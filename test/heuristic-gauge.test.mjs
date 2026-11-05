/**
 * 回复必要性打分的测试。
 *
 * ## 这组测试为什么整体重写
 *
 * 旧实现是**关键词信号计数 + 两条硬门槛**（信号 ≥2、发言人 ≥2），实机跑出来的
 * 结果是「群里正常聊天永远不触发」—— 其中"至少两个不同发言人在场"这条**把只有
 * 一个人在活跃的群直接一票否决**（用户实测：测试群里只有他自己说话，于是永远沉默）。
 *
 * 现在改成照 MaiBot `reply_necessity.py` 的**累积打分 + 阈值**：
 *
 * ```
 * 最终分 = (强相关 + 内容 + 存在感) × 频率倍率
 * ≥ threshold 才说话
 * ```
 *
 * 所以下面断言的是**分数与行为**，不再断言"发言人数量"那种硬门槛。
 *
 * ## ⚠️ 2026-10-13：权重整组换成**拟合值**（方案 3）—— 本文件改动最多的一次
 *
 * 原权重是**手拍的**。在它真正该干活的场景（没有 @我/喊名字）的 2,413 个真实决策点上，
 * 现用打分的 **AUC 只有 0.4801（比抛硬币还差）**；同一套特征做逻辑回归能到
 * **0.6246（5-fold）**。⇒ **特征够用，是权重不对。**
 * 依据与系数：`_qq-judge/SPEC-plan3-landing.md` · `_qq-judge/FIT-RESULT.md`。
 *
 * 这一版改了**行为**（不只是数字），凡是钉行为的断言都按新行为重写了 ——
 * 每一条都留了"为什么变"：
 *
 * | 变了什么 | 为什么 |
 * |---|---|
 * | **问句/求助/技术词不再"单条就触发"** | 拟合系数里这几项都很小；`helpHits` 干脆**砍掉了** |
 * | **`substantive` 是负系数** | 消融显示它对判别的贡献 ≈0（±0.0004） |
 * | **存在感从"扣分"变"加分"** | `selfRatio` 是唯一的主力（去掉它 5-fold 掉 0.083），而符号是正的 |
 * | **`pressure` 砍掉** | 与 `substantive` r=0.957、拟合系数≈0 |
 * | **`helpHits` / `opinionHits` 砍掉** | 词表有毛病 / 出现率 1.12% / 缩放后等于"自动放行后门" |
 * | **阈值 24 → 50** | 权重尺度变了；用离线重放反推（见 `threshold` 的注释） |
 * | **被点名仍必回** | 拟合**排除了 `relevance>0` 的行** ⇒ 对它没证据 ⇒ 不动 |
 *
 * ⚠️ **砍完之后的一个硬事实**（`acceptance.test.mjs` 里有实测）：
 * 在**全新会话**上，`relevance == 0` 的主动插话**几乎不可能**发生 ——
 * 剩下三项（`substantive` 负 / `questions` +8.6 上限 / `techHits` +5.29）撑不起阈值。
 * 真实数据里那条路靠的是 **presence**（她刚说过话、别人接着说）。这不是 bug，
 * 是这次权重取舍的**直接后果**，主会话与用户都该知道。
 *
 * 校准依据见配置示例里的 gauge 段。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  judge,
  score,
  countSignals,
  defaultGaugeConfig,
  looksLikeQuestion,
  isShortReactionBatch,
  hasContent,
  repetitionScore,
  normalizeIndex,
} from '../src/dsh/heuristic-gauge.mjs';

const T0 = 1_700_000_000_000;

/** 造一批消息。 */
function msgs(items) {
  return items.map(([text, userId = 'u1'], i) => ({
    chatId: 'group:1',
    at: T0 + i * 1000,
    text,
    userId,
    nickname: userId,
    kind: 'group',
  }));
}

/** 判定并只取"说不说"。 */
function speaks(request, config) {
  const r = score(request, config === undefined ? {} : { config });
  return r !== null && r.speak;
}

// ---------------------------------------------------------------- 该说话

test('强相关：@我 一定触发', () => {
  const r = score({ kind: 'group', recent: msgs([['@小鲸鱼 在吗']]), mentioned: true });
  assert.ok(r !== null && r.speak, `@我 应触发，实际 ${JSON.stringify(r)}`);
  assert.equal(r.detail.relevance, 60);
});

test('★ 2026-10-13 变更：提到我名字**不再**自动触发（撤掉"被点名必回"保底）', () => {
  // ⚠️ 这条原来钉的是"提到我名字一定触发"，靠的是"被点名 ⇒ 不低于阈值"那条保底。
  // 用户 2026-10-13 03:2x 用真实反例**拍板撤掉保底**（引用/@ 都可能只是吐槽，
  // 见 `addressedFloor` 的注释）⇒ 现在严格按算出来的分走。
  //
  // 这一档实测 `55 + (−6.7) = 48.3`（`怎么` 只是 `questions` 之外的负项 `substantive`），
  // **差 1.7 分**。⇒ 只喊一句名字、正文没什么内容时，**不再必回**。
  // （引擎侧"喊名字"仍会被 `#gate` 放行 —— 但那走的是闸门，不是打分。见文件头。）
  const r = score({ kind: 'group', recent: msgs([['小鲸鱼这个你怎么看']]), nameMentioned: true });
  assert.equal(r.detail.relevance, 55);
  assert.ok(r !== null);
  assert.equal(r.speak, false, `48.3 < 阈值 50 ⇒ 不说（实际 ${r.score}）`);
});

// ⚠️ 这里原来有两条：**「强相关：回复我的消息一定触发」** 与 **「私聊：问句会触发」**。
//    **2026-10-13 03:2x 都删掉了** —— 用户拍板撤掉"被点名必回"保底后它们不再成立
//    （`replyToSelf 35`、`私聊 30` 都到不了阈值 50）。
//    同一条口径现在由下面两条钉着：「引用回复我（没 @）**不再**自动回」+「私聊不再自动过线」。
//    ⚠️ 私聊**实际上照样会回** —— 那由**引擎的 `#gate`** 负责（`isPrivateChat ⇒ addressed`），
//       打分层从来就不是私聊的准入判据。

test('★ 2026-10-13 变更：求助单条**不再**触发（`helpHits` 那一项已砍掉）', () => {
  // 旧版这条钉的是"一个人求助就该能触发"（当时它是对的方向：`helpHits +36`）。
  //
  // 现在 `helpHits` **整个砍掉了**（用户 2026-10-13 拍板）——理由两条：
  //   ① 词表本身有毛病（泛疑问词当求助词 / `怎么`⊂`怎么办` 重复计分 / 单字 `求` 太宽）
  //   ② 拟合系数符号是**负**的（−0.1835），与预期严重不符
  // ⚠️ 口径澄清：消融里它是 **−0.0054** ⇒ **去掉它 AUC 掉 0.0054 ⇒ 它在微弱帮忙**，
  //   不是"它掉 AUC"。**反常的是符号，不是贡献。**
  //
  // ⇒ 求助词现在**完全不参与打分**（`detail.helpHits` 仍然报出来，那只是调试信息）。
  const r = score({ kind: 'group', recent: msgs([['有没有人知道这个报错怎么解决']]) });
  assert.ok(r !== null, '照常打分（不是 null）');
  assert.equal(r.detail.messages, 1);
  assert.ok(r.detail.helpHits >= 2, `求助词仍然被数出来（${r.detail.helpHits} 个）—— 但它不再影响分数`);
  assert.equal(r.score, 0, '内容项只剩 substantive（负），被夹到下限 ⇒ 0 分');
  assert.equal(r.speak, false, '单条求助不再触发');
  // 只靠 `substantive` 一项在算（helpHits/opinionHits 已从 fitWeights 里删掉）
  assert.deepEqual(
    Object.keys(defaultGaugeConfig().fitWeights).sort(),
    ['questions', 'selfRatio', 'substantive', 'techHits'],
    'fitWeights 只剩四项',
  );
});

test('★ 2026-10-13 变更：**征求意见也被砍了**（它是"自动放行后门"，不是加权）', () => {
  // `opinionHits` 系数 +1.8968 ⇒ × `weightScale` 100 = **命中一次 +190，而阈值才 50**
  // ⇒ 那是给这 1.12% 的消息开**自动放行后门**，不是"加权"。加上出现率低、消融 ≈0
  // （−0.0002）⇒ 用户拍板砍掉。
  //
  // ⚠️ **砍它的代价**（必须记一笔）：`'你觉得'` 同时也是**引用回复**最自然的说法
  // （「你觉得呢」）。砍掉之后，一条"引用我、但没 @ 我"的消息只能靠 `relevance +35`
  // —— 见下面那条测试，现在由 `addressed` 的保底兜住。
  const r = score({ kind: 'group', recent: msgs([['你觉得这个方案行不行']]) });
  assert.ok(r.detail.opinionHits >= 1, '词仍然被数出来（调试信息）');
  assert.equal(r.speak, false, '但它不再让这条消息自动过关');
});

test('★ 2026-10-13 变更：**引用回复我**（没 @）**不再**自动回 —— 用户给了真实反例', () => {
  // ⚠️ 这条的沿革（**三次**，每次都跟着权重/口径变）：
  //   1. 手拍权重：`replyToSelf +35` 被 `helpHits +36` 与 `opinionHits +30` **抵消掉 ≈ 0 分**
  //      ⇒ 是"抵消出来的假死代码"，看起来像"引用我不回"。
  //   2. 换拟合权重 + 砍掉那两项后：我补了一条"被点名 ⇒ 不低于阈值"的保底 ⇒ **必回**。
  //   3. **2026-10-13 03:2x 用户拍板撤掉保底**，原话：
  //      「**引用不一定回，我这边有一个刚刚发生的绝佳案例，"吕子翔"引用小鲸鱼的话单纯是为了吐槽**」
  //
  // 现场实测复算（`_qq-judge/_replyto-scenarios.txt`）：「引用我 + 随便一句」= **36.9**，
  // 「引用我 + 原话复制（纯吐槽）」= **38.8** ⇒ **都在阈值 50 以下** ⇒ 不自动回。
  // ⇒ 现在完全靠算术：`+35` 那点相关分不足以独自过线，得真有内容（长文 + 问句等）才回。
  const r = score({ kind: 'group', recent: msgs([['那你觉得呢']]), replyToSelf: true });
  assert.equal(r.detail.relevance, 35);
  assert.equal(r.speak, false, `36.9 < 阈值 50 ⇒ 不自动回（实际 ${r.score}）`);
});

test('★ 引用我 + **真有内容**（技术长文）时仍然会回 —— 撤保底不等于"引用一律不回"', () => {
  // 撤掉的是"自动过关"，不是"这条路作废"：内容够强照样过线。
  // ⚠️ 注意选词：`substantive` 是**负**的，而 `怎么/为什么/求助` 那类词**已经砍掉、不计分了**；
  //    能顶上去的只有 `techHits`（+5.29/个）与 `questions`（+8.6/句）。
  //    所以这里用**技术词密集的长文**（`linux`/`git`/`api` 各命中一次 = +15.87，外加长文 +12）。
  const text = '这个 linux 环境的 git 和 api 一直有问题，'.repeat(12);
  const r = score({ kind: 'group', recent: msgs([[text]]), replyToSelf: true });
  assert.ok(r.detail.techHits >= 3, `技术词该命中至少 3 个，实际 ${r.detail.techHits}`);
  assert.ok(r.speak, `引用我 + 技术长文该回，实际 ${r.score}（阈值 ${r.threshold}）`);
});

test('★ 2026-10-13 变更：技术词只是**很小的正向加分**，单条撑不起阈值', () => {
  // `techHits` 系数 +0.0529（同号，但量级小：单次命中 = 5.29 分）。
  // 旧版这里是「技术词 + 问句 ⇒ 触发」，靠的是 `+15 + 20` 那套手拍加法。
  const r = score({ kind: 'group', recent: msgs([['这个 API 怎么调']]) });
  assert.ok(r.detail.techHits > 0, '技术词照常计分');
  assert.equal(r.speak, false, '单条技术问题不再触发（内容项量级不够）');
});

test('2026-10-13 变更：私聊**不再**自动过线（撤保底后一视同仁）', () => {
  // ⚠️ 原来这条断言"私聊该回"，靠的是"被点名 ⇒ 不低于阈值"那条保底。保底撤掉后
  // 私聊走的是**和群聊同一套算术**：`relevance +30` 加内容项，**过不了阈值 50**。
  // 实测「这个怎么弄啊」= 23.3。
  //
  // ⚠️ **这不等于"私聊不回了"**：私聊的准入在**引擎的 `#gate`**
  // （`engine.mjs` L616-623：`isPrivateChat` ⇒ `addressed` ⇒ 直接放行；
  //  `replay-core.mjs` 里也是 `if (!cfg.enabled && !isAddressed)` 放行私聊）。
  // **打分层只负责群里的"机会主义插话"** —— 私聊那条路由闸门兜着。
  const r = score({ kind: 'private', recent: msgs([['这个怎么弄啊']]) });
  assert.ok(r !== null);
  assert.equal(r.speak, false, `23.3 < 阈值 50 ⇒ 打分层不说（准入由引擎的闸门负责，见注释）`);
});

test('兴趣领域：聊技术也算内容分，而不是只认求助词', () => {
  const r = score({
    kind: 'group',
    recent: msgs([['我在写一个 QQ 机器人', 'u1'], ['用的是 NapCat 加 OneBot', 'u2']]),
  });
  assert.ok(r.detail.techHits > 0, '技术词应计分');
});

// ---------------------------------------------------------------- 该沉默

test('闲聊单条：不触发（靠累积压力才说话）', () => {
  assert.equal(speaks({ kind: 'group', recent: msgs([['今天好累啊', 'u1']]) }), false);
});

test('★ 2026-10-13 变更：闲聊**不再靠条数堆到阈值**（内容项是负的，压力已砍掉）', () => {
  // 旧版这条钉的是"阈值 24 之后要五条才触发"—— 那时候分是这么来的：
  // `min(18,6n)` 的内容基础分 + `pressure = 25n/20` 的压力分。
  // 现在这两项都没了：
  //   · `substantive` 系数 −0.0670（负）
  //   · `pressure` 砍掉（`maxPressure = 0`；它与 substantive r=0.957）
  // ⇒ **闲聊堆多少条都是 0 分**，因为规则本身不再看"条数"。
  //   说不说改由**存在感**（她最近说了多少）决定 —— 见下面的存在感那组测试。
  const many = score({
    kind: 'group',
    recent: msgs([
      ['今天好累啊', 'u1'], ['晚上吃什么', 'u1'], ['好困', 'u1'], ['明天还得早起', 'u2'], ['有点饿', 'u1'],
      ['困死了', 'u1'], ['睡不睡', 'u1'], ['再等等', 'u2'], ['先躺会儿', 'u1'], ['晚安', 'u1'],
    ]),
  });
  assert.ok(many !== null, '照常打分');
  assert.equal(many.detail.pressure, 0, '压力项已砍掉');
  assert.equal(many.score, 0, `十条闲聊是 0 分（内容项为负，被夹在下限），实际 ${many.score}`);
  assert.equal(many.speak, false, '光靠闲聊条数不会触发');
});

test('★ 2026-10-13 变更：问句单条**不再**触发（`questions +0.0860` 太小）', () => {
  // 旧版：`if (questions > 0) content += 18;` ⇒ 单条问句 18 分，够阈值 16/24。
  // 拟合把这个固定 +18 换成 **`+0.0860 × 问句数`** —— 同号，但量级差两个数量级
  // （单条问句 = 8.6 分，阈值 50）。
  //
  // 注：「今晚一起吃饭吗」这类软性邀约也算问句（口径没变，见 `looksLikeQuestion`）。
  const r = score({ kind: 'group', recent: msgs([['今晚一起吃饭吗', 'u1']]) });
  assert.equal(r.detail.questions, 1, '确实被认成问句');
  assert.equal(r.speak, false, '单条问句不再触发');
});

test('纯短反应：整窗都是哈哈/666 时不触发', () => {
  const r = score({ kind: 'group', recent: msgs([['哈哈', 'u1'], ['666', 'u2']]) });
  assert.equal(r, null, '短反应批次应直接沉默');
});

test('明确要求安静：无条件沉默（哪怕 @ 了我）', () => {
  const r = score({ kind: 'group', recent: msgs([['别说话']]), mentioned: true });
  assert.equal(r, null);
});

test('空窗口：沉默', () => {
  assert.equal(score({ kind: 'group', recent: [] }), null);
  assert.equal(score({ kind: 'group' }), null);
});

test('enabled=false 时无条件沉默', () => {
  const r = score(
    { kind: 'group', recent: msgs([['@小鲸鱼 在吗']]), mentioned: true },
    { config: { enabled: false } },
  );
  assert.equal(r, null);
});

// ---------------------------------------------------------------- 短反应：有条件沉默（A3）

test('短反应批次：整窗都是短反应、又没人在跟我说话 → 沉默', () => {
  const r = score({ kind: 'group', recent: msgs([['哈哈', 'u1'], ['666', 'u2']]) });
  assert.equal(r, null, '没人找我，群里只是互相哈哈哈 —— 不插嘴');
});

test('★ 短反应批次：有人 @ 我 → 不 kill（照常打分）', () => {
  // 2026-10-07 改的核心：同样一句「可以」，我刚问完就是**回答**，别人闲聊中间就是**附和**。
  // 字面上分不开，只能看"有没有人在跟我说话"。
  const r = score({ kind: 'group', recent: msgs([['可以', 'u1']]), mentioned: true });
  assert.ok(r !== null, '被 @ 了就不该被短反应一刀切掉');
  assert.equal(r.detail.shortBatch, true, '它**确实**是短反应批次（只是不再无条件沉默）');
  // ⚠️ 2026-10-13 03:2x：撤掉保底后这个结论仍然成立，但**理由是算出来的分**（53.3），
  //    不再是"@ 我必回"那条保底 —— 短反应窗口里 `substantive` 计了 1 条、扣 6.7，
  //    `60 − 6.7 = 53.3 ≥ 50`。
  assert.equal(r.speak, true, `@我 + 短反应仍过线（实际 ${r.score}）`);
});

test('★ 短反应批次豁免 vs 「过线」是两件事（撤保底后的口径）', () => {
  // ⚠️ 2026-10-13 03:2x 撤掉"被点名必回"保底后，这一组要**分开看两件事**：
  //   ① 【豁免】—— 不被"整窗短反应"一刀 kill（判定为 `null`）  ← 这些仍然成立
  //   ② 【过线】—— 分数够不够阈值 50                          ← 撤保底后多数**不够**
  // 把它们混成一条断言（原来的写法）在撤保底后就会红。
  const short = msgs([['彳亍', 'u1'], ['可以', 'u1']]);
  assert.equal(score({ kind: 'group', recent: short }), null, '没人找我 → 直接沉默（不是打分，是 null）');

  const contexts = [
    ['nameMentioned（喊名字）', { nameMentioned: true }, 55],
    ['replyToSelf（引用我）', { replyToSelf: true }, 35],
    ['botSpokeRecently（我刚说完）', { botSpokeRecently: true }, 0],
    ['private（私聊）', {}, 30],
  ];
  for (const [label, extra, rel] of contexts) {
    const req = label.startsWith('private')
      ? { kind: 'private', recent: short }
      : { kind: 'group', recent: short, ...extra };
    const r = score(req);
    assert.ok(r !== null, `${label}：该被豁免（照常打分，不是 null）`);
    assert.equal(r.detail.relevance, rel, `${label}：相关分应是 ${rel}`);
    // ② 过线与否：只有"喊名字"这一档 41.6 也 < 50 ⇒ 这一组**现在都不说**
    assert.equal(r.speak, false, `${label}：短反应 + 这点相关分，够不到阈值 50`);
  }
});

test('★ 短反应批次：命中复读时也豁免（群里在刷同一句）', () => {
  const r = score({ kind: 'group', recent: msgs([['哈哈', 'u1'], ['哈哈', 'u2'], ['哈哈', 'u3']]) });
  assert.ok(r !== null, '复读豁免：整窗短反应 + 复读 → 不 kill');
  assert.ok(r.detail.repetition > 0, '复读分要真的算上');
});

// ---------------------------------------------------------------- 「有内容」不看字数（A4）

test('★ hasContent：去掉标点 / emoji / 空白之后还剩字符才算有内容', () => {
  // 这条取代了旧的 `trim().length >= 4` 魔数（用户否掉了词表方案：「拉一个表…有点笨了」）。
  assert.equal(hasContent('何意味'), true);
  assert.equal(hasContent('可以'), true, '两个字也算（旧规则下不算）');
  assert.equal(hasContent('6'), true);
  assert.equal(hasContent('。。。'), false, '只有标点');
  assert.equal(hasContent('...'), false);
  assert.equal(hasContent('？！'), false);
  assert.equal(hasContent('  '), false);
  assert.equal(hasContent(''), false);
  assert.equal(hasContent('❤️'), false, 'emoji + 变体选择符不算内容');
  assert.equal(hasContent('👨‍👩‍👧'), false, '带零宽连接符的 emoji 也不算');
  assert.equal(hasContent('ok👍'), true, '有实义字符就算');
});

test('★ 短消息（2 字）现在也拿基础分 —— 但整窗都短时仍被拦住', () => {
  // 「可以」单独一条：整窗短反应 → 沉默（没人找我）。
  assert.equal(score({ kind: 'group', recent: msgs([['可以', 'u1']]) }), null);
  // 混在正常对话里，它也是一条"有内容"的消息（旧的 length>=4 会把它漏掉）。
  // ⚠️ 2026-10-13：`substantive` 现在是**负**系数 ⇒ "算进 substantive"**不等于**加分，
  //    这一组从来就不该按"字数多就该说"来理解。这里只钉**计数口径**没变。
  const r = score({ kind: 'group', recent: msgs([['这个报错怎么办', 'u1'], ['可以', 'u2']]) });
  assert.equal(r.detail.substantive, 2, '两条都算有内容');
  assert.equal(r.speak, false, '它不构成"该说话"的理由（内容项为负）');
});

// ---------------------------------------------------------------- 复读机（A5）

test('★ 复读机：窗口里同样的文本 ≥3 条才加分，每条 +6', () => {
  const two = score({ kind: 'group', recent: msgs([['确实', 'u1'], ['确实', 'u2'], ['这个 API 怎么调', 'u3']]) });
  assert.equal(two.detail.repetition, 0, '两条还不算复读');

  const three = score({
    kind: 'group',
    recent: msgs([['确实', 'u1'], ['确实', 'u2'], ['确实', 'u3'], ['这个 API 怎么调', 'u4']]),
  });
  assert.ok(three.detail.repetition > 0, '三条起算');
  assert.equal(three.detail.repeatMessages, 3);

  const four = score({
    kind: 'group',
    recent: msgs([['确实', 'u1'], ['确实', 'u2'], ['确实', 'u3'], ['确实', 'u4'], ['这个 API 怎么调', 'u5']]),
  });
  assert.ok(four.detail.repetition > three.detail.repetition, '4 条比 3 条更多');
});

test('★ 复读机：「一样」= trim 后严格相等（标点/大小写不归一）', () => {
  const withSpace = repetitionScore(msgs([['  确实  '], ['确实'], ['确实']]));
  assert.equal(withSpace.messages, 3, '首尾空白不影响"一样"');
  const mixedCase = repetitionScore(msgs([['OK'], ['ok'], ['Ok']]));
  assert.equal(mixedCase.messages, 0, '大小写不归一');
  const withPunct = repetitionScore(msgs([['确实'], ['确实。'], ['确实！']]));
  assert.equal(withPunct.messages, 0, '标点不归一');
});

test('★ 复读机：三句一模一样的短话**不再**单独触发（复读分没进拟合）', () => {
  // 旧版钉的是「3 条 = 18 ≥ 阈值 16」（倍率 1.0 之后）。
  // 2026-10-13：`repetition` 的拟合系数是 **−0.0016**（消融 +0.0005 ⇒ 判别贡献≈0），
  // 所以按 SPEC 它**保留原样（+6/条）、但不进拟合那一坨**：
  // 3 条复读 = 18 分，而阈值已经涨到 50 ⇒ **单独触发不了**。
  // 复读**照样计分**（它作为"群里在玩梗"的信号仍然留着），只是不足以独自开口。
  const r = score({ kind: 'group', recent: msgs([['确实', 'u1'], ['确实', 'u2'], ['确实', 'u3']]) });
  assert.ok(r !== null, '照常打分');
  assert.equal(r.detail.repetition, 18, '复读分照旧 +6/条');
  assert.equal(r.speak, false, '光靠三条复读撑不起阈值 50');
});

// ---------------------------------------------------------------- @ 别人只算 +3（A6）

test('★ @ 了别人的消息：content 只给 +3，不按"有内容"给基础分', () => {
  // 用户原话：「别人 @ 别人和小鲸鱼关系太小了，content 那边 +3 分算了，
  // 一般情况下不吭声，只有之前各种分攒多了才会说一声」。
  const atOther = (text, i) => ({
    chatId: 'g:1', at: T0 + i * 1000, text, userId: 'u1', kind: 'group', mentionsOthers: true,
  });
  const r = score({ kind: 'group', recent: [atOther('@10000002 你看看', 0)] });
  assert.equal(r.detail.atOthers, 1);
  assert.equal(r.detail.substantive, 0, '它不该再算"有内容"');
  assert.equal(r.detail.content, 3, '只给 +3');
  assert.equal(r.speak, false, '单靠它绝不会触发（3 分离阈值 16 差得远）');
});

test('★ 2026-10-13 变更：@别人攒到 8 条**不再**触发（它压根不进拟合表）', () => {
  // ⚠️ `atOthers` 在拟合里**没有对应特征**（`mentionsOthers` 老库恒 false ⇒ 本实验对它全盲）
  // ⇒ 按 SPEC 它是"没证据"的历史项，原样保留 **+3/条**。
  // 8 条 = 24 分 < 阈值 50 ⇒ 不再触发（旧版是 8×3 + 压力 ≈ 39 ≥ 24，所以能触发）。
  const atOther = (text, i) => ({
    chatId: 'g:1', at: T0 + i * 1000, text, userId: 'u1', kind: 'group', mentionsOthers: true,
  });
  const one = score({ kind: 'group', recent: [atOther('@10000002 你看看', 0)] });
  const many = score({
    kind: 'group',
    recent: Array.from({ length: 8 }, (_, i) => atOther(`@10000002 你看看${i}`, i)),
  });
  // ⚠️ 砍掉 `helpHits`/`opinionHits` 之后，这个窗口的 `contentFit` 是 0
  //    （`substantive` 命中 8 条？不 —— 这些消息都带 `mentionsOthers`，
  //    所以它们**不算 substantive**，只剩 `techHits` 命中 "qq"×1 = +5.29）⇒
  //    内容项 ≈ +5.3，`contentLegacy` +24 加得上去 ⇒ 总分 29.3 < 50。
  assert.equal(one.detail.contentLegacy, 3, '单条 +3');
  assert.equal(many.detail.contentLegacy, 24, '8 条 +24（线性，不封顶也不加权）');
  assert.ok(many.score > one.score, '确实在涨（+3 与 +5.3 那两项）');
  assert.equal(many.speak, false, '但涨不到阈值 50');
});

test('★ 2026-10-13 变更：内容项可以是负的 —— 但那不吃"被点名"的保底', () => {
  // 这是新权重最容易踩的坑：`substantive` 是**负**系数（−0.0670）⇒
  // 窗口里"有内容"的消息越多，内容项扣得越狠（下限 `contentFitFloor`）。
  // 实测踩到过「小鲸鱼这个你怎么看」（`relevance 55`）被内容项扣到 30 分 ⇒ 阈值 50 ⇒
  // **喊了名字却不回**。⇒ 所以 `addressed` 一路有保底（`addressedFloor`）。
  const r = score({
    kind: 'group',
    recent: [{ chatId: 'g:1', at: T0, text: '@10000002 @我 你们看看', userId: 'u1', mentionsOthers: true, mentioned: true }],
    mentioned: true,
  });
  assert.equal(r.detail.atOthers, 0, '它 @ 了我，不算"@别人"那一档');
  assert.ok(r.detail.substantive >= 1, '照常算有内容');
  // 内容项是负的（`substantive` 1 条 × −0.0670 × 100 = −6.7）；但分不会被它拖下去。
  assert.equal(r.detail.content, -6.7, `内容项是负的，实际 ${r.detail.content}`);
  assert.ok(r.speak, '@我 + 保底 ⇒ 照旧必回');
});

test('@ 我 的消息不受 +3 规则影响（强相关仍是 +60）', () => {
  const r = score({
    kind: 'group',
    recent: [{ chatId: 'g:1', at: T0, text: '@我 在吗', userId: 'u1', kind: 'group', mentionsOthers: false }],
    mentioned: true,
  });
  assert.equal(r.detail.relevance, 60);
  assert.equal(r.detail.atOthers, 0);
  assert.ok(r.detail.substantive >= 1, '被 @ 的那条照常算内容');
});

test('@ 了我和别人（同一条）：那一档的分类口径不变（不压到 +3）', () => {
  // 口径是「@ 的**不是小鲸鱼**」——同时 @ 了我的那种，强相关已经拿了 60 分，
  // 内容也从"有内容"那一档算。只有"整条都不是冲我来的"才走 +3。
  //
  // ⚠️ 2026-10-13：内容项现在**可能是负分**（见上面那条测试），所以这里只钉
  // **归类**（`atOthers` 不算它）与"它确实进了 substantive"，不钉正负。
  const r = score({
    kind: 'group',
    recent: [{
      chatId: 'g:1', at: T0, text: '@10000002 @我 你们看看', userId: 'u1',
      kind: 'group', mentionsOthers: true, mentioned: true,
    }],
    mentioned: true,
  });
  assert.equal(r.detail.atOthers, 0, '它 @ 了我，不算"@别人"那一档');
  assert.ok(r.detail.substantive >= 1, '照常算有内容');
  assert.notEqual(r.detail.content, 3, '不该被压到"@别人"那个 +3');
});

// ---------------------------------------------------------------- 存在感（A8）
//
// ⚠️ **2026-10-13 整组反转**：这一项从「存在感**惩罚**（−0..25，防话痨）」
// 改成「存在感**加分**（`selfRatio × +2.9636 × 100`）」。
//
// 依据：去共线后的拟合里，`selfRatio` 的系数是 **+2.9636**，而且是**唯一的主力**
// （消融：去掉它 5-fold 从 0.6246 掉到 0.5418，掉了 0.083；别的项都在 ±0.006 以内）。
// 用户 2026-10-13 明确拍板「**那 selfRatio 还是跟着他们加分吧**」。
//
// ⇒ 这意味着**放弃"用存在感压话痨"这个产品意图**（见 SPEC）。话痨控制交给提示词/别的环节。
//
// 口径没变的部分：
//   1. **占比**：从「我 / 窗口」改成「我 / (窗口 + 我)」——
//      小鲸鱼的话不在转录里，分母只用窗口的话，分子一大就会出现"占比 > 100%"这种怪数；
//   2. **"我说了几次"的来源**：小鲸鱼自己的消息**不进转录**（`fromSelf` 在 push 之前
//      就 return 了），所以旧实现里 `selfRatio` 恒为 0、**penalty 是死代码**。
//      现在由引擎把发言时间戳带进来（`request.selfAt`）。旧的 `fromSelf` 条目仍认（兜底）。

/** 4 条用户消息、跨度 3 秒 —— 只让"我说了几次"变化。 */
function penaltyWindow() {
  return [0, 1, 2, 3].map((i) => ({
    chatId: 'g:1', at: T0 + i * 1000, text: '这个 API 怎么调', userId: 'u1', kind: 'group',
  }));
}

test('★ 存在感：我说得越多，分**越高**（2026-10-13 反转；不再是恒 0 的死代码）', () => {
  const window = penaltyWindow();
  const quiet = score({ kind: 'group', recent: window, selfAt: [] });
  const some = score({ kind: 'group', recent: window, selfAt: [T0, T0 + 1000] });
  const lots = score({ kind: 'group', recent: window, selfAt: [T0, T0 + 1000, T0 + 2000, T0 + 3000] });

  assert.equal(quiet.detail.presence, 0);
  assert.equal(quiet.detail.selfCount, 0);
  assert.equal(some.detail.selfCount, 2, '引擎报"窗口里我说了 2 次"');
  assert.ok(some.detail.presence > quiet.detail.presence, '占比升高，存在感分该升高');
  assert.ok(lots.detail.presence > some.detail.presence, '占比更高加得更多');
  assert.ok(lots.score > quiet.score, `我说得越多分越高：${lots.score} vs ${quiet.score}`);
  assert.ok(lots.speak, '话接上了（占比高 ⇒ 该继续说）');
});

test('★ 占比的分母是「窗口 + 我」', () => {
  const window = penaltyWindow(); // 窗口 4 条
  const r = score({ kind: 'group', recent: window, selfAt: [T0, T0 + 1000] });
  assert.equal(r.detail.selfCount, 2);
  assert.equal(r.detail.selfRatio, Math.round((2 / 6) * 100) / 100, '2 / (4 + 2)');
});

test('存在感：占比低 ⇒ 存在感分也低（连续，不再有 free/full 那两条线）', () => {
  // 旧口径是**分段**的（低于 `selfRatioFree` 不扣、到 `selfRatioFull` 扣满）。
  // 拟合用的是**连续**的 `recent_self_ratio` ⇒ 现在直接按比例给分，没有断点。
  const rows = Array.from({ length: 8 }, (_, i) => ({
    chatId: 'g:1', at: T0 + i * 1000, text: '这个 API 怎么调', userId: 'u1', kind: 'group',
  }));
  const low = score({ kind: 'group', recent: rows, selfAt: [T0] });
  const high = score({ kind: 'group', recent: rows, selfAt: [T0, T0 + 1000, T0 + 2000, T0 + 3000] });
  assert.equal(low.detail.selfCount, 1);
  assert.equal(low.detail.selfRatio, Math.round((1 / 9) * 100) / 100, '1 / (8 + 1)');
  assert.ok(low.detail.presence > 0, '占比再低也给分（连续口径，没有死区）');
  assert.ok(low.detail.presence < high.detail.presence, '占比低 ⇒ 给得少');
});

test('存在感：被点名（喊名字）时**不算这一项**（但照样必回）', () => {
  const window = penaltyWindow();
  const selfAt = [T0, T0 + 1000, T0 + 2000, T0 + 3000]; // 占比很高
  const r = score({ kind: 'group', recent: window, selfAt, nameMentioned: true });
  assert.ok(r !== null);
  assert.equal(r.detail.presence, 0, '被点名时不算存在感项（这是别人在找她，不是她自己插话）');
  assert.ok(r.speak, '喊了名字就该回');
});

test('存在感：窗口外的发言不算（只看窗口那段时间里我说了几次）', () => {
  const window = penaltyWindow();
  const r = score({
    kind: 'group',
    recent: window,
    // 三条都在窗口之前（更早的时间戳）→ 不该被算进来
    selfAt: [T0 - 60_000, T0 - 30_000, T0 - 10_000],
  });
  assert.equal(r.detail.selfCount, 0, '窗口外的不算');
  assert.equal(r.detail.presence, 0);
});

test('存在感：转录里真带 fromSelf 的条目仍然认（向后兼容）', () => {
  // 生产链路上小鲸鱼的消息不进转录，所以这条只是兜底 —— 但它是旧行为，不能悄悄丢。
  const rows = [
    { chatId: 'g:1', at: T0, text: '我看看', userId: 'bot', fromSelf: true, kind: 'group' },
    { chatId: 'g:1', at: T0 + 1000, text: '这个我知道', userId: 'bot', fromSelf: true, kind: 'group' },
    { chatId: 'g:1', at: T0 + 2000, text: '这个 API 怎么调', userId: 'u1', kind: 'group' },
    { chatId: 'g:1', at: T0 + 3000, text: '还有个问题', userId: 'u1', kind: 'group' },
  ];
  const r = score({ kind: 'group', recent: rows });
  assert.equal(r.detail.selfCount, 2);
  assert.ok(r.detail.presence > 0, '占比 2/6 该开始给存在感分了');
});

// ---------------------------------------------------------------- 压力曲线（A9）

test('★ 2026-10-13 变更：压力项**默认砍掉**（maxPressure=0），但曲线本身还活着', () => {
  // 砍掉的理由：`pressure` 与 `substantive` 的相关系数 **r = 0.957**（基本是同一个量），
  // 去共线时它被自动丢掉；拟合系数≈0；实测"打到 0 只降 1.5pp"。
  //
  // ⚠️ 但 `pressureScore()` **不是死代码** —— 它是可配置的：
  // `maxPressure` 改回 25（并把 `pressureWeight` 设成 1）就恢复。
  // 所以这一组测试同时钉**两件事**：默认是 0，以及曲线本身仍然正确（直线 + 封顶）。
  const cfg = defaultGaugeConfig();
  assert.equal(cfg.maxPressure, 0, '默认砍掉');
  assert.equal(cfg.pressureWeight, 0, '倍率也是 0（两个都要开才生效）');

  // 用"纯标点、每条都不一样"的消息把内容清掉，单独看压力：
  //   · 纯标点 → hasContent=false → 内容项为 0
  //   · 每条长度不同 → 不会被当成复读
  //   · botSpokeRecently → 跳过"整窗短反应"的沉默（那是另一条规则，别混进来）
  const at = (n, gauge) => score({
    kind: 'group',
    recent: Array.from({ length: n }, (_, i) => ({
      chatId: 'g:1', at: T0 + i * 1000, text: '。'.repeat(i + 1), userId: 'u1', kind: 'group',
    })),
    botSpokeRecently: true,
  }, gauge ? { config: gauge } : {});

  // ① 默认：恒 0
  assert.equal(at(1).detail.pressure, 0);
  assert.equal(at(20).detail.pressure, 0);
  assert.equal(at(1).detail.content, 0, '纯标点不该有内容分');

  // ② 把两个旋钮打开 ⇒ 老曲线回来了（这是"没坏，只是关了"的证据）
  const on = { maxPressure: 25, pressureWeight: 1 };
  const points = [1, 4, 5, 8, 13, 19, 20, 40].map((n) => [n, at(n, on).detail.pressure]);
  const asMap = new Map(points);
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(
      points[i][1] >= points[i - 1][1],
      `压力不该随消息数下降：n=${points[i - 1][0]} → ${points[i - 1][1]}，n=${points[i][0]} → ${points[i][1]}`,
    );
  }
  // 直线：每多一条消息压力涨同样的量（detail 保留 1 位小数，所以比"每步斜率"）。
  const slope = (from, to) => (asMap.get(to) - asMap.get(from)) / (to - from);
  const s1 = slope(4, 5);
  const s2 = slope(5, 8);
  const s3 = slope(8, 13);
  assert.ok(
    Math.abs(s1 - s2) < 0.1 && Math.abs(s2 - s3) < 0.1,
    `该是一条直线：每步斜率 ${s1} / ${s2} / ${s3}`,
  );
  // 封顶：到饱和点就不再涨。
  assert.equal(asMap.get(20), 25);
  assert.equal(asMap.get(40), 25, '超过饱和点也不越过封顶');
  // 用户点名要钉的点（账本 §12.5）：n=4 → 5 分（不再满分）。
  assert.equal(asMap.get(4), 5, 'n=4 该是 5 分，不是满分');
  assert.ok(Math.abs(asMap.get(13) - 16.25) < 0.1, `n=13 该约 16.25，实际 ${asMap.get(13)}`);
});

// ---------------------------------------------------------------- 频率倍率（A7）

test('★ 频率倍率是【纯倍率】：multiplier === frequency，默认 1.0（不打折）', () => {
  // 旧写法是 `0.5 + 0.5 × frequency`，默认填 0.5 得到固定 0.75 —— 那等于"阈值偷偷抬高 33%"。
  // 用户 2026-10-07 原话：「倍率改成 1.0 * frequency，然后 frequency 改成 1，其他的先不动」。
  const request = { kind: 'group', recent: msgs([['这个 API 怎么调']]) };
  assert.equal(defaultGaugeConfig().frequency, 1, '默认必须是不打折');
  assert.equal(score(request).detail.multiplier, 1, '不传配置时就是 1.0');
  assert.equal(score(request, { config: { frequency: 0.5 } }).detail.multiplier, 0.5);
  assert.equal(score(request, { config: { frequency: 0 } }).detail.multiplier, 0, '0 = 静音（原始分直接乘没了）');
  assert.equal(score(request, { config: { frequency: 1 } }).detail.multiplier, 1);
});

test('频率倍率：越高越容易触发；0 时什么都不说', () => {
  // ⚠️ 2026-10-13：**换了个构造方式**。旧版用「这个 API 怎么调」（当时靠手拍加法有 56 分），
  // 现在它恒 0 分（内容项只剩负的 `substantive`）⇒ 测不出倍率。
  // 而"征求意见"那条路也被砍了 ⇒ **没有任何单条内容能拿到正分**
  // （见下面"内容项已经弱到撑不起阈值"那条测试）。⇒ 改用**存在感**造一个正分：
  // 把 `contentFitFloor` 关掉（0），只留 `selfRatio` 那一项。
  const request = {
    kind: 'group',
    recent: msgs([['这个 API 怎么调', 'u1'], ['这个 API 怎么调', 'u1']]),
    selfAt: [T0, T0 + 1000, T0 + 2000],
  };
  const gauge = { contentFitFloor: 0 };
  const low = score(request, { config: { ...gauge, frequency: 0 } });
  const high = score(request, { config: { ...gauge, frequency: 1 } });
  assert.ok(high.score > low.score, `频率高应得更高分：${high.score} vs ${low.score}`);
  assert.equal(low.speak, false, '倍率 0 → 永远不说');
  assert.equal(high.speak, true);
});

test('频率倍率：非法值退回默认的 1.0（不是 NaN）', () => {
  const request = { kind: 'group', recent: msgs([['这个 API 怎么调']]) };
  for (const bad of [undefined, null, 'x', NaN, {}]) {
    const r = score(request, { config: { frequency: bad } });
    assert.equal(r.detail.multiplier, 1, `frequency=${String(bad)} 应退回 1`);
    assert.ok(Number.isFinite(r.score), '分数不能变成 NaN');
  }
});

// ---------------------------------------------------------------- judge 接口

test('judge：说不说与 score 一致，说了才给文本', () => {
  const yes = judge({ kind: 'group', recent: msgs([['@小鲸鱼 在吗']]), mentioned: true }, { random: () => 0 });
  assert.ok(yes !== null && typeof yes.text === 'string' && yes.text.length > 0);
  assert.equal(yes.speak, true);
  assert.ok(yes.score > 0);
  // threshold 要跟着结果一起出来：判定日记靠它解释"为什么没说"。
  assert.equal(yes.threshold, defaultGaugeConfig().threshold);

  // 分数不够：**不是** null，而是带分数的"不说"——否则排查时只剩"没冒泡"三个字。
  // ⚠️ 2026-10-13：`no.score` 现在是 **0**（内容项被夹到下限、再被 `Math.max(0, …)` 夹回来）。
  // 这不影响这条测试要钉的东西（"不是 null，而是带分数的沉默"），所以照旧。
  const no = judge({ kind: 'group', recent: msgs([['今天天气不错']]) });
  assert.equal(no.speak, false);
  assert.equal(no.text, undefined);
  assert.ok(no.score < no.threshold, `分数 ${no.score} 应低于阈值 ${no.threshold}`);
});

test('judge：压根没打分的情形才返回 null（空窗 / 命中"别说话"）', () => {
  assert.equal(judge({ kind: 'group', recent: [] }), null);
  assert.equal(judge({ kind: 'group', recent: msgs([['别说话']]) }), null);
  assert.equal(judge({ kind: 'group', recent: msgs([['哈哈']]) }), null, '纯短反应不参与打分');
});

test('judge：templates 可自定义', () => {
  const r = judge(
    { kind: 'group', recent: msgs([['@小鲸鱼 在吗']]), mentioned: true },
    { config: { templates: ['我的台词'] }, random: () => 0 },
  );
  assert.equal(r.text, '我的台词');
});

test('judge：templates 为空时回退默认文案，不崩', () => {
  const r = judge(
    { kind: 'group', recent: msgs([['@小鲸鱼 在吗']]), mentioned: true },
    { config: { templates: [] }, random: () => 0 },
  );
  assert.ok(typeof r.text === 'string' && r.text.length > 0);
});

// ---------------------------------------------------------------- 辅助函数

test('looksLikeQuestion：中英文问号与「吗/呢」结尾', () => {
  assert.equal(looksLikeQuestion('这个怎么弄？'), true);
  assert.equal(looksLikeQuestion('这是什么?'), true);
  assert.equal(looksLikeQuestion('这样可以吗'), true);
  assert.equal(looksLikeQuestion('然后呢'), true);
  assert.equal(looksLikeQuestion('今天天气不错'), false);
  assert.equal(looksLikeQuestion(''), false);
});

test('isShortReactionBatch：整窗短反应才算', () => {
  assert.equal(isShortReactionBatch(msgs([['哈哈', 'u1'], ['666', 'u2']])), true);
  assert.equal(isShortReactionBatch(msgs([['哈哈', 'u1'], ['这个报错怎么办', 'u2']])), false);
  assert.equal(isShortReactionBatch([]), true);
});

test('countSignals：保留但判定已不依赖它（调试用）', () => {
  const s = countSignals(msgs([['这个报错怎么办', 'u1'], ['谁知道', 'u2']]));
  assert.ok(s.hits >= 2);
  assert.equal(s.distinctSenders, 2);
});

test('normalizeIndex：越界与非法值都夹到合法范围', () => {
  assert.equal(normalizeIndex(0, 3), 0);
  assert.equal(normalizeIndex(0.99, 3), 2);
  assert.equal(normalizeIndex(1, 3), 2);
  assert.equal(normalizeIndex(-5, 3), 0);
  assert.equal(normalizeIndex(NaN, 3), 0);
  assert.equal(normalizeIndex(0.5, 0), 0);
});

test('defaultGaugeConfig：关键字段齐全', () => {
  const cfg = defaultGaugeConfig();
  for (const k of [
    'enabled', 'lookback', 'threshold', 'frequency', 'maxPressure', 'maxPresencePenalty',
    // 2026-10-13 方案 3 新增
    'weightScale', 'fitWeights', 'contentFitFloor', 'addressedFloor', 'pressureWeight',
  ]) {
    assert.ok(k in cfg, `缺字段 ${k}`);
  }
  assert.ok(cfg.threshold > 0);
  assert.ok(Array.isArray(cfg.templates) && cfg.templates.length > 0);
  // 拟合系数**只剩四项**（`helpHits` / `opinionHits` 已按用户拍板砍掉 —— 见代码注释）
  for (const k of ['substantive', 'questions', 'techHits', 'selfRatio']) {
    assert.equal(typeof cfg.fitWeights[k], 'number', `fitWeights 缺 ${k}`);
  }
  for (const k of ['helpHits', 'opinionHits']) {
    assert.ok(!(k in cfg.fitWeights), `fitWeights 不该再有 ${k}（已砍）`);
  }
});

test('score：detail 带齐各分项，便于排查', () => {
  const r = score({ kind: 'group', recent: msgs([['这个 API 怎么调', 'u1']]) });
  for (const k of [
    'relevance', 'content', 'contentFit', 'pressure', 'presence', 'repetition',
    'multiplier', 'weightScale', 'messages',
    // 2026-10-14 新增（第 6 项：攒劲儿）
    'declineBonus',
  ]) {
    assert.ok(k in r.detail, `detail 缺 ${k}`);
  }
  // `penalty` 已随方案 3 改名成 `presence`（语义也从扣分变加分）
  assert.ok(!('penalty' in r.detail), '旧的 penalty 字段不该再出现（改成 presence 了）');
});

// ---------------------------------------------------------------- 攒劲儿（第 6 项）
//
// 2026-10-14：账本 §4.2 那个悬案的答案 —— 加在**打分这一层的 `raw` 上、
// 参与 `>= threshold` 判定**（不是"闸门欠账"）。引擎算好通过 `request.declineBonus`
// 带进来（见 `defaultTriggerConfig().decline_bonus`）。

test('★ 攒劲儿：不传 `declineBonus` 时加分恒为 0（既有行为逐字不变）', () => {
  const req = { kind: 'group', recent: msgs([['今天这个 bug 有点意思', 'u1']]) };
  const bare = score(req);
  const zero = score({ ...req, declineBonus: 0 });
  assert.equal(bare.detail.declineBonus, 0);
  assert.equal(zero.score, bare.score, '显式给 0 必须与不传等价');
});

test('★ 攒劲儿：加分计入总分，能把"差一点"推过阈值', () => {
  // 「@ 了别人」的消息内容项只给 +3，且**不计入 `substantive`**（那项是负的）
  // ⇒ 分数只有 3 分，单条怎么都过不了 50。正是用它测"刚刚好推过去"这条边界。
  const req = {
    kind: 'group',
    recent: msgs([['@30000024 666', 'u1']]).map((m) => ({ ...m, mentionsOthers: true })),
  };
  const bare = score(req);
  assert.equal(bare.score, 3, `口径前提：@别人 只给 +3，实际 ${bare.score}`);
  assert.equal(bare.speak, false, `基准不该过线，实际 ${bare.score}/${bare.threshold}`);
  // 差多少补多少：判定是 `final >= threshold`，所以**补齐就该过**。
  const gap = Math.round((bare.threshold - bare.score) * 10) / 10;
  const just = score({ ...req, declineBonus: gap });
  assert.ok(
    just.speak,
    `补上 ${gap} 分后应恰好过线：${just.score} vs ${just.threshold}`,
  );
  // 差一分不过（证明它真的走的是那个阈值判定，不是"有加分就放行"）。
  const notYet = score({ ...req, declineBonus: gap - 1 });
  assert.equal(notYet.speak, false, `差一点仍不该过线，实际 ${notYet.score}`);
});

test('★ 攒劲儿：detail 里能看到"这次加了多少"（否则线上没法诊断）', () => {
  const req = {
    kind: 'group',
    recent: msgs([['@30000024 666', 'u1']]).map((m) => ({ ...m, mentionsOthers: true })),
  };
  const bare = score(req);
  const r = score({ ...req, declineBonus: 42.55 });
  assert.equal(r.detail.declineBonus, 42.6, 'detail 保留一位小数（与 score 同尺度）');
  assert.equal(
    r.score,
    Math.round((bare.score + 42.55) * 10) / 10,
    '总分 = 不含攒劲儿的基准分 + 加分',
  );
});

test('★ 攒劲儿：坏值（负数 / NaN / 字符串）一律当 0，绝不变成 NaN', () => {
  const req = { kind: 'group', recent: msgs([['今天这个 bug 有点意思', 'u1']]) };
  const base = score(req).score;
  for (const bad of [-10, Number.NaN, 'x', null, undefined, {}]) {
    const r = score({ ...req, declineBonus: bad });
    assert.ok(Number.isFinite(r.score), `declineBonus=${String(bad)} 时分数必须是有限数`);
    assert.equal(r.score, base, `declineBonus=${String(bad)} 应等价于 0`);
  }
});

test('★ 攒劲儿：被点名时它加在"保底抬分"之前（两者不互斥）', () => {
  // `addressedFloor = 1` 时 final = max(raw + 攒劲儿, threshold)。
  const req = {
    kind: 'group',
    recent: msgs([['@小鲸鱼 在吗', 'u1']]),
    mentioned: true,
  };
  const r = score(req, { config: { addressedFloor: 1 } });
  assert.equal(r.speak, true, '保底本身就该过线');
  const withBonus = score({ ...req, declineBonus: 10 }, { config: { addressedFloor: 1 } });
  assert.equal(withBonus.speak, true, '加了攒劲儿也必须过线');
  assert.ok(
    withBonus.score >= r.score,
    `攒劲儿只该抬分：${withBonus.score} vs ${r.score}`,
  );
});

// ---------------------------------------------- contentFitFloor（2026-10-16）
//
// 用户原话：「反正现在有 llm 兜底，我说不用尝试用启发式之间拟合 20% 的发言率的，
// 干脆负分少一些，10 吧」+「这个改分**除了示例群**全改」。
// ⇒ 全局默认 -0.30 → **-0.10**（weightScale=100 ⇒ 负分 -30 → -10）；
//   示例群（30000013）靠 `[proactive.groups."30000013".gauge] contentFitFloor = -0.30` 保住旧值。
//
// ⚠️ 这条同时钉住**新增的那层能力**：在此之前 `gauge` 的配置全局只有一份，
//   引擎的按群 `overrides` 只作用于闸门/配额 ⇒ **按群覆盖改不了打分**。
//   现在 `request.gaugeOverrides` 以最高优先级合并（见 `score()` 里 `cfg` 那行）。

test('★ 2026-10-16：contentFitFloor 全局默认 -0.10', () => {
  assert.equal(
    defaultGaugeConfig().contentFitFloor,
    -0.10,
    '负分从 -30 收到 -10（有 LLM 兜底，不必再用启发式硬拟合发言率）',
  );
});

test('★ 2026-10-16：request.gaugeOverrides 优先级最高 —— 示例群保住旧地板 -0.30', () => {
  // 造一窗"纯闲聊、没人提她"的消息 ⇒ 内容项会触到地板，于是 detail.contentFit 就等于地板。
  const chat = [
    ['这游戏真好玩啊'], ['是啊是啊'], ['我也觉得'], ['哈哈哈哈哈'],
    ['明天还玩吗'], ['玩'], ['好'], ['嗯'],
  ];
  const plain = score({ kind: 'group', recent: msgs(chat) });
  const star = score({ kind: 'group', recent: msgs(chat), gaugeOverrides: { contentFitFloor: -0.30 } });

  assert.ok(plain !== null && star !== null, '两轮都该照常打分');
  assert.equal(plain.detail.contentFit, -0.1, `不带覆盖 ⇒ 地板 -0.1，实际 ${plain.detail.contentFit}`);
  assert.equal(star.detail.contentFit, -0.3, `带覆盖 ⇒ 地板 -0.3，实际 ${star.detail.contentFit}`);
  // ⚠️ 这里**不能比 `score`** —— 这个最小请求里两项的 `score` 都被夹到 0（total 是负的），
  //    比出来恒等。要比的是**摊平后的内容项**：-0.1×100 = -10 vs -0.3×100 = -30。
  //    （第一版就是比 score，结果 `plain=0 star=0` 挂了 —— 测试写得不严谨，不是代码错。）
  assert.equal(plain.detail.content, -10, `不带覆盖 ⇒ 内容项 -10，实际 ${plain.detail.content}`);
  assert.equal(star.detail.content, -30, `带覆盖 ⇒ 内容项 -30，实际 ${star.detail.content}`);
});

