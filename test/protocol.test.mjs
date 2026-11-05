/**
 * OneBot 11 协议层测试。表格驱动 + 真机偏差回归。
 *
 * 这一层的价值全在"实现之间的偏差"上：段数组 vs CQ 串、`&amp;` 转义、
 * 昵称字段三选一、群系统提示混进 message 事件……每一条都对应一个真机上会犯的错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCqString,
  cqUnescape,
  cqEscape,
  toSegments,
  segmentsToText,
  detectMention,
  isReplyToSelf,
  detectReplyToId,
  sanitizeNickname,
  buildChatId,
  splitChatId,
  normalizeEvent,
  textToSegments,
  mentionSegments,
} from '../src/onebot/protocol.mjs';

// ---------------------------------------------------------------- CQ 转义

test('CQ 反转义：NapCat 把 & 转成 &amp; 是真实事故根因', () => {
  // 这条是回归用例：不反转义去下载图片会 403。
  assert.equal(cqUnescape('https://x.com/a?b=1&amp;c=2'), 'https://x.com/a?b=1&c=2');
  assert.equal(cqUnescape('&#91;x&#93;'), '[x]');
  assert.equal(cqUnescape('a&#44;b'), 'a,b');
  // 顺序敏感：[ 的反转义不能吃掉后面新产生的实体。
  assert.equal(cqUnescape('&amp;#91;'), '&#91;');
});

test('CQ 反转义对非字符串输入安全', () => {
  assert.equal(cqUnescape(undefined), '');
  assert.equal(cqUnescape(null), '');
  assert.equal(cqUnescape(42), '');
});

test('CQ 转义与反转义互逆（往返）', () => {
  const raw = 'a&b[c],d';
  assert.equal(cqUnescape(cqEscape(raw)), raw);
});

// ---------------------------------------------------------------- CQ 解析

test('parseCqString：纯文本', () => {
  assert.deepEqual(parseCqString('你好'), [{ type: 'text', text: '你好' }]);
});

test('parseCqString：空串与非法输入', () => {
  assert.deepEqual(parseCqString(''), []);
  assert.deepEqual(parseCqString(undefined), []);
  assert.deepEqual(parseCqString(null), []);
});

test('parseCqString：单个 at 段与文本混合', () => {
  const segments = parseCqString('[CQ:at,qq=123] 说话');
  assert.deepEqual(segments, [
    { type: 'at', qq: '123' },
    { type: 'text', text: ' 说话' },
  ]);
});

test('parseCqString：带 &amp; 的图片 URL', () => {
  const segments = parseCqString('[CQ:image,file=x.jpg,url=https://a.com/i?x=1&amp;y=2]');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, 'image');
  assert.equal(segments[0].url, 'https://a.com/i?x=1&y=2');
});

test('parseCqString：值里含逗号（转义形式）', () => {
  const segments = parseCqString('[CQ:image,file=a&#44;b.jpg]');
  assert.equal(segments[0].file, 'a,b.jpg');
});

test('parseCqString：多个段与空字段', () => {
  const segments = parseCqString('[CQ:face,id=1][CQ:at,qq=9][CQ:image]tail');
  assert.deepEqual(segments, [
    { type: 'face', id: '1' },
    { type: 'at', qq: '9' },
    { type: 'image' },
    { type: 'text', text: 'tail' },
  ]);
});

test('parseCqString：无 = 的畸形字段被跳过而不是崩掉', () => {
  const segments = parseCqString('[CQ:image,broken,file=a.jpg]');
  assert.equal(segments[0].type, 'image');
  assert.equal(segments[0].file, 'a.jpg');
  assert.equal(segments[0].broken, undefined);
});

// ---------------------------------------------------------------- toSegments

test('toSegments：段数组优先于 CQ 串', () => {
  const segments = toSegments([{ type: 'text', text: '段数组' }], '[CQ:face,id=1]');
  assert.deepEqual(segments, [{ type: 'text', text: '段数组' }]);
});

test('toSegments：段数组为空时回退到 CQ 串', () => {
  const segments = toSegments([], '[CQ:face,id=1]');
  assert.deepEqual(segments, [{ type: 'face', id: '1' }]);
});

test('toSegments：丢弃无 type 的畸形段', () => {
  const segments = toSegments([{ type: 'text', text: 'ok' }, { foo: 1 }, null, 'x'], '');
  assert.deepEqual(segments, [{ type: 'text', text: 'ok' }]);
});

test('toSegments：message 缺失时用 raw_message', () => {
  const segments = toSegments(undefined, 'raw 文本');
  assert.deepEqual(segments, [{ type: 'text', text: 'raw 文本' }]);
});

// ---------------------------------------------------------------- segmentsToText

test('segmentsToText：非文本段压成占位符（@ 段带上目标，不再是空占位）', () => {
  const segments = [
    { type: 'at', qq: '1' },
    { type: 'text', text: '看这个 ' },
    { type: 'image' },
    { type: 'record' },
    { type: 'video' },
    { type: 'file' },
  ];
  // 语音的占位符带"未转写"（B4 2026-10-25：NapCat 的 record 段没有 text 字段）。
  assert.equal(segmentsToText(segments), '@1看这个 [图片][语音（未转写）][视频][文件]');
});

test('segmentsToText：未知段类型有兜底占位符，不会静默消失', () => {
  assert.equal(segmentsToText([{ type: 'brand_new_thing' }]), '[brand_new_thing]');
});

test('segmentsToText：reply 段不占正文位置', () => {
  const segments = [{ type: 'reply', id: '1' }, { type: 'text', text: '就这样' }];
  assert.equal(segmentsToText(segments), '就这样');
});

test('segmentsToText：keepPlaceholders=false 时只剩纯文本', () => {
  const segments = [{ type: 'image' }, { type: 'text', text: '说明' }];
  assert.equal(segmentsToText(segments, { keepPlaceholders: false }), '说明');
});

test('segmentsToText：首尾空白被去掉', () => {
  assert.equal(segmentsToText([{ type: 'text', text: '  hi  ' }]), 'hi');
});

// ---------------------------------------------------------------- @ 检测

function atSelf(botQQ = '999') {
  return { segments: [{ type: 'at', qq: botQQ }, { type: 'text', text: '在吗' }], raw: '' };
}

test('detectMention：段数组里的 at 命中', () => {
  const { segments, raw } = atSelf();
  assert.equal(detectMention(segments, raw, '999'), true);
});

test('detectMention：@全体成员不算 @ 机器人', () => {
  assert.equal(detectMention([{ type: 'at', qq: 'all' }], '', '999', '999'), false);
});

test('detectMention：@别人不算', () => {
  assert.equal(detectMention([{ type: 'at', qq: '111' }], '', '999', '999'), false);
});

test('detectMention：fail-closed —— 不知道机器人 QQ 时一律视为未 @', () => {
  // 这是刻意的：多回一句废话的代价远小于在群里对每条消息都应答。
  const { segments, raw } = atSelf();
  assert.equal(detectMention(segments, raw, '', undefined), false);
  assert.equal(detectMention(segments, raw, undefined, undefined), false);
});

test('detectMention：self_id 与配置 botQQ 任一命中即可', () => {
  const segments = [{ type: 'at', qq: '888' }];
  assert.equal(detectMention(segments, '', '999', '888'), true);
  assert.equal(detectMention(segments, '', '999', undefined), false);
});

test('detectMention：段数组缺失时回退查 CQ 串', () => {
  assert.equal(detectMention([], '[CQ:at,qq=999] 来', '999'), true);
  assert.equal(detectMention([], '[CQ:at,qq=111] 来', '999'), false);
});

test('detectMention：数字型 qq 字段与字符串型 selfId 也要能匹配', () => {
  // 真机上 self_id 有时是数字、段的 qq 有时是字符串，比较必须走字符串化。
  assert.equal(detectMention([{ type: 'at', qq: 999 }], '', '999'), true);
  assert.equal(detectMention([{ type: 'at', qq: '999' }], '', '999'), true);
  assert.equal(detectMention([{ type: 'at', qq: 999 }], '', '999', '999'), true);
  assert.equal(detectMention([{ type: 'at', qq: 998 }], '', '999', '999'), false);
});

test('isReplyToSelf：判定不了时返回 false（fail-closed）', () => {
  assert.equal(isReplyToSelf([{ type: 'reply', id: '1' }], '999'), false, '只给 id 时无法判定');
  assert.equal(isReplyToSelf([{ type: 'reply', user_id: '999' }], '999'), true);
  assert.equal(isReplyToSelf([{ type: 'reply', user_id: '111' }], '999'), false);
  assert.equal(isReplyToSelf([{ type: 'reply', user_id: '999' }], ''), false);
});

// ---------------------------------------------------------------- 引用了哪一条

test('detectReplyToId：真机 NapCat 的 reply 段（{type,data:{id}}）取得到被引用 id', () => {
  // 样本逐字来自本机 NapCat 的 `get_group_msg_history`（2026-11-02 复核）：
  //   {"type":"reply","data":{"id":"551866400"}}
  // 段里**只有 id** —— 没有 qq / user_id / 内嵌原文。
  const segments = [
    { type: 'reply', data: { id: '551866400' } },
    { type: 'at', data: { qq: '30000024' } },
    { type: 'text', data: { text: ' 看到a忍了 哪有b忍' } },
  ];
  assert.equal(detectReplyToId(segments), '551866400');
  // `toSegments` 会把 `data` 压平到顶层，压平后的形状也要认。
  assert.equal(detectReplyToId(toSegments(segments)), '551866400');
});

test('detectReplyToId：CQ 串回退路径（[CQ:reply,id=…]）也能取到 id', () => {
  const segments = parseCqString('[CQ:reply,id=551866400][CQ:at,qq=30000024] 看到a忍了');
  assert.equal(detectReplyToId(segments), '551866400');
});

test('detectReplyToId：没有 reply 段 / 段里没 id 时返回空串', () => {
  assert.equal(detectReplyToId([{ type: 'text', text: '随便说说' }]), '');
  assert.equal(detectReplyToId([{ type: 'reply' }]), '', '畸形段（连 id 都没有）不算引用');
  assert.equal(detectReplyToId([{ type: 'reply', id: '   ' }]), '', '空白 id 不算');
  assert.equal(detectReplyToId([]), '');
  assert.equal(detectReplyToId(null), '', '非数组输入安全');
  assert.equal(detectReplyToId(undefined), '');
});

test('normalizeEvent：带引用时 replyToId = 被引用消息 id，且正文与判定语义不变', () => {
  // 真机形状：引用别人的消息（NapCat 会顺手带一个 @，但这里连 @ 都不给，
  // 单看"引用"这一件事）。
  const result = normalizeEvent(
    groupEvent({
      message: [{ type: 'reply', data: { id: '551866400' } }, { type: 'text', data: { text: '这个不行' } }],
      raw_message: '[CQ:reply,id=551866400]这个不行',
    }),
  );
  assert.equal(result.replyToId, '551866400');
  assert.equal(result.text, '这个不行', 'reply 段仍然不占正文位置');
  // ⚠️ 既有语义原样保住：reply 段只有 id 时 `isReplyToSelf` 判不了 ⇒ 不算被点名。
  assert.equal(result.replyToSelf, false);
  assert.equal(result.mentioned, false);
});

test('normalizeEvent：没有引用时不写 replyToId（不是空串占位）', () => {
  const result = normalizeEvent(groupEvent());
  assert.equal('replyToId' in result, false);
});

// ---------------------------------------------------------------- 昵称与 chatId

test('sanitizeNickname：控制字符替换成空格后压空白，不会把字粘在一起', () => {
  // 换行变空格而不是删掉：删掉会让「阿\n猫」粘成「阿猫」。
  assert.equal(sanitizeNickname('阿\n猫'), '阿 猫');
  assert.equal(sanitizeNickname('  空格   多  '), '空格 多');
  assert.equal(sanitizeNickname('坏\u0000名'), '坏 名');
  assert.equal(sanitizeNickname('制表\t符'), '制表 符');
  assert.equal(sanitizeNickname(undefined), '');
  assert.equal(sanitizeNickname(123), '');
});

test('sanitizeNickname：超长昵称被截断，不会撑爆前缀', () => {
  const long = 'x'.repeat(200);
  assert.equal(sanitizeNickname(long).length, 32);
});

test('buildChatId / splitChatId 往返', () => {
  assert.equal(buildChatId('group', '123'), 'group:123');
  assert.deepEqual(splitChatId('group:123'), { kind: 'group', target: '123' });
  assert.deepEqual(splitChatId('private:456'), { kind: 'private', target: '456' });
});

test('splitChatId 拒绝畸形输入', () => {
  assert.throws(() => splitChatId('group'), /无效的 chatId/);
  assert.throws(() => splitChatId('group:abc'), /无效的会话目标/);
  assert.throws(() => splitChatId('channel:123'), /无效的会话类型/);
  assert.throws(() => splitChatId(''), /无效的 chatId/);
});

// ---------------------------------------------------------------- normalizeEvent

/** 一条标准的 NapCat 群消息事件。 */
function groupEvent(overrides = {}) {
  return {
    time: 30000023,
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 12345,
    group_id: 100,
    user_id: 2001,
    message: [{ type: 'text', text: '今天这个 bug 有点意思' }],
    raw_message: '今天这个 bug 有点意思',
    font: 0,
    sender: { user_id: 2001, nickname: '阿猫', card: '群名片猫', role: 'member' },
    ...overrides,
  };
}

test('normalizeEvent：群消息全字段归一化', () => {
  const result = normalizeEvent(groupEvent());
  assert.equal(result.chatId, 'group:100');
  assert.equal(result.kind, 'group');
  assert.equal(result.userId, '2001');
  assert.equal(result.nickname, '群名片猫', '群名片优先于昵称');
  assert.equal(result.text, '今天这个 bug 有点意思');
  assert.equal(result.mentioned, false);
  assert.equal(result.at, 30000023000, '秒 → 毫秒');
  assert.equal(result.messageId, 12345);
  assert.equal(result.groupId, '100');
  assert.equal(result.selfId, '999');
});

test('normalizeEvent：群名片为空时回退昵称，再回退 QQ 号', () => {
  assert.equal(normalizeEvent(groupEvent({ sender: { nickname: '阿猫', card: '' } })).nickname, '阿猫');
  assert.equal(normalizeEvent(groupEvent({ sender: {} })).nickname, '2001');
  assert.equal(normalizeEvent(groupEvent({ sender: undefined })).nickname, '2001');
});

test('normalizeEvent：私聊消息用发送者 QQ 作会话', () => {
  const result = normalizeEvent({
    time: 30000023,
    self_id: 999,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 1,
    user_id: 2001,
    message: '在吗',
    raw_message: '在吗',
    sender: { nickname: '阿猫' },
  });
  assert.equal(result.chatId, 'private:2001');
  assert.equal(result.kind, 'private');
  assert.equal(result.groupId, undefined);
});

test('normalizeEvent：@ 机器人被识别为 mentioned', () => {
  const result = normalizeEvent(
    groupEvent({
      message: [{ type: 'at', qq: '999' }, { type: 'text', text: ' 看看这个' }],
      raw_message: '[CQ:at,qq=999] 看看这个',
    }),
  );
  assert.equal(result.mentioned, true);
  // @ 段现在会渲染出目标（`@QQ`）—— 看得见"@ 了谁"，而 `mentioned` 语义不变。
  assert.equal(result.text, '@999 看看这个');
});

test('normalizeEvent：回复机器人也算 mentioned', () => {
  const result = normalizeEvent(
    groupEvent({ message: [{ type: 'reply', user_id: '999' }, { type: 'text', text: '对' }] }),
  );
  assert.equal(result.mentioned, true);
});

test('normalizeEvent：忽略机器人自己发的消息（防自循环）', () => {
  assert.equal(normalizeEvent(groupEvent({ user_id: 999 })), null);
  assert.equal(normalizeEvent(groupEvent({ user_id: 999 }), { botQQ: '999' }), null);
  assert.equal(normalizeEvent(groupEvent({ user_id: 888 }), { botQQ: '888' }), null);
});

test('normalizeEvent：ignoreSelf=false 时保留自己的消息', () => {
  const result = normalizeEvent(groupEvent({ user_id: 999 }), { ignoreSelf: false });
  assert.notEqual(result, null);
  assert.equal(result.userId, '999');
});

test('normalizeEvent：非 message 事件一律返回 null', () => {
  assert.equal(normalizeEvent(groupEvent({ post_type: 'meta_event' })), null);
  assert.equal(normalizeEvent(groupEvent({ post_type: 'notice' })), null);
  assert.equal(normalizeEvent(groupEvent({ post_type: 'request' })), null);
});

test('normalizeEvent：群系统提示（sub_type=notice）不是人说的话', () => {
  assert.equal(normalizeEvent(groupEvent({ sub_type: 'notice' })), null);
});

test('normalizeEvent：畸形输入返回 null 而不是抛异常', () => {
  assert.equal(normalizeEvent(null), null);
  assert.equal(normalizeEvent(undefined), null);
  assert.equal(normalizeEvent('x'), null);
  assert.equal(normalizeEvent(42), null);
  assert.equal(normalizeEvent({ post_type: 'message' }), null, '缺 message_type');
  assert.equal(normalizeEvent(groupEvent({ user_id: undefined })), null, '缺 user_id');
  assert.equal(normalizeEvent(groupEvent({ group_id: undefined })), null, '群消息缺 group_id');
  // message 与 raw_message 全缺 = 内容字段损坏，不该当成一条空消息交给上层。
  assert.equal(normalizeEvent(groupEvent({ message: undefined, raw_message: undefined })), null);
});

test('normalizeEvent：message_type 非法时返回 null', () => {
  assert.equal(normalizeEvent(groupEvent({ message_type: 'discuss' })), null);
});

test('normalizeEvent：time 缺失或非法时回落到当前时刻而不是崩', () => {
  const before = Date.now();
  const result = normalizeEvent(groupEvent({ time: undefined }));
  assert.ok(result.at >= before && result.at <= Date.now() + 5);
  const result2 = normalizeEvent(groupEvent({ time: 0 }));
  assert.ok(result2.at >= before);
});

test('normalizeEvent：纯媒体消息文本为占位符，不为空串', () => {
  const result = normalizeEvent(
    groupEvent({ message: [{ type: 'image' }], raw_message: '[CQ:image,file=a.jpg]' }),
  );
  assert.equal(result.text, '[图片]');
  assert.equal(result.segments.length, 1);
});

test('normalizeEvent：只有 reply 段时文本为空串（调用方据此跳过）', () => {
  const result = normalizeEvent(
    groupEvent({ message: [{ type: 'reply', id: '1' }], raw_message: '' }),
  );
  assert.equal(result.text, '');
});

test('normalizeEvent：只给 CQ 串的实现也能工作（回退路径）', () => {
  const result = normalizeEvent(groupEvent({ message: undefined }));
  assert.equal(result.text, '今天这个 bug 有点意思');
});

test('normalizeEvent：message_id 非数字时不写入该字段（而不是写 NaN）', () => {
  const result = normalizeEvent(groupEvent({ message_id: undefined }));
  assert.equal('messageId' in result, false);
});

// ---------------------------------------------------------------- 出站组装

test('textToSegments：空文本产出空数组，不产出空 text 段', () => {
  assert.deepEqual(textToSegments(''), []);
  assert.deepEqual(textToSegments(null), []);
  assert.deepEqual(textToSegments('hi'), [{ type: 'text', text: 'hi' }]);
});

test('mentionSegments：@ 与正文之间留一个空格', () => {
  assert.deepEqual(mentionSegments('123', '你好'), [
    { type: 'at', qq: '123' },
    { type: 'text', text: ' ' },
    { type: 'text', text: '你好' },
  ]);
});

test('mentionSegments：无 userId 时只发正文', () => {
  assert.deepEqual(mentionSegments('', '你好'), [{ type: 'text', text: '你好' }]);
  assert.deepEqual(mentionSegments(undefined, '你好'), [{ type: 'text', text: '你好' }]);
});

test('mentionSegments：空正文时只 @ 不带多余空格', () => {
  assert.deepEqual(mentionSegments('123', ''), [{ type: 'at', qq: '123' }]);
});

// ---------------------------------------------------------------- 真机偏差回归

test('回归：NapCat 把 URL 的 & 转成 &amp; 时，图片 URL 仍可用', () => {
  const event = groupEvent({
    message: [{ type: 'image', url: 'https://cdn.x.com/i?token=a&amp;t=1' }],
    raw_message: '[CQ:image,url=https://cdn.x.com/i?token=a&amp;t=1]',
  });
  const result = normalizeEvent(event);
  assert.equal(result.segments[0].url, 'https://cdn.x.com/i?token=a&t=1');
});

test('回归：段数组与 CQ 串同时存在且不一致时，以段数组为准', () => {
  const event = groupEvent({
    message: [{ type: 'text', text: '段数组版本' }],
    raw_message: '[CQ:at,qq=999] 假的 @',
  });
  const result = normalizeEvent(event);
  assert.equal(result.text, '段数组版本');
  assert.equal(result.mentioned, false, '不能因为 raw 里有 @ 就误判（段数组才是权威）');
});

test('回归：匿名消息（anonymous 非 null）仍能正常归一化', () => {
  const result = normalizeEvent(
    groupEvent({ sub_type: 'anonymous', anonymous: { id: 1, name: '匿名', flag: 'x' } }),
  );
  assert.equal(result.kind, 'group');
  assert.equal(result.text, '今天这个 bug 有点意思');
});

test('回归：字符串型 user_id / group_id / self_id 也能归一化', () => {
  const result = normalizeEvent(groupEvent({ user_id: '2001', group_id: '100', self_id: '999' }));
  assert.equal(result.chatId, 'group:100');
  assert.equal(result.userId, '2001');
});
