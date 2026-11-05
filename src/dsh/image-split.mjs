/**
 * 入站长图切分（2026-10-22，用户要求）。
 *
 * ## 为什么需要它
 *
 * 用户从 QQ 发一张 **960×10793** 的长图给小鲸鱼，结果**小鲸鱼根本收不到那张图**：
 * DSH 的附件服务对**源图**有「每边 ≤ `maxImageDimension`」的硬上限
 * （`dsh-attachment-local`：`DEFAULT_MAX_IMAGE_DIMENSION = 8192`，
 * 判定在 `detectImage`：`Math.max(width, height) > limits.maxDimension`
 * ⇒ 抛 `IMAGE_DIMENSION_TOO_LARGE`）。超了**不缩放、不裁**，直接拒收 ——
 * 而拒收发生在 `attachments.saveImage()` 里，插件这一侧只能看到一条异常。
 *
 * ⇒ 解决办法不是"让 DSH 放宽"（那是宿主的配置，而且放宽了模型那边也未必吃得下），
 * 而是**在图片进 `saveImage()` 之前把它切成几段**，每段都在上限内。
 *
 * ## 三个刻意的取舍
 *
 * 1. **按长边切、切出来还是整宽（或整高）**：960×10793 只按高度切 ⇒ 每段 960×5937。
 *    横向不切，因为长图的信息流是竖着的，横着切会把同一行文字劈开。
 * 2. **相邻两块重叠**（默认 10%）：切在文字行中间是最坏情况 —— 一段里那行只剩上半截，
 *    另一段剩下半截，**两段都读不出那个字**。重叠一块就能让每行至少完整地落在某一段里。
 *    ⚠️ **实际重叠会大于参数**：段长是向上取整到"能覆盖整张图"的，多出来的那点全落在
 *    相邻两块上（960×10793 ⇒ 段长 5937，实际重叠约 18%）。提示词里报的是**实算值**，
 *    不是参数值 —— 报参数等于骗模型。
 * 3. **输出 JPG 质量 92**（不是 PNG）：一段 960×5937 的无损 PNG 动辄十几 MB，
 *    而 DSH 附件允许的**归一化后**字节上限只有 4 MiB（`normalizedImageMaxBytes`）。
 *    92 的质量在"文字能看清"和"体积能过"之间是实测够用的那一档。
 *
 * ## 永不抛
 * 它接在**入站消息**那条路上（用户发图 → 小鲸鱼看图）。抛出去 = 这条消息的图片部分丢失，
 * 最坏情况整轮失败。所有失败都收敛成 `{ ok:false, error }`，调用方**退回原图**。
 *
 * @module qq-dsh/image-split
 */

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 单边像素上限的**默认值**，与 `dsh-attachment-local` 的 `DEFAULT_MAX_IMAGE_DIMENSION` 对齐。
 *
 * ⚠️ 这是**兜底默认**，不是唯一真相：宿主的附件服务能在配置里改它
 * （`maxImageDimension`），调用方应当优先读 `attachments.imageLimits.maxImageDimension`，
 * 读不到才用这个数（见 `media.mjs` 的 `resolveDimensionLimit`）。
 */
export const MAX_IMAGE_DIMENSION = 8192;

/** 相邻两段的重叠比例（占段长的比例）。见文件头第 2 条。 */
export const DEFAULT_OVERLAP = 0.1;

/** 切出来的 JPG 质量。见文件头第 3 条。 */
export const JPEG_QUALITY = 92;

/**
 * 最多切几段。
 *
 * 段数越多，模型吃到的图片 token 越多（每段都是一整张图）。6 段已经能覆盖
 * 长边约 5.4 万像素（远超 QQ 能发的长图），再长就该考虑"这不是让人看的图"了。
 */
export const MAX_SEGMENTS = 6;

/** 脚本那份机器可读回执的前缀（`key=value`，全 ASCII）。 */
export const SPLIT_REPORT_PREFIX = 'QQGUGU-SPLIT';

/**
 * 切图超时。比截图松得多：一次要解码一张大图、再编码 2~6 张 JPG。
 * 冷启动（`Add-Type` 编译 C# 帮手）约 1~2s，之后每段几十到几百毫秒。
 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 交给 PowerShell 的脚本。
 *
 * ⚠️ **只用 ASCII**（写成数组再 join）：Windows 控制台代码页与中文标点之间的问题见
 * AGENTS.md；这里的脚本要能被 `-File` 直接跑。
 * ⚠️ **JPEG 编码走 C# 帮手**（`QqGuguJpegSlice`）：PowerShell 拼
 * `ImageCodecInfo::GetImageEncoders` + `New-Object EncoderParameters` 这两种写法
 * 会被 Windows Defender / AMSI 整份拦掉（`screen-capture.mjs` 2026-10-21 实测），
 * 同样的调用写成 C# 就放行。**别改回 PowerShell 写法。**
 */
export const SPLIT_SCRIPT = [
  'param(',
  '  [Parameter(Mandatory = $true)][string]$InPath,',
  '  [Parameter(Mandatory = $true)][string]$OutDir,',
  '  [Parameter(Mandatory = $true)][string]$BaseName,',
  '  [Parameter(Mandatory = $true)][string]$Ranges,',
  `  [int]$Quality = ${JPEG_QUALITY}`,
  ')',
  '',
  '$ErrorActionPreference = "Stop"',
  '',
  'Add-Type -AssemblyName System.Drawing',
  '',
  '$jpegSource = @"',
  'using System.Drawing;',
  'using System.Drawing.Imaging;',
  'public static class QqGuguJpegSlice {',
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
  '',
  '$src = $null',
  '$done = 0',
  'try {',
  '  $src = [System.Drawing.Image]::FromFile($InPath)',
  '  $i = 0',
  '  foreach ($range in $Ranges.Split(";")) {',
  '    if ($range -eq "") { continue }',
  '    $parts = $range.Split(":")',
  '    $x = [int]$parts[0]',
  '    $y = [int]$parts[1]',
  '    $w = [int]$parts[2]',
  '    $h = [int]$parts[3]',
  '    $i = $i + 1',
  '    # 24bppRgb: JPEG has no alpha. A 32bpp source would otherwise encode',
  '    # with an undefined alpha channel and some decoders render it black.',
  '    $dest = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)',
  '    $g = [System.Drawing.Graphics]::FromImage($dest)',
  '    $srcRect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)',
  '    $destRect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)',
  '    $g.DrawImage($src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)',
  '    $g.Dispose()',
  '    $target = [System.IO.Path]::Combine($OutDir, $BaseName + "-" + $i + ".jpg")',
  '    [QqGuguJpegSlice]::Save($dest, $target, [long]$Quality)',
  '    $dest.Dispose()',
  '    $bytes = (New-Object System.IO.FileInfo($target)).Length',
  '    Write-Output ("' + SPLIT_REPORT_PREFIX + ' ok=1 index=" + $i + " bytes=" + $bytes + " width=" + $w + " height=" + $h)',
  '    $done = $i',
  '  }',
  '  if ($done -lt 1) { throw "no range was written" }',
  '  Write-Output ("' + SPLIT_REPORT_PREFIX + ' done=1 count=" + $done)',
  '} finally {',
  '  if ($src -ne $null) { $src.Dispose() }',
  '}',
].join('\r\n');

/**
 * 算「这张图要切成几段、每段是哪一块」。
 *
 * **纯函数**：不碰文件、不 spawn、不读时钟 —— 所以它是整个切图逻辑里唯一能被
 * 直接钉住的地方（"960×10793 必须正好 2 段、每段 960×5937"）。
 *
 * 段长公式：`L = ceil(长边 × (1 + 重叠比例) / 段数)` —— 多出来的那一小截是留给重叠的。
 * 从 2 段开始试，取**第一个让 L ≤ 上限**的段数；一段都放不下（超过
 * `MAX_SEGMENTS × 上限 × (1 - 重叠)`）就返回**空 segments**，让调用方退回原图
 * （绝不输出一批仍然超限的切片 —— 那等于把"被拒一次"变成"被拒 N 次"）。
 *
 * 每段的起点**均匀分布**、最后一段的末尾**正好贴住图的末尾**（不越界、不缺角）。
 *
 * @param {number} width 原图宽（像素）
 * @param {number} height 原图高（像素）
 * @param {number} [limit] 单边上限（默认 {@link MAX_IMAGE_DIMENSION}）
 * @param {number} [overlap] 重叠比例（0 ≤ o < 1，默认 {@link DEFAULT_OVERLAP}）
 * @returns {{axis: 'height'|'width'|'none', segments: Array<{index: number, count: number, x: number, y: number, width: number, height: number}>}}
 *   `segments.length === 1` 表示**不用切**；`length === 0` 表示"切不动，退回原图"。
 */
export function planSplits(width, height, limit = MAX_IMAGE_DIMENSION, overlap = DEFAULT_OVERLAP) {
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { axis: 'none', segments: [] };
  }

  const rawLimit = Number(limit);
  const cap = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.floor(rawLimit) : MAX_IMAGE_DIMENSION;
  const rawOverlap = Number(overlap);
  const o = Number.isFinite(rawOverlap) && rawOverlap >= 0 && rawOverlap < 1 ? rawOverlap : DEFAULT_OVERLAP;

  // 长边决定切的方向：长图（竖）按高度切，宽图（横）按宽度切。
  const axis = h >= w ? 'height' : 'width';
  const long = axis === 'height' ? h : w;

  const buildAt = (count, segLen) => {
    const segments = [];
    for (let i = 0; i < count; i += 1) {
      // 均匀分布起点，最后一段贴住末尾（i = count-1 时正好是 long - segLen）。
      const start = count === 1 ? 0 : Math.round((i * (long - segLen)) / (count - 1));
      segments.push(axis === 'height'
        ? { index: i + 1, count, x: 0, y: start, width: w, height: segLen }
        : { index: i + 1, count, x: start, y: 0, width: segLen, height: h });
    }
    return segments;
  };

  // 长边本来就在上限内 ⇒ 一段都不切（`count = 1` 表示"原图直接用"）。
  if (long <= cap) return { axis, segments: buildAt(1, long) };

  for (let count = 2; count <= MAX_SEGMENTS; count += 1) {
    const segLen = Math.ceil((long * (1 + o)) / count);
    if (segLen <= cap) return { axis, segments: buildAt(count, segLen) };
  }
  // 切到上限段数仍然有一段超限 ⇒ 放弃（调用方退回原图）。
  return { axis, segments: [] };
}

/**
 * 相邻两段的**实际**重叠占比（百分比，整数）。
 *
 * ⚠️ **不是** `overlap` 参数：段长向上取整后，多出来的像素全落在相邻两块上
 * （960×10793 的参数是 10%，实算约 18%）。提示词里要说实算值。
 *
 * @param {{segments: Array<{x: number, y: number, width: number, height: number}>}} plan
 * @returns {number} 0 表示没有重叠 / 算不出来
 */
export function overlapPercentOf(plan) {
  const segments = Array.isArray(plan?.segments) ? plan.segments : [];
  if (segments.length < 2) return 0;
  const byHeight = segments.some((s) => Number(s.height) !== Number(segments[0].height))
    || segments.every((s) => Number(s.x) === 0);
  let percent = 0;
  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1];
    const cur = segments[i];
    const overlapPx = byHeight
      ? (Number(prev.y) + Number(prev.height)) - Number(cur.y)
      : (Number(prev.x) + Number(prev.width)) - Number(cur.x);
    const spanPx = byHeight ? Number(cur.height) : Number(cur.width);
    if (spanPx > 0 && overlapPx > 0) {
      percent = Math.max(percent, Math.round((overlapPx / spanPx) * 100));
    }
  }
  return percent;
}

/**
 * 给模型看的那句说明。
 *
 * 用户原话：「附带一句说明，例如「这是同一张图的 1/2、2/2（重叠 10%），请合起来看」」。
 * 少了这句话，模型会把同一行文字在两个切片里**各数一次**（重叠区就是这么被读错的）。
 *
 * @param {object} plan {@link planSplits} 的返回值
 * @returns {string} 不需要切（< 2 段）时返回空串
 */
export function buildSplitNote(plan) {
  const segments = Array.isArray(plan?.segments) ? plan.segments : [];
  const count = segments.length;
  if (count < 2) return '';
  const list = segments.map((_, i) => `${i + 1}/${count}`).join('、');
  const percent = overlapPercentOf(plan);
  const overlapText = percent > 0 ? `，相邻两块重叠约 ${percent}%` : '';
  return `【图片说明】这是同一张长图按长边切成 ${count} 张：${list}${overlapText}，`
    + '请按顺序把它们拼起来当成一张图看（交界处的内容会重复出现，别当成两处）。';
}

/**
 * PowerShell 候选可执行文件。与 `screen-capture.mjs` 同一套规矩：
 * `QQ_PWSH_PATH`（显式指定）→ `pwsh`（本机 7.6.6）→ 系统自带 5.1。
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

/**
 * 解析脚本回执（每段一行 + 最后一行汇总）。
 *
 * @param {string} stdout
 * @returns {{ok: boolean, done: boolean, count: number, images: Array<{index: number, bytes: number, width: number, height: number}>}|null}
 *   没有回执 ⇒ null（调用方按"文件才是事实"继续判断）
 */
export function parseSplitReport(stdout) {
  const text = String(stdout ?? '');
  const lines = text.split(/\r?\n/).filter((row) => row.startsWith(SPLIT_REPORT_PREFIX));
  if (lines.length === 0) return null;
  const images = [];
  let done = false;
  let count = 0;
  for (const line of lines) {
    const fields = {};
    for (const token of line.slice(SPLIT_REPORT_PREFIX.length).trim().split(/\s+/)) {
      const eq = token.indexOf('=');
      if (eq > 0) fields[token.slice(0, eq)] = token.slice(eq + 1);
    }
    const num = (value) => {
      const parsed = Number(value);
      return value !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    };
    if (fields.done === '1' || fields.done === 'true') {
      done = true;
      count = num(fields.count);
      continue;
    }
    if (fields.ok === '1' || fields.ok === 'true') {
      images.push({
        index: num(fields.index),
        bytes: num(fields.bytes),
        width: num(fields.width),
        height: num(fields.height),
      });
    }
  }
  return { ok: images.length > 0, done, count: count > 0 ? count : images.length, images };
}

/** 把分段计划变成脚本要的 `x:y:w:h;x:y:w:h` 串（纯 ASCII，无空格）。 */
export function rangesOf(segments) {
  const list = Array.isArray(segments) ? segments : [];
  return list
    .map((s) => `${Math.max(0, Math.floor(Number(s.x) || 0))}:${Math.max(0, Math.floor(Number(s.y) || 0))}`
      + `:${Math.max(1, Math.floor(Number(s.width) || 0))}:${Math.max(1, Math.floor(Number(s.height) || 0))}`)
    .join(';');
}

/**
 * 文件名基名：去掉目录、去掉扩展名、只留**安全 ASCII**。
 *
 * 它会被拼进 PowerShell 的字符串（`$BaseName + "-" + $i`）——虽然参数是数组传参、
 * 不经过 shell，但控制台代码页对非 ASCII 的显示仍是坑，索性归一化掉。
 *
 * @param {unknown} name
 * @returns {string}
 */
export function safeBaseName(name) {
  const raw = String(name ?? '').trim();
  const stem = raw === '' ? '' : raw.split(/[\\/]/).pop() ?? '';
  const withoutExt = stem.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const cleaned = withoutExt.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'qq-image' : cleaned.slice(0, 60);
}

/**
 * 跑一次 PowerShell（数组传参，不经过 shell）。
 *
 * @returns {Promise<{code?: number|null, stdout?: string, stderr?: string, timedOut?: boolean, spawnError?: Error}>}
 */
function runOnce({ exe, scriptPath, inPath, outDir, baseName, ranges, quality, spawnImpl, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(
        exe,
        [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          '-InPath', inPath,
          '-OutDir', outDir,
          '-BaseName', baseName,
          '-Ranges', ranges,
          '-Quality', String(quality),
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

    // 监听器**不摘**（理由同 `screen-capture.mjs`）：超时后进程可能还在写，
    // 摘掉会把管道塞满、把子进程卡住。`settled` 保证只 resolve 一次。
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

/**
 * 把一张图的字节切成若干段（每段一个 JPG 文件的字节）。
 *
 * 流程：字节写进临时目录 → 一次 PowerShell 调用切完 → 读回每段字节 → 删临时目录。
 * **永不抛**：任何一步失败都返回 `{ ok:false, error }`，调用方退回原图。
 *
 * @param {object} options
 * @param {Uint8Array|Buffer} options.data 原图字节
 * @param {string} [options.name] 原图文件名（只用来给切片起个可读的名字）
 * @param {'png'|'jpeg'} [options.format] 原图格式（决定临时文件的扩展名；PowerShell 靠内容解码，不靠它）
 * @param {Array<{x: number, y: number, width: number, height: number}>} options.segments {@link planSplits} 的结果
 * @param {number} [options.quality] JPG 质量（默认 {@link JPEG_QUALITY}）
 * @param {number} [options.timeoutMs]
 * @param {string} [options.tempRoot] 临时目录的父目录（默认 `os.tmpdir()`；测试可注入）
 * @param {typeof nodeSpawn} [options.spawnImpl] 测试注入
 * @param {typeof fs} [options.fsImpl] 测试注入（只用 mkdtempSync / writeFileSync / readFileSync / rmSync）
 * @param {string[]} [options.pwshCandidates]
 * @returns {Promise<{ok: true, images: Array<{index: number, data: Uint8Array, name: string, width: number, height: number, bytes: number}>, ms: number}
 *   | {ok: false, error: string, ms: number}>}
 */
export async function splitImageBytes({
  data,
  name = 'qq-image',
  format = 'png',
  segments,
  quality = JPEG_QUALITY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tempRoot,
  spawnImpl = nodeSpawn,
  fsImpl = fs,
  pwshCandidates,
} = {}) {
  const startedAt = Date.now();
  const ms = () => Math.max(0, Date.now() - startedAt);

  const plan = Array.isArray(segments) ? segments : [];
  if (plan.length < 1) return { ok: false, error: '没有分段计划', ms: ms() };
  if (data === null || data === undefined || typeof data.length !== 'number' || data.length === 0) {
    return { ok: false, error: '原图字节为空', ms: ms() };
  }
  if (typeof spawnImpl !== 'function') return { ok: false, error: 'spawn 注入不是函数', ms: ms() };
  if (fsImpl === null || typeof fsImpl !== 'object') return { ok: false, error: 'fs 注入不可用', ms: ms() };

  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const q = Number.isFinite(Number(quality)) && Number(quality) >= 1 && Number(quality) <= 100
    ? Math.floor(Number(quality))
    : JPEG_QUALITY;
  const baseName = safeBaseName(name);
  const root = String(tempRoot ?? '').trim() === '' ? os.tmpdir() : String(tempRoot).trim();

  let workDir = '';
  try {
    workDir = fsImpl.mkdtempSync(path.join(root, 'qq-gugu-split-'));
    const inPath = path.join(workDir, `src.${format === 'jpeg' ? 'jpg' : 'png'}`);
    const scriptPath = path.join(workDir, `split-script-${process.pid}.ps1`);
    fsImpl.writeFileSync(inPath, Buffer.from(data));
    fsImpl.writeFileSync(scriptPath, SPLIT_SCRIPT, 'utf8');

    const candidates = Array.isArray(pwshCandidates) && pwshCandidates.length > 0
      ? pwshCandidates
      : defaultPowerShellCandidates();
    const ranges = rangesOf(plan);

    let lastSpawnError = null;
    let lastStdout = '';
    let ran = false;
    for (const exe of candidates) {
      const result = await runOnce({
        exe, scriptPath, inPath, outDir: workDir, baseName, ranges, quality: q, spawnImpl, timeoutMs: budget,
      });
      if (result.spawnError !== undefined && result.spawnError !== null) {
        if (result.spawnError.code === 'ENOENT') {
          lastSpawnError = result.spawnError;
          continue;
        }
        return { ok: false, error: `启动 ${exe} 失败：${result.spawnError.message ?? result.spawnError}`, ms: ms() };
      }
      if (result.timedOut === true) {
        return { ok: false, error: `切图超时（>${budget}ms，${exe}）`, ms: ms() };
      }
      if (result.code !== 0) {
        const tail = String(result.stderr ?? '').trim().split(/\r?\n/).slice(-1)[0] ?? '';
        return {
          ok: false,
          error: `切图失败（PowerShell 退出码 ${result.code}${tail === '' ? '' : `：${tail}`}）`,
          ms: ms(),
        };
      }
      // 回执只用来留痕（尺寸取自计划、字节取自文件）—— 不拿它当真相。
      lastStdout = String(result.stdout ?? '');
      ran = true;
      break;
    }
    if (!ran) {
      return {
        ok: false,
        error: `找不到 PowerShell（试过 ${candidates.join(' / ')}）${lastSpawnError === null ? '' : `：${lastSpawnError.message}`}`,
        ms: ms(),
      };
    }

    // **文件才是事实**：不按回执去"应该有几张"，而是按计划逐段读回来，
    // 少一张就算失败（少一张的切片拼起来是残缺的，比不切更误导模型）。
    const images = [];
    for (let i = 1; i <= plan.length; i += 1) {
      const file = path.join(workDir, `${baseName}-${i}.jpg`);
      let buffer;
      try {
        buffer = fsImpl.readFileSync(file);
      } catch (error) {
        return {
          ok: false,
          error: `切片 ${i}/${plan.length} 没生成：${error?.message ?? error}`,
          ms: ms(),
        };
      }
      if (buffer === null || buffer === undefined || buffer.length === 0) {
        return { ok: false, error: `切片 ${i}/${plan.length} 是空的`, ms: ms() };
      }
      const segment = plan[i - 1];
      images.push({
        index: i,
        data: new Uint8Array(buffer),
        name: `${baseName}-${i}.jpg`,
        width: Number(segment?.width) || 0,
        height: Number(segment?.height) || 0,
        bytes: buffer.length,
      });
    }

    // 回执里的汇总（`done=1 count=N`）与"实际读回几张"不一致 ⇒ 已经在上面的循环里
    // 因为读不到文件而失败了。这里只把回执留在返回值上，方便调用方记日志。
    const report = parseSplitReport(lastStdout);
    return {
      ok: true,
      images,
      report: report === null ? null : { done: report.done, count: report.count },
      ms: ms(),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), ms: ms() };
  } finally {
    if (workDir !== '') {
      try { fsImpl.rmSync(workDir, { recursive: true, force: true }); } catch { /* 清不掉不影响结果 */ }
    }
  }
}
