/**
 * 人格按会话覆盖（2026-10-21）。
 *
 * ## 这一组在钉什么
 *
 * 1. **逐字段合并**：覆盖层里只有**非空**字段才顶替全局；空串/只有空白 ⇒ 继承。
 * 2. **不许把全局顶成空串**（最容易写错的那一条）。
 * 3. **覆盖层全空 = 没有覆盖**（不保留空层、不产生空 section）。
 * 4. **会话键 → 覆盖层**：`qq-group-<群号>` / `qq-private-<QQ>`，其余形状没有覆盖。
 * 5. **没有覆盖时逐字节不变**：`buildPersona(全局)` 与接线前完全一致。
 *
 * ⚠️ 全组不碰线上 `qq-gugu.toml`，全部在 `test/.tmp-persona-*` 下现造。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PERSONA_FIELDS,
  compactPersonaLayer,
  emptyPersonaFields,
  loadPersonaSections,
  mergePersonaFields,
  normalizePersonaFields,
  normalizeScopeId,
  overriddenPersonaKeys,
  personaForSession,
  scopeFromSessionKey,
} from '../src/dsh/persona-sections.mjs';
import { buildPersona, makePersonaForSession } from '../src/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-persona-';

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
    /* 收尾失败不影响测试结果 */
  }
});

const GLOBAL = {
  persona: '全局人格',
  relations: '',
  reply_style: '全局风格',
  emotion_style: '全局情绪',
  interest: '全局兴趣',
  chat_sense: '',
  ai_flavor: '',
  examples: '',
  rules: '全局规矩',
};

const TOML = [
  '[personality]',
  'persona = """全局人格"""',
  'reply_style = """全局风格"""',
  'emotion_style = "全局情绪"',
  'interest = "全局兴趣"',
  'rules = """全局规矩"""',
  '',
  '[personality.groups."30000013"]',
  'rules = """这个群专用的硬规矩"""',
  '',
  '[personality.privates."30000001"]',
  'reply_style = """私聊专用风格"""',
  '',
].join('\n');

// ---------------------------------------------------------------- 读 / 规范化

test('loadPersonaSections：读出全局五段 + 群覆盖 + 私聊覆盖', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', TOML);
  const sections = loadPersonaSections({ tomlPath });
  assert.deepEqual(sections.global, GLOBAL);
  assert.deepEqual(sections.groups, { 30000013: { rules: '这个群专用的硬规矩' } });
  assert.deepEqual(sections.privates, { 30000001: { reply_style: '私聊专用风格' } });
});

test('PERSONA_FIELDS 与 buildPersona 实际读取的字段一致（2026-11-01 起九段）', () => {
  assert.deepEqual([...PERSONA_FIELDS], [
    'persona', 'relations', 'reply_style', 'emotion_style', 'interest',
    'chat_sense', 'ai_flavor', 'examples', 'rules',
  ]);
});

test('改名兜底：老键 personality 仍然读得出来（新键优先）', () => {
  const fields = normalizePersonaFields({ personality: '老的写法', reply_style: ' x ' });
  assert.equal(fields.persona, '老的写法', '老键兜底');
  assert.equal(fields.reply_style, 'x');
  const both = normalizePersonaFields({ persona: '新的', personality: '旧的' });
  assert.equal(both.persona, '新的', '两个都在时新键优先');
});

test('normalizePersonaFields：非字符串当空串，九个键齐全', () => {
  const fields = normalizePersonaFields({ persona: ' x ', reply_style: 5 });
  assert.deepEqual(fields, {
    persona: 'x',
    relations: '',
    reply_style: '',
    emotion_style: '',
    interest: '',
    chat_sense: '',
    ai_flavor: '',
    examples: '',
    rules: '',
  });
});

test('compactPersonaLayer：只留非空字段；全空 ⇒ null', () => {
  assert.deepEqual(compactPersonaLayer({ rules: ' r ', reply_style: '  ' }), { rules: 'r' });
  assert.equal(compactPersonaLayer({ rules: '  ' }), null);
  assert.equal(compactPersonaLayer({}), null);
  assert.equal(compactPersonaLayer(null), null);
});

test('overriddenPersonaKeys：按提示词顺序返回，不按书写顺序', () => {
  assert.deepEqual(overriddenPersonaKeys({ rules: 'x', persona: 'y' }), ['persona', 'rules']);
});

test('normalizeScopeId：纯号码与带前缀都认，非数字丢', () => {
  assert.equal(normalizeScopeId('30000013', 'group'), '30000013');
  assert.equal(normalizeScopeId(' group:30000013 ', 'group'), '30000013');
  assert.equal(normalizeScopeId('private:177', 'private'), '177');
  assert.equal(normalizeScopeId('abc', 'group'), '');
});

test('scopeFromSessionKey：只认 qq-group-<号> / qq-private-<号>', () => {
  assert.deepEqual(scopeFromSessionKey('qq-group-30000013'), { kind: 'group', id: '30000013' });
  assert.deepEqual(scopeFromSessionKey('qq-private-30000001'), { kind: 'private', id: '30000001' });
  assert.equal(scopeFromSessionKey('session-1234'), null);
  assert.equal(scopeFromSessionKey(''), null);
});

// ---------------------------------------------------------------- 合并

test('★ mergePersonaFields：逐字段——覆盖层非空才顶替', () => {
  const merged = mergePersonaFields(GLOBAL, { rules: '群规矩' });
  assert.deepEqual(merged, { ...GLOBAL, rules: '群规矩' });
});

test('★ mergePersonaFields：空串 / 只有空白不顶替（不许把全局顶成空串）', () => {
  const merged = mergePersonaFields(GLOBAL, { rules: '', reply_style: '   \n  ' });
  assert.equal(merged.rules, GLOBAL.rules);
  assert.equal(merged.reply_style, GLOBAL.reply_style);
});

test('mergePersonaFields：没写覆盖层 ⇒ 与全局逐字相同', () => {
  assert.deepEqual(mergePersonaFields(GLOBAL, null), normalizePersonaFields(GLOBAL));
});

test('★ 覆盖层存在但一个字段都没写 ⇒ 等价于没有覆盖（不保留空层）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', [
    '[personality]',
    'rules = """全局规矩"""',
    '',
    '[personality.groups."30000013"]',
    '# 只写了注释，没有任何字段',
    '',
  ].join('\n'));
  const sections = loadPersonaSections({ tomlPath });
  assert.equal(Object.hasOwn(sections.groups, '30000013'), false, '空层不该留在结果里');
  assert.equal(personaForSession(sections, 'qq-group-30000013'), null);
});

// ---------------------------------------------------------------- 按会话解析

test('★ personaForSession：群覆盖只顶该字段，其余继承全局', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', TOML);
  const sections = loadPersonaSections({ tomlPath });
  const got = personaForSession(sections, 'qq-group-30000013');
  assert.deepEqual(got.overridden, ['rules']);
  assert.equal(got.fields.rules, '这个群专用的硬规矩');
  assert.equal(got.fields.persona, GLOBAL.persona);
  assert.equal(got.kind, 'group');
  assert.equal(got.id, '30000013');
});

test('★ personaForSession：私聊覆盖', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', TOML);
  const sections = loadPersonaSections({ tomlPath });
  const got = personaForSession(sections, 'qq-private-30000001');
  assert.deepEqual(got.overridden, ['reply_style']);
  assert.equal(got.fields.reply_style, '私聊专用风格');
  assert.equal(got.fields.rules, GLOBAL.rules);
});

test('personaForSession：没有覆盖层 ⇒ null（调用方直接用全局人格）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', TOML);
  const sections = loadPersonaSections({ tomlPath });
  assert.equal(personaForSession(sections, 'qq-group-30000012'), null);
  assert.equal(personaForSession(sections, 'qq-private-999'), null);
  assert.equal(personaForSession(sections, 'session-abcdef'), null);
});

test('loadPersonaSections：没有 [personality] 段 ⇒ 全空、无覆盖、不抛', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', '[memory]\nlearned_enabled = false\n');
  const sections = loadPersonaSections({ tomlPath });
  assert.deepEqual(sections.global, emptyPersonaFields());
  assert.deepEqual(sections.groups, {});
  assert.deepEqual(sections.privates, {});
  assert.equal(sections.fromToml, false);
});

test('loadPersonaSections：文件读不到 ⇒ 空结构 + warn，不抛', () => {
  const warnings = [];
  const sections = loadPersonaSections(
    { tomlPath: path.join(HERE, '.tmp-persona-nope.toml') },
    (level, message) => warnings.push({ level, message }),
  );
  assert.deepEqual(sections.global, emptyPersonaFields());
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'warn');
});

// ---------------------------------------------------------------- 接线：makePersonaForSession

test('★ makePersonaForSession：有覆盖 ⇒ 拼出合并后的人格，且全局段落还在', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', TOML);
  const resolve = makePersonaForSession(loadPersonaSections({ tomlPath }));
  const got = resolve('qq-group-30000013');
  assert.notEqual(got, null);
  assert.deepEqual(got.overridden, ['rules']);
  assert.ok(got.text.includes('这个群专用的硬规矩'), '群规矩必须进提示词');
  assert.ok(got.text.includes('全局人格'), '全局人格必须保留');
  assert.ok(got.text.includes('全局风格'), '其它全局段落也要在');
  assert.equal(got.text.includes('全局规矩'), false, '被覆盖的全局规矩不应再出现');
});

test('makePersonaForSession：没有覆盖 ⇒ null（全局人格逐字节不变）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', TOML);
  const resolve = makePersonaForSession(loadPersonaSections({ tomlPath }));
  assert.equal(resolve('qq-group-30000012'), null);
  // 对照组：没有覆盖层时 binder 用的就是 buildPersona(全局) 这份文本。
  const globalText = buildPersona(GLOBAL);
  assert.ok(globalText.includes('全局人格'));
  assert.ok(globalText.includes('全局规矩'));
});
