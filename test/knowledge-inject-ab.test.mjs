/**
 * 静态知识库注入的 A+B 旋钮测试（2026-10-17）。
 *
 * ## 为什么这一组必须存在
 *
 * 用户发现小鲸鱼的提示词"有点长"：静态知识库 `knowledge.json` 每轮都把
 * 「2 条画像 + 若干概念」**拼进用户消息**，而且**留在会话历史里累积**
 * （实测每轮 490 字"在吗" / 1767~1822 字带资讯）。用户批准了两件事：
 *
 *   A. 加**注入上限**（`[memory] inject_max_chars`，默认 800，按条目丢、不切半句）
 *   B. **私聊**改走 system prompt 的 section（`qq:knowledge`，不进历史 ⇒ 不累积）
 *
 * ## 三条静默失效（这一组的重点）
 *
 * 1. **读不到 `[memory]` 时行为必须与改动前等价**（上限 800、私聊走 section）
 *    —— 否则"没写这两行"会变成"悄悄换了注入方式"（不报错）。
 * 2. **写错类型不许当真值**：`inject_max_chars = "800"`（字符串）、`0`、负数
 *    ⇒ 一律回默认 800。`inject_private_as_section = "false"` 在 JS 里是**真值**，
 *    那正好把用户想关的开关吃掉 ⇒ 只认布尔。
 * 3. **快照必须能看出"配了"和"真的生效了"是两件事**：`maxChars` 与
 *    `lastChars`/`lastMode` 分开记 —— 只看一个数看不出接线漏没漏。
 *
 * ⚠️ 全组**不碰线上数据**：toml 写在测试目录下的临时目录里，
 * 快照是 `buildSnapshot()` 的纯函数产物（不写 `<DSH_HOME>\media\`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pluginModule from '../src/index.mjs';
import { buildSnapshot } from '../src/dsh/debug-snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 写一份临时 toml，返回路径。
 *
 * ⚠️ **刻意不用 `os.tmpdir()`**（照 `learned-memory-switch.test.mjs`）：
 * 受限沙箱里 `%LOCALAPPDATA%\Temp` 会被挡，`mkdtempSync` 直接 EPERM ⇒
 * 这组测试会**在本机永远是红的**，而且看起来像代码坏了。
 */
function tempToml(body) {
  const dir = fs.mkdtempSync(path.join(HERE, '.tmp-inject-'));
  const file = path.join(dir, 'qq-gugu.toml');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith('.tmp-inject-')) {
        fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
      }
    }
  } catch {
    // 清理失败不影响测试结果。
  }
});

const load = pluginModule.loadLearnedMemoryConfig;
assert.equal(typeof load, 'function', 'loadLearnedMemoryConfig 必须是导出的函数');

test('缺少 toml/段时三个值都回默认：learned 开、上限 800、私聊走 section', () => {
  const cfg = load({ tomlPath: path.join(HERE, '.tmp-inject-nonexistent.toml') });
  assert.equal(cfg.learnedEnabled, true);
  assert.equal(cfg.injectMaxChars, 800);
  assert.equal(cfg.injectPrivateAsSection, true);
});

test('toml 里显式配了就照配的来', () => {
  const toml = tempToml([
    '[memory]',
    'learned_enabled = false',
    'inject_max_chars = 500',
    'inject_private_as_section = false',
    '',
  ].join('\n'));
  const cfg = load({ tomlPath: toml });
  assert.equal(cfg.learnedEnabled, false);
  assert.equal(cfg.injectMaxChars, 500);
  assert.equal(cfg.injectPrivateAsSection, false);
});

test('inject_max_chars 写错类型/太小 ⇒ 回默认 800，不许当 0', () => {
  for (const bad of ['"800"', '0', '-5', 'true', '800.7']) {
    const toml = tempToml(['[memory]', `inject_max_chars = ${bad}`, ''].join('\n'));
    const cfg = load({ tomlPath: toml });
    if (bad === '800.7') {
      // 正数小数是"能读懂的数"，取整即可（不当成写错）。
      assert.equal(cfg.injectMaxChars, 800, `800.7 该取整成 800，实际 ${cfg.injectMaxChars}`);
    } else {
      assert.equal(cfg.injectMaxChars, 800, `${bad} 该回默认 800，实际 ${cfg.injectMaxChars}`);
    }
  }
});

test('inject_private_as_section 写字符串 "false" ⇒ 不许被当成 truthy', () => {
  const toml = tempToml(['[memory]', 'inject_private_as_section = "false"', ''].join('\n'));
  const cfg = load({ tomlPath: toml });
  assert.equal(cfg.injectPrivateAsSection, true, '"false" 是字符串，必须回默认 true');
});

test('快照的 knowledgeInject 段：null 时是 null，喂对象时四个字段都在', () => {
  const snapNull = buildSnapshot({ gateway: {}, engine: {}, transport: {}, config: {} });
  assert.equal(snapNull.knowledgeInject, null);

  const snap = buildSnapshot({
    gateway: {},
    engine: {},
    transport: {},
    config: {},
    knowledgeInject: { maxChars: 800, privateAsSection: true, lastChars: 412, lastMode: 'section' },
  });
  assert.deepEqual(snap.knowledgeInject, {
    maxChars: 800,
    privateAsSection: true,
    lastChars: 412,
    lastMode: 'section',
  });
});

test('快照对坏输入 fail-safe：缺字段/类型不对不许抛', () => {
  const snap = buildSnapshot({
    gateway: {},
    engine: {},
    transport: {},
    config: {},
    knowledgeInject: { maxChars: 'x', privateAsSection: 'yes', lastChars: null, lastMode: 42 },
  });
  assert.equal(snap.knowledgeInject.maxChars, 0);
  assert.equal(snap.knowledgeInject.privateAsSection, false);
  assert.equal(snap.knowledgeInject.lastChars, 0);
  assert.equal(snap.knowledgeInject.lastMode, 'none');
});
