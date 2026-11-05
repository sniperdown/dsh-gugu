/**
 * 「她自己的时间」定时器（2026-10-18 接上，用户拍的方案）。
 *
 * ## 它做的事
 * 每 60 秒醒一次，两个闹钟（**2026-10-23 起分长短**），四条闸都过了才叫她：
 *   1. `[free_time] enabled` 为真
 *   2. 现在在窗口内（`windowStartHour` ≤ 当前小时 < `windowEndHour`，24 表示"到当天结束"）
 *   3. 距上次（长：`intervalHours`；短：`followupMinutes`）
 *   4. **她不在忙**（`binder.locks` 里没有她那个会话）—— 忙就跳过，下一分钟再看
 *
 * 过了就叫醒她（走 `gateway.deliverFromAlice`，不经过 QQ 入站），拿回她这一轮说的话，
 * 再决定**发不发到 QQ**：她说 `[不说话]` 或干脆没说话 ⇒ 默认不发（`quietWhenNothing`）。
 *
 * ## 长唤醒 / 短追问（用户 2026-10-23 定稿，逐条确认过）
 *
 * 「最后一条」一律指**用户自己发的入站消息**（`gateway.handleEvent` 记进
 * `lastUserMessageAt`），**不是**她回的那句。锚点因此只有这一个：
 *
 * - **长唤醒**（原来的定时器，截图 + 「你自己的时间」）：
 *   条件 `now - max(上次长唤醒, 用户最后一条消息) ≥ intervalHours`。
 *   ⇒ **用户一说话，长钟就顺延**（例：10:00 长唤醒，10:30 用户说话 ⇒ 下次 12:30）。
 *   四道闸全过（含 `busy`）。
 * - **短追问**（`followupMinutes`，默认 10）：用户最后一条消息之后这么久还没动静
 *   ⇒ 叫她一声，问"你是不突然不回了"。
 *   **只过前三道**（enabled / 时间窗 / 距用户最后一条消息），**不查 `busy`**
 *   （她真在忙着回话，那就不叫"沉默"，这条钟本来也不会到点）。**不截图**。
 * - **短追问只响一次**：响了就置 `followupDone = true` 锁住，不会 10 分钟一次没完。
 *   **用户再发一条消息 ⇒ 重新武装**（`followupDone = false`，重新计 10 分钟）。
 * - 长唤醒成功后也把 `followupDone` 置真：她刚被叫醒过，再补一句追问没有意义。
 *
 * 两个闹钟**互不改写对方的锚点**：短追问不动 `lastRunAt`（那是长钟的锚），
 * 长唤醒也不清 `lastUserMessageAt`（那是"用户最后一句"的事实）。
 *
 * `skipReasons` 里**短追问的每一次跳过都以 `short-` 开头**（`short-too-soon` /
 * `short-done`），其余原因（`too-soon` / `busy` / `disabled` …）
 * 都是长唤醒那一侧 —— 事后看快照能一眼分开两边。
 *
 * ## 唤醒前先截屏（2026-10-21 起；2026-10-22 改成**每块屏一张**）
 *
 * 用户要求：叫醒她的时候让她**能看见屏幕现在什么样**。
 * **2026-10-22 改了口径**（用户原话：「两个屏幕 → 两张图，分开」）：以前是一张
 * 拼好的虚拟桌面，现在**每块屏一张**，`viewImages` 里放**全部**那几张
 * （`screen-capture.mjs` 拿不到多屏时会回落成合并一张，所以这里也要能处理 1 张）。
 *
 * 2026-10-21 补（用户拍的 B 方案）：源图可能大到让 DSH 附件管线**静默拒收**
 * （`IMAGE_TOO_LARGE`，不缩放也不报错）⇒ `screen-capture.mjs` 会在同一张位图上
 * **只换编码**（PNG → JPEG，尺寸一个像素不动），**每张各自判断**。
 * 这里**只认它返回的每张 `path`** —— 格式变了也不影响投递；日志里把 `format`、
 * `reencodeMs` 与 `count` 一起记上，好在快照里看出"这次几张、哪张重编码过"。
 *
 * 三条刻意的取舍：
 * - **截屏失败照常唤醒**（只发文字）：截图是"锦上添花"，不该变成"今天她不说话了"。
 * - **`capture` 默认 `null`**：不注入就完全不碰屏幕 —— 测试与老调用方都不会
 *   意外执行 PowerShell（唯一注入真实实现的是 `index.mjs`）。
 * - **只清自己写的 tmp**：保留最近 `screenshotsKeep` **轮**，别的文件一律不碰。
 *
 * ## 几个刻意的取舍
 * - **不排队**：她正在跟人说话（`binder.locks` 有锁）就整轮跳过，不是排到后面 ——
 *   排进去会让"她自己的时间"和"回用户的话"挤在一起，两件事都变怪。
 * - **不重试**：这一次没叫醒就算了，下一个 interval 再说；没有补叫机制（简单、可预测）。
 *   短追问也一样：**失败也算"响过了"**（`followupDone` 仍然置真）—— 一失败就每分钟重试，
 *   和"只追问一次"的语义直接打架。
 * - **只有两个字段持久化**：`lastUserMessageAt` / `followupDone`（2026-10-23）。
 *   它们是**跨重启的语义**（重启之后"用户最后一句是什么时候"不能忘，否则短追问会
 *   从零开始或立刻炸一轮）；计数类（`runs` / `sent` / `skipReasons` …）仍旧重启归零，
 *   那只是"当场一眼看"。
 *   落盘位置与写法**跟着现成的那套走**：`<DSH_HOME>\media\qq-proactive-free-time.json`，
 *   临时文件 + `rename` 原子替换、失败只记 debug（与 `qq-proactive-debug.json` /
 *   `qq-proactive-announce.json` 同一个目录、同一种小 JSON）。
 * - **回调自己吞异常**：它挂在 `ctx.interval` 上，抛出去就是宿主进程里的未捕获异常。
 *
 * ## 为什么不用 DSH 的 schedule
 * 勘察过（`shared/tmp/2026-10-17-入口勘察.md`）：schedule 触发的那一轮**不走插件的发送路径**，
 * 她说的话到不了 QQ；而且她的 preset 里根本没有 `schedule_*` 工具。
 * ⇒ 走插件自己的定时器 + 现成的内部通道。
 */

import fs from 'node:fs';
import path from 'node:path';

import { pruneScreenshots } from './screen-capture.mjs';

/**
 * 把 `{{名字}}` 占位符换成对应的值（2026-10-29，用户可以把提示词搬进配置页）。
 *
 * ⚠️ **replacement 一律传函数**（`() => text`），绝不传字符串：
 * 字符串作 replacement 时 [`$&` / `` $` `` / `$'` / `$1` / `$$` 会被**展开** ——
 * 用户填的提示词里只要出现一个 `$`，就可能把"匹配之前的整段内容"复制进来
 * （`apply-src-edits.mjs` 真踩过：40877 → 99157 字符）。
 * 传函数则**一切按字面**：中文引号、`$`、反斜杠、换行都不动。
 *
 * @param {unknown} template 用户填的原文
 * @param {Record<string, unknown>} values 占位符名 → 值（名字是本文件里写死的字面量）
 * @returns {string}
 */
function fillPlaceholders(template, values) {
  let out = String(template ?? '');
  for (const [name, value] of Object.entries(values)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g'), () => String(value ?? ''));
  }
  return out;
}

/**
 * 占位符里能用的日期 / 时间（**本地时区**，取这次唤醒的时刻）。
 *
 * @param {unknown} at 毫秒时间戳；不是有限数就用当下
 * @returns {{date: string, time: string}} `2026-10-29` / `09:05`
 */
function localDateTimeParts(at) {
  const d = new Date(Number.isFinite(at) ? Number(at) : Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * 叫醒她时说的那段话。内容随预算变，所以是函数。
 *
 * 2026-10-29：**配置优先**。`[free_time] wakePrompt` 写了非空文本 ⇒ 用那一份，
 * 并替换占位符 `{{budget}}` / `{{date}}` / `{{time}}`；没写 / 只有空白 ⇒
 * **原样用下面的内置文案**（那段是用户定稿的，一个字都不许改 —— 只是"变成兜底"）。
 *
 * @param {{tokenBudgetPerTurn?: number, wakePrompt?: string}} cfg
 * @param {number} [at] 这次唤醒的时刻（占位符 `{{date}}` / `{{time}}` 用）
 */
function buildWakePrompt({ tokenBudgetPerTurn, wakePrompt } = {}, at = Date.now()) {
  const budget = Number.isFinite(tokenBudgetPerTurn) ? tokenBudgetPerTurn : 20000;
  const custom = String(wakePrompt ?? '');
  if (custom.trim() !== '') {
    return fillPlaceholders(custom, { budget: String(budget), ...localDateTimeParts(at) });
  }
  return [
    '【你自己的时间】',
    '（这是插件按定时器自动叫醒你的一条内部提示 —— 不是用户在找你，也不用当成有人在问你话。）',
    '',
    '现在这一小段时间归你自己：可以上网看看东西、翻翻文件、想点事，或者什么都不干。',
    `这一轮大约 ${budget} token 的预算，差不多就收。`,
    '',
    '【这一版的边界】只做**看**的事情：不要删文件、不要改文件、不要往外发东西 ——',
    '「整理文件」这类会动东西的活，等用户另外开口再说。',
    '',
    '如果看到什么想告诉用户，直接说出来就行：插件会把这一轮的话发到 QQ 私聊（只发私聊）。',
    '如果这一轮没什么想说的，就只回一句 [不说话]，我不会发出去。',
  ].join('\n');
}

/**
 * 短追问时说的那段话（2026-10-23 加，用户定稿）。
 *
 * 与 {@link buildWakePrompt}（长唤醒）**刻意分开写**：长唤醒是"这段时间归你自己"，
 * 短追问是"他是不是突然不回了"。两件事混用一段提示词，她会把追问当成自省时间。
 *
 * 三条必须说清（对应需求的 ③）：
 * - 这是**短追问**，不是用户来找她；
 * - **别重复问**：同一个沉默只追问一次，再问一遍就是复读机；
 * - 没什么好问的就 `[不说话]`（沉默比硬凑一句好）。
 *
 * 2026-10-29：与长唤醒同一条口子 —— `[free_time] followupPrompt` 非空就用它
 * （占位符 `{{minutes}}` / `{{date}}` / `{{time}}`），空 ⇒ 原样用内置文案。
 *
 * @param {{followupMinutes?: number, followupPrompt?: string}} cfg
 * @param {number} [at] 这次唤醒的时刻（占位符用）
 */
function buildFollowupPrompt({ followupMinutes, followupPrompt } = {}, at = Date.now()) {
  const minutes = Number.isFinite(followupMinutes) && followupMinutes > 0 ? followupMinutes : 10;
  const custom = String(followupPrompt ?? '');
  if (custom.trim() !== '') {
    return fillPlaceholders(custom, { minutes: String(minutes), ...localDateTimeParts(at) });
  }
  return [
    '【短追问】',
    `（这是插件按定时器自动叫醒你的一次**短追问** —— 不是用户在找你。他最后一条消息之后已经 ${minutes} 分钟没有新消息了。）`,
    '',
    '去看会话最后那几句：他是不是话说了一半就没影了。',
    '如果确实像"突然不回了"，就轻轻问一句（比如"怎么突然不回了"）——',
    '**别重复你刚才已经问过的话**，也别把之前聊过的事再翻一遍；这轮沉默只追问这一次。',
    '',
    '如果其实没什么好追问的（比如是你说完了他还没回、或者本来就说完了），',
    '就只回一句 [不说话]，我不会发出去。',
  ].join('\n');
}

/**
 * 从 `capture()` 的返回值里取出**这次真正落盘的每一张图**。
 *
 * 新形状是 `{ ok, images: [{path, …}] }`（分屏后一次可能 1~N 张）；
 * 老的/替身形状只有 `{ ok, path }`。两种都要认 —— 少了这个兼容层，
 * 老调用方（和那些只塞了一个 `path` 的测试）会静默变成"不带图"。
 *
 * @param {unknown} shot
 * @returns {string[]}
 */
function shotPaths(shot) {
  if (shot === null || typeof shot !== 'object' || shot.ok !== true) return [];
  const list = Array.isArray(shot.images) ? shot.images : [];
  const paths = list
    .map((item) => (item !== null && typeof item === 'object' ? String(item.path ?? '').trim() : ''))
    .filter((item) => item !== '');
  if (paths.length > 0) return paths;
  const single = String(shot.path ?? '').trim();
  return single === '' ? [] : [single];
}

/**
 * 截图格式**只认这两个**：`png` / `jpeg`（`jpg` 归一化成 `jpeg`）。
 * 别的值一律当成"没说"（`''`）—— 宁可日志里空着，也不编一个格式出来。
 *
 * @param {unknown} value
 * @returns {'png'|'jpeg'|''}
 */
function normalizeShotFormat(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'jpeg' || text === 'jpg') return 'jpeg';
  if (text === 'png') return 'png';
  return '';
}

/**
 * 造一个「她自己的时间」执行器。
 *
 * @param {object} options
 * @param {object} options.gateway 需要 `deliverFromAlice` 与 `speakProactively`
 * @param {object} options.binder  用它判断"她在不在忙"（`binder.locks`）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {() => object} options.getConfig 每次现取（热重载/改 toml 后能反映新值）
 * @param {string} options.privateChatId 叫醒与发送的目标，形如 `private:30000001`
 * @param {((input: {outDir: string, timeoutMs: number}) => Promise<object>)|null} [options.capture]
 *   截屏函数（`screen-capture.mjs` 的 `captureVirtualDesktop`）。**默认 null = 不截屏** ——
 *   测试里绝不能真的去截图，所以真实实现由 `index.mjs` 显式注入。
 *   返回值认两种形状：`{ok, images:[{path}]}`（分屏）与 `{ok, path}`（老/替身）。
 * @param {string} [options.screenshotsDir] 截图落盘目录（空 = 不截屏）
 * @param {number} [options.captureTimeoutMs] 单次截图超时（分屏要截多张，别给太小）
 * @param {({dir: string, keep: number}) => object} [options.prune] 清理函数（测试可注入）
 *   ⚠️ `keep` 的单位是**轮**（一次唤醒 = 一轮 = 每块屏一张），不是文件数。
 * @param {string} [options.statePath] 跨重启状态的落盘路径（空 = 不落盘，测试默认）。
 *   只存 `lastUserMessageAt` / `followupDone` 两项 —— 见模块注释"只有两个字段持久化"。
 */
export function createFreeTime({
  gateway,
  binder,
  log = () => {},
  now = () => Date.now(),
  getConfig,
  privateChatId,
  capture = null,
  screenshotsDir = '',
  captureTimeoutMs = 15_000,
  prune = pruneScreenshots,
  statePath = '',
  // 用户的会话键（2026-10-24，P1-4 / P2-6）：由装配层用会话映射表解析好传进来。
  // 可以是**字符串**（固定）或**函数**（每 tick 现取 —— P2-6 之后新聊天会在第一次派发时
  // 才分配 uuid，构造时还查不到，所以必须现取）。空 ⇒ 回退旧前缀拼串（改动前行为）。
  // 它只用来**查 `binder.locks`（她忙不忙）** 和快照里的诊断字段 —— 不能靠它发消息
  // （发送一律用 `privateChatId`，那是 chatId，不会随会话 id 改名）。
  sessionKey: explicitSessionKey = '',
}) {
  const legacySessionKey = String(privateChatId ?? '').replace(/^private:/, 'qq-private-');
  const sessionKeyOf = () => {
    if (typeof explicitSessionKey === 'function') {
      try {
        const value = explicitSessionKey();
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
      } catch {
        /* 解析失败 ⇒ 回退旧前缀（宁可 busy 判错，也不让她不说话） */
      }
      return legacySessionKey;
    }
    return typeof explicitSessionKey === 'string' && explicitSessionKey.trim() !== ''
      ? explicitSessionKey.trim()
      : legacySessionKey;
  };
  /** 用户 QQ（`private:30000001` → `30000001`）。空串 = 认不出来。 */
  const ownerQq = String(privateChatId ?? '').replace(/^private:/, '').trim();

  /**
   * 状态。
   *
   * 只有 `lastUserMessageAt` / `followupDone` **跨重启**（见下面 `loadPersisted`）；
   * 其余都是计数，重启归零（和 `lastRunAt` 的老口径一致）。
   *
   * ⚠️ `lastRunAt` 是**长唤醒**的锚点，短追问**不动它** ——
   * 否则一次追问就会把 2 小时的长钟推后，两个闹钟会互相吃掉。
   */
  const state = {
    lastRunAt: null,
    /** 用户最后一条入站消息（长/短两个钟共同的锚点）。 */
    lastUserMessageAt: null,
    /** 这轮沉默是否已经追问过。`true` = 不用追问（初值就是"没有待追问的沉默"）。 */
    followupDone: true,
    lastFollowupAt: null,
    lastWakeKind: null,
    userMessages: 0,
    runs: 0,
    longWakes: 0,
    followups: 0,
    sent: 0,
    notices: 0,
    quiet: 0,
    skipped: 0,
    lastSkip: null,
    /** 按原因计数：lastSkip 会被覆盖，这个不会（排查"为什么没叫"用）。 */
    skipReasons: {},
    lastChars: 0,
    lastError: null,
    /**
     * 最后一条「用户消息」来自哪个会话（诊断用，2026-10-26）。
     *
     * 存在的理由：**短追问只该由私聊重新上膛**，而长唤醒锚点是"人还在"（跨会话合理）。
     * 这两件事分开了之后，"为什么刚在群里说过话还会收到私聊追问"就只能靠这个字段解释。
     */
    lastUserMessageChat: '',
    /** 因为用户**在私聊**说话而重新上膛的次数。 */
    rearms: 0,
    /** 用户说话但**不在私聊**（群里）⇒ 只推进长唤醒锚点、不给短追问上膛的次数。 */
    rearmSkipped: 0,
    /** 落盘失败次数（`persist()` 写不进去）。>0 ⇒ 下次重载可能丢锁。 */
    persistFailures: 0,
  };

  /** 短追问的间隔（毫秒）。`followupMinutes` 没配/不合法 ⇒ 10 分钟。 */
  function followupMsOf(cfg) {
    const minutes = Number.isFinite(cfg?.followupMinutes) && cfg.followupMinutes > 0 ? cfg.followupMinutes : 10;
    return minutes * 60 * 1000;
  }

  /**
   * 读回跨重启状态。
   *
   * 读不到 / 写坏了 / 类型不对 ⇒ **当成全新开始**（一个状态文件不该让唤醒起不来）。
   * `followupDone` 缺省按 `true`：文件是老的（还没有这个键）时，"没有待追问的沉默"
   * 比"立刻补一句追问"安全。
   */
  function loadPersisted() {
    if (statePath === '') return;
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      // 文件里写的是 ISO 字符串（人可读）；数字毫秒也认 —— 老/别处的写法不该炸。
      const rawAt = raw?.lastUserMessageAt;
      const at = typeof rawAt === 'number' ? rawAt : Date.parse(String(rawAt ?? ''));
      if (Number.isFinite(at) && at > 0) state.lastUserMessageAt = at;
      state.followupDone = raw?.followupDone !== false;
    } catch {
      /* 没写过 / 坏了 / 读不了 ⇒ 全新开始 */
    }
  }

  /**
   * 把跨重启状态落盘（原子写：临时文件 + rename）。
   *
   * **永不抛**：存不上只是"重启后少记一条"，绝不能让定时器停下来。
   */
  function persist() {
    if (statePath === '') return;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const payload = {
        lastUserMessageAt: state.lastUserMessageAt === null ? null : new Date(state.lastUserMessageAt).toISOString(),
        followupDone: state.followupDone,
        savedAt: new Date(now()).toISOString(),
      };
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, statePath);
    } catch (error) {
      // 🔴 2026-10-26：**写失败必须显性**。
      //
      // 为什么不能只 log debug：这个文件是**锁**的唯一跨重启载体 ——
      // 写不进磁盘时内存里 `followupDone=true` 看着一切正常，而下次热重载
      // 会把状态读回成旧的 `false` ⇒ 同一段沉默又追一次（用户看到的就是"连响两次"）。
      // 所以：进 `lastError` + 计数（快照看得见），日志抬到 warn。
      const detail = error instanceof Error ? error.message : String(error);
      state.persistFailures += 1;
      state.lastError = `状态没存上（重载后可能丢锁）：${detail}`;
      log('warn', '她自己的时间：状态没存上（重载后可能丢锁）', {
        error: detail,
        statePath,
        persistFailures: state.persistFailures,
      });
    }
  }

  // 构造时就把跨重启状态接回来（读不到 = 全新开始）。
  loadPersisted();

  /**
   * **用户自己发了一条消息**（`gateway.handleEvent` 的汇合点调进来）。
   *
   * 两条语义（用户定稿的 ④）：
   * - 短追问重新武装：`lastUserMessageAt = at` + `followupDone = false`；
   * - 长唤醒顺延：锚点取 `max(lastRunAt, lastUserMessageAt)`，所以这条也会把它推后。
   *
   * ## 🔴 2026-10-26：**只认用户的【私聊】能重新上膛**
   *
   * 用户原话：「我只是在问唤醒的不太对，**你这个是正常使用啊，改来干嘛**」——
   * 当时"在群里说了话 → 十分钟后私聊收到追问"被当成 bug 报上来，查下来是这样：
   * 原来的判据只有 `sender.user_id === 用户`，**不看是哪个会话** ⇒ 用户**在任何群**
   * 里说一句，都会给**私聊**的短追问重新上膛；十分钟后她就在私聊里追了一句
   * （"我没在私聊理你，凭什么追我"）。
   *
   * ⇒ 现在拆成两件事（`chatId` 是判据，不靠 sender）：
   *
   * | 这条消息来自 | 短追问上膛 | 长唤醒锚点 |
   * |---|---|---|
   * | **`private:<用户>`** | **重新上膛**（`followupDone=false`） | 推进 |
   * | 别的会话（群 / 别人） | **不动**（`rearmSkipped += 1`） | 推进 |
   * | 不是用户 / 认不出 | 不动 | 不动 |
   *
   * 为什么长锚点仍然跨会话：那条语义是"**人还在，别打扰**"（他群聊两句也算没走开），
   * 和"你没回我私聊"是两回事。混成一个就是这次的事故。
   *
   * ⚠️ **只认用户 QQ 发的**：群友说话不是"用户说话"，否则活跃群里她的长唤醒
   *    会被别人的闲聊永远推后、短追问还会按别人的节奏冒出来。
   * ⚠️ 比现有锚点更早的时间戳（断线补发 / 乱序）直接忽略 —— **别把锚点往回拨**。
   * ⚠️ **没有 `chatId` 的调用一律不重新上膛**（fail-closed）：少追一次只是安静，
   *    多追一次是打扰。网关总会带 `chatId`，测试要按真实形状造。
   *
   * @param {{userId?: string, at?: number, chatId?: string}} message 归一化后的入站消息
   * @returns {boolean} 真的记下来没有（**记下锚点**就算 —— 群消息也算，只是不上膛）
   */
  function noteUserMessage(message) {
    try {
      if (ownerQq === '') return false;
      const userId = String(message?.userId ?? '').trim();
      if (userId === '' || userId !== ownerQq) return false;
      const raw = Number(message?.at);
      const at = Number.isFinite(raw) && raw > 0 ? raw : now();
      if (state.lastUserMessageAt !== null && at < state.lastUserMessageAt) return false;
      const chatId = String(message?.chatId ?? '').trim();
      state.lastUserMessageAt = at;
      state.lastUserMessageChat = chatId;
      state.userMessages += 1;
      // 🔴 只有**私聊**能重新上膛（见上表）。`privateChatId` 形如 `private:30000001`。
      if (chatId !== '' && chatId === privateChatId) {
        state.followupDone = false;
        state.rearms += 1;
      } else {
        // 群消息（或认不出的会话）：只推进长唤醒锚点，**不给短追问上膛**。
        state.rearmSkipped += 1;
      }
      persist();
      return true;
    } catch (error) {
      // 这个函数挂在入站热路径上（每条消息一次）⇒ 绝不往外抛。
      log('debug', '她自己的时间：记用户消息失败（忽略）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 走一次闸。返回"该不该叫她"、是哪个闹钟（`kind`）、和为什么。
   * 拆出来是为了**可测**，也让 skipped 的原因能被快照看见（坏了要看得出来）。
   *
   * 顺序 = **先长后短**：长唤醒该响就响（它带截图和自省提示词）；
   * 只有当长钟还没到点时，才看短追问。
   */
  function shouldWake(at) {
    const cfg = getConfig() ?? {};
    if (cfg.enabled !== true) return { wake: false, reason: 'disabled', kind: 'long' };

    const hour = new Date(at).getHours();
    const start = Number.isFinite(cfg.windowStartHour) ? cfg.windowStartHour : 0;
    const end = Number.isFinite(cfg.windowEndHour) ? cfg.windowEndHour : 24;
    if (hour < start || hour >= end) return { wake: false, reason: `outside-window(${hour})`, kind: 'long' };

    // ── ① 长唤醒：锚点 = max(上次长唤醒, 用户最后一条消息) ──
    // 用户说话就把长钟顺延（⑤）—— 这是 2026-10-23 改的语义，之前只认 lastRunAt。
    const intervalMs = (Number.isFinite(cfg.intervalHours) && cfg.intervalHours > 0 ? cfg.intervalHours : 3) * 3600 * 1000;
    const anchors = [state.lastRunAt, state.lastUserMessageAt].filter((value) => value !== null);
    const anchor = anchors.length === 0 ? null : Math.max(...anchors);
    if (anchor === null || at - anchor >= intervalMs) {
      // 她在忙（正在回用户 / 正在跑别的内部轮）⇒ 整轮跳过，不排队。
      if (binder !== null && typeof binder === 'object' && binder.locks instanceof Map && binder.locks.has(sessionKeyOf())) {
        return { wake: false, reason: 'busy', kind: 'long' };
      }
      return { wake: true, reason: 'go', kind: 'long', cfg };
    }

    // ── ② 短追问：只过前三道闸（enabled / 时间窗 / 距用户最后一条消息）──
    // **不查 busy**：她真在忙着回话，那就不叫"沉默"，这条钟本来也到不了点。
    //
    // 还没人说过话 ⇒ 报 `too-soon`（长钟还没到点，也没有"沉默"可追问）——
    // 这是**改动前的老原因**，让"没到点"在快照里沿用同一个词。
    if (state.lastUserMessageAt === null) return { wake: false, reason: 'too-soon', kind: 'long' };
    if (state.followupDone) return { wake: false, reason: 'short-done', kind: 'short' };
    if (at - state.lastUserMessageAt < followupMsOf(cfg)) {
      return { wake: false, reason: 'short-too-soon', kind: 'short' };
    }
    return { wake: true, reason: 'go', kind: 'short', cfg };
  }

  /**
   * 唤醒前截屏（默认每块屏一张；拿不到多屏就是合并一张）。
   *
   * **永不抛**：截图失败返回 `{ok:false, ...}`，调用方照常唤醒（只发文字）。
   * 成功时顺手把旧图清到只剩最近 `screenshotsKeep` **轮** —— **只删自己写的** `shot-*`。
   *
   * @param {object} cfg `[free_time]` 的生效值
   * @returns {Promise<{ok: boolean, paths: string[], count: number, mode: string, width: number, height: number, bytes: number, format: string, reencodeMs: number, ms: number, error?: string}|null>}
   *   `null` = 这次不截（关掉了 / 没注入实现 / 没配目录）
   */
  async function takeScreenshot(cfg) {
    if (cfg.screenshots === false) return null;
    if (typeof capture !== 'function') return null;
    const dir = String(screenshotsDir ?? '').trim();
    if (dir === '') return null;

    const started = now();
    let shot = null;
    try {
      shot = await capture({ outDir: dir, timeoutMs: captureTimeoutMs });
    } catch (error) {
      // 截屏实现自己崩了也不能带走这次唤醒。
      shot = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    const ok = shot !== null && typeof shot === 'object' && shot.ok === true;
    const paths = ok ? shotPaths(shot) : [];
    // 有 images 但一张路径都没有 ⇒ 这不是"截到了"，按失败处理（不能空手说 ok）。
    const good = ok && paths.length > 0;
    // 🔴 2026-10-29：**喂给模型几张**（`screenshotsMaxPerWake`）和"落盘几张"是两件事 ——
    // 落盘照旧每块屏一张（清理按轮算），这里只截**投递**列表的前 N 张（按屏序）。
    // ⚠️ 别和 `screenshotsKeep`（磁盘保留**轮**数）混用：那个管删图，这个管看图。
    const cap = Number.isFinite(Number(cfg.screenshotsMaxPerWake)) && Number(cfg.screenshotsMaxPerWake) > 0
      ? Math.floor(Number(cfg.screenshotsMaxPerWake))
      : 2;
    const delivered = good ? paths.slice(0, cap) : [];
    const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    const meta = {
      ok: good,
      // 2026-10-22：分屏之后一次可能 1~N 张，**全部**都进 viewImages；
      // `count` 与 `mode` 让快照/日志一眼看出"这次分屏成了没有"。
      // ⚠️ `count` 是**截到几张**（落盘几张），不是"喂给模型几张"（那个见下面的日志）。
      count: paths.length,
      mode: good ? String(shot.mode ?? '').trim() : '',
      width: good ? finite(shot.width) : 0,
      height: good ? finite(shot.height) : 0,
      bytes: good ? finite(shot.bytes) : 0,
      // 2026-10-21：源图太大时落盘的是 JPEG（同尺寸、只换编码），
      // 所以"这次带的是哪种图"必须进日志 —— 光看 bytes 看不出是重编码过的。
      format: good ? normalizeShotFormat(shot.format) : '',
      reencodeMs: good ? finite(shot.reencodeMs) : 0,
      ms: Number.isFinite(Number(shot?.ms)) ? Number(shot.ms) : Math.max(0, now() - started),
    };
    // ⚠️ 这条日志就是"压缩前"的基准：宽/高/字节数 + 耗时（+ 格式与重编码耗时）。DSH 附件管线之后
    //    会按它自己的上限处理，我们**不加任何自己的缩放**（用户明确要求的）。
    log(good ? 'info' : 'warn', '她自己的时间：截屏', good ? meta : { ...meta, error: String(shot?.error ?? 'unknown') });

    if (!good) return { ...meta, paths: [], error: String(shot?.error ?? 'unknown') };

    // 截到 3 张、上限 2 ⇒ 只带前 2 张。**单独一条日志**：不塞进上面那条 meta，
    // 是因为那条的形状已经被测试钉死（deepEqual），而且"投递被截断"是另一件事。
    if (delivered.length < paths.length) {
      log('info', '她自己的时间：截图超过每轮上限，只带前几张', {
        captured: paths.length,
        sent: delivered.length,
        screenshotsMaxPerWake: cap,
      });
    }

    // 清理：只保留最近 screenshotsKeep **轮**（只认 `shot-*`，别的东西不碰）。
    // ⚠️ 2026-10-22：以前 keep 是"文件数"，分屏一次产生 2 张后会**当场删掉上一轮**
    //   （表面上"保留 2 张"，实际永远只有最新一轮）。现在按时间戳分组，keep = 轮数。
    try {
      const keep = Number.isFinite(Number(cfg.screenshotsKeep)) && Number(cfg.screenshotsKeep) > 0
        ? Math.floor(Number(cfg.screenshotsKeep))
        : 2;
      if (typeof prune === 'function') prune({ dir, keep });
    } catch {
      /* 清理失败不影响这一轮 */
    }
    return { ...meta, paths: delivered };
  }

  /**
   * 叫醒她一轮。
   * @returns {Promise<{woke: boolean, reason: string, sent: boolean, chars: number}>}
   *   **永不 reject** —— 它挂在定时器上。
   */
  async function tick() {
    try {
      return await runOnce();
    } catch (error) {
      // 兜底：这个函数挂在 `ctx.interval` 上，**任何**抛出去都会变成宿主进程里的
      // 未捕获异常（2026-10-14 那次就是这么把 DSH 弄得起不来的）。
      state.lastError = error instanceof Error ? error.message : String(error);
      log('warn', '她自己的时间：tick 兜底捕获', { error: state.lastError });
      return { woke: false, reason: 'tick-error', sent: false, chars: 0 };
    }
  }

  async function runOnce() {
    const at = now();
    const gate = shouldWake(at);
    if (!gate.wake) {
      state.skipped += 1;
      state.lastSkip = gate.reason;
      // 短追问的跳过原因一律以 `short-` 开头（见 `shouldWake`），所以这张表
      // 天然分开两边：`short-*` = 短追问没响，其余 = 长唤醒没响。
      state.skipReasons[gate.reason] = (state.skipReasons[gate.reason] || 0) + 1;
      return { woke: false, reason: gate.reason, sent: false, chars: 0 };
    }

    const cfg = gate.cfg;
    const isLong = gate.kind !== 'short';
    state.runs += 1;
    state.lastWakeKind = isLong ? 'long' : 'short';
    if (isLong) {
      // `lastRunAt` 只由**长唤醒**推进；短追问不动它（否则会把长钟越推越远）。
      state.lastRunAt = at;
      state.longWakes += 1;
    } else {
      state.followups += 1;
      state.lastFollowupAt = at;
      // ③ 一响就锁住：这轮沉默**只追问一次**，下一分钟不会再问。
      //    用户再发消息才重新武装（`noteUserMessage`）。
      //    ⚠️ 放在投递**之前**：投递失败也算"响过了" —— 一失败就每分钟重试，
      //       和"只追问一次"的语义直接打架。
      state.followupDone = true;
      persist();
    }

    let reply = '';
    // 先截图、再叫醒（"唤醒前"）：成功 ⇒ **每一块屏的图**都作为**进**方向的 `viewImages`
    // 一起投递（`deliverFromAlice` 认得本机路径）；失败 ⇒ 只发文字，**不跳过唤醒**。
    // ⚠️ 2026-10-22：以前只传 `[shot.path]`，分屏之后那样等于**只让她看一块屏**。
    // 🔴 2026-10-23：**短追问不截图**（用户明确要求：截图只给长唤醒）。
    const shot = isLong ? await takeScreenshot(cfg) : null;
    const viewImages = shot !== null && shot.ok === true && Array.isArray(shot.paths) ? [...shot.paths] : [];
    try {
      reply = await gateway.deliverFromAlice({
        // 提示词能被配置覆盖（2026-10-29）：`[free_time] wakePrompt` / `followupPrompt`；
        // 空 ⇒ 用本文件里的内置文案。`at` 只给占位符 `{{date}}` / `{{time}}` 用。
        text: isLong ? buildWakePrompt(cfg, at) : buildFollowupPrompt(cfg, at),
        replyTo: null,
        viewImages,
      });
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      log('warn', isLong ? '她自己的时间：叫醒失败' : '她自己的时间：短追问失败', { error: state.lastError });
      if (!isLong) return { woke: true, reason: 'followup-error', sent: false, chars: 0 };
      // ⚠️ 叫醒失败**不该占掉整个 interval**（默认 3 小时，一次瞬时错误就废掉一下午）。
      // 把 lastRunAt 往回拨到"距现在只剩 RETRY_MS"，下一次 tick 就会在约 5 分钟后重试。
      // 反复失败时退化成"每 5 分钟试一次"，比"每 3 小时"更容易发现，也不会打爆。
      const cfg0 = getConfig() ?? {};
      const ivMs = (Number.isFinite(cfg0.intervalHours) && cfg0.intervalHours > 0 ? cfg0.intervalHours : 3) * 3600 * 1000;
      state.lastRunAt = at - ivMs + 5 * 60 * 1000;
      return { woke: true, reason: 'wake-error', sent: false, chars: 0 };
    }

    // 叫醒成功了（不管她说不说话）⇒ 上一轮的故障原因作废，别让快照长期挂着旧错误。
    state.lastError = null;
    state.lastSkip = null;
    // 长唤醒成功 ⇒ 她刚被叫醒过，待追问的短钟可以撤了（再补一句"你怎么不回"
    // 是重复打扰）。同理，长唤醒也证明"这轮沉默已经处理过"。
    if (isLong && state.followupDone !== true) {
      state.followupDone = true;
      persist();
    }

    const text = String(reply ?? '').trim();
    // ⚠️ 只认"整条就是这个标记"，或者"很短且含它"。
    //    原来的 `includes` 匹配会把「她说了一堆，末尾提一句[不说话]」整条吞掉 —— 那是丢内容。
    const quietMark = /^[\s（(【\[]*不说话[\s）)】\]]*$/u.test(text)
      || (text.length <= 12 && text.includes('不说话'));
    const empty = text === '' || quietMark;
    state.lastChars = text.length;

    // 没东西可说 ⇒ 默认不发（这就是 quietWhenNothing 的"空手不吵"）。
    // `quietWhenNothing=false` 时**发一句极短的状态**（不是编内容，只是让她"在场"），
    // 这是这个开关目前唯一的作用 —— 想要"每次都必须说点什么"是另一回事，别用这个键表达。
    if (empty) {
      state.quiet += 1;
      if (cfg.quietWhenNothing === false) {
        try {
          const okNotice = await gateway.speakProactively(privateChatId, '（她这轮没什么想说的）');
          // 这条**确实发出去了**，所以计入 sent —— 否则统计里永远看不出来它动过。
          if (okNotice === true) state.notices += 1;
        } catch (error) {
          state.lastError = error instanceof Error ? error.message : String(error);
          log('warn', '她自己的时间：状态句没发出去', { error: state.lastError });
        }
      }
      return { woke: true, reason: 'quiet', sent: false, chars: text.length };
    }

    // 她说的话要发出去。**走 speakProactively**：同一道出站白名单 + 台账，不自己拼发送。
    try {
      const ok = await gateway.speakProactively(privateChatId, text);
      if (ok === true) {
        state.sent += 1;
        return { woke: true, reason: 'sent', sent: true, chars: text.length };
      }
      state.skipped += 1;
      state.lastSkip = 'speak-blocked';
      return { woke: true, reason: 'speak-blocked', sent: false, chars: text.length };
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      log('warn', '她自己的时间：发出去失败', { error: state.lastError });
      return { woke: true, reason: 'send-error', sent: false, chars: text.length };
    }
  }

  /** 给快照用（只读副本）。 */
  function stats() {
    const cfg = getConfig() ?? {};
    const followupMs = followupMsOf(cfg);
    return {
      sessionKey: sessionKeyOf(),
      lastRunAt: state.lastRunAt === null ? null : new Date(state.lastRunAt).toISOString(),
      /** 用户最后一条入站消息（长/短两个钟共同的锚点）；`null` = 重启后还没人说过话。 */
      lastUserMessageAt: state.lastUserMessageAt === null ? null : new Date(state.lastUserMessageAt).toISOString(),
      /** 这轮沉默是否已经追问过。`true` = 短钟已响过（或者还没人说话）。 */
      followupDone: state.followupDone,
      /** 下一次短追问的时刻；`null` = 没有待追问的沉默。 */
      nextFollowupAt: state.lastUserMessageAt === null || state.followupDone
        ? null
        : new Date(state.lastUserMessageAt + followupMs).toISOString(),
      lastFollowupAt: state.lastFollowupAt === null ? null : new Date(state.lastFollowupAt).toISOString(),
      lastWakeKind: state.lastWakeKind,
      userMessages: state.userMessages,
      /** 最后一条用户消息来自哪个会话（`private:…` / `group:…`）；空 = 还没记过。 */
      lastUserMessageChat: state.lastUserMessageChat,
      /** 私聊重新上膛 / 群聊只推锚点 的次数（2026-10-26 拆分后才有意义）。 */
      rearms: state.rearms,
      rearmSkipped: state.rearmSkipped,
      /** 落盘失败次数（>0 ⇒ 下次重载可能丢锁）。 */
      persistFailures: state.persistFailures,
      runs: state.runs,
      /** 长短分开计数（`runs` = 两者之和）：看快照就知道短追问到底响没响过。 */
      wakes: { long: state.longWakes, short: state.followups },
      sent: state.sent,
      notices: state.notices,
      quiet: state.quiet,
      skipped: state.skipped,
      lastSkip: state.lastSkip,
      // 按原因累计（`lastSkip` 只记最后一次，会被覆盖 ⇒ 单独一份才看得出"到底卡在哪"）。
      // 2026-10-20：采集早就在 `runOnce` 里了，只是没吐出来 —— 快照里看不见就等于没采。
      // 2026-10-23：短追问的跳过原因都带 `short-` 前缀，所以这张表能分开两边。
      // 浅拷贝：`stats()` 的契约是"只读副本"，把内部那份直接递出去会被调用方改坏。
      skipReasons: { ...state.skipReasons },
      lastChars: state.lastChars,
      lastError: state.lastError,
    };
  }

  return { tick, shouldWake, stats, noteUserMessage };
}
