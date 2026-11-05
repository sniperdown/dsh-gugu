/**
 * 主动发言引擎的离线测试。零依赖，`node --test` 直接跑。
 *
 * 这里刻意把「引擎自己该负责的决策」和「留给模型判的事」分开测：
 * 引擎的职责是**在错误的时候绝不说话**，所以大部分用例断言的是「没说话」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProactiveEngine,
  Transcript,
  ChatState,
  normalizeDecision,
  formatClock,
  formatStamp,
  defaultTriggerConfig,
  flattenDetail,
  mentionedByName,
  replaceImagePlaceholders,
} from '../src/proactive/engine.mjs';
import { defaultGaugeConfig } from '../src/dsh/heuristic-gauge.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ---------------------------------------------------------------- 名字识别
//
// 回归：gauge 里 `nameMentioned`（+45 相关分）一直存在，但**引擎从没设置过它** ——
// 实测用户在测试群连发「小鲸鱼在不在」「小鲸鱼？」全被沉默。这条把"用文字喊名字"
// 这个信号钉住，别再断掉。

test('mentionedByName：喊昵称或别名都算', () => {
  const names = ['小鲸鱼', '鸽子', '小鲸鱼'];
  assert.equal(mentionedByName({ text: '小鲸鱼在不在' }, names), true);
  assert.equal(mentionedByName({ text: '小鲸鱼？' }, names), true);
  assert.equal(mentionedByName({ text: '鸽子在吗' }, names), true);
  assert.equal(mentionedByName({ text: '小鲸鱼快出来' }, names), true);
});

test('mentionedByName：没喊名字就不算', () => {
  const names = ['小鲸鱼', '鸽子'];
  assert.equal(mentionedByName({ text: '今天好累啊' }, names), false);
  assert.equal(mentionedByName({ text: '' }, names), false);
  assert.equal(mentionedByName({}, names), false);
});

test('mentionedByName：raw 里喊到也算（段数组丢正文时的兜底）', () => {
  assert.equal(mentionedByName({ text: '', raw: '[CQ:at,qq=1] 小鲸鱼 看看这个' }, ['小鲸鱼']), true);
});

test('mentionedByName：names 为空时一律不算（不误判成"叫了"）', () => {
  assert.equal(mentionedByName({ text: '小鲸鱼在不在' }, []), false);
  assert.equal(mentionedByName({ text: '小鲸鱼在不在' }, undefined), false);
});

test('引擎把 names 带下来，并作用于 nameMentioned', async () => {
  const seen = [];
  const T = Date.now();
  const engine = new ProactiveEngine({
    // 注：这里以前要显式关掉 quietHours / burst 门槛（默认值会挡掉判定）。
    // 那两道闸门 2026-10-07 已经删了，所以不再需要那些开关。
    config: {
      ...defaultTriggerConfig(),
      enabled: true,
      minIntervalMs: 0,
      afterUserMsgCount: 0,
      cooldownAfterBotMs: 0,
    },
    names: ['小鲸鱼'],
    allowed: () => true,
    gauge: (request) => { seen.push(request.nameMentioned); return { text: '在' }; },
    speak: async () => true,
    log: () => {},
    now: () => T,
  });

  // 注意 `mentioned: false`：引擎里「@ 我」会提前 return（那条走被动通道）。
  const base = { chatId: 'group:1', kind: 'group', mentioned: false, at: T };
  await engine.decide({ ...base, messageId: 1, text: '小鲸鱼在不在' });
  await engine.decide({ ...base, messageId: 2, at: T + 1000, text: '今天好累啊' });

  assert.deepEqual(seen, [true, false], '第一条喊了名字、第二条没有');
});

/** 固定起点，让所有断言可复现：2026-03-01 12:00:00 UTC。 */
const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);

/** 造一条群消息。 */
function msg(overrides = {}) {
  return {
    chatId: 'group:100',
    kind: 'group',
    userId: '2001',
    nickname: '阿猫',
    text: '今天这个 bug 有点意思',
    at: T0,
    mentioned: false,
    ...overrides,
  };
}

/**
 * 装一台可控的引擎：假判定 + 记录发言 + 可控时钟。
 *
 * 默认把「机器人刚说完话的冷却」设为 0，让每个用例只考一件事；
 * 需要考冷却的用例自己把它调回来。
 * @param {object} [options]
 */
function harness(options = {}) {
  const spoken = [];
  const gauges = [];
  const logs = [];
  let now = T0;

  const engine = new ProactiveEngine({
    config: {
      // 测试里把门槛都调低，让单个用例只考一件事。
      enabled: true,
      minIntervalMs: MINUTE,
      maxPerHour: 3,
      cooldownAfterBotMs: 0,
      afterUserMsgCount: 1,
      ...(options.config ?? {}),
    },
    gauge: async (request) => {
      gauges.push(request);
      if (options.gauge) return options.gauge(request, gauges.length);
      // 判定层现在只认 `speak: true`（措辞已改由会话生成），所以默认桩必须给这个字段。
      return { speak: true, text: `冒泡第${gauges.length}次` };
    },
    speak: async (request) => {
      spoken.push(request);
      if (options.speak) return options.speak(request, spoken.length);
    },
    allowed: options.allowed,
    names: options.names ?? ['小鲸鱼'],
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => (options.clock ? options.clock() : now),
  });

  return {
    engine,
    spoken,
    gauges,
    logs,
    /**
     * 统一判定入口的测试包装。
     *
     * 重构后引擎**自己不再发言**（说什么由会话决定），所以测试不再能靠
     * `engine.ingest` 观察"说没说"。这里把网关的行为搬进来：
     * 判定说 speak → 记一条 spoken + 记账（noteReplied），于是绝大多数
     * 老断言（`h.spoken.length`）原样成立。
     */
    decide: async (msg) => {
      const d = await engine.decide(msg);
      if (d.speak === true) {
        spoken.push({ chatId: msg.chatId, kind: msg.kind, trigger: d.reason, at: msg.at, addressed: d.addressed });
        engine.noteReplied(msg.chatId, msg.at, d.addressed === true);
      }
      return d;
    },
    setNow: (v) => {
      now = v;
    },
    getNow: () => now,
  };
}

// ---------------------------------------------------------------- 专注度（聊上了）
//
// 回归：兴趣打分没触发时，靠 focus_value 决定「机器人刚说完话、别人在接话」要不要续聊。
// 对应 MaiBot 的 focus_value，解决「插一句就掉线」的问题（用户实测踩到）。

test('专注度：小鲸鱼刚说完且别人引用回复 → focus = 1.0', async () => {
  const h = harness({ clock: () => T0 });
  // 小鲸鱼 2 秒前刚说过话（30 秒专注窗口内）—— 而且那条是**问句**：
  // 2026-10-12 起，时间票（+0.5）只在"她最后一条是问句/请求"时才给。
  h.engine.noteBotSpoke('group:100', T0 - 2000, '要我去通知主会话吗？');
  // 别人引用回复小鲸鱼
  await h.decide(msg({ text: '那你觉得呢', replyToSelf: true }));
  const req = h.gauges[h.gauges.length - 1];
  assert.equal(req.focus, 1, `紧接(0.5) + 引用回复(0.5) 应 = 1.0，实际 ${req.focus}`);
});

test('专注度：紧接小鲸鱼发言（30秒内，未引用）且**她问过话** → focus = 0.5', async () => {
  const h = harness({ clock: () => T0 });
  h.engine.noteBotSpoke('group:100', T0 - 5000, '需要我去通知主会话吗？');
  await h.decide(msg({ at: T0, text: '接着刚才的说', messageId: 1 }));
  const req = h.gauges[h.gauges.length - 1];
  assert.equal(req.focus, 0.5, `她刚问完话，紧接 5 秒内应 focus 0.5，实际 ${req.focus}`);
});

test('专注度：紧接小鲸鱼发言（30秒内，未引用）可她只是**评论**过 → focus = 0', async () => {
  // 2026-10-12 改动 A：这一票原来**无条件**给 +0.5，而它单独就等于
  // `focusSpeakThreshold`(0.5) ⇒ `focusEnough` 恒真 ⇒ 她说完话后专注窗口内
  // **群里任何消息都让她回一轮**。她只是评论一句、别人接着聊别的，不算在接她的话。
  const h = harness({ clock: () => T0 });
  h.engine.noteBotSpoke('group:100', T0 - 5000, '今天这个 bug 有点意思');
  await h.decide(msg({ at: T0, text: '接着刚才的说', messageId: 1 }));
  const req = h.gauges[h.gauges.length - 1];
  assert.equal(req.focus, 0, `她只是评论 → 时间票不该给，实际 ${req.focus}`);
});

test('★ 专注度（票C，2026-10-15）：她【被点名回过话】后，别人普通接话 ⇒ focus = 0.5，且真能说', async () => {
  // 用户 2026-10-15 原话：「感觉 at 之后得有一段时间高概率接收消息啊，
  // 不然我后续发的没啥回的可能性了」。
  //
  // 现场证据（journal）：冷清群里普通消息只有 8~15 分，而阈值 50
  // ⇒ **永远够不到**；而票A（要别人**引用回复**）和票B（要她**最后一条是问句**）
  // 在他那个场景**都不触发** ⇒ `focus` 恒 0 ⇒ 她等于哑了。
  //
  // 票C 补的就是"别人刚把她叫出来"这一段。这里让判定器明说"不接"
  // （模拟真实分数 9 < 50），**能说出来才证明是 focus 通道放的行**。
  const h = harness({
    clock: () => T0,
    gauge: () => ({ speak: false, score: 9, threshold: 50 }),
  });
  // 她被 @ 并回了话 —— 走网关那条路（`noteReplied(chatId, at, addressed=true, text)`）。
  h.engine.noteReplied('group:100', T0 - 10_000, true, '在的在的，用户~');
  // 10 秒后（默认专注窗口 30 秒内）用户普通接一句：不引用、她上一条也不是问句。
  const d = await h.decide(msg({ at: T0, text: '那你看看这个', messageId: 1 }));
  const req = h.gauges[h.gauges.length - 1];
  assert.equal(req.focus, 0.5, `被点名回过话后 10 秒，focus 应为 0.5，实际 ${req.focus}`);
  assert.equal(d.speak, true, '打分 9 < 50 没过，但票C 的 focus 通道该放行');
});

test('★ 专注度（票C 边界）：她自己【冒泡插话】不开这个窗口（只有别人找她才算）', async () => {
  // `noteReplied(addressed=false)` 走的是 `noteSpeak` —— 那是"机会主义插话"，
  // 不是"别人刚找过她" ⇒ **不该**开票C 的窗口。
  // （否则她顺口插一句就能给自己续 60 秒免打分发言权，正是 2026-10-12 修掉的那类失控。）
  //
  // ⚠️ `minIntervalMs: 0` 必须给：`noteSpeak` 会写 `lastSpeakAt`，而 harness 默认
  // `minIntervalMs = MINUTE` ⇒ 那条消息会在 `min-interval` 闸门被挡掉、**根本进不了打分**
  // ⇒ `h.gauges` 为空、断言拿不到 focus。本用例只考票C，别的闸门一律放开。
  const h = harness({
    clock: () => T0,
    config: { minIntervalMs: 0 },
    gauge: () => ({ speak: false, score: 9, threshold: 50 }),
  });
  h.engine.noteReplied('group:100', T0 - 10_000, false, '今天这个 bug 有点意思');
  const d = await h.decide(msg({ at: T0, text: '接着刚才的说', messageId: 1 }));
  const req = h.gauges[h.gauges.length - 1];
  assert.equal(req.focus, 0, `她自己冒泡不该开票C 窗口，实际 focus=${req.focus}`);
  assert.equal(d.speak, false, '而且分数没过 ⇒ 不该说');
});

test('★ 专注度（票C 边界）：超出专注窗口就不给（默认 30 秒）', async () => {
  const h = harness({
    clock: () => T0,
    config: { minIntervalMs: 0 },
    gauge: () => ({ speak: false, score: 9, threshold: 50 }),
  });
  h.engine.noteReplied('group:100', T0 - 40_000, true, '在的在的');
  const d = await h.decide(msg({ at: T0, text: '过了 40 秒才接话', messageId: 1 }));
  const req = h.gauges[h.gauges.length - 1];
  assert.equal(req.focus, 0, `40 秒 > 30 秒窗口 ⇒ focus 应为 0，实际 ${req.focus}`);
  assert.equal(d.speak, false);
});

// ------------------------------------------------- 突发消息（2026-10-16 示例群 6 连发）
//
// 线上实证：2026-10-16 12:03:54~12:04:02，示例群（30000013）小鲸鱼 **10 秒内连发 6 条**
// （turn 29→34，间隔 1.5~1.8 秒）。那个群该守 minIntervalMs=60000 / cooldownAfterBotMs=30000
// ⇒ 本该被挡。根因：`#gate` 的检查发生在**串行点之前**，而 `lastBotAt` 要等回复真发出去
// （网关回调 `noteReplied`）才更新 ⇒ 1.5 秒内连发的消息**全部**看到"她好久没说话" ⇒ 全放行。
//
// ⚠️ 所以这个用例【必须直连 `engine.decide`】、**刻意不调 `noteReplied`** ——
// 那正是线上"回合还没跑完"的窗口。用 harness 的 `decide` 包装会在每次发言后立刻记账，
// **恰恰把这个窗口抹掉，测不出这个 bug**（第一版就是这么写错的）。

test('★ 突发刷屏：1.5 秒内连投 6 条，只该放行 1 条（闸门不能集体迟到）', async () => {
  const h = harness({
    config: { cooldownAfterBotMs: 30_000, minIntervalMs: 60_000, maxPerHour: 100, afterUserMsgCount: 1 },
    gauge: () => ({ speak: true, text: '值得接' }),
  });
  const results = [];
  for (let i = 0; i < 6; i++) {
    const at = T0 + i * 300; // 每条间隔 300ms —— 比一个真实回合（约 1.5 秒）短得多
    h.setNow(at);
    results.push(await h.engine.decide(msg({ at, messageId: 100 + i, text: `第${i + 1}条` })));
  }
  const spoke = results.filter((d) => d.speak === true);
  assert.equal(
    spoke.length,
    1,
    `6 条突发只该放行 1 条，实际放了 ${spoke.length} 条（reason: ${results.map((d) => d.reason).join(' / ')}）`,
  );
  assert.equal(results[1].reason, 'cooldown-after-bot', '第 2 条起该被「刚说过话」挡掉');
  assert.equal(results[5].reason, 'cooldown-after-bot', '第 6 条同样该被挡');
});

test('★ 突发刷屏：突发过后（冷却走完）她还能正常说话 —— 别把她锁死', async () => {
  const h = harness({
    config: { cooldownAfterBotMs: 30_000, minIntervalMs: 60_000, maxPerHour: 100, afterUserMsgCount: 1 },
    gauge: () => ({ speak: true, text: '值得接' }),
  });
  h.setNow(T0);
  assert.equal((await h.engine.decide(msg({ at: T0, messageId: 1 }))).speak, true, '第一条该说');
  // 冷却期内不说
  h.setNow(T0 + 10_000);
  assert.equal((await h.engine.decide(msg({ at: T0 + 10_000, messageId: 2 }))).speak, false);
  // 过了冷却 + 最小间隔 ⇒ 又能说
  h.setNow(T0 + 61_000);
  assert.equal(
    (await h.engine.decide(msg({ at: T0 + 61_000, messageId: 3 }))).speak,
    true,
    '冷却与最小间隔都过了 ⇒ 不该被永久锁死',
  );
});

test('专注度（不变量 1）：她【问了话】→ 别人 5 秒后简短作答（未引用）⇒ focus = 0.5，且这一轮真能说', async () => {
  // 用户 2026-10-11 的原话场景：小鲸鱼问「需要我去通知主会话吗」→ 用户答「好啊」→ 被拒。
  // 打分那一关「好啊」只值 7.3 分（阈值 24），**从来没上过打分的线，全靠 focus 救** ——
  // 所以这里让判定器明说"不接"：能说出来才证明是 focus 放的行。
  const h = harness({
    clock: () => T0,
    gauge: () => ({ speak: false, score: 7.3, threshold: 24 }),
  });
  h.engine.noteBotSpoke('group:100', T0 - 5000, '需要我去通知主会话吗？');
  const d = await h.decide(msg({ at: T0, text: '好啊', messageId: 1 }));

  assert.equal(h.gauges.at(-1).focus, 0.5, '她刚问完话 → 别人接一句该算心流');
  assert.equal(d.speak, true, '必须放行 —— 放行不了就是当年那个"掉线"回归');
  assert.equal(d.reason, 'focus', '打分没过线，能说只可能是 focus 这条路');
  assert.equal(h.spoken.length, 1);
});

test('专注度：她上一条**不是**问句时，别人引用回复仍然 +0.5（这一票无条件）', async () => {
  const h = harness({ clock: () => T0 });
  h.engine.noteBotSpoke('group:100', T0 - 2000, '我刚看了下日志');
  await h.decide(msg({ at: T0, text: '那你觉得呢', replyToSelf: true, messageId: 1 }));
  const req = h.gauges.at(-1);
  assert.equal(req.focus, 0.5, '引用回复与"她那句是不是问句"无关');
  assert.equal(req.botSpokeRecently, true, 'botSpokeRecently 字段不受问句判断影响（短反应豁免要用）');
});

test('专注度：窗口里她说够 3 条 ⇒ 时间票不再给（疲惫，MaiBot 的 _message_threshold）', async () => {
  const h = harness({
    clock: () => T0,
    gauge: () => ({ speak: false, score: 7.3, threshold: 24 }),
  });
  h.engine.noteBotSpoke('group:100', T0 - 6000, '要我去通知主会话吗？');
  h.engine.noteBotSpoke('group:100', T0 - 4000, '那我现在就去，行吗');
  h.engine.noteBotSpoke('group:100', T0 - 2000, '顺便问一句，日志放哪了？');

  const d = await h.decide(msg({ at: T0, text: '好啊', messageId: 1 }));
  const req = h.gauges.at(-1);
  assert.equal(req.focus, 0, '她自己都说 3 条了，第 4 条该回去打分');
  assert.equal(req.botSpokeRecently, true, '但"她刚说过话"这个事实照旧带给判定层');
  assert.equal(d.speak, false);
});

test('专注度：窗口里她说 2 条（未到 3）⇒ 心流还在，正常连续对话不被砍', async () => {
  const h = harness({
    clock: () => T0,
    gauge: () => ({ speak: false, score: 7.3, threshold: 24 }),
  });
  h.engine.noteBotSpoke('group:100', T0 - 4000, '那我先去了');
  h.engine.noteBotSpoke('group:100', T0 - 2000, '要我顺路带点什么吗？');
  const d = await h.decide(msg({ at: T0, text: '好啊', messageId: 1 }));
  assert.equal(h.gauges.at(-1).focus, 0.5, 'M=3 时前 3 条仍靠心流续得上');
  assert.equal(d.speak, true);
});

test('专注度：focusMaxSpeaksPerWindow 可配置（=2 时她说 2 条就疲惫）', async () => {
  const h = harness({
    clock: () => T0,
    config: { focusMaxSpeaksPerWindow: 2 },
    gauge: () => ({ speak: false, score: 7.3, threshold: 24 }),
  });
  h.engine.noteBotSpoke('group:100', T0 - 4000, '要我去通知主会话吗？');
  h.engine.noteBotSpoke('group:100', T0 - 2000, '那我这就出发？');
  const d = await h.decide(msg({ at: T0, text: '好啊', messageId: 1 }));
  assert.equal(h.gauges.at(-1).focus, 0, '配上 2 就该按 2 算');
  assert.equal(d.speak, false);
});

test('专注度：拿不到正文的记账**不许瞎猜**（保持原值；默认就是 false）', async () => {
  const h = harness({ clock: () => T0 });
  const st = () => h.engine.state('group:100');
  // 1) 默认 false —— 没有"她问了话"这个前提，时间票不给（这就是恒真被拆掉的那一刀）。
  assert.equal(st().lastBotWasQuestion, false);
  // 2) 拿得到正文 ⇒ 按 `looksLikeQuestion` 判断。
  h.engine.noteBotSpoke('group:100', T0 - 6000, '需要我去通知主会话吗？');
  assert.equal(st().lastBotWasQuestion, true);
  // 3) 又一次记账但**没带正文**（`gateway.runTurn` 那条链路目前就是这样）
  //    ⇒ 不许把 true 改写成 false：拿不到证据不等于"她没问"。
  h.engine.noteBotSpoke('group:100', T0 - 2000);
  assert.equal(st().lastBotWasQuestion, true, '缺正文时保持原值，不要瞎猜');
  // 4) 迟到的旧消息（时间戳倒退）同样不许改写"她最后一条是什么"。
  h.engine.noteBotSpoke('group:100', T0 - 30_000, '嗯');
  assert.equal(st().lastBotWasQuestion, true, '迟到消息不许改写最新发言的判断');
  // 5) 她能拿到正文的下一次发言，照常覆盖。
  h.engine.noteBotSpoke('group:100', T0 - 1000, '嗯，知道了');
  assert.equal(st().lastBotWasQuestion, false, '知道内容时就该如实更新');
});

test('专注度：fromSelf 那条消息与 forceSpeak 都带得动正文', async () => {
  const h = harness({ clock: () => T0 });
  await h.decide(msg({ at: T0 - 3000, fromSelf: true, text: '需要我去通知主会话吗？', messageId: 1 }));
  assert.equal(h.engine.state('group:100').lastBotWasQuestion, true, 'fromSelf 那条路上拿得到正文');

  const h2 = harness({ clock: () => T0 });
  await h2.engine.forceSpeak({ chatId: 'group:100', kind: 'group', text: '有人要我帮忙看看吗？' });
  assert.equal(h2.engine.state('group:100').lastBotWasQuestion, true, 'forceSpeak 也有正文');
});

test('专注度：小鲸鱼很久没说话 → focus 为 0', async () => {
  const h = harness({ clock: () => T0 });
  // 小鲸鱼 10 分钟前说过话（远超 30 秒专注窗口）
  h.engine.noteBotSpoke('group:100', T0 - 10 * MINUTE);
  await h.decide(msg({ text: '在吗' }));
  const req = h.gauges[h.gauges.length - 1];
  assert.equal(req.focus, 0);
});

test('聊上了：小鲸鱼刚说完，别人 4 秒后引用回复 → 能续（3 秒间隔，不受 20/90 秒限制）', async () => {
  const h = harness({ config: { cooldownAfterBotMs: 20_000, minIntervalMs: 90_000 } });
  h.setNow(T0);
  h.engine.noteBotSpoke('group:100', T0, '要我去通知主会话吗？');
  // 别人 4 秒后引用回复小鲸鱼（focus 高：紧接 0.5 + 引用 0.5 = 1.0）
  h.setNow(T0 + 4_000);
  await h.decide(msg({ at: T0 + 4_000, messageId: 1, replyToSelf: true }));
  assert.equal(h.spoken.length, 1, '聊上了，4 秒就该续（3 秒间隔，不是 20/90 秒）');
});

test('引擎把「我说过几次」带进 gauge —— 存在感惩罚不再恒为 0（2026-10-07）', async () => {
  // 回归：小鲸鱼自己的消息**根本不进转录**（`decide()` 对 fromSelf 提前 return），
  // 所以 gauge 的 `selfRatio` 一直是 0、`penalty` 是**死代码**。
  // 现在引擎把发言时间戳（`selfAt`）带下去，让判定层数得到。
  const h = harness({ clock: () => T0 });
  h.engine.noteBotSpoke('group:100', T0 - 3_000);
  h.engine.noteBotSpoke('group:100', T0 - 2_000);
  await h.decide(msg({ at: T0, messageId: 1 }));

  const req = h.gauges.at(-1);
  assert.deepEqual(req.selfAt, [T0 - 3_000, T0 - 2_000], '两次发言都要带下去');
  assert.equal(req.botSpokeRecently, true, '2 秒前刚说过话 → 专注窗口内');
});

test('引擎把「我刚说过话」带进 gauge（短反应豁免的依据之一）', async () => {
  const h = harness({ clock: () => T0 + 10 * MINUTE });
  h.engine.noteBotSpoke('group:100', T0); // 10 分钟前，远在专注窗口之外
  await h.decide(msg({ at: T0 + 10 * MINUTE, messageId: 1 }));
  assert.equal(h.gauges.at(-1).botSpokeRecently, false, '太久以前说过 → 不算"刚说过"');
});

// ---------------------------------------------------------------- 被动通道优先（不双回）
//
// 回归：私聊消息曾经被**两个通道**同时响应 —— 被动回复回一条、主动插话又回一条。
// 用户实测「发一句话收到两条回复，会话里只有一条（另一条是 llm 措辞、不落会话）」。
// 根因是那段代码的**注释写了"@ / 私聊"，代码却只判了 mentioned**。

// ---------------------------------------------------------------- 统一判定（@ 只是加分）
//
// 旧实现把"@ 我 / 私聊"当成**切换通道**（转给被动会话），未 @ 才走引擎 ——
// 两条并行通道，实测导致同一条私聊消息被各回一次（小鲸鱼回两条）。
// 现在所有消息走同一条判定链：`@`/私聊 = "被点名"，跳过限流、必回。

test('私聊消息：被点名，必回（不再走"另一条通道"）', async () => {
  const h = harness({});
  h.setNow(T0);
  const d = await h.decide(msg({ chatId: 'private:100', kind: 'private', at: T0, messageId: 1 }));
  assert.equal(d.speak, true, '私聊必回');
  assert.equal(d.addressed, true, '私聊算被点名');
  assert.equal(d.reason, 'addressed');
  assert.equal(h.spoken.length, 1, '应触发一次回复');
});

test('群里 @ 机器人：被点名，必回', async () => {
  const h = harness({});
  h.setNow(T0);
  const d = await h.decide(msg({ at: T0, text: '@小鲸鱼 在吗', mentioned: true, messageId: 1 }));
  assert.equal(d.speak, true, '@ 必回');
  assert.equal(d.addressed, true);
  assert.equal(h.spoken.length, 1);
});

test('被点名时跳过限流：冷却期/最小间隔/安静时段都拦不住它', async () => {
  const h = harness({
    config: {
      cooldownAfterBotMs: 60_000,
      minIntervalMs: 60 * MINUTE,
    },
  });
  h.setNow(T0);
  h.engine.noteBotSpoke('group:100', T0);
  const d = await h.decide(msg({ at: T0 + 1000, text: '@小鲸鱼 在吗', mentioned: true, messageId: 1 }));
  assert.equal(d.speak, true, '明确请求不该被冷却/配额挡住');
  assert.equal(d.reason, 'addressed');
});

// ---------------------------------------------------------------- 基础放行/拦截

test('默认配置是保守的：有最小间隔和小时上限', () => {
  const cfg = defaultTriggerConfig();
  assert.equal(cfg.enabled, true);
  assert.ok(cfg.minIntervalMs >= 60_000, '最小间隔不该短于一分钟');
  assert.ok(cfg.maxPerHour <= 10, '小时上限不该太宽松');
});

test('达到消息量门槛后放行，并在放行时真正发言', async () => {
  const h = harness({ config: { afterUserMsgCount: 3 } });
  await h.decide(msg({ at: T0, messageId: 1 }));
  await h.decide(msg({ at: T0 + 1000, messageId: 2 }));
  assert.equal(h.spoken.length, 0, '还没到门槛不该说话');

  const d = await h.decide(msg({ at: T0 + 2000, messageId: 3 }));
  assert.equal(h.spoken.length, 1, '第三次人类消息后应冒泡');
  assert.equal(d.speak, true);
  assert.equal(h.spoken[0].chatId, 'group:100');
});

test('判定返回空/无文本时绝不说空话', async () => {
  const cases = [null, undefined, '', '   ', {}, { speak: false, text: '算了' }, { text: 42 }];
  for (const decision of cases) {
    const h = harness({ gauge: () => decision });
    await h.decide(msg({ messageId: 1 }));
    assert.equal(h.spoken.length, 0, `判定 ${JSON.stringify(decision)} 不该产生发言`);
  }
});

test('判定层只认 speak:true —— 措辞已改由会话生成，裸字符串不再算数', async () => {
  const h = harness({ gauge: () => '  这样也行  ' });
  const d = await h.decide(msg({ messageId: 1 }));
  assert.equal(d.speak, false, '裸字符串不算"要说话"');
  assert.equal(h.spoken.length, 0);
});

// ---------------------------------------------------------------- 准入（访问控制）

test('准入不允许时：不叫判定、不发言，且**不消耗配额**', async () => {
  // 回归：早先准入只在 speak 里判，而 noteSpeak() 在那之前就扣了配额。
  // 于是被访问控制拦下的发言会白烧掉小时配额，连续几次之后这个会话
  // 今天就再也不冒泡了——而日志只说"跳过"。
  const h = harness({
    config: { maxPerHour: 1 },
    allowed: () => false,
  });

  await h.decide(msg({ at: T0, messageId: 1 }));
  assert.equal(h.gauges.length, 0, '准入不过就不该叫判定');
  assert.equal(h.spoken.length, 0);
  assert.equal(
    h.engine.state('group:100').speaksWithin(T0, HOUR),
    0,
    '被拦下的发言不该消耗配额',
  );
});

test('准入拦截后，一旦放行仍然能正常冒泡（配额没被烧掉）', async () => {
  let permit = false;
  const h = harness({
    config: { maxPerHour: 1, minIntervalMs: 0 },
    allowed: () => permit,
    clock: () => T0,
  });

  await h.decide(msg({ at: T0, messageId: 1 }));
  await h.decide(msg({ at: T0 + 1000, messageId: 2 }));
  await h.decide(msg({ at: T0 + 2000, messageId: 3 }));
  assert.equal(h.spoken.length, 0, '一直不允许就一次都不说');
  assert.equal(h.engine.state('group:100').speaksWithin(T0 + 2000, HOUR), 0);

  permit = true;
  await h.decide(msg({ at: T0 + 3000, messageId: 4 }));
  assert.equal(h.spoken.length, 1, '放行后应立刻能冒泡（配额未被烧掉）');
});

test('准入判定抛异常时按「不允许」处理（fail-closed）', async () => {
  const h = harness({
    allowed: () => {
      throw new Error('准入服务挂了');
    },
  });
  await assert.doesNotReject(() => h.decide(msg({ messageId: 1 })));
  assert.equal(h.spoken.length, 0);
  assert.equal(h.gauges.length, 0);
  assert.ok(h.logs.some((l) => l.level === 'warn' && /准入判定失败/.test(l.message)));
});

test('未注入 allowed 时默认全部允许（保持向后兼容）', async () => {
  const h = harness({});
  await h.decide(msg({ messageId: 1 }));
  assert.equal(h.spoken.length, 1);
});

test('准入检查排在配额之前：拒绝原因应报 not-permitted 而不是 hourly-cap', async () => {
  const h = harness({
    config: { maxPerHour: 1 },
    allowed: () => false,
  });
  await h.decide(msg({ at: T0, messageId: 1 }));
  assert.ok(
    h.logs.some((l) => l.meta?.reason === 'not-permitted'),
    `应报 not-permitted，实际：${JSON.stringify(h.logs.map((l) => l.meta?.reason))}`,
  );
});

// ---------------------------------------------------------------- 频率闸门

test('机器人刚说完话后处于冷却期，不抢话', async () => {
  const h = harness({ config: { cooldownAfterBotMs: 60_000 } });
  h.setNow(T0);
  h.engine.noteBotSpoke('group:100', T0);
  // 40 秒后别人说话：超过 30 秒 focus 窗口（focus 低，走冷启动冷却），仍在 60 秒冷却内。
  h.setNow(T0 + 40_000);
  await h.decide(msg({ at: T0 + 40_000, messageId: 1 }));
  assert.equal(h.spoken.length, 0, '冷却期内不该冒泡');
  assert.ok(h.logs.some((l) => l.meta?.reason === 'cooldown-after-bot'));

  h.setNow(T0 + 61_000);
  await h.decide(msg({ at: T0 + 61_000, messageId: 2 }));
  assert.equal(h.spoken.length, 1, '冷却期过后可以冒泡');
});

test('两次主动发言之间的最小间隔被强制', async () => {
  const h = harness({ config: { minIntervalMs: 5 * MINUTE } });
  h.setNow(T0);
  await h.decide(msg({ at: T0, messageId: 1 }));
  assert.equal(h.spoken.length, 1);

  h.setNow(T0 + MINUTE);
  await h.decide(msg({ at: T0 + MINUTE, messageId: 2 }));
  assert.equal(h.spoken.length, 1, '间隔不足不该再冒泡');
  assert.ok(h.logs.some((l) => l.meta?.reason === 'min-interval'));

  h.setNow(T0 + 6 * MINUTE);
  await h.decide(msg({ at: T0 + 6 * MINUTE, messageId: 3 }));
  assert.equal(h.spoken.length, 2, '间隔够了可以再冒泡');
});

test('小时上限硬性拦住，且窗口滚动后恢复', async () => {
  const h = harness({ config: { maxPerHour: 2, minIntervalMs: 0 } });
  // 每条消息都把注入时钟推到它的时间戳：真实运行里两者本就同步，
  // 而配额记账必须走真实时钟（发言发生的时刻），不能走消息时间戳——
  // 否则补发的旧消息能拿着旧时间戳绕过限流。
  const send = (at, messageId) => {
    h.setNow(at);
    return h.decide(msg({ at, messageId }));
  };

  await send(T0, 1);
  await send(T0 + 1000, 2);
  assert.equal(h.spoken.length, 2);

  await send(T0 + 2000, 3);
  assert.equal(h.spoken.length, 2, '达到小时上限后必须安静');
  assert.ok(h.logs.some((l) => l.meta?.reason === 'hourly-cap'));

  // 滚出窗口后恢复。
  await send(T0 + HOUR + 3000, 4);
  assert.equal(h.spoken.length, 3, '窗口滚动后应恢复');
});

test('记账发生在回复成功之后（失败不会白烧配额）', async () => {
  // 重构后引擎**不再自己发言**：判定只回答"说不说"，记账由网关在**回复成功后**
  // 调 `noteReplied`。所以旧实现那套"发言失败 → 回滚配额"的机制不再需要 ——
  // 失败压根没记过账。
  const h = harness({
    config: { maxPerHour: 1, minIntervalMs: 0, cooldownAfterBotMs: 0 },
  });
  h.setNow(T0);
  await h.decide(msg({ at: T0, messageId: 1 }));
  assert.equal(h.engine.state('group:100').speaksWithin(T0, HOUR), 1, '成功后记账');

  h.engine.noteReplied('group:100', T0 + 1000, false);
  assert.equal(h.engine.state('group:100').speaksWithin(T0, HOUR), 2, '每次机会主义回复记一次');
});

test('被点名的回复不占配额，但仍刷新 lastBotAt（冷却照常生效）', async () => {
  const h = harness({
    config: { maxPerHour: 1, minIntervalMs: 0, cooldownAfterBotMs: 0 },
  });
  h.setNow(T0);
  await h.decide(msg({ at: T0, text: '@小鲸鱼 在吗', mentioned: true, messageId: 1 }));
  const st = h.engine.state('group:100');
  assert.equal(st.speaksWithin(T0, HOUR), 0, '被点名不占配额（那是别人找小鲸鱼，不是它话多）');
  assert.equal(st.lastBotAt, T0, '但仍然刷新 lastBotAt');
});

test('配额按发言的真实时刻记账，消息时间戳倒退不能绕开限流', async () => {
  const h = harness({
    config: { maxPerHour: 1, minIntervalMs: 0, cooldownAfterBotMs: 0 },
  });
  h.setNow(T0);
  await h.decide(msg({ at: T0, messageId: 1 }));
  assert.equal(h.spoken.length, 1);

  // 一条「迟到」的消息（自带两小时前的时间戳）试图绕过小时上限。
  h.logs.length = 0;
  await h.decide(msg({ at: T0 - 2 * HOUR, messageId: 2 }));
  assert.equal(h.spoken.length, 1, '按消息时间戳记账的话这里会被绕过');
  assert.ok(
    h.logs.some((l) => l.meta?.reason === 'hourly-cap'),
    `应报 hourly-cap，实际：${JSON.stringify(h.logs.map((l) => l.meta?.reason))}`,
  );
});

test('迟到消息的时间戳早于上次发言时，不会被误判成「机器人刚说完话」', async () => {
  // 回归用例：noteSpeak/noteBotMessage 曾无条件覆盖 lastBotAt，
  // 于是一条老消息会把冷却期"拉回过去"，导致它之后的所有消息全被冷却挡死，
  // 真正的拦截原因（小时上限）也被遮蔽。
  const h = harness({
    config: {
      maxPerHour: 1,
      minIntervalMs: 0,
      cooldownAfterBotMs: 60_000,
    },
  });
  h.setNow(T0);
  await h.decide(msg({ at: T0, messageId: 1 }));
  assert.equal(h.engine.state('group:100').lastBotAt, T0);

  h.logs.length = 0;
  await h.decide(msg({ at: T0 - HOUR, messageId: 2 }));
  assert.equal(
    h.engine.state('group:100').lastBotAt,
    T0,
    'lastBotAt 不该被倒退的时间戳拉回去',
  );
  assert.ok(
    h.logs.some((l) => l.meta?.reason === 'hourly-cap'),
    `真因应是 hourly-cap，而不是 cooldown，实际：${JSON.stringify(h.logs.map((l) => l.meta?.reason))}`,
  );
});

test('分钟间隔与小时上限叠加时，先判间隔再判上限，原因不会被遮蔽', async () => {
  // 回归用例：早先的实现把 minInterval 判在 hourlyCap 之前，导致
  // 「上限已满但恰好也在间隔内」时日志报的是 min-interval，运维看不出真因。
  const h = harness({ config: { maxPerHour: 2, minIntervalMs: 2 * MINUTE } });

  await h.decide(msg({ at: T0, messageId: 1 }));
  await h.decide(msg({ at: T0 + 2 * MINUTE + 1000, messageId: 2 }));
  assert.equal(h.spoken.length, 2, '间隔够，两次都应放出');
  assert.equal(h.engine.state('group:100').speaksWithin(T0 + 2 * MINUTE + 1000, HOUR), 2);

  h.logs.length = 0;
  // 第三次：间隔不够（只过了 1 秒），同时上限也已满。上限是更硬的约束。
  await h.decide(msg({ at: T0 + 2 * MINUTE + 2000, messageId: 3 }));
  assert.equal(h.spoken.length, 2);
  assert.ok(
    h.logs.some((l) => l.meta?.reason === 'hourly-cap'),
    `上限已满时应报 hourly-cap，实际日志：${JSON.stringify(h.logs.map((l) => l.meta?.reason))}`,
  );
});

// ---------------------------------------------------------------- 已删的两道闸门（2026-10-07）
//
// 回归：这两道闸门都是**用户点名要删**的。
//   - `quiet-hours`：本部署从没开过（用户是深夜活跃型），留着只会误导
//   - `burst-too-small`：它把"顺口接一句"硬挡了
//
// ⚠️ 配置键**刻意留着没删**（`qq-gugu.toml` / `cordis.patch.yml` 里还写着它们，
// 而本次改动约定不碰那两个文件）。所以这里**故意把废弃的键写进配置**，
// 钉住"写了也不生效" —— 免得将来有人看到 toml 里那几行又以为能调。

test('quiet-hours 闸门已删：凌晨三点照样走到判定', async () => {
  // UTC+8 的 03:00 → UTC 前一日 19:00，正好落在旧的 0~7 点静默时段里。
  const quietAt = Date.UTC(2026, 2, 0, 19, 0);
  const h = harness({
    config: { quietHoursStart: 0, quietHoursEnd: 7, utcOffsetMinutes: 480 },
  });
  await h.decide(msg({ at: quietAt, messageId: 1 }));
  assert.equal(h.gauges.length, 1, '凌晨也会判定（闸门已删，配置里那几个键不生效）');
  assert.ok(
    !h.logs.some((l) => l.meta?.reason === 'quiet-hours'),
    `不该再有 quiet-hours 这个拒绝理由：${JSON.stringify(h.logs.map((l) => l.meta?.reason))}`,
  );
});

test('burst-too-small 闸门已删：群里只有一条消息也会走到判定', async () => {
  // 配置里**故意**把旧门槛写足（4 条 / 5 分钟窗口）—— 它现在不该有任何作用。
  const h = harness({ config: { burstMinMessages: 4, burstWindowMs: 5 * MINUTE } });
  await h.decide(msg({ at: T0, messageId: 1 }));
  assert.equal(h.gauges.length, 1, '一条消息也放行（不再要求"话题先起来"）');
  assert.equal(h.spoken.length, 1, '判定说回就回');
  assert.ok(
    !h.logs.some((l) => String(l.meta?.reason ?? '').startsWith('burst-too-small')),
    `不该再有 burst-too-small 这个拒绝理由：${JSON.stringify(h.logs.map((l) => l.meta?.reason))}`,
  );
});

// ---------------------------------------------------------------- 被动/自身/去重

test('@ 机器人的消息：进转录，且判定为必回（不再"不抢"）', async () => {
  const h = harness({ config: { afterUserMsgCount: 99 } });
  const d = await h.decide(msg({ at: T0, mentioned: true, messageId: 1 }));
  assert.equal(d.speak, true, '@ 走同一条判定链，且被点名必回');
  assert.equal(d.addressed, true);
  assert.equal(h.engine.transcript('group:100').snapshot().length, 1, '仍应进转录');
  assert.equal(h.spoken.length, 1);
});

test('机器人自己的消息不进转录，只刷新冷却时间', async () => {
  const h = harness({ config: { cooldownAfterBotMs: 60_000 } });
  h.setNow(T0);
  await h.decide(msg({ at: T0, fromSelf: true, text: '我自己说的', messageId: 1 }));
  assert.equal(h.engine.transcript('group:100').snapshot().length, 0, '自己的话不该进上下文');

  // 40 秒后别人说话（focus 低，冷启动冷却 60 秒仍生效）
  h.setNow(T0 + 40_000);
  await h.decide(msg({ at: T0 + 40_000, messageId: 2 }));
  assert.equal(h.spoken.length, 0, '自己刚说完，冷却期内不该冒泡');
});

test('同一个 messageId 重复投递只算一次（重连补发场景）', async () => {
  const h = harness({ config: { maxPerHour: 10, minIntervalMs: 0 } });
  await h.decide(msg({ at: T0, messageId: 777 }));
  await h.decide(msg({ at: T0 + 1, messageId: 777 }));
  await h.decide(msg({ at: T0 + 2, messageId: 777 }));
  assert.equal(h.engine.transcript('group:100').snapshot().length, 1);
  assert.equal(h.spoken.length, 1, '重复投递不该放大成多次冒泡');
});

test('缺失 messageId 的消息不被去重（不能靠猜）', async () => {
  const h = harness({ config: { maxPerHour: 10, minIntervalMs: 0 } });
  await h.decide(msg({ at: T0 }));
  await h.decide(msg({ at: T0 + 1 }));
  assert.equal(h.engine.transcript('group:100').snapshot().length, 2);
});

test('多个会话之间互不干扰：状态与配额都是独立的', async () => {
  const h = harness({ config: { minIntervalMs: 5 * MINUTE } });
  await h.decide(msg({ chatId: 'group:100', at: T0, messageId: 1 }));
  await h.decide(msg({ chatId: 'group:200', at: T0 + 1, messageId: 2 }));
  assert.equal(h.spoken.length, 2, '两个群各自的第一条都应触发');

  await h.decide(msg({ chatId: 'group:100', at: T0 + 2, messageId: 3 }));
  assert.equal(h.spoken.length, 2, 'A 群的间隔限制不该被 B 群的发言影响（反之亦然）');
});

// ---------------------------------------------------------------- 并发与容错

test('同一会话判定在进行中时不叠加第二次判定', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    gauge: async () => {
      await gate;
      return { speak: true, text: '我来' };
    },
    config: { maxPerHour: 10 },
  });

  const first = h.decide(msg({ at: T0, messageId: 1 }));
  const second = h.decide(msg({ at: T0 + 1, messageId: 2 }));
  // 让两个判定都走到 gauge（第二个会排队等第一个，所以这里不能 await 它们）。
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.gauges.length, 1, '同一会话的判定排队，不并发重入');

  release();
  await first;
  await second;
  // 排队而非跳过：两条消息最终**都**得到判定（旧实现会静默丢掉第二条）。
  assert.equal(h.spoken.length, 2, '排队的第二条不该被丢弃');
});

test('判定抛异常不会炸掉链路，也不会产生发言', async () => {
  const h = harness({
    gauge: () => {
      throw new Error('模型挂了');
    },
  });
  await assert.doesNotReject(() => h.decide(msg({ messageId: 1 })));
  assert.equal(h.spoken.length, 0);
  assert.ok(h.logs.some((l) => l.level === 'warn' && l.meta?.error?.includes('模型挂了')));
});

test('记账真的会占用间隔额度（刚回过就不该立刻再冒泡）', async () => {
  // 重构后"发言"不在引擎里，"失败是否占用额度"这个问题也随之消失 ——
  // 记账只发生在网关**回复成功之后**。这里守的是记账本身的效力。
  const h = harness({ config: { minIntervalMs: 10 * MINUTE } });
  await h.decide(msg({ at: T0, messageId: 1 }));
  assert.equal(h.engine.state('group:100').lastSpeakAt, T0, '记账应刷新 lastSpeakAt');
  assert.equal(h.spoken.length, 1);

  await h.decide(msg({ at: T0 + 1000, messageId: 2 }));
  assert.equal(h.spoken.length, 1, '间隔额度内不该再冒泡');
});

test('stop() 之后只记录不判定', async () => {
  const h = harness({});
  h.engine.stop();
  await h.decide(msg({ at: T0, messageId: 1 }));
  assert.equal(h.gauges.length, 0);
  assert.equal(h.engine.transcript('group:100').snapshot().length, 1, '转录仍继续（被动通道要用）');
});

test('enabled=false 时完全不主动，但转录照常', async () => {
  const h = harness({ config: { enabled: false } });
  await h.decide(msg({ at: T0, messageId: 1 }));
  assert.equal(h.gauges.length, 0);
  assert.equal(h.engine.transcript('group:100').snapshot().length, 1);
});

// ---------------------------------------------------------------- forceSpeak

test('forceSpeak 绕过闸门但计入配额（工作汇报/定时播报用）', async () => {
  // enabled=false 时主动发言整条关掉，forceSpeak 照样得能发出去。
  const h = harness({ config: { enabled: false } });
  const ok = await h.engine.forceSpeak({ chatId: 'group:100', kind: 'group', text: '任务完成了' });
  assert.equal(ok, true);
  assert.equal(h.spoken.length, 1);
  assert.equal(h.spoken[0].trigger, 'forced');
  assert.equal(h.engine.state('group:100').speaksWithin(T0, HOUR), 1, '强制发言也要占配额');
});

test('forceSpeak 拒绝空文本', async () => {
  const h = harness({});
  assert.equal(await h.engine.forceSpeak({ chatId: 'group:100', kind: 'group', text: '   ' }), false);
  assert.equal(await h.engine.forceSpeak({ chatId: 'group:100', kind: 'group', text: '' }), false);
  assert.equal(h.spoken.length, 0);
});

test('forceSpeak 之后紧邻的机会主义冒泡会被间隔挡住（汇报完不再补一句）', async () => {
  const h = harness({ config: { minIntervalMs: 2 * MINUTE, burstMinMessages: 1, maxPerHour: 10 } });
  await h.engine.forceSpeak({ chatId: 'group:100', kind: 'group', text: '这一段干完了' });
  await h.decide(msg({ at: T0 + 1000, messageId: 1 }));
  assert.equal(h.spoken.length, 1, '刚汇报完不该马上再冒泡');
});

// ---------------------------------------------------------------- Transcript

test('Transcript 按条数封顶', () => {
  // ⚠️ 2026-10-13：`maxAgeMs` 这个选项**已经删掉了**（见下面那条用例）。
  // 传它进来没有任何作用 —— 这个构造参数原样留着只会让人以为时间窗还在。
  const t = new Transcript({ maxMessages: 3 });
  for (let i = 0; i < 10; i++) t.push(msg({ at: T0 + i, messageId: i, text: `第${i}条` }));
  const snap = t.snapshot();
  assert.equal(snap.length, 3);
  assert.deepEqual(
    snap.map((m) => m.text),
    ['第7条', '第8条', '第9条'],
  );
});

// ⚠️ 这条用例**改过**（2026-10-13）：原来叫「Transcript 按时间裁剪」，
// 断言"超过 maxAgeMs 的条目被丢掉"。
//
// 为什么改：用户 2026-10-13 的要求是「**只要进 llm 了就塞 20 条前文，
// 不管是多久的**」，而 30 分钟的时间窗**正是**"只渲染出 2 条"的根因
// （群里安静 31 分钟 ⇒ 窗口清空 ⇒ `render(20)` 只剩 1~2 条）。
// 所以时间窗被**故意删掉**，这条用例反过来钉住新行为：
// **过了多久都不许丢**，只有条数封顶。
test('Transcript 不再按时间裁剪（"不管多久都带 20 条前文"，2026-10-13）', () => {
  const t = new Transcript({ maxMessages: 100 });
  t.push(msg({ at: T0, text: '很久以前' }));
  t.push(msg({ at: T0 + 11 * MINUTE, text: '刚刚' }));
  assert.deepEqual(
    t.snapshot().map((m) => m.text),
    ['很久以前', '刚刚'],
    '过了 11 分钟（旧时间窗是 10 分钟）也不许丢 —— 否则提示词里的"最近 20 条"会缩水',
  );

  // 极端情形：隔了一整天，`render(20)` 仍然拿得到 20 条。
  const long = new Transcript();
  for (let i = 0; i < 25; i++) {
    long.push(msg({ at: T0 + i * 6 * HOUR, messageId: i, text: `第${i}条` }));
  }
  assert.equal(long.render(20).split('\n').length, 20, '60 条上限内，20 条前文必须给满');
  assert.match(long.render(20), /第5条/, '最早那条（6 小时一条 ⇒ 隔了 5 天）仍在窗口里');
});

test('Transcript 丢弃时间倒退的乱序消息', () => {
  const t = new Transcript();
  assert.equal(t.push(msg({ at: T0 + 1000 })), true);
  assert.equal(t.push(msg({ at: T0 })), false, '迟到消息不该插到前面污染顺序');
  assert.equal(t.snapshot().length, 1);
});

test('Transcript.render 输出带时钟和昵称的紧凑文本，且只取最近 N 条', () => {
  const t = new Transcript();
  for (let i = 0; i < 5; i++) {
    t.push(msg({ at: T0 + i * 60_000, nickname: `人${i}`, userId: `${i}`, text: `话${i}` }));
  }
  const rendered = t.render(2);
  const lines = rendered.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /人3\(3\): 话3$/);
  // ⚠️ 2026-10-13 改过：行首现在**不是当天就带日期**（`T0` 是 2026-03-01，
  // 早就不止一天 ⇒ 实际渲染成 `[03-01 20:00]`）。这条用例本来只想钉
  // "带行首时间戳"，所以改成同时接受两种形态（只带日期的分支另有专门用例）。
  assert.match(lines[0], /^\[(?:\d{2}-\d{2} )?\d{2}:\d{2}\]/);
});

test('Transcript.clear 清空内容', () => {
  const t = new Transcript();
  t.push(msg());
  t.clear();
  assert.equal(t.snapshot().length, 0);
});

// ------------------------------------------------- 图片描述注入（2026-10-13）

test('★ `render(limit, imageText)`：转录里的 `[图片]` 被换成描述', () => {
  const t = new Transcript();
  t.push(msg({ at: T0, nickname: '甲', userId: '1', text: '[图片]' }));
  t.push(msg({ at: T0 + 1000, nickname: '乙', userId: '2', text: '这是啥' }));
  const rendered = t.render(20, (m) => (m.text === '[图片]' ? ['一只橘猫'] : null));
  const lines = rendered.split('\n');
  assert.match(lines[0], /甲\(1\): \[图片: 一只橘猫\]/, `第一条该带描述，实际：${rendered}`);
  assert.match(lines[1], /乙\(2\): 这是啥/, '没有图的那条一个字不动');
});

test('★ `renderExcept` 也带描述通道（被点名那一路的转录）', () => {
  const t = new Transcript();
  const image = msg({ at: T0, nickname: '甲', userId: '1', text: '[图片]' });
  const current = msg({ at: T0 + 1000, nickname: '乙', userId: '2', text: '在吗' });
  t.push(image);
  t.push(current);
  const rendered = t.renderExcept(current, 20, (m) => (m === image ? ['两只猫'] : null));
  assert.doesNotMatch(rendered, /在吗/, '触发那条要被剔掉（既有行为）');
  assert.match(rendered, /\[图片: 两只猫\]/);
});

test('`replaceImagePlaceholders`：空描述 / 下标越界 / 已带描述 都有明确行为', () => {
  assert.equal(replaceImagePlaceholders('[图片][图片]', ['甲', '']), '[图片: 甲][图片]',
    '第二张没描述 ⇒ 原样保留占位符（宁可不写，也不编）');
  assert.equal(replaceImagePlaceholders('[图片][图片][图片]', ['甲']), '[图片: 甲][图片][图片]',
    '描述比占位符少 ⇒ 多出来的保持原样');
  assert.equal(replaceImagePlaceholders('[图片]', []), '[图片]', '没有描述表 ⇒ 一个字不动');
  assert.equal(replaceImagePlaceholders('[图片]', null), '[图片]');
  // ⚠️ 这条最要紧：**已经带描述的行不许被二次替换** ——
  // 否则转录里那些先前已注入的行会变成 `[图片: [图片: …]]`。
  assert.equal(replaceImagePlaceholders('[图片: 甲]', ['乙']), '[图片: 甲]');
  // 富段那种带元信息的形态也要认（`rich.mjs` 的 `imageLine`）。
  assert.equal(replaceImagePlaceholders('[图片1 745KB]', ['甲']), '[图片: 甲]');
  assert.equal(replaceImagePlaceholders('看这个[图片]是吗', ['甲']), '看这个[图片: 甲]是吗');
});

// ---------------------------------------------------------------- ChatState

test('ChatState.speaksWithin 滚动裁剪历史发言时间戳', () => {
  const s = new ChatState();
  s.noteSpeak(T0);
  s.noteSpeak(T0 + 10 * MINUTE);
  assert.equal(s.speaksWithin(T0 + 11 * MINUTE, HOUR), 2);
  assert.equal(s.speaksWithin(T0 + 2 * HOUR, HOUR), 0, '两小时后窗口内应为空');
  assert.equal(s.speaks.length, 0, '裁剪应真的移除元素，避免无界增长');
});

test('ChatState.botAt：记发言时间戳、有上界、两种数法都对', () => {
  const s = new ChatState();
  s.noteBotMessage(T0);
  s.noteBotMessage(T0 + 1000);
  assert.deepEqual(s.botAt, [T0, T0 + 1000], '按发生顺序记下来');
  assert.equal(s.lastBotAt, T0 + 1000, 'lastBotAt 仍然是最近一次（冷却读它）');
  assert.equal(s.botMessagesWithin(T0 + 1000, 500), 1, '只数窗口内的');
  assert.equal(s.botMessagesWithin(T0 + 1000, 5000), 2);

  // 上界：长跑不能无限增长（不然一个活跃群跑几天就是几万个数）。
  for (let i = 0; i < 500; i += 1) s.noteBotMessage(T0 + 2000 + i);
  assert.ok(s.botAt.length < 500, `必须有上界，实际 ${s.botAt.length}`);
  assert.ok(s.botAt.length >= 20, `至少要覆盖判定窗口，实际 ${s.botAt.length}`);
  assert.equal(s.lastBotAt, T0 + 2000 + 499, '裁剪不能让 lastBotAt 变小');
});

test('ChatState.noteBotMessage：时间戳倒退不能把 lastBotAt 拉回去', () => {
  // 与 noteSpeak 同一条规矩：迟到消息（时间戳更早）不该让冷却期"回到过去"。
  const s = new ChatState();
  s.noteBotMessage(T0);
  s.noteBotMessage(T0 - HOUR);
  assert.equal(s.lastBotAt, T0, 'lastBotAt 取最大值');
  assert.equal(s.botAt.length, 2, '但两次发言都要留在历史里（判定层要数次数）');
});

test('ChatState.snapshot/rollback 也要管住 botAt（回滚不能漏掉发言历史）', () => {
  const s = new ChatState();
  s.noteBotMessage(T0);
  const snap = s.snapshot();
  s.noteBotMessage(T0 + 1000);
  s.rollback(snap);
  assert.deepEqual(s.botAt, [T0], '回滚后发言历史应回到快照那一刻');
  assert.equal(s.lastBotAt, T0);
});

// ---------------------------------------------------------------- 工具函数

test('normalizeDecision 的边界', () => {
  assert.equal(normalizeDecision(null), null);
  assert.equal(normalizeDecision(undefined), null);
  assert.equal(normalizeDecision(''), null);
  assert.equal(normalizeDecision('  \n '), null);
  assert.equal(normalizeDecision('hi'), 'hi');
  assert.equal(normalizeDecision({ text: 'hi' }), 'hi');
  assert.equal(normalizeDecision({ speak: false, text: 'hi' }), null);
  assert.equal(normalizeDecision({ text: '' }), null);
  assert.equal(normalizeDecision(123), null);
  assert.equal(normalizeDecision([]), null);
});

test('formatClock 受时区偏移影响', () => {
  const at = Date.UTC(2026, 2, 1, 12, 0);
  assert.equal(formatClock(at, 0), '12:00');
  assert.equal(formatClock(at, 480), '20:00');
  assert.equal(formatClock(at, -300), '07:00');
});

// ------------------------------------------------- 行首时间戳带日期（2026-10-13）
//
// 用户拍板选了"加日期"这一版（**只加日期，不加时间窗**，原话「多这几条多不了多少 token」）。
// 起因：灌历史之后转录里全是几天前的消息，而提示词第一句写着「群里刚在聊」——
// 那个"刚"是假的，而旧渲染只有 `[HH:MM]`，模型没有别的线索能识破。
//
// 真实跨度（`_qq-judge/_transcript-date-probe.txt`）：测试群 30000012
// `10-03 16:44` → `10-07 23:52`，即 **5.6 天前**。

test('formatStamp：当天只给 HH:MM（和加日期之前一模一样，不加噪音）', () => {
  // 都用 UTC+8 的墙上时间构造，免得"本地时区"混进来。
  const now = Date.UTC(2026, 9, 13, 5, 50); // 10-13 13:50 (+08)
  assert.equal(formatStamp(now, { now }), '13:50', '同一毫秒 ⇒ 当天');
  assert.equal(formatStamp(Date.UTC(2026, 9, 12, 16, 0), { now }), '00:00',
    'UTC 10-12 16:00 = 本地 10-13 00:00 ⇒ 还是当天（只是钟点跨了 UTC 日界）');
  assert.equal(formatStamp(Date.UTC(2026, 9, 13, 15, 59), { now }), '23:59', '本地 10-13 当天最后一分钟');
});

test('formatStamp：不是当天给 MM-DD HH:MM', () => {
  const now = Date.UTC(2026, 9, 13, 5, 50); // 10-13 13:50 (+08)
  // 本地 10-12 23:59 —— 只差一分钟，但**已经跨了本地日历日** ⇒ 必须带日期。
  // 这条钉的就是"按日历日、不按 24 小时差"（按差值算的话它会漏掉日期）。
  assert.equal(formatStamp(Date.UTC(2026, 9, 12, 15, 59), { now }), '10-12 23:59');
  // 任务给的真实数据：测试群那 20 条的头一条（本地 10-03 16:44）。
  assert.equal(formatStamp(Date.UTC(2026, 9, 3, 8, 44), { now }), '10-03 16:44');
  // 最后一条（本地 10-07 23:52）—— 这就是那个"5.6 天前"。
  assert.equal(formatStamp(Date.UTC(2026, 9, 7, 15, 52), { now }), '10-07 23:52');
  // 未来一点也算"不是当天"（时钟回拨/乱序时不至于渲染成裸 HH:MM 骗人）。
  assert.equal(formatStamp(Date.UTC(2026, 9, 14, 0, 0), { now }), '10-14 08:00');
});

test('formatStamp：跨年才补年份 YYYY-MM-DD HH:MM', () => {
  const now = Date.UTC(2026, 0, 1, 4, 0); // 本地 2026-01-01 12:00
  assert.equal(formatStamp(Date.UTC(2025, 11, 31, 15, 50), { now }), '2025-12-31 23:50',
    '去年最后一天 ⇒ 必须带年份（只写 12-31 会被读成"今年 12 月"，反而错）');
  assert.equal(formatStamp(Date.UTC(2025, 11, 31, 16, 0), { now }), '00:00',
    '本地 2026-01-01 00:00 ⇒ 和"现在"同一天 ⇒ 裸时钟（跨年边界要按【本地日】判，不是 UTC 日）');
  assert.equal(formatStamp(Date.UTC(2024, 5, 1, 4, 0), { now }), '2024-06-01 12:00', '前年');
  assert.equal(formatStamp(Date.UTC(2026, 0, 1, 4, 0), { now: Date.UTC(2026, 0, 2, 4, 0) }), '01-01 12:00',
    '同一年、但不是当天 ⇒ 只补月日，【不】补年份（省 token）');
});

test('formatStamp：边界 —— 时间戳缺失 / 非法「现在」/ 时区可注入', () => {
  const now = Date.UTC(2026, 9, 13, 5, 50);
  assert.equal(formatStamp(0, { now }), '1970-01-01 08:00', '`at=0` 不炸：走带日期分支（年月日由 at 自己算）');
  assert.equal(formatStamp(NaN, { now }), 'NaN:NaN', '非有限数：退回最保守形态，不抛异常');
  assert.equal(formatStamp(undefined, { now }), 'NaN:NaN');
  // "现在"非法 ⇒ 判不了"当天" ⇒ 退回裸时钟（宁可少写日期，也不写错日期）。
  assert.equal(formatStamp(Date.UTC(2026, 9, 3, 8, 44), { now: NaN }), '16:44');
  // ⚠️ 时区可注入：同一个瞬间在 UTC 是 10-12 23:59、不是 UTC+8 的"当天"。
  assert.equal(formatStamp(Date.UTC(2026, 9, 12, 15, 59), { now, utcOffsetMinutes: 0 }), '10-12 15:59');
  assert.equal(formatStamp(Date.UTC(2026, 9, 13, 5, 50), { now, utcOffsetMinutes: 0 }), '05:50');
});

test('★ 转录渲染：跨天的消息带日期，当天的消息不带（时间可注入）', () => {
  const t = new Transcript();
  t.push(msg({ at: Date.UTC(2026, 9, 3, 8, 44), nickname: '用户', userId: '30000001', text: '转主会话' }));
  t.push(msg({ at: Date.UTC(2026, 9, 7, 15, 52), nickname: '小鲸鱼', userId: '30000002', text: '讲完了' }));
  t.push(msg({ at: Date.UTC(2026, 9, 13, 5, 50), nickname: '我', userId: '1', text: '在吗' }));
  const now = Date.UTC(2026, 9, 13, 5, 50);
  const lines = t.render(20, null, { now }).split('\n');
  assert.match(lines[0], /^\[10-03 16:44\] 用户\(30000001\): 转主会话$/);
  assert.match(lines[1], /^\[10-07 23:52\] 小鲸鱼\(30000002\): 讲完了$/);
  assert.equal(lines[2], '[13:50] 我(1): 在吗', '当天的还是裸 HH:MM —— 旧行为一个字没变');
});

test('★ `renderExcept` 同样带日期（被点名那一路的转录）', () => {
  const t = new Transcript();
  const old = msg({ at: Date.UTC(2026, 9, 3, 8, 44), nickname: '甲', userId: '1', text: '几天前的话' });
  const current = msg({ at: Date.UTC(2026, 9, 13, 5, 50), nickname: '乙', userId: '2', text: '在吗' });
  t.push(old);
  t.push(current);
  const rendered = t.renderExcept(current, 20, null, { now: Date.UTC(2026, 9, 13, 5, 50) });
  assert.match(rendered, /^\[10-03 16:44\] 甲\(1\): 几天前的话$/);
  assert.doesNotMatch(rendered, /在吗/, '触发那条仍要被剔掉');
});

test('★ 加日期不影响图片描述注入（两条通道叠在一起）', () => {
  const t = new Transcript();
  t.push(msg({ at: Date.UTC(2026, 9, 3, 8, 44), nickname: '甲', userId: '1', text: '[图片]' }));
  t.push(msg({ at: Date.UTC(2026, 9, 13, 5, 50), nickname: '乙', userId: '2', text: '[图片]这是啥' }));
  const rendered = t.render(20, (m) => (m.text === '[图片]' ? ['一只橘猫'] : ['两只猫']), {
    now: Date.UTC(2026, 9, 13, 5, 50),
  });
  const lines = rendered.split('\n');
  assert.equal(lines[0], '[10-03 16:44] 甲(1): [图片: 一只橘猫]', '跨天 + 描述，两个都得在');
  assert.equal(lines[1], '[13:50] 乙(2): [图片: 两只猫]这是啥', '当天裸时钟 + 描述');
});

test('describeError 对非 Error 也不炸', async () => {
  const h = harness({
    gauge: () => {
      throw 'string-failure'; // eslint-disable-line no-throw-literal
    },
  });
  await assert.doesNotReject(() => h.decide(msg({ messageId: 1 })));
  assert.ok(h.logs.some((l) => l.meta?.error === 'string-failure'));
});

// ---------------------------------------------------------------- 判定日记
//
// 日记存在的唯一理由：计数（gauges）回答不了「为什么没冒泡」。
// 闸门挡的、打分不够、发言失败，三者都是"计数涨了、消息没出去"，
// 所以每条路径都必须留下可区分的原因。

test('journal：闸门拦下时记下原因', async () => {
  const h = harness({ config: { afterUserMsgCount: 3 } });
  await h.decide(msg({ at: T0 }));
  await h.decide(msg({ at: T0 + 1000 }));

  assert.equal(h.engine.journal.length, 2);
  const last = h.engine.journal.at(-1);
  assert.equal(last.event, 'skip');
  assert.equal(last.reason, 'warming-up(2/3)');
  assert.equal(last.chatId, 'group:100');
  assert.equal(last.at, T0 + 1000);
});

test('journal：@ 我的消息记成"被点名"（addressed），且仍然走判定链', async () => {
  const h = harness();
  await h.decide(msg({ mentioned: true }));
  const entry = h.engine.journal.at(-1);
  assert.equal(entry.event, 'gauge');
  assert.equal(entry.addressed, true);
  assert.equal(h.gauges.length, 1, '统一判定：@ 也要打分（结果虽必回）');
});

test('journal：判定器说"不说"时，分数与打分明细一并留档', async () => {
  const h = harness({
    gauge: () => ({
      score: 12.5,
      threshold: 26,
      detail: { relevance: 0, content: 12, pressure: 4.66, nested: { deep: 1 }, note: 'x!' },
    }),
  });
  await h.decide(msg());

  const entry = h.engine.journal.at(-1);
  assert.equal(entry.event, 'gauge');
  assert.equal(entry.speak, false, '没有文本就是不说');
  assert.equal(entry.score, 12.5);
  assert.equal(entry.threshold, 26);
  assert.equal(entry.d_content, 12, '明细摊平成 d_ 前缀的标量');
  assert.equal(entry.d_pressure, 4.66);
  assert.equal(entry.d_nested, undefined, '嵌套对象不落盘');
  assert.equal(entry.d_note, undefined, '字符串不是分数，不落盘');
  assert.equal(h.spoken.length, 0);
});

test('journal：判定为"回"时记一条 gauge（含 speak:true）', async () => {
  const h = harness();
  await h.decide(msg());
  const entry = h.engine.journal.at(-1);
  assert.equal(entry.event, 'gauge');
  assert.equal(entry.speak, true);
  // 说话本身由会话完成，所以日记里不再有单独的 `speak` 事件。
  const events = h.engine.journal.map((e) => e.event);
  assert.ok(!events.includes('speak'), `不该再有 speak 事件：${JSON.stringify(events)}`);
});

test('journal：判定器抛错时记下 phase=gauge', async () => {
  const h = harness({
    gauge: () => {
      throw new Error('gauge exploded');
    },
  });
  await h.decide(msg());
  const entry = h.engine.journal.at(-1);
  assert.equal(entry.event, 'error');
  assert.equal(entry.phase, 'gauge');
});

test('journal：有上界，长跑不会无限增长', async () => {
  const h = harness({
    config: {
      minIntervalMs: 0,
      cooldownAfterBotMs: 0,
      afterUserMsgCount: 1,
      // 放开小时上限，否则跑到第 4 条就被 hourly-cap 挡住，测的就不是"日记有没有上界"了。
      maxPerHour: 100,
    },
  });
  for (let i = 0; i < 30; i += 1) await h.decide(msg({ at: T0 + i * 1000 }));

  assert.equal(h.engine.journal.length, h.engine.journalLimit);
  assert.ok(h.engine.journal.length <= 30);
  // 丢掉的是最早的：末尾一条必须是最后一次判定。
  assert.equal(h.engine.journal.at(-1).event, 'gauge');
});

test('journal：forceSpeak 也留痕（工作汇报/定时播报同一条流水）', async () => {
  const h = harness();
  await h.engine.forceSpeak({ chatId: 'private:2001', kind: 'private', text: '汇报一下', trigger: 'report' });
  const entry = h.engine.journal.at(-1);
  assert.equal(entry.event, 'speak');
  assert.equal(entry.trigger, 'report');
  assert.equal(entry.chars, 4);

  await h.engine.forceSpeak({ chatId: 'private:2001', kind: 'private', text: '   ' });
  assert.equal(h.engine.journal.at(-1).trigger, 'report', '空文本不该留新痕');
});

test('flattenDetail：只收有限数字与布尔，前缀 d_', () => {
  assert.deepEqual(flattenDetail(null), {});
  assert.deepEqual(flattenDetail('x'), {});
  assert.deepEqual(flattenDetail({ a: 1, b: true, c: NaN, d: Infinity, e: 'x', f: {} }), {
    d_a: 1,
    d_b: true,
  });
});

// ---------------------------------------------------------------- 攒劲儿（2026-10-14）
//
// 治的是"结构性反馈锁"：`presence` 只有她自己刚说过话时才非零
// ⇒ 她必须是"已经在说话"才可能说话。攒劲儿是唯一只看"时间在推进"的正项。
// 详细设计见 `defaultTriggerConfig().decline_bonus` 与 `_qq-judge/DECLINE-BONUS.md`。

/** 攒劲儿用例的公共桩：判定器永远说"不说"（分数固定），间隔闸门全放开。 */
function declineHarness(options = {}) {
  return harness({
    config: {
      minIntervalMs: 0,
      cooldownAfterBotMs: 0,
      afterUserMsgCount: 1,
      maxPerHour: 100,
      ...(options.config ?? {}),
    },
    gauge: options.gauge ?? (() => ({ speak: false, score: 20, threshold: 50 })),
  });
}

test('★ 攒劲儿：判定了但没说 ⇒ 计数 +1（限流内），加分 = 计数 × step', async () => {
  const h = declineHarness();
  await h.decide(msg({ at: T0 }));
  assert.equal(h.engine.state('group:100').declineCount, 1);
  assert.equal(h.engine.declineBonus('group:100'), 6, 'step 默认 6');

  // 距上次计数只有 5 秒 < 30 秒 ⇒ **不计数**（防刷屏刷爆）
  await h.decide(msg({ at: T0 + 5_000 }));
  assert.equal(h.engine.state('group:100').declineCount, 1, '限流内不该 +1');
  assert.equal(h.engine.declineBonus('group:100'), 6, '加分不该涨');

  // 满 30 秒 ⇒ +1
  await h.decide(msg({ at: T0 + 30_000 }));
  assert.equal(h.engine.state('group:100').declineCount, 2);
  assert.equal(h.engine.declineBonus('group:100'), 12);
});

test('★ 攒劲儿：封顶生效（cap）—— 攒够之后不再涨', () => {
  // 直接驱动 `noteDecline`：走完整判定的话，加到阈值那一条她会开口、
  // 计数归零（那是**对的**行为，见下面"死锁被打破"那条），就测不到封顶了。
  const h = declineHarness({ config: { decline_bonus: 6, decline_bonus_cap: 60, decline_bonus_min_gap_ms: 0 } });
  for (let i = 0; i < 20; i += 1) {
    assert.equal(h.engine.noteDecline('group:100', T0 + i * 1_000), true, 'gap=0 ⇒ 每次都该计数');
  }
  assert.equal(h.engine.state('group:100').declineCount, 20);
  assert.equal(h.engine.declineBonus('group:100'), 60, 'cap=60 封住（20×6=120）');
  // 再攒也不涨。
  h.engine.noteDecline('group:100', T0 + 21_000);
  assert.equal(h.engine.declineBonus('group:100'), 60);
});

test('🔴 攒劲儿：死锁真的被打破 —— 分不够的消息攒到 cap 之后她开口了', async () => {
  // 场景：一条"分数很低"的真实闲聊（**只用 `request.declineBonus` 抬分**，基准 20 分，
  // 阈值 50）。按现状她**永远不会说话**（presence 恒 0 ⇒ 上界 < 50）；
  // 攒劲儿攒够就必然过线。
  //
  // ⚠️ 这里刻意让桩**只**用引擎带进来的 `request.declineBonus`（不漏算、不重复算）——
  // 与生产里 `heuristic-gauge.score()` 的口径一致（它在 `raw` 上加这一项）。
  const seenAhead = [];
  const h = declineHarness({
    config: { decline_bonus: 6, decline_bonus_cap: 60, decline_bonus_min_gap_ms: 0 },
    gauge: (request) => {
      // 记录"引擎这一条带进来的加分"（= 上一条累积的结果）
      seenAhead.push(request.declineBonus ?? 0);
      const total = 20 + (request.declineBonus ?? 0);
      return { speak: total >= 50, score: total, threshold: 50 };
    },
  });
  const trace = [];
  for (let i = 0; i < 8; i += 1) {
    const d = await h.decide(msg({ at: T0 + i * 1_000 }));
    trace.push({
      n: i + 1,
      bonus: seenAhead.at(-1),
      score: d.score,
      threshold: d.threshold,
      speak: d.speak,
      reason: d.reason,
      count: h.engine.state('group:100').declineCount,
    });
  }
  // 前 4 条（加分 0/6/12/18 ⇒ 20/26/32/38）都不够；
  // 第 5 条加 24 ⇒ 44；第 6 条加 30 ⇒ **50 ⇒ 过线**。
  assert.deepEqual(
    trace.map((t) => t.speak),
    [false, false, false, false, false, true, false, false],
    `开口时机不对：${JSON.stringify(trace)}`,
  );
  assert.equal(trace[5].score, 50, `第 6 条该是 20+30=50：${JSON.stringify(trace[5])}`);
  assert.equal(trace[5].reason, 'scored');
  // 她开口之后计数归零（`noteReplied` 走 `noteBotMessage`）⇒ 从头再攒。
  assert.equal(trace[5].count, 0, '说过话之后计数必须归零');
  assert.equal(trace[6].bonus, 0, '归零之后下一条不带旧加分');
});

test('🔴 攒劲儿：她【被动回复】也归零（`noteReplied` 那条路不能漏）', async () => {
  const h = declineHarness({ config: { decline_bonus_min_gap_ms: 0 } });
  await h.decide(msg({ at: T0 }));
  await h.decide(msg({ at: T0 + 1_000 }));
  assert.equal(h.engine.state('group:100').declineCount, 2, '先攒两次');

  // 网关收到一条 @ 她的消息 → `addressed` 直通 → 判定说回 → 网关调 noteReplied。
  // 这里直接模拟网关那一步（`addressed = true` 走 noteBotMessage）。
  h.engine.noteReplied('group:100', T0 + 2_000, true, '在呢');
  assert.equal(h.engine.state('group:100').declineCount, 0, '被动回复也必须归零');
  assert.equal(h.engine.declineBonus('group:100'), 0);

  // 主动发言（noteSpeak）同样归零。
  //
  // ⚠️ 2026-10-15：这里**必须显式 `setNow()` 跳过专注窗口**。两个坑叠在一起：
  //   ① 上面那次 `noteReplied(..., addressed=true)` 现在会开一个专注窗口（**票C**，
  //      见 `engine.mjs` 的 `lastAddressedReplyAt`）⇒ 紧接着这一步会被 focus 通道放行；
  //   ② 而 **harness 的时钟不跟随 `msg.at`**（`now` 是 harness 自己的变量，
  //      `engine.now()` 一直返回它）⇒ **光把 `msg.at` 往后挪没有用**，
  //      必须 `h.setNow(...)` 才真的"过了 30 秒"。
  // 不放行的话：`decide` 里 focus 放行 ⇒ `speak=true` ⇒ harness 包装会记账
  // （`noteReplied(addressed=false)` ⇒ `noteSpeak`）⇒ 攒劲儿归零 ⇒ 下面 `=== 1` 不成立。
  // 本用例要测的是"主动发言也归零"，不是票C，所以先跳出窗口。
  h.setNow(T0 + 40_000);
  await h.decide(msg({ at: T0 + 40_000 }));
  assert.equal(h.engine.state('group:100').declineCount, 1);
  h.setNow(T0 + 41_000);
  h.engine.noteReplied('group:100', T0 + 41_000, false, '这个我看看');
  assert.equal(h.engine.state('group:100').declineCount, 0, '主动发言同样归零');
});

test('🔴 攒劲儿：闸门挡掉的消息【不算否决】（连打分都没进）', async () => {
  // `cooldown-after-bot`：她刚说过话之后的 20 秒内，消息连打分都进不去。
  const h = harness({
    config: {
      minIntervalMs: 0,
      cooldownAfterBotMs: 20_000,
      afterUserMsgCount: 1,
      maxPerHour: 100,
      decline_bonus_min_gap_ms: 0,
    },
    gauge: () => ({ speak: false, score: 20, threshold: 50 }),
  });
  // 造出"她刚说过话"的状态（`noteBotSpoke` 就是网关被动回复走的那条）。
  h.engine.noteBotSpoke('group:100', T0, '刚说完一句');

  const d = await h.decide(msg({ at: T0 + 1_000 }));
  assert.equal(d.reason, 'cooldown-after-bot');
  assert.equal(h.gauges.length, 0, '被闸门挡掉 ⇒ 压根没打分');
  assert.equal(
    h.engine.state('group:100').declineCount,
    0,
    '闸门挡的**不是否决**：启发式根本没机会否决（用户 2026-10-14 的硬要求）',
  );
});

test('★ 攒劲儿：判定器返回 null（压根没打分）也不算否决', async () => {
  const h = declineHarness({ gauge: () => null });
  const d = await h.decide(msg({ at: T0 }));
  assert.equal(d.speak, false);
  assert.equal(h.engine.state('group:100').declineCount, 0, 'null = 没打分，不是否决');
});

test('★ 攒劲儿：被点名时不算否决 —— 那是别人找她', async () => {
  // 被点名的消息闸门是**直通**的（`#gate` 里 `addressed` 短路），它会照常进打分；
  // 但"她没回"不该给她攒劲儿 —— 别人明确在找她却没回，不是"她忍着没说"。
  const h = declineHarness({ gauge: () => ({ speak: false, score: 5, threshold: 50 }) });
  const d = await h.decide(msg({ at: T0, mentioned: true }));
  assert.equal(d.addressed, true);
  assert.equal(h.gauges.length, 1, '被点名也要打分（结果虽必回）');
  assert.equal(
    h.engine.state('group:100').declineCount,
    0,
    '判定器说"不说"的被点名消息不该算成"她否决了发言"',
  );
});

test('★ 攒劲儿：config 坏值（负数 / 字符串）不产生 NaN，也不静默哑掉', async () => {
  const h = declineHarness({
    config: { decline_bonus: -5, decline_bonus_cap: 'x', decline_bonus_min_gap_ms: 0 },
  });
  await h.decide(msg({ at: T0 }));
  // 负数/坏值退回**默认**（不是 0）—— 默认 step 6；docstring 里写明了这条语义。
  assert.equal(h.engine.declineBonus('group:100'), 6);
  assert.ok(Number.isFinite(h.engine.declineBonus('group:100')));
});

test('★ 攒劲儿：cap < 阈值 时打一条 warn（否则"配了却不开口"无从查起）', async () => {
  const h = declineHarness({ config: { decline_bonus_cap: 30 } });
  await h.decide(msg({ at: T0 }));
  const warn = h.logs.find((l) => l.level === 'warn' && /decline_bonus_cap/.test(l.message));
  assert.ok(warn, `该有一条 warn，实际日志：${JSON.stringify(h.logs)}`);
  assert.equal(warn.meta.cap, 30);
  assert.equal(warn.meta.threshold, 50);
  // 而且只打一次（热路径上每条消息都打会把 journal 冲掉）。
  await h.decide(msg({ at: T0 + 60_000 }));
  assert.equal(
    h.logs.filter((l) => /decline_bonus_cap/.test(l.message)).length,
    1,
  );
});

test('★ 攒劲儿：journal 里看得到【当前计数】与【本次加了多少】', async () => {
  const h = declineHarness({ config: { decline_bonus: 6, decline_bonus_min_gap_ms: 0 } });
  await h.decide(msg({ at: T0 }));
  const first = h.engine.journal.at(-1);
  assert.equal(first.d_bonus, 0, '本次用的是"已攒的"加分（第一条当然是 0）');
  assert.equal(first.d_declineCount, 1, '这一条否决之后计数是 1');
  assert.equal(first.d_declineBonus, 6, '累计值也留档了');

  await h.decide(msg({ at: T0 + 1_000 }));
  const second = h.engine.journal.at(-1);
  assert.equal(second.d_bonus, 6, '第二次生效的加分 = 上一条攒下的 6');
  assert.equal(second.d_declineCount, 2);
  assert.equal(second.d_declineBonus, 12);
});

test('★ 攒劲儿：按会话分开记账（一个群的攒劲儿不许借给另一个群）', async () => {
  const h = declineHarness({ config: { decline_bonus_min_gap_ms: 0 } });
  await h.decide(msg({ at: T0, chatId: 'group:100' }));
  await h.decide(msg({ at: T0 + 1_000, chatId: 'group:200' }));
  assert.equal(h.engine.state('group:100').declineCount, 1);
  assert.equal(h.engine.state('group:200').declineCount, 1);
  assert.equal(h.engine.declineBonus('group:100'), 6, '各是各的（不是合计）');
});

test('★ 攒劲儿：默认配置就开着（step 6 / cap 60 / 限流 30 秒）', () => {
  const cfg = defaultTriggerConfig();
  assert.equal(cfg.decline_bonus, 6);
  assert.equal(cfg.decline_bonus_cap, 60);
  assert.equal(cfg.decline_bonus_min_gap_ms, 30_000);
  // ⚠️ 不变量：cap 必须 ≥ 判定阈值，否则"最终必然开口"不成立。
  assert.ok(
    cfg.decline_bonus_cap >= defaultGaugeConfig().threshold,
    `cap ${cfg.decline_bonus_cap} 必须 ≥ 阈值 ${defaultGaugeConfig().threshold}`,
  );
});
