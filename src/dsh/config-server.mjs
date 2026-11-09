/**
 * 宿主侧**临时**配置服务：插件加载时自动起一次（不弹浏览器），心跳一停就关。
 *
 * ## 为什么是"临时"
 *
 * 配置页要搬成独立网页（能改 toml、白名单、推理等级）。这种页面**平时不该存在**：
 * 常驻监听端口等于常驻攻击面，而它一年里可能只用几次。所以生命周期反过来——
 * 由**插件加载**（或用户的那次点击）发起，由页面自己的心跳维持，**心跳一停就关**。
 *
 * ⚠️ 加载时自动起一次是 **2026-10-29** 加的，专为"插件重载后配置页能接回来"：
 * 重载会 dispose 整个插件，如果新实例不自己起服务，页面那层自动重连就没有可连的对象。
 * 自动起的这一次**绝不 spawn 浏览器**（`openBrowser: false`）—— 每次重载都弹一个
 * 标签页是不能接受的；用户没有页面开着时，它 120 秒后自己关掉。
 *
 * ## 形态
 *
 * - `http.createServer(...).listen(<preferredPort>, '127.0.0.1')`：优先绑**上次的
 *   （或配置里固定的）端口**，只监听回环，局域网内不可达。端口被占时回退到
 *   `listen(0)`（系统分配随机端口），并记一条 warn。
 * - 令牌 `crypto.randomBytes(16).toString('hex')`（32 个十六进制字符），
 *   入口地址是 `http://127.0.0.1:<port>/?t=<token>`。
 * - 服务已经活着时 `open()` **复用**它（同一个端口、同一个令牌），不重复监听，
 *   也**不重复打开浏览器**：窗口只在服务从无到有的那一次出现。
 * - `close()` 幂等；服务、令牌、定时器、空闲连接一起清掉。
 *
 * ## 跨插件重载的"原地接回"（2026-10-29）
 *
 * 配置页的前端有一层自动重连：连接断了就每 1.5 秒轮询**同一个 origin**，最多 30 秒。
 * 但热重载会 dispose 整个插件（新实例 = 新对象），所以「随机端口 + 每次新令牌」
 * 让那层重连永远落空：页面指着旧端口 + 旧令牌，30 秒后放弃。
 *
 * ⇒ 把 `{port, token}` 落到 `<DSH_HOME>\media\qq-config-page.json`
 * （与 `qq-proactive-*.json` 同目录、同一套「临时文件 + rename」原子写法）：
 *
 * 1. 启动时先读它，拿到上次的 `port` / `token`；
 * 2. 绑回**同一个端口**、复用**同一个令牌** ⇒ 旧页面原地接回（不需要重新打开）；
 * 3. 端口被占（EADDRINUSE，含"旧实例的 socket 还没放干净"）⇒ 先重试几次，
 *    仍失败才回退 `listen(0)`，记 warn 说明"这次是 X，页面需要重新打开"，
 *    令牌可以重生，**新的 `{port, token}` 写回文件**（下一次重载就稳定在新端口）；
 * 4. 没有文件 / 文件坏了 ⇒ 随机端口 + 新令牌，写完文件。
 *
 * ⚠️ **只固定端口不够**：令牌每次重生的话，同一个端口也是 401/404，页面照样接不回来。
 * 两者必须一起跨重载稳定，所以这里持久化的是 `{port, token}` 这一对。
 *
 * ⚠️ **风险要说清楚**：令牌落盘 = 本机任意进程（同一用户权限下）都能读到它。
 * 这个服务只绑 `127.0.0.1`、只服务配置页，但拿到令牌的本地进程可以在服务活着时
 * 读写配置（改 toml、重载插件）。落盘时按 `0600` 创建并在 POSIX 上 `chmod` 收紧；
 * Windows 上 Node 的 `mode` 不产生 ACL 效果（文件继承目录 ACL）—— 这一点没法靠本模块解决。
 * 令牌**绝不进日志**：所有日志只记 `port` / `tokenReused`，不记 `url`。
 *
 * ## 生命周期的判据（只有一条）
 *
 * `now() - max(openedAt, lastBeatAt) > idleTimeoutMs`（默认 120 秒）⇒ 自己关。
 *
 * `lastBeatAt` 来自页面每 5 秒一次的 `POST /heartbeat`；`openedAt` 只是**初值**，
 * 用来兜住「服务起来了但浏览器从未打开页面」这种情形——否则没有心跳记录时
 * 那个差值永远算不出来，服务就会一直挂着。
 *
 * 刻意**没有**任何"兜底时长"：用户明确要求过不要（"我有时候可能挂着就睡着了"）。
 * 服务的生死由心跳决定，页面关掉 120 秒后它就消失。
 *
 * ## 路由（挂在**这个临时服务**上，不是主 webServer）
 *
 * | 路由 | 用途 |
 * |---|---|
 * | `GET  /?t=<token>` | 配置页 HTML（`web/index.html`，令牌占位符在此替换） |
 * | `GET  /index.html` | 与 `/` 同一份页面（同样替换令牌），便于直接按文件名访问 |
 * | `GET  /app.js` | 页面入口（ES module，无构建步骤） |
 * | `GET  /logic.mjs` | 纯逻辑模块（字段选择、折叠、草稿比较、写入文案） |
 * | `GET  /style.css` | 页面样式表 |
 * | `GET  /vendor/react.development.js` | 本地 React UMD 构建 |
 * | `GET  /vendor/react-dom.development.js` | 本地 ReactDOM UMD 构建 |
 * | `GET  /status` | 页面轮询：`status()` |
 * | `POST /heartbeat` | 页面每 5 秒报到一次 |
 * | `GET|POST /dsh-qq-proactive/*` | **转发**给主 webServer（同机回环代理） |
 *
 * 「转发」这条路径**不新增任何业务语义**：主 webServer 上已经挂着
 * `/dsh-qq-proactive/{settings,config,free-time,reload,config-server/*}`，
 * 页面从**临时服务的端口**（默认固定 `configPagePort`，回退时才随机）发请求时，
 * 由这里按原样代理过去，读写的仍是同一份 toml。
 * 页面与主 webServer 的差别只有来源（临时服务的端口）与鉴权（持久化令牌），业务逻辑共用。
 * 上游地址由 `src/index.mjs` 提供（`upstream` 选项，字符串或惰性函数均可）；
 * 取不到就一律 `502` + JSON，**不猜端口**。
 *
 * ## 转发的四条约束
 *
 * 1. 只按前缀 `/dsh-qq-proactive/` 匹配：具体有哪些子路径、各自接受什么方法，
 *    都由主 webServer 决定，这里不复制那份名单（复制出来就有两处需要同步）。
 * 2. 请求体与 `content-type` 原样过去；响应的状态码、`content-type`、响应体原样回来。
 * 3. 超时（默认 10 秒）与任何错误都折成 `502` + JSON。转发路径上**不抛异常**：
 *    抛出去就是宿主进程里的未捕获异常。
 * 4. 令牌与 `Origin` 两道门在转发之前，与其他路由完全一致。
 *
 * 校验顺序：**先令牌、再 Origin**。
 * - 令牌错 ⇒ 一律 `404`。不用 401/403 是刻意的：那等于告诉扫描器"这里有个东西"。
 *   页面与静态资源走**同一道门**：`<script src>` / `<link>` 无法自定义请求头，
 *   因此页面里的资源地址都带 `?t=`；缺令牌或令牌不对一样是 `404`。
 * - `POST` 再校验 `Origin` 必须等于 `http://127.0.0.1:<本端口>`（缺头也算不通过），
 *   防止别的网页跨站打这个口子。
 * - 所有响应带 `Cache-Control: no-store`（静态资源另加 `no-cache, must-revalidate`）：
 *   改完 `web/` 下的文件按 F5 就能看到新内容，不必重启宿主。
 * - 每条路径都 `try/catch`：这里的异常一旦冒出去就是宿主进程里的未捕获异常。
 *
 * ## 与主 webServer 的分工
 *
 * 启停开关本身（`/dsh-qq-proactive/config-server/{open,close,status}`）挂在
 * **主 webServer** 上，见 {@link createConfigServerRoutes}；临时服务承载配置页
 * 自己的页面、静态资源与三条端点，另转发 `/dsh-qq-proactive/*` 下的既有配置路由。
 * 两者刻意分开：关掉临时服务不能把"再打开它"的入口一起关掉。
 *
 * @module qq-dsh/config-server
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 启停开关在主 webServer 上的路径前缀。 */
export const CONFIG_SERVER_ROUTE_BASE = '/dsh-qq-proactive/config-server';

/**
 * 需要转发给主 webServer 的路径前缀。
 *
 * 主 webServer 上的配置路由都挂在这个前缀下（`src/index.mjs` 的
 * `FREE_TIME_ROUTE_BASE` 与 `CONFIG_SERVER_ROUTE_BASE`）。转发只认这个前缀，
 * 不再逐条登记子路径。
 */
export const FORWARD_PREFIX = '/dsh-qq-proactive/';

/**
 * 转发上游的超时（毫秒）。
 *
 * 主服务器与本服务同机、只走回环，正常响应在毫秒级；超过这个时长只可能是
 * 上游卡住了。超时不是"再等等"，而是当场按失败处理，否则页面上会一直转圈。
 */
export const UPSTREAM_TIMEOUT_MS = 10000;

/**
 * 转发时允许的最大请求体（1 MiB）。
 *
 * 配置页写入的 JSON 只有几百字节；给上限是为了不让一个异常大的请求体把
 * 宿主的缓冲吃光。
 */
export const MAX_FORWARD_BODY_BYTES = 1 << 20;

/**
 * 启停路由允许的 JSON 请求体上限（16 KiB）。
 *
 * 这些路由只接受一个可选的布尔字段，正常请求体不到 40 字节。给一个宽松上限，
 * 是为了让任何合法请求都进得来；超过它的请求按"读不懂"处理，不再往内存里堆。
 */
export const MAX_ROUTE_BODY_BYTES = 16 * 1024;

/** 令牌的查询参数名（`http://127.0.0.1:<port>/?t=<token>`）。 */
export const TOKEN_QUERY_KEY = 't';

/** 令牌的请求头名（小写，Node 的 `req.headers` 键一律小写）。 */
export const TOKEN_HEADER = 'x-config-token';

/** 监听地址：只回环。 */
export const LISTEN_HOST = '127.0.0.1';

/** 页面报到的间隔（页面侧的值；宿主不依赖它，只用 120 秒判死）。 */
export const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * 多久没心跳就自己关。
 *
 * 120 秒 = 页面心跳间隔（5 秒）的 24 倍，是给**后台标签页**留的余量：
 * 浏览器会把后台页的定时器降频（Chrome 的 intensive throttling 会拖到 1 分钟一次），
 * 原来 15 秒的窗口在切走标签页之后必然超时自杀，表现就是「配置页开一会儿就断」。
 * 服务没有被浏览器冻结，只是页面喊不出声。
 */
export const IDLE_TIMEOUT_MS = 120000;

/** 心跳检查的节拍。 */
export const TICK_INTERVAL_MS = 1000;

/** 令牌字节数（16 字节 = 32 个十六进制字符）。 */
export const TOKEN_BYTES = 16;

/**
 * 跨插件重载持久化的状态文件名（`<DSH_HOME>/media/` 下）。
 *
 * 内容只有 `{port, token}`：端口让页面指向的 origin 仍然有效，令牌让旧地址仍然能过
 * 鉴权。少了任何一个，重载后页面都接不回来（见模块头部的说明）。
 */
export const CONFIG_PAGE_STATE_FILE_NAME = 'qq-config-page.json';

/**
 * 固定端口被占时，绑回上次端口的重试次数与间隔。
 *
 * 为什么需要重试：插件热重载是 **dispose 旧实例 → 立刻 apply 新实例**，旧实例的
 * `close()` 是异步的 —— 新实例来 `listen()` 时旧 socket 可能还没完全释放，
 * 于是拿到一个**假的** EADDRINUSE。页面每 1.5 秒轮询、最多等 30 秒，
 * 所以这里花不到 1 秒重试是划算的：避免把"刚好赶上"误判成"端口被占"。
 */
export const LISTEN_RETRY_ATTEMPTS = 8;
export const LISTEN_RETRY_DELAY_MS = 120;

/**
 * 页面模板里代表令牌的占位符。
 *
 * 页面 HTML 在**每次请求时**读出并替换：静态资源无法自定义请求头，只能把令牌拼进
 * 查询参数。令牌**不是**每次 `open()` 重新生成的：它会跨插件重载复用（持久化在
 * {@link CONFIG_PAGE_STATE_FILE_NAME}），否则页面重连时同一个端口也会鉴权失败。
 */
export const PAGE_TOKEN_PLACEHOLDER = '__TOKEN__';

/**
 * 本进程推出来的默认状态文件路径：`<DSH_HOME>/media/qq-config-page.json`。
 *
 * 与 `qq-proactive-debug.json` / `qq-proactive-announce.json` 同一个目录 ——
 * 那里已经是本插件的小 JSON 落盘处，不必再开第二处。没有 `DSH_HOME`（测试进程）
 * 时返回空串，调用方据此**关掉持久化**（纯内存，不碰盘）。
 *
 * @param {NodeJS.ProcessEnv|object} [env]
 * @returns {string}
 */
export function defaultConfigPageStatePath(env = process.env) {
  const home = String(env?.DSH_HOME ?? '').trim();
  if (home === '') return '';
  return path.join(home, 'media', CONFIG_PAGE_STATE_FILE_NAME);
}

/** 把一个"想绑的端口"归一成合法值；不合法一律当 0（= 让系统分配）。 */
function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return 0;
  return port;
}

/** 令牌格式校验：长度与字符集都要对，避免把坏文件里的垃圾当成令牌复用。 */
function isTokenLike(value) {
  return typeof value === 'string'
    && value.length === TOKEN_BYTES * 2
    && /^[0-9a-f]+$/.test(value);
}


/** 本模块所在目录，用于按相对位置找到 `web/` 与 `preview/vendor/`。 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIR = path.resolve(MODULE_DIR, '..', '..', 'web');
const DEFAULT_VENDOR_DIR = path.resolve(MODULE_DIR, '..', '..', 'preview', 'vendor');

/**
 * 允许以静态文件送出的资源（白名单，不做任意路径读取）。
 *
 * 只登记页面真正引用的五个文件，因此不存在目录穿越：地址不是这五个之一就一律 404。
 * `dir` 指向 `webDir` 或 `vendorDir`，两者都是构造时可覆盖的选项。
 */
const STATIC_ASSETS = new Map([
  ['/app.js', { dir: 'web', file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/logic.mjs', { dir: 'web', file: 'logic.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { dir: 'web', file: 'style.css', type: 'text/css; charset=utf-8' }],
  ['/vendor/react.development.js', {
    dir: 'vendor',
    file: 'react.development.js',
    type: 'text/javascript; charset=utf-8',
  }],
  ['/vendor/react-dom.development.js', {
    dir: 'vendor',
    file: 'react-dom.development.js',
    type: 'text/javascript; charset=utf-8',
  }],
]);

/**
 * 把白名单里的文件名解析成绝对路径，并确认结果仍落在给定根目录之内。
 *
 * 白名单本身已经限定了文件名（不含 `/`、不含 `..`），这里的二次校验是为了让
 * 「不会读到根目录之外」成为**代码里成立的结论**，而不是只靠登记表的正确性。
 * 任何异常（例如参数不是字符串）一律返回 `null`，由调用方当作 404。
 *
 * @param {string} rootDir 允许读取的根目录
 * @param {string} fileName 相对根目录的文件名
 * @returns {string|null} 绝对路径；越界或无法解析时为 `null`
 */
function resolveWithin(rootDir, fileName) {
  try {
    const root = path.resolve(String(rootDir));
    const resolved = path.resolve(root, String(fileName));
    const relative = path.relative(root, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return resolved;
  } catch {
    return null;
  }
}

/**
 * 读出 `web/index.html` 的模板文本；读不到时返回空串。
 *
 * **本函数不抛异常**：它会在插件 `apply` 阶段被调用一次（由 `src/index.mjs` 传入
 * `pageHtml`），任何未捕获异常都会让插件加载失败并连带宿主退出。因此读文件的所有
 * 失败形态（文件缺失、权限不足、路径是目录）都归并成空串，由调用方降级到占位页。
 *
 * @param {object} [options]
 * @param {string} [options.webDir] 页面目录（默认与本模块同仓库的 `web/`）
 * @returns {string} 模板文本；失败时为空串
 */
export function readPageHtml({ webDir = DEFAULT_WEB_DIR } = {}) {
  try {
    const target = resolveWithin(webDir, 'index.html');
    if (target === null) return '';
    const text = fs.readFileSync(target, 'utf8');
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** 异常压成一行可读文本。 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 从主 `webServer` 服务实例上取出它的来源地址（例如 `http://127.0.0.1:61482`）。
 *
 * 为什么需要这个函数：临时配置服务与主 webServer 是**两个端口**（前者默认固定
 * `configPagePort`，回退时才随机），页面里的配置请求
 * （`/dsh-qq-proactive/*`）必须转发回主服务器，而主服务器的端口只有 `webServer`
 * 自己知道。本函数把"从服务实例读地址"这件事收在一处，`src/index.mjs` 只负责
 * 把服务实例递进来。
 *
 * 读取顺序（都是运行时读取，不是猜）：
 *
 * 1. `webServer.origin` —— 服务自己的 getter，格式就是协议 + 地址 + 实际端口；
 * 2. `webServer.port` + `webServer.config.host` —— `origin` 在**绑定端口之前**
 *    会抛异常（源码里明确 `read before the listener bound a port`），而路由注册
 *    与端口绑定谁先谁后不由本插件决定，因此留一条用同样两个真实字段拼出来的退路。
 *
 * **绝不返回猜出来的值**：两个字段都拿不到时返回空串，调用方据此回 `502`。
 * 本函数不抛异常 —— 它在插件 `apply` 阶段之后的请求链里被调用，抛出去就是
 * 宿主进程里的未捕获异常。
 *
 * @param {object|null|undefined} webServer 主 webServer 服务实例
 * @returns {string} 形如 `http://127.0.0.1:61482` 的来源地址；取不到时为空串
 */
export function resolveWebServerOrigin(webServer) {
  if (webServer === null || webServer === undefined) return '';
  try {
    const origin = webServer.origin;
    if (typeof origin === 'string' && origin !== '') return origin;
  } catch {
    // 监听尚未绑定端口时 getter 会抛，继续走下面的退路。
  }
  try {
    const port = webServer.port;
    if (!Number.isInteger(port) || port <= 0) return '';
    let protocol = 'http:';
    try {
      if (webServer.protocol === 'https:') protocol = 'https:';
    } catch {
      // 读不到协议就按 http 处理：本插件的转发目标是同机回环的明文监听。
    }
    let host = LISTEN_HOST;
    try {
      const configured = webServer.config?.host;
      if (typeof configured === 'string' && configured !== '') host = configured;
    } catch {
      // 读不到绑定地址就用回环地址：转发只发生在同一台机器上。
    }
    // IPv6 字面量放进 URL 必须加方括号。
    const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `${protocol}//${urlHost}:${port}`;
  } catch {
    return '';
  }
}

/**
 * 写 JSON 响应。
 *
 * 本模块自带一份而不从 `index.mjs` 引入：`index.mjs` 会 `import` 本模块，
 * 反向引入就成了循环依赖。`res` 已断开时静默——断连不是插件该管的事。
 */
function sendJson(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  } catch {
    /* 连接已经断了 */
  }
}

/** 写 HTML 响应（同样带 `no-store`：这是每次都不一样的一次性页面）。 */
function sendHtml(res, status, html) {
  try {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(html);
  } catch {
    /* 连接已经断了 */
  }
}

/** 写静态资源响应：每次现读磁盘，`no-store` 保证按 F5 就能看到改动。 */
function sendBytes(res, status, type, body) {
  try {
    res.writeHead(status, {
      'content-type': type,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store, no-cache, must-revalidate',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    /* 连接已经断了 */
  }
}

/** 令牌不对时的统一答复：`404`，且**不带任何解释**。 */
function sendNotFound(res) {
  try {
    res.writeHead(404, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end('Not Found');
  } catch {
    /* 连接已经断了 */
  }
}

/**
 * 把不需要的请求体读空。
 *
 * 不读空的话，keep-alive 连接会被半截请求卡住，下一个请求可能永远等不到。
 * 转发路径不走这里：那些请求体要原样送给上游。
 *
 * @param {import('node:http').IncomingMessage} req
 */
function drainRequest(req) {
  try {
    req.resume?.();
  } catch {
    /* 流已经结束 */
  }
}

/**
 * 读完一个请求体，供转发使用。
 *
 * 上限由 {@link MAX_FORWARD_BODY_BYTES} 兜住；超限时把剩余数据丢弃并 reject，
 * 让调用方回 `502`，而不是继续往内存里堆。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limitBytes] 允许的最大字节数
 * @returns {Promise<Buffer>} 完整请求体
 */
function readRequestBody(req, limitBytes = MAX_FORWARD_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      try {
        req.off?.('data', onData);
        req.off?.('end', onEnd);
        req.off?.('error', onError);
        req.off?.('aborted', onAborted);
      } catch {
        /* 假的 req 可能没有 off */
      }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > limitBytes) {
        finish(new Error(`请求体超过 ${limitBytes} 字节`));
        // 剩下的数据丢掉，连接仍可正常收尾。
        try {
          req.resume?.();
        } catch {
          /* 流已经结束 */
        }
        return;
      }
      chunks.push(buffer);
    }
    function onEnd() {
      finish(null, Buffer.concat(chunks));
    }
    function onError(error) {
      finish(error);
    }
    function onAborted() {
      finish(new Error('客户端中断了请求'));
    }

    try {
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      req.on('aborted', onAborted);
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * 读一个 JSON 请求体（启停路由用）。
 *
 * 三条约定，都是为了"路由 handler 绝不抛异常"：
 *
 * - 空体视为 `{}`。启停路由的字段全是可选的，空 `POST` 必须仍然可用。
 * - 坏 JSON、超限、流错误一律返回 `null`，由调用方回落到默认值。
 * - 请求对象不是流（测试里的假 `req`）时同样返回 `{}`，不挂起、不抛错。
 *
 * 返回的对象只做"有没有这个字段"的判断，不做深拷贝或结构校验。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown> | null>} 解析结果；`{}` 表示空体
 */
async function readJsonBody(req) {
  if (req === null || req === undefined || typeof req.on !== 'function') return {};
  let raw;
  try {
    raw = await readRequestBody(req, MAX_ROUTE_BODY_BYTES);
  } catch {
    return null;
  }
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * 给一个 Promise 套上超时：先到者生效，之后的结果一律忽略。
 *
 * 单独用 `AbortSignal` 不够：注入的请求实现（测试里的假上游）根本不看信号，
 * 一个永不落地的 Promise 会把请求永远挂住。这里的超时**不依赖被调方配合**。
 *
 * @template T
 * @param {Promise<T>} promise 被等的东西
 * @param {number} timeoutMs 超时毫秒数
 * @param {string} message 超时时抛出的错误文案
 * @returns {Promise<T>}
 */
function withDeadline(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') {
      timer.unref();
    }
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 用 `node:http` / `node:https` 请求上游，返回状态码、`content-type` 与响应体。
 *
 * 刻意**不用全局 `fetch`**：宿主里可能通过 undici 的全局 dispatcher 配置了代理，
 * 那会把同机回环的请求也带出去。`node:http` 不经过任何 dispatcher，行为确定。
 *
 * 只做代理该做的事：不改状态码、不改 `content-type`、不重写响应体、不跟随重定向。
 *
 * @param {string} target 完整目标地址（含路径与查询串）
 * @param {{method: string, headers?: object, body?: Buffer|null, timeoutMs?: number}} options
 * @returns {Promise<{status: number, contentType: string, body: Buffer}>}
 */
function httpRequestUpstream(target, { method = 'GET', headers = {}, body = null, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let url = null;
    try {
      url = new URL(target);
    } catch (error) {
      reject(new Error(`上游地址无效：${errorText(error)}`));
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const requestHeaders = { ...headers };
    if (body !== null && body !== undefined) requestHeaders['content-length'] = String(body.length);
    let request = null;
    try {
      request = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === '' ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method,
          headers: requestHeaders,
          timeout: timeoutMs,
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          response.on('end', () => {
            resolve({
              status: typeof response.statusCode === 'number' ? response.statusCode : 502,
              contentType: typeof response.headers['content-type'] === 'string'
                ? response.headers['content-type']
                : '',
              body: Buffer.concat(chunks),
            });
          });
          response.on('error', (error) => reject(error));
          response.on('aborted', () => reject(new Error('上游响应被中断')));
        },
      );
    } catch (error) {
      reject(error);
      return;
    }
    request.on('error', (error) => reject(error));
    request.on('timeout', () => {
      try {
        request.destroy(new Error(`转发上游超时（${timeoutMs} 毫秒）`));
      } catch {
        /* 连接可能已经结束 */
      }
    });
    try {
      if (body !== null && body !== undefined && body.length > 0) request.write(body);
      request.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 把上游的答复原样写回页面。
 *
 * “原样”指状态码、`content-type` 与响应体；另外补上本服务统一的 `no-store`
 * 与 `nosniff`（配置数据不该被缓存）。`204` / `304` 按规范不写响应体。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{status: number, contentType: string, body: Buffer}} answered
 */
function sendUpstreamResponse(res, answered) {
  const status = Number.isInteger(answered?.status) ? answered.status : 502;
  const body = Buffer.isBuffer(answered?.body) ? answered.body : Buffer.from(answered?.body ?? '');
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (typeof answered?.contentType === 'string' && answered.contentType !== '') {
    headers['content-type'] = answered.contentType;
  }
  const bodyless = status === 204 || status === 304;
  if (!bodyless) headers['content-length'] = String(body.length);
  try {
    res.writeHead(status, headers);
    res.end(bodyless ? undefined : body);
  } catch {
    /* 连接已经断了 */
  }
}

/**
 * 把页面模板里的令牌占位符替换成本次会话的令牌。
 *
 * 令牌是十六进制字符串，本身不含需要转义的字符；仍然过一遍 `encodeURIComponent`，
 * 使这个函数对任意调用方都安全。用 `split` / `join` 而不是 `replace`，避免替换串里
 * 出现 `$` 一类标记时被展开。
 *
 * @param {string} template 页面 HTML 模板
 * @param {string} token 本次会话的令牌
 * @returns {string}
 */
export function renderPageHtml(template, token) {
  const text = typeof template === 'string' ? template : '';
  return text.split(PAGE_TOKEN_PLACEHOLDER).join(encodeURIComponent(String(token ?? '')));
}

/**
 * 页面模板缺失时的兜底说明。
 *
 * 这不是配置页本身，只在 `web/index.html` 读不到时出现（例如插件以打包方式安装、
 * 而打包清单里没有 `web/`）。文案直接说明位置，便于就地修复。
 *
 * @returns {string}
 */
function renderMissingPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>QQ 小鲸鱼 · 配置页不可用</title></head>
<body style="margin:0;padding:32px 24px;font:15px/1.75 system-ui,'Segoe UI',sans-serif">
<main style="max-width:680px;margin:0 auto">
<h1 style="font-size:19px;margin:0 0 12px">配置页文件缺失</h1>
<p>临时服务已经启动，但读不到页面模板 <code>web/index.html</code>。
请确认插件目录下存在 <code>web/</code>（页面、逻辑与样式）与 <code>preview/vendor/</code>
（React 的两个 UMD 构建）；本机开发时这两个目录都在仓库里。</p>
<p>地址里的令牌只对本次会话有效；页面每 5 秒报到一次，120 秒没有心跳服务就自行关闭。</p>
</main>
</body>
</html>`;
}


/**
 * 造一个临时配置服务。
 *
 * @param {object} [options]
 * @param {(level: string, message: string, meta?: object) => void} [options.log] 日志（宿主注入）
 * @param {((url: string) => unknown) | null} [options.openBrowser]
 *   打开浏览器的注入点。**默认不打开**：真正的实现是 `open-browser.mjs` 的
 *   `openBrowser`，由调用方注入；这样测试里不会意外弹出浏览器窗口。
 *   抛错、返回 `{ok:false}`、返回 reject 的 Promise 都只记一条 warn。
 * @param {() => number} [options.now] 取当前时间的毫秒数（测试注入假时钟）
 * @param {typeof http} [options.httpModule] `node:http`（测试注入假实现）
 * @param {typeof setInterval} [options.intervalFn] 定时器注入点（测试驱动节拍）
 * @param {typeof clearInterval} [options.clearIntervalFn] 清除定时器
 * @param {string} [options.pageHtml]
 *   页面 HTML 模板（字符串）。非空时直接使用；空串或未提供时每次请求现读
 *   `webDir/index.html`；两者都拿不到才用内联占位页。
 *   模板里的 `__TOKEN__` 会替换成本次会话的令牌。
 *   本选项由 `src/index.mjs` 在启动时填入 `web/index.html` 的内容。
 * @param {string} [options.webDir] 页面目录（`app.js` / `logic.mjs` / `style.css` / `index.html`）
 * @param {string} [options.vendorDir] React UMD 所在目录（复用 `preview/vendor/`，不复制第二份）
 * @param {number} [options.idleTimeoutMs] 多久没心跳就关（默认 120 秒）
 * @param {number} [options.tickIntervalMs] 心跳检查节拍（默认 1 秒）
 * @param {string | (() => string)} [options.upstream]
 *   主 webServer 的来源地址（`http://127.0.0.1:<port>`），`/dsh-qq-proactive/*`
 *   的转发目标。可以给字符串，也可以给**惰性函数**——服务实例本身要等插件注入
 *   之后才拿得到，因此 `src/index.mjs` 传的是
 *   `() => resolveWebServerOrigin(webServer)`。留空或取不到时，转发一律回 `502`。
 * @param {number} [options.upstreamTimeoutMs] 转发超时（默认 10 秒）
 * @param {string} [options.stateFile]
 *   `{port, token}` 的持久化文件（`<DSH_HOME>/media/qq-config-page.json`，由
 *   {@link defaultConfigPageStatePath} 推出来）。**空前缀 = 关掉持久化**：每次都用
 *   随机端口 + 新令牌（测试进程没有 `DSH_HOME` 时就是这一档）。读/写失败只记 debug，
 *   绝不影响服务本身。
 * @param {number} [options.preferredPort]
 *   想绑的固定端口（配置项 `configPagePort`）。`0` / 非法值 = 没有偏好，此时退到
 *   `stateFile` 里上次记录的端口；两者都没有才用 `listen(0)` 的随机端口。
 * @param {object} [options.fsImpl]
 *   持久化用的 `fs` 注入点（测试验证读/写失败的降级路径）。
 * @param {((target: string, options: object) => Promise<{status: number, contentType: string, body: Buffer}>) | null} [options.requestUpstream]
 *   转发请求的注入点。默认用 `node:http` 真发请求；测试注入假实现来验证超时与失败，
 *   不必真的等满 10 秒。
 * @returns {{
 *   open: (options?: {openBrowser?: boolean}) => Promise<{state: string, url: string, port: number, ageMs: number, lastBeatMs: number|null, browserOpened: boolean}>,
 *   close: () => {state: string, url: string, port: number, ageMs: number, lastBeatMs: number|null},
 *   status: () => {state: string, url: string, port: number, ageMs: number, lastBeatMs: number|null},
 *   handleHeartbeat: () => {state: string, url: string, port: number, ageMs: number, lastBeatMs: number|null},
 * }}
 */
export function createConfigServer({
  log = () => {},
  openBrowser = null,
  now = () => Date.now(),
  httpModule = http,
  intervalFn = setInterval,
  clearIntervalFn = clearInterval,
  pageHtml = null,
  webDir = DEFAULT_WEB_DIR,
  vendorDir = DEFAULT_VENDOR_DIR,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  tickIntervalMs = TICK_INTERVAL_MS,
  upstream = '',
  upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
  requestUpstream = null,
  stateFile = '',
  preferredPort = 0,
  fsImpl = fs,
} = {}) {
  /** 已建立的连接：`close()` 时主动销毁，否则 keep-alive 会让端口多活好一会儿。 */
  const openSockets = new Set();

  /** 正在监听的 server；`null` = 已关闭。它是"在跑"的唯一判据。 */
  let server = null;
  /** 一次性令牌；关闭时清空。 */
  let token = '';
  /** 系统分配的端口；关闭后归零。 */
  let port = 0;
  /** 完整入口地址（含令牌）；关闭后为空串。 */
  let url = '';
  /** 本轮的打开时刻（心跳的初值兜底）。 */
  let openedAt = 0;
  /** 最后一次心跳的时刻；`0` = 这一轮还从没报到过。 */
  let lastBeatAt = 0;
  /** 心跳检查的定时器句柄。 */
  let timer = null;
  /** 启动/关闭的代次：用于丢弃"关闭之后才完成"的启动结果。 */
  let generation = 0;
  /** 正在进行的 `open()`（并发调用共用同一次启动）。 */
  let pendingOpen = null;

  /** 状态文件路径（空前缀 = 关掉持久化）。 */
  const statePath = typeof stateFile === 'string' ? stateFile.trim() : '';

  /**
   * 读上一次的 `{port, token}`。
   *
   * **本函数不抛异常**：它在 `start()` 里被调用，而 `start()` 可能由插件的 apply
   * 阶段触发；任何未捕获异常都会让插件加载失败、连带宿主退出。所有失败形态
   * （文件不存在、坏 JSON、字段缺失、权限不足、路径是目录）一律当成"没有记录"，
   * 只记一条 debug —— 这属于优化路径，不该在日志里刷存在感。
   *
   * @returns {{port: number, token: string}|null}
   */
  function readPersistedState() {
    if (statePath === '') return null;
    let text;
    try {
      text = fsImpl.readFileSync(statePath, 'utf8');
    } catch (error) {
      // ENOENT 是最常见的（第一次运行），不必和真故障区分开：都按"没有记录"。
      if (error?.code !== 'ENOENT') {
        log('debug', '读取配置页状态文件失败（按没有记录处理）', {
          file: statePath,
          error: errorText(error),
        });
      }
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      log('debug', '配置页状态文件不是合法 JSON（按没有记录处理）', {
        file: statePath,
        error: errorText(error),
      });
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const savedPort = normalizePort(parsed.port);
    if (savedPort === 0 || !isTokenLike(parsed.token)) {
      log('debug', '配置页状态文件的端口/令牌不合法（按没有记录处理）', { file: statePath });
      return null;
    }
    return { port: savedPort, token: parsed.token };
  }

  /**
   * 把 `{port, token}` 写回状态文件：临时文件 + `rename` 原子替换。
   *
   * 与 `qq-proactive-*.json` 的写法一致（同目录临时文件，避免读到半截 JSON）。
   * **失败只记 debug**：写不进去的后果只是"下次重载换个端口/令牌"，页面重新打开即可，
   * 不该因此把服务起不来。文件按 `0600` 创建（POSIX 上收紧到本用户可读；
   * Windows 上 `mode` 不产生 ACL 效果，文件继承 `<DSH_HOME>\media` 的 ACL）。
   *
   * @param {{port: number, token: string}} value
   * @returns {boolean} 是否写成功
   */
  function writePersistedState(value) {
    if (statePath === '') return false;
    const tmp = `${statePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      fsImpl.mkdirSync(path.dirname(statePath), { recursive: true });
      fsImpl.writeFileSync(
        tmp,
        `${JSON.stringify({ port: value.port, token: value.token }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      fsImpl.renameSync(tmp, statePath);
      // 已存在的文件复写时 `mode` 不生效，再显式收紧一次（POSIX 有效）。
      try {
        fsImpl.chmodSync(statePath, 0o600);
      } catch {
        /* Windows 上 chmod 基本是空操作，失败也不影响可用性 */
      }
      return true;
    } catch (error) {
      try {
        fsImpl.rmSync(tmp, { force: true });
      } catch {
        /* 临时文件留着也无害 */
      }
      log('debug', '写入配置页状态文件失败（下次重载会换端口/令牌）', {
        file: statePath,
        error: errorText(error),
      });
      return false;
    }
  }

  /** 等一小会儿（重试绑定端口用）。定时器 unref，不拖住宿主退出。 */
  function sleep(ms) {
    return new Promise((resolve) => {
      try {
        const handle = setTimeout(resolve, ms);
        if (handle !== null && typeof handle === 'object' && typeof handle.unref === 'function') {
          handle.unref();
        }
      } catch {
        resolve();
      }
    });
  }

  /**
   * 未注入页面 HTML 时的兜底占位页。
   * 刻意写成内联常量而非独立函数：这里必须是**不可能未定义**的最小实现，
   * 因为 `createConfigServer` 在插件 `apply` 阶段调用，任何 ReferenceError
   * 都会让整个插件加载失败，进而导致宿主进程退出。
   */
  const PLACEHOLDER_PAGE = [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<title>QQ 小鲸鱼</title>',
    '<p>配置页尚未实现。',
    // 占位页必须自己报到：服务只认心跳，120 秒没人报到就会自行关闭。
    '<script>',
    'setInterval(() => {',
    '  fetch("/heartbeat" + location.search, { method: "POST" }).catch(() => {});',
    '}, 5000);',
    '</script>',
  ].join('');
  /**
   * 调用方显式给出的页面模板；空串表示"没有覆盖"。
   *
   * 与下面的 `PLACEHOLDER_PAGE` 不同，这里允许为空：`src/index.mjs` 在读取
   * `web/index.html` 失败时会传空串，此时仍然可以走每次请求现读磁盘的路径，
   * 两处都失败才落到占位页。
   */
  const pageOverride = typeof pageHtml === 'string' && pageHtml !== '' ? pageHtml : '';

  /**
   * 本次请求应当送出的页面模板，按优先级取第一个可用的：
   *
   * 1. 调用方注入的 `pageHtml`（`src/index.mjs` 在启动时读一次 `web/index.html`）；
   * 2. 每次请求现读 `webDir/index.html` —— 这样 F5 就能看到页面改动，
   *    只有 HTML 在启动时被注入过时才需要重载插件；
   * 3. 内联占位页 `PLACEHOLDER_PAGE`。
   *
   * 任何一步失败都往下一级降级，绝不抛异常：本函数在请求处理链里被调用，
   * 抛出的异常会成为宿主进程里的未捕获异常。
   *
   * @returns {string}
   */
  function pageTemplate() {
    try {
      if (pageOverride !== '') return pageOverride;
      const fresh = readPageHtml({ webDir });
      return fresh === '' ? PLACEHOLDER_PAGE : fresh;
    } catch {
      return PLACEHOLDER_PAGE;
    }
  }

  /** 本端口的来源（Origin 校验与入口地址共用这一处）。 */
  function originFor(targetPort) {
    return `http://${LISTEN_HOST}:${targetPort}`;
  }

  /**
   * 本次转发要用的上游基址，归一成 `scheme://host:port`（可带基路径）；无效时为空串。
   *
   * `upstream` 既可以是字符串，也可以是函数（`src/index.mjs` 传的就是函数：
   * 主服务器实例要等注入之后才拿得到，端口更是要等它绑定）。每次请求现取，
   * 因此端口一旦就绪就自动可用，不需要"重新创建临时服务"。
   *
   * @returns {string}
   */
  function resolvedUpstream() {
    let raw;
    try {
      raw = typeof upstream === 'function' ? upstream() : upstream;
    } catch (error) {
      log('warn', '读取主服务器地址失败', { error: errorText(error) });
      return '';
    }
    if (typeof raw !== 'string' || raw === '') return '';
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {
      // 不是合法 URL（例如只给了 "127.0.0.1:61482"）：当作没有地址，走 502。
      return '';
    }
  }

  /**
   * 把一次请求代理给主 webServer。
   *
   * 只在令牌与 `Origin` 两道门之后调用。请求体与 `content-type` 原样送给上游，
   * 响应的状态码、`content-type`、响应体原样写回。
   *
   * **本函数不抛异常**：上游未注入、连不上、超时、读请求体失败，
   * 全部折成 `502` + JSON。转发挂在请求链上，抛出去就是宿主里的未捕获异常。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} parsed 已解析的请求地址
   */
  async function forwardToUpstream(req, res, parsed) {
    const base = resolvedUpstream();
    if (base === '') {
      log('warn', '转发失败：拿不到主 webServer 的地址', { path: parsed.pathname });
      sendJson(res, 502, { ok: false, error: '主服务器地址未知，无法转发' });
      return;
    }

    const method = req.method === 'POST' ? 'POST' : 'GET';
    let body = null;
    if (method === 'POST') {
      try {
        body = await readRequestBody(req);
      } catch (error) {
        log('warn', '转发失败：读取请求体出错', { path: parsed.pathname, error: errorText(error) });
        sendJson(res, 502, { ok: false, error: `读取请求体失败：${errorText(error)}` });
        return;
      }
    }

    // 查询串原样转发（含令牌参数）：本服务不解释主服务器的参数，改写只会制造差异。
    const target = `${base}${parsed.pathname}${parsed.search}`;
    const headers = {};
    const rawType = req.headers?.['content-type'];
    const contentType = typeof rawType === 'string' ? rawType : Array.isArray(rawType) ? String(rawType[0] ?? '') : '';
    if (contentType !== '') headers['content-type'] = contentType;

    const call = typeof requestUpstream === 'function' ? requestUpstream : httpRequestUpstream;
    try {
      const answered = await withDeadline(
        call(target, { method, headers, body, timeoutMs: upstreamTimeoutMs }),
        upstreamTimeoutMs,
        `转发到主服务器超时（${upstreamTimeoutMs} 毫秒）`,
      );
      sendUpstreamResponse(res, answered);
    } catch (error) {
      log('warn', '转发到主服务器失败', { path: parsed.pathname, error: errorText(error) });
      sendJson(res, 502, { ok: false, error: `转发到主服务器失败：${errorText(error)}` });
    }
  }

  /** 空闲基准：最后一次心跳，或本轮打开时刻，取较晚的那个。 */
  function idleBase() {
    return Math.max(openedAt, lastBeatAt);
  }

  /**
   * 当前状态。关闭时各字段归零，`lastBeatMs` 为 `null`（"没有这个数"，区别于 0）。
   */
  function status() {
    if (server === null) {
      return { state: 'closed', url: '', port: 0, ageMs: 0, lastBeatMs: null };
    }
    const at = now();
    return {
      state: 'running',
      url,
      port,
      ageMs: Math.max(0, at - openedAt),
      lastBeatMs: lastBeatAt > 0 ? Math.max(0, at - lastBeatAt) : null,
    };
  }

  /** 常数时间的字符串比较（长度不同直接判否，`timingSafeEqual` 要求等长）。 */
  function sameSecret(candidate, expected) {
    if (typeof candidate !== 'string' || candidate === '' || candidate.length !== expected.length) {
      return false;
    }
    try {
      return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  /** 令牌校验：`?t=` 或 `X-Config-Token` 头，两处任一正确即可。 */
  function tokenMatches(parsed, req) {
    if (token === '') return false;
    if (sameSecret(parsed.searchParams.get(TOKEN_QUERY_KEY) ?? '', token)) return true;
    const raw = req.headers?.[TOKEN_HEADER];
    const fromHeader = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0] ?? '') : '';
    return sameSecret(fromHeader, token);
  }

  /** `POST` 的 Origin 校验：必须正好是本临时服务的来源，缺头也算不通过。 */
  function originMatches(req) {
    if (port === 0) return false;
    const raw = req.headers?.origin;
    const origin = typeof raw === 'string' ? raw : '';
    return origin !== '' && origin === originFor(port);
  }

  /** 记一次心跳。服务已关时什么也不做（此时不应有请求进来）。 */
  function handleHeartbeat() {
    try {
      if (server !== null) lastBeatAt = now();
    } catch (error) {
      log('warn', '记录配置页心跳失败', { error: errorText(error) });
    }
    return status();
  }

  /** 心跳检查：唯一的关闭判据。 */
  function tick() {
    try {
      if (server === null) return;
      const idleMs = now() - idleBase();
      if (idleMs > idleTimeoutMs) {
        log('info', `临时配置服务 ${Math.round(idleTimeoutMs / 1000)} 秒没有心跳，自行关闭`, {
          port,
          idleMs,
        });
        close();
      }
    } catch (error) {
      // 检查本身出错也不能把宿主带下去；关掉服务是安全的降级。
      log('warn', '临时配置服务的心跳检查失败，按无心跳处理', { error: errorText(error) });
      try {
        close();
      } catch {
        /* 关闭流程自己出错时无处可去 */
      }
    }
  }

  /** 关闭：幂等。清定时器、清令牌、关监听、踩掉残留连接。 */
  function close() {
    generation += 1;
    if (timer !== null) {
      try {
        clearIntervalFn(timer);
      } catch {
        /* 定时器可能已经被清过 */
      }
      timer = null;
    }
    const current = server;
    const closedPort = port;
    server = null;
    token = '';
    port = 0;
    url = '';
    openedAt = 0;
    lastBeatAt = 0;
    if (current !== null) {
      try {
        current.close(() => {});
      } catch {
        /* 没在监听或已经关闭 */
      }
      for (const socket of openSockets) {
        try {
          socket.destroy();
        } catch {
          /* 单个连接销毁失败不影响其它连接 */
        }
      }
      openSockets.clear();
      log('info', '临时配置服务已关闭', { port: closedPort });
    }
    return status();
  }

  /** 打开浏览器：任何失败都只记 warn，绝不影响返回的地址。 */
  function openInBrowser(target) {
    if (typeof openBrowser !== 'function') return;
    let result;
    try {
      result = openBrowser(target);
    } catch (error) {
      log('warn', '打开浏览器失败（地址仍然有效，可手工粘贴）', { error: errorText(error) });
      return;
    }
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      result.then(
        (value) => {
          if (value !== null && typeof value === 'object' && value.ok === false) {
            log('warn', '打开浏览器失败（地址仍然有效，可手工粘贴）', { error: value.error ?? '' });
          }
        },
        (error) => {
          log('warn', '打开浏览器失败（地址仍然有效，可手工粘贴）', { error: errorText(error) });
        },
      );
      return;
    }
    if (result !== null && typeof result === 'object' && result.ok === false) {
      log('warn', '打开浏览器失败（地址仍然有效，可手工粘贴）', { error: result.error ?? '' });
    }
  }

  /** 请求处理：令牌 →（POST）Origin → 路由。整条链自己吞异常。 */
  async function handleRequest(req, res) {
    try {
      let parsed = null;
      try {
        parsed = new URL(typeof req.url === 'string' && req.url !== '' ? req.url : '/', originFor(port || 0));
      } catch {
        parsed = null;
      }
      if (parsed === null || !tokenMatches(parsed, req)) {
        sendNotFound(res);
        return;
      }

      // 转发路径：`/dsh-qq-proactive/*` 属于主 webServer，页面从临时服务端口发来的
      // 请求由这里原样代理过去。只做前缀匹配 —— 具体子路径与允许的方法都在主服务器
      // 那边，这里不复制那份名单。
      const forwardable = parsed.pathname.startsWith(FORWARD_PREFIX);

      if (req.method === 'POST') {
        // Origin 是既有的一道门，转发路径同样要过：它防的是别的网页跨站打这个口子。
        if (!originMatches(req)) {
          drainRequest(req);
          sendJson(res, 403, { ok: false, error: 'Origin 不被接受' });
          return;
        }
        // 转发路径需要原始请求体；其余路由把流读空，否则 keep-alive 连接会被
        // 半截请求卡住。
        if (!forwardable) drainRequest(req);
      }

      if (forwardable) {
        if (req.method !== 'GET' && req.method !== 'POST') {
          drainRequest(req);
          sendJson(res, 405, { ok: false, error: '只接受 GET 或 POST' });
          return;
        }
        await forwardToUpstream(req, res, parsed);
        return;
      }

      if (parsed.pathname === '/status') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '只接受 GET' });
          return;
        }
        sendJson(res, 200, status());
        return;
      }

      if (parsed.pathname === '/heartbeat') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' });
          return;
        }
        sendJson(res, 200, handleHeartbeat());
        return;
      }

      if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '只接受 GET' });
          return;
        }
        // 令牌占位符在送出的这一刻替换：静态资源无法自定义请求头，只能把令牌
        // 拼进查询参数，而令牌每次 open() 都会重新生成，不能预先写死在文件里。
        sendHtml(res, 200, renderPageHtml(pageTemplate(), token));
        return;
      }

      // 静态资源：只认白名单里的确切文件名，地址不在表里一律 404。
      const asset = STATIC_ASSETS.get(parsed.pathname);
      if (asset !== undefined) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '只接受 GET' });
          return;
        }
        const rootDir = asset.dir === 'vendor' ? vendorDir : webDir;
        const target = resolveWithin(rootDir, asset.file);
        if (target === null) {
          sendNotFound(res);
          return;
        }
        let body = null;
        try {
          body = fs.readFileSync(target);
        } catch {
          // 文件缺失、权限不足、路径是目录：都是 404。这里不能是 500 ——
          // 静态资源缺失属于部署问题，不该表现为"服务坏了"。
          body = null;
        }
        if (body === null || body.length === 0) {
          sendNotFound(res);
          return;
        }
        sendBytes(res, 200, asset.type, body);
        return;
      }

      sendNotFound(res);
    } catch (error) {
      log('warn', '临时配置服务处理请求失败', { error: errorText(error) });
      try {
        res.writeHead(500, { 'cache-control': 'no-store' });
        res.end();
      } catch {
        /* 连接已经断了 */
      }
    }
  }

  /** 把 `listen` 包装成 Promise（成功一次即解绑两个一次性监听器）。 */
  function listenOnce(srv, targetPort) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onListening = () => finish(null);
      const onError = (error) => finish(error);
      function finish(error) {
        if (settled) return;
        settled = true;
        try {
          srv.off?.('listening', onListening);
          srv.off?.('error', onError);
        } catch {
          /* 假的 server 可能没有 off */
        }
        if (error) reject(error);
        else resolve();
      }
      srv.once('listening', onListening);
      srv.once('error', onError);
      try {
        // `targetPort = 0` 表示让系统分配随机端口（回退路径）。
        srv.listen(targetPort, LISTEN_HOST);
      } catch (error) {
        finish(error);
      }
    });
  }

  /** 关掉一个 server；失败无所谓（它可能压根没在监听）。 */
  function closeQuietly(srv) {
    try {
      srv?.close?.(() => {});
    } catch {
      /* 没监听成功时 close 可能抛 */
    }
  }

  /** 造一个监听用的 server：请求兜底 + 连接跟踪（`close()` 要靠它踩掉 keep-alive）。 */
  function makeServer() {
    const srv = httpModule.createServer((req, res) => {
      // 兜底：handleRequest 自己已经 try/catch，这里再拦一层，
      // 因为 Promise 的 rejection 同样会变成宿主里的未捕获异常。
      handleRequest(req, res).catch((error) => {
        log('warn', '临时配置服务的请求处理抛出异常', { error: errorText(error) });
      });
    });

    srv.on('connection', (socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
      socket.on('error', () => {
        /* 客户端断连不是错误 */
      });
    });
    return srv;
  }

  /**
   * 造一个 server 并绑到 `targetPort` 上；成功返回 `{srv, port}`。
   *
   * 失败时把 server 关掉再抛 —— 调用方不必自己收尾（重试与回退都靠这个约定）。
   * 端口读不出来（`address()` 为 null / 非正整数）按失败处理：那说明监听状态不对，
   * 与其拼一个 `:0` 的地址，不如走回退。
   *
   * @param {number} targetPort
   * @returns {Promise<{srv: import('node:http').Server, port: number}>}
   */
  async function listenOn(targetPort) {
    const srv = makeServer();
    try {
      await listenOnce(srv, targetPort);
      const address = typeof srv.address === 'function' ? srv.address() : null;
      const bound = address !== null && typeof address === 'object' && typeof address.port === 'number'
        ? address.port
        : 0;
      if (!Number.isInteger(bound) || bound <= 0) throw new Error('监听成功但读不到端口');
      return { srv, port: bound };
    } catch (error) {
      closeQuietly(srv);
      throw error;
    }
  }

  /**
   * 真正起服务：**先试固定/上次的端口（复用上次的令牌）**，失败才回退随机端口。
   *
   * 端口选择的优先顺序（见模块头部「跨插件重载的原地接回」）：
   *
   * 1. `preferredPort`（配置项 `configPagePort`）—— 有就用它；
   * 2. 否则用状态文件里上次记录的端口（"没配也稳定"）；
   * 3. 都没有 ⇒ 随机端口。
   *
   * 绑定失败时：EADDRINUSE 先**重试**（旧实例的 socket 可能还没放干净），
   * 仍失败才回退 `listen(0)`；回退成功会记一条 warn，说明页面需要重新打开。
   *
   * 令牌**只在绑到的端口与上次记录一致时复用** —— 换了端口，旧页面指着旧 origin，
   * 复用令牌没有任何好处，反而让一个已经失效的令牌继续有效，不如重生。
   *
   * 成功之后把 `{port, token}` 写回状态文件（写失败只记 debug）。
   *
   * @param {boolean} [shouldOpenBrowser] 起完之后是否 spawn 系统浏览器
   */
  async function start(shouldOpenBrowser = true) {
    const gen = ++generation;
    const previous = readPersistedState();
    const wanted = normalizePort(preferredPort);
    // 配置里的固定端口优先；没配就沿用上次记录的端口（这条让"不配也稳定"）。
    const candidate = wanted > 0 ? wanted : previous === null ? 0 : previous.port;

    let bound = null;
    let failureCode = '';
    if (candidate > 0) {
      for (let attempt = 1; attempt <= LISTEN_RETRY_ATTEMPTS; attempt += 1) {
        try {
          bound = await listenOn(candidate);
          break;
        } catch (error) {
          // 启动期间被 close()（例如插件正好在卸载）：不再折腾。
          if (gen !== generation) return status();
          failureCode = typeof error?.code === 'string' && error.code !== '' ? error.code : 'error';
          if (error?.code !== 'EADDRINUSE' || attempt >= LISTEN_RETRY_ATTEMPTS) break;
          await sleep(LISTEN_RETRY_DELAY_MS);
        }
      }
    }

    if (bound === null) {
      try {
        // 回退：让系统分配随机端口（这是改动前一直走的路径，保留成兜底）。
        bound = await listenOn(0);
      } catch (error) {
        log('warn', '临时配置服务启动失败（不影响插件的其它功能）', { error: errorText(error) });
        throw error;
      }
      if (candidate > 0) {
        log(
          'warn',
          failureCode === 'EADDRINUSE'
            ? `固定端口 ${candidate} 被占用（重试 ${LISTEN_RETRY_ATTEMPTS} 次仍失败），这次改用 ${bound.port}，配置页需要重新打开`
            : `固定端口 ${candidate} 绑定失败（${failureCode}），这次改用 ${bound.port}，配置页需要重新打开`,
          { port: bound.port, wantedPort: candidate },
        );
      }
    }

    const srv = bound.srv;
    // 启动过程中被 close()（例如插件正好在卸载）：把刚起来的监听丢掉。
    if (gen !== generation) {
      closeQuietly(srv);
      return status();
    }

    // 监听成功之后仍然要有人接住 'error'，否则运行期的服务错误没人管。
    srv.on('error', (error) => {
      log('warn', '临时配置服务出错', { error: errorText(error) });
    });

    // 令牌跨重载复用：只有"绑到了上次那个端口"时才有意义（旧页面指着同一个 origin）。
    const reuseToken = previous !== null && previous.port === bound.port ? previous.token : '';
    const nextToken = reuseToken !== ''
      ? reuseToken
      : crypto.randomBytes(TOKEN_BYTES).toString('hex');

    server = srv;
    token = nextToken;
    port = bound.port;
    url = `${originFor(port)}/?${TOKEN_QUERY_KEY}=${token}`;
    openedAt = now();
    lastBeatAt = 0;
    timer = intervalFn(tick, tickIntervalMs);
    if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') {
      timer.unref();
    }
    // 写回 `{port, token}`：下一次重载（或下一次加载）就绑回这里。写失败不阻止启动。
    writePersistedState({ port, token });
    log(
      'info',
      reuseToken !== ''
        ? '临时配置服务已启动（复用上次的端口与令牌，开着的配置页可以直接接回）'
        : '临时配置服务已启动（只监听回环，新令牌）',
      { port, tokenReused: reuseToken !== '', wantedPort: candidate },
    );
    if (shouldOpenBrowser) openInBrowser(url);
    return status();
  }

  /**
   * 复用已有的服务：只刷新打开时刻。
   *
   * **刻意不打开浏览器。** 复用意味着端口与令牌都没变，调用方拿返回的 `url`
   * 自己决定怎么呈现（遥控卡片用的是 `window.open`）。若这里再 spawn 一次
   * 系统浏览器，每次点「打开配置页」都会多出一个窗口 —— 这正是要修掉的现象。
   *
   * @returns {object} `status()`
   */
  function reuse() {
    openedAt = now();
    return status();
  }

  /**
   * 起服务；**已在跑就复用**（同一个端口、同一个令牌）。
   *
   * 浏览器的打开时机由 `openBrowser` 决定：
   *
   * - 缺省（`true`）：只在**服务从无到有**的那一次 spawn 系统浏览器。
   * - `false`：任何情况下都不 spawn。供内部与测试验证地址/状态用 —— 那种调用
   *   只想要数据，不该在用户的桌面上留下窗口。
   * - 复用分支一律不 spawn，与 `openBrowser` 无关。
   *
   * 并发调用共用同一次启动，此时 `openBrowser` 以**发起启动的那一次**为准：
   * 后到的调用走复用分支，不会补开窗口。
   *
   * 启动失败会 reject，由调用方转成一条 warn / 500。
   *
   * 返回值比 `status()` 多一个 `browserOpened` 布尔：**这一次调用**有没有请求
   * 打开浏览器。调用方据此避免"宿主开了一个、自己也开一个"的双窗口。
   *
   * @param {{openBrowser?: boolean}} [options]
   * @returns {Promise<object>} `status()` + `browserOpened`
   */
  async function open(options = {}) {
    const wantsBrowser = !(options !== null && typeof options === 'object' && options.openBrowser === false);
    if (server !== null) return { ...reuse(), browserOpened: false };
    if (pendingOpen !== null) {
      try {
        await pendingOpen;
      } catch {
        /* 上一次启动失败：这一次重新试一遍 */
      }
      if (server !== null) return { ...reuse(), browserOpened: false };
    }
    const attempt = start(wantsBrowser);
    pendingOpen = attempt;
    try {
      await attempt;
    } finally {
      if (pendingOpen === attempt) pendingOpen = null;
    }
    // `browserOpened` 只说明**这一次调用**有没有请求打开浏览器。调用方据此
    // 决定要不要自己再开一个标签页 —— 两边都开就是"多出一个窗口"。
    return { ...status(), browserOpened: wantsBrowser };
  }

  return { open, close, status, handleHeartbeat };
}

/**
 * 造「启停开关」的三条路由（**不注册**，调用方负责 `webServer.register`）。
 *
 * | 路由 | 作用 |
 * |---|---|
 * | `POST /dsh-qq-proactive/config-server/open` | 起服务 +（默认）打开浏览器 ⇒ `{ok, url, port, state, browserOpened}` |
 * | `POST /dsh-qq-proactive/config-server/close` | 停服务 |
 * | `GET  /dsh-qq-proactive/config-server/status` | `status()` |
 *
 * 它们挂在**主 webServer** 上，与临时服务自己的三个端点分开：
 * 临时服务关掉之后，这三条仍然在，才可能"再点一次打开"。
 *
 * 三个 handler 都自己吞异常（挂在这里的异常就是宿主里的未捕获异常）。
 *
 * `POST .../open` 接受一个**可选**的 JSON 请求体 `{ "openBrowser": false }`：
 * 该字段为 `false` 时不 spawn 系统浏览器，只把服务起起来并返回地址。
 * 缺省（或请求体读不懂）等价于 `true`。
 *
 * @param {object} options
 * @param {ReturnType<typeof createConfigServer>} options.configServer 临时服务实例
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @returns {Array<{kind: string, path: string, handler: Function}>}
 */
export function createConfigServerRoutes({ configServer = null, log = () => {} } = {}) {
  const requireServer = () => {
    if (configServer === null || configServer === undefined) {
      throw new Error('configServer 未注入');
    }
    return configServer;
  };

  const handleOpen = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只接受 POST' });
        return;
      }
      // 可选请求体 `{ "openBrowser": false }`：缺省、坏 JSON、字段不是布尔值时
      // 一律按 `true` 处理（用户的按钮就该开一次窗口）；`false` 是给内部与
      // 测试验证数据用的，那种调用不该在桌面上留下窗口。
      const body = await readJsonBody(req);
      const requested = body === null ? undefined : body.openBrowser;
      const current = await requireServer().open(
        typeof requested === 'boolean' ? { openBrowser: requested } : {},
      );
      sendJson(res, 200, {
        ok: true,
        url: current.url,
        port: current.port,
        state: current.state,
        // 这一次调用有没有请求打开浏览器。调用方（遥控卡片）据此决定是否
        // 自己再开一个标签页：宿主已经开了还再开，就会出现两个窗口。
        browserOpened: current.browserOpened === true,
      });
    } catch (error) {
      log('warn', '打开临时配置服务失败', { error: errorText(error) });
      sendJson(res, 500, {
        ok: false,
        state: 'closed',
        url: '',
        port: 0,
        error: errorText(error),
      });
    }
  };

  const handleClose = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只接受 POST' });
        return;
      }
      const current = requireServer().close();
      sendJson(res, 200, {
        ok: true,
        url: current.url,
        port: current.port,
        state: current.state,
      });
    } catch (error) {
      log('warn', '关闭临时配置服务失败', { error: errorText(error) });
      sendJson(res, 500, { ok: false, state: 'closed', url: '', port: 0, error: errorText(error) });
    }
  };

  const handleStatus = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '只接受 GET' });
        return;
      }
      sendJson(res, 200, { ok: true, ...requireServer().status() });
    } catch (error) {
      log('warn', '读取临时配置服务状态失败', { error: errorText(error) });
      sendJson(res, 500, { ok: false, state: 'closed', url: '', port: 0, error: errorText(error) });
    }
  };

  return [
    { kind: 'exact', path: `${CONFIG_SERVER_ROUTE_BASE}/open`, handler: handleOpen },
    { kind: 'exact', path: `${CONFIG_SERVER_ROUTE_BASE}/close`, handler: handleClose },
    { kind: 'exact', path: `${CONFIG_SERVER_ROUTE_BASE}/status`, handler: handleStatus },
  ];
}
