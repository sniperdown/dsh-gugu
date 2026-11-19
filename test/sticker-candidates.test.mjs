/**
 * 表情包**候选表**（群友频次）—— 2026-11-18，方案 §3 的 **③a：只记不判**。
 *
 * 文件：[`shared/2026-11-18-表情包打分方案.md`](../../shared/2026-11-18-表情包打分方案.md) §3.2/§3.5。
 *
 * ## 这一组盯的是什么
 *
 * 1. **计数口径**（`qualifies`）：同一张图要"≥3 次、≥2 人、≥2 天、在 30 天窗口内"
 *    才算群里的梗 —— 一个人连发 10 次、同一天刷屏都**不算**（那是刷屏，不是梗）；
 * 2. **只记不判**：接上候选表之后，`stored` / `rejected` / `auditFailed` **一个都不能变**。
 *    这条是 ③a 的全部意义 —— 变了就说明"只记"其实改了行为，必须当场回退；
 * 3. **坏了当空表**：读不出来 ⇒ `degraded` + 一条 warn，库照常工作（不许变成单点故障）。
 *
 * ## 隐私（方案 §5 风险 7）
 *
 * `chatters` 存的是 `sha256(userId)` 的**前 8 位**，不存明文 QQ。
 * 所以这里有一条专门钉着这件事：表里**不许出现**明文 userId。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_STICKER_ADMIT,
  STICKER_CANDIDATES_VERSION,
  chatterHash,
  createStickerCandidates,
} from '../src/dsh/sticker-candidates.mjs';
import {
  DEFAULT_STICKER_ADMIT_SWITCH,
  loadStickerPickConfig,
  normalizeStickerAdmit,
} from '../src/dsh/sticker-pick.mjs';
import { createStickerLibrary } from '../src/dsh/sticker-library.mjs';

const T0 = Date.UTC(2026, 10, 18, 0, 0, 0);
const DAY = 86_400_000;
const MD5 = 'a'.repeat(32);

/** 一个隔离的候选表（`filePath: ''` = 只在内存里）。 */
function makeTable({ filePath, clock, maxEntries, coalesceMs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cand-'));
  const target = filePath === undefined ? path.join(root, 'qq-sticker-candidates.json') : filePath;
  const tick = clock ?? { t: T0 };
  const logs = [];
  const table = createStickerCandidates({
    filePath: target,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => tick.t,
    coalesceMs: coalesceMs === undefined ? 0 : coalesceMs, // 默认"每次都写"：测试要好断言
    ...(maxEntries === undefined ? {} : { maxEntries }),
  });
  return { root, target, table, clock: tick, logs };
}

// ------------------------------------------------------------------ 表情包夹具（偷那张路用）

function realSticker(overrides = {}) {
  return {
    type: 'image',
    summary: '',
    file: 'abc.gif',
    url: 'https://gxh.vip.qq.com/club/item/parcel/item/67/aaa/raw300.gif',
    emoji_id: 'id0',
    emoji_package_id: 240387,
    ...overrides,
  };
}

/** 一张最小 PNG（magic 认得出）。`seed` 决定内容 → 决定 md5。 */
function pngBytes(seed) {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b[8] = 0x00; b[9] = 0x00; b[10] = 0x00; b[11] = 0x0d;
  b[12] = seed % 256; b[13] = (seed * 7) % 256;
  return b;
}

function fakeFetch(table) {
  return async (url) => {
    const body = table[String(url)];
    if (body === undefined) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
}

// ================================================================== ① 计数口径

test('★★ 三个不同的人、分两天、共 3 次 ⇒ 够门槛', () => {
  const { table } = makeTable();
  table.observe({ md5: MD5, userId: '1001', at: T0 });
  table.observe({ md5: MD5, userId: '1002', at: T0 + DAY });
  table.observe({ md5: MD5, userId: '1003', at: T0 + DAY });
  assert.equal(table.qualifies(MD5, { at: T0 + DAY }), true);
  const entry = table.get(MD5);
  assert.equal(entry.seen, 3);
  assert.equal(entry.chatters.length, 3, '三个人 = 三个不同的哈希');
  assert.equal(entry.days.length, 2, '只存去重后的日期串');
});

test('★★ 一个人连发 3 次（跨两天）⇒ **不算**（人数不够 = 刷屏，不是"群里的梗"）', () => {
  const { table } = makeTable();
  table.observe({ md5: MD5, userId: '1001', at: T0 });
  table.observe({ md5: MD5, userId: '1001', at: T0 + 1000 });
  table.observe({ md5: MD5, userId: '1001', at: T0 + DAY });
  assert.equal(table.qualifies(MD5, { at: T0 + DAY }), false, 'chatters=1 < minChatters=2');
  assert.equal(table.get(MD5).seen, 3);
});

test('★★ 三个人同一天发 ⇒ **不算**（`minDays` 挡"一次刷屏"）', () => {
  const { table } = makeTable();
  table.observe({ md5: MD5, userId: '1001', at: T0 });
  table.observe({ md5: MD5, userId: '1002', at: T0 + 3600_000 });
  table.observe({ md5: MD5, userId: '1003', at: T0 + 7200_000 });
  assert.equal(table.qualifies(MD5, { at: T0 + 7200_000 }), false, 'days=1 < minDays=2');
});

test('★★ 四十天前热过、现在没人发了 ⇒ **不算**（"高频"必须是近期高频）', () => {
  const { table } = makeTable();
  const old = T0 - 40 * DAY;
  table.observe({ md5: MD5, userId: '1001', at: old });
  table.observe({ md5: MD5, userId: '1002', at: old + DAY });
  table.observe({ md5: MD5, userId: '1003', at: old + DAY });
  assert.equal(table.qualifies(MD5, { at: old + DAY }), true, '当时是够的');
  assert.equal(table.qualifies(MD5, { at: T0 }), false, '窗口之外（40 天没再出现）就不算了');
});

test('★★ 单人饱和 `perChatterCap = 2`：一个人刷 5 次只算 2 次（另一个人各算各的）', () => {
  const { table } = makeTable();
  for (let i = 0; i < 5; i += 1) table.observe({ md5: MD5, userId: '1001', at: T0 + i * 1000 });
  table.observe({ md5: MD5, userId: '1002', at: T0 + DAY });
  // 计分 = min(5,2) + min(1,2) = 3 ⇒ 刚够 minSeen=3；人数 2、跨天 2 ⇒ 过门槛
  assert.equal(table.qualifies(MD5, { at: T0 + DAY }), true);
  assert.equal(table.get(MD5).counts[chatterHash('1001')], 5, '原始次数照实存（饱和只发生在判定时）');

  // 反证：只有那 5 次（一个人）⇒ 计分 2 < 3 ⇒ 不过
  const solo = makeTable();
  for (let i = 0; i < 5; i += 1) solo.table.observe({ md5: MD5, userId: '1001', at: T0 + i * 1000 });
  solo.table.observe({ md5: MD5, userId: '1001', at: T0 + DAY });
  assert.equal(solo.table.qualifies(MD5, { at: T0 + DAY }), false, '一个人刷再多也只有 2 分 + 人数不够');
});

test('★ `stats().qualified` 是可读的汇总（两周后定阈值就看这两个数）', () => {
  const { table } = makeTable();
  table.observe({ md5: 'a'.repeat(32), userId: '1001', at: T0 });
  table.observe({ md5: 'a'.repeat(32), userId: '1002', at: T0 + DAY });
  table.observe({ md5: 'a'.repeat(32), userId: '1003', at: T0 + DAY });
  table.observe({ md5: 'b'.repeat(32), userId: '1001', at: T0 });
  const s = table.stats();
  assert.equal(s.size, 2);
  assert.equal(s.qualified, 1, '两条里只有一条够门槛');
  assert.equal(s.mode, 'observe', '③a 恒为观察模式');
  assert.deepEqual(s.gates, { ...DEFAULT_STICKER_ADMIT }, '门槛的生效值要能看见');
  assert.equal(s.observed, 4);
});

// ================================================================== ② 自己发的不算 + 隐私

test('★★ 自己发的**一次都不记**（协议层已丢，这里是防退化）', () => {
  const { table } = makeTable();
  assert.equal(table.observe({ md5: MD5, userId: '999', self: true }), false);
  assert.equal(table.stats().skippedSelf, 1);
  assert.equal(table.stats().size, 0);
  assert.equal(table.get(MD5), null);
});

test('★★ `chatters` 只存 `sha256(userId)` 前 8 位 —— 表里**不许出现明文 QQ**', () => {
  const userId = '30000001';
  const { table, target } = makeTable();
  table.observe({ md5: MD5, userId, at: T0 });
  table.flush();
  const raw = fs.readFileSync(target, 'utf8');
  assert.equal(raw.includes(userId), false, '明文 QQ 不该出现在候选表里');
  assert.equal(raw.includes(chatterHash(userId)), true);
  assert.equal(chatterHash(userId).length, 8);
  assert.match(chatterHash(userId), /^[0-9a-f]{8}$/);
  assert.equal(chatterHash(''), '', '空 id ⇒ 空串（那一次"谁发的"不可判）');
  assert.notEqual(chatterHash('1001'), chatterHash('1002'));
  assert.equal(chatterHash('1001'), chatterHash('1001'), '同一个人的哈希必须稳定');
});

// ================================================================== ③ 落盘：原子写 / 坏了当空表 / 淘汰

test('★★ 写盘是"临时文件 + rename"，重新打开能读回来', () => {
  const { table, target } = makeTable({ coalesceMs: 0 });
  table.observe({ md5: MD5, userId: '1001', at: T0, emojiId: 'emoji-1' });
  table.observe({ md5: MD5, userId: '1002', at: T0 + DAY });
  assert.equal(fs.existsSync(target), true, '第一次 observe 就该落盘（coalesceMs=0）');
  assert.equal(fs.existsSync(`${target}.tmp`), false, '临时文件必须被 rename 走，不留残骸');

  const again = createStickerCandidates({ filePath: target, log: () => {}, now: () => T0 + DAY, coalesceMs: 0 });
  const entry = again.get(MD5);
  assert.equal(entry.seen, 2);
  assert.equal(entry.chatters.length, 2);
  assert.deepEqual(entry.days.length, 2);
  assert.equal(entry.emojiId, 'emoji-1');
  assert.equal(again.byEmojiId('emoji-1').md5, MD5, 'emoji_id → md5 的配对要能用（将来省掉下载）');
});

test('★★ 表坏了 ⇒ `degraded` + warn，**当空表**照常记（不是单点故障）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cand-bad-'));
  const target = path.join(root, 'qq-sticker-candidates.json');
  fs.writeFileSync(target, '{"version": 1, "entries": { 半截', 'utf8');
  const logs = [];
  const table = createStickerCandidates({ filePath: target, log: (l, m) => logs.push({ level: l, message: m }), now: () => T0, coalesceMs: 0 });
  assert.equal(table.stats().degraded, true);
  assert.equal(table.stats().size, 0);
  assert.equal(logs.some((l) => l.level === 'warn'), true, '坏表要留 warn');

  // 照常能记、能写回去（下一次读就是好的了）
  table.observe({ md5: MD5, userId: '1001', at: T0 });
  assert.equal(table.stats().size, 1);
  const again = createStickerCandidates({ filePath: target, log: () => {}, now: () => T0 });
  assert.equal(again.stats().degraded, false);
  assert.equal(again.stats().size, 1);
});

test('★ 版本号对不上 / entries 不是对象 ⇒ 当空表（宁可重新攒，也不误读旧格式）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cand-ver-'));
  const target = path.join(root, 'qq-sticker-candidates.json');
  for (const payload of [
    { version: STICKER_CANDIDATES_VERSION + 1, entries: { [MD5]: { seen: 9 } } },
    { version: STICKER_CANDIDATES_VERSION, entries: [] },
    { version: STICKER_CANDIDATES_VERSION, entries: null },
  ]) {
    fs.writeFileSync(target, JSON.stringify(payload), 'utf8');
    const table = createStickerCandidates({ filePath: target, log: () => {}, now: () => T0 });
    assert.equal(table.stats().size, 0, `payload=${JSON.stringify(payload).slice(0, 40)} 应被当空表`);
    assert.equal(table.stats().degraded, true);
  }
});

test('★ 超过上限 ⇒ `lastAt` 最旧的先走（别让它长成第二张库）', () => {
  const { table } = makeTable({ maxEntries: 2, coalesceMs: 0 });
  table.observe({ md5: 'a'.repeat(32), userId: '1', at: T0 - 3 * DAY });
  table.observe({ md5: 'b'.repeat(32), userId: '1', at: T0 - 2 * DAY });
  table.observe({ md5: 'c'.repeat(32), userId: '1', at: T0 - 1 * DAY });
  assert.equal(table.stats().size, 2);
  assert.equal(table.get('a'.repeat(32)), null, '最久没再出现的那张先走');
  assert.equal(table.stats().dropped, 1);
});

test('★ 合并写：窗口内的第二次 observe 只打脏标（`pendingWrites` 涨、`writes` 不涨）', () => {
  const clock = { t: T0 };
  const { table } = makeTable({ clock, coalesceMs: 5000 });
  table.observe({ md5: MD5, userId: '1', at: T0 });          // 首次写
  const writesAfterFirst = table.stats().writes;
  clock.t = T0 + 1000;
  table.observe({ md5: MD5, userId: '2', at: T0 + 1000 });   // 窗口内 ⇒ 攒着
  assert.equal(table.stats().writes, writesAfterFirst, '窗口内不该再整份重写');
  assert.equal(table.stats().pendingWrites >= 1, true);
  clock.t = T0 + 6000;
  table.observe({ md5: MD5, userId: '3', at: T0 + 6000 });   // 过了窗口 ⇒ 写掉
  assert.equal(table.stats().writes > writesAfterFirst, true);
  assert.equal(table.stats().pendingWrites, 0);
  assert.equal(table.flush(), true, 'flush 必须能强制写');
});

// ================================================================== ④ 只记不判（零行为变化）

test('★★★ 接上候选表之后 `stored` / `rejected` / `auditFailed` **一个都不能变**', async () => {
  // 同一批消息跑两遍：一遍 `candidates: null`（老行为），一遍自动建表（新行为）。
  // 三个计数必须逐字节相同 —— 这就是 ③a 的判据（方案 §3.5 验证判据 2）。
  const seg = realSticker({ url: 'http://x/1.png', emoji_id: 'id1' });
  const bytes = pngBytes(7);

  async function run(withCandidates) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cand-lib-'));
    const dir = path.join(root, 'stickers');
    fs.mkdirSync(dir, { recursive: true });
    const recognize = async () => ({ ok: true, accept: false, reject: 'boring', scores: { funny: 0 } });
    const library = createStickerLibrary({
      dir,
      indexPath: path.join(root, 'qq-stickers.json'),
      log: () => {},
      now: () => T0,
      fetchImpl: fakeFetch({ [seg.url]: bytes }),
      recognize,
      ...(withCandidates ? {} : { candidates: null }),
    });
    const result = await library.harvest([seg], { chatId: 'group:1', userId: '1001' });
    return { root, library, result };
  }

  const off = await run(false);
  const on = await run(true);
  for (const key of ['stored', 'rejected', 'auditFailed', 'dedup', 'failed']) {
    assert.equal(on.result[key], off.result[key], `${key} 必须与"没有候选表"逐字节相同`);
  }
  assert.equal(on.result.rejected, 1, '这一份用例走的是"审核闸判不收"');
  assert.equal(on.result.stored, 0);

  // ⭐ 关键：**被拒的那张也进了候选表**（方案 §3.1：计数在「认」之前 = "入库前"）
  const s = on.library.stats().candidates;
  assert.equal(s.size, 1, '被审核拒掉的图也必须被计数（这正是候选表存在的理由）');
  assert.equal(s.observed, 1);
  assert.equal(off.library.stats().candidates, null, 'candidates: null ⇒ 明确关掉');

  // 表落在索引同目录（同构才好读）
  assert.equal(fs.existsSync(path.join(on.root, 'qq-sticker-candidates.json')), true);
});

test('★★ 候选表**不参与打分**：接上它之后 `pick` 的分布逐点不变', () => {
  // 同一份库，唯一差别是候选表里"这张图很热"。pick 必须完全看不见它。
  const X = 'b'.repeat(32);
  const Y = 'c'.repeat(32);
  function run(withCandidates) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cand-pick-'));
    const dir = path.join(root, 'stickers');
    fs.mkdirSync(dir, { recursive: true });
    const indexPath = path.join(root, 'qq-stickers.json');
    fs.writeFileSync(indexPath, JSON.stringify({
      version: 1,
      updatedAt: new Date(T0).toISOString(),
      entries: {
        [X]: { file: `${X}.png`, at: new Date(T0).toISOString(), tags: ['开心'], lastUsedAt: null },
        [Y]: { file: `${Y}.png`, at: new Date(T0).toISOString(), tags: ['开心'], lastUsedAt: null },
      },
    }));
    // "X 是群里的梗"：5 个人、跨 5 天、发了 10 次 —— 如果哪天有人拿它打分，这里就会偏。
    const table = withCandidates
      ? createStickerCandidates({ filePath: path.join(root, 'cand.json'), log: () => {}, now: () => T0 })
      : null;
    if (table !== null) {
      for (let i = 0; i < 10; i += 1) {
        table.observe({ md5: X, userId: `20${i % 5}`, at: T0 - (i % 5) * DAY });
      }
    }
    const library = createStickerLibrary({
      dir,
      indexPath,
      log: () => {},
      now: () => T0,
      ...(table === null ? { candidates: null } : { candidates: table }),
    });
    const original = Math.random;
    const hits = new Map();
    try {
      for (let i = 0; i < 2000; i += 1) {
        Math.random = () => (i + 0.5) / 2000;
        const picked = library.pick({ tags: ['开心'] });
        hits.set(picked.md5, (hits.get(picked.md5) ?? 0) + 1);
      }
    } finally {
      Math.random = original;
    }
    return { hits, table, library, root };
  }

  const off = run(false);
  const on = run(true);
  assert.equal(on.table.stats().size, 1, '候选表确实记上了');
  assert.equal(on.table.get(X).seen, 10);
  assert.deepEqual([...on.hits.entries()].sort(), [...off.hits.entries()].sort(),
    '候选表不许影响 pick —— ③a 是"只记不判"');
});

test('★ 表关掉（`filePath: ""`）⇒ 只在内存里，一次盘都不落', () => {
  const table = createStickerCandidates({ filePath: '', log: () => {}, now: () => T0 });
  assert.equal(table.stats().enabled, false);
  assert.equal(table.observe({ md5: MD5, userId: '1001', at: T0 }), true, '内存里照样记');
  assert.equal(table.stats().size, 1);
  assert.equal(table.stats().writes, 0);
  assert.equal(table.persist(), false);
});

test('★ 库没开（`enabled: false`）⇒ 连候选表都不建（不给用户磁盘上多写一个文件）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cand-off-'));
  const library = createStickerLibrary({
    dir: path.join(root, 'stickers'),
    indexPath: path.join(root, 'qq-stickers.json'),
    enabled: false,
    log: () => {},
    now: () => T0,
  });
  assert.equal(library.stats().candidates, null);
});

// ================================================================== ⑤ ③ 的回退键（`[sticker_admit]`）

test('★★ `[sticker_admit] enabled = false` ⇒ 连候选表都不建（③ 的回退键真的生效）', () => {
  // 用 `QQ_GUGU_TOML` 指临时文件（同步区间内改完就还原：单进程串行 import，中间不能有 await）。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cand-admit-'));
  const mainToml = path.join(root, 'qq-gugu.toml');
  const sideToml = path.join(root, 'qq-gugu.sticker.toml');
  fs.writeFileSync(mainToml, '# 主 toml\n', 'utf8');
  fs.writeFileSync(sideToml, '[sticker_admit]\nenabled = false\nmode = "observe"\n', 'utf8');

  const before = process.env.QQ_GUGU_TOML;
  try {
    process.env.QQ_GUGU_TOML = mainToml;
    const dir = path.join(root, 'stickers');
    fs.mkdirSync(dir, { recursive: true });
    const library = createStickerLibrary({
      dir,
      indexPath: path.join(root, 'qq-stickers.json'),
      log: () => {},
      now: () => T0,
    });
    assert.equal(library.stats().admit.enabled, false, 'toml 的 false 必须生效');
    assert.equal(library.stats().candidates, null, '关掉后一张都不记');
    // 开关本身也是"看得见"的（不然没人知道它被关了）
    assert.equal(library.stats().admit.mode, 'observe');
  } finally {
    if (before === undefined) delete process.env.QQ_GUGU_TOML;
    else process.env.QQ_GUGU_TOML = before;
  }
});

test('★★ `mode = "enforce"`（③b 还没实现）⇒ **降级回 observe + warn**，绝不"看起来在拦"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cand-enforce-'));
  const tomlPath = path.join(root, 'qq-gugu.sticker.toml');
  fs.writeFileSync(tomlPath, '[sticker_admit]\nmode = "enforce"\n', 'utf8');
  const logs = [];
  const got = loadStickerPickConfig({ tomlPath, log: (level, message) => logs.push({ level, message }) });
  assert.equal(got.admit.mode, 'observe', '没实现的模式必须降级');
  assert.equal(got.clamped.some((c) => c.key === 'mode'), true);
  assert.equal(logs.some((l) => l.level === 'warn'), true, '降级要留 warn');
});

test('★ `normalizeStickerAdmit`：非布尔 / 未知模式 ⇒ 回退默认 + 记一条 clamped', () => {
  for (const raw of [undefined, null, [], 'x', 42]) {
    const got = normalizeStickerAdmit(raw);
    assert.deepEqual(
      { enabled: got.enabled, mode: got.mode },
      { ...DEFAULT_STICKER_ADMIT_SWITCH },
      `raw=${JSON.stringify(raw)} 应全部回退默认`,
    );
    assert.deepEqual(got.clamped, []);
  }
  const bad = normalizeStickerAdmit({ enabled: 'false', mode: 'x' });
  assert.equal(bad.enabled, DEFAULT_STICKER_ADMIT_SWITCH.enabled, '不是布尔 ⇒ 回退默认值（`"false"` 有歧义）');
  assert.equal(bad.mode, 'observe');
  assert.equal(bad.clamped.length, 2);
  assert.equal(normalizeStickerAdmit({ enabled: false }).enabled, false, '真正的布尔照常认');
});

test('★ 没有 `[sticker_admit]` 这一节 ⇒ 默认**开着观察**（这是 ③a 的出厂状态）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cand-noadmit-'));
  const tomlPath = path.join(root, 'qq-gugu.sticker.toml');
  fs.writeFileSync(tomlPath, '[sticker_pick]\nhalfLifeDays = 30\n', 'utf8');
  const got = loadStickerPickConfig({ tomlPath, log: () => {} });
  assert.equal(got.foundAdmit, false);
  assert.deepEqual(got.admit, { ...DEFAULT_STICKER_ADMIT_SWITCH });
});
