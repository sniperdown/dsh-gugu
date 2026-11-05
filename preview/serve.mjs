/**
 * 本地静态预览站 —— 只做静态服务，一个依赖都不引（Node 内置 http/fs/path）。
 *
 * 用法：
 *   node preview/serve.mjs            # 默认 http://127.0.0.1:8899/
 *   set PREVIEW_PORT=9000 && node preview/serve.mjs
 *
 * 为什么需要它：`client.js` 是**经典脚本**（靠 `window.__ModuleLoader__` 注册），
 * 浏览器不许从 file:// 直接加载模块、也不让跨目录取文件，所以得有这么一个站。
 *
 * 路由是**白名单**（见 ROUTES）—— 只有表里那几条能取到文件，取不到的一律 404。
 * 每一条命中的路径还会再过一遍 `insideAllowed()`：用 `path.resolve` 把两端都变成
 * 真正的绝对路径再比，**不做字符串前缀比较**（历史上的写法是用正斜杠拼串比
 * `startsWith`，Windows 下反斜杠对不上，结果全站 403）。
 */

import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** preview/ 目录（本文件所在目录）。 */
const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
/** 仓库里的 qq-plugin/ 根目录 —— `client.js` 从这里取（**不复制**，永远是那一份）。 */
const ROOT = resolve(HERE, '..');

const PORT = Number(process.env.PREVIEW_PORT || 8899);
const HOST = '127.0.0.1';

/** 扩展名 → Content-Type。就这几个，够用了。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * URL 路径 → 绝对文件路径。**白名单**：不在表里的直接 404，根本没有"拼路径"的机会。
 *
 * `/client.js` 指向**上一层**的真文件 —— 预览页看到的永远是你现在磁盘上那份，
 * 所以改完 client.js 存盘、F5 一下就是新的（不需要重起这个站）。
 */
const ROUTES = new Map([
  ['/', resolve(HERE, 'index.html')],
  ['/index.html', resolve(HERE, 'index.html')],
  ['/boot.mjs', resolve(HERE, 'boot.mjs')],
  ['/fixtures.mjs', resolve(HERE, 'fixtures.mjs')],
  ['/serve.mjs', resolve(HERE, 'serve.mjs')],
  ['/client.js', resolve(ROOT, 'client.js')],
  ['/react.development.js', resolve(HERE, 'vendor', 'react.development.js')],
  ['/react-dom.development.js', resolve(HERE, 'vendor', 'react-dom.development.js')],
]);

/** 允许被读的根目录（preview/ 与 qq-plugin/）。 */
const ALLOWED_ROOTS = [HERE, ROOT];

/**
 * 路径守卫：`path.resolve` 之后按**目录边界**比，`preview-evil/` 这种不算在 `preview/` 里面。
 *
 * @param {string} target 待判定的绝对路径
 * @returns {boolean}
 */
function insideAllowed(target) {
  const file = resolve(target);
  return ALLOWED_ROOTS.some((root) => {
    const base = resolve(root);
    return file === base || file.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

const server = createServer(async (req, res) => {
  // 只收 GET / HEAD；别的直接拒。
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
    res.end('only GET/HEAD\n');
    return;
  }

  // 去掉查询串（`?t=` 之类）与尾部的 `/`，命中白名单。
  const rawPath = String(req.url || '/').split('?')[0].split('#')[0];
  const pathname = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;

  const file = ROUTES.get(pathname);
  if (file === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404  ${pathname}\n\npreview 只服务这几条：\n  ${[...ROUTES.keys()].join('\n  ')}\n`);
    return;
  }

  // 白名单命中的路径也要过守卫：万一以后有人往表里塞了 `../`，这里会挡住。
  if (!insideAllowed(file)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`403  ${pathname} is outside the allowed roots\n`);
    return;
  }

  // React 的 UMD 是可选的本地文件：本机没放进 vendor/ 就 302 到 CDN（需要联网）。
  // 放进去之后就自动变成离线可用，不用改任何代码。
  if (
    (pathname === '/react.development.js' || pathname === '/react-dom.development.js')
    && !(await fileExists(file))
  ) {
    const name = pathname === '/react.development.js' ? 'react' : 'react-dom';
    const target = `https://unpkg.com/${name}@18.3.1/umd/${name}.development.js`;
    res.writeHead(302, { location: target, 'cache-control': 'no-store' });
    res.end(`302 ${target}\n`);
    return;
  }

  try {
    const body = await readFile(file);
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      // 关键：**不许缓存**。改完 client.js 刷新就该是新的，不能被浏览器拿旧副本糊弄。
      'cache-control': 'no-store, must-revalidate',
      'content-length': body.byteLength,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
  } catch (error) {
    const code = error && error.code === 'ENOENT' ? 404 : 500;
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${code}  ${pathname}\n\n${String((error && error.message) || error)}\n`);
  }
});

server.on('error', (error) => {
  const code = error && error.code;
  if (code === 'EADDRINUSE') {
    console.error(`preview: port ${PORT} is already in use -- close that server, or run with PREVIEW_PORT=9000`);
    process.exit(1);
  }
  console.error('preview: server error', error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // 控制台只打 ASCII：Windows 控制台可能是 GBK，中文会变成乱码。
  console.log(`preview: http://${HOST}:${PORT}/`);
  console.log('preview: serving client.js from ' + resolve(ROOT, 'client.js'));
  console.log('preview: edit client.js, then press F5 in the browser (no restart needed)');
  console.log('preview: Ctrl+C to stop');
});

/**
 * 文件存在与否（不区分"是目录"）。
 *
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function fileExists(file) {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
