/**
 * 记忆写入的三道闸门（治源头）。
 *
 * 用户 2026-10-05：「这块反正别学 MaiBot 了，**屎山就是他累积起来的**」
 * 「我不知道现在增添记忆的规则是什么，但是**源头得把控好**」
 * 「推测也是有用的」→ 所以推测**留着但必须标**。
 *
 * 之前的问题（实测过，有数字）：
 * - MaiBot 的 `relation.py` 用无上限 `append` 累积 → 有人被记 1,321 条 / 12.9 万字；
 * - 我们的 `remember` 去重是**精确匹配**（`includes`）→「他喜欢深夜调试」和
 *   「他喜欢在深夜调试」算两条；
 * - `learner` 抽取时**不知道已经记过什么** → 同一件事反复记；
 * - 记忆点**没有来源标记** → 模型的推测和事实混在一起（人家那份 82% 是推测）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KnowledgeBase, ORIGIN, similarity } from '../src/dsh/knowledge.mjs';
import { createLearner, parseFacts } from '../src/dsh/learner.mjs';

// ── similarity ──

test('similarity：改一个字的句子算"很像"', () => {
  const s = similarity('他喜欢深夜调试', '他喜欢在深夜调试');
  // 6 个 bigram vs 7 个，共有 5 个 → Jaccard = 5/8 = 0.625
  // （第一版我把期望写成 >0.7，是我的期望错了，不是实现错了）
  assert.ok(s >= 0.6, `应该比较像，实际 ${s}`);
  assert.ok(s < 1, '但不是完全相同');
});

test('similarity：只差空白/标点 → 归一化后算完全相同', () => {
  // 这一条是"归一化"存在的理由：不做的话，"只差一个空格"会掉到阈值以下，
  // 于是同一件事被记两遍 —— 而那正是我们要堵的路。
  assert.equal(similarity('[事实] 他在做 QQ 机器人', '[事实] 他在做QQ机器人'), 1);
  assert.equal(similarity('他说：你好', '他说你好'), 1);
  assert.equal(similarity('ABC', 'abc'), 1, '大小写也该归一');
});

test('similarity：完全不同的句子分很低', () => {
  const s = similarity('他喜欢深夜调试', '群里在聊第五人格');
  assert.ok(s < 0.2, `应该很低，实际 ${s}`);
});

test('similarity：边界（空串 / 完全相同 / 单字）', () => {
  assert.equal(similarity('', 'x'), 0);
  assert.equal(similarity('x', ''), 0);
  assert.equal(similarity('一样的话', '一样的话'), 1);
  assert.ok(similarity('猫', '猫') === 1);
  assert.ok(similarity('猫', '狗') >= 0 && similarity('猫', '狗') <= 1);
});

// ── remember：闸门 1（相似度去重）──

test('★ 闸门1：措辞不同但意思相同 → 不重复记', () => {
  const kb = new KnowledgeBase();
  assert.equal(kb.remember('u1', '[事实] 他在做 QQ 机器人'), true, '第一条该记下');
  // 精确匹配时代，这条会被当成新记忆记进去
  const again = kb.remember('u1', '[事实] 他在做QQ机器人');
  assert.equal(again, false, '只差一个空格，该判重');
  assert.equal(kb.factsFor('u1').length, 1, `应该只有 1 条，实际 ${kb.factsFor('u1').length}`);
});

test('闸门1：确实不同的两件事都要记', () => {
  const kb = new KnowledgeBase();
  kb.remember('u1', '[事实] 他在做 QQ 机器人');
  kb.remember('u1', '[事实] 他养了一只叫年糕的猫');
  assert.equal(kb.factsFor('u1').length, 2);
});

// ── remember：闸门 2（上限，优先淘汰推测）──

test('★ 闸门2：超过上限时，先淘汰推测、保留事实', () => {
  const kb = new KnowledgeBase();
  kb.remember('u1', `${ORIGIN.GUESS} 他可能喜欢猫`);
  kb.remember('u1', `${ORIGIN.FACT} 事实A`);
  kb.remember('u1', `${ORIGIN.FACT} 事实B`);
  // 上限设 2 → 应该丢掉那条推测，留下两条事实
  kb.remember('u1', `${ORIGIN.FACT} 事实C`, { maxPerPerson: 2 });
  const facts = kb.factsFor('u1');
  assert.equal(facts.length, 2, `该截到 2 条，实际 ${facts.length}`);
  assert.ok(
    facts.every((f) => f.startsWith(ORIGIN.FACT)),
    `该全是事实，实际：${JSON.stringify(facts)}`,
  );
});

test('闸门2：全是推测时，淘汰最旧的', () => {
  const kb = new KnowledgeBase();
  kb.remember('u1', `${ORIGIN.GUESS} 推测一`);
  kb.remember('u1', `${ORIGIN.GUESS} 推测二`);
  kb.remember('u1', `${ORIGIN.GUESS} 推测三`, { maxPerPerson: 2 });
  const facts = kb.factsFor('u1');
  assert.equal(facts.length, 2);
  assert.ok(!facts.includes(`${ORIGIN.GUESS} 推测一`), '最旧的那条该被淘汰');
});

// ── remember：闸门 3（来源标注）──

test('★ 闸门3：没标来源的自动当[事实]，标了的原样保留', () => {
  const kb = new KnowledgeBase();
  kb.remember('u1', '没标来源的句子');
  kb.remember('u1', `${ORIGIN.GUESS} 标了推测的句子`);
  const facts = kb.factsFor('u1');
  assert.ok(facts[0].startsWith(ORIGIN.FACT), `没标的该被补上事实标记：${facts[0]}`);
  assert.ok(facts[1].startsWith(ORIGIN.GUESS), '标了推测的不该被改');
});

test('remember：空输入不记', () => {
  const kb = new KnowledgeBase();
  assert.equal(kb.remember('', 'x'), false);
  assert.equal(kb.remember('u1', '   '), false);
  assert.equal(kb.factsFor('u1').length, 0);
});

test('remember：不认识的人自动建画像', () => {
  const kb = new KnowledgeBase();
  kb.remember('u-new', '[事实] 新来的');
  assert.equal(kb.personInfo.length, 1);
  assert.equal(kb.personInfo[0].user_id, 'u-new');
});

// ── factsFor（给 learner 的输入）──

test('★ factsFor：把已有记忆交出去（这是"不重复记"的前提）', () => {
  const kb = new KnowledgeBase();
  kb.remember('u1', '[事实] 甲');
  kb.remember('u1', '[事实] 乙');
  assert.deepEqual(kb.factsFor('u1'), ['[事实] 甲', '[事实] 乙']);
  assert.deepEqual(kb.factsFor('不存在的人'), []);
});

test('factsFor：存量数据那种"空 memory"要安全处理', () => {
  const kb = new KnowledgeBase({ personInfo: [{ user_id: 'u1', nickname: '甲', memory: '' }] });
  assert.deepEqual(kb.factsFor('u1'), []);
  const kb2 = new KnowledgeBase({ personInfo: [{ user_id: 'u2', nickname: '乙' }] });
  assert.deepEqual(kb2.factsFor('u2'), []);
});

// ── learner 提示词 ──

/** 造一个假 stream：记录 prompt，返回固定内容。 */
function fakeStream(reply) {
  const calls = [];
  const stream = (opts) => {
    calls.push(opts);
    return (async function* gen() {
      yield { type: 'text-delta', text: reply };
    })();
  };
  return { stream, calls };
}

test('★ learner：提示词里出现"已经记过"，且带上已有记忆原文', async () => {
  const { stream, calls } = fakeStream('[]');
  const learner = createLearner({ stream, provider: 'p', model: 'm' });
  await learner.learn({
    userText: '我最近在调一个机器人',
    assistantText: '哦？',
    knownFacts: ['[事实] 他在做 QQ 机器人', '[推测] 他偏好深夜工作'],
  });
  const prompt = calls[0].messages[0].content[0].text;
  assert.match(prompt, /已经记过/, '该有"不要重复记"的提示');
  assert.ok(prompt.includes('他在做 QQ 机器人'), '该把已有记忆原文喂进去');
  assert.ok(prompt.includes('他偏好深夜工作'));
});

test('★ learner：提示词要求标来源，且"拿不准就标推测"', async () => {
  const { stream, calls } = fakeStream('[]');
  const learner = createLearner({ stream, provider: 'p', model: 'm' });
  await learner.learn({ userText: '随便说说', assistantText: '嗯' });
  const prompt = calls[0].messages[0].content[0].text;
  assert.ok(prompt.includes(ORIGIN.FACT), '该说明 [事实] 的含义');
  assert.ok(prompt.includes(ORIGIN.GUESS), '该说明 [推测] 的含义');
  assert.match(prompt, /宁可标推测/, '该要求"拿不准就标推测"');
});

test('learner：没有已知记忆时不出现"已经记过"那段', async () => {
  const { stream, calls } = fakeStream('[]');
  const learner = createLearner({ stream, provider: 'p', model: 'm' });
  await learner.learn({ userText: '你好', assistantText: '在' });
  const prompt = calls[0].messages[0].content[0].text;
  assert.ok(!prompt.includes('已经记过'), '没有已知记忆时不该出现那一段');
});

test('learner：knownFacts 只取最近 N 条（提示词不能无限长）', async () => {
  const { stream, calls } = fakeStream('[]');
  const learner = createLearner({ stream, provider: 'p', model: 'm', maxKnownFacts: 3 });
  await learner.learn({
    // ⚠️ 输入得是"有意义的话" —— 写 `'x'` 会被内容过滤器拦掉，
    // stream 压根不会被调用，于是断言看到的是一段空字符串（实测踩过）。
    userText: '我最近在调一个 QQ 机器人，想让它记住我说过的话',
    assistantText: '哦？',
    knownFacts: ['A1', 'A2', 'A3', 'A4', 'A5'],
  });
  assert.equal(calls.length, 1, '应该发起了一次调用');
  const prompt = calls[0].messages[0].content[0].text;
  assert.ok(prompt.includes('A5'), '该留下最新的');
  assert.ok(!prompt.includes('A1'), '该丢掉最旧的');
});

test('learner：无意义的话不抽（原有行为不能坏）', async () => {
  const { stream, calls } = fakeStream('["[事实] 不该出现"]');
  const learner = createLearner({ stream, provider: 'p', model: 'm' });
  const out = await learner.learn({ userText: '打卡', assistantText: '' });
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0, '压根不该发起调用');
});

test('parseFacts：抠 JSON 的老行为不变', () => {
  assert.deepEqual(parseFacts('["[事实] a","[推测] b"]'), ['[事实] a', '[推测] b']);
  assert.deepEqual(parseFacts('前言 ["x"] 后语'), ['x']);
  assert.deepEqual(parseFacts('没有数组'), []);
  assert.deepEqual(parseFacts('[]'), []);
});
