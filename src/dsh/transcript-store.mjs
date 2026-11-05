/**
 * 转录落盘（M1b，2026-11-05）。
 *
 * 现在转录是**纯内存**的：插件一重载/重启就空，只能靠 NapCat 回填 20 条。
 * 这个模块把每个会话的转录环形缓冲**定期写盘**，启动时读回来 —— 重启不再等于失忆。
 *
 * 只存"能重建上下文的最小字段"（谁、什么时候、说了什么、是不是自己），
 * 不存图片描述、不存原始事件。文件大小按 24 会话 × 60 条封顶。
 */

import fsSync from 'node:fs';
import path from 'node:path';
import { dshHome, resolveStatePath } from './paths.mjs';

export const TRANSCRIPT_STORE_VERSION = 1;

export const TRANSCRIPT_DEFAULTS = Object.freeze({
  maxPerChat: 60,
  maxChats: 24,
  debounceMs: 5000,
});

function emptyStore() {
  return { version: TRANSCRIPT_STORE_VERSION, chats: {} };
}

/** 只保留重建上下文需要的字段；坏条目直接丢。 */
export function slimEntry(m) {
  if (m === null || typeof m !== 'object') return null;
  const at = Number(m.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const text = String(m.text ?? '');
  if (text === '') return null;
  return {
    messageId: Number.isFinite(Number(m.messageId)) ? Number(m.messageId) : undefined,
    chatId: String(m.chatId ?? ''),
    userId: String(m.userId ?? ''),
    nickname: String(m.nickname ?? ''),
    text,
    at,
    fromSelf: m.fromSelf === true,
    kind: m.kind === 'private' ? 'private' : 'group',
  };
}

export function parseStore(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed === null || typeof parsed !== 'object') return emptyStore();
    if (parsed.chats === null || typeof parsed.chats !== 'object' || Array.isArray(parsed.chats)) {
      return emptyStore();
    }
    const out = emptyStore();
    for (const [chatId, entries] of Object.entries(parsed.chats)) {
      if (!Array.isArray(entries)) continue;
      const slim = entries.map(slimEntry).filter(Boolean);
      if (slim.length > 0) out.chats[String(chatId)] = slim;
    }
    return out;
  } catch {
    return emptyStore();
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.filePath] 空串 = 纯内存（测试）
 * @param {object} [options.fs]
 * @param {(level: string, msg: string, meta?: object) => void} [options.log]
 * @param {number} [options.maxPerChat]
 * @param {number} [options.maxChats]
 * @param {number} [options.debounceMs]
 */
export function createTranscriptStore({
  filePath = null,
  fs = fsSync,
  log = () => {},
  maxPerChat = TRANSCRIPT_DEFAULTS.maxPerChat,
  maxChats = TRANSCRIPT_DEFAULTS.maxChats,
  debounceMs = TRANSCRIPT_DEFAULTS.debounceMs,
} = {}) {
  // 路径归拢（2026-11-05）：默认写入 `<DSH_HOME>/qq-gugu/state/`；
  // 首次运行会把 `<DSH_HOME>/media/` 下的旧文件复制过来（只复制，不删除）。
  filePath = filePath === null
    ? resolveStatePath({ name: 'transcripts.json', envVar: 'QQ_TRANSCRIPTS_PATH', legacy: [path.join(dshHome(), 'media', 'qq-transcripts.json')], log })
    : filePath;
  let store = emptyStore();
  let timer = null;
  let dirty = false;

  if (filePath !== '') {
    try {
      if (fs.existsSync(filePath)) {
        store = parseStore(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (error) {
      log('warn', '转录落盘：旧文件读不出来，按空库继续', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function scheduleSave() {
    if (filePath === '' || timer !== null) return;
    dirty = true;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, Math.max(0, Number(debounceMs) || 0));
    if (typeof timer?.unref === 'function') timer.unref();
  }

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
      log('warn', '转录落盘：写盘失败（下次再试）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** 用引擎当前的全部转录**整体替换**（不做增量，简单且不会漂）。 */
  function replaceAll(input) {
    if (input === null || typeof input !== 'object') return;
    const next = emptyStore();
    for (const [chatId, entries] of Object.entries(input)) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      const slim = entries
        .slice(-Math.max(1, maxPerChat))
        .map(slimEntry)
        .filter(Boolean);
      if (slim.length > 0) next.chats[String(chatId)] = slim;
    }
    // 会话数封顶：保留"最新一条"更靠后的那些
    const ids = Object.keys(next.chats);
    if (ids.length > maxChats) {
      ids.sort((a, b) => {
        const lastA = next.chats[a][next.chats[a].length - 1]?.at ?? 0;
        const lastB = next.chats[b][next.chats[b].length - 1]?.at ?? 0;
        return lastA - lastB;
      });
      for (const id of ids.slice(0, ids.length - maxChats)) delete next.chats[id];
    }
    store = next;
    scheduleSave();
  }

  function load() {
    return JSON.parse(JSON.stringify(store.chats));
  }

  function toJSON() {
    return JSON.parse(JSON.stringify(store));
  }

  function dispose() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
  }

  return { replaceAll, load, flush, toJSON, dispose, filePath };
}
