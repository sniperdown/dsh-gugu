// 按需加载（2026-11-04）：目录 + load_tools + 可撤销 restrict
// 目标不是"少发几个字节"，是**每轮少占上下文**：118 个工具 100,201 字 ≈ 3.5 万 token。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ON_DEMAND_PREFIXES,
  ON_DEMAND_SECTION,
  ON_DEMAND_TOOL_NAME,
  SessionBinder,
  oneLineOf,
  pickOnDemandTools,
  renderToolCatalog,
} from '../src/dsh/binding.mjs';

function fakeAgentWithTools({ restrict, register, schemas = () => [], replyQueue = [] } = {}) {
  const calls = [];
  const registrations = [];
  const sections = [];
  const agent = {
    id: 'agent',
    session: { header: { cwd: 'H:\\work' } },
    ctx: {
      tools: {
        restrict(filter) { calls.push(filter); return () => {}; },
        register(tool) { registrations.push(tool); return () => {}; },
        schemas(scope) { return typeof schemas === 'function' ? schemas(scope) : schemas; },
      },
      systemPrompt: {
        section(cfg) { sections.push(cfg); return () => {}; },
      },
    },
  };
  agent.restrictCalls = calls;
  agent.registrations = registrations;
  agent.sections = sections;
  return agent;
}

function binderWith(agent, options = {}) {
  const setupCalls = [];
  const agents = {
    async create(options) {
      setupCalls.push(options);
      if (typeof options.setup === 'function') await options.setup(agent.ctx);
      return { agent, dispose: async () => {} };
    },
    async resume(options) {
      return agents.create(options);
    },
  };
  const binder = new SessionBinder({ ctx: { agents }, ...options });
  return { binder, agents, setupCalls };
}

const SAMPLE = [
  { name: 'read', description: 'Read a file from disk.' },
  { name: 'pwsh', description: 'Run a PowerShell command.' },
  {
    name: 'zhihu_search',
    description: '搜索知乎内容（问题/回答/文章）。',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  { name: 'dsh_browser_open', description: 'Open a URL in the shared browser. Use it for pages.' },
  { name: 'schedule_create', description: 'Create a reminder in the current session.' },
];

test('pickOnDemandTools：只挑配置里的前缀，保序去重', () => {
  assert.ok(DEFAULT_ON_DEMAND_PREFIXES.includes('dsh_browser_'));
  assert.ok(DEFAULT_ON_DEMAND_PREFIXES.includes('zhihu_'));
  assert.deepEqual(
    pickOnDemandTools(['read', 'zhihu_search', 'dsh_browser_open', 'pwsh', 'schedule_list', 'zhihu_search']),
    ['zhihu_search', 'dsh_browser_open', 'schedule_list'],
  );
  assert.deepEqual(pickOnDemandTools(['read', 'pwsh']), [], '没有一个匹配 → 空');
  assert.deepEqual(pickOnDemandTools(undefined), []);
});

test('oneLineOf：取第一句、超长截断、去换行', () => {
  assert.equal(oneLineOf('搜索知乎内容。然后还会做别的。', 40), '搜索知乎内容。');
  assert.equal(oneLineOf('Open a URL.\nUse it for pages.', 40), 'Open a URL.');
  assert.equal(oneLineOf('a'.repeat(50), 20).length, 20);
  assert.ok(oneLineOf('a'.repeat(50), 20).endsWith('…'));
  assert.equal(oneLineOf(''), '');
});

test('renderToolCatalog：每条一行「名字 — 一句话」，空输入给空串', () => {
  const text = renderToolCatalog(SAMPLE.filter((t) => t.name === 'zhihu_search'));
  assert.match(text, /load_tools/, '目录必须告诉模型去哪儿加载');
  assert.match(text, /zhihu_search — 搜索知乎内容（问题\/回答\/文章）。/);
  assert.equal(renderToolCatalog([]), '');
});

test('装会话时：按需工具被收进目录，load_tools 与目录段都挂上', async () => {
  const agent = fakeAgentWithTools({ schemas: () => SAMPLE });
  const { binder } = binderWith(agent);

  await binder.ensure('qq-private-30000001');

  // ⚠️ `restrict` 现在会先逐个**探测**能否收（单名字），最后才挂整批 —— 断言看最后那一次。
  assert.deepEqual(
    agent.restrictCalls.at(-1),
    { deny: ['zhihu_search', 'dsh_browser_open', 'schedule_create'] },
    '三个匹配前缀的被收掉，read/pwsh 常驻',
  );
  assert.ok(agent.registrations.some((t) => t.name === ON_DEMAND_TOOL_NAME));
  const section = agent.sections.find((s) => s.name === ON_DEMAND_SECTION);
  assert.ok(section, '目录段必须挂上（否则模型不知道有这些工具）');
  assert.match(section.text, /zhihu_search — 搜索知乎内容/);
  assert.ok(section.text.length < 5000, `目录要短，实际 ${section.text.length}`);
});

test('load_tools：加载后放开限制，并把参数 schema 一并回给模型', async () => {
  const agent = fakeAgentWithTools({ schemas: () => SAMPLE });
  const { binder } = binderWith(agent);
  await binder.ensure('qq-private-30000001');

  const load = agent.registrations.find((t) => t.name === ON_DEMAND_TOOL_NAME);
  const result = await load.execute({ names: ['zhihu_search'] });

  assert.equal(result.ok, true);
  assert.match(result.text, /已加载：zhihu_search/);
  assert.match(result.text, /"type":"object"/, '兜底：完整参数 schema 必须在结果里');
  assert.deepEqual(
    agent.restrictCalls.at(-1),
    { deny: ['dsh_browser_open', 'schedule_create'] },
    '已加载的不再被收',
  );
});

test('load_tools：目录里没有的名字拒绝，不改变已加载状态', async () => {
  const agent = fakeAgentWithTools({ schemas: () => SAMPLE });
  const { binder } = binderWith(agent);
  await binder.ensure('qq-private-30000001');

  const load = agent.registrations.find((t) => t.name === ON_DEMAND_TOOL_NAME);
  const before = agent.restrictCalls.length;
  const result = await load.execute({ names: ['read'] });

  assert.equal(result.ok, false);
  assert.match(result.text, /没有这些工具/);
  assert.equal(agent.restrictCalls.length, before, '拒绝时不该重挂限制');
});

test('onDemandTools 配成 []：整套关掉（一个 restrict 都不发）', async () => {
  const agent = fakeAgentWithTools({ schemas: () => SAMPLE });
  const { binder } = binderWith(agent, { onDemandTools: [] });

  await binder.ensure('qq-private-30000001');

  assert.deepEqual(agent.restrictCalls, []);
  assert.equal(agent.registrations.some((t) => t.name === ON_DEMAND_TOOL_NAME), false);
});

test('重复走进来（equip / ensure 再调）不会叠第二层限制', async () => {
  const agent = fakeAgentWithTools({ schemas: () => SAMPLE });
  const { binder } = binderWith(agent);
  await binder.ensure('qq-private-30000001');

  const before = agent.restrictCalls.length;
  binder.setupOnDemandTools(agent.ctx, 'qq-private-30000001', 'reuse');
  assert.equal(agent.restrictCalls.length, before, '幂等：台账说装过了就直接返回');
});

test('load_tools 重复加载：只回一句收执，不再吐一遍 schema', async () => {
  const agent = fakeAgentWithTools({ schemas: () => SAMPLE });
  const { binder } = binderWith(agent);
  await binder.ensure('qq-private-30000001');

  const load = agent.registrations.find((t) => t.name === ON_DEMAND_TOOL_NAME);
  await load.execute({ names: ['zhihu_search'] });
  const second = await load.execute({ names: ['zhihu_search'] });

  assert.equal(second.ok, true);
  assert.match(second.text, /已经加载过/);
  assert.equal(second.text.includes('参数 schema'), false, '重复加载不该再占一遍上下文');
});

test('补编目：agent 创建之后才注册的工具会被补收进目录（真机 schedule/team/job 的坑）', async () => {
  let visible = [
    { name: 'read', description: 'Read a file.' },
    { name: 'zhihu_search', description: '搜索知乎内容。', parameters: { type: 'object' } },
  ];
  const agent = fakeAgentWithTools({ schemas: () => visible });
  const { binder } = binderWith(agent);
  await binder.ensure('qq-private-30000001');

  assert.deepEqual(agent.restrictCalls.at(-1), { deny: ['zhihu_search'] });

  // 模拟：agent 建好之后，schedule 插件才把自己的工具注册上来
  visible = [
    ...visible,
    { name: 'schedule_list', description: '列出当前会话的定时任务。', parameters: { type: 'object' } },
  ];
  const added = binder.refreshOnDemandTools(agent.ctx, 'qq-private-30000001');

  assert.equal(added, true);
  assert.deepEqual(agent.restrictCalls.at(-1), { deny: ['zhihu_search', 'schedule_list'] });
  assert.match(
    agent.sections.at(-1).text,
    /schedule_list — 列出当前会话的定时任务/,
    '补收的同时必须补进目录，否则模型看不见也不知道',
  );
});

test('补编目：没有新工具就停手（不再每轮克隆全量 schema）', async () => {
  const agent = fakeAgentWithTools({ schemas: () => SAMPLE });
  const { binder } = binderWith(agent);
  await binder.ensure('qq-private-30000001');

  assert.equal(binder.refreshOnDemandTools(agent.ctx, 'qq-private-30000001'), false);
  const calls = agent.restrictCalls.length;
  assert.equal(binder.refreshOnDemandTools(agent.ctx, 'qq-private-30000001'), false);
  assert.equal(agent.restrictCalls.length, calls);
});

test('收不到的工具（注册在 agent 自己那层）跳过，不拖累同一批的其它工具', async () => {
  // 真机现场（2026-11-05）：team_* 在 agent.ctx 自己的层注册，restrict 收不到；
  // 而 restrict 是"一次校验全部名字"，混一个进去整条限制就失败 —— schedule_* 也跟着收不掉。
  let visible = [{ name: 'zhihu_search', description: '搜索知乎。' }];
  const agent = fakeAgentWithTools({ schemas: () => visible });
  const { binder } = binderWith(agent);
  await binder.ensure('qq-private-30000001');

  const original = agent.ctx.tools.restrict;
  agent.ctx.tools.restrict = (filter) => {
    const names = Array.isArray(filter?.deny) ? filter.deny : [];
    if (names.some((name) => name.startsWith('team_'))) {
      throw new Error('tools.restrict() names unknown global tool "team_task_list"');
    }
    return original(filter);
  };

  visible = [
    ...visible,
    { name: 'schedule_list', description: '列出定时任务。' },
    { name: 'team_task_list', description: '列出团队任务。' },
  ];
  const added = binder.refreshOnDemandTools(agent.ctx, 'qq-private-30000001');

  assert.equal(added, true, 'schedule_list 该被补收');
  assert.deepEqual(agent.restrictCalls.at(-1), { deny: ['zhihu_search', 'schedule_list'] });
  assert.match(agent.sections.at(-1).text, /schedule_list/);
  assert.doesNotMatch(agent.sections.at(-1).text, /team_task_list/, '收不到的别写进目录（会误导模型）');
});
