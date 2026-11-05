/**
 * 「语境 → 候选桶」先验的守门测试（`src/dsh/sticker-context.mjs`）。
 *
 * 这组盯三件事：
 *
 * 1. **lift 数字是从哪来的、有没有被手改**（表里每个数都能在
 *    `shared/表情包-2026-10-08/emoji2-context.txt` 的 §4.3 逐条对上；这里抽样钉死）；
 * 2. **纯函数**的契约：给文本 → 2~4 个候选桶；认不出就**如实**返回空（严格版）；
 * 3. **它绝不"挑"**：不查库、不随机、不发消息 —— 只有一个纯函数和几张冻结的表。
 *    （同一族的守门断言在 `sticker-library.test.mjs` 里是"库没有 pick/random"。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASELINE_BUCKETS,
  BASELINE_SHARE,
  CONTEXT_PRIORS,
  CONTEXT_PRIOR_MIN_LIFT,
  CONTEXT_WITHOUT_SIGNAL,
  candidatesForContext,
  contextCandidates,
  matchedContexts,
} from '../src/dsh/sticker-context.mjs';
import { STICKER_TAGS, isStickerTag } from '../src/dsh/sticker-tags.mjs';

// ------------------------------------------------------------------ 表本身

test('★★ lift 表：10 个有信号的语境，数字与 `emoji2-context.txt` §4.3 一致', () => {
  assert.equal(CONTEXT_PRIORS.length, 10);
  assert.equal(CONTEXT_PRIOR_MIN_LIFT, 1.4);
  const byId = Object.fromEntries(CONTEXT_PRIORS.map((c) => [c.id, c]));

  // 最强的那一条（报告原话：「看不懂 → 困惑不解，几乎没有例外」）
  assert.deepEqual(
    byId['困惑/看不懂'].buckets.map((b) => [b.tag, b.lift]),
    [['困惑不解', 4.14], ['生气不满', 1.91], ['无语无奈', 1.88], ['尴尬社死', 1.71], ['吃瓜围观', 1.42]],
  );
  // 无语与尴尬是**两个桶**，别合并
  assert.deepEqual(
    byId['无语/无奈/尴尬'].buckets.slice(0, 2).map((b) => [b.tag, b.lift]),
    [['无语无奈', 3.30], ['尴尬社死', 2.75]],
  );
  assert.deepEqual(
    byId['震惊/意外/离谱'].buckets.slice(0, 3).map((b) => [b.tag, b.lift]),
    [['震惊惊讶', 2.87], ['困惑不解', 2.03], ['吃瓜围观', 1.99]],
  );
  // 对方负面情绪：报告特意点明"小鲸鱼实测行为是常用『无语无奈』回应低落，而不是『难过不安』"
  assert.deepEqual(
    byId['对方负面情绪/求安慰'].buckets.map((b) => [b.tag, b.lift]),
    [['难过不安', 2.50], ['无语无奈', 2.20], ['生气不满', 1.92], ['尴尬社死', 1.63]],
  );
  // 吃瓜：干净的一条（只有一个桶）
  assert.deepEqual(byId['吃瓜/围观/看戏'].buckets.map((b) => [b.tag, b.lift]), [['吃瓜围观', 2.90]]);
  // 问候：偏暖心/萌，不是"社交互动"
  assert.deepEqual(
    byId['打招呼/问候/祝福'].buckets.slice(0, 2).map((b) => [b.tag, b.lift]),
    [['治愈陪伴', 2.84], ['社交互动', 2.02]],
  );
  // 可爱簇三桶同时被抬（区分度最低的一组，报告点名"挑不准先怀疑这里"）
  assert.deepEqual(
    byId['可爱/萌/亲密/喜欢'].buckets.map((b) => [b.tag, b.lift]),
    [['害羞心动', 2.00], ['卖萌可爱', 1.94], ['治愈陪伴', 1.65]],
  );
});

test('★ 表里的桶名全是枚举值，且 lift 都 ≥ 阈值（别把 1.4 以下的塞进来）', () => {
  for (const ctx of CONTEXT_PRIORS) {
    assert.ok(ctx.keywords.length > 0, `${ctx.id} 没有关键词就没法命中`);
    for (const kw of ctx.keywords) assert.equal(typeof kw === 'string' && kw !== '', true);
    for (const b of ctx.buckets) {
      assert.equal(isStickerTag(b.tag), true, `${ctx.id} 里出现了枚举外的桶「${b.tag}」`);
      assert.ok(b.lift >= CONTEXT_PRIOR_MIN_LIFT, `${ctx.id}/${b.tag} 的 lift ${b.lift} 低于阈值`);
      assert.ok(Number.isFinite(b.n) && b.n > 0, `${ctx.id}/${b.tag} 缺样本量 n`);
    }
    // 每个语境内按 lift 降序（纯函数依赖这个不变量）
    const lifts = ctx.buckets.map((b) => b.lift);
    assert.deepEqual(lifts, [...lifts].sort((a, b) => b - a), `${ctx.id} 的 buckets 没按 lift 降序`);
  }
  assert.equal(Object.isFrozen(CONTEXT_PRIORS), true);
});

test('★ 「没有信号」的两个语境被**显式**记下来，而不是靠"表里没有"暗示', () => {
  const ids = CONTEXT_WITHOUT_SIGNAL.map((c) => c.id);
  assert.deepEqual(ids, ['图片/表情包回应', '工作/学习/日常吐槽']);
  for (const c of CONTEXT_WITHOUT_SIGNAL) {
    assert.equal(CONTEXT_PRIORS.some((p) => p.id === c.id), false, `${c.id} 不该同时在先验表里`);
    assert.ok(typeof c.why === 'string' && c.why !== '');
  }
  // 报告口径里的那两个 n 也钉住（一个 13319、一个 823）
  assert.equal(CONTEXT_WITHOUT_SIGNAL[0].n, 13319);
  assert.equal(CONTEXT_WITHOUT_SIGNAL[1].n, 823);
});

test('基线表：一份独立口径（一张图可能有多个桶，所以总和不等于 100）', () => {
  assert.equal(BASELINE_SHARE['调侃吐槽'], 27.9);
  const sum = Object.values(BASELINE_SHARE).reduce((a, b) => a + b, 0);
  assert.ok(sum > 100, `多标签口径的总和该 > 100（实际 ${sum}）—— 这正说明它不是覆盖率`);
  assert.deepEqual([...BASELINE_BUCKETS], ['调侃吐槽', '幽默搞笑', '卖萌可爱', '无语无奈']);
});

// ------------------------------------------------------------------ 纯函数

test('★ contextCandidates（严格版）：只给"这段语境真的抬高过"的桶', () => {
  assert.deepEqual(contextCandidates('我完全看不懂他在说什么'), ['困惑不解', '生气不满', '无语无奈', '尴尬社死']);
  assert.deepEqual(contextCandidates('无语了，好尴尬啊'), ['无语无奈', '尴尬社死', '困惑不解', '生气不满']);
  // 只有一个桶的语境**如实只给一个**（凑数会把"这个语境很干净"的信息抹掉）
  assert.deepEqual(contextCandidates('来来来吃瓜看戏'), ['吃瓜围观']);
  assert.deepEqual(contextCandidates('开个玩笑啦'), ['调侃吐槽']);
  // 认不出 ⇒ 空数组（**不编先验**）
  assert.deepEqual(contextCandidates('今天的工作汇报写完了'), []);
  assert.deepEqual(contextCandidates('这是一句没有任何关键词的话'), []);
  assert.deepEqual(contextCandidates(''), []);
  assert.deepEqual(contextCandidates(null), []);
  assert.deepEqual(contextCandidates(undefined), []);
});

test('★ max 生效；结果永远只含枚举值', () => {
  assert.deepEqual(contextCandidates('看不懂', { max: 2 }), ['困惑不解', '生气不满']);
  assert.deepEqual(contextCandidates('看不懂', { max: 1 }), ['困惑不解']);
  const wide = contextCandidates('看不懂，而且好尴尬，太离谱了');
  assert.ok(wide.length <= 4);
  for (const t of wide) assert.equal(STICKER_TAGS.includes(t), true);
});

test('★ 命中多个语境时：按最高 lift 排序，不做加权求和', () => {
  // "离谱"+"看不懂" 两个语境 → 困惑不解(4.14) 该在 震惊惊讶(2.87) 前面；
  // 吃瓜围观/生气不满 被**两个**语境同时抬高（1.99 / 1.91），排在只被一个抬高的前面
  assert.deepEqual(contextCandidates('这也太离谱了，我看不懂'), ['困惑不解', '震惊惊讶', '吃瓜围观', '生气不满']);
  assert.deepEqual(matchedContexts('这也太离谱了，我看不懂'), ['困惑/看不懂', '震惊/意外/离谱']);
  assert.deepEqual(matchedContexts('普通的一句话'), []);
});

test('★★ candidatesForContext：2~4 个（不够就用兜底补，且兜底是基线不是平铺）', () => {
  // 语境抬高了 4 个 → 原样
  assert.deepEqual(candidatesForContext('我完全看不懂'), ['困惑不解', '生气不满', '无语无奈', '尴尬社死']);
  // 只抬高 1 个 → 用基线补到 2 个
  assert.deepEqual(candidatesForContext('来来来吃瓜'), ['吃瓜围观', '调侃吐槽']);
  assert.deepEqual(candidatesForContext('开个玩笑'), ['调侃吐槽', '幽默搞笑']);
  // 认不出语境 → 全是基线兜底，但**只补到 min（2）为止**：
  // 一个"没有信号"的输入给两个最大的桶就够了，补满 4 个只会稀释
  assert.deepEqual(candidatesForContext('今天天气不错'), ['调侃吐槽', '幽默搞笑']);
  // 调用方可以显式关掉兜底（传 []），那就退化成严格版
  assert.deepEqual(candidatesForContext('今天天气不错', { fallback: [] }), []);
  assert.deepEqual(candidatesForContext('来来来吃瓜', { fallback: [] }), ['吃瓜围观']);
  // 每个结果都只含枚举值、不重复
  for (const text of ['看不懂', '吃瓜', '早安', '嘲讽', '无关键词']) {
    const got = candidatesForContext(text);
    assert.ok(got.length >= 2 && got.length <= 4, `「${text}」给了 ${got.length} 个`);
    assert.equal(new Set(got).size, got.length, '不该重复');
    for (const t of got) assert.equal(STICKER_TAGS.includes(t), true);
  }
});

test('★ min/max 的边界与非法输入都不抛', () => {
  assert.equal(candidatesForContext('看不懂', { min: 1, max: 1 }).length, 1);
  assert.ok(candidatesForContext('看不懂', { max: 2 }).length <= 2);
  assert.deepEqual(candidatesForContext(null), ['调侃吐槽', '幽默搞笑']);
  assert.deepEqual(candidatesForContext(42), ['调侃吐槽', '幽默搞笑']);
  assert.deepEqual(candidatesForContext('看不懂', { fallback: ['不存在的桶', '治愈陪伴'] }), ['困惑不解', '生气不满', '无语无奈', '尴尬社死']);
  assert.deepEqual(candidatesForContext('吃瓜', { fallback: ['不存在的桶', '治愈陪伴'] }), ['吃瓜围观', '治愈陪伴']);
});

test('★★ 这一层**不做"挑"**：模块上没有任何选择/发送的动作', () => {
  const mod = { contextCandidates, candidatesForContext, matchedContexts };
  for (const forbidden of ['pick', 'pickOne', 'random', 'choose', 'sendOne', 'send']) {
    assert.equal(typeof mod[forbidden], 'undefined', `不该有 ${forbidden}()`);
  }
});
