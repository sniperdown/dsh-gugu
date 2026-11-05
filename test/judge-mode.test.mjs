/**
 * 「说不说」的裁量模式（`judge_mode`）—— 模式 2 `precheck` / 模式 3 `inTurn`。
 *
 * ## 这一份测试钉的是什么
 *
 * 1. **默认（`heuristic`）行为一个字都没变** —— 提示词逐字相同、journal 逐字相同、
 *    precheck 一次都不调（"不配新键 ⇒ 行为不变"的反证）；
 * 2. 模式 2：**过阈值之后才问**、**只问一次**、**那一次请求里带着转录/当前消息/分数**、
 *    答「不该」⇒ **不起 agent**、失败/超时/答歪 ⇒ **降级成「该说」**；
 * 3. 模式 3：提示词里多出"倾向 + 允许弃权"，模型回空 ⇒ **不发**；
 * 4. 三种模式**共用同一条闸门与同一份打分**（装置里的打分器/引擎都是真的）。
 *
 * ⚠️ **纯离线**：假 transport + 假 stream，**一条真 QQ 消息都不会发**
 * （`sendToChat` 只往数组里 push）。
 *
 * ⚠️ 装置在 `test/judge-mode-harness.mjs`（`_qq-judge/probe-three-modes.mjs` 也用它，
 * 这样"测试里跑通的"与"报告里贴出来的"是**同一条链**）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OUTCOME } from '../src/dsh/gateway.mjs';
import {
  JUDGE_MODE_HEURISTIC,
  JUDGE_MODE_IN_TURN,
  JUDGE_MODE_PRECHECK,
  buildPrecheckPrompt,
  normalizeJudgeMode,
  parsePrecheckAnswer,
  resolvePrecheckModel,
} from '../src/dsh/judge-mode.mjs';
import { T0, gaugeStub, groupEvent, harness, makeStream, privateEvent, sendTwo } from './judge-mode-harness.mjs';

// ------------------------------------------------------- 纯函数（解析/归一化）

test('judge-mode：配置形状里有那三个键，且【没碰】gauge 那层（口径回归）', async () => {
  const { configShape, resolveConfig } = await import('../src/index.mjs');
  const { defaultGaugeConfig } = await import('../src/dsh/heuristic-gauge.mjs');
  const { defaultTriggerConfig } = await import('../src/proactive/engine.mjs');
  // ① 三个键在 `proactive` 段（画布 + 设计账本都写在那儿）
  assert.equal(configShape.proactive.judge_mode, 'heuristic');
  assert.equal(configShape.proactive.precheck_model, '');
  // ⚠️ 2026-10-14：`decline_bonus` 从"未实现的占位 3"变成**真实现了**（累积式攒劲儿），
  //    默认值 6 且**对着真源比**（不写死数字 —— 这条断言以前写死 3，改实现时就误报了）。
  assert.equal(configShape.proactive.decline_bonus, defaultTriggerConfig().decline_bonus);
  assert.equal(configShape.proactive.decline_bonus_cap, defaultTriggerConfig().decline_bonus_cap);
  assert.equal(
    configShape.proactive.decline_bonus_min_gap_ms,
    defaultTriggerConfig().decline_bonus_min_gap_ms,
  );
  // ② 🔴 `CONFIG_SHAPE.gauge` **不许**出现 `threshold` 一类会顶掉校准值的键
  //    （这一层历史上写错过两次：32→26、26→16）
  assert.equal(configShape.gauge.threshold, undefined);
  assert.equal(configShape.gauge.templates, undefined);
  assert.equal(configShape.gauge.fitWeights, undefined);
  // ③ 走一遍真正的合并：默认阈值得原样活着
  const resolved = resolveConfig({ mode: 'reverse', accessToken: 'x', botQQ: '1' });
  assert.equal(resolved.gauge.threshold, defaultGaugeConfig().threshold);
  assert.equal(resolved.gauge.threshold, 50);
  // ④ 不配新键 ⇒ 解析出来就是模式 1
  assert.equal(normalizeJudgeMode(resolved.proactive.judge_mode), JUDGE_MODE_HEURISTIC);
});

test('judge-mode：normalizeJudgeMode 认三种写法，其余一律回落 heuristic', () => {
  assert.equal(normalizeJudgeMode('heuristic'), JUDGE_MODE_HEURISTIC);
  assert.equal(normalizeJudgeMode('precheck'), JUDGE_MODE_PRECHECK);
  assert.equal(normalizeJudgeMode('inTurn'), JUDGE_MODE_IN_TURN);
  // 宽容：大小写 / 分隔符 / 前后空白
  assert.equal(normalizeJudgeMode(' IN_TURN '), JUDGE_MODE_IN_TURN);
  assert.equal(normalizeJudgeMode('in-turn'), JUDGE_MODE_IN_TURN);
  assert.equal(normalizeJudgeMode('PreCheck'), JUDGE_MODE_PRECHECK);
  // ⚠️ 写错 = 回默认（不是抛异常，也**不是**静默换成另一种模式）
  assert.equal(normalizeJudgeMode('inturn2'), JUDGE_MODE_HEURISTIC);
  assert.equal(normalizeJudgeMode(''), JUDGE_MODE_HEURISTIC);
  assert.equal(normalizeJudgeMode(null), JUDGE_MODE_HEURISTIC);
  assert.equal(normalizeJudgeMode(undefined), JUDGE_MODE_HEURISTIC);
});

test('judge-mode：resolvePrecheckModel 的两种写法（provider 可省）', () => {
  const opts = { defaultProvider: 'deepseek-official' };
  assert.deepEqual(resolvePrecheckModel('deepseek-flash', opts), {
    provider: 'deepseek-official', model: 'deepseek-flash', raw: 'deepseek-flash',
  });
  assert.deepEqual(resolvePrecheckModel('  deepseek-flash  ', opts), {
    provider: 'deepseek-official', model: 'deepseek-flash', raw: 'deepseek-flash',
  });
  // 没给出 provider 名单时，`a/b` 一律当**模型名**（模型 id 自己就常带斜杠）
  assert.deepEqual(resolvePrecheckModel('stepfun/step-5-preview', opts), {
    provider: 'deepseek-official', model: 'stepfun/step-5-preview', raw: 'stepfun/step-5-preview',
  });
  // 给了名单，且前半段真的是 provider ⇒ 拆开
  assert.deepEqual(resolvePrecheckModel('local-llamacpp/qwen3.5-4b-q4km', {
    defaultProvider: 'deepseek-official',
    knownProviders: ['deepseek-official', 'local-llamacpp'],
  }), {
    provider: 'local-llamacpp', model: 'qwen3.5-4b-q4km', raw: 'local-llamacpp/qwen3.5-4b-q4km',
  });
  // 留空 = 没配（调用侧会降级并打 warn）
  assert.deepEqual(resolvePrecheckModel('', opts), { provider: '', model: '', raw: '' });
});

test('judge-mode：parsePrecheckAnswer 不会把「不该」读成「该」', () => {
  assert.equal(parsePrecheckAnswer('该'), 'speak');
  assert.equal(parsePrecheckAnswer('该。'), 'speak');
  assert.equal(parsePrecheckAnswer('不该'), 'decline');
  assert.equal(parsePrecheckAnswer('不该。'), 'decline');
  assert.equal(parsePrecheckAnswer('这个不该接'), 'decline');
  assert.equal(parsePrecheckAnswer('不要接'), 'decline');
  assert.equal(parsePrecheckAnswer('no'), 'decline');
  assert.equal(parsePrecheckAnswer('yes'), 'speak');
  assert.equal(parsePrecheckAnswer(''), 'unparsed');
  assert.equal(parsePrecheckAnswer('唔……'), 'unparsed');
  assert.equal(parsePrecheckAnswer(null), 'unparsed');
});

test('judge-mode：那一次性的提示词里【转录/当前消息/总分/分项】全都在', () => {
  const prompt = buildPrecheckPrompt({
    transcript: '[09:18 2002] 今天试试那个新插件\n[09:21 2003] 诶这个 port 怎么改啊',
    chatId: 'group:200000001',
    kind: 'group',
    userId: '2003',
    messageText: '诶这个 port 怎么改啊',
    addressed: false,
    score: 161.6,
    threshold: 50,
    detail: { relevance: 0, content: -16.2, presence: 177.8, questions: 0, techHits: 2 },
    now: T0,
  });
  // ① 明说"没有上下文" —— 这就是用户那条硬约束的落地
  assert.match(prompt, /一次性的预检/);
  assert.match(prompt, /没有上下文/);
  // ② 转录
  assert.match(prompt, /今天试试那个新插件/);
  // ③ 当前这条（单独再给一份，因为转录里可能已经有它）
  assert.match(prompt, /刚发生的这条消息/);
  assert.match(prompt, /诶这个 port 怎么改啊/);
  // ④ 总分 + 阈值
  assert.match(prompt, /总分 161\.6/);
  assert.match(prompt, /阈值 50/);
  // ⑤ 分项
  assert.match(prompt, /她最近发言的存在感=\+177\.8/);
  assert.match(prompt, /技术词命中=2/);
  // ⑥ 会话形态
  assert.match(prompt, /group:200000001（群聊）/);
});

// ------------------------------------------------------ 模式 1：默认，逐字不变

test('模式 1（默认）：不配新键 ⇒ precheck 一次都不调，提示词与旧版逐字相同', async () => {
  const h = harness({ judgeMode: JUDGE_MODE_HEURISTIC });
  const result = await sendTwo(h);
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  // 🔴 关键反证：**一次模型调用都没有**
  assert.equal(h.stream.calls.length, 0);
  // 提示词里**没有**模式 3 的"倾向"段
  assert.doesNotMatch(h.responded[0].prompt, /要不要接，由你自己定/);
  assert.doesNotMatch(h.responded[0].prompt, /倾向/);
  // 逐字对照：环境轮提示词 = 转录 + 固定的那句要求（改动前就是这个形状）
  assert.equal(
    h.responded[0].prompt,
    [
      '群里刚在聊：',
      h.engine.transcript('group:100').render(20),
      '',
      '你想接一句话。要求：只回一句、不超过 40 字、像在群里随口接话、'
        + '不要 Markdown、不要解释你在做什么、不要重复别人说过的话。',
    ].join('\n'),
  );
  // journal 里**没有** precheck 留下的字段，也没有 pmode（模式 1 的日记逐字不变）
  const gauge = h.engine.journal.filter((e) => e.event === 'gauge').pop();
  assert.equal(gauge.pmode, undefined);
  assert.equal(gauge.pc_verdict, undefined);
  assert.equal(gauge.pc_source, undefined);
});

test('模式 1：precheck 器**挂着也不调**（模式 1 是零模型调用）', async () => {
  const h = harness({ judgeMode: JUDGE_MODE_HEURISTIC, stream: makeStream(['不该']) });
  await sendTwo(h);
  assert.equal(h.stream.calls.length, 0, '模式 1 下不该有任何轻量模型调用');
  assert.equal(h.responded.length, 1, '照常进 agent');
  // 计数器同样不动（"不调 = 不计数"，别让它在模式 1 下假装跑过）
  assert.equal(h.precheck.stats().total.calls, 0);
});

test('模式 1：打分器说"不说"时也不会去问 precheck', async () => {
  const h = harness({ judgeMode: JUDGE_MODE_HEURISTIC, gauge: gaugeStub({ speak: false, score: 26.5 }) });
  const result = await sendTwo(h);
  assert.equal(result.outcome, OUTCOME.OBSERVED);
  assert.equal(h.stream.calls.length, 0);
  assert.equal(h.responded.length, 0);
});

// ------------------------------------------------------------ 模式 2：precheck

test('模式 2：它答「该」⇒ 只调一次，且那次请求里带着转录/当前消息/分数 ⇒ 进 agent', async () => {
  const stream = makeStream(['该']);
  const h = harness({ judgeMode: JUDGE_MODE_PRECHECK, stream });
  const result = await sendTwo(h);
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.responded.length, 1);
  // 🔴 **只有一次调用**（一次性、没有多轮）
  assert.equal(stream.calls.length, 1);
  const { opts } = stream.calls[0];
  assert.equal(opts.provider, 'deepseek-official');
  assert.equal(opts.model, 'deepseek-flash');
  assert.equal(opts.reasoningEffort, 'off');
  assert.equal(opts.maxTokens, 4);
  // 🔴 **一条消息**：没有 system 之外的历史、没有 assistant/tool 轮次
  assert.equal(opts.messages.length, 1);
  assert.equal(opts.messages[0].role, 'user');
  const text = opts.messages[0].content[0].text;
  assert.match(text, /最近聊天（转录/);
  assert.match(text, /诶这个 port 怎么改啊/);
  assert.match(text, /总分 161\.6/);
  assert.match(text, /阈值 50/);
  assert.match(text, /存在感=\+177\.8/);
  // journal 里能看出"这条是 precheck 放行的"
  const gauge = h.engine.journal.filter((e) => e.event === 'gauge').pop();
  assert.equal(gauge.pmode, 'precheck');
  assert.equal(gauge.pc_verdict, 'speak');
  assert.equal(gauge.pc_source, 'reply');
  assert.equal(gauge.pc_model, 'deepseek-flash');
  assert.ok(gauge.pc_promptChars > 200, `提示词长度应可观测，实际 ${gauge.pc_promptChars}`);
});

test('模式 2：它答「不该」⇒ 不起 agent（省下那一轮），journal 留下证据', async () => {
  const stream = makeStream(['不该']);
  const h = harness({ judgeMode: JUDGE_MODE_PRECHECK, stream });
  const result = await sendTwo(h);
  assert.equal(result.outcome, OUTCOME.OBSERVED);
  assert.equal(result.reason, 'precheck-declined');
  // 🔴 没有起 agent：responder 一次都没被调，也没有任何回复发出去
  assert.equal(h.responded.length, 0);
  assert.equal(h.transport.sent.length, 0);
  assert.equal(stream.calls.length, 1);
  // 「被 precheck 拦下」在日记里是一条**独立**的记录，且带 `pc_*`
  const entry = h.engine.journal.filter((e) => e.event === 'precheck').pop();
  assert.ok(entry, 'journal 里必须有 event:precheck 那一条');
  assert.equal(entry.speak, false);
  assert.equal(entry.reason, 'precheck-declined');
  assert.equal(entry.pc_verdict, 'decline');
  assert.equal(entry.pc_source, 'decline');
  assert.equal(entry.pc_speak, false);
  assert.equal(entry.score, 161.6);
  assert.equal(entry.threshold, 50);
  // ⚠️ 它**不重复** `d_*`（那些已由上面那条 `gauge` 记过一份）
  assert.equal(entry.d_presence, undefined);
});

test('模式 2：轻量模型挂了 ⇒ 降级成「该说」（退回模式 1），不是哑掉', async () => {
  const stream = makeStream([new Error('ECONNRESET')]);
  const h = harness({ judgeMode: JUDGE_MODE_PRECHECK, stream, precheckRetry: 1 });
  const result = await sendTwo(h);
  assert.equal(result.outcome, OUTCOME.DISPATCHED, '失败必须降级成"该说"，绝不能把整条链哑掉');
  assert.equal(h.responded.length, 1);
  assert.equal(stream.calls.length, 2, '失败重试一次（默认 retry=1，本用例显式给了）');
  const entry = h.engine.journal.filter((e) => e.event === 'gauge').pop();
  assert.equal(entry.pc_source, 'error');
  assert.equal(entry.pc_speak, true);
});

test('模式 2：超时 ⇒ 降级成「该说」（有界等待，不会卡住消息链路）', async () => {
  // 数字 = 那个 stream 一直不吐字
  const stream = makeStream([200]);
  const h = harness({ judgeMode: JUDGE_MODE_PRECHECK, stream, precheckTimeoutMs: 40, precheckRetry: 0 });
  const started = Date.now();
  const result = await sendTwo(h);
  const spent = Date.now() - started;
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.ok(spent < 1500, `超时应当有界（实际 ${spent}ms）`);
  const entry = h.engine.journal.filter((e) => e.event === 'gauge').pop();
  assert.equal(entry.pc_source, 'timeout');
  assert.equal(entry.pc_speak, true);
});

test('模式 2：它答非所问（空/乱码）⇒ 降级成「该说」，只调一次不重试', async () => {
  const stream = makeStream(['唔……让我想想']);
  const h = harness({ judgeMode: JUDGE_MODE_PRECHECK, stream, precheckRetry: 1 });
  const result = await sendTwo(h);
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(stream.calls.length, 1, '答非所问重试没有意义 ⇒ 只调一次');
  const entry = h.engine.journal.filter((e) => e.event === 'gauge').pop();
  assert.equal(entry.pc_source, 'unparsed');
  assert.equal(entry.pc_speak, true);
  // 格式不对是**失败**，不是通过（虽然它降级成了"该说"）
  const total = h.precheck.stats().total;
  assert.equal(total.calls, 1);
  assert.equal(total.passed, 0, '降级成"该说"不等于判定器说了"该"');
  assert.equal(total.failedUnparsed, 1);
});

test('模式 2：没配 precheck_model ⇒ 降级成「该说」+ 一条 warn（不静默）', async () => {
  const stream = makeStream(['不该']);
  const h = harness({ judgeMode: JUDGE_MODE_PRECHECK, stream, precheckModel: '' });
  const result = await sendTwo(h);
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(stream.calls.length, 0);
  assert.ok(h.logs.some((l) => l.level === 'warn' && /precheck/.test(l.message)));
  assert.equal(h.engine.journal.filter((e) => e.event === 'gauge').pop().pc_source, 'no-model');
  // "没配模型"记 skippedNoModel（**配置问题，不是失败**），而且 enabled 必须是 false
  const stats = h.precheck.stats();
  assert.equal(stats.enabled, false);
  assert.equal(stats.total.calls, 1);
  assert.equal(stats.total.skippedNoModel, 1);
  assert.equal(stats.total.failed, 0, '配置没配 ≠ 判定器坏了');
});

test('模式 2：被点名那一轮**不花预检**（闸门短路 addressed，不打分也不问）', async () => {
  const stream = makeStream(['不该']);
  const h = harness({ judgeMode: JUDGE_MODE_PRECHECK, stream });
  await h.gateway.handleEvent(groupEvent()); // 预热
  const result = await h.gateway.handleEvent(groupEvent({
    message: [{ type: 'at', qq: '999' }, { type: 'text', text: ' 在不在' }],
    raw_message: '[CQ:at,qq=999] 在不在',
  }));
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(stream.calls.length, 0, '被点名是明确请求 ⇒ 不该花预检（更不该被它拦下）');
  // ⚠️ 判据用**判定层记的 `addressed`**，不用 `result.reason` ——
  // 后者的 `reason` 来自**路由**（`group-allowed`），不是"有没有被点名"。
  const entry = h.engine.journal.filter((e) => e.event === 'gauge').pop();
  assert.equal(entry.addressed, true);
  assert.equal(entry.pc_verdict, undefined, '被点名这条路压根不该有预检结论');
  assert.equal(h.responded.length, 1);
  // 被点名没走判定器 ⇒ 计数一次都不该涨（否则通过率会被"没问过"的那些稀释）
  assert.equal(h.precheck.stats().total.calls, 0);
});

// -------------------------------------------------------------- 模式 3：inTurn

test('模式 3：提示词里多出"倾向 + 允许弃权"，且分数来自打分器', async () => {
  const h = harness({ judgeMode: JUDGE_MODE_IN_TURN });
  const result = await sendTwo(h);
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.stream.calls.length, 0, 'inTurn 不做预检 ⇒ 零轻量调用');
  const prompt = h.responded[0].prompt;
  assert.match(prompt, /要不要接，由你自己定/);
  assert.match(prompt, /规则打分给这一条打了 161\.6 分/);
  assert.match(prompt, /门槛 50 分/);
  const lean = '这只是' + '**' + '一个倾向' + '**' + '，不是命令：';
  assert.ok(prompt.includes(lean), `提示词里应有"倾向"那句，实际提示词：${prompt}`);
  assert.match(prompt, /直接返回空回复是合法的/);
  // 旧的正文一个字没丢
  assert.match(prompt, /群里刚在聊：/);
  assert.match(prompt, /你想接一句话。要求：只回一句/);
});

test('模式 3：分数没到门槛 ⇒ 文案说"没够"，绝不再写"已经过线"（2026-11-02）', async () => {
  const h = harness({
    judgeMode: JUDGE_MODE_IN_TURN,
    gauge: async () => ({ speak: true, score: 28, threshold: 50, detail: {} }),
  });
  await sendTwo(h);
  const prompt = h.responded[0].prompt;
  assert.match(prompt, /门槛 50 分 —— 没够/);
  assert.doesNotMatch(prompt, /已经过线/, '28 分配 50 的门槛说"过线"会让她自我审查');
});

test('模式 3：门槛不是有限数 ⇒ 只给分数，不提门槛', async () => {
  const h = harness({
    judgeMode: JUDGE_MODE_IN_TURN,
    gauge: async () => ({ speak: true, score: 28, threshold: undefined, detail: {} }),
  });
  await sendTwo(h);
  const prompt = h.responded[0].prompt;
  assert.match(prompt, /规则打分给这一条打了 28 分/);
  assert.doesNotMatch(prompt, /门槛/, '拿不到门槛就别在提示词里提它');
});

test('模式 3：模型返回空 ⇒ 弃权，不发消息（复用既有的"空回复合法"出口）', async () => {
  const h = harness({ judgeMode: JUDGE_MODE_IN_TURN, responder: async () => '' });
  const result = await sendTwo(h);
  // 轮次照跑（那是"由它自己拍板"的前提），但**没有任何消息发出去**
  assert.equal(h.responded.length, 1);
  assert.equal(h.transport.sent.length, 0);
  assert.equal(result.reply, '');
  assert.ok(h.logs.some((l) => /inTurn 弃权/.test(l.message)));
  // ⚠️ 空回复也要记 `noteReplied`（冷却期照生效）—— 这是既有行为，不是新加的
  assert.ok(h.engine.state('group:100').lastBotAt > 0);
});

test('模式 3：被点名那一轮的提示词也带倾向（它同样可以弃权）', async () => {
  const h = harness({ judgeMode: JUDGE_MODE_IN_TURN });
  await h.gateway.handleEvent(groupEvent());
  await h.gateway.handleEvent(groupEvent({
    message: [{ type: 'at', qq: '999' }, { type: 'text', text: ' 在不在' }],
    raw_message: '[CQ:at,qq=999] 在不在',
  }));
  assert.match(h.responded[0].prompt, /要不要接，由你自己定/);
});

// ------------------------------------------- 第三态「等」（2026-11-01）

test('第三态：parsePrecheckAnswer 认「等」，且不把「不等」读成等待', () => {
  assert.equal(parsePrecheckAnswer('等'), 'wait');
  assert.equal(parsePrecheckAnswer('等等'), 'wait');
  assert.equal(parsePrecheckAnswer('还没说完'), 'wait');
  assert.equal(parsePrecheckAnswer('等他说完'), 'wait');
  assert.notEqual(parsePrecheckAnswer('不等'), 'wait');
  assert.notEqual(parsePrecheckAnswer('不该'), 'wait');
});

test('第三态：判官说「等」⇒ 不起 agent、挂标记；下一条跳过阈值再问一次', async () => {
  let scored = 0;
  const stream = makeStream(['等', '该']);
  const h = harness({
    judgeMode: JUDGE_MODE_PRECHECK,
    stream,
    engineConfig: { afterUserMsgCount: 1 },
    // 第一条给足分（能走到 precheck），第二条故意不给分 ——
    // 只有"没说完"的标记能让它照样进 precheck。这就是这条机制的全部意义。
    gauge: async () => {
      scored += 1;
      const pass = scored === 1;
      return { speak: pass, score: pass ? 100 : 1, threshold: 50, reason: 'stub', detail: {} };
    },
  });

  const first = await h.gateway.handleEvent(groupEvent());
  assert.equal(first.reason, 'precheck-wait');
  assert.equal(h.responded.length, 0, '「等」不该起 agent（省钱）');
  assert.equal(stream.calls.length, 1);
  const mark = h.engine.state('group:100').incomplete;
  assert.equal(mark.count, 1, '连续「等」的次数应记 1');
  assert.equal(h.precheck.stats().total.wait, 1, '计数进 wait 桶，不混进 passed / declined');
  assert.equal(h.precheck.stats().total.passed, 0, '「等」不是放行');

  const second = await h.gateway.handleEvent(groupEvent());
  assert.equal(second.outcome, OUTCOME.DISPATCHED, '标记在 ⇒ 跳过阈值，照样进 precheck');
  assert.equal(stream.calls.length, 2, '下一条必须再问一次');
  assert.equal(h.responded.length, 1);
  assert.equal(h.engine.state('group:100').incomplete, null, '判官给了结论就清标记');
});

test('第三态：标记过了 TTL 就作废（不会十分钟后还强制预检）', async () => {
  const h = harness({ judgeMode: JUDGE_MODE_PRECHECK, stream: makeStream(['不该']) });
  h.engine.state('group:100').noteIncomplete(T0 - 120_000);
  const result = await h.gateway.handleEvent(groupEvent());
  assert.notEqual(result.reason, 'precheck-wait');
});

// ------------------------------------------- 私聊单独一套（judge_mode_private）

test('私聊判定模式：群里 precheck、私聊配 inTurn ⇒ 私聊那一轮带"倾向"，群里不带', async () => {
  const h = harness({ judgeMode: JUDGE_MODE_PRECHECK, judgeModePrivate: JUDGE_MODE_IN_TURN });
  await h.gateway.handleEvent(privateEvent());
  assert.equal(h.responded.length, 1, '私聊照常进 agent');
  assert.match(h.responded[0].prompt, /要不要接，由你自己定/, '私聊该拿到"可以不说"那段');
  assert.equal(h.stream.calls.length, 0, '私聊是明确请求 ⇒ 不该花预检');
});

test('私聊判定模式：留空 = 跟随全局（全局 precheck ⇒ 私聊没有"倾向"那段）', async () => {
  const h = harness({ judgeMode: JUDGE_MODE_PRECHECK, judgeModePrivate: '' });
  await h.gateway.handleEvent(privateEvent());
  assert.equal(h.responded.length, 1);
  assert.ok(
    !h.responded[0].prompt.includes('要不要接，由你自己定'),
    '没配私聊模式 ⇒ 行为与接线前逐字相同',
  );
});

// ------------------------------------------------- 三种模式共用同一条闸门/打分

test('三种模式共用同一条闸门：没放行时谁都不进 agent（模式 2 也不花调用）', async () => {
  for (const mode of [JUDGE_MODE_HEURISTIC, JUDGE_MODE_PRECHECK, JUDGE_MODE_IN_TURN]) {
    const stream = makeStream(['该']);
    const h = harness({ judgeMode: mode, stream, engineConfig: { enabled: false } });
    const result = await h.gateway.handleEvent(groupEvent());
    assert.equal(result.outcome, OUTCOME.OBSERVED, `${mode} 下应被闸门挡下`);
    assert.equal(h.responded.length, 0, `${mode} 下不该起 agent`);
    assert.equal(stream.calls.length, 0, `${mode} 下不该花模型调用`);
    assert.equal(h.gaugeCalls.length, 0, `${mode} 下连打分都不该跑（闸门在打分之前）`);
  }
});

test('三种模式共用同一份打分：分数不够时三种模式都不进 agent', async () => {
  for (const mode of [JUDGE_MODE_HEURISTIC, JUDGE_MODE_PRECHECK, JUDGE_MODE_IN_TURN]) {
    const stream = makeStream(['该']);
    const h = harness({ judgeMode: mode, stream, gauge: gaugeStub({ speak: false, score: 26.5 }) });
    const result = await sendTwo(h);
    assert.equal(result.outcome, OUTCOME.OBSERVED, `${mode} 下分数不够应沉默`);
    assert.equal(h.responded.length, 0);
    assert.equal(stream.calls.length, 0, `${mode} 下"没过阈值"不该花预检`);
  }
});

// ------------------------------------------------ 判定器计数（2026-10-28 加）

/**
 * 这一节回答用户的原始问题：「判定器有在正常工作吗？**通过率**多少」。
 *
 * 之前快照里只有 `states`（攒了多少劲）和 20 条会滚掉的 `journal` —— 看不出
 * "一共问了几次 / 几次说该说 / 几次说不该 / 几次根本没答上来"。现在这些数在
 * `proactive.judge`（与 `states` 并列）。
 *
 * ⚠️ 这里刻意走**真网关**（`handleEvent` → `engine.decide` → `precheck.check`），
 * 而不是单独调 `check()` —— 要证明的是"接线通了、数真的会动"，不是"函数能算"。
 */
test('判定器计数：通过 / 否决 / 三种失败**分别落到各自的桶**（真网关连跑 5 条）', async () => {
  // 每一条消息消耗脚本里的下一项：该 / 不该 / 抛错 / 答歪 / 超时
  const stream = makeStream(['该', '不该', new Error('ECONNRESET'), '唔……让我想想', 200]);
  const h = harness({
    judgeMode: JUDGE_MODE_PRECHECK,
    stream,
    precheckRetry: 0, // 关掉重试，一条消息正好一次调用（重试的计数是另一回事）
    precheckTimeoutMs: 40,
  });

  // 第 1 条只用来过"预热门槛"（afterUserMsgCount=2），之后 5 条才真的问判定器
  await h.gateway.handleEvent(groupEvent());
  for (let i = 0; i < 5; i += 1) {
    await h.gateway.handleEvent(groupEvent());
  }
  assert.equal(stream.calls.length, 5, '五条消息 = 五次判定');

  const stats = h.precheck.stats();
  assert.equal(stats.enabled, true);
  assert.equal(stats.sessionCount, 1, '全在同一个群里');
  assert.equal(stats.sessions[0][0], 'group:100');

  const total = stats.total;
  assert.equal(total.calls, 5);
  assert.equal(total.passed, 1, '只有一条它真答了「该」');
  assert.equal(total.declined, 1);
  assert.equal(total.failed, 3, '超时 / 报错 / 格式不对');
  assert.equal(total.failedTimeout, 1);
  assert.equal(total.failedError, 1);
  assert.equal(total.failedUnparsed, 1);
  assert.equal(total.skipped, 0, '这五条都真的问了模型');
  assert.equal(total.other, 0);
  // 恒等式（调用方可以拿它自检）
  assert.equal(total.calls, total.passed + total.declined + total.failed + total.skipped + total.other);
  assert.equal(total.failed, total.failedTimeout + total.failedError + total.failedUnparsed);

  // 🔴 通过率口径：**只算答上来的那些**（1 通过 / (1+1)），不是 1/5
  assert.equal(total.passRate, 0.5);
  assert.equal(total.failRate, 0.6, '3 失败 / 5 次调用');

  // 最近一次（就是那条超时）的时间戳与耗时都可读
  assert.equal(total.lastSource, 'timeout');
  assert.ok(Number.isFinite(total.lastMs) && total.lastMs >= 0, `lastMs 应可读，实际 ${total.lastMs}`);
  assert.ok(Number.isFinite(Date.parse(total.lastAt)), `lastAt 应是 ISO 时间，实际 ${total.lastAt}`);
  assert.equal(total.lastFailedReason, 'timeout');
  assert.ok(Number.isFinite(Date.parse(total.lastFailedAt)));

  // 分会话的那一份与全局一致（只有一个会话）
  const [, row] = stats.sessions[0];
  assert.equal(row.calls, total.calls);
  assert.equal(row.passRate, total.passRate);
});

test('判定器计数：连续两次「该」⇒ 通过率 1；再来一次「不该」⇒ 0.667（口径与分母都钉住）', async () => {
  const stream = makeStream(['该', '该', '不该']);
  const h = harness({ judgeMode: JUDGE_MODE_PRECHECK, stream, precheckRetry: 0 });
  await h.gateway.handleEvent(groupEvent()); // 预热
  for (let i = 0; i < 3; i += 1) await h.gateway.handleEvent(groupEvent());

  const total = h.precheck.stats().total;
  assert.equal(total.calls, 3);
  assert.equal(total.passed, 2);
  assert.equal(total.declined, 1);
  assert.equal(total.passRate, 0.667);
  assert.equal(total.failRate, 0);
});


