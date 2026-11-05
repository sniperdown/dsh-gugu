/**
 * 配置页「保存全部」（2026-10-28）的纯逻辑。
 *
 * ## 这一组在钉什么
 *
 * 病根：以前每张卡片各有自己的「保存」按钮，改了三个地方只点了其中一两个时，
 * 剩下的改动**根本没写进文件**，而界面上没有任何"还有东西没保存"的痕迹 ——
 * 表现就是"改了配置没生效"。
 *
 * 现在整页只有一个保存入口，一次提交**所有脏字段**。这套收集逻辑放在
 * `web/logic.mjs`（不碰 DOM、不发请求），因此能在 Node 里直接钉住：
 *
 * 1. `writableScopeFields`：global **含 `admins`**（身份卡的用户名单也要进收集
 *    范围），会话层仍只有人格五段；
 * 2. `dirtyEntriesFor`：**只收改动过的字段**（没改的键不重写 ⇒ 文件里手写注释与
 *    格式不会被冲掉）、值转成宿主能收的形态、危险键标记取"宿主标的 danger 与按
 *    key 判"的并集；
 * 3. `saveAllLabel` / `describeDirtyEntries`：按钮上的处数与摘要文案 ——
 *    处数为 0 时不能还写着"还有 N 处"。
 *
 * 字段形状用的是宿主真实的那份（`CONFIG_FIELDS`），不另造样例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeDirtyEntries,
  dirtyEntriesFor,
  draftKey,
  isDangerFieldKey,
  saveAllLabel,
  writableScopeFields,
} from '../web/logic.mjs';
import { CONFIG_FIELDS } from '../src/dsh/config-fields.mjs';

/** 宿主 `/settings` 里 global 作用域字段的形状：value = 文件里的值。 */
function globalFields() {
  return CONFIG_FIELDS.map((field) => ({
    ...field,
    scope: 'global',
    value: null,
    effective: field.default,
  }));
}

/** 造一个"文件里是 value"的全局字段。 */
function withValue(key, value) {
  const field = CONFIG_FIELDS.find((item) => item.key === key);
  assert.ok(field !== undefined, `CONFIG_FIELDS 里没有 ${key}`);
  return { ...field, scope: 'global', value, effective: value };
}

// ---------------------------------------------------------------- 收集范围

test('★ writableScopeFields：global 含 admins（用户名单也要进「保存全部」）', () => {
  const list = writableScopeFields(globalFields(), 'global');
  assert.equal(list.length, CONFIG_FIELDS.length, 'global 就是字段表全量');
  assert.ok(
    list.some((field) => field.key === 'admins'),
    'admins 必须在收集范围里：漏了它，身份卡上改的用户名单就不会被保存',
  );
});

test('writableScopeFields：会话层仍然只有人格五段', () => {
  // 会话层可写的字段由宿主定死（写别的会被 400「只有人格五段支持按会话覆盖」）。
  const fields = [
    'persona',
    'reply_style',
    'emotion_style',
    'interest',
    'rules',
    'admins',
    'agent.reasoning',
  ].map((key) => ({
    key,
    section: key === 'agent.reasoning' ? 'agent' : 'personality',
    scope: 'group:30000013',
    type: 'multiline',
    value: null,
  }));
  assert.deepEqual(
    writableScopeFields(fields, 'group:30000013').map((field) => field.key),
    ['persona', 'reply_style', 'emotion_style', 'interest', 'rules'],
  );
});

test('writableScopeFields：空输入不炸（scope 缺省按 global 算）', () => {
  assert.deepEqual(writableScopeFields(null, 'global'), []);
  assert.deepEqual(writableScopeFields([], ''), []);
});

// ---------------------------------------------------------------- 只收脏字段

test('★ dirtyEntriesFor：只收改动过的字段（没改的键不重写）', () => {
  const fields = [
    withValue('persona', '旧人格'),
    withValue('interest', '旧兴趣'),
    withValue('free_time.enabled', false),
    withValue('free_time.intervalHours', 3),
    withValue('admins', ['30000001']),
  ];
  const draft = {
    [draftKey('global', 'persona')]: '新人格',
    // 草稿存在、但与文件里的值相同 ⇒ **不算改动**，不许进条目
    [draftKey('global', 'interest')]: '旧兴趣',
    [draftKey('global', 'free_time.intervalHours')]: '5',
    [draftKey('global', 'admins')]: '30000001, 900',
  };
  const entries = dirtyEntriesFor(fields, draft, 'global');

  assert.deepEqual(entries.map((entry) => entry.key), [
    'persona',
    'free_time.intervalHours',
    'admins',
  ]);
  // 值转成宿主能收的形态：字符串原样、数字去空白、数组名单切成数组
  assert.equal(entries[0].value, '新人格');
  assert.equal(entries[1].value, '5');
  assert.deepEqual(entries[2].value, ['30000001', '900']);
  assert.equal(entries[0].scope, 'global');
  assert.equal(entries[0].label, '角色设定');
});

test('dirtyEntriesFor：bool 取真假，不受字符串形式影响', () => {
  const fields = [withValue('free_time.enabled', false), withValue('mood.enabled', true)];
  const entries = dirtyEntriesFor(
    fields,
    {
      [draftKey('global', 'free_time.enabled')]: true,
      // 与文件值相同 ⇒ 不算改动
      [draftKey('global', 'mood.enabled')]: true,
    },
    'global',
  );
  assert.deepEqual(entries.map((entry) => entry.key), ['free_time.enabled']);
  assert.equal(entries[0].value, true);
});

test('★ dirtyEntriesFor：宿主标的 danger:true 也算危险键（voice.python）', () => {
  // 这一格以前是漏的：`DANGER_KEYS` 里没有 `python`，但宿主按字段表里的
  // `danger: true` 要求 `confirm: true` ⇒ 漏判的结果是"一保存就报『需要二次确认』"。
  assert.equal(isDangerFieldKey('voice.python'), false, '按 key 判不出来（这就是漏的原因）');
  const entries = dirtyEntriesFor(
    [withValue('voice.python', '旧路径')],
    { [draftKey('global', 'voice.python')]: '新路径' },
    'global',
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].danger, true);
});

test('dirtyEntriesFor：会话层清空某一框 = 提交空串（删掉这条覆盖）', () => {
  const fields = [{
    key: 'rules',
    section: 'personality',
    scope: 'group:30000013',
    type: 'multiline',
    value: '群规',
    effective: '群规',
  }];
  const entries = dirtyEntriesFor(
    fields,
    { [draftKey('group:30000013', 'rules')]: '' },
    'group:30000013',
  );
  assert.deepEqual(entries, [{
    scope: 'group:30000013',
    key: 'rules',
    label: '行为规则',
    value: '',
    danger: false,
    section: 'personality',
  }]);
});

test('dirtyEntriesFor：没有草稿 / 空输入都返回空数组（不写空 patch）', () => {
  assert.deepEqual(dirtyEntriesFor([withValue('persona', 'x')], {}, 'global'), []);
  assert.deepEqual(dirtyEntriesFor(null, {}, 'global'), []);
  assert.deepEqual(dirtyEntriesFor([null, undefined, 'x'], {}, 'global'), []);
});

// ---------------------------------------------------------------- 按钮与摘要

test('★ saveAllLabel：有改动时把处数写在按钮上', () => {
  assert.equal(saveAllLabel(0), '保存全部');
  assert.equal(saveAllLabel(1), '保存全部（1 处改动）');
  assert.equal(saveAllLabel(3), '保存全部（3 处改动）');
  // 拿不到数字时按 0 处理：宁可少标，也不要写出 NaN 处
  assert.equal(saveAllLabel(undefined), '保存全部');
  assert.equal(saveAllLabel(Number.NaN), '保存全部');
});

test('★ describeDirtyEntries：摘要说清"改在哪儿"', () => {
  const labels = {
    global: '全局',
    'group:30000013': '群 示例群',
    'private:30000001': '私聊 用户',
  };
  const entries = [
    { scope: 'global', key: 'personality', label: '人格' },
    { scope: 'group:30000013', key: 'rules', label: '行为规则' },
    { scope: 'private:30000001', key: 'reply_style', label: '表达风格' },
    { scope: 'global', key: 'interest', label: '兴趣' },
  ];
  assert.equal(
    describeDirtyEntries(entries.slice(0, 2), labels),
    '全局 · 人格、群 示例群 · 行为规则',
  );
  // 默认最多列 3 条，其余折成"等 N 处"
  assert.equal(
    describeDirtyEntries(entries, labels),
    '全局 · 人格、群 示例群 · 行为规则、私聊 用户 · 表达风格 等 4 处',
  );
  assert.equal(describeDirtyEntries(entries, labels, 1), '全局 · 人格 等 4 处');
  assert.equal(describeDirtyEntries([], labels), '');
});

test('describeDirtyEntries：没有短名时回落成作用域 id，不留空', () => {
  assert.equal(
    describeDirtyEntries([{ scope: 'group:1', key: 'rules', label: '行为规则' }], {}),
    'group:1 · 行为规则',
  );
  assert.equal(
    describeDirtyEntries([{ scope: 'global', key: 'rules' }], { global: '全局' }),
    '全局 · rules',
    '缺显示名时回落成 key（宁可显示 key，也不要一行空白）',
  );
});
