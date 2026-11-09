/**
 * 「心情接线」—— `mood.mjs` 生成的那句话要进**两个地方**（2026-10-15）。
 *
 * 背景（用户原话）：**「进c，也要进a，进c是影响其发言，进a是影响是否说话；b就算了」**
 *
 * ```
 * 【c】system prompt（persona 段）→ 影响"怎么说话"   ⇒ binding.mjs 的 section.text 改成函数
 * 【a】precheck 的一次性提示词      → 影响"是否说话"   ⇒ judge-mode.mjs 多一行「小鲸鱼此刻的心情」
 * ```
 *
 * 接线前的病：`mood.mjs` 的 `getMood()` **零调用** —— 心情生成出来了，却没有任何地方读它。
 * 这一类"不报错、计数正常、只是什么都没发生"的坑在本项目最贵（见 `AGENTS.md`）。
 *
 * ## 这一份测试钉的四件事
 *
 * 1. **没心情 ⇒ 逐字节不变**（两个落点都是）：`[mood] enabled=false`（管理器 `null`）、
 *    这个会话还没生成过、空串、会话键反推不出 chatId —— 全都走"一个字都不加"；
 * 2. **有心情 ⇒ 加在哪、加的是哪句**（c 追加在人格末尾 / a 只多一行）；
 * 3. **不串台**：A 群的心情绝不能显示给 B 群（按 chatId 取值）；
 * 4. **绝不抛**：两个落点分别在提示词组装路径与消息热路径上（拿不到就当没有）。
 *
 * ⚠️ （a）的"逐字节不变"是拿 `test/mood-precheck-golden.mjs` 比的 —— 那是**改动前**
 * 真实输出的副本，不是"改后代码自己跟自己比"。
 * ⚠️ **纯离线**：假 stream / 假 ctx.agents，**一条真 QQ 消息都不会发**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionBinder } from '../src/dsh/binding.mjs';
import {
  JUDGE_MODE_HEURISTIC,
  JUDGE_MODE_PRECHECK,
  PRECHECK_MAX_TOKENS,
  PRECHECK_MAX_TOKENS_WITH_REASONING,
  PRECHECK_REASONING_EFFORT,
  buildPrecheckPrompt,
  createPrecheck,
} from '../src/dsh/judge-mode.mjs';
import { MOOD_TEXT_MAX_CHARS, moodTextFor } from '../src/index.mjs';
import { OUTCOME } from '../src/dsh/gateway.mjs';
import { PRECHECK_GOLDEN } from './mood-precheck-golden.mjs';
import { harness, makeStream, sendTwo } from './judge-mode-harness.mjs';

/** 假心情管理器：只有 `getAllMoods`（**纯快照，不创建状态**，与 `mood.mjs` 一致）。 */
const stubMood = (states) => ({ getAllMoods: () => ({ ...states }) });

// ============================================================ 1. moodTextFor 契约

test('moodTextFor：没有心情 ⇒ 空串（关掉 / 没记录 / 空串 / 空 chatId）', () => {
  assert.equal(moodTextFor(null, 'group:1'), '', '[mood] enabled=false ⇒ 管理器是 null，必须空串');
  assert.equal(moodTextFor(undefined, 'group:1'), '');
  assert.equal(moodTextFor(stubMood({}), 'group:1'), '', '这个会话还没生成过心情');
  assert.equal(moodTextFor(stubMood({ 'group:1': '' }), 'group:1'), '');
  assert.equal(moodTextFor(stubMood({ 'group:1': '   ' }), 'group:1'), '');
  assert.equal(moodTextFor(stubMood({ 'group:1': '开心' }), ''), '', '没有 chatId 就无从谈起"谁的心情"');
  assert.equal(moodTextFor(stubMood({ 'group:1': '开心' }), undefined), '');
});

test('moodTextFor：有心情 ⇒ 原样返回（压成单行、按码点截断）', () => {
  assert.equal(
    moodTextFor(stubMood({ 'group:1': '（轻轻晃着尾巴）开心的小鲸鱼~' }), 'group:1'),
    '（轻轻晃着尾巴）开心的小鲸鱼~',
  );
  // 模型可能吐换行：换行会把提示词里那一行拆成两段，所以压成空格。
  assert.equal(moodTextFor(stubMood({ 'group:1': '第一行\n第二行' }), 'group:1'), '第一行 第二行');
  // 长度上限：这是**每轮都进 prompt** 的东西（precheck 那条还要求"极短"）。
  const long = '心'.repeat(MOOD_TEXT_MAX_CHARS + 40);
  assert.equal(Array.from(moodTextFor(stubMood({ 'group:1': long }), 'group:1')).length, MOOD_TEXT_MAX_CHARS);
  // 截断按**码点**：别把 emoji 的代理对切成半个字符（那会渲染成乱码）。
  const emoji = '😀'.repeat(MOOD_TEXT_MAX_CHARS + 5);
  const clipped = moodTextFor(stubMood({ 'group:1': emoji }), 'group:1');
  assert.equal(Array.from(clipped).length, MOOD_TEXT_MAX_CHARS);
  assert.equal(clipped.includes('\uFFFD'), false);
});

test('moodTextFor：只认这个 chatId 的心情（A 群的心情绝不能显示给 B 群）', () => {
  const m = stubMood({ 'group:1': '甲群的心情', 'group:2': '乙群的心情' });
  assert.equal(moodTextFor(m, 'group:1'), '甲群的心情');
  assert.equal(moodTextFor(m, 'group:2'), '乙群的心情');
  assert.equal(moodTextFor(m, 'group:3'), '', '没记录的会话不许拿到别人的心情');
  assert.equal(moodTextFor(m, 'private:30000001'), '');
});

test('moodTextFor：绝不抛（管理器坏了 = 没有心情）', () => {
  const boom = () => {
    throw new Error('boom');
  };
  assert.equal(moodTextFor({ getAllMoods: boom }, 'group:1'), '');
  assert.equal(moodTextFor({ getAllMoods: () => null }, 'group:1'), '');
  assert.equal(moodTextFor({ getAllMoods: () => ['甲'] }, 'group:1'), '', '数组不是"会话→心情"的表');
  // 没有 `getAllMoods` 时退回 `getMood`（只读，不碰 `mood.mjs` 的状态机语义）
  assert.equal(moodTextFor({ getMood: (id) => (id === 'group:1' ? '平静' : '') }, 'group:1'), '平静');
  assert.equal(moodTextFor({}, 'group:1'), '', '两个方法都没有 ⇒ 空串，不是抛异常');
});

test('moodTextFor：读的是 getAllMoods（纯快照），**不会**顺手创建默认状态', () => {
  // 为什么钉这条：`getMood()` 会创建默认值 ⇒ 快照里凭空多出一堆 `感觉很平静`，
  // 把"没触发过"和"确实生成了这一句"混成同形（见 `mood.mjs` 的 `getMoodDiag` 注释）。
  const all = {};
  const m = {
    getAllMoods: () => ({ ...all }),
    getMood: () => {
      all['group:9'] = '感觉很平静';
      return '感觉很平静';
    },
  };
  assert.equal(moodTextFor(m, 'group:9'), '');
  assert.deepEqual(all, {}, '只读的地方不许写入状态');
});

// ================================================== 2.【c】进 system prompt（persona 段）

const PERSONA = '你是「小鲸鱼」。\n\n【说话方式】\n- 简短优先。';

/**
 * 走**真的** `ensure()`（假 `ctx.agents` 在返回前跑一遍 `setup(agentCtx)`，与宿主一致），
 * 把注册上去的 section 抓下来，再按 `dsh-system-prompt` 的调用方式（`section.text(context)`）取值。
 */
async function personaSection({ sessionKey = 'qq-group-200000001', moodFor = null, persona = PERSONA } = {}) {
  const sections = [];
  const agentCtx = {
    systemPrompt: {
      section: (s) => sections.push(s),
      getSectionOrder: () => 0,
    },
    tools: { restrict: () => () => {} },
  };
  const agents = {
    async resume(options) {
      if (typeof options.setup === 'function') await options.setup(agentCtx);
      return { agent: { session: { header: { cwd: 'H:\\work' } } }, dispose: async () => {} };
    },
  };
  const binder = new SessionBinder({ ctx: { agents }, persona, moodFor });
  await binder.ensure(sessionKey);
  const section = sections.find((s) => s.name === 'deployment:persona-prefix');
  assert.ok(section, 'persona-prefix 段必须注册上');
  return { section, text: typeof section.text === 'function' ? section.text({}) : section.text };
}

test('【c】心情接进 persona 段：`section.text` 是**函数**（每轮现算，不累积）', async () => {
  const { section, text } = await personaSection({
    moodFor: (chatId) => (chatId === 'group:200000001' ? '有点感慨。' : ''),
  });
  assert.equal(
    typeof section.text,
    'function',
    '必须是函数：`dsh-system-prompt/lib/index.js:342` 每轮 assemble 时现算（固定串做不到"动态"）',
  );
  assert.equal(text, `${PERSONA}\n\n（你现在的心情：有点感慨。）`);
});

test('【c】没有心情 ⇒ 与人格原文**逐字节相同**（四种"没有"）', async () => {
  // ① 压根没接线（`moodFor` 没传）
  assert.equal((await personaSection({ moodFor: null })).text, PERSONA);
  // ② 接线了，但 `[mood] enabled=false`（管理器 null ⇒ 取值器恒空）
  assert.equal((await personaSection({ moodFor: (chatId) => moodTextFor(null, chatId) })).text, PERSONA);
  // ③ 这个会话还没生成过心情
  assert.equal((await personaSection({ moodFor: (chatId) => moodTextFor(stubMood({}), chatId) })).text, PERSONA);
  // ④ 会话键反推不出 chatId（`dmRouting=main` 的 `session-<uuid>`）
  const withMood = (chatId) => moodTextFor(stubMood({ 'group:200000001': '开心' }), chatId);
  assert.equal(
    (await personaSection({ sessionKey: 'session-00000000-0000-0000-0000-000000000000', moodFor: withMood })).text,
    PERSONA,
    '反推不出 chatId ⇒ 一个字都不加（宁可没有心情，也不能张冠李戴）',
  );
  // ⑤ 心情属于**别的**会话
  assert.equal((await personaSection({ sessionKey: 'qq-group-30000011', moodFor: withMood })).text, PERSONA);
});

test('【c】取心情时抛错 ⇒ 当作没有心情（提示词组装绝不能被它拖垮）', async () => {
  const boom = () => {
    throw new Error('mood boom');
  };
  const { text } = await personaSection({ moodFor: boom });
  assert.equal(text, PERSONA, '拿不到心情 = 没有心情，**不能**让这一轮连回复都产不出来');
});

test('【c】心情里的 `{{` 必须被拆开（否则提示词变量解析会抛，整轮组装失败）', async () => {
  // `dsh-system-prompt` 的 `renderPrompt()` 会 interpolate **每一段** section 正文，
  // 遇到 `{{未知变量}}` 直接抛（`lib/index.js:169`）。而心情是**模型生成的任意文本**。
  const { text } = await personaSection({ moodFor: () => '看到 {{cwd}} 就想笑' });
  assert.equal(text, `${PERSONA}\n\n（你现在的心情：看到 { {cwd} } 就想笑）`);
  assert.equal(text.includes('{{'), false, '正文里不许再出现 `{{`');
  assert.equal(text.includes('}}'), false);
});

// ============================================== 3.【a】进 precheck 的一次性提示词

const T0 = Date.UTC(2026, 9, 13, 9, 20, 0);
const PRECHECK_INPUT = {
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
};

/** 基准里的 `{{CLOCK}}` → 本地时钟（`formatClock` 走本地时区，换机器会变）。 */
function goldenPrompt() {
  const d = new Date(T0);
  const pad = (n) => String(n).padStart(2, '0');
  return PRECHECK_GOLDEN.replace('{{CLOCK}}', `${pad(d.getHours())}:${pad(d.getMinutes())}`);
}

/** 跑一次真的 `check()`（假 stream，答「该」），返回那次请求的正文与 `promptChars`。 */
async function runPrecheck(input, options = {}) {
  const seen = [];
  const stream = (opts) => {
    seen.push(opts);
    return (async function* gen() {
      yield { type: 'text-delta', text: '该' };
    })();
  };
  const precheck = createPrecheck({ stream, provider: 'p', model: 'm', timeoutMs: 500, retry: 0, ...options });
  const outcome = await precheck.check(input);
  return { outcome, prompt: seen[0].messages[0].content[0].text, opts: seen[0] };
}

test('【a】没有心情 ⇒ 那一次性的预检提示词与**接线前逐字节相同**', async () => {
  const golden = goldenPrompt();
  assert.equal(buildPrecheckPrompt(PRECHECK_INPUT), golden, '纯拼装函数：没有心情这一段一个字都不变');
  const { outcome, prompt } = await runPrecheck(PRECHECK_INPUT);
  assert.equal(prompt, golden, '`check()` 那条路同样逐字节不变');
  assert.equal(outcome.promptChars, golden.length, '快照/journal 里那个 `promptChars` 也要一样');
  // 关掉心情（管理器 null）同理
  const off = await runPrecheck(PRECHECK_INPUT, { moodFor: (chatId) => moodTextFor(null, chatId) });
  assert.equal(off.prompt, golden);
  assert.equal(off.outcome.promptChars, golden.length);
});

test('【a】有心情 ⇒ 只多**一行**，位置在会话背景里（并给出 promptChars 的差）', async () => {
  const golden = goldenPrompt();
  const { outcome, prompt, opts } = await runPrecheck(PRECHECK_INPUT, {
    moodFor: (chatId) => moodTextFor(stubMood({ 'group:200000001': '有点感慨。' }), chatId),
  });
  const moodLine = '【小鲸鱼此刻的心情】有点感慨。';
  const expected = golden.replace('【这条消息的发送者】2003\n', `【这条消息的发送者】2003\n${moodLine}\n`);
  assert.equal(prompt, expected, '就多这一行（插在【会话】那一段里），别处一个字不动');
  assert.equal(outcome.promptChars - golden.length, moodLine.length + 1, 'promptChars 的差 = 那一行 + 一个换行');
  // 那一次调用仍然极省：系统提示没变 / 没有多轮 / 预算跟着思考档走。
  // ⚠️ 2026-11-06：`reasoningEffort` 从 `'off'` 改成 `'low'`（档位在 `judge-mode.mjs`），
  //    预算随之从 4 涨到 96 —— 所以这里**引用常量**而不是写死数字：
  //    档位是活配置，写死只会让"改了档位"变成一条莫名其妙的红（这次就红了一轮）。
  assert.equal(opts.reasoningEffort, PRECHECK_REASONING_EFFORT);
  assert.equal(
    opts.maxTokens,
    PRECHECK_REASONING_EFFORT === 'off' ? PRECHECK_MAX_TOKENS : PRECHECK_MAX_TOKENS_WITH_REASONING,
  );
  assert.equal(opts.messages.length, 1);
  assert.match(opts.system, /预检器/);
});

test('【a】按 chatId 取心情：别的会话不串台，取不到就不加', async () => {
  const golden = goldenPrompt();
  const moodFor = (chatId) => moodTextFor(stubMood({ 'group:200000001': '有点感慨。' }), chatId);
  const other = await runPrecheck({ ...PRECHECK_INPUT, chatId: 'group:30000011' }, { moodFor });
  assert.equal(other.prompt, golden.replace('group:200000001', 'group:30000011'));
  assert.equal(other.prompt.includes('小鲸鱼此刻的心情'), false);
});

test('【a】取心情时抛错 ⇒ 当作没有心情（消息热路径绝不能被它炸掉）', async () => {
  const golden = goldenPrompt();
  const boom = () => {
    throw new Error('mood boom');
  };
  const { prompt, outcome } = await runPrecheck(PRECHECK_INPUT, { moodFor: boom });
  assert.equal(prompt, golden);
  assert.equal(outcome.promptChars, golden.length);
  assert.equal(outcome.speak, true, '照常答"该"（这次调用本身没受影响）');
});

// ============================================================ 4. 休眠证明（模式 1）

test('【休眠证明】`judge_mode=heuristic`：心情接了线也**零影响**（预检一次都不调）', async () => {
  // 硬要求：`judge_mode` 保持 heuristic 不动 ⇒ （a）这一段在默认配置下**是休眠的**。
  // 判据：模式 1 是零模型调用（网关上 `judgeMode === 'precheck'` 才碰 precheck）。
  const h = harness({ judgeMode: JUDGE_MODE_HEURISTIC, moodFor: () => '有点感慨。' });
  const result = await sendTwo(h);
  assert.equal(result.outcome, OUTCOME.DISPATCHED);
  assert.equal(h.stream.calls.length, 0, '模式 1 一次模型调用都没有 ⇒ 心情那行没机会出现');
  assert.equal(h.responded[0].prompt.includes('小鲸鱼此刻的心情'), false);
  assert.equal(h.responded[0].prompt.includes('你现在的心情'), false);
});

test('【对照】`judge_mode=precheck`：那一次调用里确实带着心情那句话', async () => {
  const stream = makeStream(['该']);
  const h = harness({
    judgeMode: JUDGE_MODE_PRECHECK,
    stream,
    moodFor: (chatId) => (chatId === 'group:100' ? '有点感慨。' : ''),
  });
  await sendTwo(h);
  assert.equal(stream.calls.length, 1, '一次性调用：只有一次');
  const text = stream.calls[0].opts.messages[0].content[0].text;
  assert.match(text, /【小鲸鱼此刻的心情】有点感慨。/);
  const gauge = h.engine.journal.filter((e) => e.event === 'gauge').pop();
  assert.ok(gauge.pc_promptChars > 0, '`promptChars` 照旧可观测');
});

test('【对照】precheck + 没心情 ⇒ 那一次调用与不接线时逐字相同', async () => {
  const withNull = makeStream(['该']);
  const a = harness({ judgeMode: JUDGE_MODE_PRECHECK, stream: withNull, moodFor: (chatId) => moodTextFor(null, chatId) });
  await sendTwo(a);
  const withOut = makeStream(['该']);
  const b = harness({ judgeMode: JUDGE_MODE_PRECHECK, stream: withOut });
  await sendTwo(b);
  assert.equal(
    withNull.calls[0].opts.messages[0].content[0].text,
    withOut.calls[0].opts.messages[0].content[0].text,
  );
});
