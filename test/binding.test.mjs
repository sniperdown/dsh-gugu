/**
 * DSH 绑定层测试。
 *
 * 分两部分：
 * 1. 纯函数的文本抽取——消息的具体形状是构建产物里最不确定的地方，
 *    所以这里对多种形状都压了用例。
 * 2. `SessionBinder` 的会话管理——用假 `ctx.agents` 与假 handle，
 *    验证"优先 resume、失败则 create""同一会话串行""只取本轮新增发言"
 *    这些真机上最容易出错的行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMessageText,
  isAssistantMessage,
  lastAssistantText,
  assistantTextSince,
  assistantTextAfterMessage,
  extractStreamText,
  SessionBinder,
  sessionKeyForChat,
  DEFAULT_GROUP_DENY_TOOLS,
  GROUP_DENY_HOST_PREFIXES,
  GROUP_DENY_HOST_EXACT,
  pickGroupDeniedHostTools,
  DEFAULT_ON_DEMAND_PREFIXES,
  ON_DEMAND_SECTION,
  ON_DEMAND_TOOL_NAME,
  oneLineOf,
  pickOnDemandTools,
  renderToolCatalog,
  normalizeToolNames,
  resolveGroupDenyTools,
  resolveSessionPreset,
  GROUP_PRESET_SUFFIX,
  sessionKindOf,
} from '../src/dsh/binding.mjs';
import { createSessionMap, createSessionResolver } from '../src/dsh/chat-sessions.mjs';

const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);

// ---------------------------------------------------------------- 文本抽取

test('extractMessageText：内容块数组（最可能的形状）', () => {
  assert.equal(
    extractMessageText({ role: 'assistant', content: [{ type: 'text', text: '你好' }] }),
    '你好',
  );
});

test('extractMessageText：多个文本块拼接', () => {
  assert.equal(
    extractMessageText({
      content: [
        { type: 'text', text: '第一段' },
        { type: 'tool_use', name: 'x' },
        { type: 'text', text: '第二段' },
      ],
    }),
    '第一段第二段',
    '非文本块应被跳过',
  );
});

test('extractMessageText：纯字符串 content', () => {
  assert.equal(extractMessageText({ content: '直接是字符串' }), '直接是字符串');
});

test('extractMessageText：text 字段兜底', () => {
  assert.equal(extractMessageText({ text: '兜底字段' }), '兜底字段');
});

test('extractMessageText：裸字符串也接受', () => {
  assert.equal(extractMessageText('裸字符串'), '裸字符串');
});

test('extractMessageText：没有可用文本时返回 null', () => {
  for (const bad of [
    null,
    undefined,
    42,
    {},
    { content: '' },
    { content: [] },
    { content: [{ type: 'image', source: {} }] },
    { text: '' },
    [],
  ]) {
    assert.equal(extractMessageText(bad), null, JSON.stringify(bad));
  }
});

test('extractMessageText：内容块里 text 不是字符串时跳过', () => {
  assert.equal(extractMessageText({ content: [{ type: 'text', text: 123 }] }), null);
});

// ---------------------------------------------------------------- 助手判定

test('isAssistantMessage：只看 role', () => {
  assert.equal(isAssistantMessage({ role: 'assistant' }), true);
  assert.equal(isAssistantMessage({ role: 'user' }), false);
  assert.equal(isAssistantMessage({ role: 'system' }), false);
  assert.equal(isAssistantMessage(null), false);
  assert.equal(isAssistantMessage('assistant'), false, '字符串不是消息对象');
});

test('lastAssistantText：取最后一条非空助手发言，跳过工具消息', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第一次回答' }] },
    { role: 'tool', content: [{ type: 'text', text: '工具输出' }] },
    { role: 'assistant', content: [{ type: 'text', text: '最终回答' }] },
  ];
  assert.equal(lastAssistantText(messages), '最终回答');
});

test('lastAssistantText：末尾是空助手消息时往前找', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: '有内容' }] },
    { role: 'assistant', content: [] },
  ];
  assert.equal(lastAssistantText(messages), '有内容');
});

test('lastAssistantText：没有助手发言时返回 null', () => {
  assert.equal(lastAssistantText([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]), null);
  assert.equal(lastAssistantText([]), null);
  assert.equal(lastAssistantText(null), null);
});

// ---------------------------------------------------------------- 只取本轮新增

test('assistantTextSince：只认本轮新增的发言（关键：不能把上一轮的回复又发一遍）', () => {
  const before = [
    { role: 'user', content: [{ type: 'text', text: '第一个问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第一个回答' }] },
  ];
  const after = [
    ...before,
    { role: 'user', content: [{ type: 'text', text: '第二个问题' }] },
    // 本轮模型没说话（比如决定不回复）
  ];
  assert.equal(assistantTextSince(after, before.length), null, '本轮没说话就不该复用上一轮的回复');

  const withReply = [
    ...after,
    { role: 'assistant', content: [{ type: 'text', text: '第二个回答' }] },
  ];
  assert.equal(assistantTextSince(withReply, before.length), '第二个回答');
});

test('assistantTextSince：since 非法或越界时安全处理', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }];
  assert.equal(assistantTextSince(messages, 0), 'a', 'since=0 视为从头算');
  assert.equal(assistantTextSince(messages, -5), 'a');
  assert.equal(assistantTextSince(messages, 999), null, 'since 越界 -> 空切片 -> null');
  assert.equal(assistantTextSince(null, 0), null);
});

// ---------------------------------------------------------------- 假 agent 脚手架

/**
 * 造一个假 agent：`followup` 会把预置的回复追加进消息数组，`whenIdle` 立刻返回。
 * @param {object} [options]
 */
function fakeAgent({ replyQueue = [], onFollowup } = {}) {
  const messages = [];
  let followups = 0;
  let idleWaits = 0;
  const agent = {
    session: {
      deriveMessages: () => messages.map((m) => ({ ...m })),
    },
    followup(payload) {
      followups += 1;
      messages.push({ role: 'user', content: payload.content });
      if (onFollowup !== undefined) onFollowup(payload, messages);
      const reply = replyQueue.shift();
      if (reply !== undefined && reply !== null) {
        messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      }
    },
    async whenIdle() {
      idleWaits += 1;
    },
    get followupCount() {
      return followups;
    },
    get idleWaits() {
      return idleWaits;
    },
    messages,
  };
  return agent;
}

/** 造一个假 ctx.agents。 */
function fakeAgents({ resumeFails = false, replyQueue = [], onFollowup } = {}) {
  const created = [];
  const resumed = [];
  const disposed = [];
  const agents = {
    async create(options) {
      created.push(options);
      const agent = fakeAgent({ replyQueue: replyQueue.slice(), onFollowup });
      return {
        agent,
        async dispose() {
          disposed.push(options.sessionId ?? options.resumeSessionId);
        },
      };
    },
    async resume(options) {
      resumed.push(options);
      if (resumeFails) throw new Error('没有可恢复的会话');
      return {
        agent: fakeAgent({ replyQueue: replyQueue.slice(), onFollowup }),
        async dispose() {
          disposed.push(options.resumeSessionId);
        },
      };
    },
  };
  return { agents, created, resumed, disposed };
}

// ---------------------------------------------------------------- Binder

test('ensure：优先 resume（重启后要接回原对话，而不是新开失忆的会话）', async () => {
  const { agents, created, resumed } = fakeAgents();
  const binder = new SessionBinder({ ctx: { agents } });
  await binder.ensure('qq-group-100');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].resumeSessionId, 'qq-group-100');
  assert.equal(created.length, 0, 'resume 成功就不该再 create');
});

test('ensure：resume 失败时回退到 create', async () => {
  const { agents, created, resumed } = fakeAgents({ resumeFails: true });
  const binder = new SessionBinder({ ctx: { agents } });
  await binder.ensure('qq-group-100');
  assert.equal(resumed.length, 1);
  assert.equal(created.length, 1, 'resume 失败后必须 create');
  assert.equal(created[0].sessionId, 'qq-group-100');
});

test('ensure：同一会话第二次不会重复创建', async () => {
  const { agents, created, resumed } = fakeAgents();
  const binder = new SessionBinder({ ctx: { agents } });
  const first = await binder.ensure('qq-group-100');
  const second = await binder.ensure('qq-group-100');
  assert.equal(second.created, false);
  assert.equal(first.handle, second.handle, '应复用同一个 handle');
  assert.equal(resumed.length, 1);
  assert.equal(created.length, 0);
});

test('ensure：不同会话各自独立', async () => {
  const { agents, resumed } = fakeAgents();
  const binder = new SessionBinder({ ctx: { agents } });
  await binder.ensure('qq-group-100');
  await binder.ensure('qq-private-2001');
  assert.deepEqual(
    resumed.map((r) => r.resumeSessionId).sort(),
    ['qq-group-100', 'qq-private-2001'],
  );
});

test('ensure：cwd 一定有值（缺了会让提示词组装在步骤内抛错）', async () => {
  // 回归：部署人设模板里有 `{{cwd}}` 变量，值来自会话头。会话没有 cwd 时
  // 组装的不是空字符串而是**抛错**：
  //   prompt variable "{{cwd}}" has no value for this assembly
  //     (section "deployment:persona-suffix")
  // 错发生在消息被追加之前，外部只看到"会话里什么都没有、模型从不回复"，
  // 而 agent 状态却是正常的 running→idle——极难定位。
  const { agents, resumed } = fakeAgents();
  const binder = new SessionBinder({ ctx: { agents } });
  await binder.ensure('qq-group-100');
  assert.equal(typeof resumed[0].meta.cwd, 'string');
  assert.ok(resumed[0].meta.cwd.length > 0, 'cwd 不该为空');
});

test('ensure：配了 workspacePath 时用它作为 cwd', async () => {
  const { agents, resumed } = fakeAgents();
  const binder = new SessionBinder({ ctx: { agents }, config: { workspacePath: 'H:\\work' } });
  await binder.ensure('qq-group-100');
  assert.equal(resumed[0].meta.cwd, 'H:\\work');
});

test('ensure：**resume 不传 reasoningEffort**（免得盖掉会话里的 per-session 选择）', async () => {
  // 2026-10-24 线上事故：用户每次在 DSH 里给私聊选了 high/max，插件一重载就变回 low。
  // 根因是宿主 `dsh-agent-loop` 的 `prepareRequest()` 取档是
  //   `this.options.reasoningEffort ?? persistedReasoningEffort`
  // ⇒ agentOptions 里的档位**优先于**会话里持久化的选择（GUI 写的是 model/selection）。
  // 所以 resume 这一路**一个字段都不发**，把档位还给会话自己。
  const { agents, resumed } = fakeAgents();
  const binder = new SessionBinder({ ctx: { agents }, config: { reasoningEffort: 'low' } });
  await binder.ensure('qq-group-100');
  assert.equal(resumed[0].agentOptions.reasoningEffort, undefined, 'resume 不许发档位');
  assert.equal(resumed[0].agentOptions.provider, undefined, '路由照旧（这条部署没配 provider）');
});

test('ensure：**create（新会话）仍带全局 reasoningEffort** —— 便宜的起点', async () => {
  // 新会话没有"会话里存的选择"可继承，不带就会吃部署默认（max）。
  // 回归：部署默认 max 时，私聊随口一句闲聊会被当成调研跑满 50 步、堵死会话。
  const { agents, created } = fakeAgents({ resumeFails: true });
  const binder = new SessionBinder({ ctx: { agents }, config: { reasoningEffort: 'low' } });
  await binder.ensure('qq-group-100');
  assert.equal(created[0].agentOptions.reasoningEffort, 'low');
});

test('ensure：没配 reasoningEffort 时两条路都不带该字段（继承部署默认）', async () => {
  const { agents, resumed } = fakeAgents();
  const binder = new SessionBinder({ ctx: { agents } });
  await binder.ensure('qq-group-100');
  assert.equal(resumed[0].agentOptions.reasoningEffort, undefined);

  const createdRun = fakeAgents({ resumeFails: true });
  const binder2 = new SessionBinder({ ctx: { agents: createdRun.agents } });
  await binder2.ensure('qq-group-100');
  assert.equal(createdRun.created[0].agentOptions.reasoningEffort, undefined);
});

test('isEquipped：按 **agent ctx 上的台账** 判，ctx 一换就变假（要重补）', async () => {
  // 2026-10-24：旧实现用 `Set<sessionId>` 记"补过了"，ctx 换了它还记着 ⇒ 永不重补
  // （实测 GUI 触发 105 轮里 39 轮无人格）。现在判据是 ctx 上的注册台账。
  const makeCtx = () => ({
    tools: {
      register: () => () => {},
      restrict: () => () => {},
    },
    systemPrompt: {
      section: () => () => {},
      getSectionOrder: () => 100,
    },
  });
  const ctxA = makeCtx();
  const agentA = { id: 'qq-group-100', session: { id: 'qq-group-100' }, ctx: ctxA };
  const agents = {
    get: () => agentA,
    list: () => [agentA],
    async create() { throw new Error('不该走到 create'); },
    async resume() { throw new Error('不该走到 resume'); },
  };
  const binder = new SessionBinder({
    ctx: { agents },
    config: {},
    persona: '人格文本',
    sendTool: () => ({ ok: true }),
    lookTool: () => ({}),
  });
  assert.equal(binder.isEquipped(ctxA), false, '还没补 ⇒ 假');
  assert.equal(binder.equipLiveAgent('qq-group-100', 'test'), true);
  assert.equal(binder.isEquipped(ctxA), true, '补完 ⇒ 真');

  // ctx 换了（agent 重建 / HMR 后拿到新 ctx）：旧台账跟着旧 ctx，新 ctx 上什么都没有。
  const ctxB = makeCtx();
  const agentB = { id: 'qq-group-100', session: { id: 'qq-group-100' }, ctx: ctxB };
  agents.get = () => agentB;
  agents.list = () => [agentB];
  assert.equal(binder.isEquipped(ctxB), false, '新 ctx 上必须判"不齐"，否则永远不会重补');
});

// ---------------------------------------------------------------- P2-6：新聊天走新 id

/** 造一个**纯内存**的映射表 + resolver（不落盘）。 */
function makeResolver(policy) {
  const map = createSessionMap({
    mappingFile: 'X:\\nope\\qq-chat-sessions.json',
    retiredFile: 'X:\\nope\\qq-retired-sessions.json',
    log: () => {},
    persist: false,
  });
  return { map, resolver: createSessionResolver({ map, policy }) };
}

test('★ P2-6：`new-if-no-legacy` —— resume 失败（没有旧会话）⇒ 新建用 `session-<uuid>` 并写表', async () => {
  const { map, resolver } = makeResolver('new-if-no-legacy');
  const { agents, created } = fakeAgents({ resumeFails: true });
  const binder = new SessionBinder({ ctx: { agents }, resolver });
  await binder.ensure('qq-private-2001', { chatId: 'private:2001' });

  assert.equal(created.length, 1);
  const newId = created[0].sessionId;
  assert.match(newId, /^session-[0-9a-f-]{36}$/, '新聊天必须用标准 id');
  assert.equal(map.lookup('private:2001'), newId, '新 id 要写进映射表');
});

test('★ P2-6：`new-if-no-legacy` —— resume 成功（有旧会话）⇒ **继续用旧 id**，并记进表', async () => {
  const { map, resolver } = makeResolver('new-if-no-legacy');
  const { agents, resumed, created } = fakeAgents();
  const binder = new SessionBinder({ ctx: { agents }, resolver });
  await binder.ensure('qq-group-100', { chatId: 'group:100' });

  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].resumeSessionId, 'qq-group-100');
  assert.equal(created.length, 0, '有旧会话就不许新建');
  assert.equal(map.lookup('group:100'), 'qq-group-100', '旧 id 也要记进表（P3-9 迁移时要用）');
});

test('P2-6：`legacy` 策略下行为与改动前一致（resume 失败仍用原 id 新建）', async () => {
  const { map, resolver } = makeResolver('legacy');
  const { agents, created } = fakeAgents({ resumeFails: true });
  const binder = new SessionBinder({ ctx: { agents }, resolver });
  await binder.ensure('qq-group-100', { chatId: 'group:100' });

  assert.equal(created[0].sessionId, 'qq-group-100', 'legacy 不分配新 id');
  // 但"当前实际用的 id"仍然要记进表（P1-4 的积累行为，P3-9 迁移时靠它）。
  assert.equal(map.lookup('group:100'), 'qq-group-100');
});

test('P2-6：没传 chatId（老调用方）⇒ 即使策略是 new-if-no-legacy 也不分配新 id', async () => {
  const { resolver } = makeResolver('new-if-no-legacy');
  const { agents, created } = fakeAgents({ resumeFails: true });
  const binder = new SessionBinder({ ctx: { agents }, resolver });
  await binder.ensure('qq-group-100');
  assert.equal(created[0].sessionId, 'qq-group-100', '没有 chatId 就无从写表，保持旧行为');
});

test('ensure：优先复用 ctx.agents 里已存在的 agent（别去 resume 一个被持有的会话）', async () => {
  // 回归：会话可能已经由别处建好了（声明式 agent-loop 配置、或上一次 ensure）。
  // 直接 resume 会撞 `session "…" is already owned by an active write handle`，
  // 然后错误地走到 create 再失败一次。
  const liveAgent = { id: 'qq-group-100', session: { id: 'qq-group-100' } };
  const agents = {
    get: (id) => (id === 'qq-group-100' ? liveAgent : undefined),
    list: () => [liveAgent],
    async create() {
      throw new Error('不该走到 create');
    },
    async resume() {
      throw new Error('不该走到 resume');
    },
  };
  const binder = new SessionBinder({ ctx: { agents } });
  const { handle, created } = await binder.ensure('qq-group-100');
  assert.equal(created, false);
  assert.equal(handle.agent, liveAgent);
});

test('缺少 ctx.agents 时明确报错（而不是静默不工作）', async () => {
  const binder = new SessionBinder({ ctx: {} });
  await assert.rejects(() => binder.ensure('qq-group-100'), /需要 agent 服务/);
});

test('runTurn：目标会话缺 cwd 时明确告警一次（否则只表现为「没有助手发言」）', async () => {
  // 部署人设模板里有 {{cwd}}，会话缺它时提示词组装是**抛错**而不是填空串，
  // 错发生在消息被追加之前——外部只看到"本轮没有助手发言"，极难定位。
  // 插件自己建的会话会兜底填 cwd，所以只有"复用外部会话"这一路会缺
  // （典型场景：dmRouting=main 指向一个外部预建的主会话）。
  const logs = [];
  const agents = {
    get: () => undefined,
    list: () => [],
    async create() {
      const agent = fakeAgent({ replyQueue: ['ok'] });
      agent.session.header = {}; // 没有 cwd
      return { agent, dispose: async () => {} };
    },
    async resume() {
      throw new Error('nope');
    },
  };
  const binder = new SessionBinder({
    ctx: { agents },
    log: (level, message) => logs.push({ level, message }),
  });

  await binder.runTurn({ sessionKey: 'qq-group-100', prompt: '一' });
  await binder.runTurn({ sessionKey: 'qq-group-100', prompt: '二' });

  const warnings = logs.filter((l) => l.level === 'warn' && /没有 cwd/.test(l.message));
  assert.equal(warnings.length, 1, '同一会话只该告警一次，不要刷屏');
  assert.match(warnings[0].message, /cwd/);
});

test('runTurn：会话有 cwd 时不告警', async () => {
  const logs = [];
  const agents = {
    get: () => undefined,
    list: () => [],
    async create() {
      const agent = fakeAgent({ replyQueue: ['ok'] });
      agent.session.header = { cwd: 'H:\\work' };
      return { agent, dispose: async () => {} };
    },
    async resume() {
      throw new Error('nope');
    },
  };
  const binder = new SessionBinder({
    ctx: { agents },
    log: (level, message) => logs.push({ level, message }),
  });
  await binder.runTurn({ sessionKey: 'qq-group-100', prompt: '一' });
  assert.equal(logs.some((l) => /没有 cwd/.test(l.message)), false);
});

test('runTurn：投提示词 -> 等空闲 -> 返回本轮回复', async () => {
  const { agents } = fakeAgents({ replyQueue: ['你好呀'] });
  const binder = new SessionBinder({ ctx: { agents } });
  const reply = await binder.runTurn({ sessionKey: 'qq-group-100', prompt: '在吗' });
  assert.equal(reply, '你好呀');
});

test('runTurn：本轮模型没说话时返回空串，不会重复上一轮回复', async () => {
  const { agents } = fakeAgents({ replyQueue: ['第一次回答', null] });
  const binder = new SessionBinder({ ctx: { agents } });
  assert.equal(await binder.runTurn({ sessionKey: 'qq-group-100', prompt: '一' }), '第一次回答');
  assert.equal(
    await binder.runTurn({ sessionKey: 'qq-group-100', prompt: '二' }),
    '',
    '本轮没说话必须返回空串',
  );
});

test('runTurn：提示词被当作 content 块投进去，且 source.kind 不能是已废弃的 plugin', async () => {
  let seen = null;
  const { agents } = fakeAgents({
    replyQueue: ['ok'],
    onFollowup: (payload) => {
      seen = payload;
    },
  });
  const binder = new SessionBinder({ ctx: { agents } });
  await binder.runTurn({ sessionKey: 'qq-group-100', prompt: '测试正文' });
  assert.deepEqual(seen.content, [{ type: 'text', text: '测试正文' }]);
  // 回归：session v4 会拒绝 `kind: 'plugin'`（已废弃的包装写法），
  // 报 `format v4 message requires a producer-owned source kind`，
  // 消息会凭空消失、模型从不回复。
  assert.notEqual(seen.source?.kind, 'plugin');
  assert.equal(seen.source?.kind, 'user');
  // 消息必须是带身份的用户消息，不能是裸对象。
  assert.equal(seen.role, 'user');
  assert.equal(typeof seen.id, 'string');
  assert.ok(seen.id.length > 0);
});

test('runTurn：同一会话的两轮串行执行', async () => {
  const order = [];
  let counter = 0;
  const { agents } = fakeAgents({
    onFollowup: () => {
      counter += 1;
      order.push(`start${counter}`);
    },
  });
  // 手工给一个会延迟的 whenIdle：直接改 agents.create 返回的 handle。
  const slowAgents = {
    async create() {
      const agent = fakeAgent({
        onFollowup: () => {
          counter += 1;
          order.push(`start${counter}`);
        },
      });
      const original = agent.whenIdle;
      agent.whenIdle = async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`end${counter}`);
        return original();
      };
      return { agent, dispose: async () => {} };
    },
    async resume() {
      throw new Error('nope');
    },
  };
  void agents;
  const binder = new SessionBinder({ ctx: { agents: slowAgents } });
  await Promise.all([
    binder.runTurn({ sessionKey: 'qq-group-100', prompt: '一' }),
    binder.runTurn({ sessionKey: 'qq-group-100', prompt: '二' }),
  ]);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2'], '第二轮必须等第一轮空闲');
});

test('runTurn：不同会话可以并发', async () => {
  const order = [];
  const slowAgents = {
    async create(options) {
      const key = options.sessionId;
      const agent = fakeAgent();
      agent.whenIdle = async () => {
        order.push(`start-${key}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`end-${key}`);
      };
      return { agent, dispose: async () => {} };
    },
    async resume() {
      throw new Error('nope');
    },
  };
  const binder = new SessionBinder({ ctx: { agents: slowAgents } });
  await Promise.all([
    binder.runTurn({ sessionKey: 'qq-group-100', prompt: '一' }),
    binder.runTurn({ sessionKey: 'qq-group-200', prompt: '二' }),
  ]);
  assert.equal(order[0].startsWith('start-'), true);
  assert.equal(order[1].startsWith('start-'), true, '两个会话应各自开始，不互相等待');
});

test('runTurn：已取消的 signal 直接抛错，不投提示词', async () => {
  const { agents } = fakeAgents();
  const binder = new SessionBinder({ ctx: { agents } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => binder.runTurn({ sessionKey: 'qq-group-100', prompt: 'x', signal: controller.signal }),
    /取消/,
  );
});

test('runTurn：会话没有 agent 对象时明确报错', async () => {
  const badAgents = {
    async create() {
      return { agent: null, dispose: async () => {} };
    },
    async resume() {
      throw new Error('nope');
    },
  };
  const binder = new SessionBinder({ ctx: { agents: badAgents } });
  await assert.rejects(() => binder.runTurn({ sessionKey: 'qq-group-100', prompt: 'x' }), /没有 agent 对象/);
});

test('runTurn：deriveMessages 抛错时退化成空串而不是炸掉', async () => {
  const badAgents = {
    async create() {
      const agent = fakeAgent({ replyQueue: ['x'] });
      agent.session = {
        deriveMessages() {
          throw new Error('日志损坏');
        },
      };
      return { agent, dispose: async () => {} };
    },
    async resume() {
      throw new Error('nope');
    },
  };
  const logs = [];
  const binder = new SessionBinder({
    ctx: { agents: badAgents },
    log: (level, message) => logs.push({ level, message }),
  });
  assert.equal(await binder.runTurn({ sessionKey: 'qq-group-100', prompt: 'x' }), '');
  assert.ok(logs.some((l) => l.level === 'warn' && /读取会话消息失败/.test(l.message)));
});

test('asResponder：产出网关可直接用的函数', async () => {
  const { agents } = fakeAgents({ replyQueue: ['通过 responder'] });
  const binder = new SessionBinder({ ctx: { agents } });
  const responder = binder.asResponder();
  const reply = await responder({
    sessionKey: 'qq-group-100',
    chatId: 'group:100',
    kind: 'group',
    prompt: '在吗',
    restricted: false,
  });
  assert.equal(reply, '通过 responder');
});

test('evictIdle：按「最近使用」淘汰，且会话本身仍可 resume 回来', async () => {
  let now = T0;
  const { agents, disposed } = fakeAgents();
  const binder = new SessionBinder({ ctx: { agents }, now: () => now });

  await binder.ensure('qq-group-100');
  now = T0 + 1000;
  // 命中缓存会刷新 lastUsedAt —— 这是刻意的：淘汰依据是"最近用过"，
  // 而不是"最早创建"，否则一个天天在用的会话也会被当成空闲。
  await binder.ensure('qq-group-100');
  await binder.ensure('qq-group-200');

  now = T0 + 5000;
  const evicted = await binder.evictIdle(3000);
  assert.equal(evicted, 2, '两个会话的最近使用都超过 3s 了');
  assert.deepEqual(disposed.sort(), ['qq-group-100', 'qq-group-200']);
  assert.equal(binder.live.size, 0);

  // 淘汰只是省内存：会话已持久化，下次 ensure 会 resume 回来。
  await binder.ensure('qq-group-100');
  assert.equal(agents.resume !== undefined, true);
});

test('evictIdle：最近用过的会话不会被淘汰', async () => {
  let now = T0;
  const { agents, disposed } = fakeAgents();
  const binder = new SessionBinder({ ctx: { agents }, now: () => now });

  await binder.ensure('qq-group-100');
  // 1000ms 后 200 建立，再 1000ms 后 100 又被用了一次。
  now = T0 + 1000;
  await binder.ensure('qq-group-200');
  now = T0 + 2000;
  await binder.ensure('qq-group-100');

  // 此刻 100 是 0ms 前用的，200 是 1000ms 前用的；淘汰阈值 500ms。
  now = T0 + 2000;
  const evicted = await binder.evictIdle(500);
  assert.equal(evicted, 1);
  assert.deepEqual(disposed, ['qq-group-200'], '只该淘汰更久没用过的那个');
  assert.equal(binder.live.has('qq-group-100'), true);
});

test('evictIdle：idleMs 非法时什么都不做', async () => {
  const { agents } = fakeAgents();
  const binder = new SessionBinder({ ctx: { agents } });
  await binder.ensure('qq-group-100');
  assert.equal(await binder.evictIdle(0), 0);
  assert.equal(await binder.evictIdle(-1), 0);
  assert.equal(await binder.evictIdle(Number.NaN), 0);
  assert.equal(binder.live.has('qq-group-100'), true);
});

test('dispose：释放所有会话，且单个失败不影响其他', async () => {
  const disposedLog = [];
  const agents = {
    async create(options) {
      const id = options.sessionId;
      return {
        agent: fakeAgent(),
        async dispose() {
          if (id === 'qq-group-100') throw new Error('释放失败');
          disposedLog.push(id);
        },
      };
    },
    async resume() {
      throw new Error('nope');
    },
  };
  const logs = [];
  const binder = new SessionBinder({
    ctx: { agents },
    log: (level, message) => logs.push({ level, message }),
  });
  await binder.ensure('qq-group-100');
  await binder.ensure('qq-group-200');
  await binder.dispose();
  assert.deepEqual(disposedLog, ['qq-group-200'], '另一个仍应被释放');
  assert.ok(logs.some((l) => l.level === 'warn'));
  assert.equal(binder.live.size, 0);
});

test('sessionKeyForChat 与 routing 的规则一致', () => {
  assert.equal(sessionKeyForChat('group:100'), 'qq-group-100');
  assert.equal(sessionKeyForChat('private:2001'), 'qq-private-2001');
  assert.equal(sessionKeyForChat('bogus'), '');
});

// -------------------------------------------- 监听器不残留（回归：长驻资源审计 H1/H2）

/**
 * 造一个带 `ctx.on` 的假 agent，并且**数得清还有几个监听活着**。
 *
 * 行为对齐真实的 Cordis（`cordis/src/events.ts` 的 `on`）：注册时把 handler 塞进
 * 那个事件的数组，**返回一个解绑函数**，解绑函数幂等。这里不模拟事件分发 ——
 * 要验的是"注册了却没解绑"，不需要真的派发。
 */
function fakeAgentWithHooks() {
  /** @type {Map<string, Function[]>} */
  const hooks = new Map();
  const agent = fakeAgent({ replyQueue: ['收到'] });
  agent.ctx = {
    on(name, handler) {
      const list = hooks.get(name) ?? [];
      list.push(handler);
      hooks.set(name, list);
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        const cur = hooks.get(name) ?? [];
        const index = cur.indexOf(handler);
        if (index >= 0) cur.splice(index, 1);
      };
    },
  };
  /** 当前活着的监听总数。 */
  agent.hookCount = () => [...hooks.values()].reduce((n, list) => n + list.length, 0);
  /** 某个事件上活着的监听数。 */
  agent.hooksOn = (name) => (hooks.get(name) ?? []).length;
  return agent;
}

/**
 * 让 `ensure()` 每轮都拿到**同一个** agent。
 *
 * 这不只是图省事：真实世界里 agent 就是被复用的（`ensure()` 先查 `this.live`
 * 缓存，命中就直接返回），"每轮往同一个 ctx 上挂监听"这个前提正来自它。
 * 如果每轮换一个新 agent，泄漏就测不出来了。
 */
function agentsWithOneAgent(agent) {
  const handle = { agent, async dispose() {} };
  return {
    async create() {
      return handle;
    },
    async resume() {
      return handle;
    },
  };
}

test('每轮监听器不留残余：连跑 6 轮后 agent 上的监听数回到基线', async () => {
  const agent = fakeAgentWithHooks();
  const binder = new SessionBinder({ ctx: { agents: agentsWithOneAgent(agent) } });

  await binder.runTurn({ sessionKey: 'qq-group-100', prompt: '第一轮' });
  const baseline = agent.hookCount();
  assert.equal(baseline, 0, '一轮跑完，4 个监听就该全解掉');

  for (let i = 2; i <= 6; i += 1) {
    await binder.runTurn({ sessionKey: 'qq-group-100', prompt: `第 ${i} 轮` });
  }

  assert.equal(
    agent.hookCount(),
    0,
    '每轮挂的 4 个监听必须全部解绑。数字一路涨 = 旧实现那个「每轮 +3」的漏回来了',
  );
  assert.equal(agent.hooksOn('agent/status'), 0, 'agent/status 那一个原先漏得最狠（每次状态变化都 push）');
  assert.equal(agent.hooksOn('agent/request-error'), 0);
});

test('中止的那一轮也要解绑（H2）：`stop()` 必须走 finally', async () => {
  const agent = fakeAgentWithHooks();
  const binder = new SessionBinder({ ctx: { agents: agentsWithOneAgent(agent) } });
  const controller = new AbortController();
  // 让中止发生在**挂完监听之后**：`whenIdle()` 一返回就把 signal 置为已中止。
  // 必须这样安排 —— 如果一进来就是 aborted，`#runTurnInner` 开头的检查会直接抛，
  // 那时监听还没挂上，这条用例就测不到 finally 了。
  agent.whenIdle = async () => {
    controller.abort();
  };

  await assert.rejects(
    () => binder.runTurn({ sessionKey: 'qq-group-100', prompt: '会被取消', signal: controller.signal }),
    /本轮已被取消/,
  );

  assert.equal(
    agent.hookCount(),
    0,
    '异常路径也必须把监听解干净 —— 其中一个握着本轮回复的全文',
  );
});

// -------------------------------------------- 按会话类型限制工具（群收口 / 私聊放开）
//
// 需求：**群里禁掉危险的 shell 工具，私聊不受影响**（私聊是"联系不上主会话时的
// 备用通道"，要保留全套能力）。
//
// 用的是宿主 `@deepseek-ai/dsh-tools` 的 per-agent 能力收口
// （`agentCtx.tools.restrict({ deny })`，lib/index.js:2895）。三个**实测过的**性质
// 决定了这一组的写法：
//   1. 必须从 `agent.ctx` 调 —— 普通 ctx 上会抛 `requires a scoped context`；
//   2. `allow` / `deny` 至少要有一个 —— 空 filter 直接抛（那是宿主防
//      "materialized-empty-config" 的护栏）；
//   3. **名字必须是已注册的全局工具名**，写错就抛，错误信息里带全部合法名字。
//      ⚠️ `bash` 在 Windows 上没注册（patch 里 `disabled: process.platform === 'win32'`），
//      所以默认名单里**不能**有它 —— 有它整条限制都会失败（连 pwsh 都禁不掉）。
//
// 所以这一组钉的是：**群会话真的调了、私聊真的没调、以及调失败时会话照样建得起来**。

/**
 * 造一个带 `agent.ctx.tools.restrict` 的假 agent，并记下调用。
 *
 * `restrict` 挂在 `agent.ctx` 上（而不是 binder 的 ctx）是刻意的 —— 对齐宿主：
 * 只有 agent 作用域的 ctx 才有这个方法。
 *
 * @param {object} [options]
 * @param {(filter: object) => any} [options.restrict] 覆盖实现（用来模拟宿主抛错）
 * @param {(tool: object, all: object[]) => any} [options.register] 覆盖实现（模拟宿主抛错）
 * @param {string[]} [options.replyQueue]
 */
function fakeAgentWithTools({ restrict, register, schemas = () => [], replyQueue = [] } = {}) {
  const agent = fakeAgent({ replyQueue });
  // 给个 cwd：没有的话 runTurn 会记一条"没有 cwd"的 warn，干扰按 level 计数的断言。
  agent.session.header = { cwd: 'H:\\work' };
  /** @type {Array<object>} */
  const calls = [];
  /** @type {Array<object>} */
  const registrations = [];
  agent.ctx = {
    tools: {
      restrict(filter) {
        calls.push(filter);
        if (restrict !== undefined) return restrict(filter);
        return () => {};
      },
      // 2026-10-18（方案 B）：宿主 agent 作用域的 `tools.register`。
      // 工具注册只往这里挂；旧替身缺这个方法，于是它会多打一条
      // "这个 agent 作用域上没有 tools.register" 的 warn，把下面
      // "restrict 抛错时该有且只有一条 warn" 那条断言打红了。
      register(tool) {
        registrations.push(tool);
        if (register !== undefined) return register(tool, registrations);
        return () => {};
      },
      // 2026-11-04：`restrictGroupHostTools` 靠 `schemas(scope)` 现取可见工具名
      // （ops / browser / screen_view 三个族按前缀挑）。默认给"有 API、但没有工具"的宿主，
      // 和真机一致；要测"老宿主没有这个 API"就自己造一个（见对应用例）。
      schemas(scope) {
        return typeof schemas === 'function' ? schemas(scope) : schemas;
      },
    },
  };
  agent.restrictCalls = calls;
  agent.registrations = registrations;
  return agent;
}

/**
 * 假 ctx.agents：create / resume 都在返回前跑一遍 `setup(agentCtx)`。
 *
 * 这是真实行为（setup 是"agent 发布前"的钩子），也是本功能的**主路径** ——
 * 不模拟它，测的就只是"函数能调"，而不是"建会话时会调"。
 */
function agentsWithSetup(agent, { resumeFails = false } = {}) {
  /** @type {object[]} */
  const setupCalls = [];
  const run = async (options) => {
    setupCalls.push(options);
    if (typeof options.setup === 'function') await options.setup(agent.ctx);
    return { agent, dispose: async () => {} };
  };
  const agents = {
    async create(options) {
      return run(options);
    },
    async resume(options) {
      if (resumeFails) throw new Error('没有可恢复的会话');
      return run(options);
    },
  };
  return { agents, setupCalls };
}

test('sessionKindOf：认 qq- 前缀的会话键，也认 chatId 形态', () => {
  // ⚠️ 真实的会话键是 `qq-group-<群号>`（routing.sessionKeyFromChatId 加的前缀），
  // **不是** `group:<群号>` —— 后者是 chatId。两种形态都认，免得"传错形态"表现为
  // "限制静默失效"（那是最难查的一类）。
  assert.equal(sessionKindOf('qq-group-30000011'), 'group');
  assert.equal(sessionKindOf('qq-private-30000001'), 'private');
  assert.equal(sessionKindOf('group:30000011'), 'group');
  assert.equal(sessionKindOf('private:30000001'), 'private');
  assert.equal(sessionKindOf('  qq-group-100  '), 'group', '前后空白不影响判定');
  assert.equal(sessionKindOf('qq-group-unknown'), 'group', 'chatId 派生失败时的兜底键照样算群（宁严勿松）');
  // dmRouting=main 时私聊落进的是一个 session-<uuid> 主会话（主会话的）——
  // 按"群"处理会误伤她，所以未知形态一律不限制。
  assert.equal(sessionKindOf('session-00000000-0000-0000-0000-000000000000'), 'unknown');
  assert.equal(sessionKindOf(''), 'unknown');
  assert.equal(sessionKindOf(null), 'unknown');
  assert.equal(sessionKindOf(undefined), 'unknown');
});

test('默认名单只有 pwsh（bash 在 Windows 上没注册，写进去会让整条限制失败）', () => {
  assert.deepEqual(DEFAULT_GROUP_DENY_TOOLS, ['pwsh']);
  assert.equal(
    DEFAULT_GROUP_DENY_TOOLS.includes('bash'),
    false,
    '`bash` 在本部署是 disabled（process.platform === win32），写进 deny 会抛"未知工具名"',
  );
});

test('normalizeToolNames：丢空串/非字符串/重复，保留原顺序', () => {
  assert.deepEqual(
    normalizeToolNames([' pwsh ', '', '   ', 42, null, undefined, {}, [], 'read', 'pwsh', 'write']),
    ['pwsh', 'read', 'write'],
  );
  assert.deepEqual(normalizeToolNames('pwsh'), ['pwsh'], '单个字符串也认');
  assert.deepEqual(normalizeToolNames([]), []);
  assert.deepEqual(normalizeToolNames(undefined), []);
  assert.deepEqual(normalizeToolNames(null), []);
  assert.deepEqual(normalizeToolNames(7), [], '非字符串非数组 → 空（不是 ["7"]）');
});

test('resolveGroupDenyTools：没配用代码默认；空数组是"明确不限制"', () => {
  assert.deepEqual(resolveGroupDenyTools(undefined), ['pwsh'], '没配 → 代码默认');
  assert.deepEqual(resolveGroupDenyTools(null), ['pwsh']);
  assert.deepEqual(resolveGroupDenyTools([]), [], '配成空数组 = 明确不限制，**不能**被默认值顶掉');
  assert.deepEqual(resolveGroupDenyTools(['read']), ['read'], '配了就用配的');
});

test('resolveGroupDenyTools：每次给的是新数组（默认值不能被调用方改坏）', () => {
  const first = resolveGroupDenyTools(undefined);
  first.push('read');
  assert.deepEqual(resolveGroupDenyTools(undefined), ['pwsh'], '模块级默认值被改坏了');
  assert.deepEqual(DEFAULT_GROUP_DENY_TOOLS, ['pwsh']);
});

test('群会话：建会话时调 restrict，deny 就是名单（默认 pwsh）', async () => {
  const agent = fakeAgentWithTools();
  const { agents, setupCalls } = agentsWithSetup(agent);
  const binder = new SessionBinder({ ctx: { agents } });

  const { created } = await binder.ensure('qq-group-30000011');

  assert.equal(created, true);
  assert.equal(setupCalls.length, 1, 'resume 成功就只该有一次');
  assert.deepEqual(agent.restrictCalls, [{ deny: ['pwsh'] }], '群会话必须收掉 pwsh');
});

test('pickGroupDeniedHostTools：只挑 ops_* / dsh_browser_* / screen_view', () => {
  // 2026-11-04 用户批的名单：群会话禁 ops / browser / screen view，私聊不动。
  assert.deepEqual(GROUP_DENY_HOST_PREFIXES, ['ops_', 'dsh_browser_'], '前缀就是这三族的边界');
  assert.deepEqual(GROUP_DENY_HOST_EXACT, ['screen_view']);

  assert.deepEqual(
    pickGroupDeniedHostTools([
      'read',
      'pwsh',
      'ops_bash',
      'ops_grep',
      'dsh_browser_open',
      'dsh_browser_click',
      'screen_view',
      'desktop_control',
      'zhihu_search',
      'memory_save',
      '  dsh_browser_open  ',
      'dsh_browser_new',
      42,
      null,
      '',
    ]),
    ['ops_bash', 'ops_grep', 'dsh_browser_open', 'dsh_browser_click', 'screen_view', 'dsh_browser_new'],
    '按输入顺序、去重、丢掉非字符串；桌面/知乎/记忆这些**不在**名单里',
  );
  assert.deepEqual(pickGroupDeniedHostTools(undefined), []);
  assert.deepEqual(pickGroupDeniedHostTools('ops_bash'), [], '非数组一律空，不把字符串当单元素数组');
});

test('群会话：挂着推导出来的 gugu-lite 也照样收宿主工具族', async () => {
  // 关键点：`groupToolBackstop` 原来一看 preset 是 `-lite` 就整段跳过（那是给 pwsh 的
  // 兜底逻辑），但 ops/browser/screen_view 在**全局层**，preset 根本拿不掉 ——
  // 如果跟着一起跳过，这次改动就是"写了但没生效"。
  const agent = fakeAgentWithTools({
    schemas: () => [
      { name: 'read' },
      { name: 'pwsh' },
      { name: 'ops_bash' },
      { name: 'ops_replace' },
      { name: 'dsh_browser_open' },
      { name: 'screen_view' },
      { name: 'zhihu_search' },
    ],
  });
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({ ctx: { agents }, config: { agentPreset: 'gugu' } });

  binder.groupToolBackstop(agent.ctx, 'qq-group-30000011', 'setup', 'gugu-lite');

  assert.deepEqual(
    agent.restrictCalls,
    [{ deny: ['ops_bash', 'ops_replace', 'dsh_browser_open', 'screen_view'] }],
    '`pwsh` 由 preset 负责，这一条不该多叠',
  );
});

test('群会话：宿主工具族只收一次（ensure / equip 会重复走进来）', () => {
  const agent = fakeAgentWithTools({ schemas: () => [{ name: 'ops_bash' }, { name: 'screen_view' }] });
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({ ctx: { agents }, config: { agentPreset: 'gugu' } });

  binder.groupToolBackstop(agent.ctx, 'qq-group-30000011', 'setup', 'gugu-lite');
  binder.groupToolBackstop(agent.ctx, 'qq-group-30000011', 'reuse', 'gugu-lite');

  assert.equal(agent.restrictCalls.length, 1, '限制是挂在 ctx 上的 effect，叠第二层没有意义');
});

test('宿主没有 tools.schemas()：记 warn，不静默跳过', () => {
  // "静默跳过"是这类收口最坏的失败方式：日志干干净净，群里照样有浏览器。
  const logs = [];
  const agent = fakeAgent();
  agent.session.header = { cwd: 'H:\\work' };
  const calls = [];
  agent.ctx = {
    tools: {
      restrict(filter) {
        calls.push(filter);
        return () => {};
      },
      // 刻意不给 schemas
    },
  };
  const binder = new SessionBinder({ ctx: { agents: {} }, log: (level, message) => logs.push({ level, message }) });

  binder.groupToolBackstop(agent.ctx, 'qq-group-30000011', 'setup', null);

  assert.ok(
    logs.some((l) => l.level === 'warn' && /tools\.schemas/.test(l.message)),
    `该明确报"宿主没有 schemas"，实际：${JSON.stringify(logs)}`,
  );
  assert.deepEqual(calls, [{ deny: ['pwsh'] }], '这一族没收到，pwsh 的兜底照旧');
});

test('私聊：可见表里有 ops/browser/screen_view 也一个都不收（用户明确说私聊别动）', async () => {
  // 这里钉的是**群会话那条硬性 deny** 不会波及私聊。按需加载（2026-11-04）是另一条线：
  // 它会把 browser 这类收进目录（可 load 回来），所以这个用例显式关掉它，只测 deny。
  const agent = fakeAgentWithTools({
    schemas: () => [{ name: 'ops_bash' }, { name: 'dsh_browser_open' }, { name: 'screen_view' }],
  });
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({ ctx: { agents }, onDemandTools: [] });

  await binder.ensure('qq-private-30000001');

  assert.deepEqual(agent.restrictCalls, [], '私聊保留全套（含内置浏览器，2026-10-24 实测能用的那条路）');
});

test('群会话：建会话时两道都挂 —— 宿主工具族 + pwsh 兜底', async () => {
  const agent = fakeAgentWithTools({
    schemas: () => [{ name: 'read' }, { name: 'pwsh' }, { name: 'ops_bash' }, { name: 'screen_view' }],
  });
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({ ctx: { agents } });

  const { created } = await binder.ensure('qq-group-30000011');

  assert.equal(created, true);
  assert.deepEqual(agent.restrictCalls, [
    { deny: ['ops_bash', 'screen_view'] },
    { deny: ['pwsh'] },
  ]);
});

test('群会话：resume 失败回退 create 的那条路也要收口', async () => {
  const agent = fakeAgentWithTools();
  const { agents, setupCalls } = agentsWithSetup(agent, { resumeFails: true });
  const binder = new SessionBinder({ ctx: { agents } });

  await binder.ensure('qq-group-30000011');

  assert.equal(setupCalls.length, 1, '只有 create 那一次');
  assert.deepEqual(agent.restrictCalls, [{ deny: ['pwsh'] }]);
});

test('私聊：一次都不调 restrict（那是"联系不上主会话时的备用通道"，保留全套）', async () => {
  const agent = fakeAgentWithTools();
  const { agents, setupCalls } = agentsWithSetup(agent);
  const binder = new SessionBinder({ ctx: { agents } });

  await binder.ensure('qq-private-30000001');

  assert.equal(setupCalls.length, 1, '会话照样建起来');
  assert.deepEqual(agent.restrictCalls, [], '私聊不该被限制');
});

test('未知会话（dmRouting=main 的主会话）：不限制', async () => {
  const agent = fakeAgentWithTools();
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({ ctx: { agents } });

  await binder.ensure('session-00000000-0000-0000-0000-000000000000');

  assert.deepEqual(agent.restrictCalls, [], '主会话自己的会话不能被当成群会话收口');
});

test('★ restrict 抛错时：会话照常建立、不崩，走 warn 且把合法工具名清单记进日志', async () => {
  // 宿主的真实报错长这样（名字写错时）—— 里面带全部合法名字，是运维改配置的依据。
  const hostError =
    'tools.restrict() names unknown global tool "bash"; ' +
    'known global tools: edit, pwsh, read, write';
  const logs = [];
  const agent = fakeAgentWithTools({
    restrict: () => {
      throw new Error(hostError);
    },
    replyQueue: ['在的'],
  });
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({
    ctx: { agents },
    // 给个模型路由：否则 `resolveAgentOptions` 会多记一条 warn（那是另一条链路的
    // 告警），把"该有且只有一条 warn"的断言搅浑。
    config: { provider: 'deepseek-official', model: 'deepseek-flash' },
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  // 这一条是整组里最要紧的：setup 跑在**建会话的路径**上，
  // 限制失败若能冒泡出去，就等于"名单写错一个字 → 这个 QQ 会话整个建不起来"。
  const { handle, created } = await binder.ensure('qq-group-30000011');
  assert.equal(created, true, '限制失败绝不能把会话建失败');
  assert.equal(handle.agent, agent);

  const warnings = logs.filter((l) => l.level === 'warn');
  assert.equal(warnings.length, 1, `该有且只有一条 warn，实际：${JSON.stringify(logs)}`);
  assert.match(warnings[0].message, /工具限制失败/);
  assert.match(warnings[0].message, /会话照常建立/);
  assert.match(
    warnings[0].message,
    /known global tools: edit, pwsh, read, write/,
    '合法工具名清单必须原样记进日志（否则不知道该怎么改）',
  );
  assert.equal(
    logs.some((l) => l.level === 'info' && /已禁用工具/.test(l.message)),
    false,
    '失败时不能谎报成功',
  );

  // 而且这一轮回复照常 —— "限制没挂上"不等于"会话坏了"。
  const reply = await binder.runTurn({ sessionKey: 'qq-group-30000011', prompt: '在吗' });
  assert.equal(reply, '在的');
});

test('agent 作用域上没有 tools.restrict 时：记 warn，不崩', async () => {
  const logs = [];
  const agent = fakeAgent(); // 没有 agent.ctx.tools
  agent.session.header = { cwd: 'H:\\work' };
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({
    ctx: { agents },
    log: (level, message) => logs.push({ level, message }),
  });

  const { created } = await binder.ensure('qq-group-30000011');
  assert.equal(created, true);
  assert.ok(
    logs.some((l) => l.level === 'warn' && /tools\.restrict/.test(l.message)),
    `该提示"限制没生效"，实际：${JSON.stringify(logs)}`,
  );
});

test('复用已有 agent 时也要收口（热重载后走的就是这条路）', async () => {
  // 为什么必须测：插件热重载会把 binder 的 `live` 缓存清空，但活着的 agent 还在，
  // 于是下一次 ensure 走**复用**分支 —— 那条路**不经过 setup**。
  // 不在这里补一次，群会话就会**安静地拿回 shell 权限**（没有报错，限制只是没了）。
  const agent = fakeAgentWithTools();
  const liveAgent = {
    id: 'qq-group-30000011',
    session: { id: 'qq-group-30000011', header: { cwd: 'H:\\work' } },
    ctx: agent.ctx,
  };
  const agents = {
    get: (id) => (id === 'qq-group-30000011' ? liveAgent : undefined),
    list: () => [liveAgent],
    async create() {
      throw new Error('不该走到 create');
    },
    async resume() {
      throw new Error('不该走到 resume');
    },
  };
  const binder = new SessionBinder({ ctx: { agents } });

  const { handle, created } = await binder.ensure('qq-group-30000011');

  assert.equal(created, false);
  assert.equal(handle.agent, liveAgent);
  assert.deepEqual(agent.restrictCalls, [{ deny: ['pwsh'] }], '复用路径也必须收口');
});

test('复用已有 agent：私聊与未知会话都不收口', async () => {
  const agent = fakeAgentWithTools();
  const liveAgent = {
    session: { header: { cwd: 'H:\\work' } },
    ctx: agent.ctx,
  };
  // `get` 对任何 id 都返回同一个 agent：这里要测的是**按请求的会话键**判定类型，
  // 而不是"这个 agent 自己的 id 长什么样"。
  const agents = {
    get: () => liveAgent,
    list: () => [liveAgent],
    async create() {
      throw new Error('不该走到 create');
    },
    async resume() {
      throw new Error('不该走到 resume');
    },
  };
  const binder = new SessionBinder({ ctx: { agents } });

  await binder.ensure('qq-private-30000001');
  await binder.ensure('session-00000000');

  assert.deepEqual(agent.restrictCalls, []);
});

test('同一会话只收口一次（第二次 ensure 命中缓存，不重复叠加限制）', async () => {
  const agent = fakeAgentWithTools();
  const { agents, setupCalls } = agentsWithSetup(agent);
  const binder = new SessionBinder({ ctx: { agents } });

  await binder.ensure('qq-group-30000011');
  await binder.ensure('qq-group-30000011');

  assert.equal(setupCalls.length, 1);
  assert.equal(agent.restrictCalls.length, 1, '不要每次 ensure 都往 agent 上叠一层限制');
});

test('名单可配置：配了别的名单就按配置来', async () => {
  const agent = fakeAgentWithTools();
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({
    ctx: { agents },
    denyToolsInGroup: ['pwsh', 'read', 'write'],
  });

  await binder.ensure('qq-group-30000011');

  assert.deepEqual(agent.restrictCalls, [{ deny: ['pwsh', 'read', 'write'] }]);
});

test('名单配成空数组 = 群里不限制任何工具（留的退路）', async () => {
  const agent = fakeAgentWithTools();
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({ ctx: { agents }, denyToolsInGroup: [] });

  await binder.ensure('qq-group-30000011');

  assert.deepEqual(agent.restrictCalls, [], '空名单不该调 restrict（空 filter 本身也会被宿主拒）');
});

test('名单过滤：空串/非字符串/重复项都进不了 restrict 的参数', async () => {
  const agent = fakeAgentWithTools();
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({
    ctx: { agents },
    denyToolsInGroup: [' pwsh ', '', '  ', 42, null, {}, [], 'read', 'pwsh', 'write'],
  });

  await binder.ensure('qq-group-30000011');

  assert.deepEqual(agent.restrictCalls, [{ deny: ['pwsh', 'read', 'write'] }]);
});

test('传给 restrict 的是名单的副本（外部改不到 binder 的状态）', async () => {
  const agent = fakeAgentWithTools({
    restrict: (filter) => {
      filter.deny.push('read'); // 模拟宿主/别的代码乱改
      return () => {};
    },
  });
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({ ctx: { agents } });

  await binder.ensure('qq-group-30000011');
  assert.deepEqual(binder.denyToolsInGroup, ['pwsh'], 'binder 持有的名单不该被改');
});

// ------------------------------------- 按会话选 preset（群挂减配那份，子会话才继承得到）
//
// 需求：**「群里没有危险工具」这件事必须体现在 preset 上**，不能只靠 `restrict`。
//
// 起因（实测）：`restrict` 是 per-agent 的，**子会话不继承**。小鲸鱼在测试群里说
// 「我这边根会话没有 pwsh 工具，上面是派子会话跑的」—— 子会话有 pwsh 且跑了命令。
// 而 `dsh-subagent` 建子会话时继承的是**父的 preset**：
//   - `childSessionMeta`：`parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)`
//     （lib/index.js:471-482，源码原话「read from the parent's LIVE scope chain」）；
//   - `applyChildComposition` → `composeFrom(childCtx, parent.ctx)`（lib/index.js:511-512），
//     把子作用域的父链接指向父手上那一代 preset。
// ⇒ 子会话继承的是「父的 preset」，不是「父的 restrict」。所以要让子会话也没有 pwsh，
//   只能让**群会话挂的那份 preset 本身**不含 pwsh。
//
// 这一组钉的就是：**群挂的是减配那份、私聊挂原样、挂不上时退回原样而不是退回 standard**，
// 以及**兜底 restrict 的开关**（挂上了就不叠，没挂上才叠）。

/**
 * 假 `ctx.agentPresets`，形状对齐 `@deepseek-ai/dsh-agent-preset-registry`。
 *
 * - `mount(ctx, id)`：找不到 / 定义坏了就 **reject**（`retain()` 先查 `definitions`，
 *   查不到抛 `Unknown agent preset`）；
 * - `composedPreset(ctx)`：读一个活着的 agent 当前跑的 preset 注册名（读不到返回 undefined）。
 *
 * @param {{failFor?: string[], composed?: string|null}} [options]
 */
function fakeAgentPresets({ failFor = [], composed = null } = {}) {
  /** @type {string[]} */
  const mounts = [];
  return {
    mounts,
    async mount(agentCtx, id) {
      mounts.push(id);
      if (failFor.includes(id)) throw new Error(`Unknown agent preset: ${id}`);
      return { id };
    },
    composedPreset: () => composed,
  };
}

test('resolveSessionPreset：群挂「私聊那份 + -lite」，私聊原样', () => {
  assert.equal(GROUP_PRESET_SUFFIX, '-lite');
  assert.equal(
    resolveSessionPreset({ sessionKey: 'qq-group-30000011', agentPreset: 'gugu' }),
    'gugu-lite',
    '群会话默认挂推导出来的那份',
  );
  assert.equal(
    resolveSessionPreset({ sessionKey: 'qq-private-30000001', agentPreset: 'gugu' }),
    'gugu',
    '私聊原样',
  );
  assert.equal(
    resolveSessionPreset({ sessionKey: 'session-00000000', agentPreset: 'gugu' }),
    'gugu',
    '主会话自己的会话按私聊处理（不是群）',
  );
  // ⚠️ 会话键是 `qq-group-<群号>`，不是 `group:<群号>` —— 第一步就在这上面踩过。
  assert.equal(resolveSessionPreset({ sessionKey: 'group:30000011', agentPreset: 'gugu' }), 'gugu-lite');
});

test('resolveSessionPreset：三态 —— 没配推导 / 配了照用 / 配空串表示"跟私聊一样"', () => {
  const group = 'qq-group-30000011';
  assert.equal(
    resolveSessionPreset({ sessionKey: group, agentPreset: 'gugu', groupAgentPreset: undefined }),
    'gugu-lite',
    'undefined = 没配 → 推导',
  );
  assert.equal(
    resolveSessionPreset({ sessionKey: group, agentPreset: 'gugu', groupAgentPreset: 'gugu-noshell' }),
    'gugu-noshell',
    '显式覆盖赢',
  );
  assert.equal(
    resolveSessionPreset({ sessionKey: group, agentPreset: 'gugu', groupAgentPreset: '' }),
    'gugu',
    '★ 空串 = 明确要求群跟私聊同一份（急刹车，和 denyToolsInGroup=[] 同一套语义）',
  );
  assert.equal(
    resolveSessionPreset({ sessionKey: group, agentPreset: 'gugu', groupAgentPreset: '  gugu-x  ' }),
    'gugu-x',
    '两头空白要去掉',
  );
  // 没配私聊 preset 时推导不出后缀来 —— 空串 = 这个会话不挂 preset（保持原行为）。
  assert.equal(resolveSessionPreset({ sessionKey: group, agentPreset: '' }), '');
  assert.equal(resolveSessionPreset({ sessionKey: group }), '');
});

test('群会话：挂的是推导出来的 -lite 那份，私聊挂原样', async () => {
  const agent = fakeAgentWithTools();
  const { agents } = agentsWithSetup(agent);
  const presets = fakeAgentPresets();
  const binder = new SessionBinder({ ctx: { agents, agentPresets: presets }, config: { agentPreset: 'gugu' } });

  await binder.ensure('qq-group-30000011');
  assert.deepEqual(presets.mounts, ['gugu-lite'], '群会话必须挂减配那份');

  const agent2 = fakeAgentWithTools();
  const { agents: agents2 } = agentsWithSetup(agent2);
  const presets2 = fakeAgentPresets();
  const binder2 = new SessionBinder({ ctx: { agents: agents2, agentPresets: presets2 }, config: { agentPreset: 'gugu' } });

  await binder2.ensure('qq-private-30000001');
  assert.deepEqual(presets2.mounts, ['gugu'], '私聊照旧');
});

test('★ 群会话 header 记的是按会话解析后的 preset（不是配置里那个固定值）', async () => {
  // 写错这个的代价很具体：header 说 gugu、实际跑 gugu-lite，
  // 而 `dsh-agent-preset-registry` 的会话投影拿 header 当初始值。
  const agent = fakeAgentWithTools();
  const { agents, setupCalls } = agentsWithSetup(agent);
  const binder = new SessionBinder({
    ctx: { agents, agentPresets: fakeAgentPresets() },
    config: { agentPreset: 'gugu' },
  });

  await binder.ensure('qq-group-30000011');
  assert.equal(setupCalls[0].meta.agentPreset, 'gugu-lite');

  const agent2 = fakeAgentWithTools();
  const { agents: agents2, setupCalls: setupCalls2 } = agentsWithSetup(agent2);
  const binder2 = new SessionBinder({
    ctx: { agents: agents2, agentPresets: fakeAgentPresets() },
    config: { agentPreset: 'gugu' },
  });
  await binder2.ensure('qq-private-30000001');
  assert.equal(setupCalls2[0].meta.agentPreset, 'gugu');
});

test('★★ 群 preset 挂上了：不再叠 restrict 兜底（收不了 preset 没注册的名字）', async () => {
  // 源码依据：`@deepseek-ai/dsh-tools` 的 `view(scope)` 里 `restrictableNames`
  // 只收 global 层 + 作用域链上**除自己以外**的每一层（preset 的工具正落在祖先层）。
  // 本部署全局那条 `tool-pwsh` 是 `disabled: true`（cordis.yml:204），所以 `pwsh`
  // 之所以可收**只是因为 gugu preset 注册了它** —— preset 一去掉，restrict 必然
  // 以 `names unknown global tool "pwsh"` 失败。硬叠 = 每个群会话一条误导性的 warn。
  const agent = fakeAgentWithTools();
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({
    ctx: { agents, agentPresets: fakeAgentPresets() },
    config: { agentPreset: 'gugu' },
  });

  await binder.ensure('qq-group-30000011');

  assert.deepEqual(agent.restrictCalls, [], '工具本来就不在，别再叠一层收不了名字的 restrict');
});

test('★★ 群 preset 挂不上、退回私聊那份时：restrict 兜底还在（保险丝没拆）', async () => {
  const agent = fakeAgentWithTools();
  const { agents } = agentsWithSetup(agent);
  const presets = fakeAgentPresets({ failFor: ['gugu-lite'] });
  const logs = [];
  const binder = new SessionBinder({
    ctx: { agents, agentPresets: presets },
    config: { agentPreset: 'gugu' },
    log: (level, message) => logs.push({ level, message }),
  });

  await binder.ensure('qq-group-30000011');

  assert.deepEqual(presets.mounts, ['gugu-lite', 'gugu'], '退回到私聊那份，而不是什么都不挂');
  assert.deepEqual(agent.restrictCalls, [{ deny: ['pwsh'] }], '退回之后必须把兜底捡起来');
  // 退回 = 群会话又带着那几个工具了，而且**子会话会继承这一份** —— 这条 warn 必须说清楚。
  const warn = logs.find((l) => l.level === 'warn' && l.message.includes('gugu-lite'));
  assert.ok(warn !== undefined, '必须留下一条说清后果的 warn');
  assert.match(warn.message, /子会话会继承/);
});

test('preset 一个都挂不上时：会话照常建立，退回 global 层（老行为）', async () => {
  const agent = fakeAgentWithTools();
  const { agents } = agentsWithSetup(agent);
  const logs = [];
  const binder = new SessionBinder({
    ctx: { agents, agentPresets: fakeAgentPresets({ failFor: ['gugu-lite', 'gugu'] }) },
    config: { agentPreset: 'gugu' },
    log: (level, message) => logs.push({ level, message }),
  });

  const { handle } = await binder.ensure('qq-group-30000011');

  assert.ok(handle.agent !== undefined, '会话必须照常建起来');
  assert.ok(
    logs.some((l) => l.level === 'warn' && l.message.includes('回退到 global 层')),
    '两次都失败要留下"回退到 global 层"的 warn',
  );
  // 两次都挂不上 → 什么都没挂上 → 兜底照旧生效（不知道跑的是哪份，就往安全那侧靠）。
  assert.deepEqual(agent.restrictCalls, [{ deny: ['pwsh'] }]);
});

test('复用已有 agent：读 live preset 决定要不要兜底', async () => {
  // 复用这条路**不经过 setup**，所以既没挂 preset、也读不到 setup 的结果；
  // 只能拿 `composedPreset(agentCtx)` 问（它读的是 live 作用域链，不是 header）。
  const build = (composed) => {
    const agent = fakeAgentWithTools();
    const liveAgent = { session: { header: { cwd: 'H:\\work' } }, ctx: agent.ctx };
    const agents = {
      get: () => liveAgent,
      list: () => [liveAgent],
      async create() {
        throw new Error('不该走到 create');
      },
      async resume() {
        throw new Error('不该走到 resume');
      },
    };
    const binder = new SessionBinder({
      ctx: { agents, agentPresets: fakeAgentPresets({ composed }) },
      config: { agentPreset: 'gugu' },
    });
    return { binder, agent };
  };

  const onLite = build('gugu-lite');
  await onLite.binder.ensure('qq-group-30000011');
  assert.deepEqual(onLite.agent.restrictCalls, [], '已经在群那份上 → 不用兜');

  const onBase = build('gugu');
  await onBase.binder.ensure('qq-group-30000011');
  assert.deepEqual(onBase.agent.restrictCalls, [{ deny: ['pwsh'] }], '跑的不是群那份 → 必须兜');

  const unknown = build(undefined);
  await unknown.binder.ensure('qq-group-30000011');
  assert.deepEqual(
    unknown.agent.restrictCalls,
    [{ deny: ['pwsh'] }],
    '问不到就跑安全的那一侧（宁可多一条 warn，也别漏收口）',
  );
});

test('groupAgentPreset 配成空串：群跟私聊挂同一份（急刹车开关）', async () => {
  const agent = fakeAgentWithTools();
  const { agents } = agentsWithSetup(agent);
  const presets = fakeAgentPresets();
  const binder = new SessionBinder({
    ctx: { agents, agentPresets: presets },
    config: { agentPreset: 'gugu' },
    groupAgentPreset: '',
  });

  await binder.ensure('qq-group-30000011');

  assert.deepEqual(presets.mounts, ['gugu'], '空串 = 不区分群和私聊');
  assert.deepEqual(agent.restrictCalls, [{ deny: ['pwsh'] }], '这时候兜底必须还在');
});

test('groupAgentPreset 显式覆盖成别的 preset：兜底照旧叠（代码不知道它有没有那些工具）', async () => {
  // 判据是**推导出来的那个名字**，不是"挂的名字 == 想挂的名字"：
  // 只有推导出来那份，内容才是代码知道的（`test/preset-config.test.mjs` 盯着那条不变式）。
  // 覆盖成别的 preset 时照旧兜 —— 多一条 warn，方向是安全的那侧。
  const agent = fakeAgentWithTools();
  const { agents } = agentsWithSetup(agent);
  const presets = fakeAgentPresets();
  const binder = new SessionBinder({
    ctx: { agents, agentPresets: presets },
    config: { agentPreset: 'gugu' },
    groupAgentPreset: 'gugu-noshell',
  });

  await binder.ensure('qq-group-30000011');

  assert.deepEqual(presets.mounts, ['gugu-noshell']);
  assert.deepEqual(agent.restrictCalls, [{ deny: ['pwsh'] }]);
});

test('没有 agentPresets 服务时：不崩、不挂 preset，限制照旧', async () => {
  const agent = fakeAgentWithTools();
  const { agents } = agentsWithSetup(agent);
  const binder = new SessionBinder({ ctx: { agents }, config: { agentPreset: 'gugu' } });

  await binder.ensure('qq-group-30000011');

  assert.deepEqual(agent.restrictCalls, [{ deny: ['pwsh'] }]);
});

// ------------------------------------------ 「往 QQ 发东西」工具（`send_qq`，2026-10-18）
//
// 和 `registerSendTool` 同一个形状、同一个理由（必须挂在 agent 作用域上、
// setup 与复用两条路都要注册、整段包 try）。
//
// ⚠️ **trim 的归属**（读代码确认）：工具层**不 trim、不判空** —— `execute` 只验
//    "items 是不是数组"，然后把 `{ sessionKey, items }` **原样**交给注入的 `sendTool`；
//    空白、条数、总字数、kind 全由 `gateway.sendFromTool` 判。
//    这里钉住这个分界：将来谁把 trim 挪到工具层，就会**红**（那会改变空白的语义）。
//
// ⚠️ 出站：`sendTool` 是注入的桩，不碰 transport —— 一条都不会真发。

test('★ registerSendTool：注册 `send_qq`，execute 把 `{sessionKey, items}` 原样交给 sendTool', async () => {
  const agent = fakeAgentWithTools();
  const calls = [];
  const binder = new SessionBinder({
    ctx: {},
    sendTool: async (args) => {
      calls.push(args);
      return { ok: true, sent: 1, note: '发了 1 条。' };
    },
  });

  const ok = binder.registerSendTool(agent.ctx, 'qq-private-30000001', 'setup');

  assert.equal(ok, true);
  assert.equal(agent.registrations.length, 1, '应该恰好注册一次');
  const tool = agent.registrations[0];
  assert.equal(tool.name, 'send_qq');
  assert.match(tool.description, /QQ 会话/);
  assert.deepEqual(tool.parameters.required, ['items']);
  assert.equal(tool.parameters.properties.items.type, 'array');

  // 执行器：只验数组，**trim 不在这里做**。
  const items = [{ text: '  hi  ' }];
  const result = await tool.execute({ items });
  assert.deepEqual(result, { ok: true, sent: 1, note: '发了 1 条。' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionKey, 'qq-private-30000001');
  assert.deepEqual(calls[0].items, [{ text: '  hi  ' }], '空白必须原样带出去（trim 由网关做）');

  // 空正文也**不在工具层拦**：整批拒是网关的职责。
  const empty = await tool.execute({ items: [{ text: '   ' }] });
  assert.deepEqual(empty, { ok: true, sent: 1, note: '发了 1 条。' });
  assert.equal(calls.length, 2, '空正文也要交给网关判（工具层不复制规则）');
  assert.deepEqual(calls[1].items, [{ text: '   ' }]);
});

// B2（2026-10-25）：`[send] auto_reply` 必须**改工具描述**。
//
// 为什么这条重要：切成 `off` 之后插件不再自动发任何东西，而描述里那句
// "你这一轮的回复插件会自动发"就成了假话 —— 结果是"她只输出文本、QQ 上什么都不发"。
// 这是静默丢消息，用户那边看起来就是"她不说话了"，所以用测试钉住。
test('★ registerSendTool：autoReply=off ⇒ 描述必须说"插件不会自动发"（否则她只输出文本）', () => {
  const agent = fakeAgentWithTools();
  const binder = new SessionBinder({
    ctx: {},
    sendTool: async () => ({ ok: true, sent: 1, note: '' }),
    autoReply: 'off',
  });
  assert.equal(binder.registerSendTool(agent.ctx, 'qq-private-30000001'), true);
  const tool = agent.registrations[0];
  assert.match(tool.description, /不会\*\*自动发|不会.*自动发/);
  assert.doesNotMatch(tool.description, /平时回话不需要它/);
});

test('registerSendTool：默认（fallback）描述说清"用工具发过文字就不再自动发"', () => {
  const agent = fakeAgentWithTools();
  const binder = new SessionBinder({
    ctx: {},
    sendTool: async () => ({ ok: true, sent: 1, note: '' }),
  });
  assert.equal(binder.autoReplyMode, 'fallback');
  assert.equal(binder.registerSendTool(agent.ctx, 'qq-private-30000001'), true);
  const tool = agent.registrations[0];
  assert.match(tool.description, /平时回话不需要它/);
  assert.match(tool.description, /发过\*\*文字\*\*|发过.*文字/);
  assert.match(tool.description, /表情包不影响自动发送/);
});

test('registerSendTool：autoReply=always ⇒ 描述说清"照常自动发"（回滚档也不能自相矛盾）', () => {
  const agent = fakeAgentWithTools();
  const binder = new SessionBinder({
    ctx: {},
    sendTool: async () => ({ ok: true, sent: 1, note: '' }),
    autoReply: 'always',
  });
  assert.equal(binder.registerSendTool(agent.ctx, 'qq-private-30000001'), true);
  const tool = agent.registrations[0];
  assert.match(tool.description, /照常自动发/);
});

test('registerSendTool：autoReply 取值不认识 ⇒ 按 fallback（和 Gateway 同一个归一化）', () => {
  const binder = new SessionBinder({ ctx: {}, autoReply: 'ALWAYS' });
  assert.equal(binder.autoReplyMode, 'fallback');
});

test('★ registerSendTool：items 不是数组 ⇒ execute 抛错（别把坏参数交给网关）', async () => {  const agent = fakeAgentWithTools();
  let calls = 0;
  const binder = new SessionBinder({
    ctx: {},
    sendTool: async () => {
      calls += 1;
      return { ok: true, sent: 0, note: '' };
    },
  });
  assert.equal(binder.registerSendTool(agent.ctx, 'qq-private-30000001'), true);
  const tool = agent.registrations[0];

  await assert.rejects(() => tool.execute({ items: 'nope' }), /items 必须是数组/);
  await assert.rejects(() => tool.execute({}), /items 必须是数组/);
  await assert.rejects(() => tool.execute(undefined), /items 必须是数组/);
  assert.equal(calls, 0, '坏参数不该调用 sendTool');
});

test('★ registerSendTool：没有注入 sendTool 时**不注册**（未接线就别给她假工具）', async () => {
  const logs = [];
  const agent = fakeAgentWithTools();
  const binder = new SessionBinder({
    ctx: {},
    // sendTool 没给 / 给了非函数：都当"没有"
    sendTool: 'nope',
    log: (level, message) => logs.push({ level, message }),
  });

  assert.equal(binder.registerSendTool(agent.ctx, 'qq-private-30000001', 'setup'), false);
  assert.equal(agent.registrations.length, 0, '一个工具都不该注册');
  assert.ok(
    logs.some((l) => l.level === 'debug' && /没有注入 sendTool/.test(l.message)),
    `未接线要留一条 debug，实际：${JSON.stringify(logs)}`,
  );
});

test('registerSendTool：agent 作用域上没有 tools.register 时只 warn，不崩', async () => {
  const logs = [];
  const agent = fakeAgent(); // 没有 agent.ctx.tools
  const binder = new SessionBinder({
    ctx: {},
    sendTool: async () => ({ ok: true, sent: 0, note: '' }),
    log: (level, message) => logs.push({ level, message }),
  });

  assert.equal(binder.registerSendTool(agent.ctx, 'qq-private-1'), false);
  assert.ok(
    logs.some((l) => l.level === 'warn' && /tools\.register/.test(l.message)),
    `该提示工具没挂上，实际：${JSON.stringify(logs)}`,
  );
});

test('★ registerSendTool：重复注册**幂等**（返回 false + debug，不抛、不再打扰宿主）', async () => {
  const logs = [];
  /** 模拟宿主：同一作用域重复注册同名工具会抛。 */
  const already = new Set();
  let hostCalls = 0;
  const agent = fakeAgentWithTools({
    register(tool) {
      hostCalls += 1;
      if (already.has(tool.name)) throw new Error(`工具 ${tool.name} 已经注册过了`);
      already.add(tool.name);
      return () => {};
    },
  });
  const binder = new SessionBinder({
    ctx: {},
    sendTool: async () => ({ ok: true, sent: 0, note: '' }),
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  assert.equal(binder.registerSendTool(agent.ctx, 'qq-group-30000012', 'setup'), true);
  // 关键：这里**不能 throw** —— 调用点在 `setup` 里，抛出去等于这个会话建不起来。
  assert.equal(binder.registerSendTool(agent.ctx, 'qq-group-30000012', 'reuse'), false);
  assert.equal(hostCalls, 1, '判重之后不该再调宿主 register');

  const warnings = logs.filter((l) => l.level === 'warn');
  assert.equal(warnings.length, 0, `重复注册不该留 warn，实际：${JSON.stringify(logs)}`);
  assert.ok(
    logs.some((l) => l.level === 'debug' && /发 QQ 的工具已经在这个 agent 上注册过/.test(l.message)),
    `该有一条 debug 说明跳过了，实际：${JSON.stringify(logs)}`,
  );
});

test('★ registerSendTool：setup 建会话时自动注册；复用分支再补一次', async () => {
  // 主路径：setup（新建/恢复会话时都会经过）。
  const createdAgent = fakeAgentWithTools();
  const sendTool = async () => ({ ok: true, sent: 0, note: '' });
  const { agents } = agentsWithSetup(createdAgent);
  const binder = new SessionBinder({ ctx: { agents }, sendTool });

  await binder.ensure('qq-private-30000001');
  assert.equal(
    createdAgent.registrations.filter((t) => t.name === 'send_qq').length,
    1,
    'setup 上必须把工具挂给她',
  );

  // 复用分支：这条路**不经过 setup**（热重载后就是它）。不补一次的话，
  // 热重载之后她就**静默地没有这个工具了**（不报错，只是不见了）。
  const liveAgent = fakeAgentWithTools();
  const live = {
    session: { header: { cwd: 'H:\\work' } },
    ctx: liveAgent.ctx,
  };
  const agentsReuse = {
    get: () => live,
    list: () => [live],
    async create() {
      throw new Error('不该走到 create');
    },
    async resume() {
      throw new Error('不该走到 resume');
    },
  };
  const binder2 = new SessionBinder({ ctx: { agents: agentsReuse }, sendTool });
  const { created } = await binder2.ensure('qq-private-30000001');

  assert.equal(created, false);
  assert.deepEqual(
    liveAgent.registrations.map((t) => t.name),
    ['send_qq'],
    '复用路径也必须补注册（否则热重载后工具消失）',
  );
});

// ------------------------------------------------ agent 归属：跨插件热重载存活
//
// 2026-10-20 架构改动。目标：「改 `src/` 不再掐断正在跑的那一轮」。
//
// 根因：`ctx.agents.create` 用的 ownerCtx 就是**调用方 ctx**（插件自己的），
// 插件 HMR 重载 ⇒ `agentLoop.lifecycle(id)` 那个 effect 被 dispose ⇒ agent 连
// 正在跑的一轮一起 `aborted/disposed`。
//
// 三条路各钉一条用例，**顺序是硬性的**：
//   ① 收养：`agents.get` 查到活着的 ⇒ 复用，**一次 create/resume 都不能发生**
//      （两个 agent 写同一个会话日志 = 数据损坏）
//   ② 走 root：没有活着的 ⇒ `agentLoop.createAgent(ctx.root, …)`（ownerCtx 是应用根
//      作用域，插件热重载不 dispose 它）+ 尝试 `agents.register` 进登记表
//   ③ 回退：没有 `agentLoop` / `ctx.root` ⇒ 老路 `ctx.agents.create`
// 走错任一条，现象都是"改 src/ 时她那一轮被掐断"或"同一个会话两个 agent"。

/** 假的应用根作用域（身份比较用，不需要真的是 Cordis ctx）。 */
const ROOT_CTX = { name: 'root-ctx' };

/**
 * 假 `agentLoop` 服务：记下 `createAgent` / `resume` 的入参。
 * @param {object} [options]
 * @param {boolean} [options.resumeSucceeds] resume 是否成功（默认失败 ⇒ 走 createAgent）
 */
function fakeAgentLoop({ resumeSucceeds = false } = {}) {
  /** @type {Array<{ownerCtx: any, options: object}>} */
  const created = [];
  /** @type {Array<{ownerCtx: any, options: object}>} */
  const resumed = [];
  const build = (id) => {
    const agent = fakeAgentWithTools();
    agent.id = id;
    agent.session.id = id;
    return { agent, dispose: async () => {} };
  };
  const loop = {
    async createAgent(ownerCtx, options) {
      created.push({ ownerCtx, options });
      return build(options.sessionId);
    },
    async resume(ownerCtx, options) {
      resumed.push({ ownerCtx, options });
      if (!resumeSucceeds) throw new Error('没有可恢复的会话');
      return build(options.resumeSessionId);
    },
  };
  return { loop, created, resumed };
}

/** 假 ctx：带 `get('agentLoop')` 与 `root`（Cordis 的那两个入口）。 */
function ctxWithRoot(agents, loop) {
  return {
    agents,
    root: ROOT_CTX,
    get(name) {
      return name === 'agentLoop' ? loop : undefined;
    },
  };
}

test('★ ensure ① 收养：有活着的 agent ⇒ 复用，create/resume 一次都不许发生', async () => {
  const liveAgent = fakeAgentWithTools();
  liveAgent.id = 'qq-group-30000011';
  liveAgent.session.id = 'qq-group-30000011';

  const { loop, created, resumed } = fakeAgentLoop({ resumeSucceeds: true });
  const counts = { create: 0, resume: 0, register: 0 };
  const agents = {
    get: (id) => (id === 'qq-group-30000011' ? liveAgent : undefined),
    list: () => [liveAgent],
    async create() {
      counts.create += 1;
      throw new Error('收养时绝不能再 create');
    },
    async resume() {
      counts.resume += 1;
      throw new Error('收养时绝不能再 resume');
    },
    register() {
      counts.register += 1;
      return () => {};
    },
  };
  const logs = [];
  const binder = new SessionBinder({
    ctx: ctxWithRoot(agents, loop),
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const first = await binder.ensure('qq-group-30000011');
  const second = await binder.ensure('qq-group-30000011');

  assert.equal(first.created, false);
  assert.equal(first.handle.agent, liveAgent, '必须复用那个活着的 agent，而不是新建');
  assert.equal(second.handle, first.handle, '第二次 ensure 命中缓存');
  assert.deepEqual(
    counts,
    { create: 0, resume: 0, register: 0 },
    '有活着的 agent 时绝不能出现 create/resume（两个 agent 写同一个会话日志 = 数据损坏）',
  );
  assert.equal(created.length, 0, 'agentLoop.createAgent 一次都不该调');
  assert.equal(resumed.length, 0, 'agentLoop.resume 一次都不该调');
  // 收养这条路**不经过 setup**，所以那套「复用要补一遍」的东西必须还在。
  assert.deepEqual(liveAgent.restrictCalls, [{ deny: ['pwsh'] }], '收养路径也要补工具收口');
  // 可观测性：走的是哪条一眼能看出来。
  const adoptLogs = logs.filter((l) => l.meta?.via === 'adopt');
  assert.equal(adoptLogs.length, 1, '收养要且只要一条 info（第二次命中缓存，不再打）');
  assert.equal(adoptLogs[0].level, 'info');
  assert.match(adoptLogs[0].message, /via: adopt/);
  assert.deepEqual(binder.sessionModeStats(), { via: 'adopt', reason: null }, '快照要能区分"收养"');
});

test('★ ensure ② 走 root：agentLoop.createAgent(ctx.root, …) + agents.register 登记', async () => {
  const { loop, created, resumed } = fakeAgentLoop();
  const registered = [];
  const agents = {
    get: () => undefined,
    list: () => [],
    register(agent) {
      registered.push(agent);
      return () => {};
    },
    async create() {
      throw new Error('有 agentLoop/root 时不该走老路');
    },
    async resume() {
      throw new Error('有 agentLoop/root 时不该走老路');
    },
  };
  const logs = [];
  const binder = new SessionBinder({
    ctx: ctxWithRoot(agents, loop),
    config: { agentPreset: 'gugu' },
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const { handle, created: isCreated } = await binder.ensure('qq-group-30000011');

  assert.equal(isCreated, true);
  // 先试 resume（重启后接回原对话），失败再 createAgent —— 两条都在 root 上。
  assert.equal(resumed.length, 1, '先在 root 上试 resume');
  assert.equal(resumed[0].ownerCtx, ROOT_CTX, 'resume 的 ownerCtx 也必须是根作用域');
  assert.equal(resumed[0].options.resumeSessionId, 'qq-group-30000011');
  assert.equal(created.length, 1, 'resume 失败后走 createAgent');
  assert.equal(
    created[0].ownerCtx,
    ROOT_CTX,
    'ownerCtx 必须是 ctx.root，否则插件重载照样把 agent dispose 掉',
  );
  const { options } = created[0];
  // options 的形状**照 `agents.create` 那套传**（sessionId/agentOptions/meta/setup）。
  assert.equal(options.sessionId, 'qq-group-30000011');
  assert.equal(typeof options.agentOptions, 'object');
  assert.equal(typeof options.setup, 'function');
  assert.equal(typeof options.meta.cwd, 'string');
  assert.equal(options.meta.agentPreset, 'gugu-lite', '群会话照样挂推导出来的 -lite');
  // 让它进 `agents` 的登记表，否则收养分支（`agents.get`）永远找不到它。
  assert.equal(registered.length, 1, '要进登记表');
  assert.equal(registered[0], handle.agent);
  const rootLogs = logs.filter((l) => l.meta?.via === 'root');
  assert.ok(rootLogs.length >= 1, `该有 via: root 的 info，实际：${JSON.stringify(logs)}`);
  assert.ok(rootLogs.some((l) => l.level === 'info' && /已新建/.test(l.message)));
});

test('★ ensure ② resume 失败 ⇒ warn 写清原因+会话 id+改为新建，快照 sessionMode 可观测', async () => {
  const { loop, created } = fakeAgentLoop();
  const agents = {
    get: () => undefined,
    list: () => [],
    register() {
      return () => {};
    },
  };
  const logs = [];
  const binder = new SessionBinder({
    ctx: ctxWithRoot(agents, loop),
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  await binder.ensure('qq-group-30000011');

  // 行为不变：失败后照样新建（只是不再是静默的）。
  assert.equal(created.length, 1);
  const warn = logs.find((entry) => entry.level === 'warn' && entry.meta?.resumed === false);
  assert.ok(warn !== undefined, `恢复失败必须打 warn，实际：${JSON.stringify(logs)}`);
  assert.match(warn.message, /qq-group-30000011/, '日志里要有会话 id');
  assert.match(warn.message, /没有可恢复的会话/, '日志里要有失败原因');
  assert.match(warn.message, /改为新建/, '日志里要说清接下来是新建');
  assert.equal(warn.meta.resumed, false);
  assert.equal(warn.meta.sessionKey, 'qq-group-30000011');

  // 快照可观测：`reason` 就是失败原因 —— "她失忆了"在磁盘上留痕。
  assert.deepEqual(binder.sessionModeStats(), {
    via: 'create',
    reason: '没有可恢复的会话',
  });
});

test('★ ensure ② resume 成功 ⇒ 快照 sessionMode.via = resume（不是 create）', async () => {
  const { loop } = fakeAgentLoop({ resumeSucceeds: true });
  const agents = {
    get: () => undefined,
    list: () => [],
    register() {
      return () => {};
    },
  };
  const binder = new SessionBinder({ ctx: ctxWithRoot(agents, loop) });

  await binder.ensure('qq-group-200');

  assert.deepEqual(binder.sessionModeStats(), { via: 'resume', reason: null });
});

test('★ ensure ③ 回退：没有 agentLoop / ctx.root ⇒ 老路 agents.create（测试替身走这条）', async () => {
  const { agents, created, resumed } = fakeAgents({ resumeFails: true });
  const logs = [];
  // 只有 `agents`：既没有 `ctx.get('agentLoop')`，也没有 `ctx.root`。
  const binder = new SessionBinder({
    ctx: { agents },
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const { created: isCreated } = await binder.ensure('qq-group-100');

  assert.equal(isCreated, true);
  assert.equal(resumed.length, 1, '老路照样先试 resume');
  assert.equal(created.length, 1, 'resume 失败后回退到 agents.create');
  assert.equal(created[0].sessionId, 'qq-group-100');
  const pluginLogs = logs.filter((l) => l.meta?.via === 'plugin' && l.level === 'info');
  assert.equal(pluginLogs.length, 1, '回退这条路的 info 要打 via: plugin');
  assert.equal(pluginLogs[0].level, 'info');
  // 老路的恢复失败同样要 warn（以前只有 debug），快照里也要看出是新建。
  const warn = logs.find((entry) => entry.level === 'warn' && entry.meta?.resumed === false);
  assert.ok(warn !== undefined, '回退路的 resume 失败也要升 warn');
  assert.match(warn.message, /qq-group-100/);
  assert.deepEqual(binder.sessionModeStats(), { via: 'create', reason: '没有可恢复的会话' });
});

test('★ ensure ③ 回退：有 ctx.get 但查不到 agentLoop、且没有 root ⇒ 也走老路', async () => {
  const { agents, created } = fakeAgents({ resumeFails: true });
  const binder = new SessionBinder({
    ctx: { agents, get: () => undefined },
  });

  await binder.ensure('qq-group-100');

  assert.equal(created.length, 1, '拿不到 agentLoop ⇒ 必须回退，不能把建会话搞挂');
});

test('★ ensure ② 有 agentLoop 但没有 resume 方法 ⇒ 直接 createAgent（不必等一个不存在的入口）', async () => {
  const created = [];
  const loop = {
    async createAgent(ownerCtx, options) {
      created.push({ ownerCtx, options });
      const agent = fakeAgentWithTools();
      agent.id = options.sessionId;
      agent.session.id = options.sessionId;
      return { agent, dispose: async () => {} };
    },
  };
  const agents = {
    get: () => undefined,
    list: () => [],
    register() {
      return () => {};
    },
  };
  const binder = new SessionBinder({ ctx: ctxWithRoot(agents, loop) });

  await binder.ensure('qq-private-30000001');

  assert.equal(created.length, 1);
  assert.equal(created[0].ownerCtx, ROOT_CTX);
});

test('★ dispose（插件卸载）：root 托管的 agent 不释放；老路（plugin）照旧释放', async () => {
  // **这是整个改动的另一半。** `index.mjs` 的 shutdown 会调 `binder.dispose()`
  // （`qq-proactive: shutdown`，index.mjs:2126）。要是那条路把 root 托管的 agent
  // 一起 teardown，"跨热重载存活"当场作废 —— agent 照样 dispose、正在跑的那一轮
  // 照样 aborted/disposed，只是换了个地方掐。
  const disposedRoot = [];
  const { loop } = fakeAgentLoop();
  const originalCreate = loop.createAgent.bind(loop);
  loop.createAgent = async (ownerCtx, options) => {
    const handle = await originalCreate(ownerCtx, options);
    handle.dispose = async () => disposedRoot.push(options.sessionId);
    return handle;
  };
  const agents = {
    get: () => undefined,
    list: () => [],
    register() {
      return () => {};
    },
  };
  const binderRoot = new SessionBinder({ ctx: ctxWithRoot(agents, loop) });
  await binderRoot.ensure('qq-group-100');
  await binderRoot.dispose();
  assert.deepEqual(disposedRoot, [], 'root 托管的 agent 在插件卸载时绝对不许释放');
  assert.equal(binderRoot.live.size, 0, '插件这边的账还是清干净的（下次会重新收养）');

  // 老路（没有 agentLoop/root ⇒ via: plugin）照旧释放，行为不变。
  const { agents: plainAgents, disposed } = fakeAgents({ resumeFails: true });
  const binderPlugin = new SessionBinder({ ctx: { agents: plainAgents } });
  await binderPlugin.ensure('qq-group-200');
  await binderPlugin.dispose();
  assert.deepEqual(disposed, ['qq-group-200'], 'plugin 托管的照旧释放');
});

test('★ evictIdle 仍然释放 root 托管的 agent（"省内存"那条路是主动释放，不变）', async () => {
  let now = T0;
  const disposedRoot = [];
  const { loop } = fakeAgentLoop();
  const originalCreate = loop.createAgent.bind(loop);
  loop.createAgent = async (ownerCtx, options) => {
    const handle = await originalCreate(ownerCtx, options);
    handle.dispose = async () => disposedRoot.push(options.sessionId);
    return handle;
  };
  const agents = {
    get: () => undefined,
    list: () => [],
    register() {
      return () => {};
    },
  };
  const binder = new SessionBinder({ ctx: ctxWithRoot(agents, loop), now: () => now });
  await binder.ensure('qq-group-100');
  now = T0 + 5000;
  assert.equal(await binder.evictIdle(1000), 1);
  assert.deepEqual(disposedRoot, ['qq-group-100'], '主动淘汰照旧 dispose（会话已持久化，能 resume 回来）');
});



// ---------------------------------------------------------------- 压缩吞回复（2026-10-28）

/**
 * 事故现场（2026-10-28 20:43，私聊 `private:30000001`）：
 *
 * 用户发「终于做完了，一个小时」→ 那一轮里 DSH 做了上下文压缩（450 条历史 / 32.7 万 token）
 * → 模型照常产出了回复（会话日志里 `assistant/message` 有全文，GUI 上也看得见）
 * → **QQ 上一句话都没到**，`qq-outbound.jsonl` 里连 `gw-send` 都没有。
 *
 * 根因是两条取回复的路同时空了：
 *  1. `assistantTextSince()` 按**条数下标**切，而压缩会把 surface **替换**短
 *     （`before≈900 → after≈30`）⇒ `slice(min(900,30))` = 空数组；
 *  2. 流式兜底 `extractStreamText()` 找错了层级 —— 正文在
 *     `payload.frame.chunk.text`（`StreamChunk.type === 'text-delta'`），
 *     老实现只看 `payload.frame.text|delta|content` ⇒ 永远抽不到
 *     （现场是 `streamFrames: 3 / streamedChars: 0`）。
 *
 * 而"空回复"在网关那边是**合法**的（模型可以不说话）⇒ 静默丢弃，
 * 唯一线索是 `lostTurn` 那条 **debug**（默认不输出、宿主 logger 也不落盘）。
 *
 * 下面这几条钉住"再也不许静默丢"。
 */

/** 造一个"这一轮里被压缩过"的假 agent：followup 时把历史换成摘要 + 本轮几条。 */
function compactingAgent({ keepId = true, reply = '（拍手）干得好！一小时不算慢', emitStream = false, streamText = null, history = 200 } = {}) {
  const messages = [];
  for (let i = 0; i < history; i += 1) {
    messages.push({ id: `h${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `历史 ${i}` }] });
  }
  const listeners = new Map();
  const agent = {
    session: {
      header: { cwd: '<workspace>' },
      deriveMessages: () => messages.map((m) => ({ ...m })),
    },
    followup(payload) {
      // 压缩：整段 surface 被一条 checkpoint 取代（宿主用 surfaceOp replace 做到的）
      messages.length = 0;
      messages.push({ id: 'ck', role: 'user', content: [{ type: 'text', text: 'checkpoint …' }] });
      messages.push({ ...(keepId ? { id: payload.id } : {}), role: 'user', content: payload.content });
      if (reply !== null) messages.push({ id: 'a1', role: 'assistant', content: [{ type: 'text', text: reply }] });
      const emit = listeners.get('agent/assistant-stream');
      if (typeof emit === 'function' && emitStream) {
        emit({ frame: { type: 'start', attemptId: 'at1', revision: 1, turn: 1, step: 1 } });
        emit({ frame: { type: 'chunk', attemptId: 'at1', revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: streamText ?? reply ?? '' } } });
        emit({ frame: { type: 'end', attemptId: 'at1', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } } });
      }
    },
    async whenIdle() {},
    ctx: {
      on(name, handler) {
        listeners.set(name, handler);
        return () => listeners.delete(name);
      },
    },
  };
  return agent;
}

/** 装一个只建会话的 binder（单轮用）。 */
function binderWith(agent, { now, log } = {}) {
  const agents = {
    get: () => undefined,
    list: () => [],
    async create() {
      return { agent, dispose: async () => {} };
    },
    async resume() {
      throw new Error('nope');
    },
  };
  return new SessionBinder({ ctx: { agents }, ...(now ? { now } : {}), log, config: {} });
}

test('extractStreamText：宿主真实帧形状（正文在 frame.chunk.text）', () => {
  // 契约来自 dsh-agent 的类型声明：frame = {type:'chunk', chunk: StreamChunk}，
  // 而 StreamChunk 的正文是 {type:'text-delta', text}。
  const chunkFrame = (chunk) => ({ frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: 0, chunk } });
  assert.equal(extractStreamText(chunkFrame({ type: 'text-delta', index: 0, text: '你好' })), '你好');
  assert.equal(
    extractStreamText(chunkFrame({ type: 'reasoning-delta', index: 0, text: '我先想想' })),
    null,
    '思考过程不是回复，绝不能发到 QQ',
  );
  assert.equal(extractStreamText(chunkFrame({ type: 'usage', usage: {} })), null);
  // start / end 帧没有正文
  assert.equal(extractStreamText({ frame: { type: 'start', attemptId: 'a' } }), null);
  assert.equal(extractStreamText({ frame: { type: 'end', attemptId: 'a', outcome: { kind: 'abandoned' } } }), null);
  // 老形状仍然认（不知道 payload 形状那段时间的兼容）
  assert.equal(extractStreamText({ frame: { text: '老的直给形状' } }), '老的直给形状');
  assert.equal(extractStreamText(null), null);
});

test('assistantTextAfterMessage：按提示词 id 锚定，不受"条数变短"影响', () => {
  const messages = [
    { id: 'old-user', role: 'user', content: [{ type: 'text', text: '上一轮' }] },
    { id: 'old-a', role: 'assistant', content: [{ type: 'text', text: '上一轮的回答' }] },
    { id: 'ck', role: 'user', content: [{ type: 'text', text: 'checkpoint' }] },
    { id: 'p1', role: 'user', content: [{ type: 'text', text: '这一轮' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '这一轮的回答' }] },
  ];
  assert.equal(assistantTextAfterMessage(messages, 'p1'), '这一轮的回答');
  assert.equal(assistantTextAfterMessage(messages, 'nope'), null, '锚点不在 ⇒ null（绝不退化去拿上一轮的）');
  assert.equal(assistantTextAfterMessage(messages, ''), null);
  assert.equal(assistantTextAfterMessage(null, 'p1'), null);
  assert.equal(assistantTextAfterMessage([{ id: 'p1', role: 'user', content: [] }], 'p1'), null, '锚点后没有助手文本');
});

test('runTurn：压缩把历史变短时，回复照样取得回来（2026-10-28 事故回归）', async () => {
  const agent = compactingAgent();
  const binder = binderWith(agent);
  // 压缩前 200 条 ⇒ `before=200`；压缩后派生消息只剩 3 条 ⇒ 按下标切必然为空。
  const reply = await binder.runTurn({ sessionKey: 'qq-private-1', prompt: '[20:43] 终于做完了，一个小时' });
  assert.equal(reply, '（拍手）干得好！一小时不算慢', '回复必须取得回来，否则 QQ 上就是一片安静');
  const diag = binder.turnDiagnostics();
  assert.equal(diag.compactedTurns, 1, '这一轮要被认出"历史被压缩过"');
  assert.equal(diag.recoveredByAnchor, 1, '走的是 id 锚定那条兜底');
  assert.equal(diag.lostReplies, 0, '救回来了就不算丢');
});

test('runTurn：历史变短且没有 id 锚点时，用流式分片兜底', async () => {
  const agent = compactingAgent({ keepId: false, emitStream: true, reply: null, streamText: '（拍手）干得好！一小时不算慢' });
  // 这条用例一定会走满 `#waitForNewMessages` 的超时（既没锚点、条数又涨不回来），
  // 所以塞一个快进时钟，别让单测白等 8 秒。
  let tick = T0;
  const binder = binderWith(agent, { now: () => (tick += 3000) });
  const reply = await binder.runTurn({ sessionKey: 'qq-private-1', prompt: '说点什么' });
  assert.equal(reply, '（拍手）干得好！一小时不算慢');
  assert.equal(binder.turnDiagnostics().recoveredByStream, 1);
});

test('runTurn：什么都取不到时，必须留一条 warn（不许静默丢）', async () => {
  const logs = [];
  const agent = compactingAgent({ keepId: false, emitStream: false, reply: null });
  let tick = T0;
  const binder = binderWith(agent, { now: () => (tick += 3000), log: (level, message, meta) => logs.push({ level, message, meta }) });
  const reply = await binder.runTurn({ sessionKey: 'qq-private-1', prompt: '在吗' });
  assert.equal(reply, '', '取不到就是空串（网关那边仍然不发）');
  const warn = logs.find((l) => l.level === 'warn' && /没有助手发言/.test(l.message));
  assert.ok(warn, '历史被压缩过 ⇒ 这必须是 warn，不能是 debug（debug 默认看不见）');
  assert.equal(warn.meta.historyShrank, true, '日志里要能直接看出"是压缩"');
  assert.equal(warn.meta.before, 200);
  assert.equal(warn.meta.after, 2, '压缩后只剩「摘要 + 本轮用户消息」两条');
  const diag = binder.turnDiagnostics();
  assert.equal(diag.lostReplies, 1);
  assert.equal(diag.emptyReplies, 1);
  assert.equal(binder.emptyReplyDiagnosis('qq-private-1').kind, 'lost');
});

test('runTurn：一点新消息都没有时的空回复仍然是 debug（不刷屏）', async () => {
  const logs = [];
  // 投递之后会话里什么都没多（模型压根没动）⇒ 这是真的"没说话"，不该 warn。
  const agent = {
    session: {
      header: { cwd: '<workspace>' },
      deriveMessages: () => [{ id: 'a0', role: 'assistant', content: [{ type: 'text', text: '上一轮' }] }],
    },
    followup() {},
    async whenIdle() {},
  };
  let tick = T0;
  const binder = binderWith(agent, { now: () => (tick += 3000), log: (level, message, meta) => logs.push({ level, message, meta }) });
  assert.equal(await binder.runTurn({ sessionKey: 'qq-group-100', prompt: '一' }), '');
  const line = logs.find((l) => /没有助手发言/.test(l.message));
  assert.ok(line);
  assert.equal(line.level, 'debug', '没有动静就是正常的沉默');
  assert.equal(binder.turnDiagnostics().emptyReplies, 1);
  assert.equal(binder.turnDiagnostics().lostReplies, 0);
});

test('runTurn：压缩那一轮不再空等满 8 秒（id 锚点到站就返回）', async () => {
  const agent = compactingAgent();
  const binder = binderWith(agent); // 用真实时钟，量真实耗时
  const started = Date.now();
  await binder.runTurn({ sessionKey: 'qq-private-1', prompt: '压缩轮' });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `压缩轮必须按"到站"提前返回，实测 ${elapsed}ms（老实现必然 8s 超时）`);
});
