/**
 * **插件启动时，从 NapCat 拉最近的历史消息，灌进转录**（2026-10-13）。
 *
 * ## 为什么需要它
 *
 * `ProactiveEngine.transcripts` 是**纯内存**的 `Map` ⇒ 插件一重载/重启就空。
 * 用户 2026-10-13 的要求：
 *
 * > 「**只要进 llm 了就塞 20 条前文，不管是多久的**」
 *
 * 这句话在"同一个进程里跨时间"是成立的（转录不再按时间窗裁剪了），
 * 但**跨重启不成立** —— 重启之后小鲸鱼看到的前文是空的，于是它对着一个聊了
 * 半天的群，像刚进群一样插一句不相干的话。
 *
 * ⚠️ **"NapCat 自己存消息、所以拉不到关机期间的"这个假设是错的**（已实测）：
 * 用户 04:25 关机、12:22 开机，期间群里 14 条（08:03→12:14），
 * `get_group_msg_history` **一条不少**。NapCat 不存库（`D:\QQNT\data\NapCat` 是空的），
 * 它读的是 **QQ 自己的库**，登录后同步 ⇒ 关机期间的消息照样在。
 *
 * ## 三条硬约束（照用户 2026-10-13 定的设计）
 *
 * ### ① 只拉**白名单里的会话**
 * 不在白名单的群**只被 `OBSERVE`**（转录对它们没用），拉了纯属白花一次 API。
 * 白名单判断**直接复用 `Router.proactiveAllowed()`** —— 不另写一份判据，
 * 免得"哪个算是允许的会话"出现两种解释（`routing.mjs` 里为这件事踩过坑）。
 *
 * ### ② 🔴 **只当上下文，绝不触发判定**
 * **开机后绝不能因为灌进来的旧消息去回一条 8 小时前的消息。**
 * 灌进去的**唯一出口**是两个"只写内存"的方法（`Transcript.restore` /
 * `ChatState.restoreContext`）—— 本模块**从头到尾没有** `decide` / `#gate` /
 * 任何会 `dispatched++` 的调用。所以"回复一条旧消息"不是"被判断为不该发生"，
 * 而是**结构上没有那条路**。
 *
 * ### ③ **失败静默降级、不阻塞启动**
 * 插件挂载的时刻 QQ 很可能还没登录、NapCat 还没连上（实测见过
 * `OneBot 未连接`）⇒ 拉取**必须**异步、带超时、逐会话 try/catch，
 * 一个会话失败**不影响**其他会话，也**不影响**插件挂载本身。
 * 这是"锦上添花"的功能：拿不到就当没有，**绝不能因此拖慢或搞挂启动**。
 *
 * ## 灌进去之后转录里是什么样
 *
 * 与实时消息**完全同形**（`renderEntries` 只认 `InboundMessage` 的
 * `at` / `nickname` / `userId` / `text`），所以提示词里就是普通的一行行
 * `[08:03] 用户(30000001): 这是片能出现的东西？`
 * —— 不会因为"是补的"而带上任何标记。
 */

import { toSegments, segmentsToText } from '../onebot/protocol.mjs';

/** 每个会话默认拉最近多少条。 */
export const DEFAULT_COUNT = 20;

/**
 * 拉取窗口的**下限**。
 *
 * 为什么不直接 `count: 20`：转录只要 20 条，但**上下文恢复**（她最后一条是不是问句）
 * 看的是同一个窗口里的**自己发言**，而那些发言**占窗口名额**（NapCat 的历史里
 * 小鲸鱼自己的消息也在）。拉 20 条时，如果最近 20 条里有 6 条是小鲸鱼说的，
 * 就只剩 14 条别人的话进转录；更糟的是她上一句话可能正好被挤出窗口 ⇒
 * `lastBotWasQuestion` 恢复不出来。
 * 多拉一些（50）成本一样（一次 API 调用），但窗口覆盖得住。
 */
export const FETCH_FLOOR = 50;

/** 单次 `fetch` 的超时（毫秒）。默认宁快勿慢 —— 失败可以忽略，卡住不行。 */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 白名单里的会话 → chatId 列表。
 *
 * ⚠️ **判断"在不在白名单"用的是 `router.proactiveAllowed(chatId)`**，
 * 而不是自己去读 `config.groupAllowFrom` / `config.allowFrom`：
 * 那两份名单只是 `Router` 的输入，实际生效值还受 `groupPolicy` / `dmPolicy` 影响，
 * 而且 `routing.mjs` 已经为"同一个字段两种解释"踩过坑（见 `proactiveAllowed` 的注释）。
 *
 * @param {import('./routing.mjs').Router} router
 * @returns {string[]} 形如 `group:30000012` / `private:30000001`
 */
export function allowedChatIds(router) {
  if (router === null || router === undefined) return [];
  const ids = [];
  const push = (chatId) => {
    try {
      // 白名单是**用户手写的配置**，里面可能有空串/坏形状 ⇒ 逐个过 `proactiveAllowed`，
      // 它内部会做形状校验（`isValidId`），坏的一次直接丢掉。
      if (router.proactiveAllowed(chatId) === true) ids.push(chatId);
    } catch {
      /* 一条坏配置不该让整次灌历史失败 */
    }
  };
  for (const id of router.groupAllowFrom ?? []) push(`group:${String(id)}`);
  for (const id of router.allowFrom ?? []) push(`private:${String(id)}`);
  return ids;
}

/**
 * 把一条历史消息里的一行渲染文本取出来。
 *
 * ⚠️ **归一化一律走 `protocol.mjs`**，这里不自己写一套。原因：
 * **NapCat HTTP API 返回的段形状和实时事件不一样**（实时是 `{type, data:{…}}`，
 * 历史接口在某些版本上给的是已压平的 `{type, text}` / `{type, qq}`）——
 * `media.mjs` 里有实测记录，而 `toSegments` 早就是"两种形状都吃、统一输出压平形状"
 * 的那一层。绕过它自己 `s.data?.text` 一下，就会在另一个版本上变成"一群空消息"。
 *
 * @param {any} message 历史接口里的一条消息
 * @param {object} [options]
 * @param {(qq: string, groupId?: string) => string} [options.resolveAt]
 *   `QQ → 昵称` 查表函数（见 `protocol.mjs` 的 `formatAtSegment`）。
 *   不给 ⇒ 历史里的 `@某人` 会渲染成 `@QQ号`（老行为）。
 * @param {string} [options.groupId] 这条消息所属的群（查群名片那一层要用）
 * @returns {string} 可能为空串（这条只有图/语音）
 */
export function historyMessageText(message, { resolveAt, groupId } = {}) {
  const raw = message?.message ?? message?.raw_message;
  return segmentsToText(toSegments(raw), { resolveAt, groupId });
}

/**
 * 把一条历史消息喂给 {@link messageToTarget} 的那份"事件形状"。
 *
 * `normalizeEvent` 要求 `post_type` / `message_type` / `user_id` 齐全
 * （它给实时事件用的），历史接口只给 `user_id` + `message` + `time` ⇒ 这里补齐。
 *
 * ⚠️ **不做"是不是自己发的"过滤**：那一层留在本模块（见 `isSelfMessage`），
 * 因为**自己发的消息也要用**（喂上下文），只是不进转录。
 *
 * @param {any} message
 * @param {{chatId: string, kind: 'group'|'private', groupId?: string}} shape
 * @returns {object}
 */
export function historyEvent(message, { chatId, kind, groupId }) {
  const event = {
    post_type: 'message',
    message_type: kind,
    message_id: message?.message_id,
    user_id: message?.user_id,
    sender: message?.sender,
    message: message?.message,
    raw_message: message?.raw_message,
  };
  if (kind === 'group') {
    event.group_id = groupId;
    event.self_id = message?.self_id;
  }
  return event;
}

/**
 * 这条历史消息是不是**小鲸鱼自己**发的。
 *
 * 判据两条，任一成立即算（**偏向"算成自己的"** —— 把别人的话漏进上下文，
 * 比把自己的一句话排除在转录外，代价大得多）：
 *   1. `user_id === selfId`
 *   2. 段数组里有段带 `post_type === 'self'`（部分实现会这么标）
 *
 * @returns {boolean}
 */
export function isSelfMessage(message, selfId) {
  const uid = message?.user_id;
  if (uid !== undefined && uid !== null && String(uid) !== '' && String(uid) === String(selfId)) return true;
  const segments = toSegments(message?.message ?? message?.raw_message);
  return segments.some((s) => s.post_type === 'self');
}

/** 一条历史消息 → 可以直接灌进数据的形状（或 null = 这条进不了转录）。 */
function toTarget(message, shape, resolveAt) {
  const text = historyMessageText(message, { resolveAt, groupId: shape.groupId });
  if (text === '') return null;
  const event = historyEvent(message, shape);
  const rawId = event.message_id;
  const messageId = typeof rawId === 'number' && Number.isFinite(rawId)
    ? rawId
    : (rawId === undefined || rawId === null || rawId === '' ? null : Number(rawId));
  const nickname = String(message?.sender?.card || message?.sender?.nickname || '').trim();
  return {
    chatId: shape.chatId,
    kind: shape.kind,
    userId: String(event.user_id ?? ''),
    nickname: nickname === '' ? '' : nickname,
    text,
    at: Number.isFinite(Number(message?.time)) && Number(message?.time) > 0
      ? Number(message.time) * 1000
      : null,
    messageId: Number.isFinite(messageId) ? messageId : undefined,
    segments: event.message,
  };
}

/**
 * 只保留"她说了什么"的那条自己发言（转录不收自己，见 `decide()` 的
 * `fromSelf` 早退）—— 但**上下文要用**，所以单独留一份。
 */
function toSelfTarget(message, shape) {
  const text = historyMessageText(message);
  const at = Number(message?.time);
  if (!Number.isFinite(at) || at <= 0) return null;
  return { at: at * 1000, text };
}

function normalizeCallOptions(options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  return opts.signal === undefined ? { timeoutMs } : { timeoutMs, signal: opts.signal };
}

/** `setTimeout(…).unref()` —— 一个后台预热功能不该把进程钉着不退出。 */
function unref(timer) {
  if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  return timer;
}

/**
 * 拉一个会话最近的历史消息 → 归一化后的条目。
 *
 * 成功返回 `{chatId, selfId, messages, selfMessages}`；**失败一律抛**，
 * 由调用方（{@link backfillChat}）转成"这个会话降级、别的照常"。
 *
 * @param {object} options
 * @param {string} options.chatId `group:30000012` / `private:30000001`
 * @param {(action: string, params?: object, opts?: object) => Promise<any>} options.call
 *   OneBot 调用器。生产上就是 `transport.action`（字段会被平铺到顶层，
 *   见 `transport.mjs:219-231` 那个"没平铺会被 NapCat 拒"的坑）。
 * @param {number} [options.count] 要多少条（缺省 `DEFAULT_COUNT`）
 * @param {string} [options.selfId] 小鲸鱼自己的 QQ 号
 * @param {number} [options.timeoutMs] 单次调用超时
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.nicknames] **`QQ → 昵称` 表**（`nicknames.mjs` 的产物，2026-10-14 加）。
 *   灌历史时**顺便把这一窗里每个人的名字都学进去**（那些历史消息的 `sender` 里就有），
 *   然后渲染 `@` 段时查它。这条路很重要：**HMR 每次重载都会清空转录**，
 *   而"重载后立刻又能从历史灌回来"正是这张表能自愈的原因。
 * @returns {Promise<{chatId: string, kind: string, messages: object[], selfMessages: object[]}>}
 */
export async function fetchHistory({
  chatId,
  call,
  count = DEFAULT_COUNT,
  selfId = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  nicknames = null,
} = {}) {
  if (typeof call !== 'function') throw new Error('backfill: 缺少 call（OneBot 调用器）');
  const text = String(chatId ?? '');
  const index = text.indexOf(':');
  const kind = index === -1 ? '' : text.slice(0, index);
  const target = index === -1 ? '' : text.slice(index + 1);
  if ((kind !== 'group' && kind !== 'private') || target === '') {
    throw new Error(`backfill: 无效的 chatId ${JSON.stringify(chatId)}`);
  }
  // 多拉一些：窗口里小鲸鱼自己的发言也占名额（见 `FETCH_FLOOR` 的说明）。
  const want = Number.isFinite(count) && count > 0 ? Math.max(Math.floor(count), FETCH_FLOOR) : FETCH_FLOOR;
  const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
  const params = kind === 'group' ? { group_id: target, count: want } : { user_id: target, count: want };

  const data = await call(action, params, normalizeCallOptions({ timeoutMs, signal }));
  const list = Array.isArray(data) ? data : data?.messages;
  if (!Array.isArray(list)) {
    throw new Error(`backfill: ${action} 没有返回 messages 数组（拿到 ${typeof data}）`);
  }

  const shape = { chatId: text, kind, groupId: kind === 'group' ? target : undefined };

  // ── 先学名字，再渲染正文（2026-10-14 加）──
  //
  // 为什么分两步、而不是"边渲染边学"：**同一条历史消息里的 at 段要查名字**，
  // 而那个名字可能在**它后面**的消息里才出现（QQ 里"@张三"和"张三是谁"是两条消息）。
  // 先扫一遍整窗 ⇒ 每个 at 段都能用上窗口里全部的名字。
  //
  // ⚠️ 学名字失败**绝不能**影响灌历史（那才是这条路的正事）——
  //    这里是 `Promise.all` 里被 await 的一环，抛出去会让"这个会话没灌上"。
  if (nicknames !== null && nicknames !== undefined && typeof nicknames.learnBatch === 'function') {
    try {
      nicknames.learnBatch(list.map((item) => ({
        userId: item?.user_id ?? item?.sender?.user_id,
        nickname: item?.sender?.nickname,
        card: item?.sender?.card,
        groupId: kind === 'group' ? target : '',
        at: Number(item?.time) > 0 ? Number(item.time) * 1000 : undefined,
      })));
    } catch {
      /* 学不到名字只是 @ 退回 QQ 号，不该影响灌历史 */
    }
  }
  const resolveAt = nicknames === null || nicknames === undefined
    ? undefined
    : (qq, gid) => nicknames.resolve(qq, gid);

  const messages = [];
  const selfMessages = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    if (isSelfMessage(item, selfId)) {
      const self = toSelfTarget(item, shape);
      if (self !== null) selfMessages.push(self);
      continue;
    }
    const entry = toTarget(item, shape, resolveAt);
    if (entry !== null && entry.at !== null) messages.push(entry);
  }
  return { chatId: text, kind, messages, selfMessages };
}

/**
 * 拉取 + 灌进转录与上下文。
 *
 * ⚠️ **它做的全部事情就是**：拉一次 API → 把**别的**人说的话灌进转录、
 * 把**她自己**最后一条发言灌进上下文。**不判定、不发言、不计配额。**
 *
 * @param {object} options
 * @param {import('../proactive/engine.mjs').ProactiveEngine} options.engine
 * @param {string} options.chatId
 * @param {(action: string, params?: object, opts?: object) => Promise<any>} options.call
 * @param {number} [options.count] 灌多少条（缺省 `DEFAULT_COUNT`）
 * @param {string} [options.selfId]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.nicknames] `QQ → 昵称` 表（见 {@link fetchHistory}）
 * @returns {Promise<object>} 结果摘要（**只含时间戳/条数，不含正文**）
 */
export async function backfillChat({
  engine,
  chatId,
  call,
  count = DEFAULT_COUNT,
  selfId = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  nicknames = null,
} = {}) {
  if (engine === null || engine === undefined) throw new Error('backfill: 缺少 engine');
  const fetched = await fetchHistory({ chatId, call, count, selfId, timeoutMs, signal, nicknames });
  const state = engine.state(chatId);
  // 转录条数上限：引擎自己那个（默认 60）比"要灌 20 条"大，所以传 count 就够。
  const limit = Number.isFinite(count) && count > 0 ? Math.floor(count) : DEFAULT_COUNT;

  // === ② 上下文（她刚说过话 / 刚问过话）===
  // 取窗口里**最晚**的一条自己发言。注意这是真实时刻（可能是几小时前），
  // 这正是 `restoreContext` 想要的：`#gate` 用"流逝时间"，旧时刻不会造成假冷却。
  let contextAt = null;
  if (fetched.selfMessages.length > 0) {
    const lastSelf = fetched.selfMessages.reduce((a, b) => (b.at >= a.at ? b : a));
    if (state.restoreContext(lastSelf.at, lastSelf.text) === true) contextAt = lastSelf.at;
  }

  // === ① 转录（最近 N 条别人的话）===
  // ⚠️ 顺序：**先去重、再取最近 N 条**。反过来的话，已被看见的那条会白占一个名额。
  const fresh = fetched.messages.filter((m) => !(typeof m.messageId === 'number' && engine.seenIds.has(m.messageId)));
  const restored = engine.transcript(chatId).restore(fresh.slice(-limit), { hardCap: limit });

  // 记住这些 id：万一 NapCat 把同一条历史又作为实时事件补发一次，
  // `decide()` 那边会按 `duplicate` 直接跳过 —— 这是红线②的第二层保险。
  for (const m of fetched.messages) {
    if (typeof m.messageId === 'number') engine.seenIds.add(m.messageId);
  }

  return {
    chatId,
    ok: true,
    fetched: fetched.messages.length,
    restored,
    contextAt,
    lastSelfWasQuestion: contextAt === null ? null : state.lastBotWasQuestion === true,
  };
}

/**
 * 启动入口：**对白名单里的每个会话各拉一次**，全异步、失败可忽略。
 *
 * **本函数永远不抛异常**（内部全部 try/catch）—— 它的调用点就在插件 `apply()`
 * 里，任何异常都可能拖挂挂载。
 *
 * @param {object} options
 * @param {import('../proactive/engine.mjs').ProactiveEngine} options.engine
 * @param {import('./routing.mjs').Router} options.router 用来取白名单（**唯一**的白名单判据）
 * @param {(action: string, params?: object, opts?: object) => Promise<any>} options.call
 * @param {string} [options.selfId]
 * @param {number} [options.count]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {string[]} [options.chatIds] 显式指定会话（**测试用**；生产不传，走白名单）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {object} [options.nicknames] `QQ → 昵称` 表（见 {@link fetchHistory}）
 * @param {'startup'|'connected'|'manual'} [options.trigger]
 *   这一次是谁触发的。**进报告**，因为"到底哪一次灌成的"是排查的第一问
 *   （`startup` 失败、`connected` 补上，与反过来是两回事）。
 * @returns {Promise<object>} 汇总（`chats` 里每条只有条数与时间戳）
 */
export async function backfillHistory({
  engine,
  router,
  call,
  selfId = '',
  count = DEFAULT_COUNT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  chatIds,
  log = () => {},
  now = () => Date.now(),
  trigger = 'startup',
  nicknames = null,
} = {}) {
  const startedAt = now();
  const report = {
    enabled: true, trigger, attempts: 1, count, startedAt, at: null, fetched: 0, restored: 0, chats: [],
  };

  if (engine === null || engine === undefined || typeof engine.transcript !== 'function') {
    log('warn', '灌历史跳过：引擎不可用', {});
    return { ...report, enabled: false, reason: 'no-engine' };
  }
  // 引擎已经停了（插件正在卸载）就别再灌了。
  if (engine.stopped === true) {
    return { ...report, enabled: false, reason: 'engine-stopped' };
  }
  if (typeof call !== 'function') {
    log('warn', '灌历史跳过：没有 OneBot 调用器', {});
    return { ...report, enabled: false, reason: 'no-call' };
  }

  let ids = Array.isArray(chatIds) ? chatIds.map((x) => String(x)) : [];
  if (ids.length === 0) {
    try {
      ids = allowedChatIds(router);
    } catch (error) {
      log('warn', '灌历史跳过：白名单解析失败', { error: String(error?.message ?? error) });
      return { ...report, enabled: false, reason: 'no-allowlist' };
    }
  }
  if (ids.length === 0) {
    return { ...report, enabled: false, reason: 'no-chat' };
  }
  return runAttempts({ engine, ids, call, count, selfId, timeoutMs, signal, log, now, report, nicknames });
}

/**
 * 一次尝试的**执行体** —— 启动那次与"连接就绪后补一次"共用同一套代码。
 *
 * **并发**拉（会话之间互不依赖），但每个会话自己 try/catch
 * ⇒ 一个失败不影响别的、更不影响挂载。
 * @private
 */
async function runAttempts({ engine, ids, call, count, selfId, timeoutMs, signal, log, now, report, nicknames = null }) {
  // **并发**拉（会话之间互不依赖），但每个会话自己 try/catch ⇒ 一个失败不影响别的。
  const results = await Promise.all(ids.map(async (chatId) => {
    try {
      return await backfillChat({ engine, chatId, call, count, selfId, timeoutMs, signal, nicknames });
    } catch (error) {
      // 静默降级：这里唯一该发生的事就是记一行日志，然后当作"没这条会话"。
      log('info', `灌历史失败（忽略）${chatId}`, { error: String(error?.message ?? error) });
      return { chatId, ok: false, error: String(error?.message ?? error), fetched: 0, restored: 0, contextAt: null };
    }
  }));

  for (const r of results) {
    if (r.ok === true) {
      report.fetched += r.fetched;
      report.restored += r.restored;
      // **只留前 3 条正文**：这份摘要会落进调试快照，快照是给人一眼看的，
      // 而且落盘的东西越少越好（转录本身已经在内存里了）。
      const preview = engine.transcript(r.chatId).snapshot()
        .slice(-r.restored)
        .slice(0, 3)
        .map((m) => ({ at: m.at, userId: m.userId, nickname: m.nickname, text: String(m.text ?? '').slice(0, 60) }));
      report.chats.push({
        chatId: r.chatId,
        ok: true,
        fetched: r.fetched,
        restored: r.restored,
        contextAt: r.contextAt,
        lastSelfWasQuestion: r.lastSelfWasQuestion === true,
        preview,
      });
    } else {
      report.chats.push({ chatId: r.chatId, ok: false, error: r.error });
    }
  }
  report.at = now();
  const okCount = report.chats.filter((c) => c.ok === true).length;
  log('info', `灌历史完成（${report.trigger}，第 ${report.attempts} 次）：${okCount}/${ids.length} 个会话，共灌进转录 ${report.restored} 条`, {
    chats: report.chats.map((c) => `${c.chatId}:${c.ok === true ? c.restored : 'fail'}`),
  });
  return report;
}

/**
 * **不 await、不抛**的一次尝试。
 *
 * 为什么单独一层：调用点（`index.mjs` 的 `apply()`）里那一行必须短到"一眼看出
 * 它不会阻塞挂载"，而且必须**保证**没有未处理的 rejection（那会变成
 * `unhandledRejection`，在宿主里可能被当成插件崩了）。
 *
 * @returns {Promise<object|null>} 摘要。**拿不到引擎时返回 null**
 *   —— 那是"这件事压根没条件做"，与"做了但某个会话失败"（返回摘要）要分得开。
 */
export function runHistoryBackfill(options = {}) {
  const onDone = options !== null && typeof options === 'object' ? options.onDone : undefined;
  try {
    const task = backfillHistory(options);
    return Promise.resolve(task)
      .then((report) => {
        // `enabled: false` = 没条件做（没有引擎 / 引擎已停 / 没有调用器）。
        // 这时不调 `onDone`：调用方会把 `null` 当成"没做"，而不是当成"做了 0 条"。
        if (report !== null && report !== undefined && report.enabled === false) return null;
        if (typeof onDone === 'function') {
          try {
            onDone(report);
          } catch {
            /* 回调自己的错不该冒出来 */
          }
        }
        return report;
      })
      .catch((error) => {
        try {
          if (typeof options !== 'object' || options === null) return null;
          if (typeof options.log === 'function') {
            options.log('warn', '灌历史整体失败（忽略）', { error: String(error?.message ?? error) });
          }
        } catch {
          /* logger 自己炸了也不管 */
        }
        return null;
      });
  } catch (error) {
    return Promise.resolve(null);
  }
}

/**
 * 兼容名：一次性的"启动时灌一次"。
 *
 * ⚠️ **它的时机不完整**（2026-10-13 实测确认）：`apply()` 那一刻传输层**可能还没
 * 握上手**，而 **HMR 热重载**（改 `src/` 就会发生，且是开发期最频繁的事件）
 * 恰好总是这样 —— 重载后 WS 要重新握手，而这里立刻就跑了。
 *
 * ⇒ 生产**不要**只用它，用 {@link createHistoryBackfillController}（多了"连接就绪后补一次"）。
 * 留着它是为了不破坏"只想灌一次"的简单调用点与既有测试。
 */
export function startHistoryBackfill(options = {}) {
  return runHistoryBackfill(options);
}

/**
 * **灌历史控制器**：启动试一次 + **连接就绪时补一次**，且**只成功灌一遍**。
 *
 * ## 为什么必须有"补一次"（用户 2026-10-13 抓到的洞）
 *
 * 实测（线上快照）：`historyBackfill.startedAt = 12:56:55` 那次是 **HMR 热重载**
 * 而不是开机，三个会话全是 `OneBot 未连接` ⇒ **"只在启动时拉一次"等于"每次改
 * 代码重载后都灌不上"**。而热重载恰恰是开发期最容易发生的事。
 *
 * ## 三条不变量（缺一条就会出别的毛病）
 *
 * 1. **幂等**：只要**所有**会话都成功过（`chats` 里 `ok:true` 全覆盖，或至少一次
 *    `restored > 0`），之后**任何**触发都直接跳过 —— 否则转录里同一批消息会出现两遍。
 *    ⚠️ 去重（`seenIds`）在 `backfillChat` 里也有一层，但那层的语义是"顺带",
 *    这里必须是**硬保证**：连 API 都不再打。
 * 2. **有界**：`startup` 失败后最多再补 `maxRetries` 次（缺省 2）。连接反复抖动
 *    ⇒ 不会变成每 5 秒打一次 QQ 的循环。
 * 3. **降级**：补的那次失败**只是**再记一行日志 + 快照里换个 `trigger`，
 *    不抛、不阻塞、不影响实时消息链路。
 *
 * @param {object} options 与 {@link backfillHistory} 相同，外加：
 * @param {() => void} [options.onAttempt] 每次尝试结束（无论成败）调一次，参数是报告。
 *   **调用方每次重新赋值 `historyBackfill`** —— 快照里因此总能看到**最近一次**的结果，
 *   而 `trigger` / `attempts` 说明"是哪一次、第几次"。
 * @param {number} [options.maxRetries] 启动失败后允许再补几次（缺省 2）
 * @returns {{
 *   startup: () => Promise<object|null>,
 *   onConnected: () => Promise<object|null>,
 *   refresh: () => Promise<object|null>,
 *   state: () => object,
 *   attempts: () => number,
 * }}
 */
export function createHistoryBackfillController(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const onAttempt = typeof opts.onAttempt === 'function' ? opts.onAttempt : null;
  const maxRetries = Number.isFinite(opts.maxRetries) && opts.maxRetries >= 0 ? Math.floor(opts.maxRetries) : 2;

  let attempts = 0;
  let running = false;
  let started = false;
  /** 已经成功灌过的会话（拉到过东西，或确认过"这个会话没历史"）。 */
  const resolved = new Set();
  /** 最近一次尝试里失败的会话 id（决定"要不要补、补哪些"）。 */
  let lastFailed = [];
  let lastReport = null;
  /**
   * 本次挂载要灌的全部会话 id。
   *
   * 为什么要自己留一份：**"补一次"只该补没成功的那些**。没有这份名单，
   * 补的时候只能把**全部**会话再拉一遍 —— 转录不会重复（`seenIds` 去重兜着），
   * 但会**白发一遍 API**，而那是每次重连都要付的代价。
   * 第一次成功拿到报告后固定下来（白名单在同一进程生命周期里不会变）。
   */
  let allIds = [];
  /** 已用掉的重试次数（只数 `connected` 触发的）。 */
  let retries = 0;

  /** 先自己算一次白名单，**第一次尝试之前就知道要灌哪些会话**。 */
  if (Array.isArray(opts.chatIds) && opts.chatIds.length > 0) {
    allIds = opts.chatIds.map((x) => String(x));
  } else {
    try {
      allIds = allowedChatIds(opts.router);
    } catch {
      allIds = []; // 白名单坏了 ⇒ 第一次尝试会自己报 no-allowlist
    }
  }

  const settle = (report, trigger, failed = false) => {
    lastReport = report;
    if (report !== null && report !== undefined && report.enabled !== false) {
      const chats = report.chats ?? [];
      if (chats.length > 0 && allIds.length === 0) allIds = chats.map((c) => String(c.chatId));
      lastFailed = chats.filter((c) => c.ok !== true).map((c) => String(c.chatId));
      for (const c of chats) {
        // ⚠️ `ok:true` 但 `fetched:0` 也算"解决了" —— 那是"这个会话最近没消息"
        // （NapCat 正常应答、就是空），不是失败。反复重试它没有意义。
        if (c.ok === true) resolved.add(String(c.chatId));
      }
    } else if (failed) {
      // 整体炸了 ⇒ 标记"还没解决"，让连接就绪时补一次。
      lastFailed = ['*'];
    }
    const out = {
      attempts,
      trigger,
      resolvedChats: [...resolved],
      pendingChats: [...lastFailed],
    };
    if (onAttempt !== null) {
      try {
        onAttempt(report, out);
      } catch {
        /* 回调自己的错不该冒出来 */
      }
    }
    return report;
  };

  /** 全部会话都成功过？ */
  const allResolved = () => allIds.length > 0 && allIds.every((id) => resolved.has(id));

  /**
   * 跑一次。
   * @param {'startup'|'connected'|'manual'} trigger
   * @param {boolean} force `true` = 跳过幂等判断（只给显式的人工/测试调用）
   */
  const attempt = async (trigger, force = false) => {
    if (running) return null;
    if (opts.engine !== null && opts.engine !== undefined && opts.engine.stopped === true) return null;
    // 幂等闸门①：全部解决 ⇒ 什么都不做（连 API 都不打）。
    if (!force && allResolved()) return null;
    // 幂等闸门②：白名单那次就没算出来（`enabled:false`），别反复空转。
    if (!force && started && allIds.length === 0) return null;
    // 有界：`connected` 触发的重试次数封顶，免得连接抖动变成每 5 秒打一次 QQ。
    if (!force && trigger === 'connected' && retries >= maxRetries) return null;
    if (trigger === 'connected') retries += 1;
    running = true;
    started = true;
    attempts += 1;
    // **只补没成功的那些**（第一次是全量）。
    const target = lastFailed.length > 0 && allIds.length > 0 ? allIds.filter((id) => lastFailed.includes(id)) : null;
    try {
      /**
       * ⚠️ 这里**直接调 `backfillHistory`、不走 `runHistoryBackfill`**：
       * 那一层把 `enabled:false`（没条件做）转成 `null`，而控制器需要**报告本身**
       * 才能判定"要不要补一次" —— 全转成 null 的话，"引擎不可用"会被误当成
       * "已经成功过"，于是连接就绪时**再也不会补**（正是要修的那个洞的镜像）。
       */
      const report = await backfillHistory({ ...opts, trigger, ...(target === null ? {} : { chatIds: target }) });
      /**
       * ⚠️ `attempts` 由**控制器**说了算，不能沿用 `backfillHistory` 里那个 1 ——
       * 报告是每次尝试**新建**的，而次数是控制器累计的；不覆写的话
       * "第 2 次尝试"的报告里会写着 `attempts: 1`（实测踩到，正是
       * "快照里要能看出是哪一次灌成的"那条要求被写反的样子）。
       */
      if (report !== null && report !== undefined && typeof report === 'object') report.attempts = attempts;
      return settle(report, trigger);
    } catch (error) {
      // 整体失败也只是降级：记一行、把这次当"全失败"，等下一次连接就绪再补。
      try {
        log('warn', '灌历史整体失败（忽略）', { error: String(error?.message ?? error) });
      } catch {
        /* logger 自己炸了也不管 */
      }
      return settle(null, trigger, true);
    } finally {
      running = false;
    }
  };

  return {
    /** 启动时试一次（失败不要紧）。 */
    startup: () => {
      return attempt('startup');
    },
    /**
     * 连接就绪时补一次。
     *
     * **幂等**：已经成功灌完全部会话 ⇒ 直接返回 null（不打 API、不动转录）；
     * 失败过、且还在 `maxRetries` 之内 ⇒ **只补没成功的那些**。
     */
    onConnected: () => {
      if (started !== true) return Promise.resolve(null);
      return attempt('connected');
    },
    /** 不看不问，直接再跑一次（人工/测试用；**不受幂等闸门约束**）。 */
    refresh: () => attempt('manual', true),
    /** 控制器自己的状态（给快照/日志看）。 */
    state: () => ({
      attempts,
      retries,
      running,
      allChats: [...allIds],
      resolvedChats: [...resolved],
      pendingChats: [...lastFailed],
      lastTrigger: lastReport === null ? null : (lastReport.trigger ?? null),
    }),
    attempts: () => attempts,
  };
}
