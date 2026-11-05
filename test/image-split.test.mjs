/**
 * 入站长图切分（`src/dsh/image-split.mjs`，2026-10-22）的契约测试。
 *
 * 四类断言：
 * 1. **纯函数 `planSplits`** —— 用户给的例子必须逐像素对上：960×10793 ⇒ **正好 2 段、每段 960×5937**；
 * 2. **说明那句话** —— 没有它模型会把重叠区的内容数两遍；
 * 3. **脚本安全** —— 全 ASCII、JPEG 编码走 C# 帮手（AMSI 回归）、只调一次；
 * 4. **切图 plumbing** —— 用假 `spawn` + 假 `fs`（**绝不真的执行 PowerShell**、绝不写盘），
 *    钉住"少一张就算失败"和"临时目录一定清掉"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  JPEG_QUALITY,
  MAX_IMAGE_DIMENSION,
  MAX_SEGMENTS,
  SPLIT_REPORT_PREFIX,
  SPLIT_SCRIPT,
  buildSplitNote,
  overlapPercentOf,
  parseSplitReport,
  planSplits,
  rangesOf,
  safeBaseName,
  splitImageBytes,
} from '../src/dsh/image-split.mjs';

/** 一段结构合法的 JPEG 头（切图码不解析它，只是让"读回来有字节"这件事像真的）。 */
function jpegBytes(width, height) {
  const buf = Buffer.alloc(24);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf.writeUInt16BE(width, 8);
  buf.writeUInt16BE(height, 10);
  buf[2] = 0xff;
  buf[3] = 0xc0;
  return buf;
}

/** 内存假 fs：只实现 `splitImageBytes` 用到的那几个方法。 */
function makeFs() {
  const files = new Map();
  const dirs = new Set();
  let seq = 0;
  return {
    files,
    dirs,
    mkdtempSync(prefix) {
      seq += 1;
      const dir = `${prefix}${seq}`;
      dirs.add(dir);
      return dir;
    },
    writeFileSync(file, data) {
      files.set(file, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
    },
    readFileSync(file) {
      if (!files.has(file)) {
        const error = new Error(`ENOENT: no such file or directory, open '${file}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    rmSync(target) {
      if (dirs.has(target)) {
        dirs.delete(target);
        for (const key of [...files.keys()]) {
          if (key.startsWith(`${target}\\`)) files.delete(key);
        }
        return;
      }
      files.delete(target);
    },
  };
}

/** 假 spawn：`handler` 决定这次子进程怎么结束。 */
function makeSpawn(handler) {
  const calls = [];
  function spawnImpl(exe, args, opts) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    const call = { exe, args, opts, child };
    calls.push(call);
    handler(call);
    return child;
  }
  return { spawnImpl, calls };
}

function argAfter(args, flag) {
  return args[args.indexOf(flag) + 1];
}

// ---------------------------------------------------------------- 纯函数

test('★ planSplits：960×10793 ⇒ 正好 2 段，每段 960×5937（用户给的例子）', () => {
  const plan = planSplits(960, 10793, 8192, 0.1);
  assert.equal(plan.axis, 'height', '长图按高度切');
  assert.equal(plan.segments.length, 2);
  assert.deepEqual(plan.segments.map((s) => [s.width, s.height]), [[960, 5937], [960, 5937]]);
  assert.deepEqual(plan.segments.map((s) => s.y), [0, 4856], '第二段贴住末尾（10793 - 5937）');
  // 覆盖整张图、不越界
  const last = plan.segments[1];
  assert.equal(last.y + last.height, 10793);
  for (const segment of plan.segments) {
    assert.ok(segment.height <= MAX_IMAGE_DIMENSION, '每段都必须在上限内');
    assert.equal(segment.width, 960, '横向不切（切了会把同一行文字劈开）');
  }
  // 相邻两块必须重叠（切在文字行中间时，靠重叠让每行至少完整落在一段里）
  const overlapPx = plan.segments[0].y + plan.segments[0].height - plan.segments[1].y;
  assert.ok(overlapPx > 0, '必须有重叠');
});

test('planSplits：长边在上限内 ⇒ 一段都不切（返回原图一块）', () => {
  for (const [w, h] of [[800, 600], [8192, 100], [100, 8192]]) {
    const plan = planSplits(w, h, 8192, 0.1);
    assert.equal(plan.segments.length, 1, `${w}x${h} 不该切`);
    assert.deepEqual([plan.segments[0].x, plan.segments[0].y, plan.segments[0].width, plan.segments[0].height], [0, 0, w, h]);
    assert.equal(buildSplitNote(plan), '', '不用切 ⇒ 不需要说明');
  }
});

test('planSplits：宽图按宽度切（不是一律按高度）', () => {
  const plan = planSplits(20000, 400, 8192, 0.1);
  assert.equal(plan.axis, 'width');
  assert.ok(plan.segments.length >= 3, '20000 宽必然要多段');
  for (const segment of plan.segments) {
    assert.ok(segment.width <= 8192);
    assert.equal(segment.height, 400);
  }
  assert.equal(plan.segments[0].x, 0);
  const last = plan.segments[plan.segments.length - 1];
  assert.equal(last.x + last.width, 20000, '最后一段贴住末尾');
});

test('planSplits：N 按需算 —— 越长的图段数越多，且段数有上限', () => {
  const countOf = (h) => planSplits(960, h, 8192, 0.1).segments.length;
  assert.equal(countOf(10793), 2);
  assert.equal(countOf(20000), 3);
  assert.equal(countOf(30000), 5);
  // 长到切 6 段都超限 ⇒ 返回空（调用方退回原图，绝不输出仍超限的切片）
  assert.deepEqual(planSplits(100, 200000, 8192, 0.1).segments, []);
  assert.equal(MAX_SEGMENTS, 6);
});

test('planSplits：垃圾输入不猜（空 segments / axis none）', () => {
  assert.deepEqual(planSplits(0, 10), { axis: 'none', segments: [] });
  assert.deepEqual(planSplits(NaN, 10), { axis: 'none', segments: [] });
  assert.deepEqual(planSplits(-5, 10), { axis: 'none', segments: [] });
  assert.deepEqual(planSplits('abc', 10), { axis: 'none', segments: [] });
  // 上限/重叠瞎写 ⇒ 回默认，不抛
  assert.equal(planSplits(960, 10793, NaN, 5).segments.length, 2);
});

test('★ buildSplitNote：说清 1/2、2/2 和重叠，并让模型"拼起来看"', () => {
  const note = buildSplitNote(planSplits(960, 10793, 8192, 0.1));
  assert.match(note, /1\/2/);
  assert.match(note, /2\/2/);
  assert.match(note, /重叠约 \d+%/);
  assert.match(note, /拼起来/);
  // 报的是**实算值**（960×10793 参数 10%，实算约 18%）—— 报参数等于骗模型
  assert.match(note, /重叠约 18%/);
  assert.ok(!note.includes('10%'), '不许把参数当成事实写进提示词');
  assert.equal(buildSplitNote(null), '');
  assert.equal(buildSplitNote({ segments: [] }), '');
});

test('overlapPercentOf：算相邻两块的实际重叠，单段/空 ⇒ 0', () => {
  assert.equal(overlapPercentOf({ segments: [{ x: 0, y: 0, width: 10, height: 10 }] }), 0);
  assert.equal(overlapPercentOf(null), 0);
  const plan = { segments: [{ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 8, width: 10, height: 10 }] };
  assert.equal(overlapPercentOf(plan), 20, '重叠 2px / 10px = 20%');
});

test('rangesOf / safeBaseName：脚本参数是纯 ASCII、没有空格', () => {
  assert.equal(rangesOf(planSplits(960, 10793).segments), '0:0:960:5937;0:4856:960:5937');
  assert.equal(rangesOf([]), '');
  assert.equal(safeBaseName('abc.png'), 'abc');
  assert.equal(safeBaseName('D:\\QQ\\a b\\x y.jpg'), 'x-y');
  assert.equal(safeBaseName('图 片.png'), 'qq-image', '非 ASCII 一律换成占位名');
  assert.equal(safeBaseName(''), 'qq-image');
  assert.equal(safeBaseName(undefined), 'qq-image');
});

// ---------------------------------------------------------------- 脚本

test('★ SPLIT_SCRIPT：全 ASCII、按 Ranges 逐段 DrawImage、JPEG 走 C# 帮手', () => {
  assert.match(SPLIT_SCRIPT, /^[\x00-\x7F]*$/, '脚本内容必须全是 ASCII');
  assert.match(SPLIT_SCRIPT, /\[System\.Drawing\.Image\]::FromFile/);
  assert.match(SPLIT_SCRIPT, /\$Ranges\.Split\(";"\)/, '按分段计划逐段切');
  assert.match(SPLIT_SCRIPT, /DrawImage\(\$src, \$destRect, \$srcRect/);
  assert.match(SPLIT_SCRIPT, /Format24bppRgb/, 'JPEG 没有 alpha，必须转 24bpp');
  assert.match(SPLIT_SCRIPT, new RegExp(`\\[int\\]\\$Quality = ${JPEG_QUALITY}`), '质量 92 是参数默认值');
  // AMSI 回归：这两种 PowerShell 写法会被 Defender 整份拦掉，必须留在 C# 里
  assert.ok(!SPLIT_SCRIPT.includes('[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders'));
  assert.ok(!/New-Object\s+System\.Drawing\.Imaging\.EncoderParameters/.test(SPLIT_SCRIPT));
  assert.match(SPLIT_SCRIPT, /public static class QqGuguJpegSlice/);
  assert.match(SPLIT_SCRIPT, /bmp\.Save\(path, chosen, parameters\)/);
  // 回执：每段一行 + 一行汇总
  assert.match(SPLIT_SCRIPT, new RegExp(`${SPLIT_REPORT_PREFIX} ok=1`));
  assert.match(SPLIT_SCRIPT, new RegExp(`${SPLIT_REPORT_PREFIX} done=1`));
});

test('parseSplitReport：认每段回执与 done 汇总，缺字段按 0（不编数字）', () => {
  const report = parseSplitReport([
    'noise',
    `${SPLIT_REPORT_PREFIX} ok=1 index=1 bytes=100 width=960 height=5937`,
    `${SPLIT_REPORT_PREFIX} ok=1 index=2 bytes=200 width=960 height=5937`,
    `${SPLIT_REPORT_PREFIX} done=1 count=2`,
  ].join('\r\n'));
  assert.equal(report.ok, true);
  assert.equal(report.done, true);
  assert.equal(report.count, 2);
  assert.deepEqual(report.images.map((i) => i.index), [1, 2]);
  assert.equal(report.images[1].bytes, 200);

  assert.equal(parseSplitReport(''), null);
  assert.equal(parseSplitReport(undefined), null);
  const junk = parseSplitReport(`${SPLIT_REPORT_PREFIX} ok=1 index=abc bytes=`);
  assert.deepEqual(junk.images, [{ index: 0, bytes: 0, width: 0, height: 0 }]);
});

// ---------------------------------------------------------------- 切图 plumbing（假 spawn / 假 fs）

test('★ splitImageBytes：一次 spawn 切完，读回每一段，临时目录清干净', async () => {
  const fsImpl = makeFs();
  const plan = planSplits(960, 10793, 8192, 0.1);
  const { spawnImpl, calls } = makeSpawn(({ child, args }) => {
    const dir = argAfter(args, '-OutDir');
    const base = argAfter(args, '-BaseName');
    const count = argAfter(args, '-Ranges').split(';').length;
    for (let i = 1; i <= count; i += 1) {
      fsImpl.writeFileSync(`${dir}\\${base}-${i}.jpg`, jpegBytes(960, 5937));
    }
    setImmediate(() => {
      for (let i = 1; i <= count; i += 1) {
        child.stdout.emit('data', `${SPLIT_REPORT_PREFIX} ok=1 index=${i} bytes=24 width=960 height=5937\r\n`);
      }
      child.stdout.emit('data', `${SPLIT_REPORT_PREFIX} done=1 count=${count}\r\n`);
      child.emit('close', 0);
    });
  });

  const result = await splitImageBytes({
    data: Buffer.from('original-bytes'),
    name: '长图.png',
    format: 'png',
    segments: plan.segments,
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh'],
    tempRoot: '<tmp>',
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.images.length, 2, '两段 ⇒ 两个文件字节');
  assert.deepEqual(result.images.map((i) => i.name), ['qq-image-1.jpg', 'qq-image-2.jpg']);
  assert.equal(result.images[0].width, 960);
  assert.equal(result.images[0].height, 5937);
  assert.ok(result.images[0].data instanceof Uint8Array);
  assert.equal(result.images[0].data.length, 24);

  // 调用形状：数组传参 + -File，一次就够
  assert.equal(calls.length, 1, '⚠️ 一次 PowerShell 调用切完，别一段起一个进程');
  const { args, opts } = calls[0];
  assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.equal(args[4], '-File');
  assert.equal(argAfter(args, '-Ranges'), '0:0:960:5937;0:4856:960:5937');
  assert.equal(argAfter(args, '-Quality'), String(JPEG_QUALITY));
  assert.equal(opts.windowsHide, true, '不许弹黑窗');
  assert.ok(!args.includes('-Command'), '不许内联 -Command');

  // 临时目录整棵清掉（含原图与脚本）
  assert.deepEqual([...fsImpl.files.keys()], []);
  assert.deepEqual([...fsImpl.dirs], []);
});

test('★ splitImageBytes：少一张 ⇒ ok:false（残缺的切片比不切更误导模型）', async () => {
  const fsImpl = makeFs();
  const { spawnImpl } = makeSpawn(({ child, args }) => {
    const dir = argAfter(args, '-OutDir');
    const base = argAfter(args, '-BaseName');
    // 只写出第一张
    fsImpl.writeFileSync(`${dir}\\${base}-1.jpg`, jpegBytes(960, 5937));
    setImmediate(() => child.emit('close', 0));
  });

  const result = await splitImageBytes({
    data: Buffer.from('x'),
    name: 'a.png',
    format: 'png',
    segments: planSplits(960, 10793).segments,
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh'],
    tempRoot: '<tmp>',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /切片 2\/2 没生成/);
  assert.deepEqual([...fsImpl.files.keys()], [], '失败也要清临时目录');
});

test('splitImageBytes：超时 / 非 0 退出 / 没有计划 / 空字节 都收敛成 ok:false', async () => {
  const soft = new EventEmitter();
  soft.stdout = new EventEmitter();
  soft.stderr = new EventEmitter();
  soft.kill = () => { soft.killed = true; };

  const timeout = await splitImageBytes({
    data: Buffer.from('x'),
    segments: planSplits(960, 10793).segments,
    spawnImpl: () => soft,
    fsImpl: makeFs(),
    pwshCandidates: ['pwsh'],
    timeoutMs: 15,
    tempRoot: '<tmp>',
  });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /超时/);
  assert.equal(soft.killed, true, '超时必须 kill 子进程');

  const failedExit = await splitImageBytes({
    data: Buffer.from('x'),
    segments: planSplits(960, 10793).segments,
    spawnImpl: makeSpawn(({ child }) => {
      setImmediate(() => {
        child.stderr.emit('data', 'Access is denied.\r\n');
        child.emit('close', 1);
      });
    }).spawnImpl,
    fsImpl: makeFs(),
    pwshCandidates: ['pwsh'],
    tempRoot: '<tmp>',
  });
  assert.equal(failedExit.ok, false);
  assert.match(failedExit.error, /退出码 1/);
  assert.match(failedExit.error, /Access is denied/);

  assert.equal((await splitImageBytes({ data: Buffer.from('x'), segments: [] })).ok, false);
  assert.equal((await splitImageBytes({ data: new Uint8Array(0), segments: planSplits(960, 10793).segments })).ok, false);
});

test('splitImageBytes：pwsh 不在 ⇒ 换下一个候选；都没有 ⇒ 说清试过谁（不抛）', async () => {
  const fsImpl = makeFs();
  const { spawnImpl, calls } = makeSpawn(({ child, exe, args }) => {
    if (exe === 'pwsh') {
      const error = new Error('spawn pwsh ENOENT');
      error.code = 'ENOENT';
      setImmediate(() => child.emit('error', error));
      return;
    }
    const dir = argAfter(args, '-OutDir');
    const base = argAfter(args, '-BaseName');
    fsImpl.writeFileSync(`${dir}\\${base}-1.jpg`, jpegBytes(960, 5937));
    fsImpl.writeFileSync(`${dir}\\${base}-2.jpg`, jpegBytes(960, 5937));
    setImmediate(() => child.emit('close', 0));
  });

  const result = await splitImageBytes({
    data: Buffer.from('x'),
    segments: planSplits(960, 10793).segments,
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh', 'powershell.exe'],
    tempRoot: '<tmp>',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls.map((c) => c.exe), ['pwsh', 'powershell.exe']);

  const none = await splitImageBytes({
    data: Buffer.from('x'),
    segments: planSplits(960, 10793).segments,
    spawnImpl: makeSpawn(({ child }) => {
      const error = new Error('spawn ENOENT');
      error.code = 'ENOENT';
      setImmediate(() => child.emit('error', error));
    }).spawnImpl,
    fsImpl: makeFs(),
    pwshCandidates: ['pwsh', 'powershell.exe'],
    tempRoot: '<tmp>',
  });
  assert.equal(none.ok, false);
  assert.match(none.error, /找不到 PowerShell/);
  assert.match(none.error, /powershell\.exe/);
});
