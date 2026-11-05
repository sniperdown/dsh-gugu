# NapCat 兼容补丁：`{action, params}` 包装格式

> 症状：QQ 里收不到任何回复，但日志显示入站正常、回复也生成了。**动出站逻辑前先读这份。**

## 症状

`dsh-onebot-qq` 的**入站正常**（能读到你的消息、会生成回复、会发"正在输入"），
但**出站一条都发不出去** —— 用户从来没在 QQ 里收到过它的回复。

## 根因

NapCat 4.18.28 的 action 处理器**把整个请求体当参数用**，只认平铺格式：

```json
{"action":"send_msg","group_id":123,"message":[...]}   ← 对
{"action":"send_msg","params":{"group_id":123,...}}    ← 被拒
```

而 OneBot 11 的常见惯例（也就是 `dsh-onebot-qq` 0.5.1 实际用的）是 `{action, params}` 包装。
于是它的每条出站都被拒，报：

```
TypeError: Cannot read properties of undefined (reading 'type')
```

（`check()` 里的 `aye()` 读 `e.message` 的元素，包装格式下 `e.message` 是 undefined。）

## 修法

在 NapCat 的 action 入口 `handle()` 里加**摊平**逻辑，让两种格式都能跑：

```js
// D:\QQNT\napcat\napcat.mjs 约 40476 行
async handle(e, n, r, i = { send: async () => {
} }, o) {
  // [DSH-FLATTEN] 兼容 {action, params} 包装格式。
  if (e !== null && typeof e === 'object' && e.params !== null && typeof e.params === 'object') {
    for (const k of Object.keys(e.params)) {
      if (e[k] === undefined) e[k] = e.params[k];
    }
  }
  const s = await this.check(e);
  ...
```

**纯加法**：平铺格式的行为完全不变（顶层已有同名键时不覆盖）。

### ⚠️ NapCat 有**两个** action 入口 —— 必须都补

**这是本项目踩过的最贵的坑之一。** 两条路径走的是**不同方法**：

| 路径 | 调用链 | 只补 `handle` 的后果 |
|---|---|---|
| HTTP | `httpApiRequest` → `c.handle(i, …)` | ✔ 有效 |
| **反向 WS** | `handleMessage` → `i.websocketHandle(n.params, …)` | ✘ **不生效** |

于是会出现**极具误导性**的局面：

- 用 HTTP 测三种格式 → **全绿** → 以为修好了
- 而**本项目的插件走的是反向 WS** → 一发言就崩：

```
[NapCat] unhandledRejection: TypeError: Cannot read properties of undefined (reading 'type')
    at aye (napcat.mjs:74028)
    at cye.check (napcat.mjs:74038)
    at cye.websocketHandle (napcat.mjs:40503)   ← 这里
    at pO.handleMessage (napcat.mjs:63988)
```

所以**两个方法都要打补丁**（`[DSH-FLATTEN]` + `[DSH-FLATTEN-WS]`），
并用**真实的反向 WS 路径**验证，而不是只用 HTTP。

**教训**：「用一个入口验证另一个入口」等于没验证。这已经是本项目第四次同类盲区
（握手 key 长度、HTTP `params` 包装、段格式 `data` 嵌套、这次的**双入口**）。

- 应用脚本：`restore-and-patch.mjs`（HTTP 入口）、`patch-ws-flatten.mjs`（WS 入口）
- 干净原版备份：`D:\QQNT\napcat\napcat.mjs.ORIGINAL`

### 验证（三种形态都测过）

```
✔ params包装-私聊   status=ok
✔ 平铺-私聊         status=ok   （回归，没被破坏）
✔ params包装-群聊   status=ok
```

## 排查过程中犯的错（务必避免重犯）

1. **打错方法**：先补在 `handle()`，误以为 HTTP 不走它，又去补 `websocketHandle()`。
   实际上 HTTP 入口就是 `httpApiRequest` → `c.handle(i, ...)`。
   **教训**：先用"写文件探测"确认哪段代码真的被执行，再决定改哪里。
2. **在 ESM 模块里用 `require`**：`napcat.mjs` 是 ESM，`require` 未定义，
   运行到那行抛 `ReferenceError`，**NapCat 直接起不来**。
   要加日志就用文件顶部的 `import`。
3. **清理正则太宽**：把注释连带后面的 `try{}` 一起删，却留下 `} catch (e) {` 残片 → 语法错误。
   **教训**：不要在同一份被改花的文件上反复打补丁+清理；每次从干净原版重来，只加一个补丁。
4. **用探测客户端顶掉了真实连接**：`dsh-onebot-qq` 的反向 WS 是 **last-wins**
   （它自己注释写着 `NapCat expects a single dial-in; close any older socket`），
   我冒充 NapCat 拨进去会把真 NapCat 顶掉，**导致"测试时它不回复"是我自己造成的**。
   **教训**：排查收发问题时，不要用会抢连接的探测方式。
5. **反复重启导致 4 个 NapCat 实例互相挤占**：重启脚本只停了 `NapCatWinBootMain`，
   没清它拉起的 QQ 子进程。已修：`<napcat>\scripts\start-napcat.ps1` 会先清理再启动，
   并**保留用户的个人 QQ**（按路径 `\QQ\Bin\` 识别）。
6. **PowerShell 5.1 按 ANSI 读 `.ps1`**，中文注释会被读成乱码且破坏引号 →
   `数组索引表达式丢失或无效`。修法：脚本存成 **UTF-8 with BOM**。

## 其它环境的注意点

- NapCat 启动**需要管理员权限**（UAC）。agent 无法自行提权，
  所以"启动 NapCat"这一步要用户手动做，或由用户确认 UAC。
- NapCat 配置文件：`D:\QQNT\napcat\config\onebot11_10000002.json`（文件名里的数字是机器人自己的 QQ）
  - `websocketClients` 是**数组**，本项目用了两条：
    `dshOnebot` → `ws://127.0.0.1:18660`（被动回复）
    `dshProactive` → `ws://127.0.0.1:18661`（主动发言）
- 改 `websocketClients` 后**必须重启 NapCat**（它不热加载该配置）。
