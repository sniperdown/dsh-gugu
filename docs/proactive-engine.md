# 主动发言引擎（自研部分）

这是本方案中**方向无关**的那一半：不管最后是接在现成的 `dsh-onebot-qq` 上，还是自研整个插件，
"什么时候该说话、说完还能不能说"这套判断都必须存在，且必须可靠。

刻意做成**纯逻辑 + 零依赖 + 零 DSH 耦合**：

- 不调用模型 —— 话题判定通过注入的 `gauge` 完成，测试里注入假的
- 不碰网络 —— 发消息通过注入的 `speak` 完成
- 状态全在内存，靠配置里上界约束，不会无限增长

所以它能离线全量测试，也能接到任何宿主上。

## 文件

| 文件 | 作用 |
|---|---|
| [`src/proactive/engine.mjs`](../src/proactive/engine.mjs) | 引擎本体：转录缓冲、闸门、判定调度、配额 |
| [`test/engine.test.mjs`](../test/engine.test.mjs) | 38 个用例，`npm test` 跑 |

跑测试：

```powershell
& '<DSH_HOME>\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --test test/engine.test.mjs
```

## 两层判定

群聊里刷屏的代价远大于漏一次，所以判定分两层，**第一层不通就连模型都不叫**：

### 第一层：闸门（纯算术，本引擎负责）

按拒绝理由的「根本性」排序，越根本越先报 —— 日志才能反映真因：

| 顺序 | 条件 | 拒绝原因 |
|---|---|---|
| 1 | 累计人类消息数未达 `afterUserMsgCount` | `warming-up` |
| 2 | 落在安静时段 | `quiet-hours` |
| 3 | 滚动一小时内主动发言已达 `maxPerHour` | `hourly-cap` |
| 4 | 距机器人上次发言不足 `cooldownAfterBotMs` | `cooldown-after-bot` |
| 5 | 距上次主动发言不足 `minIntervalMs` | `min-interval` |
| 6 | 突发窗口内人类消息不足 `burstMinMessages` | `burst-too-small` |

### 第二层：话题判定（注入的 `gauge` 负责）

只有闸门放行后才问模型「这个话题你要不要说、说什么」。
`gauge` 返回 `null` / 空文本 = 不说话；返回 `{text}` 或非空字符串 = 冒泡。

## 时间语义（踩过坑，写下来）

引擎同时接触两个时钟，**记账一律用注入的 `now()`（真实时刻），不用消息自带的 `at`**：

- 发言时刻用 `now()` 记 —— 否则一条补发的旧消息能拿着旧时间戳绕过限流。
- `lastBotAt` / `lastSpeakAt` 取 `Math.max` 而非覆盖 —— 否则迟到消息会把冷却期/间隔
  "拉回过去"。
- 流逝时间夹 `Math.max(0, ...)` 下限 —— 否则 `now - lastBotAt` 为负、恒小于阈值，
  该会话被永久判为「冷却中」，从此再也不说话。

这三条都是测试抓出来的真实缺陷的修复（见 git 历史与用例注释）。
**接入时务必把 `now` 接成真实系统时钟**，不要把消息时间戳传进去。

## 两个入口

- `engine.ingest(message)` —— 所有入站消息都该走这里（含 @ 机器人的、私聊的），
  转录因此始终完整；是否触发主动发言另行判定。`mentioned: true` 的消息走被动通道，
  主动引擎不抢（但会视作"已过热身门槛"）。
- `engine.forceSpeak({chatId, kind, text})` —— 手动触发（工作汇报、定时播报）。
  **绕过闸门但计入配额**：这是我们自己决定要说的话，不是机会主义冒泡；
  汇报完紧接着的一段间隔仍然生效，不会汇报完又补一句。

被动回复完成后**必须**调用 `engine.noteBotSpoke(chatId)`，否则冷却期形同虚设 ——
机器人会在自己刚回完话之后立刻再冒一句。

## 配置默认值

见 `defaultTriggerConfig()`。刻意保守：深夜安静（0-7 点 UTC+8）、
最小间隔 90 秒、每小时最多 6 次、机器人说完话后 20 秒不抢、突发窗口 5 分钟内至少 4 条消息。

`burstMinMessages` 是最重要的一个参数：它要求**短时间内有多人在接话**才算"话题起来了"。
只有 1 条消息就冒泡，本质上是抢话而不是参与。
