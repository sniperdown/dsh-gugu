/**
 * 工作汇报文案的测试。
 *
 * 汇报是"群里的同事唯一看到的东西"，所以重点在：
 * - 不能把长长的模型回复整段搬进群（刷屏）
 * - 失败/中止也要报（"我卡住了"恰恰是群里最该知道的）
 * - 事件畸形时不炸
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkReport,
  collectToolUsage,
  lastAssistantTextOfTurn,
  firstSentence,
  shortId,
} from '../src/dsh/report.mjs';

/** 造一条 tool/call 事件。 */
const toolCall = (turn, name, step = 0) => ({
  type: 'tool/call',
  seq: 0,
  time: 0,
  data: { turn, step, callId: `c${step}`, name, arguments: '{}' },
});

/** 造一条 assistant/message 事件。 */
const assistant = (turn, text, step = 0) => ({
  type: 'assistant/message',
  seq: 0,
  time: 0,
  data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [] },
});

const turnEnd = (turn, kind = 'completed') => ({
  type: 'turn/end',
  seq: 0,
  time: 0,
  data: { turn, reason: { kind } },
});

// ---------------------------------------------------------------- 工具统计

test('collectToolUsage：按名称聚合次数，只算指定轮次', () => {
  const events = [
    toolCall(1, 'read'),
    toolCall(1, 'read'),
    toolCall(1, 'pwsh'),
    toolCall(2, 'write'),
  ];
  const counts = collectToolUsage(events, 1);
  assert.equal(counts.get('read'), 2);
  assert.equal(counts.get('pwsh'), 1);
  assert.equal(counts.has('write'), false, '别的轮次不该算进来');
});

test('collectToolUsage：畸形事件安全跳过', () => {
  const events = [null, 'x', 42, {}, { type: 'tool/call' }, { type: 'tool/call', data: {} }, toolCall(1, 'read')];
  const counts = collectToolUsage(events, 1);
  assert.equal(counts.get('read'), 1);
  assert.equal(counts.size, 1);
});

test('collectToolUsage：turn 省略时统计全部轮次', () => {
  const counts = collectToolUsage([toolCall(1, 'read'), toolCall(2, 'read')]);
  assert.equal(counts.get('read'), 2);
});

// ---------------------------------------------------------------- 结论提取

test('lastAssistantTextOfTurn：取该轮最后一条非空助手文本', () => {
  const events = [assistant(1, '第一次'), assistant(1, '最终结论')];
  assert.equal(lastAssistantTextOfTurn(events, 1), '最终结论');
});

test('lastAssistantTextOfTurn：只取指定轮次', () => {
  const events = [assistant(1, '第一轮'), assistant(2, '第二轮')];
  assert.equal(lastAssistantTextOfTurn(events, 1), '第一轮');
});

test('lastAssistantTextOfTurn：跳过只有 reasoning 的助手消息', () => {
  const events = [
    assistant(1, '有文本'),
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: '思考' }] } } },
  ];
  assert.equal(lastAssistantTextOfTurn(events, 1), '有文本');
});

test('lastAssistantTextOfTurn：没有时返回空串', () => {
  assert.equal(lastAssistantTextOfTurn([], 1), '');
  assert.equal(lastAssistantTextOfTurn([toolCall(1, 'read')], 1), '');
});

// ---------------------------------------------------------------- 首句提取

test('firstSentence：取首个非空行的第一句', () => {
  assert.equal(firstSentence('第一句。第二句。'), '第一句。');
  assert.equal(firstSentence('\n\n  开头这句话。后面还有'), '开头这句话。');
});

test('firstSentence：剥掉 markdown 装饰', () => {
  assert.equal(firstSentence('## 标题式结论'), '标题式结论');
  assert.equal(firstSentence('- 列表式的第一项。'), '列表式的第一项。');
  assert.equal(firstSentence('> 引用的结论。'), '引用的结论。');
});

test('firstSentence：没有句末标点时取整行', () => {
  assert.equal(firstSentence('没有标点的一行'), '没有标点的一行');
});

test('firstSentence：超长时按码点截断', () => {
  const long = '很'.repeat(200);
  const out = firstSentence(long, 20);
  assert.equal(Array.from(out).length, 20);
  assert.ok(out.endsWith('…'));
});

test('firstSentence：空输入返回空串', () => {
  for (const bad of ['', '   ', '\n\n', null, undefined]) {
    assert.equal(firstSentence(bad), '');
  }
});

// ---------------------------------------------------------------- 整段汇报

test('buildWorkReport：包含会话、轮次、结果、动作、结论', () => {
  const events = [
    toolCall(3, 'read'),
    toolCall(3, 'grep'),
    toolCall(3, 'grep'),
    assistant(3, '修好了那个 bug。细节见 patch。'),
    turnEnd(3, 'completed'),
  ];
  const text = buildWorkReport({
    events,
    turn: 3,
    sessionId: 'session-abcdef123456',
    reason: { kind: 'completed' },
  });
  assert.match(text, /abcdef12/, '应含会话短 id');
  assert.match(text, /第 3 轮/);
  assert.match(text, /完成/);
  assert.match(text, /读文件/);
  assert.match(text, /搜代码×2/, '重复工具应聚合');
  assert.match(text, /结论：修好了那个 bug。/);
});

test('buildWorkReport：不把整段模型回复搬进来（只取首句）', () => {
  const long = `结论一句话。\n\n${'废话'.repeat(500)}`;
  const text = buildWorkReport({
    events: [assistant(1, long), turnEnd(1), toolCall(1, 'read')],
    turn: 1,
    sessionId: 'session-x',
    reason: { kind: 'completed' },
  });
  assert.ok(text.length < 200, `不该很长，实际 ${text.length}`);
  assert.equal(text.includes('废话'), false, '后续段落不该出现');
});

test('buildWorkReport：中止与出错也要报（这是群里最该知道的）', () => {
  for (const [kind, expect] of [
    ['aborted', /被中止/],
    ['error', /出错/],
    ['max-tokens', /撞到输出上限/],
    ['interrupted', /被打断/],
  ]) {
    const text = buildWorkReport({
      events: [toolCall(1, 'read'), turnEnd(1, kind)],
      turn: 1,
      sessionId: 'session-1',
      reason: { kind },
    });
    assert.match(text, expect, `kind=${kind}`);
  }
});

test('buildWorkReport：没有工具也没有结论时返回空串（不报空话）', () => {
  const text = buildWorkReport({ events: [turnEnd(1)], turn: 1, sessionId: 's', reason: { kind: 'completed' } });
  assert.equal(text, '');
});

test('buildWorkReport：只有工具没结论也能报（做了事但没总结）', () => {
  const text = buildWorkReport({
    events: [toolCall(1, 'write'), turnEnd(1)],
    turn: 1,
    sessionId: 's',
    reason: { kind: 'completed' },
  });
  assert.match(text, /写文件/);
});

test('buildWorkReport：未知工具名原样显示，不丢信息', () => {
  const text = buildWorkReport({
    events: [toolCall(1, 'some_new_tool'), turnEnd(1)],
    turn: 1,
    sessionId: 's',
    reason: { kind: 'completed' },
  });
  assert.match(text, /some_new_tool/);
});

test('buildWorkReport：未知结束原因原样显示', () => {
  const text = buildWorkReport({
    events: [toolCall(1, 'read'), turnEnd(1, 'weird_reason')],
    turn: 1,
    sessionId: 's',
    reason: { kind: 'weird_reason' },
  });
  assert.match(text, /weird_reason/);
});

test('buildWorkReport：整段受 maxChars 限制', () => {
  const events = [
    ...Array.from({ length: 30 }, (_, i) => toolCall(1, `tool_${i}`)),
    assistant(1, '结论'),
    turnEnd(1),
  ];
  const text = buildWorkReport({
    events,
    turn: 1,
    sessionId: 'session-abc',
    reason: { kind: 'completed' },
    maxChars: 80,
  });
  assert.ok(Array.from(text).length <= 80, `实际 ${Array.from(text).length}`);
});

test('buildWorkReport：missing sessionId 时也能出一段可读文本', () => {
  const text = buildWorkReport({
    events: [toolCall(1, 'read'), turnEnd(1)],
    turn: 1,
    reason: { kind: 'completed' },
  });
  assert.match(text, /第 1 轮/);
});

test('buildWorkReport：events 畸形/缺失时返回空串而不是抛异常', () => {
  for (const bad of [undefined, null, 'x', {}, 42]) {
    assert.equal(buildWorkReport({ events: bad, turn: 1, sessionId: 's', reason: { kind: 'completed' } }), '');
  }
  assert.equal(buildWorkReport({ events: [], turn: 1, sessionId: 's', reason: { kind: 'completed' } }), '');
});

test('shortId：剥掉 session- 前缀后取前 8 位（否则群里区分不出会话）', () => {
  // 回归：DSH 的会话 id 统一是 `session-<uuid>`，直接截前 8 位只会得到
  // 一模一样的 `session-`，在群里毫无区分度。
  assert.equal(shortId('session-abcdef123456'), 'abcdef12');
  assert.equal(shortId('session-11111111-2222-3333'), '11111111');
  // 不是 session- 前缀的照样截断。
  assert.equal(shortId('abcdefghijkl'), 'abcdefgh');
  assert.equal(shortId('abc'), 'abc');
  assert.equal(shortId('qq-group-100'), 'qq-group');
  // 边界：剥完前缀为空时回退成原串，而不是给一个空标签。
  assert.equal(shortId('session-'), 'session-');
  assert.equal(shortId('session'), 'session');
  assert.equal(shortId(''), '');
  assert.equal(shortId(null), '');
  assert.equal(shortId(undefined), '');
});
