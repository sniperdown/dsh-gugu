/**
 * 语音情绪旁路（2026-10-26，`wav2small`）—— **只算 arousal，只记录，不进提示词**。
 *
 * ⚠️ 生效提醒：改完 `[emotion]` 要**碰一次 `src/`**（或点「重载插件」）才会重读 toml ——
 * 这是本项目那条老规矩（配置只随重载读，`stale:false` 只证明代码新）。
 *
 * ## 为什么只留 arousal
 *
 * 两个公开数据集实测（`shared\2026-10-26-wav2small评估.md` §2.5）：
 *
 * | 维 | RAVDESS（英语 640 条） | emodb（德语 535 条） | 结论 |
 * |---|---|---|---|
 * | **arousal** | 组均值 vs 人耳锚点 **ρ=+0.95**；happy vs sad d=0.85 | **ρ=+0.93**；d=5.73 | **可用** |
 * | valence | happy vs sad **d=0.005**（均值都是 0.407） | d=0.985 | 跨数据集不一致 ⇒ **不用** |
 * | dominance | 与 arousal 的 **r=0.996** | 同上 | 同一个信号 ⇒ **丢弃** |
 *
 * ⇒ 这个模块**只把 arousal 交出去**；valence/dominance 连返回值都不带
 * （不是"记下来但不用" —— 记下来迟早有人顺手拿去当判断依据）。
 *
 * ## 三条硬约束（都有实测依据）
 *
 * 1. **clip 到 [0,1]**：模型输出没有 clamp，RAVDESS 640 条里 arousal 有 14 条 >1（最大 1.1756）。
 *    （真正做 clip 的是 `tools/emotion-adv.py`，这里再兜一层 —— 注入进来的实现可能不守规矩。）
 * 2. **时长 / RMS 门限**：纯静音会让它输出胡话（实测 valence −0.78）。门限放在
 *    **import torch 之前**（脚本里），静音一秒都不花。
 * 3. **永不抛、永不阻塞**：这是挂在**每一轮派发**上的旁路，它出错只能记一条日志 ——
 *    转写和回复绝不能因为它坏掉。
 *
 * ## 许可
 *
 * 模型 `audeering/wav2small` 是 **CC-BY-NC-SA-4.0 + research purpose only**：
 * 自用可以、**商用要授权**。它与本仓库的 MIT **不兼容** ⇒ **权重不进仓库**，
 * 要用请自己准备（见 `DEFAULT_EMOTION_MODEL`）。
 *
 * @module qq-gugu/emotion
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { qqGuguHome } from './paths.mjs';

/** 插件自带的推理脚本。 */
export const DEFAULT_EMOTION_SCRIPT = fileURLToPath(new URL('../../tools/emotion-adv.py', import.meta.url));
/**
 * **仓库里不带模型权重。**
 *
 * 原因有两条，缺一不可：
 * 1. 权重 `audeering/wav2small` 是 **CC-BY-NC-SA-4.0 + research purpose only**
 *    （禁商用、要求相同方式共享），与仓库的 MIT **不兼容**，不能一起分发；
 * 2. 一个几十 KB 的二进制放码仓里，clone 的人拿到也用不上（他大概率没有 torch）。
 *
 * 要用这个旁路就自己放一份到 `<DSH_HOME>/qq-gugu/models/`
 * （`model.safetensors` / `wav2small-model.safetensors` / `emotion-model.safetensors`
 * 三个文件名都认），或者配 `[emotion] model_dir` 指过去。
 * **拿不到就退化成"没有情绪信号"**：`enabled` 判为未就绪，快照里记一条原因，
 * 其余功能一个字节都不受影响。
 */
export const DEFAULT_EMOTION_MODEL = '';

/**
 * `[emotion]` 的默认值（**真源只在这里**）。默认**关**：它要一个装了 torch 的 python。
 *
 * @type {{enabled: boolean, python: string, script: string, modelDir: string, arousalHigh: number, minSeconds: number, minRms: number, timeoutMs: number, cacheDir: string}}
 */
export const DEFAULT_EMOTION = Object.freeze({
  enabled: false,
  /** 带 torch+safetensors+soxr 的 python（本机：`shared\tools\emotion\.venv\Scripts\python.exe`）。 */
  python: '',
  /** 推理脚本；空 = 插件自带的 `tools/emotion-adv.py`。 */
  script: '',
  /** 权重目录（含 `model.safetensors` 等）；空 = `<DSH_HOME>/qq-gugu/models/`，那里也没有就当作没有权重。 */
  modelDir: '',
  /**
   * 「听着挺急」的门槛。实测依据：RAVDESS 640 条上 `a ≥ 0.75` 的命中率是
   * angry 57% / fearful 47% / happy 37% / surprised 30% / disgust 10% / sad 7% /
   * **neutral 0% / calm 0%** —— 假阳性是 0，所以只上这一条。
   * ⚠️ **不设 `arousal_low`**：RAVDESS 的 sad 均值 0.51（打不到 0.25），
   *    那条只在 emodb 那种德语强表演数据上成立。
   */
  arousalHigh: 0.75,
  /** 短于这个秒数的语音不算（口音/噪声都撑不起一句情绪）。 */
  minSeconds: 1.0,
  /**
   * RMS 下限（满量程 = 1.0）。实测：纯静音 **0.0000**；RAVDESS 最安静的真语音 0.0010~0.0013；
   * 我们自己的 QQ 语音 **0.0366~0.1114**；emodb 最低 **0.0491**。
   * ⇒ 0.001 只挡"几乎没声音"，对真实语音留了 30 倍余量。
   */
  minRms: 0.001,
  timeoutMs: 30_000,
  /** 临时 JSON 放哪；空 = `os.tmpdir()/qq-emotion`。**部署时应该指到工作区**（见 `voice.mjs` 的同名教训）。 */
  cacheDir: '',
});

/** 内存缓存最多留多少条（键 = 音频文件 + 大小 + 修改时间）。 */
const CACHE_MAX_ENTRIES = 100;

/**
 * 建一个"听一遍、只报 arousal"的旁路器。**所有方法永不抛**。
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled] `[emotion] enabled`
 * @param {string} [options.pythonPath] 带 torch 的 python
 * @param {string} [options.scriptPath] `tools/emotion-adv.py`（留空用自带的）
 * @param {string} [options.modelDir] 权重目录（留空用自带的 `emotion-model.safetensors`）
 * @param {number} [options.arousalHigh] 「听着挺急」的门槛（只是**记录**用，v1 不进 prompt）
 * @param {number} [options.minSeconds] 时长门限
 * @param {number} [options.minRms] RMS 门限
 * @param {number} [options.timeoutMs] 单次推理超时
 * @param {string} [options.tempDir] 临时 JSON 目录
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {typeof nodeSpawn} [options.spawnImpl] 测试注入
 * @param {typeof fs} [options.fsImpl] 测试注入
 * @param {() => number} [options.now] 测试注入
 * @returns {{
 *   enabled: boolean,
 *   describe: () => object,
 *   sense: (input: {audioPath: string, text?: string, chatId?: string, messageId?: string|number}) => Promise<{ok: boolean, skipped: string, arousal: number|null, textSha: string, textLen: number, secs?: number, rms?: number, ms?: number, error?: string}>,
 * }}
 */
export function createEmotionSenser({
  enabled = DEFAULT_EMOTION.enabled,
  pythonPath = DEFAULT_EMOTION.python,
  scriptPath = DEFAULT_EMOTION.script,
  modelDir = DEFAULT_EMOTION.modelDir,
  arousalHigh = DEFAULT_EMOTION.arousalHigh,
  minSeconds = DEFAULT_EMOTION.minSeconds,
  minRms = DEFAULT_EMOTION.minRms,
  timeoutMs = DEFAULT_EMOTION.timeoutMs,
  tempDir = DEFAULT_EMOTION.cacheDir,
  log = () => {},
  spawnImpl = nodeSpawn,
  fsImpl = fs,
  now = () => Date.now(),
} = {}) {
  const python = String(pythonPath ?? '').trim();
  const script = String(scriptPath ?? '').trim() || DEFAULT_EMOTION_SCRIPT;
  const workDir = String(tempDir ?? '').trim() || path.join(os.tmpdir(), 'qq-emotion');
  const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : DEFAULT_EMOTION.timeoutMs;
  const threshold = Number.isFinite(Number(arousalHigh)) ? Number(arousalHigh) : DEFAULT_EMOTION.arousalHigh;
  const minSec = Number.isFinite(Number(minSeconds)) && Number(minSeconds) >= 0
    ? Number(minSeconds)
    : DEFAULT_EMOTION.minSeconds;
  const rmsFloor = Number.isFinite(Number(minRms)) && Number(minRms) >= 0
    ? Number(minRms)
    : DEFAULT_EMOTION.minRms;

  const exists = (file) => {
    if (file === '') return false;
    try {
      return typeof fsImpl?.existsSync === 'function' && fsImpl.existsSync(file);
    } catch {
      return false;
    }
  };

  /**
   * 权重文件：`model_dir` 三种命名都认。
   * 留空 ⇒ `<DSH_HOME>/qq-gugu/models/`（**仓库不带权重**，见 `DEFAULT_EMOTION_MODEL` 那段）。
   */
  const modelPath = (() => {
    const dir = String(modelDir ?? '').trim() || path.join(qqGuguHome(), 'models');
    for (const name of ('model.safetensors', 'wav2small-model.safetensors', 'emotion-model.safetensors')) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
    return path.join(dir, 'model.safetensors');
  })();

  const ready = enabled === true && python !== '' && exists(python) && exists(script) && exists(modelPath);
  let notReadyReason = '';
  if (enabled !== true) notReadyReason = '`[emotion] enabled` 是关的';
  else if (python === '') notReadyReason = '没配 `[emotion] python`（带 torch 的 python.exe）';
  else if (!exists(python)) notReadyReason = '`[emotion] python` 指向的文件不存在';
  else if (!exists(script)) notReadyReason = '推理脚本不存在（`tools/emotion-adv.py`）';
  else if (!exists(modelPath)) notReadyReason = '权重文件不存在（仓库不带权重：放到 `<DSH_HOME>/qq-gugu/models/` 或配 `[emotion] model_dir`）';

  /** 观测计数（进快照；logger 不落盘）。 */
  const stats = {
    enabled: ready === true,
    attempts: 0,
    scored: 0,
    skipped: 0,
    failed: 0,
    cached: 0,
    /** 跳过原因计数（`too_short` / `too_quiet`）。 */
    skipReasons: { too_short: 0, too_quiet: 0 },
    /** 越过「听着挺急」门槛的次数（v1 只记数，不告诉任何人）。 */
    overThreshold: 0,
    lastMs: 0,
    lastArousal: null,
    lastSkipped: '',
    lastError: '',
    lastAt: '',
  };

  /** `audioPath + size + mtime` → 结果（同一段音频重复算没有意义）。 */
  const cache = new Map();

  const cacheKeyOf = (audioPath) => {
    try {
      const st = fsImpl.statSync(audioPath);
      return `${audioPath}|${st.size}|${Math.floor(st.mtimeMs)}`;
    } catch {
      return `${audioPath}|?`;
    }
  };

  /** 跑一次 python，`{code, stdout, stderr, timedOut, spawnError}`；**永不 reject**。 */
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
    // 监听器不摘（同 `voice.mjs` / `tts.mjs`）：超时后进程可能还在写，摘掉会把管道塞满。
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
   * 听一段音频，只报 arousal。**永不抛**。
   *
   * @param {{audioPath: string, text?: string, chatId?: string, messageId?: string|number}} input
   * @returns {Promise<{ok: boolean, skipped: string, arousal: number|null, textSha: string, textLen: number, secs?: number, rms?: number, ms?: number, error?: string}>}
   */
  const sense = async ({ audioPath = '', text = '', chatId = '', messageId = '' } = {}) => {
    const startedAt = now();
    const elapsed = () => Math.max(0, now() - startedAt);
    const spoken = String(text ?? '');
    const textSha = spoken === '' ? '' : createHash('sha256').update(spoken, 'utf8').digest('hex').slice(0, 8);
    const textLen = Array.from(spoken).length;
    /**
     * 统一的"没算成"形状（**字段永不缺**，省得调用方到处判 undefined）。
     *
     * `ok` 的口径：**只有"内容不够"（太短/太静）算 ok:true**（那是一个正常结论）；
     * `disabled` / `no_audio` / `error` 都是 ok:false —— 她没听到东西，不算跑过。
     */
    const noScore = (skipped, error = '') => ({
      ok: skipped === 'too_short' || skipped === 'too_quiet',
      skipped,
      arousal: null,
      textSha,
      textLen,
      ...(error === '' ? {} : { error, ms: elapsed() }),
    });

    if (ready !== true) return noScore('disabled');

    const file = String(audioPath ?? '').trim();
    if (file === '') return noScore('no_audio');

    const key = cacheKeyOf(file);
    const hit = cache.get(key);
    if (hit !== undefined) {
      stats.cached += 1;
      return { ...hit, cached: true };
    }

    stats.attempts += 1;
    const resultFile = path.join(workDir, `${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 20)}.json`);
    try {
      if (typeof fsImpl?.mkdirSync === 'function') fsImpl.mkdirSync(workDir, { recursive: true });
      if (typeof fsImpl?.rmSync === 'function') fsImpl.rmSync(resultFile, { force: true });
    } catch (error) {
      stats.failed += 1;
      stats.lastError = `建临时目录失败：${error instanceof Error ? error.message : String(error)}`;
      stats.lastAt = new Date(now()).toISOString();
      return noScore('error', stats.lastError);
    }

    const run = await runOnce(python, [
      script,
      '--wav', file,
      '--out', resultFile,
      '--model', modelPath,
      '--min-seconds', String(minSec),
      '--min-rms', String(rmsFloor),
    ]);

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
      log('debug', '语音情绪没算出来（不影响转写与回复）', { error: error.slice(0, 200) });
      return noScore('error', error);
    };

    if (run.spawnError !== undefined) return fail(`起不了 python：${run.spawnError.message ?? String(run.spawnError)}`);
    if (run.timedOut === true) return fail(`情绪推理超时（>${limit} ms）`);
    if (payload === null) return fail(`结果文件读不出来（python 退出码 ${run.code ?? '?'}）`);
    if (payload.ok !== true) return fail(String(payload.error ?? '推理失败（没给原因）'));

    const skipped = String(payload.skipped ?? '');
    if (skipped !== '') {
      // 门限是**正常结论**，不是失败：记一行 debug 就够。
      stats.skipped += 1;
      if (skipped === 'too_short' || skipped === 'too_quiet') stats.skipReasons[skipped] += 1;
      stats.lastSkipped = skipped;
      stats.lastAt = new Date(now()).toISOString();
      const out = {
        ok: true,
        skipped,
        arousal: null,
        textSha,
        textLen,
        secs: Number(payload.secs) || 0,
        rms: Number(payload.rms) || 0,
        ms: elapsed(),
      };
      cache.set(key, out);
      return out;
    }

    // ⚠️ 再 clip 一次：脚本已经 clip 过，但注入进来的实现可能不守规矩。
    const raw = Number(payload.arousal);
    if (!Number.isFinite(raw)) return fail('arousal 不是有限数');
    const arousal = Math.min(1, Math.max(0, raw));

    stats.scored += 1;
    if (arousal >= threshold) stats.overThreshold += 1;
    stats.lastMs = elapsed();
    stats.lastArousal = arousal;
    stats.lastSkipped = '';
    stats.lastError = '';
    stats.lastAt = new Date(now()).toISOString();

    const out = {
      ok: true,
      skipped: '',
      arousal,
      textSha,
      textLen,
      secs: Number(payload.secs) || 0,
      rms: Number(payload.rms) || 0,
      ms: elapsed(),
      /** 只给**记录/诊断**用：v1 不进提示词（见文件头）。 */
      overThreshold: arousal >= threshold,
      chatId: String(chatId ?? ''),
      messageId: String(messageId ?? ''),
      at: stats.lastAt,
    };
    cache.set(key, out);
    if (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return out;
  };

  return {
    enabled: ready === true,
    describe: () => ({
      ...stats,
      // 把两种跳过的计数**摊平**一份：快照/配置页读起来更省事（`skipReasons` 仍在）。
      tooShort: stats.skipReasons.too_short,
      tooQuiet: stats.skipReasons.too_quiet,
      threshold,
      minSeconds: minSec,
      minRms: rmsFloor,
      timeoutMs: limit,
      model: modelPath,
      notReadyReason: ready === true ? '' : notReadyReason,
    }),
    sense,
  };
}
