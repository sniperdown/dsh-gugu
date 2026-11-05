/**
 * `[不说话]`（2026-11-02）：**主路径**也要认这个标记。
 *
 * 用户这一轮定的规矩：`[不说话]` 是通用的「这轮不发 QQ」标识符。
 * - 不想说话 ⇒ 只回 `[不说话]`，正文不发；
 * - 已经用 `send_qq` 发过 ⇒ 正文写 `[不说话]`，压掉重复的自动发送。
 *
 * ## 三条必须钉住的判据
 * 1. **正例**：整条就是标记（可带括号/空白）⇒ 一个字都不发到 QQ；
 * 2. **反例**：正文里顺口提到「不说话」⇒ **照常发**（`includes` 全匹配会丢内容，
 *    这个坑 `free-time.mjs` 的 quietMark 注释里记着）；
 * 3. 与 `send_qq` 那条路**并存**：工具发过的正文不再自动发，但 `toolSent` 要留痕。
 *
 * ⚠️ **纯离线**：transport 只往数组里 push，一条真 QQ 消息都不会发。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Gateway, isQuietMark } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { createOutboundAllow } from '../src/dsh/outbound-allow.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

const T0 = Date.UTC(2026, 10, 1, 23, 0, 0);
const CHAT_ID = 'private:2001';
const SESSION_KEY = 'qq-private-2001';
const RELAY_ALLOW = createOutboundAllow({ allowFrom: ['2001'], groupAllowFrom: ['100'] });

function harness(options = {}) {
  const transport = {
    selfId: '999',
    sent: [],
    on: () => {},
    off: () => {},
    emit: () => {},
    async sendToChat(chatId, message) {
      this.sent.push({ chatId, message });
      return this.sent.length;
    },
  };
  const logs = [];
  const ledgerRows = [];
  const engine = new ProactiveEngine({
    config: {
      enabled: false,
      minIntervalMs: 0,
      maxPerHour: 10,
      cooldownAfterBotMs: 0,
      afterUserMsgCount: 1,
    },
    gauge: async () => ({ speak: true, text: 'x' }),
    speak: async () => undefined,
    log: () => {},
    now: () => T0,
  });
  let gateway = null;
  gateway = new Gateway({
    transport,
    router: new Router({
      dmPolicy: POLICY.OPEN,
      groupPolicy: POLICY.OPEN,
      requireMention: true,
      adminUsers: ['9001'],
    }),
    engine,
    outboundAllow: RELAY_ALLOW,
    responder: async (request) => {
      if (typeof options.beforeRespond === 'function') await options.beforeRespond(gateway, request);
      return options.reply ?? '回复正文';
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    maxReplyChars: 2000,
    autoReply: options.autoReply ?? 'fallback',
    outboundLedger: { record: (row) => ledgerRows.push(row) },
  });
  gateway.attach();
  return { gateway, transport, engine, logs, ledgerRows };
}

function message() {
  return {
    chatId: CHAT_ID,
    kind: 'private',
    userId: '2001',
    nickname: '阿猫',
    text: '在吗',
    at: T0,
    mentioned: true,
    replyToSelf: false,
    segments: [{ type: 'text', text: '在吗' }],
    raw: '在吗',
  };
}

function sentTexts(transport) {
  return transport.sent.map((entry) => (typeof entry.message === 'string'
    ? entry.message
    : (Array.isArray(entry.message)
      ? entry.message.map((seg) => (seg?.type === 'text' ? String(seg.data?.text ?? '') : '')).join('')
      : String(entry.message))));
}

// ------------------------------------------------------------ 判定口径本身

test('isQuietMark 正例：整条就是标记（可带括号/空白）⇒ true', () => {
  for (const text of ['[不说话]', '（不说话）', '【不说话】', ' ( 不说话 ) ', '这次不说话', '不说话']) {
    assert.equal(isQuietMark(text), true, `应认成标记：${JSON.stringify(text)}`);
  }
});

test('isQuietMark 反例：正文里顺口提到「不说话」⇒ false（不能吞掉整条内容）', () => {
  for (const text of [
    '我本来想说[不说话]但后来还是想跟你聊两句',
    '我昨天跟她讲话，她说不说话要看场合，你懂吧',
    '在吗',
  ]) {
    assert.equal(isQuietMark(text), false, `不该认成标记：${JSON.stringify(text)}`);
  }
});

// ------------------------------------------------------------ 主路径：整句标记

test('★ 主路径：整句 [不说话] ⇒ 一条不发、标记本身绝不发出去，并留痕', async () => {
  const h = harness({ reply: '[不说话]' });
  const reply = await h.gateway.runTurn({
    message: message(),
    sessionKey: SESSION_KEY,
    restricted: false,
    prompt: '在吗',
  });
  assert.equal(reply, '', '不回任何正文');
  assert.equal(h.transport.sent.length, 0, 'QQ 上一条都不该有');
  assert.equal(h.gateway.stats.quietReplies, 1);
  assert.equal(h.gateway.stats.replies, 0, '没发就不许记进 replies');
  assert.equal(h.gateway.lastQuietReply.toolSent, false);
  assert.equal(h.gateway.lastQuietReply.chars, '[不说话]'.length);
  const log = h.logs.find((l) => /不说话/.test(l.message));
  assert.ok(log, '必须有一条 info 日志（不许静默）');
  assert.equal(log.level, 'info');
});

test('主路径：正文里提到「不说话」⇒ 照常发出去（反例）', async () => {
  const body = '我本来想说[不说话]但后来还是想跟你聊两句';
  const h = harness({ reply: body });
  const reply = await h.gateway.runTurn({
    message: message(),
    sessionKey: SESSION_KEY,
    restricted: false,
    prompt: '在吗',
  });
  assert.equal(reply, body);
  assert.deepEqual(sentTexts(h.transport), [body], '内容不许被吞');
  assert.equal(h.gateway.stats.quietReplies, 0);
  assert.equal(h.gateway.lastQuietReply, null);
});

// ------------------------------------------------------------ 与 send_qq 并存

test('★ 已经 send_qq 发过 ⇒ 正文 [不说话] 只压重复，不压掉工具那条', async () => {
  const h = harness({
    reply: '[不说话]',
    beforeRespond: async (gateway, request) => {
      const result = await gateway.sendFromTool({
        sessionKey: request.sessionKey,
        items: [{ kind: 'text', text: '先说一句' }],
        now: T0,
      });
      assert.equal(result.ok, true, '工具那条必须真的发出去');
    },
  });
  const reply = await h.gateway.runTurn({
    message: message(),
    sessionKey: SESSION_KEY,
    restricted: false,
    prompt: '在吗',
  });
  assert.equal(reply, '');
  assert.deepEqual(sentTexts(h.transport), ['先说一句'], '只有工具那条，没有重复正文');
  assert.ok(!sentTexts(h.transport).some((t) => t.includes('[不说话]')), '标记绝不发出去');
  assert.equal(h.gateway.stats.quietReplies, 1);
  assert.equal(h.gateway.lastQuietReply.toolSent, true, 'toolSent 留痕：她其实说过了');
});

// ------------------------------------------------------------ 图照发（2026-11-02 拍板）

/**
 * 用户原话：「**一声不吭发张图我觉得挺合理的**」。
 *
 * ⇒ `[不说话]` 管的是**正文**，不是"这轮什么都别发"。
 * 这条测试就是钉住这个口子：正文一个字都不出去，图必须出去。
 *
 * （取舍来回过一次：实现最初把图一起压了，用户看完说压掉才对的是反的 ——
 *   一声不吭甩张图本身就是表达，压掉等于把"我没话讲，但想给你看这个"也禁了。）
 */
test('★ 整句 [不说话] + 带图 ⇒ 正文不发，图照发', async () => {
  const h = harness({ reply: '[不说话]' });
  const reply = await h.gateway.runTurn({
    message: message(),
    sessionKey: SESSION_KEY,
    restricted: false,
    prompt: '在吗',
    images: ['https://example.com/cat.png'],
  });
  assert.equal(reply, '', '正文一个字都不发');
  assert.equal(h.transport.sent.length, 1, '图必须发出去（一声不吭发张图是合理的）');
  const sent = h.transport.sent[0].message;
  const segs = Array.isArray(sent) ? sent : [];
  assert.ok(
    segs.some((seg) => seg?.type === 'image'),
    '发出去的必须是图片段，不是文字段',
  );
  assert.ok(
    !sentTexts(h.transport).some((t) => t.includes('[不说话]')),
    '标记绝不发出去',
  );
  assert.equal(h.gateway.stats.quietReplies, 1);
  assert.equal(h.gateway.lastQuietReply.images, 1);
  assert.equal(h.gateway.stats.replies, 1, '图真发出去了 ⇒ 记进 replies');
});
