/**
 * 表情包「淘汰保护」—— 2026-11-18，方案 §2。
 *
 * 文件：[`shared/2026-11-18-表情包打分方案.md`](../../shared/2026-11-18-表情包打分方案.md) §2.4-A。
 *
 * ## 这一组盯的是什么
 *
 * `evict` 的原排序是「`uses` 最少的先走，同次数 `at` 最旧的先走」。它**不看这张图是不是
 * 某个标签的唯一持有者** —— 删掉那张以后，那个标签在库里就没了，`pick({tags:[那个类]})`
 * 直接 `null`，她**再也表达不出这个情绪**。
 *
 * 所以这里有两条主线：
 *
 * 1. **唯一持有者必须活下来**（并且证明"今天的行为会删掉它"—— 用同一份数据 + 关掉开关来对照）；
 * 2. ⚠️ **候选人筛空时必须降级**：库缩到"每张都是某个标签的最后一张"时，
 *    如果筛空就 `break`，库会**静默停在上限之上、一张都删不掉**（方案 §2.2 点名的陷阱）。
 *    这条必须有测试钉着 —— 它是最容易踩、而且踩了**没有任何日志**的那一脚。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStickerLibrary, createStickerIndex, STICKER_INDEX_VERSION } from '../src/dsh/sticker-library.mjs';
import { DEFAULT_STICKER_PICK } from '../src/dsh/sticker-pick.mjs';

const T0 = Date.UTC(2026, 10, 18, 0, 0, 0);
const DAY = 86_400_000;

/** 一个隔离的库 + 一堆按顺序 `set()` 进去的条目。 */
function makeLib({ maxEntries, protectLastOfTag = true, entries }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-evict-'));
  const dir = path.join(root, 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(root, 'qq-stickers.json');
  const logs = [];
  const library = createStickerLibrary({
    dir,
    indexPath,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => T0,
    maxEntries,
    // ⚠️ 显式传参数：不让用例去读本机那份 toml
    stickerPick: { ...DEFAULT_STICKER_PICK, protectLastOfTag },
    candidates: null,
  });
  for (const [md5, extra] of entries) {
    library.set(md5, { file: `${md5}.png`, ...extra });
  }
  return { root, dir, indexPath, library, logs };
}

const ids = (library) => library.all().map((e) => e.md5).sort();

/** 直接造索引（测 `createStickerIndex` 自己，不经过库的包装层）。 */
function makeIndex({ maxEntries, protectLastOfTag = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-evict-idx-'));
  const filePath = path.join(root, 'qq-stickers.json');
  const logs = [];
  const index = createStickerIndex({
    filePath,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => T0,
    maxEntries,
    protectLastOfTag,
  });
  return { root, filePath, index, logs };
}

// ================================================================== ① 唯一持有者存活

test('★★★ 淘汰保护：某标签只剩 1 张时**不许删它**（关掉开关 = 今天的行为，会删掉）', () => {
  // A 是「生气不满」的唯一一张、`uses` 0、入库最旧 —— 今天的行为一定先删它。
  // B / C 都属「调侃吐槽」，B 用过 5 次、C 没过。
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const C = 'c'.repeat(32);
  const entries = [
    [A, { tags: ['生气不满'], uses: 0, at: new Date(T0 - 30 * DAY).toISOString() }],
    [B, { tags: ['调侃吐槽'], uses: 5, at: new Date(T0).toISOString() }],
    [C, { tags: ['调侃吐槽'], uses: 0, at: new Date(T0).toISOString() }],
  ];

  const on = makeLib({ maxEntries: 2, protectLastOfTag: true, entries });
  assert.deepEqual(ids(on.library), [A, B].sort(), 'A（唯一持有者）必须活下来，C 被删');
  assert.equal(on.library.stats().index.protectedEvictions >= 1, true, '这次淘汰走了保护层');

  // 回退判据：关掉开关 ⇒ 逐字节是今天的行为（删 A，因为 uses 最小 + at 最旧）
  const off = makeLib({ maxEntries: 2, protectLastOfTag: false, entries });
  assert.deepEqual(ids(off.library), [B, C].sort(), 'protectLastOfTag=false 必须回到原排序（A 被删）');
  assert.equal(off.library.stats().index.protectedEvictions, 0);
});

test('★★ 判定是 `some` 不是 `every`：一张图只要**任一**标签是库里的独苗就受保护', () => {
  // E1 同时挂「生气不满」（全库 1 张）和「调侃吐槽」（全库 4 张）。
  // `every` 会判它"还剩别的类"⇒ 不受保护 ⇒ 删掉它 ⇒ 「生气不满」当场灭绝。
  const E1 = 'a'.repeat(32);
  const others = ['b', 'c', 'd'].map((ch) => ch.repeat(32));
  const entries = [
    [E1, { tags: ['生气不满', '调侃吐槽'], uses: 0, at: new Date(T0 - 30 * DAY).toISOString() }],
    [others[0], { tags: ['调侃吐槽'], uses: 5, at: new Date(T0).toISOString() }],
    [others[1], { tags: ['调侃吐槽'], uses: 5, at: new Date(T0).toISOString() }],
    [others[2], { tags: ['调侃吐槽'], uses: 5, at: new Date(T0).toISOString() }],
  ];
  const { library } = makeLib({ maxEntries: 3, protectLastOfTag: true, entries });

  assert.equal(library.get(E1) !== null, true, '`some` 语义：任一标签是独苗就保护（用 every 会把它删掉）');
  assert.equal(library.all().length, 3, '还是缩到上限 3 张');
  // 被删的应该是「调侃吐槽」那一族里最旧的（三张同 uses、同 at ⇒ 按 md5 兜底排序）
  assert.equal(ids(library).includes(E1), true);
});

test('★★ `tags: []` 的条目**不参与保护**（认都没认出来的图最该让位）', () => {
  // A 没标签、用过 9 次、入库最旧；B 是「独一份」的唯一一张、0 次、最新。
  // 今天的行为（以及保护生效时的行为）都该删 A —— 空标签条目没有"最后一张"的概念。
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const { library } = makeLib({
    maxEntries: 1,
    protectLastOfTag: true,
    entries: [
      [A, { tags: [], uses: 9, at: new Date(T0 - 30 * DAY).toISOString() }],
      [B, { tags: ['独一份'], uses: 0, at: new Date(T0).toISOString() }],
    ],
  });
  assert.equal(library.get(A), null, '空标签条目该被删（哪怕它用过 9 次）');
  assert.equal(library.get(B) !== null, true, '有唯一标签的那张活下来');
});

// ================================================================== ② 降级：筛空必须回退

test('★★★ 候选人筛成空集 ⇒ **必须降级回原始排序**，库要真的缩到上限（否则静默卡住）', () => {
  // 三张各自独占一个标签、limit=2 ⇒ 每张都是"某标签的最后一张"⇒ 保护层筛空。
  // 如果这时 `break`：库停在 3 张、一张都删不掉，而且**一个字都不打**（方案 §2.2）。
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const C = 'c'.repeat(32);
  const entries = [
    [A, { tags: ['生气不满'], uses: 0, at: new Date(T0 - 30 * DAY).toISOString() }],
    [B, { tags: ['调侃吐槽'], uses: 0, at: new Date(T0 - 20 * DAY).toISOString() }],
    [C, { tags: ['卖萌可爱'], uses: 0, at: new Date(T0 - 10 * DAY).toISOString() }],
  ];
  const { library, logs } = makeLib({ maxEntries: 2, protectLastOfTag: true, entries });

  assert.equal(library.all().length, 2, '必须真的缩到上限 2（不是静默停在 3）');
  const s = library.stats().index;
  assert.equal(s.protectFallback >= 1, true, '降级必须被计数（一直涨 = 库太小，要看得出来）');
  assert.equal(s.dropped, 1, '删掉了一张');
  assert.equal(s.protectStuck, 0, '不该走到"挑不出受害者"那条路');
  // 降级要留痕（不是静默）
  assert.equal(
    logs.some((l) => l.level === 'warn' && String(l.message).includes('回退')),
    true,
    '降级必须打一条 warn',
  );
  // 按原排序：at 最旧的 A 先走
  assert.deepEqual(ids(library), [B, C].sort());
});

test('★★ 降级**反复**发生也不会死循环，而且每次都真的删掉一张', () => {
  // 8 张各自独占一个标签、limit=3 ⇒ 每一轮保护都筛空、每一轮都得降级。
  const entries = [];
  for (let i = 0; i < 8; i += 1) {
    entries.push([
      `${i.toString(16)}`.repeat(32).slice(0, 32),
      { tags: [`标签${i}`], uses: 0, at: new Date(T0 - (8 - i) * DAY).toISOString() },
    ]);
  }
  const { library } = makeLib({ maxEntries: 3, protectLastOfTag: true, entries });
  assert.equal(library.all().length, 3, '缩到上限');
  assert.equal(library.stats().index.dropped, 5, '删掉了 5 张');
  assert.equal(library.stats().index.protectFallback >= 5, true, '每轮都降级过');
  assert.equal(library.stats().index.protectStuck, 0);
});

test('★★ `createStickerIndex` 自己也要降级（不是只有包装层对）', () => {
  const { index, logs } = makeIndex({ maxEntries: 1, protectLastOfTag: true });
  index.set('a'.repeat(32), { file: 'a.png', tags: ['生气不满'] });
  index.set('b'.repeat(32), { file: 'b.png', tags: ['调侃吐槽'] });
  assert.equal(index.stats().size, 1, '两张各自独占标签、上限 1 ⇒ 必须降级删掉一张');
  assert.equal(index.stats().protectFallback >= 1, true);
  assert.equal(logs.some((l) => l.level === 'warn'), true);

  // 关掉保护：同样是"最旧的先走"，但**不经过降级**（保护层压根没跑）
  const off = makeIndex({ maxEntries: 1, protectLastOfTag: false });
  off.index.set('a'.repeat(32), { file: 'a.png', tags: ['生气不满'] });
  off.index.set('b'.repeat(32), { file: 'b.png', tags: ['调侃吐槽'] });
  assert.equal(off.index.stats().size, 1);
  assert.equal(off.index.stats().protectFallback, 0, '关掉时不存在"降级"这回事');
});

// ================================================================== ③ 可观测 + 参数来源

test('★★ 快照里看得见：`tagCoverage` / `protectLastOfTag` / 三个保护计数', () => {
  const { library } = makeLib({
    maxEntries: 10,
    protectLastOfTag: true,
    entries: [
      ['a'.repeat(32), { tags: ['生气不满'], uses: 0, at: new Date(T0).toISOString() }],
      ['b'.repeat(32), { tags: ['调侃吐槽'], uses: 0, at: new Date(T0).toISOString() }],
      ['c'.repeat(32), { tags: ['调侃吐槽'], uses: 0, at: new Date(T0).toISOString() }],
      ['d'.repeat(32), { tags: ['卖萌可爱'], uses: 0, at: new Date(T0).toISOString() }],
    ],
  });
  const s = library.stats().index;
  assert.equal(s.protectLastOfTag, true, '生效的开关要能在快照里看到');
  // 3 个标签，其中「生气不满」「卖萌可爱」各只剩 1 张
  assert.deepEqual(s.tagCoverage, { total: 3, singleton: 2 });
  // 三个计数都在（恒为 0 的死字段也不行 —— 它们各有判据）
  assert.equal(typeof s.protectedEvictions, 'number');
  assert.equal(typeof s.protectFallback, 'number');
  assert.equal(typeof s.protectStuck, 'number');
  assert.equal(s.lastEvictProtected, false, '这次没有淘汰，所以"上一次有没有走保护层"是 false');
});

test('★★★ 参数真的被读了：`[sticker_pick] protectLastOfTag = false` 必须让行为回到原排序', () => {
  // 用 `QQ_GUGU_TOML` 把加载器指向临时文件（**同步区间**内改完就还原：
  // `run-all-tests.mjs` 是单进程串行 import，中间不能有 await）。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-evict-toml-'));
  const mainToml = path.join(root, 'qq-gugu.toml');
  const sideToml = path.join(root, 'qq-gugu.sticker.toml');
  fs.writeFileSync(mainToml, '# 主 toml\n', 'utf8');
  fs.writeFileSync(sideToml, '[sticker_pick]\nprotectLastOfTag = false\n', 'utf8');

  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const C = 'c'.repeat(32);
  const entries = [
    [A, { tags: ['生气不满'], uses: 0, at: new Date(T0 - 30 * DAY).toISOString() }],
    [B, { tags: ['调侃吐槽'], uses: 5, at: new Date(T0).toISOString() }],
    [C, { tags: ['调侃吐槽'], uses: 0, at: new Date(T0).toISOString() }],
  ];

  const before = process.env.QQ_GUGU_TOML;
  try {
    process.env.QQ_GUGU_TOML = mainToml;
    const dir = path.join(root, 'stickers');
    fs.mkdirSync(dir, { recursive: true });
    const indexPath = path.join(root, 'qq-stickers.json');
    const library = createStickerLibrary({
      dir,
      indexPath,
      log: () => {},
      now: () => T0,
      maxEntries: 2,
      candidates: null, // ⚠️ 不传 stickerPick ⇒ 走"读 toml"那条路
    });
    assert.equal(library.stats().pick.protectLastOfTag, false, 'toml 里的 false 必须生效');
    for (const [md5, extra] of entries) library.set(md5, { file: `${md5}.png`, ...extra });
    assert.deepEqual(ids(library), [B, C].sort(), 'toml 关掉保护 ⇒ 回到原排序（A 被删）');
  } finally {
    if (before === undefined) delete process.env.QQ_GUGU_TOML;
    else process.env.QQ_GUGU_TOML = before;
  }
});

test('★ 索引文件还是老格式（version 对不上）⇒ 当空库，淘汰保护不参与（不抛）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-evict-bad-'));
  const filePath = path.join(root, 'qq-stickers.json');
  fs.writeFileSync(filePath, JSON.stringify({ version: STICKER_INDEX_VERSION + 1, entries: { a: { file: 'a.png' } } }));
  const index = createStickerIndex({ filePath, log: () => {}, maxEntries: 2, protectLastOfTag: true });
  assert.equal(index.stats().degraded, true);
  assert.equal(index.stats().size, 0);
  assert.deepEqual(index.stats().tagCoverage, { total: 0, singleton: 0 });
});
