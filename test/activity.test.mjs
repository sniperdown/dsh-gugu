/**
 * 「用户最近 2 小时在电脑上」摘要（`src/dsh/activity.mjs`）的契约测试。
 *
 * 三条硬约束：
 * - **绝不读真实日志**：每个用例都在 `test/` 下现造临时目录，用 `QQ_ACTIVITY_LOG_DIR`
 *   指过去（`%LOCALAPPDATA%\activity-log` 里是真人的真实活动，绝不能进测试）。
 * - **`now` 必须注入**：窗口是 `[now-2h, now)`，日文件名也是按本地日期拼的。
 * - 只测**生产代码已经写下**的契约（见 `activity.mjs` 顶部注释里的取舍表）。
 *
 * 最后三条钉的是注入：**自由活动轮**带活动段、**追加轮（followup）一个字都不带** ——
 * 这条是这次改动最要紧的边界（漏到追问轮会把"他是不是不回了"拽成聊电脑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTIVITY_HOURS, readActivitySummary } from '../src/dsh/activity.mjs';
import { createFreeTime } from '../src/dsh/free-time.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_PREFIX = '.tmp-activity-';

/** 临时目录（造在 test/ 下 —— 受限沙箱里 `%TEMP%` 会被挡）。 */
const TEMP_DIRS = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(HERE, TMP_PREFIX));
  TEMP_DIRS.push(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 收尾失败不该影响测试结果 */
    }
  }
});

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日期（日文件名用的就是它）。 */
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 基准时刻 = 2026-11-09 08:23（本地）。窗口因此是 `[06:23, 08:23)`。 */
const NOW = new Date(2026, 10, 9, 8, 23, 0, 0).getTime();
/** 当天某个本地时刻。 */
const at = (hour, minute, second = 0) => new Date(2026, 10, 9, hour, minute, second, 0).getTime();

function dayFile(dir, ms) {
  return path.join(dir, `events-${stamp(ms)}.jsonl`);
}

/** 把事件写成一个日文件（一行一个 JSON，跟记录器同形状）。 */
function writeEvents(dir, ms, events) {
  const lines = events.map((ev) => JSON.stringify(ev)).join('\n');
  fs.writeFileSync(dayFile(dir, ms), `${lines}\n`, 'utf8');
}

function focus(ms, proc, title, hwnd = '0x1') {
  return { t: new Date(ms).toISOString(), k: 'focus', ms, proc, pid: 1000, hwnd, title };
}

function snap(ms, proc, title, idleSec, hwnd = '0x1') {
  return {
    t: new Date(ms).toISOString(),
    k: 'snap',
    ms,
    proc,
    pid: 1000,
    hwnd,
    title,
    idleSec,
    wins: [{ proc, pid: 1000, hwnd, title }],
  };
}

function idleEvent(ms, idleSec) {
  return { t: new Date(ms).toISOString(), k: 'idle', ms, idleSec };
}

function activeEvent(ms) {
  return { t: new Date(ms).toISOString(), k: 'active', ms };
}

/** 临时把 `QQ_ACTIVITY_LOG_DIR` 指过去，跑完还原（同一个进程里跑全部测试）。 */
async function withLogDir(dir, fn) {
  const before = process.env.QQ_ACTIVITY_LOG_DIR;
  process.env.QQ_ACTIVITY_LOG_DIR = dir;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.QQ_ACTIVITY_LOG_DIR;
    else process.env.QQ_ACTIVITY_LOG_DIR = before;
  }
}

/** 时间线那几行（`HH:MM-HH:MM …`），总览 / 当前状态不算。 */
function segmentLines(text) {
  return String(text ?? '').split('\n').filter((line) => /^\d\d:\d\d-/.test(line));
}

// ================================================================ 时间线

test('★ 同一进程连续的 focus 合并成一段（同 hwnd 或同标题前缀都算同一段）', async () => {
  const dir = tempDir();
  writeEvents(dir, NOW, [
    focus(at(7, 0), 'chrome.exe', 'B站：波兰枪击案', '0xAA'),
    // 同一窗口里换了个标签页（标题变了、hwnd 没变）⇒ 仍然是同一段
    focus(at(7, 20), 'chrome.exe', 'B站：波兰枪击案 - 第2P', '0xAA'),
    focus(at(7, 50), 'Code.exe', 'free-time.mjs', '0xBB'),
  ]);
  const out = await withLogDir(dir, () => readActivitySummary({ now: NOW }));
  assert.ok(out !== null, '有数据就必须给摘要');
  const lines = segmentLines(out.text);
  assert.deepEqual(lines, [
    '07:00-07:50 chrome.exe（B站：波兰枪击案 - 第2P）',
    '07:50-现在 Code.exe（free-time.mjs）',
  ]);
  assert.match(out.text, /^【用户最近2小时在电脑上】/u, '第一行是那句话的前缀');
});

test('★ 短于 3 分钟的碎段叠到相邻段上（不单独成段，时间也不丢）', async () => {
  const dir = tempDir();
  writeEvents(dir, NOW, [
    focus(at(7, 0), 'chrome.exe', 'B站', '0xAA'),
    focus(at(7, 30), 'lghub.exe', 'G HUB', '0xCC'), // 07:30-07:32 = 2 分钟，< 3 分钟
    focus(at(7, 32), 'chrome.exe', 'B站', '0xAA'),
    focus(at(8, 0), 'QQ.exe', '小号', '0xDD'),
  ]);
  const out = await withLogDir(dir, () => readActivitySummary({ now: NOW }));
  const lines = segmentLines(out.text);
  assert.equal(lines.some((line) => line.includes('lghub')), false, '2 分钟的碎段不该单独成段');
  assert.equal(out.text.includes('lghub'), false, '总览里也不该出现（时间记到邻居头上）');
  // chrome 那两截被碎段隔开、叠完之后时间连续、同一个进程 ⇒ 再并回一段（时间线不留洞）
  assert.deepEqual(lines, [
    '07:00-08:00 chrome.exe（B站）',
    '08:00-现在 QQ.exe（小号）',
  ]);
  assert.match(out.text, /总览：chrome 60 分钟 \/ QQ 23 分钟/u, '碎段的 2 分钟算在 chrome 上，没被丢掉');
});

test('★ idle 段：总览扣掉空闲重叠，当前行照实报「已闲置 N 分钟」', async () => {
  const dir = tempDir();
  writeEvents(dir, NOW, [
    focus(at(7, 0), 'chrome.exe', 'B站', '0xAA'),
    idleEvent(at(7, 30), 900), // 「首次超过 600 秒」⇒ 其实从 07:15 就闲置了
    activeEvent(at(7, 45)),
    focus(at(8, 0), 'Code.exe', 'free-time.mjs', '0xBB'),
    snap(at(8, 20), 'Code.exe', 'free-time.mjs', 120, '0xBB'),
  ]);
  const out = await withLogDir(dir, () => readActivitySummary({ now: NOW }));
  // chrome 的前台窗口开了 07:00-08:00（60 分钟），其中 07:15-07:45 在闲置 ⇒ 只算 30 分钟
  assert.match(out.text, /总览：chrome 30 分钟 \/ Code 23 分钟/u);
  assert.deepEqual(segmentLines(out.text), [
    '07:00-08:00 chrome.exe（B站）',
    '08:00-现在 Code.exe（free-time.mjs）',
  ]);
  // idleSec=120（最后一条 snap）⇒ 归一到分钟往下取
  assert.match(out.text, /当前：前台 Code\.exe（08:00 起），已闲置 2 分钟/u);
});

test('★ 最新一条事件早于 now 15 分钟以上 ⇒ 当前行说「记录器可能已停」', async () => {
  const dir = tempDir();
  writeEvents(dir, NOW, [
    focus(at(7, 0), 'chrome.exe', 'B站', '0xAA'),
    focus(at(7, 40), 'Code.exe', 'free-time.mjs', '0xBB'),
  ]);
  const out = await withLogDir(dir, () => readActivitySummary({ now: NOW }));
  // 最后一条是 07:40，比 08:23 早 43 分钟
  assert.match(out.text, /当前：前台 Code\.exe（07:40 起），正在用；记录器可能已停（最后一条 07:40）/u);
});

// ================================================================ 读盘与坏数据

test('★ 目录里没有日文件 ⇒ null（不抛），目录都不存在也一样', async () => {
  const dir = tempDir();
  assert.equal(await withLogDir(dir, () => readActivitySummary({ now: NOW })), null);
  assert.equal(
    await withLogDir(path.join(dir, 'no-such-dir'), () => readActivitySummary({ now: NOW })),
    null,
  );
});

test('坏行被跳过：非 JSON / 空行 / 数组 / null / 裸数字，都不影响其它行', async () => {
  const dir = tempDir();
  const lines = [
    JSON.stringify(focus(at(7, 0), 'chrome.exe', 'B站', '0xAA')),
    'not json at all {{{',
    '{"k":"focus"', // 写了一半
    '[]',
    'null',
    '42',
    '',
    JSON.stringify(focus(at(8, 0), 'Code.exe', 'free-time.mjs', '0xBB')),
    '{"k":"focus","proc":"Weird.exe"}', // 没有 ms ⇒ 不能猜时间
  ];
  fs.writeFileSync(dayFile(dir, NOW), `${lines.join('\n')}\n`, 'utf8');
  const out = await withLogDir(dir, () => readActivitySummary({ now: NOW }));
  assert.ok(out !== null, '八条坏行不该把整份摘要弄没');
  assert.deepEqual(segmentLines(out.text), [
    '07:00-08:00 chrome.exe（B站）',
    '08:00-现在 Code.exe（free-time.mjs）',
  ]);
});

test('跨零点也读得到【前一天】的日文件（按本地日期定位文件）', async () => {
  const dir = tempDir();
  const nowMs = new Date(2026, 10, 9, 0, 30, 0, 0).getTime(); // 00:30，窗口回到前一天 22:30
  const yesterday = new Date(2026, 10, 8, 23, 0, 0, 0).getTime();
  writeEvents(dir, yesterday, [focus(yesterday, 'chrome.exe', 'B站', '0xAA')]);
  const out = await withLogDir(dir, () => readActivitySummary({ now: nowMs }));
  assert.ok(out !== null, '前一天的日文件必须被读到');
  assert.deepEqual(segmentLines(out.text), ['23:00-现在 chrome.exe（B站）']);
});

// ================================================================ 长度上限

test('★ 输出长度硬上限 500 字：先丢最旧的段，总览和当前状态留下', async () => {
  const dir = tempDir();
  const events = [];
  for (let i = 0; i < 12; i += 1) {
    const ms = at(6, 30) + i * 9 * 60_000; // 每段 9 分钟（> 3 分钟，不会被当碎段）
    events.push(focus(ms, `long-process-name-${String(i).padStart(2, '0')}.exe`, `${'很长的标题'.repeat(20)}${i}`, `0x${i}`));
  }
  writeEvents(dir, NOW, events);
  const out = await withLogDir(dir, () => readActivitySummary({ now: NOW }));
  assert.ok(out !== null);
  assert.ok(out.text.length <= 500, `长度必须 ≤ 500（实际 ${out.text.length}）`);
  const lines = segmentLines(out.text);
  assert.ok(lines.length >= 1 && lines.length <= 6, `时间线最多 6 段（实际 ${lines.length}）`);
  assert.equal(lines.some((line) => line.includes('long-process-name-00.exe')), false, '最旧的段先被砍');
  assert.equal(lines.some((line) => line.includes('long-process-name-11.exe')), true, '最新的段必须留下');
  assert.match(out.text, /总览：/u, '总览不能被砍掉');
  assert.match(out.text, /当前：/u, '当前状态不能被砍掉');
});

// ================================================================ 唤醒提示词注入

const PRIVATE = 'private:30000001';
const ACTIVITY_TEXT = '【用户最近2小时在电脑上】\n07:12-07:48 chrome.exe（B站）\n总览：chrome 36 分钟\n当前：前台 chrome.exe（07:12 起），正在用';

function localAt(hour, minute = 0) {
  return new Date(2026, 10, 9, hour, minute, 0, 0).getTime();
}

function makeGateway() {
  const delivered = [];
  return {
    delivered,
    async deliverFromAlice(request) {
      delivered.push(request);
      return '这一轮挺好的';
    },
    async speakProactively() {
      return true;
    },
  };
}

/**
 * 装一套 free-time。`activity` **必须显式给**（默认实现读本机真实日志）。
 * @param {{activity: Function, cfg?: object, t0?: number}} options
 */
function harness({ activity, cfg = {}, t0 = localAt(10) }) {
  const clock = { now: t0 };
  const gateway = makeGateway();
  const config = {
    enabled: true,
    intervalHours: 3,
    windowStartHour: 0,
    windowEndHour: 24,
    tokenBudgetPerTurn: 20000,
    quietWhenNothing: true,
    ...cfg,
  };
  const ft = createFreeTime({
    gateway,
    binder: { locks: new Map() },
    log: () => {},
    now: () => clock.now,
    getConfig: () => config,
    privateChatId: PRIVATE,
    capture: null,
    screenshotsDir: '',
    activity,
  });
  return { ft, clock, gateway };
}

test('★ 自由活动轮：提示词**末尾**追加活动摘要，用空行隔开；取数窗口是最近 2 小时', async () => {
  const calls = [];
  const reader = async (options) => {
    calls.push(options);
    return { text: ACTIVITY_TEXT };
  };
  const { ft, gateway } = harness({ activity: reader });
  const result = await ft.tick();
  assert.equal(result.reason, 'sent');
  const text = gateway.delivered[0].text;
  assert.ok(text.startsWith('【你自己的时间】'), '内置文案还在最前面');
  assert.ok(text.endsWith(`\n\n${ACTIVITY_TEXT}`), '摘要拼在末尾，用空行隔开');
  assert.deepEqual(calls, [{ hours: ACTIVITY_HOURS, now: localAt(10) }], '窗口就是 2 小时，锚在这次唤醒的时刻');
  assert.equal(ACTIVITY_HOURS, 2);
});

test('★ 追加轮（followup）**一个字都不加** —— 也不能去读日志', async () => {
  const calls = [];
  const reader = async (options) => {
    calls.push(options);
    return { text: ACTIVITY_TEXT };
  };
  const { ft, clock, gateway } = harness({ activity: reader, cfg: { followupMinutes: 10 } });
  await ft.tick(); // 10:00 长唤醒（这一轮带摘要）
  assert.ok(gateway.delivered[0].text.includes('用户最近2小时'), '长唤醒是该带的');

  // 用户 10:30 在私聊说了一句 ⇒ 短追问重新上膛；10:45 还没动静 ⇒ 追问
  clock.now = localAt(10, 30);
  assert.equal(ft.noteUserMessage({ userId: '30000001', at: clock.now, chatId: PRIVATE }), true);
  clock.now = localAt(10, 45);
  const result = await ft.tick();
  assert.equal(result.reason, 'sent');

  const followupText = gateway.delivered[1].text;
  assert.match(followupText, /【短追问】/u, '这一轮确实是追问');
  assert.equal(followupText.includes('用户最近2小时'), false, '追问卷绝不能带活动摘要');
  assert.equal(followupText.includes(ACTIVITY_TEXT), false);
  assert.equal(calls.length, 1, '追问轮压根不该去读日志（只该有长唤醒那一次）');
});

test('拿不到摘要（null / 空 / 抛错）⇒ 提示词与改动之前**逐字节一致**，唤醒照常', async () => {
  const readers = [() => null, () => ({ text: '' }), () => ({ text: '   ' }), () => { throw new Error('日志炸了'); }];
  const texts = [];
  for (const activity of readers) {
    const { ft, gateway } = harness({ activity });
    const result = await ft.tick();
    assert.equal(result.reason, 'sent', '摘要取不到也要照常唤醒');
    texts.push(gateway.delivered[0].text);
  }
  for (const text of texts) {
    assert.equal(text, texts[0], '这四种情况必须产生同一段提示词');
    assert.equal(text.includes('用户最近'), false);
    assert.equal(text.endsWith('\n'), false, '不许留多余的尾随换行');
  }
  assert.ok(texts[0].includes('【你自己的时间】'));
});

test('配了 wakePrompt 也照样在末尾追加（配置优先只影响主体那段）', async () => {
  const { ft, gateway } = harness({ activity: async () => ({ text: ACTIVITY_TEXT }), cfg: { wakePrompt: '自定义唤醒词' } });
  await ft.tick();
  assert.equal(gateway.delivered[0].text, `自定义唤醒词\n\n${ACTIVITY_TEXT}`);
});
