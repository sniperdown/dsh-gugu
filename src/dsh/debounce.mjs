/**
 * 群聊消息防抖（2026-11-04，用户点名"很有必要"）。
 *
 * 解决的是**半句话抢话**：同一个人连发三条，原来每一条都各判一次，第一条往往
 * 只是"我在"或"那个"；攒批之后整批只判一次，判的是这条思路的**最后一句**。
 *
 * 与 MaiBot 的对应（`message_debounce_mode: natural`）：
 * - 同一人续发等 **2s**；换人等 **0.5s**；整批自第一条起最多 **8s**；
 *   含 @ 的批次最多等 **1s**（被点名要快）。
 *
 * 刻意不做成配置项（用户 2026-11-04：「条数多点少点影响都不大，最终还是要跑过才知道」）：
 * 参数是常量，先跑一周，有数据再调。
 *
 * 防抖只发生在**网关**：它决定"这条消息现在要不要处理"，不改变转录内容 ——
 * 被攒住的前几条会在 flush 时用 `engine.ingest()` 补进转录，一条都不丢。
 */

export const DEFAULTS = Object.freeze({
  sameUserMs: 2000,
  switchUserMs: 500,
  capMs: 8000,
  atMs: 1000,
});

/**
 * @param {object} options
 * @param {(items: object[]) => void} options.onFlush 批次到达时回调（旧 → 新）
 * @param {() => number} [options.now]
 * @param {object} [options.timers] `{setTimeout, clearTimeout}`（测试注入）
 * @param {(level: string, msg: string) => void} [options.log]
 */
export function createDebouncer({
  onFlush,
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout },
  log = () => {},
  sameUserMs = DEFAULTS.sameUserMs,
  switchUserMs = DEFAULTS.switchUserMs,
  capMs = DEFAULTS.capMs,
  atMs = DEFAULTS.atMs,
} = {}) {
  /** chatId -> { items: [{payload, userId, at}], firstAt, lastUserId, timer, deadline } */
  const chats = new Map();

  function clearChat(state) {
    if (state.timer !== null) {
      timers.clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function take(state) {
    clearChat(state);
    const items = state.items;
    state.items = [];
    state.firstAt = 0;
    state.lastUserId = '';
    return items;
  }

  function fire(chatId) {
    const state = chats.get(chatId);
    if (state === undefined) return;
    const items = take(state);
    if (items.length === 0) return;
    try {
      onFlush(items);
    } catch (error) {
      log('warn', `防抖批次处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function schedule(chatId, state) {
    clearChat(state);
    const t = now();
    const remaining = state.firstAt + capMs - t;
    const delay = Math.max(0, Math.min(state.pendingDelay, remaining));
    state.timer = timers.setTimeout(() => {
      state.timer = null;
      fire(chatId);
    }, delay);
    if (typeof state.timer?.unref === 'function') state.timer.unref();
  }

  /**
   * 收一条消息。
   * @param {object} input
   * @param {string} input.chatId
   * @param {string} input.userId
   * @param {boolean} [input.isAt] 含 @（被点名要快）
   * @param {*} input.payload 这条消息的载荷（网关放 `{event, message}`）
   * @returns {boolean} true = 已被攒住（调用方**不要**继续处理）；false = 立即处理
   */
  function push({ chatId, userId, isAt = false, payload } = {}) {
    const key = String(chatId ?? '');
    if (key === '') return false;
    const uid = String(userId ?? '');
    const t = now();
    let state = chats.get(key);
    if (state === undefined) {
      state = { items: [], firstAt: 0, lastUserId: '', timer: null, pendingDelay: 0 };
      chats.set(key, state);
    }
    if (state.items.length === 0) state.firstAt = t;
    // 关键：**新开一批**等的是"安静 2s"；只有批里已经有别人时，"换人"才缩到 0.5s。
    // （第一版写成"新批也按换人算"，结果每条消息 0.5s 就放行了一次 —— 测试逮到。）
    const fresh = state.items.length === 0;
    const sameUser = uid !== '' && uid === state.lastUserId;
    state.lastUserId = uid;
    state.items.push({ payload, userId: uid, at: t });
    state.pendingDelay = isAt ? atMs : fresh || sameUser ? sameUserMs : switchUserMs;
    // 首批就含 @：最多等 atMs，别拖成 2 秒。
    schedule(key, state);
    return true;
  }

  /** 立刻放掉所有（或指定）会话的批次。 */
  function flush(chatId) {
    if (chatId === undefined) {
      for (const key of [...chats.keys()]) fire(key);
      return;
    }
    fire(String(chatId));
  }

  function dispose() {
    for (const [key, state] of chats) {
      clearChat(state);
      take(state);
      chats.delete(key);
    }
  }

  function sizeOf(chatId) {
    return chats.get(String(chatId))?.items.length ?? 0;
  }

  return { push, flush, dispose, sizeOf };
}
