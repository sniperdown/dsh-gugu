/**
 * 表情包「挑」的时间衰减（半衰期）—— 2026-11-18，方案 §1。
 *
 * 文件：[`shared/2026-11-18-表情包打分方案.md`](../../shared/2026-11-18-表情包打分方案.md) §1.6-A。
 *
 * ## 这一组盯的是什么
 *
 * `weight = 标签权重 × 描述贴合 × factor`，其中
 * `factor = 1 - (1-floor)·2^(-Δ/H)`。所以有**两类断言**：
 *
 * 1. **纯函数级**（`halfLifeFactor`）：给的六个参照值直接当断言表；
 * 2. **分布级**（真跑 `pick`）：把 `Math.random` 钉在均匀网格上扫一遍，
 *    断言命中比例 ≈ 权重之比 —— 这才证明那个乘数**真的进了挑的那条路**，
 *    而不只是"函数算得对、没人调它"。
 *
 * ## 三条必须自己守的纪律
 *
 * - **不读本机真实数据**：每个用例都在 `mkdtemp` 里，`indexPath` / `auditPath` / `dir` 全显式注入；
 *   连 `[sticker_pick]` 的参数也**显式传**（`stickerPick`）—— 只有专门测"toml 接线"的那两条
 *   才用 `QQ_GUGU_TOML` 指向临时文件。
 * - **`Math.random` 只在同步区间里替换**（`run-all-tests.mjs` 是单进程串行 import，
 *   中间不能有 `await`，否则别的文件的测试会被插进来）。
 * - **不碰 `now` 以外的时钟**：所有"多久之前"都由注入的时钟算出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStickerLibrary, STICKER_INDEX_VERSION } from '../src/dsh/sticker-library.mjs';
import {
  DEFAULT_STICKER_PICK,
  STICKER_PICK_CLAMPS,
  halfLifeFactor,
  loadStickerPickConfig,
  normalizeStickerPick,
} from '../src/dsh/sticker-pick.mjs';

// ------------------------------------------------------------------ 夹具

/** 注入时钟的起点（固定值，与真时钟无关）。 */
const T0 = Date.UTC(2026, 10, 18, 0, 0, 0);
const DAY = 86_400_000;

/** `days` 天前那一刻的 ISO 串（相对 T0）。 */
const ago = (days) => new Date(T0 - days * DAY).toISOString();

const md5Of = (i) => `b${i.toString(16).padStart(31, '0')}`;

/** 造一份索引文件（`entries` 是 `[md5, {...}]` 数组；数组顺序 = 库里的顺序）。 */
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
 * 一个隔离的库。
 *
 * ⚠️ `stickerPick` **默认显式传默认值** —— 不让用例偷偷去读本机那份 toml
 * （只有两条专门测接线的用例才通过 `QQ_GUGU_TOML` 指向临时文件）。
 */
function makeLibrary({ entries = [], clock, stickerPick = DEFAULT_STICKER_PICK } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-decay-'));
  const dir = path.join(root, 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(root, 'qq-stickers.json');
  writeIndexFile(indexPath, entries);
  const tick = clock ?? { t: T0 };
  const library = createStickerLibrary({
    dir,
    indexPath,
    auditPath: path.join(root, 'sticker-audit', 'index.jsonl'),
    log: () => {},
    now: () => tick.t,
    stickerPick,
    candidates: null, // 这一组不关心候选表，明确关掉（免得每个用例多写一份文件）
  });
  return { root, dir, indexPath, library, clock: tick };
}

/**
 * 确定性扫描：`Math.random` 依次取 `(i+0.5)/steps`，跑 `steps` 次。
 *
 * 每个条目被命中的次数**恰好正比于它的权重**（间隔长度 = weight/total），
 * 于是"0.300 : 0.405 : 0.650"这类比例可以被精确断言，完全没有运气成分。
 */
function sweepPicks(library, options, steps = 3000) {
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

// ================================================================== ① 纯函数：六个参照值

test('★★ 半衰期参照值（H=30、floor=0.3）：刚发出 0.300 / 1 天 0.316 / 7 天 0.405 / 30 天 0.650 / 90 天 0.913', () => {
  const H = { halfLifeDays: 30, recentFloor: 0.3 };
  const cases = [
    [0, 0.300],
    [1, 0.316],
    [7, 0.405],
    [30, 0.650],
    [60, 0.825],
    [90, 0.913],
    [180, 0.989],
  ];
  for (const [days, expected] of cases) {
    const got = halfLifeFactor(ago(days), T0, H);
    assert.ok(
      Math.abs(got - expected) < 0.001,
      `${days} 天前的应约 ${expected}（实测 ${got.toFixed(4)}）`,
    );
  }
  // 端点：刚发出必须**恰好**是 floor（这一条是"floor 真的是下限"的定义）
  assert.ok(Math.abs(halfLifeFactor(ago(0), T0, H) - 0.3) < 1e-9);
  // 端点是"越来越接近 1、但只有真的没发过才是 1.0"。⚠️ 2^(-3650/30) 会下溢成 0，
  // 于是浮点上它**就是** 1.0 —— 所以这里断言上界是 `<= 1`，不是 `< 1`。
  assert.ok(halfLifeFactor(ago(3650), T0, H) <= 1);
  assert.ok(halfLifeFactor(ago(3650), T0, H) > 0.999);
  assert.ok(halfLifeFactor(ago(370), T0, H) < 1, '370 天不该已经变成 1.0');
});

test('★★★ `lastUsedAt` 为空 ⇒ **恰好** 1.0；而且**绝不回退 `entry.at`**', () => {
  const H = { halfLifeDays: 30, recentFloor: 0.3 };
  // ① 空 / null / 空白 / 非字符串 ⇒ 1.0（"从没发过" = 不压）
  for (const empty of [null, undefined, '', '   ', 0, 12345, {}, []]) {
    assert.equal(halfLifeFactor(empty, T0, H), 1, `lastUsedAt=${JSON.stringify(empty)} 必须给 1.0`);
  }

  // ② 非法日期 ⇒ 1.0（**不是 NaN**）。NaN 会让权重总和变 NaN ⇒ pick 静默退化成均匀随机
  //    （方案 §5 风险 11），那时"还能发图"，只是挑得变差 —— 看不出来。
  for (const bad of ['不是日期', '2026-13-45T99:99:99Z', 'yesterday']) {
    const got = halfLifeFactor(bad, T0, H);
    assert.equal(Number.isFinite(got), true, `非法日期 ${bad} 不能算出 NaN/Infinity`);
    assert.equal(got, 1, `非法日期 ${bad} 按"没有信息"处理 ⇒ 1.0`);
  }

  // ③ **不回退到 `at`** 的分布级判据：
  //    A 从没发过（`at` = 就是现在，最"新"的入库时间），B 一天前发过。
  //    正确权重 1.0 : 0.316 ⇒ A 占 76.0%；
  //    若有人"顺手"拿 `at` 兜底，A 会拿到 0.300 ⇒ 变成 77.0%… 仍接近，所以这里换成
  //    更极端的对照：C 从没发过但 `at` 是 400 天前。
  //    ⇒ 正确权重 1.0 : 1.0 : 0.316（A、C 都 1.0）；拿 `at` 兜底的话 C 只有 0.989，
  //    虽然也接近 1，但**A 与 C 会不等** —— 它们必须严格相等，这就是那条判据。
  const A = md5Of(1);
  const B = md5Of(2);
  const C = md5Of(3);
  const { library } = makeLibrary({
    entries: [
      [A, { tags: ['开心'], lastUsedAt: null, at: new Date(T0).toISOString() }],
      [B, { tags: ['开心'], lastUsedAt: ago(1) }],
      [C, { tags: ['开心'], lastUsedAt: null, at: ago(400) }],
    ],
    stickerPick: H,
  });
  const hits = sweepPicks(library, { tags: ['开心'] }, 3000);
  const a = hits.get(A) ?? 0;
  const c = hits.get(C) ?? 0;
  assert.equal(a + c + (hits.get(B) ?? 0), 3000);
  // A 与 C 权重完全相等 ⇒ 命中次数只差 ±1（扫描网格的取整）
  assert.ok(Math.abs(a - c) <= 1, `从没发过的两张权重必须相等（A=${a}、C=${c}）—— 用 \`at\` 兜底会不等`);
  // 而且 B（一天前发过）明显更冷：理论 0.316/2.316 ⇒ 13.6%
  const bShare = (hits.get(B) ?? 0) / 3000;
  assert.ok(Math.abs(bShare - 0.1364) < 0.02, `一天前发过的应约占 13.6%（实测 ${(bShare * 100).toFixed(1)}%）`);
});

test('★★ `halfLifeDays: 0` ⇒ 关掉：factor 恒 1.0，分布与"全都没发过"逐点一致（回退判据）', () => {
  const H = { halfLifeDays: 0, recentFloor: 0.3 };
  for (const days of [0, 1, 7, 30, 365]) {
    assert.equal(halfLifeFactor(ago(days), T0, H), 1, `${days} 天前也应恒 1.0`);
  }

  // 分布级：三条同标签、`lastUsedAt` 分别是 0/7/30 天前；H=0 时应当各 1/3
  const entries = [
    [md5Of(1), { tags: ['开心'], lastUsedAt: ago(0) }],
    [md5Of(2), { tags: ['开心'], lastUsedAt: ago(7) }],
    [md5Of(3), { tags: ['开心'], lastUsedAt: ago(30) }],
  ];
  const off = sweepPicks(makeLibrary({ entries, stickerPick: H }).library, { tags: ['开心'] }, 3000);
  for (const index of [1, 2, 3]) {
    const share = (off.get(md5Of(index)) ?? 0) / 3000;
    assert.ok(Math.abs(share - 1 / 3) < 0.02, `H=0 时三张应各占 1/3（实测 ${(share * 100).toFixed(1)}%）`);
  }

  // 回退判据：与"把 lastUsedAt 全抹掉"的库**逐点一致**（同一份网格、同一次扫描）
  const baseline = sweepPicks(
    makeLibrary({
      entries: entries.map(([md5, extra]) => [md5, { ...extra, lastUsedAt: null }]),
      stickerPick: H,
    }).library,
    { tags: ['开心'] },
    3000,
  );
  assert.deepEqual([...off.entries()].sort(), [...baseline.entries()].sort(), 'H=0 必须与"没有时间信息"逐点相同');
});

test('★★ 三道乘法叠起来：标签权重 × 描述贴合 × 半衰期（谁乘谁不能乱）', () => {
  // 两条同标签：X 有贴合的描述（×4），但**刚发过**（×0.3）；Y 没描述，从没发过（×1.0）。
  // 权重 = 4×0.3 = 1.2 : 1 ⇒ X 占 54.5%。若半衰期被**替换**成描述系数、
  // 或者漏乘，比例会掉到 80%（= 描述那一档的原值）。
  const X = md5Of(1);
  const Y = md5Of(2);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-decay-'));
  const dir = path.join(root, 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(root, 'qq-stickers.json');
  const auditPath = path.join(root, 'sticker-audit', 'index.jsonl');
  writeIndexFile(indexPath, [
    [X, { tags: ['开心'], desc: '熊猫头皱眉叹气', lastUsedAt: ago(0) }],
    [Y, { tags: ['开心'], lastUsedAt: null }],
  ]);
  const library = createStickerLibrary({
    dir,
    indexPath,
    auditPath,
    log: () => {},
    now: () => T0,
    stickerPick: { halfLifeDays: 30, recentFloor: 0.3 },
    candidates: null,
  });
  const hits = sweepPicks(library, { tags: ['开心'], mood: '皱眉叹气' }, 3000);
  const share = (hits.get(X) ?? 0) / 3000;
  assert.ok(
    Math.abs(share - 0.5454) < 0.03,
    `描述加分与半衰期必须是**乘法**（理论 54.5%，实测 ${(share * 100).toFixed(1)}%）`,
  );
});

test('★ 权重总算不出正数时计 `weightZero`（不许静默退化成均匀随机还看不出来）', () => {
  const X = md5Of(1);
  const { library } = makeLibrary({ entries: [[X, { tags: ['开心'], lastUsedAt: null }]] });
  assert.equal(library.stats().pick.weightZero, 0);
  library.pick({ tags: ['开心'] });
  assert.equal(library.stats().pick.weightZero, 0, '正常权重不该走 fallback');
  assert.equal(library.stats().pick.picks, 1);
  assert.equal(library.stats().pick.nullLastUsedAt, 1, '从没发过的条数要被数出来（方案 §5 风险 2 的判据）');
  assert.equal(library.stats().pick.decayed, 0, 'factor = 1.0 不算"被压过"');
});

test('★ `pickStats.decayed` 数的是"真被压过"的条数（不是候选数）', () => {
  const entries = [
    [md5Of(1), { tags: ['开心'], lastUsedAt: ago(0) }],
    [md5Of(2), { tags: ['开心'], lastUsedAt: null }],
  ];
  const { library } = makeLibrary({ entries });
  library.pick({ tags: ['开心'] });
  const s = library.stats().pick;
  assert.equal(s.picks, 1);
  assert.equal(s.decayed, 1, '只有"刚发过"的那张被压');
  assert.equal(s.nullLastUsedAt, 1, '另一张算"从没发过"');
});

// ================================================================== ② 参数来源：toml → 真的生效

test('★★★ `[sticker_pick]` 真的被读了：QQ_GUGU_TOML 指向的旁路 toml 里写什么，书里就是什么', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-decay-toml-'));
  const mainToml = path.join(root, 'qq-gugu.toml');
  const sideToml = path.join(root, 'qq-gugu.sticker.toml');
  fs.writeFileSync(mainToml, '# 主 toml（这里什么都不写）\n', 'utf8');
  // ⚠️ 参数写进**旁路**那份（`qq-gugu.sticker.toml`）。写进主 toml 会"看起来配了、永远不生效"。
  fs.writeFileSync(sideToml, [
    '[sticker_pick]',
    'halfLifeDays = 7',
    'recentFloor = 0.2',
    'protectLastOfTag = false',
    '',
  ].join('\n'), 'utf8');

  const before = process.env.QQ_GUGU_TOML;
  try {
    process.env.QQ_GUGU_TOML = mainToml;
    const dir = path.join(root, 'stickers');
    fs.mkdirSync(dir, { recursive: true });
    const indexPath = path.join(root, 'qq-stickers.json');
    writeIndexFile(indexPath, []);
    const library = createStickerLibrary({
      dir,
      indexPath,
      log: () => {},
      now: () => T0,
      candidates: null,
    });
    const pick = library.stats().pick;
    assert.equal(pick.halfLifeDays, 7, 'toml 里的 7 必须生效（不是代码默认的 30）');
    assert.equal(pick.recentFloor, 0.2);
    assert.equal(pick.protectLastOfTag, false);
    assert.equal(pick.fromToml, true);
    assert.equal(pick.tomlPath, sideToml, '读的必须是 sticker 那份旁路文件');

    // **这个值真的改变了挑的结果**：H=7 / floor=0.2 ⇒
    //   刚发出 factor = 0.2、7 天前 factor = 1-(1-0.2)×2^(-7/7) = 0.6
    //   ⇒ 分布 0.2 : 0.6 = 25% : 75%。
    // 拿默认值（H=30 / floor=0.3）算这两条是 0.3 : 0.404 ⇒ 42.6% : 57.4%，
    // 所以这条断言能分辨"toml 的值生效了"还是"代码默认值在跑"。
    const X = md5Of(1);
    const Y = md5Of(2);
    const lib2 = createStickerLibrary({
      dir,
      indexPath: (() => {
        const p = path.join(root, 'qq-stickers-2.json');
        writeIndexFile(p, [
          [X, { tags: ['开心'], lastUsedAt: ago(0) }],
          [Y, { tags: ['开心'], lastUsedAt: ago(7) }],
        ]);
        return p;
      })(),
      log: () => {},
      now: () => T0,
      candidates: null,
    });
    const hits = sweepPicks(lib2, { tags: ['开心'] }, 3000);
    const share = (hits.get(X) ?? 0) / 3000;
    assert.ok(
      Math.abs(share - 0.25) < 0.02,
      `toml 的 7/0.2 必须真的参与挑图（理论 25%，实测 ${(share * 100).toFixed(1)}%）`,
    );
  } finally {
    if (before === undefined) delete process.env.QQ_GUGU_TOML;
    else process.env.QQ_GUGU_TOML = before;
  }
});

test('★★ 越界 / 写错类型**不静默**：夹到边界并逐个 warn（`recentFloor = 0` 是最危险的那个）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-decay-clamp-'));
  const tomlPath = path.join(root, 'qq-gugu.sticker.toml');
  fs.writeFileSync(tomlPath, [
    '[sticker_pick]',
    'halfLifeDays = 99999',   // 超上限 ⇒ 夹到 3650
    'recentFloor = 0',        // ⚠️ 等于禁发 ⇒ 必须夹到 0.1
    'protectLastOfTag = "no"', // 不是布尔 ⇒ 回退默认
    '',
  ].join('\n'), 'utf8');
  const logs = [];
  const got = loadStickerPickConfig({ tomlPath, log: (level, message, meta) => logs.push({ level, message, meta }) });

  assert.equal(got.found, true);
  assert.equal(got.halfLifeDays, STICKER_PICK_CLAMPS.halfLifeDays[1]);
  assert.equal(got.recentFloor, 0.1, 'floor=0 必须被抬到 0.1（0 等于禁发，而且日志平静）');
  assert.equal(got.protectLastOfTag, true, '不是布尔 ⇒ 回退默认值');
  assert.equal(got.clamped.length, 3);
  assert.deepEqual(got.clamped.map((c) => c.key).sort(), ['halfLifeDays', 'protectLastOfTag', 'recentFloor']);
  assert.equal(logs.filter((l) => l.level === 'warn').length, 3, '三条被夹的都必须留 warn（夹紧必须留痕）');
});

test('★ 没有 `[sticker_pick]` 这一节 ⇒ 用代码默认值，并留一条 info（不是静默）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-decay-nosec-'));
  const tomlPath = path.join(root, 'qq-gugu.sticker.toml');
  fs.writeFileSync(tomlPath, '[sticker_gate]\nmaxTokens = 4000\n', 'utf8');
  const logs = [];
  const got = loadStickerPickConfig({ tomlPath, log: (level, message) => logs.push({ level, message }) });
  assert.equal(got.found, false);
  assert.equal(got.halfLifeDays, DEFAULT_STICKER_PICK.halfLifeDays);
  assert.equal(got.recentFloor, DEFAULT_STICKER_PICK.recentFloor);
  assert.equal(got.protectLastOfTag, DEFAULT_STICKER_PICK.protectLastOfTag);
  assert.ok(logs.some((l) => l.level === 'info'), '没有这一节要能看见（info 一条）');
});

test('★ toml 读不到 / 坏了 ⇒ 回退默认 + warn，**不抛**（配置坏了不该让小鲸鱼起不来）', () => {
  const logs = [];
  const missing = loadStickerPickConfig({
    tomlPath: path.join(os.tmpdir(), 'gugu-绝对不存在的文件.toml'),
    log: (level, message) => logs.push({ level, message }),
  });
  assert.equal(missing.found, false);
  assert.equal(missing.halfLifeDays, DEFAULT_STICKER_PICK.halfLifeDays);
  assert.ok(logs.some((l) => l.level === 'warn'), '读不到要留 warn');
});

test('★ `normalizeStickerPick`：不传 / null / 数组 / 无关键 ⇒ 全是默认值，且 `clamped` 为空', () => {
  for (const raw of [undefined, null, [], 'x', 42, { unrelated: 1 }]) {
    const got = normalizeStickerPick(raw);
    assert.deepEqual(
      { h: got.halfLifeDays, f: got.recentFloor, p: got.protectLastOfTag },
      {
        h: DEFAULT_STICKER_PICK.halfLifeDays,
        f: DEFAULT_STICKER_PICK.recentFloor,
        p: DEFAULT_STICKER_PICK.protectLastOfTag,
      },
      `raw=${JSON.stringify(raw)} 应全部回退默认`,
    );
    assert.deepEqual(got.clamped, [], `raw=${JSON.stringify(raw)} 没有"夹过"可言`);
  }
});

test('★★ 未来时间（时钟回拨）按"刚发过"算，**不给还没发生的事加分**', () => {
  const H = { halfLifeDays: 30, recentFloor: 0.3 };
  const future = new Date(T0 + 10 * DAY).toISOString();
  const got = halfLifeFactor(future, T0, H);
  assert.ok(got <= 1, `未来时间不能算出 > 1 的因子（实测 ${got}）`);
  assert.ok(Math.abs(got - 0.3) < 1e-9, '被钳到 floor（= 刚发过）');
});

test('★ `recentFloor` 传 0 / 负数 / 超过 1 ⇒ 夹到 [0.1, 1]（任何入口都不许出现 0）', () => {
  for (const [floor, expected] of [[0, 0.1], [-5, 0.1], [0.05, 0.1], [1, 1], [7, 1]]) {
    const got = halfLifeFactor(ago(0), T0, { halfLifeDays: 30, recentFloor: floor });
    assert.ok(Math.abs(got - expected) < 1e-9, `recentFloor=${floor} 应夹到 ${expected}（实测 ${got}）`);
  }
});
