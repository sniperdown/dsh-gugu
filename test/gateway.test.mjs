/**
 * 网关端到端测试。
 *
 * 这里用的是**真实的** protocol / Router / ProactiveEngine，只把两个东西换成假的：
 * 传输层（记下发了什么）与会话（responder）。所以这一层验证的是"从 OneBot 原始
 * 事件到发回 QQ"的完整链路，其中唯一的假货就是 DSH 会话本身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Gateway, OUTCOME } from '../src/dsh/gateway.mjs';
import { Router, POLICY, sessionKeyFromChatId } from '../src/dsh/routing.mjs';
import { createOutboundAllow } from '../src/dsh/outbound-allow.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);

/**
 * 转交白名单（**配置形状**：`allowFrom` / `groupAllowFrom`，全是假号）。
 *
 * 生产里这份名单来自 `cordis.patch.yml`，由 `index.mjs` 读出来、
 * 用 `createOutboundAllow()` 装配好注入网关。测试这里自己造一份等价的 ——
 * ⚠️ 关键差别：网关**自己不再有**任何写死的名单，所以"不注入 = 谁都不能转交"。
 */
const OUTBOUND_ALLOW = createOutboundAllow({
  allowFrom: ['10000001'],
  groupAllowFrom: ['200000001', '200000002'],
});

/** 假传输层：记录发出的消息，保留 EventEmitter 语义。 */
function makeTransport({ selfId = '999', failSend = false } = {}) {
  const emitter = new EventEmitter();
  const sent = [];
  return {
    selfId,
    sent,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async sendToChat(chatId, message) {
      if (failSend) throw new Error('发送失败');
      sent.push({ chatId, message });
      return sent.length;
    },
    async sendGroupMsg(groupId, message) {
      return this.sendToChat(`group:${groupId}`, message);
    },
    async sendPrivateMsg(userId, message) {
      return this.sendToChat(`private:${userId}`, message);
    },
  };
}

/**
 * 装一套网关：真 protocol/router/engine + 假 transport/responder。
 * @param {object} [options]
 */
function harness(options = {}) {
  const transport = makeTransport(options.transport);
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.OPEN,
    requireMention: true,
    adminUsers: ['9001'],
    ...(options.router ?? {}),
  });

  const spoken = [];
  const gauges = [];
  const logs = [];
  const responded = [];
  let now = T0;

  const engine = new ProactiveEngine({
    config: {
      enabled: options.proactive === true,
      minIntervalMs: 0,
      maxPerHour: 10,
      cooldownAfterBotMs: 0,
      afterUserMsgCount: 1,
      ...(options.engineConfig ?? {}),
    },
    gauge: async (request) => {
      gauges.push(request);
      if (options.gauge) return options.gauge(request, gauges.length);
      // 判定层只认 `speak: true`（措辞由会话生成），所以桩必须给这个字段。
      return { speak: true, text: `主动冒泡${gauges.length}` };
    },
    speak: async (request) => {
      spoken.push(request);
      await transport.sendToChat(request.chatId, request.text);
      if (options.onSpeak) return options.onSpeak(request);
      return undefined;
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => (options.clock ? options.clock() : now),
  });

  const gateway = new Gateway({
    transport,
    router,
    engine,
    // 出站白名单是注入的（生产里由 index.mjs 从配置装配）。默认给一份假号名单，
    // 需要验"名单外不许发"的用例可以自己传一份。
    outboundAllow: options.outboundAllow ?? OUTBOUND_ALLOW,
    responder: async (request) => {
      responded.push(request);
      if (options.responder) return options.responder(request, responded.length);
      return `回复${responded.length}`;
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    maxReplyChars: options.maxReplyChars ?? 2000,
    // 其余网关选项**原样透传**（2026-10-13 加）。
    //
    // 为什么需要：`imageDescriber` 这类注入项以前在这个 harness 里没出口，
    // 于是"图片描述真的进提示词了吗"这一整类用例只能去 `rich-gateway.test.mjs`
    // 写（那边的 harness 一直带这个透传）。两个 harness 行为不一致本身就是坑
    // —— 第一版新用例就是因为把 `imageDescriber` 挂在了顶层面静默失效的。
    ...(options.gateway ?? {}),
  });
  gateway.attach();

  return { gateway, transport, router, engine, spoken, gauges, logs, responded, setNow: (v) => (now = v) };
}

/** 一条标准群消息事件。 */
function groupEvent(overrides = {}) {
  return {
    time: Math.floor(T0 / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 1,
    group_id: 100,
    user_id: 2001,
    message: [{ type: 'text', text: '看这个' }],
    raw_message: '看这个',
    sender: { nickname: '阿猫', card: '群名片猫' },
    ...overrides,
  };
}

/** 一条标准私聊事件。 */
function dmEvent(overrides = {}) {
  return {
    time: Math.floor(T0 / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 1,
    user_id: 2001,
    message: [{ type: 'text', text: '在吗' }],
    raw_message: '在吗',
    sender: { nickname: '阿猫' },
    ...overrides,
  };
}

// ---------------------------------------------------------------- 被动回复

test('私聊：被允许时交给会话并回复', async () => {
  const h = harness();
  const result = await h.gateway.handleEvent(dmEvent());
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.transport.sent.length, 1);
  assert.equal(h.transport.sent[0].chatId, 'private:2001');
  assert.equal(h.transport.sent[0].message, '回复1');
  assert.equal(h.responded[0].sessionKey, 'qq-private-2001');
  // ⚠️ 2026-10-13 改过：私聊**仍然不加发言人前缀**（上下文里只有两个人），
  // 但**时间戳照带** —— 用户原话「还是带，所有的消息都带时间戳」。
  //
  // 为什么写成"可选的 `MM-DD`"：这条链路渲染时用的是**真实时钟**
  // （`renderPrompt` 的 `now` 缺省 `Date.now()`），而事件固定在 `T0`(2026-03-01)
  // ⇒ 现网跑出来必然带日期。**两种形态本身（当天裸 `HH:MM` / 跨天带日期）
  // 钉在 `routing.test.mjs`** —— 那里 `now` 是注入的，跑哪一天都稳。
  assert.match(h.responded[0].prompt, /^\[(?:\d{2}-\d{2} )?20:00\] 在吗$/);
});

test('私聊：不在允许范围时完全忽略', async () => {
  const h = harness({ router: { dmPolicy: POLICY.ADMIN, adminUsers: ['9001'] } });
  const result = await h.gateway.handleEvent(dmEvent({ user_id: 2001 }));
  assert.equal(result.outcome, OUTCOME.IGNORED);
  assert.match(result.reason, /dm-denied/);
  assert.equal(h.responded.length, 0);
  assert.equal(h.transport.sent.length, 0);
});

test('群聊：被 @ 时交给会话，提示词带发言人前缀', async () => {
  // 关掉软限制，单独看前缀本身；受限前缀另有专门用例。
  const h = harness({ router: { groupPolicy: POLICY.OPEN, restrictMembers: false } });
  const result = await h.gateway.handleEvent(
    groupEvent({
      message: [{ type: 'at', qq: '999' }, { type: 'text', text: ' 看这个' }],
      raw_message: '[CQ:at,qq=999] 看这个',
    }),
  );
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.responded[0].sessionKey, 'qq-group-100');
  // @ 段渲染成 `@999`（看得见 @ 的是谁），后面才是正文。
  // 外面那层【刚 @ 你的那条】是 2026-10-07 加的（被点名那轮也要带上下文，见下一条用例）。
  // ⚠️ 2026-10-13 改过：前缀里的时间戳**不是当天就带日期**（这里是 `T0` ⇒ 带日期）。
  assert.match(
    h.responded[0].prompt,
    /^【刚 @ 你的那条】\[(?:\d{2}-\d{2} )?20:00 群名片猫\(2001\)\] @999 看这个$/,
  );
});

test('★ 被 @ 那一轮也要带上转录（2026-10-07，账本 §十）', async () => {
  // 用户的场景：连发几条小鲸鱼没回（被闸门挡住 → 那几条压根没进过 agent 会话），
  // 然后 @ 一下。旧实现里提示词**只有那一条 @**，小鲸鱼看不到前面发生了什么，
  // 只能干巴巴回一句"在的？"。
  const h = harness({ router: { groupPolicy: POLICY.OPEN, restrictMembers: false } });
  const before = (id, text, at) =>
    groupEvent({
      message_id: id,
      time: at,
      message: [{ type: 'text', text }],
      raw_message: text,
    });
  const t = Math.floor(T0 / 1000);
  // 两条"没人 @ 小鲸鱼"的普通聊天（判定沉默 → 只进转录，不进会话）。
  await h.gateway.handleEvent(before(1, '这个接口一直报错', t));
  await h.gateway.handleEvent(before(2, '谁知道怎么解决', t + 60));
  // 然后 @ 小鲸鱼。
  await h.gateway.handleEvent(
    groupEvent({
      message_id: 3,
      time: t + 120,
      message: [{ type: 'at', qq: '999' }, { type: 'text', text: ' 在吗' }],
      raw_message: '[CQ:at,qq=999] 在吗',
    }),
  );

  const prompt = h.responded.at(-1).prompt;
  assert.match(prompt, /^群里刚在聊：/, `提示词该带转录，实际：${prompt}`);
  assert.match(prompt, /这个接口一直报错/, '前面的聊天要看得见');
  assert.match(prompt, /谁知道怎么解决/, '前面的聊天要看得见');
  assert.match(prompt, /【刚 @ 你的那条】/, '触发的那条要单独标出来');
  // ⚠️ 触发的那条**只能出现一次**：它已经是转录的最后一条了，
  // 再以"先前聊天"的身份出现一次会显得群里说了两遍。
  //
  // 数**正文**（`@999 在吗`）而不是行首时间戳：时间戳现在带日期，而两种形态本来就不同
  // （转录行 `[stamp] 昵称(id): 正文` vs 【刚 @ 你的那条】`【刚 @ 你的那条】[stamp 昵称(id)] 正文`），
  // 拿时间戳当锚点会随"今天"是哪天而变。
  const occurrences = prompt.split('@999 在吗').length - 1;
  assert.equal(occurrences, 1, `触发那条只该出现一次，实际 ${occurrences} 次：${prompt}`);
});

test('私聊不加转录（会话历史里本来就有，且"群里刚在聊"不成立）', async () => {
  const h = harness();
  await h.gateway.handleEvent(dmEvent());
  // 不加转录，但**带时间戳**（2026-10-13 起的私聊行为，见上面那条用例的说明）。
  assert.match(h.responded[0].prompt, /^\[(?:\d{2}-\d{2} )?20:00\] 在吗$/);
});

test('群聊：没被 @ 且主动插话关闭时，只观察不回复', async () => {
  const h = harness(); // proactive 默认 false
  const result = await h.gateway.handleEvent(groupEvent());
  assert.equal(result.outcome, OUTCOME.OBSERVED);
  assert.equal(result.reason, 'proactive-disabled');
  assert.equal(h.responded.length, 0);
  assert.equal(h.transport.sent.length, 0);
});

test('群聊：没被 @ 但判定说回 → 插话也走会话（统一回复路径）', async () => {
  const h = harness({ proactive: true, engineConfig: {} });
  const result = await h.gateway.handleEvent(groupEvent());
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.responded.length, 1, '插话也应该走会话（而不是 llm 措辞）');
  // 提示词是"群里在聊…你接一句"，而不是把这条消息当成对我的指令。
  assert.match(h.responded[0].prompt, /你想接一句话/);
});

test('群聊：不在允许范围时只观察，但仍进转录', async () => {
  const h = harness({ router: { groupPolicy: POLICY.ALLOWLIST, groupAllowFrom: ['100'] } });
  const result = await h.gateway.handleEvent(groupEvent({ group_id: 999 }));
  assert.equal(result.outcome, OUTCOME.OBSERVED);
  assert.match(result.reason, /group-denied/);
  // 转录仍然记录（运维想看群里在聊什么）。
  assert.equal(h.engine.transcript('group:999').snapshot().length, 1);
});

test('同群共用一个会话，不同群分开', async () => {
  const h = harness();
  const at = (groupId, messageId) =>
    groupEvent({
      group_id: groupId,
      message_id: messageId,
      message: [{ type: 'at', qq: '999' }, { type: 'text', text: 'x' }],
    });
  await h.gateway.handleEvent(at(100, 1));
  await h.gateway.handleEvent(at(100, 2));
  await h.gateway.handleEvent(at(200, 3));
  assert.deepEqual(
    h.responded.map((r) => r.sessionKey),
    ['qq-group-100', 'qq-group-100', 'qq-group-200'],
  );
});

test('群聊成员的受限标记会带进提示词', async () => {
  // ⚠️ 2026-10-07 起，被点名那轮外面套了一层「群里刚在聊 + 【刚 @ 你的那条】」，
  // 所以受限标记不再在提示词的**第一个字符**，而是紧跟在这个人的消息前面
  // （它本来描述的就是"这个发言人受限"，挂在消息上更准）。
  const h = harness({ router: { groupPolicy: POLICY.OPEN, restrictMembers: true, adminUsers: ['9001'] } });
  await h.gateway.handleEvent(
    groupEvent({
      user_id: 2001,
      message: [{ type: 'at', qq: '999' }, { type: 'text', text: '帮我删库' }],
    }),
  );
  assert.match(h.responded[0].prompt, /【刚 @ 你的那条】\[受限用户:仅问答\]/);

  // 管理员不受限。
  const h2 = harness({ router: { groupPolicy: POLICY.OPEN, restrictMembers: true, adminUsers: ['9001'] } });
  await h2.gateway.handleEvent(
    groupEvent({ user_id: 9001, message: [{ type: 'at', qq: '999' }, { type: 'text', text: '干活' }] }),
  );
  assert.equal(h2.responded[0].prompt.includes('[受限用户'), false);
});

// ---------------------------------------------------------------- 去重与串行

test('重复投递同一个 message_id 只回一次（重连补发场景）', async () => {
  const h = harness();
  const event = groupEvent({ message: [{ type: 'at', qq: '999' }, { type: 'text', text: 'x' }] });
  const first = await h.gateway.handleEvent(event);
  const second = await h.gateway.handleEvent(event);
  assert.equal(first.outcome, OUTCOME.DISPATCHED);
  assert.equal(second.outcome, OUTCOME.IGNORED);
  assert.equal(second.reason, 'duplicate');
  assert.equal(h.transport.sent.length, 1);
});

test('同一会话内的两轮串行执行，不会交叉', async () => {
  const order = [];
  const h = harness({
    responder: async (request, n) => {
      order.push(`start${n}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end${n}`);
      return `r${n}`;
    },
  });
  const at = (messageId) =>
    groupEvent({
      message_id: messageId,
      message: [{ type: 'at', qq: '999' }, { type: 'text', text: 'x' }],
    });

  await Promise.all([h.gateway.handleEvent(at(1)), h.gateway.handleEvent(at(2))]);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2'], '第二轮必须等第一轮结束');
});

test('不同会话之间可以并发', async () => {
  const order = [];
  const h = harness({
    responder: async (request, n) => {
      order.push(`start-${request.sessionKey}-${n}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end-${request.sessionKey}-${n}`);
      return `r${n}`;
    },
  });
  await Promise.all([
    h.gateway.handleEvent(dmEvent({ user_id: 2001, message_id: 1 })),
    h.gateway.handleEvent(dmEvent({ user_id: 3000, message_id: 2 })),
  ]);
  // 两个会话各自开始，不应互相等待。
  assert.equal(order[0].startsWith('start-qq-private-2001'), true);
  assert.equal(order[1].startsWith('start-qq-private-3000'), true);
});

// ---------------------------------------------------------------- 容错

test('会话抛错时不回消息、不崩，并记 error', async () => {
  const h = harness({
    responder: () => {
      throw new Error('模型挂了');
    },
  });
  const result = await h.gateway.handleEvent(groupEvent({
    message: [{ type: 'at', qq: '999' }, { type: 'text', text: 'x' }],
  }));
  assert.equal(result.outcome, OUTCOME.FAILED);
  assert.equal(h.transport.sent.length, 0);
  assert.ok(h.logs.some((l) => l.level === 'error' && /模型挂了/.test(l.meta?.error ?? '')));
});

test('发送失败时也记为失败而不是崩掉', async () => {
  const h = harness({ transport: { failSend: true } });
  const result = await h.gateway.handleEvent(dmEvent());
  assert.equal(result.outcome, OUTCOME.FAILED);
});

test('非 message 事件一律忽略', async () => {
  const h = harness();
  for (const event of [
    { post_type: 'meta_event', meta_event_type: 'heartbeat' },
    { post_type: 'notice', notice_type: 'group_recall' },
    { post_type: 'request', request_type: 'friend' },
    null,
    'x',
  ]) {
    const result = await h.gateway.handleEvent(event);
    assert.equal(result.outcome, OUTCOME.IGNORED);
    assert.equal(result.reason, 'not-a-user-message');
  }
  assert.equal(h.responded.length, 0);
});

test('机器人自己发的消息被忽略（防自循环）', async () => {
  const h = harness();
  const result = await h.gateway.handleEvent(groupEvent({ user_id: 999, message_id: 5 }));
  assert.equal(result.outcome, OUTCOME.IGNORED);
});

test('空正文（只有媒体/回复段）不进会话，也不发空消息', async () => {
  const h = harness();
  const result = await h.gateway.handleEvent(
    groupEvent({
      // 回复机器人自己的消息 → `mentioned=true`；但正文为空。
      message: [{ type: 'reply', user_id: '999', id: '1' }],
      raw_message: '',
      message_id: 6,
    }),
  );
  assert.equal(result.outcome, OUTCOME.OBSERVED);
  // ⚠️ 2026-10-13 03:2x：这里原来是 `'empty-body'`。用户的拍板改了语义 ——
  // **「引用回复时自动带的 @ 不算被点名」**（引用 + 空正文 = 纯引用，不是"叫她"）⇒
  // 引擎在 `proactive.enabled=false`（本 harness 的默认值，见 L77）时就先回
  // `proactive-disabled`，不再走到网关那条 `empty-body` 判断。
  // ⚠️ 两条结论**完全一样**：**不出站、不进会话**（下面两条断言才是本用例的要点）。
  assert.equal(result.reason, 'proactive-disabled');
  assert.equal(h.responded.length, 0, '不该为无内容的消息创建会话轮次');
  assert.equal(h.transport.sent.length, 0, '不该发空消息');
});

test('纯 @（@ 了我却没打字）要回 —— 不能当成空正文丢掉', async () => {
  // 回归：用户在群里 `@小鲸鱼` 没打字（消息段是 `at` + 一个空格）。
  // 判定其实完全正确（addressed=True、speak=True），却被网关的空正文检查
  // 当成 empty-body 丢掉，小鲸鱼一声不吭。
  const h = harness();
  const result = await h.gateway.handleEvent(
    groupEvent({
      message: [{ type: 'at', qq: '999' }, { type: 'text', text: ' ' }],
      raw_message: '[CQ:at,qq=999] ',
      message_id: 11,
    }),
  );
  assert.equal(result.outcome, OUTCOME.DISPATCHED, '纯 @ 必须唤起会话');
  assert.equal(h.responded.length, 1);
  assert.equal(h.transport.sent.length, 1);
  // 2026-10-07 改：这句话要**说准**。旧文案只说"@ 了你，但没说话"，
  // 读起来像"对方只是 @ 了一下"，而真实情况更可能是"前面发过几条你没回，来催你"
  // 或者"看看你掉线没有"（用户原话）。
  assert.match(h.responded[0].prompt, /@ 了你，但没说话 —— 可能是催你，也可能是看你掉线没有/);
});

test('回复段缺少 user_id 时判定不了，按「未被 @」处理（fail-closed）', async () => {
  // 这是刻意的保守：宁可漏一条，也不要在群里对每条消息都应答。
  // 统一判定后，"未被 @ 又不该插话"的表现是判定沉默（此处 active 插话未开）。
  const h = harness();
  const result = await h.gateway.handleEvent(
    groupEvent({
      message: [{ type: 'reply', id: '1' }, { type: 'text', text: '这个' }],
      raw_message: '这个',
      message_id: 7,
    }),
  );
  assert.equal(result.outcome, OUTCOME.OBSERVED);
  assert.equal(result.reason, 'proactive-disabled');
});

// ---------------------------------------------------------------- 引用（引用原文进提示词）

/**
 * 真机 id 形状：`message_id` 是**数字**，而 reply 段里的 `id` 是**字符串**。
 * 夹具刻意照真机这么造 —— 两边都用 `===` 比就永远对不上（静默失效）。
 */
const QUOTED_ID = 551866400;

test('★ 私聊：引用别人的消息时，被引用的原文一起进提示词', async () => {
  // 用户 2026-10-29 的原话：「引用你似乎现在还看不出？……引用的消息会把引用的原文也带上」。
  // 修之前：reply 段整段被丢（`SEGMENT_PLACEHOLDERS.reply = ''`），她只看到「这个不行」。
  const h = harness();
  // ① 被引用的那条先进转录（私聊每条都会派发，所以这一步就是一次正常对话）
  await h.gateway.handleEvent(dmEvent({
    message_id: QUOTED_ID,
    message: [{ type: 'text', data: { text: '昨天那句原话' } }],
    raw_message: '昨天那句原话',
    sender: { nickname: '用户' },
  }));
  // ② 引用它再说一句（NapCat 的段形状：{type:'reply', data:{id}}）
  const second = await h.gateway.handleEvent(dmEvent({
    message_id: 900001,
    message: [
      { type: 'reply', data: { id: String(QUOTED_ID) } },
      { type: 'text', data: { text: '这个不行' } },
    ],
    raw_message: `[CQ:reply,id=${QUOTED_ID}]这个不行`,
  }));
  assert.equal(second.outcome, OUTCOME.DISPATCHED);
  const prompt = h.responded[1].prompt;
  assert.match(prompt, /^本条消息引用了这条消息：/, '用户要的就是这个措辞');
  // 原文那一行与转录里的同一条长得**一模一样**（转录的格式是
  // `[时间戳] 昵称(QQ): 正文` —— 那是 `engine.mjs` 的 `renderEntries`，不是 `renderPrompt`）
  assert.match(prompt, /^\[(?:\d{2}-\d{2} )?\d{2}:\d{2}\] 用户\(2001\): 昨天那句原话$/m);
  // 顺序：引用原文在触发消息正文**之前**
  assert.ok(
    prompt.indexOf('昨天那句原话') < prompt.indexOf('这个不行'),
    '引用段要排在「这个不行」之前',
  );
});

test('群聊被 @ 时：引用原文排在「刚 @ 你的那条」之前', async () => {
  const h = harness({ router: { groupPolicy: POLICY.OPEN, restrictMembers: false } });
  // 别人的一条普通消息：本例 proactive 关着 ⇒ 不派发轮次，但**照样进转录**
  // （`engine.decide()` 先 push 再判 enabled）。
  await h.gateway.handleEvent(groupEvent({
    message_id: 700001,
    user_id: 2002,
    message: [{ type: 'text', data: { text: '原来的那句话' } }],
    raw_message: '原来的那句话',
    sender: { nickname: '小铅', card: '' },
  }));
  const result = await h.gateway.handleEvent(groupEvent({
    message_id: 700002,
    message: [
      { type: 'reply', data: { id: '700001' } },
      { type: 'at', data: { qq: '999' } },
      { type: 'text', data: { text: ' 这个不行' } },
    ],
    raw_message: '[CQ:reply,id=700001][CQ:at,qq=999] 这个不行',
  }));
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  const prompt = h.responded[0].prompt;
  assert.ok(prompt.includes('原来的那句话'), '被引用的原文要在提示词里');
  const quoteAt = prompt.indexOf('本条消息引用了这条消息：');
  const atHeaderAt = prompt.indexOf('【刚 @ 你的那条】');
  assert.ok(atHeaderAt > quoteAt && quoteAt > 0, '引用段排在「刚 @ 你的那条」之前');
});

test('群聊环境轮：引用原文也带上（接在转录之后 —— 那条本身就在转录末尾）', async () => {
  const h = harness({
    proactive: true,
    engineConfig: {},
    router: { groupPolicy: POLICY.OPEN, restrictMembers: false },
  });
  await h.gateway.handleEvent(groupEvent({
    message_id: 800001,
    user_id: 2003,
    message: [{ type: 'text', data: { text: '发个小牢骚' } }],
    raw_message: '发个小牢骚',
    sender: { nickname: '阿铅', card: '' },
  }));
  const result = await h.gateway.handleEvent(groupEvent({
    message_id: 800002,
    user_id: 2004,
    message: [
      { type: 'reply', data: { id: '800001' } },
      { type: 'text', data: { text: '这个不行' } },
    ],
    raw_message: '[CQ:reply,id=800001] 这个不行',
    sender: { nickname: '阿猫', card: '' },
  }));
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  const prompt = h.responded.at(-1).prompt;
  assert.ok(prompt.includes('本条消息引用了这条消息：'));
  assert.ok(prompt.includes('发个小牢骚'));
  // 环境轮的形状：抬头 / 转录 / 空行 / 引用段 / 空行 / 插话提示 ——
  // 引用段刻意放在转录**之后**：这一条本身就在转录末尾，插到前面会跑到别人几句话之前。
  assert.ok(
    prompt.indexOf('这个不行') < prompt.indexOf('本条消息引用了这条消息：'),
    '环境轮里引用段在转录之后',
  );
});

test('引用了一条已经不在转录里的消息 ⇒ 只报 id，且明说这是引用', async () => {
  // 退化路径（b）：引的是很久以前、已被转录窗口挤掉的那条。
  // 关键仍然是"她知道这是一条引用"—— 光给孤立那句正文正是这次要修的病。
  const h = harness();
  const result = await h.gateway.handleEvent(dmEvent({
    message_id: 12,
    message: [
      { type: 'reply', data: { id: '123456789' } },
      { type: 'text', data: { text: '这个不行' } },
    ],
    raw_message: '[CQ:reply,id=123456789]这个不行',
  }));
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  const prompt = h.responded[0].prompt;
  assert.match(prompt, /^本条消息引用了这条消息：/);
  assert.match(prompt, /原文没找到/);
  assert.ok(prompt.includes('123456789'), '找不到原文也要把 id 报出来');
});

test('★ 反例：不带引用的消息 ⇒ 提示词逐字不变（不许给所有消息都加那段）', async () => {
  // 这条最重要：这段会永久进会话历史、影响 token。
  // 除行首时间戳（真实时钟，跨天会带日期）之外必须**逐字相同**、且不许额外加行。
  const h = harness();
  const result = await h.gateway.handleEvent(dmEvent({ message_id: 11 }));
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  const prompt = h.responded[0].prompt;
  assert.equal(prompt.replace(/^\[[^\]]*\] /, '[TS] '), '[TS] 在吗');
  assert.equal(prompt.includes('本条消息引用了'), false, '没引用就不许出现这段');
  assert.equal(prompt.split('\n').length, 1, '不许额外加行');
});

test('反例：群聊环境轮不带引用时，提示词形状不变（抬头 / 转录 / 空行 / 插话提示）', async () => {
  const h = harness({
    proactive: true,
    engineConfig: {},
    router: { groupPolicy: POLICY.OPEN, restrictMembers: false },
  });
  const result = await h.gateway.handleEvent(groupEvent({
    message_id: 21,
    message: [{ type: 'text', data: { text: '随便说说' } }],
    raw_message: '随便说说',
  }));
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  const prompt = h.responded[0].prompt;
  assert.match(prompt, /^群里刚在聊：\n/);
  assert.equal(prompt.includes('本条消息引用了'), false);
  assert.equal(prompt.split('\n').length, 4, '四行：抬头 / 转录一行 / 空行 / 插话提示');
});

test('纯媒体消息的占位符是可处理正文，不该被当成空正文', async () => {
  const h = harness({ router: { groupPolicy: POLICY.OPEN, restrictMembers: false } });
  const result = await h.gateway.handleEvent(
    groupEvent({
      message: [{ type: 'at', qq: '999' }, { type: 'image' }],
      raw_message: '[CQ:at,qq=999][CQ:image,file=a.jpg]',
      message_id: 8,
    }),
  );
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  // @ 段现在渲染成 `@999`（看得见 @ 的是谁），后面紧接图片占位符。
  // 时间戳同前一条用例：`T0` 不是当天 ⇒ 带日期（可选的 `MM-DD`，见那里说明）。
  assert.match(
    h.responded[0].prompt,
    /^【刚 @ 你的那条】\[(?:\d{2}-\d{2} )?20:00 群名片猫\(2001\)\] @999\[图片\]$/,
  );
});

test('群里 @ 别人：提示词里看得见 @ 的是谁（@ 段不再凭空消失）', async () => {
  // 这是 2026-10-06 修的那个 bug：`SEGMENT_PLACEHOLDERS.at = ''` 让 at 段整段被丢，
  // `@黑猫 你看看` 到达模型时只剩 `你看看`。
  const h = harness({
    proactive: true,
    engineConfig: {},
    router: { groupPolicy: POLICY.OPEN, restrictMembers: false },
  });
  const result = await h.gateway.handleEvent(
    groupEvent({
      message: [{ type: 'at', qq: '10000002' }, { type: 'text', text: ' 你看看' }],
      raw_message: '[CQ:at,qq=10000002] 你看看',
      message_id: 31,
    }),
  );
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  // 没被点名（@ 的是别人）→ 走"群里刚在聊"那条提示词；
  // 转录里的正文同样看得见 @ 目标（这条就是修 bug 前会丢的那一段）。
  // ⚠️ 2026-10-13 改过：**转录行首现在不是当天就带日期**，而本用例的消息固定在
  // `T0`（2026-03-01）⇒ 渲染成 `[03-01 20:00]`。这条用例要钉的是"@ 目标看得见"，
  // 日期是顺带出现的**预期新行为**（见 `engine.test.mjs` 的 `formatStamp` 那一组）。
  assert.match(h.responded[0].prompt, /\[03-01 20:00\] 群名片猫\(2001\): @10000002 你看看/);
});

test('只 @ 了别人、没打字：仍然算空正文（判定语义不变）', async () => {
  // `@别人`（没说话）与「引用我但没打字」同类：没有内容，不该唤起会话。
  // ⚠️ 判空必须**去掉 @ 目标**再看 —— 否则 `message.text` 变成 `@10000002`，
  // 这条消息会被当成"有内容"，悄悄改了 empty-body 这条既有行为。
  const h = harness({
    proactive: true,
    engineConfig: {},
    router: { groupPolicy: POLICY.OPEN, restrictMembers: false },
  });
  const result = await h.gateway.handleEvent(
    groupEvent({
      message: [{ type: 'at', qq: '10000002' }],
      raw_message: '[CQ:at,qq=10000002]',
      message_id: 32,
    }),
  );
  assert.equal(result.outcome, OUTCOME.OBSERVED);
  assert.equal(result.reason, 'empty-body');
  assert.equal(h.responded.length, 0, '不该为没有内容的消息创建会话轮次');
});

test('超长回复被截断后仍能发出', async () => {
  const h = harness({
    maxReplyChars: 10,
    responder: () => 'x'.repeat(500),
  });
  await h.gateway.handleEvent(dmEvent());
  assert.equal(Array.from(h.transport.sent[0].message).length, 10);
  assert.ok(h.transport.sent[0].message.endsWith('…'));
});

// ---------------------------------------------------------------- 与主动引擎的协作

test('被动回复后主动引擎的冷却期生效（不会自己接自己的话）', async () => {
  const h = harness({
    engineConfig: { cooldownAfterBotMs: 60_000 },
    proactive: false,
  });
  await h.gateway.handleEvent(dmEvent());
  assert.equal(h.transport.sent.length, 1, '被动回复已发出');
  assert.equal(
    h.engine.state('private:2001').lastBotAt,
    T0,
    'noteBotSpoke 必须被调用，否则冷却是假的',
  );
});

test('只观察的消息也会进转录，供主动发言判断话题', async () => {
  const h = harness();
  await h.gateway.handleEvent(groupEvent({ message_id: 1 }));
  await h.gateway.handleEvent(groupEvent({ message_id: 2 }));
  assert.equal(h.engine.transcript('group:100').snapshot().length, 2);
});

test('主动发言开启时，话题足够会自己冒泡', async () => {
  const h = harness({
    proactive: true,
    // 群必须是允许范围（proactiveAllowed 才放行）。PROACTIVE 走 speakProactively，
    // 而引擎的 speak 直接发 transport，所以这里只验证引擎确实被喂了转录。
    engineConfig: { cooldownAfterBotMs: 0, minIntervalMs: 0 },
  });
  await h.gateway.handleEvent(groupEvent({ message_id: 1 }));
  await h.gateway.handleEvent(groupEvent({ message_id: 2 }));
  await h.gateway.handleEvent(groupEvent({ message_id: 3 }));
  assert.ok(h.gauges.length >= 1, '达到突发门槛后应发起判定');
});

test('speakProactively：允许的会话会发出', async () => {
  const h = harness();
  const ok = await h.gateway.speakProactively('group:100', '定时播报');
  assert.equal(ok, true);
  assert.equal(h.transport.sent.at(-1).message, '定时播报');
});

test('speakProactively：不允许的会话被拒绝', async () => {
  const h = harness({
    router: { groupPolicy: POLICY.ALLOWLIST, groupAllowFrom: ['100'] },
  });
  const ok = await h.gateway.speakProactively('group:999', '不该发');
  assert.equal(ok, false);
  assert.equal(h.transport.sent.length, 0);
  assert.ok(h.logs.some((l) => /拒绝向/.test(l.message)));
});

test('speakProactively：空文本不发', async () => {
  const h = harness();
  assert.equal(await h.gateway.speakProactively('group:100', '   '), false);
  assert.equal(h.transport.sent.length, 0);
});

// ---------------------------------------------- 同文短窗去重（2026-10-16 示例群 4 连发同文）
//
// 线上实证：2026-10-16 12:04:00.916~.918，同一条 26 字文本被发了 4 次，
// 台账里 4 行 `gw-send`（同 sha）+ 4 行 `transport-action`，
// **4 个 messageId 各不相同** ⇒ NapCat 真发出去 4 条。
// ⚠️ 根因没查实（会话里 6 轮回复各不相同、台账里却有 4 条同文），所以这里是**防御性收口**：
//    不管上游谁在重复调用，`#send` 这道唯一的咽喉保证"同一句话不会连着甩进同一个群"。

test('★ 同文短窗去重：同一会话 10 秒内发两条一模一样的，第二条被拦下', async () => {
  const h = harness();
  assert.equal(await h.gateway.speakProactively('group:100', '同一句话'), true);
  assert.equal(await h.gateway.speakProactively('group:100', '同一句话'), false, '第二条该被拦');
  assert.equal(h.transport.sent.length, 1, '真正发出去的只该有 1 条');
  assert.ok(h.logs.some((l) => /拦下重复发送/.test(l.message)), '要留一条 warn 当证据');
});

test('★ 同文短窗去重：不同会话各发一条相同的，两条都要发出去', async () => {
  // 只按 chatId 隔离 —— 换个群说同样的话是正常的，不能被误拦。
  const h = harness();
  assert.equal(await h.gateway.speakProactively('group:100', '同一句话'), true);
  assert.equal(await h.gateway.speakProactively('group:200', '同一句话'), true);
  assert.equal(h.transport.sent.length, 2);
});

test('★ 同文短窗去重：语义是「紧接着重复」，A→B→A 不算（别把正常对话挡了）', async () => {
  // ⚠️ 守卫每会话只记**最后一条**，所以判的是"紧挨着的下一条是不是一模一样"，
  //    不是"窗口内出现过没有"。中间说过别的话话 ⇒ 那是正常对话节奏，放行。
  //    （第一版测试把这条写成"窗口内任何重复都拦"，是**测试写错了**，不是代码错。）
  const h = harness();
  assert.equal(await h.gateway.speakProactively('group:100', '第一句'), true);
  assert.equal(await h.gateway.speakProactively('group:100', '第二句'), true);
  assert.equal(await h.gateway.speakProactively('group:100', '第一句'), true, '中间隔了别的 ⇒ 不该拦');
  assert.equal(await h.gateway.speakProactively('group:100', '第一句'), false, '紧接着又是它 ⇒ 拦');
  assert.equal(h.transport.sent.length, 3, '放行 3 条、拦 1 条');
});

// ---------------------------------------------------------------- 出站目标白名单
//
// 用户明确提出的硬要求：**只允许在"和本人的私聊"以及"测试群"里发消息**，
// 不许往任何其他群或私聊发。这里做端到端检查，
// 而不只测 Router 的布尔值——要确认 speakProactively 这个出站口真的拦住了。
//
// ⚠️ 2026-10-07：号码统一换成假号（私人号 10000001 起、群号 200000001 起）。
//    原来写的是生产真实值，等于把用户的 QQ 号与群号抄进了测试。
//    现在这些用例测的是**机制**；真实白名单在 `cordis.patch.yml`，测试读不到它。

test('出站白名单：只放行本人私聊与测试群，其他一律拒绝且不发', async () => {
  const h = harness({
    router: {
      dmPolicy: POLICY.ALLOWLIST,
      allowFrom: ['10000001'],
      groupPolicy: POLICY.ALLOWLIST,
      groupAllowFrom: ['200000001'],
    },
  });

  const allowed = ['private:10000001', 'group:200000001'];
  const denied = [
    'private:10001',       // 其他私聊
    'private:10000003',    // 机器人自己
    'group:200000004',     // 示例群～水舞
    'group:200000003',     // ψ(｀∇´)ψ
    'group:200000002',     // 用力到处扣扣（此例的白名单里没有它）
    'group:999999999',     // 不存在的群
  ];

  for (const chatId of allowed) {
    assert.equal(await h.gateway.speakProactively(chatId, `测试 ${chatId}`), true, `${chatId} 应被放行`);
  }
  const sentAfterAllowed = h.transport.sent.length;
  assert.equal(sentAfterAllowed, allowed.length, '放行的都应真的发出');

  for (const chatId of denied) {
    assert.equal(await h.gateway.speakProactively(chatId, `不该发 ${chatId}`), false, `${chatId} 应被拒绝`);
  }
  assert.equal(h.transport.sent.length, sentAfterAllowed, '被拒绝的目标一条都不能发出去');
});

test('出站白名单：加进 200000002（用力到处扣扣）后该群放行，其余仍拒绝', async () => {
  // 2026-10-02：用户在某个群里发了三句等小鲸鱼接话，但被白名单拒了
  // （判定日志连续 3 条 `skip not-permitted`）。他期望小鲸鱼在那里活跃，于是加进白名单。
  // 这条测试钉住的是**机制**：加进白名单就放行、没加的一律拒绝。
  // ⚠️ 它钉不住生产白名单本身 —— 这里的值硬编码在测试里，读不到 cordis.patch.yml。
  const h = harness({
    router: {
      dmPolicy: POLICY.ALLOWLIST,
      allowFrom: ['10000001'],
      groupPolicy: POLICY.ALLOWLIST,
      groupAllowFrom: ['200000001', '200000002'],
    },
  });

  for (const chatId of ['private:10000001', 'group:200000001', 'group:200000002']) {
    assert.equal(await h.gateway.speakProactively(chatId, `测试 ${chatId}`), true, `${chatId} 应被放行`);
  }
  const sent = h.transport.sent.length;
  assert.equal(sent, 3);

  // 其余群仍然一律不许发 —— 白名单是硬边界，不是"开放"。
  for (const chatId of ['group:200000004', 'group:200000003', 'private:10001', 'private:10000003']) {
    assert.equal(await h.gateway.speakProactively(chatId, `不该发 ${chatId}`), false, `${chatId} 应被拒绝`);
  }
  assert.equal(h.transport.sent.length, sent, '被拒绝的目标一条都不能发出去');
});

test('出站白名单：群全部禁用时连测试群也不发，私聊仍放行', async () => {
  const h = harness({
    router: {
      dmPolicy: POLICY.ALLOWLIST,
      allowFrom: ['10000001'],
      groupPolicy: POLICY.DISABLED,
    },
  });
  assert.equal(await h.gateway.speakProactively('group:200000001', 'x'), false);
  assert.equal(await h.gateway.speakProactively('private:10000001', 'ok'), true);
  assert.equal(h.transport.sent.length, 1);
  assert.equal(h.transport.sent[0].chatId, 'private:10000001');
});

test('内部通道：投给小鲸鱼的提示词带时间戳（收件箱是轮询的，可能躺一会儿才被读到）', async () => {
  const h = harness();
  await h.gateway.deliverFromAlice({ text: '帮我看下这个', replyTo: 'private:2001', now: T0 });
  const prompt = h.responded[0].prompt;
  // `now` 注入成 `T0` ⇒ 和虚拟消息的 `at` 同一天 ⇒ 裸 `HH:MM`（这次能钉死了）。
  assert.equal(prompt, '【主会话 · 内部通道】[20:00]\n帮我看下这个');
});

test('★ 内部通道：viewImages 收**本机路径**（定时唤醒的整屏截图）⇒ 走同一条附件入库路径', async () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const dir = fs.mkdtempSync(path.join(HERE, '.tmp-gateway-shot-'));
  const file = path.join(dir, 'shot-20261021-030000-000.png');
  // 只需要能被认成 PNG（媒体类型靠魔数嗅探），不要求真能解码。
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(7680, 16);
  png.writeUInt32BE(2160, 20);
  fs.writeFileSync(file, png);

  const saved = [];
  const h = harness({
    gateway: {
      attachments: {
        async saveImage(input) {
          saved.push(input);
          return { id: 'att-shot-1' };
        },
      },
    },
  });

  try {
    await h.gateway.deliverFromAlice({ text: '看看屏幕', replyTo: 'private:2001', viewImages: [file], now: T0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 进了附件管线（= 小鲸鱼真的能看见），而不是被当成"转发序号"静默丢掉。
  assert.equal(saved.length, 1, '本机路径必须被当成图片源');
  assert.equal(saved[0].mediaType, 'image/png');
  assert.equal(saved[0].data.length, 33);
  assert.equal(h.responded[0].imageBlocks.length, 1);
  assert.equal(h.responded[0].imageBlocks[0].type, 'image');
});

test('stop() 之后不再处理任何事件', async () => {
  const h = harness();
  h.gateway.stop();
  const result = await h.gateway.handleEvent(dmEvent());
  assert.equal(result.outcome, OUTCOME.IGNORED);
  assert.equal(result.reason, 'gateway-stopped');
  assert.equal(h.responded.length, 0);
});

test('统计计数正确', async () => {
  const h = harness();
  await h.gateway.handleEvent(dmEvent({ message_id: 1 }));
  await h.gateway.handleEvent(dmEvent({ message_id: 2, user_id: 9001 }));
  await h.gateway.handleEvent(groupEvent({ message_id: 3 })); // 只观察
  assert.equal(h.gateway.stats.received, 3);
  assert.equal(h.gateway.stats.dispatched, 2);
  assert.equal(h.gateway.stats.observed, 1);
  assert.equal(h.gateway.stats.replies, 2);
});

// ---------------------------------------------------------------- 会话键一致性

test('网关用的会话键与 routing 的派生规则一致', async () => {
  const h = harness();
  await h.gateway.handleEvent(dmEvent({ user_id: 2001, message_id: 1 }));
  await h.gateway.handleEvent(
    groupEvent({
      group_id: 100,
      message_id: 2,
      message: [{ type: 'at', qq: '999' }, { type: 'text', text: 'x' }],
    }),
  );
  assert.deepEqual(
    h.responded.map((r) => r.sessionKey),
    [sessionKeyFromChatId('private:2001'), sessionKeyFromChatId('group:100')],
  );
});

// ------------------------------------------------- 图片描述进转录（2026-10-13）

/**
 * 造一条**只带图**的群聊事件。
 * @param {{messageId: number, at: number, url: string, text?: string, groupId?: number}} options
 */
function imageEvent({ messageId, at, url, text = '', groupId = 100 }) {
  return groupEvent({
    group_id: groupId,
    message_id: messageId,
    time: at,
    message: [
      ...(text === '' ? [] : [{ type: 'text', text }]),
      { type: 'image', data: { file: 'p.jpg', url, file_size: 1024 } },
    ],
    raw_message: text,
  });
}

test('★ `[图片]` 在转录里变成 `[图片: 描述]` —— 环境轮终于看得到图里是什么', async () => {
  // 用户 2026-10-13 报的场景（`_qq-judge/IMAGE-DESC-BUG.md`）：
  // 图是**单独一条无文字消息**，于是它只在**之后某一轮的转录**里以 `[图片]` 出现
  // —— 而描述原来只渲染进"当前这一条"的正文（环境轮压根不用那段正文）
  // ⇒ 图在环境轮里**永远没有描述**。这条用例盯的就是那个通道。
  const calls = [];
  const imageDescriber = {
    async describeAll(segments, options) {
      calls.push({ segments, options });
      return new Map([['https://x/cat.jpg', { text: '一只橘猫趴在键盘上', source: 'jpg' }]]);
    },
  };
  // ⚠️ `imageDescriber` 是**网关**的选项，所以必须挂在 `gateway` 下面
  // （harness 把它整个展开给 `new Gateway(...)`）。挂错层的表现是
  // "描述器一次都没被调用、提示词里还是 `[图片]`" —— 第一版就踩了这个。
  const h = harness({
    proactive: true,
    engineConfig: { afterUserMsgCount: 2 },
    gateway: { imageDescriber },
  });

  const t = Math.floor(T0 / 1000);
  const first = await h.gateway.handleEvent(imageEvent({ messageId: 1, at: t, url: 'https://x/cat.jpg' }));
  assert.equal(first.outcome, OUTCOME.OBSERVED, '第一条不派发（暖机），只进转录');
  const second = await h.gateway.handleEvent(
    groupEvent({ message_id: 2, time: t + 60, message: [{ type: 'text', text: '这是啥' }], raw_message: '这是啥' }),
  );
  assert.equal(second.outcome, OUTCOME.DISPATCHED);

  const prompt = h.responded.at(-1).prompt;
  assert.match(prompt, /^群里刚在聊：/, '环境轮的形态没变');
  assert.match(
    prompt,
    /\[图片: 一只橘猫趴在键盘上\]/,
    `★ 转录里的图必须带描述（这是本次修复的核心）：${prompt}`,
  );
  assert.doesNotMatch(prompt, /\[图片\]/, '占位符该被描述替换掉');
  // ⚠️ 判定层（gauge）看到的**仍然是占位符**：描述只进提示词，
  // 不参与打分（`image-desc` 是给会话看的，不是给打分看的）。
  // 第一条消息（纯图）那次判定就是最好的样本。
  assert.equal(h.gauges[0].transcript.includes('[图片]'), true, '打分那条路的转录保持占位符');
  assert.equal(h.gauges[0].transcript.includes('橘猫'), false, '打分不该看到描述');
  assert.ok(calls.length >= 1, '描述器该被调用');
});

test('★ 被 @ 的那一条自己带图时，正文里的 `[图片]` 也拿到描述', async () => {
  // `expandRichText` 对**顶层图**不查描述表（它只给转发里的图描述），
  // 所以"@ 我 + 一张图"原来在正文里也只有一个裸 `[图片]`。
  const title = '一张写着干活的表情包';
  const h = harness({
    proactive: true,
    gateway: {
      imageDescriber: {
        async describeAll() {
          return new Map([['https://x/cat.jpg', { text: title, source: '' }]]);
        },
      },
    },
  });
  const t = Math.floor(T0 / 1000);
  await h.gateway.handleEvent(groupEvent({
    message_id: 1,
    time: t,
    message: [{ type: 'at', qq: '999' }, { type: 'image', data: { file: 'p.jpg', url: 'https://x/cat.jpg' } }],
    raw_message: '[CQ:at,qq=999]',
  }));
  const prompt = h.responded.at(-1).prompt;
  assert.match(prompt, /【刚 @ 你的那条】/, '走的还是"被点名"那一路');
  assert.match(prompt, new RegExp(`\\[图片: ${title}\\]`), `正文里的图也要有描述：${prompt}`);
});

test('★ 入站预取**不 await** —— 预取挂着不返回，这一轮照样立刻回', async () => {
  // 这是"消除延后"那条改动的钉子：描述在**入站处** fire-and-forget，
  // 主链路一个毫秒都不等。若哪天有人把它改回 `await`，这个用例会**超时**。
  //
  // ⚠️ 桩是**有状态的**，这一点很要紧：第一个 `describeAll` 是**入站预取**
  // （永远挂着、不会返回），后面的调用一律立刻回空表。
  //
  // 为什么不连后面一起挂：派发路径上还有一处**既有的** `await`
  // （`gateway.mjs` 的 `#describeEmbeddedImages` → `image-desc.mjs:493`），
  // 它给"当前这一条自己带的图"取描述（含顶层图，`rich.mjs:636-658` 的
  // `collectEmbeddedImages` 会把顶层图一起收）。那条路本次**没改**
  // （而且它的输入是**转发内嵌**的图，与"转录里的图"是两件事），
  // 所以用例只钉"预取"这一条；把两件事混在一根桩上，红了也分不清是谁的锅。
  let prefetched = 0;
  const hanging = new Promise(() => {});
  const h = harness({
    proactive: true,
    gateway: {
      imageDescriber: {
        describeAll() {
          prefetched += 1;
          return prefetched === 1 ? hanging : Promise.resolve(new Map());
        },
      },
    },
  });

  const t = Math.floor(T0 / 1000);
  const settled = await Promise.race([
    h.gateway.handleEvent(
      groupEvent({
        message_id: 1,
        time: t,
        // 段顺序（与 `segmentsToText` 一致）：`[图片]` + 后面的文字。
        // 这样既**不是纯图**（不会被"空正文"挡掉），也**没有 @**（走环境轮那条路）。
        message: [
          { type: 'image', data: { file: 'p.jpg', url: 'https://x/cat.jpg' } },
          { type: 'text', text: '（我刚那张图）' },
        ],
        raw_message: '（我刚那张图）',
      }),
    ),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1500)),
  ]);
  assert.notEqual(settled, 'TIMEOUT', '★ 预取挂着也必须照常派发（主链路不能 await 它）');
  assert.equal(settled.outcome, OUTCOME.DISPATCHED);
  assert.ok(prefetched >= 1, '入站预取该被调用（哪怕它永远不返回）');
  // 描述还没回来 ⇒ 这一轮就是没有描述（`[图片]`），**但绝不因此少派发一轮**。
  assert.match(h.responded.at(-1).prompt, /\[图片\]/);
});

test('没注入描述器时，转录里仍是 `[图片]`（老行为逐字节不变）', async () => {
  const h = harness({ proactive: true, engineConfig: { afterUserMsgCount: 2 } });
  const t = Math.floor(T0 / 1000);
  await h.gateway.handleEvent(imageEvent({ messageId: 1, at: t, url: 'https://x/cat.jpg' }));
  await h.gateway.handleEvent(
    groupEvent({ message_id: 2, time: t + 60, message: [{ type: 'text', text: '这是啥' }], raw_message: '这是啥' }),
  );
  assert.match(h.responded.at(-1).prompt, /\[图片\]/);
});

// --------------------------------------- 她手里的「发 QQ」工具（`send_qq`，2026-10-18）
//
// 契约（用户拍板，第一档只文字）：
//   · 参数里**没有 chatId** —— 只能发【当前会话】，越界从设计上不可能；
//   · 白名单 / 条数 / 总字符 / 频率全在 `gateway.sendFromTool` 里硬卡，不信任调用方；
//   · 通过后**逐条**走 `#send`（台账 / 同文闸 / Markdown 剥除一样不落）；
//   · 任何一条不合格 ⇒ **整批拒**（宁可一条不发，也不发半截）。
//
// ⚠️ 出站：本文件的 transport 是**假货**（`makeTransport`），一条都到不了真 NapCat。
//    目标也只写测试白名单里的 `private:30000001` / `group:30000012`。
//
// ⚠️ trim 的归属读代码确认过：**工具层不 trim，`sendFromTool` 才 trim**
//    （binding 的 `execute` 原样把 `args.items` 交给注入的 `sendTool`）。
//    所以这里断言的是"网关收到的原始空白会先被 trim 再发"。

const SEND_ALLOW = createOutboundAllow({
  allowFrom: ['30000001'],
  groupAllowFrom: ['30000012'],
});
const SEND_DM = 'qq-private-30000001';
const SEND_GROUP = 'qq-group-30000012';

function sendHarness() {
  return harness({ outboundAllow: SEND_ALLOW });
}

test('★ sendFromTool：私聊逐条发，正文在网关 trim（工具层不 trim）', async () => {
  const h = sendHarness();
  const result = await h.gateway.sendFromTool({
    sessionKey: SEND_DM,
    items: [{ text: '  hi  ' }, { text: '**粗体**' }],
  });
  assert.deepEqual(result, { ok: true, sent: 2, note: '发了 2 条。' });
  assert.equal(h.transport.sent.length, 2);
  assert.deepEqual(
    h.transport.sent.map((s) => s.chatId),
    ['private:30000001', 'private:30000001'],
  );
  // 第一条验 trim，第二条验 Markdown 剥离 ⇒ 证明真的走了 `#send` 那条唯一的咽喉。
  assert.deepEqual(h.transport.sent.map((s) => s.message), ['hi', '粗体']);
});

test('★ sendFromTool：群会话也照样发（chatId 用 group:<群号>）', async () => {
  const h = sendHarness();
  const result = await h.gateway.sendFromTool({
    sessionKey: SEND_GROUP,
    items: [{ text: '群里说一句' }],
  });
  assert.deepEqual(result, { ok: true, sent: 1, note: '发了 1 条。' });
  assert.deepEqual(h.transport.sent, [{ chatId: 'group:30000012', message: '群里说一句' }]);
});

test('★ P1-4：会话 id 换成标准 `session-<uuid>` 后，工具靠**映射表**也能认出 chatId', async () => {
  // 旧实现三个工具都用 `/^qq-(private|group)-(.+)$/` 当闸门 ⇒ uuid 之后直接不可用。
  // 现在闸门走 `chatOf()`：映射表反查优先、旧前缀兜底。
  const SESSION = 'session-8f3a0000-0000-4000-8000-000000000000';
  const resolver = {
    lookup: () => null,
    note: () => false,
    chatIdOf: (key) => (key === SESSION ? 'private:30000001' : ''),
    kindOf: () => 'private',
    userIdOf: () => '30000001',
    has: (key) => key === SESSION,
  };
  const h = harness({ outboundAllow: SEND_ALLOW, gateway: { sessionResolver: resolver } });
  const result = await h.gateway.sendFromTool({
    sessionKey: SESSION,
    items: [{ text: 'uuid 也要能发' }],
  });
  assert.deepEqual(result, { ok: true, sent: 1, note: '发了 1 条。' });
  assert.deepEqual(h.transport.sent, [{ chatId: 'private:30000001', message: 'uuid 也要能发' }]);
});

test('★ sendFromTool：会话键认不出 / 不在白名单 ⇒ 一条都不发', async () => {
  const h = sendHarness();
  for (const sessionKey of [undefined, null, '', 'group:30000012', 'qq-channel-30000012']) {
    const r = await h.gateway.sendFromTool({ sessionKey, items: [{ text: 'x' }] });
    assert.equal(r.ok, false, `sessionKey=${String(sessionKey)}`);
    assert.equal(r.sent, 0);
    assert.match(r.note, /认不出这个会话键/);
  }
  // 白名单外（私聊号 / 群号都不在名单里）。
  for (const sessionKey of ['qq-private-10000001', 'qq-group-123456789']) {
    const r = await h.gateway.sendFromTool({ sessionKey, items: [{ text: 'x' }] });
    assert.equal(r.ok, false, sessionKey);
    assert.equal(r.sent, 0);
    assert.match(r.note, /不在出站白名单/);
  }
  assert.equal(h.transport.sent.length, 0, '被拒时一条都不该发');
});

test('★ sendFromTool：items 空 / 非数组 ⇒ ok:false，一条不发', async () => {
  const h = sendHarness();
  for (const items of [[], undefined, null, 'x', 42, {}]) {
    const r = await h.gateway.sendFromTool({ sessionKey: SEND_DM, items });
    assert.equal(r.ok, false, `items=${JSON.stringify(items)}`);
    assert.equal(r.sent, 0);
  }
  assert.equal(h.transport.sent.length, 0);
});

test('★ sendFromTool：一次最多 3 条 —— 4 条时整批拒', async () => {
  const h = sendHarness();
  const items = Array.from({ length: 4 }, (_, i) => ({ text: `第 ${i + 1} 条` }));
  const r = await h.gateway.sendFromTool({ sessionKey: SEND_DM, items });
  assert.equal(r.ok, false);
  assert.equal(r.sent, 0);
  assert.match(r.note, /一次最多 3 条/);
  assert.match(r.note, /你给了 4 条/);
  assert.equal(h.transport.sent.length, 0, '超条数时整批都不发（不发前 3 条）');
});

test('★ sendFromTool：总字数卡在 6000（6001 整批拒，正好 6000 放行）', async () => {
  const h = sendHarness();
  const tooLong = await h.gateway.sendFromTool({
    sessionKey: SEND_DM,
    items: [{ text: 'a'.repeat(3000) }, { text: 'b'.repeat(3001) }],
  });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.sent, 0);
  assert.match(tooLong.note, /6001 字/);
  assert.match(tooLong.note, /超过上限 6000/);
  assert.equal(h.transport.sent.length, 0, '超限时一条都不该发');

  // 边界：卡的是 `>` 而不是 `>=`，正好 6000 应当放行。
  const ok = await h.gateway.sendFromTool({
    sessionKey: SEND_DM,
    items: [{ text: 'a'.repeat(3000) }, { text: 'b'.repeat(3000) }],
  });
  assert.deepEqual(ok, { ok: true, sent: 2, note: '发了 2 条。' });
  assert.equal(h.transport.sent.length, 2);
});

test('★ sendFromTool：非 text（文件档）/ 空正文 / 坏元素 ⇒ 整批拒', async () => {
  const h = sendHarness();
  const batches = [
    // 第一条合格，第二条是文件 —— 整批仍要拒（别偷偷发掉第一条）。
    [{ text: '第一段' }, { kind: 'file', text: 'report.txt' }],
    [{ text: '第一段' }, { text: '   ' }],
    [{ text: '第一段' }, null],
  ];
  for (const items of batches) {
    const r = await h.gateway.sendFromTool({ sessionKey: SEND_DM, items });
    assert.equal(r.ok, false, JSON.stringify(items));
    assert.equal(r.sent, 0, JSON.stringify(items));
  }
  assert.equal(h.transport.sent.length, 0, '整批拒时连合格的那一条也不该发');

  // note 要提到"文件发送还没做"（别让她以为是自己写错了）。
  const file = await h.gateway.sendFromTool({
    sessionKey: SEND_DM,
    items: [{ kind: 'file', text: 'x' }],
  });
  assert.match(file.note, /文件发送还没做/);
});

test('★ sendFromTool：同会话 30 秒内第二次 ⇒ 拒（一条不发），冷却过后才放行', async () => {
  const h = sendHarness();
  const first = await h.gateway.sendFromTool({ sessionKey: SEND_DM, items: [{ text: '第一条' }] });
  assert.equal(first.ok, true);
  assert.equal(h.transport.sent.length, 1);

  const second = await h.gateway.sendFromTool({ sessionKey: SEND_DM, items: [{ text: '第二条' }] });
  assert.equal(second.ok, false);
  assert.equal(second.sent, 0);
  assert.match(second.note, /秒后才能再发/);
  assert.equal(h.transport.sent.length, 1, '被频率闸拒时一条都不该发');

  // ⚠️ 频率闸读的是**真实时钟 `Date.now()`**（不是注入的 `engine.now()`）——
  // 所以这里只能把"上次发送时刻"往前挪 31 秒来模拟冷却结束。
  // 这同时是一条**生产疑点**的记录：网关别处的时间都可注入，只有这里不行。
  h.gateway.sendToolLastAt.set('private:30000001', Date.now() - 31_000);
  const third = await h.gateway.sendFromTool({ sessionKey: SEND_DM, items: [{ text: '第三条' }] });
  assert.equal(third.ok, true);
  assert.equal(h.transport.sent.length, 2);
});

test('★ sendFromTool：被同文闸拦下的那条**不计入 sent**，但 ok 仍为 true', async () => {
  const h = sendHarness();
  const first = await h.gateway.sendFromTool({ sessionKey: SEND_DM, items: [{ text: '同一条' }] });
  assert.deepEqual(first, { ok: true, sent: 1, note: '发了 1 条。' });

  // 绕过频率闸（测试里不必真等 30 秒）；同文闸的时钟是 `engine.now()`
  // （这个 harness 固定在 T0）⇒ 仍会把它拦下。
  h.gateway.sendToolLastAt.clear();
  const second = await h.gateway.sendFromTool({ sessionKey: SEND_DM, items: [{ text: '同一条' }] });
  assert.deepEqual(second, { ok: true, sent: 0, note: '发了 0 条。' });
  assert.equal(h.transport.sent.length, 1, '被同文闸拦下的那条不该真的发出去');
  assert.ok(
    h.logs.some(
      (l) => l.level === 'warn' && /拦下重复发送/.test(l.message) && l.meta?.caller === 'send_qq',
    ),
    `同文闸要留一条 caller=send_qq 的 warn，实际：${JSON.stringify(h.logs.slice(-5))}`,
  );
});

test('★ sendFromTool：某一条抛错 ⇒ ok:false，sent 报**已经发出去的条数**（不谎报）', async () => {
  const h = sendHarness();
  const orig = h.transport.sendToChat.bind(h.transport);
  let calls = 0;
  h.transport.sendToChat = async (chatId, message) => {
    calls += 1;
    if (calls === 2) throw new Error('NapCat 挂了');
    return orig(chatId, message);
  };

  const r = await h.gateway.sendFromTool({
    sessionKey: SEND_DM,
    items: [{ text: '一' }, { text: '二' }, { text: '三' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.sent, 1);
  assert.match(r.note, /第 2 条时出错/);
  assert.match(r.note, /前面已经发出去 1 条/);
  assert.equal(h.transport.sent.length, 1);
  assert.equal(calls, 2, '出错即停，第三条不该再尝试');
  assert.ok(
    h.logs.some((l) => l.level === 'warn' && /send_qq 发送失败/.test(l.message)),
    `发送失败要留一条 warn，实际：${JSON.stringify(h.logs.slice(-5))}`,
  );
});

test('sendFromTool：第一条就抛 ⇒ sent 为 0，异常不冒泡', async () => {
  const h = sendHarness();
  h.transport.sendToChat = async () => {
    throw new Error('boom');
  };
  const r = await h.gateway.sendFromTool({ sessionKey: SEND_DM, items: [{ text: '一' }] });
  assert.equal(r.ok, false);
  assert.equal(r.sent, 0);
  assert.match(r.note, /第 1 条时出错/);
  assert.equal(h.transport.sent.length, 0);
});

// ======================================================== 入站锚点（2026-10-23）
//
// 定时唤醒的长间隔与短追问都以「用户最后一条消息」为锚点，而"用户说了话"
// 这件事只有网关知道 ⇒ `gateway.onUserMessage`。这一组钉三件事：
//   ① 每条入站消息都转告一次（给的是**归一化后**的消息，不是原始事件）；
//   ② 重复投递（重连补发）只算一次；
//   ③ 回调抛错**不许**带走消息处理 —— 它挂在每条入站事件上（2026-10-14 那类事故）。

test('onUserMessage：每条入站消息转告一次，给的是归一化后的消息', async () => {
  const h = harness();
  const seen = [];
  h.gateway.onUserMessage = (message) => seen.push(message);

  await h.gateway.handleEvent(dmEvent({ user_id: 2001, message_id: 1 }));
  await h.gateway.handleEvent(groupEvent({ user_id: 2001, message_id: 2 }));

  assert.equal(seen.length, 2);
  assert.equal(seen[0].chatId, 'private:2001');
  assert.equal(seen[0].userId, '2001');
  assert.equal(typeof seen[0].at, 'number');
  assert.equal(seen[1].chatId, 'group:100');
});

test('onUserMessage：重复的 message_id 只算一次（重连补发不重置定时器）', async () => {
  const h = harness();
  let calls = 0;
  h.gateway.onUserMessage = () => { calls += 1; };

  await h.gateway.handleEvent(dmEvent({ message_id: 7 }));
  await h.gateway.handleEvent(dmEvent({ message_id: 7 }));
  assert.equal(calls, 1);
});

test('onUserMessage：被忽略的消息也算"用户说过话"（放在任何早退之前）', async () => {
  // 白名单外的私聊会被路由忽略，但它仍然是用户自己发的 —— 锚点要记。
  const h = harness({ router: { dmPolicy: POLICY.ALLOWLIST, allowFrom: ['10000001'] } });
  let calls = 0;
  h.gateway.onUserMessage = () => { calls += 1; };
  const result = await h.gateway.handleEvent(dmEvent({ user_id: 3000, message_id: 9 }));
  assert.equal(result.outcome, OUTCOME.IGNORED);
  assert.equal(calls, 1);
});

test('onUserMessage：回调抛错不带走这一轮（异常自己吞掉）', async () => {
  const h = harness();
  h.gateway.onUserMessage = () => { throw new Error('锚点炸了'); };
  const result = await h.gateway.handleEvent(dmEvent({ message_id: 11 }));
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.transport.sent.length, 1, '消息照样回出去了');
  assert.ok(
    h.logs.some((l) => /用户消息锚点记录失败/.test(l.message)),
    '要留一条日志，不然"锚点坏了"永远查不到',
  );
});

test('onUserMessage：没挂（null）⇒ 一切照旧', async () => {
  const h = harness();
  assert.equal(h.gateway.onUserMessage, null);
  const result = await h.gateway.handleEvent(dmEvent({ message_id: 12 }));
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
});

// ---------------------------------------------------------------- 空回复不能静默丢（2026-10-28）

/**
 * 事故：2026-10-28 20:43 私聊那一轮，responder 返回了 `''`（因为压缩把取回复的
 * 主路径切空了），而这里的分支把它当"模型决定不说话"处理 ——
 * **不发、不留痕、台账里连 `gw-send` 都没有**。
 *
 * 修法：判据由 binder 通过 `diagnoseEmptyReply` 注入（网关自己不猜），
 * 但**只影响日志与计数**，发送决策一个字节都没动。
 */

test('空回复：诊断指向"丢了"⇒ warn + 计数 + 快照有现场', async () => {
  const diag = { kind: 'lost', before: 900, after: 30, historyShrank: true, streamFrames: 3, streamedChars: 0 };
  const h = harness({
    responder: async () => '',
    gateway: { diagnoseEmptyReply: () => diag },
  });
  const result = await h.gateway.handleEvent(dmEvent());
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.transport.sent.length, 0, '空回复照旧不发（发送决策没变）');
  const warn = h.logs.find((l) => l.level === 'warn' && /静默丢弃/.test(l.message));
  assert.ok(warn, '这就是"必须留痕"的那一条');
  assert.equal(warn.meta.historyShrank, true);
  assert.equal(warn.meta.before, 900);
  assert.equal(warn.meta.after, 30);
  assert.equal(h.gateway.stats.emptyReplies, 1);
  assert.equal(h.gateway.stats.lostReplies, 1);
  assert.equal(h.gateway.stats.compactedTurns, 1);
  assert.equal(h.gateway.lastEmptyReply.kind, 'lost');
  assert.equal(h.gateway.lastEmptyReply.chatId, 'private:2001');
});

test('空回复：模型真没说话（诊断 kind=empty）⇒ 不 warn，只计数', async () => {
  const h = harness({
    responder: async () => '',
    gateway: { diagnoseEmptyReply: () => ({ kind: 'empty', before: 10, after: 10, historyShrank: false, streamFrames: 0, streamedChars: 0 }) },
  });
  await h.gateway.handleEvent(dmEvent());
  assert.equal(h.transport.sent.length, 0);
  assert.equal(h.logs.some((l) => l.level === 'warn' && /静默丢弃/.test(l.message)), false, '正常沉默别刷屏');
  assert.equal(h.gateway.stats.emptyReplies, 1);
  assert.equal(h.gateway.stats.lostReplies, 0);
  assert.equal(h.gateway.lastEmptyReply, null);
});

test('空回复：没接诊断（未接线 / 老调用方）⇒ 行为与改动前逐字相同', async () => {
  const h = harness({ responder: async () => '' });
  await h.gateway.handleEvent(dmEvent());
  assert.equal(h.transport.sent.length, 0);
  assert.equal(h.logs.some((l) => l.level === 'warn' && /静默丢弃/.test(l.message)), false);
  assert.equal(h.gateway.stats.emptyReplies, 1, '计数照样有（它不依赖诊断）');
  assert.equal(h.gateway.stats.lostReplies, 0);
});

test('空回复：诊断本身抛异常时不炸这一轮', async () => {
  const h = harness({
    responder: async () => '',
    gateway: { diagnoseEmptyReply: () => { throw new Error('诊断坏了'); } },
  });
  const result = await h.gateway.handleEvent(dmEvent());
  assert.equal(result.outcome, OUTCOME.DISPATCHED, '回调抛异常绝不能把这一轮带走');
  assert.equal(h.gateway.stats.emptyReplies, 1);
  assert.equal(h.gateway.stats.lostReplies, 0);
});
