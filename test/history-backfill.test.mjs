/**
 * 「启动时灌历史」的离线测试（2026-10-13）。
 *
 * 这条功能的**红线**是"灌进来的旧消息绝不能被回复"，所以最重的用例不是
 * "灌进去了没有"，而是：
 *
 * 1. 灌的**那条路上没有判定** —— 真装配（`Gateway` + 真 `Router` + 真引擎 +
 *    真 `heuristic-gauge`）灌完 20 条，`stats.dispatched` **一个都不许涨**；
 * 2. 就算 NapCat 又把同一条历史当实时事件补发一次，**照样不判**（`duplicate`）；
 * 3. NapCat 不可用时**静默降级**，不抛、不阻塞。
 *
 * 另外两类容易静默写错的地方也各有用例：
 * - **段形状**（历史接口给的是 `{type, data}` 还是压平的 `{type, text}`）——
 *   写错就是"一群空消息"，而计数一切正常；
 * - **只恢复上下文、不恢复限流**（`lastBotAt` 要、`speaks`/`userMessages` 不要）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ProactiveEngine, ChatState, Transcript } from '../src/proactive/engine.mjs';
import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { judge } from '../src/dsh/heuristic-gauge.mjs';
import {
  backfillChat,
  backfillHistory,
  allowedChatIds,
  startHistoryBackfill,
  runHistoryBackfill,
  createHistoryBackfillController,
  historyMessageText,
  isSelfMessage,
  DEFAULT_COUNT,
} from '../src/dsh/history-backfill.mjs';

const HOUR = 60 * 60 * 1000;
/** 一个"开机时刻"：历史都在这之前。 */
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const OLD = NOW - 8 * HOUR;

/** 一条历史接口形态的群消息。 */
function historyMsg(seq, { text = `第${seq}条`, at = OLD + seq * 60_000, userId = 2001, name = '阿猫', extra = [] } = {}) {
  return {
    message_id: 1000 + seq,
    user_id: userId,
    time: Math.floor(at / 1000),
    message: [{ type: 'text', data: { text } }, ...extra],
    sender: { nickname: name, card: '' },
  };
}

/** 20 条别人的话 + 一条她自己的话（最晚）。顺序**故意从新到旧**（NapCat 给的就是这个序）。 */
function historyWindow({ selfCount = 1, selfText = '我刚说的话' } = {}) {
  const list = [];
  for (let i = 1; i <= 20; i += 1) list.push(historyMsg(i));
  for (let i = 0; i < selfCount; i += 1) {
    list.push({
      message_id: 9000 + i,
      user_id: 999,
      time: Math.floor((OLD + (30 + i) * 60_000) / 1000),
      message: [{ type: 'text', data: { text: selfText } }],
      sender: { nickname: '小鲸鱼', card: '' },
    });
  }
  return list.reverse();
}

// ---------------------------------------------------------------- 段归一化

test('灌历史：段形状两种都吃（HTTP API 的 {type,data} 与压平的 {type,text}）', () => {
  // 这条**必须**走 protocol.mjs 的归一化：NapCat 的 HTTP API 与实时事件的段形状
  // 不一样（`media.mjs` 有实测记录），自己写一个 `data?.text` 就会在另一种形状下
  // 变成一群空消息 —— 而"空消息"不会报错，只是转录里全是空白。
  assert.equal(historyMessageText({ message: [{ type: 'text', data: { text: '在吗' } }] }), '在吗');
  assert.equal(historyMessageText({ message: [{ type: 'text', text: '在吗' }] }), '在吗');
  // CQ 串回退（老实现只给 raw_message）
  assert.equal(historyMessageText({ raw_message: '看这个[CQ:at,qq=999]' }), '看这个@999');
  // 非文本段落成占位符（与实时消息一致）
  assert.equal(historyMessageText({ message: [{ type: 'image' }] }), '[图片]');
  assert.equal(historyMessageText({ message: [] }), '');
});

test('灌历史：自己发的消息认得出来（`user_id` 命中，或段里标了 `post_type:self`）', () => {
  assert.equal(isSelfMessage({ user_id: 999 }, '999'), true);
  assert.equal(isSelfMessage({ user_id: 2001 }, '999'), false);
  assert.equal(isSelfMessage({ user_id: 2001, message: [{ type: 'text', post_type: 'self', text: 'x' }] }, '999'), true);
  // selfId 未知时不能把所有人都当成自己（那会让转录全空）
  assert.equal(isSelfMessage({ user_id: 2001 }, ''), false);
});

// ---------------------------------------------------------------- Transcript.restore

test('转录 restore：接受乱序输入、按时间排好；时间戳缺失的丢掉', () => {
  const t = new Transcript();
  const n = t.restore([
    { at: 300, text: 'c', messageId: 3, nickname: 'A', userId: '1' },
    { at: 100, text: 'a', messageId: 1, nickname: 'A', userId: '1' },
    { at: 200, text: 'b', messageId: 2, nickname: 'A', userId: '1' },
    { at: 0, text: 'x', messageId: 9, nickname: 'A', userId: '1' },
    { text: 'no-time', messageId: 10, nickname: 'A', userId: '1' },
  ]);
  assert.equal(n, 3, '时间戳为 0 / 缺失的必须丢掉');
  assert.deepEqual(t.snapshot().map((m) => m.text), ['a', 'b', 'c']);
});

test('转录 restore：同一条（同 messageId）只留一份，后到的赢', () => {
  const t = new Transcript();
  const n = t.restore([
    { at: 100, text: '旧副本', messageId: 7, nickname: 'A', userId: '1' },
    { at: 100, text: '新副本', messageId: 7, nickname: 'A', userId: '1' },
    { at: 200, text: '别的', messageId: 8, nickname: 'A', userId: '1' },
  ]);
  assert.equal(n, 2);
  assert.deepEqual(t.snapshot().map((m) => m.text), ['新副本', '别的']);
});

test('转录 restore：hardCap 截到"最近 N 条"，且不越过自身 maxMessages', () => {
  const t = new Transcript({ maxMessages: 5 });
  const many = Array.from({ length: 30 }, (_, i) => ({
    at: 1000 + i, text: `m${i}`, messageId: i, nickname: 'A', userId: '1',
  }));
  const n = t.restore(many, { hardCap: 20 });
  // ⚠️ 返回值是"我灌了几条"（**裁剪前**）——那是给日志/快照看的。
  assert.equal(n, 20, '返回值 = 灌进去的条数');
  assert.equal(t.snapshot().length, 5, '硬上界是 maxMessages(5)—— restore 不该成为内存放大的口子');
  assert.deepEqual(t.snapshot().map((m) => m.text), ['m25', 'm26', 'm27', 'm28', 'm29']);
});

// ---------------------------------------------------------------- ChatState.restoreContext

test('上下文恢复：只动"她刚说过话 / 刚问过话"，**不动任何限流字段**', () => {
  const s = new ChatState();
  assert.equal(s.restoreContext(OLD, '要我去通知主会话吗？'), true);
  // ✅ 上下文恢复了
  assert.equal(s.lastBotAt, OLD);
  assert.equal(s.lastBotWasQuestion, true, '她最后一句是问句 —— 这是上下文');
  assert.deepEqual(s.botAt, [OLD]);
  // ❌ 限流一律不恢复（新实例该有自己的限流）
  assert.deepEqual(s.speaks, [], 'speaks 是滚动小时配额，不许被历史灌满');
  assert.equal(s.lastSpeakAt, 0, 'lastSpeakAt 是最小间隔的依据，不许恢复');
  assert.equal(s.userMessages, 0, 'userMessages 是预热门槛，不许恢复');
  assert.equal(s.lastUserAt, undefined, 'lastUserAt 不许被旧消息污染成"刚来过"');
  assert.equal(s.thresholdPassed, false);
  assert.equal(s.gauges, 0);
});

test('上下文恢复：拿不到正文时**不许瞎猜**成问句（保持原值）', () => {
  const s = new ChatState();
  s.restoreContext(OLD, '要我去通知主会话吗？');
  assert.equal(s.lastBotWasQuestion, true);
  // 一条只有图的消息（正文为空）⇒ 无权改写"她最后一条是不是问句"
  s.restoreContext(OLD + 1000, '');
  assert.equal(s.lastBotWasQuestion, true, '不知道内容就别动它');
  assert.equal(s.lastBotAt, OLD + 1000, '但"她说过话"这个时刻还是要更新');
});

test('上下文恢复：非法时刻一律不写（0 / NaN / 负数）', () => {
  const s = new ChatState();
  assert.equal(s.restoreContext(0, 'x'), false);
  assert.equal(s.restoreContext(Number.NaN, 'x'), false);
  assert.equal(s.restoreContext(-1, 'x'), false);
  assert.equal(s.lastBotAt, 0);
});

test('上下文恢复：旧时刻**不会**把她锁进 cooldown-after-bot（流逝时间算法已兜住）', async () => {
  // 这条是"恢复 lastBotAt 会不会误伤"的关键：`#gate` 用的是 `now - lastBotAt`。
  // 灌一个 8 小时前的真实时刻 ⇒ 差值是几小时 ≫ 冷却阈值 ⇒ 天然已过。
  // （灌一个"假的现在"才会真出事：那等于人为制造一整段冷却。）
  const t = Date.now();
  const engine = new ProactiveEngine({
    config: { enabled: true, minIntervalMs: 0, afterUserMsgCount: 0, cooldownAfterBotMs: 20_000 },
    gauge: async () => ({ speak: false }),
    speak: async () => {},
    allowed: () => true,
    now: () => t,
  });
  engine.state('group:1').restoreContext(t - 8 * HOUR, '好久以前说的');
  const verdict = await engine.decide({
    chatId: 'group:1', kind: 'group', userId: '2', nickname: '阿猫',
    text: '在吗', at: t, messageId: 1, mentioned: true,
  });
  assert.equal(verdict.speak, true, '被点名且冷却早过了 —— 不该被 8 小时前的发言挡住');
  assert.equal(verdict.reason, 'addressed');
});

// ---------------------------------------------------------------- 白名单

test('白名单：只挑 Router 认的会话，坏数据（空串/非数字/不在名单）丢掉', () => {
  const router = new Router({
    dmPolicy: POLICY.ALLOWLIST,
    groupPolicy: POLICY.ALLOWLIST,
    allowFrom: ['30000001', '', 'abc', '30000001'],
    // ⚠️ 这里**故意**把"只被 OBSERVE 的那个群"（30000013）放在**名单外** ——
    // 它就是用户说的那类群（"不在白名单的群不拉"）。
    groupAllowFrom: ['30000012', '30000011', ''],
  });
  const ids = allowedChatIds(router);
  assert.deepEqual(ids, ['group:30000012', 'group:30000011', 'private:30000001']);
  assert.ok(!ids.includes('group:30000013'), '不在白名单的群不许被拉');
});

test('白名单：policy=open 时不该把"全世界的群"都当成待灌会话', () => {
  // 白名单是**唯一的**会话来源（`allowedChatIds` 只遍历两份名单），
  // 所以 open 策略下名单为空 = 一个都不灌，而不是"灌所有群"。
  const router = new Router({ groupPolicy: POLICY.OPEN, dmPolicy: POLICY.OPEN });
  assert.deepEqual(allowedChatIds(router), []);
});

// ---------------------------------------------------------------- backfillChat

test('backfillChat：拉最近 20 条进转录，自己说的话不进转录、只进上下文', async () => {
  const engine = new ProactiveEngine({ config: {}, gauge: async () => ({ speak: false }), speak: async () => {} });
  const calls = [];
  const r = await backfillChat({
    engine,
    chatId: 'group:100',
    selfId: '999',
    call: async (action, params) => {
      calls.push({ action, params });
      return { messages: historyWindow()  };
    },
  });
  assert.equal(calls[0].action, 'get_group_msg_history');
  assert.equal(calls[0].params.group_id, '100');
  assert.ok(calls[0].params.count >= DEFAULT_COUNT, '拉取窗口要 ≥ 要灌的条数');
  assert.equal(r.fetched, 20, '20 条别人的话（她那条不算进转录）');
  assert.equal(r.restored, 20);
  const entries = engine.transcript('group:100').snapshot();
  assert.equal(entries.length, 20);
  assert.ok(!entries.some((m) => m.userId === '999'), '她自己的话不进转录（与 decide 的 fromSelf 早退一致）');
  // 上下文：她那个时刻恢复了
  assert.equal(r.contextAt, OLD + 30 * 60_000);
  assert.equal(engine.state('group:100').lastBotAt, OLD + 30 * 60_000);
});

test('backfillChat：私聊走 get_friend_msg_history，user_id 是自己那一侧', async () => {
  const engine = new ProactiveEngine({ config: {}, gauge: async () => ({ speak: false }), speak: async () => {} });
  const calls = [];
  await backfillChat({
    engine,
    chatId: 'private:30000001',
    selfId: '999',
    call: async (action, params) => {
      calls.push({ action, params });
      return { messages: historyWindow()  };
    },
  });
  assert.equal(calls[0].action, 'get_friend_msg_history');
  assert.equal(calls[0].params.user_id, '30000001');
  assert.equal(engine.transcript('private:30000001').snapshot().length, 20);
});

test('backfillChat：已见过的 messageId 不再灌（同一条消息不许出现两次）', async () => {
  const engine = new ProactiveEngine({ config: {}, gauge: async () => ({ speak: false }), speak: async () => {} });
  const call = async () => ({ messages: historyWindow()  });
  const first = await backfillChat({ engine, chatId: 'group:100', selfId: '999', call });
  assert.equal(first.restored, 20);
  // 第二次启动/重连：同样的窗口再来一遍 —— 一条都不该重复灌进去
  const second = await backfillChat({ engine, chatId: 'group:100', selfId: '999', call });
  assert.equal(second.restored, 0, '转录里已有的别再灌');
  assert.equal(engine.transcript('group:100').snapshot().length, 20, '总数不变（没重复）');
});

test('backfillChat：API 报错时**抛**（由上层转成"这个会话降级"）', async () => {
  const engine = new ProactiveEngine({ config: {}, gauge: async () => ({ speak: false }), speak: async () => {} });
  await assert.rejects(
    () => backfillChat({ engine, chatId: 'group:100', call: async () => { throw new Error('OneBot 未连接'); } }),
    /OneBot 未连接/,
  );
  assert.equal(engine.transcript('group:100').snapshot().length, 0);
});

test('backfillChat：应答里没有 messages 数组时，明确报错而不是静默灌空', async () => {
  const engine = new ProactiveEngine({ config: {}, gauge: async () => ({ speak: false }), speak: async () => {} });
  await assert.rejects(
    () => backfillChat({ engine, chatId: 'group:100', call: async () => null }),
    /没有返回 messages 数组/,
  );
});

// ---------------------------------------------------------------- backfillHistory

test('backfillHistory：一个会话失败不影响其他会话，也不抛', async () => {
  const engine = new ProactiveEngine({ config: {}, gauge: async () => ({ speak: false }), speak: async () => {} });
  const logs = [];
  const report = await backfillHistory({
    engine,
    chatIds: ['group:100', 'group:200'],
    selfId: '999',
    now: () => NOW,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    call: async (action, params) => {
      if (params.group_id === '200') throw new Error('OneBot 未连接');
      return { messages: historyWindow()  };
    },
  });
  assert.equal(report.enabled, true);
  assert.equal(report.restored, 20);
  const failed = report.chats.find((c) => c.chatId === 'group:200');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /OneBot 未连接/);
  assert.equal(report.chats.find((c) => c.chatId === 'group:100').ok, true);
  assert.ok(logs.some((l) => /灌历史失败/.test(l.message)), '失败要留一行日志（否则"没灌"无从判断）');
});

test('backfillHistory：摘要里带前 3 条正文预览（否则看不出灌的是什么时候的话）', async () => {
  const engine = new ProactiveEngine({ config: {}, gauge: async () => ({ speak: false }), speak: async () => {} });
  const report = await backfillHistory({
    engine,
    chatIds: ['group:100'],
    selfId: '999',
    now: () => NOW,
    call: async () => ({ messages: historyWindow()  }),
  });
  const chat = report.chats[0];
  assert.equal(chat.restored, 20);
  assert.equal(chat.preview.length, 3);
  assert.equal(chat.preview[0].text, '第1条');
  assert.ok(chat.preview[0].at < NOW, '预览里的时刻是历史时刻（不是"刚才"）');
});

test('backfillHistory：没有白名单 / 没有调用器 / 引擎已停 ⇒ 明确返回原因，不当成失败', async () => {
  const engine = new ProactiveEngine({ config: {}, gauge: async () => ({ speak: false }), speak: async () => {} });
  const noList = await backfillHistory({ engine, router: new Router({ groupPolicy: POLICY.OPEN }), call: async () => ({}) });
  assert.equal(noList.enabled, false);
  assert.equal(noList.reason, 'no-chat');
  const noCall = await backfillHistory({ engine, chatIds: ['group:100'] });
  assert.equal(noCall.reason, 'no-call');
  engine.stop();
  const stopped = await backfillHistory({ engine, chatIds: ['group:100'], call: async () => ({}) });
  assert.equal(stopped.reason, 'engine-stopped');
});

test('startHistoryBackfill：调用器直接抛同步异常也不外泄（绝不给宿主留 unhandledRejection）', async () => {
  const engine = new ProactiveEngine({ config: {}, gauge: async () => ({ speak: false }), speak: async () => {} });
  const report = await startHistoryBackfill({
    engine,
    chatIds: ['group:100'],
    call: () => { throw new Error('同步就炸'); },
  });
  assert.equal(report.chats[0].ok, false);
  assert.match(report.chats[0].error, /同步就炸/);
});

test('startHistoryBackfill：没条件做时返回 null，且**不抛**', async () => {
  // ⚠️ "没条件做"（没引擎）必须与"做了但 0 条"分得开：前者返回 null、
  // 不调 onDone，调用方据此把快照里的 `historyBackfill` 留成 null。
  const result = await startHistoryBackfill({ engine: null, chatIds: ['group:100'], call: async () => ({}) });
  assert.equal(result, null);
  // 连 options 都不是对象也不许抛
  assert.equal(await startHistoryBackfill(undefined), null);
});

// ---------------------------------------------------------------- 🔴 红线（真装配）

/** 装一套**真装配**：真 Gateway + 真 Router + 真引擎 + 真 gauge，只有传输层与会话是假的。 */
function harness({ allowFrom = [], groupAllowFrom = [] } = {}) {
  const emitter = new EventEmitter();
  const sent = [];
  const transport = {
    selfId: '999',
    sent,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async sendToChat(chatId, message) {
      sent.push({ chatId, message });
      return sent.length;
    },
  };
  const router = new Router({
    dmPolicy: POLICY.ALLOWLIST,
    groupPolicy: POLICY.ALLOWLIST,
    allowFrom,
    groupAllowFrom,
    requireMention: false,
    restrictMembers: false,
  });
  const engine = new ProactiveEngine({
    config: {
      enabled: true, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0, afterUserMsgCount: 1,
    },
    // **真**判定层：这是"旧消息会不会被回"最逼近生产的一条链。
    gauge: (request) => judge(request, { config: { enabled: true, minSignals: 2, lookback: 6 } }),
    allowed: (chatId) => router.proactiveAllowed(chatId),
    speak: async ({ chatId, text }) => { await transport.sendToChat(chatId, text); },
    log: () => {},
    now: () => NOW,
  });
  const prompts = [];
  const gateway = new Gateway({
    transport,
    router,
    engine,
    responder: async (request) => { prompts.push(request); return '回复'; },
    log: () => {},
  });
  gateway.attach();
  return { gateway, transport, sent, prompts, engine, router };
}

test('🔴 红线①：灌 20 条旧消息**一条都不派发**（stats.dispatched 灌前灌后不变）', async () => {
  const h = harness({ groupAllowFrom: ['100'] });
  assert.equal(h.gateway.stats.dispatched, 0, '基线');
  assert.equal(h.gateway.stats.received, 0);

  const report = await backfillHistory({
    engine: h.engine,
    router: h.router,
    selfId: '999',
    now: () => NOW,
    call: async () => ({ messages: historyWindow()  }),
  });

  assert.equal(report.restored, 20, '历史确实灌进去了');
  assert.equal(h.engine.transcript('group:100').snapshot().length, 20);
  // **证明方式**：这一段里没有任何一条旧消息走 `handleEvent` / `decide`，
  // 所以计数只能是 0；会话（responder）一次都没被叫、QQ 一条都没发。
  assert.equal(h.gateway.stats.dispatched, 0, '🔴 灌历史不许派发任何一轮');
  assert.equal(h.gateway.stats.received, 0, '灌历史不是"收到消息"');
  assert.equal(h.gateway.stats.replies, 0);
  assert.equal(h.gateway.stats.observed, 0);
  assert.equal(h.prompts.length, 0, '会话一次都不该被叫');
  assert.equal(h.sent.length, 0, 'QQ 一条都不该发');
  assert.equal(h.engine.state('group:100').speaks.length, 0, '不许偷配额');
});

test('🔴 红线②：NapCat 把同一条历史当实时事件补发一次 ⇒ 仍然不判（duplicate）', async () => {
  const h = harness({ groupAllowFrom: ['100'] });
  await backfillHistory({
    engine: h.engine,
    router: h.router,
    selfId: '999',
    now: () => NOW,
    call: async () => ({ messages: historyWindow()  }),
  });
  const dispatchedBefore = h.gateway.stats.dispatched;

  // 「引用我 + @我」——按判定层口径这是**必回**的一类（`mentioned` + 命中白名单）。
  // 也就是说：如果 dedup 没生效，这条 8 小时前的消息**一定会**得到一条回复。
  const replayed = {
    time: Math.floor((OLD + 60_000) / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 1001, // 与历史里第 1 条同一个 id
    group_id: 100,
    user_id: 2001,
    message: [{ type: 'at', qq: '999' }, { type: 'text', data: { text: '第1条' } }],
    raw_message: '[CQ:at,qq=999] 第1条',
    sender: { nickname: '阿猫', card: '' },
  };
  const first = await h.gateway.handleEvent(replayed);
  assert.equal(first.reason, 'duplicate', '历史里已经有的 id 必须按重复丢掉');
  assert.equal(h.gateway.stats.dispatched, dispatchedBefore, '🔴 旧消息不许因为"补发"而变成一次回复');
  assert.equal(h.sent.length, 0);
});

test('红线③：新消息照常派发（灌历史不该把引擎冻住）', async () => {
  const h = harness({ groupAllowFrom: ['100'] });
  await backfillHistory({
    engine: h.engine,
    router: h.router,
    selfId: '999',
    now: () => NOW,
    call: async () => ({
      // 窗口里**没有她自己的发言** ⇒ `lastBotAt = 0` ⇒ 冷却不参与（与生产一致的正常情况）
      messages: historyWindow().filter((m) => m.user_id !== 999),
    }),
  });
  assert.equal(h.engine.state('group:100').lastBotAt, 0);
  const fresh = {
    time: Math.floor(NOW / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 77,
    group_id: 100,
    user_id: 2001,
    message: [{ type: 'at', qq: '999' }, { type: 'text', data: { text: '小鲸鱼在吗' } }],
    raw_message: '[CQ:at,qq=999] 小鲸鱼在吗',
    sender: { nickname: '阿猫', card: '' },
  };
  const result = await h.gateway.handleEvent(fresh);
  assert.equal(result.outcome, 'dispatched', '点名的新消息该照常回');
  assert.equal(h.gateway.stats.dispatched, 1);
  // 而且它写进转录之后，转录里**新消息在最前**（顺序没被灌历史打乱）
  const entries = h.engine.transcript('group:100').snapshot();
  assert.equal(entries[entries.length - 1].messageId, 77);
  assert.equal(entries.length, 21);
});

test('🔴 红线④：不在白名单的群**根本不拉**', async () => {
  const h = harness({ groupAllowFrom: ['100'] }); // 30000013 不在名单里
  const asked = [];
  await backfillHistory({
    engine: h.engine,
    router: h.router,
    selfId: '999',
    now: () => NOW,
    call: async (action, params) => {
      asked.push(params.group_id);
      return { messages: historyWindow()  };
    },
  });
  assert.deepEqual(asked, ['100'], '只拉白名单里的群');
  assert.equal(h.engine.transcripts.has('group:30000013'), false);
});

test('红线⑤：NapCat 不可用时启动照常（灌历史静默降级，插件不受影响）', async () => {
  const h = harness({ groupAllowFrom: ['100'] });
  const logs = [];
  const report = await backfillHistory({
    engine: h.engine,
    router: h.router,
    selfId: '999',
    now: () => NOW,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    call: async () => { throw new Error('OneBot 未连接，无法调用 get_group_msg_history'); },
  });
  assert.equal(report.enabled, true);
  assert.equal(report.restored, 0);
  assert.equal(report.chats[0].ok, false);
  assert.equal(h.engine.transcript('group:100').snapshot().length, 0);
  // 关键：**插件主链路一个字都没受影响** —— 新消息照样判定、照样回。
  const fresh = {
    time: Math.floor(NOW / 1000), self_id: 999, post_type: 'message', message_type: 'group',
    sub_type: 'normal', message_id: 5, group_id: 100, user_id: 2001,
    message: [{ type: 'at', qq: '999' }, { type: 'text', text: '小鲸鱼' }],
    raw_message: '[CQ:at,qq=999] 小鲸鱼', sender: { nickname: '阿猫', card: '' },
  };
  const result = await h.gateway.handleEvent(fresh);
  assert.equal(result.outcome, 'dispatched');
  assert.equal(h.gateway.stats.dispatched, 1);
});

// ---------------------------------------------------------------- 就绪后补一次（2026-10-13 补）
//
// 背景（用户实测抓到的洞）：`historyBackfill.startedAt = 12:56:55` 那次失败**不是开机**，
// 是 **HMR 热重载** —— 重载后 WS 要重新握手，而灌历史立刻就跑 ⇒ **每次改代码重载都灌不上**。
// 所以"启动时拉一次"这个时机不完整，必须有"连接就绪后补一次"。

/** 控制器测试用：一个能按脚本"先失败后成功"的调用器（按**会话**计数，贴真实语义）。 */
function flakyCall({ failTimes = 1, messages = () => historyWindow() } = {}) {
  /** 每个会话各自被调用了几次。 */
  const perChat = new Map();
  const calls = [];
  const call = async (action, params) => {
    const key = String(params?.group_id ?? params?.user_id ?? '?');
    const n = (perChat.get(key) ?? 0) + 1;
    perChat.set(key, n);
    calls.push({ action, chat: key });
    if (n <= failTimes) throw new Error('OneBot 未连接，无法调用 get_group_msg_history');
    return { messages: messages() };
  };
  return { call, calls, count: () => calls.length, perChat: () => new Map(perChat) };
}

function makeEngine() {
  return new ProactiveEngine({ config: {}, gauge: async () => ({ speak: false }), speak: async () => {} });
}

/** 另一组 20 条（**全新 messageId**）—— 给"第二次尝试"用，避免与第一轮撞 id。 */
function historyWindow2() {
  const list = [];
  for (let i = 1; i <= 20; i += 1) {
    const m = historyMsg(i, { text: `补${i}条`, at: OLD + (100 + i) * 60_000 });
    m.message_id += 500; // ⚠️ 必须换 id：撞上第一轮的 id 会被 `seenIds` 去重掉，第二轮就成 0 条
    list.push(m);
  }
  return list;
}

test('🆕 就绪后补一次：启动那次失败（连接未就绪）⇒ ready 时真的灌上了', async () => {
  const engine = makeEngine();
  const { call, count } = flakyCall({ failTimes: 1 });
  const seen = [];
  const ctl = createHistoryBackfillController({
    engine,
    chatIds: ['group:100'],
    selfId: '999',
    now: () => NOW,
    call,
    onAttempt: (report, meta) => seen.push({ report, meta }),
  });

  // ⓐ 启动：这一刻 WS 还没握上手 ⇒ 失败
  const first = await ctl.startup();
  assert.equal(first.chats[0].ok, false);
  assert.equal(first.restored, 0);
  assert.equal(first.trigger, 'startup');
  assert.equal(first.attempts, 1);
  assert.equal(engine.transcript('group:100').snapshot().length, 0);

  // ⓑ 连接就绪：补一次 ⇒ 这次成了
  const second = await ctl.onConnected();
  assert.notEqual(second, null, '失败过 ⇒ 就绪时必须补');
  assert.equal(second.trigger, 'connected');
  assert.equal(second.attempts, 2);
  assert.equal(second.restored, 20);
  assert.equal(engine.transcript('group:100').snapshot().length, 20);

  // 快照里能看出**是哪一次灌成的**
  assert.equal(seen.length, 2);
  assert.equal(seen[0].report.trigger, 'startup');
  assert.equal(seen[1].report.trigger, 'connected');
  assert.deepEqual(seen[1].meta.pendingChats, []);
  assert.deepEqual(seen[1].meta.resolvedChats, ['group:100']);
  assert.equal(count(), 2, '两次尝试 = 两次 API 调用');
});

test('🆕 就绪后补一次：**启动那次已经成功 ⇒ 就绪钩子一次都不再打**（不重复灌）', async () => {
  const engine = makeEngine();
  const { call, count } = flakyCall({ failTimes: 0 });
  const ctl = createHistoryBackfillController({ engine, chatIds: ['group:100'], selfId: '999', now: () => NOW, call });

  const first = await ctl.startup();
  assert.equal(first.restored, 20);
  const callsAfterStartup = count();
  assert.equal(callsAfterStartup, 1);

  // **就绪钩子触发多次**（重连会反复触发）
  assert.equal(await ctl.onConnected(), null, '已经成功过 ⇒ 跳过');
  assert.equal(await ctl.onConnected(), null);
  assert.equal(await ctl.onConnected(), null);

  assert.equal(count(), callsAfterStartup, '幂等：连 API 都不许再打一次');
  assert.equal(engine.transcript('group:100').snapshot().length, 20, '转录里不许出现第二份（20 条，不是 40）');
  const ids = engine.transcript('group:100').snapshot().map((m) => m.messageId);
  assert.equal(new Set(ids).size, ids.length, '没有重复的 messageId');
});

test('🆕 就绪后补一次：有界 —— 失败后最多再补 maxRetries 次', async () => {
  const engine = makeEngine();
  const { call, count } = flakyCall({ failTimes: 99 }); // 永远失败
  const ctl = createHistoryBackfillController({
    engine, chatIds: ['group:100'], selfId: '999', now: () => NOW, call, maxRetries: 2,
  });
  assert.equal((await ctl.startup()).attempts, 1);
  await ctl.onConnected();
  await ctl.onConnected();
  const fourth = await ctl.onConnected();
  assert.equal(fourth, null, '到达上限后不再尝试');
  assert.equal(ctl.attempts(), 3, '1 次启动 + 2 次补 = 3');
  assert.equal(count(), 3, '到上限后连 API 都不打（不会变成每 5 秒一次的循环）');
});

test('🆕 就绪后补一次：`fetched:0`（这个会话最近没消息）也算"解决"，不再重试', async () => {
  const engine = makeEngine();
  const { call, count } = flakyCall({ failTimes: 0, messages: () => [] });
  const ctl = createHistoryBackfillController({ engine, chatIds: ['group:100'], selfId: '999', now: () => NOW, call });
  const first = await ctl.startup();
  assert.equal(first.chats[0].ok, true, 'NapCat 正常应答、只是空 —— 这是成功不是失败');
  assert.equal(await ctl.onConnected(), null, '空结果不该被当成"要补"');
  assert.equal(count(), 1);
});

test('🆕 就绪后补一次：多会话时只补没成功的那个（不白拉成功过的）', async () => {
  const engine = makeEngine();
  const asked = [];
  const ctl = createHistoryBackfillController({
    engine,
    chatIds: ['group:100', 'group:200'],
    selfId: '999',
    now: () => NOW,
    call: async (action, params) => {
      const before200 = asked.filter((g) => g === '200').length;
      asked.push(params.group_id);
      // group:200 **第一次**调用失败（模拟"这一刻 NapCat 还没应答"），补的那次成功。
      // ⚠️ 补那次给**另一组 20 条**（新 messageId）：这样"补上了"和"没重复灌"
      // 两件事各自可判。两轮若用同一批 id，`seenIds` 去重会让第二轮 `restored=0`，
      // 那时"到底补没补"就看不出来了。
      if (params.group_id === '200' && before200 === 0) throw new Error('OneBot 未连接');
      return { messages: params.group_id === '200' && before200 > 0 ? historyWindow2() : historyWindow() };
    },
  });
  const first = await ctl.startup();
  assert.equal(first.restored, 20, '只有 100 灌上了');
  assert.deepEqual(asked, ['100', '200'], '第一次是全量');
  assert.equal(engine.transcript('group:200').snapshot().length, 0);
  assert.deepEqual(ctl.state().pendingChats, ['group:200']);

  const second = await ctl.onConnected();
  assert.equal(second.trigger, 'connected');
  assert.equal(second.attempts, 2, '报告里的 attempts 必须是控制器的累计值');
  assert.deepEqual(second.chats.map((c) => c.chatId), ['group:200'], '只补没成功的那个');
  assert.equal(second.restored, 20);
  assert.equal(engine.transcript('group:200').snapshot().length, 20);
  assert.deepEqual(asked, ['100', '200', '200'], '成功过的 100 不再白拉一次');
  // 而且 100 那些**没有被再灌一遍**
  assert.equal(engine.transcript('group:100').snapshot().length, 20);
  assert.equal(await ctl.onConnected(), null, '都解决了 ⇒ 之后不再触发');
});

test('🆕 就绪后补一次：整体抛错也只降级，且标记成"待补"', async () => {
  const engine = makeEngine();
  const logs = [];
  const ctl = createHistoryBackfillController({
    engine,
    chatIds: ['group:100'],
    selfId: '999',
    now: () => NOW,
    log: (level, message) => logs.push({ level, message }),
    call: () => { throw new Error('同步就炸'); },
  });
  const first = await ctl.startup();
  assert.equal(first.chats[0].ok, false);
  assert.equal(ctl.state().pendingChats.length > 0, true, '炸过 ⇒ 还欠着');
  assert.ok(logs.some((l) => /灌历史失败/.test(l.message)));
  // 没条件做（引擎已停）时连试都不试
  engine.stop();
  assert.equal(await ctl.onConnected(), null);
});

test('🆕 就绪钩子**不 await、不抛**：宿主那一行写 `void ctl.onConnected()` 也不会漏 rejection', async () => {
  const engine = makeEngine();
  const ctl = createHistoryBackfillController({
    engine, chatIds: ['group:100'], selfId: '999', now: () => NOW,
    call: async () => { throw new Error('OneBot 未连接'); },
  });
  // 完全照 index.mjs 的写法：不 await、不管返回值
  void ctl.onConnected();
  void ctl.onConnected();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(ctl.attempts() <= 3);
});

test('🆕 refresh() 跳过幂等闸门（人工/测试想再跑一次时用）', async () => {
  const engine = makeEngine();
  const { call, count } = flakyCall({ failTimes: 0 });
  const ctl = createHistoryBackfillController({ engine, chatIds: ['group:100'], selfId: '999', now: () => NOW, call });
  await ctl.startup();
  assert.equal(await ctl.onConnected(), null);
  const forced = await ctl.refresh();
  assert.equal(forced.trigger, 'manual');
  assert.equal(count(), 2, 'refresh 是明确要求再跑一次');
  // 但**仍然不许重复灌**（`backfillChat` 里的 seenIds 去重兜住这一层）
  assert.equal(engine.transcript('group:100').snapshot().length, 20, 'force 也不许把同一批消息灌两遍');
});

test('🔴 红线（就绪钩子这条路）：补一次成功了，照样一条都不派发', async () => {
  const h = harness({ groupAllowFrom: ['100'] });
  const { call } = flakyCall({ failTimes: 1 });
  const ctl = createHistoryBackfillController({
    engine: h.engine, router: h.router, selfId: '999', now: () => NOW, call,
  });
  await ctl.startup();
  await ctl.onConnected();
  assert.equal(h.engine.transcript('group:100').snapshot().length, 20, '补成功了');
  assert.equal(h.gateway.stats.dispatched, 0, '🔴 补一次也不许派发');
  assert.equal(h.prompts.length, 0);
  assert.equal(h.sent.length, 0);
});

test('🔴 端到端接线：`transport.emit("ready")` ⇒ 补一次灌上（与 index.mjs 同构）', async () => {
  // 这一条钉住的是 **index.mjs 那段接线**：启动失败 → `ready` 事件 → 灌上，
  // 且期间**没有任何派发**。用真 Gateway + 真 Router + 真 gauge 跑。
  const h = harness({ groupAllowFrom: ['100'] });
  const { call, count } = flakyCall({ failTimes: 1 });
  const reports = [];
  const ctl = createHistoryBackfillController({
    engine: h.engine,
    router: h.router,
    selfId: '999',
    now: () => NOW,
    call,
    onAttempt: (report, meta) => reports.push({ trigger: report?.trigger ?? null, restored: report?.restored ?? 0, attempts: meta?.attempts }),
  });
  // @@ 与 index.mjs 同样的两行接线 @@
  const onReady = () => { void ctl.onConnected(); };
  h.transport.on('ready', onReady);
  void ctl.startup();

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.engine.transcript('group:100').snapshot().length, 0, '启动那次失败（连接未就绪）');

  h.transport.emit('ready', { selfId: '999' }); // ← NapCat 握上手
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(count(), 2);
  assert.equal(h.engine.transcript('group:100').snapshot().length, 20, '就绪钩子把历史补上了');
  assert.deepEqual(reports.map((r) => r.trigger), ['startup', 'connected']);
  assert.deepEqual(reports.map((r) => r.attempts), [1, 2]);
  assert.equal(h.gateway.stats.dispatched, 0, '🔴 全程一条都没派发');

  // 再次握手（重连）⇒ 幂等，不许再灌
  h.transport.emit('ready', { selfId: '999' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(count(), 2, '已经成功过 ⇒ 重连不再打 API');
  assert.equal(h.engine.transcript('group:100').snapshot().length, 20, '转录里没有第二份');
  h.transport.off('ready', onReady);
});

