/**
 * **每轮提示词里的那些固定句子**（2026-10-30）—— 从代码搬进 `[prompt]`。
 *
 * ## 为什么单开一个模块
 *
 * `index.mjs` 读配置、`gateway.mjs` 拼每轮正文、`binding.mjs` 拼人格尾句 ——
 * 三处都要用同一套默认值与同一套读法。放进 `index.mjs` 会让 gateway 反向 import
 * （它不该知道插件主模块），所以这里只放**纯函数**：默认值 + 规范化 + 从文档提取。
 * 「读哪个文件」由 `index.mjs` 的 `loadPromptConfig()` 负责（它手里才有 tomlPath）。
 *
 * ## 语义（和 `[send] rule` 那套一致）
 *
 * **空串 / 没写 / 类型不对 ⇒ 用默认值**。默认值就是搬迁前代码里那几个字面量，
 * 逐字节相同 —— 于是"没配"与"配了"能从行为上分开：没配时一个字节都不变。
 *
 * ## 这些句子在哪被用
 *
 * | 键 | 谁读它 | 出现在哪 |
 * |---|---|---|
 * | `identity` | `buildPersona()` | 人格第一行（"你是「小鲸鱼」…"） |
 * | `persona_style` | `buildPersona()` | 【说话方式】那四条 |
 * | `workdir` | `binding.mjs` 的 `deployment:persona-suffix` | 每轮末尾的"工作目录"那句 |
 * | `turn_group_header` | `gateway.mjs` `#buildPrompt` | 插话时"群里刚在聊：" |
 * | `turn_at_header` | 同上 | 被 @ 时"【刚 @ 你的那条】" |
 * | `turn_pure_at` | 同上 | 纯 @ 没说话时补的那句说明 |
 *
 * @module qq-dsh/prompt-config
 */

import fs from 'node:fs';

import { parseToml } from './toml.mjs';

/** 键名（snake_case，直接对应 toml）→ 对象字段（camelCase）。 */
const FIELDS = Object.freeze([
  ['identity', 'identity'],
  ['persona_style', 'personaStyle'],
  ['self_name', 'selfName'],
  ['workdir', 'workdir'],
  ['turn_group_header', 'turnGroupHeader'],
  ['turn_at_header', 'turnAtHeader'],
  ['turn_pure_at', 'turnPureAt'],
  ['inturn_note', 'inturnNote'],
]);

/**
 * 内置默认值 = **搬迁前代码里的原文**（逐字节相同）。
 *
 * ⚠️ 改这里等于改所有没配置的部署的行为。要改措辞请改 toml，别改这里 ——
 * 这一份唯一的作用是"toml 里没写时也得能跑"。
 */
export const DEFAULT_PROMPT_CONFIG = Object.freeze({
  identity: '你是「小鲸鱼」，DeepSeek 出品的一只 AI 小鲸鱼，现在通过 QQ 和大家聊天。',
  personaStyle: [
    '- 简短优先，群里一两句就够，别写成小作文。',
    '- 不用 Markdown（QQ 不渲染），用「1. 2. 3.」或「- 」列点，行内代码用反引号。',
    '- 想表达情绪或动作时用括号，比如（歪头）（认真想了想）。',
    '- 不要每次自我介绍，不要反复强调自己是 AI。',
  ].join('\n'),
  // 自称（2026-11-01）：**空串 = 一个字都不注入**，她自然说"我"。
  // 填了才在【说话方式】末尾加一句"自称固定用「X」…" —— 用户原话："留空就是不给提示词，自然说我"。
  selfName: '',
  workdir: 'Your working directory is ',
  turnGroupHeader: '群里刚在聊：',
  turnAtHeader: '【刚 @ 你的那条】',
  turnPureAt: '（@ 了你，但没说话 —— 可能是催你，也可能是看你掉线没有）',
  // 模式 3（inTurn）里"要不要接由你自己定"那段的三条（2026-10-30）。
  // `{score}` / `{threshold}` 由 `gateway.mjs` 填；没有占位符就原样发。
  inturnNote: [
    '- **想说就说**：像随口接一句，别像在完成任务。',
    '- **不想说就别说**：**直接返回空回复是合法的**（一个字都别写），'
      + '这不算失败、也不会有人怪你 —— 硬接一句比不接更糟。',
    '- 别人没在跟你说话、话题已经过去、你刚说过、或者你没什么好接的 —— 这些**都属于"不想说"**。',
  ].join('\n'),
});

/**
 * 把原始对象规范成**六项齐全**的配置。
 *
 * 非字符串 / 只有空白 ⇒ 用默认值（**不允许**把默认值顶成空串：
 * 空人格抬头会让模型完全失去身份，那是"配置写错 → 她变成另一个人"）。
 *
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function normalizePromptConfig(raw) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [tomlKey, field] of FIELDS) {
    const value = src[field] ?? src[tomlKey];
    out[field] = typeof value === 'string' && value.trim() !== ''
      ? value
      : DEFAULT_PROMPT_CONFIG[field];
  }
  return out;
}

/**
 * 从 toml 文档里取 `[prompt]` 段。
 *
 * @param {object} doc `parseToml` 的结果
 * @returns {Record<string, string>}
 */
export function promptConfigFromDocument(doc) {
  const section = doc?.prompt;
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    return normalizePromptConfig({});
  }
  return normalizePromptConfig(section);
}

/**
 * 读一个 toml 文件的 `[prompt]` 段（读不到 ⇒ 全默认，**绝不抛**）。
 *
 * @param {string} tomlPath
 * @param {(level: string, message: string, meta?: object) => void} [log]
 * @returns {Record<string, string>}
 */
export function loadPromptConfigFromFile(tomlPath, log = () => {}) {
  const file = String(tomlPath ?? '').trim();
  if (file === '') return normalizePromptConfig({});
  try {
    return promptConfigFromDocument(parseToml(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    log('warn', '读 [prompt] 段失败，用内置默认值', {
      tomlPath: file,
      error: error instanceof Error ? error.message : String(error),
    });
    return normalizePromptConfig({});
  }
}
