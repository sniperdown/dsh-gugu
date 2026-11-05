/**
 * 表情包标签**封闭枚举 + 1685 映射表**的守门测试。
 *
 * ## 这组测试为什么必须存在
 *
 * `src/dsh/sticker-tags.mjs` 是**生成**出来的（生成器 `shared/tmp/gen-sticker-tags.mjs`），
 * 而生成物的坏法全都**不报错**：
 *
 * - 枚举少一个 / 多一个词（模型选不出来 ⇒ 全部落 `tags: []`，而日志里只会看到"没标签"）；
 * - 映射表被"顺手改一改"（1685 → 1684，谁都不会发现）；
 * - 桶名被改回旧名（`治愈陪伴` → `关心安慰`）—— 那会让"挑"永远查不到东西；
 * - 覆盖率表被手改成好看的数字（那是**报告里的实测值**，不是装饰）。
 *
 * ⇒ 这里把它们**逐条钉死**：数目、值域、每桶条数、抽样点、以及"生成物的结构"。
 * 钉的是**语义**而不是文件哈希 —— 哈希只能告诉你"变了"，这些能告诉你"坏在哪"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMOJI_TAG_MAP,
  EMOJI_TAG_MAP_META,
  MAX_STICKER_TAGS,
  MAX_UNMATCHED_CHARS,
  STICKER_TAGS,
  STICKER_TAG_COVERAGE,
  STICKER_TAG_COVERAGE_TOTAL,
  STICKER_TAG_FALLBACK,
  STICKER_TAG_HINTS,
  STICKER_TAG_PRIORITY,
  isStickerTag,
  normalizeStickerTags,
} from '../src/dsh/sticker-tags.mjs';

// ------------------------------------------------------------------ 17 个枚举

test('★★ 枚举正好是 17 个值，一个字都不能差（顺序也是契约）', () => {
  // 顺序 = 报告 §2.2 的表格顺序（按真实使用次数降序）。
  // 它不是"随便排的"：覆盖率表、提示词示例、以及"挑"的展示顺序都按它。
  assert.deepEqual([...STICKER_TAGS], [
    '调侃吐槽', '幽默搞笑', '卖萌可爱', '震惊惊讶', '无语无奈', '害羞心动', '玩梗接梗',
    '开心满足', '治愈陪伴', '困惑不解', '尴尬社死', '得意自信', '社交互动', '难过不安',
    '吃瓜围观', '生气不满', '赞同支持',
  ]);
  assert.equal(STICKER_TAGS.length, 17);
  assert.equal(new Set(STICKER_TAGS).size, 17, '不该有重复');
  assert.equal(STICKER_TAG_FALLBACK, '其他');
  assert.equal(STICKER_TAGS.includes(STICKER_TAG_FALLBACK), false, '「其他」不进可选列表');
  assert.equal(MAX_STICKER_TAGS, 3);
  assert.equal(MAX_UNMATCHED_CHARS, 8);
  assert.equal(Object.isFrozen(STICKER_TAGS), true, '枚举要冻结：它是契约');
});

test('★★ `治愈陪伴` 这个名字不能回退成旧的 `关心安慰`', () => {
  // ⚠️ 数据源 `emoji2-context.txt` 的 lift 表里写的是「关心安慰」（历史文本），
  //    而**定稿的枚举名与映射表的键是「治愈陪伴」**（报告 §2.3 "已统一"）。
  //    回退的后果是"挑"永远命中不了这个桶，而且看不出来。
  assert.equal(STICKER_TAGS.includes('治愈陪伴'), true);
  assert.equal(STICKER_TAGS.includes('关心安慰'), false);
  assert.equal(EMOJI_TAG_MAP['萌系治愈，可爱日常分享，轻松氛围调节'], '治愈陪伴');
  assert.equal(EMOJI_TAG_MAP['亲密调侃'], '治愈陪伴');
});

test('覆盖率表：18 个键（17 + 其他），17 个加起来 ≈ 98.93%', () => {
  assert.equal(Object.keys(STICKER_TAG_COVERAGE).length, 18);
  for (const tag of STICKER_TAGS) {
    assert.equal(typeof STICKER_TAG_COVERAGE[tag], 'number', `${tag} 缺覆盖率`);
  }
  assert.equal(STICKER_TAG_COVERAGE[STICKER_TAG_FALLBACK], 1.07);
  // 报告口径 A（30458 个标签实例）里逐项四舍五入后相加 = 98.92，报告写 98.93。
  assert.ok(
    STICKER_TAG_COVERAGE_TOTAL >= 98.5 && STICKER_TAG_COVERAGE_TOTAL <= 99.5,
    `17 个桶该覆盖 ~98.93%，实际 ${STICKER_TAG_COVERAGE_TOTAL}`,
  );
  // 抽样：占最大头的那两个 + 最小的那一个
  assert.equal(STICKER_TAG_COVERAGE['调侃吐槽'], 16.69);
  assert.equal(STICKER_TAG_COVERAGE['幽默搞笑'], 15.41);
  assert.equal(STICKER_TAG_COVERAGE['赞同支持'], 1.24);
});

test('匹配优先级：17 个值、与枚举同集合、而且「其他」不在里面', () => {
  assert.equal(STICKER_TAG_PRIORITY.length, 17);
  assert.deepEqual([...STICKER_TAG_PRIORITY].sort(), [...STICKER_TAGS].sort());
  assert.equal(STICKER_TAG_PRIORITY.includes(STICKER_TAG_FALLBACK), false);
  // 方案 A「情绪反应优先」的头两个（数据源里的 order[0]/[1]）
  assert.equal(STICKER_TAG_PRIORITY[0], '尴尬社死');
  assert.equal(STICKER_TAG_PRIORITY[1], '生气不满');
});

test('高频标签示例：每个桶都有、都不超过 3 个、都非空', () => {
  assert.deepEqual(Object.keys(STICKER_TAG_HINTS).sort(), [...STICKER_TAGS].sort());
  for (const tag of STICKER_TAGS) {
    const hints = STICKER_TAG_HINTS[tag];
    assert.ok(Array.isArray(hints) && hints.length >= 1 && hints.length <= 3, `${tag} 的示例数不对`);
    for (const h of hints) assert.equal(typeof h === 'string' && h !== '', true);
  }
  assert.deepEqual(STICKER_TAG_HINTS['调侃吐槽'], ['幽默调侃', '搞笑调侃', '网络调侃']);
});

// ------------------------------------------------------------------ 1685 映射表

test('★★ 映射表正好 1685 条，值域只有 18 个（17 枚举 + 其他）', () => {
  const keys = Object.keys(EMOJI_TAG_MAP);
  assert.equal(keys.length, 1685);
  assert.equal(EMOJI_TAG_MAP_META.size, 1685);
  assert.equal(EMOJI_TAG_MAP_META.best, 'A 情绪反应优先');
  const allowed = new Set([...STICKER_TAGS, STICKER_TAG_FALLBACK]);
  for (const [k, v] of Object.entries(EMOJI_TAG_MAP)) {
    assert.equal(allowed.has(v), true, `「${k}」归到了枚举外的「${v}」`);
  }
  assert.equal(Object.isFrozen(EMOJI_TAG_MAP), true);
});

test('★ 每个桶的**原标签条数**逐桶钉死（改坏一条就看得出是哪个桶变了）', () => {
  const counts = {};
  for (const v of Object.values(EMOJI_TAG_MAP)) counts[v] = (counts[v] ?? 0) + 1;
  assert.deepEqual(counts, {
    调侃吐槽: 177, 幽默搞笑: 144, 卖萌可爱: 130, 震惊惊讶: 132, 无语无奈: 200,
    害羞心动: 84, 玩梗接梗: 85, 开心满足: 78, 治愈陪伴: 69, 困惑不解: 81,
    尴尬社死: 99, 得意自信: 90, 社交互动: 25, 难过不安: 82, 吃瓜围观: 38,
    生气不满: 69, 赞同支持: 23, 其他: 79,
  });
});

test('★ 抽样点：短语、长句、以及"落进其他"的那一类', () => {
  const points = {
    幽默调侃: '调侃吐槽',
    搞笑调侃: '调侃吐槽',
    阴阳怪气: '调侃吐槽',
    搞笑互动: '幽默搞笑',
    可爱卖萌: '卖萌可爱',
    无奈接受邀请: '无语无奈',
    无奈: '无语无奈',
    尴尬无奈: '尴尬社死',
    震惊无语: '震惊惊讶',
    震惊吃瓜: '吃瓜围观',
    害羞卖萌: '害羞心动',
    网络流行梗: '玩梗接梗',
    轻松愉快: '开心满足',
    困惑不解: '困惑不解',
    一脸懵逼: '困惑不解',
    强大自傲: '得意自信',
    正能量: '赞同支持',
    社交媒体互动: '社交互动',
    悲伤和失落: '难过不安',
    不满宣泄: '生气不满',
    // 长句（含中文逗号的那些"整句话标签"）也要能对上
    '萌系治愈，可爱日常分享，轻松氛围调节': '治愈陪伴',
    // 兜底：「其他」只有 79 个原标签（1.07% 使用量）
    古代人吃现代食物: '其他',
    表达WTF时刻: '其他',
  };
  for (const [label, tag] of Object.entries(points)) {
    assert.equal(EMOJI_TAG_MAP[label], tag, `「${label}」该归「${tag}」`);
  }
});

// ------------------------------------------------------------------ 纯函数

test('isStickerTag：只认 17 个枚举值（「其他」不算，近似词不算）', () => {
  assert.equal(isStickerTag('调侃吐槽'), true);
  assert.equal(isStickerTag('  卖萌可爱  '), true, '去首尾空白');
  assert.equal(isStickerTag('其他'), false, '兜底桶不可选');
  assert.equal(isStickerTag('幽默'), false, '近似匹配刻意不做（那会掩盖"模型没选出来"）');
  assert.equal(isStickerTag(''), false);
  assert.equal(isStickerTag(null), false);
  assert.equal(isStickerTag(3), false);
});

test('★ normalizeStickerTags：保序去重、截到 3 个、「其他」按没选处理', () => {
  assert.deepEqual(
    normalizeStickerTags(['无语无奈', '无语无奈', '其他', '卖萌可爱']),
    { tags: ['无语无奈', '卖萌可爱'], unmatched: '' },
  );
  // 模型给多了：**截断**而不是报错（多给一个不该废掉整条记录）
  assert.deepEqual(
    normalizeStickerTags(['调侃吐槽', '幽默搞笑', '开心满足', '生气不满']).tags,
    ['调侃吐槽', '幽默搞笑', '开心满足'],
  );
  // 非数组 / 空 / 全是不认识的词
  assert.deepEqual(normalizeStickerTags(null), { tags: [], unmatched: '' });
  assert.deepEqual(normalizeStickerTags([]), { tags: [], unmatched: '' });
  assert.deepEqual(normalizeStickerTags(['   ', 42]), { tags: [], unmatched: '' });
});

test('★ normalizeStickerTags：想用而用不上的词进 `unmatched`（只记日志、不建桶）', () => {
  const got = normalizeStickerTags(['调侃吐槽', '阴阳怪气']);
  assert.deepEqual(got.tags, ['调侃吐槽']);
  assert.equal(got.unmatched, '阴阳怪气');
  // 多个 → 用 / 连起来，且**截到 8 个字**（字段本身有上限，别让它无限长）
  const many = normalizeStickerTags(['一个非常长的自造标签', '第二个自造词']);
  assert.deepEqual(many.tags, []);
  assert.equal(Array.from(many.unmatched).length, MAX_UNMATCHED_CHARS);
});

test('normalizeStickerTags：max 可调，且非法 max 退回默认值', () => {
  assert.deepEqual(normalizeStickerTags(['调侃吐槽', '幽默搞笑'], { max: 1 }).tags, ['调侃吐槽']);
  assert.deepEqual(normalizeStickerTags(['调侃吐槽', '幽默搞笑'], { max: 0 }).tags, ['调侃吐槽', '幽默搞笑']);
  assert.deepEqual(normalizeStickerTags(['调侃吐槽', '幽默搞笑'], { max: Number.NaN }).tags, ['调侃吐槽', '幽默搞笑']);
});
