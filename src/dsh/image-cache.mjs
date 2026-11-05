/**
 * 图片**原件**在哪、**它是哪张图**（内容哈希）、以及**这张图的描述**（跨会话缓存表）。
 *
 * ## 为什么需要它
 *
 * 两个理由，都是 2026-10-07 用户拍板的：
 *
 * 1. **零网络拿到原件**：QQ 的图片 URL 要走 CDN（可能几 MB、几百毫秒），
 *    而**原件常常就在本机 QQ 的缓存目录里**。先在本地按名字找，找到就直接用。
 *    这条路还有一个副作用：本地原件能拿来做**内容哈希**（见下）。
 * 2. **描述是唯一能穿越长上下文的载体**（小鲸鱼实测）：图片会被 offload，描述不会。
 *    所以「同一张图第二次出现就别再花一次模型调用」这件事值得做一张**跨会话**的表 ——
 *    插件是常驻的，但重启/热重载会把内存缓存清空；表活在磁盘上。
 *
 * ## ⚠️ 路径必须按「**小鲸鱼自己的账号**」拼（用户特别警告过）
 *
 * 用户原话：
 * > 「虽然现在小鲸鱼在的地方我都在，但之后可不一定，很有可能**你看到的是我的账号保存的图片，
 * > 不是小鲸鱼账号保存的**，你要确认」
 *
 * 事实是：开发时我第一时间找到的原件在 `D:\QQNT\data\**30000001**\Image\Group2\…`
 * —— 那是**用户自己账号**（30000001）的缓存。它能用**只是因为用户当时也在同一个群里**
 * （他的客户端也收了一份）。小鲸鱼的账号是 **30000002**，缓存路径完全不同。
 *
 * 所以这里的规矩是死的：
 *
 * - **账号 id 从配置读**（`qq-proactive` 的 `botQQ`），**绝不硬编码**；
 * - **目录模板从配置读**（`imageOriginalDirs`）—— QQ 数据目录是**环境相关**的，
 *   别人装的时候在别处；
 * - 模板里只能用 `{qq}` 占位，**默认模板里绝不出现任何写死的号码**
 *   （`test/image-cache.test.mjs` 里有一条用例专门钉这个）；
 * - 找不到就**如实返回 null**，让调用方回退到"下载原件"—— **不偷偷去翻别人的账号目录**。
 *
 * ## 表是"缓存"，不是"真相"
 *
 * 读不到 / 坏了 / 格式变了 → **一律当成空表**，继续走"重新识图"。
 * 表绝不能变成单点故障（用户的硬要求）。
 *
 * @module qq-gugu/image-cache
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { MAX_IMAGE_BYTES, localPathFromSegment } from './media.mjs';
import { dshHome } from './paths.mjs';

/**
 * 描述缓存表的默认位置（用户拍板：放 `<DSH_HOME>\` 下）。
 *
 * 选 `media\` 子目录是因为插件已有的运行期产物都在那儿
 * （`qq-proactive-debug.json` / `qq-proactive-announce.json`），不另开新目录。
 */
export const DEFAULT_DESC_TABLE_PATH = path.join(dshHome(), 'media', 'qq-image-desc.json');

/**
 * 本地原件目录模板（默认值，**只含 `{qq}` 占位，不含任何写死的号码**）。
 *
 * | 模板 | 是什么 |
 * |---|---|
 * | `Pic\{yyyy-mm}\Ori` | NTQQ 收到的图片原件（按年月分目录） |
 * | `Emoji\emoji-recv\...` | **收到的表情包**（实测：QQ 把贴纸原件放这儿，不在 Pic 里） |
 *
 * `*` 表示"这一层按目录名展开"（只认 `YYYY-MM` 形状，最多取最近的
 * {@link MAX_MONTH_DIRS} 个）—— 这样跨月也不用改配置。
 *
 * ⚠️ **`Image\Group2`（旧版 QQ 的布局）刻意不在默认值里**：那是**用户账号**的路径形状。
 * 谁要加就自己往配置里写，**默认值不许猜**。
 *
 * @type {string[]}
 */
export const DEFAULT_ORIGINAL_DIRS = [
  'D:\QQNT\\data\\{qq}\\nt_qq\\nt_data\\Pic\\*\\Ori',
  'D:\QQNT\\data\\{qq}\\nt_qq\\nt_data\\Emoji\\emoji-recv',
  'D:\QQNT\\data\\{qq}\\nt_qq\\nt_data\\Emoji\\emoji-recv\\*\\Ori',
];

/** `*` 展开时最多试几个月份目录（按名字倒序，即从新到旧）。 */
export const MAX_MONTH_DIRS = 6;

/** 表的版本号。对不上就**当空表**（宁可重算，也不要误读旧格式）。 */
export const DESC_TABLE_VERSION = 1;

/** 表最多存多少条。超了按写入时间淘汰最旧的（描述是缓存，丢了会重算，不会错）。 */
export const DEFAULT_TABLE_MAX_ENTRIES = 2000;

/** 只有"年-月"形状的目录名才认（`Pic\` 下还有 `OriTemp` / `ThumbTemp` 这类目录）。 */
const MONTH_DIR = /^\d{4}-\d{2}$/;

/** 32 位十六进制 = QQ 给图片原件的文件名形状（就是内容的 md5）。 */
const HASH_NAME = /^[0-9a-f]{32}(\.[a-z0-9]+)?$/i;

/** GUID 形状的哈希（`{CBFBAC6B-E70B-2861-1B1B-CE19328D1AFB}.gif`）—— 去掉括号和横杠就是那个 md5。 */
const GUID_NAME = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?(\.[a-z0-9]+)?$/i;

/**
 * 展开一条目录模板。
 *
 * 占位符：`{qq}` = 机器人 QQ 号，`{yyyy}` / `{mm}` / `{yyyy-mm}` = 当前年月，
 * `*` = 这一层按"年-月"目录展开（从新到旧，最多 {@link MAX_MONTH_DIRS} 个）。
 *
 * `botQQ` 为空时**直接返回空数组**（模板里要 `{qq}` 却没账号 ⇒ 这条路走不通，
 * 调用方据此记一条日志；**不猜一个号码**）。
 *
 * @param {string} template
 * @param {object} options
 * @param {string} options.botQQ
 * @param {Date} [options.now]
 * @param {{readdirSync: Function}} [options.fsImpl]
 * @returns {string[]}
 */
export function expandOriginalDir(template, { botQQ, now = new Date(), fsImpl = nodeFs } = {}) {
  const tpl = String(template ?? '').trim();
  if (tpl === '') return [];
  const qq = String(botQQ ?? '').trim();
  if (tpl.includes('{qq}') && qq === '') return [];

  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const filled = tpl
    .replace(/\{qq\}/g, qq)
    .replace(/\{yyyy-mm\}/g, `${yyyy}-${mm}`)
    .replace(/\{yyyy\}/g, yyyy)
    .replace(/\{mm\}/g, mm);

  const parts = filled.split(/[\\/]+/).filter((s) => s !== '');
  const starAt = parts.indexOf('*');
  if (starAt < 0) return [filled];

  const parent = parts.slice(0, starAt).join('\\');
  let names = [];
  try {
    names = fsImpl.readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && MONTH_DIR.test(e.name))
      .map((e) => e.name);
  } catch {
    return []; // 目录不存在 = 这条路本来就走不通
  }
  names.sort().reverse();
  return names.slice(0, MAX_MONTH_DIRS).map((name) =>
    [...parts.slice(0, starAt), name, ...parts.slice(starAt + 1)].join('\\'));
}

/**
 * 段里可能出现的**文件名候选**（都要试，因为 QQ 同一张图有好几种写法）。
 *
 * 三种写法都实测见过（2026-10-07）：
 *
 * | 段里给的 | 盘上叫 | 差别 |
 * |---|---|---|
 * | `C54E377436E966E2392170AAE864AD52.png` | `c54e3774….png` | **大小写** |
 * | `{CBFBAC6B-E70B-2861-1B1B-CE19328D1AFB}.gif` | `cbfbac6be70b28611b1bce19328d1afb.gif` | **GUID 写法 → 裸 md5** |
 * | `https://multimedia.nt.qq.com.cn/download?…` | —— | URL，取不到名字（只能靠下载） |
 *
 * ⚠️ 大小写那条是**实打实**的：段里给的是大写 md5，盘上的文件名是**小写**，
 * 直接按名字查找会 100% 落空（第一版就踩了，见报告的本地查找一节）。
 *
 * @param {Record<string, unknown>} segment
 * @returns {string[]} 候选文件名（含原样、小写、去 GUID 三种）
 */
export function originalNameCandidates(segment) {
  const names = new Set();
  const add = (value) => {
    let text = String(value ?? '').trim().replace(/^.*[\\/]/, '');
    if (text === '') return;
    // URL 形状：取 pathname 的最后一段
    const q = text.indexOf('?');
    if (q >= 0) text = text.slice(0, q);
    if (text === '') return;
    names.add(text);
  };
  add(segment?.file);
  add(segment?.data?.file);
  const url = typeof segment?.url === 'string' ? segment.url : (typeof segment?.data?.url === 'string' ? segment.data.url : '');
  if (url !== '' && !/^[a-z]:[\\/]/i.test(url) && !url.startsWith('\\\\')) {
    try {
      add(new URL(url).pathname);
    } catch {
      add(url);
    }
  }

  for (const name of [...names]) {
    names.add(name.toLowerCase());
    const guid = GUID_NAME.exec(name);
    if (guid !== null) {
      const hex = `${guid[1]}${guid[2]}${guid[3]}${guid[4]}${guid[5]}`.toLowerCase();
      names.add(`${hex}${guid[6] ?? ''}`);
    }
  }
  return [...names];
}

/**
 * 段里的 `file` 是不是"**内容 md5 的文件名**"形状（32 位十六进制）。
 *
 * 用途：**表可以按这个名字查**（省掉一次网络请求）。但这条捷径有前提：
 * 只有当我们**亲手核对过**「这个名字 == 那份字节的 md5」之后，才会往表里写这个键
 * （见 {@link createDescTable} 与 `image-desc.mjs` 里的写入处）——
 * 名字对不上内容的实现（换个客户端/改版）不会污染缓存。
 *
 * @param {Record<string, unknown>} segment
 * @returns {string|null} 归一化后的 `md5.ext`（小写）；不是这个形状返回 null
 */
export function contentHashNameOf(segment) {
  for (const name of originalNameCandidates(segment)) {
    const lower = name.toLowerCase();
    if (HASH_NAME.test(lower)) return lower;
  }
  return null;
}

/**
 * 在配置的目录里按名字找原件。
 *
 * **零网络**：只 `readdir` + `readFileSync`。任何失败都只是"没找到"（返回 null），不抛。
 *
 * @param {object} options
 * @param {string[]} options.dirs 已经展开好的目录列表
 * @param {Record<string, unknown>} options.segment
 * @param {{readdirSync: Function, readFileSync: Function, statSync: Function}} [options.fsImpl]
 * @param {number} [options.maxBytes]
 * @returns {{data: Uint8Array, name: string, path: string}|null}
 */
export function findOriginalInDirs({ dirs, segment, fsImpl = nodeFs, maxBytes = MAX_IMAGE_BYTES }) {
  const candidates = originalNameCandidates(segment);
  if (candidates.length === 0) return null;
  const wanted = new Map(candidates.map((n) => [n.toLowerCase(), n]));

  for (const dir of Array.isArray(dirs) ? dirs : []) {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在/读不了 = 这条路不成立
    }
    for (const entry of entries) {
      if (entry.isDirectory() || !entry.isFile()) continue;
      if (!wanted.has(entry.name.toLowerCase())) continue;
      const full = path.join(dir, entry.name);
      let size = 0;
      try {
        size = fsImpl.statSync(full).size;
      } catch {
        continue;
      }
      if (size <= 0 || size > maxBytes) continue;
      try {
        const data = new Uint8Array(fsImpl.readFileSync(full));
        if (data.length === 0) continue;
        return { data, name: entry.name, path: full };
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * 造一个"段 → 原件字节"的查找器（本地优先）。
 *
 * 顺序（**都不成立才返回 null**）：
 *
 * 1. 段里直接给了**本地绝对路径**（`url` 或 `file` 是 `D:\…` / `\\…` / `file://…`）——
 *    实测真的有这种：NapCat 给某些段的就是本机路径（视频段见过，
 *    `url` = `D:\QQNT\data\…\Video\…\xxxx.mp4`）；
 * 2. 按名字在**配置的目录**里找（大小写不敏感 + GUID→md5 归一化）；
 *
 * ⚠️ 这里**不做网络**。网络那条路在调用方（`image-desc.mjs` 依次走
 * "本地找不到 → 下载"），这样"本地找不到"这件事能被记成一条日志
 * —— 那正是回答"小鲸鱼账号的 Pic 目录到底会不会落图"所需的证据。
 *
 * @param {object} options
 * @param {string[]} [options.dirs] 目录模板（未展开）
 * @param {string} [options.botQQ]
 * @param {Function} [options.log]
 * @param {object} [options.fsImpl]
 * @param {Date} [options.now]
 * @returns {{find: (segment: Record<string, unknown>) => {data: Uint8Array, name: string, path: string, via: string}|null,
 *            dirs: () => string[]}}
 */
export function createOriginalFinder({
  dirs = DEFAULT_ORIGINAL_DIRS,
  botQQ = '',
  log = () => {},
  fsImpl = nodeFs,
  now = () => new Date(),
} = {}) {
  const templates = (Array.isArray(dirs) ? dirs : []).map((d) => String(d ?? '')).filter((d) => d !== '');
  let warned = false;

  /** 展开后的目录（每次调用重算：`*` 会随月份变化，用户也可能热改配置）。 */
  const expanded = () => {
    const out = [];
    for (const tpl of templates) {
      for (const dir of expandOriginalDir(tpl, { botQQ, now: now(), fsImpl })) {
        if (!out.includes(dir)) out.push(dir);
      }
    }
    return out;
  };

  return {
    dirs: expanded,
    find(segment) {
      if (segment === null || typeof segment !== 'object') return null;

      // ① 段里自带本地路径
      const localPath = localPathFromSegment(segment);
      if (localPath !== null) {
        try {
          const stat = fsImpl.statSync(localPath);
          if (stat.isFile() && stat.size > 0 && stat.size <= MAX_IMAGE_BYTES) {
            const data = new Uint8Array(fsImpl.readFileSync(localPath));
            if (data.length > 0) {
              return { data, name: path.basename(localPath), path: localPath, via: 'segment-path' };
            }
          }
        } catch {
          /* 段里给的路径不存在（别的机器/已清理）→ 落到按名字找 */
        }
      }

      // ② 按名字在配置目录里找
      const found = findOriginalInDirs({ dirs: expanded(), segment, fsImpl });
      if (found !== null) return { ...found, via: 'local-name' };

      if (!warned && botQQ === '' && templates.some((t) => t.includes('{qq}'))) {
        warned = true;
        log('warn', '没有配 botQQ，按名字找本地图片原件这条路走不通（模板里有 {qq}）', {});
      }
      return null;
    },
  };
}

/**
 * 内容哈希（**原件**的 sha256）。
 *
 * 用户拍板「哈希算**原件**」：同一张图从哪来都一样（本地缓存件与 CDN 件字节相同 ——
 * QQ 的文件名就是内容 md5），而缩略图可能有损、绝不能当身份。
 *
 * @param {Uint8Array} bytes
 * @returns {string} 十六进制
 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/** 内容的 md5（十六进制）。用来核对"段里的文件名 == 这份字节"这件事。 */
export function md5Hex(bytes) {
  return createHash('md5').update(Buffer.from(bytes)).digest('hex');
}

/**
 * 跨会话的**描述缓存表**。
 *
 * 结构（磁盘上的 JSON）：
 *
 * ```json
 * { "version": 1, "updatedAt": "…",
 *   "entries": {
 *     "sha256:<hex>": { "text": "…", "source": "gif", "at": "…" },
 *     "name:<md5>.<ext>": { "text": "…", "source": "gif", "at": "…" }
 *   } }
 * ```
 *
 * 两种键：
 *
 * - `sha256:` —— **主键**，算的是原件字节。永远可信。
 * - `name:` —— QQ 段里给的那个文件名（就是内容 md5）。它让"同一张图第二次出现"
 *   **连下载都不用**（名字在事件里就有）。⚠️ 只有**核对过**「名字 == 内容 md5」才会写这个键
 *   （写入方负责核对，见 `image-desc.mjs`）—— 绝不能因为"名字看起来像哈希"就信它。
 *
 * ## 坏了怎么办
 *
 * **当成空表。** 读不到 / JSON 坏了 / 版本对不上 → `degraded = true` + 一条 warn，
 * 然后照常走"重新识图"。表只是缓存，**不是真相**；它不该有任何单点故障的可能。
 *
 * @param {object} options
 * @param {string} options.filePath
 * @param {Function} [options.log]
 * @param {object} [options.fsImpl]
 * @param {number} [options.maxEntries]
 * @param {() => number} [options.now]
 * @returns {{get: Function, set: Function, flush: Function, stats: Function, loaded: number}}
 */
export function createDescTable({
  filePath,
  log = () => {},
  fsImpl = nodeFs,
  maxEntries = DEFAULT_TABLE_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  const target = String(filePath ?? '').trim();
  /** @type {Map<string, {text: string, source: string, at: string, count: number}>} */
  const entries = new Map();
  const stats = { hits: 0, misses: 0, writes: 0, dropped: 0 };
  let degraded = false;
  let usable = target !== '';

  if (usable) {
    try {
      const raw = fsImpl.readFileSync(target, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && parsed.version === DESC_TABLE_VERSION
        && parsed.entries !== null && typeof parsed.entries === 'object') {
        for (const [key, value] of Object.entries(parsed.entries)) {
          const text = typeof value?.text === 'string' ? value.text.trim() : '';
          if (key === '' || text === '') continue;
          entries.set(key, {
            text,
            source: typeof value.source === 'string' ? value.source : '',
            at: typeof value.at === 'string' ? value.at : new Date(0).toISOString(),
            count: Number.isFinite(value.count) ? Number(value.count) : 1,
          });
        }
      } else {
        degraded = true;
      }
    } catch (error) {
      // 文件不存在是**正常情况**（第一次跑），不算坏
      const code = error !== null && typeof error === 'object' ? error.code : '';
      if (code === 'ENOENT') {
        degraded = false;
      } else {
        degraded = true;
        log('warn', '图片描述缓存表读不了，按空表继续（不影响识图，只是要重算）', {
          path: target,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } else {
    usable = false; // 没配路径 = 明确关掉这张表
  }

  /** 淘汰最旧的若干条（按写入时间）。 */
  function evict() {
    const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : DEFAULT_TABLE_MAX_ENTRIES;
    while (entries.size > limit) {
      let oldestKey = null;
      let oldestAt = null;
      for (const [key, value] of entries) {
        if (oldestAt === null || value.at < oldestAt) {
          oldestAt = value.at;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      entries.delete(oldestKey);
      stats.dropped += 1;
    }
  }

  function persist() {
    if (!usable) return false;
    try {
      evict();
      const payload = JSON.stringify({
        version: DESC_TABLE_VERSION,
        updatedAt: new Date(now()).toISOString(),
        entries: Object.fromEntries(entries),
      }, null, 0);
      // ⚠️ **直接写目标文件，不写临时文件再改名**：用户只授权了"<DSH_HOME> 下这一个新文件"，
      //    多一个 `.tmp` 就是多一个文件。代价是理论上可能写坏 —— 但表是缓存，
      //    写坏了下次启动按空表处理，不会造成错误结论（这也是"表不是真相"的一部分）。
      fsImpl.writeFileSync(target, payload, 'utf8');
      stats.writes += 1;
      return true;
    } catch (error) {
      log('warn', '图片描述缓存表写不进去（本轮照常，只是下次要重算）', {
        path: target,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  return {
    get(key) {
      const found = entries.get(String(key ?? ''));
      if (found === undefined) {
        stats.misses += 1;
        return null;
      }
      stats.hits += 1;
      found.count += 1;
      return { text: found.text, source: found.source };
    },
    /**
     * 存一条。
     *
     * 返回 `true` = **这一进程已经记住了**（本轮描述照样能命中）；
     * 落盘是**尽力而为**的：写不进去会记一条 warn，但内存里那条仍然有效
     * （表是缓存，丢一次写入最多让下次重算，不该影响这一轮回复）。
     * 真的落了盘才会让 `stats().writes` 加一。
     */
    set(key, value) {
      const k = String(key ?? '').trim();
      const text = typeof value?.text === 'string' ? value.text.trim() : '';
      if (!usable || k === '' || text === '') return false;
      entries.set(k, {
        text,
        source: typeof value?.source === 'string' ? value.source : '',
        at: new Date(now()).toISOString(),
        count: 1,
      });
      persist();
      return true;
    },
    flush: () => persist(),
    stats: () => ({ ...stats, size: entries.size, degraded, enabled: usable }),
    loaded: entries.size,
  };
}
