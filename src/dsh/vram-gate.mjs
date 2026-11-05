/**
 * **显存门控**：调视觉模型之前先看一眼空闲显存，够就走本地，不够就走云。
 *
 * ## 用户原话（2026-10-09 05:5x）
 *
 * > 「**得有个 if：调用视觉模型前先看一眼目前的显存占用，if 空闲显存小于 7g，
 * > then 使用 v4f，else 使用本地模型**」
 *
 * 方向是**反直觉的**，所以写清楚：**空闲显存少 ⇒ 用云**，空闲显存多 ⇒ 用本地。
 * 直觉容易记反（"显存不够才该用云" —— 其实这条 if 就是这个意思，
 * 但它读起来像"显存不够就用云"，而人们常把 if 写反）。这里以用户原话为准：
 * **`free < threshold` → 云（v4f），`free >= threshold` → 本地**。
 *
 * 为什么这个方向是对的（本地 4B 视觉要 ~6.16 GB，云不要显存）：
 * 空闲显存少说明卡上已经有别人（判定端点 3.34 GB / 桌面 ~4.9 GB），
 * 这时候再拉一个 6.16 GB 的本地视觉后端会**挤爆 12 GB 的卡**；
 * 而云不占显存，所以"挤"的时候把这次调用推给云是唯一安全的选择。
 *
 * ## 这一层只做"**选哪条路**"，不做调用
 *
 * 它是个**纯决策函数 + 一个带缓存的探针**，不 import 模型、不发请求。
 * 真正的切换在 `image-desc.mjs`（那里才有 `stream()`），调用方是 `index.mjs`。
 * 这么分层的理由和 `image-desc` 收"已经收拾好的 gate 形状"一样：
 * **决策能被单独测**（注入假探针就能同时覆盖"够"和"不够"两个分支），
 * 而不用去伪造一个 llama-server。
 *
 * ## 三条保守默认（都是用户点名要的方向）
 *
 * 1. **探针失败 ⇒ 用云**：`nvidia-smi` 跑不到 / 超时 / 输出解析不出来 / 不是 N 卡
 *    ⇒ 一律 `use: 'cloud'`。云不会因为"显存问不出来"而失败，本地会。
 * 2. **不缓存异常**：失败结果**不进缓存**（下一次立刻重试），
 *    只有成功读到的数字才缓存 —— 否则一次偶发超时会锁死好几秒。
 * 3. **绝不抛异常**：这个函数在"每条带图消息"的路上，抛出去等于那张图没有描述。
 *
 * @module qq-gugu/vram-gate
 */

import { execFile } from 'node:child_process';

/** 显存量的单位：MiB（`nvidia-smi --query-gpu=memory.free` 的原生单位）。 */
export const MIB = 1;
/** 1 GiB = 1024 MiB。**用户说的「7g」按这个换算**（7168 MiB），不是 7000。 */
export const GIB = 1024;

/**
 * 门控的**兜底默认值**。
 *
 * ⚠️ **真源是 `qq-gugu.toml` 的 `[vision_gate]`**（用户点名要求阈值可调：
 * 「不知道模型倾向只能自己调」那类需求，这个项目里已经栽过 —— 阈值写死在代码里
 * 就等于每次调都要改代码）。这份只在"toml 没写 / 读不到"时生效。
 *
 * `local.provider` / `local.model` 留空 = **本地路不存在** ⇒ 永远走云。
 * 这是刻意的：没配 provider 的部署（比如别人的机器）不该"看起来可以走本地、
 * 实际每次都失败再降级"，那会平白多一次失败的调用。
 */
export const DEFAULT_VISION_GATE = Object.freeze({
  /** 空闲显存**低于**这个数（MiB）就走云。用户原话是 7 GB ⇒ 7168 MiB。 */
  freeMiB: 7 * GIB,
  /** 显存读数缓存多久（毫秒）。0 = 每次都真跑 nvidia-smi（测试用）。 */
  cacheMs: 5000,
  /** `nvidia-smi` 的单次超时（毫秒）。卡上在跑大活时它会变慢，别给太紧。 */
  probeTimeoutMs: 5000,
  /** 云那条路（v4f）。 */
  cloud: Object.freeze({ provider: 'discovery-intern-ai', model: 'deepseek-v4-flash-vision' }),
  /** 本地那条路（第 2 步在 cordis.patch.yml 里加的 provider）。 */
  local: Object.freeze({ provider: '', model: '' }),
});

/**
 * 把外面（toml / 配置 / 测试）给的参数收拾成能用的形状。
 *
 * ⚠️ **越界的数一律夹到边界**（和 `normalizeStickerGate` 同一条规矩）：
 * 这一节在用户手改的 toml 里，写错一个数字不该让小鲸鱼起不来；
 * 但"夹了却不吭声"是这个项目最贵的一类坑，所以调用方要把夹过的字段打 warn
 * （见 `index.mjs` 的 `loadVisionGate`）。
 *
 * @param {unknown} raw
 * @returns {{freeMiB: number, cacheMs: number, probeTimeoutMs: number, cloud: {provider: string, model: string}, local: {provider: string, model: string}}}
 */
export function normalizeVisionGate(raw = {}) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const intIn = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const cloud = src.cloud !== null && typeof src.cloud === 'object' ? src.cloud : {};
  const local = src.local !== null && typeof src.local === 'object' ? src.local : {};
  return {
    // 阈值上界给 64 GiB：比这更大的卡不存在于本项目要考虑的范围里，
    // 而"写成 7000000（把 MiB 当字节）"这种错就会被夹到 65536 并留痕。
    freeMiB: intIn(src.freeMiB, DEFAULT_VISION_GATE.freeMiB, 1, 64 * GIB),
    // 缓存上界 10 分钟：再长就不是"几秒的缓存"了，那是"忘掉显存变化"。
    cacheMs: intIn(src.cacheMs, DEFAULT_VISION_GATE.cacheMs, 0, 600_000),
    probeTimeoutMs: intIn(src.probeTimeoutMs, DEFAULT_VISION_GATE.probeTimeoutMs, 200, 60_000),
    cloud: {
      provider: text(cloud.provider) === '' ? DEFAULT_VISION_GATE.cloud.provider : text(cloud.provider),
      model: text(cloud.model) === '' ? DEFAULT_VISION_GATE.cloud.model : text(cloud.model),
    },
    local: {
      provider: text(local.provider),
      model: text(local.model),
    },
  };
}

/**
 * 默认探针：问 `nvidia-smi` 要**空闲显存**（MiB）。
 *
 * ```text
 * nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits
 * ⇒ 6272
 * ```
 *
 * ⚠️ **多卡时只取第一行**（本项目是单卡；多卡的情形没被验证过，
 * 拿第一张卡的数字做决定至少是**确定的**，而不是随机挑一张）。
 *
 * ⚠️ 解析失败**返回 `null`，不抛异常** —— 调用方（门控）把 `null` 当"问不出来"，
 * 那会走云。为什么不在这一层决定走哪条路：探针只管读数，决策只在一处（好测）。
 *
 * @param {{execFileImpl?: typeof execFile, timeoutMs?: number}} [options]
 * @returns {Promise<{freeMiB: number, raw: string}|null>}
 */
export function probeFreeVram({ execFileImpl = execFile, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    try {
      execFileImpl(
        'nvidia-smi',
        ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error) return finish(null);
          const raw = String(stdout ?? '').trim();
          const first = raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '')[0] ?? '';
          const n = Number(first);
          if (!Number.isFinite(n) || n < 0) return finish(null);
          finish({ freeMiB: Math.floor(n), raw });
        },
      );
    } catch {
      finish(null);
    }
  });
}

/**
 * 造一个**带缓存的门控**。返回值就是 `image-desc.mjs` 要的那一个函数。
 *
 * 缓存的设计（三条，每条都对着一个具体的失败模式）：
 *
 * 1. **几秒的缓存，不是永久缓存**：`nvidia-smi` 每次要 fork 一个进程（本机实测
 *    约 80–200 ms），带图消息可能连着来几条，不缓存就是每条消息 fork 一次。
 *    但显存是**会变的**（本地后端一加载就是 +6 GB），缓存太久会让门控拿旧数字做决定。
 * 2. **并发只跑一次**：同一次读数的多个并发请求共享同一个 Promise
 *    （`inFlight`）—— 否则"3 张图一起来"就是 3 个 nvidia-smi 进程。
 * 3. **失败不进缓存**：读到 `null` 不写 `at`，下一次立刻重试。
 *
 * @param {object} [options]
 * @param {ReturnType<typeof normalizeVisionGate>|object} [options.gate] 门控参数（先过 `normalizeVisionGate`）
 * @param {(options: object) => Promise<{freeMiB: number, raw?: string}|null>} [options.probe]
 *   探针（测试注入假探针就能覆盖两个分支，不用真显卡）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {() => number} [options.now] 时钟（测试用）
 * @returns {(input?: object) => Promise<{
 *   use: 'cloud'|'local',
 *   reason: string,
 *   freeMiB: number|null,
 *   thresholdMiB: number,
 *   cached: boolean,
 *   ageMs: number|null,
 *   provider: string,
 *   model: string,
 *   cloud: {provider: string, model: string},
 *   local: {provider: string, model: string},
 * }>}
 */
export function createVisionGate({
  gate = null,
  probe = null,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  const cfg = normalizeVisionGate(gate ?? DEFAULT_VISION_GATE);
  const probeFn = typeof probe === 'function' ? probe : (opts) => probeFreeVram(opts);

  /** 最近一次**成功**读数：`{freeMiB, at}`。失败不写（见模块注释）。 */
  let last = null;
  /** 正在飞的那次读数（并发合并）。 */
  let inFlight = null;

  async function read() {
    if (last !== null && cfg.cacheMs > 0 && now() - last.at < cfg.cacheMs) {
      return { value: { freeMiB: last.freeMiB }, cached: true, ageMs: now() - last.at };
    }
    if (inFlight !== null) {
      const shared = await inFlight;
      return { value: shared, cached: true, ageMs: last === null ? null : now() - last.at };
    }
    const started = now();
    inFlight = (async () => {
      try {
        // ⚠️ 探针的契约是**直接收 `{timeoutMs}`**（和 `probeFreeVram` 一致）——
        //    不是我这边包一层。测试注入的假探针只要忽略它就行。
        return await probeFn({ timeoutMs: cfg.probeTimeoutMs });
      } catch (error) {
        log('debug', '查空闲显存时探针抛异常（按"问不出来"处理 ⇒ 走云）', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();
    let got = null;
    try {
      got = await inFlight;
    } finally {
      inFlight = null;
    }
    if (got !== null && got !== undefined && Number.isFinite(Number(got.freeMiB))) {
      last = { freeMiB: Math.floor(Number(got.freeMiB)), at: now() };
      log('debug', '查到了空闲显存', {
        freeMiB: last.freeMiB,
        thresholdMiB: cfg.freeMiB,
        tookMs: now() - started,
      });
      return { value: { freeMiB: last.freeMiB }, cached: false, ageMs: 0 };
    }
    return { value: null, cached: false, ageMs: null };
  }

  /**
   * **决策**：这次视觉调用走本地还是走云。**不抛异常。**
   *
   * @param {{localProvider?: string, localModel?: string}} [input]
   *   `localProvider` 传空串 = **本次调用没有本地路可选** ⇒ 直接走云（连显存都不用查，
   *   因为查了也没用 —— 少一次 fork）。`image-desc` 用它表达"没配本地 provider"。
   *   ⚠️ 注意：这里**不**用来表达"调用方手动指定了 provider" ——
   *   那种情况在 `image-desc` 里就分流了（手动指定优先，见那里的注释），根本不会到这一层。
   * @returns {Promise<object>} 形状见 `createVisionGate` 的 `@returns`
   */
  async function decide(input = {}) {
    const localProvider = typeof input.localProvider === 'string' ? input.localProvider.trim() : cfg.local.provider;
    const localModel = typeof input.localModel === 'string' ? input.localModel.trim() : cfg.local.model;
    const base = {
      freeMiB: null,
      thresholdMiB: cfg.freeMiB,
      cached: false,
      ageMs: null,
      provider: cfg.cloud.provider,
      model: cfg.cloud.model,
      cloud: { ...cfg.cloud },
      local: { provider: localProvider, model: localModel },
    };

    // 没有本地路 ⇒ 云。**不查显存**（查了也不会改变结论，那一次 fork 是纯浪费）。
    if (localProvider === '') {
      return { ...base, use: 'cloud', reason: 'no-local-provider' };
    }

    const read1 = await read();
    const freeMiB = read1.value === null ? null : read1.value.freeMiB;
    const withRead = { ...base, freeMiB, cached: read1.cached, ageMs: read1.ageMs };

    // ⚠️ 默认"用云"：这是本模块最重要的一条保守默认（用户点名要求）。
    if (freeMiB === null) {
      return { ...withRead, use: 'cloud', reason: 'probe-failed' };
    }
    if (freeMiB < cfg.freeMiB) {
      return { ...withRead, use: 'cloud', reason: 'vram-low' };
    }
    return { ...withRead, use: 'local', reason: 'vram-enough', provider: localProvider, model: localModel };
  }

  /** 调试/日志用：当前缓存的读数（不触发探测）。 */
  function peek() {
    if (last === null) return null;
    return { freeMiB: last.freeMiB, ageMs: now() - last.at, cacheMs: cfg.cacheMs };
  }

  /** 清掉缓存（测试与"刚发生了大显存变化"时用）。 */
  function reset() { last = null; inFlight = null; }

  return Object.assign(decide, { peek, reset, config: () => ({ ...cfg, cloud: { ...cfg.cloud }, local: { ...cfg.local } }) });
}
