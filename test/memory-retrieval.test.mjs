/**
 * "导出限量"的测试（用户 2026-10-05 要求）。
 *
 * 用户原话：
 * > 储存管够的，写入多一点我觉得问题不大，主要**导出如果每次都把对象所有的记忆全导出
 * > 有点蠢了**，2 是得做
 *
 * 背景（实测数字）：`retrieve` 原来把发言人的**整串记忆**塞进 prompt，
 * 最重的一个人 5,559 字符 ≈ 3,706 token，**每次他说话都要付**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KnowledgeBase, pickRelevantPoints } from '../src/dsh/knowledge.mjs';

const P = (s) => `[事实] ${s}`;

test('★ 相关性：聊机器人的时候，机器人那条排前面', () => {
  const memory = [
    P('他养了一只叫年糕的猫，是橘猫'),
    P('他在做 QQ 机器人，用的是 DSH 框架'),
    P('他喜欢在深夜调试代码'),
    P('他昨天去吃了火锅'),
  ].join('；');
  const out = pickRelevantPoints(memory, '我的 QQ 机器人又崩了，DSH 那边报错', { maxChars: 200 });
  assert.ok(out.includes('机器人'), `该挑出机器人那条，实际：${out}`);
});

test('★ 相关性：聊猫的时候挑猫那条', () => {
  const memory = [
    P('他养了一只叫年糕的猫，是橘猫'),
    P('他在做 QQ 机器人，用的是 DSH 框架'),
  ].join('；');
  const out = pickRelevantPoints(memory, '我家年糕今天不吃饭', { maxChars: 200 });
  assert.ok(out.includes('年糕'), `该挑出猫那条，实际：${out}`);
});

test('★ 总量封顶：不管原来多长，输出不超过 maxChars', () => {
  const memory = Array.from({ length: 40 }, (_, i) => P(`这是第 ${i} 条比较长的记忆内容，用来把总量撑起来，确保触发封顶逻辑`)).join('；');
  const out = pickRelevantPoints(memory, '随便说点什么', { maxChars: 300 });
  assert.ok(out.length <= 300, `该封顶到 300 字，实际 ${out.length}`);
  assert.ok(out.length > 0, '但不该是空的');
});

test('★ 兜底：完全不相干的话题，也要给几条（不能"不认识"这个人）', () => {
  const memory = [
    P('他养了一只叫年糕的猫'),
    P('他在做 QQ 机器人'),
    P('他喜欢在深夜调试代码'),
    P('他昨天去吃了火锅'),
  ].join('；');
  const out = pickRelevantPoints(memory, 'zzzzz', { minPoints: 2 });
  assert.ok(out !== '', '不该返回空 —— 那样小鲸鱼会完全不认识他');
  const n = out.split('；').filter((s) => s.trim() !== '').length;
  assert.ok(n >= 2, `至少给 2 条，实际 ${n}`);
});

test('兜底优先给"较新的"（越靠后越新）', () => {
  const memory = [P('最旧的'), P('中间的'), P('最新的')].join('；');
  const out = pickRelevantPoints(memory, 'zzzzz', { minPoints: 1, maxChars: 60 });
  assert.ok(out.includes('最新的'), `该优先给最新的，实际：${out}`);
});

test('输出按原始顺序排（读起来自然）', () => {
  const memory = [P('第一条关于猫'), P('第二条关于机器人'), P('第三条关于猫和机器人')].join('；');
  const out = pickRelevantPoints(memory, '猫 机器人', { maxChars: 300 });
  const idx1 = out.indexOf('第一条');
  const idx3 = out.indexOf('第三条');
  if (idx1 >= 0 && idx3 >= 0) assert.ok(idx1 < idx3, '该保持原顺序');
});

test('边界：空记忆 / 空查询 / 单条', () => {
  assert.equal(pickRelevantPoints('', 'x'), '');
  assert.equal(pickRelevantPoints('   ', 'x'), '');
  assert.equal(pickRelevantPoints(P('只有一条'), ''), P('只有一条'), '空查询时至少给兜底');
  assert.equal(pickRelevantPoints(P('只有一条'), 'x'), P('只有一条'));
});

test('边界：记忆串里有空段（分号连着）不该崩', () => {
  const memory = `${P('甲')}；；${P('乙')}；`;
  const out = pickRelevantPoints(memory, '甲', { maxChars: 200 });
  assert.ok(out.includes('甲'));
  assert.ok(!out.includes('；；'), '不该出现连续分号');
});

// ── 集成：retrieve 用上它 ──

test('★ retrieve：发言人画像现在被限量了', () => {
  const person = {
    user_id: 'u1',
    nickname: '甲',
    memory: Array.from({ length: 40 }, (_, i) => P(`第 ${i} 条撑长度的记忆内容，随便写点什么让总量够大`)).join('；'),
  };
  const kb = new KnowledgeBase({ personInfo: [person] });
  const items = kb.retrieve({ text: '随便', userId: 'u1', topK: 3 });
  const p = items.find((x) => x.type === 'person');
  assert.ok(p !== undefined, '该有画像那条');
  assert.ok(p.memory.length <= 1200, `默认该封顶 1200，实际 ${p.memory.length}`);
});

test('retrieve：maxPersonChars 可调', () => {
  const person = {
    user_id: 'u1',
    nickname: '甲',
    memory: Array.from({ length: 40 }, (_, i) => P(`第 ${i} 条撑长度的记忆内容，随便写点什么让总量够大`)).join('；'),
  };
  const kb = new KnowledgeBase({ personInfo: [person] });
  const items = kb.retrieve({ text: '随便', userId: 'u1', maxPersonChars: 300 });
  const p = items.find((x) => x.type === 'person');
  assert.ok(p.memory.length <= 300, `该封顶 300，实际 ${p.memory.length}`);
});

test('retrieve：画像为空的人不产生条目', () => {
  const kb = new KnowledgeBase({ personInfo: [{ user_id: 'u1', nickname: '甲', memory: '' }] });
  const items = kb.retrieve({ text: '随便', userId: 'u1', topK: 3 });
  assert.equal(items.filter((x) => x.type === 'person').length, 0);
});

test('retrieve：graph_nodes 那部分行为没变', () => {
  const kb = new KnowledgeBase({
    graphNodes: [{ concept: '第五人格', memory: '一个游戏' }],
    personInfo: [],
  });
  const items = kb.retrieve({ text: '我在玩第五人格', topK: 3 });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'concept');
});
