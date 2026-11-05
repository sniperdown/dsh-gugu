/**
 * 「顺便看一眼」通知判定的测试。
 *
 * 这些规则全部来自用户的明确要求，不是我自己定的：
 * - 「只在非常需要的时候，比如过了好几个小时一直挂着就等我点确定的时候喊我」
 * - 「或者我出去的时候喊我」
 * - 「不需要在工作的时候挂着计时器…聊天子会话汇报上来激活核心的时候顺便偶尔看一眼」
 * - QQ 聊天会话不是"工作"（他实测收到过小鲸鱼自己的闲聊被当成工作播报）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isChatSession,
  readSessionState,
  shouldNotify,
  selectNotifiable,
  buildAlert,
  WAITING_KINDS,
} from '../src/dsh/notifier.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** 造一个已记录的 turn/end 事件。 */
const turnEnd = (kind, turn = 1, time = 0) => ({
  type: 'turn/end',
  time,
  data: { turn, reason: { kind } },
});

// ---------------------------------------------------------------- 会话分类

test('isChatSession：QQ 通道前缀都算聊天', () => {
  for (const id of ['qq-private-1', 'qq-group-2', 'onebot-group-3', 'onebot-private-4']) {
    assert.equal(isChatSession(id), true, `${id} 应算聊天会话`);
  }
  for (const id of ['session-abc', 'work-1', '', 'onebots-x', 'qq']) {
    assert.equal(isChatSession(id), false, `${id} 不该算聊天会话`);
  }
});

// ---------------------------------------------------------------- 状态读取

test('readSessionState：只看最后一个 turn/end', () => {
  // 先卡住、后完成 → 当前是完成
  const s1 = readSessionState([turnEnd('blocked', 1, 100), turnEnd('completed', 2, 200)]);
  assert.equal(s1.waiting, false);
  assert.equal(s1.kind, 'completed');
  assert.equal(s1.turn, 2);

  // 先完成、后卡住 → 当前是卡住
  const s2 = readSessionState([turnEnd('completed', 1, 100), turnEnd('blocked', 2, 200)]);
  assert.equal(s2.waiting, true);
  assert.equal(s2.kind, 'blocked');
  assert.equal(s2.turn, 2);
});

test('readSessionState：三种等待原因都算"在等我"', () => {
  for (const kind of WAITING_KINDS) {
    assert.equal(readSessionState([turnEnd(kind)]).waiting, true, kind);
  }
  assert.equal(readSessionState([turnEnd('completed')]).waiting, false);
  assert.equal(readSessionState([turnEnd('max-tokens')]).waiting, false);
});

test('readSessionState：没有 turn/end 时不算等待', () => {
  assert.equal(readSessionState([]).waiting, false);
  assert.equal(readSessionState(undefined).waiting, false);
  assert.equal(readSessionState([{ type: 'system/message' }]).waiting, false);
});

// ---------------------------------------------------------------- 是否出声

const base = {
  now: 10 * HOUR,
  waiting: false,
  blockedSince: null,
  createdAt: 0,
  turn: 3,
  awayMode: false,
  onlyWhenBlocked: true,
  waitingNotifyAfterMinutes: 90,
};

test('默认策略：普通完成不 pesky —— 人就在电脑前', () => {
  const v = shouldNotify({ ...base, waiting: false });
  assert.equal(v.notify, false);
  assert.equal(v.reason, 'not-waiting');
});

test('默认策略：卡住但还没等够久 → 不催', () => {
  const v = shouldNotify({ ...base, waiting: true, blockedSince: 9 * HOUR + 30 * MIN });
  assert.equal(v.notify, false);
  assert.equal(v.reason, 'not-long-enough');
});

test('默认策略：卡住等够久了 → 喊他', () => {
  const v = shouldNotify({ ...base, waiting: true, blockedSince: 8 * HOUR });
  assert.equal(v.notify, true);
  assert.equal(v.reason, 'waiting-too-long');
});

test('默认策略：第一轮不算（还没干过活）', () => {
  const v = shouldNotify({ ...base, turn: 0, waiting: true, blockedSince: 0 });
  assert.equal(v.notify, false);
  assert.equal(v.reason, 'no-turn');
});

test('出门模式：普通完成也喊', () => {
  const v = shouldNotify({ ...base, awayMode: true, waiting: false });
  assert.equal(v.notify, true);
  assert.equal(v.reason, 'away-mode');
});

test('出门模式优先级高于阻塞判定（完成也喊）', () => {
  const v = shouldNotify({ ...base, awayMode: true, waiting: false, turn: 1 });
  assert.equal(v.notify, true);
});

test('onlyWhenBlocked=false：退化成每轮都报', () => {
  const v = shouldNotify({ ...base, onlyWhenBlocked: false, waiting: false });
  assert.equal(v.notify, true);
  assert.equal(v.reason, 'every-turn');
});

test('时间不明时宁可漏报，不打扰', () => {
  // 「不明」= 两个时间都给不出来（NaN / undefined / null）。
  // 注意 `0` **不算**不明——它是合法的 epoch 0 时间戳，见下一条测试。
  const v = shouldNotify({ ...base, waiting: true, blockedSince: NaN, createdAt: NaN });
  assert.equal(v.notify, false);
  assert.equal(v.reason, 'unknown-since');

  const v2 = shouldNotify({ ...base, waiting: true, blockedSince: undefined, createdAt: undefined });
  assert.equal(v2.notify, false);
  assert.equal(v2.reason, 'unknown-since');
});

test('时间戳恰好为 0 是合法值，不能当成"不明"', () => {
  // 回归：守卫曾写成 `since > 0`，于是 epoch 0 被判成"时间不明"，
  // 本该出声的场景被静默吞掉。事件里的 `time` 是毫秒时间戳，0 合法。
  const v = shouldNotify({
    ...base,
    waiting: true,
    blockedSince: 0,
    createdAt: 0,
    now: 10 * HOUR,
  });
  assert.equal(v.notify, true, 'epoch 0 起算等了 10 小时，该喊');
  assert.equal(v.reason, 'waiting-too-long');
});

test('blockedSince 缺失时退化为会话创建时间', () => {
  const v = shouldNotify({
    ...base,
    waiting: true,
    blockedSince: null,
    createdAt: 1 * HOUR,
    now: 10 * HOUR,
  });
  assert.equal(v.notify, true, '用创建时间算也等够久了');
});

test('waitingNotifyAfterMinutes 非法时回落到 90 分钟', () => {
  const justUnder = shouldNotify({
    ...base,
    waiting: true,
    blockedSince: 0,
    createdAt: 0,
    now: 89 * MIN,
    waitingNotifyAfterMinutes: 0,
  });
  assert.equal(justUnder.notify, false, '89 分钟不该喊（默认 90）');
  const justOver = shouldNotify({
    ...base,
    waiting: true,
    blockedSince: 0,
    createdAt: 0,
    now: 91 * MIN,
    waitingNotifyAfterMinutes: 0,
  });
  assert.equal(justOver.notify, true, '91 分钟该喊');
});

// ---------------------------------------------------------------- 批量挑选

test('selectNotifiable：跳过 QQ 会话，只挑工作会话', () => {
  const now = 10 * HOUR;
  const out = selectNotifiable({
    now,
    awayMode: false,
    onlyWhenBlocked: true,
    waitingNotifyAfterMinutes: 90,
    sessions: [
      { id: 'onebot-group-200000001', createdAt: 0, events: [turnEnd('blocked', 1, 0)] },
      { id: 'qq-private-1', createdAt: 0, events: [turnEnd('blocked', 1, 0)] },
      { id: 'session-stuck', createdAt: 0, events: [turnEnd('blocked', 4, 0)] },
      { id: 'session-done', createdAt: 0, events: [turnEnd('completed', 2, 0)] },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'session-stuck');
  assert.equal(out[0].turn, 4);
  assert.equal(out[0].reason, 'waiting-too-long');
});

test('selectNotifiable：allow 回调可再过滤', () => {
  const out = selectNotifiable({
    now: 10 * HOUR,
    awayMode: false,
    onlyWhenBlocked: true,
    waitingNotifyAfterMinutes: 90,
    allow: (id) => id === 'session-b',
    sessions: [
      { id: 'session-a', createdAt: 0, events: [turnEnd('blocked', 1, 0)] },
      { id: 'session-b', createdAt: 0, events: [turnEnd('blocked', 1, 0)] },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'session-b');
});

test('selectNotifiable：出门模式下挑出已完成的会话', () => {
  const out = selectNotifiable({
    now: 10 * HOUR,
    awayMode: true,
    onlyWhenBlocked: true,
    waitingNotifyAfterMinutes: 90,
    sessions: [
      { id: 'session-a', createdAt: 0, events: [turnEnd('completed', 2, 0)] },
      { id: 'session-b', createdAt: 0, events: [] },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'session-a');
  assert.equal(out[0].reason, 'away-mode');
});

test('selectNotifiable：空输入不炸', () => {
  const opts = { now: 0, awayMode: false, onlyWhenBlocked: true, waitingNotifyAfterMinutes: 90 };
  assert.deepEqual(selectNotifiable({ ...opts, sessions: [] }), []);
  assert.deepEqual(selectNotifiable({ ...opts, sessions: undefined }), []);
});

// ---------------------------------------------------------------- 文案

test('buildAlert：单个卡住的会话措辞直白', () => {
  const text = buildAlert(
    [{ id: 'session-11111111-2222-3333-4444-555555555555', turn: 12, kind: 'blocked', reason: 'waiting-too-long' }],
    { shortId: (id) => id.slice(8, 16) },
  );
  assert.match(text, /11111111/);
  assert.match(text, /第 12 轮/);
  assert.match(text, /卡住/);
  assert.match(text, /等你确认/);
});

test('buildAlert：出门模式措辞不同', () => {
  const text = buildAlert(
    [{ id: 'session-aaaa1111', turn: 3, kind: 'completed', reason: 'away-mode' }],
    { shortId: (id) => id.slice(8, 16) },
  );
  assert.match(text, /跑完/);
  assert.doesNotMatch(text, /卡住/);
});

test('buildAlert：多个会话列成清单', () => {
  const text = buildAlert(
    [
      { id: 'session-aaaa1111', turn: 1, kind: 'blocked', reason: 'waiting-too-long' },
      { id: 'session-bbbb2222', turn: 2, kind: 'error', reason: 'waiting-too-long' },
    ],
    { shortId: (id) => id.slice(8, 16) },
  );
  assert.match(text, /2 个会话/);
  assert.match(text, /aaaa1111/);
  assert.match(text, /bbbb2222/);
});

test('buildAlert：空列表给空串（不发出无意义消息）', () => {
  assert.equal(buildAlert([]), '');
  assert.equal(buildAlert(undefined), '');
});

test('buildAlert：受 maxChars 限制', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    id: `session-${String(i).padStart(8, '0')}`,
    turn: i,
    kind: 'blocked',
    reason: 'waiting-too-long',
  }));
  const text = buildAlert(many, { maxChars: 100 });
  assert.ok(text.length <= 100, `实际 ${text.length} 应 ≤ 100`);
});
