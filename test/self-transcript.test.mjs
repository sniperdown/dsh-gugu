/**
 * 转录里也要有**她自己发出去的那句话**（2026-11-10，主人明确要求）。
 *
 * ## 为什么要有这一批
 *
 * 转录原来只收**入站**消息（`engine.decide()` 对 `fromSelf` 提前 return），于是
 * 「群里刚在聊」那段里**没有小鲸鱼刚说过的话** —— 群一热闹，她自己都分不清
 * 哪句是别人说的、哪句是她自己说的。主人 2026-11-10 拍板：群聊优先，私聊一起做。
 *
 * ## 钉住的判据
 *
 * 1. 群聊发一段正文 ⇒ 转录里出现一条 `fromSelf` 记录，渲染成 `我(小鲸鱼)`；
 * 2. `⟨cut⟩` 切 3 段 ⇒ **3 条**（对方确实看到 3 条），内容与顺序对得上；
 * 3. 私聊同样生效（`kind: 'private'`）；
 * 4. 发送失败 / `[不说话]` / 空正文 ⇒ **一条都不写**；
 * 5. 同一段不重复写（一次发送 = 一条记录）；
 * 6. 判定层不因此重复计数（打分窗口里仍然没有 `fromSelf` 条目，见引擎 `#decide`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { createOutboundAllow } from '../src/dsh/outbound-allow.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

const T0 = Date.UTC(2026, 4, 1, 12, 0, 0); // UTC+8 ⇒ 20:00
const GROUP_CHAT = 'group:100';
const GROUP_KEY = 'qq-group-100';
const PRIVATE_CHAT = 'private:2001';
const PRIVATE_KEY = 'qq-private-2001';
const RELAY_ALLOW = createOutboundAllow({ allowFrom: ['2001'], groupAllowFrom: ['100'] });

function harness(options = {}) {
  const transport = {
    selfId: '999',
    sent: [],
    on: () => {},
    off: () => {},
    emit: () => {},
    async sendToChat(chatId, message) {
      if (options.failSend === true) throw new Error('发送失败');
      this.sent.push({ chatId, message });
      return this.sent.length;
    },
  };
  const engine = new ProactiveEngine({
    config: {
      enabled: false,
      minIntervalMs: 0,
      maxPerHour: 10,
      cooldownAfterBotMs: 0,
      afterUserMsgCount: 1,
    },
    gauge: async () => ({ speak: true, text: 'x' }),
    speak: async () => undefined,
    log: () => {},
    now: () => T0,
  });
  const gateway = new Gateway({
    transport,
    router: new Router({
      dmPolicy: POLICY.OPEN,
      groupPolicy: POLICY.OPEN,
      requireMention: true,
      adminUsers: ['9001'],
    }),
    engine,
    outboundAllow: RELAY_ALLOW,
    responder: async () => options.reply ?? '回复正文',
    log: () => {},
    maxReplyChars: 2000,
    autoReply: options.autoReply ?? 'fallback',
    splitMarker: options.splitMarker ?? '⟨cut⟩',
    outboundLedger: { record: () => {} },
  });
  gateway.attach();
  return { gateway, engine, transport };
}

function message(chatId = GROUP_CHAT, kind = 'group') {
  return {
    chatId,
    kind,
    userId: kind === 'group' ? '3001' : '2001',
    nickname: '阿猫',
    text: '在吗',
    at: T0,
    mentioned: true,
    replyToSelf: false,
    segments: [{ type: 'text', text: '在吗' }],
    raw: '在吗',
  };
}

function runTurn(gateway, { chatId = GROUP_CHAT, sessionKey = GROUP_KEY, kind = 'group', text = '在吗' } = {}) {
  const m = message(chatId, kind);
  m.text = text;
  m.segments = [{ type: 'text', text }];
  m.raw = text;
  return gateway.runTurn({ message: m, sessionKey, restricted: false, prompt: text });
}

/** 转录里的自己发言（只要 `fromSelf` 的那些）。 */
function selfEntries(engine, chatId = GROUP_CHAT) {
  return engine.transcript(chatId).snapshot().filter((m) => m?.fromSelf === true);
}

// ---------------------------------------------------------------- 群聊

test('★ 群聊：发出去的一段正文 ⇒ 转录里多一条「我」的记录（带时间戳与名字）', async () => {
  const h = harness({ reply: '在的，我在' });
  await runTurn(h.gateway);
  const mine = selfEntries(h.engine);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].text, '在的，我在');
  assert.equal(mine[0].at, T0);
  assert.equal(mine[0].kind, 'group');
  assert.equal(mine[0].nickname, '小鲸鱼');
  // 渲染形状（这就是模型看到的那一行）
  assert.equal(h.engine.transcript(GROUP_CHAT).render(20, null, { now: T0 }), '[20:00] 我(小鲸鱼): 在的，我在');
});

test('★ 渲染：入站行形状不变，自己那行是 `我(小鲸鱼)`（混排也认得出）', async () => {
  const h = harness({ reply: '嗯' });
  h.engine.noteSelfMessage(GROUP_CHAT, '我先说一句', T0);
  h.engine.transcript(GROUP_CHAT).push({
    chatId: GROUP_CHAT,
    kind: 'group',
    userId: '3001',
    nickname: '阿猫',
    text: '接话',
    at: T0 + 1000,
    fromSelf: false,
  });
  const rendered = h.engine.transcript(GROUP_CHAT).render(20, null, { now: T0 + 1000 });
  assert.match(rendered, /^\[20:00\] 我\(小鲸鱼\): 我先说一句\n\[20:00\] 阿猫\(3001\): 接话$/u);
});

// ---------------------------------------------------------------- ⟨cut⟩ 切段

test('★ ⟨cut⟩ 切 3 段 ⇒ 转录 3 条，内容与顺序与真发出去的一致', async () => {
  const h = harness({ reply: '一 ⟨cut⟩ 二 ⟨cut⟩ 三' });
  await runTurn(h.gateway);
  // 先确认对方真的收到 3 条（这是"写 3 条"的依据）
  assert.equal(h.transport.sent.length, 3);
  const mine = selfEntries(h.engine);
  assert.deepEqual(mine.map((m) => m.text), ['一', '二', '三']);
  assert.deepEqual(mine.map((m) => m.at), [T0, T0, T0]);
  // 同一次发送里，每段**恰好一条**（不是 6 条）
  assert.equal(mine.length, 3);
});

test('⟨cut⟩ 只有标记没有内容 ⇒ 一条都不发，转录也不写', async () => {
  const h = harness({ reply: '⟨cut⟩\n   \n⟨cut⟩' });
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 0);
  assert.equal(selfEntries(h.engine).length, 0);
});

// ---------------------------------------------------------------- 私聊

test('★ 私聊：同样留痕（对方就是主人），`kind` 记成 private', async () => {
  const h = harness({ reply: '收到' });
  await runTurn(h.gateway, { chatId: PRIVATE_CHAT, sessionKey: PRIVATE_KEY, kind: 'private' });
  const mine = selfEntries(h.engine, PRIVATE_CHAT);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].text, '收到');
  assert.equal(mine[0].kind, 'private');
  assert.equal(
    h.engine.transcript(PRIVATE_CHAT).render(20, null, { now: T0 }),
    '[20:00] 我(小鲸鱼): 收到',
  );
});

test('私聊 ⟨cut⟩ 两段 ⇒ 两条记录（群聊/私聊走的是同一条路）', async () => {
  const h = harness({ reply: '先这样 ⟨cut⟩ 再说' });
  await runTurn(h.gateway, { chatId: PRIVATE_CHAT, sessionKey: PRIVATE_KEY, kind: 'private' });
  assert.deepEqual(selfEntries(h.engine, PRIVATE_CHAT).map((m) => m.text), ['先这样', '再说']);
});

// ---------------------------------------------------------------- 不该写的情况

test('★ 发送失败（传输层抛错）⇒ 转录一条都不写，异常照原样抛出去', async () => {
  const h = harness({ reply: '这句话发不出去', failSend: true });
  await assert.rejects(runTurn(h.gateway), /发送失败/u);
  assert.equal(h.transport.sent.length, 0);
  assert.equal(selfEntries(h.engine).length, 0);
});

test('★ `[不说话]` ⇒ 不发也不写（静默标记不是发言）', async () => {
  const h = harness({ reply: '[不说话]' });
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 0);
  assert.equal(selfEntries(h.engine).length, 0);
});

test('★ 空正文 / 纯空白 ⇒ 不发也不写', async () => {
  const h = harness({ reply: '   ' });
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 0);
  assert.equal(selfEntries(h.engine).length, 0);
});

test('空正文 ⇒ 不发也不写；只有图片源那条（正文空）同样不写"空话"', async () => {
  const h = harness({ reply: '' });
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 0);
  assert.equal(selfEntries(h.engine).length, 0);
});

// ---------------------------------------------------------------- 不重复写

test('★ 同一段不重复写：一次发送正好一条记录', async () => {
  const h = harness({ reply: '只说一次' });
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 1);
  assert.equal(selfEntries(h.engine).length, 1);
});

test('同文短窗拦下第二遍 ⇒ 没真发出去，也就不写第二条', async () => {
  const h = harness({ reply: '一模一样的话' });
  await runTurn(h.gateway);
  await runTurn(h.gateway);
  // 第二遍被同文闸拦下（这一轮的台账里没有第二条 transport 记录）
  assert.equal(h.transport.sent.length, 1);
  assert.equal(selfEntries(h.engine).length, 1);
});

test('send_qq 工具每发一条 ⇒ 一条记录（工具那条路也走同一个口）', async () => {
  const h = harness();
  const out = await h.gateway.sendFromTool({
    sessionKey: GROUP_KEY,
    items: [{ kind: 'text', text: '第一句' }, { kind: 'text', text: '第二句' }],
  });
  assert.equal(out.ok, true);
  assert.equal(out.sent, 2);
  assert.deepEqual(selfEntries(h.engine).map((m) => m.text), ['第一句', '第二句']);
});

// ---------------------------------------------------------------- 判定层不重复计数

test('★ 判定层：打分窗口里没有 `fromSelf` 条目，但渲染文本里看得到她说的那句', async () => {
  const requests = [];
  const engine = new ProactiveEngine({
    config: { enabled: true, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0, afterUserMsgCount: 0 },
    gauge: async (request) => {
      requests.push(request);
      return { speak: true, text: 'x' };
    },
    speak: async () => undefined,
    log: () => {},
    now: () => T0,
    names: ['小鲸鱼'],
  });
  engine.noteSelfMessage(GROUP_CHAT, '我刚说过这句', T0 - 1000);
  const verdict = await engine.decide(message());
  assert.equal(verdict.speak, true);
  assert.equal(requests.length, 1);
  const req = requests[0];
  // ① 窗口（打分原料）里一条自己都没有 —— 自己那几句靠 `selfAt` 单独带进去，不会重复计数
  assert.equal(req.recent.filter((m) => m?.fromSelf === true).length, 0);
  // ② 但渲染给模型看的文本里有（这就是这次改动的目的）
  assert.match(req.transcript, /我\(小鲸鱼\): 我刚说过这句/u);
});

test('noteSelfMessage：空正文 / 空 chatId 一律拒，时间戳缺省用注入时钟', () => {
  const engine = new ProactiveEngine({
    config: {},
    gauge: async () => null,
    speak: async () => undefined,
    log: () => {},
    now: () => T0,
  });
  assert.equal(engine.noteSelfMessage(GROUP_CHAT, '   '), false);
  assert.equal(engine.noteSelfMessage('', '有话说'), false);
  assert.equal(engine.noteSelfMessage(GROUP_CHAT, '有话说'), true);
  const mine = selfEntries(engine);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].at, T0);
  assert.equal(mine[0].userId, '');
});

// ---------------------------------------------------------------- onSelfMessage（2026-11-18）
//
// 短追问的计时基准 = max(用户最后一条入站, **她最后一条出站**) ⇒ 「她刚说了话」这件事
// 只有发送成功之后才知道，由 `#sendOne` 转告。这里钉住那个口子。

test('★ 出站成功 ⇒ `onSelfMessage` 每段报一次（chatId + 发出去的时刻）', async () => {
  const h = harness({ reply: '第一句 ⟨cut⟩ 第二句' });
  const seen = [];
  h.gateway.onSelfMessage = (payload) => {
    seen.push(payload);
    return true;
  };
  await runTurn(h.gateway);
  assert.deepEqual(seen, [
    { chatId: GROUP_CHAT, at: T0 },
    { chatId: GROUP_CHAT, at: T0 },
  ]);

  // 私聊同样报（会话算不算数是调用方的事，网关不判）
  const dm = harness({ reply: '收到' });
  const dmSeen = [];
  dm.gateway.onSelfMessage = (payload) => { dmSeen.push(payload); return true; };
  await runTurn(dm.gateway, { chatId: PRIVATE_CHAT, sessionKey: PRIVATE_KEY, kind: 'private' });
  assert.deepEqual(dmSeen, [{ chatId: PRIVATE_CHAT, at: T0 }]);
});

test('★ 没发出去就不报：发送失败 / `[不说话]` / 同文短窗拦下', async () => {
  const fail = harness({ reply: '发不出去', failSend: true });
  const failSeen = [];
  fail.gateway.onSelfMessage = (payload) => { failSeen.push(payload); return true; };
  await assert.rejects(runTurn(fail.gateway), /发送失败/u);
  assert.equal(failSeen.length, 0);

  const quiet = harness({ reply: '[不说话]' });
  const quietSeen = [];
  quiet.gateway.onSelfMessage = (payload) => { quietSeen.push(payload); return true; };
  await runTurn(quiet.gateway);
  assert.equal(quietSeen.length, 0);

  const dup = harness({ reply: '一模一样的话' });
  const dupSeen = [];
  dup.gateway.onSelfMessage = (payload) => { dupSeen.push(payload); return true; };
  await runTurn(dup.gateway);
  await runTurn(dup.gateway); // 第二遍被同文短窗拦下
  assert.equal(dupSeen.length, 1);
});

test('★ 回调体抛异常也不能冒到发送链上（那条消息已经发出去了）', async () => {
  const h = harness({ reply: '照常发出' });
  h.gateway.onSelfMessage = () => { throw new Error('锚点炸了'); };
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 1, '发送不受影响');
  assert.equal(selfEntries(h.engine).length, 1);
});
