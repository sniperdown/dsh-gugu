/**
 * **QQ → 昵称** 表：让 `@某人` 渲染成 `@昵称`，而不是 `@QQ号`（2026-10-14）。
 *
 * ## 为什么需要它
 *
 * 用户 2026-10-14 提的问题：
 *
 * > 「现在 `@` 渲染成纯 QQ 号，比如 `@30000002`。**模型认不出那是谁** ——
 * >  连"@ 的是它自己"都认不出。」
 *
 * 根因**不是渲染代码写错了**，而是**没有名字可用**：NapCat 的 at 段只有
 * `{type:'at', data:{qq}}`，**不带任何昵称字段**（`protocol.mjs` 的 `formatAtSegment`
 * 注释里有 2026-10-06 的实测；2026-10-14 又用 `get_group_msg_history` 复核了一遍，
 * 40 条里的 at 段键集合仍然只有 `{qq}`）。别的实现（Lagrange 等）可能带 `name`，
 * 但这条部署上【永远】走退化分支 ⇒ `@30000002`。
 *
 * ⇒ 所以只能**自己攒一张表**。数据来源是**每条入站消息的 `sender`**
 *   （`nickname` / `card` / `user_id`），以及 `history-backfill.mjs` 灌历史时那些历史消息的
 *   `sender` —— **两者喂进同一张表**（历史那条路尤其重要：HMR 重载很频繁，
 *   而"重载后立刻又能从历史灌回来"是这张表能自愈的关键）。
 *
 * ## 两层：`(群, QQ) → 群名片` + `QQ → 昵称`
 *
 * **实测依据**（2026-10-14 拉真机历史归纳，见 `_qq-judge/nick-probe-summary.txt`）：
 *
 * | QQ | 在哪 | `card` | `nickname` |
 * |---|---|---|---|
 * | `30000021` | 测试群 30000012 | `""` | `用户A` |
 * | `30000021` | 群 30000011 | `本群名片A` | `用户A` |
 * | `30000022` | 群 30000014 | `本群名片B` | `用户B` |
 *
 * ⇒ **同一个人的群名片在不同群真的不一样**，而 QQ 昵称是全局的。
 *   所以是一张两层表：先在**本群**找群名片，找不到再回落到全局昵称。
 *   只用一层（QQ→某个名字）会在跨群时显示**别的群的名字**，那是明显错的。
 *
 * **取名优先级与 `protocol.mjs:normalizeEvent` 完全一致**（`card` → `nickname`）。
 * 这一条是刻意的：转录里的发送者就是按这个优先级渲染成 `名字(QQ)`，
 * 如果 @ 用另一套优先级，同一个人的两个名字就会在**同一段提示词里**同时出现。
 *
 * ## ③ 查不到 ⇒ **保留原有的退化行为**（渲染 `@QQ号`）
 *
 * 本模块的 `resolve()` 查不到时返回 **空串**，由 `formatAtSegment` 退回 `@QQ号`。
 * 绝不返回"未知用户"之类的东西 —— 那等于把"我不知道"包装成一句看起来像信息的话。
 *
 * ## ② 持久化：**要**
 *
 * 落在 `<DSH_HOME>\media\qq-nicknames.json`（与 `qq-outbound.jsonl` /
 * `qq-image-desc.json` 同处）。理由：**HMR 是保存即重载**，而重载会清掉一切内存状态；
 * 没有落盘的话，"改一行代码 ⇒ 所有人重新变回 `@QQ号`"。这一条与
 * `image-cache.mjs` 的 `qq-image-desc.json` 完全同一个理由。
 *
 * ## ④ 上限：**绝不允许无限增长**
 *
 * 三个上限（`maxPeople` / `maxCards` / `maxGroups`），超出就**按 `at`（最近一次更新）
 * 淘汰最旧的**——照 `image-cache.mjs` 的 `evict()` 那套写，不另发明。
 *
 * ## 🔴 这是**观测/便利设施，不是必需品**
 *
 * 读不到 / 坏了 / 版本对不上一律**当空表**（照常收消息回消息，只是 @ 退回 `@QQ号`）；
 * 写盘失败只记一条日志，连续失败 `failsBeforeDisable` 次就**本次进程内断开**
 * （免得每条消息都去撞一次系统调用）——同 `outbound-ledger.mjs` / `sticker-audit.mjs`。
 * **表坏了不能把被它服务的那件事也弄坏。**
 *
 * @module qq-dsh/nicknames
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sanitizeNickname } from '../onebot/protocol.mjs';

/** 磁盘格式版本。对不上就**当空表**（表是缓存，不是真相）。 */
export const NICKNAME_TABLE_VERSION = 1;

/**
 * `DSH_HOME` 推不出来时的兜底目录 —— 用户主目录下的 `.dsh/media`。
 *
 * 与 `outbound-ledger.mjs` 的 `DEFAULT_OUTBOUND_LEDGER_DIR` /
 * `sticker-library.mjs` 的 `DEFAULT_STICKER_INDEX_PATH` 同一条规矩：
 * 兜底必须是个**真实可写**的位置 —— 猜错的话会默默什么都没记，
 * 而所有计数都正常（这种静默失效比报错难查得多）。
 */
export const DEFAULT_NICKNAME_TABLE_DIR = path.join(os.homedir(), '.dsh', 'media');

/**
 * 默认表路径：`<DSH_HOME>/media/qq-nicknames.json`；
 * `DSH_HOME` 没设时退到本部署的写死路径（**不是空串** —— 空串会让 `enabled` 变 false，
 * 那就等于"功能装上了但一条都不记"，而那种状态下所有计数看起来都正常）。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function defaultNicknameTablePath(env = process.env) {
  const home = String(env?.DSH_HOME ?? '').trim();
  if (home === '') return path.join(DEFAULT_NICKNAME_TABLE_DIR, 'qq-nicknames.json');
  return path.join(home, 'media', 'qq-nicknames.json');
}

/**
 * 本进程推出来的默认表路径（**模块加载时定一次**）。
 *
 * 它也是 `index.mjs` 的 `CONFIG_SHAPE.nicknameTablePath` 的默认值 ——
 * **路径的唯一来源是这里**（同 `DEFAULT_OUTBOUND_LEDGER_PATH` 那条规矩：
 * 与其让调用方各推一遍、迟早分叉成两份，不如只留一个常量）。
 */
export const DEFAULT_NICKNAME_TABLE_PATH = defaultNicknameTablePath();

/**
 * 兜底默认值。
 *
 * ⚠️ **这里绝不能有 `file` 字段**（`outbound-ledger.mjs` 上那个坑的镜像）：
 * `file` 是 `defaultNicknameTablePath()` **推**出来的；放一个 `file: ''` 会把功能
 * **默认关掉**，而且**一点声音都没有**（快照上长得像"装了、挂上了、一条都没记"）。
 *
 * 三个上限的口径：
 * - `maxPeople` —— `QQ → 昵称` 的条目数；
 * - `maxCards` —— **全局**的 `(群, QQ) → 群名片` 条目数（一个大群里几千人也不至于爆）；
 * - `maxGroups` —— 记住多少个群的名片（超出就丢掉"最久没人说话"的那个群）。
 *
 * 为什么要有 `maxCards` 之外还要 `maxGroups`：只有全局上限的话，一个灌进来的大群
 * 可以把**所有**别的群的名片挤掉。两个一起才既防总量、又防"一个群吃掉全部额度"。
 */
export const DEFAULT_NICKNAME_TABLE = Object.freeze({
  enabled: true,
  maxPeople: 2000,
  maxCards: 5000,
  maxGroups: 200,
  /** 连续写失败几次就本次进程内断开（同 `outbound-ledger.mjs`）。 */
  failsBeforeDisable: 5,
});

/**
 * 把配置收拾成能用的形状（越界一律夹到边界，不抛）。
 *
 * ⚠️ **不参与推路径**：缺 `file` 时用的是模块加载时定下的
 * {@link DEFAULT_NICKNAME_TABLE_PATH}；显式给（含空串）以给的为准
 * ⇒ **空串 = 明确关掉**，不是"走默认"。
 *
 * @param {object} [raw]
 * @returns {{file: string, enabled: boolean, maxPeople: number, maxCards: number, maxGroups: number, failsBeforeDisable: number}}
 */
export function normalizeNicknameTable(raw = {}) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const intIn = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  const file = src.file === undefined ? DEFAULT_NICKNAME_TABLE_PATH : text(src.file);
  return {
    file,
    // 路径为空就等于关掉：没有路径就没地方写，"以为自己开着"只会更坏。
    enabled: bool(src.enabled, DEFAULT_NICKNAME_TABLE.enabled) && file !== '',
    // 上限 20 万：再大就不是"一个人名表"了（一条约 60 字节 ⇒ 20 万条约 12 MB）。
    maxPeople: intIn(src.maxPeople, DEFAULT_NICKNAME_TABLE.maxPeople, 0, 200_000),
    maxCards: intIn(src.maxCards, DEFAULT_NICKNAME_TABLE.maxCards, 0, 200_000),
    maxGroups: intIn(src.maxGroups, DEFAULT_NICKNAME_TABLE.maxGroups, 0, 5_000),
    failsBeforeDisable: intIn(src.failsBeforeDisable, DEFAULT_NICKNAME_TABLE.failsBeforeDisable, 0, 1000),
  };
}

/** `all`（`@全体成员`）不是一个人，永远不进表。 */
const AT_ALL = 'all';

/**
 * 一个 QQ 号是不是能当键用。
 *
 * **故意宽松**：只要是**非空字符串**就收（真实 QQ 号全是数字，但历史接口在某些实现上
 * 会给字符串/数字混用的形状）。只排除两个东西：空串、`all`。
 *
 * @param {unknown} value
 * @returns {string} 能用的键（不能用时返回空串）
 */
function keyOf(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (text === '' || text === AT_ALL) return '';
  return text;
}

/**
 * 造一张表。
 *
 * @param {object} [options]
 * @param {object} [options.config] `normalizeNicknameTable` 的输入（或它的输出）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {object} [options.fsImpl] 注入 fs（测试用）
 * @param {() => number} [options.now] 时钟（测试用）
 * @returns {{
 *   learn: (entry: object) => boolean,
 *   learnBatch: (entries: object[]) => number,
 *   resolve: (qq: unknown, groupId?: unknown) => string,
 *   stats: () => object,
 *   file: () => string,
 *   enabled: () => boolean,
 *   flush: () => boolean,
 *   read: () => object,
 *   people: () => number,
 *   cards: () => number,
 * }}
 */
export function createNicknameTable({
  config = null,
  log = () => {},
  fsImpl = null,
  now = () => Date.now(),
} = {}) {
  const cfg = normalizeNicknameTable(config ?? DEFAULT_NICKNAME_TABLE);
  const f = fsImpl ?? fs;

  /** `QQ → { nickname, at, seen }`。 */
  const people = new Map();
  /** `群号 → (QQ → { card, at, seen })`。 */
  const cards = new Map();

  const stats = {
    enabled: cfg.enabled,
    /** `learn()` 被调了几次（含学不到名字的那些）。 */
    learned: 0,
    /** 真的新增/改写了名字的次数（这个数才对应"该落盘了"）。 */
    updated: 0,
    /** 查表命中 / 未命中（`@` 段每渲染一次算一次）。 */
    hits: 0,
    misses: 0,
    writes: 0,
    failed: 0,
    failStreak: 0,
    disabled: false,
    prunes: 0,
    droppedPeople: 0,
    droppedCards: 0,
    droppedGroups: 0,
    degraded: false,
    loaded: 0,
    last: null,
  };

  // ─────────────────────────────────────────────── 读盘

  if (cfg.enabled) {
    try {
      const raw = f.readFileSync(cfg.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && parsed.version === NICKNAME_TABLE_VERSION) {
        for (const [qq, value] of Object.entries(parsed.people ?? {})) {
          const key = keyOf(qq);
          const nickname = sanitizeNickname(value?.nickname);
          if (key === '' || nickname === '') continue;
          people.set(key, {
            nickname,
            at: typeof value?.at === 'string' ? value.at : new Date(0).toISOString(),
            seen: Number.isFinite(value?.seen) ? Number(value.seen) : 1,
          });
        }
        for (const [groupId, group] of Object.entries(parsed.cards ?? {})) {
          const gid = String(groupId ?? '').trim();
          if (gid === '' || group === null || typeof group !== 'object') continue;
          const bucket = new Map();
          for (const [qq, value] of Object.entries(group)) {
            const key = keyOf(qq);
            const card = sanitizeNickname(value?.card);
            if (key === '' || card === '') continue;
            bucket.set(key, {
              card,
              at: typeof value?.at === 'string' ? value.at : new Date(0).toISOString(),
              seen: Number.isFinite(value?.seen) ? Number(value.seen) : 1,
            });
          }
          if (bucket.size > 0) cards.set(gid, bucket);
        }
        stats.loaded = people.size + countCards();
      } else {
        stats.degraded = true;
      }
    } catch (error) {
      // 文件不存在是**正常情况**（第一次跑），不算坏。
      const code = error !== null && typeof error === 'object' ? error.code : '';
      if (code === 'ENOENT') {
        stats.degraded = false;
      } else {
        stats.degraded = true;
        log('warn', '昵称表读不了，按空表继续（@ 会退回 @QQ号，直到重新学到名字）', {
          file: cfg.file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** 全局的名片条目总数。 */
  function countCards() {
    let total = 0;
    for (const bucket of cards.values()) total += bucket.size;
    return total;
  }

  // ─────────────────────────────────────────────── 淘汰

  /**
   * 淘汰到上限以内。**按 `at`（最近一次更新）丢最旧的**，同 `image-cache.mjs` 的 `evict()`。
   *
   * 顺序是先群、再名片、最后人：先砍掉整个"没人说话"的群，
   * 能让后面那次全局扫描少走一圈。
   */
  function evict() {
    let pruned = false;

    if (cfg.maxGroups > 0 && cards.size > cfg.maxGroups) {
      // 每个群取"最新的那一条"的时刻当它的新鲜度，丢最旧的那个群。
      while (cards.size > cfg.maxGroups) {
        let oldestGroup = null;
        let oldestAt = null;
        for (const [groupId, bucket] of cards) {
          let newest = '';
          for (const value of bucket.values()) if (value.at > newest) newest = value.at;
          if (oldestAt === null || newest < oldestAt) {
            oldestAt = newest;
            oldestGroup = groupId;
          }
        }
        if (oldestGroup === null) break;
        const bucket = cards.get(oldestGroup);
        stats.droppedCards += bucket?.size ?? 0;
        cards.delete(oldestGroup);
        stats.droppedGroups += 1;
        pruned = true;
      }
    }

    if (cfg.maxCards > 0 && countCards() > cfg.maxCards) {
      while (countCards() > cfg.maxCards) {
        let oldestGroup = null;
        let oldestQq = null;
        let oldestAt = null;
        for (const [groupId, bucket] of cards) {
          for (const [qq, value] of bucket) {
            if (oldestAt === null || value.at < oldestAt) {
              oldestAt = value.at;
              oldestGroup = groupId;
              oldestQq = qq;
            }
          }
        }
        if (oldestGroup === null || oldestQq === null) break;
        cards.get(oldestGroup)?.delete(oldestQq);
        if (cards.get(oldestGroup)?.size === 0) cards.delete(oldestGroup);
        stats.droppedCards += 1;
        pruned = true;
      }
    }

    if (cfg.maxPeople > 0 && people.size > cfg.maxPeople) {
      while (people.size > cfg.maxPeople) {
        let oldestKey = null;
        let oldestAt = null;
        for (const [qq, value] of people) {
          if (oldestAt === null || value.at < oldestAt) {
            oldestAt = value.at;
            oldestKey = qq;
          }
        }
        if (oldestKey === null) break;
        people.delete(oldestKey);
        stats.droppedPeople += 1;
        pruned = true;
      }
    }

    if (pruned) stats.prunes += 1;
  }

  // ─────────────────────────────────────────────── 写盘

  /**
   * 落盘。**绝不抛异常**（同 `outbound-ledger.mjs` 的 `record()`）。
   *
   * 原子写（`tmp` + `rename`）：半截的 JSON 比没有更坏 —— 下次启动读不出来，
   * 会静默变成"空表 + degraded"。同 `outbound-ledger.mjs` 的 `trimIfNeeded`。
   *
   * @returns {boolean} 真写了才 true
   */
  function persist() {
    if (!stats.enabled || stats.disabled) return false;
    try {
      evict();
      const payload = JSON.stringify({
        version: NICKNAME_TABLE_VERSION,
        updatedAt: new Date(now()).toISOString(),
        people: Object.fromEntries(people),
        cards: Object.fromEntries([...cards].map(([groupId, bucket]) => [groupId, Object.fromEntries(bucket)])),
      }, null, 0);
      f.mkdirSync(path.dirname(cfg.file), { recursive: true });
      const tmp = `${cfg.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      f.writeFileSync(tmp, payload, 'utf8');
      f.renameSync(tmp, cfg.file);
      stats.writes += 1;
      stats.failStreak = 0;
      return true;
    } catch (error) {
      stats.failed += 1;
      stats.failStreak += 1;
      log('warn', '昵称表写盘失败（@ 退回 @QQ号，收消息回消息不受影响）', {
        file: cfg.file,
        error: error instanceof Error ? error.message : String(error),
        failStreak: stats.failStreak,
      });
      if (cfg.failsBeforeDisable > 0 && stats.failStreak >= cfg.failsBeforeDisable) {
        stats.disabled = true;
        log('warn', '昵称表连续写盘失败，**本次进程内已断开**（免得每条消息都撞一次）', {
          file: cfg.file, failStreak: stats.failStreak,
        });
      }
      return false;
    }
  }

  // ─────────────────────────────────────────────── 学 / 查

  /**
   * 学一条（**不落盘**）。内部用；外部请用 {@link learn} / {@link learnBatch}。
   *
   * ⚠️ **只在"新值非空且与旧值不同"时才算改动**：
   *   - 新值为空 ⇒ **绝不覆盖**已有的名字（某条消息没带 card，不代表名片被清空了）；
   *   - 值没变 ⇒ 只更新 `at`/`seen`（诊断用），**不触发写盘**
   *     —— 这是"每条消息都写一次整个 JSON"这个代价的闸门。
   *
   * @param {object} entry
   * @returns {boolean} 这个人的名字**新增或变了**（= 该落盘了）
   */
  function learnOne(entry) {
    const qq = keyOf(entry?.userId);
    const groupId = String(entry?.groupId ?? '').trim();
    const nickname = sanitizeNickname(entry?.nickname);
    const card = sanitizeNickname(entry?.card);
    if (qq === '') return false;
    if (nickname === '' && (card === '' || groupId === '')) return false;

    const at = new Date(Number.isFinite(Number(entry?.at)) && Number(entry.at) > 0 ? Number(entry.at) : now()).toISOString();
    let changed = false;

    if (nickname !== '') {
      const found = people.get(qq);
      if (found === undefined) {
        people.set(qq, { nickname, at, seen: 1 });
        changed = true;
      } else {
        found.at = at;
        found.seen += 1;
        if (found.nickname !== nickname) {
          found.nickname = nickname;
          changed = true;
        }
      }
    }

    if (card !== '' && groupId !== '') {
      let bucket = cards.get(groupId);
      if (bucket === undefined) {
        bucket = new Map();
        cards.set(groupId, bucket);
      }
      const found = bucket.get(qq);
      if (found === undefined) {
        bucket.set(qq, { card, at, seen: 1 });
        changed = true;
      } else {
        found.at = at;
        found.seen += 1;
        if (found.card !== card) {
          found.card = card;
          changed = true;
        }
      }
    }

    if (changed) {
      stats.updated += 1;
      stats.last = { qq, nickname, card, groupId, at };
    }
    return changed;
  }

  /**
   * 学一条入站消息的发送者（**这条路绝不抛** —— 它挂在每一条入站消息上）。
   *
   * 名字**变了/是新的**才落盘一次。
   *
   * @param {{userId?: unknown, nickname?: unknown, card?: unknown, groupId?: unknown, at?: number}} entry
   * @returns {boolean} 真的新增/改写了名字才 true
   */
  function learn(entry) {
    try {
      // `file: ''`（= 配置里明确关掉）⇒ **完全不记**：不学、不查、不写盘。
      // 与"连续写盘失败自己断开"（`stats.disabled`）**不是一回事** ——
      // 那种情况下内存里的名字继续用，只是不再尝试写盘。
      if (!stats.enabled) return false;
      stats.learned += 1;
      const changed = learnOne(entry);
      if (changed) persist();
      return changed;
    } catch (error) {
      // 学名字失败**绝不能**影响处理这条消息（这是热路径）。
      log('debug', '昵称表学习失败（忽略）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 批量学（`history-backfill` 灌历史时用）：**全部学完只落盘一次**。
   *
   * 为什么要有它：灌一次历史会一次见到几十个人 ⇒ 逐条 `learn()` 就是几十次
   * 整份 JSON 的写盘。那是启动路径上的惊群，而这个函数把它压成一次。
   *
   * @param {object[]} entries
   * @returns {number} 说了算的条数（新增/改写名字的条数）
   */
  function learnBatch(entries) {
    try {
      if (!stats.enabled) return 0;
      let changed = 0;
      for (const entry of Array.isArray(entries) ? entries : []) {
        stats.learned += 1;
        if (learnOne(entry)) changed += 1;
      }
      if (changed > 0) persist();
      return changed;
    } catch (error) {
      log('debug', '昵称表批量学习失败（忽略）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * 查名字：**先本群名片、再全局昵称、最后空串**。
   *
   * 返回的是**已清理、已去掉前导 `@`** 的名字（可以直接接在 `@` 后面）；
   * 查不到返回 `''` —— 由调用方（`formatAtSegment`）退回 `@QQ号`。
   *
   * ⚠️ **这个函数会被每一条 at 段调用**，所以它自己不抛：
   * 查表坏了最坏就是"这次 @ 退回 QQ 号"，绝不能让渲染正文这件事失败。
   *
   * @param {unknown} qq
   * @param {unknown} [groupId]
   * @returns {string}
   */
  function resolve(qq, groupId) {
    try {
      const key = keyOf(qq);
      if (key === '') return '';
      const gid = String(groupId ?? '').trim();
      if (gid !== '') {
        const card = cards.get(gid)?.get(key)?.card;
        if (typeof card === 'string' && card !== '') {
          stats.hits += 1;
          return card.replace(/^@+/, '');
        }
      }
      const nickname = people.get(key)?.nickname;
      if (typeof nickname === 'string' && nickname !== '') {
        stats.hits += 1;
        return nickname.replace(/^@+/, '');
      }
      stats.misses += 1;
      return '';
    } catch {
      stats.misses += 1;
      return '';
    }
  }

  return {
    learn,
    learnBatch,
    resolve,
    /** 诊断口径（进调试快照）。 */
    stats: () => ({
      ...stats,
      file: cfg.file,
      size: people.size,
      cardEntries: countCards(),
      groups: cards.size,
      maxPeople: cfg.maxPeople,
      maxCards: cfg.maxCards,
      maxGroups: cfg.maxGroups,
    }),
    file: () => cfg.file,
    enabled: () => stats.enabled && !stats.disabled,
    /** 立刻落盘（测试与"想确认它真的写下来了"时用；**不抛**）。 */
    flush: () => persist(),
    /** 读回磁盘上的表（**只给诊断/测试用**，坏了返回 `null`）。 */
    read: () => {
      try {
        return JSON.parse(f.readFileSync(cfg.file, 'utf8'));
      } catch {
        return null;
      }
    },
    /** 内存里的条目数（测试用）。 */
    people: () => people.size,
    cards: () => countCards(),
  };
}
