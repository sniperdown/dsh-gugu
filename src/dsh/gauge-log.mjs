/**
 * **判官 / 启发式决策日志**（2026-11-06）。
 *
 * ## 它解决什么
 *
 * 主动接话的链路是：入站消息 → 启发式打分（`heuristic-gauge.mjs`，给 `score` /
 * `threshold` / `detail` 分项）→ 过阈值后问一次判官（`judge-mode.mjs` 的 precheck，
 * 答的原文在 `outcome.raw`）→ `speak` / `decline` / `wait` → 真说话时走网关发送。
 *
 * 这条链上**只有内存计数**（快照的 `proactive.states` / `proactive.judge`）：
 * 计数回答"判了几次、过了几次"，**回答不了"这一条为什么被判不该说"** ——
 * 是分不够、还是分够但判官拦了、判官到底答了什么、它当时看到的是哪 20 条上下文。
 * 这些信息过几秒就被下一条消息覆盖（转录是环形缓冲、journal 只留 20 条）。
 *
 * ⇒ 本模块把**每一条过了启发式阈值的候选**落一行 JSON，供离线研究：
 *   · `kind: 'gauge'`：这一次判定的全部输入与结论（一行流）；
 *   · `kind: 'out'`：这一轮**真的发出去了**时，再补一行正文 + 上下文。
 *
 * ## 为什么两行而不是一行（`kind: 'gauge'` + `kind: 'out'`）
 *
 * 判定发生在**链路中段**（判官回来那一刻），而"最终发出了什么"要等 agent 跑完
 * （可能几秒，也可能几十秒）。要在一条记录里写全，就得**回头改写文件**
 * ——那是行级 JSONL 里最容易写坏的一种操作（截断/半行/并发）。
 * 所以：**只追加，不回头改**；两行用同一个 `turnId` 关联，一条命令就能配对：
 *
 * ```
 * # PowerShell
 * Select-String -Path <DSH_HOME>\media\qq-gauge.jsonl -Pattern 'group:100@1767'
 * # bash / grep
 * grep 'group:100@1767' <DSH_HOME>/media/qq-gauge.jsonl
 * ```
 *
 * ## ⚠️ 三条硬约束（违反会炸，本项目为同类问题崩过三次）
 *
 * 1. **绝不抛**：写盘失败、序列化失败、盘满、路径不可写 —— 全部 try/catch
 *    吞成**一条 debug 日志**。它挂在消息热路径上，抛出去 = 宿主进程退出
 *    （见 `qq-plugin/AGENTS.md` 第三节）。
 * 2. **不改判定**：只读旁路。不改 `score` / `speak`，不挡发送，不加 `await`
 *    （同步小文件追加，一次 syscall 级）。
 * 3. **默认关闭**：`[proactive] gauge_log = true` 才写（见 `config-fields.mjs`）。
 *    关着的时候 `open()` / `complete()` 立刻返回，**一个字节都不碰磁盘**
 *    （连目录都不建）。
 *
 * ## 字段命名：`kind` 有两个意思，这里用两个键分开
 *
 * 需求里"每次记录的类型"和"会话类型"都叫 `kind`。**同一个键不能装两个意思**，
 * 所以：
 *   · `kind`（顶层）= **记录类型**：`'gauge'` / `'out'`；
 *   · `chatKind` = **会话类型**：`'group'` / `'private'`。
 *
 * ## 落盘位置与上限
 *
 * `<DSH_HOME>/media/qq-gauge.jsonl`（与出站台账同一棵树，路径由 `paths.mjs` 推）。
 * 超过 `maxBytes`（默认 **50 MB**）就轮转成 `<file>.1`，**只保留一个旧文件**。
 *
 * @module qq-dsh/gauge-log
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveMediaPath } from './paths.mjs';

/** 默认文件名。 */
export const GAUGE_LOG_FILE = 'qq-gauge.jsonl';

/**
 * 路径覆盖用的环境变量（排障：`QQ_GAUGE_LOG_PATH=D:\tmp\g.jsonl`）。
 * 与 `resolveMediaPath` 同一条约定，优先级高于配置文件里的路径。
 */
export const GAUGE_LOG_ENV = 'QQ_GAUGE_LOG_PATH';

/** 记录类型：一次判定（启发式 + 判官）。 */
export const KIND_GAUGE = 'gauge';
/** 记录类型：这一轮**真的发出去了**的正文与上下文。 */
export const KIND_OUT = 'out';

/** 默认轮转阈值：50 MB。 */
export const DEFAULT_GAUGE_LOG_MAX_BYTES = 50 * 1024 * 1024;

/** `messageText` 截断长度（需求：500 字）。 */
export const MESSAGE_TEXT_MAX = 500;
/**
 * 判官答的原文截断长度（需求：**不要** 40 字截断，这里留到 1000）。
 *
 * 判官的 `maxTokens` 是 96（`judge-mode.mjs` 的 `PRECHECK_MAX_TOKENS_WITH_REASONING`），
 * 实际答案最多也就一两百字 —— 1000 只是"绝不成为瓶颈"的上界。
 * ⚠️ 这**不影响** `outcome.raw`（那边仍按它自己的口径截 40 字，见下面的注释）。
 */
export const JUDGE_RAW_MAX = 1000;
/** 输出正文上限（`maxReplyChars` 本来就有限，这里只是防御性封顶）。 */
export const OUTPUT_MAX = 4000;
/** 上下文（20 条转录渲染）上限。 */
export const CONTEXT_MAX = 8000;

/** 兜底默认值。 */
export const DEFAULT_GAUGE_LOG = Object.freeze({
  /**
   * **默认关闭** —— 用户 2026-11-06 的要求：开关由用户自己在 toml 里开。
   * 关着的时候连目录都不建（"装了但一行不写"和"压根没装"在现象上必须分得开）。
   */
  enabled: false,
  /**
   * ⚠️ **这里绝不能有 `file: ''`** —— 缺字段才走默认路径，显式空串是"明确关掉"
   * （同 `outbound-ledger.mjs` 里那条踩过的坑：默认值写空串会把功能静默关掉，
   * 而快照上一切计数看起来都正常）。
   */
  maxBytes: DEFAULT_GAUGE_LOG_MAX_BYTES,
});

/**
 * 默认路径：`<DSH_HOME>/media/qq-gauge.jsonl`。
 *
 * 走 `paths.mjs` 的 {@link resolveMediaPath}（**不在这里拼字符串**）：
 * 环境变量 `QQ_GAUGE_LOG_PATH` 优先，其次 `<DSH_HOME>/media/`。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function defaultGaugeLogPath(env = process.env) {
  return resolveMediaPath({ name: GAUGE_LOG_FILE, envVar: GAUGE_LOG_ENV, env });
}

/** 本进程推出来的默认路径（模块加载时定一次，同 `outbound-ledger.mjs` 的规矩）。 */
export const DEFAULT_GAUGE_LOG_PATH = defaultGaugeLogPath();

/**
 * 把配置收拾成能用的形状（越界一律夹到边界，**绝不抛**）。
 *
 * - `file` 缺省（`undefined`）⇒ 用 {@link DEFAULT_GAUGE_LOG_PATH}；
 *   显式给（含空串）⇒ 以给的为准，**空串 = 明确关掉**（"关了却还在写"比"没开"更坏）；
 * - `enabled` 默认 **false**（需求：默认关闭）；
 * - `maxBytes` ≤ 0 ⇒ **不轮转**（写到底为止；那是"我要全量留档"的显式选择）。
 *
 * @param {object} [raw]
 * @returns {{enabled: boolean, file: string, maxBytes: number}}
 */
export function normalizeGaugeLog(raw = {}) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const file = src.file === undefined
    ? DEFAULT_GAUGE_LOG_PATH
    : String(src.file ?? '').trim();
  const n = Number(src.maxBytes);
  const maxBytes = Number.isFinite(n) && n > 0
    ? Math.min(Math.floor(n), 4 * 1024 * 1024 * 1024)
    : (Number.isFinite(n) && n <= 0 ? 0 : DEFAULT_GAUGE_LOG.maxBytes);
  return {
    // 没有路径就没地方写 —— "以为自己开着"只会更坏（同 `outbound-ledger.mjs`）。
    enabled: src.enabled === true && file !== '',
    file,
    maxBytes,
  };
}

/** 取字符串并截断（`null` / `undefined` ⇒ 空串）。 */
function clipText(value, max) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!(max > 0) || text.length <= max) return text;
  return text.slice(0, max);
}

/** 只接受有限数字，其余一律 `null`（日记要能安全落盘）。 */
function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把任意值收成**一定可序列化**的东西（对象/数组最多挖三层）。
 *
 * 为什么不直接 `JSON.stringify(detail)` 了事：`detail` 来自打分器（现在全是数字/布尔），
 * 但它是"别人给的对象" —— 将来有人往里塞一个 `BigInt`、一个函数、一个环，
 * `JSON.stringify` 就会抛，而这里**抛出去就是宿主退出**。
 * 所以先过一道：只留 `number|string|boolean|null` 与（三层内的）对象/数组。
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function sanitizeJsonValue(value, depth = 3) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'string') return clipText(value, 4000);
  if (type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (type !== 'object') return null;
  if (depth <= 0) return null;
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value.slice(0, 40)) out.push(sanitizeJsonValue(item, depth - 1));
      return out;
    }
    const out = {};
    let n = 0;
    for (const [key, item] of Object.entries(value)) {
      if (n >= 60) break;
      out[String(key).slice(0, 80)] = sanitizeJsonValue(item, depth - 1);
      n += 1;
    }
    return out;
  } catch {
    // 带 getter / Proxy 的对象在遍历时可能抛 —— 当成"没有这一项"。
    return null;
  }
}

/**
 * 判官结论 → 记录里的 `verdict`。
 *
 * 为什么要映射一层：`judge-mode.mjs` 的 `outcome` 有两个字段 ——
 * `verdict` 只有 `speak|decline|wait` 三个值，而"超时/报错/答歪/没配模型"
 * **都降级成 `speak`**（退回模式 1），只在 `source` 里能看出来。
 *
 * ⇒ 研究时最该一眼看见的恰恰是"**它其实没给结论，是降级放行的**"，
 *   所以这里把那些 `source` 提到 `verdict` 上：`timeout` / `error` /
 *   `unparsed` / `no-model` / `busy`。判定行为**一个字节都没变**
 *   （`outcome.speak` 决定走哪条分支，这个函数只负责记录怎么写）。
 *
 * @param {{verdict?: string, source?: string, speak?: boolean}} judge
 * @returns {string}
 */
export function judgeVerdictOf(judge) {
  const source = String(judge?.source ?? '').trim().toLowerCase();
  if (source === 'timeout' || source === 'error' || source === 'unparsed'
    || source === 'no-model' || source === 'busy') {
    return source;
  }
  const verdict = String(judge?.verdict ?? '').trim().toLowerCase();
  if (verdict === 'speak' || verdict === 'decline' || verdict === 'wait') return verdict;
  // 没有判官（启发式自己拍板）：说就说，"该说"就是它的结论。
  return judge?.speak === false ? 'decline' : 'speak';
}

/**
 * 造一个判定日志。
 *
 * @param {object} [options]
 * @param {object} [options.config] `normalizeGaugeLog` 收拾过的参数（或原始配置）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {object} [options.fsImpl] 注入 fs（测试用）
 * @param {() => number} [options.now] 时钟（测试用）
 * @returns {{
 *   enabled: () => boolean,
 *   file: () => string,
 *   open: (input: object) => ({turnId: string, chatId: string, context: string}|null),
 *   complete: (handle: object, extra?: {output?: string}) => boolean,
 *   stats: () => object,
 * }}
 */
export function createGaugeLog({
  config = null,
  log = () => {},
  fsImpl = null,
  now = () => Date.now(),
} = {}) {
  const cfg = normalizeGaugeLog(config ?? DEFAULT_GAUGE_LOG);
  const f = fsImpl ?? fs;

  /** 目录建过没有（懒建：关着的时候连 mkdir 都不做）。 */
  let ready = false;
  /**
   * 已知的文件字节数（`-1` = 还没 stat 过）。
   *
   * 为什么记在内存里：每写一行都 `statSync` 一次是白花钱（一行 2~4 KB，
   * 50 MB 要写一万多行）。`open()` 第一次会真 stat 一次（进程中途启动时
   * 文件里已经有旧内容），之后按追加的字节数累加。**别人往里写**这种情况
   * 不处理 —— 这个文件按约定只有本进程写（同 `outbound-ledger.mjs` 的行数缓存，
   * 那边有定期重数，这里不需要：轮转只看"够不够 50 MB"，估小了最多晚轮转一点）。
   */
  let knownBytes = -1;
  let writes = 0;
  let failures = 0;
  let rotations = 0;
  let lastError = '';
  /** 生成过的 turnId 计数（同一个 chatId + 同一毫秒可能撞两次）。 */
  const turnSeq = new Map();

  function rememberError(error) {
    failures += 1;
    lastError = error instanceof Error ? error.message : String(error);
  }

  function debug(message, meta) {
    try {
      log('debug', message, meta);
    } catch {
      /* 日志本身坏了也不能抛 */
    }
  }

  function ensureDir() {
    if (ready) return;
    f.mkdirSync(path.dirname(cfg.file), { recursive: true });
    ready = true;
  }

  /**
   * 轮转：把当前文件改名成 `<file>.1`（**只留一个旧文件**）。
   *
   * 先删旧的 `.1` 再 rename：Windows 上 `rename` 到已存在的目标会失败，
   * 而失败之后继续往原文件写就等于"永远不轮转"（文件无限长大、没人发现）。
   */
  function rotate() {
    const backup = `${cfg.file}.1`;
    try {
      f.rmSync(backup, { force: true });
    } catch {
      /* 旧的 .1 删不掉就再试一次 rename（大概率也失败 → 下面 catch 兜住） */
    }
    f.renameSync(cfg.file, backup);
    rotations += 1;
    knownBytes = 0;
  }

  /**
   * 追加一行（**唯一**真正碰磁盘的地方，全部包在 try/catch 里）。
   *
   * @param {object} record
   * @returns {boolean} 写成了没有
   */
  function append(record) {
    if (!cfg.enabled || cfg.file === '') return false;
    try {
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      ensureDir();
      if (knownBytes < 0) {
        try {
          knownBytes = Number(f.statSync(cfg.file).size) || 0;
        } catch {
          knownBytes = 0; // 文件还不存在（第一次写）
        }
      }
      if (cfg.maxBytes > 0 && knownBytes + bytes > cfg.maxBytes) {
        try {
          rotate();
        } catch (error) {
          // 轮转失败**不改写盘行为**：宁可这一份文件比上限大，也不能丢记录。
          debug('判定日志轮转失败（继续写原文件）', {
            file: cfg.file,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      f.appendFileSync(cfg.file, line, 'utf8');
      knownBytes = Math.max(0, knownBytes) + bytes;
      writes += 1;
      return true;
    } catch (error) {
      rememberError(error);
      debug('判定日志写盘失败（忽略，不影响判定与发送）', {
        file: cfg.file,
        error: lastError,
      });
      return false;
    }
  }

  /**
   * 造一个 `turnId`：`<chatId>@<消息毫秒>`，同一毫秒重复时加后缀。
   *
   * 需求允许"用 `chatId` + `at` 生成"（引擎里没有 turn 标识 —— 一轮的边界
   * 在网关的 `runTurn` 里，而那是个函数调用、没有 id）。撞车的可能是
   * **同一群里同一条消息被判定两次**（重复投递 / 重试），所以加一个计数后缀，
   * 保证 `.1` 文件里也能唯一定位。
   */
  function nextTurnId(chatId, at) {
    const base = `${chatId}@${at}`;
    const used = (turnSeq.get(base) ?? 0) + 1;
    turnSeq.set(base, used);
    // 上界：只留最近用过的 500 个键（够覆盖"同一毫秒连判几条"，也不会让 Map 无限涨）。
    if (turnSeq.size > 500) {
      let drop = turnSeq.size - 400;
      for (const key of turnSeq.keys()) {
        turnSeq.delete(key);
        if (--drop <= 0) break;
      }
    }
    return used === 1 ? base : `${base}#${used}`;
  }

  /**
   * 记一条判定（`kind: 'gauge'`）。
   *
   * **调用时机**：过了启发式阈值、判官给了结论的那一刻（网关 `handleEvent`）。
   * 记录里的 `at` 是**写盘时刻**，`messageAt` 是**触发这条判定的消息时刻**
   * —— 两者差的就是判官那次调用的耗时（几百毫秒），研究时用 `messageAt` 对齐转录。
   *
   * @param {object} input
   * @param {string} input.chatId
   * @param {'group'|'private'} [input.chatKind]
   * @param {string} [input.userId]
   * @param {string} [input.messageText] 触发这条判定的消息正文（截 500 字）
   * @param {number} [input.messageAt] 消息毫秒时间戳
   * @param {string} [input.context] 判定时的 20 条转录（只留给 `kind:'out'` 那行用）
   * @param {number|null} [input.score]
   * @param {number|null} [input.threshold]
   * @param {object|null} [input.detail] **整个分项对象**（不摊平、不挑项）
   * @param {object} [input.judge] `judge-mode.mjs` 的 `outcome`（或等价的启发式结论）
   * @param {string} [input.pmode] 裁量模式（`heuristic` / `precheck` / `inTurn`）
   * @param {string} [input.reason] 引擎给的放行原因（`scored` / `focus` / …）
   * @param {number|null} [input.focus]
   * @param {boolean} [input.addressed]
   * @returns {{turnId: string, chatId: string, context: string}|null}
   *   `null` = 关着 / 写失败（**调用方不需要区分**：`complete` 收到 `null` 直接跳过）
   */
  function open(input = {}) {
    if (!cfg.enabled || cfg.file === '') return null;
    try {
      const src = input !== null && typeof input === 'object' ? input : {};
      const messageAt = Number(src.messageAt) > 0 ? Number(src.messageAt) : now();
      const chatId = clipText(src.chatId, 80);
      const turnId = nextTurnId(chatId, messageAt);
      const judge = src.judge !== null && typeof src.judge === 'object' ? src.judge : {};
      const record = {
        kind: KIND_GAUGE,
        at: new Date(now()).toISOString(),
        turnId,
        chatId,
        // ⚠️ `chatKind` 而不是 `kind`：顶层 `kind` 是**记录类型**（见文件头）。
        chatKind: src.chatKind === 'private' ? 'private' : 'group',
        userId: clipText(src.userId, 40),
        messageText: clipText(src.messageText, MESSAGE_TEXT_MAX),
        messageAt: new Date(messageAt).toISOString(),
        // ---- 启发式 ----
        score: finiteOrNull(src.score),
        threshold: finiteOrNull(src.threshold),
        detail: sanitizeJsonValue(src.detail),
        // ---- 判官 ----
        verdict: judgeVerdictOf(judge),
        judgeSource: clipText(judge.source, 20),
        /**
         * 判官答的原文。
         *
         * 优先 `answer`（`judge-mode.mjs` 2026-11-06 起的**全文**字段，截到 1000 字），
         * 退回 `raw`（老字段，只留 40 字）—— 桩 / 老调用方只有 `raw`。
         * ⚠️ 这里**不用** `raw` 优先：40 字会把"它到底在说什么"切掉，
         * 那正是这次改动要研究的对象。
         */
        judgeRaw: clipText(judge.answer !== undefined && judge.answer !== '' ? judge.answer : judge.raw, JUDGE_RAW_MAX),
        judgeMs: finiteOrNull(judge.ms) ?? 0,
        judgeModel: clipText(judge.model, 80),
        judgeProvider: clipText(judge.provider, 40),
        judgePromptChars: finiteOrNull(judge.promptChars) ?? 0,
        // ---- 上下文 ----
        pmode: clipText(src.pmode, 20) || 'heuristic',
        reason: clipText(src.reason, 30),
        focus: finiteOrNull(src.focus) ?? 0,
        addressed: src.addressed === true,
      };
      if (!append(record)) return null;
      return {
        turnId,
        chatId,
        // 上下文**只留给 `out` 那行**（候选里绝大多数不会说话，全都存会白占一半篇幅）。
        context: clipText(src.context, CONTEXT_MAX),
      };
    } catch (error) {
      rememberError(error);
      debug('判定日志序列化失败（忽略）', {
        file: cfg.file,
        error: lastError,
      });
      return null;
    }
  }

  /**
   * 这一轮**真的发出去了** ⇒ 补一行 `kind: 'out'`（正文 + 20 条上下文）。
   *
   * @param {object} handle `open()` 的返回值
   * @param {{output?: string}} [extra] `output` = 这一轮最终发到群里的正文
   *   （分段的话由调用方按 `\n` 拼好，见 `gateway.runTurn` 的 `sentBodies`）
   * @returns {boolean}
   */
  function complete(handle, extra = {}) {
    if (!cfg.enabled || cfg.file === '') return false;
    if (handle === null || typeof handle !== 'object') return false;
    try {
      const turnId = clipText(handle.turnId, 120);
      const output = clipText(extra.output, OUTPUT_MAX).trim();
      // 什么都没发出去 ⇒ 不写（"发言失败"与"她没说"在正文上都是空，但这一行
      // 的语义是"**发出去的**正文"，写一行空的只会让人以为发了）。
      if (turnId === '' || output === '') return false;
      return append({
        kind: KIND_OUT,
        at: new Date(now()).toISOString(),
        turnId,
        chatId: clipText(handle.chatId, 80),
        output,
        context: clipText(handle.context, CONTEXT_MAX),
      });
    } catch (error) {
      rememberError(error);
      debug('判定日志输出段落盘失败（忽略）', {
        file: cfg.file,
        error: lastError,
      });
      return false;
    }
  }

  return {
    /** 开关是否真的开着（`enabled:true` 但路径为空 ⇒ false）。 */
    enabled: () => cfg.enabled,
    /** 实际写入的文件路径（关着时也返回"本来会写哪儿"，排障时有用）。 */
    file: () => cfg.file,
    open,
    complete,
    stats: () => ({
      enabled: cfg.enabled,
      file: cfg.file,
      maxBytes: cfg.maxBytes,
      // `bytes` 可能是 -1（还没写过 / 还没 stat），调用方自己判。
      bytes: knownBytes,
      writes,
      failures,
      rotations,
      lastError,
    }),
  };
}
