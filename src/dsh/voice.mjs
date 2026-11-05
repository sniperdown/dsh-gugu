/**
 * **语音转文字**（B4 的真答案，2026-10-25）。
 *
 * ## 为什么需要这一层
 *
 * 真机定论：NapCat 的 `record` 段只给 `file` / `path` / `url` / `file_size`，
 * **没有 `text`**（服务端转写）⇒ 插件只能拿到一段 SILK v3 音频，模型"什么都听不到"。
 *
 * 但本机有现成的转写能力（`shared/tools/whisper` 的 faster-whisper + large-v3 + 4070 SUPER），
 * 所以这条链路是：
 *
 * ```
 * record 段（SILK，伪装成 .amr）
 *   → action('get_record', {file, out_format:'wav'})   ← NapCat 自己把 SILK 解成 WAV
 *   → spawn(.venv/Scripts/python.exe, tools/transcribe-voice.py …)  ← faster-whisper
 *   → 文本 ⇒ message.text 里的占位符换掉
 * ```
 *
 * **为什么要绕 get_record**：`ffmpeg` 没有 SILK 解码器（实测 `Invalid data found`），
 * 机器上也没有 `silk-v3-decoder`。NapCat 自带 SILK→WAV，用它比自己养一份解码器划算得多。
 *
 * ## 三条硬约束（都是本项目踩过的坑）
 *
 * 1. **永不抛**：这一层挂在每一轮入站上，抛出去会变成"她这一轮没反应"。
 *    所有失败都降级成 `{ok:false, error}`，调用方照旧发 `[语音（未转写）]`。
 * 2. **超时必须杀进程**：whisper 在 CPU 上可以磨很久；卡住的 python 会一直占着显存。
 * 3. **参数走数组、结果走文件**：`spawn(python, [args])` 不经过 shell（AGENTS.md 那条）；
 *    python 把 JSON 写文件而不是 stdout —— Windows 控制台是 GBK，中文直接打会炸。
 *
 * @module qq-gugu/voice
 */

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * 转写脚本的**默认位置**：插件包自己的 `tools/transcribe-voice.py`。
 *
 * 用 `import.meta.url` 算而不是写死绝对路径 —— 插件目录换了也能找到自己带的脚本。
 */
export const DEFAULT_TRANSCRIBE_SCRIPT = fileURLToPath(
  new URL('../../tools/transcribe-voice.py', import.meta.url),
);

/**
 * `[voice]` 的默认值（配置页的 `default`、`index.mjs` 的兜底都取这里，只留一份）。
 *
 * ⚠️ `enabled` 默认 **false**：转写要 spawn 一个 python + 加载 2.9GB 模型，
 * 这是**本机部署的选择**，不是插件该默认替所有人做的决定。要开就在 toml 里写
 * `enabled = true` 并把 python / model 指过去（见 `qq-gugu.toml` 的 `[voice]`）。
 */
export const DEFAULT_VOICE = Object.freeze({
  enabled: false,
  /** venv 里的 python.exe（含 faster-whisper 的那一个）。 */
  python: '',
  /** 转写脚本；空 = 用 {@link DEFAULT_TRANSCRIBE_SCRIPT}。 */
  script: '',
  /** 模型目录；空 = 让 faster-whisper 用 `large-v3` 这个名字去 HF 找。 */
  model: '',
  device: 'cuda',
  language: 'zh',
  timeoutMs: 90_000,
  /**
   * 引擎优先级：`auto`（ntqq → whisper）/ `ntqq` / `whisper`。
   *
   * `ntqq` = NapCat 的 `fetch_ptt_text`（QQ 自己的语音转文字，零 GPU）；
   * `whisper` = 本机 faster-whisper。见 `transcribe()` 的说明。
   */
  engine: 'auto',
  /** 转写缓存（键 = record 段的 `file`）；空 = 不缓存、也不落盘。 */
  cachePath: '',
  /**
   * python 写结果 JSON / 解出来的 wav 放哪。
   *
   * 🔴 **绝不能放在 `<DSH_HOME>` 下面**（2026-10-25 线上踩到）：
   * 那棵树对**子进程**是只读的（插件自己是宿主进程、能写，spawn 出去的 python 不行）
   * ⇒ `write-failed: [Errno 13] Permission denied`，整条语音转写静默失败。
   * 空 ⇒ 落到 `os.tmpdir()/qq-voice`（插件部署方一般会显式配成工作区里的目录）。
   */
  tempDir: '',
});

/** `get_record` 的超时：本机 NapCat，正常几十毫秒；超了就当取不到。 */
const GET_RECORD_TIMEOUT_MS = 20_000;

/**
 * `fetch_ptt_text` 快路径的**重试节奏**（毫秒；数组长度 = 额外重试几次）。
 *
 * ## 为什么要重试（2026-10-26 实测，`shared\2026-10-26-语音线方案.md` §1.7）
 *
 * `fetch_ptt_text` 的机制是「**调一次触发**、QQ 内核**异步**把结果写回 `pttElement.text`」，
 * 而 NapCat 的实现**不看重试触发那次调用的返回值**，只重新取一次消息看 `text` 是否非空
 * （`packages/napcat-onebot/action/msg/FetchPttText.ts`）。
 * ⇒ 到达那一刻（+1~2 s）查，几乎必然是**空**；过一会儿再查就有了。
 * 实测：一条真实语音在 **+20.2 s** 时已经能取到（上界），而"到达到刻那次"仍为空
 * ⇒ 写回延迟是**秒级**，所以这里用"查一次 → 等 500 ms → 再查"的节奏，**总预算 1.5 s**。
 *
 * ⚠️ **别把预算放大到十几秒**：那会变成"她听见了但要等二十秒才回"。
 * 到 1.5 s 还没出来就落 whisper（5~30 s 的语音，whisper 只要 1~6 s，不慢）。
 * ⚠️ 也**别用盲睡固定 3 s**：已经转好的情况（占多数）会被白拖 3 秒。
 */
export const NTQQ_RETRY_DELAYS_MS = Object.freeze([500, 500]);

/** 缓存最多留多少条（一条语音一个键；200 条足够覆盖"最近说过的"）。 */
const CACHE_MAX_ENTRIES = 200;

/**
 * 转写器。
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled] `false` ⇒ 根本不去取音频（`[voice] enabled`）
 * @param {string} [options.pythonPath] venv 里的 python.exe
 * @param {string} [options.scriptPath] `tools/transcribe-voice.py`
 * @param {string} [options.modelPath] faster-whisper 模型目录（空 = 用 `large-v3` 这个名字去 HF 找）
 * @param {string} [options.device] `cuda` / `cpu`
 * @param {string} [options.language] 语言代码；空 = 自动识别
 * @param {number} [options.timeoutMs] 单次转写超时
 * @param {string} [options.cachePath] 缓存 JSON（`<DSH_HOME>\media\qq-voice-cache.json`）
 * @param {string} [options.tempDir] 临时 wav/json 放哪（默认同缓存目录下 `qq-voice-tmp`）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {typeof nodeSpawn} [options.spawnImpl] 测试注入
 * @param {typeof fs} [options.fsImpl] 测试注入
 * @returns {{
 *   enabled: boolean,
 *   describe: () => object,
 *   transcribe: (input: {segment: object, action?: Function|null}) => Promise<{ok: boolean, text?: string, ms: number, cached?: boolean, error?: string}>,
 * }}
 */
export function createVoiceTranscriber({
  enabled = DEFAULT_VOICE.enabled,
  pythonPath = DEFAULT_VOICE.python,
  scriptPath = DEFAULT_VOICE.script,
  modelPath = DEFAULT_VOICE.model,
  device = DEFAULT_VOICE.device,
  language = DEFAULT_VOICE.language,
  timeoutMs = DEFAULT_VOICE.timeoutMs,
  cachePath = DEFAULT_VOICE.cachePath,
  engine = DEFAULT_VOICE.engine,
  tempDir = '',
  ntqqRetryDelaysMs = NTQQ_RETRY_DELAYS_MS,
  log = () => {},
  spawnImpl = nodeSpawn,
  fsImpl = fs,
} = {}) {
  const python = String(pythonPath ?? '').trim();
  // 脚本路径留空 ⇒ 用插件自带的那一个（别的部署不该被迫配它）。
  const script = String(scriptPath ?? '').trim() || DEFAULT_TRANSCRIBE_SCRIPT;
  const model = String(modelPath ?? '').trim();
  const cacheFile = String(cachePath ?? '').trim();
  // 引擎模式归一化：认不出的取值当 `auto`（先问 QQ、再本地 whisper）——
  // 这是唯一"两个都好用"的形态，写错一个字不该让它彻底不转。
  const rawEngine = String(engine ?? '').trim().toLowerCase();
  const mode = rawEngine === 'ntqq' || rawEngine === 'whisper' ? rawEngine : 'auto';
  // 临时目录：**不跟着 cachePath 走**（那正是 2026-10-25 的事故：缓存放在
  // `<DSH_HOME>\media`，于是临时 JSON 也落在那儿 ⇒ python 写不进去）。
  // 没配 ⇒ 系统临时目录下的固定子目录（插件部署方一般会显式配成工作区里的路径）。
  const workDir = String(tempDir ?? '').trim() || path.join(os.tmpdir(), 'qq-voice');
  const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : 90_000;
  // 重试节奏归一化：只认"非负有限数"，别的（NaN / 负数 / 字符串）一律丢掉。
  // 空数组 = 不重试（测试里想要"只查一次"的老行为就传 `[]`）。
  const retryDelays = (Array.isArray(ntqqRetryDelaysMs) ? ntqqRetryDelaysMs : [])
    .map((ms) => Number(ms))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);

  /**
   * 等一会儿（只用于重试）。
   *
   * ⚠️ 这里**不** `unref()`：这个定时器是"当前唯一的待办"时，
   * unref 掉会让进程以为没事可做 —— 测试里就会变成"用例跑完了但没有结果"。
   */
  const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

  /** 观测计数（进调试快照；光打日志查不到 —— 宿主 logger 不落盘）。 */
  const stats = {
    enabled: false,
    attempts: 0,
    ok: 0,
    failed: 0,
    cached: 0,
    /** 因为 ntqq 那条失败而落到 whisper 的次数（`[voice] engine=auto` 时）。 */
    ntqqFailed: 0,
    /** ntqq 快路径**累计重试**了多少次（第 2/3 次才算重试；用于判"写回要多久"）。 */
    ntqqRetries: 0,
    /** ntqq 那条**一共调了几次**（含重试；成功与否都算）。 */
    ntqqCalls: 0,
    lastMs: 0,
    lastError: '',
    /** 最后一次用的是哪个引擎：`ntqq` / `whisper` / ''（还没成功过）。 */
    lastSource: '',
    lastAt: '',
  };

  const exists = (file) => {
    if (file === '') return false;
    try {
      return typeof fsImpl?.existsSync === 'function' && fsImpl.existsSync(file);
    } catch {
      return false;
    }
  };

  // 只在**说清楚了要启用**的情况下吵：没启用是常态，不该 warn。
  let ready = false;
  if (enabled !== true) {
    stats.enabled = false;
  } else if (python === '' || script === '') {
    log('warn', '语音转写没配全（缺 python 或脚本路径），当作关闭', { python, script });
  } else if (!exists(python)) {
    log('warn', '语音转写关掉了：python 路径不存在', { python });
  } else if (!exists(script)) {
    log('warn', '语音转写关掉了：转写脚本不存在', { script });
  } else {
    ready = true;
    stats.enabled = true;
  }

  /** `@type {Map<string, string>}` 键（`file`/`path`/`url` 任一）→ 文本。 */
  const cache = new Map();
  const loadCache = () => {
    if (cacheFile === '' || typeof fsImpl?.readFileSync !== 'function') return;
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(cacheFile, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') return;
      for (const [key, value] of Object.entries(parsed)) {
        const text = typeof value === 'string' ? value : (typeof value?.text === 'string' ? value.text : '');
        if (text !== '') cache.set(key, text);
      }
    } catch {
      /* 缓存坏了就当空的：转写一次的成本远小于"因此不转写" */
    }
  };
  loadCache();

  const saveCache = () => {
    if (cacheFile === '' || typeof fsImpl?.writeFileSync !== 'function') return;
    try {
      const entries = [...cache.entries()].slice(-CACHE_MAX_ENTRIES);
      fsImpl.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(entries)), 'utf8');
    } catch (error) {
      log('debug', '语音缓存写不进去（不影响转写）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** 同一时刻只跑一个 whisper：两个语音连着来不该同时加载两份模型（显存/CPU 都不划算）。 */
  let queue = Promise.resolve();

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
    // 监听器不摘（同 `image-split.mjs` / `screen-capture.mjs`）：超时后进程可能还在写，
    // 摘掉会把管道塞满、把子进程卡住。`settled` 保证只 resolve 一次。
    if (typeof child.stdout?.on === 'function') {
      child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-4096); });
    }
    if (typeof child.stderr?.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4096); });
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

  /** 找一个能用的 wav 路径（`get_record` 的 `file` 或 `base64`）。 */
  const audioFromRecord = async (segment, action) => {
    const fileName = String(segment?.file ?? '').trim();
    if (fileName === '') return { ok: false, error: 'record 段没有 file 字段，取不到音频' };
    let data;
    try {
      data = await action('get_record', { file: fileName, out_format: 'wav' }, { timeoutMs: GET_RECORD_TIMEOUT_MS });
    } catch (error) {
      return { ok: false, error: `get_record 失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (data === null || typeof data !== 'object') return { ok: false, error: 'get_record 没给数据' };

    // ① 本地路径最省事（NapCat 就把 wav 写在原文件旁边）。
    const localPath = String(data.file ?? data.url ?? '').trim();
    if (localPath !== '' && exists(localPath)) return { ok: true, audioPath: localPath, temp: false };

    // ② 只有 base64：落到临时文件（不把 base64 进日志、也不留在内存里等 GC）。
    const base64 = typeof data.base64 === 'string' ? data.base64.trim() : '';
    if (base64 !== '' && workDir !== '') {
      try {
        if (typeof fsImpl?.mkdirSync === 'function') fsImpl.mkdirSync(workDir, { recursive: true });
        const target = path.join(workDir, `wav-${randomUUID()}.wav`);
        fsImpl.writeFileSync(target, Buffer.from(base64, 'base64'));
        return { ok: true, audioPath: target, temp: true };
      } catch (error) {
        return { ok: false, error: `base64 落盘失败：${error instanceof Error ? error.message : String(error)}` };
      }
    }
    return { ok: false, error: 'get_record 既没给可读路径、也没给 base64' };
  };

  /** 真正跑一次 whisper。 */
  const transcribeFile = async (audioPath) => {
    if (workDir !== '') {
      try {
        if (typeof fsImpl?.mkdirSync === 'function') fsImpl.mkdirSync(workDir, { recursive: true });
      } catch {
        /* 建不出来就让 python 自己报错 */
      }
    }
    const outJson = workDir === ''
      ? path.join(path.dirname(audioPath), `qq-voice-${randomUUID()}.json`)
      : path.join(workDir, `transcript-${randomUUID()}.json`);
    const args = [
      script,
      '--audio', audioPath,
      '--out', outJson,
      '--device', String(device ?? 'cuda'),
      '--language', String(language ?? ''),
    ];
    if (model !== '') args.push('--model', model);

    const result = await runOnce(python, args);
    let payload = null;
    try {
      payload = JSON.parse(fsImpl.readFileSync(outJson, 'utf8'));
    } catch {
      payload = null;
    }
    try {
      if (typeof fsImpl?.rmSync === 'function') fsImpl.rmSync(outJson, { force: true });
    } catch {
      /* 临时文件清不掉不算失败 */
    }
    if (result.timedOut === true) return { ok: false, error: `转写超时（${limit}ms）` };
    if (result.spawnError !== undefined) {
      return { ok: false, error: `起不了 python：${result.spawnError?.message ?? String(result.spawnError)}` };
    }
    if (payload === null || payload.ok !== true) {
      const reason = String(result.stderr ?? '').trim().split('\n').slice(-2).join(' / ') || 'no-output';
      return { ok: false, error: `转写失败（exit=${result.code}）：${reason}` };
    }
    const text = String(payload.text ?? '').trim();
    if (text === '') return { ok: false, error: '转写结果为空（可能是纯静音）' };
    return { ok: true, text };
  };

  /**
   * 转写一条 `record` 段（**永不抛**）。
   *
   * ## 引擎优先级（`engine`，真源 `[voice] engine`）
   *
   * 1. **`ntqq`**：NapCat 的 `fetch_ptt_text`（它调的是 NTQQ 自己的
   *    `translatePtt2Text`，**QQ 服务端的语音转文字** —— 用户手机上看到的就是这个）。
   *    零 GPU、最快、对 QQ 的编码最准，所以永远先试它。
   * 2. **`whisper`**：本机 faster-whisper（`get_record` 解 WAV → python）。
   * 3. `auto`（默认）= 先 ntqq、失败再 whisper；`ntqq` / `whisper` 则只用那一个。
   *
   * ⚠️ **`fetch_ptt_text` 的真相（2026-10-26 更正）**：它不是"永远失败"，
   *    而是**"调一次触发、QQ 内核异步写回 `pttElement.text`"** —— 到达那一刻查必然为空，
   *    隔一会儿（实测秒级；上界 20.2 s）再查就有。2026-10-25 那次的"两调两失败"是**单次尝试**的锅，
   *    不是权限、也不是老消息过期。⇒ 所以这里**先试 ntqq 并重试几次**（{@link NTQQ_RETRY_DELAYS_MS}），
   *    仍不行才落 whisper。`engine=ntqq` 单独用意味着"到达到刻那 1~2 秒她听不到"，别这么配。
   *
   * @param {{segment: object, action?: Function|null, messageId?: string|number}} input
   *   `action` 是 `transport.action`（`(name, params, opts) => Promise<data>`）；
   *   `messageId` 是 OneBot 的**消息 id**（`fetch_ptt_text` 要它，不是文件名）。
   * @returns {Promise<{ok: boolean, text?: string, ms: number, cached?: boolean, source?: 'ntqq'|'whisper'|'cache', error?: string}>}
   */
  const transcribe = async ({ segment, action = null, messageId = '' } = {}) => {
    const startedAt = Date.now();
    const ms = () => Math.max(0, Date.now() - startedAt);
    if (ready !== true) return { ok: false, error: '语音转写没启用', ms: ms() };

    const key = String(segment?.file ?? segment?.path ?? segment?.url ?? '').trim();
    if (key === '') return { ok: false, error: 'record 段没有能当键的字段', ms: ms() };
    const hit = cache.get(key);
    if (typeof hit === 'string' && hit !== '') {
      stats.cached += 1;
      return { ok: true, text: hit, cached: true, source: 'cache', ms: ms() };
    }
    if (typeof action !== 'function') return { ok: false, error: '没有传输层，取不到音频', ms: ms() };

    stats.attempts += 1;

    // ---- ① 先问 QQ 自己（NapCat `fetch_ptt_text`）----
    //
    // **要重试**（2026-10-26 实测）：这条 action 是"调一次触发、QQ 内核异步写回"，
    // 到达到刻查几乎必然为空。节奏见 {@link NTQQ_RETRY_DELAYS_MS}（查→500ms→查→500ms→查，共 1.5s）。
    // ⚠️ 只在**确实没拿到**之后才 sleep：已经转好的情况（多数）一次就返回，一秒都不多等。
    let ntqqError = '';
    if (mode !== 'whisper' && String(messageId ?? '').trim() !== '') {
      const delays = [...retryDelays];
      for (let attempt = 1; ; attempt += 1) {
        stats.ntqqCalls += 1;
        if (attempt > 1) stats.ntqqRetries += 1;
        try {
          const data = await action('fetch_ptt_text', { message_id: messageId }, { timeoutMs: GET_RECORD_TIMEOUT_MS });
          const text = String(data?.text ?? '').trim();
          if (text !== '') {
            cache.set(key, text);
            saveCache();
            stats.ok += 1;
            stats.lastMs = ms();
            stats.lastError = '';
            stats.lastSource = 'ntqq';
            stats.lastAt = new Date().toISOString();
            return { ok: true, text, source: 'ntqq', cached: false, ms: ms() };
          }
          ntqqError = 'fetch_ptt_text 返回空文本';
        } catch (error) {
          ntqqError = `fetch_ptt_text 失败：${error instanceof Error ? error.message : String(error)}`;
        }
        const wait = delays.shift();
        if (wait === undefined) break;
        await sleep(wait);
      }
      stats.ntqqFailed += 1;
      // 落到 whisper 时留一行 debug：判"写回到底要多久"只能靠这条 + ntqqRetries。
      log('debug', 'fetch_ptt_text 重试后仍没拿到，落 whisper', {
        messageId: String(messageId), calls: stats.ntqqCalls, error: ntqqError,
      });
    }

    if (mode === 'ntqq') {
      stats.failed += 1;
      stats.lastError = ntqqError || 'fetch_ptt_text 不可用（没有 message_id）';
      stats.lastAt = new Date().toISOString();
      return { ok: false, error: stats.lastError, ms: ms() };
    }

    // ---- ② 落到本机 whisper ----
    const task = queue.then(async () => {
      const audio = await audioFromRecord(segment, action);
      if (audio.ok !== true) return { ok: false, error: audio.error, ms: ms() };
      let output;
      try {
        output = await transcribeFile(audio.audioPath);
      } finally {
        if (audio.temp === true) {
          try {
            if (typeof fsImpl?.rmSync === 'function') fsImpl.rmSync(audio.audioPath, { force: true });
          } catch {
            /* 临时 wav 清不掉不算失败 */
          }
        }
      }
      if (output.ok === true) {
        cache.set(key, output.text);
        if (cache.size > CACHE_MAX_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        saveCache();
      }
      // `cached: false` 显式写出来：调用方（和测试）拿它区分"这次真跑了"与"命中缓存"，
      // 留 `undefined` 会让人以为"没这个字段 = 不知道"。
      return { ...output, cached: false, source: 'whisper', ms: ms() };
    });
    // 队列本身不能因为某一条失败就断掉（后面每条语音都还要能转）。
    queue = task.then(() => undefined, () => undefined);
    const result = await task;
    if (result.ok === true) {
      stats.ok += 1;
      stats.lastMs = result.ms;
      stats.lastError = '';
      stats.lastSource = 'whisper';
    } else {
      stats.failed += 1;
      // ntqq 那条的失败原因也带上 —— 否则"为什么没用 QQ 自己的"就查不到了。
      stats.lastError = ntqqError === '' ? String(result.error ?? '') : `${String(result.error ?? '')}（ntqq: ${ntqqError}）`;
      log('warn', '语音转写失败（这一轮按未转写处理）', { error: stats.lastError });
    }
    stats.lastAt = new Date().toISOString();
    return result;
  };

  return {
    /** 配置是否齐全且可用（调用方可以据此跳过整段逻辑）。 */
    enabled: ready === true,
    /** 快照用：**只放配置与计数，不放文本**（语音内容不该进调试快照）。 */
    describe: () => ({
      ...stats,
      engine: mode,
      device: String(device ?? ''),
      language: String(language ?? ''),
      model: model === '' ? '<默认 large-v3>' : model,
      timeoutMs: limit,
      cacheEntries: cache.size,
      // 临时目录也进快照：这一格就是为了让"python 写不进去"这类事故**一眼可查**
      // （2026-10-25：它指向了 `<DSH_HOME>`，于是每次转写都 `Permission denied`）。
      tempDir: workDir,
    }),
    transcribe,
  };
}
