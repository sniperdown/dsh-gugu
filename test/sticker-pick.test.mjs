/**
 * 表情包「挑」（`pick({tags, mood})`）—— 2026-10-19 新增的那一步。
 *
 * ## 为什么单开一个文件
 *
 * `sticker-library.test.mjs` 盯的是「偷 + 存」（位判据 / md5 去重 / 坏了当空库）；
 * 这一批盯的是**挑**，而挑有两件事**只能靠统计或注入的时钟**才看得见：
 *
 * 1. **加权随机没有"正确的那一张"** —— 只能断言**分布**（跑 200/2000 次看比例）；
 * 2. **描述表 60 秒缓存** —— 只能靠**注入的 `now`** 推进时间，真时钟会让测试变慢且不稳。
 *
 * ## 三条硬约束（这组测试自己也要守）
 *
 * - **不读本机真实数据**：所有用例都在 `mkdtemp` 出来的临时目录里，
 *   `indexPath` / `auditPath` / `dir` 全部显式注入（默认值指向 `<DSH_HOME>\media\…`）。
 * - **不断言具体 md5**（除了"只会挑到某一张"的标签唯一场景）：加权随机的单次结果不固定。
 * - **统计断言给足余量**：期望 80% 的断言只要求 > 60%，期望 50% 的只要求 > 30% ——
 *   二项分布在 200 次上的标准差约 5~7，留 4 个标准差以上的余量就不 flaky。
 *   另有两条用**确定性扫描**（把 `Math.random` 固定在均匀网格上）验证权重本身，
 *   它们不依赖运气，能精确证明 50/25/25 这类比例。
 *
 * ## ⚠️ 全局 `Math.random` 只在【同步区间】里替换
 *
 * `run-all-tests.mjs` 是**单进程串行 import**：本文件的测试可能与别的文件的测试交错执行。
 * 所以所有替换都发生在**一段纯同步代码**里（`try/finally` 恢复），中间没有 `await`，
 * 事件循环不可能把别的测试插进来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { STICKER_INDEX_VERSION, createStickerLibrary } from '../src/dsh/sticker-library.mjs';

// ------------------------------------------------------------------ 夹具

/** 注入时钟的起点（固定值，与真时钟无关）。 */
const T0 = Date.UTC(2026, 9, 19, 0, 0, 0);

/** 一个像 md5 但**一定不是**整数索引形式的键（32 位十六进制，首位是字母）。 */
const md5Of = (i) => `a${i.toString(16).padStart(31, '0')}`;

/**
 * 造一份索引 JSON。`entries` 是 `[md5, {tags, …}]` 的数组。
 *
 * ⚠️ 数组顺序 = 索引里的顺序 = `table.all()` 的顺序。
 * 需要"固定随机数下一定挑到第二张"的用例（缓存那组）依赖这个顺序。
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
 * @param {boolean} [options.writeIndex] `false` = **不写**索引文件（模拟"库空/文件不存在"）
 * @param {string|null} [options.audit] audit jsonl 的内容（`null` = 不写）
 * @param {string} [options.auditPath] 覆盖 audit 路径（`''` = 明确不读）
 * @param {{t: number}} [options.clock] 注入的时钟（测试里可以改 `clock.t` 推进时间）
 * @param {object} [options.fsImpl] 直接注入 fs 替身
 * @param {(paths: object) => object} [options.fsImplOf] 按最终路径造 fs 替身（要按 audit 路径计数时用）
 */
function makeLibrary({
  entries = [],
  writeIndex = true,
  audit = null,
  auditPath: auditPathOverride,
  clock,
  fsImpl,
  fsImplOf,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-pick-'));
  const dir = path.join(root, 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(root, 'qq-stickers.json');
  const auditPath = auditPathOverride === undefined
    ? path.join(root, 'sticker-audit', 'index.jsonl')
    : auditPathOverride;
  if (writeIndex) writeIndexFile(indexPath, entries);
  if (typeof audit === 'string' && auditPath !== '') {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.writeFileSync(auditPath, audit);
  }
  const tick = clock ?? { t: T0 };
  const fsImplFinal = fsImplOf === undefined ? fsImpl : fsImplOf({ root, dir, indexPath, auditPath });
  const library = createStickerLibrary({
    dir,
    indexPath,
    auditPath,
    log: () => {},
    now: () => tick.t,
    ...(fsImplFinal === undefined ? {} : { fsImpl: fsImplFinal }),
  });
  return { root, dir, indexPath, auditPath, library, clock: tick };
}

/** 数 audit 被读了几次的 fs 替身（其余全部转发给真 fs，索引照常读）。 */
function countingAuditFs(auditPath, counts) {
  return Object.assign({}, fs, {
    readFileSync(target, ...rest) {
      if (String(target) === auditPath) counts.audit += 1;
      return fs.readFileSync(target, ...rest);
    },
  });
}

/**
 * 把全局 `Math.random` 固定成一个值再调一次 `pick`（**纯同步**，`finally` 恢复）。
 *
 * 用来把"加权随机"变成**确定性**断言：权重 4:1 时 r=0.7 ⇒ 一定落在 X；
 * 权重 1:1 时 r=0.7 ⇒ 一定落在**第二张**。
 */
function pickWithRandom(library, random, options) {
  const original = Math.random;
  try {
    Math.random = () => random;
    return library.pick(options);
  } finally {
    Math.random = original;
  }
}

/**
 * 确定性扫描：让 `Math.random` 依次取 `(i+0.5)/steps`，跑 `steps` 次。
 *
 * 这样每个条目被命中的次数**恰好正比于它的权重**（间隔长度 = weight/total），
 * 于是 50/25/25 这类比例可以被精确断言，完全没有运气成分。
 */
function sweepPicks(library, options, steps = 2000) {
  const original = Math.random;
  const hits = new Map();
  try {
    for (let i = 0; i < steps; i += 1) {
      Math.random = () => (i + 0.5) / steps;
      const picked = library.pick(options);
      const key = picked === null ? '<null>' : picked.md5;
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  } finally {
    Math.random = original;
  }
  return hits;
}

/** 按 md5 集合把扫描结果分成两类求和。 */
function sumHits(hits, keys) {
  let n = 0;
  for (const [key, count] of hits) if (keys.has(key)) n += count;
  return n;
}

const moodAudit = (x, y) => [
  JSON.stringify({ md5: x, desc: '熊猫头皱眉叹气' }),
  JSON.stringify({ md5: y, desc: '' }), // desc 空 —— 不算描述
  `{"md5": "${y}", "desc": "皱眉`, // 坏行（追加写的日志尾部半行很常见）
].join('\n');

// ================================================================== ① 描述表（间接效果）

test('★★ 描述表：有 desc 的那张在 mood 贴合时明显更容易被挑到（200 次统计）', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const { library } = makeLibrary({
    entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]],
    audit: moodAudit(X, Y),
  });

  const counts = { [X]: 0, [Y]: 0 };
  for (let i = 0; i < 200; i += 1) {
    const picked = library.pick({ tags: ['开心'], mood: '皱眉叹气' });
    assert.ok(picked !== null, '有候选就必须挑到一张');
    counts[picked.md5] += 1;
  }

  // 理论：X 权重 1+3×1=4、Y 权重 1 ⇒ X 应占 160/200（80%）。
  // 断言只要求 > 120（60%），距离"没加分时的 100"有近 3 个标准差。
  assert.equal(counts[X] + counts[Y], 200, '每次挑到的都得是这两张之一');
  assert.ok(counts[X] > 120, `贴合的 X 应明显更容易被挑到（实测 ${counts[X]}/200，理论 160）`);
  assert.ok(counts[X] > counts[Y] * 2, `有描述的应是没描述的两倍以上（实测 ${counts[X]} vs ${counts[Y]}）`);
});

test('★ 描述表：同一份库不给 mood 时两张大致均分（对照，证明加分来自 mood）', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const { library } = makeLibrary({
    entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]],
    audit: moodAudit(X, Y),
  });

  let x = 0;
  for (let i = 0; i < 200; i += 1) {
    const picked = library.pick({ tags: ['开心'] }); // 没有 mood
    assert.ok(picked !== null);
    if (picked.md5 === X) x += 1;
  }
  // 均分：100 ± 7（sd）；50~150 是 7 个标准差，不会 flaky。
  assert.ok(x > 50 && x < 150, `没有 mood 时不该偏（实测 X=${x}/200，理论 100）`);
});

// ================================================================== ② 反比加权

test('★★ 反比加权：A 类 20 张、B 类 2 张，B 的命中率应显著高于按张数的 9%（200 次统计）', () => {
  const entries = [];
  for (let i = 0; i < 20; i += 1) entries.push([md5Of(i), { tags: ['A'] }]);
  for (let i = 0; i < 2; i += 1) entries.push([md5Of(100 + i), { tags: ['B'] }]);
  const bIds = new Set(entries.slice(20).map(([md5]) => md5));
  const { library } = makeLibrary({ entries });

  let b = 0;
  for (let i = 0; i < 200; i += 1) {
    const picked = library.pick({ tags: ['A', 'B'] });
    assert.ok(picked !== null);
    if (bIds.has(picked.md5)) b += 1;
  }

  // 不反比的话 B 只占 2/22 ≈ 9%；反比后两类**总权重相等** ⇒ 理论 50%（100/200）。
  // 断言只要 > 30%，离 9% 和 50% 都很远（sd≈7）。
  assert.ok(b > 60, `B 类应远高于"按张数"的 9%（实测 ${b}/200，理论 100）`);
  assert.equal(b <= 200, true);
});

test('★★ 反比加权（确定性扫描）：两类总权重相等 ⇒ 精确各占一半', () => {
  const entries = [];
  for (let i = 0; i < 20; i += 1) entries.push([md5Of(i), { tags: ['A'] }]);
  for (let i = 0; i < 2; i += 1) entries.push([md5Of(100 + i), { tags: ['B'] }]);
  const bIds = new Set(entries.slice(20).map(([md5]) => md5));
  const { library } = makeLibrary({ entries });

  const hits = sweepPicks(library, { tags: ['A', 'B'] }, 2000);
  const b = sumHits(hits, bIds);
  // 精确：B 总权重 = 2×(1/2) = 1；A 总权重 = 20×(1/20) = 1 ⇒ B 占 1/2。
  assert.ok(Math.abs(b / 2000 - 0.5) < 0.02, `B 应占约 50%（实测 ${b}/2000）；按张数加权只有 9%`);
});

test('★ 一个条目匹配两个标签 ⇒ 拿到两份反比贡献（1:1 的库 ⇒ 50/25/25）', () => {
  const E1 = md5Of(1); // 同时有 A、B
  const E2 = md5Of(2); // 只有 A
  const E3 = md5Of(3); // 只有 B
  const { library } = makeLibrary({
    entries: [
      [E1, { tags: ['A', 'B'] }],
      [E2, { tags: ['A'] }],
      [E3, { tags: ['B'] }],
    ],
  });

  // 全库 A=2 张、B=2 张 ⇒ E1 权重 1/2+1/2 = 1，E2 = 1/2，E3 = 1/2，总权重 2。
  const hits = sweepPicks(library, { tags: ['A', 'B'] }, 2000);
  assert.ok(Math.abs((hits.get(E1) ?? 0) / 2000 - 0.5) < 0.02, '两个标签各贡献一份 ⇒ E1 约 50%');
  assert.ok(Math.abs((hits.get(E2) ?? 0) / 2000 - 0.25) < 0.02, 'E2 约 25%');
  assert.ok(Math.abs((hits.get(E3) ?? 0) / 2000 - 0.25) < 0.02, 'E3 约 25%');
});

// ================================================================== ③ 边界

test('★ 库空（索引文件不存在）⇒ pick 返回 null，不抛', () => {
  const { library } = makeLibrary({ writeIndex: false });
  assert.equal(library.all().length, 0);
  assert.equal(library.pick(), null);
  assert.equal(library.pick({ tags: ['开心'] }), null);
  assert.equal(library.pick({ tags: ['开心'], mood: '皱眉叹气' }), null);
});

test('★ 库空（索引存在但 entries 为空）⇒ pick 返回 null', () => {
  const { library } = makeLibrary({ entries: [] });
  assert.equal(library.pick({ tags: [] }), null);
  assert.equal(library.pick({ mood: '开心' }), null);
});

test('★ 标签不匹配 ⇒ null（别乱给一张）', () => {
  const X = md5Of(1);
  const { library } = makeLibrary({ entries: [[X, { tags: ['开心'] }]] });
  assert.equal(library.pick({ tags: ['不存在的标签'] }), null);
  assert.equal(library.pick({ tags: ['开心', '不存在的标签'] }).md5, X, '匹配任一即可');
});

test('★ tags 空 / 不传 = 全库（不是"没有候选"）', () => {
  const entries = [];
  for (let i = 0; i < 3; i += 1) entries.push([md5Of(i), { tags: [] }]);
  const { library } = makeLibrary({ entries });

  for (const options of [undefined, {}, { tags: [] }]) {
    const picked = library.pick(options);
    assert.ok(picked !== null, 'tags 空 = 全库，一定有得挑');
    assert.ok(entries.some(([md5]) => md5 === picked.md5));
  }

  const seen = new Set();
  for (let i = 0; i < 60; i += 1) seen.add(library.pick({ tags: [] }).md5);
  assert.ok(seen.size >= 2, `全库随机应能挑到多张（实测出现 ${seen.size} 种）`);
});

test('★ tags 传非数组 ⇒ 当成"全库"（不能让一个坏参数把挑变成 null）', () => {
  const A = md5Of(1);
  const B = md5Of(2);
  const { library } = makeLibrary({ entries: [[A, { tags: ['A'] }], [B, { tags: ['B'] }]] });

  for (const bad of ['B', 42, null, { 0: 'A' }]) {
    const seen = new Set();
    for (let i = 0; i < 60; i += 1) {
      const picked = library.pick({ tags: bad });
      assert.ok(picked !== null, `tags=${String(bad)} 应按"全库"处理`);
      seen.add(picked.md5);
    }
    // 若错误地按字符串过滤，这两个 tag 只能命中一张（或 null）；两种都会让 seen.size === 1。
    assert.equal(seen.size, 2, `tags=${String(bad)} 被当成全库，两张都该能出现`);
  }
});

test('★ tags 里带空白 / 非字符串 ⇒ String + trim 后照常过滤', () => {
  const A = md5Of(1); // tag 'B'
  const B = md5Of(2); // tag 'A'
  const { library } = makeLibrary({ entries: [[A, { tags: ['B'] }], [B, { tags: ['A'] }]] });

  for (let i = 0; i < 100; i += 1) {
    assert.equal(library.pick({ tags: ['  B  '] }).md5, A, '两边的空白都被 trim');
    assert.equal(library.pick({ tags: [' B ', ''] }).md5, A, '空串被丢掉');
  }
  assert.equal(library.pick({ tags: [42] }), null, '数字会变成字符串 "42"，库里没有 ⇒ null');
  // 非字符串的 tag 不能把正常标签一起弄坏
  assert.equal(library.pick({ tags: ['A', 42] }).md5, B);
});

test('★ mood 传非字符串 / 空 ⇒ 不抛，等价"没有 mood"', () => {
  const X = md5Of(1);
  const { library } = makeLibrary({ entries: [[X, { tags: ['开心'] }]] });

  for (const mood of [12345, 0, null, undefined, {}, ['皱眉叹气'], true, '   ']) {
    assert.doesNotThrow(() => library.pick({ tags: ['开心'], mood }));
    const picked = library.pick({ tags: ['开心'], mood });
    assert.ok(picked !== null);
    assert.equal(picked.md5, X);
  }
});

test('★ md5 不是 pick 的参数：传了也被忽略（挑到的仍一定在库里）', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const ghost = 'f'.repeat(32);
  const { library } = makeLibrary({ entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]] });

  for (let i = 0; i < 50; i += 1) {
    const picked = library.pick({ tags: ['开心'], md5: ghost });
    assert.ok(picked !== null, 'pick 不认 md5，传了也不能变成 null');
    assert.notEqual(picked.md5, ghost);
    assert.ok(library.get(picked.md5) !== null, '挑到的 md5 一定在库里');
  }
});

test('★ 返回的是一条**快照**：改返回值不影响库内部', () => {
  const X = md5Of(1);
  const { library } = makeLibrary({ entries: [[X, { tags: ['开心'] }]] });

  const picked = library.pick({ tags: ['开心'] });
  assert.equal(picked.md5, X);
  assert.deepEqual(picked.tags, ['开心']);
  assert.equal(typeof picked.file, 'string');
  assert.equal(typeof picked.source, 'object');

  picked.tags.push('伪造');
  picked.uses = 999;
  picked.source.chatId = '伪造的群';
  picked.file = '伪造.png';

  const stored = library.get(X);
  assert.deepEqual(stored.tags, ['开心'], '改快照不该改到库里');
  assert.equal(stored.uses, 0);
  assert.equal(stored.source.chatId, '');
  assert.equal(stored.file, `${X}.png`);
});

test('★ 标签唯一时一定挑到那张（权重再随机也只有一个候选）', () => {
  const A = md5Of(1); // tag 'A'
  const B = md5Of(2); // tag 'B'
  const { library } = makeLibrary({ entries: [[A, { tags: ['A'] }], [B, { tags: ['B'] }]] });

  for (let i = 0; i < 100; i += 1) {
    assert.equal(library.pick({ tags: ['B'] }).md5, B);
  }
});

// ================================================================== ④ 描述表 60 秒缓存

test('★★ 缓存：60 秒内改 audit 文件不生效（而且根本不重读）', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const clock = { t: T0 };
  const counts = { audit: 0 };
  const { library, auditPath } = makeLibrary({
    entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]],
    audit: moodAudit(X, Y),
    clock,
    fsImplOf: ({ auditPath: p }) => countingAuditFs(p, counts),
  });
  const options = { tags: ['开心'], mood: '皱眉叹气' };

  // 首次：权重 4:1 ⇒ 固定 r=0.7 一定落在 X（这一条同时证明描述被用上了）。
  assert.equal(pickWithRandom(library, 0.7, options).md5, X, '有描述 ⇒ 权重 4:1 ⇒ X');
  assert.equal(counts.audit, 1, '首次读一次 audit');

  // 同一秒内把 audit 改成"X 没描述、Y 拿到一句贴合的"。
  // ⚠️ 第一次 pick 已经把 X 的 desc 回填进库了（条目自带优先），所以 X 的权重不随 audit 变；
  //    但 Y 若读到新表就会拿到 4 分（和 X 打平，固定 r=0.7 会落在第二张 Y）
  //    ⇒ 这次仍挑到 X，才证明用的是缓存里的旧表。
  fs.writeFileSync(auditPath, [
    JSON.stringify({ md5: X, desc: '' }),
    JSON.stringify({ md5: Y, desc: '皱眉叹气' }),
  ].join('\n'));

  clock.t = T0 + 30_000; // 30 秒 —— 仍在 60 秒缓存窗口内
  assert.equal(
    pickWithRandom(library, 0.7, options).md5,
    X,
    '缓存窗口内必须还是旧表（否则 Y 拿到描述、权重打平，这次会挑到 Y）',
  );
  assert.equal(counts.audit, 1, '窗口内根本不重读文件（改文件"没被看见"）');
});

test('★★ 缓存：把注入的 now 推进 61 秒后能读到新内容', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const clock = { t: T0 };
  const counts = { audit: 0 };
  const { library, auditPath } = makeLibrary({
    entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]],
    audit: moodAudit(X, Y),
    clock,
    fsImplOf: ({ auditPath: p }) => countingAuditFs(p, counts),
  });

  const options = { tags: ['开心'], mood: '皱眉叹气' };
  assert.equal(pickWithRandom(library, 0.7, options).md5, X);
  assert.equal(counts.audit, 1, '第一次读 audit');

  // 改写文件（Y 换上一句贴合的），但**还在缓存窗口内**。
  // ⚠️ X 的 desc 在第一次 pick 时已被回填进库（条目自带优先），所以它不随 audit 变。
  fs.writeFileSync(auditPath, [
    JSON.stringify({ md5: X, desc: '' }),
    JSON.stringify({ md5: Y, desc: '皱眉叹气' }),
  ].join('\n'));
  clock.t = T0 + 30_000;
  assert.equal(pickWithRandom(library, 0.7, options).md5, X, '窗口内仍是旧表（Y 没有描述 ⇒ X 权重 4:1）');
  assert.equal(counts.audit, 1, '窗口内不重读文件');

  clock.t = T0 + 61_000; // 越过 60 秒
  assert.equal(
    pickWithRandom(library, 0.7, options).md5,
    Y,
    '新表里 Y 也拿到描述 ⇒ 权重 4:4 打平 ⇒ 固定 r=0.7 落在第二张 Y',
  );
  assert.equal(counts.audit, 2, '过期后重读一次');
});

test('★ 缓存边界：59 999ms 仍用旧表，60 000ms 整重读', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const clock = { t: T0 };
  const counts = { audit: 0 };
  const { library, auditPath } = makeLibrary({
    entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]],
    audit: moodAudit(X, Y),
    clock,
    fsImplOf: ({ auditPath: p }) => Object.assign({}, fs, {
      readFileSync(target, ...rest) {
        if (String(target) === p) counts.audit += 1;
        return fs.readFileSync(target, ...rest);
      },
    }),
  });
  const options = { tags: ['开心'], mood: '皱眉叹气' };

  library.pick(options);
  assert.equal(counts.audit, 1);

  clock.t = T0 + 59_999;
  library.pick(options);
  assert.equal(counts.audit, 1, '差 1ms 不该过期');

  clock.t = T0 + 60_000;
  fs.writeFileSync(auditPath, JSON.stringify({ md5: Y, desc: '皱眉叹气' })); // 内容也换掉
  library.pick(options);
  assert.equal(counts.audit, 2, '整 60 秒就该重读（不是"大于 60 秒"）');
});

// ================================================================== ⑤ 永不抛

test('★ auditPath 指向不存在的文件 ⇒ 照常挑（只是没有描述加分）', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const { library, auditPath } = makeLibrary({
    entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]],
    audit: null, // 不写文件
  });
  assert.equal(fs.existsSync(auditPath), false, '确认文件真的不存在');

  for (let i = 0; i < 50; i += 1) {
    const picked = library.pick({ tags: ['开心'], mood: '皱眉叹气' });
    assert.ok(picked !== null);
    assert.ok([X, Y].includes(picked.md5));
  }
});

test('★ fsImpl.readFileSync 抛错 ⇒ 照常挑（描述读不到不该让发表情包失败）', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const { library } = makeLibrary({
    entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]],
    audit: moodAudit(X, Y),
    fsImplOf: ({ auditPath }) => Object.assign({}, fs, {
      readFileSync(target, ...rest) {
        if (String(target) === auditPath) {
          const error = new Error('EPERM: operation not permitted');
          error.code = 'EPERM';
          throw error;
        }
        return fs.readFileSync(target, ...rest);
      },
    }),
  });

  for (let i = 0; i < 50; i += 1) {
    const picked = library.pick({ tags: ['开心'], mood: '皱眉叹气' });
    assert.ok(picked !== null);
    assert.ok([X, Y].includes(picked.md5));
  }
});

test('★ audit 读回来的不是文本（undefined / Buffer 坏内容）⇒ 照常挑', () => {
  const X = md5Of(1);
  for (const broken of [undefined, 123, Buffer.from('这不是 JSON\n'), '']) {
    const { library } = makeLibrary({
      entries: [[X, { tags: ['开心'] }]],
      fsImplOf: ({ auditPath }) => Object.assign({}, fs, {
        readFileSync(target, ...rest) {
          if (String(target) === auditPath) return broken;
          return fs.readFileSync(target, ...rest);
        },
      }),
    });
    const picked = library.pick({ tags: ['开心'], mood: '皱眉叹气' });
    assert.ok(picked !== null, `坏内容 ${String(broken)} 不能让它挑不出来`);
    assert.equal(picked.md5, X);
  }
});

test('★ auditPath 为空串 ⇒ 完全不读 audit 文件', () => {
  const X = md5Of(1);
  const counts = { all: 0 };
  const { library } = makeLibrary({
    entries: [[X, { tags: ['开心'] }]],
    auditPath: '',
    fsImplOf: () => Object.assign({}, fs, {
      readFileSync(target, ...rest) {
        counts.all += 1;
        return fs.readFileSync(target, ...rest);
      },
    }),
  });
  assert.equal(counts.all, 1, '构造时读了索引');

  for (let i = 0; i < 20; i += 1) {
    assert.equal(library.pick({ tags: ['开心'], mood: '皱眉叹气' }).md5, X);
  }
  assert.equal(counts.all, 1, 'auditPath 空 ⇒ 一次都不该读');
});

test('★ 坏行 / 空 desc / 非对象行都被跳过，不影响好行生效', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const garbage = [
    '这不是 JSON',
    JSON.stringify({ md5: Y, desc: '   ' }), // desc 只有空白
    JSON.stringify({ desc: '皱眉叹气' }), // 没有 md5
    '[]',
    'null',
    '123',
    '""',
    '',
  ].join('\n');

  // ① 只有坏行 ⇒ 等于没有描述表 ⇒ 1:1 ⇒ 固定 r=0.7 落在第二张 Y
  const onlyGarbage = makeLibrary({
    entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]],
    audit: garbage,
  });
  assert.equal(pickWithRandom(onlyGarbage.library, 0.7, { tags: ['开心'], mood: '皱眉叹气' }).md5, Y);

  // ② 坏行中间夹一条好行 ⇒ 好行照样生效（4:1 ⇒ 固定 r=0.7 落在 X）
  const mixed = makeLibrary({
    entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]],
    audit: `${garbage}\n${JSON.stringify({ md5: X, desc: '皱眉叹气' })}`,
  });
  assert.equal(pickWithRandom(mixed.library, 0.7, { tags: ['开心'], mood: '皱眉叹气' }).md5, X);
});

test('★ 同一个 md5 有多条记录 ⇒ 后写的覆盖先写的', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const options = { tags: ['开心'], mood: '皱眉叹气' };

  const first = makeLibrary({
    entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]],
    audit: JSON.stringify({ md5: X, desc: '皱眉叹气' }),
  });
  assert.equal(pickWithRandom(first.library, 0.7, options).md5, X, '只有一条好记录时 X 有加分');

  const overridden = makeLibrary({
    entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]],
    audit: [
      JSON.stringify({ md5: X, desc: '皱眉叹气' }),
      JSON.stringify({ md5: X, desc: '完全不相关' }), // 后写的赢
    ].join('\n'),
  });
  assert.equal(
    pickWithRandom(overridden.library, 0.7, options).md5,
    Y,
    '后写的那条覆盖了先写的 ⇒ X 没有加分 ⇒ 1:1 ⇒ 第二张 Y',
  );
});

test('★ 描述表的 md5 大小写、desc 前后空白都被规整', () => {
  const X = md5Of(1);
  const Y = md5Of(2);
  const { library } = makeLibrary({
    entries: [[X, { tags: ['开心'] }], [Y, { tags: ['开心'] }]],
    audit: JSON.stringify({ md5: X.toUpperCase(), desc: '  皱眉叹气  ' }),
  });
  assert.equal(
    pickWithRandom(library, 0.7, { tags: ['开心'], mood: '皱眉叹气' }).md5,
    X,
    'audit 里的 md5 大写也能对上库里的键，desc 两侧空白被 trim',
  );
});
