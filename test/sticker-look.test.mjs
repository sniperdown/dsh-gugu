/**
 * 「发之前亲眼看一眼这张表情包」—— `look_sticker` 工具 / `gateway.lookFromTool`（2026-10-19）。
 *
 * ## 为什么单开一个文件
 *
 * 这一批钉的是**成本口径**：用户拍板「别每张都看」——
 *   - 条目自带非空 `desc` ⇒ **一次模型都不调**（`fromCache:true`）；
 *   - 没有 `desc` ⇒ 读文件字节、走**已有**的识图链路（`imageDescriber.describeDetailed`），
 *     并且把描述**写回库**（下次就直接命中上面那条）；
 *   - 同会话 **10 秒内最多现看一次**（识图有成本），超了要**说还剩几秒**，
 *     不能让她误以为"识别失败"去重试。
 *
 * ## 约束
 *
 * - **出站安全**：`look_sticker` **不发消息**。这里连 transport 都换成"一调就抛"的桩，
 *   一条都到不了 QQ（也不需要真 NapCat）。
 * - 不读本机真实数据：库全在 `mkdtemp` 的临时目录里，`dir` / `indexPath` / `auditPath` 显式注入。
 * - 不做随机断言：`md5` 全部给定，不走 `pick` 的加权随机（挑不出候选那几条只断言 `ok:false`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Gateway } from '../src/dsh/gateway.mjs';
import { SessionBinder } from '../src/dsh/binding.mjs';
import { STICKER_DESC_CHARS } from '../src/dsh/image-desc.mjs';
import {
  STICKER_INDEX_VERSION,
  createStickerLibrary,
} from '../src/dsh/sticker-library.mjs';

const T0 = Date.UTC(2026, 9, 19, 0, 0, 0);

/** 一个像 md5 但一定不是整数索引形式的键（32 位十六进制，首位是字母）。 */
const md5Of = (i) => `b${i.toString(16).padStart(31, '0')}`;

/** 一张最小 PNG（只满足 magic 判定，内容由 seed 决定）。 */
function pngBytes(seed) {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b[8] = 0x00; b[9] = 0x00; b[10] = 0x00; b[11] = 0x0d;
  b[12] = seed % 256; b[13] = (seed * 7) % 256;
  return b;
}

/**
 * 一个隔离的表情包库：临时目录 + 真的 PNG 文件 + 手写索引。
 *
 * ⚠️ 文件**必须真的写**：`pathOf()` 会 `statSync` 一遍，只写索引不写文件
 * 会变成"文件不在盘上"那条分支（那样就测不到识图了）。
 *
 * @param {Array<{md5: string, tags?: string[], desc?: string, seed?: number}>} entries
 */
function makeLibrary(entries = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-look-'));
  const dir = path.join(root, 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(root, 'qq-stickers.json');
  const auditPath = path.join(root, 'sticker-audit', 'index.jsonl');
  const map = {};
  for (const [i, e] of entries.entries()) {
    const file = `${e.md5}.png`;
    fs.writeFileSync(path.join(dir, file), pngBytes(e.seed ?? i + 1));
    map[e.md5] = {
      file,
      path: '',
      emojiId: '',
      packageId: null,
      at: new Date(T0).toISOString(),
      seen: 0,
      uses: 0,
      lastUsedAt: null,
      tags: e.tags ?? [],
      desc: e.desc ?? '',
      source: { chatId: '', userId: '' },
    };
  }
  fs.writeFileSync(indexPath, JSON.stringify({
    version: STICKER_INDEX_VERSION,
    updatedAt: new Date(T0).toISOString(),
    entries: map,
  }, null, 2));
  const library = createStickerLibrary({
    dir,
    indexPath,
    auditPath,
    log: () => {},
    now: () => T0,
  });
  return { root, dir, indexPath, auditPath, library };
}

/** 假的识图链路：记下每次输入，可按需抛错。 */
function fakeDescriber({ text = '一只笑得很欠的青蛙', throws = false } = {}) {
  const calls = [];
  return {
    calls,
    canUseVision: () => true,
    async describeDetailed(input, options) {
      calls.push({ input, options });
      if (throws) throw new Error('模型挂了');
      return { text, source: 'vision' };
    },
  };
}

/**
 * 只装了 look 它能用到的那几个依赖的网关。
 *
 * ⚠️ transport 是**一调就抛**的桩：这个工具本来就不该发消息，
 *    真发出去会在这里立刻暴露（而不是悄悄多发一条到 QQ）。
 */
function makeGateway({ library, describer }) {
  return new Gateway({
    transport: {
      async sendToChat() {
        throw new Error('look_sticker 不该发消息');
      },
    },
    stickerLibrary: library,
    imageDescriber: describer,
    log: () => {},
  });
}

const SESSION = 'qq-private-30000001';

// ================================================================== 有描述：不走识图

test('★★ lookFromTool：条目自带 desc ⇒ 直接返回，一次识图都不调（fromCache:true）', async () => {
  const X = md5Of(1);
  const { library } = makeLibrary([{ md5: X, desc: '一只笑得很欠的青蛙', tags: ['玩梗接梗'] }]);
  // 桩里只要被调用就抛 ⇒ 用"没抛"证明它真的没走识图。
  const describer = fakeDescriber({ throws: true });
  const gateway = makeGateway({ library, describer });

  const got = await gateway.lookFromTool({ sessionKey: SESSION, md5: X });

  assert.deepEqual(got, {
    ok: true,
    md5: X,
    desc: '一只笑得很欠的青蛙',
    tags: ['玩梗接梗'],
    fromCache: true,
    note: '不用现看，库里已经有这张的描述：一只笑得很欠的青蛙',
  });
  assert.equal(describer.calls.length, 0, '有描述就不该调识图（"别每张都看"那条）');
});

test('★ lookFromTool：有描述时**频率闸也不该挡**（它是零成本的）', async () => {
  const X = md5Of(1);
  const { library } = makeLibrary([{ md5: X, desc: '画面描述' }]);
  const describer = fakeDescriber();
  const gateway = makeGateway({ library, describer });
  // 先让这个会话"刚现看过一张"，占住 10 秒窗口。
  gateway.lookToolLastAt.set(SESSION, 1000);

  const got = await gateway.lookFromTool({ sessionKey: SESSION, md5: X, now: 2000 });
  assert.equal(got.ok, true);
  assert.equal(got.fromCache, true, '零成本那条路不该被识图频率闸挡住');
});

// ================================================================== 没描述：现看 + 回写

test('★★ lookFromTool：没有 desc ⇒ 读文件字节走识图，并把描述写回库（落盘）', async () => {
  const X = md5Of(2);
  const { library, dir, indexPath, auditPath } = makeLibrary([
    { md5: X, desc: '', tags: ['卖萌可爱'] },
  ]);
  const describer = fakeDescriber({ text: '一只歪头卖萌的猫' });
  const gateway = makeGateway({ library, describer });

  const got = await gateway.lookFromTool({ sessionKey: SESSION, md5: X, now: T0 });

  assert.equal(got.ok, true);
  assert.equal(got.md5, X);
  assert.equal(got.desc, '一只歪头卖萌的猫');
  assert.deepEqual(got.tags, ['卖萌可爱']);
  assert.equal(got.fromCache, false);
  assert.match(got.note, /现看了一眼/);

  // 真的走了识图：字节 + 格式 + 表情包口径的字数都传对了。
  assert.equal(describer.calls.length, 1);
  const { input, options } = describer.calls[0];
  assert.ok(input.data instanceof Uint8Array, '必须把文件字节交给识图链路');
  assert.equal(input.mediaType, 'image/png');
  assert.equal(options.maxChars, STICKER_DESC_CHARS, '描述口径和审核那一步一致（20 字上下）');

  // 内存里 + 盘上都要有（"用一次补一条"必须真的补进库，否则下次还得花钱）。
  assert.equal(library.get(X).desc, '一只歪头卖萌的猫');
  const reopened = createStickerLibrary({ dir, indexPath, auditPath, log: () => {}, now: () => T0 });
  assert.equal(reopened.get(X).desc, '一只歪头卖萌的猫', '回写必须落盘 —— 重启后不能又变回没描述');

  // 下一次同一张 ⇒ 直接命中 desc，不再调识图。
  const again = await gateway.lookFromTool({ sessionKey: SESSION, md5: X, now: T0 + 60_000 });
  assert.equal(again.fromCache, true);
  assert.equal(describer.calls.length, 1, '补过描述之后就不该再花第二次钱');
});

test('★ lookFromTool：识图返回空串 ⇒ ok:false（不把"没看成"当成看过），库里的 desc 保持空', async () => {
  const X = md5Of(3);
  const { library } = makeLibrary([{ md5: X, desc: '' }]);
  const gateway = makeGateway({ library, describer: fakeDescriber({ text: '   ' }) });

  const got = await gateway.lookFromTool({ sessionKey: SESSION, md5: X, now: T0 });
  assert.equal(got.ok, false);
  assert.match(got.note, /没给出描述/);
  assert.equal(library.get(X).desc, '', '没看成不能写一个空描述进库');
});

// ================================================================== 失败不冒泡

test('★★ lookFromTool：识图抛错 ⇒ ok:false、异常不冒泡、不把库写脏', async () => {
  const X = md5Of(4);
  const { library } = makeLibrary([{ md5: X, desc: '' }]);
  const describer = fakeDescriber({ throws: true });
  const gateway = makeGateway({ library, describer });

  const got = await gateway.lookFromTool({ sessionKey: SESSION, md5: X, now: T0 });

  assert.equal(got.ok, false, '失败要以 ok:false 表达，不能 reject');
  assert.match(got.note, /识图出错了/);
  assert.equal(got.md5, X, '失败时也要把"看的是哪一张"带回去');
  assert.equal(library.get(X).desc, '');
  assert.equal(describer.calls.length, 1);
});

test('★ lookFromTool：文件不在盘上 ⇒ ok:false（不猜一张别的图）', async () => {
  const X = md5Of(5);
  const { library, dir } = makeLibrary([{ md5: X, desc: '' }]);
  fs.rmSync(path.join(dir, `${X}.png`));
  const describer = fakeDescriber();
  const gateway = makeGateway({ library, describer });

  const got = await gateway.lookFromTool({ sessionKey: SESSION, md5: X, now: T0 });
  assert.equal(got.ok, false);
  assert.match(got.note, /不在盘上/);
  assert.equal(describer.calls.length, 0, '文件都没有，不该白花一次识图');
});

test('★ lookFromTool：没有视觉服务（canUseVision=false）⇒ ok:false，且不调识图', async () => {
  const X = md5Of(6);
  const { library } = makeLibrary([{ md5: X, desc: '' }]);
  const describer = {
    calls: [],
    canUseVision: () => false,
    async describeDetailed() {
      this.calls.push(1);
      return { text: '不该被调用' };
    },
  };
  const gateway = makeGateway({ library, describer });

  const got = await gateway.lookFromTool({ sessionKey: SESSION, md5: X, now: T0 });
  assert.equal(got.ok, false);
  assert.match(got.note, /没有可用的识图服务/);
  assert.equal(describer.calls.length, 0);
});

// ================================================================== 频率闸

test('★★ lookFromTool：同会话 10 秒内最多现看一次 —— 第二次 ok:false 并报还剩几秒', async () => {
  const X = md5Of(7);
  const Y = md5Of(8);
  const Z = md5Of(14);
  const { library } = makeLibrary([
    { md5: X, desc: '', seed: 7 },
    { md5: Y, desc: '', seed: 8 },
    { md5: Z, desc: '', seed: 9 },
  ]);
  const describer = fakeDescriber({ text: '画面描述' });
  const gateway = makeGateway({ library, describer });

  const first = await gateway.lookFromTool({ sessionKey: SESSION, md5: X, now: 100_000 });
  assert.equal(first.ok, true);
  assert.equal(describer.calls.length, 1);

  const second = await gateway.lookFromTool({ sessionKey: SESSION, md5: Y, now: 103_000 });
  assert.equal(second.ok, false);
  assert.equal(second.md5, Y, '"看的是哪一张"照样要说清');
  assert.match(second.note, /7 秒后才能再看/, '10 秒窗口里还剩 7 秒要说出来，别让她以为识别失败');
  assert.equal(describer.calls.length, 1, '被闸住的那次不能真的调识图');

  // 另一个会话不受影响（闸是按会话算的）。
  const other = await gateway.lookFromTool({ sessionKey: 'qq-group-30000012', md5: Y, now: 103_000 });
  assert.equal(other.ok, true);
  assert.equal(describer.calls.length, 2);

  // 窗口过了就放行（用第三张，避免上一轮的回写让它走 fromCache）。
  const later = await gateway.lookFromTool({ sessionKey: SESSION, md5: Z, now: 110_001 });
  assert.equal(later.ok, true);
  assert.equal(describer.calls.length, 3);
});

// ================================================================== 选不中

test('★ lookFromTool：md5 不在库 ⇒ ok:false，连识图都不调', async () => {
  const X = md5Of(9);
  const ghost = md5Of(99);
  const { library } = makeLibrary([{ md5: X, desc: '画面描述' }]);
  const describer = fakeDescriber();
  const gateway = makeGateway({ library, describer });

  const got = await gateway.lookFromTool({ sessionKey: SESSION, md5: ghost });
  assert.equal(got.ok, false);
  assert.match(got.note, /库里没有这张表情包/);
  assert.equal(describer.calls.length, 0);
});

test('★ lookFromTool：挑不出候选 ⇒ 库空 / 没有这个标签，都 ok:false', async () => {
  const empty = makeLibrary([]);
  const emptyGateway = makeGateway({ library: empty.library, describer: fakeDescriber() });
  // 全库挑（不给标签）⇒ 空库要报"库是空的"。⚠️ 和 `sendFromTool` 同一口径：
  // 给了标签却挑不出时，报的应该是"没有这一类"，不是"库是空的"。
  const noCandidates = await emptyGateway.lookFromTool({ sessionKey: SESSION });
  assert.equal(noCandidates.ok, false);
  assert.match(noCandidates.note, /表情包库是空的/);

  const X = md5Of(10);
  const one = makeLibrary([{ md5: X, desc: '画面描述', tags: ['卖萌可爱'] }]);
  const oneGateway = makeGateway({ library: one.library, describer: fakeDescriber() });
  const wrongTag = await oneGateway.lookFromTool({ sessionKey: SESSION, tags: ['生气不满'] });
  assert.equal(wrongTag.ok, false);
  assert.match(wrongTag.note, /库里没有「生气不满」这类表情包/);
});

test('★ lookFromTool：sessionKey 认不出 ⇒ ok:false（频率闸按会话算，认不出没法记）', async () => {
  const X = md5Of(11);
  const { library } = makeLibrary([{ md5: X, desc: '画面描述' }]);
  const gateway = makeGateway({ library, describer: fakeDescriber() });

  for (const sessionKey of ['', 'group:123', 'session-abc', null]) {
    const got = await gateway.lookFromTool({ sessionKey, md5: X });
    assert.equal(got.ok, false);
    assert.match(got.note, /认不出这个会话键/);
  }
});

test('★ lookFromTool：表情包库没接上 ⇒ ok:false（不是必需品，但要说清）', async () => {
  const gateway = makeGateway({ library: null, describer: fakeDescriber() });
  const got = await gateway.lookFromTool({ sessionKey: SESSION, md5: md5Of(12) });
  assert.equal(got.ok, false);
  assert.match(got.note, /表情包库没接上/);
});

test('★ lookFromTool：老写法 tag（单个标签）也能用', async () => {
  const X = md5Of(13);
  const { library } = makeLibrary([{ md5: X, desc: '画面描述', tags: ['玩梗接梗'] }]);
  const gateway = makeGateway({ library, describer: fakeDescriber() });

  const got = await gateway.lookFromTool({ sessionKey: SESSION, tag: '玩梗接梗' });
  assert.equal(got.ok, true);
  assert.equal(got.md5, X);
  assert.equal(got.fromCache, true);
});

// ================================================================== 工具注册（binding）

/** 假 agent：只在 agent 作用域上带 `tools.register`，并记下注册了什么。 */
function fakeAgentWithTools() {
  const registrations = [];
  const agent = {
    session: { header: { cwd: 'H:\\work' }, deriveMessages: () => [] },
    followup() {},
    async whenIdle() {},
    ctx: {
      tools: {
        register(tool) {
          registrations.push(tool);
          return () => {};
        },
      },
    },
  };
  agent.registrations = registrations;
  return agent;
}

/** 假 ctx.agents：create / resume 都在返回前跑一遍 `setup(agentCtx)`（真实行为）。 */
function agentsWithSetup(agent) {
  const run = async (options) => {
    if (typeof options.setup === 'function') await options.setup(agent.ctx);
    return { agent, dispose: async () => {} };
  };
  return {
    async create(options) {
      return run(options);
    },
    async resume(options) {
      return run(options);
    },
  };
}

test('★ registerLookTool：注册 `look_sticker`，execute 把参数原样交给注入的 lookTool', async () => {
  const agent = fakeAgentWithTools();
  const calls = [];
  // 桩：**绝不发消息**，只把参数带出去。
  const binder = new SessionBinder({
    ctx: {},
    lookTool: async (args) => {
      calls.push(args);
      return {
        ok: true, md5: 'abc', desc: '一只青蛙', tags: ['玩梗接梗'], fromCache: false, note: '现看了一眼：一只青蛙',
      };
    },
  });

  const ok = binder.registerLookTool(agent.ctx, SESSION, 'setup');

  assert.equal(ok, true);
  assert.equal(agent.registrations.length, 1);
  const tool = agent.registrations[0];
  assert.equal(tool.name, 'look_sticker');
  assert.match(tool.description, /发一张表情包之前拿不准这张对不对/);
  assert.match(tool.description, /没有描述的才会现看一次/);
  // 规格：md5? / tags?（数组）/ mood? —— 没有 required，三个都可省。
  assert.deepEqual(Object.keys(tool.parameters.properties), ['md5', 'tags', 'mood']);
  assert.equal(tool.parameters.required, undefined);
  assert.equal(tool.parameters.properties.tags.type, 'array');

  // execute：trim 后把 `{sessionKey, md5, tags, mood}` 交给注入的函数。
  const result = await tool.execute({
    md5: '  b01  ',
    tags: [' 玩梗接梗 ', ''],
    mood: ' 被逗笑又无语 ',
  });
  assert.deepEqual(result, {
    ok: true, md5: 'abc', desc: '一只青蛙', tags: ['玩梗接梗'], fromCache: false, note: '现看了一眼：一只青蛙',
  });
  assert.deepEqual(calls, [{
    sessionKey: SESSION, md5: 'b01', tags: ['玩梗接梗'], mood: '被逗笑又无语',
  }]);

  // 什么都不给也合法（交给网关按全库挑一张）。
  await tool.execute({});
  assert.deepEqual(calls[1], { sessionKey: SESSION });

  // 坏的 tags 形状在工具层就拦下（别让坏参数走到网关）。
  await assert.rejects(() => tool.execute({ tags: '玩梗接梗' }), /tags 必须是数组/);
  assert.equal(calls.length, 2, '坏参数不该调用 lookTool');

  // output.render 用 note 出一段文本。
  const rendered = tool.output.render({}, result);
  assert.deepEqual(rendered, [{ type: 'text', text: '现看了一眼：一只青蛙' }]);
  assert.deepEqual(
    tool.output.render({}, { ok: true, md5: '', desc: '只有描述', tags: [], fromCache: true, note: '' }),
    [{ type: 'text', text: '只有描述' }],
    'note 为空时用 desc 兜底',
  );
});

test('★ registerLookTool：setup 建会话时自动注册；复用分支再补一次', async () => {
  const createdAgent = fakeAgentWithTools();
  const lookTool = async () => ({
    ok: true, md5: '', desc: '', tags: [], fromCache: false, note: '',
  });
  const binder = new SessionBinder({ ctx: { agents: agentsWithSetup(createdAgent) }, lookTool });

  await binder.ensure(SESSION);
  assert.equal(
    createdAgent.registrations.filter((t) => t.name === 'look_sticker').length,
    1,
    'setup 上必须把 look_sticker 挂给她',
  );

  // 复用分支：这条路**不经过 setup**（热重载之后就是它）。不补一次的话，
  // 热重载后她就静默地没有这个工具了（不报错，只是不见了）。
  const liveAgent = fakeAgentWithTools();
  const live = { session: { header: { cwd: 'H:\\work' } }, ctx: liveAgent.ctx };
  const binder2 = new SessionBinder({
    ctx: {
      agents: {
        get: () => live,
        list: () => [live],
        async create() { throw new Error('不该走到 create'); },
        async resume() { throw new Error('不该走到 resume'); },
      },
    },
    lookTool,
  });
  const { created } = await binder2.ensure(SESSION);

  assert.equal(created, false);
  assert.deepEqual(
    liveAgent.registrations.map((t) => t.name),
    ['look_sticker'],
    '复用路径也必须补注册（否则热重载后工具消失）',
  );
});

test('★ registerLookTool：没有注入 lookTool 时**不注册**（未接线就别给她假工具）', async () => {
  const agent = fakeAgentWithTools();
  const logs = [];
  const binder = new SessionBinder({
    ctx: {},
    lookTool: 'nope', // 非函数一律当"没有"
    log: (level, message) => logs.push({ level, message }),
  });

  assert.equal(binder.registerLookTool(agent.ctx, SESSION, 'setup'), false);
  assert.equal(agent.registrations.length, 0, '一个工具都不该注册');
  assert.ok(
    logs.some((l) => l.level === 'debug' && /没有注入 lookTool/.test(l.message)),
    `未接线要留一条 debug，实际：${JSON.stringify(logs)}`,
  );
});

test('★ registerLookTool：重复注册**幂等**（返回 false + debug，不抛、不再打扰宿主）', async () => {
  const logs = [];
  const already = new Set();
  let hostCalls = 0;
  const agent = fakeAgentWithTools();
  agent.ctx.tools.register = (tool) => {
    hostCalls += 1;
    if (already.has(tool.name)) throw new Error(`工具 ${tool.name} 已经注册过了`);
    already.add(tool.name);
    return () => {};
  };
  const binder = new SessionBinder({
    ctx: {},
    lookTool: async () => ({
      ok: true, md5: '', desc: '', tags: [], fromCache: false, note: '',
    }),
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  assert.equal(binder.registerLookTool(agent.ctx, SESSION, 'setup'), true);
  // 关键：这里**不能 throw** —— 调用点在 `setup` 里，抛出去等于这个会话建不起来。
  assert.equal(binder.registerLookTool(agent.ctx, SESSION, 'reuse'), false);
  assert.equal(hostCalls, 1, '判重之后不该再调宿主 register');

  const warnings = logs.filter((l) => l.level === 'warn');
  assert.equal(warnings.length, 0, `重复注册不该留 warn，实际：${JSON.stringify(logs)}`);
  assert.ok(
    logs.some((l) => l.level === 'debug' && /看表情包的工具已经在这个 agent 上注册过/.test(l.message)),
    `该有一条 debug 说明跳过了，实际：${JSON.stringify(logs)}`,
  );
});
