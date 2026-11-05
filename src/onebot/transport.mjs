/**
 * OneBot 11 传输层：正向/反向 WebSocket、action 调用、重连退避。
 *
 * 两种模式的差别只在于「谁来拨号」：
 * - **反向（reverse）**：我们监听端口，NapCat 作为 WS 客户端拨入。这是推荐模式，
 *   因为 NAT 后面的 NapCat 不需要开放入站端口，也不需要在插件里配远端地址。
 * - **正向（forward）**：我们作为 WS 客户端拨到 NapCat 的 WS 服务端。
 *
 * 上层只看到同一个接口：`action()` / `sendGroupMsg()` / `sendPrivateMsg()` 与
 * `ready` / `down` / `event` 事件。
 *
 * action 关联用 OneBot 规范的 `echo` 字段：请求带 `echo`，响应回同一个 `echo`。
 * 断线时必须立刻 reject 所有在途 action——否则调用方会干等几十秒然后超时，
 * 既是体验问题也是泄漏（dsh-onebot 的 DEVLOG 记过这条）。
 *
 * 关于 `_open` / `_shutdown` 为什么用下划线而不是 `#` 私有方法：
 * JS 私有方法按词法作用域绑定，**不是虚方法**。派生类声明同名 `#open` 只会造出一个
 * 无关的新函数，基类里的 `this.#open()` 永远命中基类版本。这一点已实测确认。
 *
 * @module qq-onebot/transport
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import { acceptKey, isValidHandshakeKey, makeHandshakeKey, wrapSocket } from './ws.mjs';
import { createShortLinkExpander } from './short-link.mjs';

/** action 默认超时。NapCat 在大群列表等操作上偶尔会慢，给足余量。 */
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;

/** 重连退避：首连失败后 2s 起，翻倍到 60s 封顶，带抖动避免多实例同步重连。 */
const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * 从 HTTP 请求里取出 access token：先看 Authorization 头，再看查询参数。
 *
 * 两种都要支持：OneBot 规范用 `Authorization: Bearer <token>`，
 * 但 NapCat 的 ws-reverse 界面上填的 token 在部分版本里走 `?access_token=`。
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
export function extractToken(req) {
  const header = req.headers?.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match !== null) return match[1].trim();
  }
  const rawUrl = req.url ?? '';
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex !== -1) {
    const params = new URLSearchParams(rawUrl.slice(queryIndex + 1));
    const token = params.get('access_token');
    if (token !== null && token !== '') return token;
  }
  return null;
}

/**
 * 计算下一次重连延迟（指数退避 + 抖动）。
 * @param {number} attempt 第几次失败（从 1 开始）
 * @param {() => number} [random] 注入随机源便于测试
 * @returns {number} 毫秒
 */
export function backoffDelay(attempt, random = Math.random) {
  const exponent = Math.min(attempt - 1, 10);
  const base = Math.min(BACKOFF_START_MS * 2 ** exponent, BACKOFF_MAX_MS);
  // 抖动 ±20%：避免 NapCat 与插件同时重启时所有实例齐步重连。
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

/** 连接状态。 */
export const STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  READY: 'ready',
  RETRYING: 'retrying',
  STOPPED: 'stopped',
};

/**
 * 传输层基类。子类实现 `_open()` / `_shutdown()`。
 *
 * 事件：
 * - `ready`  ({ selfId })            连上并完成身份探测
 * - `down`   ({ reason })            断开
 * - `event`  (rawOneBotEvent)        收到上报事件
 * - `give-up`({ attempts, reason })  连续重连失败后放弃
 * - `log`    (level, message, meta)
 */
export class OneBotTransport extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.mode `reverse` 或 `forward`
   * @param {string} [options.host] reverse 监听地址
   * @param {number} [options.port] reverse 监听端口
   * @param {string} [options.url] forward 目标地址
   * @param {string} [options.accessToken]
   * @param {string} [options.botQQ] 显式指定机器人 QQ（留空则从事件学习）
   * @param {number} [options.reconnectMaxAttempts] 连续失败上限，0 = 无限
   * @param {number} [options.actionTimeoutMs]
   * @param {number} [options.maxPayload]
   * @param {() => number} [options.random]
   */
  constructor(options = {}) {
    super();
    this.mode = options.mode === 'forward' ? 'forward' : 'reverse';
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 8643;
    this.url = options.url ?? 'ws://127.0.0.1:3001';
    this.accessToken = options.accessToken ?? '';
    this.botQQ = options.botQQ ?? '';
    this.reconnectMaxAttempts = options.reconnectMaxAttempts ?? 0;
    this.actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.maxPayload = options.maxPayload ?? 8 * 1024 * 1024;
    this.random = options.random ?? Math.random;
    /**
     * 可选的 action 应答器。设了它，这条连接就会扮演 OneBot **服务端**一侧：
     * 收到对方发来的 action 就调它取数据并回响应。
     *
     * 用途有两个：一是测试里当 NapCat 替身，二是在反向模式下做自检。
     * 必须在构造时给（不能 start 之后再替换 handleFrame）：对端可能在握手
     * 过程中立刻发问，那时 start() 还没返回。
     * @type {((action: string, params: any) => any | Promise<any>) | undefined}
     */
    this.onAction = options.onAction;
    /**
     * **卡片短链展开器**（`onebot/short-link.mjs` 的 `createShortLinkExpander`）。
     *
     * 解决的问题（用户 2026-11-03）：「卡片生成的文本把 bv 号也提供了，或者直接生成网址」——
     * 卡片里的 `qqdocurl` 是 `https://b23.tv/RcVLXMu` 这种短链，模型用不了。
     *
     * ⚠️ **为什么在这一层展开**：`rich.mjs` 的渲染链是**纯同步**的，而跟随短链是异步的。
     * 这里（`handleFrame` → `emit('event')`）是入站唯一的收口，本来就是 async，
     * 展开一次把结果写回段对象，渲染层只管同步读 —— 同步契约一个字都不用改。
     *
     * 传 `false` ⇒ 完全关掉（一个请求都不发）；不传 ⇒ 默认开着。
     * 展开有 1s 超时，**失败静默退回原短链**（见那个模块头部的三条硬规矩）。
     * @type {ReturnType<typeof createShortLinkExpander>|false|null}
     */
    this.shortLinks = options.shortLinks === undefined
      ? createShortLinkExpander({ log: (level, message, meta) => this.log(level, message, meta) })
      : options.shortLinks;
    /**
     * 连接建立后是否主动探测身份（发 `get_login_info`）。
     *
     * - 正向模式：true。我们是客户端，身份在 NapCat 手里，只能问它。
     * - 反向模式：false。NapCat 是应用端，它不会回应我们的问询；
     *   身份只能从它上报的事件里学，或由配置显式给出。
     * @type {boolean}
     */
    this.probesIdentity = this.mode === 'forward';

    this.state = STATE.IDLE;
    /** @type {import('./ws.mjs').WebSocketConnection|null} */
    this.connection = null;
    /** @type {Map<string, {resolve:Function, reject:Function, timer:any, action:string}>} */
    this.pending = new Map();
    this.failures = 0;
    this.stopping = false;
    /** @type {any} */
    this.retryTimer = null;
    /** 连接代数：每次成功连接 +1，用来丢弃旧连接的迟到回调。 */
    this.generation = 0;
  }

  /** 是否已就绪。 */
  get isReady() {
    return this.state === STATE.READY && this.connection !== null && !this.connection.closed;
  }

  /** 当前已知的机器人 QQ（配置值或从事件学到的）。 */
  get selfId() {
    return this.botQQ;
  }

  log(level, message, meta) {
    this.emit('log', level, message, meta);
  }

  /**
   * 启动。反向模式开始监听；正向模式开始拨号。
   * @returns {Promise<void>}
   */
  async start() {
    if (this.stopping) throw new Error('transport 已停止，不能重新启动');
    await this._open();
  }

  /**
   * 子类实现：反向=开始监听，正向=开始拨号。
   * 见文件头的说明——这里必须是可重写的约定方法，不能用 `#` 私有方法。
   */
  async _open() {
    throw new Error('OneBotTransport 是抽象基类，请使用 ReverseTransport 或 ForwardTransport');
  }

  /** 子类实现：释放监听器/定时器。 */
  async _shutdown() {
    return undefined;
  }

  /** 停止并拒绝所有在途 action。 */
  async stop() {
    this.stopping = true;
    this.state = STATE.STOPPED;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.failAllPending('transport stopped');
    const connection = this.connection;
    this.connection = null;
    if (connection !== null) connection.close(1001, 'going away');
    await this._shutdown().catch((error) => {
      this.log('warn', 'transport 关闭时出错', { error: String(error) });
    });
  }

  /**
   * 调用一个 OneBot action。
   * @param {string} action
   * @param {object} [params]
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<any>} 成功时返回 `data`
   */
  async action(action, params = {}, { timeoutMs } = {}) {
    const connection = this.connection;
    if (connection === null || connection.closed) {
      throw new Error(`OneBot 未连接，无法调用 ${action}`);
    }
    const echo = `${action}-${randomUUID()}`;
    // **字段必须平铺在顶层**：`{action, group_id, message, echo}`。
    //
    // 这里曾经是 `{action, params, echo}`（OneBot 文档里常见的包装形式），
    // 实测被 NapCat 4.18.28 拒绝：它的 handler 把**整个请求体**当参数用，
    // 于是 `e.user_id` / `e.message` 全是 undefined，报
    //   `请指定正确的 group_id 或 user_id`
    // 或更早的 `TypeError: Cannot read properties of undefined (reading 'type')`。
    //
    // 反面证据：`dsh-onebot-qq`（能正常工作的实现）发的就是平铺形式：
    //   {"action":"send_msg","group_id":20001,"message":[...]}
    //
    // 这个坑之所以长期没被发现，是因为**本项目的假服务端不校验格式**，
    // 自产自销时两边都接受（与握手 key 那次同一个教训）。
    const payload = JSON.stringify({ action, ...params, echo });
    const limit = timeoutMs ?? this.actionTimeoutMs;

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot action ${action} 超时（${limit}ms）`));
      }, limit);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(echo, { resolve, reject, timer, action });
    });

    if (!connection.send(payload)) {
      const entry = this.pending.get(echo);
      if (entry !== undefined) {
        clearTimeout(entry.timer);
        this.pending.delete(echo);
      }
      throw new Error(`OneBot 连接不可写，无法调用 ${action}`);
    }
    return promise;
  }

  /**
   * 通用请求：发一个 action、按 `echo` 等回包，**永不 reject**。
   *
   * 与 {@link action} 的唯一差别是失败语义：`action()` 抛异常（发送路径需要知道
   * 失败），`request()` 把超时 / 断线 / 对端报错**一律降级成 `null`**。这是给
   * 「拿不到也不影响主流程」的查询类调用用的（目前只有 `get_msg`，见
   * `gateway.mjs` 的 `#fetchQuoted`）。
   *
   * 两条硬约束，都在实现里体现：
   * 1. **不抛**：调用点挂在提示词拼装路径上，抛出去会带走一整轮；
   *    这里连 `log` 都不冒进（`log` 走 `emit`，监听方也可能抛）。
   * 2. **不拖**：超时由调用方给（`timeoutMs`），默认继承 `actionTimeoutMs`
   *    （15s，那是给发送路径的）。查询类调用必须自己传小的值。
   *
   * @param {string} action
   * @param {object} [params]
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<any|null>} 成功时的 `data`；任何失败都是 `null`
   */
  async request(action, params = {}, { timeoutMs } = {}) {
    try {
      if (!this.isReady) return null;
      return await this.action(action, params, { timeoutMs });
    } catch (error) {
      try {
        this.log('debug', `action ${action} 失败（调用方按拿不到处理）`, {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        /* 日志都别信：见 `#deliverEvent` 的说明 */
      }
      return null;
    }
  }

  /**
   * 发消息（统一走 `send_msg`）。
   *
   * **刻意不用 `send_group_msg` / `send_private_msg`**：那两个是 OneBot 的
   * 便捷别名，而 `send_msg` 是所有实现都认的标准入口——实测 NapCat 4.18.28
   * 上 `send_msg` + 顶层平铺可用，`dsh-onebot-qq` 用的也是这个。
   * @param {{kind: 'group'|'private', target: string, message: any}} request
   */
  async sendMsg({ kind, target, message }) {
    const params = { message };
    if (kind === 'group') params.group_id = toNumeric(target);
    else params.user_id = toNumeric(target);
    const data = await this.action('send_msg', params);
    return data?.message_id;
  }

  /** 发群消息。`message` 可以是字符串或段数组。 */
  async sendGroupMsg(groupId, message) {
    return this.sendMsg({ kind: 'group', target: groupId, message });
  }

  /** 发私聊消息。 */
  async sendPrivateMsg(userId, message) {
    return this.sendMsg({ kind: 'private', target: userId, message });
  }

  /** 通用发送：按会话类型分派。 */
  async sendToChat(chatId, message) {
    const { kind, target } = splitChatId(chatId);
    return this.sendMsg({ kind, target, message });
  }

  /** 探活 + 学习机器人 QQ。 */
  async getLoginInfo() {
    return this.action('get_login_info');
  }

  /** 群列表（主动发言选群、诊断用）。 */
  async getGroupList() {
    return this.action('get_group_list');
  }

  /** 撤回消息。 */
  async deleteMsg(messageId) {
    return this.action('delete_msg', { message_id: toNumeric(messageId) });
  }

  /**
   * 处理一个入站文本帧。响应走 `echo` 关联，其余当事件。
   *
   * `origin` 是这条帧到达的那条连接。应答必须用它，**不能用 `this.connection`**：
   * `attach()` 要在身份探测之后才赋值 `this.connection`，而对端可能在握手完成后
   * 立刻发问——那一刻 `this.connection` 还是 null，用它会让应答被静默吞掉，
   * 表现为对端 `get_login_info` 一直超时。
   * @param {string} text
   * @param {import('./ws.mjs').WebSocketConnection} [origin]
   */
  handleFrame(text, origin) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log('warn', '收到无法解析的帧（非 JSON），已忽略', {
        preview: text.slice(0, 200),
      });
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;

    // 对方问我们（我们是 OneBot 服务端一侧）。这在使用传输层充当 NapCat 替身、
    // 或在反向模式下做自检时才需要。
    // responder 必须在构造时注入——对端可能在握手过程中立刻发问，那时 start()
    // 还没返回，事后再替换实例方法就晚了。
    if (typeof parsed.action === 'string') {
      const target = origin ?? this.connection;
      const reply = (payload) => {
        if (target === null || target === undefined || target.closed) return;
        target.send(JSON.stringify({ ...payload, echo: parsed.echo }));
      };
      if (this.onAction === undefined) {
        // 没有 responder 也要明确回一个失败：静默吞掉会让对端的 action()
        // 一直挂到超时，排查时看不到任何线索。
        reply({
          status: 'failed',
          retcode: 1,
          msg: `本端没有注册 action 应答器，无法处理 ${parsed.action}`,
        });
        return;
      }
      Promise.resolve()
        .then(() => this.onAction(parsed.action, parsed.params ?? {}))
        .then(
          (data) => reply({ status: 'ok', retcode: 0, data: data ?? {} }),
          (error) =>
            reply({
              status: 'failed',
              retcode: 1,
              msg: error instanceof Error ? error.message : String(error),
            }),
        );
      return;
    }

    // 响应帧：带 echo 且有人等。
    if (typeof parsed.echo === 'string' && this.pending.has(parsed.echo)) {
      const entry = this.pending.get(parsed.echo);
      this.pending.delete(parsed.echo);
      clearTimeout(entry.timer);
      if (parsed.status === 'ok' || parsed.retcode === 0) {
        entry.resolve(parsed.data);
      } else {
        entry.reject(
          new Error(
            `OneBot action ${entry.action} 失败：status=${parsed.status} retcode=${parsed.retcode} ${
              parsed.msg ?? parsed.wording ?? ''
            }`.trim(),
          ),
        );
      }
      return;
    }

    // 带了 echo 但没人等（超时后迟到）：静默丢弃，不算错误。
    //
    // ⚠️ **这一支必须排在事件分发【之前】**（2026-11-04 挪上来）。判据是
    // 「带 `echo` 的帧**一律**是 action 回包，不是事件」—— 顺序反过来的话，
    // 一个迟到回包只要同时带了 `post_type` 就会被当成消息事件送进
    // engine（表现为一条来路不明的消息、甚至触发一轮回复）。现在没有哪个
    // 真实 NapCat 事件会带 `echo`，但这条判据不该依赖对端的行为。
    if (typeof parsed.echo === 'string') {
      this.log('debug', '收到无人等待的 action 响应（多半是已超时）', {
        echo: parsed.echo,
      });
      return;
    }

    // 事件帧。
    if (typeof parsed.post_type === 'string') {
      this.learnSelfId(parsed);
      this.emitEventFrame(parsed);
      return;
    }
    this.log('debug', '收到无法归类的事件帧', { preview: text.slice(0, 200) });
  }

  /**
   * 把一条入站事件交给监听方（`event`）。
   *
   * 只有**事件里真的带 `b23.tv` 短链**时才会晚一拍：先等展开（最多 1s，见
   * `short-link.mjs` 的三条硬规矩），把结果写回段对象再 emit；其余情况
   * **同步** emit，行为和加这个特性之前一个字不差。
   *
   * ⚠️ **这里绝不能抛**。它挂在 socket 的 `message` 回调里，抛出去就是
   * `dsh: fatal uncaught exception` ⇒ 宿主退出。2026-11-03 连崩两次就是这么来的：
   * 调用点先改成 `this.emitEventFrame(parsed)`、方法还没写，
   * `TypeError: this.emitEventFrame is not a function`。所以展开器抛错 /
   * 展开 Promise reject / 监听方抛错，**三条路都降级成日志**。
   *
   * @param {any} event
   */
  emitEventFrame(event) {
    const expander = this.shortLinks;
    let prepared = null;
    if (expander !== false && expander !== null && expander !== undefined) {
      try {
        prepared = expander.prepareEvent(event);
      } catch (error) {
        this.log('warn', '短链展开准备失败，按无短链处理', {
          error: error instanceof Error ? error.message : String(error),
        });
        prepared = null;
      }
    }
    if (prepared === null || prepared === undefined || typeof prepared.then !== 'function') {
      this.#deliverEvent(event);
      return;
    }
    prepared.then(
      () => this.#deliverEvent(event),
      (error) => {
        this.log('warn', '短链展开失败，照常派发事件', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.#deliverEvent(event);
      },
    );
  }

  /**
   * 真正 `emit('event')` 的那一刻：**兜住监听方的异常**。
   *
   * 监听方（gateway）里漏一个 catch 就会顺着 socket 回调把宿主带走，代价是整个
   * profile 被砍成 661 B（见 `qq-plugin/AGENTS.md` 第七节）。
   * @param {any} event
   */
  #deliverEvent(event) {
    try {
      this.emit('event', event);
    } catch (error) {
      // 连日志都别信：`log` 走的是 `emit('log')`，它的监听方也可能抛。
      try {
        this.log('error', '事件监听方抛异常（已拦下，未让它带走宿主）', {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        /* 无处可报，但绝不往外抛 */
      }
    }
  }

  /** 从事件里学习机器人 QQ。 */
  learnSelfId(event) {
    if (this.botQQ !== '') return;
    const selfId = event.self_id;
    if (selfId === undefined || selfId === null) return;
    const text = String(selfId);
    if (!/^\d+$/.test(text)) return;
    this.botQQ = text;
    this.log('info', `已从事件学到机器人 QQ：${text}`, {});
  }

  /**
   * 挂上一条已就绪的连接。反向/正向两条路都汇到这里。
   * @param {import('./ws.mjs').WebSocketConnection} connection
   */
  async attach(connection) {
    const generation = ++this.generation;

    // 同一时刻只保留一条连接：NapCat 重连时旧的可能还没断。
    const previous = this.connection;
    if (previous !== null && previous !== connection) {
      this.log('info', '已有连接，替换为新的（多半是对端重连）', {});
      previous.close(1000, 'replaced');
    }
    this.connection = connection;
    this.state = STATE.CONNECTING;

    connection.on('message', (text) => {
      if (generation !== this.generation) return;
      // 最后一层兜底：这条回调是 socket 直接调进来的，抛出去 = 宿主退出
      // （`qq-plugin/AGENTS.md` 第三节）。收帧逻辑本身已尽量不抛，但这里
      // 不能再指望"以后也不会有人加一行会抛的代码"。
      try {
        this.handleFrame(text, connection);
      } catch (error) {
        this.log('error', '处理入站帧时抛异常（已拦下，未让它带走宿主）', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    connection.on('error', (error) => {
      if (generation !== this.generation) return;
      this.log('warn', '连接出错', { error: error.message });
    });
    connection.on('close', (code, reason) => {
      if (generation !== this.generation) return;
      try {
        this.onDown(`closed code=${code}${reason === '' ? '' : ` reason=${reason}`}`);
      } catch (error) {
        this.log('error', '处理断线时抛异常（已拦下，未让它带走宿主）', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // 就绪收尾。注意两种模式的差别，这里曾经是个真实缺陷：
    //
    // 反向 WS 里，**NapCat 才是「客户端/应用端」**，QQ 身份在它手里，它不会回应
    // 我们发出的问询。早期实现把"发 get_login_info 探身份"无差别地套在两种模式上，
    // 结果反向模式永远在等一个不会来的答复，每次连接白等一个 action 超时，
    // 而且因为超时被宽容吞掉，问题只在日志里表现为一句 warning。
    // 所以：正向模式才探测；反向模式靠事件学 self_id。
    if (this.probesIdentity) {
      try {
        const info = await this.getLoginInfo();
        if (generation !== this.generation) return;
        if (info !== null && typeof info === 'object') {
          const userId = info.user_id;
          if (userId !== undefined && userId !== null) {
            const text = String(userId);
            if (/^\d+$/.test(text)) this.botQQ = text;
          }
        }
      } catch (error) {
        // 探测失败不致命：有些实现握手后极短时间内还没准备好。
        this.log('warn', 'get_login_info 失败，仍按已连接处理', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (this.botQQ === '') {
      this.log(
        'info',
        '反向模式不在连接时探测身份（NapCat 才是应用端）；botQQ 将从上报告事件里学习，或由配置显式指定。',
        {},
      );
    }
    if (generation !== this.generation) return;

    this.state = STATE.READY;
    this.failures = 0;
    this.log('info', `OneBot 已就绪（${this.mode}）`, { selfId: this.botQQ });
    this.emit('ready', { selfId: this.botQQ });
  }

  /**
   * 连接断开：拒绝在途请求并发 `down`。子类负责安排重连。
   * @param {string} reason
   */
  onDown(reason) {
    if (this.state === STATE.STOPPED) return;
    this.connection = null;
    this.failAllPending(`连接断开：${reason}`);
    this.log('warn', `OneBot 连接断开：${reason}`, {});
    this.emit('down', { reason });
  }

  /**
   * 由子类在连接断开后调用，安排一次带退避的重连。
   * @param {() => Promise<void>} retry
   */
  scheduleRetry(retry) {
    if (this.stopping) return;
    if (this.retryTimer !== null) return;
    this.failures += 1;
    if (this.reconnectMaxAttempts > 0 && this.failures > this.reconnectMaxAttempts) {
      this.state = STATE.STOPPED;
      const message =
        `连续 ${this.reconnectMaxAttempts} 次重连失败，已放弃。` +
        '修好 NapCat / 网络后重启 DSH，或把 reconnectMaxAttempts 设为 0 改为无限重连。';
      this.log('error', message, {});
      this.emit('give-up', { attempts: this.failures, reason: message });
      return;
    }
    const delay = backoffDelay(this.failures, this.random);
    this.state = STATE.RETRYING;
    this.log('info', `${delay}ms 后重连（第 ${this.failures} 次）`, {});
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopping) return;
      Promise.resolve()
        .then(() => retry())
        .catch((error) => {
          this.log('warn', '重连尝试失败', {
            error: error instanceof Error ? error.message : String(error),
          });
          this.scheduleRetry(retry);
        });
    }, delay);
    if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
  }

  /**
   * 拒绝所有在途 action，避免调用方干等超时。
   * @param {string} reason
   */
  failAllPending(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

/**
 * 反向模式：我们监听，NapCat 拨入。
 */
export class ReverseTransport extends OneBotTransport {
  constructor(options = {}) {
    super({ mode: 'reverse', ...options });
    /** @type {import('node:http').Server|null} */
    this.server = null;
  }

  /** @override */
  async _open() {
    if (this.server !== null) return;
    if (this.accessToken === '') {
      // fail-closed：没有 token 的 WS 监听端口等于把机器人控制权开放给整个局域网。
      throw new Error(
        '反向模式必须配置 accessToken：空 token 的监听端口会让同网段任何人都能控制这个 QQ 号。请在 NapCat 与插件两侧填同一个 token。',
      );
    }
    const server = http.createServer((req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('dsh-qq-onebot: this port speaks WebSocket only\n');
    });
    this.server = server;
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });
    this.state = STATE.CONNECTING;
    this.log('info', `反向 WS 已监听 ws://${this.host}:${this.port}/`, {});
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  handleUpgrade(req, socket, head) {
    const token = extractToken(req);
    if (token !== this.accessToken) {
      this.log('warn', '拒绝一个 token 不匹配的 WS 连接', { url: req.url ?? '' });
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    // 校验 key 合规性，与 `ws` 库的行为对齐。
    //
    // 早先这里只判"非空"，于是**畸形握手也能通过**——而真实实现（NapCat 用的
    // `ws` 库）会以 400 拒绝。这个不对称造成的后果很隐蔽：我自己的假客户端
    // 生成的是 22 字符 key（不合规），却因为服务端不校验而一路绿灯，
    // 于是"正向模式能不能连上真实服务端"这件事从来没被真正验证过。
    if (!isValidHandshakeKey(key)) {
      this.log('warn', '拒绝一个 Sec-WebSocket-Key 不合规的 WS 连接', {
        url: req.url ?? '',
        keyLength: typeof key === 'string' ? key.length : -1,
      });
      socket.write(
        'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n' +
          'Content-Type: text/plain\r\nContent-Length: 43\r\n\r\n' +
          'Invalid Sec-WebSocket-Key (need 24-char base64)',
      );
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    const connection = wrapSocket(socket, {
      isServer: true,
      maxPayload: this.maxPayload,
    });
    // head 是升级请求之后、已经到达的那部分帧字节。只喂给解码器，
    // 不要 unshift 回明文 socket（TCP 层已经把'data'事件排在'upgrade'之后了）。
    connection.feed(head);
    void this.attach(connection).catch((error) => {
      this.log('warn', 'attach 失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** @override */
  async _shutdown() {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    // 🔴 2026-10-20：`server.close(cb)` **只是"不再接受新连接"，而 cb 要等所有
    //    已有连接断开才触发** —— 反向模式下 NapCat 一断就立刻重连，可能在我们
    //    close 的窗口里又挂上来一条，于是这个 await 永远不返回。
    //
    //    后果是"静默半死"（实测）：插件卸载卡在这里 ⇒ 旧实例的 server 还在、
    //    旧 gateway 还收得到消息（能写 `gw-send`），但它挂在 transport 上的
    //    出站台账包装早被 `uninstall` 拆了 ⇒ **只有 gw-send、没有 transport-action**，
    //    消息发不出去；而新实例因为端口被占（或刚释放）也接不上，快照里
    //    `received` 一直是 0。
    //
    //    ⇒ 主动砍掉所有连接，再给 close 一个**有上限的等待**，绝不允许无限挂起。
    const closed = new Promise((resolve) => server.close(() => resolve()));
    try {
      // Node 18.2+：一次性关闭该 server 上的全部连接。
      server.closeAllConnections?.();
    } catch { /* 老版本没有这个方法，下面还有超时兜底 */ }
    await Promise.race([
      closed,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        if (typeof timer?.unref === 'function') timer.unref();
      }),
    ]);
  }
}

/**
 * 正向模式：我们拨号到 NapCat 的 WS 服务端。
 */
export class ForwardTransport extends OneBotTransport {
  constructor(options = {}) {
    super({ mode: 'forward', ...options });
    /** @type {import('node:net').Socket|null} */
    this.socket = null;
  }

  /** @override */
  async _open() {
    await this.connect();
  }

  /** 建立一次连接（失败向上抛，由重连逻辑接住）。 */
  async connect() {
    this.state = STATE.CONNECTING;
    const target = new URL(this.url);
    const isSecure = target.protocol === 'wss:';
    const port = target.port === '' ? (isSecure ? 443 : 80) : Number(target.port);
    const path = `${target.pathname === '' ? '/' : target.pathname}${target.search}`;

    // 无论有没有 token 都必须走 HTTP 握手：早先的实现把"无 token"分支写成
    // 只 `net.connect` 建连、却**从不发送 Upgrade 请求**，于是服务端一直在等
    // 握手，而客户端已经在等响应——表现为 get_login_info 必然超时。
    const upgraded = await this.handshakeOverHttp(
      target.hostname,
      port,
      path,
      makeHandshakeKey(),
      this.accessToken,
      isSecure,
    );
    const socket = upgraded.socket;
    const head = upgraded.head;

    const connection = wrapSocket(socket, { isServer: false, maxPayload: this.maxPayload });
    this.socket = socket;
    // 重连必须挂在 `down` 上，而不能靠 socket 的 'close' 事件去对比
    // `this.connection === connection`：onDown 会先把 this.connection 置空，
    // 那个比较恒为假，结果是 NapCat 一重启我们就永久停在断开状态、再也不连。
    this.once('down', () => {
      if (this.stopping) return;
      this.scheduleReconnect();
    });
    // 同反向模式：head 是已经到达的帧字节，只能喂给解码器。
    connection.feed(head);
    await this.attach(connection).catch((error) => {
      this.log('warn', 'attach 失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * 走 HTTP Upgrade 完成握手（需要带 Authorization 头，所以不能用裸 socket）。
   * @returns {Promise<{socket: import('node:net').Socket, head: Buffer|undefined}>}
   */
  handshakeOverHttp(host, port, path, key, token, isSecure) {
    if (isSecure) {
      throw new Error('暂不支持 wss://（需要 TLS 客户端实现），请改用 ws:// 或反向模式');
    }
    return new Promise((resolve, reject) => {
      const req = http.request({
        host,
        port,
        path,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
          Authorization: `Bearer ${token}`,
        },
      });
      req.on('upgrade', (_res, socket, head) => resolve({ socket, head }));
      req.on('response', (res) => {
        reject(
          new Error(`WS 握手被拒绝：HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim()),
        );
        res.resume();
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** 连接断开后安排重连。 */
  scheduleReconnect() {
    if (this.stopping) return;
    this.scheduleRetry(() => this.connect());
  }

  /** @override */
  async _shutdown() {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null && !socket.destroyed) socket.destroy();
  }
}

/**
 * HTTP 传输层：**只发不收**，直接打 NapCat 的 HTTP API。
 *
 * 这是「与 `dsh-onebot-qq` 共存」方案（P3）的关键。原因：
 * `dsh-onebot-qq` 在反向 WS 模式里要**独占**监听端口（NapCat 只拨一条连接，
 * 而且它的实现注释写明 `Last-wins: NapCat expects a single dial-in`，
 * 新连接会顶掉旧连接）。所以本项目**不能再抢那个 WS 端口**，
 * 改走 NapCat 的另一条独立通道（HTTP API），两条并存、互不干扰。
 *
 * 代价：收不到任何事件（没有 WS 就没有推送）。所以这个模式**只能主动发言**，
 * 不能做被动回复——被动回复交给 `dsh-onebot-qq`。
 *
 * 用法：`mode: 'http'` + `httpUrl`（如 `http://127.0.0.1:3000`）+ `accessToken`。
 */
export class HttpTransport extends OneBotTransport {
  /** HTTP 模式没有长连接，"就绪"= 探活成功过。 */
  #alive = false;

  constructor(options = {}) {
    super(options);
    const raw = String(options.httpUrl ?? '').trim();
    if (raw === '') throw new Error('HTTP 模式必须配置 httpUrl');
    this.httpUrl = raw.replace(/\/+$/, '');
  }

  /**
   * @override HTTP 模式没有 WS 连接，`isReady` 不能沿用基类
   * （基类要求 `connection !== null`，这里永远是 null）。
   */
  get isReady() {
    return this.#alive;
  }

  /** @override 无需建立长连接，只探活一次。 */
  async _open() {
    // 探活：确认 endpoint 通、token 对。失败会抛出，让调用方看到真实原因。
    const info = await this.#post('get_login_info', {});
    if (info !== null && typeof info === 'object' && info.user_id !== undefined) {
      // selfId 是只读 getter（返回 botQQ），所以写 botQQ。
      this.botQQ = String(info.user_id);
    }
    this.#alive = true;
    this.emit('ready', { selfId: this.botQQ });
    this.log('info', 'OneBot HTTP 已就绪（只发不收）', { selfId: this.botQQ, url: this.httpUrl });
  }

  /** @override 没有长连接要断。 */
  async _shutdown() {
    this.#alive = false;
    this.pending.clear();
  }

  /**
   * @override 走 HTTP POST，不用 WS。
   *
   * 格式与 WS 路径一致：**字段平铺在顶层**（`{action, ...params, echo}`）。
   * NapCat 4.18.28 的 handler 把整个请求体当参数用，包装成 `params` 会被拒。
   */
  async action(action, params = {}, { timeoutMs } = {}) {
    const limit = timeoutMs ?? this.actionTimeoutMs;
    const echo = `${action}-${randomUUID()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const data = await this.#post(action, { ...params, echo }, controller.signal);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 发一次 POST 并解包 OneBot 应答信封。
   * @param {string} action
   * @param {object} body
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>} 成功时返回 `data`
   */
  async #post(action, body, signal) {
    const url = `${this.httpUrl}/${encodeURIComponent(action)}`;
    const headers = { 'content-type': 'application/json' };
    // 两种鉴权写法都带上，兼容 NapCat 的不同版本
    if (this.accessToken !== '') {
      headers.authorization = `Bearer ${this.accessToken}`;
      headers['x-self-id'] = this.selfId;
    }
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, ...body }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`OneBot HTTP ${action} 超时（${this.actionTimeoutMs}ms）`);
      }
      throw new Error(`OneBot HTTP ${action} 请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`OneBot HTTP ${action} 返回 ${response.status}`);
    }
    let envelope;
    try {
      envelope = await response.json();
    } catch (error) {
      throw new Error(`OneBot HTTP ${action} 应答不是 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    if (envelope === null || typeof envelope !== 'object') {
      throw new Error(`OneBot HTTP ${action} 应答格式异常`);
    }
    if (envelope.status === 'failed' || (typeof envelope.retcode === 'number' && envelope.retcode !== 0)) {
      // NapCat 失败时把异常塞在 message 里，原样透传便于排查
      throw new Error(`OneBot HTTP ${action} 失败：${String(envelope.message ?? envelope.wording ?? '未知原因')}`);
    }
    return envelope.data;
  }
}

/**
 * 按配置创建传输层。
 *
 * - `mode: 'reverse'` —— 反向他连（本项目当服务端），能收能发
 * - `mode: 'forward'` —— 正向我们连（本项目当客户端），能收能发
 * - `mode: 'http'`    —— 只打 NapCat 的 HTTP API，**只发不收**
 *                        （与 `dsh-onebot-qq` 共存时用这个，避免抢 WS 端口）
 * @param {object} config
 * @returns {OneBotTransport}
 */
export function createTransport(config = {}) {
  if (config.mode === 'http') return new HttpTransport(config);
  return config.mode === 'forward' ? new ForwardTransport(config) : new ReverseTransport(config);
}

/**
 * 拆分 chatId。
 * @param {string} chatId 形如 `group:123` / `private:456`
 * @returns {{kind: 'group'|'private', target: string}}
 */
export function splitChatId(chatId) {
  const index = String(chatId ?? '').indexOf(':');
  const kind = index === -1 ? '' : String(chatId).slice(0, index);
  const target = index === -1 ? '' : String(chatId).slice(index + 1);
  if (kind === 'group' || kind === 'private') return { kind, target };
  throw new Error(`无效的 chatId：${JSON.stringify(chatId)}`);
}

/** OneBot 的 ID 字段多为整数，但实现之间不一致；发出去时统一成数字。 */
function toNumeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '');
  if (!/^-?\d+$/.test(text)) throw new Error(`无效的 OneBot ID：${JSON.stringify(value)}`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`OneBot ID 超出安全整数范围：${text}`);
  }
  return parsed;
}
