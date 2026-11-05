/**
 * B 站卡片短链展开：`onebot/short-link.mjs` + `transport.emitEventFrame` 的接线。
 *
 * 这个文件是**补**出来的：2026-11-03 那个会话写完 `short-link.mjs`、`rich.mjs`、
 * `transport.mjs` 的调用点（`this.emitEventFrame(parsed)`）就被自己的热重载弄崩了
 * （方法还没写 ⇒ `TypeError: this.emitEventFrame is not a function` ⇒ 宿主 fatal），
 * 所以整条链一个测试都没有。**第一条测试就是那个崩溃本身**。
 *
 * 全部零外部依赖：`fetchImpl` 一律注入假实现，**不联一次网**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectShortLinkTargets,
  createShortLinkExpander,
  shortLinkOf,
  videoUrlFromLocation,
  RESOLVED_URL_KEY,
} from '../src/onebot/short-link.mjs';
import { parseCardFields } from '../src/onebot/rich.mjs';
import { OneBotTransport } from '../src/onebot/transport.mjs';

/** 实拍形状的 B 站卡片（只要 `qqdocurl`，其余字段对本测试无意义）。 */
function biliCard(qqdocurl) {
  return {
    ver: '1.0.0.19',
    app: 'com.tencent.miniapp_01',
    meta: {
      detail_1: {
        title: '哔哩哔哩',
        desc: '一个视频',
        qqdocurl,
      },
    },
  };
}

/** NapCat 的 json 段是双层的：`data.data` 才是那串 JSON。 */
function jsonSegment(card) {
  return { type: 'json', data: { data: JSON.stringify(card) } };
}

/** 一条最小可用的 OneBot 事件帧。 */
function eventOf(segments) {
  return JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    self_id: 30000002,
    message: segments,
  });
}

/** `redirect: 'manual'` 拿到的那种响应：只要 `headers.location`。 */
function redirectTo(location) {
  return { headers: new Headers({ location }), url: '' };
}

// ---------------------------------------------------------------- 崩溃回归

test('★ 回归：默认构造的 transport 收到事件帧**不抛**，事件照常同步派发', () => {
  // 2026-11-03 的现场：`handleFrame` 里写着 `this.emitEventFrame(parsed)`，方法不存在。
  // 这条事件帧就是当天压垮宿主的那条（任何 QQ 消息都会压在同一个点上）。
  const transport = new OneBotTransport({ mode: 'reverse' });
  const seen = [];
  transport.on('event', (event) => seen.push(event));

  assert.doesNotThrow(() => transport.handleFrame(eventOf([{ type: 'text', data: { text: '在吗' } }])));
  assert.equal(seen.length, 1, '没有短链时必须是同步派发，行为不能变');
  assert.equal(seen[0].message[0].data.text, '在吗');
});

test('监听方抛异常时**拦下**并记一条 error，不顺着 socket 回调带走宿主', () => {
  const transport = new OneBotTransport({ mode: 'reverse', shortLinks: false });
  const logs = [];
  transport.on('log', (level, message) => logs.push({ level, message }));
  transport.on('event', () => {
    throw new Error('监听方炸了');
  });

  assert.doesNotThrow(() => transport.handleFrame(eventOf([])));
  assert.equal(logs.filter((entry) => entry.level === 'error').length, 1);
});

// ---------------------------------------------------------------- 短链识别

test('只认 `b23.tv`：主机名必须精确相等，协议必须是 http/https', () => {
  assert.equal(shortLinkOf('https://b23.tv/RcVLXMu'), 'https://b23.tv/RcVLXMu');
  assert.equal(shortLinkOf('http://www.b23.tv/RcVLXMu'), 'http://www.b23.tv/RcVLXMu');
  // 以下几种都是"对任意 URL 发请求"的入口，一个都不能认。
  assert.equal(shortLinkOf('https://b23.tv.evil.com/x'), null);
  assert.equal(shortLinkOf('https://evil.com/b23.tv/x'), null);
  assert.equal(shortLinkOf('b23.tv/RcVLXMu'), null); // 缺协议头
  assert.equal(shortLinkOf('ftp://b23.tv/x'), null);
  assert.equal(shortLinkOf(''), null);
  assert.equal(shortLinkOf(undefined), null);
});

test('从 302 的 location 掏视频地址：**必须带 `/video/`**', () => {
  assert.equal(
    videoUrlFromLocation('https://www.bilibili.com/video/BV1jPgH6jE7z?buvid=x&unique_k=RcVLXMu'),
    'https://www.bilibili.com/video/BV1jPgH6jE7z',
  );
  // 用户点名过：不带 `/video/` 的地址打不开 —— 所以拼出来的地址**永远**带 `/video/`。
  assert.equal(
    videoUrlFromLocation('https://www.bilibili.com/BV1jPgH6jE7z'),
    'https://www.bilibili.com/video/BV1jPgH6jE7z',
  );
  // 还是短链本身 / 压根不是 B 站 ⇒ 取不到
  assert.equal(videoUrlFromLocation('https://b23.tv/RcVLXMu'), null);
  assert.equal(videoUrlFromLocation(''), null);
});

test('collectShortLinkTargets 会钻进合并转发里找卡片', () => {
  const flat = { message: [jsonSegment(biliCard('https://b23.tv/RcVLXMu'))] };
  const targets = collectShortLinkTargets(flat);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].url, 'https://b23.tv/RcVLXMu');

  const forwarded = {
    message: [
      {
        type: 'forward',
        data: { content: [{ message: [jsonSegment(biliCard('https://b23.tv/hj62yZf'))] }] },
      },
    ],
  };
  const nested = collectShortLinkTargets(forwarded);
  assert.equal(nested.length, 1);
  assert.equal(nested[0].url, 'https://b23.tv/hj62yZf');
});

// ---------------------------------------------------------------- 展开与渲染

test('展开成功后写回段对象，`parseCardFields` 读到的就是视频地址', async () => {
  const calls = [];
  const expander = createShortLinkExpander({
    fetchImpl: async (url) => {
      calls.push(url);
      return redirectTo('https://www.bilibili.com/video/BV1jPgH6jE7z?buvid=1&unique_k=RcVLXMu');
    },
  });
  const segment = jsonSegment(biliCard('https://b23.tv/RcVLXMu'));
  const event = { message: [segment] };

  await expander.prepareEvent(event);

  assert.deepEqual(calls, ['https://b23.tv/RcVLXMu'], '只发一次、且只问短链本身');
  assert.equal(segment[RESOLVED_URL_KEY], 'https://www.bilibili.com/video/BV1jPgH6jE7z');
  assert.equal(segment.data[RESOLVED_URL_KEY], 'https://www.bilibili.com/video/BV1jPgH6jE7z');
  assert.equal(parseCardFields(segment).url, 'https://www.bilibili.com/video/BV1jPgH6jE7z');
});

test('展开失败（抛错）⇒ 静默退回原短链，卡片一个字段都不丢', async () => {
  const expander = createShortLinkExpander({
    fetchImpl: async () => {
      throw new Error('ETIMEDOUT');
    },
  });
  const segment = jsonSegment(biliCard('https://b23.tv/RcVLXMu'));
  await expander.prepareEvent({ message: [segment] });

  assert.equal(segment[RESOLVED_URL_KEY], undefined);
  const fields = parseCardFields(segment);
  assert.equal(fields === null, false);
  assert.match(fields.url, /^https:\/\/b23\.tv\/RcVLXMu/);
});

// ---------------------------------------------------------------- 传输层接线

test('带短链的事件：等展开完再派发，派生出去的段上已经写好视频地址', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const expander = createShortLinkExpander({
    fetchImpl: async () => {
      await gate;
      return redirectTo('https://www.bilibili.com/video/BV1jPgH6jE7z');
    },
  });
  const transport = new OneBotTransport({ mode: 'reverse', shortLinks: expander });
  const seen = [];
  transport.on('event', (event) => seen.push(event));

  const segment = jsonSegment(biliCard('https://b23.tv/RcVLXMu'));
  transport.handleFrame(eventOf([segment]));
  assert.equal(seen.length, 0, '展开没完就不许派发');

  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.length, 1);
  // 派发出去的是 **handleFrame 自己 JSON.parse 出来的那份**，展开结果写在那份上
  // （不是调用方手里那个 `segment` —— 传输层只碰得到文本）。
  assert.equal(
    seen[0].message[0][RESOLVED_URL_KEY],
    'https://www.bilibili.com/video/BV1jPgH6jE7z',
  );
  assert.equal(parseCardFields(seen[0].message[0]).url, 'https://www.bilibili.com/video/BV1jPgH6jE7z');
});

test('展开器自己抛错时**照常派发**（不能让一条卡片把消息卡死）', () => {
  const transport = new OneBotTransport({
    mode: 'reverse',
    shortLinks: {
      prepareEvent() {
        throw new Error('展开器炸了');
      },
    },
  });
  const seen = [];
  const logs = [];
  transport.on('event', (event) => seen.push(event));
  transport.on('log', (level) => logs.push(level));

  assert.doesNotThrow(() => transport.handleFrame(eventOf([])));
  assert.equal(seen.length, 1);
  assert.equal(logs.includes('warn'), true);
});
