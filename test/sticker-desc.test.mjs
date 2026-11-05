/**
 * 表情包 `desc`（画面描述）**进库**的整条链 —— 2026-10-19。
 *
 * ## 为什么单开一个文件
 *
 * 这一批改的是同一个字段在**四个位置**的流转：
 *
 * 1. `harvest` 入库：`verdict.desc` 要写进索引（以前只写 `tags`）；
 * 2. `set()`：**写**的那条路也必须存 `desc` ——
 *    ⚠️ 只改 `createStickerIndex` 的**解析**（读）那处，回填会跑、`all()` 也看得见，
 *    但 `persist()` 写回文件时又把 `desc` 丢了 ⇒ 重启后从 79 张退回 0 张。
 *    这条是本文件最值钱的一个用例（真库实测过：修之前文件里带 desc 的条目是 0/120）。
 * 3. `createStickerIndex` 的解析（读）那处：手写索引里的 `desc` 读回来要保留；
 * 4. `pick` 里的一次性回填：老库（条目没 desc）从审核留样的 `index.jsonl` 补一次，
 *    而且**只补一次**（老库升级不该每次 pick 都写盘）。
 *
 * ## 约束
 *
 * - 不读本机真实数据：全部在 `mkdtemp` 的临时目录里，`indexPath` / `auditPath` / `dir` 显式注入。
 * - 不做统计断言：`desc` 是**确定性的字段**，这条链上没有随机。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  STICKER_INDEX_VERSION,
  createStickerIndex,
  createStickerLibrary,
} from '../src/dsh/sticker-library.mjs';

// ------------------------------------------------------------------ 夹具

const T0 = Date.UTC(2026, 9, 19, 0, 0, 0);

/** 一个像 md5 但一定不是整数索引形式的键（32 位十六进制，首位是字母）。 */
const md5Of = (i) => `b${i.toString(16).padStart(31, '0')}`;

/** 一张最小 PNG（magic 认得出，内容由 seed 决定 ⇒ md5 由 seed 决定）。 */
function pngBytes(seed) {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b[8] = 0x00; b[9] = 0x00; b[10] = 0x00; b[11] = 0x0d;
  b[12] = seed % 256; b[13] = (seed * 7) % 256;
  return b;
}

/**
 * 手写一份索引 JSON。`entries` 是 `[md5, extra]` 数组，`extra` 里可带 `desc`。
 *
 * ⚠️ 刻意**不**自动补 `desc`：要模拟"老库"（字段不存在）与"新库"（字段存在）两种形状。
 */
function writeIndexFile(indexPath, entries) {
  const map = {};
  for (const [md5, extra] of entries) {
    map[md5] = {
      file: `${md5}.png`,
      emojiId: '',
      packageId: null,
      at: new Date(T0).toISOString(),
      seen: 0,
      uses: 0,
      lastUsedAt: null,
      tags: [],
      source: { chatId: '', userId: '' },
      ...extra,
    };
  }
  fs.writeFileSync(indexPath, JSON.stringify({
    version: STICKER_INDEX_VERSION,
    updatedAt: new Date(T0).toISOString(),
    entries: map,
  }, null, 2));
}

/**
 * 一个隔离的库：临时目录 + 注入 `indexPath` / `auditPath` / `dir` / `now`。
 *
 * @param {object} [options]
 * @param {Array<[string, object]>} [options.entries] 索引里的条目
 * @param {string|null} [options.audit] audit jsonl 内容（`null` = 不写）
 * @param {{t: number}} [options.clock] 注入时钟（可改 `clock.t` 推进时间）
 * @param {(paths: {root: string, dir: string, indexPath: string, auditPath: string}) => object} [options.fsImplOf]
 *   按最终路径造 fs 替身（数 `writeFileSync` 时用）
 */
function makeLibrary({ entries = [], audit = null, clock, fsImplOf } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-desc-'));
  const dir = path.join(root, 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(root, 'qq-stickers.json');
  const auditPath = path.join(root, 'sticker-audit', 'index.jsonl');
  writeIndexFile(indexPath, entries);
  if (typeof audit === 'string') {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.writeFileSync(auditPath, audit);
  }
  const tick = clock ?? { t: T0 };
  const fsImpl = fsImplOf === undefined ? undefined : fsImplOf({ root, dir, indexPath, auditPath });
  // 索引对象显式建出来：`set()` 是**索引**的方法（2026-10-19 起库的包装层也转发同一个调用，
  // 但这里要直接测索引本身 —— harvest 内部调的正是这个 `table.set`）。
  const table = createStickerIndex({
    filePath: indexPath,
    log: () => {},
    now: () => tick.t,
    ...(fsImpl === undefined ? {} : { fsImpl }),
  });
  const library = createStickerLibrary({
    index: table,
    dir,
    indexPath,
    auditPath,
    log: () => {},
    now: () => tick.t,
    ...(fsImpl === undefined ? {} : { fsImpl }),
  });
  return { root, dir, indexPath, auditPath, library, table, clock: tick };
}

/** 一个能真的跑一次 `harvest` 的临时库（注入 `fetchImpl` + `recognize`）。 */
function makeHarvestLibrary(recognize) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-desc-'));
  const dir = path.join(root, 'stickers');
  const indexPath = path.join(root, 'qq-stickers.json');
  const bytes = pngBytes(1);
  // `sub_type: 1` = 收藏的表情包（位判据收下这一张）。
  const segment = {
    type: 'image',
    sub_type: 1,
    summary: '',
    file: 'a.png',
    url: 'https://gchat.qpic.cn/x',
  };
  const library = createStickerLibrary({
    dir,
    indexPath,
    log: () => {},
    now: () => T0,
    fetchImpl: async () => ({
      ok: true,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    }),
    recognize,
  });
  return { root, dir, indexPath, library, segment, bytes };
}

// ================================================================== ① harvest 入库

test('★★ harvest 入库：desc 也进库（以前只写 tags）', async () => {
  const { library, indexPath, segment } = makeHarvestLibrary(
    async () => ({ ok: true, accept: true, desc: '画面描述', tags: ['卖萌可爱'] }),
  );

  const got = await library.harvest([segment], { chatId: 'g', userId: 'u' });
  assert.equal(got.stored, 1);

  const entry = Object.values(JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries)[0];
  assert.equal(entry.desc, '画面描述', 'desc 必须写进索引文件（以前这里只有 tags）');
  assert.deepEqual(entry.tags, ['卖萌可爱'], 'tags 照旧');
  assert.equal(library.all()[0].desc, '画面描述', '库里也读得到');
});

test('★ harvest 入库：desc 两侧空白被 trim（与 tags 同一口径）', async () => {
  const { library, segment } = makeHarvestLibrary(
    async () => ({ ok: true, accept: true, desc: '  画面描述  ', tags: [] }),
  );
  const got = await library.harvest([segment], { chatId: 'g', userId: 'u' });
  assert.equal(got.stored, 1);
  assert.equal(library.all()[0].desc, '画面描述');
});

test('★ harvest 没配 recognize：desc 是空串（不是 undefined）', async () => {
  const { library, segment } = makeHarvestLibrary(null);
  const got = await library.harvest([segment], { chatId: 'g', userId: 'u' });
  assert.equal(got.stored, 1);
  assert.equal(library.all()[0].desc, '');
});

// ================================================================== ② set 的写路径

test('★★ set() 也存 desc 并落盘（回归：只改解析那处 ⇒ 回填跑了但没落库）', () => {
  const X = md5Of(1);
  const { table, indexPath } = makeLibrary({ entries: [] });

  assert.equal(table.set(X, { file: `${X}.png`, desc: '画面描述', tags: ['卖萌可爱'] }), true);
  assert.equal(table.get(X).desc, '画面描述', 'set 之后内存里就该有');

  const onDisk = JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries[X];
  assert.equal(onDisk.desc, '画面描述', 'set 必须把 desc 写进文件 —— 少了这一步，回填会"跑了但没落库"');

  const reopened = createStickerIndex({ filePath: indexPath, log: () => {}, now: () => T0 });
  assert.equal(reopened.get(X).desc, '画面描述', '重新打开（解析路径）也要读得回来');
});

test('★ set() 没给 desc ⇒ 空串（不是 undefined，也不是把旧值留着）', () => {
  const X = md5Of(1);
  const { table } = makeLibrary({ entries: [[X, { desc: '旧描述' }]] });
  // 覆盖写入时 value 里没有 desc ⇒ 落成空串（set 是"写入/覆盖一条"，不是局部更新）
  assert.equal(table.set(X, { file: `${X}.png`, tags: ['卖萌可爱'] }), true);
  assert.equal(table.get(X).desc, '');
});

// ================================================================== ③ 解析路径

test('★★ 解析路径：手写索引里的 desc 读回来保留（并按 textOf 去空白）', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const { library } = makeLibrary({ entries: [[X, { desc: '  画面描述  ' }], [Y, {}]] });

  const all = library.all();
  assert.equal(all.length, 2);
  assert.equal(all[0].desc, '画面描述', 'desc 保留、两侧空白被 trim');
  assert.equal(all[1].desc, '', '老条目（没有 desc 字段）读回来是空串，不是 undefined');
});

test('★ 解析路径：desc 不是字符串（数字/对象/null）⇒ 空串，不炸', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const Z = md5Of(3);
  const { library } = makeLibrary({
    entries: [[X, { desc: 42 }], [Y, { desc: { text: '画面描述' } }], [Z, { desc: null }]],
  });
  for (const entry of library.all()) assert.equal(entry.desc, '');
});

// ================================================================== ④ 一次性回填

test('★★ 一次性回填：pick 把审核表里的 desc 补进库并落盘（已有 desc 不被覆盖）', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const audit = JSON.stringify({ md5: X, desc: '画面描述' });
  const { library, indexPath, dir, auditPath } = makeLibrary({
    entries: [
      [X, { tags: ['卖萌可爱'] }], // desc 空 ⇒ 该被补
      [Y, { tags: ['卖萌可爱'], desc: '已有描述' }], // 不该被覆盖
    ],
    audit,
  });

  assert.equal(library.get(X).desc, '', '回填前是空的');
  assert.ok(library.pick({ tags: ['卖萌可爱'] }) !== null, '有候选就必须挑到一张');

  const after = library.all();
  assert.equal(after.find((e) => e.md5 === X).desc, '画面描述', '空了的那条被补上');
  assert.equal(after.find((e) => e.md5 === Y).desc, '已有描述', '已有 desc 不被审核表覆盖');

  const reopened = createStickerLibrary({ dir, indexPath, auditPath, log: () => {}, now: () => T0 });
  assert.equal(reopened.get(X).desc, '画面描述', '回填必须落盘 —— 重启后不能退回 0 张');
});

test('★★ 回填只做一次：第二次 pick 不再写盘（即使描述表缓存过期、又出现空 desc 条目）', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const clock = { t: T0 };
  const writes = { n: 0 };
  const audit = [
    JSON.stringify({ md5: X, desc: '画面描述' }),
    JSON.stringify({ md5: Y, desc: '新条目的描述' }),
  ].join('\n');
  const { library, table } = makeLibrary({
    entries: [[X, { tags: ['卖萌可爱'] }]],
    audit,
    clock,
    fsImplOf: ({ indexPath: p }) => Object.assign({}, fs, {
      writeFileSync(target, ...rest) {
        // `persist()` 写的是 `<index>.tmp` 再 rename ⇒ 按前缀数
        if (String(target).startsWith(p)) writes.n += 1;
        return fs.writeFileSync(target, ...rest);
      },
    }),
  });

  assert.ok(library.pick({ tags: ['卖萌可爱'] }) !== null);
  assert.equal(writes.n, 1, '第一次 pick 回填并写盘一次');
  assert.equal(library.get(X).desc, '画面描述');

  // 再塞一条 desc 为空的条目：若回填标志没置位，下一次 pick 会把它也补上（多写一次盘）
  table.set(Y, { file: `${Y}.png`, desc: '', tags: ['卖萌可爱'] });
  const baseline = writes.n;

  clock.t = T0 + 61_000; // 越过 60 秒描述表缓存 —— audit 会被重读，确保不是"缓存让它不动"
  assert.ok(library.pick({ tags: ['卖萌可爱'] }) !== null);
  assert.ok(library.pick({ tags: ['卖萌可爱'] }) !== null);
  assert.equal(writes.n, baseline, 'didBackfill 已置位 ⇒ 不再回填、不再写盘');
  assert.equal(library.get(Y).desc, '', '第二次 pick 不会把新条目也补上（回填只做一次）');
});

test('★ 回填不会发生：审核表为空 / 不存在 ⇒ 不写盘、desc 保持空', () => {
  const X = md5Of(1);
  const clock = { t: T0 };
  const writes = { n: 0 };

  const noAudit = makeLibrary({
    entries: [[X, { tags: ['卖萌可爱'] }]],
    audit: null, // 文件不存在
    clock,
    fsImplOf: ({ indexPath: p }) => Object.assign({}, fs, {
      writeFileSync(target, ...rest) {
        if (String(target).startsWith(p)) writes.n += 1;
        return fs.writeFileSync(target, ...rest);
      },
    }),
  });
  assert.ok(noAudit.library.pick({ tags: ['卖萌可爱'] }) !== null);
  assert.equal(writes.n, 0, '没有描述表 ⇒ 一次都不该写盘');
  assert.equal(noAudit.library.get(X).desc, '');

  // 空文件同理
  const emptyAudit = makeLibrary({
    entries: [[X, { tags: ['卖萌可爱'] }]],
    audit: '',
  });
  assert.ok(emptyAudit.library.pick({ tags: ['卖萌可爱'] }) !== null);
  assert.equal(emptyAudit.library.get(X).desc, '');
});

test('★ 回填只补匹配的 md5：审核表里别的图不会串到这张上', () => {
  const X = md5Of(1);
  const ghost = md5Of(9);
  const { library } = makeLibrary({
    entries: [[X, { tags: ['卖萌可爱'] }]],
    audit: [JSON.stringify({ md5: ghost, desc: '别的图' }), JSON.stringify({ md5: X.toUpperCase(), desc: ' 画面描述 ' })].join('\n'),
  });

  assert.ok(library.pick({ tags: ['卖萌可爱'] }) !== null);
  assert.equal(library.get(X).desc, '画面描述', 'md5 大小写/desc 空白都被规整');
  assert.equal(library.all().some((e) => e.md5 === ghost), false, '审核表里的图不能凭空进库');
});
