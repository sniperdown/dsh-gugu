/**
 * 插件宿主半入口：把八个模块接成一个能跑的 QQ 通道。
 *
 * 装配关系：
 *
 *   OneBot WS ─ transport ─┐
 *                          ├─ gateway ── responder ── SessionBinder ── DSH 会话
 *   proactive/engine ──────┘      │
 *        ▲                        └─ router（访问控制 + 会话键）
 *        └── heuristic-gauge（话题判定）
 *
 * `inject` 只声明真正需要的服务。**刻意不声明 peerDependencies**：
 * 任何一条 `@deepseek-ai/dsh*` 范围不匹配都会让这一行被宿主静默 disable，
 * 而运行时本来就会把插件 import 的包重定向到宿主安装树的同一实例。
 * 同理这里不 import schemastery，`Config` 用普通对象即可。
 *
 * @module qq-dsh/index
 *
 * ⚠️ 改这个文件（或 `src/` 下任何文件）会触发 HMR ⇒ **dispose 小鲸鱼的 agent**。
 *    如果那一刻它正跟人对话，那一轮会被掐断在半句话中间 ——
 *    动手前先看 `qq-proactive-debug.json` 的 `stats.received/dispatched/replies`
 *    涨不涨（涨 = 正在说话）。规矩在 AGENTS.md。
 *
 * 2026-10-16 记：`[memory] learned_enabled`（旧记忆库开关）加在这里，
 *    真源在 `<DSH_HOME>\profiles\desktop\qq-gugu.toml` 的 `[memory]` 段。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTransport, backoffDelay } from './onebot/transport.mjs';
import { ProactiveEngine, defaultTriggerConfig } from './proactive/engine.mjs';
import { Gateway } from './dsh/gateway.mjs';
import { dshHome } from './dsh/paths.mjs';
import { Router, defaultConfig, parseChatId, chatIdFromSessionKey, POLICY, normalizeIdList } from './dsh/routing.mjs';
import { createSessionMap, createSessionResolver } from './dsh/chat-sessions.mjs';
import { SessionBinder, resolveGroupDenyTools, publishToolBridge } from './dsh/binding.mjs';
import { judge, defaultGaugeConfig } from './dsh/heuristic-gauge.mjs';
// 「说不说」的裁量模式（2026-10-13）：模式 2 `precheck` 的**一次性**轻量预检在这里。
// ⚠️ 打分器（`heuristic-gauge.mjs`）一行没动 —— 三种模式共用它。
import {
  JUDGE_MODE_IN_TURN,
  JUDGE_MODE_PRECHECK,
  DEFAULT_PRECHECK_TIMEOUT_MS,
  createPrecheck,
  normalizeJudgeMode,
  resolvePrecheckModel,
} from './dsh/judge-mode.mjs';
import { createSettingsHandler, CHANNEL as SETTINGS_CHANNEL } from './dsh/settings-host.mjs';
import { buildWorkReport, shortId } from './dsh/report.mjs';
// 自动搬运（2026-11-02）：宿主自己跑的轮次（子会话交活 / 后台作业结束 / schedule 到点 /
// banner 恢复）不经 `runTurn`，以前她说的字只写进会话、QQ 上一个都不到。
import { createAutoRelay } from './dsh/auto-relay.mjs';
import { createHistoryBackfillController, DEFAULT_COUNT as HISTORY_BACKFILL_COUNT } from './dsh/history-backfill.mjs';
import { buildAlert, isChatSession, readSessionState, shouldNotify } from './dsh/notifier.mjs';
import { createLearner } from './dsh/learner.mjs';
import { createOutboundAllow } from './dsh/outbound-allow.mjs';
import { createMood, moodSnapshotState, DEFAULT_MOOD_UPDATE_NOTE } from './dsh/mood.mjs';
import { createImageDescriber, normalizeStickerGate } from './dsh/image-desc.mjs';
// 显存门控（2026-10-09）：`[vision_gate]` 在 toml 里，接线在代码里。
// ⚠️ 用户点名的那条 if「空闲显存 < 7G ⇒ v4f，否则本地」的**决策**在 `vram-gate.mjs`，
//    这里只负责"读配置 + 造一个带缓存的决策函数 + 注入描述器"。
import { createVisionGate, normalizeVisionGate } from './dsh/vram-gate.mjs';
// 审核留样（2026-10-09）：把**每一张被审核过的图**（含被拒的）另存一份给用户标。
// ⚠️ 它和"入库"那条路（`media\stickers\`）**语义不同、目录不同**，刻意不合并。
import { createStickerAudit, normalizeStickerAudit, DEFAULT_STICKER_AUDIT } from './dsh/sticker-audit.mjs';
// 出站台账（2026-10-11）：**只加观测** —— 往 QQ 发消息时在两个层各留一行
// （`gw-send` / `transport-action`），让"重复发两条"下次发生时**一眼能定位在哪一层**。
// ⚠️ **这次刻意不去重、不加重试**（重复在哪一层还不知道，两者都会**掩盖**它）。
// 判读方式与理由见 `outbound-ledger.mjs` 的模块头。
import { createOutboundLedger, DEFAULT_OUTBOUND_LEDGER_PATH } from './dsh/outbound-ledger.mjs';
// 语音转文字（B4 真答案，2026-10-25）：NapCat 的 record 段**没有转写**，
// 用本机 faster-whisper 转一次（SILK→WAV 由 NapCat 的 `get_record` 负责）。
import { createVoiceTranscriber, DEFAULT_VOICE } from './dsh/voice.mjs';
// 2026-10-26：出站语音（`send_voice`）—— `edge-tts` 合成 mp3，NapCat 自己转 silk。
import { createTtsSpeaker, DEFAULT_TTS } from './dsh/tts.mjs';
// 2026-10-26：语音情绪旁路（wav2small）—— 只算 arousal、只记录、**不进提示词**。
import { createEmotionSenser, DEFAULT_EMOTION } from './dsh/emotion.mjs';
// `QQ → 昵称` 表（2026-10-14）：NapCat 的 at 段**不带昵称** ⇒ `@某人` 渲染成 `@30000002`，
// 模型认不出那是谁（连"@ 的是它自己"都认不出）。所以自己从每条消息的 `sender` 攒一张表，
// 渲染时查它；查不到才退回 `@QQ号`（用户明确要求保留这个退化行为）。
// 数据来源有两条，**都喂进同一张表**：入站事件（`gateway.handleEvent`）+ 灌历史
// （`history-backfill` 的那些历史消息 `sender`）。
// 理由、两层结构（群名片 / 昵称）与实测依据见 `nicknames.mjs` 的模块头。
import { createNicknameTable, DEFAULT_NICKNAME_TABLE_PATH } from './dsh/nicknames.mjs';
import { DEFAULT_DESC_TABLE_PATH } from './dsh/image-cache.mjs';
import {
  DEFAULT_STICKER_DIR,
  DEFAULT_STICKER_INDEX_PATH,
  createStickerLibrary,
} from './dsh/sticker-library.mjs';
import { KnowledgeBase } from './dsh/knowledge.mjs';
import { parseToml } from './dsh/toml.mjs';
import { createRelationsLedger } from './dsh/relations-ledger.mjs';
import { createRecallStore } from './dsh/recall.mjs';
import { createRecallCompressor } from './dsh/recall-compress.mjs';
import { createTranscriptStore } from './dsh/transcript-store.mjs';
import { resolveStatePath } from './dsh/paths.mjs';
import { createTopicStore } from './dsh/topics.mjs';
import { createTopicExtractor } from './dsh/topics-extract.mjs';
import { buildSnapshot, createDebugWriter, defaultDebugPath } from './dsh/debug-snapshot.mjs';
import { createFreeTime } from './dsh/free-time.mjs';
// 唤醒前的整屏截图（2026-10-21）：整个虚拟桌面（主屏 + 副屏拼成一张）。
import { captureVirtualDesktop } from './dsh/screen-capture.mjs';
// 用户：`[owner] admins`（2026-10-21）。在这之前用户是"白名单第一个"，两个语义
// （能不能聊天 / 谁是用户）绑在同一个数组顺序上，所以单开一段。
import { loadOwnerConfig, ownerFromTomlDocument } from './dsh/owner.mjs';
// 人格的按会话覆盖层（2026-10-21）：`[personality.groups."<群号>"]` 等。
import {
  loadPersonaSections,
  personaForSession,
  personaSectionsFromDocument,
  overriddenPersonaKeys,
  mergePersonaFields,
  emptyPersonaFields,
} from './dsh/persona-sections.mjs';
// 群名缓存（2026-10-21）：配置页要显示真实群名，宿主原来没有来源。
import { createGroupNameCache, DEFAULT_GROUP_NAME_TABLE_PATH } from './dsh/group-names.mjs';
// 配置页的字段目录（scope + key 读写契约）。
import {
  CONFIG_FIELDS,
  SCOPE_FIELDS,
  fieldByKey,
  fileFieldValue,
  effectiveFieldValue,
  coerceFieldValue,
} from './dsh/config-fields.mjs';
// 旁路模型的**分文件配置**（2026-10-30）：解析 / 枚举 / 段名归属。
// 读、写、备份**都从这一个模块拿路径** —— 别在别处拼 `<base>.<key>.toml`。
import {
  describeModelFiles,
  isModelFileKey,
  resolveModelToml,
  splitTomlPath,
} from './dsh/toml-files.mjs';
// 每轮提示词里的固定句子（2026-10-30 从代码搬进 `[prompt]`）。
import { loadPromptConfigFromFile, normalizePromptConfig } from './dsh/prompt-config.mjs';
// 只改目标键的行级 TOML 手术 + 校验 + 备份 + 原子写。
import {
  isDangerKey,
  rewriteTomlKey,
  removeTomlKey,
  validateTomlRewrite,
  validateTomlKeyRemoved,
  backupToml,
  atomicWriteText,
  defaultBackupDir,
  readTomlKey,
} from './dsh/toml-edit.mjs';
// 小鲸鱼的推理等级（`[agent] reasoning`，2026-10-21）。合法取值与缺省值都在那个模块里，
// 配置页的 `options` 也直接引用它（**只此一份**，免得"能选但跑起来抛错"）。
import { loadAgentConfig } from './dsh/agent-config.mjs';
// 宿主侧**临时**配置服务（2026-10-21）：点「QQ 小鲸鱼」时才起，心跳一停就关。
// 平时不占任何监听端口——配置页从"常驻入口"改成"临时网页"之后，这就是它的生命周期。
import {
  createConfigServer,
  createConfigServerRoutes,
  defaultConfigPageStatePath,
  readPageHtml,
  resolveWebServerOrigin,
} from './dsh/config-server.mjs';
// 把临时地址交给系统默认浏览器（零依赖；失败只记 warn，地址本身照常返回）。
import { openBrowser as openSystemBrowser } from './dsh/open-browser.mjs';

/** Cordis 插件名。 */
export const name = 'qq-proactive';

/**
 * 本模块被 import 的时刻。
 *
 * 用途只有一个：判断**正在跑的进程用的是不是改完之后的代码**。
 * 踩过的坑：改完插件源码没重启宿主，于是新代码从没被执行过，而所有计数
 * 看起来都正常——排查会一路往"逻辑不对/配置不对"的方向走，因为没人会想到
 * 跑的是旧代码。快照里的 `staleCode` 就是拿源码 mtime 与这个时刻比出来的。
 */
const MODULE_LOADED_AT = Date.now();

/** 插件自身的 `src/` 目录（自查代码新鲜度用；只关心运行时代码，不含测试与文档）。 */
const PLUGIN_SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 需要的宿主服务。
 *
 * - `agents`：创建/恢复每个 QQ 会话的 agent。缺它整个插件无法工作，所以必须声明。
 * - `timer`：空闲会话释放的定时器（Cordis 的 timer 插件提供）。
 * - `agentDefaultModel`：读部署默认的 provider/model。
 *   **这一条不能少**：agent loop 在分发前必须有 provider 与 model 两者，
 *   而插件需要从部署默认里补齐。漏掉声明的后果不是报错，而是运行到那一步时
 *   Cordis 抛 `cannot get property "agentDefaultModel" without inject`，
 *   于是模型路由为空、整轮没有任何模型请求——表现成"机器人从不回话"。
 *   这个坑是实测踩出来的。
 * - `connection` / `webServer` **不在这个列表里**，是刻意的。
 *   设置页需要它们（`connection.register` 内部要 `owner.webServer`），但它们
 *   只存在于带 Web 前端的部署。**一旦写进模块级 inject，纯 headless 部署里
 *   整个插件会挂起不激活**（实测：`pending (waiting for services: connection, webServer)`，
 *   端口都不开，QQ 通道完全不工作）。
 *   所以这两个走下面的**条件加载**：有就挂设置页，没有就只记一条 info。
 */
export const inject = ['agents', 'timer', 'agentDefaultModel', 'llm', 'agentPresets'];

/**
 * **刻意不导出 `Config`**。
 *
 * Cordis 的 `resolveConfig`（cordis/lib/index.js:956）是这么走的：
 *
 *   if (!runtime.Config) return config;
 *   const result = runtime.Config['~standard'].validate(config);
 *
 * 也就是说它要的是一个 **Standard Schema**（带 `~standard.validate`）。
 * 早期这里导出了一个普通对象当"配置形状声明"，结果 Cordis 拿到它、去读
 * `'~standard'` 得到 undefined，插件直接以
 * `TypeError: Cannot read properties of undefined (reading 'validate')` 拒绝激活——
 * 这是真机验证时实测到的。
 *
 * 不导出 `Config` 时 Cordis 会把原始配置原样交给 `apply`，校验与默认值全部由
 * 本模块的 `resolveConfig` 负责。这样做的额外好处是：
 * - 插件仍然**零运行期依赖**（不需要 import schemastery）；
 * - 校验错误信息是我们自己写的，能直接告诉运维"哪里错了、该怎么改"，
 *   而不是一串 schema 违例路径。
 *
 * 代价：插件管理器 UI 看不到这一行的配置表单（那需要导出真正的 schema）。
 * 配置当前通过 profile 的 `cordis.patch.yml` 提供。
 */
const CONFIG_SHAPE = {
  mode: 'reverse',
  host: '127.0.0.1',
  port: 8643,
  url: 'ws://127.0.0.1:3001',
  /**
   * `mode: 'http'` 时用的 NapCat HTTP API 地址（如 `http://127.0.0.1:3000`）。
   *
   * http 模式**只发不收**：不建 WS、不抢端口，用于与 `dsh-onebot-qq` 共存——
   * 那个插件在反向 WS 模式下要独占监听端口（NapCat 只拨一条连接，且它的实现
   * 采用 last-wins 会顶掉旧连接）。代价是收不到事件，所以只能**主动发言**，
   * 被动回复交给 `dsh-onebot-qq`。
   */
  httpUrl: '',
  accessToken: '',
  botQQ: '',
  adminUsers: [],
  /** 出站白名单：允许私聊的 QQ 号（不在名单里的一律不处理、也不往回发）。 */
  allowFrom: [],
  /** 出站白名单：允许的群号。 */
  groupAllowFrom: [],
  dmPolicy: POLICY.ADMIN,
  groupPolicy: POLICY.ADMIN,
  /**
   * 私聊去向：
   * - `isolated`（默认）：每个私聊联系人一个独立持久会话。
   * - `main`：所有私聊统一进 `mainSessionKey` 指定的那个会话
   *   （即需求里的"私聊消息进主会话"）。
   */
  dmRouting: 'isolated',
  /**
   * `dmRouting=main` 时的目标 DSH 会话 id（形如 `session-<uuid>`，**不是** chatId）。
   * 留空会回落到 `isolated` 并记一条日志——刻意不隐式挑一个"主会话"，
   * 因为那会让"它为什么答的是那个会话的内容"极难排查。
   */
  mainSessionKey: '',
  /**
   * 会话 id 策略（2026-10-24，P2-6）：
   * - `new-if-no-legacy`（默认，用户拍板）：表里有就查表；新聊天（**没有可接回的旧会话**）
   *   分配 `session-<uuid>`；已有旧会话的聊天在 P3-9 迁移前**继续用旧 id**。
   * - `legacy`：永远用旧前缀拼串（回滚开关）。
   *
   * 判据是 binder 的 `resume`：失败 = 没有旧会话。这也让"日志坏掉的旧会话"
   * 自然换新 id，而不是继续在孤儿目录里新建空会话。
   */
  sessionIdPolicy: 'new-if-no-legacy',
  requireMention: true,
  restrictMembers: true,
  agentPreset: '',
  /**
   * ⚠️ **「学来的记忆」的开关（`[memory] learned_enabled`）刻意不在这里。**
   *
   * 理由和 `groupAgentPreset` / `denyToolsInGroup` / `knowledgePath` 是同一条：
   * `CONFIG_SHAPE` 会**物化**一个值出来，"这台机器上没配"和"配成默认值"就再也
   * 分不开了。而这个开关要的正是「**没配 = 默认开着**（与改动前等价）」，真源只有
   * toml 一处。它是**行为配置**，不是**加载配置**（分层规矩见 AGENTS.md）。
   * 读取与默认值在 {@link loadLearnedMemoryConfig}。
   */
  /**
   * **群会话那份 preset（`groupAgentPreset`）刻意不在这里。**
   *
   * 它需要三态：`undefined` = 没配（按 `agentPreset` 推导 `-lite`），
   * `''` = 配了"群跟私聊用同一份"，字符串 = 用指定的那份。而这个对象会被
   * **物化**（不写就有空串），物化之后前两种再也分不开 —— 和 `denyToolsInGroup`
   * 同一个坑（见 `binding.mjs` 里 `resolveSessionPreset` 的说明）。
   */
  /**
   * QQ 会话的模型 provider/model。留空则用部署全局默认。
   *
   * 小鲸鱼的会话要显式配 `deepseek-official` + `deepseek-flash`（多模态 text+image，
   * 能识图），否则跟着全局默认走成 deepseek-v4-pro（text-only，丢了识图）。
   */
  provider: '',
  model: '',
  /**
   * 推理强度（`reasoningEffort`）。留空则继承部署全局默认。
   *
   * **为什么小鲸鱼要单独配低值**：全局默认是 `max`，实测后果很具体 ——
   * 用户在私聊里随口问一句「要不要调小模型省钱」，小鲸鱼拿 `high/max` 的推理
   * 把这句话当成调研任务，去翻 DSH 源码找模型定价表，跑满 50 步、3 分钟
   * 还没结束，私聊就被这一个 turn 堵死了（用户连发两条都没等到回复）。
   *
   * 闲聊不需要深度推理。需要深想的活儿本来就不该占着 QQ 会话。
   */
  reasoningEffort: '',
  /**
   * 小鲸鱼人设（主动插话措辞用）。`ctx.llm.stream` 不经过 agent 会话、不挂 preset，
   * 所以要在这里单独给一份 persona 文本。留空则措辞退化成无 person 的普通文本。
   */
  persona: '',
  workspacePath: '',
  /**
   * 上线播报目标（chatId，如 `private:10000001`）。留空则不播报。
   *
   * 插件启动时往这里发一条「（小鲸鱼上线了）」。理由是用户常在外面、只能靠 QQ
   * 判断家里电脑的状态，而 DSH 重启期间这边是断的 —— 没有播报的话，
   * "重启中"和"真挂了"在他眼里完全一样（实测他因此两次以为机器坏了）。
   */
  onlineAnnounce: '',
  maxReplyChars: 2000,
  /** 本轮没有纯文本时的兜底回复（留空则沉默）。
   * 模型跑完一轮却只说工具调用、没有一句话时，QQ 那边会一片沉默，
   * 用户不知道发生了什么。配了它就补一句。默认留空 = 沉默。 */
  emptyReplyFallback: '',
  /**
   * **图片描述**：`'forward'`（默认）· `'all'` · `'off'`。
   *
   * 合并转发里夹着的图，模型看不到原图（一张都投不进去，几十张更不可能），
   * 所以给一句描述让"看得见"。
   *
   * ## ⚠️ 2026-10-07 核实：**顶层单发的图其实也在被描述**（与这里的说明不符）
   *
   * 这段注释原来写的是「顶层单发的图**默认不描述**」，但**代码不是这么跑的**：
   * `collectEmbeddedImages`（`onebot/rich.mjs`）遍历段数组时**把顶层的 `image` 段也收了**
   * —— 它的文档说"只钻进 forward、不返回顶层图片"，实现却是在任意层遇到 `image` 就 push。
   *
   * 证据（不是推断）：小鲸鱼的私聊会话里，用户**直接发**的一张表情包，正文就是
   * `[图片: 动画表情]`（顶层图的渲染格式是 `[图片: …]`，带序号 `[图片1: …]` 才是转发里的）。
   * 那条只能是走 `describeAll` 得来的。
   *
   * ⇒ 所以 `'forward'` 与 `'all'` 目前**事实上等价**（`'all'` 只是多收一遍、
   *   靠 `describeAll` 的去重兜住，不会多花钱）。
   *
   * **本次有意不动这个行为**：用户这次要的正是"**动图看得见动态**"，
   * 而真实场景里的 GIF **恰恰都是顶层单发的表情包** —— 把 `'forward'` 修成字面意思
   * 会让这次的改动在最需要它的地方**静默失效**。
   * 想让名字和行为对上，应该**另外拍板**（要么把默认值改成 `'all'` 并把 `'forward'`
   * 改成真的只看转发内，要么把这个配置项改名）—— 那是一次行为变更，不该塞在这一次里。
   *
   * 想连顶层也描述就写 `'all'`（每条消息最多 6 张，同图有缓存不重复花钱）。
   * 用户 2026-10-07 原话：「图片用描述，**可以和偷表情包的那套简短描述公用**」——
   * 实现就是 `dsh/image-desc.mjs`，表情包那边直接调同一个 `describe()`。
   */
  imageDescription: 'forward',
  /**
   * **图片原件的本地目录模板**（2026-10-07 加，用户要求）。
   *
   * 为什么进配置而不是写死在代码里：**它跟环境绑死**
   * （QQ 装在哪个盘、数据目录叫什么、哪个账号），
   * 别人装的时候路径一定不一样。用户原话：
   * 「路径模板也进配置（它是"环境相关"的 —— 别人装的时候 QQ 数据目录不一样）」。
   *
   * 占位符：
   * - `{qq}` = 本条的 `botQQ`（**账号 id 绝不硬编码** —— 用户特别警告过：
   *   开发机上"用户账号"的缓存能用只是**碰巧**（他当时也在同一个群、客户端也收了一份），
   *   拿别人的账号目录去翻原件是**一定会出错**的捷径）；
   * - `{yyyy}` / `{mm}` / `{yyyy-mm}` = 当前年月；
   * - `*` = 这一层按"年-月"目录展开（从新到旧，最多 6 个）—— 跨月不用改配置。
   *
   * 默认三条都只含 `{qq}`：
   *
   * | 模板 | 是什么 |
   * |---|---|
   * | `…\Pic\*\Ori` | NTQQ 收到的图片原件（按年月分目录） |
   * | `…\Emoji\emoji-recv` | **收到的表情包**（实测贴纸原件落在 Emoji 缓存里，不在 Pic） |
   * | `…\Emoji\emoji-recv\*\Ori` | 同上，带年月子目录的那种布局 |
   *
   * ⚠️ **默认值里刻意不含 `Image\Group2`**（旧版 QQ 布局）：那是**用户账号**的路径形状。
   * 要加就自己往这里写 —— 默认值不替任何人猜。
   */
  imageOriginalDirs: [
    'D:\QQNT\\data\\{qq}\\nt_qq\\nt_data\\Pic\\*\\Ori',
    'D:\QQNT\\data\\{qq}\\nt_qq\\nt_data\\Emoji\\emoji-recv',
    'D:\QQNT\\data\\{qq}\\nt_qq\\nt_data\\Emoji\\emoji-recv\\*\\Ori',
  ],
  /**
   * **图片描述缓存表**（跨会话；用户拍板放 `<DSH_HOME>\` 下）。
   *
   * 作用：同一张图（内容哈希相同）**第二次出现就不再花一次模型调用**。
   * 描述是唯一能穿越长上下文的载体（图片会被 offload），所以"同一张表情包反复发"
   * 这种情况值得一张落盘的表 —— 插件重启/热重载后它还在。
   *
   * ⚠️ **它是缓存，不是真相**：读不到/坏了/版本对不上一律**当空表**
   * （照常重新识图），绝不因为表出问题而影响一轮回复。
   * 写 `''` = 明确关掉这张表。
   *
   * 路径的**唯一来源**是 `image-cache.mjs` 的 {@link DEFAULT_DESC_TABLE_PATH} ——
   * 这里不重复写一遍字符串（重复的那份迟早会分叉）。
   */
  imageDescCachePath: DEFAULT_DESC_TABLE_PATH,
  /**
   * **表情包库**：图落在哪个目录（2026-10-08 加，本次"偷表情包"的产物位置）。
   *
   * 参考 MaiBot 是 `IMAGES/emoji/`（`utils_image.py:203-228`）—— 我们跟它一致的是
   * "**一个专门的表情包目录**"，不一致的是**路径进配置、不写死在代码里**
   * （同 `imageOriginalDirs` / `imageDescCachePath` 那条规矩：
   * 环境相关的东西进配置，别人装的时候路径一定不一样）。
   *
   * 库里每个文件的名字就是**内容 md5**（`<md5>.gif`），索引在
   * {@link CONFIG_SHAPE.stickerIndexPath}。
   *
   * 写 `''` = **明确关掉"偷"**（照样收消息、照样回；发图那半边也不受影响）。
   */
  stickerDir: DEFAULT_STICKER_DIR,
  /**
   * **表情包索引**（跨会话的 json 表；与 `qq-image-desc.json` 同构）。
   *
   * ```json
   * { "version": 1, "updatedAt": "…",
   *   "entries": { "<md5>": { "file": "<md5>.gif", "path": "…", "emojiId": "…",
   *                           "at": "…", "seen": 0, "uses": 0, "lastUsedAt": null,
   *                           "tags": [], "source": {"chatId": "…", "userId": "…"} } } }
   * ```
   *
   * ⚠️ **它是库、不是真相源**：读不到 / 坏了 / 版本对不上一律**当空库**
   * （照常收消息回消息，只是这一轮偷不到）。**库绝不能变成单点故障** ——
   * 这条与 `imageDescCachePath` 完全同一个原则（写 `''` = 关掉整张表）。
   */
  stickerIndexPath: DEFAULT_STICKER_INDEX_PATH,
  /**
   * 要不要**偷**群友的表情包。
   *
   * 默认开。关掉只影响"入库"那半边：**发图能力（出站图片段）不受它控制**
   * —— 那两件事共用库，但不共用开关。
   *
   * ⚠️ 判据是**位判据**（`emoji_id` 非空 **或** `sub_type & 1`）：普通图
   * （`sub_type: 0` 的照片/截图/梗图）**一个字节都不会落盘**。
   * 理由见 `dsh/sticker-library.mjs` 的模块注释。
   * 另有一道**审核闸**（`[sticker_gate]`，2026-10-08 改成**打分制**）：新图入库前会「认」一次，
   * 四项 0-10 打分 vs 四项阈值、配文长度、真人/截图，任一命中就**不入库**；**没看成**也不入库。
   */
  stickerSteal: true,
  /**
   * **出站台账**（2026-10-11 加，B9）：每一次往 QQ 发消息，在
   * `gw-send`（插件决定要发）与 `transport-action`（真交给 NapCat）**各留一行**。
   *
   * 为什么要有它：2026-10-09 那次"同一条消息在 QQ 上出现两条"，出站两头
   * **都没有留档** ⇒ 根因**定不到唯一**（报告见
   * `shared\tmp\2026-10-10-出站重复-session-00000000.md`）。**卡点不是推理不够，
   * 是口径不存在。**
   *
   * ⚠️ 它**只记长度 + sha256，绝不记正文**（隐私）。
   * ⚠️ 它**只加观测，不做去重、不加重试** —— 重复在哪一层还不知道，
   * 去重会吃掉第二条、重试会制造第二条，**两者都会掩盖它**。
   * ⚠️ **写不进去绝不影响发送**（只记一行 log）——
   * `sticker-audit` 那次的教训：观测设施坏了不能把被观测的事也弄坏。
   *
   * 路径的**唯一来源**是 `outbound-ledger.mjs` 的
   * {@link DEFAULT_OUTBOUND_LEDGER_PATH}（本部署 = `<DSH_HOME>\media\qq-outbound.jsonl`）。
   * **写 `''` = 明确关掉**（与 `stickerDir` / `imageDescCachePath` 同一条规矩）。
   */
  outboundLedgerPath: DEFAULT_OUTBOUND_LEDGER_PATH,
  /**
   * **`QQ → 昵称` 表**（2026-10-14 加）：`@某人` 要渲染成 `@昵称`，而不是 `@QQ号`。
   *
   * 为什么需要它：NapCat 的 at 段**只有 `{type:'at', data:{qq}}`**、不带昵称
   * （2026-10-06 与 2026-10-14 两次实测，见 `protocol.mjs` 的 `formatAtSegment`），
   * 所以插件只能自己攒：每条消息的 `sender.nickname` / `sender.card` 都是一个名字样本。
   *
   * 表有**两层**：`(群, QQ) → 群名片` + `QQ → 昵称`（先本群名片、再全局昵称）。
   * 实测依据：同一个人的群名片在不同群真的不一样（`30000021` 在测试群是空、
   * 在群 30000011 是「本群名片A」）。**查不到就退回 `@QQ号`**（老行为，不改）。
   *
   * 路径的**唯一来源**是 `nicknames.mjs` 的 {@link DEFAULT_NICKNAME_TABLE_PATH}
   * （本部署 = `<DSH_HOME>\media\qq-nicknames.json`，与 `qq-outbound.jsonl` /
   * `qq-image-desc.json` 同处）。**写 `''` = 明确关掉**（@ 全部退回 `@QQ号`）。
   *
   * ⚠️ 它**不是必需品**：读不到 / 坏了当空表，写不进去只记一行 log
   * （同 `outboundLedgerPath` / `imageDescCachePath` 那条规矩）。
   */
  nicknameTablePath: DEFAULT_NICKNAME_TABLE_PATH,
  /**
   * **群名缓存**（2026-10-21 加）：`{群号: 群名}`，配置页显示真实群名用。
   *
   * 来源只有 `get_group_info`（NapCat 的 at 段/入站事件都不带群名），
   * 拉一次落盘、之后按需补拉。路径的**唯一来源**是 `group-names.mjs` 的
   * {@link DEFAULT_GROUP_NAME_TABLE_PATH}（本部署 = `<DSH_HOME>\media\qq-group-names.json`）。
   *
   * **写 `''` = 明确关掉**（同 `nicknameTablePath`）。它**不是必需品**：
   * 读不到 / 坏了当空表，取不到名字时接口给空串、前端回退显示号码。
   */
  groupNameTablePath: DEFAULT_GROUP_NAME_TABLE_PATH,
  reconnectMaxAttempts: 0,
  actionTimeoutMs: 15000,
  /** 主动发言：默认关闭机会主义冒泡，只保留定时播报与工作汇报。
   *
   * ⚠️ **这个默认值 `false` 是个陷阱**：现网靠 `cordis.patch.yml` 那一行把它打开，
   * 而那一行丢过 —— 2026-10-08 崩溃对话框那个 "Disable third-party plugins"
   * 把 patch 从 52631 B 砍成 661 B ⇒ **小鲸鱼整个静默不工作**。
   * 2026-10-13 起 `qq-gugu.toml` 的 `[proactive]` 里也显式写了 `enabled = true` 兜底。
   */
  proactive: {
    enabled: false,
    minIntervalMs: 90_000,
    maxPerHour: 6,
    cooldownAfterBotMs: 20_000,
    /**
     * 累计多少条人类消息后才允许**第一次**冒泡。
     *
     * **本部署设为 0（关闭预热）** —— 用户 2026-10-02 明确要求「先把 3 条的限制关了」。
     * 0 表示立刻放行（引擎里判的是 `userMessages < 该值`，`0 < 0` 永不成立）。
     *
     * 关掉之后，"要不要说话"完全由打分决定。
     * ⚠️ **2026-10-13 更新**：阈值已从 16/24 改成 **50**，而且打分整条换成了拟合权重
     * （见 `heuristic-gauge.mjs` 的 `defaultGaugeConfig` 与 `_qq-judge\SPEC-plan3-landing.md`）。
     * **⇒ 别再用这里从前那句"单条闲聊约 4.5 分"来估算门槛** —— 那套量纲已经对不上了。
     */
    afterUserMsgCount: 0,
    /**
     * ⚠️ 下面两组键是**已废弃的空壳**（2026-10-07 闸门删除，见 `proactive/engine.mjs`）：
     *
     * - `quietHoursStart` / `quietHoursEnd` / `utcOffsetMinutes`（静默时段）
     * - `burstWindowMs` / `burstMinMessages`（突发门槛）
     *
     * 保留是因为本部署的 `qq-gugu.toml` 与 `cordis.patch.yml` 里还写着它们，
     * 而本次改动的约定是**不碰那两个文件**（toml 只改一行 `focusWindowMs`）。
     * **写了不生效**——别再照它们调参，那是浪费时间。
     */
    quietHoursStart: null,
    quietHoursEnd: null,
    utcOffsetMinutes: 480,
    burstWindowMs: 300_000,
    burstMinMessages: 4,
    /**
     * 「说不说」的**裁量模式**（画布上的三种，2026-10-13 落地模式 2/3）。
     *
     * | 值 | 行为 | 模型调用 |
     * |---|---|---|
     * | `"heuristic"`（**默认**） | 分数 ≥ 阈值 ⇒ 直接说（= 一直以来的行为） | 0 |
     * | `"precheck"` | 过阈值后**先问一次轻量模型**，它说「该」才进 agent | 每条过阈值的消息 1 次 |
     * | `"inTurn"` | 照常进 agent，但把**总分当"倾向"**塞进提示词，由它自己拍板 | 0（多一点点提示词） |
     *
     * ⚠️ **默认值必须与"没配"逐字一致**：`heuristic` 就是现状，三种模式
     * **共用同一条闸门（`engine.#gate`）和同一份打分（`heuristic-gauge`）** ——
     * 它只改"过了闸门之后由谁拍板"（见 `src/dsh/judge-mode.mjs` 的文件头）。
     * 写不认识的值 ⇒ **回落到 `heuristic`**（fail-safe，不是报错）：这个键在用户手改的 toml 里。
     *
     * ⚠️ **为什么放在 `proactive` 而不是 `gauge`**：
     * ① 画布与设计账本（`shared\2026-10-06-小鲸鱼判定层改造-设计账本-session-00000000.md`
     * §三）都把它写在 `[proactive]` 段；② 它是**闸门之后的裁量**，不是打分权重；
     * ③ `CONFIG_SHAPE.gauge` 会**覆盖** `defaultGaugeConfig()`（那里写错过两次，
     * 32→26、26→16），不往那一层再塞新东西。
     */
    judge_mode: 'heuristic',
    /**
     * **仅 `precheck`**：预检走哪个模型。
     *
     * 两种写法（`provider` 可省，省了就沿用主配置的 `provider`）：
     *
     * ```toml
     * precheck_model = "deepseek-flash"                   # 沿用主 provider
     * precheck_model = "local-llamacpp/qwen3.5-4b-q4km"   # 显式 provider/model
     * ```
     *
     * 留空 = **没有预检模型** ⇒ 每次预检都降级成「该说」，并打一条 warn 说明
     * （等价模式 1 —— 不会静默哑掉）。
     *
     * ⚠️ 这一次调用是**一次性的、没有上下文**（用户 2026-10-13 明确约束）：
     * 转录 / 当前这条消息 / 总分与分项都要塞进那一次请求的提示词，见
     * `buildPrecheckPrompt()`。所以**别把它指到一个需要长上下文才判得准的模型上**。
     */
    precheck_model: '',
    /**
     * **仅 `precheck` 且只在用 `provider/model` 写法时才需要**：
     * 已注册的 provider 名单，用来判断 `precheck_model` 里 `a/b` 的 `a` 到底是
     * provider 还是模型名的一部分。
     *
     * ⚠️ **不在画布的键名里**（画布只有 `judge_mode` / `precheck_model` / `decline_bonus`），
     * 这是实现补的一个可选口子：留空时 `a/b` **整体当模型名**，provider 沿用主配置
     * —— 那对本部署（`precheck_model` 写裸模型名，如 `deepseek-flash`）是**正确**的。
     * 只有当你想写 `local-llamacpp/qwen3.5-4b-q4km` 这种"显式别的 provider"时，
     * 才需要把 `local-llamacpp` 列进来（`cordis.patch.yml` 的
     * `llm-pi-ai.providers.*` 键名）。
     *
     * 为什么不把 provider 名单写死在代码里：它随部署漂移（换端点、加本地模型），
     * 写死的结果是"配了本地预检却静默走了云"。
     */
    knownProviders: [],
    /**
     * **「攒劲儿」步长**：每次"判定了但她没说"（限流后）给下一条被判定的消息加多少分。
     *
     * ## 2026-10-14 从"未实现的占位"变成真的实现了
     *
     * 先前的注释写着「🔴 **未实现 —— 待用户确认**」，因为**它加在哪一层当时没定**
     * （账本 §4.2 未决项第 2 条原话：「`decline_bonus` 的 +3 加在哪一层 ——
     * 加在打分的 `content`？还是一个能影响**闸门**的"欠账"？现在图上看不出来」）。
     *
     * **现在那个悬案结掉了：加在打分那一层的 `raw` 上、参与 `>= threshold` 判定**
     * （不是"闸门欠账"）。理由：闸门只回答"允不允许说话"（准入/配额/冷却/间隔），
     * 往里塞一个"欠账"会变成**第二个阈值**；而攒劲儿本质是"这话题的分被时间抬高了"，
     * 属于打分。实现见 `heuristic-gauge.mjs` 的 `request.declineBonus`
     * 与 `proactive/engine.mjs` 的 `declineBonus()` / `noteDecline()`。
     *
     * ⚠️ **⚠️ 与账本原文的一处分歧（故意的）**：账本写「判『不说』后，**下一条**消息补」，
     * 那是**单次平移**（每条都否决 = 恒定 +3，治不了死锁）；用户 2026-10-14 要的是
     * **累积**（否决 N 次 ⇒ +N×step ⇒ 保证最终开口）。⇒ **按累积实现**。
     *
     * ⚠️ 另外两个配套键 `decline_bonus_cap` / `decline_bonus_min_gap_ms` 的默认值在
     * `defaultTriggerConfig()`（`src/proactive/engine.mjs`）—— 这里**不重复写**，
     * 避免又一处"两个真源打架"（`CONFIG_SHAPE` 覆盖默认值那类坑，见下面 `gauge` 段）。
     */
    decline_bonus: 6,
    /**
     * 攒劲儿的**封顶**（分）。**必须 ≥ 判定阈值（默认 50）**，否则"最终必然开口"
     * 不成立（内容项触地板时非被点名消息的上界 < 50）。默认 60。
     */
    decline_bonus_cap: 60,
    /**
     * 计数的**限流间隔**（毫秒）：距上次计数至少这么久才 +1。
     *
     * 不这么写的话"每条消息 +1"⇒ 群里刷屏时计数瞬间拉满 ⇒ **她一被刷屏就开口**
     * （把"防刷屏"做成了"刷屏触发器"）。默认 30 秒，标定见 `_qq-judge/DECLINE-BONUS.md`。
     */
    decline_bonus_min_gap_ms: 30_000,
  },
  /**
   * 回复必要性打分（决定机会主义冒泡说不说）。
   *
   * ## ⚠️ 这一层会**覆盖** `defaultGaugeConfig()`
   *
   * 合并顺序是 `defaultGaugeConfig() ← CONFIG_SHAPE.gauge ← 用户配置`，
   * 中间这层优先级更高。所以在校准过的权重（阈值、压力曲线、**兜底模板**）上
   * 重复写一份默认值，等于把 `heuristic-gauge.mjs` 里的校准结果顶掉 ——
   * 这个坑踩过两次（第一次 `threshold: 32` 顶掉 26，第二次 `threshold: 26`
   * 顶掉 16，连 `templates` 都被顶回旧文案）。
   *
   * 所以这里**只放真正想让用户能一眼看到的开关**，凡是需要与
   * `defaultGaugeConfig()` 保持同步的数值一律不重复写。
   * 要改默认值就改 `heuristic-gauge.mjs`，那一处是真源。
   *
   * 回归测试：`test/index.test.mjs` 的「gauge 校准值不被 CONFIG_SHAPE 顶掉」。
   */
  gauge: {
    enabled: true,
    /** 判定窗口：看最近多少条消息。 */
    lookback: 8,
    /**
     * 频率倍率（**纯倍率**：`final = raw × frequency`，0–1）。越小越沉默。
     *
     * 2026-10-07 从 `0.5`（旧公式 `0.5 + 0.5×frequency` = 固定 0.75）改成 `1`。
     * ⚠️ 这个字段**必须和 `defaultGaugeConfig()` 保持一致** —— 这一层的优先级
     * 高于真源（见下面的警告），写错就等于把校准结果顶掉。
     */
    frequency: 1,
    /**
     * 语言层（小鲸鱼）：插话的**措辞**交给挂着 persona 的会话生成，
     * 而不是用兜底模板。对应 MaiBot 的 BrainChatting / HeartFChatting 分离。
     *
     * 用户原话：「聊天的方向把控之类的可以靠你，具体怎么聊让小鲸鱼干，这样能增加人格的一致性」
     *
     * **本部署已打开**：判定链和发送链都在真机跑通了，模板文案在真实聊天里
     * 显得很傻（用户实测：「小鲸鱼在不在」→「诶这个我知道」）。所以让小鲸鱼自己措辞。
     * 失败/超时仍会退回 `defaultGaugeConfig().templates`，不会把插话弄丢。
     */
    languageLayer: true,
    /** 语言层超时（毫秒）。超了就退回兜底模板。 */
    languageLayerTimeoutMs: 20000,
  },
  /** 会话空闲释放（小时）。会话本身已持久化，释放后能 resume 回来。 */
  sessionIdleEvictHours: 12,
  /**
   * 机器人自己的名字与别名 —— 用户在群里用**文字**喊的名字。
   *
   * 命中即给 gauge 的 `nameMentioned` 加 +45 相关分（真正的 @ 是 +60，另有一路）。
   * 默认值取自用户的旧 MaiBot 配置（`bot_config.toml` 的 `nickname` /
   * `alias_names`），所以是**他自己的叫法**，不是我瞎编的。
   *
   * 为什么要它：实测用户在测试群连发「小鲸鱼在不在」「小鲸鱼？」都沉默 ——
   * 因为引擎从没把"名字被叫到"这件事告诉 gauge。
   */
  botNames: ['小鲸鱼', '鲸鱼', '小鲸'],
  /** 工作完成汇报：把工作会话的进度同步到指定 QQ 会话。 */
  /**
   * 工作汇报（**只在该喊的时候喊**）。
   *
   * 设计原则来自用户：人就在电脑前时，DSH 界面本身看得见进度，往 QQ 推汇报是噪音。
   * 所以默认**不汇报普通完成**，只在两种真需要他的情况下出声：
   *
   *  1. 任务**卡住等他**（`blocked` / 出错）且已经等了一段时间
   *     —— 他可能在忙别的、或不在电脑前，卡住会一直卡住；
   *  2. 他明确说了要出门（`awayMode`）时的完成汇报。
   *
   * 而且**不挂计时器**：检查时机借聊天子会话的轮次驱动
   * （QQ 群不缺消息，天然有心跳），避免为汇报单独跑一个定时器。
   */
  report: {
    enabled: false,
    /** 目标 QQ 会话，形如 private:123456 或 group:123456。 */
    target: '',
    /** 最短汇报间隔（分钟），避免长任务期间刷屏。按会话分别记账。 */
    minIntervalMinutes: 10,
    /** 汇报整段字符上限。 */
    maxChars: 600,
    /**
     * 只有"卡住等用户"时才出声。这是默认行为。
     * 设 false 则退化成旧的"每轮完成都汇报"。
     */
    onlyWhenBlocked: true,
    /**
     * 卡住后至少等多少分钟才喊。
     * 用户原话：「过了好几个小时一直挂着就等我点确定的时候喊我」——
     * 所以默认 90 分钟，避免刚阻塞就催。
     */
    waitingNotifyAfterMinutes: 90,
    /**
     * 出门模式：为 true 时普通完成也会汇报。
     * 用户原话：「我出去的时候喊我」。由聊天侧或用户在设置页开关。
     */
    awayMode: false,
  },
  /**
   * 临时配置服务想绑的**固定端口**（2026-10-29）。
   *
   * ## 为什么需要它
   *
   * 配置页的前端会自己重连：断开就每 1.5 秒轮询同一个 origin，最多 30 秒。
   * 但插件热重载会 dispose 整个插件，如果端口是 `listen(0)` 随机的，新实例
   * 落到另一个端口，页面那层重连永远够不着（30 秒后放弃）。
   *
   * ⇒ 端口固定 + 令牌持久化（见 `config-server.mjs` 头部），页面在重载后能**原地接回**。
   * 端口被占时自动回退随机端口，并记一条 warn（页面需要重新打开）。
   *
   * `0` = 关掉固定端口（回到"每次随机"的旧行为）；默认 `19390` 是挑的一个
   * 不常见的端口，避免撞上常见的开发服务器（3000 / 5173 / 8080 …）。
   *
   * ⚠️ 它与上面的 `port` **不是一回事**：`port` 是 OneBot 反向 WS 的监听端口。
   */
  configPagePort: 19390,
};

/** 暴露配置形状给测试与文档用——它**不是** Cordis 的 Config 导出。 */
export const configShape = CONFIG_SHAPE;

/**
 * 合并并校验配置。非法值应当明确报错，而不是带着错配置跑。
 * @param {object} raw
 * @returns {object}
 */
export function resolveConfig(raw = {}) {
  const merged = {
    ...defaultConfig(),
    ...CONFIG_SHAPE,
    ...raw,
    proactive: { ...defaultTriggerConfig(), ...CONFIG_SHAPE.proactive, ...(raw.proactive ?? {}) },
    gauge: { ...defaultGaugeConfig(), ...CONFIG_SHAPE.gauge, ...(raw.gauge ?? {}) },
    report: { ...CONFIG_SHAPE.report, ...(raw.report ?? {}) },
  };

  if (merged.mode !== 'reverse' && merged.mode !== 'forward' && merged.mode !== 'http') {
    throw new Error(
      `qq-proactive: mode 必须是 reverse / forward / http，得到 ${JSON.stringify(merged.mode)}`,
    );
  }
  // 图片描述模式：**只认三个值，拼错就报错**。
  //
  // 刻意不"非法值悄悄退化成默认" —— 这个项目反复栽在**静默不生效**上
  // （配置写了、计数正常、就是什么都没发生）。写错一个字母要当场炸，
  // 而不是让人对着"小鲸鱼还是只看到 `[图片]`"查半天。
  if (merged.imageDescription !== 'forward' && merged.imageDescription !== 'all' && merged.imageDescription !== 'off') {
    throw new Error(
      `qq-proactive: imageDescription 必须是 forward / all / off，得到 ${JSON.stringify(merged.imageDescription)}`,
    );
  }
  // 配置页的固定端口：`0` 合法（= 关掉固定端口，每次随机）。
  //
  // 写错（负数 / 小数 / 超出范围 / 不是数字）**当场报错**：静默退化成随机端口的话，
  // 表现就是"重载后页面接不回来"—— 正是这个配置项要修的东西，不该再静默一次。
  {
    const configPagePort = Number(merged.configPagePort);
    if (!Number.isInteger(configPagePort) || configPagePort < 0 || configPagePort > 65535) {
      throw new Error(
        `qq-proactive: configPagePort 必须是 0–65535 的整数（0 = 每次随机），得到 ${JSON.stringify(merged.configPagePort)}`,
      );
    }
    merged.configPagePort = configPagePort;
  }
  // 本地原件目录模板：**只认字符串数组**。
  //
  // 写错了（比如写成一个字符串）会静默变成"逐字符遍历"—— 于是本地查找永远落空，
  // 而日志里只有一句"没找到"。这个项目反复栽在**静默不生效**上，所以这里当场报错。
  if (!Array.isArray(merged.imageOriginalDirs)
    || merged.imageOriginalDirs.some((d) => typeof d !== 'string')) {
    throw new Error(
      `qq-proactive: imageOriginalDirs 必须是字符串数组（目录模板，可用 {qq} / {yyyy-mm} / *），得到 ${JSON.stringify(merged.imageOriginalDirs)}`,
    );
  }
  if (typeof merged.imageDescCachePath !== 'string') {
    throw new Error(
      `qq-proactive: imageDescCachePath 必须是字符串（留空 = 关掉缓存表），得到 ${JSON.stringify(merged.imageDescCachePath)}`,
    );
  }
  // 昵称表路径：**只认字符串**（同 imageDescCachePath —— 写错类型会静默变成
  // "什么都不记"，而这个项目反复栽在**静默不生效**上）。
  if (typeof merged.nicknameTablePath !== 'string') {
    throw new Error(
      `qq-proactive: nicknameTablePath 必须是字符串（留空 = 关掉昵称表，@ 会退回 @QQ号），得到 ${JSON.stringify(merged.nicknameTablePath)}`,
    );
  }
  // 群名缓存路径：同样**只认字符串**（留空 = 关掉缓存，配置页显示号码）。
  if (typeof merged.groupNameTablePath !== 'string') {
    throw new Error(
      `qq-proactive: groupNameTablePath 必须是字符串（留空 = 关掉群名缓存，配置页显示号码），得到 ${JSON.stringify(merged.groupNameTablePath)}`,
    );
  }
  // 表情包库的两个路径：**只认字符串**（同 imageOriginalDirs 的理由 ——
  // 写错类型会静默变成"什么都不做"，而这个项目反复栽在**静默不生效**上）。
  if (typeof merged.stickerDir !== 'string') {
    throw new Error(
      `qq-proactive: stickerDir 必须是字符串（留空 = 关掉"偷表情包"），得到 ${JSON.stringify(merged.stickerDir)}`,
    );
  }
  if (typeof merged.stickerIndexPath !== 'string') {
    throw new Error(
      `qq-proactive: stickerIndexPath 必须是字符串（留空 = 关掉索引表），得到 ${JSON.stringify(merged.stickerIndexPath)}`,
    );
  }
  if (merged.mode === 'reverse') {
    if (typeof merged.accessToken !== 'string' || merged.accessToken === '') {
      throw new Error(
        'qq-proactive: 反向模式必须配置 accessToken。空 token 的监听端口会让同网段任何人都能控制这个 QQ 号。',
      );
    }
    const port = Number(merged.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`qq-proactive: port 非法：${JSON.stringify(merged.port)}`);
    }
  } else if (merged.mode === 'forward') {
    if (typeof merged.url !== 'string' || !/^wss?:\/\//.test(merged.url)) {
      throw new Error(`qq-proactive: 正向模式需要合法的 ws:// 或 wss:// 地址，得到 ${JSON.stringify(merged.url)}`);
    }
  } else {
    // http 模式：只发不收。
    // 用于与 dsh-onebot-qq 共存 —— 它要独占反向 WS 端口（NapCat 只拨一条连接），
    // 所以本项目改走 NapCat 的另一条通道（HTTP API），两条并存、互不干扰。
    if (typeof merged.httpUrl !== 'string' || !/^https?:\/\//.test(merged.httpUrl)) {
      throw new Error(
        `qq-proactive: http 模式需要合法的 http:// 或 https:// 地址（NapCat 的 HTTP API），得到 ${JSON.stringify(merged.httpUrl)}`,
      );
    }
  }
  if (merged.report.enabled) {
    const target = String(merged.report.target ?? '');
    // ⚠️ **2026-10-24（P0-2）：启动路径只许用纯函数校验，绝不许查表。**
    //
    // 以前这里拿 `sessionKeyFromChatId(target) === ''` 当格式校验器。等映射表落地
    // （迁移清单 §3 #8），那个函数会变成"查表优先" —— 表里没有这条 chatId
    // （新装 / 清状态后首启 / 换了部署）就会抛 ⇒ 插件 apply 失败 ⇒ **整个 App 起不来**
    // （2026-10-14 连崩三次、patch 被砍成 661 B 的形状）。
    // ⇒ 格式对不对，用 `parseChatId()`（纯字符串）；映射有没有，将来只 warn。
    if (parseChatId(target) === null) {
      throw new Error(
        `qq-proactive: report.enabled 为真时必须配 report.target，形如 group:123456，得到 ${JSON.stringify(target)}`,
      );
    }
  }
  // **所有"读 toml 的段"共用这一个路径**（2026-10-21 线上事故）。
  //
  // 以前这里没填 `tomlPath` → 只有 `loadFreeTimeConfig()` / `loadLearnedMemoryConfig()`
  // / `loadRelayConfig()` / `loadSendConfig()` / `loadMoodConfig()` 那几个自己写了
  // `config?.tomlPath ?? defaultTomlPath()` 兜着；而后加的
  // **`loadPersonaSections()` 与 `loadOwnerConfig()` 只认 `config.tomlPath`**
  // （它们的约定是"回退由 index.mjs 负责"，见 owner.mjs 里的注释）
  // ⇒ 这两个拿到空串 ⇒ **静默按"没有 toml"处理**：
  //   `/settings` 的 `effective.personality` 五段恒为空、配置页每条都打红字
  //   「未生效（重载后生效）」，哪怕用户一个字节都没改；`snapshot.owner` 也恒为回退值。
  //
  // ⇒ 定成一次：**路径只在这里定，loader 只管读**。新加读 toml 的段只要走
  //   `config.tomlPath` 就自动对，别再各自实现一遍回退（"每段一套"正是这个 bug 的温床）。
  merged.tomlPath = String(raw?.tomlPath ?? defaultTomlPath());
  return merged;
}

/**
 * 插件主体。
 * @param {any} ctx Cordis 上下文
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  // 人格在下面（`personaSections` 加载之后）从**同一份** sections 拼出来 ——
  // 见 `loadPersona(config, personaSections)` 那段注释。
  // 情绪特点（作动态心情的底色，用户会自己改）。
  const emotionStyle = loadEmotionStyle(config);
  // 知识库：从 MaiBot.db 导出的 JSON 加载。读不到就空库，不影响插件。
  // 动态学来的记忆单独存 learned-memory.json，启动时重放、学习后回写（重启不丢）。
  //
  // ⚠️ 2026-10-05 挪位置：这两个文件原来躺在 `<maibot>\`（MaiBot 的导出目录）。
  // 用户指出它们**是我们自己的数据、而且是所有会话共用的**，不该放在别人的地盘里 ——
  // 于是搬到工作区的 `shared/`（跨会话共享目录）。
  //
  // 路径支持环境变量覆盖（和收件箱那两个一致）—— 以后再挪位置不用改代码。
  const sharedDir = process.env.QQ_SHARED_DIR
    ?? '<workspace>\\shared';
  // 注意：此处 `log` 尚未初始化（apply 末尾才定义），迁移日志传空实现，
  // 否则首次启动迁移会触发 TDZ（Cannot access 'log' before initialization）。
  const learnedPath = resolveStatePath({
    name: 'learned-memory.json',
    envVar: 'QQ_LEARNED_PATH',
    legacy: [path.join(sharedDir, 'learned-memory.json')],
    log: () => {},
  });
  // 「学来的记忆」（旧记忆库）的总开关 —— 在 toml 的 `[memory] learned_enabled`。
  //
  // ⚠️ **它只关"学来的"那一半**：静态知识库 `knowledge.json` 照旧加载、照旧注入
  //    （用户明确说过「那是知识库不是记忆，别砍」）。两条路的区分见
  //    {@link loadLearnedMemoryConfig} 那段表 —— 干净分开靠的是**两条写入路径**，
  //    不靠给每条数据打标记（`personInfo` 里一个 learned 标记都没有）。
  const memoryCfg = loadLearnedMemoryConfig(config);
  // 定时任务（`[free_time]`）的**生效值**。⚠️ 默认 `enabled:false`：这是新行为，
  // 没配就不该跑。本轮只负责"读到 + 进快照 + 设置页能改"，**定时器还没接**
  // （写进快照是为了让"toml 到底被读到了没有"有一份落盘证据）。
  const freeTimeCfg = loadFreeTimeConfig(config);
  // 「她自己的时间」实例稍后才造（要 gateway）。这里先占位：
  // 快照闭包可能在构造完成之前被调一次，直接用 `const freeTime` 会撞 TDZ。
  const freeTimeRef = { current: null };
  // 2026-10-18：`[send] rule` —— 她"往 QQ 发东西"的规矩，独立一段。
  const sendCfg = loadSendConfig(config);
  // 2026-10-25（B4 真答案）：`[voice]` —— 语音转文字（本地 faster-whisper）。
  // ⚠️ 这里只读配置；**构造转写器要等 `log` 就绪之后**（下面 `makeLogger` 那段）。
  const voiceCfg = loadVoiceConfig(config);

  let knowledge = null;
  try {
    const configuredKb = String(config?.knowledgePath ?? '').trim();
    const kbPath = configuredKb !== '' ? configuredKb : `${sharedDir}\\knowledge.json`;
    if (fs.existsSync(kbPath)) {
      knowledge = KnowledgeBase.load(kbPath, { readFileSync: (p, e) => fs.readFileSync(p, e) });
      // 重放之前学来的记忆。
      //
      // ⚠️ 这一段**只有**在关着时才不发生 —— 也就是"`personInfo` 里学来的条目"
      // 唯一的**跨重启**入口就在这两行。把它跳掉，库里剩下的就只是
      // `knowledge.json` 的内容（`remember()` 的另一条调用点在 learner 那条路上，
      // 而 learner 关掉时压根不会构造）。
      if (memoryCfg.learnedEnabled && fs.existsSync(learnedPath)) {
        const learned = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
        if (Array.isArray(learned)) {
          for (const item of learned) {
            if (item !== null && typeof item === 'object' && item.user_id && item.fact) {
              knowledge.remember(item.user_id, item.fact);
            }
          }
        }
      }
    }
  } catch {
    knowledge = null;
  }

  // 学习后回写记忆（防抖：合并到下一次写入，避免每学一条都落盘）。
  //
  // ⚠️ `null` = **没有回写这条路**（`learned_enabled = false`）。关掉时
  //    `onLearned` 传下去的是 `null`，`binding.mjs` 自己会判空 ⇒ 一行都不写。
  //    **老文件不删**（用户没让删）—— 只是不再写。
  let saveLearnedTimer = null;
  const saveLearned = memoryCfg.learnedEnabled
    ? (learned) => {
      if (saveLearnedTimer !== null) return;
      saveLearnedTimer = setTimeout(() => {
        saveLearnedTimer = null;
        try {
          fs.writeFileSync(learnedPath, JSON.stringify(learned, null, 2), 'utf8');
        } catch {
          /* 写盘失败不致命 */
        }
      }, 2000);
    }
    : null;

  const liveConfig = config;
  const log = makeLogger(ctx);
  // ===== 语音转文字（B4 真答案，2026-10-25）=====
  //
  // ⚠️ **必须放在 `log` 之后**：转写器在构造时会为"配置了但路径不对"打 warn
  // （`createVoiceTranscriber` 里那三条），而 `log` 在 951 行才就绪。
  // 放到前面写会踩 **TDZ**（`ReferenceError: Cannot access 'log' before initialization`），
  // 那是**插件加载期**的异常 ⇒ DSH 判定插件失败，可能直接崩宿主。
  //
  // 它只读配置、不 spawn 任何东西；python 进程按需起（见 `voice.mjs`）。
  const voiceTranscriber = createVoiceTranscriber({
    enabled: voiceCfg.enabled,
    pythonPath: voiceCfg.python,
    scriptPath: voiceCfg.script,
    modelPath: voiceCfg.model,
    device: voiceCfg.device,
    language: voiceCfg.language,
    timeoutMs: voiceCfg.timeoutMs,
    cachePath: voiceCfg.cachePath,
    // 引擎：`auto`（先问 QQ 自己的 fetch_ptt_text，失败再走 whisper）/ `ntqq` / `whisper`。
    engine: voiceCfg.engine,
    // 🔴 默认放**工作区**下的临时目录，不是 `<DSH_HOME>`（那棵树对子进程只读）。
    // 2026-10-25 实线事故：python 写结果 JSON 拿到 `Permission denied`，转写整条失败。
    tempDir: voiceCfg.tempDir || `${sharedDir}\\tmp\\qq-voice`,
    log,
  });

  // ===== 文字转语音（出站，2026-10-26）=====
  //
  // `[tts]` 只读配置；合成器同样只"准备"、python 进程按需起（见 `tts.mjs`）。
  // ⚠️ 这里同样**必须在 `log` 之后**（理由同 `voiceTranscriber`：构造期会打 warn/TDZ）。
  // ⚠️ 缓存目录默认落**工作区**（`<工作区>\shared\tmp\qq-tts`）——
  //    `<DSH_HOME>` 对 spawn 出去的 python 是只读的（2026-10-25 那个坑）。
  const ttsCfg = loadTtsConfig(config);
  const ttsSpeaker = createTtsSpeaker({
    enabled: ttsCfg.enabled,
    pythonPath: ttsCfg.python,
    scriptPath: ttsCfg.script,
    voice: ttsCfg.voice,
    rate: ttsCfg.rate,
    pitch: ttsCfg.pitch,
    maxChars: ttsCfg.maxChars,
    cacheDir: ttsCfg.cacheDir || `${sharedDir}\\tmp\\qq-tts`,
    timeoutMs: ttsCfg.timeoutMs,
    log,
  });
  // 群聊让不让、两次之间隔多久：这两个是**网关**要判的，挂在对象上带过去
  //（不另加构造参数 —— 合成器是"怎么合成"，网关是"发不发、发到哪"）。
  ttsSpeaker.allowGroups = ttsCfg.allowGroups;
  ttsSpeaker.minGapMs = ttsCfg.minGapMs;

  // ===== 语音情绪旁路（wav2small，2026-10-26）=====
  //
  // 只算 **arousal**、只记录、**不进提示词**（用户拍板的第一版）。
  // 同样"只准备、不 spawn"：python 进程按需起（`emotion.mjs`），静音/过短在**import torch
  // 之前**就被门限挡掉。
  // ⚠️ 临时 JSON 落**工作区**（`<工作区>\shared\tmp\qq-emotion`）—— spawn 出去的 python
  //    对 `<DSH_HOME>` 是只读的（`voice.mjs` 2026-10-25 那个坑）。
  const emotionCfg = loadEmotionConfig(config);
  const emotionSenser = createEmotionSenser({
    enabled: emotionCfg.enabled,
    pythonPath: emotionCfg.python,
    scriptPath: emotionCfg.script,
    modelDir: emotionCfg.modelDir,
    arousalHigh: emotionCfg.arousalHigh,
    minSeconds: emotionCfg.minSeconds,
    minRms: emotionCfg.minRms,
    timeoutMs: emotionCfg.timeoutMs,
    tempDir: emotionCfg.cacheDir || `${sharedDir}\\tmp\\qq-emotion`,
    log,
  });

  // 会话映射表（2026-10-24，P1-3/P1-4）。
  //
  // 这是"QQ 聊天 ↔ DSH 会话 id"的唯一真相：`lookup` 纯读、`ensure` 才分配新 id。
  // **这一版只读 + 顺手记录**（把当前实际在用的旧 id 落进表），所以行为零变化；
  // 换成 `session-<uuid>` 是下一步（P2-6，开关在 resolver 里加分支）。
  //
  // 路径默认 `<DSH_HOME>/media/qq-chat-sessions.json`；测试用 env 覆盖
  // （`QQ_SESSION_MAP_FILE` / `QQ_SESSION_RETIRED_FILE`），不往真 media 目录写。
  //
  // ⚠️ **没有 DSH_HOME（测试进程）时 `persist: false`**：纯内存、不碰盘。
  //    否则跑测试会去读/写真的 `<DSH_HOME>\media\qq-chat-sessions.json`，
  //    测试之间还会互相污染（真机上那张表这时已经有内容了）。
  const sessionStateEnabled = String(process.env.DSH_HOME ?? '').trim() !== ''
    || String(process.env.QQ_SESSION_MAP_FILE ?? '').trim() !== '';
  const sessionMap = createSessionMap({
    mappingFile: process.env.QQ_SESSION_MAP_FILE ?? undefined,
    retiredFile: process.env.QQ_SESSION_RETIRED_FILE ?? undefined,
    log,
    persist: sessionStateEnabled,
  });
  const sessionResolver = createSessionResolver({
    map: sessionMap,
    // 策略：默认 `new-if-no-legacy`（用户 2026-10-24 拍板）；配置或 env 可回滚成 legacy。
    policy: String(process.env.QQ_SESSION_ID_POLICY ?? '').trim()
      || String(config.sessionIdPolicy ?? '').trim()
      || 'new-if-no-legacy',
    log,
  });

  // 「学来的记忆」的开关状态在**挂载时**留一行痕（照上面 `动态心情已启用/已关闭` 的风格）。
  //
  // 为什么这一行不能省：关掉之后**现象就是"什么都没发生"**（不再学到新东西、
  // prompt 里不再出现学来的条目），而"没关掉、但恰好没学到东西"看上去一模一样。
  // 留痕之后，"这一轮到底学不学"第一眼就有答案；另一半取证在快照的 `learnedMemory` 段。
  //
  // ⚠️ **位置有讲究**：它必须在 `makeLogger` **之后**。第一版写在前面，真跑出来
  //    `ReferenceError: Cannot access 'log' before initialization` ——
  //    而 `apply()` 抛错会被宿主判成**插件加载失败**（最贵的一类事故），所以别往上挪。
  log(
    'info',
    memoryCfg.learnedEnabled
      ? '学来的记忆已启用（[memory] learned_enabled 没写或为 true）'
      : '学来的记忆：已关闭（[memory] learned_enabled = false）—— 静态知识库照旧',
    { learnedEnabled: memoryCfg.learnedEnabled, learnedPath },
  );

  // `[owner] admins`（2026-10-21）：用户从"白名单第一个"改成"显式声明优先"。
  //
  // ⚠️ 位置有讲究：它要用 `log`，所以必须在 `makeLogger` 之后（上面那段注释记的
  //    `Cannot access 'log' before initialization` 是同一个坑）。
  const ownerCfg = loadOwnerConfig(config, log);
  // 人格的按会话覆盖层（2026-10-21）。挂载时读一次：改 toml 之后要点「重载插件」
  // 才会重建 —— 与 `/config` 一律回 `restartNeeded: true` 是同一套语义。
  const personaSections = loadPersonaSections(config, log);
  log('info', '人格覆盖层已加载', {
    // 只记"哪些会话有覆盖 / 覆盖了哪些字段" —— 不记人格正文（可能很长且是私人内容）。
    groups: Object.keys(personaSections.groups).length,
    privates: Object.keys(personaSections.privates).length,
  });
  // **全局人格从同一份 `personaSections` 拼出来**（2026-10-21）。
  //
  // 为什么不在这里再 `loadPersona(config)` 读一次 toml：那样提示词里用的那份
  // 与 `/settings` 的 `effective.personality` 是**两次独立解析**，只要有一条路径
  // 少给一个参数（这次的 `config.tomlPath`）就会各读各的 —— 配置页显示"没生效"，
  // 而她其实一直在用。现在**一次读取、一个对象**：`buildPersona`（提示词）、
  // `personaForSession`（按会话覆盖）、`/settings` 的 `effective` 全都看它。
  const persona = loadPersona(config, personaSections);
  // 2026-10-30：`[prompt]` 段（身份第一行 / 说话方式 / 每轮那几句固定话）。
  // 和人格一起在**建 agent 时**读一次；改完要重载才生效（与其它配置同一条规矩）。
  const promptCfg = loadPromptConfig(config, log);

  // 传输层。
  const transport = createTransport({
    mode: config.mode,
    host: config.host,
    port: config.port,
    url: config.url,
    httpUrl: config.httpUrl,
    accessToken: config.accessToken,
    botQQ: config.botQQ,
    reconnectMaxAttempts: config.reconnectMaxAttempts,
    actionTimeoutMs: config.actionTimeoutMs,
  });

  // 路由与访问控制。
  // `sessionLookup` **只传纯读**：`resolve()` 是每消息一次的判定路径，这里不许建 id。
  const router = new Router(config, { sessionLookup: (chatId) => sessionResolver.lookup(chatId) });

  // 学习器：私聊被动回复后，从对话提炼事实入库（知识库"学习"能力）。
  //
  // ⚠️ `learned_enabled = false` ⇒ **不构造**（照 `mood` 那条：关掉要能一键止血，
  //    构造出来再在里面判空等于那条路还挂着）。`binding.mjs` 两处都自带 `null` 守卫，
  //    所以"关掉"只要**不传**就够 —— 不用改 binding 的逻辑。
  const learner = memoryCfg.learnedEnabled
    ? createLearner({
      stream: (opts) => ctx.llm.stream(opts),
      provider: config.provider || 'deepseek-official',
      model: config.model || 'deepseek-flash',
      log,
    })
    : null;

  // 行为配置（人格、门槛、**群里禁哪些工具**）统一从 toml 读：
  // **toml 的通配段覆盖 cordis 配置，toml 的 groups 段按会话覆盖**。
  //
  // 分层顺序（用户要的"通配 + 指定群特殊规则"）：
  //   toml [proactive]           ← 通配，盖过 cordis.patch.yml 里的默认值
  //   toml [proactive.groups.X]  ← 只对那个会话生效
  //   代码里的 defaultTriggerConfig()  ← 最后的兜底
  //
  // 为什么不直接用 cordis 配置做全局：`cordis.patch.yml` 是**加载配置**
  // （装哪些插件、什么模式、白名单），TOML 才是**行为配置**（人格、门槛）。
  // 调一个人的脾气不该去改启动文件。
  //
  // ⚠️ 读得比引擎早：下面的**会话绑定层**也要用同一段 —— 群会话禁哪些工具
  // 就是从 `[proactive]` 读的，而 binder 建得比引擎早。所以这里读一次、
  // 两处共用（不是每处各读一遍 toml）。
  const proactiveToml = loadProactiveConfig(config);
  if (Object.keys(proactiveToml.overrides).length > 0) {
    log('info', '主动发言会话覆盖已加载', { chats: Object.keys(proactiveToml.overrides) });
  }

  // 动态心情：拟人化的关键 —— 心情随对话演化，不写死在表面配置。
  //
  // ## 2026-10-14：从"跟着对话模型"改成**可配的独立模型**
  //
  // 用户指令：「心情更新改成云端的千问的小模型，找找 30b 左右的，接进去」。
  // 背景：它原来用的是**小鲸鱼对话那条路**（`config.provider/model` = deepseek-flash），
  // 而它在活跃群里约 **1.7 次调用/分钟** —— 烧的是对话模型的钱。
  //
  // ⚠️ **`reasoningEffort` 必须可配**，不能写死 `'off'`：`cordis.patch.yml` 里那条
  //   注释记着实测 —— 模型条目**不声明档位**时，适配器收到这个字段会直接抛
  //   `UNSUPPORTED_REASONING_EFFORT`。所以万一换的模型不接受 `off`，
  //   用户改 toml 一行就能换掉，**不用改代码**。
  //
  // ⚠️ **放在这里**（而不是文件上半部分"原来那两行"的位置）：默认值里那个
  //   `config.provider || …` 的兜底语义要原样保住，而 `loadMoodConfig` 是纯函数、
  //   放哪都一样；统一放在 `loadProactiveConfig` 旁边，读 toml 的两处挨着看得见。
  const moodCfg = loadMoodConfig(config);
  log('info', moodCfg.enabled ? '动态心情已启用' : '动态心情**已关闭**（[mood] enabled = false）', {
    provider: moodCfg.provider,
    model: moodCfg.model,
    reasoningEffort: moodCfg.reasoningEffort,
  });

  // 小鲸鱼的**推理等级**（2026-10-21）：`[agent] reasoning`，真源在 `qq-gugu.toml`。
  //
  // 在这之前它只写在 profile 的 `cordis.patch.yml`（`reasoningEffort: low`）——
  // 配置页看不到、也改不了。用户要求「插件应当有一个能改小鲸鱼推理等级的地方」。
  //
  // ⚠️ **缺省仍是 `low`**（= 改动前的行为）：toml 没写这一节时先看 patch 里那个旧值，
  //    再没有就 `low`。合法取值 `off/low/high/max` 与"非法值夹到默认 + warn"
  //    都在 `agent-config.mjs` 里（源码依据也写在那儿）。
  const agentCfg = loadAgentConfig(config, log);
  log('info', '小鲸鱼的推理等级', {
    reasoning: agentCfg.reasoning,
    source: agentCfg.source,
  });
  // `enabled = false` ⇒ **不构造**（于是下面每个调用点都拿不到它）。
  // 关掉要能"一键止血"：构造出来再在里面判空，等于那些路径还挂着。
  const mood = moodCfg.enabled
    ? createMood({
        stream: (opts) => ctx.llm.stream(opts),
        provider: moodCfg.provider,
        model: moodCfg.model,
        reasoningEffort: moodCfg.reasoningEffort,
        emotionStyle,
        names: config.botNames,
        // 2026-10-30：三段提示词（空串 ⇒ mood.mjs 里的默认原文）。
        systemPrompt: moodCfg.systemPrompt,
        updateNote: moodCfg.updateNote,
        regressNote: moodCfg.regressNote,
        // 2026-10-30：节奏（冷却 / 概率曲线 / 平复）。
        cooldownMinutes: moodCfg.cooldownMinutes,
        baseProb: moodCfg.updateBaseProb,
        rampPerMinute: moodCfg.updateRampPerMin,
        maxProb: moodCfg.updateMaxProb,
        regressAfterSeconds: moodCfg.regressAfterSeconds,
        regressMax: moodCfg.regressMax,
        log,
      })
    : null;

  // 心情取值器：`chatId → 一句心情`（没有就是空串）。**两个落点共用这一个**：
  //   · 【c】会话绑定层 —— 拼进 system prompt 的 persona 段（影响"怎么说话"）；
  //   · 【a】precheck —— 塞进那一次性的预检提示词（影响"说不说"）。
  // `mood === null`（`[mood] enabled=false`）时它恒返回空串 ⇒ 两处**都不加**（行为与接线前一致）。
  // ⚠️ 它是**纯读取**、且自己吞异常（见 `moodTextFor`）—— 两个落点都在关键路径上。
  const moodFor = (chatId) => moodTextFor(mood, chatId);

  // 群会话禁用的工具：toml > cordis 配置 > 代码默认（`binding.mjs` 里的 `['pwsh']`）。
  //
  // **默认值必须在代码里**，不能只写在 toml 里：用户环境那份 `qq-gugu.toml`
  // 不打算改动，所以"没写这个键"必须等于"默认禁 pwsh"。
  // 反过来，`deny_tools_in_group = []` 是**明确要求不限制**（留的退路）。
  const groupDenyTools = resolveGroupDenyTools(
    proactiveToml.config.deny_tools_in_group ?? config.denyToolsInGroup,
  );

  // 按需加载（2026-11-04）：哪些前缀的工具「不常驻」，模型要用时再 `load_tools`。
  //
  // 三态和 `deny_tools_in_group` 一样：**没配** → 代码默认（`DEFAULT_ON_DEMAND_PREFIXES`）；
  // `on_demand_tools = []` → 明确关掉整套按需加载（出问题时不用改代码）。
  const onDemandTools = proactiveToml.config.on_demand_tools ?? config.onDemandTools;

  // 群会话单独挂的 preset：**不配就按 `agentPreset` 推导**（`gugu` → `gugu-lite`）。
  //
  // 为什么群要单独一份：`tools.restrict()` 是 per-agent 的，**子会话不继承**，
  // 而 `dsh-subagent` 建子会话时继承的是**父的 preset** —— 所以"群里没有 shell"
  // 这件事只有让群会话挂的那份 preset 本身不含 shell 才算数。详见 `binding.mjs`
  // 的 `GROUP_PRESET_SUFFIX` / `groupToolBackstop`。
  //
  // ⚠️ 刻意**不进 `CONFIG_SHAPE`**：那一层会把"没配"物化成空串，而这里
  // `undefined`（推导 `-lite`）和 `''`（群跟私聊用同一份）是**两种不同意图**，
  // 必须分得开 —— 和 `denyToolsInGroup` 同一个坑。
  //
  // 也刻意**不从 toml 读**：这一条决定的是"挂哪些插件"，属于部署配置
  // （同一份理由见上面 `loadProactiveConfig` 那段：cordis 管装什么，toml 管脾气）。
  const groupAgentPreset = config.groupAgentPreset;

  // 会话绑定（唯一的 DSH 耦合点）。
  /** `send_qq` 的执行器（同样先空壳，gateway 后面才构造）。 */
  const sendToolRef = { fn: null };
  /** `look_sticker` 的执行器（同上；真正实现在 `gateway.lookFromTool`）。 */
  const lookToolRef = { fn: null };
  /** `send_voice` 的执行器（2026-10-26；真正实现在 `gateway.sendVoiceFromTool`）。 */
  const voiceToolRef = { fn: null };

  // 这几个工具执行器的**当前实例包装**：读 ref、不绑死某个 gateway 对象。
  //
  // 🔴 2026-10-20：这三个包装就是写进**跨插件热重载中转表**（`publishToolBridge`）的
  // 东西 —— agent 的 regs 挂在 root 上、HMR 后照样活着，旧注册的 `execute` 只会
  // 运行时查表；表里是**这一代实例**，换不掉。
  const sendExecutor = (args) => (typeof sendToolRef.fn === 'function'
    ? sendToolRef.fn(args)
    : Promise.resolve({ ok: false, sent: 0, note: '发 QQ 的通道没接上（插件刚启动？），这条没发出去。' }));
  const lookExecutor = (args) => (typeof lookToolRef.fn === 'function'
    ? lookToolRef.fn(args)
    : Promise.resolve({
      ok: false,
      md5: '',
      desc: '',
      tags: [],
      fromCache: false,
      note: '看表情包的通道没接上（插件刚启动？），这次没看成。',
    }));
  /**
   * `send_voice` 的执行器（2026-10-26）。形状必须和 `send_qq` 的输出一致
   * （`{ok, sent, note}`），工具那边只 render `note`。
   */
  const voiceExecutor = (args) => (typeof voiceToolRef.fn === 'function'
    ? voiceToolRef.fn(args)
    : Promise.resolve({ ok: false, sent: 0, note: '发语音的通道没接上（插件刚启动？），这条没发出去。' }));

  // 关系记账（2026-11-04，A+B 段）：网关写入、绑定读取，**同一个实例**。
  // 落盘 `QQ_RELATIONS_PATH` 或 `<DSH_HOME>/media/qq-relations.json`；写失败只 warn。
  const relationLedger = createRelationsLedger({ log });
  // 聊天回想（M1，2026-11-04）：被转录挤出去的那一段压成摘要 + 线索，下轮按需召回。
  const recallStore = createRecallStore({ log });
  // 转录落盘（M1b，2026-11-05）：每 20 秒把各会话转录写盘，重启读回来，不再只剩回填的 20 条。
  const transcriptStore = createTranscriptStore({ log });
  // 话题状态（M3，2026-11-05）：影子模式，只写盘与日志，不注入提示词。
  const topicStore = createTopicStore({ log });
  const binder = new SessionBinder({
    ctx,
    config,
    log,
    persona,
    knowledge,
    relations: relationLedger,
    // M1（2026-11-04）：回想只在有人说话时召回，不常驻。
    recall: recallStore,
    // B2（2026-11-04）：关系摘要的候选序要用"最近谁在说话"。
    // `engine` 在后面才创建，这里给的是闭包，调用时它一定已经就绪；
    // 抛错就返回空数组（关系摘要退化成只看当前发言人，不影响主链路）。
    recentSpeakers: (sessionKey) => {
      try {
        const chatId = chatIdFromSessionKey(sessionKey);
        if (chatId === '') return [];
        const transcript = engine?.transcript?.(chatId);
        if (transcript === null || transcript === undefined || typeof transcript.snapshot !== 'function') {
          return [];
        }
        return transcript.snapshot().slice(-8);
      } catch {
        return [];
      }
    },
    learner,
    onLearned: saveLearned,
    // A+B（2026-10-17）：知识注入的字数上限 + 私聊走 system section。真源在 toml 的 `[memory]`。
    knowledgeInject: {
      maxChars: memoryCfg.injectMaxChars,
      privateAsSection: memoryCfg.injectPrivateAsSection,
    },
    // 群会话的工具限制（私聊不受影响）。名单已在上面解析完。
    denyToolsInGroup: groupDenyTools,
    // 按需加载：哪些前缀的工具收进目录（`undefined` = 代码默认；`[]` = 关掉）。
    onDemandTools,
    // 群会话单独挂的 preset（`undefined` = 按 `agentPreset` 推导）。
    groupAgentPreset,
    // 【c】当前心情 → system prompt（影响"怎么说话"）。
    // 绑定层拿 `sessionKey`，用 `routing.chatIdFromSessionKey()` 反推成 chatId 后再取心情。
    moodFor,
    // 发 QQ（send_qq）：执行器 + 规矩。规矩同样独立一段（`[send] rule`）。
    sendTool: sendExecutor,
    sendRule: sendCfg.rule,
    // B2（2026-10-25）：自动发送策略 —— **工具描述那句"插件会自动发"要跟着它变**
    // （`off` 之后插件不再自动发；描述不改 = 她只输出文本、什么都不发）。
    autoReply: sendCfg.autoReply,
    // 看表情包（`look_sticker`，2026-10-19）：执行器同样是延迟绑定。
    // ⚠️ **它不发消息**，所以不涉及 `outboundAllow`；这里只注入"怎么执行"。
    // 它也没有单独的规矩文本 —— 规矩写在 `[send] rule` 里（和 send_qq 同一段，都是发之前的事）。
    lookTool: lookExecutor,
    // 发语音（`send_voice`，2026-10-26）：同一个延迟绑定套路。
    // ⚠️ **`[tts] enabled=false` 时干脆不注册这个工具**：一个"点了必然被拒"的工具
    //    只是噪音（她会在工具列表里看见它、试一次、被拒）。开没开看配置就知道。
    //    真开了但 python 配错，工具**照样存在** —— 那时网关会把 `notReadyReason`
    //    原样告诉她（"语音功能没开（没配 python）"），别让她自己猜。
    voiceTool: ttsCfg.enabled ? voiceExecutor : null,
    // 按会话的人格覆盖（2026-10-21）：`qq-group-<群号>` / `qq-private-<QQ>`
    // 命中覆盖层时用它拼一份合并后的人格；没有覆盖层 ⇒ 返回 null ⇒ 用上面的
    // `persona`（全局那份，逐字节不变）。
    // 2026-10-24（P1-4）：坐标先问会话映射表（uuid 之后前缀正则认不出）。
    personaForSession: makePersonaForSession(personaSections, (key) => sessionResolver.scopeOf(key), promptCfg),
    // 2026-10-30：每轮提示词里的固定句子（身份/说话方式/工作目录/群聊骨架）走同一份配置。
    promptCfg,
    // 会话映射解析器：群/私聊、chatId、QQ 号都改成"表优先、旧前缀兜底"。
    resolver: sessionResolver,
    // 小鲸鱼的推理等级（`[agent] reasoning`，2026-10-21）：建 agent 时传给
    // `agentOptions.reasoningEffort`。**缺省 `low`**，不偷偷换档。
    agentReasoning: agentCfg.reasoning,
  });

  // **出站白名单**（`send_qq` / 主动语音 / 主动插话共用这一个判定器）。
  // 名单从配置来，代码里不写死任何号码；两边都没配 ⇒ 一律拒绝（fail-closed）。
  const outboundAllow = createOutboundAllow({
    allowFrom: config.allowFrom,
    groupAllowFrom: config.groupAllowFrom,
  });

  // 「图片 → 一句描述」描述器（`dsh/image-desc.mjs`）。
  //
  // **刻意只有一份**：这里新建、注入网关（展开转发里的图用），
  // 下一步「偷表情包」要的也是同一件事 —— 直接复用这个实例，
  // 别在那个功能里再写一套（缓存还能共享：同一张表情包不重复花钱）。
  //
  // ⚠️ **长度按次给，两份用途不一样**（`describe(input, {maxChars})`）：
  // - 这里（转发里的图，多是照片）**不传** → 用默认的 **50 字上下**，要看清场景/人物/动作；
  // - 偷表情包那条路要的是**短标签** → 届时传 `{maxChars: 12}` 左右。
  //   缓存是按「图 + 目标字数」分键的，所以同一个实例长短两种互不串味。
  //
  // 拿不到 `ctx.llm` / `ctx.attachments` 时它自动降级成"只用 QQ 自带的 summary"，
  // 插件在任何环境都能加载。
  // 审核闸的参数：**真源是 `qq-gugu.toml` 的 `[sticker_gate]`** ——
  // 用户点名要求提示词与阈值都放那儿，代码里不留第二份"真源"。
  // 读不到 / 写错一律回退默认值，但**每次都会留痕**（见 loadStickerGate 的 JSDoc）。
  const stickerGate = loadStickerGate(config, log);

  // ── 显存门控（2026-10-09）：`[vision_gate]` ──
  //
  // 用户要求的那条 if「调用视觉模型前先看空闲显存：
  // < 7G ⇒ v4f；≥ 7G ⇒ 本地」。
  //
  // ⚠️ **只在 toml 里配了本地 provider 时才真的开门控**：没配本地路的话，
  //    门控的结论永远是"走云"，那还不如压根不查显存（每次省一次 nvidia-smi 进程）。
  //    `loadVisionGate` 返回 null（没这一节）时 `visionGateCfg` 是 null ⇒ 门控关闭。
  const visionGateCfg = loadVisionGate(config, log);
  const visionGateConfig = visionGateCfg === null ? null : normalizeVisionGate(visionGateCfg);
  const visionGate = visionGateConfig !== null && visionGateConfig.local.provider !== ''
    ? createVisionGate({ gate: visionGateConfig, log })
    : null;
  if (visionGateCfg !== null && visionGateConfig.local.provider === '') {
    log('warn', '[vision_gate] 配了，但 localProvider 是空的 ⇒ 没有本地路可用，门控恒走云', {
      cloud: `${visionGateConfig.cloud.provider}/${visionGateConfig.cloud.model}`,
      thresholdMiB: visionGateConfig.freeMiB,
    });
  }

  // ── 审核留样（2026-10-09）：`[sticker_audit]` ──
  //
  // 把**每一张被审核过的图**（含被拒的、没看成的）另存一份给用户标。
  // ⚠️ 它与"入库"（`media\stickers\`）**是两个目录、两种语义**，刻意不合并：
  //    库里只该有"敢发出去的"，留样里要**什么都有**（否则没法统计拒得对不对）。
  const stickerAuditCfg = loadStickerAudit(config, log);
  const stickerAudit = createStickerAudit({ config: stickerAuditCfg, log });
  // 启动时先淘汰一次：上一次进程留下的东西可能早就超上限了
  // （不 await —— 它不该拖慢插件挂载；失败已在内部吞掉）。
  void stickerAudit.prune().catch(() => {});

  // ── 出站台账（2026-10-11）：B9 的观测层 ──
  //
  // 现场：2026-10-09 16:01:48 小鲸鱼的一条消息在 QQ 上出现**两条逐字相同的**
  // （不同 `message_id`、`real_seq` 连号、同秒）。调查（报告
  // `shared\tmp\2026-10-10-出站重复-session-00000000.md`）把范围压到【网关之下】，
  // 但**卡点是"没有任何出站留档"** —— 插件 log 不落盘、`stats` 只在内存且重载清零、
  // NapCat 日志停在 10-02。**没有口径，推理就到头了。**
  //
  // ⇒ 这一行把口径补上：`<DSH_HOME>\media\qq-outbound.jsonl`（只追加）。
  // ⚠️ **不传 `config`** ⇒ 走默认值（`enabled:true` + 路径由 `DSH_HOME` 推，
  //    推不出来退到本部署的 `<DSH_HOME>\media`）。要关就配 `{ file: '' }` 或
  //    `{ enabled: false }`（**空串 = 明确关掉**，与"没配"分得开）。
  // ⚠️ **它绝不是必需品**：写不进去只记一行 log，发送照常
  //    （`sticker-audit` 那次的教训：观测设施坏了不能把被观测的事也弄坏）。
  // ⚠️ **接上之后必须查快照的【值】**（`stats.outbound.ledger.hooked === true`）——
  //    `staleCode.stale:false` **只证明代码新，一个字都不证明这条链路接上了**。
  // ⚠️ **`file` 必须从配置里传**（`config.outboundLedgerPath`）。
  //    不传的话那个配置项就是**装饰品** —— 用户写 `''` 想关掉、或指到别的盘，
  //    代码却照写默认路径。那种"配了不生效"正是本项目反复栽的那一类。
  //    路径的真源是 `outbound-ledger.mjs` 的 `DEFAULT_OUTBOUND_LEDGER_PATH`
  //    （`resolveConfig` 已经把它填成默认值 ⇒ 不配也是它）。
  const outboundLedger = createOutboundLedger({
    config: { file: config.outboundLedgerPath },
    log,
  });

  // ── `QQ → 昵称` 表（2026-10-14）──
  //
  // 一句话：**NapCat 的 at 段不给名字，所以自己攒**（理由见 `nicknames.mjs` 模块头）。
  // 两条数据来源都接到同一张表上：
  //   ① 入站事件 —— `gateway.handleEvent` 里每条消息喂一次 `sender`；
  //   ② 灌历史   —— `history-backfill` 把那一窗的 `sender` 批量喂一遍
  //      （HMR 每次重载都清内存，这条路是**重载后自愈**的关键）。
  // ⚠️ **落盘路径必须从配置里传**（`config.nicknameTablePath`），否则那个配置项就是
  //    装饰品 —— 用户写 `''` 想关掉、或指到别的盘，代码却照写默认路径。
  //    路径的真源是 `nicknames.mjs` 的 `DEFAULT_NICKNAME_TABLE_PATH`
  //    （`resolveConfig` 已经把它填成默认值 ⇒ 不配也是它）。
  const nicknames = createNicknameTable({
    config: { file: config.nicknameTablePath },
    log,
  });

  // ── 群名缓存（2026-10-21）──
  //
  // 配置页要显示真实群名（"示例群"），而宿主原来**没有任何来源**：
  // 入站事件只有 `group_id`，`qq-nicknames.json` 只存人名。所以通过 transport
  // 调 `get_group_info`（只读动作）攒一张 `{群号: 群名}` 落盘。
  //
  // 三条约定：
  //   ① 启动后（transport ready）拉一次白名单里的群，之后按需补拉；
  //   ② 失败只记 warn —— 它是观测设施，不是必需品；
  //   ③ 取不到名字 ⇒ 接口给空串，前端回退显示号码（宿主**不编名字**）。
  const groupNames = createGroupNameCache({
    config: { file: config.groupNameTablePath },
    transport,
    log,
  });
  // 白名单里的群（启动时拉一遍）。纯数字去重由 `normalizeIdList` 负责。
  const groupNameTargets = normalizeIdList(config.groupAllowFrom);

  const imageDescriber = createImageDescriber({
    attachments: typeof ctx.get === 'function' ? (ctx.get('attachments') ?? null) : null,
    stream: typeof ctx.llm?.stream === 'function' ? (opts) => ctx.llm.stream(opts) : null,
    provider: config.provider || 'deepseek-official',
    model: config.model || 'deepseek-flash',
    log,
    // ── 原件与缓存表（2026-10-07）──
    //
    // **账号从配置读**（`botQQ`），路径模板也从配置读 —— 都**不硬编码**。
    // 开发机上那个"能用"的路径是**用户账号**的（30000001），
    // 拿它当默认值就是埋一个"以后一定出错"的雷（用户明确警告过）。
    botQQ: config.botQQ,
    originalDirs: config.imageOriginalDirs,
    tablePath: config.imageDescCachePath,
    // ── 审核闸（2026-10-08 打分制）──
    //
    // ⚠️ 审核的**每一条判据都要看像素**（配文是什么、各项各打几分、是不是真人/截图）
    //    ⇒ 它只能由一个**有视觉能力的模型**执行。`[sticker_gate]` 的 provider/model
    //    **留空 ⇒ 交给下面的显存门控自动选**（不是"固定走云"—— 2026-10-09 更正）。
    stickerGate,
    // ── 显存门控（2026-10-09）──
    //
    // ⚠️ **手动 vs 自动 的优先级**：`[sticker_gate] provider/model` 是**手动指定**，
    //    门控是**自动选**。两者冲突时【手动赢】—— 见 `image-desc.mjs` 的 `resolveRoles`。
    //    ⚠️ **门控作用在【所有没手动指定 provider/model 的视觉调用】上**，
    //    目前是**两条**：① 转发里夹着的图 → 一句描述 ② **审核闸本身**（`[sticker_gate]` 留空时）。
    //    （这里原来只写了"①"，漏了② —— 2026-10-09 核实代码后更正。）
    visionGate,
    visionGateConfig,
    // 2026-10-30：图片描述的两套 system（`[vision_gate]`；空 ⇒ 代码原文）。
    systemDetailed: String(visionGateCfg?.descSystemDetailed ?? ''),
    systemBrief: String(visionGateCfg?.descSystemBrief ?? ''),
    // ── 审核留样（2026-10-09）──
    //
    // ⚠️ 它**只**在「认」那条路上被调用（`describeSticker` 里），而且**不许影响判定**：
    //    写盘失败只记日志（连续失败会自动断开）。
    stickerAudit,
  });

  // **把审核闸读到了什么说出来。** 这是"toml 改了到底生效没有"最直接的答案 ——
  // 配置静默不生效是这个项目最贵的一类坑（见 AGENTS.md「静默不生效」那一族）。
  log('info', '表情包审核闸已加载', {
    promptFromToml: stickerGate.prompt.trim() !== '',
    provider: stickerGate.provider === '' ? (config.provider || 'deepseek-official') : stickerGate.provider,
    model: stickerGate.model === '' ? (config.model || 'deepseek-flash') : stickerGate.model,
    nsfwMax: stickerGate.nsfwMax,
    violenceMax: stickerGate.violenceMax,
    goreMax: stickerGate.goreMax,
    uglyMax: stickerGate.uglyMax,
    // ⭐ 2026-10-09：`funny` 的**下限**（唯一一项方向相反的阈值）。
    //    挂载日志里少一个旋钮 = "它在 toml 里到底读到了没有"只能靠翻代码回答。
    funnyMin: stickerGate.funnyMin,
    captionMaxChars: stickerGate.captionMaxChars,
    // ⭐ 2026-10-10：「认」那一次调用的输出 token 预算。
    //    挂载日志里少它就等于"切模型时有没有连带抬它"只能靠翻代码回答 ——
    //    而"数太小 ⇒ JSON 被截断 ⇒ 静默拒图"正是加它的起因。
    maxTokens: stickerGate.maxTokens,
    // ⭐ 2026-10-10：这次「认」**要不要让模型思考**（默认 false = 不要）。
    //    它必须出现在挂载日志里 —— "toml 里写了、到底读到没有"的第一观测点。
    //    ⚠️ 顺手一起说清它的**作用范围**：它不是往请求体塞字段，而是驱动那一次调用的
    //    `reasoningEffort`（`false` ⇒ `'off'`，`true` ⇒ 不发这个字段）。线上到底会不会
    //    出现 `enable_thinking`，取决于 provider 路由有没有声明 thinking 元数据 ——
    //    见紧跟在本条后面的"审核闸的思考开关…"那条探测日志。
    enableThinking: stickerGate.enableThinking,
  });

  // ⭐ 2026-10-10：**"关思考"到底能不能在本路由上生效** —— 挂载时探一次，留一条痕迹。
  //
  // 为什么值得单独一条日志：`enableThinking=false` 走的是 `reasoningEffort: 'off'`，
  // 而那是 DSH LLM 环缝里**唯一**能表达"要不要思考"的契约字段。它在不同适配器上的
  // 线上表现不一样（pi-ai：有 thinking 元数据的模型才会发 `enable_thinking`；
  // `dsh-llm-deepseek`：发 `thinking:{type:'disabled'}`），而**手写在配置里的模型
  // 默认没有 thinking 元数据** ⇒ 那种路由上"关思考"不会产生任何线上字段差异。
  // 这件事**不报错、计数正常**，正是"静默不生效"那一族坑 ⇒ 必须能一眼看见。
  //
  // ⚠️ **best-effort、绝不拖慢挂载**：fire-and-forget + 全包 try/catch。
  //    provider 没注册适配器时 `resolveModelInfo` 会抛（NO_ADAPTER）—— 那本身是最该报的
  //    一条（审核闸的每一次视觉调用都会失败、而且 fail-closed 全拒）。
  void (async () => {
    if (typeof ctx.llm?.resolveModelInfo !== 'function') return;
    const probeProvider = stickerGate.provider === '' ? (config.provider || '') : stickerGate.provider;
    const probeModel = stickerGate.model === '' ? (config.model || '') : stickerGate.model;
    if (probeProvider === '' || probeModel === '') return;
    try {
      const info = await ctx.llm.resolveModelInfo(probeProvider, probeModel);
      const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts.map((e) => e?.id) : [];
      const switchable = efforts.some((id) => id !== undefined && id !== 'off');
      log(switchable ? 'info' : 'warn', switchable
        ? '审核闸的思考开关：本路由声明了思考档位 ⇒ enableThinking=false 会让适配器按"不思考"发请求'
        : '⚠️ 审核闸的思考开关在本路由上**没有线上效果**：该模型没有声明任何"非 off"的思考档位 ⇒ enableThinking=false 只是"不发 reasoningEffort"，provider 会用它自己的默认档（通常仍是思考开）。想真正关掉：给 `cordis.patch.yml` 里该 provider 的模型加 `reasoningEfforts`（如 {off: null, low: "low"}）与 `compat.thinkingFormat`（qwen 类端点）', {
        provider: probeProvider,
        model: probeModel,
        enableThinking: stickerGate.enableThinking,
        efforts,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log('warn', '⚠️ 审核闸的 provider/model **取不到模型信息** —— 每一次视觉审核都会失败（fail-closed ⇒ 全部拒收），先修 provider 注册与凭据再看别的', {
        provider: probeProvider,
        model: probeModel,
        error: detail.slice(0, 300),
      });
    }
  })();

  // **把显存门控读到了什么说出来**（同上：配置静默不生效是最贵的一类坑）。
  // ⚠️ 这条日志要说清**四件事**，少一件都可能在"为什么走了云"上抓瞎：
  //    门控开没开 / 阈值多少 / 本地是哪条 / 云端是哪条。
  log('info', '显存门控（视觉按空闲显存选后端）已加载', {
    enabled: visionGate !== null,
    thresholdMiB: visionGateConfig?.freeMiB ?? null,
    cacheMs: visionGateConfig?.cacheMs ?? null,
    local: visionGateConfig === null ? null : `${visionGateConfig.local.provider}/${visionGateConfig.local.model}`,
    cloud: visionGateConfig === null ? null : `${visionGateConfig.cloud.provider}/${visionGateConfig.cloud.model}`,
    // ⚠️ 这一条是"手动配置赢"的可执行说明（免得以后有人猜）：
    manualWins: '[sticker_gate] provider/model 非空的那条调用不受门控影响',
  });

  // **表情包库**（2026-10-08）：偷（从消息里捞表情包）+ 存（md5 去重、使用计数）。
  //
  // 判据是**位判据**：`emoji_id` 非空 **或** `sub_type & 1` —— 2026-10-08 的
  // 1495 张真实样本定的（`shared/表情包-2026-10-08/`），把收进量从 2 张提到 235 张。
  // 判据写在 `sticker-library.mjs` 里，理由（含"summary 为什么不能当证据"）也在那儿。
  //
  // ⚠️ **它绝不能变成单点故障**：读不到/坏了/写不进一律当空库，
  // 照常收消息回消息（见 `sticker-library.mjs` 的模块注释）。
  // `stickerDir: ''` 是**明确关掉"偷"**；发图那半边不受这个开关控制。
  const stickerLibrary = createStickerLibrary({
    indexPath: config.stickerIndexPath,
    // 2026-10-19：`pick` 的描述表从**审核留样**的 index.jsonl 读。
    // ⚠️ 必须跟着 `[sticker_audit] dir` 走 —— 写死默认路径的话，
    //    一改 dir（或换 POSIX 部署）描述就静默读不到：加分永久失效，而且**没有任何日志**。
    auditPath: String(stickerAuditCfg?.dir ?? '').trim() === ''
      ? ''
      : path.join(String(stickerAuditCfg.dir), 'index.jsonl'),
    dir: config.stickerDir,
    enabled: config.stickerSteal === true,
    log,
    botQQ: config.botQQ,
    // 复用同一份本地原件目录模板：QQ 把收到的表情包放在
    // `…\Emoji\emoji-recv\` 下，先按名字找能省掉一次 CDN 往返。
    originalDirs: config.imageOriginalDirs,
    // ── 「认」：新图入库前先看一眼（一次调用出 desc/标签/safe）──
    //
    // 复用**同一个**描述器实例（缓存也共享：同一张图不会为"描述"和"认"各花一次钱）。
    // ⚠️ **只有真能看图时才接**：接上就是 fail-closed（认不出 ⇒ 那一张不入库），
    // 所以没有视觉服务的部署宁可不接 —— 那样照样攒图，只是 tags 全空、也没有审核闸。
    //
    // ⚠️ 第二个参数 `meta`（`{chatId, userId, subType}`）**必须并进去**：
    // 「认」会把它写进留样记录（`sticker-audit`）—— 没有来源，
    // 用户看到一张被拒的图也答不出"这是谁在哪个群发的"。
    ...(imageDescriber.canUseVision()
      ? { recognize: (image, meta) => imageDescriber.describeSticker({ ...image, source: meta ?? null }) }
      : {}),
  });

  // ===== 「说不说」的裁量模式（画布上的三种，2026-10-13 落地模式 2/3）=====
  //
  // 三个键都在 `[proactive]` 段（画布与设计账本都写在那儿；`CONFIG_SHAPE` 里也有）。
  // 这里把它们**解析成运行时要用的东西**，之后引擎/网关只认解析结果：
  //
  // ```
  // judge_mode      → 'heuristic' | 'precheck' | 'inTurn'（认不出 ⇒ heuristic）
  // precheck_model  → 预检那一次调用走哪个 provider/model（provider 可省）
  // decline_bonus   → ✅ 2026-10-14 已实现（累积式攒劲儿，第 6 项加分）。
  //                   引擎自己在闸门放行后结算，**这里不需要解析** ——
  //                   它和 cap / 限流间隔一样走 `ProactiveEngine` 的 `#cfgFor()`。
  //                   （见 `CONFIG_SHAPE.proactive.decline_bonus` 与 `defaultTriggerConfig()`）
  // ```
  //
  // ⚠️ 放在网关**之前**：网关构造时要收这两个值（`judgeMode` / `precheck`）。
  //
  // ⚠️ **读的是 `[proactive]` 那三层合并后的结果**（`defaultTriggerConfig() ←
  // CONFIG_SHAPE.proactive ← toml`），**不是只读 cordis 那一层** —— 这三个键按设计
  // 是"行为配置"，用户是在 `qq-gugu.toml` 里切的。只读 cordis 的话，
  // toml 里写了 `judge_mode = "inTurn"` 会**静默不生效**（本项目最贵的一类坑）。
  // 合并顺序与下面 `ProactiveEngine` 收到的 `config` **完全同一份**，避免两处漂移。
  const proactiveMerged = { ...config.proactive, ...proactiveToml.config };
  const judgeMode = normalizeJudgeMode(proactiveMerged.judge_mode);
  // 私聊单独一套判定模式（2026-11-01）：**空串 = 跟随 `judge_mode`**。
  // 为什么要它：群里要 precheck（省掉白跑的整轮），私聊要 inTurn（让她自己决定这轮说不说）。
  // 用户原话：「私聊里也允许她有时候不吭声，不过我觉得私聊 inTurn 更好」。
  const judgeModePrivateRaw = String(proactiveMerged.judge_mode_private ?? '').trim();
  const judgeModePrivate = judgeModePrivateRaw === '' ? '' : normalizeJudgeMode(judgeModePrivateRaw);
  const precheckModel = resolvePrecheckModel(proactiveMerged.precheck_model, {
    // provider 省略时沿用主配置那一条（账本草案的注释：「留空 = 跟随 provider/model」）。
    defaultProvider: config.provider || 'deepseek-official',
    /**
     * 已注册的 provider 名单 —— 用来判断 `a/b` 里的 `a` 到底是 provider
     * 还是模型名的一部分（模型 id 自己就常带斜杠：`stepfun/step-5-preview`）。
     * 名单随部署漂移，所以走配置里的可选数组，不写死在这里。
     */
    knownProviders: config.knownProviders,
  });
  // 模式 2 的预检器。**模式 1/3 下它一次都不会被调用**（网关只在 precheck 模式里看它）。
  const precheck = createPrecheck({
    stream: typeof ctx.llm?.stream === 'function' ? (opts) => ctx.llm.stream(opts) : null,
    provider: precheckModel.provider,
    model: precheckModel.model,
    // 2026-10-30：预检的**系统段**可配（空 = 代码里那段原文，逐字节相同）。
    // 组装段（转录/打分/心情那些）仍是代码拼的 —— 它塞的是运行期数据，不是措辞。
    systemPrompt: String(proactiveMerged.precheck_system ?? ''),
    timeoutMs: Number(proactiveMerged.precheck_timeout_ms) > 0
      ? Number(proactiveMerged.precheck_timeout_ms)
      : DEFAULT_PRECHECK_TIMEOUT_MS,
    log,
    // 【a】当前心情 → 那一次性的预检提示词（影响"说不说"）。
    // 用户原话：「走启发式是没办法了，走轻量的话直接塞进去让他看着决定呗」
    // ⇒ **不做任何阈值数学**，就把那句心情塞进去让轻量模型自己权衡。
    // ⚠️ `judge_mode = heuristic` 时这一路**根本不会被调用**（网关只在 precheck 里看它），
    //    所以默认配置下的行为与接线前**逐字节相同**。
    moodFor,
  });

  if (judgeMode === JUDGE_MODE_PRECHECK) {
    // 这条日志是"配置到底读到了没有"的唯一答案 —— toml 改了不碰 `src/` 不会重载
    // （AGENTS.md 里那两条独立的生效链）。
    log(precheck.enabled ? 'info' : 'warn', `判定模式 = precheck（预检走 ${precheckModel.provider}/${precheckModel.model || '(未配)'}）`, {
      ...precheck.describe(),
    });
  } else if (judgeMode === JUDGE_MODE_IN_TURN) {
    log('info', '判定模式 = inTurn（总分当倾向塞进提示词，由该轮自己决定说不说）', {});
  }

  // 网关。注意 transport 要晚一点才有 selfId，所以 botQQ 的判断放在事件处理里。
  const gateway = new Gateway({
    transport,
    router,
    // 关系记账（A 段，2026-11-04）：纯观察，不调模型、不改判定。
    // 与 binder 共用同一个实例（关系摘要要用这里记下的计数）。
    relationLedger,
    // 群聊防抖（2026-11-04）：同人续发 2s / 换人 0.5s / 整批 8s / @ 1s。
    // 参数写死在 debounce.mjs，不走配置（先跑一周看数据）。
    debounce: true,
    // 会话映射解析器（2026-10-24，P1-4）：三个工具闸门 + 派发时记映射都靠它。
    sessionResolver,
    engine: null, // 下面补上：引擎需要 speak 回调，而 speak 要用 gateway。
    responder: binder.asResponder(),
    // 2026-10-28：「这一轮到底是不是**丢了**回复」的判据（事故驱动）。
    // 网关只知道 responder 返回了空串，分不出"模型决定不说话"和"我们没取到"；
    // 真相在 binder 那边（`historyShrank` / 流式帧数）。传进去之后，
    // "静默丢消息"那条路会留一条 warn + 进快照的 `stats.lostReplies` / `emptyReply`。
    diagnoseEmptyReply: (sessionKey) => binder.emptyReplyDiagnosis(sessionKey),
    // 内部通道没给收件人时的默认目标：主人（`[owner] admins` 第一个）。
    // 没配主人就留空 ⇒ 内部通道只写会话、不推 QQ（不在代码里写死任何人的号）。
    ownerChatId: ownerCfg.admins.length > 0 ? `private:${ownerCfg.admins[0]}` : '',
    log,
    maxReplyChars: config.maxReplyChars,
    // B2（2026-10-25）：`[send] auto_reply` —— 决定"她这一轮没调 `send_qq` 时要不要自动发"。
    autoReply: sendCfg.autoReply,
    // B3（2026-10-25）：消息切分（独立一行的标记 ⇒ 切成几条发；空串 = 关）。
    splitMarker: sendCfg.splitMarker,
    splitMaxParts: sendCfg.splitMaxParts,
    // 2026-10-26：`send_qq` 发图的本地文件大小上限（`[send] max_image_mb`，默认 10 MB）。
    maxImageBytes: Math.round(sendCfg.maxImageMb * 1024 * 1024),
    // B4（2026-10-25）：语音转文字。`null` = 没启用 ⇒ 照旧 `[语音（未转写）]`。
    voiceTranscriber,
    // 文字转语音（2026-10-26，`send_voice`）。`enabled:false` ⇒ 工具直接拒（"语音没开"）。
    // 语音**发不发**另有三道闸（白名单 / 群里默认关 / 间隔），全在网关里判，不在工具里。
    tts: ttsSpeaker,
    // 语音情绪旁路（2026-10-26）：转写之后听一遍，**只算 arousal、只记录**。
    // ⚠️ v1 **不进提示词**；要进的话改 `gateway.#buildPrompt`（那里的注释写着要用的那句话）。
    emotionSenser,
    // 「主动插话」那句措辞：**真源是 toml 的 `[proactive] interject_prompt`**。
    // 与其它"脾气"类配置一致 —— cordis 管装什么，toml 管脾气（见 `loadProactiveConfig`）。
    // 读不到 / 留空 ⇒ 网关用内置默认（行为与改动前逐字相同）。
    // 为什么放这儿而不是 `CONFIG_SHAPE`：那段字很长，不该塞进 `cordis.patch.yml`。
    interjectPrompt: proactiveToml.config.interject_prompt,
    // 2026-10-30：每轮提示词里的固定句子（`[prompt]`）。
    promptCfg,
    // 心情模型能看到几条聊天记录（`[mood] transcript_messages`，默认 20）。
    moodTranscriptMessages: Number(moodCfg.transcriptMessages) > 0 ? Number(moodCfg.transcriptMessages) : 20,
    outboundAllow,
    // 识图：把入站图片存成 DSH 附件再喂给模型（见 dsh/media.mjs）。
    // 可选读取 —— 没有附件服务的环境（包括测试里的假 ctx）里插件照样要能跑，
    // 只是看不到图、退回 `[图片]` 占位符。`ctx.get` 本身也可能不存在，所以要双重防御。
    attachments: typeof ctx.get === 'function' ? (ctx.get('attachments') ?? null) : null,
    // 转发里夹着的图 → 一句描述（顶层单发的图默认不动，见 imageDescription 注释）。
    imageDescriber,
    imageDescription: config.imageDescription,
    // 表情包库：偷（入站时捞）与发（出站图片源写成 `{sticker:'<md5>'}`）共用这一份。
    // 为 null 时两条路都关掉，插件照样跑（它**不是**必需品）。
    stickerLibrary,
    // 出站台账：网关用它往 `qq-outbound.jsonl` 记 `gw-send` 一行，
    // 并把 `transport.sendToChat` 挂上（那一层记 `transport-action`）。
    // 为 null 时**什么都不记**、也不挂钩（收消息回消息照旧）——
    // 同 `stickerLibrary`：它**不是**必需品。
    outboundLedger,
    // `QQ → 昵称` 表：入站时学、渲染 @ 段时查（`@30000002` → `@小鲸鱼`）。
    // 为 null 时两个方向都不做 ⇒ @ 段落回退成 `@QQ号`（它**不是**必需品）。
    nicknames,
    mood,
    // 「说不说」的裁量模式 + 模式 2 的预检器（2026-10-13）。
    // ⚠️ 网关**不持有判定逻辑**：它只在"过了阈值"之后决定由谁拍板
    // （见 `gateway.mjs` 构造函数里那两段注释）。默认值 = 模式 1，行为不变。
    judgeMode,
    judgeModePrivate,
    precheck,
  });

  sendToolRef.fn = (args) => gateway.sendFromTool(args);
  // 2026-10-19：看表情包工具的真身（发之前"亲眼看一眼"）。
  lookToolRef.fn = (args) => gateway.lookFromTool(args);
  // 2026-10-26：发语音工具的真身。
  voiceToolRef.fn = (args) => gateway.sendVoiceFromTool(args);

  // 🔴 2026-10-20：把**本实例**的三个执行器写进跨插件热重载中转表（覆盖上一代的值）。
  //
  // 注册在 agentCtx（root 托管、跨 HMR 存活）上的工具只会注册一次，所以它们的
  // `execute` 不能在注册时闭包捕获实例 —— 那样 HMR 之后旧闭包指向的 gateway
  // 的 transport 已经停了，工具会**静默失效**。`execute` 运行时查表，表由这里填。
  publishToolBridge({ send: sendExecutor, look: lookExecutor, voice: voiceExecutor });

  // 自动搬运（2026-11-02）：`turn/end` 时看这个会话有没有 QQ 出口，有就把**这一轮的正文**
  // 搬过去。用户原话：「让插件把你每次的输出都搬出来（不说话除外）」。
  //
  // 为什么必须在**这里**（apply 作用域）造：它要跟 gateway 同生共死（HMR 后换代）。
  // 为什么它自己不做判定细节：判定全在 `dsh/auto-relay.mjs`（纯逻辑、可离线测），
  // 这里只负责"把事件喂进去"，并且**自己吞掉所有异常** —— 这个回调挂在宿主的事件循环上，
  // 抛出去 = 宿主进程退出（本项目崩过三次的同一个形状）。
  const autoRelay = createAutoRelay({ gateway, log });

  // 「她自己的时间」（2026-10-18）：`[free_time]` 的定时器 —— 之前只有配置、没有实现。
  //
  // ⚠️ v1 只放开**只读**活动：提示词里明确"别删别改文件"，开口子另说。
  // ⚠️ 回调体自己吞异常：它挂在 `ctx.interval` 上，抛出去就是宿主进程里的未捕获异常。
  // ⚠️ `enabled=false` 时**连定时器都不建**（和 mood 那条一致：关掉 = 一条路都不留）；
  //    改 toml 要点「重载插件」才会重建 —— 和配置页那套"重载后生效"完全一致。
  // **用户是谁、这个值从哪来**（2026-10-21 改）：
  //   `[owner] admins` 第一个 ⇒ 否则回退 `allowFrom` 第一个 ⇒ 否则没有用户。
  // 这一行取代了原来那句 `normalizeIdList(config.allowFrom)[0]` 的隐含约定。
  const ownerQq = ownerCfg.qq;
  if (ownerQq === '') {
    log('warn', '她自己的时间：既没有 [owner] admins、allowFrom 也是空的，没法确定叫醒哪个会话 —— 不挂定时器', {
      source: ownerCfg.source,
    });
  } else {
    // 留痕：**用的哪个号、从哪来的**。改了 admins 之后"到底生效没有"就靠这一行。
    log('info', `用户（ownerQq）取 ${ownerQq}，来源 ${ownerCfg.source === 'owner' ? '[owner] admins' : 'allowFrom 的第一个'}`, {
      qq: ownerQq,
      source: ownerCfg.source,
      admins: ownerCfg.admins.length,
      allowFrom: normalizeIdList(config.allowFrom).length,
    });
  }
  /**
   * 跨重启状态的落盘路径（2026-10-23）：**只有 `lastUserMessageAt` / `followupDone`**。
   *
   * 放 `<DSH_HOME>\media\` —— 和 `qq-proactive-debug.json` / `qq-proactive-announce.json`
   * 同一个目录、同一种"小 JSON + 临时文件 rename"的写法，**不另造一套存储**。
   * （`<DSH_HOME>` 对 shell 只读，但插件跑在宿主进程里，一直往这个目录写快照。）
   * 可用 `QQ_FREE_TIME_STATE=` 置空/改路径（空 = 不落盘，重启就从头算）。
   */
  const freeTimeStateFile = process.env.QQ_FREE_TIME_STATE !== undefined
    ? String(process.env.QQ_FREE_TIME_STATE)
    : (() => {
      // 目录跟着**调试快照**走：它被 `QQ_PROACTIVE_DEBUG_FILE` 改到哪，状态就落在哪
      // （测试/临时部署因此不会写到真的 `<DSH_HOME>` 里）。
      const debugPath = process.env.QQ_PROACTIVE_DEBUG_FILE !== undefined
        ? String(process.env.QQ_PROACTIVE_DEBUG_FILE)
        : defaultDebugPath();
      return debugPath === '' ? '' : path.join(path.dirname(debugPath), 'qq-proactive-free-time.json');
    })();

  const freeTime = ownerQq === '' ? null : createFreeTime({
    gateway,
    binder,
    log,
    now: () => Date.now(),
    getConfig: () => freeTimeCfg,
    privateChatId: `private:${ownerQq}`,
    // 她忙不忙的锁键（2026-10-24，P1-4 / P2-6）：**必须和 binder.locks 用的是同一个键**。
    // 传函数而不是值：new-if-no-legacy 之下，新聊天要等第一次派发才分配 uuid，
    // 构造时还查不到 —— 每 tick 现取才能一直对齐。
    sessionKey: () => sessionResolver.resolve(`private:${ownerQq}`).sessionId,
    // 跨重启状态（2026-10-23）：用户最后一条消息 + 这轮沉默追问过没有。
    statePath: freeTimeStateFile,
    // 唤醒前截图（2026-10-21；2026-10-22 改成**每块屏一张**）：`captureVirtualDesktop`
    // 默认逐屏截、拿不到多屏就回落成合并一张，一次返回 `images[]`（free-time 全部投递）。
    // 目录放工作区 tmp（`<DSH_HOME>` 那棵树对某些进程只读）；`[free_time] screenshots=false`
    // 时 `free-time.mjs` 连 `capture` 都不会调。截屏失败 ⇒ 照常唤醒、只发文字。
    capture: captureVirtualDesktop,
    screenshotsDir: process.env.QQ_SCREENSHOT_DIR ?? `${sharedDir}\\tmp\\screens`,
    // 分屏要截多张（越线时还要各自重编码）⇒ 给 15s；原来的 8s 在两块 4K 屏冷启动上会偶发超时。
    captureTimeoutMs: 15000,
  });
  freeTimeRef.current = freeTime;
  // 「用户最后一条消息」的**唯一汇合点**：网关每条入站消息都会问一次
  // （`gateway.handleEvent`，去重之后、任何早退之前）。
  // `free-time` 自己只认**用户 QQ** 发的那条（群友说话不是"用户说话"），
  // 别处的判定不重复一遍 —— 两处记就会漂移。
  gateway.onUserMessage = freeTime === null ? null : (message) => freeTime.noteUserMessage(message);
  if (freeTime !== null && freeTimeCfg.enabled === true) {
    ctx.effect(
      () =>
        ctx.interval(() => {
          freeTime.tick().catch((error) => {
            log('warn', '她自己的时间：tick 出错', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, 60 * 1000),
      'qq-proactive: free time',
    );
    log('info', '她自己的时间：定时器已挂上', {
      everyMs: 60000,
      intervalHours: freeTimeCfg.intervalHours,
      // 短追问（2026-10-23）：用户最后一条消息之后这么久没动静就叫她一声。
      followupMinutes: freeTimeCfg.followupMinutes,
      stateFile: freeTimeStateFile,
      window: [freeTimeCfg.windowStartHour, freeTimeCfg.windowEndHour],
      chatId: `private:${ownerQq}`,
    });
  } else {
    log('info', '她自己的时间：enabled=false（或没有用户），不挂定时器', {});
  }

  // 判定引擎：**只判定、不生成措辞**。
  //
  // ## 架构（用户拍板的方案 A：判定统一 + 回复统一）
  //
  // 判定层（`engine.decide` → `heuristic-gauge.judge`）只回答「要不要回」，
  // 三条触发通道取或：被点名（@/私聊/喊名字）、打分够、专注度够。
  //
  // **说什么一律交给会话（agent）** —— 包括群里没 @ 时的插话。所以插话也会落进
  // 会话历史，上下文是连续的（小鲸鱼知道自己插过什么），这正是之前"插完话就断片、
  // 只能拿时间戳猜"的解法。
  //
  // 早先这里挂过一个 `wording`（`ctx.llm.stream` 生成轻量插话），它在
  // 「判定/措辞分离」的旧架构下是合理的；统一之后不再需要，已移除。
  // 主动发言的配置：`proactiveToml` 在上面已经读过（会话绑定层要先用它），
  // 这里直接复用 —— **不要重复读一遍 toml**，否则两处解析结果可能不一致。
  //
  // 分层顺序（用户要的"通配 + 指定群特殊规则"）：
  //   toml [proactive]           ← 通配，盖过 cordis.patch.yml 里的默认值
  //   toml [proactive.groups.X]  ← 只对那个会话生效
  //   代码里的 defaultTriggerConfig()  ← 最后的兜底
  const gaugeRunner = async (request) => {
    const decision = await judge(request, { config: config.gauge });
    // `null` = **压根没打分**（窗口空 / 命中"别说话" / 打分关闭）⇒ 原样传下去。
    // ⚠️ 这一条不能并进下面的逻辑：precheck 只在"打分说要"之后才有意义。
    if (decision === null) return null;
    /**
     * `judgeMode` 挂在判定结果上**一起往下走** —— 它会经 `gateway.dispatch`
     * 传进 `#buildPrompt`（模式 3 加"倾向"）与 `runTurn`（空回复留痕），
     * 以及 `engine.#decide` 的日记（`pmode`）。
     *
     * 为什么挂在 `decision` 上而不是让网关读 `this.judgeMode`：
     * 那条路要走 `dispatch(decision)` **已有的**参数，一个字段都不用加；
     * 网关自己的 `judgeMode` 只是缺省值（单测可以只传 `decision`）。
     */
    decision.judgeMode = judgeMode;
    return decision;
  };
  const engine = new ProactiveEngine({
    config: proactiveMerged,
    overrides: proactiveToml.overrides,
    // 机器人自己的名字与别名 —— 让"用文字喊名字"也能算相关。
    // 早先引擎没传 `nameMentioned`，gauge 里 +45 那条相关性加成是死代码，
    // 于是群里喊「小鲸鱼在不在」被判不相关、直接沉默（用户实测踩到）。
    names: config.botNames,
    // 模式 1/2/3 —— 引擎**只把它记进日记**（`pmode`），不实现任何一种：
    // 真正的分支在网关（模式 2 要拼"带着正文的一次性提示词"，而引擎不碰正文）。
    judgeMode,
    precheck,
    // 判定层**只打分**，不再生成措辞。
    //
    // 统一之后（用户拍板的方案 A）：说什么、怎么回，一律交给会话（agent）——
    // 插话也会落进会话历史，所以上下文是连续的，小鲸鱼知道自己插过什么。
    // 于是这里不再需要 `ctx.llm.stream` 那套轻量措辞（原 `wording.mjs`），
    // 判定层退回成一个纯函数。
    //
    // ## 2026-10-13：`judge_mode` 三种模式（画布上的模式 2/3 落地）
    //
    // 打分器（`heuristic-gauge.judge`）**一个字没改** —— 它仍然是三种模式**共用**的
    // 那一份打分。`gaugeRunner` 只把它包一层，把"过了阈值之后由谁拍板"接上去：
    //
    // ```
    // heuristic（默认）  打分说什么就是什么        ← 与改动前逐字一致
    // precheck           打分说要 ⇒ 网关再问一次轻量模型 ⇒ 它说该才进 agent
    // inTurn             打分说要 ⇒ 照常进 agent（"倾向"由网关塞进提示词）
    // ```
    //
    // ⚠️ **默认分支里一个字段都没多**：`heuristic` 下返回的对象与改动前**逐字相同**
    // （只多挂一个 `judgeMode`，而它在模式 1 下不改变任何分支）——
    // "不配新键 ⇒ 行为不变"可以拿反证验，见 `test/judge-mode.test.mjs`。
    gauge: gaugeRunner,
    // 准入在闸门里判（扣配额之前），speak 里再判一次是兜底。
    // 只靠 speak 里判的话，被拦下的发言会白烧掉小时配额。
    allowed: (chatId) => router.proactiveAllowed(chatId),
    speak: async ({ chatId, text }) => {
      // **必须看返回值**。`speakProactively` 在"目标不在允许范围"或
      // "发送失败"时返回 false 而不是抛异常 —— 早先这里不检查返回值，
      // 结果调试日志里记着 `event: "speak"`，用户却什么都没收到。
      const ok = await gateway.speakProactively(chatId, text);
      if (ok !== true) {
        log('warn', `主动发言没有发出 ${chatId}`, { chars: String(text ?? '').length });
      }
      return ok;
    },
    log,
  });
  gateway.engine = engine;
  gateway.attach();

  // ===== 聊天回想泵（M1，2026-11-04）=====
  //
  // 转录是 60 条环形缓冲，第 61 条进来时第 1 条就被挤掉了（`Transcript.dropped`）。
  // 这里每 2 分钟看一次：某个会话攒够 20 条被挤掉的消息，就压成一条"回想"
  // （摘要 + 3~5 条线索）存进 `recall.json`，下一轮由 binding 按当前消息召回。
  //
  // 参数写死（用户 2026-11-04：「条数多点少点影响都不大，最终还是要跑过才知道」）：
  // 20 条一批、2 分钟一查。模型复用预检那个轻量模型，失败只 warn、不重试。
  const recallCompressor = createRecallCompressor({
    stream: typeof ctx.llm?.stream === 'function' ? (opts) => ctx.llm.stream(opts) : null,
    provider: precheckModel.provider,
    model: precheckModel.model,
    log,
  });
  const RECALL_PUMP_MS = 2 * 60 * 1000;
  const RECALL_BATCH_MIN = 20;
  const recallPump = async () => {
    if (!recallCompressor.enabled) return;
    let batches = [];
    try {
      batches = engine.drainDropped({ minCount: RECALL_BATCH_MIN });
    } catch (error) {
      log('debug', '回想：取被挤出的消息失败（忽略）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const { chatId, messages } of batches) {
      try {
        const parsed = await recallCompressor.compress(messages);
        if (parsed === null) continue;
        recallStore.add({ chatId, summary: parsed.summary, cues: parsed.cues });
        log('debug', '回想：已压缩一段', { chatId, 条数: messages.length, 线索: parsed.cues.length });
      } catch (error) {
        log('warn', '回想：压缩失败（忽略这一段）', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  const recallTimer = setInterval(() => {
    recallPump().catch((error) => {
      log('warn', '回想泵异常（忽略）', { error: error instanceof Error ? error.message : String(error) });
    });
  }, RECALL_PUMP_MS);
  if (typeof recallTimer?.unref === 'function') recallTimer.unref();

  // ===== 转录落盘（M1b，2026-11-05）=====
  //
  // 重启后第一件事：把上次写盘的转录读回来。**在 NapCat 回填之前**——
  // 回填只有 20 条，而盘里是完整的一圈（最多 60 条）。回填自己会按 messageId 去重。
  try {
    const saved = transcriptStore.load();
    let chats = 0;
    let entries = 0;
    for (const [chatId, list] of Object.entries(saved)) {
      const n = engine.restoreTranscript(chatId, list);
      if (n > 0) {
        chats += 1;
        entries += n;
      }
    }
    if (entries > 0) log('info', `转录落盘：已恢复 ${chats} 个会话 / ${entries} 条`);
  } catch (error) {
    log('warn', '转录落盘：恢复失败（忽略，继续用回填）', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const TRANSCRIPT_SAVE_MS = 20 * 1000;
  const transcriptTimer = setInterval(() => {
    try {
      transcriptStore.replaceAll(engine.exportTranscripts());
    } catch (error) {
      log('debug', '转录落盘：本次写盘跳过', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, TRANSCRIPT_SAVE_MS);
  if (typeof transcriptTimer?.unref === 'function') transcriptTimer.unref();

  // ===== 话题状态影子泵（M3，2026-11-05）=====
  //
  // 每 3 分钟检查一次：某会话自上次抽取后新增至少 6 条消息，就用最近 20 条
  // 与当前开放事项重新判断一遍"还有哪些没说完"。结果只写 `qq-topics.json` 与日志，
  // **不进入提示词**；观察一周后再决定是否注入。
  const topicExtractor = createTopicExtractor({
    stream: typeof ctx.llm?.stream === 'function' ? (opts) => ctx.llm.stream(opts) : null,
    provider: precheckModel.provider,
    model: precheckModel.model,
    log,
  });
  const TOPIC_PUMP_MS = 3 * 60 * 1000;
  const TOPIC_MIN_NEW = 6;
  const TOPIC_WINDOW = 20;
  const topicLastAt = new Map();
  const topicPump = async () => {
    if (!topicExtractor.enabled) return;
    let transcripts = {};
    try {
      transcripts = engine.exportTranscripts();
    } catch (error) {
      log('debug', '话题影子：读取转录失败（忽略）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const [chatId, entries] of Object.entries(transcripts)) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      const lastAt = topicLastAt.get(chatId) ?? 0;
      const fresh = entries.filter((m) => Number(m.at) > lastAt);
      if (fresh.length < TOPIC_MIN_NEW) continue;
      const window = entries.slice(-TOPIC_WINDOW);
      try {
        const result = await topicExtractor.extract({ messages: window, open: topicStore.openOf(chatId) });
        if (result === null) continue;
        topicStore.setOpen(chatId, result.open);
        topicLastAt.set(chatId, Number(fresh[fresh.length - 1]?.at) || Date.now());
        log('debug', '话题影子：已更新开放事项（不注入）', { chatId, 条数: result.open.length });
      } catch (error) {
        log('warn', '话题影子：抽取异常（忽略这一轮）', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  const topicTimer = setInterval(() => {
    topicPump().catch((error) => {
      log('warn', '话题泵异常（忽略）', { error: error instanceof Error ? error.message : String(error) });
    });
  }, TOPIC_PUMP_MS);
  if (typeof topicTimer?.unref === 'function') topicTimer.unref();

  // ===== 开始灌历史（2026-10-13）=====
  //
  // 转录是**纯内存**的 ⇒ 插件一重载/重启就空。用户 2026-10-13 的要求是
  // 「只要进 llm 了就塞 20 条前文，**不管是多久的**」—— 那一条跨重启不成立，
  // 所以启动时（以及**连接就绪时**）从 NapCat 拉一次最近的历史补进去。
  //
  // 四条**位置决定**的约束（实现与注释都在 `history-backfill.mjs`）：
  //
  // 1. **异步、不 await、失败可忽略**。挂载那一刻 QQ 很可能还没登录
  //    （实测见过 `OneBot 未连接`）⇒ 拉取失败只能是"这次没前文"，
  //    **绝不能**拖慢或搞挂插件的 `apply()`。
  // 2. **只拉白名单里的会话**（判据复用 `router.proactiveAllowed`，
  //    不在白名单的群只被 OBSERVE，转录对它们没用）。
  // 3. 🔴 **只当上下文，绝不触发判定**。灌进去的唯一出口是两个只写内存的方法
  //    （`Transcript.restore` / `ChatState.restoreContext`）—— 这条路里
  //    **没有** `decide` / `#gate` / 任何 `dispatched++`。
  //    **开机后绝不能因为灌进来的旧消息去回一条 8 小时前的消息。**
  // 4. **ⓐ 启动试一次 → 失败不要紧 → ⓑ `ready` 时补一次，且只成功灌一遍**
  //    （2026-10-13 补）。**只在启动时拉一次是不够的**：实测那次失败
  //    （`startedAt = 12:56:55`）根本不是开机，是 **HMR 热重载** ——
  //    重载后 WS 要重新握手，而灌历史立刻就跑 ⇒ **每次改代码重载都灌不上**。
  //    而热重载恰恰是开发期最频繁的事件，所以"补一次"不是锦上添花。
  //
  // ⚠️ 放在 `gateway.attach()` **之后**：先让入站链路挂好，再补历史 ——
  // 反过来的话，历史灌完到 attach 之间进来的实时消息会被它们自己挤掉顺序
  // （`Transcript.restore` 是"追加"，它假设自己先于实时消息）。
  const backfillCount = Number(config.historyBackfillCount ?? HISTORY_BACKFILL_COUNT);
  let historyBackfill = null;
  /** `ready` 就绪钩子。关掉灌历史 / 卸载时要能摘掉它（匿名箭头函数没法 `off`）。 */
  let onTransportReadyForBackfill = null;
  if (config.historyBackfill === false) {
    historyBackfill = { enabled: false, reason: 'disabled', at: Date.now() };
    log('info', '灌历史已关闭（historyBackfill=false）', {});
  } else {
    const backfill = createHistoryBackfillController({
      engine,
      router,
      // 生产上就是 transport.action：字段会被平铺到顶层（见 `transport.mjs` 的注释）。
      call: (action, params, options) => transport.action(action, params, options),
      selfId: config.botQQ || transport.selfId || '',
      count: Number.isFinite(backfillCount) && backfillCount > 0 ? backfillCount : HISTORY_BACKFILL_COUNT,
      log,
      // `QQ → 昵称` 表（2026-10-14）：**灌历史时顺便把这一窗里每个人的名字学进去**。
      // 这条路是"改了 src ⇒ HMR 重载 ⇒ 内存里那张表没了"之后**能立刻自愈**的原因
      // （用户点名的要求：那条路也要喂进同一张表）。
      nicknames,
      // 每次**尝试**结束都把报告挂到快照上（不只最后一次）：
      // 这样"启动那次失败 / 连接就绪那次成功"这个前后关系在快照里看得见 ——
      // 报告自带 `trigger` 与 `attempts`，一眼能判"是哪一次灌成的"。
      onAttempt: (report, meta) => {
        if (report === null || report === undefined) {
          historyBackfill = { enabled: true, failed: true, trigger: meta?.trigger ?? null, attempts: meta?.attempts ?? null };
          return;
        }
        historyBackfill = {
          ...report,
          controller: meta === undefined ? undefined : {
            resolvedChats: meta.resolvedChats,
            pendingChats: meta.pendingChats,
          },
        };
      },
    });
    // ⓐ 启动试一次（**不 await**：拉取绝不能拖慢挂载）。
    void backfill.startup();
    // ⓑ 连接就绪时补一次。**必须用控制器**，不能直接再调一次灌历史 ——
    //    否则"启动那次已经成功"时会**再灌一遍**（转录里同一批消息出现两次）。
    //    控制器自己保证幂等（全部会话成功过 ⇒ 直接跳过，连 API 都不打）。
    //
    //    `ready` 每次连上都发（`transport.mjs` 里 `emit('ready')` 有两个发点：
    //    反向握手成功 / HTTP 探活成功），所以这里天然覆盖"重连后也要补"。
    onTransportReadyForBackfill = () => {
      void backfill.onConnected();
    };
    transport.on('ready', onTransportReadyForBackfill);
  }

  // 上线播报：插件启动时主动往 QQ 发一条，让用户知道"这边活着"。
  //
  // 为什么需要它：用户常在**外面**，只能靠 QQ 判断家里电脑的状态。而 DSH 每次重启
  // （改代码、改配置）都会让这边离线几十秒 —— 那段时间他发的消息没人接，
  // 看起来和"全挂了"一模一样。实测他因此两次以为机器坏了，
  // 原话：「我在外面都不知道现在家里电脑是什么状态」。
  //
  // ⚠️ **只在"跨进程"启动时播报，插件热重载不播报。**
  //
  // 踩过的坑：2026-10-04 给插件开了热重载之后，**每保存一次源码就会重新挂载插件**，
  // 而播报的触发条件就是"被挂载" —— 于是我改两轮代码，用户看到两次「（小鲸鱼上线了）」，
  // 以为我要反复重启，急得发「？？先别重启了」。
  //
  // 判据用**进程启动时刻**（`Date.now() - process.uptime()`）而不是 pid：
  // Windows 会复用 pid，而启动时刻在同一个进程内是恒定的、跨进程必然不同。
  //
  // 留空则不播报。走 `speakProactively`，因此照样受同一道出站白名单约束。
  const announceTo = String(config.onlineAnnounce ?? '');
  if (announceTo !== '') {
    const markPath = path.join(dshHome(), 'media', 'qq-proactive-announce.json');
    const processStartedAt = Math.round(Date.now() - process.uptime() * 1000);
    let lastAnnouncedAt = null;
    try {
      lastAnnouncedAt = Number(JSON.parse(fs.readFileSync(markPath, 'utf8')).processStartedAt);
    } catch {
      lastAnnouncedAt = null; // 没记录过 = 首次运行，该播报
    }
    const sameProcess = Number.isFinite(lastAnnouncedAt)
      && Math.abs(lastAnnouncedAt - processStartedAt) < 2000;

    if (sameProcess) {
      log('info', '上线播报跳过（同一次进程内的插件重载，不是重启）', { processStartedAt });
    } else {
      try {
        fs.writeFileSync(markPath, JSON.stringify({ processStartedAt, at: new Date().toISOString() }), 'utf8');
      } catch {
        /* 记不上就算了，大不了下次多播报一次 */
      }
      // 延迟几秒：刚起来时 transport 可能还没跟 NapCat 握上手。
      const timer = setTimeout(() => {
        gateway
          .speakProactively(announceTo, '（小鲸鱼上线了）')
          .catch(() => undefined);
      }, 4000);
      // 别让这个定时器拖住插件卸载。
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  // 运行时调试快照。
  //
  // 本插件的主动层**不建 DSH 会话、也不回复**，状态只活在内存里——从磁盘
  // 无法判断它有没有收到消息、转录有没有建起来、主动插话为什么没触发。
  // 之前每次排查都要用户复制粘贴控制台；把关键计数节流落盘后，
  // agent 可以自己读文件自证。
  //
  // 可用 `QQ_PROACTIVE_DEBUG_FILE=` 置空来关闭。
  const debugFile =
    process.env.QQ_PROACTIVE_DEBUG_FILE !== undefined
      ? String(process.env.QQ_PROACTIVE_DEBUG_FILE)
      : defaultDebugPath();
  const debug = createDebugWriter({
    filePath: debugFile,
    minIntervalMs: 10000,
    onError: (err) => log('debug', '调试快照写入失败', { error: err.message }),
  });
  // 补装备的**节流 + 观测**（2026-10-24）。
  //
  // 判据不在这里 —— 在 `binder.isEquipped(agent.ctx)`：它看 agent ctx 上的注册台账，
  // ctx 一换就自动变假、必须重补（这正是 2026-10-15 人格消失、2026-10-24 "105 轮里
  // 39 轮无人格"的根因：旧实现拿 `Set<sessionId>` 记"补过了"，ctx 换了它还说补过了）。
  // 这里的 Map **只做冷却**：补失败时（宿主版本没 systemPrompt/tools 之类）不要每个
  // 事件都重试、把日志刷满；冷却结束仍按台账重新判。
  const equipAttemptAt = new Map();
  const EQUIP_RETRY_MS = 5000;
  const equipStats = {
    checked: 0, ready: 0, refilled: 0, failed: 0, throttled: 0, lastAt: null, lastResult: '',
  };
  const writeSnapshot = (force = false) => {
    // ⚠️ 这里的异常【必须吞掉】—— 理由和下面"启动传输层"那段一模一样，
    // 而且在 2026-10-14 被真实事故验证过一次：
    //
    //   本函数挂在 `transport.on('event')` 上，是【每个入站事件都走】的热路径。
    //   任何异常都会变成未捕获异常 ⇒ DSH 判成插件加载失败 ⇒ **整个 App 起不来**
    //   （桌面端弹 "DeepSeek Harness is unavailable" + 那个三按钮恢复框）。
    //
    //   那次的原因：buildSnapshot 里引用了一个未定义的 `judgeLedgerStats`，
    //   ReferenceError 一路抛到宿主，**连崩三次**，每次都要手工恢复 profile
    //   （patch 被砍成 661 B + bundles 清空）。
    //
    //   ⇒ **写不出快照是小事，把宿主带下去是大事。** 宁可少一份诊断信息，
    //     也不能让"写诊断信息"这件事本身成为故障源。
    try {
      const snapshot = buildSnapshot({
        gateway,
        engine,
        transport,
        config,
        // 表情包库的计数：**"偷到底偷到没有"只能靠这几个数回答**
        // （落盘的东西在别的目录，从快照一眼判断库是不是在长）。
        stickerLibrary,
        // 灌历史的结果（条数 / 哪个会话失败 / 前 3 条正文预览）。
        //
        // 为什么必须进快照：这件事**完全异步、失败静默**，所以"没灌"在日志里
        // 只留一行 `info`，而**用户看得见的现象**是"小鲸鱼重启完像刚进群" ——
        // 没有这份结果，那个现象分不清是 ① NapCat 没连上 ② 白名单里没有这个会话
        // ③ 灌了但转录又被别处清空了。三个答案在这里各不相同。
        historyBackfill,
        // 心情：**开关 + 当前生效的 provider/model + 每个会话现在的心情**
        // （2026-10-14 加）。它是每条消息都可能触发一次云调用的东西，
        // 而在加这一段之前它**完全不可观测**（状态只在内存里）。
        // ⚠️ 两个参数分开传：`mood` 是管理器（`null` = 压根没构造 = 关掉了），
        //    `moodConfig` 是**生效值**（用户才能看见"关掉/正在跑的到底是哪条路"）。
        mood,
        moodConfig: moodCfg,
        // 「学来的记忆」（旧记忆库）的**生效值**（2026-10-16 加）。
        //
        // 为什么必须进快照：关掉之后的现象是"什么都没发生"（不再学到新东西、
        // 不再注入学来的条目），而"没关掉但恰好没学到东西"长得一模一样。
        // 光看日志分不出来 —— 快照里摆出这个布尔，加上"`learner` 到底构造了没有"
        // 那一条，"这一轮学不学"就是一眼能读的。
        learnedMemory: { enabled: memoryCfg.learnedEnabled, learnerBuilt: learner !== null },
        // A+B（2026-10-17）：知识注入的**生效值** + 最近一次的留痕。
        // "上限配了多少"和"实际注进去多少"分开记 —— 只看一个数看不出接线漏没漏。
        knowledgeInject: binder.knowledgeInjectStats(),
        // 最近一次建/接会话走的是哪条路（2026-10-21）：`{via, reason}`。
        // 恢复失败 ⇒ `via:'create'` + `reason` 是失败原因 —— 让"她失忆了"
        // 在快照里留痕，而不是只有一条会滚掉的日志。
        sessionMode: binder.sessionModeStats(),
        // 用户（2026-10-21）：契约 `{admins, source}` —— 由 `buildSnapshot` 里的
        // `ownerSnapshot(ownerCfg)` 统一成这个形状。
        owner: ownerCfg,
        // 小鲸鱼的推理等级（2026-10-21）：契约 `{reasoning, source}`。
        // 这一项以前只活在 `cordis.patch.yml` 里、快照里一个字都没有 ⇒
        // "我改成 high 了"与"改了但配置没被读"在现象上完全一样（都只是她变聪明/没变）。
        agent: agentCfg,
        // 代码新鲜度：`staleCode.stale === true` 就等于"这份快照描述的行为
        // 来自旧代码，改过的东西还没生效"，先重启再谈排查。
        watch: { dir: PLUGIN_SRC_DIR, since: MODULE_LOADED_AT },
      });
      // `[free_time]` 的**生效值**（2026-10-17）：本轮边界**不改 `debug-snapshot.mjs`**，
      // 所以在这里贴上去。为什么必须进快照：定时任务默认关着，而"关着"和"配了但没被读"
      // 在行为上**一模一样**（都什么都不做）—— 只有把生效值落盘，
      // "toml 到底被读了没有"才有证据（本项目最贵的坑：代码新 ≠ 配置被读）。
      // 配置 + 运行状态：只有配置的话，坏了（叫不醒 / 发不出去）一眼看不出来。
      snapshot.freeTime = {
        ...freeTimeCfg,
        ...(freeTimeRef.current === null ? {} : freeTimeRef.current.stats()),
      };
      // 补装备的观测（2026-10-24）：`ready` 在涨 = 宿主自己捡起会话那条路是齐的；
      // `refilled` 在涨 = 刚刚有 ctx 换了、补回来了；`failed` 一直涨 = 补不上（要看日志）。
      // 不写这个，"到底补了没有"又只能翻会话日志。
      snapshot.equip = { ...equipStats };
      // 自动搬运的观测（2026-11-02）：`sent` 在涨 = 宿主自己跑的轮次真的被搬出去了；
      // `skippedInFlight` 在涨 = 定时唤醒/内部通道那些轮次**照旧由 `runTurn` 自己发**（没被重复搬）。
      // 不看这几个数，"它到底动没动过"就只能翻会话日志。
      snapshot.autoRelay = autoRelay.stats();
      // 会话映射表的观测（2026-10-24，P1-4/P2-6）：条数 / 退休数 / 路径 / **当前策略**。
      // 迁移期要能一眼看出"表到底学到了多少张脸、有没有写进去"，不看内容（内容在文件里）。
      snapshot.sessions = { ...sessionResolver.stats(), policy: sessionResolver.policy };
      // 2026-10-19：**审核闸跑在哪条 provider/model 上** —— 之前只在挂载日志里说过一句，
      // 快照里查不到 ⇒ "toml 改了到底生效没有"只能翻日志/翻代码。
      // 这项目最贵的一类坑就是"静默不生效"，所以这条必须能被观测。
      snapshot.stickerGate = {
        provider: stickerGate.provider === '' ? (config.provider || 'deepseek-official') : stickerGate.provider,
        model: stickerGate.model === '' ? (config.model || 'deepseek-flash') : stickerGate.model,
        // `true` = toml 里手写了（手动赢，显存门控不插手这条调用）。
        manual: stickerGate.provider !== '' || stickerGate.model !== '',
        maxTokens: stickerGate.maxTokens,
        enableThinking: stickerGate.enableThinking === true,
      };
      // 2026-10-19：**显存门控 / 图片描述走哪条 provider/model** —— 同样要能观测。
      // `cloud` 那条是真正烧钱的；`local` 是本机免费 4B。之前也没有它。
      snapshot.visionGate = visionGateCfg === null
        ? { enabled: false }
        : {
          enabled: true,
          freeMiB: visionGateCfg.freeMiB,
          cloud: { provider: visionGateCfg.cloud.provider, model: visionGateCfg.cloud.model },
          local: { provider: visionGateCfg.local.provider, model: visionGateCfg.local.model },
        };
      debug.write(snapshot, force);
    } catch (error) {
      log('warn', '写调试快照时抛错（已吞掉，不影响运行）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // 每次入站事件之后落一次（节流），这是"有没有收到消息"最直接的证据。
  //
  // 注意挂的是 **transport** 的 `event`，不是 gateway —— gateway 本身不是
  // EventEmitter（它只是把 transport 的事件转发给 `handleEvent`）。
  //
  // ⚠️ 这两个监听**必须具名**（不能写成匿名箭头函数）—— 匿名的话关停时
  // 没法 `off`，只能指望"transport 被丢弃、监听器跟着消失"。
  // 而那个假设**对闭包不成立**（曾经因此漏掉一次卸载清理）。
  const onTransportEvent = () => writeSnapshot();
  const onTransportReady = () => writeSnapshot(true);
  transport.on('event', onTransportEvent);
  transport.on('ready', onTransportReady);

  // 群名这里也拉一次（2026-10-21）：启动后对白名单里的群调 `get_group_info`。
  //
  // ⚠️ 挂在 `ready` 上而不是挂载时直接调：反向模式要等 NapCat 拨进来才有连接；
  //    挂载那一刻 `action()` 必然抛"未连接"（那是最常见的假失败）。
  // ⚠️ 回调体自己吞异常（同 `writeSnapshot` 那条规则：这是外部事件回调）。
  const onTransportReadyForGroupNames = () => {
    if (groupNameTargets.length === 0) return;
    groupNames.refresh(groupNameTargets).catch((error) => {
      log('warn', '群名拉取出错（已吞掉，配置页回退显示号码）', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  transport.on('ready', onTransportReadyForGroupNames);

  // 挂载时先落一份（**force 无视节流**）。
  //
  // 为什么要有这一次：上面那两个监听都是**由外部事件驱动**的 —— 一条消息都没有
  // 之前，快照里读到的还是**上一次挂载**留下的内容。而恰恰在"刚改完配置、
  // 还没人来消息"的时候，人最想知道的就是"现在到底按哪套在跑"
  // （`mood` 段就是为这个加的）。开一次机写一次，这个窗口就没有了。
  //
  // 它在 try/catch 里（`writeSnapshot` 自己吞异常），所以不违反
  // 「回调必须自己吞异常」那条 —— 这里不是异步回调，是挂载路径上的同步调用。
  writeSnapshot(true);

  // 启动传输层：**失败必须软着陆，绝不能把异常抛出去**。
  //
  // 这里曾经是 `.catch(err => { log('error', ...); throw err; })` —— 想法是
  // "失败要让宿主看到，不静默"，但**做法是错的**：连接失败是**运行时**问题
  // （NapCat 没开、端口不对、网络抖动），不是配置错误。抛出去会让 DSH 认为
  // 插件加载失败，进而**整个 App 起不来**（实测：桌面端弹
  // "The application could not start or stopped unexpectedly"）。
  //
  // 正确做法与 `dsh-onebot-qq` 一致：记录日志 + 后台按退避重试，
  // 让插件处于"已加载但未连接"状态，NapCat 起来后自动接上。
  let started = false;
  let attempt = 0;
  let retryTimer = null;

  const targetDesc = () => {
    if (config.mode === 'reverse') return `${config.host}:${config.port}`;
    return config.mode === 'http' ? config.httpUrl : config.url;
  };

  const connect = async () => {
    attempt += 1;
    try {
      await transport.start();
      started = true;
      attempt = 0;
      log('info', `QQ 通道已启动（${config.mode}）`, { target: targetDesc() });
    } catch (error) {
      const delay = backoffDelay(attempt);
      log('warn', `QQ 通道连接失败，${Math.round(delay / 1000)} 秒后重试`, {
        target: targetDesc(),
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      retryTimer = ctx.setTimeout(() => {
        retryTimer = null;
        connect().catch(() => undefined);
      }, delay);
      if (typeof retryTimer?.unref === 'function') retryTimer.unref();
    }
  };

  // 刻意不 await：让 apply 立刻返回，插件视为"已加载"。
  // 连接在后台上推进，成功与否都不影响宿主加载。
  const startPromise = connect();

  // `sessions` 服务是**可选**的（同 connection/webServer）：宿主不一定暴露它。
  // 用可变引用 + 条件注入，缺了也不影响插件加载（模块级 inject 会让整个插件挂起）。
  /** @type {{current: any}} */
  const sessionsRef = { current: null };
  ctx.inject(['sessions'], (sessionCtx) => {
    sessionsRef.current = sessionCtx.sessions;
    return () => {
      sessionsRef.current = null;
    };
  });

  // 接上工作完成汇报。
  // 注意这里必须读 `config`（经 resolveConfig 合并后的用户配置），
  // 不是 `CONFIG_SHAPE`（那是默认值）——读错了的话用户在 YAML 里开的工作汇报
  // 永远不会生效，而且日志里也看不出来。
  if (config.report.enabled) {
    attachReportBridge({ ctx, gateway, config, log, sessionsRef, isChat: (id) => sessionResolver.has(id) });
  }

  // 自动搬运的事件订阅（2026-11-02）。
  //
  // 判据一句话：**`turn/end` 时，这个会话能映射到白名单里的 QQ chatId、这一轮不是
  // `runTurn` 驱动的、正文非空、不是 `[不说话]`、这一轮没调过 `send_qq` ⇒ 发。**
  // 细节与理由全在 `dsh/auto-relay.mjs` 的模块注释里。
  //
  // ⚠️ 回调**必须自己吞异常**：`session/event` 是宿主事件循环上的最后一层，
  //    抛出去 = 宿主退出（本项目崩过三次）。所以这里两层防护：
  //    `observe()` 内部有一层，外面再包一层 —— 并且 `observe` 是 async 的，
  //    必须 `.catch()`，否则 reject 会变成未处理的 Promise 拒绝。
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          Promise.resolve(autoRelay.observe(session, event)).catch((error) => {
            try {
              log('warn', '自动搬运失败（已忽略）', {
                error: error instanceof Error ? error.message : String(error),
              });
            } catch {
              /* 连日志都失败就放弃这一条 */
            }
          });
        } catch (error) {
          try {
            log('warn', '自动搬运出错（已忽略）', {
              error: error instanceof Error ? error.message : String(error),
            });
          } catch {
            /* 同上 */
          }
        }
      }),
    'qq-proactive: auto relay',
  );

  // 「宿主自己捡起会话」那条路的补装备（2026-10-24 重写）。
  //
  // ## 为什么必须注册在【apply 作用域】里
  //
  // 这段以前写在模块级函数 `attachReportBridge()` 里，而 `binder` 是 `apply()`
  // 的局部变量 ⇒ 那里的 `typeof binder !== 'undefined'` **恒为假**，
  // 整个"补装备"分支从来没执行过（只留了个前缀判断在那儿）。所以 2026-10-24 的
  // `78463d1`（本意是修裸轮）实际是死代码；"GUI 105 轮里 39 轮无人格"当然不会好。
  //
  // ## 判据：不是"我补过了"，而是"这个 agent ctx 上现在有没有"
  //
  // 旧实现是 `Set<sessionId>`：补一次就记下 id。两个问题：
  // ① `/^(qq|onebot)-/` 在 id 换成标准 uuid 后恒假（迁移清单 §3 #2）；
  // ② 补进去的 `tools.register` / `systemPrompt.section` 都是挂在 **agent ctx 上的
  //    effect**，ctx 一换（HMR 后 agent 重建 / 宿主重新 resume）全死，**Set 还说补过了**
  //    ⇒ 永不重补。2026-10-15 人格消失、2026-10-24 统计的 39/105 都是这个形状。
  // ⇒ 现在按 `binder.isEquipped(agent.ctx)` 判（查 ctx 上的注册台账）：ctx 换 ⇒ 台账没
  //   ⇒ 自动判"不齐" ⇒ 重补。
  //
  // ## 下面那个 Map 只是节流
  //
  // `session/event` 是热路径；台账判"不齐"时如果每个事件都真去补，遇到"宿主没
  // tools/systemPrompt"之类的硬失败会把 warn 刷满。5 秒冷却足够，判据仍是台账。
  //
  // ## 哪些会话才补
  //
  // 必须排除主会话/子会话，否则会把 QQ 的三件工具和人格挂到别的 agent 上。
  // 两个来源：① `binder.live` 里已登记（create/adopt 过）；② 迁移前的旧 id 形状。
  // ⚠️ 迁移到标准 uuid 后 ② 要换成映射表的 `hasSession()`（见清单 §3 #2/#28）。
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          const sessionId = String(session?.id ?? '');
          equipStats.checked += 1;

          // `binder` 在这个作用域里一定存在（本段就在 apply 内），但保留 null 守卫：
          // 装配顺序一旦变动，宁可什么都不做，也不能在事件回调里抛 ⇒ 宿主退出。
          if (binder === null || binder === undefined) return;

          // 本插件管的会话：映射表认识（uuid 之后靠这条）、binder 登记过、或旧前缀。
          const managed = sessionResolver.has(sessionId)
            || (binder.live instanceof Map && binder.live.has(sessionId))
            || /^(qq|onebot)-/.test(sessionId);
          if (!managed) return;

          const agent = typeof binder.findLiveAgent === 'function'
            ? binder.findLiveAgent(sessionId)
            : undefined;
          if (agent === null || agent === undefined) return;

          if (typeof binder.isEquipped === 'function' && binder.isEquipped(agent.ctx)) {
            equipStats.ready += 1;
            equipStats.lastResult = 'ready';
            equipStats.lastAt = new Date().toISOString();
            return;
          }

          const at = Date.now();
          const last = equipAttemptAt.get(sessionId) ?? 0;
          if (at - last < EQUIP_RETRY_MS) {
            equipStats.throttled += 1;
            equipStats.lastResult = 'throttled';
            equipStats.lastAt = new Date().toISOString();
            return;
          }
          equipAttemptAt.set(sessionId, at);
          const ok = typeof binder.equipLiveAgent === 'function'
            && binder.equipLiveAgent(sessionId, 'event');
          equipStats.lastResult = ok ? 'refilled' : 'failed';
          if (ok) equipStats.refilled += 1;
          else equipStats.failed += 1;
          equipStats.lastAt = new Date().toISOString();
        } catch (error) {
          // 挂在外部事件上的回调**必须自己吞异常**（2026-10-14 的教训：抛出去 =
          // 插件加载失败 = 宿主起不来）。这里连日志都只打 debug，免得刷屏。
          try {
            log('debug', '补装备失败（已忽略）', {
              sessionId: String(session?.id ?? ''),
              error: error instanceof Error ? error.message : String(error),
            });
          } catch {
            /* 连日志都失败就彻底放弃这条 */
          }
        }
      }),
  );

  // 设置页的宿主半：**条件加载**，绝不写进模块级 inject。
  //
  // 写成模块级 inject 的后果实测过：纯 headless 部署里整个插件会挂起
  // （`pending (waiting for services: connection, webServer)`），
  // QQ 通道完全不工作——为了一个可选功能把主体功能搭进去，很不值。
  // 所以用 `ctx.inject([...], cb)`：服务齐了才跑 cb，缺了插件照常工作。
  //
  // 另外这里是 `connection.register(owner, channel, handler)` 而不是
  // `connection.rpc.handle(channel, handler)`。原因见下：
  // `rpc.handle` 内部是 `this.register(this.ctx, …)`，而 `this.ctx` 是服务构造时
  // `super(ctx, "connection")` 存下的那个 ctx；`register` 结尾要
  // `owner.webServer.register(route)`，**可那个 ctx 上访问不到 webServer**
  // （库里只对 `webCtx` 做了 `ctx.inject(["webServer"], (webCtx) => …)`，
  // 那不会让外层 ctx 获得它）。于是 `rpc.handle` 必然抛
  // `cannot get property "webServer" without inject`，与插件 inject 了什么无关。
  // `register` 的第一个参数就是 owner，正好让我们把注入过的 ctx 传进去。
  const settingsHandler = createSettingsHandler({
    ctx,
    getConfig: () => liveConfig,
    getStatus: () => ({
      connected: transport.isReady === true,
      selfId: safeSelfId(transport),
      liveSessions: binder.live.size,
      stats: { ...gateway.stats },
    }),
    log,
  });

  // 临时配置服务（2026-10-21）：整个插件**只造一个实例**，生命周期跟着 fiber。
  //
  // 它平时不监听任何端口 —— `createConfigServer` 只是个对象，`open()` 才会
  // `listen(0, '127.0.0.1')`。所以这里造出来不花任何代价，也不会留下入口。
  // 配置页的 HTML 在启动时读一次 `web/index.html`，作为页面模板注入临时服务。
  //
  // ⚠️ 这段代码在插件的 apply 阶段执行：任何抛出的异常都会让插件加载失败，
  // 进而导致宿主进程退出（用户看到的是"重复打开 DSH"）。因此 `readPageHtml`
  // 自身把读文件的全部失败形态归并成空串，这里再加一层兜底。
  // 传空串不会导致页面不可用：`createConfigServer` 会退到「每次请求现读
  // web/index.html」，两者都拿不到才用内联占位页。
  //
  // 注意生效范围：`app.js` / `logic.mjs` / `style.css` 每次请求现读磁盘，改完按 F5
  // 就能看到；`index.html` 走的是这份启动时快照，改动需要重载插件才可见。
  let configPageHtml = '';
  try {
    configPageHtml = readPageHtml();
  } catch {
    // readPageHtml 内部已经吞掉异常，这一层只防它未来被改动。
    configPageHtml = '';
  }

  // 临时服务要把 `/dsh-qq-proactive/*` 转发到主 webServer，因此需要主服务器的
  // 地址。此刻还拿不到：`webServer` 服务尚未注入，它的端口更要等绑定之后才知道。
  // 所以这里传一个**惰性求值器**，地址在每次转发时现取；`webServer` 一旦注入就可用。
  // `resolveWebServerOrigin` 自己吞掉全部异常并返回空串（取不到就回 502，
  // 绝不猜端口），因此这段不会把插件的 apply 阶段弄挂。
  let upstreamWebServer = null;

  // 配置页的固定端口与"跨重载接回"的落脚点（2026-10-29）。
  //
  // - `configPagePort`（默认 19390）：想绑的固定端口；`0` = 回到每次随机。
  // - `stateFile`：`{port, token}` 落盘位置（`<DSH_HOME>/media/qq-config-page.json`，
  //   与 `qq-proactive-*.json` 同目录）。没有 `DSH_HOME`（测试进程）时为空串 ⇒
  //   `createConfigServer` 关掉持久化，行为与改动前等价。
  const configPageStateFile = defaultConfigPageStatePath();

  const configServer = createConfigServer({
    log,
    // 默认不打开浏览器（配置服务模块的默认值是 null），真正的打开器在这里注入。
    openBrowser: (target) => openSystemBrowser(target),
    pageHtml: configPageHtml,
    upstream: () => resolveWebServerOrigin(upstreamWebServer),
    preferredPort: config.configPagePort,
    stateFile: configPageStateFile,
  });

  try {
    ctx.inject(['connection', 'webServer'], (webCtx) => {
      try {
        const connection = webCtx.connection;
        if (connection === undefined || connection === null || typeof connection.register !== 'function') {
          log('info', '没有 connection 服务，设置页不可用（QQ 通道本身照常工作）', {});
          return;
        }
        webCtx.effect(
          () => connection.register(webCtx, SETTINGS_CHANNEL, settingsHandler),
          `qq-proactive: settings rpc ${SETTINGS_CHANNEL}`,
        );
        log('info', `设置页 RPC 已挂载 ${SETTINGS_CHANNEL}`, {});
      } catch (error) {
        log('warn', '挂载设置页 RPC 失败（不影响 QQ 通道本身）', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  } catch (error) {
    log('debug', '条件加载设置页 RPC 失败', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 配置页的 HTTP 路由（`[free_time]`：读 / 写 / 重载，2026-10-17）。
  //
  // 与上面那段设置页 RPC **分开注入**：这几条只依赖 `webServer`，
  // 与 QQ 连接无关。写进同一个 `ctx.inject(['connection','webServer'])` 里的话，
  // 没有 connection 的部署会连这几条只读路由都挂不上（为一个可选功能把主体搭进去
  // —— 和上面那段注释记的是同一个教训）。
  try {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        const webServer = webCtx.webServer;
        if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
          log('info', '没有 webServer 服务，配置页 HTTP 路由不可用（QQ 通道本身照常工作）', {});
          return;
        }
        // 临时配置服务的转发上游就是这里的主 webServer。存下服务实例本身而不是
        // 当下算好的地址：端口要等它绑定之后才读得到，`resolveWebServerOrigin`
        // 在每次转发时现取，拿不到就返回空串（转发回 502）。
        upstreamWebServer = webServer;
        log('info', '配置页转发的上游已接上主 webServer', {});
        const routes = [
          ...createFreeTimeHttpRoutes({
            tomlPath: config.tomlPath ?? defaultTomlPath(),
            freeTimeCfg,
            memoryCfg,
            ownerCfg,
            personaSections,
            // 进程里其它段的生效值（`fields[].effective` 用）。
            effective: {
              personality: personaSections.global,
              owner: { admins: ownerCfg.admins },
              freeTime: freeTimeCfg,
              memory: memoryCfg,
              send: sendCfg,
              // B4（2026-10-25）：`[voice]` 的生效值 —— 配置页据此显示"改了但没重载"。
              voice: voiceCfg,
              // 2026-10-26：`[tts]` 的生效值（同一条口径）。
              tts: ttsCfg,
              mood: moodCfg,
              // 2026-10-30：`[prompt]` 段与预检系统段的生效值。
              prompt: { ...(promptCfg ?? {}) },
              // 2026-10-30：三条视觉旁路 + 留样的生效值（配置页"生效值"一列要用）。
              sticker: stickerGate,
              vision: {
                ...(visionGateConfig ?? {}),
                // 2026-10-30：两套图片描述 system 也进生效值（否则页面这一列永远是默认值）。
                descSystemDetailed: String(visionGateCfg?.descSystemDetailed ?? ''),
                descSystemBrief: String(visionGateCfg?.descSystemBrief ?? ''),
              },
              stickerAudit: stickerAuditCfg,
              proactive: {
                judge_mode: judgeMode,
                // 2026-11-01：私聊那套判定模式的生效值（空串 = 跟随全局）。
                judge_mode_private: judgeModePrivate,
                precheck_model: String(proactiveMerged?.precheck_model ?? ''),
                // 2026-10-30：两段提示词文本的生效值（文件里写了什么 ⇒ 这里就是什么；
                // 空串 ⇒ 代码里那两句原文，页面显示为空代表"用兜底"）。
                interject_prompt: String(proactiveMerged?.interject_prompt ?? ''),
                precheck_system: String(proactiveMerged?.precheck_system ?? ''),
              },
              // 小鲸鱼的推理等级（2026-10-21）：配置页的 `effective` 就是这个值 ——
              // 它和 `file` 里的 `[agent] reasoning` 不同 = 改过但没重载。
              agent: agentCfg,
            },
            allowFrom: config.allowFrom,
            groupAllowFrom: config.groupAllowFrom,
            // 2026-10-30：`[prompt]` 的生效值 —— `/prompt-preview` 用它拼最终提示词。
            promptCfg,
            workspacePath: String(config.workspacePath ?? ''),
            groupNames,
            nicknames,
            backupDir: defaultBackupDir(),
            snapshotPath: debugFile,
          }),
          // 临时配置服务的启停开关（2026-10-21）：open / close / status。
          //
          // ⚠️ 它们挂在**主 webServer** 上，与临时服务自己的那三条端点
          // （`/status`、`/heartbeat`、`/`）是两套东西。分开的理由很实际：
          // 临时服务关掉之后这一组必须仍然在，否则"再点一次打开"就没有入口了。
          //
          // `POST .../open` 接受一个可选的 JSON 请求体 `{ "openBrowser": false }`，
          // 字段由 config-server.mjs 的路由 handler 自己解析：`false` 只起服务、
          // 不 spawn 系统浏览器（内部与测试验证数据时用），缺省等价于 `true`。
          // 这里不做二次处理 —— 路由定义与它必须保持一致，重复解析只会制造分叉。
          ...createConfigServerRoutes({ configServer, log }),
        ];
        webCtx.effect(
          () => {
            const disposers = routes.map((route) => webServer.register(route));
            return () => {
              for (const dispose of disposers) {
                try {
                  if (typeof dispose === 'function') dispose();
                } catch {
                  /* 卸载失败不该影响别的路由 */
                }
              }
            };
          },
          'qq-proactive: config page http routes',
        );
        log('info', `配置页 HTTP 路由已挂载 ${FREE_TIME_ROUTE_BASE}`, {});

        // 加载时自动起一次临时配置服务（**不弹浏览器**，2026-10-29）。
        //
        // 目的：插件热重载后，用户浏览器里那个配置页能**原地接回**——前端断开后每
        // 1.5 秒轮询同一个 origin，最多 30 秒；而端口与令牌都跨重载持久化
        // （见 `config-server.mjs` 头部），所以这一次 `open()` 会把旧端口抢回来、
        // 复用旧令牌。不自动起的话，新实例根本不监听，页面那 30 秒必然落空。
        //
        // 三条纪律，缺一条都会出事故：
        // 1. **fire-and-forget**：不 await，`apply` 不等监听结果；
        // 2. **try/catch + 双参 `.then`**：挂载期抛异常 = 宿主起不来
        //    （这个项目为此崩过三次）；
        // 3. **`openBrowser: false`**：每次重载都弹一个标签页是不能接受的。
        //
        // 失败只记 debug，绝不阻止插件加载；用户没有页面开着时，服务 15 秒后自己关。
        // 放在路由注册**之后**：页面一打开就能读到主 webServer 上的配置路由（否则
        // 头几百毫秒会是 502）。
        try {
          const autoOpen = configServer.open({ openBrowser: false });
          if (autoOpen !== null && typeof autoOpen === 'object' && typeof autoOpen.then === 'function') {
            autoOpen.then(
              (opened) => {
                log('info', '配置页服务已就绪（插件加载时自动打开，未弹浏览器）', {
                  port: opened?.port ?? 0,
                  state: opened?.state ?? '',
                });
              },
              (error) => {
                log('debug', '插件加载时自动打开配置页服务失败（不影响插件本身）', {
                  error: error instanceof Error ? error.message : String(error),
                });
              },
            );
          }
        } catch (error) {
          log('debug', '插件加载时自动打开配置页服务失败（不影响插件本身）', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } catch (error) {
        log('warn', '挂载配置页 HTTP 路由失败（不影响 QQ 通道本身）', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  } catch (error) {
    log('debug', '条件加载配置页 HTTP 路由失败', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 空闲会话释放（省内存；会话已持久化，之后能 resume）。
  const evictHours = Number(config.sessionIdleEvictHours);
  if (Number.isFinite(evictHours) && evictHours > 0) {
    const intervalMs = 30 * 60 * 1000;
    ctx.effect(
      () =>
        ctx.interval(() => {
          binder.evictIdle(evictHours * 3600 * 1000).catch((error) => {
            log('warn', '释放空闲会话时出错', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, intervalMs),
      'qq-proactive: idle session eviction',
    );
  }

  // 心情平复：定时对所有会话做心情回落（拟人化 —— 一段时间没关注，心情自动平复）。
  //
  // ⚠️ `[mood] enabled = false` 时 `mood` 是 `null` ⇒ **这里连定时器都不建**
  //    （关掉 = 一条路都不留，不是"建起来再在里面判空"）。
  //    回调体自己吞异常：它挂在**定时器**上，抛出去就是宿主进程里的未捕获异常。
  if (mood !== null) {
    ctx.effect(
      () =>
        ctx.interval(() => {
          mood.regressAll().catch((error) => {
            log('warn', '心情平复出错', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, 60 * 1000),
      'qq-proactive: mood regress',
    );
  }

  // 停机关停：fiber 停止时把连接、会话、定时器都收干净。
  //
  // ⚠️ 重复 apply（配置 live reload）时，任何"没显式 stop 的后台循环"
  //    都会一份一份地堆起来 —— 表现是同一个动作被做两次，而且计数看起来都正常。
  ctx.effect(
    () => () => {
      gateway.stop();
      // **定时器也要显式清**，不能指望"对象被丢弃、定时器就没了"。
      //
      // 2026-10-04 排查长驻资源时补的。两处之前都漏了：
      //   1. 学习回写的防抖定时器（`saveLearnedTimer`）—— 卸载后它还会跑一次、
      //      往磁盘写一遍记忆。无害，但那是"卸载后仍在活动"，本身就是错的信号。
      //   2. 我给调试快照挂的两个 transport 监听 —— 靠"transport 被丢弃、
      //      监听器跟着消失"活着。**这个假设对闭包不成立**，
      //      所以显式 `off` 才算数。
      if (saveLearnedTimer !== null) {
        clearTimeout(saveLearnedTimer);
        saveLearnedTimer = null;
      }
      transport.off('event', onTransportEvent);
      transport.off('ready', onTransportReady);
      // 群名拉取的 `ready` 钩子同样显式摘掉（同一条理由：闭包不会跟着 transport 消失）。
      transport.off('ready', onTransportReadyForGroupNames);
      // 灌历史的 `ready` 钩子同理必须显式摘掉（同一条理由：闭包不会跟着 transport 消失）。
      // ⚠️ 它里面那个控制器**没有定时器**（连接就绪才触发、且幂等），所以摘掉监听就干净了。
      if (onTransportReadyForBackfill !== null) {
        transport.off('ready', onTransportReadyForBackfill);
        onTransportReadyForBackfill = null;
      }
      // 卸载前把还没落盘的记忆状态刷掉（都幂等、失败只 warn）。
      try {
        transcriptStore.dispose();
        recallStore.dispose();
        relationLedger.dispose();
        topicStore.dispose();
      } catch {
        /* 收尾失败不影响卸载 */
      }
      Promise.allSettled([transport.stop(), binder.dispose()]).catch(() => undefined);
      // 临时配置服务也要关（2026-10-21）。它的监听端口、令牌、心跳定时器都在
      // `close()` 里清；漏掉的后果是**卸载后仍有一个端口在听**——那正是这套
      // 临时服务要避免的事（"平时没有任何监听端口"）。`close()` 幂等，重复调无害。
      try {
        configServer.close();
      } catch (error) {
        log('warn', '关闭临时配置服务失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    'qq-proactive: shutdown',
  );

  log('info', 'qq-proactive 已挂载', {
    dm: config.dmPolicy,
    group: config.groupPolicy,
    proactive: config.proactive.enabled === true,
    // 动态心情：**开关 + 走哪条模型**。它是每条消息都可能触发一次云调用的东西，
    // 挂载时留痕 = "烧的是哪笔钱"第一眼能看见（2026-10-14 加）。
    mood: {
      enabled: moodCfg.enabled,
      provider: moodCfg.provider,
      model: moodCfg.model,
      reasoningEffort: moodCfg.reasoningEffort,
    },
    // 群会话禁用哪些工具 —— 挂载时记一笔。工具名不是秘密，而"限制到底有没有
    // 装上去"是排查时第一个要问的问题（名单为空 = 群里不限制任何工具）。
    denyToolsInGroup: groupDenyTools,
    // 群会话挂哪份 preset。**这一条决定了子会话拿到哪些工具**，所以更要在挂载日志里
    // 留痕：不在这一行的话，"群里到底跑的是不是那份减配的"只能去翻会话 header。
    // `undefined` = 没配（按 `agentPreset` 推导）；`''` = 群跟私聊同一份。
    groupAgentPreset: groupAgentPreset === undefined ? '<推导 agentPreset + -lite>' : groupAgentPreset,
    // 图片描述模式。**"小鲸鱼说看不到图"时第一个要问的就是它**：
    // `off` / 没注入描述器 = 一个描述都不会有，全部是 `[图片]` 占位符。
    imageDescription: config.imageDescription,
    // 本地原件目录模板的**条数**（不记完整路径：路径里有账号，日志可能被贴出去）。
    // 它决定了"零网络拿原件"这条路通不通，所以要在挂载时留痕。
    imageOriginalDirs: config.imageOriginalDirs.length,
    // 缓存表路径：表坏了/没开时，这一行是第一个要看的（空串 = 明确关掉）。
    imageDescCachePath: config.imageDescCachePath,
    // 表情包库：偷的开关 + 两个路径（空串 = 明确关掉那一半）。
    // 与上面两条同一个理由 —— "偷没偷到东西"第一个要问的就是这几个值。
    stickerSteal: config.stickerSteal === true,
    stickerDir: config.stickerDir,
    stickerIndexPath: config.stickerIndexPath,
    stickerLibSize: stickerLibrary.stats().index.size,
    // 审核留样：**目录 + 上限 + 已写了几张**。用户要自己当标注员，
    // 所以"留样开着没、存哪儿了"必须在挂载日志里一眼看到。
    stickerAudit: {
      enabled: stickerAudit.enabled(),
      dir: stickerAudit.dir(),
      maxFiles: stickerAuditCfg.maxFiles,
      maxBytes: stickerAuditCfg.maxBytes,
    },
    // 定时任务（`[free_time]`）的生效值。**默认关着**，而"关着"与"toml 没被读到"
    // 在行为上完全一样 —— 挂载时留一笔，配合快照里的 `freeTime` 才能分开这两档。
    freeTime: { ...freeTimeCfg },
    // 用户（2026-10-21）：用的哪个号 + 从哪来。回退是**静默**的，所以必须留痕。
    owner: { qq: ownerQq === '' ? null : ownerQq, source: ownerCfg.source, admins: ownerCfg.admins.length },
    // 小鲸鱼的推理等级（2026-10-21）：生效值 + 从哪来。
    // 这一项直接决定"一句闲聊会不会被当调研跑满 50 步"，所以挂载时留一笔。
    agent: { reasoning: agentCfg.reasoning, source: agentCfg.source },
    // 群名缓存：路径 + 已缓存几个（取不到名字时前端显示号码）。
    groupNames: { path: groupNames.file(), cached: Object.keys(groupNames.names()).length },
  });

  return { transport, gateway, engine, binder, mood, writeSnapshot, startPromise, started: () => started };
}

/**
 * 工作完成汇报：监听工作会话的轮次结束，把**摘要**同步到指定 QQ 会话。
 *
 * 只在**非 QQ 会话**上触发——QQ 会话自己的轮次结束不该再往群里播报一次，
 * 那就是机器人自己复读自己。
 *
 * 摘要是真摘要（见 [report.mjs](./report.mjs)）：会话短 id、轮次、结果、
 * 这一轮动过哪些工具、以及一条结论。**不整段搬模型回复**——那种内容又长又含
 * 代码与路径，搬到群里既不合语境也刷屏。
 *
 * 频率限制按**每个会话**分别记账：早先只有一个全局 `lastReportAt`，
 * 结果一个活跃会话会把其他会话的汇报全部挤掉。
 *
 * @param {object} options
 * @param {(sessionId: string) => boolean} [options.isChat]
 *   判断"这是不是 QQ 聊天会话"（2026-10-24 P1-4：装配层传映射表解析器；
 *   不传 ⇒ 回退旧前缀，行为不变）。
 */
function attachReportBridge({ ctx, gateway, config, log, sessionsRef, isChat = null }) {
  const target = String(config.report.target);
  const minIntervalMs =
    Math.max(0, Number(config.report.minIntervalMinutes) || 0) * 60 * 1000;
  /** @type {Map<string, number>} 每个会话自己的上次出声时刻（防刷屏）。 */
  const lastReportAt = new Map();

  const gateOptions = () => ({
    awayMode: config.report.awayMode === true,
    onlyWhenBlocked: config.report.onlyWhenBlocked !== false,
    waitingNotifyAfterMinutes: Number(config.report.waitingNotifyAfterMinutes) || 90,
  });

  /** 统一的"要不要出声"判定（与 notifier.mjs 同一套规则）。 */
  const decide = (sessionId, session, events, now) => {
    const state = readSessionState(events);
    const verdict = shouldNotify({
      now,
      waiting: state.waiting,
      blockedSince: state.blockedSince,
      createdAt: Number(session?.header?.createdAt) || 0,
      turn: state.turn,
      ...gateOptions(),
    });
    if (!verdict.notify) return null;
    if (now - (lastReportAt.get(sessionId) ?? 0) < minIntervalMs) return null;
    return { ...state, reason: verdict.reason };
  };

  const snapshot = (session) => {
    try {
      return typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
    } catch (error) {
      log('debug', '读取会话事件失败，汇报将退化为简要文案', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  /**
   * 「顺便看一眼」——用户设计的调度方式。
   *
   * 原话：「其实不需要在工作的时候挂着计时器，只需要聊天的时候，聊天子会话汇报上来
   * 激活核心的时候顺便偶尔看一眼就行了，qq群不缺消息」
   *
   * 所以**没有为汇报单独挂定时器**：扫描由聊天会话的轮次驱动，聊天群本身就是心跳。
   * 而且判定用的是"此刻是否处于阻塞态"，一个会话不再阻塞（你回了、它继续跑了）
   * 就不再匹配，天然去重。
   */
  const scanWorkSessions = (now) => {
    const sessions = sessionsRef.current;
    if (sessions === null || typeof sessions?.list !== 'function') return;
    if (!gateway.router.proactiveAllowed(target)) return;

    let live = [];
    try {
      live = sessions.list() ?? [];
    } catch (error) {
      log('debug', '列举会话失败，本次跳过巡检', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // 收集"该喊他"的会话，聚成一条消息发出——比一个会话一条消息清爽得多。
    const alerts = [];
    for (const session of Array.isArray(live) ? live : []) {
      try {
        const sessionId = String(session?.id ?? '');
        if (sessionId === '' || isChatSession(sessionId, isChat)) continue;
        const events = snapshot(session);
        const decision = decide(sessionId, session, events, now);
        if (decision === null) continue;
        alerts.push({ id: sessionId, turn: decision.turn, kind: decision.kind, reason: decision.reason, events });
      } catch (error) {
        log('debug', '巡检某个会话时出错，跳过它', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (alerts.length === 0) return;

    const text = buildAlert(
      alerts.map((a) => ({ id: a.id, turn: a.turn, kind: a.kind, reason: a.reason })),
      { shortId, maxChars: Number(config.report.maxChars) || 600 },
    );
    if (text === '') return;

    const sentAt = Date.now();
    for (const a of alerts) lastReportAt.set(a.id, sentAt);
    gateway.speakProactively(target, text).catch((error) => {
      // 发送失败要把时刻还回去，否则这次白白占掉一个窗口。
      for (const a of alerts) lastReportAt.delete(a.id);
      log('warn', '工作汇报发送失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          const sessionId = String(session?.id ?? '');

          if (event?.type !== 'turn/end') return;

          // 聊天会话自己的轮次结束 = 「顺便看一眼」的时机。
          //
          // 这是用户要的调度方式：不为汇报挂计时器，借聊天的心跳来巡检。
          // 注意这里**只借时机**，聊天会话本身永远不会被汇报（见下）。
          if (isChatSession(sessionId, isChat)) {
            scanWorkSessions(Date.now());
            return;
          }

          if (!gateway.router.proactiveAllowed(target)) return;

          const now = Date.now();
          const events = snapshot(session);
          const decision = decide(sessionId, session, events, now);
          if (decision === null) return;

          const text = buildWorkReport({
            events,
            turn: decision.turn,
            sessionId,
            reason: { kind: decision.kind },
            maxChars: Number(config.report.maxChars) || 600,
          });
          if (text === '') return;

          lastReportAt.set(sessionId, now);
          gateway.speakProactively(target, text).catch((error) => {
            // 发送失败要把时刻还回去，否则这一轮就白白占掉了一个汇报窗口。
            lastReportAt.delete(sessionId);
            log('warn', '工作汇报发送失败', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        } catch (error) {
          // 事件监听器绝不能把异常抛回宿主的事件循环。
          log('warn', '工作汇报桥出错', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    'qq-proactive: report bridge',
  );

  log('info', `工作汇报已开启，目标 ${target}，每会话最短间隔 ${minIntervalMs / 60000} 分钟`, {});
}

/** 安全读传输层的机器人 QQ（它可能还没学到）。 */
function safeSelfId(transport) {
  try {
    return String(transport?.selfId ?? '');
  } catch {
    return '';
  }
}

/** 统一的日志出口。
 *
 * 优先走宿主的 `ctx.logger`（Cordis 的 LoggerService，`error/info/warn/debug`
 * 挂在原型上，调用后会建一个以 fiber 命名的 Logger）。
 *
 * **但一定同时写 stderr**：宿主是否注册了终端 exporter 不由插件决定；
 * 一旦没有出口，日志就只进 `ctx.logger` 的内存缓冲里，插件看起来像"什么都没干"。
 * 这是真机验证时踩过的坑——插件明明在跑，却一行输出都没有。
 * 日志永远不该被静默吞掉。
 *
 * `debug` 级默认不输出：网关对每条被忽略的消息都记一条 debug，正常运行时会很吵。
 * 排查时设 `QQ_PROACTIVE_DEBUG=1` 打开。error / warn / info 始终输出。
 */
function makeLogger(ctx) {
  const debugEnabled = (process.env.QQ_PROACTIVE_DEBUG ?? '') !== '';
  return (level, message, meta) => {
    const line = `[qq-proactive] ${message}`;
    try {
      const logger = ctx.logger;
      if (logger !== undefined && logger !== null && typeof logger[level] === 'function') {
        logger[level](line, meta ?? '');
      }
    } catch {
      /* 宿主日志通道不可用时就只靠 stderr */
    }
    if (level === 'debug' && !debugEnabled) return;
    try {
      const suffix = meta === undefined || meta === null || Object.keys(meta).length === 0
        ? ''
        : ` ${JSON.stringify(meta)}`;
      if (level === 'error' || level === 'warn') console.error(`${line}${suffix}`);
      else console.log(`${line}${suffix}`);
    } catch {
      /* stderr 都写不进去就真的没办法了 */
    }
  };
}

// ---------------------------------------------------------------------------
// 配置页 HTTP 路由（`[free_time]`：读 / 写 / 重载，2026-10-17）
//
// 为什么走 HTTP 而不是设置页那套 connection RPC：这三条要返回「文件值 / 生效值 /
// 快照」三份东西，纯 JSON 最直接；而 client 半本来就在同一个 web 源上，
// `fetch('/dsh-qq-proactive/...')` 即可（同 dsh-ui-banner 的做法）。
//
// ⚠️ 四条硬约束（都是本项目的踩坑）：
//   1. **三个 handler 自己吞异常** —— 它们挂在 webServer 上，抛出去就是宿主进程里的
//      未捕获异常（2026-10-14 就是这么把整个 App 带下去的）。
//   2. **只重写 `[free_time]` 一节**，其余字节原样保留。整份重新序列化会把
//      人设、白名单、模型一起改写 —— 那个文件就是小鲸鱼的命。
//   3. **保存 ≠ 生效**：toml 只在插件重载时被读。所以返回体里 `restartNeeded: true`。
//   4. **重载返回前不 sleep** —— UI 自己轮询快照，等 5 秒只会让按钮转圈到超时。
// ---------------------------------------------------------------------------

/** 三个路由的路径前缀。 */
export const FREE_TIME_ROUTE_BASE = '/dsh-qq-proactive';

/** 请求体上限。这几个字段撑死几百字节，64 KiB 已经非常宽松。 */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** 写 JSON 响应。res 已断时静默 —— 断连不是插件该管的事。 */
function sendJson(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  } catch {
    /* 连接已经断了 */
  }
}

/** 读 JSON 请求体；空体 = `{}`，坏 JSON / 超长 / 出错 = `null`。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** 异常压成一行可读文本。 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把 `[free_time]` 的值渲染成一节文本。
 *
 * 键名用**驼峰**（与设置页 POST body 一致）；读取侧两种命名都认
 * （见 {@link loadFreeTimeConfig}），所以老的手写蛇形也不会失效。
 *
 * @param {object} values 九个字段的**已校验**值
 * @param {string} [eol] 换行符（跟随原文件，避免 CRLF 文件被混入 LF）
 * @returns {string}
 */
export function renderFreeTimeSection(values, eol = '\n') {
  return [
    '[free_time]',
    '# 定时任务（空闲时她自己会说话）。改完必须点「重载插件」才生效。',
    `enabled = ${values.enabled === true ? 'true' : 'false'}`,
    `intervalHours = ${values.intervalHours}`,
    '# followupMinutes = 短追问：用户最后一条消息之后这么久没动静，就叫你一声',
    '#                  （只追问一次；用户再说话才重新计时。短唤醒不截图）。',
    `followupMinutes = ${values.followupMinutes}`,
    `windowStartHour = ${values.windowStartHour}`,
    `windowEndHour = ${values.windowEndHour}`,
    `tokenBudgetPerTurn = ${values.tokenBudgetPerTurn}`,
    `quietWhenNothing = ${values.quietWhenNothing === true ? 'true' : 'false'}`,
    `screenshots = ${values.screenshots === true ? 'true' : 'false'}`,
    '# screenshotsKeep = 保留最近几「轮」截图。一轮 = 一次唤醒 = 每块屏一张图（双屏 ⇒ 2 张/轮），',
    '#                   所以 2 表示最多留 4 个文件。分屏之后别把它当"文件数"（见 screen-capture.mjs）。',
    `screenshotsKeep = ${values.screenshotsKeep}`,
  ].join(eol);
}

/**
 * **只重写 `[free_time]` 一节**，其余字节原样保留。
 *
 * 两种情形：
 * - 文件里已经有 `[free_time]` ⇒ 用新的一节替换那一段（位置不变）；
 * - 没有 ⇒ 追加到文件末尾（前面补一个空行）。
 *
 * ⚠️ 这是**行级手术**，不是"解析成对象再序列化"：那个 toml 里有人设、白名单、
 * 模型，整份重新序列化等于把它们重写一遍（本项目踩过"配置静默失效"的坑）。
 *
 * @param {string} text 原文件全文
 * @param {object} values 九个字段的已校验值
 * @returns {string} 新全文
 */
export function rewriteFreeTimeSection(text, values) {
  const src = String(text ?? '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const section = renderFreeTimeSection(values, eol);
  const lines = src.split(eol);
  const isAnyHeader = (line) => /^\s*\[/.test(line);

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    // 精确匹配 `[free_time]`（允许行尾注释）；`[free_time.sub]` 不算。
    if (/^\s*\[\s*free_time\s*\]\s*(#.*)?$/.test(lines[i])) {
      start = i;
      break;
    }
  }

  // 没有这一节 ⇒ 追加。保留原文件末尾的空行，不把"尾巴"吃掉。
  if (start === -1) {
    if (src === '') return `${section}${eol}`;
    const prefix = src.endsWith(eol + eol) ? '' : (src.endsWith(eol) ? eol : `${eol}${eol}`);
    return `${src}${prefix}${section}${eol}`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isAnyHeader(lines[i])) {
      end = i;
      break;
    }
  }

  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const rebuilt = [...before, ...section.split(eol)];
  // 与下一节之间留一个空行（原文件那里本来就有的空行会被保留在 `after` 里）。
  if (after.length > 0 && after[0].trim() !== '') rebuilt.push('');
  rebuilt.push(...after);
  return rebuilt.join(eol);
}

/**
 * 校验 POST `/free-time` 的请求体。
 *
 * **八个字段必须全给**（`followupMinutes` 是唯一例外：老界面不传它，缺省按默认收）：
 * 缺字段按默认值写进去 = 用户没动过的值被静默重置，比报错难查得多。
 * 类型不对 / 越界 ⇒ 400 + 原因，不猜意思。
 *
 * @param {any} body
 * @returns {{ok: true, values: object}|{ok: false, error: string}}
 */
export function validateFreeTimeInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  const problems = [];
  const bool = (key) => {
    if (body[key] === undefined) {
      problems.push(`缺少字段 ${key}`);
      return DEFAULT_FREE_TIME_CONFIG[key];
    }
    if (typeof body[key] !== 'boolean') {
      problems.push(`${key} 必须是布尔（true/false）`);
      return DEFAULT_FREE_TIME_CONFIG[key];
    }
    return body[key];
  };
  const num = (key, min, max, integer) => {
    if (body[key] === undefined) {
      problems.push(`缺少字段 ${key}`);
      return DEFAULT_FREE_TIME_CONFIG[key];
    }
    const value = body[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${key} 必须是数字`);
      return DEFAULT_FREE_TIME_CONFIG[key];
    }
    const n = integer ? Math.floor(value) : value;
    if (n < min || n > max) {
      problems.push(`${key} 必须在 ${min}~${max} 之间`);
      return DEFAULT_FREE_TIME_CONFIG[key];
    }
    return n;
  };

  const enabled = bool('enabled');
  const intervalHours = num('intervalHours', 1, 24, false);
  // 短追问间隔（2026-10-23）：**唯一一个"缺了也收"的字段** ——
  // 旧界面（`client.js` 的 `/free-time` 表单）只回传八个键，它没有这一项；
  // 要是按"缺字段 = 静默重置"去拒，用户在那个界面上保存一次就被拦住。
  // 给了就必须合法（1~1440 分钟，整数），不接受含糊值。
  const followupMinutes = body.followupMinutes === undefined
    ? DEFAULT_FREE_TIME_CONFIG.followupMinutes
    : num('followupMinutes', 1, 1440, true);
  const windowStartHour = num('windowStartHour', 0, 23, true);
  const windowEndHour = num('windowEndHour', 1, 24, true);
  const tokenBudgetPerTurn = num('tokenBudgetPerTurn', 1000, Number.MAX_SAFE_INTEGER, true);
  const quietWhenNothing = bool('quietWhenNothing');
  // 截图两个键（2026-10-21）。**没有"我们自己的缩放上限"** —— 用户要先看
  // DSH 附件管线自己压到什么程度，所以这里只有"截不截"和"留几轮"。
  // ⚠️ `screenshotsKeep` 的单位是**轮**（一次唤醒 = 一轮 = 每块屏一张），不是文件数。
  const screenshots = bool('screenshots');
  const screenshotsKeep = num('screenshotsKeep', 1, 50, true);
  if (problems.length === 0 && windowEndHour <= windowStartHour) {
    problems.push('windowEndHour 必须大于 windowStartHour');
  }
  if (problems.length > 0) return { ok: false, error: problems.join('；') };
  return {
    ok: true,
    values: {
      enabled,
      intervalHours,
      followupMinutes,
      windowStartHour,
      windowEndHour,
      tokenBudgetPerTurn,
      quietWhenNothing,
      screenshots,
      screenshotsKeep,
    },
  };
}

/**
 * 用 `parseToml` 校验**改后的全文**（不通过就不写）。
 *
 * 两条都必须成立：
 * 1. `[free_time]` 读回来就是**要写的值**（类型/数值都对）；
 * 2. **除 `[free_time]` 之外，其它段落解析结果一字不差** —— 行级手术的理论保证，
 *    但"理论保证"要在这里验一次：写坏了人设/白名单，小鲸鱼在 QQ 上就是死了。
 *
 * @returns {string|null} 不通过的原因；`null` = 通过
 */
function validateFreeTimeRewrite(beforeText, afterText, expected) {
  let before;
  let after;
  try {
    before = parseToml(beforeText);
    after = parseToml(afterText);
  } catch (error) {
    return `改后的 toml 解析失败：${errorText(error)}`;
  }
  const section = after?.free_time;
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    return '改后的 toml 里读不到 [free_time] 这一节（写入被拒绝）';
  }
  for (const key of FREE_TIME_KEYS) {
    if (section[key] !== expected[key]) {
      return `改后的 [free_time] ${key} 读回来是 ${JSON.stringify(section[key])}，不是 ${JSON.stringify(expected[key])}`;
    }
  }
  const strip = (doc) => {
    const copy = { ...doc };
    delete copy.free_time;
    return copy;
  };
  if (JSON.stringify(strip(before)) !== JSON.stringify(strip(after))) {
    return '除 [free_time] 之外还有内容被改动了（写入被拒绝）';
  }
  return null;
}

/**
 * 造配置页的 HTTP 路由（不注册，调用方负责 `webServer.register`）。
 *
 * 2026-10-21 起这里是**按 scope + key** 的读写契约：
 *
 * | 路由 | 作用 |
 * |---|---|
 * | `GET  /dsh-qq-proactive/settings` | 文件值 / 生效值 / 用户 / 会话列表 / 字段表 |
 * | `POST /dsh-qq-proactive/free-time` | 旧的整段写入（保留，向后兼容） |
 * | `POST /dsh-qq-proactive/config` | 单个 `{scope, key, value}` 写入 |
 * | `POST /dsh-qq-proactive/reload` | 碰 `src/` 的 mtime 逼 HMR 重载 |
 *
 * 拆成工厂是为了**能测**：测试里传一个临时 toml，就能验证
 * "只改目标键"、"校验失败不写"、"备份落在工作区"三件事，
 * 而不用去碰线上那份 `qq-gugu.toml`。
 *
 * @param {object} options
 * @param {string} [options.tomlPath] 目标 toml（默认 `defaultTomlPath()`）
 * @param {object} [options.freeTimeCfg] 进程里的**生效值**
 * @param {object} [options.memoryCfg] 进程里的记忆配置（只读展示）
 * @param {object} [options.ownerCfg] 进程里的用户配置（`{admins, source, qq}`）
 * @param {object} [options.personaSections] 进程里的人格段（全局 + 覆盖层）
 * @param {object} [options.effective] 进程里其它段的生效值树
 * @param {unknown[]} [options.allowFrom] 私聊白名单（用户回退 + 会话列表用）
 * @param {unknown[]} [options.groupAllowFrom] 群白名单（启动拉群名 + 会话列表用）
 * @param {object} [options.groupNames] 群名缓存（`group-names.mjs` 的产物）
 * @param {object} [options.nicknames] 昵称表（`nicknames.mjs` 的产物）
 * @param {string} [options.backupDir] 备份目录（默认 `defaultBackupDir()`）
 * @param {string} [options.snapshotPath] 调试快照路径（空 = 不读）
 * @param {string} [options.entryPath] 重载时碰 mtime 的文件（默认 `src/index.mjs`）
 * @returns {Array<{kind: string, path: string, handler: Function}>}
 */
export function createFreeTimeHttpRoutes({
  tomlPath,
  freeTimeCfg = DEFAULT_FREE_TIME_CONFIG,
  memoryCfg = {},
  ownerCfg = null,
  personaSections = null,
  effective = {},
  allowFrom = [],
  groupAllowFrom = [],
  groupNames = null,
  nicknames = null,
  backupDir = defaultBackupDir(),
  snapshotPath = '',
  entryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.mjs'),
  log = () => {},
  promptCfg = null,
  workspacePath = '',
} = {}) {
  const targetToml = String(tomlPath ?? defaultTomlPath());

  const handleSettings = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' });
        return;
      }
      let snapshot = null;
      const snapFile = String(snapshotPath ?? '');
      if (snapFile !== '') {
        try {
          snapshot = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
        } catch {
          snapshot = null;
        }
      }
      const pick = (value) => (value === undefined ? null : value);
      const payload = buildConfigPagePayload({
        tomlPath: targetToml,
        freeTimeCfg,
        memoryCfg,
        ownerCfg,
        personaSections,
        effective,
        allowFrom,
        groupAllowFrom,
        groupNames,
        nicknames,
        backupDir,
      });
      sendJson(res, 200, {
        ok: true,
        tomlPath: targetToml,
        ...payload,
        snapshot: {
          staleCode: pick(snapshot?.staleCode),
          stats: pick(snapshot?.stats),
          learnedMemory: pick(snapshot?.learnedMemory),
          knowledgeInject: pick(snapshot?.knowledgeInject),
          freeTime: pick(snapshot?.freeTime),
          // 运行时用户（契约 `{admins, source}`）：与顶层 `owner` 可能不同 ——
          // 顶层是"文件里现在写的"，这里是"进程里生效的"。
          owner: pick(snapshot?.owner),
        },
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `读取配置页状态失败：${errorText(error)}` });
    }
  };

  /**
   * `POST /free-time`：旧的整段写入（向后兼容）。
   *
   * 备份规则与 `POST /config` **完全一致**（2026-10-21 修）：
   * - 落**工作区**备份目录（`backupDir`，默认 `defaultBackupDir()`）—— 复用
   *   `backupToml`，**不再**在 toml 旁边拼 `qq-gugu.toml.bak-<ms>`；
   *   以前那样两份备份落在两个地方，而 `<DSH_HOME>\profiles\desktop\` 那棵
   *   树对某些进程只读，历史上还留了 2 份删不掉的残留。
   * - **被拒的写入删掉刚做的备份**：备份是"这次写入的退路"，写没发生就没有
   *   留它的理由（参数非法 / 校验不过 / 写入失败三条分支都删）。
   */
  const handleFreeTime = async (req, res) => {
    let backupPath = '';
    const dropBackup = () => {
      if (backupPath === '') return;
      try {
        fs.rmSync(backupPath, { force: true });
      } catch {
        /* 备份删不掉不影响结果 */
      }
      backupPath = '';
    };
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      const body = await readJsonBody(req);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON（或超过 64 KiB）' });
        return;
      }
      const checked = validateFreeTimeInput(body);
      if (!checked.ok) {
        sendJson(res, 400, { ok: false, error: checked.error });
        return;
      }

      let before;
      try {
        before = fs.readFileSync(targetToml, 'utf8');
      } catch (error) {
        sendJson(res, 400, { ok: false, error: `读不到 ${targetToml}：${errorText(error)}` });
        return;
      }

      // 🔴 2026-10-29：**这段接口会按 `FREE_TIME_KEYS` 重建整段 `[free_time]`**，
      // 表外的键会被静默丢掉。提示词（`wakePrompt` / `followupPrompt`）与
      // `screenshotsMaxPerWake` 就是这样的键 —— 用户手写的提示词被一次旧接口调用
      // 抹掉，比拒绝写入糟得多。⇒ **fail-closed**：认不出的键在，就不重写，
      // 并告诉他改走配置页的逐键保存（`POST /config`，只改动的键、有备份）。
      const sectionBefore = parseToml(before)?.free_time;
      if (sectionBefore !== null && typeof sectionBefore === 'object' && !Array.isArray(sectionBefore)) {
        const unknown = Object.keys(sectionBefore).filter((key) => !FREE_TIME_KEYS.includes(key));
        if (unknown.length > 0) {
          sendJson(res, 400, {
            ok: false,
            error: `[free_time] 里有这个接口不认识的键（${unknown.join('、')}），整段重写会把它们丢掉；`
              + '请改用配置页的逐键保存（POST /config）',
          });
          return;
        }
      }

      // ① **先备份**（落 `backupDir`，与 `POST /config` 同一个目录函数）。
      //    备份失败就**不写**：没有退路的写入比不写更糟。
      try {
        backupPath = backupToml(targetToml, { backupDir });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: `备份失败，未写入：${errorText(error)}` });
        return;
      }

      // ② **只重写 `[free_time]` 一节**（其余字节保持原样）
      let after;
      try {
        after = rewriteFreeTimeSection(before, checked.values);
      } catch (error) {
        dropBackup();
        sendJson(res, 500, { ok: false, error: `生成新内容失败：${errorText(error)}` });
        return;
      }

      // ③ 用 `parseToml` 校验**改后的全文**：不通过 ⇒ 400，且一个字节都不写
      const problem = validateFreeTimeRewrite(before, after, checked.values);
      if (problem !== null) {
        dropBackup();
        sendJson(res, 400, { ok: false, error: problem });
        return;
      }

      // ④ 原子写：临时文件 + rename（同目录，宿主进程有写权限）
      const tmpPath = `${targetToml}.tmp-${process.pid}-${Date.now()}`;
      try {
        fs.writeFileSync(tmpPath, after, 'utf8');
        fs.renameSync(tmpPath, targetToml);
      } catch (error) {
        try {
          fs.rmSync(tmpPath, { force: true });
        } catch {
          /* 临时文件留着也无害 */
        }
        dropBackup();
        sendJson(res, 500, { ok: false, error: `写入失败：${errorText(error)}` });
        return;
      }

      log('info', '配置页已写入 [free_time]（等重载才生效）', {
        tomlPath: targetToml,
        backup: backupPath,
      });
      sendJson(res, 200, { ok: true, wrote: true, restartNeeded: true });
    } catch (error) {
      dropBackup();
      sendJson(res, 500, { ok: false, error: `保存 [free_time] 失败：${errorText(error)}` });
    }
  };

  /**
   * `POST /config`：按 `{scope, key, value}` **只改一个键**（2026-10-21）。
   *
   * 写盘规则（六条，按次执行）：
   *
   * 1. 先备份整份 toml 到**工作区**（`shared/tmp/qq-gugu.toml.bak-<epoch>`）——
   *    不往 `<DSH_HOME>` 写备份（那棵树对某些进程只读，历史踩过 EPERM）；
   * 2. 改完的全文做结构校验（带行号）；校验不过 ⇒ **不写**；
   * 3. 只重写目标键（行级手术，其余字节原样）；
   * 4. 临时文件 + `rename` 原子替换；
   * 5. 一律 `restartNeeded: true`（改配置要有一次重载才生效，不假装即时）；
   * 6. 危险键（`allowFrom` / `groupAllowFrom` / `provider` / `model` / `admins`）
   *    额外要求 body 里带 `confirm: true`。
   *
   * ⚠️ 被拒的写入会把**刚做的备份删掉**：备份是"这次写入的退路"，
   *    写入没发生就没有留它的理由（`shared\tmp` 会越堆越多）。
   */
  const handleConfig = async (req, res) => {
    let backupPath = '';
    const dropBackup = () => {
      if (backupPath === '') return;
      try {
        fs.rmSync(backupPath, { force: true });
      } catch {
        /* 备份删不掉不影响结果 */
      }
      backupPath = '';
    };
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      const body = await readJsonBody(req);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON（或超过 64 KiB）' });
        return;
      }
      const scope = parseConfigScope(body.scope);
      if (scope === null) {
        sendJson(res, 400, { ok: false, error: 'scope 只能是 global / private:<QQ号> / group:<群号>' });
        return;
      }
      const field = fieldByKey(body.key);
      // 危险键的闸门放在"认字段"之前：`allowFrom` / `groupAllowFrom` / `provider`
      // 这几个名字**不在可写目录里**（它们在 `cordis.patch.yml` 或别的段），
      // 但用户最可能误触的正是它们 —— 没有二次确认就该先看到 `需要二次确认`，
      // 而不是一句"未知字段"（那会让人以为是拼错了名字）。
      if (isDangerKey(body.key) && body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: '需要二次确认' });
        return;
      }
      if (field === undefined) {
        sendJson(res, 400, { ok: false, error: `未知字段：${JSON.stringify(body.key ?? null)}` });
        return;
      }
      // 覆盖层只支持人格五段：别的字段写进 `[personality.groups.*]` 也读不到。
      if (scope.kind !== 'global' && !SCOPE_FIELDS.some((item) => item.key === field.key)) {
        sendJson(res, 400, { ok: false, error: '只有人格五段支持按会话覆盖' });
        return;
      }
      if (field.danger === true && body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: '需要二次确认' });
        return;
      }
      const coerced = coerceFieldValue(field, body.value);
      if (coerced.ok === false) {
        sendJson(res, 400, { ok: false, error: coerced.error });
        return;
      }

      // 目标段路径：全局用字段自己的；覆盖层是 `[personality.groups."<号>"]` /
      // `[personality.privates."<号>"]`。
      const sectionPath = scope.kind === 'global'
        ? field.sectionPath
        : ['personality', scope.kind === 'group' ? 'groups' : 'privates', scope.id];
      // 覆盖层写空串 = **清掉这个字段**（清空 = 继承全局；不留下空 section）。
      const isClear = scope.kind !== 'global' && coerced.value === '';

      // 2026-10-30：写到**这个字段所属的那个文件** —— 分文件存在就写分文件，
      // 否则回落主文件（与加载器同一口径：`resolveModelToml` 是唯一入口）。
      // 按会话覆盖（`[personality.groups.*]`）只存在于主文件，所以它永远写主文件。
      const fileKey = scope.kind === 'global' ? String(field.file ?? 'main') : 'main';
      const writePath = resolveModelToml(targetToml, fileKey).path;

      let before;
      try {
        before = fs.readFileSync(writePath, 'utf8');
      } catch (error) {
        sendJson(res, 400, { ok: false, error: `读不到 ${writePath}：${errorText(error)}` });
        return;
      }
      const current = readTomlKey(parseToml(before), sectionPath, field.tomlKey);
      if (isClear && current === undefined) {
        sendJson(res, 200, {
          ok: true, wrote: false, key: field.key, scope: scope.id, backup: '', restartNeeded: true,
        });
        return;
      }
      if (!isClear && JSON.stringify(current) === JSON.stringify(coerced.value)) {
        sendJson(res, 200, {
          ok: true, wrote: false, key: field.key, scope: scope.id, backup: '', restartNeeded: true,
        });
        return;
      }

      // ① 先备份（落工作区）——**备的是这次真正要写的那个文件**，
      //    所以改心情只会产生 `qq-gugu.mood.toml.bak-<epoch>`，不会连人格一起备。
      try {
        backupPath = backupToml(writePath, { backupDir, name: path.basename(writePath) });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: `备份失败，未写入：${errorText(error)}` });
        return;
      }

      // ③ 只改目标键
      let after;
      try {
        after = isClear
          ? removeTomlKey(before, { sectionPath, key: field.tomlKey }).text
          : rewriteTomlKey(before, {
            sectionPath,
            key: field.tomlKey,
            value: coerced.value,
            type: field.type,
          });
      } catch (error) {
        dropBackup();
        sendJson(res, 500, { ok: false, error: `生成新内容失败：${errorText(error)}` });
        return;
      }

      // ② 校验改后的全文：不通过 ⇒ 一个字节都不写（行号一起回，方便定位）
      const check = isClear
        ? validateTomlKeyRemoved(before, after, { sectionPath, key: field.tomlKey })
        : validateTomlRewrite(before, after, {
          sectionPath,
          key: field.tomlKey,
          expected: coerced.value,
        });
      if (check.ok === false) {
        dropBackup();
        sendJson(res, 400, {
          ok: false,
          error: 'TOML 校验未通过',
          line: check.line ?? null,
          detail: check.detail,
        });
        return;
      }

      // ④ 原子写
      try {
        atomicWriteText(writePath, after);
      } catch (error) {
        dropBackup();
        sendJson(res, 500, { ok: false, error: `写入失败：${errorText(error)}` });
        return;
      }

      log('info', '配置页已写入一个键（等重载才生效）', {
        tomlPath: writePath,
        file: fileKey,
        scope: scope.id,
        key: field.key,
        cleared: isClear,
        backup: backupPath,
      });
      sendJson(res, 200, {
        ok: true,
        wrote: true,
        key: field.key,
        file: fileKey,
        tomlPath: writePath,
        scope: scope.id,
        backup: backupPath,
        restartNeeded: true,
      });
    } catch (error) {
      dropBackup();
      sendJson(res, 500, { ok: false, error: `保存配置失败：${errorText(error)}` });
    }
  };

  const handleReload = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      // 只改 mtime —— HMR 的 root 含整个 `src/`，看见变更就会重载插件，
      // **并顺带重读 toml**（"改 toml ⇒ 必须碰 src/ 逼重载"那条规则的按钮形态）。
      const now = new Date();
      try {
        fs.utimesSync(entryPath, now, now);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: `触碰 ${entryPath} 失败：${errorText(error)}` });
        return;
      }
      // ⚠️ **返回前不 sleep**：UI 自己轮询 `/settings`；等 5 秒只会让按钮超时。
      // ⚠️ 风险必须带给 UI：重载会 dispose 小鲸鱼的 agent，正在说的那一轮会被掐断。
      sendJson(res, 200, {
        ok: true,
        touched: 'src/index.mjs',
        note: '重载中，约 5 秒后生效',
        warning: '若小鲸鱼正在说话，重载会掐断这一轮',
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `重载失败：${errorText(error)}` });
    }
  };

  /**
   * `GET /backups?file=<key>`（2026-10-30）：列某个配置文件在备份目录里的备份。
   *
   * 分文件之后"回滚"才有意义：改心情只产生 `qq-gugu.mood.toml.bak-<epoch>`，
   * 回滚它不会把人格一起退回去。**没有这条接口，分文件只是换了个位置放**。
   */
  const handleBackups = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' });
        return;
      }
      const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1');
      const key = String(url.searchParams.get('file') ?? 'main').trim() || 'main';
      if (!isModelFileKey(key)) {
        sendJson(res, 400, { ok: false, error: `未知文件：${key}` });
        return;
      }
      const target = resolveModelToml(targetToml, key);
      const base = path.basename(target.path);
      let names = [];
      try {
        names = fs.readdirSync(backupDir);
      } catch {
        names = [];
      }
      const backups = names
        .filter((name) => name.startsWith(`${base}.bak-`))
        .map((name) => {
          let bytes = 0;
          let at = '';
          try {
            const stat = fs.statSync(path.join(backupDir, name));
            bytes = stat.size;
            at = new Date(stat.mtimeMs).toISOString();
          } catch {
            /* 读不到就留空 —— 仍然列出来，用户才知道它在那儿但坏了 */
          }
          return { name, bytes, at };
        })
        .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
      sendJson(res, 200, {
        ok: true,
        file: key,
        target: target.path,
        split: target.split,
        backupDir: String(backupDir ?? ''),
        backups,
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `列备份失败：${errorText(error)}` });
    }
  };

  /**
   * `POST /restore`（2026-10-30）：把某份备份**整份**写回它当初的来源文件。
   *
   * 规矩（每一条都对应一次可能的误操作）：
   * - `confirm: true` 必须带 —— 这是覆盖整份文件；
   * - `name` **只认备份目录里的文件名**，不许带路径（否则等于任意写盘）；
   * - 只接受 `<目标文件名>.bak-` 开头的名字（防止拿别人的备份覆盖它）；
   * - 写之前**先给当前版本再备一份** ⇒ "还原"本身也是可还原的；
   * - 写之前用 `parseToml` 验一遍 ⇒ 坏备份不会把配置写成半截。
   */
  const handleRestore = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      const body = await readJsonBody(req);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON（或超过 64 KiB）' });
        return;
      }
      if (body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: '还原会覆盖整份文件，需要二次确认' });
        return;
      }
      const key = String(body.file ?? 'main').trim() || 'main';
      if (!isModelFileKey(key)) {
        sendJson(res, 400, { ok: false, error: `未知文件：${key}` });
        return;
      }
      const name = String(body.name ?? '').trim();
      const target = resolveModelToml(targetToml, key);
      const base = path.basename(target.path);
      if (name === '' || name.includes('/') || name.includes('\\') || !name.startsWith(`${base}.bak-`)) {
        sendJson(res, 400, { ok: false, error: `备份名不合法（只接受 ${base}.bak-*）` });
        return;
      }
      const source = path.join(backupDir, name);
      let text;
      try {
        text = fs.readFileSync(source, 'utf8');
      } catch (error) {
        sendJson(res, 404, { ok: false, error: `读不到备份 ${name}：${errorText(error)}` });
        return;
      }
      try {
        parseToml(text);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: `备份不是合法 TOML，未写入：${errorText(error)}` });
        return;
      }
      // 还原前先把"当前版本"再备一份 —— 这样还原本身也能被还原。
      let safety = '';
      try {
        if (fs.existsSync(target.path)) {
          safety = backupToml(target.path, { backupDir, name: base });
        }
      } catch (error) {
        sendJson(res, 500, { ok: false, error: `还原前备份失败，未写入：${errorText(error)}` });
        return;
      }
      try {
        atomicWriteText(target.path, text);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: `写入失败：${errorText(error)}` });
        return;
      }
      log('info', '配置页还原了一份备份', {
        file: key, tomlPath: target.path, from: name, safety,
      });
      sendJson(res, 200, {
        ok: true,
        file: key,
        restored: target.path,
        from: name,
        safety,
        restartNeeded: true,
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `还原失败：${errorText(error)}` });
    }
  };

  /**
   * `POST /split`（2026-10-30）：把旁路的段落从主文件**搬进各自的文件**。
   *
   * 为什么要有这条接口：分文件之后，"第一次搬迁"必须由**能写 `<DSH_HOME>` 的进程**
   * （也就是插件自己）来做 —— shell 对那棵树只读，而让人手抄 5 万字节的 toml
   * 是拿配置当赌注。这一步做成一次性的、可验证的、可回滚的操作。
   *
   * 规矩（按顺序，全部通过才写）：
   * 1. `confirm: true`；2. 分文件已存在 ⇒ **跳过**（绝不覆盖人家改过的那份）；
   * 3. 先把主文件备份到工作区；4. 新文件的 TOML 先 `parseToml` 验一遍；
   * 5. 主文件改完再验一遍，并做**语义对照**：搬完之后「主文件 + 分文件」
   *    合起来必须与搬之前逐段相等（`canonicalJson`）—— 不相等就一个字节都不写。
   */
  const handleSplit = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      const body = await readJsonBody(req);
      if (body === null || body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: '拆分要搬动整段配置，需要二次确认（confirm: true）' });
        return;
      }
      const before = fs.readFileSync(targetToml, 'utf8');
      const eol = before.includes('\r\n') ? '\r\n' : '\n';
      const beforeDoc = parseToml(before);
      let lines = before.split(eol);

      const plan = [];
      const skipped = [];
      for (const [key, names] of Object.entries(SIDE_SECTION_MAP)) {
        const splitPath = splitTomlPath(targetToml, key);
        if (splitPath !== targetToml && fs.existsSync(splitPath)) {
          skipped.push({ key, reason: '分文件已存在，跳过' });
          continue;
        }
        const blocks = [];
        for (const name of names) {
          const block = extractSectionBlock(lines, name);
          if (block !== null) blocks.push(block);
        }
        if (blocks.length === 0) continue;
        plan.push({ key, splitPath, blocks });
      }
      if (plan.length === 0) {
        sendJson(res, 200, { ok: true, wrote: [], skipped, note: '没有可搬的段' });
        return;
      }

      // 先把新文件内容准备好并校验
      const outputs = [];
      for (const item of plan) {
        const title = `# ${item.key} 的配置（2026-10-30 从 qq-gugu.toml 拆出来）。`
          + `${eol}# 为什么分开：一份文件 = 一条模型链路，备份与回滚互不牵连。`
          + `${eol}# 加载器优先读这个文件；删掉它就会回落主文件里的同名段。`;
        const text = `${title}${eol}${eol}${item.blocks.map((b) => b.body).join(`${eol}${eol}`)}${eol}`;
        parseToml(text); // 坏内容不许落盘
        outputs.push({ key: item.key, path: item.splitPath, text });
      }

      // 从主文件里删掉这些段（按行号从大到小，前面的行号不会失效）
      const cuts = plan.flatMap((item) => item.blocks).sort((a, b) => b.from - a.from);
      for (const cut of cuts) {
        let end = cut.to;
        while (end < lines.length && lines[end].trim() === '') end += 1;
        lines = [...lines.slice(0, cut.from), ...lines.slice(end)];
      }
      const after = lines.join(eol);
      const afterDoc = parseToml(after);

      // 语义对照：搬之前的主文件 vs 搬之后的「主文件 + 分文件」
      for (const [key, names] of Object.entries(SIDE_SECTION_MAP)) {
        for (const name of names) {
          const wanted = canonicalJson(beforeDoc?.[name]);
          const fromMain = canonicalJson(afterDoc?.[name]);
          const output = outputs.find((item) => item.key === key);
          const fromSplit = canonicalJson(output === undefined ? undefined : parseToml(output.text)[name]);
          const effective = output === undefined && fromSplit !== canonicalJson(undefined)
            ? fromSplit
            : (fromSplit !== canonicalJson(undefined) ? fromSplit : fromMain);
          if (wanted !== effective) {
            sendJson(res, 500, {
              ok: false,
              error: `拆分前后 [${name}] 不一致，未写入任何文件`,
              before: wanted,
              after: effective,
            });
            return;
          }
        }
      }

      // 先备份主文件，再写分文件、最后改主文件（分文件先落地，读的人不会看到"半空"）
      const backup = backupToml(targetToml, { backupDir, name: path.basename(targetToml) });
      for (const item of outputs) atomicWriteText(item.path, item.text);
      atomicWriteText(targetToml, after);

      log('info', '旁路配置已拆成独立文件', {
        main: targetToml,
        files: outputs.map((item) => item.path),
        backup,
      });
      sendJson(res, 200, {
        ok: true,
        backup,
        wrote: outputs.map((item) => ({ key: item.key, path: item.path, bytes: item.text.length })),
        skipped,
        restartNeeded: true,
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `拆分失败：${errorText(error)}` });
    }
  };

  /**
   * `GET /prompt-preview?scope=global|private:<号>|group:<号>`（2026-10-30）：
   * 把这一轮**真正会进模型的那些句子**拼出来给页面看。
   *
   * 用户原话：「我要求最后我打开配置页这些内容都可改」—— 可改之后还要能**看见结果**，
   * 否则改完只能靠猜。返回的是分段正文 + 每段字数，页面按段显示。
   *
   * 这里只拼**每轮都会重发的那几段**（人格、工作目录、发 QQ 规矩）。
   * 不进预览的：历史对话、工具描述、知识和心情（它们是运行期数据，不是配置文本）。
   */
  const handlePromptPreview = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' });
        return;
      }
      const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1');
      const rawScope = String(url.searchParams.get('scope') ?? 'global').trim() || 'global';
      const scope = parseConfigScope(rawScope);
      if (scope === null) {
        sendJson(res, 400, { ok: false, error: 'scope 只能是 global / private:<QQ号> / group:<群号>' });
        return;
      }
      const prompt = normalizePromptConfig(promptCfg ?? {});
      const base = personaSections !== null && typeof personaSections === 'object'
        ? (personaSections.global ?? {})
        : {};
      let fields = base;
      let overridden = [];
      if (scope.kind !== 'global') {
        const bucket = scope.kind === 'group' ? personaSections?.groups : personaSections?.privates;
        const layer = bucket !== null && typeof bucket === 'object' ? bucket[scope.id] : undefined;
        if (layer !== undefined && layer !== null) {
          fields = mergePersonaFields(base, layer);
          overridden = overriddenPersonaKeys(layer);
        }
      }
      const parts = [];
      const push = (name, label, text) => {
        const body = String(text ?? '');
        parts.push({ name, label, text: body, chars: body.length });
      };
      push('persona', '人格（每轮重发）', buildPersona(fields, prompt));
      push('workdir', '工作目录那句', `${prompt.workdir}${String(workspacePath || '') || '.'}.`);
      push('send-rule', '发 QQ 的规矩', effective?.send?.rule
        ? `【发 QQ 的规矩】${effective.send.rule}`
        : '');
      // 旁路模型的提示词：不在每轮上下文里，但同样是"模型读到的文本"，
      // 所以单列一组（页面上分开显示，免得和每轮那四段混在一起）。
      const side = [];
      const pushSide = (name, label, text) => {
        const body = String(text ?? '');
        side.push({ name, label, text: body, chars: body.length });
      };
      pushSide('mood-system', '心情 · 系统段', effective?.mood?.systemPrompt);
      pushSide('mood-update', '心情 · 更新那句', effective?.mood?.updateNote);
      pushSide('mood-regress', '心情 · 平复那句', effective?.mood?.regressNote);
      pushSide('vision-detailed', '识图 · 详细描述系统段', effective?.vision?.descSystemDetailed);
      pushSide('vision-brief', '识图 · 短描述系统段', effective?.vision?.descSystemBrief);
      pushSide('sticker-prompt', '表情包审核提示词', effective?.sticker?.prompt);
      pushSide('precheck', '预检系统段', effective?.proactive?.precheck_system);
      pushSide('inturn', 'inTurn · 要不要接那三条', prompt.inturnNote);
      // 「心情模型到底看到了什么」—— 用户 2026-10-30 问"有上下文吗"。
      // 这里把**实际拼出来的样子**按示例填一遍（转录/心情是运行期的，标成占位）。
      const moodEff = effective?.mood ?? {};
      const moodLines = Math.max(1, Number(moodEff.transcriptMessages) || DEFAULT_MOOD_RHYTHM.transcriptMessages);
      const emotionStyle = String(effective?.personality?.emotion_style ?? '').trim();
      const moodPrompt = [
        `（最近 ${moodLines} 条聊天记录）`,
        '以上是群里最近的聊天记录',
        '',
        '你的名字是小鲸鱼',
        '你刚刚的情绪状态是：（当前心情）',
        '',
        String(moodEff.updateNote || DEFAULT_MOOD_UPDATE_NOTE),
        emotionStyle === '' ? '' : `你的情绪特点是：${emotionStyle}`,
        '请只输出新的情绪状态本身，不要输出其他内容。',
      ].filter((line) => line !== '').join('\n');
      pushSide('mood-prompt', '心情 · 实际拼出来长这样（转录与心情是运行期填的）', moodPrompt);
      sendJson(res, 200, {
        ok: true,
        scope: scope.kind === 'global' ? 'global' : `${scope.kind}:${scope.id}`,
        overridden,
        parts,
        side,
        totalChars: parts.reduce((sum, part) => sum + part.chars, 0),
        sideTotalChars: side.reduce((sum, part) => sum + part.chars, 0),
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `拼提示词失败：${errorText(error)}` });
    }
  };

  return [
    { kind: 'exact', path: `${FREE_TIME_ROUTE_BASE}/settings`, handler: handleSettings },
    { kind: 'exact', path: `${FREE_TIME_ROUTE_BASE}/free-time`, handler: handleFreeTime },
    { kind: 'exact', path: `${FREE_TIME_ROUTE_BASE}/config`, handler: handleConfig },
    { kind: 'exact', path: `${FREE_TIME_ROUTE_BASE}/backups`, handler: handleBackups },
    { kind: 'exact', path: `${FREE_TIME_ROUTE_BASE}/restore`, handler: handleRestore },
    { kind: 'exact', path: `${FREE_TIME_ROUTE_BASE}/split`, handler: handleSplit },
    { kind: 'exact', path: `${FREE_TIME_ROUTE_BASE}/prompt-preview`, handler: handlePromptPreview },
    { kind: 'exact', path: `${FREE_TIME_ROUTE_BASE}/reload`, handler: handleReload },
  ];
}

/**
 * 解析 `/config` 的 scope。
 *
 * @param {unknown} raw
 * @returns {{kind: 'global'|'private'|'group', id: string}|null}
 */
function parseConfigScope(raw) {
  const text = String(raw ?? 'global').trim();
  if (text === 'global') return { kind: 'global', id: 'global' };
  const match = /^(private|group):(\d+)$/.exec(text);
  if (match === null) return null;
  return { kind: match[1], id: match[2] };
}

/**
 * 造 `GET /settings` 的载荷（2026-10-21 的 scope + key 契约）。
 *
 * 四块：
 * - `file`：**文件里写的**（现读磁盘，不是进程里的旧值）；
 * - `effective`：**进程里生效的**（`apply()` 时读到的；两者不同 = 改过但没重载）；
 * - `owner`：`{admins, source}`（用户这个值从哪来）；
 * - `scopes` / `fields`：配置页渲染用的会话列表与字段表。
 *
 * `fields` 里的 `scope` 只有两种：`global`（文件基准确）与 `private:<号>` /
 * `group:<号>`（该会话的覆盖值）。`value` 为 `null` 表示**文件里没写**，
 * `effective` 则是合并/回退之后真正在用的值。
 *
 * @param {object} options
 * @returns {object}
 */
function buildConfigPagePayload({
  tomlPath,
  freeTimeCfg,
  memoryCfg,
  ownerCfg,
  personaSections,
  effective,
  allowFrom,
  groupAllowFrom,
  groupNames,
  nicknames,
  backupDir = '',
}) {
  // 2026-10-30：**每个旁路一份文件**。这里一次把六份都读出来 ——
  // 配置页的"文件值"必须来自**加载器真正会读的那个文件**，
  // 否则会出现"页面显示没写、实际从一个分文件里读到了值"这种最难查的错。
  const files = describeModelFiles(tomlPath);
  const docs = {};
  for (const item of files) {
    try {
      docs[item.key] = parseToml(fs.readFileSync(item.path, 'utf8'));
      item.readOk = true;
    } catch {
      docs[item.key] = {};
      item.readOk = false;
    }
  }
  const mainDoc = docs.main ?? {};
  const readOk = files.find((item) => item.key === 'main')?.readOk === true;
  const filePathOf = (key) => {
    const hit = files.find((item) => item.key === key);
    return hit === undefined ? tomlPath : hit.path;
  };
  const doc = mainDoc;
  const filePersona = personaSectionsFromDocument(readOk ? doc : {});
  const fileOwner = ownerFromTomlDocument(readOk ? doc : {}, { allowFrom });
  const processPersona = personaSections !== null && typeof personaSections === 'object'
    ? personaSections
    : { global: emptyPersonaFields(), groups: {}, privates: {} };

  // 会话列表 = 白名单 ∪ 人格覆盖层里声明过的键（顺序：白名单在前，保序去重）。
  const scopeIds = { private: [], group: [] };
  for (const qq of normalizeIdList(allowFrom)) scopeIds.private.push(qq);
  for (const gid of normalizeIdList(groupAllowFrom)) scopeIds.group.push(gid);
  for (const id of Object.keys(filePersona.privates)) {
    if (!scopeIds.private.includes(id)) scopeIds.private.push(id);
  }
  for (const id of Object.keys(filePersona.groups)) {
    if (!scopeIds.group.includes(id)) scopeIds.group.push(id);
  }

  // 群名：缺的顺手补拉（fire-and-forget，**绝不等它** —— 一次拉取要几百毫秒，
  // 而配置页的 `/settings` 被前端轮询）。
  if (groupNames !== null && typeof groupNames?.ensure === 'function' && scopeIds.group.length > 0) {
    try {
      groupNames.ensure(scopeIds.group).catch(() => {});
    } catch {
      /* 补拉失败不影响本次载荷 */
    }
  }

  const nameForPrivate = (qq) => {
    try {
      return typeof nicknames?.resolve === 'function' ? String(nicknames.resolve(qq) ?? '') : '';
    } catch {
      return '';
    }
  };
  const nameForGroup = (gid) => {
    try {
      return typeof groupNames?.get === 'function' ? String(groupNames.get(gid) ?? '') : '';
    } catch {
      return '';
    }
  };

  const scopes = [
    { id: 'global', kind: 'global', name: '全局', idText: '基准值', overridden: [] },
  ];
  for (const qq of scopeIds.private) {
    scopes.push({
      id: `private:${qq}`,
      kind: 'private',
      name: nameForPrivate(qq),
      idText: `QQ ${qq}`,
      overridden: overriddenPersonaKeys(filePersona.privates[qq] ?? {}),
    });
  }
  for (const gid of scopeIds.group) {
    scopes.push({
      id: `group:${gid}`,
      kind: 'group',
      name: nameForGroup(gid),
      idText: `QQ群${gid}`,
      overridden: overriddenPersonaKeys(filePersona.groups[gid] ?? {}),
    });
  }

  const fields = [];
  for (const field of CONFIG_FIELDS) {
    fields.push({
      key: field.key,
      section: field.section,
      // 2026-10-30：中文显示名由宿主给（以前只有客户端一张表，新字段一律显示 key）。
      label: field.label,
      // 2026-10-30：这一项落在哪个文件（配置页按它分标签；写盘也按它选目标）。
      file: field.file,
      scope: 'global',
      value: fileFieldValue(field, docs[field.file] ?? {}),
      type: field.type,
      // `enum` 的选项也带上（2026-10-21 加 `agent.reasoning` 时补的）。
      // 前端 `fieldOptions()` 是"载荷带了就用载荷的，否则用客户端表" ——
      // 所以宿主多给一份不会冲突，反而让新字段**不用等前端发版**就能出下拉。
      ...(Array.isArray(field.options) ? { options: [...field.options] } : {}),
      effective: effectiveFieldValue(field, effective),
    });
  }
  for (const scope of scopes) {
    if (scope.kind === 'global') continue;
    const fileLayer = scope.kind === 'group'
      ? (filePersona.groups[scope.id.replace(/^group:/, '')] ?? {})
      : (filePersona.privates[scope.id.replace(/^private:/, '')] ?? {});
    const processLayer = scope.kind === 'group'
      ? (processPersona.groups?.[scope.id.replace(/^group:/, '')] ?? {})
      : (processPersona.privates?.[scope.id.replace(/^private:/, '')] ?? {});
    const merged = mergePersonaFields(processPersona.global, processLayer);
    for (const field of SCOPE_FIELDS) {
      fields.push({
        key: field.key,
        section: field.section,
        scope: scope.id,
        value: typeof fileLayer[field.key] === 'string' && fileLayer[field.key] !== ''
          ? fileLayer[field.key]
          : null,
        type: 'multiline',
        effective: merged[field.key] ?? '',
      });
    }
  }

  return {
    // 2026-10-30：六份配置文件各自的路径 / 是否已拆分 / 是否读得到；以及备份目录
    // （配置页的「语音」等标签要显示"这个文件在哪、备份在哪、能不能还原"）。
    files,
    backupDir: String(backupDir ?? ''),
    // 「文件里写的」——**现读一遍磁盘**。不是进程里那份旧值。
    file: {
      // 两个旧键保留（向后兼容旧界面）：`file.freeTime` / `file.memory`。
      freeTime: loadFreeTimeConfig({ tomlPath }),
      memory: loadLearnedMemoryConfig({ tomlPath }),
      personality: filePersona.global,
      owner: { admins: fileOwner.admins },
      send: {
        rule: typeof doc?.send?.rule === 'string' ? doc.send.rule : '',
        // B2（2026-10-25）：文件里写的值；没写 ⇒ `null`（"没配"≠"配成 fallback"）。
        autoReply: typeof doc?.send?.auto_reply === 'string' ? doc.send.auto_reply : null,
        // B3（2026-10-25）：切分标记 / 段数上限（没写 ⇒ null，由 `default` 兜）。
        splitMarker: typeof doc?.send?.split_marker === 'string' ? doc.send.split_marker : null,
        splitMaxParts: typeof doc?.send?.split_max_parts === 'number'
          && Number.isFinite(doc.send.split_max_parts)
          ? doc.send.split_max_parts
          : null,
        // 2026-10-26：发图大小上限（`null` = 没写 ⇒ 用默认 10 MB）。
        maxImageMb: typeof doc?.send?.max_image_mb === 'number' && Number.isFinite(doc.send.max_image_mb)
          ? doc.send.max_image_mb
          : null,
      },
      mood: loadMoodConfig({ tomlPath: filePathOf('mood') }),
      // B4（2026-10-25）：`[voice]` 的**文件值**。这里整段用 loader 读 ——
      // 它的默认值语义（"没写 ⇒ 默认关"）已经在 `loadVoiceConfig` 里定好了，
      // 再在这里手抄一份 `null` 判断只会两边漂移。
      voice: loadVoiceConfig({ tomlPath: filePathOf('voice') }),
      // 2026-10-26：`[tts]` 的**文件值**（同上：整段用 loader 读，别手抄默认值）。
      tts: loadTtsConfig({ tomlPath: filePathOf('tts') }),
      // 2026-10-26：`[emotion]` 的**文件值**（同上：整段用 loader 读，别手抄默认值）。
      // 2026-10-30：它和 `[voice]` 共用 `qq-gugu.voice.toml`（同一条入站语音链）。
      emotion: loadEmotionConfig({ tomlPath: filePathOf('voice') }),
      // 2026-10-30：三条视觉旁路的文件值（识图 / 审核 / 留样）。
      sticker: loadStickerGate({ tomlPath: filePathOf('sticker') }),
      vision: loadVisionGate({ tomlPath: filePathOf('vision') }),
      stickerAudit: loadStickerAudit({ tomlPath: filePathOf('sticker') }),
    },
    // 「进程里生效的」——插件挂载时读到的值。
    // ⚠️ 两者不同 = 改过但**没重载**（本项目的硬教训：stale:false 只证明代码新）。
    effective: {
      freeTime: { ...freeTimeCfg },
      memory: { ...memoryCfg },
      personality: { ...processPersona.global },
      owner: { admins: normalizeIdList(ownerCfg?.admins) },
      send: {
        rule: String(effective?.send?.rule ?? ''),
        autoReply: String(effective?.send?.autoReply ?? 'fallback'),
        splitMarker: String(effective?.send?.splitMarker ?? '⟨cut⟩'),
        splitMaxParts: Number(effective?.send?.splitMaxParts ?? 4),
        // 2026-10-26：发图大小上限（进程里生效的值）。
        maxImageMb: Number(effective?.send?.maxImageMb ?? 10),
      },
      mood: { ...(effective?.mood ?? {}) },
      // B4（2026-10-25）：进程里生效的语音配置（与 `file.voice` 不同 = 改过没重载）。
      voice: {
        enabled: effective?.voice?.enabled === true,
        python: String(effective?.voice?.python ?? ''),
        script: String(effective?.voice?.script ?? ''),
        model: String(effective?.voice?.model ?? ''),
        device: String(effective?.voice?.device ?? 'cuda'),
        language: String(effective?.voice?.language ?? 'zh'),
        timeoutMs: Number(effective?.voice?.timeoutMs ?? 90000),
        cachePath: String(effective?.voice?.cachePath ?? ''),
      },
      // 2026-10-26：进程里生效的 `[tts]`（与 `file.tts` 不同 = 改过没重载）。
      tts: {
        enabled: effective?.tts?.enabled === true,
        voice: String(effective?.tts?.voice ?? ''),
        rate: String(effective?.tts?.rate ?? ''),
        pitch: String(effective?.tts?.pitch ?? ''),
        maxChars: Number(effective?.tts?.maxChars ?? 0),
        allowGroups: effective?.tts?.allowGroups === true,
        minGapMs: Number(effective?.tts?.minGapMs ?? 0),
        python: String(effective?.tts?.python ?? ''),
      },
      // 2026-10-26：进程里生效的 `[emotion]`（与 `file.emotion` 不同 = 改过没重载）。
      emotion: {
        enabled: effective?.emotion?.enabled === true,
        python: String(effective?.emotion?.python ?? ''),
        modelDir: String(effective?.emotion?.modelDir ?? ''),
        arousalHigh: Number(effective?.emotion?.arousalHigh ?? 0),
        minSeconds: Number(effective?.emotion?.minSeconds ?? 0),
        minRms: Number(effective?.emotion?.minRms ?? 0),
      },
    },
    // 用户的来源：文件里的 `[owner] admins` 优先，空了回退白名单第一个。
    owner: { admins: fileOwner.admins, source: fileOwner.source },
    scopes,
    fields,
  };
}

/** 默认的 qq-gugu.toml 路径（与 cordis.patch.yml 同级）。 */
function defaultTomlPath() {
  return process.env.QQ_GUGU_TOML ?? path.join(dshHome(), 'profiles', 'desktop', 'qq-gugu.toml');
}

/**
 * 一次搬迁时，每份分文件该接走主文件里的哪几段（2026-10-30）。
 *
 * 段名不改 —— 分文件里仍然叫 `[mood]` / `[sticker_gate]` …，解析器与字段表不用动。
 * 这张表是**唯一**的"哪个段归哪个文件"清单，和 `toml-files.mjs` 的
 * `fileKeyForSection()` 必须一致（那边是反查，这边是清单；有测试对着核）。
 */
export const SIDE_SECTION_MAP = Object.freeze({
  mood: ['mood'],
  vision: ['vision_gate'],
  sticker: ['sticker_gate', 'sticker_audit'],
  voice: ['voice', 'emotion'],
  tts: ['tts'],
});

/** 这一行是不是表头；是的话返回段名（`vision_gate.cloud` 也算）。 */
function tableHeaderName(line) {
  const match = /^\[([^[\]]+)\][ \t]*$/.exec(String(line ?? '').trim());
  return match === null ? '' : match[1].trim();
}

/**
 * 从 toml 文本里切出某一段：**带上紧邻上方的注释块**，连同它的子表，
 * 到下一个"不是它的子表"的表头为止（尾部空行不切走，留给主文件当分隔）。
 *
 * @param {string[]} lines
 * @param {string} name 段名（如 `mood` / `vision_gate`）
 * @returns {{from: number, to: number, body: string}|null}
 */
export function extractSectionBlock(lines, name) {
  const list = Array.isArray(lines) ? lines : [];
  const start = list.findIndex((line) => tableHeaderName(line) === name);
  if (start < 0) return null;
  let head = start;
  // 往上带注释块（连续的 `#` 行）—— 那些"为什么这么配"的注释跟着段走，别留在原地孤悬。
  while (head > 0 && /^\s*#/.test(list[head - 1])) head -= 1;
  let end = start + 1;
  while (end < list.length) {
    const next = tableHeaderName(list[end]);
    if (next !== '') {
      if (next.startsWith(`${name}.`)) {
        end += 1;
        continue;
      }
      break;
    }
    end += 1;
  }
  let tail = end;
  while (tail > start + 1 && list[tail - 1].trim() === '') tail -= 1;
  return { from: head, to: tail, body: list.slice(head, tail).join('\n') };
}

/** 键排序后的 JSON —— 只用来比较两份配置的**语义**是否相同。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

/**
 * 读 toml 的 `[sticker_gate]`：**表情包入库审核闸**的提示词与阈值。
 *
 * 用户 2026-10-08 拍板的三条决定了这一段的形状：
 * 1. 「表情包入库审核闸**需要在 toml 里有一块放提示词的位置**」⇒ 提示词从这儿读，
 *    代码里那份（`DEFAULT_STICKER_PROMPT`）只是"toml 读不到"时的兜底；
 * 2. 「nsfw 这块**分开来**，并且改成打分…**默认 4 分以下才能接纳**…
 *    **不知道模型本身倾向，所以只能自己测试调整**」⇒ 四项各自一个阈值，全部可调；
 * 3. 真人照片「**a，真人直接砍**」⇒ `portrait` **没有阈值**（判定层写死，不放进旋钮）。
 *
 * ⚠️ **夹紧必须留痕**：越界的数会被 {@link normalizeStickerGate} 夹到边界，
 * 这里把"夹过"的字段**逐个打 warn**。不这么做的话，用户把 `nsfwMax` 写成 `40`
 * 会得到一个"看起来设成 40、实际按 10 跑"的配置 —— 而日志里一个字都没有
 * （"配置写了却不生效"是这个项目最贵的一类坑）。
 *
 * ⚠️ 读不到 toml / 那一节不存在 ⇒ 回退默认值（**不抛异常**）：
 * 这一节在用户手改的 toml 里，写错不该让小鲸鱼整个起不来；但**一定留一条 warn**。
 *
 * @param {object} config 经 `resolveConfig` 的配置（这里只用 `tomlPath`）
 * @param {(level: string, message: string, meta?: object) => void} [log]
 * @returns {{prompt: string, provider: string, model: string, nsfwMax: number, violenceMax: number, goreMax: number, uglyMax: number, funnyMin: number, captionMaxChars: number, maxTokens: number, enableThinking: boolean}}
 */
/**
 * 某个旁路**这一轮该读哪个 toml**（2026-10-30）。
 *
 * `qq-gugu.<key>.toml` 存在就用它，否则**回落主文件** —— 老部署一个字节都不用改。
 * 唯一入口是 `toml-files.mjs` 的 `resolveModelToml()`：读、写、备份都走它，
 * 谁也不许自己拼 `<base>.<key>.toml`（拼一次就会有一处分叉）。
 *
 * @param {object} config 经 `resolveConfig` 的配置（这里只用 `tomlPath`）
 * @param {'mood'|'vision'|'sticker'|'voice'|'tts'} key
 * @returns {string}
 */
function sideTomlPath(config, key) {
  const main = String(config?.tomlPath ?? '').trim() || defaultTomlPath();
  return resolveModelToml(main, key).path;
}

export function loadStickerGate(config, log = () => {}) {
  const tomlPath = sideTomlPath(config, 'sticker');
  let section = null;
  try {
    const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
    section = doc?.sticker_gate ?? null;
  } catch (error) {
    log('warn', '读 qq-gugu.toml 失败，表情包审核闸回退到代码默认值', {
      tomlPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return normalizeStickerGate({});
  }
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    log('warn', 'qq-gugu.toml 里没有 [sticker_gate] 这一节，审核闸回退到代码默认值', { tomlPath });
    return normalizeStickerGate({});
  }
  const gate = normalizeStickerGate(section);
  // ⚠️ 这个键名列表**必须和 `normalizeStickerGate` 里会夹的那些键一一对应**。
  //    2026-10-09 实测踩到过：`funnyMin` 加进判定层之后**漏加到这里** ⇒
  //    它写越界会被**静默夹紧**（配置写着 999、实际按 10 跑，日志里一个字都没有）——
  //    正是这个项目最贵的一类坑（"不报错、计数正常、只是什么都没发生"）。
  //    ⇒ 以后往 `DEFAULT_STICKER_GATE` 加任何**数值**阈值，都要同时加到这一行。
  //    `.test.mjs` 里有一条测试钉着"两个列表一致"，不用靠记性（见 sticker-recognize.test.mjs）。
  //    ⚠️ 2026-10-10：`maxTokens` 就是照着这条加进来的。
  //    ⚠️ 2026-10-10 第二次：`enableThinking` 是**第一个布尔项** —— 它会被同一个列表
  //      覆盖（写 `"false"` / `0` 这种不是布尔的 ⇒ 回退默认值，同样必须留痕），
  //      所以下面的比较**按类型分**：布尔比布尔，数字比数值（`"2000"` 与 `2000` 等价）。
  for (const key of ['nsfwMax', 'violenceMax', 'goreMax', 'uglyMax', 'funnyMin', 'captionMaxChars', 'maxTokens', 'enableThinking']) {
    if (section[key] === undefined) continue;
    const using = gate[key];
    const same = typeof using === 'boolean' ? section[key] === using : Number(section[key]) === using;
    if (!same) {
      log('warn', `[sticker_gate] ${key} 的值不合法，已回退/夹到边界（生效的是"夹过之后"的值）`, {
        wrote: section[key],
        using,
      });
    }
  }
  return gate;
}

/**
 * 读 toml 的 `[vision_gate]`（**显存门控**，2026-10-09）。
 *
 * 用户原话：
 *   > 「得有个 if：调用视觉模型前先看一眼目前的显存占用，if 空闲显存小于 7g，
 *   > then 使用 v4f，else 使用本地模型」
 *
 * 这一节就是那个 if 的**两个旋钮 + 两条路的名字**：
 *
 * ```toml
 * [vision_gate]
 * freeMiB = 7168                       # 空闲显存低于它 ⇒ 用云
 * cacheMs = 5000                       # 显存读数缓存多久（别每条消息 fork 一次 nvidia-smi）
 * provider = "discovery-intern-ai"     # 云端（v4f）
 * model    = "deepseek-v4-flash-vision"
 * localProvider = "local-llamacpp"     # 本地（留空 = 没有本地路 ⇒ 永远走云）
 * localModel    = "qwen3.5-4b-q4km-vision"
 * ```
 *
 * ⚠️ **夹紧必须留痕**（和 {@link loadStickerGate} 同一条规矩）：越界的数被夹到边界时
 * 逐个打 warn —— 否则用户会得到一个"看起来设成 7000000、实际按 65536 跑"的配置，
 * 而日志里一个字都没有。
 *
 * ⚠️ 读不到 toml / 那一节不存在 ⇒ 返回 `null`（**门控关闭**），并且**只打一条 info**。
 * 为什么不是 warn：这一节是**可选功能**，没写它不该每天在日志里报警。
 * 但"发现没配"这件事必须能看见 —— 所以 info 里明说"没有 [vision_gate] ⇒ 视觉永远走云"。
 *
 * @param {object} config 经 `resolveConfig` 的配置（这里只用 `tomlPath`）
 * @param {(level: string, message: string, meta?: object) => void} [log]
 * @returns {object|null} `normalizeVisionGate` 收拾过的形状；没配则 `null`
 */
export function loadVisionGate(config, log = () => {}) {
  const tomlPath = sideTomlPath(config, 'vision');
  let section = null;
  try {
    const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
    section = doc?.vision_gate ?? null;
  } catch (error) {
    log('warn', '读 qq-gugu.toml 失败，显存门控**关闭**（视觉恒走云）', {
      tomlPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    log('info', 'qq-gugu.toml 里没有 [vision_gate] 这一节 ⇒ 显存门控关闭，视觉恒走云', { tomlPath });
    return null;
  }
  const gate = normalizeVisionGate(section);
  // 2026-10-30：图片描述的两套 system 文本跟着这一节走（不进 normalizeVisionGate ——
  // 那个模块只管显存门控的数值，别把提示词塞进去）。
  const textOf = (value) => (typeof value === 'string' ? value.trim() : '');
  gate.descSystemDetailed = textOf(section.desc_system_detailed);
  gate.descSystemBrief = textOf(section.desc_system_brief);
  for (const key of ['freeMiB', 'cacheMs', 'probeTimeoutMs']) {
    if (section[key] === undefined) continue;
    if (Number(section[key]) !== gate[key]) {
      log('warn', `[vision_gate] ${key} 的值超出合法范围，已夹到边界（生效的是"夹过之后"的值）`, {
        wrote: section[key],
        using: gate[key],
      });
    }
  }
  return gate;
}

/**
 * 读 toml 的 `[sticker_audit]`（**审核留样**，2026-10-09）。
 *
 * 用户原话：
 *   > 「这样吧，**所有的图暂时性的都保存到另一个文件夹下**，然后**看哪些被拒了就知道了**；
 *   > **我来客串一回数据标注员**」
 *
 * ```toml
 * [sticker_audit]
 * enabled = true
 * dir = "<DSH_HOME>\\media\\sticker-audit"   # 空串 = 明确关掉
 * maxFiles = 200      # 最多留多少张（最旧的先淘汰）
 * maxBytes = 268435456 # 256 MB
 * index = true        # 写 index.jsonl（一眼扫用）
 * maxIndexLines = 2000
 * ```
 *
 * ⚠️ **没写这一节 = 用代码默认值**（默认开、默认 200 张 / 256 MB）。
 * 为什么默认开：用户明确要了这个功能，"配了才生效"会让它看起来没做。
 * 但它**一定会留痕**（挂载日志里有目录 + 上限），而且会**自发淘汰**。
 *
 * ⚠️ 越界夹到边界时逐个 warn（和 `loadStickerGate` / `loadVisionGate` 同一条规矩）。
 *
 * @param {object} config 经 `resolveConfig` 的配置（这里只用 `tomlPath`）
 * @param {(level: string, message: string, meta?: object) => void} [log]
 * @returns {object} `normalizeStickerAudit` 收拾过的形状（读不到就用默认值，**不会返回 null**）
 */
export function loadStickerAudit(config, log = () => {}) {
  const tomlPath = sideTomlPath(config, 'sticker');
  let section = null;
  let readOk = true;
  try {
    const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
    section = doc?.sticker_audit ?? null;
  } catch (error) {
    readOk = false;
    log('warn', '读 qq-gugu.toml 失败，审核留样回退到代码默认值（默认开、写 media\\sticker-audit）', {
      tomlPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (readOk && (section === null || typeof section !== 'object' || Array.isArray(section))) {
    // 不是错，只是"没配" —— 用默认值，并说清默认值是什么（否则"目录里冒出一个文件夹"会很吓人）。
    log('info', 'qq-gugu.toml 里没有 [sticker_audit] 这一节 ⇒ 用代码默认值', {
      tomlPath,
      dir: DEFAULT_STICKER_AUDIT.dir,
      maxFiles: DEFAULT_STICKER_AUDIT.maxFiles,
      maxBytes: DEFAULT_STICKER_AUDIT.maxBytes,
    });
    return normalizeStickerAudit({});
  }
  const audit = normalizeStickerAudit(section ?? {});
  for (const key of ['maxFiles', 'maxBytes', 'maxIndexLines']) {
    if (section?.[key] === undefined) continue;
    if (Number(section[key]) !== audit[key]) {
      log('warn', `[sticker_audit] ${key} 的值超出合法范围，已夹到边界（生效的是"夹过之后"的值）`, {
        wrote: section[key],
        using: audit[key],
      });
    }
  }
  return audit;
}

/** 把 toml 的 [personality] 四字段拼成完整 system prompt。 */
/** 把 toml 的 [personality] 各字段拼成完整 system prompt。 */
export function buildPersona(p, promptCfg = null) {
  // 2026-10-30：开头那句、以及【说话方式】那一段，改由 `[prompt]` 提供（默认 = 原来的字面量）。
  const prompt = normalizePromptConfig(promptCfg ?? {});
  const field = (name) => String(p?.[name] ?? '').trim();
  const parts = [
    prompt.identity,
    '',
    '【人格】',
    field('persona'),
  ];
  /**
   * 2026-11-01：人格从五段扩到九段（新增 关系 / 群聊判断力 / AI 味 / 示例）。
   *
   * **新段空串就整段跳过** ⇒ 没配的输出与扩之前**逐字节相同**，
   * 这也是"老 toml 不用改也能跑"的那条保证。原有的四段仍然无条件出现（保持旧行为）。
   */
  const addOptional = (title, text) => {
    if (text === '') return;
    parts.push('', title, text);
  };

  addOptional('【跟谁说话】', field('relations'));
  parts.push('', '【表达风格】', field('reply_style'));
  parts.push('', '【情绪】', field('emotion_style'));
  parts.push('', '【兴趣】', field('interest'));

  // 【说话方式】永远在；自称（`self_name`）是可选的一行，留空就一个字都不加。
  const selfName = String(prompt.selfName ?? '').trim();
  const personaStyle = selfName === ''
    ? prompt.personaStyle
    : `${prompt.personaStyle}\n自称固定用「${selfName}」，平均每两三句出现一次，别每条都带。`;
  parts.push('', '【说话方式】', personaStyle);

  addOptional('【群聊里怎么判断】', field('chat_sense'));
  addOptional('【AI 味】', field('ai_flavor'));
  addOptional('【例子】', field('examples'));

  // 【规矩】是可选的：toml 里写了 rules 就追加，没写就跳过（保持旧行为、可回滚）。
  // 为什么要这个字段：QQ 环境特有的几条硬规矩（不要用 ask_user_question /
  // 动手前先问 / 被沙箱拒绝就是拒绝）原本写在 preset 的 persona 里，被这里遮蔽后就不生效了。
  const rules = field('rules');
  if (rules !== '') parts.push('', rules);
  return parts.join('\n');
}

/**
 * 造一个「sessionKey → `{text, overridden}` | `null`」的人格解析器（2026-10-21）。
 *
 * 交给 `SessionBinder`，在**每轮提示词组装**时调用（`section.text` 是函数）。
 *
 * - 命中覆盖层 ⇒ 返回合并后的正文 + 生效字段清单；
 * - 没命中 ⇒ `null`（绑定层直接用全局人格，逐字节不变）；
 * - `buildPersona()` 仍在这里 —— 提示词的**格式**只有一处定义。
 *
 * @param {{global?: object, groups?: object, privates?: object}} sections
 * @param {((sessionKey: unknown) => ({kind: string, id: string}|null))|null} [scopeOf]
 *   覆盖层坐标解析（2026-10-24 P1-4：会话映射表）。不传 ⇒ 回退旧前缀（行为不变）。
 * @returns {(sessionKey: string) => ({text: string, overridden: string[]}|null)}
 */
export function makePersonaForSession(sections, scopeOf = null, promptCfg = null) {
  return (sessionKey) => {
    const merged = personaForSession(sections, sessionKey, scopeOf);
    if (merged === null) return null;
    return { text: buildPersona(merged.fields, promptCfg), overridden: merged.overridden };
  };
}

/**
 * 加载人格：优先从 qq-gugu.toml 读 [personality]，读不到就回退 config.persona。
 *
 * 这是用户点名要的「人格放 toml」—— 改人格直接编辑 toml，不用喊 agent 改 persona。
 *
 * @param {object} config 经 `resolveConfig` 的配置（`tomlPath` 由它填好）
 * @param {{global?: object, fromToml?: boolean}|null} [sections]
 *   **已经加载好的**人格段（`loadPersonaSections()` 的产物）。给了就直接用它 ——
 *   于是提示词里那份人格与 `/settings` 的 `effective.personality` 读的是
 *   **同一个对象**（2026-10-21：两处各自读一遍，而其中一处拿不到 `tomlPath`
 *   ⇒ 读空 ⇒ 配置页把"她一直在用的人格"全标成「未生效（重载后生效）」）。
 * @returns {string}
 */
export function loadPersona(config, sections = null) {
  const loaded = sections !== null && typeof sections === 'object'
    ? sections
    : loadPersonaSections(config);
  const global = loaded?.global;
  // 判定条件与"直接读 raw doc"那版等价：toml 里有 `[personality]`、且
  // `personality` 是**非空字符串**才用它（`personaSectionsFromDocument` 已经把
  // 非字符串 / 只有空白规范成空串）。否则回退 `config.persona`。
  if (loaded?.fromToml === true
    && global !== null && typeof global === 'object'
    && global.persona !== '') {
    return buildPersona(global, loadPromptConfig(config));
  }
  return typeof config?.persona === 'string' ? config.persona : '';
}

/**
 * 读 `[prompt]` 段（2026-10-30）：每轮提示词里的那几句固定话。
 *
 * **永远在主文件里**（和人格一样），分文件的只有旁路模型。读不到 ⇒ 全默认，不抛。
 *
 * @param {object} config 经 `resolveConfig` 的配置（只读 `tomlPath`）
 * @param {(level: string, message: string, meta?: object) => void} [log]
 * @returns {Record<string, string>}
 */
export function loadPromptConfig(config, log = () => {}) {
  const main = String(config?.tomlPath ?? '').trim() || defaultTomlPath();
  return loadPromptConfigFromFile(main, log);
}

/**
 * 读 toml 的 emotion_style（情绪特点，作动态心情的底色）。
 * 用户会自己去改这个字段；读不到返回空串。
 */
export function loadEmotionStyle(config) {
  const tomlPath = String(config?.tomlPath ?? defaultTomlPath());
  try {
    const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
    return String(doc?.personality?.emotion_style ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * 读 toml 的主动发言配置：**通配一套 + 指定会话覆盖**。
 *
 * 用户 2026-10-04 的诉求（原话）：
 *   > 这个群聊不太活跃，可能得改下；似乎还没有单独群聊的规则，
 *   > 要不 toml 做成一套通配的规则 + 指定某几个群聊的特殊规则吧？
 *
 * toml 里长这样：
 *
 * ```toml
 * [proactive]                    # 通配：所有会话都按这套
 * maxPerHour = 60
 * focusWindowMs = 60000
 *
 * [proactive.groups."200000002"] # 覆盖：只对这个群生效
 * maxPerHour = 20
 *
 * [proactive.groups."200000003"]
 * enabled = false                # 单独关掉这个群的主动发言
 * ```
 *
 * ⚠️ 别在例子里写 `burstMinMessages` —— 那道闸门 2026-10-07 已删，
 * 同名键现在**不生效**（虽然 toml 里可能还留着）。
 *
 * **两个约定**：
 * 1. `groups` 下的键写**群号**（不带 `group:` 前缀），这里统一补上 ——
 *    群名会改、群号不会，而且用户看到的就是群号。
 * 2. 覆盖是**浅合并**：只写要改的字段，其余往通配要。
 *
 * 读不到/写错时**不抛异常**（回退成"没有覆盖"），因为配置文件写错不该让插件起不来。
 *
 * @returns {{config: object, overrides: Record<string, object>}}
 */
export function loadProactiveConfig(config) {
  const tomlPath = String(config?.tomlPath ?? defaultTomlPath());
  let doc;
  try {
    doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
  } catch {
    return { config: {}, overrides: {} };
  }
  const section = doc?.proactive;
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    return { config: {}, overrides: {} };
  }

  const { groups, ...wildcard } = section;
  const overrides = {};
  if (groups !== null && typeof groups === 'object' && !Array.isArray(groups)) {
    for (const [key, value] of Object.entries(groups)) {
      const id = String(key ?? '').trim();
      if (id === '' || value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      // 已经写了前缀就尊重原样（`private:123` / `group:456`），否则当作群号补 `group:`
      const chatId = id.includes(':') ? id : `group:${id}`;
      overrides[chatId] = value;
    }
  }
  return { config: wildcard, overrides };
}

/**
 * `[memory] learned_enabled` 的**代码默认值**。
 *
 * `true` = **与改动前逐字等价**（旧记忆库一直在跑）。这一条是硬要求：
 * "读不到 `[memory]` 这一节"绝不许偷偷变成"把它关掉" —— 那是本项目最贵的
 * 一类坑（静默不生效 / 静默改了行为，两边都不报错）。
 */
export const DEFAULT_LEARNED_MEMORY_ENABLED = true;

/**
 * 读 toml 的 `[memory] learned_enabled`：**"学来的记忆"（旧记忆库）的总开关**。
 *
 * ## 它管什么、不管什么（⚠️ 这是本次改动最要紧的一条）
 *
 * 用户原话：「我们现在既然有记忆库了，**老的那个停掉吧，我看了看全是噪声**」。
 * 而 `knowledge.json`（**静态**知识库，1247 概念 + 546 画像）是**另一件事**，
 * 用户明确说过「那是知识库不是记忆，别砍」。两者在代码里混在**同一个
 * `KnowledgeBase` 对象**里，能干净分开靠的是**两条写入路径**：
 *
 * | 来源 | 怎么进的 `KnowledgeBase` | 这个开关管不管 |
 * |---|---|---|
 * | `knowledge.json` 的 `graph_nodes` / `person_info` | `KnowledgeBase.load()` ⇒ **只读那一个文件** | ❌ **不管**（照旧加载、照旧注入） |
 * | `learned-memory.json` | `remember()` 的**两条调用点**：启动重放 + `learner.learn()` | ✅ **管**（两条一起关） |
 *
 * ⇒ `learned_enabled = false` 时：**不重放、不注入、不构造 learner**（于是也不回写文件）。
 *   静态知识库原样保留。`#injectKnowledge()` 那条路照旧注入 —— 只是
 *   `personInfo` 里只剩 `knowledge.json` 的内容。
 *
 * ⚠️ **不删 `learned-memory.json`**（用户没让删）—— 只是不再写。
 *   要恢复：把这个键改回 `true`（或删掉整个 `[memory]` 段）再重载一次即可。
 *
 * ## 为什么走 toml 而不是 `CONFIG_SHAPE`
 *
 * 和 `denyToolsInGroup` / `groupAgentPreset` / `knowledgePath` **同一个理由**
 * （见 `binding.mjs` 里 `resolveGroupDenyTools` 上那段）：`CONFIG_SHAPE` 会
 * **物化**一个值出来（不写就有），于是"这台机器上没配"和"明确配成默认"再也
 * 分不开。而这里要的正是"**没配 = 默认开着**"，且真源只有 toml 一处。
 *
 * ## 用法（toml）
 *
 * ```toml
 * [memory]
 * learned_enabled = false   # 停掉"学来的记忆"；不写这一行 = 开着（改动前的行为）
 * ```
 *
 * 读不到 toml / 这一节不存在 / 类型不对 ⇒ 回 {@link DEFAULT_LEARNED_MEMORY_ENABLED}，
 * **绝不抛异常**（和 `loadMoodConfig` 同一条约定：配置文件写错不该让小鲸鱼起不来）。
 *
 * @param {object} config 经 `resolveConfig` 的配置（这里只用 `tomlPath`）
 * @returns {{learnedEnabled: boolean}}
 */
export function loadLearnedMemoryConfig(config) {
  const tomlPath = String(config?.tomlPath ?? defaultTomlPath());
  let section = null;
  try {
    const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
    section = doc?.memory ?? null;
  } catch {
    section = null;
  }
  const raw = section !== null && typeof section === 'object' && !Array.isArray(section) ? section : {};

  // `learned_enabled` **只认布尔**（照 `loadMoodConfig` 的 `enabled` 那条）：
  // 写 `"false"`（带引号的字符串）在 toml 里是很自然的错法，而 JS 里 `"false"` 是
  // **真值** ⇒ 静默当成"开着"，正好把用户想止血的开关吃掉。所以不合法就回默认值，
  // 不猜他的意思。
  const learnedEnabled = typeof raw.learned_enabled === 'boolean'
    ? raw.learned_enabled
    : DEFAULT_LEARNED_MEMORY_ENABLED;

  // A（2026-10-17）：注入字数上限。**只认 ≥100 的有限数**；
  // 写 `0` / 负数 / 字符串（toml 里 `inject_max_chars = "800"`）⇒ 回默认 800。
  // 不猜他的意思：这类键写错时"静默按 0 处理"会把她的记忆直接抹平。
  const injectMaxChars = typeof raw.inject_max_chars === 'number'
    && Number.isFinite(raw.inject_max_chars)
    && raw.inject_max_chars >= 100
    ? Math.floor(raw.inject_max_chars)
    : 800;

  // B（2026-10-17）：私聊把知识放进 system prompt 的 section（不进历史、不累积）。
  // **只认布尔**（理由同 learned_enabled：`"false"` 在 JS 里是真值）。
  const injectPrivateAsSection = typeof raw.inject_private_as_section === 'boolean'
    ? raw.inject_private_as_section
    : true;

  return { learnedEnabled, injectMaxChars, injectPrivateAsSection };
}

/**
 * `[free_time]` 的代码默认值 —— **每一项都必须"读不到 = 不跑"**。
 *
 * ⚠️ `enabled` 的默认值是 `false`，和 `[memory]` / `[mood]` 的"默认开着"**故意相反**：
 * 定时任务是**新行为**，没配就不该自己跑（用户没让小鲸鱼在半夜自己开口）。
 * 而 `[memory]` 那一套是"改动前一直在跑"，默认关掉反而是静默改行为。
 */
export const DEFAULT_FREE_TIME_CONFIG = Object.freeze({
  enabled: false,
  intervalHours: 3,
  // 短追问（2026-10-23）：用户最后一条消息之后这么久还没动静 ⇒ 叫她一声
  // 「你是不突然不回了」。**只追问一次**，用户再说话才重新武装。
  followupMinutes: 10,
  windowStartHour: 9,
  windowEndHour: 24,
  tokenBudgetPerTurn: 20000,
  quietWhenNothing: true,
  // 唤醒前截屏（2026-10-21）。默认**开着**：用户要的是"叫她的时候顺便看看屏幕"，
  // 关掉只是想让唤醒退回纯文字（比如在开会共享屏幕）。
  screenshots: true,
  // 只留最近几**轮**（工作区 tmp 里，按 `shot-<时间戳>[-N].png|jpg` 的时间戳分组清理）。
  //
  // ⚠️ 2026-10-22 语义变了：**一轮 = 一次唤醒 = 每块屏一张图**（双屏 ⇒ 2 张/轮）。
  // 以前这里是"保留几个文件"，分屏之后按文件数留会在同一个 tick 里把上一轮删光 ——
  // 表面上"保留 2 张"，实际永远只剩最新一轮。现在保留的是**最近 2 轮**（= 最多 2N 个文件）。
  screenshotsKeep: 2,
  // 🔴 2026-10-29：**每轮最多带几张截图喂给模型**（用户要的"唤醒时带几张"）。
  // ⚠️ 和 `screenshotsKeep` 是两件不同的事：那个管**磁盘上留几轮**（删图），
  // 这个管**这一轮投递几张**（看图）。落盘照旧每块屏一张，投递取前 N 张（按屏序）。
  // 默认 2 = 双屏各一张，也就是**改动前的行为**。
  screenshotsMaxPerWake: 2,
  // 2026-10-29：两段提示词的**兜底是代码**（`free-time.mjs` 的 `buildWakePrompt` /
  // `buildFollowupPrompt`）。空串 / 只有空白 = 用内置文案（与 `[send] rule` 同语义）。
  wakePrompt: '',
  followupPrompt: '',
});

/**
 * `[free_time]` 的九个键（读文件 / 写文件共用同一份清单）。
 *
 * ⚠️ **2026-10-29 起这不再等于"这一节的全部键"**：提示词（`wakePrompt` /
 * `followupPrompt`）和 `screenshotsMaxPerWake` 刻意**不进这张表** ——
 * 它们是配置页**逐键**写的（`POST /config`），而这张表只服务旧的
 * 「整段重写 `[free_time]`」接口（`POST /free-time`）：那个接口按这张表重建整段，
 * 表里没有的键会被**静默丢掉**。所以 `handleFreeTime` 里加了一道 fail-closed 闸门
 * （见那里的注释）：段里出现表外键就 400，不重写。
 */
export const FREE_TIME_KEYS = Object.freeze([
  'enabled',
  'intervalHours',
  'followupMinutes',
  'windowStartHour',
  'windowEndHour',
  'tokenBudgetPerTurn',
  'quietWhenNothing',
  'screenshots',
  'screenshotsKeep',
]);

/**
 * 读 toml 的 `[free_time]`：**定时任务**的开关与参数（2026-10-17 加）。
 *
 * 名字里的 `free_time` 是"空闲时间"——用户的原话是「**空闲的时候她自己会说话**」。
 * ⚠️ 本轮只做到「**能读到 + 进快照 + 能被设置页改**」，**定时器本身不在本轮**：
 * 也就是说 `enabled = true` 现在不会有任何动作，这是**刻意留的一步**
 * （先让配置链路可见，再接到引擎上）。
 *
 * toml 里长这样（驼峰与 `[memory]` 的蛇形两种写法都认）：
 *
 * ```toml
 * [free_time]
 * enabled = false
 * intervalHours = 3
 * windowStartHour = 9
 * windowEndHour = 24
 * tokenBudgetPerTurn = 20000
 * quietWhenNothing = true
 * ```
 *
 * 越界/类型不对 ⇒ **回默认值**（不夹紧、不猜意思），**绝不抛异常**：
 * 这个文件在用户手里，写错不该让小鲸鱼整个起不来（照 `loadLearnedMemoryConfig` 的约定）。
 *
 * @param {object} config 经 `resolveConfig` 的配置（这里只用 `tomlPath`）
 * @returns {{enabled: boolean, intervalHours: number, windowStartHour: number, windowEndHour: number, tokenBudgetPerTurn: number, quietWhenNothing: boolean}}
 */
/**
 * 读 `[send]` 段（2026-10-18，`send_qq`）。
 *
 * 两个字段：
 * - `rule`：写给她看的一句话，说明"什么时候该自己往 QQ 发、发几条"。
 *   以 prompt section `qq:send-rule` 注入 ⇒ 改 toml + 点重载就能改行为。
 * - `auto_reply`（B2，2026-10-25）：`fallback`（默认）/ `always` / `off`。
 *   决定"她这一轮没调 `send_qq` 时，插件要不要把她的输出自动发出去"。
 *   取值不认识 ⇒ 回 `fallback`（**不是** `always`：打错一个字就悄悄退回
 *   "会重复发"的旧行为，是最难查的那种静默错）。
 *
 * 读不到 / 类型不对 ⇒ 回默认（和一整套 toml 读取器一致：**永不 throw**）。
 *
 * @param {{tomlPath?: string}} [config]
 * @returns {{rule: string, autoReply: 'fallback'|'always'|'off', splitMarker: string, splitMaxParts: number, maxImageMb: number}}
 */
export function loadSendConfig(config) {
  const tomlPath = String(config?.tomlPath ?? defaultTomlPath());
  let section = null;
  try {
    const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
    section = doc?.send ?? null;
  } catch {
    section = null;
  }
  const raw = section !== null && typeof section === 'object' && !Array.isArray(section) ? section : {};
  const rule = typeof raw.rule === 'string' ? raw.rule.trim() : '';
  const rawMode = typeof raw.auto_reply === 'string' ? raw.auto_reply.trim() : '';
  const autoReply = rawMode === 'always' || rawMode === 'off' || rawMode === 'fallback'
    ? rawMode
    : 'fallback';
  // 消息切分（B3）：`split_marker` 是"独立一行就切"的标记；没写 ⇒ 默认 `⟨cut⟩`，
  // **空串 = 显式关掉**（所以不能用 `||` 兜底 —— 那会把"用户想关"变成"用默认值"）。
  const splitMarker = typeof raw.split_marker === 'string' ? raw.split_marker.trim() : '⟨cut⟩';
  // ⚠️ 只认 **number**：TOML 的 `true` 会被 `Number(true)` 变成 1（`"很多"` 变 NaN 还好），
  // 那样"写错类型"就悄悄变成"最多切 1 段"= 这个功能看起来坏了。
  const rawParts = raw.split_max_parts;
  const splitMaxParts = typeof rawParts === 'number' && Number.isFinite(rawParts) && rawParts >= 1
    ? Math.floor(rawParts)
    : 4;
  // 2026-10-26：`send_qq` 发图的大小上限（MB，只对本地文件生效）。
  // 认 (0, 200] 的有限数；写错类型/越界一律回默认 —— 别让一个笔误把闸关死或撑爆。
  const rawImageMb = raw.max_image_mb;
  const maxImageMb = typeof rawImageMb === 'number' && Number.isFinite(rawImageMb)
    && rawImageMb > 0 && rawImageMb <= 200
    ? rawImageMb
    : 10;
  return { rule, autoReply, splitMarker, splitMaxParts, maxImageMb };
}

/**
 * 读 `[voice]` 段（B4 真答案，2026-10-25）：**本地 faster-whisper 转写语音**。
 *
 * 为什么在 toml 里：python / 模型目录都是**这台机器**的事实，而插件代码该是通用的
 * —— 换个部署不该被迫带一段"只在这台机子上有意义"的绝对路径。
 *
 * 字段与默认值见 `voice.mjs` 的 `DEFAULT_VOICE`（**只留一份**，不在这里重抄）。
 *
 * 读不到 / 类型不对 ⇒ 回默认（和一整套 toml 读取器一致：**永不 throw**）。
 *
 * @param {{tomlPath?: string}} [config]
 * @returns {{enabled: boolean, python: string, script: string, model: string, device: 'cuda'|'cpu', language: string, timeoutMs: number, cachePath: string}}
 */
export function loadVoiceConfig(config) {
  const tomlPath = sideTomlPath(config, 'voice');
  let section = null;
  try {
    const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
    section = doc?.voice ?? null;
  } catch {
    section = null;
  }
  const raw = section !== null && typeof section === 'object' && !Array.isArray(section) ? section : {};
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const deviceRaw = text(raw.device).toLowerCase();
  const timeoutRaw = raw.timeout_ms;
  return {
    // `enabled` 只认真正的布尔：字符串 `"false"` 一律当没配（默认关）。
    enabled: raw.enabled === true,
    python: text(raw.python),
    script: text(raw.script),
    model: text(raw.model),
    device: deviceRaw === 'cpu' ? 'cpu' : 'cuda',
    language: typeof raw.language === 'string' ? raw.language.trim() : DEFAULT_VOICE.language,
    timeoutMs: typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw >= 1000
      ? Math.floor(timeoutRaw)
      : DEFAULT_VOICE.timeoutMs,
    cachePath: text(raw.cache_path),
    // 引擎（2026-10-25 加）：`auto` = 先问 QQ 自己的 `fetch_ptt_text`，失败再本地 whisper。
    // 认不出的取值当 `auto`（两个引擎都在的时候，"尽量转出来"永远是对的）。
    engine: (() => {
      const want = text(raw.engine).toLowerCase();
      return want === 'ntqq' || want === 'whisper' ? want : 'auto';
    })(),
    // 🔴 写临时文件的地方（python 用）。**不能默认落在 `<DSH_HOME>`**：
    // 那棵树对子进程只读，落那儿 = 每次转写都 `Permission denied`
    // （2026-10-25 实线事故）。留空 ⇒ 由 index.mjs 填工作区下的 `shared\tmp\qq-voice`。
    tempDir: text(raw.temp_dir),
  };
}

/**
 * 读 `[tts]` 段（2026-10-26）：**文字转语音（出站）**，`edge-tts` → mp3 → NapCat 转 silk。
 *
 * 为什么在 toml 里：python 路径、音色、缓存目录都是**这台机器 / 这个人**的事实，
 * 而插件代码该是通用的。字段与默认值见 `tts.mjs` 的 `DEFAULT_TTS`（**只留一份**）。
 *
 * 读不到 / 类型不对 ⇒ 回默认（和整套 toml 读取器一致：**永不 throw**）。
 *
 * @param {{tomlPath?: string}} [config]
 * @returns {{enabled: boolean, voice: string, rate: string, pitch: string, maxChars: number, allowGroups: boolean, minGapMs: number, timeoutMs: number, python: string, script: string, cacheDir: string}}
 */
export function loadTtsConfig(config) {
  const tomlPath = sideTomlPath(config, 'tts');
  let section = null;
  try {
    const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
    section = doc?.tts ?? null;
  } catch {
    section = null;
  }
  const raw = section !== null && typeof section === 'object' && !Array.isArray(section) ? section : {};
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const num = (value, fallback, min, max) => (typeof value === 'number' && Number.isFinite(value)
    && value >= min && value <= max ? Math.floor(value) : fallback);
  return {
    // `enabled` 只认真正的布尔：字符串 `"false"` 一律当没配（默认关 —— 它要装 edge-tts）。
    enabled: raw.enabled === true,
    voice: text(raw.voice) || DEFAULT_TTS.voice,
    rate: text(raw.rate) || DEFAULT_TTS.rate,
    pitch: text(raw.pitch) || DEFAULT_TTS.pitch,
    maxChars: num(raw.max_chars, DEFAULT_TTS.maxChars, 1, 2000),
    // 群里默认**不许**发语音：只认 `true`，其余（含写错的字符串）一律 false。
    allowGroups: raw.allow_groups === true,
    minGapMs: num(raw.min_gap_ms, DEFAULT_TTS.minGapMs, 0, 600_000),
    timeoutMs: num(raw.timeout_ms, DEFAULT_TTS.timeoutMs, 1000, 300_000),
    python: text(raw.python),
    script: text(raw.script),
    // 🔴 缓存目录**不能默认落 `<DSH_HOME>`**（那棵树对子进程只读）。
    // 留空 ⇒ 由 index.mjs 填工作区下的 `shared\tmp\qq-tts`。
    cacheDir: text(raw.cache_dir),
  };
}

/**
 * 读 `[emotion]` 段（2026-10-26）：**语音情绪旁路**（wav2small，只算 arousal）。
 *
 * 字段与默认值见 `emotion.mjs` 的 `DEFAULT_EMOTION`（**只留一份**，不在这里重抄）。
 * 读不到 / 类型不对 ⇒ 回默认（和整套 toml 读取器一致：**永不 throw**）。
 *
 * @param {{tomlPath?: string}} [config]
 * @returns {{enabled: boolean, python: string, script: string, modelDir: string, arousalHigh: number, minSeconds: number, minRms: number, timeoutMs: number, cacheDir: string}}
 */
export function loadEmotionConfig(config) {
  const tomlPath = sideTomlPath(config, 'voice');
  let section = null;
  try {
    const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
    section = doc?.emotion ?? null;
  } catch {
    section = null;
  }
  const raw = section !== null && typeof section === 'object' && !Array.isArray(section) ? section : {};
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const num = (value, fallback, min, max) => (typeof value === 'number' && Number.isFinite(value)
    && value >= min && value <= max ? value : fallback);
  return {
    // `enabled` 只认真正的布尔（字符串 `"false"` 当没配 ⇒ 默认关）。
    enabled: raw.enabled === true,
    python: text(raw.python),
    script: text(raw.script),
    modelDir: text(raw.model_dir),
    // 阈值只认 (0,1) 里的数：写 75 或 "0.75" 都当没配（回 0.75），别让笔误把闸关死。
    arousalHigh: num(raw.arousal_high, DEFAULT_EMOTION.arousalHigh, 0.01, 0.99),
    minSeconds: num(raw.min_seconds, DEFAULT_EMOTION.minSeconds, 0, 120),
    minRms: num(raw.min_rms, DEFAULT_EMOTION.minRms, 0, 1),
    timeoutMs: num(raw.timeout_ms, DEFAULT_EMOTION.timeoutMs, 1000, 300_000),
    // 🔴 临时 JSON 目录**不能默认落 `<DSH_HOME>`**（那棵树对子进程只读）。
    // 留空 ⇒ 由 index.mjs 填工作区下的 `shared\tmp\qq-emotion`。
    cacheDir: text(raw.cache_dir),
  };
}

export function loadFreeTimeConfig(config) {
  const tomlPath = String(config?.tomlPath ?? defaultTomlPath());
  let section = null;
  try {
    const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
    section = doc?.free_time ?? null;
  } catch {
    section = null;
  }
  const raw = section !== null && typeof section === 'object' && !Array.isArray(section) ? section : {};

  // 两种命名都认：`interval_hours`（与 `[memory]` 一致）和 `intervalHours`
  // （与设置页 POST body 一致）。**驼峰优先** —— 那是设置页写出去的名字。
  const read = (camel, snake) => (raw[camel] !== undefined ? raw[camel] : raw[snake]);

  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const num = (value, fallback, min, max, integer) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    const n = integer ? Math.floor(value) : value;
    if (n < min || n > max) return fallback;
    return n;
  };

  const enabled = bool(read('enabled', 'enabled'), DEFAULT_FREE_TIME_CONFIG.enabled);
  const intervalHours = num(
    read('intervalHours', 'interval_hours'), DEFAULT_FREE_TIME_CONFIG.intervalHours, 1, 24, false,
  );
  // 短追问间隔（2026-10-23）：用户最后一条消息之后这么久没新消息 ⇒ 追问一次。
  // 1~1440 分钟（一天）。**按整数读**：分钟本来就该是整数，写 10.5 说明想歪了，
  // 不如落到 10，并且这个值在快照里看得见（本项目最贵的坑就是"配置静默不按写的跑"）。
  const followupMinutes = num(
    read('followupMinutes', 'followup_minutes'),
    DEFAULT_FREE_TIME_CONFIG.followupMinutes,
    1,
    1440,
    true,
  );
  const windowStartHour = num(
    read('windowStartHour', 'window_start_hour'), DEFAULT_FREE_TIME_CONFIG.windowStartHour, 0, 23, true,
  );
  // `windowEndHour` 依赖 `windowStartHour`：**必须严格大于它**，否则回默认 24。
  // 写成 `end <= start` 的时段（比如 22→6 这种跨零点）本轮**不支持** ——
  // 宁可回默认让人看见，也不静默按一个他没想过的解释跑。
  const endRaw = num(read('windowEndHour', 'window_end_hour'), DEFAULT_FREE_TIME_CONFIG.windowEndHour, 1, 24, true);
  const windowEndHour = endRaw > windowStartHour ? endRaw : DEFAULT_FREE_TIME_CONFIG.windowEndHour;
  const tokenBudgetPerTurn = num(
    read('tokenBudgetPerTurn', 'token_budget_per_turn'),
    DEFAULT_FREE_TIME_CONFIG.tokenBudgetPerTurn,
    1000,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  const quietWhenNothing = bool(
    read('quietWhenNothing', 'quiet_when_nothing'), DEFAULT_FREE_TIME_CONFIG.quietWhenNothing,
  );
  // 截图（2026-10-21）：只认 `screenshots`，没有蛇形别名；保留张数认 `screenshotsKeep` /
  // `screenshots_keep`。越界/类型不对 ⇒ 回默认（和这一节其它键同一条规矩）。
  const screenshots = bool(read('screenshots', 'screenshots'), DEFAULT_FREE_TIME_CONFIG.screenshots);
  const screenshotsKeep = num(
    read('screenshotsKeep', 'screenshots_keep'),
    DEFAULT_FREE_TIME_CONFIG.screenshotsKeep,
    1,
    50,
    true,
  );
  // 每轮最多带几张截图（2026-10-29）。**不合法就回默认 2**，和其它数值键同一条规矩。
  const screenshotsMaxPerWake = num(
    read('screenshotsMaxPerWake', 'screenshots_max_per_wake'),
    DEFAULT_FREE_TIME_CONFIG.screenshotsMaxPerWake,
    1,
    50,
    true,
  );
  // 提示词（2026-10-29）：**原样读，不 trim** —— 用户填的每个字节都要留住
  // （"空 = 用内置文案"由 `free-time.mjs` 用 `trim() !== ''` 判，那里不丢内容）。
  // 类型不对（写成数字/数组）⇒ 当成没写（空串），不猜他的意思。
  const prompt = (camel, snake) => {
    const value = read(camel, snake);
    return typeof value === 'string' ? value : '';
  };
  const wakePrompt = prompt('wakePrompt', 'wake_prompt');
  const followupPrompt = prompt('followupPrompt', 'followup_prompt');

  return {
    enabled,
    intervalHours,
    followupMinutes,
    windowStartHour,
    windowEndHour,
    tokenBudgetPerTurn,
    quietWhenNothing,
    screenshots,
    screenshotsKeep,
    screenshotsMaxPerWake,
    wakePrompt,
    followupPrompt,
  };
}

/** `[mood]` 的代码默认值 —— **每一项都必须"读不到 = 与改动前等价"**。 */
export const DEFAULT_MOOD_CONFIG = Object.freeze({
  /** 默认开着（改动前它一直在跑，"读不到 toml 段"不该等于"把它关掉"）。 */
  enabled: true,
  /** 空串 = **回退到小鲸鱼对话那条路**（`config.provider` / `config.model`）。 */
  provider: '',
  model: '',
  /** 不思考 = 不发那个参数。心情更新是 100 token 的后台小任务，不需要推理。 */
  reasoningEffort: 'off',
});

/**
 * 心情的**节奏默认值**（2026-10-30 上配置页）。
 *
 * 每一项都等于改动前的写死值，只有 `transcriptMessages` 是例外 ——
 * 它原来是"只有当前这一条消息"，现在默认给 20 条真实转录（用户明确问过"有上下文吗"）。
 */
export const DEFAULT_MOOD_RHYTHM = Object.freeze({
  transcriptMessages: 20,
  cooldownMinutes: 0,
  updateBaseProb: 0.1,
  updateRampPerMin: 0.1,
  updateMaxProb: 0.5,
  regressAfterSeconds: 200,
  regressMax: 2,
});

/**
 * 读 toml 的 `[mood]`：动态心情用**哪条模型**跑 + 开关（2026-10-14）。
 *
 * 用户指令：「心情更新改成云端的千问的小模型，找找 30b 左右的，接进去」。
 *
 * toml 里长这样：
 *
 * ```toml
 * [mood]
 * enabled = true
 * provider = "qwen"
 * model = "qwen3-30b-a3b-instruct-2507"
 * reasoning_effort = "off"
 * ```
 *
 * **三层，缺一层用下一层**：
 * 1. `[mood]` 写了 ⇒ 用它；
 * 2. `[mood]` 没写 / 没人配 provider ⇒ **回退到小鲸鱼对话那条路**
 *    （`config.provider || 'deepseek-official'` / `config.model || 'deepseek-flash'`）
 *    —— 这是改动前的行为，**读不到这一节时行为不许变**；
 * 3. 连 cordis 配置也没有 ⇒ 上面那两个硬编码兜底。
 *
 * ⚠️ `reasoning_effort` 单独拎出来是**故意的**：不同模型路由对它的接受度不同，
 *    不接受时会抛 `UNSUPPORTED_REASONING_EFFORT`（不是静默忽略），
 *    所以它必须能靠改这一行换掉 —— 见 {@link createMood} 的参数说明。
 *
 * ⚠️ **它只读 `[mood]`，不碰 `[proactive]`**：两节的覆盖是分开的，
 *    心情不该被主动发言的规则牵动（`loadProactiveConfig` 只管后者）。
 *
 * 读不到 toml / 这一节不存在 ⇒ **回退默认值，绝不抛异常**
 * （配置文件写错不该让小鲸鱼整个起不来）。
 *
 * @param {object} config 经 `resolveConfig` 的配置（这里只用 `provider` / `model` / `tomlPath`）
 * @returns {{enabled: boolean, provider: string, model: string, reasoningEffort: string}}
 */
export function loadMoodConfig(config) {
  const tomlPath = sideTomlPath(config, 'mood');
  let section = null;
  try {
    const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
    section = doc?.mood ?? null;
  } catch {
    section = null;
  }
  const raw = section !== null && typeof section === 'object' && !Array.isArray(section) ? section : {};

  // `enabled` 只认布尔：写 `"false"`（带引号的字符串）在 toml 里是**很自然的错法**，
  // 而 JS 里 `"false"` 是真值 —— 静默当成"开着"就正好把用户想止血的开关吃掉。
  // 所以不合法就回默认值（true），不猜他的意思。
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_MOOD_CONFIG.enabled;

  // 非空串才算"配了"。空串/只有空格 = 没配 ⇒ 走回退（provider/model 的自动回退
  // 正是靠这条；`reasoning_effort` 反过来 —— 见下面单独处理的那一处）。
  const str = (value) => (value === null || value === undefined ? '' : String(value).trim());
  const pick = (value, fallback) => {
    const text = str(value);
    return text === '' ? fallback : text;
  };
  /** 数字：非数字 ⇒ 回默认；越界 ⇒ 夹到边界（与 `[vision_gate]` 同一条规矩）。 */
  const numIn = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  // ⚠️ `reasoning_effort` **单独一条路**：它把空串当成**有意义的取值**
  //    （= "别发这个字段"），所以不能走 pick 的"空 = 没配"逻辑。
  //    - 键没写        ⇒ 默认 `'off'`（改动前的行为）；
  //    - 写了空串 `""` ⇒ 原样输出空串 ⇒ `mood.mjs` 里**一个字段都不发**。
  //    这一档是留给"连 `off` 都不接受"的路由的退路。
  const effortRaw = raw.reasoning_effort;
  const reasoningEffort = effortRaw === null || effortRaw === undefined
    ? DEFAULT_MOOD_CONFIG.reasoningEffort
    : str(effortRaw);

  return {
    enabled,
    provider: pick(raw.provider, str(config?.provider) || 'deepseek-official'),
    model: pick(raw.model, str(config?.model) || 'deepseek-flash'),
    reasoningEffort,
    // 2026-10-30：三段提示词（空串 = 用 mood.mjs 里的原文）。
    systemPrompt: pick(raw.system_prompt, ''),
    updateNote: pick(raw.update_note, ''),
    regressNote: pick(raw.regress_note, ''),
    // 2026-10-30：节奏（概率曲线 + 硬冷却 + 平复 + 上下文条数）。
    transcriptMessages: numIn(raw.transcript_messages, DEFAULT_MOOD_RHYTHM.transcriptMessages, 1, 200),
    cooldownMinutes: numIn(raw.cooldown_minutes, DEFAULT_MOOD_RHYTHM.cooldownMinutes, 0, 1440),
    updateBaseProb: numIn(raw.update_base_prob, DEFAULT_MOOD_RHYTHM.updateBaseProb, 0, 1),
    updateRampPerMin: numIn(raw.update_ramp_per_min, DEFAULT_MOOD_RHYTHM.updateRampPerMin, 0, 1),
    updateMaxProb: numIn(raw.update_max_prob, DEFAULT_MOOD_RHYTHM.updateMaxProb, 0, 1),
    regressAfterSeconds: numIn(raw.regress_after_seconds, DEFAULT_MOOD_RHYTHM.regressAfterSeconds, 0, 86400),
    regressMax: numIn(raw.regress_max, DEFAULT_MOOD_RHYTHM.regressMax, 0, 20),
  };
}

/**
 * 「那个会话此刻的心情」→ 能塞进提示词的一小句（**两个落点共用同一份口径**，2026-10-15）。
 *
 * 为什么要有这个函数：`mood.mjs` 的 `getMood()` 在此之前**零调用** ——
 * 心情生成出来了，却没有任何地方读它（心事故障：不报错、计数正常、只是什么都没发生）。
 * 两个落点都要用它，而"什么时候算没有心情"这件事**只能有一处口径**，
 * 否则两个落点会漂移（一个加了、一个没加）。
 *
 * ## 行为契约（四条，都有测试钉着）
 *
 * 1. **`mood === null`（`[mood] enabled = false`）⇒ `''`** —— 关掉就要一键止血；
 * 2. **这个 chatId 没记录 / 心情是空串 ⇒ `''`** —— "没生成过"不许退化成默认那句
 *    `感觉很平静`（那会让"没触发"和"生成了"又混成一团，见 `mood.mjs` 的 `getMoodDiag` 注释）；
 * 3. **单行、有长度上限**（{@link MOOD_TEXT_MAX_CHARS}）—— 它是**每轮都进 prompt** 的东西；
 * 4. **绝不抛** —— 两个落点分别在 system prompt 组装路径与消息热路径上。
 *
 * ⚠️ **读的是 `getAllMoods()`（纯快照），不是 `getMood()`**：后者会**顺手创建**默认状态，
 * 于是快照里会凭空多出一堆 `感觉很平静`，把"没触发过"和"确实生成过这一句"混成同形。
 * `getAllMoods()` 缺席的会话就是**没有记录** ⇒ `''`。只有拿不到 `getAllMoods` 时
 * 才退回 `getMood()`（兼容别的实现 / 测试桩）。
 *
 * @param {{getAllMoods?: () => Record<string,string>, getMood?: (chatId: string) => string}|null} mood
 *   心情管理器（`index.mjs` 里那个 `mood`；`null` = 关掉了）
 * @param {string} chatId 形如 `group:30000013` / `private:30000001`
 * @returns {string} 一句心情（单行、已截断），没有就是 `''`
 */
export function moodTextFor(mood, chatId) {
  try {
    if (mood === null || mood === undefined) return '';
    const id = String(chatId ?? '');
    // 没有 chatId 就没法谈"是谁的心情" —— 宁可没有，也不能张冠李戴。
    if (id === '') return '';
    let raw = '';
    if (typeof mood.getAllMoods === 'function') {
      const all = mood.getAllMoods();
      raw = all !== null && typeof all === 'object' && !Array.isArray(all) ? all[id] : '';
    } else if (typeof mood.getMood === 'function') {
      raw = mood.getMood(id);
    }
    // 压成单行：模型可能吐换行，而换行会把提示词里那一行拆开（读起来像另起一段）。
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (text === '') return '';
    // 按码点截断（别把 emoji 的代理对切成半个字符）。
    const points = Array.from(text);
    return points.length > MOOD_TEXT_MAX_CHARS ? points.slice(0, MOOD_TEXT_MAX_CHARS).join('') : text;
  } catch {
    // 调试/观测设施绝不拖垮主流程：取不到 = 没有心情。
    return '';
  }
}

/**
 * 心情那一小段的字符上限。
 *
 * 为什么必须封顶（而不是"相信模型会写短"）：这一句**每一轮**都进 system prompt，
 * 而 `precheck` 那条路还要求"极短"（那是一次性、`maxTokens=4` 的调用）。
 * 60 个字符足够装下一句中文心情（实测线上那条 16 字）。
 */
export const MOOD_TEXT_MAX_CHARS = 60;
