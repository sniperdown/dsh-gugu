/**
 * **出站白名单**：决定"这条消息能不能发到那个会话"。
 *
 * ## 为什么单独一个模块
 *
 * 它被这三处共用（它们各自的入口不同，但"能不能发到那个会话"必须是同一份答案）：
 *
 * - `send_qq` 工具（她主动发消息）
 * - 主动语音
 * - `speakProactively`（主动插话 / 上线播报 / 定时唤醒）
 *
 * ## 语义
 *
 * `allowFrom` 管私聊、`groupAllowFrom` 管群；**两边都没列 = 一律拒绝**（fail-closed）。
 *
 * ⚠️ 归一化用的是 `routing.mjs` 的 `normalizeIdList` —— **与 Router 同一份实现**。
 * 两边解释不一致的坑很隐蔽：配置里写了个带空格的号，路由认它、出站不认，
 * 表现成"这个人明明能跟它说话，它却一个字都发不回去"。
 *
 * @module qq-dsh/outbound-allow
 */

import { normalizeIdList } from './routing.mjs';

/**
 * 建一个出站白名单判定器。
 *
 * @param {object} [options]
 * @param {unknown} [options.allowFrom] 允许的私聊 QQ 号（通常是配置的 `allowFrom`）
 * @param {unknown} [options.groupAllowFrom] 允许的群号（通常是配置的 `groupAllowFrom`）
 * @returns {(kind: string, target: string|number) => boolean} 判定器
 */
export function createOutboundAllow({ allowFrom = [], groupAllowFrom = [] } = {}) {
  const privateIds = new Set(normalizeIdList(allowFrom));
  const groupIds = new Set(normalizeIdList(groupAllowFrom));

  /**
   * @param {string} kind `'private'` 或 `'group'`（其余一律 false，**大小写敏感**）
   * @param {string|number} target 私聊是 QQ 号、群聊是群号
   */
  return function outboundAllowed(kind, target) {
    // ⚠️ 这里**故意不 trim**：target 来自 chatId 的解析结果，本来就是干净的。
    // 顺手 trim 等于悄悄放宽（`' 123 '` 本来不该被当成 `'123'`），
    // 而这是出站边界 —— 宁可多拒一个畸形输入。
    const t = String(target ?? '');
    if (kind === 'private') return privateIds.has(t);
    if (kind === 'group') return groupIds.has(t);
    return false;
  };
}
