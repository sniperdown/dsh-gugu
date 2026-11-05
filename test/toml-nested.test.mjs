/**
 * 点分嵌套段（`[a.b."c"]`）的解析测试。
 *
 * 起因：用户 2026-10-04 要"通配 + 指定群覆盖"，于是 toml 里出现了
 * `[proactive.groups."200000002"]` 这种写法。而原来的 `parseToml`
 * 把 `[section]` 的整串当成一个键名 —— 结果是
 * `doc['proactive.groups."200000002"']` 而不是 `doc.proactive.groups['200000002']`，
 * 覆盖规则**静默失效**（读的时候 `doc.proactive.groups` 是 undefined）。
 *
 * 这类 bug 的可怕之处在于：**不报错**。配置写了、语法也对，
 * 只是没生效 —— 表现出来就是"我改了门槛但它还是不说话"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseToml } from '../src/dsh/toml.mjs';

test('单层段照旧（不能改坏）', () => {
  const doc = parseToml('[personality]\nname = "小鲸鱼"\n');
  assert.deepEqual(doc, { personality: { name: '小鲸鱼' } });
});

test('★ 点分嵌套段：[a.b."c"] 要真的嵌进去', () => {
  const doc = parseToml('[proactive.groups."200000002"]\nburstMinMessages = 2\n');
  assert.ok(doc.proactive, 'proactive 层要存在');
  assert.ok(doc.proactive.groups, 'groups 层要存在');
  assert.equal(doc.proactive.groups['200000002'].burstMinMessages, 2, '群号那层要存在');
  // 反面证据：不该再出现"整串当一个键"的旧行为
  assert.equal(doc['proactive.groups."200000002"'], undefined, '不该把整串当键名');
});

test('两层嵌套：[a.b]', () => {
  const doc = parseToml('[srv.http]\nport = 3000\n');
  assert.equal(doc.srv.http.port, 3000);
});

test('★ 引号里的点不当分隔符', () => {
  const doc = parseToml('[groups."a.b.c"]\nx = 1\n');
  assert.equal(doc.groups['a.b.c'].x, 1, '带点的键名要完整保留');
});

test('多段混排：通配段和覆盖段互不干扰', () => {
  const doc = parseToml([
    '[proactive]',
    'burstMinMessages = 2',
    '',
    '[proactive.groups."111"]',
    'burstMinMessages = 1',
    '',
    '[proactive.groups."222"]',
    'enabled = false',
    '',
  ].join('\n'));
  assert.equal(doc.proactive.burstMinMessages, 2, '通配段还在');
  assert.equal(doc.proactive.groups['111'].burstMinMessages, 1);
  assert.equal(doc.proactive.groups['222'].enabled, false);
});

test('覆盖段写完后，再回通配段也能继续追加（current 要跟着切）', () => {
  const doc = parseToml([
    '[proactive]',
    'a = 1',
    '[proactive.groups."111"]',
    'b = 2',
    '[proactive.groups."222"]',
    'c = 3',
  ].join('\n'));
  assert.equal(doc.proactive.a, 1);
  assert.equal(doc.proactive.groups['111'].b, 2);
  assert.equal(doc.proactive.groups['222'].c, 3);
});

test('段里的注释和多行字符串不受影响', () => {
  const doc = parseToml([
    '# 顶层注释',
    '[personality]',
    'personality = """',
    '第一行',
    '第二行',
    '"""',
    '[proactive.groups."111"]  # 行尾注释',
    'x = 1',
  ].join('\n'));
  assert.match(doc.personality.personality, /第一行\n第二行/);
  assert.equal(doc.proactive.groups['111'].x, 1);
});

test('空段名、连续点、首尾点都要安全（不炸）', () => {
  const cases = ['[]', '[.]', '[a..b]', '[.a]', '[a.]'];
  for (const c of cases) {
    assert.doesNotThrow(() => parseToml(`${c}\nx = 1\n`), `${c} 不该抛异常`);
  }
});
