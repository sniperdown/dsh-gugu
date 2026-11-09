/**
 * 「用户最近 N 小时在电脑上干了什么」→ 给自由活动轮（长唤醒）用的摘要。
 *
 * 数据源是**另一个进程**写的（独立计划任务 `ActivityRecorder`，跟 DSH 无关）：
 *   `%LOCALAPPDATA%\activity-log\events-YYYY-MM-DD.jsonl`（本地日期切文件，只留 72 小时）
 * 每行一个 JSON。**记录器随仓库提供**，在 `tools/activity-recorder/`（Windows 计划任务）。
 *
 * ## 为什么"开箱没数据"（这是常态，不是坏了）
 *
 * 记录器是**可选组件**：没 install 计划任务，就没有这个目录；本模块读到空 ⇒ 返回 `null`，
 * 唤醒提示词**一个字节都不加**（见 `free-time.mjs` 的 `appendActivity`）。
 * 想让它有数据：`tools/activity-recorder/install.ps1`（注册当前用户的登录自启任务）。
 *
 * ## 事件契约（记录器写、本模块读；改一边必须改另一边）
 *
 * 公共字段：`t`（本地 ISO 时间，只给人看）、`k`（类型）、`ms`（epoch 毫秒，**排序与窗口判定只用它**）。
 *
 * | `k` | 额外字段 | 含义 |
 * |---|---|---|
 * | `boot` | — | 记录器启动（无活动信息，不产生时间线） |
 * | `focus` | `proc` `pid` `hwnd` `title` | **前台窗口变化**（时间线的锚点） |
 * | `snap` | `proc` `pid` `hwnd` `title` `idleSec` `wins` | 每 5 分钟快照（无 focus 时的兜底锚点） |
 * | `idle` | `idleSec` | 进入空闲（空闲起点 = `ms - idleSec*1000`） |
 * | `active` | — | 回到活动（空闲终点） |
 * | `stop` | — | 记录器退出 |
 *
 * 读的时候**只信任 `ms` 是数字**：坏行、非 JSON、缺 `ms` 一律跳过（记录器可能正写到一半）。
 *
 * ## 契约
 * - 返回 `{ text }` 或 `null`（读不到 / 没有数据 / 只有 boot 这种无活动信息的行）。
 * - **永不抛**：它接在唤醒路径上，读日志失败绝不能让「她自己的时间」停摆。
 * - 输出**硬上限 500 字**（`MAX_CHARS`）—— 这是塞进提示词的东西，烧的是每轮 token。
 *
 * ## 只读最近 N 小时（用户 2026-11-09 的要求）
 * 按**日文件名直接定位**（今天 + 前一天，够覆盖 ≤24h 的窗口），用 `readline` **流式逐行**读，
 * 一行一次 `JSON.parse`，**坏行跳过**。绝不把整个文件读成一个字符串再整体 parse ——
 * 记录器还在往后追加，文件会越长越大。
 *
 * ## 时间线的算法（取舍都写在这里，测试钉的是这几条）
 * 1. 锚点只认 `focus`（前台窗口变化）；窗口里一条 `focus` 都没有时退回用 `snap`
 *    （记录器刚起来、还没发生切换的兜底）。
 * 2. 第 i 条锚点 → 第 i+1 条锚点之间的时间就是它占的前台时间；最后一条延伸到 `now`。
 * 3. **同一进程的相邻段合并**（判据：同 proc 且「同 hwnd」或「标题前缀相同」）——
 *    在同一个窗口里翻页 / 换标签页不该碎成十几段。
 * 4. **总时长 < 3 分钟的碎段叠到相邻段上**（`MIN_SEGMENT_MS`）：有前一段就延长前一段，
 *    没有（最前面那几段）就并进后一段的起点。**整段不单独出现**，但它占的时间不丢 ——
 *    时间线因此是**连续的**，不会留洞。
 *    为什么不是"直接丢掉"：真实数据里"快速 Alt-Tab"会让落尾全变成几秒的碎段，
 *    一旦丢掉，时间线就停在 7 分钟之前、而"当前"却写着另一个进程，看起来像坏了。
 *    阈值内的时间被记到邻居头上，误差 ≤ 3 分钟/段，值得。
 *    例外：**全是碎段**时保留最长的那一段（否则输出会变成没有时间线的空壳）。
 * 5. **空闲（`idle`）怎么算**：`idle` 事件带 `idleSec` ⇒ 空闲起点 = `ms - idleSec*1000`，
 *    终点是后面第一条 `active`（或任何 `focus` —— 能切窗口就说明人回来了）；
 *    一直没回来的就延到 `now`。
 *    **总览里扣掉空闲重叠** ⇒ 那一列是「**有操作**的前台时长」，不是"窗口开着"的时长。
 *    理由：人走开 40 分钟、窗口还停在 B 站，不该算成"看了 40 分钟 B 站"。
 *    当前状态那行则**照实报**「已闲置 N 分钟」（`idleSec` 本来就是这个意思）。
 *
 * ## 输出格式（≤500 字）
 * ```
 * 【用户最近2小时在电脑上】
 * 07:12-07:48 chrome.exe（B站：波兰枪击案…）
 * 07:48-08:05 QQ.exe（小号）
 * 08:05-现在 Code.exe（free-time.mjs）
 * 总览：chrome 42 分钟 / QQ 35 分钟 / Code 25 分钟
 * 当前：前台 Code.exe（08:05 起），已闲置 5 分钟
 * ```
 * - 前缀行一句话；时间线最多 6 段（`MAX_SEGMENTS`，取**最新**的 6 段）；
 * - 总览取前台时长前 3 名，进程名去掉 `.exe`（省字，也更好读）；
 * - 标题过一遍清洗（去 CR/LF/TAB、压空白、截断 30 字），中文原样保留；
 * - 最新一条事件早于 `now` 15 分钟以上 ⇒ 当前行补一句「记录器可能已停」。
 *
 * ## 满了怎么砍
 * 先**丢时间线里最旧的段**（一段一段丢到不超上限），还超就整段硬截到 500 字（末尾「…」）。
 * 总览和当前状态**永远不砍** —— 那两行才是"现在在干嘛"。
 *
 * 目录可用 `QQ_ACTIVITY_LOG_DIR` 覆盖（测试用；默认 `%LOCALAPPDATA%\activity-log`）。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** 摘要正文的硬上限（字符数，含换行）。 */
const MAX_CHARS = 500;
/** 短于这个时长的段整段丢掉（3 分钟）。 */
const MIN_SEGMENT_MS = 3 * 60 * 1000;
/** 时间线最多几段（取最新的）。 */
const MAX_SEGMENTS = 6;
/** 总览最多几个进程。 */
const MAX_PROCS = 3;
/** 标题截断到几个字。 */
const TITLE_MAX = 30;
/** 「同标题前缀」判据取前面几个字。 */
const TITLE_PREFIX = 12;
/** 最新事件比 now 早这么久 ⇒ 怀疑记录器停了。 */
const STALE_MS = 15 * 60 * 1000;
/** 一天多少毫秒（只用来算"该读哪几个日文件"，跨 DST 差一小时无所谓）。 */
const DAY_MS = 24 * 3600 * 1000;
/** 默认看最近几小时。 */
export const ACTIVITY_HOURS = 2;

const pad2 = (n) => String(n).padStart(2, '0');

/** `1794183125750` → `08:12`（**本地时区**：记录器写的就是本地时间）。 */
function hhmm(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `1794183125750` → `2026-11-09`（本地日期，用来拼文件名）。 */
function dayStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 标题清洗：去掉 CR / LF / TAB（一行一条是硬要求 —— 换行会把时间线撕开），
 * 连续空白压成一个空格，中文原样保留。
 */
function cleanTitle(value) {
  return String(value ?? '')
    .replace(/[\r\n\t\u0000]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 截断到 `max` 个字（含末尾的「…」）。 */
function clip(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** 进程名去掉 `.exe`（只在总览里用，省字）。 */
function shortProc(proc) {
  const name = String(proc ?? '').trim();
  return name.replace(/\.exe$/iu, '') || name;
}

/** 日志目录：环境变量优先，默认 `%LOCALAPPDATA%\activity-log`；认不出来返回空串。 */
function activityDir() {
  const override = String(process.env.QQ_ACTIVITY_LOG_DIR ?? '').trim();
  if (override !== '') return override;
  const base = String(process.env.LOCALAPPDATA ?? '').trim();
  if (base === '') return '';
  return path.join(base, 'activity-log');
}

/**
 * 一行一条地读某个日文件，把窗口内的事件按 `ms` 升序返回。
 *
 * 坏行（非 JSON / 非对象 / 没有数字 `ms`）⇒ **跳过**，不影响别的行。
 * 文件不存在 ⇒ 什么都不做（"今天还没写过"是常态，不是错误）。
 */
async function readEvents(dir, sinceMs, nowMs) {
  const events = [];
  // 今天的文件 + 往前够覆盖窗口的那几天（2 小时 ⇒ 今天 + 昨天）。
  const daySpan = Math.max(1, Math.ceil((nowMs - sinceMs) / DAY_MS) + 1);
  for (let offset = daySpan - 1; offset >= 0; offset -= 1) {
    const file = path.join(dir, `events-${dayStamp(nowMs - offset * DAY_MS)}.jsonl`);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      continue; // 没有这个文件 / 读不到 ⇒ 跳过
    }
    if (!stat.isFile() || stat.size === 0) continue;

    let stream = null;
    const rl = readline.createInterface({
      input: (stream = fs.createReadStream(file, { encoding: 'utf8' })),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let raw = null;
        try {
          raw = JSON.parse(trimmed);
        } catch {
          continue; // 坏行（写了一半 / 手改过）⇒ 跳过
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const ms = Number(raw.ms);
        if (!Number.isFinite(ms) || ms < sinceMs) continue;
        const idleSec = Number(raw.idleSec);
        events.push({
          k: typeof raw.k === 'string' ? raw.k : '',
          ms,
          proc: typeof raw.proc === 'string' ? raw.proc.trim() : '',
          hwnd: typeof raw.hwnd === 'string' ? raw.hwnd : '',
          title: typeof raw.title === 'string' ? raw.title : '',
          idleSec: Number.isFinite(idleSec) ? idleSec : null,
        });
      }
    } finally {
      try {
        rl.close();
      } catch {
        /* 关不掉就算了 */
      }
      try {
        stream?.destroy();
      } catch {
        /* 同上 */
      }
    }
  }
  // 稳定排序：同一毫秒的多条按文件里的顺序（`Array#sort` 是稳定的）。
  events.sort((a, b) => a.ms - b.ms);
  return events;
}

/** 从锚点事件（focus / snap）切成 [start, end) 的段。 */
function segmentsOf(anchors, nowMs) {
  const segments = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const item = anchors[i];
    const next = i + 1 < anchors.length ? anchors[i + 1].ms : nowMs;
    const end = Math.min(next, nowMs);
    if (end <= item.ms) continue;
    segments.push({
      start: item.ms,
      end,
      proc: item.proc,
      hwnd: item.hwnd,
      title: cleanTitle(item.title),
    });
  }
  return segments;
}

/** 标题前缀（"同一个窗口里换了标签页"也算同一段）。 */
function titleKey(title) {
  return title.slice(0, TITLE_PREFIX);
}

/** 合并相邻的同一进程（同 hwnd 或同标题前缀）。 */
function mergeSegments(segments) {
  const merged = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    const sameProc = prev !== undefined && prev.proc === seg.proc;
    const sameWindow = sameProc
      && ((prev.hwnd !== '' && prev.hwnd === seg.hwnd) || titleKey(prev.title) === titleKey(seg.title));
    if (sameWindow) {
      prev.end = seg.end;
      // 显示**最新**那个标题（她正看着的那一页），空标题不覆盖已知标题。
      if (seg.title !== '') prev.title = seg.title;
      continue;
    }
    merged.push({ ...seg });
  }
  return merged;
}

/**
 * 碎段（< 3 分钟）**叠到相邻段上**（2026-11-09 的取舍，见模块注释第 4 条）。
 *
 * 有前一段 ⇒ 把前一段的 `end` 延到这个碎段的结束（时间归邻居，标题不动）；
 * 在最前面（还没有长段）⇒ 记下起点，等第一段长段出现时把它的 `start` 提前。
 * 全是碎段 ⇒ 保留最长的那一段（否则整份摘要会变成没有时间线的空壳）。
 */
function foldShort(segments) {
  if (segments.length === 0) return [];
  const kept = [];
  let leadingStart = null;
  for (const seg of segments) {
    if (seg.end - seg.start >= MIN_SEGMENT_MS) {
      kept.push({ ...seg });
      if (leadingStart !== null) {
        kept[kept.length - 1].start = leadingStart;
        leadingStart = null;
      }
      continue;
    }
    if (kept.length > 0) {
      kept[kept.length - 1].end = seg.end;
    } else if (leadingStart === null) {
      leadingStart = seg.start;
    }
  }
  if (kept.length > 0) return kept;
  return [segments.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a))];
}

/** 叠完之后时间上已经连续：相邻的同进程段再并一次（同一个窗口被碎段隔开的那种）。 */
function joinSameProc(segments) {
  const out = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.proc === seg.proc && seg.start <= prev.end) {
      prev.end = Math.max(prev.end, seg.end);
      if (seg.title !== '') prev.title = seg.title;
      continue;
    }
    out.push({ ...seg });
  }
  return out;
}

/**
 * 空闲区间列表 `[{start, end}]`。
 *
 * 起点 = `idle.ms - idleSec*1000`（"第一次超过 600 秒"那一刻往回推），
 * 终点 = 后面第一条 `active` 或 `focus`（能切窗口就说明人回来了），没回来就延到 `now`。
 */
function idleIntervals(events, nowMs) {
  const list = [];
  let open = null;
  for (const ev of events) {
    if (ev.k === 'idle') {
      if (open !== null) open.end = ev.ms; // 连着两条 idle（不该发生）⇒ 前一条就地收口
      const back = ev.idleSec !== null && ev.idleSec > 0 ? ev.idleSec * 1000 : 0;
      open = { start: ev.ms - back, end: null };
      list.push(open);
      continue;
    }
    if ((ev.k === 'active' || ev.k === 'focus') && open !== null && ev.ms >= open.start) {
      open.end = ev.ms;
      open = null;
    }
  }
  for (const item of list) if (item.end === null) item.end = nowMs;
  return list;
}

/** 一段与空闲区间的重叠毫秒数。 */
function idleOverlapMs(seg, idle) {
  let sum = 0;
  for (const item of idle) {
    const from = Math.max(seg.start, item.start);
    const to = Math.min(seg.end, item.end);
    if (to > from) sum += to - from;
  }
  return sum;
}

/** 每个进程的**有操作**前台时长（降序）。 */
function procTotals(segments, idle) {
  const map = new Map();
  for (const seg of segments) {
    const active = Math.max(0, seg.end - seg.start - idleOverlapMs(seg, idle));
    if (active <= 0) continue;
    map.set(seg.proc, (map.get(seg.proc) ?? 0) + active);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/** 最近一个"知道前台进程"的事件（focus / snap）。 */
function lastWithProc(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if ((ev.k === 'focus' || ev.k === 'snap') && ev.proc !== '') return ev;
  }
  return null;
}

/** 当前闲置了多久（毫秒）：挂着 idle 就按现在算，否则看最后一条 `idleSec`。 */
function idleNowMs(events, nowMs) {
  const list = idleIntervals(events, nowMs);
  const last = list[list.length - 1];
  if (last !== undefined && last.end === nowMs && last.start <= nowMs && nowMs - last.start > 0) {
    return nowMs - last.start;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.k === 'active') return 0; // 刚回来
    if (ev.idleSec !== null) return Math.max(0, ev.idleSec * 1000);
  }
  return 0;
}

/** 当前状态那一行（拿不到前台进程 ⇒ 空串）。 */
function currentLine(events, nowMs) {
  const last = lastWithProc(events);
  if (last === null) return '';
  // 「最近一次 focus 的 t」—— 字面意思：不管是不是同一个进程。
  let focusAt = last.ms;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].k === 'focus' && events[i].proc !== '') {
      focusAt = events[i].ms;
      break;
    }
  }
  const idleMs = idleNowMs(events, nowMs);
  const idleText = idleMs >= 60_000 ? `已闲置 ${Math.max(1, Math.floor(idleMs / 60_000))} 分钟` : '正在用';
  let line = `当前：前台 ${last.proc}（${hhmm(focusAt)} 起），${idleText}`;
  const newest = events[events.length - 1];
  if (newest !== undefined && nowMs - newest.ms > STALE_MS) {
    line += `；记录器可能已停（最后一条 ${hhmm(newest.ms)}）`;
  }
  return line;
}

/** 拼正文（纯函数，测试直接钉它的输出）。 */
function buildText(events, { hours, nowMs }) {
  const focuses = events.filter((ev) => ev.k === 'focus' && ev.proc !== '');
  const anchors = focuses.length > 0 ? focuses : events.filter((ev) => ev.k === 'snap' && ev.proc !== '');
  const merged = mergeSegments(segmentsOf(anchors, nowMs));
  const kept = joinSameProc(foldShort(merged));
  if (kept.length === 0) return '';

  const idle = idleIntervals(events, nowMs);
  const shown = kept.slice(-MAX_SEGMENTS);
  const header = `【用户最近${hours}小时在电脑上】`;
  let segmentLines = shown.map((seg, i) => {
    const isLast = i === shown.length - 1;
    const endText = isLast && nowMs - seg.end < 60_000 ? '现在' : hhmm(seg.end);
    const title = seg.title === '' ? '' : `（${clip(seg.title, TITLE_MAX)}）`;
    return `${hhmm(seg.start)}-${endText} ${seg.proc}${title}`;
  });

  // 总览 / 当前状态放最后 —— 截断只砍时间线，这两行必须活下来。
  const tail = [];
  const totals = procTotals(kept, idle);
  if (totals.length > 0) {
    tail.push(
      `总览：${totals
        .slice(0, MAX_PROCS)
        .map(([proc, ms]) => `${shortProc(proc)} ${Math.max(1, Math.round(ms / 60_000))} 分钟`)
        .join(' / ')}`,
    );
  }
  const current = currentLine(events, nowMs);
  if (current !== '') tail.push(current);

  const render = () => [header, ...segmentLines, ...tail].join('\n');
  let text = render();
  while (text.length > MAX_CHARS && segmentLines.length > 1) {
    segmentLines = segmentLines.slice(1); // 先丢最旧的段
    text = render();
  }
  if (text.length > MAX_CHARS) text = clip(text, MAX_CHARS); // 还超 ⇒ 硬截
  return text;
}

/**
 * 读最近 `hours` 小时的电脑活动，压成一段给提示词用的短文本。
 *
 * **永不抛**：任何异常（目录不存在 / 编码坏了 / 没有数据）都返回 `null`。
 *
 * @param {{hours?: number, now?: number}} [options]
 *   `hours` 往回看多久（默认 2）；`now` 毫秒时间戳（默认当下，测试要注入）
 * @returns {Promise<{text: string}|null>} `null` = 没有可用数据
 */
export async function readActivitySummary({ hours = ACTIVITY_HOURS, now = Date.now() } = {}) {
  try {
    const dir = activityDir();
    if (dir === '') return null;
    const spanRaw = Number(hours);
    const spanHours = Number.isFinite(spanRaw) && spanRaw > 0 ? spanRaw : ACTIVITY_HOURS;
    const nowRaw = Number(now);
    const nowMs = Number.isFinite(nowRaw) ? nowRaw : Date.now();
    const sinceMs = nowMs - spanHours * 3600 * 1000;

    const events = await readEvents(dir, sinceMs, nowMs);
    if (events.length === 0) return null;
    const text = buildText(events, { hours: Math.max(1, Math.round(spanHours)), nowMs });
    return text === '' ? null : { text };
  } catch {
    // 唤醒路径上的东西 —— 读日志失败只是"这轮没有活动摘要"。
    return null;
  }
}
