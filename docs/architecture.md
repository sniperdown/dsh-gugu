# 架构概览

一句话：**一个 QQ 会话 = 一个独立的 DSH 持久会话**，插件夹在 NapCat 与 DSH 之间，
决定"这条消息要不要处理、交给谁、说什么、发给谁"。

```text
QQ 用户 ←→ NapCat ←→ 本插件 ──┬─ 被动回复：@我 / 私聊
                              ├─ 主动插话：群里聊到相关话题时自己冒泡
                              └─ 内部唤醒：定时/系统事件叫醒它，结果发回私聊
```

## 模块与职责边界

| 模块 | 唯一职责 |
|---|---|
| `src/onebot/ws.mjs` | 手写 RFC 6455。Node 内置 WebSocket 只有客户端，而反向模式要当服务端 |
| `src/onebot/protocol.mjs` | OneBot 11：段数组 / CQ 码、@ 检测、事件归一化 |
| `src/onebot/transport.mjs` | 正/反向 WS、action echo 关联、超时、重连退避 |
| `src/dsh/routing.mjs` | 访问控制、会话去向、会话键派生（**纯函数**，好测） |
| `src/dsh/chat-sessions.mjs` | chatId → DSH 会话 id 的映射与持久化 |
| `src/dsh/binding.mjs` | 与 DSH 的耦合点：建/驱动/取回复、注册工具与提示词段落 |
| `src/dsh/gateway.mjs` | 端到端编排：入站 → 判定 → 会话 → 出站（唯一缝四处的地方） |
| `src/proactive/engine.mjs` | 主动发言的闸门与配额（准入排最前） |
| `src/dsh/paths.mjs` | 插件文件路径的统一解析（`DSH_HOME` / `QQ_GUGU_HOME`） |
| `client.js` + `web/` | 设置页：宿主半与浏览器半，零构建 |

依赖方向是单向的：`onebot/` 不认识 DSH，`routing/engine` 不认识网络，
`gateway` 是唯一同时知道两边的地方。改任何一层都先问「这层该不该知道这件事」。

## 消息怎么走

1. **入站**：NapCat 推事件 → `protocol.normalizeEvent` 归一化 → `router.resolve` 判访问控制
   （`IGNORE` / `OBSERVE` / `DISPATCH`）。
2. **记录**：过闸门之前就写进会话转录 —— 运维要能看见"群里在聊什么"，
   哪怕这条不回复。转录是主动发言与上下文的唯一事实来源。
3. **判定**（只对主动发言）：纯算术闸门先过（热身/时段/配额/冷却/间隔/突发），
   不过就连模型都不调；过了再用启发式 gauge 打总分。
4. **投递**：`binding.ensure` 拿到（或建出）对应 DSH 会话，渲染提示词，跑一轮，取回复。
5. **出站**：所有发送收敛到 `gateway.#send` 一个口子 —— 剥 Markdown、组段数组、
   同文短窗去重、出站白名单、台账记账，都在这一处。

## 三条硬规则

### 1. 会话去向是显式配置的

| 消息 | 落到哪个会话 |
|---|---|
| 群聊 | 永远 `qq-group-<群号>`（群聊隔离） |
| 私聊 + `dmRouting: isolated`（默认） | `qq-private-<QQ号>`，每个联系人独立持久会话 |
| 私聊 + `dmRouting: main` | 配置的 `mainSessionKey` 指定的那个会话 |

会话键是**纯字符替换**派生的，不含随机数或时间戳 —— 重启后靠它 resume 回原对话。
有测试专门钉住这一点：一旦引入随机成分，群里的人每次重启都会发现机器人失忆。

### 2. 默认拒绝

没明确放行的人和群一律不处理。群号/QQ 号的**形状也要校验** ——
`groupPolicy: 'open'` 意味着"任何群都行"，而空串不是"任何群"，是坏数据；
放行它等于让畸形事件绕过整条访问控制。

出站同样 fail-closed：`send_qq`、主动语音、主动插话全部先过同一份出站白名单
（`src/dsh/outbound-allow.mjs`），名单外一条都发不出去。

### 3. 主动发言是两层判定

群聊里刷屏的代价远大于漏一次，所以第一层是纯算术闸门：

| 顺序 | 条件 | 拒绝原因 |
|---|---|---|
| 1 | 热身不足 | `warming-up` |
| 2 | 安静时段 | `quiet-hours` |
| 3 | 滚动小时配额已满 | `hourly-cap` |
| 4 | 机器人刚说完话 | `cooldown-after-bot` |
| 5 | 未到最小间隔 | `min-interval` |
| 6 | 突发窗口内接话的人太少 | `burst-too-small` |

日志报的是**最根本的那个原因**（说够了就是够了，跟冷却无关），否则运维看不出真因。

第二层才是话题判定：当前是确定性启发式（只在两个以上不同的人都在明显求助时才认领），
可测、可预期、不会因为模型抽风而刷屏。换成模型判定只要替换注入的 gauge，
引擎与网关都不用动。

## 零依赖、零构建

`ws`、`schemastery` 全都不用，连 Node 内置的全局 `WebSocket` 也不用（它只有客户端）。
`exports` 直接指向 `src/` 下的 `.mjs` —— 宿主按 `exports` 里的字符串拼绝对路径读文件，
所以不需要构建产物。

**刻意不声明 `peerDependencies`**：任何一条 `@deepseek-ai/dsh*` 的范围不匹配都会让宿主
**静默 disable** 这一行；而运行时本来就会把插件 import 的包重定向到宿主安装树的同一实例，
声明它们只有坏处。

## 运行期数据放哪

```text
<DSH_HOME>/qq-gugu/
  state/   关系、回想、转录、话题、学来的记忆
  media/   快照、出站台账、图片描述缓存、表情包库
  config/  预留（真实配置仍在 profile 目录）
```

都可用环境变量覆盖（`QQ_GUGU_HOME` 整体搬移）。**这些文件永远不进仓库** ——
见 `.gitignore` 里逐条写明的理由。
