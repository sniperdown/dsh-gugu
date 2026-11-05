/**
 * **自动搬运：任何在 QQ 会话里跑完的一轮，只要模型说了话，就搬到对应 QQ**（2026-11-02）。
 *
 * ## 为什么需要它
 *
 * 以前"发到 QQ"**只发生在 `Gateway.runTurn` 里**（QQ 入站 / 内部通道 / 定时唤醒
 * 这三条路都经过它）。但宿主还会**自己**在同一个会话里跑轮次：
 *
 * | 这类轮次 | 谁叫醒的 | 走 `runTurn` 吗 |
 * |---|---|---|
 * | QQ 消息触发 | `gateway.dispatch` → `runTurn` | ✅ |
 * | 主会话内部通道 / 定时唤醒 | `deliverFromAlice` → `runTurn` | ✅ |
 * | **子会话交活（subagent / teammate 回报）** | 宿主把消息塞进 agent 收件箱 | ❌ |
 * | **后台作业结束** | 同上 | ❌ |
 * | **`schedule` 定时到点** | 同上 | ❌ |
 * | **banner 自助重启回来** | 同上 | ❌ |
 *
 * 后四类**没有任何插件代码在等**，于是她说的话只写进会话、QQ 上一个字都不到
 * （2026-10-25 06:46 已经因此让用户一个字都没看到）。用户拍板：
 * 「让插件把你每次的输出都搬出来（不说话除外）」。
 *
 * ## 判据（一句话）
 *
 * `turn/end` 时，**这个会话能映射到白名单里的 QQ chatId** + **这一轮不是插件自己驱动的**
 * （`gateway.isTurnInFlight()` ⇒ 那是 `runTurn` 的路，它自己会发）+ **这一轮的最后一段
 * 助手正文非空** + **不是 `[不说话]`** + **这一轮没调过发文字的工具** ⇒ 发。
 *
 * ## 为什么"不是插件自己驱动的"这一条是**必须**的（定时唤醒的护栏）
 *
 * 「她自己的时间」(`free-time.mjs`) 和内部通道都走 `deliverFromAlice` → `runTurn({silent})`。
 * 那一轮的设计初衷是**可以什么都不干**，而且它**自己**已经有完整的"发不发"逻辑
 * （`[不说话]` 判定 + `quietWhenNothing`，free-time.mjs:669-706）。
 * 如果自动搬运也去搬它，后果是：**同一句话发两遍**，而且"只观察不说话"的轮次里
 * 她随口一句自言自语会被直接推到用户手机上。⇒ 让路，一个字都不碰。
 *
 * ## 为什么正文取自**事件流**而不是 `deriveMessages()`
 *
 * `assistant/message` 事件带 `data.turn`（真实会话日志核实过），所以
 * `lastAssistantTextOfTurn(events, turn)` 能**精确**取到"这一轮的最后一句话"，
 * 不受上下文压缩（条数会变短）影响 —— 这正是 2026-10-28 丢回复的形状。
 * 事件形状与 `report.mjs` 共用同一份读法，不另写一套。
 *
 * @module qq-dsh/auto-relay
 */

import { lastAssistantTextOfTurn } from './report.mjs';
import { isQuietMark } from './gateway.mjs';

/**
 * 会往 QQ 发**文字**的工具名：这一轮调过它 ⇒ 正文不再自动搬运（防重复）。
 *
 * 只收**文字**那一路：`send_voice` 明确"不顶掉文字"（gateway.mjs 里那段注释），
 * `send_qq` 发图那一条在同一个工具里、但正文仍该发 —— 这里按"调过就当发过"处理，
 * 与 `runTurn` 的 `toolSentThisTurn` 口径一致（B2，2026-10-25）。
 */
export const TEXT_SEND_TOOL_NAMES = Object.freeze(['send_qq']);

/**
 * 这一轮（`turn`）里有没有调用过"发文字"的工具。
 *
 * @param {Array<any>} events `session.snapshotEvents()` 的结果
 * @param {number} turn 轮次号（`turn/end` 的 `data.turn`）
 * @param {readonly string[]} [toolNames]
 * @returns {boolean}
 */
export function turnHasTextToolCall(events, turn, toolNames = TEXT_SEND_TOOL_NAMES) {
  if (!Array.isArray(events)) return false;
  const want = Array.isArray(toolNames) ? toolNames : [];
  if (want.length === 0) return false;
  const wanted = new Set(want.map((name) => String(name)));
  const target = Number(turn);
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type !== 'tool/call') continue;
    if (Number.isFinite(target) && target > 0 && Number(event.data?.turn) !== target) continue;
    if (wanted.has(String(event.data?.name ?? ''))) return true;
  }
  return false;
}

/**
 * 只读地取会话的事件快照。
 *
 * `snapshotEvents` 是宿主给的方法，**可能不存在**（替身 / 老版本）；取不到就当"没有事件"，
 * 绝不能把这一轮弄抛 —— 这个函数跑在 `session/event` 回调里，抛出去 = 宿主进程。
 *
 * @param {any} session
 * @returns {Array<any>}
 */
export function eventsOf(session) {
  try {
    return typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  } catch {
    return [];
  }
}

/**
 * 造一个自动搬运器。
 *
 * `observe(session, event)` 返回**判定结果字符串**（`sent` / `in-flight` / `no-chat` /
 * `empty` / `quiet` / `tool-sent` / `send-failed` / `error`），测试直接断言它，
 * 不必去猜日志。
 *
 * @param {object} options
 * @param {any} options.gateway 网关（要 `chatOf` / `isTurnInFlight` / `sendTurnReply`）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {(text: string) => boolean} [options.isQuiet] `[不说话]` 判定（默认与网关口一致）
 * @param {readonly string[]} [options.toolNames] 见 `TEXT_SEND_TOOL_NAMES`
 */
export function createAutoRelay({ gateway, log = () => {}, isQuiet = isQuietMark, toolNames = TEXT_SEND_TOOL_NAMES } = {}) {
  /** 观测计数（进调试快照，用来回答"它到底动没动过"）。 */
  const stats = {
    /** 收到的 `session/event` 条数 */
    events: 0,
    /** 看到的 `turn/end` 条数 */
    turns: 0,
    /** 真的搬运出去了几条 */
    sent: 0,
    /** 让路给 `runTurn`（含定时唤醒 / 内部通道）的轮数 */
    skippedInFlight: 0,
    /** 这个会话映射不到 QQ chatId（= 不是 QQ 会话） */
    skippedNoTarget: 0,
    /** 这一轮没有助手正文 */
    skippedEmpty: 0,
    /** 正文是 `[不说话]` */
    skippedQuiet: 0,
    /** 这一轮已经用 `send_qq` 发过文字 */
    skippedToolSent: 0,
    /** 宿主这个会话没给 `snapshotEvents()`（拿不到"这一轮说了什么"） */
    skippedNoEvents: 0,
    /** 网关拒了 / 被同文短窗拦下 */
    failed: 0,
    lastResult: '',
    lastAt: null,
    lastChars: 0,
  };

  const note = (result) => {
    stats.lastResult = result;
    stats.lastAt = new Date().toISOString();
  };

  async function observe(session, event) {
    stats.events += 1;
    try {
      if (event === null || typeof event !== 'object' || event.type !== 'turn/end') return null;

      const sessionId = String(session?.id ?? '');
      const turn = Number(event.data?.turn) || 0;
      stats.turns += 1;

      if (sessionId === '') {
        stats.skippedNoTarget += 1;
        note('no-session');
        return 'no-session';
      }

      // ① 这一轮是**插件自己驱动的**（QQ 入站 / 内部通道 / 定时唤醒）⇒ 让路。
      //    `runTurn` 自己会发，而且它那条路有 `silent` / `send_qq` / `[不说话]` 三套判据。
      if (typeof gateway?.isTurnInFlight === 'function' && gateway.isTurnInFlight(sessionId) === true) {
        stats.skippedInFlight += 1;
        note('in-flight');
        return 'in-flight';
      }

      // ② 这个会话得有 QQ 出口 —— 认不出 chatId 就是"不是 QQ 会话"（主会话、子会话等）。
      const chat = typeof gateway?.chatOf === 'function' ? gateway.chatOf(sessionId) : null;
      const chatId = typeof chat?.chatId === 'string' ? chat.chatId : '';
      if (chatId === '') {
        stats.skippedNoTarget += 1;
        note('no-chat');
        return 'no-chat';
      }

      const events = eventsOf(session);

      // ③ 正文：**这一轮**的最后一段助手文本（按 `data.turn` 取，抗压缩）。
      //
      // ⚠️ 先分清"宿主没给事件快照"和"这一轮确实没说话"——两者在旧实现里长得一模一样
      // （都是"没东西可发"），那是最难查的一类静默失败。没有 `snapshotEvents` 这个方法
      // 就明说（`no-events` + 一条 warn），别冒充"空轮"。
      if (typeof session?.snapshotEvents !== 'function') {
        stats.skippedNoEvents += 1;
        note('no-events');
        try {
          log('warn', '自动搬运：会话没有 snapshotEvents()，拿不到这一轮的正文（本轮没搬）', {
            sessionId,
          });
        } catch {
          /* 日志失败不影响判定 */
        }
        return 'no-events';
      }
      const text = String(lastAssistantTextOfTurn(events, turn) ?? '').trim();
      if (text === '') {
        stats.skippedEmpty += 1;
        note('empty');
        return 'empty';
      }

      // ④ `[不说话]` = 这一轮本来就不打算出声（与 runTurn 同一判定口径）。
      if (isQuiet(text) === true) {
        stats.skippedQuiet += 1;
        note('quiet');
        return 'quiet';
      }

      // ⑤ 这一轮已经用工具发过文字 ⇒ 正文不重复发（否则 QQ 上一条变两条）。
      if (turnHasTextToolCall(events, turn, toolNames) === true) {
        stats.skippedToolSent += 1;
        note('tool-sent');
        return 'tool-sent';
      }

      const ok = typeof gateway?.sendTurnReply === 'function'
        ? await gateway.sendTurnReply(sessionId, text)
        : false;
      if (ok === true) {
        stats.sent += 1;
        stats.lastChars = text.length;
        note('sent');
        return 'sent';
      }
      stats.failed += 1;
      note('send-failed');
      return 'send-failed';
    } catch (error) {
      // 挂在外部事件上的回调**必须自己吞异常**（抛出去 = 宿主进程退出）。
      stats.failed += 1;
      note('error');
      try {
        log('warn', '自动搬运出错（已忽略）', {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        /* 连日志都失败就只能放弃这条 */
      }
      return 'error';
    }
  }

  return {
    observe,
    /** 只读副本（快照用）。 */
    stats: () => ({ ...stats }),
  };
}
