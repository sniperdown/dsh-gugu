/**
 * 出站**图片段**：[7-2] 的回归测试。
 *
 * ## 这组测试盯的是什么
 *
 * 传输层早就支持段数组（`transport.mjs` 的 `sendToChat(chatId, message)`，
 * `message` 可以是字符串或段数组），但**调用方全部只传字符串** ——
 * 于是小鲸鱼一张图都发不出去。这个能力的全部证据只有两件事：
 *
 * 1. **形状**：发出去的图片段必须是 OneBot 11 的**规范形状**
 *    `{type:'image', data:{url|file}}`，不是本项目内部那个压平形状。
 *    形错了一半的代价是**静默失败**（NapCat 收到一个没有 data 的段）。
 * 2. **文本路径没坏**：6 个发送点里 4 个是纯文本，它们必须继续发**字符串**。
 *
 * 所以这里同时钉住两边：有图 → 段数组；没图 → 原样的字符串。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { imageSegment, outboundMessage, MAX_OUTBOUND_IMAGES } from '../src/onebot/protocol.mjs';
import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { createOutboundAllow } from '../src/dsh/outbound-allow.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-outimg-';

/** `send_qq` 发图用的临时文件（**真文件**：校验会 stat/access 它）。 */
function tempDir() {
  return fs.mkdtempSync(path.join(HERE, PREFIX));
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith(PREFIX)) fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
    }
  } catch {
    /* 收尾失败不该影响测试结果 */
  }
});

function writeImage(dir, name, bytes = 1024) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

// ------------------------------------------------------------------ 形状

test('imageSegment：http(s) 走 url，其余走 file（**规范形状**，data 嵌套）', () => {
  assert.deepEqual(
    imageSegment('https://gxh.vip.qq.com/club/item/parcel/item/67/aaa/raw300.gif'),
    { type: 'image', data: { url: 'https://gxh.vip.qq.com/club/item/parcel/item/67/aaa/raw300.gif' } },
  );
  // 本地绝对路径：NapCat 支持直接读本机文件（dsh-onebot-qq 也把本地文件走 file）
  assert.deepEqual(
    imageSegment('<DSH_HOME>\\media\\stickers\\abc.gif'),
    { type: 'image', data: { file: '<DSH_HOME>\\media\\stickers\\abc.gif' } },
  );
  assert.deepEqual(
    imageSegment('base64://AAAA'),
    { type: 'image', data: { file: 'base64://AAAA' } },
  );
});

test('imageSegment：`data` 嵌套与压平两种输入都收敛到规范形状', () => {
  // ⚠️ 这条是防"从内部表示反推线上协议"的：入站段是**压平**的
  //（`toSegments` 会把 data 摊到顶层），照抄那个形状发出去就是错的。
  assert.deepEqual(
    imageSegment({ type: 'image', data: { file: 'a.png', url: 'http://x/a.png' } }),
    { type: 'image', data: { url: 'http://x/a.png' } },
    'url 优先（与入站渲染的取值顺序一致）',
  );
  assert.deepEqual(
    imageSegment({ type: 'image', file: 'a.png' }),
    { type: 'image', data: { file: 'a.png' } },
  );
  assert.deepEqual(imageSegment({ url: 'http://x/a.png' }), { type: 'image', data: { url: 'http://x/a.png' } });
  assert.deepEqual(imageSegment({ path: 'D:\\x\\a.gif' }), { type: 'image', data: { file: 'D:\\x\\a.gif' } });
});

test('imageSegment：认不出的输入返回 null（绝不发半残的段）', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, [], { type: 'text', text: 'hi' }, { type: 'image' }]) {
    assert.equal(imageSegment(bad), null, `${JSON.stringify(bad)} 应返回 null`);
  }
});

test('outboundMessage：**没有图就原样返回字符串**（文本路径的命根子）', () => {
  assert.equal(outboundMessage('你好', []), '你好');
  assert.equal(outboundMessage('你好'), '你好');
  assert.equal(outboundMessage('你好', null), '你好');
  // 全是认不出的图 → 退化回字符串，而不是发一个空壳段数组
  assert.equal(outboundMessage('你好', ['', null, 42]), '你好');
});

test('★ outboundMessage：有图就组段数组，正文段在前，**文本段也是 data 嵌套**', () => {
  // 2026-10-26 真机教训：扁平 `{type:'text', text}` 进段数组时 NapCat 直接报
  // `Cannot read properties of undefined (reading 'text')`（retcode 200）。
  // 所以这条断言盯的不只是"顺序"，还有**文本段的形状必须是规范形状**。
  assert.deepEqual(
    outboundMessage('看这个', ['H:\\s\\a.gif']),
    [
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: { file: 'H:\\s\\a.gif' } },
    ],
  );
});

test('outboundMessage：正文为空时不发空文本段（"只发一张表情包"是合法发言）', () => {
  assert.deepEqual(
    outboundMessage('', ['http://x/a.png']),
    [{ type: 'image', data: { url: 'http://x/a.png' } }],
  );
});

test('outboundMessage：一次最多带 MAX_OUTBOUND_IMAGES 张（防刷屏）', () => {
  const many = Array.from({ length: 9 }, (_, i) => `http://x/${i}.png`);
  const got = outboundMessage('t', many);
  assert.equal(got.length, 1 + MAX_OUTBOUND_IMAGES);
  assert.equal(MAX_OUTBOUND_IMAGES, 3);
});

// ------------------------------------------------------------------ 网关

/** 假传输层：记录 `sendToChat` 收到的**原始 message**（字符串还是段数组一眼可见）。 */
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

/** 装一套网关：真 Router/Engine + 假 transport/responder。 */
function harness({ stickerLibrary = null, reply = '回复', outboundAllow = null, maxImageBytes, ledgerRows } = {}) {
  const transport = makeTransport();
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    // 群聊用**白名单**而不是 open：出站白名单是用户的硬边界，
    // 这里要能真的验出"名单外的群一条都不发"。
    groupPolicy: POLICY.ALLOWLIST,
    groupAllowFrom: ['200000001'],
    requireMention: true,
    botQQ: '999',
  });
  const logs = [];
  const engine = new ProactiveEngine({
    config: { enabled: false, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0, afterUserMsgCount: 0 },
    gauge: async () => ({ speak: true }),
    speak: async () => undefined,
    log: () => {},
  });
  const gateway = new Gateway({
    transport,
    router,
    engine,
    responder: async () => reply,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    stickerLibrary,
    // 2026-10-26：`send_qq` 发图的校源要它（不传 ⇒ 全拒，那是"没配白名单"的正确行为）。
    outboundAllow,
    // 只有测"超大小"时才传一个小额度；其余用默认 10 MB。
    ...(maxImageBytes === undefined ? {} : { maxImageBytes }),
    ...(ledgerRows === undefined ? {} : { outboundLedger: { record: (row) => ledgerRows.push(row) } }),
  });
  gateway.attach();
  return { gateway, transport, router, engine, logs };
}

/** 一张最小可用的 PNG（≥12 字节，magic 认得出）。 */
function pngBytes(seed) {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b[8] = 0x00; b[9] = 0x00; b[10] = 0x00; b[11] = 0x0d;
  b[12] = seed % 256; b[13] = (seed * 7) % 256;
  return b;
}

// ------------------------------------------------------------------ 文本路径没坏

test('★ speakProactively：纯文本仍然发**字符串**（与改动前逐字节相同）', async () => {
  const h = harness();
  const ok = await h.gateway.speakProactively('group:200000001', '主动说一句');
  assert.equal(ok, true);
  assert.equal(h.transport.sent.length, 1);
  assert.equal(h.transport.sent[0].message, '主动说一句', '必须是字符串，不是段数组');
});

test('★ runTurn：纯文本回复仍然发**字符串**', async () => {
  const h = harness();
  await h.gateway.runTurn({
    message: {
      chatId: 'private:10000001',
      kind: 'private',
      userId: '10000001',
      nickname: '用户',
      text: '在吗',
      at: Date.now(),
      mentioned: true,
      replyToSelf: false,
      segments: [{ type: 'text', text: '在吗' }],
      raw: '在吗',
    },
    sessionKey: 'qq-private-10000001',
    restricted: false,
    prompt: 'p',
    addressed: true,
  });
  assert.equal(h.transport.sent.length, 1);
  assert.equal(h.transport.sent[0].message, '回复');
});

test('★ speakProactively：给了图就发**段数组**，且形状是规范形状', async () => {
  const h = harness();
  const ok = await h.gateway.speakProactively('group:200000001', '看图', ['https://gxh.vip.qq.com/x.gif']);
  assert.equal(ok, true);
  assert.deepEqual(h.transport.sent[0].message, [
    { type: 'text', data: { text: '看图' } },
    { type: 'image', data: { url: 'https://gxh.vip.qq.com/x.gif' } },
  ]);
});

test('★ speakProactively：正文为空但有图 → 照发（"只发一张表情包"）', async () => {
  const h = harness();
  const ok = await h.gateway.speakProactively('group:200000001', '', ['H:\\s\\a.gif']);
  assert.equal(ok, true);
  assert.deepEqual(h.transport.sent[0].message, [{ type: 'image', data: { file: 'H:\\s\\a.gif' } }]);
});

test('speakProactively：正文为空且没图 → 什么都不发（老行为不变）', async () => {
  const h = harness();
  assert.equal(await h.gateway.speakProactively('group:200000001', ''), false);
  assert.equal(h.transport.sent.length, 0);
});

test('★ runTurn：回复可以带图（正文为空也算一轮有效回复）', async () => {
  const h = harness({ reply: '' });
  await h.gateway.runTurn({
    message: {
      chatId: 'private:10000001',
      kind: 'private',
      userId: '10000001',
      text: 'x',
      at: Date.now(),
      mentioned: true,
      segments: [{ type: 'text', text: 'x' }],
    },
    sessionKey: 'qq-private-10000001',
    restricted: false,
    prompt: 'p',
    addressed: true,
    images: ['http://x/a.png'],
  });
  assert.deepEqual(h.transport.sent[0].message, [{ type: 'image', data: { url: 'http://x/a.png' } }]);
});

test('★ 出站白名单照旧管住带图发言（图片段不是绕过白名单的后门）', async () => {
  const h = harness();
  const ok = await h.gateway.speakProactively('group:999999999', '看图', ['http://x/a.png']);
  assert.equal(ok, false);
  assert.equal(h.transport.sent.length, 0, '不在白名单里 → 一条都不该发出去');
});

// ------------------------------------------------------------------ 表情包引用

test('★ {sticker:<md5>}：从库里取路径发出去，并**记一次使用**', async () => {
  const used = [];
  const library = {
    pathOf: (md5) => (md5 === 'a'.repeat(32) ? '<DSH_HOME>\\media\\stickers\\aaa.gif' : null),
    recordUse: (md5) => { used.push(md5); return true; },
  };
  const h = harness({ stickerLibrary: library });
  const ok = await h.gateway.speakProactively('group:200000001', '', [{ sticker: 'a'.repeat(32) }]);
  assert.equal(ok, true);
  assert.deepEqual(h.transport.sent[0].message, [
    { type: 'image', data: { file: '<DSH_HOME>\\media\\stickers\\aaa.gif' } },
  ]);
  assert.deepEqual(used, ['a'.repeat(32)], '发出去了才记使用次数');
});

test('★ 裸的 32 位十六进制串：库里**有**才当表情包，没有就当普通路径', async () => {
  const md5 = 'b'.repeat(32);
  const used = [];
  const library = {
    pathOf: (id) => (id === md5 ? 'H:\\lib\\b.gif' : null),
    recordUse: (id) => { used.push(id); return true; },
  };
  const h = harness({ stickerLibrary: library });

  // ① 库里有 → 用库里的路径 + 记账
  await h.gateway.speakProactively('group:200000001', '', [md5]);
  assert.deepEqual(h.transport.sent[0].message, [{ type: 'image', data: { file: 'H:\\lib\\b.gif' } }]);
  assert.deepEqual(used, [md5]);

  // ② 库里没有 → **原样当文件名/路径**发（shape 仍是 file），不记账
  const other = 'c'.repeat(32);
  await h.gateway.speakProactively('group:200000001', '', [other]);
  assert.deepEqual(h.transport.sent[1].message, [{ type: 'image', data: { file: other } }]);
  assert.deepEqual(used, [md5], '猜不出内容就不记账');
});

test('★ {sticker:<md5>} 明示但库里没有 → 跳过这张 + 记一条 warn（不退化成发错图）', async () => {
  const logs = [];
  const library = { pathOf: () => null, recordUse: () => true };
  const h = harness({ stickerLibrary: library });
  h.logs.length = 0;
  const ok = await h.gateway.speakProactively('group:200000001', '文字还在', [{ sticker: 'd'.repeat(32) }]);
  assert.equal(ok, true);
  // 图被跳过 → 只剩文本；**仍然是字符串**（没有可发的图就不组段数组）
  assert.equal(h.transport.sent[0].message, '文字还在');
  assert.ok(h.logs.some((l) => String(l.message).includes('不在库里')), '要留一条可查的 warn');
});

test('★ 没有注入表情包库时不炸：裸 md5 当成普通路径发出去', async () => {
  const h = harness({ stickerLibrary: null });
  const md5 = 'e'.repeat(32);
  const ok = await h.gateway.speakProactively('group:200000001', '', [md5]);
  assert.equal(ok, true);
  assert.deepEqual(h.transport.sent[0].message, [{ type: 'image', data: { file: md5 } }]);
});

test('★ 记账失败不影响这条消息已经发出去（库写不进去不是单点故障）', async () => {
  const library = {
    pathOf: () => 'H:\\lib\\x.gif',
    recordUse: () => { throw new Error('索引写不进去'); },
  };
  const h = harness({ stickerLibrary: library });
  const ok = await h.gateway.speakProactively('group:200000001', '', [{ sticker: 'f'.repeat(32) }]);
  assert.equal(ok, true, '发图不该因为记账失败而失败');
  assert.deepEqual(h.transport.sent[0].message, [{ type: 'image', data: { file: 'H:\\lib\\x.gif' } }]);
});

test('sanit：最小 PNG 夹具本身能被协议层认出来（防"测试夹具是假的"）', () => {
  // 这条是给上面那些用 pngBytes 的用例兜底的：夹具若不是合法 PNG，
  // 后面的格式判定会静默走另一支，测试就变成"测了个假的"。
  assert.equal(pngBytes(1).length >= 12, true);
  assert.deepEqual([...pngBytes(1).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

// ---------------------------------------------------------------- send_qq 发图（2026-10-26）
//
// 工具层只校参数形状，**真要发之前的所有闸都在 `gateway.sendFromTool` / `#checkImageSource`**。
// 这组用例就是那些闸的回归网：路径不存在 / 超大小 / 坏扩展名 / file:// / 群里被白名单拦 / 图文混发。

const RELAY_ALLOW_DM = createOutboundAllow({ allowFrom: ['10000001'], groupAllowFrom: ['200000001'] });

test('★ send_qq kind=image：本地图 ⇒ 发出去是规范图片段，台账记 kind=image', async () => {
  const dir = tempDir();
  const file = writeImage(dir, 'a.png', 2048);
  const ledgerRows = [];
  const h = harness({ outboundAllow: RELAY_ALLOW_DM, ledgerRows });

  const r = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [{ kind: 'image', path: file }],
  });

  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  assert.match(r.note, /1 张图/);
  assert.deepEqual(h.transport.sent[0].message, [{ type: 'image', data: { file } }]);

  const gw = ledgerRows.filter((row) => row.layer === 'gw-send');
  assert.equal(gw.length, 1, '一行 = 一次决定要发');
  assert.equal(gw[0].caller, 'send_qq-image');
  assert.equal(gw[0].meta.kind, 'image');
  assert.equal(gw[0].meta.images, 1);
});

test('★ send_qq kind=image 带 caption：图注走同一条消息的文本段，且**算一次文字名额**', async () => {
  const dir = tempDir();
  const file = writeImage(dir, 'b.jpg', 512);
  const h = harness({ outboundAllow: RELAY_ALLOW_DM });
  const before = h.gateway.toolSendSeq.get('qq-private-10000001') ?? 0;

  const r = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [{ kind: 'image', path: file, caption: '你看这个' }],
  });

  assert.equal(r.ok, true);
  assert.deepEqual(h.transport.sent[0].message, [
    { type: 'text', data: { text: '你看这个' } },
    { type: 'image', data: { file } },
  ]);
  // 口径：带图注的图**算一次**（图注就是她说的话）⇒ 本轮自动回复不再发。
  assert.equal(h.gateway.toolSendSeq.get('qq-private-10000001') ?? 0, before + 1);
});

test('★ send_qq kind=image 不带 caption：**不占**文字名额（纯图 = 垫一下，正文照常自动发）', async () => {
  const dir = tempDir();
  const file = writeImage(dir, 'c.png', 512);
  const h = harness({ outboundAllow: RELAY_ALLOW_DM });
  const before = h.gateway.toolSendSeq.get('qq-private-10000001') ?? 0;

  const r = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [{ kind: 'image', path: file }],
  });

  assert.equal(r.ok, true);
  assert.equal(h.gateway.toolSendSeq.get('qq-private-10000001') ?? 0, before);
});

test('★ 图文混发：文字 + 图各一条，都发出去，note 说清有几张图', async () => {
  const dir = tempDir();
  const file = writeImage(dir, 'd.png', 512);
  const h = harness({ outboundAllow: RELAY_ALLOW_DM });

  const r = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [{ kind: 'text', text: '先看字' }, { kind: 'image', path: file, caption: '再看图' }],
  });

  assert.equal(r.ok, true);
  assert.equal(r.sent, 2);
  assert.match(r.note, /其中 1 张图/);
  assert.equal(h.transport.sent.length, 2);
  assert.equal(typeof h.transport.sent[0].message, 'string', '纯文字那条仍然是字符串（老路径不变）');
  assert.deepEqual(h.transport.sent[1].message[0], { type: 'text', data: { text: '再看图' } });
});

test('★ 闸：路径不存在 ⇒ 整批拒（不发半截）', async () => {
  const h = harness({ outboundAllow: RELAY_ALLOW_DM });
  const r = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [{ kind: 'image', path: path.join(HERE, '.tmp-outimg-does-not-exist.png') }],
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /不存在/);
  assert.equal(h.transport.sent.length, 0);
});

test('★ 闸：超过大小上限 ⇒ 拒，并报出实际大小（**不截断**）', async () => {
  const dir = tempDir();
  const file = writeImage(dir, 'big.png', 4096);
  const h = harness({ outboundAllow: RELAY_ALLOW_DM, maxImageBytes: 1024 });
  const r = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [{ kind: 'image', path: file }],
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /太大/);
  assert.match(r.note, /KB|MB/);
  assert.equal(h.transport.sent.length, 0);
});

test('★ 闸：扩展名不在白名单（.txt / 无扩展名）⇒ 拒，别猜 MIME', async () => {
  const dir = tempDir();
  const txt = writeImage(dir, 'note.txt', 64);
  const noext = path.join(dir, 'plain');
  fs.writeFileSync(noext, Buffer.alloc(64, 1));
  const h = harness({ outboundAllow: RELAY_ALLOW_DM });

  for (const file of [txt, noext]) {
    const r = await h.gateway.sendFromTool({
      sessionKey: 'qq-private-10000001',
      items: [{ kind: 'image', path: file }],
    });
    assert.equal(r.ok, false, `${path.basename(file)} 应该被拒`);
    assert.match(r.note, /只认 jpg/);
  }
  assert.equal(h.transport.sent.length, 0);
});

test('★ 闸：`file://` 一律拒（别让她读本机任意文件）', async () => {
  const h = harness({ outboundAllow: RELAY_ALLOW_DM });
  const r = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [{ kind: 'image', path: 'file:///H:/x/a.png' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /file:\/\//);
});

test('★ 闸：URL 只认 http/https 且有图片扩展名；https 图能发（走 url 段）', async () => {
  const h = harness({ outboundAllow: RELAY_ALLOW_DM });

  const bad = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [{ kind: 'image', path: 'ftp://x/a.png' }],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.note, /http\/https/);

  const noExt = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [{ kind: 'image', path: 'https://example.com/image?id=1' }],
  });
  assert.equal(noExt.ok, false);
  assert.match(noExt.note, /只认 jpg/);

  const good = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [{ kind: 'image', path: 'https://example.com/a.webp' }],
  });
  assert.equal(good.ok, true);
  assert.deepEqual(h.transport.sent[0].message, [
    { type: 'image', data: { url: 'https://example.com/a.webp' } },
  ]);
});

test('★ 闸：群里发图照旧过白名单（名单外的群一张都不发）', async () => {
  const dir = tempDir();
  const file = writeImage(dir, 'e.png', 512);
  const h = harness({ outboundAllow: RELAY_ALLOW_DM });

  const r = await h.gateway.sendFromTool({
    sessionKey: 'qq-group-999999999',
    items: [{ kind: 'image', path: file }],
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /白名单/);
  assert.equal(h.transport.sent.length, 0);
});

test('★ 闸：图 + 文合计最多 3 条（第 4 条整批拒）', async () => {
  const dir = tempDir();
  const file = writeImage(dir, 'f.png', 512);
  const h = harness({ outboundAllow: RELAY_ALLOW_DM });
  const r = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [
      { kind: 'text', text: '1' },
      { kind: 'text', text: '2' },
      { kind: 'image', path: file },
      { kind: 'image', path: file },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /最多 3 条/);
  assert.equal(h.transport.sent.length, 0);
});

test('闸：图注也计入 6000 字上限（图不是绕开字数闸的后门）', async () => {
  const dir = tempDir();
  const file = writeImage(dir, 'g.png', 512);
  const h = harness({ outboundAllow: RELAY_ALLOW_DM });
  const r = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [{ kind: 'image', path: file, caption: '啊'.repeat(6001) }],
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /超过上限/);
});

test('闸：空 path ⇒ 拒（说清楚要配 path）', async () => {
  const h = harness({ outboundAllow: RELAY_ALLOW_DM });
  const r = await h.gateway.sendFromTool({
    sessionKey: 'qq-private-10000001',
    items: [{ kind: 'image' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /path/);
});
