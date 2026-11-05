/**
 * 知识学习（learner）的测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLearner, parseFacts } from '../src/dsh/learner.mjs';

test('parseFacts：从 LLM 文本抠出 JSON 字符串数组', () => {
  assert.deepEqual(parseFacts('["事实1", "事实2"]'), ['事实1', '事实2']);
  assert.deepEqual(parseFacts('结果是 ["他在做 QQ 机器人"]，完了'), ['他在做 QQ 机器人']);
  assert.deepEqual(parseFacts('没有数组'), []);
  assert.deepEqual(parseFacts(''), []);
});

test('parseFacts：非字符串元素被过滤', () => {
  assert.deepEqual(parseFacts('["好的", 123, ""]'), ['好的']);
});

test('learn：内容无意义时不调 LLM、直接返回空', async () => {
  let called = false;
  const learner = createLearner({
    stream: async function* () { called = true; },
    provider: 'p', model: 'm',
  });
  const facts = await learner.learn({ userText: '打卡', assistantText: '在' });
  assert.deepEqual(facts, []);
  assert.equal(called, false, '无意义消息不该调 LLM');
});

test('learn：从一轮对话提炼事实', async () => {
  const learner = createLearner({
    stream: async function* () {
      yield { type: 'text-delta', text: '["他在做 QQ 机器人"]' };
    },
    provider: 'p', model: 'm',
  });
  const facts = await learner.learn({ userText: '我在做 QQ 机器人', assistantText: '有意思' });
  assert.deepEqual(facts, ['他在做 QQ 机器人']);
});

test('learn：LLM 抛异常时返回空、不炸', async () => {
  const learner = createLearner({
    stream: async function* () { throw new Error('模型挂了'); },
    provider: 'p', model: 'm',
  });
  const facts = await learner.learn({ userText: '我在做东西', assistantText: '好' });
  assert.deepEqual(facts, []);
});
