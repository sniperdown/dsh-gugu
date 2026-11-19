/**
 * 定时器代际登记（2026-11-15）的离线测试。
 *
 * 目标：证明"重复 apply 不会叠加定时器"这一条在模块层面成立 ——
 * 新一代开始时清掉上一代；旧一代的 register/clear 不再影响新一代。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeGeneration,
  endGeneration,
  resetGenerationForTest,
  startGeneration,
} from '../src/dsh/lifecycle.mjs';

function makeHarness() {
  const cleared = [];
  const logs = [];
  const opts = {
    clear: (t) => cleared.push(t),
    log: (level, msg, meta) => logs.push({ level, msg, meta }),
  };
  return { cleared, logs, opts };
}

test('换代：新的一代开始时会清掉上一代登记的定时器', () => {
  resetGenerationForTest();
  const { cleared, logs, opts } = makeHarness();
  const gen1 = startGeneration(opts);
  gen1.register('t1');
  gen1.register('t2');
  assert.equal(gen1.size(), 2);
  const gen2 = startGeneration(opts);
  assert.deepEqual(cleared, ['t1', 't2']);
  assert.ok(logs.some((l) => l.msg.includes('上一代遗留定时器')));
  assert.equal(gen1.size(), 0);
  assert.equal(gen2.size(), 0);
  assert.equal(activeGeneration().generation, gen2.generation);
});

test('旧一代的 clear 在换代之后是空操作，不会误清新一代', () => {
  resetGenerationForTest();
  const { cleared, opts } = makeHarness();
  const gen1 = startGeneration(opts);
  gen1.register('old');
  const gen2 = startGeneration(opts);
  gen2.register('new');
  cleared.length = 0;
  assert.equal(gen1.clear(), 0);
  assert.deepEqual(cleared, [], '旧一代不应清掉新一代的定时器');
  assert.equal(gen2.size(), 1);
});

test('旧一代迟到登记：立即清理，不留在任何一代里', () => {
  resetGenerationForTest();
  const { cleared, logs, opts } = makeHarness();
  const gen1 = startGeneration(opts);
  startGeneration(opts);
  cleared.length = 0;
  gen1.register('late');
  assert.deepEqual(cleared, ['late']);
  assert.ok(logs.some((l) => l.msg.includes('旧一代尝试登记')));
  assert.equal(gen1.size(), 0);
});

test('endGeneration 带代际号：代不符时不动（迟到的 dispose 不会误伤）', () => {
  resetGenerationForTest();
  const { cleared, opts } = makeHarness();
  const gen1 = startGeneration(opts);
  gen1.register('a');
  const gen2 = startGeneration(opts);
  gen2.register('b');
  cleared.length = 0;
  assert.equal(endGeneration(() => {}, gen1.generation), -1);
  assert.deepEqual(cleared, []);
  assert.equal(activeGeneration().generation, gen2.generation);
  // 代际号相符时正常清空
  assert.equal(endGeneration(() => {}, gen2.generation), 1);
  assert.deepEqual(cleared, ['b']);
  assert.equal(activeGeneration(), null);
});

test('endGeneration 无参时清掉当前一代；没有当前一代返回 0', () => {
  resetGenerationForTest();
  const { cleared, opts } = makeHarness();
  const gen = startGeneration(opts);
  gen.register('x');
  assert.equal(endGeneration(() => {}), 1);
  assert.deepEqual(cleared, ['x']);
  assert.equal(endGeneration(() => {}), 0);
});
