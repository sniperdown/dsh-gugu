/**
 * 跨插件热重载：工具执行走**中转表**、工具/ section 注册**幂等**。
 *
 * ## 为什么单开一个文件
 *
 * agent 现在挂在 `ctx.root` 上（跨插件热重载存活），注册在 agentCtx 上的
 * `tools.register()` / `systemPrompt.section()` 是 **effect**，也跟着一起活着。
 * HMR 之后新实例走「收养」，**同一个 agentCtx 上二次注册会抛重复**：
 *   - 工具：旧注册继续生效，而它的闭包捕获的旧 gateway 的 transport 已经 `stop()`
 *     ⇒ 工具**静默失效**（不报错、只是不再干活）。
 *   - persona：旧 section 继续生效，`text` 闭包捕获旧实例 ⇒ 改 `qq-gugu.toml`
 *     不再生效。
 *
 * 这里钉三件事：
 *   ① 工具 `execute` **运行时查中转表**（由每个插件实例覆盖），旧注册也能打到新实例；
 *   ② 收养时重复注册**幂等**：不抛、不吞错、只留 debug；
 *   ③ 中转表没接线时返回 `ok:false`，**不抛**。
 *
 * ## 出站安全
 * 全部替身：没有任何 transport，执行器都是本地函数。**一条消息都到不了 QQ。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionBinder, publishToolBridge } from '../src/dsh/binding.mjs';

const KEY = 'qq-private-30000001';

/**
 * 假 agentCtx：带宿主的 `tools.register`（**重复注册会抛**，与真宿主一致）与
 * 可选的 `systemPrompt.section`（同样**重复会抛**）。
 */
function fakeAgentCtx({ withSection = false } = {}) {
  /** @type {object[]} */
  const registrations = [];
  const tools = new Map();
  const sections = new Map();
  const ctx = {
    tools: {
      // 私聊不走 restrict；给一个空实现，免得将来改成群会话时炸。
      restrict: () => () => {},
      register(tool) {
        if (tools.has(tool.name)) {
          throw new Error(`tool "${tool.name}" is already registered in this scope`);
        }
        registrations.push(tool);
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
      // 真宿主的 `get(name)` 只读**全局视图**（scoped 工具读不到）——
      // 所以实现里判重靠的是挂在 ctx 上的台账，不是这个。
      get: () => undefined,
      // 2026-11-04：按需加载（`setupOnDemandTools`）会先读一次可见工具表。
      // 这个替身代表"没有可延迟工具"的宿主 —— 真宿主的 `schemas()` 一定存在。
      schemas: () => [],
    },
  };
  if (withSection) {
    ctx.systemPrompt = {
      section(section) {
        if (sections.has(section.name)) {
          throw new Error(`prompt section "${section.name}" is already registered in this scope`);
        }
        sections.set(section.name, section);
        return () => sections.delete(section.name);
      },
      getSectionOrder: () => 0,
    };
  }
  return { ctx, registrations, tools, sections };
}

/** 收集日志，断言级别用。 */
function collectLogs() {
  const logs = [];
  return { logs, log: (level, message, meta) => logs.push({ level, message, meta }) };
}

const SEND_ITEMS = [{ kind: 'text', text: '嗨' }];

// ---------------------------------------------- ① 重载之后，旧注册打到新实例

test('★ 重载：send_qq 的 execute 查中转表 —— 新实例启动后打到新实例，不绑旧闭包', async () => {
  // 干净起点：别让别的测试文件留下的值混进来。
  publishToolBridge({ send: null, look: null, voice: null });

  const a = { send: [] };
  const b = { send: [] };
  const agent = fakeAgentCtx();

  // 「上一代实例」：注册工具时把它自己的执行器写进中转表（构造器里做的，与生产一致）。
  const binderA = new SessionBinder({
    ctx: {},
    log: () => {},
    sendTool: async (args) => {
      a.send.push(args);
      return { ok: true, sent: 1, note: 'A 发的' };
    },
  });
  assert.equal(binderA.registerSendTool(agent.ctx, KEY, 'setup'), true);
  const tool = agent.registrations.find((t) => t.name === 'send_qq');
  assert.ok(tool, 'send_qq 应该被注册上');

  assert.deepEqual(
    await tool.execute({ sessionKey: KEY, items: SEND_ITEMS }),
    { ok: true, sent: 1, note: 'A 发的' },
  );
  assert.equal(a.send.length, 1);

  // 「新一代实例」：HMR 之后构造 —— 构造器会把 B 的执行器写进中转表。
  // 注意**不**在同一个 agentCtx 上重新注册工具（那会抛重复），这正是要复现的形状。
  const binderB = new SessionBinder({
    ctx: {},
    log: () => {},
    sendTool: async (args) => {
      b.send.push(args);
      return { ok: true, sent: 1, note: 'B 发的' };
    },
  });
  assert.equal(binderB.registerSendTool(agent.ctx, KEY, 'setup'), false, '同一 agentCtx 上重复注册应当被台账挡下');

  // 旧注册（tool）现在必须打到 B —— 证明它查的是表，不是闭包。
  assert.deepEqual(
    await tool.execute({ sessionKey: KEY, items: SEND_ITEMS }),
    { ok: true, sent: 1, note: 'B 发的' },
  );
  assert.equal(a.send.length, 1, 'A 只该收到换实例之前那一次');
  assert.equal(b.send.length, 1);
});

// ---------------------------------------------- ② 收养时重复注册幂等

test('★ 收养：重复注册**幂等**（返回 false + debug，不抛、不再打扰宿主）', () => {
  publishToolBridge({ send: null, look: null, voice: null });
  const agent = fakeAgentCtx();
  const { logs, log } = collectLogs();
  const binder = new SessionBinder({
    ctx: {},
    log,
    sendTool: async () => ({ ok: true, sent: 0, note: 'x' }),
  });

  assert.equal(binder.registerSendTool(agent.ctx, KEY, 'setup'), true);
  assert.equal(binder.registerSendTool(agent.ctx, KEY, 'reuse'), false);
  assert.ok(logs.some((l) => l.level === 'debug' && /已经在这个 agent 上注册过/.test(l.message)));
  assert.equal(agent.registrations.filter((t) => t.name === 'send_qq').length, 1);
});

test('收养：persona section 重复注册**不抛**，且不会多挂段落', () => {
  const agent = fakeAgentCtx({ withSection: true });
  const binder = new SessionBinder({ ctx: {}, log: () => {}, persona: '你是一只测试用的小鲸鱼。' });
  assert.equal(binder.applyPersona(agent.ctx, KEY, 'setup'), true);
  const after = agent.sections.size;
  // 第二次（收养路径）宿主会抛"already registered" —— 必须被吞成 debug，不能冒泡。
  assert.doesNotThrow(() => binder.applyPersona(agent.ctx, KEY, 'reuse'));
  assert.equal(agent.sections.size, after, '重复调用不该多注册段落');
});

// ---------------------------------------------- ③ 没接线 ⇒ 明确失败，不抛

test('没注入执行器 ⇒ 不注册工具（别给她一个只会报错的空壳）', () => {
  publishToolBridge({ send: null, look: null, voice: null });
  const agent = fakeAgentCtx();
  const { logs, log } = collectLogs();
  const binder = new SessionBinder({ ctx: {}, log });

  assert.equal(binder.registerSendTool(agent.ctx, KEY, 'setup'), false);
  assert.equal(agent.registrations.length, 0);
  assert.ok(logs.some((l) => l.level === 'debug' && /没有注入 sendTool/.test(l.message)));
});

test('中转表被清空 ⇒ execute 返回 ok:false（旧注册也不抛）', async () => {
  publishToolBridge({ send: null, look: null, voice: null });
  const agent = fakeAgentCtx();
  const binder = new SessionBinder({
    ctx: {},
    log: () => {},
    sendTool: async () => ({ ok: true, sent: 1, note: 'ok' }),
  });
  binder.registerSendTool(agent.ctx, KEY, 'setup');
  const tool = agent.registrations.find((t) => t.name === 'send_qq');

  // 模拟"插件停了、表被清空"，而旧注册还活着。
  publishToolBridge({ send: null });
  const result = await tool.execute({ sessionKey: KEY, items: SEND_ITEMS });
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
});

test('中转表只认函数：写了非函数 ⇒ 当没接线', async () => {
  publishToolBridge({ send: null, look: null, voice: null });
  const agent = fakeAgentCtx();
  const binder = new SessionBinder({
    ctx: {},
    log: () => {},
    sendTool: async () => ({ ok: true, sent: 1, note: 'ok' }),
  });
  binder.registerSendTool(agent.ctx, KEY, 'setup');
  const tool = agent.registrations.find((t) => t.name === 'send_qq');

  publishToolBridge({ send: 'not-a-function' });
  assert.equal((await tool.execute({ sessionKey: KEY, items: SEND_ITEMS })).ok, false);
});
