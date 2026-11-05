/**
 * `dsh/image-cache.mjs`：**本地原件查找** + **内容哈希** + **跨会话描述表**。
 *
 * ## 这些用例在钉什么（都是用户点名要求的）
 *
 * | 组 | 钉的是 |
 * |---|---|
 * | 目录模板 | `{qq}` / `{yyyy-mm}` / `*` 的展开；**默认值里不许有写死的账号** |
 * | 名字候选 | 大小写（段里大写、盘上小写）+ **GUID → md5** 两种写法 |
 * | 查找 | 零网络、找不到就如实返回 null、**不偷偷翻别人的账号目录** |
 * | 内容哈希 | 算的是**原件** |
 * | 描述表 | 跨会话可读、**坏了当空表**、有上限、写不进去也不抛 |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_DESC_TABLE_PATH,
  DEFAULT_ORIGINAL_DIRS,
  DESC_TABLE_VERSION,
  MAX_MONTH_DIRS,
  contentHashNameOf,
  createDescTable,
  createOriginalFinder,
  expandOriginalDir,
  findOriginalInDirs,
  md5Hex,
  originalNameCandidates,
  sha256Hex,
} from '../src/dsh/image-cache.mjs';
import { dshHome } from '../src/dsh/paths.mjs';

/** 造一个临时目录。 */
function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqimg-${tag}-`));
}

// ─────────────────────────────────────────────────────────── 目录模板

test('★ 默认模板**只认 {qq}** —— 绝不写死任何账号（用户特别警告过）', () => {
  // 用户原话：「很有可能你看到的是我的账号保存的图片，不是小鲸鱼账号保存的……
  //            绝对不要偷偷用"用户账号"的路径 —— 那是碰巧现在能用，以后一定出错」。
  for (const tpl of DEFAULT_ORIGINAL_DIRS) {
    assert.match(tpl, /\{qq\}/, `模板 ${tpl} 必须用 {qq} 占位`);
  }
  const joined = DEFAULT_ORIGINAL_DIRS.join('|');
  assert.doesNotMatch(joined, /30000001/, '**用户账号的号码绝不能出现在默认值里**');
  assert.doesNotMatch(joined, /30000002/, '小鲸鱼自己的号码也不硬编码（要跟着配置走）');
  assert.doesNotMatch(joined, /Image\\\\Group2/, '旧版布局（Image\\Group2）是用户账号那边的形状，不进默认值');
});

test('expandOriginalDir：{qq} / {yyyy-mm} / {yyyy} / {mm} 都要换掉', () => {
  const now = new Date(2026, 9, 7); // 2026-10-07
  assert.deepEqual(
    expandOriginalDir('D:\\QQNT\\data\\{qq}\\nt_qq\\nt_data\\Pic\\{yyyy-mm}\\Ori', { botQQ: '30000002', now }),
    ['D:\\QQNT\\data\\30000002\\nt_qq\\nt_data\\Pic\\2026-10\\Ori'],
  );
  assert.deepEqual(
    expandOriginalDir('X:\\{yyyy}\\{mm}\\{yyyy-mm}', { botQQ: '1', now }),
    ['X:\\2026\\10\\2026-10'],
  );
});

test('★ expandOriginalDir：**没配 botQQ 就返回空**（模板要 {qq} 却不给号 = 这条路不通，绝不猜号码）', () => {
  assert.deepEqual(expandOriginalDir('D:\\QQNT\\data\\{qq}\\Pic', { botQQ: '' }), []);
  assert.deepEqual(expandOriginalDir('D:\\QQNT\\data\\{qq}\\Pic', { botQQ: '   ' }), []);
  // 不含 {qq} 的模板不受影响
  assert.deepEqual(expandOriginalDir('D:\\fixed\\Pic', { botQQ: '' }), ['D:\\fixed\\Pic']);
  assert.deepEqual(expandOriginalDir('', { botQQ: '1' }), []);
});

test('expandOriginalDir：`*` 只展开"年-月"目录、从新到旧、有上限', () => {
  const dir = tmpdir('star');
  for (const name of ['2026-08', '2026-09', '2026-10', 'OriTemp', 'ThumbTemp', 'notes.txt']) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
  }
  const got = expandOriginalDir(`${dir}\\*\\Ori`, { botQQ: 'x' });
  assert.deepEqual(got, [
    path.join(dir, '2026-10', 'Ori'),
    path.join(dir, '2026-09', 'Ori'),
    path.join(dir, '2026-08', 'Ori'),
  ], '只认 YYYY-MM，且从新到旧（OriTemp 这种不能被当成月份）');

  // 上限
  const many = tmpdir('star-many');
  for (let m = 1; m <= 12; m += 1) fs.mkdirSync(path.join(many, `2026-${String(m).padStart(2, '0')}`));
  assert.equal(expandOriginalDir(`${many}\\*`, { botQQ: 'x' }).length, MAX_MONTH_DIRS);

  // 目录不存在 → 空（不是抛异常）
  assert.deepEqual(expandOriginalDir('Z:\\nope\\*\\Ori', { botQQ: 'x' }), []);
});

// ─────────────────────────────────────────────────────────── 名字候选

test('★ originalNameCandidates：**大小写**与 **GUID→md5** 两种写法都要覆盖', () => {
  // 实测：段里给的是大写 md5，盘上的文件名是小写 —— 不归一化就 100% 落空。
  const upper = originalNameCandidates({ file: 'C54E377436E966E2392170AAE864AD52.PNG' });
  assert.equal(upper.includes('C54E377436E966E2392170AAE864AD52.PNG'), true);
  assert.equal(upper.includes('c54e377436e966e2392170aae864ad52.png'), true);

  // 实测：群里收的表情包，段里是 GUID 写法，盘上是裸 md5。
  const guid = originalNameCandidates({ file: '{CBFBAC6B-E70B-2861-1B1B-CE19328D1AFB}.gif' });
  assert.equal(guid.includes('cbfbac6be70b28611b1bce19328d1afb.gif'), true);

  // URL 形状 → 取最后一段
  const fromUrl = originalNameCandidates({ url: 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=abc' });
  assert.equal(fromUrl.includes('download'), true, 'URL 取 pathname 最后一段（多半没用，但不能炸）');

  assert.deepEqual(originalNameCandidates({}), []);
  assert.deepEqual(originalNameCandidates(null), []);
});

test('contentHashNameOf：只有"32 位十六进制"形状才算内容哈希名', () => {
  assert.equal(contentHashNameOf({ file: 'C54E377436E966E2392170AAE864AD52.png' }), 'c54e377436e966e2392170aae864ad52.png');
  assert.equal(contentHashNameOf({ file: '{CBFBAC6B-E70B-2861-1B1B-CE19328D1AFB}.gif' }), 'cbfbac6be70b28611b1bce19328d1afb.gif');
  assert.equal(contentHashNameOf({ file: 'a.gif' }), null, '普通名字不是内容哈希，别拿它当键');
  assert.equal(contentHashNameOf({ url: 'https://x/y.jpg' }), null);
});

// ─────────────────────────────────────────────────────────── 查找

test('findOriginalInDirs：大小写不敏感 + GUID 归一化，能找到就返回字节', () => {
  const dir = tmpdir('find');
  const lower = 'cbfbac6be70b28611b1bce19328d1afb.gif';
  fs.writeFileSync(path.join(dir, lower), Buffer.from('GIF89a-hello'));
  fs.writeFileSync(path.join(dir, 'other.jpg'), Buffer.from('nope'));

  const byGuid = findOriginalInDirs({ dirs: [dir], segment: { file: '{CBFBAC6B-E70B-2861-1B1B-CE19328D1AFB}.gif' } });
  assert.ok(byGuid !== null);
  assert.equal(byGuid.path, path.join(dir, lower));
  assert.equal(Buffer.from(byGuid.data).toString('utf8'), 'GIF89a-hello');

  const byUpper = findOriginalInDirs({ dirs: [dir], segment: { file: lower.toUpperCase() } });
  assert.ok(byUpper !== null, '盘上小写、段里大写也要找得到');

  assert.equal(findOriginalInDirs({ dirs: [dir], segment: { file: 'missing.png' } }), null);
  assert.equal(findOriginalInDirs({ dirs: ['Z:\\nope'], segment: { file: lower } }), null);
  assert.equal(findOriginalInDirs({ dirs: [dir], segment: {} }), null);
});

test('★ createOriginalFinder：段里给了**本机绝对路径**就直接读（NapCat 真的会给这种段）', () => {
  const dir = tmpdir('abs');
  const file = path.join(dir, 'local.gif');
  fs.writeFileSync(file, Buffer.from('GIF89a-local'));

  const finder = createOriginalFinder({ dirs: [], botQQ: '1' });
  const got = finder.find({ url: file });
  assert.ok(got !== null);
  assert.equal(got.via, 'segment-path');
  assert.equal(Buffer.from(got.data).toString('utf8'), 'GIF89a-local');

  // file:// 也要认
  const asUrl = `file:///${file.replace(/\\/g, '/')}`;
  assert.equal(finder.find({ file: asUrl })?.via, 'segment-path');

  // 不存在的路径 → 落到"按名字找" → 也找不到 → null（不抛）
  assert.equal(finder.find({ url: path.join(dir, 'nope.gif') }), null);
});

test('createOriginalFinder：按名字找得到时标 via=local-name；目录模板每次都重新展开', () => {
  const dir = tmpdir('finder');
  const name = 'a'.repeat(32) + '.gif';
  fs.writeFileSync(path.join(dir, name), Buffer.from('GIF89a-1'));
  const finder = createOriginalFinder({ dirs: [dir], botQQ: '30000002' });
  assert.deepEqual(finder.dirs(), [dir]);

  const got = finder.find({ file: name });
  assert.equal(got?.via, 'local-name');
  assert.equal(got?.name, name);

  // 模板里的 {qq} 用的是传进来的号 —— 换成别的号就找不到（证明账号是从配置走的）
  const other = createOriginalFinder({ dirs: [`${dir}\\{qq}`], botQQ: '42' });
  assert.equal(other.find({ file: name }), null);
  assert.deepEqual(other.dirs(), [`${dir}\\42`]);
});

test('createOriginalFinder：没配 botQQ 又用了 {qq} 模板时，记一条 warn（不静默）', () => {
  const logs = [];
  const finder = createOriginalFinder({
    dirs: ['D:\\data\\{qq}\\Pic'],
    botQQ: '',
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });
  assert.equal(finder.find({ file: 'a.gif' }), null);
  assert.equal(logs.length, 1, '这条路走不通必须说出来');
  assert.equal(logs[0].level, 'warn');
  // 只提醒一次，别每张图刷一条
  finder.find({ file: 'b.gif' });
  assert.equal(logs.length, 1);
});

// ─────────────────────────────────────────────────────────── 哈希

test('sha256Hex / md5Hex：算的是**给定的那串字节**（原件语义）', () => {
  const bytes = new Uint8Array(Buffer.from('abcdef'));
  // 硬编码的期望值（`sha256(md5) of "abcdef"`）—— 钉住"算法与编码格式别再变"
  assert.equal(sha256Hex(bytes), 'bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721');
  assert.equal(md5Hex(bytes), 'e80b5017098950fc58aad83c8c14978e');
  // 不同字节必须不同键（同一张图从哪来都一样，不同的图绝不能撞在一条描述上）
  assert.notEqual(sha256Hex(bytes), sha256Hex(new Uint8Array(Buffer.from('abcdeg'))));
});

// ─────────────────────────────────────────────────────────── 描述缓存表

test('★ createDescTable：写完能被**另一个实例**读到（这就是"跨会话"）', () => {
  const dir = tmpdir('table');
  const file = path.join(dir, 'desc.json');
  const a = createDescTable({ filePath: file });
  assert.equal(a.loaded, 0);
  assert.equal(a.get('sha256:xx'), null);

  assert.equal(a.set('sha256:xx', { text: '一只橘猫', source: 'gif' }), true);
  assert.equal(fs.existsSync(file), true, '插件常驻，写表要真的落盘');

  const b = createDescTable({ filePath: file });
  assert.equal(b.loaded, 1);
  assert.deepEqual(b.get('sha256:xx'), { text: '一只橘猫', source: 'gif' });
  assert.deepEqual(b.stats(), { hits: 1, misses: 0, writes: 0, dropped: 0, size: 1, degraded: false, enabled: true });
});

test('★ createDescTable：**表坏了当空表**（表是缓存不是真相，绝不能变成单点故障）', () => {
  const dir = tmpdir('table-bad');
  const file = path.join(dir, 'desc.json');

  // ① JSON 坏了
  fs.writeFileSync(file, '{ this is not json');
  const broken = createDescTable({ filePath: file });
  assert.equal(broken.loaded, 0);
  assert.equal(broken.stats().degraded, true, '坏了要标 degraded（日志里能看出来）');
  assert.equal(broken.get('sha256:any'), null);
  // 而且还能照常写入（把坏文件盖掉，自我修复）
  assert.equal(broken.set('sha256:new', { text: '新描述', source: '' }), true);
  assert.equal(createDescTable({ filePath: file }).get('sha256:new')?.text, '新描述');

  // ② 版本对不上
  fs.writeFileSync(file, JSON.stringify({ version: DESC_TABLE_VERSION + 1, entries: { 'sha256:x': { text: '旧版本' } } }));
  const wrongVersion = createDescTable({ filePath: file });
  assert.equal(wrongVersion.loaded, 0);
  assert.equal(wrongVersion.stats().degraded, true);

  // ③ 文件不存在 = 正常（第一次跑），不该标 degraded
  const fresh = createDescTable({ filePath: path.join(dir, 'not-yet.json') });
  assert.equal(fresh.loaded, 0);
  assert.equal(fresh.stats().degraded, false);
});

test('createDescTable：条目有上限，超了淘汰最旧的（描述丢了会重算，不会错）', () => {
  const dir = tmpdir('table-cap');
  const file = path.join(dir, 'desc.json');
  let clock = 1000;
  const table = createDescTable({ filePath: file, maxEntries: 2, now: () => (clock += 1000) });
  table.set('sha256:a', { text: 'A' });
  table.set('sha256:b', { text: 'B' });
  table.set('sha256:c', { text: 'C' });
  assert.equal(table.stats().size, 2);
  assert.equal(table.get('sha256:a'), null, '最旧的那条被淘汰');
  assert.equal(table.get('sha256:c')?.text, 'C');
  assert.equal(table.stats().dropped, 1);
});

test('createDescTable：写不进去 / 关掉表 / 空值 —— 一律不抛，只是这条缓存没有了', () => {
  // 目录不存在 → writeFileSync 抛 ENOENT，必须被吞掉（只记 warn）
  const logs = [];
  const file = path.join(tmpdir('table-wr'), 'no-such-dir', 'x.json');
  const bad = createDescTable({ filePath: file, log: (level, message) => logs.push({ level, message }) });
  assert.equal(bad.set('sha256:a', { text: 'A' }), true, '内存里收下了（这一轮照样能命中）');
  assert.deepEqual(bad.get('sha256:a'), { text: 'A', source: '' });
  assert.equal(bad.stats().writes, 0, '没真的落盘');
  assert.equal(logs.length, 1, '写失败要说出来，不能静默');
  assert.equal(logs[0].level, 'warn');
  assert.equal(fs.existsSync(file), false);
  assert.equal(createDescTable({ filePath: file }).loaded, 0, '换个实例读：当然没有（没落盘）');

  // 空路径 = 明确关掉
  const off = createDescTable({ filePath: '' });
  assert.equal(off.stats().enabled, false);
  assert.equal(off.set('sha256:a', { text: 'A' }), false);
  assert.equal(off.get('sha256:a'), null);

  // 空键 / 空描述不写（避免把"没描述"当成一条缓存存下来）
  const dir = tmpdir('table-empty');
  const table = createDescTable({ filePath: path.join(dir, 'd.json') });
  assert.equal(table.set('', { text: 'A' }), false);
  assert.equal(table.set('sha256:a', { text: '   ' }), false);
  assert.equal(table.stats().size, 0);
});

test('DEFAULT_DESC_TABLE_PATH：放在 <DSH_HOME>/media 下', () => {
  assert.equal(DEFAULT_DESC_TABLE_PATH, path.join(dshHome(), 'media', 'qq-image-desc.json'));
  assert.doesNotMatch(DEFAULT_DESC_TABLE_PATH, /deepseek-harness[\\/]workspace/, '不要放进工作区（那是项目的地盘）');
});
