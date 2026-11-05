/**
 * `dsh/gif.mjs`：自己写的 GIF 解码 + 挑关键帧 + 拼图 + PNG 编码。
 *
 * ## 这个文件在钉什么
 *
 * 用户 2026-10-07 的要求是「**动图要真的看得见动态**」—— 而链路上 DSH 会把动图
 * 归一化成**单帧 webp**，所以插件只能自己拿原件、自己解帧。手写解码器**必须**有测试钉住，
 * 否则"某天它开始解出花花绿绿的噪点"这种事没人会发现。
 *
 * 夹具是 **PIL(Pillow) 生成的真实 GIF**（base64 内嵌，见 `fixtures/gif-bytes.mjs`），
 * 而且开发时拿 PIL 逐帧对过 sha256（48 帧的真实 GIF 全部逐字节相同，
 * 唯一差异在全透明像素的 RGB）—— 所以这里钉的期望值是**独立实现给出来的**，不是我自说自话。
 *
 * ## 这些用例在防什么
 *
 * | 用例组 | 防的是 |
 * |---|---|
 * | `parseGifInfo` | 把**单帧 gif** 当成动图（小鲸鱼那个 `img1.gif` 就是 1 帧） |
 * | `decodeGifFrames` | 解码错（颜色/交错/局部帧/透明/截断） |
 * | `selectKeyFrames` | **只按"变化最大"挑帧** → 漏掉笑点那一帧（实测：48 帧的 GIF，第 47 帧才是梗） |
 * | `buildGifSheet` | 一帧也去抽帧；拼图超宽 |
 * | `encodePng` | 拼图存不成 DSH 认得的 PNG（magic/IHDR/zlib 流） |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

import {
  DEFAULT_SHEET_FRAMES,
  SHEET_MAX_WIDTH,
  buildGifSheet,
  composeSheet,
  decodeGifFrames,
  encodePng,
  frameDiffRatio,
  isGif,
  parseGifInfo,
  resizeRgba,
  selectKeyFrames,
} from '../src/dsh/gif.mjs';

import {
  GIF_1FRAME,
  GIF_2FRAMES,
  GIF_6FRAMES,
  GIF_INTERLACE,
  GIF_LARGE,
  GIF_PARTIAL,
  GIF_TRANSPARENT,
  GIF_WIDE,
} from './fixtures/gif-bytes.mjs';

/** base64 → 字节。 */
const raw = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));

/** 解出所有帧。 */
function decodeAll(bytes) {
  const frames = [];
  const info = decodeGifFrames(bytes, { maxFrames: 100000, onFrame: (f) => { frames.push(f); } });
  return { frames, info };
}

/** 取某帧某点的 RGBA。 */
const px = (frame, x, y) => Array.from(frame.rgba.subarray((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4));

// ─────────────────────────────────────────────────────────── 结构解析（不解码）

test('isGif：只看 magic bytes，不看扩展名', () => {
  assert.equal(isGif(raw(GIF_6FRAMES)), true);
  assert.equal(isGif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), false, 'JPEG 不是 GIF');
  assert.equal(isGif(new Uint8Array([0x47, 0x49, 0x46])), false, '太短');
  assert.equal(isGif(null), false, '垃圾输入不能抛');
});

test('★ parseGifInfo：**帧数是文件结构里的事实** —— 单帧 gif 就是静图', () => {
  const six = parseGifInfo(raw(GIF_6FRAMES));
  assert.equal(six.gif, true);
  assert.equal(six.width, 200);
  assert.equal(six.height, 120);
  assert.equal(six.frameCount, 6);
  assert.equal(six.loop, 0, 'loop=0 是无限循环；⚠️ 别把 NETSCAPE 子块里的那个 0x01 当成循环次数');
  assert.equal(six.truncated, false);

  // 小鲸鱼实测的那张：扩展名是 gif、magic 是 GIF87a，但**只有一帧** —— 它不是动图。
  const one = parseGifInfo(raw(GIF_1FRAME));
  assert.equal(one.frameCount, 1);
  assert.equal(one.width, 64);
  assert.equal(one.loop, null, '没有 NETSCAPE 扩展时循环次数应当是"没标注"');
});

test('parseGifInfo：非 GIF / 截断都不抛，且如实标 truncated', () => {
  assert.deepEqual(parseGifInfo(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), { gif: false });

  const cut = raw(GIF_6FRAMES).slice(0, 200);
  const info = parseGifInfo(cut);
  assert.equal(info.gif, true);
  assert.equal(info.truncated, true, '截断要标出来（否则"读到 0 帧"会被误当成"本来就是空的"）');
});

// ─────────────────────────────────────────────────────────── 解码

test('★ decodeGifFrames：六帧纯色，颜色逐帧对得上（PIL 生成、我们解）', () => {
  const { frames, info } = decodeAll(raw(GIF_6FRAMES));
  assert.equal(info.decoded, 6);
  assert.equal(frames.length, 6);
  const expected = [
    [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255],
    [255, 255, 0, 255], [0, 255, 255, 255], [255, 0, 255, 255],
  ];
  frames.forEach((frame, i) => {
    assert.equal(frame.width, 200);
    assert.equal(frame.height, 120);
    assert.deepEqual(px(frame, 0, 0), expected[i], `第 ${i} 帧的左上是 ${expected[i]}`);
    assert.deepEqual(px(frame, 199, 119), expected[i], `第 ${i} 帧的右下也是同一个颜色`);
  });
});

test('★ decodeGifFrames：**局部帧要合成到上一帧上**（不是每帧重新开画布）', () => {
  // 夹具里那个方块每帧向左挪 5px，所以它在文件里是"只覆盖一小块"的帧。
  // 若把局部帧当成整幅图，背景会变成透明/黑 —— 这条用例就是钉这个。
  const { frames } = decodeAll(raw(GIF_PARTIAL));
  assert.equal(frames.length, 5);
  assert.deepEqual(px(frames[0], 80, 80), [200, 30, 30, 255], '第 0 帧：方块在 x=60..100');
  assert.deepEqual(px(frames[0], 58, 80), [240, 240, 240, 255], '第 0 帧：x=58 还在背景上');
  assert.deepEqual(px(frames[1], 58, 80), [200, 70, 30, 255], '第 1 帧：方块挪过来了，x=58 变成方块色');
  assert.deepEqual(px(frames[4], 150, 150), [240, 240, 240, 255], '没被任何帧碰过的地方一直是背景色');
  assert.deepEqual(px(frames[0], 150, 150), [240, 240, 240, 255]);
});

test('★ decodeGifFrames：**隔行**（interlaced）也能解对', () => {
  const { frames } = decodeAll(raw(GIF_INTERLACE));
  assert.equal(frames.length, 4);
  const f1 = frames[1];
  // 隔行存储要跑 4 个 pass；漏掉任何一个 pass 都会让某些行留在上一帧的颜色上。
  // 这里逐行抽查（0/1/2/3/4 分属不同 pass）。
  for (const y of [0, 1, 2, 3, 4, 5, 85, 89]) {
    assert.deepEqual(px(f1, 0, y), [200, 10, 10, 255], `第 1 帧第 ${y} 行应当是纯色`);
  }
  assert.deepEqual(px(f1, 119, 89), [200, 10, 10, 255]);
});

test('decodeGifFrames：透明 + disposal=2 不炸，透明区 alpha=0、实心区颜色对', () => {
  const { frames } = decodeAll(raw(GIF_TRANSPARENT));
  assert.equal(frames.length, 4);
  assert.deepEqual(px(frames[0], 0, 0), [0, 0, 0, 0], '透明背景');
  assert.deepEqual(px(frames[0], 30, 30), [255, 120, 0, 255], '圆是实心的');
  assert.deepEqual(px(frames[3], 95, 95), [0, 0, 0, 0], 'disposal=2 擦过的区域回到透明');
});

test('decodeGifFrames：垃圾输入/非 GIF 一律不抛，返回 ok=false', () => {
  assert.equal(decodeGifFrames(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { onFrame: () => {} }).ok, false);
  const cut = raw(GIF_6FRAMES).slice(0, 120);
  const got = decodeGifFrames(cut, { onFrame: () => {} });
  assert.equal(typeof got.ok, 'boolean', '截断的输入也必须有明确返回值，而不是异常');
});

test('decodeGifFrames：帧数上限生效，且回调返回 false 能提前收工', () => {
  const seen = [];
  const capped = decodeGifFrames(raw(GIF_6FRAMES), { maxFrames: 3, onFrame: (f) => { seen.push(f.index); } });
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(capped.decoded, 3);

  const early = [];
  decodeGifFrames(raw(GIF_6FRAMES), { maxFrames: 99, onFrame: (f) => { early.push(f.index); return f.index < 1 ? undefined : false; } });
  assert.deepEqual(early, [0, 1], '回调返回 false 之后不再解后面的帧（第二趟解码靠它省时间）');
});

// ─────────────────────────────────────────────────────────── 差异率与挑帧

test('frameDiffRatio：同一帧是 0；纯色红→绿这种大变化接近 1', () => {
  const { frames } = decodeAll(raw(GIF_6FRAMES));
  assert.equal(frameDiffRatio(frames[0], frames[0]), 0);
  assert.ok(frameDiffRatio(frames[0], frames[1]) > 0.4, '红→绿应当判成"变了很多"');
  const flat = decodeAll(raw(GIF_LARGE)).frames[0];
  assert.equal(frameDiffRatio(flat, flat), 0);
});

test('★ selectKeyFrames：**末帧固定入选**（笑点是变化的"结果"，光按变化大小排会漏掉它）', () => {
  const { frames } = decodeAll(raw(GIF_6FRAMES));
  const thumbs = frames.map((f, i) => ({ index: i, width: f.width, height: f.height, rgba: f.rgba }));

  for (const count of [2, 3, 4]) {
    const { indices } = selectKeyFrames(thumbs, { count });
    assert.equal(indices.length, count);
    assert.equal(indices.includes(0), true, `count=${count} 时首帧必须在（"从哪开始"）`);
    assert.equal(indices.includes(frames.length - 1), true, `count=${count} 时**末帧必须在**（"到哪结束"，笑点常在这）`);
    assert.deepEqual(indices, [...new Set(indices)].sort((a, b) => a - b), '去重且按时间序（拼图从左到右就是时间顺序）');
  }
});

test('selectKeyFrames：帧数不够时全给；数量非法时退回默认', () => {
  const two = decodeAll(raw(GIF_2FRAMES)).frames;
  const thumbs = two.map((f, i) => ({ index: i, width: f.width, height: f.height, rgba: f.rgba }));
  assert.deepEqual(selectKeyFrames(thumbs, { count: 4 }).indices, [0, 1]);
  assert.equal(selectKeyFrames(thumbs, { count: 0 }).indices.length, 2);
  assert.equal(selectKeyFrames(thumbs, { count: 99 }).indices.length, 2);
  // 默认值 = 报告里说明过的那个（4 帧：首 + 末 + 2 个最大变化）
  assert.equal(DEFAULT_SHEET_FRAMES, 4);
});

// ─────────────────────────────────────────────────────────── 缩放与拼图

test('resizeRgba：**不放大**；缩小时按 alpha 加权平均（透明像素不能把颜色拉黑）', () => {
  const src = new Uint8Array([10, 20, 30, 255]);
  assert.deepEqual(Array.from(resizeRgba(src, 1, 1, 4, 4)), [10, 20, 30, 255], '目标比源大时原样返回（不放大）');

  // 两个像素：一个不透明的红，一个全透明（RGB 是 0）。加权平均后应当还是红，不是暗红。
  const two = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]);
  const one = resizeRgba(two, 2, 1, 1, 1);
  assert.deepEqual(Array.from(one), [255, 0, 0, 128], '半透明但颜色保持红（不透明那个像素的颜色）');
});

test('composeSheet：横向拼接 + 留缝 + 透明处用背景色合成', () => {
  const sheet = composeSheet([
    { width: 2, height: 1, rgba: new Uint8Array([10, 10, 10, 255, 20, 20, 20, 255]) },
    { width: 1, height: 1, rgba: new Uint8Array([30, 30, 30, 255]) },
  ], { gap: 1, background: 255 });
  assert.equal(sheet.width, 4);
  assert.equal(sheet.height, 1);
  assert.deepEqual(Array.from(sheet.rgba.subarray(0, 8)), [10, 10, 10, 255, 20, 20, 20, 255]);
  assert.deepEqual(Array.from(sheet.rgba.subarray(8, 12)), [255, 255, 255, 255], '缝是背景色');
  assert.deepEqual(Array.from(sheet.rgba.subarray(12, 16)), [30, 30, 30, 255]);

  // 全透明像素 → 背景色（不是黑块）
  const blended = composeSheet([{ width: 1, height: 1, rgba: new Uint8Array([0, 0, 0, 0]) }], { background: 255 });
  assert.deepEqual(Array.from(blended.rgba), [255, 255, 255, 255]);

  assert.equal(composeSheet([]), null, '空输入返回 null，不抛');
});

// ─────────────────────────────────────────────────────────── PNG 编码

test('★ encodePng：magic / IHDR / zlib 流都正确（不然 DSH 存不进附件）', () => {
  const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const png = encodePng({ width: 2, height: 2, rgba });

  assert.deepEqual(Array.from(png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR 紧跟在 magic 之后：长度 13、类型 IHDR
  assert.equal(String.fromCharCode(...png.subarray(12, 16)), 'IHDR');
  const view = new DataView(png.buffer, png.byteOffset);
  assert.equal(view.getUint32(16), 2, '宽');
  assert.equal(view.getUint32(20), 2, '高');
  assert.equal(png[24], 8, '位深 8');
  assert.equal(png[25], 6, '颜色类型 6 = RGBA');
  assert.equal(png[28], 0, '非隔行');
  assert.equal(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4)), 'IEND');

  // 把 IDAT 解出来，逐字节对回原始扫描行（每行前面一个 filter=0）
  let at = 8;
  let idat = null;
  while (at < png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === 'IDAT') idat = png.subarray(at + 8, at + 8 + len);
    at += 12 + len;
  }
  assert.ok(idat !== null, '必须有一个 IDAT');
  const rows = new Uint8Array(inflateSync(Buffer.from(idat)));
  assert.deepEqual(Array.from(rows), [0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 9, 10, 11, 12, 13, 14, 15, 16]);
});

// ─────────────────────────────────────────────────────────── 一站式

test('★ buildGifSheet：**单帧 gif 直接不肯抽帧**（用户点名的那条：不许说它在动）', () => {
  const got = buildGifSheet(raw(GIF_1FRAME));
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'single-frame');
  assert.equal(got.frameCount, 1);
});

test('★ buildGifSheet：六帧 → 一张 PNG，首末帧都在，尺寸符合预期', () => {
  const got = buildGifSheet(raw(GIF_6FRAMES), { maxFrames: 4 });
  assert.equal(got.ok, true);
  assert.equal(got.frameCount, 6);
  assert.equal(got.picked.length, 4);
  assert.equal(got.picked.includes(0), true);
  assert.equal(got.picked.includes(5), true, '末帧必须在（笑点常在这）');
  // 200px × 4 帧 + 3 个 8px 缝
  assert.equal(got.width, 200 * 4 + 8 * 3);
  assert.equal(got.height, 120);
  assert.deepEqual(Array.from(got.png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(got.avgDiff > 0, '应当算出平均差异率（进日志，便于事后看"这张到底动没动"）');
});

test('buildGifSheet：**宽图必须把每帧缩小**，总宽不能超上限', () => {
  const got = buildGifSheet(raw(GIF_WIDE), { maxFrames: 4 });
  assert.equal(got.ok, true);
  // 源 600×200，4 帧。若按原尺寸拼 = 2424 宽 → 会被下游再压一次、细节全糊。
  assert.ok(got.width <= SHEET_MAX_WIDTH, `总宽 ${got.width} 不该超过 ${SHEET_MAX_WIDTH}`);
  assert.equal(got.width, SHEET_MAX_WIDTH, '刚好顶到上限（4 × 344 + 3 × 8）');
  assert.ok(got.height < 200, '每帧等比缩小');
});

test('buildGifSheet：大画布正常；非 GIF / 截断**不抛**，只返回失败原因', () => {
  const large = buildGifSheet(raw(GIF_LARGE), { maxFrames: 4 });
  assert.equal(large.ok, true);
  assert.equal(large.frameCount, 3);
  assert.deepEqual(large.picked, [0, 1, 2], '只有 3 帧时全给');

  assert.deepEqual(buildGifSheet(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), { ok: false, reason: 'not-gif' });

  const cut = buildGifSheet(raw(GIF_6FRAMES).slice(0, 150));
  assert.equal(cut.ok, false);
  assert.equal(cut.reason, 'truncated', '截断要报 truncated，不要和"本来就是单帧"混起来');
});
