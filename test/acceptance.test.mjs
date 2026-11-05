/**
 * 验收测试：把多种真实实现形态的 OneBot 事件喂进**完整插件装配**，
 * 检查最终发出的报文字段。
 *
 * 与 gateway 的单测不同，这里关注的是"跨模块的保真度"：
 * 协议层归一化 → 网关编排 → 会话 → 回复 → 出站组装的整条路上，
 * 消息有没有被改造错。所以断言直接打在**发出去的 OneBot 报文**上。
 *
 * 刻意混合了不同实现的形态：
 * - 段数组（OneBot 标准推荐）
 * - CQ 串（go-cqhttp 老配置）
 * - 值里带 `&amp;` 转义（NapCat 把 URL 的 `&` 转义）
 * - 空群名片 / 匿名 / 字符串型 id
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY, DM_ROUTING } from '../src/dsh/routing.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';
import { judge } from '../src/dsh/heuristic-gauge.mjs';

const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);

/**
 * 装一套完整的网关：真实 protocol / Router / ProactiveEngine / gauge，
 * 只有传输层与会话是假的。
 * @param {object} [options]
 */
function acceptanceHarness(options = {}) {
  const emitter = new EventEmitter();
  /** 发出去的原始 OneBot 报文（`{action, params, ...}`）。 */
  const sent = [];
  const transport = {
    selfId: options.selfId ?? '999',
    sent,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async sendToChat(chatId, message) {
      // 模拟真实传输层：私聊走 send_private_msg、群聊走 send_group_msg，
      // 并把 id 收敛成数字（与 transport.mjs 的 toNumeric 一致）。
      const i = chatId.indexOf(':');
      const kind = chatId.slice(0, i);
      const target = Number(chatId.slice(i + 1));
      if (kind === 'group') sent.push({ action: 'send_group_msg', params: { group_id: target, message } });
      else sent.push({ action: 'send_private_msg', params: { user_id: target, message } });
      return sent.length;
    },
  };

  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.OPEN,
    requireMention: false,
    restrictMembers: false,
    ...(options.router ?? {}),
  });

  const engine = new ProactiveEngine({
    config: {
      enabled: options.proactive === true,
      minIntervalMs: 0,
      maxPerHour: 10,
      cooldownAfterBotMs: 0,
      afterUserMsgCount: 1,
      ...(options.engineConfig ?? {}),
    },
    gauge: (request) => judge(request, { config: { enabled: true, minSignals: 2, lookback: 6 } }),
    // 准入必须与 Router 一致——这正是审计修掉的那条
    allowed: (chatId) => router.proactiveAllowed(chatId),
    speak: async ({ chatId, text }) => {
      await transport.sendToChat(chatId, text);
    },
    log: () => {},
  });

  const prompts = [];
  const gateway = new Gateway({
    transport,
    router,
    engine,
    responder: async (request) => {
      prompts.push(request);
      return options.reply ?? `回：${request.prompt}`;
    },
    log: () => {},
  });
  gateway.attach();
  return { gateway, transport, sent, prompts, engine, router };
}

// ---------------------------------------------------------------- 出站报文形态

test('验收：群聊回复用 send_group_msg，群号是数字', async () => {
  const h = acceptanceHarness();
  await h.gateway.handleEvent({
    time: Math.floor(T0 / 1000), self_id: 999,
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: 1, group_id: 100, user_id: 2001,
    message: [{ type: 'at', qq: '999' }, { type: 'text', text: ' 在吗' }],
    raw_message: '[CQ:at,qq=999] 在吗',
    sender: { nickname: '阿猫', card: '群名片猫' },
  });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].action, 'send_group_msg');
  assert.equal(h.sent[0].params.group_id, 100);
  assert.equal(typeof h.sent[0].params.group_id, 'number', 'id 必须是数字，字符串会让部分实现拒绝');
  // @ 段渲染成 `@999`（看得见 @ 的是谁），后面才是正文。
  // 外面那层【刚 @ 你的那条】是 2026-10-07 加的（被点名那轮也要带上下文）。
  // ⚠️ 2026-10-13 改过：前缀里的时间戳**不是当天就带日期**（事件固定在 `T0` ⇒ 带日期），
  // 两种形态本身钉在 `routing.test.mjs`（那里 `now` 是注入的）。
  assert.match(
    h.sent[0].params.message,
    /^回：【刚 @ 你的那条】\[(?:\d{2}-\d{2} )?20:00 群名片猫\(2001\)\] @999 在吗$/,
  );
});

test('验收：私聊回复用 send_private_msg，user_id 是数字', async () => {
  const h = acceptanceHarness();
  await h.gateway.handleEvent({
    time: Math.floor(T0 / 1000), self_id: 999,
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    message_id: 1, user_id: 2001,
    message: [{ type: 'text', text: '在吗' }], raw_message: '在吗',
    sender: { nickname: '阿猫' },
  });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].action, 'send_private_msg');
  assert.equal(h.sent[0].params.user_id, 2001);
  assert.equal(typeof h.sent[0].params.user_id, 'number');
  // 私聊仍然不加**发言人**前缀（上下文里只有两个人），但时间戳照带（2026-10-13）。
  assert.match(h.sent[0].params.message, /^回：\[(?:\d{2}-\d{2} )?20:00\] 在吗$/);
});

// ---------------------------------------------------------------- 不同实现形态

test('验收：CQ 串形态（老 go-cqhttp）能被正确处理', async () => {
  const h = acceptanceHarness();
  await h.gateway.handleEvent({
    time: Math.floor(T0 / 1000), self_id: 999,
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: 1, group_id: 100, user_id: 2001,
    message: '[CQ:at,qq=999] 看这个[CQ:image,file=a.jpg]',
    raw_message: '[CQ:at,qq=999] 看这个[CQ:image,file=a.jpg]',
    sender: { nickname: '阿猫' },
  });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].params.message, /看这个\[图片\]/, '非文本段应压成占位符');
});

test('验收：段数组里 URL 带 &amp; 转义时被反转义（NapCat 行为）', async () => {
  // 这一条不直接影响出站文本，但会决定"能不能去下载这张图"。
  // 这里验证的是归一化没有把它留在中间层。
  const h = acceptanceHarness();
  await h.gateway.handleEvent({
    time: Math.floor(T0 / 1000), self_id: 999,
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: 1, group_id: 100, user_id: 2001,
    message: [{ type: 'at', qq: '999' }, { type: 'image', url: 'https://x/y?a=1&amp;b=2' }],
    raw_message: '[CQ:at,qq=999]',
    sender: { nickname: '阿猫' },
  });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].params.message, /\[图片\]/);
});

test('验收：字符串型 id 也能正确处理', async () => {
  const h = acceptanceHarness();
  await h.gateway.handleEvent({
    time: Math.floor(T0 / 1000), self_id: '999',
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: 1, group_id: '100', user_id: '2001',
    message: [{ type: 'at', qq: 999 }, { type: 'text', text: ' hi' }],
    raw_message: '',
    sender: { nickname: '阿猫', card: '' },
  });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].params.group_id, 100, '字符串群号应被收敛成数字');
  assert.match(h.sent[0].params.message, /阿猫/, '空群名片应回退到昵称');
});

test('验收：纯媒体消息用占位符进提示词，不被当成空消息丢掉', async () => {
  const h = acceptanceHarness();
  await h.gateway.handleEvent({
    time: Math.floor(T0 / 1000), self_id: 999,
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: 1, group_id: 100, user_id: 2001,
    message: [{ type: 'at', qq: '999' }, { type: 'video' }, { type: 'file' }],
    raw_message: '',
    sender: { nickname: '阿猫' },
  });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].params.message, /\[视频\]\[文件\]/);
});

// ---------------------------------------------------------------- 会话隔离

test('验收：三个会话互不串台（群 A、群 B、私聊各一个）', async () => {
  const h = acceptanceHarness({ reply: 'ok' });
  const mk = (n, type, id) => ({
    time: Math.floor(T0 / 1000), self_id: 999,
    post_type: 'message', message_type: type, sub_type: type === 'group' ? 'normal' : 'friend',
    message_id: n,
    ...(type === 'group' ? { group_id: id } : {}),
    user_id: id,
    message: [{ type: 'at', qq: '999' }, { type: 'text', text: `m${n}` }],
    raw_message: `m${n}`,
    sender: { nickname: 'n' },
  });

  await h.gateway.handleEvent(mk(1, 'group', 100));
  await h.gateway.handleEvent(mk(2, 'group', 200));
  await h.gateway.handleEvent(mk(3, 'private', 2001));

  assert.deepEqual(
    h.sent.map((s) => s.action),
    ['send_group_msg', 'send_group_msg', 'send_private_msg'],
  );
  assert.deepEqual(
    h.prompts.map((p) => p.sessionKey),
    ['qq-group-100', 'qq-group-200', 'qq-private-2001'],
    '三个会话必须各自独立',
  );
});

test('验收：dmRouting=main 时不同私聊联系人进同一个会话，但回复各自发回原处', async () => {
  const h = acceptanceHarness({
    reply: 'ok',
    router: { dmRouting: DM_ROUTING.MAIN, mainSessionKey: 'session-main' },
  });
  const dm = (n, uid) => ({
    time: Math.floor(T0 / 1000), self_id: 999,
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    message_id: n, user_id: uid,
    message: [{ type: 'text', text: `hi${n}` }], raw_message: `hi${n}`,
    sender: { nickname: 'n' },
  });

  await h.gateway.handleEvent(dm(1, 2001));
  await h.gateway.handleEvent(dm(2, 3000));

  assert.deepEqual(
    h.prompts.map((p) => p.sessionKey),
    ['session-main', 'session-main'],
    'main 模式下必须进同一个会话',
  );
  assert.deepEqual(
    h.sent.map((s) => s.params.user_id),
    [2001, 3000],
    '回复必须各自发回原联系人',
  );
});

// ---------------------------------------------------------------- 端到端行为

test('验收：重复投递同一条消息只发一次', async () => {
  const h = acceptanceHarness({ reply: 'ok' });
  const event = {
    time: Math.floor(T0 / 1000), self_id: 999,
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: 777, group_id: 100, user_id: 2001,
    message: [{ type: 'at', qq: '999' }, { type: 'text', text: 'x' }],
    raw_message: 'x', sender: { nickname: 'n' },
  };
  await h.gateway.handleEvent(event);
  await h.gateway.handleEvent(event);
  await h.gateway.handleEvent(event);
  assert.equal(h.sent.length, 1);
});

test('验收：被 @ 时插话同样走会话（统一回复路径）', async () => {
  // ⚠️ **2026-10-13 第三次改这个用例**（方案 3：权重换拟合值 + 砍 `helpHits`/`opinionHits`）。
  //
  // 沿革：
  //   · 2026-10-07：原来发 **3 条**、断言出站 **1** 条 —— 那"1 条"其实是被
  //     `burst-too-small` 筛出来的（那道闸门已删）。改成一条 + 断言一条。
  //   · 2026-10-13 第一版：把消息换成「你觉得这个方案行不行」（`opinionHits` +1.8968）。
  //   · 2026-10-13 第二版（本条）：`opinionHits` / `helpHits` **都被用户拍板砍掉了**
  //     ⇒ **没有任何单条内容能拿到正分**。
  //
  // ⚠️ **实测结论（要记住的口径）**：砍完之后，在**全新会话**上，
  // `relevance == 0` 的主动插话**几乎不可能**发生 —— 剩的三项撑不起来：
  //   · `substantive` **负**（−0.0670）⇒ 越有内容越扣
  //   · `questions` +0.0860 × 100 = **8.6/句**（窗口最多 20 条 ⇒ 上限 172，但**从未**接近阈值）
  //   · `techHits` +5.29/个
  //   · `presence`（`selfRatio`）要**她先说过话**才非零
  // ⇒ 所以这条验收改成钉**"被 @"这条路**（闸门短路 + gauge 保底），
  //   它才是现在真正在干活的那条路。
  //
  //   至于"没人 @ 也能接话"：真实数据里靠的是 **presence**（她刚说过话、别人接着说），
  //   离线重放三群 20.66% 就是这么来的。那条路要跨多轮才出现，**不适合塞进验收测试**
  //   （构造起来是"她先回一条 → 别人再说"）。判定层的口径在
  //   `heuristic-gauge.test.mjs` 里逐项钉住了。
  const h = acceptanceHarness({
    proactive: true,
    reply: 'ok',
    router: { requireMention: true },
  });
  /** 带**真 `at` 段**的消息（正文里写 `@999` 不触发 `mentioned`，实测过）。 */
  const chatter = (n, uid, text, at = false) => ({
    time: Math.floor(T0 / 1000) + n, self_id: 999,
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: n, group_id: 100, user_id: uid,
    message: at
      ? [{ type: 'at', data: { qq: '999' } }, { type: 'text', text }]
      : [{ type: 'text', text }],
    raw_message: at ? `[CQ:at,qq=999]${text}` : text,
    sender: { nickname: `u${uid}` },
  });
  // 一条 @ 我 + 求助词的消息：求助词现在是**负分**，全靠 @ 那 60 分 + 保底放行。
  await h.gateway.handleEvent(chatter(1, 5001, '这个接口一直报错，谁知道怎么解决', true));

  assert.equal(h.sent.length, 1, `应恰好一条出站（插话），实际 ${h.sent.length}`);
  assert.equal(h.sent[0].action, 'send_group_msg');
  assert.equal(h.sent[0].params.group_id, 100);
  assert.equal(h.sent[0].params.message, 'ok');
  // 关键变化：插话也**经过会话**（旧实现用 llm 措辞直接发，会话一次都不唤）。
  assert.equal(h.prompts.length, 1, '插话也应该唤起会话（统一回复路径）');
  // ⚠️ 措辞随路径不同（2026-10-13 实测）：
  //   · **被 @**（本条）⇒ 提示词是「【刚 @ 你的那条】…」—— 被点名，走被动那条措辞
  //   · 没人 @、靠打分/存在感放行 ⇒ 才是「你想接一句话」
  // 原来这里钉的是后者（旧用例走的是打分那条路）。现在本用例走前者，所以按实际改。
  assert.match(h.prompts[0].prompt, /刚 @ 你的那条/, '被 @ 时用"刚 @ 你的那条"措辞');
});

test('验收（2026-10-13 新增）：没人 @ 时，"求助 / 征求意见"都不再插话', async () => {
  // 这条**刻意钉住**权重的方向性反转（砍 `helpHits` / `opinionHits` 的直接后果）。
  // 它的价值：万一以后有人把这两项加回 `fitWeights`，这条会红 ——
  // 而那一刻需要的是**重新做一次校准**（重扫 threshold），不是把测试改掉。
  const h = acceptanceHarness({ proactive: true, reply: 'ok', router: { requireMention: true } });
  const chatter = (n, uid, text) => ({
    time: Math.floor(T0 / 1000) + n, self_id: 999,
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: n, group_id: 100, user_id: uid,
    message: [{ type: 'text', text }], raw_message: text,
    sender: { nickname: `u${uid}` },
  });
  for (const [i, text] of [
    '这个接口一直报错，谁知道怎么解决',   // 求助（曾是 +36）
    '你觉得这个方案行不行',               // 征求意见（曾是 +30，拟合后 +1.8968）
    '这个 API 怎么调',                    // 技术词 + 问句（曾是「技术词 + 问句 ⇒ 触发」）
  ].entries()) {
    await h.gateway.handleEvent(chatter(i + 1, 5001, text));
  }
  assert.equal(h.sent.length, 0, '三条都没到阈值 50 ⇒ 一条都不插话');
  assert.equal(h.prompts.length, 0);
});

test('验收：主动插话在准入不允许时一次都不发', async () => {
  const h = acceptanceHarness({
    proactive: true,
    reply: 'ok',
    // 白名单里没有 group:100 → 主动发言被拒
    router: { groupPolicy: POLICY.ALLOWLIST, groupAllowFrom: ['999'] },
  });
  const chatter = (n, uid, text) => ({
    time: Math.floor(T0 / 1000) + n, self_id: 999,
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: n, group_id: 100, user_id: uid,
    message: [{ type: 'text', text }], raw_message: text,
    sender: { nickname: `u${uid}` },
  });
  await h.gateway.handleEvent(chatter(1, 5001, '这个接口一直报错，谁知道怎么解决'));
  await h.gateway.handleEvent(chatter(2, 5002, '我也卡住了，求助一下'));
  await h.gateway.handleEvent(chatter(3, 5001, '有人遇到过吗'));
  assert.equal(h.sent.length, 0, '准入不过就不该有任何出站消息');
});

test('验收：机器人自己发的消息不会造成自循环', async () => {
  const h = acceptanceHarness({ reply: 'ok' });
  await h.gateway.handleEvent({
    time: Math.floor(T0 / 1000), self_id: 999,
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: 1, group_id: 100, user_id: 999,
    message: [{ type: 'text', text: '我自己说的话' }], raw_message: '我自己说的',
    sender: { nickname: '机器人' },
  });
  assert.equal(h.sent.length, 0, '自己的消息不该被回');
  assert.equal(h.prompts.length, 0);
});

test('验收：超长回复按上限截断后才发出', async () => {
  const h = acceptanceHarness({ reply: 'x'.repeat(5000) });
  // 走默认 2000 上限
  await h.gateway.handleEvent({
    time: Math.floor(T0 / 1000), self_id: 999,
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    message_id: 1, user_id: 2001,
    message: [{ type: 'text', text: 'hi' }], raw_message: 'hi',
    sender: { nickname: 'n' },
  });
  const text = h.sent[0].params.message;
  assert.ok(Array.from(text).length <= 2000, `实际 ${Array.from(text).length}`);
  assert.ok(text.endsWith('…'));
});
