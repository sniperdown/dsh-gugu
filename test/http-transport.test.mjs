/**
 * HTTP 传输层测试（P3 方案）。
 *
 * 这一层存在的理由是**与 `dsh-onebot-qq` 共存**：那个插件在反向 WS 模式下要
 * 独占监听端口（NapCat 只拨一条连接，且它的实现是 last-wins）。
 * 所以本项目不能再抢那个端口，改走 NapCat 的另一条通道（HTTP API）。
 *
 * 重点钉住两条：
 * 1. **平铺格式** —— 字段必须在顶层，不能包 `params`
 *    （NapCat 4.18.28 的 handler 把整个请求体当参数用；包装会被拒）
 * 2. HTTP 模式**只发不收**，`isReady` 不能沿用需要 WS 连接的基类实现
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { HttpTransport, createTransport } from '../src/onebot/transport.mjs';

/**
 * 起一个假的 NapCat HTTP API。
 * @param {(action:string, body:any)=>any} handler 返回 data，或 {__reject}/{__status}
 */
async function startFakeHttpApi(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      const action = String(req.url ?? '/').replace(/^\//, '');
      received.push({ action, body, headers: req.headers });
      const out = handler?.(action, body);
      if (out !== undefined && typeof out === 'object' && out.__status !== undefined) {
        res.writeHead(out.__status, { 'content-type': 'text/plain' });
        res.end('nope');
        return;
      }
      const data = out !== undefined ? out : action === 'get_login_info' ? { user_id: 999, nickname: 'x' } : { message_id: 4242 };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    received,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------------------------------------------------------------- 工厂

test('createTransport：mode=http 返回 HttpTransport', () => {
  const t = createTransport({ mode: 'http', httpUrl: 'http://127.0.0.1:3000' });
  assert.ok(t instanceof HttpTransport);
});

test('createTransport：mode=http 缺 httpUrl 立刻抛错', () => {
  assert.throws(() => createTransport({ mode: 'http' }), /必须配置 httpUrl/);
});

test('HttpTransport：默认仍是 reverse（不破坏既有行为）', () => {
  const t = createTransport({ mode: 'reverse', accessToken: 't' });
  assert.equal(t.constructor.name, 'ReverseTransport');
});

// ---------------------------------------------------------------- 平铺格式

test('action：字段平铺在顶层，绝不出现 params 包装', async () => {
  // 这是本文件存在的核心原因。曾经写成 {action, params} 被 NapCat 全量拒绝。
  const api = await startFakeHttpApi();
  const t = new HttpTransport({ httpUrl: api.url, accessToken: 'tk' });
  await t.start();

  await t.sendToChat('group:100', 'hi');

  const last = api.received.at(-1);
  assert.equal(last.action, 'send_msg');
  assert.equal(last.body.action, 'send_msg');
  assert.equal(last.body.group_id, 100, 'group_id 应在顶层');
  assert.equal(last.body.message, 'hi');
  assert.equal(last.body.params, undefined, '不能有 params 包装');
  assert.equal(typeof last.body.echo, 'string', '要有 echo 便于关联');

  await t.stop();
  await api.close();
});

test('action：群聊只带 group_id，私聊只带 user_id（避免歧义）', async () => {
  const api = await startFakeHttpApi();
  const t = new HttpTransport({ httpUrl: api.url, accessToken: 'tk' });
  await t.start();

  await t.sendToChat('group:100', 'g');
  assert.equal(api.received.at(-1).body.group_id, 100);
  assert.equal(api.received.at(-1).body.user_id, undefined);

  await t.sendToChat('private:200', 'p');
  assert.equal(api.received.at(-1).body.user_id, 200);
  assert.equal(api.received.at(-1).body.group_id, undefined);

  await t.stop();
  await api.close();
});

test('action：统一走 send_msg（不用 send_group_msg 别名）', async () => {
  const api = await startFakeHttpApi();
  const t = new HttpTransport({ httpUrl: api.url, accessToken: 'tk' });
  await t.start();

  await t.sendGroupMsg('100', 'x');
  await t.sendPrivateMsg('200', 'y');
  const actions = api.received.map((r) => r.action);
  assert.deepEqual(actions.filter((a) => a.startsWith('send_')), ['send_msg', 'send_msg']);

  await t.stop();
  await api.close();
});

// ---------------------------------------------------------------- 鉴权与就绪

test('start：探活成功才置为就绪，并学到 selfId', async () => {
  const api = await startFakeHttpApi(() => ({ user_id: 12345, nickname: 'bot' }));
  const t = new HttpTransport({ httpUrl: api.url, accessToken: 'tk' });
  assert.equal(t.isReady, false, 'start 之前不就绪');

  await t.start();
  assert.equal(t.isReady, true, 'HTTP 模式没有 WS 连接，isReady 不能依赖 connection');
  assert.equal(t.selfId, '12345', '应从 get_login_info 学到 selfId');

  await t.stop();
  assert.equal(t.isReady, false, 'stop 之后不就绪');
  await api.close();
});

test('start：探活失败时抛出，不谎报就绪', async () => {
  const api = await startFakeHttpApi(() => ({ __status: 500 }));
  const t = new HttpTransport({ httpUrl: api.url, accessToken: 'tk' });
  await assert.rejects(() => t.start(), /500/);
  assert.equal(t.isReady, false);
  await api.close();
});

test('携带 accessToken 时用 Bearer 头发出去', async () => {
  const api = await startFakeHttpApi();
  const t = new HttpTransport({ httpUrl: api.url, accessToken: 'secret-token' });
  await t.start();
  assert.equal(api.received[0].headers.authorization, 'Bearer secret-token');
  await t.stop();
  await api.close();
});

test('不带 accessToken 时不发 Authorization 头', async () => {
  const api = await startFakeHttpApi();
  const t = new HttpTransport({ httpUrl: api.url, accessToken: '' });
  await t.start();
  assert.equal(api.received[0].headers.authorization, undefined);
  await t.stop();
  await api.close();
});

// ---------------------------------------------------------------- 错误信封

test('action：status=failed 时 reject 并透传 message', async () => {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const action = String(req.url ?? '/').replace(/^\//, '');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (action === 'send_msg') {
        res.end(JSON.stringify({ status: 'failed', retcode: 200, message: '请指定正确的 group_id 或 user_id' }));
        return;
      }
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 1 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t = new HttpTransport({ httpUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 't' });
  await t.start();

  await assert.rejects(() => t.sendToChat('group:1', 'x'), (e) => {
    assert.match(e.message, /请指定正确的 group_id 或 user_id/);
    return true;
  });

  await t.stop();
  await new Promise((r) => server.close(r));
});

test('action：retcode 非 0 也视为失败', async () => {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const action = String(req.url ?? '/').replace(/^\//, '');
      if (action === 'get_login_info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 1 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 1404, message: 'bad' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t = new HttpTransport({ httpUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 't' });
  await t.start();
  await assert.rejects(() => t.sendToChat('private:1', 'x'), /失败/);
  await t.stop();
  await new Promise((r) => server.close(r));
});

test('action：非 JSON 应答给出可读错误', async () => {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const action = String(req.url ?? '/').replace(/^\//, '');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (action === 'get_login_info') {
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 1 } }));
        return;
      }
      res.end('<html>not json</html>');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t = new HttpTransport({ httpUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 't' });
  await t.start();
  await assert.rejects(() => t.sendToChat('private:1', 'x'), /不是 JSON/);
  await t.stop();
  await new Promise((r) => server.close(r));
});

test('action：超时被 abort 并给出可读错误', async () => {
  const server = http.createServer(() => { /* 永不回应 */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const t = new HttpTransport({ httpUrl: `http://127.0.0.1:${port}`, accessToken: 't', actionTimeoutMs: 300 });
  await assert.rejects(() => t.action('anything'), /超时/);
  await t.stop();
  await new Promise((r) => server.close(r));
});

test('action：地址不可达时报出请求失败', async () => {
  // 用一个几乎不可能被占用的端口
  const t = new HttpTransport({ httpUrl: 'http://127.0.0.1:1', accessToken: 't', actionTimeoutMs: 2000 });
  await assert.rejects(() => t.action('get_login_info'), /请求失败/);
});
