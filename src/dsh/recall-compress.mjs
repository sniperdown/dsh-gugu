/**
 * 聊天回想的"压缩"那一步（M1，2026-11-04）。
 *
 * 输入被转录挤出去的一批消息（时间 + 昵称 + 文本），输出
 * `{summary ≤200 字, cues: 3~5 条}`。**纯函数负责拼提示词与解析**，
 * 真正的模型调用用注入的 `stream`（与 learner / precheck 同一种形状），
 * 这样离线测试不需要网络。
 */

import { parseRecallPayload } from './recall.mjs';

/** 把消息列表压成提示词里的"一段聊天"。 */
export function formatMessages(messages, { perLineMax = 120, maxLines = 40 } = {}) {
  const list = Array.isArray(messages) ? messages.slice(-maxLines) : [];
  return list
    .map((m) => {
      const text = String(m?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, perLineMax);
      if (text === '') return '';
      const who = String(m?.nickname ?? '').trim() || String(m?.userId ?? '').trim() || '某人';
      const at = Number(m?.at) > 0 ? new Date(Number(m.at)) : null;
      const hhmm = at !== null && !Number.isNaN(at.getTime())
        ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
        : '';
      return `- ${hhmm} ${who}: ${text}`;
    })
    .filter((l) => l !== '')
    .join('\n');
}

export function buildCompressPrompt(messages) {
  const body = formatMessages(messages);
  return [
    '下面是一段群/私聊的聊天记录（即将从上下文窗口里被挤出去）。',
    '请把它压缩成一条可以在一周后看懂的中文摘要，并给出 3~5 条召回线索。',
    '',
    '要求：',
    '1. 摘要 ≤200 字，写"聊了什么、结论是什么、有没有没做完的事"，不要逐句复述；',
    '2. 不要记录流水账、玩笑、客套；对方纠正过的内容以最后一次为准；',
    '3. cues 是"以后想再翻出这段记忆时可能出现的词或话题"，每条 ≤12 字；',
    '4. 如果这段没有值得记住的东西，返回 {"summary":"","cues":[]}。',
    '',
    '只输出 JSON：{"summary":"…","cues":["…","…"]}',
    '',
    '聊天记录：',
    body,
  ].join('\n');
}

/**
 * @param {object} options
 * @param {Function} options.stream 与 learner 相同的流式调用
 * @param {string} options.provider
 * @param {string} options.model
 * @param {(level: string, msg: string, meta?: object) => void} [options.log]
 * @param {number} [options.maxTokens]
 * @param {string} [options.reasoningEffort]
 */
export function createRecallCompressor({
  stream,
  provider,
  model,
  log = () => {},
  maxTokens = 400,
  reasoningEffort = 'off',
} = {}) {
  const enabled = typeof stream === 'function' && String(provider ?? '') !== '' && String(model ?? '') !== '';

  /**
   * @param {object[]} messages
   * @returns {Promise<{summary: string, cues: string[]}|null>}
   */
  async function compress(messages) {
    if (!enabled) return null;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const prompt = buildCompressPrompt(messages);
    let text = '';
    try {
      const chunks = stream({
        provider,
        model,
        reasoningEffort,
        system: '你是聊天记忆压缩器，只输出 JSON，不输出其他内容。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens,
      });
      for await (const chunk of chunks) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      }
    } catch (error) {
      log('warn', '回想压缩失败', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
    const parsed = parseRecallPayload(text);
    if (parsed === null) {
      log('debug', '回想压缩：模型输出解析不出来', { raw: String(text).slice(0, 120) });
      return null;
    }
    if (parsed.summary === '' && parsed.cues.length === 0) return null;
    return parsed;
  }

  return { compress, enabled };
}
