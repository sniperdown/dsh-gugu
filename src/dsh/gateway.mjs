/**
 * QQ ↔ DSH 网关：把 OneBot 事件变成提示词，把回复发回 QQ。
 *
 * 这是插件的真正心脏，也是唯一把三个子系统缝在一起的地方：
 * - `transport`：OneBot 连接（收发）
 * - `router`：访问控制与会话路由
 * - `proactive`：主动发言决策引擎
 * - `responder`：**注入的**会话依赖——"把这句话交给某个会话，拿回回复"
 *
 * `responder` 刻意是注入的：这样网关本身不耦合 DSH 的任何具体 API，
 * 可以用假实现离线测透整条链路，真机上只换一个 responder。
 *
 * @module qq-dsh/gateway
 */
import fs from 'node:fs';

import { normalizeEvent, outboundMessage, segmentsToText, voiceSegment } from '../onebot/protocol.mjs';
import { ACTION, chatIdFromSessionKey, parseChatId, renderPrompt, resolveSessionTarget, truncateReply } from './routing.mjs';
import { createDebouncer } from './debounce.mjs';
import { splitChatId, SEGMENT_PLACEHOLDERS } from '../onebot/protocol.mjs';
import { collectImageSegments, sniffImageMediaType, summarizeRecordSegment, toImageBlocksDetailed } from './media.mjs';
import { collectEmbeddedImages, expandRichText } from '../onebot/rich.mjs';
import { flattenPrecheck, formatStamp, renderEntries, replaceImagePlaceholders } from '../proactive/engine.mjs';
import { DEFAULT_MAX_IMAGES, STICKER_DESC_CHARS, imageKey } from './image-desc.mjs';
import { stripMarkdown } from '../onebot/plain-text.mjs';
import { LAYER_GW_SEND, LAYER_TRANSPORT_ACTION, ledgerHash } from './outbound-ledger.mjs';
import { DEFAULT_PROMPT_CONFIG } from './prompt-config.mjs';

/** 一条入站消息的处理结果，用于日志与测试断言。 */
export const OUTCOME = {
  DISPATCHED: 'dispatched',
  OBSERVED: 'observed',
  IGNORED: 'ignored',
  FAILED: 'failed',
};

/** 没注入出站白名单时的兜底判定器：谁都不放行。 */
const DENY_ALL = () => false;

/**
 * 入站**预取**最多描述几张（2026-10-13）。
 *
 * 与 `image-desc.mjs` 的 `DEFAULT_MAX_IMAGES`(6) 同一个口径 —— 单条消息本来也就
 * 最多收 `MAX_IMAGES_PER_MESSAGE` 张图（`media.mjs`），所以这个上限基本不触发，
 * 留着是为了"一批图"永远有界（预取是 fire-and-forget 的，别让它无限烧视觉调用）。
 */
const PREFETCH_MAX_IMAGES = DEFAULT_MAX_IMAGES;

/**
 * 一轮提示词里最多问几张图的描述（2026-10-13）。
 *
 * **和上面那个是两个不同的东西**：那个管"入站那一批"，这个管"渲染转录时要补的那一批"。
 * 入站预取过、或跨会话表里有的图**不会真的打模型**（静默命中缓存）。
 */
const PROMPT_MAX_IMAGES = DEFAULT_MAX_IMAGES;

/**
 * 在转录的尾部多少条里找"带图的消息"（2026-10-13）。
 *
 * 转录本身最多留 60 条（`Transcript.maxMessages`），先看尾部 30 条足够覆盖
 * "最近 20 条前文"里出现的图 —— 用户的口径是**进 LLM 就带最近 20 条前文**。
 */
const TRANSCRIPT_SCAN_MESSAGES = 30;

/**
 * 上面那批里最多挑几条**带图**的消息去描述（2026-10-13）。
 *
 * 取 6 ≈ `PROMPT_MAX_IMAGES`：一条消息常带 1~2 张，所以正好是
 * "最近几张图"这个量级。更早的图**仍在转录里**，只是保持 `[图片]`
 * （宁可少一个描述，也不在一轮里打十几次视觉调用）。
 */
const TRANSCRIPT_IMAGE_MESSAGES = 6;

/**
 * 「这是一个表情包 md5」的形状（32 位十六进制）。
 *
 * 微信/QQ 的图片原名就是内容 md5，所以这个形状单独拿出来判一下：
 * 库里**有**这条 → 当成表情包引用（发表情包 + 记一次使用）；
 * 库里**没有** → 当成普通文件名/路径，原样交给 `imageSegment`。
 *
 * 判"库里有没有"而不是"像不像哈希"，是为了**绝不猜内容**
 * （同 `image-cache.mjs` 里 `name:` 键那条规矩）。
 */
const STICKER_ID = /^[0-9a-f]{32}$/i;

/**
 * 「主动插话」那句提示词的**内置默认**（用户没在 toml 里配时用它）。
 *
 * ## 为什么把它提出来（2026-10-15）
 *
 * 原来这串字**写死在 `#buildPrompt` 里**，于是"改措辞要动代码"。
 * 用户报「群里小鲸鱼说话生硬」时追到根：她在**被 @ 的回复**里也在遵守
 * 「只回一句、不超过 40 字」—— 而那本该只约束【主动插话】。
 * 机制：这句提示词每次都以 `user/message` 落进会话历史、**永久留在那里每轮重发**
 * （画布 `[6-7]` 那条），所以她读得到、就照着办。
 * ⇒ 现在它可以由 `qq-gugu.toml` 的 `[proactive] interject_prompt` 覆盖。
 *
 * ⚠️ **默认值刻意与改动前逐字相同** —— 没配的部署行为一个字节都不变。
 */
const DEFAULT_INTERJECT_PROMPT =
  '你想接一句话。要求：只回一句、不超过 40 字、像在群里随口接话、'
  + '不要 Markdown、不要解释你在做什么、不要重复别人说过的话。';

/**
 * 「本条消息引用了这条消息：」—— 引用原文那一段的抬头（2026-11-02）。
 *
 * ## 为什么需要这一段
 *
 * 用户报：「引用你似乎现在还看不出？……引用的消息会把引用的原文也带上」。
 * 起因是入站解析把 `reply` 段整段丢掉（`protocol.mjs` 的 `SEGMENT_PLACEHOLDERS.reply = ''`），
 * 于是「引用昨天那句『X』，然后说『这个不行』」到她眼里只剩**孤立的一句"这个不行"**。
 *
 * ## 为什么写死在代码里（而不是 `[prompt]` 配置）
 *
 * `interject_prompt` 那类措辞之所以可配，是因为用户会想改**她说话的样子**；
 * 这一句是**结构标记**（"下面是引用的原文"），不是措辞。多一个配置键 = 多一处
 * 可能对不上（`prompt-config` / `config-fields` / 配置文件三处）。真要改，改这里。
 */
const QUOTE_HEADER = '本条消息引用了这条消息：';

/**
 * 转录里找不到被引用消息时，问一次 NapCat `get_msg` 的超时（2026-11-04）。
 *
 * 为什么只给 1.2 秒：这一次请求挂在**提示词拼装路径**上，对端的延迟直接变成
 * 用户等待回复的延迟。而它要救的场景（引用了很久以前 / 小鲸鱼自己发的消息）
 * 本来就是少数 —— 拿不到就退回"只报 id"，代价是"少一句话"，不是"回不了"。
 * 超时要留够本地 WS 的一次往返（实测同机 < 10ms），又不至于让一轮卡成肉眼可见。
 */
const QUOTE_LOOKUP_TIMEOUT_MS = 1_200;

/**
 * 引用原文缓存：同一个 id 只问一次（成功和**失败**都记）。
 *
 * - TTL 10 分钟：被引用的消息不会变，但缓存不该跟着进程活到天荒地老；
 * - 上限 200 条：失败也要"记一辈子"的话，一条群里被刷屏的坏 id 会无限重问。
 *
 * **负数缓存（问过、没拿到）是故意的**：断线 / 对端不认 `get_msg` 时，
 * 每轮都重问一次 = 每轮白等 1.2 秒。
 */
const QUOTE_CACHE_TTL_MS = 10 * 60_000;
const QUOTE_CACHE_MAX = 200;

/**
 * 同一会话里，完全相同的正文在这个窗口内**只发一次**（2026-10-16）。
 *
 * 取值理由：比任何冷却都短（本部署 `cooldownAfterBotMs` 最小 10 秒、示例群 30 秒），
 * 所以正常对话（"哈哈哈哈"隔几秒再来一句）**几乎不会**撞上它；
 * 而真正的事故形态（同一秒/同一回合重复投递）**一定**落在窗口里。
 */
const SAME_TEXT_WINDOW_MS = 10_000;

/**
 * `#send` 因"同文短窗"被拦下时的返回值。
 *
 * 调用方用它区分"真发出去了"和"被拦了" —— `stats.replies` 只该数真发出去的。
 * 用对象常量而不是 `null`：既能 `===` 判等，也能在日志里看出是什么。
 */
const SEND_SUPPRESSED = Object.freeze({ suppressed: true, reason: 'same-text-within-window' });

/**
 * `send_qq` 的 `kind=image` 允许的图片扩展名（2026-10-26）。
 *
 * 白名单而不是黑名单：**认不出就拒**。理由是"猜 MIME"这条路已经踩过坑
 * （`media.mjs` 从字节嗅探类型，但工具层拿到的可能是个改名文件）；
 * 扩展名不在表里时最省事的处理是**让她自己换一张**，而不是让她发出去一张打不开的图。
 *
 * 为什么没有 svg：QQ 客户端不把它当图片渲染（会变成文件/一片空白），
 * 而 `heic` 同理（iPhone 拍的图得先转 jpg）。
 */
const SEND_IMAGE_EXTS = Object.freeze(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

/** `[send] max_image_mb` 的默认值（10 MB）。超了直接拒，**不截断**。 */
const DEFAULT_MAX_IMAGE_MB = 10;

/**
 * `[send] auto_reply` 的合法取值（B2，2026-10-25）。
 *
 * - `fallback`：工具发过就跳过自动发送，没发过就自动发 + `warn`（默认）；
 * - `always`  ：无条件自动发（老行为，只作回滚）；
 * - `off`     ：只认工具（她没调 `send_qq` = 她不说话）。
 */
export const AUTO_REPLY_MODES = Object.freeze(['fallback', 'always', 'off']);

/**
 * 「这条消息到底说没说话」用的正文 —— **不含 @ 的目标**。
 *
 * 为什么不能直接用 `message.text`：`@` 段现在会渲染成 `@30000001`（看得见 @ 了谁），
 * 那个字符串不是"内容"。而这个判空决定两件事：
 *   1. `@别人` 却没打字 → 仍按空正文丢弃（empty-body）；
 *   2. `@小鲸鱼` 却没打字 → 仍要回，并补一句「（@ 了你，但没说话）」。
 * 直接拿渲染后的 `text` 判空，这两条既有行为都会被悄悄改掉。
 *
 * 合成消息（内部通道）没有 `segments`，回落到 `text` 本身。
 *
 * @param {{segments?: Array<object>, text?: string}} message
 * @returns {string}
 */
function bodyWithoutMentions(message) {
  const segments = Array.isArray(message?.segments) ? message.segments : null;
  if (segments === null) return String(message?.text ?? '').trim();
  return segmentsToText(segments, { keepMentions: false }).trim();
}

/**
 * **模式 3（`inTurn`）**塞进提示词的那一段：把总分当"倾向"交给这一轮自己拍板。
 *
 * 三条口径（都是刻意的）：
 *
 * 1. **是"倾向"，不是命令** —— 所以措辞是"启发式觉得…但由你定"。
 *    写成"必须回"就退化成模式 1，写成"随便"又等于没有信号。
 * 2. **把"总分 vs 阈值"一起给，而且按实际比较说** —— 光给一个 `72.5` 没有意义，
 *    得让它知道门槛在哪、这个分是"过线了"还是"没够"。
 *    ⚠️ **不许无条件写"已经过线"**：28 分配 50 的门槛却写"过线"，
 *    她读了会按"规则已经替我放行"去自我审查（2026-11-02 私聊空回复就是这么来的）。
 * 3. **明确允许弃权**（用户 2026-10-13 的要求）：空回复是合法结果。
 *    模型被叫起来时默认倾向"必须说点什么"，不点明这一条它就会硬凑一句。
 *
 * `score` 拿不到时（打分器返回 `null` 之类）返回空串 —— **宁可不加，
 * 也不要在提示词里出现"倾向：undefined"**。
 *
 * @param {{score?: number, threshold?: number, detail?: object}} decision
 * @returns {string}
 */
/**
 * 模式 3（inTurn）里"要不要接由你自己定"那段提示词。
 *
 * 三条固定指导语从 `[prompt] inturn_note` 读（2026-10-30）；空串 ⇒ 用内置原文。
 * 分数/构成那两行恒由代码拼 —— 它们是运行期数据，不是措辞。
 *
 * 门槛那句**分三种说法**（2026-11-02）：过线 / 没够 / 没有有限门槛（不提）。
 * 之前无条件拼"已经过线"，于是 28 分配 50 的门槛也在说"过线" —— 模型读到
 * 自相矛盾的裁定，反而选择闭嘴。措辞必须跟实际比较结果一致。
 *
 * @param {object} decision
 * @param {string} [note] `[prompt] inturn_note` 的配置值
 * @returns {string}
 */
function inTurnLeaning(decision, note = '') {
  const score = Number(decision?.score);
  if (!Number.isFinite(score)) return '';
  // ⚠️ 不写 `Number(decision?.threshold)`：引擎拿不到门槛时给的是 `null`，
  // 而 `Number(null) === 0` —— 那会凭空冒出一个"门槛 0 分"（已踩过）。
  const threshold = decision?.threshold;
  const lines = [
    '【要不要接，由你自己定】',
    `规则打分给这一条打了 ${score} 分`
    + (Number.isFinite(threshold)
      ? (score >= threshold
        ? `（门槛 ${threshold} 分 —— 已经过线）`
        : `（门槛 ${threshold} 分 —— 没够，它觉得这个点可有可无）`)
      : '')
    + '。这只是**一个倾向**，不是命令：',
  ];
  const detail = decision?.detail;
  if (detail !== null && typeof detail === 'object') {
    const bits = [];
    for (const [key, label] of [
      ['relevance', '和小鲸鱼的相关度'],
      ['content', '内容分'],
      ['presence', '她最近发言的存在感'],
      ['questions', '问句数'],
      ['techHits', '技术词命中'],
    ]) {
      const v = detail[key];
      if (typeof v === 'number' && Number.isFinite(v)) bits.push(`${label} ${v}`);
    }
    if (bits.length > 0) lines.push(`（分数构成：${bits.join(' · ')}）`);
  }
  lines.push(
    typeof note === 'string' && note.trim() !== '' ? note : DEFAULT_PROMPT_CONFIG.inturnNote,
  );
  return lines.join('\n');
}

/**
 * 这一轮的正文是不是**只为了说"别发"** —— `[不说话]`（2026-11-02）。
 *
 * 两种用法（都收敛到这里）：
 * 1. 没什么想说的 ⇒ 只回 `[不说话]`，这一轮一个字都不发到 QQ；
 * 2. 已经用 `send_qq` 发过东西 ⇒ 正文写 `[不说话]`，压掉重复的自动发送。
 *
 * 判定口径与 `free-time.mjs` 的 `quietMark` **逐字一致**（那边是主动轮的参考实现）：
 * 要么整条就是这个标记（允许被空白/全角括号/方括号包着），要么很短且含这个词。
 *
 * ⚠️ **不要改成 `text.includes('不说话')`**：那会把「她说了一堆、末尾顺口提一句
 *    不说话」整条吞掉 —— 丢的是内容，不是静默（free-time.mjs 里记着同一个坑）。
 *
 * @param {string} text 已经 `trim()` 过的正文
 * @returns {boolean}
 */
export function isQuietMark(text) {
  return /^[\s（(【\[]*不说话[\s）)】\]]*$/u.test(text)
    || (text.length <= 12 && text.includes('不说话'));
}

/**
 * 网关。
 */
export class Gateway {
  /**
   * @param {object} options
   * @param {import('../onebot/transport.mjs').OneBotTransport} options.transport
   * @param {import('./routing.mjs').Router} options.router
   * @param {import('../proactive/engine.mjs').ProactiveEngine} options.engine
   * @param {(request: {sessionKey: string, chatId: string, kind: string, prompt: string, restricted: boolean, signal?: AbortSignal}) => Promise<string>} options.responder
   *   把提示词交给该会话并拿回回复文本。抛错表示这一轮失败。
   * @param {(level: string, message: string, meta?: object) => void} [options.log]
   * @param {number} [options.maxReplyChars]
   * @param {AbortSignal} [options.signal]
   */
  constructor({
    transport,
    router,
    engine,
    responder,
    log,
    maxReplyChars,
    // 「主动插话」那句话的措辞（2026-10-15 做成可配）。
    // 留空 ⇒ `#buildPrompt` 用内置的那句（行为与改动前逐字相同）。
    // 为什么要可配：用户发现群里小鲸鱼说话生硬，追到根是这句
    // 「只回一句、不超过 40 字…」—— 而它原来写死在 `#buildPrompt` 里。
    interjectPrompt = '',
    /** 心情模型能看到的聊天记录条数（2026-10-30）：默认 20，0/非法 ⇒ 20。 */
    moodTranscriptMessages = 20,
    /**
     * 每轮提示词里的固定句子（`[prompt]`，2026-10-30）。
     * 只认对象；缺字段/类型不对 ⇒ 用内置默认值（= 搬迁前那些字面量，逐字节相同）。
     */
    promptCfg = null,
    signal,
    mood = null,
    /** 出站白名单判定器（`outbound-allow.mjs` 的 `createOutboundAllow(...)` 产物），由装配方注入；不注入 = 一律拒发。 */
    outboundAllow = null,
    /** 内部通道没给 `replyTo` 时的默认收件人（`private:<QQ>`）；留空 = 只写会话、不推 QQ。 */
    ownerChatId = '',
    // `ctx.attachments`：把入站图片存成 DSH 附件（见 media.mjs），让小鲸鱼真的能看图。
    // 为 null 时不识图，退回 `[图片]` 占位符 —— 没有附件服务的环境照样能跑。
    attachments = null,
    // 「图片 → 一句描述」的描述器（`image-desc.mjs` 的 `createImageDescriber(...)` 产物）。
    // 为 null 时**一个描述都不生成**，全部退回占位符（老行为）。
    imageDescriber = null,
    // **表情包库**（`sticker-library.mjs` 的 `createStickerLibrary(...)` 产物）。
    //
    // 两个用途，都在这里接：
    //   1. **偷**：`handleEvent` 里 fire-and-forget 地把消息里判定为表情包的图落盘进库；
    //   2. **发**：出站图片源写成 `{sticker:'<md5>'}`（或裸 md5）时，从库里取文件路径发出去，
    //      并记一次使用次数。
    //
    // 为 null 时两条路都关掉：照样收、照样回，只是不偷也不认 md5 —— **它绝不能是必需品**。
    stickerLibrary = null,
    // **描述哪些图**：
    //   `'forward'`（默认）只描述**转发里**的图 —— 那些图模型看不见原图，描述是净增益；
    //   `'all'`     连顶层的图也描述（顶层已经有原图投递，等于多花一次视觉调用）；
    //   `'off'`     全不描述。
    imageDescription = 'forward',
    // **出站台账**（`outbound-ledger.mjs` 的 `createOutboundLedger(...)` 产物，2026-10-11 加）。
    //
    // 它回答一个**之前根本不存在的口径**：「这一条到底发了几次、发到哪一层了」。
    // 背景：2026-10-09 16:01:48 小鲸鱼的一条消息在 QQ 上出现两条逐字相同的，
    // 而**出站两头都没有留档**（插件日志不落盘、`stats` 只在内存且每次重载清零、
    // NapCat 日志停在 10-02）⇒ 根因卡在"定不到唯一"。完整报告见
    // `shared/tmp/2026-10-10-出站重复-session-00000000.md`。
    //
    // 为 null 时**一个字节都不写**（没有台账的环境照样收、照样回）——
    // 它绝不能变成必需品，和 `stickerLibrary` / `imageDescriber` 同一条规矩。
    outboundLedger = null,
    // **`QQ → 昵称` 表**（`nicknames.mjs` 的 `createNicknameTable(...)` 产物，2026-10-14 加）。
    //
    // 它解决的是用户 2026-10-14 提的那条：**NapCat 的 at 段不带昵称**
    // ⇒ `@30000002`，模型认不出那是谁（连"@ 的是它自己"都认不出）。
    // 数据只能自己攒：**每条入站消息的 `sender`** 就是一个名字样本
    // （`nickname` / `card` / `user_id`），所以这里在**每条事件**上喂一条进去。
    //
    // ⚠️ **喂在 `normalizeEvent` 之前**，而且**不看这条消息会不会被忽略**：
    //    小鲸鱼**自己发**的消息也要学（`ignoreSelf` 会把它们挡在归一化之外，
    //    但"小鲸鱼的昵称"恰恰是从那些消息的 `sender` 里来的 ——
    //    没有它，`@30000002` 永远渲染不出 `@小鲸鱼`）。
    //
    // 为 null 时一个名字都不查、也不学（@ 段落回退成 `@QQ号`）—— 它**绝不是必需品**，
    // 和 `stickerLibrary` / `outboundLedger` 同一条规矩。
    nicknames = null,
    // ===== 「说不说」的裁量模式（2026-10-13 落地模式 2/3）=====
    //
    // ⚠️ **网关不持有判定逻辑**，只持有两个"过了闸门之后"的零件：
    //   · `judgeMode` —— 决定**要不要**走 precheck、以及提示词里要不要带"倾向"；
    //   · `precheck`  —— 模式 2 的那一次**一次性**轻量调用（`judge-mode.mjs` 的产物）。
    //
    // 刻意**不把 precheck 塞进 `ProactiveEngine`**：闸门与打分都在引擎里，
    // 而"过了阈值之后由谁拍板"是在**消息派发的最后一刻**做的（那时才知道
    // 到底是哪条消息、转录长什么样）。塞进引擎会让它多一个消息正文的入参，
    // 而引擎至今**一个字都不碰正文**（它只存 `message.text` 进转录）。
    //
    // 默认 `'heuristic'` + `null` = **和以前逐字一致**：不调模型、不改提示词。
    judgeMode = 'heuristic',
    /**
     * **私聊单独一套判定模式**（2026-11-01）。空串 = 跟随 `judgeMode`。
     * 用户要的是"群里 precheck、私聊 inTurn"：私聊里让她自己决定这轮说不说。
     */
    judgeModePrivate = '',
    precheck = null,
    /**
     * **判官/启发式决策日志**（2026-11-06，`gauge-log.mjs` 的 `createGaugeLog(...)` 产物）。
     *
     * 为什么挂在网关而不是引擎：这条记录要的是"启发式给的分数 + 判官给的结论"
     * **同一行的快照**，而判官在网关里、在 `engine.decide()` **之后**才跑
     * （理由见下面 `handleEvent` 那段 precheck 的注释）。引擎拿不到判官结论，
     * 网关两样都有 —— 而且"最终发出了什么"也只有在网关里才真的发生了。
     *
     * 为 null ⇒ **一个字节都不写**（默认；由 `index.mjs` 按 `[proactive] gauge_log`
     * 决定要不要注入）。它和 `outboundLedger` / `stickerLibrary` 同一条规矩：
     * **观测设施绝不是必需品**，坏了只能影响它自己。
     */
    gaugeLog = null,
    /**
     * 关系记账（A 段，2026-11-04）。`null` = 不做记账（默认，测试与未注入时）；
     * 由 `index.mjs` 注入一个 ledger 实例开启，**只记**「说过几句 / 认识多久 / 被点名几次」。
     */
    relationLedger = null,
    /**
     * 群聊防抖（2026-11-04）：`true` = 用默认常量（同人 2s / 换人 0.5s / 整批 8s / @ 1s）；
     * `null` = 关（默认，测试保持逐条处理）。只对**群聊、非 @** 生效。
     */
    debounce = null,
    // 会话映射解析器（`chat-sessions.mjs` 的 `createSessionResolver(...)`，2026-10-24 P1-4）。
    //
    // 网关里所有"从会话键反推 chatId / 群还是私聊"的地方都改成问它（表优先、旧前缀兜底）。
    // 为 null ⇒ 全部回退旧前缀逻辑，**与改动前逐字一致**（测试/老调用方不受影响）。
    sessionResolver = null,
    // ===== 「自动发回复」的策略（B2，2026-10-25）=====
    //
    // 现在**两条发送路径并存**：`runTurn` 无条件把她这一轮的输出发出去，
    // 而 `send_qq` 是**另一条**路。她一旦调了工具、这一轮又产出文本 ⇒ QQ 上多一条。
    //
    // 三种取值（真源是 toml 的 `[send] auto_reply`）：
    //   · `fallback`（默认）：**这一轮工具发过 ⇒ 跳过自动发送**；没发过 ⇒ 自动发 + `warn`
    //     （兜底保命："她只输出文本"这类老行为不会变成"她不说话"）。
    //   · `always`：老行为，**无条件自动发**（有重复风险，只作回滚开关）。
    //   · `off`：只认工具，她没调 `send_qq` 就是"她不想说"—— 切这个之前必须改工具描述
    //     （`binding.mjs` 里按本字段切文案），否则她会只输出文本、什么都不发。
    //
    // ⚠️ 判据是「**这一轮**工具发过没有」，不是"这个会话发过没有"—— 见 `toolSendSeq`。
    autoReply = 'fallback',
    // ===== 消息切分（B3，2026-10-25）=====
    //
    // **独立一行**等于这个标记 ⇒ 切成几条发（真源 `[send] split_marker`）。
    // 空串 = 显式关掉。默认 `⟨cut⟩` —— **刻意不用 `---`**：模型很爱把 `---` 当
    // Markdown 水平线写，而且 `stripMarkdown` 会整行删掉它。
    // （2026-10-25 用户拍板：本部署用 `⟨cut⟩`，代码默认值跟着统一 —— 免得
    //  "代码默认"和"线上配置"是两个值，又多一处要分辨哪个才是真的。）
    splitMarker = '⟨cut⟩',
    // 一段回复最多切几条（超出的并进最后一段，**不丢内容**）。
    splitMaxParts = 4,
    // 段间延时（毫秒）。实测**连发会丢段**：2026-10-27 现场，4 段只到 2~3 段，
    // 丢的总是末尾 —— QQ 那边来不及吃。切出来的段本来就是"一口气说几句"，
    // 有间隔反而更像人说话，顺手解决丢消息。
    splitGapMs = 500,
    // ===== 语音转文字（B4 真答案，2026-10-25）=====
    //
    // `voice.mjs` 的 `createVoiceTranscriber(...)` 产物。真机定论过：NapCat 的
    // `record` 段**没有转写**，所以要么"她听不到"，要么本地转写一次。
    // 为 null ⇒ 完全不做（照旧 `[语音（未转写）]`）—— **它绝不能是必需品**，
    // 和 `stickerLibrary` / `imageDescriber` / `outboundLedger` 同一条规矩。
    voiceTranscriber = null,
    // ===== 文字转语音（出站，2026-10-26）=====
    //
    // `tts.mjs` 的 `createTtsSpeaker(...)` 产物（`edge-tts` → mp3）。为 null 或 `enabled:false`
    // ⇒ `send_voice` 工具**直接拒**（"语音没开"），绝不让她自己发现"调了但没声音"。
    // 和 `voiceTranscriber` / `stickerLibrary` 同一条规矩：**不能是必需品**。
    tts = null,
    // ===== `send_qq` 发图的大小上限（2026-10-26，真源 `[send] max_image_mb`）=====
    //
    // 只对**本地文件**生效（能 `stat`）；URL 那一侧拿不到 Content-Length，
    // 而为了量大小先下载一遍会把"一条消息"变成"一次网络请求"，不值 —— 见 `#checkImageSource`。
    maxImageBytes = DEFAULT_MAX_IMAGE_MB * 1024 * 1024,
    // ===== 语音情绪旁路（2026-10-26，`wav2small`）=====
    //
    // `emotion.mjs` 的 `createEmotionSenser(...)` 产物。**只算 arousal、只记录、不进提示词**。
    // 为 null 或 `enabled:false` ⇒ 连 `get_record` 都不调（零成本）。
    // ⚠️ 它挂在**转写之后**做旁路：**不 await**、永不抛 —— 转写和回复绝不能因为它坏掉。
    emotionSenser = null,
    // ===== 「这一轮到底取到回复没有」的诊断（2026-10-28，事故驱动）=====
    //
    // `binding.mjs` 的 `emptyReplyDiagnosis()`（`(sessionKey) => diag|null`）。
    //
    // 为什么要注入：网关只知道"responder 返回了空串"，**分不出**两种完全不同的情况 ——
    //   ① 模型确实决定不说话（正常，别吵）；
    //   ② 它明明说了、但我们没取到（**静默丢消息**，必须能看见）。
    // 而 2026-10-28 20:43 那次线上事故就是 ②：压缩把会话 surface 缩短，
    // 取回复的主路径按条数下标切空了，这里按 ① 处理 ⇒ 一声不响，台账里连
    // `gw-send` 都没有。只有 binder 那边知道真相（`historyShrank` / `streamFrames`），
    // 所以判据从那边注入，**网关不改任何判定逻辑**，只是把"丢没丢"记下来。
    //
    // 非函数 ⇒ 一律当"没有诊断"（行为与接线前逐字相同：空回复照旧静默）。
    diagnoseEmptyReply = null,
    // ===== 引用原文兜底（`get_msg`）的超时（2026-11-04）=====
    //
    // 只有"转录里找不到被引用那条"才会用到它（见 `#primeQuoted`），所以它
    // **不是**每一轮的延迟，而是少数几次的最坏延迟。留成构造参数是为了让
    // 装配方（`index.mjs`）将来能从配置里给；不传就是 1.2 秒。
    quoteLookupTimeoutMs = QUOTE_LOOKUP_TIMEOUT_MS,
  }) {
    this.transport = transport;
    /**
     * 被引用消息的缓存：`id → { at, entry }`（`entry === null` = 问过但没拿到）。
     *
     * 键是 `reply` 段那个**字符串** id（真机形状），不是数字。
     * @type {Map<string, {at: number, entry: any}>}
     */
    this.quoteCache = new Map();
    this.quoteLookupTimeoutMs = Number.isFinite(quoteLookupTimeoutMs) && quoteLookupTimeoutMs > 0
      ? quoteLookupTimeoutMs
      : QUOTE_LOOKUP_TIMEOUT_MS;
    this.router = router;
    this.engine = engine;
    this.responder = responder;
    /**
     * 「这一轮是不是**丢了**回复」的判据（见构造函数参数里那段）。
     * 只记函数；传别的当"没有"—— 热路径上不该出现 `is not a function`。
     */
    this.diagnoseEmptyReply = typeof diagnoseEmptyReply === 'function' ? diagnoseEmptyReply : null;
    /**
     * 最近一次"拿不到回复"的诊断（进快照的 `emptyReply` 段）。
     *
     * 为什么必须落盘：宿主 logger 不落盘（见 `recordProbe` 的同一条理由），
     * 而这件事的全部意义就是"下次再丢，能看见"。`null` = 这个进程还没丢过。
     */
    this.lastEmptyReply = null;
    /**
     * 最近一次「她说 `[不说话]`、这一轮不发」的现场（进快照的 `quietReply` 段）。
     *
     * 为什么要留痕：这条路径的**正确表现就是 QQ 上没消息**，和"坏了/丢消息"
     * 长得一模一样。只靠一句日志（宿主 logger 还不落盘）区分不了
     * 「她主动选择不说」与「回复被静默丢掉」—— 2026-11-02 这一轮新定的规矩，
     * 不留痕以后又是一个查不出来的静默分支。
     */
    this.lastQuietReply = null;
    this.sessionResolver = sessionResolver;
    // 路由只许拿**纯读**查询（这里每消息一次，不能顺手建 id）。
    this.chatLookup = typeof sessionResolver?.lookup === 'function'
      ? (chatId) => sessionResolver.lookup(chatId)
      : null;
    this.log = log ?? (() => {});
    this.maxReplyChars = maxReplyChars ?? router?.config?.maxReplyChars ?? 2000;
    // 心情模型能看到的聊天记录条数（2026-10-30）。非数字/≤0 ⇒ 20（改动前的"看 1 条"太少了）。
    this.moodTranscriptMessages = Number.isFinite(Number(moodTranscriptMessages)) && Number(moodTranscriptMessages) > 0
      ? Math.floor(Number(moodTranscriptMessages))
      : 20;
    // 「主动插话」那句措辞。空 ⇒ 用内置默认（`DEFAULT_INTERJECT_PROMPT`）。
    // 归一化在这里做一次：非字符串 / 纯空白都当作"没配"。
    this.interjectPrompt =
      typeof interjectPrompt === 'string' && interjectPrompt.trim() !== ''
        ? interjectPrompt
        : '';
    // 每轮提示词里的固定句子（`[prompt]`，2026-10-30）。缺字段 ⇒ 内置默认。
    {
      const src = promptCfg !== null && typeof promptCfg === 'object' ? promptCfg : {};
      const pick = (key, fallback) => (typeof src[key] === 'string' && src[key].trim() !== ''
        ? src[key]
        : fallback);
      this.promptCfg = {
        turnGroupHeader: pick('turnGroupHeader', '群里刚在聊：'),
        turnAtHeader: pick('turnAtHeader', '【刚 @ 你的那条】'),
        turnPureAt: pick('turnPureAt', '（@ 了你，但没说话 —— 可能是催你，也可能是看你掉线没有）'),
        inturnNote: pick('inturnNote', ''),
      };
    }
    // ===== 自动发送策略（B2）=====
    // 归一化在这里做一次：非法值 ⇒ 回 `fallback` 并 warn。
    // 为什么**不**默默用 `always`：`always` 是那条"会重复发"的旧行为，
    // 把它当兜底等于"配置打错一个字就悄悄退回最差的形态"。
    this.autoReply = AUTO_REPLY_MODES.includes(autoReply) ? autoReply : 'fallback';
    if (this.autoReply !== autoReply) {
      this.log('warn', `[send] auto_reply 取值不认识（${String(autoReply)}），按 fallback 处理`, {
        supported: [...AUTO_REPLY_MODES],
      });
    }
    // ===== 消息切分（B3）=====
    // 标记归一化：非字符串 ⇒ 空（关）；去掉首尾空白。**不校验具体字符** ——
    // 用户在配置页里填什么都行，只要它"整行出现"。
    this.splitMarker = typeof splitMarker === 'string' ? splitMarker.trim() : '';
    const maxParts = Number(splitMaxParts);
    this.splitMaxParts = Number.isFinite(maxParts) && maxParts >= 1 ? Math.floor(maxParts) : 4;
    const gapMs = Number(splitGapMs);
    this.splitGapMs = Number.isFinite(gapMs) && gapMs >= 0 ? Math.floor(gapMs) : 500;
    this.signal = signal;
    // 没注入判定器 = 没有名单 → 一律拒发（fail-closed，见构造函数注释）。
    this.outboundAllow = typeof outboundAllow === 'function' ? outboundAllow : DENY_ALL;
    this.ownerChatId = String(ownerChatId ?? '').trim();
    this.mood = mood;
    /**
     * 每个会话"最近发出去的正文" —— 供 `#send` 的**同文短窗去重**用（2026-10-16）。
     * 每会话只留**最后一条**（不是列表）：只判"紧接着又来一条一模一样的"，
     * 不做历史指纹库 —— 那既没必要，也会无限涨内存。
     * @type {Map<string, {text: string, at: number}>}
     */
    this.recentSends = new Map();
    /** `send_qq` 的频率闸：chatId -> 上次发送时间。只在内存里，重启归零。 */
    this.sendToolLastAt = new Map();
    /**
     * **B2（2026-10-25）：按会话记「工具发过几次**文字**」的流水号。**
     *
     * `runTurn` 在 `responder()` 前后各读一次本表：**变了** ⇒ 这一轮她走过 `send_qq`
     * ⇒ `fallback` 模式下跳过自动发送（否则 QQ 上会多一条一模一样的）。
     *
     * 为什么用"流水号"而不是布尔：布尔要在轮次结束时清掉，而清理点一旦漏了一处
     * （异常/提前 return），下一次"她没调工具"的轮次就会被错误地当成"发过了" ⇒
     * **静默不回话**。单调递增的计数只有比较、没有复位，漏清理也不会有状态残留。
     *
     * 只在内存里，重启归零（和 `sendToolLastAt` 同一口径）。
     * @type {Map<string, number>}
     */
    this.toolSendSeq = new Map();
    /**
     * **正在由插件自己驱动（`runTurn`）的会话键**（2026-11-02，自动搬运的护栏）。
     *
     * 宿主还会**自己**在同一个会话里跑轮次（子会话交活 / 后台作业结束 / `schedule` 到点 /
     * banner 恢复），那些轮次没人等结果 ⇒ `dsh/auto-relay.mjs` 在 `turn/end` 时补发。
     * 但 `runTurn` 驱动的轮次**本来就会发**，而且它那条路有 `silent`（定时唤醒 / 内部通道）、
     * `send_qq`、`[不说话]` 三套判据 ⇒ 自动搬运必须**让路**，否则
     * ① 同一句话发两遍；② 「她自己的时间」那轮"只观察不说话"的自言自语被推到手机上。
     *
     * 生命周期：`runTurn` 在 `await responder()` 前后加/删。`turn/end` 就发生在那次
     * `await` 里（宿主在轮次结束时**同步**发事件），所以判定时刻标记一定还在。
     * 万一事件晚到（标记已删）：同样的正文会被 `#sendOne` 的「同文短窗」闸拦下
     * ⇒ 也不会真的发两遍，两道保险。
     * @type {Set<string>}
     */
    this.turnsInFlight = new Set();
    /**
     * **最近一条语音段（`record`）的字段摘要**（B4 探针，2026-10-25）→ 进调试快照。
     * `null` = 进程起来之后还没收到过语音。见 `#logRecordSegments`。
     * @type {null | {at: string, chatId: string, count: number, transcribed: boolean, records: object[]}}
     */
    this.lastRecordProbe = null;
    /**
     * 语音转写器（`voice.mjs` 的产物）。`null` = 这条能力没接（照旧占位符）。
     * @type {null | {enabled: boolean, describe: Function, transcribe: Function}}
     */
    this.voiceTranscriber = voiceTranscriber !== null && typeof voiceTranscriber === 'object'
      ? voiceTranscriber
      : null;
    /**
     * 语音合成器（`tts.mjs` 的产物）。`null` = 这条能力没接（`send_voice` 一律拒）。
     * @type {null | {enabled: boolean, describe: Function, synthesize: Function}}
     */
    this.tts = tts !== null && typeof tts === 'object' ? tts : null;
    /**
     * `send_qq` 发图的大小上限（字节）。`[send] max_image_mb` × 1 MB。
     * 只对本地文件生效（URL 量不到大小，见 `#checkImageSource`）。
     */
    this.maxImageBytes = Number.isFinite(Number(maxImageBytes)) && Number(maxImageBytes) > 0
      ? Math.floor(Number(maxImageBytes))
      : DEFAULT_MAX_IMAGE_MB * 1024 * 1024;
    /**
     * 语音情绪旁路器（`emotion.mjs` 的产物）。`null` = 没接（这条路整个关掉）。
     * @type {null | {enabled: boolean, describe: Function, sense: Function}}
     */
    this.emotionSenser = emotionSenser !== null && typeof emotionSenser === 'object' ? emotionSenser : null;
    /**
     * 最近一条**算出来的**情绪（进快照；`null` = 起来之后还没算过）。
     *
     * v1 **只记录、不进提示词**（用户 2026-10-26 拍板）。别在这里接 `#buildPrompt`。
     */
    this.lastEmotion = null;
    /** 最近若干条（新的在后），只留 20 条；同样是"只记录"。 */
    this.recentEmotions = [];
    /** 正在算的音频（同一段别算两遍：她连发两条一样的语音很常见）。 */
    this.emotionInFlight = new Set();
    /**
     * `send_voice` 的频率闸：chatId -> 上次真的发语音的时间（2026-10-26）。
     *
     * 和 `sendToolLastAt` 分两张表：语音的节奏由 `[tts] min_gap_ms` 定，
     * 而文字那条由 `send_qq` 自己的 5 秒闸管 —— 混用会让"发过文字"意外挡掉"发语音"。
     * 只在内存里，重启归零。
     * @type {Map<string, number>}
     */
    this.voiceToolLastAt = new Map();
    /**
     * `look_sticker` 的**识图**频率闸：sessionKey -> 上次真的调识图的时间（2026-10-19）。
     *
     * 为什么单独一张表、且只在"确实要现看"时才写：
     *   - 有 `desc` 的那条路是零成本的，**不该被它挡**（否则"问一句就被拒 10 秒"）；
     *   - 识图有真金白银的成本 ⇒ 同一个会话里 10 秒最多一次。
     * 只在内存里，重启归零（和 `sendToolLastAt` 同一口径）。
     * @type {Map<string, number>}
     */
    this.lookToolLastAt = new Map();
    this.attachments = attachments;
    this.imageDescriber = imageDescriber;
    this.stickerLibrary = stickerLibrary;
    this.imageDescription = imageDescription;
    /** **出站台账**（可为 null）。挂钩见下面 `attachOutboundLedger()`。 */
    this.outboundLedger = outboundLedger;
    /**
     * **`QQ → 昵称` 表**（可为 null）。
     *
     * 两个方向都在这一个对象上：`handleEvent` 里**学**（每条事件喂一次 `sender`），
     * `normalizeEvent` 里**查**（@ 段渲染成 `@昵称`）。
     * 为 null ⇒ 两个方向都不做，@ 段退回 `@QQ号`。
     */
    this.nicknames = nicknames;
    /**
     * 「说不说」的裁量模式（`heuristic` / `precheck` / `inTurn`）。
     * ⚠️ 归一化在 `judge-mode.mjs` 的 `normalizeJudgeMode()` 里做，
     * 这里只存结果 —— 认不出的值在那里**回落到 `heuristic`**（fail-safe）。
     */
    this.judgeMode = judgeMode;
    /** 私聊专用的判定模式；空串 = 跟随 `judgeMode`（2026-11-01）。 */
    this.judgeModePrivate = String(judgeModePrivate ?? '').trim();
    /** 模式 2 的预检器（`{enabled, check, describe}` 或 null）。模式 1/3 用不到它。 */
    this.precheck = precheck;
    /**
     * 判官/启发式决策日志（可为 null）。见构造函数里 `gaugeLog` 那段说明。
     * 所有调用点都在 `try/catch` 里，且**永不 await** —— 它在消息热路径上。
     */
    this.gaugeLog = gaugeLog ?? null;
    // 关系记账：**没注入就是关**（测试/离线保持零副作用），由 index.mjs 显式传入。
    this.relations = relationLedger ?? null;
    // 群聊防抖：攒批后只对最后一条跑判定（前几条由 engine.ingest 补进转录，不丢）。
    this.debouncer =
      debounce === null || debounce === false
        ? null
        : createDebouncer({
            log: (level, msg) => this.log(level, msg),
            ...(typeof debounce === 'object' ? debounce : {}),
            onFlush: (items) => this.#flushBatch(items),
          });
    /** 正在处理的会话，避免同一会话并发跑两轮（QQ 里会看起来像精神分裂）。 */
    this.inFlight = new Map();
    /** 已见过的 message_id，用于去重（OneBot 重连会补发）。 */
    this.seen = new Set();
    /**
     * **最近一次带图转发的图片清单**（chatId → `[{index, url, size, from}]`）。
     *
     * 用来实现"按序号取图"：提示词里只给 `[图片1 745KB]` 这样的元信息，
     * 小鲸鱼想要哪张再用序号来换真图（见 `deliverFromAlice` 的 `viewImages`）。
     *
     * 只留**最近一次**：转发是"当下这件事"，隔很久再来取图多半搞错了对象，
     * 存多份反而容易取出牛头不对马嘴的东西。
     */
    this.forwardImages = new Map();
    /**
     * 每个会话的**图片描述查表函数**（`chatId → (message) => string[]|null`）。
     *
     * 为什么要按会话缓存：一轮提示词里要渲染**两次**转录（正文 + 转录），
     * 而每次渲染都新建一个查表函数就会把同一批图**问两遍**（`describeAll` 是串行的）。
     * 缓存让"同一轮"共用同一批 `describeAll`、同一张表。
     *
     * ⚠️ 上界：每个会话一项，条目本身很小（一个闭包 + 一张表）。
     * 会话数就是"我们有权说话的群/私聊"数，不随消息数增长。
     */
    this.transcriptImageText = new Map();
    /**
     * **同步可用**的图片描述备忘（`chatId → Map<imageKey, {text,source}|string>`）。
     *
     * 由入站预取（{@link Gateway#prefetchImageDescriptions}）在描述落地时写入。
     * 和 `imageDescriber` 自己的缓存是两件事：那个是**异步**的（要 `await`），
     * 而 `#buildPrompt` 是**同步**的 —— 提示词这一侧只能查一个现成的表。
     *
     * ⚠️ 上界：每个会话一张表，条数 = 这个会话"被预取过的图"数。
     * 长跑会话里会缓慢增长（每张图一条短文本）—— 换掉的是"每轮都要等描述"，
     * 值这个内存；真要收拾，清掉这个 Map 即可（丢了只是退回 `[图片]`）。
     */
    this.imageTextMemo = new Map();
    /**
     * `chatId → 生成序号`：**这个会话已经有可查的图片描述了**（2026-10-13）。
     *
     * 它只做一件事：让 {@link Gateway#imageTextFor} 知道"之前缓存下来的那个查表
     * 函数还算不算数"。为什么需要它（两个坑都是实测踩出来的）：
     *
     * 1. 无条件缓存 ⇒ **第一轮**（转录里还没有带图消息）建出来的那个"永远返回
     *    `null`"的函数被永久缓存，之后图进来了查表还是它 ⇒ 描述算出来了、
     *    提示词里却还是 `[图片]`；
     * 2. 改成"当前这条带图才缓存"还是不够 —— **纯图那条无正文的消息**会在
     *    "空正文早退"那条路上就把它缓存掉，而那时备忘里一条都还没有。
     *
     * ⇒ 判据只能是"**入站预取真的把描述写进备忘了**"，也就是这个键存在。
     * 预取写入时会 `transcriptImageText.delete(chatId)` 把旧函数丢掉。
     */
    this.imageTextGeneration = new Map();
    /**
     * `chatId` 集合：**入站预取已经往这个会话的备忘里写过描述**（2026-10-13）。
     *
     * ⚠️ 它和 `imageTextGeneration` 是**两个方向**的东西，别合成一个：
     * - 这个（`imageTextReady`）回答"**缓存还作不作数**"（写给 `#imageTextFor` 的判据）；
     * - 那个（生成序号）回答"**这份缓存是第几代**"（写给"重新建一个"的判断）。
     * 合成一个的后果实测过：把"只有轮询才需要重新建"混成"有代次就复用"
     * ⇒ 又退回坑 1（把空的永久缓存住）。
     */
    this.imageTextReady = new Set();
    this.stopped = false;
    /**
     * 「用户自己发了一条消息」的观察者（2026-10-23 加，可为 `null`）。
     *
     * 定时唤醒（`free-time.mjs`）的长间隔与短追问都以**用户最后一条消息**为锚点，
     * 而「用户说了话」这件事只有网关知道 ⇒ 由它转告一次（`handleEvent` 里）。
     *
     * 网关**不判断**哪条算数（用户？群友？）：那是调用方的事，
     * 所以这里只把归一化后的消息原样递出去，回调体自己吞异常。
     * @type {((message: object) => unknown)|null}
     */
    this.onUserMessage = null;
    /**
     * 统计，给诊断用。
     *
     * ⚠️ **`outbound` 这两个数会随热重载清零**（整个 `stats` 都在内存里，重载即归零）
     * ⇒ 它只能回答"**当场**一眼看"，**历史只有台账**（`qq-outbound.jsonl`）。
     * 两个数分开记，是因为"插件想发"与"真交给 NapCat"之间**隔着传输层**：
     * `sends` > `actions` ⇒ 有一次压根没走到运输层（发送前就抛了）；
     * `actions` > `sends` ⇒ 有东西**绕过了 `#send`** 直接调传输层（那本身就是要查的事）。
     */
    this.stats = {
      received: 0, dispatched: 0, observed: 0, ignored: 0, failed: 0, replies: 0,
      /**
       * 语音发出去几条（`send_voice` 成功一次加一，2026-10-26）。
       *
       * 为什么不并进 `outbound.sends`：那个数回答"**插件总共决定发几次**"，
       * 而这个回答"**其中几条是语音**"。分开记，`sends - voices` 就是文字条数，
       * 排查"她是不是只会打字"时一眼能看出来。
       */
      voices: 0,
      /**
       * **拿不到回复的计数**（2026-10-28 加，事故驱动）。
       *
       * 为什么单独记：`stats.replies` 只数"发出去几条"，它**回答不了**
       * "有多少轮本该说话却一个字都没发" —— 那一类在旧口径里完全不存在，
       * 台账里也没有 `gw-send`（连要发的文本都没有），所以 2026-10-28 20:43
       * 那次事故只能靠会话日志逐事件反推。
       *
       * - `emptyReplies`：responder 返回空串的轮数（含"模型确实不说话"，正常会有）；
       * - `lostReplies`：其中**有丢消息迹象**的（历史被压缩过 / 明明有新消息却没文本）
       *   —— **正常就该是 0**；
       * - `compactedTurns`：binder 报"这一轮历史被压缩/重写过"的轮数。
       *
       * ⚠️ 与别处一致：随热重载清零，只回答"当场"。
       */
      emptyReplies: 0,
      lostReplies: 0,
      compactedTurns: 0,
      /**
       * **她说 `[不说话]` 的轮数**（2026-11-02）。
       *
       * 与 `emptyReplies` 分开记：那个是"responder 一个字都没给"，
       * 这个是"她给了字、并且明确说这轮别发"。混在一起的话，
       * 以后想按"她主动沉默 vs 回复丢了"分账就分不出来了。
       * （被它压掉的那一轮**不进** `stats.replies` —— 确实没发。）
       */
      quietReplies: 0,
      /**
       * **逐段外发**的两个数（2026-11-04）。
       *
       * - `segments`：真的把"一段"交给 `#send` 的次数（= 台账里 `runTurn-step*` 的行数）；
       * - `failedSegments`：其中**抛了异常**的段数（超时 / 连接没就绪）。
       *
       * 为什么要单独记：逐段发送之后，"发了 3 段"和"发了 1 段、另 2 段失败"在
       * `replies` 上看起来只差个数，但**后者是丢消息** —— 用户明确说过发送失败
       * 不许静默。失败那一段在台账的 `transport-action` 层另有 `ok:false` 一行。
       */
      segments: 0,
      failedSegments: 0,
      outbound: { sends: 0, actions: 0 },
    };
    this.attachOutboundLedger();
  }

  /**
   * 把出站台账挂到传输层的发送包装上（**幂等**，`outbound-ledger.mjs` 里保证）。
   *
   * 单独一个方法而不是塞进构造函数，是为了让"挂"和"用"分得开：
   * `#recordOutbound()` 只管记账，挂钩这件事只有这一处。
   * ⚠️ **绝不抛** —— 台账装不上只是少一层证据，不该让网关起不来。
   */
  attachOutboundLedger() {
    const ledger = this.outboundLedger;
    if (ledger === null || typeof ledger?.instrument !== 'function') return;
    try {
      // ⚠️ **`transport-action` 那个计数靠第二个回调（`onAction`）加**，
      //    不是第一个（`onRecord`）。
      //
      // 那一层是在**传输层**记的（台账的挂钩里），而计数在**网关**上 ——
      // 中间必须有根线把两边接起来。
      // **两个回调口径不同**：
      //   `onAction` = "发生了一次发送动作"（**台账写不进去也照样数**）⇒ 给计数；
      //   `onRecord` = "真的记下来一行"（写失败时不调）⇒ 给诊断。
      // 挂错那个的后果很具体：**台账一坏，计数器就一起停** ——
      // 于是"发了很多条但没记上"和"什么都没发"在快照上一样。**别改回去。**
      ledger.instrument(this.transport, {
        // 计数：**每一次发送动作**都 +1（台账写不进去也照样数）。
        onAction: (entry) => {
          if (entry?.layer !== LAYER_TRANSPORT_ACTION) return;
          this.stats.outbound.actions += 1;
        },
        // `onRecord`（"一行真的写下了"）这里**不接**：
        // 台账自己已经用 `stats.outbound.ledger.wrote/failed/disabled` 记了那件事，
        // 快照里看得到（`debug-snapshot.mjs` 的 `outboundLedgerStats`）。
        // 再接一遍就是把同一个数记在两个地方，迟早对不上。
      });
    } catch (error) {
      this.log('warn', '出站台账挂钩失败（发送不受影响，台账会缺 transport-action 这一层）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 绑定到传输层事件。 */
  attach() {
    this.onEvent = (event) => {
      // 事件处理绝不能把异常抛回传输层的事件循环。
      Promise.resolve()
        .then(() => this.handleEvent(event))
        .catch((error) => {
          this.log('error', '处理事件时发生未捕获错误', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };
    this.onDown = (payload) => {
      this.log('warn', 'OneBot 连接断开，在途请求已被拒绝', payload ?? {});
    };
    this.onLog = (level, message, meta) => this.log(level, `[onebot] ${message}`, meta);
    this.onReady = (payload) => this.log('info', 'OneBot 已就绪', payload ?? {});

    this.transport.on('event', this.onEvent);
    this.transport.on('down', this.onDown);
    this.transport.on('log', this.onLog);
    this.transport.on('ready', this.onReady);
  }

  /** 解绑。 */
  detach() {
    if (this.onEvent !== undefined) this.transport.off('event', this.onEvent);
    if (this.onDown !== undefined) this.transport.off('down', this.onDown);
    if (this.onLog !== undefined) this.transport.off('log', this.onLog);
    if (this.onReady !== undefined) this.transport.off('ready', this.onReady);
  }

  /** 停止接受新消息（在途的等它自然结束）。 */
  stop() {
    this.stopped = true;
    this.detach();
    // 台账挂钩**装回去**：`stop()` 的语义是"这个网关不再用了"，
    // 留着挂钩会让 transport 继续被记（而它可能被复用/被别的网关接走）。
    // ⚠️ 装不回去也只影响台账，不影响发送。
    try {
      this.outboundLedger?.uninstall?.();
    } catch { /* 无关紧要 */ }
  }

  /**
   * 处理一个原始 OneBot 事件。
   * @param {any} event
   * @returns {Promise<{outcome: string, reason: string, chatId?: string, reply?: string}>}
   */
  async handleEvent(event, { skipDebounce = false, counted = false, skipSeen = false } = {}) {
    if (this.stopped) return { outcome: OUTCOME.IGNORED, reason: 'gateway-stopped' };

    // 先学名字（**在归一化之前**，而且不管这条消息会不会被忽略）：
    //
    // ⚠️ 两件事都必须在 `normalizeEvent` 之前 —— ① 本条消息里 @ 的人正好是发送者本人时，
    //    这一条就能查到；② **小鲸鱼自己发的消息也会走到这里**，而"小鲸鱼的昵称"只可能从
    //    那些消息的 `sender` 里学到（`ignoreSelf` 会把它们挡在归一化之外）。
    //
    // ⚠️ `learn()` 自己吞异常（它内部 try/catch + 写盘也是 try/catch），这里再包一层：
    //    这个回调挂在**每条入站事件**上，抛出去就是"整个 DSH 起不来"那一类事故
    //    （见 AGENTS.md：2026-10-14 `writeSnapshot` 的教训）。学不到名字的后果
    //    只能是"这次 @ 退回 QQ 号"，**绝不能让一条消息处理不了**。
    if (this.nicknames !== null) {
      try {
        this.nicknames.learn({
          userId: event?.user_id,
          nickname: event?.sender?.nickname,
          card: event?.sender?.card,
          groupId: event?.group_id,
          at: Number(event?.time) > 0 ? Number(event.time) * 1000 : undefined,
        });
      } catch (error) {
        this.log('debug', '学昵称失败（忽略）', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const message = normalizeEvent(event, {
      botQQ: this.transport.selfId || this.router.config.botQQ,
      ignoreSelf: true,
      // 查名字：`resolveAt(qq, groupId)` —— 表自己知道"先本群名片、再全局昵称"。
      // 传的是**闭包**（不是方法引用）⇒ 丢 `this` 也不会坏。
      resolveAt: this.nicknames === null ? undefined : (qq, gid) => this.nicknames.resolve(qq, gid),
    });
    if (message === null) {
      return { outcome: OUTCOME.IGNORED, reason: 'not-a-user-message' };
    }

    // 防抖回放时这批已经记过账（stats / 关系 / 心情都不该加两次）。
    if (!counted) {
      this.stats.received += 1;

      // 关系记账（A 段，2026-11-04）：纯观察，不改判定、不存原文。
      // 失败最多丢一条计数 —— 绝不能因为记账把消息处理弄挂（手册第三节）。
      if (this.relations !== null && this.relations !== undefined) {
        try {
          this.relations.observe({
            chatId: message.chatId,
            userId: message.userId,
            at: message.at,
            mentioned: message.mentioned === true,
            nickname: message.nickname,
          });
        } catch {
          /* 记账失败：忽略 */
        }
      }
    }

    // 收到消息时，fire-and-forget 更新心情（拟人化：心情随对话演化，不阻塞消息处理）。
    // 防抖回放（counted=true）不再更新：同一条消息的心情只该算一次。
    if (!counted && this.mood !== null && typeof this.mood.updateMood === 'function') {
      // 2026-10-30：**从"只有这一条"改成"最近 N 条转录"**。
      // 原来传的是 `String(message.text)` —— 心情模型以为自己在看"群里最近的聊天记录"，
      // 其实只看到一句话，等于没有上下文。现在给它真正的上下文（默认 20 条，可配）。
      // 拿不到转录时退回这一条（行为与改动前一致）。
      let moodTranscript = String(message.text ?? '');
      try {
        const transcript = this.engine?.transcript?.(message.chatId);
        if (transcript !== null && transcript !== undefined && typeof transcript.render === 'function') {
          const text = String(transcript.render(Math.max(1, Number(this.moodTranscriptMessages) || 20)) ?? '').trim();
          if (text !== '') moodTranscript = text;
        }
      } catch {
        /* 转录拿不到 ⇒ 用这一条，绝不能因为心情把消息处理弄挂 */
      }
      this.mood.updateMood({ chatId: message.chatId, transcript: moodTranscript }).catch(() => {});
    }

    // 去重：OneBot 断线重连会补发最近的事件，不去重就会重复回复。
    // 防抖回放（skipSeen=true）跳过：这条在攒批时已经登记过，再查会被当成重复丢掉。
    if (!skipSeen && typeof message.messageId === 'number') {
      if (this.seen.has(message.messageId)) {
        return { outcome: OUTCOME.IGNORED, reason: 'duplicate', chatId: message.chatId };
      }
      this.seen.add(message.messageId);
      pruneSeen(this.seen);
    }

    // 消息防抖（2026-11-04）：群聊与私聊都生效。
    // - 群聊：同一人续发 2s / 换人 0.5s / 整批 8s / 含 @ 压到 1s；
    // - 私聊：只有一个对话者，"换人"不会发生，等价于续发 2s；连发同样攒成一批。
    if (!skipDebounce && this.debouncer !== null) {
      const held = this.debouncer.push({
        chatId: message.chatId,
        userId: message.userId,
        isAt: message.mentioned === true,
        payload: { event, message },
      });
      if (held) {
        return { outcome: OUTCOME.OBSERVED, reason: 'debounced', chatId: message.chatId };
      }
    }

    // 「用户最后一条消息」这个锚点（2026-10-23）：定时唤醒的长间隔与短追问都从它起算。
    //
    // ⚠️ 位置：**去重之后、任何早退之前**。它问的是"用户什么时候说过话"，
    //    与"这条会不会被回 / 被观察"无关（白名单外的群、被忽略的消息，也照样是用户说了话）。
    // ⚠️ 这个回调挂在**每条入站事件**上，抛出去就是宿主退出（2026-10-14 那类事故）
    //    ⇒ 必须自己 try/catch；记不下来最多是定时器锚点旧一点。
    if (typeof this.onUserMessage === 'function') {
      try {
        this.onUserMessage(message);
      } catch (error) {
        this.log('debug', '用户消息锚点记录失败（忽略）', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const verdict = this.router.resolve(message);

    if (verdict.action === ACTION.IGNORE) {
      this.stats.ignored += 1;
      this.log('debug', `忽略消息 ${message.chatId}`, { reason: verdict.reason });
      return { outcome: OUTCOME.IGNORED, reason: verdict.reason, chatId: message.chatId };
    }

    // 路由只回答"能不能跟这个会话说话"（白名单 / 群策略）。
    // OBSERVE = 不在允许范围，仍然记转录（运维想看群里在聊什么），但不回复。
    if (verdict.action === ACTION.OBSERVE) {
      // 不在允许范围的消息也要进转录，这样主动侧看到的历史是完整的。
      await this.engine.decide(message).catch(() => undefined);
      this.stats.observed += 1;
      this.log('debug', `只观察不回复 ${message.chatId}`, { reason: verdict.reason });
      return { outcome: OUTCOME.OBSERVED, reason: verdict.reason, chatId: message.chatId };
    }

    // ===== 偷表情包（fire-and-forget）=====
    //
    // 放在这里的三个理由，每一个都是**位置**决定的，不能随便挪：
    //
    // 1. **在 OBSERVE 之后** —— 上面那个分支是"不在出站白名单里的会话"。
    //    从那里面偷图等于把**我们无权说话的群**的图攒起来，是隐私上的越界。
    //    只偷我们本来就被允许参与的会话。
    // 2. **在 `engine.decide` 之前** —— 偷图跟她要不要吭声毫无关系。
    //    放进 decide 之后，会让"判定沉默"的那些消息里的表情包全漏掉，
    //    而群里绝大多数表情包恰恰出现在小鲸鱼不说话的时候。
    // 3. **不 await** —— 落盘要下载字节（可能几百毫秒到几秒）。
    //    为了偷一张图让用户的回复晚几秒，是拿主链路的延迟换一个后台功能。
    //    失败只记日志（`#harvestStickers` 内部已经全包了）。
    void this.#harvestStickers(message);

    // ===== 图片描述预取（fire-and-forget，2026-10-13 加）=====
    //
    // **和上面偷表情包同一条规矩：不 await。** 位置也照抄它：在 OBSERVE 之后
    // （只为我们本来就有权参与的会话花视觉调用），在 `decide` 之前（描述跟
    // "她要不要吭声"毫无关系，而且绝大多数带图消息是**判定沉默**的）。
    //
    // ## 为什么必须挪到入站处（原来它在下面 `#describeEmbeddedImages` 那条 await 上）
    //
    // 原路径：`await this.#describeEmbeddedImages(message)` 在**派发路径上**，
    // 而那条路要等下图片字节（`DESCRIBE_TIMEOUT_MS = 20s`，`image-desc.mjs:363`）
    // **串行最多 6 张**（`describeAll`，`image-desc.mjs:2416-2430`）⇒ 最坏 120s。
    // 更糟的是**模型调用那一层原来既没有超时、也没有 `AbortSignal`**，
    // 提供商挂住就是**无限等** —— 用户看到的现象就是"小鲸鱼这条回得莫名其妙地晚"。
    //
    // 挪到这里之后：
    // - 主链路**一个毫秒都不等**（描述在后台算，算完进内存缓存 + 跨会话表）；
    // - 描述**不再只服务这一轮** —— 它落在 `imageDescriber` 自己的缓存/表里，
    //   所以之后**任何**一轮渲染转录都能查到（这正是环境轮要的东西）；
    // - 判定沉默的那些图**照样有描述**（原来它们连描述都拿不到，
    //   只能等下一次机会轮以 `[图片]` 的形态出现 —— 用户 2026-10-13 报的就是这个）。
    //
    // ⚠️ 幂等性：同一张图重复走到这里，命中内存缓存 / 跨会话表
    // （`describeDetailed`，`image-desc.mjs:2302-2354`），**不会重复调模型**。
    void this.#prefetchImageDescriptions(message);

    // ===== 统一判定 =====
    //
    // **所有在允许范围内的消息走同一条链**：私聊、群里 @ 的、群里没 @ 的。
    // 不再有"@ 走被动通道、未 @ 走主动通道"的二分 —— 那个二分实测导致
    // 同一条私聊消息被两个通道各回一次。`@` 现在只是判定里的加分项，
    // 以及"跳过限流"的凭据（见 engine 的 `#gate`）。
    const decision = await this.engine.decide(message).catch((error) => {
      this.log('warn', '判定失败（按不回复处理）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { speak: false, reason: 'decide-error', addressed: false };
    });

    if (decision.speak !== true) {
      this.stats.observed += 1;
      this.log('debug', `判定沉默 ${message.chatId}`, { reason: decision.reason });
      return { outcome: OUTCOME.OBSERVED, reason: decision.reason, chatId: message.chatId };
    }

    // ===== 判官/启发式决策日志（2026-11-06）=====
    //
    // ## 为什么在这里开一条
    //
    // 走到这一行 = **启发式那一步已经给了"要说"**（`decision.speak === true`），
    // 也就是需求里说的「过阈值那一刻」：再往下一层要么是判官（precheck），
    // 要么直接进 agent。**再早**（没过阈值 / 被闸门挡掉）研究的对象就不存在了
    // —— 那类"为什么没冒泡"由 `engine.journal` 回答（闸门原因 + 分数）。
    //
    // ## 为什么不是"立刻写盘"而是先攒着
    //
    // 判官在下面几行才跑，而记录里**必须有判官的结论、原文、耗时、模型**
    // （那是这次改动的核心诉求）。若在过阈值那一刻就写、之后再补字段，
    // 就得回头改写文件 —— 行级 JSONL 里最危险的操作（截断/半行/并发）。
    // ⇒ 一条只写一次，写盘时机在判官回来之后；记录的 `messageAt` 仍然是
    //   **过阈值那条消息的时刻**（语义没变，只是落盘晚了那一次调用的几百毫秒）。
    //   `reply` 阶段再补一行 `kind:'out'`，两行用同一个 `turnId` 关联。
    //
    // ⚠️ `gaugeLog` 为 null（没开）时这一整段是**空转**：不建对象、不碰磁盘。
    //    下面每个调用点都还各自包着 try/catch —— 它**绝不许**影响这一条消息。
    let gaugeTurn = null;
    let gaugeLogged = false;
    /**
     * 判官结论的默认值 = **启发式自己拍板**。
     *
     * 三种情况会用到它：`judge_mode = heuristic`（默认）、`inTurn`（不调判官）、
     * 以及 `precheck` 但没配模型 / 没注入（那两种在 `judge-mode.mjs` 里也会
     * 降级成"该说"，只是要等到 `check()` 内部才知道）。
     */
    let gaugeJudge = {
      verdict: 'speak',
      source: 'heuristic',
      raw: '',
      ms: 0,
      model: '',
      provider: '',
      promptChars: 0,
    };

    // ===== 模式 2：precheck（过了闸门与阈值之后，**再问一次轻量模型**）=====
    //
    // 位置是这一条全部价值所在：**在 `engine.decide` 之后、进 agent 之前**。
    //   · 之后 —— 没放行的消息**根本不会花钱**（闸门/阈值已经把它们挡掉了，
    //     "别为它花模型调用"是硬要求）；
    //   · 之前 —— 它要省的就是"这一轮白跑的整轮钱"（`FIT-RESULT.md` 的方案 3 对照表：
    //     precheck 的成本是"每条一次轻量调用"，收益是"省掉白跑的整轮"）。
    //
    // 🔴 **这一次调用是一次性的、没有上下文**（用户 2026-10-13 原话）：
    // 转录 / 当前这条消息 / 总分与分项**全部塞进这一次请求的提示词**，
    // 拼装见 `judge-mode.mjs` 的 `buildPrecheckPrompt()`。
    //
    // 它答「不该」⇒ 直接当"不说"返回（**不起 agent、不花那一轮的钱**）；
    // 失败 / 超时 / 答歪 ⇒ **降级成「该说」**（退回模式 1；理由见 `judge-mode.mjs` 文件头）。
    // 两种情形都**必须可观测**：`pc_*` 会跟着进 `engine.journal`。
    //
    // ⚠️ **被点名（`decision.addressed`）不进这里**：`@` / 喊名字 / 私聊是**明确请求**，
    // 闸门在 `#gate` 里就为它短路放行了（`reason:'addressed'`，连打分都不参与决定）。
    // 让轻量模型去拦一条"人家在叫你"的消息，等于把明确请求交给一个**没有上下文**
    // 的小模型否决 —— 那不是省钱，是漏回。
    if (this.#modeFor(message, decision) === 'precheck' && this.precheck !== null && decision.addressed !== true) {
      const outcome = await this.precheck.check({
        transcript: this.engine.transcript(message.chatId).render(20),
        chatId: message.chatId,
        kind: message.kind,
        userId: message.userId,
        messageText: message.text,
        addressed: decision.addressed === true,
        score: decision.score ?? null,
        threshold: decision.threshold ?? null,
        detail: decision.detail ?? null,
        now: message.at,
      });
      // ⚠️ 顺序：先挂 `decision`（给下面那条 `event:'precheck'` 与日志用），
      // 再**回填**引擎那条已经落盘的 `event:'gauge'` 日记。
      //
      // 为什么要回填而不是"一开始就写进去"：预检在网关里、且在 `engine.decide()`
      // **返回之后**才跑，而 `#decide` 的 `gauge` 日记在返回前就落了盘 ——
      // 写那一刻 `pc_*` 还没算出来。`annotateLastGauge()` 补的是**同一个对象**
      // （`#record` 是 push 引用，不是拷贝）⇒ 最终 journal / 快照里那条是完整的。
      decision.precheck = outcome;
      this.engine.annotateLastGauge(flattenPrecheck(outcome));

      // 判定日志：**判官一给结论就落一行**（speak / decline / wait 都记）。
      // ⚠️ 必须写在下面两条早退**之前** —— 「判官说不该」与「判官说等」
      // 正是这次改动要研究的东西，漏了它们这份日志就只剩"说了话"的那些。
      gaugeJudge = outcome;
      gaugeTurn = this.#openGaugeLog(message, decision, outcome);
      gaugeLogged = true;

      // ===== 第三态：判官说「等」（2026-11-01）=====
      //
      // 语义：对方话还没说完，现在接会接错。三件事：
      //   ① 不派活（这一轮不花钱）；
      //   ② 挂一个标记（TTL 90 秒、最多连 3 次）；
      //   ③ 下一条消息由 `engine.#gate` 的 `incomplete-followup` **跳过阈值**再问一次。
      if (outcome.verdict === 'wait') {
        const times = this.engine.noteIncomplete(message.chatId, message.at);
        this.stats.observed += 1;
        this.log('debug', `precheck 说「等」${message.chatId}`, {
          times,
          model: outcome.model,
          ms: outcome.ms,
          raw: outcome.raw,
        });
        this.engine.record({
          at: message.at,
          chatId: message.chatId,
          event: 'precheck',
          speak: false,
          reason: 'precheck-wait',
          score: Number.isFinite(Number(decision.score)) ? Number(decision.score) : null,
          threshold: Number.isFinite(Number(decision.threshold)) ? Number(decision.threshold) : null,
          waitTimes: times,
          ...flattenPrecheck(outcome),
        });
        return { outcome: OUTCOME.OBSERVED, reason: 'precheck-wait', chatId: message.chatId };
      }

      if (outcome.speak !== true) {
        // 判官给了结论（不该）⇒ 这条话不用再等了。
        this.engine.clearIncomplete(message.chatId);
        this.stats.observed += 1;
        this.log('debug', `precheck 拦下 ${message.chatId}`, {
          reason: 'precheck-declined',
          model: outcome.model,
          ms: outcome.ms,
          promptChars: outcome.promptChars,
          raw: outcome.raw,
        });
        // **日记里必须留一条**：这是"没回消息"的两种完全不同的原因之一。
        // 上面 `engine.#decide` 那条 `gauge` 记的是"打分说要"，而 agent **压根没起** ——
        // 只留那一条的话，看起来像"说了但没发出去"（那是另一类故障）。
        this.engine.record({
          at: message.at,
          chatId: message.chatId,
          event: 'precheck',
          speak: false,
          reason: 'precheck-declined',
          score: Number.isFinite(Number(decision.score)) ? Number(decision.score) : null,
          threshold: Number.isFinite(Number(decision.threshold)) ? Number(decision.threshold) : null,
          // ⚠️ **不塞 `decision.detail`** —— 上面那条 `gauge` 已经摊平过一份，
          // 这里再摊一次只会让日记里同一批 `d_*` 数出现两遍、把上界挤掉。
          ...flattenPrecheck(outcome),
        });
        return { outcome: OUTCOME.OBSERVED, reason: 'precheck-declined', chatId: message.chatId };
      }
      // 放行 ⇒ 判官已经给了结论，这个会话不用再等下一句了。
      this.engine.clearIncomplete(message.chatId);
      this.log('debug', `precheck 放行 ${message.chatId}`, {
        source: outcome.source,
        model: outcome.model,
        ms: outcome.ms,
      });
    }

    // 没走判官（模式 1 / 模式 3 / 没配预检模型）⇒ 结论由启发式自己给，
    // 现在把它落一行（`gaugeJudge` 还是上面那个默认值 `verdict:'speak'`）。
    if (!gaugeLogged) gaugeTurn = this.#openGaugeLog(message, decision, gaugeJudge);

    // 空正文拦在"决定要回"之后。**但纯 @ 不算空**：
    // `@小鲸鱼` 却没打字是"叫你一声"，得让它应一句"在的"。
    //
    // 实测踩到：用户在群里 @ 了小鲸鱼没打字（消息段是 `at` + 一个空格），
    // 判定完全正确（addressed=True、speak=True），却在这里被当成 empty-body
    // 丢掉，小鲸鱼一声不吭。
    //
    // 只认**真正的 @**：归一化时"引用回复我"也会把 `mentioned` 置 true，
    // 所以要用 `replyToSelf` 把它排除掉 —— 引用我但没打字更可能是手滑，
    // 静默处理。私聊 / 纯表情同理。
    const isExplicitAt = message.mentioned === true && message.replyToSelf !== true;
    // ⚠️ 判空要**去掉 @ 目标**再看（`@别人` 没打字仍是空正文；`@小鲸鱼` 没打字仍要回）。
    const body = bodyWithoutMentions(message);
    if (body === '' && !isExplicitAt) {
      this.stats.observed += 1;
      this.log('debug', `空正文且没被直接 @，不触发会话 ${message.chatId}`, {});
      return { outcome: OUTCOME.OBSERVED, reason: 'empty-body', chatId: message.chatId };
    }

    // ===== 统一回复：一律走会话（agent）=====
    // 插话也走会话，于是它进会话历史 —— 上下文连续，小鲸鱼知道自己插过什么。
    //
    // 合并转发 / 文件 / 卡片这类段在这里展开成可读文本，**只用于提示词**：
    // `message.text` 保持占位符形态，判定与打分那套逻辑不受影响。
    const richImages = [];
    // 转发里夹着的图先拿一句描述 —— `renderRichText` 是纯同步的，
    // 异步（下载 + 视觉模型）必须在渲染之前做完，渲染时只查表（见 image-desc.mjs）。
    const imageText = await this.#describeEmbeddedImages(message);
    // ===== 语音转文字（B4，2026-10-25）=====
    //
    // **必须在这里**（`expandRichText` 与 `#buildPrompt` 之前）：正文有两个来源 ——
    // `#buildPrompt` 在"有富段/在收集图片"时会用 `richText` 当 `textOverride`，
    // 而那个值是从 `message.segments` **当场重新渲染**出来的。所以只改 `message.text`
    // 是不够的：晚一步改，提示词仍然用旧的 `[语音（未转写）]`（2026-10-25 实测踩到）。
    // 放在渲染之前 ⇒ 下游（提示词、引擎转录、判定层）看到的是同一份文字。
    await this.#transcribeVoice(message);
    const richText = expandRichText(message.segments, {
      images: richImages,
      imageText,
      // 展开出来的内容里也有 `@` 段（比如转发里那句"@某人 看看"）——
      // 名字表不往下传的话，那一层又退回 `@QQ号`（同 `imageText` 那条踩过的坑）。
      resolveAt: this.nicknames === null ? undefined : (qq, gid) => this.nicknames.resolve(qq, gid),
      groupId: message.groupId ?? '',
    });
    // 缓存这一轮的图片清单，供"按序号取图"用。
    if (richImages.length > 0) {
      this.forwardImages.set(message.chatId, richImages);
      this.log('info', '缓存了转发图片清单', {
        chatId: message.chatId,
        count: richImages.length,
        sources: [...new Set(richImages.map((i) => i.from).filter(Boolean))].slice(0, 5),
      });
    }
    // 诊断：**只要收到富段就记一笔**，不管有没有展开成功。
    //
    // ⚠️ 这里踩过一次：原先的条件写成 `richText === null` 才记录，可
    // `expandRichText` 在"有 forward 段但没有 content"时返回的是 `[合并转发]`
    // （**不是 null**）—— 于是那条日志永远不触发，我还以为"根本没收到富段"，
    // 白等了一轮。教训：**诊断条件要盯"输入"，不要盯"输出的某个特定值"。**
    //
    // 👉 **卡片（json/xml）也在这条日志里**（2026-10-07 补）：用户报告"小鲸鱼对卡片是瞎的"
    // 时，最该看的就是"插件到底收没收到 json 段、载荷有多长"——以前这两种段
    // 连记都不记，等于把唯一的证据扔了。
    const richSegs = (Array.isArray(message.segments) ? message.segments : [])
      .filter((s) => s !== null && typeof s === 'object'
        && (s.type === 'forward' || s.type === 'file' || s.type === 'json' || s.type === 'xml'));
    if (richSegs.length > 0) {
      this.log('info', '收到富段', {
        chatId: message.chatId,
        expanded: richText !== null,
        segs: richSegs.map((s) => ({
          type: s.type,
          // 归一化会把 data 压平到顶层，所以两处都看，避免误判。
          topKeys: Object.keys(s),
          contentLenTop: Array.isArray(s.content) ? s.content.length : null,
          contentLenData: Array.isArray(s.data?.content) ? s.data.content.length : null,
          hasId: typeof s.id === 'string' || typeof s.data?.id === 'string',
          // 卡片的载荷是**字符串**（`data.data`），长度能直接说明"里面有没有东西"。
          cardPayloadLen: typeof s.data?.data === 'string' ? s.data.data.length : null,
        })),
      });
    }
    // 语音转写已经在上面 `expandRichText` 之前做完了（正文有两个来源，见那段注释）。
    // 诊断（2026-11-04，**临时**）：引用到底有没有传到插件。
    //
    // 起因：用户截图证明 QQ 客户端确实带引用发出去了，但提示词里既没有引用块、
    // 也没有"原文没找到"那一行 ⇒ `#quoteLines` 返回了 `[]` ⇒ `replyToId` 是空的。
    // 而 00:29 那次还能看到 id。中间只发生过一次热重载，没法凭空判断是哪一头断的。
    // ⇒ 把**入站那一刻**的段结构原样落盘一次，下次引用就有证据。
    //
    // ⚠️ 第一版只记 `reply` 段 —— 用户指出"手机和电脑发的在服务端应该一样"，
    // 于是"文件没生成"可能只是**桌面端用了别的段类型**（source / quote / …），
    // 而不是"没带引用"。教训同上面那条：**诊断条件要盯输入（记下所有段），
    // 不要盯你预期的那个值。** 现在改成无条件记最近 30 条（环形覆盖，不会涨）。
    // 查完就删。
    try {
      const segs = Array.isArray(message.segments) ? message.segments : [];
      const file = '<DSH_HOME>\\media\\qq-quote-debug.json';
      let arr = [];
      try {
        const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(prev)) arr = prev;
      } catch { arr = []; }
      arr.push({
        at: new Date().toISOString(),
        chatId: message.chatId,
        replyToId: typeof message.replyToId === 'string' ? message.replyToId : null,
        segTypes: segs.map((s) => (s === null || typeof s !== 'object' ? String(s) : s.type)),
        // 每个段的键名 + 那个段里可能的 id（reply 段两种形状都看）
        segDetail: segs.slice(0, 10).map((s) => {
          if (s === null || typeof s !== 'object') return null;
          const d = s.data !== null && typeof s.data === 'object' ? s.data : {};
          return { type: s.type, keys: Object.keys(d).slice(0, 8), id: d.id ?? s.id ?? null };
        }),
        textHead: String(message.text ?? '').slice(0, 40),
      });
      while (arr.length > 30) arr.shift();
      fs.writeFileSync(file, JSON.stringify(arr, null, 1), 'utf8');
    } catch { /* 诊断永远不该影响主流程 */ }
    // 「本条消息引用了这条消息：」的**兜底**（2026-11-04）：转录里找不到被引用的
    // 那条时（典型：引的是小鲸鱼自己的发言 —— 她的发言根本不进转录），问一次
    // `get_msg`。**必须在这里 await**：`#buildPrompt` 是同步的，它只查缓存。
    // 三个早退在 `#primeQuoted` 里 —— 正常引用一次都不问，代价为零。
    await this.#primeQuoted(message);
    const prompt = this.#buildPrompt(message, verdict, decision, richText, this.#modeFor(message, decision));
    return this.dispatch(message, verdict, prompt, decision, gaugeTurn);
  }

  /**
   * 防抖批次落地（2026-11-04）。
   *
   * 一批里**只有最后一条**走完整判定；前面几条用 `engine.ingest()` 补进转录 ——
   * 这样模型看得到"她刚才说了什么"，但不会被半句话单独触发一次判定。
   *
   * 三件必须守住的事：
   * 1. 前面几条的统计/关系/心情在攒批时已经记过（`counted: true` 不再重复）；
   * 2. 去重也在攒批时登记过（`skipSeen: true`），否则回放会被当重复丢掉；
   * 3. 这个回调不挂在事件循环最外层，抛出去会掐掉批次 ⇒ 自己 catch。
   */
  #flushBatch(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    const last = items[items.length - 1];
    for (const item of items.slice(0, -1)) {
      try {
        const message = item?.payload?.message;
        if (message !== undefined && message !== null) this.engine?.ingest?.(message);
      } catch (error) {
        this.log('debug', '防抖：补转录失败（忽略）', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    Promise.resolve()
      .then(() => this.handleEvent(last?.payload?.event, { skipDebounce: true, counted: true, skipSeen: true }))
      .catch((error) => {
        this.log('error', '防抖批次处理失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * 把消息里**判定为表情包**的图捞进库（"偷"这一步）。
   *
   * ## 判据是**位判据**：`emoji_id` 非空 **或** `sub_type & 1`
   *
   * 2026-10-08 用 **1495 张真实 image 段**定下来的（`shared/表情包-2026-10-08/`）：
   * `sub_type` 是 QQ 原生的 `picElement.picSubType` 位域，非零值 `1 / 7 / 11`
   * 的最低位全是 1、`0`（占 84%）是 0 ⇒ `sub_type & 1` 就是"表情 / 普通图"的分界。
   * `emoji_id` 那一支留着只为**商城表情**（那 2 张没有 `sub_type` 键）。
   * 位判据把全量 1495 张的收进量从 **2 张（0.13%）提到 235 张（15.72%）**。
   *
   * ⚠️ 两条旧结论已作废：**`summary` 不是证据**（它是 NapCat 按 `sub_type` 合成的）；
   * **`sub_type: 1` 也不是"群友照片"的形状**（用户看着图确认那几张是
   * 他**自己从「我的表情」面板发的**）。详细理由写在 `sticker-library.mjs` 的模块注释里。
   *
   * ## 这里只做三件事：调用、吞异常、记日志
   *
   * 真正的判定/下载/去重/落盘全在 `sticker-library.mjs`。这一层薄是**故意的**：
   * 网关是主链路，任何一行多余的逻辑都可能拖慢或弄坏"收消息 → 回消息"。
   *
   * @param {import('../onebot/protocol.mjs').InboundMessage} message
   * @returns {Promise<void>} **永不 reject**
   */
  async #harvestStickers(message) {
    if (this.stickerLibrary === null) return;
    try {
      const result = await this.stickerLibrary.harvest(message.segments, {
        chatId: message.chatId,
        userId: message.userId,
      });
      // `rejected`/`auditFailed` 也一起打出来：接了「认」之后，"收到表情包但一张没入库"
      // 完全可能是因为**审核闸**或**没看成**，而这两种在计数上完全不同因。
      if (result.stored > 0 || result.dedup > 0 || result.rejected > 0 || result.auditFailed > 0) {
        this.log('info', '偷到表情包', {
          chatId: message.chatId,
          stored: result.stored,
          dedup: result.dedup,
          nearMiss: result.nearMiss ?? 0,
          rejected: result.rejected ?? 0,
          auditFailed: result.auditFailed ?? 0,
        });
      }
    } catch (error) {
      // 库坏了/下载不动/磁盘满了 —— 一条都不该影响这条消息的处理。
      this.log('warn', '偷表情包失败（不影响本轮）', {
        chatId: message.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 给**转发里夹着的图**生成一句描述，供展开时替换掉 `[图片1 745KB]`。
   *
   * 为什么只管转发里的：顶层的图由 `media.mjs` 直接投成 **image block**，
   * 模型看见的是原图 —— 再让它看一遍、写一句字，是**花了钱买更差的信息**。
   * 转发里的图则相反：一张都投不进去（几十张更不可能），只有描述能救。
   * （想连顶层也描述：`imageDescription: 'all'`。）
   *
   * **任何失败都只是"这张没有描述"** —— 返回的表里少一项，渲染时自然退回占位符，
   * 绝不会因此丢消息。
   *
   * @param {import('../onebot/protocol.mjs').InboundMessage} message
   * @returns {Promise<Map<string, string>|null>}
   */
  async #describeEmbeddedImages(message) {
    if (this.imageDescriber === null || this.imageDescription === 'off') return null;
    try {
      const targets = this.imageDescription === 'all'
        ? [...collectEmbeddedImages(message.segments), ...collectImageSegments(message.segments)]
        : collectEmbeddedImages(message.segments);
      if (targets.length === 0) return null;
      // `withSource: true` → 表里存 `{text, source}`，渲染器才能标出 `源 gif`
      // （用户 2026-10-07 的要求）。渲染器两种形状都认，所以这里改契约不会波及其他调用方。
      const table = await this.imageDescriber.describeAll(targets, { withSource: true });
      return table.size === 0 ? null : table;
    } catch (error) {
      // 描述器内部已经逐张吞了异常，这里再包一层是防它整体炸（比如附件服务没了）。
      this.log('warn', '图片描述失败（本轮按无描述处理）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * **入站处预取图片描述 —— 不 await**（2026-10-13 加，用户要求"消除延后"）。
   *
   * 和 `#harvestStickers` 同一条规矩：**主链路不等它**。
   * 原来描述是在派发路径上 `await` 的（`image-desc.mjs` 下字节超时 20s × 串行 6 张
   * ⇒ 最坏 120s，模型挂住更是无限等），而那笔延迟**用户是能感觉到的**。
   *
   * 这里只做三件事：筛出顶层的图、把描述烧进 `imageDescriber` 的缓存/表、失败只记日志。
   * **不需要保存返回值** —— 之后任何一轮渲染转录时，`describeDetailed` 会从
   * 内存缓存（`cache`）或跨会话表（`qq-image-desc.json`）里**零成本**命中。
   *
   * 为什么用 `describeAll` 而不是逐张 `describe`：同一批图它们走**同一条管线**
   * （`describeAll` 内部就是逐张 `describeDetailed`），用 `describeAll` 顺带
   * 保留了"一批最多几张"这个闸门（`limit`）。
   *
   * @param {import('../onebot/protocol.mjs').InboundMessage} message
   * @returns {Promise<void>} **永不 reject**（`describeAll` 内部已逐张吞异常）
   */
  async #prefetchImageDescriptions(message) {
    if (this.imageDescriber === null || this.imageDescription === 'off') return;
    try {
      const targets = collectImageSegments(message.segments);
      if (targets.length === 0) return;
      // ⚠️ 别把返回值当结果用 —— 它同时也在烧缓存，但下面那份**同步**的备忘
      // 才是提示词这一侧要的东西（异步表的 `.then` 赶不上本轮渲染）。
      const table = await this.imageDescriber.describeAll(targets, {
        withSource: true,
        limit: PREFETCH_MAX_IMAGES,
      });
      if (!(table instanceof Map) || table.size === 0) return;
      let memo = this.imageTextMemo.get(message.chatId);
      if (memo === undefined) {
        memo = new Map();
        this.imageTextMemo.set(message.chatId, memo);
      }
      for (const [key, value] of table) memo.set(key, value);
      // ★ 这个会话现在**真的有描述可查**了：让 `#imageTextFor` 知道
      //   （并且把可能已经缓存下来的空函数丢掉）。
      this.imageTextReady.add(message.chatId);
      this.transcriptImageText.delete(message.chatId);
    } catch (error) {
      // 描述不该影响任何一条消息的处理（连日志都只是 debug：这条路每张图都会走）。
      this.log('debug', '图片描述预取失败（只是这张没有描述，之后会再试）', {
        chatId: message.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 为**这一轮提示词里的转录**准备图片描述表。
   *
   * 这是「给转录渲染加描述注入通道」的调用侧（`engine.mjs` 是渲染侧）：
   * 挑出转录里最近 {@link TRANSCRIPT_IMAGE_MESSAGES} 条**带图**的消息，
   * 把它们交给 `describeAll`（**异步**，可能真要打模型），拿回表之后
   * 以"每条消息 → 按出现顺序的描述数组"的形态交给 `render` / `renderExcept`。
   *
   * ## 为什么要"最近 N 条带图消息"而不是"全部都描述"
   *
   * 用户的验收口径是"**进 LLM 就塞 20 条前文**"，而转录最多留 60 条
   * （`Transcript.maxMessages`）—— 全量描述等于每轮都可能打十几张图。
   * 取最近带图的 6 条，覆盖了"刚发的那张 + 之前的几张"，
   * 而**更早那些仍然留在转录里、只是没有描述**（保持 `[图片]`）。
   *
   * ## 绝大多数情况这里是**零模型调用**的
   *
   * 入站预取（{@link Gateway#prefetchImageDescriptions}）已经把图烧进缓存了，
   * 而且缓存命中是**静默的**（`describeDetailed` 的内存缓存 → 跨会话表）。
   * 这里兜的是"预取还在飞 / 预取失败 / 跨进程重启后表里有但内存没有"那几种。
   *
   * ⚠️ **同步失败不影响提示词**：任何异常都退回 `null`（= 全是 `[图片]`），
   * 绝不因为描述的问题少派发一轮。
   *
   * ## 为什么按 chatId 缓存这一个函数（而不是每次渲染都算一遍）
   *
   * 一轮提示词里要渲染**两次**转录（被点名那一路：正文里要描述"刚 @ 你的那张图"、
   * 转录里要描述更早的图）。`describeAll` 是**串行**的（`image-desc.mjs:2427`），
   * 让它跑两遍就是把同一批图问两次 —— 缓存命中也是白跑的。
   * 所以**同一个 chatId 复用同一个查表函数**（同一批 `describeAll`、同一张表）。
   *
   * @param {string} chatId
   * @returns {(message: any) => string[]|null} 给 `Transcript.render` 的**同步**查表函数
   */
  #imageTextFor(chatId) {
    const cached = this.transcriptImageText.get(chatId);
    // ⚠️ 只在"**这个会话真的有描述备忘**"时才复用缓存的查表函数。
    //
    // 判据为什么不是"缓存存在"（这是实测踩出来的两个坑，都在这一行上）：
    // 1. 第一版**无条件缓存** ⇒ 第一轮（转录里还没有带图消息）建出来的那个
    //    "永远返回 `null`"的函数被**永久缓存**，之后图进来了查表还是它
    //    ⇒ 现象是"描述算出来了、提示词里却还是 `[图片]`"；
    // 2. 改成"当前这条带图才缓存"也不够 —— **纯图那条无正文的消息**会在
    //    "空正文早退"那条路上就把它缓存掉，而那时备忘里一条都还没有。
    // ⇒ 判据只能是"入站预取真的把描述写进过备忘"（`imageTextReady`）。
    if (cached !== undefined && this.imageTextReady.has(chatId)) return cached;
    const lookup = this.#transcriptImageText(chatId);
    this.transcriptImageText.set(chatId, lookup);
    this.imageTextGeneration.set(chatId, (this.imageTextGeneration.get(chatId) ?? 0) + 1);
    return lookup;
  }

  /**
   * @param {string} chatId
   * @returns {(message: any) => string[]|null}
   */
  #transcriptImageText(chatId) {
    const empty = () => null;
    if (this.imageDescriber === null || this.imageDescription === 'off') return empty;
    const transcript = this.engine?.transcript?.(chatId);
    if (transcript === undefined || transcript === null) return empty;

    // 最近 N 条**带图**的消息。**当前这一条也算在内**：
    // `renderExcept`（被点名那一路）会按对象引用把它剔掉，环境轮那一路
    // 本来就没有它 —— 所以收进来只会让"当前这条"也有描述可查（零成本）。
    const picked = [];
    for (const entry of transcript.snapshot().slice(-TRANSCRIPT_SCAN_MESSAGES).reverse()) {
      if (collectImageSegments(entry?.segments).length === 0) continue;
      picked.push(entry);
      if (picked.length >= TRANSCRIPT_IMAGE_MESSAGES) break;
    }
    if (picked.length === 0) return empty;

    /**
     * 查表函数读的就是这个**可变单元格** —— 这一条是"描述能不能赶上这一轮"的关键。
     *
     * ⚠️ 踩过的坑（2026-10-13，当场被自己的用例抓住）：第一版用一个
     * `settled` 布尔 + `.then()` 里置位。**而 `.then` 的回调是微任务，
     * 本轮渲染时它还没跑** ⇒ `settled` 一直是 `false` ⇒ 描述算出来了、
     * 却在这一轮渲染时查不到（现象：提示词里还是 `[图片]`）。
     * 更关键的是这个单元格**会被按会话缓存**（`#imageTextFor`）：
     * 一旦 `describeAll` 落地，**之后每一轮**查表都能命中上面这些图片的描述
     * —— "入站预取没赶上这一轮"不再是终点，下一轮照样有。
     */
    const cell = { ready: false, table: new Map() };

    try {
      const described = this.imageDescriber.describeAll(
        picked.flatMap((entry) => collectImageSegments(entry.segments)),
        { withSource: true, limit: PROMPT_MAX_IMAGES },
      );
      if (described === null || typeof described?.then !== 'function') return empty;
      described.then((result) => {
        cell.ready = true;
        if (result instanceof Map) {
          for (const [key, value] of result) cell.table.set(key, value);
        }
      }).catch((error) => {
        cell.ready = true;
        this.log('warn', '转录图片描述失败（本轮转录按 `[图片]` 渲染）', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      this.log('warn', '转录图片描述失败（本轮转录按 `[图片]` 渲染）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }

    return (message) => {
      const segments = collectImageSegments(message?.segments);
      if (segments.length === 0) return null;
      const memo = this.imageTextMemo.get(chatId);
      // ⚠️ 判据是"**两者都还没有**"才算查不到 —— 这里踩过一次（2026-10-13）：
      // 第一版把 `if (!cell.ready) return null` 放在**备忘查询之前**，于是
      // "预取已经算好、就等这一轮渲染"那种最好的情况反而被挡在门外
      // （现象：`memoSize:1` 明明有描述，提示词里还是 `[图片]`）。
      // 备忘（同步、已落地）**优先**，异步的 `cell` 只是兜底。
      if (!cell.ready && (memo === undefined || memo.size === 0)) return null;
      return segments.map((seg) => {
        // 空键（段里既没 url 也没 file）**不查表** —— 所有无键的图会挤在同一个
        // 键上，查到的可能是别人的描述（那就是"编一句"）。
        const key = imageKey(seg);
        if (key === '') return '';
        // 顺序：同步备忘 → 异步表（这一轮现算的）。前者更新，后者是兜底。
        const hit = memo?.get(key) ?? cell.table.get(key);
        if (hit === null || hit === undefined) return '';
        return typeof hit === 'string' ? hit : String(hit.text ?? '');
      });
    };
  }

  /**
   * 「本条消息引用了这条消息：」那一段（2026-11-02）。**只在真的带引用时非空。**
   *
   * ## 为什么是"回查转录"而不是"在这里问 NapCat 要原文"
   *
   * 被引用的消息**通常已经在转录里**（`engine.transcript(chatId)` 存的就是
   * `InboundMessage` 对象，而它带 `messageId`）—— 回查是**同步、零额外调用**的。
   *
   * ## 退化路径（2026-11-04 补的 `get_msg`）
   *
   * 转录里对不上时**先查缓存**（`#findQuoted` 的末行），缓存由 `#primeQuoted`
   * 在 `handleEvent` 里 await 填好 —— 那一步才是唯一会发 WS 请求的地方，
   * 而且只在"转录没有 / 这个 id 没问过"时才发生（见 `#primeQuoted` 的三个早退）。
   * 这里保持**纯同步**，是因为它被 `#buildPrompt` 的十几处拼接共用、返回 `string`；
   * 为了它把整条提示词路径改成异步，代价远大于收益。
   *
   * 拿不到仍然退化成"只报 id"（②）：**必须告诉模型"这是一条引用"** ——
   * 光给孤立那句正文正是这次要修的病。
   *
   * ## 为什么格式复用 `renderEntries`
   *
   * 引用的原文和转录里的同一条**必须长得一模一样**（时间戳/昵称/`(QQ)`/图片描述）。
   * 在网关里再写一份格式就是第二个来源，漂移时表现是"引用里那句和上面转录里
   * 那句对不上，模型以为不是同一条"。所以直接用引擎那个导出函数渲染**单条**。
   *
   * ⚠️ 空数组 ⇒ 调用方必须**一个字节都不改**地拼提示词（没引用的消息占了绝大多数，
   * 这段会永久留在会话历史里，不能给所有消息都加）。
   *
   * @param {import('../onebot/protocol.mjs').InboundMessage} message
   * @param {((message: any) => string[]|null)|null} [imageText] 图片描述表（同转录那一路）
   * @returns {string[]} 要插进提示词的行；空数组 = 没带引用 / 拿不到 id
   */
  #quoteLines(message, imageText = null) {
    const id = typeof message?.replyToId === 'string' ? message.replyToId.trim() : '';
    if (id === '') return [];
    const lines = [QUOTE_HEADER];
    const quoted = this.#findQuoted(message, id);
    if (quoted === null) {
      // 退化路径（b）：不知道原文，但**必须让模型知道"这条是在回复某条消息"**。
      // 只报 id：不编内容、也不假装没有引用。
      lines.push(`（原文没找到 —— 引用的是一条 id 为 ${id} 的消息，它不在最近的对话记录里）`);
      return lines;
    }
    // `now` 用触发消息的时间：这样"昨天那条"会带日期（`11-01 22:14`），
    // 而"刚刚那条"是裸 `HH:MM` —— 与转录里同一套判据（见 `formatStamp`）。
    const at = Number.isFinite(message?.at) ? message.at : Date.now();
    const rendered = renderEntries([quoted], imageText, { now: at });
    if (rendered !== '') lines.push(rendered);
    return lines;
  }

  /**
   * 在转录里按 `messageId` 找回**被引用的那条消息**。
   *
   * 比较用 `String()`：`reply` 段的 `id` 是**字符串**（真机样本 `"551866400"`），
   * 而 `InboundMessage.messageId` 是**数字**（`normalizeEvent` 走 `Number()`）——
   * 直接用 `===` 永远对不上，这是个静默失效（"这段代码从来没命中过"）。
   *
   * 按对象引用把当前这条跳掉：它自己也在转录里（`decide()` 先 push 再判），
   * 而"引用了自己"没有意义。
   *
   * @param {import('../onebot/protocol.mjs').InboundMessage} message
   * @param {string} id 被引用消息的 id（字符串）
   * @returns {import('../onebot/protocol.mjs').InboundMessage|null}
   */
  #findQuoted(message, id) {
    const transcript = this.engine?.transcript?.(message?.chatId);
    if (transcript !== null && transcript !== undefined && typeof transcript.snapshot === 'function') {
      const entries = transcript.snapshot();
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry === null || entry === undefined || entry === message) continue;
        const mid = entry.messageId;
        if (mid === undefined || mid === null) continue;
        if (String(mid) === id) return entry;
      }
    }
    // 转录里没有 ⇒ 查 `get_msg` 那一层的结果（见 `#primeQuoted`）。
    // 顺序刻意是"转录优先"：绝大多数引用在转录里（同步、零调用），
    // 缓存只服务"小鲸鱼自己发的 / 已被挤出窗口的"那两种。
    return this.#quoteCacheGet(id) ?? null;
  }

  /**
   * 缓存里查一条被引用消息。
   *
   * 三态是**故意的**（调用方靠它区分"没问过"和"问过没拿到"）：
   * - `undefined` = 没问过（该去问）；
   * - `null` = 问过，但没拿到（**别再问**，见 `QUOTE_CACHE_TTL_MS` 那段）；
   * - 对象 = 拿到了。
   *
   * @param {string} id
   * @returns {any}
   */
  #quoteCacheGet(id) {
    const hit = this.quoteCache.get(id);
    if (hit === undefined) return undefined;
    if (Date.now() - hit.at > QUOTE_CACHE_TTL_MS) {
      this.quoteCache.delete(id);
      return undefined;
    }
    return hit.entry;
  }

  /**
   * 写缓存（同时按插入顺序淘汰最老的一条，`Map` 的迭代顺序就是插入顺序）。
   * @param {string} id
   * @param {any} entry `null` 表示"问过但没拿到"
   */
  #quoteCacheSet(id, entry) {
    if (this.quoteCache.size >= QUOTE_CACHE_MAX) {
      const oldest = this.quoteCache.keys().next();
      if (oldest.done !== true) this.quoteCache.delete(oldest.value);
    }
    this.quoteCache.set(id, { at: Date.now(), entry });
  }

  /**
   * 引用原文的**兜底预取**（2026-11-04）：转录里找不到时，问一次 NapCat。
   *
   * ## 为什么必须单独一步（而不是在 `#quoteLines` 里 await）
   *
   * `#quoteLines` / `#buildPrompt` 是**纯同步**的（它们被 `#buildPrompt` 的
   * 十几处拼接共用，返回 `string`）。把它改成 async 等于让整条提示词路径变形；
   * 所以异步的那一半放在这里，在 `handleEvent` 里**先 await 完**，同步那一半
   * 只查缓存（`#findQuoted` 的末行）。契约因此保持不变。
   *
   * ## 只在退化路径上问
   *
   * 三个早退：没带引用 / 转录里能对上 / 这个 id 问过了（含问过没拿到）。
   * 所以**正常引用一次都不问**，`get_msg` 只在"引的是小鲸鱼自己的话"或
   * "引的太旧已被挤出转录"时发生。
   *
   * ## 绝不抛
   *
   * 它挂在主链路上（`handleEvent`），抛出去就是这一轮整个失败。
   * 内部每条路都吞成日志 + `null`，最坏结果是退回"只报 id"那一行。
   *
   * @param {import('../onebot/protocol.mjs').InboundMessage} message
   * @returns {Promise<void>} **永不 reject**
   */
  async #primeQuoted(message) {
    try {
      const id = typeof message?.replyToId === 'string' ? message.replyToId.trim() : '';
      if (id === '') return;
      if (this.#findQuoted(message, id) !== null) return;
      if (this.#quoteCacheGet(id) !== undefined) return;
      const entry = await this.#fetchQuoted(id, message);
      this.#quoteCacheSet(id, entry);
      if (entry !== null) {
        this.log('info', '引用原文从 get_msg 取回', {
          chatId: message?.chatId ?? '',
          messageId: id,
          chars: String(entry.text ?? '').length,
        });
      }
    } catch (error) {
      // 连缓存都不写：下一次遇到同一条还能再试一次（这一条几乎不可能走到）。
      this.log('warn', '引用原文兜底失败（按"原文没找到"处理）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 发一次 `get_msg` 并把它转成和转录条目**同形**的消息对象。
   *
   * 复用 `normalizeEvent({ignoreSelf:false})` 而不是自己解析段数组：段形状、
   * `@` 渲染、昵称清洗、`time*1000` 这些规则只能有一个来源，否则"引用里那句
   * 和转录里那句长得不一样"（正是 `renderEntries` 那段注释说的病）。
   * `ignoreSelf: false` 是这里的**关键**：被引用的很可能就是小鲸鱼自己发的，
   * 默认的防自循环会把最该救的那种直接判成 `null`。
   *
   * @param {string} id 被引用消息 id（字符串）
   * @param {import('../onebot/protocol.mjs').InboundMessage} message 触发引用的那条
   * @returns {Promise<any|null>}
   */
  async #fetchQuoted(id, message) {
    const request = this.transport?.request;
    if (typeof request !== 'function') return null;
    const numeric = Number(id);
    // `get_msg` 的 `message_id` 是数字。非数字 id / 超出安全整数 ⇒ 问了也是白问。
    if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
    const data = await request.call(this.transport, 'get_msg', { message_id: numeric }, {
      timeoutMs: this.quoteLookupTimeoutMs,
    });
    if (data === null || typeof data !== 'object') return null;
    return this.#quotedFromGetMsg(data, numeric, message);
  }

  /**
   * `get_msg` 的 `data` → `InboundMessage`（转录条目的同形对象）。
   *
   * 对端字段缺一半也要能活：`message_type` 缺了按"有没有 group_id"推断，
   * `sender` 缺了 `normalizeEvent` 自己会退回 `user_id` 当昵称。
   * 拼不出合法消息（`normalizeEvent` 返回 `null`）⇒ 也返回 `null`，退化成"只报 id"。
   *
   * @param {any} data
   * @param {number} numeric 请求用的 message_id（对端不一定回填）
   * @param {import('../onebot/protocol.mjs').InboundMessage} message 触发引用的那条
   * @returns {any|null}
   */
  #quotedFromGetMsg(data, numeric, message) {
    const senderId = data.sender?.user_id ?? data.user_id;
    if (senderId === undefined || senderId === null) return null;
    const groupId = data.group_id ?? (data.message_type === 'group' ? message?.groupId : undefined);
    const kind =
      data.message_type === 'group' || data.message_type === 'private'
        ? data.message_type
        : groupId !== undefined && groupId !== null && groupId !== ''
          ? 'group'
          : 'private';
    const normalized = normalizeEvent(
      {
        post_type: 'message',
        message_type: kind,
        message_id: data.message_id ?? numeric,
        user_id: senderId,
        ...(kind === 'group' ? { group_id: groupId } : {}),
        time: data.time,
        sender: {
          user_id: senderId,
          nickname: data.sender?.nickname,
          card: data.sender?.card,
        },
        message: data.message,
        raw_message: data.raw_message,
        self_id: this.transport?.selfId || undefined,
      },
      // ⚠️ **不能忽略自己**：被引用的经常就是小鲸鱼自己的发言（这正是本次要修的病）。
      { botQQ: this.transport?.selfId, ignoreSelf: false },
    );
    // 空正文（对端给了个空段）等于"没拿到"：渲染出来会是一行
    // `[时间 昵称(QQ)]: `，比"原文没找到"更误导。
    if (normalized === undefined || normalized === null) return null;
    if (String(normalized.text ?? '').trim() === '') return null;
    return normalized;
  }

  /**
   * 这条消息该用哪套「说不说」的裁量模式（2026-11-01）。
   *
   * 优先级：
   * 1. **私聊且配了 `judgeModePrivate`** ⇒ 用它（全局 `judgeMode` 管不到私聊）；
   * 2. 判定结果上挂着的 `judgeMode`（单测可以只传 `decision`）；
   * 3. 兜底 = 网关构造时的全局 `judgeMode`。
   *
   * 群聊**永远不吃第 1 条**：那边靠 precheck 省掉白跑的整轮，
   * 不该因为她在群里吭了一声就改路子。
   */
  #modeFor(message, decision = null) {
    if (message !== null && typeof message === 'object'
      && message.kind === 'private'
      && this.judgeModePrivate !== '') {
      return this.judgeModePrivate;
    }
    const fromDecision = decision !== null && typeof decision === 'object' ? decision.judgeMode : undefined;
    return typeof fromDecision === 'string' && fromDecision !== '' ? fromDecision : this.judgeMode;
  }

  /**
   * 构造交给会话的提示词。
   *
   * - **被点名**（@ / 私聊 / 喊名字）：那条消息 + （群里的话）**前面的转录**。
   * - **未被点名**（群里没人叫，是它自己想接话）：把最近聊天给它，让它接一句。
   *
   * ## ⚠️ 被 @ 那一轮也要带转录（2026-10-07 改，账本 §十）
   *
   * 用户 2026-10-07 的原话：
   * > 一般情况下只 @ 小鲸鱼的时候是**前面发过几条她没回**，于是 @，
   * > 或者我**单纯想看看她有没有掉线**，@ 一下，**不论如何都得看一眼前面的聊天消息**。
   *
   * 在那之前，被点名那一轮**只有那一条消息** —— 而前面那几条正是因为被闸门挡住、
   * 压根没派发过轮次，所以 agent 会话历史里也没有。小鲸鱼于是只能干巴巴回一句"在的？"。
   *
   * 现在是「**都带转录**，被点名时额外把这一条展开得更细」：
   *
   * ```
   * 群里刚在聊：
   * [02:48 …] ……
   * [02:50 …] ……
   * 【刚 @ 你的那条】[02:52 用户(30000001)] @30000002
   * （@ 了你，但没说话 —— 可能是催你，也可能是看你掉线没有）
   * ```
   *
   * **私聊不加**：私聊每条消息都会起一轮，会话历史里本来就有上下文，再塞一份转录
   * 只是重复；而且「群里刚在聊」这句话在私聊里也不成立。
   *
   * 代价（已与用户说明）：这 20 条转录会跟着被点名那轮**永久进 `qq-group-*` 会话历史**，
   * 而被点名是最常见的触发方式 → 这笔开销每次交互都付。
   *
   * ## 引用（2026-11-02）
   *
   * 这一条**带引用**时（`message.replyToId` 非空），在前面多插一段：
   *
   * ```
   * 本条消息引用了这条消息：
   * [11-01 22:14 用户(30000001)] 昨天那句原话……
   * ```
   *
   * 位置：被点名那两路在**这一条正文之前**；环境轮在**转录之后**（那一路的正文就在
   * 转录末尾，插到前面会跑到别人几句话之前）。**没带引用时一个字节都不加** ——
   * 见 `#quoteLines()`。
   *
   * @param {import('../onebot/protocol.mjs').InboundMessage} message
   * @param {{restricted: boolean}} verdict
   * @param {{addressed: boolean, score?: number, threshold?: number}} decision
   * @param {string|null} [richText] 展开后的正文（合并转发/文件）；null 表示没有可展开的东西
   * @param {string} [judgeMode] 「说不说」的裁量模式；`inTurn` 时才往提示词里加"倾向"段
   * @returns {string}
   */
  #buildPrompt(message, verdict, decision, richText = null, judgeMode = 'heuristic') {
    // 模式 3（`inTurn`）的那段"倾向"。**非 inTurn 时恒为空串** ⇒ 提示词逐字不变。
    const leaning = judgeMode === 'inTurn' ? inTurnLeaning(decision, this.promptCfg.inturnNote) : '';
    const withLeaning = (text) => (leaning === '' ? text : `${text}\n\n${leaning}`);
    // 有展开内容就用它替换占位符 —— 否则保持原样，不改动既有行为。
    const textOverride = richText === null ? {} : { text: richText };
    // 图片描述表：**正文与转录共用同一张**（见 `#imageTextFor` 的说明）。
    // 顶层图原来在提示词里只有裸 `[图片]` —— `expandRichText` 不认顶层图
    // （`rich.mjs:502` 那条：顶层不进 `images` 清单、也不查 `imageText`），
    // 所以这张表是"@ 我的那条带图"唯一能拿到描述的地方，也是环境轮唯一的通道。
    const lookup = this.#imageTextFor(message.chatId);
    const withImages = (text) => replaceImagePlaceholders(text, lookup(message));
    // 「本条消息引用了这条消息：」那段（2026-11-02）。
    // **没带引用时是空数组** ⇒ 下面每一处拼接都退化成原文，一个字节都不变。
    const quote = this.#quoteLines(message, lookup);
    if (decision.addressed === true) {
      const rendered = withImages(
        renderPrompt(message, { restricted: verdict.restricted, ...textOverride }),
      );
      // 引用原文放在**这一条的正文之前**（用户举的例子就是这个顺序）：
      // 「本条消息引用了这条消息：[原文]」→ 然后才是「[时间] 昵称: 这个不行」。
      // 私聊那条路也吃这一段 —— 用户主要就在私聊里用它。
      const renderedWithQuote = quote.length === 0 ? rendered : `${quote.join('\n')}\n${rendered}`;
      // 纯 @（@ 了我却没打字）：正文里只剩一个 `@我自己的QQ`，
      // 模型看不出对方想干嘛（`[02:52 用户(30000001)] @30000001`）。
      // 补一句说明，免得它回一句莫名其妙的话。
      //
      // ⚠️ 判空必须**去掉 @ 目标**：`message.text` 现在非空（就是那个 `@QQ`），
      // 拿它判空会让这条提示语永远不触发（见 `bodyWithoutMentions`）。
      //
      // ⚠️ 措辞也要准：旧文案光说「@ 了你，但没说话」是**误导**的 —— 读起来像
      // "对方只是 @ 了一下"，而真实情况更可能是"前面发过几条你没回，来催你"
      // 或者"看看你掉线没有"（用户 2026-10-07 原话）。
      const pureAt =
        bodyWithoutMentions(message) === ''
        && message.mentioned === true
        && message.replyToSelf !== true;
      const atNote = pureAt ? this.promptCfg.turnPureAt : '';
      if (message.kind !== 'group') {
        return withLeaning(atNote === '' ? renderedWithQuote : `${renderedWithQuote}${atNote}`);
      }
      // 转录里已经包含这一条（引擎在过闸门前就 push 了），所以剔掉它再渲染 ——
      // 否则同一条消息会以"先前聊天"和"刚 @ 你的那条"两种身份各出现一次。
      //
      // 第三个参数 = **图片描述注入**（2026-10-13）：转录里更早消息的图
      // 原来是裸 `[图片]`（`engine.mjs` 只存 `m.text`），现在换成 `[图片: …]`。
      const transcript = this.engine.transcript(message.chatId)
        .renderExcept(message, 20, lookup);
      const lines = [];
      if (transcript !== '') lines.push(this.promptCfg.turnGroupHeader, transcript, '');
      // 引用原文夹在"先前聊天"和"刚 @ 你的那条"之间：读起来就是
      // 「群里刚在聊 → 它引用了这条 → 然后它 @ 你说这句」。
      if (quote.length > 0) lines.push(...quote);
      lines.push(`${this.promptCfg.turnAtHeader}${rendered}`);
      if (atNote !== '') lines.push(atNote);
      return withLeaning(lines.join('\n'));
    }
    // ⚠️ 环境轮这条**原来一个描述都拿不到**（`IMAGE-DESC-BUG.md` 的结论）：
    // 正文里的描述只进"当前这一条"（上一行的 `rendered`），而这条提示词
    // **只用转录** ⇒ 图在转录里永远只有 `[图片]`。这个第三个参数就是那条通道。
    const transcript = this.engine.transcript(message.chatId)
      .render(20, lookup);
    const lines = [
      this.promptCfg.turnGroupHeader,
      transcript,
      '',
    ];
    // 环境轮里**这一条本身就在转录末尾**（引擎先 push 再判定），所以引用原文
    // 只能接在转录之后 —— 否则会插到别人几句话的前面，读起来像那条在引用更早的消息。
    // 被引用的那条通常就在上面几行里，这里相当于点名"它是引的那一条"。
    if (quote.length > 0) lines.push(...quote, '');
    lines.push(
      // 措辞可配（`[proactive] interject_prompt`）；没配就用内置默认 —— 与改动前逐字相同。
      this.interjectPrompt !== '' ? this.interjectPrompt : DEFAULT_INTERJECT_PROMPT,
    );
    // ===== 模式 3：inTurn —— 总分当"倾向"塞进提示词，**由这一轮自己拍板** =====
    //
    // 与模式 1 的区别**只在这里**：模式 1 是"分数 ≥ 阈值 ⇒ 一定进 agent 并开口"；
    // 模式 3 是"分数 ≥ 阈值 ⇒ 有机会进 agent，但**说不说由它自己定**"。
    // 所以给两样东西（画布 [6-6] 的设想 + 用户 2026-10-13 的"由它自己决定说不说"）：
    //   ① **总分当倾向**（不是命令）：让它知道启发式为什么觉得这个点值得接；
    //   ② **明确允许弃权**：空回复是合法的 —— 没有这一句，模型会默认"被叫起来就得说"。
    //
    // ⚠️ 缺席（`judgeMode !== 'inTurn'`）时**一个字节都不加** ⇒ 模式 1/2 的提示词
    //    与改动前逐字相同（`withLeaning` 在 `leaning === ''` 时原样返回）。
    return withLeaning(lines.join('\n'));
  }

  /**
   * 记一条「判官/启发式决策」日志（`kind:'gauge'`）—— **只读旁路**。
   *
   * ## 三条铁律（`gauge-log.mjs` 的文件头写着同一条）
   *
   * 1. **绝不抛**：它挂在每条消息的热路径上，抛出去 = 宿主进程退出
   *    （`qq-plugin/AGENTS.md` 第三节）。所以整段一个 try/catch，失败只落 debug。
   * 2. **不改判定**：不碰 `decision`（只读字段）、不 await、不挡发送。
   * 3. **关着就一个字节都不碰**：`gaugeLog` 为 null / `open()` 内部判开关。
   *
   * ## 记哪些
   *
   * 只记**主动接话**的候选：过了启发式那一步、且**不是被点名**的。
   * `@` / 私聊 / 喊名字是别人的明确请求 —— 闸门短路放行、判官压根不问，
   * 记进来只会把"要不要插一句"的样本稀释掉。
   *
   * @param {object} message 触发这条判定的消息
   * @param {object} decision `engine.decide()` 的返回值（含 `score`/`threshold`/`detail`）
   * @param {object} judge 判官结论（`judge-mode.mjs` 的 `outcome`，或启发式的占位）
   * @returns {{turnId: string, chatId: string, context: string}|null} 失败/关闭 ⇒ null
   * @private
   */
  #openGaugeLog(message, decision, judge) {
    const sink = this.gaugeLog;
    if (sink === null || typeof sink !== 'object' || typeof sink.open !== 'function') return null;
    try {
      if (decision === null || typeof decision !== 'object' || decision.addressed === true) return null;
      // 上下文（前 20 条转录）**只在这一刻取一次**：它和判官看到的是同一份
      // （判官那次请求用的也是 `transcript.render(20)`），而且之后转录还会继续变。
      // 取不到就空着 —— 绝不因为渲染失败丢掉整条记录。
      let context = '';
      try {
        const transcript = typeof this.engine?.transcript === 'function'
          ? this.engine.transcript(message.chatId)
          : null;
        if (transcript !== null && transcript !== undefined && typeof transcript.render === 'function') {
          context = String(transcript.render(20) ?? '');
        }
      } catch {
        context = '';
      }
      return sink.open({
        chatId: message.chatId,
        chatKind: message.kind === 'private' ? 'private' : 'group',
        userId: message.userId,
        messageText: message.text,
        messageAt: message.at,
        context,
        score: decision.score ?? null,
        threshold: decision.threshold ?? null,
        // **整个分项对象**（不摊平、不挑项）—— 这是用户最想看的那一项。
        detail: decision.detail ?? null,
        judge,
        pmode: this.#modeFor(message, decision),
        // 引擎给的放行原因（`scored` / `focus` / `incomplete-followup`）：
        // 分数没过阈值却走到这里的那几种，全靠这个字段才不会读成"阈值失效"。
        reason: decision.reason,
        focus: decision.focus,
        addressed: decision.addressed === true,
      });
    } catch (error) {
      this.log('debug', '判定日志：建记录失败（忽略，不影响判定）', {
        chatId: message?.chatId ?? '',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 这一轮**真的发出去了** ⇒ 补一行 `kind:'out'`（正文 + 20 条上下文）。
   *
   * 正文的取法：`runTurn` 把**每一段真正发出去的文字**按顺序推进 `sentBodies`，
   * 这里按 `\n` 拼起来 —— 与需求里"分段的话按 `\n` 拼接"一致，
   * 且拿的是**发出去的**，不是模型原始输出（那两者在 `[不说话]` / 同文短窗 /
   * `send_qq` 已经发过 的几种情况下并不相同）。
   *
   * 一段都没发出去（`[不说话]` / 空回复 / 发送全失败）⇒ **不写**：
   * 这一行的语义是"发到群里的正文"，写空的会让人以为发了。
   *
   * @param {object|null} turn `#openGaugeLog` 的返回值
   * @param {string[]|null} sentBodies `runTurn` 收集的"真的发出去的段"
   * @private
   */
  #closeGaugeLog(turn, sentBodies) {
    const sink = this.gaugeLog;
    if (sink === null || typeof sink !== 'object' || typeof sink.complete !== 'function') return;
    if (turn === null || typeof turn !== 'object') return;
    try {
      const bodies = Array.isArray(sentBodies)
        ? sentBodies.map((text) => String(text ?? '').trim()).filter((text) => text !== '')
        : [];
      if (bodies.length === 0) return;
      sink.complete(turn, { output: bodies.join('\n') });
    } catch (error) {
      this.log('debug', '判定日志：输出段落盘失败（忽略，不影响发送）', {
        chatId: turn?.chatId ?? '',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 把一条消息交给对应会话，并把回复发回 QQ。
   * @param {import('../onebot/protocol.mjs').InboundMessage} message
   * @param {{sessionKey: string, restricted: boolean, reason: string}} verdict
   * @param {string} prompt 已渲染好的提示词
   * @param {{addressed?: boolean}} [decision] 判定结果（用于记账：被点名的不占配额）
   * @param {object|null} [gaugeTurn] 判定日志的句柄（见 `#openGaugeLog`）；
   *   `null` = 没开 / 不是主动接话的候选 ⇒ 这一轮不补 `kind:'out'` 那行
   */
  async dispatch(message, verdict, prompt, decision = {}, gaugeTurn = null) {
    const { chatId, kind } = message;
    // 会话去向由 routing 的纯函数决定（私聊可能是 isolated 或 main），
    // 不在这里再推一遍——两处规则漂移的后果是"消息进了错的会话"。
    //
    // 2026-10-24：**映射表只在 binder.ensure 里记**（P2-6）。
    // 曾经在这里也记一次（P1-4 的"迁移期积累"），但 `new-if-no-legacy` 下这里
    // 只知道"候选旧 id"，还不知道 resume 会不会成功 —— 先记下去就会把新聊天
    // 错误地钉在旧 id 上。⇒ 挪进 ensure：它知道最终用了哪个 id。
    const target = resolveSessionTarget(message, this.router.config, { lookup: this.chatLookup });
    const sessionKey = target.sessionKey === '' ? `qq-${kind}-unknown` : target.sessionKey;
    if (target.reason.startsWith('dm-main-missing-key')) {
      this.log(
        'warn',
        'dmRouting=main 但没配 mainSessionKey，已回落到每联系人独立会话',
        { chatId },
      );
    }

    // 同一会话串行：并发回复会互相打断，QQ 里看起来像精神分裂。
    // **按 sessionKey 串行而不是按 chatId**：main 模式下多个私聊联系人共用一个
    // 会话，按 chatId 加锁会让它们互不排队、同时往同一个会话里灌消息。
    const previous = this.inFlight.get(sessionKey);
    if (previous !== undefined) {
      this.log('debug', `会话 ${sessionKey} 上一轮还在跑，本轮排队`, {});
      await previous.catch(() => undefined);
    }

    /**
     * **这一轮真正发出去的正文**（按段收集，给判定日志的 `kind:'out'` 那行用）。
     *
     * 为什么让 `runTurn` 往里推、而不是在这里拿返回值：返回值是**模型原始输出**
     * （`return text`），而"发到群里的是什么"还要经过 `[不说话]` 标记、静默轮、
     * `send_qq` 已发过、同文短窗、切条这几道 —— 那些情况下两者**并不相同**。
     * 只在 `gaugeTurn` 存在时才建数组，常规轮次不多造一个对象。
     */
    const sentBodies = gaugeTurn === null ? null : [];
    const task = this.runTurn({
      message,
      sessionKey,
      restricted: verdict.restricted,
      prompt,
      addressed: decision.addressed === true,
      judgeMode: this.#modeFor(message, decision),
      sentBodies,
    });
    // 锁的键也用 sessionKey，与上面的排队判断保持一致。
    this.inFlight.set(
      sessionKey,
      task.catch(() => undefined).finally(() => {
        if (this.inFlight.get(sessionKey) === task) this.inFlight.delete(sessionKey);
      }),
    );

    try {
      const reply = await task;
      this.stats.dispatched += 1;
      // 这一轮结束了 —— 真发出去的话，把正文 + 上下文补成一行（`kind:'out'`）。
      // ⚠️ 放在 `dispatched` 之后、返回之前：**只加一行日志**，返回值的形状一个字都不动。
      this.#closeGaugeLog(gaugeTurn, sentBodies);
      return { outcome: OUTCOME.DISPATCHED, reason: verdict.reason, chatId, reply };
    } catch (error) {
      this.stats.failed += 1;
      this.log('error', `会话 ${sessionKey} 处理失败`, {
        error: error instanceof Error ? error.message : String(error),
      });
      // 这一轮炸了，但**已经发出去的段**仍然值得留档（"说了一半就没了"正是要查的）。
      this.#closeGaugeLog(gaugeTurn, sentBodies);
      return {
        outcome: OUTCOME.FAILED,
        reason: verdict.reason,
        chatId,
        reply: '',
      };
    }
  }

  /**
   * 跑一轮：提示词 → 会话 → 回复 → 发回。
   *
   * @param {object} options
   * @param {boolean} [options.silent] **不回 QQ**。
   *   用于"主会话 → 小鲸鱼"的内部通道：技术沟通不该每条都推到用户面前。
   *   静默轮只写会话、不发消息（但照样记 `noteReplied`，否则判定层会以为自己没说过话）。
   * @param {unknown[]} [options.images] 本轮回复要**附带发出去**的图
   *   （URL / 本地路径 / `{sticker:'<md5>'}`）。省略 = 纯文本（老行为）。
   */
  /**
   * **把这一轮的语音段转成文字**（B4 真答案，2026-10-25）—— **永不抛**。
   *
   * 做两件事（顺序有讲究）：
   * 1. 给段对象补上 `text`（下游 `runTurn` 靠它判断"这条已经听得见了"，
   *    决定还要不要说"你听不到"那句）；
   * 2. **改写 `message.text`**：把 `[语音（未转写）]` 换成 `[语音：<文字>]`。
   *    改在这里 = 提示词、引擎转录、判定层看到的是同一份文字（不会有一处说有、一处说没有）。
   *
   * ⚠️ 替换用**函数**形式：转写出来的文字可能含 `$&` 这类字符，字符串形式的
   *    `String.replace` 会把它们当替换标记展开（AGENTS.md 那条踩过的坑）。
   *
   * ⚠️ 整段包 try/catch：它是**派发路径上**的一步，转写失败只能降级成占位符，
   *    绝不能把这一轮弄没。
   *
   * @param {any} message
   * @returns {Promise<void>}
   */
  async #transcribeVoice(message) {
    const transcriber = this.voiceTranscriber;
    if (transcriber === null || transcriber.enabled !== true) return;
    let pending = [];
    try {
      const list = Array.isArray(message?.segments) ? message.segments : [];
      pending = list.filter((segment) => segment !== null && typeof segment === 'object'
        && segment.type === 'record' && String(segment.text ?? '').trim() === '');
    } catch {
      // 段是别处造的东西（带 getter / 结构怪）⇒ 当作没有语音，别把这一轮弄没。
      return;
    }
    if (pending.length === 0) return;

    const action = typeof this.transport?.action === 'function'
      ? (name, params, options) => this.transport.action(name, params, options)
      : null;
    const placeholder = SEGMENT_PLACEHOLDERS.record;

    for (const segment of pending) {
      let result;
      try {
        result = await transcriber.transcribe({
          segment,
          action,
          // `fetch_ptt_text` 要的是**消息 id**（不是文件名）—— 这是"用 QQ 自己的转写"
          // 那条路的入口。旧段（没有 id）时传空串，转写器会直接走 whisper。
          messageId: message?.messageId ?? '',
        });
      } catch (error) {
        this.log('warn', '语音转写抛了（这一条按未转写处理）', {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const text = result !== null && typeof result === 'object' && result.ok === true
        ? String(result.text ?? '').trim()
        : '';
      if (text === '') {
        // 失败原因已经在 voice.mjs 里 warn 过了；这里只留一条 debug 便于对账。
        this.log('debug', '语音没有转出文字（保留占位符）', {
          chatId: message?.chatId ?? '',
          error: result?.error ?? '',
        });
        continue;
      }
      segment.text = text;
      const replacement = `[语音：${text}]`;
      const source = String(message?.text ?? '');
      message.text = source.includes(placeholder)
        ? source.replace(placeholder, () => replacement)
        : `${source}${source === '' ? '' : ' '}${replacement}`;
      this.log('info', `语音已转文字 ${message?.chatId ?? ''}`, {
        chars: text.length,
        ms: result.ms ?? 0,
        cached: result.cached === true,
      });
      // 2026-10-26：**转写之后**再旁路听一遍情绪（只算 arousal、只记录、不进提示词）。
      // ⚠️ **不 await**：它要起一个 python + import torch（冷启动约 2~5 秒），
      //    等她算完再回话就是把回复拖慢几秒。`.catch()` 兜底 —— 这条是挂在派发路径上的。
      void this.#senseEmotion({ segment, text, message, action });
    }
  }

  /**
   * **语音情绪旁路**（2026-10-26）：只算 arousal、只记录。
   *
   * ## 为什么是旁路、且不 await
   *
   * 情绪**不是**回复所必需的：`arousal` 现在只进快照（观察期），v1 不进提示词。
   * 而它的成本是"起 python + import torch"（冷启动 2~5 s）—— 等它就是拿回复速度换
   * 一个暂时没人用的数。所以：fire-and-forget，`#transcribeVoice` 里不 await。
   *
   * ## 它绝对不能影响任何东西
   *
   * 整段包 try/catch，失败只留一条 debug 日志 + `stats.failed`。
   * **音频要自己再取一次**（`get_record`）：`engine=auto` 命中 `fetch_ptt_text` 时
   * `voice.mjs` **根本没取过音频**；即使取了，那条临时 wav 在转写结束时已经被删掉了。
   * 取一次约 30~180 ms（本机 NapCat，已缓存时更快），比 import torch 便宜得多。
   *
   * ## 口径（用户 2026-10-26 拍板）
   *
   * - **只留 arousal**；valence/dominance 连记录都不落（`emotion.mjs` 那边就不返回）。
   * - `arousal ≥ arousal_threshold` 时记 `overThreshold: true` —— **只是记下来**，
   *   以后要进提示词时就用这句：`（听感参考，可能不准：这条语音听着挺急的）`。
   *   那一步没做，别在这里偷偷加。
   *
   * @param {{segment: object, text: string, message: object, action: Function|null}} input
   * @returns {Promise<void>} 永不 reject
   */
  async #senseEmotion({ segment, text, message, action }) {
    const senser = this.emotionSenser;
    if (senser === null || senser.enabled !== true) return;
    const file = String(segment?.file ?? '').trim();
    if (file === '') return;
    if (this.emotionInFlight.has(file)) return;
    this.emotionInFlight.add(file);
    try {
      if (typeof action !== 'function') return;
      let audioPath = '';
      try {
        const data = await action('get_record', { file, out_format: 'wav' }, { timeoutMs: 20_000 });
        audioPath = String(data?.file ?? '').trim();
      } catch (error) {
        this.log('debug', '情绪旁路取音频失败（不影响转写）', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (audioPath === '') return;

      const result = await senser.sense({
        audioPath,
        text,
        chatId: String(message?.chatId ?? ''),
        messageId: message?.messageId ?? '',
      });
      // 只有**算出了分**的那条才进 recent/last（跳过和失败各自由 senser 记计数）。
      if (result?.ok === true && typeof result.arousal === 'number') {
        this.lastEmotion = result;
        this.recentEmotions.push(result);
        if (this.recentEmotions.length > 20) this.recentEmotions.shift();
        // ⚠️ 计数**只在 senser 里**（`describe().scored`）：这里再加一个 `stats.emotions`
        //    就是"同一件事两个数"，而快照是**白名单** —— 新字段不补进去会被静默吃掉
        //    （这个坑已经踩过两次：`ntqqRetries`、`stats.voices`）。**别加第二份。**
      }
    } catch (error) {
      // 这里已经是最后一层了：旁路绝不能把异常带回派发路径。
      this.log('debug', '语音情绪旁路抛了（已吞掉，不影响转写与回复）', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.emotionInFlight.delete(file);
    }
  }

  /**
   * **语音探针（B4，2026-10-25）**：每条带 `record` 段的消息记一行摘要。
   *
   * 这一行只回答"NapCat 给了哪些字段、有没有 `text`（服务端转写）"。
   * 它是**临时探针**（用户发一条语音就能得出结论），有了结论之后
   * 要么留成常驻的轻日志、要么删掉 —— 别让它长成第二个日志系统。
   *
   * ⚠️ 用 `info` 而不是 `debug`：线上日志级别可能把 debug 过滤掉，
   *    那样"探针跑了但什么都没记下来"，等于没探。
   * ⚠️ 整段包 try/catch：这是挂在**每一轮**上的代码，抛出去会变成一轮失败。
   */
  #logRecordSegments(message) {
    try {
      const list = Array.isArray(message?.segments) ? message.segments : [];
      const records = list.filter((s) => s !== null && typeof s === 'object' && s.type === 'record');
      if (records.length === 0) return;
      const summary = {
        at: new Date().toISOString(),
        chatId: String(message?.chatId ?? ''),
        count: records.length,
        transcribed: records.some((s) => String(s.text ?? s.data?.text ?? '').trim() !== ''),
        records: records.slice(0, 3).map((s) => summarizeRecordSegment(s)),
      };
      // ⚠️ **同时落进快照**（`recordProbe`）：`this.log()` 只进宿主 logger，
      // 那玩意不落盘 ⇒ 线上"探了但看不到结果"（2026-10-25 实测：日志里没有）。
      // 快照是唯一既落盘、又能被下一个会话直接读到的通道。
      this.lastRecordProbe = summary;
      this.log('info', `收到语音段（B4 探针）${message.chatId}`, {
        count: summary.count,
        transcribed: summary.transcribed,
        records: summary.records,
      });
    } catch (error) {
      this.log('debug', '语音探针失败（不影响这一轮）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async runTurn({
    message,
    sessionKey,
    restricted,
    prompt,
    addressed = false,
    silent = false,
    images = [],
    judgeMode = 'heuristic',
    /**
     * **判定日志用的收集器**（2026-11-06）：把这一轮**真正发出去**的正文按段推进来。
     *
     * `null`（默认）= 不收集（测试 / 内部通道 / 没开日志）。**纯观察**：
     * 推的是"已经交给 `#send` 且没被拦下"的文本，不参与任何发送决策。
     */
    sentBodies = null,
  }) {
    void restricted;

    // B4：语音探针 —— 放在最前面，任何一条带语音的消息都会被记下来（哪怕后面失败）。
    this.#logRecordSegments(message);

    // 图片：下载 → 存成 DSH 附件 → image block，让小鲸鱼"真的看见"而不是只看到 `[图片]`。
    //
    // 失败**只跳过图**，不影响这一轮的文字：`toImageBlocksDetailed` 内部已经吞掉每一张图的
    // 单独失败，这里再包一层是防它整体抛（比如附件服务本身没了）——
    // 那种情况下也得让文字照常发出去。
    //
    // ⚠️ 2026-10-22：长图（任一边 > `maxImageDimension`，默认 8192）会在这一层被
    //    切成几段再入库（`media.mjs` 的 `blocksForImage`）—— DSH 对源图是**硬拒收**、
    //    不缩放，所以 960×10793 那种图以前**根本进不来**。切开之后所有切片都在这批
    //    `imageBlocks` 里，`imageNotes` 是"这是同一张图的 1/2、2/2"那句说明。
    let imageBlocks = [];
    let imageNotes = [];
    try {
      const prepared = await toImageBlocksDetailed({
        attachments: this.attachments,
        segments: message.segments,
        log: this.log,
        // 取字节的兜底要问服务器（OneBot `get_file`）—— 这里把**传输层已有的 action 封装**
        // 传下去，`media.mjs` 不另写一套 HTTP（`send_msg` 走的就是这个口子）。
        // 没有传输层（单测 / 替身）时传 undefined ⇒ 少一条兜底、照旧退回 [文件]。
        oneBotAction: typeof this.transport?.action === 'function'
          ? (action, params, options) => this.transport.action(action, params, options)
          : undefined,
      });
      imageBlocks = prepared.blocks;
      imageNotes = prepared.notes;
      if (imageBlocks.length > 0) {
        this.log('debug', `本轮带 ${imageBlocks.length} 张图 ${message.chatId}`, {
          notes: imageNotes.length,
        });
      }
    } catch (error) {
      this.log('warn', '图片入库失败（本轮按纯文本处理）', {
        error: error instanceof Error ? error.message : String(error),
      });
      imageNotes = [];
    }

    // 切图说明必须进**提示词**（image block 只是图，模型不知道它们是一张图切开的）。
    // 放在末尾：前面是正文/上下文，最后一句是"怎么读这几张图"，离图最近。
    const imagePart = imageNotes.length === 0 ? '' : imageNotes.join('\n');
    // 语音说明（B4）：NapCat 的 record 段本身**没有转写**，文字是本地 whisper 转的
    // （见 `#transcribeVoice`）。所以这里的措辞分三种：
    //   · 全部转出来了 ⇒ **一个字都不加**（正文里已经写着 `[语音：…]`）；
    //   · 一条都没转出来 ⇒ 明说"你听不到、别假装听见"；
    //   · 部分转出来 ⇒ 说清还剩几条听不到（别让她拿"听见了"去糊弄没转出来的那条）。
    // 只在这一轮真的带语音时加 ⇒ 其它轮的提示词一个字节都不变。
    //
    // ⚠️ 整段 try/catch：这里读的是**段的属性**（`s.text`），而段可能是任何东西
    // （历史消息、别处造的假段、甚至带 getter 的对象）。这是每一轮都走的路，
    // 抛出去就等于"这一轮没回" —— 读不出来就当"没有语音"，别把轮次弄没。
    let voiceNote = '';
    try {
      const voiceRecords = Array.isArray(message.segments)
        ? message.segments.filter((s) => s !== null && typeof s === 'object' && s.type === 'record')
        : [];
      const voiceMissing = voiceRecords.filter((s) => String(s.text ?? '').trim() === '').length;
      const voiceHeard = voiceRecords.length - voiceMissing;
      if (voiceMissing > 0 && voiceHeard === 0) {
        voiceNote = '（本轮带了一条语音，但它**没有转写文字** —— 你听不到内容。别假装听见了，也别猜；可以请对方打字再说一遍。）';
      } else if (voiceMissing > 0) {
        voiceNote = `（本轮有 ${voiceMissing} 条语音**没有转写文字** —— 那几条你听不到，别假装听见了；有文字的那几条正文里写着。）`;
      }
    } catch {
      voiceNote = '';
    }
    const turnPrompt = [prompt, imagePart, voiceNote].filter((part) => part !== '').join('\n\n');

    // B2：**这一轮**她有没有走 `send_qq` —— 在 `responder()` 前后各读一次流水号
    // （`send_qq` 的执行发生在这个 await 里面：工具调用属于 agent 的这一轮）。
    // 工具没发出去（被同文闸/频率闸拦下、参数不合法）时**不加**流水号，
    // 于是"她试过但没发成"仍然走兜底 —— 否则 QQ 上会一片沉默。
    const toolSendSeqBefore = this.toolSendSeq.get(sessionKey) ?? 0;

    // 打上"这一轮由插件自己驱动"的标记（2026-11-02）：自动搬运看到它就完全让路。
    // 覆盖范围不只是 QQ 入站 —— `deliverFromAlice`（主会话内部通道、定时唤醒）也走这里，
    // 那些轮次的发送语义（`silent` / `quietWhenNothing` / `[不说话]`）全在原地，一个字都不动。
    this.turnsInFlight.add(sessionKey);

    // ===== 逐段外发（2026-11-04）==============================================
    //
    // 用户原话：「不要走拼接，因为时间段可能相差很多，每次都输出一次」。
    //
    // 她"边干边说"：一轮里分好几步写正文、中间夹工具调用，前后能差几十分钟。
    // 攒到最后只发最后一段 = 前面说的全丢（2026-11-02 20:15 那轮丢了 4 段）。
    //
    // 这里**不新写发送路径**：每一段仍然走 `#send` ⇒ `⟨cut⟩` 切条、Markdown 剥离、
    // 同文短窗、台账、截断一条都不少；`caller` 记 `runTurn-step<n>`，判读时看得出
    // "这是同一轮的第几段"（段内再被切条时会变成 `runTurn-step2-part1`）。
    const segments = {
      /** 真的交给了 `#send` 的段数（含失败的那几段） */
      attempted: 0,
      /** 真发出去（没被同文短窗拦下）的段数 */
      sent: 0,
      /** 抛了异常的段数 */
      failed: 0,
      /** 按判据**故意**不发的段数（`[不说话]` / 静默轮 / 工具已发过） */
      skipped: 0,
      /** 最后一段的正文，供 `noteReplied` 判"是不是问句" */
      lastText: '',
    };

    const onSegment = async (text, step) => {
      try {
        const body = String(text ?? '').trim();
        if (body === '') return;
        const label = Number.isFinite(Number(step)) && Number(step) > 0 ? Number(step) : segments.attempted + 1;
        // ① `[不说话]` 是**标记**，永远不出去（与下面整轮那条分支同一口径）。
        //    某一轮里"前面有正文、最后一段是标记"是完全可能的 —— 前面的照发。
        if (isQuietMark(body)) {
          segments.skipped += 1;
          this.log('debug', `第 ${label} 段是 [不说话]，不发 ${message.chatId}`, {});
          return;
        }
        // ② 静默轮（定时唤醒 / 内部通道）：一个字都不发 —— 与改动前一致。
        if (silent) {
          segments.skipped += 1;
          return;
        }
        // ③ `auto_reply=off`：自动发送整个关掉。
        if (this.autoReply === 'off') {
          segments.skipped += 1;
          return;
        }
        // ④ 这一轮她已经用 `send_qq` 说过了 ⇒ **后面**的段不再自动发（B2 同一口径）。
        //    先发的段已经上路了（时间上确实在工具调用之前），不算重复。
        const toolSentNow = (this.toolSendSeq.get(sessionKey) ?? 0) > toolSendSeqBefore;
        if (this.autoReply === 'fallback' && toolSentNow) {
          segments.skipped += 1;
          this.log('debug', `第 ${label} 段跳过自动发送（本轮 send_qq 已发过）${message.chatId}`, {
            chars: body.length,
          });
          return;
        }
        segments.attempted += 1;
        segments.lastText = body;
        const sent = await this.#send(message.chatId, body, [], `runTurn-step${label}`);
        // 被"同文短窗"拦下 ⇒ 这条没真发出去，不记进 replies（见 `runTurn` 末尾的说明）。
        if (sent !== SEND_SUPPRESSED) {
          segments.sent += 1;
          this.stats.replies += 1;
          this.stats.segments += 1;
          // 判定日志：这一段的正文真发出去了 ⇒ 记下（分段的话最后按 `\n` 拼）。
          if (sentBodies !== null) sentBodies.push(body);
        }
      } catch (error) {
        // ⚠️ **发送失败不许静默**（用户明确要求）：warn + 计数 + 台账。
        //    台账那一行是 `transport-action` 的 `ok:false`（`outbound-ledger.mjs` 记的），
        //    这里**不再补记一行 `gw-send`** —— 那会破坏"gw-send 行数 = #send 调用次数"。
        segments.failed += 1;
        this.stats.failedSegments += 1;
        this.log('warn', `第 ${step ?? '?'} 段发送失败（后续段照常发）${message.chatId}`, {
          step: step ?? null,
          chars: String(text ?? '').length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    let raw;
    try {
      raw = await this.responder({
        sessionKey,
        chatId: message.chatId,
        kind: message.kind,
        prompt: turnPrompt,
        restricted,
        signal: this.signal,
        imageBlocks,
        // 逐段外发的回调（binder 每写出一个 step 调一次）。不认识它的 responder
        // （替身 / 老实现）会直接忽略 —— 那条路退回"轮末整段发一次"。
        onSegment,
      });
    } finally {
      // `turn/end` 就发生在上面那次 await 里，所以这里删掉不会影响本轮判定。
      this.turnsInFlight.delete(sessionKey);
    }

    const toolSentThisTurn = (this.toolSendSeq.get(sessionKey) ?? 0) > toolSendSeqBefore;

    // B3（2026-10-25）：**不在这里截断** —— 截断挪进 `#sendOne`（每段一次）。
    // 理由：切分标记可能落在 `maxReplyChars` 以外，先截断就永远看不到它。
    // 这里保留 `.trim()`：空回复判定与 `noteReplied` 都依赖"只有空白 = 空"。
    const text = String(raw ?? '').trim();
    const sendImages = Array.isArray(images) ? images : [];

    // ===== `[不说话]`：这一轮不发 QQ（2026-11-02）=====
    //
    // 这是**通用标识符**，两种用法共用这一条分支：
    //   ① 没什么想说的 ⇒ 只回 `[不说话]`（本来会被当成正文发出去）；
    //   ② 已经用 `send_qq` 发过 ⇒ 正文写 `[不说话]`，压掉重复的自动发送。
    //
    // 与 B2 的 `skipAutoSend`（`auto_reply=fallback` + 工具发过）**并存，不打架**：
    // 这里先一步短路，`toolSentThisTurn` 照旧用来判"她到底说没说过话"——
    // 记 `noteReplied` 的规则因此不变（说过 ⇒ 记；只说标记 ⇒ 不记成刚说过）。
    // ⚠️ **标记本身绝不发出去**（剥掉也没用：**正文整条不发**。图不在此列，见下面）。
    if (isQuietMark(text)) {
      try {
        this.stats.quietReplies += 1;
        this.lastQuietReply = {
          at: Date.now(),
          chatId: message.chatId,
          sessionKey,
          toolSent: toolSentThisTurn,
          chars: text.length,
          images: sendImages.length,
        };
      } catch {
        /* 计数坏了不影响这一轮 */
      }
      // info 级 + 落快照：这条路径的"正确结果"就是 QQ 上一片安静，
      // 不主动留痕的话它和"回复被丢了"在证据上完全一样。
      this.log('info', `收到 [不说话]，本轮不发 QQ ${message.chatId}`, {
        chars: text.length,
        toolSent: toolSentThisTurn,
        images: sendImages.length,
      });
      if (toolSentThisTurn || segments.attempted > 0) {
        // 她确实说过话（走的是工具那条路，或已经逐段发出去过）⇒ 让判定层知道，
        // 冷却期照生效。不传 `text`：手里只有标记，别把它记成"她最后一条是不是问句"。
        this.engine.noteReplied(message.chatId, this.engine.now(), addressed);
      }
      // ===== 图照发（2026-11-02 用户拍板）=====
      //
      // 用户原话：「**一声不吭发张图我觉得挺合理的**」。
      // 也就是说 `[不说话]` 管的是**正文**，不是"这一轮什么都别发"——
      // 一声不吭甩张纸片人截图，本身就是一种表达，压掉它等于把
      // "我没话讲，但我想给你看这个"一并禁了。
      //
      // ⚠️ 所以这条分支**只负责正文**：图走下面同一条 `#send`（正文传空串，
      // 与 2159 行 `skipAutoSend` 那条路的形状一致 —— 不带字，只带图）。
      if (sendImages.length > 0) {
        await this.#send(message.chatId, '', sendImages, 'runTurn-images')
          .then((sent) => {
            if (sent !== SEND_SUPPRESSED) this.stats.replies += 1;
          });
      }
      return '';
    }

    if (text === '' && sendImages.length === 0) {
      // 逐段外发已经把话送出去了 ⇒ 这一轮**不是**"空回复"（别记进 emptyReplies /
      // lostReplies，那会让诊断看起来像丢了消息）。
      if (segments.attempted > 0) {
        this.engine.noteReplied(message.chatId, this.engine.now(), addressed, segments.lastText);
        this.log('info', `已逐段回复（轮末正文为空）${message.chatId}`, {
          segments: segments.attempted, sent: segments.sent, failed: segments.failed,
        });
        return '';
      }
      // 空回复是合法选择（模型决定不说话），但必须让判定层知道机器人"刚说过话"，
      // 否则冷却期不会生效。
      //
      // ⚠️ **模式 3（`inTurn`）的"弃权"就走这一条**（2026-10-13）：那条路照常进 agent，
      // 但提示词里明说"空回复是合法的、不想说就别硬说"（见 `#buildPrompt` 的
      // `倾向` 段）⇒ 模型返回空 = **它自己决定不说**，在这里被丢掉。
      // 所以这一路不需要新代码：`inTurn` 的裁量**复用这个既有的合法出口**。
      // `judgeMode` 在这里只是留痕（下面日志用得上），不改变任何分支。
      if (judgeMode === 'inTurn') {
        this.log('debug', `inTurn 弃权（模型返回空回复）${message.chatId}`, {});
      }
      //
      // 🔴 2026-10-28（事故驱动）：**"空串"不等于"模型没说话"。**
      //
      // 20:43 私聊那一轮：模型明明回了（会话里有 `assistant/message`，GUI 上也看得见），
      // 但上下文压缩把 surface 缩短了、取回复的主路径按条数下标切空，
      // 而流式兜底因为 payload 形状看错了一层的缘故也一直是空的
      // ⇒ responder 返回 `''` ⇒ 这一分支当"模型决定不说话"处理 ⇒
      // **QQ 上一句话都没到，台账里连 `gw-send` 都没有，日志里一个字都没有。**
      //
      // 现在：问一句 binder"这一轮到底丢没丢"。**判据只影响日志与计数**，
      // 发送决策一个字节都没动（仍然不发 —— 空串就是空串）。
      let diag = null;
      try {
        diag = this.diagnoseEmptyReply === null ? null : this.diagnoseEmptyReply(sessionKey);
      } catch {
        diag = null; // 诊断坏了绝不能影响这一轮
      }
      const suspicious = diag !== null && typeof diag === 'object'
        && (diag.kind === 'lost' || diag.historyShrank === true);
      try {
        this.stats.emptyReplies += 1;
        if (diag !== null && typeof diag === 'object' && diag.historyShrank === true) {
          this.stats.compactedTurns += 1;
        }
      } catch {
        /* 计数坏了不影响这一轮 */
      }
      if (suspicious) {
        try {
          this.stats.lostReplies += 1;
          this.lastEmptyReply = {
            at: Date.now(),
            chatId: message.chatId,
            sessionKey,
            kind: String(diag.kind ?? '?'),
            before: Number(diag.before) || 0,
            after: Number(diag.after) || 0,
            historyShrank: diag.historyShrank === true,
            streamFrames: Number(diag.streamFrames) || 0,
            streamedChars: Number(diag.streamedChars) || 0,
          };
        } catch {
          /* 同上 */
        }
        // ⚠️ warn 级：这条日志的意义就是"默认看得见"。
        this.log('warn', `拿不到回复 —— 这一轮的回复被静默丢弃了 ${message.chatId}`, {
          kind: diag.kind ?? '?',
          before: diag.before ?? null,
          after: diag.after ?? null,
          historyShrank: diag.historyShrank === true,
          streamFrames: diag.streamFrames ?? null,
          streamedChars: diag.streamedChars ?? null,
        });
      }
      //
      // ⚠️ 只有"**连图都没有**"才算空。配了图却因为没有文字就整轮丢掉，
      // 等于把"只发一张表情包"这种合法回复吃掉（见 `#send` 的说明）。
      this.engine.noteReplied(message.chatId, this.engine.now(), addressed);
      return '';
    }

    if (silent) {
      // 静默轮：会话里已经有这条回复了，只是不推到 QQ。
      // **仍然记 noteReplied** —— 否则判定层以为自己没说过话，下一轮会莫名插话。
      //
      // ⚠️ 必须带上 `text`（2026-10-12 补）：判定层用 `looksLikeQuestion(text)` 记
      // 「她最后一条是不是问句」—— focus 的时间票只在问句时给。
      // **不传 `text` 时那个判断保持原值**（"不知道就别动"），于是线上恒为 false ⇒
      // 「她问了话 → 别人答一句 → 她别掉线」这条救命路会【整个关掉】。
      this.engine.noteReplied(message.chatId, this.engine.now(), addressed, text);
      this.log('info', `静默回复 ${message.chatId}（未发 QQ）`, {
        chars: text.length,
        images: sendImages.length,
      });
      return text;
    }

    // ===== B2（2026-10-25）：两条发送路径的优先级 =====
    //
    // 旧行为是**无条件**在这里发一次；如果她这一轮还调了 `send_qq`，QQ 上就多一条。
    // 现在的判据只有一条：**这一轮工具发过没有**（`toolSentThisTurn`）。
    // `auto_reply=always` 时**不看它** —— 那是刻意的回滚开关，保持改动前的行为。
    const skipAutoSend = this.autoReply === 'off'
      || (this.autoReply === 'fallback' && toolSentThisTurn);

    if (skipAutoSend && sendImages.length === 0) {
      // 不发。⚠️ `noteReplied` **照旧**：她确实说过话，只是走的是工具那条路。
      // 不记的话判定层以为她没开口 ⇒ 冷却期失效 ⇒ 下一轮可能立刻再冒一句
      // （同一类坑见上面 `silent` 分支那段注释）。
      this.engine.noteReplied(message.chatId, this.engine.now(), addressed, text);
      this.log('debug', `跳过自动发送（${this.autoReply === 'off' ? 'auto_reply=off' : 'send_qq 已发过'}）${message.chatId}`, {
        chars: text.length,
      });
      return text;
    }

    if (skipAutoSend) {
      // 有正文重复风险、但**这批图是调用方明确要送的**（`deliverFromAlice` 的 `sendImages`）
      // ⇒ 只送图、不带正文：既不丢图，也不把同一段字发两遍。
      await this.#send(message.chatId, '', sendImages, 'runTurn-images')
        .then((sent) => {
          if (sent !== SEND_SUPPRESSED) this.stats.replies += 1;
        });
      this.engine.noteReplied(message.chatId, this.engine.now(), addressed, text);
      this.log('info', `只发图片（正文已由 send_qq 发出）${message.chatId}`, {
        images: sendImages.length,
      });
      return text;
    }

    // ===== 逐段外发已经替这一轮说过话了 ⇒ **不再整体发一次** =====
    //
    // 判据用 `attempted`（"试图发过"）而不是 `sent`：某一段发送失败之后，
    // 整体重发一次会把**已经发成功的前几段**重复甩到 QQ 上。失败那一段靠
    // `warn` + `failedSegments` + 台账的 `ok:false` 留痕，不在这里静默重试。
    if (segments.attempted > 0) {
      // 调用方明确要送的图（`deliverFromAlice` 的 `sendImages`）不能被吞掉：
      // 上面那些段只发了正文，图单独补一条（正文传空串，形状与 `[不说话]` 那条一致）。
      if (sendImages.length > 0) {
        await this.#send(message.chatId, '', sendImages, 'runTurn-images')
          .then((sent) => {
            if (sent !== SEND_SUPPRESSED) this.stats.replies += 1;
          })
          .catch((error) => {
            this.stats.failedSegments += 1;
            this.log('warn', `逐段回复后补发图片失败 ${message.chatId}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      this.engine.noteReplied(message.chatId, this.engine.now(), addressed, segments.lastText);
      this.log('info', `已逐段回复 ${message.chatId}`, {
        segments: segments.attempted,
        sent: segments.sent,
        failed: segments.failed,
        skipped: segments.skipped,
        chars: segments.lastText.length,
      });
      return text;
    }

    // `caller` 是**常量字符串**（台账用）：段数组形状由 `sendImages` 决定，
    // 所以这里分两个 caller —— 判读时"带图那条"与"纯文本那条"一眼能分开
    //（带图的那条 `chars` 只是文本段长度，混进来比长度会失真）。
    //
    // ⚠️ `fallback` 走到这里 = **这一轮没调 `send_qq`** ⇒ 这是那条"兜底"的行，
    //    caller 记 `runTurn-fallback`（一眼能看出它本该由工具发）+ 一条 `warn`。
    //    一条消息仍然只记 **1 行 `gw-send` + 1 行 `transport-action`** —— 不许因为
    //    "走了工具"或"兜底"再多记一行（台账的不变式见 `#recordOutbound` 的注释）。
    const caller = this.autoReply === 'fallback'
      ? 'runTurn-fallback'
      : (sendImages.length > 0 ? 'runTurn-images' : 'runTurn');
    if (this.autoReply === 'fallback') {
      this.log('warn', `本轮没有调 send_qq，走兜底自动发送 ${message.chatId}`, {
        chars: text.length,
        images: sendImages.length,
      });
    }
    await this.#send(message.chatId, text, sendImages, caller)
      .then((sent) => {
        // 被"同文短窗"拦下 ⇒ 这条没真发出去，**不**该记进 replies。
        // `stats.replies` 是"她真说了几条"，虚报会让台账与快照互相矛盾。
        if (sent !== SEND_SUPPRESSED) {
          this.stats.replies += 1;
          // 判定日志：整段一次发出去的那条路径（responder 不支持 `onSegment` 时走这里）。
          if (sentBodies !== null) sentBodies.push(text);
        }
      });
    // 关键：让判定层知道机器人刚说过话，否则它会在自己刚回完话后立刻再冒一句。
    // `addressed` 决定这次回复是否**占用配额**：被点名的不占（那是别人找小鲸鱼）。
    // 时刻取 `engine.now()` 而不是 `Date.now()`：测试里引擎的时钟是可控的。
    // ⚠️ `text` 必传（2026-10-12 补）—— 理由见 `silent` 分支那段注释。
    this.engine.noteReplied(message.chatId, this.engine.now(), addressed, text);
    this.log('info', `已回复 ${message.chatId}`, { chars: text.length, addressed });
    return text;
  }

  /**
   * **主会话 → 小鲸鱼**：内部通道投递（不经过 QQ 入站）。
   *
   * 用户原话：「你俩得有个沟通渠道啊，信箱不提就不会读的，一直借用小鲸鱼的私聊也不是事」。
   *
   * 它不是"某个外部用户发来消息"，所以**不走入站白名单**；会话键、私聊/群聊的区分仍然复用路由的现成逻辑。
   * 直接投进小鲸鱼的会话。
   *
   * - `replyTo` 给了 → 小鲸鱼的回复发到那个 chatId（**走既有白名单**，越界会被拒）
   * - `replyTo` 省略 → **静默**：只写会话，不推 QQ，免得每条技术沟通都吵到用户
   *
   * ## ⚠️ `viewImages` 与 `sendImages` 是**反方向**的两件事
   *
   * | 参数 | 方向 | 干什么 |
   * |---|---|---|
   * | `viewImages` | **进**（喂给模型看） | **数字** = 刚才那批转发里的序号；**字符串** = 图片源本身（本机路径 / URL，2026-10-21 为定时唤醒的整屏截图加的） |
   * | `sendImages` | **出**（发到 QQ） | 让小鲸鱼的回复**附带上这些图**（URL / 路径 / `{sticker:'<md5>'}`） |
   *
   * 两个都是本次链路要的，但**别混**：把 `sendImages` 当 `viewImages` 用会让小鲸鱼
   * 把别人发的图原样发回去；反过来则是"要它发图结果自己看了一遍"。
   *
   * @param {{text: string, replyTo?: string|null, viewImages?: Array<number|string>|null, sendImages?: unknown[]|null, now?: number}} request
   * @returns {Promise<string>} 小鲸鱼这一轮的回复；没说话则空串
   */
  async deliverFromAlice({ text, replyTo = null, viewImages = null, sendImages = null, now = Date.now() }) {
    const body = String(text ?? '').trim();
    if (body === '') return '';

    // 造一条"虚拟入站消息"，然后**走正常路由** —— 这样会话键、白名单、
    // 私聊/群聊的区分全部复用现成逻辑，不另起一套。
    const target = typeof replyTo === 'string' && replyTo.trim() !== '' ? replyTo.trim() : this.ownerChatId;
    if (target === '') {
      this.log('warn', '内部通道没给 replyTo，也没有配置主人（[owner] admins）⇒ 本轮不投递', {});
      return '';
    }
    const { kind, target: targetId } = splitChatId(target);

    // **按序号取图**：把缓存里的图片清单变成真正的 image 段，
    // 后面 `runTurn` 会走**和"用户直接发图"完全同一条**下载/attachment 路径
    // （小鲸鱼明确要求过：别写第二套）。
    const segments = [{ type: 'text', text: body }];
    const requested = Array.isArray(viewImages) ? viewImages : [];
    if (requested.length > 0) {
      const catalog = this.forwardImages.get(target) ?? [];
      for (const want of requested) {
        // ① 数字（或纯数字串）= 刚才那批转发里的序号。
        const isIndex = typeof want === 'number'
          || (typeof want === 'string' && /^\d+$/.test(want.trim()));
        if (!isIndex) {
          // ② 非数字 = **图片源本身**（本机绝对路径 / http(s) 链接）。
          //    2026-10-21：「她自己的时间」唤醒前截的那张整屏图**不在转发缓存里**，
          //    没有序号可取 —— 它是 `captureVirtualDesktop()` 刚写到工作区 tmp 的文件。
          //    段形状与上面的转发图完全一致，所以后面 `toImageBlocks` 走的是**同一条**
          //    附件入库路径（小鲸鱼明确要求过：别写第二套）。
          const src = String(want ?? '').trim();
          if (src !== '') segments.push({ type: 'image', url: src });
          continue;
        }
        const hit = catalog.find((item) => item.index === Number(want));
        if (hit === undefined || hit.url === '') {
          this.log('warn', '取图请求找不到对应图片', { want, available: catalog.length });
          continue;
        }
        segments.push({ type: 'image', url: hit.url, file: hit.file });
      }
      this.log('info', '按序号取图', {
        requested: requested.length,
        matched: segments.length - 1,
      });
    }

    const message = {
      chatId: target,
      kind,
      userId: 'system',
      nickname: '系统',
      text: body,
      at: now,
      // 强制"被点名"：这是我们之间说话，不该再过一遍"要不要回"的判定。
      mentioned: true,
      replyToSelf: false,
      segments,
      raw: body,
    };

    const verdict = this.router.resolve(message);
    // ⚠️ **这里刻意不看 `verdict.action`。**
    //
    // 踩过的坑：我一开始把虚拟消息的 `userId` 设成 `'alice'`，然后照搬入站那套
    // `action !== DISPATCH 就拒绝` —— 结果路由拿 `alice` 去核对白名单，当然不在
    // `allowFrom` 里，于是 `dm-denied(allowlist)`，投递被我自己挡掉了。
    //
    // 想清楚：**这条路不是"外部用户给机器人发消息"，而是系统里另一个会话在跟我说话**，
    // 不该过入站白名单那道门。路由在这里唯一的用处，是告诉我 chatId 对应哪个
    // sessionKey（那个映射只有它知道）。
    //
    // 但**回复出去的 chatId 必须过白名单**（见下面的 replyTo 处理），
    // 否则这条通道就成了"绕过出站白名单发消息"的后门。
    const sessionKey = verdict.sessionKey;
    this.log('info', '内部通道路由结果', {
      target,
      action: verdict.action,
      reason: verdict.reason,
      sessionKey,
    });
    if (typeof sessionKey !== 'string' || sessionKey === '') {
      this.log('warn', '内部通道拿不到会话键', {
        target,
        action: verdict.action,
        reason: verdict.reason,
      });
      return '';
    }

    // 出站目标必须过白名单。不合法就**退化成静默**，绝不把消息发到允许范围之外。
    let effectiveReplyTo = replyTo;
    if (effectiveReplyTo !== null) {
      const allowed = typeof this.router.proactiveAllowed === 'function'
        ? this.router.proactiveAllowed(effectiveReplyTo)
        : false;
      if (allowed !== true) {
        this.log('warn', '内部通道的 replyTo 不在白名单内，改为静默投递', {
          replyTo: effectiveReplyTo,
        });
        effectiveReplyTo = null;
      }
    }

    // 明确标注来源，免得小鲸鱼把我和用户搞混（它俩的对话风格完全不同）。
    // 时间戳 = **这条消息什么时候到的**（收件箱是轮询的，可能躺一会儿才被读到）。
    const prompt = `【主会话 · 内部通道】[${formatStamp(message.at, { now })}]\n${body}`;
    // **静默轮绝不带图**：`replyTo` 被白名单挡掉时 effectiveReplyTo 为 null，
    // 这时候发图等于往 QQ 推东西而没有任何目标 —— 直接把图也丢掉。
    const outgoing = effectiveReplyTo === null ? [] : (Array.isArray(sendImages) ? sendImages : []);
    this.log('info', '内部通道即将投递', {
      sessionKey,
      chars: body.length,
      sendImages: outgoing.length,
    });
    const reply = await this.runTurn({
      message,
      sessionKey,
      restricted: false,
      prompt,
      addressed: true,
      silent: effectiveReplyTo === null,
      images: outgoing,
    });
    this.log('info', '内部通道投递返回', { replyChars: String(reply ?? '').length });
    return reply;
  }

  /**
   * 会话键 → `{chatId, kind, target}`（2026-10-24，P1-4）。
   *
   * 顺序：**映射表反查 → 旧前缀正则**。认不出 ⇒ `null`（各工具会把原因回给模型）。
   * ⚠️ 只读：这里不建映射（建表归 `dispatch` 的 `note`，且只在真的派发时做）。
   *
   * @param {unknown} sessionKey
   * @returns {{chatId: string, kind: 'group'|'private', target: string} | null}
   */
  chatOf(sessionKey) {
    const resolver = this.sessionResolver;
    const chatId = typeof resolver?.chatIdOf === 'function'
      ? resolver.chatIdOf(sessionKey)
      : chatIdFromSessionKey(sessionKey);
    if (typeof chatId !== 'string' || chatId === '') return null;
    const parsed = parseChatId(chatId);
    if (parsed === null) return null;
    return { chatId, kind: parsed.kind, target: parsed.id };
  }

  /**
   * 这个会话**此刻**是不是正被插件自己驱动（`runTurn` 还没返回）。
   *
   * 自动搬运（`dsh/auto-relay.mjs`）用它给 `runTurn` 让路 —— 见 `turnsInFlight` 的说明。
   *
   * @param {unknown} sessionKey
   * @returns {boolean}
   */
  isTurnInFlight(sessionKey) {
    try {
      return this.turnsInFlight.has(String(sessionKey ?? ''));
    } catch {
      return false;
    }
  }

  /**
   * **把某一轮说的话搬到它对应的 QQ**（2026-11-02，自动搬运的唯一出口）。
   *
   * 为什么需要一个共用出口：宿主**自己**跑的轮次（子会话交活 / 后台作业结束 /
   * `schedule` 到点 / banner 恢复）根本没人取回复 ⇒ 以前她说的话只写进会话，
   * QQ 上一个字都不到。现在统一走这里，把"目标 / 白名单 / 台账 / 频率"全部复用一遍，
   * 不另写一套发送。
   *
   * 与 `speakProactively` 的区别只有两点：① 入参是**会话键**（自动搬运手上只有它）；
   * ② 台账 `caller` 记 `auto-relay`（判读时一眼能分开"这是补发的"还是"她在聊天里回的"）。
   * 出站白名单照判 —— 认不出会话 / 不在名单 / 正文空 / 被同文短窗拦下 ⇒ 返回 `false`，绝不静默假成功。
   *
   * @param {unknown} sessionKey
   * @param {unknown} text
   * @returns {Promise<boolean>} 真的发出去了才 `true`
   */
  async sendTurnReply(sessionKey, text) {
    if (this.stopped) return false;
    const chat = this.chatOf(sessionKey);
    if (chat === null) {
      this.log('warn', `自动搬运：认不出会话键 ${String(sessionKey ?? '')}，没发`, {});
      return false;
    }
    if (!this.router.proactiveAllowed(chat.chatId)) {
      this.log('warn', `自动搬运：${chat.chatId} 不在出站白名单，没发`, {});
      return false;
    }
    const body = String(text ?? '').trim();
    if (body === '') return false;
    try {
      const sent = await this.#send(chat.chatId, body, [], 'auto-relay');
      // 被"同文短窗"拦下 ⇒ 这一条没真发出去（多半是搬的正文和刚发过的重复），不记 replies。
      if (sent === SEND_SUPPRESSED) return false;
      this.stats.replies += 1;
      // 判定层要知道"她刚说过话"—— 否则冷却期不生效，下一轮可能立刻再冒一句。
      this.engine.noteReplied(chat.chatId, this.engine.now());
      this.log('info', `自动搬运本轮输出 ${chat.chatId}`, { chars: body.length });
      return true;
    } catch (error) {
      this.log('warn', `自动搬运发到 ${chat.chatId} 失败`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * **她自己决定往 QQ 发东西**（2026-10-18，`send_qq` 工具，第一档：只文字）。
   *
   * 设计要点（用户 2026-10-18 拍板）：
   *   - **参数里没有 chatId**：只发【当前会话】。越界从设计上不可能。
   *   - 白名单照判（`outboundAllow` 就是出站白名单）。
   *   - 条数 / 总字符 / 频率都在这里硬卡，不信任调用方。
   *   - 每条都走 `#send` ⇒ 台账、同文去重、markdown 剥除一样不落。
   *   - **文件档还没做**：`kind` 不是 `text` 的一律拒（OneBot 的 upload_* 未验证）。
   *
   * @param {{sessionKey: string, items: Array<{kind?: string, text?: string}>}} input
   * @returns {Promise<{ok: boolean, sent: number, note: string}>} 永不 reject
   */
  async sendFromTool({ sessionKey, items, now = Date.now() }) {
    const MAX_ITEMS = 3;
    const MAX_TOTAL = 6000;
    const MIN_GAP_MS = 5_000;

    const chat = this.chatOf(sessionKey);
    if (chat === null) return { ok: false, sent: 0, note: `认不出这个会话键（${sessionKey}），没发。` };
    const { kind, target } = chat;
    if (!this.outboundAllow(kind, target)) {
      return { ok: false, sent: 0, note: '这个会话不在出站白名单里，没发。' };
    }
    const chatId = chat.chatId;

    if (!Array.isArray(items)) return { ok: false, sent: 0, note: 'items 必须是数组（要发哪几条？）。' };
    const list = items;
    if (list.length === 0) return { ok: false, sent: 0, note: 'items 是空的，没发。' };
    if (list.length > MAX_ITEMS) {
      return { ok: false, sent: 0, note: `一次最多 ${MAX_ITEMS} 条，你给了 ${list.length} 条 —— 没发（自己合并一下再来）。` };
    }

    // 2026-10-19：`items` 现在有两种——文字（`text`）和**表情包**（`sticker`）。
    //
    // 「挑」这件事当初刻意没做（见 `sticker-library.mjs` 开头：属于产品决定，骰子还是视觉）。
    // 用户 2026-10-19 选的**骰子**：按审核打好的 `tags` 随机挑一张 —— 库里的
    // `findByTags({tags})` 本来就是为这一步留的接口，这里只是把它用起来。
    //
    // `{kind:'sticker', tag?}` ⇒ 按标签随机（不传 tag = 全库随机）；`{kind:'sticker', md5}` ⇒ 指定那张。
    const out = [];
    for (const item of list) {
      if (item === null || typeof item !== 'object') return { ok: false, sent: 0, note: 'items 里有坏元素，没发。' };
      const kind = item.kind === undefined ? 'text' : item.kind;

      if (kind === 'text') {
        const t = String(item.text ?? '').trim();
        if (t === '') return { ok: false, sent: 0, note: '有一条是空的，没发（整批都不发，避免半截）。' };
        out.push({ kind: 'text', text: t });
        continue;
      }

      if (kind === 'sticker') {
        if (this.stickerLibrary === null) {
          return { ok: false, sent: 0, note: '表情包库没接上（这次没开），没发。' };
        }
        const wanted = String(item.md5 ?? '').trim();
        if (wanted !== '') {
          if (this.stickerLibrary.pathOf(wanted) === null) {
            return { ok: false, sent: 0, note: `库里没有这张表情包（${wanted}），没发。` };
          }
          out.push({ kind: 'sticker', md5: wanted });
          continue;
        }
        // 2026-10-19：**骰子挑一张**，交给库里的 `pick`（反比加权 + 描述贴合 + 加权随机）。
        // 她给的情绪走 `mood`，类别走 `tags`（1~2 个）；只给 `tag` 也认。
        const oneTag = String(item.tag ?? '').trim();
        const tagList = Array.isArray(item.tags)
          ? item.tags.map((t) => String(t).trim()).filter((t) => t !== '')
          : (oneTag === '' ? [] : [oneTag]);
        const picked = this.stickerLibrary.pick({ tags: tagList, mood: String(item.mood ?? '').trim() });
        if (picked === null) {
          return {
            ok: false,
            sent: 0,
            note: tagList.length === 0 ? '表情包库是空的，没发。' : `库里没有「${tagList.join('/')}」这类表情包，没发。`,
          };
        }
        out.push({ kind: 'sticker', md5: picked.md5 });
        continue;
      }

      // 2026-10-26：`image` —— 发**任意一张图**（表情包是"库里随机/指定"，这是"我就要这张"）。
      // 全部校源工作交给 `#checkImageSource`（白名单 / 协议 / 存在 / 可读 / 大小 / 扩展名），
      // 这里只把结果塞进 `out`，真正的发送仍走网关**已有**的 `#send(..., images)` 链路。
      if (kind === 'image') {
        const checked = this.#checkImageSource(item.path);
        if (checked.ok !== true) return { ok: false, sent: 0, note: checked.error };
        const caption = String(item.caption ?? '').trim();
        out.push({ kind: 'image', image: checked.image, caption, bytes: checked.bytes });
        continue;
      }

      // ⚠️ 文件（kind=file）还没做：OneBot 的 upload_* 没验证过，别假装支持。
      return { ok: false, sent: 0, note: `只支持 text / sticker / image（收到 kind=${kind}）；文件发送还没做，没发。` };
    }

    const texts = out.filter((x) => x.kind === 'text').map((x) => x.text);
    // 图注也算字（一次 3 条、合计 6000 字那条闸对图也一样有效）。
    const captions = out.filter((x) => x.kind === 'image').map((x) => x.caption).filter((c) => c !== '');

    const total = [...texts, ...captions].reduce((n, t) => n + t.length, 0);
    if (total > MAX_TOTAL) {
      return { ok: false, sent: 0, note: `总共 ${total} 字，超过上限 ${MAX_TOTAL} —— 没发（先给摘要；发文件那条还没做）。` };
    }

    // 同一批里出现**完全一样**的句子 ⇒ 后一条会被 10 秒同文闸吞掉，
    // 结果变成 ok:true 但少发一条（静默少发是 bug 形状，用户看不出少了哪条）。
    // ⇒ 宁可整批拒，让她自己改。
    const seenText = new Set();
    for (const t of texts) {
      if (seenText.has(t)) {
        return { ok: false, sent: 0, note: '同一批里有两条一模一样的话，没发（后一条会被去重吞掉，别这样写）。' };
      }
      seenText.add(t);
    }

    // 频率闸：同会话 5 秒内不许再来一次（防刷屏；原为 30 秒，按要求缩短）。
    const nowMs = Number.isFinite(now) ? now : Date.now();
    const last = this.sendToolLastAt.get(chatId) ?? 0;
    if (nowMs - last < MIN_GAP_MS) {
      const wait = Math.ceil((MIN_GAP_MS - (nowMs - last)) / 1000);
      return { ok: false, sent: 0, note: `刚发过，${wait} 秒后才能再发。` };
    }
    this.sendToolLastAt.set(chatId, nowMs);

    // 逐条发。⚠️ `#send` 的返回值不是布尔：被同文闸拦下时返回 `SEND_SUPPRESSED`。
    let sent = 0;
    let sentImages = 0;
    try {
      for (const [i, item] of out.entries()) {
        const isText = item.kind === 'text';
        const isSticker = item.kind === 'sticker';
        const isImage = item.kind === 'image';
        // 三种 item 都收敛到同一条发送链路：
        //   文字  ⇒ text + 无图
        //   表情包 ⇒ 空正文 + `{sticker: md5}`（由 `#resolveImages` 换成路径）
        //   图片   ⇒ caption 当正文 + 图片源（本地路径 / URL）
        const images = isSticker
          ? [{ sticker: item.md5 }]
          : (isImage ? [item.image] : []);
        const body = isText ? item.text : (isImage ? item.caption : '');
        // 台账 `caller` 区分来源（判读时一眼看出"这是她发的图"），`meta.kind` 记 image。
        const caller = isImage ? 'send_qq-image' : 'send_qq';
        const outcome = await this.#send(chatId, body, images, caller, isImage ? 'image' : 'text');
        if (outcome === SEND_SUPPRESSED) {
          this.log('info', 'send_qq 有一条被同文闸拦下', { chatId, index: i + 1 });
          continue;
        }
        sent += 1;
        if (isImage) sentImages += 1;
        // B2（2026-10-25）：**真发出去一条【文字】**就加一次流水号 —— `runTurn` 拿它判
        // "这一轮工具发过没有"，从而不再重复自动发送。
        //
        // ## 2026-10-26 口径扩展（发图进来之后）
        //
        // | 这一条是什么 | 算不算"文字名额"（`toolSendSeq`） | 为什么 |
        // |---|---|---|
        // | `kind=text` | **算** | 老行为 |
        // | `kind=sticker`（无正文） | **不算** | 她常"甩张表情包垫一下、正文还是本轮回复"，算了就把正文吞掉 |
        // | `kind=image` **带 caption** | **算一次** | 图注就是她说的话；不算的话自动回复会再发一条意思差不多的，等于重复 |
        // | `kind=image` **不带 caption** | **不算** | 纯图 = 表情包那种"垫一下"，正文照常自动发 |
        //
        // 同文闸拦下的那条**一律不数**（它什么都没到 QQ，不该让兜底闭嘴）。
        const countsAsText = isText || (isImage && item.caption !== '');
        if (countsAsText) {
          this.toolSendSeq.set(sessionKey, (this.toolSendSeq.get(sessionKey) ?? 0) + 1);
        }
      }
    } catch (error) {
      this.log('warn', `send_qq 发送失败 ${chatId}`, {
        sent,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, sent, note: `发到第 ${sent + 1} 条时出错了；前面已经发出去 ${sent} 条。` };
    }

    const stickerCount = out.filter((x) => x.kind === 'sticker').length;
    // 说人话：发了几条、几图几表情包。空口报"发了 N 条"会让她以为图也进去了。
    const parts = [];
    if (stickerCount > 0) parts.push(`${stickerCount} 张表情包`);
    if (sentImages > 0) parts.push(`${sentImages} 张图`);
    return {
      ok: true,
      sent,
      note: parts.length === 0
        ? `发了 ${sent} 条。`
        : `发了 ${sent} 条（其中 ${parts.join('、')}）。`,
    };
  }

  /**
   * **她自己发一条语音**（2026-10-26，`send_voice` 工具）。
   *
   * ## 为什么是**独立工具**，而不是给 `send_qq` 加 `kind:'voice'`
   *
   * `send_qq` 上那套闸（一次 1~3 条、总 6000 字、同文短窗、剥 Markdown、`toolSendSeq`
   * 只数文字）对语音要么没意义、要么会互相干扰；硬塞进去会把"一行 = 一次决定要发"
   * 的台账口径搅乱。所以这里单开一条路，**共用**的只有：白名单、台账、传输层。
   *
   * ## 白名单 / 群聊 / 频率三道闸（都在这里，不信任调用方）
   *
   * 1. **出站白名单**（`outboundAllow`）：和 `send_qq` 同一个判定器 —— 语音比文字更"吵"，
   *    越界代价更大。
   * 2. **群里默认不许**（`[tts] allow_groups = false`）：语音条在群里太显眼。
   * 3. **每会话 `[tts] min_gap_ms`**（默认 5 s）：防连发。
   *
   * ## 和"自动发送"的关系：**不顶掉文字**
   *
   * 这个函数**绝不**碰 `toolSendSeq`（那个只由 `send_qq` 的**文字**条数递增）。
   * ⇒ 她发了一条语音，本轮的文本回复**照常自动发**。理由：对方可能听不了
   * （静音、在开会、ASR 失败），文字是保底。要改成"发了语音就不发文字"是**产品决定**，
   * 得用户拍板，不该由这里偷偷决定。
   *
   * ## 返回形状：**五个字段永不缺**
   *
   * ⚠️ 2026-10-26 线上撞过一个真 bug：工具那层的 `output.schema` 声明了
   * `additionalProperties:false` 而这里成功时多返回了 `ms`/`chars`
   * ⇒ DSH 判「returned invalid output」（**语音其实已经发出去了**，用户也听到了）。
   * ⇒ 照 `lookFromTool` 的 `out()` 那条老规矩办：**每次返回都带齐 `{ok,sent,note,ms,chars}`**，
   *    被拒/失败时 `ms`/`chars` 填 0。这样"声明"和"返回"只有一处可能漂移，且能写测试钉住。
   *
   * @param {{sessionKey: string, text: unknown, to?: unknown, voice?: unknown, rate?: unknown, now?: number}} input
   * @returns {Promise<{ok: boolean, sent: number, note: string, ms: number, chars: number}>} **永不 reject**
   */
  async sendVoiceFromTool({ sessionKey, text, to, voice, rate, now = Date.now() } = {}) {
    /** 拒/失败的统一出口（**形状永不缺字段**，同 `lookFromTool` 的 `out()`）。 */
    const refuse = (note) => ({ ok: false, sent: 0, note, ms: 0, chars: 0 });

    const tts = this.tts;
    if (tts === null || tts.enabled !== true) {
      // `notReadyReason` 是合成器自己给的（"enabled 是关的" / "python 不存在" / …），
      // 直接转给她 —— 让她知道"不是我说错了，是这个功能没开"。
      const described = typeof tts?.describe === 'function' ? tts.describe() : null;
      const why = String(described?.notReadyReason ?? '').trim();
      return refuse(`语音功能没开${why === '' ? '' : `（${why}）`}，没发。`);
    }

    // ---- 发到哪：默认当前会话；给了 `to` 才换目标，但**照样过白名单** ----
    let chat = this.chatOf(sessionKey);
    const wanted = String(to ?? '').trim();
    if (wanted !== '') {
      // 认三种写法：`group:100` / `private:2001`、`qq-group-100` / `qq-private-2001`
      // （会话键的老形状）、以及 `group-100`（少了冒号的顺手写法）。
      const normalized = wanted
        .replace(/^qq-/, '')
        .replace(/^(group|private)-/, '$1:');
      const parsed = parseChatId(normalized);
      if (parsed === null) {
        return refuse(`认不出 to="${wanted}"（要 \`group:<群号>\` 或 \`private:<QQ>\`），没发。`);
      }
      chat = { chatId: `${parsed.kind}:${parsed.id}`, kind: parsed.kind, target: parsed.id };
    }
    if (chat === null) return refuse(`认不出这个会话键（${sessionKey}），没发。`);
    const { kind, target } = chat;
    const chatId = chat.chatId;

    if (!this.outboundAllow(kind, target)) {
      return refuse('这个会话不在出站白名单里，没发。');
    }
    if (kind === 'group' && this.tts?.allowGroups !== true) {
      // 群聊默认关：语音条在群里极其显眼，刷屏观感比文字差得多。
      return refuse('群里默认不让发语音（太显眼）。要发就把文字发出去吧。');
    }

    const body = String(text ?? '').trim();
    if (body === '') return refuse('要念的话是空的，没发。');

    const nowMs = Number.isFinite(now) ? now : Date.now();
    const gap = Number.isFinite(Number(this.tts?.minGapMs)) && Number(this.tts.minGapMs) >= 0
      ? Number(this.tts.minGapMs)
      : 5_000;
    const last = this.voiceToolLastAt.get(chatId) ?? 0;
    if (nowMs - last < gap) {
      const wait = Math.ceil((gap - (nowMs - last)) / 1000);
      return refuse(`刚发过语音，${wait} 秒后才能再发。`);
    }

    // ---- 合成（可能截断；失败**说清原因**，绝不静默丢）----
    let made;
    try {
      made = await tts.synthesize({ text: body, voice, rate });
    } catch (error) {
      // 合成器自己承诺永不抛；这里是第二层保险（注入进来的可能是别人写的实现）。
      return refuse(`语音合成出错了：${error instanceof Error ? error.message : String(error)}`);
    }
    if (made === null || typeof made !== 'object' || made.ok !== true) {
      const why = String(made?.error ?? '合成失败（没给原因）');
      return refuse(`语音没合成出来：${why}。这条可以改发文字。`);
    }

    const spoken = made.chars > 0 && made.truncated !== undefined
      ? `（太长，从 ${made.truncated.from} 字截到 ${made.truncated.to} 字）`
      : (made.truncated !== undefined ? `（太长，截到 ${made.truncated.to} 字）` : '');

    try {
      await this.#sendVoice(chatId, String(made.path ?? ''), body, 'send_voice');
    } catch (error) {
      this.log('warn', `send_voice 发送失败 ${chatId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      // ⚠️ `ms`/`chars` 在这里**照样填**（合成确实花掉了时间和字数），只是 `ok:false`。
      return {
        ok: false,
        sent: 0,
        note: `语音合成好了，但发到 QQ 时失败：${error instanceof Error ? error.message : String(error)}。可以改发文字。`,
        ms: Number.isFinite(made.ms) ? made.ms : 0,
        chars: Number.isFinite(made.chars) ? made.chars : 0,
      };
    }
    // 只在**真的发出去**之后才记频率（失败不该让她再等 5 秒）。
    this.voiceToolLastAt.set(chatId, nowMs);
    this.stats.voices = (this.stats.voices ?? 0) + 1;
    return {
      ok: true,
      sent: 1,
      ms: made.ms,
      chars: made.chars,
      note: `发了一条语音${spoken}。`,
    };
  }

  /**
   * 真正发一条语音（`send_voice` 的唯一出口）。
   *
   * ⚠️ **单独记一行 `gw-send`**（不让它走 `#send`）：那条路有切分 / 剥 Markdown /
   * 同文短窗，全都不适用于语音；而"一行 = 一次决定要发"这条不变式**必须保住**。
   * `text` 传的是**念出来的那句原话**（台账按它算 chars/sha256）——
   * 这样"她说了什么"在台账里依然可查，而且**不需要**把音频字节塞进台账。
   *
   * @param {string} chatId
   * @param {string} filePath 本地 mp3（NapCat 会自己转 silk）
   * @param {string} spokenText 念出来的文字（台账用）
   * @param {string} [caller]
   * @returns {Promise<any>}
   */
  async #sendVoice(chatId, filePath, spokenText, caller = 'send_voice') {
    const segment = voiceSegment(filePath);
    if (segment === null) throw new Error('语音文件路径是空的');
    this.#recordOutbound(LAYER_GW_SEND, {
      chatId,
      caller,
      text: String(spokenText ?? ''),
      at: new Date().toISOString(),
      ok: true,
      images: 0,
      kind: 'voice',
    });
    return this.transport.sendToChat(chatId, [segment]);
  }

  /**
   * **发之前亲眼看一眼这张表情包**（2026-10-19，`look_sticker` 工具）。
   *
   * ## 为什么要有它
   * 挑表情包时她手上只有 `desc` / `tags`。2026-10-19 的实测是：「troll 脸」
   * 被当成「开心满足」发出去了 —— 因为那张图的 `desc` 写得含糊（或压根没有），
   * 而标签只覆盖了情绪类别。给她一条**真的看一眼**的路，就能在发之前发现不对。
   *
   * ## 成本口径（用户拍板：别每张都看）
   * 1. **条目自带非空 `desc` ⇒ 直接返回**（`fromCache:true`），一次模型都不调；
   * 2. 没有 `desc` ⇒ 读文件字节，交给**已有的**识图链路
   *    （`imageDescriber.describeDetailed`，和转发图/审核共用同一个实例与缓存），
   *    成功后把描述**写回库**（`stickerLibrary.set`）—— 所以 41 张缺描述的
   *    会是「用一次补一条」，越用越少；
   * 3. 同一个会话 **10 秒内最多现看一次**（`lookToolLastAt`）。超了返回 `ok:false`
   *    并报出还剩几秒 —— **别让她以为"识别失败"去重试**。
   *
   * ## 边界
   * - **不发消息**：所以**不需要** `outboundAllow`（出站白名单管的是出去的东西）。
   *   但 `sessionKey` 认不出（不是 `qq-private-…` / `qq-group-…`）一样要 `ok:false`
   *   —— 频率闸是按会话算的，认不出就没法记。
   * - **永不 reject**：调用方是工具层，抛出去会变成一轮里的工具错误。
   *   任何一步（文件读不出、格式认不出、没有视觉服务、识图抛错）都降级成 `ok:false` + `note`。
   *
   * @param {{sessionKey: string, md5?: string, tag?: string, tags?: string[], mood?: string, now?: number}} input
   *   `md5` 给了就用它；否则用 `pick({tags, mood})` 挑一张（`tag` 是单个标签的老写法）。
   * @returns {Promise<{ok: boolean, md5: string, desc: string, tags: string[], fromCache: boolean, note: string}>}
   */
  async lookFromTool({ sessionKey, md5, tag, tags, mood, now = Date.now() } = {}) {
    const LOOK_MIN_GAP_MS = 10_000;
    /** 六个字段**永不缺**：工具层的 `output.schema` 是按这个形状声明的。 */
    const out = (ok, note, extra = {}) => ({
      ok,
      md5: '',
      desc: '',
      tags: [],
      fromCache: false,
      note,
      ...extra,
    });
    const detailOf = (error) => (error instanceof Error ? error.message : String(error));

    try {
      const chat = this.chatOf(sessionKey);
      if (chat === null) return out(false, `认不出这个会话键（${sessionKey}），没看。`);
      const chatKey = String(sessionKey).trim();
      if (this.stickerLibrary === null) return out(false, '表情包库没接上（这次没开），没看。');

      // ── ① 选中哪一张 ──
      const wanted = String(md5 ?? '').trim().toLowerCase();
      let entry = null;
      if (wanted !== '') {
        entry = this.stickerLibrary.get(wanted);
        if (entry === null) {
          return out(false, `库里没有这张表情包（${wanted}）—— 要么 md5 记错了，要么它被淘汰了；没看。`);
        }
      } else {
        const oneTag = String(tag ?? '').trim();
        const tagList = Array.isArray(tags)
          ? tags.map((t) => String(t).trim()).filter((t) => t !== '')
          : (oneTag === '' ? [] : [oneTag]);
        entry = this.stickerLibrary.pick({ tags: tagList, mood: String(mood ?? '').trim() });
        if (entry === null) {
          return out(false, tagList.length === 0
            ? '表情包库是空的，没得看。'
            : `库里没有「${tagList.join('/')}」这类表情包，没得看。`);
        }
      }

      const key = String(entry?.md5 ?? wanted).trim().toLowerCase();
      const entryTags = Array.isArray(entry?.tags) ? [...entry.tags] : [];

      // ── ② 有描述 ⇒ 零成本直接答（这就是"别每张都看"那条）──
      const known = String(entry?.desc ?? '').trim();
      if (known !== '') {
        return out(true, `不用现看，库里已经有这张的描述：${known}`, {
          md5: key,
          desc: known,
          tags: entryTags,
          fromCache: true,
        });
      }

      // ── ③ 从这里往下一定会打一次视觉调用 ⇒ 先过频率闸 ──
      const nowMs = Number.isFinite(now) ? now : Date.now();
      const last = this.lookToolLastAt.get(chatKey) ?? 0;
      if (nowMs - last < LOOK_MIN_GAP_MS) {
        const wait = Math.ceil((LOOK_MIN_GAP_MS - (nowMs - last)) / 1000);
        return out(false, `刚看过一张，${wait} 秒后才能再看（识图有成本，不是失败）。`, {
          md5: key,
          tags: entryTags,
        });
      }

      // ── ④ 读盘 ──
      const full = this.stickerLibrary.pathOf(key);
      if (full === null) {
        return out(false, '这张表情包的文件不在盘上了（被删/搬家了），没看成。', {
          md5: key,
          tags: entryTags,
        });
      }
      let bytes = null;
      try {
        bytes = fs.readFileSync(full);
      } catch (error) {
        this.log('warn', '看表情包：文件读不出来', { md5: key, error: detailOf(error) });
        return out(false, `读不到这张表情包的文件（${detailOf(error)}），没看成。`, {
          md5: key,
          tags: entryTags,
        });
      }
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        return out(false, '这张表情包是空文件，没看成。', { md5: key, tags: entryTags });
      }
      const mediaType = sniffImageMediaType(bytes) ?? '';
      if (mediaType === '') {
        return out(false, '这张表情包的文件认不出图片格式（不是能看的图），没看成。', {
          md5: key,
          tags: entryTags,
        });
      }

      // ── ⑤ 交给现成的识图链路 ──
      //
      // ⚠️ 复用 `index.mjs` 已有的那个 `imageDescriber` 实例（不新建 provider）：
      //    缓存、显存门控、超时、多帧拼图都在它里面，重写一套只会多一份漂移。
      if (this.imageDescriber === null
        || typeof this.imageDescriber.describeDetailed !== 'function'
        || (typeof this.imageDescriber.canUseVision === 'function'
          && this.imageDescriber.canUseVision() !== true)) {
        return out(false, '现在没有可用的识图服务（没有视觉模型），看不了这张 —— 只能按库里的标签和描述判断。', {
          md5: key,
          tags: entryTags,
        });
      }

      // 闸过了、马上要真调 ⇒ **现在**记时间。失败了也记：否则"失败了可无限重试"
      // 会让一次坏请求在 10 秒里被反复打出去（成本翻倍，还更容易撞限流）。
      this.lookToolLastAt.set(chatKey, nowMs);

      let text = '';
      try {
        const got = await this.imageDescriber.describeDetailed(
          // 字节已经在手上（不走"按 URL 下载/找本地原件"那条，也不看 `summary`）。
          { data: bytes, mediaType, name: String(entry?.file ?? '') },
          // 表情包的描述口径和审核那一步一致：**20 字上下**（`STICKER_DESC_CHARS`）。
          { maxChars: STICKER_DESC_CHARS },
        );
        text = String(got?.text ?? '').trim();
      } catch (error) {
        this.log('warn', '看表情包：识图调用抛错（按没看成处理）', { md5: key, error: detailOf(error) });
        return out(false, `识图出错了（${detailOf(error)}），没看成。`, { md5: key, tags: entryTags });
      }
      if (text === '') {
        return out(false, '识图这次没给出描述（模型没看成），没看成；下次再试。', {
          md5: key,
          tags: entryTags,
        });
      }

      // ── ⑥ 把描述写回库：用一次补一条，下次直接 hit ② ──
      let saved = false;
      try {
        saved = typeof this.stickerLibrary.set === 'function'
          && this.stickerLibrary.set(key, { ...entry, desc: text }) === true;
      } catch (error) {
        this.log('warn', '看表情包：描述写回库失败', { md5: key, error: detailOf(error) });
      }
      if (!saved) this.log('warn', '看表情包：描述没写进库（下次还得现看）', { md5: key });

      return out(true, saved ? `现看了一眼：${text}` : `现看了一眼：${text}（描述没写进库，下次还得现看）`, {
        md5: key,
        desc: text,
        tags: entryTags,
      });
    } catch (error) {
      // 最后一道：工具层**绝不能**看到 reject（它会把异常变成一轮里的工具错误）。
      this.log('warn', '看表情包失败（按没看成处理）', { error: detailOf(error) });
      return out(false, `看这张时出了意外（${detailOf(error)}），没看成。`);
    }
  }

  /**
   * **唯一的出站发送口** —— 所有往 QQ 发消息的地方都走这里。
   *
   * ## 为什么要有这个口子（`[7-2]`）
   *
   * 传输层早就支持段数组（`transport.mjs` 的 `sendToChat(chatId, message)`，
   * `message` 可以是字符串或段数组），但**调用方全部只传字符串** ——
   * 于是小鲸鱼**一张图都发不出去**：能力在下面，没人用。
   *
   * 现在把 6 个发送点全部收敛到这一个方法上。它的形状是：
   *
   * ```
   * images 为空  → 直接把那个**字符串**交给传输层（与改动前逐字节相同）
   * images 非空  → [{type:'text',text}, {type:'image',data:{…}}, …]
   * ```
   *
   * **"空数组就退化成字符串"这条是刻意的**，不是图省事：文本回复有 4 条路
   * （正常回复 / 兜底发送 / 只发图），它们的线上载荷
   * 和测试断言都盯着"字符串"这个形状。要"统一成段数组"必须**先真机验过**
   * 段数组这条链路（本项目的入站压平形状与出站规范形状**不是一回事**，
   * 见 `protocol.mjs` 的 `imageSegment`）。
   *
   * ## 正文在这里剥 Markdown（`[7-3]`）
   *
   * QQ **不渲染** Markdown，模型却默认按 Markdown 写，于是 `**粗体**`、`# 标题`、
   * 表格竖线在手机上原样显示、像乱码。剥的动作**只在这一个方法里做**：
   * 6 个发送点全部收敛到 `#send`，所以一处剥、处处生效（见 `plain-text.mjs`）。
   *
   * 选这里而不是各调用点的理由：放在 `runTurn` / `speakProactively`
   * 里就是**三份会各自漂移的实现**；放在传输层或 `outboundMessage` 里则会让
   * 协议层沾上"QQ 怎么显示"的业务判断（而且 `outboundMessage` 有自己的一组测试）。
   *
   * ⚠️ **图片不受影响**：图片走 `images` → `#resolveImages` 那条独立的路，
   * 只有 `text` 进剥离函数 —— 图片段一个字节都不会被碰。
   *
   * @param {string} chatId
   * @param {string} text
   * @param {unknown[]} [images] 图片源（URL / 本地路径 / `{sticker:'<md5>'}`）
   * @param {string} [caller] **谁调的**（常量字符串，进台账的 `caller` 字段）
   * @returns {Promise<any>}
   */
  async #send(chatId, text, images = [], caller = 'send', kind = 'text') {
    // ===== B3（2026-10-25）：按**独立一行**的标记把一段回复切成几条发 =====
    //
    // 为什么切点必须在这里（`#sendOne` 之前、`stripMarkdown` 之前）：
    // `plain-text.mjs` 的 ⑧ 会把 `---` / `***` / `___` **整行删掉**（那是水平线规则），
    // 先剥再切 = 标记先没了、永远切不着。
    //
    // ⚠️ `send_qq` **不切**：那个工具已经能一次发 1~3 条，再让它按标记切
    //    （3 条 × 4 段 = 12 条）就把 `MAX_ITEMS` 那道防刷屏的闸架空了。
    //    它自己就是"我想分几条说"的表达方式。
    // ⚠️ 2026-10-26：`kind` 只是**台账口径**（`text` / `image`），不影响切分/剥 Markdown。
    if (caller === 'send_qq' || caller === 'send_qq-image') {
      return this.#sendOne(chatId, text, images, caller, kind);
    }

    const parts = this.#splitReply(text);
    if (parts.length === 0) {
      // 整条回复只有标记（没有内容）⇒ 什么都不发。
      // 返回 `SEND_SUPPRESSED` 是**口径借位**：调用方用它判断"这条没真发出去"
      // （`speakProactively` 会因此返回 false、`runTurn` 不记 `stats.replies`）。
      // 语义上它不是"同文窗拦下"，但对调用方来说结论完全一样。
      this.log('warn', `切分后没有内容，什么都不发 ${chatId}`, { caller });
      return SEND_SUPPRESSED;
    }
    if (parts.length === 1) {
      // 没切（无标记时 `parts[0]` **就是原文**，逐字节不变）；或相邻重复合并成了一段。
      return this.#sendOne(chatId, parts[0], images, caller, kind);
    }

    // 台账：**每段一行 `gw-send`**（"一行 = 一次决定要发"这条不变式继续成立），
    // caller 带 `-part<n>` —— 判读时一眼能看出"这是一条回复切出来的"，
    // 而不是"插件真的发了 N 次"。图片只挂在**最后**一段上（别重复发同一张）。
    let last = SEND_SUPPRESSED;
    for (const [i, part] of parts.entries()) {
      // 段间留一口气：连发会丢段，末尾的先没（见 `splitGapMs` 注释）。
      if (i > 0 && this.splitGapMs > 0) await new Promise((r) => setTimeout(r, this.splitGapMs));
      const isLast = i === parts.length - 1;
      const outcome = await this.#sendOne(chatId, part, isLast ? images : [], `${caller}-part${i + 1}`, kind);
      if (outcome !== SEND_SUPPRESSED) last = outcome;
    }
    return last;
  }

  /**
   * 把一段回复按**标记**切成若干段（B3，2026-10-25；2026-11-02 起行内标记也算切点）。
   *
   * 规则（都很窄，宁可少切不要乱切）：
   * - 标记**独占一行**是切点；**跟在文字同一行**也是切点 —— 标记本身不进正文，
   *   标记**之前**的文字留在当前段，标记**之后**的文字成为下一段的开头；
   * - 一行里有多个标记就切多次；切出来的空段（纯空白）丢掉；
   * - **代码块里不切**（围栏里的 `⟨cut⟩` 是内容，不是切点）；
   * - 超过 `splitMaxParts` 时**把多出来的并进最后一段**（宁可长一点，不丢内容）；
   * - 相邻两段完全相同 ⇒ 合并（否则后一段会被 `#sendOne` 的同文短窗闸吞掉 = 静默少一条）。
   *
   * @param {unknown} text
   * @returns {string[]} 至少一段；没标记 / 关掉时返回 `[]`? 不 —— 返回 `[原文]` 之外的
   *   唯一例外是"只有标记没有内容"，那时返回 `[]`（调用方按"没东西发"处理）。
   */
  #splitReply(text) {
    const marker = this.splitMarker;
    const source = String(text ?? '');
    if (marker === '' || !source.includes(marker)) return [source];

    const parts = [];
    let current = [];
    // **代码块里不切**：她贴一段含 `⟨cut⟩` 的代码时，那个标记是内容、不是切点。
    // 判据只认"整行以 3 个以上反引号开头"（和 `stripMarkdown` 的围栏规则同一形状）。
    let inFence = false;
    for (const line of source.split('\n')) {
      if (/^[ \t]*`{3,}/.test(line)) {
        inFence = !inFence;
        current.push(line);
        continue;
      }
      if (!inFence && line.includes(marker)) {
        // 一行里可能有多个标记：每遇到一个就是一次切。标记**之前**的文字归当前段，
        // 标记**之后**的文字成为下一段的开头（同一行切多次时，中间那段自成一段）。
        const pieces = line.split(marker);
        current.push(pieces[0]);
        for (let i = 1; i < pieces.length; i += 1) {
          parts.push(current.join('\n'));
          current = [pieces[i]];
        }
        continue;
      }
      current.push(line);
    }
    parts.push(current.join('\n'));

    const kept = [];
    for (const raw of parts) {
      const part = raw.trim();
      if (part === '') continue;
      // 相邻重复：合并成一段（中间隔一个换行）。不合并的话后一段会在
      // `#sendOne` 里被"同文短窗"拦下 —— 那正是"静默少一条"的形状。
      if (kept.length > 0 && kept[kept.length - 1] === part) {
        kept[kept.length - 1] = `${kept[kept.length - 1]}\n${part}`;
        continue;
      }
      kept.push(part);
    }

    if (kept.length === 0) return [];
    if (kept.length <= this.splitMaxParts) return kept;
    // 超上限：多出来的并进最后一段（**不丢内容**优先于"每段不太长"）。
    const head = kept.slice(0, this.splitMaxParts - 1);
    const tail = kept.slice(this.splitMaxParts - 1).join('\n');
    return [...head, tail];
  }

  /**
   * **真正发一条**（`#send` 的切分之后，一段对应一次本方法调用）。
   *
   * 除"切分"之外的**全部**出站规则都在这里：解析图片源 → 截断 → 剥 Markdown →
   * 同文短窗去重 → 记 `gw-send` → 交给传输层。
   *
   * @param {string} chatId
   * @param {string} text 已经是"一段"的正文
   * @param {unknown[]} [images]
   * @param {string} [caller]
   * @returns {Promise<any>}
   */
  async #sendOne(chatId, text, images = [], caller = 'send', kind = 'text') {
    // B3：截断挪到**每段**里（调用点不再先截）—— 否则一个在 2000 字以外的标记
    // 会先被截掉，切分永远看不见它。`truncateReply` 对已短于上限的串是恒等，
    // 所以老调用方就算自己截过一次也不会变样。
    const body = truncateReply(String(text ?? '').trim(), this.maxReplyChars);
    const { sources, usedStickers } = this.#resolveImages(images);
    const plain = stripMarkdown(body);
    // ==========================================================================
    // ⚠️ 2026-10-16：同一会话【短时间内重复发送完全相同的正文】⇒ 拦下。
    //
    // ## 为什么加这道闸（线上实证）
    //
    // 2026-10-16 12:04:00.916~.918，示例群（30000013）**同一条 26 字文本被发了 4 次**，
    // 台账里 4 行 `gw-send`（同 sha256）+ 4 行 `transport-action`，而且
    // **4 个 messageId 各不相同**（1560763351 / 1614974526 / 274443464 / 1236367793）
    // ⇒ 那是 NapCat 真真切切发出去 4 条，不是记账重复。
    //
    // ⚠️ **根因没查实**（会话文件里那 6 轮回复各不相同、台账里却有 4 条同文，
    //    两边对不上；进程只有一个、入站也没有重复投递）。所以这里**先加防御**：
    //    不管上游是谁在重复调用，这一层保证"同一句话不会连着甩进同一个群"。
    //
    // ## 边界（刻意收窄，别扩大）
    //
    // · **只在【同一个 chatId】+【正文完全相同】+【10 秒内】** 才拦 —— 三条同时成立。
    // · 带图的消息**不拦**（发两张一样的表情包是合法表达）。
    // · 拦下时照常记账、照常 `noteReplied`（她确实"说了"，只是没重复发出去）
    //   ⇒ 冷却期仍然生效，不会因为它被拦掉反而更容易再开口。
    // ==========================================================================
    const nowMs = typeof this.engine?.now === 'function' ? this.engine.now() : Date.now();
    if (sources.length === 0 && plain !== '') {
      const prev = this.recentSends.get(chatId);
      if (prev !== undefined && prev.text === plain && nowMs - prev.at < SAME_TEXT_WINDOW_MS) {
        this.log('warn', `拦下重复发送（同文短窗）${chatId}`, {
          chars: plain.length,
          msSince: nowMs - prev.at,
          caller,
        });
        return SEND_SUPPRESSED;
      }
      this.recentSends.set(chatId, { text: plain, at: nowMs });
    }
    // ⭐ **一行 = 一次"决定要发"**（这个不变式是整个台账的判读基础，别破坏它）。
    //
    // 时刻取**这里**（决定要发的瞬间）而不是 await 回来之后：台账的语义是
    // "插件决定要发一次"，而判"同一秒两条"要跟 NapCat 那边的同秒现象对得上。
    // 等往返回来再记，会把两条本来同秒的记录推散成不同秒，**恰好毁掉判据**。
    //
    // ⚠️ 所以这一行**拿不到 `messageId`** —— 那是 NapCat 回了才有的东西。
    //    `messageId` 记在下面 `transport-action` 那一层（那里才真有）。
    //    `ok` 的口径见 `#recordOutbound` 的注释（**不是**"NapCat 收下了"）。
    this.#recordOutbound(LAYER_GW_SEND, {
      chatId, caller, text: plain, at: new Date().toISOString(), ok: true, images: sources.length, kind,
    });
    const payload = outboundMessage(plain, sources);
    // 发送失败由 `transport-action` 那一层记（`ok:false`）—— 这里**不重复记**，
    // 否则一次发送会在 `gw-send` 上留两行，计数就不再是"要发几次"了。
    const result = await this.transport.sendToChat(chatId, payload);
    // 记账放在**发成功之后**：发失败却加了一次使用次数，会让"挑"的依据变假。
    for (const md5 of usedStickers) {
      try {
        this.stickerLibrary.recordUse(md5);
      } catch {
        /* 记账失败不影响这条消息已经发出去的事实 */
      }
    }
    return result;
  }

  /**
   * 往出站台账追一行（`gw-send` 这一层）。**绝不抛、绝不影响发送。**
   *
   * 这是 `#send` 唯一碰台账的地方 —— 台账坏了（目录没了、盘满、注入的是 null）
   * 也只是"少一条证据"，这条消息该发还是发。
   *
   * ## ⭐ 一行 = 一次"决定要发"（**这个不变式不许破坏**）
   *
   * 判读表（`outbound-ledger.mjs` 的 `describeOutboundVerdicts()`）是：
   *
   * ```
   * gw-send 1 + transport-action 2            ⇒ WS/传输层写了两遍
   * gw-send 1 + transport-action 1 + QQ 2     ⇒ NapCat 侧重复
   * gw-send 2                                 ⇒ 插件真的发了两次
   * ```
   *
   * 所以 **`gw-send` 的行数必须恰好等于"`#send` 被调了几次"**。
   * 千万别"顺手"在这里多发一行（发成功后再补一条回执之类）—— 那会让
   * **一次发送看起来就像发了两遍**，正好把这个台账存在的理由毁掉。
   * `messageId` 不在这里记，记在 `transport-action` 那一层（只有那里拿得到）。
   *
   * ## `ok` 的口径（**两层含义不同，别混**）
   *
   * | layer | `ok:true` 的含义 |
   * |---|---|
   * | `gw-send` | **这一层**走通了（解析图片、剥 Markdown、决定要发都没抛）。**不是**"NapCat 收下了" |
   * | `transport-action` | 真的调通了 `send_msg`（NapCat 回了 `message_id`）。`ok:false` = 抛了异常 |
   *
   * ⇒ "发失败"这件事**只出现在 `transport-action` 那一层**。这不只是口径问题：
   * 旧口径（`stats.replies` 只在成功后加）里"发失败"和"压根没打算发"是同一个数，
   * 而这两件事的处置完全不同。
   *
   * ⚠️ **绝不记正文**：只记 `chars`（净文本长度）+ `sha256`（净文本哈希前 16 位）。
   * 哈希是**判据** —— 同一秒里两条相同的 `sha256` ⇒ 真的发了两遍。
   *
   * @param {string} layer `gw-send` / `transport-action`
   * @param {{chatId: string, caller: string, text: string, at: string, ok: boolean, images?: number, messageId?: unknown, error?: string|null}} input
   * @returns {void}
   */
  #recordOutbound(layer, input) {
    const ledger = this.outboundLedger;
    // `sends` 这个计数**先加**（它是"当场一眼看"的那个口径），加完再去碰台账
    //（台账可能写不进去 —— 那个数不该跟着一起没了）。
    // ⚠️ `actions` **不在这里**加：它在传输层记账时通过 `attachOutboundLedger()`
    //    的回调加（那里才知道"真的交给 NapCat 了"）。
    if (layer === LAYER_GW_SEND) this.stats.outbound.sends += 1;
    if (ledger === null || typeof ledger.record !== 'function') return;
    try {
      ledger.record({
        at: input.at,
        layer,
        caller: input.caller,
        chatId: input.chatId,
        chars: input.text.length,
        sha256: ledgerHash(input.text),
        ok: input.ok,
        messageId: input.messageId,
        meta: {
          images: Number.isFinite(input.images) ? input.images : 0,
          error: input.error ?? null,
          // 2026-10-26：**三种出站要能分开数**。
          // `kind` 缺省是 `text`（老调用点的含义不变）：`send_voice` 传 `voice`，
          // `send_qq` 发图传 `image`。于是"她这段是说话、打字还是发图"在台账里一眼可判，
          // 不用去看 `caller` 猜。
          kind: input.kind === 'voice' ? 'voice' : (input.kind === 'image' ? 'image' : 'text'),
        },
      });
    } catch (error) {
      // `ledger.record()` 自己也是全 try/catch 的，这里是第二层保险
      //（注入进来的台账可能是别人写的、可能不守规矩）。
      this.log('warn', '出站台账写入失败（发送不受影响）', {
        layer,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * **校源**：`send_qq` 的 `kind=image` 到底能不能发（2026-10-26）。
   *
   * 七条闸全在这里，工具层只校参数形状（同一个分工原则，见 `sendFromTool` 的注释）：
   *
   * | # | 闸 | 为什么 |
   * |---|---|---|
   * | 1 | 出站白名单 | 在 `sendFromTool` 里判（和文字/语音同一个判定器），这里不管 |
   * | 2 | `file://` 一律拒 | 那等于让她读本机任意文件，没有理由开这个口子 |
   * | 3 | URL 只认 http/https | 同 2；`data:` 之类也拒 |
   * | 4 | 扩展名白名单 | **认不出就拒**，不猜 MIME（见 `SEND_IMAGE_EXTS`） |
   * | 5 | 本地路径必须存在、是文件、非空 | 不存在还发 = QQ 上一条红叹号 |
   * | 6 | 大小 ≤ `[send] max_image_mb` | 超了**拒绝并说明**，绝不截断（截断的图是坏图） |
   * | 7 | 可读（`R_OK`） | 存在但没权限，发出去也是失败 |
   *
   * ⚠️ **URL 那一侧量不到大小**（要量就得先下载一遍），所以只在扩展名/协议上把关；
   * 真要卡大小，得让 NapCat 下载失败时自己报错（那条路我们已经有了）。
   * ⚠️ 这里**不下载、不读图**（不碰附件服务），只做 `stat`/`access` —— 快，且没有副作用。
   *
   * @param {unknown} source 她给的 `path`（本地绝对路径 / http(s) 链接）
   * @returns {{ok: true, image: string, bytes: number|null} | {ok: false, error: string}}
   */
  #checkImageSource(source) {
    const raw = String(source ?? '').trim();
    if (raw === '') return { ok: false, error: 'kind=image 要配 path：本地绝对路径，或 http/https 链接。' };
    if (/^file:\/\//i.test(raw)) {
      return { ok: false, error: '`file://` 不行 —— 给本地绝对路径（`H:\\…\\a.png`）或 http/https 链接。' };
    }

    const extOf = (value) => {
      const m = /\.([A-Za-z0-9]+)$/.exec(String(value).replace(/[?#].*$/, ''));
      return m === null ? '' : m[1].toLowerCase();
    };
    const allowed = SEND_IMAGE_EXTS.join('/');
    const badExt = (ext) => ({
      ok: false,
      error: `认不出这是图片（扩展名${ext === '' ? '缺失' : `是 ${ext}`}）；只认 ${allowed}。换一张，或者先另存成 png/jpg 再发。`,
    });

    if (/^https?:\/\//i.test(raw)) {
      let pathname = '';
      try {
        pathname = new URL(raw).pathname;
      } catch {
        return { ok: false, error: `这个链接格式不对：${raw}` };
      }
      const ext = extOf(pathname);
      if (!SEND_IMAGE_EXTS.includes(ext)) return badExt(ext);
      // URL 侧量不到大小（不为此下载），交给 NapCat 下载失败时自己报错。
      return { ok: true, image: raw, bytes: null };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      // 别的协议（`data:` / `ftp:` / `file:` 已在上面挡掉）：一律拒，别猜。
      return { ok: false, error: `只认 http/https 链接或本地绝对路径，不接受这种协议：${raw.slice(0, 24)}…` };
    }

    const ext = extOf(raw);
    if (!SEND_IMAGE_EXTS.includes(ext)) return badExt(ext);
    let stat = null;
    try {
      stat = fs.statSync(raw);
    } catch {
      return { ok: false, error: `这个路径不存在（或者打不开）：${raw}` };
    }
    if (stat.isDirectory()) return { ok: false, error: `这是个文件夹，不是图片文件：${raw}` };
    if (!stat.isFile()) return { ok: false, error: `这不是一个普通文件：${raw}` };
    if (stat.size <= 0) return { ok: false, error: `这个文件是空的（0 字节）：${raw}` };
    if (stat.size > this.maxImageBytes) {
      const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
      return {
        ok: false,
        error: `图太大了：${mb(stat.size)} > 上限 ${mb(this.maxImageBytes)}（\`[send] max_image_mb\`）。不截断 —— 压缩一下或者换一张。`,
      };
    }
    try {
      fs.accessSync(raw, fs.constants.R_OK);
    } catch {
      return { ok: false, error: `这个文件读不了（权限？）：${raw}` };
    }
    return { ok: true, image: raw, bytes: stat.size };
  }

  /**
   * 把出站图片源里的**表情包引用**换成真正的文件路径。
   *
   * 认两种写法（其余原样透传给 `imageSegment`）：
   * - `{sticker: '<md5>'}` —— 明确指定；
   * - 裸的 32 位十六进制串 —— **且库里真有这一条**。
   *
   * 裸串那条刻意要求"库里真有"：只按形状判会把普通文件名/路径误当表情包
   * （同 `image-cache.mjs` 里 `name:` 键那条规矩 —— 名字看着像哈希 ≠ 它就是哈希）。
   *
   * 认不出的表情包引用**跳过并记一条 warn**，绝不发半个段出去。
   *
   * @param {unknown[]} images
   * @returns {{sources: unknown[], usedStickers: string[]}}
   */
  #resolveImages(images) {
    const list = Array.isArray(images) ? images : [];
    const sources = [];
    const usedStickers = [];
    for (const item of list) {
      const explicit = item !== null && typeof item === 'object' && !Array.isArray(item)
        ? String(item.sticker ?? '').trim()
        : '';
      const bare = typeof item === 'string' && STICKER_ID.test(item.trim()) ? item.trim() : '';
      const wanted = explicit !== '' ? explicit : bare;
      if (wanted === '') {
        sources.push(item);
        continue;
      }
      const path = this.stickerLibrary === null ? null : this.stickerLibrary.pathOf(wanted);
      if (path === null) {
        // 裸哈希不在库里 → 它就是个普通文件名，交回给 imageSegment 原样处理。
        if (explicit === '') {
          sources.push(item);
          continue;
        }
        this.log('warn', '要发的表情包不在库里（跳过这张）', { sticker: wanted });
        continue;
      }
      sources.push(path);
      usedStickers.push(wanted);
    }
    return { sources, usedStickers };
  }

  /**
   * 主动发言：由引擎判定后调用，或由外部（定时播报/工作汇报）直接调用。
   *
   * `images` 是本轮要**附带发出去**的图（URL / 本地路径 / `{sticker:'<md5>'}`）。
   * 省略或空数组时行为与改动前完全一致（纯文本）。
   *
   * @param {string} chatId
   * @param {string} text
   * @param {unknown[]} [images]
   * @returns {Promise<boolean>}
   */
  async speakProactively(chatId, text, images = []) {
    if (this.stopped) return false;
    if (!this.router.proactiveAllowed(chatId)) {
      this.log('warn', `拒绝向 ${chatId} 主动发言（不在允许范围）`, {});
      return false;
    }
    // B3：截断在 `#sendOne` 里做（每段一次）；这里只去空白。
    const body = String(text ?? '').trim();
    const list = Array.isArray(images) ? images : [];
    // 纯文本时仍然要求正文非空（老行为）；带图时正文可以为空
    // —— "只发一张表情包"是合法的一次发言。
    if (body === '' && list.length === 0) return false;
    try {
      const sent = await this.#send(chatId, body, list, 'speak-proactive');
      // 被"同文短窗"拦下 ⇒ **没发出去**，如实返回 false、也不记 replies。
      // （返回值是调用方判断"到底说没说"的依据，虚报 true 会让它以为播报成功了。）
      if (sent === SEND_SUPPRESSED) return false;
      this.stats.replies += 1;
      this.log('info', `主动发言 ${chatId}`, { chars: body.length, images: list.length });
      return true;
    } catch (error) {
      this.log('warn', `主动发言失败 ${chatId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

/** 去重集合的容量上界：Set 保持插入序，超了就丢最早的一半。 */
function pruneSeen(seen, limit = 5000) {
  if (seen.size <= limit) return;
  const drop = seen.size - Math.floor(limit / 2);
  let count = 0;
  for (const id of seen) {
    seen.delete(id);
    if (++count >= drop) break;
  }
}
