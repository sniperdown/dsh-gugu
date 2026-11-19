/**
 * 自动搬运（`src/dsh/auto-relay.mjs`）的判据测试（2026-11-02）。
 *
 * 这一层只回答**一个问题**：`turn/end` 之后，这一轮说的话**该不该**走到 QQ。
 * 所以网关整个换成替身，只留下三个被问到的口子：
 * `chatOf`（有没有 QQ 出口）、`isTurnInFlight`（这一轮是不是插件自己驱动的）、
 * `sendTurnReply`（真发）。发送本身另有一个用**真网关**的用例钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { createAutoRelay, turnHasTextToolCall, TEXT_SEND_TOOL_NAMES } from '../src/dsh/auto-relay.mjs';

/** 造一条 `assistant/message` 事件（形状照真实会话日志）。 */
function assistantEvent(turn, ...texts) {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step: 1,
      message: {
        role: 'assistant',
        content: texts.map((text) => ({ type: 'text', text })),
      },
    },
  };
}

/** 造一条 `tool/call` 事件。 */
function toolCallEvent(turn, name) {
  return { type: 'tool/call', data: { turn, step: 1, callId: `c-${name}`, name, arguments: '{}' } };
}

/** 造一条 `turn/end` 事件。 */
function turnEnd(turn, kind = 'completed') {
  return { type: 'turn/end', data: { turn, reason: { kind } } };
}

/** 会话替身：只实现 `snapshotEvents`。 */
function makeSession(id, events) {
  return { id, snapshotEvents: () => events };
}

/**
 * 网关替身。
 *
 * `chats` 是"认识的会话键 → chatId"（不在里面 = 不是 QQ 会话）；
 * `inFlight` 是"这一轮由 `runTurn` 驱动"的会话键集合。
 */
function makeGateway({ chats = {}, inFlight = [], sendOk = true, throwOnSend = false } = {}) {
  const sent = [];
  const inFlightSet = new Set(inFlight);
  return {
    sent,
    inFlightSet,
    chatOf: (sessionKey) => {
      const chatId = chats[String(sessionKey)];
      return chatId === undefined ? null : { chatId, kind: 'private', target: '1' };
    },
    isTurnInFlight: (sessionKey) => inFlightSet.has(String(sessionKey)),
    async sendTurnReply(sessionKey, text) {
      if (throwOnSend) throw new Error('假网关炸了');
      if (sendOk !== true) return false;
      sent.push({ sessionKey, text });
      return true;
    },
  };
}

const QQ = 'session-abc';
const CHATS = { [QQ]: 'private:30000001' };

// ---------------------------------------------------------------- 该发的情况

test('自动搬运：非 QQ 触发的轮（子会话交活）正文会发出去', async () => {
  const gateway = makeGateway({ chats: CHATS });
  const relay = createAutoRelay({ gateway });
  const session = makeSession(QQ, [assistantEvent(3, '子会话干完了，报告如下。')]);

  const result = await relay.observe(session, turnEnd(3));

  assert.equal(result, 'sent');
  assert.deepEqual(gateway.sent, [{ sessionKey: QQ, text: '子会话干完了，报告如下。' }]);
  assert.equal(relay.stats().sent, 1);
});

test('自动搬运：一长轮多步时取**最后**一段正文，不取中间过程台词', async () => {
  const gateway = makeGateway({ chats: CHATS });
  const relay = createAutoRelay({ gateway });
  const session = makeSession(QQ, [
    assistantEvent(1, '我先摸摸现状。'),
    assistantEvent(1, '改好了，测试全绿。'),
  ]);

  await relay.observe(session, turnEnd(1));

  assert.deepEqual(gateway.sent, [{ sessionKey: QQ, text: '改好了，测试全绿。' }]);
});

test('自动搬运：后台作业 / schedule 到点的轮次同样走这一条路', async () => {
  const gateway = makeGateway({ chats: CHATS });
  const relay = createAutoRelay({ gateway });
  const session = makeSession(QQ, [assistantEvent(9, '跑完了，日志在 shared/tmp/run.log。')]);

  assert.equal(await relay.observe(session, turnEnd(9)), 'sent');
  assert.equal(gateway.sent.length, 1);
});

// ---------------------------------------------------------------- 不该发的情况

test('自动搬运：正文是 [不说话] ⇒ 一个字都不发', async () => {
  const gateway = makeGateway({ chats: CHATS });
  const relay = createAutoRelay({ gateway });
  const session = makeSession(QQ, [assistantEvent(4, '[不说话]')]);

  const result = await relay.observe(session, turnEnd(4));

  assert.equal(result, 'quiet');
  assert.equal(gateway.sent.length, 0);
  assert.equal(relay.stats().skippedQuiet, 1);
});

test('自动搬运：这一轮已经用 send_qq 发过文字 ⇒ 正文不重复发', async () => {
  const gateway = makeGateway({ chats: CHATS });
  const relay = createAutoRelay({ gateway });
  const session = makeSession(QQ, [
    toolCallEvent(5, 'send_qq'),
    assistantEvent(5, '同一段话，别再发一遍。'),
  ]);

  const result = await relay.observe(session, turnEnd(5));

  assert.equal(result, 'tool-sent');
  assert.equal(gateway.sent.length, 0);
  assert.equal(relay.stats().skippedToolSent, 1);
});

test('自动搬运：别的轮次调过 send_qq 不算，这一轮照样发', async () => {
  const gateway = makeGateway({ chats: CHATS });
  const relay = createAutoRelay({ gateway });
  const session = makeSession(QQ, [
    toolCallEvent(1, 'send_qq'),
    assistantEvent(1, '上一轮发的。'),
    assistantEvent(2, '这一轮是新的。'),
  ]);

  assert.equal(await relay.observe(session, turnEnd(2)), 'sent');
  assert.deepEqual(gateway.sent, [{ sessionKey: QQ, text: '这一轮是新的。' }]);
});

test('自动搬运：**定时唤醒那类轮次仍然不发**（runTurn 在飞 ⇒ 让路，防刷屏回归）', async () => {
  // 反例：这就是「她自己的时间」的形状 —— `deliverFromAlice({replyTo:null})` ⇒
  // `runTurn({silent:true})`，她说的话**由 runTurn 那条路自己发**（free-time.mjs:694），
  // 这里要是再搬一次，用户手机上就多一条；而"只观察不说话"的轮次里她随口的自言自语
  // 更会被直接推出去。所以 in-flight 时拒绝一切搬运。
  const gateway = makeGateway({ chats: CHATS, inFlight: [QQ] });
  const relay = createAutoRelay({ gateway });
  const session = makeSession(QQ, [assistantEvent(6, '（自言自语：这块代码有点意思）')]);

  const result = await relay.observe(session, turnEnd(6));

  assert.equal(result, 'in-flight');
  assert.equal(gateway.sent.length, 0);
  assert.equal(relay.stats().skippedInFlight, 1);
});

test('自动搬运：不是 QQ 会话（认不出 chatId）⇒ 不发', async () => {
  const gateway = makeGateway({ chats: {} });
  const relay = createAutoRelay({ gateway });
  const session = makeSession('session-alice', [assistantEvent(7, '给主会话的技术说明。')]);

  assert.equal(await relay.observe(session, turnEnd(7)), 'no-chat');
  assert.equal(gateway.sent.length, 0);
});

test('自动搬运：这一轮只有图 / 没有正文 ⇒ 不发（图由别的路走）', async () => {
  const gateway = makeGateway({ chats: CHATS });
  const relay = createAutoRelay({ gateway });
  const session = makeSession(QQ, [assistantEvent(8)]);

  assert.equal(await relay.observe(session, turnEnd(8)), 'empty');
  assert.equal(gateway.sent.length, 0);
});

test('自动搬运：只管 turn/end，其他事件一律不动作', async () => {
  const gateway = makeGateway({ chats: CHATS });
  const relay = createAutoRelay({ gateway });
  const session = makeSession(QQ, [assistantEvent(1, '随便')]);

  assert.equal(await relay.observe(session, { type: 'turn/start', data: { turn: 1 } }), null);
  assert.equal(await relay.observe(session, null), null);
  assert.equal(gateway.sent.length, 0);
});

test('自动搬运：宿主没给 snapshotEvents() ⇒ 明说 no-events，不冒充"空轮"', async () => {
  const logs = [];
  const gateway = makeGateway({ chats: CHATS });
  const relay = createAutoRelay({ gateway, log: (level, message) => logs.push({ level, message }) });
  const session = { id: QQ }; // 没有 snapshotEvents

  const result = await relay.observe(session, turnEnd(2));

  assert.equal(result, 'no-events');
  assert.equal(gateway.sent.length, 0);
  assert.equal(logs[0].level, 'warn');
  assert.equal(relay.stats().skippedNoEvents, 1);
});

test('自动搬运：网关拒发（白名单 / 同文窗）⇒ 记失败但绝不抛', async () => {
  const gateway = makeGateway({ chats: CHATS, sendOk: false });
  const relay = createAutoRelay({ gateway });
  const session = makeSession(QQ, [assistantEvent(2, '这段没发出去。')]);

  assert.equal(await relay.observe(session, turnEnd(2)), 'send-failed');
  assert.equal(relay.stats().failed, 1);
});

test('自动搬运：网关抛异常 ⇒ 吞掉并记一条日志（绝不把异常丢回宿主事件循环）', async () => {
  const logs = [];
  const gateway = makeGateway({ chats: CHATS, throwOnSend: true });
  const relay = createAutoRelay({ gateway, log: (level, message) => logs.push({ level, message }) });
  const session = makeSession(QQ, [assistantEvent(2, '炸一下试试。')]);

  assert.equal(await relay.observe(session, turnEnd(2)), 'error');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
});

test('turnHasTextToolCall：只认指定轮次、指定工具', () => {
  const events = [toolCallEvent(3, 'send_qq'), toolCallEvent(4, 'read')];
  assert.equal(turnHasTextToolCall(events, 3), true);
  assert.equal(turnHasTextToolCall(events, 4), false);
  assert.equal(turnHasTextToolCall(events, 3, []), false);
  assert.equal(turnHasTextToolCall(null, 3), false);
  assert.deepEqual(TEXT_SEND_TOOL_NAMES, ['send_qq']);
});

// ---------------------------------------------------------------- 真网关：发送那一步

/** 最小传输层：只记发了什么。 */
function makeTransport() {
  const sent = [];
  return {
    sent,
    async sendToChat(chatId, message) {
      sent.push({ chatId, message });
      return sent.length;
    },
  };
}

test('sendTurnReply：名单内的会话真的发到那个 chatId，名单外一个字都不发', async () => {
  const transport = makeTransport();
  const router = new Router({
    // `allowlist` = 只认 `allowFrom` 里的人 —— 这就是**出站白名单**的形状：
    // `proactiveAllowed('private:2002')` 因此为假，名单外一个字都发不出去。
    dmPolicy: POLICY.ALLOWLIST,
    groupPolicy: POLICY.ALLOWLIST,
    requireMention: true,
    allowFrom: ['30000001'],
    groupAllowFrom: [],
  });
  const notes = [];
  const engine = { noteReplied: (...args) => notes.push(args), now: () => 1 };
  const gateway = new Gateway({
    transport,
    router,
    engine,
    responder: async () => '',
    log: () => {},
  });

  // ① 名单内：`qq-private-30000001` 能反过来解析出 chatId。
  const ok = await gateway.sendTurnReply('qq-private-30000001', '补发的正文');
  assert.equal(ok, true);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].chatId, 'private:30000001');
  assert.equal(transport.sent[0].message, '补发的正文');
  assert.equal(gateway.stats.replies, 1);
  assert.equal(notes.length, 1);

  // ② 名单外：认得出会话键，但不在白名单 ⇒ false，且不发。
  const denied = await gateway.sendTurnReply('qq-private-2002', '越界的正文');
  assert.equal(denied, false);
  assert.equal(transport.sent.length, 1);

  // ③ 认不出的键 / 空正文 ⇒ false。
  assert.equal(await gateway.sendTurnReply('session-nobody', '谁也不是'), false);
  assert.equal(await gateway.sendTurnReply('qq-private-30000001', '   '), false);
});

// ------------------------------------------------- 「归谁发」按轮判（2026-11-16）

/**
 * 真网关（出站白名单放行 `30000001`，传输层只记不发）。
 *
 * 这一组必须用真网关：钉的是 `isTurnInFlight(key, turn)` 与 `turnHandedToPump` 的
 * **真实语义**，替身替不出来（替身只认第一个参数，那正是要改掉的口径）。
 */
function makeLiveGateway() {
  const transport = makeTransport();
  const router = new Router({
    dmPolicy: POLICY.ALLOWLIST,
    groupPolicy: POLICY.ALLOWLIST,
    requireMention: true,
    allowFrom: ['30000001'],
    groupAllowFrom: [],
  });
  const engine = { noteReplied: () => {}, now: () => 1 };
  const gateway = new Gateway({ transport, router, engine, responder: async () => '', log: () => {} });
  return { gateway, transport };
}

const LIVE_KEY = 'qq-private-30000001';

/** 带消息 id 的助手事件（真会话里每条助手消息都有 id；按 id 判"归谁发"要用它）。 */
function assistantEventWithId(turn, id, text) {
  return {
    type: 'assistant/message',
    data: { turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

test('按轮判：会话在飞但**还没认出自己的轮号**（提示词排在队里）⇒ 宿主自己那轮照发', async () => {
  // 2026-11-16 turn 2746 的原始形状：「她自己的时间」先占住会话、提示词还在队里，
  // 牌子举了 75 秒；同期宿主自己跑的 `subagent-settled` 轮（2746）结束。
  // 旧口径只看会话 ⇒ 让路 ⇒ 683 字两边都不认领。现在只认"我登记过的那一轮"。
  const { gateway, transport } = makeLiveGateway();
  gateway.turnsInFlight.add(LIVE_KEY); // 插件这一轮确实在跑，但还没轮到它
  const relay = createAutoRelay({ gateway });
  const session = makeSession(LIVE_KEY, [assistantEvent(2746, '子会话交活的结论：改好了。')]);

  const result = await relay.observe(session, turnEnd(2746));

  assert.equal(result, 'sent');
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].message, '子会话交活的结论：改好了。');
});

test('按轮判：登记的是**别的** turn ⇒ 不挡（A 轮的牌子不让 B 轮让路）', async () => {
  const { gateway, transport } = makeLiveGateway();
  gateway.turnsInFlight.add(LIVE_KEY);
  gateway.noteTurnOwner(LIVE_KEY, 2747); // 插件这一轮是 2747
  const relay = createAutoRelay({ gateway });
  const session = makeSession(LIVE_KEY, [assistantEvent(2746, '2746 说的这句必须出去。')]);

  assert.equal(await relay.observe(session, turnEnd(2746)), 'sent');
  assert.equal(transport.sent.length, 1);
});

test('按轮判：登记的就是**这一轮** ⇒ 让路（free-time / 内部通道的牌子仍然一律让路）', async () => {
  // 定时唤醒那轮由 `runTurn` 自己按 `silent` / `quietWhenNothing` 决定发不发；
  // 自动搬运再搬一遍 = 手机上多一条（或把"只观察不说话"的自言自语推出去）。
  const { gateway, transport } = makeLiveGateway();
  gateway.turnsInFlight.add(LIVE_KEY);
  gateway.noteTurnOwner(LIVE_KEY, 2747);
  const relay = createAutoRelay({ gateway });
  const session = makeSession(LIVE_KEY, [assistantEvent(2747, '（自言自语：这块代码有点意思）')]);

  const result = await relay.observe(session, turnEnd(2747));

  assert.equal(result, 'in-flight');
  assert.equal(transport.sent.length, 0);
  assert.equal(relay.stats().skippedInFlight, 1);
});

test('按轮判：多段轮**已经被逐段泵接手过** ⇒ 整轮不再搬一遍（防发两遍）', async () => {
  // 泵是逐段发（step1/step2/step3），自动搬运发的是 `said.join('\n')` 整串 ——
  // 整串 ≠ 单段，同文短窗挡不住。所以按**消息 id** 认"这一轮已经归泵了"。
  const { gateway, transport } = makeLiveGateway();
  gateway.turnsInFlight.add(LIVE_KEY);
  gateway.notePumpedMessage(LIVE_KEY, 'a2'); // 泵已经发过第二段
  const relay = createAutoRelay({ gateway });
  const session = makeSession(LIVE_KEY, [
    assistantEventWithId(9, 'a1', '第一段'),
    assistantEventWithId(9, 'a2', '第二段'),
    assistantEventWithId(9, 'a3', '第三段'),
  ]);

  const result = await relay.observe(session, turnEnd(9));

  assert.equal(result, 'pumped');
  assert.equal(transport.sent.length, 0, '整串一个字都不该再发');
  assert.equal(relay.stats().skippedPumped, 1);

  // 反例：同一张表里是**别的轮次**的段 ⇒ 不挡这一轮（id 唯一，不会串轮）。
  const other = makeSession(LIVE_KEY, [
    assistantEventWithId(10, 'b1', '下一轮的正文'),
  ]);
  assert.equal(await relay.observe(other, turnEnd(10)), 'sent');
  assert.equal(transport.sent.length, 1);
});

test('isTurnInFlight：不传 turn = 旧口径，传了 turn 就按轮判；撤登记只撤自己那一轮', () => {
  const { gateway } = makeLiveGateway();
  gateway.turnsInFlight.add(LIVE_KEY);

  // 旧口径（向后兼容：现有调用点 / 老替身只传一个参数）
  assert.equal(gateway.isTurnInFlight(LIVE_KEY), true);
  assert.equal(gateway.isTurnInFlight(LIVE_KEY, 0), true);
  assert.equal(gateway.isTurnInFlight(LIVE_KEY, undefined), true);

  assert.equal(gateway.noteTurnOwner(LIVE_KEY, 2747), true);
  assert.equal(gateway.turnOwnerOf(LIVE_KEY), 2747);
  assert.equal(gateway.isTurnInFlight(LIVE_KEY, 2747), true);
  assert.equal(gateway.isTurnInFlight(LIVE_KEY, 2746), false);

  // 非法轮号不登记（宁可让自动搬运去发，也不能凭空吞话）
  assert.equal(gateway.noteTurnOwner(LIVE_KEY, 0), false);
  assert.equal(gateway.noteTurnOwner(LIVE_KEY, Number.NaN), false);
  assert.equal(gateway.turnOwnerOf(LIVE_KEY), 2747);

  // 撤销：轮号不符 ⇒ 不动（别把下一轮的登记擦掉）
  assert.equal(gateway.clearTurnOwner(LIVE_KEY, 2746), false);
  assert.equal(gateway.turnOwnerOf(LIVE_KEY), 2747);
  assert.equal(gateway.clearTurnOwner(LIVE_KEY), true);
  assert.equal(gateway.turnOwnerOf(LIVE_KEY), 0);
  // 轮号没了 ⇒ 传 turn 的判据不再为真（哪怕会话牌子还在）
  assert.equal(gateway.isTurnInFlight(LIVE_KEY, 2747), false);
});

test('isTurnInFlight：runTurn 在跑的那一轮被标记，跑完就撤', async () => {
  const transport = makeTransport();
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.OPEN,
    requireMention: true,
    allowFrom: ['30000001'],
    groupAllowFrom: [],
  });
  const engine = { noteReplied: () => {}, now: () => 1 };
  const seen = [];
  let gateway = null;
  gateway = new Gateway({
    transport,
    router,
    engine,
    responder: async (request) => {
      // 这一行就是"`turn/end` 发生在 responder 的 await 里"的意思。
      seen.push(gateway.isTurnInFlight('qq-private-30000001'));
      // 绑定层认出本轮轮号后会回调它（2026-11-16）⇒ 网关按轮登记。
      seen.push(typeof request.onTurn === 'function');
      request.onTurn(42);
      seen.push(gateway.isTurnInFlight('qq-private-30000001', 42));
      seen.push(gateway.isTurnInFlight('qq-private-30000001', 41));
      return '';
    },
    log: () => {},
  });

  await gateway.runTurn({
    message: {
      chatId: 'private:30000001',
      kind: 'private',
      userId: '30000001',
      nickname: '用户',
      text: '在吗',
      at: 1,
      mentioned: true,
      segments: [{ type: 'text', text: '在吗' }],
      raw: '在吗',
    },
    sessionKey: 'qq-private-30000001',
    silent: true,
  });

  assert.deepEqual(seen, [true, true, true, false]);
  assert.equal(gateway.isTurnInFlight('qq-private-30000001'), false);
  assert.equal(gateway.turnOwnerOf('qq-private-30000001'), 0, '轮归属随这一轮一起撤掉');
});
