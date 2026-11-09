# 活动窗口记录器（activity-recorder）

记录「过去 72 小时我在这台 Windows 上做了什么」：前台窗口切换、每 5 分钟的可见窗口快照、
鼠标键盘空闲段。数据是 jsonl，一行一个事件，流式追加，不占内存。

不依赖 DSH / node / pwsh 7：只有 `.ps1` + Windows 自带的 PowerShell 5.1 + 一个计划任务。
DSH 卸载、重装、崩溃都不影响它。

## 文件

| 文件 | 作用 |
|---|---|
| `recorder.ps1` | 常驻采样循环（由计划任务启动，用户登录即跑） |
| `report.ps1` | 读 jsonl 出汇总报告（覆盖范围 / 当前窗口 / 每进程时长 / 时间线 / 空闲段） |
| `install.ps1` | 注册计划任务 `ActivityRecorder` 并立即启动、自检 |
| `uninstall.ps1` | 停止进程、删除计划任务（`-PurgeData` 连数据一起删） |

数据目录：`%LOCALAPPDATA%\activity-log\`

- `events-YYYY-MM-DD.jsonl` —— 按**本地日期**切文件，一行一个 JSON 事件
- `recorder.log` —— 只写启动 / 退出 / 轮转 / 去重后的报错，超过 1 MB 自动重建

## 安装 / 卸载

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1          # 保留数据
powershell.exe -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -PurgeData
```

计划任务 `ActivityRecorder`：`AtLogOn`（当前用户）+ 失败重启（间隔 1 分钟、最多 999 次）+
`RunLevel Limited`（不提权，所以不弹 UAC）+ `MultipleInstances IgnoreNew`。
`install.ps1` 先试 `Register-ScheduledTask`，失败退回 `schtasks /Create /SC ONLOGON`；
两种方式哪种成功会在输出里写明。

## 查数据

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File report.ps1
powershell.exe ... -File report.ps1 -Hours 1 -Top 10 -Timeline
powershell.exe ... -File report.ps1 -Json     # 机器可读
```

默认 72 小时。报告分 5 段：① 数据覆盖范围（文件、条数、最早/最晚事件、重启次数）
② 当前前台窗口 + 最后一次激活时间 ③ 每进程排行（前台/后台/空闲/首末出现）
④ 合并后的时间线（连续同一窗口的 focus 段合并，空闲段单独成行）⑤ 空闲段列表。

直接看原始数据：

```
Get-Content "$env:LOCALAPPDATA\activity-log\events-2026-11-09.jsonl" -Encoding UTF8 | Select -Last 20
```

（`Get-Content` 能读正在写的文件；`[System.IO.File]::ReadAllLines` 会报「正由另一进程使用」，
因为 recorder 是以 `FileShare.ReadWrite` 打开的，只读共享模式的读者会撞上。）

## 事件模型（字段名固定）

| `k` | 何时写 | 字段 |
|---|---|---|
| `boot` | 记录器每次启动 | `pid` `procStart`（记录器进程启动时间）`uptimeSec`（系统 uptime 秒）`bootTime`（系统启动时间≈现在−uptime）`host` |
| `focus` | 前台窗口的 hwnd 变了，或同一 hwnd 的标题变了 | `proc` `pid` `hwnd`（`0x...`）`title`（≤200 字符，换行/制表符压成空格） |
| `idle` | 空闲从「不空闲」跨过 600 秒阈值时 | `idleSec` |
| `active` | 从空闲状态回到有输入 | — |
| `snap` | 每 5 分钟（对齐 `:00/:05/:10`，2 秒轮询，偏差 ≤3 秒） | `proc` `pid` `hwnd` `title` `idleSec` `wins`（当时所有可见且有标题的顶层窗口，≤60 个，title ≤120 字符，每项 `proc` `pid` `hwnd` `title`） |
| `stop` | 进程正常退出时 | `reason` |

每行另有 `t`（本地时间带时区，如 `2026-11-09T07:05:12+08:00`）和 `ms`（unix 毫秒）。
除 `t`/`k`/`ms` 外，字段顺序不保证稳定，解析请按名字取。

## 口径（重要，别把报告当秒表）

- **前台时长**：`focus` 段时长之和，**扣除与该段重叠的空闲时间**。最后一个未闭合的段，若数据
  看起来还活着（最后一条事件在 2 分钟内），结算到「现在」；否则结算到最后一条事件。
- **后台时长**：只靠 5 分钟快照估算。每张快照里出现的窗口进程（排除当时的前台进程）记入
  两张快照之间的间隔（上限 300 秒），且只算非空闲时段。**近似值，每段最大 5 分钟误差**；
  5 分钟内开过又关掉的窗口完全看不到。
- **空闲时长**：`idle`→`active` 的段长（阈值 600 秒）。若报告时仍处于空闲，结算到「现在」。
  空闲**记在当时处于前台的进程名下**（空闲期间换了前台窗口，仍记给空闲开始时的那个进程）。
- **粒度**：采样（2 秒 / 5 分钟）+ 事件混合，不是逐秒精确。还原粒度约 5 分钟；窗口切换本身
  是 2 秒级精度。持续时间 <2 秒的窗口可能整段丢失。
- **不做**锁屏 / 睡眠 / 关机 / 显示器开关的记录（这台机器不锁屏不睡眠，显示器常开），
  靠 `boot` 事件的 `bootTime` / `uptimeSec` 切分系统重启。
- 单文件按本地日期切；72 小时保留策略是「日文件的结束时刻早于 now−72h 就删」，所以磁盘上
  可能同时存在 4 个日文件，但报告只取 `-Hours` 窗口内的事件。

## 改阈值

`recorder.ps1` 顶部常量（改完重启任务：`Stop-ScheduledTask` 后 `Start-ScheduledTask`，
或 `install.ps1` 重装）：

| 常量 | 默认 | 含义 |
|---|---|---|
| `$script:PollMs` | 2000 | 主循环间隔；调大省 CPU，但 focus 精度变差 |
| `$script:IdleThresholdSec` | 600 | 多久没输入算空闲 |
| `$script:SnapIntervalSec` | 300 | 快照周期（同时决定后台时长的误差上限） |
| `$script:RetentionHours` | 72 | 日文件保留时长 |
| `$script:MaxTitleLen` | 200 | focus 标题截断 |
| `$script:MaxSnapTitleLen` | 120 | 快照标题截断 |
| `$script:MaxSnapWins` | 60 | 每张快照最多记多少窗口 |

`report.ps1` 的空闲阈值写死 600（与记录器一致）；`-Hours` / `-Top` 是命令行参数。
两处阈值若改了一处，报告的口径会歪，**要么一起改**。

## 实现要点 / 已知限制

- 全部 ASCII 的 `.ps1`：Windows PowerShell 5.1 对无 BOM 文件按 GBK 解码，中文注释会把语法搞崩。
- 写盘用 `StreamWriter`（UTF-8 无 BOM、`AutoFlush`），一行一次 `Flush`，不用 `Out-File -Append`。
- 单实例：命名互斥体 `Local\activity-recorder`，抢不到直接退出并写一行 log。
- CPU：每次轮询 2~3 次 Win32 调用 + 1 次进程名查询；`EnumWindows` 只在 5 分钟快照时做。
  实测常驻约 **0.78% 单核**（231 秒区间用了 1.81 秒 CPU），工作集 ~100 MB（PowerShell 自身基线，
  不随数据量增长——历史从不进内存）。
- 已知限制：
  - 进程名靠 `ProcessName + .exe`，拿不到（保护进程 / 已退出）时写 `unknown`。
  - 同一进程的多个窗口：后台时长按**进程**去重，一个进程每张快照最多记一个间隔。
  - 标题里如果含 emoji 等 BMP 外字符，JSON 仍是合法 UTF-8，但某些老工具读取可能不适配。
  - 计划任务的动作里写死了 `recorder.ps1` 的**绝对路径**（`<repo>\tools\activity-recorder\`）。
    移动/删除这个目录，任务下次启动就失败（任务本身还在，改路径请重跑 `install.ps1`）。
  - 任务被杀（关机 / 注销 / 强杀）时不会写 `stop`，只能靠下一条 `boot` 看出断点。
  - `bootTime` 由 `GetTickCount64` 反推，不含睡眠时间（本机不睡眠，所以够用）。
