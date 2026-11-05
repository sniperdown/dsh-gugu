/**
 * 屏幕截图（2026-10-21 起；2026-10-22 改成**每块屏一张**）。
 *
 * ## 为什么要它
 * 用户原话：定时唤醒她的时候，让她**能看见屏幕现在是什么样**（主屏 + 副屏）。
 *
 * **2026-10-22 改了口径**（用户原话：「两个屏幕 → 两张图，分开」）：
 * 以前把两块屏拼成**一张**（截整个虚拟桌面），现在**每块屏各截一张**、分开投递。
 *
 * | 模式 | 怎么截 | 文件名 |
 * |---|---|---|
 * | **split**（默认） | `[Screen]::AllScreens` 逐块 `CopyFromScreen(screen.Bounds)` | `shot-<时间戳>-1.png` / `-2.png` |
 * | **merged**（降级） | 原来那套：`SystemInformation::VirtualScreen` 一次性截拼接图 | `shot-<时间戳>.png` |
 *
 * **降级是硬要求**：分屏拿不到 ≥2 块屏、或分屏过程中抛异常 ⇒ 回落到 merged，
 * **绝不空手**（截图是"锦上添花"，但"连一张都没有"和"少一块屏"是两回事）。
 * 单块屏自己的图大到转 JPEG 也压不下去时，只丢那一块、其余照常留着。
 *
 * ## 三条硬约束（踩过 / 用户明确要求过）
 *
 * 1. **必须先 `SetProcessDPIAware()`**。多屏 DPI 不同的机器上，进程若声明为
 *    DPI-unaware，Windows 会把坐标/尺寸**按缩放比例虚拟化** ⇒ 截出来的图
 *    只有一部分、或者位置整体偏移（最常见的表现是"只截到左上角"）。
 *    这个调用必须在**读 `Screen` / `VirtualScreen` 之前**发生。
 * 2. **绝不弹黑窗、不抢焦点**：`spawn(..., { windowsHide: true })` +
 *    `-NoProfile -NonInteractive`（不加载 profile、不等输入）。
 * 3. **脚本走文件、不走内联 `-Command`**：`-Command` 的字符串会被二次解析，
 *    引号/`$` 在历史上静默改写过内容。这里把 `.ps1` 写到 outDir，
 *    用 `-File <脚本> -OutPath <路径>` 传参（spawn 是数组传参，不经过 shell）。
 *    脚本内容**只用 ASCII**（Windows 控制台/代码页与中文标点之间的问题见 AGENTS.md）。
 *
 * ## 体积保底：超过阈值就重编码成 JPEG（**每张各自判断**）
 *
 * DSH 附件管线对**源图**有 `maxImageBytes = 20 MiB` 的硬上限（实测
 * `dsh-attachment-local`：`DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024`，
 * 判断是 `data.byteLength > maxImageBytes`）—— 超过就 `IMAGE_TOO_LARGE`
 * **直接拒收、不缩放、也不回报错**：那一轮她只收到文字，而日志里一切正常。
 * 原生分辨率的整屏 PNG 很容易越线（7680×2160 实测 9.4 MB，屏幕上有照片/视频/
 * 花哨网页时抽到过 17.0 MB）。**分屏之后每张变小了、越线概率更低，但判断必须保留** ——
 * 一块 4K 屏装满花哨内容照样能到 18 MB。
 *
 * ⇒ 每张截完先看 PNG 字节数（{@link REENCODE_ABOVE_BYTES} = 18 MiB）：
 * - **小于** ⇒ 就用 PNG（无损、清晰度优先）；
 * - **大于等于** ⇒ 在**同一次** PowerShell 调用里把**同一张位图**另存为 JPEG
 *   （质量 90，不够才 75 / 60 —— {@link JPEG_QUALITY_LADDER}），删掉超大 PNG；
 * - 连 60 都压不下去（极端）⇒ 那张 `ok:false`：**宁可不带那一块，也不让整轮失败**。
 *
 * ⚠️ 这里**只重编码、绝不缩放**：用户明确不要自研的尺寸上限。`width/height`
 * 与截图当时一模一样，DSH 之后自己会压到它的显示上限内。
 *
 * ## 返回值的用途
 * `{ ok, images: [{index, path, format, width, height, bytes, reencodeMs}], mode, count, ms }`
 * —— `images` 是**这次真正落盘的每一块屏**（split 下 2 张、merged 下 1 张）。
 * 顶层的 `path/format/width/height/bytes/reencodeMs` 是**第一张**的同名值，
 * 只为兼容老调用方（原来只投一张图）；新调用方应当读 `images`。
 *
 * `width/height/bytes` 是**压缩前**的基准：DSH 附件管线自己会缩放到它的上限内，
 * 这里刻意**不做任何我们自己的缩放**。
 *
 * ## 永不抛
 * 它挂在定时器那条路上：抛出去 = 宿主进程里的未捕获异常（2026-10-14 那次
 * 把 DSH 弄得起不来的教训）。所有失败都收敛成 `{ ok:false, error }`，
 * 调用方拿到之后**照常唤醒、只发文字**。
 *
 * @module qq-dsh/screen-capture
 */

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 单次截图默认超时。
 *
 * 冷启动（第一次 `Add-Type` 编译 P/Invoke 与 C# 帮手）实测约 5.3s，热跑约 1.3s。
 * **2026-10-22 从 8s 提到 15s**：分屏模式下一次要截 2 块屏，越线时还要各自重编码 ——
 * 8s 在两块 4K 屏 + 一次 JPEG 重编码的冷启动上会偶发超时（超时 = 那一轮没图）。
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 超过这个字节数就把同一张位图重编码成 JPEG（**每张各自判断**）。
 *
 * **为什么是 18 而不是 20**：20 MiB（20,971,520 字节）是 DSH 附件管线对源图的
 * 上限（`dsh-attachment-local` 的 `DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024`）。
 * 留 2 MiB 余量，是因为"到底多大"这件事**不完全在我们手里**：
 * - 源图之后还可能被包装/拷贝一次，字节数只会往上走；
 * - 不同来源里的 "MB" 既可能是 10^6 也可能是 2^20，正卡在边界上就是抛硬币；
 * - 线上真的越线时**不报错、静默丢图** —— 事后排查的代价远高于这 2 MiB。
 */
export const REENCODE_ABOVE_BYTES = 18 * 1024 * 1024;

/** JPEG 质量阶梯：够就用 90（最接近原图），不够依次往下。**顺序有意义**。 */
export const JPEG_QUALITY_LADDER = [90, 75, 60];

/** 脚本那份机器可读回执的前缀（`key=value`，全 ASCII，见 {@link parseShotReports}）。 */
export const SHOT_REPORT_PREFIX = 'QQGUGU-SHOT';

/**
 * 文件名前缀 / 形状：`shot-YYYYMMDD-HHmmss-SSS[-N].png|jpg`（时间戳让名字**天然可排序**）。
 *
 * - `-N` 是**分屏模式**下这块屏的序号（2026-10-22）；
 * - `.jpg` 是**超阈值重编码**后的那张（同一个名字换扩展名，2026-10-21）—— 两种都必须认，
 *   否则旧 JPEG 永远不会被 {@link pruneScreenshots} 清掉（它会当成"别人的文件"）。
 */
export const SCREENSHOT_RX = /^shot-\d{8}-\d{6}-\d{3}(?:-\d+)?\.(?:png|jpg)$/;

/** 从文件名里取出**那一轮**的时间戳（清理按"轮"分组用，见 {@link pruneScreenshots}）。 */
export const SCREENSHOT_STAMP_RX = /^shot-(\d{8}-\d{6}-\d{3})(?:-\d+)?\.(?:png|jpg)$/;

/**
 * 交给 PowerShell 的脚本。
 *
 * ⚠️ **只用 ASCII**：写成数组再 join，避免模板字面量里 `$` / 反引号被 JS 解释。
 * ⚠️ `SetProcessDPIAware()` 必须在读 `Screen` / `VirtualScreen` 之前（见文件头第 1 条）。
 * ⚠️ 截图的 PowerShell **绝不内联**成 `-Command`（见文件头第 3 条）。
 */
export const POWERSHELL_SCRIPT = [
  // 阈值由调用方从 `REENCODE_ABOVE_BYTES` 传进来（spawn 是数组传参，安全）——
  // 脚本里那个默认值只是"万一被单独跑"时的兜底，**别把它当第二份真相**。
  'param(',
  '  [Parameter(Mandatory = $true)][string]$OutPath,',
  `  [long]$ReencodeAboveBytes = ${REENCODE_ABOVE_BYTES}`,
  ')',
  '',
  '$ErrorActionPreference = "Stop"',
  '',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '',
  '# DPI awareness FIRST: on mixed-DPI multi-monitor setups a DPI-unaware process',
  '# gets virtualized coordinates and the capture is cropped / offset.',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class QqGuguDpi {',
  '  [DllImport("user32.dll")]',
  '  public static extern bool SetProcessDPIAware();',
  '}',
  '"@',
  'if (-not [QqGuguDpi]::SetProcessDPIAware()) {',
  '  # Already aware is not an error: the manifest may have set it. Do not abort.',
  '  Write-Warning "SetProcessDPIAware returned false (awareness may already be set)"',
  '}',
  '',
  '# JPEG encoder helper. Kept in C# on purpose: Windows Defender / AMSI rejects',
  '# the PowerShell spellings of these two calls (ImageCodecInfo encoder lookup,',
  '# New-Object of EncoderParameters) when the same script also captures the',
  '# screen - measured 2026-10-21, the whole script is then blocked as',
  '# "malicious content" before a single line runs. Do not reintroduce them.',
  '$jpegSource = @"',
  'using System.Drawing;',
  'using System.Drawing.Imaging;',
  'public static class QqGuguJpeg {',
  '  public static void Save(Bitmap bmp, string path, long quality) {',
  '    ImageCodecInfo chosen = null;',
  '    foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders()) {',
  '      if (codec.MimeType == "image/jpeg") { chosen = codec; }',
  '    }',
  '    if (chosen == null) { throw new System.Exception("no image/jpeg encoder available"); }',
  '    EncoderParameters parameters = new EncoderParameters(1);',
  '    parameters.Param[0] = new EncoderParameter(Encoder.Quality, quality);',
  '    bmp.Save(path, chosen, parameters);',
  '  }',
  '}',
  '"@',
  '# On PowerShell 7 System.Drawing forwards to System.Drawing.Common, which the',
  '# in-memory compiler does not reference unless we hand it the loaded assembly.',
  'Add-Type -TypeDefinition $jpegSource -ReferencedAssemblies ([System.Drawing.Bitmap].Assembly.Location)',
  '$levels = @(@@JPEG_QUALITY_LADDER@@)',
  '',
  '# Save one bitmap as PNG, and re-encode THE SAME bitmap (same pixel size,',
  '# nothing resized) as JPEG when it exceeds the caller threshold. Each image',
  '# gets its own decision - one monitor being huge must not change the others.',
  '# Returns a hashtable with ok=0 when even the lowest quality stays too big.',
  'function Save-QqGuguShot([System.Drawing.Bitmap]$bmp, [string]$path) {',
  '  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
  '  $bytes = (New-Object System.IO.FileInfo($path)).Length',
  '  if ($bytes -lt $ReencodeAboveBytes) {',
  '    return @{ ok = $true; format = "png"; quality = 0; reencodeMs = 0; bytes = $bytes; path = $path }',
  '  }',
  '  $jpegPath = [System.IO.Path]::ChangeExtension($path, ".jpg")',
  '  $fits = $false',
  '  $quality = 0',
  '  $sw = [System.Diagnostics.Stopwatch]::StartNew()',
  '  foreach ($q in $levels) {',
  '    $quality = $q',
  '    [QqGuguJpeg]::Save($bmp, $jpegPath, [long]$q)',
  '    $bytes = (New-Object System.IO.FileInfo($jpegPath)).Length',
  '    if ($bytes -lt $ReencodeAboveBytes) { $fits = $true; break }',
  '  }',
  '  $sw.Stop()',
  '  if (-not $fits) {',
  '    # Give up on THIS image only: never hand the caller an oversized source',
  '    # (DSH would drop it silently, and that round would silently lose the image).',
  '    Remove-Item -LiteralPath $jpegPath -Force -ErrorAction SilentlyContinue',
  '    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue',
  '    return @{ ok = $false; format = "jpeg"; quality = $quality; reencodeMs = [long]$sw.ElapsedMilliseconds; bytes = $bytes; path = "" }',
  '  }',
  '  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue',
  '  return @{ ok = $true; format = "jpeg"; quality = $quality; reencodeMs = [long]$sw.ElapsedMilliseconds; bytes = $bytes; path = $jpegPath }',
  '}',
  '',
  '$saved = @()',
  '$mode = "merged"',
  '',
  '# --- split mode: one image per physical monitor (the point of 2026-10-22) ----',
  '$splitProblem = ""',
  'try {',
  '  $screens = @([System.Windows.Forms.Screen]::AllScreens)',
  '  if ($screens.Length -ge 2) {',
  '    $i = 0',
  '    foreach ($screen in $screens) {',
  '      $i = $i + 1',
  '      $b = $screen.Bounds',
  '      $stem = [System.IO.Path]::GetFileNameWithoutExtension($OutPath)',
  '      $dir = [System.IO.Path]::GetDirectoryName($OutPath)',
  '      $path = [System.IO.Path]::Combine($dir, $stem + "-" + $i + ".png")',
  '      $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)',
  '      $g = [System.Drawing.Graphics]::FromImage($bmp)',
  '      $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
  '      $g.Dispose()',
  '      $info = Save-QqGuguShot $bmp $path',
  '      $bmp.Dispose()',
  '      if (-not $info.ok) {',
  '        # Only this monitor is too big: keep the others, report the skip.',
  '        Write-Output ("' + SHOT_REPORT_PREFIX + ' skip index=" + $i + " quality=" + $info.quality + " bytes=" + $info.bytes)',
  '        continue',
  '      }',
  '      $info.width = $b.Width',
  '      $info.height = $b.Height',
  '      $info.index = $i',
  '      $info.monitors = $screens.Length',
  '      $saved = $saved + $info',
  '    }',
  '    if ($saved.Length -ge 1) {',
  '      $mode = "split"',
  '    } else {',
  '      $splitProblem = "no monitor produced a usable image"',
  '    }',
  '  }',
  '} catch {',
  '  $splitProblem = $_.Exception.Message',
  '  foreach ($f in $saved) { Remove-Item -LiteralPath $f.path -Force -ErrorAction SilentlyContinue }',
  '  $saved = @()',
  '  $mode = "merged"',
  '}',
  '',
  'if ($mode -ne "split") {',
  '  if ($splitProblem -ne "") { Write-Output ("split skipped: " + $splitProblem) }',
  '  # Fallback: the whole virtual desktop as ONE image (pre-2026-10-22 behaviour).',
  '  # The union of all monitors, possibly with negative Left/Top.',
  '  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen',
  '  $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)',
  '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
  '  $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)',
  '  $g.Dispose()',
  '  $info = Save-QqGuguShot $bmp $OutPath',
  '  $bmp.Dispose()',
  '  if (-not $info.ok) {',
  '    Write-Output ("' + SHOT_REPORT_PREFIX + ' ok=0 mode=merged quality=" + $info.quality + " reencodeMs=" + $info.reencodeMs + " bytes=" + $info.bytes)',
  '    exit 1',
  '  }',
  '  $info.width = $vs.Width',
  '  $info.height = $vs.Height',
  '  $info.index = 0',
  '  $info.monitors = 1',
  '  $saved = @($info)',
  '}',
  '',
  'foreach ($f in $saved) {',
  '  Write-Output ("' + SHOT_REPORT_PREFIX + ' ok=1 mode=" + $mode + " index=" + $f.index + " monitors=" + $f.monitors + " count=" + $saved.Length + " format=" + $f.format + " quality=" + $f.quality + " reencodeMs=" + $f.reencodeMs + " bytes=" + $f.bytes)',
  '}',
  'Write-Output ("' + SHOT_REPORT_PREFIX + ' done=1 mode=" + $mode + " count=" + $saved.Length)',
].join('\r\n').replace('@@JPEG_QUALITY_LADDER@@', JPEG_QUALITY_LADDER.join(', '));

/**
 * PowerShell 候选可执行文件。**`pwsh` 优先**（本机是 7.6.6，宿主 PATH 里有），
 * 退到系统自带的 Windows PowerShell 5.1 —— 两边的 .NET 调用完全一致。
 * 都找不到才报错（`ok:false`，不抛）。
 *
 * @returns {string[]}
 */
function defaultPowerShellCandidates() {
  const list = [];
  const fromEnv = typeof process.env.QQ_PWSH_PATH === 'string' ? process.env.QQ_PWSH_PATH.trim() : '';
  if (fromEnv !== '') list.push(fromEnv);
  list.push('pwsh');
  list.push('powershell.exe');
  return list;
}

/** `2026:10:21 03:04:05.678` → `20261021-030405-678`（本地时间，文件名里不能有冒号）。 */
function stamp(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return [
    d.getFullYear(), p(d.getMonth() + 1), p(d.getDate()),
    '-',
    p(d.getHours()), p(d.getMinutes()), p(d.getSeconds()),
    '-', p(d.getMilliseconds(), 3),
  ].join('');
}

/**
 * 从 PNG 的 IHDR 读真实宽高（不解析 PowerShell 的输出 —— 那是"它说截了多大"，
 * 这个才是"文件里到底是多大"）。
 *
 * @param {Buffer} buffer
 * @returns {{width: number, height: number}|null}
 */
export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) return null;
  }
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * 从 JPEG 的 SOF 段读真实宽高（重编码后的图**尺寸不变**，但宽高还是从文件里读，
 * 不从 PowerShell 的回执里拿 —— 回执是"它说"，文件才是"事实"）。
 *
 * 只扫到第一个 SOF 就返回；分段结构不正常就 `null`（不猜）。
 *
 * @param {Buffer} buffer
 * @returns {{width: number, height: number}|null}
 */
export function jpegSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null; // 不是 SOI
  let i = 2;
  while (i + 3 < buffer.length) {
    if (buffer[i] !== 0xff) { i += 1; continue; } // 失步：往后找下一个标记
    let marker = buffer[i + 1];
    // 填充字节允许连续出现多个 0xFF
    while (marker === 0xff && i + 2 < buffer.length) { i += 1; marker = buffer[i + 1]; }
    // 无长度的独立标记：TEM / RSTn / SOI
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    // 到 EOI / SOS 还没见到 SOF ⇒ 没有可用的尺寸信息
    if (marker === 0xd9 || marker === 0xda) return null;
    if (i + 4 > buffer.length) return null;
    const length = buffer.readUInt16BE(i + 2);
    if (length < 2) return null;
    // SOF0..SOF15，除了 DHT(C4) / JPG(C8) / DAC(CC) 这三个不是 SOF
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > buffer.length) return null;
      const height = buffer.readUInt16BE(i + 5);
      const width = buffer.readUInt16BE(i + 7);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * 认出一张图的**真实格式与尺寸**（PNG 或 JPEG）。
 *
 * 重编码后落盘的可能不是 PNG，所以这里不能只看 PNG 头 —— 同时它也是
 * "这张图到底是什么"的判据（不靠扩展名、不靠 PowerShell 的说法）。
 *
 * ⚠️ 它同时被 `media.mjs` 用来判断"入站图片要不要切"（{@link imageInfo} 是通用的
 * 头部读取，不只是截图专用）。
 *
 * @param {Buffer} buffer
 * @returns {{format: 'png'|'jpeg', width: number, height: number}|null}
 */
export function imageInfo(buffer) {
  const png = pngSize(buffer);
  if (png !== null) return { format: 'png', width: png.width, height: png.height };
  const jpeg = jpegSize(buffer);
  if (jpeg !== null) return { format: 'jpeg', width: jpeg.width, height: jpeg.height };
  return null;
}

/** 把一条 `PREFIX key=value …` 行拆成对象（行首前缀已去掉）。 */
function parseReportLine(line) {
  const fields = {};
  for (const token of line.trim().split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq > 0) fields[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return fields;
}

/** 非负数字；缺字段/垃圾 ⇒ 0（不编数字）。 */
function nonNegative(value) {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * 解析**所有** `QQGUGU-SHOT` 回执行（分屏模式每张一行 + 一行 `done=1`）。
 *
 * 只用来取 **`mode` / `reencodeMs` / `bytes` / `quality`** 这些"文件里读不出来"的东西；
 * 尺寸与真实字节数仍然从文件本身读（见 {@link imageInfo}）。
 * 没有回执 / 回执是垃圾 ⇒ `[]`。
 *
 * @param {string} stdout
 * @returns {Array<{ok: boolean, mode: string, index: number, monitors: number, count: number, format: 'png'|'jpeg', quality: number, bytes: number, reencodeMs: number}>}
 */
export function parseShotReports(stdout) {
  const text = String(stdout ?? '');
  const lines = text.split(/\r?\n/).filter((row) => row.startsWith(SHOT_REPORT_PREFIX));
  const reports = [];
  for (const line of lines) {
    const fields = parseReportLine(line.slice(SHOT_REPORT_PREFIX.length));
    if (fields.done === '1' || fields.done === 'true') continue;
    reports.push({
      ok: fields.ok === '1' || fields.ok === 'true',
      mode: fields.mode === 'split' ? 'split' : (fields.mode === 'merged' ? 'merged' : ''),
      index: nonNegative(fields.index),
      monitors: nonNegative(fields.monitors),
      count: nonNegative(fields.count),
      format: fields.format === 'jpeg' ? 'jpeg' : 'png',
      quality: nonNegative(fields.quality),
      bytes: nonNegative(fields.bytes),
      reencodeMs: nonNegative(fields.reencodeMs),
    });
  }
  return reports;
}

/**
 * 解析**最后一条**回执（兼容老调用方 / 老测试的签名）。
 *
 * @param {string} stdout
 * @returns {{ok: boolean, mode: string, index: number, monitors: number, count: number, format: 'png'|'jpeg', quality: number, bytes: number, reencodeMs: number}|null}
 */
export function parseShotReport(stdout) {
  return parseShotReports(stdout).pop() ?? null;
}

/**
 * 跑一次 PowerShell。
 *
 * @returns {Promise<{code?: number|null, stdout?: string, stderr?: string, timedOut?: boolean, spawnError?: Error}>}
 */
function runOnce({ exe, scriptPath, outPath, spawnImpl, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(
        exe,
        [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath, '-OutPath', outPath,
          // 阈值走参数：`REENCODE_ABOVE_BYTES` 是唯一一份真相（脚本里那个默认值只是兜底）。
          '-ReencodeAboveBytes', String(REENCODE_ABOVE_BYTES),
        ],
        // windowsHide：不弹黑窗、不抢焦点（用户明确讨厌）。
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      resolve({ spawnError: error });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(payload);
    };

    // ⚠️ 监听器**不摘**：超时后进程可能还在写，保留 data 监听免得管道塞满把子进程卡住。
    // （`settled` 保证只 resolve 一次，后面的 close 被丢掉。）
    if (typeof child.stdout?.on === 'function') {
      child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-8192); });
    }
    if (typeof child.stderr?.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8192); });
    }

    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出 */ }
      finish({ timedOut: true, stdout, stderr });
    }, timeoutMs);

    child.once('error', (error) => finish({ spawnError: error, stdout, stderr }));
    child.once('close', (code) => finish({ code, stdout, stderr }));
  });
}

/** 正则转义（文件名基名只含数字/字母/横线，但别假设它永远如此）。 */
function escapeRx(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 截屏（默认**每块屏一张**，拿不到多屏就回落到合并一张）。
 *
 * **永不抛**：任何一步失败都返回 `{ ok:false, error }`。
 *
 * @param {object} [options]
 * @param {string} options.outDir 输出目录（工作区 tmp，比如 `<shared>\tmp\screens`）
 * @param {number} [options.timeoutMs] 单次超时（默认 {@link DEFAULT_TIMEOUT_MS}）
 * @param {typeof nodeSpawn} [options.spawnImpl] 测试注入（替身只需返回 EventEmitter + `kill`）
 * @param {typeof fs} [options.fsImpl] 测试注入（只用 `mkdirSync` / `writeFileSync` / `readFileSync` / `readdirSync` / `rmSync`）
 * @param {() => number} [options.now] 时钟（测试注入）
 * @param {string[]} [options.pwshCandidates] PowerShell 候选（测试注入）
 * @returns {Promise<{ok: true, mode: 'split'|'merged', count: number,
 *     images: Array<{index: number, path: string, format: 'png'|'jpeg', width: number, height: number, bytes: number, reencodeMs: number}>,
 *     path: string, format: 'png'|'jpeg', width: number, height: number, bytes: number, reencodeMs: number,
 *     skipped: number, ms: number}
 *   | {ok: false, error: string, ms: number}>}
 */
export async function captureVirtualDesktop({
  outDir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = nodeSpawn,
  fsImpl = fs,
  now = () => Date.now(),
  pwshCandidates,
} = {}) {
  const startedAt = now();
  const ms = () => Math.max(0, now() - startedAt);

  const dir = String(outDir ?? '').trim();
  if (dir === '') return { ok: false, error: '没有配置截图目录（outDir 为空）', ms: ms() };
  if (typeof spawnImpl !== 'function') return { ok: false, error: 'spawn 注入不是函数', ms: ms() };
  if (fsImpl === null || typeof fsImpl !== 'object') return { ok: false, error: 'fs 注入不可用', ms: ms() };

  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const at = now();
  const baseName = `shot-${stamp(at)}`;
  const outPath = path.join(dir, `${baseName}.png`);
  const scriptPath = path.join(dir, `shot-script-${process.pid}-${stamp(at)}.ps1`);
  const fileRx = new RegExp(`^${escapeRx(baseName)}(?:-\\d+)?\\.(?:png|jpg)$`, 'i');

  let wrote = false;
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.writeFileSync(scriptPath, POWERSHELL_SCRIPT, 'utf8');

    const candidates = Array.isArray(pwshCandidates) && pwshCandidates.length > 0
      ? pwshCandidates
      : defaultPowerShellCandidates();

    let lastSpawnError = null;
    // 成功那次子进程的 stdout：脚本在里面留 `QQGUGU-SHOT …` 回执
    // （`reencodeMs` 只有它知道 —— 重编码发生在那个进程内部）。
    let stdoutTail = '';
    for (const exe of candidates) {
      const result = await runOnce({ exe, scriptPath, outPath, spawnImpl, timeoutMs: budget });
      if (result.spawnError !== undefined && result.spawnError !== null) {
        // ENOENT = 这个可执行文件不在 ⇒ 换下一个候选；别的错（EACCES 等）直接算失败。
        if (result.spawnError.code === 'ENOENT') {
          lastSpawnError = result.spawnError;
          continue;
        }
        return { ok: false, error: `启动 ${exe} 失败：${result.spawnError.message ?? result.spawnError}`, ms: ms() };
      }
      if (result.timedOut === true) {
        return { ok: false, error: `截图超时（>${budget}ms，${exe}）`, ms: ms() };
      }
      if (result.code !== 0) {
        // 脚本自己放弃的情况（合并图太大，降到最后一档质量仍压不下去）：
        // 它会先删掉图、发一行 `ok=0` 回执、再 `exit 1`。这条错误比 stderr 更有用。
        const report = parseShotReports(result.stdout).filter((row) => row.ok === false).pop() ?? null;
        if (report !== null) {
          return {
            ok: false,
            error: `截图重编码后仍超过上限（${report.bytes} 字节 @ 质量 ${report.quality}，阈值 ${REENCODE_ABOVE_BYTES}）`,
            ms: ms(),
          };
        }
        const tail = String(result.stderr ?? '').trim().split(/\r?\n/).slice(-1)[0] ?? '';
        return {
          ok: false,
          error: `PowerShell 退出码 ${result.code}${tail === '' ? '' : `：${tail}`}`,
          ms: ms(),
        };
      }
      stdoutTail = String(result.stdout ?? '');
      wrote = true;
      break;
    }

    if (!wrote) {
      return {
        ok: false,
        error: `找不到 PowerShell（试过 ${candidates.join(' / ')}）${lastSpawnError === null ? '' : `：${lastSpawnError.message}`}`,
        ms: ms(),
      };
    }

    // **文件才是事实**：不按回执猜"应该有几张"，直接把这一轮写的文件列出来。
    // 脚本可能已经把某张 PNG 就地换成了 JPEG（见文件头「体积保底」）——
    // 两者只差扩展名，所以两种都认。
    let names = [];
    try {
      names = fsImpl.readdirSync(dir).filter((name) => fileRx.test(name)).sort();
    } catch (error) {
      return { ok: false, error: `读不了截图目录：${error?.message ?? error}`, ms: ms() };
    }
    if (names.length === 0) {
      return { ok: false, error: `截图文件没生成（${baseName}*）`, ms: ms() };
    }

    const report = parseShotReport(stdoutTail);
    const mode = report !== null && report.mode !== ''
      ? report.mode
      : (names.length > 1 ? 'split' : 'merged');

    const images = [];
    let skipped = 0;
    let oversizedBytes = 0;
    for (const name of names) {
      const file = path.join(dir, name);
      let buffer = null;
      try {
        buffer = fsImpl.readFileSync(file);
      } catch {
        skipped += 1;
        continue;
      }
      if (buffer === null || buffer === undefined || buffer.length === 0) {
        skipped += 1;
        continue;
      }
      const info = imageInfo(buffer);
      if (info === null) {
        skipped += 1;
        try { fsImpl.rmSync(file, { force: true }); } catch { /* 删不掉不影响判定 */ }
        continue;
      }
      // 防御：脚本本该把 ≥ 阈值的图转掉。万一没有（旧脚本 / 参数没绑上），
      // **也不把它交出去** —— 交出去等于让它静默撞上 DSH 的 `IMAGE_TOO_LARGE`，
      // 那一轮既没图、也没人知道为什么。
      if (buffer.length >= REENCODE_ABOVE_BYTES) {
        skipped += 1;
        oversizedBytes = Math.max(oversizedBytes, buffer.length);
        try { fsImpl.rmSync(file, { force: true }); } catch { /* 同上 */ }
        continue;
      }
      images.push({
        index: images.length + 1,
        path: file,
        format: info.format,
        width: info.width,
        height: info.height,
        bytes: buffer.length,
        // 没重编码就是 0（失败/缺回执按 0 算，不编数字）。
        // 分屏时回执是按 index 对齐的；对不上就记 0，别把别人的耗时安上去。
        reencodeMs: report !== null && report.count <= 1 ? report.reencodeMs : 0,
      });
    }

    if (images.length === 0) {
      if (oversizedBytes > 0) {
        return {
          ok: false,
          error: `截图仍有 ${oversizedBytes} 字节（≥ ${REENCODE_ABOVE_BYTES}），放弃带图`,
          ms: ms(),
        };
      }
      return {
        ok: false,
        error: `截图文件全都不合规（${names.length} 个，${skipped} 个被跳过）`,
        ms: ms(),
      };
    }
    const first = images[0];
    return {
      ok: true,
      mode,
      count: images.length,
      images,
      skipped,
      // 兼容层：老调用方只认一张图。新调用方读 `images`。
      path: first.path,
      format: first.format,
      width: first.width,
      height: first.height,
      bytes: first.bytes,
      reencodeMs: first.reencodeMs,
      ms: ms(),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), ms: ms() };
  } finally {
    // 临时脚本删掉（截失败的半截图也删掉：留着只会被当成"上一次的"）。
    try { fsImpl.rmSync(scriptPath, { force: true }); } catch { /* 删不掉不影响结果 */ }
    if (!wrote) {
      let leftovers = [];
      try {
        leftovers = fsImpl.readdirSync(dir).filter((name) => fileRx.test(name));
      } catch {
        leftovers = [];
      }
      for (const name of leftovers) {
        try { fsImpl.rmSync(path.join(dir, name), { force: true }); } catch { /* 本来就没生成 */ }
      }
    }
  }
}

/**
 * 只保留最近 `keep` **轮**截图（`keep: 2` ⇒ 最多 2×每轮张数个文件）。
 *
 * ## ⚠️ 语义在 2026-10-22 改过（一次 2 张之后，"保留 N 个文件"会立刻删掉上一轮）
 * 分屏模式下一次产生**多张**（每块屏一张）。如果 `keep` 还是"文件数"，那么
 * `screenshotsKeep = 2` 会在**同一个 tick 里**把上一轮的图全删掉 —— 表面上"保留了 2 张"，
 * 实际上永远只有最新那一轮。所以现在按**轮（时间戳）**分组：保留最近 `keep` 轮。
 *
 * ⚠️ 只认 `shot-YYYYMMDD-HHmmss-SSS[-N].(png|jpg)` 这个形状 —— 目录是工作区 tmp，
 * 但这个函数**只删自己写的东西**（别的文件一律不碰）。
 *
 * @param {object} [options]
 * @param {string} options.dir
 * @param {number} [options.keep] 保留最近几**轮**（默认 2）
 * @param {typeof fs} [options.fsImpl]
 * @returns {{removed: number, kept: number}} `kept` 是留下的**文件数**
 */
export function pruneScreenshots({ dir, keep = 2, fsImpl = fs } = {}) {
  const result = { removed: 0, kept: 0 };
  const target = String(dir ?? '').trim();
  if (target === '' || fsImpl === null || typeof fsImpl !== 'object') return result;
  try {
    const raw = Number(keep);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 2;
    // 文件名里带时间戳 ⇒ 按名字排序就是按时间排序（不需要 stat，快且确定）。
    const groups = new Map();
    for (const name of fsImpl.readdirSync(target)) {
      const match = SCREENSHOT_STAMP_RX.exec(name);
      if (match === null) continue;
      const key = match[1];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(name);
    }
    const stamps = [...groups.keys()].sort();
    const doomed = stamps.slice(0, Math.max(0, stamps.length - limit));
    for (const key of doomed) {
      for (const name of groups.get(key)) {
        try {
          fsImpl.rmSync(path.join(target, name), { force: true });
          result.removed += 1;
        } catch {
          /* 单张删不掉就留着：清理失败不该影响唤醒 */
        }
      }
    }
    for (const key of stamps.slice(-limit)) {
      result.kept += groups.get(key).length;
    }
  } catch {
    /* 目录不在 / 读不了 ⇒ 没什么可清的 */
  }
  return result;
}
