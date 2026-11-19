/**
 * 出站文本判据（2026-11-18）—— 单元 + 集成测试。
 *
 * 分四组：
 *   A. 纯函数（`textHead` / `normalizeSuspects`）
 *   B. 客户端（`createTextLinter`，注入 fetch 造出 ok/超时/服务没起/500）
 *   C. 台账字段（`text` 前 200 字 + `lint`，且**老调用点形状一个字节都没变**）
 *   D. 网关接线 + ⭐ **静默失败**（判据挂了，发送照常、台账照写、不抛）
 *
 * D 组是本文件的重点：用户的要求原话是「服务没起、超时、报错，一律静默跳过
 * **发送照常**」「这个判据绝不能成为发送链路的单点故障」。
 * 那三条不是靠"看代码觉得没问题"能保证的，只能靠断言钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { Gateway, OUTCOME } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { createOutboundAllow } from '../src/dsh/outbound-allow.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';
import {
  createOutboundLedger,
  LEDGER_TEXT_HEAD_MAX,
  LEDGER_LINT_SAMPLES_MAX,
  ledgerHash,
} from '../src/dsh/outbound-ledger.mjs';
import {
  createTextLinter,
  textHead,
  normalizeSuspects,
  LAYER_TEXT_LINT,
} from '../src/dsh/text-lint.mjs';

const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);

const RELAY_ALLOW = createOutboundAllow({ allowFrom: ['10000001'], groupAllowFrom: [] });

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-text-lint-'));
}

/** 等一个条件成立（fire-and-forget 的东西只能这样等）。 */
async function waitFor(fn, { ms = 2000, step = 15 } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

// ───────────────────────────── A. 纯函数 ─────────────────────────────

test('textHead：短文本原样、长文本截到 200 个码点、空串是空串', () => {
  assert.equal(textHead('短文本'), '短文本');
  assert.equal(textHead(''), '');
  assert.equal(textHead(null), '');
  const long = '字'.repeat(500);
  assert.equal(Array.from(textHead(long)).length, LEDGER_TEXT_HEAD_MAX);
  assert.equal(textHead(long), '字'.repeat(200));
  // ⚠️ 按**码点**切，不能把 emoji 切成半个代理对
  const emoji = '😀'.repeat(300);
  const head = textHead(emoji);
  assert.equal(Array.from(head).length, 200);
  // 拼回去等于原串的前 200 个码点（不是前 200 个 UTF-16 单元）
  assert.equal(head, Array.from(emoji).slice(0, 200).join(''));
});

test('normalizeSuspects：最多 5 条、丢了空文本、越界收敛', () => {
  assert.deepEqual(normalizeSuspects(null), []);
  assert.deepEqual(normalizeSuspects('不是数组'), []);
  const many = Array.from({ length: 12 }, (_, i) => ({ pos: i, len: 2, text: '汰汰', reason: '非词二元组' }));
  assert.equal(normalizeSuspects(many).length, LEDGER_LINT_SAMPLES_MAX);
  const dirty = [
    { pos: -5, len: -1, text: '汰汰', reason: 'r' },
    { pos: 3, len: 2, text: '', reason: '空文本要丢掉' },
    { pos: 'x', len: 'y', text: '甲', reason: 'z' },
    null,
    42,
  ];
  const out = normalizeSuspects(dirty);
  assert.equal(out.length, 2);
  assert.equal(out[0].pos, 0);          // -5 → 0
  assert.equal(out[0].len, 0);          // -1 → 0
  assert.equal(out[1].pos, 0);          // 'x' → 0
  // 单条文本/理由自己也有上限（24 码点），别让它变成搬运正文的通道
  const huge = normalizeSuspects([{ pos: 0, len: 2, text: '甲'.repeat(100), reason: '乙'.repeat(100) }]);
  assert.equal(Array.from(huge[0].text).length, 24);
  assert.equal(Array.from(huge[0].reason).length, 24);
});

// ───────────────────────── B. 客户端 ─────────────────────────

test('createTextLinter：正常答复 → svc:ok，带 count 与截断后的 samples', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return {
          count: 9,
          ms: 1.23,
          suspects: Array.from({ length: 9 }, (_, i) => ({ pos: i, len: 2, text: '汰汰', reason: '非词二元组' })),
        };
      },
    };
  };
  const linter = createTextLinter({ fetchImpl: fakeFetch });
  const r = await linter.inspect('三步顺序是 → 汰汰保护');
  assert.equal(r.svc, 'ok');
  assert.equal(r.count, 9);                       // count 是"总共几处"，不受 samples 上限影响
  assert.equal(r.samples.length, 5);              // samples 只留前 5 条
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8791/detect');
  assert.equal(calls[0].body.text, '三步顺序是 → 汰汰保护');
  const st = linter.stats();
  assert.equal(st.calls, 1);
  assert.equal(st.ok, 1);
});

test('createTextLinter：超时 → svc:timeout（不抛、不 reject）', async () => {
  const fakeFetch = async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  };
  const linter = createTextLinter({ fetchImpl: fakeFetch, config: { timeoutMs: 50 } });
  const r = await linter.inspect('随便一句话');
  assert.equal(r.svc, 'timeout');
  assert.equal(r.count, 0);
  assert.equal(linter.stats().timeout, 1);
});

test('createTextLinter：服务没起（ECONNREFUSED）→ svc:down', async () => {
  const fakeFetch = async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  };
  const linter = createTextLinter({ fetchImpl: fakeFetch });
  const r = await linter.inspect('随便一句话');
  assert.equal(r.svc, 'down');
  assert.equal(linter.stats().down, 1);
});

test('createTextLinter：HTTP 500 / 怪异常 → svc:error，永不抛', async () => {
  const linter500 = createTextLinter({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal((await linter500.inspect('x')).svc, 'error');

  const linterWeird = createTextLinter({
    fetchImpl: async () => {
      throw new Error('某个谁也没预料到的错误');
    },
  });
  assert.equal((await linterWeird.inspect('x')).svc, 'error');

  // 连 json 都不是合法 JSON
  const linterBadJson = createTextLinter({
    fetchImpl: async () => ({ ok: true, async json() { throw new Error('not json'); } }),
  });
  assert.equal((await linterBadJson.inspect('x')).svc, 'error');
});

test('createTextLinter：关掉时一次请求都不发', async () => {
  let called = 0;
  const linter = createTextLinter({
    config: { enabled: false },
    fetchImpl: async () => {
      called += 1;
      return { ok: true, async json() { return { count: 0, suspects: [] }; } };
    },
  });
  const r = await linter.inspect('随便一句话');
  assert.equal(r.svc, 'disabled');
  assert.equal(called, 0);
  assert.equal(linter.stats().enabled, false);
});

test('createTextLinter：空文本直接回 ok 且不发请求', async () => {
  let called = 0;
  const linter = createTextLinter({
    fetchImpl: async () => {
      called += 1;
      return { ok: true, async json() { return {}; } };
    },
  });
  assert.equal((await linter.inspect('')).svc, 'ok');
  assert.equal(called, 0);
});

test('createTextLinter：spawn 关掉时绝不起子进程', () => {
  let spawned = 0;
  const linter = createTextLinter({
    config: { spawn: false },
    spawnImpl: () => {
      spawned += 1;
      return { pid: 1, kill() {}, on() {}, stderr: null, stdin: null };
    },
  });
  linter.start();
  linter.start();                 // 幂等
  assert.equal(spawned, 0);
  assert.equal(linter.stats().spawned, false);
});

test('createTextLinter：spawn 抛错只记 warn，且 enabled 不受影响', () => {
  const logs = [];
  const linter = createTextLinter({
    // `script` 指一个**确实存在的文件**：用例要走到 spawn 那一步，
    // 不能因为它先撞上"脚本不存在"就提前返回（那是另一条分支）。
    config: { spawn: true, script: import.meta.filename },
    log: (level, message) => logs.push({ level, message }),
    spawnImpl: () => {
      throw new Error('找不到 python');
    },
  });
  assert.doesNotThrow(() => linter.start());
  assert.equal(linter.stats().spawnFailed, true);
  assert.ok(logs.some((l) => l.level === 'warn' && /起不来|spawn/.test(l.message)));
  // ⚠️ 起不来**不等于**判据被关掉：它仍然可以当纯客户端去连一个已经在跑的服务
  assert.equal(linter.stats().enabled, true);
});

// ───────────────────────── C. 台账字段 ─────────────────────────

test('台账：`text` 只存前 200 码点，`chars` 记总长度', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'qq-outbound.jsonl');
  const ledger = createOutboundLedger({ config: { file, enabled: true, maxLines: 100 }, log: () => {} });
  const long = '甲'.repeat(300);
  ledger.record({ layer: 'gw-send', textHead: long, chars: long.length, sha256: ledgerHash(long), ok: true });
  const [row] = ledger.read();
  assert.equal(Array.from(row.text).length, 200);
  assert.equal(row.chars, 300);
});

test('台账：没给 `textHead` / `lint` 时**这两个键根本不存在**（老调用点形状不变）', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'qq-outbound.jsonl');
  const ledger = createOutboundLedger({ config: { file, enabled: true, maxLines: 100 }, log: () => {} });
  ledger.record({ layer: 'transport-action', chars: 5, sha256: 'abc', ok: true });
  const [row] = ledger.read();
  assert.equal('text' in row, false);
  assert.equal('lint' in row, false);
});

test('台账：`lint` 里的 samples 被收到 5 条、每条文本限长', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'qq-outbound.jsonl');
  const ledger = createOutboundLedger({ config: { file, enabled: true, maxLines: 100 }, log: () => {} });
  ledger.record({
    layer: LAYER_TEXT_LINT,
    chars: 10,
    sha256: 'abc',
    ok: true,
    lint: {
      count: 9,
      ms: 0.4,
      svc: 'ok',
      samples: Array.from({ length: 9 }, (_, i) => ({ pos: i, len: 2, text: '汰'.repeat(50), reason: '非词二元组' })),
    },
  });
  const [row] = ledger.read();
  assert.equal(row.lint.count, 9);
  assert.equal(row.lint.svc, 'ok');
  assert.equal(row.lint.samples.length, 5);
  assert.equal(Array.from(row.lint.samples[0].text).length, 24);
});

// ───────────────── D. 网关接线 + 静默失败 ─────────────────

function makeTransport() {
  const emitter = new EventEmitter();
  const sent = [];
  return {
    sent,
    selfId: '999',
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async sendToChat(chatId, message) {
      sent.push({ chatId, message });
      return sent.length;
    },
  };
}

function dmEvent(overrides = {}) {
  return {
    time: Math.floor(T0 / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 1,
    user_id: 2001,
    message: [{ type: 'text', text: '在吗' }],
    raw_message: '在吗',
    sender: { nickname: '阿猫', card: '' },
    ...overrides,
  };
}

/**
 * 装一套网关：真 Gateway/Router/Engine + 假 transport。
 * `textLint` / `outboundLedger` 通过 `options.gateway` 透传（和现有 harness 同一条规矩）。
 */
function harness({ textLint = null, ledgerFile = null, reply = '回复一' } = {}) {
  const transport = makeTransport();
  const router = new Router({ dmPolicy: POLICY.OPEN, groupPolicy: POLICY.OPEN, requireMention: true, adminUsers: [], restrictMembers: false });
  const logs = [];
  const engine = new ProactiveEngine({
    config: { enabled: false, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0, afterUserMsgCount: 1 },
    gauge: async () => ({ speak: true, text: 'x' }),
    speak: async () => undefined,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => T0,
  });
  const ledger = ledgerFile === null ? null
    : createOutboundLedger({ config: { file: ledgerFile, enabled: true, maxLines: 1000 }, log: () => {} });
  const gateway = new Gateway({
    transport,
    router,
    engine,
    outboundAllow: RELAY_ALLOW,
    responder: async () => reply,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    maxReplyChars: 2000,
    outboundLedger: ledger,
    textLint,
  });
  gateway.attach();
  return { gateway, transport, logs, ledger };
}

const rowsOf = (ledger) => ledger.read();

test('★ 网关：发送后补记一行 `text-lint`，与 `gw-send` 同 sha256 / 同 at', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'qq-outbound.jsonl');
  const fakeLint = {
    async inspect(text) {
      return { svc: 'ok', count: 2, ms: 0.3, samples: [
        { pos: 4, len: 2, text: '汰汰', reason: '非词二元组' },
        { pos: 9, len: 2, text: '栗目', reason: '非词二元组' },
      ] };
    },
    start() {}, dispose() {}, stats: () => ({}),
  };
  const h = harness({ textLint: fakeLint, ledgerFile: file });
  const result = await h.gateway.handleEvent(dmEvent());
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.transport.sent.length, 1);

  const lintRow = await waitFor(() => rowsOf(h.ledger).find((r) => r.layer === LAYER_TEXT_LINT));
  assert.ok(lintRow, '必须补记一行 text-lint');
  const sendRow = rowsOf(h.ledger).find((r) => r.layer === 'gw-send');
  assert.ok(sendRow);
  assert.equal(lintRow.sha256, sendRow.sha256);
  assert.equal(lintRow.at, sendRow.at);
  assert.equal(lintRow.layer, 'text-lint');
  assert.equal(lintRow.chatId, sendRow.chatId);
  assert.equal(lintRow.ok, true);
  assert.equal(lintRow.lint.count, 2);
  assert.equal(lintRow.lint.svc, 'ok');
  assert.equal(lintRow.lint.samples.length, 2);
  // `gw-send` 那一行也带上了 `text`
  assert.equal(sendRow.text, '回复一');
});

test('★ 网关：判据**抛异常**时发送照常、台账照写、不抛、不写 lint 行', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'qq-outbound.jsonl');
  const boom = {
    inspect() { throw new Error('判据炸了'); },
    start() {}, dispose() {}, stats: () => ({}),
  };
  const h = harness({ textLint: boom, ledgerFile: file });
  const result = await h.gateway.handleEvent(dmEvent());
  // 发送照常
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.transport.sent.length, 1);
  // 等一小会儿，确认它确实没有写出 lint 行，也没把异常抛到事件循环
  await new Promise((r) => setTimeout(r, 120));
  const rows = rowsOf(h.ledger);
  assert.ok(rows.some((r) => r.layer === 'gw-send'), 'gw-send 必须照写');
  assert.equal(rows.some((r) => r.layer === LAYER_TEXT_LINT), false, '判据炸了就不该有 lint 行');
  // 而且不许有任何一条 error 级日志把它当事故（只有 debug）
  assert.equal(h.logs.some((l) => l.level === 'error'), false);
});

test('★ 网关：判据**返回 reject** 时同样静默（发送照常）', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'qq-outbound.jsonl');
  const rejecting = {
    inspect() { return Promise.reject(new Error('异步炸')); },
    start() {}, dispose() {}, stats: () => ({}),
  };
  const h = harness({ textLint: rejecting, ledgerFile: file });
  const result = await h.gateway.handleEvent(dmEvent());
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  await new Promise((r) => setTimeout(r, 120));
  const rows = rowsOf(h.ledger);
  assert.ok(rows.some((r) => r.layer === 'gw-send'));
  assert.equal(rows.some((r) => r.layer === LAYER_TEXT_LINT), false);
});

test('★ 网关：服务**真的没起**（端口没人听）→ 发送照常，lint 行记 svc:"down"', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'qq-outbound.jsonl');
  // 真客户端、真 fetch、指向一个没人监听的端口（1 号端口不会有人听）
  const realClient = createTextLinter({
    config: { url: 'http://127.0.0.1:1', timeoutMs: 300, spawn: false },
    log: () => {},
  });
  const h = harness({ textLint: realClient, ledgerFile: file });
  const t0 = Date.now();
  const result = await h.gateway.handleEvent(dmEvent());
  const sendMs = Date.now() - t0;
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.transport.sent.length, 1);
  // ⭐ 关键：发送**不等**判据。判据超时是 300ms，发送路径不该被拖住。
  assert.ok(sendMs < 250, `发送不该被判据拖慢，实际 ${sendMs}ms`);

  const lintRow = await waitFor(() => rowsOf(h.ledger).find((r) => r.layer === LAYER_TEXT_LINT), { ms: 3000 });
  assert.ok(lintRow, '服务没起也要留一行，写明 svc=down —— 否则"没判据"和"没可疑"分不开');
  assert.equal(lintRow.lint.svc, 'down');
  assert.equal(lintRow.lint.count, 0);
  assert.equal(lintRow.ok, false);
});

test('网关：`textLint` 为 null 时一行 lint 都不写（老行为）', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'qq-outbound.jsonl');
  const h = harness({ textLint: null, ledgerFile: file });
  const result = await h.gateway.handleEvent(dmEvent());
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  await new Promise((r) => setTimeout(r, 100));
  const rows = rowsOf(h.ledger);
  assert.ok(rows.some((r) => r.layer === 'gw-send'));
  assert.equal(rows.some((r) => r.layer === LAYER_TEXT_LINT), false);
});
