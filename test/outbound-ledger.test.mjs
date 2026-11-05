/**
 * 出站台账测试（`src/dsh/outbound-ledger.mjs` + `gateway.mjs` 的接线）。
 *
 * ## 为什么必须存在
 *
 * 这个台账的**全部价值是"能分辨重复发生在哪一层"**，而它的坏法全都**不报错**：
 *
 * - 把 `gw-send` 记成两行（"决定要发" + "发成功"各一行）
 *   ⇒ **一次发送看起来就像发了两遍** —— 正好把判读表毁掉（最坏，且最像修好了）；
 * - 台账里记了**消息原文** ⇒ 隐私事故，而且没人会注意到（文件在 `<DSH_HOME>`）；
 * - 写盘失败往上抛 ⇒ 把发送本身弄坏（`sticker-audit` 那次血泪教训的同一条）；
 * - 没有上限 ⇒ 文件无声长大到几百 MB；
 * - 同时挂 `sendToChat` 与 `action('send_msg')` ⇒ 一次发送记两行（同第一条第 2 种）；
 * - 挂钩失败却把网关一起弄挂 ⇒ 少一层证据变成"什么都跑不起来"。
 *
 * 这里逐条钉住。
 *
 * ⚠️ 临时目录用**工作区内**的路径（`test/.tmp-outbound-*`），不用 `os.tmpdir()` ——
 * 本机沙箱挡着 `%TEMP%`，用它会 EPERM 假红。
 * ⚠️ **绝不往真的 `<DSH_HOME>` 写**：台账路径一律注入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import {
  CALLER_UNKNOWN,
  DEFAULT_OUTBOUND_LEDGER,
  DEFAULT_OUTBOUND_LEDGER_DIR,
  DEFAULT_OUTBOUND_LEDGER_PATH,
  LAYER_GW_SEND,
  LAYER_TRANSPORT_ACTION,
  createOutboundLedger,
  defaultOutboundLedgerPath,
  describeOutboundVerdicts,
  ledgerHash,
  normalizeOutboundLedger,
} from '../src/dsh/outbound-ledger.mjs';
import { dshHome } from '../src/dsh/paths.mjs';
import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 建一个测试目录（工作区内，避免沙箱挡 %TEMP%）。 */
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(HERE, `.tmp-outbound-${tag}-`));
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith('.tmp-outbound-')) fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
    }
  } catch { /* 收尾失败不影响结果 */ }
});

/** 造一个写进临时目录的台账（**永不碰真 `<DSH_HOME>`**）。 */
function makeLedger(tag = 'x', overrides = {}) {
  const dir = tmpDir(tag);
  const file = path.join(dir, 'qq-outbound.jsonl');
  const ledger = createOutboundLedger({
    config: { file, enabled: true, maxLines: 5000, ...overrides },
    log: () => {},
  });
  return { ledger, file, dir };
}

/** 读回文件里的每一行（解析成对象）。 */
function lines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

// ══════════════════════════════════════════════ 默认值与路径

// ══════════════════════════════════════════════ 🔴 默认值绝不能把功能关掉

test('🔴 `DEFAULT_OUTBOUND_LEDGER` **不含 `file`** —— `file` 没有默认值，它是推出来的', () => {
  // ⚠️ 这条断言是**这次真踩到的 bug** 的直接回归：
  //
  //   第一版常量里有 `file: ''` ⇒ `createOutboundLedger()`（不带配置）
  //   走 `config ?? DEFAULT_OUTBOUND_LEDGER` ⇒ `file` **已定义且是空串**
  //   ⇒ 不推路径 ⇒ `enabled = true && file !== ''` ⇒ **false**
  //   ⇒ **功能装上了、挂钩挂上了、一行都不记**，而快照上
  //   `{enabled:false, hooked:true, wrote:0, file:''}` 看起来只是"还没发过消息"。
  //
  //   **这正是本模块开头警告过的形状**（"空串 ⇒ 功能装上了但一行都不记"）。
  //   警告写了，默认值却没跟上 —— 所以这里钉死：**常量里不许出现 `file`。**
  assert.equal(
    Object.prototype.hasOwnProperty.call(DEFAULT_OUTBOUND_LEDGER, 'file'),
    false,
    '`file` 不在默认值里：放了它就等于把功能默认关掉',
  );
  assert.equal(DEFAULT_OUTBOUND_LEDGER.enabled, true);
  assert.equal(DEFAULT_OUTBOUND_LEDGER.maxLines, 5000);
  assert.equal(DEFAULT_OUTBOUND_LEDGER.failsBeforeDisable, 5);
});

test('🔴 `createOutboundLedger()` **不带参数** ⇒ 开着、且路径非空（这条早写就该拦住那个 bug）', () => {
  const ledger = createOutboundLedger({ log: () => {} });
  const s = ledger.stats();
  // ⚠️ 这条**不能**断言 `s.file === DEFAULT_OUTBOUND_LEDGER_PATH`：那是本机推出来的
  //    真路径（`<DSH_HOME>\media\…`），断言它等于在测试里依赖环境。
  //    要断的是**形状与状态**："非空 + 真的开着"。
  assert.equal(s.enabled, true, '不带配置必须是开着的 —— 默认关掉就是那个静默 bug');
  assert.equal(ledger.enabled(), true);
  assert.notEqual(s.file, '', '路径必须非空，否则每一行都写不进去');
  assert.match(s.file, /qq-outbound\.jsonl$/, '默认文件名');
  assert.equal(s.hooked, false, '还没挂钩（构造器不挂钩）');
  assert.equal(s.maxLines, 5000);
  // 没配 `fsImpl` ⇒ 用的是真 fs。**绝不能让这一跑写进真的 `<DSH_HOME>`**，
  // 所以真正的"放空配置也能写"由下一条显式验（那里 `file` 缺省但 fs 是假的）。
});

test('🔴 缺 `file` ⇒ 推成默认路径（不是空串），且**真的写得进去**', () => {
  // ⚠️ 这里**故意不传 `file`**（模拟"调用方只关心别的字段"），
  //    但把 `fsImpl` 指到假 fs —— 这样既能断言"路径被推出来了"，
  //    又绝不会真的往 `<DSH_HOME>` 写。
  const written = [];
  const ledger = createOutboundLedger({
    config: { enabled: true, maxLines: 100 },
    fsImpl: {
      mkdirSync() {},
      appendFileSync(p, data) { written.push({ p, data }); },
      readFileSync() { return ''; },
      writeFileSync() {},
      renameSync() {},
    },
    log: () => {},
  });
  const s = ledger.stats();
  assert.equal(s.file, DEFAULT_OUTBOUND_LEDGER_PATH, '缺 file ⇒ 推成默认路径（不是空串）');
  assert.notEqual(s.file, '');
  assert.equal(s.enabled, true);
  assert.equal(ledger.enabled(), true);
  // 真正的写入判据：一行真的落到了那个被推出来的路径上。
  assert.equal(ledger.record({ layer: LAYER_GW_SEND, caller: 'c', chatId: 'p:1', chars: 1, sha256: 'h', ok: true }), true);
  assert.equal(written.length, 1, '缺 file 时也必须写得进去');
  assert.equal(written[0].p, DEFAULT_OUTBOUND_LEDGER_PATH, '写到的正是推出来的那个路径');
  assert.equal(ledger.stats().wrote, 1);
});

test('🔴 `createOutboundLedger({})` 也开着（**空对象 ≠ 空串**）', () => {
  const ledger = createOutboundLedger({ config: {}, log: () => {} });
  assert.equal(ledger.enabled(), true);
  assert.notEqual(ledger.stats().file, '');
  // 对照：显式给空串才是"明确关掉" —— 这是**有意**的另一回事，两者必须分开。
  const off = createOutboundLedger({ config: { file: '' }, log: () => {} });
  assert.equal(off.enabled(), false);
});

test('默认值：路径由 DSH_HOME 推出来，推不出来退到本部署写死路径', () => {
  assert.equal(defaultOutboundLedgerPath({ DSH_HOME: '<DSH_HOME>' }), path.join('<DSH_HOME>', 'media', 'qq-outbound.jsonl'));
  // ⚠️ 没有 DSH_HOME 时**不能返回空串**：空串 ⇒ `enabled:false` ⇒
  //    "功能装上了但一行都不记"，而那种状态下所有计数看起来都正常。
  //    退到本部署的写死路径（与 `sticker-library.mjs` 同一条规矩）。
  assert.equal(defaultOutboundLedgerPath({}), path.join(DEFAULT_OUTBOUND_LEDGER_DIR, 'qq-outbound.jsonl'));
  assert.match(defaultOutboundLedgerPath({}), /qq-outbound\.jsonl$/);
  assert.equal(defaultOutboundLedgerPath({}).startsWith(path.join(dshHome(), 'media')), true);
  // 解析出来的那个常量是**模块加载时定一次**的（`index.mjs` 的配置默认值用它 ——
  // 免得调用方各自推一遍，推成两份）。
  assert.match(DEFAULT_OUTBOUND_LEDGER_PATH, /qq-outbound\.jsonl$/);
  assert.notEqual(DEFAULT_OUTBOUND_LEDGER_PATH, '');
  // 缺字段（没传 file）⇒ 推路径 ⇒ 开着
  assert.equal(normalizeOutboundLedger({}).enabled, true);
  assert.equal(normalizeOutboundLedger({}).file, DEFAULT_OUTBOUND_LEDGER_PATH);
  assert.equal(normalizeOutboundLedger({ file: 'x.jsonl' }).enabled, true);
});

test('配置：空串 = 明确关掉（与"缺字段走默认"分得开）', () => {
  assert.equal(normalizeOutboundLedger({ file: '' }).file, '');
  // ⚠️ 路径为空 ⇒ enabled 必须**自己变成 false**，哪怕配置写了 true。
  //    否则 `createOutboundLedger` 会以为"开着"，而每一行都写不进去。
  assert.equal(normalizeOutboundLedger({ file: '', enabled: true }).enabled, false);
  assert.equal(normalizeOutboundLedger({ file: 'x.jsonl', enabled: true }).enabled, true);
  const l = createOutboundLedger({ config: { file: '', enabled: true }, log: () => {} });
  assert.equal(l.enabled(), false, 'file 为空 ⇒ 不写任何东西');
  assert.equal(l.record({ layer: LAYER_GW_SEND, chars: 1 }), false);
});

test('配置：越界一律夹到边界，不抛', () => {
  assert.equal(normalizeOutboundLedger({ maxLines: -5 }).maxLines, 0);
  assert.equal(normalizeOutboundLedger({ maxLines: 9e9 }).maxLines, 200_000);
  assert.equal(normalizeOutboundLedger({ maxLines: 'abc' }).maxLines, DEFAULT_OUTBOUND_LEDGER.maxLines);
  assert.equal(normalizeOutboundLedger({ failsBeforeDisable: -1 }).failsBeforeDisable, 0);
  assert.equal(normalizeOutboundLedger(null).enabled, true);
});

// ══════════════════════════════════════════════ 哈希

test('哈希：sha256 前 16 位；空文本也有哈希（不是空串）', () => {
  assert.equal(ledgerHash('abc'), 'ba7816bf8f01cfea');
  assert.equal(ledgerHash('abc').length, 16);
  // 空串的哈希必须**存在**：留空字段分不清"没算"和"算出来是空"。
  assert.equal(ledgerHash(''), 'e3b0c44298fc1c14');
  assert.equal(ledgerHash(null), ledgerHash(''));
  assert.equal(ledgerHash(undefined), ledgerHash(''));
  assert.equal(ledgerHash(42), ledgerHash('42'), '非字符串按 String() 处理');
  // 不同文本不同哈希（判据成立的前提）
  assert.notEqual(ledgerHash('在的'), ledgerHash('在的 '));
});

// ══════════════════════════════════════════════ 一行一条

test('★ 一行一条：`record()` 每次只追加一行，字段齐全', () => {
  const { ledger, file } = makeLedger('one');
  assert.equal(ledger.record({
    layer: LAYER_GW_SEND,
    caller: 'runTurn',
    chatId: 'private:30000001',
    chars: 627,
    sha256: ledgerHash('x'),
    ok: true,
    messageId: '701703571',
    meta: { images: 0 },
  }), true);
  const rows = lines(file);
  assert.equal(rows.length, 1, '一次 record 只能落一行');
  const r = rows[0];
  assert.equal(r.layer, 'gw-send');
  assert.equal(r.caller, 'runTurn');
  assert.equal(r.chatId, 'private:30000001');
  assert.equal(r.chars, 627);
  assert.equal(r.sha256, ledgerHash('x'));
  assert.equal(r.ok, true);
  assert.equal(r.messageId, '701703571');
  assert.deepEqual(r.meta, { images: 0 });
  // `at` 必须是 ISO 串（判"同一秒"全靠它）
  assert.match(r.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(!Number.isNaN(Date.parse(r.at)));
});

test('`at`：调用方给的为准（**"决定要发"那一刻**必须由调用方给）', () => {
  const dir = tmpDir('at');
  const file = path.join(dir, 'qq-outbound.jsonl');
  // 注入的时钟故意跟传入的 `at` 差很远：能一眼看出用的是哪一个。
  const ledger = createOutboundLedger({
    config: { file, enabled: true, maxLines: 100 },
    log: () => {},
    now: () => Date.parse('2000-01-01T00:00:00.000Z'),
  });
  const explicit = '2026-10-09T08:01:48.000Z';
  ledger.record({ layer: LAYER_GW_SEND, caller: 'c', chatId: 'p:1', chars: 1, sha256: 'h', ok: true, at: explicit });
  ledger.record({ layer: LAYER_TRANSPORT_ACTION, caller: 'c', chatId: 'p:1', chars: 1, sha256: 'h', ok: true });
  const rows = lines(file);
  // ⚠️ 这条是**判据的前提**：`gw-send` 那一层若用了 `await` 回来的时刻，
  //    两条本来同秒的记录会被推散成不同秒，而"同一秒两条"正是我们要找的形状。
  assert.equal(rows[0].at, explicit, '传了 at 就必须用它');
  assert.equal(rows[1].at, '2000-01-01T00:00:00.000Z', '没传 at 才用注入的 now()');
  assert.notEqual(rows[0].at, rows[1].at);
});

test('拿不到 `echo`/`messageId` 时**不记空串**（分得清"没有"和"是空的"）', () => {
  const { ledger, file } = makeLedger('absent');
  ledger.record({ layer: LAYER_TRANSPORT_ACTION, caller: 'c', chatId: 'private:1', chars: 3, sha256: ledgerHash('abc'), ok: true });
  const r = lines(file)[0];
  assert.ok(!('messageId' in r), '拿不到就不该有 messageId 字段');
  assert.ok(!('echo' in r));
  // 显式传空串同样不该记
  ledger.record({ layer: LAYER_TRANSPORT_ACTION, caller: 'c', chatId: 'private:1', chars: 3, sha256: 'h', ok: true, messageId: '', echo: '' });
  assert.ok(!('messageId' in lines(file)[1]));
});

test('★ 隐私：**只记长度 + 哈希，绝不记正文**（含换行也不行）', () => {
  const { ledger, file } = makeLedger('privacy');
  const secret = '第一行\n第二行 这是不该落盘的内容 30000002';
  ledger.record({
    layer: LAYER_GW_SEND,
    caller: 'runTurn',
    chatId: 'private:1',
    chars: secret.length,
    sha256: ledgerHash(secret),
    ok: true,
  });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('第一行'), '正文一个字都不该出现在台账里');
  assert.ok(!raw.includes('不该落盘'), '正文一个字都不该出现在台账里');
  assert.equal(raw.split('\n').filter((l) => l.trim() !== '').length, 1, '正文里的换行不许把一行撑成两行');
  const r = lines(file)[0];
  assert.equal(r.chars, secret.length);
  assert.equal(r.sha256, ledgerHash(secret));
  // `meta` 也不许变成搬运正文的通道：长字符串丢掉、非标量丢掉。
  ledger.record({
    layer: LAYER_GW_SEND, caller: 'c', chatId: 'p:1', chars: 1, sha256: 'h', ok: true,
    meta: { long: 'x'.repeat(200), nested: { a: 1 }, arr: [1], num: 2, bool: false },
  });
  const m = lines(file)[1].meta;
  assert.ok(!('long' in m), '超长字符串必须整个丢掉（不是截断）');
  assert.ok(!('nested' in m) && !('arr' in m), 'meta 只留标量');
  assert.equal(m.num, 2);
  assert.equal(m.bool, false);
});

test('非有限 `chars` 落成 0，不落 NaN/null（台账要能被解析）', () => {
  const { ledger, file } = makeLedger('chars');
  ledger.record({ layer: LAYER_GW_SEND, caller: 'c', chatId: 'p:1', chars: 'abc', sha256: 'h', ok: true });
  ledger.record({ layer: LAYER_GW_SEND, caller: 'c', chatId: 'p:1', chars: -9, sha256: 'h', ok: true });
  ledger.record({ layer: LAYER_GW_SEND, caller: 'c', chatId: 'p:1', sha256: 'h', ok: true });
  const rows = lines(file);
  assert.deepEqual(rows.map((r) => r.chars), [0, 0, 0]);
  assert.equal(rows[0].caller, 'c');
  assert.equal(rows[0].layer, 'gw-send');
});

test('`caller` 缺省时落 `unknown`（不落空串：空串分不清"没传"和"传了空"）', () => {
  const { ledger, file } = makeLedger('caller');
  ledger.record({ layer: LAYER_GW_SEND, chatId: 'p:1', chars: 1, sha256: 'h', ok: true });
  assert.equal(lines(file)[0].caller, CALLER_UNKNOWN);
});

// ══════════════════════════════════════════════ 上限 / 裁剪

test('★ 上限：超过 `maxLines × 1.5` 才裁一次，裁完只留尾部', () => {
  const { ledger, file } = makeLedger('trim', { maxLines: 10 });
  // 写 20 行：10 行是目标，15 行（1.5×）才裁 ⇒ 到第 16 行才裁一次。
  for (let i = 0; i < 20; i += 1) {
    ledger.record({ layer: LAYER_GW_SEND, caller: `c${i}`, chatId: 'p:1', chars: i, sha256: `h${i}`, ok: true });
  }
  const rows = lines(file);
  assert.ok(rows.length <= 15, `行数不许超过 trimAt=15，实际 ${rows.length}`);
  assert.ok(rows.length >= 10, '裁完至少留着 maxLines 行');
  assert.equal(rows[rows.length - 1].caller, 'c19', '最新的那条必须在');
  assert.equal(rows[0].caller, `c${20 - rows.length}`, '留下的是**尾部**（最旧的先走）');
  assert.ok(ledger.stats().trims >= 1, '裁过就要记账');
});

test('上限：`maxLines: 0` = 不裁也不写（上限关掉时台账照写，只是不裁）', () => {
  const { ledger, file } = makeLedger('nolimit', { maxLines: 0 });
  for (let i = 0; i < 30; i += 1) {
    ledger.record({ layer: LAYER_GW_SEND, caller: `c${i}`, chatId: 'p:1', chars: i, sha256: 'h', ok: true });
  }
  assert.equal(lines(file).length, 30, 'maxLines=0 时不裁（全留着）');
  assert.equal(ledger.stats().trims, 0);
});

test('上限：进程重启后行数认知归零也**不会漏裁**（安全阀会真去数一遍）', () => {
  const { file, dir } = makeLedger('recheck', { maxLines: 10 });
  // 先用手写文件模拟"上一个进程留下的 40 行"（新 ledger 对它一无所知）。
  fs.writeFileSync(file, `${Array.from({ length: 40 }, (_, i) => JSON.stringify({ at: 'x', layer: 'gw-send', caller: `old${i}`, chatId: 'p:1', chars: 0, sha256: 'h', ok: true })).join('\n')}\n`, 'utf8');
  const fresh = createOutboundLedger({ config: { file: path.join(dir, 'qq-outbound.jsonl'), enabled: true, maxLines: 10 }, log: () => {} });
  // 写 500 次会触发一次 recount（`LINECOUNT_RECHECK_EVERY`）⇒ 随后就该裁掉。
  for (let i = 0; i < 500; i += 1) {
    fresh.record({ layer: LAYER_GW_SEND, caller: `new${i}`, chatId: 'p:1', chars: 1, sha256: 'h', ok: true });
  }
  const rows = lines(file);
  assert.ok(rows.length <= 15, `安全阀必须把文件压回上限内，实际 ${rows.length}`);
  assert.equal(rows[rows.length - 1].caller, 'new499');
});

// ══════════════════════════════════════════════ 写盘失败绝不能影响发送

test('★ 写盘失败：不抛、记 failed、连续失败到阈值就本次进程内断开', () => {
  const boom = {
    mkdirSync() { throw new Error('EPERM: mkdir'); },
    appendFileSync() { throw new Error('EPERM: append'); },
    readFileSync() { throw new Error('EPERM: read'); },
    writeFileSync() { throw new Error('EPERM: write'); },
    renameSync() { throw new Error('EPERM: rename'); },
  };
  const logs = [];
  const ledger = createOutboundLedger({
    config: { file: 'H:\\does-not-matter\\x.jsonl', enabled: true, maxLines: 100, failsBeforeDisable: 3 },
    fsImpl: boom,
    log: (level, msg, meta) => logs.push({ level, msg, meta }),
  });
  // ⚠️ 关键：**不许抛**。留样那次就是抛了异常把整张图变成"没看成"。
  for (let i = 0; i < 5; i += 1) {
    assert.doesNotThrow(() => ledger.record({ layer: LAYER_GW_SEND, caller: 'c', chatId: 'p:1', chars: 1, sha256: 'h', ok: true }));
  }
  const s = ledger.stats();
  assert.equal(s.failed, 3, '断开之后不再重复去撞系统调用');
  assert.equal(s.disabled, true);
  assert.equal(s.wrote, 0);
  assert.equal(ledger.enabled(), false);
  assert.ok(logs.some((l) => l.level === 'warn' && l.msg.includes('写盘失败')), '失败至少要留一行 log');
  assert.ok(logs.some((l) => l.msg.includes('本次进程内已断开')));
  // 断开之后 `record` 直接返回 false（不再碰 fs）
  assert.equal(ledger.record({ layer: LAYER_GW_SEND, caller: 'c', chatId: 'p:1', chars: 1, sha256: 'h', ok: true }), false);
});

test('`read()` 坏了返回空数组，不抛', () => {
  const ledger = createOutboundLedger({
    config: { file: 'H:\\nope\\x.jsonl', enabled: true },
    fsImpl: { readFileSync() { throw new Error('EPERM'); } },
    log: () => {},
  });
  assert.deepEqual(ledger.read(), []);
});

test('没注入 fs 时用真的 fs，但路径是注入的 ⇒ 只写临时目录', () => {
  const { ledger, file } = makeLedger('realfs');
  assert.equal(ledger.record({ layer: LAYER_GW_SEND, caller: 'c', chatId: 'p:1', chars: 2, sha256: ledgerHash('ab'), ok: true }), true);
  assert.ok(fs.existsSync(file));
  assert.equal(lines(file).length, 1);
  assert.ok(file.startsWith(HERE), '无论如何不许写到测试目录之外');
});

// ══════════════════════════════════════════════ 挂钩 transport

/** 假 transport：`sendToChat` 记录被调了几次，`action` 供"有没有被重复记"的对照。 */
function makeTransport({ fail = false } = {}) {
  const emitter = new EventEmitter();
  const calls = { sendToChat: 0, action: 0 };
  return {
    selfId: '999',
    calls,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async action(action, params) {
      calls.action += 1;
      return { message_id: 42 };
    },
    async sendToChat(chatId, message) {
      calls.sendToChat += 1;
      // 真实的 `sendToChat` 就是**再调一次 action('send_msg')** ——
      // 这里照样模拟，才能钉住"只挂外层、一次发送只记一行"。
      await this.action('send_msg', { message });
      if (fail) throw new Error('send_msg 超时');
      return 'mid-1';
    },
  };
}

test('★ 挂钩：一次 `sendToChat` 只在 `transport-action` 落**一行**（挂外层，不重复挂 action）', async () => {
  const { ledger, file } = makeLedger('hook');
  const transport = makeTransport();
  ledger.instrument(transport);
  await transport.sendToChat('private:30000001', '在的，你说');
  const rows = lines(file);
  assert.equal(rows.length, 1, '一次发送只能记一行 —— 同时挂 sendToChat 与 action 就会记两行，等于假重复');
  assert.equal(rows[0].layer, 'transport-action');
  assert.equal(rows[0].action, 'send_msg');
  assert.equal(rows[0].chatId, 'private:30000001');
  assert.equal(rows[0].chars, 5);
  assert.equal(rows[0].sha256, ledgerHash('在的，你说'));
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].caller, 'sendToChat:send_msg');
  assert.equal(rows[0].messageId, 'mid-1', 'NapCat 回的 message_id 记在这一层');
  assert.equal(transport.calls.action, 1, '原方法照常被执行一次');
});

test('★ 挂钩：发送抛异常 ⇒ 记 `ok:false`，但**原异常原样抛回去**', async () => {
  const { ledger, file } = makeLedger('hookfail');
  const transport = makeTransport({ fail: true });
  ledger.instrument(transport);
  await assert.rejects(() => transport.sendToChat('private:1', 'abc'), /send_msg 超时/);
  const rows = lines(file);
  assert.equal(rows.length, 1, '失败也是一行（不是两行）');
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].chars, 3);
  assert.equal(rows[0].meta.error, 'send_msg 超时');
  // 原样抛回去：调用方看到的错误类型/消息都没变
  await assert.rejects(() => transport.sendToChat('private:1', 'abc'), (e) => e instanceof Error && e.message === 'send_msg 超时');
});

test('★ 挂钩幂等：重复 instrument 只包一层（否则一次发送会记两行）', async () => {
  const { ledger, file } = makeLedger('idem');
  const transport = makeTransport();
  ledger.instrument(transport);
  ledger.instrument(transport);
  ledger.instrument(transport);
  await transport.sendToChat('private:1', 'abc');
  assert.equal(lines(file).length, 1, '挂三次也只能记一行');
  assert.equal(transport.calls.sendToChat, 1, '原方法还是只被调一次');
});

test('`uninstall()` 把原方法装回去（之后不再记）', async () => {
  const { ledger, file } = makeLedger('uninstall');
  const transport = makeTransport();
  const original = transport.sendToChat;
  ledger.instrument(transport);
  assert.notEqual(transport.sendToChat, original);
  await transport.sendToChat('private:1', 'abc');
  assert.equal(lines(file).length, 1);
  ledger.uninstall();
  assert.equal(transport.sendToChat, original, '必须装回**同一个**函数引用（不是行为相同的另一个）');
  await transport.sendToChat('private:1', 'def');
  assert.equal(lines(file).length, 1, '卸载之后不该再记');
});

test('挂钩：`sendToChat` 不是函数 / transport 不是对象 ⇒ 静默跳过，不抛', () => {
  const { ledger } = makeLedger('nohook');
  assert.doesNotThrow(() => ledger.instrument({}));
  assert.doesNotThrow(() => ledger.instrument(null));
  assert.doesNotThrow(() => ledger.instrument(undefined));
  assert.doesNotThrow(() => ledger.instrument(42));
  assert.doesNotThrow(() => ledger.instrument({ sendToChat: 'not a function' }));
});

test('挂钩：段数组载荷也记一行，`chars` 是 0 且 `meta.text=false`（别混进来比长度）', async () => {
  const { ledger, file } = makeLedger('segments');
  const transport = makeTransport();
  ledger.instrument(transport);
  await transport.sendToChat('private:1', [{ type: 'image', data: { url: 'http://x/a.png' } }]);
  const r = lines(file)[0];
  assert.equal(r.chars, 0);
  assert.equal(r.sha256, ledgerHash(''), '段数组没有"净文本"，哈希按空串算（那是"我确实算了"的证据）');
  assert.equal(r.meta.text, false);
  assert.equal(r.ok, true);
});

test('★ 消费者回调（`onRecord`）抛错 ⇒ 台账照写、发送照常，但**留一行 debug**', async () => {
  const dir = tmpDir('sink');
  const file = path.join(dir, 'qq-outbound.jsonl');
  const transport = makeTransport();
  const logs = [];
  const ledger = createOutboundLedger({
    config: { file, enabled: true, maxLines: 100 },
    log: (level, msg) => logs.push({ level, msg }),
  });
  let calls = 0;
  ledger.instrument(transport, { onRecord: () => { calls += 1; throw new Error('sink is broken'); } });
  await assert.doesNotReject(() => transport.sendToChat('private:1', 'abc'));
  assert.equal(calls, 1, '回调确实被调了');
  assert.equal(ledger.stats().wrote, 1, '回调抛错不该把台账那行弄没');
  assert.equal(lines(file).length, 1);
  // ⚠️ 这条断言是**用真金白银换来的**：这次调试中 `gateway.mjs` 漏 import
  //    一个常量，sink 每次抛 `ReferenceError`，而它被彻底吞掉 ⇒
  //    `stats.outbound.actions` 恒为 0，看起来和"没发过"一模一样。
  //    **静默失效就是这么来的** —— 所以回调抛错至少要留一行 log。
  assert.ok(logs.some((l) => l.level === 'debug' && l.msg.includes('回调')), '回调抛错必须留痕');
});

test('★★ `onAction`（计数口径）**台账写不进去也要调** —— 别把"台账坏了"和"没发过"混成一个 0', async () => {
  const transport = makeTransport();
  const logs = [];
  const ledger = createOutboundLedger({
    config: { file: 'H:\\nope\\x.jsonl', enabled: true, maxLines: 100 },
    fsImpl: {
      mkdirSync() { throw new Error('EPERM'); },
      appendFileSync() { throw new Error('EPERM'); },
      readFileSync() { throw new Error('EPERM'); },
      writeFileSync() { throw new Error('EPERM'); },
      renameSync() { throw new Error('EPERM'); },
    },
    log: (level, msg) => logs.push({ level, msg }),
  });
  let actions = 0;
  let records = 0;
  ledger.instrument(transport, {
    onAction: () => { actions += 1; },
    onRecord: () => { records += 1; },
  });
  await assert.doesNotReject(() => transport.sendToChat('private:1', 'abc'));
  assert.equal(ledger.stats().wrote, 0, '这一跑台账一个字都没写进去');
  assert.equal(actions, 1, '★ 计数必须照样 +1 —— 这正是"发了很多条但没记上"与"什么都没发"的分界');
  assert.equal(records, 0, '诊断回调只在真写下时调，所以它不涨（两个口径确实分开了）');
});

test('`onAction` 在发送抛异常时也要调（它是"发生了发送动作"，不是"发成功了"）', async () => {
  const dir = tmpDir('onaction-fail');
  const file = path.join(dir, 'qq-outbound.jsonl');
  const transport = makeTransport({ fail: true });
  const ledger = createOutboundLedger({ config: { file, enabled: true, maxLines: 100 }, log: () => {} });
  let actions = 0;
  ledger.instrument(transport, { onAction: () => { actions += 1; } });
  await assert.rejects(() => transport.sendToChat('private:1', 'abc'), /send_msg 超时/);
  assert.equal(actions, 1, '失败的发送也是"发生了一次动作"（台账里有它的 ok:false 行）');
});

// ══════════════════════════════════════════════ 判读表

test('★ 判读表：三种形状 ⇒ 三个结论（这是台账存在的全部理由）', () => {
  const rows = describeOutboundVerdicts();
  assert.equal(rows.length, 3);
  const shapes = rows.map((r) => r.shape);
  assert.deepEqual(shapes, [
    'gw-send 1 + transport-action 2',
    'gw-send 1 + transport-action 1 + QQ 2',
    'gw-send 2',
  ]);
  assert.match(rows[0].verdict, /传输层/);
  assert.match(rows[1].verdict, /NapCat/);
  assert.match(rows[2].verdict, /插件/);
});

test('层标记常量就是台账里的字面值（判读时不能有两套叫法）', () => {
  assert.equal(LAYER_GW_SEND, 'gw-send');
  assert.equal(LAYER_TRANSPORT_ACTION, 'transport-action');
});

// ══════════════════════════════════════════════ 网关接线（端到端）

/** 装一套网关：真 Router/Engine + 假 transport + 注入的台账。 */
function harness({ ledger = null, reply = '回复', transport = null } = {}) {
  const t = transport ?? makeTransport();
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.ALLOWLIST,
    groupAllowFrom: ['200000001'],
    requireMention: true,
    botQQ: '999',
  });
  const engine = new ProactiveEngine({
    config: { enabled: false, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0, afterUserMsgCount: 0 },
    gauge: async () => ({ speak: true }),
    speak: async () => undefined,
    log: () => {},
  });
  const gateway = new Gateway({
    transport: t,
    router,
    engine,
    responder: async () => reply,
    log: () => {},
    outboundLedger: ledger,
  });
  gateway.attach();
  return { gateway, transport: t };
}

/** 一条私聊入站消息（`runTurn` 用的最小形状）。 */
function privateMessage(text = '在吗') {
  return {
    chatId: 'private:10000001',
    kind: 'private',
    userId: '10000001',
    nickname: '用户',
    text,
    at: Date.now(),
    mentioned: true,
    replyToSelf: false,
    segments: [{ type: 'text', text }],
    raw: text,
  };
}

test('★★ 端到端：一次回复 ⇒ `gw-send` 恰好**一行**、`transport-action` 恰好**一行**', async () => {
  const { ledger, file } = makeLedger('e2e');
  const h = harness({ ledger, reply: '在的，你说' });
  await h.gateway.runTurn({
    message: privateMessage(),
    sessionKey: 'qq-private-10000001',
    restricted: false,
    prompt: 'p',
    addressed: true,
  });
  const rows = lines(file);
  const gw = rows.filter((r) => r.layer === 'gw-send');
  const tr = rows.filter((r) => r.layer === 'transport-action');
  // ⭐ 这就是判读表的基线行：1 + 1。**多一行就是假重复**。
  assert.equal(gw.length, 1, '`gw-send` 必须恰好一行（多了就等于"插件真的发了两次"）');
  assert.equal(tr.length, 1, '`transport-action` 必须恰好一行');
  // B2（2026-10-25）：默认 `auto_reply=fallback` ⇒ "本轮没调 send_qq 时自动发"的那条
  // 记成 `runTurn-fallback`（一眼能看出它本该由工具发）。**行数口径没变**：
  // 一条消息仍然恰好 1 行 `gw-send`，这条断言保护的正是那个不变式。
  assert.equal(gw[0].caller, 'runTurn-fallback');
  assert.equal(gw[0].chars, 5);
  assert.equal(gw[0].sha256, ledgerHash('在的，你说'), '两层记的必须是同一个净文本的哈希');
  assert.equal(tr[0].sha256, gw[0].sha256, '两层的 sha256 必须相等 —— 这是"同一条"的判据');
  assert.equal(tr[0].messageId, 'mid-1');
  assert.deepEqual(h.gateway.stats.outbound, { sends: 1, actions: 1 });
});

test('★ 端到端：**剥 Markdown 之后**的文本才是哈希对象（与真正发出去的一致）', async () => {
  const { ledger, file } = makeLedger('e2e-md');
  const h = harness({ ledger, reply: '**结论**：可以' });
  await h.gateway.runTurn({
    message: privateMessage(), sessionKey: 'qq-private-10000001', restricted: false, prompt: 'p', addressed: true,
  });
  const gw = lines(file).find((r) => r.layer === 'gw-send');
  assert.equal(gw.chars, '结论：可以'.length, '长度必须是**发出去的**那个文本的长度');
  assert.equal(gw.sha256, ledgerHash('结论：可以'));
  assert.notEqual(gw.sha256, ledgerHash('**结论**：可以'), '不能拿模型原文算哈希 —— 那和 QQ 上的字对不上');
});

test('端到端：主动发言（`speak-proactive`）也走同一套记账', async () => {
  const { ledger, file } = makeLedger('e2e-speak');
  const h = harness({ ledger });
  assert.equal(await h.gateway.speakProactively('group:200000001', '提醒：该睡了'), true);
  const gw = lines(file).filter((r) => r.layer === 'gw-send');
  assert.equal(gw.length, 1);
  assert.equal(gw[0].caller, 'speak-proactive');
  assert.deepEqual(h.gateway.stats.outbound, { sends: 1, actions: 1 });
});

test('★ 端到端：没有台账时**一个字节都不写**，`stats.outbound` 照常计数', async () => {
  const dir = tmpDir('e2e-null');
  const stray = path.join(dir, 'qq-outbound.jsonl');
  const ledger = createOutboundLedger({ config: { file: stray, enabled: false }, log: () => {} });
  const h = harness({ ledger });
  await h.gateway.runTurn({
    message: privateMessage(), sessionKey: 'qq-private-10000001', restricted: false, prompt: 'p', addressed: true,
  });
  assert.ok(!fs.existsSync(stray), '台账关掉时一个字节都不许写');
  // ⚠️ 计数必须**照样准** —— 它数的是"发了几次"，不是"记下来几行"。
  //    数错的话，一个关掉台账的部署里 `sends/actions` 会恒为 1/0（看起来像丢了一半）。
  assert.deepEqual(h.gateway.stats.outbound, { sends: 1, actions: 1 }, '计数不依赖台账写没写');
});

test('★ 端到端：连台账对象都没注入（`null`）⇒ `sends` 照样准；`actions` 为 0（没有挂钩就没有那一层）', async () => {
  const h = harness({ ledger: null });
  await h.gateway.runTurn({
    message: privateMessage(), sessionKey: 'qq-private-10000001', restricted: false, prompt: 'p', addressed: true,
  });
  // ⚠️ 这是**已知的边界**，不是 bug：`transport-action` 那一层是**台账模块挂的钩**，
  //    没有台账对象就没人挂钩 ⇒ 那一层压根不存在，`actions` 只能是 0。
  //    生产里 `index.mjs` 永远会造一个台账（`enabled` 可能是 false，但对象在），
  //    所以这条只在"完全没接台账"的环境里成立。**别把它当"发失败了"读** ——
  //    那种情况是 `sends > actions` 且台账里有 `ok:false` 的行。
  assert.equal(h.gateway.stats.outbound.sends, 1, '`sends` 在网关自己身上加，不依赖台账');
  assert.equal(h.gateway.stats.outbound.actions, 0);
});

test('★★ 端到端：台账**写不进去**时发送照常成功（血泪教训：观测坏了不能把被观测的弄坏）', async () => {
  const logs = [];
  const boomLedger = createOutboundLedger({
    config: { file: 'H:\\nope\\x.jsonl', enabled: true, maxLines: 100 },
    fsImpl: {
      mkdirSync() { throw new Error('EPERM'); },
      appendFileSync() { throw new Error('EPERM'); },
      readFileSync() { throw new Error('EPERM'); },
      writeFileSync() { throw new Error('EPERM'); },
      renameSync() { throw new Error('EPERM'); },
    },
    log: (level, msg) => logs.push({ level, msg }),
  });
  const h = harness({ ledger: boomLedger, reply: '在的' });
  const text = await h.gateway.runTurn({
    message: privateMessage(), sessionKey: 'qq-private-10000001', restricted: false, prompt: 'p', addressed: true,
  });
  assert.equal(text, '在的', '台账写不进去**绝不能**影响回复');
  assert.equal(h.transport.calls.sendToChat, 1, '该发的还是发了');
  assert.deepEqual(h.gateway.stats.outbound, { sends: 1, actions: 1 }, '计数不依赖磁盘');
  assert.ok(logs.some((l) => l.msg.includes('写盘失败')));
});

test('★ 端到端：发送**失败** ⇒ `gw-send` 与 `transport-action` 各一行，`ok` 在传输层为 false', async () => {
  const { ledger, file } = makeLedger('e2e-fail');
  const h = harness({ ledger, transport: makeTransport({ fail: true }) });
  await assert.rejects(() => h.gateway.runTurn({
    message: privateMessage(), sessionKey: 'qq-private-10000001', restricted: false, prompt: 'p', addressed: true,
  }), /send_msg 超时/);
  const rows = lines(file);
  assert.equal(rows.filter((r) => r.layer === 'gw-send').length, 1, '失败也只是一行 gw-send');
  const tr = rows.filter((r) => r.layer === 'transport-action');
  assert.equal(tr.length, 1);
  assert.equal(tr[0].ok, false, '"发失败"只出现在 transport-action 这一层');
  assert.deepEqual(h.gateway.stats.outbound, { sends: 1, actions: 1 });
});

test('★ 端到端：`stop()` 之后台账挂钩被装回去（不再记）', async () => {
  const { ledger, file } = makeLedger('e2e-stop');
  // ⚠️ 必须在**建网关之前**抓住原方法：网关一构造就挂上去了，
  // 之后再抓就只能抓到包装后的那个（那就验不了"装回去了"）。
  const transport = makeTransport();
  const original = transport.sendToChat;
  const h = harness({ ledger, transport });
  assert.notEqual(h.transport.sendToChat, original, '构造时应该已经挂上了');
  await h.gateway.speakProactively('group:200000001', '第一条');
  assert.equal(lines(file).length, 2, '一 send 一 action');
  h.gateway.stop();
  assert.equal(h.transport.sendToChat, original, '停止后必须把原方法装回去');
  await h.transport.sendToChat('group:200000001', '第二条');
  assert.equal(lines(file).length, 2, '停止后不该再记');
});

test('★ 端到端：同一轮里发两条相同文本到不同会话 ⇒ 台账里两条相同 sha256（判据真的成立）', async () => {
  const { ledger, file } = makeLedger('e2e-dup');
  const h = harness({ ledger });
  // ⚠️ 发到**不同 chatId**：`#send` 有"同一会话 10 秒内同文拦下"的闸
  //（2026-10-16 那道防御），同一个群里连发两条相同文本会被它挡掉 ——
  // 而这里要验的是**台账的哈希判据**（同文本 ⇒ 同 sha256），不是那道闸。
  // 走内部投递：它是公开入口、且会让一轮真的发出去（回复固定为「回复」）。
  await h.gateway.deliverFromAlice({ text: '一次', replyTo: 'private:10000001' });
  await h.gateway.deliverFromAlice({ text: '两次', replyTo: 'private:10000002' });
  const gw = lines(file).filter((r) => r.layer === 'gw-send');
  assert.equal(gw.length, 2);
  assert.equal(gw[0].sha256, gw[1].sha256, '同一条文本 ⇒ 同一个哈希（这条判据是台账的地基）');
  // 真实的"同一秒两条"会是这样：`at` 相同。这里不强行造同秒，只钉哈希相等。
});

test('端到端：`attachOutboundLedger()` 可重复调用而不重复挂钩', async () => {
  const { ledger, file } = makeLedger('e2e-reattach');
  const h = harness({ ledger });
  h.gateway.attachOutboundLedger();
  h.gateway.attachOutboundLedger();
  await h.gateway.speakProactively('group:200000001', '一次');
  assert.equal(lines(file).length, 2, '一 send 一 action —— 挂钩没叠');
});
// 2026-10-26：`error` 单独放宽到 300 字符。
//
// 线上那次发图失败（NapCat 报 `Cannot read properties of undefined (reading 'text')`）
// 在台账里**只剩 `{ok:false, text:false}`**：`error` 是 60+ 字符的原文，
// 被"短标量"那条规则**静默丢掉**了，排查只能靠猜。这条钉住"失败原因必须留得下来"。
test('★ 失败原因（`error`）即使超过 60 字符也要留下来（其余字符串仍限 60）', () => {
  const { ledger, file } = makeLedger('error-len');
  const longError = 'OneBot action send_msg 失败：status=failed retcode=200 Cannot read properties of undefined (reading \'text\')';
  assert.ok(longError.length > 60);
  ledger.record({
    layer: LAYER_TRANSPORT_ACTION, caller: 'sendToChat:send_msg', chatId: 'p:1',
    chars: 0, sha256: 'h', ok: false, action: 'send_msg',
    meta: { text: false, error: longError, note: 'y'.repeat(80) },
  });
  const m = lines(file)[0].meta;
  assert.equal(m.error, longError, '失败原因必须原样留下（这是唯一能查到"为什么失败"的地方）');
  assert.ok(!('note' in m), '别的字符串仍然限 60 —— meta 不是搬运长文本的通道');
});

test('`error` 超过 300 字符仍然丢掉（别让 meta 长成日志）', () => {
  const { ledger, file } = makeLedger('error-too-long');
  ledger.record({
    layer: LAYER_TRANSPORT_ACTION, caller: 'sendToChat:send_msg', chatId: 'p:1',
    chars: 0, sha256: 'h', ok: false, meta: { error: 'e'.repeat(400) },
  });
  // 全被丢掉时 `meta` 整个字段都不写（"没有"比"空对象"更诚实）。
  const meta = lines(file)[0].meta;
  assert.ok(meta === undefined || !('error' in meta));
});
