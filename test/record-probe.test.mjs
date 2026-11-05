/**
 * B4（2026-10-25）：**语音段（`record`）** 的三层。
 *
 * ## 真机结论（2026-10-25 05:06，已定）
 * NapCat 的 `record` 段**不带任何转写** —— 实测键只有
 * `type` / `file` / `path` / `url` / `file_size`（没有 `text`）。
 * 所以本部署走的是"未转写"那条路，**不做 SILK 解码**（先不做的理由：要
 * `get_record` + SILK 解码，ffmpeg 解不了 SILK，而且用户还没要求这条）。
 *
 * 三层：
 * 1. **探针**：每条带语音的消息记一份摘要（键名 + 长度，绝不打 base64），
 *    并且**落进调试快照**（`recordProbe`）—— 宿主 logger 不落盘，光打日志查不到。
 * 2. **有转写就直接用**（留给换实现 / 以后 NapCat 开始给转写）：
 *    `segmentsToText` 渲染成 `[语音：<那句话>]`，零成本。
 * 3. **没有转写 ⇒ `[语音（未转写）]`** + 提示词末尾一句"你听不到，别假装听见了"。
 *
 * ⚠️ 音频**不进 DSH 附件**：当前路由没有声明音频输入，塞进去只会被换成占位文本
 * （2026-10-10 静默丢图同款）。所以这里一行附件代码都没有，这是有意的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { segmentsToText, toSegments } from '../src/onebot/protocol.mjs';
import { summarizeRecordSegment } from '../src/dsh/media.mjs';
import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { createOutboundAllow } from '../src/dsh/outbound-allow.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

const T0 = Date.UTC(2026, 4, 1, 12, 0, 0);

// ---------------------------------------------------------------- 渲染（协议层）

test('★ 有转写 ⇒ 渲染成 [语音：那句话]（模型读得到内容，不只看到"这里有条语音"）', () => {
  const segments = toSegments([{ type: 'record', data: { file: 'a.amr', text: ' 晚上早点睡 ' } }]);
  assert.equal(segmentsToText(segments), '[语音：晚上早点睡]');
});

test('★ 没转写 ⇒ [语音（未转写）]（必须说清"未转写"，否则她会当成听过了）', () => {
  const segments = toSegments([{ type: 'record', data: { file: 'a.amr', url: 'http://x/a.amr' } }]);
  assert.equal(segmentsToText(segments), '[语音（未转写）]');
});

test('★ 真机那种段（只有 file/path/url/file_size）⇒ 也是 [语音（未转写）]', () => {
  // 这是 2026-10-25 05:06 线上探针抓到的真实键集合。
  const segments = toSegments([{
    type: 'record',
    data: {
      file: '0aaf0b0abc189e20565a1a629f6afbff.amr',
      path: 'D:\\QQNT\\data\\nt_qq\\nt_data\\Ptt\\2026-10\\Ori\\0aaf0b0abc189e20565a1a629f6afbff.amr',
      url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc',
      file_size: '7035',
    },
  }]);
  assert.equal(segmentsToText(segments), '[语音（未转写）]');
});

test('转写是空白 ⇒ 也回 [语音（未转写）]（别造出 [语音：] 这种半截）', () => {
  const segments = toSegments([{ type: 'record', data: { file: 'a.amr', text: '   ' } }]);
  assert.equal(segmentsToText(segments), '[语音（未转写）]');
});

test('语音夹在一句话中间 ⇒ 位置和内容都对', () => {
  const segments = toSegments([
    { type: 'text', data: { text: '你听：' } },
    { type: 'record', data: { file: 'a.amr', text: '明天见' } },
  ]);
  assert.equal(segmentsToText(segments), '你听：[语音：明天见]');
});

test('keepPlaceholders=false 时语音整体丢掉（"这条到底说没说话"的判断不能被转写骗）', () => {
  const segments = toSegments([{ type: 'record', data: { file: 'a.amr', text: '嗯' } }]);
  assert.equal(segmentsToText(segments, { keepPlaceholders: false }), '');
});

// ---------------------------------------------------------------- 探针摘要（媒体层）

test('★ 摘要只给键名与短值：base64 / 超长字段绝不进日志', () => {
  const huge = 'A'.repeat(5000);
  const summary = summarizeRecordSegment({
    type: 'record',
    data: {
      file: 'a.amr',
      url: 'http://example.invalid/a.amr',
      text: '晚上早点睡',
      duration: 3,
      base64: huge,
      magic: `data:audio/amr;base64,${huge}`,
    },
  });
  assert.deepEqual(summary.keys, ['type', 'data']);
  assert.deepEqual(summary.dataKeys, ['file', 'url', 'text', 'duration', 'base64', 'magic']);
  assert.equal(summary.text, '晚上早点睡');
  assert.equal(summary.textLen, 5);
  assert.equal(summary.duration, 3);
  // 内联载荷只留一句说明（长度可以有，内容不行）
  assert.match(String(summary.base64), /内联载荷/);
  assert.match(String(summary.magic), /内联载荷/);
  assert.equal(JSON.stringify(summary).includes(huge), false, 'base64 内容绝不能出现在摘要里');
});

test('摘要：超长 text 截到 120 字符（探针要能看那句话，但不该把整段贴进日志）', () => {
  const long = '字'.repeat(500);
  const summary = summarizeRecordSegment({ type: 'record', data: { text: long } });
  assert.equal(summary.textLen, 500);
  assert.equal(String(summary.text).length, 121); // 120 + 省略号
});

test('摘要：坏输入不抛', () => {
  assert.deepEqual(summarizeRecordSegment(null), { keys: [] });
  assert.deepEqual(summarizeRecordSegment(undefined), { keys: [] });
  assert.deepEqual(summarizeRecordSegment('x'), { keys: [] });
});

// ---------------------------------------------------------------- 探针接线（网关层）

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
  const prompts = [];
  const engine = new ProactiveEngine({
    config: {
      enabled: false, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0, afterUserMsgCount: 1,
    },
    gauge: async () => ({ speak: false, text: '' }),
    speak: async () => undefined,
    log: () => {},
    now: () => T0,
  });
  const gateway = new Gateway({
    transport,
    router: new Router({
      dmPolicy: POLICY.OPEN, groupPolicy: POLICY.OPEN, requireMention: true, adminUsers: ['9001'],
    }),
    engine,
    outboundAllow: createOutboundAllow({ allowFrom: ['2001'], groupAllowFrom: [] }),
    responder: async (request) => {
      prompts.push(request.prompt);
      return options.reply ?? '';
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    maxReplyChars: 2000,
  });
  gateway.attach();
  return { gateway, logs, prompts };
}

function message(segments) {
  return {
    chatId: 'private:2001',
    kind: 'private',
    userId: '2001',
    nickname: '阿猫',
    text: segmentsToText(segments),
    at: T0,
    mentioned: true,
    replyToSelf: false,
    segments,
    raw: '',
  };
}

test('★ 网关：带语音的一轮会记一行 info 摘要（含 transcribed 判据）', async () => {
  const h = harness();
  const segments = toSegments([{ type: 'record', data: { file: 'a.amr', text: '明早见' } }]);
  await h.gateway.runTurn({
    message: message(segments),
    sessionKey: 'qq-private-2001',
    restricted: false,
    prompt: 'p',
  });
  const hit = h.logs.find((entry) => entry.message.includes('B4 探针'));
  assert.ok(hit, '必须有一条语音探针日志');
  assert.equal(hit.level, 'info', '用 info —— debug 线上可能被过滤掉');
  assert.equal(hit.meta.count, 1);
  assert.equal(hit.meta.transcribed, true);
  assert.equal(hit.meta.records[0].text, '明早见');
});

test('★ 网关：探针同时落进 gateway.lastRecordProbe（日志不落盘，快照才是可查的通道）', async () => {
  const h = harness();
  assert.equal(h.gateway.lastRecordProbe, null, '刚起来时必须是 null');
  await h.gateway.runTurn({
    message: message(toSegments([{ type: 'record', data: { file: 'a.amr', url: 'http://x/a.amr', duration: 3 } }])),
    sessionKey: 'qq-private-2001',
    restricted: false,
    prompt: 'p',
  });
  const probe = h.gateway.lastRecordProbe;
  assert.ok(probe, '必须留下探针结果');
  assert.equal(probe.chatId, 'private:2001');
  assert.equal(probe.count, 1);
  assert.equal(probe.transcribed, false, '没有 text ⇒ false（这条就是"要做 SILK 解码吗"的判据）');
  assert.deepEqual(probe.records[0].dataKeys, ['file', 'url', 'duration']);
  assert.equal(probe.records[0].duration, 3);
});

test('网关：没有语音的消息不记探针（别给每条消息加噪音）', async () => {
  const h = harness();
  await h.gateway.runTurn({
    message: message(toSegments([{ type: 'text', data: { text: '在吗' } }])),
    sessionKey: 'qq-private-2001',
    restricted: false,
    prompt: 'p',
  });
  assert.equal(h.logs.some((entry) => entry.message.includes('B4 探针')), false);
});

// B4（2026-10-25 真机定论）：没有转写 ⇒ 提示词里必须**明说听不到**。
//
// 为什么不能只靠占位符：实测那次她拿到 `[语音]` 之后，第一反应是"内容确实是空的"
// （这次她对），但换个措辞她很容易顺着上下文编一句回答 —— 那比沉默更糟，
// 因为用户会以为她听懂了。所以"你听不到"要写在提示词末尾，紧挨着这一轮。
test('★ 网关：带语音的一轮，提示词里明说"没有转写文字、你听不到"', async () => {
  const h = harness();
  await h.gateway.runTurn({
    message: message(toSegments([{ type: 'record', data: { file: 'a.amr', url: 'http://x/a.amr' } }])),
    sessionKey: 'qq-private-2001',
    restricted: false,
    prompt: 'p',
  });
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /没有转写文字/);
  assert.match(h.prompts[0], /听不到/);
  assert.match(h.prompts[0], /别假装听见/);
});

test('网关：没有语音的一轮，提示词**一个字节都不加**（别给所有轮次塞噪音）', async () => {
  const h = harness();
  await h.gateway.runTurn({
    message: message(toSegments([{ type: 'text', data: { text: '在吗' } }])),
    sessionKey: 'qq-private-2001',
    restricted: false,
    prompt: '只有正文',
  });
  assert.equal(h.prompts[0], '只有正文');
});

test('网关：探针本身炸了也不影响这一轮（挂在每轮上的代码必须自己吞异常）', async () => {
  const h = harness({ reply: '照常回复' });
  const bad = [{
    type: 'record',
    get data() {
      throw new Error('探针读取炸了');
    },
    get text() {
      throw new Error('探针读取炸了');
    },
  }];
  // ⚠️ 这里**不走 `message()`**：那个辅助函数自己会调 `segmentsToText`，
  // 而带 throwing getter 的段在那一层就会炸 —— 那样测的是辅助函数，不是探针。
  const text = await h.gateway.runTurn({
    message: {
      chatId: 'private:2001',
      kind: 'private',
      userId: '2001',
      nickname: '阿猫',
      text: '[语音]',
      at: T0,
      mentioned: true,
      replyToSelf: false,
      segments: bad,
      raw: '',
    },
    sessionKey: 'qq-private-2001',
    restricted: false,
    prompt: 'p',
  });
  assert.equal(text, '照常回复');
  assert.equal(h.logs.some((entry) => entry.level === 'debug' && entry.message.includes('语音探针失败')), true);
});
