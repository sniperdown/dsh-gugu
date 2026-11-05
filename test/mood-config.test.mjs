/**
 * `[mood]` 的装载与接线测试（`index.mjs` 的 `loadMoodConfig` + `createMood` 的实参）。
 *
 * ## 为什么这一组必须存在
 *
 * 2026-10-14 之前，心情更新用的是**小鲸鱼对话那条模型**（`config.provider/model`，
 * 当时是 deepseek-flash），而它在活跃群里约 **1.7 次调用/分钟** —— 烧的是对话模型的钱。
 * 用户要求改成「云端的千问的小模型，30b 左右的」。
 *
 * 这一组的重点是三条**静默失效**：
 *
 * 1. **读不到 `[mood]` 时行为必须与改动前等价** —— 否则"没写这一节"会变成
 *    "悄悄换了个模型"或者"悄悄关掉了心情"（两种都不报错）。
 * 2. **配的 provider/model 要真的走到 `createMood`** —— 配置写了、读到了、
 *    却没接上线，是这个项目最贵的一类坑。所以这里**从 `apply()` 走完整条路**，
 *    用桩 `ctx.llm.stream` 断言它收到的 opts。
 * 3. **`enabled = false` ⇒ 不构造、不调用**（用户要能一键止血）。
 *    快照里也必须分得开「关掉了」和「接着但还没更新过」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pluginModule from '../src/index.mjs';
import { buildSnapshot } from '../src/dsh/debug-snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 写一份临时 toml（只含被测的段），返回路径。
 *
 * ⚠️ **刻意不用 `os.tmpdir()`**：受限沙箱里 `%LOCALAPPDATA%\Temp` 会被挡，
 * `mkdtempSync` 直接 EPERM ⇒ 这组测试会**在本机永远是红的**（而且看起来像代码坏了）。
 * 落在工作区内（测试文件旁边），跑完自己删。
 */
function tempToml(body) {
  const dir = fs.mkdtempSync(path.join(HERE, '.tmp-mood-'));
  const file = path.join(dir, 'qq-gugu.toml');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith('.tmp-mood-')) {
        fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
      }
    }
  } catch { /* 收尾失败不该影响测试结果 */ }
});

/**
 * 摘出**心情那一次** `llm.stream` 调用。
 *
 * 判据是 `maxTokens === 100` —— 那是 `mood.mjs` 里写死的输出预算
 * （其他任何一路调用都不是这个数），比"看调用顺序"稳。
 */
function moodCalls(streamOpts) {
  return streamOpts.filter((o) => o !== null && typeof o === 'object' && o.maxTokens === 100);
}

/** 造一个刚好够 `apply()` 用的假 ctx（照 `index.test.mjs` 的写法，另加 llm 桩）。 */
function fakeCtx() {
  const intervals = [];
  const logs = [];
  /** 每一次 `ctx.llm.stream` 收到的 opts —— 断言"传到了没有"的直接证据。 */
  const streamOpts = [];
  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      error: (...a) => logs.push(['error', ...a]),
      debug: (...a) => logs.push(['debug', ...a]),
    },
    llm: {
      stream: (opts) => {
        streamOpts.push(opts);
        return (async function* () { yield { type: 'text-delta', text: '有点开心' }; })();
      },
    },
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject: () => () => {},
    interval: (fn, ms) => {
      intervals.push({ fn, ms });
      return () => {};
    },
    setTimeout: () => ({ unref: () => {} }),
    on: () => () => {},
  };
  return { ctx, logs, intervals, streamOpts };
}

/**
 * 起一个最小可用的插件实例（http 模式 + 连不上的目标 ⇒ 不碰任何真实 QQ）。
 *
 * ⚠️ **必须把调试快照指到工作区里的临时文件**：默认路径是
 * `<DSH_HOME>\media\qq-proactive-debug.json` —— 那是**线上正在用的**那份快照，
 * 测试往里写等于伪造现场（还可能盖掉正在排查的证据）。
 * 这里只改 `process.env`，测试结束就还原。
 */
async function applyWith(rawConfig) {
  const h = fakeCtx();
  const debugFile = path.join(path.dirname(rawConfig.tomlPath), 'snap.json');
  const prev = process.env.QQ_PROACTIVE_DEBUG_FILE;
  process.env.QQ_PROACTIVE_DEBUG_FILE = debugFile;
  try {
    const handle = await pluginModule.apply(h.ctx, {
      mode: 'http',
      httpUrl: 'http://127.0.0.1:1',
      accessToken: 'x',
      actionTimeoutMs: 200,
      ...rawConfig,
    });
    await new Promise((r) => setTimeout(r, 30));
    return {
      ...h,
      handle,
      /**
       * 读这次挂载写出去的那份快照。
       *
       * ⚠️ **先 `force` 写一次再读**：快照本来只在"入站消息 / 连接就绪"时写
       * （挂载时也写一份，但那是紧接着 apply 的，之后的心情变化不会自动落盘）——
       * 不强制写就会读到**上一次**的内容，那正是"看起来对、其实没生效"的经典假象。
       */
      snap() {
        handle.writeSnapshot(true);
        return JSON.parse(fs.readFileSync(debugFile, 'utf8'));
      },
    };
  } finally {
    if (prev === undefined) delete process.env.QQ_PROACTIVE_DEBUG_FILE;
    else process.env.QQ_PROACTIVE_DEBUG_FILE = prev;
  }
}

// ---------------------------------------------------------------- 读 toml

test('★ [mood] 读得到：四项都按 toml 走（qwen 30B）', () => {
  const cfg = pluginModule.loadMoodConfig({
    tomlPath: tempToml('[mood]\nenabled = true\nprovider = "qwen"\nmodel = "qwen3-30b-a3b-instruct-2507"\nreasoning_effort = "off"\n'),
  });
  assert.deepEqual(cfg, {
    enabled: true,
    provider: 'qwen',
    model: 'qwen3-30b-a3b-instruct-2507',
    reasoningEffort: 'off',
    // 2026-10-30：三段提示词（空串 = mood.mjs 里的原文，行为不变）。
    systemPrompt: '',
    updateNote: '',
    regressNote: '',
    // 2026-10-30：节奏旋钮（默认 = 改动前的值；上下文条数从 1 变成 20）。
    transcriptMessages: 20,
    cooldownMinutes: 0,
    updateBaseProb: 0.1,
    updateRampPerMin: 0.1,
    updateMaxProb: 0.5,
    regressAfterSeconds: 200,
    regressMax: 2,
  });
});

test('★ 没有 [mood] 这一节 ⇒ 与改动前等价（开着 · 跟着对话那条路 · off）', () => {
  const cfg = pluginModule.loadMoodConfig({
    tomlPath: tempToml('[proactive]\nmaxPerHour = 5\n'),
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  });
  assert.equal(cfg.enabled, true, '读不到 ≠ 关掉（它改动前一直在跑）');
  assert.equal(cfg.provider, 'deepseek-official');
  assert.equal(cfg.model, 'deepseek-flash');
  assert.equal(cfg.reasoningEffort, 'off');
});

test('没有 [mood] 时 provider/model 回退到的是**经过 config** 的那两个值（两层兜底）', () => {
  const bare = tempToml('[mood]\n');
  const fromConfig = pluginModule.loadMoodConfig({ tomlPath: bare, provider: 'p1', model: 'm1' });
  assert.equal(fromConfig.provider, 'p1');
  assert.equal(fromConfig.model, 'm1');

  const fromHardcode = pluginModule.loadMoodConfig({ tomlPath: bare });
  assert.equal(fromHardcode.provider, 'deepseek-official', 'cordis 也没配才用硬编码兜底');
  assert.equal(fromHardcode.model, 'deepseek-flash');
});

test('toml 文件不存在 ⇒ 回默认值，不抛异常', () => {
  const cfg = pluginModule.loadMoodConfig({ tomlPath: 'H:\\nope\\nope-mood.toml' });
  assert.deepEqual(cfg, {
    enabled: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'off',
    systemPrompt: '',
    updateNote: '',
    regressNote: '',
    // 2026-10-30：节奏旋钮（默认 = 改动前的值；上下文条数从 1 变成 20）。
    transcriptMessages: 20,
    cooldownMinutes: 0,
    updateBaseProb: 0.1,
    updateRampPerMin: 0.1,
    updateMaxProb: 0.5,
    regressAfterSeconds: 200,
    regressMax: 2,
  });
});

test('reasoning_effort 能换：这是"换模型要连带换档位"的出口（写死就换不动了）', () => {
  const cfg = pluginModule.loadMoodConfig({
    tomlPath: tempToml('[mood]\nreasoning_effort = "low"\n'),
  });
  assert.equal(cfg.reasoningEffort, 'low');
});

test('enabled 只认布尔：写成字符串 "false" 不算关掉（不能把止血的开关静默吃掉）', () => {
  const cfg = pluginModule.loadMoodConfig({ tomlPath: tempToml('[mood]\nenabled = "false"\n') });
  assert.equal(cfg.enabled, true);
  const off = pluginModule.loadMoodConfig({ tomlPath: tempToml('[mood]\nenabled = false\n') });
  assert.equal(off.enabled, false, '真布尔 false 必须认');
});

test('provider/model 是空串 = 没配 ⇒ 走回退（空串在这里没有可表达的语义）', () => {
  const cfg = pluginModule.loadMoodConfig({
    tomlPath: tempToml('[mood]\nprovider = ""\nmodel = "  "\n'),
    provider: 'p1',
    model: 'm1',
  });
  assert.equal(cfg.provider, 'p1');
  assert.equal(cfg.model, 'm1');
});

test('缺字段 ⇒ 按字段补默认，不是整节丢掉', () => {
  const cfg = pluginModule.loadMoodConfig({
    tomlPath: tempToml('[mood]\nmodel = "qwen3-30b-a3b"\n'),
    provider: 'p1',
  });
  assert.equal(cfg.model, 'qwen3-30b-a3b');
  assert.equal(cfg.provider, 'p1', '没写的字段回退，不是变成空');
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.reasoningEffort, 'off');
});

// ---------------------------------------------------------------- 快照的形状

test('★ 快照的 mood 段：形状 + states 就是把当前心情原样带出来', () => {
  const snap = buildSnapshot({
    config: {},
    mood: { getAllMoods: () => ({ 'group:1': '有点开心', 'group:2': '感觉很平静' }) },
    moodConfig: { enabled: true, provider: 'qwen', model: 'qwen3-30b-a3b-instruct-2507', reasoningEffort: 'off' },
  });
  assert.deepEqual(snap.mood, {
    enabled: true,
    provider: 'qwen',
    model: 'qwen3-30b-a3b-instruct-2507',
    reasoningEffort: 'off',
    states: { 'group:1': '有点开心', 'group:2': '感觉很平静' },
    // 桩没提供 `getMoodDiag` ⇒ 退化成空对象。"没有诊断信息"本身也要看得见。
    diag: {},
  });
});

test('★ 快照的 mood 段：诊断计数原样带出来（calls/tries/fails/lastError）', () => {
  // 为什么要这段：`getMood()` 会顺手创建默认值 ⇒ 光看 states 里是"感觉很平静"，
  // 分不出「没触发」「触发了但抛错」「生成了、恰好就是这个词」。
  // calls/tries/fails/lastError 一摆出来，四种状态立刻分得开。
  const snap = buildSnapshot({
    config: {},
    mood: {
      getAllMoods: () => ({ 'group:1': '感觉很平静' }),
      getMoodDiag: () => ({
        'group:1': { calls: 3, tries: 1, fails: 1, lastTryAt: 1792000000000, lastChangeAt: 0, lastError: 'UNSUPPORTED_REASONING_EFFORT' },
      }),
    },
    moodConfig: { enabled: true, provider: 'qwen', model: 'm', reasoningEffort: '' },
  });
  assert.deepEqual(snap.mood.diag, {
    'group:1': {
      calls: 3,
      tries: 1,
      fails: 1,
      lastTryAt: 1792000000000,
      lastChangeAt: 0,
      lastError: 'UNSUPPORTED_REASONING_EFFORT',
    },
  });
});

test('快照的 mood 段：getMoodDiag 抛异常 ⇒ 退化成空对象，不冒泡', () => {
  const snap = buildSnapshot({
    config: {},
    mood: { getAllMoods: () => ({}), getMoodDiag: () => { throw new Error('diag boom'); } },
    moodConfig: { enabled: true },
  });
  assert.deepEqual(snap.mood.diag, {});
});

test('★ 快照里 states 为空对象 = "接着的但还没更新过"，不是"没接上"', () => {
  const on = buildSnapshot({ config: {}, mood: { getAllMoods: () => ({}) }, moodConfig: { enabled: true } });
  assert.deepEqual(on.mood.states, {}, '空也必须是看得出来的空');
  assert.equal(on.mood.enabled, true);

  const off = buildSnapshot({ config: {}, mood: null, moodConfig: { enabled: false, provider: '', model: '' } });
  assert.equal(off.mood.enabled, false);
  assert.equal(off.mood.states, null, '关掉了 = 压根没构造');
});

test('快照的 mood 段：什么都不传也不炸（调试设施绝不拖垮主流程）', () => {
  assert.doesNotThrow(() => buildSnapshot({}));
  const snap = buildSnapshot({});
  assert.equal(snap.mood.enabled, false);
  assert.equal(snap.mood.states, null);
});

test('快照的 mood 段：getAllMoods 抛异常 ⇒ 退化成空对象，不冒泡', () => {
  const snap = buildSnapshot({
    config: {},
    mood: { getAllMoods: () => { throw new Error('boom'); } },
    moodConfig: { enabled: true },
  });
  assert.deepEqual(snap.mood.states, {});
});

// ---------------------------------------------------------------- 接线（从 apply 走完整条路）

test('★ 配的 provider/model 真的到了 createMood —— 桩 stream 收到它们', async () => {
  const tomlPath = tempToml(
    '[mood]\nenabled = true\nprovider = "qwen"\nmodel = "qwen3-30b-a3b-instruct-2507"\nreasoning_effort = "off"\n',
  );
  const h = await applyWith({ tomlPath });

  const orig = Math.random;
  Math.random = () => 0; // 一定触发更新
  try {
    await h.handle.mood.updateMood({ chatId: 'group:1', transcript: '今晚吃什么' });
  } finally {
    Math.random = orig;
  }

  const call = moodCalls(h.streamOpts)[0];
  assert.ok(call !== undefined, '心情该发起一次 llm.stream（maxTokens=100 那次）');
  assert.equal(call.provider, 'qwen');
  assert.equal(call.model, 'qwen3-30b-a3b-instruct-2507');
  assert.equal(call.reasoningEffort, 'off');
  assert.equal(call.maxTokens, 100);

  const snap = h.snap();
  assert.equal(snap.mood.enabled, true);
  assert.equal(snap.mood.provider, 'qwen', '快照里要能看见"正在烧哪条路"');
  assert.equal(snap.mood.model, 'qwen3-30b-a3b-instruct-2507');
  assert.equal(snap.mood.reasoningEffort, 'off');
  assert.equal(snap.mood.states['group:1'], '有点开心', '当前心情本身也要落进快照');
});

test('★ 快照里的 provider/model 与桩收到的 provider/model 是同一份（读到了不等于接上线了）', async () => {
  const tomlPath = tempToml('[mood]\nprovider = "qwen"\nmodel = "qwen3-30b-a3b-thinking-2507"\nreasoning_effort = "low"\n');
  const h = await applyWith({ tomlPath });

  const orig = Math.random;
  Math.random = () => 0;
  try {
    await h.handle.mood.updateMood({ chatId: 'group:7', transcript: 'x' });
  } finally {
    Math.random = orig;
  }

  const call = moodCalls(h.streamOpts)[0];
  const snap = h.snap();
  assert.equal(snap.mood.provider, call.provider);
  assert.equal(snap.mood.model, call.model);
  assert.equal(snap.mood.reasoningEffort, call.reasoningEffort);
});

test('★ reasoning_effort 写成空串 ⇒ 一个字段都不发（"连 off 都不接受"时的出口）', async () => {
  const tomlPath = tempToml('[mood]\nprovider = "qwen"\nmodel = "qwen3-30b-a3b-instruct-2507"\nreasoning_effort = ""\n');
  const h = await applyWith({ tomlPath });

  const orig = Math.random;
  Math.random = () => 0;
  try {
    await h.handle.mood.updateMood({ chatId: 'group:1', transcript: 'x' });
  } finally {
    Math.random = orig;
  }

  const call = moodCalls(h.streamOpts)[0];
  assert.ok(call !== undefined, '仍该发起调用');
  assert.equal('reasoningEffort' in call, false, '空串 = 不发这个字段（不是发一个空值）');
  assert.equal(call.reasoningEffort, undefined);
  assert.equal(h.snap().mood.reasoningEffort, '', '快照里照实写空串，别假装是 off');
});

test('挂载日志里带得出心情走哪条路', async () => {
  const tomlPath = tempToml('[mood]\nprovider = "qwen"\nmodel = "qwen3-30b-a3b-instruct-2507"\n');
  const h = await applyWith({ tomlPath });
  const mounted = h.logs.find((l) => String(l[1]).includes('已挂载'));
  assert.ok(mounted !== undefined, '该有一条挂载日志');
  assert.equal(mounted[2]?.mood?.model, 'qwen3-30b-a3b-instruct-2507');
});

// ---------------------------------------------------------------- 一键关掉

test('★ enabled = false ⇒ 不构造、不调用，快照里看得出是"关掉了"', async () => {
  const tomlPath = tempToml('[mood]\nenabled = false\nprovider = "qwen"\nmodel = "qwen3-30b-a3b-instruct-2507"\n');
  const h = await applyWith({ tomlPath });

  assert.equal(h.handle.mood, null, '关掉 = 压根不构造（不是构造出来再判空）');

  // 平复定时器也**不该建**：两秒内它本会跑好几轮（60 秒一轮 ⇒ 这里用短窗口+手动触发验）。
  const t0 = h.intervals.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.intervals.length, t0, '关掉后不该再多出任何 interval（心情平复那个也不该有）');

  // 把所有 interval 都手动跑一遍：**心情那条路一次 llm 调用都不该发生**。
  for (const t of h.intervals) t.fn();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(moodCalls(h.streamOpts).length, 0, '关掉之后一次都不许调用');

  const snap = h.snap();
  assert.equal(snap.mood.enabled, false);
  assert.equal(snap.mood.states, null, 'states:null = 关掉了（空对象 {} 是"接着但还没更新过"）');
});
