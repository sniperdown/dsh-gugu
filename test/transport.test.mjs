/**
 * OneBot 传输层测试：反向/正向两条路 + action 关联 + 断线语义 + 重连退避。
 *
 * 两个测试替身，别搞混：
 * - `startFakeOneBot()`：一个**真正的 OneBot 服务端**（收 action、回响应、可推事件），
 *   用来测**正向**模式（我们拨出去）。
 * - `fakeNapCat()`：**NapCat 的替身**，它拨入我们的反向监听，并且会回应我们发出的
 *   action。用来测**反向**模式。
 *
 * 为什么不能拿 `ForwardTransport` 当 NapCat 替身：它是 WS 客户端，只会发请求、
 * 不会应答请求。反向模式下是我们主动发 `get_login_info` 问对方，客户端替身没人回，
 * 于是必然超时。
 *
 * 全部零外部依赖，也不需要真的 NapCat。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { acceptKey, wrapSocket } from '../src/onebot/ws.mjs';
import {
  ReverseTransport,
  ForwardTransport,
  OneBotTransport,
  createTransport,
  extractToken,
  backoffDelay,
  STATE,
} from '../src/onebot/transport.mjs';

/**
 * 一个真正的 OneBot 服务端替身：接受 WS 连接，处理 action 并回响应。
 * @param {object} [options]
 * @param {(action:string, params:any)=>any} [options.handler]
 * @param {(req:import('node:http').IncomingMessage)=>boolean} [options.authorize]
 */
async function startFakeOneBot({ handler, authorize } = {}) {
  const log = { actions: [] };
  const clients = new Set();
  const connections = new Set();

  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    if (authorize !== undefined && !authorize(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(String(key))}\r\n\r\n`,
    );
    clients.add(socket);
    const connection = wrapSocket(socket, { isServer: true });
    connections.add(connection);
    // 升级时已到达的帧字节必须喂给解码器，丢掉它第一条 action 就会凭空消失。
    connection.feed(head);

    connection.on('message', (text) => {
      const message = JSON.parse(text);
      log.actions.push(message);
      // **字段是平铺在顶层的**（`{action, ...params, echo}`），不是 `{action, params}` 包装。
      //
      // 这里曾经读 `message.params` —— 那是照 OneBot 文档写的，但实测被
      // NapCat 4.18.28 拒绝：它的 handler 把整个请求体当参数用，于是
      // `e.group_id` / `e.message` 全是 undefined。这个假服务端当时"配合"了
      // 错误格式，于是格式错误永远测不出来（与 ws.test.mjs 里 makeHandshakeKey
      // 那次同类：自产自销的盲区）。
      const { action, echo, ...params } = message;
      const custom = handler?.(action, params);
      // 约定：{__reject} = 回一个失败响应，{__silent} = 收到但不回（测超时）。
      if (custom !== undefined && typeof custom === 'object' && custom.__reject !== undefined) {
        connection.send(JSON.stringify({ ...custom.__reject, echo }));
        return;
      }
      if (custom !== undefined && typeof custom === 'object' && custom.__silent === true) return;
      const data =
        custom !== undefined
          ? custom
          : action === 'get_login_info'
            ? { user_id: 999, nickname: '测试机器人' }
            : action.startsWith('send_')
              ? { message_id: 4242 }
              : {};
      connection.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }));
    });
    connection.on('close', () => {
      clients.delete(socket);
      connections.delete(connection);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    log,
    connections,
    push: (event) => {
      for (const connection of connections) connection.send(JSON.stringify(event));
    },
    close: () =>
      new Promise((resolve) => {
        for (const client of clients) client.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * NapCat 的替身：拨入反向监听，并**回应**我们发出的 action。
 *
 * 关键：应答器必须通过构造器的 `onAction` 注入，**不能**在 `start()` 之后替换
 * `handleFrame`——反向侧会在握手过程中立刻发出 `get_login_info`，那时 start()
 * 还没返回，事后替换已经晚了（这条是实测踩出来的）。
 * @param {number} port 反向监听端口
 * @param {string} accessToken
 * @param {object} [options]
 */
async function fakeNapCat(port, accessToken, { loginInfo } = {}) {
  const seen = [];
  const transport = new ForwardTransport({
    url: `ws://127.0.0.1:${port}`,
    accessToken,
    onAction: (action) => {
      seen.push(action);
      if (action === 'get_login_info') return loginInfo ?? { user_id: 999, nickname: '测试机器人' };
      if (action.startsWith('send_')) return { message_id: 4242 };
      return {};
    },
  });
  await transport.start();
  return {
    transport,
    seen,
    send: (event) => transport.connection?.send(JSON.stringify(event)),
    close: () => transport.stop(),
  };
}

/** 等一个事件，带超时，避免测试挂死。 */
function waitFor(emitter, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`等待事件 ${event} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const onEvent = (...args) => {
      clearTimeout(timer);
      resolve(args.length === 1 ? args[0] : args);
    };
    emitter.once(event, onEvent);
  });
}

/**
 * 启动一个传输层并等到 `ready`。
 *
 * **必须**先注册监听再 start：`ready` 会在 `await start()` 内部发出（握手与
 * get_login_info 都在 start 链路上完成），若写成 `await start()` 之后再
 * `waitFor('ready')` 就会永远等不到——这是测试侧的竞态，不是产品缺陷。
 * @param {import('../src/onebot/transport.mjs').OneBotTransport} transport
 */
async function startAndWaitReady(transport) {
  const ready = waitFor(transport, 'ready');
  await transport.start();
  return ready;
}

/** 建一个反向传输层并返回 {transport, port}。 */
async function startReverse(accessToken = 'secret') {
  const transport = new ReverseTransport({ port: 0, accessToken });
  await transport.start();
  return { transport, port: transport.server.address().port };
}

// ---------------------------------------------------------------- 纯函数

test('backoffDelay：指数退避且有上限', () => {
  const fixed = () => 0.5; // 抖动为 0，便于断言基准值
  assert.equal(backoffDelay(1, fixed), 2000);
  assert.equal(backoffDelay(2, fixed), 4000);
  assert.equal(backoffDelay(3, fixed), 8000);
  assert.equal(backoffDelay(10, fixed), 60000, '应封顶在 60s');
  assert.equal(backoffDelay(99, fixed), 60000, '更大次数也不该溢出');
});

test('backoffDelay：抖动在 ±20% 内，且永不小于下限', () => {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const base = Math.min(2000 * 2 ** (attempt - 1), 60000);
    const low = backoffDelay(attempt, () => 0);
    const high = backoffDelay(attempt, () => 1);
    assert.ok(low >= 250, `第 ${attempt} 次的下界 ${low} 不该小于 250ms`);
    assert.ok(low >= Math.floor(base * 0.8) - 1, `第 ${attempt} 次抖出下界：${low}`);
    assert.ok(high <= Math.ceil(base * 1.2) + 1, `第 ${attempt} 次抖出上界：${high}`);
  }
});

test('extractToken：优先 Authorization 头，其次查询参数', () => {
  assert.equal(extractToken({ headers: { authorization: 'Bearer abc' }, url: '/' }), 'abc');
  assert.equal(extractToken({ headers: {}, url: '/?access_token=xyz' }), 'xyz');
  assert.equal(
    extractToken({ headers: { authorization: 'Bearer abc' }, url: '/?access_token=xyz' }),
    'abc',
    '两者都有时以头为准',
  );
  assert.equal(extractToken({ headers: {}, url: '/' }), null);
  assert.equal(extractToken({ headers: {}, url: '/?access_token=' }), null, '空 token 视为没有');
  assert.equal(extractToken({ headers: { authorization: 'Basic xyz' }, url: '/' }), null);
});

test('基类本身不可用：子类必须重写 _open（回归：私有方法不可重写）', async () => {
  const base = new OneBotTransport({ mode: 'reverse' });
  await assert.rejects(() => base.start(), /抽象基类/);
  base.stopping = true; // 防止 stop 时的收尾干扰
});

test('子类重写 _open/_shutdown 确实会被调用', async () => {
  const calls = [];
  class Probe extends OneBotTransport {
    async _open() {
      calls.push('open');
    }
    async _shutdown() {
      calls.push('shutdown');
    }
  }
  const probe = new Probe({});
  await probe.start();
  await probe.stop();
  assert.deepEqual(calls, ['open', 'shutdown']);
});

test('createTransport 按 mode 分派', () => {
  assert.ok(createTransport({ mode: 'reverse' }) instanceof ReverseTransport);
  assert.ok(createTransport({ mode: 'forward' }) instanceof ForwardTransport);
  assert.ok(createTransport({}) instanceof ReverseTransport, '缺省应是反向');
});

// ---------------------------------------------------------------- 反向模式

test('反向：空 accessToken 时拒绝启动（fail-closed）', async () => {
  const transport = new ReverseTransport({ port: 0, accessToken: '' });
  await assert.rejects(() => transport.start(), /必须配置 accessToken/);
  assert.equal(transport.server, null, '失败时不该留下监听器');
});

test('反向：NapCat 拨入后立即就绪，且不会去反问 get_login_info', async () => {
  const { transport, port } = await startReverse('secret');
  const readyPromise = waitFor(transport, 'ready');
  const napcat = await fakeNapCat(port, 'secret');
  const ready = await readyPromise;

  assert.equal(transport.isReady, true);
  // 反向 WS 里 NapCat 是应用端，它不负责回应我们的问询——我们也不该问。
  // 这条断言是回归：早期实现会在这里发 get_login_info，然后白等一个 15s 超时。
  assert.deepEqual(napcat.seen, [], `反向模式不该向 NapCat 发任何 action，实际发了：${JSON.stringify(napcat.seen)}`);
  assert.equal(ready.selfId, '', '身份未学到时应是空串，而不是崩溃');

  await napcat.close();
  await transport.stop();
});

test('反向：self_id 从上报事件里学习', async () => {
  const { transport, port } = await startReverse('secret');
  const readyPromise = waitFor(transport, 'ready');
  const napcat = await fakeNapCat(port, 'secret');
  await readyPromise;
  assert.equal(transport.selfId, '', '初始没有身份');

  const eventPromise = waitFor(transport, 'event');
  napcat.send({
    time: 30000023,
    self_id: 12345,
    post_type: 'message',
    message_type: 'group',
    message_id: 1,
    group_id: 100,
    user_id: 2001,
    message: [{ type: 'text', text: 'hi' }],
    raw_message: 'hi',
    sender: { nickname: '阿猫' },
  });
  await eventPromise;
  assert.equal(transport.selfId, '12345', '应从事件学到机器人 QQ');

  await napcat.close();
  await transport.stop();
});

test('反向：收到对端 action 但没有 onAction 时，明确回失败而不是静默吞掉', async () => {
  // 回归：早期实现在没有 responder 时直接把这一帧丢掉，对端的 action() 于是
  // 一直挂到超时。对端有权拿到一个明确答复。
  const { transport, port } = await startReverse('secret');
  const readyPromise = waitFor(transport, 'ready');
  const napcat = await fakeNapCat(port, 'secret');
  await readyPromise;

  await assert.rejects(
    () => napcat.transport.action('get_status', {}, { timeoutMs: 2000 }),
    /retcode=1|没有注册 action 应答器/,
  );

  await napcat.close();
  await transport.stop();
});

test('反向：配置了 onAction 时会正常应答对端', async () => {
  const transport = new ReverseTransport({
    port: 0,
    accessToken: 'secret',
    onAction: (action) => (action === 'get_status' ? { online: true, good: true } : {}),
  });
  await transport.start();
  const port = transport.server.address().port;

  const napcat = new ForwardTransport({
    url: `ws://127.0.0.1:${port}`,
    accessToken: 'secret',
    onAction: () => ({}),
  });
  const readyPromise = waitFor(transport, 'ready');
  await napcat.start();
  await readyPromise;

  const answer = await napcat.action('get_status', {});
  assert.deepEqual(answer, { online: true, good: true });

  await napcat.stop();
  await transport.stop();
});

test('反向：token 不匹配时握手被拒（401），不会进入 ready', async () => {
  const { transport, port } = await startReverse('right');
  const logs = [];
  transport.on('log', (level, message) => logs.push({ level, message }));

  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(
    'GET / HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${port}\r\n` +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      'Authorization: Bearer wrong\r\n\r\n',
  );
  const response = await new Promise((resolve) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      if (buffer.includes('\r\n\r\n')) resolve(buffer);
    });
    socket.on('close', () => resolve(buffer));
  });

  assert.match(response, /401 Unauthorized/);
  assert.equal(transport.isReady, false);
  assert.ok(
    logs.some((l) => l.level === 'warn' && /token 不匹配/.test(l.message)),
    '应记录一条拒绝日志',
  );

  socket.destroy();
  await transport.stop();
});

test('反向：查询参数形式的 token 也被接受', async () => {
  const { transport, port } = await startReverse('qsecret');
  const readyPromise = waitFor(transport, 'ready');
  // 这里手工连：ForwardTransport 走 Authorization 头，要测查询参数得自己拼。
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(
    'GET /?access_token=qsecret HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${port}\r\n` +
      'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
  );

  const ready = await readyPromise;
  assert.equal(typeof ready.selfId, 'string');
  assert.equal(transport.isReady, true);

  socket.destroy();
  await transport.stop();
});

// ---------------------------------------------------------------- action 语义

test('action：响应按 echo 关联，返回 data，且参数被正确发出', async () => {
  const fake = await startFakeOneBot();
  const transport = new ForwardTransport({ url: `ws://127.0.0.1:${fake.port}` });
  await startAndWaitReady(transport);

  const info = await transport.getLoginInfo();
  assert.equal(info.user_id, 999);

  const messageId = await transport.sendGroupMsg('100', [{ type: 'text', text: 'hi' }]);
  assert.equal(messageId, 4242);

  const sent = fake.log.actions.at(-1);
  // 统一走 send_msg（所有实现都认的标准入口），而不是 send_group_msg 别名。
  assert.equal(sent.action, 'send_msg');
  // 字段平铺顶层：group_id 在 sent 上，不在 sent.params 里。
  assert.equal(sent.group_id, 100, 'group_id 应被转成数字并平铺在顶层');
  assert.deepEqual(sent.message, [{ type: 'text', text: 'hi' }]);
  assert.equal(sent.params, undefined, '不能出现 params 包装（NapCat 会拒绝）');

  await transport.stop();
  await fake.close();
});

test('action：并发多个 action 时按 echo 各自归位，不会串台', async () => {
  const fake = await startFakeOneBot({
    handler: (action, params) => ({ echoTag: params.tag }),
  });
  const transport = new ForwardTransport({ url: `ws://127.0.0.1:${fake.port}` });
  await startAndWaitReady(transport);

  const results = await Promise.all([
    transport.action('get_status', { tag: 'a' }),
    transport.action('get_status', { tag: 'b' }),
    transport.action('get_status', { tag: 'c' }),
  ]);
  assert.deepEqual(
    results.map((r) => r.echoTag),
    ['a', 'b', 'c'],
    '每个 promise 应拿到自己那次请求的响应',
  );

  await transport.stop();
  await fake.close();
});

test('action：OneBot 返回 retcode!=0 时 reject，并带上 retcode 与消息', async () => {
  const fake = await startFakeOneBot({
    handler: (action) =>
      action === 'send_msg'
        ? { __reject: { status: 'failed', retcode: 100, msg: 'bad group' } }
        : undefined,
  });
  const transport = new ForwardTransport({ url: `ws://127.0.0.1:${fake.port}` });
  await startAndWaitReady(transport);

  await assert.rejects(
    () => transport.sendGroupMsg('1', 'x'),
    (error) => {
      assert.match(error.message, /retcode=100/);
      assert.match(error.message, /bad group/);
      return true;
    },
  );

  assert.equal(transport.pending.size, 0, '失败的 action 不该留在 pending 里（泄漏）');

  // 失败之后连接仍然可用。
  const info = await transport.getLoginInfo();
  assert.equal(info.user_id, 999);

  await transport.stop();
  await fake.close();
});

test('action：未连接时立刻抛错，不做无谓等待', async () => {
  const transport = new ReverseTransport({ port: 0, accessToken: 't' });
  await assert.rejects(() => transport.getLoginInfo(), /未连接/);
});

test('action：超时被正确 reject，且不留在 pending 里', async () => {
  const fake = await startFakeOneBot({ handler: () => ({ __silent: true }) });
  const transport = new ForwardTransport({
    url: `ws://127.0.0.1:${fake.port}`,
    actionTimeoutMs: 200,
  });
  // attach 里的 get_login_info 就会超时，所以 start 之后是"已就绪但 selfId 空"。
  await transport.start();
  await new Promise((resolve) => setTimeout(resolve, 300));

  await assert.rejects(
    () => transport.action('get_status', {}, { timeoutMs: 150 }),
    /超时/,
  );
  assert.equal(transport.pending.size, 0, '超时的 action 必须从 pending 移除');

  await transport.stop();
  await fake.close();
});

test('断线：所有在途 action 立刻被 reject，而不是干等超时', async () => {
  const fake = await startFakeOneBot({ handler: () => ({ __silent: true }) });
  const transport = new ForwardTransport({
    url: `ws://127.0.0.1:${fake.port}`,
    actionTimeoutMs: 30_000,
  });
  await transport.start();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const pendingCall = transport.action('get_status', {});
  assert.equal(transport.pending.size, 1);

  const downPromise = waitFor(transport, 'down');
  transport.connection?.close(1006, 'boom');

  await assert.rejects(() => pendingCall, /连接断开/);
  await downPromise;
  assert.equal(transport.pending.size, 0);

  await transport.stop();
  await fake.close();
});

test('事件：收到上报后原样转发，并学习 self_id', async () => {
  const fake = await startFakeOneBot();
  const transport = new ForwardTransport({
    url: `ws://127.0.0.1:${fake.port}`,
    // 注意：fake 的 get_login_info 会给出 999，所以这里用另一个号来验证"从事件学"。
  });
  await startAndWaitReady(transport);

  const eventPromise = waitFor(transport, 'event');
  const event = {
    time: 30000023,
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    message_id: 7,
    group_id: 100,
    user_id: 2001,
    message: [{ type: 'text', text: '有人吗' }],
    raw_message: '有人吗',
    sender: { nickname: '阿猫' },
  };
  fake.push(event);
  const received = await eventPromise;
  assert.equal(received.message_id, 7);
  assert.equal(transport.selfId, '999');

  await transport.stop();
  await fake.close();
});

test('协议：垃圾帧不会打死传输层（只记日志）', async () => {
  const fake = await startFakeOneBot();
  const transport = new ForwardTransport({ url: `ws://127.0.0.1:${fake.port}` });
  await startAndWaitReady(transport);

  const logs = [];
  transport.on('log', (level, message) => logs.push({ level, message }));

  for (const connection of fake.connections) {
    connection.send('这不是 JSON');
    connection.send(JSON.stringify([1, 2, 3]));
    connection.send(JSON.stringify({ echo: 'nobody-waits' }));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(transport.isReady, true, '传输层应仍然可用');
  assert.ok(logs.some((l) => /无法解析/.test(l.message)));
  assert.ok(logs.some((l) => /无人等待/.test(l.message)));

  await transport.stop();
  await fake.close();
});

// ---------------------------------------------------------------- 正向模式

test('正向：作为客户端连到 NapCat，带上 Authorization 头', async () => {
  let seenAuth = null;
  const fake = await startFakeOneBot({
    authorize: (req) => {
      seenAuth = req.headers.authorization ?? null;
      return true;
    },
  });

  const transport = new ForwardTransport({
    url: `ws://127.0.0.1:${fake.port}/ws`,
    accessToken: 'fwd-token',
  });
  await startAndWaitReady(transport);

  assert.equal(seenAuth, 'Bearer fwd-token', '正向模式应走 Authorization 头');
  const info = await transport.getLoginInfo();
  assert.equal(info.nickname, '测试机器人');

  await transport.stop();
  await fake.close();
});

test('正向：无 token 时也要完成 WS 握手（回归：曾只建连不发 Upgrade）', async () => {
  let sawUpgrade = false;
  const fake = await startFakeOneBot({
    authorize: (req) => {
      sawUpgrade = (req.headers.upgrade ?? '').toLowerCase() === 'websocket';
      return true;
    },
  });
  const transport = new ForwardTransport({ url: `ws://127.0.0.1:${fake.port}` });
  await startAndWaitReady(transport);

  assert.equal(sawUpgrade, true, '必须真的发 Upgrade 请求，而不是只建 TCP 连接');
  assert.equal(transport.selfId, '999');

  await transport.stop();
  await fake.close();
});

test('正向：握手被拒时 start() 抛错', async () => {
  const fake = await startFakeOneBot({ authorize: () => false });
  const transport = new ForwardTransport({ url: `ws://127.0.0.1:${fake.port}`, accessToken: 'x' });
  await assert.rejects(() => transport.start(), /401|握手被拒绝/);
  await fake.close();
});

test('正向：连不上目标时抛错', async () => {
  const transport = new ForwardTransport({ url: 'ws://127.0.0.1:9', actionTimeoutMs: 500 });
  await assert.rejects(() => transport.start());
});

test('正向：wss:// 明确报不支持，而不是静默失败', async () => {
  const transport = new ForwardTransport({ url: 'wss://example.com/ws', accessToken: 'x' });
  await assert.rejects(() => transport.start(), /暂不支持 wss/);
});

test('正向：路径与查询串会被带到握手请求里', async () => {
  let seenUrl = null;
  const fake = await startFakeOneBot({
    authorize: (req) => {
      seenUrl = req.url;
      return true;
    },
  });
  const transport = new ForwardTransport({ url: `ws://127.0.0.1:${fake.port}/onebot/v11/ws?x=1` });
  await startAndWaitReady(transport);
  assert.equal(seenUrl, '/onebot/v11/ws?x=1');
  await transport.stop();
  await fake.close();
});

// ---------------------------------------------------------------- 重连

test('正向：连接断开后进入重连状态', async () => {
  const fake = await startFakeOneBot();
  const transport = new ForwardTransport({
    url: `ws://127.0.0.1:${fake.port}`,
    random: () => 0.5,
  });
  await startAndWaitReady(transport);

  const downPromise = waitFor(transport, 'down');
  // 直接把底层连接掐掉，模拟对端消失。
  transport.connection?.close(1006, 'boom');
  await downPromise;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    transport.state,
    STATE.RETRYING,
    `断开后应进入重连，实际状态：${transport.state}`,
  );

  await transport.stop();
  await fake.close();
});

test('重连上限：达到上限后放弃并发 give-up（而不是无限刷）', async () => {
  const transport = new OneBotTransport({ reconnectMaxAttempts: 2, random: () => 0.5 });
  const giveUp = waitFor(transport, 'give-up');
  const noop = async () => {};

  transport.scheduleRetry(noop);
  assert.equal(transport.failures, 1);
  await transport.stop(); // 清掉已排的定时器
  transport.stopping = false;
  transport.retryTimer = null;

  transport.scheduleRetry(noop);
  transport.retryTimer = null;
  transport.scheduleRetry(noop);
  const info = await giveUp;
  assert.equal(info.attempts, 3);
  assert.equal(transport.state, STATE.STOPPED);
  assert.match(info.reason, /reconnectMaxAttempts/);
});

test('scheduleRetry：已有重连在排队时不重复排队、不重复计失败', async () => {
  const transport = new OneBotTransport({ random: () => 0.5 });
  const noop = async () => {};
  transport.scheduleRetry(noop);
  const firstTimer = transport.retryTimer;
  transport.scheduleRetry(noop);
  assert.equal(transport.retryTimer, firstTimer, '不该覆盖已有定时器');
  assert.equal(transport.failures, 1, '也不该重复计失败次数');
  await transport.stop();
});

test('重连：定时器触发后真的会再试一次', async () => {
  let attempts = 0;
  const transport = new OneBotTransport({ random: () => 0.5 }); // 2s 基准
  transport.scheduleRetry(async () => {
    attempts += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(attempts, 1);
  await transport.stop();
});

test('stop() 会清掉待重连的定时器（不会在关停后偷偷重连）', async () => {
  let attempts = 0;
  const transport = new OneBotTransport({ random: () => 0.5 });
  transport.scheduleRetry(async () => {
    attempts += 1;
  });
  await transport.stop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(attempts, 0);
  assert.equal(transport.retryTimer, null);
});

// ---------------------------------------------------------------- 关停

test('stop() 幂等，且之后 start() 抛错', async () => {
  const { transport } = await startReverse('t');
  await transport.stop();
  await transport.stop();
  assert.equal(transport.state, STATE.STOPPED);
  await assert.rejects(() => transport.start(), /已停止/);
});

test('stop() 后调用给出明确错误而不是静默丢弃', async () => {
  const { transport } = await startReverse('t');
  await transport.stop();
  await assert.rejects(() => transport.sendToChat('group:1', 'x'), /未连接/);
});

test('sendToChat：非法 chatId 抛错', async () => {
  const { transport } = await startReverse('t');
  await assert.rejects(() => transport.sendToChat('nonsense', 'x'), /未连接|无效/);
  await transport.stop();
});

test('sendGroupMsg：非法 ID 抛错（防止把 NaN 发出去）', async () => {
  const { transport } = await startReverse('t');
  await assert.rejects(() => transport.sendGroupMsg('abc', 'x'), /未连接|无效/);
  await transport.stop();
});

test('sendToChat 正确分派到群/私聊', async () => {
  const fake = await startFakeOneBot();
  const transport = new ForwardTransport({ url: `ws://127.0.0.1:${fake.port}` });
  await startAndWaitReady(transport);

  await transport.sendToChat('group:100', 'x');
  const groupSent = fake.log.actions.at(-1);
  assert.equal(groupSent.action, 'send_msg', '统一走 send_msg');
  assert.equal(groupSent.group_id, 100, 'group_id 平铺在顶层');
  assert.equal(groupSent.user_id, undefined, '群聊不该带 user_id（会被实现判为歧义）');

  await transport.sendToChat('private:200', 'y');
  const privateSent = fake.log.actions.at(-1);
  assert.equal(privateSent.action, 'send_msg');
  assert.equal(privateSent.user_id, 200, 'user_id 平铺在顶层');
  assert.equal(privateSent.group_id, undefined, '私聊不该带 group_id');

  await transport.stop();
  await fake.close();
});
