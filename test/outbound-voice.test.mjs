/**
 * 出站语音（2026-10-26，`send_voice`）：段形状 + 网关的三道闸 + 一个工具。
 *
 * ## 这组测试钉什么
 *
 * 1. **段形状**：`voiceSegment()` 产出 OneBot 11 的规范形状 `{type:'record', data:{…}}`
 *    （照 2026-10-26 真机验过的形状：本地 mp3 路径 → NapCat 自己转 silk）。
 * 2. **三道闸**（全在 `gateway.sendVoiceFromTool`，不在工具层）：
 *    出站白名单 / 群里默认不许 / 每会话最小间隔。
 * 3. **不顶掉文字**：发语音**绝不**碰 `toolSendSeq`（那个只由 `send_qq` 数文字）。
 * 4. **失败要能让她改文字**：没开 / 合成失败 / 发送失败，都返回 `{ok:false, note}`，
 *    `note` 里必须有原因。
 * 5. **台账能区分语音和文字**：`gw-send` 那行的 `meta.kind === 'voice'`。
 *
 * 全程不碰真 QQ：transport / 台账 / 合成器都是替身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { voiceSegment } from '../src/onebot/protocol.mjs';
import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { createOutboundAllow } from '../src/dsh/outbound-allow.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';
import { SessionBinder, toolBridge, publishToolBridge } from '../src/dsh/binding.mjs';

const T0 = Date.UTC(2026, 4, 1, 12, 0, 0);
const DM_CHAT = 'private:2001';
const DM_KEY = 'qq-private-2001';
const GROUP_CHAT = 'group:100';
const GROUP_KEY = 'qq-group-100';

const RELAY_ALLOW = createOutboundAllow({ allowFrom: ['2001'], groupAllowFrom: ['100'] });

// ---------------------------------------------------------------- 段形状

test('voiceSegment：本地绝对路径 ⇒ {type:record, data:{file}}', () => {
  assert.deepEqual(voiceSegment('<tmp>\\a.mp3'), {
    type: 'record',
    data: { file: '<tmp>\\a.mp3' },
  });
});

test('voiceSegment：http(s) ⇒ url；base64:// 与 file:// 走 file', () => {
  assert.deepEqual(voiceSegment('https://x/y.mp3'), { type: 'record', data: { url: 'https://x/y.mp3' } });
  assert.deepEqual(voiceSegment('base64://AAAA'), { type: 'record', data: { file: 'base64://AAAA' } });
  assert.deepEqual(voiceSegment('file:///H:/a.mp3'), { type: 'record', data: { file: 'file:///H:/a.mp3' } });
});

test('voiceSegment：对象输入 file 优先、path 是别名；已经是 record 段则幂等', () => {
  assert.deepEqual(voiceSegment({ path: 'a.mp3', file: 'b.mp3' }), { type: 'record', data: { file: 'b.mp3' } });
  assert.deepEqual(voiceSegment({ path: 'a.mp3' }), { type: 'record', data: { file: 'a.mp3' } });
  const seg = { type: 'record', data: { file: 'a.mp3' } };
  assert.deepEqual(voiceSegment(seg), { type: 'record', data: { file: 'a.mp3' } });
});

test('voiceSegment：空 / 认不出 ⇒ null（绝不发半个段出去）', () => {
  assert.equal(voiceSegment(''), null);
  assert.equal(voiceSegment('   '), null);
  assert.equal(voiceSegment(null), null);
  assert.equal(voiceSegment({ foo: 1 }), null);
  assert.equal(voiceSegment({ type: 'record', data: {} }), null);
});

// ---------------------------------------------------------------- 网关替身

function makeTransport() {
  const emitter = new EventEmitter();
  const sent = [];
  return {
    selfId: '999',
    sent,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async sendToChat(chatId, message) {
      sent.push({ chatId, message });
      return sent.length;
    },
  };
}

/** 合成器替身：默认总是成功（给一个假路径）。 */
function makeTts(overrides = {}) {
  const calls = [];
  return {
    enabled: true,
    allowGroups: false,
    minGapMs: 5_000,
    calls,
    describe: () => ({ enabled: true, notReadyReason: '', ...overrides.describe }),
    synthesize: async (input) => {
      calls.push(input);
      if (typeof overrides.synthesize === 'function') return overrides.synthesize(input);
      const chars = Array.from(String(input?.text ?? '')).length;
      return { ok: true, path: 'H:\\fake\\voice.mp3', bytes: 2048, chars, ms: 7 };
    },
  };
}

function harness(options = {}) {
  const transport = makeTransport();
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.OPEN,
    requireMention: true,
    adminUsers: ['9001'],
  });
  const ledgerRows = [];
  const logs = [];
  const engine = new ProactiveEngine({
    config: { enabled: false, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0, afterUserMsgCount: 1 },
    gauge: async () => ({ speak: false, text: '' }),
    speak: async () => undefined,
    log: () => {},
    now: () => T0,
  });

  const gateway = new Gateway({
    transport,
    router,
    engine,
    outboundAllow: RELAY_ALLOW,
    responder: async () => '',
    log: (level, message, meta) => logs.push({ level, message, meta }),
    maxReplyChars: 2000,
    outboundLedger: { record: (row) => ledgerRows.push(row) },
    tts: options.tts === undefined ? makeTts() : options.tts,
  });
  gateway.attach();
  return { gateway, transport, ledgerRows, logs };
}

// ---------------------------------------------------------------- 三道闸

test('★ 没接合成器 ⇒ 拒，并说"语音功能没开"', async () => {
  const { gateway, transport } = harness({ tts: null });
  const r = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.note, /没开/);
  assert.equal(transport.sent.length, 0);
});

test('★ 合成器没开（enabled=false）⇒ 拒，并把 notReadyReason 带出来', async () => {
  const tts = makeTts();
  tts.enabled = false;
  tts.describe = () => ({ enabled: false, notReadyReason: '没配 [tts] python' });
  const { gateway, transport } = harness({ tts });
  const r = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.note, /没开/);
  assert.match(r.note, /python/);
  assert.equal(transport.sent.length, 0);
});

test('★ 不在出站白名单 ⇒ 拒（语音比文字更吵，越界代价更大）', async () => {
  const tts = makeTts();
  const { gateway, transport } = harness({ tts });
  const r = await gateway.sendVoiceFromTool({ sessionKey: 'qq-private-3003', text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.note, /白名单/);
  assert.equal(tts.calls.length, 0, '被拒时连合成都别做');
  assert.equal(transport.sent.length, 0);
});

test('★ 群里默认不许（allow_groups=false）⇒ 拒；开了才发', async () => {
  const tts = makeTts();
  const { gateway, transport } = harness({ tts });
  const refused = await gateway.sendVoiceFromTool({ sessionKey: GROUP_KEY, text: '你好' });
  assert.equal(refused.ok, false);
  assert.match(refused.note, /群/);
  assert.equal(transport.sent.length, 0);

  tts.allowGroups = true;
  const ok = await gateway.sendVoiceFromTool({ sessionKey: GROUP_KEY, text: '你好' });
  assert.equal(ok.ok, true);
  assert.equal(transport.sent.length, 1);
});

test('★ 空文本 ⇒ 拒（不起合成、不发）', async () => {
  const tts = makeTts();
  const { gateway } = harness({ tts });
  const r = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.note, /空的/);
  assert.equal(tts.calls.length, 0);
});

// ---------------------------------------------------------------- 正常路径

test('★ 发一条语音：载荷是 record 段、台账记 meta.kind=voice、且**不碰 toolSendSeq**', async () => {
  const tts = makeTts();
  const { gateway, transport, ledgerRows } = harness({ tts });
  const before = gateway.toolSendSeq.get(DM_KEY) ?? 0;

  const r = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '喂喂，能听见吗？', now: T0 });

  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].chatId, DM_CHAT);
  assert.deepEqual(transport.sent[0].message, [{ type: 'record', data: { file: 'H:\\fake\\voice.mp3' } }]);

  const gwRows = ledgerRows.filter((row) => row.layer === 'gw-send');
  assert.equal(gwRows.length, 1, '一行 = 一次决定要发（不变式）');
  assert.equal(gwRows[0].caller, 'send_voice');
  assert.equal(gwRows[0].meta.kind, 'voice');
  assert.equal(gwRows[0].chars, Array.from('喂喂，能听见吗？').length, 'chars 记的是念出来的原文');

  // 🔴 不顶掉文字的判据：这条流水号没变 ⇒ 本轮文本回复照常自动发。
  assert.equal(gateway.toolSendSeq.get(DM_KEY) ?? 0, before, 'send_voice 绝不能递增 toolSendSeq');
});

test('语音和文字在台账里能分开（text 那行 meta.kind=text）', async () => {
  const { gateway, ledgerRows } = harness();
  await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '晚安', now: T0 });
  await gateway.sendFromTool({ sessionKey: DM_KEY, items: [{ text: '晚安' }], now: T0 + 60_000 });
  const kinds = ledgerRows.filter((row) => row.layer === 'gw-send').map((row) => row.meta.kind);
  assert.deepEqual(kinds, ['voice', 'text']);
});

test('★ 频率闸：同一会话紧接着再发 ⇒ 拒，并报还剩几秒', async () => {
  const { gateway, transport } = harness();
  const first = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '一', now: T0 });
  const second = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '二', now: T0 + 1_000 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.note, /秒后才能再发/);
  assert.equal(transport.sent.length, 1);

  const third = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '三', now: T0 + 6_000 });
  assert.equal(third.ok, true, '过了 min_gap 就能再发');
});

test('★ 合成失败 ⇒ ok:false 且 note 带原因（让她能改发文字）', async () => {
  const tts = makeTts({ synthesize: async () => ({ ok: false, error: 'EDGE_TTS_IMPORT_FAILED' }) });
  const { gateway, transport } = harness({ tts });
  const r = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.note, /EDGE_TTS_IMPORT_FAILED/);
  assert.match(r.note, /改发文字/);
  assert.equal(transport.sent.length, 0);
});

test('合成器自己抛异常 ⇒ 也变成 ok:false（绝不把异常漏给工具层）', async () => {
  const tts = makeTts({ synthesize: async () => { throw new Error('boom'); } });
  const { gateway } = harness({ tts });
  const r = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.note, /boom/);
});

test('★ 发送失败 ⇒ ok:false 且说"合成好了但发失败"（不是静默丢）', async () => {
  const { gateway, transport } = harness();
  transport.sendToChat = async () => { throw new Error('文件异常，大小为0'); };
  const r = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.note, /合成好了.*失败|发送失败/);
  assert.match(r.note, /大小为0/);
});

test('截断时 note 里说明截了多少字', async () => {
  const tts = makeTts({ synthesize: async () => ({
    ok: true, path: 'H:\\fake\\v.mp3', bytes: 10, chars: 120, ms: 3, truncated: { from: 200, to: 120 },
  }) });
  const { gateway } = harness({ tts });
  const r = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '长文', now: T0 });
  assert.equal(r.ok, true);
  assert.match(r.note, /200/);
  assert.match(r.note, /120/);
});

// ---------------------------------------------------------------- to 参数

test('★ to=`private:<QQ>` ⇒ 发到那个会话（照样过白名单）', async () => {
  const { gateway, transport } = harness();
  const r = await gateway.sendVoiceFromTool({ sessionKey: GROUP_KEY, text: '你好', to: 'private:2001', now: T0 });
  assert.equal(r.ok, true);
  assert.equal(transport.sent[0].chatId, 'private:2001');
});

test('to=`qq-group-100` 也认（老写法）', async () => {
  const tts = makeTts();
  tts.allowGroups = true;
  const { gateway, transport } = harness({ tts });
  const r = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好', to: 'qq-group-100', now: T0 });
  assert.equal(r.ok, true);
  assert.equal(transport.sent[0].chatId, GROUP_CHAT);
});

test('to 指向白名单外的会话 ⇒ 拒；to 格式认不出 ⇒ 拒', async () => {
  const { gateway, transport } = harness();
  const out = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好', to: 'private:3003' });
  assert.equal(out.ok, false);
  assert.match(out.note, /白名单/);

  const bad = await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好', to: '给她' });
  assert.equal(bad.ok, false);
  assert.match(bad.note, /认不出/);
  assert.equal(transport.sent.length, 0);
});

// ---------------------------------------------------------------- 工具层

/** 最小的 agent ctx（只要 `tools.register` + 一个能挂台账的对象）。 */
function fakeAgent() {
  const registrations = [];
  const state = new Map();
  const ctx = {
    tools: {
      register(tool) {
        registrations.push(tool);
        return () => {};
      },
    },
  };
  return { ctx, registrations, state };
}

test('★ registerVoiceTool：只在她这一层注册 `send_voice`，execute 走中转表', async () => {
  const agent = fakeAgent();
  const calls = [];
  const binder = new SessionBinder({
    ctx: {},
    voiceTool: async (args) => {
      calls.push(args);
      return { ok: true, sent: 1, note: '发了一条语音。' };
    },
  });
  // 构造 binder 时已经 publish 了自己；这里显式再发一次，保证和 `execute` 读的是同一份。
  publishToolBridge({ voice: binder.voiceTool });

  assert.equal(binder.registerVoiceTool(agent.ctx, DM_KEY, 'setup'), true);
  assert.equal(agent.registrations.length, 1);
  const tool = agent.registrations[0];
  assert.equal(tool.name, 'send_voice');
  assert.deepEqual(tool.parameters.required, ['text']);
  assert.match(tool.description, /语音/);
  assert.match(tool.description, /群聊里默认不许/, '描述必须提前告诉她群里会被拒');
  assert.doesNotMatch(tool.description, /send_qq 的参数/);

  const result = await tool.execute({ text: '晚安' });
  assert.deepEqual(result, { ok: true, sent: 1, note: '发了一条语音。' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionKey, DM_KEY);
  assert.equal(calls[0].text, '晚安');
});

test('registerVoiceTool：没注入执行器 ⇒ 不注册（不制造一个点了没反应的工具）', () => {
  const agent = fakeAgent();
  const binder = new SessionBinder({ ctx: {} });
  assert.equal(binder.registerVoiceTool(agent.ctx, DM_KEY), false);
  assert.equal(agent.registrations.length, 0);
});

test('registerVoiceTool：幂等（同一个 agent 上第二次不重复注册）', () => {
  const agent = fakeAgent();
  const binder = new SessionBinder({ ctx: {}, voiceTool: async () => ({ ok: true, sent: 1, note: '' }) });
  assert.equal(binder.registerVoiceTool(agent.ctx, DM_KEY, 'setup'), true);
  assert.equal(binder.registerVoiceTool(agent.ctx, DM_KEY, 'reuse'), false);
  assert.equal(agent.registrations.length, 1);
});

test('registerVoiceTool：中转表没接上时 execute 返回 ok:false（不抛）', async () => {
  const agent = fakeAgent();
  const binder = new SessionBinder({ ctx: {}, voiceTool: async () => ({ ok: true, sent: 1, note: '' }) });
  binder.registerVoiceTool(agent.ctx, DM_KEY);
  // 模拟"这一代实例已经不在"（热重载之后、新实例还没 publish）。
  publishToolBridge({ voice: null });
  const result = await agent.registrations[0].execute({ text: '晚安' });
  assert.equal(result.ok, false);
  assert.match(result.note, /没接上/);
  // 收尾：把表恢复，别影响同进程里的其它用例。
  assert.equal(typeof toolBridge, 'function');
});

// ---------------------------------------------------------------- 返回值 vs 声明的 schema
//
// ⚠️ 2026-10-26 线上真 bug：工具声明 `additionalProperties:false` 只允许
// `{ok,sent,note}`，而网关成功时多返回了 `ms`/`chars` ⇒ DSH 报
//   tool "send_voice" returned invalid output:
//   "value.ms" is not a declared property; "value.chars" is not a declared property
// —— **语音其实已经发出去了**（用户也听到了），但整次调用被判失败。
//
// 下面这组就是那次事故的回归网：**把每一条返回路径都拿去对一遍声明的 schema**。
// 以后再往返回里加字段（或忘了加声明），这里立刻红。

/** 极简校验器：只做"key 越界 / required 缺失 / 基本类型"三件事（够钉住这次的事故）。 */
function assertMatchesSchema(schema, value, label) {
  assert.equal(typeof value, 'object', `${label}：返回必须是对象`);
  for (const key of Object.keys(value)) {
    assert.ok(
      Object.hasOwn(schema.properties, key),
      `${label}：返回里有未声明的字段 "${key}"（会被 DSH 判成 invalid output）`,
    );
  }
  for (const key of schema.required) {
    assert.ok(Object.hasOwn(value, key), `${label}：缺 required 字段 "${key}"`);
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, key)) continue;
    const actual = Array.isArray(value[key]) ? 'array' : typeof value[key];
    assert.equal(actual, spec.type, `${label}："${key}" 的类型应该是 ${spec.type}`);
  }
}

/** 拿到 `send_voice` 声明的 output schema（从**真正注册出去**的那个工具上读，不是手抄）。 */
function declaredVoiceSchema() {
  const agent = fakeAgent();
  const binder = new SessionBinder({ ctx: {}, voiceTool: async () => ({ ok: true, sent: 1, note: '' }) });
  assert.equal(binder.registerVoiceTool(agent.ctx, DM_KEY), true);
  return agent.registrations[0].output.schema;
}

test('★ schema 回归：**每一条返回路径**都符合声明的 output.schema', async () => {
  const schema = declaredVoiceSchema();
  const cases = [];

  // 1) 成功
  {
    const { gateway } = harness();
    cases.push(['成功', await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好', now: T0 })]);
  }
  // 2) 没接合成器
  {
    const { gateway } = harness({ tts: null });
    cases.push(['没接合成器', await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好' })]);
  }
  // 3) 合成器没开
  {
    const tts = makeTts();
    tts.enabled = false;
    tts.describe = () => ({ enabled: false, notReadyReason: '没配 [tts] python' });
    const { gateway } = harness({ tts });
    cases.push(['没开', await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好' })]);
  }
  // 4) 白名单
  {
    const { gateway } = harness();
    cases.push(['白名单', await gateway.sendVoiceFromTool({ sessionKey: 'qq-private-3003', text: '你好' })]);
  }
  // 5) 群里默认关
  {
    const { gateway } = harness();
    cases.push(['群里关', await gateway.sendVoiceFromTool({ sessionKey: GROUP_KEY, text: '你好' })]);
  }
  // 6) 空文本
  {
    const { gateway } = harness();
    cases.push(['空文本', await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '' })]);
  }
  // 7) 频率闸
  {
    const { gateway } = harness();
    await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '一', now: T0 });
    cases.push(['频率闸', await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '二', now: T0 + 100 })]);
  }
  // 8) 合成失败
  {
    const tts = makeTts({ synthesize: async () => ({ ok: false, error: 'boom' }) });
    const { gateway } = harness({ tts });
    cases.push(['合成失败', await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好' })]);
  }
  // 9) 发送失败（合成成功过 ⇒ ms/chars 有真实值，但 ok:false）
  {
    const { gateway, transport } = harness();
    transport.sendToChat = async () => { throw new Error('send_msg 超时'); };
    cases.push(['发送失败', await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好' })]);
  }
  // 10) to 认不出
  {
    const { gateway } = harness();
    cases.push(['to 认不出', await gateway.sendVoiceFromTool({ sessionKey: DM_KEY, text: '你好', to: '给她' })]);
  }

  for (const [label, value] of cases) {
    assertMatchesSchema(schema, value, label);
  }
});

test('★ schema 回归：工具自己的"通道没接上"兜底返回也要合规', async () => {
  const agent = fakeAgent();
  const binder = new SessionBinder({ ctx: {}, voiceTool: async () => ({ ok: true, sent: 1, note: '' }) });
  binder.registerVoiceTool(agent.ctx, DM_KEY);
  const tool = agent.registrations[0];
  publishToolBridge({ voice: null });
  const fallback = await tool.execute({ text: '晚安' });
  assertMatchesSchema(tool.output.schema, fallback, '通道没接上');
});
