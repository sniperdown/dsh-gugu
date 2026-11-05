/**
 * GIF：**自己把帧解出来**，挑出关键帧，横着拼成一张图。
 *
 * ## 为什么要在插件里手写一个 GIF 解码器
 *
 * 用户 2026-10-07 的要求是「**动图要真的看得见动态**」。而链路上有一道我们改不了的坎：
 * DSH 在把图片投影进 LLM 请求时，会把动图归一化成**单帧 webp**
 * （`@deepseek-ai/dsh-llm` 里那句 `Normalized copy (read-only; may be resized or re-encoded)`），
 * 所以模型端永远只看得到一帧。小鲸鱼实测：48 帧的 GIF，**第 47 帧才是笑点**，
 * 而它拿到的那一帧是「眼眶含泪」—— 笑点正好落在没给它的那 47 帧里。
 *
 * 要绕开，只能**在插件侧拿原件、自己解帧**。三条约束决定了实现方式：
 *
 * 1. **不许装东西**（用户明确要求）⇒ 不能引 `sharp` / `omggif` / `gifuct-js`；
 * 2. **不依赖 shell / 外部进程**（群会话的 preset 里连 pwsh 都没有，插件更不该要靠它）
 *    ⇒ 不能去调小鲸鱼那个 `tools/gif-inspect.py`（那是**人**用的工具，不是运行时要依赖的东西）；
 * 3. **不能把内存吃爆**：一张 2000×2000、100 帧的 GIF，全解出来是 1.6GB。
 *
 * 所以这里的做法是「**两趟解码**」：
 *
 * ```
 * 第一趟：逐帧解 → 立刻缩成 48×48 的缩略图（只留缩略图，全尺寸的丢掉）→ 算相邻帧差异
 *         ↓ 选关键帧（首帧 + 末帧 + 变化最大的若干帧）
 * 第二趟：再解一遍，**只留选中的那几帧**，缩到拼图尺寸 → 横着拼 → 编码成 PNG
 * ```
 *
 * 两趟 = 两倍 CPU（GIF 的 LZW 很快，几毫秒到几十毫秒），换来的是**内存与帧数无关**：
 * 第一趟常驻内存只有 `帧数 × 48×48×4 ≈ 9KB/帧`，第二趟最多留 `maxFrames` 帧全尺寸。
 *
 * ## 这个模块**不判断**「是不是动图」以外的任何事
 *
 * - 帧数 = 1 ⇒ 这就是一张静图。**扩展名是 `.gif` 不代表它在动** ——
 *   小鲸鱼实测过：它那个 `img1.gif` 是 `GIF89a` 但只有 **1 帧**。
 * - 帧数 > 1 ⇒ 它确实是多帧的（**这是从文件结构里数出来的事实，不是猜的**）。
 *   ⚠️ 但**文本层不会因此写「动图」**：用户明确要求只能标「源 gif」。
 *   这个区分很重要 —— 「多帧」是文件属性，「动图」是要读者自己下结论的事。
 *
 * ## 挑帧策略：**首 + 末 + 变化最大的**
 *
 * 只按「相邻帧差异最大的 Top-N」挑会漏掉笑点：**笑点是变化的结果，不是变化本身**。
 * 小鲸鱼那个例子里，第 47 帧（最后一张）才是梗，而纯 Top-N 选的是「跳变最猛」的那几帧，
 * 未必含最后一张。所以这里**固定锚住首帧和末帧**，剩下的名额按差异率补：
 *
 * | 位置 | 作用 |
 * |---|---|
 * | 第 0 帧 | 「从哪开始」 |
 * | **最后一帧** | 「到哪结束」—— 笑点通常在这里（实测踩过） |
 * | 变化最大的 2 帧 | 中间的关键转折 |
 *
 * @module qq-gugu/gif
 */

import zlib from 'node:zlib';

/** GIF 文件头（`GIF87a` / `GIF89a` 的前 4 字节）。 */
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38];

/**
 * 拼图里放几帧。
 *
 * **为什么是 4**（用户给的范围是 2~6，要我说依据）：
 *
 * - **2 帧不够**：只能给"开始/结束"，一段有转折的 GIF（铺垫→反转→笑点）会被压成两点，
 *   而"从哪变到哪"恰恰要靠中间那一跳才说得清；
 * - **6 帧太贵且太小**：横向拼 6 帧时，为了不超 `SHEET_MAX_WIDTH`，每帧只能分到 200px 上下，
 *   表情细节（笑点常在那）糊掉；而且视觉 token 与像素面积成正比，6 帧不会比 4 帧便宜多少；
 * - **4 帧 = 首 + 末 + 2 个最大变化**：正好覆盖"起、转、合"，每帧还能分到 300~500px。
 *
 * 成本参考：4 帧 @ 300×300 拼成 1224×300 ≈ **470 token**；源图较大时被
 * {@link SHEET_MAX_WIDTH} 压到 1400 宽 ≈ **550 token**。相比"整条描述只花一次调用"，
 * 这是它的 1.5 倍上下 —— 而它换来的是**唯一能看到动态的机会**（见模块头）。
 */
export const DEFAULT_SHEET_FRAMES = 4;

/** 拼图总宽上限（像素）。超了就把每帧一起缩小，免得被下游按长边再压一次、细节全糊。 */
export const SHEET_MAX_WIDTH = 1400;

/** 单帧在拼图里的最大宽度。小图**不放大**（放大只是把同样的信息画得更大，反而糊）。 */
export const SHEET_MAX_FRAME_WIDTH = 512;

/** 帧与帧之间的白缝（像素）。没有缝时相邻两帧会糊成一张，看不出"这是两张"。 */
export const SHEET_GAP = 8;

/** 第一趟最多扫多少帧。上千帧的 GIF 要么是录屏要么是坏的，扫到上限就停（不假装看完了）。 */
export const MAX_SCANNED_FRAMES = 600;

/** 画布像素上限（宽 × 高）。超过就当"太大，不解"，避免解码炸弹把内存吃光。 */
export const MAX_CANVAS_PIXELS = 40_000_000;

/** 差异比较用的缩略图边长（与 `gif-inspect.py` 的 32×32 采样同量级，便于人工对账）。 */
export const THUMB_SIDE = 48;

/** 差异判定里"一个通道算变了"的阈值（0~255）。与小鲸鱼那版工具一致，便于交叉验证。 */
const DIFF_CHANNEL_THRESHOLD = 24;

/** 差异比较用的采样边长。 */
const DIFF_SAMPLE_SIDE = 32;

/**
 * 是不是 GIF（只看 magic bytes，**不看扩展名**）。
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isGif(bytes) {
  if (!bytes || bytes.length < 6) return false;
  for (let i = 0; i < GIF_SIGNATURE.length; i += 1) {
    if (bytes[i] !== GIF_SIGNATURE[i]) return false;
  }
  return true;
}

/** 小端读 16 位。越界返回 -1（调用方据此判定"截断了"）。 */
function u16(bytes, at) {
  if (at + 1 >= bytes.length) return -1;
  return bytes[at] | (bytes[at + 1] << 8);
}

/**
 * 跳过一串 sub-block（每个块首字节是长度，0 表示结束）。
 * @returns {number} 结束后的下标；越界返回 -1
 */
function skipSubBlocks(bytes, at) {
  let p = at;
  while (p < bytes.length) {
    const size = bytes[p];
    if (size === 0) return p + 1;
    p += size + 1;
  }
  return -1;
}

/**
 * **只扫结构、不解码**：数出帧数、画布尺寸、循环次数。
 *
 * 这是"要不要走抽帧这条路"的判据 —— 帧数是**文件结构里的事实**，
 * 比扩展名可靠（`img1.gif` 的教训）。
 *
 * 不抛异常：截断/畸形的文件返回已经数到的部分，并带 `truncated: true`。
 *
 * @param {Uint8Array} bytes
 * @returns {{gif: boolean, version?: string, width?: number, height?: number,
 *            frameCount?: number, loop?: number|null, truncated?: boolean}}
 */
export function parseGifInfo(bytes) {
  if (!isGif(bytes)) return { gif: false };
  const version = String.fromCharCode(bytes[4], bytes[5]);
  const width = u16(bytes, 6);
  const height = u16(bytes, 8);
  if (width <= 0 || height <= 0) return { gif: false };

  const packed = bytes[10];
  let p = 13;
  if ((packed & 0x80) !== 0) p += 3 * (1 << ((packed & 0x07) + 1));

  let frameCount = 0;
  let loop = null;
  let truncated = false;

  while (p < bytes.length) {
    const block = bytes[p];
    if (block === 0x3b) break; // trailer

    if (block === 0x21) {
      // 扩展块：label 后面跟 sub-block
      if (p + 1 >= bytes.length) { truncated = true; break; }
      const label = bytes[p + 1];
      if (label === 0xf9) {
        // Graphic Control Extension：块长固定 4，里面没有循环次数
        const next = skipSubBlocks(bytes, p + 2);
        if (next < 0) { truncated = true; break; }
        p = next;
        continue;
      }
      if (label === 0xff) {
        // Application Extension：NETSCAPE2.0 的 sub-block 第二字节 = 循环次数
        const at = p + 2;
        const size = at < bytes.length ? bytes[at] : 0;
        if (size >= 3 && at + 1 + size <= bytes.length) {
          const tag = String.fromCharCode(...bytes.subarray(at + 1, at + 1 + Math.min(size, 11)));
          if (tag.startsWith('NETSCAPE')) {
            const dataAt = at + 1 + size;
            // 下一段 sub-block：`[3, 0x01, loopLow, loopHigh]`
            // ⚠️ 里面那个 `0x01` 是**子块 ID**，不是循环次数 —— 漏掉它会把
            // `loop=0`（无限循环）读成 1。这个 off-by-one 是拿 PIL 对账时抓出来的
            // （PIL 说 img3.gif 是 0，我这版一开始说 1）。
            if (dataAt + 3 < bytes.length && bytes[dataAt] >= 3) {
              loop = u16(bytes, dataAt + 2);
            }
          }
        }
      }
      const next = skipSubBlocks(bytes, p + 2);
      if (next < 0) { truncated = true; break; }
      p = next;
      continue;
    }

    if (block === 0x2c) {
      // Image Descriptor：9 字节（left/top/w/h 各 2 + packed 1），越界就是截断
      if (p + 9 >= bytes.length) { truncated = true; break; }
      const localPacked = bytes[p + 9];
      let q = p + 10;
      if ((localPacked & 0x80) !== 0) q += 3 * (1 << ((localPacked & 0x07) + 1));
      q += 1; // LZW minimum code size
      const next = skipSubBlocks(bytes, q);
      if (next < 0) { truncated = true; break; }
      frameCount += 1;
      p = next;
      continue;
    }

    // 认不出的块：停下。**不假装知道后面还有什么**。
    truncated = true;
    break;
  }

  return { gif: true, version, width, height, frameCount, loop, truncated };
}

/**
 * GIF 的 LZW 解压（GIF 变体：码长从 `minCodeSize + 1` 起，字典满 4096 封顶，
 * 遇到 clear code 就重置，遇到 EOI 或数据耗尽就停）。
 *
 * @param {Uint8Array} data 已经拼好的码流（不含 sub-block 的长度字节）
 * @param {number} minCodeSize 1~8
 * @param {number} maxPixels 期望输出多少像素（多出来的丢弃）
 * @returns {Uint8Array|null} 解不出来返回 null（**不抛**）
 */
function lzwDecode(data, minCodeSize, maxPixels) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const MAX_CODES = 4096;

  const prefix = new Int32Array(MAX_CODES).fill(-1);
  const suffix = new Uint8Array(MAX_CODES);
  for (let i = 0; i < clearCode; i += 1) suffix[i] = i;

  const out = new Uint8Array(maxPixels);
  let outPos = 0;
  const stack = new Uint8Array(MAX_CODES + 1);

  let codeSize = minCodeSize + 1;
  let next = eoiCode + 1;
  let prev = -1;
  let bitPos = 0;
  let firstByte = 0;

  const totalBits = data.length * 8;
  while (bitPos + codeSize <= totalBits) {
    // GIF 的码是 **LSB-first** 打包的，且跨 sub-block 边界连续
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const at = bitPos + i;
      const bit = (data[at >> 3] >> (at & 7)) & 1;
      code |= bit << i;
    }
    bitPos += codeSize;

    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      next = eoiCode + 1;
      prev = -1;
      continue;
    }
    if (code === eoiCode) break;

    let cur = code;
    let sp = 0;
    if (cur >= next) {
      // KwKwK：码还没进字典，等于「上一串 + 上一串的首字节」
      if (prev < 0) return null;
      stack[sp] = firstByte;
      sp += 1;
      cur = prev;
    }
    while (cur >= 0) {
      if (sp > MAX_CODES) return null; // 字典被写坏（畸形文件）
      stack[sp] = suffix[cur];
      sp += 1;
      cur = prefix[cur];
    }
    firstByte = stack[sp - 1];
    while (sp > 0) {
      sp -= 1;
      if (outPos < maxPixels) out[outPos] = stack[sp];
      outPos += 1;
    }

    if (prev >= 0 && next < MAX_CODES) {
      prefix[next] = prev;
      suffix[next] = firstByte;
      next += 1;
      if (next === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    prev = code;
  }

  return out;
}

/** 把 sub-block 串拼成一段连续码流。 */
function gatherSubBlocks(bytes, at) {
  const parts = [];
  let p = at;
  let total = 0;
  while (p < bytes.length) {
    const size = bytes[p];
    if (size === 0) { p += 1; break; }
    const start = p + 1;
    const end = Math.min(start + size, bytes.length);
    parts.push(bytes.subarray(start, end));
    total += end - start;
    p = end;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

/** 读调色板（每个颜色 3 字节）到 `Uint8Array(256*3)`，缺的位置保持 0。 */
function readPalette(bytes, at, entries) {
  const table = new Uint8Array(256 * 3);
  for (let i = 0; i < entries; i += 1) {
    const src = at + i * 3;
    if (src + 2 >= bytes.length) break;
    table[i * 3] = bytes[src];
    table[i * 3 + 1] = bytes[src + 1];
    table[i * 3 + 2] = bytes[src + 2];
  }
  return table;
}

/**
 * 逐帧解码，**每帧回调一次**（回调自己决定留什么、留多大）。
 *
 * 这样设计是为了省内存：调用方第一趟只留 48×48 的缩略图，第二趟只留选中的几帧。
 * 回调返回 `false` 可以**提前终止**（第二趟收齐了就停，不必把剩下的帧也解完）。
 *
 * 任何畸形/截断都**不抛异常**，返回已经解出来的帧数。
 *
 * @param {Uint8Array} bytes
 * @param {object} options
 * @param {(frame: {index: number, width: number, height: number, rgba: Uint8Array, delayMs: number}) => (boolean|void)} options.onFrame
 * @param {number} [options.maxFrames]
 * @returns {{ok: boolean, reason?: string, width: number, height: number, decoded: number}}
 */
export function decodeGifFrames(bytes, { onFrame, maxFrames = MAX_SCANNED_FRAMES } = {}) {
  if (!isGif(bytes)) return { ok: false, reason: 'not-gif', width: 0, height: 0, decoded: 0 };
  const canvasWidth = u16(bytes, 6);
  const canvasHeight = u16(bytes, 8);
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return { ok: false, reason: 'bad-header', width: 0, height: 0, decoded: 0 };
  }
  if (canvasWidth * canvasHeight > MAX_CANVAS_PIXELS) {
    return { ok: false, reason: 'too-large', width: canvasWidth, height: canvasHeight, decoded: 0 };
  }

  const screenPacked = bytes[10];
  const globalPalette = (screenPacked & 0x80) !== 0
    ? readPalette(bytes, 13, 1 << ((screenPacked & 0x07) + 1))
    : null;
  let p = 13 + ((screenPacked & 0x80) !== 0 ? 3 * (1 << ((screenPacked & 0x07) + 1)) : 0);

  const canvas = new Uint8Array(canvasWidth * canvasHeight * 4);
  let pendingDelayMs = 0;
  let pendingDisposal = 0;
  let pendingTransparent = -1;
  let index = 0;

  const limit = Number.isFinite(maxFrames) && maxFrames > 0 ? Math.floor(maxFrames) : MAX_SCANNED_FRAMES;

  while (p < bytes.length && index < limit) {
    const block = bytes[p];
    if (block === 0x3b) break;

    if (block === 0x21) {
      if (p + 1 >= bytes.length) break;
      const label = bytes[p + 1];
      if (label === 0xf9) {
        const at = p + 2;
        if (at + 5 <= bytes.length && bytes[at] === 4) {
          const gcePacked = bytes[at + 1];
          pendingDelayMs = u16(bytes, at + 2) * 10;
          pendingTransparent = (gcePacked & 0x01) !== 0 ? bytes[at + 4] : -1;
          pendingDisposal = (gcePacked >> 2) & 0x07;
        }
      }
      const next = skipSubBlocks(bytes, p + 2);
      if (next < 0) break;
      p = next;
      continue;
    }

    if (block !== 0x2c) break;
    if (p + 9 >= bytes.length) break;

    const left = u16(bytes, p + 1);
    const top = u16(bytes, p + 3);
    const fw = u16(bytes, p + 5);
    const fh = u16(bytes, p + 7);
    const packed = bytes[p + 9];
    let q = p + 10;
    let palette = globalPalette;
    if ((packed & 0x80) !== 0) {
      palette = readPalette(bytes, q, 1 << ((packed & 0x07) + 1));
      q += 3 * (1 << ((packed & 0x07) + 1));
    }
    const interlaced = (packed & 0x40) !== 0;
    if (q >= bytes.length) break;
    const minCodeSize = bytes[q];
    const data = gatherSubBlocks(bytes, q + 1);
    const next = skipSubBlocks(bytes, q + 1);
    if (next < 0) break;
    p = next;

    if (fw <= 0 || fh <= 0 || palette === null || minCodeSize < 1 || minCodeSize > 8) {
      // 认不出这一帧：跳过它，但**不假装它解出来了**
      pendingDelayMs = 0;
      pendingDisposal = 0;
      pendingTransparent = -1;
      continue;
    }

    const indices = lzwDecode(data, minCodeSize, fw * fh);
    if (indices === null) break;

    // 处置方式 3（restore to previous）需要先备份这一帧要覆盖的区域
    const disposal = pendingDisposal;
    let backup = null;
    if (disposal === 3 && fw > 0 && fh > 0) {
      const bx0 = Math.min(Math.max(left, 0), canvasWidth);
      const by0 = Math.min(Math.max(top, 0), canvasHeight);
      const bw = Math.min(fw, canvasWidth - bx0);
      const bh = Math.min(fh, canvasHeight - by0);
      if (bw > 0 && bh > 0) {
        backup = new Uint8Array(bw * bh * 4);
        for (let y = 0; y < bh; y += 1) {
          const src = ((by0 + y) * canvasWidth + bx0) * 4;
          backup.set(canvas.subarray(src, src + bw * 4), y * bw * 4);
        }
      }
    }

    // 画这一帧
    const rowOrder = interlaced
      ? [[0, 8], [4, 8], [2, 4], [1, 2]]
      : [[0, 1]];
    let srcRow = 0;
    for (const [start, step] of rowOrder) {
      for (let y = start; y < fh; y += step) {
        const cy = top + y;
        if (cy < 0 || cy >= canvasHeight) { srcRow += 1; continue; }
        for (let x = 0; x < fw; x += 1) {
          const cx = left + x;
          if (cx < 0 || cx >= canvasWidth) continue;
          const colorIndex = indices[srcRow * fw + x];
          if (colorIndex === pendingTransparent) continue;
          const at = (cy * canvasWidth + cx) * 4;
          canvas[at] = palette[colorIndex * 3];
          canvas[at + 1] = palette[colorIndex * 3 + 1];
          canvas[at + 2] = palette[colorIndex * 3 + 2];
          canvas[at + 3] = 255;
        }
        srcRow += 1;
      }
    }

    const keepGoing = onFrame({
      index,
      width: canvasWidth,
      height: canvasHeight,
      rgba: canvas.slice(),
      delayMs: pendingDelayMs,
    });
    index += 1;

    // 画完之后按 disposal 收拾画布，给下一帧留干净的底
    if (disposal === 2) {
      const bx0 = Math.min(Math.max(left, 0), canvasWidth);
      const by0 = Math.min(Math.max(top, 0), canvasHeight);
      const bw = Math.min(fw, canvasWidth - bx0);
      const bh = Math.min(fh, canvasHeight - by0);
      for (let y = 0; y < bh; y += 1) {
        const at = ((by0 + y) * canvasWidth + bx0) * 4;
        canvas.fill(0, at, at + bw * 4);
      }
    } else if (disposal === 3 && backup !== null) {
      const bx0 = Math.min(Math.max(left, 0), canvasWidth);
      const by0 = Math.min(Math.max(top, 0), canvasHeight);
      const bw = Math.min(fw, canvasWidth - bx0);
      const bh = Math.min(fh, canvasHeight - by0);
      for (let y = 0; y < bh; y += 1) {
        const at = ((by0 + y) * canvasWidth + bx0) * 4;
        canvas.set(backup.subarray(y * bw * 4, (y + 1) * bw * 4), at);
      }
    }

    pendingDelayMs = 0;
    pendingDisposal = 0;
    pendingTransparent = -1;

    if (keepGoing === false) break;
  }

  return { ok: true, width: canvasWidth, height: canvasHeight, decoded: index };
}

/**
 * 面积平均缩放（RGBA）。**不放大**：目标比源大时原样返回（放大只会更糊）。
 *
 * 用面积平均而不是最近邻：差异率要的是"画面整体变了多少"，
 * 最近邻会把细小的抖动放大成整块跳变。
 *
 * @param {Uint8Array} src
 * @param {number} sw
 * @param {number} sh
 * @param {number} dw
 * @param {number} dh
 * @returns {Uint8Array}
 */
export function resizeRgba(src, sw, sh, dw, dh) {
  const tw = Math.max(1, Math.floor(dw));
  const th = Math.max(1, Math.floor(dh));
  if (tw >= sw && th >= sh) return src.slice();
  const out = new Uint8Array(tw * th * 4);
  for (let dy = 0; dy < th; dy += 1) {
    const y0 = Math.floor((dy * sh) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * sh) / th));
    for (let dx = 0; dx < tw; dx += 1) {
      const x0 = Math.floor((dx * sw) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * sw) / tw));
      // ⚠️ **按 alpha 加权求平均**（预乘再还原）。直接对 RGB 求平均的话，
      // 全透明像素（RGB 是 0）会把半透明边缘拉黑 —— GIF 的透明背景很常见。
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let y = y0; y < y1 && y < sh; y += 1) {
        for (let x = x0; x < x1 && x < sw; x += 1) {
          const at = (y * sw + x) * 4;
          const alpha = src[at + 3];
          r += src[at] * alpha; g += src[at + 1] * alpha; b += src[at + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }
      const o = (dy * tw + dx) * 4;
      if (n === 0) continue;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/**
 * 相邻两帧的差异率：缩到 32×32，逐通道比，差超过阈值的通道占比。
 *
 * 度量方式**刻意与小鲸鱼的 `tools/gif-inspect.py` 保持一致**（同为 32×32、阈值 24），
 * 这样两边的数字能拿来对账（见 `test/gif.test.mjs` 与报告里的交叉验证）。
 *
 * @param {{rgba: Uint8Array, width: number, height: number}} a
 * @param {{rgba: Uint8Array, width: number, height: number}} b
 * @returns {number} 0~1
 */
export function frameDiffRatio(a, b) {
  const sa = resizeRgba(a.rgba, a.width, a.height, DIFF_SAMPLE_SIDE, DIFF_SAMPLE_SIDE);
  const sb = resizeRgba(b.rgba, b.width, b.height, DIFF_SAMPLE_SIDE, DIFF_SAMPLE_SIDE);
  const n = Math.min(sa.length, sb.length);
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(sa[i] - sb[i]) > DIFF_CHANNEL_THRESHOLD) changed += 1;
  }
  return changed / n;
}

/**
 * 从缩略图序列里挑关键帧。
 *
 * **策略**：首帧 + 末帧**固定入选**，其余名额给"变化最大的那些帧的**结果帧**"。
 *
 * - 为什么要固定末帧：笑点通常是变化的**结果**，按"变化大小"排序未必选得中它
 *   （小鲸鱼实测：48 帧的 GIF，第 47 帧才是梗）；
 * - 为什么取 `i + 1`：差异是 `i → i+1` 的，要展示的是"变成什么样了"，
 *   所以选 `i+1`（到达的那一帧）而不是 `i`；
 * - 结果**按帧号排序**，拼图从左到右就是时间顺序（读者不会看反）。
 *
 * @param {Array<{index: number, rgba: Uint8Array, width: number, height: number}>} frames 缩略图序列（顺序即时间）
 * @param {object} [options]
 * @param {number} [options.count]
 * @returns {{indices: number[], diffs: number[]}}
 */
export function selectKeyFrames(frames, { count = DEFAULT_SHEET_FRAMES } = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const n = list.length;
  const want = Math.max(2, Math.min(Number.isFinite(count) && count > 0 ? Math.floor(count) : DEFAULT_SHEET_FRAMES, n));
  const diffs = [];
  for (let i = 0; i + 1 < n; i += 1) diffs.push(frameDiffRatio(list[i], list[i + 1]));
  if (n <= want) return { indices: list.map((_, i) => i), diffs };

  const picked = new Set([0, n - 1]);
  const ranked = diffs
    .map((d, i) => ({ d, at: i + 1 }))
    .sort((a, b) => b.d - a.d);
  for (const item of ranked) {
    if (picked.size >= want) break;
    picked.add(item.at);
  }
  return { indices: [...picked].sort((a, b) => a - b), diffs };
}

/**
 * 横向拼成一张图。
 *
 * @param {Array<{rgba: Uint8Array, width: number, height: number}>} frames 已经缩到目标尺寸的帧
 * @param {object} [options]
 * @param {number} [options.gap]
 * @param {number} [options.background] 0~255 灰度，默认白
 * @returns {{width: number, height: number, rgba: Uint8Array}|null}
 */
export function composeSheet(frames, { gap = SHEET_GAP, background = 255 } = {}) {
  const list = (Array.isArray(frames) ? frames : []).filter((f) => f && f.rgba && f.width > 0 && f.height > 0);
  if (list.length === 0) return null;
  const height = Math.max(...list.map((f) => f.height));
  const width = list.reduce((sum, f) => sum + f.width, 0) + gap * (list.length - 1);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = background;
    rgba[i + 1] = background;
    rgba[i + 2] = background;
    rgba[i + 3] = 255;
  }
  let x = 0;
  for (const frame of list) {
    // 竖直居中：帧高不一致时（理论上不会，画布是统一的）也不至于贴顶
    const y = Math.floor((height - frame.height) / 2);
    for (let row = 0; row < frame.height; row += 1) {
      for (let col = 0; col < frame.width; col += 1) {
        const srcAt = (row * frame.width + col) * 4;
        const dstAt = ((y + row) * width + (x + col)) * 4;
        // ⚠️ **要和背景合成**，不能直接覆盖：GIF 到处是透明区（透明背景、disposal=2 擦过的区域），
        // 直接覆盖的话那些地方会露出 RGBA 里的 0（黑块）。
        const alpha = frame.rgba[srcAt + 3];
        if (alpha === 255) {
          rgba[dstAt] = frame.rgba[srcAt];
          rgba[dstAt + 1] = frame.rgba[srcAt + 1];
          rgba[dstAt + 2] = frame.rgba[srcAt + 2];
        } else if (alpha > 0) {
          const k = alpha / 255;
          rgba[dstAt] = Math.round(frame.rgba[srcAt] * k + background * (1 - k));
          rgba[dstAt + 1] = Math.round(frame.rgba[srcAt + 1] * k + background * (1 - k));
          rgba[dstAt + 2] = Math.round(frame.rgba[srcAt + 2] * k + background * (1 - k));
        }
        // alpha === 0：保留背景色
      }
    }
    x += frame.width + gap;
  }
  return { width, height, rgba };
}

let crcTable = null;

/** CRC32（PNG 每个 chunk 都要）。 */
function crc32(buf) {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 拼一个 PNG chunk。 */
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * RGBA → PNG 字节（8 位真彩 + alpha，无隔行）。
 *
 * 为什么要自己写：不给插件加依赖（用户明确「不许装任何东西」）。
 * PNG 的最小实现就三块 —— IHDR / IDAT（zlib 压缩的原始行）/ IEND —— 用 `node:zlib` 就够。
 *
 * @param {{width: number, height: number, rgba: Uint8Array}} image
 * @returns {Uint8Array}
 */
export function encodePng({ width, height, rgba }) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const dst = y * (width * 4 + 1);
    raw[dst] = 0; // filter type 0（None）
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), dst + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = new Uint8Array(zlib.deflateSync(Buffer.from(raw), { level: 6 }));
  const chunks = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * **一站式**：GIF 原件 → 一张「关键时刻」拼图（PNG 字节）。
 *
 * 失败一律返回 `{ok: false, reason}`，**不抛异常** —— 调用方（描述器）把
 * "拿不到拼图"当成"那就按单帧描述"，绝不能让一张图拖垮一条消息。
 *
 * @param {Uint8Array} bytes 原件字节
 * @param {object} [options]
 * @param {number} [options.maxFrames]
 * @param {number} [options.maxWidth]
 * @param {number} [options.gap]
 * @returns {{ok: boolean, reason?: string, png?: Uint8Array, width?: number, height?: number,
 *            frameCount?: number, picked?: number[], diffs?: number[], avgDiff?: number}}
 */
export function buildGifSheet(bytes, {
  maxFrames = DEFAULT_SHEET_FRAMES,
  maxWidth = SHEET_MAX_WIDTH,
  gap = SHEET_GAP,
} = {}) {
  try {
    const info = parseGifInfo(bytes);
    if (!info.gif) return { ok: false, reason: 'not-gif' };
    if ((info.frameCount ?? 0) <= 1) {
      // **一帧就是静图**。不抽帧、不拼图 —— 也不说它是"动图"（用户点名的那条）。
      // ⚠️ 但"截断了"要和"本来就只有一帧"分开报：前者是文件坏了，
      // 后者是（很常见的）静态 GIF —— 日志里混成一句会让排查走错方向。
      return {
        ok: false,
        reason: info.truncated === true ? 'truncated' : 'single-frame',
        frameCount: info.frameCount ?? 0,
      };
    }
    if ((info.width ?? 0) * (info.height ?? 0) > MAX_CANVAS_PIXELS) {
      return { ok: false, reason: 'too-large' };
    }

    // ── 第一趟：只留缩略图 ──
    const thumbs = [];
    decodeGifFrames(bytes, {
      maxFrames: MAX_SCANNED_FRAMES,
      onFrame: (frame) => {
        thumbs.push({
          index: frame.index,
          width: THUMB_SIDE,
          height: THUMB_SIDE,
          rgba: resizeRgba(frame.rgba, frame.width, frame.height, THUMB_SIDE, THUMB_SIDE),
        });
      },
    });
    if (thumbs.length <= 1) {
      return { ok: false, reason: info.truncated === true ? 'truncated' : 'decode-failed', frameCount: thumbs.length };
    }

    const { indices, diffs } = selectKeyFrames(thumbs, { count: maxFrames });

    // ── 第二趟：只留选中的那几帧，缩到拼图尺寸 ──
    const want = new Set(indices);
    const perFrame = Math.max(
      32,
      Math.min(
        SHEET_MAX_FRAME_WIDTH,
        info.width,
        Math.floor((maxWidth - gap * (indices.length - 1)) / indices.length),
      ),
    );
    const kept = new Map();
    decodeGifFrames(bytes, {
      maxFrames: thumbs.length,
      onFrame: (frame) => {
        if (!want.has(frame.index)) return undefined;
        const height = Math.max(1, Math.round((frame.height * perFrame) / frame.width));
        kept.set(frame.index, {
          width: perFrame,
          height,
          rgba: resizeRgba(frame.rgba, frame.width, frame.height, perFrame, height),
        });
        return kept.size >= want.size ? false : undefined;
      },
    });

    const ordered = indices.map((i) => kept.get(i)).filter(Boolean);
    if (ordered.length === 0) return { ok: false, reason: 'decode-failed' };
    const sheet = composeSheet(ordered, { gap });
    if (sheet === null) return { ok: false, reason: 'compose-failed' };

    const avgDiff = diffs.length > 0 ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;
    return {
      ok: true,
      png: encodePng(sheet),
      width: sheet.width,
      height: sheet.height,
      frameCount: thumbs.length,
      picked: indices,
      diffs,
      avgDiff,
    };
  } catch (error) {
    // 解码器的任何意外都不该冒泡到消息处理路径上
    return { ok: false, reason: `error:${error instanceof Error ? error.message : String(error)}` };
  }
}
