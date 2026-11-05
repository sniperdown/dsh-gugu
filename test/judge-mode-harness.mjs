/**
 * `judge_mode` 三种模式的**共用测试装置**（2026-10-13）。
 *
 * 为什么单独一个文件：`test/judge-mode.test.mjs` 与
 * `_qq-judge/probe-three-modes.mjs`（报告里的证据脚本）要用**同一套**装置 ——
 * 两套各写一遍的话，"测试里跑通的"与"报告里贴出来的"可以是两条不同的链，
 * 那报告就不算证据了。
 *
 * ⚠️ 文件名以 `-harness.mjs` 结尾：`tools/run-all-tests.mjs` 只扫 `*.test.mjs`，
 * 所以它不会被当成一个"没有测试的文件"。
 *
 * ⚠️ **纯离线**：`transport.sendToChat` 只往数组里 push，`stream` 是脚本化的假货
 * ⇒ 跑这个装置**一条真 QQ 消息都不会发**。
 */
import { EventEmitter } from 'node:events';

import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';
import { JUDGE_MODE_HEURISTIC, createPrecheck } from '../src/dsh/judge-mode.mjs';

export const T0 = Date.UTC(2026, 9, 13, 9, 20, 0);

/** 打分器桩：**明确的 speak:true + 分数**，用来把"过阈值"变成确定条件。 */
export function gaugeStub({
  speak = true,
  score = 161.6,
  threshold = 50,
  detail = { relevance: 0, content: -16.2, presence: 177.8, questions: 0, techHits: 2 },
} = {}) {
  return async () => (speak
    ? { speak: true, text: '这个我看看', score, threshold, detail }
    : { speak: false, score, threshold, detail });
}

/** 假传输层：只记，不发。 */
export function makeTransport() {
  const emitter = new EventEmitter();
  const sent = [];
  return {
    selfId: '999',
    sent,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async sendToChat(chatId, message) { sent.push({ chatId, message }); return sent.length; },
    async sendGroupMsg(g, m) { return this.sendToChat(`group:${g}`, m); },
    async sendPrivateMsg(u, m) { return this.sendToChat(`private:${u}`, m); },
  };
}

/**
 * 假的 `ctx.llm.stream` —— 记下**每一次**调用的参数，按脚本吐字。
 * `script` 里放 `Error` = 那次调用抛错；放数字 = 一直不吐字（模拟超时）。
 */
export function makeStream(script = ['该']) {
  const calls = [];
  let i = 0;
  const fn = (opts) => {
    const answer = script[Math.min(i, script.length - 1)];
    i += 1;
    calls.push({ opts, answer });
    return (async function* gen() {
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'number') {
        await new Promise((resolve) => setTimeout(resolve, answer));
        return;
      }
      yield { type: 'text-delta', text: String(answer) };
    })();
  };
  fn.calls = calls;
  return fn;
}

/**
 * 装一套网关：真 protocol/router/engine + 假 transport/responder/stream。
 */
export function harness(options = {}) {
  const transport = makeTransport();
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.OPEN,
    requireMention: true,
    adminUsers: ['9001'],
  });
  const logs = [];
  const responded = [];
  const gaugeCalls = [];

  const engine = new ProactiveEngine({
    config: {
      enabled: true,
      minIntervalMs: 0,
      maxPerHour: 1000,
      cooldownAfterBotMs: 0,
      // ⚠️ **必须是 2**：这条门槛是"累计够几条才允许第一次冒泡"。
      // 取 1 的话**第一条**消息就放行并起 agent ⇒ 每个用例都会多跑一轮
      // （第一版就是这么写的，结果所有"只调一次"的断言都变成 2）。
      afterUserMsgCount: 2,
      ...(options.engineConfig ?? {}),
    },
    judgeMode: options.judgeMode ?? JUDGE_MODE_HEURISTIC,
    gauge: async (request) => {
      gaugeCalls.push(request);
      const decision = await (options.gauge ?? gaugeStub())();
      if (decision === null) return null;
      decision.judgeMode = options.judgeMode ?? JUDGE_MODE_HEURISTIC;
      return decision;
    },
    speak: async () => undefined,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => T0,
  });

  const stream = options.stream ?? makeStream();
  const precheck = createPrecheck({
    stream: options.stream === null ? null : stream,
    provider: options.precheckProvider ?? 'deepseek-official',
    model: options.precheckModel ?? 'deepseek-flash',
    timeoutMs: options.precheckTimeoutMs ?? 50,
    retry: options.precheckRetry ?? 0,
    // 心情（2026-10-15）：`chatId → 一句心情`。不传 = 没有心情（与接线前逐字节一致）。
    moodFor: options.moodFor ?? null,
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const gateway = new Gateway({
    transport,
    router,
    engine,
    precheck,
    judgeMode: options.judgeMode ?? JUDGE_MODE_HEURISTIC,
    // 私聊单独一套（2026-11-01）：不传 = 空串 = 跟随 `judgeMode`（与接线前等价）。
    judgeModePrivate: options.judgeModePrivate ?? '',
    responder: async (request) => {
      responded.push(request);
      if (options.responder) return options.responder(request, responded.length);
      return '回复';
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });
  gateway.attach();
  return { gateway, transport, router, engine, precheck, stream, logs, responded, gaugeCalls };
}

let seq = 0;

/** 一条**私聊**消息事件（2026-11-01：用来验"私聊单独一套判定模式"）。 */
export function privateEvent(overrides = {}) {
  seq += 1;
  return {
    time: Math.floor(T0 / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 7000 + seq,
    user_id: 2003,
    message: [{ type: 'text', text: '在吗' }],
    raw_message: '在吗',
    sender: { nickname: '阿猫' },
    ...overrides,
  };
}

/** 一条群消息事件（默认是"没人点小鲸鱼"的那条）。 */
export function groupEvent(overrides = {}) {
  seq += 1;
  return {
    time: Math.floor(T0 / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 5000 + seq,
    group_id: 100,
    user_id: 2003,
    message: [{ type: 'text', text: '诶这个 port 怎么改啊' }],
    raw_message: '诶这个 port 怎么改啊',
    sender: { nickname: '阿猫', card: '群名片猫' },
    ...overrides,
  };
}

/** 发两条：第一条只用来过"预热门槛"，第二条才是被测的那一条。 */
export async function sendTwo(h, overrides = {}) {
  await h.gateway.handleEvent(groupEvent(overrides));
  return h.gateway.handleEvent(groupEvent(overrides));
}

