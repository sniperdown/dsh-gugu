/**
 * 配置页的**字段目录**（2026-10-21）。
 *
 * ## 这个目录解决什么
 *
 * 配置页按 `scope + key` 读写：`GET /settings` 回一份 `fields[]`，前端照着渲染；
 * `POST /config` 回传 `{scope, key, value}`。所以**键名必须唯一**——
 * 而 toml 里有些键名在多个段里重复（`enabled` 在 `[free_time]` / `[mood]` 都有，
 * `provider` / `model` 在 `[mood]` / `[sticker_gate]` 都有，`rule` 在 `[send]` 里也有）。
 *
 * 规则：
 *
 * - **人格五段用裸名**（`personality` / `reply_style` / `emotion_style` /
 *   `interest` / `rules`）—— 因为覆盖层的 `key` 就是这几个名字，
 *   全局与 `group:<号>` / `private:<号>` 必须共用同一个键；
 * - 其它字段用 `<段名>.<键>`（`free_time.enabled` / `mood.provider` / …），
 *   唯一且能一眼看出落在哪一段；
 * - `admins` 保持裸名（`[owner]` 段里没有重名，而且危险键清单写的就是 `admins`）。
 *
 * ## `value` 与 `effective` 的区别
 *
 * - `value`：**文件里写的**（没写 ⇒ `null`；写错类型 ⇒ `null`）；
 * - `effective`：**进程里生效的**（来自 `apply()` 时读到的那一份）。
 *
 * 两者不同 = "改过但没重载"，这正是本项目最贵的一类坑（`stale:false` 只证明代码新）。
 *
 * @module qq-dsh/config-fields
 */

import { DEFAULT_REASONING_EFFORT, REASONING_EFFORT_VALUES } from './agent-config.mjs';
import { normalizeAdminList } from './owner.mjs';
import { readTomlKey } from './toml-edit.mjs';
import { fileKeyForSection } from './toml-files.mjs';

/**
 * 可编辑字段。
 *
 * ⚠️ `file` 由 {@link CONFIG_FIELDS} 在导出时补上（2026-10-30）：
 * 旁路模型的设置拆成独立文件之后，**每一项都要说清它落在哪个文件里**。
 * 没写 `file` 的按段名推导（`[mood]` ⇒ `qq-gugu.mood.toml`，见 `toml-files.mjs`
 * 的 `fileKeyForSection`）—— 于是新增字段时**不用记得补这一项**，
 * 少了它只会是"落错文件"，而这里让它不可能漏。
 *
 * @type {Array<{
 *   key: string, label: string, section: string, sectionPath: string[], tomlKey: string,
 *   type: 'text'|'number'|'bool'|'enum'|'array'|'multiline',
 *   effectivePath: string[], default: unknown, danger?: boolean, options?: string[],
 *   file?: 'main'|'mood'|'vision'|'sticker'|'voice'|'tts'
 * }>}
 */
const RAW_CONFIG_FIELDS = [
  // ── 人格（全局 + 按会话覆盖共用这五个键） ──
  { key: 'persona', label: '角色设定', section: 'personality', sectionPath: ['personality'], tomlKey: 'persona', type: 'multiline', effectivePath: ['personality', 'persona'], default: '' },
  { key: 'relations', label: '关系与称呼', section: 'personality', sectionPath: ['personality'], tomlKey: 'relations', type: 'multiline', effectivePath: ['personality', 'relations'], default: '' },
  { key: 'reply_style', label: '表达风格', section: 'personality', sectionPath: ['personality'], tomlKey: 'reply_style', type: 'multiline', effectivePath: ['personality', 'reply_style'], default: '' },
  { key: 'emotion_style', label: '情绪特征', section: 'personality', sectionPath: ['personality'], tomlKey: 'emotion_style', type: 'multiline', effectivePath: ['personality', 'emotion_style'], default: '' },
  { key: 'interest', label: '兴趣', section: 'personality', sectionPath: ['personality'], tomlKey: 'interest', type: 'multiline', effectivePath: ['personality', 'interest'], default: '' },
  { key: 'chat_sense', label: '群聊判断力', section: 'personality', sectionPath: ['personality'], tomlKey: 'chat_sense', type: 'multiline', effectivePath: ['personality', 'chat_sense'], default: '' },
  { key: 'ai_flavor', label: 'AI 味黑名单', section: 'personality', sectionPath: ['personality'], tomlKey: 'ai_flavor', type: 'multiline', effectivePath: ['personality', 'ai_flavor'], default: '' },
  { key: 'examples', label: '说话示例', section: 'personality', sectionPath: ['personality'], tomlKey: 'examples', type: 'multiline', effectivePath: ['personality', 'examples'], default: '' },
  { key: 'rules', label: '硬规矩', section: 'personality', sectionPath: ['personality'], tomlKey: 'rules', type: 'multiline', effectivePath: ['personality', 'rules'], default: '' },

  // ── 小鲸鱼的推理等级（[agent]） ──
  //
  // 为什么单开一段 `[agent]`、不塞进 `[personality]`：
  // `[personality]` 回答"她是谁"（人格文本，有按会话覆盖层），而推理等级是
  // **建 agent 时的模型参数**（`agentOptions.reasoningEffort`），和 `[mood]`
  // 那种"这条后台任务用哪条模型"是同一类东西 —— 混进人格段会让"改人格"
  // 顺带改变花钱/延迟，也让按会话覆盖人格时多出一个不该被覆盖的键。
  //
  // ⚠️ 选项来自 `agent-config.mjs` 的 `REASONING_EFFORT_VALUES`（**查证过的**），
  //    不是在这里另抄一份 —— 抄一份就会漂移（"配置页能选、运行时抛错"）。
  { key: 'agent.reasoning', label: '推理等级', section: 'agent', sectionPath: ['agent'], tomlKey: 'reasoning', type: 'enum', options: [...REASONING_EFFORT_VALUES], effectivePath: ['agent', 'reasoning'], default: DEFAULT_REASONING_EFFORT },

  // ── 用户 ──
  { key: 'admins', label: '用户 QQ', section: 'owner', sectionPath: ['owner'], tomlKey: 'admins', type: 'array', effectivePath: ['owner', 'admins'], default: [], danger: true },

  // ── 定时任务（[free_time]） ──
  { key: 'free_time.enabled', label: '定时任务开关', section: 'free_time', sectionPath: ['free_time'], tomlKey: 'enabled', type: 'bool', effectivePath: ['freeTime', 'enabled'], default: false },
  { key: 'free_time.intervalHours', label: '间隔（小时）', section: 'free_time', sectionPath: ['free_time'], tomlKey: 'intervalHours', type: 'number', effectivePath: ['freeTime', 'intervalHours'], default: 3 },
  // 短追问（2026-10-23）：用户最后一条消息之后这么久没动静 ⇒ 叫她一声「你是不突然不回了」。
  // 它和 `intervalHours` 是**两个闹钟**：长的是"她自己的时间"（截图 + 自省），短的是"问问怎么了"。
  // ⚠️ 短唤醒**不截图**（用户要求），所以这一项和 `screenshots` 没有关系。
  { key: 'free_time.followupMinutes', label: '追问间隔（分钟）', section: 'free_time', sectionPath: ['free_time'], tomlKey: 'followupMinutes', type: 'number', effectivePath: ['freeTime', 'followupMinutes'], default: 10 },
  { key: 'free_time.windowStartHour', label: '窗口开始（时）', section: 'free_time', sectionPath: ['free_time'], tomlKey: 'windowStartHour', type: 'number', effectivePath: ['freeTime', 'windowStartHour'], default: 9 },
  { key: 'free_time.windowEndHour', label: '窗口结束（时）', section: 'free_time', sectionPath: ['free_time'], tomlKey: 'windowEndHour', type: 'number', effectivePath: ['freeTime', 'windowEndHour'], default: 24 },
  { key: 'free_time.tokenBudgetPerTurn', label: '单轮 token 预算', section: 'free_time', sectionPath: ['free_time'], tomlKey: 'tokenBudgetPerTurn', type: 'number', effectivePath: ['freeTime', 'tokenBudgetPerTurn'], default: 20000 },
  { key: 'free_time.quietWhenNothing', label: '没什么可说时保持安静', section: 'free_time', sectionPath: ['free_time'], tomlKey: 'quietWhenNothing', type: 'bool', effectivePath: ['freeTime', 'quietWhenNothing'], default: true },
  // 提示词搬进配置（2026-10-29）。**空串 = 用代码里的内置文案** —— 和 `[send] rule` /
  // `[send] rule` 同一个语义（那两段是用户先例，照抄，别发明新机制）。
  // 占位符用**函数式替换**填（见 `free-time.mjs` 的 `fillPlaceholders`）：
  // `{{budget}}`（长唤醒）/ `{{minutes}}`（短追问）/ `{{date}}` / `{{time}}`。
  // ⚠️ 兜底文案一个字都没改 —— 配置只是"盖在上面"，不是"替换掉"。
  { key: 'free_time.wakePrompt', label: '长唤醒提示词', section: 'free_time', sectionPath: ['free_time'], tomlKey: 'wakePrompt', type: 'multiline', effectivePath: ['freeTime', 'wakePrompt'], default: '' },
  { key: 'free_time.followupPrompt', label: '短追问提示词', section: 'free_time', sectionPath: ['free_time'], tomlKey: 'followupPrompt', type: 'multiline', effectivePath: ['freeTime', 'followupPrompt'], default: '' },
  // 唤醒前截图（2026-10-21；2026-10-22 改成**每块屏一张**）：只有"截不截"和"留几轮"——
  // ⚠️ **刻意没有缩放上限**（用户要先看 DSH 附件管线自己压到什么程度）。
  { key: 'free_time.screenshots', label: '唤醒前截屏（每块屏一张）', section: 'free_time', sectionPath: ['free_time'], tomlKey: 'screenshots', type: 'bool', effectivePath: ['freeTime', 'screenshots'], default: true },
  // ⚠️ 单位是**轮**，不是文件数：一轮 = 一次唤醒 = 每块屏一张图（双屏 ⇒ 2 张/轮），
  //    所以 2 = 最多留最近两轮（最多 4 个文件）。按文件数留会在同一个 tick 里把自己上一轮删掉。
  { key: 'free_time.screenshotsKeep', label: '截图保留轮数（每轮=每块屏一张）', section: 'free_time', sectionPath: ['free_time'], tomlKey: 'screenshotsKeep', type: 'number', effectivePath: ['freeTime', 'screenshotsKeep'], default: 2 },
  // 🔴 2026-10-29：**每轮最多带几张截图喂给模型**（用户说的"唤醒时带几张"）。
  // 和 `screenshotsKeep` **不是同一个概念**，别合并：
  //   `screenshotsKeep` = 磁盘上留几**轮**（清理旧图，管"删"）；
  //   `screenshotsMaxPerWake` = 这一轮**投递**几张（管"看图"）。
  // 落盘照旧每块屏一张，投递取前 N 张（按屏序）。默认 2 = 双屏各一张 = 改动前的行为。
  { key: 'free_time.screenshotsMaxPerWake', label: '每轮最多带几张截图', section: 'free_time', sectionPath: ['free_time'], tomlKey: 'screenshotsMaxPerWake', type: 'number', effectivePath: ['freeTime', 'screenshotsMaxPerWake'], default: 2 },


  // ── 记忆（[memory]） ──
  { key: 'memory.learned_enabled', label: '学来的记忆', section: 'memory', sectionPath: ['memory'], tomlKey: 'learned_enabled', type: 'bool', effectivePath: ['memory', 'learnedEnabled'], default: true },
  { key: 'memory.inject_max_chars', label: '注入字数上限', section: 'memory', sectionPath: ['memory'], tomlKey: 'inject_max_chars', type: 'number', effectivePath: ['memory', 'injectMaxChars'], default: 800 },
  { key: 'memory.inject_private_as_section', label: '私聊知识走 section', section: 'memory', sectionPath: ['memory'], tomlKey: 'inject_private_as_section', type: 'bool', effectivePath: ['memory', 'injectPrivateAsSection'], default: true },

  // ── 往 QQ 发东西的规矩 ──
  { key: 'send.rule', label: '发 QQ 的规矩', section: 'send', sectionPath: ['send'], tomlKey: 'rule', type: 'multiline', effectivePath: ['send', 'rule'], default: '' },
  // B2（2026-10-25）：她这一轮没用 `send_qq` 时，插件要不要把她的输出自动发出去。
  // `fallback` = 工具发过就不发（默认）· `always` = 老行为（会重复，只作回滚）· `off` = 只认工具。
  { key: 'send.auto_reply', label: '自动发送策略', section: 'send', sectionPath: ['send'], tomlKey: 'auto_reply', type: 'enum', options: ['fallback', 'always', 'off'], effectivePath: ['send', 'autoReply'], default: 'fallback' },
  // B3（2026-10-25）：**独立一行**等于这个标记 ⇒ 一条回复切成几条发。空串 = 关。
  { key: 'send.split_marker', label: '切分标记', section: 'send', sectionPath: ['send'], tomlKey: 'split_marker', type: 'text', effectivePath: ['send', 'splitMarker'], default: '⟨cut⟩' },
  { key: 'send.split_max_parts', label: '最多切几段', section: 'send', sectionPath: ['send'], tomlKey: 'split_max_parts', type: 'number', effectivePath: ['send', 'splitMaxParts'], default: 4 },

  // ── 语音转文字（[voice]，B4 真答案 2026-10-25） ──
  // NapCat 的 record 段没有转写，这里配的是"本机 faster-whisper 怎么调"。
  // python / script / model 都是**机器事实**，所以放在 toml 而不是代码里。
  { key: 'voice.enabled', label: '语音转文字', section: 'voice', sectionPath: ['voice'], tomlKey: 'enabled', type: 'bool', effectivePath: ['voice', 'enabled'], default: false },
  { key: 'voice.python', label: 'python 路径', section: 'voice', sectionPath: ['voice'], tomlKey: 'python', type: 'text', effectivePath: ['voice', 'python'], default: '', danger: true },
  { key: 'voice.script', label: '转写脚本', section: 'voice', sectionPath: ['voice'], tomlKey: 'script', type: 'text', effectivePath: ['voice', 'script'], default: '' },
  { key: 'voice.model', label: '模型目录', section: 'voice', sectionPath: ['voice'], tomlKey: 'model', type: 'text', effectivePath: ['voice', 'model'], default: '', danger: true },
  { key: 'voice.device', label: '设备', section: 'voice', sectionPath: ['voice'], tomlKey: 'device', type: 'enum', options: ['cuda', 'cpu'], effectivePath: ['voice', 'device'], default: 'cuda' },
  { key: 'voice.language', label: '语言', section: 'voice', sectionPath: ['voice'], tomlKey: 'language', type: 'text', effectivePath: ['voice', 'language'], default: 'zh' },
  { key: 'voice.timeout_ms', label: '转写超时(ms)', section: 'voice', sectionPath: ['voice'], tomlKey: 'timeout_ms', type: 'number', effectivePath: ['voice', 'timeoutMs'], default: 90000 },
  { key: 'voice.cache_path', label: '转写缓存文件', section: 'voice', sectionPath: ['voice'], tomlKey: 'cache_path', type: 'text', effectivePath: ['voice', 'cachePath'], default: '' },
  // ⚠️ 这里**必须**是工作区里的路径（比如 `shared\tmp\qq-voice`）：
  // `<DSH_HOME>` 对**子进程**只读，python 往那儿写会 `Permission denied`。
  { key: 'voice.temp_dir', label: '临时目录', section: 'voice', sectionPath: ['voice'], tomlKey: 'temp_dir', type: 'text', effectivePath: ['voice', 'tempDir'], default: '' },
  // 引擎：`auto` = 先问 QQ 自己的语音转文字（NapCat `fetch_ptt_text`），失败再本地 whisper。
  // `ntqq` = 只用 QQ 的（零 GPU，但 2026-10-25 实测会失败）；`whisper` = 只用本机。
  { key: 'voice.engine', label: '转写引擎', section: 'voice', sectionPath: ['voice'], tomlKey: 'engine', type: 'enum', options: ['auto', 'ntqq', 'whisper'], effectivePath: ['voice', 'engine'], default: 'auto' },

  // ── 心情（[mood]） ──
  { key: 'mood.enabled', label: '心情更新开关', section: 'mood', sectionPath: ['mood'], tomlKey: 'enabled', type: 'bool', effectivePath: ['mood', 'enabled'], default: true },
  { key: 'mood.provider', label: '心情 provider', section: 'mood', sectionPath: ['mood'], tomlKey: 'provider', type: 'text', effectivePath: ['mood', 'provider'], default: '', danger: true },
  { key: 'mood.model', label: '心情 model', section: 'mood', sectionPath: ['mood'], tomlKey: 'model', type: 'text', effectivePath: ['mood', 'model'], default: '', danger: true },

  // ── 判定模式（[proactive]） ──
  { key: 'proactive.judge_mode', label: '判定模式', section: 'proactive', sectionPath: ['proactive'], tomlKey: 'judge_mode', type: 'enum', options: ['heuristic', 'precheck', 'inTurn'], effectivePath: ['proactive', 'judge_mode'], default: 'heuristic' },
  // 私聊单独一套判定模式（2026-11-01）：留空 = 跟随上面的全局值。
  // 用户要的是"群里用 precheck、私聊用 inTurn"——私聊里让她自己决定这轮说不说。
  { key: 'proactive.judge_mode_private', label: '私聊判定模式（空=跟随）', section: 'proactive', sectionPath: ['proactive'], tomlKey: 'judge_mode_private', type: 'enum', options: ['', 'heuristic', 'precheck', 'inTurn'], effectivePath: ['proactive', 'judge_mode_private'], default: '' },
  // 决定开口的两种方式都留在主文件（2026-10-30 用户拍板）：预检用小模型、inTurn 直接塞上下文，
  // 拆成独立文件反而会把"说不说"这件事拆散。
  { key: 'proactive.precheck_model', label: '预检模型', section: 'proactive', sectionPath: ['proactive'], tomlKey: 'precheck_model', type: 'text', effectivePath: ['proactive', 'precheck_model'], default: '' },

  // ── 心情（默认 qq-gugu.mood.toml；没拆分时在主文件） ──
  // `default` 只用于"生效值取不到时页面上怎么显示"，**真值由加载器决定**（同一份默认值写在加载器里）。
  { key: 'mood.reasoning_effort', label: '心情推理档位', section: 'mood', sectionPath: ['mood'], tomlKey: 'reasoning_effort', type: 'enum', options: [...REASONING_EFFORT_VALUES], effectivePath: ['mood', 'reasoningEffort'], default: 'off' },

  // ── 识图（qq-gugu.vision.toml） ──
  { key: 'vision_gate.freeMiB', label: '空闲显存阈值（MiB）', section: 'vision_gate', sectionPath: ['vision_gate'], tomlKey: 'freeMiB', type: 'number', effectivePath: ['vision', 'freeMiB'], default: 7168 },
  { key: 'vision_gate.cacheMs', label: '显存读数缓存（ms）', section: 'vision_gate', sectionPath: ['vision_gate'], tomlKey: 'cacheMs', type: 'number', effectivePath: ['vision', 'cacheMs'], default: 5000 },
  { key: 'vision_gate.probeTimeoutMs', label: '显存探针超时（ms）', section: 'vision_gate', sectionPath: ['vision_gate'], tomlKey: 'probeTimeoutMs', type: 'number', effectivePath: ['vision', 'probeTimeoutMs'], default: 5000 },
  { key: 'vision_gate.cloud.provider', label: '云端 provider', section: 'vision_gate', sectionPath: ['vision_gate', 'cloud'], tomlKey: 'provider', type: 'text', effectivePath: ['vision', 'cloud', 'provider'], default: '' },
  { key: 'vision_gate.cloud.model', label: '云端 model', section: 'vision_gate', sectionPath: ['vision_gate', 'cloud'], tomlKey: 'model', type: 'text', effectivePath: ['vision', 'cloud', 'model'], default: '' },
  { key: 'vision_gate.local.provider', label: '本地 provider', section: 'vision_gate', sectionPath: ['vision_gate', 'local'], tomlKey: 'provider', type: 'text', effectivePath: ['vision', 'local', 'provider'], default: '' },
  { key: 'vision_gate.local.model', label: '本地 model', section: 'vision_gate', sectionPath: ['vision_gate', 'local'], tomlKey: 'model', type: 'text', effectivePath: ['vision', 'local', 'model'], default: '' },

  // ── 表情包审核（qq-gugu.sticker.toml） ──
  // ⚠️ `prompt` 暂时不在这里：提示词文本的收拢是下一批，先只把"模型与阈值"搬上页。
  { key: 'sticker_gate.provider', label: '审核 provider', section: 'sticker_gate', sectionPath: ['sticker_gate'], tomlKey: 'provider', type: 'text', effectivePath: ['sticker', 'provider'], default: '' },
  { key: 'sticker_gate.model', label: '审核 model', section: 'sticker_gate', sectionPath: ['sticker_gate'], tomlKey: 'model', type: 'text', effectivePath: ['sticker', 'model'], default: '' },
  { key: 'sticker_gate.nsfwMax', label: '色情阈值（≥ 拒）', section: 'sticker_gate', sectionPath: ['sticker_gate'], tomlKey: 'nsfwMax', type: 'number', effectivePath: ['sticker', 'nsfwMax'], default: 4 },
  { key: 'sticker_gate.violenceMax', label: '暴力阈值（≥ 拒）', section: 'sticker_gate', sectionPath: ['sticker_gate'], tomlKey: 'violenceMax', type: 'number', effectivePath: ['sticker', 'violenceMax'], default: 4 },
  { key: 'sticker_gate.goreMax', label: '血腥阈值（≥ 拒）', section: 'sticker_gate', sectionPath: ['sticker_gate'], tomlKey: 'goreMax', type: 'number', effectivePath: ['sticker', 'goreMax'], default: 4 },
  { key: 'sticker_gate.uglyMax', label: '丑阈值（≥ 拒）', section: 'sticker_gate', sectionPath: ['sticker_gate'], tomlKey: 'uglyMax', type: 'number', effectivePath: ['sticker', 'uglyMax'], default: 4 },
  { key: 'sticker_gate.funnyMin', label: '有趣下限（< 拒）', section: 'sticker_gate', sectionPath: ['sticker_gate'], tomlKey: 'funnyMin', type: 'number', effectivePath: ['sticker', 'funnyMin'], default: 3 },
  { key: 'sticker_gate.captionMaxChars', label: '配文字数上限', section: 'sticker_gate', sectionPath: ['sticker_gate'], tomlKey: 'captionMaxChars', type: 'number', effectivePath: ['sticker', 'captionMaxChars'], default: 120 },
  { key: 'sticker_gate.maxTokens', label: '审核输出上限', section: 'sticker_gate', sectionPath: ['sticker_gate'], tomlKey: 'maxTokens', type: 'number', effectivePath: ['sticker', 'maxTokens'], default: 4000 },
  { key: 'sticker_gate.enableThinking', label: '开思考', section: 'sticker_gate', sectionPath: ['sticker_gate'], tomlKey: 'enableThinking', type: 'bool', effectivePath: ['sticker', 'enableThinking'], default: false },
  { key: 'sticker_audit.enabled', label: '审核留样', section: 'sticker_audit', sectionPath: ['sticker_audit'], tomlKey: 'enabled', type: 'bool', effectivePath: ['stickerAudit', 'enabled'], default: true },
  { key: 'sticker_audit.dir', label: '留样目录', section: 'sticker_audit', sectionPath: ['sticker_audit'], tomlKey: 'dir', type: 'text', effectivePath: ['stickerAudit', 'dir'], default: '' },
  { key: 'sticker_audit.maxFiles', label: '留样张数上限', section: 'sticker_audit', sectionPath: ['sticker_audit'], tomlKey: 'maxFiles', type: 'number', effectivePath: ['stickerAudit', 'maxFiles'], default: 200 },
  { key: 'sticker_audit.maxBytes', label: '留样字节上限', section: 'sticker_audit', sectionPath: ['sticker_audit'], tomlKey: 'maxBytes', type: 'number', effectivePath: ['stickerAudit', 'maxBytes'], default: 268435456 },
  { key: 'sticker_audit.index', label: '写索引', section: 'sticker_audit', sectionPath: ['sticker_audit'], tomlKey: 'index', type: 'bool', effectivePath: ['stickerAudit', 'index'], default: true },
  { key: 'sticker_audit.maxIndexLines', label: '索引行数上限', section: 'sticker_audit', sectionPath: ['sticker_audit'], tomlKey: 'maxIndexLines', type: 'number', effectivePath: ['stickerAudit', 'maxIndexLines'], default: 2000 },

  // ── 语音（qq-gugu.voice.toml；出站在 qq-gugu.tts.toml） ──
  // 情绪与转写同一条链：关掉转写 ⇒ 情绪也一起停（见 gateway 的 `#transcribeVoice`）。
  { key: 'emotion.enabled', label: '语音情绪旁路', section: 'emotion', sectionPath: ['emotion'], tomlKey: 'enabled', type: 'bool', effectivePath: ['emotion', 'enabled'], default: true },
  { key: 'emotion.python', label: '情绪 python', section: 'emotion', sectionPath: ['emotion'], tomlKey: 'python', type: 'text', effectivePath: ['emotion', 'python'], default: '', danger: true },
  { key: 'emotion.arousal_high', label: '唤醒度阈值', section: 'emotion', sectionPath: ['emotion'], tomlKey: 'arousal_high', type: 'number', effectivePath: ['emotion', 'arousalHigh'], default: 0.75 },
  { key: 'emotion.min_seconds', label: '最短片段（秒）', section: 'emotion', sectionPath: ['emotion'], tomlKey: 'min_seconds', type: 'number', effectivePath: ['emotion', 'minSeconds'], default: 1 },
  { key: 'emotion.min_rms', label: '最静 RMS', section: 'emotion', sectionPath: ['emotion'], tomlKey: 'min_rms', type: 'number', effectivePath: ['emotion', 'minRms'], default: 0.001 },
  { key: 'emotion.timeout_ms', label: '情绪推理超时（ms）', section: 'emotion', sectionPath: ['emotion'], tomlKey: 'timeout_ms', type: 'number', effectivePath: ['emotion', 'timeoutMs'], default: 20000 },
  { key: 'emotion.cache_dir', label: '情绪缓存目录', section: 'emotion', sectionPath: ['emotion'], tomlKey: 'cache_dir', type: 'text', effectivePath: ['emotion', 'cacheDir'], default: '' },
  { key: 'tts.enabled', label: '出站语音', section: 'tts', sectionPath: ['tts'], tomlKey: 'enabled', type: 'bool', effectivePath: ['tts', 'enabled'], default: true },
  { key: 'tts.voice', label: '音色', section: 'tts', sectionPath: ['tts'], tomlKey: 'voice', type: 'text', effectivePath: ['tts', 'voice'], default: 'zh-CN-XiaoxiaoNeural' },
  { key: 'tts.max_chars', label: '单次合成上限（字）', section: 'tts', sectionPath: ['tts'], tomlKey: 'max_chars', type: 'number', effectivePath: ['tts', 'maxChars'], default: 120 },
  { key: 'tts.allow_groups', label: '群聊也允许发语音', section: 'tts', sectionPath: ['tts'], tomlKey: 'allow_groups', type: 'bool', effectivePath: ['tts', 'allowGroups'], default: false },
  { key: 'tts.min_gap_ms', label: '两条语音最小间隔（ms）', section: 'tts', sectionPath: ['tts'], tomlKey: 'min_gap_ms', type: 'number', effectivePath: ['tts', 'minGapMs'], default: 5000 },
  { key: 'tts.python', label: 'TTS python', section: 'tts', sectionPath: ['tts'], tomlKey: 'python', type: 'text', effectivePath: ['tts', 'python'], default: '', danger: true },
  { key: 'tts.cache_dir', label: 'TTS 缓存目录', section: 'tts', sectionPath: ['tts'], tomlKey: 'cache_dir', type: 'text', effectivePath: ['tts', 'cacheDir'], default: '' },

  // ── 提示词里那些固定句子（`[prompt]`，2026-10-30 从代码搬出来） ──
  // 空串 = 用代码里的原文（与搬迁前逐字节相同）。这几项在主文件里，但归「提示词」标签页。
  { key: 'prompt.identity', label: '身份第一行', section: 'prompt', sectionPath: ['prompt'], tomlKey: 'identity', type: 'multiline', effectivePath: ['prompt', 'identity'], default: '' },
  { key: 'prompt.persona_style', label: '【说话方式】那一段', section: 'prompt', sectionPath: ['prompt'], tomlKey: 'persona_style', type: 'multiline', effectivePath: ['prompt', 'personaStyle'], default: '' },
  // 自称（2026-11-01）：**留空 = 一个字都不注入**（她自然说"我"），填了才加"自称固定用「X」…"。
  { key: 'prompt.self_name', label: '自称（留空=说「我」）', section: 'prompt', sectionPath: ['prompt'], tomlKey: 'self_name', type: 'text', effectivePath: ['prompt', 'selfName'], default: '' },
  { key: 'prompt.workdir', label: '工作目录那句', section: 'prompt', sectionPath: ['prompt'], tomlKey: 'workdir', type: 'text', effectivePath: ['prompt', 'workdir'], default: '' },
  { key: 'prompt.turn_group_header', label: '群聊骨架：群里刚在聊', section: 'prompt', sectionPath: ['prompt'], tomlKey: 'turn_group_header', type: 'text', effectivePath: ['prompt', 'turnGroupHeader'], default: '' },
  { key: 'prompt.turn_at_header', label: '群聊骨架：刚 @ 你的那条', section: 'prompt', sectionPath: ['prompt'], tomlKey: 'turn_at_header', type: 'text', effectivePath: ['prompt', 'turnAtHeader'], default: '' },
  { key: 'prompt.turn_pure_at', label: '纯 @ 时补的那句', section: 'prompt', sectionPath: ['prompt'], tomlKey: 'turn_pure_at', type: 'text', effectivePath: ['prompt', 'turnPureAt'], default: '' },
  { key: 'proactive.interject_prompt', label: '主动插话措辞', section: 'proactive', sectionPath: ['proactive'], tomlKey: 'interject_prompt', type: 'multiline', effectivePath: ['proactive', 'interject_prompt'], default: '' },
  { key: 'proactive.precheck_system', label: '预检系统段', section: 'proactive', sectionPath: ['proactive'], tomlKey: 'precheck_system', type: 'multiline', effectivePath: ['proactive', 'precheck_system'], default: '' },

  // ── 旁路模型的提示词（2026-10-30 第二批：至少让它们在页面上看得见） ──
  { key: 'mood.system_prompt', label: '心情 · 系统段', section: 'mood', sectionPath: ['mood'], tomlKey: 'system_prompt', type: 'multiline', effectivePath: ['mood', 'systemPrompt'], default: '' },
  { key: 'mood.update_note', label: '心情 · 更新那句', section: 'mood', sectionPath: ['mood'], tomlKey: 'update_note', type: 'multiline', effectivePath: ['mood', 'updateNote'], default: '' },
  { key: 'mood.regress_note', label: '心情 · 平复那句', section: 'mood', sectionPath: ['mood'], tomlKey: 'regress_note', type: 'multiline', effectivePath: ['mood', 'regressNote'], default: '' },
  // 节奏（2026-10-30）：这几项就是"多久换一次心情"的全部旋钮。
  { key: 'mood.transcript_messages', label: '能看到几条聊天记录', section: 'mood', sectionPath: ['mood'], tomlKey: 'transcript_messages', type: 'number', effectivePath: ['mood', 'transcriptMessages'], default: 20 },
  { key: 'mood.cooldown_minutes', label: '硬冷却（分钟，0=关）', section: 'mood', sectionPath: ['mood'], tomlKey: 'cooldown_minutes', type: 'number', effectivePath: ['mood', 'cooldownMinutes'], default: 0 },
  { key: 'mood.update_base_prob', label: '更新概率 · 基础', section: 'mood', sectionPath: ['mood'], tomlKey: 'update_base_prob', type: 'number', effectivePath: ['mood', 'updateBaseProb'], default: 0.1 },
  { key: 'mood.update_ramp_per_min', label: '更新概率 · 每分钟加', section: 'mood', sectionPath: ['mood'], tomlKey: 'update_ramp_per_min', type: 'number', effectivePath: ['mood', 'updateRampPerMin'], default: 0.1 },
  { key: 'mood.update_max_prob', label: '更新概率 · 上限', section: 'mood', sectionPath: ['mood'], tomlKey: 'update_max_prob', type: 'number', effectivePath: ['mood', 'updateMaxProb'], default: 0.5 },
  { key: 'mood.regress_after_seconds', label: '平复：安静多少秒', section: 'mood', sectionPath: ['mood'], tomlKey: 'regress_after_seconds', type: 'number', effectivePath: ['mood', 'regressAfterSeconds'], default: 200 },
  { key: 'mood.regress_max', label: '平复：最多几次', section: 'mood', sectionPath: ['mood'], tomlKey: 'regress_max', type: 'number', effectivePath: ['mood', 'regressMax'], default: 2 },
  { key: 'vision_gate.desc_system_detailed', label: '识图 · 详细描述系统段', section: 'vision_gate', sectionPath: ['vision_gate'], tomlKey: 'desc_system_detailed', type: 'multiline', effectivePath: ['vision', 'descSystemDetailed'], default: '' },
  { key: 'vision_gate.desc_system_brief', label: '识图 · 短描述系统段', section: 'vision_gate', sectionPath: ['vision_gate'], tomlKey: 'desc_system_brief', type: 'multiline', effectivePath: ['vision', 'descSystemBrief'], default: '' },
  // 表情包审核的 3,345 字提示词：早在 toml 里，这次终于上页了（改它要重载）。
  { key: 'sticker_gate.prompt', label: '审核提示词（3 千余字）', section: 'sticker_gate', sectionPath: ['sticker_gate'], tomlKey: 'prompt', type: 'multiline', effectivePath: ['sticker', 'prompt'], default: '' },
  { key: 'prompt.inturn_note', label: 'inTurn · 要不要接那三条', section: 'prompt', sectionPath: ['prompt'], tomlKey: 'inturn_note', type: 'multiline', effectivePath: ['prompt', 'inturnNote'], default: '' },
];

/**
 * 每一项补上 `file`（2026-10-30）。**这是唯一一处推导**，别的模块不要自己拼文件名。
 *
 * 为什么在导出时补、而不是每条手写：手写会漏（新加字段忘了写 ⇒ 写进主文件 ⇒
 * 加载器从分文件读 ⇒ "保存成功但没生效"，本项目最贵的那类坑）。
 */
export const CONFIG_FIELDS = Object.freeze(RAW_CONFIG_FIELDS.map((field) => ({
  ...field,
  file: String(field.file ?? fileKeyForSection(field.sectionPath) ?? 'main'),
})));

/** `key → field`。 */
const FIELD_BY_KEY = new Map(CONFIG_FIELDS.map((field) => [field.key, field]));

/**
 * 按 key 找字段。
 * @param {unknown} key
 * @returns {object|undefined}
 */
export function fieldByKey(key) {
  return FIELD_BY_KEY.get(String(key ?? '').trim());
}

/** 覆盖层支持的字段（人格五段）。顺序与提示词一致。 */
export const SCOPE_FIELD_KEYS = Object.freeze([
  'persona',
  'relations',
  'reply_style',
  'emotion_style',
  'interest',
  'chat_sense',
  'ai_flavor',
  'examples',
  'rules',
]);

/** 覆盖层字段定义（与全局那五条是同一份定义）。 */
export const SCOPE_FIELDS = Object.freeze(
  SCOPE_FIELD_KEYS.map((key) => FIELD_BY_KEY.get(key)).filter(Boolean),
);

/** 按路径取值（缺失 ⇒ `undefined`）。 */
export function valueAtPath(root, pathParts) {
  let node = root;
  for (const part of pathParts ?? []) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

/**
 * 文件里这一项的值（规范化）；**没写 / 类型不对 ⇒ `null`**。
 *
 * @param {object} field
 * @param {object} doc `parseToml` 的结果
 * @returns {unknown}
 */
export function fileFieldValue(field, doc) {
  const raw = readTomlKey(doc, field.sectionPath, field.tomlKey);
  if (raw === undefined || raw === null) return null;
  switch (field.type) {
    case 'array':
      // 数组里的非数字项按加载器口径丢掉（与 `[owner] admins` 一致）。
      return normalizeAdminList(raw);
    case 'bool':
      return typeof raw === 'boolean' ? raw : null;
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    case 'enum':
      return typeof raw === 'string' && Array.isArray(field.options) && field.options.includes(raw)
        ? raw
        : null;
    default:
      return typeof raw === 'string' ? raw : String(raw);
  }
}

/**
 * 进程里这一项生效的值。
 *
 * @param {object} field
 * @param {object} effective `apply()` 时组装好的生效值树
 * @returns {unknown}
 */
export function effectiveFieldValue(field, effective) {
  const value = valueAtPath(effective, field.effectivePath);
  return value === undefined ? field.default : value;
}

/**
 * 把界面提交的值收敛成该字段的类型。
 *
 * **不猜意思**：类型/取值不对就报错（而不是悄悄用默认值），因为"保存了但存成别的"
 * 比拒绝保存难查得多。
 *
 * @param {object} field
 * @param {unknown} raw
 * @returns {{ok: true, value: unknown} | {ok: false, error: string}}
 */
export function coerceFieldValue(field, raw) {
  switch (field.type) {
    case 'bool': {
      if (raw === true || raw === 'true') return { ok: true, value: true };
      if (raw === false || raw === 'false') return { ok: true, value: false };
      return { ok: false, error: `${field.label}：只能是 true / false` };
    }
    case 'number': {
      if (raw === null || raw === undefined) return { ok: false, error: `${field.label}：不能为空` };
      const text = typeof raw === 'number' ? raw : String(raw).trim();
      if (text === '') return { ok: false, error: `${field.label}：不能为空` };
      const n = typeof text === 'number' ? text : Number(text);
      if (!Number.isFinite(n)) return { ok: false, error: `${field.label}：不是合法数字` };
      return { ok: true, value: n };
    }
    case 'enum': {
      const text = String(raw ?? '').trim();
      if (!Array.isArray(field.options) || !field.options.includes(text)) {
        return { ok: false, error: `${field.label}：只能是 ${(field.options ?? []).join(' / ')}` };
      }
      return { ok: true, value: text };
    }
    case 'array': {
      // 界面按英文逗号填；数组也接受。非数字项**报错**（写进文件的东西要能读回来）。
      const items = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,，、;；]+/);
      const out = [];
      for (const item of items) {
        const text = String(item ?? '').trim();
        if (text === '') continue;
        if (!/^\d+$/.test(text)) return { ok: false, error: `${field.label}：不是合法 QQ 号（${text}）` };
        if (!out.includes(text)) out.push(text);
      }
      return { ok: true, value: out };
    }
    default: {
      // `null` / 未给 ⇒ 拒绝，**不当成空串**：界面上"没动这一项"很可能是它回传了
      // `fields[].value`（文件里没写时就是 `null`），把它当空串会**静默清掉**配置。
      // 真想清空，请显式传 `""`。
      if (raw === null || raw === undefined) return { ok: false, error: `${field.label}：不能为空` };
      return { ok: true, value: String(raw) };
    }
  }
}
