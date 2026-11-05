/**
 * B3（2026-10-25）：**出站消息切分** —— 一条回复按"独立一行的标记"切成几条发。
 *
 * ## 为什么是新功能而不是修 bug
 * 出站**根本没有**切分器（只有 `truncateReply`）。`send_qq` 能一次发 1~3 条，
 * 但自动发送那条路只会把整段文本原样丢出去。
 *
 * ## 三个必须钉住的判据
 * 1. **没标记 ⇒ 逐字节不变**（这条功能绝不能顺手改掉纯文本的形状）；
 * 2. **切点在 `stripMarkdown` 之前** —— `---` 会被 `plain-text.mjs` 的
 *    "水平线"规则**整行删掉**（所以默认标记是 `⟨cut⟩`，不是 `---`）；
 * 3. **每段一行 `gw-send`**，caller 带 `-part<n>`（"一行 = 一次决定要发"不变式）。
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
    responder: async () => {
      if (typeof options.beforeRespond === 'function') await options.beforeRespond(gateway);
      return options.reply ?? '回复正文';
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    maxReplyChars: options.maxReplyChars ?? 2000,
    autoReply: options.autoReply ?? 'fallback',
    splitMarker: options.splitMarker,
    splitMaxParts: options.splitMaxParts,
    outboundLedger: { record: (row) => ledgerRows.push(row) },
  });
  gateway.attach();
  return { gateway, transport, logs, ledgerRows };
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

function runTurn(gateway, extra = {}) {
  return gateway.runTurn({
    message: message(),
    sessionKey: SESSION_KEY,
    restricted: false,
    prompt: '在吗',
    ...extra,
  });
}

/** 取每条已发送消息的正文（传输层拿到的是字符串或段数组）。 */
function sentTexts(transport) {
  return transport.sent.map((entry) => (typeof entry.message === 'string'
    ? entry.message
    : (Array.isArray(entry.message)
      ? entry.message.map((seg) => (seg?.type === 'text' ? String(seg.data?.text ?? '') : '')).join('')
      : String(entry.message))));
}

function gwCallers(ledgerRows) {
  return ledgerRows.filter((row) => row.layer === 'gw-send').map((row) => row.caller);
}

// ---------------------------------------------------------------- 没标记：原样

test('★ 没标记 ⇒ 一条，正文逐字节不变（纯文本形状不许被这条功能改掉）', async () => {
  const body = '第一行\n第二行 **粗体** 与 `代码`\n- 列表项';
  const h = harness({ reply: body });
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 1);
  assert.deepEqual(sentTexts(h.transport), ['第一行\n第二行 粗体 与 代码\n- 列表项']);
  // 单段时 caller 不带 -part（老台账口径不变）
  assert.deepEqual(gwCallers(h.ledgerRows), ['runTurn-fallback']);
});

// 2026-11-02：行内标记也算切点（`⟨cut⟩` 不再必须独占一行）
test('标记夹在正文里（不是整行）⇒ 也切，标记前后各成一段', async () => {
  const h = harness({ reply: '前面 ⟨cut⟩ 后面' });
  await runTurn(h.gateway);
  assert.deepEqual(sentTexts(h.transport), ['前面', '后面']);
});

test('规则1：标记独占一行（上下有空行）⇒ 切（老行为不变）', async () => {
  const h = harness({ reply: 'A\n\n⟨cut⟩\nB' });
  await runTurn(h.gateway);
  assert.deepEqual(sentTexts(h.transport), ['A', 'B']);
});

test('规则2：标记行后面跟着文字 ⇒ 切，文字归下一段开头', async () => {
  const h = harness({ reply: 'A\n\n⟨cut⟩ B' });
  await runTurn(h.gateway);
  assert.deepEqual(sentTexts(h.transport), ['A', 'B']);
});

test('规则3：标记前后都有文字（同一行）⇒ 切', async () => {
  const h = harness({ reply: 'A ⟨cut⟩ B' });
  await runTurn(h.gateway);
  assert.deepEqual(sentTexts(h.transport), ['A', 'B']);
});

test('规则3延伸：一行里有多个标记 ⇒ 切多次', async () => {
  const h = harness({ reply: '一 ⟨cut⟩ 二 ⟨cut⟩ 三' });
  await runTurn(h.gateway);
  assert.deepEqual(sentTexts(h.transport), ['一', '二', '三']);
});

test('规则4：独占一行 + 行内标记连着来 ⇒ 只在文字处分段，标记不泄漏进正文', async () => {
  const h = harness({ reply: 'A\n⟨cut⟩\n⟨cut⟩ B' });
  await runTurn(h.gateway);
  assert.deepEqual(sentTexts(h.transport), ['A', 'B']);
});

test('规则5：连续多个标记（含行内）⇒ 中间空段丢掉，不发空消息', async () => {
  const h = harness({ reply: '甲 ⟨cut⟩ ⟨cut⟩ 乙' });
  await runTurn(h.gateway);
  const texts = sentTexts(h.transport);
  assert.deepEqual(texts, ['甲', '乙']);
  assert.equal(texts.filter((t) => t.trim() === '').length, 0);
});

test('规则5延伸：紧贴着的两个标记（⟨cut⟩⟨cut⟩）⇒ 同样丢空段', async () => {
  const h = harness({ reply: '甲⟨cut⟩⟨cut⟩乙' });
  await runTurn(h.gateway);
  assert.deepEqual(sentTexts(h.transport), ['甲', '乙']);
});

test('splitMarker = "" ⇒ 显式关掉切分', async () => {
  const h = harness({ splitMarker: '', reply: 'AA\n⟨cut⟩\nBB' });
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 1);
  assert.match(sentTexts(h.transport)[0], /⟨cut⟩/);
});

// ---------------------------------------------------------------- 多段

test('★ 两段：标记行本身不发出去，正文各成一条（台账每段一行，caller 带 -part）', async () => {
  const h = harness({ reply: '第一句\n⟨cut⟩\n第二句' });
  await runTurn(h.gateway);
  assert.deepEqual(sentTexts(h.transport), ['第一句', '第二句']);
  assert.deepEqual(gwCallers(h.ledgerRows), ['runTurn-fallback-part1', 'runTurn-fallback-part2']);
});

test('标记行两侧带空白 / 行尾 CRLF 也算切点', async () => {
  const h = harness({ reply: '甲\r\n   ⟨cut⟩  \r\n乙' });
  await runTurn(h.gateway);
  assert.deepEqual(sentTexts(h.transport), ['甲', '乙']);
});

test('空段被丢掉（连续两个标记 / 开头就是标记 / 末尾标记）', async () => {
  const h = harness({ reply: '⟨cut⟩\n只有这段\n⟨cut⟩\n⟨cut⟩\n还有这段\n⟨cut⟩' });
  await runTurn(h.gateway);
  assert.deepEqual(sentTexts(h.transport), ['只有这段', '还有这段']);
});

test('只有标记没有内容 ⇒ 什么都不发（不造空消息）', async () => {
  const h = harness({ reply: '⟨cut⟩\n   \n⟨cut⟩' });
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 0);
  assert.deepEqual(gwCallers(h.ledgerRows), []);
});

test('★ 代码块里的标记【不切】（围栏里的 ⟨cut⟩ 是内容）', async () => {
  const h = harness({ reply: '看这段代码：\n```\nfoo\n⟨cut⟩\nbar\n```\n就这样' });
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 1);
  assert.match(sentTexts(h.transport)[0], /⟨cut⟩/u);
});

test('规则6：代码围栏里的【行内】标记同样不切', async () => {
  const h = harness({ reply: '看这段代码：\n```js\nconst a = "A ⟨cut⟩ B";\n```\n就这样' });
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 1);
  assert.match(sentTexts(h.transport)[0], /A ⟨cut⟩ B/u);
});

test('★ 超上限：多出来的并进最后一段（宁可长一点，不丢内容）', async () => {
  const h = harness({ splitMaxParts: 2, reply: '一\n⟨cut⟩\n二\n⟨cut⟩\n三\n⟨cut⟩\n四' });
  await runTurn(h.gateway);
  const texts = sentTexts(h.transport);
  assert.equal(texts.length, 2);
  assert.equal(texts[0], '一');
  // 后三段按顺序并成一段（含分隔用的换行）
  assert.equal(texts[1], '二\n三\n四');
});

test('相邻两段完全相同 ⇒ 合并（否则后一段会被同文短窗闸静默吞掉）', async () => {
  const h = harness({ reply: '哈哈\n⟨cut⟩\n哈哈' });
  await runTurn(h.gateway);
  assert.equal(h.transport.sent.length, 1);
  assert.equal(sentTexts(h.transport)[0], '哈哈\n哈哈');
});

// ---------------------------------------------------------------- 截断与切分的关系

test('★ 标记在 maxReplyChars 以外也能切到（截断挪到了每段里）', async () => {
  // 整段 30 字 > 上限 10：老实现会先截成前 10 个字，标记和后半段一起没了。
  const h = harness({ maxReplyChars: 10, reply: 'AAAAAAAAAA\n⟨cut⟩\nBBBBBBBBBB' });
  await runTurn(h.gateway);
  assert.deepEqual(sentTexts(h.transport), ['AAAAAAAAAA', 'BBBBBBBBBB']);
});

// ---------------------------------------------------------------- 跟 B2 / send_qq 的关系

test('send_qq 不按标记切（它本身就是"分几条发"的表达方式，别架空 MAX_ITEMS 闸）', async () => {
  const h = harness({ autoReply: 'off' });
  const result = await h.gateway.sendFromTool({
    sessionKey: SESSION_KEY,
    items: [{ kind: 'text', text: 'AA\n⟨cut⟩\nBB' }],
    now: T0,
  });
  assert.equal(result.ok, true);
  assert.equal(h.transport.sent.length, 1);
  assert.equal(sentTexts(h.transport)[0], 'AA\n⟨cut⟩\nBB');
  assert.deepEqual(gwCallers(h.ledgerRows), ['send_qq']);
});

test('切出的每段都会被剥 Markdown（切在剥之前，标记不会先被当成水平线删掉）', async () => {
  const h = harness({ reply: '**甲**\n⟨cut⟩\n**乙**' });
  await runTurn(h.gateway);
  assert.deepEqual(sentTexts(h.transport), ['甲', '乙']);
});
