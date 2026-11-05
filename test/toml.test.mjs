/**
 * 极简 TOML 解析器的测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseToml } from '../src/dsh/toml.mjs';

test('parseToml：段 + 字符串/数字/布尔/数组', () => {
  const doc = parseToml(`
[chat]
talk_frequency = 0.5
require_mention = true
alias_names = ["鸽子", "小鲸鱼"]

[access]
group_allow_from = ["200000001", "200000002"]
`);
  assert.equal(doc.chat.talk_frequency, 0.5);
  assert.equal(doc.chat.require_mention, true);
  assert.deepEqual(doc.chat.alias_names, ['鸽子', '小鲸鱼']);
  assert.deepEqual(doc.access.group_allow_from, ['200000001', '200000002']);
});

test('parseToml：注释（整行 + 行尾，字符串内 # 不算）', () => {
  const doc = parseToml(`
# 整行注释
[bot]
nickname = "小鲸鱼"  # 行尾注释
tag = "a#b"        # 字符串里的 # 不该被当注释
`);
  assert.equal(doc.bot.nickname, '小鲸鱼');
  assert.equal(doc.bot.tag, 'a#b');
});

test('parseToml：多行字符串 """..."""', () => {
  const doc = parseToml(`
[personality]
persona = """
第一行
第二行（含，逗号和（括号））
"""
`);
  assert.equal(doc.personality.persona, '第一行\n第二行（含，逗号和（括号））');
});

test('parseToml：字符串转义 \\n \\" \\\\', () => {
  const doc = parseToml('[x]\na = "带\\n换行"\nb = "带\\"引号\\""\n');
  assert.equal(doc.x.a, '带\n换行');
  assert.equal(doc.x.b, '带"引号"');
});

test('parseToml：仓库里的示例 qq-gugu.toml 能解析出人格四字段', () => {
  // ⚠️ 2026-11-05（开源版）：原来读的是部署机上那份真配置的**绝对路径** ——
  //    换台机器文件就不存在，这条测试会变成"只有作者能跑绿"。
  //    改成读仓库自带的脱敏示例：它必须始终能用当前代码解析，这本身就是一条约束。
  const path = fileURLToPath(new URL('../docs/config.example.qq-gugu.toml', import.meta.url));
  const text = fs.readFileSync(path, 'utf8');
  const doc = parseToml(text);
  const p = doc.personality;
  assert.ok(p, '应有 [personality] 段');

  // ⚠️ 2026-10-24：这条原来逐字钉死措辞（`reply_style.includes('平静')`），
  //    结果 10-22~10-24 有人把人格【有意重写】了（`reply_style` 改成条目式、
  //    `emotion_style` 从"自信自负"改成"傲娇"）⇒ 测试红了，而 **toml 和代码都没错**。
  //    ⇒ 这个测试的本意是"**四个字段能被解析出来**"（守的是 parseToml 的多行字符串处理），
  //      不是"措辞不许改"。把断言从**具体词**换成**形状**，从此改人格不会误报。
  //    ⚠️ 别再往里加"必须包含某个词"—— 人格是会被用户改的。
  for (const k of ['persona', 'reply_style', 'emotion_style', 'interest']) {
    assert.equal(typeof p[k], 'string', `[personality].${k} 应是字符串`);
    assert.ok(p[k].trim().length > 10, `[personality].${k} 应解析出正文（实际 ${JSON.stringify(String(p[k]).slice(0, 30))}）`);
  }
  // 只留一个"确实是这套人格"的弱标记（人设核心词，删它属于改设定而非改措辞）
  assert.ok(p.persona.includes('鲸鱼'), 'persona 应含鲸鱼人设');
});
