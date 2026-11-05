/**
 * 文字转语音（出站，2026-10-26）：`edge-tts` → mp3，交给 NapCat 发成 QQ 语音条。
 *
 * ## 为什么是 `edge-tts`
 *
 * 纯 Python、**不加载模型、不占显存**，一条 13 字的话实测 **1178 ms / 21 744 B**（3.6 s 音频）。
 * 备选 Windows SAPI 也能离线出声，但音色很机械（小鲸鱼是社交人格，那个声音会露馅），
 * 所以**不做自动兜底**：合成失败就当"这条语音没发"，由调用方让她改回文字。
 *
 * ## 谁负责把 mp3 变成 QQ 语音条
 *
 * **NapCat 自己**。它收到 `{type:'record', data:{file:'<本地路径>'}}` 后会用自带的
 * native addon（`D:\QQNT\napcat\native\ffmpeg\ffmpegAddon.win32.x64.node`）把 mp3 转成 silk
 * ——2026-10-26 真机验过：落盘文件头是 `#!SILK_V3`、9 951 B，`send_msg` 往返 0.70 s。
 * ⚠️ 它的 **ffmpeg 命令行适配器那条路没实现 silk 转换（直接 throw）**，所以别指望
 * "自己装个 ffmpeg 转一下" —— 交给 NapCat 就行。
 *
 * ## 三条硬约束（都是踩过坑的）
 *
 * 1. **临时/缓存目录必须落在工作区**（`[tts] cache_dir`，默认 `<工作区>\shared\tmp\qq-tts`）。
 *    `<DSH_HOME>\` 对 spawn 出去的 python **是只读的** ⇒ 落那儿就是 `Permission denied`，
 *    整条链路静默失败（2026-10-25 语音转写栽过一次，见 `voice.mjs` 的同名注释）。
 * 2. **参数走数组、文本走文件**：`spawn(python, [args])` 不经过 shell；要念的文本
 *    写进 `.txt` 再让 python 读 —— 中文/引号/emoji 一旦穿过命令行就可能被二次解析。
 * 3. **结果走文件、不走 stdout**：Windows 控制台是 GBK，中文错误直接打印会炸
 *    （`tools/tts-say.py` 会把 `{ok,error}` 写成 UTF-8 JSON）。
 *
 * @module qq-gugu/tts
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件自带的合成脚本（`tools/tts-say.py`）；`[tts] script` 留空就用它。 */
export const DEFAULT_TTS_SCRIPT = fileURLToPath(new URL('../../tools/tts-say.py', import.meta.url));

// 2026-10-26：`[tts]` 的字段名与 `index.mjs` 的 `loadTtsConfig()` 一一对应
// （`max_chars` / `allow_groups` / `min_gap_ms` / `cache_dir` / `timeout_ms` …）。
// ⚠️ 改字段名要**同时**改两处，否则配置会被**静默忽略**（回默认值，而快照里看起来"配了"）。

/**
 * 默认配置。**真源只在这里**（`index.mjs` 的 `loadTtsConfig` 会引用它，不重抄）。
 *
 * @type {{enabled: boolean, voice: string, rate: string, pitch: string, maxChars: number, allowGroups: boolean, minGapMs: number, timeoutMs: number, python: string, script: string, cacheDir: string}}
 */
export const DEFAULT_TTS = Object.freeze({
  /** 默认**关**：开它要装 edge-tts（联网）+ 配 python 路径，不能默认假设有。 */
  enabled: false,
  /** 音色：`zh-CN-XiaoxiaoNeural`（Warm，实测最自然）；`list_voices()` 里 zh-CN 共 8 个。 */
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+0%',
  pitch: '+0Hz',
  /**
   * 一次最多念多少字。超过就**截断**（并在结果里说清截了多少）——
   * edge-tts 对超长文本会明显变慢，而语音条本身也不适合长内容（超过 60 s 微信/QQ 都不友好）。
   */
  maxChars: 120,
  /** 群里默认**不许**发语音：语音条在群里太显眼，容易被当成刷屏。 */
  allowGroups: false,
  /** 同一个会话两次语音之间的最小间隔（防连发）。 */
  minGapMs: 5_000,
  /** 单次合成超时（超了就杀进程，当失败处理）。 */
  timeoutMs: 20_000,
  /** 带 edge-tts 的 python（空 = 没配，等于关）。 */
  python: '',
  /** 合成脚本；空 = 用 {@link DEFAULT_TTS_SCRIPT}。 */
  script: '',
  /** mp3 缓存目录；空 = `os.tmpdir()/qq-tts`（**部署时应该显式配到工作区**）。 */
  cacheDir: '',
});

/** 缓存最多留多少条（短句复用率高：嗯嗯 / 好呀 / 晚安）。 */
const CACHE_MAX_ENTRIES = 200;

/**
 * 建一个合成器。**所有方法永不抛**（失败是返回值，不是异常）。
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled] `[tts] enabled`
 * @param {string} [options.pythonPath] 带 edge-tts 的 python.exe
 * @param {string} [options.scriptPath] `tools/tts-say.py`（留空用自带的）
 * @param {string} [options.voice] 默认音色
 * @param {string} [options.rate] 默认语速
 * @param {string} [options.pitch] 默认音高
 * @param {number} [options.maxChars] 单条字数上限（超出截断）
 * @param {string} [options.cacheDir] mp3 缓存目录（**别指到 `<DSH_HOME>`**）
 * @param {number} [options.timeoutMs] 单次合成超时
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {typeof nodeSpawn} [options.spawnImpl] 测试注入
 * @param {typeof fs} [options.fsImpl] 测试注入
 * @param {() => number} [options.now] 测试注入
 * @returns {{
 *   enabled: boolean,
 *   describe: () => object,
 *   synthesize: (input: {text: unknown, voice?: unknown, rate?: unknown, pitch?: unknown}) => Promise<{ok: boolean, path?: string, cached?: boolean, ms: number, chars?: number, bytes?: number, truncated?: {from: number, to: number}, error?: string}>,
 * }}
 */
export function createTtsSpeaker({
  enabled = DEFAULT_TTS.enabled,
  pythonPath = DEFAULT_TTS.python,
  scriptPath = DEFAULT_TTS.script,
  voice = DEFAULT_TTS.voice,
  rate = DEFAULT_TTS.rate,
  pitch = DEFAULT_TTS.pitch,
  maxChars = DEFAULT_TTS.maxChars,
  cacheDir = DEFAULT_TTS.cacheDir,
  timeoutMs = DEFAULT_TTS.timeoutMs,
  log = () => {},
  spawnImpl = nodeSpawn,
  fsImpl = fs,
  now = () => Date.now(),
} = {}) {
  const python = String(pythonPath ?? '').trim();
  const script = String(scriptPath ?? '').trim() || DEFAULT_TTS_SCRIPT;
  const workDir = String(cacheDir ?? '').trim() || path.join(os.tmpdir(), 'qq-tts');
  const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : DEFAULT_TTS.timeoutMs;
  const charLimit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.floor(Number(maxChars))
    : DEFAULT_TTS.maxChars;
  const defaultVoice = String(voice ?? '').trim() || DEFAULT_TTS.voice;
  const defaultRate = String(rate ?? '').trim() || DEFAULT_TTS.rate;
  const defaultPitch = String(pitch ?? '').trim() || DEFAULT_TTS.pitch;

  const exists = (file) => {
    if (file === '') return false;
    try {
      return typeof fsImpl?.existsSync === 'function' && fsImpl.existsSync(file);
    } catch {
      return false;
    }
  };

  // 就绪判据和 `voice.mjs` 一致：**开关 + python 存在 + 脚本存在**，三条缺一就是"没开"。
  // 缺的理由要进 `describe()`，否则"她为什么不发语音"只能靠猜。
  const ready = enabled === true && python !== '' && exists(python) && exists(script);
  let notReadyReason = '';
  if (enabled !== true) notReadyReason = '`[tts] enabled` 是关的';
  else if (python === '') notReadyReason = '没配 `[tts] python`（带 edge-tts 的 python.exe）';
  else if (!exists(python)) notReadyReason = '`[tts] python` 指向的文件不存在';
  else if (!exists(script)) notReadyReason = '合成脚本不存在（`tools/tts-say.py`）';

  /** 观测计数（进调试快照；光打日志查不到 —— 宿主 logger 不落盘）。 */
  const stats = {
    enabled: ready === true,
    attempts: 0,
    ok: 0,
    failed: 0,
    cached: 0,
    truncated: 0,
    lastMs: 0,
    lastBytes: 0,
    lastError: '',
    lastChars: 0,
    lastAt: '',
  };

  /** `sha256(voice|rate|pitch|text)` → mp3 路径（同参数同文本必然同文件）。 */
  const hashOf = (parts) => createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 32);

  /** 把一条命令跑完，`{code, stdout, stderr, timedOut, spawnError}`；**永不 reject**。 */
  const runOnce = (exe, args) => new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    // 监听器不摘（同 `voice.mjs` 的 `runOnce`）：超时后进程可能还在写，
    // 摘掉会把管道塞满、把子进程卡住。`settled` 保证只 resolve 一次。
    if (typeof child.stdout?.on === 'function') {
      child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-2048); });
    }
    if (typeof child.stderr?.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2048); });
    }
    child.once('error', (error) => finish({ spawnError: error }));
    child.once('close', (code) => finish({ code, stdout, stderr }));
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退了 */
      }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, limit);
    if (typeof timer.unref === 'function') timer.unref();
  });

  /**
   * 合成一句。**永不抛**；失败返回 `{ok:false, error:'…'}`（调用方据此让她改文字）。
   *
   * @param {{text: unknown, voice?: unknown, rate?: unknown, pitch?: unknown}} input
   * @returns {Promise<{ok: boolean, path?: string, cached?: boolean, ms: number, chars?: number, bytes?: number, truncated?: {from: number, to: number}, error?: string}>}
   */
  const synthesize = async ({ text = '', voice: voiceIn = '', rate: rateIn = '', pitch: pitchIn = '' } = {}) => {
    const startedAt = now();
    const elapsed = () => Math.max(0, now() - startedAt);
    if (ready !== true) return { ok: false, error: `语音合成没开：${notReadyReason}`, ms: elapsed() };

    const raw = String(text ?? '').replace(/\s+/gu, ' ').trim();
    if (raw === '') return { ok: false, error: '要念的话是空的', ms: elapsed() };

    // 截断：按**码点**切（不要按字符串下标 —— emoji 会被切成半个代理对）。
    const points = Array.from(raw);
    const spoken = points.length > charLimit ? points.slice(0, charLimit).join('') : raw;
    // ⚠️ 报给调用方的字数也按码点算（`spoken.length` 是 UTF-16 单元数，emoji 会算成 2）。
    const spokenChars = Array.from(spoken).length;
    const truncated = points.length > charLimit ? { from: points.length, to: charLimit } : undefined;
    if (truncated !== undefined) {
      stats.truncated += 1;
      log('info', '发的语音超长，已截断', { from: truncated.from, to: truncated.to, limit: charLimit });
    }

    const finalVoice = String(voiceIn ?? '').trim() || defaultVoice;
    const finalRate = String(rateIn ?? '').trim() || defaultRate;
    const finalPitch = String(pitchIn ?? '').trim() || defaultPitch;
    const key = hashOf([finalVoice, finalRate, finalPitch, spoken]);
    const outFile = path.join(workDir, `${key}.mp3`);

    // 缓存：同音色同参数同文本 ⇒ 同一个文件，命中就是 0 ms。
    stats.attempts += 1;
    if (exists(outFile)) {
      let bytes = 0;
      try {
        bytes = fsImpl.statSync(outFile).size;
      } catch {
        bytes = 0;
      }
      if (bytes > 0) {
        stats.cached += 1;
        stats.ok += 1;
        stats.lastMs = elapsed();
        stats.lastBytes = bytes;
        stats.lastChars = spokenChars;
        stats.lastError = '';
        stats.lastAt = new Date(now()).toISOString();
        return { ok: true, path: outFile, cached: true, bytes, chars: spokenChars, ms: elapsed(), truncated };
      }
      // 0 字节的残留文件（上次写到一半被打断）⇒ 当没缓存，重来一遍。
    }

    const textFile = path.join(workDir, `${key}.txt`);
    const resultFile = path.join(workDir, `${key}.json`);
    try {
      if (typeof fsImpl?.mkdirSync === 'function') fsImpl.mkdirSync(workDir, { recursive: true });
      // 文本走文件：中文/引号/emoji 不走命令行（AGENTS.md 那条"传数组还是传字符串"的分界）。
      fsImpl.writeFileSync(textFile, spoken, 'utf8');
      if (typeof fsImpl?.rmSync === 'function') fsImpl.rmSync(resultFile, { force: true });
    } catch (error) {
      stats.failed += 1;
      stats.lastError = `写临时文件失败：${error instanceof Error ? error.message : String(error)}`;
      stats.lastAt = new Date(now()).toISOString();
      return { ok: false, error: stats.lastError, ms: elapsed() };
    }

    const run = await runOnce(python, [
      script,
      '--text-file', textFile,
      '--out', outFile,
      '--result', resultFile,
      '--voice', finalVoice,
      '--rate', finalRate,
      '--pitch', finalPitch,
    ]);

    // 结果只认文件（stdout 只是给日志看的 ASCII 摘要）。
    let payload = null;
    try {
      payload = JSON.parse(String(fsImpl.readFileSync(resultFile, 'utf8')));
    } catch {
      payload = null;
    }

    const fail = (error) => {
      stats.failed += 1;
      stats.lastError = error;
      stats.lastAt = new Date(now()).toISOString();
      log('warn', '语音合成失败', { error: error.slice(0, 300) });
      return { ok: false, error, ms: elapsed(), truncated };
    };

    if (run.spawnError !== undefined) return fail(`起不了 python：${run.spawnError.message ?? String(run.spawnError)}`);
    if (run.timedOut === true) return fail(`语音合成超时（>${limit} ms）`);
    if (payload === null) {
      return fail(`合成的结果文件读不出来（python 退出码 ${run.code ?? '?'}）${run.stderr ? `：${String(run.stderr).slice(0, 200)}` : ''}`);
    }
    if (payload.ok !== true) return fail(String(payload.error ?? '合成失败（没给原因）'));

    let bytes = Number(payload.bytes);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      try {
        bytes = fsImpl.statSync(outFile).size;
      } catch {
        bytes = 0;
      }
    }
    if (!Number.isFinite(bytes) || bytes <= 0) return fail('合成说成功了，但 mp3 是空的');

    try {
      if (typeof fsImpl?.rmSync === 'function') fsImpl.rmSync(textFile, { force: true });
    } catch {
      /* 文本残留不影响任何事 */
    }

    stats.ok += 1;
    stats.lastMs = elapsed();
    stats.lastBytes = bytes;
    stats.lastChars = spokenChars;
    stats.lastError = '';
    stats.lastAt = new Date(now()).toISOString();
    return { ok: true, path: outFile, cached: false, bytes, chars: spokenChars, ms: elapsed(), truncated };
  };

  return {
    enabled: ready === true,
    describe: () => ({
      ...stats,
      voice: defaultVoice,
      rate: defaultRate,
      pitch: defaultPitch,
      maxChars: charLimit,
      timeoutMs: limit,
      cacheDir: workDir,
      /** 没开的时候**为什么**没开（配置页/排查就靠这一句）。 */
      notReadyReason: ready === true ? '' : notReadyReason,
    }),
    synthesize,
  };
}
