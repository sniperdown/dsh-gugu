/**
 * 「她自己的时间」（`src/dsh/free-time.mjs`）的契约测试。
 *
 * 三条硬约束：
 * - **绝不真的叫醒她** —— `gateway` 全是替身，`deliverFromAlice` / `speakProactively`
 *   只把调用记下来；不碰 DSH、不碰 QQ、不碰网络。
 * - **`now` 必须注入** —— 窗口按**本地小时**判断、间隔按毫秒比较，真时钟测不了。
 * - 只测生产代码**已经写下**的契约（`900828c`），不改 `src/**`。
 *
 * 四条闸的顺序（`shouldWake`）：disabled → 窗口 → 间隔 → busy → go。
 *
 * 2026-10-23 起闸门分**长唤醒 / 短追问**两条（见 `src/dsh/free-time.mjs` 模块注释）：
 * 长唤醒过四道闸；短追问只过前三道（第三道换成 `followupMinutes`）且不截图。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFreeTime } from '../src/dsh/free-time.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT_TMP_PREFIX = '.tmp-free-time-shot-';

/** 截图落盘目录（在 test/ 下现造 —— 受限沙箱里 `%TEMP%` 会被挡）。 */
function shotDir() {
  return fs.mkdtempSync(path.join(HERE, SHOT_TMP_PREFIX));
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith(SHOT_TMP_PREFIX)) fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
    }
  } catch {
    /* 收尾失败不该影响测试结果 */
  }
});

/**
 * 截屏替身：**绝不真的执行 PowerShell**。
 * `result` 可以是对象（每次都返回它），也可以是函数（按入参现算）。
 */
function fakeCapture(result = {}) {
  const calls = [];
  async function capture(input) {
    calls.push(input);
    return typeof result === 'function' ? result(input) : result;
  }
  return { capture, calls };
}

const HOUR = 3600 * 1000;

/**
 * 本地时间戳 —— 闸里用的是 `new Date(at).getHours()`，**不是 UTC**。
 * 2026-01-15 是普通的一天（北半球没有夏令时切换），本地小时就是传进去的那个。
 */
function localAt(hour, minute = 0, second = 0) {
  return new Date(2026, 0, 15, hour, minute, second, 0).getTime();
}

const PRIVATE = 'private:30000001';
/** `private:` → `qq-private-`（生产里 binder 的锁键）。 */
const SESSION = 'qq-private-30000001';

const DEFAULT_CFG = {
  enabled: true,
  intervalHours: 3,
  windowStartHour: 0,
  windowEndHour: 24,
  tokenBudgetPerTurn: 20000,
  quietWhenNothing: true,
};

/** 一份可中途改的配置（`getConfig` 每次现取 —— 热重载语义）。 */
function configBox(overrides = {}) {
  const state = { ...DEFAULT_CFG, ...overrides };
  return {
    state,
    get: () => state,
    set: (patch) => {
      Object.assign(state, patch);
      return state;
    },
  };
}

/** 她"忙不忙"只看 `binder.locks` 这个 Map。 */
function makeBinder(keys = []) {
  const locks = new Map();
  for (const key of keys) locks.set(key, Promise.resolve());
  return { locks };
}

/** 网关替身：记账、可注入回复 / 返回值 / 抛错。 */
function makeGateway(options = {}) {
  const delivered = [];
  const spoken = [];
  const calls = { deliver: 0, speak: 0 };
  return {
    delivered,
    spoken,
    calls,
    async deliverFromAlice(request) {
      calls.deliver += 1;
      delivered.push(request);
      if (options.onDeliver) return options.onDeliver(request, calls.deliver);
      return 'reply' in options ? options.reply : '这一轮挺好的';
    },
    async speakProactively(chatId, text) {
      calls.speak += 1;
      spoken.push({ chatId, text });
      if (options.onSpeak) return options.onSpeak(chatId, text, calls.speak);
      return 'speakResult' in options ? options.speakResult : true;
    },
  };
}

/**
 * 装一套 free-time。
 * @param {object} [options]
 * @param {object} [options.cfg] 覆盖默认配置的字段
 * @param {object} [options.config] 直接给一个 `{ get }`（测 null / 垃圾值用）
 * @param {object} [options.binder] 直接给 binder（测 null / 非 Map 用）
 * @param {object} [options.gateway] 直接给网关替身
 * @param {object} [options.gatewayOptions] 传给默认网关替身的选项
 * @param {number} [options.t0] 注入时钟的起点
 */
function harness(options = {}) {
  const clock = { now: options.t0 ?? localAt(12) };
  clock.set = (value) => { clock.now = value; };
  clock.advance = (ms) => { clock.now += ms; };

  const config = options.config ?? configBox(options.cfg);
  const gateway = options.gateway ?? makeGateway(options.gatewayOptions);
  const logs = [];
  const ft = createFreeTime({
    gateway,
    binder: 'binder' in options ? options.binder : makeBinder(),
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => clock.now,
    getConfig: config.get,
    privateChatId: 'privateChatId' in options ? options.privateChatId : PRIVATE,
    // 2026-10-21：截屏默认 **不注入** —— 这一组测试绝不允许真的执行 PowerShell。
    capture: 'capture' in options ? options.capture : null,
    screenshotsDir: options.screenshotsDir ?? '',
    captureTimeoutMs: options.captureTimeoutMs,
    // 2026-11-09：活动摘要默认 **返回 null** —— 默认实现会读本机真实日志，
    // 那会让下面这些"提示词逐字节相等"的断言随当天日志飘。要测注入的那条另写文件。
    activity: 'activity' in options ? options.activity : () => null,
    ...('prune' in options ? { prune: options.prune } : {}),
    // 跨重启状态（2026-10-23）：默认不落盘（不传 = 空串），要测持久化时显式给路径。
    ...('statePath' in options ? { statePath: options.statePath } : {}),
  });
  return { ft, clock, gateway, config, logs };
}

/** `tick()` 契约是"永不 reject" —— 这层保险让失败信息更直白。 */
async function tickNoThrow(ft) {
  try {
    return await ft.tick();
  } catch (error) {
    assert.fail(`tick() 抛了，契约是永不 reject：${error instanceof Error ? error.stack : String(error)}`);
  }
}

// ================================================================ 闸 1：开关

test('★ 闸1：enabled 不是 true ⇒ disabled（false / 缺省 / getConfig=null 都算）', () => {
  assert.deepEqual(
    harness({ cfg: { enabled: false } }).ft.shouldWake(localAt(12)),
    // 2026-10-23：`shouldWake` 多了一个 `kind`（长唤醒 / 短追问），闸不过时是长那一侧。
    { wake: false, reason: 'disabled', kind: 'long' },
  );
  // 缺字段 ⇒ 不是 true
  assert.equal(harness({ config: { get: () => ({ windowStartHour: 0, windowEndHour: 24 }) } })
    .ft.shouldWake(localAt(12)).reason, 'disabled');
  // getConfig 返回 null（`?? {}` 要兜住）
  assert.equal(harness({ config: { get: () => null } }).ft.shouldWake(localAt(12)).reason, 'disabled');
  // 字符串 "true" 不等于布尔 true —— 不做宽松判断
  assert.equal(harness({ cfg: { enabled: 'true' } }).ft.shouldWake(localAt(12)).reason, 'disabled');
});

// ================================================================ 闸 2：窗口

test('★ 闸2：窗口左闭右开（start 在内、end 在外），reason 带小时数', () => {
  const { ft } = harness({ cfg: { windowStartHour: 10, windowEndHour: 18 } });
  assert.equal(ft.shouldWake(localAt(9, 59)).reason, 'outside-window(9)');
  assert.equal(ft.shouldWake(localAt(10, 0)).reason, 'go');
  assert.equal(ft.shouldWake(localAt(17, 59)).reason, 'go');
  assert.equal(ft.shouldWake(localAt(18, 0)).reason, 'outside-window(18)');
});

test('★ 闸2：windowEndHour=24 = 到当天结束（23 点还在窗口、0 点在外）', () => {
  const { ft } = harness({ cfg: { windowStartHour: 10, windowEndHour: 24 } });
  assert.equal(ft.shouldWake(localAt(10)).reason, 'go');
  assert.equal(ft.shouldWake(localAt(23, 59)).reason, 'go');
  assert.equal(ft.shouldWake(localAt(0)).reason, 'outside-window(0)');
  assert.equal(ft.shouldWake(localAt(9, 59)).reason, 'outside-window(9)');
});

test('闸2：小时按注入时间的【本地小时】算', () => {
  const at = localAt(7, 30);
  assert.equal(new Date(at).getHours(), 7);
  const { ft } = harness({ cfg: { windowStartHour: 7, windowEndHour: 8 } });
  const utcHour = new Date(at).getUTCHours();
  if (utcHour !== 7) {
    // 非 UTC 时区：本地 7 点落在窗口内 ⇒ 只能说明它读的是 getHours()
    assert.equal(ft.shouldWake(at).reason, 'go');
  } else {
    // UTC 时区下这条反证没有意义，退化成"本地=UTC"的自明事实
    assert.equal(utcHour, 7);
  }
});

test('闸2：窗口字段类型不对 ⇒ 回默认 0/24（不猜字符串）', () => {
  const { ft } = harness({
    config: { get: () => ({ enabled: true, windowStartHour: '10', windowEndHour: '11' }) },
  });
  assert.equal(ft.shouldWake(localAt(9)).reason, 'go');
  assert.equal(ft.shouldWake(localAt(23)).reason, 'go');
});

// ================================================================ 闸 3：间隔

test('★ 闸3：距上次 < intervalHours ⇒ too-soon；正好到点 ⇒ 放行（严格小于）', async () => {
  const { ft, clock } = harness({ t0: localAt(12) });
  await tickNoThrow(ft); // 这一轮把 lastRunAt 记成 12:00
  const t = clock.now;
  clock.set(t + 3 * HOUR - 1);
  assert.equal(ft.shouldWake(clock.now).reason, 'too-soon');
  clock.set(t + 3 * HOUR);
  assert.equal(ft.shouldWake(clock.now).reason, 'go');
});

test('★ 闸3：intervalHours 缺省 / 0 / 负数 / 字符串 ⇒ 一律按 3 小时算', async () => {
  const cases = [
    { intervalHours: undefined },
    { intervalHours: 0 },
    { intervalHours: -2 },
    { intervalHours: '3' },
  ];
  for (const cfg of cases) {
    const { ft, clock } = harness({ t0: localAt(12), cfg });
    await tickNoThrow(ft);
    clock.advance(3 * HOUR - 1000);
    assert.equal(ft.shouldWake(clock.now).reason, 'too-soon', JSON.stringify(cfg));
    clock.advance(1000);
    assert.equal(ft.shouldWake(clock.now).reason, 'go', JSON.stringify(cfg));
  }
});

test('闸3：intervalHours=1 就按 1 小时算', async () => {
  const { ft, clock } = harness({ t0: localAt(12), cfg: { intervalHours: 1 } });
  await tickNoThrow(ft);
  clock.advance(HOUR - 1000);
  assert.equal(ft.shouldWake(clock.now).reason, 'too-soon');
  clock.advance(1000);
  assert.equal(ft.shouldWake(clock.now).reason, 'go');
});

// ================================================================ 闸 4：忙

test('★ 闸4：binder.locks 里有她的会话（映射后的键）⇒ busy', () => {
  const { ft } = harness({ binder: makeBinder([SESSION]) });
  assert.equal(ft.shouldWake(localAt(12)).reason, 'busy');
});

test('闸4：锁着别人 / 用原始 chatId 当键 ⇒ 都不算她忙', () => {
  const { ft } = harness({ binder: makeBinder(['qq-private-999', PRIVATE, 'qq-group-1']) });
  assert.equal(ft.shouldWake(localAt(12)).reason, 'go');
});

test('闸4：binder 缺失 / locks 不是 Map ⇒ 不拦', () => {
  for (const binder of [null, undefined, {}, { locks: {} }, { locks: new Map() }]) {
    const { ft } = harness({ binder });
    assert.equal(ft.shouldWake(localAt(12)).reason, 'go', String(binder));
  }
});

// ================================================================ 顺序 / 结果

test('★ 四条闸有先后：disabled > 窗口 > 间隔 > busy', async () => {
  const binder = makeBinder();
  const { ft, config, clock } = harness({
    t0: localAt(20),
    binder,
    cfg: { windowStartHour: 20, windowEndHour: 22, intervalHours: 1 },
  });
  await tickNoThrow(ft); // 先真跑一轮，lastRunAt = 20:00
  binder.locks.set(SESSION, Promise.resolve()); // 之后她一直"忙"

  // disabled 压住窗口外 / 间隔未到 / busy
  config.set({ enabled: false });
  clock.set(localAt(22, 30));
  assert.equal(ft.shouldWake(clock.now).reason, 'disabled');

  // 窗口外压住间隔未到 / busy
  config.set({ enabled: true });
  assert.equal(ft.shouldWake(clock.now).reason, 'outside-window(22)');

  // 同一窗口内：间隔未到压住 busy
  clock.set(localAt(20, 30));
  assert.equal(ft.shouldWake(clock.now).reason, 'too-soon');

  // 间隔到了，才轮到 busy
  clock.set(localAt(21, 30));
  assert.equal(ft.shouldWake(clock.now).reason, 'busy');
});

test('闸都过 ⇒ {wake:true, reason:"go", cfg}，cfg 就是 getConfig() 那一份', () => {
  const { ft, config } = harness();
  const gate = ft.shouldWake(localAt(12));
  assert.equal(gate.wake, true);
  assert.equal(gate.reason, 'go');
  assert.equal(gate.cfg, config.state);
});

test('shouldWake 只判闸：不动任何计数（skipped 也不加）', () => {
  const { ft } = harness();
  ft.shouldWake(localAt(12));
  ft.shouldWake(localAt(12));
  const s = ft.stats();
  assert.equal(s.runs, 0);
  assert.equal(s.skipped, 0);
  assert.equal(s.lastSkip, null);
  assert.equal(s.lastRunAt, null);
});

// ================================================================ tick：闸不过

test('★ tick 闸不过：skipped+1、lastSkip 记原因、不碰网关', async () => {
  const { ft, gateway, logs } = harness({ cfg: { enabled: false } });
  const out = await tickNoThrow(ft);
  assert.deepEqual(out, { woke: false, reason: 'disabled', sent: false, chars: 0 });

  const s = ft.stats();
  assert.equal(s.skipped, 1);
  assert.equal(s.lastSkip, 'disabled');
  assert.equal(s.runs, 0);
  assert.equal(s.lastRunAt, null);
  assert.equal(gateway.calls.deliver, 0);
  assert.equal(gateway.calls.speak, 0);
  assert.deepEqual(logs, []);
});

test('tick 闸不过：窗口外 / busy 各自进 lastSkip，lastRunAt 不动', async () => {
  const outside = harness({ t0: localAt(12), cfg: { windowStartHour: 10, windowEndHour: 11 } });
  assert.equal((await tickNoThrow(outside.ft)).reason, 'outside-window(12)');
  assert.equal(outside.ft.stats().lastSkip, 'outside-window(12)');
  assert.equal(outside.ft.stats().runs, 0);
  assert.equal(outside.gateway.calls.deliver, 0);

  const busy = harness({ binder: makeBinder([SESSION]) });
  assert.equal((await tickNoThrow(busy.ft)).reason, 'busy');
  assert.equal(busy.ft.stats().lastSkip, 'busy');
  assert.equal(busy.ft.stats().lastRunAt, null);
  assert.equal(busy.ft.stats().runs, 0);
  assert.equal(busy.gateway.calls.deliver, 0);
});

test('★ stats() 吐出 skipReasons：按原因累计（lastSkip 会被覆盖，它不会）', async () => {
  // 2026-10-20：`skipReasons` 的采集早就在 runOnce 里了，但 stats() 没吐出来 ——
  // 快照里看不见就等于没采。`lastSkip` 只记最后一次，排查"为什么一直没叫"时不够用。
  const { ft, config } = harness({ cfg: { enabled: false } });
  assert.deepEqual(ft.stats().skipReasons, {}, '初始值是一个空对象');

  await tickNoThrow(ft);
  await tickNoThrow(ft);
  assert.deepEqual(ft.stats().skipReasons, { disabled: 2 }, '同一原因累计两次');

  config.set({ enabled: true, windowStartHour: 10, windowEndHour: 11 });
  await tickNoThrow(ft);
  assert.deepEqual(
    ft.stats().skipReasons,
    { disabled: 2, 'outside-window(12)': 1 },
    '不同原因各记各的',
  );
  assert.equal(ft.stats().lastSkip, 'outside-window(12)', 'lastSkip 只记最后一次');
  assert.equal(ft.stats().skipped, 3);
});

// ================================================================ tick：叫醒

test('★ tick 闸过：调 deliverFromAlice({text, replyTo:null})，runs/lastRunAt【在叫醒之前】就记上', async () => {
  let atDeliver = null;
  const t0 = localAt(12);
  const gateway = makeGateway({
    onDeliver: () => {
      atDeliver = ft.stats(); // 在 deliver 内部看状态
      return '好呀';
    },
  });
  const { ft } = harness({ t0, gateway });

  const out = await tickNoThrow(ft);
  assert.equal(out.reason, 'sent');
  assert.equal(gateway.calls.deliver, 1);
  assert.equal(gateway.delivered.length, 1);
  assert.equal(gateway.delivered[0].replyTo, null);
  assert.equal(typeof gateway.delivered[0].text, 'string');

  // "先记上"：deliver 还没返回时，runs 已经是 1、lastRunAt 已经有值
  assert.equal(atDeliver.runs, 1);
  assert.equal(atDeliver.lastRunAt, new Date(t0).toISOString());
});

test('★ 叫醒词含预算数字与"别删/别改"边界，并说明 [不说话]', async () => {
  const { ft, gateway } = harness({ cfg: { tokenBudgetPerTurn: 12345 } });
  await tickNoThrow(ft);
  const text = gateway.delivered[0].text;
  assert.match(text, /【你自己的时间】/);
  assert.match(text, /12345/);
  assert.match(text, /token/);
  assert.match(text, /不要删/);
  assert.match(text, /不要改/);
  assert.match(text, /\[不说话\]/);
});

test('叫醒词：tokenBudgetPerTurn 不是有限数 ⇒ 用 20000 兜底', async () => {
  for (const tokenBudgetPerTurn of [undefined, null, NaN, '20000']) {
    const { ft, gateway } = harness({ cfg: { tokenBudgetPerTurn } });
    await tickNoThrow(ft);
    assert.match(gateway.delivered[0].text, /20000/, String(tokenBudgetPerTurn));
  }
});

// ============================================================ 提示词可配置（2026-10-29）
//
// 用户要求：把两段唤醒提示词搬进配置页。**空 = 用内置文案**（用户定稿的那两段一个字不改）；
// 非空 ⇒ 用配置的，占位符 `{{budget}}` / `{{minutes}}` / `{{date}}` / `{{time}}` 换成值。
// 最要紧的一条：**用户填的文本按字面处理**（中文引号、`$`、反斜杠、换行都不许动）。

test('★ 配了 wakePrompt ⇒ 用它（内置文案整段不出现），{{budget}} 换成预算数字', async () => {
  const { ft, gateway } = harness({
    cfg: { tokenBudgetPerTurn: 12345, wakePrompt: '【自定义唤醒】预算 {{budget}} token，自己看着办。' },
  });
  await tickNoThrow(ft);
  const text = gateway.delivered[0].text;
  assert.equal(text, '【自定义唤醒】预算 12345 token，自己看着办。');
  assert.doesNotMatch(text, /【你自己的时间】/, '配置优先，内置那段不该再出现');
});

test('★ 占位符替换是【函数式】：文本里的 $ / $& / $` 一个字都不许被展开', async () => {
  // 这几串是 `String.replace` 用字符串作 replacement 时会展开的元字符 ——
  // 本项目在 `apply-src-edits.mjs` 上真踩过（40877 → 99157 字符）。
  const wakePrompt = [
    '前置',
    '价 {{budget}} 元 & 尾巴 $& 和 $` 还有 $\' 和 $1 与 $$ 都按字面',
    '后置',
  ].join('\n');
  const { ft, gateway } = harness({ cfg: { tokenBudgetPerTurn: 777, wakePrompt } });
  await tickNoThrow(ft);
  const text = gateway.delivered[0].text;
  assert.equal(text, '前置\n价 777 元 & 尾巴 $& 和 $` 还有 $\' 和 $1 与 $$ 都按字面\n后置');
  assert.doesNotMatch(text, /【你自己的时间】/);
});

test('★ wakePrompt 里的中文引号 / 反斜杠 / 制表符原样保留', async () => {
  const wakePrompt = '她说“别删文件”\t反斜杠 C:\\tmp\\a 与 \\n 两个字面字符';
  const { ft, gateway } = harness({ cfg: { wakePrompt } });
  await tickNoThrow(ft);
  assert.equal(gateway.delivered[0].text, wakePrompt);
});

test('★ wakePrompt 空 / 只有空白 ⇒ 回内置文案（含【你自己的时间】与预算）', async () => {
  for (const wakePrompt of [undefined, '', '   ', '\n\t ']) {
    const { ft, gateway } = harness({ cfg: { tokenBudgetPerTurn: 20000, wakePrompt } });
    await tickNoThrow(ft);
    const text = gateway.delivered[0].text;
    const label = `wakePrompt=${JSON.stringify(wakePrompt)}`;
    assert.match(text, /【你自己的时间】/, label);
    assert.match(text, /20000/, label);
    assert.match(text, /不要删/, label);
  }
});

test('{{date}} / {{time}} 换成这次唤醒的本地日期与时刻', async () => {
  const { ft, gateway } = harness({
    t0: localAt(9, 5),
    cfg: { wakePrompt: '现在是 {{date}} {{time}}，{{date}} 这一天归你。' },
  });
  await tickNoThrow(ft);
  assert.equal(gateway.delivered[0].text, '现在是 2026-01-15 09:05，2026-01-15 这一天归你。');
});

test('占位符名字不认识 ⇒ 原样留着（不猜意思、不吞掉）', async () => {
  const { ft, gateway } = harness({ cfg: { wakePrompt: '{{budget}} / {{foo}} / {{}}' } });
  await tickNoThrow(ft);
  assert.equal(gateway.delivered[0].text, '20000 / {{foo}} / {{}}');
});

test('★ 配了 followupPrompt ⇒ 用它（内置【短追问】不出现），{{minutes}} 换成间隔', async () => {
  const { ft, clock, gateway } = harness({
    t0: localAt(10),
    cfg: { followupMinutes: 7, followupPrompt: '【自定义追问】他 {{minutes}} 分钟没声了，去看一眼。' },
  });
  await tickNoThrow(ft); // 10:00 长唤醒（用它自己的内置文案）
  clock.set(localAt(10, 30));
  ft.noteUserMessage(userMessage(clock.now));
  clock.set(localAt(10, 37));
  await tickNoThrow(ft); // 10:37 短追问

  const text = gateway.delivered.at(-1).text;
  assert.equal(text, '【自定义追问】他 7 分钟没声了，去看一眼。');
  assert.doesNotMatch(text, /【短追问】/, '配置优先，内置那段不该再出现');
});

test('followupPrompt 空 ⇒ 回内置短追问文案（含【短追问】与分钟数）', async () => {
  for (const followupPrompt of [undefined, '', '  ']) {
    const { ft, clock, gateway } = harness({
      t0: localAt(10),
      cfg: { followupMinutes: 3, followupPrompt },
    });
    await tickNoThrow(ft);
    clock.set(localAt(10, 30));
    ft.noteUserMessage(userMessage(clock.now));
    clock.set(localAt(10, 33));
    await tickNoThrow(ft);
    const text = gateway.delivered.at(-1).text;
    const label = `followupPrompt=${JSON.stringify(followupPrompt)}`;
    assert.match(text, /【短追问】/, label);
    assert.match(text, /3 分钟/, label);
    assert.doesNotMatch(text, /【你自己的时间】/, label);
  }
});

test('★ 她说了内容 ⇒ speakProactively(私聊, 去首尾空白后的正文)，sent+1', async () => {
  const { ft, gateway } = harness({ gatewayOptions: { reply: '  今天看到一只猫  ' } });
  const out = await tickNoThrow(ft);
  assert.equal(out.reason, 'sent');
  assert.equal(out.sent, true);
  assert.equal(out.chars, '今天看到一只猫'.length);
  assert.deepEqual(gateway.spoken, [{ chatId: PRIVATE, text: '今天看到一只猫' }]);

  const s = ft.stats();
  assert.equal(s.sent, 1);
  assert.equal(s.quiet, 0);
  assert.equal(s.skipped, 0);
  assert.equal(s.lastChars, '今天看到一只猫'.length);
});

// ================================================================ tick：安静

test('★ 回空 / [不说话] / （不说话）⇒ 不发、quiet+1', async () => {
  for (const reply of ['', '   ', null, undefined, '[不说话]', '（不说话）', '嗯…[不说话]']) {
    const { ft, gateway } = harness({ gatewayOptions: { reply } });
    const out = await tickNoThrow(ft);
    const label = `reply=${JSON.stringify(reply)}`;
    assert.equal(out.reason, 'quiet', label);
    assert.equal(out.sent, false, label);
    assert.equal(out.woke, true, label);
    assert.equal(gateway.calls.speak, 0, label);
    assert.equal(ft.stats().quiet, 1, label);
    assert.equal(ft.stats().sent, 0, label);
  }
});

test('quiet 时 lastChars 记的是去空白后的长度（空串 0、[不说话] 5）', async () => {
  const empty = harness({ gatewayOptions: { reply: '   ' } });
  await tickNoThrow(empty.ft);
  assert.equal(empty.ft.stats().lastChars, 0);

  const mark = harness({ gatewayOptions: { reply: '[不说话]' } });
  await tickNoThrow(mark.ft);
  assert.equal(mark.ft.stats().lastChars, '[不说话]'.length);
});

test('★ quietWhenNothing=false ⇒ 空手时补一句极短状态，但仍算 quiet（sent 不加）', async () => {
  const { ft, gateway } = harness({
    cfg: { quietWhenNothing: false },
    gatewayOptions: { reply: '[不说话]' },
  });
  const out = await tickNoThrow(ft);
  assert.equal(out.reason, 'quiet');
  assert.deepEqual(gateway.spoken, [{ chatId: PRIVATE, text: '（她这轮没什么想说的）' }]);
  const s = ft.stats();
  assert.equal(s.quiet, 1);
  assert.equal(s.sent, 0);
  assert.equal(s.skipped, 0);
});

test('quietWhenNothing=false 时那句状态发失败 ⇒ 只记 lastError，仍是 quiet、不抛', async () => {
  const { ft } = harness({
    cfg: { quietWhenNothing: false },
    gatewayOptions: {
      reply: '',
      onSpeak: () => { throw new Error('私聊被关掉了'); },
    },
  });
  const out = await tickNoThrow(ft);
  assert.equal(out.reason, 'quiet');
  assert.equal(out.woke, true);
  assert.equal(ft.stats().lastError, '私聊被关掉了');
  assert.equal(ft.stats().quiet, 1);
});

test('quietWhenNothing 缺省（undefined）⇒ 不补状态句', async () => {
  const { ft, gateway } = harness({
    cfg: { quietWhenNothing: undefined },
    gatewayOptions: { reply: '' },
  });
  await tickNoThrow(ft);
  assert.equal(gateway.calls.speak, 0);
  assert.equal(ft.stats().quiet, 1);
});

// ================================================================ tick：被拦 / 出错

test('★ speakProactively 返回非 true（白名单 / 同文拦）⇒ skipped+1、lastSkip=speak-blocked', async () => {
  for (const speakResult of [false, 0, 1, 'ok', null, undefined]) {
    const { ft, gateway } = harness({ gatewayOptions: { reply: '说点什么', speakResult } });
    const out = await tickNoThrow(ft);
    const label = `speakResult=${JSON.stringify(speakResult)}`;
    assert.equal(out.reason, 'speak-blocked', label);
    assert.equal(out.sent, false, label);
    assert.equal(gateway.calls.speak, 1, label);

    const s = ft.stats();
    assert.equal(s.sent, 0, label);
    assert.equal(s.quiet, 0, label);
    assert.equal(s.skipped, 1, label);
    assert.equal(s.lastSkip, 'speak-blocked', label);
  }
});

test('★ deliverFromAlice 抛错 ⇒ woke:true / sent:false、记 lastError、不抛', async () => {
  const { ft, gateway, logs } = harness({
    gatewayOptions: { onDeliver: () => { throw new Error('会话不可用'); } },
  });
  const out = await tickNoThrow(ft);
  assert.deepEqual(out, { woke: true, reason: 'wake-error', sent: false, chars: 0 });

  const s = ft.stats();
  assert.equal(s.lastError, '会话不可用');
  assert.equal(s.sent, 0);
  assert.equal(s.quiet, 0);
  // 失败也占掉这次间隔 —— "先记上"那个取舍
  assert.equal(s.runs, 1);
  assert.ok(s.lastRunAt !== null);
  assert.equal(gateway.calls.speak, 0);
  assert.ok(logs.some((entry) => entry.level === 'warn' && /叫醒失败/.test(entry.message)));
});

test('deliverFromAlice 抛非 Error（字符串）⇒ lastError 原样记下', async () => {
  const { ft } = harness({ gatewayOptions: { onDeliver: () => { throw '断了'; } } });
  const out = await tickNoThrow(ft);
  assert.equal(out.reason, 'wake-error');
  assert.equal(ft.stats().lastError, '断了');
});

test('★ speakProactively 抛错 ⇒ lastError、reason=send-error、skipped 不加、不抛', async () => {
  const { ft, logs } = harness({
    gatewayOptions: {
      reply: '一句',
      onSpeak: () => { throw new Error('发送失败'); },
    },
  });
  const out = await tickNoThrow(ft);
  assert.deepEqual(out, { woke: true, reason: 'send-error', sent: false, chars: '一句'.length });

  const s = ft.stats();
  assert.equal(s.lastError, '发送失败');
  assert.equal(s.sent, 0);
  assert.equal(s.skipped, 0);
  assert.equal(s.lastChars, '一句'.length);
  assert.ok(logs.some((entry) => entry.level === 'warn' && /发出去失败/.test(entry.message)));
});

// ================================================================ 间隔的"占掉"

test('★ 跑过一轮后立刻再 tick ⇒ too-soon（skipped+1，不再叫醒）', async () => {
  const { ft, gateway } = harness({ t0: localAt(12) });
  await tickNoThrow(ft);
  const out = await tickNoThrow(ft);
  assert.equal(out.woke, false);
  assert.equal(out.reason, 'too-soon');
  assert.equal(gateway.calls.deliver, 1);
  assert.equal(ft.stats().skipped, 1);
  assert.equal(ft.stats().lastSkip, 'too-soon');
});

test('★ 间隔到点后再 tick ⇒ 又跑一轮（runs / sent 累加）', async () => {
  const { ft, clock, gateway } = harness({ t0: localAt(12) });
  await tickNoThrow(ft);
  clock.advance(3 * HOUR);
  await tickNoThrow(ft);
  assert.equal(gateway.calls.deliver, 2);
  assert.equal(ft.stats().runs, 2);
  assert.equal(ft.stats().sent, 2);
});

test('叫醒失败也占掉这次间隔（下一分钟仍是 too-soon）', async () => {
  const { ft, clock } = harness({
    gatewayOptions: { onDeliver: () => { throw new Error('炸'); } },
  });
  await tickNoThrow(ft);
  clock.advance(60 * 1000);
  assert.equal(ft.shouldWake(clock.now).reason, 'too-soon');
  assert.equal(ft.stats().runs, 1);
});

test('getConfig 每次现取：中途关掉 enabled ⇒ 下一 tick 立刻 disabled', async () => {
  const { ft, config, clock } = harness({ t0: localAt(12) });
  await tickNoThrow(ft);
  config.set({ enabled: false });
  clock.advance(3 * HOUR);
  const out = await tickNoThrow(ft);
  assert.equal(out.reason, 'disabled');
  assert.equal(ft.stats().lastSkip, 'disabled');
});

// ================================================================ stats

test('★ stats：没跑过时 lastRunAt=null、sessionKey 是映射后的键，字段齐全', () => {
  const { ft } = harness();
  assert.deepEqual(ft.stats(), {
    sessionKey: SESSION,
    lastRunAt: null,
    // 2026-10-23 新增：长短两个钟的锚点与"这轮沉默追问过没有"。
    lastUserMessageAt: null,
    followupDone: true,
    nextFollowupAt: null,
    lastFollowupAt: null,
    lastWakeKind: null,
    userMessages: 0,
    // 2026-10-26 新增：短追问只由**私聊**重新上膛；群消息只推进长唤醒锚点。
    // 这三个字段就是"为什么没被上膛"在快照里的唯一证据。
    lastUserMessageChat: '',
    rearms: 0,
    rearmSkipped: 0,
    persistFailures: 0,
    runs: 0,
    wakes: { long: 0, short: 0 },
    sent: 0,
    // 2026-10-19 新增：`quietWhenNothing=false` 时那句状态"确实发出去了"，
    // 但它不是"她说了话" ⇒ 单独计数，不混进 `sent`。
    notices: 0,
    quiet: 0,
    skipped: 0,
    lastSkip: null,
    // 2026-10-20 新增：按原因累计（`lastSkip` 会被覆盖，它不会）。
    skipReasons: {},
    lastChars: 0,
    lastError: null,
  });
});

test('★ stats：跑过后 lastRunAt 是 ISO 字符串', async () => {
  const t0 = localAt(12);
  const { ft } = harness({ t0 });
  await tickNoThrow(ft);
  assert.equal(ft.stats().lastRunAt, new Date(t0).toISOString());
  assert.match(ft.stats().lastRunAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('★ stats 返回的是副本：改它不影响内部状态，也不会被下一次调用看见', async () => {
  const { ft } = harness();
  await tickNoThrow(ft);

  const first = ft.stats();
  first.runs = 99;
  first.sent = 99;
  first.lastRunAt = 'nope';
  first.lastSkip = 'hacked';
  delete first.quiet;

  const second = ft.stats();
  assert.equal(second.runs, 1);
  assert.equal(second.sent, 1);
  assert.equal(second.lastRunAt, new Date(localAt(12)).toISOString());
  assert.equal(second.lastSkip, null);
  assert.equal(second.quiet, 0);

  // 每次都是新对象
  assert.notEqual(ft.stats(), ft.stats());
  assert.notEqual(first, second);
});

test('stats：sent / quiet / skipped 各自累加、不串账', async () => {
  let reply = '好';
  let speakResult = true;
  const gateway = makeGateway({
    onDeliver: () => reply,
    onSpeak: () => speakResult,
  });
  const { ft, clock } = harness({ t0: localAt(12), gateway });

  await tickNoThrow(ft); // sent
  clock.advance(3 * HOUR);
  reply = ''; // quiet
  await tickNoThrow(ft);
  clock.advance(3 * HOUR);
  reply = '一句'; speakResult = false; // speak-blocked
  await tickNoThrow(ft);
  clock.advance(60 * 1000); // too-soon
  await tickNoThrow(ft);

  const s = ft.stats();
  assert.equal(s.runs, 3);
  assert.equal(s.sent, 1);
  assert.equal(s.quiet, 1);
  assert.equal(s.skipped, 2);
  assert.equal(s.lastSkip, 'too-soon');
});

// ================================================================ 截屏（2026-10-21）

test('★ 截屏成功 ⇒ deliverFromAlice 收到 viewImages:[path]，日志记压缩前基准（含格式）', async () => {
  const dir = shotDir();
  const shot = {
    ok: true,
    path: path.join(dir, 'shot-20261021-030000-000.png'),
    format: 'png',
    width: 7680,
    height: 2160,
    bytes: 17018664,
    reencodeMs: 0,
    ms: 1059,
  };
  const { capture, calls } = fakeCapture(shot);
  const { ft, gateway, logs } = harness({
    cfg: { screenshots: true, screenshotsKeep: 2 },
    capture,
    screenshotsDir: dir,
  });

  const out = await tickNoThrow(ft);
  assert.equal(out.woke, true);
  assert.equal(out.reason, 'sent');
  assert.equal(calls.length, 1, '唤醒前必须截一次');
  assert.equal(calls[0].outDir, dir);
  assert.equal(typeof calls[0].timeoutMs, 'number');
  assert.deepEqual(gateway.delivered[0].viewImages, [shot.path], 'viewImages 必须带且只带这一张');

  // 日志里那条就是"压缩前"的基准数据（给用户看 DSH 管线压了多少）
  const entry = logs.find((item) => item.message.includes('截屏'));
  assert.ok(entry !== undefined, '必须留一条截屏日志');
  assert.deepEqual(entry.meta, {
    ok: true, count: 1, mode: '', width: 7680, height: 2160, bytes: 17018664, format: 'png', reencodeMs: 0, ms: 1059,
  });
});

test('★ 分屏：capture 返回 images[] ⇒ **每一块屏**都进 viewImages（不是只发第一张）', async () => {
  const dir = shotDir();
  const first = path.join(dir, 'shot-20261021-040000-000-1.png');
  const second = path.join(dir, 'shot-20261021-040000-000-2.jpg');
  const { capture } = fakeCapture({
    ok: true,
    mode: 'split',
    count: 2,
    images: [
      { index: 1, path: first, format: 'png', width: 1920, height: 1080, bytes: 100, reencodeMs: 0 },
      { index: 2, path: second, format: 'jpeg', width: 2560, height: 1440, bytes: 200, reencodeMs: 0 },
    ],
    // 兼容字段 = 第一张
    path: first,
    format: 'png',
    width: 1920,
    height: 1080,
    bytes: 100,
    reencodeMs: 0,
    ms: 900,
  });
  const { ft, gateway, logs } = harness({
    cfg: { screenshots: true, screenshotsKeep: 2 },
    capture,
    screenshotsDir: dir,
  });

  const out = await tickNoThrow(ft);
  assert.equal(out.woke, true);
  assert.deepEqual(
    gateway.delivered[0].viewImages,
    [first, second],
    '双屏 ⇒ 两张都要投递，顺序与屏序一致',
  );
  const entry = logs.find((item) => item.message.includes('截屏'));
  assert.equal(entry.meta.count, 2);
  assert.equal(entry.meta.mode, 'split');
});

test('★ screenshotsMaxPerWake：截到 3 张、上限 2 ⇒ 只投递前 2 张（落盘仍是 3 张）', async () => {
  const dir = shotDir();
  const paths = [1, 2, 3].map((n) => path.join(dir, `shot-20261021-050000-000-${n}.png`));
  const { capture } = fakeCapture({
    ok: true,
    mode: 'split',
    images: paths.map((p, index) => ({ index: index + 1, path: p, format: 'png' })),
    path: paths[0],
    format: 'png',
    width: 1920,
    height: 1080,
    bytes: 100,
    reencodeMs: 0,
    ms: 800,
  });
  const { ft, gateway, logs } = harness({
    cfg: { screenshots: true, screenshotsKeep: 2, screenshotsMaxPerWake: 2 },
    capture,
    screenshotsDir: dir,
  });

  await tickNoThrow(ft);
  assert.deepEqual(gateway.delivered[0].viewImages, [paths[0], paths[1]], '只带前 2 张，按屏序');

  // 落盘张数（count）不变：投递上限只影响"喂给模型几张"，不影响截图本身。
  const entry = logs.find((item) => item.message.includes('截屏'));
  assert.equal(entry.meta.count, 3);
  // 被截断这件事要留一条日志，否则"她怎么没看到第三块屏"没法从快照解释。
  const trimmed = logs.find((item) => item.message.includes('超过每轮上限'));
  assert.ok(trimmed !== undefined, '必须留一条"超过每轮上限"的日志');
  assert.deepEqual(trimmed.meta, { captured: 3, sent: 2, screenshotsMaxPerWake: 2 });
});

test('screenshotsMaxPerWake 够大 ⇒ 全部投递，不留"截断"日志', async () => {
  const dir = shotDir();
  const paths = [1, 2].map((n) => path.join(dir, `shot-20261021-060000-000-${n}.png`));
  const { capture } = fakeCapture({
    ok: true,
    mode: 'split',
    images: paths.map((p, index) => ({ index: index + 1, path: p, format: 'png' })),
    path: paths[0],
    format: 'png',
    ms: 700,
  });
  const { ft, gateway, logs } = harness({
    cfg: { screenshots: true, screenshotsMaxPerWake: 5 },
    capture,
    screenshotsDir: dir,
  });

  await tickNoThrow(ft);
  assert.deepEqual(gateway.delivered[0].viewImages, paths);
  assert.equal(logs.find((item) => item.message.includes('超过每轮上限')), undefined);
});

test('★ 超 18MB 重编码成 JPEG ⇒ viewImages 用 .jpg 路径，日志记 format/reencodeMs', async () => {
  const dir = shotDir();
  // 尺寸不变、只换了编码 —— 这里的 path 是 `.jpg`，free-time **只认 path**，不该在意扩展名。
  const shot = {
    ok: true,
    path: path.join(dir, 'shot-20261021-031500-000.jpg'),
    format: 'jpeg',
    width: 7680,
    height: 2160,
    bytes: 7936000,
    reencodeMs: 733,
    ms: 1900,
  };
  const { capture } = fakeCapture(shot);
  const { ft, gateway, logs } = harness({
    cfg: { screenshots: true, screenshotsKeep: 2 },
    capture,
    screenshotsDir: dir,
  });

  const out = await tickNoThrow(ft);
  assert.equal(out.woke, true);
  assert.deepEqual(gateway.delivered[0].viewImages, [shot.path], '换成 JPEG 之后投递的还是那张图');

  const entry = logs.find((item) => item.message.includes('截屏'));
  assert.equal(entry.level, 'info');
  assert.equal(entry.meta.format, 'jpeg', '日志必须能看出这次是重编码过的 JPEG');
  assert.equal(entry.meta.reencodeMs, 733, '重编码耗时也要记');
  assert.equal(entry.meta.bytes, 7936000);
});

test('日志格式归一化：jpg ⇒ jpeg；缺字段/瞎写 ⇒ 空串（不编格式）', async () => {
  for (const [input, expected] of [
    [{ format: 'jpg' }, 'jpeg'],
    [{ format: 'JPEG' }, 'jpeg'],
    [{ format: 'png' }, 'png'],
    [{ format: 'webp' }, ''],
    [{}, ''],
  ]) {
    const dir = shotDir();
    const { capture } = fakeCapture({ ok: true, path: path.join(dir, 'x.png'), width: 1, height: 1, bytes: 1, ms: 1, ...input });
    const { ft, logs } = harness({ cfg: { screenshots: true }, capture, screenshotsDir: dir });
    await tickNoThrow(ft);
    const entry = logs.find((item) => item.message.includes('截屏'));
    assert.equal(entry.meta.format, expected, JSON.stringify(input));
  }
});

test('★ screenshots=false ⇒ 完全不截（不调 capture、不落盘）且只发文字', async () => {
  const dir = shotDir();
  const { capture, calls } = fakeCapture({ ok: true, path: 'should-not-be-used.png' });
  const { ft, gateway } = harness({
    cfg: { screenshots: false, screenshotsKeep: 2 },
    capture,
    screenshotsDir: dir,
  });

  const out = await tickNoThrow(ft);
  assert.equal(out.woke, true);
  assert.equal(calls.length, 0, '关掉截图后连 capture 都不该调');
  assert.deepEqual(gateway.delivered[0].viewImages, []);
  assert.deepEqual(fs.readdirSync(dir), [], '不该落任何文件');
});

test('★ 截屏失败 ⇒ 照常唤醒、只发文字（不许因此跳过这次唤醒）', async () => {
  const dir = shotDir();
  const { capture } = fakeCapture({ ok: false, error: '截图超时（>8000ms）', ms: 8001 });
  const { ft, gateway, logs } = harness({
    cfg: { screenshots: true, screenshotsKeep: 2 },
    capture,
    screenshotsDir: dir,
  });

  const out = await tickNoThrow(ft);
  assert.equal(out.woke, true, '截图失败不等于不唤醒');
  assert.equal(out.reason, 'sent');
  assert.equal(gateway.calls.deliver, 1);
  assert.deepEqual(gateway.delivered[0].viewImages, []);
  assert.equal(typeof gateway.delivered[0].text, 'string');

  const entry = logs.find((item) => item.message.includes('截屏'));
  assert.equal(entry.meta.ok, false);
  assert.equal(entry.meta.error, '截图超时（>8000ms）');
  assert.equal(entry.level, 'warn');
});

test('截屏实现自己抛错 ⇒ 仍唤醒，只发文字', async () => {
  const dir = shotDir();
  const capture = async () => { throw new Error('spawn 炸了'); };
  const { ft, gateway, logs } = harness({
    cfg: { screenshots: true, screenshotsKeep: 2 },
    capture,
    screenshotsDir: dir,
  });

  const out = await tickNoThrow(ft);
  assert.equal(out.woke, true);
  assert.equal(gateway.calls.deliver, 1);
  assert.deepEqual(gateway.delivered[0].viewImages, []);
  const entry = logs.find((item) => item.message.includes('截屏'));
  assert.equal(entry.meta.error, 'spawn 炸了');
});

test('screenshots 缺省（undefined）⇒ 视为开：截了屏再唤醒', async () => {
  const dir = shotDir();
  const { capture, calls } = fakeCapture({ ok: true, path: 'x.png', width: 1, height: 1, bytes: 1, ms: 1 });
  const { ft, gateway } = harness({ capture, screenshotsDir: dir }); // DEFAULT_CFG 里没有 screenshots
  await tickNoThrow(ft);
  assert.equal(calls.length, 1);
  assert.deepEqual(gateway.delivered[0].viewImages, ['x.png']);
});

test('没注入 capture（老调用方）⇒ 不截屏、不报错', async () => {
  const { ft, gateway } = harness({ cfg: { screenshots: true } });
  const out = await tickNoThrow(ft);
  assert.equal(out.woke, true);
  assert.deepEqual(gateway.delivered[0].viewImages, []);
});

test('★ 清理：只保留最近 screenshotsKeep 张，且只删自己写的 shot-*.png', async () => {
  const dir = shotDir();
  const older = [
    'shot-20260101-000001-000.png',
    'shot-20260101-000002-000.png',
    'shot-20260101-000003-000.png',
    'shot-20260101-000004-000.png',
  ];
  for (const name of older) fs.writeFileSync(path.join(dir, name), 'x');
  // 目录里还有别的东西 —— 一张都不许碰。
  fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'other.png'), 'x');

  const fresh = 'shot-20261021-030000-000.png';
  const { capture } = fakeCapture((input) => {
    fs.writeFileSync(path.join(input.outDir, fresh), 'x');
    return { ok: true, path: path.join(input.outDir, fresh), width: 7680, height: 2160, bytes: 1, ms: 2 };
  });
  const { ft } = harness({
    cfg: { screenshots: true, screenshotsKeep: 2 },
    capture,
    screenshotsDir: dir,
  });

  await tickNoThrow(ft);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    [fresh, older[3], 'keep-me.txt', 'other.png'].sort(),
    '只留最新两张 shot-*.png；别的文件原样',
  );
});

// ============================================================ 短追问（2026-10-23）
//
// 用户定稿的语义逐条钉住：
//   ① 「最后一条」= **用户自己发的入站消息**（不是她回的那句）；
//   ② 短钟在它之后 `followupMinutes` 计时；
//   ③ 一响就不再重置（这轮沉默只追问一次）；
//   ④ 用户再发消息 ⇒ 重新武装；
//   ⑤ 长钟锚点也改成它（用户说话 ⇒ 长钟顺延）；
//   ⑥ 短唤醒**不截图**。

const OWNER = '30000001';

/**
 * 一条"用户发来的"消息。
 *
 * ⚠️ 2026-10-26 起 `noteUserMessage` **按 `chatId` 判"能不能重新上膛"**
 * （只有 `private:<用户>` 才行；群消息只推进长唤醒锚点）。夹具必须带真实形状的
 * `chatId` —— 没带的调用会被 fail-closed（宁可少追一次，不要多打扰一次）。
 */
function userMessage(at, chatId = PRIVATE) {
  return { userId: OWNER, at, chatId };
}

/** 群里的用户发言（只该推进长唤醒锚点，**不该**给短追问上膛）。 */
function groupUserMessage(at) {
  return userMessage(at, 'group:200000001');
}

test('★ 验收时间线：10:00 长唤醒 → 10:30 用户说话 → 10:40 短追问 → 12:30 / 14:30 长唤醒', async () => {
  // 用户给的例子：长间隔 2 小时、短追问 10 分钟。
  const { ft, clock, gateway } = harness({ t0: localAt(10), cfg: { intervalHours: 2 } });

  assert.equal((await tickNoThrow(ft)).woke, true);
  assert.equal(ft.stats().lastWakeKind, 'long');
  assert.equal(gateway.calls.deliver, 1);
  assert.match(gateway.delivered[0].text, /【你自己的时间】/);

  // 10:30 用户说话 ⇒ 短钟 10:40、长钟锚点 10:30
  clock.set(localAt(10, 30));
  assert.equal(ft.noteUserMessage(userMessage(clock.now)), true);
  assert.equal(ft.stats().lastUserMessageAt, new Date(localAt(10, 30)).toISOString());
  assert.equal(ft.stats().nextFollowupAt, new Date(localAt(10, 40)).toISOString());

  // 10:40 短追问：确实是短唤醒、确实不带图
  clock.set(localAt(10, 40));
  assert.equal((await tickNoThrow(ft)).woke, true);
  assert.equal(ft.stats().lastWakeKind, 'short');
  assert.deepEqual(gateway.delivered.at(-1).viewImages, [], '短唤醒不截图');
  assert.match(gateway.delivered.at(-1).text, /【短追问】/);
  assert.equal(ft.stats().followupDone, true);

  // ③ 11:00 不会再问一遍
  clock.set(localAt(11));
  assert.equal((await tickNoThrow(ft)).reason, 'short-done');
  assert.equal(gateway.calls.deliver, 2, '沉默只追问一次');

  // ⑤ 长钟锚点 = 10:30 ⇒ 12:30
  clock.set(localAt(12, 30));
  assert.equal((await tickNoThrow(ft)).woke, true);
  assert.equal(ft.stats().lastWakeKind, 'long');
  assert.match(gateway.delivered.at(-1).text, /【你自己的时间】/);

  // 14:30（12:30 + 2h）
  clock.set(localAt(14, 30));
  assert.equal((await tickNoThrow(ft)).woke, true);
  assert.equal(ft.stats().lastWakeKind, 'long');

  assert.deepEqual(ft.stats().wakes, { long: 3, short: 1 });
});

test('④ 用户再发消息 ⇒ 短钟重新武装（新一轮沉默重新计）', async () => {
  const { ft, clock, gateway } = harness({ t0: localAt(10), cfg: { intervalHours: 2 } });
  await tickNoThrow(ft); // 10:00

  clock.set(localAt(10, 30));
  ft.noteUserMessage(userMessage(clock.now));
  clock.set(localAt(10, 40));
  assert.equal((await tickNoThrow(ft)).woke, true); // 第一次追问
  assert.equal(gateway.calls.deliver, 2);

  // 用户又说话了（10:50）⇒ 重新武装：12:00 才该问下一轮
  clock.set(localAt(10, 50));
  ft.noteUserMessage(userMessage(clock.now));
  assert.equal(ft.stats().followupDone, false);
  assert.equal(ft.stats().nextFollowupAt, new Date(localAt(11, 0)).toISOString());

  clock.set(localAt(10, 55));
  assert.equal((await tickNoThrow(ft)).reason, 'short-too-soon');
  clock.set(localAt(11, 0));
  assert.equal((await tickNoThrow(ft)).woke, true);
  assert.equal(ft.stats().lastWakeKind, 'short');
  assert.equal(gateway.calls.deliver, 3);
});

test('① 只认用户 QQ 发的那条：群友说话不重置短钟、也不顺延长钟', async () => {
  const { ft, clock } = harness({ t0: localAt(10), cfg: { intervalHours: 2 } });
  await tickNoThrow(ft); // 10:00 长唤醒

  clock.set(localAt(11));
  assert.equal(ft.noteUserMessage({ userId: '30000002', at: clock.now }), false, '群友不算');
  assert.equal(ft.noteUserMessage({ userId: '', at: clock.now }), false, '认不出人也不算');
  assert.equal(ft.stats().lastUserMessageAt, null);
  assert.equal(ft.stats().userMessages, 0);

  // 长钟仍按 10:00 算 ⇒ 11:00 还是 too-soon
  assert.equal((await tickNoThrow(ft)).reason, 'too-soon');
});

test('乱序/补发的时间戳更早 ⇒ 忽略，不把锚点往回拨', async () => {
  const { ft } = harness({ t0: localAt(10, 40) });
  assert.equal(ft.noteUserMessage(userMessage(localAt(10, 30))), true);
  assert.equal(ft.noteUserMessage(userMessage(localAt(10, 10))), false);
  assert.equal(ft.stats().lastUserMessageAt, new Date(localAt(10, 30)).toISOString());
  assert.equal(ft.stats().userMessages, 1);
});

test('短追问不查 busy：她真在忙着回话，那就不叫"沉默"', async () => {
  // 这是**刻意**的（用户："短唤醒只过前三道"）：busy 只挡长唤醒。
  const { ft, clock } = harness({ t0: localAt(10), binder: makeBinder([SESSION]), cfg: { intervalHours: 2 } });
  // 长唤起先被 busy 挡住（顺带证明第四道闸还在）
  assert.equal((await tickNoThrow(ft)).reason, 'busy');

  clock.set(localAt(10, 30));
  ft.noteUserMessage(userMessage(clock.now));
  clock.set(localAt(10, 40));
  assert.equal((await tickNoThrow(ft)).woke, true);
  assert.equal(ft.stats().lastWakeKind, 'short');
});

test('短追问失败也算"响过了"：不会每分钟重试', async () => {
  const gateway = makeGateway({ onDeliver: () => { throw new Error('炸'); } });
  const { ft, clock } = harness({ t0: localAt(10), gateway, cfg: { intervalHours: 2 } });
  await tickNoThrow(ft); // 10:00 长唤醒（也炸，但长的那条会自己安排 5 分钟重试）

  clock.set(localAt(10, 30));
  ft.noteUserMessage(userMessage(clock.now));
  clock.set(localAt(10, 40));
  const out = await tickNoThrow(ft);
  assert.equal(out.reason, 'followup-error');
  assert.equal(ft.stats().followupDone, true, '失败也算响过 ⇒ 锁住');
  clock.set(localAt(10, 41));
  assert.equal((await tickNoThrow(ft)).reason, 'short-done');
});

test('★ 长唤醒成功后清掉待追问的短钟（刚被叫醒过，别再补一句追问）', async () => {
  const { ft, clock } = harness({ t0: localAt(10), cfg: { intervalHours: 2 } });
  await tickNoThrow(ft); // 10:00
  clock.set(localAt(10, 30));
  ft.noteUserMessage(userMessage(clock.now));
  assert.equal(ft.stats().followupDone, false);

  // 中间一直没 tick（比如宿主离线），12:30 长钟直接到点
  clock.set(localAt(12, 30));
  assert.equal((await tickNoThrow(ft)).woke, true);
  assert.equal(ft.stats().lastWakeKind, 'long');
  assert.equal(ft.stats().followupDone, true, '长唤醒把待追问撤掉');

  clock.set(localAt(12, 40));
  assert.equal((await tickNoThrow(ft)).reason, 'short-done');
});

test('★ 短追问的提示词：说清是短追问、别重复问、带上 followupMinutes', async () => {
  const { ft, clock, gateway } = harness({ t0: localAt(10), cfg: { followupMinutes: 7 } });
  await tickNoThrow(ft);
  clock.set(localAt(10, 30));
  ft.noteUserMessage(userMessage(clock.now));
  clock.set(localAt(10, 37));
  await tickNoThrow(ft);

  const text = gateway.delivered.at(-1).text;
  assert.match(text, /【短追问】/);
  assert.match(text, /别重复/);
  assert.match(text, /7 分钟/);
  assert.match(text, /\[不说话\]/);
  assert.doesNotMatch(text, /【你自己的时间】/, '不能拿长唤醒的提示词糊弄');
});

test('★ skipReasons 分得开长短：短追问的跳过原因都以 short- 开头', async () => {
  const { ft, clock } = harness({ t0: localAt(10), cfg: { intervalHours: 2 } });
  await tickNoThrow(ft); // 10:00 长唤醒
  clock.set(localAt(10, 5));
  await tickNoThrow(ft); // 长：too-soon
  clock.set(localAt(10, 30));
  ft.noteUserMessage(userMessage(clock.now));
  clock.set(localAt(10, 31));
  await tickNoThrow(ft); // 短：short-too-soon
  clock.set(localAt(10, 40));
  await tickNoThrow(ft); // 短：响过
  clock.set(localAt(10, 41));
  await tickNoThrow(ft); // 短：short-done

  const reasons = ft.stats().skipReasons;
  assert.equal(reasons['too-soon'], 1, '10:05 是长唤醒的 too-soon');
  assert.equal(reasons['short-too-soon'], 1, '10:31 是短追问的 too-soon（名字不同）');
  assert.equal(reasons['short-done'], 1);
});

test('★ 跨重启持久化：lastUserMessageAt / followupDone 落在 statePath，新实例读得回来', async () => {
  const dir = shotDir();
  const statePath = path.join(dir, 'free-time-state.json');
  const saidAt = localAt(10, 30);

  // 第一代：跑一轮长唤醒 + 用户说一句话
  const one = harness({ t0: localAt(10), statePath, cfg: { intervalHours: 2 } });
  await tickNoThrow(one.ft);
  assert.equal(one.ft.noteUserMessage(userMessage(saidAt)), true);

  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(saved.lastUserMessageAt, new Date(saidAt).toISOString());
  assert.equal(saved.followupDone, false);

  // 第二代（≈ 热重载 / 重启）：锚点读回来，10:40 照样是短追问
  const two = harness({ t0: localAt(10, 40), statePath, cfg: { intervalHours: 2 } });
  assert.equal(two.ft.stats().lastUserMessageAt, new Date(saidAt).toISOString());
  assert.equal(two.ft.stats().followupDone, false);
  assert.equal(two.ft.stats().nextFollowupAt, new Date(localAt(10, 40)).toISOString());
  assert.equal((await tickNoThrow(two.ft)).woke, true);
  assert.equal(two.ft.stats().lastWakeKind, 'short');
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).followupDone, true);

  // 第三代：追问过这件事也读得回来 ⇒ 不会重启一次就再问一遍
  const three = harness({ t0: localAt(10, 45), statePath, cfg: { intervalHours: 2 } });
  assert.equal(three.ft.stats().followupDone, true);
  assert.equal((await tickNoThrow(three.ft)).reason, 'short-done');
});

test('状态文件坏了 / 不存在 ⇒ 当成全新开始，不抛', async () => {
  const dir = shotDir();
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ 不是 json', 'utf8');
  const { ft } = harness({ statePath: broken });
  assert.equal(ft.stats().lastUserMessageAt, null);
  assert.equal(ft.stats().followupDone, true);

  const missing = path.join(dir, 'nope.json');
  const other = harness({ statePath: missing });
  assert.equal(other.ft.stats().lastUserMessageAt, null);
  // 记一条会顺手把文件建出来
  assert.equal(other.ft.noteUserMessage(userMessage(localAt(10, 30))), true);
  assert.ok(fs.existsSync(missing));
});

test('statePath 为空（测试/老调用方）⇒ 一个字节都不写', async () => {
  const { ft } = harness();
  assert.equal(ft.noteUserMessage(userMessage(localAt(10, 30))), true);
  assert.equal(ft.stats().followupDone, false);
});



// ============================================================ 2026-10-26：只认私聊上膛

test('★ 验收：**群里说话不给短追问上膛** —— 11 分钟后私聊不会追', async () => {
  const { ft, clock, gateway } = harness({ t0: localAt(10), cfg: { intervalHours: 2 } });
  await tickNoThrow(ft); // 10:00 长唤醒（这轮沉默已处理，短钟锁着）

  // 10:30 用户在**群里**说话：锚点推进，但短追问**不上膛**
  clock.set(localAt(10, 30));
  assert.equal(ft.noteUserMessage(groupUserMessage(clock.now)), true, '记下来（锚点要动）');
  const s = ft.stats();
  assert.equal(s.lastUserMessageChat, 'group:200000001');
  assert.equal(s.followupDone, true, '群消息不重新上膛');
  assert.equal(s.rearmSkipped, 1);
  assert.equal(s.rearms, 0);
  assert.equal(s.nextFollowupAt, null, '没有待追问的沉默');

  // 10:40（本来私聊说话就该追了）⇒ 这里是 short-done，一条都不发
  clock.set(localAt(10, 40));
  assert.equal((await tickNoThrow(ft)).reason, 'short-done');
  clock.set(localAt(10, 55));
  assert.equal((await tickNoThrow(ft)).reason, 'short-done');
  assert.equal(gateway.calls.deliver, 1, '只有 10:00 那次长唤醒，没有追问');
});

test('★ 对照：**私聊**说话才上膛（同一时间线，只把会话换成私聊）', async () => {
  const { ft, clock, gateway } = harness({ t0: localAt(10), cfg: { intervalHours: 2 } });
  await tickNoThrow(ft); // 10:00

  clock.set(localAt(10, 30));
  assert.equal(ft.noteUserMessage(userMessage(clock.now)), true);
  const s = ft.stats();
  assert.equal(s.lastUserMessageChat, PRIVATE);
  assert.equal(s.followupDone, false, '私聊要重新上膛');
  assert.equal(s.rearms, 1);
  assert.equal(s.rearmSkipped, 0);
  assert.equal(s.nextFollowupAt, new Date(localAt(10, 40)).toISOString());

  clock.set(localAt(10, 40));
  assert.equal((await tickNoThrow(ft)).woke, true);
  assert.equal(ft.stats().lastWakeKind, 'short');
  assert.equal(gateway.calls.deliver, 2);
});

test('★ 群消息仍然推进**长唤醒**锚点（那条语义是"人还在"）', async () => {
  const { ft, clock } = harness({ t0: localAt(10), cfg: { intervalHours: 2 } });
  await tickNoThrow(ft); // 10:00 长唤醒

  clock.set(localAt(10, 30));
  ft.noteUserMessage(groupUserMessage(clock.now));
  // 长钟锚点 = max(10:00, 10:30) ⇒ 12:30 才到点
  clock.set(localAt(12, 0));
  assert.equal((await tickNoThrow(ft)).reason, 'short-done', '11:30 之前长钟没到点');
  clock.set(localAt(12, 30));
  assert.equal((await tickNoThrow(ft)).woke, true);
  assert.equal(ft.stats().lastWakeKind, 'long');
});

test('★ 没有 `chatId` 的调用 fail-closed：记锚点但**不上膛**（宁可少追一次）', async () => {
  const { ft, clock } = harness({ t0: localAt(10), cfg: { intervalHours: 2 } });
  await tickNoThrow(ft); // 10:00

  clock.set(localAt(10, 30));
  assert.equal(ft.noteUserMessage({ userId: OWNER, at: clock.now }), true);
  const s = ft.stats();
  assert.equal(s.followupDone, true);
  assert.equal(s.rearms, 0);
  assert.equal(s.rearmSkipped, 1);
  clock.set(localAt(10, 40));
  assert.equal((await tickNoThrow(ft)).reason, 'short-done');
});

test('★ 落盘失败 ⇒ 进 `lastError` + 计数（内存 true / 磁盘 false 是"重载丢锁"的源头）', async () => {
  const dir = fs.mkdtempSync(path.join(HERE, SHOT_TMP_PREFIX));
  // 拿一个**普通文件**当"目录" ⇒ `mkdirSync(dirname)` 必失败 ⇒ persist() 走 catch。
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');
  const statePath = path.join(blocker, 'state.json');

  const { ft, clock } = harness({ t0: localAt(10), statePath, cfg: { intervalHours: 2 } });
  clock.set(localAt(10, 1));
  ft.noteUserMessage(userMessage(clock.now));

  const s = ft.stats();
  assert.ok(s.persistFailures >= 1, '失败要计数');
  assert.match(String(s.lastError), /没存上/);
  assert.match(String(s.lastError), /丢锁/, '错误文案要说清后果');
});
