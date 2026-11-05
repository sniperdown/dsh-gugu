/**
 * DSH 绑定层：把网关的 `responder` 接到真实的 DSH 会话上。
 *
 * 用的是 `dsh-agent` README 里的官方范式：
 *   ctx.agents.create / resume  →  handle.agent.followup(...)  →  await handle.agent.whenIdle()
 * 回复从 `handle.agent.session.deriveMessages()` 里读（`deriveMessages()` 每次返回新快照）。
 *
 * 这一层**刻意与网关解耦**：网关只认 `responder` 这个函数签名，所以整条链路
 * 可以用假 responder 离线测透（见 gateway.test.mjs）。真机上只换这一个实现。
 *
 * `extractAssistantText` 是纯函数且单独导出：消息的具体形状是构建产物里
 * 唯一不够确定的部分，所以抽取逻辑写成对多种形状都稳，并且有专门用例。
 *
 * @module qq-dsh/binding
 */
import { randomUUID } from 'node:crypto';

import { chatIdFromSessionKey, sessionKeyFromChatId } from './routing.mjs';
import { formatRecall, RECALL_DEFAULTS } from './recall.mjs';

// ================================================== 跨插件热重载的中转（2026-10-20）
//
// ## 为什么需要它
//
// `agentCtx` 现在挂在 `ctx.root` 上（跨插件热重载存活），于是**注册在它上面的
// effect 也一起活着**：`tools.register()` 与 `systemPrompt.section()` 都是这个形状。
// HMR 之后新实例走「收养」，在**同一个 agentCtx** 上再注册会抛"重复"，被 try/catch
// 吞掉 ⇒ **旧注册继续生效**，而旧注册的闭包捕获的是**旧实例的 gateway**
// （旧 transport 已经在 shutdown 里 `stop()` 过了）⇒ 工具静默失效。
//
// ## 解法：工具的执行器不绑实例
//
// 工具注册只发生一次，`execute` 里**运行时查中转表**：表里是谁就打到谁。
// 每个插件实例启动时（`SessionBinder` 构造 / `index.mjs` 接线后）把**当前实例**的
// 三个执行器写进去（覆盖旧值）⇒ 旧注册调用的是新实例。
//
// ⚠️ 键必须用 `Symbol.for()`：模块本身也会被 HMR 重新 import，模块级常量会重置，
//    只有**全局符号注册表**里的键能在两代模块之间对上。
const TOOL_BRIDGE_KEY = Symbol.for('dsh.qq-proactive.toolBridge');

/**
 * 拿到跨插件热重载存活的中转表（不存在就建一个）。
 *
 * 形状：`{ send, look, voice }`，每个槽位是**当前插件实例**的执行器或 `null`。
 *
 * @returns {{send: null|((args: object) => any), look: null|((args: object) => any), voice: null|((args: object) => any)}}
 */
export function toolBridge() {
  const g = globalThis;
  let bridge = g[TOOL_BRIDGE_KEY];
  if (bridge === null || typeof bridge !== 'object') {
    bridge = { send: null, look: null, voice: null };
    g[TOOL_BRIDGE_KEY] = bridge;
  }
  // 容忍"上一代模块只写了部分槽位"的形状（比如将来加了第四个工具）。
  if (!Object.hasOwn(bridge, 'send')) bridge.send = null;
  if (!Object.hasOwn(bridge, 'look')) bridge.look = null;
  if (!Object.hasOwn(bridge, 'voice')) bridge.voice = null;
  return bridge;
}

/**
 * 把**当前实例**的执行器写进中转表（覆盖旧值）。
 *
 * 只覆盖调用里**给出**的槽位；显式传 `null` 是"清空"（测试用）。
 * 非函数一律落到 `null` —— 热路径上不该出现 `… is not a function`。
 *
 * @param {{send?: unknown, look?: unknown, voice?: unknown}} [executors]
 * @returns {ReturnType<typeof toolBridge>} 写入后的中转表
 */
export function publishToolBridge({ send, look, voice } = {}) {
  const bridge = toolBridge();
  const put = (key, value) => {
    if (value === undefined) return;
    bridge[key] = typeof value === 'function' ? value : null;
  };
  put('send', send);
  put('look', look);
  put('voice', voice);
  return bridge;
}

// ================================================== 注册台账（幂等用）
//
// 「这个 agentCtx 上到底注册过没有」不能靠模块级变量：HMR 会重置模块。
// 把台账**挂在 agentCtx 上**（`Symbol.for` 的键），它跟 agent 一样跨热重载存活。
//
// 记两样东西：
//   - `tools`：工具名 → `tools.register()` 返回的 disposer（只用来判重/将来替换）；
//   - `sections`：section 名 → `systemPrompt.section()` 返回的 disposer。
//
// 对 **section** 我们比"判重"多做一步：拿到上一代 disposer 就先撤销、再按本实例的
// 闭包重新注册 —— 因为 section 的 `text` 是**闭包**（人格 / 心情 / 知识都从 `this` 取），
// 跳过就等于内容永远冻在旧实例上，改 `qq-gugu.toml` 不再生效。
// 工具不需要这一步：它们的执行走上面的中转表（见 `register*Tool` 的 `execute`）。
const REGISTRATION_LEDGER_KEY = Symbol.for('dsh.qq-proactive.registrationLedger');

/**
 * 读（必要时创建）某个 agentCtx 上的注册台账。
 *
 * 拿不到可写对象时返回 `null`（调用方按"没有台账"处理，退化成**每次都试注册**）。
 *
 * @param {any} agentCtx
 * @returns {{tools: Map<string, Function|null>, sections: Map<string, Function|null>}|null}
 */
function registrationLedger(agentCtx) {
  if (agentCtx === null || (typeof agentCtx !== 'object' && typeof agentCtx !== 'function')) return null;
  let ledger = agentCtx[REGISTRATION_LEDGER_KEY];
  if (ledger === null || typeof ledger !== 'object') {
    ledger = { tools: new Map(), sections: new Map() };
    try {
      agentCtx[REGISTRATION_LEDGER_KEY] = ledger;
    } catch {
      return null;
    }
  }
  if (!(ledger.tools instanceof Map)) ledger.tools = new Map();
  if (!(ledger.sections instanceof Map)) ledger.sections = new Map();
  return ledger;
}

/** 宿主的"重复注册"报错长这样 —— 只认这一种（别的错照旧 warn）。 */
function isDuplicateRegistrationError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('already registered') || message.includes('已经注册');
}

/**
 * 群会话**默认**禁用的工具（`tools.restrict({ deny })` 的名单）。
 *
 * 只放 `pwsh`：这是用户明确批准的那一条 —— 群里的人不该能驱动这台机器的 shell。
 *
 * ⚠️ **名字必须是"已注册的全局工具名"**，写错会被 `tools.restrict()` 拒绝
 * （错误信息里带全部合法名字，见 `restrictGroupTools`）。所以这里刻意**不放 `bash`**：
 * 本部署的 `cordis.patch.yml` 里 `tool-bash` 是 `disabled: !!js process.platform === 'win32'`，
 * 在 Windows 上它根本没注册 —— 写进名单会让**整条限制一起失败**（连 `pwsh` 都禁不掉，
 * 因为 `restrict` 是"一次调用校验全部名字"）。换平台要禁 bash 就让配置去加。
 *
 * 语义是**能力移除**，不是提示词里的请求：`restrict` 会把工具从该 agent 可见的
 * 工具表里删掉，模型连它都看不见，所以群里的人诱导不出一个不存在的工具。
 */
export const DEFAULT_GROUP_DENY_TOOLS = ['pwsh'];

/**
 * 群会话要额外收掉的「宿主全局工具族」（2026-11-04 用户批准）。
 *
 * 和上面 `DEFAULT_GROUP_DENY_TOOLS` 的关键区别是**注册在哪一层**：
 *
 * - `pwsh` 来自 **preset**（`tool-pwsh` 挂在 preset 的插件行里）⇒ 主控制是 preset 本身，
 *   `restrict` 只是"没挂上推导出来的那份"时的保险丝；
 * - `ops_*` / `dsh_browser_*` / `screen_view` 来自 **全局层**（`dsh-ops`、
 *   `dsh-builtin-browser`、桌面壳）⇒ **任何 preset 都拿不掉**，群会话只要继承全局层
 *   就一定有。所以这一族必须**每次建群会话都显式收**，跟挂没挂 `-lite` 无关。
 *
 * 用**前缀**而不是逐个名字：浏览器那三十几个工具会随版本涨（rc.2 → rc.5 就加过一批），
 * 写死一份名单必然腐烂；前缀让"新加的浏览器工具"自动落网。
 */
export const GROUP_DENY_HOST_PREFIXES = ['ops_', 'dsh_browser_'];

/** 前缀之外的单点（`screen_view` 是桌面壳的一张截图，不属于任何前缀族）。 */
export const GROUP_DENY_HOST_EXACT = ['screen_view'];

/**
 * 从可见工具名里挑出群会话要收掉的宿主工具族。
 *
 * 纯函数：给什么名字挑什么，不查宿主、不抛错 —— 这样"挑法"能被单测钉死，
 * 而"名字从哪来"留在 `restrictGroupHostTools` 里（那里必须现取，理由见下）。
 *
 * @param {unknown} names 可见工具名（允许混入非字符串/重复/空白，按需过滤）
 * @returns {string[]} 去重后的名字，保持输入顺序
 */
export function pickGroupDeniedHostTools(names) {
  const list = Array.isArray(names) ? names : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name === '' || seen.has(name)) continue;
    if (GROUP_DENY_HOST_EXACT.includes(name) || GROUP_DENY_HOST_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * 群会话 preset 的默认后缀：私聊挂 `gugu` → 群挂 `gugu-lite`。
 *
 * **为什么群会话要单独一个 preset，而不是继续靠 `restrict`：**
 *
 * `tools.restrict()` 是 **per-agent** 的能力收口 —— 它把过滤器挂进**那个 agent 自己**
 * 的层（`@deepseek-ai/dsh-tools` 的 `restrict()` → `layer.restrictions.append`），
 * 而子会话是另一个 scope、另一套层，**不会继承父的 restrict**。实测证实过：
 * 群会话根会话没有 `pwsh`，小鲸鱼派了个子会话，子会话有 `pwsh` 且成功跑了命令。
 *
 * 而 `dsh-subagent` 建子会话时读的是**父的 preset**，两处：
 *   - 子会话的 `meta.agentPreset` 取 `parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)`
 *     （`childSessionMeta`，lib/index.js:471-482，注释原话「read from the parent's LIVE scope chain」）；
 *   - 真正挂载走 `applyChildComposition` → `composeFrom(childCtx, parent.ctx)`
 *     （lib/index.js:511-512），它把子作用域的父链接指向**父手上那一代 preset**
 *     （`bindScopeParent(key, generation.key)`）。
 *
 * ⇒ 子会话继承的是「父的 preset」，不是「父的 restrict」。所以要让子会话也拿不到
 * 危险工具，只能让**父挂的那个 preset 本身**不含它们。
 *
 * ⚠️ 后缀是**推导**出来的（`<私聊 preset>-lite`），不是写死的名字：这样
 * 「私聊挂什么，群就挂它减配的那份」是代码里的规则，而不是配置里两份要人肉对齐的字面量。
 * 要覆盖就用 `groupAgentPreset`；要关掉（群跟私聊一样）就配成空串。
 */
export const GROUP_PRESET_SUFFIX = '-lite';

// ================================================== 按需加载（2026-11-04）
//
// 目的：**省上下文**。工具 schema 是每轮都带的那一大坨 —— 本机实测 118 个 / 100,201 字
// （约 3.5 万 token），而 14 天里 36 个工具一次都没被调用过。这一族不常驻：
// 系统提示里只留一行 `名字 — 一句话`，真要用了再 `load_tools` 载入。
//
// 为什么不是 `deferLoading`：那个标记 DSH 只在中途新增工具时自动打（`dsh-llm` 761-764），
// 没有配置开关；而且就算打了，模型看不见名字也照样想不起来用。**目录是必须的**，
// 有了目录 + 载入，`defer_loading` 就变成额外好处而不是前提。

/**
 * 默认**不常驻**的工具族（前缀）。按族而不是按名字：浏览器那三十几个会随版本涨。
 *
 * 只放「用的时候多花一步完全不亏」的族；读写文件 / shell / QQ 发送 / 记忆这些高频的
 * 一律常驻 —— 它们占了调用量的 87%，让模型每轮都为它们多跳一次是纯亏。
 *
 * 关掉：`[on_demand] tools = []`（toml）或构造参数传 `[]`。
 */
export const DEFAULT_ON_DEMAND_PREFIXES = [
  'dsh_browser_', // 内置浏览器（34 个）
  'zhihu_', // 知乎（14 个）
  'mcp__argo__', // argo 搜索（3 个）
  'schedule_', // 定时任务（4 个）
  'team_', // 团队任务板（4 个）
  'session_', // 会话检索（5 个）
  'desktop_', // 桌面操作（2 个）
  'job_', // 后台作业（3 个）
];

/** 目录里每条「一句话」的上限（字）。60 是实测下来“够读懂、又不肉”的档。 */
export const ON_DEMAND_CATALOG_CAP = 60;

/** 目录段的名字（幂等键）。 */
export const ON_DEMAND_SECTION = 'qq:on-demand-tools';

/** 目录段在系统提示里的排序值（外部贡献允许任意有限值）。 */
export const ON_DEMAND_SECTION_ORDER = 1200;

/**
 * 目录/加载工具的名字。
 *
 * 用 `load_tools` 而不是 `use_tool`：它不是"调用工具"，是"把工具的定义取回来"。
 */
export const ON_DEMAND_TOOL_NAME = 'load_tools';

/** 从可见工具名里挑出「不常驻」的那些（前缀匹配，保序去重）。 */
export function pickOnDemandTools(names, prefixes = DEFAULT_ON_DEMAND_PREFIXES) {
  const list = Array.isArray(names) ? names : [];
  const pref = Array.isArray(prefixes)
    ? prefixes.filter((p) => typeof p === 'string' && p.trim() !== '').map((p) => p.trim())
    : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name === '' || seen.has(name)) continue;
    if (pref.length > 0 && pref.some((prefix) => name.startsWith(prefix))) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * 探测哪些名字真的能被 `restrict` 收掉。
 *
 * `restrict` 只认「全局层 + 祖先层」，**agent 自己那层注册的工具收不到**；而它是
 * **一次校验全部名字**——名单里混进一个收不到的，整条限制就失败。真机上
 * `dsh-experimental-tool-agent-team` 的工具就是在 `agent.ctx.tools.register` 注册的，
 * 混进来直接把 schedule/jobs 一起拖失败（2026-11-05 实测）。
 *
 * 逐个试：成功就拿住 disposer 立刻撤销（**只探测，不留层**）。
 *
 * @returns {{ok: string[], blocked: string[]}}
 */
export function partitionRestrictable(tools, agentCtx, names) {
  const ok = [];
  const blocked = [];
  for (const name of Array.isArray(names) ? names : []) {
    try {
      const lift = tools.restrict({ deny: [name] });
      if (typeof lift === 'function') lift();
      ok.push(name);
    } catch {
      blocked.push(name);
    }
  }
  return { ok, blocked };
}

/** 把一段描述压成一句（去换行、取第一句、超长截断）。 */
export function oneLineOf(text, cap = ON_DEMAND_CATALOG_CAP) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  const cut = flat.search(/[。．.！!？?；;]\s?/u);
  const sentence = cut === -1 ? flat : flat.slice(0, cut + 1);
  if (sentence.length <= cap) return sentence;
  return `${sentence.slice(0, Math.max(1, cap - 1))}…`;
}

/**
 * 渲染目录文本（每行 `名字 — 一句话`）。
 *
 * 纯函数：给定定义与上限，输出稳定字符串 —— 目录是**常驻前缀**，稳定才能吃到缓存。
 */
export function renderToolCatalog(defs, { cap = ON_DEMAND_CATALOG_CAP, intro } = {}) {
  const lines = (Array.isArray(defs) ? defs : [])
    .filter((d) => d !== null && typeof d === 'object' && typeof d.name === 'string' && d.name !== '')
    .map((d) => `${d.name} — ${oneLineOf(d.description, cap)}`);
  if (lines.length === 0) return '';
  const head =
    typeof intro === 'string' && intro !== ''
      ? intro
      : `【按需工具】下面这些工具为了省上下文没有常驻。需要哪个就先调用 ${ON_DEMAND_TOOL_NAME} 加载，加载后即可正常调用：`;
  return `${head}\n\n${lines.join('\n')}`;
}


/**
 * 解析「这个会话该挂哪个 preset」。
 *
 * | 会话 | `groupAgentPreset` | 结果 |
 * |---|---|---|
 * | 私聊 / 其它 | —— | `agentPreset` |
 * | 群 | 没配（`undefined`/`null`/非字符串） | `agentPreset` + `-lite`（`agentPreset` 为空则空） |
 * | 群 | 字符串（含空串） | 原样用它；`''` = 群跟私聊用同一个 preset（急刹车） |
 *
 * ⚠️ 三态是**刻意**的，和 `resolveGroupDenyTools` 同一套理由：`undefined` = 没配（走
 * 推导），`''` = 配了但要求"不区分"。所以 `groupAgentPreset` **不能进 `CONFIG_SHAPE`**
 * —— 那一层会把"没配"物化成空串，两种意图就再也分不开了。
 *
 * ⚠️ **没有任何输入会让群会话"不挂 preset"**（除非 `agentPreset` 本来就是空）。
 * 这是刻意的：不挂 = 只剩 global 层 = 挂上 standard，"You are a coding agent" 的口吻，
 * 实测踩过。所以连类型写错（传了数字之类）也退回**推导值**，而不是退回"不挂"。
 *
 * @param {{sessionKey?: unknown, agentPreset?: unknown, groupAgentPreset?: unknown, kind?: unknown}} [input]
 * @param {'group'|'private'|'unknown'} [input.kind] 会话种类（P1-4：由映射表解析器给出；
 *   不传 ⇒ 回退旧前缀判断，与改动前逐字一致）
 * @returns {string} preset 注册名（`agentPresets` 里 `config.id` 那个值），空串 = 不挂
 */
export function resolveSessionPreset({ sessionKey, agentPreset, groupAgentPreset, kind } = {}) {
  const base = typeof agentPreset === 'string' ? agentPreset.trim() : '';
  const resolvedKind = kind === 'group' || kind === 'private' || kind === 'unknown'
    ? kind
    : sessionKindOf(sessionKey);
  if (resolvedKind !== 'group') return base;
  const derived = base === '' ? '' : `${base}${GROUP_PRESET_SUFFIX}`;
  if (typeof groupAgentPreset !== 'string') return derived;
  const explicit = groupAgentPreset.trim();
  // 空串 = 明确要求「群跟私聊同一份」（急刹车）。注意是**退回私聊那份**，
  // 不是"不挂" —— 那两件事差着一个 standard 口吻。
  return explicit === '' ? base : explicit;
}

/**
 * 归一化工具名清单：只留非空字符串、去重、保持原顺序。
 *
 * 「非字符串一律丢掉」是刻意的：`deny: [1, true, {}]` 这种坏数据交给 `restrict()`
 * 会走到"未知工具名"分支上，报出来的错看起来像"配置写错了名字"，实际是类型错了。
 * 在这里丢掉，错的只是那一项，不是整条限制。
 *
 * @param {unknown} value 数组，或单个字符串
 * @returns {string[]}
 */
export function normalizeToolNames(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 解析"群会话禁用哪些工具"。
 *
 * 刻意区分三种输入（这个区别很实在）：
 * - `undefined` / `null`：**没配** → 用代码默认（`DEFAULT_GROUP_DENY_TOOLS`）；
 * - 数组（**包括空数组**）：配了 → 尊重它。`[]` 表示"群里不限制任何工具"，
 *   是留给"哪天发现禁错了要立刻放开"的开关（不用改代码、不用发版）；
 * - 其它：归一化后按"配了"处理（写单个字符串也认，少一个坑）。
 *
 * ⚠️ **别把默认值写进 `CONFIG_SHAPE`。** 那一层会**物化**一个值出来（不写就有
 * 空数组/空串），于是"没配"和"配成空"再也分不出来，代码默认永远不生效 ——
 * 这正是宿主 `tools.restrict({})` 那个 materialized-empty-config 坑的同款。
 * 所以这个键**不在 `CONFIG_SHAPE` 里**（与 `tomlPath` / `knowledgePath` 同一处理）。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function resolveGroupDenyTools(value) {
  if (value === undefined || value === null) return DEFAULT_GROUP_DENY_TOOLS.slice();
  return normalizeToolNames(value);
}

/**
 * 判定一个会话键属于哪种会话。
 *
 * ⚠️ **会话键是 `qq-group-<群号>` / `qq-private-<QQ号>`，不是 `group:<群号>`。**
 * `group:` 那套是 **chatId**；会话键由 `routing.sessionKeyFromChatId()` 加 `qq-` 前缀
 * 派生（见 routing.mjs 的注释）。两者长得很像、日志里又常并排出现，所以这里**两种形态都认**
 * —— 认错形态的代价是"限制静默失效"，那是最难查的一类。
 *
 * 群聊那一路用**前缀**判定而不是严格数字正则：会话键在 chatId 派生失败时有个
 * `qq-group-unknown` 兜底（见 gateway.mjs），那种键照样该算群 —— **宁严勿松**。
 *
 * 返回 `'unknown'` 的处理方式是**不限制**，为的是 `dmRouting=main`：
 * 那种配置下私聊落进的是一个 `session-<uuid>` 主会话（主会话的），
 * 按"群"处理会误伤她。
 *
 * @param {unknown} sessionKey
 * @returns {'group'|'private'|'unknown'}
 */
export function sessionKindOf(sessionKey) {
  const key = String(sessionKey ?? '').trim().toLowerCase();
  if (key.startsWith('qq-group-') || key.startsWith('group:')) return 'group';
  if (key.startsWith('qq-private-') || key.startsWith('private:')) return 'private';
  return 'unknown';
}

/** 深度冻结，对齐宿主 `createMessage` 的语义（消息发布后不可变）。 */
export function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

/**
 * 从一条消息对象里抽出文本。
 *
 * 兼容几种可能的形状（构建产物里注释描述为"content blocks"，但不同版本字段名
 * 可能有差异，所以这里稳一点）：
 * - `{ content: [{type:'text', text}] }`（内容块数组，最可能）
 * - `{ content: 'string' }`
 * - `{ text: 'string' }`
 *
 * 返回 `null` 表示"这条消息没有可用文本"，调用方应跳过它。
 * @param {any} message
 * @returns {string|null}
 */
export function extractMessageText(message) {
  if (message === null || message === undefined) return null;
  if (typeof message === 'string') return message === '' ? null : message;
  if (typeof message !== 'object') return null;
  const content = message.content;
  if (typeof content === 'string') {
    return content === '' ? null : content;
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      if (block.type !== 'text') continue;
      if (typeof block.text === 'string' && block.text !== '') parts.push(block.text);
    }
    return parts.length === 0 ? null : parts.join('');
  }
  if (typeof message.text === 'string') {
    return message.text === '' ? null : message.text;
  }
  return null;
}

/** 判定一条派生消息是否助手发言。 */
export function isAssistantMessage(message) {
  if (message === null || typeof message !== 'object') return false;
  return message.role === 'assistant';
}

/**
 * 从一条派生消息数组里选出最后一条非空助手发言。
 * @param {any[]} messages
 * @returns {string|null}
 */
export function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isAssistantMessage(message)) continue;
    const text = extractMessageText(message);
    if (text !== null && text.trim() !== '') return text;
  }
  return null;
}

/**
 * 取某一轮**新增**的助手发言。
 *
 * 为什么要传 `since`：`deriveMessages()` 返回的是整个会话历史，直接取最后一条
 * 会在"模型这一轮没说话"时把上一轮的回复又发一遍。所以按"这一轮开始前的长度"
 * 切片，只认本轮新增的内容。
 *
 * @param {any[]} messages
 * @param {number} since 本轮开始前已派生的消息条数
 * @returns {string|null}
 */
export function assistantTextSince(messages, since) {
  if (!Array.isArray(messages)) return null;
  const start = Number.isFinite(since) && since > 0 ? Math.min(since, messages.length) : 0;
  return lastAssistantText(messages.slice(start));
}

/**
 * 按**本轮提示词消息的 id** 取其后新增的助手发言（2026-10-28 加）。
 *
 * 为什么需要第二条路：`assistantTextSince()` 靠**条数下标**切片，而条数
 * **不是单调的** —— 上下文压缩（compaction）会把一段 surface 用一条 checkpoint
 * 消息**替换掉**（宿主 `compactRegion` + `surfaceOp: {op:'replace'}`），
 * 于是一轮之内 `deriveMessages().length` 会**变小**：
 *
 * ```text
 * before = 900（压缩前）
 * after  =  30（压缩后：摘要 + 本轮的用户消息 + 本轮的助手回复）
 * assistantTextSince(after, 900) → slice(min(900,30)) = slice(30) = [] → null
 * ```
 *
 * ⇒ 回复明明在 `after` 里，却被下标切掉了。用**消息 id 当锚点**就不受条数变化影响：
 * 只要"那条我这一轮投进去的用户消息"还在 surface 里，它后面的助手发言就是本轮的答复。
 *
 * **为什么安全（不会把上一轮的回复又发一遍）**：锚点 id 是这一轮 `randomUUID()`
 * 新生成的，上一轮不存在这条消息 ⇒ 找不到锚点就返回 `null`，绝不退化。
 *
 * @param {any[]} messages `session.deriveMessages()` 的结果
 * @param {string} messageId 本轮投进去的用户消息 id
 * @returns {string|null} 找不到锚点、或锚点后没有助手文本 ⇒ `null`
 */
export function assistantTextAfterMessage(messages, messageId) {
  if (!Array.isArray(messages)) return null;
  if (typeof messageId !== 'string' || messageId === '') return null;
  let anchor = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== null && typeof message === 'object' && message.id === messageId) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return null;
  return lastAssistantText(messages.slice(anchor + 1));
}

/**
 * 取【本轮新增、还没交出去过】的助手正文段，按出现顺序（2026-11-04）。
 *
 * ## 为什么按"消息"切，而不是按"一条消息里的 content 块"切
 *
 * DSH 的 `assistant/message` 事件带 `{turn, step}`（见 `SessionEventMap`），
 * 每一次成功的模型调用**各自追加一条**助手消息到 surface —— 文档原话是
 * "Each successful model call appends one message anchor"。所以"一步一段"
 * 天然就是"一条消息一段"：多步 = **多条**消息，不是一条累积的消息。
 * 因此一小时的活里她先说一句、调个工具、过二十分钟再说一句，会是两条消息。
 *
 * ## 为什么"出现在 `deriveMessages()` 里"就等于"这个 step 结束了"
 *
 * 半截的流式文本**不进** surface：只有落盘（committed）或被中断（`interrupted: true`，
 * 带已交付的前缀）时才追加那条锚点。所以轮询派生消息**不会**把半句话发出去，
 * 也不用去猜"这个 step 完了没有"。
 *
 * ## 去重（**同一个 step 只发一次**）
 *
 * 按消息 id：`seen` 是本次调用方（一轮）已经交出去的 key 集合；`preIds` 是
 * **本轮开始前**就已在 surface 里那些助手消息的 id（压缩会把上一轮的尾巴留在
 * 里面，不能把它当成本轮的新话再发一遍）。
 *
 * @param {any[]} messages `session.deriveMessages()`
 * @param {object} [options]
 * @param {string} [options.anchorId] 本轮投进去的用户消息 id；找到就只看它之后
 * @param {Set<string>} [options.seen] 已经交出去的 key（会被**调用方**更新）
 * @param {Set<string>} [options.preIds] 本轮开始前就存在的助手消息 id
 * @returns {Array<{key: string, id: string, text: string, index: number}>}
 */
export function takeNewAssistantSegments(messages, { anchorId = '', seen = new Set(), preIds = new Set() } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const sent = seen instanceof Set ? seen : new Set();
  const beforeTurn = preIds instanceof Set ? preIds : new Set();
  let from = 0;
  if (typeof anchorId === 'string' && anchorId !== '') {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const message = list[i];
      if (message !== null && typeof message === 'object' && message.id === anchorId) {
        from = i + 1;
        break;
      }
    }
    // 找不到锚点（压缩把它替换掉了）⇒ 从 0 扫，靠 `preIds` 挡住上一轮的旧话。
  }
  const out = [];
  for (let i = from; i < list.length; i += 1) {
    const message = list[i];
    if (!isAssistantMessage(message)) continue;
    const id = typeof message.id === 'string' ? message.id : '';
    const key = id !== '' ? id : `#${i}`;
    if (sent.has(key)) continue;
    if (id !== '' && beforeTurn.has(id)) continue;
    const text = extractMessageText(message);
    if (text === null || text.trim() === '') continue;
    out.push({ key, id, text, index: i });
  }
  return out;
}

/**
 * 逐段扫描的间隔（毫秒）。
 *
 * 一个 step 落盘之后，最多这么久就该到 QQ。别调太小：每次扫描都要走一遍
 * `deriveMessages()`（长会话里是几百条），而它跑在一轮进行中。
 */
const SEGMENT_POLL_MS = 200;

/**
 * 一个 QQ 会话 ↔ 一个持久 DSH 会话的映射与驱动器。
 */
export class SessionBinder {
  /**
   * @param {object} options
   * @param {any} options.ctx Cordis 上下文（需要 `ctx.agents`）
   * @param {object} [options.config] 路由/插件配置
   * @param {(level: string, message: string, meta?: object) => void} [options.log]
   * @param {() => number} [options.now]
   * @param {unknown} [options.denyToolsInGroup] 群会话禁用的工具名清单。
   *   **不传 = 用代码默认**（`DEFAULT_GROUP_DENY_TOOLS`）；传空数组 = 明确不限制。
   *   调用方（`index.mjs`）已经把 toml / cordis 配置的覆盖算完了。
   * @param {unknown} [options.groupAgentPreset] 群会话单独挂的 preset 注册名。
   *   **不传 = 按 `agentPreset` 推导**（加 `GROUP_PRESET_SUFFIX`）；传空串 = 群跟私聊同一个。
   *   和 `denyToolsInGroup` 一样**刻意不进 `CONFIG_SHAPE`**（`undefined` 与 `''` 必须分得开）。
   * @param {(chatId: string) => string} [options.moodFor] **当前心情的取值器**（2026-10-15 加）。
   *   入参是 **chatId**（`group:30000013` / `private:30000001`），返回一句中文心情；
   *   取不到就返回空串。由 `index.mjs` 用 `moodTextFor(mood, chatId)` 装配 ——
   *   **`undefined` / 非函数 = 没有心情**（与接线前逐字一致）。
   * @param {(sessionKey: string) => ({text: string, overridden: string[]}|null)} [options.personaForSession]
   *   **按会话的人格覆盖**（2026-10-21 加）。返回 `null` = 这个会话没有覆盖层，
   *   直接用 `persona` 那份全局人格（逐字节不变）。由 `index.mjs` 用
   *   `personaForSession(personaSections, sessionKey)` + `buildPersona()` 装配。
   *   ⚠️ 它跑在**每轮提示词组装**里（`section.text` 是函数），所以必须自己吞异常。
   * @param {string} [options.agentReasoning] 小鲸鱼的**推理等级**（`[agent] reasoning`，
   *   2026-10-21 加）。由 `index.mjs` 用 `loadAgentConfig()` 解析好再注入（缺省 `low`）。
   *   空串 = 调用方没给 ⇒ 回落到 `config.reasoningEffort`（旧字段），再没有就不发这个字段。
   * @param {object} [options.resolver] 会话映射解析器（`chat-sessions.mjs` 的
   *   `createSessionResolver(...)`，2026-10-24 P1-4）。给了 ⇒ 群/私聊、chatId、QQ 号
   *   都先查它（表优先、旧前缀兜底）；不给 ⇒ 全部走旧前缀逻辑，与改动前逐字一致。
   */
  constructor({ ctx, config = {}, log, now = () => Date.now(), persona = '', knowledge = null, relations = null, recall = null, recentSpeakers = null, learner = null, onLearned = null, denyToolsInGroup = undefined, onDemandTools = undefined, groupAgentPreset = undefined, moodFor = null, knowledgeInject = null, sendTool = null, sendRule = '', autoReply = 'fallback', lookTool = null, voiceTool = null, personaForSession = null, agentReasoning = '', resolver = null, promptCfg = null }) {
    this.ctx = ctx;
    this.config = config;
    /**
     * 每轮提示词里的固定句子（`[prompt]`，2026-10-30）。
     * `null` / 非对象 ⇒ 全部用内置默认值（与搬迁前逐字节相同）。
     * 这里只存**规范化后的结果**：`promptCfg.workdir` 之类的直接取。
     */
    this.promptCfg = (function () {
      const src = promptCfg !== null && typeof promptCfg === 'object' ? promptCfg : {};
      return {
        workdir: typeof src.workdir === 'string' && src.workdir.trim() !== ''
          ? src.workdir
          : 'Your working directory is ',
      };
    })();
    this.resolver = resolver !== null && typeof resolver === 'object' ? resolver : null;
    /**
     * 小鲸鱼的**推理等级**（`[agent] reasoning`，2026-10-21）。
     *
     * 由 `index.mjs` 先用 `loadAgentConfig()` 解析好再注入（缺省 `low`，见
     * `agent-config.mjs` 的说明），这里**只认字符串**。
     *
     * ⚠️ 空串 = "调用方没给" ⇒ `resolveAgentOptions()` 回落到旧字段
     *    `config.reasoningEffort`（`cordis.patch.yml` 那个），再没有就**一个字段都不发**
     *    （继承部署默认）。这样 `new SessionBinder({ctx})` 的行为与改动前逐字一致
     *    —— 缺省值由装配层决定，绑定层不自己发明一个。
     */
    this.agentReasoning = typeof agentReasoning === 'string' && agentReasoning.trim() !== ''
      ? agentReasoning.trim()
      : '';
    /**
     * 「她自己往 QQ 发东西」的工具（2026-10-18，`send_qq`）。由 index.mjs 注入。
     * 配置叫 `[send] rule`，同样**独立一段**，不塞 personality。
     */
    this.sendTool = typeof sendTool === 'function' ? sendTool : null;
    /**
     * 自动发送策略（B2，2026-10-25）：`fallback` / `always` / `off`。
     *
     * 只影响**工具描述那句"平时的回复插件会自动发"**（这是本轮唯一需要跟着变的地方）：
     * 切成 `off` 之后，插件**不再自动发**任何东西 ⇒ 描述里那句必须改，否则她会只输出
     * 文本、什么都不发（静默丢消息，用户那边看起来就是"她不说话了"）。
     *
     * ⚠️ 归一化与 `Gateway` 保持一致：非法值按 `fallback`（**不是** `always` ——
     * 配置打错一个字就悄悄退回"会重复发"的旧行为，是最难查的那种静默错）。
     */
    this.autoReplyMode = ['fallback', 'always', 'off'].includes(String(autoReply ?? '').trim())
      ? String(autoReply).trim()
      : 'fallback';
    this.sendRule = String(sendRule ?? '').trim() === ''
      ? '平时你回话，插件会自动把你这一轮的回复发到 QQ，不用你操心。想多发几条时才用 send_qq：一次最多三条、每条自己说完整、别写「下条继续」；长内容先给一句摘要。发之前先问自己用户现在需不需要看到 —— 空手就别发。'
      : String(sendRule).trim();
    /**
     * 「发之前看一眼这张表情包」的工具（2026-10-19，`look_sticker`）。
     * 由 `index.mjs` 注入，内部是 `gateway.lookFromTool(...)`。
     * 和 `sendTool` 同一个理由：binding 比 gateway 先构造，
     * 直接引用会是 TDZ ⇒ 只能注入函数，非函数一律当"没有"。
     */
    this.lookTool = typeof lookTool === 'function' ? lookTool : null;
    /**
     * 「她自己发一条语音」的工具（2026-10-26，`send_voice`）。由 `index.mjs` 注入，
     * 内部是 `gateway.sendVoiceFromTool(...)`。同 `sendTool` / `lookTool`：
     * binding 比 gateway 先构造 ⇒ 只能注入函数；非函数一律当"没有"（工具就不注册）。
     */
    this.voiceTool = typeof voiceTool === 'function' ? voiceTool : null;
    this.log = log ?? (() => {});
    this.now = now;
    this.persona = persona;
    /**
     * 按会话的人格覆盖解析器（2026-10-21）。**只记函数** —— 传别的东西当"没有覆盖"。
     *
     * 它在 `personaTextFor()` 里每轮被调用一次：拿 `{text, overridden}`，
     * 或 `null`（没有覆盖层 ⇒ 用上面的 `this.persona`）。
     * 异常一律在这里吞掉：它挂在提示词组装路径上，抛出去等于这一轮产不出回复。
     */
    this.personaForSession = typeof personaForSession === 'function' ? personaForSession : null;
    /** 已经打过「persona 覆盖生效」日志的会话+键组合（避免每轮刷屏）。 */
    this.loggedPersonaOverrides = new Set();
    /**
     * 心情取值器（`chatId → 一句心情`）。**只记函数**：传了别的东西一律当"没有心情"，
     * 免得热路径上出现 `moodFor is not a function` 这种把整轮提示词组装炸掉的形状。
     */
    this.moodFor = typeof moodFor === 'function' ? moodFor : null;
    this.knowledge = knowledge;
    /** 关系记账（B 段，2026-11-04）：给知识注入补一行关系摘要；null = 不注入。 */
    this.relations = relations ?? null;
    /** 聊天回想（M1，2026-11-04）：按当前消息召回一条"之前聊过什么"；null = 不注入。 */
    this.recall = recall ?? null;
    /** 最近发言人取值器（B2，2026-11-04）：`(sessionKey) => [{userId, nickname?}]`；null = 只看当前发言人。 */
    this.recentSpeakers = typeof recentSpeakers === 'function' ? recentSpeakers : null;
    this.learner = learner;
    this.onLearned = onLearned;
    /**
     * 知识库注入的两个旋钮（2026-10-17，用户批准的 A+B 方案）。
     *
     * - `maxChars`（A）：每轮注入的**字数上限**，默认 800。超了**按条目丢**，不切半句。
     *   改造前实测每轮 490（一句"在吗"）~1820 字（带资讯时）。
     * - `privateAsSection`（B）：私聊把知识放进 **system prompt 的 section**（`qq:knowledge`），
     *   而不是拼进用户消息 —— 后者会**留在会话历史里累积**（那是真在烧 token 的）。
     *   写 `false` 完全回到改造前。
     *
     * ⚠️ 归一化在这里做一次：热路径上不该出现 `undefined > 800` 这种形状。
     */
    this.kbMaxChars = Number.isFinite(knowledgeInject?.maxChars) && knowledgeInject.maxChars >= 100
      ? Math.floor(knowledgeInject.maxChars)
      : 800;
    this.kbPrivateAsSection = typeof knowledgeInject?.privateAsSection === 'boolean'
      ? knowledgeInject.privateAsSection
      : true;
    /** 每会话最近一次要注入的文本（B 用它当 `qq:knowledge` 的**检索钥匙**）。 */
    this.kbLast = new Map();
    /** 留痕：最近一次注入的字数与走向（进快照的 `knowledgeInject` 段，坏了要看得出来）。 */
    this.kbLastChars = 0;
    this.kbLastMode = 'none';
    /** 群会话禁用的工具（私聊不受影响）。归一化在这里做一次，热路径直接用。 */
    this.denyToolsInGroup = resolveGroupDenyTools(denyToolsInGroup);
    /**
     * 按需加载要收进目录的**前缀**（2026-11-04）。
     *
     * 三态：`undefined` / `null` = 没配 → 用代码默认（`DEFAULT_ON_DEMAND_PREFIXES`）；
     * 数组（**包括空数组**）= 配了 → 尊重它（`[]` 明确表示关掉整个按需加载）。
     * 和 `denyToolsInGroup` 同一套三态语义，别混进 `CONFIG_SHAPE`。
     */
    this.onDemandPrefixes = onDemandTools === undefined || onDemandTools === null
      ? DEFAULT_ON_DEMAND_PREFIXES.slice()
      : normalizeToolNames(onDemandTools);
    /**
     * 群会话单独挂的 preset。`undefined` = 没配 → 按 `agentPreset` 推导 `-lite`。
     * **不做归一化**：这里要保住"没配"和"配成空串"的区别（见 `resolveSessionPreset`）。
     */
    this.groupAgentPreset = groupAgentPreset;
    /** @type {Map<string, {handle: any, sessionKey: string, lastUsedAt: number}>} */
    this.live = new Map();
    /** 同一会话串行：两轮并发会让 agent 收件箱里的顺序不可控。 */
    this.locks = new Map();
    /** 已经就 cwd 缺失告警过的会话（每个会话只吵一次）。 */
    this.warnedCwd = new Set();
    /**
     * 最近一次 `ensure()` 建/接会话走的是哪条路（进快照的 `sessionMode` 段）。
     *
     * 形状**固定**成 `{via: 'resume'|'create'|'adopt', reason: string|null}`：
     * `via` 回答"这一轮是恢复、新建、还是收养"，`reason` 只在
     * **恢复失败 ⇒ 改为新建**时有值（失败原因原样带出）。
     *
     * 为什么必须有它：恢复失败原来只打一条 debug 日志就静默新建同 id 会话，
     * 用户侧的现象是"她突然不记得之前的话"，而日志里分不清是恢复还是新建。
     * 默认 `create/null` —— 还没建过会话时形状也是合法的，读快照的人不必判空。
     */
    this.lastSessionMode = { via: 'create', reason: null };

    /**
     * 取回复这件事的计数（2026-10-28 加，事故驱动）。
     *
     * 事故：20:43 私聊那一轮，压缩把会话 surface 缩短了 ⇒ `assistantTextSince`
     * 按下标切出空数组 ⇒ 取回 `''` ⇒ 网关按"模型决定不说话"**静默丢弃**，
     * 台账里连 `gw-send` 都没有，而唯一的线索是一条 **debug** 日志
     * （`debug` 默认不输出，宿主 logger 又不落盘 ⇒ 等于什么都没留下）。
     *
     * 这几个数就是"这件事还会不会被看见"的答案。口径：
     * - `turns`：跑过几轮；
     * - `emptyReplies`：**一个字符都没拿到**的轮数（含正常的"模型不说话"，见 `lostReplies`）；
     * - `lostReplies`：**有异常迹象**的空回复（历史被压缩 / 明明有新消息却没文本）——
     *   这是"静默丢消息"的计数，**正常就该是 0**；
     * - `compactedTurns`：会话历史被压缩过的轮数（无论取没取回回复）；
     * - `recoveredByAnchor` / `recoveredByStream`：**兜底救回来的**轮数 ——
     *   它们 > 0 就说明这条路真的在用（前缀 `recovered` 与丢失路径分开记，
     *   否则"救回来了"和"压根没出事"在快照上一样）。
     */
    this.turnStats = {
      turns: 0,
      emptyReplies: 0,
      lostReplies: 0,
      compactedTurns: 0,
      recoveredByAnchor: 0,
      recoveredByStream: 0,
    };
    /**
     * 每会话**最近一轮**的取回复诊断（供网关在"空回复"分支留痕 / 进快照）。
     *
     * 形状：`{kind, before, after, historyShrank, streamFrames, streamedChars, at}`。
     * `kind` 四态：`ok`（正常拿到）/ `ok-anchor`、`ok-stream`（兜底救回）/
     * `lost`（有迹象的空回复）/ `empty`（一点动静都没有）。
     */
    this.lastTurnDiag = new Map();

    // 🔴 把**本实例**的执行器写进跨热重载的中转表（覆盖上一代实例的值）。
    //
    // 工具注册只发生一次（下一轮换插件实例时会被判重跳过），所以 `execute` 里
    // 必须**运行时查表**而不是闭包捕获：表里是谁，旧注册就打到哪里。
    // `index.mjs` 在 gateway 接线后还会再写一次（那三个包装函数读的是 ref，
    // 先写还是后写都一样指向本实例），这里写是为了让**直接构造 binder 的测试**
    // 也得到和宿主一致的语义（否则工具会以为"没接线"）。
    publishToolBridge({ send: this.sendTool, look: this.lookTool, voice: this.voiceTool });
  }

  /** `ctx.agents` 是否可用。缺失时整个插件应当明确报错而不是静默不工作。 */
  requireAgents() {
    const agents = this.ctx?.agents;
    if (agents === undefined || agents === null) {
      throw new Error(
        'QQ 插件需要 agent 服务（ctx.agents）才能建立会话。请确认 profile 里挂了 @deepseek-ai/dsh-agent 与 @deepseek-ai/dsh-agent-loop。',
      );
    }
    return agents;
  }

  /**
   * 给**群会话**禁掉危险工具；私聊不受影响（那是"联系不上主会话时的备用通道"）。
   *
   * 用的是 DSH 原生的 per-agent 能力收口（`@deepseek-ai/dsh-tools` 的
   * `tools.restrict({ deny })`），不是"在提示词里请求模型别用 shell"：
   * 提示词是**请求**，模型可以不听；`restrict` 是**从可见工具表里删掉** ——
   * 模型连这个工具都看不见，群里的人也就诱导不出一个不存在的工具。
   * 返回的 disposer 由 `ctx.effect` 注册，agent 销毁时自动撤销，这里不用手工管。
   *
   * ⚠️ **2026-10-07 起它不再是群会话的主控制，而是「保险丝」。**
   * 主控制是**群会话挂的那份 preset**（`GROUP_PRESET_SUFFIX` / `groupToolBackstop`）——
   * 因为 `restrict` 是 per-agent 的、**子会话不继承**，能被"派个子会话"绕过去（实测）。
   * 本方法现在只在**没挂上推导出来那份群 preset** 时才被调用（见 `groupToolBackstop`）。
   *
   * 调用时机有两处，缺一不可 —— **两处都改走 `groupToolBackstop` 了**，
   * 由它决定要不要落到这里：
   *  1. `setup(agentCtx)` —— agent 发布前的钩子。这是主路径（create / resume 都会走），
   *     限制在这一刻挂上，agent 第一次跑就已经是受限的，没有"先不受限跑一轮"的窗口。
   *  2. `ensure()` 里**复用已有 agent** 那一路。那条路**不经过 `setup`**，而它真实存在：
   *     插件热重载（改一次 `src/dsh/**` 就发生一次）会把 `this.live` 清空，
   *     但活着的 agent 还在 —— 于是下一次 `ensure` 会走复用分支。不在这里补一次，
   *     群会话就会**安静地拿回 shell 权限**（没有任何报错，只是限制没了）。
   *
   * ⚠️ **本方法绝不抛异常。** `restrict()` 会在这些情况下抛：
   *   - 从非 agent 作用域的 ctx 调（`requires a scoped context (agent.ctx)`）；
   *   - 名单里有**未注册**的全局工具名（错误信息里带全部合法名字）；
   *   - 名单里有保留名 `run_code`；
   *   - 传了空 filter。
   * 而调用点之一是 `setup` —— 那是**建会话的路径**：抛出去就等于"名单里写错一个字，
   * 这个 QQ 会话整个建不起来"。所以这里全部吞掉，只留一条 warn（含错误原文，
   * 里面有合法工具名清单，照着改配置即可），**会话照常建立**。
   *
   * @param {any} agentCtx agent 作用域的 ctx（只有它上面才有 `tools.restrict`）
   * @param {string} sessionKey 形如 `qq-group-<群号>`
   * @param {string} [via] 调用来源（`setup` / `reuse`），只进日志便于定位
   * @returns {boolean} 是否真的挂上了限制
   */
  /**
   * 给她注册「往 QQ 发东西」工具（2026-10-18，`send_qq`，第一档只文字）。
   *
   * 和 `registerSendTool` 同一个形状、同一个理由：
   *   - 必须用 `agentCtx.tools.register`（插件自己的 ctx 注册出来是全局的，
   *     主会话的工具列表里会多一个"往 QQ 发东西"，纯噪音）；
   *   - `setup` 与【复用】两条路都要注册（热重载会 dispose 旧 ctx 上的注册）；
   *   - 整段包 try —— 调用点在 setup，抛出去会话就建不起来。
   *
   * ⚠️ 真正发不发、发几条、发给谁：**全由 `gateway.sendFromTool` 判**。
   *    工具这层只做参数形状校验，不复制任何规则。
   */
  registerSendTool(agentCtx, sessionKey, via = 'setup') {
    const tools = agentCtx?.tools;
    const sendFn = this.sendTool;
    const ledger = registrationLedger(agentCtx);
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      this.log('warn', `发 QQ 的工具没有注册：这个 agent 作用域上没有 tools.register`, { sessionKey, via });
      return false;
    }
    // 🔴 幂等：收养一个**活着的** agent 时，上一代实例已经注册过 —— 再注册会抛
    // "already registered"，旧版被 try/catch 吞成一条 warn，结果是"旧注册继续生效"。
    // 现在提前判掉（台账挂在 agentCtx 上，跨热重载存活）。
    if (ledger !== null && ledger.tools.has('send_qq')) {
      this.log('debug', `发 QQ 的工具已经在这个 agent 上注册过，跳过（${via}）`, { sessionKey, via });
      return false;
    }
    if (sendFn === null) {
      this.log('debug', `发 QQ 的工具没有注册：没有注入 sendTool（未接线）`, { sessionKey, via });
      return false;
    }

    try {
      const dispose = tools.register({
        name: 'send_qq',
        description:
          '往当前这个 QQ 会话发消息（一次 1~3 条）。'
          // ⚠️ 这句必须跟着 `[send] auto_reply` 变（B2，2026-10-25）：
          // 切到 `off` 后插件不再自动发，描述还写着"会自动发" ⇒ 她只输出文本、什么都不发。
          + (this.autoReplyMode === 'off'
            ? '⚠️ 插件**不会**自动发你这一轮说的话 —— 你想说什么都必须用它发；不调它就等于这一轮不说话。'
            : this.autoReplyMode === 'always'
              ? '你这一轮的回复插件会照常自动发（即使用了本工具也一样）。'
              : '平时回话不需要它 —— 你这一轮的回复插件会自动发；但只要你用它发过**文字**，'
                + '这一轮的回复就不再自动发（免得同一句话发两遍）。只发表情包不影响自动发送。')
          + ' 想多发几条、想把一段话分成几条说、或者想甩一张表情包/一张图时才用。只能发到当前会话，不能选发件对象。' +
          ' 表情包用 kind=sticker 配 tag：按标签从库里随机挑一张。' +
          ' 库里现成的标签（选一个最贴的）：卖萌可爱 / 幽默搞笑 / 无语无奈 / 玩梗接梗 / 调侃吐槽 / 开心满足 / ' +
          '困惑不解 / 害羞心动 / 治愈陪伴 / 生气不满 / 难过不安 / 震惊惊讶 / 尴尬社死 / 吃瓜围观 / 得意自信 / 赞同支持。' +
          ' 不传 tag 就是全库随机。想指定某一张才用 kind=sticker 配 md5。' +
          ' 想发**具体某张图**（比如你刚截的图、某个文件的图）用 kind=image 配 path'
          + '（本地绝对路径，或 http/https 链接），可选配 caption 当图注；'
          + ' 只认 jpg/jpeg/png/webp/gif/bmp，单张不超过 [send] max_image_mb（默认 10 MB），'
          + ' 超了或格式不对会被拒（不会悄悄截断）。',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              description: '要发的几条，按顺序发；一次最多 3 条（图 + 文合计），总共不超过 6000 字',
              items: {
                type: 'object',
                properties: {
                  // 2026-10-19：`text` 之外多了 `sticker`（骰子挑表情包，见 sticker-library.mjs 开头那段）。
                  // 2026-10-26：再加 `image`（发任意一张图；走的是网关**已有**的发图链路）。
                  // ⚠️ 刻意**不新开一个 images 数组**：`kind` 已经是判别字段，用两个平行数组会出现
                  //    "图文交错顺序"的歧义（第 1 张图配第 2 句话？说不清）。
                  kind: {
                    type: 'string',
                    enum: ['text', 'sticker', 'image'],
                    description: 'text = 一句话；sticker = 一张表情包（库里随机/指定）；image = 一张具体的图（给 path）',
                  },
                  text: { type: 'string', description: 'kind=text 时的正文' },
                  tag: { type: 'string', description: 'kind=sticker：单个标签（老写法，等价于只给一个 tags）' },
                  tags: {
                    type: 'array',
                    description: 'kind=sticker：按 1~2 个标签挑（推荐）。越冷门的类越容易被挑到，不会老是发萌图',
                    items: { type: 'string' },
                  },
                  mood: {
                    type: 'string',
                    description: 'kind=sticker：你想要的那股劲儿（一句话，比如“被逗笑又无语”）。有画面描述的图会按字面贴合加分',
                  },
                  md5: { type: 'string', description: 'kind=sticker 时指定某一张（一般不用）' },
                  path: {
                    type: 'string',
                    description: 'kind=image：图片的本地绝对路径，或 http/https 链接（file:// 会被拒）',
                  },
                  caption: {
                    type: 'string',
                    description: 'kind=image：可选的图注（跟图同一条消息发出去）',
                  },
                },
                additionalProperties: false,
              },
            },
          },
          required: ['items'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              sent: { type: 'number' },
              note: { type: 'string' },
            },
            required: ['ok', 'sent', 'note'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.note ?? '') }],
        },
        async execute(args) {
          const items = Array.isArray(args?.items) ? args.items : null;
          if (items === null) throw new Error('items 必须是数组（要发哪几条？）');
          // 🔴 运行时查中转表（不是闭包捕获 sendFn）：旧注册也能打到**当前实例**的网关。
          const fn = toolBridge().send;
          if (typeof fn !== 'function') {
            return { ok: false, sent: 0, note: '发 QQ 的通道没接上（插件刚启动？），这条没发出去。' };
          }
          return fn({ sessionKey, items });
        },
      });
      if (ledger !== null) ledger.tools.set('send_qq', typeof dispose === 'function' ? dispose : null);
      this.log('info', `已给她注册发 QQ 工具 send_qq`, { sessionKey, via });
      return true;
    } catch (error) {
      // 重复 = 上一代实例（旧代码没有台账）已经注册过：降级成 debug，别的错照旧 warn。
      if (isDuplicateRegistrationError(error)) {
        if (ledger !== null) ledger.tools.set('send_qq', null);
        this.log('debug', `发 QQ 的工具已经在这个 agent 上注册过（宿主报重复），跳过`, { sessionKey, via });
        return false;
      }
      this.log('warn', `发 QQ 的工具注册失败`, {
        sessionKey,
        via,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 给她注册「发一条语音」工具（2026-10-26，`send_voice`）。
   *
   * 和 `registerSendTool` / `registerLookTool` **同一个形状、同一个理由**：
   *   - 只挂 `agentCtx.tools.register`（插件自己的 ctx 上注册会变成**全局工具**，
   *     主会话的工具列表里会多一个"发 QQ 语音"，纯噪音）；
   *   - `setup` 与**复用**两条路都要注册（热重载会 dispose 旧 ctx 上的注册）；
   *   - 整段包 try —— 调用点在 `setup`，抛出去这个会话就建不起来。
   *
   * ⚠️ **真发不发、发去哪、群里让不让、间隔多少**：全由 `gateway.sendVoiceFromTool` 判。
   *    工具这层只做参数形状校验，不复制任何规则。
   * ⚠️ 这个工具**不碰 `toolSendSeq`**（那是 `send_qq` 数文字用的）⇒ 她发了语音，
   *    本轮的文本回复照常自动发（对方可能听不了语音，文字是保底）。
   *
   * @param {any} agentCtx agent 作用域的 ctx
   * @param {string} sessionKey 形如 `qq-private-30000001`
   * @param {string} [via] `setup` / `reuse`，只进日志
   * @returns {boolean} 是否真的注册上了
   */
  registerVoiceTool(agentCtx, sessionKey, via = 'setup') {
    const tools = agentCtx?.tools;
    const voiceFn = this.voiceTool;
    const ledger = registrationLedger(agentCtx);
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      this.log('warn', `发语音的工具没有注册：这个 agent 作用域上没有 tools.register`, { sessionKey, via });
      return false;
    }
    // 幂等：收养一个**活着的** agent 时，上一代实例已经注册过（理由同 `registerSendTool`）。
    if (ledger !== null && ledger.tools.has('send_voice')) {
      this.log('debug', `发语音的工具已经在这个 agent 上注册过，跳过（${via}）`, { sessionKey, via });
      return false;
    }
    if (voiceFn === null) {
      this.log('debug', `发语音的工具没有注册：没有注入 voiceTool（未接线或 [tts] 没开）`, { sessionKey, via });
      return false;
    }

    try {
      const dispose = tools.register({
        name: 'send_voice',
        description:
          '把一句话**说**出来（发一条 QQ 语音条）。只在"出声"明显比文字更合适时才用：'
          + '撒娇、想让她听见语气、说一句很短的话（「晚安」「我在呢」这种）。'
          + '⚠️ 用之前先想清楚：对方可能不方便听（在开会、在外面、静音）——'
          + '重要内容还是用 send_qq 发文字，或者两条都发（发了语音，本轮的文本回复照常会自动发）。'
          + '⚠️ 群聊里默认不许发语音（太显眼），会被拒绝，那种情况请发文字。'
          + '太长的内容会被截断（截了会告诉你截到多少字），所以别拿它念长段落。'
          + '一次只能发一条；刚发过要等几秒。',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: '要说的话（口语，别写 Markdown；太长会被截断）',
            },
            to: {
              type: 'string',
              description: '发到哪个会话（可选，省略就是当前会话）：`group:<群号>` 或 `private:<QQ号>`。不在白名单里的会被拒绝',
            },
            voice: {
              type: 'string',
              description: '可选，换音色（默认取 [tts] voice）',
            },
            rate: {
              type: 'string',
              description: '可选，语速，比如 `+10%` / `-5%`',
            },
          },
          required: ['text'],
          additionalProperties: false,
        },
        output: {
          /**
           * ⚠️ **必须和 `sendVoiceFromTool` 的返回形状逐一对应。**
           *
           * 2026-10-26 线上撞过（用户那头语音已经听到了，DSH 却判整次调用失败）：
           * 这里只声明了 `{ok,sent,note}` + `additionalProperties:false`，而网关成功时
           * 还会返回 `ms` / `chars` ⇒ `tool "send_voice" returned invalid output:
           * "value.ms" is not a declared property; "value.chars" is not a declared property`。
           *
           * ⇒ 两个教训：
           * 1. **声明了 `additionalProperties:false`，返回就一个字段都不许多**；
           *    反过来，返回里有的字段**必须**先在这里声明（`ms`/`chars` 有用，留）。
           * 2. 网关那边照 `lookFromTool` 的 `out()` 那条规矩办：**五个字段永不缺**
           *    （失败时 `ms`/`chars` 填 0），所以这里五个都是 `required`。
           *    别学"成功才有、失败就没有"的可选字段 —— 那种形状最难对账。
           */
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              sent: { type: 'number' },
              note: { type: 'string' },
              /** 合成 + 发送一共花了多少毫秒（被拒时 0）。 */
              ms: { type: 'number' },
              /** 实际念出去的字数（截断后；没合成就 0）。 */
              chars: { type: 'number' },
            },
            required: ['ok', 'sent', 'note', 'ms', 'chars'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.note ?? '') }],
        },
        async execute(args) {
          // 🔴 运行时查中转表（不是闭包捕获 voiceFn）：旧注册也能打到**当前实例**的网关。
          const fn = toolBridge().voice;
          if (typeof fn !== 'function') {
            return { ok: false, sent: 0, note: '发语音的通道没接上（插件刚启动？），这条没发出去。', ms: 0, chars: 0 };
          }
          return fn({ sessionKey, ...args });
        },
      });
      if (ledger !== null) ledger.tools.set('send_voice', typeof dispose === 'function' ? dispose : null);
      this.log('info', `已给她注册发语音工具 send_voice`, { sessionKey, via });
      return true;
    } catch (error) {
      // 重复 = 上一代实例（旧代码没有台账）已经注册过：降级成 debug，别的错照旧 warn。
      if (isDuplicateRegistrationError(error)) {
        if (ledger !== null) ledger.tools.set('send_voice', null);
        this.log('debug', `发语音的工具已经在这个 agent 上注册过（宿主报重复），跳过`, { sessionKey, via });
        return false;
      }
      this.log('warn', `发语音的工具注册失败`, {
        sessionKey,
        via,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 给她注册「发之前看一眼这张表情包」工具（2026-10-19，`look_sticker`）。
   *
   * 和 `registerSendTool` **同一个形状、同一个理由**：
   *   - 只挂 `agentCtx.tools.register`（插件 ctx 上注册会变成全局工具，主会话那边多一个噪音）；
   *   - `setup` 与**复用**两条路都要注册（热重载会 dispose 旧 ctx 上的注册）；
   *   - 整段包 try —— 调用点在 `setup`，抛出去这个会话就建不起来。
   *
   * ⚠️ **这个工具不发消息**：所以网关那层不需要 `outboundAllow`（出站白名单管的是"出去的东西"）。
   *    它只读库 + 读一个本地文件 + 最多一次识图；真正的判断仍在 `gateway.lookFromTool` 里，
   *    工具这层只做参数形状校验，不复制规则（尤其**不**自己判断"要不要看"）。
   *
   * @param {any} agentCtx agent 作用域的 ctx
   * @param {string} sessionKey 形如 `qq-private-30000001`
   * @param {string} [via] `setup` / `reuse`，只进日志
   * @returns {boolean} 是否真的注册上了
   */
  registerLookTool(agentCtx, sessionKey, via = 'setup') {
    const tools = agentCtx?.tools;
    const lookFn = this.lookTool;
    const ledger = registrationLedger(agentCtx);
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      this.log('warn', `看表情包的工具没有注册：这个 agent 作用域上没有 tools.register`, { sessionKey, via });
      return false;
    }
    // 幂等：收养活着的 agent 时上一代已经注册过（理由见 `registerSendTool`）。
    if (ledger !== null && ledger.tools.has('look_sticker')) {
      this.log('debug', `看表情包的工具已经在这个 agent 上注册过，跳过（${via}）`, { sessionKey, via });
      return false;
    }
    if (lookFn === null) {
      this.log('debug', `看表情包的工具没有注册：没有注入 lookTool（未接线）`, { sessionKey, via });
      return false;
    }

    try {
      const dispose = tools.register({
        name: 'look_sticker',
        description:
          '发一张表情包之前拿不准这张对不对，就用它看一眼：给 md5 看指定的那张，或者给 tags / mood 让插件挑一张。' +
          ' 库里已经有画面描述的直接返回（不花钱、不调模型）；没有描述的才会现看一次（有一次视觉调用，同一会话 10 秒最多一次）。' +
          ' 返回的 desc 是这张图**实际长什么样** —— 跟你想表达的情绪对不上就别发它。',
        parameters: {
          type: 'object',
          properties: {
            md5: { type: 'string', description: '要看的表情包 md5（刚用 send_qq 挑中的那张就是它）；不传就按 tags/mood 挑' },
            tags: {
              type: 'array',
              description: '按 1~2 个标签让插件挑一张来看（卖萌可爱 / 幽默搞笑 / 无语无奈 / 玩梗接梗 / 调侃吐槽 / 开心满足 / …）',
              items: { type: 'string' },
            },
            mood: { type: 'string', description: '你想表达的那股劲儿（一句话，比如“被逗笑又无语”）' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              md5: { type: 'string' },
              desc: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              fromCache: { type: 'boolean' },
              note: { type: 'string' },
            },
            required: ['ok', 'md5', 'desc', 'tags', 'fromCache', 'note'],
            additionalProperties: false,
          },
          // 用 `||` 而不是 `??`：**空串也要让位给 desc**（有描述但 note 被清空的情况）。
          render: (_args, value) => [{ type: 'text', text: String(value?.note || value?.desc || '') }],
        },
        async execute(args) {
          const md5 = String(args?.md5 ?? '').trim();
          const rawTags = args?.tags;
          if (rawTags !== undefined && rawTags !== null && !Array.isArray(rawTags)) {
            throw new Error('tags 必须是数组（比如 ["卖萌可爱"]）');
          }
          const tags = Array.isArray(rawTags)
            ? rawTags.map((t) => String(t).trim()).filter((t) => t !== '')
            : undefined;
          const mood = String(args?.mood ?? '').trim();
          // 运行时查中转表（不是闭包捕获 lookFn）：旧注册也能打到**当前实例**的网关。
          const fn = toolBridge().look;
          if (typeof fn !== 'function') {
            return {
              ok: false,
              md5: '',
              desc: '',
              tags: [],
              fromCache: false,
              note: '看表情包的通道没接上（插件刚启动？），这次没看成。',
            };
          }
          return fn({
            sessionKey,
            ...(md5 === '' ? {} : { md5 }),
            ...(tags === undefined ? {} : { tags }),
            ...(mood === '' ? {} : { mood }),
          });
        },
      });
      if (ledger !== null) ledger.tools.set('look_sticker', typeof dispose === 'function' ? dispose : null);
      this.log('info', `已给她注册看表情包工具 look_sticker`, { sessionKey, via });
      return true;
    } catch (error) {
      // 重复 = 上一代实例（旧代码没有台账）已经注册过：降级成 debug，别的错照旧 warn。
      if (isDuplicateRegistrationError(error)) {
        if (ledger !== null) ledger.tools.set('look_sticker', null);
        this.log('debug', `看表情包的工具已经在这个 agent 上注册过（宿主报重复），跳过`, { sessionKey, via });
        return false;
      }
      this.log('warn', `看表情包的工具注册失败`, {
        sessionKey,
        via,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 会话种类（**映射表优先、旧前缀兜底**，2026-10-24 P1-4）。
   * @param {unknown} sessionKey
   * @returns {'group'|'private'|'unknown'}
   */
  kindOf(sessionKey) {
    if (this.resolver !== null && typeof this.resolver.kindOf === 'function') {
      try {
        const kind = this.resolver.kindOf(sessionKey);
        if (kind === 'group' || kind === 'private' || kind === 'unknown') return kind;
      } catch {
        /* 解析器出问题 ⇒ 回退旧前缀 */
      }
    }
    return sessionKindOf(sessionKey);
  }

  /**
   * 会话键 → chatId（映射表反查，回退旧前缀）。认不出 ⇒ `''`。
   * @param {unknown} sessionKey
   * @returns {string}
   */
  chatIdOf(sessionKey) {
    if (this.resolver !== null && typeof this.resolver.chatIdOf === 'function') {
      try {
        const chatId = this.resolver.chatIdOf(sessionKey);
        if (typeof chatId === 'string' && chatId !== '') return chatId;
      } catch {
        /* 回退 */
      }
    }
    return chatIdFromSessionKey(sessionKey);
  }

  /**
   * 会话键 → 私聊对方 QQ 号（映射表优先；群/认不出 ⇒ `''`）。
   * @param {unknown} sessionKey
   * @returns {string}
   */
  userIdOf(sessionKey) {
    if (this.resolver !== null && typeof this.resolver.userIdOf === 'function') {
      try {
        const userId = this.resolver.userIdOf(sessionKey);
        if (typeof userId === 'string' && userId !== '') return userId;
      } catch {
        /* 回退 */
      }
    }
    const m = /^(?:qq|onebot)-private-(\d+)$/.exec(String(sessionKey ?? '').trim());
    return m === null ? '' : m[1];
  }

  restrictGroupTools(agentCtx, sessionKey, via = 'setup') {
    if (this.kindOf(sessionKey) !== 'group') return false;

    const deny = this.denyToolsInGroup;
    if (deny.length === 0) {
      this.log('debug', `群会话 ${sessionKey} 没有配置要禁用的工具，不做限制`, {});
      return false;
    }

    const tools = agentCtx?.tools;
    if (tools === undefined || tools === null || typeof tools.restrict !== 'function') {
      this.log(
        'warn',
        `群会话 ${sessionKey} 的工具限制没有生效：这个 agent 作用域上没有 tools.restrict` +
          '（DSH 版本不匹配？群会话的 shell 权限没被收掉）',
        { sessionKey, via, deny: deny.slice() },
      );
      return false;
    }

    try {
      // 传副本：名单是我们长期持有的状态，不该交给外部去改。
      tools.restrict({ deny: deny.slice() });
      this.log('info', `群会话已禁用工具: ${deny.join(', ')}`, {
        sessionKey,
        via,
        deny: deny.slice(),
      });
      return true;
    } catch (error) {
      // ⚠️ 一种失败是**预期内**的：名单里某个工具**根本没在这个 agent 上注册**
      // （`names unknown global tool "…"`）。`restrict` 只能收 global 层 + 祖先层
      // 注册的名字，所以给"preset 本来就把它拿掉了"的会话硬收，就会撞上这个。
      // 正常路径已经由 `groupToolBackstop` 避开了；还走到这里，多半是有人把
      // `groupAgentPreset` 显式覆盖成了另一份不含这些工具的 preset ——
      // 那把 `denyToolsInGroup` 配成 `[]` 就是明确表态。
      this.log(
        'warn',
        `群会话工具限制失败，会话照常建立（本轮不受影响）: ${error instanceof Error ? error.message : String(error)}`,
        { sessionKey, via, deny: deny.slice() },
      );
      return false;
    }
  }

  /**
   * 收掉群会话继承的**宿主全局工具族**（ops / browser / screen_view）。
   *
   * ## 为什么单独一个方法，不并进 `restrictGroupTools`
   *
   * `restrictGroupTools` 是 `pwsh` 的**兜底**，只在"没挂推导出来的群 preset"时才跑；
   * 而这一族在全局层，跟 preset 无关 —— 正常路径（群会话挂 `gugu-lite`）也必须收。
   * 两件事的触发条件不同，混在一起会让"什么时候跑"变成一团。
   *
   * ## 名字为什么从 `tools.schemas()` 现取，而不是写死
   *
   * `restrict()` 会**一次校验全部名字**：只要有一个名字不是「全局层 + 祖先层」已注册的，
   * 整条限制就失败 —— 连本该收掉的那几个也一起失效。写死名单等于把"浏览器哪天改名/
   * 换工具集"变成一次静默的**全量放开**。现取 + 前缀匹配的代价只是"没注册的自然跳过"。
   *
   * ## 幂等
   *
   * 限制是挂在 agentCtx 上的 effect，随 ctx 销毁而消失；台账里记一笔，
   * 同一个 ctx 上不重复叠（`equipLiveAgent` / `ensure` 都可能再走进来）。
   *
   * ⚠️ 本方法**绝不抛异常**（它在建会话的 setup 路径上）。
   *
   * @param {any} agentCtx agent 作用域的 ctx
   * @param {string} sessionKey 会话键，形如 `qq-group-30000011`
   * @param {string} [via] `setup` / `reuse`，只进日志
   * @returns {boolean} 是否真的挂上了这次限制
   */
  restrictGroupHostTools(agentCtx, sessionKey, via = 'setup') {
    if (this.kindOf(sessionKey) !== 'group') return false;

    const tools = agentCtx?.tools;
    if (tools === undefined || tools === null || typeof tools.restrict !== 'function') return false;

    const ledger = registrationLedger(agentCtx);
    if (ledger !== null && ledger.hostToolsDenied === true) return false;

    let deny = [];
    try {
      if (typeof tools.schemas !== 'function') {
        // 宿主版本没有 `tools.schemas()`：不静默跳过 —— 那会让"写了但没生效"变成常态。
        this.log(
          'warn',
          `群会话 ${sessionKey} 的宿主没有 tools.schemas()，宿主工具族（ops/browser/screen_view）没收紧`,
          { sessionKey, via },
        );
        return false;
      }
      const schemas = tools.schemas(agentCtx);
      deny = pickGroupDeniedHostTools(
        (Array.isArray(schemas) ? schemas : []).map((schema) => schema?.name),
      );
    } catch (error) {
      this.log(
        'warn',
        `群会话 ${sessionKey} 读不到可见工具表，宿主工具族没收紧: ${error instanceof Error ? error.message : String(error)}`,
        { sessionKey, via },
      );
      return false;
    }
    if (deny.length === 0) {
      // 不是故障：要么这些插件没挂，要么已经收过了。只在 debug 里留痕。
      this.log('debug', `群会话 ${sessionKey} 没有可见的宿主工具族（ops/browser/screen_view），不用收`, {
        sessionKey,
        via,
      });
      return false;
    }

    try {
      // 传副本：名单是本次算出来的，不该交给宿主去持有。
      tools.restrict({ deny: deny.slice() });
      if (ledger !== null) ledger.hostToolsDenied = true;
      this.log('info', `群会话已禁用宿主工具族（ops/browser/screen_view）: ${deny.join(', ')}`, {
        sessionKey,
        via,
        deny: deny.slice(),
      });
      return true;
    } catch (error) {
      this.log(
        'warn',
        `群会话宿主工具限制失败，会话照常建立（本轮不受影响）: ${error instanceof Error ? error.message : String(error)}`,
        { sessionKey, via, deny: deny.slice() },
      );
      return false;
    }
  }

  /**
   * 按需加载（2026-11-04）：把「不常驻」的工具收进目录，模型要用时用 `load_tools` 取回。
   *
   * ## 它省的是什么
   *
   * 工具 schema 是每轮都带的那一大坨（本机实测 118 个 / 100,201 字 ≈ 3.5 万 token）。
   * 这一族平时只留一行「名字 — 一句话」：60 字截断的目录实测只有 8,381 字，**原来的 8%**。
   *
   * ## 为什么用 restrict，而不是注销注册
   *
   * 这些工具是**别的插件全局注册**的，本插件没有权力注销。`restrict` 正好是
   * 「按 agent 收掉继承来的工具」的官方口子，而且**返回 disposer**（放开要重新挂一层）。
   * 群会话那条 deny 是**独立的另一层**，两层取交集 ⇒ 群里收掉的浏览器/ops
   * 不会因为这里 load 一次就回来。
   *
   * ## 顺序
   *
   * 必须在 `groupToolBackstop`（群会话的硬性收口）**之后**跑：目录是从"当前可见"里挑的，
   * 先收后编目才不会把群里已经禁掉的工具又写进目录。
   *
   * ## 幂等
   *
   * 状态挂在 agentCtx 的台账上（随 ctx 生灭）；`applied` 之后不再重来。
   *
   * ⚠️ 本方法绝不抛异常（跑在建会话的路径上）。
   *
   * @param {any} agentCtx agent 作用域的 ctx
   * @param {string} sessionKey 会话键
   * @param {string} [via] `setup` / `reuse`，只进日志
   * @returns {boolean} 是否真的启用了
   */
  setupOnDemandTools(agentCtx, sessionKey, via = 'setup') {
    const prefixes = this.onDemandPrefixes;
    if (!Array.isArray(prefixes) || prefixes.length === 0) return false;

    const tools = agentCtx?.tools;
    const ledger = registrationLedger(agentCtx);
    if (ledger === null) return false;
    if (ledger.onDemand !== undefined && ledger.onDemand !== null && ledger.onDemand.applied === true) return false;

    if (
      tools === undefined || tools === null
      || typeof tools.schemas !== 'function'
      || typeof tools.restrict !== 'function'
      || typeof tools.register !== 'function'
    ) {
      this.log('warn', '按需加载没有启用：这个 agent 作用域缺少 tools.schemas/restrict/register', { sessionKey, via });
      return false;
    }

    let visible = [];
    try {
      const schemas = tools.schemas(agentCtx);
      visible = (Array.isArray(schemas) ? schemas : [])
        .filter((s) => s !== null && typeof s === 'object' && typeof s.name === 'string' && s.name !== '')
        .map((s) => ({
          name: s.name,
          description: typeof s.description === 'string' ? s.description : '',
          parameters: s.parameters,
        }));
    } catch (error) {
      this.log('warn', '按需加载没有启用：读不到可见工具表', {
        sessionKey,
        via,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    const names = pickOnDemandTools(visible.map((d) => d.name), prefixes);
    if (names.length === 0) {
      this.log('debug', '按需加载：没有匹配前缀的可见工具，跳过', { sessionKey, via, prefixes });
      return false;
    }

    // ⚠️ 真机踩过（2026-11-05）：`restrict` 只收「全局层 + 祖先层」，**agent 自己那层注册的
    // 收不到**（`dsh-experimental-tool-agent-team` 就是在 `agent.ctx.tools.register`）。
    // 而 `restrict` 是**一次校验全部名字**：名单里混进一个收不到的，整条限制就失败。
    // ⇒ 先逐个探测，只把收得到的写进 base；收不到的保持常驻（它们本来也在可见表里）。
    const probe = partitionRestrictable(tools, agentCtx, names);
    if (probe.blocked.length > 0) {
      this.log(
        'info',
        `按需加载：${probe.blocked.length} 个工具注册在 agent 自己的层，restrict 收不到，保持常驻`,
        { sessionKey, via, names: probe.blocked.slice() },
      );
    }
    const base = probe.ok;
    if (base.length === 0) {
      this.log('warn', '按需加载没有启用：匹配到的工具都收不到（都注册在 agent 自己的层）', { sessionKey, via });
      return false;
    }

    const wanted = new Set(base);
    const definitions = new Map();
    for (const def of visible) if (wanted.has(def.name)) definitions.set(def.name, def);
    const state = { applied: false, base: base.slice(), blocked: new Set(probe.blocked), definitions, loaded: new Set(), dispose: null, catalogChars: 0 };

    // 目录：**稳定文本**。别把 loaded 状态写进去 —— 那会让系统提示每轮都变、吃不到前缀缓存。
    //
    // ⚠️ 目录是这套机制的**前提**，不是装饰：挂不上目录就绝不能收工具，否则模型既看不见
    // 工具、也不知道它们存在 —— 那比不改还糟。所以下面两个失败分支都直接 return。
    const catalog = renderToolCatalog([...definitions.values()]);
    const sp = agentCtx.systemPrompt;
    if (sp === null || sp === undefined || typeof sp.section !== 'function') {
      this.log('warn', '按需加载没有启用：这个 agent 作用域上没有 systemPrompt.section，目录没有出处', { sessionKey, via });
      return false;
    }
    try {
      const disposeSection = sp.section({ name: ON_DEMAND_SECTION, order: ON_DEMAND_SECTION_ORDER, text: catalog });
      ledger.sections.set(ON_DEMAND_SECTION, typeof disposeSection === 'function' ? disposeSection : null);
      state.catalogChars = catalog.length;
    } catch (error) {
      this.log('warn', '按需加载没有启用：目录段挂不上（模型会看不到目录）', {
        sessionKey,
        via,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    /** 按「已加载」重算 deny 层。可能抛（restrict 会校验名字），由调用方接。 */
    const reloadRestriction = () => {
      if (typeof state.dispose === 'function') {
        const lift = state.dispose;
        state.dispose = null;
        lift();
      }
      const deny = state.base.filter((name) => !state.loaded.has(name));
      state.dispose = deny.length > 0 ? tools.restrict({ deny }) : null;
    };

    try {
      const disposeTool = tools.register({
        name: ON_DEMAND_TOOL_NAME,
        description:
          '加载「按需工具」目录里的工具定义。当你要用目录中列出、但当前工具列表里没有的工具时，先调用它：names 填目录里的名字（可一次多个），加载后再正常调用。',
        parameters: {
          type: 'object',
          properties: {
            names: {
              type: 'array',
              items: { type: 'string' },
              description: '要加载的工具名（取自按需工具目录），可以一次给多个',
            },
          },
          required: ['names'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
            required: ['ok', 'text'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        async execute(args) {
          const asked = normalizeToolNames(args?.names);
          if (asked.length === 0) {
            return { ok: false, text: 'names 不能为空：要从目录里加载哪个工具？' };
          }
          const unknown = asked.filter((name) => !state.definitions.has(name));
          if (unknown.length > 0) {
            return { ok: false, text: `没有这些工具：${unknown.join(', ')}。只能加载目录里列出的名字。` };
          }
          const fresh = asked.filter((name) => !state.loaded.has(name));
          for (const name of fresh) state.loaded.add(name);
          if (fresh.length > 0) {
            try {
              reloadRestriction();
            } catch (error) {
              return {
                ok: false,
                text: `加载失败（工具集没能更新）：${error instanceof Error ? error.message : String(error)}`,
              };
            }
          } else {
            // 全都已经加载过：只回一行收执，**不再吐一遍 schema**（那是纯浪费上下文，
            // 工具定义本来就已经在工具列表里了）。
            return { ok: true, text: `这几个工具已经加载过，可直接调用：${asked.join(', ')}` };
          }
          // 只给**这次新加载**的那些回 schema；已经载过的只列名字（省上下文）。
          const blocks = fresh.map((name) => {
            const def = state.definitions.get(name);
            return `## ${name}\n${oneLineOf(def?.description ?? '', 200)}\n参数 schema：\n${JSON.stringify(def?.parameters ?? {})}`;
          });
          const already = asked.filter((name) => !fresh.includes(name));
          return {
            ok: true,
            text: `已加载：${fresh.join(', ')}。从现在起可以直接调用，参数如下。\n\n${blocks.join('\n\n')}`
              + (already.length > 0 ? `\n\n（${already.join(', ')} 之前就加载过，不再重复贴 schema。）` : ''),
          };
        },
      });
      ledger.tools.set(ON_DEMAND_TOOL_NAME, typeof disposeTool === 'function' ? disposeTool : null);
    } catch (error) {
      this.log('warn', `按需加载：${ON_DEMAND_TOOL_NAME} 注册失败`, {
        sessionKey,
        via,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    try {
      reloadRestriction();
    } catch (error) {
      this.log('warn', '按需加载：收口失败（工具仍然全部可见）', {
        sessionKey,
        via,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    state.applied = true;
    state.refreshLeft = 3;
    ledger.onDemand = state;
    this.log(
      'info',
      `按需加载已启用：${base.length} 个工具收进目录（目录 ${catalog.length} 字），常驻 ${visible.length - base.length} 个`,
      { sessionKey, via, names: base.slice(), blocked: probe.blocked.slice(), catalogChars: catalog.length },
    );
    return true;
  }

  /**
   * 补编目（2026-11-04，真机踩出来的）：有些工具插件是在 **agent 创建之后**才注册的。
   *
   * 实测：QQ 会话第一次挂上按需加载时，`schedule_*` / `team_*` / `job_*` 这 9 个
   * 不在挂载那一刻的可见表里，于是既没进目录、也没被收 —— 它们比常驻还常驻。
   * 每次对话开头补一次：把"新出现、且匹配前缀"的工具加进目录并收口。
   *
   * 只在前几轮做（`refreshLeft`）：每次都克隆一遍全量 schema 不便宜，而工具集在
   * 第一两轮之后不会再变。补到一次"没有新增"就停。
   *
   * ⚠️ **目录必须先更新再收口**：只收不编目 = 模型看不见也不知道，比不改还糟。
   * 目录变了会让系统提示的前缀缓存失效一次 —— 这是必要的代价（收一次，之后稳定）。
   *
   * @returns {boolean} 是否补进了新工具
   */
  refreshOnDemandTools(agentCtx, sessionKey) {
    const ledger = registrationLedger(agentCtx);
    const state = ledger?.onDemand;
    if (state === undefined || state === null || state.applied !== true) return false;
    // 老状态（上一个插件实例建的）没有这些字段 —— 补上，否则热重载之后这条永远不跑。
    if (!(state.blocked instanceof Set)) {
      state.blocked = new Set();
      state.refreshLeft = 3;
    }
    if (typeof state.refreshLeft !== 'number') state.refreshLeft = 3;
    if (state.refreshLeft <= 0) return false;

    const tools = agentCtx?.tools;
    if (
      tools === undefined || tools === null
      || typeof tools.schemas !== 'function'
      || typeof tools.restrict !== 'function'
    ) return false;

    state.refreshLeft -= 1;

    let schemas = null;
    try {
      schemas = tools.schemas(agentCtx);
    } catch {
      return false;
    }
    const defs = (Array.isArray(schemas) ? schemas : [])
      .filter((s) => s !== null && typeof s === 'object' && typeof s.name === 'string' && s.name !== '')
      .map((s) => ({
        name: s.name,
        description: typeof s.description === 'string' ? s.description : '',
        parameters: s.parameters,
      }));
    const extraAll = pickOnDemandTools(defs.map((d) => d.name), this.onDemandPrefixes)
      .filter((name) => !state.base.includes(name));
    if (extraAll.length === 0) {
      // 稳定了：不再试（省掉每轮一次全量 schema 克隆）。
      state.refreshLeft = 0;
      return false;
    }

    const candidates = extraAll.filter((name) => !state.blocked.has(name));
    if (candidates.length === 0) {
      state.refreshLeft = 0;
      return false;
    }

    // 只收 restrict 收得到的（全局层 + 祖先层）；agent 自己那层注册的收不了，
    // 而且**一个收不到就整条失败** —— 所以逐个探测，收不到的记进 blocked，以后不再试。
    const probe = partitionRestrictable(tools, agentCtx, candidates);
    for (const name of probe.blocked) state.blocked.add(name);
    if (probe.blocked.length > 0) {
      this.log('info', `按需加载：${probe.blocked.length} 个工具注册在 agent 自己的层，restrict 收不到，保持常驻`, {
        sessionKey,
        names: probe.blocked.slice(),
      });
    }
    const accepted = probe.ok;
    if (accepted.length === 0) {
      state.refreshLeft = 0;
      return false;
    }

    // ① 先扩目录（定义现取）
    const acceptedSet = new Set(accepted);
    for (const def of defs) if (acceptedSet.has(def.name)) state.definitions.set(def.name, def);
    const catalog = renderToolCatalog([...state.definitions.values()]);
    const sp = agentCtx.systemPrompt;
    if (sp !== null && sp !== undefined && typeof sp.section === 'function') {
      try {
        const old = ledger.sections.get(ON_DEMAND_SECTION);
        if (typeof old === 'function') old();
        ledger.sections.set(
          ON_DEMAND_SECTION,
          sp.section({ name: ON_DEMAND_SECTION, order: ON_DEMAND_SECTION_ORDER, text: catalog }),
        );
        state.catalogChars = catalog.length;
      } catch (error) {
        // 目录没换成功 ⇒ 一个都别收（只收不编目是最坏的那条路）。
        for (const name of accepted) state.definitions.delete(name);
        this.log('warn', '按需加载：补编目失败，这批工具保持常驻', {
          sessionKey,
          names: accepted.slice(),
          error: error instanceof Error ? error.message : String(error),
        });
        state.refreshLeft = 0;
        return false;
      }
    } else {
      for (const name of accepted) state.definitions.delete(name);
      state.refreshLeft = 0;
      return false;
    }

    // ② 再收口（把新名字并进 base，重挂 deny）
    for (const name of accepted) state.base.push(name);
    try {
      if (typeof state.dispose === 'function') {
        const lift = state.dispose;
        state.dispose = null;
        lift();
      }
      const deny = state.base.filter((name) => !state.loaded.has(name));
      state.dispose = deny.length > 0 ? tools.restrict({ deny }) : null;
    } catch (error) {
      this.log('warn', '按需加载：补收口失败（这批工具仍可见）', {
        sessionKey,
        names: accepted.slice(),
        error: error instanceof Error ? error.message : String(error),
      });
      state.refreshLeft = 0;
      return false;
    }

    this.log('info', `按需加载：补收了 ${accepted.length} 个后注册的工具（目录 ${catalog.length} 字）`, {
      sessionKey,
      names: accepted.slice(),
    });
    return true;
  }

  /**
   * 这个会话该挂的 preset 注册名。
   *
   * ⚠️ **是「注册名」（`agentPresets.register()` 里 `config.id` 那个值），
   * 不是 loader 条目 id。** 配置里 `agentPreset: gugu` 对应的是 preset 的
   * `config.id: gugu`，而它在 `cordis.patch.yml` 里的条目 id 是 `preset-gugu`
   * —— 两者长得像但不是一回事。搞错的代价是**静默回退到 standard**
   * （`mount()` 抛 `Unknown agent preset`，会话以 "You are a coding agent" 的口吻回话）。
   *
   * 判据在源码里：`AgentPresetRegistry.retain(id)` 拿 id 去 `this.definitions.get(id)`，
   * 而 `definitions` 的键是 `register(definition)` 时的 `definition.id`。
   *
   * @param {string} sessionKey
   * @returns {string} 空串 = 这个会话不挂 preset
   */
  sessionPreset(sessionKey) {
    return resolveSessionPreset({
      sessionKey,
      // 2026-10-24（P1-4）：种类先问映射表解析器（表优先、旧前缀兜底），
      // 这样 uuid 之后群会话仍然挂 `-lite` 那份 preset。
      kind: this.kindOf(sessionKey),
      agentPreset: this.config?.agentPreset,
      groupAgentPreset: this.groupAgentPreset,
    });
  }

  /**
   * 读一个活着的 agent **当前**跑的 preset（读 live 作用域链，不读 header）。
   *
   * 为什么读 live：header 记的是**建会话那一刻**的值，会话在空白期换过 preset 的话
   * 它已经过时。`dsh-subagent` 的 `childSessionMeta` 就是因为这个才去读 live 的
   * （源码原话：「read from the parent's LIVE scope chain rather than from its header」）。
   *
   * @param {any} agentCtx
   * @returns {string|null} preset 注册名；没有/读不到则 null
   */
  livePresetOf(agentCtx) {
    try {
      const presets = this.ctx?.agentPresets;
      if (presets === undefined || presets === null) return null;
      if (typeof presets.composedPreset !== 'function') return null;
      const id = presets.composedPreset(agentCtx);
      return typeof id === 'string' && id !== '' ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * 群会话的工具兜底（`restrict`）现在还要不要挂。
   *
   * ⚠️ **`restrict()` 只收得了「全局层 + 祖先层」注册的工具名。**
   * `@deepseek-ai/dsh-tools` 的 `view(scope)` 里，`restrictableNames` 只收 `inherited`
   * —— global 层，加作用域链上**除自己以外**的每一层；agent 自己那层注册的工具
   * **故意不收**（源码注释：「A restriction filters what a scope inherits … and never
   * what its OWN layer registers」）。而 **preset 的工具正落在祖先层**（同一个注释：
   * 「Once presets moved them onto the agent plane they became an ANCESTOR contribution」）。
   *
   * 本部署里全局那条 `tool-pwsh` 是 `disabled: true`（`cordis.yml:204-206`），
   * 根本没注册 —— 所以 `pwsh` 之所以可收，**只是因为 `gugu` preset 注册了它**。
   *
   * ⇒ 群会话一旦挂上**不含 `tool-pwsh`** 的 preset，`restrict({ deny:['pwsh'] })` 必然以
   * `names unknown global tool "pwsh"` 失败。那**不是故障**（工具本来就不在这个 agent 上，
   * 正是我们要的结果），但 `restrictGroupTools` 会为它打一条 warn：每个群会话一条，
   * 而且文案说的是"限制失败"，会把人往错的方向带。
   *
   * ⇒ 所以：**挂上了「推导出来的那份群 preset」就不兜**（兜的是空气）；其余一律照旧兜 ——
   * 那包括「群 preset 挂不上、退回了私聊那份」「显式覆盖成别的 preset」「复用了一个
   * 别处建的 agent」三种。`restrict` 因此从「每次都挂的主控制」变成「保险丝」。
   *
   * **主控制是 preset 本身**，而且它比 restrict 强的地方正是关键：restrict 管不到子会话，
   * preset 管得到。
   *
   * ⚠️ 判据用的是**推导出来的那个名字**（`<私聊 preset>-lite`），不是"挂的名字 == 想挂的名字"。
   * 因为只有推导出来的那份，内容才是**代码知道的**（"恰好等于私聊那份减去三个工具行"
   * 这条不变式由 `test/preset-config.test.mjs` 盯着）。显式覆盖成别的 preset 时，
   * 代码不知道它有没有那些工具 —— 那就照旧兜：`restrict` 收不了的名字会报错并打 warn，
   * **方向是安全的那一侧**（宁可多一条 warn，也别漏收口）。真遇到这种情况，
   * 把 `denyToolsInGroup` 配成 `[]` 即可明确表态"这份 preset 已经有了"。
   *
   * 代价（说清楚）：preset 的**名字**成了"这几个工具不在"的凭据。要是哪天有人把
   * `tool-pwsh` 加回 `gugu-lite`，这条路就不会再兜底了。这与"子会话会继承 preset"
   * 是同一个信任面 —— 子会话本来就无条件信任这份 preset，兜底能护的只有根会话。
   *
   * @param {any} agentCtx
   * @param {string} sessionKey
   * @param {string} [via] `setup` / `reuse`，只进日志
   * @param {string|null} [presetId] 这个 agent 现在跑的 preset 注册名（读不到给 null）
   * @returns {boolean} 是否真的挂了兜底
   */
  groupToolBackstop(agentCtx, sessionKey, via = 'setup', presetId = null) {
    if (this.kindOf(sessionKey) !== 'group') return false;
    // 2026-11-04：ops / browser / screen_view 来自**全局层**，preset 拿不掉 ——
    // 不管挂没挂 `-lite` 都要收这一次（和下面 pwsh 的兜底是两个独立的问题）。
    const hostDenied = this.restrictGroupHostTools(agentCtx, sessionKey, via);
    const rawBase = this.config?.agentPreset;
    const base = typeof rawBase === 'string' ? rawBase.trim() : '';
    const derived = base === '' ? '' : `${base}${GROUP_PRESET_SUFFIX}`;
    if (derived !== '' && presetId === derived) {
      this.log(
        'debug',
        `群会话 ${sessionKey} 已经在 preset ${presetId} 上，不再叠 restrict 兜底（工具本来就不在）`,
        { sessionKey, via, preset: presetId },
      );
      return hostDenied;
    }
    return this.restrictGroupTools(agentCtx, sessionKey, via) || hostDenied;
  }

  /**
   * 挂这个会话该挂的 preset，失败时退回「私聊那份」。
   *
   * 为什么失败要退回私聊那份、而不是什么都不挂：什么都不挂 = 只剩 global 层 =
   * 挂上 standard，"You are a coding agent" 的口吻（实测踩过）。退回私聊那份至少
   * 人格是对的，代价是那几个危险工具又回来了 —— 所以退的时候打一条**说清后果**的 warn：
   * 那意味着子会话也会重新拿到它们。
   *
   * @param {any} agentCtx agent 作用域的 ctx
   * @param {string} sessionKey
   * @returns {Promise<string|null>} 真正挂上的 preset 注册名；没挂返回 null
   */
  async mountSessionPreset(agentCtx, sessionKey) {
    const presets = this.ctx?.agentPresets;
    if (presets === undefined || presets === null || typeof presets.mount !== 'function') return null;
    const wanted = this.sessionPreset(sessionKey);
    if (wanted === '') return null;
    const rawBase = this.config?.agentPreset;
    const base = typeof rawBase === 'string' ? rawBase.trim() : '';
    try {
      await presets.mount(agentCtx, wanted);
      if (wanted === base) {
        this.log('debug', `agent joined preset ${wanted}`, { sessionKey });
      } else {
        this.log('info', `群会话 ${sessionKey} 挂在 preset ${wanted}（私聊那份是 ${base || '<未配>'}）`, {
          sessionKey,
          preset: wanted,
          privatePreset: base,
        });
      }
      return wanted;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (wanted === base) {
        this.log('warn', `preset 挂载失败（回退到 global 层）: ${reason}`, { sessionKey, preset: wanted });
        return null;
      }
      this.log(
        'warn',
        `群会话 preset ${wanted} 挂不上（${reason}），退回私聊那份 ${base || '<未配>'}。` +
          '⚠️ 退回之后群会话又带着那几个危险工具了，而且**子会话会继承这一份** —— ' +
          '请检查 profile 里有没有定义这个 preset（`cordis.patch.yml` 的 `- id: preset-…`）。',
        { sessionKey, preset: wanted, privatePreset: base },
      );
      try {
        await presets.mount(agentCtx, base);
        return base;
      } catch (retryError) {
        this.log(
          'warn',
          `preset 挂载失败（回退到 global 层）: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          { sessionKey, preset: base },
        );
        return null;
      }
    }
  }

  /**
   * 解析这个会话该用的人格覆盖（2026-10-21）。
   *
   * - 返回 `null` ⇒ 没有覆盖层（用 `this.persona`，与接线前逐字节一致）；
   * - 返回 `{text, overridden}` ⇒ 合并后的人格正文 + 生效了哪些字段。
   *
   * **绝不抛**：它跑在每轮提示词组装里（`section.text` 是函数）。
   *
   * @param {string} sessionKey
   * @returns {{text: string, overridden: string[]}|null}
   */
  resolvedPersona(sessionKey) {
    if (this.personaForSession === null) return null;
    try {
      const got = this.personaForSession(sessionKey);
      if (got === null || typeof got !== 'object') return null;
      if (typeof got.text !== 'string' || got.text === '') return null;
      const overridden = Array.isArray(got.overridden)
        ? got.overridden.filter((key) => typeof key === 'string')
        : [];
      return { text: got.text, overridden };
    } catch (error) {
      this.log('warn', '人格覆盖解析失败（这一轮按全局人格处理）', {
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 这个会话此刻该用的 persona 正文 = **按会话覆盖后的人格 +（有的话）一句当前心情**。
   *
   * ## 为什么是「函数」而不是「固定串」（2026-10-15）
   *
   * 心情是**每轮都可能变**的动态状态（`mood.mjs` 收到消息时按概率重写）。
   * `dsh-system-prompt` 明确支持 `section.text` 是函数：
   * `lib/index.js:342` —— `typeof section.text === "function" ? section.text(context) : section.text`，
   * 而它跑在**每次 assemble**（每轮组装提示词）里 ⇒ 动态、且**不累积**
   * （system prompt 每轮重建，不像 `agent.followup()` 那条会永久留在历史里）。
   *
   * ## 三条硬约束
   *
   * 1. **绝不抛**：它挂在提示词组装路径上（`setup` 注册、每轮调用）——
   *    抛出去 = 这一轮连回复都产不出来。所以整段包 try/catch，拿不到心情就当没有。
   * 2. **没有心情 ⇒ 逐字节等于人格原文**（`[mood] enabled=false`、还没生成过、
   *    或 chatId 反推不出来，全都走这条路）—— 与接线前**完全一致**。
   * 3. **会话键 → chatId 必须用 `routing.mjs` 里现成的逆运算**（`chatIdFromSessionKey`），
   *    不自己发明一套。反推失败（典型：`dmRouting=main` 时的 `session-<uuid>`）⇒ 空串
   *    ⇒ 一个字都不加 —— **宁可这条会话没有心情，也不能把 A 群的心情显示给 B 群**。
   *
   * @param {string} sessionKey 形如 `qq-group-30000013`（**不是** chatId）
   * @returns {string} 提示词里那一段的正文
   */
  personaTextFor(sessionKey) {
    // 2026-10-21：先看这个会话有没有覆盖层；没有就用全局那份（逐字节不变）。
    const resolved = this.resolvedPersona(sessionKey);
    const base = resolved !== null
      ? resolved.text
      : (typeof this.persona === 'string' ? this.persona : '');
    if (base === '' || this.moodFor === null) return base;
    // 2026-10-24（P1-4）：映射表反查优先；uuid 会话靠它才能继续拿到 chatId。
    const chatId = this.chatIdOf(sessionKey);
    if (chatId === '') return base;
    let mood = '';
    try {
      mood = String(this.moodFor(chatId) ?? '').trim();
    } catch (error) {
      // 心情解析失败 = 当作"没有心情"。**不能**让 persona 注册/组装跟着失败。
      this.log(
        'debug',
        `读取心情失败（按没有心情处理）: ${error instanceof Error ? error.message : String(error)}`,
        { sessionKey, chatId },
      );
      return base;
    }
    if (mood === '') return base;
    // ⚠️ 心情是**模型生成的任意文本**，而这一段随后会过 `dsh-system-prompt` 的
    // `interpolate()`（`renderPrompt`）：里面出现 `{{名字}}` 会被当成**提示词变量**，
    // 未知变量**直接抛**（`lib/index.js:169`）⇒ 整轮提示词组装失败。
    // 所以在这一层把 `{{` / `}}` 拆开：既不让它触发解析，也读得出来（`{ {`）。
    const oneLine = mood
      .replace(/\s+/g, ' ')
      .replace(/\{\{/g, '{ {')
      .replace(/\}\}/g, '} }');
    return `${base}\n\n（你现在的心情：${oneLine}）`;
  }

  /**
   * 把「人格（+心情）」注册进某个 agent 的 system prompt 作用域。
   *
   * ## 为什么要单独抽成一个方法（2026-10-15，线上事故驱动）
   *
   * 它原来**只写在 `setup` 回调里**，而 `setup` **只有创建/恢复 agent 时才跑**。
   * `ensure()` 还有一条【复用已有 agent】的路（`findLiveAgent` 命中）—— 那条路
   * **不经过 `setup`**。于是出现了这个具体后果：
   *
   * ```
   * 插件热重载（改一次 src/ 就发生一次）
   *   ⇒ 旧的 agentCtx 被销毁，挂在它上面的 `systemPrompt.section()` 这个 **effect** 被 dispose
   *     （`dsh-system-prompt` L242：`this.layers.effect(this.ctx, (layer) => layer.sections.insert(...))`）
   *   ⇒ 那个会话的 persona section **消失**
   *   ⇒ 但 agent 本体还活着 ⇒ 下一次 ensure 走【复用】分支 ⇒ 不会重新注册
   *   ⇒ ⇒ 该会话从此【没有 persona】，露出 preset 里那句兜底指针文本
   * ```
   *
   * **2026-10-15 实测到的现场**：`qq-group-30000011` 17:06 那份 system prompt 5967 字符、
   * 人格段落一个都没有、开头就是预设的接线文本
   * （`（人格文本已迁移到 qq-gugu.toml 的 [personality] 段 …）`），
   * 而同进程的 `qq-group-30000012` 16:22 那份 6912 字符、人格与心情都在。
   * **⇒ 差别只在"那个 agent 是新建的还是复用的"。**
   *
   * ⚠️ 这**不是**某次改动引入的：旧代码的 `text` 虽然是固定串，effect 一样挂在 agentCtx 上，
   * 热重载后同样会被摘掉。**只是它一直没被看见。**
   *
   * ## 幂等性（2026-10-20 重写）
   *
   * `dsh-system-prompt` 对**同一层里的重名 section 会抛**
   * （"duplicates within one layer … throw"）。而 agent 现在挂在 `ctx.root` 上、
   * **跨插件热重载存活**，所以"同一个 agentCtx 上二次注册"是常态而不是意外。
   *
   * 两种处理，按能不能拿到上一代的 disposer 分：
   *   - **拿得到**（本方法上一代留下的台账）⇒ 先撤销、再按**本实例的闭包**重注册。
   *     section 的 `text` 是闭包（人格 / 心情 / 知识都从 `this` 取），直接跳过的话
   *     内容会永远冻在旧实例上 —— **改 `qq-gugu.toml` 不再生效**，所以必须替换。
   *   - **拿不到**（旧代码没留台账，比如这次改动之前的注册）⇒ 宿主报"重复"⇒ 降级成
   *     **debug**，旧那段留着（不为空），下次重载再试。别的错照旧 warn。
   *
   * @param {object} ctx 目标 agent 的 ctx
   * @param {string} sessionKey 形如 `qq-group-30000013`
   * @param {string} [via] `setup` / `reuse`，只进日志便于定位
   * @returns {boolean} 是否至少写进了一段（全被跳过 / 出错时为 false）
   */
  /**
   * 给一个**已经在跑**的 agent 补齐本插件应当给它的全部装备。
   *
   * ## 为什么需要这个
   *
   * 工具限制、三个工具（发 QQ / 看表情包 / 发语音）与人格，原本只在 `setup` 里注册，
   * 而 `setup` 只在**插件自己发起的** `createAgent` / `loop.resume` 路径上被调用；
   * `ensure()` 的收养分支虽然补过一次，但那条路只在 **QQ 消息派发**时才走。
   *
   * ⇒ 宿主侧任何一种"自己把会话捡起来"的动作（在 GUI 里打字、DSH 重启后恢复会话）
   *   都会绕过这两条路，于是那一轮既没有工具、也没有人格。
   *   实测现场：2026-10-23 的那一轮，请求里工具数 103（正常 106），
   *   system prompt 13244 字符（正常约 16700）且露出 preset 的兜底接线文本。
   *
   * ⇒ 所以把这段补注册抽出来，交给"任何会话事件"这个不依赖派发路径的时机去调。
   *
   * ## 幂等性
   *
   * 四个注册各自带台账判重（重复调用安全），`applyPersona` 是撤销后重注册。
   * agent 尚未创建时返回 `false`，由调用方决定是否另外补。
   *
   * @param {string} sessionKey 会话键，形如 `qq-private-30000001`
   * @param {string} [via] 只进日志与台账，用于定位是谁补的
   * @returns {boolean} 是否真的补了一次（`false` 表示当前没有活着的 agent）
   */
  equipLiveAgent(sessionKey, via = 'event') {
    const existing = this.findLiveAgent(sessionKey);
    if (existing === undefined) return false;
    // 群会话的工具收口（理由见 `groupToolBackstop` 自己的说明）。
    this.groupToolBackstop(existing.ctx, sessionKey, via, this.livePresetOf(existing.ctx));
    this.registerSendTool(existing.ctx, sessionKey, via);
    this.registerLookTool(existing.ctx, sessionKey, via);
    this.registerVoiceTool(existing.ctx, sessionKey, via);
    this.applyPersona(existing.ctx, sessionKey, via);
    // 2026-11-04：按需加载同样是"挂在 agent ctx 上的 effect"，复用路径不补就会漏。
    this.setupOnDemandTools(existing.ctx, sessionKey, via);
    // **走到了这里**才标记"这个 ctx 的补装流程跑过了"。
    // 各 register 内部会吞异常、失败时往台账里写不进对应条目 ⇒ `isEquipped()`
    // 仍然返回 false（它逐个查 `tools` / `sections`），下一个事件会再补。
    const ledger = registrationLedger(existing.ctx);
    if (ledger !== null) ledger.equipped = true;
    return true;
  }

  /**
   * 这个 agent 的 ctx 上，装备**齐不齐**（2026-10-24）。
   *
   * ## 为什么按"台账结果"判，而不是按"我补过了"判
   *
   * 补进去的东西（`tools.register` / `systemPrompt.section` / `restrict`）都是挂在
   * **agent ctx** 上的 effect —— ctx 一换（插件热重载后 agent 被重建、补的时候拿到旧 ctx、
   * 宿主重新 resume），旧 effect 全死，**而"补过了"这个记忆还在别处**。
   * 2026-10-15 的人格消失事故、2026-10-24 统计到的"GUI 触发 105 轮里 39 轮无人格"，
   * 都是同一个形状：某个 `Set<sessionId>` 说补过了，实际早就没了。
   *
   * `registrationLedger(ctx)`（见文件顶部的实现）把 `{tools, sections}` 用 Symbol
   * 挂在 **agentCtx 上** ⇒ **它随 ctx 生灭**：ctx 一换，新 ctx 没有台账，判定自然变假，
   * 调用方就会重补。这就是"按结果判"最省事、也最不会自欺的写法。
   *
   * @param {any} agentCtx agent 作用域的 ctx
   * @returns {boolean} 三件工具 + 人格首段都确实注册在这个 ctx 上
   */
  isEquipped(agentCtx) {
    const ledger = registrationLedger(agentCtx);
    if (ledger === null || ledger.equipped !== true) return false;
    return ledger.tools.has('send_qq')
      && ledger.tools.has('look_sticker')
      && ledger.sections.has('deployment:persona-prefix');
  }

  applyPersona(ctx, sessionKey, via = 'setup') {
    // 2026-10-21：按会话覆盖层先合并；没有覆盖层 ⇒ 全局人格（逐字节不变）。
    const resolved = this.resolvedPersona(sessionKey);
    const personaText = resolved !== null ? resolved.text : this.persona;
    if (typeof personaText !== 'string' || personaText === '') return false;
    const sp = ctx?.systemPrompt;
    if (sp === null || sp === undefined || typeof sp.section !== 'function') {
      this.log('warn', `persona 覆盖失败: 这个 agent 作用域上没有 systemPrompt.section`, { sessionKey, via });
      return false;
    }
    const ledger = registrationLedger(ctx);

    // 五个段落：`name` 是幂等键，`order` 现取（宿主版本可能变），`text` 是每轮现算的函数。
    const sections = [
      {
        name: 'deployment:persona-prefix',
        order: () => sp.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        // 🔴 **函数**（不是固定串）：每轮组装时现算，在人格后面按需追加一句当前心情。
        // 没有心情时它的返回值与人格原文**逐字节相同**（见 `personaTextFor`）。
        text: () => this.personaTextFor(sessionKey),
      },
      {
        name: 'deployment:persona-suffix',
        order: () => sp.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
        // 🔴 **2026-10-18：不再用 `{{cwd}}` 变量。**
        //
        // 原来这里是固定串 `'Your working directory is {{cwd}}.'`，
        // 而**会话头没有 cwd 时，提示词组装抛的不是空字符串、是异常**：
        //   `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix",
        //    registered variables: provider, model`
        // 抛错发生在消息被追加之前 ⇒ 外部只看到"这一轮没有助手发言" ⇒
        // **每一轮都失败、她在 QQ 上彻底哑掉**（2026-10-18 实测，连续 4 轮里 3 轮炸）。
        //
        // 教训：**能自己算出来的值，别让它走"变量表"这条会抛的路。**
        // `workspacePath` 是本插件自己的配置、`defaultCwd()` 是兜底，
        // 两者都拿不到时退化成 "." —— 难看，但**永远不会让整轮挂掉**。
        text: () => `${this.promptCfg.workdir}${this.config?.workspacePath || defaultCwd() || '.'}.`,
      },
      {
        // B（2026-10-17）：知识库走 section，**不进会话历史**（私聊才真的有内容，群返回空串）。
        //
        // `text` 是**函数**、每轮组装时现算 —— 和上面人格那句同一个理由：固定串会在
        // agent 创建那一刻冻死，而这里的知识是按"当前这句话"检索的。
        //
        // ⚠️ 函数体自己吞异常：它抛出去会炸掉**整轮提示词组装**
        //    （`{{cwd}}` 缺值那次就是这样，外部只看到"模型从不回复"）。
        name: 'qq:knowledge',
        order: () => sp.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
        text: () => {
          try {
            // 2026-10-24（P1-4）：映射表优先；认不出发言人就按没有知识处理。
            const userId = this.userIdOf(sessionKey);
            // M0（2026-11-04）：**群聊也不再拼进用户消息**，一律走这段 section。
            // 原因：拼进用户消息会**留在会话历史里**，同样的 800 字每轮都在，
            // 对话越久越贵；section 是每轮重算、不进历史的。
            if (userId === '') return '';
            const body = this.#retrieveKBText(userId, this.kbLast.get(sessionKey) ?? '');
            this.kbLastChars = body.length;
            this.kbLastMode = 'section';
            return body === '' ? '' : `\n\n【你记得的相关事】\n${body}`;
          } catch {
            return '';
          }
        },
      },
      {
        // 「往 QQ 发东西的规矩」也走 section（2026-10-18，send_qq）。
        // 和发 QQ 的规矩同一个形状：函数、每轮现算、自己吞异常。
        name: 'qq:send-rule',
        order: () => sp.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
        text: () => {
          try {
            // B2（2026-10-25）：`off` 模式下**插件不再自动发**，而 toml 里那句规矩
            // 通常还写着"插件会自动发" —— 两句话打架时模型只会听一句，代价是
            // **整轮不说话**（用户那边就是"她不理我"）。所以在规矩前面钉一句现状。
            // 只改 `off`：另外两种模式下那句老规矩仍然成立，一个字都不动。
            const note = this.autoReplyMode === 'off'
              ? '\n（当前 auto_reply=off：插件**不会**自动发你这一轮的话，所有发言都必须走 send_qq。）'
              : '';
            return `${note}\n\n【发 QQ 的规矩】${this.sendRule}`;
          } catch {
            return '';
          }
        },
      },
    ];

    let applied = 0;
    for (const section of sections) {
      const previous = ledger?.sections.get(section.name);
      if (typeof previous === 'function') {
        // 上一代实例注册的段落：撤销后按**本实例**的闭包重注册（理由见上面的"幂等性"）。
        try {
          previous();
        } catch {
          // 已经失效（agent 被重建过？）：当作没有，继续往下注册。
        }
        ledger?.sections.delete(section.name);
        this.log('debug', `persona 段落 ${section.name} 换成本实例的注册（替换上一代）`, { sessionKey, via });
      }
      try {
        const dispose = sp.section({
          name: section.name,
          order: section.order(),
          text: section.text,
        });
        if (ledger !== null) {
          ledger.sections.set(section.name, typeof dispose === 'function' ? dispose : null);
        }
        applied += 1;
      } catch (error) {
        // 重复 = 上一代实例（旧代码没有台账）已经注册过：降级成 debug，别的错照旧 warn。
        if (isDuplicateRegistrationError(error)) {
          // 已经在这个 ctx 上注册过（上一代实例，没有台账）⇒ 人格式样确实在，
          // 记一个 `null`（没有 disposer 可撤）让 `isEquipped()` 看到它，
          // 否则会一直判"不齐"、每 5 秒重试一次。工具那边也是同样的处理。
          if (ledger !== null) ledger.sections.set(section.name, null);
          this.log('debug', `persona 段落 ${section.name} 已经在这个 agent 上注册过，跳过`, { sessionKey, via });
          continue;
        }
        this.log('warn', `persona 覆盖失败: ${error instanceof Error ? error.message : String(error)}`, {
          sessionKey,
          via,
          name: section.name,
        });
      }
    }
    // 覆盖层生效时留一条**可观测**的日志（没有覆盖就不打）。
    //
    // 为什么不在 `personaTextFor` 里打：那是每轮组装都会走的路径，会把日志刷满。
    // 这里只在注册/复用 agent 时判一次，并按「会话 + 覆盖字段」去重。
    if (applied > 0 && resolved !== null && resolved.overridden.length > 0) {
      if (this.loggedPersonaOverrides.size > 500) this.loggedPersonaOverrides.clear();
      const signature = `${sessionKey}|${resolved.overridden.join(',')}`;
      if (!this.loggedPersonaOverrides.has(signature)) {
        this.loggedPersonaOverrides.add(signature);
        this.log('info', 'persona 覆盖生效', {
          sessionKey,
          overridden: resolved.overridden,
          via,
        });
      }
    }
    return applied > 0;
  }

  /**
   * 把「chatId → 会话 id」记进映射表（2026-10-24，P2-6）。
   *
   * **绝不抛**：记不上只影响"下次还要重新探测一次"，不该影响她这一轮说话。
   * 没有 chatId（老调用方 / 测试）⇒ 什么都不做（行为与接线前一致）。
   * @param {string} chatId
   * @param {string} sessionId
   */
  #noteMapping(chatId, sessionId) {
    if (typeof chatId !== 'string' || chatId === '') return;
    if (this.resolver === null || typeof this.resolver.note !== 'function') return;
    try {
      this.resolver.note(chatId, sessionId);
    } catch (error) {
      this.log('debug', '记录会话映射失败（不影响本轮）', {
        chatId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 恢复失败时该用哪个 id 去新建（2026-10-24，P2-6）。
   *
   * - `legacy` 策略 ⇒ 返回原 id（与改动前逐字一致：新建同 id 会话）；
   * - `new-if-no-legacy` ⇒ 让 resolver 分配一个 `session-<uuid>` 并写进映射表。
   *
   * 判据其实就是"**resume 失败**"：这条聊天没有可接回的旧会话。
   * 不额外查盘/查服务 —— resume 已经是宿主给出的权威答案。
   * @param {string} chatId
   * @param {string} sessionKey
   * @returns {string}
   */
  #idAfterResumeFailure(chatId, sessionKey) {
    if (typeof chatId !== 'string' || chatId === '') return sessionKey;
    if (this.resolver === null || typeof this.resolver.afterResumeFailure !== 'function') return sessionKey;
    try {
      const decision = this.resolver.afterResumeFailure(chatId, sessionKey);
      if (decision !== null && typeof decision === 'object'
        && typeof decision.sessionId === 'string' && decision.sessionId !== '') {
        return decision.sessionId;
      }
    } catch (error) {
      this.log('warn', '分配新会话 id 失败（退回原 id 新建）', {
        chatId,
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return sessionKey;
  }

  /**
   * 拿到（或创建）某个 QQ 会话对应的 agent handle。
   * @param {string} sessionKey
   * @param {object} [options]
   * @param {string} [options.chatId] 这条会话对应的 chatId（`private:<QQ>` / `group:<群号>`）。
   *   给了才会写映射表、才可能在"没有旧会话"时分配新 id（P2-6）。不给 ⇒ 行为与接线前一致。
   * @returns {Promise<{handle: any, created: boolean}>}
   */
  async ensure(sessionKey, { chatId = '' } = {}) {
    // 三步，顺序是硬性的（2026-10-20 架构改动）：
    //   ① 收养（`agents.get` 查到活着的就复用，**绝不**再 create/resume）
    //   ② 走 root 创建（`agentLoop.createAgent(ctx.root, …)` ⇒ 跨插件热重载存活）
    //   ③ 回退到老路（`ctx.agents.create`，只有没有 agentLoop/root 时才走 —— 测试替身走这条）
    // 每一步都打一条带 `via` 的 info 日志，`adopt / root / plugin` 一眼能看出走的哪条。

    /**
     * 记下"这一次是恢复/新建/收养"（进快照的 `sessionMode`）。
     *
     * ⚠️ 只在**真的建/接**会话时调；命中缓存的那些轮不覆盖它 ——
     * 快照要回答的是"最近一次建会话怎么建的"，不是"最近一轮有没有建"。
     * @param {'resume'|'create'|'adopt'} via
     * @param {unknown} [reason] 恢复失败的原因（成功 / 直接新建时传 null）
     */
    const markSessionMode = (via, reason = null) => {
      this.lastSessionMode = {
        via,
        reason: reason === null || reason === undefined ? null : String(reason),
      };
    };

    // 插件自己的缓存优先：已经是活的了，不必再问宿主。
    const cached = this.live.get(sessionKey);
    if (cached !== undefined) {
      cached.lastUsedAt = this.now();
      // 顺手补记映射（表丢过/首次接线时靠它自愈）；幂等。
      this.#noteMapping(chatId, sessionKey);
      return { handle: cached.handle, created: false };
    }

    const agents = this.requireAgents();

    // ------------------------------------------------------------ ① 收养
    //
    // **这一步必须排在 create/resume 之前，而且只要命中就绝不创建。**
    // 两个 agent 同时写同一个会话日志 = **数据损坏** ——
    // `session "…" is already owned by an active write handle`（实测）只是它最轻的表现。
    //
    // 现在真的会遇到"插件缓存为空、agent 还活着"：agent 挂在 `ctx.root` 上
    // （见下面的 `via: root`），插件热重载**不再**连它一起 dispose。于是 HMR 之后
    // `this.live` 是新的空 Map，而 agent 还在跑 —— 必须把它接回来，不能重建。
    const existing = this.findLiveAgent(sessionKey);
    if (existing !== undefined) {
      markSessionMode('adopt');
      this.log('info', `收养已有的 QQ 会话 agent ${sessionKey}（via: adopt）`, { sessionKey, via: 'adopt' });
      // ⚠️ 复用这条路**不经过 `setup`**，所以工具限制要在这里补一次。
      // 不补的后果很具体：插件热重载后 `this.live` 是空的、但 agent 还活着，
      // 于是下一次 `ensure` 走这里 —— 群会话**安静地拿回 shell 权限**。
      // 幂等性没问题：这个 agent 一旦进了 `this.live` 就不会再走这条路。
      //
      // 代价：这条路也**不经过 `setup` 的 preset 挂载**，所以拿不准它跑的是哪一份
      // —— 读 live 作用域链问出来（`composedPreset`），问不到就按"没挂群 preset"处理，
      // 也就是**兜**。方向是安全的那一侧：宁可多一条多余的 warn，也别漏了收口。
      this.groupToolBackstop(existing.ctx, sessionKey, 'reuse', this.livePresetOf(existing.ctx));
      // 2026-11-04：按需加载也要在这里补（复用不经过 setup；理由同下面的工具注册）。
      this.setupOnDemandTools(existing.ctx, sessionKey, 'reuse');
      this.registerSendTool(existing.ctx, sessionKey, 'reuse');
      // 看表情包（look_sticker）同一条待遇：复用不经过 setup，不补一次热重载后就消失了。
      this.registerLookTool(existing.ctx, sessionKey, 'reuse');
      this.registerVoiceTool(existing.ctx, sessionKey, 'reuse');
      // 🔴 **persona 也要在这里补一次**（2026-10-15 线上事故）。
      //
      // 和上面那条工具限制是**同一种病、同一个位置**：挂 preset / 注册 persona 都只在
      // `setup` 里做，而这条路不经过 `setup`。热重载会 dispose 掉旧 ctx 上的
      // `systemPrompt.section()` effect ⇒ 复用回来的 agent **安静地没有 persona**，
      // 露出 preset 里那句兜底接线文本。
      // 实测现场：`qq-group-30000011` 17:06 的 prompt 5967 字符、人格段落一个都没有；
      // 同进程的测试群 16:22 是 6912、人格与心情都在 —— 差别只在新建还是复用。
      // `applyPersona` 幂等：本实例上一代留下的段落会被**替换**（撤销 + 重注册），
      // 旧代码留下的（没有台账）则降级成 debug —— 两种都不会抛、不会重复 insert。
      this.applyPersona(existing.ctx, sessionKey, 'reuse');
      // `dispose` 是**空操作**：这个 agent 的命归 `ctx.root` 管，插件不该也不能替它收尸
      // （否则"跨热重载存活"这件事会被插件自己的 dispose 直接抵掉）。
      const adopted = { agent: existing, dispose: async () => {} };
      this.live.set(sessionKey, { handle: adopted, sessionKey, lastUsedAt: this.now(), owner: 'root' });
      this.#noteMapping(chatId, sessionKey);
      return { handle: adopted, created: false };
    }

    const meta = {};
    // cwd 一定要有值。
    //
    // 部署人设的模板里有 `{{cwd}}` 变量，而提示词组装的变量表来自会话头的 cwd。
    // 会话没有 cwd 时组装的不是"空字符串"而是**抛错**：
    //   prompt variable "{{cwd}}" has no value for this assembly
    //     (section "deployment:persona-suffix")
    // 这个错发生在步骤内、消息被追加之前，所以外部只看到"会话里什么都没有、
    // 模型从不回复"，agent 状态却是正常的 running→idle。实测踩过。
    const cwd = this.config.workspacePath;
    if (typeof cwd === 'string' && cwd !== '') {
      meta.cwd = cwd;
    } else {
      meta.cwd = defaultCwd();
    }
    // **agentPreset 必须放 meta，不是 agentOptions。**
    //
    // dsh-agent 的 create/resume 约定：`meta.agentPreset` 指定挂哪个 preset，
    // `agentOptions` 只管 provider/model。上一版把 agentPreset 塞进 agentOptions，
    // preset 根本没挂上，turn 在 preStep 读 `decision.kind` 时炸出
    //   Cannot read properties of undefined (reading 'kind')
    // 且连模型请求都没发（会话里只有 turn/start → turn/end error）。
    //
    // ⚠️ 这里写的是**按会话解析后**的 preset（群会话是那份 `-lite`），不是配置里
    // 那个固定值。header 会被用来看"这个会话跑的是什么组合"，写私聊那份就是记错账
    // —— `dsh-agent-preset-registry` 的会话投影拿 header 当初始值
    // （`agentPresetProjectionDefinition.init: (header) => header.agentPreset ?? null`）。
    const sessionPreset = this.sessionPreset(sessionKey);
    if (sessionPreset !== '') {
      meta.agentPreset = sessionPreset;
    }

    // 模型路由：agent loop 在分发前必须有 provider 与 model 两者。
    // 部署里可能有默认选择（`ctx.agentDefaultModel.currentSelection()`），
    // 也可能没有；没有的话整轮不会有任何模型请求，会话里连用户消息都不会记，
    // 表现成"模型从不回复"。所以这里显式解析并把结果记进日志。
    const agentOptions = this.resolveAgentOptions();
    // ⚠️ **resume 用的那一份不带 `reasoningEffort`**（2026-10-24 实测事故）。
    //
    // 宿主 `dsh-agent-loop` 的 `prepareRequest()`：
    //   const reasoningEffort = this.options.reasoningEffort ?? persistedReasoningEffort;
    // ⇒ agentOptions 的档位**盖住**会话里持久化的 per-session 选择（GUI 选择器写的就是它）。
    // 以前每次 resume 都塞全局 low，结果用户在 GUI 里给私聊选了 high/max，插件一重载
    // 就变回 low —— 会话日志里 `MODEL/SELECTION high` 后面总跟着 `HEADER(resume) low`，
    // 重复了十几次。现在 resume 只交路由，档位还给会话；create 仍带全局档位。
    const resumeAgentOptions = this.resolveAgentOptions({ includeReasoningEffort: false });

    let handle;
    // setup 回调：agent 发布前挂 preset（persona + 工具）+ 收掉群会话的危险工具。
    //
    // `meta.agentPreset` 只把 preset id 记进会话 header，**真正的挂载**（把 preset 的
    // persona 段落、工具、技能注入 agent 作用域）靠的是这个 setup 里的
    // `agentPresets.mount(agentCtx, id)`。漏了它，会话会以 standard 的
    // "You are a coding agent" 口吻回话（实测：header 有 agentPreset:gugu，
    // 回复却是"编码智能体"）—— 这坑和 dsh-onebot-qq 的 joinPreset 同源。
    const setup = async (agentCtx) => {
      // 挂 preset：群会话挂**减配的那一份**（默认 `agentPreset` + `-lite`）。
      // 这里挂哪一份决定了子会话拿到什么 —— `dsh-subagent` 建子会话时
      // `composeFrom(childCtx, parent.ctx)` 加入的正是父手上这一代。
      const mounted = await this.mountSessionPreset(agentCtx, sessionKey);
      // 群会话兜底工具：挂的是**推导出来那份**就不叠（工具本来就不在），其余照旧叠。
      // 挂上了还硬叠 —— `restrict` 收不了 preset 没注册的名字，只会每次会话
      // 打一条误导性的 warn（理由与源码依据见 `groupToolBackstop`）。
      this.groupToolBackstop(agentCtx, sessionKey, 'setup', mounted);
      this.registerSendTool(agentCtx, sessionKey, 'setup');
      // 发之前看一眼表情包（2026-10-19）：同样只挂她这一层。
      this.registerLookTool(agentCtx, sessionKey, 'setup');
      this.registerVoiceTool(agentCtx, sessionKey, 'setup');
      // 用人格（qq-gugu.toml）覆盖 preset 的 persona —— 人格统一从 toml 读，
      // 不再散在 preset 的 YAML 里。挂完 preset 后覆盖，保证小鲸鱼的口吻来自 toml。
      this.applyPersona(agentCtx, sessionKey);
      // 2026-11-04：按需加载（目录 + load_tools）。必须在群会话收口**之后**：
      // 目录是从"当前可见"里挑的，先收后编目才不会把群里禁掉的工具写进目录。
      this.setupOnDemandTools(agentCtx, sessionKey, 'setup');
    };

    // ------------------------------------------------------------ ② 走 root 创建
    //
    // 为什么不再默认用 `ctx.agents.create`：它内部的 ownerCtx 就是**调用方 ctx**
    // （`create(options) { const ownerCtx = this.ctx; … target.createAgent(ownerCtx, options) }`，
    // `dsh-agent/lib/index.js:453-458`）—— 也就是**插件自己的 ctx**。
    // 插件热重载销毁插件 ⇒ `agentLoop.lifecycle(id)` 那个 effect 被 dispose ⇒
    // agent 连它正在跑的那一轮一起没了（实测 `turn/end`
    // `{"reason":{"kind":"aborted","reason":{"kind":"disposed"}}}`）。
    //
    // 底层 `agentLoop.createAgent(ownerCtx, options)` 是**接受 ownerCtx** 的
    // （`dsh-agent-loop/lib/index.js:1893`），`ctx.root` 是应用根作用域
    // （cordis 的 `Context` 构造器里 `this.root = self`，子 ctx 原型继承），
    // 插件卸载时**不会**销毁它 —— loader / hmr 插件自己就是靠这个活下来的。
    // 于是"改 src/ 不再掐断正在跑的那一轮"。
    //
    // ⚠️ **必须保留回退**：测试替身只有假 `ctx.agents`（没有 `agentLoop`、没有
    // `root`），宿主也可能没挂 agent-loop 服务 —— 那些情况继续走老路。
    const loop = typeof this.ctx?.get === 'function' ? this.ctx.get('agentLoop') : undefined;
    const rootCtx = this.ctx?.root;
    const viaRoot = loop !== undefined && loop !== null && rootCtx !== undefined && rootCtx !== null
      && typeof loop.createAgent === 'function';
    /**
     * 让它进 `agents` 的登记表 —— 收养分支（`agents.get`）靠这张表把它找回来。
     *
     * ⚠️ 真机上这一步**通常是空操作**：`publish()` 里已经
     * `loopCtx.agents.enter(agent, …)` 进过表了（`dsh-agent-loop/lib/index.js:1791`），
     * 再 `register` 会抛 `already registered` —— 必须吞掉，不能让它把建会话搞挂。
     * 留着它是为了"万一宿主某个版本 publish 不再自动进表"时收养仍然找得到。
     */
    const registerIfPossible = (value) => {
      if (value?.agent === undefined || value.agent === null) return;
      if (typeof agents.register !== 'function') return;
      try {
        const registered = agents.register(value.agent);
        if (registered !== null && typeof registered === 'object' && typeof registered.catch === 'function') {
          registered.catch(() => {});
        }
      } catch {
        // 已经在表里（正常情况）或宿主不认这个 agent —— 都不该让这一轮建会话失败。
      }
    };

    if (viaRoot) {
      // 恢复失败后要用哪个 id 新建（P2-6）。空串 = 继续用原 id（legacy 行为）。
      let createId = '';
      // `resume` 也走 root，理由同上：**不这么做的话，DSH 重启后 resume 回来的
      // agent 又挂在插件 ctx 上，下一次改 src/ 照样被掐断** —— 目标只实现一半。
      // `AgentLoop#resume(ownerCtx, options)` 的 options 形状与 `agents.resume(options)`
      // 逐字段一致（`resumeSessionId / agentOptions / meta / setup`，见
      // `dsh-agent-loop/lib/index.js:1959-1966` 与 `dsh-agent/lib/index.js:466-471`）。
      //
      // ⚠️ 但"接回已有会话"**不能**用 `createAgent` 顶替：它只认 `sessionId` + 可选
      // `seed`（`dsh-agent-loop/lib/index.js:1888-1898`），**没有** `resumeSessionId`。
      const viaRootResume = typeof loop.resume === 'function';
      if (viaRootResume) {
        try {
          handle = await loop.resume(rootCtx, {
            resumeSessionId: sessionKey,
            agentOptions: resumeAgentOptions,
            meta,
            setup,
          });
          markSessionMode('resume');
          this.log('info', `已恢复 QQ 会话 ${sessionKey}（via: root）`, { sessionKey, via: 'root', resumed: true });
          // 恢复成功 ⇒ 这条聊天确实有旧会话：把「chatId → 旧 id」记进表（P2-6 的 new-if-no-legacy 靠它）。
          this.#noteMapping(chatId, sessionKey);
        } catch (error) {
          // ⚠️ 这里原来只打 `debug`：会话日志坏掉时用户看到的是"她突然不记得之前的话"，
          // 而日志里既看不出恢复失败过、也看不出接下来是新建。升 `warn` 并写清三件事：
          // **失败原因 + 会话 id + 改为新建**（快照里另有 `sessionMode.reason`）。
          //
          // 2026-10-24（P2-6）：默认策略是 `new-if-no-legacy` —— resume 失败说明
          // "这条聊天没有可接回的旧会话"（新聊天 / 日志坏了），此时**换新 id**新建，
          // 而不是像以前那样继续用旧 id 建一个空会话（空会话会把旧历史永远钉在孤儿目录里）。
          const reason = error instanceof Error ? error.message : String(error);
          markSessionMode('create', reason);
          createId = this.#idAfterResumeFailure(chatId, sessionKey);
          this.log('warn', `恢复 QQ 会话 ${sessionKey} 失败（${reason}），改为新建（via: root）`, {
            sessionKey,
            via: 'root',
            resumed: false,
            createId: createId === '' ? null : createId,
            error: reason,
          });
        }
      }
      if (handle === undefined) {
        const targetId = createId === '' ? sessionKey : createId;
        handle = await loop.createAgent(rootCtx, {
          sessionId: targetId,
          agentOptions,
          meta,
          setup,
        });
        if (!viaRootResume) markSessionMode('create');
        // 用新 id 建出来之后，后续的缓存/日志/工具注册都要跟着它走。
        if (targetId !== sessionKey) {
          this.log('info', `这条聊天没有旧会话 ⇒ 换用新会话 id ${targetId}（P2-6 new-if-no-legacy）`, {
            chatId,
            legacySessionKey: sessionKey,
            sessionId: targetId,
          });
          sessionKey = targetId;
        }
        this.#noteMapping(chatId, sessionKey);
        this.log('info', `已新建 QQ 会话 ${sessionKey}（via: root）`, { sessionKey, via: 'root', created: true });
      }
      registerIfPossible(handle);
    } else {
      // -------------------------------------------------------- ③ 回退（老路）
      // 没有 `agentLoop` / `ctx.root`：测试替身与"宿主没挂 agent-loop"的部署走这条。
      // 代价说清楚：这条路建出来的 agent 依旧挂在插件 ctx 上，热重载会 dispose 它。
      try {
        // 尝试 resume：重启后要把原来的对话接回来，而不是新开一个失忆的会话。
        handle = await agents.resume({
          resumeSessionId: sessionKey,
          agentOptions: resumeAgentOptions,
          meta,
          setup,
        });
        markSessionMode('resume');
        this.log('info', `已恢复 QQ 会话 ${sessionKey}（via: plugin）`, { sessionKey, via: 'plugin', resumed: true });
        this.#noteMapping(chatId, sessionKey);
      } catch (error) {
        // 与 root 那条同款：`debug` 太轻，恢复失败等于"这一轮她失忆了"，
        // 必须留下可检索的 warn（原因 + 会话 id + 改为新建）。
        const reason = error instanceof Error ? error.message : String(error);
        markSessionMode('create', reason);
        // P2-6：resume 失败 = 没有可接回的旧会话 ⇒ 按策略决定"继续用旧 id"还是"换新 id"。
        const targetId = this.#idAfterResumeFailure(chatId, sessionKey);
        this.log('warn', `恢复 QQ 会话 ${sessionKey} 失败（${reason}），改为新建（via: plugin）`, {
          sessionKey,
          via: 'plugin',
          resumed: false,
          createId: targetId === sessionKey ? null : targetId,
          error: reason,
        });
        handle = await agents.create({
          sessionId: targetId,
          agentOptions,
          meta,
          setup,
        });
        if (targetId !== sessionKey) {
          this.log('info', `这条聊天没有旧会话 ⇒ 换用新会话 id ${targetId}（P2-6 new-if-no-legacy）`, {
            chatId,
            legacySessionKey: sessionKey,
            sessionId: targetId,
          });
          sessionKey = targetId;
        }
        this.#noteMapping(chatId, sessionKey);
        this.log('info', `已新建 QQ 会话 ${sessionKey}（via: plugin）`, { sessionKey, via: 'plugin', created: true });
      }
    }

    this.live.set(sessionKey, {
      handle,
      sessionKey,
      lastUsedAt: this.now(),
      // 归属：`root` 的 agent 命归应用根作用域管，**插件卸载时不许 dispose**
      // （否则插件自己的 shutdown 就把"跨热重载存活"亲手抵掉了 —— 见 `dispose()`）。
      owner: viaRoot ? 'root' : 'plugin',
    });
    return { handle, created: true };
  }

  /**
   * 在 `ctx.agents` 里找已经活着的、会话 id 等于该会话键的 agent。
   *
   * `list()` 是公开 API（`dsh-agent` README：`get(id)`、`list()`、`roots()` 用于
   * 查找实时 agent）。agent 的会话 id 取自 `agent.session.id` 或 `agent.id`，
   * 两者在构建产物里都可能，所以都试。
   * @param {string} sessionKey
   * @returns {any|undefined}
   */
  findLiveAgent(sessionKey) {
    try {
      const agents = this.ctx?.agents;
      if (agents === undefined || agents === null) return undefined;
      // get() 是最直接的路径；没有再退回全表扫描。
      const direct = typeof agents.get === 'function' ? agents.get(sessionKey) : undefined;
      if (direct !== undefined && direct !== null) return direct;
      if (typeof agents.list !== 'function') return undefined;
      const all = agents.list();
      if (!Array.isArray(all)) return undefined;
      return all.find((agent) => {
        if (agent === null || typeof agent !== 'object') return false;
        const ids = [agent.id, agent.session?.id, agent.session?.header?.id];
        return ids.some((id) => id !== undefined && String(id) === sessionKey);
      });
    } catch (error) {
      this.log('debug', '查找已有 agent 失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * 解析会话的模型路由（provider/model）与推理档。
   *
   * 优先级：插件配置 → 部署默认（`ctx.agentDefaultModel`）。
   * 两者都没有时**明确警告**：那一轮不会有任何模型请求，是很典型的"配好了但机器人
   * 从不回话"，必须让它一眼可见，而不是安静地什么都不做。
   *
   * @param {object} [options]
   * @param {boolean} [options.includeReasoningEffort] 是否把推理档写进 `agentOptions`。
   *   **resume 时必须传 `false`**（2026-10-24 实测事故）：宿主 `dsh-agent-loop` 的
   *   `prepareRequest()` 取档是 `this.options.reasoningEffort ?? persistedReasoningEffort`
   *   ⇒ `agentOptions` 里的档位**优先级高于**会话里持久化的 per-session 选择
   *   （GUI 的会话级选择器写的是 `model/selection` 事件 + `modelSelection` 投影）。
   *   每次 resume 都塞一个全局 low，等于把用户在 GUI 里给这条会话选的档位一遍遍改回 low
   *   —— 会话日志里的现场是 `MODEL/SELECTION high` 后面总跟一条 `HEADER(resume) low`。
   *   create 仍然要带：新会话需要一个便宜的起点（否则继承部署默认 max）。
   * @returns {object}
   */
  resolveAgentOptions({ includeReasoningEffort = true } = {}) {
    const options = {};
    // 注意：agentPreset 不在这里（它在 ensure 里放进 meta.agentPreset）。
    // agentOptions 只管 provider/model 路由。

    const configuredProvider = this.config.provider;
    const configuredModel = this.config.model;
    if (typeof configuredProvider === 'string' && configuredProvider !== '') {
      options.provider = configuredProvider;
    }
    if (typeof configuredModel === 'string' && configuredModel !== '') {
      options.model = configuredModel;
    }
    // 推理强度：留空则继承部署默认（全局是 `max`）。
    // 小鲸鱼配低值，免得把一句闲聊当成调研任务跑到天荒地老（实测 50 步 3 分钟）。
    //
    // 2026-10-21：**真源改成 `[agent] reasoning`**（由 index.mjs 解析后注入
    // `this.agentReasoning`）。旧的 `config.reasoningEffort`（`cordis.patch.yml`）
    // 只在装配层没给值时兜底 —— 两条路都空了才**一个字段都不发**（继承部署默认），
    // 所以 `new SessionBinder({ctx})` 的行为与改动前逐字一致。
    //
    // ⚠️ 2026-10-24：**resume 时一个字段都不发**（`includeReasoningEffort: false`）。
    // 理由见 JSDoc：宿主侧 `options.reasoningEffort ?? persisted` ⇒ 我们发什么就把
    // 会话里存的那档改成什么。只有 create（新会话）才写这个字段。
    if (includeReasoningEffort) {
      const configuredEffort = this.agentReasoning !== ''
        ? this.agentReasoning
        : this.config.reasoningEffort;
      if (typeof configuredEffort === 'string' && configuredEffort !== '') {
        options.reasoningEffort = configuredEffort;
      }
    }

    if (options.provider === undefined || options.model === undefined) {
      // 从部署默认补齐缺失的一侧。
      let selection;
      try {
        selection = this.ctx?.agentDefaultModel?.currentSelection?.();
      } catch (error) {
        this.log('debug', '读取部署默认模型失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (selection !== null && typeof selection === 'object') {
        if (options.provider === undefined && typeof selection.provider === 'string') {
          options.provider = selection.provider;
        }
        if (options.model === undefined && typeof selection.model === 'string') {
          options.model = selection.model;
        }
      }
    }

    if (options.provider === undefined || options.model === undefined) {
      this.log(
        'warn',
        'QQ 会话没有可用的模型路由：这一轮不会有任何模型请求，机器人不会回话。' +
          '请在插件配置里显式设置 provider 与 model，或在 DSH 里选好默认模型。',
        { provider: options.provider ?? null, model: options.model ?? null },
      );
    } else {
      this.log('debug', 'QQ 会话的模型路由', {
        provider: options.provider,
        model: options.model,
      });
    }
    return options;
  }

  /**
   * 跑一轮：投提示词，等空闲，读出回复。
   *
   * @param {object} request
   * @param {string} request.sessionKey
   * @param {string} request.prompt
   * @param {AbortSignal} [request.signal]
   * @param {string} [request.source] 归因用的插件名
   * @param {Array<{type: 'image', attachment: any}>} [request.imageBlocks]
   *   这条消息里的图片（已由 `media.mjs` 存成 DSH 附件）。空数组 = 纯文本轮。
   * @param {(text: string, step: number) => Promise<void>} [request.onSegment]
   *   **逐段外发**（2026-11-04）：每写出一个 step 的正文就调一次（`step` 从 1 数起）。
   *   不给 = 只在轮末返回最后一段（改动前的行为）。
   * @returns {Promise<string>} 助手本轮发言；本轮没说话则空串
   */
  async runTurn({ sessionKey, prompt, signal, source = 'dsh-qq-proactive', imageBlocks = [], chatId = '', onSegment = null }) {
    // 注入知识：检索用户消息里的概念 + 发言人画像，让小鲸鱼"认识人、记得事"。
    const finalPrompt = this.#injectKnowledge(sessionKey, prompt);
    // 同一会话串行。
    const previous = this.locks.get(sessionKey);
    if (previous !== undefined) await previous.catch(() => undefined);

    const task = this.#runTurnInner({ sessionKey, prompt: finalPrompt, signal, source, imageBlocks, chatId, onSegment });
    // 2026-10-21：`finally` 里比较的必须是**存进 map 的那个包装 promise**，
    // 不能是原始 `task` —— 两者永远不 `===`，于是这一行永远不会删锁。
    //
    // 后果（实测）：任何一轮结束之后 `binder.locks` 都会永久残留，free_time 的
    // 「她不在忙」判定从此恒为 false，定时唤醒静默失效（快照里表现为
    // `skipReasons` 全是 `busy`）。重载会重建 binder、清空 map，所以这个缺陷只在
    // 「一次重载之后又跑过至少一轮」时暴露。
    const guarded = task.catch(() => undefined).finally(() => {
      if (this.locks.get(sessionKey) === guarded) this.locks.delete(sessionKey);
    });
    this.locks.set(sessionKey, guarded);
    const reply = await task;
    // 学习：私聊被动回复后，从这轮对话提炼事实入库（异步，不阻塞回复）。
    this.#learnFromTurn(sessionKey, prompt, reply).catch(() => {});
    return reply;
  }

  /**
   * 被动回复后，从"用户消息 + 助手回复"提炼事实，存进知识库的人物画像。
   * 只在私聊做（1 对 1、噪音低）；群聊不抽。
   * @param {string} sessionKey
   * @param {string} userText
   * @param {string} assistantText
   */
  async #learnFromTurn(sessionKey, userText, assistantText) {
    if (this.learner === null || this.learner === undefined) return;
    if (this.knowledge === null || this.knowledge === undefined) return;
    // 2026-10-24（P1-4）：映射表优先 —— uuid 会话靠它才能继续学记忆。
    const userId = this.userIdOf(sessionKey);
    if (userId === '') return;
    if (String(assistantText ?? '').trim() === '') return;
    try {
      // ⚠️ **必须把"这个人已经记住的东西"传进去**（2026-10-05 补）。
      //
      // 以前这里只传 `{ userText, assistantText }` —— 于是抽取器根本不知道
      // "这条已经记过了"，同一件事被反复记。查 MaiBot 那份存量数据时看到的
      // 1,321 条记忆点、里面大量重复，就是这么来的。
      // 现在把它喂进去，提示词里明说"这些已经记过，不要重复"。
      const facts = await this.learner.learn({
        userText,
        assistantText,
        knownFacts: this.knowledge.factsFor(userId),
      });
      if (facts.length === 0) return;
      // `remember` 自己会做相似度去重和上限（返回 false 表示判重命中、没记进去）。
      let kept = 0;
      for (const fact of facts) {
        if (this.knowledge.remember(userId, fact) === true) kept += 1;
      }
      if (kept === 0) return;
      // 通知外部回写（持久化）。
      if (typeof this.onLearned === 'function') {
        this.onLearned(this.knowledge.dumpLearned());
      }
    } catch {
      /* 学习失败不影响主链路 */
    }
  }

  /**
   * 把知识库检索结果注入提示词。
   * @param {string} sessionKey
   * @param {string} prompt
   * @returns {string}
   */
  #injectKnowledge(sessionKey, prompt) {
    if (this.knowledge === null || this.knowledge === undefined) return prompt;
    try {
      // 2026-10-24（P1-4）：映射表优先（uuid 会话靠它反推发言人；旧前缀兜底）。
      const userId = this.userIdOf(sessionKey);
      if (userId === '') return prompt;
      // M0（2026-11-04）：**不再把知识拼进用户消息**（群聊原来这么干）。
      //
      // 拼进用户消息 = 知识进了会话历史，同样的 800 字每轮都在，而且越积越多；
      // 现在统一改成「把本轮 prompt 当检索钥匙存下，正文由 `qq:knowledge` section
      // 每轮现算」——section 不进历史、每轮替换，私聊从 2026-10-17 起就是这么做的。
      //
      // `kbLastChars` 由 section 的 `text()` 在渲染后回填（见那里），这里只记钥匙。
      this.kbLast.set(sessionKey, prompt);
      this.kbLastMode = 'section';
      return prompt;
    } catch {
      return prompt;
    }
  }

  /**
   * 检索 + 渲染知识，并按 `maxChars` **逐条丢弃**到上限以内（A，2026-10-17）。
   *
   * 画像自己的字数上限交给 `retrieve` 的 `maxPersonChars` —— 那边是**挑要点**，
   * 不会把一句话切一半；这里再把**概念**从最后一条开始丢。
   *
   * @param {string} userId
   * @param {string} text 检索用的当前文本
   * @returns {string} 空串表示没有可注入的知识
   */
  #retrieveKBText(userId, text, sessionKey = '') {
    const cap = this.kbMaxChars;
    // B 段（2026-11-04）：每人画像再压一档（1200 → 400）。理由：关系记账已经给了
    // 一行"这人跟小鲸鱼是什么关系"，画像不需要再整串倒出来；总量上限仍是 kbMaxChars。
    const items = this.knowledge.retrieve({
      text,
      userId,
      topK: 2,
      maxPersonChars: Math.min(400, cap),
    });
    let list = Array.isArray(items) ? [...items] : [];
    let out = this.knowledge.render(list);
    while (out.length > cap && list.length > 0) {
      list = list.slice(0, -1);
      out = this.knowledge.render(list);
    }
    // B 段：一行关系摘要（来自关系记账，零模型调用）。放在知识前面 ——
    // 它回答"这人是谁"，知识回答"记得什么"，顺序反了读者会先看到细节。
    const note = this.#relationNote(sessionKey, userId);
    if (note !== '') {
      out = out === '' ? note : `${note}\n${out}`;
    }
    // M1：回想一行（"之前聊过什么"），按当前消息字面召回；命中才加。
    const recallLine = this.#recallLine(sessionKey, text);
    if (recallLine !== '') {
      out = out === '' ? recallLine : `${out}\n${recallLine}`;
    }
    return out;
  }

  /**
   * 回想召回（M1，2026-11-04）：拿这一轮的提示词当查询，命中才返回一行。
   * 群聊压到 150 字、私聊 300 字（群里要短，私聊可以多说两句）。
   * @param {string} sessionKey
   * @param {string} text
   * @returns {string}
   */
  #recallLine(sessionKey, text) {
    if (this.recall === null || this.recall === undefined) return '';
    try {
      const chatId = sessionKey === '' ? '' : chatIdFromSessionKey(sessionKey);
      if (chatId === '') return '';
      const hit = this.recall.recall({ chatId, text });
      if (hit === null || hit === undefined) return '';
      const cap = chatId.startsWith('group:')
        ? RECALL_DEFAULTS.injectChars.group
        : RECALL_DEFAULTS.injectChars.private;
      return formatRecall(hit, { maxChars: cap });
    } catch {
      return '';
    }
  }

  /**
   * 一行关系摘要（B 段）。拿不到 chatId / 没有记账 / 没这个人 ⇒ 空串（提示词一字不变）。
   * @param {string} sessionKey
   * @param {string} userId
   * @returns {string}
   */
  #relationNote(sessionKey, userId) {
    if (this.relations === null || this.relations === undefined) return '';
    if (userId === '') return '';
    try {
      const chatId = sessionKey === '' ? '' : chatIdFromSessionKey(sessionKey);
      if (chatId === '') return '';
      // B2（2026-11-04）：候选序 = 当前发言者 → 最近发言的人（去重、最多看 3 个）。
      // @ 的人和被回复的人需要消息级信息，等下一版再接（binder 这里拿不到 message）。
      const candidates = [];
      const push = (uid) => {
        const id = String(uid ?? '').trim();
        if (id !== '' && !candidates.includes(id)) candidates.push(id);
      };
      push(userId);
      if (this.recentSpeakers !== null) {
        try {
          const recent = this.recentSpeakers(sessionKey);
          for (const item of Array.isArray(recent) ? recent : []) {
            if (item?.fromSelf === true) continue;
            push(item?.userId);
            if (candidates.length >= 3) break;
          }
        } catch {
          /* 取转录失败 ⇒ 只留当前发言人 */
        }
      }
      const lines = [];
      let budget = 300;
      for (const uid of candidates) {
        const line = this.relations.lineFor({ chatId, userId: uid });
        if (typeof line !== 'string' || line.trim() === '') continue;
        if (line.length + 3 > budget) break;
        budget -= line.length + 3;
        lines.push(line.trim());
        if (lines.length >= 3) break;
      }
      if (lines.length === 0) return '';
      return lines.map((l) => `【关系】${l}`).join('\n');
    } catch {
      return '';
    }
  }

  /**
   * 快照的 `sessionMode` 段：最近一次 `ensure()` 是**恢复 / 新建 / 收养**。
   *
   * 现状（2026-10-21 修）：恢复失败会在 `warn` 里带上原因，这里把同一个事实
   * 落进快照 —— 日志会滚、快照不会。形状固定 `{via, reason}`：
   * `reason === null` 表示没有发生过"恢复失败 ⇒ 新建"。
   *
   * @returns {{via: 'resume'|'create'|'adopt', reason: string|null}}
   */
  sessionModeStats() {
    return { ...this.lastSessionMode };
  }

  /**
   * 快照的 `knowledgeInject` 段（2026-10-17）：两个旋钮的**生效值** + 最近一次的留痕。
   * 两档分开记（照 `learnedMemory` 的经验）：只看一个布尔的话，
   * "配了关但还在注入"这种接线漏掉是看不出来的。
   * @returns {{maxChars: number, privateAsSection: boolean, lastChars: number, lastMode: string}}
   */
  knowledgeInjectStats() {
    return {
      maxChars: this.kbMaxChars,
      privateAsSection: this.kbPrivateAsSection,
      lastChars: this.kbLastChars,
      lastMode: this.kbLastMode,
    };
  }

  /**
   * 记一轮的取回复结果（2026-10-28）。**永不抛** —— 它挂在每一轮的收尾上。
   * @param {string} sessionKey
   * @param {{kind: string, before: number, after: number, historyShrank: boolean, streamFrames: number, streamedChars: number, promptId?: string}} diag
   */
  #recordTurnDiag(sessionKey, diag) {
    try {
      const stats = this.turnStats;
      stats.turns += 1;
      if (diag.historyShrank === true) stats.compactedTurns += 1;
      if (diag.kind === 'lost') {
        stats.emptyReplies += 1;
        stats.lostReplies += 1;
      } else if (diag.kind === 'empty') {
        stats.emptyReplies += 1;
      } else if (diag.kind === 'ok-anchor') {
        stats.recoveredByAnchor += 1;
      } else if (diag.kind === 'ok-stream') {
        stats.recoveredByStream += 1;
      }
      // 会话有上限地留着（聊天群可以很多），别让这个表长成进程泄漏。
      if (this.lastTurnDiag.size > 128) this.lastTurnDiag.clear();
      this.lastTurnDiag.set(sessionKey, { ...diag, at: this.now() });
    } catch {
      /* 计数坏了也不能影响这一轮 */
    }
  }

  /**
   * 快照用的取回复计数（2026-10-28）：`{turns, emptyReplies, lostReplies,
   * compactedTurns, recoveredByAnchor, recoveredByStream}`。
   *
   * `lostReplies` **正常就该是 0** —— 它 > 0 就是"这一轮的回复被静默丢过"
   * （压缩吞回复 / deriveMessages 里没正文）。
   * @returns {{turns: number, emptyReplies: number, lostReplies: number, compactedTurns: number, recoveredByAnchor: number, recoveredByStream: number}}
   */
  turnDiagnostics() {
    try {
      return { ...this.turnStats };
    } catch {
      return { turns: 0, emptyReplies: 0, lostReplies: 0, compactedTurns: 0, recoveredByAnchor: 0, recoveredByStream: 0 };
    }
  }

  /**
   * 某会话**最近一轮**的取回复诊断（网关用它给"空回复"分级留痕）。
   *
   * 返回 `null` 表示这个会话还没跑过一轮。
   * @param {string} sessionKey
   * @returns {{kind: string, before: number, after: number, historyShrank: boolean, streamFrames: number, streamedChars: number, promptId?: string, at: number}|null}
   */
  emptyReplyDiagnosis(sessionKey) {
    try {
      return this.lastTurnDiag.get(sessionKey) ?? null;
    } catch {
      return null;
    }
  }

  async #runTurnInner({ sessionKey, prompt, signal, source, imageBlocks = [], chatId = '', onSegment = null }) {
    if (signal?.aborted === true) throw new Error('本轮已被取消');

    // P2-6：把 chatId 交给 `ensure` —— 它才是决定"用旧 id 还是新分配一个"的地方
    // （resume 失败 = 没有旧会话；是否换新 id 由 resolver 的策略定）。
    const { handle } = await this.ensure(sessionKey, { chatId });
    const agent = handle?.agent;
    if (agent === undefined || agent === null) {
      throw new Error(`会话 ${sessionKey} 的 handle 上没有 agent 对象，无法驱动`);
    }

    // 2026-11-04：有些工具插件在 agent 创建**之后**才注册（实测 schedule/team/jobs 这三个族
    // 就漏在挂载那次快照之外）。每轮开头补一次编目，前几轮有效、稳定后自动停。
    this.refreshOnDemandTools(agent.ctx, sessionKey);

    // 复用外部预建的会话时检查 cwd。
    //
    // 部署人设模板里有 `{{cwd}}`，而会话没有 cwd 时提示词组装的不是空字符串
    // 而是**抛错**——错发生在消息被追加之前，外部只看到"本轮没有助手发言"，
    // 极难定位（实测踩过两次：一次是插件自己建的会话，一次是 dmRouting=main
    // 指向的外部会话）。
    // 插件自己建的会话已经兜底填了 cwd，所以只有"复用外部会话"这一路会缺；
    // 这里首次进入时告警一次，把根因直接写在日志里。
    if (!this.warnedCwd.has(sessionKey) && agent.session?.header?.cwd === undefined) {
      this.warnedCwd.add(sessionKey);
      this.log(
        'warn',
        `会话 ${sessionKey} 没有 cwd：提示词组装会因 {{cwd}} 无值而失败，本轮不会产生回复。` +
          '如果是外部预建的会话，请给它配 cwd（插件自己建的会话会自动兜底填）。',
        {},
      );
    }

    // 记录本轮开始前的派生消息长度，用来只取本轮新增的发言。
    const before = this.readMessages(agent).length;
    this.log('debug', `→ 投递提示词 ${sessionKey}`, { before, chars: prompt.length });

    // 同时挂一个流式监听器：`deriveMessages()` 是本轮结束后的权威来源，
    // 但一旦它没给出预期结果，流式事件能直接证明"这一轮到底有没有产生助手文本"。
    // 两条路都留着，是因为它们失效的原因完全不同（前者可能是读法不对，
    // 后者可能是事件名或 payload 形状变了）。
    const streamed = this.#collectStream(agent);

    // ⚠️ **这一整段必须在 `try` 里，`streamed.stop()` 必须在 `finally` 里。**
    //
    // 这条路径上有三处会抛：`whenIdle()`、下面那个中止分支（`signal.aborted`）、
    // `#waitForNewMessages()`。原先 `streamed.stop()` 写在流程末尾，任一异常都会
    // 跳过它 —— 于是连第 4 个监听（它握着 `parts` = **本轮助手回复的全文**）
    // 也一起漏掉，把"每轮漏 3 个"放大成"中止时漏 4 个，其中一个是正文"。
    //
    // 取证见 `shared/2026-10-05-qq-proactive-长驻资源审计-<session-id>.md` 的 H2。
    let after;
    // 本轮投进去的那条用户消息（带 id）。**这个 id 是取回复的第二条锚点**：
    // 历史被压缩时条数会变短，按下标切必然切空，按 id 找就不受影响
    // （见 `assistantTextAfterMessage` 的说明）。
    const promptMessage = this.#buildMessage({ prompt, imageBlocks });
    const promptId = promptMessage !== null && typeof promptMessage.id === 'string' ? promptMessage.id : '';
    // 逐段外发（2026-11-04）：调用方给了 `onSegment` 才开 —— 不给 = 行为与改动前逐字相同。
    const pump = typeof onSegment === 'function'
      ? this.#startSegmentPump({ agent, anchorId: promptId, sessionKey, onSegment })
      : null;
    try {
      agent.followup(promptMessage);
      this.log('debug', `→ 已投递，等 whenIdle ${sessionKey}`, {});

      await agent.whenIdle();
      this.log('debug', `→ whenIdle 返回 ${sessionKey}`, {
        streamFrames: streamed.count(),
        afterMessages: this.readMessages(agent).length,
      });
      if (signal?.aborted === true) throw new Error('本轮已被取消');

      // `whenIdle()` 只等"当前这次活动"。如果驱动器当时没被唤醒，它会立刻返回，
      // 会话还没追加上这一轮的消息。所以这里轮询等新消息出现，而不是只读一次快照。
      //
      // 🔴 2026-10-28：**只等"条数涨了"是不够的。**
      // 上下文压缩（compaction）会把一段 surface 用一条 checkpoint 消息**替换掉**
      // （宿主 `surfaceOp: {op:'replace'}`）⇒ 一轮之内 `deriveMessages().length`
      // **变小**，此后永远 `<= before`（`before` 是压缩前的条数）⇒ 这段循环必然
      // 空等到 8 秒超时，然后拿一份"切不出本轮回复"的消息表出去。
      // 所以补第二个出口：**按本轮提示词消息的 id 找到它，后面已有助手文本 ⇒ 到站了**。
      after = await this.#waitForNewMessages(agent, before, undefined, promptId === ''
        ? null
        : (messages) => assistantTextAfterMessage(messages, promptId) !== null);
    } finally {
      streamed.stop();
      if (pump !== null) {
        // 停轮询 + **最后一次**扫描：最后一段正文可能是在 `whenIdle()` 之后才落盘的。
        // 逐段发送坏了也不能把这一轮弄抛（取回复的路照常走完）。
        try {
          await pump.stop();
        } catch {
          /* 已在 `#startSegmentPump` 里记过日志 */
        }
      }
    }

    // 历史"变短"= 这一轮里 surface 被压缩/重写过（正常轮次只会变长）。
    const historyShrank = after.length < before;

    const reply = assistantTextSince(after, before);
    if (reply !== null) {
      this.#recordTurnDiag(sessionKey, {
        kind: 'ok',
        before,
        after: after.length,
        historyShrank,
        streamFrames: streamed.count(),
        streamedChars: streamed.text().trim().length,
      });
      return reply;
    }

    // ① 兜底一：**按提示词 id 锚定**（压缩把条数改短时，这条路能把回复捞回来）。
    //    只在上面那条权威路径取不到时才走，所以正常轮次的行为一个字节都没变。
    const anchored = assistantTextAfterMessage(after, promptId);
    if (anchored !== null) {
      this.#recordTurnDiag(sessionKey, {
        kind: 'ok-anchor',
        before,
        after: after.length,
        historyShrank,
        streamFrames: streamed.count(),
        streamedChars: streamed.text().trim().length,
        promptId,
      });
      this.log('warn', `本轮回复是靠【提示词 id 锚定】捞回来的（历史条数没涨，疑似压缩过）${sessionKey}`, {
        before,
        after: after.length,
        chars: anchored.trim().length,
      });
      return anchored;
    }

    // 回退：用流式事件拼出的文本。
    const streamedText = streamed.text().trim();
    if (streamedText !== '') {
      this.#recordTurnDiag(sessionKey, {
        kind: 'ok-stream',
        before,
        after: after.length,
        historyShrank,
        streamFrames: streamed.count(),
        streamedChars: streamedText.length,
      });
      this.log('warn', `本轮回复是靠【流式分片】拼回来的（deriveMessages 里没有正文）${sessionKey}`, {
        before,
        after: after.length,
        frames: streamed.count(),
        chars: streamedText.length,
      });
      return streamedText;
    }

    // 空回复时的兜底文案。
    //
    // 模型跑完一整轮却只产出了 `reasoning` 与 `tool-call` 块、没有一句纯文本——
    // 这在"任务做了但没汇报"时很常见。此时若什么都不发，QQ 那边就是一片沉默，
    // 用户完全不知道发生了什么。配了 `emptyReplyFallback` 就补一句。
    // 默认关闭：主动发言场景下沉默是正确行为，不该硬塞一句话。
    const fallback = String(this.config.emptyReplyFallback ?? '').trim();
    if (fallback !== '' && after.length > before) {
      this.log('debug', `会话 ${sessionKey} 本轮无纯文本，使用兜底文案`, {});
      return fallback;
    }
    // 🔴 2026-10-21：级别按「这一轮到底有没有动静」分，不再一律 debug。
    //
    // 实测（2026-10-21 13:01 私聊那一轮）：GUI 上「已完成」、也确实有最终文本，
    // 但 `assistantTextSince` 和流式拼接都没取到 ⇒ 返回空串 ⇒ gateway 按
    // 「模型决定不说话」静默丢掉，台账里连 `gw-send` 都没有，用户那边就是一片安静。
    // **当时唯一的线索就是这条 debug 日志，而 debug 默认看不见。**
    //
    // 所以：这一轮**有新消息**却一个字符都没取到 ⇒ warn（异常，要能看见）；
    //       一点新消息都没有 ⇒ debug（模型确实没动，属于正常，别刷屏）。
    //
    // 🔴 2026-10-28 再加一条口径：**历史变短了（压缩过）也算"有动静"**。
    // 事故现场就是 `after(≈30) < before(≈900)` ——
    // 原来的判据 `after.length > before` 在这种时候**恒为 false**，
    // 于是"回复被压缩吞掉"被判成"模型没说话"，只留一条 debug。**这就是静默丢消息。**
    const lostTurn = after.length > before || historyShrank;
    this.#recordTurnDiag(sessionKey, {
      kind: lostTurn ? 'lost' : 'empty',
      before,
      after: after.length,
      historyShrank,
      streamFrames: streamed.count(),
      streamedChars: streamedText.length,
      promptId,
    });
    this.log(lostTurn ? 'warn' : 'debug', `会话 ${sessionKey} 本轮没有助手发言`, {
      before,
      after: after.length,
      historyShrank,
      promptId,
      roles: after.map((m) => (m === null || typeof m !== 'object' ? typeof m : m.role)),
      streamFrames: streamed.count(),
      streamedChars: streamedText.length,
      agentFailures: streamed.failures(),
      agentStatuses: streamed.statuses(),
      agentStatus: (() => {
        try {
          return agent.status;
        } catch {
          return '?';
        }
      })(),
      // 形状诊断：只看键名与块类型，不把正文倒进日志。
      shape: after.slice(-3).map((m) =>
        m === null || typeof m !== 'object'
          ? typeof m
          : {
              role: m.role,
              keys: Object.keys(m),
              blockTypes: Array.isArray(m.content)
                ? m.content.map((b) => (b !== null && typeof b === 'object' ? b.type : typeof b))
                : typeof m.content,
            },
      ),
      // 所有助手消息里各自有哪些块类型：用来判断"模型到底有没有产出纯文本"。
      assistantBlocks: after
        .filter((m) => m !== null && typeof m === 'object' && m.role === 'assistant')
        .map((m) =>
          Array.isArray(m.content)
            ? m.content.map((b) =>
                b !== null && typeof b === 'object'
                  ? `${b.type}${b.type === 'text' ? `(${String(b.text ?? '').length})` : ''}`
                  : typeof b,
              )
            : typeof m.content,
        ),
    });
    return streamedText;
  }

  /**
   * **逐段外发**（2026-11-04）：这一轮每写一段正文（= 一个 step 落盘），
   * 立刻把它交给调用方发出去，**不等整轮结束**。
   *
   * ## 为什么必须这样（用户原话）
   *
   * 「不要走拼接，因为时间段可能相差很多，每次都输出一次」—— 她习惯"边干边说"：
   * 一轮里可能分好几步写正文、中间夹工具调用，前后能差几十分钟。攒到最后只发
   * 最后一段，前面说的全丢（这正是 2026-11-02 20:15 那轮丢 4 段的形状）。
   *
   * ## 判据只有一条：派生消息里**新出现**一条有正文的助手消息
   *
   * 半截的流式文本不进 surface（见 `takeNewAssistantSegments` 的说明），所以
   * 轮询不会把半句话发出去。**不挂事件监听**：`session/event` 是宿主热路径，
   * 而 `deriveMessages()` 已经是"落盘后的权威来源"，少一层形状不确定的东西。
   *
   * ## 去重
   *
   * `seen` 记本轮交出去过的 key；同一个 step 被扫描看到第二次直接跳过 ——
   * `whenIdle()` 被多次唤醒、连接重放都不影响。
   *
   * @param {object} options
   * @param {any} options.agent
   * @param {string} options.anchorId 本轮用户消息 id（找不到就靠 `preIds` 兜底）
   * @param {string} options.sessionKey 只用于日志
   * @param {(text: string, step: number) => Promise<void>} options.onSegment
   * @returns {{count: () => number, flush: () => Promise<void>, stop: () => Promise<void>}}
   */
  #startSegmentPump({ agent, anchorId, sessionKey, onSegment }) {
    /** 本轮开始前就在 surface 里的助手消息 id（压缩后仍要挡住的那些旧话）。 */
    const preIds = new Set();
    for (const message of this.readMessages(agent)) {
      if (isAssistantMessage(message) && typeof message.id === 'string' && message.id !== '') preIds.add(message.id);
    }
    /** 本轮已经交出去的 key（消息 id / `#<下标>`）。 */
    const seen = new Set();
    let count = 0;
    let stopped = false;
    /** 串行化：两次扫描不会同时把同一段交出去，也不会乱序。 */
    let chain = Promise.resolve();

    const once = async () => {
      const found = takeNewAssistantSegments(this.readMessages(agent), { anchorId, seen, preIds });
      for (const segment of found) {
        // ⚠️ **先登记再 await**：发送可能失败，但"试图发过"就算用掉了这一段 ——
        // 否则失败的那段会在下一次扫描里被再发一遍（超时但真到了 = QQ 上两条）。
        seen.add(segment.key);
        count += 1;
        try {
          await onSegment(segment.text, count);
        } catch (error) {
          // `onSegment` 自己该吞异常；这里再兜一层，逐段发送坏了**不能**把整轮弄抛。
          this.log('warn', `第 ${count} 段外发失败（后续段照常发）${sessionKey}`, {
            error: error instanceof Error ? error.message : String(error),
            chars: segment.text.length,
          });
        }
      }
    };

    const flush = () => {
      chain = chain.then(once).catch((error) => {
        this.log('debug', `逐段发送扫描出错（已忽略）${sessionKey}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return chain;
    };

    const timer = setInterval(() => {
      if (!stopped) flush();
    }, SEGMENT_POLL_MS);
    try {
      timer?.unref?.();
    } catch {
      /* unref 失败只是多一个定时器，不影响发送 */
    }

    return {
      count: () => count,
      flush,
      /**
       * 收尾：停掉轮询，再做**最后一次**扫描。
       *
       * 最后一次是必须的：`whenIdle()` 先返回、最后那条助手消息稍后才落盘（实测就这样），
       * 不补这一次，最后一段会等到下一轮才被看见 —— 那就又变成"丢最后一段"。
       */
      stop: async () => {
        stopped = true;
        try {
          clearInterval(timer);
        } catch {
          /* 清不掉也无所谓：`stopped` 已经挡住了后续扫描 */
        }
        await flush();
      },
    };
  }

  /**
   * 挂一个 `agent/assistant-stream` 监听器，把这一轮的助手文本拼出来。
   *
   * 这是官方文档给出的流式观察点（`agent/assistant-stream`：一条 attempt 的有序
   * start / 分片 / end 帧）。它的 payload 形状在构建产物里不够确定，所以这里
   * 对多种可能的位置都做兼容，并且**只取文本块**。
   *
   * @param {any} agent
   * @returns {{text: () => string, count: () => number, stop: () => void}}
   */
  #collectStream(agent) {
    /** @type {Map<string, string[]>} attemptId → 该次 attempt 的正文分片 */
    const attempts = new Map();
    /** 最近一个收到正文分片的 attemptId（`text()` 只取它的） */
    let lastAttempt = '';
    /** @type {string[]} */
    const failures = [];
    /** @type {string[]} */
    const statuses = [];
    let frames = 0;

    /**
     * 四个监听器的解绑函数**全部**收在这里，`stop()` 一次性解完。
     *
     * ⚠️ **这里曾经只收了第一个。** `agentCtx.on(...)` 会返回一个解绑函数，但
     * 原先只把 `agent/assistant-stream` 那个存进 `stop`，另外三个（`agent/error`、
     * `agent/status`、`agent/request-error`）的返回值被直接丢掉。
     *
     * 代价不是"多几个监听器"，而是两层：
     *  1. **按轮次累积** —— agent 是跨轮次复用的（`ensure()` 先查 `this.live`
     *     缓存），所以每跑一轮就在同一个 ctx 上多留 3 个。而 Cordis 的 `ctx.on`
     *     只在**该 fiber 卸载**时才自动解绑，这里的 fiber 要等会话空闲
     *     `sessionIdleEvictHours` 小时才回收 —— 群聊白天一直有人说话就永远等不到，
     *     实际寿命约等于进程寿命。
     *  2. **闭包数组会继续吞事件** —— 这 4 个 handler 各自握着一个数组
     *     （`parts`/`failures`/`statuses`）。监听器不解绑，就意味着**每一轮留下的
     *     那些数组都还在继续接收之后所有轮次的事件**（`statuses` 每次状态变化都
     *     push），总量随运行时间近似二次增长；同时每个事件的分发要遍历 3N 个
     *     hook，线性变慢。而调试快照里看不到这个计数，属于"完全看不见的漏"。
     *
     * 取证与影响面见 `shared/2026-10-05-qq-proactive-长驻资源审计-<session-id>.md`
     * 的 H1；回归测试在 `test/binding.test.mjs` 的「每轮监听器不留残余」。
     *
     * @type {Array<() => void>}
     */
    const agentCtx = agent?.ctx;
    const disposers = [];
    /** 挂一个监听并把解绑函数收好；挂失败只记 debug，不影响这一轮。 */
    const listen = (name, handler) => {
      try {
        disposers.push(agentCtx.on(name, handler));
      } catch (error) {
        this.log('debug', `挂 ${name} 监听器失败`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    if (agentCtx !== undefined && agentCtx !== null && typeof agentCtx.on === 'function') {
      // ⚠️ 四个 handler 的**函数体自己 try/catch**：它们挂在宿主的事件派发上
      // （`ctx.on` / `agentCtx.on`），抛出去就是宿主进程里的未捕获异常。
      // 这个项目已经因为"热路径回调抛异常"崩过三次（见 AGENTS.md 那条规矩）。
      listen('agent/assistant-stream', (payload) => {
        try {
          frames += 1;
          const text = extractStreamText(payload);
          if (text === null || text === '') return;
          // 按 attempt 分桶：一次重试会让同一段正文**再流一遍**，
          // 混在一起拼就会变成两句话重复。取**最后一个 attempt** 的就是
          // 真正落盘的那一份（宿主会在 committed end 之前提交 `assistant/message`）。
          const bucket = String(payload?.frame?.attemptId ?? '');
          const list = attempts.get(bucket);
          if (list === undefined) attempts.set(bucket, [text]);
          else list.push(text);
          lastAttempt = bucket;
        } catch {
          /* 流式只是旁证，坏了不该影响这一轮 */
        }
      });
      // 这一轮为什么不产出：把 agent 自己的错误与状态变化也收进来。
      // 没有这些，失败就只表现为"没有助手发言"，看不到任何原因。
      listen('agent/error', (payload) => {
        try {
          failures.push(`agent/error: ${describeThing(payload?.error ?? payload)}`);
        } catch {
          /* 同上：旁证坏了不影响这一轮 */
        }
      });
      listen('agent/status', (payload) => {
        try {
          statuses.push(String(payload?.status ?? '?'));
        } catch {
          /* 同上 */
        }
      });
      listen('agent/request-error', (payload) => {
        try {
          failures.push(`agent/request-error: ${describeThing(payload?.failure ?? payload)}`);
        } catch {
          /* 同上 */
        }
      });
    }

    return {
      // 只取最后一个 attempt 的分片 —— 见上面分桶那段的理由。
      text: () => (attempts.get(lastAttempt) ?? []).join(''),
      count: () => frames,
      failures: () => failures.slice(),
      statuses: () => statuses.slice(),
      /** 解绑**全部**监听；幂等（重复调用时 `disposers` 已空）。 */
      stop: () => {
        for (const dispose of disposers.splice(0).reverse()) {
          try {
            dispose();
          } catch {
            /* 解绑失败无所谓 */
          }
        }
      },
    };
  }

  /**
   * 构造投给 agent 的消息。
   *
   * **两个都必须对**，否则这一轮会安静地什么都不做：
   *
   * 1. 必须是构造好的 UserMessage（带 `id` 与 `role`），不能是裸 `{content, source}`：
   *    `agent.followup(input)` 把 input 原样塞进收件箱，缺字段的消息不会被记入会话。
   * 2. `source.kind` **不能是 `'plugin'`**：那是 session v4 格式里已废弃的写法，
   *    持久化时会被直接拒绝（实测报
   *    `format v4 message requires a producer-owned source kind`），
   *    表现为"消息凭空消失、模型从不回复"。
   *    源码见 `dsh-session-format-v3-to-v4` 的 `source()`：
   *    `typeof kind !== 'string' || kind.length === 0 || kind === 'plugin'` → 抛错。
   *    官方 subagent driver 用的是 `{ kind: 'user' }`，这里跟随它。
   *
   * 宿主那边的 `createUserMessage` 本身就是
   * `deepFreeze(structuredClone({ ...input, id: randomUUID(), role: 'user' }))`，
   * 所以这里自己构造能零依赖地得到等价对象（第三方插件解析不到宿主安装树里的包）。
   *
   * @param {{prompt: string, imageBlocks?: Array<{type: 'image', attachment: any}>}} options
   */
  #buildMessage({ prompt, imageBlocks = [] }) {
    // 文本在前、图片在后 —— 与用户"先说一句话再甩图"的习惯一致，
    // 模型也更容易把图**当作那条文本的补充**而不是独立的东西。
    const content = [{ type: 'text', text: prompt }];
    for (const block of imageBlocks) content.push(block);
    return deepFreeze({
      id: randomUUID(),
      role: 'user',
      content,
      source: { kind: 'user' },
    });
  }

  /**
   * 等这一轮的新消息出现。
   *
   * 两个出口（2026-10-28 加第二个）：
   *  1. **条数涨了**（`messages.length > before`）—— 正常轮次；
   *  2. `hasAnswer(messages) === true` —— **压缩之后条数永远涨不回来**
   *     （surface 被替换成"摘要 + 本轮几条"），只能靠"本轮提示词 id 后面
   *     已经出现助手文本"来判断到站。没有这个出口的话，压缩轮必然空等满
   *     `timeoutMs`，然后拿一份切不出回复的消息表出去 —— 那正是 2026-10-28
   *     20:43 丢消息的形状。
   *
   * @param {any} agent
   * @param {number} before 本轮开始前的消息条数
   * @param {number} [timeoutMs]
   * @param {((messages: any[]) => boolean)|null} [hasAnswer] 第二个出口的判据（给了就不会抛出去）
   * @returns {Promise<any[]>}
   */
  async #waitForNewMessages(agent, before, timeoutMs = 8000, hasAnswer = null) {
    const deadline = this.now() + timeoutMs;
    let messages = this.readMessages(agent);
    const arrive = (list) => {
      if (list.length > before) return true;
      if (typeof hasAnswer !== 'function') return false;
      try {
        return hasAnswer(list) === true;
      } catch {
        // 判据自己坏了 ⇒ 当"没到"，退回老口径，绝不能因此把这一轮弄丢
        return false;
      }
    };
    while (!arrive(messages) && this.now() < deadline) {
      await delay(100);
      messages = this.readMessages(agent);
    }
    return messages;
  }

  /** 安全读取派生消息；任何失败都退化成空数组而不是炸掉一轮。 */
  readMessages(agent) {
    try {
      const session = agent?.session;
      if (session === undefined || session === null) return [];
      if (typeof session.deriveMessages !== 'function') return [];
      const messages = session.deriveMessages();
      return Array.isArray(messages) ? messages : [];
    } catch (error) {
      this.log('warn', '读取会话消息失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * 生成给网关用的 responder。
   * @returns {(request: {sessionKey: string, chatId: string, kind: string, prompt: string, restricted: boolean, signal?: AbortSignal}) => Promise<string>}
   */
  asResponder() {
    // `imageBlocks` 由网关（gateway）负责准备：它手上有原始消息段，
    // 并且注入了 `ctx.attachments`。绑定层只负责把它塞进消息内容。
    // `chatId`（P2-6）：交给 `ensure` 决定"旧 id 还是新分配"，并写映射表。
    // `onSegment`（2026-11-04）：逐段外发的回调，由网关注入（它才是走 `#send` 的那一层）。
    return async ({ sessionKey, chatId = '', prompt, signal, imageBlocks = [], onSegment = null }) =>
      this.runTurn({ sessionKey, chatId, prompt, signal, imageBlocks, onSegment });
  }

  /**
   * 释放空闲过久的会话（省内存；会话本身已持久化，之后能 resume 回来）。
   * @param {number} idleMs
   * @returns {Promise<number>} 释放了几个
   */
  async evictIdle(idleMs) {
    if (!Number.isFinite(idleMs) || idleMs <= 0) return 0;
    const deadline = this.now() - idleMs;
    let evicted = 0;
    for (const [key, entry] of [...this.live]) {
      if (entry.lastUsedAt > deadline) continue;
      this.live.delete(key);
      evicted += 1;
      try {
        await entry.handle?.dispose?.();
      } catch (error) {
        this.log('warn', `释放会话 ${key} 时出错`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (evicted > 0) this.log('info', `已释放 ${evicted} 个空闲 QQ 会话`, {});
    return evicted;
  }

  /** 全部释放。 */
  async dispose() {
    const entries = [...this.live.values()];
    this.live.clear();
    for (const entry of entries) {
      // 🔴 **root 托管的 agent 不释放**（2026-10-20 架构改动的另一半）。
      //
      // 插件卸载时 `index.mjs` 会调 `binder.dispose()`（`qq-proactive: shutdown`）。
      // 而 `owner: 'root'` 那些 handle 的 `dispose` 是**真的 teardown** ——
      // 在这里调它 = 插件自己把"跨热重载存活"这件事亲手抵掉：agent 照样被 dispose、
      // 正在跑的那一轮照样 `aborted/disposed`。
      //
      // ⚠️ 但**不是所有卸载都要留**：`evictIdle()` 是"省内存"的主动释放，那条路照旧
      // 调 dispose（会话已持久化，下次 ensure 会 root resume 回来）。
      if (entry.owner === 'root') {
        this.log('info', `插件卸载：保留 root 托管的 agent ${entry.sessionKey}（跨热重载存活）`, {
          sessionKey: entry.sessionKey,
          via: 'root',
        });
        continue;
      }
      try {
        await entry.handle?.dispose?.();
      } catch (error) {
        this.log('warn', '释放会话时出错', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/** 把 chatId 直接换成会话键（转发给 routing，避免两处规则漂移）。 */
export function sessionKeyForChat(chatId) {
  return sessionKeyFromChatId(chatId);
}

/** 会话 cwd 的兜底：宿主进程的工作目录。 */
function defaultCwd() {
  try {
    return process.cwd();
  } catch {
    return '.';
  }
}

/** 把任意东西压成一行可读文本。 */
function describeThing(value) {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 小工具：可被取消的延迟。 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * 从一帧 `agent/assistant-stream` payload 里抽出文本。
 *
 * ## 真实形状（2026-10-28 核实，别再猜）
 *
 * 宿主 `agent-loop` 的发点是：
 *
 * ```js
 * this.dispatch.emit("agent/assistant-stream", { frame });
 * ```
 *
 * 而 `frame` 的契约（`dsh-agent` 的类型声明）是：
 *
 * ```ts
 * type SessionAssistantStreamFrame =
 *   | { type: 'start'; attemptId; revision; startedAfterSeq; turn; step }
 *   | { type: 'chunk'; attemptId; revision; index; time; chunk: JsonValue }
 *   | { type: 'end';   attemptId; revision; index; outcome: {...} }
 * ```
 *
 * 正文在 **`frame.chunk`** 里，而 `chunk` 是 LLM 的 `StreamChunk`：
 *
 * ```ts
 * { type: 'text-delta'; index: number; text: string }
 * | { type: 'reasoning-delta'; ... }   // ← 思考，不是回复，不能发到 QQ
 * | { type: 'tool-call-delta'; ... } | { type: 'block-end'; block } | ...
 * ```
 *
 * 🔴 **这条路径以前是死的**：老实现只看 `payload / payload.frame / payload.delta /
 * payload.chunk` 上的 `text|delta|content`，而正文在 `payload.frame.chunk.text` ——
 * **差一层**。于是 `agent/assistant-stream` 明明来了（`streamFrames: 3`）、
 * 却一个字符都抽不出来（`streamedChars: 0`），兜底等于不存在。
 * 2026-10-28 20:43 那一轮的回复就是这么丢的（压缩把那轮的主路径也弄空了，
 * 两条路同时空 ⇒ 网关当"模型不说话"静默丢弃）。
 *
 * 取不到就返回 null（不猜）；`reasoning-delta` 也返回 null（那不是她要发的话）。
 *
 * @param {any} payload
 * @returns {string|null}
 */
export function extractStreamText(payload) {
  if (payload === null || payload === undefined) return null;
  // ① 宿主真实形状：{ frame: { type: 'chunk', chunk: StreamChunk } }
  const frame = payload.frame;
  if (frame !== null && typeof frame === 'object' && typeof frame.type === 'string') {
    // start / end 帧没有正文；只认 chunk。
    if (frame.type !== 'chunk') return null;
    const chunk = frame.chunk;
    if (chunk === null || chunk === undefined || typeof chunk !== 'object') return null;
    if (typeof chunk.type === 'string') {
      // 只认 text-delta：reasoning-delta 是思考过程，发出去就是泄漏 + 答非所问。
      return chunk.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : null;
    }
    // chunk 自身没有 type（形状不认识）⇒ 退回通用提取，仍不猜。
    return pickText(chunk);
  }
  // ② 老形状（构建产物里不确定时期的兼容）：直接在 payload / 子对象上找文本。
  const candidates = [payload, payload.frame, payload.delta, payload.chunk];
  for (const candidate of candidates) {
    const direct = pickText(candidate);
    if (direct !== null) return direct;
  }
  return null;
}

/** 从一个对象上找出文本字段。 */
function pickText(value) {
  if (value === null || typeof value !== 'object') return null;
  if (typeof value.text === 'string' && value.text !== '') return value.text;
  if (typeof value.delta === 'string' && value.delta !== '') return value.delta;
  if (Array.isArray(value.content)) {
    const parts = [];
    for (const block of value.content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) return parts.join('');
  }
  return null;
}
