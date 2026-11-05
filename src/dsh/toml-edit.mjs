/**
 * **行级** TOML 改写与校验（2026-10-21）。
 *
 * ## 为什么是行级手术
 *
 * `qq-gugu.toml` 里有**人设原文**、注释、白名单、模型路由。把它解析成对象再
 * 序列化回去，等于整份重写一遍：顺序变、注释丢、引号风格变。
 * 本项目已经因为"配置静默失效"付过代价（见 AGENTS.md 的「同名 prompt section
 * 会被遮蔽」与「stale:false 只证明代码新」两节），所以写配置只允许**只改目标键**，
 * 其余字节原样保留。
 *
 * 本模块只做四件事：
 *
 * 1. {@link validateTomlText} —— 带**行号**的结构校验（`parseToml` 本身从不抛，
 *    所以"校验不过"必须由这里判定）；
 * 2. {@link rewriteTomlKey} —— 只替换（或插入）一个键；
 * 3. {@link validateTomlRewrite} —— 改完的全文用 `parseToml` 回读，确认
 *    "目标键 = 写入值" 且 "其它内容一字不差"；
 * 4. {@link backupToml} / {@link atomicWriteText} —— **备份落工作区**、
 *    写入走临时文件 + rename。
 *
 * ## ⚠️ 备份为什么不放在 toml 旁边
 *
 * `<DSH_HOME>` 那棵树对某些进程只读（历史踩过 EPERM），而备份是"出事时的退路"，
 * 退路本身写不进去就等于没有。所以默认备份到
 * `<工作区>\shared\tmp\qq-gugu.toml.bak-<epoch>`（可用 `QQ_WORKSPACE` 覆盖工作区）。
 *
 * @module qq-dsh/toml-edit
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseToml, splitTablePath, stripComment } from './toml.mjs';

/**
 * **危险键**：改动会影响"谁能跟机器人说话"或"钱花在哪条模型上"。
 * 这些键额外要求请求体带 `confirm: true`，否则拒绝写入。
 *
 * 名字按**键名**判（不是按 section）：`provider` / `model` 在 `[mood]` 里也是同一个语义。
 */
export const DANGER_KEYS = Object.freeze([
  'allowFrom',
  'groupAllowFrom',
  'provider',
  'model',
  'admins',
]);

/** 工作区默认位置（备份落这里，不落 `<DSH_HOME>`）。 */
export const DEFAULT_WORKSPACE = '<workspace>';

/**
 * 这个键是不是危险键。
 *
 * 容忍 catalog 里带 section 前缀的键（`mood.provider`）—— 判的是**最后一段**，
 * 因为真正写进文件的是那一段。
 *
 * @param {unknown} key
 * @returns {boolean}
 */
export function isDangerKey(key) {
  const text = String(key ?? '').trim();
  if (text === '') return false;
  if (DANGER_KEYS.includes(text)) return true;
  const tail = text.split('.').pop() ?? '';
  return DANGER_KEYS.includes(tail);
}

/** 默认备份目录：`<工作区>\shared\tmp`。 */
export function defaultBackupDir(env = process.env) {
  const workspace = String(env?.QQ_WORKSPACE ?? '').trim() || DEFAULT_WORKSPACE;
  return path.join(workspace, 'shared', 'tmp');
}

/** 文件用的是哪种换行（跟随原文件，别把 CRLF 文件混入 LF）。 */
export function detectEol(text) {
  return String(text ?? '').includes('\r\n') ? '\r\n' : '\n';
}

/** 把一个字符串渲染成 TOML 单行字符串（处理 `\` `"` 与换行/制表）。 */
export function quoteTomlString(value) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${text}"`;
}

/**
 * 按字段类型渲染成 TOML 值文本。
 *
 * 多行文本优先用 `"""…"""`（和现有 toml 的书写风格一致）；内容里本身含 `"""`
 * 时退回单行转义字符串 —— 否则会把文件写坏。
 *
 * @param {unknown} value
 * @param {'text'|'number'|'bool'|'enum'|'array'|'multiline'} [type]
 * @param {object} [options]
 * @param {string} [options.eol]
 * @returns {string} 可能含换行（多行文本）
 */
export function renderTomlValue(value, type = 'text', { eol = '\n' } = {}) {
  if (type === 'array') {
    const items = Array.isArray(value) ? value : [];
    return `[${items.map((item) => quoteTomlString(item)).join(', ')}]`;
  }
  if (type === 'bool') return value === true ? 'true' : 'false';
  if (type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`不是合法数字：${JSON.stringify(value)}`);
    return String(n);
  }
  const text = String(value ?? '').replace(/\r\n?/g, '\n');
  if (type === 'multiline' && text.includes('\n') && !text.includes('"""')) {
    return `"""${eol}${text}${eol}"""`;
  }
  return quoteTomlString(text);
}

/**
 * 带**行号**的结构校验。
 *
 * 只报**明确的损坏**（未闭合的多行字符串 / 未闭合的单行字符串 / 未闭合的数组 /
 * `[section` 少右括号 / `key` 不合法）。不认识但合法省略的写法不报错 ——
 * 校验的目的是"别把文件写坏"，不是实现一个完整 TOML 校验器。
 *
 * @param {string} text
 * @returns {{ok: true} | {ok: false, line: number, detail: string}}
 */
export function validateTomlText(text) {
  const eol = detectEol(text);
  const lines = String(text ?? '').split(eol);
  let multilineStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (multilineStart !== -1) {
      // 多行字符串内部：只找闭合，别的一概不当结构。
      if (raw.includes('"""')) multilineStart = -1;
      continue;
    }
    const stripped = stripComment(raw).trim();
    if (stripped === '') continue;

    // 段头
    if (stripped.startsWith('[')) {
      if (!stripped.endsWith(']')) {
        return { ok: false, line: lineNo, detail: '段头缺少右方括号' };
      }
      const inner = stripped.slice(1, -1).trim();
      if (inner === '' || splitTablePath(inner).length === 0) {
        return { ok: false, line: lineNo, detail: '段头是空的' };
      }
      continue;
    }

    // 键值对
    const eq = stripped.indexOf('=');
    if (eq === -1) {
      // 不是段头、也不是键值对 —— 我们的解析器会**静默忽略**这一行，
      // 那正是"配置写了却不生效"的典型形状，所以在这里明确报掉。
      return { ok: false, line: lineNo, detail: '无法解析的行（既不是段头也不是键值对）' };
    }
    const key = stripped.slice(0, eq).trim();
    if (key === '') return { ok: false, line: lineNo, detail: '缺少键名' };
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      return { ok: false, line: lineNo, detail: `键名不合法：${JSON.stringify(key)}` };
    }
    const valueText = stripped.slice(eq + 1).trim();
    if (valueText === '') return { ok: false, line: lineNo, detail: `键 ${key} 缺少值` };

    if (valueText.startsWith('"""')) {
      const rest = valueText.slice(3);
      if (!rest.includes('"""')) multilineStart = lineNo;
      continue;
    }
    if (valueText.startsWith('"')) {
      if (!isClosedString(valueText)) {
        return { ok: false, line: lineNo, detail: `键 ${key} 的字符串没有闭合` };
      }
      continue;
    }
    if (valueText.startsWith('[')) {
      if (!valueText.endsWith(']')) {
        return { ok: false, line: lineNo, detail: `键 ${key} 的数组没有闭合` };
      }
    }
  }
  if (multilineStart !== -1) {
    return { ok: false, line: multilineStart, detail: '多行字符串 """ 没有闭合' };
  }
  return { ok: true };
}

/** 单行字符串是否闭合（跳过 `\"` 转义）。 */
function isClosedString(valueText) {
  for (let i = 1; i < valueText.length; i += 1) {
    const c = valueText[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === '"') return true;
  }
  return false;
}

/** 段头 → 段路径；不是段头返回 null。 */
function parseHeaderLine(line) {
  const stripped = stripComment(line).trim();
  if (!stripped.startsWith('[') || !stripped.endsWith(']')) return null;
  return splitTablePath(stripped.slice(1, -1).trim());
}

function samePath(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((part, index) => part === b[index]);
}

/**
 * 扫一遍文件，得到段区间与键行（多行字符串内部不算结构行）。
 *
 * @param {string[]} lines
 * @returns {{sections: Array<{start: number, end: number, path: string[]}>, keyLines: Array<{line: number, path: string[]|null, key: string, valueText: string}>}}
 */
function analyze(lines) {
  const sections = [];
  const keyLines = [];
  let current = null;
  let multiline = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (multiline) {
      if (raw.includes('"""')) multiline = false;
      continue;
    }
    const stripped = stripComment(raw).trim();
    if (stripped === '') continue;
    if (stripped.startsWith('[')) {
      const header = parseHeaderLine(raw);
      if (header === null) continue;
      current = { start: i, end: lines.length, path: header };
      if (sections.length > 0) sections[sections.length - 1].end = i;
      sections.push(current);
      continue;
    }
    const eq = stripped.indexOf('=');
    if (eq === -1) continue;
    const valueText = stripped.slice(eq + 1).trim();
    keyLines.push({
      line: i,
      path: current === null ? null : current.path,
      key: stripped.slice(0, eq).trim(),
      valueText,
    });
    if (valueText.startsWith('"""')) {
      const rest = valueText.slice(3);
      if (!rest.includes('"""')) multiline = true;
    }
  }
  return { sections, keyLines };
}

/** 段头文本：数字/特殊字符段加引号（`[personality.groups."30000013"]`）。 */
export function renderTomlHeader(sectionPath) {
  const parts = (Array.isArray(sectionPath) ? sectionPath : []).map((part) => {
    const text = String(part ?? '');
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(text)) return text;
    return quoteTomlString(text);
  });
  return `[${parts.join('.')}]`;
}

/**
 * 只改一个键：能找到就替换那一行（含多行值），找不到就插进该段，段也没有就追加。
 *
 * @param {string} text 原全文
 * @param {object} options
 * @param {string[]} options.sectionPath 目标段路径
 * @param {string} options.key 键名
 * @param {unknown} options.value 值
 * @param {string} [options.type] 见 {@link renderTomlValue}
 * @returns {string} 新全文
 */
export function rewriteTomlKey(text, { sectionPath, key, value, type = 'text' } = {}) {
  const src = String(text ?? '');
  const eol = detectEol(src);
  const lines = src.split(eol);
  const { sections, keyLines } = analyze(lines);
  const rendered = renderTomlValue(value, type, { eol });
  const path_ = Array.isArray(sectionPath) ? sectionPath : [];

  const section = sections.find((item) => samePath(item.path, path_));
  if (section !== undefined) {
    const hit = keyLines.find((item) => item.path !== null && samePath(item.path, path_) && item.key === key);
    if (hit !== undefined) {
      // 找这个值的结束行：多行字符串会跨行，必须一起换掉。
      let end = hit.line;
      if (hit.valueText.startsWith('"""') && !hit.valueText.slice(3).includes('"""')) {
        end += 1;
        while (end < lines.length && !lines[end].includes('"""')) end += 1;
      }
      const indent = /^[ \t]*/.exec(lines[hit.line])?.[0] ?? '';
      const comment = end === hit.line ? trailingComment(lines[hit.line]) : '';
      const replacement = `${indent}${key} = ${rendered}${comment}`.split(eol);
      return [...lines.slice(0, hit.line), ...replacement, ...lines.slice(end + 1)].join(eol);
    }
    // 段在、键不在：插到该段最后一行内容之后。
    let insertAt = section.start + 1;
    for (let i = section.end - 1; i > section.start; i -= 1) {
      if (lines[i].trim() !== '') {
        insertAt = i + 1;
        break;
      }
    }
    const prefix = /^[ \t]*/.exec(lines[section.start])?.[0] ?? '';
    const newLine = `${prefix}${key} = ${rendered}`;
    const needsBlank = insertAt < section.end && lines[insertAt] !== undefined && lines[insertAt].trim() !== '';
    return [
      ...lines.slice(0, insertAt),
      ...newLine.split(eol),
      ...(needsBlank ? [''] : []),
      ...lines.slice(insertAt),
    ].join(eol);
  }

  // 段不存在：追加到文件末尾（前面保证一个空行）。
  const header = renderTomlHeader(path_);
  const block = [header, `${key} = ${rendered}`].join(eol);
  if (src === '') return `${block}${eol}`;
  const tail = src.endsWith(eol) ? (src.endsWith(eol + eol) ? '' : eol) : `${eol}${eol}`;
  return `${src}${tail}${block}${eol}`;
}

/** 取行尾注释（`#` 之后，字符串内的不算）；没有则空串。 */
function trailingComment(line) {
  const without = stripComment(line);
  if (without.length === line.length) return '';
  return line.slice(without.length); // 已包含 `#` 与其前导空白
}

/**
 * 删掉一个键（覆盖层"清空某字段"走这里）。
 *
 * 该段删空之后**连段头一起删掉** —— 空 section 等价于没有覆盖，
 * 留着它只会让文件里堆一层没有任何作用的东西。
 *
 * @param {string} text
 * @param {{sectionPath: string[], key: string}} options
 * @returns {{text: string, removed: boolean}}
 */
export function removeTomlKey(text, { sectionPath, key } = {}) {
  const src = String(text ?? '');
  const eol = detectEol(src);
  const lines = src.split(eol);
  const path_ = Array.isArray(sectionPath) ? sectionPath : [];
  const first = analyze(lines);
  const hit = first.keyLines.find(
    (item) => item.path !== null && samePath(item.path, path_) && item.key === key,
  );
  if (hit === undefined) return { text: src, removed: false };

  let end = hit.line;
  if (hit.valueText.startsWith('"""') && !hit.valueText.slice(3).includes('"""')) {
    end += 1;
    while (end < lines.length && !lines[end].includes('"""')) end += 1;
  }
  const cut = [...lines.slice(0, hit.line), ...lines.slice(end + 1)];
  const after = analyze(cut);
  const stillHasKeys = after.keyLines.some(
    (item) => item.path !== null && samePath(item.path, path_),
  );
  if (stillHasKeys) return { text: cut.join(eol), removed: true };

  const section = after.sections.find((item) => samePath(item.path, path_));
  if (section === undefined) return { text: cut.join(eol), removed: true };
  let removeEnd = section.start + 1;
  while (removeEnd < cut.length && cut[removeEnd].trim() === '') removeEnd += 1;
  const head = cut.slice(0, section.start);
  while (head.length > 0 && head[head.length - 1].trim() === '') head.pop();
  const tail = cut.slice(removeEnd);
  if (tail.length === 0) return { text: head.length === 0 ? '' : `${head.join(eol)}${eol}`, removed: true };
  const body = head.length === 0 ? tail : [...head, '', ...tail];
  return { text: body.join(eol), removed: true };
}

/** 从解析结果里读 `段路径 + 键`。 */
export function readTomlKey(doc, sectionPath, key) {
  let node = doc;
  for (const part of sectionPath ?? []) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  if (node === null || typeof node !== 'object') return undefined;
  return node[key];
}

/** 在解析结果里写 `段路径 + 键`（只用于"改完应该长什么样"的对照）。 */
export function writeTomlKey(doc, sectionPath, key, value) {
  let node = doc;
  for (const part of sectionPath ?? []) {
    if (node[part] === null || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {};
    node = node[part];
  }
  node[key] = value;
  return doc;
}

/**
 * 改完之后的**双重校验**。
 *
 * 1. 结构校验（带行号）—— 写坏了就别写；
 * 2. `parseToml` 回读：目标键 == 期望值，且把原文档的该键替换成期望值之后，
 *    **整份文档与改后的解析结果完全一致**（= 除目标键之外没有别的语义变化）。
 *
 * @param {string} beforeText
 * @param {string} afterText
 * @param {{sectionPath: string[], key: string, expected: unknown}} options
 * @returns {{ok: true} | {ok: false, line?: number, detail: string}}
 */
export function validateTomlRewrite(beforeText, afterText, { sectionPath, key, expected }) {
  const structural = validateTomlText(afterText);
  if (structural.ok === false) {
    return { ok: false, line: structural.line, detail: structural.detail };
  }
  let before;
  let after;
  try {
    before = parseToml(beforeText);
    after = parseToml(afterText);
  } catch (error) {
    return { ok: false, detail: `改后的 toml 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const written = readTomlKey(after, sectionPath, key);
  if (JSON.stringify(written) !== JSON.stringify(expected)) {
    return {
      ok: false,
      detail: `改后的 ${[...sectionPath, key].join('.')} 读回来是 ${JSON.stringify(written)}，不是 ${JSON.stringify(expected)}`,
    };
  }
  const shadow = JSON.parse(JSON.stringify(before));
  writeTomlKey(shadow, sectionPath, key, expected);
  // 新段/新键在对象里的位置可能与磁盘顺序不同，所以按"键排序后的形状"比。
  if (stableStringify(shadow) !== stableStringify(after)) {
    return { ok: false, detail: '除目标键之外还有内容被改动了（写入被拒绝）' };
  }
  return { ok: true };
}

/**
 * 删掉一个键之后的校验：目标键读不回来，其余语义不变。
 *
 * @param {string} beforeText
 * @param {string} afterText
 * @param {{sectionPath: string[], key: string}} options
 * @returns {{ok: true} | {ok: false, line?: number, detail: string}}
 */
export function validateTomlKeyRemoved(beforeText, afterText, { sectionPath, key }) {
  const structural = validateTomlText(afterText);
  if (structural.ok === false) {
    return { ok: false, line: structural.line, detail: structural.detail };
  }
  let before;
  let after;
  try {
    before = parseToml(beforeText);
    after = parseToml(afterText);
  } catch (error) {
    return { ok: false, detail: `改后的 toml 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (readTomlKey(after, sectionPath, key) !== undefined) {
    return { ok: false, detail: `改后的 ${[...sectionPath, key].join('.')} 仍然存在` };
  }
  const shadow = JSON.parse(JSON.stringify(before));
  pruneTomlKey(shadow, sectionPath, key);
  if (stableStringify(shadow) !== stableStringify(after)) {
    return { ok: false, detail: '除目标键之外还有内容被改动了（写入被拒绝）' };
  }
  return { ok: true };
}

/** 在解析结果里删键，并清掉因此变空的祖先段。 */
function pruneTomlKey(doc, sectionPath, key) {
  const path_ = Array.isArray(sectionPath) ? sectionPath : [];
  const chain = [doc];
  let node = doc;
  for (const part of path_) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return;
    node = node[part];
    chain.push(node);
  }
  if (node === null || typeof node !== 'object') return;
  delete node[key];
  // 从最深的一层往上，删掉"空了"的对象。
  for (let i = chain.length - 1; i > 0; i -= 1) {
    const current = chain[i];
    if (current === null || typeof current !== 'object') break;
    if (Object.keys(current).length > 0) break;
    delete chain[i - 1][path_[i - 1]];
  }
}

/** 递归按键名排序后的 JSON —— 只用来比较两份文档的**语义**是否相同。 */function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 备份整份 toml 到**工作区**。
 *
 * @param {string} tomlPath
 * @param {object} [options]
 * @param {string} [options.backupDir] 默认 {@link defaultBackupDir}
 * @param {object} [options.fsImpl]
 * @param {() => number} [options.now] 时钟（测试用）
 * @param {string} [options.name] 备份文件名前缀（默认 `qq-gugu.toml`）
 * @returns {string} 备份文件路径
 */
export function backupToml(tomlPath, {
  backupDir = defaultBackupDir(),
  fsImpl = null,
  now = () => Date.now(),
  name = 'qq-gugu.toml',
} = {}) {
  const f = fsImpl ?? fs;
  const dir = String(backupDir ?? '');
  if (dir === '') throw new Error('备份目录为空');
  const epoch = now();
  let target = path.join(dir, `${name}.bak-${epoch}`);
  let suffix = 1;
  while (f.existsSync(target)) {
    target = path.join(dir, `${name}.bak-${epoch}-${suffix}`);
    suffix += 1;
  }
  f.mkdirSync(dir, { recursive: true });
  f.copyFileSync(tomlPath, target);
  return target;
}

/**
 * 原子写：临时文件 + `rename`（同目录，避免读到半截文件）。
 *
 * @param {string} file
 * @param {string} text
 * @param {{fsImpl?: object}} [options]
 */
export function atomicWriteText(file, text, { fsImpl = null } = {}) {
  const f = fsImpl ?? fs;
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    f.writeFileSync(tmp, text, 'utf8');
    f.renameSync(tmp, file);
  } catch (error) {
    try {
      f.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件留着也无害 */
    }
    throw error;
  }
}
