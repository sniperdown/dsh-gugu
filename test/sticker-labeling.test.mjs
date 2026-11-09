/**
 * 表情包人工标注（`src/dsh/sticker-labeling.mjs`，2026-11-06）。
 *
 * 这一批盯的是四件事，每件都可能**静默错**：
 *
 * 1. **抽样覆盖**：库里 180/228 是「卖萌可爱」，随机抽必然一屏全是它（用户原话
 *    "别 12 张全是卖萌可爱"）。所以抽的是"主标签轮转"，要能断言"12 张里主标签不重复"。
 * 2. **落库不毁库**：写 `qq-stickers.json` 必须先备份、临时文件 + rename；
 *    `tags` / `desc` 一个字节都不能动；`modelTags` / `modelDesc` 只在首次标注时拷一份。
 * 3. **失败可回滚**：重命名失败 / 备份失败时原文件保持原样，并且**不抛**。
 * 4. **字段不会被抹掉**：`sticker-library` 的 `persist()` 是按内存形状整份重写的 ——
 *    它不认识 `manual*` 的话，下一次 `seen` 自增就把人工标注洗掉了，而磁盘上看起来"什么都没发生"。
 *
 * 全部用例都在 `mkdtemp` 出来的临时目录里跑，**不读本机真实数据**
 * （默认路径指向 `<DSH_HOME>\media\…`，那是线上库）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { createStickerIndex } from '../src/dsh/sticker-library.mjs';
import {
  ANNOTATE_TAGS,
  LABEL_DATASET_SCHEMA,
  MANUAL_VERDICTS,
  backupStamp,
  clampBatchSize,
  computeAccuracy,
  createStickerAnnotator,
  createStickerLabelRoutes,
  normalizeManualDesc,
  normalizeManualTags,
  normalizeVerdict,
  sampleBatch,
} from '../src/dsh/sticker-labeling.mjs';

// ------------------------------------------------------------------ 夹具

const T0 = Date.UTC(2026, 10, 6, 0, 0, 0);
/** 32 位十六进制、首位是 b（与真实 md5 同形，但不会是任何随机数）。 */
const md5Of = (i) => `b${i.toString(16).padStart(31, '0')}`;

/** 造一个隔离目录。 */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-label-'));
}

/**
 * 写一份库文件。`entries` 是 `[md5, 覆盖字段]` 的数组；默认给一个能用的 file。
 */
function writeLibrary(dir, entries, extra = {}) {
  const map = {};
  for (const [md5, override] of entries) {
    map[md5] = {
      file: `${md5}.png`,
      path: path.join(dir, `${md5}.png`),
      emojiId: '',
      packageId: null,
      at: new Date(T0).toISOString(),
      seen: 0,
      uses: 0,
      lastUsedAt: null,
      tags: [],
      desc: '',
      source: { chatId: '', userId: '' },
      ...override,
    };
  }
  const indexPath = path.join(dir, 'qq-stickers.json');
  fs.writeFileSync(indexPath, JSON.stringify({
    version: 1,
    updatedAt: new Date(T0).toISOString(),
    entries: map,
    ...extra,
  }, null, 2));
  return indexPath;
}

/** 写一张"图"（内容不重要，只验读得到字节）。 */
function writeImage(dir, md5, bytes = 'png-bytes') {
  fs.writeFileSync(path.join(dir, `${md5}.png`), bytes);
}

/** 一个隔离的标注器（注入固定时钟）。 */
function makeAnnotator(dir, options = {}) {
  const indexPath = path.join(dir, 'qq-stickers.json');
  return createStickerAnnotator({
    indexPath,
    dir,
    now: () => T0,
    ...options,
  });
}

/** 假 res：记下 status / headers / body。 */
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(body) {
      this.body = body === undefined ? '' : String(body);
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

/** 假 req：一个真正的 Readable（handler 用到 on/data/end），再挂上 method/url/headers。 */
function fakeReq(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

// ------------------------------------------------------------------ 规范化的纯函数

test('normalizeManualTags：只认 17 个、去重、按枚举顺序排', () => {
  assert.deepEqual(
    normalizeManualTags(['赞同支持', '不存在的标签', '卖萌可爱', '赞同支持', '  ']),
    ['卖萌可爱', '赞同支持'],
  );
  assert.deepEqual(normalizeManualTags('赞同支持'), ['赞同支持'], '单个字符串也认');
  assert.deepEqual(normalizeManualTags(null), []);
  assert.deepEqual(normalizeManualTags({ x: 1 }), []);
  assert.equal(ANNOTATE_TAGS.length, 17);
  assert.equal(ANNOTATE_TAGS.includes('社交互动'), false, '用户这份清单里没有社交互动');
  // 2026-11-06 追加的第 17 个：新标签必须在清单里，而且排在最后（前 16 个顺序不动）
  assert.equal(ANNOTATE_TAGS.includes('幸灾乐祸'), true, '新标签必须在人工可选清单里');
  assert.equal(ANNOTATE_TAGS[16], '幸灾乐祸', '追加项排最后');
  assert.deepEqual(normalizeManualTags(['幸灾乐祸']), ['幸灾乐祸'], '只勾新标签也得留下');
  assert.deepEqual(
    normalizeManualTags(['幸灾乐祸', '调侃吐槽']),
    ['调侃吐槽', '幸灾乐祸'],
    '混着勾时按枚举顺序排（老的在前）',
  );
});

test('normalizeVerdict / clampBatchSize / normalizeManualDesc', () => {
  assert.deepEqual([...MANUAL_VERDICTS], ['对', '半对', '错']);
  assert.equal(normalizeVerdict(' 半对 '), '半对');
  assert.equal(normalizeVerdict('差不多'), '', '认不出的判词 = 还没评');
  assert.equal(normalizeVerdict(null), '');

  assert.equal(clampBatchSize(undefined), 12, '默认 12');
  assert.equal(clampBatchSize('8'), 8);
  assert.equal(clampBatchSize(999), 30, '上限 30');
  assert.equal(clampBatchSize(0), 1, '至少 1');
  assert.equal(clampBatchSize('abc'), 12);

  assert.equal(normalizeManualDesc('  竖大拇指，赞同  '), '竖大拇指，赞同');
  assert.equal(normalizeManualDesc(null), '');
  assert.equal(normalizeManualDesc('x'.repeat(500)).length, 200, '一句描述，超长截断');
});

// ------------------------------------------------------------------ 抽样

test('抽样：一屏 12 张，主标签尽量不重复（稀有标签也会被抽到）', () => {
  const entries = [];
  // 巨桶（30 张「卖萌可爱」）+ 11 个各 2 张的小桶 = 12 个不同主标签
  for (let i = 0; i < 30; i += 1) entries.push({ md5: md5Of(i), tags: ['卖萌可爱'], manualAt: '' });
  const others = ANNOTATE_TAGS.filter((tag) => tag !== '卖萌可爱').slice(0, 11);
  others.forEach((tag, index) => {
    for (let k = 0; k < 2; k += 1) {
      entries.push({ md5: md5Of(100 + index * 10 + k), tags: [tag], manualAt: '' });
    }
  });

  const got = sampleBatch(entries, { size: 12, cursor: 0 });
  assert.equal(got.items.length, 12);
  const primaries = got.items.map((item) => item.tags[0]);
  assert.equal(new Set(primaries).size, 12, '12 张应有 12 个不同的主标签（逐桶轮流取）');
  assert.equal(got.items.filter((item) => item.tags[0] === '卖萌可爱').length, 1,
    '巨桶也只能占一张，否则就是用户说的"一屏全是卖萌可爱"');
  assert.equal(got.nextCursor, 1);
});

test('抽样：没标过的优先；不够一批才退回全库（重标）', () => {
  const fresh = Array.from({ length: 4 }, (_, i) => ({ md5: md5Of(i), tags: ['卖萌可爱'], manualAt: '' }));
  const marked = Array.from({ length: 10 }, (_, i) => ({
    md5: md5Of(100 + i), tags: ['幽默搞笑'], manualAt: new Date(T0).toISOString(),
  }));
  const small = sampleBatch([...fresh, ...marked], { size: 8, cursor: 0 });
  assert.equal(small.freshOnly, false);
  assert.equal(small.items.filter((item) => item.manualAt === '').length, 4, '4 张没标过的全都给到');
  assert.equal(small.items.length, 8);

  const enough = sampleBatch(
    [...Array.from({ length: 8 }, (_, i) => ({ md5: md5Of(i), tags: ['卖萌可爱'], manualAt: '' })), ...marked],
    { size: 6, cursor: 0 },
  );
  assert.equal(enough.freshOnly, true);
  assert.equal(enough.items.every((item) => item.manualAt === ''), true, '够一批时一张标过的都不混进来');
});

test('抽样：cursor 推进换一批（同一批不会永远是那 12 张，也不只挪一张）', () => {
  const entries = [];
  for (let i = 0; i < 40; i += 1) entries.push({ md5: md5Of(i), tags: ['卖萌可爱'], manualAt: '' });
  const first = sampleBatch(entries, { size: 12, cursor: 0 }).items.map((item) => item.md5);
  const second = sampleBatch(entries, { size: 12, cursor: 1 }).items.map((item) => item.md5);
  assert.notDeepEqual(first, second, '换一批必须真的换');
  assert.equal(new Set([...first, ...second]).size, 24,
    '两批之间不重复（桶内指针随 cursor 平移一整屏）');
});

test('抽样：空库 / 坏条目返回空数组，不抛', () => {
  assert.deepEqual(sampleBatch([], { size: 12 }).items, []);
  assert.deepEqual(sampleBatch(null, { size: 12 }).items, []);
  const got = sampleBatch([null, 42, { md5: md5Of(1), tags: ['卖萌可爱'] }], { size: 5 });
  assert.equal(got.items.length, 1);
});

// ------------------------------------------------------------------ 对账

test('computeAccuracy：命中率 / 多余率 / 三档计数', () => {
  const items = [
    // 人工两个标签，模型命中一个；模型共 3 个，多余 2 个
    { manualTags: ['卖萌可爱', '赞同支持'], modelTags: ['卖萌可爱', '玩梗接梗', '无语无奈'], manualVerdict: '半对', manualAt: 'x' },
    // 完全对上
    { manualTags: ['幽默搞笑'], modelTags: ['幽默搞笑'], manualVerdict: '对', manualAt: 'x' },
    // 全错
    { manualTags: ['生气不满'], modelTags: ['卖萌可爱'], manualVerdict: '错', manualAt: 'x' },
    // 没标（不计）
    { manualTags: [], modelTags: ['卖萌可爱'], manualVerdict: '', manualAt: '' },
  ];
  const acc = computeAccuracy(items);
  assert.equal(acc.annotated, 3);
  assert.equal(acc.tagRated, 3);
  assert.equal(acc.manualTagTotal, 4);
  assert.equal(acc.manualTagHit, 2);
  assert.equal(acc.manualTagMiss, 2);
  assert.equal(acc.tagRecall, 0.5);
  assert.equal(acc.modelTagTotal, 5);
  assert.equal(acc.modelTagExtra, 3);
  assert.equal(acc.tagExtraRate, 0.6);
  assert.equal(acc.tagPrecision, 0.4);
  assert.deepEqual(acc.verdicts, { 对: 1, 半对: 1, 错: 1 });
  assert.equal(acc.verdictStrict, 1 / 3);
  assert.equal(acc.verdictSoft, 0.5);
  const agree = acc.perTag.find((row) => row.tag === '赞同支持');
  assert.deepEqual([agree.manual, agree.hit, agree.model, agree.extra], [1, 0, 0, 0]);
});

test('computeAccuracy：还没标时所有比率是 null（不是 0%）', () => {
  const acc = computeAccuracy([]);
  assert.equal(acc.annotated, 0);
  assert.equal(acc.tagRecall, null);
  assert.equal(acc.tagExtraRate, null);
  assert.equal(acc.tagPrecision, null);
  assert.equal(acc.verdictStrict, null);
});

test('computeAccuracy：清单外的模型标签单独列（只算多余，不算遗漏）', () => {
  const acc = computeAccuracy([
    { manualTags: ['卖萌可爱'], modelTags: ['卖萌可爱', '社交互动'], manualVerdict: '半对', manualAt: 'x' },
  ]);
  assert.equal(acc.manualTagHit, 1);
  assert.equal(acc.modelTagExtra, 1);
  assert.deepEqual(acc.otherTags, [{ tag: '社交互动', model: 1, extra: 1 }]);
});

// ------------------------------------------------------------------ 读库 / 抽样接口

test('batch：返回图片地址与模型原判；图片不在盘上的条目被跳过', () => {
  const dir = tempDir();
  const md5a = md5Of(1);
  const md5b = md5Of(2);
  writeLibrary(dir, [
    [md5a, { tags: ['卖萌可爱'], desc: '微笑' }],
    [md5b, { tags: ['赞同支持'] }],
  ]);
  writeImage(dir, md5a);
  // md5b 的图**没有**落盘

  const annotator = makeAnnotator(dir);
  const got = annotator.batch({ size: 12, cursor: 0 });
  assert.equal(got.ok, true);
  assert.equal(got.items.length, 1, '缺图的条目不该出现在页面上（否则是一排碎图）');
  assert.equal(got.items[0].md5, md5a);
  assert.equal(got.items[0].imageUrl, `/dsh-qq-proactive/sticker-label/image?md5=${md5a}`);
  assert.deepEqual(got.items[0].tags, ['卖萌可爱']);
  assert.equal(got.items[0].desc, '微笑');
  assert.equal(got.items[0].annotated, false);
  assert.deepEqual(got.tagOptions, [...ANNOTATE_TAGS]);
  assert.deepEqual(got.verdictOptions, [...MANUAL_VERDICTS]);
  assert.equal(got.total, 2);
  assert.equal(got.missingFiles, 1);
});

test('batch：库文件不存在 / 坏 JSON 时返回 ok:false，不抛', () => {
  const dir = tempDir();
  const annotator = makeAnnotator(dir); // 没有 qq-stickers.json
  const missing = annotator.batch({ size: 12 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /还不存在|读不到/);

  fs.writeFileSync(path.join(dir, 'qq-stickers.json'), '{ 这不是 json');
  const broken = annotator.batch({ size: 12 });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /不是合法 JSON/);
});

// ------------------------------------------------------------------ 落库

test('save：写 manual*、保留 tags/desc、首次标注冻结 modelTags/modelDesc，并先备份', () => {
  const dir = tempDir();
  const md5 = md5Of(1);
  const indexPath = writeLibrary(dir, [[md5, { tags: ['玩梗接梗', '得意自信'], desc: '简笔画小人竖大拇指' }]]);
  writeImage(dir, md5);
  const annotator = makeAnnotator(dir);

  const result = annotator.save({
    md5,
    manualTags: ['赞同支持', '得意自信'],
    manualDesc: '竖大拇指 = 赞同',
    manualVerdict: '半对',
  });
  assert.equal(result.ok, true, result.error);
  const saved = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const entry = saved.entries[md5];
  assert.deepEqual(entry.tags, ['玩梗接梗', '得意自信'], '模型原判一个字节都不动');
  assert.equal(entry.desc, '简笔画小人竖大拇指');
  assert.deepEqual(entry.manualTags, ['得意自信', '赞同支持'], '按 16 个枚举的顺序规范化');
  assert.equal(entry.manualDesc, '竖大拇指 = 赞同');
  assert.equal(entry.manualVerdict, '半对');
  assert.equal(entry.manualAt, new Date(T0).toISOString());
  assert.deepEqual(entry.modelTags, ['玩梗接梗', '得意自信'], '首次标注把模型原判冻结一份');
  assert.equal(entry.modelDesc, '简笔画小人竖大拇指');

  const backups = fs.readdirSync(dir).filter((name) => name.includes('.bak-'));
  assert.equal(backups.length, 1, '写之前必须留一份同目录备份');
  assert.equal(backups[0], path.basename(result.backup));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, backups[0]), 'utf8')).entries[md5].manualTags, undefined,
    '备份里是写入前的内容');
});

test('★★ 新标签 `幸灾乐祸`：能存能读、不被校验丢掉（save → 磁盘 → batch → 报告）', () => {
  // 这条钉的是"新标签真的能用"，而不是"数组里多了一个字符串"。
  // 三类静默失效都在它的路径上：
  //   ① `normalizeManualTags` 不认识它 ⇒ 静默丢掉（`manualTags: []`），页面看起来"勾了但没存"；
  //   ② `sticker-library` 的读写把它当未知字段抹掉 ⇒ 下次 `seen` 自增就没了；
  //   ③ 报告/导出按 `ANNOTATE_TAGS` 建行 ⇒ 少了它，人工标了新标签在准确率里查不到。
  const dir = tempDir();
  const md5 = md5Of(50);
  const indexPath = writeLibrary(dir, [
    [md5, { tags: ['调侃吐槽'], desc: '像素笑脸抱着自己笑到流泪' }],
  ]);
  writeImage(dir, md5);
  const annotator = makeAnnotator(dir);

  const result = annotator.save({
    md5,
    manualTags: ['幸灾乐祸'],
    manualDesc: '纯嘲笑，不是安慰也不是自嘲',
    manualVerdict: '错',
  });
  assert.equal(result.ok, true, result.error);

  const entry = JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries[md5];
  assert.deepEqual(entry.manualTags, ['幸灾乐祸'], '新标签必须原样写进 qq-stickers.json');
  assert.deepEqual(entry.tags, ['调侃吐槽'], '模型原判一个字节都不动');
  assert.equal(entry.desc, '像素笑脸抱着自己笑到流泪');

  // 读回：页面拿到的胶囊清单里有它，条目上的勾选也在
  const batch = annotator.batch({ size: 12 });
  assert.equal(batch.ok, true);
  assert.equal(batch.tagOptions.length, ANNOTATE_TAGS.length);
  assert.ok(batch.tagOptions.includes('幸灾乐祸'), '页面胶囊清单里要有新标签');
  assert.deepEqual(batch.items[0].manualTags, ['幸灾乐祸'], '读回来的条目要带着它');

  // 对账：它有自己的统计行，而且算"人工给了、模型没命中"
  const report = annotator.report();
  const row = report.accuracy.perTag.find((candidate) => candidate.tag === '幸灾乐祸');
  assert.ok(row, '报告里要有新标签那一行');
  assert.deepEqual([row.manual, row.hit, row.model, row.extra], [1, 0, 0, 0]);
  assert.equal(report.accuracy.manualTagTotal, 1);
  assert.equal(report.accuracy.manualTagMiss, 1);
});

test('save：第二次保存不覆盖冻结的 modelTags（模型重跑改了 tags 也不污染基准）', () => {
  const dir = tempDir();
  const md5 = md5Of(3);
  const indexPath = writeLibrary(dir, [[md5, { tags: ['卖萌可爱'], desc: '旧描述' }]]);
  writeImage(dir, md5);
  const annotator = makeAnnotator(dir);

  assert.equal(annotator.save({ md5, manualTags: ['赞同支持'], manualVerdict: '错' }).ok, true);
  // 模拟模型重跑：原路覆盖 tags / desc（标注这条线**不碰**它们）
  const now = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  now.entries[md5].tags = ['玩梗接梗'];
  now.entries[md5].desc = '模型重跑的新描述';
  fs.writeFileSync(indexPath, JSON.stringify(now, null, 2));

  assert.equal(annotator.save({ md5, manualTags: ['赞同支持'], manualVerdict: '对' }).ok, true);
  const entry = JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries[md5];
  assert.deepEqual(entry.modelTags, ['卖萌可爱'], '基准还是第一次那天的模型判词');
  assert.equal(entry.modelDesc, '旧描述');
  assert.deepEqual(entry.tags, ['玩梗接梗'], '模型重跑后的 tags 保留原样');
  assert.equal(entry.desc, '模型重跑的新描述');
  assert.equal(entry.manualVerdict, '对', '人工判词更新');
});

test('save：空内容 / 坏 md5 一律拒绝，且一个字节都不写', () => {
  const dir = tempDir();
  const md5 = md5Of(4);
  const indexPath = writeLibrary(dir, [[md5, { tags: ['卖萌可爱'] }]]);
  writeImage(dir, md5);
  const before = fs.readFileSync(indexPath, 'utf8');
  const annotator = makeAnnotator(dir);

  assert.equal(annotator.save({ md5: '../../etc/passwd', manualVerdict: '对' }).ok, false);
  assert.equal(annotator.save({ md5, manualTags: [], manualDesc: '  ', manualVerdict: '' }).ok, false);
  assert.equal(annotator.save({ md5: md5Of(99), manualVerdict: '对' }).ok, false, '库里没有这一条');
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.bak-')).length, 0, '被拒的写入不留备份');
});

test('save：原子写 —— 用临时文件 + rename，成功后临时文件不残留', () => {
  const dir = tempDir();
  const md5 = md5Of(5);
  writeLibrary(dir, [[md5, { tags: ['卖萌可爱'] }]]);
  writeImage(dir, md5);
  const annotator = makeAnnotator(dir);
  assert.equal(annotator.save({ md5, manualTags: ['卖萌可爱'], manualVerdict: '对' }).ok, true);
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '临时文件必须 rename 掉');
});

test('save：rename 失败 ⇒ 原文件保持原样、临时文件清掉、不抛（可回滚）', () => {
  const dir = tempDir();
  const md5 = md5Of(6);
  const indexPath = writeLibrary(dir, [[md5, { tags: ['卖萌可爱'] }]]);
  writeImage(dir, md5);
  const before = fs.readFileSync(indexPath, 'utf8');
  const annotator = makeAnnotator(dir, {
    fsImpl: {
      ...fs,
      renameSync: () => { throw new Error('模拟 rename 失败'); },
    },
  });

  const result = annotator.save({ md5, manualTags: ['赞同支持'], manualVerdict: '对' });
  assert.equal(result.ok, false);
  assert.match(result.error, /写库失败/);
  assert.equal(result.rollback, 'not-needed', '原文件没被改，回滚无需动作');
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before, '原库一个字节都不能变');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.bak-')).length, 1, '备份留着，可手工恢复');
});

test('save：备份失败 ⇒ 直接不写（没有退路的写入比不写更糟）', () => {
  const dir = tempDir();
  const md5 = md5Of(7);
  const indexPath = writeLibrary(dir, [[md5, { tags: ['卖萌可爱'] }]]);
  writeImage(dir, md5);
  const before = fs.readFileSync(indexPath, 'utf8');
  const annotator = makeAnnotator(dir, {
    fsImpl: {
      ...fs,
      copyFileSync: () => { throw new Error('模拟备份失败'); },
    },
  });
  const result = annotator.save({ md5, manualTags: ['赞同支持'], manualVerdict: '对' });
  assert.equal(result.ok, false);
  assert.match(result.error, /备份失败/);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
});

test('save：坏条目 / 坏条目字段不影响别的条目（跳过这一条，不整库报废）', () => {
  const dir = tempDir();
  const good = md5Of(8);
  const indexPath = writeLibrary(dir, [
    ['not-an-md5', { tags: ['卖萌可爱'], file: 'x.png' }],
    [md5Of(9), { tags: ['卖萌可爱'], file: '' }],
    [good, { tags: ['幽默搞笑'] }],
  ]);
  writeImage(dir, good);
  const annotator = makeAnnotator(dir);
  const batch = annotator.batch({ size: 12 });
  assert.equal(batch.ok, true);
  assert.equal(batch.total, 1, '坏条目被跳过（缺文件名 / 键不是 md5）');
  const result = annotator.save({ md5: good, manualTags: ['幽默搞笑'], manualVerdict: '对' });
  assert.equal(result.ok, true);
  const saved = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.ok(saved.entries['not-an-md5'], '坏条目原样留在文件里（只是不参与标注）');
});

test('save：onSaved 回调把标注字段同步出去（sticker-library 的内存同步钩子）', () => {
  const dir = tempDir();
  const md5 = md5Of(10);
  writeLibrary(dir, [[md5, { tags: ['卖萌可爱'] }]]);
  const calls = [];
  const annotator = makeAnnotator(dir, { onSaved: (key, patch) => calls.push([key, patch]) });
  assert.equal(annotator.save({ md5, manualTags: ['赞同支持'], manualVerdict: '对' }).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], md5);
  assert.deepEqual(calls[0][1].manualTags, ['赞同支持']);
  assert.equal(calls[0][1].manualVerdict, '对');
});

// ------------------------------------------------------------------ 图片

test('readImage：按 md5 找文件、给出 content-type；非法 md5 / 缺图都不抛', () => {
  const dir = tempDir();
  const md5 = md5Of(11);
  writeLibrary(dir, [[md5, { tags: ['卖萌可爱'] }]]);
  writeImage(dir, md5, 'fake-png');
  const annotator = makeAnnotator(dir);

  const got = annotator.readImage(md5);
  assert.equal(got.ok, true);
  assert.equal(got.contentType, 'image/png');
  assert.equal(Buffer.from(got.bytes).toString(), 'fake-png');
  assert.equal(annotator.readImage('../qq-stickers.json').ok, false);
  assert.equal(annotator.readImage(md5Of(12)).ok, false, '库里没有的 md5');
});

test('readImage：条目文件名带路径穿越 ⇒ 拒绝（只取 basename 比对）', () => {
  const dir = tempDir();
  const md5 = md5Of(13);
  writeLibrary(dir, [[md5, { tags: ['卖萌可爱'], file: '../../secret.png' }]]);
  const annotator = makeAnnotator(dir);
  const got = annotator.readImage(md5);
  assert.equal(got.ok, false);
  assert.match(got.error, /不安全/);
});

// ------------------------------------------------------------------ 报告 / 导出

test('report / export：只统计标过的条目，schema 与字段齐全', () => {
  const dir = tempDir();
  const md5a = md5Of(20);
  const md5b = md5Of(21);
  writeLibrary(dir, [
    [md5a, { tags: ['卖萌可爱'], desc: 'a' }],
    [md5b, { tags: ['无语无奈'], desc: '' }],
  ]);
  writeImage(dir, md5a);
  writeImage(dir, md5b);
  const annotator = makeAnnotator(dir);
  annotator.save({ md5: md5a, manualTags: ['赞同支持'], manualDesc: '竖大拇指', manualVerdict: '错' });

  const report = annotator.report();
  assert.equal(report.ok, true);
  assert.equal(report.annotated, 1);
  assert.equal(report.total, 2);
  assert.equal(report.accuracy.manualTagTotal, 1);
  assert.equal(report.accuracy.manualTagHit, 0);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].md5, md5a);

  const exported = annotator.exportDataset();
  assert.equal(exported.ok, true);
  assert.equal(exported.payload.schema, LABEL_DATASET_SCHEMA);
  assert.equal(exported.payload.annotated, 1);
  assert.equal(exported.payload.items.length, 1);
  const item = exported.payload.items[0];
  for (const key of ['md5', 'file', 'modelTags', 'modelDesc', 'manualTags', 'manualDesc', 'manualVerdict', 'manualAt', 'tags', 'desc']) {
    assert.ok(key in item, `导出条目缺字段 ${key}`);
  }
  assert.equal(typeof exported.payload.exportedAt, 'string');
  assert.deepEqual(exported.payload.tagOptions, [...ANNOTATE_TAGS]);
});

// ------------------------------------------------------------------ 与 sticker-library 的共存

test('sticker-library：persist() 不会抹掉人工标注字段（seen 自增这条线最容易踩）', () => {
  const dir = tempDir();
  const md5 = md5Of(30);
  const indexPath = writeLibrary(dir, [[md5, { tags: ['卖萌可爱'], desc: '旧' }]]);
  writeImage(dir, md5);

  // 先由标注器写进人工字段
  makeAnnotator(dir).save({ md5, manualTags: ['赞同支持'], manualDesc: '赞同', manualVerdict: '对' });

  // 再由库加载并触发一次 persist（`bumpSeen` 是最常见的那条）
  const index = createStickerIndex({ filePath: indexPath });
  assert.equal(index.bumpSeen(md5), true);
  const entry = JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries[md5];
  assert.deepEqual(entry.manualTags, ['赞同支持'], 'seen 自增后人工标签还在');
  assert.equal(entry.manualVerdict, '对');
  assert.deepEqual(entry.modelTags, ['卖萌可爱']);
});

test('sticker-library：applyAnnotation 同步内存（不落盘），set() 不写时沿用旧标注', () => {
  const dir = tempDir();
  const md5 = md5Of(31);
  const indexPath = path.join(dir, 'qq-stickers.json');
  writeLibrary(dir, [[md5, { tags: ['卖萌可爱'] }]]);
  writeImage(dir, md5);

  const index = createStickerIndex({ filePath: indexPath });
  assert.equal(index.applyAnnotation(md5, {
    manualTags: ['卖萌可爱'],
    manualDesc: '可爱',
    manualVerdict: '对',
    manualAt: new Date(T0).toISOString(),
    modelTags: ['卖萌可爱'],
    modelDesc: '',
  }), true);
  assert.equal(index.applyAnnotation('ffffffffffffffffffffffffffffffff', { manualTags: [] }), false);

  // set() 传一条没有 manual* 的对象（harvest 的形状）⇒ 沿用内存里已有的标注
  assert.equal(index.set(md5, { file: `${md5}.png`, tags: ['幽默搞笑'] }), true);
  const entry = JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries[md5];
  assert.deepEqual(entry.manualTags, ['卖萌可爱'], 'set 不许静默清掉人工标注');
  assert.equal(entry.manualVerdict, '对');
  assert.deepEqual(entry.tags, ['幽默搞笑'], 'set 本来要改的字段照改');
});

// ------------------------------------------------------------------ HTTP 路由

test('路由：batch GET 返回 JSON；方法不对 405；内部异常降级成 ok:false（不 500）', async () => {
  const dir = tempDir();
  const md5 = md5Of(40);
  writeLibrary(dir, [[md5, { tags: ['卖萌可爱'] }]]);
  writeImage(dir, md5);
  const annotator = makeAnnotator(dir);
  const routes = createStickerLabelRoutes({ annotator });
  const byPath = new Map(routes.map((route) => [route.path, route]));

  const res = fakeRes();
  await byPath.get('/dsh-qq-proactive/sticker-label/batch').handler(
    { method: 'GET', url: '/dsh-qq-proactive/sticker-label/batch?size=4&cursor=0', headers: {} },
    res,
  );
  assert.equal(res.status, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().size, 4);

  const wrong = fakeRes();
  await byPath.get('/dsh-qq-proactive/sticker-label/batch').handler({ method: 'POST', url: '/x', headers: {} }, wrong);
  assert.equal(wrong.status, 405);

  const broken = createStickerLabelRoutes({
    annotator: { batch: () => { throw new Error('炸了'); } },
  }).find((route) => route.path.endsWith('/batch'));
  const degraded = fakeRes();
  await broken.handler({ method: 'GET', url: '/x', headers: {} }, degraded);
  assert.equal(degraded.status, 200, '异常不能 500（那会把配置页搞挂）');
  assert.equal(degraded.json().ok, false);
});

test('路由：save POST 合法写库；坏 JSON 400；导出带 content-disposition', async () => {
  const dir = tempDir();
  const md5 = md5Of(41);
  writeLibrary(dir, [[md5, { tags: ['卖萌可爱'] }]]);
  writeImage(dir, md5);
  const annotator = makeAnnotator(dir);
  const routes = createStickerLabelRoutes({ annotator });
  const byPath = new Map(routes.map((route) => [route.path, route]));

  const body = JSON.stringify({ md5, manualTags: ['赞同支持'], manualDesc: '赞', manualVerdict: '对' });
  const res = fakeRes();
  await byPath.get('/dsh-qq-proactive/sticker-label/save').handler(
    fakeReq('POST', '/s', body),
    res,
  );
  assert.equal(res.status, 200);
  assert.equal(res.json().ok, true);

  const bad = fakeRes();
  await byPath.get('/dsh-qq-proactive/sticker-label/save').handler(
    fakeReq('POST', '/s', '{oops'),
    bad,
  );
  assert.equal(bad.status, 400);

  const exported = fakeRes();
  await byPath.get('/dsh-qq-proactive/sticker-label/export').handler(
    { method: 'GET', url: '/e', headers: {} },
    exported,
  );
  assert.equal(exported.status, 200);
  assert.match(exported.headers['content-disposition'], /attachment; filename="sticker-labels-/);
  assert.equal(exported.json().schema, LABEL_DATASET_SCHEMA);
});

test('路由：image 按 md5 送字节；没有这张图 404（不 500）', async () => {
  const dir = tempDir();
  const md5 = md5Of(42);
  writeLibrary(dir, [[md5, { tags: ['卖萌可爱'] }]]);
  writeImage(dir, md5, 'the-bytes');
  const annotator = makeAnnotator(dir);
  const route = createStickerLabelRoutes({ annotator })
    .find((item) => item.path.endsWith('/image'));

  const res = fakeRes();
  await route.handler({ method: 'GET', url: `/i?md5=${md5}`, headers: {} }, res);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(String(res.body), 'the-bytes');

  const miss = fakeRes();
  await route.handler({ method: 'GET', url: '/i?md5=deadbeef', headers: {} }, miss);
  assert.equal(miss.status, 404);
});

test('backupStamp：Windows 可用（不含冒号），同一次写入名字稳定', () => {
  const stamp = backupStamp(new Date(Date.UTC(2026, 10, 6, 11, 40, 32, 123)));
  assert.equal(stamp, '20261106-114032-123');
  assert.equal(stamp.includes(':'), false);
});
