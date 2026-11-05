/**
 * 群聊防抖（2026-11-04）的离线测试：用假时钟，不睡真时间。
 *
 * 断言的是"什么时候放行、放行几条、顺序对不对"——它不判断该不该说话，
 * 那是引擎的事；这里只保证**不吞消息、不拖过上限**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, createDebouncer } from '../src/dsh/debounce.mjs';

/** 极简假时钟：advance 时按到期顺序执行。 */
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    set: (fn, delay) => {
      const id = ++seq;
      timers.set(id, { fn, at: t + Math.max(0, delay) });
      return id;
    },
    clear: (id) => timers.delete(id),
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let next = null;
        for (const [id, item] of timers) {
          if (item.at <= target && (next === null || item.at < next[1].at)) next = [id, item];
        }
        if (next === null) break;
        const [id, item] = next;
        timers.delete(id);
        t = item.at;
        item.fn();
      }
      t = target;
    },
    pending: () => timers.size,
  };
}

function makeDebouncer(clock) {
  const batches = [];
  const d = createDebouncer({
    now: clock.now,
    timers: { setTimeout: clock.set, clearTimeout: clock.clear },
    onFlush: (items) => batches.push(items.map((i) => i.payload)),
  });
  return { d, batches };
}

test('同一个人连发：等 2s，一批收齐、顺序保持', () => {
  const clock = fakeClock();
  const { d, batches } = makeDebouncer(clock);
  assert.equal(d.push({ chatId: 'g', userId: '1', payload: 'a' }), true);
  clock.advance(1000);
  assert.equal(d.push({ chatId: 'g', userId: '1', payload: 'b' }), true);
  clock.advance(1000);
  assert.equal(d.push({ chatId: 'g', userId: '1', payload: 'c' }), true);
  assert.equal(batches.length, 0, '还没到 2s 不该放行');
  clock.advance(2000);
  assert.deepEqual(batches, [['a', 'b', 'c']]);
});

test('换人：窗口缩到 0.5s', () => {
  const clock = fakeClock();
  const { d, batches } = makeDebouncer(clock);
  d.push({ chatId: 'g', userId: '1', payload: 'a' });
  clock.advance(100);
  d.push({ chatId: 'g', userId: '2', payload: 'b' });
  clock.advance(DEFAULTS.switchUserMs);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], ['a', 'b']);
});

test('8s 硬上限：一直有人说话也必须放行', () => {
  const clock = fakeClock();
  const { d, batches } = makeDebouncer(clock);
  for (let i = 0; i < 12; i++) {
    d.push({ chatId: 'g', userId: '1', payload: i });
    clock.advance(900); // 每 900ms 一条，2s 窗口永远不静
  }
  clock.advance(10000); // 把剩下的也放掉
  assert.ok(batches.length >= 1, '应该有批次被放行');
  const flat = batches.flat();
  assert.deepEqual(flat, Array.from({ length: 12 }, (_, i) => i), '一条都不能丢、顺序不能乱');
  assert.ok(batches[0].length >= 9, `第一批应在 8s 处断掉（实际 ${batches[0].length} 条）`);
});

test('含 @：最多等 1s', () => {
  const clock = fakeClock();
  const { d, batches } = makeDebouncer(clock);
  d.push({ chatId: 'g', userId: '1', isAt: true, payload: 'at' });
  clock.advance(999);
  assert.equal(batches.length, 0);
  clock.advance(1);
  assert.deepEqual(batches, [['at']]);
});

test('不同会话各自计时，互不干扰', () => {
  const clock = fakeClock();
  const { d, batches } = makeDebouncer(clock);
  d.push({ chatId: 'g1', userId: '1', payload: 'x' });
  clock.advance(100);
  d.push({ chatId: 'g2', userId: '1', payload: 'y' });
  clock.advance(1900); // t=2000：只有 g1 到点
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], ['x']);
  clock.advance(100); // t=2100：g2 到点
  assert.deepEqual(batches[1], ['y']);
});

test('flush 立刻放行；dispose 之后不再放行', () => {
  const clock = fakeClock();
  const { d, batches } = makeDebouncer(clock);
  d.push({ chatId: 'g', userId: '1', payload: 'a' });
  d.flush('g');
  assert.deepEqual(batches, [['a']]);
  d.push({ chatId: 'g', userId: '1', payload: 'b' });
  d.dispose();
  clock.advance(10000);
  assert.equal(batches.length, 1, 'dispose 之后的定时器不该再触发');
});

test('缺少 chatId 不接管（返回 false，交给调用方立即处理）', () => {
  const clock = fakeClock();
  const { d, batches } = makeDebouncer(clock);
  assert.equal(d.push({ userId: '1', payload: 'x' }), false);
  clock.advance(10000);
  assert.deepEqual(batches, []);
});
