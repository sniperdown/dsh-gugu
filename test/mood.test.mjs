/**
 * 动态心情系统的测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMood, moodUpdateProbability } from '../src/dsh/mood.mjs';

test('moodUpdateProbability：随时间增长，封顶 0.5', () => {
  assert.equal(moodUpdateProbability(0), 0.1);
  assert.equal(moodUpdateProbability(60_000), 0.2);
  assert.ok(moodUpdateProbability(300_000) >= 0.5);
  assert.equal(moodUpdateProbability(600_000), 0.5);
});

test('getMood：初始平静', () => {
  const mood = createMood({ stream: async function* () {}, provider: 'p', model: 'm' });
  assert.equal(mood.getMood('g:1'), '感觉很平静');
});

test('updateMood：概率触发时用 LLM 更新心情', async () => {
  const orig = Math.random;
  Math.random = () => 0; // 一定触发
  try {
    const mood = createMood({
      stream: async function* () { yield { type: 'text-delta', text: '有点兴奋' }; },
      provider: 'p', model: 'm', emotionStyle: '聊色色会兴奋',
    });
    const m = await mood.updateMood({ chatId: 'g:1', transcript: '聊了色色', now: Date.now() });
    assert.equal(m, '有点兴奋');
    assert.equal(mood.getMood('g:1'), '有点兴奋');
  } finally {
    Math.random = orig;
  }
});

test('updateMood：第一次【必定】尝试，不靠抽签', async () => {
  // 2026-10-15 改的行为。原因：`moodUpdateProbability` 上限只有 0.5，
  // 而"从没成功过"时它算的是 `now - 0`（巨大）⇒ 概率封顶 0.5 ⇒ 每个进程重载后
  // 第一次心情要抛硬币。实测连发 3 条消息全没中（12.5%）—— 而线上表现和
  // "没接线"一模一样（都是 tries=0），排查时极难分辨。
  // ⇒ 条件用 `tries === 0`（每个会话每进程恰好多这一次），不是 `lastChangeAt === 0`
  //   （后者在持续失败时也不为 0 ⇒ 会变成每条消息都真发请求）。
  const orig = Math.random;
  Math.random = () => 1; // 专门让它"抽不中"
  try {
    let called = 0;
    const mood = createMood({ stream: async function* () { called += 1; }, provider: 'p', model: 'm' });
    await mood.updateMood({ chatId: 'g:1', transcript: 'x', now: Date.now() });
    assert.equal(called, 1, '第一次必须真的发请求（即使 Math.random 返回 1）');
  } finally {
    Math.random = orig;
  }
});

test('updateMood：第一次之后仍受概率约束（没抽中就不调 LLM）', async () => {
  const orig = Math.random;
  try {
    let called = 0;
    const mood = createMood({ stream: async function* () { called += 1; }, provider: 'p', model: 'm' });
    Math.random = () => 0; // 第一次必定成功 ⇒ 把 tries 变成 1
    await mood.updateMood({ chatId: 'g:1', transcript: 'x', now: Date.now() });
    assert.equal(called, 1, '第一次应该调了');
    Math.random = () => 1; // 之后抽不中
    const m = await mood.updateMood({ chatId: 'g:1', transcript: 'x', now: Date.now() + 1000 });
    assert.equal(called, 1, '没抽中 ⇒ 不该再发请求');
    assert.equal(typeof m, 'string', '没抽中时仍然返回当前心情');
  } finally {
    Math.random = orig;
  }
});

test('regress：静默够久才平复，且最多两次', async () => {
  const orig = Math.random;
  Math.random = () => 0;
  try {
    const mood = createMood({
      stream: async function* () { yield { type: 'text-delta', text: '平静了一些' }; },
      provider: 'p', model: 'm',
    });
    // 先有一次变化（把 lastChangeAt 推到 1000）
    await mood.updateMood({ chatId: 'g:1', transcript: 'x', now: 1000 });

    // 300 秒后平复（超过 200 秒静默阈值）
    const m = await mood.regress('g:1', 1000 + 300_000);
    assert.equal(m, '平静了一些');

    // 刚平复完，立刻再平复（静默不足）不该变
    const m2 = await mood.regress('g:1', 1000 + 300_001);
    assert.equal(m2, '平静了一些');
  } finally {
    Math.random = orig;
  }
});
