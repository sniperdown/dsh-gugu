/**
 * 内容质量过滤：判断一条消息值不值得进知识库。
 *
 * 用户点名的问题：群里有大量"文字冒险/打卡/运势"等功能型机器人的固定格式消息，
 * 被当成知识抽进图谱，污染越滚越大。所以信息抽取**之前**先过这道闸。
 *
 * 核心原则（用户原话）：按"内容有没有意义"过滤，不是按"是不是机器人"过滤 ——
 * 真人也会打卡刷屏，机器人偶尔也有用。
 *
 * @module qq-gugu/content-filter
 */

/** 明显无意义的命令/功能型前缀（打卡、签到、运势、文字冒险等）。 */
const COMMAND_PREFIXES = ['#', '/', '！', '!', '。'];
const MEANINGLESS_KEYWORDS = [
  '打卡', '签到', '运势', '占卜', '抽签', '今日宜', '今日忌',
  '文字冒险', '开始冒险', '继续冒险', '冒险', '任务', '菜单', '帮助',
  '欢迎新人', '退群', '被禁言', '撤回了一条消息',
];

/**
 * 这条消息值不值得进知识库。
 *
 * @param {string} text 消息纯文本
 * @returns {boolean} true = 无意义（该过滤），false = 值得记
 */
export function isMeaningless(text) {
  const t = String(text ?? '').trim();

  // 1. 空 / 过短
  if (t.length < 2) return true;

  // 2. 没有可读文字（纯数字/符号/纯 emoji）—— 只要不含中文或英文字母就视为无意义
  if (!/[\u4e00-\u9fffA-Za-z]/.test(t)) return true;

  // 3. 命令 / 功能型前缀（#帮助、/菜单 等）
  if (COMMAND_PREFIXES.some((p) => t.startsWith(p))) return true;

  // 4. 关键词黑名单（打卡、签到、运势、文字冒险…）
  for (const kw of MEANINGLESS_KEYWORDS) {
    if (t.includes(kw)) return true;
  }

  return false;
}
