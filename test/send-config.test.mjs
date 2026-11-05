/**
 * `[send]` 段的读取（2026-10-18，`send_qq`）。
 *
 * 契约：`[send] rule` 是一句**写给她看**的话（"什么时候该自己往 QQ 发、发几条"），
 * 作为 prompt section 注入。读不到 / 类型不对 ⇒ 回默认（空串），**绝不 throw** ——
 * 这个文件在用户手里，写坏一个字段不该让小鲸鱼整个起不来（和 `loadRelayConfig`
 * / `loadFreeTimeConfig` 同一个约定，见 `relay-config.test.mjs`）。
 *
 * ⚠️ 全组**不碰线上那份 `qq-gugu.toml`**：所有 toml 都在 `test/.tmp-send-config-*`
 * 下现造（刻意不用 `os.tmpdir()` —— 受限沙箱里 `%TEMP%` 会被挡，那会让这组测试
 * 在本机永远是红的）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSendConfig } from '../src/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-send-config-';

function tempDir() {
  return fs.mkdtempSync(path.join(HERE, PREFIX));
}

function writeFile(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith(PREFIX)) fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
    }
  } catch {
    /* 收尾失败不该影响测试结果 */
  }
});

// B2（2026-10-25）：`autoReply` 加入返回值 —— 缺省 **fallback**（不是 always）。
// 2026-10-26：`maxImageMb`（`send_qq` 发图的本地文件大小上限）默认 10 MB。
const DEFAULTS = { rule: '', autoReply: 'fallback', splitMarker: '⟨cut⟩', splitMaxParts: 4, maxImageMb: 10 };

// ---------------------------------------------------------------- 读 toml

test('★ 读得到：[send] rule 原样读出来（去掉首尾空白）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', [
    '[personality]',
    'name = "小鲸鱼"',
    '',
    '[send]',
    'rule = "  想分几条说时调 send_qq；一次最多 3 条。  "',
    '',
  ].join('\n'));
  assert.deepEqual(loadSendConfig({ tomlPath }), {
    rule: '想分几条说时调 send_qq；一次最多 3 条。',
    autoReply: 'fallback',
    splitMarker: '⟨cut⟩',
    splitMaxParts: 4,
    maxImageMb: 10,
  });
});

test('★ 没有 [send] ⇒ 默认值（空串）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', '[personality]\nname = "小鲸鱼"\n');
  assert.deepEqual(loadSendConfig({ tomlPath }), DEFAULTS);
});

test('toml 不存在 ⇒ 默认值，绝不抛', () => {
  assert.deepEqual(
    loadSendConfig({ tomlPath: path.join(HERE, '.tmp-send-does-not-exist.toml') }),
    DEFAULTS,
  );
});

test('★ 垃圾值 ⇒ 回默认（不猜意思、不 throw）', () => {
  const dir = tempDir();
  // 1) 类型不对：数字 / 数组 / 表
  assert.deepEqual(
    loadSendConfig({ tomlPath: writeFile(dir, 'num.toml', '[send]\nrule = 42\n') }),
    DEFAULTS,
  );
  assert.deepEqual(
    loadSendConfig({ tomlPath: writeFile(dir, 'arr.toml', '[send]\nrule = ["a", "b"]\n') }),
    DEFAULTS,
  );
  // 2) `[send]` 本身不是表（TOML 里这是字符串）
  assert.deepEqual(
    loadSendConfig({ tomlPath: writeFile(dir, 'str.toml', 'send = "整段写错"\n') }),
    DEFAULTS,
  );
  // 3) toml 根本解析不了
  assert.deepEqual(
    loadSendConfig({ tomlPath: writeFile(dir, 'broken.toml', '[send\nrule = ???\n') }),
    DEFAULTS,
  );
  // 4) 空串 / 纯空白 ⇒ 也回空串（不是 "   "）
  assert.deepEqual(
    loadSendConfig({ tomlPath: writeFile(dir, 'blank.toml', '[send]\nrule = "   "\n') }),
    DEFAULTS,
  );
});

test('只认 [send] 一节：别的节里的 rule 不算数', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', [
    '[personality]',
    'rule = "这不是发消息的规矩"',
    '',
    '[free_time]',
    'rule = "还不是"',
    '',
  ].join('\n'));
  assert.deepEqual(loadSendConfig({ tomlPath }), DEFAULTS);
});

test('[send] 里的别的键不影响返回值（只取 rule）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', [
    '[send]',
    'enabled = true',
    'max_items = 3',
    'rule = "只认这一句"',
    '',
  ].join('\n'));
  assert.deepEqual(loadSendConfig({ tomlPath }), { rule: '只认这一句', autoReply: 'fallback', splitMarker: '⟨cut⟩', splitMaxParts: 4, maxImageMb: 10 });
});

// ---------------------------------------------------------------- auto_reply（B2）

test('★ auto_reply：三个合法值原样读出来', () => {
  const dir = tempDir();
  for (const mode of ['fallback', 'always', 'off']) {
    const tomlPath = writeFile(dir, `mode-${mode}.toml`, `[send]\nauto_reply = "${mode}"\n`);
    assert.equal(loadSendConfig({ tomlPath }).autoReply, mode, mode);
  }
});

test('★ auto_reply：不认识的取值 ⇒ 回 fallback（绝不退回 always）', () => {
  const dir = tempDir();
  for (const bad of ['FOO', 'ALWAYS', '', 'true']) {
    const tomlPath = writeFile(dir, `bad-${bad.replace(/\W/g, '') || 'empty'}.toml`, `[send]\nauto_reply = "${bad}"\n`);
    assert.equal(loadSendConfig({ tomlPath }).autoReply, 'fallback', `取值 ${JSON.stringify(bad)}`);
  }
});

test('auto_reply：首尾空白被吃掉（和 rule 同一个口径）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'trim.toml', '[send]\nauto_reply = "  always  "\n');
  assert.equal(loadSendConfig({ tomlPath }).autoReply, 'always');
});

test('auto_reply：大小写敏感 —— 大写的 ALWAYS 不算合法值（配置写错就别悄悄生效）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'upper.toml', '[send]\nauto_reply = "ALWAYS"\n');
  assert.equal(loadSendConfig({ tomlPath }).autoReply, 'fallback');
});

test('auto_reply：类型不对（数字 / 布尔 / 数组）⇒ fallback，绝不抛', () => {
  const dir = tempDir();
  for (const [name, body] of [
    ['num', '[send]\nauto_reply = 42\n'],
    ['bool', '[send]\nauto_reply = true\n'],
    ['arr', '[send]\nauto_reply = ["off"]\n'],
  ]) {
    assert.equal(loadSendConfig({ tomlPath: writeFile(dir, `${name}.toml`, body) }).autoReply, 'fallback', name);
  }
});

test('auto_reply 与 rule 互不影响：只写 mode 时 rule 仍是空串', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'only-mode.toml', '[send]\nauto_reply = "off"\n');
  assert.deepEqual(loadSendConfig({ tomlPath }), { rule: '', autoReply: 'off', splitMarker: '⟨cut⟩', splitMaxParts: 4, maxImageMb: 10 });
});

// ---------------------------------------------------------------- 切分配置（B3）

test('★ split_marker 原样读出来（去首尾空白）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'marker.toml', '[send]\nsplit_marker = "  ⟨cut⟩  "\n');
  assert.equal(loadSendConfig({ tomlPath }).splitMarker, '⟨cut⟩');
});

test('★ split_marker = "" ⇒ 读出来就是空串（"用户想关"不能被默认值吃掉）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'marker-off.toml', '[send]\nsplit_marker = ""\n');
  assert.equal(loadSendConfig({ tomlPath }).splitMarker, '');
});

test('split_marker 类型不对 ⇒ 回默认 ⟨cut⟩（不是空串 —— 静默关掉一个功能是最难查的）', () => {
  const dir = tempDir();
  for (const [name, body] of [
    ['num', '[send]\nsplit_marker = 7\n'],
    ['arr', '[send]\nsplit_marker = ["⟨cut⟩"]\n'],
  ]) {
    assert.equal(loadSendConfig({ tomlPath: writeFile(dir, `${name}.toml`, body) }).splitMarker, '⟨cut⟩', name);
  }
});

test('split_max_parts：正整数才认，其它一律回 4', () => {
  const dir = tempDir();
  const cases = [
    ['ok', '[send]\nsplit_max_parts = 6\n', 6],
    ['float', '[send]\nsplit_max_parts = 2.9\n', 2],
    ['zero', '[send]\nsplit_max_parts = 0\n', 4],
    ['neg', '[send]\nsplit_max_parts = -3\n', 4],
    ['str', '[send]\nsplit_max_parts = "很多"\n', 4],
    ['bool', '[send]\nsplit_max_parts = true\n', 4],
  ];
  for (const [name, body, want] of cases) {
    assert.equal(
      loadSendConfig({ tomlPath: writeFile(dir, `parts-${name}.toml`, body) }).splitMaxParts,
      want,
      name,
    );
  }
});

// 2026-10-26：`max_image_mb` —— `send_qq` 发图的**本地文件**大小上限。
test('★ max_image_mb：正数才认（≤200），其它一律回 10', () => {
  const dir = tempDir();
  const cases = [
    ['ok', '[send]\nmax_image_mb = 3\n', 3],
    ['float', '[send]\nmax_image_mb = 2.5\n', 2.5],
    ['zero', '[send]\nmax_image_mb = 0\n', 10],
    ['neg', '[send]\nmax_image_mb = -5\n', 10],
    ['huge', '[send]\nmax_image_mb = 999\n', 10],
    ['str', '[send]\nmax_image_mb = "10"\n', 10],
    ['bool', '[send]\nmax_image_mb = true\n', 10],
  ];
  for (const [name, body, want] of cases) {
    assert.equal(
      loadSendConfig({ tomlPath: writeFile(dir, `img-${name}.toml`, body) }).maxImageMb,
      want,
      name,
    );
  }
});
