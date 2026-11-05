# 开发手册（给改这个仓库的人 / agent）

这份文件放**"干活时要照着做"的硬规则**与踩过的坑。事故经过不在仓库里
（在维护者本地），这里只留判据和做法。

## 一、跑测试

```bash
npm test                # = node tools/run-all-tests.mjs，单进程串行 import
npm run test:isolated   # 逐文件独立进程（node --test + glob），非沙箱环境用
```

- **别用裸 `node --test`**：受限沙箱禁 named pipe，子进程抓管道会 `EPERM`，
  表现是"每个文件正好 1 条失败"的假红。
- `npm test` 自己 readdir 扫 `test/*.test.mjs`，**新增测试文件自动跑到**，不用维护清单。
- 基线：**104 个文件 / 2221 条**。当前已知长期红 1 条
  （`markdown-outbound` 的「图片段一个字节都不碰」）；除它以外应当全绿。
- 判绿：**条数对得上基线且退出码为 0**。

## 二、改完代码 / 配置，它真的生效了吗

**查【那个值】，不是查"代码是新的"。**

- 改 `.toml` ⇒ 必须触发一次重载（碰一下 `src/`，或用宿主的「重载插件」）⇒
  再去看快照/日志里**那个字段**的值。
- "文件 mtime 是新的"、"快照里 `stale: false`" 都**不证明配置被读了**。

## 三、挂在外部事件 / 定时器上的回调，必须自己吞异常

任何注册给外部系统的回调（`transport.on(...)` / `ctx.on(...)` / `setInterval` /
`setTimeout` / 事件订阅），**函数体自己 `try/catch` 或 `.catch()`**，把异常降级成日志。

**理由：这些回调是 DSH 进程里的最后一层，抛出去 = 宿主退出。**

**但不要加 `process.on('uncaughtException')` 全局兜底** —— 插件跑在宿主进程里，
那会把 DSH 自己的异常一起吞掉，**比崩了更难查**。

## 四、改 `src/` 会 dispose agent，掐断正在跑的一轮

插件带热重载：保存即重载。重载会 dispose 掉正在服役的 agent，那一刻它
**正在跑的那一轮会被直接掐断** —— 界面上是「已停止」/输入框变灰，
看起来像插件坏了，其实只是被卸载了。

- 改 `src/` 之前先看有没有人在用（调试快照里的 `stats` 在涨 = 正在用）。
- **长任务别在重启前跑**：重启会连带杀掉子会话。
- **跨文件的接口改动：先写实现，再改调用。** 热重载没有防抖，一次保存立刻重载 ⇒
  调用点先上线、方法还没写，下一个事件进来就是 `TypeError`。
  顺序对了，任何一刻代码都自洽，成本为零。

## 五、同名 prompt section 会被**遮蔽**

`dsh-system-prompt` 的 `section()`：**作用域更内层的同名 section 会整体替换外层那份**，
不是追加。不报错、不警告，表现就是"那段文本像没存在过一样"。

```text
全局           dsh-system-prompt 的 config.personaPrefix        ← 被遮蔽
preset 作用域   dsh-persona                                      ← 被遮蔽
agent 作用域    src/dsh/binding.mjs（读 qq-gugu.toml 的 persona） ← 最终生效
```

**要往提示词里加东西时，先问「这个 section 名有没有人在更内层注册过」。**

同一族：`section()` / `restrict()` 都是挂在 ctx 上的 effect，热重载销毁 ctx 就 dispose。
**要问：「创建路径之外还有没有复用路径？那条路会不会漏掉这一步？」**

## 六、配置的边界：代码里不写"环境相关"的东西

QQ 号、群号、昵称、群名、白名单、口令 —— 一律进**配置**（`cordis.patch.yml` /
`qq-gugu.toml`）或**数据**（`<DSH_HOME>/qq-gugu/state/`），**不进代码**。
这样别人能用自己的号跑，改配置不用动代码。

路径同理：不要写死盘符路径。用 `src/dsh/paths.mjs` 的
`dshHome()` / `qqGuguHome()` / `stateDir()`。

## 七、目录结构

```text
src/index.mjs              插件入口：读配置、装配各模块、注册服务
src/onebot/                OneBot 11：手写 RFC 6455（反向 WS 要当服务端）、段数组/CQ、传输
src/dsh/gateway.mjs        端到端编排：入站 → 判定 → 会话 → 出站（唯一缝四处的地方）
src/dsh/binding.mjs        与 DSH 会话的耦合点：创建/驱动/取回复
src/dsh/routing.mjs        访问控制、会话去向、会话键派生（纯函数，好测）
src/dsh/chat-sessions.mjs  聊天 → DSH 会话的映射与持久化
src/proactive/engine.mjs   主动发言的闸门与配额（准入排最前）
src/dsh/paths.mjs          插件文件路径的统一解析
web/ + client.js           设置页（浏览器半 / 宿主半），零构建
tools/                     开发与诊断脚本（bootstrap 体检、健康检查、回放…）
docs/                      设计与部署文档
test/                      测试（104 个文件）
```

## 八、提交前

- `npm test` 绿（除已知那条）。
- **别把运行期产物带进提交**：`.gitignore` 里逐条写了理由；尤其注意
  `test/.tmp-*/`（测试会往里写抓下来的图片）与真实 `qq-gugu.toml`。
- 新增配置字段要同时改：`src/dsh/config-fields.mjs`（设置页）、
  `docs/config.example.*`（示例）、README 的字段说明 ——
  三处不同步的后果是"界面上有、实际不生效"。
