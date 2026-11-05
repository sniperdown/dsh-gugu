/**
 * 极简 TOML 解析器（够用版）。
 *
 * 为什么自己写而不是装库：`qq-gugu.toml` 的结构很简单（`[section]` + `key = value`），
 * 没必要为一个配置文件拉进 smol-toml 这类依赖（往 DSH 运行时塞东西正是之前被点过
 * 的坏习惯）。这里只支持我们真正用到的子集：
 *
 *   - `[section]` 段
 *   - **`[a.b."c"]` 点分嵌套段**（引号内的点不当分隔符）—— 用于
 *     `[proactive.groups."200000002"]` 这种"按会话覆盖"的写法
 *   - `key = "字符串"`（带转义 \n \t \" \\）
 *   - `key = 数字 / true / false`
 *   - `key = ["a", "b"]` 数组
 *   - `# 注释`（整行 + 行尾，字符串内的 # 不当作注释）
 *   - `"""..."""` 多行字符串（用于长人设文本，方便阅读）
 *
 * @module qq-gugu/toml
 */

/**
 * 把 `[a.b."c"]` 拆成 `['a','b','c']`。
 *
 * ⚠️ 必须处理引号：`"200000002"` 里的内容要**去掉引号**，
 * 而且引号内的 `.` 不能当分隔符 —— 否则以后有人写
 * `[proactive.groups."a.b"]` 会被拆错。
 */
export function splitTablePath(name) {
  const parts = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === '"') { inQuote = !inQuote; continue; }
    if (c === '.' && !inQuote) {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  parts.push(buf.trim());
  return parts.filter((p) => p !== '');
}

/** 去掉一行里的注释（字符串内的 # 不算）。 */
export function stripComment(line) {
  let inSingle = false;
  let inTriple = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (!inTriple && c === '"' && line[i + 1] === '"' && line[i + 2] === '"') {
      inTriple = !inTriple;
      i += 2;
      continue;
    }
    if (!inTriple && c === '"') {
      inSingle = !inSingle;
      continue;
    }
    if (c === '#' && !inSingle && !inTriple) return line.slice(0, i);
  }
  return line;
}

/** 解析一个值（字符串/数字/布尔/数组）。 */
function parseValue(s) {
  if (s.startsWith('"')) {
    let out = '';
    let i = 1;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1];
        if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === '"') out += '"';
        else if (n === '\\') out += '\\';
        else out += n;
        i += 2;
      } else if (c === '"') {
        break;
      } else {
        out += c;
        i += 1;
      }
    }
    return out;
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((x) => parseValue(x.trim()));
  }
  return s;
}

/**
 * 解析 TOML 文本，返回嵌套对象。
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseToml(text) {
  const result = {};
  let current = result;
  const rawLines = String(text ?? '').split('\n');

  let i = 0;
  while (i < rawLines.length) {
    let line = stripComment(rawLines[i]).trim();

    // 多行字符串 """...""" 开头
    if (line.includes('"""')) {
      const eq = line.indexOf('=');
      if (eq !== -1) {
        const key = line.slice(0, eq).trim();
        const after = line.slice(eq + 1).trim();
        const bodyStart = after.indexOf('"""');
        if (bodyStart !== -1) {
          let body = after.slice(bodyStart + 3);
          // 收集直到下一个 """
          while (i < rawLines.length && !body.includes('"""')) {
            i += 1;
            if (i < rawLines.length) body += '\n' + rawLines[i];
          }
          const end = body.indexOf('"""');
          if (end !== -1) body = body.slice(0, end);
          // TOML 规范：`"""` 之后的第一个换行不计入内容。
          if (body.startsWith('\n')) body = body.slice(1);
          current[key] = body.replace(/\n$/, '');
          i += 1;
          continue;
        }
      }
    }

    if (line === '') {
      i += 1;
      continue;
    }

    // [section] 或 [a.b."c"] 点分嵌套
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim();
      const parts = splitTablePath(name);
      if (parts.length === 0) { i += 1; continue; }
      // 逐段深入；中间缺失就建。遇到已有但**不是对象**的键（比如
      // 先写了 `proactive = 5` 再来 `[proactive.x]`）就覆盖掉 ——
      // 冲突时以后出现的段为准，比抛异常好排查。
      let node = result;
      for (const part of parts) {
        const cur = node[part];
        if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) node[part] = {};
        node = node[part];
      }
      current = node;
      i += 1;
      continue;
    }

    // key = value
    const eq = line.indexOf('=');
    if (eq !== -1) {
      const key = line.slice(0, eq).trim();
      const valueStr = line.slice(eq + 1).trim();
      if (key !== '') current[key] = parseValue(valueStr);
    }
    i += 1;
  }

  return result;
}
