/**
 * **出站台账**（outbound ledger）：往 QQ 发消息这件事，在**两个层**各留一行只追加的记录。
 *
 * ## 为什么要有它（用户 2026-10-11 的要求）
 *
 * 现场：2026-10-09 16:01:48，小鲸鱼发的一条消息在 QQ 上出现**两条逐字相同的**
 * （不同 `message_id`、`real_seq` 连号 2073/2074、同秒）。调查结论（完整报告：
 * `shared/tmp/2026-10-10-出站重复-session-00000000.md`）是：
 *
 * - 会话存储里**只生成了一条**（不是生成两次）；
 * - QQ 上那 627 字符 == 插件 `stripMarkdown()` 对那条 715 字符回复的输出（逐字节相等）
 *   ⇒ **只可能出自插件的出站路径**；那个口子全项目**只有一个调用点**、**无重试**、
 *   **无双通道**、**无自回声**；
 * - 但全量 455 条历史里「同秒 + 连号 + 逐字相同」出现过 **3 段**，其中一段来自
 *   **另一个会话、走 HTTP、没经过插件的 `#send`** ⇒ 共同点只剩「同一个 NapCat 发送机」。
 *
 * **卡住的唯一原因：出站两头都没有留档。** 插件日志不落盘、`stats` 只在内存且每次
 * 重载清零、NapCat 日志停在 10-02。于是"发了一次还是两次"这个口径**根本不存在**，
 * 推理到此为止。
 *
 * ## ⭐ 判读方式（这是本次改动的**全部意义**）
 *
 * 台账每行有一个 `layer`。同一秒里同一条文本（`sha256` 相同）落在哪几层，
 * 直接指出重复发生在**哪一层**：
 *
 * ```
 * gw-send 1 条 + transport-action 2 条            ⇒ 【WS/传输层写了两遍】
 * gw-send 1 条 + transport-action 1 条 + QQ 上 2 条 ⇒ 【NapCat 侧重复】
 * gw-send 2 条                                     ⇒ 【插件真的发了两次】（那要另查调用方）
 * ```
 *
 * 三个层标记：
 * | `layer` | 写在哪 | 含义 |
 * |---|---|---|
 * | `gw-send` | `gateway.mjs` 的 `#send()`（**唯一**出站口） | 插件"决定要发一次" |
 * | `transport-action` | 传输层的发送包装（`sendToChat` → `send_msg`） | 真的交给 NapCat 了 |
 *
 * ## 🔴 这次**只加观测**：不做去重、不加重试
 *
 * **重复在哪一层还不知道**，任何去重/重试都可能**掩盖**它：去重会吃掉第二条
 * （于是再也看不见"发了两遍"），重试会**制造**第二条（于是台账里多一条，
 * 而分不清是它造的、还是本来就有的）。**先把口径补上，再谈修。**
 *
 * ## 隐私：**绝不记消息原文**
 *
 * 只记长度（`chars`）+ 哈希（`sha256` 前 16 位）。哈希是**判据**：
 * 同一秒出现两条相同的 `sha256` ⇒ 真的发了两遍。QQ 号/会话 id 不算正文，照记。
 *
 * ## ⚠️ 写盘失败**绝不许**影响发送
 *
 * 台账落在 `<DSH_HOME>\media\qq-outbound.jsonl`。那是插件进程能写的地方，
 * 但**不是必然能写**（目录被清、权限变了、盘满）。这条教训是血泪的
 * —— `sticker-audit.mjs` 那次"留样抛异常 ⇒ 整张图变成『没看成』"：
 * **观测设施坏了，绝不能把被观测的事也弄坏。** 所以 `record()` **全程 try/catch**，
 * 失败只记一行 log，并像 `sticker-audit.mjs` 那样**连续失败若干次就本次进程内断开**
 * （免得每条消息都去撞一次系统调用）。
 *
 * ## 上限：台账不该长成几百 MB
 *
 * 照 `sticker-audit.mjs` 的 `index.jsonl` 那套约定：`maxLines` 是目标行数，
 * 实际放到 `maxLines × 1.5`（`trimAt`）才裁一次，裁完**只留尾部**
 * —— 每裁一次都要读整份文件，太频繁不值当。**行数还在涨 ≠ 台账在长大。**
 *
 * @module qq-dsh/outbound-ledger
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from './paths.mjs';

/** 层标记：插件"决定要发一次"（`gateway.mjs` 的 `#send`）。 */
export const LAYER_GW_SEND = 'gw-send';
/** 层标记：真的交给 NapCat 了（传输层的发送包装）。 */
export const LAYER_TRANSPORT_ACTION = 'transport-action';

/** `caller` 兜底：不知道谁调的（新加了调用点却忘了传 `caller` 时会落到这里）。 */
export const CALLER_UNKNOWN = 'unknown';

/**
 * `DSH_HOME` 推不出来时的兜底目录 —— **本部署的实际路径**。
 *
 * 与 `sticker-library.mjs` 的 `DEFAULT_STICKER_INDEX_PATH`
 * （`<DSH_HOME>\media\qq-stickers.json`）同一条规矩：**这个部署就长在 H 盘**，
 * 写死比"猜一个相对路径"可靠（猜错 = 默默什么都没记，而所有计数都正常）。
 * Linux 部署时改这一行（或在配置里给 `file`）。
 */
export const DEFAULT_OUTBOUND_LEDGER_DIR = path.join(dshHome(), 'media');

/**
 * 默认台账路径：`<DSH_HOME>/media/qq-outbound.jsonl`。
 *
 * 和 `sticker-audit\index.jsonl` **同一棵树**（都是 `<DSH_HOME>\media\`）。
 * `DSH_HOME` 没设时**退到本部署的写死路径**（不是空串）—— 理由见上：
 * 空串会让 `enabled` 变 false，那就等于"功能装上了但一行都不记"，
 * 而那种状态下所有计数看起来都正常。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function defaultOutboundLedgerPath(env = process.env) {
  const home = String(env?.DSH_HOME ?? '').trim();
  if (home === '') return path.join(DEFAULT_OUTBOUND_LEDGER_DIR, 'qq-outbound.jsonl');
  return path.join(home, 'media', 'qq-outbound.jsonl');
}

/**
 * 本进程推出来的默认台账路径（**模块加载时定一次**）。
 *
 * 它也是 `index.mjs` 的 `CONFIG_SHAPE.outboundLedgerPath` 的默认值。
 * **路径的唯一来源是这里**：与其让调用方各自 `defaultOutboundLedgerPath()` 一遍
 * （迟早分叉成两份），不如只留一个常量（同 `DEFAULT_DESC_TABLE_PATH` 那条规矩）。
 */
export const DEFAULT_OUTBOUND_LEDGER_PATH = defaultOutboundLedgerPath();

/**
 * 兜底默认值。
 *
 * ## 🔴 **这里绝不能有 `file` 字段**（2026-10-11 踩过，别再踩）
 *
 * `file` **没有默认值** —— 它是 `defaultOutboundLedgerPath()` **推**出来的。
 * 在这里放一个 `file: ''` 会把功能**默认关掉**，而且**一点声音都没有**：
 *
 * ```
 * createOutboundLedger()                     // 不带配置
 *   → config = DEFAULT_OUTBOUND_LEDGER       // { file: '', … }
 *   → normalizeOutboundLedger(): 'file' 已定义（是空串）⇒ 不推路径 ⇒ file = ''
 *   → enabled = true && file !== ''          ⇒ 【false，静默关掉】
 * ```
 *
 * 而快照上它长这样：`{ enabled:false, hooked:true, wrote:0, file:'' }` ——
 * **"装了、挂上了、一行都没记"**，所有计数看起来都正常。
 * **这正是这个模块开头警告过的形状**（"空串 ⇒ 功能装上了但一行都不记"），
 * 而当时的默认值恰好踩了它：**警告写了，默认值没跟上。**
 *
 * 为什么会漏：那两条测试**单独看都对** ——
 * 「`{file:''}` ⇒ `enabled:false`」（空串=明确关掉）与
 * 「缺 `file` ⇒ 推路径」。「**什么都不传**」这个**组合**没人测 ⇒ 它就成了藏身处。
 * ⇒ 所以下面 `test\outbound-ledger.test.mjs` 里钉了"无参调用"那条。
 */
export const DEFAULT_OUTBOUND_LEDGER = Object.freeze({
  enabled: true,
  /** 目标行数（超出后裁到这么多）。 */
  maxLines: 5000,
  /** 连续写失败几次就本次进程内断开（同 `sticker-audit.mjs`）。 */
  failsBeforeDisable: 5,
});

/**
 * 把配置收拾成能用的形状（越界一律夹到边界，不抛）。
 *
 * ⚠️ **不参与推路径**：缺 `file` 时用的是模块加载时定下的
 * {@link DEFAULT_OUTBOUND_LEDGER_PATH}（推路径那条路单独可测、单独一个真源）。
 * 这里只负责"配置 → 能用的形状"。
 *
 * @param {object} [raw]
 * @returns {{file: string, enabled: boolean, maxLines: number, failsBeforeDisable: number}}
 */
export function normalizeOutboundLedger(raw = {}) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const intIn = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  // ⚠️ 缺字段 ⇒ 用**本进程推出来的**默认路径（模块加载时定一次的那个常量）；
  //    显式给（含空串）⇒ 以给的为准。空串因此是"明确关掉"，不是"走默认"。
  //
  // ⚠️ **这里故意不加 `|| DEFAULT_OUTBOUND_LEDGER_PATH` 之类的兜底**：
  //    那会把**显式的 `{ file: '' }`**（= 用户明确关掉）也悄悄改成默认路径 ⇒
  //    "关了却还在写" —— 又一种静默不生效，方向还反着。
  //    "默认不会关掉"这件事靠的是 `DEFAULT_OUTBOUND_LEDGER` **不再持有 `file` 字段**
  //    （见那个常量上的注释），而不是靠在这里抹掉调用方的意图。
  const file = src.file === undefined ? DEFAULT_OUTBOUND_LEDGER_PATH : text(src.file);
  return {
    // ⚠️ 空串 = **明确关掉**（同 `sticker-audit` 的 `dir`：空串是关，缺字段才是走默认）。
    file,
    // ⚠️ **路径为空就等于关掉**：没有路径就没地方写，"以为自己开着"只会更坏。
    enabled: bool(src.enabled, DEFAULT_OUTBOUND_LEDGER.enabled) && file !== '',
    // 上限 20 万行：再大就不是"排查用的台账"了（一行约 200 字节 ⇒ 20 万行约 40 MB）。
    maxLines: intIn(src.maxLines, DEFAULT_OUTBOUND_LEDGER.maxLines, 0, 200_000),
    failsBeforeDisable: intIn(src.failsBeforeDisable, DEFAULT_OUTBOUND_LEDGER.failsBeforeDisable, 0, 1000),
  };
}

/**
 * 台账用的哈希：净文本的 `sha256` **前 16 位十六进制**。
 *
 * 为什么只取前 16 位：64 位十六进制（256 bit）在"同一秒里两条相同"这个用途上
 * 是过量的，16 位（64 bit）已经远超碰撞概率上界；而台账要**一眼能看**、还要能塞进一行。
 *
 * ⚠️ 空文本**不是**空串 —— 它照样有哈希（`e3b0c44298fc1c14…`），
 * 那是"我确实算了一个空串"的证据，比留空字段强（留空分不清"没算"和"算出来是空"）。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function ledgerHash(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 真正的底层发送动作叫什么（`transport.mjs` 里 `sendToChat` 是 `send_msg` 的包装）。
 *
 * 只用来写台账的 `action` 字段（"这一层到底调了哪个动作"），不参与判定。
 */
const TRANSPORT_SEND_METHOD = 'sendToChat';
const TRANSPORT_SEND_ACTION = 'send_msg';

/**
 * 造一个台账。
 *
 * @param {object} [options]
 * @param {object} [options.config] `normalizeOutboundLedger` 收拾过的参数（或原始配置）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {object} [options.fsImpl] 注入 fs（测试用）
 * @param {() => number} [options.now] 时钟（测试用）
 * @returns {{record: (input: object) => boolean, stats: () => object, file: () => string,
 *   enabled: () => boolean, uninstall: () => void, read: () => object[]}}
 */
export function createOutboundLedger({
  config = null,
  log = () => {},
  fsImpl = null,
  now = () => Date.now(),
} = {}) {
  const cfg = normalizeOutboundLedger(config ?? DEFAULT_OUTBOUND_LEDGER);
  const f = fsImpl ?? fs;
  /** 裁一次的窗口：`maxLines × 1.5`（同 `sticker-audit.mjs` 的 `trimIndexIfNeeded`）。 */
  const trimAt = Math.max(cfg.maxLines, Math.ceil(cfg.maxLines * 1.5));
  /**
   * 已知的行数。
   *
   * ⚠️ 它**只在内存里**，所以有两种情况会让它偏小：进程中途重启（文件还在、计数归零）、
   * 或者别人往这个文件里写过。`LINECOUNT_RECHECK_EVERY` 是为此留的安全阀
   * —— 每追加这么多次就**真去数一遍**，偏了就拿实际值纠正。
   */
  const LINECOUNT_RECHECK_EVERY = 500;

  const stats = {
    enabled: cfg.enabled && cfg.file !== '',
    wrote: 0,
    failed: 0,
    trims: 0,
    trimmedLines: 0,
    disabled: false,
    failStreak: 0,
    last: null,
    /**
     * 挂钩到底装上了没有。
     *
     * ⚠️ 它必须是个**独立字段**：挂钩失败（transport 没有 `sendToChat`、
     * 或者 `Object.defineProperty` 被拒）时，`wrote` 会一直是 0 ——
     * 而"没挂上钩"和"挂了但没发过消息"在计数上**完全一样**。
     * 有了它，那种静默失效在快照里一眼可见（`hooked:false` 而 `enabled:true`）。
     */
    hooked: false,
  };
  let lineCount = 0;
  let linesSinceCheck = 0;
  /** 挂钩过的 transport（`uninstall()` 装回原方法用）。 */
  let transportRef = null;
  /** 每成功记一行调一次的回调（诊断口径）。 */
  let recordSink = null;
  /** 每次发送动作都调一次的回调（计数口径 —— 与台账写没写成功无关）。 */
  let actionSink = null;

  /** 真去数一遍文件行数（读不到当 0 —— 文件还不存在是最常见的情况）。 */
  function actualLineCount() {
    try {
      const text = f.readFileSync(cfg.file, 'utf8');
      return text.split('\n').filter((l) => l.trim() !== '').length;
    } catch {
      return 0;
    }
  }

  /** 超过 `trimAt` 就只留尾部 `maxLines` 行（它不该无声长大）。 */
  function trimIfNeeded() {
    if (cfg.maxLines <= 0) return;
    if (lineCount <= trimAt) return;
    try {
      const text = f.readFileSync(cfg.file, 'utf8');
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      if (lines.length <= trimAt) {
        // 别人删过或刚才读错了 ⇒ 以实际为准，不白裁。
        lineCount = lines.length;
        return;
      }
      const tail = lines.slice(lines.length - cfg.maxLines);
      // 原子写：半截的 jsonl 比没有更坏（读的人会以为"当时就是这么发的"）。
      const tmp = `${cfg.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      f.writeFileSync(tmp, `${tail.join('\n')}\n`, 'utf8');
      f.renameSync(tmp, cfg.file);
      stats.trims += 1;
      stats.trimmedLines += lines.length - tail.length;
      lineCount = tail.length;
      log('info', '出站台账超上限，已只保留尾部', {
        had: lines.length, kept: tail.length, maxLines: cfg.maxLines,
      });
    } catch (error) {
      log('debug', '出站台账裁剪失败（不影响发送）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 追加一行。**绝不抛异常。**
   *
   * @param {object} input
   * @param {string} input.layer `gw-send` / `transport-action`
   * @param {string} [input.caller] 谁调的（常量字符串）
   * @param {string} [input.chatId]
   * @param {number} [input.chars] **净文本**长度（图片不计）
   * @param {string} [input.sha256] `ledgerHash(净文本)`
   * @param {string} [input.at] ISO 时刻；**不给才用 `now()`**
   *   （调用方要"决定要发"那一刻时**必须自己给** —— 见下面的注释）
   * @param {string} [input.echo] OneBot 的 `echo`（拿得到才记）
   * @param {string|number} [input.messageId] NapCat 回的 `message_id`（拿得到才记）
   * @param {string} [input.action] 这一层调的动作名
   * @param {boolean} [input.ok] 成功/抛异常
   * @param {object} [input.meta] 少量附加标量（**绝不放正文**）
   * @returns {boolean} 真写了一行才 true
   */
  function record(input) {
    if (!stats.enabled || stats.disabled) return false;
    try {
      const chars = Number(input?.chars);
      // ⚠️ **`at` 以调用方给的为准**（给空才用 `now()`）。
      //    `gw-send` 那一层必须在"**决定要发**的瞬间"取时刻（不是 await 回来之后），
      //    否则两条本来同秒的记录会被推散成不同秒，**恰好毁掉"同一秒两条"这个判据**。
      //    调用方没给时（`transport-action` 那种）才用注入的时钟。
      const at = typeof input?.at === 'string' && input.at !== '' ? input.at : new Date(now()).toISOString();
      const entry = {
        at,
        layer: String(input?.layer ?? ''),
        caller: String(input?.caller ?? CALLER_UNKNOWN),
        chatId: String(input?.chatId ?? ''),
        chars: Number.isFinite(chars) ? Math.max(0, Math.floor(chars)) : 0,
        sha256: String(input?.sha256 ?? ''),
        ok: input?.ok === true,
      };
      // `echo` / `messageId` **拿得到才记**：没有这两个字段比记一个空串诚实
      //（空串分不清"没有"和"是空的"）。
      if (input?.echo !== undefined && input.echo !== null && String(input.echo) !== '') {
        entry.echo = String(input.echo);
      }
      if (input?.messageId !== undefined && input.messageId !== null && String(input.messageId) !== '') {
        entry.messageId = input.messageId;
      }
      if (input?.action !== undefined && input.action !== null && String(input.action) !== '') {
        entry.action = String(input.action);
      }
      if (input?.meta !== null && typeof input?.meta === 'object') {
        // 只留短标量：`meta` 是给人看的附注，不是搬运正文的通道。
        //
        // ⚠️ 2026-10-26 修：原来一律"字符串 ≤60 字符"，于是 `error`
        // （NapCat 的原话，通常带中文/括号/JSON，>60 是常态）被**静默丢掉** ——
        // 线上那次发图失败，台账上只剩 `{ok:false, text:false}`，**看不到原因**。
        // 现在 `error` 单独放宽到 300 字符，其余仍限 60（正文依旧搬不进 meta）。
        const limitOf = (key) => (key === 'error' ? 300 : 60);
        const meta = {};
        for (const [k, v] of Object.entries(input.meta)) {
          if (typeof v === 'number' || typeof v === 'boolean') meta[k] = v;
          else if (typeof v === 'string' && v.length <= limitOf(k)) meta[k] = v;
        }
        if (Object.keys(meta).length > 0) entry.meta = meta;
      }

      f.mkdirSync(path.dirname(cfg.file), { recursive: true });
      f.appendFileSync(cfg.file, `${JSON.stringify(entry)}\n`, 'utf8');
      stats.wrote += 1;
      stats.failStreak = 0;
      stats.last = entry;
      lineCount += 1;
      linesSinceCheck += 1;

      const recount = linesSinceCheck >= LINECOUNT_RECHECK_EVERY;
      if (recount) {
        linesSinceCheck = 0;
        lineCount = actualLineCount();
      }
      trimIfNeeded();
      return true;
    } catch (error) {
      stats.failed += 1;
      stats.failStreak += 1;
      log('warn', '出站台账写盘失败（发送不受影响）', {
        file: cfg.file,
        error: error instanceof Error ? error.message : String(error),
        failStreak: stats.failStreak,
      });
      if (cfg.failsBeforeDisable > 0 && stats.failStreak >= cfg.failsBeforeDisable) {
        stats.disabled = true;
        log('warn', '出站台账连续写盘失败，**本次进程内已断开**（免得每条消息都撞一次）', {
          file: cfg.file, failStreak: stats.failStreak,
        });
      }
      return false;
    }
  }

  /**
   * 读回全部台账行（**只给诊断/测试用**，坏了返回空数组，不抛）。
   *
   * @returns {object[]}
   */
  function read() {
    try {
      const text = f.readFileSync(cfg.file, 'utf8');
      return text
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter((x) => x !== null);
    } catch {
      return [];
    }
  }

  /**
   * 挂钩传输层的发送包装。
   *
   * ## 为什么挂在 `sendToChat` 而**不**挂 `action('send_msg')`
   *
   * `transport.sendToChat(chatId, message)`（`transport.mjs` L282）**就是**
   * "调底层发送动作"的那一步 —— 它内部一次 `this.sendMsg()`（L284），
   * 而 `sendMsg` 再调一次 `this.action('send_msg', …)`（L267）。
   * 两者是**同一次发送**的两层写法：**同时挂就会把一次发送记成两行**，
   * 台账上长得**和"真的发了两遍"一模一样** —— 那正好毁掉这个台账存在的理由。
   * 所以只挂外层这一个（任务书里"或其包装"指的就是它）。
   *
   * ## 为什么是**就地换方法**而不是包一层代理对象
   *
   * 网关订阅了 `transport` 的四个事件（`event` / `down` / `log` / `ready`），
   * 还读 `transport.selfId`、调 `transport.stop()`。包一个代理对象出来，
   * 要么得把事件转发一遍（多一层能坏的东西），要么得让网关改去订阅原对象
   * （那 `this.transport` 就不是它订阅的那个了）。**就地换掉那一个方法**
   * 只动发送这一条路，其余的原封不动 —— 而且 `uninstall()` 能装回去。
   *
   * **不抛异常、不改变返回值、不改变异常**：原方法怎么来的怎么回去。
   *
   * @param {object} transport
   * @param {{onRecord?: (entry: object) => void, onAction?: (entry: object) => void}} [hooks]
   *
   *   ⚠️ **两个回调必须分开，不能合成一个**（所以是对象，不是两个位置参数 ——
   *   位置参数会让调用点写 `instrument(t, null, fn)`，读的人根本看不出
   *   "第一根线没接"是有意的还是漏了）。它们的口径不同：
   *
   *   | 回调 | 何时调 | 口径 | 用在哪 |
   *   |---|---|---|---|
   *   | `onAction` | **每一次发送动作** | 真的发生了一次发送 | 计数（`stats.outbound.actions`） |
   *   | `onRecord` | 一行**真的写下**时 | 真的记下来了 | 诊断（"台账是不是好的"） |
   *
   *   合成一个的后果很具体：**台账一写不进去，计数器就一起停**——
   *   于是"我发了很多条但台账没记上"和"什么都没发"在快照上长得一模一样，
   *   而那正是这个改动要消灭的静默失效。
   *   （2026-10-11 实测踩过：回调抛错被吞掉 ⇒ `actions` 恒为 0 ⇒ 看起来像没发过。）
   *
   *   两个回调抛异常都**不影响**台账，也不影响发送。
   * @returns {() => void} 卸载函数（装回原方法）
   */
  function instrument(transport, hooks = {}) {
    if (transport === null || typeof transport !== 'object') return () => {};
    if (typeof transport[TRANSPORT_SEND_METHOD] !== 'function') return () => {};
    // 幂等：已经挂过的就别再包一层（网关被复用/测试重复调用时）。
    // ⚠️ 这条不是防呆，是**防重复记账**：包两层 ⇒ 一次发送记两行
    //    ⇒ 台账上长得和"真的发了两遍"一模一样。
    if (transport.__outboundLedgerInstalled === true) return () => {};
    // 记住它，`uninstall()` 用它（调用方不必自己存卸载函数）。
    transportRef = transport;
    // 最新一次的回调（重新挂钩时以新的为准）。
    const { onRecord = null, onAction = null } = hooks ?? {};
    if (typeof onRecord === 'function') recordSink = onRecord;
    if (typeof onAction === 'function') actionSink = onAction;

    const original = transport[TRANSPORT_SEND_METHOD];

    /**
     * 记一行 `transport-action`，并（写成功时）通知 `recordSink`。
     *
     * 抽出来是因为**成功与失败两条路必须记成一模一样的形状** ——
     * 分两份写迟早会漂移，而"失败那次少一个字段"正好会让判读表读错。
     */
    const emit = (chatId, message, ok, extra) => {
      const isText = typeof message === 'string';
      const plain = isText ? message : '';
      // ⚠️ `messageId` 是**顶层字段**，不能混进 `meta`（`meta` 是附注，不是接口）。
      const { messageId, error, ...rest } = extra ?? {};
      const meta = { text: isText, ...rest };
      if (error !== undefined) meta.error = error;
      const entry = {
        layer: LAYER_TRANSPORT_ACTION,
        caller: `${TRANSPORT_SEND_METHOD}:${TRANSPORT_SEND_ACTION}`,
        chatId,
        chars: plain.length,
        sha256: ledgerHash(plain),
        action: TRANSPORT_SEND_ACTION,
        ok,
        // `text:false` = 这条载荷是**段数组**（带图的），`chars` 只是文本段的长度，
        // 不是整条消息的长度 —— 判读时别把带图的那几条混进来比长度。
        meta,
      };
      if (messageId !== undefined && messageId !== null && String(messageId) !== '') {
        entry.messageId = messageId;
      }
      /**
     * 通知一个消费者回调（**传入 `entry`，不靠闭包** —— 这个函数定义在 `emit` 之外）。
     *
     * ⚠️ 故意把 `entry` 做成参数：上面那版靠闭包抓 `emit` 里的 `entry`，
     * 而 `notify` 定义在 `emit` 外面 ⇒ 悬空引用、一跑就 `ReferenceError`。
     * 这正是这次差点漏掉的形状（"看起来在闭包里，其实不在"）。
     */
    const notify = (sink, entry, what) => {
      if (sink === null) return;
      try {
        sink(entry);
      } catch (error) {
        // ⚠️ **`debug` 级，不是 `warn`**：回调是调用点自己的逻辑，
        //    它坏了不该在日志里喊，但**不能完全静默** —— 这次调试就靠它抓到
        //    `gateway.mjs` 里漏 import 一个常量导致 `actions` 恒为 0（一个静默失效）。
        log('debug', `出站台账的${what}回调抛错（计数/诊断可能不准）`, {
          layer: entry?.layer,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    // ⚠️ **顺序与条件都是刻意的**：
    //   1. `actionSink` **先调、无条件调** —— 它数的是"发生了一次发送动作"，
    //      跟台账写没写成功**无关**（写不进去也要数）。放在 `record()` 后面、
    //      或者挂在 `wrote` 上，都会让"台账坏了"顺带把计数也弄停。
    //   2. `recordSink` 只在**真的写下来一行**时调 —— 它是"台账好不好"的诊断口径。
    notify(actionSink, entry, '计数');
    const wrote = record(entry);
    if (wrote) notify(recordSink, entry, '诊断');
    return wrote;
  };

    const wrapped = async function outboundLedgerSendToChat(chatId, message) {
      try {
        const result = await original.call(this, chatId, message);
        emit(chatId, message, true, { messageId: result });
        return result;
      } catch (error) {
        emit(chatId, message, false, {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };

    try {
      // 非枚举：它不该出现在"transport 有什么"的遍历里（`uninstall` 是设施，不是接口）。
      Object.defineProperty(transport, '__outboundLedgerInstalled', {
        value: true, enumerable: false, configurable: true, writable: true,
      });
      Object.defineProperty(transport, '__outboundLedgerUninstall', {
        value: () => {
          try {
            transport[TRANSPORT_SEND_METHOD] = original;
            transport.__outboundLedgerInstalled = false;
            recordSink = null;
            actionSink = null;
            stats.hooked = false;
          } catch { /* 装不回去也不影响发送 */ }
        },
        enumerable: false, configurable: true, writable: true,
      });
      transport[TRANSPORT_SEND_METHOD] = wrapped;
      stats.hooked = true;
    } catch (error) {
      log('debug', '出站台账挂钩失败（发送不受影响，台账会缺 transport-action 这一层）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return () => {};
    }
    return () => {
      try { transport.__outboundLedgerUninstall(); } catch { /* 无关紧要 */ }
    };
  }

  /** 卸载（把原方法装回去）。 */
  function uninstall() {
    try {
      if (transportRef !== null && typeof transportRef.__outboundLedgerUninstall === 'function') {
        transportRef.__outboundLedgerUninstall();
      } else {
        // 没挂过也要把回调清掉：`instrument()` 幂等早退时**不会**设它们
        // ⇒ 留着上一次的，下一个挂钩的调用点会以为自己还在被通知。
        recordSink = null;
        actionSink = null;
      }
    } catch { /* 无关紧要 */ }
  }

  return {
    record,
    instrument,
    stats: () => ({
      ...stats,
      /**
       * ⚠️ **这里报的是"构造时定的"那个值**（`stats.enabled`），
       * 不是 `enabled()` 那个复合判定。理由：`enabled()` 还要减去
       * "连续写失败 ⇒ 自己断开"（`stats.disabled`）那一种。
       * **两个分开看才分得清**「本来就没开」与「开着但写不进去、自己断开了」——
       * 在现象上（文件里没东西）它们**一模一样**，处置却完全不同。
       */
      enabled: stats.enabled,
      file: cfg.file,
      maxLines: cfg.maxLines,
      trimAt,
      lines: lineCount,
    }),
    file: () => cfg.file,
    enabled: () => stats.enabled && !stats.disabled,
    uninstall,
    read,
  };
}

/**
 * 判读表（**人看的**）：同一秒里，各层各出现几条 ⇒ 结论是什么。
 *
 * 把它放代码里（而不是只写在报告里），是因为**它是这个台账存在的全部理由**：
 * 下次再出"两条"，第一个问题就是"看台账"，而看台账的人需要在**当场**
 * 就把三个数字映射到三个结论，不该去翻文档。
 *
 * @returns {Array<{shape: string, verdict: string}>}
 */
export function describeOutboundVerdicts() {
  return [
    { shape: 'gw-send 1 + transport-action 2', verdict: 'WS/传输层写了两遍' },
    { shape: 'gw-send 1 + transport-action 1 + QQ 2', verdict: 'NapCat 侧重复' },
    { shape: 'gw-send 2', verdict: '插件真的发了两次（去查调用方）' },
  ];
}