/**
 * 「学来的记忆」（旧记忆库）总开关的装载与接线测试（2026-10-16）。
 *
 * ## 为什么这一组必须存在
 *
 * 用户原话：「我们现在既然有记忆库了，**老的那个停掉吧，我看了看全是噪声**」。
 * 而这里有一个**很容易搞砸、搞砸了还看不出来**的点：
 *
 *   静态知识库 `knowledge.json`（1247 概念 + 546 画像）和学来的事实
 *   `learned-memory.json` **住在同一个 `KnowledgeBase` 对象里** ——
 *   用户明确说过「那是知识库不是记忆，别砍」，所以**只能关后一半**。
 *
 * 干净分开靠的是**两条写入路径**（`personInfo` 里没有任何 learned 标记）：
 *   ① `knowledge.json` ⇒ `KnowledgeBase.load()`，只读那一个文件；
 *   ② `learned-memory.json` ⇒ `remember()` 的两条调用点：**启动重放** + `learner.learn()`。
 * ⇒ 关掉 ② 的两条调用点即"只剩静态库"。这一组钉的正是这两条**真的都关了**、
 *   而且**没有把静态库牵连进去**。
 *
 * ## 三条静默失效（这一组的重点）
 *
 * 1. **读不到 `[memory]` 时行为必须与改动前逐字等价**（默认 `true`）——
 *    否则"没写这一节"会变成"悄悄把旧记忆库关了"（不报错）。
 * 2. **`learned_enabled = false` 时 `learner` 真的没构造**（`binder.learner === null`）——
 *    配置读了、判断做了、却没接上线，是本项目最贵的一类坑。
 * 3. **静态知识库不受影响**：关掉之后 `binder.knowledge` 的 `graphNodes`
 *    还是 `knowledge.json` 里那些，画像里学来的条目**一条都不在**。
 *
 * ⚠️ 全组**不碰线上数据**：知识库/记忆文件都指到临时目录，调试快照也指到临时文件
 * （默认路径是 `<DSH_HOME>\media\qq-proactive-debug.json` —— 那是**正在用的**那份，
 * 测试往里写等于伪造现场）。
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
 * ⚠️ **刻意不用 `os.tmpdir()`**（照 `mood-config.test.mjs`）：受限沙箱里
 * `%LOCALAPPDATA%\Temp` 会被挡，`mkdtempSync` 直接 EPERM ⇒ 这组测试会
 * **在本机永远是红的**，而且看起来像代码坏了。
 */
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(HERE, prefix));
}

function writeFile(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith('.tmp-learned-')) {
        fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
      }
    }
  } catch { /* 收尾失败不该影响测试结果 */ }
});

/** 造一个刚好够 `apply()` 用的假 ctx（照 `mood-config.test.mjs`）。 */
function fakeCtx() {
  const logs = [];
  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      error: (...a) => logs.push(['error', ...a]),
      debug: (...a) => logs.push(['debug', ...a]),
    },
    llm: {
      stream: () => (async function* () { yield { type: 'text-delta', text: '[]' }; })(),
    },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    inject: () => () => {},
    interval: () => () => {},
    setTimeout: () => ({ unref: () => {} }),
    on: () => () => {},
  };
  return { ctx, logs };
}

/**
 * 起一个最小可用的插件实例：http 模式 + 连不上的目标 ⇒ **不碰任何真实 QQ**。
 *
 * 知识库与记忆文件都指到临时目录；调试快照也指到临时文件（只改 `process.env`，
 * 结束就还原）。
 */
async function applyWith({ tomlBody, knowledge, learned }) {
  const dir = tempDir('.tmp-learned-');
  const tomlPath = writeFile(dir, 'qq-gugu.toml', tomlBody);
  const kbPath = writeFile(dir, 'knowledge.json', JSON.stringify(knowledge));
  const learnedPath = writeFile(dir, 'learned-memory.json', JSON.stringify(learned));
  const debugFile = path.join(dir, 'snap.json');

  const prevShared = process.env.QQ_SHARED_DIR;
  const prevLearned = process.env.QQ_LEARNED_PATH;
  const prevDebug = process.env.QQ_PROACTIVE_DEBUG_FILE;
  process.env.QQ_PROACTIVE_DEBUG_FILE = debugFile;
  process.env.QQ_LEARNED_PATH = learnedPath;
  try {
    const h = fakeCtx();
    const handle = await pluginModule.apply(h.ctx, {
      mode: 'http',
      httpUrl: 'http://127.0.0.1:1',
      accessToken: 'x',
      actionTimeoutMs: 200,
      tomlPath,
      // 知识库路径（刻意不在 `CONFIG_SHAPE` 里，所以只能这样传）
      knowledgePath: kbPath,
    });
    await new Promise((r) => setTimeout(r, 30));
    return {
      ...h,
      handle,
      dir,
      learnedPath,
      /** **强制**写一次再读 —— 不 force 会读到上一次的内容（"看起来对、其实没生效"）。 */
      snap() {
        handle.writeSnapshot(true);
        return JSON.parse(fs.readFileSync(debugFile, 'utf8'));
      },
    };
  } finally {
    if (prevShared === undefined) delete process.env.QQ_SHARED_DIR;
    else process.env.QQ_SHARED_DIR = prevShared;
    if (prevLearned === undefined) delete process.env.QQ_LEARNED_PATH;
    else process.env.QQ_LEARNED_PATH = prevLearned;
    if (prevDebug === undefined) delete process.env.QQ_PROACTIVE_DEBUG_FILE;
    else process.env.QQ_PROACTIVE_DEBUG_FILE = prevDebug;
  }
}

/** 一份"静态知识库"：一个概念 + 一个**空的**画像（画像是学来的条目唯一去处）。 */
const STATIC_KB = {
  graph_nodes: [{ concept: '第五人格', memory: '这是一款非对称竞技手游。' }],
  person_info: [{ user_id: '9001', nickname: '甲', memory: '静态画像里的一句话' }],
};

/** 一份"学来的记忆"：两条属于 9001 的事实。 */
const LEARNED = [
  { user_id: '9001', fact: '[事实] 他在配置 QQ 机器人' },
  { user_id: '9001', fact: '[事实] 他抱怨 token 消耗大' },
];

// ---------------------------------------------------------------- 读 toml

test('★ [memory] 读得到：learned_enabled = false ⇒ 关掉', () => {
  const dir = tempDir('.tmp-learned-');
  const tomlPath = writeFile(dir, 'qq-gugu.toml', '[memory]\nlearned_enabled = false\n');
  // 2026-10-17：同一节里又加了两个键（A+B 注入旋钮），这里跟着契约一起扩。
  // 它们与"学来的记忆"无关，值恒为默认 —— 但**形状是精确断言**，少一个就红。
  assert.deepEqual(pluginModule.loadLearnedMemoryConfig({ tomlPath }), {
    learnedEnabled: false,
    injectMaxChars: 800,
    injectPrivateAsSection: true,
  });
});

test('★ 没有 [memory] 这一节 ⇒ 默认**开着**（读不到 ≠ 关掉，改动前的行为）', () => {
  const dir = tempDir('.tmp-learned-');
  const tomlPath = writeFile(dir, 'qq-gugu.toml', '[proactive]\nmaxPerHour = 5\n');
  assert.deepEqual(pluginModule.loadLearnedMemoryConfig({ tomlPath }), {
    learnedEnabled: true,
    injectMaxChars: 800,
    injectPrivateAsSection: true,
  });
});

test('toml 文件不存在 ⇒ 回默认值，不抛异常', () => {
  assert.deepEqual(
    pluginModule.loadLearnedMemoryConfig({ tomlPath: 'H:\\nope\\nope-memory.toml' }),
    { learnedEnabled: true, injectMaxChars: 800, injectPrivateAsSection: true },
  );
});

test('learned_enabled 只认布尔：写成字符串 "false" 不算关掉（不能把止血的开关静默吃掉）', () => {
  const dir = tempDir('.tmp-learned-');
  const quoted = writeFile(dir, 'quote.toml', '[memory]\nlearned_enabled = "false"\n');
  assert.equal(
    pluginModule.loadLearnedMemoryConfig({ tomlPath: quoted }).learnedEnabled,
    true,
    'JS 里 "false" 是真值 —— 认了它等于把开关吃掉',
  );
  const real = writeFile(dir, 'real.toml', '[memory]\nlearned_enabled = false\n');
  assert.equal(pluginModule.loadLearnedMemoryConfig({ tomlPath: real }).learnedEnabled, false);
});

test('显式写 true 与"没写"等价（恢复旧行为的出口）', () => {
  const dir = tempDir('.tmp-learned-');
  const tomlPath = writeFile(dir, 'qq-gugu.toml', '[memory]\nlearned_enabled = true\n');
  assert.deepEqual(pluginModule.loadLearnedMemoryConfig({ tomlPath }), {
    learnedEnabled: true,
    injectMaxChars: 800,
    injectPrivateAsSection: true,
  });
});

// ---------------------------------------------------------------- 接线（真的关掉没有）

test('★ 关掉时：learner **没有构造**，且学来的条目**一条都没重放进画像**', async () => {
  const h = await applyWith({
    tomlBody: '[memory]\nlearned_enabled = false\n',
    knowledge: STATIC_KB,
    learned: LEARNED,
  });
  try {
    // ① 学习器不构造 ⇒ `binding.mjs` 的学习守卫直接 return（写入侧彻底断）
    assert.equal(h.handle.binder.learner, null, 'learner 必须压根不构造（关掉要能一键止血）');
    // ② 不重放 ⇒ 画像里只剩静态那一条，学来的两条不在
    const person = h.handle.binder.knowledge.personInfo.find((p) => String(p.user_id) === '9001');
    assert.ok(person !== undefined, '静态画像必须在（那是知识库，不是记忆）');
    assert.equal(person.memory, '静态画像里的一句话', '学来的条目必须一条都没进来');
    assert.ok(
      !person.memory.includes('QQ 机器人') && !person.memory.includes('token 消耗'),
      '重放被跳过了才可能到这里',
    );
    // ③ **静态知识库不受影响** —— 这是用户点名要保住的那一半
    assert.deepEqual(
      h.handle.binder.knowledge.graphNodes,
      STATIC_KB.graph_nodes,
      '概念库要原样保留（用户原话：那是知识库不是记忆，别砍）',
    );
    // ④ 注入这条路照旧开着（`knowledge` 仍是那个对象，不是 null）——
    //    "停掉旧记忆库"不等于"把知识库也停了"
    assert.notEqual(h.handle.binder.knowledge, null);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('★ 开着时（默认）：learner 构造了，学来的条目**原样重放**进画像', async () => {
  const h = await applyWith({
    tomlBody: '[proactive]\nmaxPerHour = 5\n', // 没有 [memory] 段 = 默认
    knowledge: STATIC_KB,
    learned: LEARNED,
  });
  try {
    assert.notEqual(h.handle.binder.learner, null, '默认必须是开着的（与改动前逐字等价）');
    const person = h.handle.binder.knowledge.personInfo.find((p) => String(p.user_id) === '9001');
    assert.ok(person.memory.includes('静态画像里的一句话'), '静态那条还在');
    assert.ok(person.memory.includes('他在配置 QQ 机器人'), '学来的第 1 条要重放进来');
    assert.ok(person.memory.includes('他抱怨 token 消耗大'), '学来的第 2 条要重放进来');
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('★ 关掉时：**不构造** ⇒ `onLearned` 那条回写路也是 null（不写文件）', async () => {
  const h = await applyWith({
    tomlBody: '[memory]\nlearned_enabled = false\n',
    knowledge: STATIC_KB,
    learned: LEARNED,
  });
  try {
    // `binding.mjs` 是 `typeof this.onLearned === 'function'` 才回写 ⇒ null 就是"压根不写"。
    assert.equal(h.handle.binder.onLearned, null);
    // 文件本身**不许删**（用户没让删，只是不再写）
    assert.ok(fs.existsSync(h.learnedPath), '老文件必须还在（不删，只是不写）');
    assert.deepEqual(JSON.parse(fs.readFileSync(h.learnedPath, 'utf8')), LEARNED, '内容不该被动过');
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 快照（怎么读这个开关）

test('★ 快照的 learnedMemory 段：形状 + 关掉时是 enabled:false / learnerBuilt:false', () => {
  const snap = buildSnapshot({
    config: {},
    learnedMemory: { enabled: false, learnerBuilt: false },
  });
  assert.deepEqual(snap.learnedMemory, { enabled: false, learnerBuilt: false });
});

test('★ 快照能区分"关干净了"和"配了关、learner 却还在跑"（接线漏了的那一档）', () => {
  // 只看一个布尔的话，第二档会被误判成"已停用"，而行为上它照样在学。
  const half = buildSnapshot({ config: {}, learnedMemory: { enabled: false, learnerBuilt: true } });
  assert.deepEqual(half.learnedMemory, { enabled: false, learnerBuilt: true });
});

test('快照没传 learnedMemory ⇒ null（不假装一切正常）', () => {
  assert.equal(buildSnapshot({ config: {} }).learnedMemory, null);
});

test('★ 快照里的 learnedMemory 是**接线真的做到的**，不只是配置说了什么', async () => {
  const off = await applyWith({
    tomlBody: '[memory]\nlearned_enabled = false\n',
    knowledge: STATIC_KB,
    learned: LEARNED,
  });
  try {
    assert.deepEqual(off.snap().learnedMemory, { enabled: false, learnerBuilt: false });
  } finally {
    fs.rmSync(off.dir, { recursive: true, force: true });
  }

  const on = await applyWith({
    tomlBody: '[proactive]\nmaxPerHour = 5\n',
    knowledge: STATIC_KB,
    learned: LEARNED,
  });
  try {
    assert.deepEqual(on.snap().learnedMemory, { enabled: true, learnerBuilt: true });
  } finally {
    fs.rmSync(on.dir, { recursive: true, force: true });
  }
});

test('★ 挂载日志里留了一行痕（"关掉"不能只靠观察"什么都没发生"）', async () => {
  const h = await applyWith({
    tomlBody: '[memory]\nlearned_enabled = false\n',
    knowledge: STATIC_KB,
    learned: LEARNED,
  });
  try {
    const flat = JSON.stringify(h.logs);
    assert.ok(flat.includes('学来的记忆：已关闭'), `挂载日志里必须有那一行，实际：${flat.slice(0, 400)}`);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
