/**
 * `[free_time]`（定时任务）的装载、写回与三条 HTTP 路由（2026-10-17）。
 *
 * ## 这一组在钉什么
 *
 * 1. **默认必须关**：`enabled` 没配 = `false`。和 `[memory]` / `[mood]` 的
 *    "默认开着"故意相反 —— 定时任务是**新行为**，没配就不该自己跑。
 * 2. **越界/类型不对 ⇒ 回默认、绝不抛**：那个 toml 在用户手里，
 *    写坏一个数不该让小鲸鱼整个起不来。
 * 3. **只重写 `[free_time]` 一节**：文件里有人设、白名单、模型，
 *    整份重新序列化等于把它们重写一遍（本项目最贵的一类坑）。
 * 4. **文件值 vs 生效值是两个字段**：`stale:false` 只证明代码新，
 *    **不证明 toml 被读了** —— 所以 `/settings` 必须同时给出两份。
 * 5. **保存 ≠ 生效**：返回体里必须有 `restartNeeded: true`。
 *
 * ⚠️ 全组**不碰线上那份 `qq-gugu.toml`**：所有 toml 都在 `test/.tmp-free-time-*`
 * 下现造（照 `learned-memory-switch.test.mjs` 的做法，刻意不用 `os.tmpdir()` ——
 * 受限沙箱里 `%TEMP%` 会被挡，那会让这组测试在本机永远是红的）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pluginModule from '../src/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-free-time-';

function tempDir() {
  return fs.mkdtempSync(path.join(HERE, PREFIX));
}

function writeFile(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith(PREFIX)) fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
    }
  } catch {
    /* 收尾失败不该影响测试结果 */
  }
});

const DEFAULTS = {
  enabled: false,
  intervalHours: 3,
  // 2026-10-23：短追问（用户最后一条消息之后多久叫一声，只叫一次）。
  followupMinutes: 10,
  windowStartHour: 9,
  windowEndHour: 24,
  tokenBudgetPerTurn: 20000,
  quietWhenNothing: true,
  // 2026-10-21：唤醒前整屏截图。**默认开**（用户要的是"叫她的时候顺便看看屏幕"）。
  screenshots: true,
  screenshotsKeep: 2,
  // 2026-10-29：每轮投递几张截图（和"保留轮数"是两件事）；两段提示词默认**空** = 用内置文案。
  screenshotsMaxPerWake: 2,
  wakePrompt: '',
  followupPrompt: '',
};

/**
 * 旧的 `/free-time` 整段写入 body：**仍然只有那九个键**。
 *
 * 提示词那三个键**故意不进这张表** —— 它们只走逐键接口（`POST /config`），
 * 整段接口按 `FREE_TIME_KEYS` 重建整段，不认识的键会被丢掉（见宿主的 fail-closed 闸门）。
 */
const VALID = {
  enabled: true,
  intervalHours: 4,
  followupMinutes: 7,
  windowStartHour: 10,
  windowEndHour: 23,
  tokenBudgetPerTurn: 12000,
  quietWhenNothing: false,
  screenshots: false,
  screenshotsKeep: 3,
};

/** `loadFreeTimeConfig` 的完整返回值（= 九个键 + 三个只走逐键接口的键）。 */
const VALID_LOADED = { ...VALID, screenshotsMaxPerWake: 2, wakePrompt: '', followupPrompt: '' };

// ---------------------------------------------------------------- 读 toml

test('★ 读得到：[free_time] 的九个键原样读出来', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', [
    '[free_time]',
    'enabled = true',
    'intervalHours = 4',
    'followupMinutes = 7',
    'windowStartHour = 10',
    'windowEndHour = 23',
    'tokenBudgetPerTurn = 12000',
    'quietWhenNothing = false',
    'screenshots = false',
    'screenshotsKeep = 3',
    '',
  ].join('\n'));
  assert.deepEqual(pluginModule.loadFreeTimeConfig({ tomlPath }), VALID_LOADED);
});

test('★ 没有 [free_time] ⇒ 默认值，且 enabled 是 **false**（新行为不能自己跑）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', '[personality]\nname = "小鲸鱼"\n');
  const cfg = pluginModule.loadFreeTimeConfig({ tomlPath });
  assert.deepEqual(cfg, DEFAULTS);
  assert.equal(cfg.enabled, false);
});

test('toml 不存在 ⇒ 默认值，绝不抛', () => {
  assert.deepEqual(
    pluginModule.loadFreeTimeConfig({ tomlPath: path.join(HERE, '.tmp-does-not-exist.toml') }),
    DEFAULTS,
  );
});

test('★ 类型不对 / 越界 ⇒ 回默认（不猜意思、不夹紧）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', [
    '[free_time]',
    'enabled = "false"',        // 字符串：JS 里是真值 —— 认了就把开关吃掉
    'intervalHours = 0',        // 1~24
    'windowStartHour = 25',     // 0~23
    'windowEndHour = 0',        // 1~24
    'tokenBudgetPerTurn = 999', // >= 1000
    'quietWhenNothing = 1',     // 只认布尔
    '',
  ].join('\n'));
  assert.deepEqual(pluginModule.loadFreeTimeConfig({ tomlPath }), DEFAULTS);
});

test('windowEndHour 必须 > windowStartHour，否则回默认 24', () => {
  const dir = tempDir();
  const same = writeFile(dir, 'same.toml', '[free_time]\nwindowStartHour = 9\nwindowEndHour = 9\n');
  assert.equal(pluginModule.loadFreeTimeConfig({ tomlPath: same }).windowEndHour, 24);
  const cross = writeFile(dir, 'cross.toml', '[free_time]\nwindowStartHour = 22\nwindowEndHour = 6\n');
  const cfg = pluginModule.loadFreeTimeConfig({ tomlPath: cross });
  assert.equal(cfg.windowEndHour, 24, '跨零点时段本轮不支持 ⇒ 回默认（要看得见）');
});

test('蛇形键名也认（老的手写配置不会失效）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', [
    '[free_time]',
    'enabled = true',
    'interval_hours = 6',
    'followup_minutes = 5',
    'window_start_hour = 8',
    'window_end_hour = 20',
    'token_budget_per_turn = 9000',
    'quiet_when_nothing = false',
    '',
  ].join('\n'));
  assert.deepEqual(pluginModule.loadFreeTimeConfig({ tomlPath }), {
    enabled: true,
    intervalHours: 6,
    followupMinutes: 5,
    windowStartHour: 8,
    windowEndHour: 20,
    tokenBudgetPerTurn: 9000,
    quietWhenNothing: false,
    screenshots: true,
    screenshotsKeep: 2,
    screenshotsMaxPerWake: 2,
    wakePrompt: '',
    followupPrompt: '',
  });
});

test('★ 截图两个键：写进 toml 能读回来；没写 ⇒ 默认 true / 2；类型不对 ⇒ 回默认', () => {
  // ① 没写 ⇒ 默认值（截图默认**开**，因为用户要的就是"叫她的时候顺便看看屏幕"）
  const empty = writeFile(tempDir(), 'empty.toml', '[free_time]\nenabled = true\n');
  const plain = pluginModule.loadFreeTimeConfig({ tomlPath: empty });
  assert.equal(plain.screenshots, true);
  assert.equal(plain.screenshotsKeep, 2);

  // ② 写进去能读回来
  const written = writeFile(tempDir(), 'written.toml', [
    '[free_time]',
    'screenshots = false',
    'screenshotsKeep = 5',
    '',
  ].join('\n'));
  const cfg = pluginModule.loadFreeTimeConfig({ tomlPath: written });
  assert.equal(cfg.screenshots, false);
  assert.equal(cfg.screenshotsKeep, 5);

  // ③ 类型不对 / 越界 ⇒ 回默认（1~50，整数）
  const broken = writeFile(tempDir(), 'broken.toml', [
    '[free_time]',
    'screenshots = "false"',
    'screenshotsKeep = 51',
    '',
  ].join('\n'));
  const bad = pluginModule.loadFreeTimeConfig({ tomlPath: broken });
  assert.equal(bad.screenshots, true);
  assert.equal(bad.screenshotsKeep, 2);
});

test('★ 行级重写把截图两个键一起写下去（不然保存一次就被删掉）', () => {
  const after = pluginModule.rewriteFreeTimeSection('[personality]\nname = "小鲸鱼"\n', VALID);
  assert.ok(after.includes('screenshots = false'), after);
  assert.ok(after.includes('screenshotsKeep = 3'), after);
  assert.ok(after.includes('followupMinutes = 7'), '短追问的键也要写下去');
  assert.deepEqual(pluginModule.loadFreeTimeConfig({ tomlPath: writeFile(tempDir(), 'x.toml', after) }), VALID_LOADED);
});

test('★ 短追问（followupMinutes）：默认 10、写进去读得回来、越界/类型不对 ⇒ 回默认', () => {
  const empty = writeFile(tempDir(), 'ft-empty.toml', '[free_time]\nenabled = true\n');
  assert.equal(pluginModule.loadFreeTimeConfig({ tomlPath: empty }).followupMinutes, 10);

  const written = writeFile(tempDir(), 'ft-written.toml', '[free_time]\nfollowupMinutes = 25\n');
  assert.equal(pluginModule.loadFreeTimeConfig({ tomlPath: written }).followupMinutes, 25);

  for (const bad of ['25', 0, 1441, -5]) {
    const file = writeFile(tempDir(), `ft-bad-${String(bad).replace(/[^0-9-]/g, '')}-${Math.random().toString(16).slice(2)}.toml`,
      `[free_time]\nfollowupMinutes = ${typeof bad === 'string' ? `"${bad}"` : bad}\n`);
    assert.equal(pluginModule.loadFreeTimeConfig({ tomlPath: file }).followupMinutes, 10, String(bad));
  }
});

// ---------------------------------------------------------------- 行级重写

test('★ 追加：没有 [free_time] 时只加这一节，其它字节原样', () => {
  const before = '[personality]\nname = "小鲸鱼"\n\n[memory]\nlearned_enabled = false\n';
  const after = pluginModule.rewriteFreeTimeSection(before, VALID);
  assert.ok(after.startsWith(before), '原有内容必须原样保留在开头');
  assert.ok(after.includes('[free_time]'));
  assert.ok(after.includes('intervalHours = 4'));
  assert.ok(after.includes('enabled = true'));
  // 解析层面也读得回来
  assert.deepEqual(pluginModule.loadFreeTimeConfig({ tomlPath: writeFile(tempDir(), 'x.toml', after) }), VALID_LOADED);
});

test('★ 替换：已有 [free_time] 时只换那一段，前后文一字不动', () => {
  const before = [
    '[personality]',
    'name = "小鲸鱼"',
    '',
    '[free_time]',
    'enabled = false',
    'intervalHours = 3',
    '',
    '[memory]',
    'learned_enabled = false',
    '',
  ].join('\n');
  const after = pluginModule.rewriteFreeTimeSection(before, VALID);
  assert.ok(after.startsWith('[personality]\nname = "小鲸鱼"\n'));
  assert.ok(after.includes('\n[memory]\nlearned_enabled = false\n'));
  assert.equal(after.split('[free_time]').length - 1, 1, '不许留下两份 [free_time]');
  assert.equal(pluginModule.loadFreeTimeConfig({ tomlPath: writeFile(tempDir(), 'x.toml', after) }).intervalHours, 4);
});

test('CRLF 文件不被混进 LF（改完换行符保持不变）', () => {
  const before = '[personality]\r\nname = "小鲸鱼"\r\n';
  const after = pluginModule.rewriteFreeTimeSection(before, VALID);
  assert.ok(after.includes('\r\n[free_time]\r\n'), `实际：${JSON.stringify(after.slice(-80))}`);
  assert.ok(!/[^\r]\n/.test(after), '不许出现裸 LF');
});

// ---------------------------------------------------------------- 输入校验

test('★ 校验：六个字段全给才收（缺字段 = 静默重置，比报错难查）', () => {
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, enabled: undefined }).ok, false);
  const partial = { ...VALID };
  delete partial.quietWhenNothing;
  const result = pluginModule.validateFreeTimeInput(partial);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('quietWhenNothing'));
});

test('校验：类型不对 / 越界 / 时段倒置都拒绝', () => {
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, enabled: 'true' }).ok, false);
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, intervalHours: 0 }).ok, false);
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, intervalHours: 25 }).ok, false);
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, windowStartHour: -1 }).ok, false);
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, windowEndHour: 0 }).ok, false);
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, tokenBudgetPerTurn: 999 }).ok, false);
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, quietWhenNothing: 'yes' }).ok, false);
  // 截图两个键也要认（别只加一半）
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, screenshots: 'yes' }).ok, false);
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, screenshotsKeep: 0 }).ok, false);
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, screenshotsKeep: 51 }).ok, false);
  // 短追问（2026-10-23）：给了就必须合法（1~1440 分钟，整数）
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, followupMinutes: 0 }).ok, false);
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, followupMinutes: 1441 }).ok, false);
  assert.equal(pluginModule.validateFreeTimeInput({ ...VALID, followupMinutes: '10' }).ok, false);
  // ⚠️ 唯一一个"缺了也收"的字段：老界面（`client.js` 的 /free-time 表单）没有它，
  //    按"缺字段 = 静默重置"去拒会让用户在那个界面上保存一次就被拦住。
  const noFollowup = { ...VALID };
  delete noFollowup.followupMinutes;
  assert.deepEqual(pluginModule.validateFreeTimeInput(noFollowup), {
    ok: true,
    values: { ...VALID, followupMinutes: 10 },
  });
  const noShot = { ...VALID };
  delete noShot.screenshots;
  assert.equal(pluginModule.validateFreeTimeInput(noShot).ok, false, '缺 screenshots = 静默重置，必须拒');
  assert.equal(
    pluginModule.validateFreeTimeInput({ ...VALID, windowStartHour: 22, windowEndHour: 6 }).ok,
    false,
    '跨零点本轮不支持',
  );
  assert.equal(pluginModule.validateFreeTimeInput(null).ok, false);
  assert.deepEqual(pluginModule.validateFreeTimeInput(VALID), { ok: true, values: VALID });
});

// ---------------------------------------------------------------- HTTP 路由

/** 极简 req：`on` 收集监听，测试在 handler 开始 await 后再 `fire()`。 */
function makeReq(method, body) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method,
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
      return req;
    },
    destroy() {},
  };
  const fire = () => {
    if (body !== undefined) {
      const chunk = Buffer.from(JSON.stringify(body), 'utf8');
      for (const fn of listeners.data) fn(chunk);
    }
    for (const fn of listeners.end) fn();
  };
  return { req, fire };
}

function makeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body += chunk === undefined ? '' : String(chunk);
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function routeOf(routes, suffix) {
  const route = routes.find((r) => r.path === `/dsh-qq-proactive/${suffix}`);
  assert.ok(route !== undefined, `缺路由 ${suffix}`);
  return route;
}

async function call(routes, suffix, method, body) {
  const { req, fire } = makeReq(method, body);
  const res = makeRes();
  const pending = routeOf(routes, suffix).handler(req, res);
  fire();
  await pending;
  return res;
}

test('★ GET /settings：文件值与生效值分成两个字段（只靠一个就等于自证）', async () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', [
    '[free_time]',
    'enabled = true',
    'intervalHours = 5',
    '',
    '[memory]',
    'learned_enabled = false',
    '',
  ].join('\n'));
  const snapshotPath = path.join(dir, 'snap.json');
  fs.writeFileSync(snapshotPath, JSON.stringify({
    staleCode: { stale: false, newestFile: 'src/index.mjs' },
    stats: { received: 42, dispatched: 7, replies: 3 },
    learnedMemory: { enabled: false, learnerBuilt: false },
    knowledgeInject: { maxChars: 800, privateAsSection: true, lastChars: 0, lastMode: 'none' },
    freeTime: { enabled: false },
  }), 'utf8');

  const routes = pluginModule.createFreeTimeHttpRoutes({
    tomlPath,
    // 进程里还是默认值 ⇒ 模拟"toml 改过、但没重载"
    freeTimeCfg: DEFAULTS,
    memoryCfg: { learnedEnabled: false, injectMaxChars: 800, injectPrivateAsSection: true },
    snapshotPath,
  });
  const res = await call(routes, 'settings', 'GET');
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.tomlPath, tomlPath);
  assert.equal(payload.file.freeTime.enabled, true, '文件里写的是 true');
  assert.equal(payload.effective.freeTime.enabled, false, '进程里生效的是 false（还没重载）');
  assert.equal(payload.file.freeTime.intervalHours, 5);
  assert.equal(payload.effective.freeTime.intervalHours, 3);
  assert.equal(payload.file.memory.learnedEnabled, false);
  assert.deepEqual(payload.snapshot.stats, { received: 42, dispatched: 7, replies: 3 });
  assert.equal(payload.snapshot.staleCode.stale, false);
  assert.equal(payload.snapshot.knowledgeInject.maxChars, 800);
});

test('GET /settings：快照文件不存在 ⇒ snapshot 是空值，不是 500', async () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', '');
  const routes = pluginModule.createFreeTimeHttpRoutes({
    tomlPath,
    snapshotPath: path.join(dir, 'nope.json'),
  });
  const res = await call(routes, 'settings', 'GET');
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.snapshot.stats, null);
  assert.equal(payload.snapshot.staleCode, null);
});

test('★ POST /free-time：只改 [free_time]，先备份，返回 restartNeeded', async () => {
  const dir = tempDir();
  const backupDir = path.join(dir, 'backups');
  const original = [
    '[personality]',
    'name = "小鲸鱼"',
    'personality = """很长的设定"""',
    '',
    '[memory]',
    'learned_enabled = false',
    '',
  ].join('\n');
  const tomlPath = writeFile(dir, 'qq-gugu.toml', original);
  const routes = pluginModule.createFreeTimeHttpRoutes({ tomlPath, backupDir });

  const res = await call(routes, 'free-time', 'POST', VALID);
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(res.json(), { ok: true, wrote: true, restartNeeded: true });

  const written = fs.readFileSync(tomlPath, 'utf8');
  assert.ok(written.startsWith('[personality]\nname = "小鲸鱼"\n'), '人设段必须原样');
  assert.ok(written.includes('[memory]\nlearned_enabled = false'), '记忆段必须原样');
  assert.deepEqual(
    pluginModule.loadFreeTimeConfig({ tomlPath }),
    VALID_LOADED,
    '写进去的六个数必须读得回来',
  );

  // 备份落 `backupDir`（与 `POST /config` 同一个目录），**不再**在 toml 旁边。
  const backups = fs.readdirSync(backupDir).filter((n) => n.startsWith('qq-gugu.toml.bak-'));
  assert.equal(backups.length, 1, '必须留一份备份');
  assert.equal(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'), original, '备份必须是改动前的原文');
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('qq-gugu.toml.bak-')).length, 0, 'toml 旁边不该再有备份');

  // 再写一次：不许留下两份 [free_time]
  const second = { ...VALID, intervalHours: 8, enabled: false };
  const res2 = await call(routes, 'free-time', 'POST', second);
  assert.equal(res2.status, 200, res2.body);
  const twice = fs.readFileSync(tomlPath, 'utf8');
  assert.equal(twice.split('[free_time]').length - 1, 1);
  assert.deepEqual(
    pluginModule.loadFreeTimeConfig({ tomlPath }),
    { ...VALID_LOADED, intervalHours: 8, enabled: false },
  );
  assert.equal(fs.readdirSync(backupDir).filter((n) => n.startsWith('qq-gugu.toml.bak-')).length, 2);
});

test('★ POST /free-time：校验不过 ⇒ 400，且**一个字节都不写**、备份也不留', async () => {
  const dir = tempDir();
  const backupDir = path.join(dir, 'backups');
  const original = '[personality]\nname = "小鲸鱼"\n';
  const tomlPath = writeFile(dir, 'qq-gugu.toml', original);
  const routes = pluginModule.createFreeTimeHttpRoutes({ tomlPath, backupDir });

  // 参数本身非法：闸在最前面，连备份都还没做。
  const res = await call(routes, 'free-time', 'POST', { ...VALID, intervalHours: 99 });
  assert.equal(res.status, 400);
  assert.equal(res.json().ok, false);
  assert.equal(fs.readFileSync(tomlPath, 'utf8'), original, '被拒的写入不许碰文件');
  assert.equal(fs.existsSync(backupDir), false, '连备份目录都不该被建出来');
});

test('★ POST /free-time：备份之后才失败（[free_time] 出现在多行字符串里）⇒ 400 且删掉刚做的备份', async () => {
  const dir = tempDir();
  const backupDir = path.join(dir, 'backups');
  // 这份 toml **读得出来、`parseToml` 也成功**（`note` 的值里含 `[free_time]` 那行），
  // 但行级改写会把多行字符串当成 section 切开 ⇒ 改后的全文校验不过。
  // 关键：它正好落在**备份已经做完之后** —— 专门钉"失败要删备份"。
  const broken = 'note = """\n[free_time]\n"""\n';
  const tomlPath = writeFile(dir, 'qq-gugu.toml', broken);
  const routes = pluginModule.createFreeTimeHttpRoutes({ tomlPath, backupDir });

  const res = await call(routes, 'free-time', 'POST', VALID);
  assert.equal(res.status, 400, res.body);
  assert.equal(res.json().ok, false);
  assert.equal(fs.readFileSync(tomlPath, 'utf8'), broken, '失败时一个字节都不许写');
  const backups = fs.existsSync(backupDir)
    ? fs.readdirSync(backupDir).filter((n) => n.startsWith('qq-gugu.toml.bak-'))
    : [];
  assert.deepEqual(backups, [], '失败分支必须删掉刚做的备份（不能留残留）');
});

// ---------------------------------------------------------------- 提示词 / 投喂张数（2026-10-29）

test('★ 两段提示词读得回来：内容按字面（换行 / 引号 / $ / 反斜杠都不动）', () => {
  const dir = tempDir();
  const wakeText = '【我的唤醒】\n预算 {{budget}} token，$& 和 C:\\tmp 都是字面。';
  const followText = '短追问：他 {{minutes}} 分钟没回了（“别重复问”）。';
  const tomlPath = writeFile(dir, 'qq-gugu.toml', [
    '[free_time]',
    'wakePrompt = """',
    ...wakeText.split('\n'),
    '"""',
    `followupPrompt = "${followText.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    '',
  ].join('\n'));

  const cfg = pluginModule.loadFreeTimeConfig({ tomlPath });
  assert.equal(cfg.wakePrompt, wakeText);
  assert.equal(cfg.followupPrompt, followText);
});

test('提示词：没写 ⇒ 空串（= 用内置文案）；类型不对 ⇒ 也按没写处理', () => {
  const none = writeFile(tempDir(), 'p-none.toml', '[free_time]\nenabled = true\n');
  assert.equal(pluginModule.loadFreeTimeConfig({ tomlPath: none }).wakePrompt, '');
  assert.equal(pluginModule.loadFreeTimeConfig({ tomlPath: none }).followupPrompt, '');

  const broken = writeFile(tempDir(), 'p-broken.toml', '[free_time]\nwakePrompt = 12\nfollowupPrompt = ["a"]\n');
  const bad = pluginModule.loadFreeTimeConfig({ tomlPath: broken });
  assert.equal(bad.wakePrompt, '');
  assert.equal(bad.followupPrompt, '');
});

test('提示词：蛇形键名也认（wake_prompt / followup_prompt）', () => {
  const tomlPath = writeFile(tempDir(), 'p-snake.toml', [
    '[free_time]',
    'wake_prompt = "蛇形长唤醒"',
    'followup_prompt = "蛇形短追问"',
    '',
  ].join('\n'));
  const cfg = pluginModule.loadFreeTimeConfig({ tomlPath });
  assert.equal(cfg.wakePrompt, '蛇形长唤醒');
  assert.equal(cfg.followupPrompt, '蛇形短追问');
});

test('★ screenshotsMaxPerWake：默认 2、写进去读得回来、越界/类型不对 ⇒ 回默认', () => {
  const none = writeFile(tempDir(), 's-none.toml', '[free_time]\nenabled = true\n');
  assert.equal(pluginModule.loadFreeTimeConfig({ tomlPath: none }).screenshotsMaxPerWake, 2);

  const written = writeFile(tempDir(), 's-written.toml', '[free_time]\nscreenshotsMaxPerWake = 1\n');
  assert.equal(pluginModule.loadFreeTimeConfig({ tomlPath: written }).screenshotsMaxPerWake, 1);
  assert.equal(
    pluginModule.loadFreeTimeConfig({ tomlPath: writeFile(tempDir(), 's-snake.toml', '[free_time]\nscreenshots_max_per_wake = 3\n') })
      .screenshotsMaxPerWake,
    3,
  );

  for (const bad of ['"2"', 0, 51, -1]) {
    const file = writeFile(
      tempDir(),
      `s-bad-${String(bad).replace(/[^0-9-]/g, '')}-${Math.random().toString(16).slice(2)}.toml`,
      `[free_time]\nscreenshotsMaxPerWake = ${typeof bad === 'string' ? bad : bad}\n`,
    );
    assert.equal(pluginModule.loadFreeTimeConfig({ tomlPath: file }).screenshotsMaxPerWake, 2, String(bad));
  }
});

test('★ 旧接口 fail-closed：[free_time] 里有它不认识的键 ⇒ 400、不写、不留备份', async () => {
  const dir = tempDir();
  const backupDir = path.join(dir, 'backups');
  // 用户通过配置页（逐键接口）写进去的提示词 —— 旧的整段接口不认识它。
  const original = [
    '[personality]',
    'name = "小鲸鱼"',
    '',
    '[free_time]',
    'enabled = true',
    'intervalHours = 2',
    'wakePrompt = "我自己的唤醒词"',
    '',
  ].join('\n');
  const tomlPath = writeFile(dir, 'qq-gugu.toml', original);
  const routes = pluginModule.createFreeTimeHttpRoutes({ tomlPath, backupDir });

  const res = await call(routes, 'free-time', 'POST', VALID);
  assert.equal(res.status, 400, res.body);
  assert.equal(res.json().ok, false);
  assert.match(res.json().error, /wakePrompt/, '必须点名是哪个键拦住了');
  assert.equal(fs.readFileSync(tomlPath, 'utf8'), original, '不许重写 —— 提示词不能这样被抹掉');
  assert.equal(fs.existsSync(backupDir), false, '被拒的写入连备份都不该做');
});

test('POST /free-time：错方法给 405', async () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', '');
  const routes = pluginModule.createFreeTimeHttpRoutes({ tomlPath });
  const res = makeRes();
  await routeOf(routes, 'free-time').handler(makeReq('GET').req, res);
  assert.equal(res.status, 405);
});

test('★ POST /reload：碰的是 mtime，返回带 warning，且**不 sleep**', async () => {
  const dir = tempDir();
  const entry = writeFile(dir, 'index.mjs', '// fake entry\n');
  const routes = pluginModule.createFreeTimeHttpRoutes({ tomlPath: path.join(dir, 'qq-gugu.toml'), entryPath: entry });

  const before = fs.statSync(entry).mtimeMs;
  await new Promise((r) => setTimeout(r, 30));
  const startedAt = Date.now();
  const res = await call(routes, 'reload', 'POST');
  const elapsed = Date.now() - startedAt;
  assert.equal(res.status, 200, res.body);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.touched, 'src/index.mjs');
  assert.ok(payload.note.includes('5 秒'));
  assert.ok(payload.warning.includes('掐断'), '风险必须带给 UI');
  assert.ok(elapsed < 1000, `不许 sleep，实际用了 ${elapsed}ms`);
  assert.notEqual(fs.statSync(entry).mtimeMs, before, 'mtime 必须真的变了（HMR 就靠这个）');
});

// ---------------------------------------------------------------- 接线与快照

test('★ 快照里有 freeTime（生效值），默认是 enabled:false', async () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', '[free_time]\nenabled = true\nintervalHours = 7\n');
  const snapPath = path.join(dir, 'snap.json');
  const prev = process.env.QQ_PROACTIVE_DEBUG_FILE;
  process.env.QQ_PROACTIVE_DEBUG_FILE = snapPath;
  const logs = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    llm: { stream: () => (async function* () { yield { type: 'text-delta', text: '[]' }; })() },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    inject: () => () => {},
    interval: () => () => {},
    setTimeout: () => ({ unref: () => {} }),
    on: () => () => {},
  };
  try {
    const handle = await pluginModule.apply(ctx, {
      mode: 'http',
      httpUrl: 'http://127.0.0.1:1',
      accessToken: 'x',
      actionTimeoutMs: 200,
      tomlPath,
      knowledgePath: path.join(dir, 'no-knowledge.json'),
    });
    await new Promise((r) => setTimeout(r, 30));
    handle.writeSnapshot(true);
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    assert.equal(snap.freeTime.enabled, true, '快照必须带出生效值（否则"没读到"与"关着"分不开）');
    assert.equal(snap.freeTime.intervalHours, 7);
    void logs;
  } finally {
    if (prev === undefined) delete process.env.QQ_PROACTIVE_DEBUG_FILE;
    else process.env.QQ_PROACTIVE_DEBUG_FILE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
