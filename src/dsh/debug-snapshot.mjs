/**
 * 运行时调试快照 —— 让 agent 能自主验证插件是否真的收到了消息。
 *
 * ## 为什么需要它
 *
 * 本插件的主动层**不建 DSH 会话、也不回复**（回复是 dsh-onebot-qq 的活），
 * 所以它的全部状态只活在内存里。结果是：
 *   - 无法从磁盘判断它有没有收到消息
 *   - 无法从磁盘判断转录有没有建起来
 *   - 无法判断主动插话为什么没触发
 *
 * 每次排查都要用户复制粘贴控制台，效率低且容易漏。所以把关键状态**节流落盘**，
 * agent 直接读文件即可自证。
 *
 * ## 设计约束
 *
 * - **零依赖**、纯 JSON、原子写（先写临时文件再 rename，避免读到半截）
 * - **节流**：默认每 15 秒最多写一次，避免消息密集时反复写盘
 * - **不抛异常**：调试设施坏了绝不能影响主流程
 * - **只写摘要**：不落完整转录文本，避免把群聊内容大量落盘
 */

import fs from 'node:fs';
import path from 'node:path';

import { moodSnapshotState } from './mood.mjs';
import { ownerSnapshot } from './owner.mjs';

/** 默认输出路径（可用环境变量覆盖）。 */
export function defaultDebugPath(env = process.env) {
  const home = env.DSH_HOME ?? '';
  if (home === '') return '';
  return path.join(home, 'media', 'qq-proactive-debug.json');
}

/**
 * 造一个节流写入器。
 *
 * @param {object} [options]
 * @param {string} [options.filePath] 输出路径；空字符串表示禁用
 * @param {number} [options.minIntervalMs] 两次写盘的最小间隔
 * @param {() => number} [options.now] 注入时钟（测试用）
 * @param {(err: Error) => void} [options.onError] 写失败时的回调（默认静默）
 * @returns {{write: (snapshot: object, force?: boolean) => boolean, filePath: string}}
 */
export function createDebugWriter({ filePath, minIntervalMs = 15000, now = Date.now, onError } = {}) {
  const target = String(filePath ?? '');
  // 初值用 -Infinity 而不是 0：注入时钟可能从任意值起步（测试里常从 0/1000 开始），
  // 用 0 会让"首次写入"被误判成"间隔不足"。
  let lastWrite = Number.NEGATIVE_INFINITY;

  const report = (err) => {
    try {
      if (typeof onError === 'function') onError(err);
    } catch {
      /* 连错误回调都坏了就算了 */
    }
  };

  return {
    filePath: target,
    /**
     * 写一份快照。
     * @param {object} snapshot
     * @param {boolean} [force] 忽略节流
     * @returns {boolean} 是否真的写了
     */
    write(snapshot, force = false) {
      if (target === '') return false;
      const t = now();
      if (!force && t - lastWrite < minIntervalMs) return false;
      try {
        const dir = path.dirname(target);
        fs.mkdirSync(dir, { recursive: true });
        const payload = { ...snapshot, writtenAt: new Date(t).toISOString() };
        // 原子写：先写临时文件再改名，避免读的人拿到半截 JSON
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tmp, target);
        lastWrite = t;
        return true;
      } catch (err) {
        report(err instanceof Error ? err : new Error(String(err)));
        return false;
      }
    },
  };
}

/**
 * `sessionMode` 的合法取值（`via`）。
 *
 * - `resume`：把已有会话日志接回来（她记得之前的话）；
 * - `create`：新建会话（**恢复失败时会走到这里 ⇒ 她"失忆"了**）；
 * - `adopt`：热重载后收养一个还活着的 agent（没建也没接）。
 */
const SESSION_MODES = new Set(['resume', 'create', 'adopt']);

/**
 * 把 `sessionMode` 归一成固定形状 `{via, reason}`。
 *
 * 容错是刻意的：快照是诊断设施，**绝不能因为调用方少传/传错就把写快照搞挂**
 * （2026-10-14 一次未定义引用把宿主带崩过）。不传 ⇒ `{via:'create', reason:null}`，
 * 与"还没建过会话"的语义一致；`reason` 不是非空字符串就当没有（成功 / 直接新建）。
 *
 * @param {unknown} value
 * @returns {{via: 'resume'|'create'|'adopt', reason: string|null}}
 */
function normalizeSessionMode(value) {
  const via = value !== null && typeof value === 'object' ? value.via : undefined;
  const reason = value !== null && typeof value === 'object' ? value.reason : undefined;
  return {
    via: SESSION_MODES.has(via) ? via : 'create',
    reason: typeof reason === 'string' && reason !== '' ? reason : null,
  };
}

/**
 * 把 `agent` 的推理等级归一成固定形状 `{reasoning, source}`（2026-10-21）。
 *
 * 容错同 `normalizeSessionMode`：快照是诊断设施，**绝不能因为调用方少传/传错就挂掉**。
 * 不传 ⇒ `{reasoning:'', source:'default'}`（"这份快照不知道"，不冒充某个值），
 * 老快照文件里没有这一段也照样能读。
 *
 * @param {unknown} value
 * @returns {{reasoning: string, source: 'config'|'default'}}
 */
/**
 * 语音探针（B4）的归一化：**只留摘要需要的四样东西**，并且绝不放正文。
 *
 * 为什么还要归一化（值本来就是网关造好的）：快照是**跨版本可读**的东西 ——
 * 下一个会话读它的时候，代码可能已经改过两三版了。这里把形状钉住
 * （`count`/`transcribed`/`keys`），顺手把可能出现的原始载荷挡在外面。
 *
 * @param {unknown} value `gateway.lastRecordProbe`
 * @returns {null | {at: string, chatId: string, count: number, transcribed: boolean, records: object[]}}
 */
function normalizeRecordProbe(value) {
  if (value === null || typeof value !== 'object') return null;
  const probe = value;
  const records = Array.isArray(probe.records) ? probe.records : [];
  return {
    at: typeof probe.at === 'string' ? probe.at : '',
    chatId: typeof probe.chatId === 'string' ? probe.chatId : '',
    count: Number.isFinite(probe.count) ? probe.count : records.length,
    transcribed: probe.transcribed === true,
    // 摘要已经是"键名 + 短值"（`summarizeRecordSegment`），这里只截数量。
    records: records.slice(0, 3),
  };
}

/**
 * 「最近一次拿不到回复」的归一化（2026-10-28，事故驱动）。
 *
 * 形状钉死的理由同 `normalizeRecordProbe`：快照要能跨版本读。
 *
 * 每一格都对应事故现场的一个事实：
 * - `historyShrank`：**这一轮历史变短了** ⇒ 压缩/重写过 surface ⇒
 *   按下标取回复的主路径必然切空（这就是根因的形状）；
 * - `streamFrames` / `streamedChars`：流式兜底来没来、抽没抽出字
 *   （事故里是 `3 / 0` —— 来了但一个字都抽不出来）；
 * - `before` / `after`：压缩前后的条数，一看就知道"是不是它"。
 *
 * @param {unknown} value `gateway.lastEmptyReply`
 * @returns {null | {at: number, chatId: string, sessionKey: string, kind: string, before: number, after: number, historyShrank: boolean, streamFrames: number, streamedChars: number}}
 */
function normalizeEmptyReply(value) {
  if (value === null || typeof value !== 'object') return null;
  const diag = value;
  return {
    at: Number.isFinite(diag.at) ? diag.at : 0,
    chatId: typeof diag.chatId === 'string' ? diag.chatId : '',
    sessionKey: typeof diag.sessionKey === 'string' ? diag.sessionKey : '',
    kind: typeof diag.kind === 'string' ? diag.kind : '',
    before: Number.isFinite(diag.before) ? diag.before : 0,
    after: Number.isFinite(diag.after) ? diag.after : 0,
    historyShrank: diag.historyShrank === true,
    streamFrames: Number.isFinite(diag.streamFrames) ? diag.streamFrames : 0,
    streamedChars: Number.isFinite(diag.streamedChars) ? diag.streamedChars : 0,
  };
}

/**
 * 「最近一次 `[不说话]`」的归一化（2026-11-02）。
 *
 * 形状钉死的理由同 `normalizeEmptyReply`：快照要能跨版本读。
 * 每一格回答一个问题：
 * - `toolSent`：这一轮她是不是**先用 `send_qq` 说过了**（true = 标记只是压重复，
 *   不是"她不想说话"）；
 * - `chars` / `images`：被压掉的是多长的正文、几张图（`images > 0` 说明图也没发）。
 *
 * @param {unknown} value `gateway.lastQuietReply`
 * @returns {null | {at: number, chatId: string, sessionKey: string, toolSent: boolean, chars: number, images: number}}
 */
function normalizeQuietReply(value) {
  if (value === null || typeof value !== 'object') return null;
  const note = value;
  return {
    at: Number.isFinite(note.at) ? note.at : 0,
    chatId: typeof note.chatId === 'string' ? note.chatId : '',
    sessionKey: typeof note.sessionKey === 'string' ? note.sessionKey : '',
    toolSent: note.toolSent === true,
    chars: Number.isFinite(note.chars) ? note.chars : 0,
    images: Number.isFinite(note.images) ? note.images : 0,
  };
}

/**
 * 语音转写器的归一化（B4，2026-10-25）：**只留配置与计数**。
 *
 * 形状钉死的原因同 `normalizeRecordProbe`：快照要能跨版本读，
 * 而转写器以后可能加字段（每加一个都要能安全落盘）。
 *
 * @param {unknown} value `gateway.voiceTranscriber`
 * @returns {null | {enabled: boolean, attempts: number, ok: number, failed: number, cached: number, ntqqFailed: number, ntqqCalls: number, ntqqRetries: number, lastMs: number, lastError: string, lastAt: string, device: string, language: string, model: string, timeoutMs: number, cacheEntries: number}}
 */
function normalizeVoiceStats(value) {
  if (value === null || typeof value !== 'object') return null;
  let described = null;
  try {
    described = typeof value.describe === 'function' ? value.describe() : null;
  } catch {
    described = null;
  }
  if (described === null || typeof described !== 'object') return null;
  const num = (input) => (Number.isFinite(input) ? input : 0);
  return {
    enabled: described.enabled === true,
    attempts: num(described.attempts),
    ok: num(described.ok),
    failed: num(described.failed),
    cached: num(described.cached),
    // `ntqq` = 因为 QQ 自己那条（`fetch_ptt_text`）失败而落到 whisper 的次数。
    // 它一直是 0 且 `ok > 0` ⇒ QQ 的转写其实能用；一直涨 ⇒ 只有本机 whisper 在干活。
    ntqqFailed: num(described.ntqqFailed),
    // 2026-10-26：`fetch_ptt_text` 的真相是「调一次触发、QQ 内核异步写回」⇒ 现在会重试。
    // 这两个数就是用来判"写回到底要多久"的：`ntqqCalls` = 一共问了几次、
    // `ntqqRetries` = 其中第 2 次及以后各算一次。成功时 `ntqqRetries=0` ⇒ 一次就拿到。
    ntqqCalls: num(described.ntqqCalls),
    ntqqRetries: num(described.ntqqRetries),
    lastMs: num(described.lastMs),
    lastError: typeof described.lastError === 'string' ? described.lastError : '',
    /** 最后一次成功的引擎：`ntqq` / `whisper` / ''。 */
    lastSource: typeof described.lastSource === 'string' ? described.lastSource : '',
    lastAt: typeof described.lastAt === 'string' ? described.lastAt : '',
    engine: typeof described.engine === 'string' ? described.engine : '',
    device: typeof described.device === 'string' ? described.device : '',
    language: typeof described.language === 'string' ? described.language : '',
    model: typeof described.model === 'string' ? described.model : '',
    timeoutMs: num(described.timeoutMs),
    cacheEntries: num(described.cacheEntries),
    tempDir: typeof described.tempDir === 'string' ? described.tempDir : '',
  };
}

/**
 * 语音合成器（`tts.mjs`）的归一化（2026-10-26）：**只留配置与计数**。
 *
 * 同样是**白名单** —— 形状钉死，快照要能跨版本读。加字段时记得同时改这里，
 * 否则新字段会被**静默吃掉**（`voice.mjs` 那边踩过：`ntqqRetries` 一开始就看不见）。
 *
 * @param {unknown} value `gateway.tts`
 * @returns {null | {enabled: boolean, attempts: number, ok: number, failed: number, cached: number, truncated: number, lastMs: number, lastBytes: number, lastChars: number, lastError: string, lastAt: string, voice: string, maxChars: number, notReadyReason: string}}
 */
function normalizeTtsStats(value) {
  if (value === null || typeof value !== 'object') return null;
  let described = null;
  try {
    described = typeof value.describe === 'function' ? value.describe() : null;
  } catch {
    described = null;
  }
  if (described === null || typeof described !== 'object') return null;
  const num = (input) => (Number.isFinite(input) ? input : 0);
  return {
    enabled: described.enabled === true,
    attempts: num(described.attempts),
    ok: num(described.ok),
    failed: num(described.failed),
    cached: num(described.cached),
    truncated: num(described.truncated),
    lastMs: num(described.lastMs),
    lastBytes: num(described.lastBytes),
    lastChars: num(described.lastChars),
    lastError: typeof described.lastError === 'string' ? described.lastError : '',
    lastAt: typeof described.lastAt === 'string' ? described.lastAt : '',
    voice: typeof described.voice === 'string' ? described.voice : '',
    maxChars: num(described.maxChars),
    /** 没开的时候**为什么**没开（"她为什么不发语音"先看这一句）。 */
    notReadyReason: typeof described.notReadyReason === 'string' ? described.notReadyReason : '',
  };
}

/**
 * **语音情绪旁路**（`emotion.mjs`）的归一化（2026-10-26）。
 *
 * ⚠️ 这是**白名单** —— 新字段必须同时加进来，否则会被**静默吃掉**
 * （这个坑已经踩过两次：`ntqqRetries`、`stats.voices`）。
 *
 * ## 口径（用户 2026-10-26 拍板）
 *
 * - **只有 arousal**：valence/dominance 连 `describe()` 都不返回，所以这里也没得抄。
 * - **不记正文**：只有 `textSha`（前 8 位）和 `textLen`，跟正文对得上、又搬不走正文。
 * - `skipped` 是**正常结论**（太短/太静），和 `failed` 分开数 —— 这两种的处置完全不同。
 *
 * @param {unknown} value `gateway.emotionSenser`
 * @returns {null | {enabled: boolean, attempts: number, scored: number, skipped: number, failed: number, cached: number, tooShort: number, tooQuiet: number, overThreshold: number, lastMs: number, lastArousal: number|null, lastSkipped: string, lastError: string, lastAt: string, threshold: number, minSeconds: number, minRms: number, notReadyReason: string}}
 */
function normalizeEmotionStats(value) {
  if (value === null || typeof value !== 'object') return null;
  let described = null;
  try {
    described = typeof value.describe === 'function' ? value.describe() : null;
  } catch {
    described = null;
  }
  if (described === null || typeof described !== 'object') return null;
  const num = (input) => (Number.isFinite(input) ? input : 0);
  const reasons = described.skipReasons !== null && typeof described.skipReasons === 'object'
    ? described.skipReasons
    : {};
  return {
    enabled: described.enabled === true,
    attempts: num(described.attempts),
    scored: num(described.scored),
    skipped: num(described.skipped),
    failed: num(described.failed),
    cached: num(described.cached),
    tooShort: num(reasons.too_short),
    tooQuiet: num(reasons.too_quiet),
    /** 越过「听着挺急」门槛的次数（v1 只计数，**不进提示词**）。 */
    overThreshold: num(described.overThreshold),
    lastMs: num(described.lastMs),
    lastArousal: Number.isFinite(described.lastArousal) ? described.lastArousal : null,
    lastSkipped: typeof described.lastSkipped === 'string' ? described.lastSkipped : '',
    lastError: typeof described.lastError === 'string' ? described.lastError : '',
    lastAt: typeof described.lastAt === 'string' ? described.lastAt : '',
    threshold: num(described.threshold),
    minSeconds: num(described.minSeconds),
    minRms: num(described.minRms),
    notReadyReason: typeof described.notReadyReason === 'string' ? described.notReadyReason : '',
  };
}

/**
 * 最近一条**算出来的**情绪（`gateway.lastEmotion`）。
 *
 * 只留 `arousal` + 与正文对得上的两个指纹；**valence/dominance 不存在**（源头就不返回）。
 *
 * @param {unknown} value
 * @returns {null | {at: string, chatId: string, arousal: number, textSha: string, textLen: number, secs: number, rms: number, ms: number, overThreshold: boolean, skipped: string}}
 */
function normalizeEmotionResult(value) {
  if (value === null || typeof value !== 'object') return null;
  const num = (input) => (Number.isFinite(input) ? input : 0);
  return {
    at: typeof value.at === 'string' ? value.at : '',
    chatId: typeof value.chatId === 'string' ? value.chatId : '',
    arousal: num(value.arousal),
    textSha: typeof value.textSha === 'string' ? value.textSha : '',
    textLen: num(value.textLen),
    secs: num(value.secs),
    rms: num(value.rms),
    ms: num(value.ms),
    overThreshold: value.overThreshold === true,
    skipped: typeof value.skipped === 'string' ? value.skipped : '',
  };
}

function normalizeAgentState(value) {
  const node = value !== null && typeof value === 'object' ? value : {};
  return {
    reasoning: typeof node.reasoning === 'string' ? node.reasoning : '',
    source: node.source === 'config' || node.source === 'default' ? node.source : 'default',
  };
}

/**
 * 把引擎/网关的内部状态压成一份**小**快照。
 *
 * 刻意只放计数与最近几条判定理由，不放正文——调试够用，又不会把群聊内容落盘。
 *
 * @param {object} input
 * @param {object} input.gateway
 * @param {object} input.engine
 * @param {object} input.transport
 * @param {object} input.config
 * @param {number} [input.now]
 * @param {object} [input.stickerLibrary] 表情包库（`sticker-library.mjs` 的产物）
 * @param {object|null} [input.mood] 心情管理器（`mood.mjs` 的产物；`null` = 关掉了）
 * @param {object} [input.moodConfig] `[mood]` 的**生效值**（enabled/provider/model/reasoningEffort）
 * @param {{enabled?: boolean, learnerBuilt?: boolean}} [input.learnedMemory]
 *   「学来的记忆」（旧记忆库）的**生效值**：`enabled` 来自 toml 的
 *   `[memory] learned_enabled`，`learnerBuilt` = 这一轮**真的构造了**学习器没有。
 *   ⚠️ 两者刻意分开记：`enabled:false + learnerBuilt:true` 是"配置关了、接线漏了"
 *   （行为上照样在学），而光看一个布尔分不出这种半关状态。
 * @param {{via?: 'resume'|'create'|'adopt', reason?: string|null}} [input.sessionMode]
 *   **最近一次建/接会话走的是哪条路**（2026-10-21）。默认 `{via:'create', reason:null}`，
 *   老调用方不传也能读出固定形状。
 *   为什么必须落盘：恢复失败原来只打 debug 就静默新建同 id 会话 ——
 *   用户看到的是"她突然不记得之前的话"，而快照/日志里分不清恢复还是新建。
 *   `reason` 非空 = 恢复失败过，值就是失败原因。
 * @param {{dir: string, since: number}} [input.watch]
 *   代码新鲜度自查：插件目录与"模块加载时刻"。传了就会算出 `staleCode`。
 * @param {{admins?: string[], source?: string}} [input.owner]
 *   用户的**生效值**（`[owner] admins` 规范化结果 + 来源）。契约是
 *   `snapshot.owner = { admins, source: 'owner'|'allowFrom'|'none' }`。
 *   为什么必须落盘：`admins` 为空时**静默回退**白名单第一个，光看配置读不出
 *   "现在到底按哪一套在跑"。
 * @param {{reasoning?: string, source?: 'config'|'default'}} [input.agent]
 *   小鲸鱼的**推理等级生效值**（2026-10-21）。契约是
 *   `snapshot.agent = { reasoning, source }`：`reasoning` 是真正传给
 *   `agentOptions.reasoningEffort` 的那个字符串，`source` 说明它来自
 *   `[agent] reasoning`（`config`）还是缺省值（`default`）。
 *   为什么必须落盘：这一项以前只写在 `cordis.patch.yml` 里，快照里一个字都没有 ——
 *   "我改成 high 了"和"改了但没重载"在现象上完全一样（都只是她变聪明/没变），
 *   而两者在快照里各不相同。
 * @returns {object}
 */
export function buildSnapshot({
  gateway, engine, transport, config, now = Date.now(), watch, stickerLibrary = null, historyBackfill = null,
  mood = null, moodConfig = {}, learnedMemory = null, knowledgeInject = null, owner = null,
  sessionMode = null, agent = null,
} = {}) {
  const stats = gateway?.stats ?? {};
  return {
    mode: config?.mode ?? '',
    connected: transport?.isReady === true,
    selfId: transport?.selfId ?? '',
    /**
     * 小鲸鱼的**推理等级生效值**（2026-10-21）：`{reasoning, source}`。
     *
     * `source` 两态：`config`（来自 `[agent] reasoning` 或旧的 patch 值）/
     * `default`（读不到 ⇒ 缺省 `low`）。
     */
    agent: normalizeAgentState(agent),
    /**
     * 最近一次**建/接会话**走的是哪条路（2026-10-21）：`{via, reason}`。
     *
     * `via` 三态：`resume`（接回原对话）/ `create`（新建）/ `adopt`（收养活的 agent）。
     * `reason` 只在**恢复失败 ⇒ 改为新建**时有值 —— 它就是失败原因。
     * 这一段的全部意义：让"她失忆了"这件事在磁盘上留下可查的痕迹，
     * 而不是只有一条会滚掉的 debug 日志。
     */
    sessionMode: normalizeSessionMode(sessionMode),
    /**
     * 用户的**生效值**（2026-10-21）：`{ admins: [...], source }`。
     *
     * `source` 三态：
     * - `owner`：来自 `[owner] admins`；
     * - `allowFrom`：`[owner] admins` 为空 ⇒ **静默回退**白名单第一个；
     * - `none`：两处都没有。
     *
     * 回退是静默的，所以这个字段是"现在到底按哪一套在跑"唯一的落盘证据。
     */
    owner: ownerSnapshot(owner),
    /**
     * 这份快照读到的**代码比进程新吗**。
     *
     * 踩过的坑：改了插件源码、但宿主进程还是几十分钟前启动的那个，于是
     * "改完的代码从没被执行过"，而所有计数看起来都正常——排查会一路往
     * 错误方向走（怀疑逻辑、怀疑配置），因为没人会想到跑的是旧代码。
     * 这里把"源码 mtime 晚于模块加载时刻"直接写进快照，一眼可判。
     */
    staleCode: detectStaleCode(watch),
    /**
     * **最近一条语音段（`record`）的字段摘要**（B4 探针，2026-10-25）。
     *
     * 为什么必须进快照：`this.log()` 只进宿主 logger，而**宿主 logger 不落盘**
     * （2026-10-25 实测：探针跑过了，日志里一个字都查不到）。这条信息的用途是
     * 回答一个**只有真机能验**的问题 —— "NapCat 的 record 段里到底有没有
     * QQ 服务端转写（`text`）"。进快照之后，读一眼就够，不用再让用户发语音。
     *
     * `null` = 这个进程还没收到过语音。
     * `transcribed: true` ⇒ 插件已经在用转写了（`[语音：<那句话>]`）；
     * `false` ⇒ 只有占位符，下一步才需要谈 SILK 解码。
     */
    recordProbe: normalizeRecordProbe(gateway?.lastRecordProbe),
    /**
     * **最近一次"拿不到回复"的现场**（2026-10-28 加，事故驱动）。
     *
     * `null` = 这个进程还没丢过回复（正常）。
     * 非 null ⇒ 那一刻 QQ 上是**一片安静**，而这里留着"为什么"：
     * `historyShrank: true` + `before` 远大于 `after` ⇒ 就是压缩把取回复的路弄空了。
     *
     * 为什么必须落盘（和 `recordProbe` 同一条理由）：宿主 logger **不落盘**
     * ⇒ 日志滚掉之后，"她刚才到底丢没丢一条"就再没人回答得了。
     * 2026-10-28 20:43 那次，用户只能靠 `qq-outbound.jsonl` 里"没有 `gw-send`"
     * 反推 —— 那是**缺席的证据**，多一层间接。
     */
    emptyReply: normalizeEmptyReply(gateway?.lastEmptyReply),
    /**
     * **最近一次"她说 `[不说话]`、这一轮没发"的现场**（2026-11-02）。
     *
     * `null` = 这个进程还没遇到过（正常）。非 null ⇒ QQ 上的安静是**她要求的**，
     * 不是丢消息 —— 和旁边 `emptyReply` 那段一起看就能分开这两件事。
     */
    quietReply: normalizeQuietReply(gateway?.lastQuietReply),
    /**
     * **语音转写的状态与计数**（B4 真答案，2026-10-25）。
     *
     * 为什么进快照（和 `recordProbe` 同一条理由）：宿主 logger 不落盘 ⇒
     * "转写到底跑过没有、失败在哪一步"只有落盘才查得到。
     * 这里**只放配置与计数，不放转写出来的文字**（语音内容不该进快照）。
     *
     * `enabled: false` 的常见原因：`[voice] enabled` 没开、python 路径不存在、
     * 转写脚本不存在 —— 那三种在启动时各会打一条 warn（看日志的人能看到）。
     */
    voice: normalizeVoiceStats(gateway?.voiceTranscriber),
    /**
     * **文字转语音（出站）的状态与计数**（`send_voice`，2026-10-26）。
     *
     * 只看两件事就够：`enabled`（开没开）与 `notReadyReason`（没开是为什么：
     * `[tts] enabled` 关 / python 不存在 / 脚本缺失）。再看 `failed` + `lastError`
     * 就知道"她调了但没出声"是哪一步坏的 —— 合成失败和发送失败在 note 里都带原因。
     *
     * ⚠️ **绝不记念出来的正文**（和 `voice` 那条同一口径：语音内容不该进快照）。
     */
    tts: normalizeTtsStats(gateway?.tts),
    /**
     * **语音情绪旁路（wav2small）的状态、计数与最近一条结果**（2026-10-26）。
     *
     * 观察期就靠这一段：`scored` / `tooShort` / `tooQuiet` / `failed` 四种结果分开数，
     * `last.arousal` + `overThreshold` 用来人肉核对"这条到底该不该算急"。
     * **只有 arousal**（valence/dominance 源头就不返回），**不记正文**（只有 textSha/textLen）。
     */
    emotion: {
      ...(normalizeEmotionStats(gateway?.emotionSenser) ?? { enabled: false, attempts: 0, scored: 0,
        skipped: 0, failed: 0, cached: 0, tooShort: 0, tooQuiet: 0, overThreshold: 0, lastMs: 0,
        lastArousal: null, lastSkipped: '', lastError: '', lastAt: '', threshold: 0, minSeconds: 0,
        minRms: 0, notReadyReason: '没接情绪旁路（gateway.emotionSenser 为 null）' }),
      last: normalizeEmotionResult(gateway?.lastEmotion),
      /** 最近几条（最多 5 条，新的在后）—— 观察期抽检用，条数刻意压小（快照别长大）。 */
      recent: Array.isArray(gateway?.recentEmotions)
        ? gateway.recentEmotions.slice(-5).map((item) => normalizeEmotionResult(item))
        : [],
    },
    stats: {
      received: stats.received ?? 0,
      dispatched: stats.dispatched ?? 0,
      observed: stats.observed ?? 0,
      ignored: stats.ignored ?? 0,
      failed: stats.failed ?? 0,
      replies: stats.replies ?? 0,
      /**
       * **语音发出去了几条**（`send_voice` 成功的次数，2026-10-26）。
       *
       * 单独一格而不是并进 `outbound.sends`：那个回答"总共决定发几次"，
       * 这个回答"其中几条是语音" ⇒ `sends - voices` 就是文字条数，
       * "她是不是只会打字"一眼能看出来。（和 `tts` 段的 `failed` 一起看，
       * 还能区分"她没用语音"与"用了但合成/发送失败"。）
       */
      voices: stats.voices ?? 0,
      /**
       * **拿不到回复的计数**（2026-10-28 加，事故驱动）。
       *
       * 为什么必须进快照：`stats.replies` 只数"发出去几条"，它**回答不了**
       * "有多少轮本该说话却一个字都没发"。2026-10-28 20:43 那一轮就是这样 ——
       * 模型明明回了，压缩把取回复的路径弄空 ⇒ responder 返回 `''` ⇒
       * 网关当"模型决定不说话"静默丢弃：QQ 上一句话没到、台账里连
       * `gw-send` 都没有、日志里那条还是 `debug`（默认不输出、宿主 logger 也不落盘）。
       * **那一次，快照是唯一能回答"她刚才到底回没回"的地方，而它当时什么都没有。**
       *
       * - `emptyReplies`：空回复轮数（含"模型确实不说话"，**正常会有**）；
       * - `lostReplies`：**有丢消息迹象**的空回复（历史被压缩过 / 明明有新消息却没文本）；
       * - `compactedTurns`：这一轮历史被压缩/重写过的轮数。
       *
       * ⇒ **`lostReplies > 0` 就是"回复被静默丢过"**，去看 `emptyReply` 段拿现场。
       */
      emptyReplies: stats.emptyReplies ?? 0,
      lostReplies: stats.lostReplies ?? 0,
      compactedTurns: stats.compactedTurns ?? 0,
      /**
       * **她回 `[不说话]` 的轮数**（2026-11-02）。
       *
       * 和 `emptyReplies` 分开：那个是"responder 一个字都没给"，这个是
       * "她给了字、明确说这轮别发"。两者在 QQ 上都表现为安静，靠这个数分账。
       * 被它压掉的那一轮**不进 `replies`**（确实没发）。
       */
      quietReplies: stats.quietReplies ?? 0,
      /**
       * **出站两个单调计数**（2026-10-11 加）：`sends` = 插件"决定要发"几次，
       * `actions` = 真交给 NapCat 几次。
       *
       * 为什么必须进快照：`stats.replies` **回答不了"发了几条"** ——
       * 它只在成功后加，所以"发失败"和"压根没打算发"是同一个数；
       * 而 2026-10-09 那次"QQ 上两条、会话里一条"的问题，第一个要问的就是
       * "到底发了几次"。两个数分开记，差值本身就有信息：
       *   `sends > actions` ⇒ 有一次连运输层都没走到；
       *   `actions > sends` ⇒ 有东西**绕过了 `#send`** 直接调传输层（那本身就要查）。
       *
       * ⚠️ **它仍会随热重载清零**（整个 `stats` 都在内存里）⇒ 它只回答"**当场**一眼看"。
       * **历史只有台账**（`<DSH_HOME>/media/qq-outbound.jsonl`，见 `outbound-ledger.mjs`）。
       */
      outbound: {
        sends: stats.outbound?.sends ?? 0,
        actions: stats.outbound?.actions ?? 0,
        /**
         * **台账自身的状态**（写了几行 / 写失败几次 / 是不是自己断开了）。
         *
         * ⚠️ 和 `stickerAudit` 那条同一条理由：`enabled:false`（关了/没配）
         * 与 `disabled:true`（连续写盘失败断开）在现象上都是"台账文件里没东西"
         * —— 而"没记"与"记不进去"的处置完全不同，所以两个字段都要在。
         * 没有这段，一个坏掉的台账和"真的什么都没发"长得一模一样。
         */
        ledger: outboundLedgerStats(gateway?.outboundLedger),
      },
    },
    proactive: {
      enabled: config?.proactive?.enabled === true,
      /**
       * **当前生效的裁量模式**（`heuristic` / `precheck` / `inTurn`，2026-10-13 加）。
       *
       * 为什么必须进快照：这三个模式**在日志里长得一样**（都是"判定跑了、分数够"），
       * 而"到底是哪个模式判的"决定了该去哪儿查。更要紧的是 `precheck` 会
       * **静默降级**（模型挂了/没配 ⇒ 当成"该说"，见 `judge-mode.mjs` 文件头），
       * 于是"我配了 precheck 但看起来和没配一样"需要一个当场能看的答案。
       * `pc_model` 是**解析后**的 provider/model（`precheck_model` 允许省略 provider）。
       */
      judgeMode: engine?.judgeMode ?? config?.proactive?.judge_mode ?? '',
      /**
       * **私聊单独那套裁量模式**（2026-11-02 加）。
       *
       * 空串 = 跟随 `judgeMode`。为什么必须进快照：`judge_mode_private` 是 toml
       * 里的行为配置，改了它**只有靠重载 + 看这个数**才知道读没读到 ——
       * 上一版快照里没有这一格，于是"私聊还带着 inTurn 的劝导"只能靠翻代码猜。
       */
      judgeModePrivate: gateway?.judgeModePrivate ?? config?.proactive?.judge_mode_private ?? '',
      precheck: engine?.precheckInfo ?? null,
      // 转录条数 = "有没有真的收到群消息"最直接的证据
      transcripts: mapSize(engine?.transcripts),
      // 每个会话的判定状态（发言计数、上次发言时间等），只取最近几个
      states: mapTail(engine?.states, 5),
      /**
       * **判定器（模式 2 `precheck`）的计数**（2026-10-28 加）。
       *
       * 与上面的 `states` **并列**、刻意不并进去：`states` 是"此刻的状态"
       * （攒了多少劲、门槛过没过），它是"累计干了多少活"。两者回答的问题不一样 ——
       * 用户问的正是后者（「判定器有在正常工作吗？通过率多少」），而在加这一段之前
       * **快照里一个字都没有**：只有 `journal` 那 20 条会滚掉的流水能看出跑过几次。
       *
       * 形状（`judge-stats.mjs` 的 `snapshot()`，这里只做白名单收口）：
       * ```
       * { mode, enabled, since, sessionCount,
       *   sessions: [[chatId, { calls, passed, declined, failed,
       *                         failedTimeout, failedError, failedUnparsed,
       *                         skipped, skippedBusy, skippedNoModel, other,
       *                         passRate, failRate, lastAt, lastMs, lastSource,
       *                         lastFailedAt, lastFailedReason }], ...],
       *   total: { …同上 + lastChatId } }
       * ```
       *
       * ⚠️ **口径**（读之前先看这两条，否则会误判）：
       * - `passRate = passed / (passed + declined)` —— **只算"答上来了"的那些**；
       *   超时 / 报错 / 格式不对虽然降级成"该说"，但**不算通过**（算 `failed`）；
       * - `total` 是**全部会话**的加总，与 `sessions` 里显示了几个无关。
       */
      judge: judgeSnapshot(gateway?.precheck, engine),
      // 已去重的消息 id 数（消息确实进过网关）
      seenIds: mapSize(engine?.seenIds) ?? setSize(engine?.seenIds),
      inFlight: mapSize(engine?.inFlight),
      /**
       * 判定日记尾部：**为什么没说**的流水。
       *
       * 计数只能说明"判定被叫过几次"，回答不了"为什么没冒泡"——闸门挡的、
       * 打分不够、发言失败，三者在计数上一模一样。这里把原因本身带出来。
       */
      journal: journalTail(engine?.journal, 12),
    },
    /**
     * **启动时灌历史的结果**（2026-10-13 加）。
     *
     * 为什么必须进快照：它整条路是**异步、失败静默**的（拉不到就当没有，
     * 见 `history-backfill.mjs`），所以"没灌进来"在日志里只有一行 `info` ——
     * 而**用户看得见的现象**是"小鲸鱼重启完像刚进群，接话接得驴唇不对马嘴"。
     * 没有这份结果，那个现象分不清是：
     *   ① NapCat 没连上（每个会话 `ok:false` + `error`）
     *   ② 这个会话压根不在白名单（`chats` 里没有它 / `enabled:false` + `reason`）
     *   ③ 白名单里有、也拉到了，但**转录条数还是 0**（那就是别处在清转录）
     * 三个答案在这里各不相同。`preview` 只留前 3 条正文，够看出"是谁在说什么时候的话"。
     */
    historyBackfill,
    /**
     * **动态心情的状态与当前生效的模型**（2026-10-14 加）。
     *
     * 为什么必须进快照：心情是**每条入站消息都可能触发一次 LLM 调用**的东西
     * （活跃群里实测 ≈1.7 次/分钟），而在加这一段之前它**完全不可观测** ——
     * 状态只在内存的 Map 里，快照里一个字都没有。于是两件最要紧的事都只能靠猜：
     *
     *   ① **它到底跑没跑、用的哪条路**（provider/model ⇒ 烧的是哪笔钱）；
     *   ② **现在是什么心情**。
     *
     * ⚠️ **`states:{}` 和 `states:null` 是两件事**，刻意分开：
     *   - `enabled:true` + `states:{}` ⇒ 接着的，只是**还没有任何会话更新过心情**
     *     （这本身就是信息：说明它一次都没被触发过）；
     *   - `enabled:false` ⇒ **压根没构造**（用户一键关掉止血），`states:null`。
     *   两者在日志里长得一样（都"什么都没发生"），在这里各不相同。
     */
    mood: moodSnapshotState(mood, moodConfig),
    /**
     * **「学来的记忆」（旧记忆库）的开关状态**（2026-10-16 加）。
     *
     * 为什么必须进快照：用户要求「老的那个停掉吧，我看了看全是噪声」，而这个开关
     * **关掉之后的现象就是"什么都没发生"** —— 不再学到新东西、prompt 里不再出现
     * 学来的条目。而"没关掉、但恰好没学到东西"与它**在日志里长得一模一样**
     * （都只是一片安静）。这个字段是"到底关没关"唯一的当场证据。
     *
     * ⚠️ **两个子字段缺一不可**（`enabled` = 配置说了什么，`learnerBuilt` = 接线真的做到没有）：
     *   - `enabled:false + learnerBuilt:false` ⇒ **关干净了**（要的就是这个）；
     *   - `enabled:false + learnerBuilt:true`  ⇒ 配置关了、**learner 却还在跑**
     *     （= 接线漏了，行为上照样在学）—— 只看一个布尔的话，这一档会被误判成"已停用"；
     *   - `enabled:true`  ⇒ 与改动前一致（旧记忆库还在跑）。
     *
     * ⚠️ 它**不回答**"静态知识库还注入吗" —— 那是另一条路（`knowledge.json`），
     * 本次刻意没做开关（用户明确说「那是知识库不是记忆，别砍」）。
     */
    learnedMemory: learnedMemory === null || typeof learnedMemory !== 'object'
      ? null
      : {
        enabled: learnedMemory.enabled === true,
        learnerBuilt: learnedMemory.learnerBuilt === true,
      },
    /**
     * **静态知识库注入的生效值 + 留痕**（2026-10-17，A+B 方案）。
     *
     * - `maxChars`：每轮注入的字数上限（A）。改造前每轮 490~1820 字。
     * - `privateAsSection`：私聊是否走 system prompt 的 section（B，不进历史、不累积）。
     * - `lastChars` / `lastMode`：**最近一次**实际注入的字符数与走向
     *   （`'prompt'` = 拼进用户消息 / `'section'` = 走 system section / `'none'` = 还没跑过）。
     *
     * ⚠️ 为什么四个都要有：`maxChars` 配了 800 但 `lastChars` 还是 1800
     * ⇒ 说明改动没接上；`privateAsSection:true` 但 `lastMode:'prompt'`
     * ⇒ 说明 B 没生效。只看一个数会漏掉这两档。
     */
    knowledgeInject: knowledgeInject === null || typeof knowledgeInject !== 'object'
      ? null
      : {
        maxChars: Number.isFinite(knowledgeInject.maxChars) ? knowledgeInject.maxChars : 0,
        privateAsSection: knowledgeInject.privateAsSection === true,
        lastChars: Number.isFinite(knowledgeInject.lastChars) ? knowledgeInject.lastChars : 0,
        lastMode: typeof knowledgeInject.lastMode === 'string' ? knowledgeInject.lastMode : 'none',
      },
    allow: {
      dmPolicy: config?.dmPolicy ?? '',
      groupPolicy: config?.groupPolicy ?? '',
      allowFrom: config?.allowFrom ?? [],
      groupAllowFrom: config?.groupAllowFrom ?? [],
    },
    /**
     * **图片描述器的状态**（2026-10-07 加）。
     *
     * 为什么必须进快照：有一条**只能靠实机回答**的问题 ——
     * 「小鲸鱼账号自己的图片缓存目录，到底会不会落图？」
     *
     * 离线证据是矛盾的：那个目录里确实有 57 个文件，但它们**停在 10-06 19:13**，
     * 而今天（10-07）的图**一张都没进**（用户账号的缓存里倒是有）。
     * 所以代码里两条路都留着（本地找 / 下载），并在这里留下计数：
     *
     * - `localOriginals` 一直在涨 ⇒ 本地这条路是通的；
     * - `localOriginals` 恒为 0、`downloaded` 在涨 ⇒ 这部署里"本地找"基本无用，
     *   得接受"每次都要下载"（或者去查 QQ 的懒下载/别的目录）。
     *
     * `dirs` 也一起记：路径是**按账号从配置拼出来的**，出问题时第一眼要看它拼成了什么
     * （而不是猜）。
     */
    imageDesc: imageDescStats(gateway),
    /**
     * **`QQ → 昵称` 表**（2026-10-14 加）。
     *
     * 为什么必须进快照：它的唯一后果是"`@某人` 渲染成 `@昵称` 还是 `@QQ号`"，
     * 而反过来（**没渲染出名字**）的三种原因在日志里长得一模一样
     * ——"没人喂它" / "喂了但学不进去" / "表坏了"。见 `nicknameStats` 的注释。
     */
    nicknames: nicknameStats(gateway?.nicknames),
    /**
     * **表情包库的计数**（2026-10-08 加）。
     *
     * 为什么必须进快照：整个"偷"是 **fire-and-forget** 的（不 await，怕拖慢回复），
     * 唯一的结果就是几个计数 + 磁盘上的文件。没有这段，出问题时能看到的只有
     * "群里发了表情包，库里什么都没有" —— 而那句话分不清以下四种情况：
     *
     *   ① 判据没认出来（`dedup/stored` 全 0、`nearMiss` 也不涨）
     *   ② 认出来了但取不到字节（`failed` 在涨 —— 本地没找到 + 下载也失败）
     *   ③ 认出来了、字节也有了，但格式认不出（`unrecognized`）或太大（`tooLarge`）
     *   ④ 索引/目录坏了（`index.degraded === true` / `enabled === false`）
     *   ⑤ **「认」把它挡下来了**（`rejected` = 审核闸判不安全；`auditFailed` = 没看成）
     *      —— 2026-10-08 接了「认」之后新增的一档：入库前要多过一道审核闸，
     *      所以"收到了却没入库"第一次有了**正当**原因，不看到这两个数就会误判成坏了。
     *
     * 五种在日志里长得一样（都只是"没偷到"），在这里各不相同。
     */
    stickers: stickerStats(stickerLibrary),
    now: new Date(now).toISOString(),
  };
}

/**
 * 表情包库的计数（取不到就 null —— 调试设施绝不拖垮主流程）。
 *
 * `uses` **总和**单独算一份：它是"发出去过几次"的全局依据，
 * 也顺带证明"使用计数"这条路真的在写（而不是一个恒为 0 的字段）。
 */
function stickerStats(library) {
  try {
    if (library === null || library === undefined || typeof library.stats !== 'function') return null;
    const s = library.stats() ?? {};
    const index = s.index ?? {};
    let usesTotal = 0;
    let tagged = 0;
    if (typeof library.all === 'function') {
      for (const entry of library.all()) {
        usesTotal += Number.isFinite(entry?.uses) ? Number(entry.uses) : 0;
        if (Array.isArray(entry?.tags) && entry.tags.length > 0) tagged += 1;
      }
    }
    return {
      // 判定/入库
      harvested: s.harvested ?? 0,
      stored: s.stored ?? 0,
      dedup: s.dedup ?? 0,
      // 判据只放过了"只有 emoji_package_id"这一档（`nearMissPackage`）。
      // ⚠️ 上一批那个 `nearMissAnimated` **已删**：位判据把那一类收进来了，
      //    留着它就是个恒为 0 的死字段。
      nearMiss: s.nearMiss ?? 0,
      nearMissPackage: s.nearMissPackage ?? 0,
      // 「认」接上之后的两档"没入库"：审核闸拒了 / 没看成（不可信）。
      // 这两个数与 `failed`（取不到字节）分开，才看得出是哪一环在挡。
      rejected: s.rejected ?? 0,
      auditFailed: s.auditFailed ?? 0,
      // 取字节 / 格式 / 体积
      failed: s.failed ?? 0,
      unrecognized: s.unrecognized ?? 0,
      tooLarge: s.tooLarge ?? 0,
      // 并发闸挡掉的批次数
      skipped: s.skipped ?? 0,
      // `emoji_id` 与内容 md5 是否一致（核对过的条目才能走零网络去重）
      idMatched: s.idMatched ?? 0,
      idMismatch: s.idMismatch ?? 0,
      pending: s.pending ?? 0,
      dir: typeof s.dir === 'string' ? s.dir : '',
      // 索引自身状态（size / degraded / enabled）+ 发出次数总和 / 已打标签条数
      index,
      usesTotal,
      tagged,
    };
  } catch {
    return null;
  }
}

/** 图片描述器的计数（取不到就 null —— 调试设施绝不拖垮主流程）。 */
function imageDescStats(gateway) {
  try {
    const describer = gateway?.imageDescriber;
    if (describer === null || describer === undefined || typeof describer.stats !== 'function') return null;
    const s = describer.stats() ?? {};
    return {
      // QQ 自己给的标签命中（零成本那条路）
      qqLabel: s.local ?? 0,
      // "动画表情"这类**类型**标签被挡下的次数（每次挡下都会改走视觉）
      animationLabels: s.animationLabels ?? 0,
      // 描述里检到"看不出来"的说法 → 整条丢弃的次数
      rejected: s.rejected ?? 0,
      // 本地原件命中 / 改为下载 —— **回答"Pic 目录会不会落图"的两个数**
      localOriginals: s.localOriginals ?? 0,
      downloaded: s.downloaded ?? 0,
      // 跨会话表：命中 / 写入 / 表自身状态（size、degraded、enabled）
      tableHits: s.tableHits ?? 0,
      tableWrites: s.tableWrites ?? 0,
      table: s.table ?? null,
      // 多帧 GIF 拼图次数（"动图真的被抽帧了"的证据）
      sheets: s.sheets ?? 0,
      // 「认」（一次调用出全部）的计数：调了几次 / 没看成 / 审核闸**收了几张、拦了几张** /
      // **按原因分开的拦截数**。`stickerCalls` 涨而 `stickerFailed` 不涨 ⇒ 这条路是通的；
      // `stickerRejected` 恒为 0 ⇒ 审核闸是个装饰（判据/阈值该看了）。
      stickerCalls: s.stickerCalls ?? 0,
      stickerFailed: s.stickerFailed ?? 0,
      stickerAccepted: s.stickerAccepted ?? 0,
      stickerRejected: s.stickerRejected ?? 0,
      stickerReasons: s.stickerReasons ?? null,
      // 审核闸**当前生效的参数**（阈值 / 提示词是否从 toml 读到 / 走的哪个 provider）——
      // 这是"toml 改了到底生效没有"唯一的直接证据（不放到快照里就只能翻日志）。
      stickerGate: s.stickerGate ?? null,
      // **显存门控**（2026-10-09）：开关 / 阈值 / 本地是哪条 / 最近一次为什么这么选 / 各分支计数。
      // ⚠️ 不放进快照的话，"为什么这一条走了云"只能去翻日志（而日志是逐条滚动的，看不出比例）。
      //    用户要的正是"能自己调阈值"—— 调之前得先看得见它现在按什么在选。
      visionGate: s.visionGate ?? null,
      // **审核留样**（2026-10-09）：写了几张 / 淘汰了几张 / 目录在哪 / 是不是自己断开了。
      // ⚠️ `enabled:false`（关了或没配）与 `disabled:true`（连续写盘失败断开）在现象上
      //    都是"目录里没东西"，所以两个字段都要在，别合成一个布尔。
      stickerAudit: s.stickerAudit ?? null,
      vision: s.vision ?? 0,
      failed: s.failed ?? 0,
      cache: s.cache ?? 0,
      dirs: Array.isArray(s.dirs) ? s.dirs : [],
    };
  } catch {
    return null;
  }
}

/** 出站台账的计数（取不到就 null —— 调试设施绝不拖垮主流程）。 */
function outboundLedgerStats(ledger) {
  try {
    if (ledger === null || ledger === undefined || typeof ledger.stats !== 'function') return null;
    const s = ledger.stats() ?? {};
    return {
      enabled: s.enabled === true,
      disabled: s.disabled === true,
      /**
       * **挂钩到底装上了没有**。
       *
       * ⚠️ 它和 `enabled` 必须分开看：`enabled:true + hooked:false` 意思是
       * "台账开着，但**传输层那一层压根没接上**" ⇒ 台账里**永远只有 `gw-send`**，
       * 判读表的三条**一条都判不了**（少了"真的交给 NapCat 了吗"那一半）。
       * 而光看 `wrote:0` 分不出这个和"确实没发过消息"。
       */
      hooked: s.hooked === true,
      wrote: s.wrote ?? 0,
      failed: s.failed ?? 0,
      failStreak: s.failStreak ?? 0,
      trims: s.trims ?? 0,
      trimmedLines: s.trimmedLines ?? 0,
      lines: s.lines ?? 0,
      maxLines: s.maxLines ?? 0,
      file: typeof s.file === 'string' ? s.file : '',
      // 只留**最近那条的形状**（`at`/`layer`/`ok`），不留它的 `sha256`：
      // 这是个"计数与状态"快照，哈希本身没有任何诊断价值（要哈希去读台账）。
      last: s.last === null || typeof s.last !== 'object' ? null : {
        at: s.last.at ?? '',
        layer: s.last.layer ?? '',
        ok: s.last.ok === true,
      },
    };
  } catch {
    return null;
  }
}

/**
 * **`QQ → 昵称` 表**的计数（取不到就 null —— 调试设施绝不拖垮主流程）。
 *
 * 为什么必须进快照：这张表只有一个外部可见的后果 —— **`@某人` 渲染成 `@昵称` 还是 `@QQ号`**。
 * 而"没查到名字"有三种完全不同的原因，在日志里长得一样：
 *
 *   ① `learned === 0`      ⇒ **压根没人在喂它**（接线断了 / 表是 null）；
 *   ② `learned` 在涨、`size` 不涨、`misses` 在涨 ⇒ 学到了但**学不进去**
 *      （`sender` 里没名字？或者查的群号对不上 `cards` 那一层）；
 *   ③ `degraded:true` / `disabled:true` ⇒ 表本身坏了（读不出来 / 连续写盘失败断开）。
 *
 * 另外 `file` 一定要在：路径是从配置推的，出问题时第一眼要看它推成了什么（不是猜）。
 */
function nicknameStats(table) {
  try {
    if (table === null || table === undefined || typeof table.stats !== 'function') return null;
    const s = table.stats() ?? {};
    return {
      enabled: s.enabled === true,
      disabled: s.disabled === true,
      degraded: s.degraded === true,
      loaded: s.loaded ?? 0,
      /** 被喂了几次（每条入站消息 + 灌历史里的每一条）。 */
      learned: s.learned ?? 0,
      /** 真的新增/改写了名字的次数（= 落盘的次数上界）。 */
      updated: s.updated ?? 0,
      /** 查表命中/未命中（`@` 段每渲染一次算一次）。`misses` 涨 = 还有 `@QQ号`。 */
      hits: s.hits ?? 0,
      misses: s.misses ?? 0,
      size: s.size ?? 0,
      cardEntries: s.cardEntries ?? 0,
      groups: s.groups ?? 0,
      maxPeople: s.maxPeople ?? 0,
      maxCards: s.maxCards ?? 0,
      maxGroups: s.maxGroups ?? 0,
      writes: s.writes ?? 0,
      failed: s.failed ?? 0,
      failStreak: s.failStreak ?? 0,
      prunes: s.prunes ?? 0,
      droppedPeople: s.droppedPeople ?? 0,
      droppedCards: s.droppedCards ?? 0,
      droppedGroups: s.droppedGroups ?? 0,
      file: typeof s.file === 'string' ? s.file : '',
      /** ⚠️ 只留"最近学了谁"的**形状**（qq/名字/群），不留别的（这是个计数快照）。 */
      last: s.last === null || typeof s.last !== 'object' ? null : {
        qq: s.last.qq ?? '',
        nickname: s.last.nickname ?? '',
        card: s.last.card ?? '',
        groupId: s.last.groupId ?? '',
      },
    };
  } catch {
    return null;
  }
}

/** Map/Set 的大小，取不到就 undefined。 */
function mapSize(m) {
  try {
    if (m instanceof Map || m instanceof Set) return m.size;
    if (m !== null && typeof m === 'object' && typeof m.size === 'number') return m.size;
    return undefined;
  } catch {
    return undefined;
  }
}

function setSize(s) {
  return mapSize(s);
}

/** Map 尾部若干项的浅摘要（避免落盘过多内容）。 */
function mapTail(m, n) {
  try {
    if (!(m instanceof Map)) return undefined;
    const entries = [...m.entries()].slice(-n);
    return entries.map(([k, v]) => [String(k), summarize(v)]);
  } catch {
    return undefined;
  }
}

/**
 * 判定器计数（`judge-mode.mjs` 的 `createPrecheck()` 产物，2026-10-28）。
 *
 * ## 为什么这里只做"收口"、格式由 `judge-stats.mjs` 决定
 *
 * 计数本身在热路径上累加，形状由造它的模块钉死（每个字段都在那里写了含义）；
 * 这个函数只负责三件事：
 *   1. **调用 `.stats()`** —— 每次调用都现取，绝不缓存（数字会变）；
 *   2. 补上 `mode`（`engine.judgeMode`，计数模块自己不知道模式）；
 *   3. 用 `summarize()` 过一遍 —— 只让标量进快照，防以后有人往计数里塞对象。
 *
 * ⚠️ **无论有没有判定器，都返回固定形状**（`enabled:false` + 全零）：
 * 判决器不存在（模式 1/3、或没配 llm）与"存在但一次没跑"在现象上是两回事，
 * 而"这个键在不在"不该成为读快照时的第一个问题。
 *
 * @param {unknown} precheck `gateway.precheck`
 * @param {unknown} engine `ProactiveEngine`（只读它的 `judgeMode`）
 * @returns {{mode: string, enabled: boolean, since: string, sessionCount: number,
 *   sessions: Array<[string, object]>, total: object}}
 */
function judgeSnapshot(precheck, engine) {
  const mode = engine !== null && typeof engine === 'object' && typeof engine.judgeMode === 'string'
    ? engine.judgeMode
    : '';
  /** 取不到时的固定形状（`summarize({})` = `{}`，所以这里手写全零，别让读的人看见空对象）。 */
  const empty = () => ({
    calls: 0,
    passed: 0,
    declined: 0,
    failed: 0,
    failedTimeout: 0,
    failedError: 0,
    failedUnparsed: 0,
    skipped: 0,
    skippedBusy: 0,
    skippedNoModel: 0,
    other: 0,
    passRate: null,
    failRate: null,
    lastAt: '',
    lastMs: 0,
    lastSource: '',
    lastFailedAt: '',
    lastFailedReason: '',
  });
  try {
    const stats = precheck !== null && precheck !== undefined && typeof precheck.stats === 'function'
      ? precheck.stats()
      : null;
    const node = stats !== null && typeof stats === 'object' ? stats : {};
    const rows = Array.isArray(node.sessions) ? node.sessions : [];
    return {
      mode,
      enabled: node.enabled === true,
      since: typeof node.since === 'string' ? node.since : '',
      sessionCount: Number.isFinite(node.sessionCount) ? node.sessionCount : rows.length,
      // 逐条收口：只留 `[chatId, 标量摘要]`，最多 12 个会话（比 `states` 的 5 宽一点：
      // 这是计数，条数不是问题；但也不能让快照跟着会话数无限长大）。
      sessions: rows.slice(0, 12).map((pair) => {
        const key = Array.isArray(pair) ? String(pair[0] ?? '') : '';
        const row = Array.isArray(pair) && pair[1] !== null && typeof pair[1] === 'object' ? pair[1] : {};
        return [key, judgeCounts(row)];
      }),
      total: judgeCounts(node.total !== null && typeof node.total === 'object' ? node.total : empty()),
    };
  } catch {
    // 快照是诊断设施：它坏了不能拖垮主流程（2026-10-14 那次崩了三次的教训）。
    return { mode, enabled: false, since: '', sessionCount: 0, sessions: [], total: empty() };
  }
}

/**
 * 判定器计数的收口（只留标量）—— 和 `summarize()` **只差一条**：`null` 保留。
 *
 * 为什么不能直接用 `summarize()`：它把 `null` 当"非标量"丢掉，而这里
 * `passRate: null` 是**有意义的值**（"还没有任何一次判定答上来"）。
 * 丢掉之后读的人看到的是"这个键不存在"，分不清是"没算"还是"没跑过"。
 *
 * @param {object} row
 * @returns {object}
 */
function judgeCounts(row) {
  const out = {};
  for (const [k, val] of Object.entries(row)) {
    if (val === null || typeof val === 'number' || typeof val === 'boolean') {
      out[k] = val;
      continue;
    }
    if (typeof val === 'string' && val.length <= MAX_SUMMARY_STRING) out[k] = val;
  }
  return out;
}

/** 摘要里允许保留的最长字符串；更长的**整个丢掉**而不是截断。 */
const MAX_SUMMARY_STRING = 120;

/**
 * 把一个状态对象压成小摘要：只留短标量。
 *
 * 比阈值长的字符串**直接丢弃**，不截断——这个快照的用途是排查计数与状态，
 * 不是搬运内容；截断过的正文留在盘上既没用又是无谓的落盘。
 */
function summarize(v) {
  if (v === null || typeof v !== 'object') return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'number' || typeof val === 'boolean') {
      out[k] = val;
      continue;
    }
    if (typeof val === 'string' && val.length <= MAX_SUMMARY_STRING) out[k] = val;
  }
  return out;
}

/**
 * 日记尾部若干条，逐条压成小摘要。
 *
 * 日记条目是**扁平的**（引擎已经用 `flattenDetail` 摊平），所以直接复用
 * `summarize`：长错误串会被丢掉，剩下原因与分数。
 */
function journalTail(journal, n) {
  try {
    if (!Array.isArray(journal)) return undefined;
    return journal.slice(-n).map((entry) => summarize(entry));
  } catch {
    return undefined;
  }
}

/** 自查时最多扫多少个文件（防止插件目录里被塞进庞大的东西）。 */
const STALE_SCAN_MAX_FILES = 200;
/** 自查时的最大递归深度。 */
const STALE_SCAN_MAX_DEPTH = 4;

/**
 * 源码新鲜度自查：插件目录里有没有文件的 mtime **晚于**模块加载时刻。
 *
 * 返回 `null` 表示"没传参数 / 读不到"（快照里就是 `null`，不假装一切正常）。
 *
 * @param {{dir?: string, since?: number}} [watch]
 * @returns {{stale: boolean, newest: string, newestFile: string, since: string}|null}
 */
export function detectStaleCode({ dir, since } = {}) {
  const root = String(dir ?? '');
  const loadedAt = Number(since);
  if (root === '' || !Number.isFinite(loadedAt)) return null;

  let newest = 0;
  let newestFile = '';
  let seen = 0;

  const visit = (target, depth) => {
    if (seen >= STALE_SCAN_MAX_FILES || depth > STALE_SCAN_MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= STALE_SCAN_MAX_FILES) return;
      // node_modules 里是别人的代码，与"我改的东西有没有生效"无关。
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      seen += 1;
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (mtime > newest) {
        newest = mtime;
        newestFile = path.relative(root, full).replace(/\\/g, '/');
      }
    }
  };

  try {
    visit(root, 0);
  } catch {
    return null;
  }
  if (newest === 0) return null;

  return {
    stale: newest > loadedAt,
    newest: new Date(newest).toISOString(),
    newestFile,
    since: new Date(loadedAt).toISOString(),
  };
}
