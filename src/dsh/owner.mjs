/**
 * `[owner] admins` —— "谁是这台机器人的用户"的**声明**（2026-10-21）。
 *
 * ## 为什么单独一段
 *
 * 在这之前，用户是从白名单里**推**出来的：
 *
 * ```js
 * const ownerQq = normalizeIdList(config.allowFrom)[0];
 * ```
 *
 * 也就是"白名单第一个 = 用户"。这条约定有两处问题：
 *
 * 1. `allowFrom` 同时是**出站白名单**（能不能跟机器人说话）。往它加人（本意只是
 *    允许对方聊天）会**顺带改变用户是谁** —— 两个语义绑在一个数组的顺序上。
 * 2. "第一个"依赖手写顺序，而数组顺序在配置文件里最容易在编辑时被改动。
 *
 * 所以单开 `[owner] admins`：**先读它，空了才回退到白名单第一个**。
 * 本轮它**只做身份声明**：可读、可写、可观测，**不接任何权限判断**
 * （用户明确要求先不管权限）。
 *
 * ## toml 形状
 *
 * ```toml
 * [owner]
 * admins = ["30000001"]
 * ```
 *
 * 界面上按英文逗号填写，写回时存成**字符串数组**。
 *
 * ## 规范化（加载器负责，调用方不要各自再实现一遍）
 *
 * - 去空白；
 * - 只留纯数字（`/^\d+$/`）—— 非数字项**丢弃**而不是报错：这一段在用户手改的
 *   toml 里，写错一个字符不该让机器人起不来；
 * - **去重、保序**（第一个是主用户）；
 * - 留空 / 缺失 ⇒ 空数组。
 *
 * @module qq-dsh/owner
 */

import fs from 'node:fs';

import { normalizeIdList } from './routing.mjs';
import { parseToml } from './toml.mjs';

/** 用户的来源。名字直接进快照，所以用小写驼峰。 */
export const OWNER_SOURCE = Object.freeze({
  /** 来自 `[owner] admins`。 */
  OWNER: 'owner',
  /** `[owner] admins` 为空，回退到 `allowFrom` 的第一个。 */
  ALLOW_FROM: 'allowFrom',
  /** 两处都没有 ⇒ 没有用户。 */
  NONE: 'none',
});

/**
 * 把 `[owner] admins` 的原始值规范成**字符串数组**。
 *
 * 接受两种形状（都是配置文件里可能出现的）：
 * - 数组：`["30000001", 12345]`
 * - 字符串：`"30000001, 12345"`（界面按英文逗号填写；兼容中文逗号/顿号/分号/空白）
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeAdminList(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(/[\s,，、;；]+/);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (item === undefined || item === null) continue;
    const text = String(item).trim();
    // 只留纯数字：QQ 号是数字，混进名字/带 `QQ:` 前缀的写法一律丢掉。
    if (text === '' || !/^\d+$/.test(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 决定"用户是谁、这个值从哪来"。
 *
 * 规则（用户指定）：`admins[0] ?? allowFrom[0]` —— **admins 为空才回退**。
 *
 * @param {{admins?: unknown, allowFrom?: unknown}} [input]
 * @returns {{admins: string[], source: string, qq: string}}
 *   - `admins`：`[owner] admins` 规范化之后的值（**原样**，不含回退项）；
 *   - `source`：`owner` / `allowFrom` / `none`；
 *   - `qq`：真正在用的那个号（回退时是白名单第一个）。
 */
export function resolveOwner({ admins, allowFrom } = {}) {
  const list = normalizeAdminList(admins);
  const allow = normalizeIdList(allowFrom);
  if (list.length > 0) {
    return { admins: list, source: OWNER_SOURCE.OWNER, qq: list[0] };
  }
  if (allow.length > 0) {
    return { admins: list, source: OWNER_SOURCE.ALLOW_FROM, qq: allow[0] };
  }
  return { admins: list, source: OWNER_SOURCE.NONE, qq: '' };
}

/**
 * 从已解析的 toml 文档 + 配置里取用户。
 *
 * 单独抽出来是为了能测：不该为了验一条解析规则去造一个真文件。
 *
 * @param {object} doc `parseToml` 的结果
 * @param {object} config 经 `resolveConfig` 的配置（只读 `allowFrom`）
 * @returns {{admins: string[], source: string, qq: string}}
 */
export function ownerFromTomlDocument(doc, config = {}) {
  const section = doc?.owner;
  const admins = section !== null && typeof section === 'object' && !Array.isArray(section)
    ? section.admins
    : undefined;
  return resolveOwner({ admins, allowFrom: config?.allowFrom });
}

/**
 * 读 `qq-gugu.toml` 的 `[owner]` 段。
 *
 * 读不到 / 解析失败 / 那一段不存在 ⇒ **按空数组处理**，并且**绝不抛异常**
 * （这一段在用户手改的文件里；配置文件写错不该让插件起不来）。
 *
 * @param {object} config 经 `resolveConfig` 的配置（用 `tomlPath` / `allowFrom`）
 * @param {(level: string, message: string, meta?: object) => void} [log]
 * @param {{tomlPath?: string}} [options] 可显式给 toml 路径（测试用）
 * @returns {{admins: string[], source: string, qq: string}}
 */
export function loadOwnerConfig(config, log = () => {}, options = {}) {
  const tomlPath = String(options.tomlPath ?? config?.tomlPath ?? '').trim();
  if (tomlPath === '') {
    // 走 `defaultTomlPath()` 是 index.mjs 的事；本模块不硬编码部署路径。
    return resolveOwner({ admins: [], allowFrom: config?.allowFrom });
  }
  try {
    const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
    return ownerFromTomlDocument(doc, config);
  } catch (error) {
    log('warn', '读 qq-gugu.toml 的 [owner] 失败，按空数组处理（回退白名单第一个）', {
      tomlPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return resolveOwner({ admins: [], allowFrom: config?.allowFrom });
  }
}

/**
 * 快照里 `snapshot.owner` 的形状。
 *
 * ⚠️ **只吐 `admins` 与 `source`**：这是契约，前端按这两个字段判断
 * "配了哪些用户 / 用户这个值是从哪儿来的"。
 *
 * @param {{admins?: string[], source?: string}} owner
 * @returns {{admins: string[], source: string}}
 */
export function ownerSnapshot(owner = {}) {
  const source = owner?.source;
  return {
    admins: normalizeAdminList(owner?.admins),
    source: source === OWNER_SOURCE.OWNER || source === OWNER_SOURCE.ALLOW_FROM
      ? source
      : OWNER_SOURCE.NONE,
  };
}
