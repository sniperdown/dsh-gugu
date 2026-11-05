/**
 * 识图模块测试。重点不是"能不能成功",而是**失败时会不会连累文字**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_FILE_EXTENSIONS,
  MAX_IMAGES_PER_MESSAGE,
  collectImageSegments,
  fetchImageBytes,
  fileIdFromSegment,
  isFileIdShaped,
  isImageFileSegment,
  localPathFromSegment,
  resolveDimensionLimit,
  sniffImageMediaType,
  sourceFormatOf,
  summarizeFileSegment,
  toImageBlocks,
  toImageBlocksDetailed,
} from '../src/dsh/media.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 几个真实的文件头
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 1, 2, 3, 4]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 1, 2, 3,
]);

test('sniffImageMediaType：靠字节判断，不靠扩展名', () => {
  assert.equal(sniffImageMediaType(PNG), 'image/png');
  assert.equal(sniffImageMediaType(JPEG), 'image/jpeg');
  assert.equal(sniffImageMediaType(GIF), 'image/gif');
  assert.equal(sniffImageMediaType(WEBP), 'image/webp');
  // 认不出的（比如文本、或太短）
  assert.equal(sniffImageMediaType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);
  assert.equal(sniffImageMediaType(new Uint8Array([1, 2, 3])), null);
  assert.equal(sniffImageMediaType(null), null);
});

test('collectImageSegments：只挑图，且有条数上限', () => {
  const segs = [
    { type: 'text', text: '看这个' },
    { type: 'image', url: 'http://a/1.png' },
    { type: 'at', qq: '1' },
    { type: 'image', url: 'http://a/2.png' },
  ];
  assert.equal(collectImageSegments(segs).length, 2);
  assert.equal(collectImageSegments(null).length, 0);

  // 刷 20 张也要被截断 —— 防止有人拿图把上下文和钱包撑爆
  const many = Array.from({ length: 20 }, (_, i) => ({ type: 'image', url: `http://a/${i}.png` }));
  assert.equal(collectImageSegments(many).length, MAX_IMAGES_PER_MESSAGE);
});

test('fetchImageBytes：base64 不走网络', async () => {
  const seg = { type: 'image', file: `base64://${Buffer.from(PNG).toString('base64')}` };
  let called = false;
  const got = await fetchImageBytes(seg, {
    fetchImpl: async () => { called = true; throw new Error('不该走网络'); },
  });
  assert.ok(got !== null);
  assert.equal(got.data.length, PNG.length);
  assert.equal(called, false, 'base64 应该完全不联网');
});

test('fetchImageBytes：url 走网络；失败返回 null 而不抛', async () => {
  const okFetch = async () => ({ ok: true, arrayBuffer: async () => PNG.buffer });
  const got = await fetchImageBytes({ type: 'image', url: 'http://a/x.png' }, { fetchImpl: okFetch });
  assert.ok(got !== null);

  const badFetch = async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) });
  assert.equal(await fetchImageBytes({ type: 'image', url: 'http://a/x.png' }, { fetchImpl: badFetch }), null);

  const throwFetch = async () => { throw new Error('网络炸了'); };
  assert.equal(await fetchImageBytes({ type: 'image', url: 'http://a/x.png' }, { fetchImpl: throwFetch }), null);

  // 没有可用来源
  assert.equal(await fetchImageBytes({ type: 'image' }, { fetchImpl: okFetch }), null);
});

test('toImageBlocks：正常路径 —— 下载 → 附件 → image block', async () => {
  const saved = [];
  const attachments = {
    async saveImage({ data, mediaType, name }) {
      saved.push({ bytes: data.length, mediaType, name });
      return { attachmentId: 'att-1', mediaType, bytes: data.length, width: 1, height: 1 };
    },
  };
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => PNG.buffer });
  const blocks = await toImageBlocks({
    attachments,
    segments: [{ type: 'image', url: 'http://a/x.png', file: 'x.png' }],
    fetchImpl,
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].attachment.attachmentId, 'att-1');
  assert.equal(saved[0].mediaType, 'image/png');
});

test('toImageBlocks：没有附件服务 → 空数组（插件照样能跑）', async () => {
  assert.deepEqual(
    await toImageBlocks({ attachments: null, segments: [{ type: 'image', url: 'http://a/x.png' }] }),
    [],
  );
  assert.deepEqual(
    await toImageBlocks({ attachments: {}, segments: [{ type: 'image', url: 'http://a/x.png' }] }),
    [],
  );
});

test('toImageBlocks：图片失败只跳过它，不抛给调用方（文字必须照常）', async () => {
  const logs = [];
  const attachments = {
    async saveImage() { throw new Error('DSH 拒收：尺寸超限'); },
  };

  // ① 下载失败
  let blocks = await toImageBlocks({
    attachments,
    segments: [{ type: 'image', url: 'http://a/x.png' }],
    fetchImpl: async () => { throw new Error('timeout'); },
    log: (l, m, meta) => logs.push(m),
  });
  assert.deepEqual(blocks, [], '下载失败 → 空，但不抛');

  // ② 格式认不出
  blocks = await toImageBlocks({
    attachments,
    segments: [{ type: 'image', url: 'http://a/x.png' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer }),
    log: () => {},
  });
  assert.deepEqual(blocks, [], '格式认不出 → 空，但不抛');

  // ③ 附件服务拒收（尺寸超限之类）
  blocks = await toImageBlocks({
    attachments,
    segments: [{ type: 'image', url: 'http://a/x.png' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => PNG.buffer }),
    log: () => {},
  });
  assert.deepEqual(blocks, [], '附件拒收 → 空，但不抛');

  assert.ok(logs.length > 0, '失败要留日志，别静默吞掉');
});

test('toImageBlocks：多张图里坏一张，好的那几张照样用', async () => {
  const attachments = {
    async saveImage({ mediaType }) { return { attachmentId: 'ok', mediaType, bytes: 1, width: 1, height: 1 }; },
  };
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 2) throw new Error('第二张挂了');
    return { ok: true, arrayBuffer: async () => PNG.buffer };
  };
  const blocks = await toImageBlocks({
    attachments,
    segments: [
      { type: 'image', url: 'http://a/1.png' },
      { type: 'image', url: 'http://a/2.png' },
      { type: 'image', url: 'http://a/3.png' },
    ],
    fetchImpl,
    log: () => {},
  });
  assert.equal(blocks.length, 2, '坏的跳过，好的两张留下');
});

// ─────────────────────────────────────────── 本机路径（2026-10-07 补）

test('localPathFromSegment：认盘符 / UNC / file://，不认 http 与普通名字', () => {
  assert.equal(localPathFromSegment({ url: 'D:\\QQNT\\data\\x\\a.mp4' }), 'D:\\QQNT\\data\\x\\a.mp4');
  assert.equal(localPathFromSegment({ url: 'D:/QQNT/data/x/a.mp4' }), 'D:/QQNT/data/x/a.mp4');
  assert.equal(localPathFromSegment({ file: '\\\\server\\share\\a.png' }), '\\\\server\\share\\a.png');
  assert.equal(localPathFromSegment({ file: 'file:///D:/QQNT/a.png' }), path.normalize('D:\\QQNT\\a.png'));
  assert.equal(localPathFromSegment({ url: 'https://multimedia.nt.qq.com.cn/download?x=1' }), null);
  assert.equal(localPathFromSegment({ file: 'a.png' }), null);
  assert.equal(localPathFromSegment({}), null);
  // NapCat 的 &amp; 转义也要先还原
  assert.equal(localPathFromSegment({ url: 'D:\\a&amp;b\\c.png' }), 'D:\\a&b\\c.png');
});

test('★ fetchImageBytes：段里给的是**本机路径**时直接读盘，不联网', async () => {
  // 实测背景：NapCat 给某些段的 `url` 就是本机绝对路径（视频段见过真实样本）。
  // 原实现只认 http(s)，于是"本机就有的文件"反被当成下载失败跳过了。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqmedia-'));
  const file = path.join(dir, 'local.png');
  fs.writeFileSync(file, Buffer.from(PNG));

  let called = false;
  const got = await fetchImageBytes({ url: file }, {
    fetchImpl: async () => { called = true; throw new Error('不该走网络'); },
  });
  assert.ok(got !== null);
  assert.equal(got.data.length, PNG.length);
  assert.equal(got.name, 'local.png');
  assert.equal(called, false, '本机有原件就不该联网');

  // 路径不存在 → 回落到 URL 那条路（段里的路径可能来自另一台机器）
  const fetched = await fetchImageBytes({ url: path.join(dir, 'missing.png') });
  assert.equal(fetched, null, '本机没有、也不是 http → null（不抛）');
});

test('sourceFormatOf：只标"可能藏住动态"的两种容器，其余不标', () => {
  // 用户 2026-10-07：「只能标『源 gif』，绝不能标『这是动图』」
  assert.equal(sourceFormatOf('image/gif'), 'gif');
  assert.equal(sourceFormatOf('image/webp'), 'webp');
  assert.equal(sourceFormatOf('image/png'), '', 'png 是静态格式，标出来是噪音');
  assert.equal(sourceFormatOf('image/jpeg'), '');
  assert.equal(sourceFormatOf(''), '');
  assert.equal(sourceFormatOf(undefined), '');
});

// ─────────────────────────────────── 入站长图自动切分（2026-10-22）

/** 一张"结构上合法"的 PNG（只要够 24 字节 + IHDR，`imageInfo` 就能读出真实宽高）。 */
function pngOf(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** 记录每次 `saveImage` 的入参，并假装成功。 */
function makeStore(limits) {
  const saved = [];
  return {
    saved,
    store: {
      ...(limits === undefined ? {} : { imageLimits: limits }),
      async saveImage({ data, mediaType, name }) {
        saved.push({ bytes: data.length, mediaType, name });
        return { attachmentId: `att-${saved.length}`, mediaType, bytes: data.length, width: 1, height: 1 };
      },
    },
  };
}

test('★ 长图（960×10793）：任一边 > 8192 ⇒ 切段入库，**所有切片**都进 blocks，并附一句说明', async () => {
  const { saved, store } = makeStore({ maxImageDimension: 8192 });
  const calls = [];
  const splitImpl = async (input) => {
    calls.push(input);
    return {
      ok: true,
      images: input.segments.map((segment, i) => ({
        index: i + 1,
        data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
        name: `qq-image-${i + 1}.jpg`,
        width: segment.width,
        height: segment.height,
        bytes: 4,
      })),
    };
  };

  const outcome = await toImageBlocksDetailed({
    attachments: store,
    segments: [{ type: 'image', url: 'http://a/long.png' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(960, 10793).buffer }),
    splitImpl,
    log: () => {},
  });

  assert.equal(calls.length, 1, '必须真的尝试切图');
  assert.equal(calls[0].segments.length, 2, '960×10793 ⇒ 2 段');
  assert.deepEqual(calls[0].segments.map((s) => s.height), [5937, 5937]);
  assert.equal(outcome.blocks.length, 2, '⚠️ 所有切片都要喂给模型（不是只喂第一张）');
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map((s) => s.mediaType), ['image/jpeg', 'image/jpeg'], '切片一律 JPG');
  assert.equal(outcome.notes.length, 1);
  assert.match(outcome.notes[0], /1\/2/);
  assert.match(outcome.notes[0], /2\/2/);
  assert.match(outcome.notes[0], /重叠/);
  assert.match(outcome.notes[0], /拼起来/);
});

test('★ 切图失败 ⇒ 退回原图 + 记 warn（绝不因为切图把消息弄丢）', async () => {
  const { saved, store } = makeStore();
  const logs = [];
  const outcome = await toImageBlocksDetailed({
    attachments: store,
    segments: [{ type: 'image', url: 'http://a/long.png' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(960, 10793).buffer }),
    splitImpl: async () => ({ ok: false, error: 'PowerShell 退出码 1' }),
    log: (level, message) => logs.push({ level, message }),
  });

  assert.equal(outcome.blocks.length, 1, '原图还是要交给附件管线（能进就进）');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mediaType, 'image/png', '退回的是**原图**，不是切片');
  assert.deepEqual(outcome.notes, [], '没切成就不该有"拼起来看"的说明');
  const warn = logs.find((l) => l.level === 'warn');
  assert.ok(warn !== undefined, '切图失败必须留 warn —— 否则线上只会看到"图又没了"');
  assert.match(warn.message, /切分失败/);
});

test('切图抛异常 / 长短张数对不上 ⇒ 同样退回原图（不抛）', async () => {
  for (const splitImpl of [
    async () => { throw new Error('spawn 炸了'); },
    async () => ({ ok: true, images: [{ index: 1, data: new Uint8Array([1, 2]), name: 'a', width: 1, height: 1 }] }), // 少了第二张
  ]) {
    const { saved, store } = makeStore();
    const outcome = await toImageBlocksDetailed({
      attachments: store,
      segments: [{ type: 'image', url: 'http://a/long.png' }],
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(960, 10793).buffer }),
      splitImpl,
      log: () => {},
    });
    assert.equal(outcome.blocks.length, 1);
    assert.equal(saved[0].mediaType, 'image/png');
    assert.deepEqual(outcome.notes, []);
  }
});

test('小图 / 尺寸读不出来 ⇒ 不碰切图（老行为一个字都不变）', async () => {
  let called = 0;
  for (const bytes of [pngOf(800, 600), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3])]) {
    const { saved, store } = makeStore();
    const outcome = await toImageBlocksDetailed({
      attachments: store,
      segments: [{ type: 'image', url: 'http://a/small.png' }],
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }),
      splitImpl: async () => { called += 1; throw new Error('不该被调用'); },
      log: () => {},
    });
    assert.equal(outcome.blocks.length, 1);
    assert.equal(saved.length, 1);
    assert.deepEqual(outcome.notes, []);
  }
  assert.equal(called, 0, '小图不该触发切图');
});

test('★ 上限读宿主附件服务（imageLimits.maxImageDimension），读不到才退 8192', async () => {
  assert.equal(resolveDimensionLimit({ imageLimits: { maxImageDimension: 4096 } }), 4096);
  assert.equal(resolveDimensionLimit({ imageLimits: { maxImageDimension: 0 } }), 8192);
  assert.equal(resolveDimensionLimit({ imageLimits: {} }), 8192);
  assert.equal(resolveDimensionLimit({}), 8192);
  assert.equal(resolveDimensionLimit(null), 8192);

  // 上限 4096 时，4000×100 也该被切（不是"只有超过 8192 才切"）
  let plan = null;
  const { store } = makeStore({ maxImageDimension: 4096 });
  await toImageBlocksDetailed({
    attachments: store,
    segments: [{ type: 'image', url: 'http://a/wide.png' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(4000, 100).buffer }),
    splitImpl: async (input) => { plan = input; return { ok: false, error: '不行' }; },
    log: () => {},
  });
  assert.equal(plan, null, '4000 < 4096 ⇒ 不该切');

  const { store: store2 } = makeStore({ maxImageDimension: 2048 });
  await toImageBlocksDetailed({
    attachments: store2,
    segments: [{ type: 'image', url: 'http://a/wide.png' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(4000, 100).buffer }),
    splitImpl: async (input) => { plan = input; return { ok: false, error: '不行' }; },
    log: () => {},
  });
  assert.ok(plan !== null, '4000 > 2048 ⇒ 必须切');
  assert.ok(plan.segments.length >= 2);
});

test('切不动（段数到上限仍超限）⇒ 退回原图，不输出一批仍然超限的图', async () => {
  const { saved, store } = makeStore();
  const logs = [];
  const outcome = await toImageBlocksDetailed({
    attachments: store,
    segments: [{ type: 'image', url: 'http://a/absurd.png' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(100, 200000).buffer }),
    splitImpl: async () => { throw new Error('不该被调用'); },
    log: (level, message) => logs.push({ level, message }),
  });
  assert.equal(outcome.blocks.length, 1);
  assert.equal(saved.length, 1);
  assert.ok(logs.some((l) => l.level === 'warn' && l.message.includes('切不动')));
});

test('切片入库中途失败 ⇒ 也退回原图（不留半套切片）', async () => {
  const saved = [];
  let n = 0;
  const store = {
    async saveImage({ data, mediaType, name }) {
      n += 1;
      saved.push({ mediaType, name });
      if (n === 2) throw new Error('DSH 拒收第二张');
      return { attachmentId: `att-${n}`, mediaType, bytes: data.length, width: 1, height: 1 };
    },
  };
  const logs = [];
  const outcome = await toImageBlocksDetailed({
    attachments: store,
    segments: [{ type: 'image', url: 'http://a/long.png' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(960, 10793).buffer }),
    splitImpl: async (input) => ({
      ok: true,
      images: input.segments.map((s, i) => ({ index: i + 1, data: new Uint8Array([1]), name: `x-${i + 1}.jpg`, width: s.width, height: s.height, bytes: 1 })),
    }),
    log: (level, message) => logs.push({ level, message }),
  });

  assert.equal(outcome.blocks.length, 1, '半套切片不能交给模型');
  assert.equal(saved[saved.length - 1].mediaType, 'image/png', '最后存进去的是原图');
  assert.deepEqual(outcome.notes, []);
  assert.ok(logs.some((l) => l.level === 'warn' && l.message.includes('切片入库失败')));
});

test('toImageBlocks（老签名）仍然只返回数组 —— 别把返回类型改坏', async () => {
  const { store } = makeStore();
  const blocks = await toImageBlocks({
    attachments: store,
    segments: [{ type: 'image', url: 'http://a/long.png' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(960, 10793).buffer }),
    splitImpl: async (input) => ({
      ok: true,
      images: input.segments.map((s, i) => ({ index: i + 1, data: new Uint8Array([1]), name: `x-${i}.jpg`, width: s.width, height: s.height, bytes: 1 })),
    }),
  });
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.length, 2);
});

// ───────────────────────────── file 段里的图片（2026-10-22，真机：960×10793 走 file 段）

test('★ isImageFileSegment：只看扩展名，**判不准就当文件**（保守）', () => {
  // 真人发的那张：QQ 把它当文件发，名字带扩展名
  assert.equal(isImageFileSegment({ type: 'file', file: '长图.jpg' }), true);
  assert.equal(isImageFileSegment({ type: 'file', file: 'a.JPEG' }), true);
  assert.equal(isImageFileSegment({ type: 'file', file: 'a.png' }), true);
  assert.equal(isImageFileSegment({ type: 'file', file: 'a.webp' }), true);
  assert.equal(isImageFileSegment({ type: 'file', file: 'a.gif' }), true);
  assert.equal(isImageFileSegment({ type: 'file', file: 'a.bmp' }), true);
  // NapCat 的形状：`file` 是名字，真正能下载的是 `url`（常常带查询串）
  assert.equal(
    isImageFileSegment({ type: 'file', data: { file: 'x.jpg', url: 'https://x/a.jpg?term=2&spec=abc' } }),
    true,
  );
  // 只有 url 带扩展名也认
  assert.equal(isImageFileSegment({ type: 'file', url: 'https://x/a.png?term=2' }), true);
  // 本机路径（NapCat 有时给这个）
  assert.equal(isImageFileSegment({ type: 'file', file: 'D:\\QQNT\\data\\a.jpeg' }), true);

  // ⚠️ 判不准一律 false：非图片、没扩展名、内联载荷、畸形输入
  assert.equal(isImageFileSegment({ type: 'file', file: '报告.zip' }), false);
  assert.equal(isImageFileSegment({ type: 'file', file: 'a.mp4' }), false);
  assert.equal(isImageFileSegment({ type: 'file', file: 'a.txt' }), false);
  assert.equal(isImageFileSegment({ type: 'file', file: 'noext' }), false);
  assert.equal(isImageFileSegment({ type: 'file', file: '' }), false);
  assert.equal(isImageFileSegment({ type: 'file', file: `base64://${Buffer.from(PNG).toString('base64')}` }), false);
  assert.equal(isImageFileSegment({ type: 'file' }), false);
  assert.equal(isImageFileSegment({ type: 'image', file: 'a.jpg' }), false, 'image 段不走这个判据');
  assert.equal(isImageFileSegment(null), false);
  assert.equal(isImageFileSegment('a.jpg'), false);
  assert.ok(IMAGE_FILE_EXTENSIONS.includes('jpg'));
});

test('collectImageSegments：includeImageFiles 才并进 file 段里的图（默认口径不变）', () => {
  const segs = [
    { type: 'text', text: '看这个' },
    { type: 'image', url: 'http://a/1.png' },
    { type: 'file', file: 'photo.jpg', url: 'http://a/photo.jpg' },
    { type: 'file', file: '文档.pdf', url: 'http://a/文档.pdf' },
    { type: 'file', file: '包.zip' },
  ];
  // 默认（贴纸收割 / 描述预取 / 转录渲染用的就是它）—— 一个 file 段都不能多
  assert.equal(collectImageSegments(segs).length, 1);
  assert.deepEqual(collectImageSegments(segs).map((s) => s.type), ['image']);

  const withFiles = collectImageSegments(segs, { includeImageFiles: true });
  assert.deepEqual(withFiles.map((s) => s.type), ['image', 'file']);
  assert.equal(withFiles[1].file, 'photo.jpg');

  // 条数上限对合并后的总数生效（防止 file 段把 4 张的闸门绕过去）
  const many = Array.from({ length: 20 }, (_, i) => ({ type: 'file', file: `${i}.png` }));
  assert.equal(collectImageSegments(many, { includeImageFiles: true }).length, MAX_IMAGES_PER_MESSAGE);
  assert.equal(isImageFileSegment(many[0]), true);
});

test('★ file 段里的长图（960×10793）⇒ 走和 image 段**完全相同**的切分链路', async () => {
  const { saved, store } = makeStore({ maxImageDimension: 8192 });
  const calls = [];
  const outcome = await toImageBlocksDetailed({
    attachments: store,
    // 真人那条的形状：type 是 file，名字是 .jpg，字节是那张长图
    segments: [{ type: 'file', file: '长图.jpg', url: 'http://a/long.jpg', file_size: '1234567' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(960, 10793).buffer }),
    splitImpl: async (input) => {
      calls.push(input);
      return {
        ok: true,
        images: input.segments.map((segment, i) => ({
          index: i + 1,
          data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
          name: `qq-image-${i + 1}.jpg`,
          width: segment.width,
          height: segment.height,
          bytes: 4,
        })),
      };
    },
    log: () => {},
  });

  assert.equal(calls.length, 1, 'file 段里的长图必须真的进切图链');
  assert.deepEqual(calls[0].segments.map((s) => s.height), [5937, 5937]);
  assert.equal(outcome.blocks.length, 2, '所有切片都要喂给模型');
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map((s) => s.mediaType), ['image/jpeg', 'image/jpeg']);
  assert.equal(outcome.notes.length, 1);
  assert.match(outcome.notes[0], /1\/2/);
  assert.match(outcome.notes[0], /2\/2/);
  assert.match(outcome.notes[0], /拼起来/);
});

test('file 段里的小图 ⇒ 一张 image block（不切）', async () => {
  const { saved, store } = makeStore();
  let splitCalled = 0;
  const blocks = await toImageBlocks({
    attachments: store,
    segments: [{ type: 'file', file: 'a.png', url: 'http://a/a.png' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(800, 600).buffer }),
    splitImpl: async () => { splitCalled += 1; throw new Error('小图不该切'); },
  });
  assert.equal(blocks.length, 1);
  assert.equal(saved.length, 1);
  assert.equal(splitCalled, 0);
});

test('★ 非图片的 file 段：**不下载、不进链路**，[文件] 占位照旧', async () => {
  let fetched = 0;
  const { saved, store } = makeStore();
  const outcome = await toImageBlocksDetailed({
    attachments: store,
    segments: [
      { type: 'file', file: '报告.zip', url: 'http://a/报告.zip' },
      { type: 'file', file: 'a.mp4', url: 'http://a/a.mp4' },
      { type: 'file', file: 'noext' },
      { type: 'text', text: '看看这个' },
    ],
    fetchImpl: async () => { fetched += 1; throw new Error('非图片不该被下载'); },
    log: () => {},
  });
  assert.equal(fetched, 0, '判不准就不是图片 —— 连一次下载都不该发生');
  assert.deepEqual(outcome.blocks, []);
  assert.deepEqual(outcome.notes, []);
  assert.equal(saved.length, 0);
});

test('★ file 段疑似图片但下载失败 / 字节认不出 ⇒ 退回 [文件] + warn，绝不抛', async () => {
  const { saved, store } = makeStore();

  // ① 下载失败（url 拿不到）
  const logs = [];
  let outcome = await toImageBlocksDetailed({
    attachments: store,
    segments: [{ type: 'file', file: 'a.jpg', url: 'http://a/a.jpg' }],
    fetchImpl: async () => { throw new Error('timeout'); },
    log: (level, message) => logs.push({ level, message }),
  });
  assert.deepEqual(outcome.blocks, [], '退回 [文件]，但没有异常');
  assert.equal(saved.length, 0);
  const warn = logs.find((l) => l.level === 'warn');
  assert.ok(warn !== undefined, 'file 段失败必须 warn（image 段才是 debug）');
  assert.match(warn.message, /\[文件\]/);

  // ② 扩展名是 .jpg，但字节根本不是图片（改名的假图 / 坏文件）
  const logs2 = [];
  outcome = await toImageBlocksDetailed({
    attachments: store,
    segments: [{ type: 'file', file: 'fake.jpg', url: 'http://a/fake.jpg' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer }),
    log: (level, message) => logs2.push({ level, message }),
  });
  assert.deepEqual(outcome.blocks, []);
  assert.equal(saved.length, 0);
  assert.ok(logs2.some((l) => l.level === 'warn' && l.message.includes('不是有效图片')));

  // ③ 附件服务拒收 —— 同样只退回 [文件]
  const logs3 = [];
  outcome = await toImageBlocksDetailed({
    attachments: { async saveImage() { throw new Error('DSH 拒收：尺寸超限'); } },
    segments: [{ type: 'file', file: 'a.png', url: 'http://a/a.png' }],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(800, 600).buffer }),
    log: (level, message) => logs3.push({ level, message }),
  });
  assert.deepEqual(outcome.blocks, []);
  assert.ok(logs3.some((l) => l.level === 'warn'));
});

test('image 段 + file 段里的图同时出现 ⇒ 两张都进同一批 blocks（顺序按段）', async () => {
  const { saved, store } = makeStore();
  const outcome = await toImageBlocksDetailed({
    attachments: store,
    segments: [
      { type: 'image', url: 'http://a/1.png' },
      { type: 'file', file: '2.png', url: 'http://a/2.png' },
    ],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(800, 600).buffer }),
    log: () => {},
  });
  assert.equal(outcome.blocks.length, 2);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map((s) => s.name), ['qq-image', '2.png'], 'file 段的名字要带进附件名');
});

// ─────────────── get_file 兜底（2026-10-22 第二次真机：file 段只给 id / 名字，不给 url）

test('isFileIdShaped：内联载荷 / 带协议的地址**不算** id；名字与路径算', () => {
  // NapCat 的 `file` 往往是**文件名**（带扩展名），也可能是容器内路径 —— 两种 get_file 都认
  assert.equal(isFileIdShaped('5DF393C7AE600C520F6F08EBD50188C.jpg'), true);
  assert.equal(isFileIdShaped('/app/.config/QQ/nt_data/a.jpg'), true);
  assert.equal(isFileIdShaped('D:\\QQNT\\data\\a.jpeg'), true);
  // 这两类"段里已经能自己拿到内容"的形状**不能**当 id（上面几步已经试过了）
  assert.equal(isFileIdShaped('http://a/x.jpg'), false);
  assert.equal(isFileIdShaped('https://a/x.jpg?term=2'), false);
  assert.equal(isFileIdShaped('file:///D:/QQNT/a.jpg'), false);
  assert.equal(isFileIdShaped(`base64://${Buffer.from(PNG).toString('base64')}`), false);
  assert.equal(isFileIdShaped('data:image/png;base64,AAAA'), false);
  // 畸形输入
  assert.equal(isFileIdShaped(''), false);
  assert.equal(isFileIdShaped('   '), false);
  assert.equal(isFileIdShaped('a b'), false);
  assert.equal(isFileIdShaped(null), false);
  assert.equal(isFileIdShaped(123), false);
});

test('fileIdFromSegment：显式 file_id 优先（**不再做形状检查**），没有才退回 file', () => {
  // OneBot / NapCat 把真 id 放 file_id，它可能就是个 `/xxx` 容器路径
  assert.equal(fileIdFromSegment({ type: 'file', file_id: '/8f3c-1d2e', file: '5DF.jpg' }), '/8f3c-1d2e');
  assert.equal(fileIdFromSegment({ type: 'file', data: { file_id: 'abc', file: '5DF.jpg' } }), 'abc');
  // 没有 file_id ⇒ 退回 file（NapCat 给的是文件名）
  assert.equal(
    fileIdFromSegment({ type: 'file', file: '5DF393C7AE600C520F6F08EBD50188C.jpg' }),
    '5DF393C7AE600C520F6F08EBD50188C.jpg',
  );
  assert.equal(fileIdFromSegment({ type: 'file', data: { file: 'x.png' } }), 'x.png');
  // 已经是可下载地址 / 内联载荷 ⇒ 不是 id
  assert.equal(fileIdFromSegment({ type: 'file', file: 'http://a/x.jpg' }), '', '有可下载地址就不是 id');
  assert.equal(fileIdFromSegment({ type: 'file', file: 'base64://AAAA' }), '');
  assert.equal(fileIdFromSegment({ type: 'file' }), '');
  assert.equal(fileIdFromSegment(null), '');
});

test('★ fetchImageBytes：file 段只有 file_id、没有 url ⇒ 调 get_file 换 url 再下载', async () => {
  const calls = [];
  const fetched = [];
  const got = await fetchImageBytes(
    { type: 'file', file: '5DF393C7AE600C520F6F08EBD50188C.jpg' },
    {
      fetchImpl: async (url) => {
        fetched.push(url);
        return { ok: true, arrayBuffer: async () => PNG.buffer };
      },
      oneBotAction: async (action, params, options) => {
        calls.push({ action, params, options });
        // NapCat 的真实形状：file = 服务器路径，url = 可下载地址
        return { file: '/app/.config/QQ/a.jpg', url: 'http://cdn/a.jpg?term=2', file_size: 1936582 };
      },
    },
  );

  assert.ok(got !== null);
  assert.equal(got.data.length, PNG.length);
  assert.equal(calls.length, 1, '只该问一次服务器');
  assert.equal(calls[0].action, 'get_file');
  assert.equal(calls[0].params.file_id, '5DF393C7AE600C520F6F08EBD50188C.jpg', 'OneBot 11 的参数名就是 file_id');
  assert.equal(typeof calls[0].options?.timeoutMs, 'number', '不能无限等');
  assert.deepEqual(fetched, ['http://cdn/a.jpg?term=2'], '拿到的是 get_file 回的 url');
});

test('get_file 的三种返回都认：base64（不联网）/ url / 服务器本地路径', async () => {
  // a) base64
  let net = 0;
  let got = await fetchImageBytes(
    { type: 'file', file_id: 'id-b64' },
    {
      fetchImpl: async () => { net += 1; throw new Error('不该联网'); },
      oneBotAction: async () => ({ base64: Buffer.from(PNG).toString('base64') }),
    },
  );
  assert.ok(got !== null);
  assert.equal(got.data.length, PNG.length);
  assert.equal(net, 0, 'base64 已经给了字节，不该再下载');

  // b) 服务器本地路径 —— 同机部署时才读得到（容器内路径读不到就降级）
  got = await fetchImageBytes(
    { type: 'file', file_id: 'id-path' },
    {
      fetchImpl: async () => { throw new Error('不该联网'); },
      oneBotAction: async () => ({ file: 'H:/napcat/cache/a.jpg' }),
      fsImpl: {
        statSync: () => ({ isFile: () => true, size: PNG.length }),
        readFileSync: () => Buffer.from(PNG),
      },
    },
  );
  assert.ok(got !== null);
  assert.equal(got.data.length, PNG.length);
});

test('★ 有可下载 url 时**不问** get_file（省一次 action）；失败一律 null 不抛', async () => {
  let actions = 0;
  const got = await fetchImageBytes(
    { type: 'file', file: 'a.jpg', url: 'http://a/a.jpg' },
    {
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => PNG.buffer }),
      oneBotAction: async () => { actions += 1; return {}; },
    },
  );
  assert.ok(got !== null);
  assert.equal(actions, 0, '能直接下载就别多问一句');

  // get_file 抛 / 返回 null / 返回一个读不到的路径 / 根本没注入 action ⇒ 全部 null
  const seg = { type: 'file', file_id: 'id-x' };
  assert.equal(await fetchImageBytes(seg, { oneBotAction: async () => { throw new Error('NapCat: 文件不存在'); } }), null);
  assert.equal(await fetchImageBytes(seg, { oneBotAction: async () => null }), null);
  assert.equal(await fetchImageBytes(seg, { oneBotAction: async () => ({ file: 'H:/nope/missing.jpg' }) }), null);
  assert.equal(await fetchImageBytes({ type: 'file', file: 'a.jpg' }), null, '没注入 action ⇒ 老行为');

  // image 段不走这条兜底（那是 get_image 的事，不在这次范围内）
  let called = 0;
  await fetchImageBytes({ type: 'image', file: 'a.jpg' }, { oneBotAction: async () => { called += 1; return {}; } });
  assert.equal(called, 0);
});

test('★ 真机那条（file 段只给 id、没有 url）⇒ get_file 拿到 url，图真的变成 image block', async () => {
  const { saved, store } = makeStore();
  const seen = [];
  const outcome = await toImageBlocksDetailed({
    attachments: store,
    segments: [{ type: 'file', file: '5DF393C7AE600C520F6F08EBD50188C.jpg', file_size: '1936582' }],
    oneBotAction: async (action, params) => {
      seen.push({ action, params });
      return { url: 'http://cdn/5DF.jpg' };
    },
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => pngOf(800, 600).buffer }),
    log: () => {},
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, 'get_file');
  assert.equal(outcome.blocks.length, 1, '这条链以前在这里断，现在必须通');
  assert.equal(saved.length, 1);
});

test('★ file 段打一行 debug 摘要：键名 + 标量，**base64 内容绝不进日志**', async () => {
  const logs = [];
  const payload = 'A'.repeat(4096); // 假装是 base64 的图
  await toImageBlocksDetailed({
    attachments: null, // 没有附件服务也要留日志（排查时就靠这一行）
    segments: [
      { type: 'file', file: '5DF.jpg', file_id: 'abc', file_size: '1936582', url: '', base64: payload },
      { type: 'text', text: '看这个' },
    ],
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const line = logs.find((l) => l.level === 'debug' && l.message.includes('file 段'));
  assert.ok(line !== undefined, '收到 file 段必须留一行 debug');
  assert.notEqual(line.level, 'warn', '这条不许刷屏');

  const text = JSON.stringify(line.meta);
  assert.ok(!text.includes(payload), 'base64 绝不能进日志');
  assert.ok(!text.includes('AAAA'), '连片段都不能进');
  assert.match(text, /"keys":\["type","file"/);
  assert.ok(text.includes('1936582'), 'file_size 是排查的关键信息');
  assert.ok(text.includes('file_id'));
  assert.equal(line.meta.idShaped, true);
  assert.equal(line.meta.fileId, 'abc', '显式 file_id 优先（它才是拿去问服务器的那个）');
  assert.equal(line.meta.file, '5DF.jpg');
  assert.match(text, /内联载荷 4096 字符/, '内联载荷只留长度');

  // data 形状也摊平读（NapCat 的 HTTP 接口会这么给）
  const summary = summarizeFileSegment({ type: 'file', data: { file: 'x.jpg', url: 'http://a/x.jpg' } });
  assert.deepEqual(summary.keys, ['type', 'data']);
  assert.deepEqual(summary.dataKeys, ['file', 'url']);
  assert.equal(summary.url, 'http://a/x.jpg');
  assert.equal(summary.idShaped, true);
});
