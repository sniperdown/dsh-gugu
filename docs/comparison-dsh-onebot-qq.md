# 两个插件的对照

`vendor/` 里的 [dsh-onebot-qq](https://github.com/mario841859784/dsh-onebot) v0.5.1 与
本目录（`dsh-qq-proactive`）解决的是**同一个问题的不同两半**。这份文档把两边的事实摆在一起，
以及如果要合并，代价分别是什么。

> 写这份文档时我的立场：**它的被动层比我的成熟得多**，我不粉饰这一点。
> 本文里的"它"指 vendored 包，"我"指本目录。

---

## 一、一句话区别

| | 定位 | 它解决什么 |
|---|---|---|
| **dsh-onebot-qq v0.5.1** | 成熟的 **QQ 通道**（被动收发 + 工具 + 命令 + 设置页） | "我能好好地在 QQ 上收发消息" |
| **dsh-qq-proactive**（本目录） | **自主发言层**（什么时候自己开口） | "没人叫我的时候我该不该说话" |

关键事实：**它没有任何主动行为。** 在它的 20 个 `lib/*.js` 里搜 `proactive` 命中 0、
`cron` 命中 0、`定时`/`schedule` 各 1 处且都与主动发言无关（30 处 `idle` 全是"等 agent 空闲"）。

而你最初的需求原话是「**让你能在 QQ 上自主发言**」「**干活聊天两不误**」——
"自主"和"干活时也在聊天"正是它的空白处，也正好是我做的那部分。

---

## 二、能力对照

### 它有、我没有

| 类别 | 它有的 |
|---|---|
| 入站媒体 | 图片四路解析（url/base64/file/hash）、大图自动压缩供视觉模型、GIF 不压、文件段双通道、表情 id→emoji、戳一戳段 |
| 语音 | ffmpeg→16kHz WAV + whisper 转写，**非阻塞**：先以 `[语音]` 进回合，转写完再补递 |
| 引用/转发 | 引用消息自动 `get_msg` 取原文、合并转发自动 `get_forward_msg` 展开 |
| 文字图 | t2i 卡片渲染（@napi-rs/canvas，800px/26px/中文标点禁则） |
| 出站塑形 | 超 150 字自动渲染文字图、Markdown 剥离、`[[qq_forward]]` 合并转发、**实时中间消息 + 90s 自动撤回 + 回合末 t2i 小结卡** |
| 宿主卡中继 | 模型调 `exit_plan_mode` / `ask_user_question` 时把计划/选项发到 QQ |
| 命令 | 19 个斜杠命令：`/new` `/stop` `/model` `/workspace` `/preset` `/session` `/status` `/retry` `/permission` `/goal` `/ocr` … |
| 工具 | 7 个模型可调用：`qq_send_image/voice/video/file/forward`、`qq_napcat_api`（14 白名单 action）、`qq_group_history` |
| 提示词 | 按**每个 QQ 会话自身作用域**注入平台说明（Web 会话不可见） |
| 运维 | 热加载（fiber 原地重启）、临时媒体 TTL 清理、正在输入提示 |
| 设置页 | `onebotSettings` Typert Remote + 19 键、三组、与 patch config 有优先级规则 |
| 工程 | `lib/types/*.d.ts`、vitest 306 用例、`DEVLOG.md` 记录实测事故 |

### 我有、它没有

| 类别 | 我有的 | 它的等价物 |
|---|---|---|
| **主动发言引擎** | 七道闸门（准入→预热→安静时段→小时上限→冷却→最小间隔→突发规模）、每小时配额、突发窗口 | **无** |
| **话题判定** | 确定性启发式：≥2 个不同发言人 + 求助信号，含"别插嘴"信号集 | **无** |
| **工作完成汇报** | 监听工作会话 `turn/end`，从会话事件**真摘要**（会话短 id/轮次/结果/用过的工具/结论）发到指定 QQ | **无** |
| **私聊路由可选** | `dmRouting: main` 把私聊送进指定主会话 | 无（它固定每会话一个 agent） |

### 两边都有、质量不同

| | 它 | 我 |
|---|---|---|
| WebSocket | 用 `ws` 库 | **手写 RFC 6455**（零依赖，但这是自己造轮子） |
| OneBot 解析 | 段数组优先 + CQ 回退 + 反转义 | 同类，但入站媒体只压成 `[图片]` 占位符 |
| 会话隔离 | `onebot-<chatId>`，重启 resume | `qq-group-*` / `qq-private-*`，机制相同 |
| 访问控制 | 管理员名单 + dm/group 策略 + @gating + 软限制 | `admin`/`allowlist`/`open`/`disabled` 四档 |
| 设置页 | Typert Remote（正规） | 自建 Connection RPC 通道 |
| 测试 | vitest 306 | node:test 2200+ |

**结论：论"QQ 通道"这个工种，它全面强于我。论"自主发言"，那是我的全部。**

---

## 三、安装代价对比

| | 它 | 我 |
|---|---|---|
| 依赖 | `@napi-rs/canvas`（**原生模块**）、`fontkit`、`schemastery`、`ws` | **零依赖** |
| 装法 | npm 发布通道 或 git clone + `./scripts/build.sh` | `link:` 源码目录即可，无构建 |
| 当前环境是否就绪 | `ws` 宿主已有；`schemastery`/`fontkit`/`@napi-rs/canvas` **缺失，需联网安装** | 就绪 |
| 额外步骤 | 要改 `pnpm-workspace.yaml`（`autoInstallPeers:false` / `hoist:false`）、要手合并它 patch 模板的两行 insert、**不要**在 profile 里手写 `@deepseek-ai/*` | 一条 `dsh plugin add`，bundles 自动加 |
| 版本契合 | 它要求 dsh `>=0.2.0-rc.1 <0.3.0`，你的是 **0.2.0-rc.2** ✔ | 无 peer 声明，靠宿主重定向 |
| 可选依赖 | 语音转写需 ffmpeg + whisper CLI；t2i 在 Linux 需 Noto CJK 字体 | 无 |

它的 README 自己也提醒：`peerDependencies` 范围不匹配会被兼容门拒绝，
要用 `dsh plugin allow-version ... --accept-risk` 豁免。**版本恰好合适，这条用不上。**

它体积也大：解包后 `lib/` 20 个文件、含 `.d.ts`，`registry.js` 54 KB、`commands.js` 56 KB。

---

## 四、如果要合并：三条路与代价

### 路 A：把我的主动层做成它的配套扩展（我推荐）

在它旁边挂一个**第三个 insert 行**，读它的会话，不碰它的被动路径。

| 需要什么 | 难度 |
|---|---|
| 复用它的会话 id（`onebot-<chatId>`） | 低——`sessionIdForChat()` 是导出的纯函数 |
| 复用它的 agent 映射 | 中——它的 `bridge.js` 里 `chat.agent.followup(...)` 是私有的，要么它导出、要么我通过 `ctx.agents.get(sessionId)` 自己拿 |
| 拿到入站消息流（做转录） | 低——`ctx.on('session/event')` 照样能看见所有会话 |
| 主动发言时发消息 | 低——复用它的出站队列，或直接用 `send_group_msg` |
| 设置页 | 中——接它的 `onebotSettings` Remote 命名空间 |

代价：耦合到它的内部结构（它升级可能改）。收益：不重复造通道，工具/媒体/命令全都有。

### 路 B：只装它，我把主动层留成独立可选包

最省事，先跑通被动能力。主动能力等你确认想要了再挂。

### 路 C：两个都装，各自独立跑

**不推荐。** 同一个 QQ 消息会被两边各回一次，两边会话互不可见，
群里的人会看到机器人精神分裂。技术上可行，体验上不可接受。

---

## 五、我可能的误判

诚实列出来，你看代码时可以重点验证：

1. **"它没有主动能力"** 是我 grep `proactive`/`cron`/`定时` 得出的。如果它的
   `interim.js`/`outbound.js` 里有某种"超过 N 分钟没人说话就发一句"的机制，我会漏掉。
2. **它的 peerDependencies 是否真的会被宿主满足**，我只核对了 `engines.dsh` 范围，
   没验证 8 个 `@deepseek-ai/*` peer 是否都在你的安装树里。
3. **它的 `schemastery` 声明为 `dependencies`**，而宿主树里没有——
   这意味着安装它必然要联网拉包。如果你的环境不能联网，它装不上，而我能。
4. **我没读它的 `registry.js` / `commands.js`**（各 54/56 KB），那两块只是按 README 转述。

---

## 六、我的建议

如果你的目标是**一个真能日常用的 QQ 通道**，用它的。它在这个工种上比我成熟一个量级，
本项目的用例里有相当一部分是在重新发现它已经踩过的坑（比如 `{{cwd}}`、
`agent.followup` 要构造 UserMessage、`source.kind` 必须是 `user`——它的
`bridge.js` 里已经处理了这些）。

如果你的目标是**"没人叫我时它也会自己说话"**，那是它没有的部分，也是我唯一真正的贡献。

**两者不冲突，组合起来才是你最初说的那个东西。** 我倾向路 A，但这条路要我先读懂它的
`bridge.js` 和 `inbound.js`，再决定接口从哪切——在动手前我想先得到你的确认。
