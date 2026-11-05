/**
 * 配置页（独立网页）的纯逻辑：**两张卡片的切分**与**折叠条门槛**。
 *
 * `web/app.js` 只负责把这里算出来的分组铺成 React 元素，判定本身都在
 * `web/logic.mjs`（不碰 DOM、不发请求），所以能在 Node 里直接钉住。
 *
 * 钉三件事：
 *
 * 1. 人格五段里**情绪特征 / 兴趣**与前三段是同一种控件（`multiline`）——
 *    它们曾经是单行输入框，字号、高度、能否换行都与人格段不一致；
 * 2. 折叠条只在**该段 ≥2 项**时出现：只有 1 项的段（推理等级、转交规矩、
 *    发 QQ 的规矩、判定模式）直接平铺成一行；
 * 3. 行为规则 / 转交规矩 / 发 QQ 的规矩 / 记忆 / 判定模式**不进人格卡**，
 *    而是第二张卡；人格卡里只剩人格四段 + 推理等级 + 定时任务 + 心情。
 *
 * 字段形状用的是宿主真实的那份（`CONFIG_FIELDS`）与 `/settings` 的同名字段
 * （`key` / `section` / `type` / `scope` / `value` / `effective`），不另造样例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNEL_SECOND_CARD_KEYS,
  CHANNEL_SECOND_CARD_SECTIONS,
  SECTION_FOLD_MIN_FIELDS,
  channelSecondCardGroups,
  fieldHint,
  fieldInactive,
  fieldLabel,
  fieldCompact,
  groupFields,
  isSecondCardField,
  isZoomableField,
  sectionFoldable,
  selectScopeFields,
  splitChannelCardFields,
} from '../web/logic.mjs';
import { CONFIG_FIELDS } from '../src/dsh/config-fields.mjs';

/** 通道页 global 作用域的字段：用户名单由「身份」卡单独负责，不在字段表里。 */
function globalFields() {
  return CONFIG_FIELDS
    .filter((field) => field.key !== 'admins')
    .map((field) => ({ ...field, scope: 'global', value: null, effective: field.default }));
}

// ---------------------------------------------------------------- ① 多行控件

test('① 情绪特征 / 兴趣与人格前三段是同一种控件（multiline，可双击放大）', () => {
  const byKey = new Map(CONFIG_FIELDS.map((field) => [field.key, field]));
  for (const key of ['persona', 'reply_style', 'emotion_style', 'interest', 'rules']) {
    const field = byKey.get(key);
    assert.ok(field !== undefined, `缺字段 ${key}`);
    assert.equal(field.type, 'multiline', `${key} 应是 multiline`);
    assert.equal(isZoomableField(field), true, `${key} 应可双击放大`);
  }
});

// ---------------------------------------------------------------- ③ 折叠门槛

test('③ 折叠条门槛：≥2 项才折叠，1 项直接平铺', () => {
  assert.equal(SECTION_FOLD_MIN_FIELDS, 2);
  assert.equal(sectionFoldable(0), false);
  assert.equal(sectionFoldable(1), false);
  assert.equal(sectionFoldable(2), true);
  assert.equal(sectionFoldable(3), true);
  assert.equal(sectionFoldable(8), true);
});

test('③ 非数字的项数按 0 处理：宁可不折叠，也不把内容藏起来', () => {
  for (const value of [undefined, null, '3', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(sectionFoldable(value), false, String(value));
  }
});

// ---------------------------------------------------------------- ④ 两张卡

test('④ 第二张卡正好五类：行为规则 / 转交规矩 / 发 QQ 的规矩 / 记忆 / 判定模式', () => {
  const { second } = splitChannelCardFields(globalFields());
  // 切分只挑字段、不改顺序（顺序由 `channelSecondCardGroups` 负责），所以这里比集合。
  // ⚠️ 2026-10-29：这几条期望值是**补上的旧账** —— `[send]` 在 2026-10-25 加了
  // `auto_reply` / `split_marker` / `split_max_parts`（B2/B3），测试没跟着改，
  // 于是这条一直是红的（与本次"提示词进配置页"无关，改前就红，`git stash` 验过）。
  assert.deepEqual([...new Set(second.map((field) => field.key))].sort(), [
    'memory.inject_max_chars',
    'memory.inject_private_as_section',
    'memory.learned_enabled',
    'proactive.interject_prompt',
    'proactive.judge_mode',
    'proactive.judge_mode_private',
    // 2026-10-30：决定开口的预检模型 + 两段提示词文本都留在主文件（用户拍板）。
    'proactive.precheck_model',
    'proactive.precheck_system',
    'rules',
    'send.auto_reply',
    'send.rule',
    'send.split_marker',
    'send.split_max_parts',
  ]);
});

test('④ 人格卡里不再有那五类：只剩人格四段 + 推理等级 + 定时任务', () => {
  const { first } = splitChannelCardFields(globalFields());
  const groups = groupFields(first);
  // 段落顺序即 section 的登记顺序（`SECTION_TITLES`）。
  // ⚠️ 2026-10-30：`mood` / `voice` 已搬到各自标签页（旁路分文件的产物），
  // 所以「自定义」页只剩主文件这三段。哪天它们回来了，这里会红 —— 那是提醒，不是噪音。
  assert.deepEqual(groups.map((group) => group.section), [
    'personality',
    'agent',
    'free_time',
  ]);
  // 人格段从五段降到四段：行为规则切走了。
  // 定时任务 12 项：2026-10-23 加了 `followupMinutes`（追问间隔）；
  // 2026-10-29 又加了 `wakePrompt` / `followupPrompt`（提示词搬进配置页）与
  // `screenshotsMaxPerWake`（每轮带几张截图）。
  assert.deepEqual(groups.map((group) => group.fields.length), [8, 1, 12]);
  assert.deepEqual(
    groups[0].fields.map((field) => field.key),
    ['persona', 'relations', 'reply_style', 'emotion_style', 'interest', 'chat_sense', 'ai_flavor', 'examples'],
  );
});

test('④ 第二张卡内部分组：单字段各自成组，记忆是唯一 ≥2 项的段', () => {
  const { second } = splitChannelCardFields(globalFields());
  const groups = channelSecondCardGroups(second);
  assert.deepEqual(groups.map((group) => group.key), [
    'rules',
    'send',
    'memory',
    'proactive',
  ]);
  // `send` 4 项（B2/B3 加的），`memory` 3 项，`proactive` 5 项（含预检模型与两段提示词）。
  assert.deepEqual(groups.map((group) => group.fields.length), [1, 4, 3, 5]);
  assert.deepEqual(
    groups.map((group) => sectionFoldable(group.fields.length)),
    [false, true, true, true],
  );
  // 标题用界面显示名，不是 toml 段名。
  assert.deepEqual(groups.map((group) => group.title), [
    '行为规则',
    '发 QQ 的规矩',
    '记忆',
    '判定模式',
  ]);
});

test('④ 第二张卡的常量与判定口径一致', () => {
  assert.deepEqual([...CHANNEL_SECOND_CARD_KEYS], ['rules']);
  assert.deepEqual([...CHANNEL_SECOND_CARD_SECTIONS], ['send', 'memory', 'proactive']);
  const byKey = new Map(globalFields().map((field) => [field.key, field]));
  assert.equal(isSecondCardField(byKey.get('rules')), true);
  assert.equal(isSecondCardField(byKey.get('send.rule')), true);
  assert.equal(isSecondCardField(byKey.get('memory.learned_enabled')), true);
  assert.equal(isSecondCardField(byKey.get('proactive.judge_mode')), true);
  // 人格四段 + 推理等级 + 定时任务 + 心情都留在人格卡。
  for (const key of ['persona', 'reply_style', 'emotion_style', 'interest', 'agent.reasoning', 'free_time.enabled', 'mood.enabled']) {
    assert.equal(isSecondCardField(byKey.get(key)), false, key);
  }
  // 空输入不该炸，也不该把东西算进第二张卡。
  assert.equal(isSecondCardField(null), false);
  assert.equal(isSecondCardField({}), false);
});

// ---------------------------------------------------------------- 定时任务

test('★ 追问间隔（followupMinutes）在字段表里，且配置页有中文显示名', () => {
  // 2026-10-23：用户要求它是**配置项**、并且要出现在配置页里。
  // 宿主给的是 key/label，界面显示名在 `web/logic.mjs` 的 FIELD_LABELS 里
  // （载荷不带 label，缺了就会直接显示 key）—— 两边都要有。
  const field = CONFIG_FIELDS.find((item) => item.key === 'free_time.followupMinutes');
  assert.ok(field !== undefined, '宿主字段表里没有 free_time.followupMinutes');
  assert.equal(field.type, 'number');
  assert.equal(field.section, 'free_time');
  assert.equal(field.default, 10, '默认 10 分钟');
  // 落在定时任务那一段 ⇒ 跟着 `[free_time]` 一起出现在「通道」页的人格卡里。
  assert.deepEqual(field.effectivePath, ['freeTime', 'followupMinutes']);
  assert.equal(fieldLabel({ key: 'free_time.followupMinutes' }), '追问间隔（分钟）');
});

// ---------------------------------------------------------------- 提示词与截图张数（2026-10-29）

test('★ 两段提示词与"每轮带几张截图"都在字段表里，且配置页有中文显示名与说明', () => {
  // 用户要求：唤醒提示词要能在网页上改（多行文本框），并说明「留空 = 内置文案」。
  // 宿主给 key/type/section，**显示名与说明都在 `web/logic.mjs`**（载荷不带）。
  const byKey = new Map(CONFIG_FIELDS.map((field) => [field.key, field]));

  for (const [key, label] of [
    ['free_time.wakePrompt', '长唤醒提示词'],
    ['free_time.followupPrompt', '短追问提示词'],
  ]) {
    const field = byKey.get(key);
    assert.ok(field !== undefined, `宿主字段表里没有 ${key}`);
    assert.equal(field.type, 'multiline', `${key} 必须能换行（提示词是一整段）`);
    assert.equal(field.section, 'free_time');
    assert.equal(field.default, '', `${key} 默认空 = 用内置文案`);
    assert.equal(fieldLabel({ key }), label);
    // 说明里必须点出占位符写法，否则没人知道 {{budget}} 能换东西。
    assert.match(fieldHint({ key }), /\{\{budget\}\}|\{\{minutes\}\}/, `${key} 的说明要提占位符`);
    assert.match(fieldHint({ key }), /留空/, `${key} 的说明要写清"留空 = 内置文案"`);
    // 双击放大对长文本是必需的（人格段同款）。
    assert.equal(isZoomableField(field), true, `${key} 应可双击放大`);
  }

  const shot = byKey.get('free_time.screenshotsMaxPerWake');
  assert.ok(shot !== undefined, '宿主字段表里没有 free_time.screenshotsMaxPerWake');
  assert.equal(shot.type, 'number');
  assert.equal(shot.default, 2);
  assert.deepEqual(shot.effectivePath, ['freeTime', 'screenshotsMaxPerWake']);
  assert.equal(fieldLabel({ key: shot.key }), '每轮最多带几张截图');
  // 两个截图键要能分得开：一个是"留几轮"（删图），一个是"带几张"（看图）。
  assert.notEqual(fieldLabel({ key: 'free_time.screenshotsKeep' }), fieldLabel({ key: shot.key }));
});

test('fieldHint：载荷带了就用载荷的，没有则回落客户端表；都没有 ⇒ 空串（不渲染空行）', () => {
  assert.equal(fieldHint({ key: 'free_time.wakePrompt', hint: '  载荷里的说明  ' }), '载荷里的说明');
  assert.match(fieldHint({ key: 'free_time.wakePrompt' }), /留空 = 用内置文案/);
  assert.equal(fieldHint({ key: 'free_time.enabled' }), '', '没登记的字段不该硬编一句说明');
  assert.equal(fieldHint(null), '');
  assert.equal(fieldHint({}), '');
});

// ---------------------------------------------------------------- 会话层

test('会话层仍只列人格五段：行为规则跟着进第二张卡，其余四段留在人格卡', () => {
  const fields = ['persona', 'reply_style', 'emotion_style', 'interest', 'rules', 'agent.reasoning']
    .map((key) => ({
      key,
      section: key === 'agent.reasoning' ? 'agent' : 'personality',
      type: 'multiline',
      scope: 'group:30000013',
      value: null,
      effective: '',
    }));
  const scoped = selectScopeFields(fields, 'group:30000013');
  assert.deepEqual(scoped.map((field) => field.key), [
    'persona',
    'reply_style',
    'emotion_style',
    'interest',
    'rules',
  ]);
  const { first, second } = splitChannelCardFields(scoped);
  assert.deepEqual(first.map((field) => field.key), [
    'persona',
    'reply_style',
    'emotion_style',
    'interest',
  ]);
  assert.deepEqual(second.map((field) => field.key), ['rules']);
});

test('「未生效」不因多行文本的尾随空白而误报（2026-10-29 线上）', () => {
  // 现场：`[personality] reply_style` 写成 `"""` 块，readToml 保留结尾换行（309 字节），
  // 而进程里那份拼人格时被 trim（308 字节）⇒ 一个字节没改也挂「未生效（重载后生效）」。
  const body = '回复比较少女化，可以适当的加一点口癖。';
  assert.equal(fieldInactive({ key: 'reply_style', value: `${body}\n`, effective: body }), false);
  assert.equal(fieldInactive({ key: 'reply_style', value: body, effective: `${body}\n` }), false);
  assert.equal(fieldInactive({ key: 'reply_style', value: `${body}  \n\n`, effective: body }), false);

  // 但**真的改过**仍然要报（只有尾部空白被放过，中间和正文一个字符都不能吞）。
  assert.equal(fieldInactive({ key: 'reply_style', value: `${body}\n`, effective: '回复比较少女化。' }), true);
  assert.equal(fieldInactive({ key: 'reply_style', value: `${body}啊\n`, effective: body }), true);
  // 文件里没写（value 为 null）不算未生效 —— 冷字段不该打红字。
  assert.equal(fieldInactive({ key: 'reply_style', value: null, effective: body }), false);
});


// ---------------------------------------------------------------- 布局与显示名（2026-10-30）

test('显示名：客户端表优先，其次宿主 label，都没有才显示 key', () => {
  // 表里有的老字段：名字不能因为宿主换了个叫法就跳（用户看惯「行为规则」）
  assert.equal(fieldLabel({ key: 'rules', label: '硬规矩' }), '行为规则');
  // 表里没有的新字段：用宿主给的中文名，不必再改两处
  assert.equal(fieldLabel({ key: 'mood.cooldown_minutes', label: '硬冷却（分钟，0=关）' }), '硬冷却（分钟，0=关）');
  // 什么都没有：显示 key（不隐藏、不留空）
  assert.equal(fieldLabel({ key: 'brand.new.key' }), 'brand.new.key');
});

test('窄字段判定：数字 / 开关 / 下拉能挤一行，文本与多行占整行', () => {
  for (const type of ['number', 'bool', 'enum']) {
    assert.equal(fieldCompact({ key: 'x', type }), true, type + ' 应该能挤一行');
  }
  for (const type of ['text', 'multiline', 'array', undefined]) {
    assert.equal(fieldCompact({ key: 'x', type }), false, String(type) + ' 应该占整行');
  }
});
