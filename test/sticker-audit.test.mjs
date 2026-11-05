/**
 * 审核留样测试（`src/dsh/sticker-audit.mjs`）。
 *
 * ## 为什么必须存在
 *
 * 这个模块的整个价值是"**被拒的图也要能看到**"，而它的坏法全都**不报错**：
 *
 * - 只存收下的（把 `save()` 放到 `accept` 判断之后）⇒ 目录里全是通过的，
 *   用户以为自己"校过一轮了"，其实**最该看的那批一张都没有**；
 * - `.json` 里不记**当时生效的阈值** ⇒ 事后分数还在，但不知道是按哪套阈值拒的
 *   （阈值一调，全部历史记录同时失去意义）；
 * - 没有上限 ⇒ 目录无声长大（用户明确说"暂时性"）；
 * - 写盘失败往上抛 ⇒ 把 fire-and-forget 的偷图链搞出未捕获 rejection；
 * - 侧车 `.json` 不跟着淘汰 ⇒ 标注员点进去发现图没了。
 *
 * 这里逐条钉住。
 *
 * ⚠️ 临时目录用**工作区内**的路径（`test/.tmp-audit-*`），不用 `os.tmpdir()` ——
 * 本机沙箱挡着 `%TEMP%`，用它会 EPERM 假红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_STICKER_AUDIT,
  auditHashOf,
  createStickerAudit,
  normalizeStickerAudit,
} from '../src/dsh/sticker-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 建一个测试目录（工作区内，避免沙箱挡 %TEMP%）。 */
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(HERE, `.tmp-audit-${tag}-`));
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith('.tmp-audit-')) fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
    }
  } catch { /* 收尾失败不影响结果 */ }
});

/** 一段能当"图"用的字节（内容不同 → md5 不同）。 */
const bytesOf = (seed) => new Uint8Array(Buffer.from(`fake-image-bytes-${seed}`));

/** 造一份 `sanitizeStickerVerdict` 形状的结果。 */
function verdictOf({
  ok = true, accept = false, reject = 'ugly',
  scores = { nsfw: 0, violence: 0, gore: 0, ugly: 7, funny: 8 },
  political = false, pureText = false, phash = '',
} = {}) {
  return {
    ok, accept, reject,
    rejects: ok && !accept ? [reject] : [],
    isSticker: true,
    portrait: false, screenshot: false,
    political, pureText,
    scores, caption: '我裂开了', captionChars: 4,
    desc: '一只猫在键盘上', tags: ['调侃吐槽'], unmatched: '',
    phash,
  };
}

const THRESHOLDS = { nsfwMax: 4, violenceMax: 4, goreMax: 4, uglyMax: 4, funnyMin: 3, captionMaxChars: 60 };

// ─────────────────────────────────────────────── 默认值与夹紧

test('默认值：目录 / 上限 / 索引都有一套保守默认（用户说"暂时性"）', () => {
  assert.equal(DEFAULT_STICKER_AUDIT.enabled, true);
  assert.match(DEFAULT_STICKER_AUDIT.dir, /sticker-audit$/);
  assert.equal(DEFAULT_STICKER_AUDIT.maxFiles, 200);
  assert.equal(DEFAULT_STICKER_AUDIT.maxBytes, 256 * 1024 * 1024);
  assert.equal(DEFAULT_STICKER_AUDIT.index, true);
});

test('夹紧：maxFiles / maxBytes / maxIndexLines 越界夹到边界；空 dir = 明确关掉', () => {
  const a = normalizeStickerAudit({ maxFiles: 999999, maxBytes: -5, maxIndexLines: 1e9 });
  assert.equal(a.maxFiles, 20_000);
  assert.equal(a.maxBytes, 0, '负字节数 = 不按字节限制（会被 prune 当成"全都要淘汰"吗？见下面那条测试）');
  assert.equal(a.maxIndexLines, 1_000_000);

  const b = normalizeStickerAudit({ dir: '' });
  assert.equal(b.dir, '', '空串要保留成空串 —— "关掉"和"没配"是两件事');

  const c = normalizeStickerAudit({});
  assert.equal(c.dir, DEFAULT_STICKER_AUDIT.dir, '缺字段才走默认');
  assert.equal(c.enabled, true);
});

test('`enabled=false` 或 `dir=\'\'` ⇒ 一张都不写（连目录都不建）', async () => {
  const dir = tmpDir('off');
  const target = path.join(dir, 'sub');
  const audit = createStickerAudit({ config: { dir: target, enabled: false } });
  const got = await audit.save({ data: bytesOf(1), mediaType: 'image/png', verdict: verdictOf() });
  assert.equal(got, null);
  assert.equal(fs.existsSync(target), false, '关掉时不该建目录');
  assert.equal(audit.enabled(), false);

  const audit2 = createStickerAudit({ config: { dir: '' } });
  assert.equal(await audit2.save({ data: bytesOf(1), mediaType: 'image/png', verdict: verdictOf() }), null);
  assert.equal(audit2.enabled(), false);
});

// ─────────────────────────────────────────────── ★ 核心：被拒的也要存

test('★★ 被拒的图**照样落盘**（这是这个功能的全部意义）', async () => {
  const dir = tmpDir('rejected');
  const audit = createStickerAudit({ config: { dir, maxFiles: 10, maxBytes: 1e9 } });
  const data = bytesOf('rejected-1');
  const hash = auditHashOf(data);
  const got = await audit.save({
    data, mediaType: 'image/gif', name: 'a.gif',
    source: { chatId: 'group:30000011', userId: '3410284724', subType: 1 },
    verdict: verdictOf({ accept: false, reject: 'ugly' }),
    thresholds: THRESHOLDS,
  });
  assert.equal(got.md5, hash);
  assert.equal(fs.existsSync(path.join(dir, `${hash}.gif`)), true, '原图要在');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, `${hash}.json`), 'utf8'));
  assert.equal(rec.accept, false);
  assert.equal(rec.reject, 'ugly');
  assert.deepEqual(rec.scores, { nsfw: 0, violence: 0, gore: 0, ugly: 7, funny: 8 });
  assert.deepEqual(rec.thresholds, THRESHOLDS, '⭐ 当时生效的阈值必须记下来（含 funnyMin / 新的 caption 红线）');
  assert.equal(rec.isSticker, true, '⭐ 是不是表情包也要落进留样（标注员要能看出"是因为不是表情包才拒的"）');
  assert.equal(rec.source.chatId, 'group:30000011');
  assert.equal(rec.source.userId, '3410284724');
  assert.equal(rec.source.subType, 1);
  assert.equal(rec.image.file, `${hash}.gif`);
  assert.equal(rec.image.originalName, 'a.gif');
  assert.equal(audit.stats().wrote, 1);
});

test('★★ 2026-10-09 判据重写新加的三个留样字段：political / pureText / phash', async () => {
  const dir = tmpDir('newfields');
  const audit = createStickerAudit({ config: { dir, maxFiles: 10, maxBytes: 1e9 } });
  const data = bytesOf('political-one');
  const hash = auditHashOf(data);
  await audit.save({
    data, mediaType: 'image/png',
    verdict: verdictOf({ accept: false, reject: 'political', political: true, phash: '1818181818181818' }),
    thresholds: THRESHOLDS,
  });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, `${hash}.json`), 'utf8'));
  assert.equal(rec.political, true, '涉政拒的图要能一眼看出"是因为涉政"');
  assert.equal(rec.pureText, false);
  assert.equal(rec.phash, '1818181818181818', '感知哈希要落进留样（将来去重那一步要比它）');
  // 索引行里也要有 —— 这样 `grep political` 就能筛，不用逐个打开侧车 json
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(line.political, true);
  assert.equal(line.pureText, false);
  assert.equal(line.phash, '1818181818181818');

  // `ok:false`（没看成）时这三个字段给的是**确定值**（调用方不用写防御）
  const dir2 = tmpDir('newfields-failed');
  const audit2 = createStickerAudit({ config: { dir: dir2, maxFiles: 10, maxBytes: 1e9 } });
  const data2 = bytesOf('not-looked-2');
  await audit2.save({ data: data2, mediaType: 'image/png', verdict: { ok: false, accept: false, reject: null, rejects: [], scores: null } });
  const rec2 = JSON.parse(fs.readFileSync(path.join(dir2, `${auditHashOf(data2)}.json`), 'utf8'));
  assert.equal(rec2.political, false, '没看成 ⇒ false（和 portrait/screenshot 同一条口径）');
  assert.equal(rec2.pureText, false);
  assert.equal(rec2.phash, '', '没看成 ⇒ 空串（不是 null，也不是猜一个）');
});

test('★★ `ok:false`（没看成）也要留，而且 accept/reject 保持 null（别伪装成"判它不合格"）', async () => {
  const dir = tmpDir('failed');
  const audit = createStickerAudit({ config: { dir, maxFiles: 10, maxBytes: 1e9 } });
  const data = bytesOf('not-looked-at');
  const hash = auditHashOf(data);
  await audit.save({
    data, mediaType: 'image/png',
    verdict: { ok: false, accept: false, reject: null, rejects: [], scores: null },
    thresholds: THRESHOLDS,
    notes: ['scores-invalid'],
  });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, `${hash}.json`), 'utf8'));
  assert.equal(rec.ok, false);
  assert.equal(rec.accept, false);
  assert.equal(rec.reject, null, '"没看成"不能写成"拒了"');
  assert.equal(rec.scores, null);
  assert.deepEqual(rec.notes, ['scores-invalid']);
  assert.equal(fs.existsSync(path.join(dir, `${hash}.png`)), true);
});

test('收下的图也留一份（两种语义的目录各自都有 —— 用户要的是对照）', async () => {
  const dir = tmpDir('accepted');
  const audit = createStickerAudit({ config: { dir, maxFiles: 10, maxBytes: 1e9 } });
  const data = bytesOf('accepted-1');
  await audit.save({ data, mediaType: 'image/png', verdict: verdictOf({ accept: true, reject: null, scores: { nsfw: 0, violence: 0, gore: 0, ugly: 1, funny: 8 } }), thresholds: THRESHOLDS });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, `${auditHashOf(data)}.json`), 'utf8'));
  assert.equal(rec.accept, true);
  assert.equal(rec.reject, null);
});

// ─────────────────────────────────────────────── 同一张图第二次

test('★ 同一张图第二次：**图不重写、json 更新**，索引照旧追加一行', async () => {
  const dir = tmpDir('twice');
  const audit = createStickerAudit({ config: { dir, maxFiles: 10, maxBytes: 1e9 } });
  const data = bytesOf('same-image');
  const hash = auditHashOf(data);
  await audit.save({ data, mediaType: 'image/png', verdict: verdictOf({ reject: 'ugly' }), thresholds: THRESHOLDS });
  const imgPath = path.join(dir, `${hash}.png`);
  const mtime1 = fs.statSync(imgPath).mtimeMs;

  await new Promise((r) => setTimeout(r, 20));
  await audit.save({ data, mediaType: 'image/png', verdict: verdictOf({ accept: true, reject: null }), thresholds: { ...THRESHOLDS, uglyMax: 8 } });

  assert.equal(fs.statSync(imgPath).mtimeMs, mtime1, '图不该被重写（内容一样）');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, `${hash}.json`), 'utf8'));
  assert.equal(rec.accept, true, 'json 要更新成最新那次');
  assert.equal(rec.thresholds.uglyMax, 8, '阈值也要是最新那次的');
  assert.equal(audit.stats().wrote, 1, '第一次算 wrote');
  assert.equal(audit.stats().updated, 1, '第二次算 updated');
  assert.equal(audit.stats().fileSkips, 1);
  const lines = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, '索引是历史，两次都要有');
});

// ─────────────────────────────────────────────── 上限与淘汰

test('★★ 超过 maxFiles ⇒ 淘汰最旧的图，而且**侧车 .json 一起删**', async () => {
  const dir = tmpDir('prune-count');
  const audit = createStickerAudit({ config: { dir, maxFiles: 3, maxBytes: 1e9, index: true } });
  const hashes = [];
  for (let i = 0; i < 5; i++) {
    const data = bytesOf(`prune-${i}`);
    hashes.push(auditHashOf(data));
    await audit.save({ data, mediaType: 'image/png', verdict: verdictOf(), thresholds: THRESHOLDS });
    await new Promise((r) => setTimeout(r, 12)); // 让 mtime 能区分先后
  }
  await audit.prune();
  const imgs = fs.readdirSync(dir).filter((n) => n.endsWith('.png'));
  assert.equal(imgs.length, 3, '要压回 maxFiles');
  // 最旧的两个（hashes[0], hashes[1]）该没了，且它们的 json 也不该剩
  assert.equal(fs.existsSync(path.join(dir, `${hashes[0]}.png`)), false);
  assert.equal(fs.existsSync(path.join(dir, `${hashes[0]}.json`)), false, '侧车要一起删（否则点进去发现图没了）');
  assert.equal(fs.existsSync(path.join(dir, `${hashes[4]}.png`)), true, '最新的必须留着');
  assert.ok(audit.stats().evicted >= 2);
});

test('★ 超过 maxBytes ⇒ 也淘汰（张数没超也照样压）', async () => {
  const dir = tmpDir('prune-bytes');
  const audit = createStickerAudit({ config: { dir, maxFiles: 999, maxBytes: 60, index: false } });
  for (let i = 0; i < 4; i++) {
    await audit.save({ data: bytesOf(`bytes-${i}`), mediaType: 'image/png', verdict: verdictOf(), thresholds: THRESHOLDS });
    await new Promise((r) => setTimeout(r, 12));
  }
  await audit.prune();
  const imgs = fs.readdirSync(dir).filter((n) => n.endsWith('.png'));
  const total = imgs.reduce((s, n) => s + fs.statSync(path.join(dir, n)).size, 0);
  assert.ok(total <= 60, `总字节要压回上限内，实际 ${total}`);
  assert.ok(imgs.length < 4);
});

test('索引超行数上限 ⇒ 只保留尾部（别让它无声长大）', async () => {
  const dir = tmpDir('index-trim');
  const audit = createStickerAudit({ config: { dir, maxFiles: 999, maxBytes: 1e9, index: true, maxIndexLines: 4 } });
  for (let i = 0; i < 12; i++) {
    await audit.save({ data: bytesOf(`idx-${i}`), mediaType: 'image/png', verdict: verdictOf(), thresholds: THRESHOLDS });
  }
  await audit.prune();
  const lines = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split('\n').filter((l) => l !== '');
  assert.ok(lines.length <= 6, `索引该被裁到上限附近，实际 ${lines.length}`);
  assert.ok(lines.length >= 4);
  // 尾部必须是最新的那几条
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.md5, auditHashOf(bytesOf('idx-11')));
});

// ─────────────────────────────────────────────── 绝不影响主流程

test('★★ 写盘失败 ⇒ **不抛异常**、不改变判定，而且连续失败会自动断开', async () => {
  const dir = tmpDir('fail');
  const logs = [];
  // 注入一个"写就报错"的 fs：模拟目录不可写/磁盘满
  const failingFs = {
    mkdirSync: () => {},
    existsSync: () => false,
    writeFileSync: () => { throw new Error('EACCES: nope'); },
    renameSync: () => {},
    appendFileSync: () => {},
    readFileSync: () => '',
    readdirSync: () => [],
    statSync: () => ({ mtimeMs: 0, size: 0 }),
    rmSync: () => {},
  };
  const audit = createStickerAudit({ config: { dir, maxFiles: 5, maxBytes: 1e9 }, fsImpl: failingFs, log: (l, m) => logs.push({ l, m }) });
  // save 不许抛
  const got = await audit.save({ data: bytesOf('boom'), mediaType: 'image/png', verdict: verdictOf(), thresholds: THRESHOLDS });
  assert.equal(got, null);
  assert.equal(audit.stats().failed, 1);
  for (let i = 0; i < 5; i++) await audit.save({ data: bytesOf(`boom-${i}`), mediaType: 'image/png', verdict: verdictOf(), thresholds: THRESHOLDS });
  assert.equal(audit.stats().disabled, true, '连续失败要断开（免得每条消息都撞一次）');
  assert.equal(audit.enabled(), false);
  assert.equal(logs.some((x) => x.m.includes('断开')), true, '断开这件事必须留痕');
  // 断开后再 save 直接返回，不再尝试
  const before = audit.stats().failed;
  await audit.save({ data: bytesOf('after'), mediaType: 'image/png', verdict: verdictOf() });
  assert.equal(audit.stats().failed, before, '断开后不该继续撞');
});

test('prune 在目录不存在 / fs 抛错时不炸（它在插件启动时就被调用）', async () => {
  const audit = createStickerAudit({
    config: { dir: 'H:\\nope\\nope-audit-dir', maxFiles: 1, maxBytes: 1 },
    log: () => {},
  });
  const got = await audit.prune();
  assert.equal(typeof got.evicted, 'number');
});

test('没给 data / 不是 Uint8Array ⇒ 直接跳过（不写空文件）', async () => {
  const dir = tmpDir('nodata');
  const audit = createStickerAudit({ config: { dir, maxFiles: 5, maxBytes: 1e9 } });
  assert.equal(await audit.save({ mediaType: 'image/png', verdict: verdictOf() }), null);
  assert.equal(await audit.save({ data: new Uint8Array(0), mediaType: 'image/png', verdict: verdictOf() }), null);
  assert.equal(await audit.save({ data: 'not-bytes', mediaType: 'image/png', verdict: verdictOf() }), null);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('认不出的 mediaType ⇒ 扩展名用 .bin（不猜，免得预览器打不开）', async () => {
  const dir = tmpDir('binext');
  const audit = createStickerAudit({ config: { dir, maxFiles: 5, maxBytes: 1e9 } });
  const data = bytesOf('weird');
  await audit.save({ data, mediaType: 'application/octet-stream', verdict: verdictOf(), thresholds: THRESHOLDS });
  assert.equal(fs.existsSync(path.join(dir, `${auditHashOf(data)}.bin`)), true);
});

test('stats 报出目录/上限，便于调试快照回答"存哪儿了"', () => {
  const dir = tmpDir('stats');
  const audit = createStickerAudit({ config: { dir, maxFiles: 7, maxBytes: 1234 } });
  const st = audit.stats();
  assert.equal(st.dir, dir);
  assert.equal(st.maxFiles, 7);
  assert.equal(st.maxBytes, 1234);
  assert.equal(st.wrote, 0);
  assert.equal(st.disabled, false);
  assert.equal(audit.dir(), dir);
});
