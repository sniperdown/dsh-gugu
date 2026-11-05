/**
 * 关系记账（A 段，2026-11-04）。
 *
 * 为什么要有它：`relations` 是一段**静态文案**（对用户软、对群友损），同一个人
 * 「七年的老友」和「刚进群的新人」拿到的是同一段话 —— 那是**身份**，不是**关系**。
 * 这个模块只做一件事：按 `(chatId, userId)` 累计最朴素的互动事实，
 * 让上层能分出生面孔 / 认识 / 熟人三档，并且**不调任何模型**。
 *
 * 刻意不做的事：
 * - 不判断"这人重不重要"（那是画像层的事）；
 * - 不存聊天原文（只存计数与时间戳，隐私面为零）；
 * - 不因为写盘失败影响主链路（全部 try/catch，最多丢一次待写）。
 *
 * 落盘：`QQ_RELATIONS_PATH` 优先，否则 `<DSH_HOME>/media/qq-relations.json`。
 * 环形裁剪：每个会话最多 `maxUsersPerChat` 个用户、`maxChats` 个会话，
 * 按 `lastSeen` 淘汰最旧的 —— 内存与文件都不会随时间无限长。
 */

import fsSync from 'node:fs';
import path from 'node:path';
import { dshHome, resolveStatePath } from './paths.mjs';

export const RELATIONS_VERSION = 1;

/** 三档关系。阈值见 {@link tierFromCounts}。 */
export const RELATION_TIERS = Object.freeze({
  stranger: '生面孔',
  known: '认识',
  familiar: '熟人',
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 由计数推档位（纯函数，测试直接打这个）。
 *
 * 阈值是**先拍一个能解释的**，不是拟合出来的：
 * - 熟人：互相说过 30 句以上，且至少认识 7 天，且被点名 ≥2 次；
 * - 认识：说过 5 句以上，或认识超过 3 天；
 * - 其余是生面孔。
 *
 * 为什么不用"最近活跃"当主判据：群里有人一天说 50 句、然后消失，那是热闹，
 * 不是熟。熟用"总量 + 时间跨度 + 被点名"三个都站得住才给。
 */
export function tierFromCounts({ msgs = 0, ats = 0, days = 0 } = {}) {
  const n = Number(msgs) || 0;
  const a = Number(ats) || 0;
  const d = Number(days) || 0;
  if (n >= 30 && d >= 7 && a >= 2) return 'familiar';
  if (n >= 5 || d >= 3) return 'known';
  return 'stranger';
}

/** 一行关系摘要。给提示词用，必须短（≤ 40 字），且不出现具体聊天内容。 */
export function relationLine({ nickname = '', userId = '', counts = {}, now = Date.now() } = {}) {
  const n = Math.max(0, Number(counts.msgs) || 0);
  const a = Math.max(0, Number(counts.ats) || 0);
  const first = Number(counts.firstSeen) || 0;
  const days = first > 0 ? Math.max(0, Math.floor((now - first) / DAY_MS)) : 0;
  const tier = tierFromCounts({ msgs: n, ats: a, days });
  const who = String(nickname ?? '').trim() || String(userId ?? '').trim() || '这个人';
  const parts = [`跟${who}：${RELATION_TIERS[tier]}`];
  if (days >= 1) parts.push(`认识 ${days} 天`);
  if (n > 0) parts.push(`说过 ${n} 句`);
  if (a > 0) parts.push(`被点名 ${a} 次`);
  return parts.join('，');
}

function emptyStore() {
  return { version: RELATIONS_VERSION, chats: {} };
}

/** 容忍一切坏数据：读不出来就当空库，绝不抛。 */
export function parseStore(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed === null || typeof parsed !== 'object') return emptyStore();
    if (parsed.chats === null || typeof parsed.chats !== 'object' || Array.isArray(parsed.chats)) {
      return emptyStore();
    }
    return { version: RELATIONS_VERSION, chats: parsed.chats };
  } catch {
    return emptyStore();
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.filePath] 落盘路径；空串 = 纯内存（测试用）
 * @param {() => number} [options.now]
 * @param {object} [options.fs] 注入的 fs（测试用；默认 node:fs）
 * @param {(level: string, msg: string, meta?: object) => void} [options.log]
 * @param {number} [options.debounceMs] 写盘去抖，默认 8s
 * @param {number} [options.maxChats]
 * @param {number} [options.maxUsersPerChat]
 */
export function createRelationsLedger({
  filePath = null,
  now = () => Date.now(),
  fs = fsSync,
  log = () => {},
  debounceMs = 8000,
  maxChats = 24,
  maxUsersPerChat = 400,
} = {}) {
  // 路径归拢（2026-11-05）：默认写入 `<DSH_HOME>/qq-gugu/state/`；
  // 首次运行会把 `<DSH_HOME>/media/` 下的旧文件复制过来（只复制，不删除）。
  filePath = filePath === null
    ? resolveStatePath({ name: 'relations.json', envVar: 'QQ_RELATIONS_PATH', legacy: [path.join(dshHome(), 'media', 'qq-relations.json')], log })
    : filePath;
  const store = emptyStore();
  let timer = null;
  let dirty = false;
  let disposed = false;

  // 首次加载：读不出来就当空库（不抛、不阻塞启动）。
  if (filePath !== '') {
    try {
      if (fs.existsSync(filePath)) {
        const loaded = parseStore(fs.readFileSync(filePath, 'utf8'));
        Object.assign(store.chats, loaded.chats);
      }
    } catch (error) {
      log('warn', '关系记账：旧文件读不出来，按空库继续', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function chatOf(chatId) {
    const key = String(chatId ?? '');
    if (key === '') return null;
    if (store.chats[key] === undefined) store.chats[key] = { users: {} };
    return store.chats[key];
  }

  function pruneChat(chat) {
    const entries = Object.entries(chat.users);
    if (entries.length <= maxUsersPerChat) return;
    entries.sort((a, b) => (Number(a[1]?.lastSeen) || 0) - (Number(b[1]?.lastSeen) || 0));
    for (const [uid] of entries.slice(0, entries.length - maxUsersPerChat)) delete chat.users[uid];
  }

  function pruneChats() {
    const keys = Object.keys(store.chats);
    if (keys.length <= maxChats) return;
    const scored = keys.map((k) => {
      const users = Object.values(store.chats[k]?.users ?? {});
      const newest = users.reduce((m, u) => Math.max(m, Number(u?.lastSeen) || 0), 0);
      return [k, newest];
    });
    scored.sort((a, b) => a[1] - b[1]);
    for (const [k] of scored.slice(0, scored.length - maxChats)) delete store.chats[k];
  }

  function scheduleSave() {
    if (filePath === '' || disposed) return;
    dirty = true;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, Math.max(0, Number(debounceMs) || 0));
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** 立刻落盘（原子写：先写 .tmp 再 rename，坏在一次写一半的概率极低）。 */
  function flush() {
    if (filePath === '' || !dirty) return false;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
      return true;
    } catch (error) {
      dirty = true;
      log('warn', '关系记账：写盘失败（下一条消息再试）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 记一条入站消息。
   * @returns {boolean} 是否记进（chatId/userId 缺失时 false）
   */
  function observe({ chatId, userId, at, mentioned = false, nickname = '' } = {}) {
    try {
      // 先验参数再建会话：否则缺 userId 的坏消息会在库里留一个空会话（测试逮到过）。
      const uid = String(userId ?? '');
      const key = String(chatId ?? '');
      if (uid === '' || key === '') return false;
      const chat = chatOf(key);
      if (chat === null) return false;
      const t = Number(at) > 0 ? Number(at) : now();
      const prev = chat.users[uid] ?? { msgs: 0, ats: 0, firstSeen: t, lastSeen: t };
      prev.msgs = (Number(prev.msgs) || 0) + 1;
      prev.lastSeen = Math.max(Number(prev.lastSeen) || 0, t);
      prev.firstSeen = Number(prev.firstSeen) > 0 ? Math.min(Number(prev.firstSeen), t) : t;
      if (mentioned === true) prev.ats = (Number(prev.ats) || 0) + 1;
      // 顺带记住最新昵称（群里改名片很常见）：渲染关系摘要时用它，省得绑定层再去查一次。
      const name = String(nickname ?? '').trim();
      if (name !== '') prev.nickname = name;
      chat.users[uid] = prev;
      pruneChat(chat);
      pruneChats();
      scheduleSave();
      return true;
    } catch (error) {
      log('debug', '关系记账：observe 失败（忽略）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function countsOf(chatId, userId) {
    try {
      return store.chats[String(chatId ?? '')]?.users?.[String(userId ?? '')] ?? null;
    } catch {
      return null;
    }
  }

  function tierOf(chatId, userId, at = now()) {
    const c = countsOf(chatId, userId);
    if (c === null) return 'stranger';
    const days = Number(c.firstSeen) > 0 ? Math.floor((at - Number(c.firstSeen)) / DAY_MS) : 0;
    return tierFromCounts({ msgs: c.msgs, ats: c.ats, days });
  }

  function lineFor({ chatId, userId, nickname = '' } = {}) {
    const c = countsOf(chatId, userId);
    if (c === null) return '';
    // 调用方不给名字就用记账时存下的最新昵称（再没有就用 QQ 号兜底）。
    const name = String(nickname ?? '').trim() || String(c.nickname ?? '').trim();
    return relationLine({ nickname: name, userId, counts: c, now: now() });
  }

  function toJSON() {
    return JSON.parse(JSON.stringify(store));
  }

  function dispose() {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
  }

  return { observe, countsOf, tierOf, lineFor, flush, toJSON, dispose, filePath };
}

let shared = null;

/**
 * 网关与绑定共用的**同一个**实例（模块级单例）。
 *
 * 为什么不从 `index.mjs` 注入：那份文件正被另一个会话改着（工作树有未提交改动），
 * 少一处接线就少一处冲突面。等路径归拢（报告第十节第 4 项）落地时再统一走注入。
 */
export function sharedLedger(options = {}) {
  if (shared === null) shared = createRelationsLedger(options);
  return shared;
}

/** 测试用：扔掉单例（不影响已创建的引用）。 */
export function resetSharedLedger() {
  shared = null;
}
