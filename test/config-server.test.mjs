/**
 * 宿主侧临时配置服务的测试。
 *
 * 这一层决定三件事，测试就钉这三件：
 *
 * 1. **生命周期只由心跳决定。** 起来的方式只有 `open()`；关掉的方式只有两种 ——
 *    显式 `close()`，或 15 秒没有心跳。没有兜底时长，也没有"起了一定还在"。
 * 2. **令牌与 Origin 是两道门。** 令牌错一律 404（不泄露服务存在），
 *    `POST` 的 Origin 必须是本端口自己的来源。
 * 3. **`/dsh-qq-proactive/*` 转发到主 webServer。** 状态码、`content-type`、响应体
 *    原样透传；上游缺失、连不上、超时一律 502 + JSON，**从不抛异常**。
 *
 * 时间用**注入的假时钟**驱动（`now` + `intervalFn`），所以 15 秒的判据可以
 * 毫秒级地确定性验证，不必真的等。socket 只用 `listen(0, '127.0.0.1')` 的
 * 随机回环端口，每个用例结束都 `close()` —— 不留监听、不碰外网。
 *
 * 转发的上游用**本地回环的桩服务**（真 socket，验证字节原样）或**注入的假请求**
 * （验证超时与失败，不真等 10 秒）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import {
  createConfigServer,
  createConfigServerRoutes,
  defaultConfigPageStatePath,
  resolveWebServerOrigin,
  CONFIG_SERVER_ROUTE_BASE,
  FORWARD_PREFIX,
  IDLE_TIMEOUT_MS,
  TOKEN_HEADER,
  TOKEN_QUERY_KEY,
} from '../src/dsh/config-server.mjs';
import { browserCommand, openBrowser } from '../src/dsh/open-browser.mjs';

// ---------------------------------------------------------------- 测试替身

/**
 * 假时钟 + 假定时器。
 *
 * `advance(ms)` 推进时间并**触发一次**心跳检查（模拟 1 秒的节拍到了）；
 * `move(ms)` 只推进时间，不触发检查。
 */
function fakeClock({ start = 1_000_000 } = {}) {
  const state = { value: start, tick: null, created: 0, cleared: [] };
  return {
    now: () => state.value,
    intervalFn: (fn) => {
      state.tick = fn;
      state.created += 1;
      return { unref() {} };
    },
    clearIntervalFn: (handle) => {
      state.cleared.push(handle);
      state.tick = null;
    },
    move(ms) {
      state.value += ms;
    },
    advance(ms) {
      state.value += ms;
      if (typeof state.tick === 'function') state.tick();
    },
    state,
  };
}

/** 假浏览器打开器：记录地址，并按需模拟三种失败。 */
function fakeBrowser(mode = 'ok') {
  const calls = [];
  const fn = (url) => {
    calls.push(url);
    if (mode === 'throw') throw new Error('打开浏览器时抛错');
    if (mode === 'false') return { ok: false, error: '命令不存在' };
    if (mode === 'reject') return Promise.reject(new Error('异步失败'));
    return { ok: true };
  };
  fn.calls = calls;
  return fn;
}

/** 造一个被测服务，并留下日志、假浏览器、假时钟和被造出来的 server。 */
function harness({ browser = 'ok', httpModule = null, createOptions = {} } = {}) {
  const clock = fakeClock();
  const browserFn = fakeBrowser(browser);
  const logs = [];
  const captured = [];
  const log = (level, message, meta) => {
    logs.push({ level, message, meta: meta ?? {} });
  };
  const wrappedHttp = httpModule ?? {
    createServer: (handler) => {
      const srv = http.createServer(handler);
      captured.push(srv);
      return srv;
    },
  };
  const server = createConfigServer({
    log,
    openBrowser: browserFn,
    now: clock.now,
    intervalFn: clock.intervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    httpModule: wrappedHttp,
    ...createOptions,
  });
  return { server, clock, browser: browserFn, logs, captured };
}

/** 发一个本地回环请求；成功时把状态码、头、文本一起返回。 */
function request(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: text,
          json: () => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('请求超时')));
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

/** 从入口地址里取出令牌。 */
function tokenOf(url) {
  return new URL(url).searchParams.get(TOKEN_QUERY_KEY);
}

/** 假的 res：够 `writeHead` / `end` 用就能读回响应体。 */
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(body) {
      if (body !== undefined) this.body += String(body);
    },
  };
}

/** 假的 req：工厂只看 `method` 与 `headers`。 */
function fakeReq({ method = 'GET', headers = {} } = {}) {
  return { method, headers, url: '/dsh-qq-proactive/config-server/open' };
}

/**
 * 假的 req，**带请求体**：按真实流的时序发出 `data` → `end`。
 *
 * 启停路由要读可选的 JSON 请求体，所以这里必须是一个真正的事件流：
 * 直接给一个普通对象的话 `readRequestBody` 会一直等 `end`，handler 永不返回。
 */
function fakeReqWithBody(body, { method = 'POST', headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.url = '/dsh-qq-proactive/config-server/open';
  const buffer = Buffer.from(body, 'utf8');
  process.nextTick(() => {
    req.emit('data', buffer);
    req.emit('end');
  });
  return req;
}

/**
 * 起一个真实的上游桩（本地回环真 socket）。
 *
 * 它记录收到的每个请求（方法、原始 URL、`content-type`、`content-length`、请求体），
 * 并按给定状态码 / 类型 / 正文回话 —— 用来验证转发是**逐字节原样**的，而不是
 * "大概对"。
 *
 * @param {{status?: number, type?: string, body?: string}} [reply]
 */
async function startUpstream({ status = 200, type = 'application/json; charset=utf-8', body = '{"ok":true}' } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        type: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '',
        length: String(req.headers['content-length'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const address = srv.address();
  return {
    seen,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

// ---------------------------------------------------------------- 起服务

test('open()：系统分配随机端口、只监听 127.0.0.1、URL 带 32 位十六进制令牌', async (t) => {
  const { server, browser, captured } = harness();
  t.after(() => server.close());

  const status = await server.open();
  assert.equal(status.state, 'running');
  assert.ok(Number.isInteger(status.port) && status.port > 0, '端口应由系统分配');
  assert.equal(captured.length, 1);

  const address = captured[0].address();
  assert.equal(address.address, '127.0.0.1', '只监听回环');
  assert.equal(address.port, status.port, '状态里的端口就是实际绑定的端口');

  const parsed = new URL(status.url);
  assert.equal(parsed.protocol, 'http:');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(Number(parsed.port), status.port);
  assert.match(parsed.searchParams.get(TOKEN_QUERY_KEY), /^[0-9a-f]{32}$/);

  // 打开浏览器收到的是同一个地址。
  assert.deepEqual(browser.calls, [status.url]);
  assert.equal(status.browserOpened, true, '这一次调用请求了打开浏览器');
});

test('open() 复用：已在跑就不重复起，端口与令牌都不变，也不再开第二个浏览器窗口', async (t) => {
  const { server, browser, captured, clock } = harness();
  t.after(() => server.close());

  const first = await server.open();
  clock.move(3000);
  const second = await server.open();

  assert.equal(second.url, first.url);
  assert.equal(second.port, first.port);
  assert.equal(captured.length, 1, '不重复创建 server');
  assert.equal(clock.state.created, 1, '不重复起心跳定时器');
  assert.equal(browser.calls.length, 1, '复用分支不 spawn：连点两次只有一个窗口');
  assert.deepEqual(browser.calls, [first.url], '开的那一次用的就是服务地址');
  assert.equal(second.ageMs, 0, '复用会刷新打开时刻');
});

// 连点三次：第一次从无到有（开一个窗口），后两次复用（不再开）。
// 这是"用户被多开两个窗口"那个现象的直接回归用例。
test('open() 复用不 spawn：连点三次只 spawn 一次浏览器', async (t) => {
  const { server, browser } = harness();
  t.after(() => server.close());

  const first = await server.open();
  const second = await server.open();
  const third = await server.open({ openBrowser: true });

  assert.equal(browser.calls.length, 1, '只有从无到有的那一次会 spawn');
  assert.deepEqual(browser.calls, [first.url]);
  assert.equal(second.port, first.port);
  assert.equal(third.port, first.port);
  assert.equal(first.browserOpened, true);
  assert.equal(second.browserOpened, false, '复用不请求开浏览器');
  assert.equal(third.browserOpened, false, '复用分支与传入的 openBrowser 无关');
});

test('open({openBrowser:false})：从无到有也不 spawn，但服务照常起来', async (t) => {
  const { server, browser } = harness();
  t.after(() => server.close());

  const status = await server.open({ openBrowser: false });
  assert.equal(status.state, 'running');
  assert.ok(status.port > 0);
  assert.match(status.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
  assert.deepEqual(browser.calls, [], '内部验证数据的调用不该弹窗口');
  assert.equal(status.browserOpened, false);
});

test('open({openBrowser:false}) 与服务已被复用时同样不 spawn', async (t) => {
  const { server, browser } = harness();
  t.after(() => server.close());

  await server.open({ openBrowser: false });
  const again = await server.open({ openBrowser: false });
  await server.open({ openBrowser: true });
  server.close();
  await server.open({ openBrowser: false });

  assert.equal(again.state, 'running');
  assert.deepEqual(browser.calls, [], 'false 在任何路径上都不 spawn，复用与重启也一样');
});

test('open() 启动失败：reject、状态回到 closed、下一次还能重试', async () => {
  const failingHttp = {
    createServer: () => {
      const srv = new EventEmitter();
      srv.listen = () => {
        throw new Error('监听失败');
      };
      srv.close = () => {};
      srv.address = () => null;
      return srv;
    },
  };
  const { server, logs } = harness({ httpModule: failingHttp });

  await assert.rejects(() => server.open(), /监听失败/);
  assert.equal(server.status().state, 'closed');
  assert.equal(server.status().port, 0);
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message.includes('启动失败')));

  // 失败的启动必须清掉 pending，否则后续 open() 会永远卡在"正在启动"。
  await assert.rejects(() => server.open(), /监听失败/);
});

// ---------------------------------------------------------------- 令牌与 Origin

test('令牌不对一律 404；带对的令牌才拿得到数据', async (t) => {
  const { server } = harness();
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const token = tokenOf(status.url);

  // 没有令牌 / 令牌错 / 头里令牌错：都是 404，且不解释。
  assert.equal((await request(`${base}/status`)).status, 404);
  assert.equal((await request(`${base}/status?t=${'0'.repeat(32)}`)).status, 404);
  assert.equal(
    (await request(`${base}/status`, { headers: { [TOKEN_HEADER]: 'f'.repeat(32) } })).status,
    404,
  );

  // 查询参数里的正确令牌。
  const byQuery = await request(`${base}/status?t=${token}`);
  assert.equal(byQuery.status, 200);
  assert.equal(byQuery.json().state, 'running');
  assert.equal(byQuery.headers['cache-control'], 'no-store');

  // 请求头里的正确令牌（页面之外的工具用得上）。
  const byHeader = await request(`${base}/status`, { headers: { [TOKEN_HEADER]: token } });
  assert.equal(byHeader.status, 200);

  // 令牌正确但路径不存在：仍然 404。
  assert.equal((await request(`${base}/nope?t=${token}`)).status, 404);
});

test('POST 校验 Origin：别的站点 403、缺头 403、本端口才放行', async (t) => {
  const { server } = harness();
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const heartbeat = `${base}/heartbeat?t=${tokenOf(status.url)}`;

  const crossSite = await request(heartbeat, { method: 'POST', headers: { origin: 'http://evil.example' } });
  assert.equal(crossSite.status, 403);

  const missing = await request(heartbeat, { method: 'POST' });
  assert.equal(missing.status, 403);

  const sameOrigin = await request(heartbeat, { method: 'POST', headers: { origin: base } });
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.json().state, 'running');
  assert.equal(sameOrigin.json().lastBeatMs, 0);
});

test('GET / 与 /index.html：返回 web/index.html 真页面，令牌占位符已替换', async (t) => {
  const { server } = harness();
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const token = tokenOf(status.url);

  for (const pathname of ['/', '/index.html']) {
    const page = await request(`${base}${pathname}?t=${token}`);
    assert.equal(page.status, 200, pathname);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.equal(page.headers['cache-control'], 'no-store');
    // 页面里每个资源地址都带本次令牌：静态资源无法自定义请求头，只能走查询参数。
    assert.match(page.body, new RegExp(`/app\\.js\\?t=${token}`), '模块入口带着本次令牌');
    assert.match(page.body, new RegExp(`/style\\.css\\?t=${token}`));
    assert.match(page.body, new RegExp(`/vendor/react\\.development\\.js\\?t=${token}`));
    assert.match(page.body, new RegExp(`/vendor/react-dom\\.development\\.js\\?t=${token}`));
    assert.doesNotMatch(page.body, /__TOKEN__/, '占位符必须被替换掉');
  }

  assert.equal((await request(`${base}/?t=${token}`, { method: 'POST', headers: { origin: base } })).status, 405);
  assert.equal((await request(`${base}/heartbeat?t=${token}`)).status, 405);
  assert.equal((await request(`${base}/status?t=${token}`, { method: 'POST', headers: { origin: base } })).status, 405);
});

test('页面模板读不到时降级到占位页：200 而不是 500，且占位页自己会报到', async (t) => {
  const missingWeb = path.resolve(process.cwd(), '__no_such_web_dir__');
  const { server, logs } = harness({ createOptions: { webDir: missingWeb } });
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;

  const page = await request(`${base}/?t=${tokenOf(status.url)}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /配置页尚未实现/);
  // 占位页必须自己报到，否则服务 15 秒后就没了。
  assert.match(page.body, /\/heartbeat/);
  // 降级是正常路径，不该记 warn。
  assert.equal(logs.filter((entry) => entry.level === 'warn').length, 0);
});

test('静态资源：白名单五个文件都能取到，Content-Type 与缓存头正确', async (t) => {
  const { server } = harness();
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const token = tokenOf(status.url);

  const expected = [
    ['/app.js', /^text\/javascript/],
    ['/logic.mjs', /^text\/javascript/],
    ['/style.css', /^text\/css/],
    ['/vendor/react.development.js', /^text\/javascript/],
    ['/vendor/react-dom.development.js', /^text\/javascript/],
  ];
  for (const [pathname, type] of expected) {
    const res = await request(`${base}${pathname}?t=${token}`);
    assert.equal(res.status, 200, pathname);
    assert.match(res.headers['content-type'], type, pathname);
    assert.equal(
      res.headers['cache-control'],
      'no-store, no-cache, must-revalidate',
      '按 F5 就要拿到新内容',
    );
    assert.ok(res.body.length > 0, pathname);
  }
});

test('静态资源内容取自仓库里的文件，不是服务端内联副本', async (t) => {
  const { server } = harness();
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const token = tokenOf(status.url);

  const cases = [
    ['/app.js', new URL('../web/app.js', import.meta.url)],
    ['/logic.mjs', new URL('../web/logic.mjs', import.meta.url)],
    ['/style.css', new URL('../web/style.css', import.meta.url)],
    // React 的两个 UMD 构建复用 preview/vendor/，仓库里只有这一份。
    ['/vendor/react.development.js', new URL('../preview/vendor/react.development.js', import.meta.url)],
    ['/vendor/react-dom.development.js', new URL('../preview/vendor/react-dom.development.js', import.meta.url)],
  ];
  for (const [pathname, file] of cases) {
    const onDisk = fs.readFileSync(file, 'utf8');
    const res = await request(`${base}${pathname}?t=${token}`);
    assert.equal(res.status, 200, pathname);
    assert.equal(res.body, onDisk, `${pathname} 必须与磁盘内容逐字节一致`);
  }
});

test('静态资源同样过令牌：缺令牌、错令牌一律 404', async (t) => {
  const { server } = harness();
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const token = tokenOf(status.url);

  const assets = [
    '/app.js',
    '/logic.mjs',
    '/style.css',
    '/vendor/react.development.js',
    '/vendor/react-dom.development.js',
    '/index.html',
  ];
  for (const pathname of assets) {
    assert.equal((await request(`${base}${pathname}`)).status, 404, `${pathname} 缺令牌`);
    assert.equal((await request(`${base}${pathname}?t=${'0'.repeat(32)}`)).status, 404, `${pathname} 错令牌`);
  }

  // 请求头里的正确令牌照样可用（工具与脚本走这条路）。
  const byHeader = await request(`${base}/app.js`, { headers: { [TOKEN_HEADER]: token } });
  assert.equal(byHeader.status, 200);
});

test('路径白名单：未登记的路径与目录穿越写法一律 404', async (t) => {
  const { server } = harness();
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const token = tokenOf(status.url);

  const attempts = [
    '/package.json',
    '/../package.json',
    '/web/app.js',
    '/vendor/../web/app.js',
    // 百分号编码的 `/` 与 `.` 不会被客户端规范化，能原样送到服务端。
    '/..%2fpackage.json',
    '/app.js%2f..%2f..%2fpackage.json',
    '/%2e%2e/package.json',
    '/vendor/%2e%2e/%2e%2e/package.json',
    '/nope.js',
    '/index.html/../../package.json',
    '/src/dsh/config-server.mjs',
  ];
  for (const pathname of attempts) {
    const res = await request(`${base}${pathname}?t=${token}`);
    assert.equal(res.status, 404, pathname);
  }
});

test('静态资源只接受 GET：POST 405；无令牌的 POST 仍然是 404（先令牌后方法）', async (t) => {
  const { server } = harness();
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const token = tokenOf(status.url);

  const wrongMethod = await request(`${base}/app.js?t=${token}`, {
    method: 'POST',
    headers: { origin: base },
  });
  assert.equal(wrongMethod.status, 405);

  assert.equal(
    (await request(`${base}/app.js`, { method: 'POST', headers: { origin: base } })).status,
    404,
  );
});

test('文件不存在：静态资源 404 而不是 500；页面同时降级到占位页', async (t) => {
  const missingWeb = path.resolve(process.cwd(), '__no_such_web_dir__');
  const missingVendor = path.resolve(process.cwd(), '__no_such_vendor_dir__');
  const { server } = harness({ createOptions: { webDir: missingWeb, vendorDir: missingVendor } });
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const token = tokenOf(status.url);

  for (const pathname of [
    '/app.js',
    '/logic.mjs',
    '/style.css',
    '/vendor/react.development.js',
    '/vendor/react-dom.development.js',
  ]) {
    assert.equal((await request(`${base}${pathname}?t=${token}`)).status, 404, pathname);
  }

  const page = await request(`${base}/?t=${token}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /配置页尚未实现/);
});

test('pageHtml 注入：优先于磁盘文件，且同样替换 __TOKEN__', async (t) => {
  const template = [
    '<!doctype html>',
    '<link rel="stylesheet" href="/style.css?t=__TOKEN__">',
    '<p id="probe">注入的模板</p>',
    '<script type="module" src="/app.js?t=__TOKEN__"></script>',
  ].join('');
  const { server } = harness({ createOptions: { pageHtml: template } });
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const token = tokenOf(status.url);

  for (const pathname of ['/', '/index.html']) {
    const page = await request(`${base}${pathname}?t=${token}`);
    assert.equal(page.status, 200, pathname);
    assert.match(page.body, /注入的模板/);
    assert.match(page.body, new RegExp(`/style\\.css\\?t=${token}`));
    assert.match(page.body, new RegExp(`/app\\.js\\?t=${token}`));
    assert.doesNotMatch(page.body, /__TOKEN__/);
  }
});

// ---------------------------------------------------------------- 心跳与自动关闭

test('心跳续命：报到把关闭时刻往后推，距上次心跳没超时才不关', async (t) => {
  const { server, clock } = harness();
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const heartbeat = `${base}/heartbeat?t=${tokenOf(status.url)}`;

  clock.move(10000);
  const beat = await request(heartbeat, { method: 'POST', headers: { origin: base } });
  assert.equal(beat.status, 200);

  // 用常量推导，别把秒数写死：改 IDLE_TIMEOUT_MS 不该让这条变红。
  const justUnder = IDLE_TIMEOUT_MS - 1000;
  clock.advance(justUnder);
  assert.equal(server.status().state, 'running');
  assert.equal(server.status().lastBeatMs, justUnder);

  // 越过判据 ⇒ 自己关。
  clock.advance(2000);
  assert.equal(server.status().state, 'closed');
});

test('无心跳自动关：边界是「超过判据」，不是「等于」', async (t) => {
  const { server, clock } = harness();
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const heartbeat = `${base}/heartbeat?t=${tokenOf(status.url)}`;

  await request(heartbeat, { method: 'POST', headers: { origin: base } });

  clock.advance(IDLE_TIMEOUT_MS);
  assert.equal(server.status().state, 'running', '恰好等于判据时还没超过');

  clock.advance(1);
  assert.equal(server.status().state, 'closed');
  assert.equal(server.status().url, '');
  assert.equal(server.status().port, 0);
  assert.equal(clock.state.cleared.length, 1, '心跳定时器必须被清掉');
});

test('从未有过心跳（浏览器没打开）：同样在超时后自动关', async (t) => {
  const { server, clock } = harness();
  t.after(() => server.close());
  const status = await server.open();
  assert.equal(server.status().lastBeatMs, null, '没有心跳记录时是 null（不是 0）');

  clock.advance(IDLE_TIMEOUT_MS);
  assert.equal(server.status().state, 'running');

  clock.advance(1);
  assert.equal(server.status().state, 'closed');
  assert.equal(clock.state.cleared.length, 1);
});

test('close()：幂等，可重复调；关掉之后原地址连不上', async (t) => {
  const { server, clock } = harness();
  t.after(() => server.close());
  const status = await server.open();
  const oldUrl = `${status.url.replace(/\/\?.*$/, '')}/status?t=${tokenOf(status.url)}`;

  const first = server.close();
  assert.equal(first.state, 'closed');
  const second = server.close();
  assert.equal(second.state, 'closed');
  assert.deepEqual(second, { state: 'closed', url: '', port: 0, ageMs: 0, lastBeatMs: null });
  assert.equal(clock.state.cleared.length, 1, '定时器只清一次');

  await assert.rejects(() => request(oldUrl));

  // 关掉之后还能再起一轮（新端口、新令牌）。
  const again = await server.open();
  assert.equal(again.state, 'running');
  assert.notEqual(again.url, status.url);
});

test('status() 各态：closed 归零、running 给出 ageMs、没心跳时 lastBeatMs 是 null', async (t) => {
  const { server, clock } = harness();
  t.after(() => server.close());

  assert.deepEqual(server.status(), {
    state: 'closed',
    url: '',
    port: 0,
    ageMs: 0,
    lastBeatMs: null,
  });

  const running = await server.open();
  assert.equal(running.ageMs, 0);
  assert.equal(running.lastBeatMs, null);

  clock.move(2000);
  assert.equal(server.status().ageMs, 2000);

  server.handleHeartbeat();
  assert.equal(server.status().lastBeatMs, 0);
  clock.move(1000);
  assert.equal(server.status().lastBeatMs, 1000);
  assert.equal(server.status().ageMs, 3000);
});

test('启动途中被 close()：不会留下一个"关不掉"的监听', async (t) => {
  const { server, captured } = harness();
  t.after(() => server.close());

  const opening = server.open();
  // `open()` 同步走到 `listen()` 就返回 Promise；此时关闭，启动结果必须被丢弃。
  server.close();
  const result = await opening;

  assert.equal(result.state, 'closed');
  assert.equal(server.status().state, 'closed');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].listening, false, '晚到的监听必须被关掉');

  // 还能正常再起一轮。
  const again = await server.open();
  assert.equal(again.state, 'running');
  server.close();
});

// ---------------------------------------------------------------- 打开浏览器

test('openBrowser 抛错：只记 warn，open() 照常返回可用地址', async (t) => {
  const { server, logs } = harness({ browser: 'throw' });
  t.after(() => server.close());

  const status = await server.open();
  assert.equal(status.state, 'running');
  assert.match(status.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message.includes('打开浏览器失败')));
});

test('openBrowser 返回 ok:false 或 reject：同样只记 warn', async (t) => {
  const syncFail = harness({ browser: 'false' });
  t.after(() => syncFail.server.close());
  const first = await syncFail.server.open();
  assert.equal(first.state, 'running');
  assert.ok(syncFail.logs.some((entry) => entry.level === 'warn'));

  const asyncFail = harness({ browser: 'reject' });
  t.after(() => asyncFail.server.close());
  const second = await asyncFail.server.open();
  assert.equal(second.state, 'running');
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(asyncFail.logs.some((entry) => entry.level === 'warn'));
});

test('browserCommand：Windows 用 cmd /c start，第一个参数是空的窗口标题', () => {
  const win = browserCommand('http://127.0.0.1:1234/?t=abc', 'win32');
  assert.equal(win.command, 'cmd');
  assert.deepEqual(win.args, ['/c', 'start', '', 'http://127.0.0.1:1234/?t=abc']);

  assert.deepEqual(browserCommand('http://x/', 'darwin'), { command: 'open', args: ['http://x/'] });
  assert.deepEqual(browserCommand('http://x/', 'linux'), { command: 'xdg-open', args: ['http://x/'] });
});

test('openBrowser：成功时 unref 子进程；error 事件转成 ok:false 而不抛出', async () => {
  const calls = [];
  const spawnOk = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {
      child.unrefed = true;
    };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const ok = await openBrowser('http://127.0.0.1:1234/?t=abc', { spawn: spawnOk, platform: 'win32' });
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(calls[0].options, { windowsHide: true, detached: true, stdio: 'ignore' });
  assert.deepEqual(calls[0].args, ['/c', 'start', '', 'http://127.0.0.1:1234/?t=abc']);

  const spawnError = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('error', new Error('命令不存在')));
    return child;
  };
  const failed = await openBrowser('http://127.0.0.1:1234/', { spawn: spawnError, platform: 'win32' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /命令不存在/);

  const spawnThrows = () => {
    throw new Error('参数非法');
  };
  const thrown = await openBrowser('http://127.0.0.1:1234/', { spawn: spawnThrows, platform: 'win32' });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /参数非法/);
});

// ---------------------------------------------------------------- 主 webServer 上的三条路由

test('主 webServer 路由：路径正确，open / status / close 都返回约定字段', async (t) => {
  const { server } = harness();
  t.after(() => server.close());
  const routes = createConfigServerRoutes({ configServer: server });

  assert.deepEqual(routes.map((route) => route.path), [
    `${CONFIG_SERVER_ROUTE_BASE}/open`,
    `${CONFIG_SERVER_ROUTE_BASE}/close`,
    `${CONFIG_SERVER_ROUTE_BASE}/status`,
  ]);
  for (const route of routes) assert.equal(route.kind, 'exact');

  const [openRoute, closeRoute, statusRoute] = routes;

  const opened = fakeRes();
  await openRoute.handler(fakeReq({ method: 'POST' }), opened);
  assert.equal(opened.status, 200);
  const openedBody = JSON.parse(opened.body);
  assert.equal(openedBody.ok, true);
  assert.equal(openedBody.state, 'running');
  assert.ok(openedBody.port > 0);
  assert.match(openedBody.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
  assert.equal(opened.headers['cache-control'], 'no-store');

  const polled = fakeRes();
  await statusRoute.handler(fakeReq({ method: 'GET' }), polled);
  assert.equal(polled.status, 200);
  assert.equal(JSON.parse(polled.body).state, 'running');

  const closed = fakeRes();
  await closeRoute.handler(fakeReq({ method: 'POST' }), closed);
  assert.equal(closed.status, 200);
  assert.equal(JSON.parse(closed.body).state, 'closed');
  assert.equal(server.status().state, 'closed');
});

// 路由上的可选 body：`{ openBrowser: false }` 关掉浏览器，其余一律默认开一次。
test('主 webServer 路由：open 的 body 传 openBrowser:false 时不 spawn，缺省仍开一次', async (t) => {
  const { server, browser } = harness();
  t.after(() => server.close());
  const [openRoute] = createConfigServerRoutes({ configServer: server });

  const quiet = fakeRes();
  await openRoute.handler(fakeReqWithBody('{"openBrowser":false}'), quiet);
  assert.equal(quiet.status, 200);
  const quietBody = JSON.parse(quiet.body);
  assert.equal(quietBody.state, 'running');
  assert.equal(quietBody.browserOpened, false, '响应里要告诉调用方"没开浏览器"');
  assert.deepEqual(browser.calls, [], '请求体明确要求不开浏览器');

  // 服务已经在跑：即使这次传 true，走的是复用分支，仍然不 spawn。
  const reused = fakeRes();
  await openRoute.handler(fakeReqWithBody('{"openBrowser":true}'), reused);
  assert.equal(reused.status, 200);
  assert.equal(JSON.parse(reused.body).browserOpened, false);
  assert.deepEqual(browser.calls, [], '复用分支不 spawn');

  // 空对象 = 字段缺省 = 默认值 true：关掉之后重新起会开一次。
  server.close();
  const defaults = fakeRes();
  await openRoute.handler(fakeReqWithBody('{}'), defaults);
  assert.equal(defaults.status, 200);
  assert.equal(JSON.parse(defaults.body).browserOpened, true);
  assert.equal(browser.calls.length, 1, '缺省语义是"开一次"');
});

test('主 webServer 路由：坏 JSON / 非布尔值一律回落成默认值 true', async (t) => {
  const { server, browser } = harness();
  t.after(() => server.close());
  const [openRoute] = createConfigServerRoutes({ configServer: server });

  const brokenJson = fakeRes();
  await openRoute.handler(fakeReqWithBody('{not json'), brokenJson);
  assert.equal(brokenJson.status, 200, '坏 JSON 不是 400：路由仍按默认值工作');
  assert.equal(browser.calls.length, 1);

  server.close();
  const wrongType = fakeRes();
  await openRoute.handler(fakeReqWithBody('{"openBrowser":"no"}'), wrongType);
  assert.equal(wrongType.status, 200);
  assert.equal(browser.calls.length, 2, '只有布尔 false 才关浏览器');
});

test('主 webServer 路由：方法不对 405；服务内部抛错变 500 而不是冒到宿主', async () => {
  const broken = {
    open: async () => {
      throw new Error('起不来');
    },
    close: () => {
      throw new Error('关不掉');
    },
    status: () => {
      throw new Error('读不到');
    },
  };
  const routes = createConfigServerRoutes({ configServer: broken });
  const [openRoute, closeRoute, statusRoute] = routes;

  const wrongMethod = fakeRes();
  await openRoute.handler(fakeReq({ method: 'GET' }), wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const openFailed = fakeRes();
  await openRoute.handler(fakeReq({ method: 'POST' }), openFailed);
  assert.equal(openFailed.status, 500);
  assert.equal(JSON.parse(openFailed.body).ok, false);
  assert.match(JSON.parse(openFailed.body).error, /起不来/);

  const closeFailed = fakeRes();
  await closeRoute.handler(fakeReq({ method: 'POST' }), closeFailed);
  assert.equal(closeFailed.status, 500);

  const statusFailed = fakeRes();
  await statusRoute.handler(fakeReq({ method: 'POST' }), statusFailed);
  assert.equal(statusFailed.status, 405);

  const statusBroken = fakeRes();
  await statusRoute.handler(fakeReq({ method: 'GET' }), statusBroken);
  assert.equal(statusBroken.status, 500);
});

// ---------------------------------------------------------------- 转发到主 webServer

test('转发路由同样先过令牌：缺令牌 / 错令牌一律 404（GET 与 POST 都不转发）', async (t) => {
  const { server } = harness({ createOptions: { upstream: 'http://127.0.0.1:1' } });
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const wrongToken = '0'.repeat(32);

  // 前缀就是这个，页面里的两条配置路由都落在里面。
  assert.equal(FORWARD_PREFIX, '/dsh-qq-proactive/');

  for (const pathname of ['/dsh-qq-proactive/settings', '/dsh-qq-proactive/config']) {
    assert.ok(pathname.startsWith(FORWARD_PREFIX), `${pathname} 应当在转发前缀下`);
    assert.equal((await request(`${base}${pathname}`)).status, 404, `${pathname} 缺令牌`);
    assert.equal(
      (await request(`${base}${pathname}?t=${wrongToken}`)).status, 404,
      `${pathname} 错令牌`,
    );
    // 无令牌的 POST 也必须是 404：令牌在 Origin 之前，不泄露"这里有个东西"。
    assert.equal(
      (await request(`${base}${pathname}`, { method: 'POST', headers: { origin: base } })).status,
      404,
      `${pathname} 无令牌的 POST`,
    );
  }

  // 令牌对但 Origin 不对：403，同样不会转发出去。
  const crossSite = await request(`${base}/dsh-qq-proactive/config?t=${tokenOf(status.url)}`, {
    method: 'POST',
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(crossSite.status, 403);
});

test('转发：上游可达时状态码 / content-type / 响应体原样回来，请求体与 content-type 原样过去', async (t) => {
  const upstream = await startUpstream({
    status: 418,
    type: 'application/vnd.qq.probe+json; charset=utf-8',
    body: '{"probe":"上游原文"}',
  });
  t.after(() => upstream.close());
  const { server } = harness({ createOptions: { upstream: () => upstream.origin } });
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const token = tokenOf(status.url);

  // GET：带着查询串过去，响应照原样回来。
  const got = await request(`${base}/dsh-qq-proactive/settings?t=${token}`);
  assert.equal(got.status, 418, '状态码不能改成 200');
  assert.equal(got.headers['content-type'], 'application/vnd.qq.probe+json; charset=utf-8');
  assert.equal(got.body, '{"probe":"上游原文"}', '响应体逐字节原样');
  assert.equal(got.headers['cache-control'], 'no-store');
  assert.deepEqual(upstream.seen[0], {
    method: 'GET',
    url: `/dsh-qq-proactive/settings?t=${token}`,
    type: '',
    length: '',
    body: '',
  });

  // POST：请求体与 content-type 原样过去（配置页就是用 JSON 写入的）。
  const payload = JSON.stringify({ scope: 'channel', key: 'name', value: '小鲸鱼' });
  const posted = await request(`${base}/dsh-qq-proactive/config?t=${token}`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: payload,
  });
  assert.equal(posted.status, 418);
  assert.equal(posted.body, '{"probe":"上游原文"}');
  assert.equal(upstream.seen[1].method, 'POST');
  assert.equal(upstream.seen[1].url, `/dsh-qq-proactive/config?t=${token}`);
  assert.equal(upstream.seen[1].type, 'application/json');
  assert.equal(upstream.seen[1].body, payload);
  assert.equal(upstream.seen[1].length, String(Buffer.byteLength(payload)));
});

test('转发：上游不可达（没有地址 / 端口没人听）⇒ 502 + JSON，不抛且服务照常', async (t) => {
  // ① 上游地址拿不到（webServer 没注入，或端口还没绑定）。
  const missing = harness({ createOptions: { upstream: '' } });
  t.after(() => missing.server.close());
  const missingStatus = await missing.server.open();
  const missingBase = `http://127.0.0.1:${missingStatus.port}`;
  const missingToken = tokenOf(missingStatus.url);

  const unaddressed = await request(`${missingBase}/dsh-qq-proactive/settings?t=${missingToken}`);
  assert.equal(unaddressed.status, 502);
  assert.equal(unaddressed.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(unaddressed.json().ok, false);
  assert.match(unaddressed.json().error, /地址未知/);
  assert.ok(
    missing.logs.some((entry) => entry.level === 'warn' && entry.message.includes('主 webServer 的地址')),
    '拿不到地址要记一条 warn',
  );
  // 一次失败不能把服务弄死：同一个临时服务仍然回答其它路由。
  assert.equal((await request(`${missingBase}/status?t=${missingToken}`)).status, 200);

  // ② 上游地址有了，但端口没人听（先占一个端口再关掉，保证它当时确实是空的）。
  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const refused = harness({ createOptions: { upstream: `http://127.0.0.1:${deadPort}` } });
  t.after(() => refused.server.close());
  const refusedStatus = await refused.server.open();
  const refusedBase = `http://127.0.0.1:${refusedStatus.port}`;
  const refusedToken = tokenOf(refusedStatus.url);

  const failed = await request(`${refusedBase}/dsh-qq-proactive/settings?t=${refusedToken}`);
  assert.equal(failed.status, 502);
  assert.equal(failed.json().ok, false);
  assert.match(failed.json().error, /转发到主服务器失败/);
  assert.ok(refused.logs.some((entry) => entry.level === 'warn' && entry.message.includes('转发到主服务器失败')));
  assert.equal((await request(`${refusedBase}/status?t=${refusedToken}`)).status, 200);
});

test('转发：上游超时 ⇒ 502（注入假上游，不真等 10 秒）', async (t) => {
  const calls = [];
  const neverAnswers = (target, options) => {
    calls.push({ target, options });
    return new Promise(() => {});
  };
  const { server, logs } = harness({
    createOptions: {
      upstream: 'http://127.0.0.1:9',
      upstreamTimeoutMs: 25,
      requestUpstream: neverAnswers,
    },
  });
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;
  const token = tokenOf(status.url);

  const timedOut = await request(`${base}/dsh-qq-proactive/settings?t=${token}`);
  assert.equal(timedOut.status, 502);
  assert.equal(timedOut.json().ok, false);
  assert.match(timedOut.json().error, /超时/);
  assert.equal(calls.length, 1, '假上游被调用一次');
  // 查询串（含令牌）按原样带过去：本服务不解释主服务器的参数，改写只会制造差异。
  assert.equal(calls[0].target, `http://127.0.0.1:9/dsh-qq-proactive/settings?t=${token}`);
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message.includes('转发到主服务器失败')));

  // 超时之后服务仍然可用。
  assert.equal((await request(`${base}/status?t=${token}`)).status, 200);
});

test('转发只接受 GET 或 POST：其它方法 405，且不会去碰上游', async (t) => {
  const calls = [];
  const { server } = harness({
    createOptions: {
      upstream: 'http://127.0.0.1:9',
      requestUpstream: (target, options) => {
        calls.push({ target, options });
        return Promise.resolve({ status: 200, contentType: 'application/json', body: Buffer.from('{}') });
      },
    },
  });
  t.after(() => server.close());
  const status = await server.open();
  const base = `http://127.0.0.1:${status.port}`;

  const got = await request(`${base}/dsh-qq-proactive/settings?t=${tokenOf(status.url)}`, {
    method: 'PUT',
  });
  assert.equal(got.status, 405);
  assert.equal(got.json().ok, false);
  assert.equal(calls.length, 0, '方法不对时不该转发');

  // 前缀之外的同名路径不受影响：仍然 404（不是被当成转发的子路径）。
  assert.equal((await request(`${base}/dsh-qq-proactive?t=${tokenOf(status.url)}`)).status, 404);
});

test('resolveWebServerOrigin：优先 origin，绑定前退到 port + host，取不到就是空串', () => {
  assert.equal(resolveWebServerOrigin({ origin: 'http://127.0.0.1:61482' }), 'http://127.0.0.1:61482');

  // 主服务器在绑定端口之前读 origin 会抛（源码里明确如此），此时用同样真实的两字段拼。
  const beforeListen = {
    get origin() {
      throw new Error('webserver: origin read before the listener bound a port');
    },
    port: 61482,
    protocol: 'http:',
    config: { host: '127.0.0.1' },
  };
  assert.equal(resolveWebServerOrigin(beforeListen), 'http://127.0.0.1:61482');
  assert.equal(
    resolveWebServerOrigin({ origin: '', port: 7000, protocol: 'http:', config: { host: '::1' } }),
    'http://[::1]:7000',
    'IPv6 字面量要加方括号',
  );

  // 拿不到就返回空串：调用方据此回 502，绝不猜端口。
  assert.equal(resolveWebServerOrigin(null), '');
  assert.equal(resolveWebServerOrigin(undefined), '');
  assert.equal(resolveWebServerOrigin({}), '');
  assert.equal(resolveWebServerOrigin({ origin: '', port: 0 }), '');
  assert.equal(
    resolveWebServerOrigin({
      get origin() {
        throw new Error('boom');
      },
      get port() {
        throw new Error('boom');
      },
    }),
    '',
    'getter 抛异常也不能冒出去',
  );
});

// ------------------------------------------- 跨插件重载：固定端口 + 令牌复用
//
// 这一组钉的是「插件重载后配置页能原地接回」的两个必要条件：
// **端口稳定** 与 **令牌稳定**。只做前者不够 —— 同端口 + 新令牌仍然是 404，
// 页面那层 1.5 秒轮询照样在 30 秒后放弃。
//
// 「重载」在测试里的等价物 = 丢掉第一个 `createConfigServer` 实例、再建一个新的，
// 两者之间只共享磁盘上的状态文件（内存全空）。这正是 HMR dispose → apply 的形状。

/** 一个用完即删的状态文件路径（放测试目录下，避开受限沙箱里 `%TEMP%` 的 EPERM）。 */
function stateFileFor(t) {
  const dir = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp-config-state-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清不掉不影响结论 */
    }
  });
  return path.join(dir, 'qq-config-page.json');
}

/** 借一个当前空闲的回环端口（绑一下、读出来、再放掉）。 */
async function freePort() {
  const srv = http.createServer(() => {});
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

test('★ 重载后原地接回：同一状态文件 ⇒ 绑回同一端口、复用同一令牌', async (t) => {
  const stateFile = stateFileFor(t);
  const wantedPort = await freePort();

  // 第一个实例：绑固定端口，把 {port, token} 写进状态文件。
  const before = harness({ createOptions: { stateFile, preferredPort: wantedPort } });
  t.after(() => before.server.close());
  const first = await before.server.open({ openBrowser: false });
  assert.equal(first.port, wantedPort, '配置里的固定端口就是实际绑定的端口');
  const firstToken = tokenOf(first.url);
  before.server.close();

  // 模拟热重载：新实例、内存全空，只有磁盘上的状态文件是共享的。
  const after = harness({ createOptions: { stateFile, preferredPort: wantedPort } });
  t.after(() => after.server.close());
  const second = await after.server.open({ openBrowser: false });

  assert.equal(second.port, first.port, '端口必须跨重载稳定（页面指着旧 origin）');
  assert.equal(
    tokenOf(second.url),
    firstToken,
    '令牌必须跨重载稳定 —— 否则同一个端口也会 404，页面照样接不回来',
  );
  // 旧页面手里那个地址（旧端口 + 旧令牌）应当仍然能过门。
  const got = await request(`http://127.0.0.1:${second.port}/status?t=${firstToken}`);
  assert.equal(got.status, 200, '旧地址接回后应立刻可用');
  assert.equal(got.json().port, second.port);
  // 服务只为回环服务：绑定的地址就是 127.0.0.1（不是 0.0.0.0）。
  assert.ok(after.captured.length >= 1);
  assert.equal(after.captured.at(-1).address().address, '127.0.0.1');
});

test('固定端口被占：先重试，仍失败才回退随机端口 + warn 说明"页面需要重新打开"', async (t) => {
  const stateFile = stateFileFor(t);
  const blocker = http.createServer(() => {});
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupied = blocker.address().port;
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const { server, logs } = harness({ createOptions: { stateFile, preferredPort: occupied } });
  t.after(() => server.close());
  const status = await server.open({ openBrowser: false });

  assert.equal(status.state, 'running', '端口被占不能把服务弄起不来');
  assert.notEqual(status.port, occupied, '被占的端口上起不来，必须换一个');
  assert.ok(status.port > 0);

  const warns = logs.filter((entry) => entry.level === 'warn');
  assert.ok(
    warns.some((entry) => String(entry.message).includes('被占用')),
    '要有一条 warn 说清楚"上次的端口被占了"',
  );
  assert.ok(
    warns.some((entry) => String(entry.message).includes('配置页需要重新打开')),
    'warn 必须告诉用户页面已经接不回来了',
  );

  // 回退后的端口/令牌也要写回：下一次重载就稳定在新端口上。
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.port, status.port);
  assert.equal(saved.token, tokenOf(status.url));
});

test('没有状态文件：随机端口 + 新令牌，并写出 {port, token}（POSIX 上 0600）', async (t) => {
  const stateFile = stateFileFor(t);
  assert.equal(fs.existsSync(stateFile), false);

  const { server } = harness({ createOptions: { stateFile, preferredPort: 0 } });
  t.after(() => server.close());
  const status = await server.open({ openBrowser: false });

  assert.ok(status.port > 0, '没有偏好端口时由系统分配');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['port', 'token']);
  assert.equal(saved.port, status.port);
  assert.match(saved.token, /^[0-9a-f]{32}$/);
  assert.equal(saved.token, tokenOf(status.url));

  if (process.platform !== 'win32') {
    // POSIX 上收紧到"只有本用户可读"；Windows 的 mode 不产生 ACL 效果，跳过。
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  }
});

test('状态文件坏了：按"没有记录"处理（随机端口 + 新令牌），并把文件修好', async (t) => {
  const stateFile = stateFileFor(t);
  fs.writeFileSync(stateFile, '{ 这不是 JSON', 'utf8');

  const { server, logs } = harness({ createOptions: { stateFile, preferredPort: 0 } });
  t.after(() => server.close());
  const status = await server.open({ openBrowser: false });

  assert.ok(status.port > 0);
  assert.ok(
    logs.some((entry) => entry.level === 'debug' && String(entry.message).includes('不是合法 JSON')),
    '坏文件只记 debug，不刷 warn',
  );
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.port, status.port);
  assert.equal(saved.token, tokenOf(status.url));
});

test('绑到的端口与上次记录不同 ⇒ 不复用旧令牌（旧页面已经指着别的 origin 了）', async (t) => {
  const stateFile = stateFileFor(t);
  const oldPort = await freePort();
  const newPort = await freePort();
  assert.notEqual(oldPort, newPort);
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ port: oldPort, token: 'a'.repeat(32) }),
    'utf8',
  );

  const { server } = harness({ createOptions: { stateFile, preferredPort: newPort } });
  t.after(() => server.close());
  const status = await server.open({ openBrowser: false });

  assert.equal(status.port, newPort);
  assert.notEqual(tokenOf(status.url), 'a'.repeat(32), '换了端口就没有"接回"可言，令牌应当重生');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.port, newPort);
  assert.equal(saved.token, tokenOf(status.url));
});

test('状态文件写不进去：只记 debug，服务照常起来（持久化是优化，不是前提）', async (t) => {
  const stateFile = stateFileFor(t);
  const failingFs = {
    readFileSync: fs.readFileSync,
    writeFileSync: () => {
      const error = new Error('disk full');
      error.code = 'ENOSPC';
      throw error;
    },
    renameSync: fs.renameSync,
    mkdirSync: fs.mkdirSync,
    rmSync: fs.rmSync,
    chmodSync: fs.chmodSync,
  };

  const { server, logs } = harness({
    createOptions: { stateFile, preferredPort: 0, fsImpl: failingFs },
  });
  t.after(() => server.close());
  const status = await server.open({ openBrowser: false });

  assert.equal(status.state, 'running', '写不进去也必须能起来');
  assert.ok(status.port > 0);
  assert.equal(logs.filter((entry) => entry.level === 'warn').length, 0, '不该刷 warn');
  assert.ok(
    logs.some((entry) => entry.level === 'debug' && String(entry.message).includes('写入配置页状态文件失败')),
  );
});

test('defaultConfigPageStatePath：落在 <DSH_HOME>/media/qq-config-page.json，没 DSH_HOME 时为空串', () => {
  assert.equal(
    defaultConfigPageStatePath({ DSH_HOME: '<DSH_HOME>' }),
    path.join('<DSH_HOME>', 'media', 'qq-config-page.json'),
  );
  assert.equal(defaultConfigPageStatePath({}), '');
  assert.equal(defaultConfigPageStatePath({ DSH_HOME: '   ' }), '');
});

