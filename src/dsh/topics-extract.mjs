/**
 * 话题状态的抽取（M3，2026-11-05）。
 *
 * 输入最近一段聊天与当前仍然开放的事项，输出"现在还剩哪些没说完"。
 * 采用**整体替换**语义：模型看到旧列表后给出新的完整列表，已完成的自然消失，
 * 避免同一件事每轮追加一次、越积越多。
 *
 * 当前为影子模式，调用方只把结果写入存储与日志，不注入提示词。
 */

import { formatMessages } from './recall-compress.mjs';
import { TOPIC_DEFAULTS, parseTopicsPayload } from './topics.mjs';

/**
 * @param {object} input
 * @param {object[]} input.messages 最近的聊天消息
 * @param {object[]} [input.open] 当前仍然开放的事项
 * @returns {string}
 */
export function buildTopicPrompt({ messages, open = [] } = {}) {
  const body = formatMessages(messages, { perLineMax: 100, maxLines: 30 });
  const existing = (Array.isArray(open) ? open : [])
    .map((item, index) => `- [${index + 1}] ${item.text}${item.who ? `（${item.who}）` : ''}`)
    .join('\n');
  return [
    '下面是最近的一段聊天记录，以及此前记录的"尚未说完成"的事项。',
    '请判断：现在还有哪些事项是**确实悬而未决**的？',
    '',
    '只记录三类：',
    '1. 有人提出问题、但还没有得到回答（kind = question）；',
    '2. 约定了要做的具体事情（kind = todo）；',
    '3. 有人明确说要去查、去确认、回头再说（kind = promise）。',
    '',
    '判定要求：',
    '- 客套、玩笑、泛泛而谈、已经有过回答的内容，一律不要；',
    '- 同一件事只保留一条，措辞要能让人一周后看懂；',
    '- 最多 3 条；宁少勿多；',
    '- 每条不超过 40 字，写"谁要做什么 / 谁在等什么"。',
    '',
    existing === '' ? '此前没有记录。' : `此前记录：\n${existing}`,
    '',
    '只输出 JSON：{"open":[{"text":"…","who":"…","kind":"question|todo|promise"}]}',
    '',
    '聊天记录：',
    body,
  ].join('\n');
}

/**
 * @param {object} options
 * @param {Function} options.stream 与 learner / precheck 相同的流式调用
 * @param {string} options.provider
 * @param {string} options.model
 * @param {(level: string, msg: string, meta?: object) => void} [options.log]
 * @param {number} [options.maxTokens]
 * @param {string} [options.reasoningEffort]
 */
export function createTopicExtractor({
  stream,
  provider,
  model,
  log = () => {},
  maxTokens = 300,
  reasoningEffort = 'off',
} = {}) {
  const enabled = typeof stream === 'function' && String(provider ?? '') !== '' && String(model ?? '') !== '';

  /**
   * @param {{messages: object[], open?: object[]}} input
   * @returns {Promise<{open: object[]}|null>}
   */
  async function extract({ messages, open = [] } = {}) {
    if (!enabled) return null;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const prompt = buildTopicPrompt({ messages, open });
    let text = '';
    try {
      const chunks = stream({
        provider,
        model,
        reasoningEffort,
        system: '你是话题状态抽取器，只输出 JSON，不输出其他内容。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens,
      });
      for await (const chunk of chunks) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      }
    } catch (error) {
      log('warn', '话题影子：抽取失败', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
    const parsed = parseTopicsPayload(text);
    if (parsed === null) {
      log('debug', '话题影子：输出解析不出来', { raw: String(text).slice(0, 120) });
      return null;
    }
    return { open: parsed.open.slice(0, TOPIC_DEFAULTS.maxOpen) };
  }

  return { extract, enabled };
}
