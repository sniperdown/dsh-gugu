/**
 * **出站文本过一遍词表判据**（2026-11-18，实验性的观测设施）。
 *
 * ## 它做什么
 *
 * 把"已经定稿、马上要发出去"的那段文字，POST 给本机一个常驻小服务
 * （`shared/2026-11-18-困惑度校验/vocab-service/server.py`），拿回"疑似近字错"的位置，
 * 然后**往出站台账补记一行 `text-lint`**。它**不改文本、不拦截、不提示用户**。
 *
 * 判据本身（jieba 词表法）的实测：12 个构造错例检出 10 个（83%），
 * 30 句正常文本误报 10 句（33%）⇒ **这是"量"的一版，不是"修"的一版**。
 * 目的只有一个：先把留痕做出来，之后才谈得上"到底准不准"。
 *
 * ## 🔴 三条硬规矩
 *
 * | # | 规矩 | 为什么 |
 * |---|---|---|
 * | 1 | **绝不 await 在发送路径上** | 它要是慢了/挂了，消息就不能晚发一秒。调用方只拿 Promise 自己接着，不等。 |
 * | 2 | **任何失败都静默降级** | 服务没起 / 超时 / 500 / 返回垃圾 ⇒ 记一条 `svc` 状态就完事，**发送照常**。 |
 * | 3 | **绝不抛异常到事件循环** | 它挂在宿主进程里，抛出去 = 宿主退出（本项目因此崩过三次）。 |
 *
 * 这三条落实成两个形状：`inspect()` **永远 resolve**（不 reject），
 * 调用方那边再包一层 `try/catch` + `.catch()`。
 *
 * ## 生命周期：谁起这个 Python 服务
 *
 * **默认不由插件起**（`spawn: false`，见 {@link DEFAULT_TEXT_LINT} 里那段实测理由：
 * 测试会 `apply()` 整个插件，而且 Windows 的 `SO_REUSEADDR` 让"撞端口"防不住重复）。
 * 默认形态是**纯客户端**：服务在不在只影响台账里有没有 `text-lint` 行。
 *
 * 要插件自己管生命周期就开 `spawn: true`（生产走 `QQ_TEXT_LINT_SPAWN=1`），那时
 * **必须同时显式给 `script`**（`config.script` 或 `QQ_TEXT_LINT_SCRIPT`）——
 * 这个仓库不带那个 Python 服务，也不再提供默认路径（留一个假路径只会让人以为开箱能用）。
 * 开了 spawn 却没给 script ⇒ 只记一条 warn、不起服务，发送完全不受影响。
 * 给了之后：
 *
 * - 子进程带 `--parent-stdin`，父进程握住它的 stdin 管道；**父进程一死管道 EOF ⇒ 它自己退出**
 *   （Windows 上父进程死掉不会自动带走子进程，这是防孤儿的那道保险）。
 *   ⚠️ 注意它的**边界**：插件跑在宿主进程里，HMR 重载**不会**让宿主死 ⇒
 *   stdin 不会 EOF ⇒ **这条 watchdog 只管"宿主崩了"**，管不了"插件重载"。
 *   重载那一路由 `dispose()` 负责（必须显式杀，别指望自动）。
 * - spawn 失败（找不到 python / 脚本不在）⇒ 只记一条 warn，`enabled` 不变，
 *   **发送完全不受影响**。
 *
 * ## 和台账的关系
 *
 * 台账是**只追加**的，而判据结果是异步回来的（发送那一行早就写下去了），
 * 所以两边**必须是两行**，靠 `sha256` + `chatId` + 相近的 `at` 关联。
 * `text-lint` 那一行的 `sha256` 与同一条 `gw-send` 行**逐字节相同**。
 *
 * @module qq-dsh/text-lint
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';

/** 台账里这一层的标记。**它不在 `outbound-ledger.mjs` 的三个层里** —— 那三个描述"发送",
 *  这一个描述"对这段文字的观察"，只是借同一个文件落盘。 */
export const LAYER_TEXT_LINT = 'text-lint';

/** 默认服务地址。选 8791 是因为工作区里没有别的东西占它。 */
export const DEFAULT_TEXT_LINT_URL = 'http://127.0.0.1:8791';

/**
 * 本部署的 bundled Python（`load_workspace_dependencies` 报的就是这个）。
 *
 * 写死路径的理由和 `outbound-ledger.mjs` 的 `DEFAULT_OUTBOUND_LEDGER_DIR` 同一条：
 * **这个部署就长在 H 盘**，写死比"猜一个相对路径"可靠 —— 猜错的表现是
 * "服务起不来但所有计数都正常"。
 */
export const DEFAULT_TEXT_LINT_PYTHON =
  '<DSH_HOME>\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

/**
 * 服务脚本路径：**没有默认值**（2026-11-19）。
 *
 * 这一版把原来那条"工作区里跟着实验目录走"的默认路径删掉了 —— 那是个**只有某个部署
 * 才成立**的假路径，留着只会让人以为开箱能用，实际表现是"spawn 一开就报脚本不存在"。
 *
 * ⇒ 要 `spawn: true` 就必须**显式**给 `config.script`（或 `QQ_TEXT_LINT_SCRIPT`）；
 *   不给就不起服务，并在日志里说清为什么（见 `start()`）。
 */

/**
 * 兜底默认值。
 *
 * ⚠️ 同 `DEFAULT_OUTBOUND_LEDGER` 那条教训：**这里放 `enabled:true` 是有意的**
 * （"装了就该跑"），而 `url: ''` 会让它静默关掉 —— 所以 **`url` 不许出现在这里**，
 * 它由 {@link DEFAULT_TEXT_LINT_URL} 推。空串是"明确关掉"，缺字段才走默认。
 */
export const DEFAULT_TEXT_LINT = Object.freeze({
  enabled: true,
  /** 单次调用超时（毫秒）。**短**是刻意的：它只是观测，慢一点点就没有价值了。 */
  timeoutMs: 400,
  /**
   * 由插件 spawn 服务。**默认 `false`**（2026-11-18 实测后改的，两个理由都很硬）：
   *
   * 1. **测试会 `apply()` 整个插件** —— 17 个测试文件 import 了 `src/index.mjs`，
   *    其中好几个直接调 `pluginModule.apply(ctx)`。spawn 默认开着就等于
   *    **跑一次 `npm test` 会顺手拉起一堆 Python 进程**（实测一次跑出 4 个）。
   * 2. **Windows 上"端口固定 ⇒ 第二个绑定会失败"是错的。** Python 的
   *    `HTTPServer.allow_reuse_address` 默认是 1，而 Windows 的 `SO_REUSEADDR`
   *    语义和 Linux 不同 —— **多个 socket 可以同时绑同一个地址并同时 LISTENING**
   *    （实测 6 个进程一起监听 8791）。所以"撞端口自动退出"这道保险在 Windows 上
   *    根本不成立，只能靠在服务端显式关掉 `allow_reuse_address`（已改）。
   *
   * ⇒ 默认当**纯客户端**：服务由谁起都行，插件只连它。要插件自己管生命周期
   * （apply 时拉起、dispose 时杀掉），显式开 `spawn: true`
   * （生产走环境变量 `QQ_TEXT_LINT_SPAWN=1`）。
   */
  spawn: false,
  /** 台账里最多记几条可疑位置。 */
  maxSamples: 5,
});

/** 台账 `text` 字段最多存多少字（总长度另有 `chars`）。 */
export const TEXT_HEAD_MAX = 200;

/** 取文本前 `TEXT_HEAD_MAX` 个字（按码点切，别把 emoji 切成半个）。 */
export function textHead(text, max = TEXT_HEAD_MAX) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  // `Array.from` 按码点切；只取前 max 个码点再拼回来。
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join('');
}

/**
 * 把服务回的 `suspects` 收拾成台账能存的样子。
 *
 * **只留最多 `maxSamples` 条**（任务书：别把整段可疑文本都记进去），
 * 每条只留 `pos` / `len` / 短 `text` / 短 `reason`。
 */
export function normalizeSuspects(raw, maxSamples = DEFAULT_TEXT_LINT.maxSamples) {
  if (!Array.isArray(raw)) return [];
  const limit = Math.max(0, Math.min(20, Math.floor(Number(maxSamples) || 0)));
  const out = [];
  for (const item of raw) {
    if (out.length >= limit) break;
    if (item === null || typeof item !== 'object') continue;
    const pos = Number(item.pos);
    const len = Number(item.len);
    const text = typeof item.text === 'string' ? Array.from(item.text).slice(0, 24).join('') : '';
    const reason = typeof item.reason === 'string' ? Array.from(item.reason).slice(0, 24).join('') : '';
    if (!text) continue;
    out.push({
      pos: Number.isFinite(pos) ? Math.max(0, Math.floor(pos)) : 0,
      len: Number.isFinite(len) ? Math.max(0, Math.floor(len)) : text.length,
      text,
      reason,
    });
  }
  return out;
}

/**
 * 造一个出站文本判据客户端。
 *
 * @param {object} [options]
 * @param {object} [options.config] 原始配置（`{enabled, url, timeoutMs, spawn, maxSamples, python, script, port}`）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl] 注入 fetch（测试用）
 * @param {() => object} [options.spawnImpl] 注入 spawn（测试用）
 * @returns {{
 *   inspect: (text: string) => Promise<{svc: string, count: number, samples: object[], ms: number}>,
 *   start: () => void, dispose: () => void, stats: () => object, url: () => string,
 * }}
 */
export function createTextLinter({
  config = null,
  log = () => {},
  fetchImpl = null,
  spawnImpl = null,
} = {}) {
  const src = config !== null && typeof config === 'object' ? config : {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, Math.floor(n)));
  };

  const url = src.url === undefined ? DEFAULT_TEXT_LINT_URL : str(src.url).replace(/\/+$/, '');
  const cfg = {
    // ⚠️ 空 url = 明确关掉（同 `outbound-ledger` 的 `file: ''`）
    enabled: (src.enabled === undefined ? DEFAULT_TEXT_LINT.enabled : src.enabled === true) && url !== '',
    url,
    timeoutMs: num(src.timeoutMs, DEFAULT_TEXT_LINT.timeoutMs, 20, 10_000),
    spawn: src.spawn === undefined ? DEFAULT_TEXT_LINT.spawn : src.spawn === true,
    maxSamples: num(src.maxSamples, DEFAULT_TEXT_LINT.maxSamples, 0, 20),
    python: str(src.python) || DEFAULT_TEXT_LINT_PYTHON,
    script: str(src.script),
    port: num(src.port, 8791, 1, 65_535),
  };

  const stats = {
    enabled: cfg.enabled,
    url: cfg.url,
    timeoutMs: cfg.timeoutMs,
    /** 发出去的次数 / 各自的结果。判断"它到底有没有在干活"就看这几个数。 */
    calls: 0,
    ok: 0,
    timeout: 0,
    down: 0,
    error: 0,
    /** 服务回复里最近的 `ms`（服务端自己量的判据耗时）。 */
    lastMs: null,
    lastCount: null,
    /** spawn 状态：没起 / 起来了 / 起失败。 */
    spawned: false,
    spawnFailed: false,
    childPid: null,
    /** 子进程 stderr 尾部若干行（起不来时唯一的线索）。 */
    stderrTail: [],
  };

  /** 真去 spawn 出来的子进程（`dispose()` 里杀它）。 */
  let child = null;
  let started = false;

  /**
   * 起服务。**永不抛。**
   *
   * 幂等：重复调用只有第一次真做事（HMR 后是新实例，所以每次重载都会重新起一个，
   * 旧的那个由 dispose 杀掉 —— 这正是"随插件生命周期走"）。
   */
  function start() {
    if (started) return;
    started = true;
    if (!cfg.enabled || !cfg.spawn) return;
    try {
      // 没有默认脚本路径（2026-11-19）：要 spawn 就必须显式给。
      // **不猜、不兜底** —— 猜错的形态是"服务起不来但所有计数都正常"，比不起更坏。
      if (cfg.script === '') {
        stats.spawnFailed = true;
        log('warn', '文本判据开了 spawn 但没给 script 路径 ⇒ 本次不起服务（发送不受影响）', {
          hint: '要插件自己管服务生命周期，必须显式给 config.script 或环境变量 QQ_TEXT_LINT_SCRIPT；'
            + '只当纯客户端用就保持 spawn:false，由外部起服务。',
        });
        return;
      }
      if (!fs.existsSync(cfg.script)) {
        stats.spawnFailed = true;
        log('warn', '文本判据服务脚本不存在，判据关掉（发送不受影响）', { script: cfg.script });
        return;
      }
      const doSpawn = spawnImpl ?? spawn;
      const proc = doSpawn(
        cfg.python,
        [cfg.script, '--port', String(cfg.port), '--parent-stdin'],
        {
          // stdin 是**管道**：父进程握着它，父进程一死就 EOF ⇒ 服务自己退出（防孤儿）。
          // stdout 丢掉（服务不往那里写），stderr 留着抓启动失败的原因。
          stdio: ['pipe', 'ignore', 'pipe'],
          windowsHide: true,
          // ⚠️ **不 detached**：让它留在这个进程树里，进程被整体杀掉时它也跟着走。
          detached: false,
        },
      );
      child = proc;
      stats.spawned = true;
      stats.childPid = proc?.pid ?? null;
      if (typeof proc?.stderr?.on === 'function') {
        let buf = '';
        proc.stderr.on('data', (chunk) => {
          buf += String(chunk);
          // 只留最后 20 行，别把关在内存里的日志撑大
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim() === '') continue;
            stats.stderrTail.push(line.slice(0, 300));
            if (stats.stderrTail.length > 20) stats.stderrTail.shift();
          }
        });
        proc.stderr.on('error', () => { /* 抓不到 stderr 不影响任何事 */ });
      }
      // ⚠️ 'error' 事件**必须有人听**：没人听的话 ENOENT 会变成未捕获异常 ⇒ 宿主退出。
      if (typeof proc?.on === 'function') {
        proc.on('error', (error) => {
          stats.spawnFailed = true;
          stats.spawned = false;
          log('warn', '文本判据服务起不来（发送不受影响）', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        proc.on('exit', () => {
          stats.spawned = false;
          child = null;
        });
      }
      log('info', '文本判据服务已拉起', { pid: stats.childPid, port: cfg.port });
    } catch (error) {
      stats.spawnFailed = true;
      log('warn', '文本判据服务 spawn 失败（发送不受影响）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 杀掉子进程。**永不抛。** */
  function dispose() {
    const proc = child;
    child = null;
    stats.spawned = false;
    if (proc === null || typeof proc !== 'object') return;
    try {
      // 先关 stdin：服务那边的 watchdog 读到 EOF 会自己退（比 kill 更 cooperate）。
      if (proc.stdin && typeof proc.stdin.end === 'function') proc.stdin.end();
    } catch { /* 无关紧要 */ }
    try {
      if (typeof proc.kill === 'function') proc.kill();
    } catch { /* 已经死了 */ }
  }

  /**
   * 问一次判据。**永远 resolve，永不抛，永不 reject。**
   *
   * @param {string} text
   * @returns {Promise<{svc: 'ok'|'timeout'|'down'|'error'|'disabled', count: number, samples: object[], ms: number}>}
   */
  async function inspect(text) {
    const empty = { svc: 'disabled', count: 0, samples: [], ms: 0 };
    if (!cfg.enabled) return empty;
    const body = String(text ?? '');
    if (body === '') return { svc: 'ok', count: 0, samples: [], ms: 0 };
    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') return { ...empty, svc: 'error' };

    stats.calls += 1;
    const t0 = Date.now();
    try {
      const res = await doFetch(`${cfg.url}/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text: body }),
        // ⚠️ 超时用 signal：**不设的话一个挂住的服务能把这条 Promise 吊死**，
        //    虽然发送不等它，但那条台账行就永远不写了、内存里还留着闭包。
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (!res || res.ok !== true) {
        stats.error += 1;
        return { svc: 'error', count: 0, samples: [], ms: Date.now() - t0 };
      }
      const json = await res.json();
      const samples = normalizeSuspects(json?.suspects, cfg.maxSamples);
      const count = Number.isFinite(Number(json?.count)) ? Math.max(0, Math.floor(Number(json.count))) : samples.length;
      stats.ok += 1;
      stats.lastMs = Number.isFinite(Number(json?.ms)) ? Number(json.ms) : null;
      stats.lastCount = count;
      return { svc: 'ok', count, samples, ms: Date.now() - t0 };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      // `TimeoutError` / `AbortError` = 超时；`TypeError`(fetch failed) / ECONNREFUSED = 服务没起
      if (name === 'TimeoutError' || name === 'AbortError') {
        stats.timeout += 1;
        return { svc: 'timeout', count: 0, samples: [], ms: Date.now() - t0 };
      }
      const msg = error instanceof Error ? error.message : String(error);
      const isDown = /ECONNREFUSED|ECONNRESET|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(msg);
      if (isDown) {
        stats.down += 1;
        return { svc: 'down', count: 0, samples: [], ms: Date.now() - t0 };
      }
      stats.error += 1;
      log('debug', '文本判据调用失败（发送不受影响）', { error: msg });
      return { svc: 'error', count: 0, samples: [], ms: Date.now() - t0 };
    }
  }

  return {
    inspect,
    start,
    dispose,
    stats: () => ({ ...stats, stderrTail: [...stats.stderrTail] }),
    url: () => cfg.url,
  };
}
