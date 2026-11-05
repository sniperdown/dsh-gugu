/**
 * QQ ↔ DSH 会话路由：访问控制、会话身份映射、入站消息的处置决策。
 *
 * 纯逻辑，零 DSH 耦合。这一层决定"这条消息该不该处理、该进哪个会话、
 * 该由被动通道还是主动通道接"。它不需要网络也不需要模型，所以可以全量测。
 *
 * ⚠️ **唯一的 import** 是 `../proactive/engine.mjs` 的 `formatStamp`（2026-10-13 加的）：
 * 这里原来有一份私有的 `formatClock`（裸 `HH:MM`），而转录行那边已经换成
 * `formatStamp`（不是当天就带日期）—— 两份实现放在两个文件里迟早漂移，
 * 所以**直接复用那一份**，本文件不再自己拼时钟。
 * 那个模块**不 import 本文件**（它唯一的 import 是零依赖的 `dsh/heuristic-gauge.mjs`）
 * ⇒ **不构成环**。
 *
 * 三条硬约束（来自需求）：
 * 1. **每个 QQ 会话一个独立持久会话**：群的归群、私聊归私聊，互不污染上下文。
 * 2. **会话 id 必须稳定可派生**：重启后要靠它 resume 回原来的对话，不能每次新开。
 * 3. **默认拒绝**：没有明确放行的人和群，一律不处理。群里机器人应答错话的代价
 *    远大于漏掉一条。
 *
 * @module qq-dsh/routing
 */

/** `HH:MM` / `MM-DD HH:MM` / `YYYY-MM-DD HH:MM` —— 时间戳只有这一份实现。 */
import { formatStamp } from '../proactive/engine.mjs';

/** 私聊与群聊的策略枚举。 */
export const POLICY = {
  /** 仅管理员可用（私聊默认）。 */
  ADMIN: 'admin',
  /** 仅白名单可用。 */
  ALLOWLIST: 'allowlist',
  /** 所有人都可用（慎用）。 */
  OPEN: 'open',
  /** 全部拒绝。 */
  DISABLED: 'disabled',
};

/** 消息的处置结果。 */
export const ACTION = {
  /** 交给被动通道：进该会话的 Agent 并触发一轮回复。 */
  DISPATCH: 'dispatch',
  /** 只记入转录，不触发回复（供主动通道判断话题）。 */
  OBSERVE: 'observe',
  /** 完全丢弃。 */
  IGNORE: 'ignore',
};

/**
 * 归一化管理员/白名单配置：去掉空白、统一成字符串、去重。
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeIdList(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (item === undefined || item === null) continue;
    const text = String(item).trim();
    if (text === '' || !/^\d+$/.test(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 默认配置。刻意偏保守：私聊仅管理员、群聊需 @、安静时段开着。
 * @returns {object}
 */
export function defaultConfig() {
  return {
    mode: 'reverse',
    host: '127.0.0.1',
    port: 8643,
    url: 'ws://127.0.0.1:3001',
    accessToken: '',
    botQQ: '',
    adminUsers: [],
    allowFrom: [],
    groupAllowFrom: [],
    dmPolicy: POLICY.ADMIN,
    groupPolicy: POLICY.ADMIN,
    /** 私聊去向：isolated（每个联系人一个独立会话，默认）或 main（统一进主会话）。 */
    dmRouting: DM_ROUTING.ISOLATED,
    /**
     * dmRouting=main 时的目标会话 id（DSH session id，不是 chatId）。
     * **必填**：留空会回落到 isolated 并记一条日志——隐式挑"主会话"太难排查。
     */
    mainSessionKey: '',
    /** 群聊是否需要被 @ 或回复才响应。 */
    requireMention: true,
    /** 群聊里非管理员消息是否加软限制前缀（只问答、不动工具）。 */
    restrictMembers: true,
    /** 每个会话的 Agent 挂载的 preset（留空用部署默认）。 */
    agentPreset: '',
    /** 每个会话的工作目录（留空用宿主 cwd）。 */
    workspacePath: '',
    /** 一次回复的字符上限，超出截断（QQ 单条消息有长度限制）。 */
    maxReplyChars: 2000,
  };
}

/**
 * 群聊策略的语义（`groupPolicy` 字段）：
 *
 * | 值 | 哪些群被允许 | 群里谁能让机器人回话 |
 * |---|---|---|
 * | `admin`（默认） | 仅 `groupAllowFrom` | 仅管理员 |
 * | `allowlist` | 仅 `groupAllowFrom` | 任何人（需 @，见 `requireMention`） |
 * | `open` | 任何群 | 任何人（需 @） |
 * | `disabled` | 无 | 无（且连转录都不记） |
 *
 * 与私聊策略刻意不同：私聊的 `open` 就是字面意思，而群聊多一个"允许的群"维度，
 * 所以 `admin` 的含义是"白名单群 + 仅管理员发言"。
 */

/**
 * 访问控制与路由决策器。
 */
export class Router {
  /**
   * @param {object} config
   * @param {object} [options]
   * @param {(chatId: string) => (string|null)} [options.sessionLookup]
   *   会话映射表的**纯读**查询（2026-10-24，P1-4）。给了就"表优先、旧前缀兜底"；
   *   不给 ⇒ 与改动前逐字一致（测试/老调用方不受影响）。
   *   ⚠️ 只许传纯读函数（`lookup`），**不许传会分配 id 的** —— Router 用在
   *   `resolve()` 这种每消息一次的判定路径上，这里建 id 会让"没落库的聊天"凭空建会话。
   */
  constructor(config = {}, { sessionLookup = null } = {}) {
    const merged = { ...defaultConfig(), ...config };
    this.config = merged;
    this.sessionLookup = typeof sessionLookup === 'function' ? sessionLookup : null;
    this.adminUsers = new Set(normalizeIdList(merged.adminUsers));
    this.allowFrom = new Set(normalizeIdList(merged.allowFrom));
    this.groupAllowFrom = new Set(normalizeIdList(merged.groupAllowFrom));
  }

  /** 该 QQ 是否管理员。 */
  isAdmin(userId) {
    return this.adminUsers.has(String(userId));
  }

  /**
   * 该私聊用户是否被允许。
   * @param {string} userId
   */
  dmAllowed(userId) {
    const policy = this.config.dmPolicy;
    if (policy === POLICY.DISABLED) return false;
    if (policy === POLICY.OPEN) return true;
    if (policy === POLICY.ALLOWLIST) return this.allowFrom.has(String(userId));
    // POLICY.ADMIN 与任何未知值都按最严处理（fail-closed）。
    return this.isAdmin(userId);
  }

  /**
   * 该群是否在允许范围内（只看"群"，不看发言人）。
   *
   * 群号形状不合法一律拒绝：`groupPolicy: 'open'` 意味着"任何群都行"，
   * 而空串/非数字的群号不是"任何群"，是坏数据。放行它等于让一条畸形事件
   * 绕过整条访问控制。
   * @param {string} groupId
   */
  groupAllowed(groupId) {
    if (!isValidId(groupId)) return false;
    const policy = this.config.groupPolicy;
    if (policy === POLICY.DISABLED) return false;
    if (policy === POLICY.OPEN) return true;
    // allowlist / admin / 未知值都要求群在白名单里。
    return this.groupAllowFrom.has(String(groupId));
  }

  /**
   * 群里的这个发言人能否让机器人回话。
   * @param {string} userId
   */
  groupSpeakerAllowed(userId) {
    if (this.config.groupPolicy === POLICY.ADMIN) return this.isAdmin(userId);
    return true;
  }

  /**
   * 决定一条入站消息怎么处置。
   *
   * @param {import('../onebot/protocol.mjs').InboundMessage} message
   * @returns {{action:string, reason:string, restricted:boolean, sessionKey:string}}
   */
  resolve(message) {
    if (message === null || typeof message !== 'object') {
      return { action: ACTION.IGNORE, reason: 'bad-message', restricted: false, sessionKey: '' };
    }
    // 表优先、旧前缀兜底（P1-4）。没注入 lookup ⇒ 与改动前逐字一致。
    const mapped = this.sessionLookup !== null ? this.sessionLookup(message.chatId) : null;
    const sessionKey = typeof mapped === 'string' && mapped.trim() !== ''
      ? mapped.trim()
      : sessionKeyFor(message);

    if (message.kind === 'private') {
      if (!this.dmAllowed(message.userId)) {
        return {
          action: ACTION.IGNORE,
          reason: `dm-denied(${this.config.dmPolicy})`,
          restricted: false,
          sessionKey,
        };
      }
      return {
        action: ACTION.DISPATCH,
        reason: 'dm-allowed',
        restricted: !this.isAdmin(message.userId),
        sessionKey,
      };
    }

    if (message.kind === 'group') {
      const groupId = message.groupId ?? '';
      if (!this.groupAllowed(groupId)) {
        // 群不在允许范围：仍记转录（运维想看群里在聊什么），但不回复。
        // 例外是 disabled，那是明确要求完全不看。
        const observe = this.config.groupPolicy !== POLICY.DISABLED;
        return {
          action: observe ? ACTION.OBSERVE : ACTION.IGNORE,
          reason: `group-denied(${this.config.groupPolicy})`,
          restricted: true,
          sessionKey,
        };
      }
      // 群允许了，但发言人可能不被允许（admin 策略下只有管理员能唤起机器人）。
      if (!this.groupSpeakerAllowed(message.userId)) {
        return { action: ACTION.OBSERVE, reason: 'group-speaker-denied', restricted: true, sessionKey };
      }
      // ⚠️ 这里**不再按"有没有 @"切换通道**。
      //
      // 旧实现是：`requireMention && !mentioned` → OBSERVE（转给主动插话引擎），
      // 于是 @ 成了"切换通道"的开关。MaiBot 不是这么做的 —— 它把所有消息送进
      // **同一条打分链**，@ 只是把分数顶到必回（`at_bot_inevitable_reply = 1.0`）。
      // 硬分通道的后果实测到了：私聊/被 @ 时两个通道同时响应，小鲸鱼回两条。
      //
      // 现在统一交给判定层（`engine.decide`）决定说不说，回复一律走会话。
      return {
        action: ACTION.DISPATCH,
        reason: 'group-allowed',
        restricted: this.config.restrictMembers === true && !this.isAdmin(message.userId),
        sessionKey,
      };
    }

    return { action: ACTION.IGNORE, reason: 'unknown-kind', restricted: false, sessionKey };
  }

  /**
   * 是否允许主动发言到某个会话。
   *
   * 主动发言比被动回复更危险（被动是"有人叫我才答"，主动是"我自己凑上去"），
   * 所以**私聊**这一路刻意更严：只有当前私聊策略就允许的人，才允许被主动搭话。
   *
   * **群聊这一路与 `groupAllowed` 保持一致**。早先它在 `open` + 白名单非空时
   * 收窄到了白名单，而 `groupAllowed` 在 `open` 下允许任何群——同一个策略字段
   * 在两条路径上含义不同，结果是"群能用机器人、消息也进了转录、判定也跑了，
   * 但冒泡被静默拒绝"，用户只看到"机器人在群里但从不说主动话"。
   * 同一个字段不该有两种解释，所以现在群聊的准入就是群聊策略本身。
   * @param {string} chatId
   * @returns {boolean}
   */
  proactiveAllowed(chatId) {
    const index = String(chatId).indexOf(':');
    const kind = index === -1 ? '' : String(chatId).slice(0, index);
    const target = index === -1 ? '' : String(chatId).slice(index + 1);
    // 目标形状不合法一律拒绝：主动发言是"我自己凑上去"，不能让坏数据绕过边界。
    if (!isValidId(target)) return false;
    if (kind === 'group') return this.groupAllowed(target);
    if (kind === 'private') return this.dmAllowed(target);
    return false;
  }
}

/** QQ 号/群号的合法形状：纯数字、非空。 */
function isValidId(value) {
  return typeof value === 'string' && value !== '' && /^\d+$/.test(value);
}

/**
 * 派生出该 QQ 会话对应的 DSH 会话键。
 *
 * 必须**稳定且可逆地**从 chatId 推出来：重启后要用同一个键去 resume。
 * 所以这里只做字符替换，不引入随机数或时间戳。
 * @param {import('../onebot/protocol.mjs').InboundMessage} message
 * @returns {string}
 */
export function sessionKeyFor(message) {
  if (message === null || typeof message !== 'object') return '';
  return sessionKeyFromChatId(message.chatId);
}

/**
 * **纯格式**解析 chatId（2026-10-24，P0-2）。
 *
 * 只回答"这个字符串是不是一个合法的 chatId"，**不查任何表、不碰任何状态**。
 * 存在的理由：`resolveConfig()` 里的 `report.target` 校验以前拿 `sessionKeyFromChatId()`
 * 当格式校验器 —— 一旦那个函数改成"查映射表"，表里没有这条 chatId（新装 / 清状态后
 * 首启）就会抛 ⇒ 插件 apply 失败 ⇒ **整个 App 起不来**（2026-10-14 连崩三次的事故形状）。
 * ⇒ 启动路径只许用这个纯函数；映射 miss 只能 warn，不能抛。
 *
 * @param {unknown} chatId
 * @returns {{kind: 'group'|'private', id: string} | null} 不合法 ⇒ `null`
 */
export function parseChatId(chatId) {
  const text = String(chatId ?? '');
  const index = text.indexOf(':');
  if (index === -1) return null;
  const kind = text.slice(0, index);
  const id = text.slice(index + 1);
  if ((kind !== 'group' && kind !== 'private') || !/^\d+$/.test(id)) return null;
  return { kind, id };
}

/**
 * chatId → 会话键。
 *
 * 形如 `qq-group-100` / `qq-private-2001`。前缀固定成 `qq-` 便于在会话列表里一眼认出，
 * 也避免和 Web 会话的 id 撞车。
 *
 * ⚠️ 这是**旧的拼串规则**（迁移清单 §3 #8）：等映射表落地后，正式路径要改成
 * `lookup(chatId) ?? 旧前缀`；这个函数退化成"回退分支"，并改名/加 deprecated 说明。
 * @param {string} chatId
 * @returns {string}
 */
export function sessionKeyFromChatId(chatId) {
  const parsed = parseChatId(chatId);
  if (parsed === null) return '';
  return `qq-${parsed.kind}-${parsed.id}`;
}

/**
 * 会话键 → chatId（逆运算，诊断与工具回调用）。
 * @param {string} sessionKey
 * @returns {string}
 */
export function chatIdFromSessionKey(sessionKey) {
  const match = /^qq-(group|private)-(\d+)$/.exec(String(sessionKey ?? ''));
  if (match === null) return '';
  return `${match[1]}:${match[2]}`;
}

/** 私聊消息的去向。 */
export const DM_ROUTING = {
  /** 每个私聊联系人一个独立持久会话（默认）。 */
  ISOLATED: 'isolated',
  /** 全部私聊进同一个指定会话（"主会话"）。 */
  MAIN: 'main',
};

/**
 * 决定一条入站消息落到哪个会话。
 *
 * 抽成纯函数是为了让"消息到底进了哪个会话"完全可测——这条一旦错了，
 * 表现是"机器人答非所问"，而从日志上很难看出是路由错了还是模型错了。
 *
 * 规则：
 * - 群聊：永远用 `qq-group-<群号>`（需求要求群聊隔离）。
 * - 私聊 + `isolated`：用 `qq-private-<QQ号>`。
 * - 私聊 + `main`：用配置的 `mainSessionKey`。
 *
 * **`main` 模式缺 `mainSessionKey` 时回落到 isolated**，并给出原因——这是刻意的：
 * 隐式挑一个"主会话"会让排查变得很难（"它为什么答的是那个会话的内容"），
 * 而显式回退至少行为可预测。
 *
 * @param {import('../onebot/protocol.mjs').InboundMessage} message
 * @param {object} config
 * @param {object} [options]
 * @param {(chatId: string) => (string|null)} [options.lookup]
 *   会话映射表的**纯读**查询（P1-4）。给了就表优先、旧前缀兜底。
 *   ⚠️ 只许纯读 —— 这里每消息一次，不能顺手建 id。
 * @returns {{sessionKey: string, reason: string}}
 */
export function resolveSessionTarget(message, config = {}, { lookup = null } = {}) {
  if (message === null || typeof message !== 'object') {
    return { sessionKey: '', reason: 'bad-message' };
  }
  const mapped = typeof lookup === 'function' ? lookup(message.chatId) : null;
  const fromTable = typeof mapped === 'string' && mapped.trim() !== '';
  const derived = fromTable ? mapped.trim() : sessionKeyFor(message);
  if (derived === '') return { sessionKey: '', reason: 'unresolvable-chat-id' };

  if (message.kind !== 'private') {
    return { sessionKey: derived, reason: fromTable ? 'group-mapped' : 'group-isolated' };
  }

  const routing = config.dmRouting ?? DM_ROUTING.ISOLATED;
  if (routing !== DM_ROUTING.MAIN) {
    return { sessionKey: derived, reason: fromTable ? 'dm-mapped' : 'dm-isolated' };
  }

  const main = String(config.mainSessionKey ?? '').trim();
  if (main === '') {
    return { sessionKey: derived, reason: 'dm-main-missing-key(fallback-isolated)' };
  }
  return { sessionKey: main, reason: 'dm-main' };
}

/**
 * 把入站消息渲染成给模型看的提示词正文。
 *
 * 群聊要带发言人前缀，否则模型分不清谁在说话（多人群聊里这是必需信息）。
 * 私聊不需要**发言人**前缀——上下文里只有两个人；但**时间戳两边都带**。
 *
 * ## 时间戳（2026-10-13 改）
 *
 * 行首时间戳一律由 {@link formatStamp} 产出：**当天 `HH:MM`、不是当天带日期**
 * （`10-03 14:30`，跨年 `2025-12-31 23:50`）。用户原话：
 * 「**还是带，所有的消息都带时间戳**」—— 之前这里只有裸 `HH:MM`，
 * 于是"刚 @ 你的那条"到底是今天的还是昨天的，模型看不出来。
 *
 * ⚠️ **`now` 必须可注入**（默认写在参数里，测试才钉得住"当天"那条分支）。
 *
 * @param {import('../onebot/protocol.mjs').InboundMessage} message
 * @param {object} [options]
 * @param {boolean} [options.restricted] 是否加软限制前缀
 * @param {number} [options.utcOffsetMinutes] 时区偏移，缺省 480（UTC+8）
 * @param {string} [options.text] **覆盖正文**。
 *   用于「合并转发 / 文件」这类段被展开后的富文本（见 onebot/rich.mjs）——
 *   它只该进提示词，不该污染 `message.text`（判定与打分用的是后者）。
 * @param {number} [options.now] **"现在"**（毫秒），只用来判"是不是当天"。
 * @returns {string}
 */
export function renderPrompt(message, {
  restricted = false,
  utcOffsetMinutes = 480,
  text,
  now = Date.now(),
} = {}) {
  const body = String(text ?? message?.text ?? '').trim();
  // 时间戳缺失就退回"现在"（改动前 `formatClock` 就是这么兜底的），
  // 免得渲染出一行 `[NaN:NaN 昵称(号)]`。`at === now` ⇒ 必然是当天 ⇒ 裸 `HH:MM`。
  const at = Number.isFinite(message?.at) ? message.at : now;
  const stamp = formatStamp(at, { now, utcOffsetMinutes });

  // 私聊：**不带发言人前缀**（上下文里只有两个人），但**时间戳照带** ——
  // 用户要的是"所有消息都能看出是什么时候说的"。
  // 空正文仍然什么都不产出：别留一行只有时间戳的噪音。
  if (message?.kind !== 'group') {
    return body === '' ? '' : `[${stamp}] ${body}`;
  }

  const nickname = message.nickname === '' ? message.userId : message.nickname;
  const prefix = `[${stamp} ${nickname}(${message.userId})]`;
  const restriction = restricted ? '[受限用户:仅问答]' : '';
  return `${restriction}${prefix} ${body}`.trim();
}

/**
 * 截断过长回复。QQ 单条消息有长度上限，超长会被拒绝或切成多段；
 * 这里先截断并加省略标记，保证一定能发出去。
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function truncateReply(text, limit) {
  const body = String(text ?? '');
  if (!Number.isFinite(limit) || limit <= 0) return body;
  // 按码点切，避免把 emoji 的代理对拆成半个字符。
  const points = Array.from(body);
  if (points.length <= limit) return body;
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
}
