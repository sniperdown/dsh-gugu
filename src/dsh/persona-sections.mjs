/**
 * 人格的**按会话覆盖层**（2026-10-21）。
 *
 * ## 背景
 *
 * `buildPersona()` 原来只读全局的 `[personality]` 五段，于是所有群、所有私聊
 * 共用同一份人格。用户要的是"某些群单独加一条硬规矩，别的不动"，所以加覆盖层：
 *
 * ```toml
 * [personality]
 * personality = "…全局…"
 * reply_style = "…"
 * emotion_style = "…"
 * interest = "…"
 * rules = "…"
 *
 * [personality.groups."30000013"]   # 只写想覆盖的字段
 * rules = "…这个群专用的硬规矩…"
 *
 * [personality.privates."30000001"]  # 私聊按 QQ 号
 * reply_style = "…"
 * ```
 *
 * ## 合并规则（逐字段，不是整段替换）
 *
 * - 覆盖层里**只有非空**的字段才顶替全局；
 * - 空串 / 只有空白 / 缺失 ⇒ **继承全局**（不允许把全局顶成空串）；
 * - 覆盖层存在但**一个字段都没写** ⇒ 等价于没有覆盖（不保留空层）。
 *
 * ## 字段名
 *
 * 以 `buildPersona()` 实际读取的为准：`personality` / `reply_style` /
 * `emotion_style` / `interest` / `rules`（`rules` 是可选段，见 `buildPersona`）。
 *
 * @module qq-dsh/persona-sections
 */

import fs from 'node:fs';

import { parseToml } from './toml.mjs';

/** `buildPersona()` 实际读取的字段（顺序 = 提示词里的顺序）。 */
export const PERSONA_FIELDS = Object.freeze([
  'persona',
  'relations',
  'reply_style',
  'emotion_style',
  'interest',
  'chat_sense',
  'ai_flavor',
  'examples',
  'rules',
]);

/**
 * **老名字 → 新名字**（2026-11-01 改名：`[personality]` 表里的 `personality` 字段
 * 与表名重名，容易看成两个不同的东西 ⇒ 字段改叫 `persona`）。
 *
 * 这里只做**读时兜底**：`persona` 优先，没有才看 `personality`。
 * ⇒ 老的 toml、老的覆盖层、老的测试 fixture 一个字节都不用改，照样读得出来。
 *
 * 写侧**只写新名字**（`config-fields.mjs` 的 `tomlKey = 'persona'`）；
 * 线上那份 toml 已经在迁移时把老键删掉了，不会长期并存。
 */
const FIELD_ALIASES = Object.freeze({ persona: 'personality' });

/** 读一个字段：新名字优先，老名字兜底。 */
function readPersonaField(src, field) {
  const direct = src[field];
  if (direct !== undefined) return direct;
  const alias = FIELD_ALIASES[field];
  return alias === undefined ? undefined : src[alias];
}

/**
 * 五段全空的基线。
 * @returns {Record<string, string>}
 */
export function emptyPersonaFields() {
  const out = {};
  for (const field of PERSONA_FIELDS) out[field] = '';
  return out;
}

/**
 * 把一段人格对象规范成**五段齐全、值为 trim 后的字符串**。
 *
 * 非字符串值一律当空串（`personality = 5` 这种写错不该让提示词里出现 `5`）。
 *
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function normalizePersonaFields(raw) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const field of PERSONA_FIELDS) {
    const value = readPersonaField(src, field);
    out[field] = typeof value === 'string' ? value.trim() : '';
  }
  return out;
}

/**
 * 这一层里**真的写了**哪些字段（非空），按 {@link PERSONA_FIELDS} 的顺序。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function overriddenPersonaKeys(raw) {
  const fields = normalizePersonaFields(raw);
  return PERSONA_FIELDS.filter((field) => fields[field] !== '');
}

/**
 * 逐字段合并：覆盖层里非空的才顶替。
 *
 * @param {unknown} base 全局五段
 * @param {unknown} override 覆盖层
 * @returns {Record<string, string>}
 */
export function mergePersonaFields(base, override) {
  const merged = normalizePersonaFields(base);
  const layer = normalizePersonaFields(override);
  for (const field of PERSONA_FIELDS) {
    if (layer[field] !== '') merged[field] = layer[field];
  }
  return merged;
}

/**
 * 把 toml 里的一层覆盖规范成"只有非空字段"的对象；**全空 ⇒ `null`**。
 *
 * `null` 的语义是"这一层不存在"——调用方不必再判空，也不会产生空 section。
 *
 * @param {unknown} raw
 * @returns {Record<string, string>|null}
 */
export function compactPersonaLayer(raw) {
  const keys = overriddenPersonaKeys(raw);
  if (keys.length === 0) return null;
  const fields = normalizePersonaFields(raw);
  const out = {};
  for (const key of keys) out[key] = fields[key];
  return out;
}

/**
 * `[personality.groups]` / `[personality.privates]` 下面的键规范化。
 *
 * 容忍两种写法：纯号码（`"30000013"`）或带前缀（`"group:30000013"`）。
 * 带前缀的那种是历史/手写容错，不是推荐写法。
 *
 * @param {unknown} key
 * @param {'group'|'private'} kind
 * @returns {string} 规范化后的号码；不可用时为空串
 */
export function normalizeScopeId(key, kind) {
  let text = key === undefined || key === null ? '' : String(key).trim();
  if (text === '') return '';
  const prefix = `${kind}:`;
  if (text.startsWith(prefix)) text = text.slice(prefix.length).trim();
  return /^\d+$/.test(text) ? text : '';
}

/**
 * 从 toml 文档里读出全局五段 + 两层覆盖。
 *
 * 覆盖层里**全空的那些直接丢掉**（等价于没写）。读不到 / 结构不对 ⇒ 空结构，
 * **绝不抛异常**（配置文件写错不该让插件起不来）。
 *
 * @param {object} doc `parseToml` 的结果
 * @returns {{global: Record<string,string>, groups: Record<string,Record<string,string>>, privates: Record<string,Record<string,string>>, fromToml: boolean}}
 */
export function personaSectionsFromDocument(doc) {
  const section = doc?.personality;
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    return { global: emptyPersonaFields(), groups: {}, privates: {}, fromToml: false };
  }
  const collect = (raw, kind) => {
    const out = {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [key, value] of Object.entries(raw)) {
      const id = normalizeScopeId(key, kind);
      if (id === '') continue;
      const layer = compactPersonaLayer(value);
      // 全空的层不保留 —— 等价于没有覆盖。
      if (layer !== null) out[id] = layer;
    }
    return out;
  };
  return {
    global: normalizePersonaFields(section),
    groups: collect(section.groups, 'group'),
    privates: collect(section.privates, 'private'),
    fromToml: true,
  };
}

/**
 * 读 `qq-gugu.toml` 的人格段（全局 + 覆盖层）。
 *
 * @param {object} config 经 `resolveConfig` 的配置（只读 `tomlPath`）
 *   ⚠️ `tomlPath` **由 `resolveConfig()` 统一定**（2026-10-21）。本文件不硬编码部署
 *   路径（同 `owner.mjs`），所以空串 ⇒ 按"没有 toml"返回空结构。
 *   **别再让每个 loader 各自写一遍回退** —— 那正是本模块上线时读空的原因：
 *   它与 `loadOwnerConfig()` 只认 `config.tomlPath`，而 `apply()` 当时没填，
 *   于是 `/settings` 的 `effective.personality` 五段恒空、配置页每条都打红字。
 * @param {(level: string, message: string, meta?: object) => void} [log]
 * @param {{tomlPath?: string}} [options]
 * @returns {{global: Record<string,string>, groups: object, privates: object, fromToml: boolean}}
 */
export function loadPersonaSections(config, log = () => {}, options = {}) {
  const tomlPath = String(options.tomlPath ?? config?.tomlPath ?? '').trim();
  const empty = { global: emptyPersonaFields(), groups: {}, privates: {}, fromToml: false };
  if (tomlPath === '') return empty;
  try {
    return personaSectionsFromDocument(parseToml(fs.readFileSync(tomlPath, 'utf8')));
  } catch (error) {
    log('warn', '读 qq-gugu.toml 的人格段失败，按"没有覆盖"处理', {
      tomlPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }
}

/**
 * 会话键 → 覆盖层坐标。
 *
 * 优先用外部注入的 `scopeOf`（2026-10-24，P1-4：会话映射表解析器）——
 * 换成 `session-<uuid>` 之后，旧前缀正则认不出，只能靠映射表反查。
 * 没注入 / 解析不出来 ⇒ 回退旧前缀（与改动前逐字一致）。
 *
 * @param {unknown} sessionKey
 * @param {((sessionKey: unknown) => ({kind: string, id: string}|null))|null} [scopeOf]
 * @returns {{kind: 'group'|'private', id: string}|null}
 */
export function scopeFromSessionKey(sessionKey, scopeOf = null) {
  if (typeof scopeOf === 'function') {
    try {
      const scope = scopeOf(sessionKey);
      if (scope !== null && typeof scope === 'object'
        && (scope.kind === 'group' || scope.kind === 'private')
        && typeof scope.id === 'string' && scope.id !== '') {
        return { kind: scope.kind, id: scope.id };
      }
    } catch {
      /* 解析器出问题 ⇒ 回退旧前缀 */
    }
  }
  const text = String(sessionKey ?? '').trim();
  const group = /^qq-group-(\d+)$/.exec(text);
  if (group !== null) return { kind: 'group', id: group[1] };
  const priv = /^qq-private-(\d+)$/.exec(text);
  if (priv !== null) return { kind: 'private', id: priv[1] };
  return null;
}

/**
 * 取某个会话的覆盖层（已规范化、只含非空字段）；没有 ⇒ `null`。
 *
 * @param {{groups?: object, privates?: object}} sections
 * @param {unknown} sessionKey
 * @param {((sessionKey: unknown) => ({kind: string, id: string}|null))|null} [scopeOf]
 * @returns {{kind: 'group'|'private', id: string, fields: Record<string,string>}|null}
 */
export function personaLayerFor(sections, sessionKey, scopeOf = null) {
  const scope = scopeFromSessionKey(sessionKey, scopeOf);
  if (scope === null) return null;
  const bucket = scope.kind === 'group' ? sections?.groups : sections?.privates;
  const layer = bucket !== null && typeof bucket === 'object' ? bucket[scope.id] : undefined;
  if (layer === null || typeof layer !== 'object') return null;
  const compact = compactPersonaLayer(layer);
  if (compact === null) return null;
  return { kind: scope.kind, id: scope.id, fields: compact };
}

/**
 * 某个会话最终该用的人格五段 + 生效了哪些覆盖。
 *
 * 返回 `null` = **这一层没有覆盖**（调用方直接用全局人格，逐字节不变）。
 *
 * @param {{global?: object, groups?: object, privates?: object}} sections
 * @param {unknown} sessionKey
 * @param {((sessionKey: unknown) => ({kind: string, id: string}|null))|null} [scopeOf]
 * @returns {{fields: Record<string,string>, overridden: string[], kind: string, id: string}|null}
 */
export function personaForSession(sections, sessionKey, scopeOf = null) {
  const layer = personaLayerFor(sections, sessionKey, scopeOf);
  if (layer === null) return null;
  return {
    // 合并后的五段：覆盖层非空字段顶替全局，其余继承全局。
    fields: mergePersonaFields(sections?.global, layer.fields),
    overridden: overriddenPersonaKeys(layer.fields),
    kind: layer.kind,
    id: layer.id,
  };
}
