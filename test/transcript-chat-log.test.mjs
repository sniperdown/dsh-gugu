/**
 * **本地聊天记录**（`src/dsh/chat-log.mjs`）与它的三个接入点（2026-11-18）。
 *
 * 方案：`shared/2026-11-18-聊天记录方案.md`。这里钉住的都是**硬约束**，不是"功能":
 *
 * | # | 判据 | 为什么钉它 |
 * |---|---|---|
 * | ① | 出站行带 `messageId`（传输层回来的那个 id） | 没有它，引用她自己的话永远对不上（只能退 `get_msg`） |
 * | ② | 失败行 `delivered:false` + `error`，**回灌时一条都读不到** | 否则她会以为那句没发出去的话说过了，从此不再提 |
 * | ③ | 内存先、磁盘后；**写盘失败不冒到发送链** | 反过来会让"写盘失败"被读成"没发出去"而重发 |
 * | ④ | 入站行没有 `messageId` ⇒ **不入库** | 回灌靠它去重，拼假身份会让同一条进转录两遍（模型开始复读） |
 * | ⑤ | 回灌条数 = 转录上限（60），**不因为落盘而变多** | 提到 500 会让每轮输入 token 线性上涨 |
 * | ⑥ | 引用一条"已被挤出窗口 / 跨重启"的消息 ⇒ 本地记录能同步取回原文 | `#findQuoted` 是纯同步的 |
 * | ⑦ | 关着（`enabled:false`）⇒ **一个字节都不碰磁盘** | 测试跑几百次引擎，不能往真实聊天记录里灌假消息 |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createChatLog,
  isReplayable,
  normalizeChatLog,
  normalizeChatLogRow,
  parseChatLogRows,
  redactText,
} from '../src/dsh/chat-log.mjs';
import { Gateway, OUTCOME } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

const T0 = Date.UTC(2026, 4, 1, 12, 0, 0); // UTC+8 ⇒ 20:00
const GROUP_CHAT = 'group:100';
const GROUP_KEY = 'qq-group-100';
const PRIVATE_CHAT = 'private:2001';

/** 临时目录（用完删）。 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-chatlog-'));
}

function readRows(file) {
  return parseChatLogRows(fs.readFileSync(file, 'utf8'));
}

function outRow(overrides = {}) {
  return {
    dir: 'out',
    chatId: PRIVATE_CHAT,
    nickname: '小鲸鱼',
    text: '收到',
    at: T0,
    delivered: true,
    messageId: 900001,
    ...overrides,
  };
}

function inRow(overrides = {}) {
  return {
    dir: 'in',
    chatId: GROUP_CHAT,
    userId: '3001',
    nickname: '阿猫',
    text: '在吗',
    at: T0,
    messageId: 800001,
    ...overrides,
  };
}

function engineWith(chatLog, options = {}) {
  return new ProactiveEngine({
    config: { enabled: false, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0, afterUserMsgCount: 1 },
    gauge: async () => ({ speak: false }),
    speak: async () => undefined,
    log: () => {},
    now: () => T0,
    names: ['小鲸鱼'],
    chatLog,
    ...options,
  });
}

// ====================================================== 行结构（纯函数）

test('行结构：入站没有 messageId ⇒ 不入库（回灌去重只认它）', () => {
  assert.equal(normalizeChatLogRow(inRow({ messageId: undefined })), null);
  assert.equal(normalizeChatLogRow(inRow({ messageId: null })), null);
  assert.equal(normalizeChatLogRow(inRow({ messageId: 'abc' })), null);
  const ok = normalizeChatLogRow(inRow());
  assert.equal(ok.dir, 'in');
  assert.equal(ok.messageId, 800001);
  // 入站行**没有** `delivered` 这个键（"收到"不是"发出去了"）
  assert.equal(Object.hasOwn(ok, 'delivered'), false);
});

test('行结构：出站行 delivered / error / userId / kind 的口径', () => {
  const ok = normalizeChatLogRow(outRow({ wire: 'text,image' }));
  assert.equal(ok.dir, 'out');
  assert.equal(ok.delivered, true);
  assert.equal(ok.userId, '', '出站行的发送者 QQ 是空串（别编一个"自己的号"）');
  assert.equal(ok.kind, 'private', '缺省由 chatId 前缀派生');
  assert.equal(ok.wire, 'text,image');
  assert.equal(Object.hasOwn(ok, 'error'), false, '成功的行不该有 error 键');

  const bad = normalizeChatLogRow(outRow({ delivered: false, error: 'EPIPE' }));
  assert.equal(bad.delivered, false);
  assert.equal(bad.error, 'EPIPE');

  // 失败行没给 error 也要有个真值（空串会让人以为"出过错、错误是空的"）
  assert.equal(normalizeChatLogRow(outRow({ delivered: false })).error, 'unknown');
});

test('行结构：空正文 / 坏时间戳 / 空 chatId 一律丢', () => {
  assert.equal(normalizeChatLogRow(outRow({ text: '   ' })), null);
  assert.equal(normalizeChatLogRow(outRow({ at: 0 })), null);
  assert.equal(normalizeChatLogRow(outRow({ at: 'x' })), null);
  assert.equal(normalizeChatLogRow(outRow({ chatId: '' })), null);
  assert.equal(normalizeChatLogRow(null), null);
});

test('脱敏：redactPatterns 命中替换、坏正则跳过（不抛）', () => {
  assert.equal(redactText('密码是 hunter2', ['hunter2']), '密码是 [已屏蔽]');
  assert.equal(redactText('原样', []), '原样');
  assert.equal(redactText('原样', ['([a-z']), '原样', '坏正则不该让整条记录写不下去');
  const row = normalizeChatLogRow(outRow({ text: 'token=abc' }), { redactPatterns: ['abc'] });
  assert.equal(row.text, 'token=[已屏蔽]');
});

test('回灌闸门 isReplayable：失败行永远 false（R10 钉一条）', () => {
  assert.equal(isReplayable({ delivered: true }), true);
  assert.equal(isReplayable({ delivered: false }), false);
  assert.equal(isReplayable({ dir: 'in' }), true, '入站行没有 delivered 键，也算可回灌');
  assert.equal(isReplayable(null), false);
});

// ====================================================== 落盘

test('关着（enabled:false）⇒ 一个字节都不碰磁盘', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const log = createChatLog({ config: { enabled: false, file } });
    assert.equal(log.record(outRow()), false);
    assert.equal(fs.existsSync(file), false);
    assert.equal(log.stats().writes, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('追加写：一行一条、读得回、stats 对得上', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const log = createChatLog({ config: { enabled: true, file } });
    assert.equal(log.record(inRow({ at: T0 })), true);
    assert.equal(log.record(outRow({ at: T0 + 1000, text: '嗯' })), true);
    const rows = readRows(file);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.dir), ['in', 'out']);
    assert.equal(log.stats().writes, 2);
    assert.equal(log.stats().failures, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 写盘失败（路径不可写）⇒ 不抛、只记 stats.failures', () => {
  const dir = tmpDir();
  try {
    // 把"文件"指到一个**目录**上：appendFileSync 必然抛。
    const log = createChatLog({ config: { enabled: true, file: dir } });
    let threw = false;
    let wrote;
    try {
      wrote = log.record(outRow());
    } catch {
      threw = true;
    }
    assert.equal(threw, false, '写盘失败绝不能抛（它挂在消息热路径上）');
    assert.equal(wrote, false);
    assert.equal(log.stats().failures, 1);
    assert.match(log.stats().lastError, /EISDIR|EPERM|EACCES|EEXIST|ENOTDIR|EBADF/iu);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 回灌：失败行读不到；成功行按会话分组、按时间取最近 N 条', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const log = createChatLog({ config: { enabled: true, file } });
    log.record(outRow({ at: T0, text: '说过的', messageId: 1 }));
    log.record(outRow({ at: T0 + 1000, text: '没发出去的', messageId: 2, delivered: false, error: 'boom' }));
    log.record(inRow({ at: T0 + 2000, text: '别人的', messageId: 3 }));
    log.record(inRow({ at: T0 + 3000, text: '另一个群', messageId: 4, chatId: 'group:200' }));

    const rows = log.loadRecent(PRIVATE_CHAT, 60);
    assert.deepEqual(rows.map((r) => r.text), ['说过的'], '失败行不进回灌');
    assert.equal(log.replayByChat().get(GROUP_CHAT).length, 1, '按 chatId 分组');
    assert.equal(log.replayByChat().get('group:200').length, 1);
    // 最近 1 条
    assert.deepEqual(log.loadRecent(GROUP_CHAT, 1).map((r) => r.text), ['别人的']);
    // 引用回查：失败行查不到（它索引里根本没有）
    assert.equal(log.find(PRIVATE_CHAT, 1)?.text, '说过的');
    assert.equal(log.find(PRIVATE_CHAT, 2), null);
    // 同 id 不同会话不串（R8：不做全局 Map）
    assert.equal(log.find(GROUP_CHAT, 3)?.text, '别人的');
    assert.equal(log.find('group:200', 3), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('裁剪：追到 maxLines×1.5 才裁一次，裁完只留尾部 maxLines 行', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const log = createChatLog({ config: { enabled: true, file, maxLines: 4 } });
    for (let i = 0; i < 6; i += 1) log.record(inRow({ at: T0 + i, text: `第${i}条`, messageId: 100 + i }));
    assert.equal(readRows(file).length, 6, '4×1.5=6 ⇒ 还没过阈值就继续追加（不是每行都裁）');
    log.record(inRow({ at: T0 + 6, text: '第6条', messageId: 106 }));
    const rows = readRows(file);
    assert.equal(rows.length, 4, '过阈值后裁到 maxLines');
    assert.deepEqual(rows.map((r) => r.text), ['第3条', '第4条', '第5条', '第6条'], '留尾部（最旧的先走）');
    assert.equal(log.stats().trims, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ====================================================== 引擎：出站收口

test('★ V1：`noteSelfMessage` 带 messageId ⇒ 转录最后一条有数字 id，并落盘 delivered:true', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const chatLog = createChatLog({ config: { enabled: true, file } });
    const engine = engineWith(chatLog);
    engine.noteSelfMessage(GROUP_CHAT, '在的，我在', T0, { messageId: 1560763351, wire: 'text' });

    const entry = engine.transcript(GROUP_CHAT).snapshot().at(-1);
    assert.equal(entry.messageId, 1560763351);
    assert.equal(entry.fromSelf, true);

    const rows = readRows(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dir, 'out');
    assert.equal(rows[0].delivered, true);
    assert.equal(rows[0].messageId, 1560763351);
    assert.equal(rows[0].text, '在的，我在');
    assert.equal(rows[0].userId, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('不传 messageId ⇒ 转录条目**没有这个键**（不编一个假 id）', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const engine = engineWith(createChatLog({ config: { enabled: true, file } }));
    engine.noteSelfMessage(GROUP_CHAT, '没有 id 的一句', T0);
    const entry = engine.transcript(GROUP_CHAT).snapshot().at(-1);
    assert.equal(Object.hasOwn(entry, 'messageId'), false);
    assert.equal(readRows(file)[0].messageId, null, '拿不到就写 null（不编）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 内存先、磁盘后：落盘炸了也不影响内存那条，更不冒到调用方', () => {
  const boom = {
    record() {
      throw new Error('磁盘炸了');
    },
  };
  const engine = engineWith(boom);
  let threw = false;
  let accepted;
  try {
    accepted = engine.noteSelfMessage(GROUP_CHAT, '照样要说的话', T0, { messageId: 5 });
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  assert.equal(accepted, true, '返回的是"内存收了没有"，与磁盘无关');
  const mine = engine.transcript(GROUP_CHAT).snapshot().filter((m) => m.fromSelf === true);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].text, '照样要说的话');
});

test('★ 回灌：出站行回来了（渲染 `我(小鲸鱼)`），失败行一条都不回来', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const writer = createChatLog({ config: { enabled: true, file } });
    writer.record(outRow({ at: T0, text: '我上午说的那句', messageId: 11 }));
    writer.record(outRow({ at: T0 + 1000, text: '这句没发出去', messageId: 12, delivered: false, error: 'EPIPE' }));
    writer.record(inRow({ at: T0 + 2000, text: '别人接了一句', messageId: 13, chatId: PRIVATE_CHAT, userId: '2001' }));

    // 新引擎 = 重启（`applied()` 里那次 `replayChatLog()`）
    const engine = engineWith(createChatLog({ config: { enabled: true, file } }));
    const rendered = engine.transcript(PRIVATE_CHAT).render(20, null, { now: T0 + 3000 });
    assert.match(rendered, /我\(小鲸鱼\): 我上午说的那句/u);
    assert.match(rendered, /2001\): 别人接了一句/u);
    assert.ok(!rendered.includes('这句没发出去'), '失败行永远不进上下文');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ V1/V5：回灌条数 = 转录上限 60，不因为落盘而变多', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const writer = createChatLog({ config: { enabled: true, file, maxLines: 500 } });
    for (let i = 0; i < 80; i += 1) {
      writer.record(outRow({ at: T0 + i, text: `第${i}句`, messageId: 1000 + i }));
    }
    const engine = engineWith(createChatLog({ config: { enabled: true, file } }));
    const snapshot = engine.transcript(PRIVATE_CHAT).snapshot();
    assert.equal(snapshot.length, 60, 'maxMessages 没被改动，回灌也不许突破它');
    assert.deepEqual(snapshot.slice(-1).map((m) => m.text), ['第79句'], '留的是最近的');
    assert.equal(engine.transcript(PRIVATE_CHAT).render(20).split('\n').length, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('入站：被转录接受才落盘；没有 messageId 的不落（磁盘与内存一致）', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const engine = engineWith(createChatLog({ config: { enabled: true, file } }));
    const base = {
      chatId: GROUP_CHAT,
      kind: 'group',
      userId: '3001',
      nickname: '阿猫',
      at: T0,
      text: '在吗',
      segments: [{ type: 'text', text: '在吗' }],
    };
    assert.equal(engine.ingest({ ...base, messageId: 700001 }), true);
    assert.equal(engine.ingest({ ...base, messageId: undefined, at: T0 + 1, text: '没 id 的' }), true);
    // 时间戳倒退 ⇒ 内存拒 ⇒ 也不许落盘
    assert.equal(engine.ingest({ ...base, messageId: 700002, at: T0 - 5000, text: '倒退的' }), false);
    const rows = readRows(file);
    assert.deepEqual(rows.map((r) => r.text), ['在吗']);
    assert.equal(rows[0].dir, 'in');
    assert.equal(rows[0].messageId, 700001);
    assert.deepEqual(rows[0].wire, 'text');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('decide() 那条路也会落盘（入站主路径）', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const engine = engineWith(createChatLog({ config: { enabled: true, file } }));
    await engine.decide({
      chatId: GROUP_CHAT,
      kind: 'group',
      userId: '3001',
      nickname: '阿猫',
      text: '在吗',
      at: T0,
      messageId: 710001,
      mentioned: true,
    });
    const rows = readRows(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dir, 'in');
    assert.equal(rows[0].messageId, 710001);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 双源去重：`restoreTranscript` 同一条灌两次只留一条（防复读）', () => {
  const engine = engineWith(null);
  const list = [
    { chatId: GROUP_CHAT, userId: '3001', nickname: '阿猫', text: '同一句', at: T0, messageId: 555, kind: 'group' },
  ];
  assert.equal(engine.restoreTranscript(GROUP_CHAT, list), 1);
  assert.equal(engine.restoreTranscript(GROUP_CHAT, list), 0, '第二次一条都不许进');
  assert.equal(engine.transcript(GROUP_CHAT).snapshot().length, 1);
});

// ====================================================== 网关：三处接入点

function harness(options = {}) {
  const transport = {
    selfId: '999',
    sent: [],
    calls: [],
    on() {},
    off() {},
    emit() {},
    async request(action, params, opts) {
      this.calls.push({ action, params, opts });
      return options.request === undefined ? null : options.request(action, params, opts);
    },
    async sendToChat(chatId, message) {
      if (options.failSend === true) throw new Error('发送失败');
      this.sent.push({ chatId, message });
      return options.messageId ?? 1560763351;
    },
  };
  const responded = [];
  const engine = engineWith(options.chatLog ?? null);
  const gateway = new Gateway({
    transport,
    router: new Router({
      dmPolicy: POLICY.OPEN,
      groupPolicy: POLICY.OPEN,
      requireMention: true,
      adminUsers: ['9001'],
    }),
    engine,
    responder: async (request) => {
      responded.push(request);
      return options.reply ?? '回复正文';
    },
    relay: { relay: async () => undefined },
    relayAllow: () => false,
    log: () => {},
    maxReplyChars: 2000,
    autoReply: 'fallback',
    splitMarker: '⟨cut⟩',
    outboundLedger: { record: () => {} },
  });
  gateway.attach();
  return { gateway, engine, transport, responded };
}

function dmEvent({ id = '', messageId = 900001, text = '在吗', at = T0 } = {}) {
  const message = id === ''
    ? [{ type: 'text', data: { text } }]
    : [{ type: 'reply', data: { id } }, { type: 'text', data: { text } }];
  return {
    time: Math.floor(at / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId,
    user_id: 2001,
    message,
    raw_message: id === '' ? text : `[CQ:reply,id=${id}]${text}`,
    sender: { nickname: '阿猫' },
  };
}

test('★ V1（网关）：发出去之后，本地记录里的 messageId 就是传输层回来的那个', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const h = harness({ chatLog: createChatLog({ config: { enabled: true, file } }), reply: '收到', messageId: 4242424 });
    await h.gateway.runTurn({
      message: {
        chatId: PRIVATE_CHAT,
        kind: 'private',
        userId: '2001',
        nickname: '阿猫',
        text: '在吗',
        at: T0,
        segments: [{ type: 'text', text: '在吗' }],
        raw: '在吗',
      },
      sessionKey: 'qq-private-2001',
      restricted: false,
      prompt: '在吗',
    });
    const rows = readRows(file).filter((r) => r.dir === 'out');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].messageId, 4242424);
    assert.equal(rows[0].delivered, true);
    const entry = h.engine.transcript(PRIVATE_CHAT).snapshot().filter((m) => m.fromSelf === true).at(-1);
    assert.equal(entry.messageId, 4242424);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ V9：发送失败 ⇒ 落一条 delivered:false + error；异常**原样**抛出；回灌读不到它', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const chatLog = createChatLog({ config: { enabled: true, file } });
    const h = harness({ chatLog, reply: '这句发不出去', failSend: true });

    await assert.rejects(
      h.gateway.runTurn({
        message: {
          chatId: PRIVATE_CHAT,
          kind: 'private',
          userId: '2001',
          nickname: '阿猫',
          text: '来一句',
          at: T0,
          segments: [{ type: 'text', text: '来一句' }],
          raw: '来一句',
        },
        sessionKey: 'qq-private-2001',
        restricted: false,
        prompt: '来一句',
      }),
      /发送失败/u,
      '异常必须原样往上冒（一个字节都没改）',
    );
    const rows = readRows(file);
    const failed = rows.filter((r) => r.dir === 'out');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].delivered, false);
    assert.match(failed[0].error, /发送失败/u);
    assert.equal(failed[0].text, '这句发不出去');

    // 引擎内存里那一条**没有**（失败的行不进上下文）
    assert.equal(h.engine.transcript(PRIVATE_CHAT).snapshot().filter((m) => m.fromSelf === true).length, 0);
    // 换个"新引擎"（= 重启）回灌，也读不到
    const fresh = engineWith(createChatLog({ config: { enabled: true, file } }));
    const rendered = fresh.transcript(PRIVATE_CHAT).render(20, null, { now: T0 });
    assert.ok(!rendered.includes('这句发不出去'), '失败行永远不进提示词');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ V8：引用一条不在转录里的旧消息 ⇒ 本地记录同步取回原文，不再问 get_msg', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'qq-chatlog.jsonl');
    const chatLog = createChatLog({ config: { enabled: true, file } });
    // 她一小时前说过的话：已被挤出 60 条窗口 / 跨重启都不在内存里了
    chatLog.record(outRow({
      chatId: PRIVATE_CHAT,
      text: '我上午说的那句',
      at: T0 - 3_600_000,
      messageId: 1627760367,
      nickname: '小鲸鱼',
    }));
    const h = harness({ chatLog });
    const result = await h.gateway.handleEvent(dmEvent({ id: '1627760367' }));
    assert.equal(result.outcome, OUTCOME.DISPATCHED);
    const prompt = h.responded.at(-1).prompt;
    assert.match(prompt, /我\(小鲸鱼\): 我上午说的那句/u, '原文要从本地记录里取回来');
    assert.ok(!prompt.includes('原文没找到'));
    assert.equal(h.transport.calls.length, 0, '本地记录命中了就一次都不许问 get_msg');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('关掉聊天记录 ⇒ 消息照发，摘要里也没什么可写的（V4 的杀开关）', async () => {
  const h = harness({ chatLog: null, reply: '照样发' });
  await h.gateway.handleEvent(dmEvent({ text: '在吗' }));
  assert.equal(h.transport.sent.length, 1);
  assert.equal(h.engine.chatLogStats(), null);
});
