/**
 * 「顺便看一眼」的通知判定 —— 纯逻辑，不碰 I/O。
 *
 * ## 为什么是这个形状
 *
 * 用户原话：
 * > 其实不需要在工作的时候挂着计时器，只需要聊天的时候，聊天子会话汇报上来
 * > 激活核心的时候顺便偶尔看一眼就行了，qq群不缺消息
 *
 * 所以这里**没有定时器**：判定被聊天会话的轮次驱动（见 index.mjs 的 `scanOnce`）。
 * 聊天群本身就是心跳源。
 *
 * ## 什么时候出声
 *
 * 只在一个会话**当前正处于阻塞态**、且**已经等了足够久**时出声：
 *
 * - 工作会话自己轮次结束时通知：人就在电脑前，DSH 界面看得见 → **不出声**
 * - 会话卡住了在等你点确认，等了 90 分钟 → **出声**
 * - 出门模式（awayMode）：普通完成也出声
 *
 * 「当前正处于阻塞」这个条件顺带解决了去重：一个会话一旦不再阻塞（你回了、
 * 它继续跑了），就不再匹配，不需要额外维护"已通知过"的集合。
 */

/** 视为"在等用户"的结束原因。 */
export const WAITING_KINDS = Object.freeze(['blocked', 'error', 'interrupted']);

/**
 * 会话前缀 → 是否属于 QQ 聊天通道。
 *
 * QQ 对话本身就是对话，不是需要汇报的"工作"：
 * 曾经只排了 `qq-`，结果小鲸鱼自己在 QQ 上说的话被当成工作又播报了一遍。
 *
 * 2026-10-24（P1-4）：口令是"**映射表优先**"。ID 换成 `session-<uuid>` 之后前缀判断
 * 必然失效，所以新增可选 `isChat` —— 由装配层传 `resolver.has`。
 * 不传 ⇒ 与改动前逐字一致（老调用方/测试不受影响）。
 *
 * @param {string} sessionId
 * @param {((sessionId: string) => boolean)|null} [isChat]
 * @returns {boolean}
 */
export function isChatSession(sessionId, isChat = null) {
  const id = String(sessionId ?? '');
  if (typeof isChat === 'function') {
    try {
      if (isChat(id) === true) return true;
    } catch {
      /* 解析器出问题 ⇒ 回退前缀 */
    }
  }
  return id.startsWith('qq-') || id.startsWith('onebot-');
}

/**
 * 从事件流里读出会话的**当前状态**。
 *
 * 只看最后一个 `turn/end`：它才是"此刻是不是卡住了"的答案。
 *
 * @param {Array<object>} events
 * @returns {{waiting: boolean, kind: string, turn: number, blockedSince: number|null}}
 */
export function readSessionState(events) {
  const list = Array.isArray(events) ? events : [];
  let last = null;
  for (const ev of list) {
    if (ev?.type === 'turn/end') last = ev;
  }
  if (last === null) {
    return { waiting: false, kind: 'none', turn: 0, blockedSince: null };
  }
  const kind = String(last?.data?.reason?.kind ?? 'completed');
  return {
    waiting: WAITING_KINDS.includes(kind),
    kind,
    turn: Number(last?.data?.turn) || 0,
    blockedSince: Number(last?.time) || null,
  };
}

/**
 * 判断某个会话是否**此刻值得打扰用户**。
 *
 * @param {object} input
 * @param {number} input.now 当前时间（毫秒）
 * @param {boolean} input.waiting 会话当前是否在等用户
 * @param {number|null} input.blockedSince 进入等待的时刻（毫秒）；未知则退化为用会话创建时间
 * @param {number} input.createdAt 会话创建时刻（毫秒）
 * @param {number} input.turn 当前轮次
 * @param {boolean} input.awayMode 出门模式
 * @param {boolean} input.onlyWhenBlocked 是否只在阻塞时出声
 * @param {number} input.waitingNotifyAfterMinutes 等多久才喊
 * @returns {{notify: boolean, reason: string}}
 */
export function shouldNotify({
  now,
  waiting,
  blockedSince,
  createdAt,
  turn,
  awayMode,
  onlyWhenBlocked,
  waitingNotifyAfterMinutes,
}) {
  // 第一轮没有"结束"可谈：还没干过活，没什么可汇报的。
  if (!Number.isFinite(turn) || turn < 1) return { notify: false, reason: 'no-turn' };

  if (awayMode === true) return { notify: true, reason: 'away-mode' };

  if (onlyWhenBlocked !== true) return { notify: true, reason: 'every-turn' };

  if (waiting !== true) return { notify: false, reason: 'not-waiting' };

  // 等待起点：优先用进入等待的时刻，拿不到就退化为会话创建时间。
  //
  // 注意守卫必须用 `Number.isFinite` 而不是 `> 0`：事件里的 `time` 是毫秒
  // 时间戳，`0` 是合法值（测试里就常用 epoch 0）。用 `> 0` 会把"恰好为 0"
  // 误判成"时间不明"，于是本该出声的场景被静默吞掉。
  const since =
    Number.isFinite(blockedSince) ? blockedSince : Number.isFinite(createdAt) ? createdAt : NaN;
  if (!Number.isFinite(since)) {
    // 时间完全不明时不催——宁可漏报，也不要在信息不足时打扰。
    return { notify: false, reason: 'unknown-since' };
  }
  const minutes = Math.max(1, Number(waitingNotifyAfterMinutes) || 90);
  if (now - since < minutes * 60 * 1000) {
    return { notify: false, reason: 'not-long-enough' };
  }
  return { notify: true, reason: 'waiting-too-long' };
}

/**
 * 扫描一批工作会话，挑出该喊用户的那些。
 *
 * @param {object} options
 * @param {Array<{id: string, createdAt: number, events: Array<object>}>} options.sessions
 * @param {number} options.now
 * @param {boolean} options.awayMode
 * @param {boolean} options.onlyWhenBlocked
 * @param {number} options.waitingNotifyAfterMinutes
 * @param {(sessionId: string) => boolean} [options.allow] 额外过滤（如出站白名单）
 * @param {(sessionId: string) => boolean} [options.isChat] 判断"这是不是 QQ 聊天会话"
 *   （2026-10-24 P1-4：装配层传 `resolver.has`；不传 ⇒ 回退前缀判断）
 * @returns {Array<{id: string, turn: number, kind: string, reason: string, events: Array<object>}>}
 */
export function selectNotifiable({
  sessions,
  now,
  awayMode,
  onlyWhenBlocked,
  waitingNotifyAfterMinutes,
  allow,
  isChat = null,
}) {
  const out = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const id = String(s?.id ?? '');
    if (id === '' || isChatSession(id, isChat)) continue;
    if (typeof allow === 'function' && !allow(id)) continue;

    const state = readSessionState(s?.events);
    const verdict = shouldNotify({
      now,
      waiting: state.waiting,
      blockedSince: state.blockedSince,
      createdAt: Number(s?.createdAt) || 0,
      turn: state.turn,
      awayMode,
      onlyWhenBlocked,
      waitingNotifyAfterMinutes,
    });
    if (!verdict.notify) continue;

    out.push({
      id,
      turn: state.turn,
      kind: state.kind,
      reason: verdict.reason,
      events: Array.isArray(s?.events) ? s.events : [],
    });
  }
  return out;
}

/**
 * 把"该喊他"的会话拼成一条 QQ 文案。
 *
 * 措辞刻意直白：用户是在 QQ 上瞄一眼，不是在读报告。
 *
 * @param {Array<{id: string, turn: number, kind: string, reason: string}>} items
 * @param {{shortId?: (id: string) => string, maxChars?: number}} [options]
 * @returns {string}
 */
export function buildAlert(items, { shortId = (id) => id, maxChars = 600 } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return '';

  const lines = [];
  if (list.length === 1) {
    const it = list[0];
    lines.push(
      it.reason === 'away-mode'
        ? `${shortId(it.id)} 第 ${it.turn} 轮：${it.kind}`
        : `${shortId(it.id)} 第 ${it.turn} 轮卡住了（${it.kind}）`,
    );
    lines.push(
      it.reason === 'away-mode' ? '已经跑完了，回来看看。' : '它在等你确认，挂了有一会儿了。',
    );
  } else {
    lines.push(`${list.length} 个会话在等你：`);
    for (const it of list) {
      lines.push(
        it.reason === 'away-mode'
          ? `- ${shortId(it.id)} 第 ${it.turn} 轮：${it.kind}`
          : `- ${shortId(it.id)} 第 ${it.turn} 轮卡住了`,
      );
    }
  }

  const text = lines.join('\n');
  const limit = Math.max(1, Number(maxChars) || 600);
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
