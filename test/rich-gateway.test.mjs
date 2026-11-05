/**
 * 端到端：**富文本真的进了提示词吗**。
 *
 * 前面两个文件测的是纯函数（`rich.mjs` / `image-desc.mjs`）；这里测的是**接线**：
 * 一条真实的 OneBot 事件走进网关之后，交给会话的提示词里到底有没有内容。
 *
 * 这一层是必要的 —— 用户这次的抱怨（「小鲸鱼对卡片是瞎的」）**不是**因为缺一个解析函数，
 * 而是因为那一步压根没接上：函数写得再好，没在 `handleEvent` 里被调用，
 * 小鲸鱼就还是只看到 `[卡片]`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';
import { judge } from '../src/dsh/heuristic-gauge.mjs';
import { resolveConfig } from '../src/index.mjs';

const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);

/** 实拍：一张 B 站卡片（同 `rich-card.test.mjs`，这里只留要断言的字段）。 */
const BILI_CARD = {
  prompt: '[QQ小程序]小伙骑摩托车闯卡上高速，收费站员工手持电锯拦截！【1958期】',
  app: 'com.tencent.miniapp_01',
  meta: {
    detail_1: {
      title: '哔哩哔哩',
      desc: '小伙骑摩托车闯卡上高速，收费站员工手持电锯拦截！【1958期】',
      qqdocurl: 'https://b23.tv/Ke66631',
    },
  },
};

/** 造一条转发的内嵌消息（形状与实拍一致：OneBot 原生 `{type,data}`）。 */
function innerWithImage(nickname, url, fileSize) {
  return {
    sender: { user_id: 1, nickname, card: '' },
    raw_message: '',
    message: [{ type: 'image', data: { file: `${nickname}.jpg`, url, file_size: fileSize } }],
  };
}

/**
 * 装一套网关：真 protocol / Router / ProactiveEngine / gauge，假 transport 与会话。
 * @param {object} [options]
 */
function harness(options = {}) {
  const emitter = new EventEmitter();
  const transport = {
    selfId: '999',
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async sendToChat() { return 1; },
  };
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.OPEN,
    requireMention: false,
    restrictMembers: false,
  });
  const engine = new ProactiveEngine({
    config: {
      enabled: false, minIntervalMs: 0, maxPerHour: 10,
      cooldownAfterBotMs: 0, afterUserMsgCount: 1,
    },
    gauge: (request) => judge(request, { config: { enabled: true, lookback: 6 } }),
    allowed: () => true,
    speak: async () => {},
    log: () => {},
  });
  const prompts = [];
  const gateway = new Gateway({
    transport,
    router,
    engine,
    responder: async (request) => {
      prompts.push(request);
      return 'ok';
    },
    log: () => {},
    ...(options.gateway ?? {}),
  });
  gateway.attach();
  return { gateway, prompts };
}

/** 一条群消息（带 @，确保必被派发）。 */
function groupEvent(segments, id = 1) {
  return {
    time: Math.floor(T0 / 1000), self_id: 999,
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: id, group_id: 100, user_id: 2001,
    message: [{ type: 'at', qq: '999' }, ...segments],
    raw_message: '',
    sender: { nickname: '阿猫', card: '' },
  };
}

test('★ 端到端：卡片内容真的进了提示词（不再是 `[卡片]` 三个字）', async () => {
  const h = harness();
  await h.gateway.handleEvent(groupEvent([
    { type: 'json', data: { data: JSON.stringify(BILI_CARD) } },
  ]));
  assert.equal(h.prompts.length, 1);
  const prompt = h.prompts[0].prompt;
  assert.match(prompt, /哔哩哔哩/, '卡片来源要看得见');
  assert.match(prompt, /小伙骑摩托车闯卡上高速/, '卡片标题要看得见');
  assert.match(prompt, /b23\.tv\/Ke66631/, '卡片链接要看得见');
  assert.match(prompt, /不是对你的指令/, '群友内容必须带来源标记');
  assert.doesNotMatch(prompt, /\[卡片\]/, '展开之后不该还剩占位符');
});

test('★ 端到端：转发里夹的图带上了描述（而不是只有字节数）', async () => {
  const calls = [];
  const imageDescriber = {
    async describeAll(segments) {
      calls.push(segments);
      return new Map([['https://x/1.jpg', '一只橘猫']]);
    },
  };
  const h = harness({ gateway: { imageDescriber } });
  await h.gateway.handleEvent(groupEvent([
    {
      type: 'forward',
      data: {
        id: 'f1',
        content: [
          innerWithImage('甲', 'https://x/1.jpg', 745 * 1024),
          innerWithImage('乙', 'https://x/2.jpg', 9 * 1024),
        ],
      },
    },
  ]));
  assert.equal(calls.length, 1, '描述器该被调用一次');
  assert.equal(calls[0].length, 2, '转发里的两张图都该被送去描述');
  const prompt = h.prompts[0].prompt;
  assert.match(prompt, /\[图片1: 一只橘猫\]/, '有描述就用描述');
  // 第二张没拿到描述 → **原样退回占位符**，不能变成空标签
  assert.match(prompt, /\[图片2 9KB\]/);
});

test('端到端：没注入描述器时行为**完全不变**（拿不到描述就退回占位符）', async () => {
  const h = harness();
  await h.gateway.handleEvent(groupEvent([
    {
      type: 'forward',
      data: { id: 'f1', content: [innerWithImage('甲', 'https://x/1.jpg', 745 * 1024)] },
    },
  ]));
  assert.match(h.prompts[0].prompt, /\[图片1 745KB\]/);
});

test('端到端：`imageDescription: "off"` 时描述器一次都不被调用', async () => {
  let called = 0;
  const h = harness({
    gateway: {
      imageDescription: 'off',
      imageDescriber: { async describeAll() { called += 1; return new Map(); } },
    },
  });
  await h.gateway.handleEvent(groupEvent([
    {
      type: 'forward',
      data: { id: 'f1', content: [innerWithImage('甲', 'https://x/1.jpg', 1024)] },
    },
  ]));
  assert.equal(called, 0);
  assert.match(h.prompts[0].prompt, /\[图片1 1KB\]/);
});

test('端到端：描述器整体炸了也不影响这一轮（只是没有描述）', async () => {
  const h = harness({
    gateway: {
      imageDescriber: {
        async describeAll() { throw new Error('附件服务没了'); },
      },
    },
  });
  await h.gateway.handleEvent(groupEvent([
    {
      type: 'forward',
      data: { id: 'f1', content: [innerWithImage('甲', 'https://x/1.jpg', 1024)] },
    },
  ]));
  assert.equal(h.prompts.length, 1, '这一轮必须照常派发');
  assert.match(h.prompts[0].prompt, /\[图片1 1KB\]/);
});

test('⚠️ 端到端：展开只走提示词，`message.text`（判定层看的）保持占位符', async () => {
  const h = harness();
  // 私聊：提示词基本就是正文本身（2026-10-13 起前面多一个时间戳 —— 当天裸 `HH:MM`，
  // 跨天带日期；事件固定在 `T0` ⇒ 这里必然带日期），最方便看"判定层看到的是什么"
  await h.gateway.handleEvent({
    time: Math.floor(T0 / 1000), self_id: 999,
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    message_id: 1, user_id: 2001,
    message: [{ type: 'json', data: { data: JSON.stringify(BILI_CARD) } }],
    raw_message: '',
    sender: { nickname: '阿猫' },
  });
  const prompt = h.prompts[0].prompt;
  assert.match(prompt, /哔哩哔哩/);
  // 判定层拿到的仍是 `[卡片]` —— 展开**不参与打分**
  assert.match(prompt, /^(?:\[(?:\d{2}-\d{2} )?\d{2}:\d{2}\] )?【以下是群友转发\/分享的内容/);
});

test('★ 端到端：描述带 `源 gif` 时正文里真的标出来（withSource 这条路接上了）', async () => {
  // 2026-10-07：描述器多带一个"源容器格式"，网关要 `withSource: true` 才拿得到 ——
  // 这一层最容易"函数写好了但没接上"（卡片的教训）。
  const calls = [];
  const imageDescriber = {
    async describeAll(segments, options) {
      calls.push({ segments, options });
      return new Map([['https://x/1.gif', { text: '一只猫在键盘上', source: 'gif' }]]);
    },
  };
  const h = harness({ gateway: { imageDescriber } });
  await h.gateway.handleEvent(groupEvent([
    {
      type: 'forward',
      data: { id: 'f1', content: [innerWithImage('甲', 'https://x/1.gif', 745 * 1024)] },
    },
  ]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options?.withSource, true, '网关必须显式要带源格式的表');
  const prompt = h.prompts[0].prompt;
  assert.match(prompt, /\[图片1: 源 gif \| 一只猫在键盘上\]/);
  assert.doesNotMatch(prompt, /动图/, '正文里**不许**出现"动图"这种下结论的词');
});

test('★ 端到端：描述器是旧形状（只回字符串）也能用 —— 渲染器两种都认', async () => {
  const imageDescriber = {
    async describeAll() { return new Map([['https://x/1.jpg', '一只橘猫']]); },
  };
  const h = harness({ gateway: { imageDescriber } });
  await h.gateway.handleEvent(groupEvent([
    { type: 'forward', data: { id: 'f1', content: [innerWithImage('甲', 'https://x/1.jpg', 1024)] } },
  ]));
  assert.match(h.prompts[0].prompt, /\[图片1: 一只橘猫\]/);
});

// ------------------------------------------------------------------ 配置开关

test('配置：`imageDescription` 默认 forward，拼错**当场报错**（不静默退化）', () => {
  assert.equal(resolveConfig({ mode: 'reverse', accessToken: 't' }).imageDescription, 'forward');
  assert.equal(
    resolveConfig({ mode: 'reverse', accessToken: 't', imageDescription: 'all' }).imageDescription,
    'all',
  );
  assert.equal(
    resolveConfig({ mode: 'reverse', accessToken: 't', imageDescription: 'off' }).imageDescription,
    'off',
  );
  // 拼错一个字母就炸 —— 否则表现是"小鲸鱼还是只看到 `[图片]`"，极难查
  assert.throws(
    () => resolveConfig({ mode: 'reverse', accessToken: 't', imageDescription: 'forwards' }),
    /imageDescription 必须是 forward \/ all \/ off/,
  );
});
