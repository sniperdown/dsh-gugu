# dsh-qq-proactive

给 DSH 加一个**能自己开口**的 QQ 通道。走 NapCat / OneBot 11，零外部依赖。

```
用户(QQ) ←→ NapCat ←→ 本插件 ──┬─ 被动回复：@我 / 私聊
                                ├─ 主动插话：群里聊到相关话题时自己冒泡
                                └─ 工作汇报：工作会话干完一段同步到群
```

每个 QQ 会话对应**一个独立的持久 DSH 会话**：群归群、私聊归私聊，互不污染上下文，
重启后按稳定派生的会话键 resume 回原来的对话。

## 状态

**端到端已真机跑通**：一条真实 OneBot 私聊消息走完全链路，模型回复并经
`send_private_msg` 发回。群聊 @ 回复、**群聊话题主动插话**、**工作完成汇报**、
**私聊进主会话（`dmRouting: main`）**、Web GUI 设置页均已真机验证。
当前 **2221 条用例**（104 个文件），除 1 条已知长期红外全绿 —— 见下文「跑测试」。

其中 [`test/acceptance.test.mjs`](test/acceptance.test.mjs) 是跨模块验收：装一整套真实
protocol / Router / ProactiveEngine / gateway（只把传输层与会话换掉），
把**不同实现形态**的事件喂进去，断言直接打在**发出去的 OneBot 报文**上——
段数组、CQ 串、`&amp;` 转义、字符串型 id、纯媒体消息、重复投递、自循环、
会话隔离、主动插话的准入拦截、超长截断。

```
[fake-napcat] 插件 -> 我: {"action":"send_private_msg","params":{"user_id":10001,
  "message":"你好！我是 DeepSeek Harness 里的一个编程智能体（coding agent）..."}}
```

验证用的是**一次性隔离环境**（独立 `DSH_HOME` + 从 `app.asar` 抽出的可运行 dsh 树），
不改动你正在用的 profile。

| 模块 | 唯一职责 | 用例 |
|---|---|---|
| [`src/onebot/ws.mjs`](src/onebot/ws.mjs) | 手写 RFC 6455（Node 内置 WebSocket 只有客户端，反向模式要当服务端） | 25 |
| [`src/onebot/protocol.mjs`](src/onebot/protocol.mjs) | OneBot 11 段数组/CQ 码、@ 检测、事件归一化 | 55 |
| [`src/onebot/transport.mjs`](src/onebot/transport.mjs) | 正/反向 WS、action echo 关联、超时、重连退避 | 37 |
| [`src/proactive/engine.mjs`](src/proactive/engine.mjs) | 主动发言闸门与配额（准入排在最前） | 43 |
| [`src/dsh/routing.mjs`](src/dsh/routing.mjs) | 访问控制、会话去向、会话键派生、提示词渲染 | 49 |
| [`src/dsh/gateway.mjs`](src/dsh/gateway.mjs) | 端到端编排（唯一缝四个子系统的地方） | 27 |
| [`src/dsh/binding.mjs`](src/dsh/binding.mjs) | DSH 会话创建/驱动/读取回复（唯一 DSH 耦合点） | 37 |
| [`src/dsh/heuristic-gauge.mjs`](src/dsh/heuristic-gauge.mjs) | 话题判定的确定性实现 | 19 |
| [`src/dsh/report.mjs`](src/dsh/report.mjs) | 工作汇报文案生成（真摘要，不搬模型回复） | 23 |
| [`src/dsh/settings-contract.mjs`](src/dsh/settings-contract.mjs) | 宿主半 ↔ 浏览器半的通信契约 | 28 |
| [`src/dsh/settings-host.mjs`](src/dsh/settings-host.mjs) | 设置页宿主半（RPC + 写回 profile patch 层） | 18 |
| [`client.js`](client.js) | 设置页浏览器半（经典脚本，无需构建） | 11 |
| [`src/index.mjs`](src/index.mjs) | 插件入口与配置校验 | 15 |
| [`test/acceptance.test.mjs`](test/acceptance.test.mjs) | 跨模块验收：真实事件形态进，出站报文出 | 13 |

跑测试（Node ≥ 22，零依赖、零构建、不联网）：

```bash
npm test
```

`npm test` 走 `tools/run-all-tests.mjs`：自己 readdir 扫 `test/*.test.mjs`，
新增测试文件自动跑到，不用手工维护清单。

> ⚠️ 别用裸 `node --test`：它在受限沙箱里 spawn 子进程会失败，
> 表现是"每个文件正好 1 条失败"的假红。要用逐文件隔离模式时用 `npm run test:isolated`。

当前基线：**104 个文件 / 2221 条**。其中 **1 条已知长期红**
（`markdown-outbound` 的「图片段一个字节都不碰」——段形状与实现不一致，
与插件功能无关，属于已知未修项）。除它以外应当全绿。

## 文档

| 文档 | 内容 |
|---|---|
| [架构概览](docs/architecture.md) | 模块边界、消息怎么走、三条硬规则 |
| [接入真实 NapCat](docs/deployment-napcat.md) | 连接模式选择、装进 profile、逐步验证、排错 |
| [主动发言引擎](docs/proactive-engine.md) | 闸门顺序、配额与时间语义 |
| [OneBot 层](docs/onebot-layer.md) | 手写 RFC 6455、双模式、重连、与真机的偏差 |
| [与 dsh-onebot-qq 的对照](docs/comparison-dsh-onebot-qq.md) | 与上游成熟插件的分工、能力差异（含取舍） |
| [NapCat 兼容补丁](docs/napcat-compat-patch.md) | `{action, params}` 包装格式导致的"出站发不出去" |
| [长驻资源的生命周期](docs/resource-lifecycle.md) | 哪些东西必须显式收场、漏了会怎样 |

> `vendor/` 目录是 [dsh-onebot-qq](https://github.com/mario841859784/dsh-onebot) v0.5.1
> 的原始 npm 包与解包内容（BSD-3-Clause），**不是本项目的代码**。
> 它比本项目成熟得多，但没有任何主动发言能力。详见上面的对照文档。

## 设计要点

### 会话去向是显式配置的

| 消息 | 落到哪个会话 |
|---|---|
| 群聊 | 永远 `qq-group-<群号>`（需求要求群聊隔离） |
| 私聊 + `dmRouting: isolated`（默认） | `qq-private-<QQ号>`，每个联系人独立持久会话 |
| 私聊 + `dmRouting: main` | 配置的 `mainSessionKey` 指定的那个会话（"进主会话"） |

`dmRouting: main` **必须**配 `mainSessionKey`（DSH session id，形如 `session-<uuid>`）。
留空会**显式回落到 isolated 并记一条日志**，不会隐式挑一个"主会话"——
否则"它为什么答的是那个会话的内容"会变得极难排查。

会话键是纯字符替换派生的，不含随机数或时间戳：重启后靠它 resume 回原对话。
有测试专门钉住这一点——一旦引入随机成分，群里的人每次重启都会发现机器人失忆。

### 零依赖、零构建

`ws`、`schemastery` 全都不用，连 Node 内置的全局 `WebSocket` 也不用（它只有客户端，
而反向模式要当服务端）。`exports` 直接指向 `src/` 下的 `.mjs`——宿主是按 `exports`
里的字符串拼绝对路径读文件的，所以不需要构建产物。

**刻意不声明 `peerDependencies`**：任何一条 `@deepseek-ai/dsh*` 的范围不匹配都会让宿主
**静默 disable** 这一行；而运行时本来就会把插件 import 的包重定向到宿主安装树的同一实例，
声明它们只有坏处。

### 主动发言是两层判定

群聊里刷屏的代价远大于漏一次，所以第一层是纯算术闸门，**不通就连判定都不做**：

| 顺序 | 条件 | 拒绝原因 |
|---|---|---|
| 1 | 热身不足 | `warming-up` |
| 2 | 安静时段 | `quiet-hours` |
| 3 | 滚动小时配额已满 | `hourly-cap` |
| 4 | 机器人刚说完话 | `cooldown-after-bot` |
| 5 | 未到最小间隔 | `min-interval` |
| 6 | 突发窗口内接话的人太少 | `burst-too-small` |

排查时日志报的是**最根本的那个原因**（说够了就是够了，跟冷却无关），
否则运维看不出真因。

第二层才是话题判定。当前用的是一个**确定性启发式**：只在两个以上不同的人
都在明显求助时才认领一句。它可测、行为可预期、不会因为模型抽风而刷屏。
升级成模型判定只需换掉注入的 gauge，引擎与网关都不用动。

### 默认拒绝

没明确放行的人和群一律不处理。群号/QQ 号的**形状也要校验**——`groupPolicy: 'open'`
意味着"任何群都行"，而空串不是"任何群"，是坏数据；放行它等于让畸形事件绕过整条访问控制。

### 会话键必须稳定

`group:100` → `qq-group-100`，纯字符替换，不含随机数或时间戳。重启后靠它 resume。
有测试专门钉住这一点：一旦引入随机成分，群里的人每次重启都会发现机器人失忆。

## 从零部署（照着做）

### 0. 先准备三样东西

| 东西 | 用来干什么 |
|---|---|
| DSH（桌面版或 CLI） | 插件的宿主，QQ 会话跑在它里面 |
| 一个 QQ 号（建议小号） | 机器人本体，登录在 NapCat 里 |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | 把 QQ 协议转成 OneBot 11 |

### 1. 装插件

把本仓库放到本机任意目录（别放进 `node_modules`），然后装进 DSH 的 profile：

```bash
dsh plugin --profile <你的 profile> add <仓库绝对路径>
```

等价于在 profile 的 `package.json` 里加一条
`"dsh-qq-proactive": "link:<仓库绝对路径>"`。
插件声明了 `dsh.bundle.patch`，装完自动激活 —— 日志里出现
`[qq-proactive] 已挂载` 就是加载成功了。

### 2. 填配置（profile 的 `cordis.patch.yml`）

在最末尾追加一段（**完整字段与逐项说明**见
[docs/config.example.cordis.patch.yml](docs/config.example.cordis.patch.yml)）：

```yaml
- id: qq-proactive
  config:
    mode: reverse                 # 反向：插件当服务端，等 NapCat 拨进来
    host: 127.0.0.1
    port: 8643
    accessToken: '<自己编一个长串，NapCat 那边填同一个>'
    botQQ: '<机器人自己的 QQ>'
    adminUsers: ['<你自己的 QQ>']
    dmPolicy: allowlist
    allowFrom: ['<你自己的 QQ>']
    groupPolicy: allowlist
    groupAllowFrom: ['<要它说话的群号>']
    agentPreset: gugu
    provider: '<你的 provider>'
    model: '<支持识图的模型>'
    workspacePath: '<QQ 会话的工作目录>'
    onlineAnnounce: 'private:<你自己的 QQ>'   # 启动时播报；留空 = 不播报
```

三个会**直接拒绝启动**的坑：`mode` 写错、`accessToken` 留空（反向模式下空 token
等于把 QQ 号控制权开放给同网段）、`adminUsers` 留空（你的私聊会被当"受限用户"，
它不肯干活）。`report.enabled: true` 时 `report.target` 也必填。

### 3. 人格（`qq-gugu.toml`）

把 [docs/config.example.qq-gugu.toml](docs/config.example.qq-gugu.toml) 拷成
`<DSH_HOME>/profiles/<profile>/qq-gugu.toml`，改 `[personality]` 段。

> ⚠️ 键名是 `persona`（2026-11-01 由 `personality` 改名，段名不变）。
> 写成 `personality = "..."` 不会被读到 —— 插件会当成"没配人格"，用内置兜底。

改完**不用重启**：插件每次建会话时现读。

### 4. NapCat 侧

新增「WebSocket 客户端」，上报地址填 `ws://<本机IP>:8643/`，
token 与上面的 `accessToken` 一致。消息上报格式建议选「**数组**」
（段数组是权威，CQ 串只作回退）。

### 5. 第一次验证（按顺序，每步都有判据）

1. **插件挂上了**：DSH 日志里有 `[qq-proactive] 已挂载`。
2. **通道通了**：NapCat 日志里 WebSocket 连接成功；插件日志里能看到 `selfId`。
3. **私聊能回**：用 `adminUsers` 里的号给机器人发一句「在吗」。
   收到回复 ⇒ 入站 → 判定 → agent → 出站整条链路通了。
4. **群里能回**：在白名单群里 `@机器人 在吗`。不回就看日志里的拒绝原因
   （`group-denied` / `group-no-mention` / 主动发言闸门…）。
5. **主动发言**：默认**关**。确认被动回复稳定之后，
   再把 `proactive.enabled` 打开（`[proactive]` 的调参见示例文件）。

## 语音情绪（可选，**权重需自备**）

`[emotion]` 打开后，插件会给每条语音算一个 arousal 分数（**只记录，不进提示词**）。
**仓库里不带模型权重**：`audeering/wav2small` 是 CC-BY-NC-SA-4.0（禁商用、要求相同方式共享），
与 MIT 不兼容，不能随仓库分发。

要用它：

1. 自己拿一份权重（`model.safetensors`），放到 `<DSH_HOME>/qq-gugu/models/`，
   或在 `qq-gugu.toml` 里配 `[emotion] model_dir = "<目录>"`；
2. 配 `[emotion] python = "<带 torch + safetensors + soxr 的 python>"`；
3. `[emotion] enabled = true`。

拿不到权重时**优雅降级**：快照里记一条 `notReadyReason`，其余功能一个字节都不受影响。

## 运维

- **日志**：每条被忽略的消息都带原因（`dm-denied(admin)`、`group-no-mention`、`duplicate`…），
  排查"为什么机器人不回我"从日志看即可。
- **去重**：OneBot 断线重连会补发最近事件，按 `message_id` 去重，不会重复回复。
- **断线**：指数退避 + 抖动重连（2s→60s 封顶）。`reconnectMaxAttempts: 0` = 无限重连。
  断线时在途 action 立刻被 reject，不让调用方干等超时。
- **串行**：同一会话的两轮串行执行（并发回复在 QQ 里看起来像精神分裂），
  不同会话之间可以并发。
- **内存**：空闲会话会定期释放（`sessionIdleEvictHours`）。会话已持久化，之后能 resume 回来。

## 仓库里**没有**什么（以及为什么）

| 没有 | 为什么 |
|---|---|
| 真实人格 `qq-gugu.toml` | 那是使用者私人写的东西（人格正文、按群覆盖、私聊专用人格），只存在他本机 |
| 任何 QQ 号 / 群号 / 昵称 | 仓库里的都是假号（`3000000x` 起）；真号属于使用者**和别人** |
| 记忆与关系数据 | `knowledge.json` / `learned-memory.json` / 关系记账里有别人的信息和推断 |
| 运行日志、台账、信箱 | 属于运行期产物，会随使用不断变化 |
| 模型权重 | `wav2small` 是 CC-BY-NC-SA-4.0，与 MIT 不兼容（见上一节） |

`.gitignore` 里每一条都写了理由，照着看即可。

## 许可证

**MIT**，全文见 [LICENSE](LICENSE)。仓库内的代码与文档均为 MIT。
仓库**不含任何非 MIT 资产**：模型权重不在仓库里（见「语音情绪」一节），
`preview/vendor/` 里是 React 的开发版构建（MIT，见文件头注释）。

`docs/` 里提到的上游项目（[dsh-onebot-qq](https://github.com/mario841859784/dsh-onebot)、
[MaiBot](https://github.com/Mai-with-u/MaiBot) 等）版权归各自作者，本项目只引用其思路与对照结论。
