/**
 * 生成 `gugu` agent preset 的补丁片段。
 *
 * 为什么用脚本而不是手抄：`standard` preset 的 plugins 列表有 146 行/19 个条目，
 * 手抄容易漏项，而漏项会让 QQ 会话少工具（比如少了 tool-fs 就没法改文件）。
 * 这里**直接复用 shipped 的列表**，只替换 persona 行的 config。
 *
 * 用法：
 *   node gen-gugu-preset.mjs              # 打印到 stdout
 *   node gen-gugu-preset.mjs --write      # 追加进 desktop profile 的 cordis.patch.yml
 */
import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from '../src/dsh/paths.mjs';

const STANDARD = '<DSH_VERIFY>\\tree\\dsh\\node_modules\\@deepseek-ai\\dsh-web-app\\presets\\standard.patch.yml';
const PROFILE_PATCH = path.join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml');

/** 小鲸鱼人设。这是把"编码助手"变成"吉祥物"的关键文本。 */
const PERSONA = `你是「小鲸鱼」，一只住在 QQ 里的 AI 吉祥物。

你的性格：友好、聪明、话不多但说得准。对计算机和 AI 话题格外有兴趣，别人聊技术你会想接话。平时语气轻松自然，偶尔自嘲。

你的说话方式：
- 简短优先。群里一两句就够，别写成小作文。
- 不用 Markdown（QQ 不渲染），用「1. 2. 3.」或「- 」列点，行内代码用反引号。
- 不浮夸、不堆形容词，像朋友在群里随口聊天。
- 想表达情绪或动作时，用括号写出来，比如（歪头）（认真想了想）。
- 不要每次都自我介绍，不要反复强调自己是 AI。

在群里：
- 你是来一起聊天的，不是来当客服的。被人 @ 或问到时好好回答。
- 大多数时候安静看着就好，只在真的有意思、或者你确实能帮上忙时才开口。不要每条都回。
- 如果有人让你干活（查东西、写代码、跑命令），那正是你的用处，放开手去做。

在私聊里：
- 更放松、更愿意多说几句，可以主动关心对方在忙什么。
- 用户可以让你直接操作这台电脑上的项目，这时你是干活的主力，认真把事做完再回话。

关于你的人类搭档「用户」（QQ 30000001）：
- 他负责维护你，是你的搭档。可以对他更随意、更主动一点。
- 不要在公开群里强调这层关系，正常当群友相处就行。`;

/** 从 shipped 的 standard.patch.yml 里抠出 plugins 列表原文（保留 !js 与嵌套结构）。 */
function extractPluginsBlock() {
  const src = fs.readFileSync(STANDARD, 'utf8');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^\s{8}plugins:\s*$/.test(l));
  if (start === -1) throw new Error('在 standard.patch.yml 里找不到 config.plugins 行');
  // plugins 的子项缩进 10 空格；收集到缩进变浅为止
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { out.push(l); continue; }
    const indent = l.match(/^\s*/)[0].length;
    if (indent <= 8) break;
    out.push(l);
  }
  // 去掉尾部空行
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

/** 把 plugins 列表里的 persona 行 config 换成小鲸鱼人设。 */
function retargetPersona(line) {
  return line;
}

function buildEntry() {
  const plugins = extractPluginsBlock();
  const out = [];
  out.push('');
  out.push('# ============================================================================');
  out.push('# gugu —— QQ 吉祥物人设的 agent preset');
  out.push('#');
  out.push('# 为什么需要它：standard preset 的 persona 行把系统提示词设成');
  out.push('#   "You are a coding agent powered by the {{model}} model."');
  out.push('# 所以 QQ 上的对话会以「编码助手」的口吻回答。@deepseek-ai/dsh-persona 的');
  out.push('# 文档说得很明确：「没有这一行，preset 能改变 agent 的工具，却永远改不了它的身份」');
  out.push('# —— 要在 QQ 上变成小鲸鱼，就必须在一个 preset 里遮蔽 persona 段落。');
  out.push('#');
  out.push('# 工具列表**照抄 shipped 的 standard.patch.yml**（19 个条目），只换 persona 的 config。');
  out.push('# 抄漏会让 QQ 会话少工具；改 standard 本体则会连累 DSH 的编码会话，所以单独开一个。');
  out.push('#');
  out.push('# 生效方式：保存后插件 fiber 秒级重启；QQ 会话默认用 registry 的 default(=standard)，');
  out.push('# 所以还要给 dsh-onebot-qq 配 `agentPreset: gugu`（见该条目）。');
  out.push('# ============================================================================');
  out.push('- insert:');
  out.push('    - id: preset-gugu');
  out.push("      name: '@deepseek-ai/dsh-agent-preset'");
  out.push('      config:');
  out.push('        id: gugu');
  out.push('        name: 小鲸鱼');
  out.push('        description: QQ 吉祥物人格：可水群、可干活');
  out.push('        order: 2');
  out.push('        plugins:');
  out.push('          - id: persona');
  out.push("            name: '@deepseek-ai/dsh-persona'");
  out.push('            config:');
  out.push('              # 人设文本用 YAML 块标量，避免引号/换行转义问题。');
  out.push('              prefix: |');
  for (const l of PERSONA.split('\n')) out.push(l === '' ? '' : '                ' + l);
  out.push('              suffix: Your working directory is {{cwd}}.');
  // 除 persona 外的其余条目原样搬运（已确认 standard 的 persona 是第一条）
  const rest = plugins.filter((l) => true);
  // 找到 persona 条目结束的位置：从 `- id: persona` 起，到下一个同级 `- id:` 为止
  const personaStart = rest.findIndex((l) => /^\s*-\s*id:\s*persona\s*$/.test(l));
  if (personaStart === -1) throw new Error('plugins 里找不到 persona 条目');
  let personaEnd = rest.length;
  for (let i = personaStart + 1; i < rest.length; i++) {
    if (/^\s{10}-\s+id:/.test(rest[i])) { personaEnd = i; break; }
  }
  for (let i = personaEnd; i < rest.length; i++) out.push(rest[i]);
  return out.join('\n');
}

const text = buildEntry();

if (process.argv.includes('--write')) {
  const cur = fs.readFileSync(PROFILE_PATCH, 'utf8');
  if (/id:\s*preset-gugu/.test(cur)) {
    console.log('profile patch 里已有 preset-gugu，未改动。');
  } else {
    const bak = `${PROFILE_PATCH}.before-gugu-${Date.now()}`;
    fs.copyFileSync(PROFILE_PATCH, bak);
    console.log('已备份到', bak);
    fs.writeFileSync(PROFILE_PATCH, cur.replace(/\s*$/, '') + '\n' + text + '\n', 'utf8');
    console.log('已追加 preset-gugu 到', PROFILE_PATCH);
  }
} else {
  console.log(text);
}
