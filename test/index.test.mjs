/**
 * 插件入口的配置校验测试。
 *
 * `apply()` 本身需要真实 DSH 运行时才能跑，但**配置校验**是纯的，而且它恰好是
 * 最该被测的部分：反向模式漏配 token 会把机器人控制权开放给整个局域网，
 * 这类错误必须在启动前就拦住，而不是等运行起来才发现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as pluginModule from '../src/index.mjs';
import { resolveConfig, configShape, name, inject } from '../src/index.mjs';
import { POLICY } from '../src/dsh/routing.mjs';
import { dshHome } from '../src/dsh/paths.mjs';
import { buildStickerInstruction } from '../src/dsh/image-desc.mjs';
import { defaultGaugeConfig } from '../src/dsh/heuristic-gauge.mjs';
import { defaultTriggerConfig } from '../src/proactive/engine.mjs';

test('插件名与 inject 声明稳定', () => {
  assert.equal(name, 'qq-proactive');
  assert.deepEqual(inject, ['agents', 'timer', 'agentDefaultModel', 'llm', 'agentPresets']);
});

// ---------------------------------------------------------------- apply 的软着陆
//
// 这一组钉住一个**会让整个 DSH 起不来**的回归：
// 曾经 `apply()` 里是 `transport.start().catch(err => { log(...); throw err; })`，
// 意图是"失败要让宿主看到，不静默"。但连接失败是**运行时**问题
// （NapCat 没开、端口不对、网络抖动），抛出去会让宿主判定插件加载失败，
// 桌面端直接弹 "The application could not start or stopped unexpectedly"。
//
// 正确行为：**记录日志 + 后台退避重试**，apply 正常返回，插件处于
// "已加载但未连接"，等对端起来自动接上（与 dsh-onebot-qq 一致）。

/**
 * 造一个刚好够 apply() 用的假 ctx。
 *
 * @param {object} [options]
 * @param {Array<object>} [options.liveSessions] 如果给了，就模拟宿主暴露 `sessions` 服务
 *   （`ctx.sessions.list()`），用于测「借聊天轮次顺便看一眼」的巡检路径。
 * @param {object} [options.agents] 如果给了，就挂到 `ctx.agents` 上
 *   （测「宿主自己捡起会话」那条路的补装备闸门：它要 `agents.get()` 找活着的 agent）。
 */
function fakeCtx({ liveSessions, agents } = {}) {
  const timers = [];
  const logs = [];
  /** 事件名 → 处理器数组（用于手动触发 `session/event`）。 */
  const handlers = new Map();
  /** 收到的出站消息（`{chatId, text}`）——**唯一可信的"有没有打扰用户"证据**。 */
  const outbound = [];
  const sessionsService =
    liveSessions === undefined
      ? undefined
      : { list: () => liveSessions, get: (id) => liveSessions.find((s) => s.id === id) };

  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      error: (...a) => logs.push(['error', ...a]),
      debug: () => {},
    },
    // Cordis 的 effect 会立刻跑 setup，返回 disposer
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    // 条件注入：服务齐了才跑 cb；['sessions'] 里的服务在本假 ctx 上按需提供。
    inject: (names, cb) => {
      if (typeof names === 'function') return () => {};
      const wanted = Array.isArray(names) ? names : [names];
      if (wanted.includes('sessions') && sessionsService !== undefined) {
        cb({ sessions: sessionsService, effect: ctx.effect });
      }
      return () => {};
    },
    interval: () => () => {},
    // 有的测试要让它"看见活着的 agent"（补装备闸门走 agents.get()）。
    ...(agents === undefined ? {} : { agents }),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return { unref: () => {} };
    },
    on: (name, handler) => {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return () => {};
    },
  };

  return {
    logs,
    timers,
    handlers,
    outbound,
    ctx,
    /** 手动触发某个事件，模拟宿主广播。 */
    fire(type, ...args) {
      for (const h of handlers.get(type) ?? []) h(...args);
    },
  };
}

test('apply：传输层连不上时**不能抛异常**（否则整个 App 起不来）', async () => {
  const { ctx } = fakeCtx();
  let result;
  await assert.doesNotReject(async () => {
    result = await pluginModule.apply(ctx, {
      mode: 'http',
      httpUrl: 'http://127.0.0.1:1',
      accessToken: 'x',
      actionTimeoutMs: 1500,
    });
  }, '连接失败是运行时问题，绝不能冒泡成加载失败');

  assert.equal(typeof result, 'object');
  assert.equal(typeof result.started, 'function');
  assert.equal(result.started(), false, '此刻应处于未连接状态');
});

test('apply：连不上时安排后台重试，且不记 error（不误导为加载失败）', async () => {
  const { ctx, timers, logs } = fakeCtx();
  await pluginModule.apply(ctx, {
    mode: 'http',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'x',
    actionTimeoutMs: 1500,
  });
  // 等后台那次连接尝试失败并安排重试
  await new Promise((r) => setTimeout(r, 2500));

  assert.ok(timers.length >= 1, '应安排至少一次重试定时器');
  assert.ok(
    logs.some(([level, msg]) => level === 'warn' && /重试/.test(String(msg))),
    `应有 warn 级重试日志，实际：${JSON.stringify(logs.map((l) => `${l[0]}:${l[1]}`))}`,
  );
  assert.equal(
    logs.some(([level]) => level === 'error'),
    false,
    '连接失败不该记 error',
  );
});

test('apply：正常返回句柄（网关/引擎/会话绑定都在）', async () => {
  const { ctx } = fakeCtx();
  const handle = await pluginModule.apply(ctx, {
    mode: 'http',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'x',
    actionTimeoutMs: 1000,
  });
  assert.equal(typeof handle.gateway, 'object');
  assert.equal(typeof handle.engine, 'object');
  assert.equal(typeof handle.binder, 'object');
});

test('★ 补装备闸门：真的注册在 apply 作用域里、按 isEquipped 判、有冷却、只管 QQ 会话', async () => {
  // 这条是 2026-10-24 那次重写的回归。两层坑：
  // ① 旧代码写在**模块级** `attachReportBridge()` 里，而 `binder` 是 apply 的局部变量
  //    ⇒ 那里 `typeof binder !== 'undefined'` 恒为假，整个"补装备"分支从没执行过
  //    （`78463d1` 本意修的裸轮因此没修好）。这条测试会抓住"又掉回模块级/没接线"。
  // ② 判据必须是 `isEquipped(ctx)`（ctx 上的台账），不是 `Set<sessionId>` ——
  //    后者在 ctx 换掉之后仍说"补过了"。
  const agentCtxA = { tools: {}, systemPrompt: {} };
  const agent = { id: 'qq-group-100', session: { id: 'qq-group-100' }, ctx: agentCtxA };
  const { ctx, fire } = fakeCtx({
    agents: { get: (id) => (id === 'qq-group-100' ? agent : undefined), list: () => [agent] },
  });
  const handle = await pluginModule.apply(ctx, {
    mode: 'http',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'x',
    actionTimeoutMs: 1000,
  });

  let ready = false;
  let equipped = 0;
  handle.binder.isEquipped = () => ready;
  handle.binder.equipLiveAgent = () => { equipped += 1; return true; };

  fire('session/event', agent.session, { type: 'turn/start' });
  assert.equal(equipped, 1, '不齐 ⇒ 补一次（说明闸门真的挂在 apply 作用域里、能拿到 binder）');

  fire('session/event', agent.session, { type: 'turn/start' });
  assert.equal(equipped, 1, '5 秒内不重复补（补失败时别把日志刷满）');

  ready = true;
  fire('session/event', agent.session, { type: 'turn/start' });
  assert.equal(equipped, 1, '已经齐了 ⇒ 不再补');

  // ctx 换掉（宿主重新 resume）：新 ctx 上判"不齐" ⇒ 冷却过后要再补一次。
  const agentCtxB = { tools: {}, systemPrompt: {} };
  agent.ctx = agentCtxB;
  ready = false;
  const realNow = Date.now;
  Date.now = () => realNow() + 6000;
  try {
    fire('session/event', agent.session, { type: 'turn/start' });
  } finally {
    Date.now = realNow;
  }
  assert.equal(equipped, 2, 'ctx 换了 ⇒ 冷却结束必须重补');

  // 主会话/子会话（不归本插件管）一个都不许补。
  fire('session/event', { id: 'session-00000000' }, { type: 'turn/start' });
  fire('session/event', { id: 'some-subagent-id' }, { type: 'turn/start' });
  assert.equal(equipped, 2, '别的 agent 不许挂上 QQ 的工具与人格');
});

// ---------------------------------------------------------------- 出站白名单的接线
//
// 出站的准入名单**从配置读**（`allowFrom` / `groupAllowFrom`），
// 由这里（装配层）用 `createOutboundAllow()` 造成判定器、注入网关。
//
// ⚠️ 为什么这一组必须存在：名单曾经写死在代码里，
// 于是"白名单有测试守着"是错觉 —— 测试钉的是一份副本，改配置不影响任何用例，
// 生产白名单被清空也不会有测试变红。这一组钉的正是**配置 → 判定器**这段接线：
// 只要有人把名单写回去、或者忘了把配置传进来，它立刻红。

/** 起一个最小可用的插件实例，返回它注入网关的那个出站判定器。 */
async function outboundAllowFrom(config) {
  const { ctx } = fakeCtx();
  const handle = await pluginModule.apply(ctx, {
    mode: 'http',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'x',
    actionTimeoutMs: 1000,
    ...config,
  });
  assert.equal(typeof handle.gateway.outboundAllow, 'function', '网关该拿到注入的出站判定器');
  return handle.gateway.outboundAllow;
}

test('出站白名单：配置里的 allowFrom / groupAllowFrom 决定谁能收消息', async () => {
  const allow = await outboundAllowFrom({
    dmPolicy: 'allowlist',
    allowFrom: ['10000001'],
    groupPolicy: 'allowlist',
    groupAllowFrom: ['200000001'],
  });

  assert.equal(allow('private', '10000001'), true, '名单里的私聊');
  assert.equal(allow('group', '200000001'), true, '名单里的群');
  assert.equal(allow('private', '10000002'), false, '名单外的私聊');
  assert.equal(allow('group', '200000002'), false, '名单外的群');
  assert.equal(allow('private', '200000001'), false, '★ 群号当私聊不认（撞号区分）');
  assert.equal(allow('group', '10000001'), false, '★ QQ 号当群不认（撞号区分）');
});

test('出站白名单：改配置就改行为 —— 不用动代码', async () => {
  // ★ 这是这次改动的**目的本身**：用户要能自己改名单（他原话：「不然公开了我这些东西全公开了」）。
  const before = await outboundAllowFrom({
    allowFrom: ['10000001'],
    groupAllowFrom: ['200000001'],
  });
  const after = await outboundAllowFrom({
    allowFrom: ['10000001', '10000002'],
    groupAllowFrom: ['200000001', '200000002'],
  });

  assert.equal(before('private', '10000002'), false, '改配置前不放行');
  assert.equal(after('private', '10000002'), true, '★ 只改了配置值，就放行了');
  assert.equal(before('group', '200000002'), false);
  assert.equal(after('group', '200000002'), true);

  // 收紧方向同样只看配置 —— 这是用户最在意的那半边。
  const tightened = await outboundAllowFrom({
    allowFrom: [],
    groupAllowFrom: [],
  });
  assert.equal(tightened('private', '10000001'), false, '⚠️ 从名单里删掉 = 立刻不再放行');
  assert.equal(tightened('group', '200000001'), false);
});

// ---------------------------------------------------------------- speak 静默失败
//
// 这一类是"判定说该说、日志也记了 speak、但用户什么都没收到"的根因之一。
//
// `gateway.speakProactively()` 在**失败时返回 `false`（不抛异常）**，
// 而 `index.mjs` 传给引擎的 `speak` 回调原本直接 `await` 它、**不看返回值** ——
// 于是引擎把 `phase` 标成成功，判定日记里写着 `event: "speak"`，
// 实际一条都没发出去。排查时完全看不出断在哪一步。
//
// 这条测试把"必须看返回值 + 失败要落日志"钉住。

/** 直接拿到引擎的 speak 回调（`apply` 把引擎给了 handle）。 */
function speakCallbackOf(handle) {
  return handle.engine.speak;
}

test('speak：网关发送成功时返回 true', async () => {
  const h = fakeCtx();
  const handle = await pluginModule.apply(h.ctx, {
    mode: 'http',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'x',
    actionTimeoutMs: 1000,
  });
  let called = null;
  handle.gateway.speakProactively = async (chatId, text) => {
    called = { chatId, text };
    return true;
  };
  const ok = await speakCallbackOf(handle)({ chatId: 'group:1', text: '你好' });
  assert.equal(ok, true);
  assert.deepEqual(called, { chatId: 'group:1', text: '你好' });
});

test('speak：网关返回 false 时**必须**返回 false 并落一条 warn', async () => {
  const h = fakeCtx();
  const handle = await pluginModule.apply(h.ctx, {
    mode: 'http',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'x',
    actionTimeoutMs: 1000,
  });
  // 模拟"目标不在白名单"或"发送失败"——speakProactively 用 false 表达
  handle.gateway.speakProactively = async () => false;

  const ok = await speakCallbackOf(handle)({ chatId: 'group:999', text: '不该发' });
  assert.equal(ok, false, '失败必须如实向上传，不能假装成功');
  assert.ok(
    h.logs.some(([level, msg]) => level === 'warn' && /没有发出/.test(String(msg))),
    `失败必须留下痕迹，实际日志：${JSON.stringify(h.logs.map((l) => `${l[0]}:${l[1]}`))}`,
  );
});

// ---------------------------------------------------------------- 汇报桥
//
// 两条规则，都来自用户的实测反馈与明确要求：
//
// 1. **QQ 通道的会话不汇报**。用户实测收到
//    「onebot-p 第 1 轮：完成 结论：（冒头）在的在的，测试收到」
//    —— 小鲸鱼自己在 QQ 上说的话被当成"工作"又播报了一遍。
//    根因：只排了 `qq-` 前缀，而 dsh-onebot-qq 的会话是 `onebot-` 前缀。
//
// 2. **只在该喊的时候喊**。用户原话：
//    「只在非常需要的时候，比如过了好几个小时一直挂着就等我点确定的时候喊我，
//      或者我出去的时候喊我」
//    —— 人就在电脑前时 DSH 界面看得见进度，推 QQ 是噪音。

/**
 * 造一个够用的 session 替身。
 *
 * 注意：**不要**用"有没有读过事件快照"当观察点。重构后统一由"读当前状态"
 * 来判定，快照总会读到一半，那个观察点既脆弱又测不到真正要紧的事。
 * 真正要紧的是「有没有真的发消息打扰用户」——见 `bridgeHarness` 的 `outbound`。
 */
function makeReportSession(id, { createdAt = Date.now(), events = [] } = {}) {
  return {
    id,
    snapshotEvents: () => events,
    deriveEventMessage: () => '{}',
    header: { id, cwd: '<workspace>', version: '0', createdAt },
  };
}

/**
 * 起一个只关心汇报桥的插件实例，并拦下出站消息。
 *
 * `outbound` 是唯一可信的"有没有打扰用户"证据：给 `gateway.speakProactively`
 * 打桩后，只有真的走到发送那一步才会留下记录。
 *
 * @param {object} [reportOverrides]
 * @param {Array<object>} [liveSessions] 给了就模拟宿主暴露 `sessions` 服务
 */
async function bridgeHarness(reportOverrides = {}, liveSessions) {
  const h = fakeCtx(liveSessions === undefined ? {} : { liveSessions });
  const handle = await pluginModule.apply(h.ctx, {
    mode: 'http',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'x',
    actionTimeoutMs: 1000,
    dmPolicy: 'allowlist',
    allowFrom: ['10000001'],
    report: { enabled: true, target: 'private:10000001', minIntervalMinutes: 0, ...reportOverrides },
  });
  assert.ok((h.handlers.get('session/event') ?? []).length > 0, 'apply 应注册 session/event 监听');

  /** 出站记录。 */
  const outbound = [];
  handle.gateway.speakProactively = async (chatId, text) => {
    outbound.push({ chatId, text });
    return true;
  };
  h.outbound = outbound;
  return h;
}

/** 造一个已记录的 turn/end 事件。 */
const turnEndEv = (kind, turn = 1, time = Date.now()) => ({
  type: 'turn/end',
  time,
  data: { turn, reason: { kind } },
});

const TURN_END = (kind) => turnEndEv(kind);

test('汇报桥：QQ 通道会话（qq- / onebot-）一律不产生出站', async () => {
  const h = await bridgeHarness();
  for (const id of [
    'qq-private-10000001',
    'qq-group-100',
    'onebot-group-200000001',
    'onebot-private-10000001',
  ]) {
    h.fire('session/event', makeReportSession(id), TURN_END('completed'));
  }
  assert.equal(h.outbound.length, 0, 'QQ 通道的会话不该产生任何出站消息');
});

test('汇报桥：普通完成**不**出声（人在电脑前看得见）', async () => {
  const h = await bridgeHarness();
  h.fire(
    'session/event',
    makeReportSession('session-work-1', { createdAt: Date.now() - 10 * 3600 * 1000 }),
    TURN_END('completed'),
  );
  assert.equal(h.outbound.length, 0, '任务完成不该推 QQ——那是噪音');
});

test('汇报桥：卡住等确认但还没等够久 → 不催', async () => {
  const h = await bridgeHarness({ waitingNotifyAfterMinutes: 90 });
  h.fire(
    'session/event',
    makeReportSession('session-work-2', { createdAt: Date.now() - 20 * 60 * 1000 }),
    TURN_END('blocked'),
  );
  assert.equal(h.outbound.length, 0, '只等了 20 分钟，不该催');
});

test('汇报桥：卡住等确认且已等够久 → 出声喊他', async () => {
  const h = await bridgeHarness({ waitingNotifyAfterMinutes: 90 });
  const since = Date.now() - 3 * 3600 * 1000;
  // 必须给真实事件：`buildWorkReport` 对空事件返回空串（没内容就不发），
  // 拿空事件当夹具会把"没内容所以不发"误判成"策略没放行"。
  const worked = [
    { type: 'tool/call', data: { turn: 7, step: 0, callId: 'c1', name: 'edit', arguments: '{}' } },
    { type: 'assistant/message', data: { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '改完了，等你确认。' }] } } },
    turnEndEv('blocked', 7, since),
  ];
  h.fire(
    'session/event',
    makeReportSession('session-work-3', { createdAt: since, events: worked }),
    turnEndEv('blocked', 7, since),
  );
  assert.equal(h.outbound.length, 1, '挂了 3 小时还在等确认，该喊他');
  assert.equal(h.outbound[0].chatId, 'private:10000001');
  assert.match(h.outbound[0].text, /第 7 轮/);
  assert.match(h.outbound[0].text, /work-3/, '要点出是哪个会话');
});

test('汇报桥：出错也算"卡住等我"，等够久就喊', async () => {
  const h = await bridgeHarness({ waitingNotifyAfterMinutes: 60 });
  const since = Date.now() - 2 * 3600 * 1000;
  const worked = [
    { type: 'tool/call', data: { turn: 3, step: 0, callId: 'c1', name: 'pwsh', arguments: '{}' } },
    turnEndEv('error', 3, since),
  ];
  h.fire(
    'session/event',
    makeReportSession('session-work-4', { createdAt: since, events: worked }),
    turnEndEv('error', 3, since),
  );
  assert.equal(h.outbound.length, 1, '出错卡住 2 小时，该喊');
});

test('汇报桥：awayMode 打开时普通完成也喊（我出门了）', async () => {
  const h = await bridgeHarness({ awayMode: true });
  const worked = [
    { type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{}' } },
    turnEndEv('completed', 1),
  ];
  h.fire('session/event', makeReportSession('session-work-5', { events: worked }), TURN_END('completed'));
  assert.equal(h.outbound.length, 1, '出门模式下完成要汇报');
});

test('汇报桥：onlyWhenBlocked=false 时退化成旧的"每轮都报"', async () => {
  const h = await bridgeHarness({ onlyWhenBlocked: false });
  const worked = [
    { type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{}' } },
    turnEndEv('completed', 1),
  ];
  h.fire('session/event', makeReportSession('session-work-6', { events: worked }), TURN_END('completed'));
  assert.equal(h.outbound.length, 1, '关掉门控后应恢复每轮汇报');
});

test('汇报桥：没内容的会话不发空消息', async () => {
  // buildWorkReport 对空事件返回空串是**有意的**：没内容就不发。
  const h = await bridgeHarness({ onlyWhenBlocked: false });
  h.fire('session/event', makeReportSession('session-empty'), TURN_END('completed'));
  assert.equal(h.outbound.length, 0, '空会话不该产生一条空消息');
});

// ---------------------------------------------------------------- 借聊天轮次巡检
//
// 用户设计的调度方式：「不需要在工作的时候挂着计时器，只需要聊天的时候，
// 聊天子会话汇报上来激活核心的时候顺便偶尔看一眼就行了，qq群不缺消息」

test('巡检：聊天会话轮次结束时会顺带看一眼工作会话（不挂计时器）', async () => {
  const since = Date.now() - 3 * 3600 * 1000;
  const stuck = makeReportSession('session-stuck-1', {
    createdAt: since,
    events: [turnEndEv('blocked', 5, since)],
  });
  const h = await bridgeHarness({ waitingNotifyAfterMinutes: 90 }, [stuck]);

  // 先确认此刻没有任何出站（还没触发）
  assert.equal(h.outbound.length, 0);

  // 群聊里来了一条消息 —— 这就是心跳
  h.fire('session/event', makeReportSession('onebot-group-200000001'), TURN_END('completed'));

  assert.equal(h.outbound.length, 1, '聊天轮次应顺带把卡住的工作会话喊出来');
  assert.match(h.outbound[0].text, /stuck-1|第 5 轮/);
});

test('巡检：没有卡住的会话时不发任何消息', async () => {
  const done = makeReportSession('session-done-1', {
    createdAt: Date.now() - 5 * 3600 * 1000,
    events: [turnEndEv('completed', 9)],
  });
  const h = await bridgeHarness({ waitingNotifyAfterMinutes: 90 }, [done]);
  h.fire('session/event', makeReportSession('onebot-group-200000001'), TURN_END('completed'));
  assert.equal(h.outbound.length, 0, '都干完了就别打扰');
});

test('巡检：多个卡住的会话聚成一条消息，而不是刷屏', async () => {
  const since = Date.now() - 4 * 3600 * 1000;
  const a = makeReportSession('session-aaaa1111', { createdAt: since, events: [turnEndEv('blocked', 1, since)] });
  const b = makeReportSession('session-bbbb2222', { createdAt: since, events: [turnEndEv('blocked', 2, since)] });
  const h = await bridgeHarness({ waitingNotifyAfterMinutes: 90 }, [a, b]);
  h.fire('session/event', makeReportSession('onebot-group-200000001'), TURN_END('completed'));
  assert.equal(h.outbound.length, 1, '两个会话应聚成一条，不是两条');
  assert.match(h.outbound[0].text, /2 个会话/);
});

test('巡检：宿主没暴露 sessions 服务时静默跳过，不抛异常', async () => {
  const h = await bridgeHarness({ waitingNotifyAfterMinutes: 90 }); // 不传 liveSessions
  assert.doesNotThrow(() => {
    h.fire('session/event', makeReportSession('onebot-group-200000001'), TURN_END('completed'));
  });
  assert.equal(h.outbound.length, 0);
});

test('inject 里绝不能出现只存在于 Web 部署的服务', () => {
  // 回归：曾经把 connection / webServer 写进模块级 inject（为了让设置页能挂上），
  // 结果纯 headless 部署里**整个插件挂起不激活**：
  //   qq-proactive (dsh-qq-proactive): pending (waiting for services: connection, webServer)
  // 端口都不开，QQ 通道完全不工作——为了一个可选功能把主体功能搭进去了。
  // 这两个服务必须走 `ctx.inject([...], cb)` 的条件加载。
  for (const optional of ['connection', 'webServer']) {
    assert.equal(
      inject.includes(optional),
      false,
      `${optional} 是可选服务，不能写进模块级 inject`,
    );
  }
});

test('不导出 Config —— 这是真机验证出来的硬约束', () => {
  // Cordis 的 resolveConfig 走的是 Standard Schema：
  //   if (!runtime.Config) return config;
  //   runtime.Config['~standard'].validate(config)
  // 导出一个普通对象会让它读到 undefined 的 '~standard'，插件直接拒绝激活：
  //   TypeError: Cannot read properties of undefined (reading 'validate')
  // 所以这里必须没有 Config 导出，校验全交给 resolveConfig。
  assert.equal(pluginModule.Config, undefined);
  assert.equal(typeof configShape, 'object', '形状仍以别的名字导出，供文档与测试用');
});

test('反向模式缺 accessToken 时拒绝（fail-closed）', () => {
  assert.throws(
    () => resolveConfig({ mode: 'reverse', accessToken: '' }),
    /反向模式必须配置 accessToken/,
  );
  assert.throws(() => resolveConfig({ mode: 'reverse' }), /accessToken/);
  assert.throws(() => resolveConfig({ mode: 'reverse', accessToken: 123 }), /accessToken/);
});

test('反向模式配了 token 就通过', () => {
  const cfg = resolveConfig({ mode: 'reverse', accessToken: 'secret' });
  assert.equal(cfg.mode, 'reverse');
  assert.equal(cfg.accessToken, 'secret');
  assert.equal(cfg.port, 8643, '端口应有默认值');
});

test('反向模式端口非法时报错', () => {
  for (const port of [0, -1, 70000, 'abc', 1.5]) {
    assert.throws(
      () => resolveConfig({ mode: 'reverse', accessToken: 't', port }),
      /port 非法/,
      `port=${JSON.stringify(port)}`,
    );
  }
});

test('mode 非法时报错', () => {
  assert.throws(() => resolveConfig({ mode: 'nonsense' }), /mode 必须是/);
});

test('configPagePort：默认 19390（不常见的固定端口），0 合法、越界/小数/非数字当场报错', () => {
  // 默认值：它决定"插件重载后配置页能不能原地接回"，所以要在测试里钉住。
  assert.equal(resolveConfig({ mode: 'reverse', accessToken: 't' }).configPagePort, 19390);
  // 0 = 关掉固定端口（回到每次随机的旧行为），合法。
  assert.equal(resolveConfig({ mode: 'reverse', accessToken: 't', configPagePort: 0 }).configPagePort, 0);
  assert.equal(
    resolveConfig({ mode: 'reverse', accessToken: 't', configPagePort: '20000' }).configPagePort,
    20000,
    '字符串数字照样收（YAML 里可能被引号包住）',
  );
  // ⚠️ 写错不能静默退化成随机端口 —— 那正是本改动要修的现象，不该再静默一次。
  for (const value of [-1, 70000, 1.5, 'abc']) {
    assert.throws(
      () => resolveConfig({ mode: 'reverse', accessToken: 't', configPagePort: value }),
      /configPagePort/,
      `configPagePort=${JSON.stringify(value)}`,
    );
  }
});

test('正向模式需要合法的 ws 地址', () => {
  assert.throws(() => resolveConfig({ mode: 'forward', url: 'http://x' }), /合法的 ws/);
  assert.throws(() => resolveConfig({ mode: 'forward', url: '' }), /合法的 ws/);
  const ok = resolveConfig({ mode: 'forward', url: 'ws://127.0.0.1:3001' });
  assert.equal(ok.url, 'ws://127.0.0.1:3001');
  // 正向模式不要求 token。
  assert.equal(resolveConfig({ mode: 'forward', url: 'ws://x:1' }).accessToken, '');
});

test('默认配置是保守的：群聊需 @、主动发言关闭', () => {
  const cfg = resolveConfig({ mode: 'reverse', accessToken: 't' });
  assert.equal(cfg.dmPolicy, POLICY.ADMIN);
  assert.equal(cfg.groupPolicy, POLICY.ADMIN);
  assert.equal(cfg.requireMention, true);
  assert.equal(cfg.proactive.enabled, false, '机会主义冒泡默认关闭');
  assert.equal(cfg.report.enabled, false, '工作汇报默认关闭');
  assert.ok(cfg.proactive.minIntervalMs >= 30_000, '两条之间要有间隔');
  // 注：这里原来还断言 `burstMinMessages >= 2`（"话题要先起来"）。那道闸门
  // 2026-10-07 已删，键虽然还在（向后兼容），但已经不是"保守默认"的一部分了。
});

test('静默时段 / 突发门槛：键还能解析，但闸门已删（2026-10-07）', () => {
  // ⚠️ 这两组键**刻意保留在配置形状里**：`qq-gugu.toml` 与 `cordis.patch.yml` 里
  // 都还写着它们，而本次改动的约定是**不碰那两个文件**（toml 只改一行 focusWindowMs）。
  // 但引擎已经不再读它们 —— 判定链里的 `quiet-hours` / `burst-too-small` 两道闸门删了
  // （"写了也不生效"由 `test/engine.test.mjs` 的行为用例钉住）。
  //
  // 这条测试守的是另一件事：**配置文件里残留这些键不能把插件弄挂**（向后兼容）。
  const cfg = resolveConfig({
    mode: 'reverse',
    accessToken: 't',
    proactive: { quietHoursStart: 0, quietHoursEnd: 7, burstMinMessages: 2 },
  });
  assert.equal(cfg.proactive.quietHoursStart, 0, '照旧解析，不报错');
  assert.equal(cfg.proactive.quietHoursEnd, 7);
  assert.equal(cfg.proactive.burstMinMessages, 2);
});

test('静默时段默认关闭（因为本部署是深夜活跃型）', () => {
  // 引擎里的老默认是 0~7 点闭嘴，但那个默认和用户的实际作息冲突：
  // 他自己的旧 MaiBot 配置里 `talk_value_rules` 是「00:00-08:59 → 0.8」，
  // **深夜反而更活跃**。实测默认值把凌晨的插话全拦了（调试日志里连着
  // 5 条 reason: "quiet-hours"），排查了好一会儿才发现。
  // 现在那道闸门整个删了（2026-10-07），这个 null 只是历史遗留的默认值。
  const cfg = resolveConfig({ mode: 'reverse', accessToken: 't' });
  assert.equal(cfg.proactive.quietHoursStart, null, '默认不该有静默时段');
  assert.equal(cfg.proactive.quietHoursEnd, null);
});

test('proactive / gauge / report 三段是深合并，不是整段替换', () => {
  const cfg = resolveConfig({
    mode: 'reverse',
    accessToken: 't',
    proactive: { enabled: true },
    // 只覆盖一个字段，其余必须保留默认（这才是"深合并"的意思）。
    // 刻意不复述具体数值：默认值会随校准调整，绑死数值会让这个测试变成
    // "每次调参都要改测试"，而它真正要守的是**合并语义**。
    gauge: { threshold: 41 },
  });
  assert.equal(cfg.proactive.enabled, true);
  assert.equal(cfg.proactive.maxPerHour, 6, '未覆盖的字段应保留默认');
  assert.equal(cfg.gauge.threshold, 41, '覆盖的字段应生效');
  assert.equal(typeof cfg.gauge.lookback, 'number', '未覆盖的字段应仍有默认值');
  assert.equal(cfg.gauge.frequency, defaultGaugeConfig().frequency, '未覆盖的字段应保留默认（对真源比，不写死数值）');
  assert.ok(Array.isArray(cfg.gauge.templates) && cfg.gauge.templates.length > 0);
});

test('gauge 校准值不被 CONFIG_SHAPE 顶掉', () => {
  // 这个坑踩过**两次**：`CONFIG_SHAPE.gauge` 的优先级高于 `defaultGaugeConfig()`，
  // 所以在那里重复写一份默认值，等于把 `heuristic-gauge.mjs` 里的校准结果顶掉。
  //   第一次 `threshold: 32` 顶掉 26；
  //   第二次 `threshold: 26` 顶掉 16，连 `templates` 都被顶回旧文案（用户看到
  //   `chars: 5` 的旧模板，而新模板是 6 个字）。
  //
  // 所以这里**对着真源比**：不写死数字，而是断言"resolveConfig 的结果与
  // defaultGaugeConfig() 一致 —— 除非用户显式覆盖"。
  const bare = resolveConfig({ mode: 'reverse', accessToken: 't' });
  const defaults = defaultGaugeConfig();
  for (const key of ['threshold', 'pressureFloor', 'pressureFull', 'maxPressure', 'maxPresencePenalty']) {
    assert.equal(
      bare.gauge[key],
      defaults[key],
      `gauge.${key} 被 CONFIG_SHAPE 顶掉了：resolveConfig=${bare.gauge[key]} vs 真源=${defaults[key]}`,
    );
  }
  assert.deepEqual(
    bare.gauge.templates,
    defaults.templates,
    '兜底模板也必须来自真源，否则措辞会被旧文案覆盖',
  );

  // 但用户显式覆盖仍然要生效。
  const overridden = resolveConfig({ mode: 'reverse', accessToken: 't', gauge: { threshold: 41 } });
  assert.equal(overridden.gauge.threshold, 41);
});

// ---------------------------------------------------------------- 攒劲儿（2026-10-14）
//
// 新键放在 `proactive` 段，**属于 `defaultTriggerConfig()` 那一层**（和 `judge_mode`
// 同一个性质：闸门之后、以跨消息历史为输入的时序状态，不是打分权重）。
// 这里钉住两件事：① 默认值来自真源；② 用户显式覆盖能生效。

test('★ 攒劲儿：三个新键在 [proactive] 段，默认值不与真源打架', () => {
  const bare = resolveConfig({ mode: 'reverse', accessToken: 't' });
  const defaults = defaultTriggerConfig();
  for (const key of ['decline_bonus', 'decline_bonus_cap', 'decline_bonus_min_gap_ms']) {
    assert.ok(key in configShape.proactive, `CONFIG_SHAPE.proactive 缺 ${key}`);
    assert.ok(key in bare.proactive, `resolveConfig 结果缺 proactive.${key}`);
    assert.equal(
      bare.proactive[key],
      configShape.proactive[key],
      `proactive.${key} 的默认值该来自 CONFIG_SHAPE（这一层不覆盖真源里的数值项）`,
    );
  }
  // ⚠️ 不变量：cap ≥ 阈值，否则"攒够了必然开口"不成立。
  assert.ok(
    configShape.proactive.decline_bonus_cap >= defaultGaugeConfig().threshold,
    `cap ${configShape.proactive.decline_bonus_cap} 必须 ≥ 阈值 ${defaultGaugeConfig().threshold}`,
  );
  assert.ok(defaults.decline_bonus_cap >= defaultGaugeConfig().threshold);

  // 用户显式覆盖仍然生效（否则 toml 里写什么都不管用）。
  const overridden = resolveConfig({
    mode: 'reverse',
    accessToken: 't',
    proactive: { decline_bonus: 9, decline_bonus_cap: 90, decline_bonus_min_gap_ms: 0 },
  });
  assert.equal(overridden.proactive.decline_bonus, 9);
  assert.equal(overridden.proactive.decline_bonus_cap, 90);
  assert.equal(overridden.proactive.decline_bonus_min_gap_ms, 0);
});

test('工作汇报开启时必须配合法的 target', () => {  assert.throws(
    () => resolveConfig({ mode: 'reverse', accessToken: 't', report: { enabled: true } }),
    /必须配 report.target/,
  );
  assert.throws(
    () =>
      resolveConfig({
        mode: 'reverse',
        accessToken: 't',
        report: { enabled: true, target: '群' },
      }),
    /必须配 report.target/,
  );
  assert.throws(
    () =>
      resolveConfig({
        mode: 'reverse',
        accessToken: 't',
        report: { enabled: true, target: 'channel:1' },
      }),
    /必须配 report.target/,
  );

  const ok = resolveConfig({
    mode: 'reverse',
    accessToken: 't',
    report: { enabled: true, target: 'group:123456' },
  });
  assert.equal(ok.report.target, 'group:123456');
});

test('工作汇报关闭时不校验 target', () => {
  const cfg = resolveConfig({ mode: 'reverse', accessToken: 't', report: { target: '' } });
  assert.equal(cfg.report.enabled, false);
});

test('configShape 是普通对象，不是 schema（避免引入 schemastery 依赖）', () => {
  assert.equal(typeof configShape, 'object');
  assert.equal(configShape.mode, 'reverse');
  assert.ok(configShape.proactive !== undefined);
  assert.equal(configShape['~standard'], undefined, '它不该长得像 Standard Schema');
  assert.equal(typeof configShape.validate, 'undefined');
});

test('resolveConfig 不修改传入的对象', () => {
  const raw = { mode: 'reverse', accessToken: 't', proactive: { enabled: true } };
  const snapshot = JSON.stringify(raw);
  resolveConfig(raw);
  assert.equal(JSON.stringify(raw), snapshot);
});

test('resolveConfig 不修改模块级 Config 常量', () => {
  const before = JSON.stringify(configShape.proactive);
  resolveConfig({ mode: 'reverse', accessToken: 't', proactive: { enabled: true } });
  assert.equal(JSON.stringify(configShape.proactive), before, '模块级默认值被污染会导致跨实例串味');
});

// ---------------------------------------------------------------- 群会话禁用工具的接线
//
// 「群里禁掉 pwsh、私聊不受影响」的**名单来源**这一段接线：
//
//   qq-gugu.toml [proactive] deny_tools_in_group   ← 行为配置（用户改这个）
//         ↓ 覆盖
//   cordis.patch.yml 的 denyToolsInGroup           ← 加载配置
//         ↓ 兜底
//   代码里的 DEFAULT_GROUP_DENY_TOOLS（['pwsh']）  ← **默认必须在代码里**
//
// ⚠️ 为什么这一组必须存在：默认值只写在文档/toml 里就等于没写 —— 用户环境那份
// `qq-gugu.toml` 不打算改动，所以"没写这个键"必须等于"默认禁 pwsh"。
// 这一组钉的正是**代码默认真的生效**、以及 toml 真的能覆盖它。
// 名单本身在 `binding.test.mjs` 里测（含 restrict 抛错时不崩）。

/** 写一份临时 toml（只含被测的段），返回路径。 */
function tempToml(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugutoml-'));
  const file = path.join(dir, 'qq-gugu.toml');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/** 起一个最小插件实例，取它交给 SessionBinder 的禁用名单。 */
async function denyToolsFromApply(rawConfig) {
  const { ctx } = fakeCtx();
  const handle = await pluginModule.apply(ctx, {
    mode: 'http',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'x',
    actionTimeoutMs: 1000,
    ...rawConfig,
  });
  return handle.binder.denyToolsInGroup;
}

test('群会话禁用工具：toml 里没这个键时，代码默认生效（默认必须在代码里）', async () => {
  const tomlPath = tempToml('[proactive]\nmaxPerHour = 5\n');
  assert.deepEqual(await denyToolsFromApply({ tomlPath }), ['pwsh']);
});

test('群会话禁用工具：toml 的 deny_tools_in_group 覆盖默认', async () => {
  const tomlPath = tempToml('[proactive]\ndeny_tools_in_group = ["pwsh", "read"]\n');
  assert.deepEqual(await denyToolsFromApply({ tomlPath }), ['pwsh', 'read']);
});

test('群会话禁用工具：toml 写空数组 = 明确不限制，不能被默认值顶掉', async () => {
  const tomlPath = tempToml('[proactive]\ndeny_tools_in_group = []\n');
  assert.deepEqual(await denyToolsFromApply({ tomlPath }), []);
});

test('群会话禁用工具：toml 写单个字符串也认（少一个坑）', async () => {
  const tomlPath = tempToml('[proactive]\ndeny_tools_in_group = "read"\n');
  assert.deepEqual(await denyToolsFromApply({ tomlPath }), ['read']);
});

test('群会话禁用工具：cordis 配置也能配；toml 是行为配置层，优先于它', async () => {
  const bare = tempToml('[proactive]\n');
  assert.deepEqual(await denyToolsFromApply({ tomlPath: bare, denyToolsInGroup: ['write'] }), ['write']);

  const layered = tempToml('[proactive]\ndeny_tools_in_group = ["read"]\n');
  assert.deepEqual(
    await denyToolsFromApply({ tomlPath: layered, denyToolsInGroup: ['write'] }),
    ['read'],
    'toml 该盖过 cordis 配置（人格/门槛/工具名单是同一套分层）',
  );
});

test('群会话禁用工具：名单里的坏项在上桥前就被过滤掉', async () => {
  const tomlPath = tempToml('[proactive]\ndeny_tools_in_group = [" pwsh ", "", "pwsh", 5]\n');
  assert.deepEqual(await denyToolsFromApply({ tomlPath }), ['pwsh']);
});

test('群会话禁用工具：挂载日志里带得出名单（"限制到底装没装"要能一眼看见）', async () => {
  const { ctx, logs } = fakeCtx();
  const tomlPath = tempToml('[proactive]\ndeny_tools_in_group = ["pwsh", "read"]\n');
  await pluginModule.apply(ctx, {
    mode: 'http',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'x',
    actionTimeoutMs: 1000,
    tomlPath,
  });
  const mounted = logs.find((l) => String(l[1]).includes('已挂载'));
  assert.ok(mounted !== undefined, '该有一条挂载日志');
  assert.deepEqual(mounted[2]?.denyToolsInGroup, ['pwsh', 'read']);
});

// ==========================================================================
// 2026-10-07：图片原件目录（配置化）与描述缓存表
// ==========================================================================

test('★ 配置默认：原件目录**只含 {qq} 占位**，缓存表在 <DSH_HOME>\\ 下', () => {
  const cfg = resolveConfig({ mode: 'reverse', accessToken: 't' });
  assert.ok(Array.isArray(cfg.imageOriginalDirs));
  assert.ok(cfg.imageOriginalDirs.length > 0);
  for (const dir of cfg.imageOriginalDirs) {
    assert.match(dir, /\{qq\}/, `模板 ${dir} 必须用 {qq}（账号绝不硬编码）`);
  }
  // 表放 <DSH_HOME>/media 下
  assert.equal(cfg.imageDescCachePath, path.join(dshHome(), 'media', 'qq-image-desc.json'));
});

test('★ 配置校验：imageOriginalDirs 必须是**字符串数组**、imageDescCachePath 必须是字符串', () => {
  // 写成字符串会静默变成"逐字符遍历" → 本地查找永远落空，而日志里只有"没找到"。
  // 这个项目反复栽在**静默不生效**上，所以当场报错。
  assert.throws(
    () => resolveConfig({ mode: 'reverse', accessToken: 't', imageOriginalDirs: 'D:\\x\\{qq}' }),
    /imageOriginalDirs 必须是字符串数组/,
  );
  assert.throws(
    () => resolveConfig({ mode: 'reverse', accessToken: 't', imageOriginalDirs: ['D:\\ok', 42] }),
    /imageOriginalDirs 必须是字符串数组/,
  );
  assert.throws(
    () => resolveConfig({ mode: 'reverse', accessToken: 't', imageDescCachePath: 123 }),
    /imageDescCachePath 必须是字符串/,
  );

  // 合法值能过，且空数组/空串是**明确关掉**（不是"用默认"）
  assert.deepEqual(
    resolveConfig({ mode: 'reverse', accessToken: 't', imageOriginalDirs: [] }).imageOriginalDirs,
    [],
  );
  assert.equal(
    resolveConfig({ mode: 'reverse', accessToken: 't', imageDescCachePath: '' }).imageDescCachePath,
    '',
  );
});

test('挂载日志带上原件目录条数与缓存表路径（排查"本地查找为什么没用"的第一眼）', async () => {
  const { ctx, logs } = fakeCtx();
  await pluginModule.apply(ctx, {
    mode: 'http',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'x',
    actionTimeoutMs: 1000,
    imageOriginalDirs: ['D:\\a\\{qq}', 'D:\\b\\{qq}'],
    imageDescCachePath: '<DSH_HOME>\\media\\x.json',
  });
  const mounted = logs.find((l) => String(l[1]).includes('已挂载'));
  assert.ok(mounted !== undefined);
  assert.equal(mounted[2]?.imageOriginalDirs, 2);
  assert.equal(mounted[2]?.imageDescCachePath, '<DSH_HOME>\\media\\x.json');
});

// ==========================================================================
// 2026-10-08：表情包库（偷 + 存）的配置契约
// ==========================================================================

test('★ 配置默认：表情包库在 <DSH_HOME>/media 下，且"偷"默认开着', () => {
  const cfg = resolveConfig({ mode: 'reverse', accessToken: 't' });
  const media = path.join(dshHome(), 'media');
  assert.equal(cfg.stickerDir, path.join(media, 'stickers'), '库目录默认在 <DSH_HOME>/media 下');
  assert.equal(cfg.stickerIndexPath, path.join(media, 'qq-stickers.json'), '索引表同处（与 qq-image-desc.json 一个目录）');
  assert.equal(cfg.stickerSteal, true, '默认开 —— 用户的原话就是要它"偷"');
});

test('★ 配置校验：stickerDir / stickerIndexPath 必须是字符串（写错的代价是静默不干活）', () => {
  assert.throws(
    () => resolveConfig({ mode: 'reverse', accessToken: 't', stickerDir: 42 }),
    /stickerDir 必须是字符串/,
  );
  assert.throws(
    () => resolveConfig({ mode: 'reverse', accessToken: 't', stickerIndexPath: ['a'] }),
    /stickerIndexPath 必须是字符串/,
  );
  // 空串是**明确关掉**那一半（不是"用默认值"）
  assert.equal(resolveConfig({ mode: 'reverse', accessToken: 't', stickerDir: '' }).stickerDir, '');
  assert.equal(resolveConfig({ mode: 'reverse', accessToken: 't', stickerSteal: false }).stickerSteal, false);
});

test('挂载日志带上表情包库的开关与两个路径（"偷没偷到"第一个要看的三个值）', async () => {
  const { ctx, logs } = fakeCtx();
  await pluginModule.apply(ctx, {
    mode: 'http',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'x',
    actionTimeoutMs: 1000,
    stickerSteal: false,
    stickerDir: '<DSH_HOME>\\media\\my-stickers',
    stickerIndexPath: '<DSH_HOME>\\media\\my-stickers.json',
  });
  const mounted = logs.find((l) => String(l[1]).includes('已挂载'));
  assert.ok(mounted !== undefined);
  assert.equal(mounted[2]?.stickerSteal, false);
  assert.equal(mounted[2]?.stickerDir, '<DSH_HOME>\\media\\my-stickers');
  assert.equal(mounted[2]?.stickerIndexPath, '<DSH_HOME>\\media\\my-stickers.json');
  assert.equal(mounted[2]?.stickerLibSize, 0, '库条数也要能看到');
});

test('★ apply 不该碰磁盘上的表情包库（只读索引；没偷到东西就不建目录）', async () => {
  // 这条是防"挂载即写盘"：构造库只读索引，harvest 才写。
  // 用一个指向不存在路径的索引 + 目录，挂载后两者都不该被创建出来。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-mount-'));
  const dir = path.join(root, 'stickers');
  const { ctx } = fakeCtx();
  await pluginModule.apply(ctx, {
    mode: 'http',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'x',
    actionTimeoutMs: 1000,
    stickerDir: dir,
    stickerIndexPath: path.join(root, 'i.json'),
  });
  assert.equal(fs.existsSync(dir), false, '挂载不该建库目录');
  assert.equal(fs.existsSync(path.join(root, 'i.json')), false, '挂载不该写索引');
});

// ==========================================================================
// 2026-10-08：表情包入库审核闸的 toml 契约（[sticker_gate]）
//
// 用户拍板三条决定了这一节：
//   ① 「审核闸需要在 toml 里有一块放提示词的位置」→ 提示词从 toml 读；
//   ② 「nsfw 分开来…默认 4 分以下才能接纳…不知道模型本身倾向，只能自己测试调整」
//      → 四项阈值可调；
//   ③ 真人照片「直接砍」→ 没有阈值（判定层写死，这一节里没有它的旋钮）。
//
// ⚠️ 这组测试盯的是**"配置写了到底生效没有"**：这个项目最贵的一类坑是
// "配置写了、计数正常、什么都没发生"，所以**回退与夹紧都必须留痕**。
// ==========================================================================

test('★ [sticker_gate]：toml 里没这一节 ⇒ 回退默认值，而且**必须留一条 warn**', async () => {
  const { ctx, logs } = fakeCtx();
  const tomlPath = tempToml('[proactive]\nmaxPerHour = 5\n');
  await pluginModule.apply(ctx, {
    mode: 'http', httpUrl: 'http://127.0.0.1:1', accessToken: 'x', actionTimeoutMs: 1000, tomlPath,
  });
  const gate = pluginModule.loadStickerGate({ tomlPath }, () => {});
  assert.equal(gate.prompt, '', '默认提示词留空 ⇒ 代码兜底（DEFAULT_STICKER_PROMPT）');
  assert.equal(gate.nsfwMax, 4);
  assert.equal(gate.violenceMax, 4);
  assert.equal(gate.goreMax, 4);
  assert.equal(gate.uglyMax, 4);
  // 2026-10-09：funny 是唯一一项**方向相反**的阈值；captionMaxChars 从 5 提到 120（降级成兜底红线）
  assert.equal(gate.funnyMin, 3);
  assert.equal(gate.captionMaxChars, 120);
  // 2026-10-10：`maxTokens` 是「认」那次调用的输出预算。**默认还是 420**（不改行为）。
  assert.equal(gate.maxTokens, 420, '默认 420 —— 加这个旋钮时行为一个字节都不变');
  assert.equal(gate.provider, '', '留空 = 沿用 imageDescriber 那条云视觉路径');
  assert.equal(gate.model, '');
  // 回退本身也要能被看见（静默回退 = 用户以为自己在调的旋钮其实没接上）
  const warned = logs.find((l) => l[0] === 'warn' && String(l[1]).includes('sticker_gate'));
  assert.ok(warned !== undefined, '缺这一节该有一条 warn');
});

test('★★ [sticker_gate]：真的从 toml 读到提示词与各项阈值（含 funnyMin）', () => {
  const tomlPath = tempToml([
    '[sticker_gate]',
    'prompt = """',
    '只输出一个 JSON 对象。{intro}',
    '配文例子：帽子上的 JOJO 不算。',
    '"""',
    'provider = "local-llamacpp"',
    'model = "qwen3.5-4b-q4km"',
    'nsfwMax = 2',
    'violenceMax = 3',
    'goreMax = 1',
    'uglyMax = 9',
    'funnyMin = 5',
    'captionMaxChars = 8',
    '',
  ].join('\n'));
  const gate = pluginModule.loadStickerGate({ tomlPath }, () => {});
  assert.equal(gate.nsfwMax, 2);
  assert.equal(gate.violenceMax, 3);
  assert.equal(gate.goreMax, 1);
  assert.equal(gate.uglyMax, 9);
  assert.equal(gate.funnyMin, 5, 'funnyMin 必须能从 toml 读到（它是"有趣度下限"那个旋钮）');
  assert.equal(gate.captionMaxChars, 8);
  assert.equal(gate.provider, 'local-llamacpp');
  assert.equal(gate.model, 'qwen3.5-4b-q4km');
  // 提示词**整段**读到了（不是"非空"就算）
  assert.ok(gate.prompt.includes('只输出一个 JSON 对象'), '多行字符串要完整读进来');
  assert.ok(gate.prompt.includes('JOJO'), '配文判据的那一段也要在');
  assert.ok(!gate.prompt.endsWith('\n'), '末尾那个换行不该混进提示词（它会让占位符判空出错）');

  // 而且它真的会被拿去问模型（不是读进来搁着）
  const instruction = buildStickerInstruction({ gate });
  assert.ok(instruction.includes('JOJO'), 'toml 的提示词真的进了这一次调用');
  assert.ok(!instruction.includes('{intro}'), '占位符要被填掉（留着就是让模型看花括号）');
  assert.ok(instruction.includes('这是一张 QQ 表情包。'), '{intro} 填的是单帧开场');
});

test('★★ [sticker_gate]：enableThinking 从 toml 一路进到描述器与挂载日志（含"不是布尔"的回退留痕）', async () => {
  // ⭐ 2026-10-10：思考开关。默认 false = 加它之前的行为（那次调用照旧 reasoningEffort='off'）。
  const tomlPath = tempToml([
    '[sticker_gate]',
    'provider = "local-llamacpp"',
    'model = "qwen3.5-4b-q4km"',
    'enableThinking = true',
    '',
  ].join('\n'));
  const { ctx, logs } = fakeCtx();
  const handle = await pluginModule.apply(ctx, {
    mode: 'http', httpUrl: 'http://127.0.0.1:1', accessToken: 'x', actionTimeoutMs: 1000, tomlPath,
  });
  const gate = handle.gateway.imageDescriber.stats().stickerGate;
  assert.equal(gate.enableThinking, true, '⭐ 调试快照里必须能看到 enableThinking（否则"toml 写了到底读到没有"只能翻代码）');
  const mounted = logs.find((l) => String(l[1]).includes('表情包审核闸已加载'));
  assert.ok(mounted !== undefined, '挂载时该说清楚审核闸读到了什么');
  assert.equal(mounted[2]?.enableThinking, true, '⭐ 挂载日志里必须带 enableThinking（排查时的第一观测点）');

  // ⚠️ 不是布尔（写成了字符串）⇒ 回退默认值，**而且必须留一条 warn**
  //    （"配置写了却静默回退"是这个项目最贵的一类坑，同一族已踩过三次）。
  const badPath = tempToml('[sticker_gate]\nenableThinking = "true"\n');
  const badLogs = [];
  const bad = pluginModule.loadStickerGate({ tomlPath: badPath }, (level, message, meta) => badLogs.push({ level, message, meta }));
  assert.equal(bad.enableThinking, false, '认不出 ⇒ 回退默认值 false（**不是**猜成 true）');
  const warned = badLogs.find((l) => l.level === 'warn' && String(l.message).includes('enableThinking'));
  assert.ok(warned !== undefined, '⚠️ 非法值必须留痕 —— 否则用户以为开关接上了，其实按默认值在跑');
  assert.equal(warned.meta?.wrote, 'true');
  assert.equal(warned.meta?.using, false, 'warn 里要同时给出"写了什么"和"实际用什么"');
});

test('★★ [sticker_gate]：越界的数被夹到边界，而且**逐个打 warn**（夹紧不许静默）', () => {
  const tomlPath = tempToml([
    '[sticker_gate]',
    'nsfwMax = 40',        // > 满分 ⇒ 夹到 10
    'uglyMax = -2',        // < 0 ⇒ 夹到 0
    'funnyMin = 999',      // ⭐ 2026-10-09 加的：它一度**漏在这个键名列表外** ⇒ 静默夹紧（不留 warn）
    'captionMaxChars = 9999',
    'maxTokens = 999999',  // ⭐ 2026-10-10 加的：**同一个坑的第三次** —— 加它就等于加进这个列表
    'violenceMax = 4',     // 合法值不该报警
    '',
  ].join('\n'));
  const logs = [];
  const gate = pluginModule.loadStickerGate({ tomlPath }, (level, message, meta) => logs.push({ level, message, meta }));
  assert.equal(gate.nsfwMax, 10);
  assert.equal(gate.uglyMax, 0);
  assert.equal(gate.funnyMin, 10, 'funnyMin 越界也要夹到满分');
  assert.equal(gate.captionMaxChars, 200);
  assert.equal(gate.maxTokens, 8192, 'maxTokens 越界夹到自己的上界（不是满分区间的 10）');
  assert.equal(gate.violenceMax, 4);
  const keys = logs.filter((l) => l.level === 'warn').map((l) => l.meta?.wrote);
  assert.deepEqual(keys, [40, -2, 999, 9999, 999999], '**五个**越界值各要一条 warn，合法值不要吵');
  assert.ok(
    logs.some((l) => l.level === 'warn' && String(l.message).includes('funnyMin')),
    '⚠️ funnyMin 越界**必须**留痕 —— 静默夹紧 = 用户以为自己在调一个根本没接上的旋钮',
  );
  assert.ok(
    logs.some((l) => l.level === 'warn' && String(l.message).includes('maxTokens')),
    '⚠️ maxTokens 也一样：它越小越危险（JSON 被截断 ⇒ 静默拒图），夹紧更要留痕',
  );
  for (const l of logs) {
    assert.ok(typeof l.meta.using === 'number', 'warn 里要同时给出"写了什么"和"实际用什么"');
  }
});

test('★ [sticker_gate]：非法值（不是数）回退默认，同样留痕；读不到 toml 也不抛', () => {
  const tomlPath = tempToml('[sticker_gate]\nnsfwMax = "abc"\n');
  const logs = [];
  const gate = pluginModule.loadStickerGate({ tomlPath }, (level, message, meta) => logs.push({ level, message, meta }));
  assert.equal(gate.nsfwMax, 4, '认不出就用默认');
  assert.equal(logs.length, 1);

  // 路径不存在 ⇒ 回退 + warn，但**绝不抛**（配置文件写错不该让小鲸鱼起不来）
  const logs2 = [];
  const missing = pluginModule.loadStickerGate({ tomlPath: 'H:\\nope\\nope.toml' }, (l, m, meta) => logs2.push({ l, m, meta }));
  assert.equal(missing.nsfwMax, 4);
  assert.equal(logs2.length, 1);
  assert.equal(logs2[0].l, 'warn');
});

test('★★ 接线：审核闸的参数从 toml 一路进到描述器（"到底生效没有"的直接证据）', async () => {
  const tomlPath = tempToml([
    '[sticker_gate]',
    'prompt = """',
    '这是一段很长很长很长的自定义提示词，用来证明它真的被读进去了。',
    '"""',
    'provider = "local-llamacpp"',
    'model = "qwen3.5-4b-q4km"',
    'nsfwMax = 1',
    'funnyMin = 6',
    'captionMaxChars = 9',
    'maxTokens = 2000',
    '',
  ].join('\n'));
  const { ctx, logs } = fakeCtx();
  const handle = await pluginModule.apply(ctx, {
    mode: 'http', httpUrl: 'http://127.0.0.1:1', accessToken: 'x', actionTimeoutMs: 1000, tomlPath,
  });
  const gate = handle.gateway.imageDescriber.stats().stickerGate;
  assert.equal(gate.provider, 'local-llamacpp');
  assert.equal(gate.model, 'qwen3.5-4b-q4km');
  assert.equal(gate.nsfwMax, 1);
  assert.equal(gate.funnyMin, 6, '⭐ 调试快照里必须能看到 funnyMin（否则"它生效没有"查不到）');
  assert.equal(gate.captionMaxChars, 9);
  assert.equal(gate.maxTokens, 2000, '⭐ 调试快照里必须能看到 maxTokens（切模型时忘了抬它是静默拒图）');
  assert.equal(gate.promptFromToml, true);
  assert.ok(gate.promptChars > 20, '读到的提示词长度要能看出来（截断/读错文件都会明显偏小）');

  // 挂载日志里也要有一份 —— 排查"闸门到底按哪套阈值在跑"的第一眼
  const mounted = logs.find((l) => String(l[1]).includes('表情包审核闸已加载'));
  assert.ok(mounted !== undefined, '挂载时该说清楚审核闸读到了什么');
  assert.equal(mounted[2]?.promptFromToml, true);
  assert.equal(mounted[2]?.nsfwMax, 1);
  assert.equal(mounted[2]?.funnyMin, 6, '⭐ 挂载日志里少一个旋钮 = "它到底读到没有"只能靠翻代码回答');
  assert.equal(mounted[2]?.captionMaxChars, 9);
  assert.equal(mounted[2]?.maxTokens, 2000, '⭐ 挂载日志里必须带 maxTokens');
  assert.equal(mounted[2]?.provider, 'local-llamacpp');
});

