/**
 * B2（2026-10-25）：**两条发送路径的优先级** —— `runTurn` 的自动发送 vs `send_qq` 工具。
 *
 * ## 这条测试在保护什么
 *
 * 旧行为是 `runTurn` **无条件**把她这一轮的输出发出去，而 `send_qq` 是**另外一条**路
 * ⇒ 她调了工具、这一轮又产出文本，QQ 上就多一条。`[send] auto_reply` 三种取值：
 *
 * | 取值 | 工具发过文字 | 工具没发过 |
 * |---|---|---|
 * | `fallback`（默认） | **不自动发**（避免重复） | 自动发 + `warn`（兜底保命） |
 * | `always` | 照旧自动发（= 改动前的行为，只作回滚） | 自动发（不 warn） |
 * | `off` | 不自动发 | **不自动发**（她没调工具 = 这一轮不说话） |
 *
 * ## 两个刻意的边界（都有用例钉着，别顺手"简化"掉）
 *
 * 1. **只数【文字】，不数表情包**：她常常"甩一张表情包 + 正文还是本轮回复"，
 *    如果表情包也算"发过了"，正文就被吞掉 = 丢消息。
 * 2. **只数【真发出去】的**：被同文闸拦下、或 `send_qq` 直接 `ok:false`
 *    （参数不合法 / 频率闸 / 白名单）都不算 —— 那种时候兜底必须照发，
 *    否则 QQ 上会一片沉默，而台账里看起来"她说了"。
 *
 * ## 台账口径（另一个不变式）
 *
 * 一条消息仍然 = **1 行 `gw-send`**（`#recordOutbound` 的注释写死了这条），
 * 兜底发出去的那行 `caller` 记 `runTurn-fallback`，工具那行记 `send_qq`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { createOutboundAllow } from '../src/dsh/outbound-allow.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

const T0 = Date.UTC(2026, 4, 1, 12, 0, 0);
const CHAT_ID = 'private:2001';
const SESSION_KEY = 'qq-private-2001';

/** 出站白名单（配置形状，假号）：测试里就一个私聊 + 一个群。 */
const RELAY_ALLOW = createOutboundAllow({ allowFrom: ['2001'], groupAllowFrom: ['100'] });

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

/** 表情包库替身：只有一张 `deadbeef`，`pick` 永远挑到它。 */
function makeStickerLibrary() {
  return {
    pathOf: (md5) => (md5 === 'deadbeef' ? '/fake/stickers/deadbeef.gif' : null),
    pick: () => ({ md5: 'deadbeef' }),
    recordUse: () => {},
  };
}

/**
 * 装一套网关：真 Router/Engine + 假 transport/responder/台账。
 *
 * @param {object} [options]
 * @param {'fallback'|'always'|'off'|string} [options.autoReply]
 * @param {(gateway: object) => Promise<void>|void} [options.beforeRespond]
 *   在 `responder()` 里执行 —— 模拟"她这一轮调了 `send_qq`"。
 * @param {string} [options.reply] responder 的返回（默认 `'回复正文'`）
 */
function harness(options = {}) {
  const transport = makeTransport();
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.OPEN,
    requireMention: true,
    adminUsers: ['9001'],
  });
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
    gauge: async () => ({ speak: true, text: '主动冒泡' }),
    speak: async () => undefined,
    log: () => {},
    now: () => T0,
  });

  let gateway = null;
  gateway = new Gateway({
    transport,
    router,
    engine,
    outboundAllow: RELAY_ALLOW,
    responder: async () => {
      if (typeof options.beforeRespond === 'function') await options.beforeRespond(gateway);
      return options.reply ?? '回复正文';
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    maxReplyChars: 2000,
    autoReply: options.autoReply,
    outboundLedger: { record: (row) => ledgerRows.push(row) },
    stickerLibrary: makeStickerLibrary(),
  });
  gateway.attach();

  return { gateway, transport, logs, ledgerRows };
}

/** `runTurn` 需要的最小消息形状（走的是同一个 `chatId`/`kind`）。 */
function message(overrides = {}) {
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
    ...overrides,
  };
}

/** 跑一轮（不经路由/判定，直接打到 B2 改动的那段）。 */
function runTurn(gateway, extra = {}) {
  return gateway.runTurn({
    message: message(),
    sessionKey: SESSION_KEY,
    restricted: false,
    prompt: '在吗',
    ...extra,
  });
}

/** 台账里 `gw-send` 那一层的 caller 列表。 */
function gwCallers(ledgerRows) {
  return ledgerRows.filter((row) => row.layer === 'gw-send').map((row) => row.caller);
}

function hasLog(logs, level, text) {
  return logs.some((entry) => entry.level === level && String(entry.message).includes(text));
}

// ---------------------------------------------------------------- fallback（默认）

test('fallback：她这一轮用 send_qq 发了文字 ⇒ 只发工具那条，不再自动发（不再重复）', async () => {
  const h = harness({
    beforeRespond: async (gw) => {
      const result = await gw.sendFromTool({
        sessionKey: SESSION_KEY,
        items: [{ kind: 'text', text: '工具发的这句' }],
        now: T0,
      });
      assert.equal(result.ok, true);
      assert.equal(result.sent, 1);
    },
  });
  const text = await runTurn(h.gateway);

  // 工具那条 + **没有**第二条（自动发送被跳过）
  assert.equal(h.transport.sent.length, 1);
  assert.equal(h.transport.sent[0].chatId, CHAT_ID);
  assert.match(JSON.stringify(h.transport.sent[0].message), /工具发的这句/);
  assert.doesNotMatch(JSON.stringify(h.transport.sent[0].message), /回复正文/);
  // 她的输出仍然返回给调用方（会话/判定层要它）
  assert.equal(text, '回复正文');
  // 台账：一行，caller 是工具那条（**不是** runTurn*）
  assert.deepEqual(gwCallers(h.ledgerRows), ['send_qq']);
  assert.equal(hasLog(h.logs, 'debug', '跳过自动发送'), true);
  assert.equal(hasLog(h.logs, 'warn', '兜底'), false);
});

test('fallback：她这一轮没调工具 ⇒ 兜底自动发（+ 一行 warn，caller=runTurn-fallback）', async () => {
  const h = harness({});
  const text = await runTurn(h.gateway);

  assert.equal(text, '回复正文');
  assert.equal(h.transport.sent.length, 1);
  assert.match(JSON.stringify(h.transport.sent[0].message), /回复正文/);
  assert.deepEqual(gwCallers(h.ledgerRows), ['runTurn-fallback']);
  // 兜底是"本该由工具发"的信号 ⇒ 必须 warn（否则这个模式悄悄退化成 always 也没人发现）
  assert.equal(hasLog(h.logs, 'warn', '兜底自动发送'), true);
});

test('fallback：工具只发了【表情包】⇒ 正文照常自动发（别把正文当重复吞掉）', async () => {
  const h = harness({
    beforeRespond: async (gw) => {
      const result = await gw.sendFromTool({
        sessionKey: SESSION_KEY,
        items: [{ kind: 'sticker', tags: ['开心满足'] }],
        now: T0,
      });
      assert.equal(result.ok, true);
      assert.equal(result.sent, 1);
    },
  });
  await runTurn(h.gateway);

  // 表情包 1 条 + 正文 1 条
  assert.equal(h.transport.sent.length, 2);
  assert.doesNotMatch(JSON.stringify(h.transport.sent[0].message), /回复正文/);
  assert.match(JSON.stringify(h.transport.sent[1].message), /回复正文/);
  assert.deepEqual(gwCallers(h.ledgerRows), ['send_qq', 'runTurn-fallback']);
});

test('fallback：send_qq 自己失败了（参数不合法 / 一条都没发出去）⇒ 兜底照发，不算"发过"', async () => {
  const h = harness({
    beforeRespond: async (gw) => {
      // 4 条超过上限 3 ⇒ ok:false、一条都不发
      const result = await gw.sendFromTool({
        sessionKey: SESSION_KEY,
        items: [
          { kind: 'text', text: 'a' },
          { kind: 'text', text: 'b' },
          { kind: 'text', text: 'c' },
          { kind: 'text', text: 'd' },
        ],
        now: T0,
      });
      assert.equal(result.ok, false);
      assert.equal(result.sent, 0);
    },
  });
  await runTurn(h.gateway);

  assert.equal(h.transport.sent.length, 1);
  assert.match(JSON.stringify(h.transport.sent[0].message), /回复正文/);
  assert.deepEqual(gwCallers(h.ledgerRows), ['runTurn-fallback']);
});

test('fallback：工具发了文字、但本轮还带着图 ⇒ 只送图（不丢图、也不把正文发两遍）', async () => {
  const h = harness({
    beforeRespond: async (gw) => {
      await gw.sendFromTool({
        sessionKey: SESSION_KEY,
        items: [{ kind: 'text', text: '工具发的这句' }],
        now: T0,
      });
    },
  });
  await runTurn(h.gateway, { images: ['https://example.invalid/x.png'] });

  assert.equal(h.transport.sent.length, 2);
  // 第二条只有图，没有重复的正文
  assert.doesNotMatch(JSON.stringify(h.transport.sent[1].message), /回复正文/);
  assert.deepEqual(gwCallers(h.ledgerRows), ['send_qq', 'runTurn-images']);
});

// ---------------------------------------------------------------- always（回滚开关）

test('always：无条件自动发 —— 工具发过也照旧（= 改动前的行为，只作回滚）', async () => {
  const h = harness({
    autoReply: 'always',
    beforeRespond: async (gw) => {
      await gw.sendFromTool({
        sessionKey: SESSION_KEY,
        items: [{ kind: 'text', text: '工具发的这句' }],
        now: T0,
      });
    },
  });
  await runTurn(h.gateway);

  assert.equal(h.transport.sent.length, 2);
  assert.deepEqual(gwCallers(h.ledgerRows), ['send_qq', 'runTurn']);
  // always 是**有意**的老行为，不是异常 ⇒ 不该 warn"兜底"
  assert.equal(hasLog(h.logs, 'warn', '兜底自动发送'), false);
});

// ---------------------------------------------------------------- off（目标形态）

test('off：她没调工具 ⇒ 什么都不发（她说的话只留在会话里）', async () => {
  const h = harness({ autoReply: 'off' });
  const text = await runTurn(h.gateway);

  assert.equal(text, '回复正文');
  assert.equal(h.transport.sent.length, 0);
  assert.deepEqual(gwCallers(h.ledgerRows), []);
  assert.equal(hasLog(h.logs, 'debug', 'auto_reply=off'), true);
});

test('off：她调了工具 ⇒ 只发工具那条', async () => {
  const h = harness({
    autoReply: 'off',
    beforeRespond: async (gw) => {
      await gw.sendFromTool({
        sessionKey: SESSION_KEY,
        items: [{ kind: 'text', text: '工具发的这句' }],
        now: T0,
      });
    },
  });
  await runTurn(h.gateway);

  assert.equal(h.transport.sent.length, 1);
  assert.match(JSON.stringify(h.transport.sent[0].message), /工具发的这句/);
  assert.deepEqual(gwCallers(h.ledgerRows), ['send_qq']);
});

// ---------------------------------------------------------------- 空回复 / 归一化

test('空回复：三种模式都什么都不发（这是既有的合法出口，别动）', async () => {
  for (const mode of ['fallback', 'always', 'off']) {
    const h = harness({ autoReply: mode, reply: '   ' });
    const text = await runTurn(h.gateway);
    assert.equal(text, '', mode);
    assert.equal(h.transport.sent.length, 0, mode);
    assert.deepEqual(gwCallers(h.ledgerRows), [], mode);
  }
});

test('autoReply 非法值 ⇒ 归一化成 fallback（绝不悄悄退回 always）+ 一行 warn', async () => {
  const h = harness({
    autoReply: 'ALWAYS',
    beforeRespond: async (gw) => {
      await gw.sendFromTool({
        sessionKey: SESSION_KEY,
        items: [{ kind: 'text', text: '工具发的这句' }],
        now: T0,
      });
    },
  });
  await runTurn(h.gateway);

  // 按 fallback 处理 ⇒ 只 1 条；若错误地当 always 就是 2 条
  assert.equal(h.transport.sent.length, 1);
  assert.equal(hasLog(h.logs, 'warn', 'auto_reply'), true);
});

test('默认（没传 autoReply）= fallback：工具发过就不重复', async () => {
  const h = harness({
    beforeRespond: async (gw) => {
      await gw.sendFromTool({
        sessionKey: SESSION_KEY,
        items: [{ kind: 'text', text: '工具发的这句' }],
        now: T0,
      });
    },
  });
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 1);
  assert.equal(h.gateway.autoReply, 'fallback');
});
