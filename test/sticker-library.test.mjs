/**
 * 表情包库：**偷**（位判据 + 落盘）与 **存**（md5 去重 + 使用计数）。
 *
 * ## 这组测试盯着四件事，每件都对应一条会静默出错的规则
 *
 * 1. **判据是位判据**：`emoji_id 非空 或 (sub_type & 1) === 1`。
 *    ⚠️ **2026-10-08 这一条被反过来了**（上一批是"只认 `emoji_id`"）：
 *    用户本人看着图推翻了"`sub_type:1` 就是群友的照片/截图"那个说法 ——
 *    那是他**从「我的表情」面板发出去的**
 *    （`shared/表情包-2026-10-08/用户人工标注-判据真值-2026-10-08.md`）。
 *    现在必须**不收**的是 `sub_type: 0`（用户判定的那两张"很确定的梗图"就是它）。
 * 2. **md5 去重** —— 同一张表情包反复出现只该有一份文件。
 * 3. **坏了当空库** —— 索引损坏/版本不符/目录写不进去，都不能让"收消息回消息"停下来。
 * 4. **只留接口、不实现"挑"** —— `tags` 允许为空、查询是纯读，
 *    这里断言库**不会**自己选一张出来（没有随机、没有发送）。
 *
 * 样本用的是 2026-10-07 那几条**真实形状**（原文照抄）：商城表情（带 `emoji_id`、
 * 没有 `sub_type`）与"收藏的表情包"（`sub_type: 1` + `summary: ""` + `gchat.qpic.cn`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_MAX_STICKERS,
  MAX_STICKERS_PER_MESSAGE,
  STICKER_INDEX_VERSION,
  createStickerIndex,
  createStickerLibrary,
  isStickerSegment,
  stickerEvidence,
  stickerFormatOf,
} from '../src/dsh/sticker-library.mjs';
import { md5Hex } from '../src/dsh/image-cache.mjs';

// ------------------------------------------------------------------ 夹具

/**
 * 真表情包（2026-10-07 15:38:58 那条，**原文照抄**）。
 * 注意：**没有 `sub_type`**，有 `emoji_id` + `emoji_package_id`。
 */
function realSticker(overrides = {}) {
  return {
    type: 'image',
    summary: '[动画表情]',
    file: '67-674cbcb1606d656525fb8615f2648198.gif',
    url: 'https://gxh.vip.qq.com/club/item/parcel/item/67/674cbcb1606d656525fb8615f2648198/raw300.gif',
    key: '9276f2c49f9e9b5b',
    emoji_id: '674cbcb1606d656525fb8615f2648198',
    emoji_package_id: 240387,
    ...overrides,
  };
}

/**
 * **收藏的表情包**（2026-10-07 15:38:56 那条，**原文照抄**）。
 * `sub_type: 1` + `summary: ""` + **没有 `emoji_id`** + `gchat.qpic.cn`。
 *
 * ⚠️ 上一批把这个形状叫 `normalPhoto()`（"普通图"）—— **那个判断错了**：
 * 用户看着这几张图说「那 4 张是从『我的表情』面板里发的」。
 * 现在它是**要被收进来的**那一类。
 */
function collectedSticker(overrides = {}) {
  return {
    type: 'image',
    summary: '',
    file: 'Y9]7[J2}9A0S7CR~P`A2J%8.jpg',
    sub_type: 1,
    url: 'https://gchat.qpic.cn/gchatpic_new/0/0-0-D26FDA200E4CFFDF4B0DA3AA2BDD7240/0',
    file_size: '103122',
    ...overrides,
  };
}

/**
 * **普通图**（照片/截图/梗图）—— 用户亲口判定的那两张"很确定的梗图"就是这个形状。
 * `sub_type: 0`，没有 `emoji_id`。**它才是隐私红线要挡住的那一类。**
 */
function plainPhoto(overrides = {}) {
  return {
    type: 'image',
    summary: '',
    file: '{8638e263-d139-06e9-babd-13b4c022ae5c}.jpg',
    sub_type: 0,
    url: 'https://gchat.qpic.cn/gchatpic_new/0/0-0-8638E263D13906E9BABD13B4C022AE5C/0',
    file_size: '282073',
    ...overrides,
  };
}

/** 一张最小 PNG（≥12 字节，magic 认得出）。`seed` 决定内容 → 决定 md5。 */
function pngBytes(seed) {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b[8] = 0x00; b[9] = 0x00; b[10] = 0x00; b[11] = 0x0d;
  b[12] = seed % 256; b[13] = (seed * 7) % 256;
  return b;
}

/** 假 fetch：按 URL 尾段决定返回哪份字节。 */
function fakeFetch(table) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const body = table[String(url)];
    if (body === undefined) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  impl.calls = calls;
  return impl;
}

/** 一个隔离的临时库（每个用例一个目录，互不影响）。 */
function tempLib({ fetchImpl, maxEntries, enabled = true, dirOverride, indexPathOverride } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-stickers-'));
  const dir = dirOverride === undefined ? path.join(root, 'stickers') : dirOverride;
  const indexPath = indexPathOverride === undefined ? path.join(root, 'qq-stickers.json') : indexPathOverride;
  const logs = [];
  const library = createStickerLibrary({
    dir,
    indexPath,
    enabled,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(maxEntries === undefined ? {} : { maxEntries }),
    now: () => Date.UTC(2026, 9, 8, 1, 0, 0),
  });
  return { root, dir, indexPath, library, logs };
}

function readIndex(indexPath) {
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

// ------------------------------------------------------------------ ① 判据

test('★ 判据：真表情包（有 emoji_id、**没有 sub_type**）判为表情包', () => {
  const seg = realSticker();
  assert.equal(isStickerSegment(seg), true);
  assert.deepEqual(stickerEvidence(seg), {
    verdict: 'sticker',
    emojiId: '674cbcb1606d656525fb8615f2648198',
    packageId: '240387',
    reason: 'emoji_id',
  });
});

test('★★ 判据：`sub_type: 1` 的图**是**表情包（旧说法"这是普通图"已被用户推翻）', () => {
  // 用户 2026-10-08 看着图确认：这几张是**他从「我的表情」面板发出去的**。
  // ⚠️ 所以这条用例是**反过来**的 —— 上一批它断言"不是表情包"。
  const seg = collectedSticker();
  assert.equal(seg.sub_type, 1);
  assert.equal(isStickerSegment(seg), true);
  assert.equal(stickerEvidence(seg).reason, 'sub_type-bit');
  assert.equal(stickerEvidence(seg).emojiId, '', '它确实没有 emoji_id —— 靠的是位判据');
});

test('★★ 判据：`sub_type & 1` 的位判据（1 / 7 / 11 收，0 不收）', () => {
  // 1495 张真实样本里的实测分布：1(217) / 11(10) / 7(6) 的最低位全是 1，0(1260) 是 0。
  for (const sub of [1, 7, 11]) {
    assert.equal(isStickerSegment(collectedSticker({ sub_type: sub })), true, `sub_type=${sub} 该收`);
    assert.equal(stickerEvidence(collectedSticker({ sub_type: sub })).reason, 'sub_type-bit');
  }
  // 这两张正是用户判定的"很确定的梗图"
  assert.equal(isStickerSegment(plainPhoto()), false);
  assert.equal(stickerEvidence(plainPhoto()).verdict, 'not-sticker');
  assert.equal(stickerEvidence(plainPhoto({ sub_type: 4 })).verdict, 'not-sticker', '4 的最低位是 0');
  assert.equal(stickerEvidence(plainPhoto({ sub_type: 2 })).verdict, 'not-sticker');
});

test('★ 判据：`sub_type` 的边界输入不猜（字符串数字认、小数/null/空不认）', () => {
  // NapCat HTTP 那条路返回的 `sub_type` 有时是字符串
  assert.equal(isStickerSegment(collectedSticker({ sub_type: '1' })), true);
  assert.equal(stickerEvidence(collectedSticker({ sub_type: '7' })).reason, 'sub_type-bit');
  // 不是整数的（按位运算会先截断，所以必须显式排除）
  assert.equal(stickerEvidence(collectedSticker({ sub_type: 1.5 })).verdict, 'not-sticker');
  assert.equal(stickerEvidence(collectedSticker({ sub_type: 'x' })).verdict, 'not-sticker');
  assert.equal(stickerEvidence(collectedSticker({ sub_type: null })).verdict, 'not-sticker');
  assert.equal(stickerEvidence(collectedSticker({ sub_type: '  ' })).verdict, 'not-sticker');
  assert.equal(stickerEvidence(collectedSticker({ sub_type: undefined })).verdict, 'not-sticker');
});

test('★★ 判据：**`summary` 完全不是证据**（它和 `sub_type` 是同一个证据）', () => {
  // `napcat.mjs:13535`：summary 是 NapCat 按 picSubType 合成的。
  // 所以：① 只有 summary、没有 sub_type → 不收；
  assert.equal(
    stickerEvidence({ type: 'image', summary: '[动画表情]', url: 'https://x/y.gif' }).verdict,
    'not-sticker',
  );
  // ② `sub_type: 0` 的图就算 summary 写着"[动画表情]"也不收（判据不是 summary）；
  assert.equal(isStickerSegment(plainPhoto({ summary: '[动画表情]' })), false);
  // ③ 反过来，`sub_type: 1` + summary 空串**照样收** —— 正是那 10 张"收藏的表情包"
  assert.equal(isStickerSegment(collectedSticker({ summary: '' })), true);
  assert.equal(isStickerSegment(collectedSticker({ summary: '[？]' })), true);
});

test('判据：`data` 嵌套形状（NapCat 规范形状）两把证据都认', () => {
  // ① emoji_id（商城表情那条路）
  assert.equal(isStickerSegment({
    type: 'image',
    data: {
      url: 'https://gxh.vip.qq.com/club/item/parcel/item/67/aaa/raw300.gif',
      emoji_id: 'abc123',
      emoji_package_id: 7,
    },
  }), true);
  // ② 位判据（picElement 那条路）
  const nested = { type: 'image', data: { url: 'https://x/y.jpg', sub_type: 11, summary: '' } };
  assert.equal(isStickerSegment(nested), true);
  assert.equal(stickerEvidence(nested).reason, 'sub_type-bit');
});

test('判据：只有 emoji_package_id、没有 emoji_id / sub_type → 记成 near-miss（不入库，但可见）', () => {
  // 万一日后 QQ 改字段，这一档的计数会涨 —— 那是"判据该放宽了"的唯一信号。
  const got = stickerEvidence(realSticker({ emoji_id: undefined }));
  assert.equal(got.verdict, 'near-miss');
  assert.equal(got.packageId, '240387');
  assert.equal(got.reason, 'package-id-without-emoji-id');
});

test('★★ 判据：`animated-summary` 这一档**已删除**（那一类现在被收进来了）', () => {
  // 上一批的 C 类：{ sub_type:1, summary:"[动画表情]", 无 emoji_id } → 当时记 near-miss。
  // 它的"漏在门外"正是这次要修的问题（那 10 张 `sub_type:1` + summary 空 +
  // gchat.qpic.cn 的"收藏的表情包"就是同一个形状）。现在它**直接是表情包**。
  const c = {
    type: 'image',
    sub_type: 1,
    summary: '[动画表情]',
    file: '6E626B82CA4DB1C8D00E5EC9199CD21D.jpg',
    url: 'https://multimedia.nt.qq.com.cn/download?appid=1&fileid=x',
  };
  assert.equal(stickerEvidence(c).verdict, 'sticker');
  assert.equal(stickerEvidence(c).reason, 'sub_type-bit');
  // `[？]` / 空串都不影响（summary 不是证据）
  assert.equal(stickerEvidence({ ...c, summary: '[？]' }).verdict, 'sticker');
  assert.equal(stickerEvidence({ ...c, summary: '' }).verdict, 'sticker');
  // 而**没有 sub_type、也没有 emoji_id** 的那种（只有 summary）依然不收
  assert.equal(
    stickerEvidence({ type: 'image', summary: '[动画表情]', url: 'https://x/y.gif' }).verdict,
    'not-sticker',
  );
});

test('判据：非 image 段 / emoji_id 只有空白 / emoji_package_id 为 0 → not-sticker', () => {
  assert.equal(stickerEvidence({ type: 'text', text: 'hi' }).verdict, 'not-sticker');
  assert.equal(stickerEvidence({ type: 'image', emoji_id: '  ' }).verdict, 'not-sticker');
  assert.equal(
    stickerEvidence({ type: 'image', emoji_package_id: 0 }).verdict,
    'not-sticker',
    '0 是"没有包"，不算证据',
  );
});

test('stickerFormatOf：按 magic bytes 认格式，认不出的返回 null', () => {
  assert.deepEqual(stickerFormatOf(pngBytes(1)), { mediaType: 'image/png', ext: 'png' });
  assert.equal(stickerFormatOf(new Uint8Array(24)), null);
  assert.equal(stickerFormatOf(new Uint8Array(4)), null, '太短认不出（不猜）');
});

// ------------------------------------------------------------------ ② 偷 + 落盘

test('★ harvest：真表情包落盘，文件名是内容 md5，索引记全六项', async () => {
  const bytes = pngBytes(1);
  const md5 = md5Hex(bytes);
  const fetchImpl = fakeFetch({ [realSticker().url]: bytes });
  const { library, dir, indexPath } = tempLib({ fetchImpl });

  const got = await library.harvest([{ type: 'text', text: '看这个' }, realSticker()], {
    chatId: 'private:10000001',
    userId: '10000001',
  });

  assert.equal(got.stored, 1);
  assert.equal(got.dedup, 0);
  // 文件真的在盘上，名字就是 md5
  const name = `${md5}.png`;
  assert.equal(fs.existsSync(path.join(dir, name)), true);
  assert.deepEqual([...fs.readFileSync(path.join(dir, name))], [...bytes]);

  // 索引：md5 / 落盘路径 / 来源（群或人）/ 入库时间 / 使用次数 / tags
  const entry = readIndex(indexPath).entries[md5];
  assert.equal(entry.file, name);
  assert.equal(entry.path, path.join(dir, name));
  assert.equal(entry.at, '2026-10-08T01:00:00.000Z');
  assert.equal(entry.uses, 0, '刚偷进来时使用次数是 0');
  assert.equal(entry.seen, 0);
  assert.equal(entry.lastUsedAt, null);
  assert.deepEqual(entry.tags, [], '标签留给"认"，**允许为空**');
  assert.deepEqual(entry.source, { chatId: 'private:10000001', userId: '10000001' });
  assert.equal(entry.emojiId, '674cbcb1606d656525fb8615f2648198');
  assert.equal(readIndex(indexPath).version, STICKER_INDEX_VERSION);
});

test('★★ harvest：**普通图（sub_type: 0）一个字节都不落盘**（隐私红线）', async () => {
  const fetchImpl = fakeFetch({ [plainPhoto().url]: pngBytes(2) });
  const { library, dir, indexPath } = tempLib({ fetchImpl });

  const got = await library.harvest(
    [plainPhoto(), plainPhoto({ file: 'b.jpg' }), { type: 'text', text: '照片' }],
    { chatId: 'group:200000001', userId: '10000001' },
  );

  assert.equal(got.stored, 0);
  assert.deepEqual(fetchImpl.calls, [], '普通图**连下载都不该发生**');
  assert.equal(fs.existsSync(dir), false, '目录都不该建出来');
  assert.equal(fs.existsSync(indexPath), false, '索引也不该写');
  assert.equal(library.all().length, 0);
});

test('★ harvest：`sub_type: 1` 的"收藏的表情包"要**真的落盘**（这次修的正是它）', async () => {
  const bytes = pngBytes(12);
  const md5 = md5Hex(bytes);
  const fetchImpl = fakeFetch({ [collectedSticker().url]: bytes });
  const { library, dir } = tempLib({ fetchImpl });

  const got = await library.harvest([collectedSticker()], { chatId: 'private:30000001', userId: '30000001' });
  assert.equal(got.stored, 1);
  assert.equal(fs.existsSync(path.join(dir, `${md5}.png`)), true);
  assert.equal(library.get(md5).emojiId, '', '它没有 emoji_id —— 位判据也能收');
  assert.equal(library.stats().nearMiss, 0, '它不再是 near-miss');
});

test('★ harvest：同一份字节以**两个不同的 emoji_id** 到达 → md5 去重（只存一份）', async () => {
  const bytes = pngBytes(3);
  const fetchImpl = fakeFetch({ [realSticker().url]: bytes });
  const { library, dir } = tempLib({ fetchImpl });

  const first = await library.harvest([realSticker({ emoji_id: 'id-A' })], { chatId: 'group:1', userId: 'u' });
  // 第二次带了**另一个** emoji_id → `getByEmojiId` 命中不了，只能下载后按内容 md5 去重
  const second = await library.harvest([realSticker({ emoji_id: 'id-B' })], { chatId: 'group:1', userId: 'u' });

  assert.equal(first.stored, 1);
  assert.equal(second.stored, 0);
  assert.equal(second.dedup, 1);
  assert.equal(fetchImpl.calls.length, 2, 'id 对不上时必须下载，靠内容 md5 兜底');
  assert.deepEqual(fs.readdirSync(dir), [`${md5Hex(bytes)}.png`], '盘上只有一份');
  const entry = library.get(md5Hex(bytes));
  assert.equal(entry.seen, 1, '第二次见到 → seen +1');
  assert.equal(entry.uses, 0, 'seen 不是 uses');
  assert.equal(entry.emojiId, 'id-a', '已经记下的 emoji_id 不被后来的覆盖（且统一小写）');
});

test('★ harvest：**观测到的** emoji_id 配对让第二次零网络（emoji_id ≠ 内容 md5，实测就是这样）', async () => {
  const bytes = pngBytes(4);
  const md5 = md5Hex(bytes);
  // 真机实测：emoji_id 是 `674cbcb1…`，而下载到的 raw300.gif 内容 md5 是 `155912a0…`
  // —— **两者不同**。所以这里刻意用不一样的 id，模拟真实情况。
  const emojiId = '674cbcb1606d656525fb8615f2648198';
  const seg = realSticker({ emoji_id: emojiId });
  const fetchImpl = fakeFetch({ [seg.url]: bytes });
  const { library } = tempLib({ fetchImpl });

  const first = await library.harvest([seg], { chatId: 'g', userId: 'u' });
  const second = await library.harvest([seg], { chatId: 'g', userId: 'u' });

  assert.equal(first.stored, 1);
  assert.equal(library.stats().idMismatch, 1, 'emoji_id ≠ 内容 md5（实测结论的持续证据）');
  assert.ok(md5 !== emojiId, '这条用例的前提就是两者不同');
  assert.equal(second.dedup, 1);
  assert.equal(fetchImpl.calls.length, 1, '第二次靠"观测到的 emoji_id 配对"命中，没有下载');
});

test('★ 零网络：段里给的是**本机路径**时不去下载', async () => {
  const { root, library } = tempLib();
  const local = path.join(root, 'local.gif');
  fs.writeFileSync(local, Buffer.from(pngBytes(5)));
  const fetchImpl = fakeFetch({});
  const lib = createStickerLibrary({
    dir: path.join(root, 'lib'),
    indexPath: path.join(root, 'i.json'),
    log: () => {},
    fetchImpl,
    // `url` 是本机绝对路径 —— 实测 NapCat 真的会给这种段
  });
  const got = await lib.harvest([realSticker({ url: local, file: 'local.gif' })], { chatId: 'g', userId: 'u' });
  assert.equal(got.stored, 1);
  assert.deepEqual(fetchImpl.calls, [], '本地就有的文件绝不该走网络');
  assert.equal(lib.all().length, 1);
  assert.equal(library.all().length, 0, '另一个实例不受影响（隔离）');
});

test('★★ harvest：`near-miss` 只剩"只有包 id"这一档（animated-summary 那一档已删）', async () => {
  // 上一批的 C 类（sub_type + [动画表情] + 无 emoji_id）现在**是表情包**，
  // 所以它该走"入库"，而不是记一笔 near-miss 之后什么都不做。
  const c = {
    type: 'image',
    sub_type: 1,
    summary: '[动画表情]',
    file: '6E626B82CA4DB1C8D00E5EC9199CD21D.jpg',
    url: 'https://multimedia.nt.qq.com.cn/download?appid=1&fileid=x',
  };
  const bytes = pngBytes(40);
  const fetchImpl = fakeFetch({ [c.url]: bytes });
  const { library, dir } = tempLib({ fetchImpl });

  const got = await library.harvest([c], { chatId: 'private:30000001', userId: '30000001' });
  assert.equal(got.stored, 1, '现在收它（这正是本次要修的那一类）');
  assert.equal(got.nearMiss, 0);
  assert.equal(fs.existsSync(dir), true);
  // 那个"判据覆盖面"的计数连同它代表的判断一起退休了：
  // 留着它会变成一个**恒为 0 的死字段**（这个项目专门记过这一类坑）。
  assert.equal(library.stats().nearMissAnimated, undefined);
  assert.equal('nearMissAnimated' in got, false);

  // 真正还该记 near-miss 的只剩"只有 emoji_package_id"那一档
  const pkgOnly = realSticker({ emoji_id: undefined, sub_type: undefined, summary: '' });
  await library.harvest([pkgOnly], { chatId: 'g', userId: 'u' });
  assert.equal(library.stats().nearMiss, 1);
  assert.equal(library.stats().nearMissPackage, 1);
});

test('harvest：一次最多偷 MAX_STICKERS_PER_MESSAGE 张，其余记 skipped', async () => {
  const table = {};
  const segs = [];
  for (let i = 0; i < 5; i += 1) {
    const seg = realSticker({ emoji_id: `id${i}`, url: `http://x/${i}.png` });
    table[seg.url] = pngBytes(10 + i);
    segs.push(seg);
  }
  const { library } = tempLib({ fetchImpl: fakeFetch(table) });
  const got = await library.harvest(segs, { chatId: 'g', userId: 'u' });
  assert.equal(MAX_STICKERS_PER_MESSAGE, 3);
  assert.equal(got.stored, 3);
  assert.equal(got.skipped, 2);
  assert.equal(library.all().length, 3);
});

// ------------------------------------------------------------------ 失败分类

test('harvest：取不到字节 → failed，不抛异常', async () => {
  const { library } = tempLib({ fetchImpl: fakeFetch({}) });
  const got = await library.harvest([realSticker()], { chatId: 'g', userId: 'u' });
  assert.equal(got.failed, 1);
  assert.equal(got.stored, 0);
  assert.equal(library.stats().failed, 1);
});

test('harvest：fetch 直接抛错也**不 reject**（网关是 fire-and-forget 调的）', async () => {
  const throwing = async () => { throw new Error('网络炸了'); };
  const { library } = tempLib({ fetchImpl: throwing });
  const got = await library.harvest([realSticker()], { chatId: 'g', userId: 'u' });
  assert.equal(got.stored, 0);
  // 具体归到 failed（取字节那条路已经吞了）
  assert.equal(got.failed, 1);
});

test('harvest：格式认不出 → unrecognized，不入库（存了也发不回来）', async () => {
  const junk = new Uint8Array(24); // 全 0：不是任何已知图片格式
  const { library, dir, indexPath } = tempLib({ fetchImpl: fakeFetch({ [realSticker().url]: junk }) });
  const got = await library.harvest([realSticker()], { chatId: 'g', userId: 'u' });
  assert.equal(got.unrecognized, 1);
  assert.equal(fs.existsSync(indexPath), false);
  assert.equal(fs.existsSync(dir), false);
});

test('harvest：超过单张上限 → tooLarge，不入库', async () => {
  // 造一份"合法 PNG 头 + 5MB"的字节（超过 4MB 的 MAX_STICKER_BYTES）
  const big = new Uint8Array(5 * 1024 * 1024);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const { library, dir } = tempLib({ fetchImpl: fakeFetch({ [realSticker().url]: big }) });
  const got = await library.harvest([realSticker()], { chatId: 'g', userId: 'u' });
  assert.equal(got.tooLarge, 1);
  assert.equal(fs.existsSync(dir), false);
});

test('harvest：目录写不进去 → failed，不抛（磁盘满/无权限都不能影响主流程）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-stickers-'));
  // 把"目录"指到一个**已存在的普通文件**上 → mkdirSync 必失败
  const blocked = path.join(root, 'blocked');
  fs.writeFileSync(blocked, 'x');
  const library = createStickerLibrary({
    dir: path.join(blocked, 'stickers'),
    indexPath: path.join(root, 'i.json'),
    log: () => {},
    fetchImpl: fakeFetch({ [realSticker().url]: pngBytes(6) }),
  });
  const got = await library.harvest([realSticker()], { chatId: 'g', userId: 'u' });
  assert.equal(got.failed, 1);
  assert.equal(library.all().length, 0);
});

test('harvest：`enabled: false`（配置关掉"偷"）时什么都不做', async () => {
  const fetchImpl = fakeFetch({ [realSticker().url]: pngBytes(7) });
  const { library, dir } = tempLib({ fetchImpl, enabled: false });
  const got = await library.harvest([realSticker()], { chatId: 'g', userId: 'u' });
  assert.deepEqual(got, {
    stored: 0, dedup: 0, nearMiss: 0, skipped: 0, failed: 0,
    rejected: 0, auditFailed: 0, unrecognized: 0, tooLarge: 0,
  });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(fs.existsSync(dir), false);
});

// ------------------------------------------------------------------ ③ 坏了当空库

test('★★ 索引损坏（不是 JSON）→ 当空库、degraded=true，且**照常能入库**', async () => {
  const { dir, indexPath, library } = tempLib({ fetchImpl: fakeFetch({ [realSticker().url]: pngBytes(8) }) });
  fs.writeFileSync(indexPath, '{这不是 JSON');
  const lib = createStickerLibrary({ dir, indexPath, log: () => {}, fetchImpl: fakeFetch({}) });
  assert.equal(lib.stats().index.degraded, true);
  assert.equal(lib.stats().index.size, 0);
  assert.deepEqual(lib.all(), []);
  assert.equal(lib.pathOf('a'.repeat(32)), null, '空库里什么都没有');

  // 关键：坏了之后**照常工作**，不是变成一个坏掉的功能
  const got = await library.harvest([realSticker()], { chatId: 'g', userId: 'u' });
  assert.equal(got.stored, 1, '原实例照常入库');
});

test('★ 索引版本对不上 → 当空库 + degraded（宁可重攒，不误读旧格式）', () => {
  const { dir, indexPath } = tempLib();
  fs.writeFileSync(indexPath, JSON.stringify({ version: 999, entries: { [ 'a'.repeat(32) ]: { file: 'x.png' } } }));
  const lib = createStickerLibrary({ dir, indexPath, log: () => {} });
  assert.equal(lib.stats().index.degraded, true);
  assert.equal(lib.stats().index.size, 0);
});

test('索引不存在（第一次跑）**不算坏**：degraded=false、enabled=true', () => {
  const { dir, indexPath, library } = tempLib();
  assert.equal(library.stats().index.degraded, false);
  assert.equal(library.stats().index.enabled, true);
  assert.equal(library.stats().index.size, 0);
});

test('★ 索引跨进程可读：新建一个实例能把上一次写的读回来', async () => {
  const { dir, indexPath, library } = tempLib({ fetchImpl: fakeFetch({ [realSticker().url]: pngBytes(9) }) });
  await library.harvest([realSticker()], { chatId: 'group:200000001', userId: '10000001' });
  const reopened = createStickerLibrary({ dir, indexPath, log: () => {} });
  assert.equal(reopened.all().length, 1);
  const entry = reopened.all()[0];
  assert.equal(entry.source.chatId, 'group:200000001');
  assert.equal(reopened.pathOf(entry.md5), entry.path, '路径能重新算出来（不靠 index 里那份快照）');
});

test('索引里的坏条目被丢掉，好条目留下（一条坏的不该废掉整库）', () => {
  const good = 'a'.repeat(32);
  const { dir, indexPath } = tempLib();
  fs.writeFileSync(indexPath, JSON.stringify({
    version: STICKER_INDEX_VERSION,
    updatedAt: '2026-10-08T00:00:00.000Z',
    entries: {
      [good]: { file: `${good}.gif`, tags: ['开心'] },
      bad1: { file: '' },
      bad2: null,
    },
  }));
  const lib = createStickerLibrary({ dir, indexPath, log: () => {} });
  assert.equal(lib.stats().index.size, 1);
  assert.equal(lib.stats().index.degraded, false, '丢条目不是"库坏了"');
  assert.deepEqual(lib.get(good).tags, ['开心']);
});

test('★ 索引写不进去时内存里仍然有效（write 是尽力而为）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-stickers-'));
  const index = createStickerIndex({
    filePath: path.join(root, 'no-such-dir', 'i.json'), // 父目录不存在 → 写失败
    log: () => {},
  });
  assert.equal(index.set('a'.repeat(32), { file: 'a.gif' }), true, '内存里记住了');
  assert.equal(index.get('a'.repeat(32)).file, 'a.gif');
  assert.equal(index.stats().writes, 0, '但没落盘');
});

// ------------------------------------------------------------------ ④ 接口（认/挑）

test('★ recordUse / setTags / findByTags / all / get —— 接口齐了，且 2026-10-19 起**实现了挑**', async () => {
  const table = {};
  const segs = [];
  for (let i = 0; i < 2; i += 1) {
    const seg = realSticker({ emoji_id: `id${i}`, url: `http://x/${i}.png` });
    table[seg.url] = pngBytes(20 + i);
    segs.push(seg);
  }
  const { library } = tempLib({ fetchImpl: fakeFetch(table) });
  await library.harvest(segs, { chatId: 'g', userId: 'u' });
  const [a, b] = library.all().map((e) => e.md5);

  // 使用计数（"挑"的依据）
  assert.equal(library.recordUse(a), true);
  assert.equal(library.recordUse(a), true);
  assert.equal(library.recordUse(b), true);
  assert.equal(library.get(a).uses, 2);
  assert.equal(library.get(b).uses, 1);
  assert.equal(typeof library.get(a).lastUsedAt, 'string');

  // 标签（"认"回写）——**允许空数组**
  assert.deepEqual(library.get(a).tags, []);
  assert.equal(library.setTags(a, ['开心', ' ']), true);
  assert.deepEqual(library.get(a).tags, ['开心'], '空标签被丢掉');
  assert.equal(library.setTags(a, []), true);
  assert.deepEqual(library.get(a).tags, []);

  // 纯查询：按标签过滤
  library.setTags(b, ['无语']);
  assert.deepEqual(library.findByTags({ tags: ['无语'] }).map((e) => e.md5), [b]);
  assert.deepEqual(library.findByTags().length, 2, '不传标签 = 全部');
  assert.deepEqual(library.findByTags({ tags: ['不存在'] }), []);

  // 只读快照：改返回值不该影响库内部
  const snapshot = library.get(b);
  snapshot.tags.push('伪造');
  snapshot.uses = 999;
  assert.deepEqual(library.get(b).tags, ['无语']);
  assert.equal(library.get(b).uses, 1);

  // 2026-10-19：**"挑"现在实现了**（用户拍板：骰子 + 同类反比加权 + 描述贴合）。
  // 这条从"守门不许加"翻成"必须有、而且只能从库里挑"。
  assert.equal(typeof library.pick, 'function', '现在必须有 pick()');
  const picked = library.pick({ tags: ['无语'] });
  assert.ok(picked === null || [a, b].includes(picked.md5), 'pick 只能挑库里存在的');
  assert.equal(library.pick({ tags: ['不存在的标签'] }), null, '挑不到就 null，别乱给');
});

test('★ pathOf：库里有记录但文件已被删掉 → null（不猜、不发错图）', async () => {
  const { library, dir } = tempLib({ fetchImpl: fakeFetch({ [realSticker().url]: pngBytes(11) }) });
  await library.harvest([realSticker()], { chatId: 'g', userId: 'u' });
  const md5 = library.all()[0].md5;
  assert.equal(typeof library.pathOf(md5), 'string');
  fs.rmSync(path.join(dir, `${md5}.png`));
  assert.equal(library.pathOf(md5), null);
});

test('★ 满了按「用得少的先走」淘汰（MaiBot 的 1/(uses+1) 同向、但确定性）', async () => {
  const table = {};
  const segs = [];
  for (let i = 0; i < 2; i += 1) {
    const seg = realSticker({ emoji_id: `id${i}`, url: `http://x/${i}.png` });
    table[seg.url] = pngBytes(30 + i);
    segs.push(seg);
  }
  const { library, indexPath } = tempLib({ fetchImpl: fakeFetch(table), maxEntries: 1 });
  await library.harvest([segs[0]], { chatId: 'g', userId: 'u' });
  const keeper = library.all()[0].md5;
  library.recordUse(keeper); // 让第一条"被用过"

  // 再偷一张（此刻 2 条 > 上限 1 → 落盘时淘汰"用得少的"那条，即新来的）
  const table2 = { [segs[1].url]: pngBytes(31) };
  const lib2 = createStickerLibrary({
    dir: library.dir(),
    indexPath,
    log: () => {},
    fetchImpl: fakeFetch(table2),
    maxEntries: 1,
  });
  await lib2.harvest([segs[1]], { chatId: 'g', userId: 'u' });

  const entries = readIndex(indexPath).entries;
  assert.equal(Object.keys(entries).length, 1);
  assert.equal(entries[keeper].uses, 1, '用过的留下');
  assert.equal(lib2.stats().index.dropped >= 1, true, '有淘汰发生（不是静默长大）');
});

test('默认上限是一个正数（配置缺省不能变成"无上限"）', () => {
  assert.equal(Number.isInteger(DEFAULT_MAX_STICKERS), true);
  assert.ok(DEFAULT_MAX_STICKERS > 0);
});
