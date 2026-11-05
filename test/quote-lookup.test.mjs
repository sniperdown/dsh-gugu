/**
 * 引用原文的 `get_msg` 兜底（2026-11-04）。
 *
 * 要修的病：引用的是**小鲸鱼自己发的**消息时，提示词里只剩
 * 「（原文没找到 —— 引用的是一条 id 为 … 的消息，它不在最近的对话记录里）」。
 * 根因不在格式化：`engine.decide()` 对 `fromSelf` 早退（`transcript.push(message)`
 * 之前就 return）⇒ **她自己说过的话根本不进转录**，按 id 永远查不到。
 *
 * 所以补一条退化路径：转录里没有 ⇒ 在**已有的反向 WS 连接**上问一次
 * `get_msg`（`transport.request`），拿到就按 `renderEntries` 那套渲染。
 *
 * 这份用例钉住的**不是"能不能取回"**（真机能不能取回只能等真实引用出现，
 * 我们没法从外部测 NapCat），而是四条不许退化的性质：
 *   ① 转录里有的 ⇒ **一次都不问**（绝大多数引用走这条，代价必须为零）；
 *   ② 转录里没有的 ⇒ 问一次，且**只问一次**（缓存）；
 *   ③ 问不到（超时/报错/空）⇒ 退回原来那行"原文没找到"，**不抛**；
 *   ④ 带 `echo` 的回包**不会**被当成消息事件派发出去。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Gateway, OUTCOME } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';
import { OneBotTransport, STATE } from '../src/onebot/transport.mjs';

const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);
/** 真机形状：`reply` 段里的 `id` 是**字符串**，`message_id` 是数字。 */
const GHOST_ID = '1627760367';

/**
 * 装一套网关：真 protocol/router/engine + 假 transport。
 *
 * 假 transport 的 `request` 是这次要测的那个口子 —— 记下每一次调用
 * （action / params / 超时），返回 `options.request` 给的东西。
 * 不传 `request` ⇒ 这根假传输层**没有**这个能力（老形状），用来验"没有也得活"。
 */
function harness(options = {}) {
  const transport = {
    selfId: '999',
    sent: [],
    calls: [],
    on() {},
    off() {},
    emit() {},
    async sendToChat(chatId, message) {
      this.sent.push({ chatId, message });
      return this.sent.length;
    },
  };
  if (options.hasRequest !== false) {
    transport.request = async (action, params, opts) => {
      transport.calls.push({ action, params, opts });
      return options.request === undefined
        ? null
        : options.request(action, params, opts, transport.calls.length);
    };
  }
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.OPEN,
    requireMention: true,
    adminUsers: ['9001'],
  });
  const responded = [];
  const logs = [];
  const engine = new ProactiveEngine({
    config: { enabled: false, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0, afterUserMsgCount: 1 },
    gauge: async () => ({ speak: true, text: '冒泡' }),
    speak: async () => undefined,
    log: () => undefined,
    now: () => T0,
  });
  const gateway = new Gateway({
    transport,
    router,
    engine,
    responder: async (request) => {
      responded.push(request);
      return `回复${responded.length}`;
    },
    outboundAllow: () => false,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    ...(options.gateway ?? {}),
  });
  gateway.attach();
  return { gateway, transport, responded, logs };
}

/** 一条私聊事件（默认「引用 GHOST_ID，然后说这句话」）。 */
function dmQuote({ id = GHOST_ID, messageId = 900001, text = '这个不行', at = T0 } = {}) {
  return {
    time: Math.floor(at / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId,
    user_id: 2001,
    message: [
      { type: 'reply', data: { id } },
      { type: 'text', data: { text } },
    ],
    raw_message: `[CQ:reply,id=${id}]${text}`,
    sender: { nickname: '阿猫' },
  };
}

/** `get_msg` 的真机形状（NapCat：`message` 是段数组，`time` 是**秒**）。 */
function getMsgPayload(overrides = {}) {
  return {
    message_id: Number(GHOST_ID),
    message_type: 'private',
    user_id: 999,
    sender: { user_id: 999, nickname: '小鲸鱼' },
    time: Math.floor(T0 / 1000) - 60,
    message: [{ type: 'text', data: { text: '我上午说的那句' } }],
    raw_message: '我上午说的那句',
    ...overrides,
  };
}

// ------------------------------------------------------- ① 转录里有 ⇒ 一次都不问

test('转录里能找到被引用的那条 ⇒ 一次都不调 get_msg（代价必须为零）', async () => {
  const h = harness();
  // 被引用那条先进转录（私聊每条都派发 ⇒ 它一定在快照里）
  await h.gateway.handleEvent({
    ...dmQuote({ messageId: 700001, text: '原来那句' }),
    message: [{ type: 'text', data: { text: '原来那句' } }],
    raw_message: '原来那句',
  });
  const before = h.transport.calls.length;
  await h.gateway.handleEvent(dmQuote({ id: '700001' }));
  assert.equal(h.transport.calls.length, before, '转录命中时一次都不许问');
  assert.match(h.responded.at(-1).prompt, /原来那句/);
});

// ------------------------------------------------- ② 转录里没有 ⇒ 问一次并渲染原文

test('★ 转录里没有 ⇒ 调一次 get_msg，并渲染出被引用的原文', async () => {
  const h = harness({ request: () => getMsgPayload() });
  const result = await h.gateway.handleEvent(dmQuote());
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.transport.calls.length, 1, '退化路径问一次');
  assert.equal(h.transport.calls[0].action, 'get_msg');
  assert.equal(h.transport.calls[0].params.message_id, Number(GHOST_ID), 'id 要转成数字');
  // 超时必须用**查询专用**的那个小值，不能继承发送路径的 15 秒。
  assert.ok(
    Number.isFinite(h.transport.calls[0].opts?.timeoutMs) && h.transport.calls[0].opts.timeoutMs <= 1500,
    `超时该是小值，实际 ${String(h.transport.calls[0].opts?.timeoutMs)}`,
  );
  const prompt = h.responded[0].prompt;
  assert.match(prompt, /^本条消息引用了这条消息：/, '抬头与转录命中时逐字相同');
  // 格式必须和转录里同一套：`[HH:MM 昵称(QQ): 正文]`
  assert.match(prompt, /^\[(?:\d{2}-\d{2} )?\d{2}:\d{2}\] 小鲸鱼\(999\): 我上午说的那句$/m);
  assert.ok(!prompt.includes('原文没找到'), '拿到了就不该再报"原文没找到"');
});

test('★ 同一个 id 引用两次 ⇒ 只请求一次（缓存）', async () => {
  const h = harness({ request: () => getMsgPayload() });
  await h.gateway.handleEvent(dmQuote({ messageId: 900001 }));
  await h.gateway.handleEvent(dmQuote({ messageId: 900002 }));
  assert.equal(h.transport.calls.length, 1, '同一个 id 只问一次');
  assert.match(h.responded[1].prompt, /我上午说的那句/);
});

test('get_msg 回来的段里有图片/表情/未知类型 ⇒ 各给一个占位符，不崩', async () => {
  const h = harness({
    request: () =>
      getMsgPayload({
        message: [
          { type: 'text', data: { text: '看这个 ' } },
          { type: 'image', data: { file: 'a.jpg', url: 'https://example.invalid/a.jpg' } },
          { type: 'mface', data: { summary: '[动画表情]' } },
          { type: 'weird_segment', data: {} },
        ],
        raw_message: '看这个 [CQ:image,file=a.jpg]',
      }),
  });
  const result = await h.gateway.handleEvent(dmQuote());
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  const prompt = h.responded[0].prompt;
  assert.match(prompt, /小鲸鱼\(999\): 看这个 \[图片\]/, '图片段要有占位符，不能吃掉或炸掉');
  assert.ok(prompt.includes('[weird_segment]'), '不认识的段也要有占位，不能静默消失');
});

// ------------------------------------------------------ ③ 问不到 ⇒ 退回"原文没找到"

test('get_msg 返回 null（超时/对端不认）⇒ 退回"原文没找到"那一行，且不抛', async () => {
  const h = harness({ request: () => null });
  const result = await h.gateway.handleEvent(dmQuote());
  assert.equal(result.outcome, OUTCOME.DISPATCHED, '拿不到原文不许影响这一轮');
  const prompt = h.responded[0].prompt;
  assert.match(prompt, /^本条消息引用了这条消息：/);
  assert.match(prompt, /（原文没找到 —— 引用的是一条 id 为 1627760367 的消息，它不在最近的对话记录里）/);
});

test('get_msg 抛异常 / 返回残缺数据 ⇒ 同样静默退回，不抛', async () => {
  const cases = [
    () => { throw new Error('boom'); },
    async () => { throw new Error('超时（1200ms）'); },
    () => ({}),
    () => ({ message_id: 1, message: [] }),
    () => ({ message_id: 1, user_id: 999, message: [{ type: 'text', data: { text: '' } }] }),
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const h = harness({ request: cases[i] });
    const result = await h.gateway.handleEvent(dmQuote({ id: `77${i}`, messageId: 900100 + i }));
    assert.equal(result.outcome, OUTCOME.DISPATCHED);
    assert.match(h.responded[0].prompt, /原文没找到/);
  }
});

test('传输层压根没有 request（老形状）⇒ 一个字节都不改，退回"原文没找到"', async () => {
  const h = harness({ hasRequest: false });
  const result = await h.gateway.handleEvent(dmQuote());
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.match(h.responded[0].prompt, /原文没找到/);
});

test('失败也会被缓存：同一个 id 第二次不再等（负数缓存）', async () => {
  const h = harness({ request: () => null });
  await h.gateway.handleEvent(dmQuote({ messageId: 900001 }));
  await h.gateway.handleEvent(dmQuote({ messageId: 900002 }));
  assert.equal(h.transport.calls.length, 1, '问不到也算"问过"，别每轮白等 1.2 秒');
});

// --------------------------------------- ④ 带 echo 的回包不能当消息事件派发出去

/** 一条握手完成、可写的假连接（不需要真 socket）。 */
function readyTransport() {
  const transport = new OneBotTransport({ accessToken: 'x' });
  const sent = [];
  transport.connection = { closed: false, send: (payload) => { sent.push(payload); return true; } };
  transport.state = STATE.READY;
  const events = [];
  transport.on('event', (event) => events.push(event));
  return { transport, sent, events };
}

test('★ 带 echo 的回包（哪怕同时带 post_type）不会被当成消息事件派发', () => {
  const { transport, events } = readyTransport();
  transport.handleFrame(JSON.stringify({
    echo: 'nobody-waits',
    post_type: 'message',
    message_type: 'private',
    message_id: 1,
    user_id: 2001,
    message: [{ type: 'text', text: '迟到的回包' }],
  }));
  assert.equal(events.length, 0, 'echo 帧一律是回包，不许进事件分发');
});

test('没有 echo 的正常事件照旧派发（这一支没被上面那条挡住）', () => {
  const { transport, events } = readyTransport();
  transport.handleFrame(JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    message_id: 1,
    user_id: 2001,
    message: [{ type: 'text', text: '正常消息' }],
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].message_id, 1);
});

test('request()：没人回包 ⇒ 超时后返回 null（不 reject）', async () => {
  const { transport, sent } = readyTransport();
  const data = await transport.request('get_msg', { message_id: 1 }, { timeoutMs: 30 });
  assert.equal(data, null);
  assert.equal(sent.length, 1, '确实发出去了一帧');
  assert.equal(JSON.parse(sent[0]).action, 'get_msg');
});

test('request()：未就绪 ⇒ 立刻返回 null，不排队干等', async () => {
  const transport = new OneBotTransport({ accessToken: 'x' });
  const started = Date.now();
  const data = await transport.request('get_msg', { message_id: 1 }, { timeoutMs: 5000 });
  assert.equal(data, null);
  assert.ok(Date.now() - started < 500, '没连上就立刻放弃');
});

test('request()：回包按 echo 归位，拿到 data', async () => {
  const { transport, sent } = readyTransport();
  const promise = transport.request('get_msg', { message_id: 7 }, { timeoutMs: 500 });
  // `action()` 在返回 promise 之前就同步发帧了 ⇒ 这里直接读发出去那一帧的 echo。
  const echo = JSON.parse(sent[0]).echo;
  transport.handleFrame(JSON.stringify({ status: 'ok', retcode: 0, echo, data: { message_id: 7 } }));
  assert.deepEqual(await promise, { message_id: 7 });
  assert.equal(transport.pending.size, 0, '回包到达后不许留在途表');
});
