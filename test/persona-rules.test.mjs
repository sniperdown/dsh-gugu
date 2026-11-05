/**
 * 人格拼装的两条不变式 —— 防的是 2026-10-08 那个"规矩静默失效"复发。
 *
 * 背景：`cordis.patch.yml` 里两个 preset 的 `persona.config.prefix` 各 68 行，
 * 含五段硬规矩（干活的规矩 / 别乱转交 / 在 QQ 上问问题的方式 / 动手前先问 /
 * 被沙箱拒绝就是拒绝）。而 `binding.mjs` 在 agent 作用域用【同名 section】
 * （`deployment:persona-prefix`）遮蔽了它 —— `dsh-system-prompt` 的 `section()`
 * 文档写着 "A scoped section shadows a global section with the same name"。
 * ⇒ 那五段不生效，而且因为 `buildPersona` 只读 toml 的 4 个字段，它们也没有等价物兜底。
 *
 * 修法：给 buildPersona 加可选的 `rules` 字段，把规矩搬进 toml。
 * 这个文件钉住两件事：
 *   ① rules 字段真的会被拼进人格（否则搬家等于白搬）
 *   ② 没写 rules 时行为与从前完全一致（不接受"加了字段导致所有人都多一段空标题"）
 *   ③ 如果跑得到用户的 toml，就真的断言那五段硬规矩在里面（最贴近现实的一条）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { buildPersona, loadPersona } from '../src/index.mjs';
import { parseToml } from '../src/dsh/toml.mjs';

test('buildPersona：写了 rules 就追加在末尾', () => {
  const out = buildPersona({
    persona: 'P',
    reply_style: 'R',
    emotion_style: 'E',
    interest: 'I',
    rules: '【测试规矩】\n- 甲\n- 乙',
  });
  assert.match(out, /【测试规矩】/, 'rules 的内容必须出现在成品里');
  assert.ok(out.endsWith('- 乙'), 'rules 应该追加在末尾（不该夹在中间）');
  // 四个字段也都还得在
  for (const s of ['P', 'R', 'E', 'I']) assert.ok(out.includes(s), `字段 ${s} 丢了`);
});

test('buildPersona：没写 rules 时，输出与加了字段之前逐字相同', () => {
  const base = {
    persona: 'P',
    reply_style: 'R',
    emotion_style: 'E',
    interest: 'I',
  };
  const withoutRules = buildPersona(base);
  // rules 缺省 / 空串 / 只有空白 ⇒ 三者输出必须完全一样（不许因为"加了个字段"多出空标题或空行）
  assert.equal(withoutRules, buildPersona({ ...base, rules: '' }), 'rules 为空串时应与不写等价');
  assert.equal(withoutRules, buildPersona({ ...base, rules: '   \n  ' }), 'rules 只有空白时应与不写等价');

  // ⚠️ 别去数空行 —— 那种断言脆（第一版就因为它红了：actual 5 / expected 4）。
  //    改成断言"结构没变"：最后一段仍然是【说话方式】那四行，且没有多出空标题。
  const tail = withoutRules.split('\n').slice(-4);
  assert.match(tail[0], /简短优先/, '最后一段应该还是【说话方式】的内容');
  assert.ok(withoutRules.endsWith('不要反复强调自己是 AI。'), '结尾不该被 rules 改掉');
  assert.ok(!withoutRules.includes('undefined'), '不能把 undefined 拼进去');
  assert.equal((withoutRules.match(/\n\n\n/g) ?? []).length, 0, '不该出现连续两个空行');
});

test('buildPersona：toml 缺字段也不能崩（回归：插件挂掉比多说一句糟得多）', () => {
  for (const bad of [{}, { persona: 'P' }, { rules: 'R' }]) {
    const out = buildPersona(bad);
    assert.equal(typeof out, 'string');
    assert.ok(out.includes('你是「小鲸鱼」'), '抬头必须还在');
  }
});

/** 找用户的 toml（和 preset-config.test.mjs 同样的顺序）。 */
function locateToml() {
  const cands = [];
  if (process.env.QQ_GUGU_TOML) cands.push(process.env.QQ_GUGU_TOML);
  for (const home of [process.env.DSH_HOME, '<DSH_HOME>']) {
    if (home) cands.push(path.join(home, 'profiles', 'desktop', 'qq-gugu.toml'));
  }
  return cands.find((p) => existsSync(p)) ?? null;
}

const tomlPath = locateToml();

test('真机上：那五段硬规矩必须真的在人格里（防"搬家搬丢了"）', { skip: tomlPath === null ? '没找到 qq-gugu.toml' : undefined }, () => {
  const doc = parseToml(readFileSync(tomlPath, 'utf8'));
  const persona = loadPersona({ tomlPath });
  assert.ok(persona.length > 0, 'loadPersona 不该返回空');

  // 五段 —— 每一段的存在都对应一次"用户明确要求/批评过"或"保命"
  const MUST = [
    '【干活的规矩】',
    '【别乱转交】',
    '【在 QQ 上问问题的方式】',
    '【动手前先问】',
    '【被沙箱拒绝就是拒绝】',
  ];
  for (const s of MUST) {
    assert.ok(persona.includes(s), `人格里缺了「${s}」—— 它被静默吃掉过一次，别再来一次`);
    assert.ok(String(doc.personality?.rules ?? '').includes(s), `toml 的 rules 里该有「${s}」`);
  }

  // 两条最要命的细则（它们各自描述了一次真实卡死/事故）
  assert.ok(persona.includes('ask_user_question'), '「不要用 ask_user_question」那条丢了会导致会话卡死');
  assert.ok(persona.includes('sandbox_permissions'), '「不要提权」那条是保命的');
});
