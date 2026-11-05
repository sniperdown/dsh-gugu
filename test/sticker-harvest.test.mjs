/**
 * 「偷表情包」在**网关里的接线**：什么时候叫库、什么时候**不叫**。
 *
 * ## 为什么单独一组（而不是塞进 sticker-library 的测试）
 *
 * `sticker-library.test.mjs` 测的是库自己（判据、落盘、去重、坏库降级）。
 * 这一组测的是**网关有没有把它接对**，而"接对"里最要紧的一条是**位置**：
 *
 * - 在**出站白名单内**的会话 → 偷（这是我们被允许参与的对话）；
 * - `ACTION.OBSERVE`（不在出站白名单里的会话）→ **一个字节都不偷**
 *   —— 从我们无权说话的群里攒图是隐私上的越界，不是"顺便多攒点"。
 *
 * 另一条是不能拖垮主链路：偷是 fire-and-forget，库抛异常也**不该影响回复**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Gateway, OUTCOME } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

const T0 = Date.UTC(2026, 9, 7, 7, 0, 0);

/** 真表情包形状（2026-10-07 15:38:58 那条，原文照抄）。 */
function stickerSegment() {
  return {
    type: 'image',
    summary: '[动画表情]',
    file: '67-674cbcb1606d656525fb8615f2648198.gif',
    url: 'https://gxh.vip.qq.com/club/item/parcel/item/67/674cbcb1606d656525fb8615f2648198/raw300.gif',
    emoji_id: '674cbcb1606d656525fb8615f2648198',
    emoji_package_id: 240387,
  };
}

/**
 * **普通图**形状（照片/截图）—— `sub_type: 0`。
 *
 * ⚠️ 2026-10-08 纠正：上一批这里写的是 `sub_type: 1` 并叫它"普通图"，
 * 而用户看着图确认那几张是**他从「我的表情」面板发的**。
 * 现在 `sub_type: 0` 才是"普通图"（判据不收的那一类）。
 */
function photoSegment() {
  return {
    type: 'image',
    summary: '',
    file: 'x.jpg',
    sub_type: 0,
    url: 'https://gchat.qpic.cn/gchatpic_new/0/0-0-AAA/0',
    file_size: '103122',
  };
}

function groupEvent(message, { groupId = 200000001, userId = 10000001, messageId = 1 } = {}) {
  return {
    time: Math.floor(T0 / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: groupId,
    user_id: userId,
    raw_message: '',
    font: 0,
    sender: { user_id: userId, nickname: '用户', card: '' },
    message,
  };
}

function harness({ library = null, respond = '回复' } = {}) {
  const emitter = new EventEmitter();
  const sent = [];
  const transport = {
    selfId: '999',
    sent,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async sendToChat(chatId, message) { sent.push({ chatId, message }); return sent.length; },
  };
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.ALLOWLIST,
    groupAllowFrom: ['200000001'],
    requireMention: false,
    adminUsers: ['10000001'],
  });
  const engine = new ProactiveEngine({
    config: { enabled: true, minIntervalMs: 0, maxPerHour: 99, cooldownAfterBotMs: 0, afterUserMsgCount: 0 },
    gauge: async () => ({ speak: true }),
    speak: async () => undefined,
    now: () => T0,
  });
  const gateway = new Gateway({
    transport,
    router,
    engine,
    responder: async () => respond,
    log: () => {},
    stickerLibrary: library,
  });
  gateway.attach();
  return { gateway, transport, router, engine };
}

/** 记下 `harvest` 收到了什么的假库。 */
function spyLibrary({ impl } = {}) {
  const calls = [];
  const empty = {
    stored: 0, dedup: 0, nearMiss: 0, skipped: 0, failed: 0,
    rejected: 0, auditFailed: 0, unrecognized: 0, tooLarge: 0,
  };
  return {
    calls,
    async harvest(segments, meta) {
      calls.push({ segments, meta });
      if (impl !== undefined) return impl(segments, meta);
      return { ...empty };
    },
    pathOf: () => null,
    recordUse: () => true,
    stats: () => ({ index: { size: 0 } }),
    all: () => [],
  };
}

test('★ 白名单内的群消息 → 网关把消息段交给库去偷', async () => {
  const library = spyLibrary();
  const h = harness({ library });
  const result = await h.gateway.handleEvent(groupEvent([
    { type: 'text', data: { text: '看这个' } },
    stickerSegment(),
  ]));
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(library.calls.length, 1);
  // 段数组是**原始段**（含 emoji_id）—— 判定在库里做，网关不预筛
  assert.equal(library.calls[0].segments.some((s) => s.emoji_id !== undefined), true);
  assert.deepEqual(library.calls[0].meta, { chatId: 'group:200000001', userId: '10000001' });
});

test('★★ 不在出站白名单里的群（OBSERVE）→ **连库都不碰**（隐私边界）', async () => {
  const library = spyLibrary();
  const h = harness({ library });
  const result = await h.gateway.handleEvent(
    groupEvent([{ type: 'text', data: { text: 'x' } }, stickerSegment()], { groupId: 999999999 }),
  );
  assert.equal(result.outcome, OUTCOME.OBSERVED);
  assert.deepEqual(library.calls, [], '我们无权说话的群，一个字节都不偷');
});

test('★ 偷不 await：库慢也不会拖住这一轮的回复', async () => {
  let resolved = false;
  const library = spyLibrary({
    impl: () => new Promise((resolve) => {
      setTimeout(() => { resolved = true; resolve({ stored: 1, dedup: 0, nearMiss: 0, skipped: 0, failed: 0, rejected: 0, auditFailed: 0, unrecognized: 0, tooLarge: 0 }); }, 50);
    }),
  });
  const h = harness({ library });
  const result = await h.gateway.handleEvent(groupEvent([
    { type: 'text', data: { text: '你好' } }, stickerSegment(),
  ]));
  assert.equal(result.outcome, OUTCOME.DISPATCHED, '回复照常');
  assert.equal(resolved, false, 'handleEvent 不该等偷图跑完');
  assert.equal(h.transport.sent.length, 1, '回复确实发出去了');
});

test('★ 库抛异常 → 消息处理照常完成（偷不是单点故障）', async () => {
  const library = spyLibrary({ impl: async () => { throw new Error('库炸了'); } });
  const h = harness({ library });
  const result = await h.gateway.handleEvent(groupEvent([
    { type: 'text', data: { text: '你好' } }, stickerSegment(),
  ]));
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.transport.sent.length, 1);
});

test('★ 没有注入库（老部署/测试环境）→ 一切照旧，不炸', async () => {
  const h = harness({ library: null });
  const result = await h.gateway.handleEvent(groupEvent([
    { type: 'text', data: { text: '你好' } }, stickerSegment(),
  ]));
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.transport.sent.length, 1);
});

test('普通图（`sub_type: 0`）也会被交给库 —— 判定只在库里做一次，别在网关里预筛', async () => {
  // ⚠️ 这条是**刻意的**：网关不做"这是不是表情包"的判断。
  // 判据只有一处（`sticker-library.mjs` 的 `stickerEvidence`），
  // 两处判定迟早漂移，而漂移的方向恰恰是"把普通图当表情包"。
  const library = spyLibrary();
  const h = harness({ library });
  await h.gateway.handleEvent(groupEvent([photoSegment()]));
  assert.equal(library.calls.length, 1);
});
