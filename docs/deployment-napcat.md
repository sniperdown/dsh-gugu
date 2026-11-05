# 接入真实 NapCat

这份文档是让插件**真的连上 QQ** 的完整步骤。前置说明：代码已完整（全部用例通过、
九项能力各有真机验证），但所有验证的对端都是我写的假 NapCat。
真实联通只差配置，而这一步是你的环境，我没法代做。

---

## 第 0 步：先想清楚你要哪种连接模式

OneBot 11 有两种方向，含义相反，**这一步选错后面全白搭**：

| | 反向 WS（默认，推荐） | 正向 WS |
|---|---|---|
| **谁监听** | **本插件**监听一个端口，NapCat 主动拨进来 | **NapCat** 监听，插件拨过去 |
| **谁是客户端** | NapCat 是客户端 | 插件是客户端 |
| **插件配置** | `mode: reverse` + `host`/`port` | `mode: forward` + `url` |
| **NapCat 配置** | 填"反向 WS 地址"= `ws://<本机>:<port>` | 填"正向 WS 服务"并给端口 |
| **适合** | ✔ 推荐。插件侧不暴露任何东西，只需本机能被 NapCat 访问到 | 跨网络（插件连不到 NapCat 所在机器时） |

**默认是反向。** 本机跑 NapCat 就用反向，最省事。

---

## 第 1 步：装并启动 NapCat

NapCat 的安装方式随平台不同，看它的官方仓库。要点只有一条：
**你需要在它的 WebUI 里配置 OneBot 11 的网络设置**，即上面那张表右列。

一个常见组合（本机、反向）：

| NapCat 设置 | 值 |
|---|---|
| 启用 | 开 |
| 反向 WS 地址 | `ws://127.0.0.1:8643` |
| Access Token | 随便设一个强随机串，**记下来**，插件要填同一个 |

> **端口要和插件的 `port` 一致。** 插件默认 `8643`。
> 我的验证环境用 `18643`/`18644` 是为了不和任何真实服务撞车。

---

## 第 2 步：把插件装进你的 profile

`desktop` 是你的桌面 profile。命令：

```powershell
dsh plugin --profile desktop add <repo>
```

装完后 `<DSH_HOME>\profiles\desktop\package.json` 里会多出两项：

```json
{
  "dsh": {
    "profile": { "bundles": ["...", "dsh-qq-proactive"] }
  },
  "dependencies": { "dsh-qq-proactive": "link:<repo>" }
}
```

**不需要复制任何构建产物**——插件的 `exports` 直接指向源码，`link:` 装上就生效。
`bundles` 那一项是宿主自动加的，不用你手改。

### 这一步为什么只有一条命令

`dsh plugin add` 会自动把包加进 `dsh.profile.bundles`，而本插件自带的
[cordis.patch.yml](../cordis.patch.yml) 会被宿主当作 bundle patch 层加载，
里面的 `insert` 行完成挂载。**用户不需要手工合并任何 patch 行。**

（对比：有些插件要求你手工把它 patch 模板里的两行 `insert` 合并进 profile 层，
还要改 `pnpm-workspace.yaml`。本插件刻意走 bundle patch，就是为了省掉这一步。）

> 想撤销：`dsh plugin --profile desktop remove dsh-qq-proactive`。
> 这一步只改 profile 的 `package.json` 与锁文件，不动你的会话数据。
>
> 这两条命令都在隔离环境里实测过：从干净 profile 执行 add → 启动 →
> 插件挂载、设置页 RPC 挂上、客户端 bundle 被登记，全部通过。

---

## 第 3 步：填配置

配置写在 **profile 的 patch 层**，也就是 `cordis.patch.yml` 里（用 GUI 的设置页
改也一样，那是同一层）。最小可用配置：

```yaml
- id: qq-proactive
  config:
    mode: reverse
    host: 127.0.0.1
    port: 8643
    accessToken: '你在第 1 步设的那个串'
    # 谁能指挥机器人。先只写你自己，跑通再放人。
    adminUsers: ['你的QQ号']
    # 群聊策略：admin = 只有管理员的群消息会被回应
    groupPolicy: admin
```

### 关于 `accessToken`：反向模式下不能为空

反向模式下插件是监听方，**没有 token 就等于任何人都能拨进来冒充 NapCat**，
所以有 token 校验。实测：错误或缺失 token 的握手返回 `401`，正确返回 `101`。

正向模式下插件是拨出方，token 留空是允许的（你不验证对方）。

### 权限三档，先从严

| 字段 | 含义 |
|---|---|
| `dmPolicy` | 私聊：`admin` / `allowlist` / `open` / `disabled` |
| `groupPolicy` | 群聊：同上 |
| `adminUsers` | 管理员 QQ 列表，`admin` 策略下只有这些人能唤起回复 |
| `allowFrom` / `groupAllowFrom` | 白名单，`allowlist` 策略下生效 |

**建议先 `admin` + 只填自己**，确认一切正常再考虑放宽。
默认值就是 `admin`，所以你不写这两行也是从严的。

⚠️ 注意 `open` 的语义：`groupPolicy: open` 表示**任何群**都可以，
包括别人把你拉进去的群。要用白名单请显式写 `allowlist`。

---

## 第 4 步：验证连通

### 4.1 看日志确认通道起来了

```powershell
# 插件日志会同时写到 ctx.logger 和 stderr
# 想更啰嗦就设环境变量 QQ_PROACTIVE_DEBUG=1
```

成功时你会看到这类行：

```
[qq-proactive] qq-proactive 已挂载 {"dm":"admin","group":"admin","proactive":false}
[qq-proactive] [onebot] 反向 WS 已监听 ws://127.0.0.1:8643/
[qq-proactive] QQ 通道已启动（reverse） {"target":"127.0.0.1:8643"}
[qq-proactive] [onebot] OneBot 已就绪（reverse） {"selfId":""}
[qq-proactive] [onebot] 已从事件学到机器人 QQ：<你的机器人QQ>
```

最后那行出现，说明 NapCat 拨进来了、并且插件从消息里学到了机器人自己的 QQ。
**这是"通了"最可靠的标志。**

> 反向模式下插件**不会**主动去问 `get_login_info`——NapCat 才是应用端，
> 问了也不会答。所以它是被动学习的，第一次收到消息才知道自己是谁。
> 想跳过这一步可以在配置里直接写 `botQQ: '你的机器人QQ'`。

### 4.2 试一条私聊

用你的管理员 QQ 给机器人发一条私聊。预期：

1. 插件日志出现 `恢复会话 qq-private-<你的QQ> 失败，改为新建` → `已新建 QQ 会话 ...`
2. 出现 `→ 投递提示词 ...` 与 `→ whenIdle 返回 ...`
3. 出现 `已回复 private:<你的QQ> {"chars":N}`
4. **QQ 里收到回复**

### 4.3 试一条群聊 @

在机器人在的群里 @ 它，说点什么。预期同上，但会话键是 `qq-group-<群号>`。

如果 @ 了却没反应，按顺序查：

- 群号在 `groupAllowFrom` 里吗？（`allowlist` 策略下）
- `groupPolicy: admin` 时，**你的 QQ 在 `adminUsers` 里吗？**
- 日志里有没有 `只观察不回复 ... {"reason":"group-speaker-denied"}`？
  有就说明是"群放行了、但发言人不是管理员"。

---

## 第 5 步：开主动发言（可选，建议先观望几天）

**默认关闭。** 打开前请想清楚：这是让机器人在群里**自己找话说**。

```yaml
- id: qq-proactive
  config:
    proactive:
      enabled: true
      # 以下都是默认值，列出来是为了让你知道有什么可调
      minIntervalMs: 90000        # 两次主动发言至少隔 90 秒
      maxPerHour: 6               # 每滚动小时上限
      cooldownAfterBotMs: 20000   # 自己刚说完话后 20 秒内不抢
      afterUserMsgCount: 3        # 至少 3 条人类消息后才考虑
      burstWindowMs: 300000       # 突发统计窗口 5 分钟
      burstMinMessages: 4         # 窗口内至少 4 条人类消息
      quietHoursStart: 0          # 安静时段起（本地时间）
      quietHoursEnd: 7            # 安静时段止
      utcOffsetMinutes: 480       # 时区，默认东八区
```

判定闸门按顺序：**准入 → 预热 → 安静时段 → 小时上限 → 冷却 → 最小间隔 → 突发规模**。
任何一道没过都会打一条 `跳过主动发言`，理由写在里面。

想让它**更保守**：把 `burstMinMessages` 调到 6~8、`maxPerHour` 调到 2。
想**快速看到效果**再调低——但如果调低了又抱怨它话多，那是配置问题不是 bug。

---

## 第 6 步：开工作汇报（可选）

让它在**你的工作会话**跑完一轮后，把摘要发到指定 QQ 会话（群或私聊）。

```yaml
- id: qq-proactive
  config:
    report:
      enabled: true
      target: 'group:123456'      # 或 private:你的QQ
      minIntervalMinutes: 10      # 同一会话最短汇报间隔
      maxChars: 600               # 摘要整段上限
```

汇报长这样：

```
f79f4cf3 第 1 轮：完成
动作：抓网页×4、搜网络
结论：WORK_DONE
```

它是从会话事件里**真的摘要**出来的，不是硬编码文案。刻意**不整段搬模型回复**——
那种内容又长又含代码和路径，搬到群里既不合语境也刷屏。

**QQ 自己的会话不会被汇报**（否则机器人复读自己）。

---

## 第 7 步：在 GUI 里改配置（可选）

装好插件、profile 里有 Web 前端时，设置页会多一个 **「QQ 通道」** 分区。
它读写的就是上面那些 YAML——同一层，不是另一份状态。

页面里能改的是标量字段（连接、权限、行为）；`proactive` / `gauge` / `report`
这几组**刻意没放进 GUI**，因为它们是需要想清楚才动的策略旋钮，不适合在表单里随手改。
要动它们请编辑 YAML。

---

## 让私聊进你的主会话（可选）

默认每个私聊联系人一个独立会话。如果你想让私聊直接进某个**已存在的工作会话**：

```yaml
- id: qq-proactive
  config:
    dmRouting: main
    mainSessionKey: 'session-<uuid>'   # 目标会话的 id，不是 QQ 号
```

两个必须知道的点：

1. **`mainSessionKey` 必须填。** 留空会**显式回落**到独立会话并记一条日志——
   刻意不隐式挑一个"主会话"，那会让"它为什么答的是那个会话的内容"极难排查。
2. **目标会话必须有 `cwd`。** 部署人设模板里有 `{{cwd}}`，会话缺它时提示词组装
   会**抛错**而不是填空串，表现是"本轮没有助手发言"而状态一切正常，极难定位。
   插件自己建的会话会自动兜底填 `process.cwd()`，但**外部预建的会话不归它管**。
   缺了的话插件会明确告警：

   ```
   会话 <id> 没有 cwd：提示词组装会因 {{cwd}} 无值而失败，本轮不会产生回复。
   如果是外部预建的会话，请给它配 cwd（插件自己建的会话会自动兜底填）。
   ```

---

## 出问题时先看什么

日志里这几个关键词能覆盖绝大多数情况：

| 日志 | 含义 |
|---|---|
| `OneBot 已就绪 {"selfId":...}` | 通道通了 |
| `没有 connection 服务，设置页不可用` | 正常。headless 部署没有 Web 前端，QQ 通道照常工作 |
| `只观察不回复 ... {"reason":"group-speaker-denied"}` | 群放行了但发言人不是管理员 |
| `跳过主动发言 ... {"reason":"..."}` | 主动发言被某道闸门拦下，理由在里面 |
| `会话 ... 没有 cwd` | 提示词组装会失败，见上一节 |
| `挂载设置页 RPC 失败` | 不影响 QQ 通道；GUI 里会少一个分区 |
| 握手 `401` | NapCat 和插件的 `accessToken` 不一致 |

### 还没被真实 NapCat 验证过的地方

诚实列出来，这几处是真实联通后最可能出现意外的地方：

1. **消息段形态差异**——我用段数组和 CQ 串都测过，也处理了 `&amp;` 转义，
   但 NapCat 具体发什么形态只有连上才知道。
2. **重连行为**——NapCat 重启、网络抖动时的退避重连逻辑有单测，
   但没在真实抖动下跑过。
3. **主动发言在真实群聊节奏下的手感**——我用的假群聊节奏很规整，
   真实群里会不会误触发或过于沉默，需要观察几天再调参。

遇到这几类问题，日志里的 `reason` 字段通常能直接指出是哪一层。
