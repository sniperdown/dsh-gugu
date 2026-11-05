/**
 * 检索排序的测试（2026-10-05 修的"扫描顺序"问题）。
 *
 * 背景：`retrieve` 原来是"边扫边 push，收满 topK*2 就 break"——
 * **按数组顺序决定谁入选**，谁排在前面谁赢，跟"哪个更贴切"无关。
 *
 * 实测过的后果：通用词排在前面（活动@5、系统@7），具体条目排在后面（八周年@385），
 * 于是聊"八周年活动"时「活动」先把名额占掉，**「八周年」永远拿不到槽位**。
 *
 * 修法：先收集全部命中，再按 concept 长度（具体度代理）降序取前几条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KnowledgeBase } from '../src/dsh/knowledge.mjs';

/** 造一个图节点。 */
const N = (concept, memory) => ({ concept, memory });

test('★ 具体的长概念要赢过靠前的短概念', () => {
  // 故意把"短且靠前"的放在数组前面 —— 这是修复前的失败场景
  const kb = new KnowledgeBase({
    graphNodes: [
      N('活动', '这是一段关于各种活动的泛泛介绍'),
      N('系统', '这是一段关于系统的泛泛介绍'),
      N('八周年', '八周年活动的完整介绍：时间是…'),
    ],
  });
  const r = kb.retrieve({ text: '八周年活动什么时候开始', topK: 1 });
  assert.equal(r.length, 1);
  assert.equal(r[0].name, '八周年', `该选中「八周年」，实际「${r[0].name}」`);
});

test('★ 第五人格的场景：「第五」不该盖过「第五人格」', () => {
  const kb = new KnowledgeBase({
    graphNodes: [
      N('第五', '关于第五这个片段的内容'),
      N('第五人格', '关于第五人格这款游戏的完整介绍'),
    ],
  });
  const r = kb.retrieve({ text: '第五人格怎么玩', topK: 1 });
  assert.equal(r[0].name, '第五人格');
});

test('排序后仍受 topK 限制', () => {
  const kb = new KnowledgeBase({
    graphNodes: [N('甲甲', 'a'), N('乙乙乙', 'b'), N('丙丙丙丙', 'c')],
  });
  const r = kb.retrieve({ text: '甲甲 乙乙乙 丙丙丙丙', topK: 2 });
  assert.equal(r.length, 2);
  assert.equal(r[0].name, '丙丙丙丙', '最长的该排第一');
  assert.equal(r[1].name, '乙乙乙');
});

test('长度相同时保持原数组顺序（稳定排序）', () => {
  const kb = new KnowledgeBase({
    graphNodes: [N('甲甲', '第一条'), N('乙乙', '第二条')],
  });
  const r = kb.retrieve({ text: '甲甲乙乙', topK: 2 });
  assert.deepEqual(r.map((x) => x.name), ['甲甲', '乙乙']);
});

test('单字概念仍被跳过', () => {
  const kb = new KnowledgeBase({ graphNodes: [N('中', '单字概念')] });
  assert.equal(kb.retrieve({ text: '中间的中', topK: 2 }).length, 0);
});

test('没命中的时候返回空', () => {
  const kb = new KnowledgeBase({ graphNodes: [N('甲甲', 'x')] });
  assert.deepEqual(kb.retrieve({ text: '完全无关的话', topK: 2 }), []);
});

test('memory 为空的节点不参与', () => {
  const kb = new KnowledgeBase({ graphNodes: [N('甲甲', '')] });
  assert.equal(kb.retrieve({ text: '甲甲', topK: 2 }).length, 0);
});

test('发言人画像仍排在概念前面（原有行为没坏）', () => {
  const kb = new KnowledgeBase({
    personInfo: [{ user_id: 'u1', nickname: '甲', memory: '[事实] 他在调机器人' }],
    graphNodes: [N('机器人', '一段很长的关于机器人的概念介绍文字')],
  });
  const r = kb.retrieve({ text: '机器人在调', userId: 'u1', topK: 2 });
  assert.equal(r[0].type, 'person', '画像该在最前');
  assert.equal(r[1].type, 'concept');
});

test('按 memory 去重（同正文的两个概念只出一条）', () => {
  const kb = new KnowledgeBase({
    graphNodes: [N('甲甲甲', '同一段正文'), N('乙乙乙', '同一段正文')],
  });
  const r = kb.retrieve({ text: '甲甲甲乙乙乙', topK: 2 });
  assert.equal(r.length, 1, '同正文该只留一条');
});
