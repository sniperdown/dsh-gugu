/**
 * **`@某人` 渲染成 `@昵称`** —— 整条链路的回归测试（2026-10-14）。
 *
 * ## 用户提的问题（原话）
 *
 * > 「现在 `@` 渲染成纯 QQ 号，比如 `@30000002`。**模型认不出那是谁** ——
 * >  连"@ 的是它自己"都认不出。」
 *
 * 根因不是渲染代码写错了，而是**没有名字可用**：NapCat 的 at 段只有 `{qq}`。
 * 所以这条功能的形状是「**自己攒表 + 渲染时查表 + 查不到退回 `@QQ号`**」，
 * 而这份用例要钉住的正是这三段**各自**都接上了：
 *
 * | 段 | 断了会怎样 |
 * |---|---|
 * | `formatAtSegment` 查表 | 表里有名字也不用，照样 `@QQ号` |
 * | `normalizeEvent` 往下传 | 群聊正文里照样 `@QQ号`（**主路径**） |
 * | `rich.mjs` 往下传 | 转发里的 `@` 照样 `@QQ号`（递归层最容易漏传） |
 * | `history-backfill` 学 + 查 | 重载后要等新消息才认得出人 |
 * | `gateway` 学（**含自己的消息**） | `@30000002` 永远变不成 `@小鲸鱼` |
 *
 * ⚠️ **退化行为必须保留**（用户明确要求「别改成别的」）：
 * 查不到 ⇒ `@QQ号`；连 QQ 都没有 ⇒ 裸 `@`。单独几条用例钉住它。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  AT_ALL_TEXT,
  formatAtSegment,
  normalizeEvent,
  segmentsToText,
  toSegments,
} from '../src/onebot/protocol.mjs';
import { expandRichText } from '../src/onebot/rich.mjs';
import { createNicknameTable } from '../src/dsh/nicknames.mjs';
import { fetchHistory, historyMessageText } from '../src/dsh/history-backfill.mjs';
import { Gateway, OUTCOME } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

const SELF = '30000002';
const T0 = Date.UTC(2026, 9, 14, 2, 0, 0);

/** 临时表（绝不碰 `<DSH_HOME>`）。 */
function makeTable(tag, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qqat-${tag}-`));
  return createNicknameTable({ config: { file: path.join(dir, 'qq-nicknames.json'), ...config } });
}

/** 一个"已经认识几个人"的表（形状取自真机历史，见 `_qq-judge/nick-probe-summary.txt`）。 */
function knownTable(tag) {
  const table = makeTable(tag);
  table.learnBatch([
    { userId: SELF, nickname: '小鲸鱼', card: '', groupId: '30000012' },
    { userId: '30000001', nickname: '用户', card: '', groupId: '30000012' },
    { userId: '30000021', nickname: '用户A', card: '', groupId: '30000012' },
    { userId: '30000021', nickname: '用户A', card: '本群名片A', groupId: '30000011' },
  ]);
  return table;
}

// ────────────────────────────────────────────────── protocol：查表与退化

test('★ `formatAtSegment`：表里有名字 ⇒ `@昵称`，而不是 `@QQ号`', () => {
  const seg = { type: 'at', qq: SELF };
  // 改前（没有表）：只有 QQ 号
  assert.equal(formatAtSegment(seg), `@${SELF}`, '⚠️ 没有表时**必须**还是老行为（用户要求保留）');
  // 改后（有表）：昵称
  const resolveAt = () => '小鲸鱼';
  assert.equal(formatAtSegment(seg, { resolveAt, groupId: '30000012' }), '@小鲸鱼');
});

test('查不到 / 表抛异常 / 表返回空 ⇒ **一律退回 `@QQ号`**（绝不许把正文弄没）', () => {
  assert.equal(formatAtSegment({ type: 'at', qq: '123' }, { resolveAt: () => '' }), '@123');
  assert.equal(formatAtSegment({ type: 'at', qq: '123' }, { resolveAt: () => undefined }), '@123');
  assert.equal(
    formatAtSegment({ type: 'at', qq: '123' }, { resolveAt: () => { throw new Error('表坏了'); } }),
    '@123',
    '表坏了只该让这次渲染退化，绝不该抛出去',
  );
  // 连 QQ 都没有的畸形段：裸 `@`（老行为）
  assert.equal(formatAtSegment({ type: 'at' }, { resolveAt: () => '不该被调用' }), '@');
});

test('段自带的昵称**仍然优先于**表（别的实现会给 name，那是更权威的信息）', () => {
  assert.equal(
    formatAtSegment({ type: 'at', qq: '123', name: '段里带的名' }, { resolveAt: () => '表里的名' }),
    '@段里带的名',
  );
});

test('`@全体成员` 不受影响（它不是一个人，也不查表）', () => {
  let called = 0;
  const resolveAt = () => { called += 1; return '全体成员'; };
  assert.equal(formatAtSegment({ type: 'at', qq: 'all' }, { resolveAt }), AT_ALL_TEXT);
  assert.equal(called, 0, '`all` 不该去查表');
});

test('查表时**群号要传下去**（两层表靠它区分"哪个群的名片"）', () => {
  const seen = [];
  const resolveAt = (qq, groupId) => { seen.push([qq, groupId]); return ''; };
  segmentsToText([{ type: 'at', qq: '7' }], { resolveAt, groupId: 'g42' });
  assert.deepEqual(seen, [['7', 'g42']]);
});

test('`segmentsToText` 带表 ⇒ 整句渲染正确（含分隔空格）', () => {
  const segs = toSegments([
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: ' 在吗' } },
  ]);
  assert.equal(segmentsToText(segs), `@${SELF} 在吗`);
  assert.equal(segmentsToText(segs, { resolveAt: () => '小鲸鱼', groupId: '30000012' }), '@小鲸鱼 在吗');
});

// ────────────────────────────────────────────────── normalizeEvent：主路径

test('★ `normalizeEvent`：群消息里的 `@30000002` → `@小鲸鱼`（这是模型真正看到的那条路）', () => {
  const table = knownTable('normalize');
  const event = {
    time: Math.floor(T0 / 1000),
    self_id: Number(SELF),
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 1,
    group_id: 30000012,
    user_id: 30000001,
    raw_message: `[CQ:at,qq=${SELF}] 在吗`,
    sender: { user_id: 30000001, nickname: '用户', card: '' },
    message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 在吗' } }],
  };
  const withTable = normalizeEvent(event, { resolveAt: (qq, gid) => table.resolve(qq, gid) });
  assert.equal(withTable.text, '@小鲸鱼 在吗');
  // 改前
  const withoutTable = normalizeEvent(event);
  assert.equal(withoutTable.text, `@${SELF} 在吗`);
  // `mentioned` 语义一个字都没变（判定层不受影响）
  assert.equal(withTable.mentioned, true);
  assert.equal(withoutTable.mentioned, true);
});

test('`normalizeEvent`：群名片按**本群**取，私聊只用全局昵称（两层表接对了）', () => {
  const table = knownTable('scope');
  const resolveAt = (qq, gid) => table.resolve(qq, gid);
  const base = {
    time: Math.floor(T0 / 1000),
    post_type: 'message',
    sub_type: 'normal',
    message_id: 2,
    user_id: 30000021,
    sender: { user_id: 30000021, nickname: '用户A', card: '本群名片A' },
    message: [{ type: 'at', data: { qq: 30000021 } }, { type: 'text', data: { text: ' 看看' } }],
  };
  const inGroupA = normalizeEvent(
    { ...base, message_type: 'group', group_id: 30000011, self_id: Number(SELF) },
    { resolveAt },
  );
  assert.equal(inGroupA.text, '@本群名片A 看看', '在 30000011 ⇒ 用那个群的群名片');
  // 同一个 QQ 换个群（表里那个群没有名片）⇒ 回落全局昵称
  const inGroupB = normalizeEvent(
    { ...base, message_type: 'group', group_id: 30000012, self_id: Number(SELF) },
    { resolveAt },
  );
  assert.equal(inGroupB.text, '@用户A 看看');
});

// ────────────────────────────────────────────────── rich：转发/卡片那一层

test('★ `expandRichText`：**转发里**的 `@` 段也查得到名字（递归层最容易漏传）', () => {
  const segments = [{
    type: 'forward',
    data: {
      content: [{
        user_id: '30000001',
        sender: { nickname: '用户', card: '' },
        message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 处理一下' } }],
      }],
    },
  }];
  const without = expandRichText(segments);
  assert.match(without, new RegExp(`@${SELF}`), '不传表 ⇒ 老行为');
  const withTable = expandRichText(segments, { resolveAt: () => '小鲸鱼', groupId: '30000012' });
  assert.match(withTable, /@小鲸鱼/, '传了表 ⇒ 转发里的 @ 也要带上名字');
});

// ────────────────────────────────────────────────── history-backfill：灌历史时学 + 查

/** 一条历史接口形态的消息（`{type, data}`）。 */
function historyMsg(seq, { userId = '2001', nickname = '阿猫', card = '', at = T0 - 60_000, extra = [] } = {}) {
  return {
    message_id: 1000 + seq,
    user_id: userId,
    time: Math.floor(at / 1000),
    message: [{ type: 'text', data: { text: `第${seq}条` } }, ...extra],
    sender: { user_id: userId, nickname, card },
  };
}

test('★ 灌历史：**既学名字、又用它渲染**（重载后能自愈的那条路）', async () => {
  const table = makeTable('backfill');
  const call = async () => ({
    messages: [
      // NapCat 给的顺序是**从新到旧**
      historyMsg(3, { userId: '2001', nickname: '阿猫', at: T0 - 60_000 }),
      // 自己发的：`ignoreSelf` 会把它挡在转录外，**但名字必须学到**（`@30000002` → `@小鲸鱼`）
      {
        message_id: 1002,
        user_id: Number(SELF),
        time: Math.floor((T0 - 120_000) / 1000),
        message: [{ type: 'text', data: { text: '我说的话' } }],
        sender: { user_id: Number(SELF), nickname: '小鲸鱼', card: '' },
      },
      historyMsg(1, {
        userId: '2001',
        nickname: '阿猫',
        at: T0 - 180_000,
        extra: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 看看这个' } }],
      }),
    ],
  });
  const fetched = await fetchHistory({ chatId: 'group:200000001', call, selfId: SELF, nicknames: table });
  assert.equal(table.resolve(SELF, '200000001'), '小鲸鱼', '自己发的消息里的 sender 也要学进去');
  const texts = fetched.messages.map((m) => m.text);
  assert.ok(
    texts.some((t) => t.includes('@小鲸鱼 看看这个')),
    `历史的 @ 段要渲染成 @小鲸鱼，实际 ${JSON.stringify(texts)}`,
  );
});

test('灌历史：表坏了/不给表 ⇒ 静默退回 `@QQ号`（灌历史本身绝不受影响）', async () => {
  const boom = { learnBatch() { throw new Error('表炸了'); }, resolve() { return ''; } };
  const call = async () => ({
    messages: [historyMsg(1, { extra: [{ type: 'at', data: { qq: '999' } }] })],
  });
  const fetched = await fetchHistory({ chatId: 'group:200000001', call, selfId: SELF, nicknames: boom });
  assert.equal(fetched.messages[0].text, '第1条@999', '表抛异常 ⇒ 退化成 @QQ号，灌历史照常');
  // `historyMessageText` 的第二个参数是可选的新增项（老调用点不受影响）
  assert.equal(historyMessageText({ raw_message: '看这个[CQ:at,qq=999]' }), '看这个@999');
});

// ────────────────────────────────────────────────── gateway：入站时学（含被忽略的自己）

/** 假传输层。 */
function makeTransport(selfId = SELF) {
  const emitter = new EventEmitter();
  const sent = [];
  return {
    selfId,
    sent,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    async sendToChat(chatId, message) { sent.push({ chatId, message }); return sent.length; },
  };
}

/** 一套最小网关（真 protocol / router / engine，只有 transport 与会话是假的）。 */
function gatewayHarness(table) {
  const transport = makeTransport();
  const router = new Router({ dmPolicy: POLICY.OPEN, groupPolicy: POLICY.OPEN, requireMention: true });
  const prompts = [];
  const engine = new ProactiveEngine({
    config: { enabled: false, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0 },
    gauge: async () => ({ speak: false, text: '' }),
    speak: async () => {},
    log: () => {},
    now: () => T0,
  });
  const gateway = new Gateway({
    transport,
    router,
    engine,
    outboundAllow: null,
    responder: async (request) => { prompts.push(request.prompt); return '收到'; },
    log: () => {},
    nicknames: table,
  });
  gateway.attach();
  return { gateway, engine, prompts };
}

const groupEvent = (overrides = {}) => ({
  time: Math.floor(T0 / 1000),
  self_id: Number(SELF),
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  message_id: 1,
  group_id: 30000012,
  user_id: 30000001,
  raw_message: '在吗',
  sender: { user_id: 30000001, nickname: '用户', card: '' },
  message: [{ type: 'text', text: '在吗' }],
  ...overrides,
});

test('★ 网关：**小鲸鱼自己发的消息**也要学名字（哪怕那条消息被 `ignoreSelf` 丢掉）', async () => {
  const table = makeTable('gateway-learn-self');
  const h = gatewayHarness(table);
  try {
    // 小鲸鱼自己发的一条 —— `normalizeEvent` 会返回 null（自循环防护），
    // 但 `handleEvent` 里的 `learn` **在归一化之前**，所以名字学得到。
    const r = await h.gateway.handleEvent(groupEvent({
      message_id: 1,
      user_id: Number(SELF),
      sender: { user_id: Number(SELF), nickname: '小鲸鱼', card: '' },
      message: [{ type: 'text', text: '我说的' }],
    }));
    assert.equal(r.outcome, OUTCOME.IGNORED, '自己的消息照旧不处理（这条没变）');
    assert.equal(table.resolve(SELF, '30000012'), '小鲸鱼', '但名字必须学到');
  } finally {
    h.gateway.stop();
  }
});

test('★ 网关：别人 @小鲸鱼 ⇒ 送进会话的正文是 `@小鲸鱼`（端到端，模型真正看到的那一行）', async () => {
  const table = makeTable('gateway-at');
  // 先让表认识小鲸鱼自己（真实情况下这一步来自"小鲸鱼说过话"）
  table.learn({ userId: SELF, nickname: '小鲸鱼', card: '', groupId: '30000012' });
  const h = gatewayHarness(table);
  try {
    const r = await h.gateway.handleEvent(groupEvent({
      message_id: 2,
      message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', text: ' 在吗' }],
      raw_message: `[CQ:at,qq=${SELF}] 在吗`,
    }));
    assert.equal(r.outcome, OUTCOME.DISPATCHED, `@ 了小鲸鱼就该派发，实际 ${JSON.stringify(r)}`);
    const entry = h.engine.transcript('group:30000012').snapshot().at(-1);
    assert.equal(entry.text, '@小鲸鱼 在吗', '转录里那一行必须是 @小鲸鱼');
    assert.match(h.prompts.at(-1), /@小鲸鱼 在吗/, '提示词里也必须是 @小鲸鱼');
  } finally {
    h.gateway.stop();
  }
});

test('网关：没给表 ⇒ 一切照旧（`@QQ号`），而且绝不抛', async () => {
  const h = gatewayHarness(null);
  try {
    const r = await h.gateway.handleEvent(groupEvent({
      message_id: 3,
      message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', text: ' 在吗' }],
      raw_message: `[CQ:at,qq=${SELF}] 在吗`,
    }));
    assert.equal(r.outcome, OUTCOME.DISPATCHED);
    const entry = h.engine.transcript('group:30000012').snapshot().at(-1);
    assert.equal(entry.text, `@${SELF} 在吗`);
  } finally {
    h.gateway.stop();
  }
});

test('网关：学的动作**抛异常也不影响处理这条消息**（热路径自己吞异常）', async () => {
  const exploding = {
    learn() { throw new Error('表整个炸了'); },
    resolve() { throw new Error('查也炸'); },
  };
  const h = gatewayHarness(exploding);
  try {
    const r = await h.gateway.handleEvent(groupEvent({
      message_id: 4,
      message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', text: ' 在吗' }],
      raw_message: `[CQ:at,qq=${SELF}] 在吗`,
    }));
    assert.equal(r.outcome, OUTCOME.DISPATCHED, '表炸了也要照常处理消息');
    const entry = h.engine.transcript('group:30000012').snapshot().at(-1);
    assert.equal(entry.text, `@${SELF} 在吗`, '查表抛异常 ⇒ 退化成 @QQ号');
  } finally {
    h.gateway.stop();
  }
});
