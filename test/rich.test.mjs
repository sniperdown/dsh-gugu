/**
 * 富化入站消息测试：合并转发 / 文件。
 *
 * 这些用例的形状全部取自**真实数据**（NapCat 给的 forward 段实拍），
 * 不是照着想象写的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_MESSAGES,
  expandRichText,
  renderRichText,
} from '../src/onebot/rich.mjs';

/** 造一条转发内嵌消息（字段与真实数据一致）。 */
function inner(nickname, text, extra = {}) {
  return {
    self_id: 10000003,
    user_id: 10000001,
    time: 1790989850,
    sender: { user_id: 10000001, nickname, card: '' },
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    ...extra,
  };
}

/** 造一个 forward 段。 */
function forward(contents) {
  return { type: 'forward', data: { id: '7692261023301756951', content: contents } };
}

test('renderRichText：把合并转发展开成「发言人: 内容」', () => {
  const out = renderRichText([
    forward([inner('用户', '请转主会话'), inner('小鲸鱼', '收到')]),
  ]);
  assert.match(out, /合并转发 2 条/);
  assert.match(out, /用户: 请转主会话/);
  assert.match(out, /小鲸鱼: 收到/);
  // 真实数据里 sender.card 常是空串 —— 要能回退到 nickname
  assert.doesNotMatch(out, /undefined/);
});

test('renderRichText：sender.card 优先于 nickname（群名片）', () => {
  const out = renderRichText([
    forward([inner('真名', '内容', { sender: { user_id: 1, nickname: '真名', card: '群名片' } })]),
  ]);
  assert.match(out, /群名片: 内容/);
  assert.doesNotMatch(out, /真名: 内容/);
});

test('renderRichText：没有 content 时**不假装看过**，退回占位符', () => {
  assert.equal(renderRichText([{ type: 'forward', data: { id: 'x' } }]), '[合并转发]');
  assert.equal(renderRichText([forward([])]), '[合并转发 0 条]');
});

test('renderRichText：条数超限会截断并说明还剩多少', () => {
  const many = Array.from({ length: 50 }, (_, i) => inner('人', `第${i}条`));
  const out = renderRichText([forward(many)], { maxMessages: 5 });
  assert.match(out, /第0条/);
  assert.match(out, /第4条/);
  assert.doesNotMatch(out, /第5条/, '超出的不该出现');
  assert.match(out, /还有 45 条未展开/);
});

test('renderRichText：字符超限会停下（防止一条转发撑爆上下文）', () => {
  const long = Array.from({ length: 30 }, (_, i) => inner('人', 'x'.repeat(200) + i));
  const out = renderRichText([forward(long)], { maxChars: 500 });
  assert.ok(out.length < 900, `展开后不该超过上限太多，实际 ${out.length}`);
  assert.match(out, /未展开/);
});

test('renderRichText：嵌套转发按深度递归，到顶就退回占位符', () => {
  const nested = inner('甲', '', {
    message: [forward([inner('乙', '深层内容')])],
    raw_message: '',
  });
  const out = renderRichText([forward([nested])]);
  assert.match(out, /深层内容/, '默认深度内应该钻得进去');

  // 深度为 0 时不该递归
  const shallow = renderRichText([forward([nested])], { maxDepth: 0 });
  assert.doesNotMatch(shallow, /深层内容/);
});

test('renderRichText：文件段带名字和大小', () => {
  const out = renderRichText([
    { type: 'file', data: { name: '报告.pdf', size: 2 * 1024 * 1024 } },
  ]);
  assert.match(out, /\[文件: 报告\.pdf 2\.0MB\]/);

  // 没有 size 的也别崩
  const noSize = renderRichText([{ type: 'file', data: { name: 'x.txt' } }]);
  assert.match(noSize, /\[文件: x\.txt\]/);
});

test('renderRichText：文件**没名字**时退回 `[文件]`，不编"未知文件"', () => {
  // 实测踩到：编出来的「未知文件」把验收用例的 `[视频][文件]` 变成了
  // `[视频][文件: 未知文件]` —— 多出来的字没有信息量，只是噪音。
  assert.equal(renderRichText([{ type: 'file', data: {} }]), '[文件]');
  assert.equal(renderRichText([{ type: 'file', data: { name: '  ' } }]), '[文件]');
  // 有 file 字段但没 name 时，file 可以当名字用
  assert.match(renderRichText([{ type: 'file', data: { file: 'a.zip' } }]), /\[文件: a\.zip\]/);
});

test('renderRichText：普通文本 / 图片 / 表情照旧走原规则', () => {
  // ⚠️ 顶层段是**归一化后**的形状（`{type:'text', text}`），不是 OneBot 原生的
  // `{type:'text', data:{text}}` —— 后者只出现在 forward 的 content 里（由 toSegments 负责）。
  const out = renderRichText([
    { type: 'text', text: '在吗' },
    { type: 'image' },
    { type: 'face' },
  ]);
  assert.match(out, /在吗/);
  assert.match(out, /\[图片\]/);
  assert.match(out, /\[表情\]/);
});

test('renderRichText：转发内层用的是 OneBot 原生格式（data.text），也要认得', () => {
  const out = renderRichText([
    forward([{ type: 'text', data: { text: '原生格式' } }].map((m) => ({
      sender: { nickname: '甲', card: '' },
      message: [m],
      raw_message: '原生格式',
    }))),
  ]);
  assert.match(out, /甲: 原生格式/);
});

test('expandRichText：没有可展开的段就返回 null（不改动既有行为）', () => {
  assert.equal(expandRichText([{ type: 'text', data: { text: '普通消息' } }]), null);
  assert.equal(expandRichText([{ type: 'image', data: {} }]), null);
  assert.equal(expandRichText([]), null);
  assert.equal(expandRichText(null), null);
});

test('expandRichText：有转发就返回展开后的正文', () => {
  const out = expandRichText([forward([inner('甲', '内容')])]);
  assert.ok(out !== null);
  assert.match(out, /甲: 内容/);
});

test('默认上限是合理的（防呆：别被改成 0 或巨大值）', () => {
  assert.ok(DEFAULT_MAX_MESSAGES >= 10 && DEFAULT_MAX_MESSAGES <= 100);
  assert.ok(DEFAULT_MAX_DEPTH >= 1 && DEFAULT_MAX_DEPTH <= 5);
});
