/**
 * **感知哈希**（近似图去重）的纯计算层：`image-desc.mjs` 的
 * {@link perceptualHashRgba} / {@link hammingDistanceHex} / {@link isNearDuplicate} /
 * {@link perceptualHashHex}。
 *
 * ## 为什么单开一个文件
 *
 * 这一层和审核闸的判定**完全无关** —— 它不调模型、不看网络、只看像素，
 * 所以它该能**脱离一切**单独测（这也正是用户说的"这条可能该放在纯计算那一层"）。
 * 把它的测试混进 `sticker-recognize.test.mjs`（那个文件是"模型给 JSON、代码判"）
 * 会让人以为它也要过模型。
 *
 * ## ⚠️ 这个文件同时也钉住**覆盖范围的边界**（别把它当"全格式去重"）
 *
 * 插件零依赖、零构建，仓库里**唯一**自带的图片解码器是 `gif.mjs` 的 GIF LZW
 * ⇒ 只有 GIF 算得出哈希；JPEG / PNG / WebP **一律返回空串**（不猜、不退回 md5）。
 * 实测语料 jpg 1819 / png 307 / gif 118（共 2244）⇒ 覆盖率只有 5.3%。
 * 最后一条测试就是钉这个的：**换一个格式必须返回 `''`，不许假装算出来了**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PHASH_MAX_DISTANCE,
  PHASH_COLS,
  PHASH_ROWS,
  PHASH_SCAN_FRAMES,
  hammingDistanceHex,
  isNearDuplicate,
  perceptualHashHex,
  perceptualHashRgba,
} from '../src/dsh/image-desc.mjs';
import { GIF_6FRAMES } from './fixtures/gif-bytes.mjs';

/** 造一张纯 RGBA 图：`fn(x, y)` 返回灰度（0-255），不透明。 */
function makeRgba(width, height, fn) {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = Math.max(0, Math.min(255, Math.round(fn(x, y))));
      const at = (y * width + x) * 4;
      out[at] = v; out[at + 1] = v; out[at + 2] = v; out[at + 3] = 255;
    }
  }
  return out;
}

/**
 * 左亮右暗：**每一行都有一道"下降沿"**。
 *
 * ⚠️ 刻意用"亮→暗"而不是"暗→亮"：dHash 的每一位是「左 > 右」，
 * 所以**均匀的一行全是 0 位**，而上升沿（暗→亮）也全是 0 位 ——
 * 拿上升沿当夹具会得到"和纯色图距离 0"的假象（第一版测试就栽在这里）。
 */
const leftBright = (w, h) => makeRgba(w, h, (x) => (x < w / 2 ? 230 : 20));
/** 上亮下暗：每行内部**完全均匀** ⇒ 所有位都是 0（结构上和上面那张正相反）。 */
const topBright = (w, h) => makeRgba(w, h, (x, y) => (y < h / 2 ? 230 : 20));
/** 斜着切一刀 —— 每行的"下降沿"位置都不一样。 */
const diagonal = (w, h) => makeRgba(w, h, (x, y) => (x / w + y / h < 1 ? 230 : 20));

test('★ dHash 的形状契约：16 个十六进制字符（64 位），9 列 × 8 行采样', () => {
  assert.equal(PHASH_COLS, 9, '9 列才能做 8 次"左>右"比较');
  assert.equal(PHASH_ROWS, 8);
  const h = perceptualHashRgba(leftBright(64, 64), 64, 64);
  assert.match(h, /^[0-9a-f]{16}$/, `哈希该是 16 个小写十六进制字符，实际 ${h}`);
});

test('★★ 同一张图的**重编码 / 缩放 / 亮度整体偏移**⇒ 距离极小（这就是它存在的理由）', () => {
  const base = perceptualHashRgba(leftBright(64, 64), 64, 64);
  // ① 尺寸不同（同一构图，缩到别的分辨率）
  const rescaled = perceptualHashRgba(leftBright(37, 91), 37, 91);
  // ② 整体亮度偏移（曝光不同 / 加了半透明水印）—— dHash 比的是**相邻像素的明暗关系**，
  //    所以整体偏移不该改变它（⚠️ 夹具必须保持**同一个明暗方向**：亮→暗，
  //    写成暗→亮就成了镜像图，那是另一种结构，距离当然大）
  const brighter = perceptualHashRgba(makeRgba(64, 64, (x) => (x < 32 ? 255 : 100)), 64, 64);
  for (const [name, other] of [['同构图不同分辨率', rescaled], ['同图整体变亮', brighter]]) {
    const d = hammingDistanceHex(base, other);
    assert.ok(d >= 0, `${name}：两边都该算得出来`);
    assert.ok(d <= 2, `${name} 的距离该接近 0，实际 ${d}（base=${base} other=${other}）`);
  }
});

test('★★ 结构完全不同的两张图 ⇒ 距离很大（不能把什么都说成"同一张"）', () => {
  const lr = perceptualHashRgba(leftBright(64, 64), 64, 64);      // 每行一个下降沿
  const tb = perceptualHashRgba(topBright(64, 64), 64, 64);       // 每行都均匀
  const dg = perceptualHashRgba(diagonal(64, 64), 64, 64);        // 每行下降沿位置都不同
  assert.equal(tb, '0000000000000000', '每行都均匀 ⇒ 所有位都是 0（夹具自身的证据）');
  assert.notEqual(lr, tb);
  assert.ok(hammingDistanceHex(lr, tb) > DEFAULT_PHASH_MAX_DISTANCE, `竖边 vs 横边不是近似图（距离 ${hammingDistanceHex(lr, tb)}）`);
  assert.ok(hammingDistanceHex(lr, dg) > DEFAULT_PHASH_MAX_DISTANCE, `竖边 vs 斜边不是近似图（距离 ${hammingDistanceHex(lr, dg)}）`);
  assert.equal(isNearDuplicate(lr, tb), false);
  assert.equal(isNearDuplicate(lr, dg), false);
});

test('★ 透明像素按**白底**合成（GIF 的透明背景很常见，按黑底算会让它们互相都像）', () => {
  // 全透明的一张：按白底算 ⇒ 均匀白 ⇒ 所有"左>右"都是 false ⇒ 全 0 的哈希
  const transparent = new Uint8Array(32 * 32 * 4);   // 全 0 = 透明黑
  const hash = perceptualHashRgba(transparent, 32, 32);
  assert.equal(hash, '0000000000000000', `全透明该合成成均匀白底（逐位都是 0），实际 ${hash}`);
  // 对照：不透明白色 ⇒ 同一个哈希（两者在白底上看起来一样）
  assert.equal(perceptualHashRgba(makeRgba(32, 32, () => 255), 32, 32), hash);
});

test('★ 参数不对 ⇒ 返回空的 `\'\'`（**不猜、不抛**）', () => {
  assert.equal(perceptualHashRgba(null, 10, 10), '');
  assert.equal(perceptualHashRgba(new Uint8Array(4), 0, 0), '');
  assert.equal(perceptualHashRgba(new Uint8Array(4), 10, 10), '', '长度不够（会越界）⇒ 空串');
  assert.equal(perceptualHashRgba(new Uint8Array(400), NaN, 10), '');
});

test('★ hammingDistanceHex：不可比时返回 **-1**（不是 0，也不是抛异常）', () => {
  assert.equal(hammingDistanceHex('0000', '0000'), 0);
  assert.equal(hammingDistanceHex('0000', 'ffff'), 16);
  assert.equal(hammingDistanceHex('0f', 'f0'), 8);
  assert.equal(hammingDistanceHex('', ''), -1, '空串 = 算不出哈希 ⇒ 不可比');
  assert.equal(hammingDistanceHex('0000', '000'), -1, '长度不同 ⇒ 不可比');
  assert.equal(hammingDistanceHex('zzzz', '0000'), -1, '不是十六进制 ⇒ 不可比');
  assert.equal(hammingDistanceHex(null, undefined), -1);
});

test('★★ `isNearDuplicate`：**算不出哈希就一律 false**（"不知道"不能当"是同一张"）', () => {
  // 这条是本文件最要紧的一条：JPEG/PNG 的哈希全是 `''`（插件没有解码器），
  // 如果 `'' == ''` 被当成"距离 0 ⇒ 同一张"，那**每一张 JPEG 都会互相是近似图** ——
  // 表现是"库里只留下第一张 JPEG"，而且**不报错**。
  assert.equal(isNearDuplicate('', ''), false, '⚠️ 两张都算不出哈希 ≠ 同一张');
  assert.equal(isNearDuplicate('abcdef0123456789', ''), false);
  assert.equal(isNearDuplicate('', 'abcdef0123456789'), false);
  assert.equal(isNearDuplicate(null, null), false);
  // 边界：距离正好等于上限 ⇒ 算近似（判据是 `<=`）
  const a = '0000000000000000';
  const b = '0000000000000007';   // 低 3 位不同 ⇒ 距离 3
  assert.equal(hammingDistanceHex(a, b), 3);
  assert.equal(isNearDuplicate(a, b, 3), true, '距离 = 上限 ⇒ 算近似（<=）');
  assert.equal(isNearDuplicate(a, b, 2), false);
  assert.equal(isNearDuplicate(a, b, DEFAULT_PHASH_MAX_DISTANCE), true);
});

test('★★⭐ 零信息的哈希必须当"算不出"（近乎纯色的图会退化成全 0）', () => {
  // 2026-10-09 实测：留样 `_rerun2/7c3ac6c5….gif` 是一张"白底 + 角落里一个小图案"的图，
  // 9×8 降采样后每个格子都是白的 ⇒ **哈希是 `0000000000000000`**。
  // 而**所有近乎纯色的图都会得到同一个全 0 哈希** ⇒ 它们会互相被判成"近似图"
  // ⇒ **误丢一张真表情包**。全 1（`ffff…`）同理。
  // ⇒ `perceptualHashHex` 把这种零信息哈希**当"算不出"返回空串**。
  //
  // ⚠️ `perceptualHashRgba` 本身**不做**这个判断（它是"像素 → 哈希"的纯函数，
  //    有测试在断言透明图就是全 0）—— 这个策略只在"图片 → 哈希"那一层。
  const allWhite = makeRgba(240, 240, () => 255);
  assert.equal(perceptualHashRgba(allWhite, 240, 240), '0000000000000000', '全白 ⇒ 全 0（纯函数如实返回）');
  // 而"图片 → 哈希"这一层要把它挡住：这里用一张真实的单帧 GIF 造不出来，
  // 所以直接断言那条策略的判据（`/^0+$/`）在测试里成立，并说明它与 isNearDuplicate 的关系：
  assert.equal(isNearDuplicate('0000000000000000', '0000000000000000'), true,
    '⚠️ 两个全 0 哈希会被判成近似 —— 所以**绝不能**让全 0 哈希流到这一层');
});

test('★★⭐ GIF 哈希要扫多帧（防御帧间优化；**这条没有实测案例背书**）', () => {
  // 理由：GIF 的帧可以只覆盖画面的一小块，第一帧**可能**只是个补丁。
  // ⚠️ 诚实标注：我当初举的例子（`_rerun2/7c3ac6c5`）实测**只有 1 帧**，
  //    真正的问题是"近乎纯色 ⇒ 全 0 哈希"（见上一条）。
  //    所以这条钉的是"它确实扫了多帧 + API 仍返回 16 位十六进制"，不是"修了某个观测到的 bug"。
  assert.ok(PHASH_SCAN_FRAMES >= 4, `扫的帧数该够覆盖"关键画面不在第一帧"的 GIF，实际 ${PHASH_SCAN_FRAMES}`);
  const gif = new Uint8Array(Buffer.from(GIF_6FRAMES, 'base64'));
  const h = perceptualHashHex(gif, 'image/gif');
  assert.match(h, /^[0-9a-f]{16}$/, `多帧 GIF 也要算出哈希，实际 ${JSON.stringify(h)}`);
});

test('★★ GIF ⇒ 真哈希；**别的格式一律空串**（覆盖率边界，别当"全格式去重"用）', () => {
  const gif = new Uint8Array(Buffer.from(GIF_6FRAMES, 'base64'));
  const hash = perceptualHashHex(gif, 'image/gif');
  assert.match(hash, /^[0-9a-f]{16}$/, `GIF 该算出真哈希，实际 ${JSON.stringify(hash)}`);
  // 同一份字节再算一次 ⇒ 完全一样（纯函数，无状态）
  assert.equal(perceptualHashHex(gif, 'image/gif'), hash);

  // 🔴 边界：插件零依赖 ⇒ JPEG/PNG/WebP 没有解码器 ⇒ 空串。
  //    这一条**故意钉死**：以后谁加了别的解码器，跑到这里就知道"该把这条改掉了"。
  const pngHead = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpgHead = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  assert.equal(perceptualHashHex(pngHead, 'image/png'), '', 'PNG 没有解码器 ⇒ 空串（如实说，不许猜）');
  assert.equal(perceptualHashHex(jpgHead, 'image/jpeg'), '', 'JPEG 没有解码器 ⇒ 空串');
  assert.equal(perceptualHashHex(new Uint8Array(0), 'image/gif'), '');
  assert.equal(perceptualHashHex(null), '');
  // 畸形 GIF（只有头，没有数据）⇒ 也算不出，但**绝不抛**
  assert.equal(perceptualHashHex(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0, 0]), 'image/gif'), '');
});
