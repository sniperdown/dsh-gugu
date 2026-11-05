/**
 * 小鲸鱼的**推理等级**（`[agent] reasoning`）—— 2026-10-21。
 *
 * ## 为什么要这一组
 *
 * 用户原话：「插件应当有一个能改小鲸鱼推理等级的地方，我发现现在会默认给小鲸鱼 low，
 * 确实是我之前的决定，不过我想法有变化」。
 *
 * 这一项原来**只**写在 profile 的 `cordis.patch.yml`（`- id: qq-proactive` →
 * `reasoningEffort: low`），插件配置页看不到、也改不了。这次把它搬进
 * `qq-gugu.toml` 的 `[agent] reasoning`，并在配置页给一个下拉。
 *
 * ## 这一组钉住的五件事（对应验收的五条）
 *
 * 1. **读配置覆盖**：toml 写了 `high` ⇒ `agentOptions.reasoningEffort === 'high'`
 *    （一直走到 `apply()` 里那个 binder，不是只测纯函数）；
 * 2. **缺省回落 low**：`[agent]` 整段不存在 ⇒ 仍然是 `low`（= 改动前的行为，不许偷偷换档）；
 * 3. **非法值有明确口径**：夹到 `low` **并 warn**（不静默、也不拒绝加载）；
 *    合法取值是**查证过的** `off/low/high/max` —— 这条路由的源码枚举里**没有 medium**；
 * 4. **快照可观测**：`snapshot.agent = {reasoning, source}`；
 * 5. **配置页能列出/能改**：`CONFIG_FIELDS` 里有它（`enum`），`POST /config` 写得进去。
 *
 * ⚠️ 临时 toml 落在**工作区内**（`test/.tmp-agent-*`），不用 `os.tmpdir()` ——
 *    受限沙箱里 `%TEMP%` 会被挡，`mkdtempSync` 直接 EPERM（同 `mood-config.test.mjs`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pluginModule from '../src/index.mjs';
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_VALUES,
  loadAgentConfig,
  normalizeAgentConfig,
} from '../src/dsh/agent-config.mjs';
import { CONFIG_FIELDS, coerceFieldValue, fileFieldValue } from '../src/dsh/config-fields.mjs';
import { buildSnapshot } from '../src/dsh/debug-snapshot.mjs';
import { SessionBinder } from '../src/dsh/binding.mjs';
import { parseToml } from '../src/dsh/toml.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-agent-';

function tempDir() {
  return fs.mkdtempSync(path.join(HERE, PREFIX));
}

/** 写一份临时 toml（只含被测的段），返回路径。 */
function tempToml(body) {
  const dir = tempDir();
  const file = path.join(dir, 'qq-gugu.toml');
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

/** 收日志的 log：`[级别, 文案, meta]`。 */
function collectingLog() {
  const entries = [];
  const log = (level, message, meta) => entries.push({ level, message, meta });
  return { entries, log };
}

// ---------------------------------------------------------------- ① 合法取值（查证过的）

test('★ 合法取值 = off / low / high / max（查证自 dsh-llm-deepseek 的源码枚举）', () => {
  // 出处（两处必须一致，缺一不可）：
  //   node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:321-326
  //     reasoningEffort: z.union(["off","low","high","max"])
  //   同文件 :465-485  REASONING_EFFORTS = [off, low, high, max]
  // ⇒ **没有 medium**：给这条路由传 medium 不会降级，而是每次调用都抛
  //   UNSUPPORTED_REASONING_EFFORT（那一轮就没有任何回复）。
  assert.deepEqual([...REASONING_EFFORT_VALUES], ['off', 'low', 'high', 'max']);
  assert.equal(DEFAULT_REASONING_EFFORT, 'low', '缺省必须还是 low（= 改动前的行为）');
  assert.ok(!REASONING_EFFORT_VALUES.includes('medium'), 'medium 在这条路由上不合法，不许列出来');
});

// ---------------------------------------------------------------- ② 读配置 / 缺省

test('★ [agent] reasoning = "high" ⇒ 生效值 high（source: config）', () => {
  const tomlPath = tempToml('[personality]\npersonality = "x"\n\n[agent]\nreasoning = "high"\n');
  assert.deepEqual(loadAgentConfig({ tomlPath, reasoningEffort: 'low' }), {
    reasoning: 'high',
    source: 'config',
  }, 'toml 写了就以 toml 为准（压过 cordis.patch.yml 里那个旧值）');
});

test('★ 没有 [agent] 这一段 ⇒ 缺省 low / source default', () => {
  const tomlPath = tempToml('[personality]\npersonality = "x"\n');
  assert.deepEqual(loadAgentConfig({ tomlPath }), { reasoning: 'low', source: 'default' });
});

test('[agent] 段在、但没写 reasoning ⇒ 仍然是缺省 low', () => {
  const tomlPath = tempToml('[agent]\n');
  assert.deepEqual(loadAgentConfig({ tomlPath }), { reasoning: 'low', source: 'default' });
});

test('兼容旧路径：没写 [agent] 时用 cordis.patch.yml 的 reasoningEffort（source: config）', () => {
  // 改动前这一项只活在 patch 里；"没写新段"不许把那个值丢掉（否则线上会从 low 变成
  // 部署默认 max —— 一句闲聊被当调研跑满 50 步，正是当初配 low 的原因）。
  const tomlPath = tempToml('[personality]\npersonality = "x"\n');
  assert.deepEqual(loadAgentConfig({ tomlPath, reasoningEffort: 'low' }), {
    reasoning: 'low',
    source: 'config',
  });
});

test('toml 路径空（没有 toml 可读）⇒ 不抛，走旧值 / 缺省', () => {
  assert.deepEqual(loadAgentConfig({}), { reasoning: 'low', source: 'default' });
  assert.deepEqual(loadAgentConfig({ reasoningEffort: 'high' }), { reasoning: 'high', source: 'config' });
});

test('toml 读失败（路径是个目录）⇒ 不抛，走缺省并 warn', () => {
  const dir = tempDir();
  const { entries, log } = collectingLog();
  assert.deepEqual(loadAgentConfig({ tomlPath: dir }, log), { reasoning: 'low', source: 'default' });
  assert.equal(entries.filter((e) => e.level === 'warn').length, 1, '读失败要留一条 warn');
});

// ---------------------------------------------------------------- ③ 非法值：夹到 low + warn

test('★ 非法值 "medium" ⇒ 夹到 low + warn（带写错的值与合法清单）', () => {
  // 为什么不是"当成没写、回落到 patch 里的旧值"：那会让"我写了 high"与"我把 high
  // 打成 highh"在快照里长得一模一样（都是 patch 那个值）—— 静默失效最难查。
  const tomlPath = tempToml('[agent]\nreasoning = "medium"\n');
  const { entries, log } = collectingLog();
  // ⚠️ 旧值故意给 `high`：结果必须是 **low**（夹到缺省），而不是回落到旧值 high ——
  //    "写错了就当没写"会让"我写了 high"与"我打错字"在快照里长得一样（都是 high）。
  const cfg = loadAgentConfig({ tomlPath, reasoningEffort: 'high' }, log);
  assert.deepEqual(cfg, { reasoning: 'low', source: 'default' });
  const warn = entries.find((e) => e.level === 'warn');
  assert.ok(warn !== undefined, '写错必须留 warn');
  assert.ok(warn.message.includes('medium'), 'warn 里要带写错的那个值');
  assert.deepEqual(warn.meta.allowed, ['off', 'low', 'high', 'max'], 'warn 里要带合法清单');
  assert.equal(warn.meta.fallback, 'low');
});

test('非法值大小写错（"HIGH"）也夹到 low（取值区分大小写）', () => {
  const tomlPath = tempToml('[agent]\nreasoning = "HIGH"\n');
  const { entries, log } = collectingLog();
  assert.deepEqual(loadAgentConfig({ tomlPath }, log), { reasoning: 'low', source: 'default' });
  assert.equal(entries.filter((e) => e.level === 'warn').length, 1);
});

test('类型不对（布尔 true）也夹到 low + warn，不猜意思', () => {
  const tomlPath = tempToml('[agent]\nreasoning = true\n');
  const { entries, log } = collectingLog();
  assert.deepEqual(loadAgentConfig({ tomlPath }, log), { reasoning: 'low', source: 'default' });
  assert.equal(entries.filter((e) => e.level === 'warn').length, 1);
});

test('normalizeAgentConfig：缺省/非法/合法三条路都不抛', () => {
  assert.deepEqual(normalizeAgentConfig(undefined), { reasoning: 'low', source: 'default' });
  assert.deepEqual(normalizeAgentConfig('nope'), { reasoning: 'low', source: 'default' });
  assert.deepEqual(normalizeAgentConfig({ reasoning: 'off' }), { reasoning: 'off', source: 'config' });
});

// ---------------------------------------------------------------- ④ 配置页：字段目录 + 读写

test('★ config-fields 里能列出 agent.reasoning（enum，选项 = 查证值）', () => {
  const field = CONFIG_FIELDS.find((item) => item.key === 'agent.reasoning');
  assert.ok(field !== undefined, '配置页的字段目录里必须有这一项');
  assert.equal(field.type, 'enum', '前端会按 enum 自动渲染下拉');
  assert.deepEqual(field.sectionPath, ['agent']);
  assert.equal(field.section, 'agent');
  assert.equal(field.tomlKey, 'reasoning');
  assert.deepEqual(field.options, ['off', 'low', 'high', 'max'], '选项必须是查证过的取值');
  assert.equal(field.default, 'low');
  assert.deepEqual(field.effectivePath, ['agent', 'reasoning']);
});

test('配置页拒绝非法值（medium ⇒ 400 口径），不会把非法值写进文件', () => {
  const field = CONFIG_FIELDS.find((item) => item.key === 'agent.reasoning');
  assert.deepEqual(coerceFieldValue(field, 'high'), { ok: true, value: 'high' });
  assert.deepEqual(coerceFieldValue(field, 'off'), { ok: true, value: 'off' });
  const bad = coerceFieldValue(field, 'medium');
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('off / low / high / max'), '错误文案要列出合法值：' + bad.error);
});

test('fileFieldValue：写了 high 就显示 high；写了 medium 显示 null（不冒充合法值）', () => {
  const field = CONFIG_FIELDS.find((item) => item.key === 'agent.reasoning');
  assert.equal(fileFieldValue(field, parseToml('[agent]\nreasoning = "high"\n')), 'high');
  assert.equal(fileFieldValue(field, parseToml('[agent]\nreasoning = "medium"\n')), null);
  assert.equal(fileFieldValue(field, parseToml('[personality]\n')), null);
});

// ---------------------------------------------------------------- 配置页 HTTP：GET / POST

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

/** 造一套路由：toml + 备份目录都在临时目录里。 */
function makeRoutes({ toml = '[personality]\npersonality = "x"\n', effective = {} } = {}) {
  const dir = tempDir();
  const tomlPath = path.join(dir, 'qq-gugu.toml');
  fs.writeFileSync(tomlPath, toml, 'utf8');
  const backupDir = path.join(dir, 'backups');
  const routes = pluginModule.createFreeTimeHttpRoutes({
    tomlPath,
    backupDir,
    allowFrom: ['30000001'],
    groupAllowFrom: ['30000013'],
    effective,
  });
  return { dir, tomlPath, backupDir, routes };
}

test('GET /settings：agent.reasoning 在 fields 里，带 options（前端不用自己维护表）', async () => {
  const { routes } = makeRoutes();
  const payload = (await call(routes, 'settings', 'GET')).json();
  const field = payload.fields.find((f) => f.key === 'agent.reasoning' && f.scope === 'global');
  assert.ok(field !== undefined, 'GET /settings 必须列出这一项');
  assert.equal(field.type, 'enum');
  assert.deepEqual(field.options, ['off', 'low', 'high', 'max'], '载荷带 options ⇒ 前端直接渲染下拉');
  assert.equal(field.value, null, '文件里没写 ⇒ null（不是空串）');
  assert.equal(field.effective, 'low', '没写 ⇒ 生效值是缺省 low');
});

test('GET /settings：文件写 high、进程里也是 high ⇒ value = effective = high', async () => {
  const { routes } = makeRoutes({
    toml: '[personality]\npersonality = "x"\n\n[agent]\nreasoning = "high"\n',
    effective: { agent: { reasoning: 'high', source: 'config' } },
  });
  const payload = (await call(routes, 'settings', 'GET')).json();
  const field = payload.fields.find((f) => f.key === 'agent.reasoning' && f.scope === 'global');
  assert.equal(field.value, 'high');
  assert.equal(field.effective, 'high', '生效值来自进程里那份（effective.agent）');
});

test('★ POST /config：能从配置页把它写进 toml（[agent] 段不存在时自动建段）', async () => {
  const { tomlPath, routes } = makeRoutes();
  const res = await call(routes, 'config', 'POST', {
    scope: 'global',
    key: 'agent.reasoning',
    value: 'high',
  });
  assert.equal(res.status, 200, res.body);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.wrote, true);
  assert.equal(body.restartNeeded, true, '改配置一律要一次重载才生效，不假装即时');

  const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
  assert.equal(doc.agent.reasoning, 'high', '写进了 [agent] reasoning');
  // 除了新加的段，原来那一段逐字不变（行级手术，不是整份重写）。
  assert.equal(doc.personality.personality, 'x');
});

test('★ POST /config：medium 被拒 400，文件里一个字节都不写', async () => {
  const { tomlPath, routes } = makeRoutes();
  const before = fs.readFileSync(tomlPath, 'utf8');
  const res = await call(routes, 'config', 'POST', {
    scope: 'global',
    key: 'agent.reasoning',
    value: 'medium',
  });
  assert.equal(res.status, 400, res.body);
  assert.ok(res.json().error.includes('off / low / high / max'), '错误里要给出合法值');
  assert.equal(fs.readFileSync(tomlPath, 'utf8'), before, '被拒的写入不许动文件');
});

// ---------------------------------------------------------------- ⑤ 快照

test('★ 快照：snapshot.agent = {reasoning, source}', () => {
  const snap = buildSnapshot({
    config: {},
    agent: { reasoning: 'high', source: 'config' },
  });
  assert.deepEqual(snap.agent, { reasoning: 'high', source: 'config' });
});

test('快照：不传 agent（老调用方）也不炸，形状固定', () => {
  const snap = buildSnapshot({ config: {} });
  assert.deepEqual(snap.agent, { reasoning: '', source: 'default' }, '不冒充某个值');
  const weird = buildSnapshot({ config: {}, agent: { reasoning: 42, source: 'nope' } });
  assert.deepEqual(weird.agent, { reasoning: '', source: 'default' });
});

test('快照：老快照文件（没有 agent 段）读出来不炸 —— 键是新增的，不影响其它段', () => {
  const old = { mode: 'reverse', stats: { received: 1 }, owner: { admins: [], source: 'none' } };
  assert.equal(old.agent, undefined, '老快照就是没有这一段');
  const snap = buildSnapshot({ config: {}, owner: { admins: [], source: 'none' } });
  assert.ok(Object.hasOwn(snap, 'agent'), '新快照一定带这一段');
  assert.deepEqual(snap.owner, { admins: [], source: 'none' }, '新增段不影响老段');
});

// ---------------------------------------------------------------- ⑥ 接线：binder

/** 假 `ctx.agents`：只记 resume/create 收到的 options（不需要真 agent）。 */
function fakeAgents({ resumeFails = false } = {}) {
  const resumed = [];
  const created = [];
  const agents = {
    async resume(options) {
      resumed.push(options);
      if (resumeFails) throw new Error('没有可恢复的会话');
      return { agent: {}, async dispose() {} };
    },
    async create(options) {
      created.push(options);
      return { agent: {}, async dispose() {} };
    },
  };
  return { agents, resumed, created };
}

test('★ binder：agentReasoning 优先于旧的 config.reasoningEffort（**create 路径**）', async () => {
  // 2026-10-24：档位只在 create（新会话）时发。resume 发它 = 盖掉会话里的
  // per-session 选择（宿主 `options.reasoningEffort ?? persisted`）。
  const { agents, created } = fakeAgents({ resumeFails: true });
  const binder = new SessionBinder({
    ctx: { agents },
    config: { reasoningEffort: 'low' },
    agentReasoning: 'high',
  });
  await binder.ensure('qq-group-100');
  assert.equal(created[0].agentOptions.reasoningEffort, 'high');

  // resume 路径：一个字段都不发，把档位还给会话（GUI 选择器写在 model/selection 里）。
  const resumedRun = fakeAgents();
  await new SessionBinder({
    ctx: { agents: resumedRun.agents },
    config: { reasoningEffort: 'low' },
    agentReasoning: 'high',
  }).ensure('qq-group-100');
  assert.equal(resumedRun.resumed[0].agentOptions.reasoningEffort, undefined, 'resume 不许发档位');
});

test('binder：agentReasoning 为空 ⇒ 老行为不变（create 用 config，两个都空就不发这个字段）', async () => {
  const withLegacy = fakeAgents({ resumeFails: true });
  await new SessionBinder({
    ctx: { agents: withLegacy.agents },
    config: { reasoningEffort: 'low' },
  }).ensure('qq-group-100');
  assert.equal(withLegacy.created[0].agentOptions.reasoningEffort, 'low', '旧字段仍然生效');

  const bare = fakeAgents({ resumeFails: true });
  await new SessionBinder({ ctx: { agents: bare.agents } }).ensure('qq-group-100');
  assert.equal(bare.created[0].agentOptions.reasoningEffort, undefined, '不给就该继承部署默认');
});

// ---------------------------------------------------------------- ⑦ 接线：apply() 走完整条路

/** 造一个刚好够 `apply()` 用的假 ctx（照 `mood-config.test.mjs` 的写法 + 假 agents）。 */
function fakeCtx(agents, registered) {
  const logs = [];
  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      error: (...a) => logs.push(['error', ...a]),
      debug: (...a) => logs.push(['debug', ...a]),
    },
    llm: { stream: () => (async function* () {})() },
    agents,
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject: (deps, cb) => {
      try {
        cb({
          connection: undefined,
          webServer: { register: (route) => { registered.push(route); return () => {}; } },
          effect: (fn) => {
            const dispose = fn();
            return typeof dispose === 'function' ? dispose : () => {};
          },
        });
      } catch {
        /* 路由挂不上不影响被测的接线 */
      }
      return () => {};
    },
    interval: () => () => {},
    setTimeout: () => ({ unref: () => {} }),
    on: () => () => {},
  };
  return { ctx, logs };
}

async function applyWith(rawConfig) {
  // 让 resume 失败 ⇒ 走 create（"新会话"那条路）。档位只在 create 时下发
  // （2026-10-24：resume 发它会盖掉会话里的 per-session 选择）。
  const { agents, resumed, created } = fakeAgents({ resumeFails: true });
  const registered = [];
  const { ctx, logs } = fakeCtx(agents, registered);
  const debugFile = path.join(path.dirname(rawConfig.tomlPath), 'snap.json');
  const prev = process.env.QQ_PROACTIVE_DEBUG_FILE;
  process.env.QQ_PROACTIVE_DEBUG_FILE = debugFile;
  let handle;
  try {
    handle = await pluginModule.apply(ctx, {
      mode: 'http',
      httpUrl: 'http://127.0.0.1:1',
      accessToken: 'x',
      actionTimeoutMs: 200,
      ...rawConfig,
    });
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    if (prev === undefined) delete process.env.QQ_PROACTIVE_DEBUG_FILE;
    else process.env.QQ_PROACTIVE_DEBUG_FILE = prev;
  }
  return {
    handle,
    resumed,
    created,
    registered,
    logs,
    snap() {
      handle.writeSnapshot(true);
      return JSON.parse(fs.readFileSync(debugFile, 'utf8'));
    },
  };
}

test('★ 接线（apply）：toml 的 [agent] reasoning = "high" 真的走到 agentOptions（新会话）', async () => {
  const tomlPath = tempToml('[personality]\npersonality = "x"\n\n[agent]\nreasoning = "high"\n');
  const env = await applyWith({ tomlPath });
  await env.handle.binder.ensure('qq-group-100');
  assert.equal(env.created.length, 1);
  assert.equal(env.created[0].agentOptions.reasoningEffort, 'high');

  const snapshot = env.snap();
  assert.deepEqual(snapshot.agent, { reasoning: 'high', source: 'config' }, '快照里能看到生效值与来源');
});

test('★ 接线（apply）：没有 [agent] 段 ⇒ 仍然是 low（缺省，快照 source: default）', async () => {
  const tomlPath = tempToml('[personality]\npersonality = "x"\n');
  const env = await applyWith({ tomlPath });
  await env.handle.binder.ensure('qq-group-100');
  assert.equal(env.created[0].agentOptions.reasoningEffort, 'low');
  assert.deepEqual(env.snap().agent, { reasoning: 'low', source: 'default' });
});

test('接线（apply）：旧 patch 值仍然兜底（toml 没写、cordis 配了 low）', async () => {
  const tomlPath = tempToml('[personality]\npersonality = "x"\n');
  const env = await applyWith({ tomlPath, reasoningEffort: 'low' });
  await env.handle.binder.ensure('qq-group-100');
  assert.equal(env.created[0].agentOptions.reasoningEffort, 'low');
  assert.deepEqual(env.snap().agent, { reasoning: 'low', source: 'config' });
});

test('接线（apply）：非法值在挂载时就被夹到 low，并留一条 warn', async () => {
  const tomlPath = tempToml('[agent]\nreasoning = "medium"\n');
  const env = await applyWith({ tomlPath });
  await env.handle.binder.ensure('qq-group-100');
  assert.equal(env.created[0].agentOptions.reasoningEffort, 'low');
  assert.deepEqual(env.snap().agent, { reasoning: 'low', source: 'default' });
  const warned = env.logs.some((entry) => entry[0] === 'warn'
    && entry.slice(1).flat().some((x) => String(x ?? '').includes('reasoning')));
  assert.ok(warned, '挂载日志里要有那条 warn');
});
