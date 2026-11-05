/**
 * WebSocket 底层测试：帧编解码、分片、掩码、握手、边界。
 *
 * 手写 WS 最容易错的地方全在这里：跨 chunk 的半帧、分片重组、
 * 掩码方向、控制帧约束、超大帧。所以这些都用表格/边界用例压实。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { acceptKey, encodeFrame, FrameDecoder, wrapSocket, makeHandshakeKey, isValidHandshakeKey, OPCODE, GUID } from '../src/onebot/ws.mjs';

// ---------------------------------------------------------------- 握手 key 格式
//
// 这一组测试来自一个真实事故：`makeHandshakeKey()` 曾经返回
// `randomUUID().replace(/-/g,'').slice(0,22)` —— 22 个十六进制字符。
// 它 base64 解码后**也是 16 字节**，所以看起来没问题；但 RFC 6455 要求这个值
// 是 16 字节的 base64 编码，`ws` 库（NapCat / LLOneBot / go-cqhttp 都用它）
// 按字符数严格校验，22 字符直接回 400。
//
// 后果极隐蔽：**正向模式连任何标准服务端都会握手失败**，而本项目的假服务端
// 不校验 key、假客户端也发 22 字符，两边互相接受，自测永远绿灯——
// 典型的"两边都是我写的，同一个错误两边都犯"。
// 用 `ws` 库做的对照实验结论：22 字符 → 400；24 字符 → 101。

test('makeHandshakeKey：必须是 24 字符的标准 base64（16 字节带填充）', () => {
  for (let i = 0; i < 200; i++) {
    const key = makeHandshakeKey();
    assert.equal(key.length, 24, `长度必须是 24，实际 ${key.length}（${key}）`);
    assert.match(key, /^[A-Za-z0-9+/]{22}==$/, `形态必须是 22 位 base64 加 "=="：${key}`);
    assert.equal(Buffer.from(key, 'base64').length, 16, '解码后必须是 16 字节');
    assert.equal(isValidHandshakeKey(key), true);
  }
});

test('isValidHandshakeKey：拒绝旧的不合规格式与各种畸形输入', () => {
  // 旧实现产出的 22 位十六进制——正是会让真实服务端回 400 的那个
  assert.equal(isValidHandshakeKey('f1408d8b3cdf490384cd83'), false);
  assert.equal(isValidHandshakeKey('4625d0dce51a4e6a'), false);
  assert.equal(isValidHandshakeKey(''), false);
  assert.equal(isValidHandshakeKey(undefined), false);
  assert.equal(isValidHandshakeKey(null), false);
  assert.equal(isValidHandshakeKey(12345), false);
  // 长度对但字符集非法
  assert.equal(isValidHandshakeKey('!!!!!!!!!!!!!!!!!!!!!!'), false);
  // 少了 "==" 填充
  assert.equal(isValidHandshakeKey('bhEIjAf9HXRYB+Vn5IKmTQ'), false);
  // 合法样例
  assert.equal(isValidHandshakeKey('bhEIjAf9HXRYB+Vn5IKmTQ=='), true);
});

// ---------------------------------------------------------------- 握手

test('acceptKey 命中 RFC 6455 的官方示例', () => {
  // RFC 6455 §1.3 给出的示例值。
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('GUID 是 RFC 规定的那个常量', () => {
  assert.equal(GUID, '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
});

// ---------------------------------------------------------------- 帧编解码

test('encodeFrame/decode：空载荷往返', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  const frames = decoder.push(encodeFrame(OPCODE.TEXT, Buffer.alloc(0), false));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, 0);
});

test('encodeFrame/decode：短文本往返（7 位长度）', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  const frames = decoder.push(encodeFrame(OPCODE.TEXT, Buffer.from('你好', 'utf8'), false));
  assert.equal(frames[0].payload.toString('utf8'), '你好');
});

test('encodeFrame/decode：126 字节长度段边界', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  for (const size of [125, 126, 127, 65535, 65536]) {
    const d = new FrameDecoder({ expectMask: false });
    const payload = Buffer.alloc(size, 0x61);
    const frames = d.push(encodeFrame(OPCODE.TEXT, payload, false));
    assert.equal(frames.length, 1, `${size} 字节应解出一帧`);
    assert.equal(frames[0].payload.length, size);
  }
  assert.ok(decoder);
});

test('encodeFrame/decode：客户端方向必须加掩码且能正确还原', () => {
  const decoder = new FrameDecoder({ expectMask: true });
  const frames = decoder.push(encodeFrame(OPCODE.TEXT, Buffer.from('带掩码', 'utf8'), true));
  assert.equal(frames[0].payload.toString('utf8'), '带掩码');
});

test('encodeFrame：加掩码后的载荷不等于原文（掩码真的生效了）', () => {
  const frame = encodeFrame(OPCODE.TEXT, Buffer.from('aaaaaaaaaa', 'utf8'), true);
  const maskFlag = (frame[1] & 0x80) !== 0;
  assert.equal(maskFlag, true, '掩码位应被置位');
  assert.notEqual(frame.subarray(frame.length - 10).toString('utf8'), 'aaaaaaaaaa');
});

// ---------------------------------------------------------------- 跨 chunk / 分片

test('decoder：一帧被拆成多个 chunk 也能解出', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  const frame = encodeFrame(OPCODE.TEXT, Buffer.from('分两次到达', 'utf8'), false);

  // 逐字节喂，最严苛的情况。
  const out = [];
  for (const byte of frame) out.push(...decoder.push(Buffer.from([byte])));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.toString('utf8'), '分两次到达');
});

test('decoder：一个 chunk 里含多帧全部解出', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  const merged = Buffer.concat([
    encodeFrame(OPCODE.TEXT, Buffer.from('一', 'utf8'), false),
    encodeFrame(OPCODE.TEXT, Buffer.from('二', 'utf8'), false),
    encodeFrame(OPCODE.TEXT, Buffer.from('三', 'utf8'), false),
  ]);
  const frames = decoder.push(merged);
  assert.deepEqual(
    frames.map((f) => f.payload.toString('utf8')),
    ['一', '二', '三'],
  );
});

test('decoder：尾随半帧留待下次，不丢字节', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  const a = encodeFrame(OPCODE.TEXT, Buffer.from('完整', 'utf8'), false);
  const b = encodeFrame(OPCODE.TEXT, Buffer.from('半截', 'utf8'), false);
  const frames = decoder.push(Buffer.concat([a, b.subarray(0, 4)]));
  assert.equal(frames.length, 1);
  assert.equal(decoder.buffer.length, 4, '半帧应留在缓冲里');

  const rest = decoder.push(b.subarray(4));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].payload.toString('utf8'), '半截');
});

test('decoder：分片帧（FIN=0 + 续帧）重组为一条消息', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  // 手工构造分片：第一片 TEXT/FIN=0，第二片 CONTINUATION/FIN=1。
  const part1 = encodeFrame(OPCODE.TEXT, Buffer.from('前半', 'utf8'), false);
  part1[0] &= 0x7f; // 清 FIN
  const part2 = encodeFrame(OPCODE.CONTINUATION, Buffer.from('后半', 'utf8'), false);

  assert.equal(decoder.push(part1).length, 0, '首片不该产出完整消息');
  const frames = decoder.push(part2);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString('utf8'), '前半后半');
  assert.equal(frames[0].opcode, OPCODE.TEXT, '重组后应保持原始操作码');
});

test('decoder：三片分片也能重组', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  const p1 = encodeFrame(OPCODE.TEXT, Buffer.from('a', 'utf8'), false);
  p1[0] &= 0x7f;
  const p2 = encodeFrame(OPCODE.CONTINUATION, Buffer.from('b', 'utf8'), false);
  p2[0] &= 0x7f;
  const p3 = encodeFrame(OPCODE.CONTINUATION, Buffer.from('c', 'utf8'), false);
  assert.equal(decoder.push(p1).length, 0);
  assert.equal(decoder.push(p2).length, 0);
  const frames = decoder.push(p3);
  assert.equal(frames[0].payload.toString('utf8'), 'abc');
});

// ---------------------------------------------------------------- 协议违例

test('decoder：服务端方向收到未加掩码的帧 → 报协议违例', () => {
  const decoder = new FrameDecoder({ expectMask: true });
  assert.throws(
    () => decoder.push(encodeFrame(OPCODE.TEXT, Buffer.from('没掩码', 'utf8'), false)),
    /未加掩码/,
  );
});

test('decoder：无在途分片时收到续帧 → 报错', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  assert.throws(
    () => decoder.push(encodeFrame(OPCODE.CONTINUATION, Buffer.from('x'), false)),
    /没有在途分片/,
  );
});

test('decoder：RSV 位被置位 → 报错（未协商扩展）', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  const frame = encodeFrame(OPCODE.TEXT, Buffer.from('x'), false);
  frame[0] |= 0x40;
  assert.throws(() => decoder.push(frame), /RSV/);
});

test('decoder：单帧超过 maxPayload → 报错（拒绝内存放大）', () => {
  const decoder = new FrameDecoder({ expectMask: false, maxPayload: 16 });
  assert.throws(
    () => decoder.push(encodeFrame(OPCODE.TEXT, Buffer.alloc(64), false)),
    /超过上限/,
  );
});

test('decoder：分片合并后超过 maxPayload → 报错', () => {
  const decoder = new FrameDecoder({ expectMask: false, maxPayload: 10 });
  const p1 = encodeFrame(OPCODE.TEXT, Buffer.alloc(8), false);
  p1[0] &= 0x7f;
  const p2 = encodeFrame(OPCODE.CONTINUATION, Buffer.alloc(8), false);
  assert.equal(decoder.push(p1).length, 0);
  assert.throws(() => decoder.push(p2), /分片合并后超过上限/);
});

test('decoder：未知操作码 → 报错', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  const frame = encodeFrame(0x3, Buffer.from('x'), false);
  assert.throws(() => decoder.push(frame), /未知操作码/);
});

test('decoder：控制帧不允许分片', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  const frame = encodeFrame(OPCODE.PING, Buffer.from('x'), false);
  frame[0] &= 0x7f; // 清 FIN
  assert.throws(() => decoder.push(frame), /控制帧不允许分片/);
});

test('decoder：控制帧载荷不得超 125 字节', () => {
  const decoder = new FrameDecoder({ expectMask: false });
  assert.throws(
    () => decoder.push(encodeFrame(OPCODE.PING, Buffer.alloc(126), false)),
    /控制帧载荷超过 125/,
  );
});

// ---------------------------------------------------------------- 真实 socket 往返

/**
 * 起一个裸 WS 服务端：完成握手，然后把收到的每条文本消息回显。
 * 用 Node 内置 http，不引任何依赖。
 * @returns {Promise<{port:number, close:()=>Promise<void>, sockets:Set<any>}>}
 */
async function startEchoServer() {
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(String(key))}\r\n\r\n`,
    );
    sockets.add(socket);
    // 服务端方向：要求客户端帧带掩码，自己发出的帧不加掩码。
    const connection = wrapSocket(socket, { isServer: true, maxPayload: 1024 * 1024 });
    connection.on('message', (text) => connection.send(`echo:${text}`));
    connection.on('close', () => sockets.delete(socket));
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    sockets,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * 作为一个原始客户端连上去（自己写握手 + 自己编帧），
 * 用于验证服务端方向的实现。
 * @param {number} port
 */
async function rawClientConnect(port) {
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(
    'GET / HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  );

  // 读到握手响应结束（\r\n\r\n）。
  const handshake = await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf('\r\n\r\n');
      if (index !== -1) {
        socket.off('data', onData);
        resolve(buffer.subarray(0, index + 4).toString('latin1'));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });

  assert.match(handshake, /101 Switching Protocols/);
  assert.match(handshake, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  return socket;
}

test('真实 socket：客户端（带掩码）→ 服务端解码 → 回显 → 客户端收到', async () => {
  const server = await startEchoServer();
  try {
    const socket = await rawClientConnect(server.port);
    const decoder = new FrameDecoder({ expectMask: false });

    const received = [];
    const done = new Promise((resolve) => {
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.opcode === OPCODE.TEXT) {
            received.push(frame.payload.toString('utf8'));
            resolve();
          }
        }
      });
    });

    socket.write(encodeFrame(OPCODE.TEXT, Buffer.from('hello onebot', 'utf8'), true));
    await done;
    assert.deepEqual(received, ['echo:hello onebot']);
    socket.destroy();
  } finally {
    await server.close();
  }
});

test('真实 socket：ping 得到 pong', async () => {
  const server = await startEchoServer();
  try {
    const socket = await rawClientConnect(server.port);
    const decoder = new FrameDecoder({ expectMask: false });
    const pongs = [];
    const done = new Promise((resolve) => {
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.opcode === OPCODE.PONG) {
            pongs.push(frame.payload.toString('utf8'));
            resolve();
          }
        }
      });
    });
    socket.write(encodeFrame(OPCODE.PING, Buffer.from('hb', 'utf8'), true));
    await done;
    assert.deepEqual(pongs, ['hb']);
    socket.destroy();
  } finally {
    await server.close();
  }
});

test('真实 socket：客户端发 close 帧，服务端回应并触发 close 事件', async () => {
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(String(req.headers['sec-websocket-key']))}\r\n\r\n`,
    );
    sockets.add(socket);
    const connection = wrapSocket(socket, { isServer: true });
    connection.on('message', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const socket = await rawClientConnect(port);
    const decoder = new FrameDecoder({ expectMask: false });
    const closed = new Promise((resolve) => {
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.opcode === OPCODE.CLOSE) resolve(frame.payload.readUInt16BE(0));
        }
      });
      socket.on('close', () => resolve('socket-closed'));
    });

    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1000, 0);
    socket.write(encodeFrame(OPCODE.CLOSE, payload, true));

    const code = await closed;
    assert.ok(code === 1000 || code === 'socket-closed', `期望服务端回应 close，得到 ${code}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('真实 socket：服务端超过 maxPayload 时应断开而不是继续读', async () => {
  const sockets = new Set();
  const errors = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(String(req.headers['sec-websocket-key']))}\r\n\r\n`,
    );
    sockets.add(socket);
    const connection = wrapSocket(socket, { isServer: true, maxPayload: 32 });
    connection.on('error', (error) => errors.push(error.message));
    connection.on('message', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const socket = await rawClientConnect(port);
    socket.write(encodeFrame(OPCODE.TEXT, Buffer.alloc(1024), true));
    const closed = await new Promise((resolve) => {
      socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });
    assert.equal(closed, true, '超限应导致连接被断开');
    assert.ok(errors.some((m) => /超过上限/.test(m)), `应记录超限错误，实际：${JSON.stringify(errors)}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('真实 socket：服务端主动 close 后，send() 返回 false 而不是抛异常', async () => {
  const sockets = new Set();
  const server = http.createServer();
  let serverSide;
  server.on('upgrade', (req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(String(req.headers['sec-websocket-key']))}\r\n\r\n`,
    );
    sockets.add(socket);
    serverSide = wrapSocket(socket, { isServer: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const socket = await rawClientConnect(port);
    await new Promise((resolve) => setTimeout(resolve, 50));
    serverSide.close(1000, 'bye');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(serverSide.send('还发得出去吗'), false);
    socket.destroy();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
