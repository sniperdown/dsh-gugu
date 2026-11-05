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
 */
function makeBinder({ onIdle }) {
  const messages = [];
  const push = (text, id) => {
    messages.push({ id, role: 'assistant', content: [{ type: 'text', text }] });
  };
  const agent = {
    session: { deriveMessages: () => messages.map((m) => ({ ...m })) },
    followup(payload) {
      messages.push({ id: payload.id, role: 'user', content: payload.content });
    },
    async whenIdle() {
      await onIdle({ messages, push });
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
  return { binder: new SessionBinder({ ctx }), messages };
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
