/**
 * 极简 RFC 6455 WebSocket：服务端握手 + 双向帧编解码。
 *
 * 为什么不直接用 Node 内置的全局 `WebSocket`（v22+ 有）或 `ws`：
 * - 内置 `WebSocket` **只有客户端**，而 OneBot 的反向 WS 模式要求我们当**服务端**
 *   监听、接受 NapCat 拨入。这是本插件必须支持的模式。
 * - `ws` 是外部依赖，第三方插件在宿主里的解析行为不可控（profile 的 node_modules
 *   解析链 + peer 重定向），能不加就不加。
 *
 * 所以这里手写一份。范围刻意收窄到 OneBot 用得到的部分：
 * 文本帧、分片、ping/pong、close。不做 permessage-deflate（OneBot 不用）。
 *
 * @module qq-onebot/ws
 */
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** RFC 6455 握手用的魔数。 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 帧操作码。 */
const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/** 单条消息的字节上限，防止对端推超大帧把内存吃光。 */
const DEFAULT_MAX_PAYLOAD = 8 * 1024 * 1024;

/**
 * 计算 `Sec-WebSocket-Accept`。
 * @param {string} key 客户端 `Sec-WebSocket-Key`
 * @returns {string}
 */
export function acceptKey(key) {
  return createHash('sha1')
    .update(String(key) + GUID)
    .digest('base64');
}

/**
 * 编码一帧（服务端发出的帧不加掩码；客户端发出的帧必须加掩码）。
 *
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {boolean} mask 是否加掩码（客户端方向必须 true）
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload, mask) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8');
  const length = body.length;

  let headerLength = 2;
  if (length >= 65536) headerLength += 8;
  else if (length >= 126) headerLength += 2;
  if (mask) headerLength += 4;

  const frame = Buffer.allocUnsafe(headerLength + length);
  frame[0] = 0x80 | opcode; // FIN=1

  let offset = 2;
  if (length >= 65536) {
    frame[1] = 127;
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(length, 6);
    offset = 10;
  } else if (length >= 126) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    frame[1] = length;
  }

  if (mask) {
    frame[1] |= 0x80;
    const maskKey = Buffer.allocUnsafe(4);
    for (let i = 0; i < 4; i++) maskKey[i] = Math.floor(Math.random() * 256);
    maskKey.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < length; i++) frame[offset + i] = body[i] ^ maskKey[i % 4];
  } else {
    body.copy(frame, offset);
  }
  return frame;
}

/**
 * 增量帧解码器。TCP 是字节流，一帧可能跨多个 chunk，一个 chunk 也可能含多帧，
 * 所以必须缓冲。这是手写 WS 最容易出错的地方，因此单独成类并重点测。
 */
export class FrameDecoder {
  /**
   * @param {object} [options]
   * @param {number} [options.maxPayload] 单条消息字节上限
   * @param {boolean} [options.expectMask] 是否要求对端帧带掩码（服务端方向应 true）
   */
  constructor({ maxPayload = DEFAULT_MAX_PAYLOAD, expectMask = true } = {}) {
    this.buffer = Buffer.alloc(0);
    this.maxPayload = maxPayload;
    this.expectMask = expectMask;
    /** @type {{opcode:number, chunks:Buffer[]} | null} */
    this.fragment = null;
  }

  /**
   * 喂入一段字节，取出已完成的帧。
   * @param {Buffer} chunk
   * @returns {Array<{opcode:number, payload:Buffer}>}
   * @throws {Error} 协议违例（超大帧、非法掩码、未知操作码）
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    /** @type {Array<{opcode:number, payload:Buffer}>} */
    const frames = [];

    for (;;) {
      const frame = this.#readOne();
      if (frame === null) break;
      frames.push(frame);
    }
    return frames;
  }

  /** 尝试解出一帧；数据不够返回 null。 */
  #readOne() {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;

    const fin = (buffer[0] & 0x80) !== 0;
    const rsv = buffer[0] & 0x70;
    if (rsv !== 0) throw new Error('ws: RSV 位被置位但未协商任何扩展');
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;

    if (this.expectMask && !masked) throw new Error('ws: 对端帧未加掩码（协议违例）');

    if (length === 126) {
      if (buffer.length < offset + 2) return null;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null;
      const high = buffer.readUInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      if (high !== 0) throw new Error('ws: 帧长度超出可处理范围');
      length = low;
      offset += 8;
    }

    if (length > this.maxPayload) throw new Error(`ws: 单帧 ${length} 字节超过上限 ${this.maxPayload}`);

    let maskKey = null;
    if (masked) {
      if (buffer.length < offset + 4) return null;
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buffer.length < offset + length) return null;

    let payload = buffer.subarray(offset, offset + length);
    if (maskKey !== null) {
      const unmasked = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    } else {
      // subarray 是视图，留着会让整个 chunk 无法回收；拷贝一份。
      payload = Buffer.from(payload);
    }
    this.buffer = buffer.subarray(offset + length);

    // 控制帧不能分片，且载荷 ≤125 字节。
    if (opcode >= 0x8) {
      if (!fin) throw new Error('ws: 控制帧不允许分片');
      if (payload.length > 125) throw new Error('ws: 控制帧载荷超过 125 字节');
      return { opcode, payload };
    }

    if (opcode === OPCODE.CONTINUATION) {
      if (this.fragment === null) throw new Error('ws: 收到续帧但没有在途分片');
      this.fragment.chunks.push(payload);
      if (!fin) return null;
      const merged = Buffer.concat(this.fragment.chunks);
      if (merged.length > this.maxPayload) throw new Error('ws: 分片合并后超过上限');
      const completed = { opcode: this.fragment.opcode, payload: merged };
      this.fragment = null;
      return completed;
    }

    if (opcode !== OPCODE.TEXT && opcode !== OPCODE.BINARY) {
      throw new Error(`ws: 未知操作码 0x${opcode.toString(16)}`);
    }

    if (fin) return { opcode, payload };
    this.fragment = { opcode, chunks: [payload] };
    return null;
  }
}

/**
 * 一条 WebSocket 连接。把帧编解码包成「发文本 / 收文本」。
 *
 * 事件：
 * - `message` (text: string)
 * - `close`   (code: number, reason: string)
 * - `error`   (error: Error)
 */
export class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:stream').Duplex} socket
   * @param {object} [options]
   * @param {boolean} [options.isServer] 本端是否为服务端（决定是否要求对端掩码）
   * @param {number} [options.maxPayload]
   */
  constructor(socket, { isServer, maxPayload = DEFAULT_MAX_PAYLOAD } = {}) {
    super();
    this.socket = socket;
    this.isServer = Boolean(isServer);
    this.closed = false;
    this.decoder = new FrameDecoder({ maxPayload, expectMask: this.isServer });
    /** 本端发出的帧是否加掩码：客户端方向必须加。 */
    this.maskOutgoing = !this.isServer;

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => {
      if (this.closed) return;
      this.emit('error', error);
      this.#teardown(1006, 'socket error');
    });
    socket.on('close', () => this.#teardown(1006, 'socket closed'));
    socket.on('end', () => this.#teardown(1006, 'socket ended'));
  }

  /**
   * 直接喂入一段字节给解码器。
   *
   * 给 HTTP 升级用：Node 在 `'upgrade'` 事件里交出的 `head` 是**已经越过 HTTP 报文头
   * 的那部分字节**。必须在 `'data'` 监听建立之前就消费它，而且只能喂给解码器——
   * 早期实现里写成 `socket.unshift(head)`，把字节塞回明文 socket，于是解码器在
   * 真正数据之前先读到 HTTP 尾部残渣，报出「RSV 位被置位」这种莫名其妙的错误。
   *
   * 注意：即使 `head` 为空也必须先建好监听再处理字节，否则会丢数据。
   * @param {Buffer} chunk
   */
  feed(chunk) {
    if (this.closed) return;
    if (chunk === undefined || chunk === null || chunk.length === 0) return;
    this.#onData(chunk);
  }

  #onData(chunk) {
    if (this.closed) return;
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      this.close(1002, 'protocol error');
      return;
    }
    for (const frame of frames) this.#handleFrame(frame);
  }

  #handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        this.emit('message', frame.payload.toString('utf8'));
        break;
      case OPCODE.PING:
        this.#write(encodeFrame(OPCODE.PONG, frame.payload, this.maskOutgoing));
        break;
      case OPCODE.PONG:
        this.emit('pong', frame.payload.toString('utf8'));
        break;
      case OPCODE.CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
        // 回一个 close 帧再断开，符合 RFC。
        if (!this.closed) this.#write(encodeFrame(OPCODE.CLOSE, frame.payload, this.maskOutgoing));
        this.#teardown(code, reason);
        break;
      }
      default:
        break;
    }
  }

  #write(frame) {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(frame);
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * 发送一条文本消息。
   * @param {string} text
   * @returns {boolean} 是否写入成功
   */
  send(text) {
    if (this.closed || this.socket.destroyed) return false;
    this.#write(encodeFrame(OPCODE.TEXT, Buffer.from(String(text), 'utf8'), this.maskOutgoing));
    return true;
  }

  /** 发送 ping（保活探测）。 */
  ping(payload = '') {
    this.#write(encodeFrame(OPCODE.PING, Buffer.from(String(payload), 'utf8'), this.maskOutgoing));
  }

  /**
   * 主动关闭。会先礼貌地发 close 帧，再断开，最后以真实 code 触发一次 `close` 事件。
   *
   * 注意：这里**不能**先置 `closed`——那会让 `#teardown` 提前返回，
   * 结果是监听器不被摘掉、`close` 事件不带真实状态码。
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBytes = Buffer.from(String(reason), 'utf8').subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.#write(encodeFrame(OPCODE.CLOSE, payload, this.maskOutgoing));
    try {
      this.socket.end();
    } catch {
      /* 已经断开就算了 */
    }
    // 收尾交给 #teardown（socket 的 close/end 也会走到它），幂等。
    this.#teardown(code, reason);
  }

  /** 幂等收尾：清理监听并只发一次 close 事件。 */
  #teardown(code, reason) {
    if (this.disposed) return;
    this.disposed = true;
    this.closed = true;
    this.removeAllListeners('message');
    this.removeAllListeners('pong');
    try {
      if (!this.socket.destroyed) this.socket.destroy();
    } catch {
      /* 断开时的清理失败无需上报 */
    }
    this.emit('close', code, reason);
  }
}

/**
 * 在已建立握手的 socket 上创建一个连接对象。
 * @param {import('node:stream').Duplex} socket
 * @param {object} [options]
 * @returns {WebSocketConnection}
 */
export function wrapSocket(socket, options = {}) {
  return new WebSocketConnection(socket, options);
}

/**
 * 生成握手需要的 `Sec-WebSocket-Key`。
 *
 * **必须是 16 随机字节的标准 base64，也就是 24 个字符（尾部带 `==`）。**
 *
 * 这里曾经是 `randomUUID().replace(/-/g, '').slice(0, 22)`——22 个十六进制字符。
 * 它 base64 解码后其实也是 16 字节，看起来"没毛病"，但 RFC 6455 要求这个值
 * 是 16 字节的 **base64 编码**，而 `ws` 库（NapCat / LLOneBot / go-cqhttp 都用它）
 * 按**字符数**严格校验，22 字符直接回 `400 Bad Request`。
 *
 * 后果很隐蔽：**正向模式连任何标准 WebSocket 服务端都会握手失败**，
 * 而本项目的假服务端不校验 key，所以自测永远通过——典型的"两边都是我写的，
 * 同一个错误两边都犯、互相接受"。实测对照：22 字符 → 400，24 字符 → 101。
 */
export function makeHandshakeKey() {
  return randomBytes(16).toString('base64');
}

/**
 * 校验客户端送来的 `Sec-WebSocket-Key` 是否合规。
 *
 * 服务端这边同样要校验：不校验就等于对任何畸形握手开门。
 * 实测过 `ws` 库的行为并与之对齐——非 24 字符或解码后非 16 字节一律拒绝。
 * @param {string} key
 * @returns {boolean}
 */
export function isValidHandshakeKey(key) {
  if (typeof key !== 'string') return false;
  // 标准形态是 24 个字符；但 base64 允许省略填充，所以按"解码后 16 字节"判定，
  // 同时要求字符集合法（避免 `Buffer.from` 静默忽略非法字符）。
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return false;
  return Buffer.from(key, 'base64').length === 16;
}

export { OPCODE, DEFAULT_MAX_PAYLOAD, GUID };
