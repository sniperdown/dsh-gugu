/**
 * 把 B 站卡片里的 **`b23.tv` 短链**展开成人能用的视频地址。
 *
 * ## 为什么需要它（用户 2026-11-03 的原话）
 *
 * > 「卡片生成的文本把 bv 号也提供了，或者直接生成网址」
 *
 * 现场：用户转发一张 B 站卡片，插件把它压成一行交给模型，链接是
 * `https://b23.tv/RcVLXMu`。模型拿到短链**没法直接用** —— 它得自己跟一次 302
 * 才知道是哪个视频，于是它去抓移动版页面，只拿到标题。正确形态是
 * `https://www.bilibili.com/video/BV1jPgH6jE7z`（**必须带 `/video/`**）。
 *
 * ## 实测事实（2026-11-03，本机 node fetch 直连 bilibili 是通的，不用代理）
 *
 * ```
 * fetch('https://b23.tv/RcVLXMu', {redirect:'manual'})
 * → 302, location: https://www.bilibili.com/video/BV1jPgH6jE7z?buvid=…&unique_k=RcVLXMu&up_id=…
 * ```
 *
 * 也就是说：**一次 follow 都不要、只要 302 的 `location` 头**，从里面正则取
 * `BV[0-9A-Za-z]{10}` 就够。别真去跟 302 —— 那会多下整个页面。
 *
 * ## 为什么异步发生在**入站这一层**（路 A 的变体）
 *
 * `rich.mjs` 的渲染链（`parseCardFields` / `formatCardSegment` / `renderRichText`）
 * 是**纯同步**的，而展开短链是异步的。两种改法里选了"把异步关在一个地方"那条：
 * 在传输层**发事件之前**展开一次，把结果写回段对象（`segment.__resolvedUrl`），
 * 渲染层只管同步读。这样 `renderRichText` 的同步契约一个字都没动，
 * 调用链（`renderPrompt` / 转录渲染 / 转发递归）全部不受影响。
 *
 * ⚠️ 位置不是 `protocol.mjs` 的 `normalizeEvent`：那个函数**整条都是同步的**
 * （原以为那里有 async 环节，实测没有），改它会把同步契约扩散到网关。
 * 而 `transport.mjs` 的 `handleFrame` 本来就是"收帧 → 发事件"的收口，天然在 async 里。
 *
 * ## 三条硬规矩（每一条都写在代码里，不是口号）
 *
 * 1. **必须超时**（{@link DEFAULT_SHORT_LINK_TIMEOUT_MS}）：`AbortController` +
 *    `setTimeout`（`.unref()`，不留活定时器），**绝不能因为它慢就把消息拖住**。
 * 2. **失败静默退回**：超时 / 抛错 / 格式不对 ⇒ 原样保留短链，只写一条 **debug**
 *    日志（这是常态，不是故障）；**不抛、不吞卡片、不让消息处理失败**。
 * 3. **只展开 `b23.tv`**：别的 URL 一个字节都不碰，也不发任何网络请求。
 *
 * @module qq-gugu/short-link
 */

import { parseCardFields } from './rich.mjs';

/** 展开一次短链最多等多久（毫秒）。 */
export const DEFAULT_SHORT_LINK_TIMEOUT_MS = 1000;

/** 认得出、也只认这几个主机名的短链。其余一律不动。 */
export const SHORT_LINK_HOSTS = new Set(['b23.tv', 'www.b23.tv']);

/** B 站视频号的形状：`BV` + 10 位 `[0-9A-Za-z]`（实测 `BV1jPgH6jE7z`）。 */
const BV_PATTERN = /BV[0-9A-Za-z]{10}/;

/** 展开结果写回段对象的键名（渲染层只读它，见 `rich.mjs` 的 `parseCardFields`）。 */
export const RESOLVED_URL_KEY = '__resolvedUrl';

/** 缓存最多留多少条（超过就丢最早的一条，防止长跑进程无限涨）。 */
export const DEFAULT_MAX_CACHE_ENTRIES = 200;

/**
 * 这个值是不是一条 **`b23.tv` 短链**？是则返回归一化后的短链，否则 `null`。
 *
 * 严格到"多一点都不算"：主机名必须**精确等于** {@link SHORT_LINK_HOSTS} 里的一项，
 * 协议必须是 http/https。`https://b23.tv.evil.com/x`、`https://evil.com/b23.tv/x`
 * 一个都不认（否则就成了"对任意 URL 发请求"）。
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function shortLinkOf(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null; // 不是绝对 URL（含 `b23.tv/xxx` 这种缺协议头的）⇒ 不碰
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!SHORT_LINK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return parsed.toString();
}

/**
 * 从 302 的 `location`（或响应自己的 `url`）里取 B 站视频地址。
 * 取不到 → `null`（调用方保留短链）。
 *
 * @param {unknown} location
 * @returns {string|null}
 */
export function videoUrlFromLocation(location) {
  const text = typeof location === 'string' ? location : '';
  if (text === '') return null;
  const bv = BV_PATTERN.exec(text)?.[0];
  if (bv === undefined) return null;
  // ⚠️ **必须带 `/video/`**：`https://www.bilibili.com/BV…` 打不开（用户点名过）。
  return `https://www.bilibili.com/video/${bv}`;
}

/**
 * 从一个 fetch 响应里掏视频地址（`redirect: 'manual'` 拿到的是 3xx 本身）。
 * @param {any} response
 * @returns {string|null}
 */
function videoUrlFromResponse(response) {
  if (response === null || typeof response !== 'object') return null;
  const candidates = [];
  const location = typeof response.headers?.get === 'function'
    ? response.headers.get('location')
    : undefined;
  if (typeof location === 'string' && location !== '') candidates.push(location);
  if (typeof response.url === 'string' && response.url !== '') candidates.push(response.url);
  for (const candidate of candidates) {
    const url = videoUrlFromLocation(candidate);
    if (url !== null) return url;
  }
  return null;
}

/**
 * 把展开结果写回段对象。
 *
 * 写**两处**（段顶层 + `seg.data` 里）：`protocol.mjs` 的 `toSegments` 会把
 * `data` 摊平到顶层并浅拷贝整段，所以两处都留一份，无论走哪条归一化路径都读得到。
 * 名字带 `__` 前缀是刻意的：它不是 OneBot 协议字段，只是一个进程内的临时标注。
 *
 * @param {any} segment
 * @param {string} url
 * @returns {boolean} 真的写进去了才返回 true
 */
export function writeResolvedUrl(segment, url) {
  if (segment === null || typeof segment !== 'object') return false;
  if (typeof url !== 'string' || url === '') return false;
  segment[RESOLVED_URL_KEY] = url;
  const data = segment.data;
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    data[RESOLVED_URL_KEY] = url;
  }
  return true;
}

/**
 * 段对象里**已经展开好**的 URL（没有就 `''`）。
 * @param {any} segment
 * @returns {string}
 */
export function resolvedUrlOf(segment) {
  const own = typeof segment?.[RESOLVED_URL_KEY] === 'string' ? segment[RESOLVED_URL_KEY].trim() : '';
  if (own !== '') return own;
  const nested = typeof segment?.data?.[RESOLVED_URL_KEY] === 'string'
    ? segment.data[RESOLVED_URL_KEY].trim()
    : '';
  return nested;
}

/**
 * 一个段（卡片）里的 URL 如果是 `b23.tv` 短链，返回它；否则 `null`。
 *
 * 这里**复用** `rich.mjs` 的 `parseCardFields` 而不是另写一套掏字段的逻辑：
 * 卡片载荷有 json/xml 两种形状、字段还分 `qqdocurl` / `jumpUrl` / `url`，
 * 抄一份必然会跟原版走岔。
 *
 * @param {any} segment
 * @returns {string|null}
 */
function shortLinkOfCard(segment) {
  if (resolvedUrlOf(segment) !== '') return null; // 已经展开过，别再问一次
  let fields;
  try {
    fields = parseCardFields(segment);
  } catch {
    return null; // 载荷畸形 ⇒ 当作没有短链（渲染层照旧退回占位符）
  }
  if (fields === null) return null;
  return shortLinkOf(fields.url);
}

/**
 * 同步地找出一个入站事件里**需要展开**的卡片段（纯解析，不发请求）。
 *
 * 会钻进合并转发里（群友转发一张 B 站卡片这类很常见），深度有上限。
 *
 * @param {any} event
 * @param {{maxDepth?: number}} [options]
 * @returns {Array<{segment: any, url: string}>}
 */
export function collectShortLinkTargets(event, { maxDepth = 2 } = {}) {
  const found = [];
  const depthLimit = Number.isFinite(maxDepth) && maxDepth >= 0 ? Math.floor(maxDepth) : 2;

  /** @param {any} message @param {number} depth */
  const walk = (message, depth) => {
    if (depth < 0) return;
    for (const item of Array.isArray(message) ? message : []) {
      if (item === null || typeof item !== 'object') continue;
      const type = String(item.type ?? '');
      if (type === 'json' || type === 'xml') {
        const url = shortLinkOfCard(item);
        if (url !== null) found.push({ segment: item, url });
        continue;
      }
      if (type !== 'forward') continue;
      const content = item.data?.content ?? item.content;
      for (const inner of Array.isArray(content) ? content : []) {
        walk(inner?.message, depth - 1);
      }
    }
  };

  walk(event?.message, depthLimit);
  return found;
}

/**
 * 造一个短链展开器。
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] 注入点（测试用假实现，**不联网**）
 * @param {number} [options.timeoutMs] 单次展开的上限（默认 1000）
 * @param {Map<string, string|null>} [options.cache] 短链 → 视频地址（失败存 `null`）
 * @param {number} [options.maxCacheEntries] 缓存上限
 * @param {(level: string, message: string, meta?: any) => void} [options.log]
 *   日志回调（传输层接到自己的 `log` 事件上）。**只用 `debug`**：展开失败是常态。
 */
export function createShortLinkExpander({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_SHORT_LINK_TIMEOUT_MS,
  cache = new Map(),
  maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
  log = () => {},
} = {}) {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_SHORT_LINK_TIMEOUT_MS;
  const store = cache instanceof Map ? cache : new Map();
  const cap = Number.isFinite(maxCacheEntries) && maxCacheEntries > 0
    ? Math.floor(maxCacheEntries)
    : DEFAULT_MAX_CACHE_ENTRIES;
  const stats = { requests: 0, expanded: 0, failed: 0, cacheHits: 0 };

  /** @param {string} message @param {any} meta */
  const debug = (message, meta) => {
    try {
      log('debug', message, meta);
    } catch {
      /* 日志坏了不许影响展开 */
    }
  };

  /**
   * 展开一条短链。**永不 reject**，取不到就是 `null`。
   * @param {string} shortUrl
   * @returns {Promise<string|null>}
   */
  async function resolve(shortUrl) {
    if (typeof fetchImpl !== 'function') return null;
    if (store.has(shortUrl)) {
      stats.cacheHits += 1;
      return store.get(shortUrl) ?? null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    // `.unref()`：别让这个定时器把进程留住（测试里尤其明显）。
    if (typeof timer.unref === 'function') timer.unref();
    stats.requests += 1;
    let resolved = null;
    try {
      const response = await fetchImpl(shortUrl, {
        method: 'GET',
        // **不跟随**：302 的 location 头就够，跟一下反而要下整页。
        redirect: 'manual',
        signal: controller.signal,
      });
      resolved = videoUrlFromResponse(response);
    } catch (error) {
      // 超时 / 网络不通 / DNS / 被墙 —— 全都是"这一条这次的运气"，不是故障。
      debug('B 站短链展开失败，保留原短链', {
        url: shortUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }

    if (resolved === null) debug('B 站短链没掏出视频号，保留原短链', { url: shortUrl });

    // 成功和失败**都进缓存**：同一条短链在一批消息里常常出现两次以上
    // （转录 + 当前消息），失败的那条也不该被反复重打。
    if (store.size >= cap) {
      const oldest = store.keys().next();
      if (!oldest.done) store.delete(oldest.value);
    }
    store.set(shortUrl, resolved);
    if (resolved === null) stats.failed += 1;
    else stats.expanded += 1;
    return resolved;
  }

  /**
   * 事件里**有没有**要展开的短链 —— 同步回答。
   * 没有 ⇒ 返回 `null`，调用方**照旧同步发事件**（零延迟、零改动）。
   * 有 ⇒ 返回一个**永不 reject** 的 Promise，等它完再发事件。
   *
   * @param {any} event
   * @returns {Promise<void>|null}
   */
  function prepareEvent(event) {
    let targets;
    try {
      targets = collectShortLinkTargets(event);
    } catch (error) {
      debug('短链展开的准备工作失败（忽略）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (targets.length === 0) return null;

    const jobs = targets.map(async (target) => {
      const resolved = await resolve(target.url);
      if (resolved === null) return; // 退回短链，什么都不写
      writeResolvedUrl(target.segment, resolved);
    });
    // 双保险：`resolve` 自己不会 reject，这里再兜一次 —— 这个 Promise 挂在
    // 入站热路径上，漏一个未捕获异常就是宿主退出那一类事故。
    return Promise.all(jobs).then(() => undefined).catch(() => undefined);
  }

  return { resolve, prepareEvent, cache: store, stats, timeoutMs: limit };
}
