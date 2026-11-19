/**
 * **逐段外发**（2026-11-04）。
 *
 * ## 为什么必须有这一组用例
 *
 * 用户原话：「不要走拼接，因为时间段可能相差很多，每次都输出一次」。
 * 她习惯"边干边说"：一轮里分好几步写正文、中间夹工具调用，前后能差几十分钟。
 * 改造前 `binding.mjs` 的 `lastAssistantText()` 倒序只取**最后一条**非空助手文本
 * ⇒ 前面说的全丢（2026-11-02 20:15 那一轮丢了 4 段，20:43 那轮丢了整轮）。
 *
 * 这里钉住四件事（任何一条坏掉，用户那边看到的就是"又丢话了"）：
 *
 * 1. **多步 = 多条消息**，几条就发几条，顺序不能乱；
 * 2. **同一个 step 只发一次** —— 轮询会反复看到同一条已落盘的消息；
 * 3. 整轮只有 `[不说话]` ⇒ 一条都不发（标记本身永远不出门）；
 * 4. 某一段发失败 ⇒ 留痕（台账 `ok:false`），**后面的段照常发**。
 *
 * 另外钉住"段内切条"：`⟨cut⟩` 仍然在**那一段之内**切，不许跨段。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { SessionBinder, takeNewAssistantSegments } from '../src/dsh/binding.mjs';
import { Gateway, OUTCOME } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { createOutboundAllow } from '../src/dsh/outbound-allow.mjs';
import { createAutoRelay } from '../src/dsh/auto-relay.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';
import { createOutboundLedger } from '../src/dsh/outbound-ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);
const RELAY_ALLOW = createOutboundAllow({ allowFrom: ['10000001'], groupAllowFrom: [] });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith('.tmp-segment-')) fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
    }
  } catch {
    /* 收尾失败不影响结果 */
  }
});

// ============================================================ 纯函数：切段

test('takeNewAssistantSegments：三条消息各一段 ⇒ 按顺序三条', () => {
  const messages = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '问题' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '第一段' }] },
    { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '第二段' }] },
    { id: 'a3', role: 'assistant', content: [{ type: 'text', text: '第三段' }] },
  ];
  const got = takeNewAssistantSegments(messages, { anchorId: 'u1' });
  assert.deepEqual(got.map((s) => s.text), ['第一段', '第二段', '第三段']);
  assert.deepEqual(got.map((s) => s.key), ['a1', 'a2', 'a3']);
});

test('takeNewAssistantSegments：同一份快照扫两次，第二次一条都不给（seen 去重）', () => {
  const messages = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '问题' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '只此一段' }] },
  ];
  const seen = new Set();
  const first = takeNewAssistantSegments(messages, { anchorId: 'u1', seen });
  for (const seg of first) seen.add(seg.key);
  assert.equal(first.length, 1);
  assert.deepEqual(takeNewAssistantSegments(messages, { anchorId: 'u1', seen }), []);
});

test('takeNewAssistantSegments：本轮开始前就有的助手消息不重发（preIds）', () => {
  const messages = [
    { id: 'old', role: 'assistant', content: [{ type: 'text', text: '上一轮的话' }] },
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '问题' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '本轮的话' }] },
  ];
  // 锚点还在 ⇒ 索引切片就挡住了旧话
  assert.deepEqual(
    takeNewAssistantSegments(messages, { anchorId: 'u1' }).map((s) => s.text),
    ['本轮的话'],
  );
  // 锚点被压缩吃掉 ⇒ 退回 preIds 挡
  assert.deepEqual(
    takeNewAssistantSegments(messages, { anchorId: 'gone', preIds: new Set(['old']) }).map((s) => s.text),
    ['本轮的话'],
  );
});

test('takeNewAssistantSegments：没正文的助手消息（只调工具）不占一段', () => {
  const messages = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '问题' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', name: 'read' }] },
    { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '说一句' }] },
  ];
  assert.deepEqual(takeNewAssistantSegments(messages, { anchorId: 'u1' }).map((s) => s.text), ['说一句']);
});

// ============================================================ 绑定层：轮询

/**
 * 造一个假 agent + binder。
 *
 * `onIdle` 拿到 `{ messages, push }` 自己控制"这一轮里什么时候多出一条助手消息"，
 * 用它模拟"分几步写正文、中间隔一会儿"。
 *
 * `turn`（2026-11-16）：给这个假会话一个轮号 —— `followup` 时补一条 `turn/start`、
 * 每 `push` 一段补一条 `assistant/message`，让"逐段泵认出本轮轮号"这条路真的能跑。
 */
function makeBinder({ onIdle, turn = 1 }) {
  const messages = [];
  const events = [];
  const push = (text, id) => {
    messages.push({ id, role: 'assistant', content: [{ type: 'text', text }] });
    events.push({
      type: 'assistant/message',
      data: { turn, step: messages.length, message: { id, role: 'assistant', content: [{ type: 'text', text }] } },
    });
  };
  const agent = {
    session: {
      deriveMessages: () => messages.map((m) => ({ ...m })),
      snapshotEvents: () => events.slice(),
    },
    followup(payload) {
      messages.push({ id: payload.id, role: 'user', content: payload.content });
      events.push({ type: 'turn/start', data: { turn } });
    },
    async whenIdle() {
      await onIdle({ messages, push, events });
    },
  };
  const ctx = {
    agents: {
      async create() {
        return { agent, async dispose() {} };
      },
      async resume() {
        return { agent, async dispose() {} };
      },
    },
  };
  return { binder: new SessionBinder({ ctx }), messages, events };
}

test('逐段外发：一轮三个 step 各一段 ⇒ 发三次，顺序对', async () => {
  const { binder } = makeBinder({
    onIdle: async ({ push }) => {
      push('第一段', 'a1');
      await delay(120);
      push('第二段', 'a2');
      await delay(120);
      push('第三段', 'a3');
    },
  });
  const sent = [];
  const reply = await binder.runTurn({
    sessionKey: 'qq-private-10001',
    prompt: '干活',
    onSegment: async (text, step) => {
      sent.push({ text, step });
    },
  });
  assert.deepEqual(sent.map((s) => s.text), ['第一段', '第二段', '第三段']);
  assert.deepEqual(sent.map((s) => s.step), [1, 2, 3]);
  assert.equal(reply, '第三段', '轮末返回值仍是最后一段（网关靠它判 [不说话]/空回复）');
});

test('逐段外发：同一个 step 被轮询看到多次 ⇒ 只发一次', async () => {
  const { binder } = makeBinder({
    onIdle: async ({ push }) => {
      push('只此一段', 'a1');
      // 比轮询间隔长得多：会被扫到好几次，内容一个字都没变。
      await delay(700);
    },
  });
  const sent = [];
  await binder.runTurn({
    sessionKey: 'qq-private-10002',
    prompt: '干活',
    onSegment: async (text, step) => {
      sent.push({ text, step });
    },
  });
  assert.deepEqual(sent.map((s) => s.text), ['只此一段']);
});

test('逐段外发：不给 onSegment 时行为不变（只返回最后一段）', async () => {
  const { binder } = makeBinder({
    onIdle: async ({ push }) => {
      push('第一段', 'a1');
      push('第二段', 'a2');
    },
  });
  const reply = await binder.runTurn({ sessionKey: 'qq-private-10003', prompt: '干活' });
  assert.equal(reply, '第二段');
});

// ============================================================ 轮归属（2026-11-16）

test('轮归属：多段轮在**第一段落盘之前**就认出自己的轮号，并且只报一次', async () => {
  // 这就是"归谁发"从按会话改成按轮的那一步：认得出轮号，网关才能在**同一个 turn**
  // 上让路（而不是为整个会话让路）。认晚一点没关系，但必须在 `turn/end` 之前 ——
  // 逐段泵每 200ms 扫一次，模型一轮跑几秒，所以第一段就报是稳的。
  const { binder } = makeBinder({
    turn: 2747,
    onIdle: async ({ push }) => {
      push('第一段', 'a1');
      await delay(120);
      push('第二段', 'a2');
      await delay(120);
      push('第三段', 'a3');
    },
  });
  const turns = [];
  const sent = [];
  await binder.runTurn({
    sessionKey: 'qq-private-10004',
    prompt: '干活',
    onTurn: (turn) => turns.push(turn),
    onSegment: async (text, step) => {
      sent.push({ text, step });
    },
  });
  assert.deepEqual(turns, [2747], '只报一次，且报的是自己这一轮的轮号');
  assert.deepEqual(sent.map((s) => s.text), ['第一段', '第二段', '第三段']);
});

test('轮归属：提示词还排在队里（宿主自己正跑别人的轮次）⇒ **不登记**', async () => {
  // 2026-11-16 turn 2746 的形状：插件这一轮的提示词还没被收下，此时"开着的轮"是
  // **宿主的** turn 2746。把那个号认成自己的 ⇒ 自动搬运会为别人的轮次让路 ⇒ 静默丢话。
  const messages = [];
  const events = [{ type: 'turn/start', data: { turn: 2746 } }];
  const inbox = [];
  const agent = {
    session: {
      deriveMessages: () => messages.map((m) => ({ ...m })),
      snapshotEvents: () => events.slice(),
    },
    followup(payload) {
      inbox.push(payload); // 排在队里，还没进 surface
    },
    async whenIdle() {
      await delay(150); // 泵扫了几次：此刻开着的 turn 是 2746，但我的提示词还没被收下
      // 2746 跑完了（宿主自己的一轮），我的提示词这才被收下 ⇒ 我的轮次是 2747。
      events.push({ type: 'turn/end', data: { turn: 2746, reason: { kind: 'completed' } } });
      messages.push({ id: inbox[0].id, role: 'user', content: inbox[0].content });
      events.push({ type: 'turn/start', data: { turn: 2747 } });
      await delay(400);
      messages.push({ id: 'a1', role: 'assistant', content: [{ type: 'text', text: '我的第一段' }] });
      events.push({
        type: 'assistant/message',
        data: { turn: 2747, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '我的第一段' }] } },
      });
    },
  };
  const ctx = { agents: { async create() { return { agent, async dispose() {} }; }, async resume() { return { agent, async dispose() {} }; } } };
  const binder = new SessionBinder({ ctx });
  const turns = [];
  const sent = [];
  await binder.runTurn({
    sessionKey: 'qq-private-10005',
    prompt: '干活',
    onTurn: (turn) => turns.push(turn),
    onSegment: async (text) => {
      sent.push(text);
    },
  });
  assert.deepEqual(turns, [2747], '只认自己被收下之后的那一轮，绝不认排队时开着的 2746');
  assert.deepEqual(sent, ['我的第一段']);
});

// ============================================================ 网关：发送

/** 假传输层：按顺序记下发了什么，可以指定"第几次抛"。 */
function makeTransport({ failAt = -1 } = {}) {
  const emitter = new EventEmitter();
  const sent = [];
  let calls = 0;
  return {
    selfId: '999',
    sent,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async sendToChat(chatId, message) {
      calls += 1;
      if (calls === failAt) throw new Error('发送失败（用例构造）');
      sent.push({ chatId, message });
      return sent.length;
    },
  };
}

/** 装一套最小网关：真 router/engine，假 transport/responder。 */
function harness({ responder, transport = makeTransport(), gateway: extra = {} } = {}) {
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.OPEN,
    requireMention: true,
    adminUsers: ['9001'],
  });
  const logs = [];
  const engine = new ProactiveEngine({
    config: { enabled: false, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0 },
    gauge: async () => ({ speak: true, text: '' }),
    speak: async () => undefined,
    log: () => {},
    now: () => T0,
  });
  const gateway = new Gateway({
    transport,
    router,
    engine,
    outboundAllow: RELAY_ALLOW,
    responder,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    maxReplyChars: 2000,
    splitGapMs: 0,
    ...extra,
  });
  gateway.attach();
  return { gateway, transport, logs };
}

/** 一条私聊消息事件（白名单里那个用户）。 */
function dmEvent(overrides = {}) {
  return {
    time: Math.floor(T0 / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 1,
    user_id: 10000001,
    message: [{ type: 'text', text: '在吗' }],
    raw_message: '在吗',
    sender: { nickname: '阿猫' },
    ...overrides,
  };
}

test('端到端：多段轮每条只出现一次（网关 → 绑定 → 自动搬运真的接上）', async () => {
  // 这一条钉的是**接线**，不是单点：网关把 `onTurn` 交给 `asResponder()`、绑定层的逐段泵
  // 认出轮号再回写给网关 —— 漏任何一环，自动搬运在 `turn/end` 都会把整串再搬一遍，
  // 而整串 ≠ 单段，`#sendOne` 的「同文短窗」拦不住（这正是 2026-11-16 那个 bug 的孪生风险）。
  const TURN = 2747;
  const KEY = 'qq-private-10000001';
  const messages = [];
  const events = [];
  const delays = () => new Promise((r) => setTimeout(r, 350));
  const agent = {
    session: {
      deriveMessages: () => messages.map((m) => ({ ...m })),
      snapshotEvents: () => events.slice(),
    },
    followup(payload) {
      messages.push({ id: payload.id, role: 'user', content: payload.content });
      events.push({ type: 'turn/start', data: { turn: TURN } });
    },
    async whenIdle() {
      const say = (text, id) => {
        messages.push({ id, role: 'assistant', content: [{ type: 'text', text }] });
        events.push({
          type: 'assistant/message',
          data: { turn: TURN, step: messages.length, message: { id, role: 'assistant', content: [{ type: 'text', text }] } },
        });
      };
      say('第一段', 'a1');
      await delays();
      owners.push(gateway.turnOwnerOf(KEY));
      say('第二段', 'a2');
      await delays();
      say('第三段', 'a3');
      await delays();
      // 轮末：宿主在这里同步发 `turn/end`（所以自动搬运看到的牌子必须**在这一刻就有效**）
      events.push({ type: 'turn/end', data: { turn: TURN, reason: { kind: 'completed' } } });
      relayResults.push(await relay.observe({ id: KEY, snapshotEvents: () => events.slice() }, { type: 'turn/end', data: { turn: TURN } }));
    },
  };
  const ctx = {
    agents: {
      async create() {
        return { agent, async dispose() {} };
      },
      async resume() {
        return { agent, async dispose() {} };
      },
    },
  };
  const binder = new SessionBinder({ ctx });
  const owners = [];
  const relayResults = [];
  let relay = null;
  let gateway = null;
  const h = harness({ responder: binder.asResponder() });
  gateway = h.gateway;
  relay = createAutoRelay({ gateway });

  const result = await gateway.handleEvent(dmEvent());

  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.deepEqual(owners, [TURN], '泵在第一段之后就认出轮号，并登记到网关（`asResponder` 没漏转发 onTurn）');
  assert.deepEqual(relayResults, ['in-flight'], '`turn/end` 时自动搬运必须让路');
  assert.deepEqual(
    h.transport.sent.map((s) => s.message),
    ['第一段', '第二段', '第三段'],
    '三段各一条：既没少发，也没有"整串"那第四条',
  );
});

test('网关：一轮三段 ⇒ QQ 上三条、顺序对、轮末不重复发', async () => {
  const h = harness({
    responder: async (request) => {
      await request.onSegment('第一段', 1);
      await request.onSegment('第二段', 2);
      await request.onSegment('第三段', 3);
      return '第三段';
    },
  });
  const result = await h.gateway.handleEvent(dmEvent());
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.deepEqual(h.transport.sent.map((s) => s.message), ['第一段', '第二段', '第三段']);
  assert.equal(h.gateway.stats.segments, 3);
  assert.equal(h.gateway.stats.failedSegments, 0);
});

test('网关：整轮只有 [不说话] ⇒ 一条都不发', async () => {
  const h = harness({
    responder: async (request) => {
      await request.onSegment('[不说话]', 1);
      return '[不说话]';
    },
  });
  await h.gateway.handleEvent(dmEvent());
  assert.deepEqual(h.transport.sent, []);
  assert.equal(h.gateway.stats.segments, 0);
  assert.equal(h.gateway.stats.quietReplies, 1, '[不说话] 的计数口径不变');
});

test('网关：前面说了正文、最后一段是 [不说话] ⇒ 正文照发、标记不发', async () => {
  const h = harness({
    responder: async (request) => {
      await request.onSegment('正文一句', 1);
      await request.onSegment('[不说话]', 2);
      return '[不说话]';
    },
  });
  await h.gateway.handleEvent(dmEvent());
  assert.deepEqual(h.transport.sent.map((s) => s.message), ['正文一句']);
});

test('网关：某一段发送失败 ⇒ 台账 ok:false，后面的段照常发', async () => {
  const dir = fs.mkdtempSync(path.join(HERE, '.tmp-segment-ledger-'));
  const ledger = createOutboundLedger({ config: { file: path.join(dir, 'out.log'), maxLines: 200 } });
  const transport = makeTransport({ failAt: 1 });
  const h = harness({
    transport,
    gateway: { outboundLedger: ledger },
    responder: async (request) => {
      await request.onSegment('第一段', 1);
      await request.onSegment('第二段', 2);
      await request.onSegment('第三段', 3);
      return '第三段';
    },
  });
  await h.gateway.handleEvent(dmEvent());
  // 第一段抛了，后两段照发
  assert.deepEqual(transport.sent.map((s) => s.message), ['第二段', '第三段']);
  assert.equal(h.gateway.stats.failedSegments, 1);
  // 台账里必须有一行失败（`transport-action` 的 ok:false），不能静默
  const entries = ledger.read();
  const failed = entries.filter((e) => e.ok === false);
  assert.equal(failed.length, 1, '失败那一段必须在台账里留痕');
  assert.match(h.logs.map((l) => l.message).join('\n'), /发送失败（后续段照常发）/);
});

test('网关：⟨cut⟩ 在某一 step 内 ⇒ 仍然在该段内切条（不跨段）', async () => {
  const h = harness({
    responder: async (request) => {
      await request.onSegment('上半句⟨cut⟩下半句', 1);
      await request.onSegment('第二段', 2);
      return '第二段';
    },
  });
  await h.gateway.handleEvent(dmEvent());
  assert.deepEqual(h.transport.sent.map((s) => s.message), ['上半句', '下半句', '第二段']);
  assert.equal(h.gateway.stats.segments, 2, '一段内的切条不算两段（`stats.segments` 数的是 step）');
});

test('网关：静默轮（silent）逐段也不发 —— 与改动前一致', async () => {
  let request0 = null;
  const h = harness({
    responder: async (request) => {
      request0 = request;
      await request.onSegment('自言自语', 1);
      return '自言自语';
    },
  });
  await h.gateway.runTurn({
    message: {
      chatId: 'private:10000001',
      kind: 'dm',
      segments: [{ type: 'text', text: 'x' }],
    },
    sessionKey: 'qq-private-10000001',
    prompt: '内部通道',
    silent: true,
  });
  assert.deepEqual(h.transport.sent, []);
  assert.equal(h.gateway.stats.segments, 0);
  assert.ok(request0 !== null, 'responder 确实被调过（否则这条用例证明不了静默）');
});
