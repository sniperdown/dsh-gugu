/**
 * 入站媒体：把 QQ 消息里的图片变成 DSH 能喂给模型的 image block。
 *
 * ## 为什么需要它
 *
 * 在这之前，`protocol.mjs` 把图片压成 `[图片]` 三个字 —— 小鲸鱼只知道"有张图"，
 * 看不见内容。用户的原话：「小鲸鱼的识图…应该开放了，目前只能看到*有*一张图片」。
 *
 * 设计文档里其实早写明了要走这条路（`docs/architecture-v2.md`）：
 * 不照搬 MaiBot 那种"先用另一个视觉模型生成一段描述"的做法（信息损失大），
 * 而是把**原图**直接交给 `deepseek-flash`（它本身就是 text+image 多模态）。
 *
 * ## 三个必须处理的坑
 *
 * 1. **CQ 反转义**：NapCat 会把 URL 里的 `&` 转成 `&amp;`，不反转义直接下载会
 *    403（`docs/onebot-layer.md` 记着这个真实事故）。→ 统一走 `cqUnescape`。
 * 2. **格式靠字节判断，不靠扩展名**：QQ 的图片 URL 经常没有后缀，或者后缀是
 *    `?term=xxx` 这种。只看 magic bytes 才可靠。
 * 3. **失败必须降级**：图下不下来、格式不认识、DSH 拒收 —— 任何一种都只跳过这张图，
 *    **不能让整条消息跟着丢**。文字部分照常进上下文，占位符也照常留着。
 *
 * ## 长图先切再入库（2026-10-22，用户要求）
 *
 * 用户从 QQ 发了一张 **960×10793** 的长图，小鲸鱼**根本收不到**：DSH 附件服务对源图有
 * "每边 ≤ `maxImageDimension`"（默认 8192）的硬上限，超了**不缩放、直接拒收**
 * （`IMAGE_DIMENSION_TOO_LARGE`）。这条路以前把那个异常吞成一条 `debug` 日志，
 * 表现就是"发了图、它好像没看见"。
 *
 * ⇒ 现在在**调 `attachments.saveImage()` 之前**先看一眼真实像素尺寸：
 * 任一边超限 ⇒ 按长边切成 N 段（重叠 10%，JPG 质量 92，见 `image-split.mjs`），
 * **所有切片**都存成附件当 image block 投出去，并附一句说明（`notes`）让模型
 * 知道"这是同一张图的 1/2、2/2，拼起来看"。
 *
 * **为什么做在这一层**（而不是 QQ 入站事件那一层）：这里是**所有**入站图片的唯一汇合点 ——
 * 用户直接发的图、合并转发里的图、主会话用 `viewImages` 塞进来的本机路径，
 * 全都经过 `toImageBlocks` 才变成 image block。做在更上游就得写第二套（小鲸鱼明确要求过
 * 别写第二套），做在更下游（`saveImage` 之后）就来不及了 —— 拒收发生在 `saveImage` 里。
 *
 * ⚠️ **切图失败一定退回原图**：宁可让它按老样子撞上限（然后只丢这一张图），
 * 也不能因为切图这一步出岔子把整条消息弄丢。
 *
 * ## file 段里装着的图片（2026-10-22，用户在真机发现）
 *
 * QQ 有时**不把一张图当图片段发**，而是当**文件**发（实测：960×10793 的长图走了 file 段）。
 * 那时 protocol.mjs 只把它压成 [文件]，这一层又只收 type === 'image' —— 那张图
 * **连处理链都没进**（连"边长 8192 先切"都轮不到它）。
 *
 * ⇒ 入站投递前先问一句 isImageFileSegment（看文件名/URL 的扩展名，**判不准就当文件**）：
 * 是图片就并进 image 段那条**完全相同**的链路（下载 → 读图头 → 超限先切 → image block）；
 * 不是图片就保持 [文件] 占位不动。
 * 下载失败 / 字节认不出 / 入库被拒 ⇒ 退回 [文件] + warn，**不丢消息、不抛**。

 *
 * ## 只有 file_id、没有 url 时（2026-10-22 第二次真机）
 *
 * 判据命中了、链路也进了，但**取不到字节** —— NapCat 的 file 段常常只给 `file`（名字 / id），
 * 不给可下载的 `url`。⇒ `fetchImageBytes` 现在在下载失败后会**问服务器要**
 * （OneBot `get_file`，见 `bytesViaGetFile`）：`url` / `base64` / 服务器本地路径三种返回都认；
 * 仍拿不到就照旧退回 [文件] + warn。
 * 另：每个 file 段都会留一行 **debug 摘要**（键名 + 标量，**base64 绝不进日志**）。
 *
 * @module qq-gugu/media
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cqUnescape } from '../onebot/protocol.mjs';
import { imageInfo } from './screen-capture.mjs';
import {
  DEFAULT_OVERLAP,
  MAX_IMAGE_DIMENSION,
  buildSplitNote,
  planSplits,
  splitImageBytes,
} from './image-split.mjs';

/** 单张图的下载上限。QQ 的图通常几百 KB，20MB 已经远超正常范围。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 一条消息最多取几张图。防止有人刷 20 张把上下文撑爆、把钱烧掉。 */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** 下载超时。慢就跳过，别让一条消息卡住整轮。 */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * **哪些源格式要在文本层标出来**（`[图片: 源 gif | …]`）。
 *
 * ⚠️ **只标"容器格式"，绝不标"它在动"** —— 用户 2026-10-07 明确要求：
 * 「只能标『源 gif』，绝不能标『这是动图』」。理由很实在：小鲸鱼实测过，
 * 它手上那个 `img1.gif` 是 `GIF89a` 但**只有 1 帧** —— 扩展名/容器格式都**不保证**它是动图，
 * 标错就是换一种方式编。
 *
 * 只收录**可能藏住动态**的两种容器（gif / webp）；jpeg/png 标出来是纯噪音
 * （静态格式没有"你只看到一帧"这个问题），所以不标。
 */
const SOURCE_LABELS = new Map([
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

/**
 * MIME → 文本层要标的**源格式**（`''` = 不标）。
 * @param {string} mediaType
 * @returns {string}
 */
export function sourceFormatOf(mediaType) {
  return SOURCE_LABELS.get(String(mediaType ?? '')) ?? '';
}


/**
 * 从 magic bytes 判断图片类型。
 *
 * **不看扩展名**：QQ 图片 URL 常常没有后缀，或后缀后面跟着查询串。
 *
 * @param {Uint8Array} bytes
 * @returns {string|null} MIME 类型；认不出返回 null
 */
export function sniffImageMediaType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const b = bytes;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // GIF: 47 49 46 38 ("GIF8")
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  // WEBP: 52 49 46 46 ... 57 45 42 50 ("RIFF"...."WEBP")
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** 「file 段里装着的其实是一张图」认得的扩展名（小写、不含点）。 */
export const IMAGE_FILE_EXTENSIONS = Object.freeze(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

const IMAGE_FILE_EXTENSION_SET = new Set(IMAGE_FILE_EXTENSIONS);

/**
 * 从"像路径的一个字符串"里取小写扩展名（不含点）；取不到返回空串。
 *
 * 要应付三种真实形状：
 *   - a.JPG                            → jpg（大小写不敏感）
 *   - https://x/a.png?term=2&spec=abc  → png（**先去查询串/片段**，否则扩展名会带上 ?term=2）
 *   - file:///D:/QQNT/a.jpeg           → jpeg
 *
 * ⚠️ base64://… / data:… 这种内联载荷**没有文件名可言** ⇒ 返回空串（判不准 ⇒ 当文件）。
 *
 * @param {unknown} value
 * @returns {string}
 */
function extensionOfPathLike(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (text === '') return '';
  // 内联载荷：别从 base64 里瞎猜扩展名。
  if (/^(?:base64|data):/i.test(text)) return '';
  const cut = text.search(/[?#]/);
  if (cut !== -1) text = text.slice(0, cut);
  const base = text.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

/**
 * 「这个 file 段里装着的是一张图吗」——**只看文件名 / URL 的扩展名**。
 *
 * ## 为什么需要它（2026-10-22，用户在真机发现）
 *
 * QQ 有时**不把图当图片段发**，而是当**文件**发（实测：960×10793 的长图走了 file 段）。
 * 那时 protocol.mjs 只把它压成 [文件]，而 collectImageSegments 又只收 image 段
 * ⇒ **那张图连处理链都没进**（连"边长 8192 先切"都轮不到它）。
 *
 * ## 判据与保守性
 *
 * 依据只有两条：**file 段自己的文件名扩展名**，或 **NapCat 给那个 url 的扩展名**
 * （jpg / jpeg / png / webp / gif / bmp，见 {@link IMAGE_FILE_EXTENSIONS}）。
 * **判不准就当文件** —— 宁可漏掉一张真图（退回 [文件]，和改之前一样），
 * 也不要把 .zip / .mp4 当图片去下载、解码、塞给模型。
 *
 * ⚠️ 扩展名只回答"**要不要试一下**"；是不是真图最终仍然看字节
 * （sniffImageMediaType），字节认不出就退回 [文件]。
 *
 * @param {Record<string, unknown>} segment
 * @returns {boolean}
 */
export function isImageFileSegment(segment) {
  if (segment === null || typeof segment !== 'object' || segment.type !== 'file') return false;
  // 顺序按"最像人看到的那个名字"来：file/name 通常是真文件名，url 是下载链接（末尾一般也带名字）。
  // 顶层优先、缺了再看 data（与 toSegments 的摊平规则一致）。
  const candidates = [
    segment.file,
    segment.data?.file,
    segment.name,
    segment.data?.name,
    segment.url,
    segment.data?.url,
  ];
  for (const value of candidates) {
    const ext = extensionOfPathLike(value);
    if (ext !== '' && IMAGE_FILE_EXTENSION_SET.has(ext)) return true;
  }
  return false;
}

/**
 * 「这个值能不能拿去问服务器要文件」—— 即**像不像一个 file_id**。
 *
 * ## 为什么需要它（2026-10-22 第二次真机：`[文件: 5DF3…jpg]` 图仍然看不到）
 *
 * OneBot 11 的 `file` 段常见形状是**只给 `file`（一个 id / 文件名）**，不给可下载的
 * `url`；要拿内容必须再问一次服务器：
 *
 * ```text
 * POST get_file { file_id: <那个 id> }
 *   → { file: "<服务器上的路径>", url: "<可下载地址>", file_size: … , base64?: "…" }
 * ```
 *
 * ⇒ 少了这一步，`fetchImageBytes` 找不到 http 地址就直接返回 null，
 *    表现就是"file 段判成了图片，却永远取不到字节 ⇒ 退回 [文件]"。
 *
 * ## 判据：**排除"段里已经能自己拿到内容"的形状**，其余都算
 *
 * 不算 id 的只有两类：**内联载荷**（`base64://` / `data:`）和**带协议的地址**（`http(s)://` …）——
 * 那两个上面几步已经试过了。剩下的（名字、NapCat 容器内路径、甚至本机路径）都**算**：
 *
 * - NapCat 的 `file` 里装的往往是**文件名**（`5DF3…jpg`，带扩展名）；
 * - 也可能是**服务器上的路径**（`/app/.config/QQ/…` 或 `D:\QQNT\…`）——
 *   `get_file` 两种都认（社区实现 `dsh-onebot-qq` 就是 `fileId ?? file` 直接丢进去的，
 *   见 `vendor/package/lib/inbound.js`）。
 *
 * 判错的最坏结果只是**多一次 action 调用、然后失败**（`bytesViaGetFile` 吞掉它 ⇒ 降级），
 * 不会误读、也不会碰别的段 —— 所以这里刻意**保守在"别把 URL / 内联载荷当 id"**，
 * 而不是保守在"少试一次"。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFileIdShaped(value) {
  if (typeof value !== 'string') return false;
  const text = cqUnescape(value).trim();
  if (text === '') return false;
  if (/^(?:base64|data):/i.test(text)) return false;       // 内联载荷：字节就在手里
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false; // http(s):// / file:// …
  if (/\s/.test(text)) return false;                        // 带空白 ⇒ 不是单个标识
  return true;
}

/**
 * 从 file 段里取"能拿去问服务器"的 file_id。
 *
 * 顺序：**显式 `file_id` 字段优先**（OneBot / NapCat 把真 id 放这儿，**不做形状检查** ——
 * 它可能就是个 `/xxx` 容器路径），没有才退回 `file`（NapCat 常给文件名），
 * 且 `file` 必须先过 {@link isFileIdShaped}（它也可能就是 `http://…` / `base64://…`）。
 *
 * @param {Record<string, unknown>} [segment]
 * @returns {string} 取不到返回空串
 */
export function fileIdFromSegment(segment) {
  if (segment === null || typeof segment !== 'object') return '';
  for (const value of [segment.file_id, segment.data?.file_id]) {
    if (typeof value === 'string' && value.trim() !== '') return cqUnescape(value).trim();
  }
  for (const value of [segment.file, segment.data?.file]) {
    if (isFileIdShaped(value)) return cqUnescape(value).trim();
  }
  return '';
}

/** 日志里单个标量最多留几个字符（再长就截断，**绝不整段打出去**）。 */
const LOG_VALUE_MAX = 40;

/**
 * 把一个值压成**能进日志**的一小段：标量留短摘要，大字符串 / base64 只留长度。
 *
 * ⚠️ 硬要求：**base64 内容绝不能进日志**（它可能有几十 MB，日志写入磁盘会被撑爆，
 * 也等于把图片内容抄了一遍）。所以两条闸门：
 *   - 键名像 `base64` / 值带 `base64://` `data:` 前缀 ⇒ 只打 `<内联载荷 N 字符，不入日志>`
 *   - 任何超长字符串 ⇒ 只打**前 12 个字符 + 总长度**
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
function loggableScalar(key, value) {
  if (value === null || value === undefined) return null;
  const kind = typeof value;
  if (kind === 'number' || kind === 'boolean') return value;
  if (kind === 'string') {
    if (/base64|binary/i.test(key) || /^(?:base64|data):/i.test(value)) {
      return `<内联载荷 ${value.length} 字符，不入日志>`;
    }
    if (value.length > LOG_VALUE_MAX) return `${value.slice(0, 12)}…(${value.length} 字符)`;
    return value;
  }
  if (Array.isArray(value)) return `[数组 ${value.length} 项]`;
  if (kind === 'object') return `{对象 ${Object.keys(value).length} 个键}`;
  return `<${kind}>`;
}

/**
 * file 段的**日志摘要**：键名 + 每个标量的短摘要（见 {@link loggableScalar}）。
 *
 * 为什么要有它：用户看到的只有 `[文件: 5DF3…jpg]`，而排查需要的是
 * **NapCat 到底给了哪些字段** —— 有没有 `url`、`file_id` 是哪个、`file_size` 多大，
 * 这些直接决定该走哪条取字节的路。
 *
 * 打 **debug**：每条带文件的消息都会路过，warn 会刷屏（用户要的是"别刷屏、下次能查"）。
 *
 * 顶层与 `data` 两种形状都摊平读（与 `toSegments` 的摊平规则一致）。
 *
 * @param {Record<string, unknown>} segment
 * @returns {Record<string, unknown>}
 */
export function summarizeFileSegment(segment) {
  if (segment === null || typeof segment !== 'object') return { keys: [] };
  const data = segment.data !== null && typeof segment.data === 'object' ? segment.data : null;
  const fileId = fileIdFromSegment(segment);
  /** @type {Record<string, unknown>} */
  const out = {
    keys: Object.keys(segment),
    idShaped: isFileIdShaped(segment.file ?? segment.data?.file),
    fileId: fileId === '' ? '' : loggableScalar('file_id', fileId),
  };
  if (data !== null) out.dataKeys = Object.keys(data);
  const flat = data === null ? { ...segment } : { ...data, ...segment };
  delete flat.data;
  delete flat.type;
  for (const [key, value] of Object.entries(flat)) out[key] = loggableScalar(key, value);
  return out;
}

/**
 * record（语音）段的**日志摘要**（B4 探针，2026-10-25）。
 *
 * 只回答一个问题：**NapCat 到底给语音段带了哪些字段** —— 尤其是 `text`
 * （QQ 服务端转写）在不在。它决定后面走哪条路：
 * - 有 `text` ⇒ 直接用（`protocol.mjs` 的 `segmentsToText` 已经会渲染成 `[语音：…]`）；
 * - 只有 `file` / `url` ⇒ 要 `get_record` + SILK 解码，**先不做**。
 *
 * ⚠️ **绝不打 base64**：除 `text` 之外的长字符串走 `loggableScalar` 的规则
 * （base64 形状直接换成一句说明，长的截成 12 字符 + 总长）；
 * `text` 单独放宽到 120 字符 —— 那正是我们要看的那句话。
 *
 * 顶层与 `data` 两种形状都摊平读（与 `toSegments` 的摊平规则一致）。
 *
 * @param {Record<string, unknown>} segment
 * @returns {Record<string, unknown>}
 */
export function summarizeRecordSegment(segment) {
  if (segment === null || typeof segment !== 'object') return { keys: [] };
  const data = segment.data !== null && typeof segment.data === 'object' ? segment.data : null;
  const flat = data === null ? { ...segment } : { ...data, ...segment };
  delete flat.data;
  delete flat.type;
  /** @type {Record<string, unknown>} */
  const out = { keys: Object.keys(segment) };
  if (data !== null) out.dataKeys = Object.keys(data);
  for (const [key, value] of Object.entries(flat)) {
    if (key === 'text' && typeof value === 'string') {
      out.textLen = value.length;
      out.text = value.length > 120 ? `${value.slice(0, 120)}…` : value;
      continue;
    }
    out[key] = loggableScalar(key, value);
  }
  return out;
}

/**
 * 取出消息里的图片段（最多 {@link MAX_IMAGES_PER_MESSAGE} 张）。
 *
 * @param {Array<{type: string} & Record<string, unknown>>} segments
 * @param {object} [options]
 * @param {boolean} [options.includeImageFiles=false]
 *   **入站投递**要传 true：把"file 段里装着的图"也并进来（判据见 {@link isImageFileSegment}）。
 *   默认 false —— 其余调用方（贴纸收割、图片描述预取、转录渲染）用的**一直是**纯 image 段，
 *   改它们的口径会牵动缓存键与打分，不在这次修复范围内。
 * @returns {Array<Record<string, unknown>>}
 */
export function collectImageSegments(segments, { includeImageFiles = false } = {}) {
  const list = Array.isArray(segments) ? segments : [];
  return list.filter((s) => s !== null && typeof s === 'object'
    && (s.type === 'image' || (includeImageFiles === true && isImageFileSegment(s))))
    .slice(0, MAX_IMAGES_PER_MESSAGE);
}

/**
 * 段里有没有给**本机路径**（而不是 URL）。
 *
 * ## 为什么需要它（实测，不是设想）
 *
 * NapCat 给某些段的 `url` 就是**本机绝对路径**。实测抓到过真实样本
 * （2026-10-07，一个视频段）：
 *
 * ```json
 * { "type": "video", "data": {
 *     "file": "e6cc2faf3138ff5827792d012b5f5d72.mp4",
 *     "url": "D:\QQNT\\data\\30000002\\nt_qq\\nt_data\\Video\\2026-10\\Ori\\e6cc…mp4",
 *     "file_size": "519643" } }
 * ```
 *
 * 而原先的 `fetchImageBytes` 只认 `http(s)` —— 于是**本机就有的文件反而被当成"下载失败"跳过**。
 * 这条路顺带解决了两件事：省一次 CDN 往返；以及"客户端已经缓存了原件"时能拿到**原件**
 * （判断 GIF 有没有多帧，必须原件，缩略图不算）。
 *
 * 认三种写法：`D:\…` / `D:/…`（盘符）、`\\server\share\…`（UNC）、`file:///D:/…`。
 *
 * @param {Record<string, unknown>} segment
 * @returns {string|null} 本机路径；没有返回 null
 */
export function localPathFromSegment(segment) {
  const raw = [segment?.url, segment?.file, segment?.data?.url, segment?.data?.file];
  for (const value of raw) {
    const text = cqUnescape(String(value ?? '')).trim();
    if (text === '') continue;
    if (/^file:\/\//i.test(text)) {
      try {
        return fileURLToPath(text);
      } catch {
        continue; // 畸形的 file:// → 当没有
      }
    }
    if (/^[a-z]:[\\/]/i.test(text) || text.startsWith('\\\\')) return text;
  }
  return null;
}

/**
 * 把 OneBot 图片段变成字节。
 *
 * 支持四种来源（QQ 客户端不同版本给的不一样）：
 *   - `url`：http(s) 链接（最常见）
 *   - `url` / `file`：**本机路径**（见 {@link localPathFromSegment}）
 *   - `file`：可能是 `base64://...`
 *   - `base64`：直接给
 *
 * ## ⚠️ 四个字段都**两种形状都读**（`url` 与 `data.url`）
 *
 * 这是 2026-10-08 实测抓出来的不一致：本函数原来只读**顶层**（`segment.url`），
 * 而同模块的 {@link localPathFromSegment} 读的是**两种**（`url` 与 `data.url`）。
 * 入站事件那条路不会暴露它（`normalizeEvent` → `toSegments` 已经把 `data` 摊平了），
 * 但**别的调用方拿的是没摊平的原生载荷**，实测直接踩到：
 *
 * - NapCat 的 **HTTP** API（`get_friend_msg_history`）返回的段是
 *   `{type:'image', data:{url:'https://gxh.vip.qq.com/…', emoji_id:'…'}}`
 *   —— 顶层没有 `url`。于是"取字节"这一步**静默返回 null**，
 *   表现成"表情包明明识别出来了，却一张都没落盘"。
 *
 * 取值顺序与 `toSegments` 的摊平规则一致：**顶层优先，缺了再看 `data`**。
 * 两种形状都给且不一致时以顶层为准（同 `toSegments` 的"顶层已有同名键不被覆盖"）。
 *
 * @param {Record<string, unknown>} segment
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {{readFileSync: Function, statSync: Function}} [options.fsImpl]
 * @param {((action: string, params?: object, options?: {timeoutMs?: number}) => Promise<any>)|null} [options.oneBotAction] **file 段**取字节的兜底（OneBot `get_file`）；由 `gateway` 传入 `transport.action` 的薄包装。省略 = 不兜底（老行为）。
 * @returns {Promise<{data: Uint8Array, name: string}|null>} 失败返回 null（不抛）
 */
export async function fetchImageBytes(segment, {
  fetchImpl = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
  fsImpl = fs,
  oneBotAction = null,
} = {}) {
  /** 顶层优先、缺了看 `data`（与 `toSegments` 的摊平规则一致）。 */
  const field = (key) => {
    const top = segment?.[key];
    if (top !== undefined && top !== null) return top;
    return segment?.data?.[key];
  };
  const rawUrl = cqUnescape(String(field('url') ?? ''));
  const rawFile = String(field('file') ?? '');
  const rawBase64 = String(field('base64') ?? '');
  const name = rawFile !== '' ? rawFile.split(/[\\/]/).pop() ?? 'qq-image' : 'qq-image';

  // ① base64:// 或独立的 base64 字段 —— 不用走网络
  const inline = rawBase64 !== '' ? rawBase64 : (rawFile.startsWith('base64://') ? rawFile.slice('base64://'.length) : '');
  if (inline !== '') {
    try {
      const data = new Uint8Array(Buffer.from(inline, 'base64'));
      if (data.length > 0 && data.length <= MAX_IMAGE_BYTES) return { data, name };
    } catch {
      // 落到下面继续试 URL
    }
  }

  // ② 本机路径 —— 也不用走网络（客户端已经缓存过原件时才给得出这条路）
  const localPath = localPathFromSegment(segment);
  if (localPath !== null) {
    try {
      const stat = fsImpl.statSync(localPath);
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_IMAGE_BYTES) {
        const data = new Uint8Array(fsImpl.readFileSync(localPath));
        if (data.length > 0) {
          return { data, name: localPath.split(/[\\/]/).pop() ?? name };
        }
      }
    } catch {
      // 路径不存在/读不了 → 继续试下面的 URL（段里的路径可能来自另一台机器）
    }
  }

  // ③ http(s) 下载（段里直接给了可下载地址 —— 最常见）
  const direct = await downloadBytes(rawUrl, { fetchImpl, timeoutMs });
  if (direct !== null) return { data: direct, name };

  // ④ **file 段兜底：段里只给 file_id / 文件名，可取地址得问服务器**
  //    见 bytesViaGetFile（OneBot `get_file`）。仍拿不到 ⇒ null ⇒ 调用方退回 [文件]。
  const viaAction = await bytesViaGetFile(segment, { fetchImpl, timeoutMs, fsImpl, oneBotAction });
  if (viaAction !== null) return { data: viaAction, name };

  return null;
}

/**
 * 下载一个 http(s) 地址。失败 / 空 / 超限一律返回 null（**不抛**）。
 *
 * @param {unknown} rawUrl
 * @param {{fetchImpl: typeof fetch, timeoutMs: number}} options
 * @returns {Promise<Uint8Array|null>}
 */
async function downloadBytes(rawUrl, { fetchImpl, timeoutMs }) {
  const url = String(rawUrl ?? '');
  if (!/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 向服务器要 file 段的字节（OneBot 11 的 `get_file`）。
 *
 * ## 为什么必须有它（2026-10-22 第二次真机）
 *
 * QQ 把那张图当**文件**发：`file` 段只有 `file`（名字 / id），**没有 `url`**。
 * 于是"下载"那一步连地址都没有 ⇒ 直接 null ⇒ 退回 `[文件]`，小鲸鱼只看到一行文件名。
 * OneBot 11 的约定就是**再问一次**：
 *
 * ```text
 * action get_file { file_id: <id> }
 *   → { file: "<服务器上的路径>", url: "<可下载地址>", file_size: … , base64?: "…" }
 * ```
 *
 * 三种返回都认：`base64` 直接解（不走网络）；`url` 再下载；`file` 是服务器本地路径时
 * **只有 NapCat 与 DSH 同机部署**才读得到（容器部署给的是容器内路径 ⇒ 读不到 ⇒ 降级）。
 *
 * ⚠️ 调用**复用传输层的 action 封装**（由 `gateway` 把 `transport.action` 传进来），
 * 这里不另写一套 HTTP —— `send_msg` 走的就是那个口子。
 * ⚠️ 任何失败都只是"拿不到字节"（返回 null），交给调用方走降级 —— **绝不抛**。
 *
 * @param {Record<string, unknown>} segment
 * @param {object} options
 * @param {typeof fetch} options.fetchImpl
 * @param {number} options.timeoutMs
 * @param {{readFileSync: Function, statSync: Function}} options.fsImpl
 * @param {((action: string, params?: object, options?: {timeoutMs?: number}) => Promise<any>)|null} options.oneBotAction
 * @returns {Promise<Uint8Array|null>}
 */
async function bytesViaGetFile(segment, { fetchImpl, timeoutMs, fsImpl, oneBotAction }) {
  if (typeof oneBotAction !== 'function') return null;
  if (segment === null || typeof segment !== 'object' || segment.type !== 'file') return null;
  const fileId = fileIdFromSegment(segment);
  if (fileId === '') return null;

  let data;
  try {
    // `file_id` 是 OneBot 11 的字段名；NapCat 也接受 `file`（社区实现就这么调）。
    // 两个都带上，谁认哪个都行 —— 多余的那个会被忽略。
    data = await oneBotAction('get_file', { file_id: fileId, file: fileId }, { timeoutMs });
  } catch {
    // 老实现没这个 action / 文件过期 / 连接断了 —— 都只是"拿不到"，不抛
    return null;
  }
  if (data === null || typeof data !== 'object') return null;

  // a) base64：字节已经给全了，不用走网络
  if (typeof data.base64 === 'string' && data.base64 !== '') {
    try {
      const bytes = new Uint8Array(Buffer.from(data.base64, 'base64'));
      if (bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES) return bytes;
    } catch {
      // 解不出来 → 继续试 url / 路径
    }
  }

  // b) http(s) 地址（NapCat 开了「文件转 URL」才有）
  const url = cqUnescape(String(data.url ?? ''));
  if (/^https?:\/\//i.test(url)) {
    const bytes = await downloadBytes(url, { fetchImpl, timeoutMs });
    if (bytes !== null) return bytes;
  }

  // c) 服务器上的本地路径 —— 同机部署才读得到（容器内路径 statSync 会抛，下面吞掉）
  const serverPath = String(data.file ?? '');
  if (serverPath !== '' && !/^https?:\/\//i.test(serverPath)) {
    try {
      const stat = fsImpl.statSync(serverPath);
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_IMAGE_BYTES) {
        const bytes = new Uint8Array(fsImpl.readFileSync(serverPath));
        if (bytes.length > 0) return bytes;
      }
    } catch {
      // 读不到 → 降级
    }
  }
  return null;
}

/**
 * 这张图**允许多大**（单边像素）。
 *
 * 优先读宿主附件服务自己暴露的上限（`LocalAttachmentStore.imageLimits`，
 * 是构造函数里 `Object.freeze` 出来的普通字段）—— 用户在 DSH 配置里改过
 * `maxImageDimension` 时我们才跟着改，不自己写死一个数。
 * 读不到（别的实现 / 老版本 / 替身）就用 {@link MAX_IMAGE_DIMENSION}（8192，宿主默认值）。
 *
 * @param {unknown} attachments
 * @returns {number}
 */
export function resolveDimensionLimit(attachments) {
  const raw = attachments?.imageLimits?.maxImageDimension;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : MAX_IMAGE_DIMENSION;
}

/**
 * 把一张图（可能已被切成多段）存成附件，产出 image block（+ 需要时一句说明）。
 *
 * 三段式：
 * 1. 尺寸读得出来、且任一边超限、且切得动 ⇒ **切**，每段各存一个附件；
 * 2. 切图失败 / 切不动 ⇒ **退回原图**（老行为，DSH 拒收就只丢这一张，记 warn）；
 * 3. 尺寸读不出来（GIF/WebP/畸形头）⇒ 直接走原图（切了也没意义）。
 *
 * @param {object} options
 * @returns {Promise<{blocks: Array<{type: 'image', attachment: any}>, note: string}>}
 */
async function blocksForImage({ attachments, got, mediaType, limit, splitImpl, log }) {
  const info = imageInfo(Buffer.from(got.data));
  const tooBig = info !== null && Math.max(info.width, info.height) > limit;
  if (!tooBig) {
    const ref = await attachments.saveImage({ data: got.data, mediaType, name: got.name });
    return { blocks: [{ type: 'image', attachment: ref }], note: '' };
  }

  const plan = planSplits(info.width, info.height, limit, DEFAULT_OVERLAP);
  if (plan.segments.length < 2) {
    // 段数上限内也切不到"每段都合格" ⇒ 别输出一批仍然超限的图（那只是把一次拒收变成 N 次）。
    log('warn', '长图切不动（段数到上限仍超限），退回原图', {
      width: info.width, height: info.height, limit,
    });
    const ref = await attachments.saveImage({ data: got.data, mediaType, name: got.name });
    return { blocks: [{ type: 'image', attachment: ref }], note: '' };
  }

  let split = null;
  try {
    split = await splitImpl({
      data: got.data,
      name: got.name,
      format: info.format,
      segments: plan.segments,
    });
  } catch (error) {
    log('warn', '长图切分抛了异常，退回原图', {
      width: info.width, height: info.height,
      error: error instanceof Error ? error.message : String(error),
    });
    split = null;
  }

  const usable = split !== null && typeof split === 'object' && split.ok === true
    && Array.isArray(split.images) && split.images.length === plan.segments.length;
  if (!usable) {
    // 用户的硬要求：**切分失败 ⇒ 退回原图 + 记 warn，绝不因为切图把消息弄丢**。
    log('warn', '长图切分失败，退回原图', {
      width: info.width,
      height: info.height,
      limit,
      segments: plan.segments.length,
      error: String(split?.error ?? 'unknown'),
    });
    const ref = await attachments.saveImage({ data: got.data, mediaType, name: got.name });
    return { blocks: [{ type: 'image', attachment: ref }], note: '' };
  }

  // 每段单独入库：任何一段失败都算"这次切图方案失败" ⇒ 退回原图（半套切片会误导模型）。
  const blocks = [];
  try {
    for (const image of split.images) {
      const ref = await attachments.saveImage({
        data: image.data,
        mediaType: 'image/jpeg',
        name: image.name,
      });
      blocks.push({ type: 'image', attachment: ref });
    }
  } catch (error) {
    log('warn', '切片入库失败，退回原图', {
      error: error instanceof Error ? error.message : String(error),
      done: blocks.length,
    });
    const ref = await attachments.saveImage({ data: got.data, mediaType, name: got.name });
    return { blocks: [{ type: 'image', attachment: ref }], note: '' };
  }

  log('info', '长图已切分', {
    width: info.width,
    height: info.height,
    limit,
    count: blocks.length,
  });
  return { blocks, note: buildSplitNote(plan) };
}

/**
 * 把消息里的图片存成 DSH 附件，产出可以直接塞进消息的 image block，
 * **外加**需要告诉模型的那几句话（长图被切开的说明）。
 *
 * 为什么要有 "Detailed" 这一版：`blocks` 是老契约（返回数组），而"这是同一张图的
 * 1/2、2/2"这句话必须进**提示词**，数组装不下。分开两个函数是为了让老调用方
 * （`toImageBlocks`，返回数组）一个字都不用改。
 *
 * **任何一步失败都只跳过那一张图**，并记一条日志 —— 调用方拿到的是
 * "能用的那些" + "要说的话"，不是异常。
 *
 * @param {object} options
 * @param {{saveImage(input: {data: Uint8Array, mediaType: string, name?: string}): Promise<any>, imageLimits?: {maxImageDimension?: number}}} options.attachments
 *   `ctx.attachments`。**为 null/undefined 时直接返回空结果**（插件在没有附件服务的
 *   环境里也要能跑，只是看不到图）。
 * @param {Array<Record<string, unknown>>} options.segments 入站消息的段数组
 *   （**含 file 段**：其中是图片的会被并进来，见 {@link isImageFileSegment}）
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {Function} [options.splitImpl] 切图实现（默认 `image-split.mjs` 的 `splitImageBytes`；测试注入）
 * @param {number} [options.dimensionLimit] 单边上限（省略则读 `attachments.imageLimits`，再退 8192）
 * @param {Function} [options.oneBotAction] 透传给 `fetchImageBytes` 的 OneBot action 调用方（见 {@link bytesViaGetFile}）。
 * @returns {Promise<{blocks: Array<{type: 'image', attachment: any}>, notes: string[]}>}
 */
export async function toImageBlocksDetailed({
  attachments,
  segments,
  fetchImpl = fetch,
  log = () => {},
  oneBotAction = null,
  splitImpl = splitImageBytes,
  dimensionLimit,
} = {}) {
  const outcome = { blocks: [], notes: [] };

  // 收到 file 段先留一行 **debug** 摘要：键名 + 标量（见 summarizeFileSegment）。
  // 打 debug 不打 warn：每条带文件的消息都会路过，warn 会刷屏；而排查"图为什么没进来"
  // 缺的正是"NapCat 到底给了哪些字段"。**base64 内容永远不进日志。**
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (seg !== null && typeof seg === 'object' && seg.type === 'file') {
      log('debug', 'file 段摘要（只打键名与标量，不打内容）', summarizeFileSegment(seg));
    }
  }

  if (attachments === null || attachments === undefined || typeof attachments.saveImage !== 'function') {
    return outcome;
  }
  // ⚠️ **入站投递是唯一要"file 段里的图"的调用方**（判据见 {@link isImageFileSegment}）。
  const picked = collectImageSegments(segments, { includeImageFiles: true });
  if (picked.length === 0) return outcome;

  const explicit = Number(dimensionLimit);
  const limit = Number.isFinite(explicit) && explicit >= 1
    ? Math.floor(explicit)
    : resolveDimensionLimit(attachments);

  for (const seg of picked) {
    // ⚠️ file 段里的图是**猜**出来的（看扩展名，见 {@link isImageFileSegment}）。
    //    它失败了不许静默 —— 那正是用户看到的"发了图，小鲸鱼什么都没收到"。
    //    所以这一路一律记 warn；老路（image 段）保持原来的 debug 不动。
    const fromFile = seg.type === 'file';
    const failed = fromFile ? 'warn' : 'debug';
    const segName = fromFile ? String(seg.file ?? seg.data?.file ?? '') : '';
    try {
      const got = await fetchImageBytes(seg, { fetchImpl, oneBotAction });
      if (got === null) {
        log(failed, fromFile
          ? 'file 段疑似图片但取不到字节，退回 [文件]'
          : '图片下载失败，跳过（保留占位符）', { name: segName });
        continue;
      }
      const mediaType = sniffImageMediaType(got.data);
      if (mediaType === null) {
        log(failed, fromFile
          ? 'file 段不是有效图片（字节认不出），退回 [文件]'
          : '图片格式认不出，跳过（保留占位符）', { bytes: got.data.length, name: segName });
        continue;
      }
      const added = await blocksForImage({ attachments, got, mediaType, limit, splitImpl, log });
      if (added.blocks.length > 0) {
        outcome.blocks.push(...added.blocks);
        if (added.note !== '') outcome.notes.push(added.note);
        // 留痕：线上查"file 段到底有没有被当成图"就看这一条。
        if (fromFile) {
          log('info', 'file 段里的图片已按图片处理', { name: got.name, blocks: added.blocks.length });
        }
      }
    } catch (error) {
      // 包括 DSH 那边因为尺寸/字节超限而拒收 —— 同样只跳过这一张。
      log(failed, fromFile
        ? 'file 段里的图片入库失败，退回 [文件]'
        : '图片入库失败，跳过（保留占位符）', {
        error: error instanceof Error ? error.message : String(error),
        name: segName,
      });
    }
  }
  return outcome;
}

/**
 * 老签名：只要 image block 数组（不要那句说明）。
 *
 * @param {object} options 同 {@link toImageBlocksDetailed}
 * @returns {Promise<Array<{type: 'image', attachment: any}>>}
 */
export async function toImageBlocks(options = {}) {
  const outcome = await toImageBlocksDetailed(options);
  return outcome.blocks;
}
