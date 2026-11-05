/**
 * 心情的**节奏与上下文**（2026-10-30 上配置页）。
 *
 * 用户原话：「这个心情模型会看到几条聊天记录？有上下文吗？冷却时间的间隔也请加到配置页上」。
 *
 * 这一组钉四件事：
 * 1. **概率曲线可配**（基础 / 每分钟加 / 上限）—— 默认与改动前逐字一致；
 * 2. **硬冷却**（`cooldownMinutes`）：不到时间连抽签都不抽；默认 0 = 关（改动前没有这一层）；
 * 3. **平复**（安静多久、最多几次）可配；
 * 4. **心情模型真的会看到多条聊天记录** —— 由网关把转录拼好传进来（这里验 mood 侧原样使用）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMood, moodUpdateProbability } from '../src/dsh/mood.mjs';

test('概率曲线：默认与改动前一致（0.1 起，每分钟 +0.1，封顶 0.5）', () => {
  assert.equal(moodUpdateProbability(0), 0.1);
  assert.equal(moodUpdateProbability(60_000), 0.2);
  assert.ok(Math.abs(moodUpdateProbability(120_000) - 0.3) < 1e-9, '两分钟 ≈ 0.3');
  assert.equal(moodUpdateProbability(10 * 60_000), 0.5, '封顶 0.5');
  assert.equal(moodUpdateProbability(-5), 0.1, '负数按 0 处理');
});

test('概率曲线：三个系数可配', () => {
  assert.equal(moodUpdateProbability(0, { base: 0.05 }), 0.05);
  assert.equal(moodUpdateProbability(60_000, { base: 0, perMinute: 0.5 }), 0.5);
  assert.equal(moodUpdateProbability(60_000, { base: 0.9, max: 0.2 }), 0.2, '上限压得住基础值');
});

test('硬冷却：不到时间连请求都不发（默认 0 = 不冷却）', async () => {
  const orig = Math.random;
  Math.random = () => 0; // 永远"抽中"，好让概率不干扰
  try {
    let calls = 0;
    const mood = createMood({
      stream: async function* () { calls += 1; yield { type: 'text-delta', text: '有点开心' }; },
      provider: 'p', model: 'm',
      cooldownMinutes: 10,
    });
    // 第一次（只要 try 过就必中一次）
    await mood.updateMood({ chatId: 'g:1', transcript: 'x', now: 1_000_000 });
    assert.equal(calls, 1);
    // 5 分钟后：冷却里 ⇒ 不发请求
    await mood.updateMood({ chatId: 'g:1', transcript: 'x', now: 1_000_000 + 5 * 60_000 });
    assert.equal(calls, 1, '冷却期内不该再发');
    // 11 分钟后：过冷却 ⇒ 又发
    await mood.updateMood({ chatId: 'g:1', transcript: 'x', now: 1_000_000 + 11 * 60_000 });
    assert.equal(calls, 2);
  } finally {
    Math.random = orig;
  }
});

test('硬冷却 = 0（默认）：与改动前一样，只看概率', async () => {
  const orig = Math.random;
  Math.random = () => 0;
  try {
    let calls = 0;
    const mood = createMood({
      stream: async function* () { calls += 1; yield { type: 'text-delta', text: '还行' }; },
      provider: 'p', model: 'm',
    });
    await mood.updateMood({ chatId: 'g:1', transcript: 'x', now: 1_000 });
    await mood.updateMood({ chatId: 'g:1', transcript: 'x', now: 2_000 });
    assert.equal(calls, 2, '没有硬冷却时，立刻抽中就会立刻更新');
  } finally {
    Math.random = orig;
  }
});

test('平复：安静秒数与次数都可配', async () => {
  const orig = Math.random;
  Math.random = () => 0;
  try {
    const mood = createMood({
      stream: async function* () { yield { type: 'text-delta', text: '平复了' }; },
      provider: 'p', model: 'm',
      regressAfterSeconds: 10,
      regressMax: 1,
    });
    await mood.updateMood({ chatId: 'g:1', transcript: 'x', now: 1_000 });
    // 11 秒后够安静 ⇒ 平复一次
    assert.equal(await mood.regress('g:1', 1_000 + 11_000), '平复了');
    // 再安静也不平复（上限 1）—— 维持当前值
    assert.equal(await mood.regress('g:1', 1_000 + 999_000), '平复了');
  } finally {
    Math.random = orig;
  }
});

test('心情模型真的读得到多条聊天记录（转录原样进提示词）', async () => {
  let captured = '';
  const mood = createMood({
    stream: async function* (opts) {
      captured = String(opts?.messages?.[0]?.content?.[0]?.text ?? '');
      yield { type: 'text-delta', text: '看得更明白了' };
    },
    provider: 'p', model: 'm',
    emotionStyle: '傲娇',
  });
  const transcript = [
    '[10-03 14:30 张三(100)] 在吗',
    '[10-03 14:31 李四(101)] 他不在',
    '[10-03 14:32 张三(100)] 那算了',
  ].join('\n');
  await mood.updateMood({ chatId: 'g:1', transcript, now: 1_000 });
  for (const line of ['张三', '李四', '那算了']) {
    assert.ok(captured.includes(line), `提示词里应该有「${line}」`);
  }
  assert.ok(captured.includes('你的情绪特点是：傲娇'), '情绪特征要跟着进提示词');
});
