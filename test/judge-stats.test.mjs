/**
 * 判定器计数器（`src/dsh/judge-stats.mjs`，2026-10-28）的**单元测试**。
 *
 * 这一份钉的是三条硬约束（比"数字对不对"更重要）：
 *
 * 1. **分类口径**：`source` → 桶的映射，尤其"超时/报错/格式不对"必须分得开，
 *    而且**都不算通过**（它们回来后 `speak === true`，混进 `passed` 会让通过率虚高）；
 * 2. **绝不抛**：热路径上的计数器，喂垃圾（`null` / 数字 / getter 抛异常 / 时钟坏掉）
 *    也只能少一个数，绝不往外抛；
 * 3. **恒等式**：`calls === passed + declined + failed + skipped + other`，
 *    `failed === failedTimeout + failedError + failedUnparsed`。
 *
 * ⚠️ 不测"判定结果" —— 那是 `judge-mode.test.mjs` 的活，这边只数数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifySource, createJudgeStats } from '../src/dsh/judge-stats.mjs';

/** 计数恒等式（每条用例都该成立）。 */
function assertInvariants(counts, label = '') {
  assert.equal(
    counts.calls,
    counts.passed + counts.declined + counts.failed + counts.skipped + counts.other,
    `${label} calls 必须等于各桶之和`,
  );
  assert.equal(
    counts.failed,
    counts.failedTimeout + counts.failedError + counts.failedUnparsed,
    `${label} failed 必须等于三种失败之和`,
  );
}

// ------------------------------------------------------------------ 分类

test('judge-stats：source → 桶（reply/decline 是判定，timeout/error/unparsed 是失败）', () => {
  assert.equal(classifySource('reply'), 'passed');
  assert.equal(classifySource('decline'), 'declined');
  assert.equal(classifySource('timeout'), 'timeout');
  assert.equal(classifySource('error'), 'error');
  assert.equal(classifySource('unparsed'), 'unparsed');
  assert.equal(classifySource('busy'), 'busy');
  assert.equal(classifySource('no-model'), 'no-model');
  // 宽容：大小写 / 前后空白 / 下划线写法
  assert.equal(classifySource(' REPLY '), 'passed');
  assert.equal(classifySource('No_Model'), 'no-model');
});

test('judge-stats：认不出的 source **绝不默认算通过**（兜底桶 other）', () => {
  for (const bad of ['', 'whatever', null, undefined, 42, {}, []]) {
    assert.equal(classifySource(bad), 'other', `${String(bad)} 应落到 other`);
  }
});

// ------------------------------------------------------------------ 记账

test('judge-stats：每一种 source 记到该去的地方，且恒等式成立', () => {
  const stats = createJudgeStats({ now: () => 1_000 });

  stats.record('group:1', { source: 'reply', ms: 12 });
  stats.record('group:1', { source: 'decline', ms: 34 });
  stats.record('group:1', { source: 'timeout', ms: 8000 });
  stats.record('group:1', { source: 'error', ms: 7 });
  stats.record('group:1', { source: 'unparsed', ms: 9 });
  stats.record('group:1', { source: 'busy', ms: 0 });
  stats.record('group:1', { source: 'no-model', ms: 0 });
  stats.record('group:1', { source: 'wat', ms: 1 });

  const snap = stats.snapshot();
  const [, row] = snap.sessions[0];
  assert.equal(row.calls, 8);
  assert.equal(row.passed, 1);
  assert.equal(row.declined, 1);
  assert.equal(row.failed, 3, '超时/报错/格式不对三者之和');
  assert.equal(row.failedTimeout, 1);
  assert.equal(row.failedError, 1);
  assert.equal(row.failedUnparsed, 1);
  assert.equal(row.skipped, 2, 'busy + no-model（都没问成，但不是失败）');
  assert.equal(row.skippedBusy, 1);
  assert.equal(row.skippedNoModel, 1);
  assert.equal(row.other, 1);
  assertInvariants(row, 'row');
  assertInvariants(snap.total, 'total');
  assert.equal(snap.total.calls, 8, '只有一个会话时 total 应与它相同');
});

test('judge-stats：通过率口径 = passed / (passed + declined)，失败**不进分母**', () => {
  const stats = createJudgeStats({ now: () => 1_000 });
  stats.record('group:1', { source: 'reply' });
  stats.record('group:1', { source: 'reply' });
  stats.record('group:1', { source: 'decline' });
  // 三次失败会让 passed/calls = 0.4，但那不是"通过率"—— 口径必须是 2/3
  stats.record('group:1', { source: 'timeout' });
  stats.record('group:1', { source: 'error' });
  stats.record('group:1', { source: 'unparsed' });

  const row = stats.snapshot().sessions[0][1];
  assert.equal(row.passRate, 0.667, '2 通过 / 3 答上来 = 0.667');
  assert.equal(row.failRate, 0.5, '3 失败 / 6 次 = 0.5');
});

test('judge-stats：一次都没"答上来"时 passRate 是 null（不是 0）', () => {
  const stats = createJudgeStats({ now: () => 1_000 });
  // 空计数器
  assert.equal(stats.snapshot().total.passRate, null);
  assert.equal(stats.snapshot().total.failRate, null);
  // 只有失败（判定器一直没答上来）⇒ 通过率**未知**，不该显示成"0% 通过"
  stats.record('group:1', { source: 'timeout' });
  const row = stats.snapshot().sessions[0][1];
  assert.equal(row.passRate, null);
  assert.equal(row.failRate, 1);
});

test('judge-stats：按会话分开记，total 是全部加总（含没显示在 sessions 里的）', () => {
  const stats = createJudgeStats({ now: () => 1_000 });
  stats.record('group:1', { source: 'reply' });
  stats.record('private:2', { source: 'decline' });
  stats.record('private:2', { source: 'decline' });

  const snap = stats.snapshot();
  assert.equal(snap.sessionCount, 2);
  const byChat = new Map(snap.sessions);
  assert.equal(byChat.get('group:1').passed, 1);
  assert.equal(byChat.get('private:2').declined, 2);
  assert.equal(byChat.get('private:2').passRate, 0);
  assert.equal(snap.total.calls, 3);
  assert.equal(snap.total.passed, 1);
  assert.equal(snap.total.declined, 2);
  assert.equal(snap.total.passRate, 0.333);
  assert.equal(snap.total.lastChatId, 'private:2');
});

test('judge-stats：sessions 按最近判定时间倒序、最多给 tail 个（total 不受影响）', () => {
  let t = 1000;
  const stats = createJudgeStats({ now: () => t, tail: 2 });
  stats.record('group:old', { source: 'reply' });
  t += 1000;
  stats.record('group:mid', { source: 'reply' });
  t += 1000;
  stats.record('group:new', { source: 'reply' });

  const snap = stats.snapshot();
  assert.equal(snap.sessions.length, 2, 'tail=2');
  assert.deepEqual(snap.sessions.map((p) => p[0]), ['group:new', 'group:mid']);
  assert.equal(snap.total.calls, 3, 'total 仍是全部 3 次（哪怕只显示了 2 个会话）');
  assert.equal(snap.sessionCount, 3);
});

test('judge-stats：会话数超上限时淘汰最久没判定的那个，total 照旧准确', () => {
  let t = 1000;
  const stats = createJudgeStats({ now: () => t, maxSessions: 2 });
  stats.record('group:a', { source: 'reply' });
  t += 1000;
  stats.record('group:b', { source: 'reply' });
  t += 1000;
  stats.record('group:c', { source: 'reply' }); // 挤掉 group:a

  const snap = stats.snapshot();
  assert.equal(snap.sessionCount, 2);
  assert.deepEqual(snap.sessions.map((p) => p[0]).sort(), ['group:b', 'group:c']);
  assert.equal(snap.total.calls, 3, '淘汰只影响"分会话"的可见性，不该丢全局数');
});

// ------------------------------------------------------------------ 最近一次

test('judge-stats：最近一次的 时刻 / 耗时 / source / 失败原因都在，且失败原因只有三种', () => {
  let t = Date.UTC(2026, 9, 28, 3, 0, 0);
  const stats = createJudgeStats({ now: () => t });

  stats.record('group:1', { source: 'reply', ms: 123 });
  let row = stats.snapshot().sessions[0][1];
  assert.equal(row.lastMs, 123);
  assert.equal(Date.parse(row.lastAt), t);
  assert.equal(row.lastSource, 'reply');
  assert.equal(row.lastFailedReason, '', '没失败过 ⇒ 空');
  assert.equal(row.lastFailedAt, '');

  t += 5000;
  stats.record('group:1', { source: 'timeout', ms: 8000 });
  row = stats.snapshot().sessions[0][1];
  assert.equal(row.lastFailedReason, 'timeout');
  assert.equal(Date.parse(row.lastFailedAt), t, '失败时刻跟着失败那一笔走');
  t += 1;
  stats.record('group:1', { source: 'unparsed', ms: 40 });
  row = stats.snapshot().sessions[0][1];
  assert.equal(row.lastMs, 40);
  assert.equal(row.lastSource, 'unparsed');
  assert.equal(row.lastFailedReason, 'unparsed', '最后一次失败原因要能区分');
  assert.equal(Date.parse(row.lastFailedAt), t);
  // 三种原因用**同一份**字段，值域只有三个 + 空
  for (const src of ['timeout', 'error']) {
    stats.record('group:1', { source: src, ms: 1 });
    assert.equal(stats.snapshot().sessions[0][1].lastFailedReason, src);
  }
});

// ------------------------------------------------------------------ 绝不抛

test('judge-stats：喂垃圾（null / 非对象 / 抛异常的 getter）也不抛，最多少一个数', () => {
  const stats = createJudgeStats({ now: () => 1000 });
  assert.doesNotThrow(() => {
    stats.record(null, null);
    stats.record(undefined, undefined);
    stats.record(42, 'reply');
    stats.record('group:1', {});
    stats.record('group:1', { source: { nested: true } });
    stats.record('group:1', { source: 'reply', ms: Number.NaN });
  });
  // `source` 的 getter 直接抛 —— 这是最容易把热路径带崩的写法
  const bomb = {};
  Object.defineProperty(bomb, 'source', { get() { throw new Error('boom'); } });
  assert.doesNotThrow(() => stats.record('group:1', bomb));
  // 时钟坏掉也不许抛
  const broken = createJudgeStats({ now: () => { throw new Error('clock'); } });
  assert.doesNotThrow(() => broken.record('group:1', { source: 'reply', ms: 5 }));
  assert.doesNotThrow(() => broken.snapshot());
});

test('judge-stats：NaN/负数耗时归一成 0，快照里不会出现 NaN', () => {
  const stats = createJudgeStats({ now: () => 1000 });
  stats.record('group:1', { source: 'reply', ms: Number.NaN });
  stats.record('group:1', { source: 'reply', ms: -5 });
  const row = stats.snapshot().sessions[0][1];
  assert.equal(row.lastMs, 0);
  assert.equal(JSON.stringify(row).includes('NaN'), false);
});

test('judge-stats：snapshot 总是固定形状（读的人不用先判"这个键在不在"）', () => {
  const snap = createJudgeStats({ now: () => 1000 }).snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ['sessionCount', 'sessions', 'since', 'total']);
  assert.equal(snap.sessionCount, 0);
  assert.deepEqual(snap.sessions, []);
  for (const key of [
    'calls', 'passed', 'declined', 'failed', 'failedTimeout', 'failedError', 'failedUnparsed',
    'skipped', 'skippedBusy', 'skippedNoModel', 'other', 'passRate', 'failRate', 'lastAt',
    'lastMs', 'lastSource', 'lastChatId', 'lastFailedAt', 'lastFailedReason',
  ]) {
    assert.ok(Object.hasOwn(snap.total, key), `total 缺字段 ${key}`);
  }
  assertInvariants(snap.total, 'empty total');
});
