/**
 * 「群里 @ 了谁」必须看得见 —— 回归测试（2026-10-06）。
 *
 * ## 这个 bug
 *
 * `SEGMENT_PLACEHOLDERS.at` 曾是空串 `''`，而 `segmentsToText` 只在
 * `placeholder !== ''` 时才 push —— 于是 **at 段被整段丢掉**：
 * 群里一句 `@黑猫 你看看` 到达模型时只剩 `你看看`，
 * **目标是谁、甚至「这里发生过一个 @」都丢了**。
 *
 * 同一个洞在 `rich.mjs`：`renderRichText` 把其余段转交 `segmentsToText([seg])`，
 * 空串又被 `if (one !== '')` 吃掉 —— 合并转发里的 @ 一样看不见。
 *
 * ## at 段的真实字段（NapCat 实测，不是猜的）
 *
 * `POST /get_group_msg_history`（群 200000002，count=100）里共 **20 个 at 段**，
 * 每一个都只有 `{type:'at', data:{qq}}`：
 *   - `qq` 是**字符串**：`"10000002"`、`"all"`
 *   - `data` 的键**只有 `qq`** —— 没有昵称/名字字段
 *   - `@全体成员` 就是 `qq: "all"`，`raw_message` 里写 `[CQ:at,qq=all]`
 *
 * 所以"有昵称用昵称"这条在 NapCat 上走不到，主路径是 QQ 号；
 * 昵称分支只是对**别的实现**（可能带 `name`）的容错。
 *
 * ## 本文件刻意**不测**什么
 *
 * `detectMention` 的语义（**机器人自己**有没有被 @）一个字都不改 ——
 * 它驱动「要不要回话」。所以除了钉渲染，还要钉住
 * 「**渲染变了，mentioned 不能跟着变**」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeEvent,
  segmentsToText,
  toSegments,
  detectMention,
} from '../src/onebot/protocol.mjs';
import { renderRichText, expandRichText } from '../src/onebot/rich.mjs';

/** 机器人自己的 QQ（这里用假号；真实值只在部署配置里）。 */
const SELF = '10000003';

/** 造一条真机形状的群消息事件（段用 NapCat 的规范 `data` 嵌套）。 */
function groupEvent({ message, raw = '', userId = '10000004', nickname = '用户', messageId = 1 }) {
  return {
    time: 1_700_000_000,
    self_id: Number(SELF),
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: 200000002,
    user_id: Number(userId),
    raw_message: raw,
    font: 0,
    sender: { user_id: Number(userId), nickname, card: '' },
    message,
  };
}

// ── 真机数据表：字段**形状**逐字照抄 2026-10-06 的 get_group_msg_history 返回 ──
// ⚠️ 号码已统一替换为假号（10000001 起），形状与字段名保持原样。
const REAL_CASES = [
  {
    label: '@别人 + 正文',
    segs: [{ type: 'at', data: { qq: '10000002' } }, { type: 'text', data: { text: ' 你看看' } }],
    raw: '[CQ:at,qq=10000002] 你看看',
    text: '@10000002 你看看',
    mentioned: false,
  },
  {
    label: '@全体成员 + 正文',
    segs: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: ' 八点半' } }],
    raw: '[CQ:at,qq=all] 八点半',
    text: '@全体成员 八点半',
    mentioned: false,
  },
  {
    label: '正文在前、@ 在后',
    segs: [
      { type: 'text', data: { text: '小鲸鱼攻击性怎么变强了' } },
      { type: 'at', data: { qq: SELF } },
    ],
    raw: `小鲸鱼攻击性怎么变强了[CQ:at,qq=${SELF}]`,
    text: `小鲸鱼攻击性怎么变强了@${SELF}`,
    mentioned: true,
  },
  {
    label: '只有 @、没打字',
    segs: [{ type: 'at', data: { qq: '10000002' } }],
    raw: '[CQ:at,qq=10000002]',
    text: '@10000002',
    mentioned: false,
  },
  {
    label: '只有 @、后面跟一个空白段',
    segs: [{ type: 'at', data: { qq: '10000002' } }, { type: 'text', data: { text: ' ' } }],
    raw: '[CQ:at,qq=10000002] ',
    text: '@10000002',
    mentioned: false,
  },
];

for (const item of REAL_CASES) {
  test(`真机形状（data 嵌套）：${item.label}`, () => {
    const message = normalizeEvent(groupEvent({ message: item.segs, raw: item.raw }));
    assert.equal(message.text, item.text);
    assert.equal(message.mentioned, item.mentioned, '渲染改了，判定不能跟着变');
  });
}

test('渲染改了判定没改：@别人 / @全体 都不算 @ 了机器人', () => {
  // 这条是硬边界：`mentioned` 驱动"要不要回话"，绝不能因为"看得见 @"而变。
  const segs = toSegments([
    { type: 'at', data: { qq: '10000002' } },
    { type: 'at', data: { qq: 'all' } },
    { type: 'text', data: { text: ' hi' } },
  ]);
  assert.equal(segmentsToText(segs), '@10000002@全体成员 hi');
  assert.equal(detectMention(segs, '', SELF, SELF), false);
});

test('★ mentionsOthers：@ 的是别人 / @全体 → true，@ 的是我 → false（2026-10-07）', () => {
  // 判定层用它把「@ 别人的消息」的 content 压到 +3（用户原话：
  // 「别人 @ 别人和小鲸鱼关系太小了，content 那边 +3 分算了，一般情况下不吭声」）。
  const build = (segs, raw = '') => normalizeEvent(groupEvent({ message: segs, raw }));
  assert.equal(
    build([{ type: 'at', data: { qq: '10000002' } }, { type: 'text', data: { text: ' 你看看' } }]).mentionsOthers,
    true,
    '@ 别人',
  );
  assert.equal(build([{ type: 'at', data: { qq: SELF } }]).mentionsOthers, false, '@ 我自己');
  assert.equal(build([{ type: 'at', data: { qq: 'all' } }]).mentionsOthers, true, '@全体 = 字面口径下的"不是@我"');
  assert.equal(build([{ type: 'text', data: { text: '这条没有 at 段' } }]).mentionsOthers, false, '压根没有 at 段');

  // 同时 @ 了我和别人：两个标记都为真 —— 判定层按"被点名"处理（+60 强相关），不走 +3。
  const both = build([
    { type: 'at', data: { qq: '10000002' } },
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: ' 你们看看' } },
  ]);
  assert.equal(both.mentioned, true);
  assert.equal(both.mentionsOthers, true);
  // `mentioned`（要不要回话）的语义一个字没改 —— 旧用例仍在守它。
});

test('at 段自带昵称时用昵称（NapCat 不带，别的实现可能带）', () => {
  assert.equal(segmentsToText([{ type: 'at', data: { qq: '1', name: '黑猫' } }]), '@黑猫');
  // 名字里带 @ / 换行也不能渲染出 `@@黑猫` 或把正文顶断行。
  assert.equal(segmentsToText([{ type: 'at', qq: '1', name: '@黑猫\n' }]), '@黑猫');
});

test('at 段缺 qq 时也不静默消失（退化成裸 @）', () => {
  assert.equal(segmentsToText([{ type: 'at' }]), '@');
});

test('keepPlaceholders=false 是"只要纯文本"，@ 目标也一并去掉', () => {
  const segments = [{ type: 'at', qq: '1' }, { type: 'text', text: '说明' }];
  assert.equal(segmentsToText(segments, { keepPlaceholders: false }), '说明');
});

test('CQ 串回退路径（段数组缺失）同样带上 @ 目标', () => {
  // 段数组完全为空的老实现只能给 CQ 串，这条路上 @ 也不能丢。
  const message = normalizeEvent(
    groupEvent({ message: undefined, raw: '[CQ:at,qq=10000002] 你看看' }),
  );
  assert.equal(message.text, '@10000002 你看看');
  assert.equal(message.mentioned, false);
});

// ---------------------------------------------------------------- rich.mjs 同名洞

test('rich.mjs：renderRichText 也要渲染 @ 目标（空占位符会被 `if (one !== \'\')` 吃掉）', () => {
  const out = renderRichText([
    { type: 'at', qq: '10000002' },
    { type: 'text', text: ' 你看看' },
  ]);
  assert.equal(out, '@10000002 你看看');
});

test('rich.mjs：合并转发内层的 @ 也看得见', () => {
  const out = expandRichText([
    {
      type: 'forward',
      data: {
        content: [{
          user_id: '10000004',
          sender: { nickname: '用户' },
          message: [
            { type: 'at', data: { qq: SELF } },
            { type: 'text', data: { text: ' 你看看' } },
          ],
          raw_message: `[CQ:at,qq=${SELF}] 你看看`,
        }],
      },
    },
  ]);
  assert.match(out, new RegExp(`用户: @${SELF}\\s+你看看`));
});
