/**
 * 聊天回想（M1，2026-11-04）。
 *
 * 解决的是**超窗即丢**：转录是 60 条的环形缓冲，第 61 条进来时第 1 条就没了。
 * 这一层把"被挤出去的那一段"压成一条**摘要 + 3~5 条线索（cues）**存起来，
 * 下轮按当前消息做**字面召回**，命中就往提示词里补一行。
 *
 * 为什么是字面召回而不是向量：用户拍板「先跑一周看数据」；中文 bigram 重叠在
 * 群里够用，且不引入 embedding 依赖。将来不够再换。
 *
 * 与 knowledge 的分工：knowledge 是"关于某人的长期事实/画像"，回想是
 * "前一阵子聊过什么"——两者来源、时效、注入位置都不同，不合并。
 */

import fsSync from 'node:fs';
import path from 'node:path';
import { dshHome, resolveStatePath } from './paths.mjs';

export const RECALL_VERSION = 1;

export const RECALL_DEFAULTS = Object.freeze({
  /** 每个会话最多保留多少条回想 */
  maxEntries: 10,
  /** 单条摘要的字符上限 */
  summaryMax: 200,
  /** 线索条数 */
  cuesMin: 3,
  cuesMax: 5,
  /** 字面召回的分数门槛（bigram 重叠率） */
  minScore: 0.12,
  /** 注入字数上限：群聊 / 私聊 */
  injectChars: { group: 150, private: 300 },
  /** 写盘去抖 */
  debounceMs: 8000,
});

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyStore() {
  return { version: RECALL_VERSION, chats: {} };
}

/** 中文按 2-gram、拉丁按整词，统一取"可比较的片断集合"。 */
export function grams(text) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set();
  if (s === '') return out;
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

/** 重合度：命中片断数 / 查询片断数（不惩罚回想比查询长）。 */
export function overlapScore(query, target) {
  const q = grams(query);
  const t = grams(target);
  if (q.size === 0 || t.size === 0) return 0;
  let hit = 0;
  for (const g of q) if (t.has(g)) hit += 1;
  return hit / q.size;
}

/** 容忍坏数据：解析不出来就返回 null（调用方跳过这条压缩结果）。 */
export function parseRecallPayload(raw) {
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
  const summary = String(value.summary ?? '').trim();
  const cuesRaw = Array.isArray(value.cues) ? value.cues : [];
  const cues = cuesRaw.map((c) => String(c ?? '').trim()).filter((c) => c !== '');
  if (summary === '' && cues.length === 0) return null;
  return { summary, cues: cues.slice(0, RECALL_DEFAULTS.cuesMax) };
}

export function formatRecall(entry, { maxChars = 200 } = {}) {
  if (entry === null || entry === undefined) return '';
  const summary = String(entry.summary ?? '').trim();
  const cues = Array.isArray(entry.cues) ? entry.cues.filter(Boolean) : [];
  const tail = cues.length > 0 ? `（线索：${cues.slice(0, 3).join(' / ')}）` : '';
  const budget = Math.max(20, maxChars - tail.length);
  const body = summary.length > budget ? `${summary.slice(0, budget)}…` : summary;
  const line = `【之前聊过】${body}${tail}`;
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

/**
 * @param {object} [options]
 * @param {string} [options.filePath] 空串 = 纯内存（测试）
 * @param {() => number} [options.now]
 * @param {object} [options.fs]
 * @param {(level: string, msg: string, meta?: object) => void} [options.log]
 * @param {number} [options.maxEntries]
 * @param {number} [options.debounceMs]
 */
export function createRecallStore({
  filePath = null,
  now = () => Date.now(),
  fs = fsSync,
  log = () => {},
  maxEntries = RECALL_DEFAULTS.maxEntries,
  debounceMs = RECALL_DEFAULTS.debounceMs,
} = {}) {
  // 路径归拢（2026-11-05）：默认写入 `<DSH_HOME>/qq-gugu/state/`；
  // 首次运行会把 `<DSH_HOME>/media/` 下的旧文件复制过来（只复制，不删除）。
  filePath = filePath === null
    ? resolveStatePath({ name: 'recall.json', envVar: 'QQ_RECALL_PATH', legacy: [path.join(dshHome(), 'media', 'qq-recall.json')], log })
    : filePath;
  const store = emptyStore();
  let timer = null;
  let dirty = false;

  if (filePath !== '') {
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.chats && typeof parsed.chats === 'object' && !Array.isArray(parsed.chats)) {
          Object.assign(store.chats, parsed.chats);
        }
      }
    } catch (error) {
      log('warn', '回想：旧文件读不出来，按空库继续', {
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
      log('warn', '回想：写盘失败（下次再试）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function listOf(chatId) {
    const key = String(chatId ?? '');
    if (key === '') return null;
    if (!Array.isArray(store.chats[key])) store.chats[key] = [];
    return store.chats[key];
  }

  /** 存一条回想；同会话超过上限就淘汰最旧的。 */
  function add({ chatId, summary, cues = [], at = now() } = {}) {
    const list = listOf(chatId);
    if (list === null) return null;
    const payload = parseRecallPayload({ summary, cues });
    if (payload === null) return null;
    const entry = {
      summary: payload.summary.slice(0, RECALL_DEFAULTS.summaryMax),
      cues: payload.cues,
      at: Number(at) > 0 ? Number(at) : now(),
      hits: 0,
    };
    list.push(entry);
    while (list.length > maxEntries) list.shift();
    scheduleSave();
    return entry;
  }

  function recent(chatId, n = maxEntries) {
    const list = listOf(chatId);
    if (list === null) return [];
    return list.slice(-Math.max(1, n));
  }

  /**
   * 召回：按字面重叠挑一条。
   * 同分时**新的优先**；超过 3 天没被命中过的降权（旧话题不该一直被翻出来）。
   */
  function recall({ chatId, text = '', minScore = RECALL_DEFAULTS.minScore } = {}) {
    const list = listOf(chatId);
    if (list === null || list.length === 0) return null;
    const t = now();
    let best = null;
    const query = String(text ?? '');
    for (const entry of list) {
      const haystack = `${entry.summary} ${entry.cues.join(' ')}`;
      let score = overlapScore(query, haystack);
      // 线索命中是强信号：中文里一个字面 cue（如「考研」）常常就是"在聊同一件事"。
      // 只算子串命中、最多加 3 条，避免长 query 把分数抬满。
      let cueHits = 0;
      for (const cue of entry.cues) {
        const c = String(cue ?? '').trim();
        if (c !== '' && query.includes(c)) cueHits += 1;
      }
      if (cueHits > 0) score = Math.min(1, score + 0.15 * Math.min(cueHits, 3));
      if (score <= 0) continue;
      const ageDays = Math.max(0, (t - Number(entry.at || t)) / DAY_MS);
      if (ageDays > 3) score *= 0.5;
      if (best === null || score > best.score || (score === best.score && entry.at > best.entry.at)) {
        best = { entry, score };
      }
    }
    if (best === null || best.score < minScore) return null;
    best.entry.hits = (Number(best.entry.hits) || 0) + 1;
    scheduleSave();
    return { ...best.entry, score: best.score };
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

  return { add, recent, recall, flush, toJSON, dispose, filePath };
}
