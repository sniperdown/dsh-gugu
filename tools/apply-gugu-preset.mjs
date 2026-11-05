/**
 * 生成并**校验** gugu preset，校验通过才写入 profile。
 * 校验用 DSH 自带的 yaml 包，确保与 loader 看到的一致。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { dshHome } from '../src/dsh/paths.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const GEN = '<repo>\\tools\\gen-gugu-preset.mjs';
const YAML_DIR = '<DSH_VERIFY>\\tree\\dsh\\node_modules\\yaml';
const PROFILE_PATCH = path.join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml');

const require = createRequire(YAML_DIR + '\\');
const YAML = require('yaml');

// 1) 生成
const text = execFileSync(process.execPath, [GEN], { encoding: 'utf8' });
console.log('生成', text.split('\n').length, '行');

// 2) 解析校验
let parsed;
try {
  parsed = YAML.parse(text);
} catch (e) {
  console.error('❌ YAML 解析失败:', e.message);
  process.exit(1);
}
console.log('✔ YAML 解析通过');

// 3) 结构校验
const insert = parsed[0].insert;
if (!Array.isArray(insert) || insert.length !== 1) throw new Error('insert 结构不对');
const preset = insert[0];
if (preset.id !== 'preset-gugu') throw new Error('id 不是 preset-gugu');
if (preset.name !== '@deepseek-ai/dsh-agent-preset') throw new Error('name 不对');
if (preset.config.id !== 'gugu') throw new Error('config.id 不是 gugu');
const plugins = preset.config.plugins;
console.log('✔ plugins 条目数:', plugins.length);
console.log('   条目:', plugins.map((p) => p.id).join(', '));

const persona = plugins.find((p) => p.id === 'persona');
if (!persona) throw new Error('缺 persona 行');
if (persona.name !== '@deepseek-ai/dsh-persona') throw new Error('persona 的 name 不对');
const prefix = persona.config.prefix;
if (!prefix || prefix.length < 200) throw new Error('人设文本太短，可能没生成');
console.log('✔ persona.prefix 长度:', prefix.length, '字符');
console.log('✔ persona.config.suffix:', JSON.stringify(persona.config.suffix));
console.log('✔ 人设含「小鲸鱼」:', prefix.includes('小鲸鱼'));
console.log('✔ 人设含「用户」:', prefix.includes('用户'));

// 与 standard 对比，确认工具没漏
const stdText = fs.readFileSync(
  '<DSH_VERIFY>\\tree\\dsh\\node_modules\\@deepseek-ai\\dsh-web-app\\presets\\standard.patch.yml',
  'utf8',
);
const stdParsed = YAML.parse(stdText);
const stdPlugins = stdParsed[0].insert[0].config.plugins;
const stdIds = stdPlugins.map((p) => p.id);
const ourIds = plugins.map((p) => p.id);
const missing = stdIds.filter((id) => !ourIds.includes(id));
console.log('');
console.log('  standard 工具数:', stdIds.length, ' gugu 工具数:', ourIds.length);
console.log('  缺失条目:', missing.length === 0 ? '无 ✔' : JSON.stringify(missing));
if (missing.length > 0) throw new Error('漏了工具条目: ' + missing.join(','));

// 4) 写入
if (process.argv.includes('--write')) {
  const cur = fs.readFileSync(PROFILE_PATCH, 'utf8');
  if (/id:\s*preset-gugu/.test(cur)) {
    console.log('');
    console.log('profile patch 里已有 preset-gugu，未改动。');
  } else {
    const bak = `${PROFILE_PATCH}.before-gugu-${Date.now()}`;
    fs.copyFileSync(PROFILE_PATCH, bak);
    fs.writeFileSync(PROFILE_PATCH, cur.replace(/\s*$/, '') + '\n' + text, 'utf8');
    console.log('');
    console.log('✔ 已写入', PROFILE_PATCH);
    console.log('  备份:', bak);
    // 复核整个文件仍可解析
    const whole = YAML.parse(fs.readFileSync(PROFILE_PATCH, 'utf8'));
    console.log('✔ 合并后的整个 patch 文件仍可解析，顶层条目数:', whole.length);
  }
} else {
  console.log('');
  console.log('（未写入；加 --write 生效）');
}
