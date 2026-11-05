/**
 * 工作汇报的文案生成。
 *
 * 纯函数，零依赖，零 DSH 耦合——它只吃"一轮的事件列表"，吐一段给 QQ 看的文本。
 * 这样"汇报写得像不像话"这件事可以离线全量测，而桥那一侧只剩接线。
 *
 * 设计取舍：**不重复贴模型回复**。工作会话的最终回复通常已经很长、而且是给
 * 开发者看的（含代码、路径、markdown），直接搬到群里既不合语境也会刷屏。
 * 汇报应当回答群里的人真正关心的三件事：
 *
 *   1. 哪个会话、第几轮、什么结果（成/败/中断）
 *   2. 干了什么活（跑过哪些工具、动过哪些文件）
 *   3. 一句话结论（取最终助手文本的首行/首句，截断）
 *
 * @module qq-dsh/report
 */

/** 工具名 → 给非技术读者看的中文说法。未列出的工具原样显示名字。 */
const TOOL_LABELS = {
  read: '读文件',
  write: '写文件',
  edit: '改文件',
  glob: '找文件',
  grep: '搜代码',
  pwsh: '跑命令',
  bash: '跑命令',
  subagent: '派子任务',
  workflow: '跑流程',
  web_search: '搜网络',
  web_fetch: '抓网页',
  todo_write: '列计划',
  present: '交付文件',
};

/** 结束原因 → 一行说明。 */
const REASON_LABELS = {
  completed: '完成',
  aborted: '被中止',
  blocked: '被拦住',
  error: '出错',
  'max-tokens': '撞到输出上限',
  interrupted: '被打断',
  forked: '被分叉',
};

/**
 * 统计一轮里用到的工具（去重、按名称聚合次数）。
 * @param {Array<{type?: string, data?: any}>} events
 * @param {number} turn 只要这一轮的事件
 */
export function collectToolUsage(events, turn) {
  const counts = new Map();
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type !== 'tool/call') continue;
    if (turn !== undefined && event.data?.turn !== turn) continue;
    const name = String(event.data?.name ?? '');
    if (name === '') continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * 从事件里找这一轮最后的助手文本。
 * @param {Array<{type?: string, data?: any}>} events
 * @param {number} turn
 * @returns {string}
 */
export function lastAssistantTextOfTurn(events, turn) {
  let found = '';
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type !== 'assistant/message') continue;
    if (turn !== undefined && event.data?.turn !== turn) continue;
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const parts = [];
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    const text = parts.join('').trim();
    if (text !== '') found = text;
  }
  return found;
}

/**
 * 取一句话结论：首个非空行，再按标点切到第一个句子，最后截断。
 * @param {string} text
 * @param {number} [maxChars]
 */
export function firstSentence(text, maxChars = 120) {
  const body = String(text ?? '').trim();
  if (body === '') return '';
  // 去掉常见的 markdown 装饰，群里不需要它。
  const cleaned = body
    .split('\n')
    .map((line) => line.replace(/^[#>\-*\s]+/, '').trim())
    .filter((line) => line !== '');
  const head = cleaned[0] ?? '';
  if (head === '') return '';
  const cut = /[。！？!?.]/.exec(head);
  const sentence = cut === null ? head : head.slice(0, cut.index + 1);
  const points = Array.from(sentence);
  if (points.length <= maxChars) return sentence;
  return `${points.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

/**
 * 生成一段工作汇报。
 *
 * @param {object} input
 * @param {Array<any>} input.events 该会话的事件快照（`session.snapshotEvents()`）
 * @param {number} [input.turn] 要汇报的轮次
 * @param {string} [input.sessionId]
 * @param {{kind?: string}} [input.reason] `turn/end` 的 reason
 * @param {number} [input.maxChars] 整段上限
 * @returns {string} 可直接发到 QQ 的文本；没有可汇报内容时返回空串
 */
export function buildWorkReport({ events, turn, sessionId, reason, maxChars = 600 }) {
  const list = Array.isArray(events) ? events : [];
  const reasonKind = String(reason?.kind ?? 'completed');
  // 被中止/出错的轮次也要报——"我这边卡住了"恰恰是群里最该知道的。
  const reasonLabel = REASON_LABELS[reasonKind] ?? reasonKind;

  const tools = collectToolUsage(list, turn);
  const conclusion = firstSentence(lastAssistantTextOfTurn(list, turn));

  const header = sessionId === undefined || sessionId === ''
    ? `第 ${turn ?? '?'} 轮：${reasonLabel}`
    : `${shortId(sessionId)} 第 ${turn ?? '?'} 轮：${reasonLabel}`;

  const lines = [header];

  if (tools.size > 0) {
    const parts = [...tools.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => {
        const label = TOOL_LABELS[name] ?? name;
        return count > 1 ? `${label}×${count}` : label;
      });
    lines.push(`动作：${parts.join('、')}`);
  }

  if (conclusion !== '') lines.push(`结论：${conclusion}`);

  const text = lines.join('\n').trim();
  if (text === '' || lines.length === 1 && tools.size === 0 && conclusion === '') return '';
  return truncate(text, maxChars);
}

/**
 * 会话 id 的短形式，用于在群里区分"是哪个会话"。
 *
 * **必须剥掉 `session-` 前缀再截断**：DSH 的会话 id 统一是 `session-<uuid>`，
 * 直接取前 8 位会得到一模一样的 `session-`，在群里毫无区分度（实测踩到）。
 * 剥掉前缀后取 uuid 的前 8 位，才是人眼可辨的那个短 id。
 * @param {string} sessionId
 * @returns {string}
 */
export function shortId(sessionId) {
  const text = String(sessionId ?? '');
  const stripped = text.startsWith('session-') ? text.slice('session-'.length) : text;
  if (stripped === '') return text === '' ? '' : text;
  return stripped.length <= 8 ? stripped : stripped.slice(0, 8);
}

/** 按码点截断。 */
function truncate(text, limit) {
  const points = Array.from(String(text));
  if (!Number.isFinite(limit) || limit <= 0 || points.length <= limit) return String(text);
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
}
