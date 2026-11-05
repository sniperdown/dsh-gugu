/**
 * 调试快照的测试。
 *
 * 这个模块存在的理由：本插件主动层**不建 DSH 会话、也不回复**，状态只在内存里，
 * 从磁盘无法判断它有没有收到消息。所以把关键计数节流落盘，agent 才能自证。
 *
 * 因此测试重点在**约束**上：节流、原子写、绝不抛异常、只落摘要不落正文。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDebugWriter, buildSnapshot, defaultDebugPath, detectStaleCode } from '../src/dsh/debug-snapshot.mjs';

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqdbg-'));
  return path.join(dir, name);
}

// ---------------------------------------------------------------- 写入器

test('createDebugWriter：filePath 为空时什么都不做', () => {
  const w = createDebugWriter({ filePath: '' });
  assert.equal(w.write({ a: 1 }, true), false);
});

test('createDebugWriter：能写出可解析的 JSON', () => {
  const f = tmpFile('snap.json');
  const w = createDebugWriter({ filePath: f, minIntervalMs: 0 });
  assert.equal(w.write({ a: 1 }, true), true);
  const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(parsed.a, 1);
  assert.equal(typeof parsed.writtenAt, 'string', '应带写入时刻');
});

test('createDebugWriter：节流生效，force 可绕过', () => {
  const f = tmpFile('snap.json');
  let t = 1000;
  const w = createDebugWriter({ filePath: f, minIntervalMs: 10000, now: () => t });

  assert.equal(w.write({ n: 1 }), true, '首次应写');
  t += 100;
  assert.equal(w.write({ n: 2 }), false, '间隔不足应跳过');
  t += 20000;
  assert.equal(w.write({ n: 3 }), true, '间隔够了应写');
  assert.equal(w.write({ n: 4 }, true), true, 'force 应无视节流');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).n, 4);
});

test('createDebugWriter：父目录不存在时自动创建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqdbg-'));
  const f = path.join(dir, 'nested', 'deep', 'snap.json');
  const w = createDebugWriter({ filePath: f, minIntervalMs: 0 });
  assert.equal(w.write({ ok: true }, true), true);
  assert.ok(fs.existsSync(f));
});

test('createDebugWriter：写失败不抛异常，走 onError', () => {
  // 用目录当文件路径，必定写失败
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqdbg-'));
  const errors = [];
  const w = createDebugWriter({ filePath: dir, minIntervalMs: 0, onError: (e) => errors.push(e) });
  assert.doesNotThrow(() => w.write({ a: 1 }, true));
  assert.equal(errors.length, 1, '应把错误交给 onError');
});

test('createDebugWriter：写入后不留 .tmp 残骸（原子写）', () => {
  const f = tmpFile('snap.json');
  const w = createDebugWriter({ filePath: f, minIntervalMs: 0 });
  w.write({ a: 1 }, true);
  assert.equal(fs.existsSync(`${f}.tmp`), false, '临时文件应已改名');
});

// ---------------------------------------------------------------- 默认路径

test('defaultDebugPath：有 DSH_HOME 时落在 media 下', () => {
  const home = path.join(os.tmpdir(), 'fake-dsh-home');
  const p = defaultDebugPath({ DSH_HOME: home });
  assert.equal(p, path.join(home, 'media', 'qq-proactive-debug.json'));
  assert.match(p, /media/);
  assert.match(p, /qq-proactive-debug\.json$/);
});

test('defaultDebugPath：没有 DSH_HOME 时给空串（等于禁用）', () => {
  assert.equal(defaultDebugPath({}), '');
});

// ---------------------------------------------------------------- 快照内容

test('buildSnapshot：把关键计数与转录规模带出来', () => {
  const snap = buildSnapshot({
    gateway: { stats: { received: 7, observed: 5, dispatched: 2 } },
    engine: {
      transcripts: new Map([['group:1', {}], ['private:2', {}]]),
      states: new Map([['group:1', { speaks: 1, lastSpeakAt: 99, buffer: 'x'.repeat(500) }]]),
      seenIds: new Set([1, 2, 3, 4]),
    },
    transport: { isReady: true, selfId: '10000003' },
    config: { mode: 'reverse', proactive: { enabled: true } },
  });
  assert.equal(snap.stats.received, 7);
  assert.equal(snap.connected, true);
  assert.equal(snap.selfId, '10000003');
  assert.equal(snap.proactive.transcripts, 2, '转录条数 = 有没有收到消息的证据');
  assert.equal(snap.proactive.seenIds, 4);
  assert.equal(snap.proactive.enabled, true);
});

test('buildSnapshot：状态摘要只保留标量，不落大块正文', () => {
  const snap = buildSnapshot({
    gateway: {},
    engine: {
      transcripts: new Map(),
      states: new Map([['g:1', { speaks: 3, buffer: 'x'.repeat(5000), nested: { deep: 1 } }]]),
      seenIds: new Set(),
    },
    transport: {},
    config: {},
  });
  const state = snap.proactive.states[0][1];
  assert.equal(state.speaks, 3, '标量保留');
  assert.equal(state.buffer, undefined, '长文本不落盘');
  assert.equal(state.nested, undefined, '嵌套对象不落盘');
});

test('buildSnapshot：输入残缺时不炸', () => {
  assert.doesNotThrow(() => buildSnapshot({}));
  assert.doesNotThrow(() => buildSnapshot({ gateway: null, engine: null, transport: null, config: null }));
});

// ------------------------------- 判定器计数（proactive.judge，2026-10-28 加）

test('★ buildSnapshot：判定器计数落在 proactive.judge（与 states 并列，不在 states 里）', () => {
  const stats = {
    enabled: true,
    since: '2026-10-28T07:00:00.000Z',
    sessionCount: 2,
    sessions: [['group:1', { calls: 3, passed: 2, declined: 1, passRate: 0.667, lastMs: 120 }]],
    total: {
      calls: 3,
      passed: 2,
      declined: 1,
      failed: 0,
      failedTimeout: 0,
      failedError: 0,
      failedUnparsed: 0,
      skipped: 0,
      skippedBusy: 0,
      skippedNoModel: 0,
      other: 0,
      passRate: 0.667,
      failRate: 0,
      lastAt: '2026-10-28T07:01:00.000Z',
      lastMs: 120,
      lastSource: 'reply',
      lastChatId: 'group:1',
      lastFailedAt: '',
      lastFailedReason: '',
    },
  };
  const snap = buildSnapshot({
    gateway: { stats: {}, precheck: { stats: () => stats } },
    engine: { judgeMode: 'precheck', states: new Map([['group:1', { gauges: 3 }]]) },
    transport: {},
    config: {},
  });
  assert.equal(snap.proactive.judge.mode, 'precheck', '模式由 engine 补上（计数模块不知道自己的模式）');
  assert.equal(snap.proactive.judge.enabled, true);
  assert.equal(snap.proactive.judge.sessionCount, 2);
  assert.equal(snap.proactive.judge.sessions[0][0], 'group:1');
  assert.equal(snap.proactive.judge.sessions[0][1].calls, 3);
  assert.equal(snap.proactive.judge.total.passed, 2);
  assert.equal(snap.proactive.judge.total.passRate, 0.667);
  // 两段是**并列**的：states 还在它自己的位置上
  assert.equal(snap.proactive.states[0][1].gauges, 3);
});

test('buildSnapshot：没有判定器时 judge 也是固定形状（不是 undefined、不是 null）', () => {
  const snap = buildSnapshot({ gateway: {}, engine: { judgeMode: 'heuristic' }, transport: {}, config: {} });
  assert.equal(snap.proactive.judge.mode, 'heuristic');
  assert.equal(snap.proactive.judge.enabled, false);
  assert.equal(snap.proactive.judge.sessionCount, 0);
  assert.deepEqual(snap.proactive.judge.sessions, []);
  // 全零而不是空对象：读的人不用先判断"这个字段在不在"
  assert.equal(snap.proactive.judge.total.calls, 0);
  assert.equal(snap.proactive.judge.total.passRate, null);
  assert.equal(snap.proactive.judge.total.lastAt, '');
});

test('buildSnapshot：计数器自己抛异常也**不拖垮快照**（诊断设施不是故障源）', () => {
  const snap = buildSnapshot({
    gateway: { stats: { received: 9 }, precheck: { stats() { throw new Error('counter boom'); } } },
    engine: { judgeMode: 'precheck' },
    transport: {},
    config: {},
  });
  assert.doesNotThrow(() => JSON.stringify(snap));
  assert.equal(snap.proactive.judge.enabled, false);
  assert.deepEqual(snap.proactive.judge.sessions, []);
  assert.equal(snap.stats.received, 9, '快照的其它部分照旧');
});

test('buildSnapshot：计数器里有对象/超长串 ⇒ 只留标量（同 states 的收口口径）', () => {
  const snap = buildSnapshot({
    gateway: {
      stats: {},
      precheck: {
        stats: () => ({
          enabled: true,
          sessionCount: 1,
          sessions: [['group:1', { calls: 1, nested: { deep: 1 }, huge: 'x'.repeat(500) }]],
          total: { calls: 1, nested: { deep: 1 } },
        }),
      },
    },
    engine: { judgeMode: 'precheck' },
    transport: {},
    config: {},
  });
  const row = snap.proactive.judge.sessions[0][1];
  assert.equal(row.calls, 1);
  assert.equal(row.nested, undefined, '嵌套对象不落盘');
  assert.equal(row.huge, undefined, '超长字符串不落盘');
  assert.equal(snap.proactive.judge.total.nested, undefined);
});

// B4（2026-10-25）：语音探针必须**落进快照** —— 宿主 logger 不落盘，
// 日志里查不到就等于"探了但看不到结果"（真机那次就是这么卡住的）。
test('buildSnapshot：没收到过语音 ⇒ recordProbe 是 null（别造一个假摘要）', () => {
  const snap = buildSnapshot({ gateway: { stats: {} }, engine: {}, transport: {}, config: {} });
  assert.equal(snap.recordProbe, null);
  assert.equal(buildSnapshot({}).recordProbe, null);
});

test('★ buildSnapshot：收到语音 ⇒ recordProbe 带出 count / transcribed / 键名摘要', () => {
  const snap = buildSnapshot({
    gateway: {
      stats: {},
      lastRecordProbe: {
        at: '2026-10-25T05:10:00.000Z',
        chatId: 'private:30000001',
        count: 1,
        transcribed: false,
        records: [{ keys: ['type', 'data'], dataKeys: ['file', 'url'], duration: 3 }],
      },
    },
    engine: {},
    transport: {},
    config: {},
  });
  assert.equal(snap.recordProbe.at, '2026-10-25T05:10:00.000Z');
  assert.equal(snap.recordProbe.chatId, 'private:30000001');
  assert.equal(snap.recordProbe.count, 1);
  assert.equal(snap.recordProbe.transcribed, false);
  assert.deepEqual(snap.recordProbe.records[0].dataKeys, ['file', 'url']);
});

test('buildSnapshot：recordProbe 形状不对 ⇒ 归一化，不抛', () => {
  assert.doesNotThrow(() => buildSnapshot({ gateway: { lastRecordProbe: 'nope' } }));
  const snap = buildSnapshot({
    gateway: { stats: {}, lastRecordProbe: { records: 'x', transcribed: 'yes', count: 'many' } },
  });
  assert.deepEqual(snap.recordProbe.records, []);
  assert.equal(snap.recordProbe.transcribed, false, '非 true 一律 false（别把"没验过"当"有转写"）');
  assert.equal(snap.recordProbe.count, 0);
});

test('★ buildSnapshot：sessionMode 默认是 {via:create, reason:null}（老调用方不传也不炸）', () => {
  const snap = buildSnapshot({ gateway: {}, engine: {}, transport: {}, config: {} });
  assert.deepEqual(snap.sessionMode, { via: 'create', reason: null });
});

test('★ buildSnapshot：sessionMode 带出"恢复失败 ⇒ 新建"的原因', () => {
  const snap = buildSnapshot({
    gateway: {}, engine: {}, transport: {}, config: {},
    sessionMode: { via: 'create', reason: '没有可恢复的会话' },
  });
  assert.deepEqual(snap.sessionMode, { via: 'create', reason: '没有可恢复的会话' });
});

test('buildSnapshot：sessionMode 非法值归一成默认，不把快照搞坏', () => {
  const via = buildSnapshot({
    gateway: {}, engine: {}, transport: {}, config: {},
    sessionMode: { via: 'bogus', reason: 42 },
  });
  assert.deepEqual(via.sessionMode, { via: 'create', reason: null });
  const text = buildSnapshot({
    gateway: {}, engine: {}, transport: {}, config: {}, sessionMode: 'resume',
  });
  assert.deepEqual(text.sessionMode, { via: 'create', reason: null });
});

test('buildSnapshot：转录是普通对象时也能取 size', () => {
  const snap = buildSnapshot({
    gateway: {}, engine: { transcripts: { size: 9 }, states: {}, seenIds: { size: 2 } },
    transport: {}, config: {},
  });
  assert.equal(snap.proactive.transcripts, 9);
  assert.equal(snap.proactive.seenIds, 2);
});

// ---------------------------------------------------------------- 判定日记

test('buildSnapshot：把判定日记尾部带出来（"为什么没说"的证据）', () => {
  const journal = Array.from({ length: 20 }, (_, i) => ({
    at: 1000 + i,
    chatId: 'group:1',
    event: i % 2 === 0 ? 'skip' : 'gauge',
    reason: `warming-up(${i}/3)`,
    score: i,
    threshold: 26,
    speak: false,
  }));
  const snap = buildSnapshot({ gateway: {}, engine: { journal }, transport: {}, config: {} });

  assert.equal(snap.proactive.journal.length, 12, '只带尾部 12 条');
  assert.equal(snap.proactive.journal.at(-1).score, 19);
  assert.equal(snap.proactive.journal.at(-1).threshold, 26);
  assert.equal(snap.proactive.journal.at(-1).event, 'gauge');
});

test('buildSnapshot：日记里的长错误串不落盘，原因与分数保留', () => {
  const snap = buildSnapshot({
    gateway: {},
    engine: {
      journal: [
        { at: 1, chatId: 'group:1', event: 'error', phase: 'speak', error: 'E'.repeat(400), score: 30 },
      ],
    },
    transport: {},
    config: {},
  });
  const entry = snap.proactive.journal[0];
  assert.equal(entry.event, 'error');
  assert.equal(entry.phase, 'speak');
  assert.equal(entry.score, 30);
  assert.equal(entry.error, undefined, '超长文本整个丢掉，不截断');
});

test('buildSnapshot：没有日记时也不炸', () => {
  const snap = buildSnapshot({ gateway: {}, engine: {}, transport: {}, config: {} });
  assert.equal(snap.proactive.journal, undefined);
});

// ---------------------------------------------------------------- 代码新鲜度

/** 造一个带文件的临时目录，返回 {dir, file, mtime}。 */
function tmpTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqstale-'));
  const file = path.join(dir, 'a.mjs');
  fs.writeFileSync(file, 'export const a = 1;\n', 'utf8');
  return { dir, file, mtime: fs.statSync(file).mtimeMs };
}

test('detectStaleCode：源码比模块加载时刻新 → stale', () => {
  const { dir, mtime } = tmpTree();
  const r = detectStaleCode({ dir, since: mtime - 5000 });
  assert.equal(r.stale, true, '改完没重启就是这种情形');
  assert.equal(r.newestFile, 'a.mjs');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('detectStaleCode：源码比模块加载时刻旧 → 不 stale', () => {
  const { dir, mtime } = tmpTree();
  const r = detectStaleCode({ dir, since: mtime + 5000 });
  assert.equal(r.stale, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('detectStaleCode：递归子目录，并跳过 node_modules', () => {
  const { dir, file, mtime } = tmpTree();
  const nested = path.join(dir, 'dsh', 'b.mjs');
  fs.mkdirSync(path.join(dir, 'dsh'), { recursive: true });
  fs.writeFileSync(nested, 'x\n', 'utf8');

  // **显式把 mtime 拉开**，不要依赖"写入顺序 == 更新顺序"。
  // 实测这是 flaky 的：两个文件相隔几毫秒写入，Windows 上 mtime 可能落在
  // 同一毫秒，于是"谁最新"变成任意——测试会偶发地报 newestFile 是 a.mjs
  // （4 次里挂 1 次）。时间敏感的比较必须给确定的时间戳。
  const newer = mtime + 2000;
  fs.utimesSync(nested, new Date(newer), new Date(newer));
  fs.utimesSync(file, new Date(mtime), new Date(mtime));

  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'c.mjs'), 'x\n', 'utf8');
  // node_modules 里的文件给一个**更晚**的时间，确保它是被"跳过"而不是"恰好不最新"
  const skipped = path.join(dir, 'node_modules', 'dep', 'c.mjs');
  const newestOverall = newer + 5000;
  fs.utimesSync(skipped, new Date(newestOverall), new Date(newestOverall));

  const r = detectStaleCode({ dir, since: newestOverall + 1000 });
  assert.equal(r.stale, false);
  assert.equal(r.newestFile, 'dsh/b.mjs', '路径用正斜杠，且 node_modules 里的更新文件要被跳过');
  // 注意精度：`detectStaleCode` 用 `toISOString()` 输出（毫秒级），
  // 而 `mtimeMs` 是小数毫秒，直接比会差在小数位上。比较前先取整。
  assert.equal(Date.parse(r.newest), Math.floor(newer), '最新时间应来自 dsh/b.mjs，不是 node_modules');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('detectStaleCode：没传参数、目录不存在都返回 null（不假装正常）', () => {
  assert.equal(detectStaleCode(), null);
  assert.equal(detectStaleCode({ dir: '', since: 1 }), null);
  assert.equal(detectStaleCode({ dir: 'H:\\no\\such\\dir\\qq', since: 1 }), null);
  const { dir, mtime } = tmpTree();
  assert.equal(detectStaleCode({ dir, since: Number.NaN }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildSnapshot：传了 watch 才带 staleCode', () => {
  const { dir, mtime } = tmpTree();
  const without = buildSnapshot({ gateway: {}, engine: {}, transport: {}, config: {} });
  assert.equal(without.staleCode, null, '不传就说"不知道"，不谎报新鲜');

  const with_ = buildSnapshot({
    gateway: {}, engine: {}, transport: {}, config: {},
    watch: { dir, since: mtime - 5000 },
  });
  assert.equal(with_.staleCode.stale, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 表情包库

test('buildSnapshot：没给表情包库 → stickers 是 null（不假装有数据）', () => {
  const snap = buildSnapshot({ gateway: {}, engine: {}, transport: {}, config: {} });
  assert.equal(snap.stickers, null);
});

test('buildSnapshot：给了表情包库 → 带上计数、库容量、使用次数总和与已打标签数', () => {
  const snap = buildSnapshot({
    gateway: {}, engine: {}, transport: {}, config: {},
    stickerLibrary: {
      stats: () => ({
        harvested: 5, stored: 3, dedup: 2, nearMiss: 1, failed: 0,
        rejected: 2, auditFailed: 1,
        unrecognized: 0, tooLarge: 0, skipped: 0, idMatched: 3, idMismatch: 0,
        pending: 0, dir: '<DSH_HOME>\\media\\stickers',
        index: { size: 3, degraded: false, enabled: true },
      }),
      all: () => [
        { uses: 2, tags: ['开心'] },
        { uses: 0, tags: [] },
        { uses: 1, tags: [] },
      ],
    },
  });
  assert.equal(snap.stickers.stored, 3);
  assert.equal(snap.stickers.dedup, 2);
  assert.equal(snap.stickers.nearMiss, 1);
  // 「认」接上之后新增的两个计数：入库前被审核闸挡下的 / 没看成（不可信）而没入库的
  assert.equal(snap.stickers.rejected, 2);
  assert.equal(snap.stickers.auditFailed, 1);
  assert.equal(snap.stickers.idMatched, 3);
  assert.equal(snap.stickers.dir, '<DSH_HOME>\\media\\stickers');
  assert.deepEqual(snap.stickers.index, { size: 3, degraded: false, enabled: true });
  assert.equal(snap.stickers.usesTotal, 3, '使用次数总和 —— 证明"记一次使用"真在写');
  assert.equal(snap.stickers.tagged, 1, '已打标签条数（给"认"用了没有）');
});

test('buildSnapshot：库的 stats() 抛异常 → stickers 是 null，绝不拖垮快照', () => {
  const snap = buildSnapshot({
    gateway: {}, engine: {}, transport: {}, config: {},
    stickerLibrary: { stats: () => { throw new Error('库炸了'); } },
  });
  assert.equal(snap.stickers, null);
  // 其余的字段照常产出 —— 调试设施坏了不能连"能不能看到消息计数"都失去
  assert.equal(typeof snap.now, 'string');
});

// ---------------------------------------------------------------- 空回复的现场要落盘（2026-10-28）

test('buildSnapshot：她说 [不说话] 的计数与最近一次现场也进快照（2026-11-02）', () => {
  const snap = buildSnapshot({
    gateway: {
      stats: { received: 2, replies: 0, quietReplies: 1 },
      lastQuietReply: {
        at: 1793600000000,
        chatId: 'private:30000001',
        sessionKey: 'qq-private-30000001',
        toolSent: true,
        chars: 5,
        images: 0,
      },
    },
    engine: { transcripts: new Map(), states: new Map(), seenIds: new Set() },
    transport: {},
    config: {},
  });
  assert.equal(snap.stats.quietReplies, 1);
  assert.equal(snap.quietReply.toolSent, true, 'true = 标记只是压重复，不是"她不想说"');
  assert.equal(snap.quietReply.chars, 5);
  assert.equal(snap.quietReply.chatId, 'private:30000001');
});

test('buildSnapshot：没回过 [不说话] 时 quietReply 是 null、计数是 0', () => {
  const snap = buildSnapshot({ gateway: { stats: {} }, engine: {}, transport: {}, config: {} });
  assert.equal(snap.quietReply, null);
  assert.equal(snap.stats.quietReplies, 0);
});

test('buildSnapshot：空回复计数与最近一次现场都进快照', () => {
  const snap = buildSnapshot({
    gateway: {
      stats: { received: 1, replies: 0, emptyReplies: 2, lostReplies: 1, compactedTurns: 1 },
      lastEmptyReply: {
        at: 1793191402000,
        chatId: 'private:30000001',
        sessionKey: 'qq-private-30000001',
        kind: 'lost',
        before: 900,
        after: 30,
        historyShrank: true,
        streamFrames: 3,
        streamedChars: 0,
      },
    },
    engine: { transcripts: new Map(), states: new Map(), seenIds: new Set() },
    transport: {},
    config: {},
  });
  assert.equal(snap.stats.emptyReplies, 2);
  assert.equal(snap.stats.lostReplies, 1);
  assert.equal(snap.stats.compactedTurns, 1);
  const e = snap.emptyReply;
  assert.equal(e.chatId, 'private:30000001');
  assert.equal(e.kind, 'lost');
  assert.equal(e.before, 900);
  assert.equal(e.after, 30);
  assert.equal(e.historyShrank, true, '这一格就是"是压缩干的"的判据');
  assert.equal(e.streamFrames, 3);
  assert.equal(e.streamedChars, 0, '来了帧却一个字都没抽到 —— 事故指纹');
});

test('buildSnapshot：没丢过回复时 emptyReply 是 null，计数是 0', () => {
  const snap = buildSnapshot({ gateway: { stats: {} }, engine: {}, transport: {}, config: {} });
  assert.equal(snap.emptyReply, null);
  assert.equal(snap.stats.emptyReplies, 0);
  assert.equal(snap.stats.lostReplies, 0);
  assert.equal(snap.stats.compactedTurns, 0);
});

test('buildSnapshot：lastEmptyReply 形状残缺时归一化，不炸', () => {
  const snap = buildSnapshot({
    gateway: { stats: {}, lastEmptyReply: { kind: 42, before: 'x', historyShrank: 'yes', streamFrames: null } },
    engine: {},
    transport: {},
    config: {},
  });
  assert.equal(snap.emptyReply.kind, '');
  assert.equal(snap.emptyReply.before, 0);
  assert.equal(snap.emptyReply.historyShrank, false);
  assert.equal(snap.emptyReply.streamFrames, 0);
});
