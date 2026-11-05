/**
 * 知识学习：被动回复后，用 LLM 从"用户消息 + 助手回复"提炼事实，
 * 存进人物画像，让小鲸鱼"记住你说过什么"。
 *
 * ## 为什么不学 MaiBot（用户 2026-10-05 的决定）
 *
 * 原话：「这块反正别学 MaiBot 了，**屎山就是他累积起来的**」。
 *
 * 查过它的实现（`src/plugins/built_in/relation/relation.py`）：
 * `person.memory_points.append(...)` **无上限累积**，而它自己的提示词只写了
 * "注意分类数一般不超过 5 个""记忆内容不超过 5 个"这种**软约束** ——
 * 对 LLM 没有约束力，代码层也没有兜底。结果：一份 546 人的画像里，
 * 有人被记了 **1,321 条、12.9 万字**，其中 **82% 是推测**。
 *
 * 所以我们这里做**硬约束**（三件，见下），而不是靠提示词里一句"一般"。
 *
 * ## 治源头三件事
 *
 * 1. **标来源**（本文件的提示词）：每条必须带 `[事实]` 或 `[推测]`。
 *    **拿不准就标推测** —— 因为不标的会被当事实用（用户拍板"推测也留着，但必须标"）。
 * 2. **不重复记**（本文件 + `binding.mjs` 调用方）：把这个人**已有的记忆**喂进来，
 *    明确告诉它"这些记过了"。以前不传，所以同一件事被反复记。
 * 3. **上限与去重**（`knowledge.remember` 里）：相似度去重 + 每人上限。
 *
 * 触发时机（保守）：只在**私聊被动回复后**抽。私聊 1 对 1、噪音低；
 * 群聊主动插话不抽，避免把群里七嘴八舌灌进画像。
 *
 * @module qq-gugu/learner
 */

import { isMeaningless } from './content-filter.mjs';
import { ORIGIN } from './knowledge.mjs';

/**
 * 从 LLM 文本里抠出 JSON 数组（容错，不依赖 json_repair）。
 * @param {string} text
 * @returns {string[]}
 */
export function parseFacts(text) {
  const s = String(text ?? '');
  const m = /\[[\s\S]*\]/.exec(s);
  if (m === null) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  } catch {
    return [];
  }
}

/**
 * 构造学习器。
 * @param {object} options
 * @param {(opts: {provider: string, model: string, system: string, messages: Array<any>, maxTokens: number}) => AsyncIterable<any>} options.stream
 * @param {string} options.provider
 * @param {string} options.model
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {number} [options.maxKnownFacts] 往提示词里塞几条"已有记忆"（默认 30）
 */
export function createLearner({
  stream,
  provider,
  model,
  // 推理强度。默认 `off`：事实提炼是**后台小任务**（每轮私聊跑一次，输出上限
  // 300 token 的 JSON），是"照着模板抽字段"，不需要推理。
  // 不显式传的话会继承模型默认档（flash 默认 `high`），纯浪费钱。
  reasoningEffort = 'off',
  log = () => {},
  maxKnownFacts = 30,
}) {
  /**
   * 从一轮对话提炼事实。
   * @param {object} input
   * @param {string} input.userText 用户这轮说的话
   * @param {string} input.assistantText 小鲸鱼这轮的回复
   * @param {string[]} [input.knownFacts] **这个人已经记住的东西** —— 传进来防重复记
   * @returns {Promise<string[]>} 提炼出的事实（带 `[事实]`/`[推测]` 前缀，可能为空）
   */
  async function learn({ userText, assistantText, knownFacts = [] }) {
    const u = String(userText ?? '').trim();
    // 内容过滤：无意义的话不抽（打卡、运势、纯刷屏……）。
    if (isMeaningless(u)) return [];

    // 只取最近的若干条：最新的更可能和当前话题相关，而且提示词不能无限长
    const known = (Array.isArray(knownFacts) ? knownFacts : [])
      .map((f) => String(f ?? '').trim())
      .filter((f) => f !== '')
      .slice(-maxKnownFacts);

    const prompt = [
      '从下面这轮对话，提炼 0~3 条「关于说话人」值得长期记住的东西。',
      '',
      '【只提炼】身份、偏好、正在做的事、与我（小鲸鱼）的关系、他明确说过的事实、',
      '以及你对他的**判断**（性格倾向、在意的点、说话习惯）。',
      '【不要提炼】情绪、寒暄、一次性的闲聊。',
      '',
      '【每条开头必须标来源】',
      `${ORIGIN.FACT} = 他明确说过的（他的原话里有依据）`,
      `${ORIGIN.GUESS} = 你从语气/上下文推断的（他没明说）`,
      `拿不准就标 ${ORIGIN.GUESS}。**宁可标推测，也别把猜测当事实** ——`,
      '因为没标的会被当成事实用，而猜错的话会被说出去。',
      '',
      ...(known.length > 0
        ? [
          '【已经记过下面这些，不要重复记】',
          ...known.map((f) => `  ${f}`),
          '',
        ]
        : []),
      '每条一句话、简短，用 JSON 字符串数组返回，例如：',
      `  ["${ORIGIN.FACT} 他在做 QQ 机器人", "${ORIGIN.GUESS} 他偏好深夜工作"]`,
      '没有值得记的就返回 []。',
      '',
      `说话人消息：${u.slice(0, 500)}`,
      `我的回复：${String(assistantText ?? '').slice(0, 300)}`,
      '',
      '直接给 JSON 数组本身。',
    ].join('\n');

    let text = '';
    try {
      const chunks = stream({
        provider,
        model,
        reasoningEffort,
        system: '你是知识抽取器，只输出 JSON 字符串数组，不输出其他内容。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 300,
      });
      for await (const chunk of chunks) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      }
    } catch (error) {
      log('warn', '知识抽取失败', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }

    const facts = parseFacts(text);
    if (facts.length > 0) log('debug', '学到事实', { facts });
    return facts;
  }

  return { learn };
}
