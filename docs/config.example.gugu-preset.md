# 示例：`gugu` agent preset 从哪来

> 这是 `docs/config.example.*` 系列的一份，配合
> [config.example.cordis.patch.yml](config.example.cordis.patch.yml) 一起看。

## 为什么需要它

QQ 会话默认走 DSH 的 `standard` preset，它的 persona 第一行把系统提示词设成
`You are a coding agent powered by the {{model}} model.` —— 于是小鲸鱼在 QQ 上会用
**编码助手**的口吻说话（实测原话：「收到，测试正常，我能看到你的消息。」）。

要让它变成「小鲸鱼」，必须有一个**遮蔽 persona 段落**的 preset。`cordis.patch.yml`
里 `agentPreset: gugu` 指的就是它。

## 它长什么样（骨架）

真身有 ~150 行，因为 `plugins:` 列表要**照抄 `standard` preset 的 19 个工具条目**——
抄漏了 QQ 会话就会少工具（少了 `tool-fs` 就没法改文件）。

```yaml
- insert:
    - id: preset-gugu
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: gugu
        name: 小鲸鱼
        description: QQ 吉祥物人格：可水群、可干活
        order: 2
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              # 人设文本用 YAML 块标量，避免引号/换行转义问题
              prefix: |
                <这里放小鲸鱼的人设。通常直接从 qq-gugu.toml 的 [personality] 抄>
              suffix: Your working directory is {{cwd}}.
          # ↓↓↓ 以下照抄 standard preset 的其余 18 个条目，一个都别漏 ↓↓↓
          - id: ...
```

## 怎么拿到完整的那一份（两条路）

### A. 从旧机器的 profile 里整段拷（最省事）

`preset-gugu` 是写进 `cordis.patch.yml` 的一个顶层条目。
在旧机器的 `<DSH_HOME>\profiles\<profile>\cordis.patch.yml` 里搜 `preset-gugu`，
从那一行 `- insert:` 起、到下一个顶层 `- ` 之前，整段复制到新机器的同位置即可。

### B. 用生成脚本（仓库自带）

```powershell
node <repo>\tools\gen-gugu-preset.mjs           # 打印出来看看
node <repo>\tools\apply-gugu-preset.mjs --write # 校验通过才写入 profile
```

⚠️ **这个脚本有两个写死的路径常量**，换机器要改：

| 文件 | 常量 | 现在指向 | 该指向 |
|---|---|---|---|
| `tools/gen-gugu-preset.mjs` | `STANDARD` | `<DSH_VERIFY>\tree\dsh\node_modules\@deepseek-ai\dsh-web-app\presets\standard.patch.yml` | 你机器上 DSH 安装树里的 `standard.patch.yml` |
| `tools/apply-gugu-preset.mjs` | `YAML_DIR`、`PROFILE_PATCH` | 同上 + 旧 profile 路径 | 新机器的 profile 目录 |

`<DSH_VERIFY>\tree` 是当初为了做真机验证、从 `app.asar` 抽出来的临时安装树。
如果你机器上没有它，可以从 DSH 安装目录的 `app.asar` 里再抽一份，或者直接用 A 方案。

## 验证它生效了

```powershell
node <repo>\tools\bootstrap.mjs
```

体检报告里会写「preset-gugu：找到 / 没找到」。
另外 **preset 一旦开始跑就锁定**：改配置只影响**之后创建**的会话，
已有的 QQ 会话要在那个聊天里发 `/new` 才会用上新 preset。
