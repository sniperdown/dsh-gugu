/**
 * **本地聊天记录**（jsonl 追加式，2026-11-18）。
 *
 * ## 它是什么
 *
 * 每个会话**两个方向**的正文，一行一条：入站（别人说了什么）与出站（她真的发出去
 * 什么、还是没发出去）。方案与判据见 `shared/2026-11-18-聊天记录方案.md`。
 *
 * ## 为什么不合并进 `qq-outbound.jsonl`（这两份文件必须分开）
 *
 * | | `qq-outbound.jsonl` | 本文件 |
 * |---|---|---|
 * | 用途 | 判"**是不是发了两遍**" | **上下文**（重启后她还记得自己说过什么） |
 * | 正文 | **刻意不存**（只有 `chars` + `sha256`） | 存全文 |
 * | 生命周期 | 滚动 5000 行 | 滚动 `maxLines`（20000） |
 * | 隐私等级 | 低（哈希） | **高（群聊全文，不可外传）** |
 *
 * `outbound-ledger.mjs` 的注释写着"⚠️ 绝不记正文：只记 chars + sha256"，那是**有意**的；
 * 本文件**故意反着做**，因为它的用途是"让模型知道自己说过什么"。合并两边会把
 * 台账的判读表弄脏（一行 = 一次"决定要发"），并让"哈希台账"失去它唯一的优点。
 * 同一条纪律的先例：`sticker-audit.mjs` 与表情包库刻意不合并（两个目录两种语义）。
 *
 * ## 三条硬约束（与 `gauge-log.mjs` / `outbound-ledger.mjs` 同一条规矩）
 *
 * 1. **绝不抛**：写盘失败、序列化失败、盘满、路径不可写 —— 全部吞成一条 `debug` 日志。
 *    它挂在消息热路径上，抛出去 = 掐断这一轮（`qq-plugin/AGENTS.md` 第三节）。
 * 2. **只追加，不回头改**：`appendFileSync` 一行；崩溃最多丢最后半行。
 *    （对比 `transcript-store.mjs` 的整文件重写：那边每 20 秒重写一次 96 KB，
 *    进程被硬杀时**最多丢 20 秒**；这边丢半行。）
 * 3. **`delivered` 双向写、单向读**：成功行 `delivered:true`、失败行 `delivered:false` + `error`
 *    （供人工排查），但**回灌时一律过滤掉失败行** —— 见 {@link isReplayable}。
 *
 * ## 名字与形状
 *
 * - 默认落 `<DSH_HOME>/media/qq-chatlog.jsonl`（与 `qq-outbound.jsonl` / `qq-gauge.jsonl`
 *   同一棵树，路径走 `paths.mjs` 的 `resolveMediaPath`，**不自己拼字符串**）；
 * - 与环境变量 `QQ_CHATLOG_PATH` 覆盖；
 * - ⚠️ 与 `sticker-audit/index.jsonl` 不是一回事（那个是审核留样索引，不同目录）。
 *
 * @module qq-dsh/chat-log
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveMediaPath } from './paths.mjs';

/** 默认文件名。 */
export const CHAT_LOG_FILE = 'qq-chatlog.jsonl';

/** 路径覆盖用的环境变量（排障：`QQ_CHATLOG_PATH=D:\tmp\c.jsonl`）。 */
export const CHAT_LOG_ENV = 'QQ_CHATLOG_PATH';

/** 方向：入站（别人说的）。 */
export const DIR_IN = 'in';
/** 方向：出站（她说的）。 */
export const DIR_OUT = 'out';

/** 默认行数上限（≈5 MB）。 */
export const DEFAULT_CHAT_LOG_MAX_LINES = 20_000;

/**
 * 追到 `maxLines × TRIM_FACTOR` 才裁一次，裁完留尾部 `maxLines` 行。
 * 照抄 `outbound-ledger.mjs`：每写一行就裁一次等于每行都读全文件。
 */
export const TRIM_FACTOR = 1.5;

/** 兜底默认值。 */
export const DEFAULT_CHAT_LOG = Object.freeze({
  /**
   * ⚠️ **默认关闭**。
   *
   * 理由不是"不重要"，而是**两条**：
   *   ① 这份文件是**群聊全文**（比哈希台账敏感得多），想开得有人明确点头；
   *   ② 测试会构造大量 `ProactiveEngine` / `Gateway`，默认打开就等于每次 `npm test`
   *      都往真实聊天记录里灌一遍假消息（`outbound-ledger` 因此是"注入式、默认 null"）。
   * 打开方式：`createChatLog({ config: { enabled: true } })` 注入，或设 `QQ_CHATLOG_PATH`。
   */
  enabled: false,
  maxLines: DEFAULT_CHAT_LOG_MAX_LINES,
  /** 启动时把本地记录灌回转录（"先本地、后 NapCat"里的"先本地"）。 */
  replayOnStart: true,
  /** 失败行也落一条（供人工排查）；回灌时**永远**过滤掉，见 `isReplayable`。 */
  recordFailures: true,
  /** 存 `wire`（段类型序列，约 20 B/行）：复核"这条到底带了几张图"。 */
  includeWire: true,
  /**
   * 写入前对正文跑的脱敏正则（字符串或 RegExp），命中替换成 `[已屏蔽]`。
   *
   * ⚠️ **默认空列表，只留机制**：任何默认正则都会误杀正常对话
   * （`1234567` 是 QQ 号，不是密码）。要开的人自己写规则。
   */
  redactPatterns: Object.freeze([]),
});

/** 屏蔽后的占位符。 */
export const REDACTED = '[已屏蔽]';

/**
 * 默认路径：`<DSH_HOME>/media/qq-chatlog.jsonl`。
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function defaultChatLogPath(env = process.env) {
  return resolveMediaPath({ name: CHAT_LOG_FILE, envVar: CHAT_LOG_ENV, env });
}

/** 本进程推出来的默认路径（模块加载时定一次，同 `gauge-log.mjs` 的规矩）。 */
export const DEFAULT_CHAT_LOG_PATH = defaultChatLogPath();

/**
 * 把配置收拾成能用的形状（**绝不抛**）。
 *
 * `file` 缺省（`undefined`）⇒ 用默认路径；显式给（含空串）⇒ 以给的为准，
 * **空串 = 明确关掉**（"关了却还在写"比"没开"更坏）。
 *
 * @param {object} [raw]
 * @returns {{enabled: boolean, file: string, maxLines: number, replayOnStart: boolean,
 *   recordFailures: boolean, includeWire: boolean, redactPatterns: (string|RegExp)[]}}
 */
export function normalizeChatLog(raw = {}) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const file = src.file === undefined ? DEFAULT_CHAT_LOG_PATH : String(src.file ?? '').trim();
  const n = Number(src.maxLines);
  const maxLines = Number.isFinite(n) && n > 0
    ? Math.min(Math.floor(n), 2_000_000)
    : DEFAULT_CHAT_LOG.maxLines;
  const patterns = Array.isArray(src.redactPatterns)
    ? src.redactPatterns.filter((p) => typeof p === 'string' || p instanceof RegExp)
    : DEFAULT_CHAT_LOG.redactPatterns;
  return {
    // 没有路径就没地方写 —— "以为自己开着"只会更坏。
    enabled: src.enabled === true && file !== '',
    file,
    maxLines,
    replayOnStart: src.replayOnStart === undefined ? DEFAULT_CHAT_LOG.replayOnStart : src.replayOnStart === true,
    recordFailures: src.recordFailures === undefined ? DEFAULT_CHAT_LOG.recordFailures : src.recordFailures === true,
    includeWire: src.includeWire === undefined ? DEFAULT_CHAT_LOG.includeWire : src.includeWire === true,
    redactPatterns: patterns,
  };
}

/** `group:123` / `private:456` → `'group'` / `'private'`。 */
export function chatKindOf(chatId) {
  return String(chatId ?? '').startsWith('private:') ? 'private' : 'group';
}

/**
 * 正文脱敏（`redactPatterns` 命中就换成 `[已屏蔽]`）。
 *
 * 坏正则**跳过**（一条写错的正则不该让整个记录功能停摆）。
 *
 * @param {string} text
 * @param {(string|RegExp)[]} [patterns]
 * @returns {string}
 */
export function redactText(text, patterns = []) {
  let out = String(text ?? '');
  if (!Array.isArray(patterns) || patterns.length === 0 || out === '') return out;
  for (const pattern of patterns) {
    try {
      const re = pattern instanceof RegExp
        ? pattern
        : new RegExp(String(pattern), 'gu');
      out = out.replace(re, REDACTED);
    } catch {
      /* 坏正则跳过：宁可漏屏蔽，也不让整条记录写不下去 */
    }
  }
  return out;
}

/**
 * 把"段数组"压成类型序列（`wire` 字段）：`text,image`。
 * 只留**类型名**，不存段内容。
 *
 * @param {any} segments
 * @returns {string}
 */
export function wireOf(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  const types = [];
  for (const seg of segments) {
    const type = String(seg?.type ?? '').trim();
    if (type !== '') types.push(type);
  }
  return types.join(',');
}

/**
 * 一条记录 → 落盘行（或 `null` = 这一条不该入库）。
 *
 * ## 为什么 `dir:'in'` 必须带 `messageId`（这条别放宽）
 *
 * 回灌时靠 `messageId` 去重（`Transcript.restore`）。入站行没有 id 就只能靠
 * 时间戳+昵称"拼一个身份"—— 两个来源（本地 + NapCat）对同一条消息拼出来的
 * 身份不一定一样 ⇒ 同一条会进转录两遍 ⇒ 模型看到"自己刚说过的话又出现一次"，
 * 接着**开始复读**。这是用户点名怕的那件事，所以宁可丢掉没有 id 的行。
 * （`normalizeEvent` 只在 `Number(event.message_id)` 是有限数时才写 `messageId`，
 * 没写的那种事件本身就是坏的。）
 *
 * @param {object} input
 * @param {object} [options] `normalizeChatLog` 的结果（用 `includeWire` / `redactPatterns`）
 * @returns {object|null}
 */
export function normalizeChatLogRow(input, options = {}) {
  const src = input !== null && typeof input === 'object' ? input : {};
  const maxLines = options.maxLines; // 与行结构无关，留着签名整齐
  void maxLines;
  const chatId = String(src.chatId ?? '').trim();
  if (chatId === '') return null;
  const at = Number(src.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const text = redactText(String(src.text ?? '').trim(), options.redactPatterns ?? []);
  if (text === '') return null;
  const dir = src.dir === DIR_OUT || src.fromSelf === true ? DIR_OUT : DIR_IN;
  // ⚠️ `null` / `''` / 缺字段一律当"没有 id"，**别交给 `Number()`**：
  //    `Number(null)` 是 `0`，于是"拿不到 id"会被写成 `messageId: 0`
  //    （一个看起来像真 id 的假身份，正是回灌去重最怕的东西）。
  const rawId = src.messageId === null || src.messageId === undefined || src.messageId === ''
    ? Number.NaN
    : Number(src.messageId);
  const messageId = Number.isFinite(rawId) ? rawId : null;
  // 入站行没有 id ⇒ 不入库（见上面的说明）。
  if (dir === DIR_IN && messageId === null) return null;

  const row = {
    at,
    dir,
    chatId,
    kind: src.kind === 'private' || src.kind === 'group' ? src.kind : chatKindOf(chatId),
    userId: dir === DIR_OUT ? '' : String(src.userId ?? ''),
    nickname: String(src.nickname ?? ''),
    text,
    messageId,
  };
  if (options.includeWire !== false) {
    const wire = String(src.wire ?? '').trim();
    if (wire !== '') row.wire = wire;
  }
  if (dir === DIR_OUT) {
    const delivered = src.delivered !== false;
    row.delivered = delivered;
    // `error` **只在失败行出现**（同 `outbound-ledger.mjs` 那条规矩：
    // 没有比空串诚实，写个 `error: ''` 会让人以为"出过错但错误是空的"）。
    if (!delivered) row.error = String(src.error ?? '').slice(0, 300) || 'unknown';
  }
  return row;
}

/**
 * **回灌的唯一闸门**：这一行能不能进转录。
 *
 * ⚠️ **失败行永远不进**（用户点名的硬约束）。为什么：把"她以为说了、其实没发出去"
 * 的话灌进上下文，她会**以为那句话已经说过了**，从此不再提 —— 比不知道更糟。
 *
 * 这一行注释是给后来人看的：**别为了让"上下文更完整"删掉这个判断**
 * （测试 `test/transcript-chat-log.test.mjs` 里钉着一条）。
 *
 * @param {object} row
 * @returns {boolean}
 */
export function isReplayable(row) {
  return row !== null && typeof row === 'object' && row.delivered !== false;
}

/**
 * 文本 → 行数组（坏行**跳过**，不抛）。
 *
 * @param {string} raw
 * @returns {object[]}
 */
export function parseChatLogRows(raw) {
  const out = [];
  const lines = String(raw ?? '').split('\n');
  for (const line of lines) {
    const text = line.trim();
    if (text === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue; // 半行（崩在写入中间）/ 手改坏的 → 跳过
    }
    const row = normalizeChatLogRow(parsed, { includeWire: true, redactPatterns: [] });
    if (row !== null) out.push(row);
  }
  return out;
}

/**
 * 造一个聊天记录器。
 *
 * @param {object} [options]
 * @param {object} [options.config] `normalizeChatLog` 收拾过的参数（或原始配置）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {object} [options.fsImpl] 注入 fs（测试用）
 * @param {() => number} [options.now] 时钟（测试用；只在兜底 `at` 时用得到）
 * @returns {{
 *   enabled: () => boolean,
 *   file: () => string,
 *   record: (input: object) => boolean,
 *   replayByChat: (limit?: number) => Map<string, object[]>,
 *   loadRecent: (chatId: string, limit?: number) => object[],
 *   find: (chatId: string, messageId: unknown) => object|null,
 *   allRows: () => object[],
 *   trim: (force?: boolean) => boolean,
 *   stats: () => object,
 * }}
 */
export function createChatLog({ config = null, log = () => {}, fsImpl = null, now = () => Date.now() } = {}) {
  const cfg = normalizeChatLog(config ?? DEFAULT_CHAT_LOG);
  const f = fsImpl ?? fs;

  let ready = false;
  /** 文件当前行数（`-1` = 还没数过）。 */
  let lineCount = -1;
  let writes = 0;
  let failures = 0;
  let trims = 0;
  let lastError = '';
  /**
   * 内存索引：`chatId` → 行数组（按 `at` 升序），以及 `(chatId, messageId)` → 行。
   *
   * ⚠️ **按会话分组、键带 chatId**：`Transcript` 是按会话分开的，而落盘是单文件。
   * NapCat 的 `message_id` 是否跨会话唯一**未验证**，所以绝不能做成全局 Map
   * （方案 R8：跨会话撞 id 会把两个群里的两条不同消息当成一条）。
   */
  /** @type {Map<string, object[]>} */
  const byChat = new Map();
  /** @type {Map<string, object>} */
  const byId = new Map();
  let indexLoaded = false;

  function debug(message, meta) {
    try {
      log('debug', message, meta);
    } catch {
      /* 日志本身坏了也不能抛 */
    }
  }

  function rememberError(error) {
    failures += 1;
    lastError = error instanceof Error ? error.message : String(error);
  }

  const idKey = (chatId, messageId) => `${chatId}#${String(messageId)}`;

  function indexRow(row) {
    if (!isReplayable(row)) return; // 失败行不进索引 ⇒ 引用回查也查不到它
    let list = byChat.get(row.chatId);
    if (list === undefined) {
      list = [];
      byChat.set(row.chatId, list);
    }
    list.push(row);
    if (typeof row.messageId === 'number' && Number.isFinite(row.messageId)) {
      byId.set(idKey(row.chatId, row.messageId), row);
    }
  }

  /** 读全文件建索引（只做一次）。**读失败不抛**，当成空库。 */
  function ensureIndex() {
    if (indexLoaded) return;
    indexLoaded = true;
    if (!cfg.enabled || cfg.file === '') return;
    try {
      if (!f.existsSync(cfg.file)) return;
      const rows = parseChatLogRows(f.readFileSync(cfg.file, 'utf8'));
      rows.sort((a, b) => a.at - b.at);
      for (const row of rows) indexRow(row);
    } catch (error) {
      debug('聊天记录：读本地失败（按空库继续，不影响运行）', {
        file: cfg.file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function ensureDir() {
    if (ready) return;
    f.mkdirSync(path.dirname(cfg.file), { recursive: true });
    ready = true;
  }

  /** 数一次现有行数（第一次写之前做一次，之后按追加累加）。 */
  function ensureCount() {
    if (lineCount >= 0) return;
    lineCount = 0;
    try {
      if (!f.existsSync(cfg.file)) return;
      const raw = f.readFileSync(cfg.file, 'utf8');
      let n = 0;
      for (const line of raw.split('\n')) if (line.trim() !== '') n += 1;
      lineCount = n;
    } catch {
      lineCount = 0; // 数不出来就从 0 起算：最坏结果是晚一点才裁
    }
  }

  /**
   * 裁剪：把文件改写成"只留尾部 `maxLines` 行"（**原样保留字节**，不重新序列化）。
   * `tmp` + `rename`，同 `outbound-ledger.mjs`。
   * @returns {boolean} 裁了没有
   */
  function trim(force = false) {
    if (!cfg.enabled || cfg.file === '') return false;
    ensureCount();
    if (!force && lineCount <= cfg.maxLines * TRIM_FACTOR) return false;
    try {
      const raw = f.existsSync(cfg.file) ? f.readFileSync(cfg.file, 'utf8') : '';
      const lines = raw.split('\n').filter((line) => line.trim() !== '');
      if (lines.length <= cfg.maxLines) {
        lineCount = lines.length;
        return false;
      }
      const kept = lines.slice(lines.length - cfg.maxLines);
      const tmp = `${cfg.file}.tmp-${process.pid}`;
      f.writeFileSync(tmp, `${kept.join('\n')}\n`, 'utf8');
      f.renameSync(tmp, cfg.file);
      lineCount = kept.length;
      trims += 1;
      // 最近转的那个 id 之外的索引重建（简单起见整库重建：一天也就几次）
      byChat.clear();
      byId.clear();
      indexLoaded = false;
      ensureIndex();
      return true;
    } catch (error) {
      rememberError(error);
      debug('聊天记录裁剪失败（继续追加，文件会暂时偏大）', {
        file: cfg.file,
        error: lastError,
      });
      return false;
    }
  }

  /**
   * 记一行。**唯一真正碰磁盘的地方**，整段包在 try/catch 里。
   *
   * @param {object} input 见 {@link normalizeChatLogRow}
   * @returns {boolean} 写成了没有（关着 / 不该入库 / 写失败 ⇒ false）
   */
  function record(input) {
    if (!cfg.enabled || cfg.file === '') return false;
    try {
      const row = normalizeChatLogRow(input, cfg);
      if (row === null) return false;
      if (row.dir === DIR_OUT && row.delivered === false && cfg.recordFailures === false) return false;
      ensureDir();
      ensureCount();
      f.appendFileSync(cfg.file, `${JSON.stringify(row)}\n`, 'utf8');
      writes += 1;
      lineCount += 1;
      indexLoaded ? indexRow(row) : null;
      trim(false);
      return true;
    } catch (error) {
      rememberError(error);
      debug('聊天记录写盘失败（忽略，不影响消息收发）', {
        file: cfg.file,
        error: lastError,
      });
      return false;
    }
  }

  /**
   * 回灌用的分组：`chatId` → 最近 `limit` 条**可回灌**的行。
   *
   * ⚠️ `limit` 只该传转录上限（`Transcript.maxMessages`，缺省 60），别传"我想要的条数"——
   * 传大会先把内存撑到上限之外再被 `#trim` 砍回去，看起来"灌了 200 条"其实只剩 60 条。
   *
   * @param {number} [limit]
   * @returns {Map<string, object[]>}
   */
  function replayByChat(limit = 60) {
    ensureIndex();
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 60;
    const out = new Map();
    for (const [chatId, rows] of byChat) {
      const usable = rows.filter(isReplayable);
      if (usable.length === 0) continue;
      out.set(chatId, usable.slice(-cap));
    }
    return out;
  }

  /**
   * 某会话最近 `limit` 条可回灌的行。
   * @param {string} chatId
   * @param {number} [limit]
   * @returns {object[]}
   */
  function loadRecent(chatId, limit = 60) {
    return replayByChat(limit).get(String(chatId ?? '').trim()) ?? [];
  }

  /**
   * 按 `(chatId, messageId)` 查一条 —— **同步**，给引用回查用（`#findQuoted` 是纯同步的）。
   *
   * 查不到 / 是失败行 ⇒ `null`（失败行索引里根本没有，见 `indexRow`）。
   *
   * @param {string} chatId
   * @param {unknown} messageId
   * @returns {object|null}
   */
  function find(chatId, messageId) {
    ensureIndex();
    const id = Number(messageId);
    if (!Number.isFinite(id)) return null;
    return byId.get(idKey(String(chatId ?? '').trim(), id)) ?? null;
  }

  /** 全部可回灌的行（按写盘顺序，给测试/排查）。 */
  function allRows() {
    ensureIndex();
    const out = [];
    for (const rows of byChat.values()) out.push(...rows);
    return out.sort((a, b) => a.at - b.at);
  }

  return {
    /** 开关是否真的开着。 */
    enabled: () => cfg.enabled,
    /** 实际写入的文件路径（关着时也返回"本来会写哪儿"）。 */
    file: () => cfg.file,
    record,
    replayByChat,
    loadRecent,
    find,
    allRows,
    trim,
    stats: () => ({
      enabled: cfg.enabled,
      file: cfg.file,
      maxLines: cfg.maxLines,
      lines: lineCount,
      writes,
      failures,
      trims,
      lastError,
      // `now` 目前只用于文档一致性（行里的 `at` 来自消息本身，不在这里补）；
      // 保留它是为了将来"没有时间戳的兜底"不必改签名。
      at: now(),
    }),
  };
}
