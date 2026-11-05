/**
 * 设置页宿主半的测试。
 *
 * handler 的契约里有两条"错了就很难查"的约束，测试重点在它们：
 * 1. 必须返回 `{ok,value}` / `{ok,error}` 信封，不能抛异常——抛了会变成 HTTP 500，
 *    界面只能显示"请求失败"，看不到校验原因。
 * 2. 写入必须经 ConfigEditor（和手改 YAML 同一层），而不是自己维护一份内存状态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSettingsHandler, CHANNEL, ENDPOINT, ENTRY_ID } from '../src/dsh/settings-host.mjs';
import { SECRET_PLACEHOLDER } from '../src/dsh/settings-contract.mjs';

/** 一份可用的基础配置。 */
function baseConfig(overrides = {}) {
  return {
    mode: 'reverse',
    host: '127.0.0.1',
    port: 8643,
    url: 'ws://127.0.0.1:3001',
    accessToken: 'secret-token',
    botQQ: '',
    dmPolicy: 'admin',
    groupPolicy: 'admin',
    requireMention: true,
    restrictMembers: true,
    adminUsers: ['10001'],
    allowFrom: [],
    groupAllowFrom: ['20001'],
    maxReplyChars: 2000,
    emptyReplyFallback: '',
    agentPreset: '',
    workspacePath: '',
    sessionIdleEvictHours: 12,
    ...overrides,
  };
}

/** 假的 ConfigEditor：记录 edit 调用并模拟持久化。 */
function fakeEditor({ entries = [{ options: { id: ENTRY_ID, config: {} } }], onEdit } = {}) {
  const calls = [];
  return {
    calls,
    entries: () => entries,
    async edit(entry, change) {
      calls.push({ entry, change });
      if (onEdit !== undefined) return onEdit(entry, change);
      return undefined;
    },
  };
}

/** 组装 handler 与可控的配置读出口。 */
function harness({ config = baseConfig(), editor, status } = {}) {
  const logs = [];
  let current = { ...config };
  const logsOut = (level, message, meta) => logs.push({ level, message, meta });
  const ctx = { configEditor: editor };
  const handler = createSettingsHandler({
    ctx,
    getConfig: () => current,
    getStatus: () => status ?? { connected: true, selfId: '99999', liveSessions: 1, stats: {} },
    log: logsOut,
  });
  return {
    handler,
    logs,
    setConfig: (next) => {
      current = next;
    },
  };
}

const signal = new AbortController().signal;

// ---------------------------------------------------------------- 读

test('GET：返回脱敏后的配置，明文 token 不出宿主', async () => {
  const h = harness();
  const r = await h.handler(ENDPOINT.GET, {}, signal);
  assert.equal(r.ok, true);
  assert.equal(r.value.config.accessToken, SECRET_PLACEHOLDER);
  assert.equal(JSON.stringify(r.value).includes('secret-token'), false, '明文不能出现');
  assert.equal(r.value.channel, CHANNEL);
  assert.equal(r.value.entryId, ENTRY_ID);
  assert.equal(r.value.config.port, 8643);
});

test('STATUS：返回运行时状态', async () => {
  const h = harness({ status: { connected: false, selfId: '', liveSessions: 3, stats: { received: 9 } } });
  const r = await h.handler(ENDPOINT.STATUS, {}, signal);
  assert.equal(r.ok, true);
  assert.equal(r.value.connected, false);
  assert.equal(r.value.liveSessions, 3);
});

test('未知端点返回 ok:false 而不是抛异常', async () => {
  const h = harness();
  const r = await h.handler('nonsense', {}, signal);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /未知端点/);
});

// ---------------------------------------------------------------- 写

test('PATCH：校验后经 ConfigEditor 写入（与手改 YAML 同一层）', async () => {
  const editor = fakeEditor();
  const h = harness({ editor });
  const r = await h.handler(ENDPOINT.PATCH, { host: '0.0.0.0', port: 9000 }, signal);

  assert.equal(r.ok, true);
  assert.equal(r.value.changed, true);
  assert.deepEqual(r.value.applied.sort(), ['host', 'port']);
  assert.equal(editor.calls.length, 1, '必须走 ConfigEditor，而不是自己存内存');

  // change 是 (current, inherited) => next，应在现有 config 上叠加。
  const next = editor.calls[0].change({ host: '127.0.0.1', port: 8643, mode: 'reverse' }, {});
  assert.deepEqual(next, { host: '0.0.0.0', port: 9000, mode: 'reverse' });
});

test('PATCH：写完后回读真实生效值（含脱敏）', async () => {
  const editor = fakeEditor();
  const h = harness({ editor });
  const r = await h.handler(ENDPOINT.PATCH, { host: '0.0.0.0' }, signal);
  assert.equal(r.ok, true);
  assert.equal(r.value.config.host, '127.0.0.1', '回读的是 getConfig() 的真实值');
  assert.equal(r.value.config.accessToken, SECRET_PLACEHOLDER);
});

test('PATCH：空补丁不触发写入', async () => {
  const editor = fakeEditor();
  const h = harness({ editor });
  const r = await h.handler(ENDPOINT.PATCH, {}, signal);
  assert.equal(r.ok, true);
  assert.equal(r.value.changed, false);
  assert.equal(editor.calls.length, 0);
});

test('PATCH：只有未知键时也不写入', async () => {
  const editor = fakeEditor();
  const h = harness({ editor });
  const r = await h.handler(ENDPOINT.PATCH, { 未来字段: 1 }, signal);
  assert.equal(r.ok, true);
  assert.equal(r.value.changed, false);
  assert.equal(editor.calls.length, 0);
});

test('PATCH：脱敏占位符不会把 token 覆盖成字面量', async () => {
  const editor = fakeEditor();
  const h = harness({ editor });
  const r = await h.handler(ENDPOINT.PATCH, { accessToken: SECRET_PLACEHOLDER, host: 'x' }, signal);
  assert.equal(r.ok, true);
  const next = editor.calls[0].change({ accessToken: 'real-token' }, {});
  assert.equal(next.accessToken, 'real-token', 'token 应保持不变');
  assert.equal(next.host, 'x');
});

test('PATCH：校验失败时返回 ok:false 且原因可读，不写入', async () => {
  const editor = fakeEditor();
  const h = harness({ editor });
  const r = await h.handler(ENDPOINT.PATCH, { port: 'abc' }, signal);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /监听端口/);
  assert.equal(editor.calls.length, 0, '校验不过就不该写');
});

test('PATCH：反向模式下拒绝清空 accessToken（fail-closed）', async () => {
  const editor = fakeEditor();
  const h = harness({ editor });
  const r = await h.handler(ENDPOINT.PATCH, { accessToken: '' }, signal);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /必须填 Access Token/);
  assert.equal(editor.calls.length, 0);
});

test('PATCH：切到 forward 模式时不强制 token', async () => {
  const editor = fakeEditor();
  const h = harness({ editor, config: baseConfig({ accessToken: '' }) });
  const r = await h.handler(ENDPOINT.PATCH, { mode: 'forward', url: 'ws://127.0.0.1:3001' }, signal);
  assert.equal(r.ok, true);
  assert.equal(editor.calls.length, 1);
});

test('PATCH：已有 token 时改别的字段不会被 token 规则挡住', async () => {
  const editor = fakeEditor();
  const h = harness({ editor });
  const r = await h.handler(ENDPOINT.PATCH, { host: '0.0.0.0' }, signal);
  assert.equal(r.ok, true, '改 host 不该被 accessToken 规则拦下');
});

// ---------------------------------------------------------------- 缺服务

test('缺 configEditor 时返回可读错误，并指向手工改 YAML', async () => {
  const h = harness({ editor: undefined });
  const r = await h.handler(ENDPOINT.PATCH, { host: 'x' }, signal);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /configEditor/);
  assert.match(r.error.message, /cordis\.patch\.yml/);
});

test('找不到自己那一行时返回可读错误', async () => {
  const editor = fakeEditor({ entries: [{ options: { id: '别人的行' } }] });
  const h = harness({ editor });
  const r = await h.handler(ENDPOINT.PATCH, { host: 'x' }, signal);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /找不到/);
  assert.equal(editor.calls.length, 0);
});

test('ConfigEditor.edit 抛错时转成 ok:false，而不是逃逸成 500', async () => {
  const editor = fakeEditor({
    onEdit: () => {
      throw new Error('profile 被锁住了');
    },
  });
  const h = harness({ editor });
  const r = await h.handler(ENDPOINT.PATCH, { host: 'x' }, signal);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /profile 被锁住了/);
  assert.ok(h.logs.some((l) => l.level === 'warn'));
});

// ---------------------------------------------------------------- 兜底

test('任何未预期异常都被吞进信封（绝不让通道变成 500）', async () => {
  const handler = createSettingsHandler({
    ctx: { configEditor: fakeEditor() },
    getConfig: () => {
      throw new Error('读配置炸了');
    },
    getStatus: () => ({}),
  });
  const r = await handler(ENDPOINT.GET, {}, signal);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /读配置炸了/);
});

test('已取消的请求立刻返回，不做任何工作', async () => {
  const editor = fakeEditor();
  const h = harness({ editor });
  const aborted = new AbortController();
  aborted.abort();
  const r = await h.handler(ENDPOINT.PATCH, { host: 'x' }, aborted.signal);
  assert.equal(r.ok, false);
  assert.equal(editor.calls.length, 0);
});

test('错误码带插件前缀，便于界面上区分来源', async () => {
  const h = harness();
  const r = await h.handler('nope', {}, signal);
  assert.match(r.error.code, /^qq-proactive\//);
});
