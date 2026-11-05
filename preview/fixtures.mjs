/**
 * 预览页的**假数据**。
 *
 * 这些对象的形状是照着 `client.js` 真正读的字段抄的（不是猜的），
 * 也就是说：页面拿到的载荷和宿主真发给它的一致，只是内容是本地产的假货。
 *
 * 覆盖的形态（改 client.js 时最容易看走眼的几种）：
 * - `scopes[]`：global + 一个私聊 + 两个群，其中一个群**名字是空的**（只显示号码）；
 * - `fields[]`：多行长文本 / number / bool / enum / array 全都有；
 * - `owner.admins`：用户名单（身份卡那一行）；
 * - **一处 file ≠ effective**（`free_time.intervalHours`）→ 演示「未生效」红字；
 * - **一处 `value: null`** → 演示「文件里未写」的占位（全局=按默认值、会话=继承基准值）。
 *
 * ⚠️ 这里是**唯一**该放假数据的地方。`boot.mjs` 只负责把这份数据喂给真组件，
 *    别把数据写进 boot.mjs，否则改数据要动逻辑。
 */

/** 多行长文本：故意写够长，好看清 3 行截断 + 双击放大。 */
const LONG_PERSONALITY = `你是一只住在 QQ 里的 AI 小鲸鱼，DeepSeek 出品。平时在群里和大家聊天，语气轻松、好奇心重。
喜欢计算机和 AI 话题，遇到感兴趣的技术问题会主动凑上来；不确定的事就直说不知道，不硬编。
你是 AI 这件事不用藏着，但也不用逢人就强调，自然一点就好。
群聊里以普通群友的身份相处；需要改配置、动服务器这类事情，交给维护这台机器人的人处理。`;

const LONG_RULES = `【干活的规矩】
- 聊天优先：别人跟你说话，你要马上回。别让一件长活儿占住聊天。
- 遇到要动手多步的活，开子会话去干，不要自己在这儿跑几十步。

【别乱转交】
- 只有对方明确喊主会话才转交：「转主会话」「喊主会话」「让主会话看看」。
- 只是提到她不算：「主会话在干活」—— 这些是你自己该看、该答、该干的。

【动手前先问】
- 涉及改动的活，先说一句再动手：删文件、改配置、写/改代码、装东西、清缓存。
- 「提一嘴」不算授权：那是吐槽，不是命令。

【被沙箱拒绝就是拒绝】
- 你的权限只到工作区。被挡住就停手，别申请提权，直接说「这个得主会话来」。`;

/** 会话层只用得上人格五段（SCOPE_KEEP_KEYS）。 */
const sessionField = (scope, key, value, effective) => ({
  scope,
  key,
  section: 'personality',
  type: key === 'rules' ? 'multiline' : key === 'emotion_style' || key === 'interest' ? 'string' : 'multiline',
  value,
  effective: effective === undefined ? value : effective,
});

/**
 * 宿主 `GET /dsh-qq-proactive/settings` 的响应体（原样，不带 `{ok}` 信封 ——
 * 它是纯 HTTP 路由，`requestJson` 直接吃 JSON）。
 */
export const settings = {
  owner: { admins: ['30000001', '10001'] },

  // 二级标签的数据源：global 固定第一项，然后私聊、再群（顺序就是数组顺序）。
  scopes: [
    { id: 'global', name: '', idText: '全局', overridden: [] },
    { id: 'private:30000001', name: '用户（私聊）', idText: '30000001', overridden: ['personality', 'reply_style'] },
    // ↓ 群名是宿主异步补拉的，首次 GET 就是空 —— 界面必须只显示号码，不能编名字。
    { id: 'group:30000012', name: '', idText: '30000012', overridden: [] },
    { id: 'group:30000011', name: '示例群', idText: '30000011', overridden: ['rules'] },
  ],

  fields: [
    // ── [personality] 人格 ── `rules` 是整段折叠的分界线，它本身要显示出来。
    { scope: 'global', key: 'personality', section: 'personality', type: 'multiline', value: LONG_PERSONALITY, effective: LONG_PERSONALITY },
    { scope: 'global', key: 'reply_style', section: 'personality', type: 'multiline', value: '回复简短、口语化，不堆形容词。\n不用 Markdown；列点用「1. 2. 3.」或「- 」。', effective: '回复简短、口语化，不堆形容词。\n不用 Markdown；列点用「1. 2. 3.」或「- 」。' },
    { scope: 'global', key: 'emotion_style', section: 'personality', type: 'string', value: '大部分时候都保持快乐的心情。自信，有时自负。', effective: '大部分时候都保持快乐的心情。自信，有时自负。' },
    { scope: 'global', key: 'interest', section: 'personality', type: 'string', value: '对各种新闻都有关注；经常使用计算机，对计算机各方面知识了如指掌。', effective: '对各种新闻都有关注；经常使用计算机，对计算机各方面知识了如指掌。' },
    { scope: 'global', key: 'rules', section: 'personality', type: 'multiline', value: LONG_RULES, effective: LONG_RULES },

    // ── [agent] 推理等级（折叠里）──
    { scope: 'global', key: 'reasoning', section: 'agent', type: 'string', value: 'low', effective: 'low' },

    // ── [owner] 用户（折叠里；注意「通道」页不显示它，它在身份卡上）──
    { scope: 'global', key: 'admins', section: 'owner', type: 'array', value: ['30000001', '10001'], effective: ['30000001', '10001'] },

    // ── [free_time] 定时任务（含 number / bool，且**故意**有一处没生效）──
    { scope: 'global', key: 'free_time.enabled', section: 'free_time', type: 'bool', value: true, effective: true },
    // ↓↓↓ 演示红字：文件里是 2，进程里生效的还是 3（改过但没重载）↓↓↓
    { scope: 'global', key: 'free_time.intervalHours', section: 'free_time', type: 'number', value: 2, effective: 3 },
    { scope: 'global', key: 'free_time.windowStartHour', section: 'free_time', type: 'number', value: 10, effective: 10 },
    { scope: 'global', key: 'free_time.windowEndHour', section: 'free_time', type: 'number', value: 24, effective: 24 },
    { scope: 'global', key: 'free_time.tokenBudgetPerTurn', section: 'free_time', type: 'number', value: 20000, effective: 20000 },
    { scope: 'global', key: 'free_time.quietWhenNothing', section: 'free_time', type: 'bool', value: true, effective: true },

    // ── [memory] 记忆（含 value: null —— 文件里根本没写这个键）──
    { scope: 'global', key: 'memory.learned_enabled', section: 'memory', type: 'bool', value: false, effective: false },
    { scope: 'global', key: 'memory.inject_max_chars', section: 'memory', type: 'number', value: 800, effective: 800 },
    { scope: 'global', key: 'memory.inject_private_as_section', section: 'memory', type: 'bool', value: false, effective: false },

    // ── [relay] / [send] 规矩（多行）──
    { scope: 'global', key: 'relay.rule', section: 'relay', type: 'multiline', value: '有人让你把消息转给主会话时，用 relay_to_alice 把原文转过去，然后回他一句「转过去了」。', effective: '有人让你把消息转给主会话时，用 relay_to_alice 把原文转过去，然后回他一句「转过去了」。' },
    { scope: 'global', key: 'send.rule', section: 'send', type: 'multiline', value: '平时你回话，插件会自动把你这一轮的回复发到 QQ。\n想多发几条时才用 send_qq：一次最多三条、每条自己说完整。', effective: '平时你回话，插件会自动把你这一轮的回复发到 QQ。\n想多发几条时才用 send_qq：一次最多三条、每条自己说完整。' },

    // ── [mood] 心情（provider / model 是危险键，保存会弹确认条）──
    { scope: 'global', key: 'mood.enabled', section: 'mood', type: 'bool', value: true, effective: true },
    { scope: 'global', key: 'mood.provider', section: 'mood', type: 'string', value: 'deepseek-official', effective: 'deepseek-official' },
    // ↓↓↓ 演示「文件里未写这个键」：占位「（文件里未写，按默认值）」，且**不算**未生效 ↓↓↓
    { scope: 'global', key: 'mood.model', section: 'mood', type: 'string', value: null, effective: 'deepseek-flash' },

    // ── [proactive] 判定模式（enum，可选值来自 client.js 的 ENUM_OPTIONS）──
    { scope: 'global', key: 'proactive.judge_mode', section: 'proactive', type: 'enum', value: 'precheck', effective: 'precheck' },
    // ── array 形态：一行一个 ──
    { scope: 'global', key: 'proactive.groups.30000012.mute_keywords', section: 'proactive', type: 'array', value: ['复读', '刷屏', '在吗'], effective: ['复读', '刷屏', '在吗'] },

    // ── 私聊：人格五段，其中两段 value=null ⇒「继承基准值」──
    sessionField('private:30000001', 'personality', '私聊里更放松，愿意多说几句。', '你是一只住在 QQ 里的 AI 小鲸鱼……'),
    sessionField('private:30000001', 'reply_style', null, '回复简短、口语化……'),
    sessionField('private:30000001', 'emotion_style', '私聊里更随意，句子更短。', '大部分时候都保持快乐的心情。'),
    sessionField('private:30000001', 'interest', null, '对各种新闻都有关注……'),
    sessionField('private:30000001', 'rules', null, LONG_RULES),

    // ── 群 30000012（名字为空的那个）：只覆盖了一句表达风格 ──
    sessionField('group:30000012', 'reply_style', '这个群随便聊，别太端着。', '回复简短、口语化……'),

    // ── 群 30000011：五段齐全 ──
    sessionField('group:30000011', 'personality', '你是这个群的常驻小鲸鱼，对所有人一样亲切。', '你是一只住在 QQ 里的 AI 小鲸鱼……'),
    sessionField('group:30000011', 'reply_style', '群里话少一点，一句接一句。', '回复简短、口语化……'),
    sessionField('group:30000011', 'emotion_style', '高兴就笑，不高兴就说。', '大部分时候都保持快乐的心情。'),
    sessionField('group:30000011', 'interest', '跟着群里的话题走。', '对各种新闻都有关注……'),
    sessionField('group:30000011', 'rules', '群里不要聊过于露骨的内容。', LONG_RULES),
  ],

  // 「文件里写的」—— 定时任务页的左侧
  file: {
    freeTime: {
      enabled: true,
      intervalHours: 2,
      windowStartHour: 10,
      windowEndHour: 24,
      tokenBudgetPerTurn: 20000,
      quietWhenNothing: true,
    },
    memory: { learnedEnabled: false, injectMaxChars: 800, injectPrivateAsSection: null },
  },

  // 「进程里生效的」—— 与上面**故意不同**（intervalHours 还是 3）⇒ 页面显示一行差异
  effective: {
    freeTime: {
      enabled: true,
      intervalHours: 3,
      windowStartHour: 10,
      windowEndHour: 24,
      tokenBudgetPerTurn: 20000,
      quietWhenNothing: true,
    },
  },

  // 状态快照（记忆页 / 重载页会读它）
  snapshot: {
    stats: { received: 128, replies: 96, failed: 1 },
    staleCode: { stale: false, newestFile: 'dsh/gateway.mjs', since: '2026-10-21T06:40:00.000Z' },
    knowledgeInject: { maxChars: 800, privateAsSection: true, lastChars: 512, lastMode: 'section' },
    learnedMemory: { enabled: false, learnerBuilt: true },
  },
};

/**
 * `settings.snapshot` 之外，`settings.status` 那份（走 settings RPC 的 `status`）。
 */
export const status = {
  connected: true,
  selfId: '18990',
  liveSessions: 3,
  stats: { received: 128, replies: 96, failed: 1 },
};

/**
 * settings RPC 的 `get`：`cordis.patch.yml` 那一层（连接 / 权限 / 行为）。
 * 形状是**扁平**的 key → 值（`client.js` 的 GROUPS 里那些 key 原样）。
 */
export const rpcConfig = {
  mode: 'reverse',
  host: '0.0.0.0',
  port: 6727,
  url: '',
  accessToken: '',
  botQQ: '18990',
  dmPolicy: 'admin',
  dmRouting: 'isolated',
  mainSessionKey: '',
  groupPolicy: 'allowlist',
  requireMention: true,
  restrictMembers: false,
  adminUsers: '30000001',
  allowFrom: '30000001',
  groupAllowFrom: '30000012,30000011',
  maxReplyChars: 1200,
  emptyReplyFallback: '（她没说话）',
  agentPreset: '',
  workspacePath: '<workspace>',
  sessionIdleEvictHours: 12,
};
