#!/usr/bin/env node
/**
 * 小鲸鱼体检 —— **纯读文件、零 LLM、秒级**。
 *
 * ## 它为什么存在
 *
 * 这几天（2026-10-14 ~ 10-16）反复撞的都是同一族问题：**不报错、计数一切正常、
 * 只是悄悄少了一样东西**。已经实际发生过的：
 *
 * | 事故 | 症状 | 靠什么发现 |
 * |---|---|---|
 * | `writeSnapshot` 不吞异常 | DSH 连崩三次、起不来 | 崩溃日志 |
 * | 热重载摘掉 persona | 群里小鲸鱼"说话很生硬"，我们答"生效了"好几次 | 事后比对 system prompt 长度 |
 * | 30B 模型是哑巴 | 19 次调用全返回空补全 | 自己加诊断才看见 |
 * | **突发全放行** | 示例群 10 秒连发 6 条 | 用户肉眼看见 |
 * | **同文 4 连发** | 同一条文本发了 4 次 | 用户肉眼看见 |
 *
 * **⇒ 共同点：没有一处会主动告诉你。这个脚本就是把那几处变成"跑一下就知道"。**
 *
 * ## 为什么不做成常驻/定时
 *
 * 用户 2026-10-15 明确说过：「防下次的功能用不太上，**白烧 token**，别搞」。
 * ⇒ 所以这里**一个 LLM 都不调**，只读文件 ⇒ **零 token**；而且**不常驻**，你要看才跑。
 *
 * ## 用法
 *
 * ```
 * node qq-plugin/tools/qq-health.mjs              # 紧凑 ASCII 汇总（控制台安全）
 * node qq-plugin/tools/qq-health.mjs --out 报告.txt  # 完整中文详情写文件
 * node qq-plugin/tools/qq-health.mjs --json        # 机器可读
 * ```
 *
 * 退出码：**0 = 全过；1 = 有 FAIL**（方便脚本化；WARN 不算失败）。
 *
 * ## 路径覆盖（换部署时用）
 *
 * 默认读本部署：`<DSH_HOME>`。
 * 可用环境变量覆盖：`QQ_HEALTH_HOME`（dsh-home 根）、`QQ_HEALTH_WORKSPACE`（工作区）。
 *
 * ## ⚠️ 三条读文件的坑（都在这脚本里处理了，改的时候别踩回去）
 *
 * 1. **`session.v4.jsonl.zstd` 是【多帧】zstd** —— 普通解压只解第一帧，
 *    你会拿到几十 KB 里的一小段还以为会话很短（2026-10-15 实测）。
 * 2. **`system/message` 只在提示词【变了】的时候才落一条** ⇒ 它是"变更史"，不是"每轮记录"。
 *    所以"最新一条里有没有人格"是能判的，但"这 190 轮都在用什么"判不了。
 * 3. **`agent/inbox/spliced` 和 `user/message` 常常是同一份内容的两条记录**
 *    （AGENTS.md 记过）⇒ 数条数时要去重，别当成两条。
 */
import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from '../src/dsh/paths.mjs';
import zlib from 'node:zlib';

// ---------------------------------------------------------------- 配置

const HOME = process.env.QQ_HEALTH_HOME ?? dshHome();
const WORKSPACE = process.env.QQ_HEALTH_WORKSPACE ?? '<workspace>';
const SESSION_ROOT = path.join(HOME, 'sessions', '--H-deepseek-harness-workspace--');
const SNAPSHOT = path.join(HOME, 'media', 'qq-proactive-debug.json');
const OUTBOUND = path.join(HOME, 'media', 'qq-outbound.jsonl');

/**
 * 「两条发言之间短于这个就算异常」。
 *
 * 取值依据：配置里**最短的合法间隔**是 `focusMinIntervalMs`（默认 3000，2026-10-16 实测线上就是它）。
 * ⇒ 这里取 **2900**，贴着那个下界再低 100ms 留一点时钟抖动余量：
 *   **比 2.9 秒还密，在本部署任何配置下都不该发生。**
 *
 * ⚠️ 这是**保守**阈值 —— 刻意不设成"该群配置的 minIntervalMs"（那要解析 toml + 按群覆盖，
 * 而且一旦有人把 `focusMinIntervalMs` 调更小就会误报）。
 * 代价是**只抓最严重的**（比如 10-16 那次 1726ms / 1982ms 都在网内，
 * 但"60 秒间隔下 20 秒发一条"这种它不报）。**宁可漏报，不可误报** ——
 * 一个会喊狼来了的监控比没有更糟。
 */
const TOO_CLOSE_MS = 2_900;

/** 同一会话里两条【完全相同】的正文短于这个间隔 ⇒ 判定为重复发送。 */
const DUP_TEXT_WINDOW_MS = 10_000;

/** 快照多久没更新就提示（不是失败——群里没人说话时它本来就不更新）。 */
const SNAPSHOT_STALE_WARN_MS = 30 * 60_000;

/** 只看台账的最后这么多行（文件是只追加的，会一直长）。 */
const LEDGER_TAIL_LINES = 4000;

/**
 * 台账只看**最近这么久**的记录（默认 24 小时）。`--since-hours N` 可覆盖，`0` = 不限。
 *
 * ⚠️ 为什么必须有这个窗口（2026-10-16 实测的教训）：
 * 台账是**只追加的历史** ⇒ 不加窗口时，10-14 和 10-16 那两次已经修好的事故
 * **会永远报 FAIL** ⇒ 体检**永远是红的** ⇒ 一个永远红的体检等于没有体检。
 *
 * ⚠️⚠️ **但"最近 24 小时"还不够** —— 2026-10-16 第一次修完就踩到了：
 * 那次事故（12:04）就在当天、落在 24 小时窗内，于是**修完照样红**。
 * 而它其实是**修复前的旧代码**干的，拿它判新代码是错的。
 *
 * ⇒ **真正的判据是"当前这份代码有没有出过事"**，所以窗口下界还要再取
 * `staleCode.since`（= 运行中那份代码被加载的时刻）：
 * ```
 * cutoff = max(now − sinceHours, staleCode.since)
 * ```
 * 每次热重载 `since` 都会前移 ⇒ 窗口自动重置 ⇒ **它只判新代码。**
 * 代价：刚重载完没有数据可判 —— 那种情况报 **WARN（"没验成"）而不是 PASS**，
 * 免得"没数据"被读成"没问题"。
 */
const DEFAULT_SINCE_HOURS = 24;

// ---------------------------------------------------------------- 工具

const results = [];
const info = [];

/**
 * 记一条检查结论。
 * @param {'PASS'|'WARN'|'FAIL'} level
 * @param {string} id 稳定的 ASCII 标识（给脚本/表格用）
 * @param {string} zh 中文说明（写进 --out 的报告）
 * @param {string} [detail]
 */
function check(level, id, zh, detail = '') {
  results.push({ level, id, zh, detail });
}

function note(zh) {
  info.push(zh);
}

const now = Date.now();
const fmt = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '-');
const ageMin = (ms) => Math.round((now - ms) / 60_000);

/** 多帧 zstd：按魔数切帧、逐帧解、拼起来。 */
function readZstdMultiFrame(file) {
  const raw = fs.readFileSync(file);
  const MAGIC = Buffer.from('28b52ffd', 'hex');
  let idx = 0;
  const parts = [];
  let frames = 0;
  let failed = 0;
  while (true) {
    const i = raw.indexOf(MAGIC, idx);
    if (i < 0) break;
    const n = raw.indexOf(MAGIC, i + 4);
    const chunk = n < 0 ? raw.subarray(i) : raw.subarray(i, n);
    try {
      parts.push(zlib.zstdDecompressSync(chunk).toString('utf8'));
      frames += 1;
    } catch {
      failed += 1;
    }
    if (n < 0) break;
    idx = n;
  }
  return { text: parts.join(''), frames, failed, bytes: raw.length };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 检查 ①：快照

let snapshot = null;
if (!fs.existsSync(SNAPSHOT)) {
  check('FAIL', 'snapshot-missing', '找不到调试快照 —— 插件可能从没加载过',
    `期望路径：${SNAPSHOT}`);
} else {
  snapshot = readJsonSafe(SNAPSHOT);
  const st = fs.statSync(SNAPSHOT);
  if (snapshot === null) {
    check('FAIL', 'snapshot-broken', '快照存在但解析不了（写坏了）', SNAPSHOT);
  } else {
    // staleCode：代码有没有真的被加载
    const stale = snapshot.staleCode?.stale;
    if (stale === true) {
      check('FAIL', 'code-stale', 'staleCode.stale = true ⇒ 跑的不是最新代码（HMR 没重载）',
        `newestFile=${snapshot.staleCode?.newestFile ?? '?'}`);
    } else {
      check('PASS', 'code-stale', '代码是最新的（staleCode.stale = false）',
        `newestFile=${snapshot.staleCode?.newestFile ?? '?'}  since=${snapshot.staleCode?.since ?? '?'}`);
    }
    // 快照新鲜度（只是提示：群里没人说话它本来就不更新）
    const age = now - st.mtimeMs;
    if (age > SNAPSHOT_STALE_WARN_MS) {
      check('WARN', 'snapshot-age', `快照 ${ageMin(st.mtimeMs)} 分钟没更新（群里没人说话时正常）`,
        `mtime=${fmt(st.mtimeMs)}`);
    } else {
      check('PASS', 'snapshot-age', `快照新鲜（${ageMin(st.mtimeMs)} 分钟内更新过）`, fmt(st.mtimeMs));
    }
    note(`stats: received=${snapshot.stats?.received} dispatched=${snapshot.stats?.dispatched} replies=${snapshot.stats?.replies}`);
    note(`judgeMode=${snapshot.proactive?.judgeMode} precheck=${snapshot.proactive?.precheck?.enabled}`);
    note(`mood: ${snapshot.mood?.provider}/${snapshot.mood?.model} effort=${JSON.stringify(snapshot.mood?.reasoningEffort)}`);
  }
}

// ---------------------------------------------------------------- 检查 ②：人格在不在

const personaMissing = [];
const sysPromptInfo = [];
if (fs.existsSync(SESSION_ROOT)) {
  for (const d of fs.readdirSync(SESSION_ROOT)) {
    if (!d.startsWith('qq-')) continue;
    const f = path.join(SESSION_ROOT, d, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(f)) continue;
    let data;
    try {
      data = readZstdMultiFrame(f);
    } catch {
      continue;
    }
    const lines = data.text.split('\n').filter(Boolean);
    let last = null;
    for (const l of lines) {
      if (!l.includes('"type":"system/message"')) continue;
      try {
        const o = JSON.parse(l);
        const tx = o.data?.message?.content?.map((c) => c.text ?? '').join('') ?? '';
        last = { at: o.time, tx };
      } catch {
        /* 坏行跳过 */
      }
    }
    if (last === null) continue;
    const hasPersona = last.tx.includes('你是「小鲸鱼」');
    const hasMood = last.tx.includes('你现在的心情：');
    sysPromptInfo.push({ session: d, at: last.at, len: last.tx.length, hasPersona, hasMood });
    if (!hasPersona) personaMissing.push(d);
  }
}
if (sysPromptInfo.length === 0) {
  check('WARN', 'persona-nodata', '没读到任何 QQ 会话的 system prompt ⇒ 这项没验成');
} else if (personaMissing.length > 0) {
  check('FAIL', 'persona-missing',
    `有 ${personaMissing.length} 个会话的最新提示词【没有人格】⇒ 那个群的小鲸鱼是"没性格"的`,
    personaMissing.join(', '));
} else {
  check('PASS', 'persona-missing', `全部 ${sysPromptInfo.length} 个 QQ 会话的最新提示词都带人格`);
}
for (const s of sysPromptInfo) {
  note(`  ${s.session}  最新提示词 ${fmt(s.at)}  len=${s.len}  人格=${s.hasPersona ? 'OK' : 'MISSING'}  心情句=${s.hasMood ? 'YES' : 'no'}`);
}

// ---------------------------------------------------------------- 检查 ③+④：出站台账

let ledgerRows = [];
if (!fs.existsSync(OUTBOUND)) {
  check('WARN', 'ledger-missing', '找不到出站台账 ⇒ 发送相关的两项没验成', OUTBOUND);
} else {
  const all = fs.readFileSync(OUTBOUND, 'utf8').split('\n').filter(Boolean);
  const tail = all.slice(-LEDGER_TAIL_LINES);
  const sinceIdx = process.argv.indexOf('--since-hours');
  const sinceHours = sinceIdx >= 0 ? Number(process.argv[sinceIdx + 1]) : DEFAULT_SINCE_HOURS;
  const byAge = Number.isFinite(sinceHours) && sinceHours > 0 ? now - sinceHours * 3600_000 : 0;
  // ★ 下界还要取 `staleCode.since`（运行中那份代码被加载的时刻）—— 见 DEFAULT_SINCE_HOURS 的注释。
  // ⚠️ `--since-hours 0` = **真的不限**（连"只看当前代码"也放开），那是**取证**用的：
  //    要回看历史事故时用它。第一版写成了 `max(0, loadedAt)` ⇒ 那个开关形同虚设（实测踩到）。
  const loadedAt = Date.parse(snapshot?.staleCode?.since ?? '') || 0;
  const noLimit = !(Number.isFinite(sinceHours) && sinceHours > 0);
  const cutoff = noLimit ? 0 : Math.max(byAge, loadedAt);
  let skippedOld = 0;
  for (const l of tail) {
    try {
      const o = JSON.parse(l);
      if (o.layer !== 'gw-send') continue; // 只看"决定要发"那一层
      const at = Date.parse(o.at ?? '') || 0;
      if (at <= 0) continue;
      if (cutoff > 0 && at < cutoff) { skippedOld++; continue; }
      ledgerRows.push({ at, chatId: o.chatId, sha: o.sha256, chars: o.chars, caller: o.caller });
    } catch {
      /* 坏行跳过 */
    }
  }
  ledgerRows.sort((a, b) => a.at - b.at);
  note(`台账：最近 ${tail.length} 行里，窗口内的 gw-send ${ledgerRows.length} 条`
    + (cutoff > 0 ? `（排除 ${skippedOld} 条更早的）` : '（不限时间）'));
  if (loadedAt > 0) note(`窗口下界 = max(now−${sinceHours}h, 代码加载时刻 ${new Date(loadedAt).toLocaleString('zh-CN', { hour12: false })})`);

  // ④ 同文短窗重复
  //
  // ⚠️ 窗口内**一条记录都没有**时，如实报 WARN（"没验成"）而不是 PASS ——
  // 刚热重载完就是这样，而"没数据"和"没问题"必须分得开（这个项目反复栽在这上面）。
  if (ledgerRows.length === 0) {
    check('WARN', 'duplicate-send', '窗口内没有发送记录 ⇒ 这项【没验成】（刚重载过就会这样，不是通过）');
    check('WARN', 'send-too-close', '窗口内没有发送记录 ⇒ 这项【没验成】（同上）');
  } else {
  const dupText = [];
  const lastByChat = new Map();
  for (const r of ledgerRows) {
    const prev = lastByChat.get(r.chatId);
    if (prev !== undefined && prev.sha === r.sha && r.at - prev.at < DUP_TEXT_WINDOW_MS) {
      dupText.push({ chatId: r.chatId, sha: r.sha, gapMs: r.at - prev.at, at: r.at, chars: r.chars });
    }
    lastByChat.set(r.chatId, r);
  }
  if (dupText.length > 0) {
    const d0 = dupText[dupText.length - 1];
    check('FAIL', 'duplicate-send',
      `发现 ${dupText.length} 处【紧接着发送完全相同的正文】⇒ 重复发送（可能群里看得到两遍）`,
      `最近一处：${d0.chatId} sha=${d0.sha} 间隔=${d0.gapMs}ms chars=${d0.chars} at=${fmt(d0.at)}`);
  } else {
    check('PASS', 'duplicate-send', '没有"紧接着同文重复发送"');
  }

  // ③ 同会话两条发言挨得过近（比配置里最短的合法间隔还短）
  const tooClose = [];
  const lastAtByChat = new Map();
  for (const r of ledgerRows) {
    const prev = lastAtByChat.get(r.chatId);
    if (prev !== undefined && r.at - prev < TOO_CLOSE_MS) {
      tooClose.push({ chatId: r.chatId, gapMs: r.at - prev, at: r.at });
    }
    lastAtByChat.set(r.chatId, r.at);
  }
  if (tooClose.length > 0) {
    const t0 = tooClose[tooClose.length - 1];
    check('FAIL', 'send-too-close',
      `发现 ${tooClose.length} 处【同一会话两条发言间隔 < ${TOO_CLOSE_MS}ms】⇒ 任何配置下都不该发生（突发全放行就是它）`,
      `最近一处：${t0.chatId} 间隔=${t0.gapMs}ms at=${fmt(t0.at)}`);
  } else {
    check('PASS', 'send-too-close', `同会话两条发言都 >= ${TOO_CLOSE_MS}ms（没有异常突发）`);
  }
  } // ← else 块（窗口内有发送记录）到此结束；空窗口那两支在上面报 WARN
}

// ---------------------------------------------------------------- 检查 ⑤：journal 里的 denied/skip 分布（只是信息）

if (snapshot !== null) {
  const jr = snapshot.proactive?.journal ?? [];
  const byReason = new Map();
  for (const e of jr) {
    if (e.event !== 'skip') continue;
    byReason.set(e.reason ?? '?', (byReason.get(e.reason ?? '?') ?? 0) + 1);
  }
  note(`journal 共 ${jr.length} 条；skip 原因分布：` +
    ([...byReason.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || '(无)'));
  const speaks = jr.filter((e) => e.event === 'gauge' && e.speak === true).length;
  note(`journal 里 gauge 说"要说"的：${speaks} 条`);
}

// ---------------------------------------------------------------- 汇总

const failed = results.filter((r) => r.level === 'FAIL');
const warned = results.filter((r) => r.level === 'WARN');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const outIdx = argv.indexOf('--out');
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;

if (asJson) {
  process.stdout.write(JSON.stringify({
    ok: failed.length === 0,
    failed: failed.length,
    warned: warned.length,
    checks: results,
    info,
  }, null, 2) + '\n');
} else {
  // ⚠️ 控制台只打 ASCII：Windows 控制台是 GBK，中文/emoji 会炸或乱码（AGENTS.md）。
  const lines = [];
  lines.push('=== qq-health ===');
  lines.push(`  now        ${new Date(now).toISOString()}`);
  for (const r of results) {
    const mark = r.level === 'PASS' ? '[ OK ]' : r.level === 'WARN' ? '[WARN]' : '[FAIL]';
    lines.push(`  ${mark} ${r.id}`);
  }
  lines.push(`  => ${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'}` +
    (warned.length ? `, ${warned.length} warning(s)` : ''));
  lines.push('  (run with --out <file> for the full Chinese report)');
  process.stdout.write(lines.join('\n') + '\n');
}

if (outFile) {
  const L = [];
  L.push('# 小鲸鱼体检报告');
  L.push('');
  L.push(`跑的时间：${fmt(now)}`);
  L.push(`dsh-home：${HOME}`);
  L.push(`工作区：${WORKSPACE}`);
  L.push('');
  L.push(`## 结论：${failed.length === 0 ? '✅ 全过' : `❌ ${failed.length} 项没过`}` +
    (warned.length ? `（另有 ${warned.length} 项提示）` : ''));
  L.push('');
  L.push('## 逐项');
  L.push('');
  for (const r of results) {
    const mark = r.level === 'PASS' ? '✅' : r.level === 'WARN' ? '⚠️' : '🔴';
    L.push(`### ${mark} ${r.id}`);
    L.push('');
    L.push(r.zh);
    if (r.detail) L.push('');
    if (r.detail) L.push('```');
    if (r.detail) L.push(r.detail);
    if (r.detail) L.push('```');
    L.push('');
  }
  L.push('## 背景信息（不是结论，是给你判断用的）');
  L.push('');
  L.push('```');
  for (const s of info) L.push(s);
  L.push('```');
  L.push('');
  L.push('## 这个脚本的边界（别拿它当"一切正常"的证明）');
  L.push('');
  L.push('- 它**只看结构性的、能从文件读出来的东西**。语义是否正确、措辞是否得体，它判不了。');
  L.push('- `system/message` 是**变更史**不是每轮记录 ⇒ "最新一条有人格"只说明最近那次变更是对的。');
  L.push('- 台账只回看最近 ' + LEDGER_TAIL_LINES + ' 行 gw-send ⇒ 更早的重复发送它看不见。');
  L.push('- 它**不会主动告诉你**，要你主动跑（这是刻意的：用户明确不想为它烧 token）。');
  fs.writeFileSync(outFile, L.join('\n'), 'utf8');
  process.stdout.write(`  report written: ${outFile}\n`);
}

process.exit(failed.length === 0 ? 0 : 1);
