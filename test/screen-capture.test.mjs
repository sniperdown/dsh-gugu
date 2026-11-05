/**
 * 虚拟桌面整屏截图（`src/dsh/screen-capture.mjs`，2026-10-21）的契约测试。
 *
 * 三条硬约束：
 * - **绝不真的执行 PowerShell**：`spawnImpl` 全是替身（EventEmitter + `kill`），
 *   只断言"传了什么参数、什么时候 kill"。
 * - **绝不碰真屏幕**：`fsImpl` 是内存假文件系统；成功路径由替身自己"写" PNG 字节。
 * - 覆盖四条失败路径：**超时 / 非 0 退出 / 文件没生成 / 不是 PNG** —— 它们都必须
 *   收敛成 `{ok:false, error}`（永不抛），因为调用方（定时唤醒）靠这个决定"只发文字"。
 *
 * 另外钉住两件容易被改回去的事：
 * 1. **用 `-File` + 脚本文件，不用内联 `-Command`**（引号二次解析踩过多次）；
 * 2. **`spawn` 带 `windowsHide: true`**（用户明确讨厌弹黑窗抢焦点）。
 *
 * 2026-10-21 补：**体积保底**（PNG ≥ 18 MiB ⇒ 同一张位图重编码成 JPEG）也在这一组里
 * 钉住 —— 关键是"**只在同一次 PowerShell 调用里**做完"（绝不为了转码再起一个进程），
 * 以及"降到底还不达标就 `ok:false`，绝不把超线图交给附件管线"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import {
  captureVirtualDesktop,
  pruneScreenshots,
  pngSize,
  jpegSize,
  imageInfo,
  parseShotReport,
  parseShotReports,
  JPEG_QUALITY_LADDER,
  POWERSHELL_SCRIPT,
  REENCODE_ABOVE_BYTES,
  SCREENSHOT_RX,
  SCREENSHOT_STAMP_RX,
  SHOT_REPORT_PREFIX,
} from '../src/dsh/screen-capture.mjs';

/** 一小段合法 PNG 头（含 IHDR 里的宽高）——只被读头，不需要真的能解码。 */
function pngBytes(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/**
 * 一小段"结构合法"的 JPEG：SOI + APP0 + SOF0（真实宽高）+ EOI。
 * 只被读头（`jpegSize`），不需要真的能解码。
 */
function jpegBytes(width, height) {
  const soi = Buffer.from([0xff, 0xd8]);
  // APP0 / JFIF，长度字段 16（含它自己）
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  // SOF0，长度字段 17（含它自己）；精度 8 + 高 2 + 宽 2 + 分量数 1 + 3×3
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof, eoi]);
}

/** 内存假 fs：只实现 `screen-capture.mjs` 用到的那几个方法。 */
function makeFs() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    dirs,
    mkdirSync(dir) { dirs.add(dir); },
    writeFileSync(file, data) { files.set(file, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')); },
    readFileSync(file) {
      if (!files.has(file)) {
        const error = new Error(`ENOENT: no such file or directory, open '${file}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    rmSync(file) { files.delete(file); },
    readdirSync(dir) {
      const prefix = `${dir}\\`;
      return [...files.keys()]
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length));
    },
  };
}

/**
 * 假 spawn：`handler` 决定这次子进程怎么结束。
 * 产物文件的路径从参数里取（`-OutPath <路径>`），与真实调用保持一致。
 */
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

function outPathOf(args) {
  return args[args.indexOf('-OutPath') + 1];
}

test('★ 成功（分屏）：-File + windowsHide，每块屏一张、名字带 -1/-2', async () => {
  const fsImpl = makeFs();
  const { spawnImpl, calls } = makeSpawn(({ child, args }) => {
    // 替身"分屏截图"：脚本按约定在基名后加 `-N` 各写一张。
    const stem = outPathOf(args).replace(/\.png$/i, '');
    fsImpl.writeFileSync(`${stem}-1.png`, pngBytes(1920, 1080));
    fsImpl.writeFileSync(`${stem}-2.png`, pngBytes(2560, 1440));
    setImmediate(() => {
      child.stdout.emit('data', `${SHOT_REPORT_PREFIX} ok=1 mode=split index=1 monitors=2 count=2 format=png quality=0 reencodeMs=0 bytes=33\r\n`);
      child.stdout.emit('data', `${SHOT_REPORT_PREFIX} ok=1 mode=split index=2 monitors=2 count=2 format=png quality=0 reencodeMs=0 bytes=33\r\n`);
      child.stdout.emit('data', `${SHOT_REPORT_PREFIX} done=1 mode=split count=2\r\n`);
      child.emit('close', 0);
    });
  });

  const result = await captureVirtualDesktop({
    outDir: '<tmp>\\screens',
    timeoutMs: 8000,
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh'],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mode, 'split', '两块屏 ⇒ 必须走分屏');
  assert.equal(result.count, 2);
  assert.equal(result.images.length, 2, '两块屏必须各一张、分开给');
  assert.match(path.basename(result.images[0].path), /^shot-\d{8}-\d{6}-\d{3}-1\.png$/);
  assert.match(path.basename(result.images[1].path), /^shot-\d{8}-\d{6}-\d{3}-2\.png$/);
  assert.equal(result.images[0].width, 1920);
  assert.equal(result.images[0].height, 1080);
  assert.equal(result.images[1].width, 2560);
  assert.equal(result.images[1].height, 1440);
  assert.equal(result.images[0].format, 'png', '小图优先 PNG（无损）');
  assert.equal(result.images[0].reencodeMs, 0, '没重编码就是 0');
  assert.ok(Number.isFinite(result.ms) && result.ms >= 0);
  // 兼容层：顶层那几个字段 = 第一张（老调用方只认一张）
  assert.equal(result.path, result.images[0].path);
  assert.equal(result.width, 1920);

  // 调用形状：数组传参 + -File，**绝不**内联 -Command
  assert.equal(calls.length, 1);
  const { exe, args, opts } = calls[0];
  assert.equal(exe, 'pwsh');
  assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.equal(args[4], '-File');
  assert.ok(args[5].endsWith('.ps1'));
  assert.equal(args[6], '-OutPath');
  assert.equal(path.dirname(args[7]), '<tmp>\\screens', 'OutPath 是**基名**，-N 由脚本加');
  assert.match(path.basename(args[7]), /^shot-\d{8}-\d{6}-\d{3}\.png$/);
  // 阈值必须**从 JS 常量传下去**（唯一一份真相），别让脚本里再藏一个数
  assert.equal(args[8], '-ReencodeAboveBytes');
  assert.equal(args[9], String(REENCODE_ABOVE_BYTES));
  assert.ok(!args.includes('-Command'), '不许用内联 -Command（引号会被二次解析）');
  assert.equal(opts.windowsHide, true, '必须有 windowsHide（不许弹黑窗/抢焦点）');
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);

  // 临时脚本用完就删；成功的两张图留着
  const left = [...fsImpl.files.keys()];
  assert.equal(left.length, 2);
  assert.deepEqual(left.sort(), [result.images[0].path, result.images[1].path].sort());
});

test('★ 降级（只有一块屏/分屏失败）：回落成合并一张，绝不空手', async () => {
  const fsImpl = makeFs();
  const { spawnImpl, calls } = makeSpawn(({ child, args }) => {
    // 脚本内部拿不到 ≥2 块屏 ⇒ 写基名那一张（老行为）
    fsImpl.writeFileSync(outPathOf(args), pngBytes(7680, 2160));
    setImmediate(() => {
      child.stdout.emit('data', `split skipped: only one monitor\r\n`);
      child.stdout.emit('data', `${SHOT_REPORT_PREFIX} ok=1 mode=merged index=0 monitors=1 count=1 format=png quality=0 reencodeMs=0 bytes=33\r\n`);
      child.stdout.emit('data', `${SHOT_REPORT_PREFIX} done=1 mode=merged count=1\r\n`);
      child.emit('close', 0);
    });
  });

  const result = await captureVirtualDesktop({
    outDir: '<tmp>\\screens',
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh'],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mode, 'merged', '只有一块屏 ⇒ 合并一张');
  assert.equal(result.count, 1);
  assert.match(path.basename(result.path), /^shot-\d{8}-\d{6}-\d{3}\.png$/, '降级那张**不带** -N');
  assert.equal(result.width, 7680);
  assert.equal(calls.length, 1, '降级也在**同一次** PowerShell 调用里完成');
});

test('★ 分屏里有一块转 JPEG 也照样两张（每张各自判断）', async () => {
  const fsImpl = makeFs();
  const jpeg = jpegBytes(3840, 2160);
  const { spawnImpl } = makeSpawn(({ child, args }) => {
    const stem = outPathOf(args).replace(/\.png$/i, '');
    fsImpl.writeFileSync(`${stem}-1.png`, pngBytes(1920, 1080));
    fsImpl.writeFileSync(`${stem}-2.jpg`, jpeg);
    setImmediate(() => {
      child.stdout.emit('data', `${SHOT_REPORT_PREFIX} ok=1 mode=split index=1 monitors=2 count=2 format=png quality=0 reencodeMs=0 bytes=33\r\n`);
      child.stdout.emit('data', `${SHOT_REPORT_PREFIX} ok=1 mode=split index=2 monitors=2 count=2 format=jpeg quality=90 reencodeMs=412 bytes=${jpeg.length}\r\n`);
      child.stdout.emit('data', `${SHOT_REPORT_PREFIX} done=1 mode=split count=2\r\n`);
      child.emit('close', 0);
    });
  });

  const result = await captureVirtualDesktop({
    outDir: '<tmp>\\screens',
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh'],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0].format, 'png');
  assert.equal(result.images[1].format, 'jpeg', '第二块超阈值 ⇒ 只有它转 JPEG');
  assert.match(result.images[1].path, /\.jpg$/);
});

test('★ 脚本内容：只用 ASCII，且 DPI / AllScreens / VirtualScreen 降级都在', () => {
  assert.match(POWERSHELL_SCRIPT, /^[\x00-\x7F]*$/, '脚本内容必须全是 ASCII');
  assert.match(POWERSHELL_SCRIPT, /SetProcessDPIAware\(\)/);
  // 分屏：遍历物理屏、按每块屏的 Bounds 各截一张
  assert.match(POWERSHELL_SCRIPT, /Screen\]::AllScreens/);
  assert.match(POWERSHELL_SCRIPT, /CopyFromScreen\(\$b\.Left, \$b\.Top, 0, 0/);
  assert.match(POWERSHELL_SCRIPT, /stem \+ "-" \+ \$i \+ "\.png"/);
  // 降级：整块虚拟桌面拼一张（老行为，必须留着）
  assert.match(POWERSHELL_SCRIPT, /SystemInformation\]::VirtualScreen/);
  assert.match(POWERSHELL_SCRIPT, /CopyFromScreen\(\$vs\.Left, \$vs\.Top, 0, 0/);
  assert.match(POWERSHELL_SCRIPT, /ImageFormat\]::Png/);
  // DPI 必须在读屏 **之前**（顺序错了等于没设）
  assert.ok(
    POWERSHELL_SCRIPT.indexOf('SetProcessDPIAware()') < POWERSHELL_SCRIPT.indexOf('AllScreens'),
    'SetProcessDPIAware 必须出现在读取 AllScreens 之前',
  );
  assert.ok(
    POWERSHELL_SCRIPT.indexOf('AllScreens') < POWERSHELL_SCRIPT.indexOf('VirtualScreen'),
    '分屏要先试，降级（VirtualScreen）在后面',
  );
});

test('★ 超时：返回 ok:false，且把子进程 kill 掉（不留孤儿）', async () => {
  const fsImpl = makeFs();
  const { spawnImpl, calls } = makeSpawn(() => { /* 永不结束 ⇒ 只能等超时 */ });
  const startedAt = Date.now();

  const result = await captureVirtualDesktop({
    outDir: '<tmp>\\screens',
    timeoutMs: 25,
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh'],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
  assert.ok(Date.now() - startedAt >= 20, '必须真的等到超时，不能立刻放弃');
  assert.equal(calls[0].child.killed, true, '超时后必须 kill');
  assert.deepEqual([...fsImpl.files.keys()], [], '临时脚本与半截 png 都不留');
});

test('★ 非 0 退出：带出退出码与 stderr 最后一行', async () => {
  const fsImpl = makeFs();
  const { spawnImpl } = makeSpawn(({ child }) => {
    setImmediate(() => {
      child.stderr.emit('data', 'noise\r\nAccess is denied.\r\n');
      child.emit('close', 1);
    });
  });

  const result = await captureVirtualDesktop({
    outDir: '<tmp>\\screens',
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh'],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /退出码 1/);
  assert.match(result.error, /Access is denied/);
  assert.deepEqual([...fsImpl.files.keys()], [], '临时脚本不留');
});

test('★ 退出码 0 但文件没生成 ⇒ ok:false（不能把"没截到"当成成功）', async () => {
  const fsImpl = makeFs();
  const { spawnImpl } = makeSpawn(({ child }) => {
    setImmediate(() => child.emit('close', 0));
  });

  const result = await captureVirtualDesktop({
    outDir: '<tmp>\\screens',
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh'],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /没生成/);
});

test('文件生成了但不合法 ⇒ ok:false（不拿假宽高糊弄）', async () => {
  const fsImpl = makeFs();
  const { spawnImpl } = makeSpawn(({ child, args }) => {
    fsImpl.writeFileSync(outPathOf(args), Buffer.from('this is not a png', 'utf8'));
    setImmediate(() => child.emit('close', 0));
  });

  const result = await captureVirtualDesktop({
    outDir: '<tmp>\\screens',
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh'],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /全都不合规/);
});

test('spawn ENOENT ⇒ 换下一个 PowerShell 候选（pwsh 不在时退到 powershell.exe）', async () => {
  const fsImpl = makeFs();
  const { spawnImpl, calls } = makeSpawn(({ child, exe, args }) => {
    if (exe === 'pwsh') {
      const error = new Error('spawn pwsh ENOENT');
      error.code = 'ENOENT';
      setImmediate(() => child.emit('error', error));
      return;
    }
    fsImpl.writeFileSync(outPathOf(args), pngBytes(3840, 2160));
    setImmediate(() => child.emit('close', 0));
  });

  const result = await captureVirtualDesktop({
    outDir: '<tmp>\\screens',
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh', 'powershell.exe'],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.width, 3840);
  assert.deepEqual(calls.map((call) => call.exe), ['pwsh', 'powershell.exe']);
});

test('所有候选都 ENOENT ⇒ ok:false 且说清试过谁（不抛）', async () => {
  const fsImpl = makeFs();
  const { spawnImpl } = makeSpawn(({ child }) => {
    const error = new Error('spawn ENOENT');
    error.code = 'ENOENT';
    setImmediate(() => child.emit('error', error));
  });

  const result = await captureVirtualDesktop({
    outDir: '<tmp>\\screens',
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh', 'powershell.exe'],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /找不到 PowerShell/);
  assert.match(result.error, /pwsh/);
});

test('没有 outDir ⇒ ok:false，不 spawn', async () => {
  let spawned = 0;
  const result = await captureVirtualDesktop({
    outDir: '   ',
    spawnImpl: () => { spawned += 1; return new EventEmitter(); },
    fsImpl: makeFs(),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /outDir/);
  assert.equal(spawned, 0);
});

test('pngSize：签名/IHDR 不对一律 null（不猜）', () => {
  assert.deepEqual(pngSize(pngBytes(1920, 1080)), { width: 1920, height: 1080 });
  assert.equal(pngSize(Buffer.from('short')), null);
  const badSignature = pngBytes(10, 10);
  badSignature[1] = 0x00;
  assert.equal(pngSize(badSignature), null);
  const badChunk = pngBytes(10, 10);
  badChunk.write('XXXX', 12, 'latin1');
  assert.equal(pngSize(badChunk), null);
});

test('★ pruneScreenshots：只留最近 N 张 shot-*.png，别的文件一个都不碰', () => {
  const dir = '<tmp>\\screens';
  const fsImpl = makeFs();
  const shots = [
    'shot-20260101-000001-000.png',
    'shot-20260101-000002-000.png',
    'shot-20260101-000003-000.png',
    'shot-20260101-000004-000.png',
    'shot-20260101-000005-000.png',
  ];
  for (const name of shots) fsImpl.files.set(`${dir}\\${name}`, Buffer.from('x'));
  fsImpl.files.set(`${dir}\\keep-me.txt`, Buffer.from('x'));
  fsImpl.files.set(`${dir}\\other.png`, Buffer.from('x'));

  const result = pruneScreenshots({ dir, keep: 2, fsImpl });
  assert.deepEqual(result, { removed: 3, kept: 2 });
  assert.deepEqual(fsImpl.readdirSync(dir).sort(), [shots[3], shots[4], 'keep-me.txt', 'other.png'].sort());
});

test('pruneScreenshots：目录不在 / keep 非法都不抛', () => {
  const fsImpl = makeFs();
  assert.deepEqual(pruneScreenshots({ dir: 'H:\\nope', keep: 2, fsImpl }), { removed: 0, kept: 0 });
  assert.deepEqual(pruneScreenshots({ dir: '', keep: 2, fsImpl }), { removed: 0, kept: 0 });
  fsImpl.files.set('<tmp>\\screens\\shot-20260101-000001-000.png', Buffer.from('x'));
  assert.deepEqual(pruneScreenshots({ dir: '<tmp>\\screens', keep: 0, fsImpl }), { removed: 0, kept: 1 });
});

// ================================================================ 体积保底（2026-10-21）

test('★ 重编码阈值 = 18 MiB（给 DSH 的 20 MiB 留 2 MiB 余量）', () => {
  assert.equal(REENCODE_ABOVE_BYTES, 18 * 1024 * 1024);
  assert.ok(REENCODE_ABOVE_BYTES < 20 * 1024 * 1024, '必须低于 DSH 附件的 20 MiB 上限');
  assert.deepEqual(JPEG_QUALITY_LADDER, [90, 75, 60], '质量阶梯：够就 90，逐级降');
});

test('★ 超阈值 ⇒ 同一张位图就地转 JPEG：**只 spawn 一次**，返回 jpg 路径/格式/重编码耗时', async () => {
  const fsImpl = makeFs();
  const jpeg = jpegBytes(7680, 2160);
  let sawArgs = null;
  const { spawnImpl, calls } = makeSpawn(({ child, args }) => {
    sawArgs = args;
    // 替身按脚本的真实行为走：先落 PNG（"超大"），再落 JPEG，删掉 PNG。
    const pngPath = outPathOf(args);
    const jpgPath = pngPath.replace(/\.png$/i, '.jpg');
    fsImpl.writeFileSync(pngPath, pngBytes(7680, 2160));
    fsImpl.rmSync(pngPath);
    fsImpl.writeFileSync(jpgPath, jpeg);
    setImmediate(() => {
      child.stdout.emit('data', `${SHOT_REPORT_PREFIX} ok=1 format=jpeg quality=90 reencodeMs=412 bytes=${jpeg.length}\r\n`);
      child.emit('close', 0);
    });
  });

  const result = await captureVirtualDesktop({
    outDir: '<tmp>\\screens',
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh'],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1, '⚠️ 重编码必须复用同一次 PowerShell 调用，不许为转码再起进程');
  assert.equal(sawArgs[8], '-ReencodeAboveBytes');
  assert.equal(result.format, 'jpeg');
  assert.match(result.path, /\.jpg$/, '落盘的是同名 .jpg');
  assert.equal(path.dirname(result.path), '<tmp>\\screens');
  assert.equal(result.width, 7680, '尺寸一个像素都不许动');
  assert.equal(result.height, 2160);
  assert.equal(result.bytes, jpeg.length);
  assert.equal(result.reencodeMs, 412, 'reencodeMs 来自脚本回执');
  // 超大 PNG 被删掉，只剩 JPEG（和临时脚本，后者在 finally 里删了）
  assert.deepEqual([...fsImpl.files.keys()], [result.path]);
});

test('★ 降到质量 60 仍超阈值 ⇒ ok:false（宁可不带图），且一张都不留', async () => {
  const fsImpl = makeFs();
  const { spawnImpl, calls } = makeSpawn(({ child, args }) => {
    const pngPath = outPathOf(args);
    fsImpl.writeFileSync(pngPath, pngBytes(7680, 2160));
    fsImpl.rmSync(pngPath); // 脚本放弃时会把自己产的图删干净
    setImmediate(() => {
      child.stdout.emit('data', `${SHOT_REPORT_PREFIX} ok=0 format=jpeg quality=60 reencodeMs=2890 bytes=20999999\r\n`);
      child.emit('close', 1);
    });
  });

  const result = await captureVirtualDesktop({
    outDir: '<tmp>\\screens',
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh'],
  });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.match(result.error, /重编码后仍超过上限/);
  assert.match(result.error, /质量 60/, '错误里要说清降到哪一档');
  assert.match(result.error, /20999999/);
  assert.deepEqual([...fsImpl.files.keys()], [], '超大图与临时脚本都不留');
});

test('★ 防御：退回来还是 ≥ 18 MiB 的 PNG ⇒ ok:false 并删掉它（绝不交给附件管线）', async () => {
  const fsImpl = makeFs();
  const huge = Buffer.concat([pngBytes(7680, 2160), Buffer.alloc(REENCODE_ABOVE_BYTES - 33)]);
  assert.equal(huge.length, REENCODE_ABOVE_BYTES, '构造一张正好卡在阈值上的 PNG');
  const { spawnImpl } = makeSpawn(({ child, args }) => {
    fsImpl.writeFileSync(outPathOf(args), huge);
    setImmediate(() => child.emit('close', 0));
  });

  const result = await captureVirtualDesktop({
    outDir: '<tmp>\\screens',
    spawnImpl,
    fsImpl,
    pwshCandidates: ['pwsh'],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /放弃带图/);
  assert.match(result.error, new RegExp(String(REENCODE_ABOVE_BYTES)));
  assert.deepEqual([...fsImpl.files.keys()], [], '超线的那张图必须删掉，别留在 tmp 里');
});

test('★ 脚本：PNG 先落盘 → 判长度 → 同一次调用里转 JPEG（质量阶梯在脚本里按序）', () => {
  // 一次 Save PNG（GDI+）+ 一次 Save JPEG（C# 帮手）—— 都在同一个脚本里，所以还是一进程
  assert.equal((POWERSHELL_SCRIPT.match(/\$bmp\.Save\(/g) ?? []).length, 1, 'PNG 只由 PowerShell 存一次');
  const savePng = POWERSHELL_SCRIPT.indexOf('$bmp.Save($path');
  const saveJpeg = POWERSHELL_SCRIPT.indexOf('[QqGuguJpeg]::Save($bmp, $jpegPath, [long]$q)');
  const sizeOfPng = POWERSHELL_SCRIPT.indexOf('FileInfo($path)');
  const ladder = `$levels = @(${JPEG_QUALITY_LADDER.join(', ')})`;
  assert.ok(savePng >= 0, 'PNG 还是要先落盘');
  assert.ok(saveJpeg > savePng, '必须先存 PNG，再决定要不要转 JPEG');
  assert.ok(sizeOfPng > savePng, '尺寸判断必须在 PNG 落盘之后');
  assert.ok(POWERSHELL_SCRIPT.includes(ladder), `质量阶梯必须与常量一致：${ladder}`);
  assert.ok(POWERSHELL_SCRIPT.indexOf(ladder) < saveJpeg, '阶梯先定义再循环用');
  // 阈值是参数（唯一真相在 JS 常量里）。判定写成**早退**：`-lt` ⇒ 直接用 PNG，
  // 于是"够小就不转"和"够大才转"是同一条判定（别改成两处各判一次）。
  assert.match(POWERSHELL_SCRIPT, /\[long\]\$ReencodeAboveBytes/);
  assert.match(POWERSHELL_SCRIPT, /if \(\$bytes -lt \$ReencodeAboveBytes\) \{/);
  assert.match(POWERSHELL_SCRIPT, /return @\{ ok = \$true; format = "png"/);
  // 转成功之后删掉超大 PNG；名字只换扩展名（目录不变，尺寸不变）
  assert.match(POWERSHELL_SCRIPT, /ChangeExtension\(\$path, "\.jpg"\)/);
  assert.match(POWERSHELL_SCRIPT, /Remove-Item -LiteralPath \$path/);
  // 每张各自判断：判断在**函数里**、被逐张调用（不是全脚本只判一次）
  assert.match(POWERSHELL_SCRIPT, /function Save-QqGuguShot/);
  assert.match(POWERSHELL_SCRIPT, /Save-QqGuguShot \$bmp \$path/);
  assert.match(POWERSHELL_SCRIPT, /Save-QqGuguShot \$bmp \$OutPath/);
  // 单块屏转不下去 ⇒ 只跳过它，别把其它屏的图丢掉
  assert.match(POWERSHELL_SCRIPT, /if \(-not \$info\.ok\)/);
  // 放弃时也要删干净，并回一行 ok=0 让调用方说得出原因
  assert.match(POWERSHELL_SCRIPT, new RegExp(`${SHOT_REPORT_PREFIX} ok=0`));
  assert.match(POWERSHELL_SCRIPT, /^\s*exit 1$/m);
});

test('★ AMSI 回归：不许再出现那两个会让 Defender 整份拦掉的 PowerShell 写法', () => {
  // 2026-10-21 实测：下面两条在**同一份脚本里还有 CopyFromScreen** 时，整份脚本会被
  // Defender 判成 "malicious content"、**一行都不执行**（截图全废，而且报的是 ParserError）。
  // 同样的调用写成 C#（QqGuguJpeg 帮手）就放行 —— 这里把"别改回去"钉死。
  assert.ok(
    !POWERSHELL_SCRIPT.includes('[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders'),
    '这段 PowerShell 写法会被 AMSI 拦（改成 C# 帮手里的 ImageCodecInfo.GetImageEncoders）',
  );
  assert.ok(
    !/New-Object\s+System\.Drawing\.Imaging\.EncoderParameters/.test(POWERSHELL_SCRIPT),
    '这段 PowerShell 写法会被 AMSI 拦（改成 C# 帮手里的 new EncoderParameters）',
  );
  // 帮手本身要完整：找编码器 → 设质量 → 存盘
  assert.match(POWERSHELL_SCRIPT, /public static class QqGuguJpeg/);
  assert.match(POWERSHELL_SCRIPT, /ImageCodecInfo\.GetImageEncoders\(\)/);
  assert.match(POWERSHELL_SCRIPT, /new EncoderParameters\(1\)/);
  assert.match(POWERSHELL_SCRIPT, /Encoder\.Quality/);
  assert.match(POWERSHELL_SCRIPT, /bmp\.Save\(path, chosen, parameters\)/);
});

test('jpegSize / imageInfo：从文件头读真实尺寸，垃圾一律 null', () => {
  assert.deepEqual(jpegSize(jpegBytes(7680, 2160)), { width: 7680, height: 2160 });
  assert.deepEqual(jpegSize(jpegBytes(1920, 1080)), { width: 1920, height: 1080 });
  assert.equal(jpegSize(pngBytes(10, 10)), null, 'PNG 不是 JPEG');
  assert.equal(jpegSize(Buffer.from('short')), null);
  assert.equal(jpegSize(Buffer.alloc(0)), null);
  // 只有 SOI、没有 SOF ⇒ 读不出来就不猜
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);

  assert.deepEqual(imageInfo(pngBytes(7680, 2160)), { format: 'png', width: 7680, height: 2160 });
  assert.deepEqual(imageInfo(jpegBytes(7680, 2160)), { format: 'jpeg', width: 7680, height: 2160 });
  assert.equal(imageInfo(Buffer.from('not an image')), null);
});

test('parseShotReports / parseShotReport：认 `key=value` 回执，噪音行/缺字段/垃圾数字都不炸', () => {
  const ok = parseShotReport([
    'split skipped: only one monitor',
    `${SHOT_REPORT_PREFIX} ok=1 mode=merged index=0 monitors=1 count=1 format=jpeg quality=75 reencodeMs=913 bytes=12345`,
    `${SHOT_REPORT_PREFIX} done=1 mode=merged count=1`,
    '',
  ].join('\r\n'));
  assert.deepEqual(ok, {
    ok: true,
    mode: 'merged',
    index: 0,
    monitors: 1,
    count: 1,
    format: 'jpeg',
    quality: 75,
    bytes: 12345,
    reencodeMs: 913,
  });

  // 分屏：每块屏一行，`done` 那行不算一张图
  const many = parseShotReports([
    `${SHOT_REPORT_PREFIX} ok=1 mode=split index=1 monitors=2 count=2 format=png quality=0 reencodeMs=0 bytes=11`,
    `${SHOT_REPORT_PREFIX} skip index=2 quality=60 bytes=999`,
    `${SHOT_REPORT_PREFIX} ok=1 mode=split index=2 monitors=2 count=2 format=jpeg quality=90 reencodeMs=300 bytes=22`,
    `${SHOT_REPORT_PREFIX} done=1 mode=split count=2`,
  ].join('\n'));
  assert.equal(many.length, 3, '三条图行；done 行单独排除');
  assert.deepEqual(many.map((r) => [r.ok, r.index, r.format]), [[true, 1, 'png'], [false, 2, 'png'], [true, 2, 'jpeg']]);
  assert.equal(parseShotReport(`${SHOT_REPORT_PREFIX} done=1 mode=split count=2`), null, '只有 done 行 ⇒ null');

  const gaveUp = parseShotReport(`${SHOT_REPORT_PREFIX} ok=0 format=jpeg quality=60 reencodeMs=2000 bytes=20999999`);
  assert.equal(gaveUp.ok, false);
  assert.equal(gaveUp.quality, 60);
  assert.equal(gaveUp.mode, '', '没写 mode ⇒ 空串（不编）');

  assert.equal(parseShotReport(''), null);
  assert.equal(parseShotReport(undefined), null);
  assert.equal(parseShotReport('7680x2160 at 0,0'), null, '没有回执 ⇒ null（不编数字）');

  const junk = parseShotReport(`${SHOT_REPORT_PREFIX} ok=1 format=jpeg quality=abc reencodeMs=-5 bytes=`);
  assert.equal(junk.quality, 0);
  assert.equal(junk.bytes, 0);
  assert.equal(junk.reencodeMs, 0);

  // 没有 format 字段 ⇒ 按 png 兜底（脚本里默认就是 png）
  assert.equal(parseShotReport(`${SHOT_REPORT_PREFIX} ok=1`).format, 'png');
});

test('★ pruneScreenshots：keep 的单位是**轮**（一次 2 张 ＝ 2 个文件）', () => {
  const dir = '<tmp>\\screens';
  const fsImpl = makeFs();
  // 三轮、每轮两块屏
  const round1 = ['shot-20260101-000001-000-1.png', 'shot-20260101-000001-000-2.png'];
  const round2 = ['shot-20260101-000002-000-1.png', 'shot-20260101-000002-000-2.png'];
  const round3 = ['shot-20260101-000003-000-1.png', 'shot-20260101-000003-000-2.jpg'];
  for (const name of [...round1, ...round2, ...round3]) fsImpl.files.set(`${dir}\\${name}`, Buffer.from('x'));
  for (const name of [...round1, ...round2, ...round3]) assert.match(name, SCREENSHOT_RX);
  assert.equal(SCREENSHOT_STAMP_RX.exec(round3[0])[1], '20260101-000003-000');

  // keep = 2 轮 ⇒ 留 4 个文件（不是 2 个）—— 这是"分屏之后别把上一轮当场删掉"的关键
  assert.deepEqual(pruneScreenshots({ dir, keep: 2, fsImpl }), { removed: 2, kept: 4 });
  assert.deepEqual(fsImpl.readdirSync(dir).sort(), [...round2, ...round3].sort());
});

test('pruneScreenshots：重编码出来的 shot-*.jpg 也要被清（不然永远删不掉）', () => {
  const dir = '<tmp>\\screens';
  const fsImpl = makeFs();
  const names = [
    'shot-20260101-000001-000.png',
    'shot-20260101-000002-000.jpg',
    'shot-20260101-000003-000.jpg',
  ];
  for (const name of names) fsImpl.files.set(`${dir}\\${name}`, Buffer.from('x'));
  assert.match(names[2], SCREENSHOT_RX);
  assert.equal(pruneScreenshots({ dir, keep: 1, fsImpl }).removed, 2);
  assert.deepEqual(fsImpl.readdirSync(dir).sort(), [names[2]]);
});
