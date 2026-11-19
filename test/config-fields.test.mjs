/**
 * 配置字段定义：**「思考档」两个键的名字与文案**（2026-11-09 修的可读性 bug）。
 *
 * 事故现场：`sticker_gate.enableThinking` 的字段名是「开思考」，勾选框旁边只有一个
 * 「关」字。用户看不懂（原话「什么叫我勾上反而是关闭思考」）—— 这个键的真实语义是
 * 「强制关 / 跟随模型默认」两档，勾上 = **不发** `reasoningEffort`，由 provider 用
 * 自己的默认档（见 `src/dsh/image-desc.mjs` 的 `gate.enableThinking ? null : 'off'`）。
 *
 * 钉三件事：
 *
 * 1. 两个键（识图 / 表情包审核）的名字都带**归属 + 说的是哪一档**，任何一个都不许再叫
 *    「开思考」—— 那个名字本身就是误解的来源；
 * 2. 两档都写进字段定义（`onText` / `offText`）与 `hint`，且 `hint` 里必须同时出现
 *    「强制」与「默认」这类词，否则"勾上 = 不发"这层意思就丢了；
 * 3. 两个键**是两回事**（两条路、两个文件），名字不能撞、也不能互指。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fieldByKey, CONFIG_FIELDS } from '../src/dsh/config-fields.mjs';

/** 要修的两个键：识图（转发里那张图配一句话）与表情包审核（「认」）。 */
const THINKING_KEYS = ['vision_gate.enableThinking', 'sticker_gate.enableThinking'];

test('★ 识图 · 思考档：名字带归属与「思考档」，不再叫「开思考」', () => {
  const field = fieldByKey('vision_gate.enableThinking');
  assert.equal(field.type, 'bool');
  assert.ok(field.label.includes('思考档'), `label 必须说清这是"哪一档"：${field.label}`);
  assert.ok(field.label.includes('识图'), `label 必须带归属：${field.label}`);
  assert.ok(!field.label.includes('开思考'), `label 不许再叫「开思考」：${field.label}`);
  assert.ok(!/^开/.test(field.label), `label 不许以「开」开头：${field.label}`);
});

test('★ 表情包审核 · 思考档：名字带归属与「思考档」，不再叫「开思考」', () => {
  const field = fieldByKey('sticker_gate.enableThinking');
  assert.equal(field.type, 'bool');
  assert.ok(field.label.includes('思考档'), `label 必须说清这是"哪一档"：${field.label}`);
  assert.ok(field.label.includes('表情包审核'), `label 必须带归属：${field.label}`);
  assert.ok(!field.label.includes('开思考'), `label 不许再叫「开思考」：${field.label}`);
  assert.ok(!/^开/.test(field.label), `label 不许以「开」开头：${field.label}`);
});

test('★ 两个思考档的 hint 都写清「不勾 = 强制 / 勾上 = 默认」', () => {
  for (const key of THINKING_KEYS) {
    const field = fieldByKey(key);
    const hint = String(field.hint || '');
    assert.ok(hint.includes('强制'), `${key} 的 hint 必须出现「强制」：${hint}`);
    assert.ok(hint.includes('默认'), `${key} 的 hint 必须出现「默认」：${hint}`);
    assert.ok(hint.includes('reasoningEffort'), `${key} 的 hint 要说清发的是什么：${hint}`);
  }
});

test('★ 两个思考档的 onText / offText：勾上 = 跟随默认，不勾 = 强制关', () => {
  for (const key of THINKING_KEYS) {
    const field = fieldByKey(key);
    assert.equal(field.onText, '跟随模型默认', `${key} 的 onText`);
    assert.equal(field.offText, '关（强制不发思考）', `${key} 的 offText`);
    // 两档不能长得一样：一样就等于又回到"一个勾看不懂"的状态。
    assert.notEqual(field.onText, field.offText);
    assert.ok(!['开', '关', '是', '否'].includes(field.onText), `${key} 的 onText 不许是一个孤零零的字`);
    assert.ok(field.offText !== '关', `${key} 的 offText 不许只写一个「关」`);
  }
});

test('★ 两个思考档是两回事：不同段、不同文件、名字不撞', () => {
  const vision = fieldByKey('vision_gate.enableThinking');
  const sticker = fieldByKey('sticker_gate.enableThinking');
  assert.notEqual(vision.section, sticker.section);
  assert.notEqual(vision.file, sticker.file, '两条路各在一个文件里，别串');
  assert.notEqual(vision.label, sticker.label, '名字必须能区分「识图」与「表情包审核」');
  // 两个都默认 false：默认值变了就是改行为，这次不动。
  assert.equal(vision.default, false);
  assert.equal(sticker.default, false);
});

test('bool 字段要么自带两档文案，要么能按显示名生成（不留只有「开 / 关」的行）', () => {
  const bools = CONFIG_FIELDS.filter((field) => field.type === 'bool');
  assert.ok(bools.length > 10, `bool 字段数量异常：${bools.length}`);
  for (const field of bools) {
    const hasPairs = typeof field.onText === 'string' && field.onText !== ''
      && typeof field.offText === 'string' && field.offText !== '';
    // 没自带成对文案的，交给 web/logic.mjs 的 boolStateTexts() 按 label 生成；
    // 这里只钉"label 非空"这个前提 —— 空名字会让生成的文案变成「启用「」」。
    assert.ok(String(field.label || '').trim() !== '', `bool 字段 label 不能为空：${field.key}`);
    if (hasPairs) assert.notEqual(field.onText, field.offText, `${field.key} 两档文案不能一样`);
  }
});

// ── 这里**故意没有**「消息防抖」那两条（2026-11-19） ──
//
// 本仓库还没同步「消息防抖」这个功能（`src/dsh/debounce.mjs` 与 `resolveConfig` 的
// `debounce` 段都不在这里）⇒ 那两条测上去必然是红的，留着只会被当成"新坏的"。
// 等防抖整套搬过来时，把上游 `test/config-fields.test.mjs` 里那两条一起带回来。
