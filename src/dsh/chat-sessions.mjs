/**
 * QQ 聊天 ↔ DSH 会话 id 的**映射表**（2026-10-24，P1-3/P1-4）。
 *
 * ## 解决的问题
 *
 * 在这之前，插件"会话 id"是**自己拼出来的**：`chatId`（`private:30000001`）
 * → `sessionKeyFromChatId()` → `qq-private-30000001` → 直接当 DSH 的 sessionId 用。
 * 要换成 DSH 标准 id（`session-<uuid>`）之后，**拼不出来了**，必须有个地方记住
 * "这条聊天对应哪个会话" —— 就是这个模块。
 *
 * ## 两个文件（都在 `<DSH_HOME>/media/`）
 *
 * ```json
 * qq-chat-sessions.json     { "private:30000001": "session-8f3a…", "group:30000011": "qq-group-30000011" }
 * qq-retired-sessions.json  [ "qq-private-30000001" ]
 * ```
 *
 * - **退休名单**抄上一代 `dsh-onebot-qq` 的做法：会话恢复失败 / 迁移到新 id 之后，
 *   旧 id 进名单，**永不再用** —— 否则下次启动会把旧历史又"救"回来。
 * - 迁移期表里可以存**旧格式的 id**（`qq-private-…`）：DSH 只校验"非空字符串"，
 *   旧 id 依然合法、依然能 resume。这样切 uuid 之前每张脸都有记录。
 *
 * ## 三条硬规矩
 *
 * 1. **`lookup` 是纯读**（不建、不写、不抛）；建 id 只走 `ensure`。启动路径只许 `lookup`
 *    （见 index.mjs 里 report.target 那段）。
 * 2. **写盘原子 + 留 `.bak`**：先写 tmp 再 rename；写之前把旧文件复制成 `.bak`。
 *    读坏了（JSON 错、类型不对）⇒ 当作空表 + warn，**绝不让插件起不来**。
 * 3. **`ensure` 只分配 id，不建 agent**。建会话（preset/setup/resume）仍然是
 *    `binder.ensure()` 的活。
 *
 * ## 这一版不做什么
 *
 * - **不改任何现有行为**：`policy` 目前只接受 `legacy`（其它值 warn 后按 legacy 处理）。
 *   新 id 的切换是下一步（P2-6），到时候在 `resolver.resolve()` 里加分支。
 * - **不迁移旧会话**：fork 迁移是 P3-9。
 *
 * @module qq-dsh/chat-sessions
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { chatIdFromSessionKey, parseChatId, sessionKeyFromChatId } from './routing.mjs';
import { dshHome } from './paths.mjs';

/** 本部署的 media 目录（推不出来时的兜底，和 group-names.mjs 同一套写法）。 */
const DEFAULT_MEDIA_DIR = path.join(dshHome(), 'media');

/**
 * 默认映射表路径：`<DSH_HOME>/media/qq-chat-sessions.json`。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultSessionsPath(env = process.env) {
  const override = String(env.QQ_SESSION_MAP_FILE ?? '').trim();
  if (override !== '') return override;
  const home = String(env.DSH_HOME ?? '').trim();
  const dir = home === '' ? DEFAULT_MEDIA_DIR : path.join(home, 'media');
  return path.join(dir, 'qq-chat-sessions.json');
}

/**
 * 默认退休名单路径：`<DSH_HOME>/media/qq-retired-sessions.json`。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultRetiredPath(env = process.env) {
  const override = String(env.QQ_SESSION_RETIRED_FILE ?? '').trim();
  if (override !== '') return override;
  const home = String(env.DSH_HOME ?? '').trim();
  const dir = home === '' ? DEFAULT_MEDIA_DIR : path.join(home, 'media');
  return path.join(dir, 'qq-retired-sessions.json');
}

/**
 * 读一个 JSON 文件；不存在 ⇒ `fallback`；坏了 ⇒ `fallback` + warn（**不抛**）。
 * @param {string} file
 * @param {unknown} fallback
 * @param {(level: string, message: string, meta?: object) => void} log
 * @returns {any}
 */
function readJson(file, fallback, log) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log('warn', '会话映射表读不出来，按空表处理', { file, error: error instanceof Error ? error.message : String(error) });
    }
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    // 坏文件不能让插件挂 —— 和本项目所有 toml 读取器同一条规矩。
    log('warn', '会话映射表不是合法 JSON，按空表处理（原文件保持不动）', {
      file,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

/**
 * 原子写 JSON，并保留上一版 `.bak`。
 *
 * 写失败只 warn（**不抛**）：映射表写不进去 = 下一次还要重新落一遍，
 * 但这不该影响她这一轮说话。
 * @param {string} file
 * @param {unknown} value
 * @param {(level: string, message: string, meta?: object) => void} log
 * @param {() => number} now
 * @returns {boolean}
 */
function writeJsonAtomic(file, value, log, now) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${now()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先留上一版（迁移事故时可以把 .bak 拷回去）。
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* 备份失败不影响这次写入 */
    }
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    log('warn', '会话映射表写不进去（本轮继续用内存里那份）', {
      file,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清临时文件失败就算了 */
    }
    return false;
  }
}

/**
 * 造映射表（纯内存 + 两个文件）。
 *
 * @param {object} [options]
 * @param {string} [options.mappingFile]
 * @param {string} [options.retiredFile]
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {() => string} [options.newId] 只给测试注入用（默认 `session-<uuid>`）
 * @param {boolean} [options.persist] 是否落盘（默认 true）。
 *   `false` = **纯内存**：不读盘、不写盘（测试/没有 state 目录的部署用，行为与"空表"一致）。
 * @returns {object} 见下面 return 上的说明
 */
export function createSessionMap({
  mappingFile = defaultSessionsPath(),
  retiredFile = defaultRetiredPath(),
  log = () => {},
  now = () => Date.now(),
  newId = () => `session-${crypto.randomUUID()}`,
  persist = true,
} = {}) {
  /** chatId → sessionId */
  const mapping = new Map();
  /** sessionId → chatId（反查；随 mapping 一起维护） */
  const reverse = new Map();
  /** 退休的 sessionId：永不再用 */
  const retired = new Set();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!persist) return;
    const doc = readJson(mappingFile, {}, log);
    if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
      for (const [chatId, sessionId] of Object.entries(doc)) {
        const chat = String(chatId ?? '').trim();
        const id = typeof sessionId === 'string' ? sessionId.trim() : '';
        // 脏条目直接跳过：不合法的 chatId / 空 id 都不该进表，更不该让插件挂。
        if (parseChatId(chat) === null || id === '') continue;
        if (retired.has(id)) continue;
        mapping.set(chat, id);
        reverse.set(id, chat);
      }
    }
    const list = readJson(retiredFile, [], log);
    if (Array.isArray(list)) {
      for (const id of list) {
        const text = typeof id === 'string' ? id.trim() : '';
        if (text !== '') retired.add(text);
      }
    }
    // 表里出现"已退休"的 id ⇒ 以退休名单为准（这也是防复活的一部分）。
    for (const [chat, id] of [...mapping.entries()]) {
      if (retired.has(id)) {
        mapping.delete(chat);
        reverse.delete(id);
        log('warn', '映射表里的会话 id 已在退休名单里，按未绑定处理', { chatId: chat, sessionId: id });
      }
    }
  }

  function saveMapping() {
    if (!persist) return false;
    const out = {};
    for (const [chatId, sessionId] of mapping) out[chatId] = sessionId;
    return writeJsonAtomic(mappingFile, out, log, now);
  }

  function saveRetired() {
    if (!persist) return false;
    return writeJsonAtomic(retiredFile, [...retired], log, now);
  }

  function chatIdOfSession(sessionId) {
    load();
    return reverse.get(String(sessionId ?? '').trim()) ?? null;
  }

  return {
    get mappingFile() {
      return mappingFile;
    },
    get retiredFile() {
      return retiredFile;
    },

    /** 纯读：这条聊天绑定到哪个会话（没有 ⇒ `null`）。 */
    lookup(chatId) {
      load();
      return mapping.get(String(chatId ?? '').trim()) ?? null;
    },

    /** 这个会话 id 是不是已被退休（永不再用）。 */
    isRetired(sessionId) {
      load();
      return retired.has(String(sessionId ?? '').trim());
    },

    /**
     * 记录一条绑定（迁移期用它把"当前实际在用的旧 id"落进表）。
     * - 已经有**不同**的绑定 ⇒ 保留旧的 + warn（表是唯一真相，不许被顺手改掉）；
     * - 已退休的 id ⇒ 拒绝写回；
     * - 相同 ⇒ 什么都不做。
     * @returns {boolean} 是否真的写了盘
     */
    note(chatId, sessionId) {
      load();
      const chat = String(chatId ?? '').trim();
      const id = String(sessionId ?? '').trim();
      if (parseChatId(chat) === null || id === '') return false;
      const exists = mapping.get(chat);
      if (exists !== undefined) {
        if (exists !== id) {
          log('warn', '会话映射表已有不同的 id，保留原绑定（不覆盖）', { chatId: chat, kept: exists, ignored: id });
        }
        return false;
      }
      if (retired.has(id)) {
        log('warn', '拒绝把已退休的会话 id 写回映射表', { chatId: chat, sessionId: id });
        return false;
      }
      mapping.set(chat, id);
      reverse.set(id, chat);
      saveMapping();
      return true;
    },

    /**
     * 查不到就**分配**一个新 id 并落盘（只分配 id，不建 agent）。
     * @returns {string|null} 新/已有 id；chatId 不合法 ⇒ `null`
     */
    ensure(chatId) {
      load();
      const chat = String(chatId ?? '').trim();
      if (parseChatId(chat) === null) return null;
      const hit = mapping.get(chat);
      if (hit !== undefined) return hit;
      let id = String(newId());
      // 撞上现有 id 或退休名单（极端情况，uuid 基本不会）⇒ 重摇。
      let guard = 0;
      while ((reverse.has(id) || retired.has(id)) && guard < 100) {
        id = String(newId());
        guard += 1;
      }
      mapping.set(chat, id);
      reverse.set(id, chat);
      saveMapping();
      return id;
    },

    /** 反查：会话 id → chatId（没有 ⇒ `null`）。 */
    chatIdOfSession,

    /** 群/私聊（不认识 ⇒ `'unknown'`）。 */
    kindOfSession(sessionId) {
      const chatId = chatIdOfSession(sessionId);
      if (chatId === null) return 'unknown';
      const parsed = parseChatId(chatId);
      return parsed === null ? 'unknown' : parsed.kind;
    },

    /** 私聊对方的 QQ 号（群/不认识 ⇒ `''`）。 */
    userIdOfSession(sessionId) {
      const chatId = chatIdOfSession(sessionId);
      if (chatId === null) return '';
      const parsed = parseChatId(chatId);
      return parsed !== null && parsed.kind === 'private' ? parsed.id : '';
    },

    /** 这个会话归不归本插件管。 */
    hasSession(sessionId) {
      return chatIdOfSession(sessionId) !== null;
    },

    /**
     * 退休一个会话 id：从表里摘掉 + 进退休名单（两个文件都写）。
     * @returns {boolean} 是否真的落了盘
     */
    retire(sessionId) {
      load();
      const id = String(sessionId ?? '').trim();
      if (id === '') return false;
      let changed = false;
      const chatId = reverse.get(id);
      if (chatId !== undefined) {
        mapping.delete(chatId);
        reverse.delete(id);
        saveMapping();
        changed = true;
      }
      if (!retired.has(id)) {
        retired.add(id);
        saveRetired();
        changed = true;
      }
      return changed;
    },

    /** 诊断/测试用：表里全部条目。 */
    entries() {
      load();
      return [...mapping.entries()].map(([chatId, sessionId]) => ({ chatId, sessionId }));
    },

    /** 快照用：路径 + 条数（不含内容）。 */
    stats() {
      load();
      return { mappingFile, retiredFile, entries: mapping.size, retired: retired.size };
    },

    /** 测试用：丢掉内存状态、下次访问重新读盘。 */
    reload() {
      loaded = false;
      mapping.clear();
      reverse.clear();
      retired.clear();
    },
  };
}

/**
 * 把"映射表 + 旧前缀回退"合成插件内部到处要用的**解析器**。
 *
 * 这是 P1-4 的接线点：凡是"从会话键反推 chatId / 群还是私聊 / QQ 号"的地方，
 * 都改成问它；它内部先查表，查不到再回退旧前缀（迁移期新旧 id 并存）。
 *
 * ⚠️ **这一版仍是纯回退语义**（`policy: 'legacy'`）：`resolve()` 不会分配新 id。
 * 新 id 的切换（P2-6）到时候在这个函数里加分支，调用点不用再动。
 *
 * @param {object} options
 * @param {ReturnType<typeof createSessionMap>} options.map
 * @param {'legacy'|'new-if-no-legacy'} [options.policy]
 *   - `legacy`（旧默认）：永远用旧前缀拼串；
 *   - `new-if-no-legacy`（2026-10-24 用户选定）：表里有就用表；没有就让 binder 先拿旧 id
 *     **试着 resume**，接不回来（= 没有旧会话）才分配 `session-<uuid>`。
 *     已有旧 id 的聊天在 P3-9 迁移之前**保持旧 id**。
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @returns {object}
 */
export function createSessionResolver({ map, policy = 'legacy', log = () => {} } = {}) {
  const effectivePolicy = policy === 'new-if-no-legacy' || policy === 'legacy' ? policy : 'legacy';
  if (effectivePolicy !== policy) {
    log('warn', 'sessionIdPolicy 只支持 legacy / new-if-no-legacy，按 legacy 处理', { policy });
  }

  function chatIdOf(sessionId) {
    const text = String(sessionId ?? '').trim();
    if (text === '') return '';
    const mapped = map.chatIdOfSession(text);
    if (mapped !== null) return mapped;
    return chatIdFromSessionKey(text);
  }

  function kindOf(sessionKey) {
    const text = String(sessionKey ?? '').trim().toLowerCase();
    if (text === '') return 'unknown';
    // 允许直接把 chatId 传进来（`sessionKindOf` 的历史行为，测试也在用）。
    const asChat = parseChatId(text);
    if (asChat !== null) return asChat.kind;
    const chatId = chatIdOf(text);
    if (chatId !== '') {
      const parsed = parseChatId(chatId);
      if (parsed !== null) return parsed.kind;
    }
    // 旧前缀兜底（含 onebot 旧 id、`qq-group-unknown` 这类）。
    if (text.startsWith('qq-group-') || text.startsWith('onebot-group-')) return 'group';
    if (text.startsWith('qq-private-') || text.startsWith('onebot-private-')) return 'private';
    return 'unknown';
  }

  function userIdOf(sessionKey) {
    const text = String(sessionKey ?? '').trim();
    if (text === '') return '';
    const chatId = chatIdOf(text);
    if (chatId !== '') {
      const parsed = parseChatId(chatId);
      if (parsed !== null && parsed.kind === 'private') return parsed.id;
    }
    const m = /^(?:qq|onebot)-private-(\d+)$/.exec(text);
    return m === null ? '' : m[1];
  }

  function scopeOf(sessionKey) {
    const kind = kindOf(sessionKey);
    if (kind === 'group' || kind === 'private') {
      const chatId = chatIdOf(sessionKey);
      if (chatId !== '') {
        const parsed = parseChatId(chatId);
        if (parsed !== null) return { kind, id: parsed.id };
      }
      // 旧前缀：`qq-group-30000013` → id 就是最后那段。
      const m = /^(?:qq|onebot)-(?:group|private)-(.+)$/.exec(String(sessionKey ?? '').trim());
      if (m !== null) return { kind, id: m[1] };
    }
    return null;
  }

  return {
    /** 当前生效的 id 策略（`legacy` / `new-if-no-legacy`）。 */
    policy: effectivePolicy,

    /** 纯读（启动/配置校验只许用这个）。 */
    lookup(chatId) {
      return map.lookup(chatId);
    },

    /**
     * 这条聊天该用哪个会话 id：表里有就表里的，否则旧前缀拼串。
     *
     * ⚠️ 这里是**纯路由**，不做"要不要新建"的判断 —— 新 id 只在
     * {@link afterResumeFailure} 里分配（resume 失败 = 确实没有旧会话）。
     * @returns {{sessionId: string, source: 'map'|'legacy'|'unresolvable'}}
     */
    resolve(chatId) {
      const chat = String(chatId ?? '').trim();
      const mapped = map.lookup(chat);
      if (mapped !== null) return { sessionId: mapped, source: 'map' };
      const legacy = sessionKeyFromChatId(chat);
      if (legacy === '') return { sessionId: '', source: 'unresolvable' };
      if (map.isRetired(legacy)) {
        log('warn', '这条聊天的旧会话 id 已退休（映射表却查不到它，表可能丢了）；先按旧 id 试一次', {
          chatId: chat,
          sessionId: legacy,
        });
      }
      return { sessionId: legacy, source: 'legacy' };
    },

    /**
     * binder 的 resume 失败后调用（2026-10-24，P2-6）。
     *
     * - `legacy` ⇒ 返回 `null`（调用方照旧：用原 id 新建，行为与改动前一致）；
     * - `new-if-no-legacy` ⇒ **分配一个 `session-<uuid>` 并写进表**，返回
     *   `{sessionId, source:'new'}`。这就是"新聊天走新 id"的唯一入口。
     *
     * @param {string} chatId
     * @param {string} legacySessionKey resume 用过的旧 id（只进日志/诊断）
     * @returns {{sessionId: string, source: 'new'} | null}
     */
    afterResumeFailure(chatId, legacySessionKey) {
      if (effectivePolicy !== 'new-if-no-legacy') return null;
      const chat = String(chatId ?? '').trim();
      if (parseChatId(chat) === null) return null;
      const id = map.ensure(chat);
      if (id === null) return null;
      log('info', '这条聊天没有可接回的旧会话，按 new-if-no-legacy 分配新 id', {
        chatId: chat,
        legacySessionKey: String(legacySessionKey ?? ''),
        sessionId: id,
      });
      return { sessionId: id, source: 'new' };
    },

    /** 把"当前实际在用的 id"记进表（迁移期靠它把旧 id 积累下来）。 */
    note(chatId, sessionId) {
      return map.note(chatId, sessionId);
    },
    chatIdOf,
    kindOf,
    userIdOf,
    scopeOf,
    has(sessionId) {
      const text = String(sessionId ?? '').trim();
      if (text === '') return false;
      if (map.hasSession(text)) return true;
      return /^(qq|onebot)-/.test(text);
    },
    retire(sessionId) {
      return map.retire(sessionId);
    },
    entries() {
      return map.entries();
    },
    stats() {
      return map.stats();
    },
  };
}
