/**
 * OneBot **标准**段格式（`{type, data:{...}}`）的回归测试。
 *
 * ## 为什么单独一组
 *
 * 项目里绝大多数测试夹具把段手写成**已压平**的 `{type:'text', text:'hi'}`，
 * 而 NapCat 实际发的是规范形状 `{type:'text', data:{text:'hi'}}`
 * （配置项 `messagePostFormat: "array"`）。
 *
 * `toSegments` 曾经只做 CQ 反转义、**不压平 `data`**，于是真实 NapCat 来的消息：
 *   - `text` 永远是空串（正文丢失）
 *   - `mentioned` 永远是 false（@ 检测不到 → 群聊里永远不理人）
 *
 * 而全量测试照样绿，因为夹具是压平形状。这是本项目第三次栽在同一类盲区
 * （前两次：WebSocket 握手 key 长度、HTTP action 的 `params` 包装）——
 * **测试替身必须模仿真实对端的形状**。
 *
 * 所以这组测试**刻意只用规范形状**，专门守住压平这一步。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toSegments, segmentsToText, detectMention, normalizeEvent } from '../src/onebot/protocol.mjs';

const SELF = '10000003';

/** 造一个 NapCat 形状的群消息事件（段用**规范**的 data 嵌套）。 */
function groupEvent({ message, raw = '', userId = '10000001', nickname = '用户', messageId = 1 }) {
  return {
    time: 1_700_000_000,
    self_id: Number(SELF),
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: 200000001,
    user_id: Number(userId),
    raw_message: raw,
    font: 0,
    sender: { user_id: Number(userId), nickname, card: '' },
    message,
  };
}

// ---------------------------------------------------------------- 压平

test('toSegments：规范形状的 data 被压平到顶层', () => {
  const out = toSegments([{ type: 'text', data: { text: 'hi' } }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'text');
  assert.equal(out[0].text, 'hi', 'data.text 必须被压到顶层，否则下游读不到');
});

test('toSegments：at 段同样压平（qq 到顶层）', () => {
  const out = toSegments([{ type: 'at', data: { qq: SELF } }]);
  assert.equal(out[0].qq, SELF);
});

test('toSegments：已压平的形状仍然可用（两种都接受）', () => {
  const out = toSegments([{ type: 'text', text: 'hi' }]);
  assert.equal(out[0].text, 'hi');
});

test('toSegments：顶层已有同名键时不被 data 覆盖', () => {
  const out = toSegments([{ type: 'text', text: 'top', data: { text: 'nested' } }]);
  assert.equal(out[0].text, 'top');
});

test('toSegments：image 段的 url/file 也压平', () => {
  const out = toSegments([{ type: 'image', data: { file: 'a.png', url: 'http://x/a.png' } }]);
  assert.equal(out[0].file, 'a.png');
  assert.equal(out[0].url, 'http://x/a.png');
});

test('toSegments：data 非对象时不炸', () => {
  const out = toSegments([{ type: 'text', data: 'weird' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'text');
});

// ---------------------------------------------------------------- 正文

test('segmentsToText：规范形状的文本段能取出正文', () => {
  const segs = toSegments([
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: ' 在吗' } },
  ]);
  assert.equal(segmentsToText(segs), '@10000003 在吗', '这是当年丢正文的那条路径；@ 段还要带上目标');
});

// ---------------------------------------------------------------- @ 检测

test('detectMention：规范形状的 at 段能识别出 @ 机器人', () => {
  const segs = toSegments([
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: ' 在吗' } },
  ]);
  assert.equal(detectMention(segs, '', SELF, ''), true);
});

test('detectMention：@ 别人不算 @ 机器人', () => {
  const segs = toSegments([{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: ' hi' } }]);
  assert.equal(detectMention(segs, '', SELF, ''), false);
});

test('detectMention：@全体成员不算 @ 机器人', () => {
  const segs = toSegments([{ type: 'at', data: { qq: 'all' } }]);
  assert.equal(detectMention(segs, '', SELF, ''), false);
});

// ---------------------------------------------------------------- 端到端归一化

test('normalizeEvent：规范形状的群消息能取出正文与 @ 状态', () => {
  const n = normalizeEvent(
    groupEvent({
      message: [
        { type: 'at', data: { qq: SELF } },
        { type: 'text', data: { text: ' 在吗' } },
      ],
      raw: `[CQ:at,qq=${SELF}] 在吗`,
    }),
  );
  assert.equal(n.text, '@10000003 在吗', '正文不能为空（@ 段渲染出目标）——曾经这里恒为空串');
  assert.equal(n.mentioned, true, '@ 状态必须识别出来——曾经这里恒为 false');
  assert.equal(n.groupId, '200000001');
  assert.equal(n.kind, 'group');
});

test('normalizeEvent：规范形状的普通消息 mentioned 为 false 但正文保留', () => {
  const n = normalizeEvent(
    groupEvent({
      message: [{ type: 'text', data: { text: '今天天气不错' } }],
      raw: '今天天气不错',
    }),
  );
  assert.equal(n.text, '今天天气不错');
  assert.equal(n.mentioned, false);
});

test('normalizeEvent：图片等非文本段压成占位符而非丢失', () => {
  const n = normalizeEvent(
    groupEvent({
      message: [
        { type: 'text', data: { text: '看这个' } },
        { type: 'image', data: { file: 'a.png' } },
      ],
      raw: '看这个[CQ:image,file=a.png]',
    }),
  );
  assert.match(n.text, /看这个/);
  assert.match(n.text, /\[图片/);
});
