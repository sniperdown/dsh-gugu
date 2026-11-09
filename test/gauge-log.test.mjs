/**
 * 判官/启发式决策日志（2026-11-06，`src/dsh/gauge-log.mjs`）的离线测试。
 *
 * 四件必须钉住的事（需求里点名的四条）：
 *   1. 写日志成功一条（字段齐、`detail` 是**整个**分项对象、判官原文**不**被截到 40 字）；
 *   2. 写盘失败**绝不抛**（消息热路径上抛出去 = 宿主退出）；
 *   3. 超过上限**轮转**成 `.1`，且只留一个旧文件；
 *   4. 开关关闭时**一个字节都不写**（连目录都不建）。
 *
 * 另外两条是"接线到底通没通"的证据（网关那一层）：
 *   · 判官判「不该」⇒ 落一条 `verdict:'decline'`，且**不**补 `out` 行；
 *   · 真的说出去 ⇒ 补一条 `kind:'out'`，与 `gauge` 那行**同一个 `turnId`**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GAUGE_LOG_FILE,
  KIND_GAUGE,
  KIND_OUT,
  createGaugeLog,
  defaultGaugeLogPath,
  judgeVerdictOf,
  normalizeGaugeLog,
  sanitizeJsonValue,
} from '../src/dsh/gauge-log.mjs';
import { Gateway, OUTCOME } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';
import { createOutboundAllow } from '../src/dsh/outbound-allow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(HERE, '.tmp-gauge-log-'));
  return { dir, file: path.join(dir, 'qq-gauge.jsonl') };
}

/** 读一份 JSONL（坏行直接跳过 —— 测试自己也要能容忍半行）。 */
function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** 一次判定的最小入参。 */
function gaugeInput(overrides = {}) {
  return {
    chatId: 'group:100',
    chatKind: 'group',
    userId: '2001',
    messageText: '这个接口一直报错',
    messageAt: T0,
    context: '[20:00] 阿猫(2001): 这个接口一直报错',
    score: 38.5,
    threshold: 5,
    detail: { strong: 0, content: 24, pressure: 12.5, penalty: 0, multiplier: 1, repetition: 0 },
    judge: {
      verdict: 'decline',
      source: 'decline',
      raw: '不该',
      ms: 312,
      model: 'deepseek-flash',
      provider: 'deepseek-official',
      promptChars: 1234,
    },
    pmode: 'precheck',
    reason: 'scored',
    focus: 0,
    addressed: false,
    ...overrides,
  };
}

// ------------------------------------------------------------------ 模块层

test('路径：默认落在 <DSH_HOME>/media/qq-gauge.jsonl，环境变量可覆盖', () => {
  assert.match(defaultGaugeLogPath({ DSH_HOME: path.join('H:', 'dsh-home') }), /qq-gauge\.jsonl$/);
  assert.equal(
    defaultGaugeLogPath({ DSH_HOME: path.join('H:', 'dsh-home') }),
    path.join('H:', 'dsh-home', 'media', GAUGE_LOG_FILE),
  );
  // 覆盖优先（排障时用户指定临时文件）。
  assert.equal(
    defaultGaugeLogPath({ DSH_HOME: '<DSH_HOME>', QQ_GAUGE_LOG_PATH: 'D:\\tmp\\g.jsonl' }),
    'D:\\tmp\\g.jsonl',
  );
});

test('配置归一化：默认关闭、空路径=关掉、缺路径=默认路径、上限夹边界', () => {
  // **默认关闭**（需求第 4 条）。缺 `file` ⇒ 走默认路径（不是空串！）。
  const dft = normalizeGaugeLog();
  assert.equal(dft.enabled, false);
  assert.notEqual(dft.file, '');
  assert.equal(dft.maxBytes, 50 * 1024 * 1024);
  // 显式空串 = 明确关掉（同 `outbound-ledger.mjs` 的口径）。
  assert.equal(normalizeGaugeLog({ enabled: true, file: '' }).enabled, false);
  // 开着 + 有路径 = 真的开。
  assert.equal(normalizeGaugeLog({ enabled: true, file: 'X:\\a.jsonl' }).enabled, true);
  // 上限：非正数 = 不轮转；坏值 = 默认。
  assert.equal(normalizeGaugeLog({ maxBytes: 0 }).maxBytes, 0);
  assert.equal(normalizeGaugeLog({ maxBytes: 'nope' }).maxBytes, 50 * 1024 * 1024);
});

test('judgeVerdictOf：降级的那几种提到 verdict 上（timeout/error/unparsed/no-model/busy）', () => {
  assert.equal(judgeVerdictOf({ verdict: 'decline', source: 'decline' }), 'decline');
  assert.equal(judgeVerdictOf({ verdict: 'wait', source: 'wait' }), 'wait');
  // ⚠️ 这五种在 judge-mode 里 `speak` 都是 true（降级放行），但记录上必须能看出
  //    "它其实没给结论" —— 否则研究时会把降级当成真的判过。
  for (const source of ['timeout', 'error', 'unparsed', 'no-model', 'busy']) {
    assert.equal(judgeVerdictOf({ verdict: 'speak', source }), source);
  }
  // 没有判官 ⇒ 启发式自己的结论。
  assert.equal(judgeVerdictOf({ verdict: 'speak', source: 'heuristic' }), 'speak');
  assert.equal(judgeVerdictOf({}), 'speak');
});

test('sanitizeJsonValue：坏值（NaN / BigInt / 环 / 函数）都收成可序列化的东西', () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  const out = sanitizeJsonValue({
    nan: Number.NaN, big: 10n, fn: () => 1, ok: 2, nested: { x: [1, Number.POSITIVE_INFINITY] }, cyclic,
  });
  assert.equal(out.nan, null);
  assert.equal(out.big, '10');
  assert.equal(out.fn, null);
  assert.equal(out.ok, 2);
  assert.deepEqual(out.nested, { x: [1, null] });
  // 环不会抛，也不会无限展开（深度上限 3）。
  assert.equal(typeof out.cyclic, 'object');
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('★ 写日志成功一条：字段齐、detail 是整份、judgeRaw 不被截到 40 字', () => {
  const { dir, file } = tmpFile();
  try {
    const log = createGaugeLog({ config: { enabled: true, file }, now: () => T0 + 5 });
    const handle = log.open(gaugeInput({
      // 60 个汉字（远超旧实现那个 40 字截断），验证"全文留档"。
      judge: { ...gaugeInput().judge, raw: '不'.repeat(60) },
    }));
    assert.notEqual(handle, null);
    const lines = readLines(file);
    assert.equal(lines.length, 1, '一次判定只写一行');
    const rec = lines[0];
    assert.equal(rec.kind, KIND_GAUGE);
    // `kind` 是**记录类型**，会话类型单独一格（见模块文件头那段说明）。
    assert.equal(rec.chatKind, 'group');
    assert.equal(rec.chatId, 'group:100');
    assert.equal(rec.userId, '2001');
    assert.equal(rec.messageText, '这个接口一直报错');
    assert.match(rec.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(rec.messageAt, /^\d{4}-\d{2}-\d{2}T/);
    // 启发式：**整份 detail**（不摊平、不挑项）。
    assert.equal(rec.score, 38.5);
    assert.equal(rec.threshold, 5);
    assert.deepEqual(rec.detail, gaugeInput().detail);
    // 判官：结论 / 来源 / 原文 / 耗时 / 模型。
    assert.equal(rec.verdict, 'decline');
    assert.equal(rec.judgeSource, 'decline');
    assert.equal(rec.judgeRaw.length, 60, '判官原文必须是全文（不能再被截成 40 字）');
    assert.equal(rec.judgeMs, 312);
    assert.equal(rec.judgeModel, 'deepseek-flash');
    assert.equal(rec.judgeProvider, 'deepseek-official');
    assert.equal(rec.judgePromptChars, 1234);
    assert.equal(rec.pmode, 'precheck');
    assert.equal(rec.reason, 'scored');
    assert.equal(rec.turnId, handle.turnId);
    // 上下文**不进** gauge 行（只在真的说话时写进 out 行）。
    assert.equal(rec.context, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 写盘失败绝不抛：只吞成一条 debug 日志', () => {
  const logs = [];
  const boom = () => { throw new Error('disk full'); };
  const fsImpl = {
    mkdirSync: boom,
    statSync: boom,
    appendFileSync: boom,
    rmSync: boom,
    renameSync: boom,
  };
  const log = createGaugeLog({
    config: { enabled: true, file: path.join('X:', 'nope', 'qq-gauge.jsonl') },
    fsImpl,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => T0,
  });
  // 整个调用链（含 mkdir / stat / append / 轮转）全部炸 ⇒ 也只能返回 null。
  let handle;
  assert.doesNotThrow(() => { handle = log.open(gaugeInput()); });
  assert.equal(handle, null);
  assert.ok(logs.length >= 1, '失败必须留一条日志（否则"没记"和"记不进去"分不开）');
  assert.equal(logs[0].level, 'debug', '热路径上的失败只能是 debug');
  assert.equal(log.stats().failures, 1);
  assert.match(log.stats().lastError, /disk full/);
  // `complete` 拿到 null 句柄 / 空正文 ⇒ 直接跳过，绝不抛。
  assert.equal(log.complete(null, { output: 'x' }), false);
  assert.equal(log.complete({ turnId: 't', chatId: 'group:1', context: '' }, { output: '  ' }), false);
  assert.equal(log.stats().failures, 1, '这两种"跳过"不算写盘失败');
});

test('★ 轮转：超过上限就改成 .1，只留一个旧文件', () => {
  const { dir, file } = tmpFile();
  try {
    // 一行约 300+ 字节 ⇒ 上限给 800，写十几条必然轮转好几次。
    const log = createGaugeLog({ config: { enabled: true, file, maxBytes: 800 } });
    for (let i = 0; i < 12; i += 1) {
      log.open(gaugeInput({ messageAt: T0 + i * 1000, messageText: `第${i}条消息` }));
    }
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(`${file}.1`), true, '必须轮转出 .1');
    assert.equal(fs.existsSync(`${file}.2`), false, '只留一个旧文件（不许堆 .2/.3）');
    // 当前文件不超上限；旧文件里也有内容（说明是"真的挪走"了）。
    assert.ok(fs.statSync(file).size <= 800, `当前文件不该超上限，实际 ${fs.statSync(file).size}`);
    assert.ok(fs.statSync(`${file}.1`).size > 0);
    // 两边的行都还是合法 JSON（轮转不能切坏行）。
    assert.ok(readLines(file).length >= 1);
    assert.ok(readLines(`${file}.1`).length >= 1);
    assert.ok(log.stats().rotations >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 开关关闭时一个字节都不写（连目录都不建）', () => {
  const { dir, file } = tmpFile();
  try {
    const nested = path.join(dir, 'never-created', 'qq-gauge.jsonl');
    const log = createGaugeLog({ config: { enabled: false, file: nested } });
    assert.equal(log.enabled(), false);
    assert.equal(log.open(gaugeInput()), null);
    assert.equal(log.complete({ turnId: 't', chatId: 'group:1', context: '' }, { output: '说了' }), false);
    assert.equal(fs.existsSync(nested), false, '关着时不许创建文件');
    assert.equal(fs.existsSync(path.dirname(nested)), false, '关着时连目录都不许创建');
    assert.equal(log.stats().writes, 0);
    // 默认配置（不传任何参数）也是关的。
    const byDefault = createGaugeLog({});
    assert.equal(byDefault.enabled(), false);
    assert.equal(byDefault.open(gaugeInput()), null);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('judgeRaw 取判官答的**全文**：优先 `answer`（2026-11-06 加的全文字段），退回 `raw`', () => {
  const { dir, file } = tmpFile();
  try {
    const log = createGaugeLog({ config: { enabled: true, file } });
    // 真 `judge-mode.mjs` 的 outcome：`raw` 只留 40 字（老口径），`answer` 是全文。
    log.open(gaugeInput({
      judge: {
        ...gaugeInput().judge,
        raw: '不'.repeat(40),
        answer: '不该，因为他们在互相接话，跟你没关系，别插嘴',
      },
    }));
    // 桩 / 老调用方只有 `raw` ⇒ 退回它（不许变成空串）。
    log.open(gaugeInput({
      messageAt: T0 + 1000,
      judge: { verdict: 'decline', source: 'decline', raw: '不该', ms: 1 },
    }));
    const lines = readLines(file);
    assert.equal(lines[0].judgeRaw, '不该，因为他们在互相接话，跟你没关系，别插嘴');
    assert.notEqual(lines[0].judgeRaw.length, 40, '不许再被切回 40 字');
    assert.equal(lines[1].judgeRaw, '不该');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('out 行：与 gauge 行同一个 turnId，正文分段按 \\n 拼、上下文也在', () => {
  const { dir, file } = tmpFile();
  try {
    const log = createGaugeLog({ config: { enabled: true, file } });
    const handle = log.open(gaugeInput());
    assert.equal(log.complete(handle, { output: '第一段\n第二段' }), true);
    const lines = readLines(file);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].kind, KIND_GAUGE);
    assert.equal(lines[1].kind, KIND_OUT);
    assert.equal(lines[1].turnId, lines[0].turnId, '两行必须能按 turnId 配对');
    assert.equal(lines[1].output, '第一段\n第二段');
    assert.equal(lines[1].context, gaugeInput().context);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('turnId：同一会话同一毫秒判两次也不会撞（重复投递 / 重试）', () => {
  const { dir, file } = tmpFile();
  try {
    const log = createGaugeLog({ config: { enabled: true, file } });
    const a = log.open(gaugeInput());
    const b = log.open(gaugeInput());
    assert.notEqual(a.turnId, b.turnId);
    assert.match(a.turnId, /^group:100@\d+$/);
    assert.match(b.turnId, /^group:100@\d+#2$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 网关接线

/** 一套最小网关：真 router/engine，假 transport/responder（同 `gateway.test.mjs`）。 */
function harness({ gaugeLog = null, judgeMode = 'heuristic', precheck = null, gauge } = {}) {
  const emitter = new EventEmitter();
  const sent = [];
  const logs = [];
  const transport = {
    selfId: '999',
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async sendToChat(chatId, message) {
      sent.push({ chatId, message });
      return sent.length;
    },
  };
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.OPEN,
    requireMention: true,
    adminUsers: ['9001'],
  });
  const engine = new ProactiveEngine({
    config: {
      enabled: true,
      minIntervalMs: 0,
      maxPerHour: 10,
      cooldownAfterBotMs: 0,
      afterUserMsgCount: 1,
    },
    gauge: gauge ?? (async () => ({
      speak: true,
      score: 60,
      threshold: 5,
      detail: { content: 18, pressure: 5 },
    })),
    speak: async () => true,
    log,
    now: () => T0,
  });
  function log(level, message, meta) {
    logs.push({ level, message, meta });
  }
  const gateway = new Gateway({
    transport,
    router,
    engine,
    outboundAllow: createOutboundAllow({ allowFrom: ['10000001'], groupAllowFrom: ['200000001'] }),
    responder: async () => '回复1',
    log,
    maxReplyChars: 2000,
    judgeMode,
    precheck,
    gaugeLog,
  });
  gateway.attach();
  return { gateway, sent, logs, engine };
}

/** 一条普通群消息（没 @ 小鲸鱼 ⇒ 走"主动接话"的判定）。 */
function groupEvent(overrides = {}) {
  return {
    time: Math.floor(T0 / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 1,
    group_id: 100,
    user_id: 2001,
    message: [{ type: 'text', text: '这个接口一直报错' }],
    raw_message: '这个接口一直报错',
    sender: { nickname: '阿猫', card: '群名片猫' },
    ...overrides,
  };
}

test('网关：关着时整条链路不产生任何文件（一个字节都不写）', async () => {
  const { dir, file } = tmpFile();
  try {
    const gaugeLog = createGaugeLog({ config: { enabled: false, file } });
    const h = harness({ gaugeLog });
    const result = await h.gateway.handleEvent(groupEvent());
    assert.equal(result.outcome, OUTCOME.DISPATCHED);
    assert.equal(h.sent.length, 1);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('网关：判官说「不该」⇒ 落一条 verdict=decline 的 gauge 行，且**不**补 out 行', async () => {
  const { dir, file } = tmpFile();
  try {
    const gaugeLog = createGaugeLog({ config: { enabled: true, file }, now: () => T0 });
    const precheck = {
      enabled: true,
      describe: () => ({ model: 'deepseek-flash' }),
      check: async () => ({
        speak: false,
        verdict: 'decline',
        source: 'decline',
        raw: '不该',
        ms: 88,
        chars: 2,
        promptChars: 999,
        provider: 'deepseek-official',
        model: 'deepseek-flash',
      }),
    };
    const h = harness({ gaugeLog, judgeMode: 'precheck', precheck });
    const result = await h.gateway.handleEvent(groupEvent());
    assert.equal(result.reason, 'precheck-declined');
    assert.equal(h.sent.length, 0, '判官拦下就不该发 QQ');
    const lines = readLines(file);
    assert.equal(lines.length, 1);
    const rec = lines[0];
    assert.equal(rec.kind, KIND_GAUGE);
    assert.equal(rec.verdict, 'decline');
    assert.equal(rec.judgeRaw, '不该');
    assert.equal(rec.judgeMs, 88);
    assert.equal(rec.judgeModel, 'deepseek-flash');
    assert.equal(rec.pmode, 'precheck');
    assert.equal(rec.score, 60);
    assert.equal(rec.threshold, 5);
    assert.deepEqual(rec.detail, { content: 18, pressure: 5 });
    assert.equal(rec.messageText, '这个接口一直报错');
    assert.equal(rec.addressed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('网关：判官放行且真的发出去了 ⇒ gauge + out 两行，同一 turnId，out 带正文与上下文', async () => {
  const { dir, file } = tmpFile();
  try {
    const gaugeLog = createGaugeLog({ config: { enabled: true, file }, now: () => T0 });
    const precheck = {
      enabled: true,
      describe: () => ({ model: 'deepseek-flash' }),
      check: async () => ({
        speak: true, verdict: 'speak', source: 'reply', raw: '该', ms: 55, chars: 1,
        promptChars: 800, provider: 'deepseek-official', model: 'deepseek-flash',
      }),
    };
    const h = harness({ gaugeLog, judgeMode: 'precheck', precheck });
    const result = await h.gateway.handleEvent(groupEvent());
    assert.equal(result.outcome, OUTCOME.DISPATCHED);
    assert.equal(h.sent.length, 1);
    const lines = readLines(file);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].kind, KIND_GAUGE);
    assert.equal(lines[0].verdict, 'speak');
    assert.equal(lines[1].kind, KIND_OUT);
    assert.equal(lines[1].turnId, lines[0].turnId);
    assert.equal(lines[1].output, '回复1');
    // 上下文用的是引擎的转录渲染（含触发那条消息本身）。
    assert.match(lines[1].context, /这个接口一直报错/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('网关：启发式模式（没有判官）也记一条，verdict=speak / source=heuristic', async () => {
  const { dir, file } = tmpFile();
  try {
    const gaugeLog = createGaugeLog({ config: { enabled: true, file }, now: () => T0 });
    const h = harness({ gaugeLog, judgeMode: 'heuristic' });
    await h.gateway.handleEvent(groupEvent());
    const lines = readLines(file);
    assert.equal(lines.length, 2, '一条 gauge + 一条 out');
    assert.equal(lines[0].verdict, 'speak');
    assert.equal(lines[0].judgeSource, 'heuristic');
    assert.equal(lines[0].judgeRaw, '');
    assert.equal(lines[0].pmode, 'heuristic');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('网关：被点名的（@）不记 —— 那是明确请求，不是"要不要插一句"的判定', async () => {
  const { dir, file } = tmpFile();
  try {
    const gaugeLog = createGaugeLog({ config: { enabled: true, file }, now: () => T0 });
    const h = harness({ gaugeLog });
    await h.gateway.handleEvent(groupEvent({
      message: [{ type: 'at', qq: '999' }, { type: 'text', text: ' 在吗' }],
      raw_message: '[CQ:at,qq=999] 在吗',
    }));
    assert.equal(h.sent.length, 1, '被点名的照常回');
    assert.equal(fs.existsSync(file), false, '但不进判定日志');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('网关：日志写盘炸了也不影响发送（观测设施绝不能弄坏被观测的事）', async () => {
  const logs = [];
  const boom = () => { throw new Error('disk full'); };
  const gaugeLog = createGaugeLog({
    config: { enabled: true, file: path.join('X:', 'nope', 'qq-gauge.jsonl') },
    fsImpl: { mkdirSync: boom, statSync: boom, appendFileSync: boom, rmSync: boom, renameSync: boom },
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });
  const h = harness({ gaugeLog });
  const result = await h.gateway.handleEvent(groupEvent());
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.sent.length, 1, '日志炸了照样得把话发出去');
  assert.ok(logs.some((item) => item.level === 'debug'));
});
