/**
 * 主动发言决策引擎——纯逻辑，零 DSH 耦合。
 *
 * ⚠️ 唯一的 import 是 `src/dsh/heuristic-gauge.mjs` 的 `looksLikeQuestion()`（2026-10-12 加的）：
 * 判定「她最后一条是不是问句/请求」要用它，而那个函数已经在那儿了 ——
 * 与其抄一份判断（迟早漂移），不如 import。那个模块**零依赖、纯函数、不 import 本文件**，
 * 所以不构成环；引擎仍然可以脱离 DSH 单独跑（测试就是这么跑的）。
 *
 * 它负责回答一句话：「群里正在聊的这个，我要不要冒个泡？」
 * 以及更重要的：「我今天已经说过几次了，还能不能再说？」
 *
 * 设计原则
 * - 引擎本身**不做模型调用**。判定通过注入的 `Gauge` 完成，测试时注入假的。
 * - 引擎本身**不碰网络**。发消息通过注入的 `Speak` 完成。
 * - 所有状态都在内存里，靠 `limits` 兜住上界，不会无限增长。
 * - 默认保守：任何一处不确定都倾向于「不说话」。群聊刷屏的代价远大于漏一次。
 *
 * @module qq-proactive/engine
 */

import { looksLikeQuestion } from '../dsh/heuristic-gauge.mjs';

/** 会话类型：私聊或群聊。 */
export const PRIVATE = 'private';
export const GROUP = 'group';

/** 毫秒常量，避免魔法数字散落。 */
const MINUTE = 60_000;

/**
 * @typedef {object} InboundMessage
 * @property {string} chatId      会话标识，`private:<QQ>` 或 `group:<群号>`
 * @property {'private'|'group'} kind
 * @property {string} userId      发送者 QQ
 * @property {string} nickname    发送者昵称/群名片
 * @property {string} text        纯文本正文（已剥掉 @ 段等非文本段）
 * @property {number} at          事件时间戳（毫秒）
 * @property {boolean} mentioned  本条是否 @ 了机器人（或回复了机器人）
 * @property {number} [messageId] 消息 ID，用于去重
 */

/**
 * @typedef {object} TriggerConfig
 * @property {boolean} enabled            总开关
 * @property {number} minIntervalMs       同一会话两次主动发言的最小间隔
 * @property {number} maxPerHour          同一会话每滚动小时的主动发言上限
 * @property {number} cooldownAfterBotMs  机器人刚说完话后的静默期（避免自问自答）
 * @property {number} afterUserMsgCount   累计多少条人类消息后才允许第一次冒泡
 * @property {number} focusWindowMs       专注窗口：机器人发言后这段时间内算「聊上了」
 * @property {number} focusSpeakThreshold 专注度到多少就触发「接话」（0-1）
 * @property {number} focusMaxSpeaksPerWindow 专注窗口里她自己最多算几条；说够这么多条就算「疲惫」，
 *                                          `#focusValue` 的时间票不再给（MaiBot 的 `_message_threshold`）
 * @property {number} focusCooldownMs     聊上了之后的冷却：几秒内别人接话就能续（比冷启动的 20s 短得多）
 * @property {number} focusMinIntervalMs  聊上了之后两次发言的最小间隔（用户：几秒一条才正常）
 * @property {number} [quietHoursStart]   **已废弃**（闸门 2026-10-07 删除，不再被读取）
 * @property {number|null} [quietHoursEnd] **已废弃**
 * @property {number} [utcOffsetMinutes]  **已废弃**
 * @property {number} [burstWindowMs]     **已废弃**
 * @property {number} [burstMinMessages]  **已废弃**
 */

/**
 * 生产环境的保守默认值。
 *
 * ## ⚠️ 2026-10-07 删掉了两道闸门（用户拍板的判定层改造）
 *
 * - **`quiet-hours`** —— 本部署早就把它显式关成 `null` 了（用户是"夜越深越清醒"的人），
 *   代码里留着一套只在默认值下才生效的机关，反而是排查时的干扰项。
 * - **`burst-too-small`** —— 它把"顺口接一句"硬挡了：实测用户在测试群发「小鲸鱼在不在」，
 *   闸门回 `burst-too-small(1/3)`（群里只有一个人说话，永远攒不够条数）。
 *
 * 现在"这话题值不值得接"完全由打分层（`heuristic-gauge`）回答，闸门只管限流。
 *
 * ### 为什么下面还留着那几个键
 *
 * `quietHours*` / `burst*` 五个键**已不再被任何代码读取**，但**刻意保留在配置形状里**：
 * 本部署的 `qq-gugu.toml` 与 `cordis.patch.yml` 里都还写着它们，而本次改动的约定是
 * **不碰那两个文件**（除了 toml 里的一行 `focusWindowMs`）。删掉形状只会让同一件事
 * 换个地方不一致。**它们不会报错，也不会生效** —— 要清就等下一批连配置文件一起清。
 *
 * @returns {TriggerConfig} 生产环境的保守默认值。
 */
export function defaultTriggerConfig() {
  return {
    enabled: true,
    minIntervalMs: 90_000,
    maxPerHour: 6,
    cooldownAfterBotMs: 20_000,
    afterUserMsgCount: 3,
    /** @deprecated 静默时段闸门已删（2026-10-07），写了不生效。 */
    quietHoursStart: 0,
    /** @deprecated 同上。 */
    quietHoursEnd: 7,
    /** @deprecated 同上。 */
    utcOffsetMinutes: 480, // UTC+8
    /** @deprecated 突发门槛闸门已删（2026-10-07），写了不生效。 */
    burstWindowMs: 5 * MINUTE,
    /** @deprecated 同上。 */
    burstMinMessages: 4,
    focusWindowMs: 30_000,
    focusSpeakThreshold: 0.5,
    /**
     * 专注窗口里她自己最多算几条（默认 3）。
     *
     * 对应 MaiBot 的 `_message_threshold`（在专注里发够 N 条 ⇒ 退出专注）。
     * **别定得太小**：她问一句、别人答一句、她再补一句是正常的连续对话，不该被砍 ——
     * M=3 时最多连着 3 条，第 4 条开始必须靠打分（2026-10-12）。
     */
    focusMaxSpeaksPerWindow: 3,
    focusCooldownMs: 3_000,
    focusMinIntervalMs: 3_000,
    /**
     * 「攒劲儿」步长：**每次"判定了但她没说"之后，下一条被判定的消息多拿多少分**。
     *
     * ## 它治的是什么病（2026-10-14 诊断的"结构性反馈锁"）
     *
     * `presence`（存在感）是唯一能把"非被点名"消息推过 50 的项，而它**只有在小鲸鱼
     * 自己刚说过话时才非零** ⇒ `她没说过话 ⇒ presence=0 ⇒ 分不够 ⇒ 不说话 ⇒ selfCount 继续 0`
     * ⇒ **她只在已经在说话的时候才会说话**（用力群那 12 小时里 23 条消息一条都没到 30 分）。
     * 本项给这条锁加一个**自我复位**的出口：一直没说 ⇒ 分越攒越高 ⇒ 最终必然过线 ⇒
     * 她开口 ⇒ 计数归零 ⇒ 机制重新开始攒。**它保证的是一个最低发言频率。**
     *
     * ## 累加，不是"下一条平移"（⚠️ 与设计账本的原始写法有一处分歧）
     *
     * 账本 §三 写的是 `decline_bonus = 3  # 判「不说」后，**下一条**消息补多少基础分`
     * —— 那是**单次平移**：每条都否决就等于恒定 +3，**治不了死锁**（分不够就是不够）。
     * 用户 2026-10-14 的原话要的是**累积**：
     * > 「**给一个发言趋势，启发式否决掉多少次发言之后加分**？」
     * ⇒ 这里按**累积**实现：`加分 = min(cap, 计数 × step)`。
     * （用户同时否掉了"未开口时加一个基础分"那条路，理由是"基础分只是平移分布、
     *  不自我复位，而且和降阈值大面积重叠"—— 累积式恰好不落在那个批评里。）
     *
     * ## 不变量（改 cap 之前先读这条）
     *
     * **只有 `cap >= threshold`（默认 50）时"最终必然开口"才成立。**
     * 因为内容项触到地板时上界是 `contentFit(−30) + legacy(≤23) + repetition(≤42) < 50`
     * ⇒ 光靠分项永远到不了。cap 砍到 50 以下，这个机制就退化成"温和抬分"，
     * **锁没被打破**。`declineBonus()` 在运行时会把这条违反打一条 warn（不抛）。
     *
     * ## 为什么放在 `[proactive]` 而不是 `[gauge]`
     *
     * ① 画布与设计账本（`shared\2026-10-06-小鲸鱼判定层改造-设计账本-session-00000000.md` §三）
     * 都把它写在 `[proactive]` 段（`CONFIG_SHAPE.proactive` 里本来就有这个键的占位）；
     * ② 它**不是打分权重**，是"闸门之后、以跨消息历史为输入"的一层时序状态 ——
     * 和 `judge_mode` 同一个性质（那个也是因此放在 `proactive`）；
     * ③ `CONFIG_SHAPE.gauge` 会**覆盖** `defaultGaugeConfig()`（历史上写错过两次 threshold），
     * 不往那一层再塞新东西。
     */
    decline_bonus: 6,
    /**
     * 攒劲儿的**封顶**（分）。
     *
     * 见 `decline_bonus` 的"不变量"：**必须 ≥ 判定阈值（默认 50）**，否则
     * "最终必然开口"不成立。默认 60 留了 10 分余量（内容项触地板时约 −30+legacy）。
     */
    decline_bonus_cap: 60,
    /**
     * 计数的**限流**：距上次计数**至少**这么多毫秒才 +1。
     *
     * ## 为什么必须有这一条
     *
     * 计数挂在"每一次判定说了不说"上。群里刷屏（或一个人连发 20 条）时，
     * 若"每条 +1"⇒ 计数瞬间涨到 cap ⇒ **她一被刷屏就开口** ——
     * 那等于把"防刷屏"反过来做成了"刷屏触发器"。
     *
     * ## 为什么取 30 秒（我的判断，标定脚本扫过 0 / 30s / 60s / 120s）
     *
     * 它和闸门的 `minIntervalMs`（本部署 2026-10-14 从 90s 改成 **20s**）**不是同一件事**：
     *   · `minIntervalMs` 管"两次**发言**之间隔多久"（看 `lastSpeakAt`）；
     *   · 这一条管"两次**计数**之间隔多久"（看 `lastDeclineAt`）——**她没发言时它照样在走**，
     *     这正是死锁需要的那条"时间也在推进"的线。
     *
     * 30 秒 ≈ 真实群消息平均间隔的量级（用力群 825 条 / 12 天 ≈ 每条几十秒）：
     * 正常的"一人一句"几乎每条都算一次；连发刷屏只算第一次 ⇒ 刷屏拿不到额外奖励。
     * 标定表见 `_qq-judge/DECLINE-BONUS.md`。
     */
    decline_bonus_min_gap_ms: 30_000,
  };
}

/**
 * 单会话转录缓冲。有界环形结构：条数封顶 + 时间窗裁剪，且只保留纯文本。
 *
 * 群聊里最贵的是上下文，所以这里刻意只记「谁说了什么」，把图片/语音压成占位符，
 * 让上层模型看到的是紧凑的对话而不是一堆媒体描述。
 */
export class Transcript {
  /**
   * @param {object} [options]
   * @param {number} [options.maxMessages] 最多保留多少条
   */
  constructor({ maxMessages = 60 } = {}) {
    this.maxMessages = maxMessages;
    /** @type {InboundMessage[]} 按时间升序 */
    this.entries = [];
    /**
     * 被 `#trim()` 挤出去的消息（M1，2026-11-04）。
     * 回想压缩靠它拿原料——没有它，超窗内容就真的没了。
     * 只留最近 200 条，防止长时间没人消费时无限涨。
     */
    this.dropped = [];
  }

  /**
   * 取走被挤出去的消息（取走即清空）。
   * @returns {InboundMessage[]}
   */
  takeDropped() {
    if (this.dropped.length === 0) return [];
    const out = this.dropped;
    this.dropped = [];
    return out;
  }

  /**
   * 追加一条消息并裁剪。
   * @param {InboundMessage} message
   * @returns {boolean} 是否被接受（时间戳倒退的乱序消息会被丢弃）
   */
  push(message) {
    const last = this.entries[this.entries.length - 1];
    if (last !== undefined && message.at < last.at) return false;
    this.entries.push(message);
    this.#trim();
    return true;
  }

  /**
   * 裁剪超量条目。
   *
   * ⚠️ **只按条数裁，不再按时间裁** —— 这里原来还有一道
   * `cutoff = now - 30 分钟` 的过期（`maxAgeMs`，2026-10-13 删除）。
   *
   * 为什么必须删（用户 2026-10-13 的要求）：**「只要进 llm 了就塞 20 条前文，
   * 不管是多久的」**。而时间窗和这句话是**直接对着干**的 —— 群里安静 31 分钟之后，
   * 那 30 分钟的窗口把前文**整段清空**，于是"最近 20 条"渲染出来只剩 1~2 条。
   *
   * 实测现场（小鲸鱼群 `30000011`，见 `_qq-judge/IMAGE-DESC-BUG.md`）：
   * 会话有 185 轮，而 00:49:03 那一轮的环境轮提示词**只有 2 行** ——
   * 不是 agent 被重建、也不是 `render(20)` 被别处截断，就是这道时间窗
   * （那两条是窗口内仅剩的消息）。
   *
   * 代价与上界：`maxMessages`(60) 仍是硬上界，所以内存不随会话时长增长；
   * 只是"安静很久"之后提示词里会出现**时间上很久以前**的 20 条 —— 那正是用户要的。
   */
  #trim() {
    while (this.entries.length > this.maxMessages) {
      const dropped = this.entries.shift();
      if (dropped === undefined) break;
      this.dropped.push(dropped);
      if (this.dropped.length > 200) this.dropped.shift();
    }
  }

  /**
   * **灌历史**（启动时从 NapCat 拉回来的最近若干条）。
   *
   * ## 为什么需要它
   *
   * 转录是**纯内存**的，插件一重载/重启就空。用户 2026-10-13 的要求是
   * 「只要进 llm 了就塞 20 条前文，**不管是多久的**」—— 这一条在
   * "同一个进程里跨时间"成立，**跨重启不成立**（NapCat 那边其实一条不少，
   * 见 `_qq-judge/HISTORY-BACKFILL.md`：关机 8 小时期间的 14 条全都拉得到）。
   *
   * ## 与 {@link push} 的区别（这三条就是它存在的全部理由）
   *
   * 1. **不判"时间戳倒退"**：历史是**批量**来的，`push` 那条"比上一条旧就丢"
   *    在批量语义下会静默吃掉乱序的条目。这里改成**先排序、再逐条取，
   *    排不回去的（时间戳缺失/为 0）才丢**。
   * 2. **不裁剪已有个数**：`#trim()` 是"新消息挤掉旧的"，而灌历史时我们**要**这 20 条。
   *    条数上界按 `hardCap` 兜底（缺省 = `maxMessages`），所以内存上界不变。
   * 3. **按 `messageId` 去重（后到的赢）**：NapCat 的窗口里可能同时有同一条消息的
   *    两个副本（重连补发实测见过），留着就会在提示词里出现两遍。
   *
   * ⚠️ **这条路【不判定】** —— 它只写内存，绝不碰 `decide` / `#gate`。
   *    见 `ChatState.restoreContext` 的说明：灌进来的旧消息**不许**引发一条回复。
   *
   * @param {InboundMessage[]} messages 要灌的条目（会被排序，不改原数组）
   * @param {object} [options]
   * @param {number} [options.hardCap] 灌完最多留多少条（缺省 `maxMessages`）
   * @returns {number} 灌进去几条（**裁剪之前**的条数，给日志/快照看；转录本身仍受 `maxMessages` 约束）
   */
  restore(messages, { hardCap = this.maxMessages } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    // 1) 时间戳缺失/为 0 的丢掉：`renderEntries` 要靠 `at` 出 `[HH:MM]`，
    //    没有时间的条目渲染出来是个没有时刻的孤行（而"多久以前的"正是这段的意义）。
    const ordered = messages.filter((m) => m !== null && typeof m === 'object' && Number.isFinite(m.at) && m.at > 0);
    if (ordered.length === 0) return 0;
    // 2) 排序：**同一时刻保持原顺序**（`Array#sort` 在 V8 上稳定）。
    ordered.sort((a, b) => a.at - b.at);
    // 3) 按 id 去重，后到的赢（同一条消息的更新副本应当覆盖旧的）。
    const byId = new Map();
    const noId = [];
    for (const m of ordered) {
      if (typeof m.messageId === 'number' && Number.isFinite(m.messageId)) byId.set(m.messageId, m);
      else noId.push(m); // 没有 id 的只能靠顺序，无法去重
    }
    const deduped = [...byId.values(), ...noId].sort((a, b) => a.at - b.at);
    // 4) 取最近 hardCap 条（`hardCap` 非法时退回 `this.maxMessages`）。
    const cap = Number.isFinite(hardCap) && hardCap > 0 ? Math.floor(hardCap) : this.maxMessages;
    const accepted = deduped.slice(-cap);
    for (const message of accepted) this.entries.push(message);
    this.#trim();
    return accepted.length;
  }

  /** @returns {InboundMessage[]} 当前快照（副本）。 */
  snapshot() {
    return this.entries.slice();
  }

  /** 清空（例如 /new 之后）。 */
  clear() {
    this.entries.length = 0;
  }

  /**
   * 紧凑渲染成给判定用的文本，一行一条。
   *
   * 行首时间戳**不是当天就带日期**（`10-07 23:52` 这种，见 {@link formatStamp}）——
   * 灌历史之后转录里可能全是几天前的消息，而提示词写着「群里刚在聊」。
   *
   * @param {number} [limit] 只取最近多少条
   * @param {ImageTextLookup|null} [imageText] **图片描述表**（可空）。
   *   给了就把正文里的 `[图片]` 占位符换成 `[图片: 描述]`（见 {@link renderEntries}）。
   * @param {object} [options]
   * @param {number} [options.now] "现在"（毫秒），用于判"当天"。缺省 `Date.now()`
   * @param {number} [options.utcOffsetMinutes] 时区偏移，缺省 480（UTC+8）
   * @returns {string}
   */
  render(limit = 20, imageText = null, options = {}) {
    return renderEntries(this.entries.slice(-limit), imageText, options);
  }

  /**
   * 渲染**除某一条之外**的最近 N 条。
   *
   * 给「被 @ 那一轮」用（2026-10-07 账本 §十）：那一条会被单独标注成
   * 【刚 @ 你的那条】，所以不能再以"先前聊天"的身份出现第二次。
   *
   * 按**对象引用**排除：引擎 push 进转录的就是同一个 `message` 对象
   * （`decide()` 里 `transcript.push(message)`）。
   *
   * @param {InboundMessage} message 要从转录里剔掉的那条
   * @param {number} [limit] 只取最近多少条
   * @param {ImageTextLookup|null} [imageText] 图片描述表（同 {@link Transcript#render}）
   * @param {object} [options] 同 {@link Transcript#render}（`now` / `utcOffsetMinutes`）
   * @returns {string}
   */
  renderExcept(message, limit = 20, imageText = null, options = {}) {
    return renderEntries(this.entries.filter((m) => m !== message).slice(-limit), imageText, options);
  }
}

/**
 * 正文里图片占位符的形态。
 *
 * 认这些（`protocol.mjs` 的 `SEGMENT_PLACEHOLDERS.image` 产出裸 `[图片]`，
 * `rich.mjs` 的 `imageLine` 产出带序号/大小/源格式的变体）：
 *
 * ```
 * [图片]  [图片1]  [图片 745KB]  [图片1 源 gif 745KB]
 * ```
 *
 * **不吃**已经带描述的 `[图片: …]` / `[图片1: …]` —— 它们没有 `]` 紧跟在
 * 序号/元信息之后（中间是 `: `），所以下面的正则天然跳过它们。
 * 这条很要紧：转录里**已经**替换过的行不该被二次替换。
 */
const IMAGE_PLACEHOLDER_RE = /\[图片\s*\d*[^\]:]*\]/g;

/**
 * 一条消息的图片描述表。
 *
 * 为什么按**消息对象**而不是按 url：转录里的图片信息**只剩正文里的 `[图片]`
 * 占位符**（`engine.mjs` 从头到尾只存 `m.text`），所以注入只能发生在
 * "渲染某一条的正文"这一刻 —— 键自然是"哪一条"。
 *
 * ⚠️ 这正是环境轮"永远没有描述"的根因：`[图片]` 是**转录里唯一**的图片形态，
 * 而描述原来只渲染进**当前这一条**的正文（`gateway.mjs:589/591` → `routing.mjs:373`），
 * 转录那一路（`gateway.mjs:619`）根本不看它。
 *
 * @typedef {(message: InboundMessage) => string[]|null} ImageTextLookup
 *   返回该条消息**按出现顺序**的描述数组；第 i 项对应第 i 个 `[图片` 占位符。
 *   空串 = 这一张没描述（保留原占位符）。返回 `null`/`[]` = 整条没有可注入的东西。
 */

/**
 * 转录条目 → 一行一条的紧凑文本。
 *
 * `render` / `renderExcept` 共用它：两处各写一份格式的话，迟早会漂移
 * （"先前聊天"和"刚 @ 你的那条"看起来就会不像同一份转录）。
 *
 * **导出**（2026-11-02）是因为网关要渲染**单条**的被引用消息（引用原文那段），
 * 而"一条消息长什么样"只能有一个来源 —— 在网关里再写一份 `[时间戳 昵称(QQ): 正文]`
 * 就是第二个来源，漂移时表现是"引用的原文和转录里的同一条长得不一样"。
 *
 * @param {InboundMessage[]} entries
 * @param {ImageTextLookup|null} [imageText]
 *   **正文覆盖通道**（2026-10-13 加）：给了就把每条正文里的 `[图片]`
 *   换成 `[图片: 描述]`。描述由调用方（网关）异步算好 —— 引擎保持**纯同步**，
 *   和 `renderRichText` 与 `imageText` 那条分工一样。
 * @param {object} [options]
 * @param {number} [options.now] **"现在"**（毫秒），决定哪条算"当天"（见 {@link formatStamp}）。
 *   缺省 `Date.now()` —— 生产就该用真实时钟，测试才需要钉住它。
 * @param {number} [options.utcOffsetMinutes] 时区偏移，缺省 480（UTC+8），一路透传给 `formatStamp`。
 * @returns {string}
 */
export function renderEntries(entries, imageText = null, { now = Date.now(), utcOffsetMinutes = 480 } = {}) {
  return entries
    .map((m) => {
      const body = typeof imageText === 'function' ? applyImageText(m.text, imageText(m)) : m.text;
      return `[${formatStamp(m.at, { now, utcOffsetMinutes })}] ${m.nickname}(${m.userId}): ${body}`;
    })
    .join('\n');
}

/**
 * 把正文里的 `[图片]` 占位符按顺序换成描述。
 *
 * **导出**是为了让网关**不用复制一遍**这段规则（`gateway.mjs` 的图片描述注入
 * 走的就是它）—— 两处各写一份正则，迟早会漂移成"有的路有描述、有的路没有"。
 *
 * 契约（与 {@link ImageTextLookup} 一致）：
 * - `described[i]` 是**第 i 张图**的描述；顺序 = 正文里 `[图片` 出现的顺序
 *   （`segmentsToText` 与 `collectImageSegments` 都按段顺序走，所以对得上）；
 * - `''` / 下标越界 ⇒ **保留原占位符**（宁可不写，也不编一句）；
 * - 已带描述的 `[图片: …]` 不会被二次替换（见 `IMAGE_PLACEHOLDER_RE`）。
 *
 * @param {string} text
 * @param {string[]|null} described
 * @returns {string}
 */
export function replaceImagePlaceholders(text, described) {
  return applyImageText(text, described);
}

/**
 * @param {string} text
 * @param {string[]|null} described
 * @returns {string}
 */
function applyImageText(text, described) {
  const body = String(text ?? '');
  if (!Array.isArray(described) || described.length === 0) return body;
  let index = 0;
  return body.replace(IMAGE_PLACEHOLDER_RE, (whole) => {
    const hit = String(described[index] ?? '');
    index += 1;
    return hit === '' ? whole : `[图片: ${hit}]`;
  });
}

/**
 * 机器人发言历史保留多少条。
 *
 * 够覆盖判定窗口就行：转录最多留 60 条 / 30 分钟，而 gauge 的窗口只有 8 条，
 * 50 个时间戳远远够用（且是有界的，不会随会话时长无限增长）。
 */
const BOT_HISTORY_LIMIT = 50;

/**
 * 「对方还没说完」标记的两个保险（2026-11-01）。
 *
 * - **TTL 90 秒**：判官说「等」之后，只有"紧接着的下一句"才算这条话的续写。
 *   十分钟后冒出来一条无关消息也被"强制预检"，那是噪声。
 * - **最多跟 3 次**：有人一直发短句时，别让这个标记无限续下去
 *   （每次续都要多花一次预检调用）。
 */
export const INCOMPLETE_TTL_MS = 90_000;
export const INCOMPLETE_MAX_FOLLOWUPS = 3;

/**
 * 单会话的发言状态：怎么算「刚说过话」。
 * 独立出来是因为判定逻辑要同时看：主动发言记录 + 任何机器人发言（含被动回复）。
 */
export class ChatState {
  constructor() {
    /** @type {number[]} 主动发言时间戳（滚动小时窗口） */
    this.speaks = [];
    /**
     * @type {number[]} 最近若干次机器人发言的时间戳（含被动回复），**升序**。
     *
     * 为什么要数组而不是单值 `lastBotAt`：判定层要算「窗口里我说了几次」，
     * 用来做存在感惩罚（防话痨）。而小鲸鱼自己的消息**根本不进转录**
     * （`decide()` 对 `fromSelf` 提前 return，`transcript.push` 也就没被调用），
     * 所以旧实现里 gauge 的 `selfRatio` 恒为 0 —— **penalty 是死代码**（2026-10-07 查实）。
     * 解法就是把它带进 gauge 的入参（账本 §12.2：转录一个字不动）。
     */
    this.botAt = [];
    /** @type {number} 最近一次机器人发言（含被动回复） */
    this.lastBotAt = 0;
    /**
     * @type {boolean} 她**最后一条**发言是不是问句/请求（2026-10-12）。
     *
     * 为什么需要：`#focusValue` 那 0.5 的"时间票"原来无条件给，而它单独就等于
     * `focusSpeakThreshold`(0.5) ⇒ `focusEnough` 恒真 ⇒ 她说完话后专注窗口内
     * （本部署 toml 里 `focusWindowMs = 60000`）**群里任何一条消息都让她回一轮**，
     * 完全不过打分。而 focus 真正要保的场景只有一个：
     * **她问了话 → 别人简短作答 → 她别掉线**（用户 2026-10-11 的原话场景：
     * 「小鲸鱼问『需要我去通知主会话吗』→ 用户答『好啊』→ 被拒，压根没送过去」）。
     * 她**只是评论了一句**、别人接着聊别的，不该被当成"在接她的话"。
     *
     * 由 `noteBotMessage(at, text)` / `noteSpeak(at, text)` 维护：
     * **调用方拿得到正文时**才更新（拿不到就保持原值，见 `noteBotMessage`）。
     */
    this.lastBotWasQuestion = false;
    /** @type {number} 最近一次主动发言 */
    this.lastSpeakAt = 0;
    /**
     * @type {number} 最近一次**【被点名触发】的发言**（@ / 喊名字 / 私聊）。
     *
     * 2026-10-15 加，供 `#focusValue` 的 **票C** 用。
     *
     * ## 为什么需要它
     *
     * 用户实测：「**@ 完她之后，我后续发的没啥回的可能性了**」。
     * 追下去发现两条既有投票在他那个场景**都不触发**：
     *   · 票A 要别人**引用回复**她的消息（`replyToSelf`）；
     *   · 票B 要她**最后一条是问句/请求**（`lastBotWasQuestion`）。
     * ⇒ `focus` 恒为 0 ⇒ 只能靠打分 ⇒ 而**冷清群里分数只有 8~15，永远够不到 50**
     *   （实测 journal：`score=8.9 / 14.9 / 14.9 / 14.9`，阈值 50）⇒ 聊不下去。
     *
     * 票C 补的就是这个缺口：**她刚被点名并回过话 ⇒ 专注窗口内算"在跟她聊"。**
     * 上限仍由 `#focusExhausted`（`focusMaxSpeaksPerWindow`，默认 3）兜着 ⇒ 不会变刷屏。
     *
     * ⚠️ **内存态，不进快照**（与 `declineCount` 同）：重载/重启就丢，
     * 代价只是"下次被点名时重新开始计时"，可以接受。
     */
    this.lastAddressedReplyAt = 0;
    /**
     * @type {number} 最近一次"判定说了**要说**"的时刻（**还没真发出去**）。
     *
     * 2026-10-16 加的，专治**突发消息刷屏** —— 完整机制、线上实证与代价
     * 见 `noteSpeakIntent()` 的注释。一句话：`#gate` 的检查发生在串行点之前、
     * 而 `lastSpeakAt` 要等回复发出去才更新 ⇒ 1.5 秒内连发的消息会**全部放行**。
     *
     * ⚠️ 只参与间隔/冷却两道闸门，**不进 `speaks`**（那是 maxPerHour 的账）。
     * ⚠️ 内存态，不进快照。
     */
    this.lastSpeakIntentAt = 0;
    /** @type {number} 累计人类消息数（用于 afterUserMsgCount 门槛） */
    this.userMessages = 0;
    /** @type {boolean} 首次冒泡门槛是否已过 */
    this.thresholdPassed = false;
    /** @type {number} 判定调用计数，用于偏移/采样 */
    this.gauges = 0;
    /**
     * @type {number} 「攒劲儿」计数：**判定了但她没说**的次数（限流后）。
     *
     * 2026-10-14 加，治"结构性反馈锁"——见 `defaultTriggerConfig().decline_bonus`。
     *
     * ⚠️ **三件事必须同时成立才 +1**（少一条这个数就没意义）：
     *   1. **闸门放行过**（`#gate` 返回 allowed）—— 没放行的连打分都没进，
     *      启发式**根本没机会否决**，所以不算否决（`cooldown-after-bot` 挡掉的那 61 条
     *      正是这一类，用户 2026-10-14 的硬要求）。
     *   2. **判定器真的给了一个结论**（`decision !== null`）。
     *      `null` = 压根没打分（窗口空 / 命中"别说话" / 打分关闭）⇒ **不算否决**。
     *   3. **距上次计数 ≥ `decline_bonus_min_gap_ms`** —— 限流，防刷屏刷爆。
     *
     * 归零只有一条路：`noteBotMessage()`（**任何**机器人发言：主动 `noteSpeak` +
     * 被动回复 `noteReplied` 都经过它）⇒ 和"她说了 ⇒ 归零"逐字对齐，不会漏掉被动回复。
     *
     * ⚠️ **内存态**：重载 / 重启就丢。丢了的后果只是"重新攒"，**可以接受**；
     * 但由此**不要**把它当成"发言频率的持久账"来读（见 task report）。
     */
    this.declineCount = 0;
    /** @type {number} 上次计数的时刻（限流用）。0 = 从没计过。 */
    this.lastDeclineAt = 0;
    /**
     * **「对方还没说完」的标记**（2026-11-01，precheck 第三态「等」）。
     *
     * 判官说「等」时由网关写进来；下一条消息**跳过阈值判定**直接进 precheck
     * （`#gate` 里那条 `incomplete-followup`），再看一眼这次说完没有。
     *
     * `{ at: number, count: number }`：`at` 用来算 TTL（超时就当没挂），
     * `count` 是连续"等"了几次（超过上限就放掉，防死循环）。
     *
     * ⚠️ **内存态**：重载/重启就丢。丢了只是"下一条按常规打分"，可以接受。
     * @type {{at: number, count: number}|null}
     */
    this.incomplete = null;
  }

  /** 记一条人类消息。 */
  noteUserMessage(at) {
    this.userMessages += 1;
    if (this.userMessages >= 1) this.lastUserAt = at;
  }

  /**
   * 记一次「对方还没说完」（2026-11-01，判官答「等」）。
   *
   * 每来一次就把时间戳刷新（TTL 从**最近一次**算起）、次数 +1（防死循环）。
   * @param {number} at
   * @returns {number} 连续第几次「等」（1 起）
   */
  noteIncomplete(at) {
    const prev = this.incomplete;
    const count = prev !== null && Number.isFinite(Number(prev.count)) ? Number(prev.count) : 0;
    this.incomplete = { at: Number.isFinite(at) ? at : Date.now(), count: count + 1 };
    return this.incomplete.count;
  }

  /** 清掉「还没说完」的标记（判官给出结论 / 她说了话 / 超过次数上限）。 */
  clearIncomplete() {
    this.incomplete = null;
  }

  /**
   * 记一次机器人发言（主动或被动都算）。
   *
   * @param {number} at
   * @param {string} [text] 她这次**说了什么**。省略 = "只知道她说了话、不知道内容"。
   *
   *   ⚠️ **省略时不要瞎猜**：那会决定 `lastBotWasQuestion`（见字段注释），
   *   而拿不到正文的调用点**本来就无权**改写这个判断 —— 所以缺正文时**保持原值**。
   *   （生产链路上 `gateway.runTurn` 调 `noteReplied` 时目前拿不到回复正文，
   *   那一处补上 `text` 之后这条判断才会在线上生效；见任务报告的"拿不到文本的调用点"。）
   */
  noteBotMessage(at, text) {
    if (!Number.isFinite(at)) return;
    /**
     * **她说了话 ⇒ 攒劲儿计数归零**（2026-10-14）。
     *
     * 为什么挂在**这里**而不是 `noteSpeak` 上：`noteBotMessage` 是**所有**机器人发言的
     * 唯一汇聚点 —— 主动发言走 `noteSpeak` → 这里；**被动回复走 `noteReplied` → 这里**；
     * `forceSpeak`（汇报/播报）、`restoreContext`（开机灌历史）也走这里。
     * 挂在 `noteSpeak` 上会**漏掉被动回复**，而"她正在跟人聊天"恰恰是被动回复最多的时候
     * —— 那种时候攒劲儿还留着，就会在她聊得正热时凭空多给 60 分。
     *
     * ⚠️ **时钟倒退不许改写它**（与 `lastBotAt` 同一条道理，但方向相反）：
     * 这里**无条件**归零。一条迟到的旧自消息**不该**把她刚攒的劲儿保留下来 ——
     * "她说过话"是事实，与那条消息的时间戳新旧无关。
     */
    this.declineCount = 0;
    // 她说了话 ⇒ 「对方还没说完」的标记也作废（那条话已经不需要接了）。
    this.incomplete = null;
    // 取最大值而不是覆盖：发言时刻来自真实时钟，而 `at` 可能是一条
    // 时间戳倒退的迟到消息。直接覆盖会把冷却期"拉回过去"，于是一条
    // 老消息之后的所有新消息都会被误判成「机器人刚说完话」而全部被挡。
    // 同理，**乱的迟到消息也不许改写「她最后一条是不是问句」**：
    // 只有"这一条确实是她最新的发言"时才更新（`at >= lastBotAt`）。
    const isLatest = at >= this.lastBotAt;
    if (at > this.lastBotAt) this.lastBotAt = at;
    const known = typeof text === 'string' && text.trim() !== '';
    if (isLatest && known) this.lastBotWasQuestion = looksLikeQuestion(text);
    this.botAt.push(at);
    if (this.botAt.length > BOT_HISTORY_LIMIT) {
      // 迟到消息可能乱序，所以按时间戳排出"最旧的若干个"再丢。
      this.botAt.sort((a, b) => a - b);
      this.botAt.splice(0, this.botAt.length - BOT_HISTORY_LIMIT);
    }
  }

  /**
   * 记一次主动发言。
   * @param {number} at
   * @param {string} [text] 她说了什么（省略 = 不知道内容，见 `noteBotMessage`）
   */
  noteSpeak(at, text) {
    this.speaks.push(at);
    // 同理取最大值，避免迟到消息把间隔额度"拉回过去"。
    if (at > this.lastSpeakAt) this.lastSpeakAt = at;
    this.noteBotMessage(at, text);
  }

  /**
   * 记一次**被点名触发的发言**（@ / 喊名字 / 私聊）—— 供 `#focusValue` 的**票C**用。
   *
   * 与 `noteSpeak` 的区别：`noteSpeak` 记的是"机会主义插话"（她自己冒泡），
   * 这里记的是"别人找她、她回了"。**只有后者开专注窗口** ——
   * 理由见 `lastAddressedReplyAt` 的字段注释。
   *
   * ⚠️ 时间戳取**最大值**，与 `lastBotAt` / `lastSpeakAt` 同一条道理：
   * 迟到的旧消息（WS 重连补发、跨机时钟偏差）**不许**把专注窗口拉回过去。
   *
   * @param {number} at
   */
  noteAddressedReply(at) {
    if (!Number.isFinite(at)) return;
    if (at > this.lastAddressedReplyAt) this.lastAddressedReplyAt = at;
  }

  /**
   * 记下"判定说了**要说**"的瞬间 —— **这是 2026-10-16 修突发刷屏的关键**。
   *
   * ## 治的是什么（有线上实证）
   *
   * 2026-10-16 12:03:54~12:04:02，示例群（30000013）小鲸鱼在 **10 秒内连发 6 条**
   * （turn 29→34，每轮一句，间隔 1.5~1.8 秒）。那个群该守的是
   * `minIntervalMs = 60000` · `cooldownAfterBotMs = 30000` · `maxPerHour = 6`
   * ⇒ 10 秒说 6 次**本该被间隔挡住**。
   *
   * ## 根因：闸门检查在**串行点之前**，而记账在**回合之后**
   *
   * `handleInbound` 的顺序是：
   * ```
   * ① #gate(message, state)      ← 读 state.lastBotAt / lastSpeakAt
   * ② if (!allowed) skip
   * ③ await inFlight(chatId)     ← 串行【从这里才开始】
   * ④ #decide(...)               ← 真正的回合（约 1.5 秒）
   * ```
   * 而 `lastBotAt` / `lastSpeakAt` 要等**回复真的发出去**、网关回调 `noteReplied`
   * 才更新（生产链路上那是在 ④ 结束之后）。
   *
   * ⇒ 群里 1.5 秒内连发 6 条时，**6 个 ① 全在任何一次 ④ 完成之前跑完**
   * ⇒ 每个都看到"她好久没说话" ⇒ **6 个全放行** ⇒ 排进 ③ 逐个跑 ⇒ 6 条消息。
   * ⇒ 闸门不是失效，是**在突发消息面前集体迟到**。
   *
   * ## 修法：把"占用"提到"决定要说"的那一刻（与检查同一个同步块）
   *
   * `#gate` 现在同时看 `lastSpeakAt` 与这里记的 `lastSpeakIntentAt`，取较晚的那个。
   * ⇒ 突发里的第 2 条开始就会看到"刚说过话" ⇒ 被 `cooldown-after-bot` 挡掉。
   *
   * ⚠️ **只用于间隔/冷却两道闸门，不进 `speaks` 数组** —— `speaks` 是
   * `maxPerHour` 的账（那是"真说了几条"），把"意图"计进去会让小时配额凭空翻倍。
   *
   * ⚠️ 内存态，不进快照（与 `declineCount` / `lastAddressedReplyAt` 同）。
   *
   * ⚠️ 代价：判定说要说、但回合最后失败（模型报错/发送失败）⇒ 名额被白占一次，
   * 接下来一个冷却期内她不出声。**比连发 6 条轻得多**，可以接受。
   *
   * @param {number} at
   */
  noteSpeakIntent(at) {
    if (!Number.isFinite(at)) return;
    if (at > this.lastSpeakIntentAt) this.lastSpeakIntentAt = at;
  }

  /** 记发言前的状态快照（发言失败时回滚用，避免白烧配额）。 */
  snapshot() {
    return {
      speaks: this.speaks.length,
      botAt: this.botAt.length,
      lastBotAt: this.lastBotAt,
      lastSpeakAt: this.lastSpeakAt,
      lastBotWasQuestion: this.lastBotWasQuestion,
      // 攒劲儿也一起回滚：`noteBotMessage` 会把它清零，而一次**失败的**发言
      // 不该当成"她说了话"⇒ 计数与限流时刻都要退回发言前。
      declineCount: this.declineCount,
      lastDeclineAt: this.lastDeclineAt,
    };
  }

  /** 回滚到发言前的状态。 */
  rollback(snap) {
    if (snap === undefined || snap === null) return;
    this.speaks.length = snap.speaks;
    if (Number.isFinite(snap.botAt)) this.botAt.length = snap.botAt;
    this.lastBotAt = snap.lastBotAt;
    this.lastSpeakAt = snap.lastSpeakAt;
    if (typeof snap.lastBotWasQuestion === 'boolean') this.lastBotWasQuestion = snap.lastBotWasQuestion;
    if (Number.isFinite(snap.declineCount)) this.declineCount = snap.declineCount;
    if (Number.isFinite(snap.lastDeclineAt)) this.lastDeclineAt = snap.lastDeclineAt;
  }

  /**
   * **只恢复【对话上下文】，不碰任何限流状态**（启动时灌历史用，2026-10-13）。
   *
   * ## 为什么必须单独开一个方法，而不是让调用方自己 `noteBotMessage`
   *
   * 用户 2026-10-13 定的红线（原话的意思是）：**新实例该有自己的限流**。
   * 而 `ChatState` 里的字段其实是**两类东西混在一个类里**：
   *
   * | 字段 | 是什么 | 灌历史时 |
   * |---|---|---|
   * | `lastBotAt` / `lastBotWasQuestion` / `botAt` | **上下文**（"她刚说过话 / 刚问过话"） | ✅ 恢复 |
   * | `speaks` / `lastSpeakAt` | **配额与冷却**（滚动小时窗口 / 最小间隔） | ❌ 不恢复 |
   * | `userMessages` / `lastUserAt` | **预热门槛**（`afterUserMsgCount`） | ❌ 不恢复 |
   * | `gauges` / `thresholdPassed` | 采样与门槛 | ❌ 不恢复 |
   *
   * ⇒ 恢复发言时间只走 `noteBotMessage`（它**只**动上表第一行），
   *   `speaks` / `lastSpeakAt` / `userMessages` / `lastUserAt` **一个字都不动**。
   *
   * ⚠️ **红线（用户 2026-10-13 立的）**：开机后**绝不能因为灌进来的旧消息**去回
   *    一条 8 小时前的消息。本条只写内存、**不调用 `decide` / `#gate`**，
   *    所以"回一条旧消息"在结构上不可能发生 —— 不是靠判断，是靠**没有那条路**。
   *
   * ⚠️ `lastBotAt` 恢复的是**真实时刻**（可能是 8 小时前）。这**不会**把她锁进
   *    `cooldown-after-bot`：`#gate` 用的是 `now - lastBotAt`（流逝时间夹在 0 以上），
   *    旧时刻的差值是几小时，**远大于**冷却阈值 ⇒ 冷却天然已过。
   *    灌一个"假的现在"才会真出事（那等于人为制造一整段冷却）。
   *
   * @param {number} at 她最后一次发言的时刻（毫秒）
   * @param {string} [text] 那句话的正文；拿不到就省略（`noteBotMessage` 会保持原值）
   * @returns {boolean} 是否记下了
   */
  restoreContext(at, text) {
    if (!Number.isFinite(at) || at <= 0) return false;
    this.noteBotMessage(at, text);
    return true;
  }

  /**
   * 窗口内机器人发言了几次。
   * @param {number} now
   * @param {number} windowMs
   */
  botMessagesWithin(now, windowMs) {
    const cutoff = now - windowMs;
    return this.botAt.filter((t) => t >= cutoff).length;
  }

  /**
   * 滚动窗口内的主动发言次数。
   * @param {number} now
   * @param {number} windowMs
   */
  speaksWithin(now, windowMs) {
    const cutoff = now - windowMs;
    while (this.speaks.length > 0 && this.speaks[0] < cutoff) this.speaks.shift();
    return this.speaks.length;
  }
}

/**
 * 主动发言引擎。
 *
 * 判定分两层：
 * 1. **闸门**（本类，纯算术）：准入、消息量门槛、配额、冷却、最小间隔。不通就直接安静，
 *    连模型都不叫——这是省钱也是防刷屏的第一道。
 * 2. **判定**（注入的 `gauge`）：闸门放行后才问模型「这话题你要不要说、说什么」。
 */
export class ProactiveEngine {
  /**
   * 「cap < 阈值」那条 warn 只打一次（见 `declineBonus`）。
   * 打一次而不是每次都打：热路径上每条消息都会问一次，重复日志会把 journal 冲掉。
   * @type {boolean}
   */
  #declineCapWarned = false;

  /**
   * @param {object} options
   * @param {TriggerConfig} options.config
   * @param {(request: GaugeRequest) => Promise<GaugeDecision|null>} options.gauge
   *   话题判定。返回 null/'pass' 表示不说话；返回 {text} 表示要冒泡。
   * @param {(request: SpeakRequest) => Promise<void>} options.speak
   *   真正发言。失败应自行处理（引擎不管重试）。
   * @param {(chatId: string) => boolean} [options.allowed]
   *   这个会话是否允许主动发言（访问控制）。
   *   **必须在闸门里判，不能等 `speak` 内部去判**：`noteSpeak()` 在调用
   *   `speak` 之前就扣了配额，如果准入是被 `speak` 拒绝的，配额就被白白烧掉——
   *   连续被拦几次之后这个会话今天就再也不冒泡了，而日志只说"跳过"。
   *   实测踩到过。省略时默认全部允许。
   * @param {(level: string, message: string, meta?: object) => void} [options.log]
   * @param {() => number} [options.now] 注入时钟，便于测试
   * @param {Record<string, object>} [options.overrides]
   *   **按会话的配置覆盖**：`{ 'group:200000002': { burstMinMessages: 2 } }`。
   *
   *   为什么需要（用户 2026-10-04 提的，原话）：
   *   > 这个群聊不太活跃，可能得改下；似乎还没有单独群聊的规则，
   *   > 要不 toml 做成一套通配的规则 + 指定某几个群聊的特殊规则吧？
   *
   *   在那之前所有闸门读的都是**同一份全局配置** —— 想给一个安静的群放宽门槛，
   *   就得把所有群一起放宽。有了它才能"通配一套 + 个别群覆盖"。
   *
   *   **合并规则：浅合并，缺的字段往全局要**（不是整段替换）。
   *   这样 `{ burstMinMessages: 2 }` 就只改这一项、其余照旧继承；
   *   整段替换的话，以后每加一个配置项，所有覆盖规则都会悄悄退回默认值。
   */
  constructor({
    config, gauge, speak, allowed, log = () => {}, now = () => Date.now(), names = [], overrides = null,
    judgeMode = 'heuristic', precheck = null,
  }) {
    this.config = { ...defaultTriggerConfig(), ...config };
    /**
     * 「说不说」的裁量模式（`heuristic` / `precheck` / `inTurn`）。
     *
     * ⚠️ **引擎不实现任何一种模式** —— 它只把结论记进日记（`#decide` 里那两行），
     * 真正的分支在调用点：
     *   · 模式 2 的预检在 `gateway.handleEvent`（过了阈值之后、进 agent 之前），
     *     因为它要用**消息正文**拼那一次性的提示词，而引擎至今不碰正文；
     *   · 模式 3 的"倾向"在同一处的 `#buildPrompt`。
     * 引擎持有它只为一件事：**让日记说得出"这一条是哪个模式判的"**（可观测性）。
     */
    this.judgeMode = judgeMode;
    /**
     * 模式 2 的预检器自述（`{provider, model, enabled, timeoutMs}` 或 null）。
     * 只用于**留痕**：诊断时"precheck 到底走哪条模型"必须有唯一答案 ——
     * 这条链是静默降级的（失败 ⇒ 当成"该说"），不写下来的话它看起来和"没用它"一样。
     */
    this.precheckInfo = typeof precheck?.describe === 'function' ? precheck.describe() : null;
    /**
     * 归一成 Map：查找在热路径上（每条消息、每道闸门都查），而且键要精确匹配。
     * 坏数据直接丢掉 —— 一条写错的覆盖规则不该让整个引擎起不来。
     */
    this.overrides = new Map(
      Object.entries(overrides ?? {})
        .map(([k, v]) => [String(k ?? '').trim(), v])
        .filter(([k, v]) => k !== '' && v !== null && typeof v === 'object' && !Array.isArray(v)),
    );
    this.gauge = gauge;
    this.speak = speak;
    this.allowed = allowed ?? (() => true);
    this.log = log;
    this.now = now;
    /**
     * 机器人自己的名字与别名。用于识别"用户在叫它"。
     *
     * 为什么需要：gauge 有 `nameMentioned`（+45 相关分），但早先**没人设置它** ——
     * 实测表现是用户在群里喊「小鲸鱼在不在」被判为不相关、直接沉默。
     */
    this.names = Array.isArray(names) ? names.map((n) => String(n)).filter((n) => n !== '') : [];
    /** @type {Map<string, Transcript>} */
    this.transcripts = new Map();
    /** @type {Map<string, ChatState>} */
    this.states = new Map();
    /** @type {Set<string>} 正在进行中的判定，防止同一会话并发判定 */
    this.inFlight = new Map();
    /** @type {Set<number>} 已见过的 messageId，用于去重 */
    this.seenIds = new Set();
    /**
     * 判定日记：最近若干条「为什么跳过 / 打分多少 / 说没说出来」的流水。
     *
     * 为什么需要它：计数（`gauges: 4`）只能说明"判定被叫过 4 次"，却分不清是
     * **闸门挡的**、**打分不够**、还是**发言失败**——三者在计数上长得一模一样
     * （计数涨了、消息没出去）。真机排查时为此反复靠猜，所以把"原因"本身
     * 也留一份有界流水，落进调试快照。
     *
     * 刻意**只记原因与分数，不记正文**：日记不是转录。
     * @type {object[]}
     */
    this.journal = [];
    /** 日记上界（条）。 */
    this.journalLimit = 20;
    /**
     * **最近一条 `event:'gauge'` 日记的对象引用**（2026-10-13 加，为模式 2）。
     *
     * 为什么留引用而不是"再记一条"：模式 2 的预检在网关里、且发生在
     * `#decide` **返回之后**，所以它落不进那条日记的初始写入 ——
     * 见 `annotateLastGauge()` 的说明。
     * @type {object|null}
     */
    this.lastGaugeEntry = null;
    this.stopped = false;
  }

  /**
   * 给"最近一条符合条件"的日记补字段 —— **模式 2 的预检结论走这里**。
   *
   * ## 为什么需要它（模式 2 的时序决定的）
   *
   * 预检发生在**网关**里，而它要等 `engine.decide()` 返回之后才开始（那时才知道
   * 打分说没说、要拼什么提示词）。可 `#decide` 的 `event:'gauge'` 日记是**在它返回
   * 之前**就落盘的 —— 也就是说，写日记那一刻"预检还没跑"，`pc_*` 根本无从取值。
   *
   * ⇒ 两条路：要么让引擎去 await 预检（那要把网关的逻辑搬进引擎，违反"引擎不碰正文"），
   * 要么**事后补一笔**。这里选后者：`#decide` 把自己那条日记的对象留在
   * `lastGaugeEntry` 上，网关跑完预检回来补字段 —— 日记对象是同一个引用，
   * 补完就是"这条日记一开始就带着预检结论"。
   *
   * ⚠️ **只改日记，绝不改判定**（判定早就做完了）。
   * @param {Record<string, unknown>} extra
   * @returns {boolean} 补上了没有（没补上说明那条日记已经被挤出上界）
   */
  annotateLastGauge(extra) {
    const entry = this.lastGaugeEntry;
    if (entry === null || entry === undefined || typeof entry !== 'object') return false;
    if (extra === null || typeof extra !== 'object') return false;
    Object.assign(entry, extra);
    return true;
  }

  /**
   * 记一条日记 —— **公开给网关用**（模式 2 的"被 precheck 拦下"必须在日记里留痕）。
   *
   * 为什么要有这个公开壳：`#record` 是私有的，而 precheck 的分支在 `gateway.handleEvent`
   * 里（它比 `#decide` 更晚、也更靠外）。不记的话，"precheck 拦下的"与
   * "压根没过阈值"在日记里完全同形 —— 而这两种情况花的钱（一次轻量调用 vs 零）
   * 和该做的处置（调措辞 vs 调阈值）都不一样。
   *
   * 刻意**不碰判定链**：它只追加一条流水，不改任何决定。
   * @param {object} entry 至少含 `event`；`at` 缺省用注入时钟
   */
  record(entry) {
    this.#record(entry);
  }

  /**
   * 记一条日记（私有）。超上界就丢最早的。
   *
   * ⚠️ 它 push 的是 `{...entry, at}` —— **一份拷贝**，不是传进来的那个对象。
   * 这个细节踩过一次（2026-10-13）：`annotateLastGauge()` 想事后补字段，
   * 最初把 `lastGaugeEntry` 指向了**传进来的** `gaugeEntry`，于是
   * `Object.assign` 补的是那份没人看的副本，`journal` 里那条始终没有 `pc_*`。
   * ⇒ 谁要事后补字段，**必须拿这个返回值**（它才是 journal 里那个对象）。
   * @param {object} entry 至少含 `event`；`at` 缺省用注入时钟
   * @returns {object} **落进 journal 的那个对象**（引用）
   * @private
   */
  #record(entry) {
    const at = Number.isFinite(entry?.at) ? entry.at : this.now();
    const stored = { ...entry, at };
    this.journal.push(stored);
    while (this.journal.length > this.journalLimit) this.journal.shift();
    return stored;
  }

  /**
   * 导出全部转录（M1b，2026-11-05），交给落盘层定期写盘。
   * @returns {Record<string, object[]>}
   */
  exportTranscripts() {
    const out = {};
    for (const [chatId, transcript] of this.transcripts) {
      if (typeof transcript?.snapshot !== 'function') continue;
      const list = transcript.snapshot();
      if (Array.isArray(list) && list.length > 0) out[chatId] = list;
    }
    return out;
  }

  /**
   * 把落盘的转录灌回来（M1b，2026-11-05）。重启/重载后调用，之后再接 NapCat 回填。
   * 按时间升序推进；`push()` 自己会拒掉时间戳倒退的条目，所以这里先排序。
   * @param {string} chatId
   * @param {object[]} messages
   * @returns {number} 实际灌进去几条
   */
  restoreTranscript(chatId, messages) {
    if (typeof chatId !== 'string' || chatId === '') return 0;
    const list = (Array.isArray(messages) ? messages : [])
      .filter((m) => m !== null && typeof m === 'object' && Number(m.at) > 0 && String(m.text ?? '').trim() !== '')
      .sort((a, b) => Number(a.at) - Number(b.at));
    if (list.length === 0) return 0;
    const transcript = this.transcript(chatId);
    let restored = 0;
    for (const m of list) {
      if (transcript.push(m) === true) restored += 1;
    }
    return restored;
  }

  /** 某会话的转录（懒创建）。 */
  transcript(chatId) {
    let t = this.transcripts.get(chatId);
    if (t === undefined) {
      t = new Transcript();
      this.transcripts.set(chatId, t);
    }
    return t;
  }

  /**
   * **只入转录、不做判定**（防抖用，2026-11-04）。
   *
   * 防抖把一批消息攒住，只对**最后一条**跑 `decide()`；前面几条如果直接丢掉，
   * 模型就看不到"她刚才说了什么"——所以要把它们补进转录。
   *
   * 与 `decide()` 里那次 `transcript.push` 的区别只有一点：这里不跑闸门、不记账。
   * 返回是否被接受（与 `Transcript.push` 同义：时间戳倒退的乱序消息会被拒）。
   */
  ingest(message) {
    if (message === null || message === undefined) return false;
    if (message.fromSelf === true) return false;
    return this.transcript(message.chatId).push(message);
  }

  /**
   * 取走"被转录挤出去的消息"（M1，2026-11-04），供回想压缩用。
   *
   * `minCount`：**只有攒够这么多条才取** —— 取走即清空，提前取会把一段聊天
   * 切成很多条零碎回想，既费模型调用又不好召回。
   *
   * @param {{minCount?: number}} [options]
   * @returns {{chatId: string, messages: InboundMessage[]}[]}
   */
  drainDropped({ minCount = 1 } = {}) {
    const out = [];
    const floor = Math.max(1, Number(minCount) || 1);
    for (const [chatId, transcript] of this.transcripts) {
      const dropped = transcript?.dropped;
      if (!Array.isArray(dropped) || dropped.length < floor) continue;
      const messages = typeof transcript.takeDropped === 'function' ? transcript.takeDropped() : [];
      if (messages.length > 0) out.push({ chatId, messages });
    }
    return out;
  }

  /** 某会话的状态（懒创建）。 */
  state(chatId) {
    let s = this.states.get(chatId);
    if (s === undefined) {
      s = new ChatState();
      this.states.set(chatId, s);
    }
    return s;
  }

  /** 停止后一切入站消息只记录不判定。 */
  stop() {
    this.stopped = true;
  }

  /**
   * 判定一条入站消息「要不要回复」。**所有**消息都走这里 —— @ 的、私聊的、群里没 @ 的。
   *
   * 这是 MaiBot 式的**统一判定链**：不再按"有没有 @"切换通道（旧实现里 @ 会直接
   * 转给被动会话、未 @ 转给主动引擎，等于两条并行通道，实测导致同一条消息被
   * 两个通道各回一次）。这里 @ 只是一个**加分项**（见 `heuristic-gauge` 的 +60），
   * 以及"跳过限流闸门"的凭据（被点名是明确请求，不该被冷却/配额挡住）。
   *
   * 判定只回答"说不说"；**说什么由会话（agent）决定** —— 所以插话也会落到会话
   * 历史里，上下文是连续的（这正是"小鲸鱼插完话不记得自己说过什么"的解法）。
   *
   * @param {InboundMessage} message
   * @returns {Promise<{speak: boolean, reason: string, score?: number, focus?: number, addressed: boolean}>}
   */
  async decide(message) {
    // 机器人自己的消息：只更新时间戳，不进转录也不触发。
    if (message.fromSelf === true) {
      // 这条路上**拿得到正文**（就是她说的那句话），所以顺手把
      // 「她最后一条是不是问句」也记下来。
      this.state(message.chatId).noteBotMessage(message.at, message.text);
      return { speak: false, reason: 'from-self', addressed: false };
    }
    // 去重：同一个 messageId 只处理一次（重连补发会重复投递）。
    if (typeof message.messageId === 'number') {
      if (this.seenIds.has(message.messageId)) return { speak: false, reason: 'duplicate', addressed: false };
      this.seenIds.add(message.messageId);
      if (this.seenIds.size > 5000) {
        // 简单上界：超了就从最早的一批里丢一半。Set 保持插入序。
        const drop = this.seenIds.size - 2500;
        let n = 0;
        for (const id of this.seenIds) {
          this.seenIds.delete(id);
          if (++n >= drop) break;
        }
      }
    }

    const transcript = this.transcript(message.chatId);
    transcript.push(message);
    const state = this.state(message.chatId);
    state.noteUserMessage(message.at);

    if (this.stopped) return { speak: false, reason: 'engine-stopped', addressed: false };

    // `proactive.enabled` 只约束**机会主义插话**；被点名（@ / 私聊 / 喊名字）不受它影响 ——
    // 那是别人的直接请求，属于被动回复范畴。
    // 旧实现用 `!enabled` 一律挡掉，等于"关了主动发言，连私聊都不理人"。
    // ⚠️ 同 `#gate` 里那条排除（2026-10-13 03:2x）：**引用回复自动带的 `@` 不算被点名**
    // ⇒ 一个群里 `enabled = false` 时，"引用我 + 自动 @"**不该**绕过禁用去回她。
    // （不改这条的话，禁用会漏掉"引用 + @"这一整类，而那正是用户报的那个误判。）
    const addressedEarly =
      (message.mentioned === true && message.replyToSelf !== true)
      || message.kind === PRIVATE || mentionedByName(message, this.names);
    // 也走按会话的配置：`{ 'group:200000003': { enabled: false } }` 能单独关掉一个群。
    if (!this.#cfgFor(message.chatId).enabled && !addressedEarly) {
      return { speak: false, reason: 'proactive-disabled', addressed: false };
    }

    const verdict = this.#gate(message, state);
    if (!verdict.allowed) {
      this.#record({ at: message.at, chatId: message.chatId, event: 'skip', reason: verdict.reason });
      this.log('debug', `判定不回复 ${message.chatId}`, { reason: verdict.reason });
      return { speak: false, reason: verdict.reason, addressed: verdict.addressed === true };
    }
    // **排队，而不是跳过。** 跳过会让并发时后面的消息被静默丢掉 ——
    // 实测场景：群里连发两条 @ 我的消息，只有第一条得到回复。
    // 判定的窗口很短（打分是纯计算），排队开销可以忽略。
    // （`inFlight` 是 Map：键=会话，值=该会话正在跑的判定 Promise。）
    const pending = this.inFlight.get(message.chatId);
    if (pending !== undefined) await pending.catch(() => undefined);

    const task = this.#decide(
      message,
      state,
      transcript,
      verdict.addressed === true,
      // 2026-11-01：这一条是"上一句没说完"的续写 ⇒ 必须再问一次 precheck，
      // 所以跳过阈值（`speakFinal` 里也认这个信号）。
      verdict.reason === 'incomplete-followup',
    );
    this.inFlight.set(
      message.chatId,
      task.catch(() => undefined).finally(() => {
        if (this.inFlight.get(message.chatId) === task) this.inFlight.delete(message.chatId);
      }),
    );
    return task;
  }

  /**
   * 记账一次"已经发出去的回复"。
   *
   * - 被点名的回复（@ / 喊名字 / 私聊）**不占配额**：那是别人找小鲸鱼，不是它话多。
   * - 未点名的（机会主义插话）**占配额**，用于 `maxPerHour` / `minIntervalMs` 限流。
   *
   * @param {string} chatId
   * @param {number} at
   * @param {boolean} addressed
   * @param {string} [text] 这条回复**说了什么**；用于维护「她最后一条是不是问句」
   *   （见 `ChatState.lastBotWasQuestion`）。拿不到正文就**省略**，不要传空串。
   */
  noteReplied(chatId, at, addressed, text) {
    const state = this.state(chatId);
    if (addressed === true) {
      state.noteBotMessage(at, text);
      // ★ 票C（2026-10-15）：**被点名的回复**额外开一个专注窗口。
      // 用户实测「@ 完她之后，我后续发的没啥回的可能性了」—— 因为票A/票B 都不触发，
      // 冷清群里分数（8~15）永远够不到 50。这一笔之后，她刚回过话的
      // `focusWindowMs`（本部署 60 秒）之内，别人再接话就能靠 focus 通道续上。
      state.noteAddressedReply(at);
    } else state.noteSpeak(at, text);
  }

  /**
   * 「对方还没说完」的标记是否有效（2026-11-01）。
   *
   * 三条同时成立：标记在、`now - at` 在 TTL 内（**负年龄也算失效**：时钟倒退时
   * 不该让它永远粘住）、连续次数没到上限。
   */
  #incompleteActive(state, now) {
    const mark = state !== null && typeof state === 'object' ? state.incomplete : null;
    if (mark === null || typeof mark !== 'object') return false;
    const at = Number(mark.at);
    const count = Number(mark.count);
    if (!Number.isFinite(at) || !Number.isFinite(count)) return false;
    if (count >= INCOMPLETE_MAX_FOLLOWUPS) return false;
    const age = now - at;
    if (!(age >= 0 && age <= INCOMPLETE_TTL_MS)) return false;
    return true;
  }

  /**
   * 记一次「还没说完」（网关在 precheck 答「等」时调）。
   * @param {string} chatId
   * @param {number} [at]
   * @returns {number} 连续第几次
   */
  noteIncomplete(chatId, at = Date.now()) {
    return this.state(chatId).noteIncomplete(at);
  }

  /** 清掉「还没说完」的标记（判官给出结论 / 她说了话）。 */
  clearIncomplete(chatId) {
    this.state(chatId).clearIncomplete();
  }

  /**
   * 取这个会话**实际生效**的配置：全局配置 + 该会话的覆盖（浅合并）。
   *
   * 所有闸门都必须走这里，**不能直接读 `this.config`** ——
   * 否则"按群覆盖"就只对改到的那几处生效，漏掉的那几处仍然按全局走，
   * 表现出来就是"我改了门槛但它还是不说话"，而且很难查。
   *
   * 热路径：没配覆盖时直接返回全局对象（不新建），配了才做一次浅拷贝。
   * @private
   */
  #cfgFor(chatId) {
    const override = this.overrides.get(chatId);
    if (override === undefined) return this.config;
    return { ...this.config, ...override };
  }

  /**
   * **当前该拿多少攒劲儿分** —— 纯读取，不改状态。
   *
   * `min(cap, 计数 × step)`，四项全部取有限非负值（配置里写了负数/字符串/undefined
   * 一律当 0 或默认，绝不因此把分算成 NaN —— NaN 会让 `>= threshold` 恒 false，
   * 那是"静默哑掉"，最难查的一类）。
   *
   * @param {string} chatId
   * @returns {number}
   */
  declineBonus(chatId) {
    const state = this.state(chatId);
    const cfg = this.#cfgFor(chatId);
    const step = nonNegative(cfg.decline_bonus, defaultTriggerConfig().decline_bonus);
    const cap = nonNegative(cfg.decline_bonus_cap, defaultTriggerConfig().decline_bonus_cap);
    if (step === 0 || cap === 0) return 0;
    const raw = state.declineCount * step;
    /**
     * ⚠️ **不变量检查**：cap < 阈值 ⇒ "最终必然开口"不成立（见 `decline_bonus` 的注释）。
     * 只 warn 不抛 —— 这是个旋钮，不是错误；但**必须留痕**，否则线上表现是
     * "配了攒劲儿却还是不说话"，而日志里一个字都没有。
     */
    const threshold = nonNegative(cfg.threshold, 50);
    if (cap < threshold && !this.#declineCapWarned) {
      this.#declineCapWarned = true;
      this.log('warn', 'decline_bonus_cap 低于判定阈值 ⇒ 攒劲儿【不能保证】最终开口', {
        cap, threshold, chatId,
      });
    }
    return Math.min(cap, raw);
  }

  /**
   * 记一次**否决**（判定了、闸门放行过、结论是"不说"）。
   *
   * 限流：距上次计数 **≥ `decline_bonus_min_gap_ms`** 才 +1。没到点**原样返回**当前
   * 加分（计数不变）—— 所以"刷屏 20 条"和"慢慢说 2 条"拿到的分是一样的。
   *
   * ⚠️ **不要**把这里当成"每条消息 +1"的计数器用：它刻意是**有节流的时间积分**。
   *
   * @param {string} chatId
   * @param {number} at 这条被否决的消息的时刻
   * @returns {boolean} 这次是否真的计数了
   */
  noteDecline(chatId, at) {
    const state = this.state(chatId);
    const cfg = this.#cfgFor(chatId);
    const now = Number.isFinite(at) ? at : this.now();
    const gap = nonNegative(cfg.decline_bonus_min_gap_ms, defaultTriggerConfig().decline_bonus_min_gap_ms);
    /**
     * ⚠️ **`gap = 0` 的语义**：按"不做时间限流"办，而不是"整条路关掉"。
     * 想整条关掉就设 `decline_bonus = 0`（那时加分恒 0，计数涨不涨都无害）。
     * 这两个语义必须分开写清楚，否则配 0 的人不知道自己得到的是哪一种。
     */
    if (state.lastDeclineAt > 0 && gap > 0 && now - state.lastDeclineAt < gap) return false;
    state.declineCount += 1;
    // 取最大值：迟到的旧消息不许把这个"节流闸"拉回过去（同 `noteBotMessage` 的道理）。
    if (now > state.lastDeclineAt) state.lastDeclineAt = now;
    return true;
  }

  /**
   * 纯算术闸门。返回是否放行及原因（原因用于日志与测试断言）。
   *
   * ⚠️ 它**只回答"现在允许不允许说话"**（准入 / 预热 / 配额 / 冷却 / 间隔），
   * 不再回答"这话题值不值得说" —— 后者是打分层的事。
   * 2026-10-07 从这里删掉了 `quiet-hours` 与 `burst-too-small` 两道闸门。
   * @private
   */
  #gate(message, state) {
    const cfg = this.#cfgFor(message.chatId);
    const now = message.at;

    // 准入检查排在最前：它是最根本的约束（"这个会话根不允许我主动说话"），
    // 而且**必须在扣配额之前**判——否则被拦下的发言会白烧掉小时配额。
    let permitted;
    try {
      permitted = this.allowed(message.chatId) !== false;
    } catch (error) {
      // 准入判定本身炸了要当"不允许"，而不是放行。
      this.log('warn', `主动发言准入判定失败 ${message.chatId}`, {
        error: describeError(error),
      });
      permitted = false;
    }
    if (!permitted) return { allowed: false, reason: 'not-permitted' };

    // **被直接点名（@ / 私聊 / 喊名字）时，跳过下面所有限流闸门。**
    //
    // 道理：这些都是**直接请求**，不该被 warming-up / 配额 / 冷却 / 最小间隔 挡住。
    // 那些闸门只该约束**机会主义插话**（群里没人说话时别硬插）。
    //
    // 实测踩过两次：
    //   - 测试群连发「小鲸鱼在不在」→ 闸门回 `burst-too-small(1/3)`（明明在叫它）
    //     → 那道闸门 2026-10-07 已**整条删除**
    //   - 私聊消息被两条通道同时响应 → 小鲸鱼回两条（那条 bug 的另一半在 decide 里修）
    const isPrivateChat = message.kind === PRIVATE;
    /**
     * ⚠️ **2026-10-13 03:2x 改（用户拍板 + 授权动 engine.mjs）**：
     * **引用回复时，`@` 不算"被点名"。**
     *
     * 原因（用户发现的第二个结构性问题，原话）：
     * > 「**引用不一定回，但是引用默认 at 别人，所以还得做排除**」
     *
     * QQ 引用别人的消息时**会自动带上一个 `@`**，而 `protocol.mjs` 的
     * `detectMention` 只认真 `at` 段、`mentioned` 又把"引用回复我"也算进去
     * ⇒ **"手打的 @我" 和 "引用自动带的 @" 在同一时刻分不开**。
     *
     * 实测现场（用力到处扣扣群，用户截图）：
     * ```
     * 小鲸鱼:   这两句吊胃口吊得挺足，正片呢
     * 吕子翔: [引用小鲸鱼那句] @小鲸鱼   ← 这个 @ 是引用时【自动加上】的，他没在叫她
     * 小鲸鱼:   「在呢，没掉线…」     ← 误判（以前这行会被 addressed 直接放行）
     * ```
     *
     * ⚠️ 这个排除**不是新发明**：`gateway.mjs` L404 早就在用同一个表达式
     * （`isExplicitAt = mentioned === true && replyToSelf !== true`，注释写着
     * 「引用我但没打字更可能是手滑」）—— 这里只是把同一条口径搬到闸门上。
     *
     * ⇒ 受影响的是"引用我 **且带** `@`"这一类：它**不再**被闸门直接放行，
     *   而是**走到打分层**按内容算分（`replyToSelf` 那一路给 `relevance +35`）。
     */
    const addressed =
      (message.mentioned === true && message.replyToSelf !== true)
      || isPrivateChat || mentionedByName(message, this.names);

    if (addressed) {
      state.thresholdPassed = true;
      return { allowed: true, reason: 'addressed', addressed: true };
    }

    /**
     * 2026-11-01：「对方还没说完」的标记还挂着 ⇒ **跳过阈值**，直接交给 precheck 再看一眼。
     *
     * 为什么不加分：闸门（配额/冷却/间隔）在打分**之前**，加分只解决"够不够阈值"，
     * 解决不了"能不能走到打分"。而这条标记的语义是"上一句没说完，这一句必须再看一次"，
     * 所以直接放行最贴切，也不引入新的分值旋钮。
     *
     * 位置：放在准入/点名之后 —— 被禁用（`not-permitted`）和热身（`warming-up`）照样管得住它。
     */
    if (this.#incompleteActive(state, now)) {
      state.thresholdPassed = true;
      return { allowed: true, reason: 'incomplete-followup' };
    }

    if (!state.thresholdPassed) {
      if (state.userMessages < cfg.afterUserMsgCount) {
        return { allowed: false, reason: `warming-up(${state.userMessages}/${cfg.afterUserMsgCount})` };
      }
      state.thresholdPassed = true;
    }

    // ⚠️ 这里原本还有两道闸门，2026-10-07 按用户拍板**删除**：
    //   - `quiet-hours`：本部署早就显式关掉了（用户是深夜活跃型），留着只会误导
    //   - `burst-too-small`：它把"顺口接一句"硬挡了（群里只有一个人说话时永远不够条数）
    // 现在"这话题值不值得接"完全由打分层（`heuristic-gauge`）回答。
    //
    // 判定顺序 = 拒绝理由的「根本性」顺序：越根本越先报，日志才看得出真因。
    // 已经说够一小时配额时，"是不是刚说过话"根本无关紧要。
    if (state.speaksWithin(now, 60 * MINUTE) >= cfg.maxPerHour) {
      return { allowed: false, reason: 'hourly-cap' };
    }
    // 流逝时间夹到 0 下限：消息时间戳可能早于机器人上次发言（WS 重连补发、
    // 跨机时钟偏差）。不夹的话差值为负、恒小于阈值，这条会话会被永久判为
    // 「冷却中」，从此再也不说话。
    // 聊上了（专注度高）时，间隔降到几秒 —— 用户实测「聊起来几秒一条才正常」。
    // 冷启动（机会主义插话）仍保持长间隔防刷屏。用 min() 尊重 config 里更短的值（如测试设 0）。
    const focusHigh = this.#focusValue(message, state) >= (cfg.focusSpeakThreshold ?? 0.5);

    const sinceBot = Math.max(0, now - Math.max(state.lastBotAt, state.lastSpeakIntentAt));
    const effectiveCooldown = focusHigh
      ? Math.min(cfg.cooldownAfterBotMs, cfg.focusCooldownMs ?? 3_000)
      : cfg.cooldownAfterBotMs;
    if (sinceBot < effectiveCooldown) {
      return { allowed: false, reason: 'cooldown-after-bot' };
    }
    const sinceSpeak = Math.max(0, now - Math.max(state.lastSpeakAt, state.lastSpeakIntentAt));
    const effectiveMinInterval = focusHigh
      ? Math.min(cfg.minIntervalMs, cfg.focusMinIntervalMs ?? 3_000)
      : cfg.minIntervalMs;
    if (sinceSpeak < effectiveMinInterval) {
      return { allowed: false, reason: 'min-interval' };
    }

    return { allowed: true, reason: 'ok' };
  }

  /**
   * 打分并给出判定结果。**不发言** —— 说什么、怎么回，一律交给会话（agent）。
   * @private
   */
  async #decide(message, state, transcript, addressed, incompleteFollowup = false) {
    const chatId = message.chatId;
    // 并发排队由 `decide()` 负责（这里不再自己管 inFlight）。
    state.gauges += 1;
    try {
      const focus = this.#focusValue(message, state);
      const decision = await this.gauge({
        chatId,
        kind: message.kind,
        userId: message.userId,
        transcript: transcript.render(20),
        recent: transcript.snapshot().slice(-20),
        now: message.at,
        // 强相关信号必须从**触发消息**上带下来。
        //
        // gauge 里 `mentioned` / `nameMentioned` / `replyToSelf` 各占 +60/+55/+35，
        // 但早先引擎**从来没传过它们**（只传 chatId/kind/transcript/recent/now/stats），
        // 于是那三个加成是死代码 —— 实测表现：用户在群里喊「小鲸鱼在不在」，
        // 相关分是 0，判定沉默。
        // ⚠️ 2026-10-13 03:2x：**引用回复时，那个"自动带的 @"不算被点名**
        //    —— 见 `#gate` 里 `addressed` 的同一条排除。判定层（`heuristic-gauge`）
        //    也认 `mentioned`（它给 `+60`），所以**这里必须一起给"修正过"的值**，
        //    否则闸门放开了、打分层却还按 `+60` 算 ⇒ 那条消息照样直接过线
        //    （实测：`60 + 1.9 = 61.9` ≥ 50，误判照旧）。
        //
        //    ⚠️ `message` 本身**不动**（别去改它）：`#focusValue()` 等处仍要看原始的
        //    `mentioned` / `replyToSelf`。这里只改**交给判定层的那份投影**。
        mentioned: message.mentioned === true && message.replyToSelf !== true,
        nameMentioned: mentionedByName(message, this.names),
        replyToSelf: message.replyToSelf === true,
        /**
         * 小鲸鱼最近的发言时间戳（含被动回复）。
         *
         * 判定层用它算存在感惩罚（防话痨）。**必须由引擎带进来**：小鲸鱼自己的消息
         * 不进转录（`fromSelf` 在 push 之前就 return 了），gauge 光看窗口永远数不到
         * 自己说过话 —— 那条惩罚曾经因此恒为 0，是死代码（2026-10-07 查实）。
         */
        selfAt: state.botAt.slice(),
        /**
         * 小鲸鱼刚说过话吗（专注窗口内）。
         *
         * 给"短反应批次"的豁免用：整窗都是「可以」「嗯」时，**只有没人在跟我说话**
         * 才该沉默，而"我刚问完/刚说完"同样是有人在跟我说话（账本 §7.3 ①）。
         */
        botSpokeRecently: this.#spokeRecently(state, chatId),
        /**
         * **「攒劲儿」加分**（2026-10-14，第 6 项）。
         *
         * 为什么由引擎带进来、而不是判定层自己算：判定层（`heuristic-gauge`）是**纯函数**，
         * 它看不到"闸门放行过几次、距上次计数多久"——那是跨消息的时序状态，
         * 只存在于 `ChatState` 里。这里给的是**已攒好的值**（`min(cap, 计数 × step)`），
         * **不含本次否决**（本次否决要下一条才算数，见 `#decide` 里的结算顺序说明）。
         *
         * ⚠️ 必须在 `await this.gauge(...)` **之前**取值：判定层要拿它一起算总分
         * （攒够了就在这一条开口），所以它不能是"判定跑完再补"的东西。
         */
        declineBonus: this.declineBonus(chatId),
        /**
         * **按群的打分配置覆盖**（2026-10-16）。
         *
         * 走 `#cfgFor(chatId)` —— 和闸门/配额那一半**同一个来源**，
         * 保证"按群覆盖"这一件事在两层之间**不会漂移**。
         * `heuristic-gauge` 里它优先级最高（见那里的 `cfg` 那行）。
         *
         * ⚠️ 不配时是 `undefined` ⇒ 打分行为与改动前**逐字一致**。
         */
        gaugeOverrides: this.#cfgFor(chatId).gauge,
        // 专注度：兴趣没触发时，靠它决定「聊上了要不要接一句」。
        focus,
        stats: {
          speaksLastHour: state.speaksWithin(message.at, 60 * MINUTE),
          maxPerHour: this.#cfgFor(chatId).maxPerHour,
          userMessages: state.userMessages,
        },
      });

      // 说不说，三条任一成立即可（对齐 MaiBot 的 interest / focus 双通道，再加"被点名必回"）：
      //   1. 被点名（@ / 私聊 / 喊名字）—— 明确请求，必回
      //   2. 打分够 —— 内容值得接（`judge` 分数过阈值时返回 `speak: true`）
      //   3. 专注度够 —— 聊上了，续一句
      //
      // 只认 `speak: true` 这个明确信号。措辞已改由会话生成，所以 `text` 字段
      // 不再是"要不要说话"的依据（它只是判定层留下的兜底文案）。
      const focusEnough = focus >= (this.#cfgFor(chatId).focusSpeakThreshold ?? 0.5);
      /**
       * ---- 「攒劲儿」结算（2026-10-14，第 6 项加分）
       *
       * ## 为什么挂在这条线上（⚠️ 位置是本次的硬要求之一）
       *
       * 它必须在 **`#gate` 放行之后**（这条线以下都是"闸门已经放行"）：
       * `cooldown-after-bot` / `min-interval` / `hourly-cap` 挡掉的消息**连打分都没进**，
       * 启发式**根本没机会否决** ⇒ **它们不是否决**（实测白挡 61 条，用户 2026-10-14 点名要求）。
       *
       * 也要在 `await this.gauge(...)` **之后**：`decision === null` 表示"压根没打分"
       * （窗口空 / 命中"别说话" / 打分关闭）—— 那同样不是"否决"。
       *
       * ## 结算顺序（顺序不能换）
       *
       * ```
       * ① bonus = 交给判定层的【已攒】加分     ← 已在上面 `gauge({... declineBonus})` 里带走
       * ② 判定层把它加进总分 ⇒ decision.speak  ← 攒够了就在这一条开口（唯一的口径）
       * ③ 若判定层说"不说" ⇒ noteDecline() 计数 +1  ← 限流在这里生效
       * ④ 若她说了话 ⇒ 计数不清（清账在 noteBotMessage，见那里的理由）
       * ```
       *
       * ⚠️ **`decision.score` 是【含攒劲儿的最终分】**（判定层在 `raw` 上加的），
       * 所以这里**绝不能再加一遍** —— 引擎只负责把"已攒好的加分"带进请求、
       * 并在判定层没加时抽掉发言。双重计入会让开口时机提前一整轮，
       * 而日志上完全看不出来（分是对的、行为是错的）。
       *
       * ⚠️ **`declineBonusBefore` 必须在这里取值**（不是判定跑完再取）：
       * `noteDecline()` 会让计数 +1，取晚了拿到的就是"下一条"的值。
       */
      const declineBonusBefore = decision === null ? 0 : this.declineBonus(chatId);
      const scoredFinal = decision?.speak === true || (
        decision !== null
        && typeof decision.score === 'number' && Number.isFinite(decision.score)
        && typeof decision.threshold === 'number' && Number.isFinite(decision.threshold)
        && decision.score >= decision.threshold
      );
      // 4. 上一句还没说完（2026-11-01）—— 这一条是续写，必须再过一次 precheck
      const speakFinal = addressed || scoredFinal || focusEnough || incompleteFollowup;
      const reasonFinal = speakFinal
        ? (incompleteFollowup ? 'incomplete-followup' : (addressed ? 'addressed' : (scoredFinal ? 'scored' : 'focus')))
        : 'below-threshold';
      // ★ 2026-10-16：**判定说"要说"的这一刻就把名额占住。**
      //
      // ⚠️ 位置是这次修复的要点：必须在这里（已经算完 `speakFinal`、就在返回之前），
      //    因为 `#gate` 的下一次检查发生在下一个 `handleInbound` 里 ——
      //    而那个时刻可能**远早于**本轮回复真正发出去、网关回调 `noteReplied` 的时刻。
      //    挂晚了（比如挂在网关的 `#send` 之后）就还是堵不住突发。
      //    完整机制见 `noteSpeakIntent()`。
      if (speakFinal) state.noteSpeakIntent(message.at);
      // 被判定了、且结论是"不说" ⇒ 这才叫一次否决。
      // ⚠️ 2026-11-01：「没说完 ⇒ 强制再问一次 precheck」这一条**不算否决**
      // （分歧是打分器给的，不是她判断"这话不值得接"），否则每续一次都会白攒一次劲儿。
      if (decision !== null && decision.speak !== true && !incompleteFollowup) {
        this.noteDecline(chatId, message.at);
      }
      const declineBonusAfter = decision === null ? 0 : this.declineBonus(chatId);
      const declineCountAfter = this.state(chatId).declineCount;

      // 打分结论无论说没说都留档：`score`/`threshold` 是「为什么没回」的头两个答案。
      const gaugeEntry = {
        at: message.at,
        chatId,
        event: 'gauge',
        speak: speakFinal,
        score: numberOrNull(decision?.score),
        threshold: numberOrNull(decision?.threshold),
        focus,
        addressed,
        ...flattenDetail(decision?.detail),
        // 攒劲儿的当场快照（摊平进同一个对象，理由同 `detail`：快照只留顶层标量）。
        // ⚠️ `d_bonus` 是【加上去的那个数】（本次生效值），`d_declineBonus` 是加完之后
        // 的累计值 —— 两个都要有，否则"这次加了多少"与"现在攒到多少"得靠推理。
        d_bonus: declineBonusBefore,
        d_declineBonus: declineBonusAfter,
        d_declineCount: declineCountAfter,
        // 模式 2 的预检结论（`pc_*`）：**这条路上还拿不到**（预检在网关、更晚才跑）。
        // 网关跑完会调 `annotateLastGauge()` 把 `pc_*` 补进**这个对象**
        // —— 所以最终落在 journal / 快照里的那条是带预检结论的。
        // 不这么做的话，"precheck 放行"与"压根没有 precheck"长得一模一样。
        ...(this.judgeMode === 'heuristic' ? {} : { pmode: this.judgeMode }),
      };
      // 留引用给 `annotateLastGauge()`。
      // ⚠️ **必须用 `#record` 的返回值**：`#record` push 的是 `{...entry, at}` 这份**拷贝**，
      // 拿传进去的那个对象去补字段，补的是一份没人读的副本（踩过）。
      // 见 `#record` 的注释。
      this.lastGaugeEntry = this.#record(gaugeEntry);
      this.log('debug', `判定${speakFinal ? '回复' : '沉默'} ${chatId}`, {
        reason: reasonFinal,
        score: numberOrNull(decision?.score),
        focus,
        bonus: declineBonusBefore,
      });
      // ⚠️ 这里原来返回的是 `{speak, reason, score, focus, addressed}` ——
      // **没有 `threshold` 和 `detail`**。模式 2 的预检要求"分数（含 `detail` 里那几项）
      // 都要塞进那一次请求的提示词"（用户 2026-10-13 的硬约束），而网关是在
      // `engine.decide` **之后**才做预检的 ⇒ 那两个字段只有从这里能拿到。
      // （纯加法：既有调用方一个都没读它们，模式 1 的行为不变。）
      return {
        speak: speakFinal,
        reason: reasonFinal,
        score: numberOrNull(decision?.score),
        threshold: numberOrNull(decision?.threshold),
        detail: decision?.detail ?? null,
        focus,
        addressed,
      };
    } catch (error) {
      // 判定炸了不该炸掉消息处理链路。被点名的仍然回（明确请求），否则沉默。
      this.#record({ at: this.now(), chatId, event: 'error', phase: 'gauge', error: describeError(error) });
      this.log('warn', `判定失败 ${chatId}`, { error: describeError(error) });
      return { speak: addressed === true, reason: 'error', addressed };
    }
  }

  /**
   * 计算专注度：机器人最近发言后，别人接话（回复/喊名字）时专注度升高。
   *
   * 这是「聊上了」的续接信号 —— 兴趣打分没触发时，靠它决定要不要接着聊。
   * 对应 MaiBot 的 `focus_value`：兴趣（interest_value）之外的第二个触发通道，
   * 让小鲸鱼插完一句话后、别人接她的话时，能继续聊下去而不是掉线。
   *
   * ## ⚠️ 2026-10-12 重写：时间票不再无条件给
   *
   * 原来 `#spokeRecently` 那一票**无条件 +0.5**，而它单独就恰好等于
   * `focusSpeakThreshold`（0.5）⇒ `focusEnough` **恒真** ⇒ 她说完话后专注窗口内
   * （本部署 toml `focusWindowMs = 60000`）**群里任何一条消息都让她回一轮**，
   * 完全不过打分。这是"她占群消息 31.5%"的直接原因。
   *
   * 现在那一票**只在「她最后一条是问句/请求」时才给**：
   * 真正要保的场景只有一个 —— **她问了话 → 别人简短作答 → 她别掉线**
   * （用户 2026-10-11 原话场景：「小鲸鱼问『需要我去通知主会话吗』→ 用户答『好啊』→ 被拒」）。
   * 她只是评论了一句、别人接着聊别的，**不该算"在接她的话"**。
   *
   * 另外加了「疲惫」（MaiBot 的 `_message_threshold`，见 `#focusExhausted`）：
   * 同一个专注窗口里她已经说够 `focusMaxSpeaksPerWindow` 条 ⇒ 时间票不再给。
   *
   * @param {object} message
   * @param {ChatState} state
   * @returns {number} 0-1
   */
  #focusValue(message, state) {
    let focus = 0;
    // 别人引用回复小鲸鱼 → 明确在接小鲸鱼的话。**这一票仍然无条件**（2026-10-12 没动它）：
    // 那是"有人真的在回她"，与"她刚才那句是不是问句"无关。
    if (message.replyToSelf === true) focus += 0.5;
    // 别人紧接小鲸鱼发言（专注窗口内）→ **仅当她最后一条是问句/请求**时才算在接她的话。
    const recencyVote =
      state.lastBotWasQuestion === true &&
      this.#spokeRecently(state, message.chatId) &&
      !this.#focusExhausted(state, message.chatId);
    if (recencyVote) focus += 0.5;
    // ★ 票C（2026-10-15）：**她刚被点名并回过话** → 专注窗口内也算"在跟她聊"。
    //
    // 为什么需要第三票：用户实测「@ 完她之后，我后续发的没啥回的可能性了」。
    //   票A 要人**引用回复**（`replyToSelf`）；
    //   票B 要她**最后一条是问句**（`lastBotWasQuestion`）。
    // 两个在他那个场景都不成立（他只是普通接话，而她那条结尾是「（歪头）」）⇒ focus 恒 0
    // ⇒ 只能靠打分 ⇒ 而**冷清群的分数只有 8~15，永远够不到 50** ⇒ 她等于哑了。
    //
    // ⚠️ 与票B 的区别：票B 是"她主动抛了个话头（问句）⇒ 保她别掉线"，
    //    票C 是"**别人刚把她叫出来** ⇒ 那这段对话本来就该继续"。
    //    两者都受 `#focusExhausted` 限制 ⇒ 一个窗口内最多被放行 `focusMaxSpeaksPerWindow` 条
    //    （默认 3）⇒ 不会退化成刷屏。
    const addressedRecencyVote =
      this.#spokeAddressedRecently(state, message.chatId) &&
      !this.#focusExhausted(state, message.chatId);
    if (addressedRecencyVote) focus += 0.5;
    return Math.min(focus, 1);
  }

  /**
   * 「疲惫」：同一个专注窗口里她**自己已经说够了**几条 ⇒ 不再靠 focus 的时间票放行。
   *
   * 对应 MaiBot 的 `_message_threshold`（在专注里发够 N 条 ⇒ 退出专注）。
   * 没有它的话，她自己每说一句都会刷新窗口 —— 只要她一直是最后一个说话的人
   * 且那句是问句，时间票就能无限续期（"她一回话窗口还续期"）。
   *
   * 上限取 `focusMaxSpeaksPerWindow`（默认 3，可配置；见 `defaultTriggerConfig`）。
   * 数的是 `state.botAt`（含被动回复）—— 被动回复同样是"她在群里占的份额"。
   *
   * ⚠️ 它**只掐时间票**，不掐 `replyToSelf` 那一票：
   * 「别人引用回复她 ⇒ +0.5」是不变量（`test/engine.test.mjs` 有测试钉着），
   * 那是"有人明确在回她"，不是"她自己话多"。
   *
   * @param {ChatState} state
   * @param {string} chatId
   * @returns {boolean} true = 说够了，时间票不给
   */
  #focusExhausted(state, chatId) {
    const cfg = this.#cfgFor(chatId);
    const max = Number(cfg.focusMaxSpeaksPerWindow ?? 3);
    // 非正数 / 非数字 ⇒ 关掉这道疲惫判定（而不是把所有人一起挡死）。
    if (!(max > 0)) return false;
    const windowMs = Number(cfg.focusWindowMs ?? 30_000);
    return state.botMessagesWithin(this.now(), windowMs) >= max;
  }

  /**
   * 小鲸鱼是否**刚说过话**（专注窗口内）。
   *
   * 两处用它，所以抽出来（免得两处对"窗口多长"有不同理解）：
   *   1. `#focusValue` 的那 +0.5（聊上了）；
   *   2. 传给 gauge 的 `botSpokeRecently` —— 短反应豁免的一条依据
   *      （「有人跟我说话」包括"我刚说完，这句是在接我"）。
   *
   * 时刻取注入时钟 `now()`，与 `#focusValue` 保持一致。
   *
   * @param {ChatState} state
   * @param {string} chatId
   * @returns {boolean}
   */
  #spokeRecently(state, chatId) {
    const windowMs = Number(this.#cfgFor(chatId).focusWindowMs ?? 30_000);
    if (!(state.lastBotAt > 0)) return false;
    // 流逝时间夹到 0 下限，与 `#gate` 里 `sinceBot` 的算法保持一致：
    // 迟到消息（时间戳早于上次发言）在这里仍然算"刚说过话"，不因为负差而变成另一个答案。
    const elapsed = Math.max(0, this.now() - state.lastBotAt);
    return elapsed < windowMs;
  }

  /**
   * 小鲸鱼是否**刚被点名并回过话**（专注窗口内）—— `#focusValue` 的**票C**用。
   *
   * 与 `#spokeRecently` 的区别（两个都叫"刚说过话"，但**不是一回事**）：
   *   · `#spokeRecently` 看 `lastBotAt` —— **任何**发言（含她自己冒泡、含汇报播报）
   *   · 这个看 `lastAddressedReplyAt` —— **只有被别人叫出来的**那些
   * 票C 要的是后者：**"别人刚找过她" 才该开一段可以接着聊的窗口**；
   * 她自己顺口插一句不该。理由见 `lastAddressedReplyAt` 的字段注释。
   *
   * 用同一个 `focusWindowMs`（本部署 toml = 60000，用户 2026-10-15 认可这个 60 秒）。
   *
   * @param {ChatState} state
   * @param {string} chatId
   * @returns {boolean}
   */
  #spokeAddressedRecently(state, chatId) {
    const windowMs = Number(this.#cfgFor(chatId).focusWindowMs ?? 30_000);
    if (!(state.lastAddressedReplyAt > 0)) return false;
    const elapsed = Math.max(0, this.now() - state.lastAddressedReplyAt);
    return elapsed < windowMs;
  }

  /**
   * 外部可以主动告知「机器人刚刚说话了」——被动回复完成后必须调用，
   * 否则冷却期形同虚设，机器人会在自己刚回完话之后立刻再冒一句。
   *
   * ⚠️ **调用时若能拿到她说的正文，第三个参数一定要传** ——
   * 它决定 `lastBotWasQuestion`（`#focusValue` 的时间票要在"她最后一条是问句"时才给）。
   * 省略 = "只知道她说了话、不知道内容"，此时**保持原值**（不会瞎猜成问句，也不会瞎猜成不是）。
   *
   * @param {string} chatId
   * @param {number} [at]
   * @param {string} [text] 她说了什么
   */
  noteBotSpoke(chatId, at = this.now(), text) {
    this.state(chatId).noteBotMessage(at, text);
  }

  /**
   * 手动触发一次主动发言（例如工作汇报、定时播报）。
   * **绕过闸门**但**计入配额**——这是我们自己决定要说的话，不是机会主义冒泡。
   * @param {object} request
   * @param {string} request.chatId
   * @param {'private'|'group'} request.kind
   * @param {string} request.text
   * @param {string} [request.trigger]
   * @returns {Promise<boolean>} 是否发出
   */
  async forceSpeak({ chatId, kind, text, trigger = 'forced' }) {
    const body = String(text ?? '').trim();
    if (body === '') return false;
    const at = this.now();
    const state = this.state(chatId);
    // 强制发言也有正文（就是 `body`），所以顺手记下"她最后一条是不是问句"。
    state.noteSpeak(at, body);
    try {
      await this.speak({ chatId, kind, text: body, trigger, at });
      this.#record({ at, chatId, event: 'speak', trigger, chars: body.length });
      this.log('info', `主动发言(${trigger}) ${chatId}`, { chars: body.length });
      return true;
    } catch (error) {
      this.#record({ at: this.now(), chatId, event: 'error', phase: 'speak', trigger, error: describeError(error) });
      this.log('warn', `主动发言(${trigger}) 失败 ${chatId}`, { error: describeError(error) });
      return false;
    }
  }
}

/** 只接受有限数字，其余一律 null（日记要能安全落盘）。 */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 取一个**有限的非负数**，坏值退回 `fallback`。
 *
 * 为什么需要它：攒劲儿那三个键是用户手改的 toml 里的值（字符串 / 负数 / 拼错的键名
 * 都可能出现）。`undefined * 6` 是 `NaN`，而 `NaN` 参与比较**恒 false** ——
 * 表现就是"配了攒劲儿却永远不说话"，且日志里一个字都没有。这里一律夹回数字。
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function nonNegative(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    const f = Number(fallback);
    return Number.isFinite(f) && f >= 0 ? f : 0;
  }
  return n;
}

/**
 * 把判定器的 `detail` 摊平成顶层标量，加前缀 `d_`。
 *
 * 摊平是因为落盘快照只保留顶层标量：嵌套对象会被整块丢掉，
 * 于是"压力分多少、存在感惩罚扣了多少"这些最该看的数反而看不到。
 * 前缀用于和引擎自己的字段（`score`/`threshold`/`speak`）区分开。
 *
 * @param {unknown} detail
 * @returns {Record<string, number|boolean>}
 */
export function flattenDetail(detail) {
  if (detail === null || typeof detail !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[`d_${key}`] = value;
    else if (typeof value === 'boolean') out[`d_${key}`] = value;
  }
  return out;
}

/** 判定结果归一化：只接受非空字符串文本，其余一律视为不说话。 */
export function normalizeDecision(decision) {
  if (decision === null || decision === undefined) return null;
  if (typeof decision === 'string') {
    const t = decision.trim();
    return t === '' ? null : t;
  }
  if (typeof decision !== 'object') return null;
  if (decision.speak === false) return null;
  const text = decision.text;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 把模式 2 的预检结论摊平（加前缀 `pc_`）。
 *
 * ⚠️ 与 `flattenDetail` **刻意分开**，理由有两条：
 *   1. 那个函数的口径被测试钉着（"只收有限数字与布尔"），而这里**必须**带上
 *      `verdict` / `source` 两个**字符串** —— 它们才是"谁拍板的"那个答案；
 *   2. 前缀不同，排查时一眼能分出"这个数是打分器给的"还是"预检器给的"。
 *
 * @param {unknown} pc `decision.precheck`
 * @returns {Record<string, string|number|boolean>}
 */
export function flattenPrecheck(pc) {
  if (pc === null || pc === undefined || typeof pc !== 'object') return {};
  const out = {};
  if (typeof pc.verdict === 'string') out.pc_verdict = pc.verdict.slice(0, 20);
  if (typeof pc.source === 'string') out.pc_source = pc.source.slice(0, 20);
  if (typeof pc.model === 'string' && pc.model !== '') out.pc_model = pc.model.slice(0, 60);
  // `ms` / `chars` / `promptChars`：分别是"等了多久""它答了几个字""提示词多长"。
  // 第三个是"上下文确实塞进去了"的量化证据（一次性调用没有别的旁证）。
  for (const key of ['ms', 'chars', 'promptChars']) {
    if (typeof pc[key] === 'number' && Number.isFinite(pc[key])) out[`pc_${key}`] = pc[key];
  }
  if (typeof pc.speak === 'boolean') out.pc_speak = pc.speak;
  return out;
}

/**
 * 安静时段判定 —— **已删除**（2026-10-07）。
 *
 * 原来这里有一个 `isQuietHours(at, cfg)`：默认 `0~7` 点闭嘴。本部署从没启用过它
 * （`CONFIG_SHAPE.proactive` 里显式设成 `null`，因为用户是"夜越深越清醒"的人），
 * 而"看起来支持、实际不认"的旋钮比没有更糟 —— 所以连同配置项一起删掉，
 * 夜里也会说话（这正是用户要的）。
 *
 * 要恢复的话：从 git/账本里捞回这个函数，并在 `#gate` 里重新插一道判断。
 */

/** `HH:MM` 本地时钟（**先加偏移再读 UTC getter** ⇒ 出来就是 UTC+8 的墙上时间）。 */
export function formatClock(at, utcOffsetMinutes = 480) {
  const d = new Date(at + utcOffsetMinutes * MINUTE);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 本地日期键 `YYYY-M-D`，只用来比"是不是同一天"。
 *
 * 抽出来是因为 `formatStamp` 要拿它比两次（条目 vs `now`、条目 vs `now` 的年份），
 * 内联两遍容易漂移。
 *
 * @param {number} at 毫秒时间戳
 * @param {number} utcOffsetMinutes
 * @returns {string}
 */
function localDayKey(at, utcOffsetMinutes) {
  const d = new Date(at + utcOffsetMinutes * MINUTE);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()].join('-');
}

/**
 * 转录行首的**时间戳** —— 当天只给时刻，不是当天就把日期补上。
 *
 * ```
 * 当天     →  `[13:22]`              （和加日期之前一模一样，不加噪音）
 * 不是当天  →  `[10-03 14:30]`
 * 跨年的    →  `[2025-12-31 23:50]`
 * ```
 *
 * ## 为什么需要它（用户 2026-10-13 拍板选了"加日期"这一版）
 *
 * 灌历史之后，安静群的转录里全是**几天前**的消息，而提示词第一句写的是
 * **「群里刚在聊」** —— 那个"刚"是**假的**，模型却没有别的线索能识破：
 * 旧渲染只有 `[HH:MM]`，**没有日期**。
 *
 * 实测跨度（`_qq-judge/_transcript-date-probe.txt`，真实会话数据）：
 *
 * | 会话 | 那 20 条的跨度 | 最后一条距"现在" |
 * |---|---|---|
 * | **测试群 30000012** | `10-03 16:44` → `10-07 23:52` | **5.6 天** |
 * | 私聊 | 约 `10-09 16:45` | 约 4 天 |
 *
 * 加上日期之后，模型能自己看出"这是几天前的"，那句"刚在聊"就不再是唯一线索。
 * 用户原话：「**b，多这几条多不了多少 token**」——只加日期，**不加时间窗**、
 * **不为此做任何截断**（方案 c 已被否）。
 *
 * ## 与 {@link formatClock} 的关系
 *
 * 当天那条分支**逐字等于** `formatClock`（直接复用，免得两处各写一份 HH:MM 会漂移）。
 * `formatClock` 本身**保持原样**（它是 `export` 的，别处/测试在用；见 `engine.test.mjs`）。
 *
 * ## 时区
 *
 * 固定 UTC+8（默认 480），**不用机器本地时区** —— 换机器/换时区时渲染结果不该变。
 *
 * ⚠️ **`now` 必须可注入**（这里**绝不**读 `Date.now()`）：否则"当天"这条分支
 * 在测试里根本钉不住 —— 而它恰恰是最容易写成"永远带日期"或"永远不带"的那个 bug。
 * 「现在」由调用方给，`renderEntries` 那层缺省才填 `Date.now()`。
 *
 * @param {number} at 消息毫秒时间戳
 * @param {object} [options]
 * @param {number} [options.now] **"现在"**（毫秒）。缺省 `Date.now()`
 * @param {number} [options.utcOffsetMinutes] 时区偏移，缺省 480（UTC+8）
 * @returns {string} 形如 `HH:MM` / `MM-DD HH:MM` / `YYYY-MM-DD HH:MM`
 */
export function formatStamp(at, { now = Date.now(), utcOffsetMinutes = 480 } = {}) {
  const clock = formatClock(at, utcOffsetMinutes);
  // 不是有限数就没法判"当天" ⇒ 退回最保守的形态（至少别把日期写错）。
  if (!Number.isFinite(at)) return clock;
  if (!Number.isFinite(now)) return clock;
  // 同一个 UTC+8 日历日 ⇒ 和加日期之前完全一样。
  if (localDayKey(at, utcOffsetMinutes) === localDayKey(now, utcOffsetMinutes)) return clock;
  // 日期用 `at` 自己的 UTC+8 年月日拼，**不经过 `toLocale*`**（那会依赖 ICU/机器本地时区）。
  const d = new Date(at + utcOffsetMinutes * MINUTE);
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(d.getUTCDate()).padStart(2, '0');
  const sameYear =
    d.getUTCFullYear() === new Date(now + utcOffsetMinutes * MINUTE).getUTCFullYear();
  // 只有【跨年】才补年份：同一年的日期不加 `2026-` 前缀，省 token 也更贴人话。
  return sameYear ? `${MM}-${DD} ${clock}` : `${d.getUTCFullYear()}-${MM}-${DD} ${clock}`;
}

/** 把任意异常压成一行可读文本。 */
export function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * 这条消息是否**叫了机器人的名字**（昵称或别名）。
 *
 * 判断依据是触发消息的**正文**（`text`）与原始消息（`raw`）。刻意宽松：
 * 「小鲸鱼在不在」「小鲸鱼？」「@小鲸鱼」都该算。`mentioned`（真正的 @）另有一路
 * 更高的权重（+60），这里只管"用文字喊名字"这种（+45）。
 *
 * @param {{text?: string, raw?: string}} message
 * @param {string[]} names
 * @returns {boolean}
 */
export function mentionedByName(message, names) {
  const list = Array.isArray(names) ? names : [];
  if (list.length === 0) return false;
  const haystack = `${message?.text ?? ''} ${message?.raw ?? ''}`;
  if (haystack.trim() === '') return false;
  for (const name of list) {
    if (name !== '' && haystack.includes(name)) return true;
  }
  return false;
}
