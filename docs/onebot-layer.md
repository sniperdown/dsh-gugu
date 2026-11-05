# OneBot 11 连接层（自研部分）

零依赖、纯 Node 内置实现的 OneBot 11 客户端/服务端。不引 `ws`、不引任何三方库。

## 为什么手写而不用现成的

1. **Node 内置的全局 `WebSocket` 只有客户端**，而 OneBot 的**反向 WS** 模式要求我们当
   **服务端**监听、接受 NapCat 拨入。这是必须支持的模式（NAT 后面的 NapCat 不必开入站端口）。
2. **`ws` 是外部依赖**。第三方插件在宿主里的模块解析不可控（profile 的 node_modules 解析链
   + peer 重定向），能不加就不加。

代价是要自己实现 RFC 6455。范围已收窄到 OneBot 用得到的部分：文本帧、分片、ping/pong、close，
不做 permessage-deflate。

## 文件

| 文件 | 职责 | 测试 |
|---|---|---|
| [`src/onebot/ws.mjs`](../src/onebot/ws.mjs) | RFC 6455：握手 accept-key、帧编解码、分片、掩码、连接对象 | [25 例](../test/ws.test.mjs) |
| [`src/onebot/protocol.mjs`](../src/onebot/protocol.mjs) | 段数组/CQ 码解析、@ 检测、事件归一化、出站组装 | [55 例](../test/protocol.test.mjs) |
| [`src/onebot/transport.mjs`](../src/onebot/transport.mjs) | 正/反向 WS、action 关联、超时、重连退避 | [37 例](../test/transport.test.mjs) |

跑测试：

```powershell
& '<DSH_HOME>\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' `
  --test --test-force-exit test/engine.test.mjs test/protocol.test.mjs test/ws.test.mjs test/transport.test.mjs
```

## 两种模式

| | reverse（推荐） | forward |
|---|---|---|
| 谁拨号 | NapCat 拨入我们 | 我们拨到 NapCat |
| 监听 | `host:port`，必须配 `accessToken` | — |
| 目标 | — | `url`（`ws://…`） |
| 身份 | **不在连接时探测**，从事件学或配置给 | 连接后发 `get_login_info` 探测 |
| token 走哪 | `Authorization: Bearer` 或 `?access_token=` | `Authorization: Bearer` |

### 反向模式为什么必须有 token

空 token 的 WS 监听端口 = 把 QQ 号的控制权开放给整个同网段。所以
`ReverseTransport._open()` 在 token 为空时**直接拒绝启动**（fail-closed），
不是打个警告继续跑。

### 两种模式的身份语义不同（踩过的坑）

反向 WS 里 **NapCat 才是「应用端/客户端」**，QQ 身份在它手里，它**不会回应**我们发出的问询。
早期实现把"连接后发 `get_login_info` 探身份"无差别地套在两种模式上，结果是：

- 反向模式每次连接都白等一个 15 秒的 action 超时；
- 因为超时被宽容吞掉，问题只在日志里表现为一句 warning；
- 更容易误判的是：**测试里拿 `ForwardTransport` 当 NapCat 替身时，这个缺陷会伪装成
  "ready 等不到"，把排查引向完全错误的方向**（它确实耗掉了我好几轮）。

现在由 `this.probesIdentity`（正向 true / 反向 false）控制。

## 重连

指数退避 + ±20% 抖动，2s 起、60s 封顶。`reconnectMaxAttempts` 默认 0 = 无限重连；
设为正数则连续失败达到上限后发 `give-up` 事件并停止（避免在日志里无限刷）。

重连**挂在 `down` 事件上**，而不是靠 socket 的 `'close'` 去对比 `this.connection === connection`。
后者恒为假——`onDown` 会先把 `this.connection` 置空——结果是 NapCat 一重启就永久失联。

## action 语义

- 请求：`{action, params, echo}`；响应：`{status, retcode, data, echo}`。
- 断线时**立刻 reject 所有在途 action**，不让调用方干等超时（既是体验也是泄漏）。
- 超时默认 15s，可配；超时后该条从 `pending` 移除。
- 收到**无人等待的 echo** 只记 debug 日志，不算错误（多半是超时后迟到）。

### 充当服务端一侧

`onAction` 选项让连接可以应答对方发来的 action。两个必须注意的点：

1. 必须在**构造时**注入，不能 `start()` 之后替换 `handleFrame` —— 对端可能在握手过程中
   立刻发问，那时 `start()` 还没返回。**这一点是实测出来的**：事后替换会让应答静默失效。
2. 回包必须用 `attach` 持有的那条 connection，**不能用 `this.connection`** ——
   `attach` 要先发出身份探测才赋值 `this.connection`，用它同样会让应答被吞掉。

没有 `onAction` 时收到 action 会**明确回一个 failed 响应**，而不是静默吞掉——
对端的 `action()` 有权拿到一个明确答复，否则会一直挂到超时。

## 真机偏差（协议层已吸收）

| 现象 | 处理 |
|---|---|
| NapCat 把 URL 里的 `&` 转成 `&amp;`（去下载图片 403） | 段数组的**所有字符串值**都过一遍 CQ 反转义，不只 CQ 串 |
| 段数组与 CQ 串不一致 | **段数组是权威**，绝不回头查 `raw_message` |
| 只给 `raw_message` 不给段数组的老实现 | 走 CQ 解析回退 |
| 昵称里带换行/控制字符 | 替换成空格再压空白（直接删会让字粘在一起），截断 32 字 |
| 不知道机器人 QQ | @ 检测 **fail-closed**：一律视为未 @ |
| 群系统提示混进 message 事件 | `sub_type === 'notice'` 直接丢弃 |
| `message` 与 `raw_message` 双双缺失 | 视为坏事件返回 `null`，不喂空文本进上下文 |
| 时间戳缺失 | 回落当前时刻，不崩 |
| 机器人自己发的消息 | 默认忽略，防自循环 |

## RFC 6455 实现要点

- `Sec-WebSocket-Accept` 命中 RFC 官方示例值（有测试钉住）。
- 增量解码器：**半帧跨 chunk、一个 chunk 多帧、分片重组**都有专门用例。
- 掩码方向严格校验：服务端方向收到未加掩码的帧 = 协议违例。
- 控制帧不得分片、载荷 ≤125 字节。
- `maxPayload` 默认 8 MiB，单帧或分片合并超限直接断开（拒绝内存放大）。
- **HTTP 升级的 `head` 只能喂给解码器，不能 `socket.unshift` 回去** ——
  塞回明文 socket 会让解码器先读到 HTTP 尾部残渣，报出「RSV 位被置位」这种完全
  指错方向的错误。反向模式与正向模式都要处理这一点（正向的 `http.request`
  升级回调也会给出 `head`）。
