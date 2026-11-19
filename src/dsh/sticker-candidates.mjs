/**
 * 表情包**候选表**：群友发过的图各自出现过几次、几个人发、跨了几天（2026-11-18）。
 *
 * 方案：[`shared/2026-11-18-表情包打分方案.md`](../../../shared/2026-11-18-表情包打分方案.md) §3。
 *
 * ## 这一步只做「观察」，不改任何行为
 *
 * 用户的口径：**先跑两周收数据、只落盘不参与打分**。
 * 所以本模块：
 *
 * - **不参与 `pick` 打分**（`sticker-library.mjs` 的 `pick` 一次都没读过它）；
 * - **不改变入库链路的结果**（`keepOne` 里只加一次计数，不动 `stored` / `rejected` / `auditFailed`）；
 * - `qualifies()` 现在**没有调用方**（那是 ③b 的事），但它是"这两个数能不能当阈值依据"的
 *   唯一算法实现，所以连同测试一起先落地 —— 两周后拿真实分布定阈值时，代码不用再改。
 *
 * ## 为什么要有它
 *
 * 库（`qq-stickers.json`）只记"**已过审核入库的**"图。于是两个问题看不出来：
 * ① 一张群里天天发的图，可能每次都过不了审核闸（**没人知道它在被反复发**）；
 * ② 阈值（`minSeen` / `windowDays`）现在只能拍脑袋，没有分布数据。
 *
 * 候选表把"出现过"这件事记在**入库之前**，于是"高频但被拒"的图第一次变得可见。
 *
 * ## 三条纪律（照抄 `sticker-library.mjs`）
 *
 * | 项 | 值 | 理由 |
 * |---|---|---|
 * | 文件 | `<媒体目录>\qq-sticker-candidates.json` | 与 `qq-stickers.json` 同目录、同结构，同构才好读 |
 * | version | `1`（对不上 ⇒ **当空表**） | 宁可重新攒，也不误读旧格式 |
 * | 淘汰 | `lastAt` 最旧先走，上限 2000 | 库的 4 倍：候选一定比库多（要装被拒的） |
 * | 写盘 | 临时文件 + rename | 半截 JSON 会让整表作废 |
 * | 坏了 | `degraded = true` + 一条 warn，**当空表** | 它绝不能变成单点故障 |
 *
 * ## 隐私（方案 §5 风险 7，需要用户点头的那条）
 *
 * 候选表覆盖面比库大得多：**所有判据认为"是表情包"的图 + 谁发的**，含被审核拒掉的脏图。
 * 所以：
 * - **不存原图**（只 md5 + 计数）；
 * - `chatters` 只存 `sha256(userId)` 的**前 8 位**（要判"≥2 人"必须有集合，但没必要存明文 QQ）；
 * - `days` 只存去重后的日期串（能判"跨天"，不堆垃圾）；
 * - 文件路径跟 `sticker-audit` 一样是"只有人看"的调试设施，不进提示词、不发 QQ。
 *
 * ## 门槛（`DEFAULT_STICKER_ADMIT`）是**先验值**，两周后拿 `stats().qualified` 定
 *
 * 四个条件是**与（AND）**而不是加权求和：加权会让条件互相补偿
 * （10 个人各发 1 次 = 分够了），而我们要挡的恰恰是"人多但都是路过"的图；
 * AND 还能在日志里说清是**哪一条**没过。
 *
 * @module qq-gugu/sticker-candidates
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 索引版本号。对不上就**当空表**（宁可重新攒，也不要误读旧格式）。 */
export const STICKER_CANDIDATES_VERSION = 1;

/** 候选表文件名（跟 `qq-stickers.json` 同一个目录）。 */
export const DEFAULT_CANDIDATES_FILE = 'qq-sticker-candidates.json';

/** 候选表的默认路径（媒体目录下；实际路径由库按 `indexPath` 的目录算出来）。 */
export const DEFAULT_CANDIDATES_PATH = '<DSH_HOME>\\media\\qq-sticker-candidates.json';

/** 上限：库是 500，候选装的是"所有出现过的"，4 倍 ≒ 2000（方案 §3.2）。 */
export const DEFAULT_MAX_CANDIDATES = 2000;

/** 写盘合并窗口：群刷屏时别每张图整份重写一次 JSON（方案 §5 风险 5）。 */
export const DEFAULT_CANDIDATES_COALESCE_MS = 5000;

/**
 * 准入阈值（**先验值，两周后按真实分布定**；`mode` 目前恒为 `observe`）。
 *
 * | 参数 | 值 | 为什么 |
 * |---|---|---|
 * | `windowDays` | 30 | "高频"必须是**近期**高频；不设窗口的话半年前刷过一次的图永久占优 |
 * | `minSeen` | 3 | 2 太松（两人各发一次就算"群里的梗"）、4 太紧（小群一周到不了） |
 * | `minChatters` | 2 | 一个人连发 10 次叫刷屏，不叫"群里的梗" —— 这是挡大字贴图的主力 |
 * | `minDays` | 2 | 同一次刷屏不跨天；与 `minChatters` 互补 |
 * | `perChatterCap` | 2 | 单人最多贡献 2 次计数（再多饱和），防"某个人偏爱某张图"顶过门槛 |
 */
export const DEFAULT_STICKER_ADMIT = Object.freeze({
  mode: 'observe',
  windowDays: 30,
  minSeen: 3,
  minChatters: 2,
  minDays: 2,
  perChatterCap: 2,
});

const DAY_MS = 86_400_000;

/** `userId` → 稳定短哈希（**前 8 位**）。空 id ⇒ 空串（那一次的"人"不可判，不算一个人）。 */
export function chatterHash(userId) {
  const id = String(userId ?? '').trim();
  if (id === '') return '';
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 8);
}

/** `at`（毫秒）→ `YYYY-MM-DD`（本地日期串，只用来判"跨天"）。 */
function dayOf(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 造一张候选表。**任何一步失败都只是"这一次没记上"**（永不抛给调用方）。
 *
 * @param {object} [options]
 * @param {string} [options.filePath] 落盘路径（`''` = 只在内存里，不读写磁盘）
 * @param {Function} [options.log]
 * @param {object} [options.fsImpl]
 * @param {() => number} [options.now]
 * @param {number} [options.maxEntries]
 * @param {number} [options.coalesceMs] 两次写盘的最小间隔（0 = 每次都写）
 * @param {object} [options.admit] 门槛（见 {@link DEFAULT_STICKER_ADMIT}）
 * @returns {object}
 */
export function createStickerCandidates({
  filePath = DEFAULT_CANDIDATES_PATH,
  log = () => {},
  fsImpl = nodeFs,
  now = () => Date.now(),
  maxEntries = DEFAULT_MAX_CANDIDATES,
  coalesceMs = DEFAULT_CANDIDATES_COALESCE_MS,
  admit = DEFAULT_STICKER_ADMIT,
} = {}) {
  const target = String(filePath ?? '').trim();
  const usable = target !== '';
  const limit = Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.floor(maxEntries)
    : DEFAULT_MAX_CANDIDATES;
  const gates = {
    mode: 'observe',
    windowDays: Number(admit?.windowDays) > 0 ? Number(admit.windowDays) : DEFAULT_STICKER_ADMIT.windowDays,
    minSeen: Number(admit?.minSeen) >= 1 ? Number(admit.minSeen) : DEFAULT_STICKER_ADMIT.minSeen,
    minChatters: Number(admit?.minChatters) >= 1 ? Number(admit.minChatters) : DEFAULT_STICKER_ADMIT.minChatters,
    minDays: Number(admit?.minDays) >= 1 ? Number(admit.minDays) : DEFAULT_STICKER_ADMIT.minDays,
    perChatterCap: Number(admit?.perChatterCap) >= 1 ? Number(admit.perChatterCap) : DEFAULT_STICKER_ADMIT.perChatterCap,
  };

  /** @type {Map<string, object>} */
  const entries = new Map();
  const stats = {
    observed: 0,     // 记了几次（含重复出现的同一张）
    skippedSelf: 0,  // 自己发的（协议层本来就丢，这里是防退化的断言）
    dropped: 0,      // 超上限被淘汰的条数
    writes: 0,
    pendingWrites: 0, // 攒着没写的次数（合并窗口）
    reads: 0,
  };
  let degraded = false;
  let lastWriteAt = 0;
  /**
   * **懒加载**：第一次真正用到表时才读盘。
   *
   * 为什么不在构造时读：这张表是"只在偷到新图时才用"的东西，
   * 而 `createStickerLibrary` 在测试里被构造几百次、在真机上只在重载时构造一次。
   * 构造即读盘会让"这张表读了几次"混进别的计数里（实测会把
   * `sticker-pick.test.mjs` 那条"auditPath 为空 ⇒ 只读了一次索引"的断言搞红），
   * 而且失败时那条 warn 会打在"这个库刚建好"的时刻 —— 那时它还没被用到，
   * 报错的人根本不知道是哪件事触发的。
   */
  let loaded = false;
  function ensureLoaded() {
    if (loaded || !usable) {
      loaded = true;
      return;
    }
    loaded = true;
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
      if (parsed !== null && typeof parsed === 'object'
        && parsed.version === STICKER_CANDIDATES_VERSION
        && parsed.entries !== null && typeof parsed.entries === 'object'
        && !Array.isArray(parsed.entries)) {
        for (const [key, value] of Object.entries(parsed.entries)) {
          const md5 = String(key ?? '').trim().toLowerCase();
          if (md5 === '') continue;
          const chatters = Array.isArray(value?.chatters)
            ? value.chatters.map((c) => String(c ?? '').trim()).filter((c) => c !== '')
            : [];
          const counts = value?.counts !== null && typeof value?.counts === 'object' ? value.counts : {};
          const byChatter = {};
          for (const hash of chatters) {
            const n = Number(counts[hash]);
            byChatter[hash] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
          }
          entries.set(md5, {
            emojiId: String(value?.emojiId ?? '').trim(),
            firstAt: String(value?.firstAt ?? ''),
            lastAt: String(value?.lastAt ?? ''),
            seen: Number.isFinite(value?.seen) ? Math.floor(Number(value.seen)) : 0,
            chatters: Object.keys(byChatter),
            counts: byChatter,
            days: Array.isArray(value?.days) ? value.days.map((d) => String(d ?? '')).filter((d) => d !== '') : [],
            // 3b 才会写：`none` = 没判过 / `rejected` = 审核闸拒过（用来省掉重复送审）。
            verdict: value?.verdict === 'rejected' ? 'rejected' : 'none',
            verdictAt: typeof value?.verdictAt === 'string' ? value.verdictAt : null,
            rejects: Array.isArray(value?.rejects) ? value.rejects.map((r) => String(r ?? '')).filter((r) => r !== '') : [],
          });
        }
      } else {
        degraded = true;
      }
    } catch (error) {
      degraded = true;
      log('warn', '表情包候选表读不出来（本次当空表，重新攒；库不受影响）', {
        path: target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function evict() {
    while (entries.size > limit) {
      let victim = null;
      let victimAt = null;
      for (const [md5, entry] of entries) {
        // 最久没再出现过的那张先走（与库的"用得少的先走"同向：没人再发它了）。
        const at = String(entry.lastAt ?? '');
        if (victimAt === null || at < victimAt) {
          victim = md5;
          victimAt = at;
        }
      }
      if (victim === null) break;
      entries.delete(victim);
      stats.dropped += 1;
    }
  }

  function persist() {
    ensureLoaded();
    if (!usable) return false;
    try {
      evict();
      const payload = JSON.stringify({
        version: STICKER_CANDIDATES_VERSION,
        updatedAt: new Date(now()).toISOString(),
        entries: Object.fromEntries(entries),
      }, null, 2);
      const dir = path.dirname(target);
      fsImpl.mkdirSync(dir, { recursive: true });
      const tmp = `${target}.tmp`;
      fsImpl.writeFileSync(tmp, payload, 'utf8');
      fsImpl.renameSync(tmp, target);
      stats.writes += 1;
      stats.pendingWrites = 0;
      lastWriteAt = now();
      return true;
    } catch (error) {
      log('warn', '表情包候选表写不进去（本轮照常，只是重启后可能少几条）', {
        path: target,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** 合并写：窗口内只打脏标，窗口外顺带把攒下的写掉。 */
  function persistCoalesced() {
    if (!usable) return;
    const at = now();
    if (coalesceMs > 0 && lastWriteAt > 0 && at - lastWriteAt < coalesceMs) {
      stats.pendingWrites += 1;
      return;
    }
    persist();
  }

  /** 一个 md5 在窗口内、按 `perChatterCap` 饱和之后的计数。 */
  function scoreOf(entry, cutoffDay) {
    let scored = 0;
    for (const hash of entry.chatters) {
      const n = entry.counts[hash] ?? 0;
      scored += Math.min(n, gates.perChatterCap);
    }
    const daysInWindow = cutoffDay === '' ? entry.days.length : entry.days.filter((d) => d >= cutoffDay).length;
    return { scored, daysInWindow };
  }

  return {
    /**
     * 记一次"看见这张图"（**在「认」之前**，见 `sticker-library.mjs` 的 `keepOne`）。
     *
     * @param {{md5: string, userId?: string, emojiId?: string, self?: boolean, at?: number}} [input]
     * @returns {boolean} 这次有没有记上（`false` = 自己发的 / md5 空 / 表关掉）
     */
    observe({ md5, userId = '', emojiId = '', self = false, at } = {}) {
      const key = String(md5 ?? '').trim().toLowerCase();
      if (key === '') return false;
      if (self === true) {
        // 自己发的消息在协议层已经被丢掉（`onebot/protocol.mjs` 的 `ignoreSelf`）。
        // 这里再拦一道是**防退化**：哪天有人把 ignoreSelf 关掉，这个计数会直接涨起来。
        stats.skippedSelf += 1;
        return false;
      }
      ensureLoaded();
      const when = Number.isFinite(at) ? at : now();
      const stamp = new Date(when).toISOString();
      const day = dayOf(when);
      const hash = chatterHash(userId);
      const found = entries.get(key);
      if (found === undefined) {
        entries.set(key, {
          emojiId: String(emojiId ?? '').trim(),
          firstAt: stamp,
          lastAt: stamp,
          seen: 1,
          chatters: hash === '' ? [] : [hash],
          counts: hash === '' ? {} : { [hash]: 1 },
          days: [day],
          verdict: 'none',
          verdictAt: null,
          rejects: [],
        });
      } else {
        found.lastAt = stamp;
        found.seen += 1;
        if (found.emojiId === '' && String(emojiId ?? '').trim() !== '') found.emojiId = String(emojiId).trim();
        if (hash !== '') {
          if (found.counts[hash] === undefined) {
            found.counts[hash] = 1;
            found.chatters.push(hash);
          } else {
            found.counts[hash] += 1;
          }
        }
        if (!found.days.includes(day)) found.days.push(day);
      }
      stats.observed += 1;
      persistCoalesced();
      return true;
    },
    /** 一条候选（只读拷贝；没有就 `null`）。 */
    get(md5) {
      stats.reads += 1;
      ensureLoaded();
      const key = String(md5 ?? '').trim().toLowerCase();
      const found = entries.get(key);
      if (found === undefined) return null;
      return { md5: key, ...found, chatters: [...found.chatters], counts: { ...found.counts }, days: [...found.days], rejects: [...found.rejects] };
    },
    /** 按 `emoji_id` 找（**零下载**的路：同一 id 再来一次就知道是谁）。 */
    byEmojiId(emojiId) {
      ensureLoaded();
      const wanted = String(emojiId ?? '').trim();
      if (wanted === '') return null;
      for (const [md5, entry] of entries) {
        if (entry.emojiId !== '' && entry.emojiId === wanted) {
          return { md5, ...entry, chatters: [...entry.chatters], counts: { ...entry.counts }, days: [...entry.days], rejects: [...entry.rejects] };
        }
      }
      return null;
    },
    /** 全部候选（按 `lastAt` 新的在前 —— 两周后要看的就是这个顺序）。 */
    all() {
      ensureLoaded();
      return [...entries.entries()]
        .map(([md5, entry]) => ({ md5, ...entry, chatters: [...entry.chatters], counts: { ...entry.counts }, days: [...entry.days], rejects: [...entry.rejects] }))
        .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    },
    /**
     * 这条现在够不够门槛（**③b 才会有人调**；③a 只有测试在读它）。
     *
     * 四个条件的**与**：窗口内计数 ≥ `minSeen`、人数 ≥ `minChatters`、跨天 ≥ `minDays`，
     * 且不是"已经判过不收"的（3b 的否决 TTL）。
     *
     * @param {string} md5
     * @param {{at?: number}} [options]
     * @returns {boolean}
     */
    qualifies(md5, { at } = {}) {
      ensureLoaded();
      const key = String(md5 ?? '').trim().toLowerCase();
      const entry = entries.get(key);
      if (entry === undefined) return false;
      const when = Number.isFinite(at) ? at : now();
      // 窗口外的最后一条观测 ⇒ 这条已经"没人再发了"，不论历史上多热都不算。
      const last = Date.parse(entry.lastAt);
      if (!Number.isFinite(last) || when - last > gates.windowDays * DAY_MS) return false;
      const cutoffDay = dayOf(when - gates.windowDays * DAY_MS);
      const { scored, daysInWindow } = scoreOf(entry, cutoffDay);
      return scored >= gates.minSeen
        && entry.chatters.length >= gates.minChatters
        && daysInWindow >= gates.minDays;
    },
    /** 门槛的**当前生效值**（诊断：这是"toml 改了到底生效没有"的直接证据）。 */
    gates: () => ({ ...gates }),
    /** 强制写盘（合并窗口里攒着的那几次）。 */
    flush() {
      return persist();
    },
    size: () => {
      ensureLoaded();
      return entries.size;
    },
    persist,
    stats() {
      ensureLoaded();
      let qualified = 0;
      const when = now();
      const cutoffDay = dayOf(when - gates.windowDays * DAY_MS);
      for (const entry of entries.values()) {
        const last = Date.parse(entry.lastAt);
        if (!Number.isFinite(last) || when - last > gates.windowDays * DAY_MS) continue;
        const { scored, daysInWindow } = scoreOf(entry, cutoffDay);
        if (scored >= gates.minSeen && entry.chatters.length >= gates.minChatters && daysInWindow >= gates.minDays) {
          qualified += 1;
        }
      }
      return {
        ...stats,
        size: entries.size,
        qualified,
        degraded,
        enabled: usable,
        path: target,
        maxEntries: limit,
        mode: gates.mode,
        gates: { ...gates },
      };
    },
  };
}
