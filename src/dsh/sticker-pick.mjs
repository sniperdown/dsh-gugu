/**
 * 表情包「挑」与「淘汰」的参数：**半衰期衰减** + **最后一张保护**（2026-11-18）。
 *
 * 方案：[`shared/2026-11-18-表情包打分方案.md`](../../../shared/2026-11-18-表情包打分方案.md)
 * 的 §1（半衰期）与 §2（淘汰保护）。两件事都在这个文件里定参数、在
 * `sticker-library.mjs` 里生效：一个乘进 `pick` 的权重，一个筛进 `evict` 的候选。
 *
 * ## ① 半衰期：惩罚量随天数半衰，而不是"发过就永久压死"
 *
 * ```
 * Δ         = 距上次发出的小时数 / 24     （`lastUsedAt` 为空 ⇒ factor 恒 1.0）
 * factor(Δ) = 1 - (1 - floor) · 2^(-Δ / H)
 * weight    = tagWeight × descBonus × factor      ← 乘法，不是替换
 * ```
 *
 * - `halfLifeDays` (H)：**惩罚残留**每 H 天减半。0 = 关闭（factor 恒 1.0 ⇒ 逐字节回到 2026-11-18 之前的行为）。
 * - `recentFloor` (floor)：刚发出去那一刻的权重下限。**夹到 [0.1, 1]** —— 方案 §5 风险 1 写明
 *   "给 0.02 就等于禁发"，表现是"某类表情永远不出现"，而且日志平静。
 *
 * ### ⚠️ `lastUsedAt` 为空时**绝对不要**回退到 `entry.at`
 *
 * `at` 是**入库时间**。拿它兜底等于系统性惩罚"入库很久但一次都没发过"的图 ——
 * 老图永远选不上，库实际只有最近 30 天在服役（方案 §5 风险 2 就是这一条）。
 * 方向正好反：真正的信号是"从没发过 = 不该压"，所以是 1.0。
 *
 * ### 六个参照值（H=30、floor=0.3；测试里当断言表）
 *
 * | 距上次发出 | factor |
 * |---|---|
 * | 刚发出 | 0.300 |
 * | 1 天 | 0.316 |
 * | 7 天 | 0.405 |
 * | 30 天 | 0.650 |
 * | 60 天 | 0.825 |
 * | 90 天 | 0.913 |
 *
 * ## ② 最后一张保护：`evict` 时别删掉某个标签的唯一持有者
 *
 * 见 `sticker-library.mjs` 的 `evict`。参数只有一个开关 `protectLastOfTag`。
 *
 * ## ⚠️ 夹紧必须留痕（和 `normalizeStickerGate` / `loadStickerGate` 同一条规矩）
 *
 * 越界 / 写错类型的值会被夹到边界或回退默认，**这里把"夹过"的字段逐个报出来**
 * （`normalizeStickerPick` 返回 `clamped` 数组，加载器每条打一条 warn）。
 * 不这么做的话，用户写 `recentFloor = 0` 会得到一个"看起来关了、实际按 0.1 跑"的配置，
 * 而日志里一个字都没有 —— 这是这个项目最贵的一类坑。
 *
 * @module qq-gugu/sticker-pick
 */

import nodeFs from 'node:fs';

import { parseToml } from './toml.mjs';
import { resolveModelToml } from './toml-files.mjs';

/** 参数所在的 toml 节（**在 `qq-gugu.sticker.toml` 里**，不是主 toml）。 */
export const STICKER_PICK_SECTION = 'sticker_pick';

/**
 * 第 ③ 步（群友频次 / 候选表）的**开关节**。
 *
 * 为什么它也在这里：同一个文件、同一次读盘，而且**这一步必须有自己的回退键**
 * （方案 §0：每一步一个独立开关、独立可回退）。放这儿之后再接 `index.mjs` 只剩一处。
 */
export const STICKER_ADMIT_SECTION = 'sticker_admit';

/**
 * ③a 的开关默认值：**开着，但只观察**。
 *
 * - `enabled = true`：候选表照建、照记（这就是"先跑两周收数据"）；
 * - `mode = "observe"`：**不参与任何决定**（`keepOne` 的返回值一个字节都不变）。
 *
 * ⚠️ `mode = "enforce"`（= ③b 接准入）**还没实现**。写它会被降级回 `observe` 并打一条 warn ——
 * 绝不静默"看起来在拦、其实没拦"。
 */
export const DEFAULT_STICKER_ADMIT_SWITCH = Object.freeze({ enabled: true, mode: 'observe' });

/** 主 toml 的默认路径（与 `index.mjs` 的 `defaultTomlPath()` 同一个默认值）。 */
export const DEFAULT_MAIN_TOML_PATH = '<DSH_HOME>\\profiles\\desktop\\qq-gugu.toml';

const DAY_MS = 86_400_000;

/**
 * 默认参数（= 方案 §1.2 / §2.3 的建议值，**也是"toml 没写"时的兜底**）。
 *
 * ⚠️ 默认值必须在代码里，不能只写在 toml 里 —— toml 可能被删、被写坏，
 * 而"没有这一节"不该让挑图这件事变成另一套行为。
 */
export const DEFAULT_STICKER_PICK = Object.freeze({
  halfLifeDays: 30,
  recentFloor: 0.3,
  protectLastOfTag: true,
});

/**
 * 夹紧边界。
 *
 * - `halfLifeDays` 上限 3650（10 年）= 事实上关闭，但不留"无穷大"这种能算出 NaN 的口子；
 * - `recentFloor` 下限 **0.1**（方案 §6 明确说这个数可以自行决定，但**不许 0**）。
 */
export const STICKER_PICK_CLAMPS = Object.freeze({
  halfLifeDays: [0, 3650],
  recentFloor: [0.1, 1],
});

/**
 * 把 toml 那一节（或任何来路不明的对象）收拾成**可用且必定有限**的参数。
 *
 * @param {unknown} raw
 * @returns {{halfLifeDays: number, recentFloor: number, protectLastOfTag: boolean,
 *   clamped: Array<{key: string, wrote: unknown, using: unknown}>}}
 */
export function normalizeStickerPick(raw = {}) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  /** 每个被夹过 / 回退过的键都记一行（加载器负责打 warn）。 */
  const clamped = [];

  const numIn = (key, fallback, min, max) => {
    if (src[key] === undefined) return fallback;
    const n = Number(src[key]);
    if (!Number.isFinite(n)) {
      clamped.push({ key, wrote: src[key], using: fallback });
      return fallback;
    }
    const value = Math.min(max, Math.max(min, n));
    if (value !== n) clamped.push({ key, wrote: src[key], using: value });
    return value;
  };

  // 布尔项**只认真正的布尔值**（TOML 的 true / false）。
  // `"false"` / `0` / 写错键名这类值语义有歧义，猜错的方向是"保护层悄悄开/关"，
  // 而且不报错 ⇒ 宁可回退默认 + 留一条 warn（同 `normalizeStickerGate` 的 `enableThinking`）。
  let protect = DEFAULT_STICKER_PICK.protectLastOfTag;
  if (src.protectLastOfTag !== undefined) {
    if (typeof src.protectLastOfTag === 'boolean') protect = src.protectLastOfTag;
    else clamped.push({ key: 'protectLastOfTag', wrote: src.protectLastOfTag, using: protect });
  }

  return {
    halfLifeDays: numIn(
      'halfLifeDays',
      DEFAULT_STICKER_PICK.halfLifeDays,
      STICKER_PICK_CLAMPS.halfLifeDays[0],
      STICKER_PICK_CLAMPS.halfLifeDays[1],
    ),
    recentFloor: numIn(
      'recentFloor',
      DEFAULT_STICKER_PICK.recentFloor,
      STICKER_PICK_CLAMPS.recentFloor[0],
      STICKER_PICK_CLAMPS.recentFloor[1],
    ),
    protectLastOfTag: protect,
    clamped,
  };
}

/**
 * 第 ③ 步那个开关（`[sticker_admit]`）：**只认真正的布尔 + 封闭枚举**。
 *
 * `mode` 目前只有一个合法值 `observe`。写成 `enforce`（③b 还没落地）会被降级回 `observe`
 * 并记一条 `clamped` —— 因为"配置写着 enforce、实际还在 observe"如果不留痕，
 * 两周后谁都会以为闸门已经开了。
 *
 * @param {unknown} raw
 * @returns {{enabled: boolean, mode: string, clamped: Array<{key: string, wrote: unknown, using: unknown}>}}
 */
export function normalizeStickerAdmit(raw = {}) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clamped = [];
  let enabled = DEFAULT_STICKER_ADMIT_SWITCH.enabled;
  if (src.enabled !== undefined) {
    if (typeof src.enabled === 'boolean') enabled = src.enabled;
    else clamped.push({ key: 'enabled', wrote: src.enabled, using: enabled });
  }
  let mode = DEFAULT_STICKER_ADMIT_SWITCH.mode;
  if (src.mode !== undefined) {
    if (src.mode === 'observe') mode = 'observe';
    else clamped.push({ key: 'mode', wrote: src.mode, using: mode });
  }
  return { enabled, mode, clamped };
}

/**
 * 时间衰减因子（**纯函数**，不碰任何全局状态）。
 *
 * 返回 `[recentFloor, 1]` 之间的有限数：
 * - `lastUsedAt` 空 / 解析不出 / 是未来时间（时钟回拨）⇒ **1.0**（= 不压）；
 * - `halfLifeDays <= 0` ⇒ **1.0**（= 关闭，这一条就是回退判据）。
 *
 * ⚠️ 非法日期**必须**返回 1.0 而不是 NaN：`NaN` 会让 `pick` 的权重总和变 NaN ⇒
 * `if (!(total > 0))` 走 fallback ⇒ **静默退化成均匀随机**（看起来还能发图，只是挑得变差）
 * —— 方案 §5 风险 11。
 *
 * @param {unknown} lastUsedAt 上次发出的 ISO 时间串（`recordUse` 写的）
 * @param {number} [nowMs] 注入的时钟（`pick` 用库的 `now()`，测试用固定值）
 * @param {{halfLifeDays?: number, recentFloor?: number}} [options]
 * @returns {number} 0 < factor <= 1
 */
export function halfLifeFactor(lastUsedAt, nowMs = Date.now(), options = {}) {
  const halfLifeDays = Number(options.halfLifeDays ?? DEFAULT_STICKER_PICK.halfLifeDays);
  const rawFloor = Number(options.recentFloor ?? DEFAULT_STICKER_PICK.recentFloor);
  // 这里再兜一次口（调用方可能绕过 normalize 直接传）：0 ⇒ 用默认下限，
  // 否则 floor=0 会让"刚发过的那张"权重变 0 ⇒ 真正的禁发，而且日志平静。
  const floor = Number.isFinite(rawFloor) ? Math.min(1, Math.max(0.1, rawFloor)) : DEFAULT_STICKER_PICK.recentFloor;

  const text = typeof lastUsedAt === 'string' ? lastUsedAt.trim() : '';
  if (text === '') return 1;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;

  const at = Date.parse(text);
  if (!Number.isFinite(at)) return 1;
  const base = Number.isFinite(nowMs) ? nowMs : Date.now();
  const days = (base - at) / DAY_MS;
  // 未来时间（`lastUsedAt` 在被注入时钟的测试里很常见 / 时钟回拨）⇒ 按"刚发过"算，
  // 不往前推：往前的方向是 factor > 1 = 给"还没发生的事"加分。
  const delta = days > 0 ? days : 0;
  const factor = 1 - (1 - floor) * 2 ** (-delta / halfLifeDays);
  return Number.isFinite(factor) ? factor : 1;
}

/**
 * 这一轮该读哪个 toml（`qq-gugu.sticker.toml`，不存在则回落主文件）。
 *
 * ⚠️ **这条是临时通道**，理由写在 `createStickerLibrary` 的 `stickerPick` 文档里：
 * 真源本该由 `index.mjs` 的 `sideTomlPath(config,'sticker')` 读好传进来
 * （同 `loadStickerGate` 的形状），本次改动的文件边界不允许动 `index.mjs`，
 * 所以加载器自己在**同一个口径**（`resolveModelToml` 是唯一入口）上解析一次。
 * 一旦 `index.mjs` 里接上 `loadStickerPickConfig()`，这条自动变成死路径（调用方传了对象就不读盘）。
 *
 * @returns {string}
 */
export function defaultStickerPickTomlPath() {
  const main = String(process.env.QQ_GUGU_TOML ?? '').trim() || DEFAULT_MAIN_TOML_PATH;
  return resolveModelToml(main, 'sticker').path;
}

/**
 * 读这个文件里的两节：`[sticker_pick]`（① 半衰期 + ② 淘汰保护）和
 * `[sticker_admit]`（③ 候选表的开关）。
 *
 * **读不到 / 没有某节 ⇒ 那一部分用默认值**（不抛，也不让小鲸鱼起不来），
 * 但夹紧与"没有这一节"都要留痕。
 *
 * 两节在**同一个文件**里，所以一次读盘、一起返回：多一次 IO 只为分开两个对象不值当，
 * 而且"某个参数到底从哪来"只有一条路径可查。
 *
 * @param {object} [options]
 * @param {string} [options.tomlPath] 覆盖路径（测试用；默认走 {@link defaultStickerPickTomlPath}）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {object} [options.fsImpl] 只有测试才传（**默认用真 fs**：toml 不在注入 fs 的域里）
 * @returns {{halfLifeDays: number, recentFloor: number, protectLastOfTag: boolean,
 *   admit: {enabled: boolean, mode: string},
 *   tomlPath: string, found: boolean, foundAdmit: boolean, clamped: Array<object>}}
 */
export function loadStickerPickConfig({ tomlPath, log = () => {}, fsImpl = nodeFs } = {}) {
  const target = String(tomlPath ?? '').trim() || defaultStickerPickTomlPath();
  const fallback = () => ({
    ...normalizeStickerPick({}),
    admit: { ...DEFAULT_STICKER_ADMIT_SWITCH },
    tomlPath: target,
    found: false,
    foundAdmit: false,
    clamped: [],
  });

  let text = '';
  try {
    text = String(fsImpl.readFileSync(target, 'utf8'));
  } catch (error) {
    log('warn', '读表情包挑图配置失败，半衰期/淘汰保护回退到代码默认值', {
      tomlPath: target,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback();
  }

  let doc = null;
  try {
    doc = parseToml(text);
  } catch (error) {
    log('warn', '表情包挑图配置解析失败，回退到代码默认值', {
      tomlPath: target,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback();
  }

  // ── `[sticker_pick]`（① 半衰期 + ② 淘汰保护）──
  const section = doc?.[STICKER_PICK_SECTION] ?? null;
  const hasPick = section !== null && typeof section === 'object' && !Array.isArray(section);
  if (!hasPick) {
    log('info', 'toml 里没有 [sticker_pick] 这一节 ⇒ 半衰期衰减与淘汰保护按代码默认值跑', {
      tomlPath: target,
      using: normalizeStickerPick({}),
    });
  }
  const pick = normalizeStickerPick(hasPick ? section : {});
  // ⚠️ 夹紧必须留痕：写越界 / 写错类型的值在这里逐个 warn（同 `loadStickerGate`）。
  for (const item of pick.clamped) {
    log('warn', `[sticker_pick] ${item.key} 的值不合法，已回退/夹到边界（生效的是"夹过之后"的值）`, {
      wrote: item.wrote,
      using: item.using,
    });
  }

  // ── `[sticker_admit]`（③ 候选表的开关；同一个文件，顺手一起读，省一次 IO）──
  const admitSection = doc?.[STICKER_ADMIT_SECTION] ?? null;
  const hasAdmit = admitSection !== null && typeof admitSection === 'object' && !Array.isArray(admitSection);
  const admit = normalizeStickerAdmit(hasAdmit ? admitSection : {});
  for (const item of admit.clamped) {
    log('warn', `[sticker_admit] ${item.key} 的值不合法，已回退到默认值（生效的是"回退之后"的值）`, {
      wrote: item.wrote,
      using: item.using,
    });
  }

  return {
    halfLifeDays: pick.halfLifeDays,
    recentFloor: pick.recentFloor,
    protectLastOfTag: pick.protectLastOfTag,
    admit: { enabled: admit.enabled, mode: admit.mode },
    tomlPath: target,
    found: hasPick,
    // `found` 只回答"`[sticker_pick]` 那一节在不在"；`[sticker_admit]` 单独看得见：
    foundAdmit: hasAdmit,
    clamped: [...pick.clamped, ...admit.clamped],
  };
}
