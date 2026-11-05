/**
 * 配置读写契约（2026-10-21）：`GET /settings` 与 `POST /config`。
 *
 * ## 这一组在钉什么
 *
 * 1. **GET 的四块**：`file`（文件里写的）/ `effective`（进程里生效的）/
 *    `owner`（用户的来源）/ `scopes` + `fields`（配置页渲染用）。
 * 2. **POST 的六条写盘规则**：
 *    ① 备份落**工作区**（不落 `<DSH_HOME>`）；
 *    ② 校验不过 ⇒ **一个字节都不写**（行号一起回）；
 *    ③ **只重写目标键**（其它行逐字节不变）；
 *    ④ 原子写；
 *    ⑤ 一律 `restartNeeded: true`；
 *    ⑥ 危险键要 `confirm: true`。
 * 3. **按 scope 写**：`group:<号>` / `private:<号>` 只写人格五段；
 *    写空串 = 清掉该覆盖（空 section 不留）。
 *
 * ⚠️ 全组在 `test/.tmp-configpage-*` 下现造 toml 与备份目录，
 * 不碰线上那份 `qq-gugu.toml`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pluginModule from '../src/index.mjs';
import { loadPersonaSections, personaForSession } from '../src/dsh/persona-sections.mjs';
import { loadOwnerConfig } from '../src/dsh/owner.mjs';
import { validateTomlText } from '../src/dsh/toml-edit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-configpage-';

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
    /* 收尾失败不影响测试结果 */
  }
});

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

const BASE_TOML = [
  '# 这是一份测试用的 qq-gugu.toml（注释必须原样保留）',
  '[personality]',
  'personality = """全局人格"""',
  'reply_style = """全局风格"""',
  'emotion_style = "全局情绪"',
  'interest = "全局兴趣"',
  'rules = """全局规矩"""',
  '',
  '[owner]',
  'admins = ["30000001"]',
  '',
  '[free_time]',
  'enabled = false',
  'intervalHours = 3',
  '',
  '[memory]',
  'learned_enabled = true',
  '',
].join('\n');

/** 造一套路由：toml + 备份目录都在临时目录里。 */
function makeRoutes({ toml = BASE_TOML, options = {}, withProcessPersona = false } = {}) {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', toml);
  const backupDir = path.join(dir, 'backups');
  const opts = { ...options };
  // 模拟"进程里已经重载过"：effective 用同一份文件算出来的那份。
  if (withProcessPersona) opts.personaSections = loadPersonaSections({ tomlPath });
  const routes = pluginModule.createFreeTimeHttpRoutes({
    tomlPath,
    backupDir,
    allowFrom: ['30000001'],
    groupAllowFrom: ['30000013'],
    ...opts,
  });
  return { dir, tomlPath, backupDir, routes };
}

// ---------------------------------------------------------------- GET /settings

test('GET /settings：契约字段齐全（file / effective / owner / scopes / fields）', async () => {
  const { tomlPath, routes } = makeRoutes();
  const res = await call(routes, 'settings', 'GET');
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.tomlPath, tomlPath);
  assert.equal(typeof payload.file, 'object');
  assert.equal(typeof payload.effective, 'object');
  assert.deepEqual(payload.owner, { admins: ['30000001'], source: 'owner' });
  assert.ok(Array.isArray(payload.scopes));
  assert.ok(Array.isArray(payload.fields));
});

test('GET /settings：保留旧键 file.freeTime / file.memory（向后兼容）', async () => {
  const { routes } = makeRoutes();
  const payload = (await call(routes, 'settings', 'GET')).json();
  assert.equal(payload.file.freeTime.enabled, false);
  assert.equal(payload.file.memory.learnedEnabled, true);
  assert.deepEqual(payload.file.personality.persona, '全局人格');
  assert.deepEqual(payload.file.owner.admins, ['30000001']);
});

test('GET /settings：owner 回退 allowFrom（文件没有 [owner] 时）', async () => {
  const toml = '[personality]\npersonality = "x"\n';
  const { routes } = makeRoutes({ toml, options: { allowFrom: ['424242'] } });
  const payload = (await call(routes, 'settings', 'GET')).json();
  assert.deepEqual(payload.owner, { admins: [], source: 'allowFrom' });
});

test('★ GET /settings：人格五段都是 multiline（情绪特征 / 兴趣不再是单行）', async () => {
  const { routes } = makeRoutes();
  const payload = (await call(routes, 'settings', 'GET')).json();
  const globals = new Map(
    payload.fields.filter((field) => field.scope === 'global').map((field) => [field.key, field]),
  );
  for (const key of ['persona', 'reply_style', 'emotion_style', 'interest', 'rules']) {
    assert.ok(globals.has(key), `缺字段 ${key}`);
    assert.equal(globals.get(key).type, 'multiline', `${key} 应是多行`);
  }
});

test('★ GET /settings：scopes 第一项是 global（精确形状）', async () => {
  const { routes } = makeRoutes();
  const payload = (await call(routes, 'settings', 'GET')).json();
  assert.deepEqual(payload.scopes[0], {
    id: 'global',
    kind: 'global',
    name: '全局',
    idText: '基准值',
    overridden: [],
  });
});

test('★ GET /settings：私聊/群 scope 的名字来自昵称表与群名缓存，缺了就是空串', async () => {
  const toml = [
    '[personality]',
    'personality = """全局人格"""',
    '',
    '[personality.groups."30000013"]',
    'rules = """群规"""',
    '',
    '[personality.privates."30000001"]',
    'reply_style = """私聊风格"""',
    '',
    '[personality.groups."111111111"]',
    'rules = """没名字的群"""',
    '',
  ].join('\n');
  const { routes } = makeRoutes({
    toml,
    options: {
      allowFrom: ['30000001'],
      groupAllowFrom: ['30000013', '111111111'],
      nicknames: { resolve: (qq) => (String(qq) === '30000001' ? '用户' : '') },
      groupNames: { get: (gid) => (String(gid) === '30000013' ? '示例群' : ''), ensure: async () => 0 },
    },
  });
  const payload = (await call(routes, 'settings', 'GET')).json();
  const priv = payload.scopes.find((s) => s.id === 'private:30000001');
  assert.deepEqual(priv, {
    id: 'private:30000001',
    kind: 'private',
    name: '用户',
    idText: 'QQ 30000001',
    overridden: ['reply_style'],
  });
  const group = payload.scopes.find((s) => s.id === 'group:30000013');
  assert.deepEqual(group, {
    id: 'group:30000013',
    kind: 'group',
    name: '示例群',
    idText: 'QQ群30000013',
    overridden: ['rules'],
  });
  const anonymous = payload.scopes.find((s) => s.id === 'group:111111111');
  assert.equal(anonymous.name, '', '取不到群名 ⇒ 空串，前端回退显示号码');
});

test('GET /settings：fields 覆盖全局字段（value 为 null = 文件里没写）', async () => {
  const { routes } = makeRoutes({
    options: { effective: { personality: { rules: '进程里的规矩' } } },
  });
  const payload = (await call(routes, 'settings', 'GET')).json();
  const rules = payload.fields.find((f) => f.key === 'rules' && f.scope === 'global');
  assert.equal(rules.section, 'personality');
  assert.equal(rules.type, 'multiline');
  assert.equal(rules.value, '全局规矩');
  assert.equal(rules.effective, '进程里的规矩', 'effective 来自进程里那一份');
  // `[mood]` 段不存在 ⇒ 文件里没写
  const mood = payload.fields.find((f) => f.key === 'mood.enabled' && f.scope === 'global');
  assert.equal(mood.value, null);
  assert.equal(mood.effective, true, '没写 ⇒ 生效值是默认值');
  // 每个字段都有契约里的五个键
  for (const field of payload.fields) {
    assert.equal(typeof field.key, 'string');
    assert.equal(typeof field.section, 'string');
    assert.equal(typeof field.scope, 'string');
    assert.ok(['text', 'number', 'bool', 'enum', 'array', 'multiline'].includes(field.type));
    assert.ok(Object.hasOwn(field, 'value'));
    assert.ok(Object.hasOwn(field, 'effective'));
  }
});

test('GET /settings：覆盖 scope 的 fields 只有人格五段，value/effective 分开', async () => {
  const toml = [
    '[personality]',
    'personality = """全局人格"""',
    '',
    '[personality.groups."30000013"]',
    'rules = """群规"""',
    '',
  ].join('\n');
  const { routes } = makeRoutes({ toml, withProcessPersona: true });
  const payload = (await call(routes, 'settings', 'GET')).json();
  const scoped = payload.fields.filter((f) => f.scope === 'group:30000013');
  assert.deepEqual(scoped.map((f) => f.key), [
    'persona', 'relations', 'reply_style', 'emotion_style', 'interest',
    'chat_sense', 'ai_flavor', 'examples', 'rules',
  ]);
  const rules = scoped.find((f) => f.key === 'rules');
  assert.equal(rules.value, '群规');
  assert.equal(rules.effective, '群规', '生效值 = 全局 + 覆盖层合并之后的值');
  const personality = scoped.find((f) => f.key === 'persona');
  assert.equal(personality.value, null, '没写 ⇒ null（继承全局）');
  assert.equal(personality.effective, '全局人格');
});

test('GET /settings：错方法给 405', async () => {
  const { routes } = makeRoutes();
  const res = await call(routes, 'settings', 'POST', {});
  assert.equal(res.status, 405);
});

// ---------------------------------------------------------------- POST /config

test('★ POST /config：admins 是危险键 ⇒ 不带 confirm 一律拒绝', async () => {
  const { tomlPath, backupDir, routes } = makeRoutes();
  const before = fs.readFileSync(tomlPath, 'utf8');
  const res = await call(routes, 'config', 'POST', {
    scope: 'global',
    key: 'admins',
    value: '900,901',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json(), { ok: false, error: '需要二次确认' });
  assert.equal(fs.readFileSync(tomlPath, 'utf8'), before, '被拒的写入不许碰文件');
  assert.equal(fs.existsSync(backupDir), false, '被拒的写入也不该留备份');
});

test('★ POST /config：不在目录里的危险键同样先要 confirm（allowFrom / provider）', async () => {
  const { routes } = makeRoutes();
  for (const key of ['allowFrom', 'groupAllowFrom', 'provider', 'model']) {
    const res = await call(routes, 'config', 'POST', { scope: 'global', key, value: 'x' });
    assert.equal(res.status, 400, key);
    assert.equal(res.json().error, '需要二次确认', key);
  }
});

test('★ POST /config：写 admins（带 confirm）⇒ 只改 [owner]，备份落工作区', async () => {
  const { tomlPath, backupDir, routes } = makeRoutes();
  const before = fs.readFileSync(tomlPath, 'utf8');
  const res = await call(routes, 'config', 'POST', {
    scope: 'global',
    key: 'admins',
    value: ['30000001', '900'],
    confirm: true,
  });
  assert.equal(res.status, 200, res.body);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.wrote, true);
  assert.equal(payload.key, 'admins');
  assert.equal(payload.scope, 'global');
  assert.equal(payload.restartNeeded, true);
  assert.equal(path.dirname(payload.backup), backupDir, '备份必须落在工作区（这里注入的目录）');
  assert.equal(fs.readFileSync(payload.backup, 'utf8'), before, '备份是改动前的原文');

  assert.deepEqual(loadOwnerConfig({ tomlPath }), {
    admins: ['30000001', '900'],
    source: 'owner',
    qq: '30000001',
  });
  // 备份**不在** toml 旁边
  const beside = fs.readdirSync(path.dirname(tomlPath)).filter((n) => n.includes('.bak-'));
  assert.deepEqual(beside, [], '不往 toml 目录写备份');
});

test('★ POST /config：只重写目标键，其它行逐字节不变', async () => {
  const { tomlPath, routes } = makeRoutes();
  const before = fs.readFileSync(tomlPath, 'utf8');
  const res = await call(routes, 'config', 'POST', {
    scope: 'global',
    key: 'rules',
    value: '新的规矩',
  });
  assert.equal(res.status, 200, res.body);
  const after = fs.readFileSync(tomlPath, 'utf8');
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  assert.equal(afterLines.length, beforeLines.length, '行数不该变');
  const changed = beforeLines
    .map((line, index) => (line === afterLines[index] ? -1 : index))
    .filter((index) => index >= 0);
  assert.equal(changed.length, 1, `只有目标行该变，实际变了 ${changed.length} 行`);
  assert.equal(afterLines[changed[0]], 'rules = "新的规矩"');
});

test('POST /config：写 free_time.enabled 只改那一行（同段别的键不动）', async () => {
  const { tomlPath, routes } = makeRoutes();
  const res = await call(routes, 'config', 'POST', {
    scope: 'global',
    key: 'free_time.enabled',
    value: true,
  });
  assert.equal(res.status, 200, res.body);
  const after = fs.readFileSync(tomlPath, 'utf8');
  assert.ok(after.includes('[free_time]\nenabled = true\nintervalHours = 3\n'));
  assert.deepEqual(pluginModule.loadFreeTimeConfig({ tomlPath }), {
    enabled: true,
    intervalHours: 3,
    // 2026-10-23：短追问间隔（BASE_TOML 里没写 ⇒ 默认 10 分钟）
    followupMinutes: 10,
    windowStartHour: 9,
    windowEndHour: 24,
    tokenBudgetPerTurn: 20000,
    quietWhenNothing: true,
    // 2026-10-21：截图两个键（BASE_TOML 里没写 ⇒ 默认值）
    screenshots: true,
    screenshotsKeep: 2,
    // 2026-10-29：投喂张数与两段提示词（BASE_TOML 里没写 ⇒ 默认值）
    screenshotsMaxPerWake: 2,
    wakePrompt: '',
    followupPrompt: '',
  });
});

test('★ POST /config：写 free_time.wakePrompt ⇒ 多行文本逐字节存下去、读回来一模一样', async () => {
  // 这是"提示词搬进配置页"的那条关键链路：**逐键接口 + 多行文本 + 任意字符**。
  // 用户填的东西里会有中文引号、`$`（含 `$&` / `` $` `` 这类 replacement 元字符）、
  // 反斜杠、换行 —— 一个字都不许丢，也不许被展开。
  const { tomlPath, routes } = makeRoutes();
  const promptText = [
    '【她自己的时间·改】',
    '这一轮大约 {{budget}} token，自己看着办。',
    '中文引号：“别删”、单引号：‘也别改’；美元 $& 与 $` 与 $1 与 $$ 都是字面。',
    '反斜杠 C:\\tmp\\a 与 \\n 两个字面字符。',
  ].join('\n');

  const res = await call(routes, 'config', 'POST', {
    scope: 'global',
    key: 'free_time.wakePrompt',
    value: promptText,
  });
  assert.equal(res.status, 200, res.body);
  const payload = res.json();
  assert.equal(payload.wrote, true);
  assert.equal(typeof payload.backup, 'string');
  assert.ok(payload.backup.length > 0, '写入必须留备份');

  // ① 读回来一字不差（`loadFreeTimeConfig` 走的是同一份 parseToml）
  assert.equal(pluginModule.loadFreeTimeConfig({ tomlPath }).wakePrompt, promptText);

  // ② 文件里其它行没被碰：`[free_time]` 里原有的 enabled / intervalHours 还在
  const after = fs.readFileSync(tomlPath, 'utf8');
  assert.ok(after.includes('enabled = true'), '同段别的键不许被动');
  assert.ok(after.includes('intervalHours = 3'), '同段别的键不许被动');

  // ③ 再写一次同样的值 ⇒ wrote:false（值没变不写文件）
  const again = await call(routes, 'config', 'POST', {
    scope: 'global',
    key: 'free_time.wakePrompt',
    value: promptText,
  });
  assert.equal(again.status, 200, again.body);
  assert.equal(again.json().wrote, false);

  // ④ 清空（写空串）⇒ 回到"用内置文案"，且读得回来
  const cleared = await call(routes, 'config', 'POST', {
    scope: 'global',
    key: 'free_time.wakePrompt',
    value: '',
  });
  assert.equal(cleared.status, 200, cleared.body);
  assert.equal(pluginModule.loadFreeTimeConfig({ tomlPath }).wakePrompt, '');
});

test('★ POST /config：TOML 非法 ⇒ 不写，回 "TOML 校验未通过" + 行号', async () => {
  const broken = [
    '[personality]',
    'rules = """全局规矩"""',
    '这一行既不是段头也不是键值对',
    '',
  ].join('\n');
  const { tomlPath, backupDir, routes } = makeRoutes({ toml: broken });
  const before = fs.readFileSync(tomlPath, 'utf8');
  const res = await call(routes, 'config', 'POST', {
    scope: 'global',
    key: 'rules',
    value: '新值',
  });
  assert.equal(res.status, 400);
  const payload = res.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'TOML 校验未通过');
  assert.equal(typeof payload.line, 'number', '行号必须回给调用方');
  assert.equal(fs.readFileSync(tomlPath, 'utf8'), before, '校验不过 ⇒ 一个字节都不写');
  const leftovers = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
  assert.deepEqual(leftovers, [], '被拒的写入不该留备份');
});

test('POST /config：未知字段 / 非法 scope 都拒绝，且不碰文件', async () => {
  const { tomlPath, routes } = makeRoutes();
  const before = fs.readFileSync(tomlPath, 'utf8');

  let res = await call(routes, 'config', 'POST', { scope: 'global', key: 'no_such_key', value: 1 });
  assert.equal(res.status, 400);
  assert.match(res.json().error, /未知字段/);

  res = await call(routes, 'config', 'POST', { scope: 'everywhere', key: 'rules', value: 'x' });
  assert.equal(res.status, 400);
  assert.match(res.json().error, /scope/);

  assert.equal(fs.readFileSync(tomlPath, 'utf8'), before);
});

test('POST /config：只有人格五段支持按会话覆盖', async () => {
  const { tomlPath, routes } = makeRoutes();
  const before = fs.readFileSync(tomlPath, 'utf8');
  const res = await call(routes, 'config', 'POST', {
    scope: 'group:30000013',
    key: 'free_time.enabled',
    value: true,
  });
  assert.equal(res.status, 400);
  assert.equal(res.json().error, '只有人格五段支持按会话覆盖');
  assert.equal(fs.readFileSync(tomlPath, 'utf8'), before);
});

test('★ POST /config：写群覆盖 ⇒ 新建 [personality.groups."<号>"] 段，合并读得回来', async () => {
  const { tomlPath, routes } = makeRoutes();
  const res = await call(routes, 'config', 'POST', {
    scope: 'group:30000013',
    key: 'rules',
    value: '这个群专用的硬规矩',
  });
  assert.equal(res.status, 200, res.body);
  const after = fs.readFileSync(tomlPath, 'utf8');
  assert.ok(after.includes('[personality.groups."30000013"]'), after);
  const sections = loadPersonaSections({ tomlPath });
  const merged = personaForSession(sections, 'qq-group-30000013');
  assert.deepEqual(merged.overridden, ['rules']);
  assert.equal(merged.fields.rules, '这个群专用的硬规矩');
  assert.equal(merged.fields.persona, '全局人格');
});

test('POST /config：写私聊覆盖', async () => {
  const { tomlPath, routes } = makeRoutes();
  const res = await call(routes, 'config', 'POST', {
    scope: 'private:30000001',
    key: 'reply_style',
    value: '私聊风格',
  });
  assert.equal(res.status, 200, res.body);
  const merged = personaForSession(loadPersonaSections({ tomlPath }), 'qq-private-30000001');
  assert.deepEqual(merged.overridden, ['reply_style']);
  assert.equal(merged.fields.reply_style, '私聊风格');
});

test('★ POST /config：覆盖层写空串 = 清掉该字段（空 section 不留下）', async () => {
  const toml = [
    '[personality]',
    'personality = """全局人格"""',
    'rules = """全局规矩"""',
    '',
    '[personality.groups."30000013"]',
    'rules = """群规"""',
    '',
    '[memory]',
    'learned_enabled = true',
    '',
  ].join('\n');
  const { tomlPath, routes } = makeRoutes({ toml });
  const res = await call(routes, 'config', 'POST', {
    scope: 'group:30000013',
    key: 'rules',
    value: '',
  });
  assert.equal(res.status, 200, res.body);
  const after = fs.readFileSync(tomlPath, 'utf8');
  assert.equal(after.includes('personality.groups'), false, '空段必须一起删掉');
  assert.equal(after.includes('[memory]'), true, '别的段原样保留');
  assert.equal(personaForSession(loadPersonaSections({ tomlPath }), 'qq-group-30000013'), null);
});

test('POST /config：值没变 ⇒ wrote:false，不备份、不碰文件', async () => {
  const { tomlPath, backupDir, routes } = makeRoutes();
  const before = fs.readFileSync(tomlPath, 'utf8');
  const res = await call(routes, 'config', 'POST', { scope: 'global', key: 'rules', value: '全局规矩' });
  assert.equal(res.status, 200, res.body);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.wrote, false);
  assert.equal(payload.backup, '');
  assert.equal(payload.restartNeeded, true);
  assert.equal(fs.readFileSync(tomlPath, 'utf8'), before);
  assert.equal(fs.existsSync(backupDir), false);
});

test('POST /config：值类型不对 ⇒ 400，不写', async () => {
  const { tomlPath, routes } = makeRoutes();
  const before = fs.readFileSync(tomlPath, 'utf8');
  const bad = [
    { key: 'free_time.intervalHours', value: '不是数字' },
    { key: 'free_time.enabled', value: 'yes' },
    { key: 'proactive.judge_mode', value: '不存在的模式' },
    { key: 'admins', value: 'abc', confirm: true },
    // `null` 不当空串：界面把 fields[].value（未写 = null）原样回传时不能清配置。
    { key: 'rules', value: null },
    { key: 'rules', value: undefined },
  ];
  for (const item of bad) {
    const res = await call(routes, 'config', 'POST', { scope: 'global', ...item });
    assert.equal(res.status, 400, JSON.stringify(item));
    assert.equal(res.json().ok, false, JSON.stringify(item));
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), before);
  }
});

test('POST /config：写完之后全文仍能通过 TOML 结构校验', async () => {
  const { tomlPath, routes } = makeRoutes();
  await call(routes, 'config', 'POST', { scope: 'global', key: 'persona', value: '多行\n第二行' });
  const after = fs.readFileSync(tomlPath, 'utf8');
  assert.deepEqual(validateTomlText(after), { ok: true });
  assert.equal(loadPersonaSections({ tomlPath }).global.persona, '多行\n第二行');
});

// ------------------------------------------------- effective：进程里那一份（2026-10-21 线上 bug）

/**
 * 造"进程里那一份"：**走 `resolveConfig`** ⇒ `tomlPath` 由它填。
 *
 * 这正是修复点：`loadPersonaSections()` 与 `loadOwnerConfig()` **只认
 * `config.tomlPath`**（不硬编码部署路径）。以前 `resolveConfig` 不填它 ⇒ 两个 loader
 * 静默读空 ⇒ `/settings` 的 `effective.personality` 五段恒为空 ⇒ 配置页把
 * "她一直在用的人格"全标成「未生效（重载后生效）」。
 */
function processFromToml(tomlPath) {
  const raw = {
    mode: 'reverse',
    accessToken: 't',
    allowFrom: ['30000001'],
    groupAllowFrom: ['30000013'],
  };
  // `tomlPath: null` = **不给**（模拟线上：`cordis.patch.yml` 里没有这个键，
  // 路径只能由 `resolveConfig` 的默认值/环境变量决定）—— 这正是 bug 的形状。
  if (tomlPath !== null && tomlPath !== undefined) raw.tomlPath = tomlPath;
  const config = pluginModule.resolveConfig(raw);
  return {
    config,
    personaSections: loadPersonaSections(config),
    ownerCfg: loadOwnerConfig(config),
    judgeMode: pluginModule.loadProactiveConfig(config).config.judge_mode ?? 'heuristic',
  };
}

/**
 * 用"进程里那一份"造一套路由 —— 与 `apply()` 里那段 `createFreeTimeHttpRoutes` 同形。
 * （`makeRoutes({withProcessPersona})` 直接 `loadPersonaSections({tomlPath})`，
 *   绕过了 `resolveConfig`，所以它抓不到这次的 bug。）
 */
function makeLiveRoutes({ toml = BASE_TOML, viaDefaultPath = false } = {}) {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', toml);
  // `viaDefaultPath`：**别在 raw config 里写 tomlPath**，改由 `QQ_GUGU_TOML`
  // 影响 `defaultTomlPath()` —— 与线上（patch 里没有 tomlPath）同一条代码路径。
  // ⚠️ 环境变量只在**同步**建路由期间生效，此后立刻还原：中间没有 await，
  //    所以不会串到别的测试（同进程跑全套）。
  const hadEnv = process.env.QQ_GUGU_TOML;
  let proc;
  try {
    if (viaDefaultPath) process.env.QQ_GUGU_TOML = tomlPath;
    proc = processFromToml(viaDefaultPath ? null : tomlPath);
  } finally {
    if (hadEnv === undefined) delete process.env.QQ_GUGU_TOML;
    else process.env.QQ_GUGU_TOML = hadEnv;
  }
  const freeTimeCfg = pluginModule.loadFreeTimeConfig(proc.config);
  const memoryCfg = pluginModule.loadLearnedMemoryConfig(proc.config);
  const routes = pluginModule.createFreeTimeHttpRoutes({
    tomlPath,
    backupDir: path.join(dir, 'backups'),
    freeTimeCfg,
    memoryCfg,
    ownerCfg: proc.ownerCfg,
    personaSections: proc.personaSections,
    effective: {
      personality: proc.personaSections.global,
      owner: { admins: proc.ownerCfg.admins },
      freeTime: freeTimeCfg,
      memory: memoryCfg,
      send: pluginModule.loadSendConfig(proc.config),
      mood: pluginModule.loadMoodConfig(proc.config),
      proactive: { judge_mode: proc.judgeMode },
    },
    allowFrom: ['30000001'],
    groupAllowFrom: ['30000013'],
  });
  return { dir, tomlPath, proc, routes };
}

/** 与客户端 `sameFieldValue` 同口径的最简版（标量/数组都够用）。 */
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

test('★ resolveConfig：tomlPath 由它填好（人格 / 用户两个 loader 只认这个键）', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', BASE_TOML);

  const config = pluginModule.resolveConfig({ mode: 'reverse', accessToken: 't', tomlPath });
  assert.equal(config.tomlPath, tomlPath, '显式给的路径必须原样带出来');

  const bare = pluginModule.resolveConfig({ mode: 'reverse', accessToken: 't' });
  assert.equal(typeof bare.tomlPath, 'string');
  assert.ok(
    bare.tomlPath.endsWith('qq-gugu.toml'),
    '默认值要指向 qq-gugu.toml，得到 ' + String(bare.tomlPath),
  );

  // 两个"只认 config.tomlPath"的 loader：路径空 ⇒ 静默读空（这就是那段线上 bug）
  const sections = loadPersonaSections(config);
  assert.equal(sections.fromToml, true, 'resolveConfig 给的路径必须让 loadPersonaSections 真读到文件');
  assert.equal(sections.global.persona, '全局人格');
  assert.deepEqual(loadOwnerConfig(config).admins, ['30000001'], '用户段也读得到');
});

test('★ GET /settings：effective.personality 五段 = file 且非空（没改过 ⇒ 一条红字都不该有）', async () => {
  const { routes } = makeLiveRoutes({ viaDefaultPath: true });
  const payload = (await call(routes, 'settings', 'GET')).json();

  for (const key of ['persona', 'reply_style', 'emotion_style', 'interest', 'rules']) {
    assert.notEqual(payload.file.personality[key], '', 'file.' + key + ' 这份 toml 里有值');
    assert.equal(
      payload.effective.personality[key],
      payload.file.personality[key],
      'effective.' + key + ' 必须与 file 相同',
    );
    assert.notEqual(
      payload.effective.personality[key],
      '',
      'effective.' + key + ' 不许是空串（线上 bug 就是这五段一起空）',
    );
  }

  // 客户端红字只看 fields[].value / .effective：没改过 ⇒ "文件里写了"的 key 必须逐条一致
  for (const field of payload.fields.filter((f) => f.scope === 'global')) {
    if (field.value === null) continue; // 文件里没写：客户端不算"未生效"（口径保留）
    assert.deepEqual(field.effective, field.value, '未改过时 ' + field.key + ' 不该打「未生效」');
  }
});

test('★ 改一个字段（不重载）⇒ 只有那一个 key 的 file ≠ effective', async () => {
  const { routes } = makeLiveRoutes({ viaDefaultPath: true });
  const before = (await call(routes, 'settings', 'GET')).json();
  assert.equal(before.effective.personality.reply_style, '全局风格');

  // 只写文件、**不重载**（POST /config 一律 restartNeeded:true，不假装生效）
  const res = await call(routes, 'config', 'POST', {
    scope: 'global',
    key: 'reply_style',
    value: '改过但还没重载的风格',
  });
  assert.equal(res.status, 200, res.body);

  const after = (await call(routes, 'settings', 'GET')).json();
  assert.equal(after.file.personality.reply_style, '改过但还没重载的风格', '文件里是新值');
  assert.equal(after.effective.personality.reply_style, '全局风格', '进程里还是旧值');

  const diffs = after.fields
    .filter((f) => f.scope === 'global' && f.value !== null)
    .filter((f) => !sameValue(f.value, f.effective))
    .map((f) => f.key);
  assert.deepEqual(diffs, ['reply_style'], '只许那一个 key 显示「未生效」');

  // 其余四段人格一点都不许受牵连（线上 bug 是五段一起红）
  for (const key of ['persona', 'emotion_style', 'interest', 'rules']) {
    assert.equal(after.effective.personality[key], after.file.personality[key], key + ' 不该变');
  }
});

test('★ GET /settings：groups / privates 覆盖层的 effective 也来自进程里那份人格', async () => {
  const tomlV1 = [
    BASE_TOML,
    '',
    '[personality.groups."30000013"]',
    'rules = """群规 V1"""',
    '',
    '[personality.privates."30000001"]',
    'reply_style = """私聊 V1"""',
    '',
  ].join('\n');
  const { tomlPath, proc, routes } = makeLiveRoutes({ toml: tomlV1, viaDefaultPath: true });

  // 磁盘上把两份覆盖都改掉，**不重载**（进程里仍是 V1）
  fs.writeFileSync(
    tomlPath,
    tomlV1.split('群规 V1').join('群规 V2').split('私聊 V1').join('私聊 V2'),
    'utf8',
  );

  const payload = (await call(routes, 'settings', 'GET')).json();
  const groupRules = payload.fields.find((f) => f.key === 'rules' && f.scope === 'group:30000013');
  assert.equal(groupRules.value, '群规 V2', 'value = 文件里现在写的');
  assert.equal(groupRules.effective, '群规 V1', 'effective = 进程里那份（未重载）');

  const privStyle = payload.fields.find((f) => f.key === 'reply_style' && f.scope === 'private:30000001');
  assert.equal(privStyle.value, '私聊 V2');
  assert.equal(privStyle.effective, '私聊 V1');

  // 覆盖层没写的字段 = 继承基准值：value 为 null ⇒ 客户端**不打红字**（口径保留）
  const inherited = payload.fields.find((f) => f.key === 'persona' && f.scope === 'group:30000013');
  assert.equal(inherited.value, null, '覆盖层没写 ⇒ null');
  assert.equal(inherited.effective, '全局人格', 'null 的生效值就是基准人格');

  // 覆盖层的 effective 必须等于"进程里那份"用同一个合并函数算出来的值
  const merged = personaForSession(proc.personaSections, 'qq-group-30000013').fields;
  for (const key of ['persona', 'reply_style', 'emotion_style', 'interest', 'rules']) {
    const field = payload.fields.find((f) => f.key === key && f.scope === 'group:30000013');
    assert.equal(field.effective, merged[key], '覆盖层 ' + key + ' 的 effective 必须是同一个合并结果');
  }
});

test('★ 其它段（owner / free_time / memory / send / mood / proactive）也是同一个 tomlPath', async () => {
  // 这组钉的是"别每段一套"：所有段的生效值都从**同一个** `config.tomlPath` 读。
  // `[owner]` 与 `[personality]` 是这次出事的两段（只有"路径"一个来源），
  // 其余段各自有 `?? defaultTomlPath()` 兜着 —— 现在统一由 resolveConfig 定。
  const fullToml = [
    BASE_TOML,
    '',
    '[send]',
    'rule = """发 QQ 的规矩"""',
    '',
    '[mood]',
    'enabled = true',
    'provider = "p-test"',
    'model = "m-test"',
    '',
    '[proactive]',
    'judge_mode = "precheck"',
    '',
  ].join('\n');
  const { routes } = makeLiveRoutes({ toml: fullToml, viaDefaultPath: true });
  const payload = (await call(routes, 'settings', 'GET')).json();

  assert.deepEqual(payload.effective.owner.admins, ['30000001'], '用户段读到同一个 toml');
  assert.equal(payload.effective.send.rule, '发 QQ 的规矩');
  assert.deepEqual(payload.effective.mood, payload.file.mood, '心情段：进程里那份 = 文件里那份');
  assert.equal(payload.effective.mood.provider, 'p-test');
  assert.deepEqual(payload.effective.freeTime, payload.file.freeTime);
  assert.deepEqual(payload.effective.memory, payload.file.memory);

  const judge = payload.fields.find((f) => f.key === 'proactive.judge_mode' && f.scope === 'global');
  assert.equal(judge.value, 'precheck');
  assert.equal(judge.effective, 'precheck', '判定模式也走同一个路径（loadProactiveConfig）');

  // 全都没有"未生效"：一个字节没改过 ⇒ 一条红字都不该有
  const diffs = payload.fields
    .filter((f) => f.scope === 'global' && f.value !== null)
    .filter((f) => !sameValue(f.value, f.effective))
    .map((f) => f.key);
  assert.deepEqual(diffs, [], '没改过时任何一段都不该显示「未生效」');
});

test('POST /config：错方法给 405', async () => {
  const { routes } = makeRoutes();
  const res = await call(routes, 'config', 'GET');
  assert.equal(res.status, 405);
});

// ---------------------------------------------------------------- POST /reload

/**
 * 这一组钉的是「重载插件」按钮的宿主半：**只碰 mtime，不碰内容**。
 *
 * 为什么它必须存在：配置页写入后**不会自动重载**（重载会 dispose 小鲸鱼的 agent，
 * 掐断正在说的那一轮），所以"保存"与"让它生效"是两步。旧界面有一个「重载」标签页，
 * 搬成独立网页后按钮丢了 —— 这条路由就是那个按钮的服务端入口。
 *
 * ⚠️ `entryPath` 在这里指向临时文件，而不是真的 `src/index.mjs`：
 * 测试若碰了真入口的 mtime，就会**在测试过程中把插件热重载掉**。
 */
test('POST /reload：只把 entryPath 的 mtime 推到现在，内容一个字节不变', async () => {
  const dir = tempDir();
  const entry = path.join(dir, 'entry.mjs');
  const body = 'export const marker = 1;\n';
  fs.writeFileSync(entry, body, 'utf8');
  // 把 mtime 拨回一分钟前，否则"推到现在"与"本来就是现在"分不出来。
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(entry, old, old);

  const { routes } = makeRoutes({ options: { entryPath: entry } });
  const res = await call(routes, 'reload', 'POST');

  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.note, 'string');
  // 风险必须随响应带出来：UI 有责任在点之前就把"会掐断这一轮"讲清楚。
  assert.match(payload.warning, /掐断/);

  const after = fs.statSync(entry);
  assert.ok(after.mtimeMs > old.getTime() + 1000, 'mtime 被推到现在');
  assert.equal(fs.readFileSync(entry, 'utf8'), body, '内容原样（否则就不是"碰一下"了）');
});

test('POST /reload：GET 给 405（只接受 POST）', async () => {
  const { routes } = makeRoutes();
  const res = await call(routes, 'reload', 'GET');
  assert.equal(res.status, 405);
});

test('POST /reload：entryPath 不可写时回 500 并带原因（不吞错误）', async () => {
  const ghost = path.join(tempDir(), 'missing.mjs');
  const { routes } = makeRoutes({ options: { entryPath: ghost } });
  const res = await call(routes, 'reload', 'POST');
  assert.equal(res.status, 500);
  const payload = res.json();
  assert.equal(payload.ok, false);
  assert.match(payload.error, /触碰/);
});
