/**
 * 「说不说」的**裁量模式**（画布上的三种）—— 模式 2 `precheck` 的实现。
 *
 * ```
 * 模式 1  heuristic  分数 ≥ 阈值 ⇒ 直接说                        ← 默认，零模型调用
 * 模式 2  precheck   过阈值后【先问一次轻量模型】⇒ 它说"该"才说
 * 模式 3  inTurn     过阈值后照常进 agent，总分当"倾向"塞进提示词，由它自己决定
 * ```
 *
 * ## 三种模式共用同一条闸门和打分（硬要求）
 *
 * 本模块**不碰闸门、也没复制一份打分**：
 *
 * - **闸门**（准入 / 预热 / 配额 / 冷却 / 间隔）仍然只有 `engine.mjs` 的 `#gate` 一处；
 * - **打分**仍然只有 `heuristic-gauge.mjs` 的 `judge()` 一处（那个文件一行没动）；
 * - 本模块只在**「过了闸门、且打分已经算出总分」之后**插一层裁量。
 *
 * ```
 * engine.#gate ──放行──▶ heuristic-gauge.judge ──▶ 【模式 1】直接按 speak
 *                                              └─▶ 【模式 2】precheck 再问一次
 *                                              └─▶ 【模式 3】照常进 agent（提示词带倾向）
 * ```
 *
 * ## 模式 2 的硬约束：这一次调用是【一次性的、没有上下文】
 *
 * 用户 2026-10-13 的原话：
 *
 * > 「模式2和模式3之间除了模型不同外，还有一个就是**模式2调用的这个轻量模型是一次性的，
 * >   没有上下文全靠这一轮塞进去的内容**」
 *
 * ⇒ **没有多轮、没有会话历史**。需要它知道的东西（**转录 / 当前这条消息 / 总分与分项**）
 * 必须**全部塞进这一次请求的提示词里** —— 少一样它就无从判断，而它也不可能"再问一次"。
 * 提示词的拼装见 {@link buildPrecheckPrompt}（逐项列了"为什么必须有"）。
 *
 * ## 失败降级：**退回"该说"**
 *
 * 轻量模型调用**失败 / 超时 / 输出无法解析** ⇒ 一律当成「该说」，
 * 也就是**退回模式 1 的行为**。理由（三条，按重要性排）：
 *
 * 1. **失败模式不对称**：小模型挂了 ⇒ 降级成"不说"的话是**整条链哑掉** ——
 *    小鲸鱼在群里从此一声不吭，而**日志里每一层都"正常"**（判定跑了、分数够、
 *    就是不说）。那正是本项目最贵的一类坑（"不报错、计数正常、只是什么都没发生"，
 *    见 `AGENTS.md`）。反过来降级成"该说"最多是多说一句 —— 可观测、可撤回、不致命。
 * 2. **下面的链路本来就有兜底**：闸门有 `maxPerHour` / `minIntervalMs` / 冷却，
 *    进 agent 之后还有 `inTurn` 那条"空回复是合法的"出口（`gateway.runTurn`）⇒
 *    "多说一句"并不是无界的。
 * 3. **precheck 是省钱措施，不是安全措施**。它的收益是"省掉一次白跑的整轮"，
 *    代价错了只会少省一次钱；把它当成必须成立的"闸"会把省钱工具变成故障点。
 *
 * ⚠️ 与 `heuristic-gauge.judge()` 的**语义差别**：那边 `null` = 压根没打分（必须保持
 * `null` 传下去）；这边"没打分"**根本不会走到 precheck**（调用点先判 `decision?.speak === true`）。
 *
 * @module qq-gugu/judge-mode
 */

import { createJudgeStats } from './judge-stats.mjs';

/** 模式 1 · 分数 ≥ 阈值就说（默认；零模型调用）。 */
export const JUDGE_MODE_HEURISTIC = 'heuristic';
/** 模式 2 · 过阈值后先问一次轻量模型。 */
export const JUDGE_MODE_PRECHECK = 'precheck';
/** 模式 3 · 不做预判，总分当倾向塞进提示词。 */
export const JUDGE_MODE_IN_TURN = 'inTurn';

/** 三种合法模式（顺序 = 画布上的顺序）。 */
export const JUDGE_MODES = Object.freeze([
  JUDGE_MODE_HEURISTIC,
  JUDGE_MODE_PRECHECK,
  JUDGE_MODE_IN_TURN,
]);

/**
 * 配置值归一：**不认识的写法一律回默认 `heuristic`**。
 *
 * 为什么不抛异常：这个键住在用户手改的 `toml` 里，`judge_mode` 写错一个字母
 * （`preCheck` / `in-turn`）不该让小鲸鱼整个起不来。但**也不能悄悄换一种行为** ——
 * 回默认 = 和"没配"逐字一致，属于 fail-safe。
 *
 * ⚠️ 大小写与分隔符宽容（`inTurn` / `inturn` / `in_turn` / `in-turn` 等价）：
 * 键名是 `snake_case`（`judge_mode`），值却是驼峰（`inTurn`），
 * 这种混搭最容易写岔，宽容处理比报错更省事。
 *
 * @param {unknown} value
 * @returns {'heuristic'|'precheck'|'inTurn'}
 */
export function normalizeJudgeMode(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[_-]/g, '');
  if (raw === 'precheck') return JUDGE_MODE_PRECHECK;
  if (raw === 'inturn') return JUDGE_MODE_IN_TURN;
  return JUDGE_MODE_HEURISTIC;
}

/**
 * `precheck_model` 的写法 —— **provider 可以省略**。
 *
 * 画布的键名是 `precheck_model`（不是 `precheck_provider`），而账本草案的注释写着
 * 「留空 = 跟随 provider/model」⇒ 这个值**本身描述的是模型**，provider 缺省沿用它。
 * 两种写法都收：
 *
 * ```
 * precheck_model = "deepseek-flash"                      # provider 沿用主配置
 * precheck_model = "local-llamacpp/qwen3.5-4b-q4km"      # 显式 provider/model
 * ```
 *
 * **不能只认"带斜杠"的写法**：模型 id 自己就常带斜杠（`stepfun/step-5-preview`、
 * `kimi/kimi-k2.8-preview`、`ZHIPU/GLM-5.3-FlashX` —— 见 `cordis.patch.yml`）。
 * 所以判据不是"有没有斜杠"，而是"**前半段是不是一个已注册的 provider**"，
 * 由调用方拿 `knownProviders` 判（缺省 `''` = 不判，按裸模型名处理）。
 *
 * @param {unknown} value
 * @param {object} [options]
 * @param {string[]|Set<string>} [options.knownProviders] 已注册的 provider 名单
 * @param {string} [options.defaultProvider] 省略 provider 时用哪个
 * @returns {{provider: string, model: string, raw: string}} `model === ''` = **没配**
 */
export function resolvePrecheckModel(value, { knownProviders = null, defaultProvider = '' } = {}) {
  const raw = String(value ?? '').trim();
  if (raw === '') return { provider: '', model: '', raw: '' };
  const slash = raw.indexOf('/');
  if (slash > 0) {
    const head = raw.slice(0, slash);
    const tail = raw.slice(slash + 1);
    if (tail !== '' && isKnown(head, knownProviders)) {
      return { provider: head, model: tail, raw };
    }
  }
  return { provider: String(defaultProvider ?? ''), model: raw, raw };
}

/** `knownProviders` 允许是数组 / Set / 空（空 = 不判）。 */
function isKnown(provider, knownProviders) {
  if (knownProviders === null || knownProviders === undefined) return false;
  if (typeof knownProviders === 'string') return knownProviders === provider;
  if (typeof knownProviders.has === 'function') return knownProviders.has(provider);
  if (Array.isArray(knownProviders)) return knownProviders.includes(provider);
  return false;
}

/**
 * precheck 的判定结果（结构化，便于落进 journal 又不用记正文）。
 *
 * @typedef {object} PrecheckOutcome
 * @property {boolean} speak 最终是否"该说"（**任何失败都算 true**）
 * @property {'speak'|'decline'|'wait'} verdict 它到底答了什么（2026-11-01 加第三态「等」）
 * @property {'reply'|'decline'|'wait'|'unparsed'|'timeout'|'error'|'no-model'|'busy'} source 这一次是怎么定的
 * @property {number} ms 这次调用花了多久（毫秒）
 * @property {number} chars 它答了几个字符（排查"模型没按格式答"用）
 * @property {number} promptChars 那次**一次性提示词**有多少字符（= 上下文确实塞进去了）
 * @property {string} provider 实际用的 provider
 * @property {string} model 实际用的 model
 * @property {string} raw 它答的原文（截断到 40 字）
 * @property {string} answer 它答的原文**全文**（截到 {@link PRECHECK_ANSWER_MAX} 字）。
 *   2026-11-06 加：判定日志（`gauge-log.mjs`）要能离线复盘"它到底答了什么"，
 *   而 `raw` 只留 40 字。⚠️ **纯加法** —— 判定分支与采样参数一个字节都没动。
 */

/**
 * 模式 2 的系统提示。
 *
 * ⚠️ 刻意**从简**：这个调用没有任何上下文、也不该花时间解释 —— 该带的背景
 * 全在用户消息里（{@link buildPrecheckPrompt}）。**回答只允许一个字**，
 * 因为输出越短越省 token（`maxTokens` 压到 4）。
 *
 * 必须**明说"没人保证它必须说话"**：否则小模型会默认"被问到就是要说"，
 * 那 precheck 就退化成恒真、白花一次调用。
 */
const PRECHECK_SYSTEM = [
  '你是 QQ 群聊机器人「小鲸鱼」的预检器。',
  '有人问你要不要接一句话，你要判断：现在回一句是否自然、是否受欢迎。',
  '',
  '判「不该」的典型情况：',
  '- 那只是群里两个人互相说话，跟小鲸鱼没关系；',
  '- 只是表情包 / 哈哈哈 / 复读 / 打招呼 / 道别；',
  '- 话题已经结束，或者她插一句会打断别人；',
  '- 她最近已经说过了，再来一句就是刷屏；',
  '- 对方话还没说完（这条以逗号、破折号、省略号结尾，或者明显是半句）—— **等他说完再接**；',
  '- 接了也只是"嗯""确实"这种废话，或者得硬找角度才接得上 —— 不接。',
  '',
  '判「该」的典型情况：',
  '- 句子里有能在群聊里接上的内容（在问事、在聊技术、在分享、在找人说）；',
  '- 有人在跟小鲸鱼说话，或者话题明显是冲她来的；',
  '- 群里正聊到她的兴趣（计算机 / 技术 / 新闻）。',
  '',
  '只输出一个词：该 / 不该 / 等。不要标点、不要解释、不要多余的字。',
  '「等」= 对方话还没说完，现在接会接错，等他的下一条。',
].join('\n');

/**
 * 拼**那一次性的** precheck 提示词。
 *
 * ## 这个函数的唯一职责：把"它必须知道的东西"全塞进一处
 *
 * 因为那个调用**没有多轮、没有历史**（见文件头），这里少一样它就无从判断。
 * 逐项与理由：
 *
 * | 塞进去的东西 | 为什么少不得 |
 * |---|---|
 * | **转录**（`transcript`） | 没有它，它只能看见孤零零一句「这个怎么办」——不知道在说哪个 |
 * | **当前这条消息**（`message`） | 转录里可能已经有它（引擎先 push 再过闸门），所以**单独再给一份并标出来**，否则它分不清"哪句是刚发生的" |
 * | **总分 + 阈值**（`score` / `threshold`） | 那是这一轮**唯一**的量化信号；"离阈值多远"直接决定这句该不该接 |
 * | **分项**（`detail` 里那几项） | 总分相同、来源可能完全相反 —— 靠"存在感"堆上来的分（她刚说了几句）与靠"技术词 + 问句"拿到的分，该不该接的答案不一样 |
 * | **会话形态 + 是否被点名**（`kind` / `addressed`） | 私聊 vs 群聊的礼貌完全不同；被点名时**根本不会走 precheck**（闸门短路），写出来是为了让它知道"这不是别人叫她" |
 * | **小鲸鱼此刻的心情**（`mood`，2026-10-15 加） | 同一句话，心情好与不好"该不该接"的答案可能相反。**极短的一行**（跟着 `chatId` 走），不做任何阈值数学 —— 用户原话：「走轻量的话直接塞进去让他看着决定呗」 |
 *
 * ⚠️ **只列 `detail` 里最该看的几项**，不是把 `detail` 整坨倒进去：
 * 那边有 20 来个字段，全塞会把它淹掉，而它对"该不该接"没有增量。
 *
 * @param {object} input
 * @param {string} [input.transcript] 转录正文（引擎渲染好的，带时间戳）
 * @param {string} [input.chatId]
 * @param {'group'|'private'|string} [input.kind]
 * @param {string} [input.userId]
 * @param {string} [input.mood] **小鲸鱼此刻的心情**（空串 = 没有 ⇒ 提示词里不加这一行）
 * @param {boolean} [input.addressed] 是否被点名（正常情况下恒 false —— 被点名不走这里）
 * @param {number} [input.score] 总分
 * @param {number} [input.threshold]
 * @param {object} [input.detail] 打分的分项
 * @param {number} [input.now] 时间戳（只用于给当前这条标个时间）
 * @returns {string}
 */
export function buildPrecheckPrompt({
  transcript = '',
  chatId = '',
  kind = 'group',
  userId = '',
  messageText = '',
  mood = '',
  addressed = false,
  score = null,
  threshold = null,
  detail = null,
  now = null,
} = {}) {
  const isPrivate = String(kind) === 'private';
  const lines = [];

  lines.push('【这是一次性的预检，你没有上下文、也不会再被追问】');
  lines.push(
    `【会话】${chatId === '' ? '(未知)' : chatId}（${isPrivate ? '私聊' : '群聊'}）`
    + `　【这条消息的发送者】${userId === '' ? '(未知)' : userId}`,
  );
  // 心情（2026-10-15 接线）：**就一行**，而且**只在有心情时才有**。
  // 不做任何阈值/规则折算 —— 它是"背景"，由这次轻量调用自己权衡该不该接。
  // 空串 ⇒ 这一行不加 ⇒ 提示词与接线前**逐字节相同**。
  const moodText = String(mood ?? '').trim();
  if (moodText !== '') lines.push(`【小鲸鱼此刻的心情】${moodText}`);
  lines.push('');

  lines.push('【最近聊天（转录，旧 → 新）】');
  const body = String(transcript ?? '').trim();
  lines.push(body === '' ? '(转录为空 —— 只看到下面这一条)' : body);
  lines.push('');

  // 当前这条：转录里**可能已经包含它**（引擎先 push 再过闸门），所以单独给一份。
  lines.push('【刚发生的这条消息 —— 就是它触发了本次预检】');
  lines.push(`[${formatClock(now)} ${String(userId === '' ? '(未知)' : userId)}] ${String(messageText ?? '').trim() || '(空正文)'}`);
  lines.push('');

  lines.push('【启发式打分给它的结论】');
  lines.push(
    `总分 ${numText(score)}　阈值 ${numText(threshold)}`
    + `　⇒ 分数口径：**过了阈值才会走到你这里**（没过阈值的消息根本不会问你）`,
  );
  if (isPrivate === false && addressed === true) {
    lines.push('⚠️ 这条是**被点名**的（@ 小鲸鱼 / 喊名字）—— 被点名本来就不该被拦，正常不会走到这里。');
  }
  const items = detailItems(detail);
  if (items.length > 0) {
    lines.push(`分项：${items.join(' · ')}`);
  }
  lines.push('');
  lines.push('【你的回答】该不该让小鲸鱼接这一句？只回「该」或「不该」。');
  return lines.join('\n');
}

/**
 * 从 `detail` 里挑出"对判断该不该接有用"的几项。
 */
function detailItems(detail) {
  if (detail === null || typeof detail !== 'object') return [];
  /** 顺序 = 重要性；`label` 是给人看的名字，`sign` 决定正负号。 */
  const wanted = [
    ['relevance', '与小鲸鱼的相关度', '+'],
    ['content', '内容分', ''],
    ['presence', '她最近发言的存在感', '+'],
    ['pressure', '群里攒的话', ''],
    ['repetition', '复读', ''],
    ['messages', '窗口条数', ''],
    ['selfCount', '窗口里她说了几条', ''],
    ['questions', '问句数', ''],
    ['techHits', '技术词命中', ''],
    ['shortBatch', '整窗都是短反应', ''],
  ];
  const out = [];
  for (const [key, label, sign] of wanted) {
    const value = detail[key];
    if (typeof value === 'boolean') {
      out.push(`${label}=${value ? '是' : '否'}`);
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.push(`${label}=${sign}${value}`);
    }
  }
  return out;
}

/** 数字 → 文本（null/NaN → `?`，别让提示词里出现 `NaN`）。 */
function numText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '?';
}

/** 时间戳 → `HH:MM`（本地时区；拿不到就是 `--:--`）。 */
function formatClock(at) {
  const t = Number(at);
  if (!Number.isFinite(t)) return '--:--';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 解析轻量模型的回答。**先找"等"、再找"不该"、最后找"该"** —— 顺序不能反：
 * 「不该」里含「该」，`includes('该')` 会把否定读成肯定（这是最容易写错的一处）。
 *
 * 2026-11-01 加第三态「等」：对方话还没说完 ⇒ 这一条先不接，等下一条进来再看。
 *
 * @param {unknown} raw
 * @returns {'decline'|'speak'|'wait'|'unparsed'}
 */
export function parsePrecheckAnswer(raw) {
  const t = String(raw ?? '').trim();
  if (t === '') return 'unparsed';
  // 第三态（2026-11-01）：**锚定开头**，别让「不等」里的"等"把拒绝读成等待。
  if (/^(等|稍等|等等|没说完|还没说完|等他|等她)/.test(t)) return 'wait';
  // 英文兜底（有些路由会把中文答成 yes/no）。
  if (/^\s*(no|n)\b/i.test(t)) return 'decline';
  if (/^\s*(yes|y)\b/i.test(t)) return 'speak';
  if (/不\s*该|不用|不必|不要说|别接|不要接|沉默|no\b/i.test(t)) return 'decline';
  if (/该|可以|应该|说吧|接吧|yes\b/i.test(t)) return 'speak';
  return 'unparsed';
}

/** 默认超时（毫秒）。轻量模型回答两个字，8 秒足够；超了就降级成"该说"。 */
export const DEFAULT_PRECHECK_TIMEOUT_MS = 8000;
/** 输出预算（token）。两个字足够，越大越容易被它写出一段解释。 */
export const PRECHECK_MAX_TOKENS = 4;
/**
 * 预检要不要开思考（2026-11-06 起 `'low'`）。
 *
 * 原来是 `'off'`：分类任务不做推理，省时省钱。代价是它**只能看一眼就给一个词**，
 * 判「不该」判错了也没法复盘（连它当时答的原文都不留）。改成 `'off'` 即可退回原样。
 */
export const PRECHECK_REASONING_EFFORT = 'low';
/** 开了思考时的输出预算：推理 token 也从这里扣，4 个连一个字都写不完。 */
export const PRECHECK_MAX_TOKENS_WITH_REASONING = 96;
/** 失败后重试几次（**只重试失败**，不重试"不该"）。 */
export const PRECHECK_RETRY = 1;
/**
 * `outcome.answer`（判官答的**全文**）的保留上限（字符）。
 *
 * ## 为什么要有这个字段（2026-11-06，为"判官/启发式决策日志"加的）
 *
 * `outcome.raw` 的口径是**截到 40 字**（它只服务日志里"它答歪了长什么样"这一眼，
 * 长了对日志没增量）。可判定日志（`gauge-log.mjs`）要的是**能离线复盘的原文** ——
 * 开了思考之后（`PRECHECK_REASONING_EFFORT = 'low'`）它可能多吐几个字，
 * 40 字会把最要紧的部分切掉。
 *
 * ⇒ 两个字段分工：`raw` 保持 40 字（老口径，谁都别动），`answer` 留全文。
 * **纯加法**：判定分支、`speak` 取值、采样参数一个字节都没变。
 */
export const PRECHECK_ANSWER_MAX = 1000;

/**
 * 造一个模式 2 预检器。
 *
 * ⚠️ **每个实例最多同时跑一个调用**（`busy` 时直接回"该说"）：这条调用在消息热路径上，
 * 而轻量模型可能慢（本地 4B 尤其）。并发堆起来会让"预检"变成"排队"——
 * 那还不如放它进 agent。**降级成"该说"是安全的那一侧**（见文件头）。
 *
 * @param {object} options
 * @param {(opts: object) => AsyncIterable<any>} options.stream `ctx.llm.stream`
 * @param {string} options.provider
 * @param {string} options.model
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retry] 失败重试次数（默认 {@link PRECHECK_RETRY}）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {(chatId: string) => string} [options.moodFor] **当前心情的取值器**（2026-10-15 加）。
 *   入参是 **chatId**（`group:30000013`），返回一句中文心情；取不到就返回空串。
 *   `undefined` / 非函数 = 没有心情 ⇒ 提示词**一个字符都不变**（与接线前逐字节相同）。
 *   由 `index.mjs` 用 `moodTextFor(mood, chatId)` 装配。
 * @returns {{enabled: boolean, check: (input: object) => Promise<PrecheckOutcome>, describe: () => object, stats: () => object}}
 */
export function createPrecheck({
  stream,
  provider = '',
  model = '',
  timeoutMs = DEFAULT_PRECHECK_TIMEOUT_MS,
  retry = PRECHECK_RETRY,
  log = () => {},
  moodFor = null,
  /** 系统段（2026-10-30 可配）：空 / 非字符串 ⇒ 用内置 {@link PRECHECK_SYSTEM}。 */
  systemPrompt = '',
} = {}) {
  const systemText = typeof systemPrompt === 'string' && systemPrompt.trim() !== ''
    ? systemPrompt
    : PRECHECK_SYSTEM;
  // 「没配 provider/model」那条降级路径要靠它（原样保留，别在改措辞时弄丢）。
  const hasModel = String(model ?? '') !== '' && String(provider ?? '') !== '';
  const canStream = typeof stream === 'function';
  /** 只认函数：传了别的东西一律当"没有心情"（免得热路径上 `moodFor is not a function`）。 */
  const moodResolver = typeof moodFor === 'function' ? moodFor : null;
  let busy = false;
  /** 「没配模型」那条 warn 只打一次（否则每条消息都刷屏）。 */
  let warnedNoModel = false;
  /**
   * **判定器计数器**（2026-10-28 加）。
   *
   * 挂在 `check()` 的出口上（那里才知道 `source`），而不是在网关里 ——
   * 理由：`check()` 是**唯一**的判定入口，计数器跟着它走就不会和真正的调用漂移
   * （网关只在一个地方调它，但"只有一个地方"是今天的事实，不是保证）。
   *
   * ⚠️ 它**只数数**：不改 `outcome`、不改降级策略、不改重试 —— 见 `judge-stats.mjs`。
   */
  const stats = createJudgeStats();

  /** 一次调用（含超时）。返回 `{raw, timedOut}`，**不抛**。 */
  async function callOnce(prompt) {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // 让适配器能提前收摊；不支持 `signal` 的路由靠下面那个 race 兜底。
      try {
        ac.abort();
      } catch {
        /* 某些实现不接受 abort，忽略 */
      }
    }, timeoutMs);
    let collected = '';
    const consume = (async () => {
      const chunks = stream({
        provider,
        model,
        // 分类任务不开思考 —— 也顺手省钱、省时间（与 `relay-judge` 同一条）。
        // 2026-11-06 起改由 {@link PRECHECK_REASONING_EFFORT} 决定，默认 `'low'`。
        reasoningEffort: PRECHECK_REASONING_EFFORT,
        system: systemText,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        // 预算必须跟着思考走：推理 token 和正文共用一个额度，
        // 开着思考还只给 4 个 ⇒ 它把额度花在推理上，正文一个字都出不来。
        maxTokens: PRECHECK_REASONING_EFFORT === 'off'
          ? PRECHECK_MAX_TOKENS
          : PRECHECK_MAX_TOKENS_WITH_REASONING,
        signal: ac.signal,
      });
      for await (const chunk of chunks) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') collected += chunk.text;
      }
    })();
    const timerRace = new Promise((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs + 50);
    });
    const winner = await Promise.race([
      consume.then(() => 'done').catch((error) => error),
      timerRace,
    ]).finally(() => clearTimeout(timer));
    if (winner === 'timeout' || timedOut) return { raw: collected, timedOut: true, error: null };
    if (winner instanceof Error) return { raw: collected, timedOut: false, error: winner };
    return { raw: collected, timedOut: false, error: null };
  }

  /** 本轮调用实际用哪条 provider/model（跟着配置走）。 */
  function target() {
    return { provider: String(provider ?? ''), model: String(model ?? '') };
  }

  const disabled = () => ({
    speak: true,
    verdict: 'speak',
    source: 'no-model',
    ms: 0,
    chars: 0,
    promptChars: 0,
    ...target(),
    raw: '',
    answer: '',
  });

  /**
   * 问一次（**内部实现，不带计数**；外面那层 `check` 负责记账）。
   * @param {object} input 见 {@link buildPrecheckPrompt}（外加 `transcript` / `messageText`）
   * @returns {Promise<PrecheckOutcome>}
   */
  async function runCheck(input = {}) {
    const started = Date.now();
    // 心情（2026-10-15 接线）：按 **chatId** 取当前心情，塞进那一次性的提示词。
    // ⚠️ 三条：① **绝不抛**（它在消息热路径上）；② 取不到就是空串 ⇒ 提示词不变；
    // ③ 一次调用一份 —— 它没有上下文，全靠这一次塞进去。
    let mood = '';
    if (moodResolver !== null) {
      try {
        mood = String(moodResolver(String(input?.chatId ?? '')) ?? '').trim();
      } catch (error) {
        log('debug', `precheck 读取心情失败（按没有心情处理）: ${error instanceof Error ? error.message : String(error)}`, target());
        mood = '';
      }
    }
    const prompt = buildPrecheckPrompt({ ...input, mood });
    const promptChars = prompt.length;

    if (!hasModel || !canStream) {
      // 没配模型 / 没有 llm 服务 ⇒ **降级成"该说"**（退回模式 1），并留一条 warn。
      // 刻意不静默：这是"配置写了却不生效"那一类里最该被看见的一种。
      // ⚠️ 只打一次：它在消息热路径上，每条都打会把日志刷满、真问题反而被埋掉。
      if (!warnedNoModel) {
        warnedNoModel = true;
        log('warn', 'judge_mode=precheck 但没有可用的 precheck_model（或没有 llm 服务）⇒ 降级成「该说」（等价模式 1）', {
          ...target(),
          hasStream: canStream,
        });
      }
      return { ...disabled(), ms: Date.now() - started, promptChars };
    }

    if (busy) {
      log('debug', 'precheck 上一个调用还没回来 ⇒ 这一条直接降级成「该说」', target());
      return {
        speak: true, verdict: 'speak', source: 'busy',
        ms: 0, chars: 0, promptChars, ...target(), raw: '',
        // 没问成，没有原文可留（answer 与 raw 同源，见 PRECHECK_ANSWER_MAX）。
        answer: '',
      };
    }

    busy = true;
    try {
      let lastError = null;
      let lastChars = 0;
      for (let attempt = 0; attempt <= Math.max(0, Number(retry) || 0); attempt += 1) {
        const { raw, timedOut, error } = await callOnce(prompt);
        lastChars = String(raw ?? '').trim().length;
        if (timedOut) {
          log('warn', 'precheck 超时 ⇒ 降级成「该说」（退回模式 1）', { ...target(), timeoutMs, promptChars });
          return {
            speak: true, verdict: 'speak', source: 'timeout',
            ms: Date.now() - started, chars: lastChars, promptChars, ...target(), raw: '',
            // 超时**保留答到一半的原文**：那正是「它到底说了什么才超时」的证据。
            answer: String(raw ?? '').trim().slice(0, PRECHECK_ANSWER_MAX),
          };
        }
        if (error !== null) {
          lastError = error;
          log('warn', 'precheck 调用失败', {
            ...target(),
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        const verdict = parsePrecheckAnswer(raw);
        if (verdict === 'wait') {
          // 第三态（2026-11-01）：对方话还没说完 ⇒ 这一条不接，让网关挂个标记，
          // 下一条消息跳过阈值再问一次。**不是失败**，所以不进 `unparsed` 那条降级。
          return {
            speak: false,
            verdict: 'wait',
            source: 'wait',
            ms: Date.now() - started,
            chars: lastChars,
            promptChars,
            ...target(),
            raw: String(raw ?? '').trim().slice(0, 40),
            // 全文（raw 只留 40 字，判定日志要能复盘的原文）。
            answer: String(raw ?? '').trim().slice(0, PRECHECK_ANSWER_MAX),
          };
        }
        if (verdict === 'unparsed') {
          // ⚠️ 空回答 / 乱码**不重试**能带来什么：多试一次也无非是同一句话。
          // 只有"抛错"才值得重试（那多半是瞬时的），所以这里直接判。
          log('debug', 'precheck 回答无法解析 ⇒ 降级成「该说」', {
            ...target(),
            answer: String(raw ?? '').slice(0, 40),
          });
          return {
            speak: true, verdict: 'speak', source: 'unparsed',
            ms: Date.now() - started, chars: lastChars, promptChars, ...target(),
            raw: String(raw ?? '').slice(0, 40),
            answer: String(raw ?? '').trim().slice(0, PRECHECK_ANSWER_MAX),
          };
        }
        return {
          speak: verdict === 'speak',
          verdict,
          source: verdict === 'speak' ? 'reply' : 'decline',
          ms: Date.now() - started,
          chars: lastChars,
          promptChars,
          ...target(),
          raw: String(raw ?? '').trim().slice(0, 40),
          answer: String(raw ?? '').trim().slice(0, PRECHECK_ANSWER_MAX),
        };
      }
      log('warn', 'precheck 重试后仍然失败 ⇒ 降级成「该说」（退回模式 1）', {
        ...target(),
        error: lastError === null ? 'unknown' : (lastError instanceof Error ? lastError.message : String(lastError)),
      });
      return {
        speak: true, verdict: 'speak', source: 'error',
        ms: Date.now() - started, chars: lastChars, promptChars, ...target(), raw: '',
        answer: '',
      };
    } catch (error) {
      // 兜底：任何没预料到的异常也走"该说"这一侧，绝不把消息处理链路炸掉。
      log('warn', 'precheck 未预期异常 ⇒ 降级成「该说」', {
        ...target(),
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        speak: true, verdict: 'speak', source: 'error',
        ms: Date.now() - started, chars: 0, promptChars, ...target(), raw: '',
        answer: '',
      };
    } finally {
      busy = false;
    }
  }

  /**
   * 问一次「要不要说」——**带计数**（这是网关唯一的入口）。
   *
   * ## 为什么计数包在这一层，而不是塞进 `runCheck` 的每个 return
   *
   * `runCheck` 有**六七个** return（没配模型 / busy / 超时 / 报错 / 答歪 / 正常 / 兜底）。
   * 每个出口各记一笔的话，以后加一个出口就漏一笔，而且漏了**没人看得出来**
   * （数会"看起来正常"）。包在最外层只有一处，出口怎么变都还是问一次记一次。
   *
   * ## ⚠️ 行为与计数前**逐字节相同**
   *
   * - 返回值是 `runCheck` 的那个对象**原样**（同一个引用，不复制、不改字段）；
   * - `runCheck` 抛异常时**照样往上抛**（这里不吞 —— 吞异常等于改错误处理，
   *   那是判定逻辑的一部分，不在这次改动的范围内）；
   * - 记账本身包在 try/catch 里：**数不出来就不数**，绝不把这条消息链炸掉
   *   （它挂在每条消息的热路径上，这个项目为此崩过三次，见 `AGENTS.md`）。
   *
   * @param {object} input 见 {@link buildPrecheckPrompt}（外加 `transcript` / `messageText`）
   * @returns {Promise<PrecheckOutcome>}
   */
  async function check(input = {}) {
    const outcome = await runCheck(input);
    try {
      const chatId = input !== null && typeof input === 'object' ? input.chatId : '';
      stats.record(chatId, outcome);
    } catch {
      /* 计数器绝不抛（`record` 自己也包了，这里是第二道） */
    }
    return outcome;
  }

  return {
    /** 有可用模型与 llm 服务才是真开启（否则每次调用都会打一条 warn）。 */
    enabled: hasModel && canStream,
    check,
    /** 给调试快照用的自述（它是"precheck 到底走哪条模型"的唯一答案）。 */
    describe: () => ({ ...target(), timeoutMs, enabled: hasModel && canStream }),
    /**
     * **判定器计数**（2026-10-28 加）：`{since, sessionCount, sessions:[[chatId, {...}]], total}`。
     *
     * ⚠️ **每次都要重新调**，别缓存结果 —— 它读的是活的计数器
     * （踩过同类坑：`engine.precheckInfo` 是构造时抓的一份 `describe()` 拷贝，
     * 所以那一份里**永远不会**出现新的计数）。
     * `enabled` 由这里补上（`judge-stats` 不管它自己开没开）。
     */
    stats: () => ({ enabled: hasModel && canStream, ...stats.snapshot() }),
  };
}
