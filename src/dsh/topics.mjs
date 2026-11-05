/**
 * 话题状态（M3，2026-11-05）。
 *
 * 目标：记录"这一轮聊到哪、有什么没说完"。与回想（M1）的分工如下：
 * 回想保存的是已经过去的一段聊天摘要；话题状态保存的是**仍然悬着的事项**，
 * 例如某人提出但尚未得到回答的问题、约定待办、表示要去查证的内容。
 *
 * 当前处于**影子模式**：只生成、只写盘、只写日志，不进入提示词。
 * 观察一周后再决定是否注入，以及注入哪些字段。
 *
 * 数据上限：每个会话最多保留 {@link TOPIC_DEFAULTS.maxOpen} 条，单条不超过
 * {@link TOPIC_DEFAULTS.textMax} 字。超出上限时淘汰最早开启且最久未更新的条目。
 */

import fsSync from 'node:fs';
import path from 'node:path';
import { dshHome, resolveStatePath } from './paths.mjs';

export const TOPIC_STORE_VERSION = 1;

export const TOPIC_DEFAULTS = Object.freeze({
  maxOpen: 3,
  textMax: 60,
  debounceMs: 5000,
});

export const TOPIC_KINDS = Object.freeze(['question', 'todo', 'promise', 'other']);

function emptyStore() {
  return { version: TOPIC_STORE_VERSION, chats: {} };
}

/** 单条话题的归一化：缺字段补默认、超长截断、非法类型归为 other。 */
export function normalizeTopic(raw, { now = Date.now() } = {}) {
  if (raw === null || typeof raw !== 'object') return null;
  const text = String(raw.text ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  const kind = TOPIC_KINDS.includes(raw.kind) ? raw.kind : 'other';
  const openedAt = Number(raw.openedAt) > 0 ? Number(raw.openedAt) : now;
  return {
    text: text.slice(0, TOPIC_DEFAULTS.textMax),
    who: String(raw.who ?? '').trim().slice(0, 40),
    kind,
    openedAt,
    updatedAt: Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : openedAt,
  };
}

/** 解析模型输出。容忍 JSON 围栏与多余文字之外的空值。 */
export function parseTopicsPayload(raw) {
  if (raw === null || raw === undefined) return null;
  let value = raw;
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const list = Array.isArray(value.open) ? value.open : [];
  const open = list.map((item) => normalizeTopic(item)).filter(Boolean);
  return { open: open.slice(0, TOPIC_DEFAULTS.maxOpen) };
}

export function parseStore(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed === null || typeof parsed !== 'object') return emptyStore();
    if (parsed.chats === null || typeof parsed.chats !== 'object' || Array.isArray(parsed.chats)) {
      return emptyStore();
    }
    const out = emptyStore();
    for (const [chatId, list] of Object.entries(parsed.chats)) {
      if (!Array.isArray(list)) continue;
      const items = list.map((item) => normalizeTopic(item)).filter(Boolean);
      if (items.length > 0) out.chats[String(chatId)] = items.slice(0, TOPIC_DEFAULTS.maxOpen);
    }
    return out;
  } catch {
    return emptyStore();
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.filePath] 空串表示纯内存，供测试使用
 * @param {() => number} [options.now]
 * @param {object} [options.fs]
 * @param {(level: string, msg: string, meta?: object) => void} [options.log]
 * @param {number} [options.maxOpen]
 * @param {number} [options.debounceMs]
 */
export function createTopicStore({
  filePath = null,
  now = () => Date.now(),
  fs = fsSync,
  log = () => {},
  maxOpen = TOPIC_DEFAULTS.maxOpen,
  debounceMs = TOPIC_DEFAULTS.debounceMs,
} = {}) {
  // 路径归拢（2026-11-05）：默认写入 `<DSH_HOME>/qq-gugu/state/`；
  // 首次运行会把 `<DSH_HOME>/media/` 下的旧文件复制过来（只复制，不删除）。
  filePath = filePath === null
    ? resolveStatePath({ name: 'topics.json', envVar: 'QQ_TOPICS_PATH', legacy: [path.join(dshHome(), 'media', 'qq-topics.json')], log })
    : filePath;
  let store = parseStore(filePath === '' ? null : undefined);
  let timer = null;
  let dirty = false;

  if (filePath !== '') {
    try {
      if (fs.existsSync(filePath)) store = parseStore(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      log('warn', '话题影子：旧文件读不出来，按空库继续', {
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
      log('warn', '话题影子：写盘失败（下次再试）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 整体替换某会话的开放事项。模型给出的是"当前仍然悬着的事项"，
   * 因此采用替换而不是追加，避免同一件事在多轮里重复累积。
   */
  function setOpen(chatId, items) {
    const key = String(chatId ?? '');
    if (key === '') return [];
    const normalized = (Array.isArray(items) ? items : [])
      .map((item) => normalizeTopic(item, { now: now() }))
      .filter(Boolean)
      .slice(0, maxOpen);
    if (normalized.length === 0) delete store.chats[key];
    else store.chats[key] = normalized;
    scheduleSave();
    return normalized;
  }

  function openOf(chatId) {
    return parseStore(JSON.stringify(store)).chats[String(chatId ?? '')] ?? [];
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

  return { setOpen, openOf, flush, toJSON, dispose, filePath };
}
