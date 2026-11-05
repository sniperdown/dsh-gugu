/**
 * 回复必要性打分 —— 决定"这个机会主义冒泡要不要出声"。
 *
 * ## 为什么重写
 *
 * 旧实现是**关键词信号计数**：只认 `怎么/如何/帮忙/报错/…` 这十几个 HELP 词，
 * 还要求「信号 ≥2」且「至少两个不同发言人在场」。
 * 实机跑出来的结果（用户真机数据）：
 *
 * | 场景 | 信号 | 发言人数 | 结果 |
 * |---|---|---|---|
 * | 群里正常聊天（累了/吃饭/打游戏） | 1 | 1 | 不说 |
 * | 求助 + 问句（同一人） | 2 | 1 | **不说（被 distinctSenders 一票否决）** |
 * | 技术讨论（两人，无关键词） | 0 | 2 | 不说 |
 * | 求助（两人） | 2 | 2 | 说 |
 *
 * 也就是：**群里正常聊天永远不触发**，只有"求助关键词 + 多人"才行。
 *
 * ## 照着谁改
 *
 * 照 MaiBot（`Mai-with-u/MaiBot`）的 `src/maisaka/reply_necessity.py`：
 * 它不用"信号计数"，而是**累积打分 + 阈值触发**：
 *
 * ```
 * 最终分 = (强相关 + 内容 + 压力 − 存在感惩罚) × 频率倍率
 * ≥ 阈值才说话
 * ```
 *
 * 其中**「存在感惩罚」是最值得学的一条**：自己最近发言占比超过一定比例
 * 就开始扣分，占比越高扣得越狠 —— 专门防话痨。比单纯的冷却时间聪明得多。
 *
 * ## 本实现与原版的差异（有意为之）
 *
 * - **不要求多个发言人**。MaiBot 没有这个要求；一个活跃的人连着聊几句、
 *   句句都在点子上，正是该接话的时候。原版的 `distinctSenders >= 2` 直接删掉
 *   —— 它是实机上"永远不触发"的直接原因。
 * - **不依赖 LLM**。原版 `reply_necessity` 是纯规则；这里保持同一定位：
 *   纯函数、可测、零依赖。"说什么"仍由模板决定（未来可接 LLM）。
 * - **权重与阈值可配置**，便于用真实数据校准（配置项见 `docs/config.example.qq-gugu.toml`）。
 *
 * ## 分数口径（2026-10-13 换权重，见 `_qq-judge/SPEC-plan3-landing.md`）
 *
 * | 分项 | 规则 |
 * |---|---|
 * | 强相关 | @我 +60 · 提到我名字 +55 · 回复我 +35 · 私聊 +30 |
 * | 内容 | 有内容 −6.7/条 · @别人 +3/条 · 问句 +8.6 · 求助 −18.35 ·
 *   征求意见 +189.68 · 技术词 +5.29 · 长文 +8~12 |
 * | 复读 | 窗口里同样的文本 ≥3 条 → 每条 +6（复读机） |
 * | 压力 | **砍掉**（`maxPressure` 默认 0，见下） |
 * | 存在感 | `我 / (窗口 + 我)` 连续：**占比越高越该说**（正号）+296.36 |
 *
 * 合计后乘**纯倍率** `frequency`（默认 1，即不打折）。
 *
 * ## 为什么是这几个数（2026-10-13，方案 3）
 *
 * 原来的权重是**手拍的**。在它真正该干活的场景（`relevance==0`，即没有 @我/喊名字）
 * 的 2,413 个真实决策点上，**现用打分的 AUC 只有 0.4801 —— 比抛硬币还差**；
 * 而**同一套特征**做逻辑回归能到 **0.6246（5-fold）／0.6571（时间切分）**。
 * ⇒ **特征够用，是权重不对。**
 *
 * ⇒ 整组换成拟合系数（**先去共线**，全部 VIF 1.01~1.28 ⇒ 系数可解读）。
 * 数据：`_qq-judge/plan3-decollinear.py` → `_plan3.txt`；结论：`_qq-judge/FIT-RESULT.md`。
 *
 * 两条与直觉相反、但**用户 2026-10-13 明确拍板「跟着数据走」**的：
 *
 * 1. **存在感（自己最近发言占比）是正号** —— 它是整个模型里**唯一的主力**
 *    （去掉它 5-fold 从 0.625 掉到 0.542，掉了 0.083）。原来当"防话痨扣分"用，
 *    方向是反的。⚠️ 这意味着**放弃"用存在感压话痨"这个产品意图**，话痨控制
 *    交给别的环节（提示词 / `precheck`）。原因见 SPEC。
 * 2. **`substantive` / `helpHits` 是负号** —— 消融显示 `substantive` 贡献 ≈0（±0.0004）、
 *    `helpHits` 确实有贡献（−0.0054）但符号与现状相反。
 *
 * `pressure` **砍掉**：它与 `substantive` 是同一个量（r=0.957），拟合系数≈0，
 * 实测"打到 0 只降 1.5pp" ⇒ 基本是噪声。
 *
 * ⚠️ **拟合排除了所有 `relevance > 0` 的行** ⇒ 对上表"强相关"那一档**没有证据**，
 * 所以它**一个数都没动**（`replyToSelf` / 私聊 仍在 `score()` 里；@我/喊名字由闸门接管）。
 *
 * ## 两条"别只看字面"的规则
 *
 * 1. **短反应不是无条件 kill**：整窗都是「哈哈/666/嗯」这类时，只有**没人在跟我说话**
 *    才沉默（`mentioned`/`nameMentioned`/`replyToSelf`/私聊/我刚说过话 任一成立就放行）。
 *    同样一句「可以」，我刚问完就是回答、别人闲聊中间就是附和 —— 字面分不开，只能看上下文。
 * 2. **「有内容」不看字数**：去掉标点/emoji/空白之后还剩字符就算有内容。
 *    刻意**不维护任何词表**（用户否掉了词表方案：「难不成要拉一个表，把那些话都塞进去？有点笨了」）。
 */

/** 默认打分权重与阈值。 */
export function defaultGaugeConfig() {
  return {
    enabled: true,
    /** 判定窗口：看最近多少条消息（只用于内容评分）。 */
    lookback: 8,
    /**
     * 达到这个分才说话。
     *
     * **2026-10-07 从 16 提到 24**：真机实测（群里 4 条消息、小鲸鱼接了 3 条）
     * 用户判断「**确实接的太勤了**」。四条实测分是 `7.3 / 22.5 / 29.8 / 25` ——
     * 提到 24 后只剩后两条过线。
     *
     * **2026-10-13 重定：24 → 50**。权重整组换成拟合值 ⇒ **旧的 24 彻底失去意义**，
     * 用离线重放（`_qq-judge/sweep-plan3c.mjs`，三群 21,576 条真实消息）反推。
     *
     * 判据（三条同时满足，**只有 50 一个值满足**）：
     *   ① 合计回复率落进 **16~29%**（用户老 MaiBot 的真实表现区间）
     *   ② **每个群各自**落进它自己的参照区间（老库实测 16.1 / 27.4 / 29.3%）
     *   ③ `addressed` 恒 **1124**（结构性保全 —— 它在 `#gate` 短路，与打分无关）
     *
     * 最终：**合计 20.66%**（示例群 16.4% / psi 28.9% / 用力 28.4%）。
     * 扫描表、候选、为什么不是 24 ⇒ `_qq-judge/PLAN3-LANDING.md`。
     */
    threshold: 50,
    /**
     * 频率倍率（0–1）。**纯倍率**：`final = raw × frequency`。
     *
     * 默认 1（不打折）。旧写法是 `0.5 + 0.5 × frequency`，默认填 0.5 得到固定 0.75 ——
     * 那等于"阈值偷偷抬高 33%"，而 `frequency` 和 `threshold` 本来就是同一个旋钮的
     * 两种写法，多一层只会让人算不清（用户 2026-10-07 定：「倍率改成 1.0 × frequency，
     * 然后 frequency 改成 1」）。
     */
    frequency: 1,
    /**
     * 权重尺度：拟合系数是 **logit 尺度**（`selfRatio` 的 2.9636 说的是"占比从 0 涨到 1
     * ⇒ 对数几率 +2.96"），直接拿来当分数太小。乘这个数换算到原来那套 0~60 的尺度，
     * 好处是**阈值仍落在 20~30 这个熟悉的量级**里。
     */
    weightScale: 100,
    /**
     * 拟合系数（**logit 尺度**，见文件头的"为什么是这几个数"）。
     * 想调就改这里的数 —— 它们和 `weightScale` 一起决定打分。
     *
     * ⚠️ **2026-10-13 按用户拍板砍掉两项**（`helpHits` / `opinionHits`）：
     *
     * | 砍掉的 | 理由 |
     * |---|---|
     * | `opinionHits` | ① 出现率只 **1.12%**（罕见）· ② 消融 **−0.0002**（≈零贡献）· ③ **危险**：系数 +1.8968 × `weightScale` 100 = **命中一次 +190，而阈值才 50** ⇒ 那是给 1.12% 的消息开**自动放行后门**，不是"加权" |
     * | `helpHits` | **词表本身有毛病**（见 `HELP_TERMS` 的注释）：把泛疑问词当求助词、`怎么` ⊂ `怎么办` 子串重复计分、单字 `求` 太宽 ⇒ 它实际是"**泛疑问词表**"，命中时往往对应"别人自顾自讨论" ⇒ **负系数反而合理**。用户原话：「按道理应该是正的…说明这项写的有重大问题，和预期严重不符，我说砍了吧」 |
     *
     * ⚠️ **口径澄清（别记反）**：消融里 `helpHits` 是 **−0.0054**，意思是
     * **去掉它 AUC 掉 0.0054 ⇒ 它在微弱帮忙**，**不是"它掉 AUC"**。
     * **反常的是它的【系数符号】，不是它的贡献。**
     *
     * ⇒ 另外：**除了 `selfRatio`，其余各项的消融全部落在折间波动 ±0.017 之内**
     * （`opinionHits` −0.0002 / `substantive` +0.0004 / `repetition` +0.0005 /
     * `techHits` +0.0016 / `questions` +0.0023）⇒ **砍哪个都不影响结果**，
     * 不必为那 ±0.002 反复调。
     */
    fitWeights: {
      substantive: -0.0670,
      questions: +0.0860,
      techHits: +0.0529,
      selfRatio: +2.9636,
    },
    /**
     * 内容项的 logit **下限**。
     *
     * ⚠️ **为什么必须有这一条**（2026-10-13 实测踩到）：
     * `substantive`（−0.0670）是**负系数** ⇒ **任何一条消息都可能被内容项倒扣分**
     * （窗口里"有内容"的消息越多，扣得越狠，下限就是这条 `contentFitFloor`）。
     * 而**被点名那条路只靠 `relevance` 的 30~60 分撑着**。实测：
     *
     * ```
     * 「小鲸鱼这个你怎么看」  relevance 55 + 内容项 −25×100 ⇒ 30 分 ⇒ 阈值 50 ⇒ 【不回】
     * ```
     *
     * ⇒ 那就把「**喊了名字却不回**」这个老毛病又请回来了（旧实现专门为它写过注释）。
     * 现在：内容项夹在 `[contentFitFloor, +∞)`。
     *
     * ⚠️ **2026-10-13 03:2x 变更**：先前这里还有一条"被点名 ⇒ 不低于阈值"的**保底**，
     * 用户用真实反例（引用/@ 都可能只是吐槽）**拍板撤掉了** —— 现在严格按算出来的分走，
     * 被点名**不再**自带"必回"。见 `addressedFloor` 的注释。
     */
    contentFitFloor: -0.10,
    /**
     * **被点名时，允许"抬"到阈值的百分比**（0~1）。**默认 0 = 不抬，严格按算出来的分走。**
     *
     * ## ⚠️ 2026-10-13 03:2x：从 1.0 改成 0（用户给了真实反例）
     *
     * 先前的 1.0 是"**被点名（@我/喊名字/引用我/私聊）⇒ 不低于阈值**"的保底。
     * **用户拍板撤掉它**，原话：
     *
     * > 「**引用不一定回，我这边有一个刚刚发生的绝佳案例，"吕子翔"引用小鲸鱼的话单纯是为了吐槽**」
     *
     * 现场（用力到处扣扣群）：
     * ```
     * 小鲸鱼:   这两句吊胃口吊得挺足，正片呢
     * 吕子翔: [引用小鲸鱼那句] @小鲸鱼      → 小鲸鱼回「在呢，没掉线…」  ← 误判，他没在叫她
     * 吕子翔: 这两句吊胃口吊得挺足，正片呢  ← 【原话复制】纯吐槽 ⇒ 小鲸鱼没回 ✓ 对的
     * ```
     * **⇒ 引用 + @ 都可能只是吐槽 ⇒ 不能给"必回"保底。**
     *
     * 注意留 0 而不是删掉这个键：**它是个可调旋钮**（想恢复保底就设 1），
     * 而且 `score()` 里要靠它决定 `final` 走哪条路（见下）。
     */
    addressedFloor: 0,
    /**
     * 压力封顶。
     *
     * **2026-10-13 改成 0 = 砍掉这项**：`pressure` 与 `substantive` 的相关系数
     * **r = 0.957**（基本是同一个量），拟合系数≈0，实测打到 0 只降 1.5pp。
     * 想恢复这条曲线把 `maxPressure` 改回 25 即可（`pressureWeight` 也要改成 1，
     * 否则它会被乘成 0）。
     */
    maxPressure: 0,
    /** 存在感项封顶（占位，当前正号连续项不需要封顶）。 */
    maxPresencePenalty: 25,
    /**
     * 压力分从第几条消息开始累积。
     *
     * 取 0：单条消息给 1.25 分，光靠压力永远说不出一句话，但"攒起来"会线性变响。
     */
    pressureFloor: 0,
    /**
     * 压力**饱和点**（到这条数就满 25 分）。
     *
     * 从 4 改成 20（2026-10-07 用户原话：「我没看懂为啥你第四条开始就满了」）——
     * 30 分钟内群里说 4 句话就算压力拉满，没道理。现在：
     * `pressure = 25 × n / 20`，光靠压力要 **n ≈ 13** 才够阈值 16 —— 得真的热闹。
     */
    pressureFull: 20,
    /**
     * `pressure` 项的倍率（0 = 砍掉，见 `maxPressure`）。
     * 单独留一个旋钮，是为了让扫描脚本能只动它、不动曲线本身。
     */
    pressureWeight: 0,
    /** 我最近发言占比低于这个值不扣分。 */
    selfRatioFree: 0.25,
    /** 我最近发言占比达到这个值扣满。 */
    selfRatioFull: 0.6,
    /**
     * 兜底措辞 —— **只在没有语言层可用时**才会用到。
     *
     * 设计上"说什么"应该由语言层（小鲸鱼，跑在 DSH 会话里、挂着 persona）生成，
     * 这样口吻永远一致；判定层只决定"说不说、往哪个方向说"。
     * 这对应 MaiBot 的 BrainChatting（思考/方向）与 HeartFChatting（语言/人格）分离。
     *
     * 这里保留模板是为了**语言层不可用时退化成一句能看的话**，而不是整条插话消失。
     * 措辞刻意口语、"像群里随口接一句"，不要写成客服腔。
     */
    templates: ['这个我看看', '诶这个我知道', '我瞅瞅'],
  };
}

/** 求助/疑问类词（内容分）。 */
const HELP_TERMS = [
  '怎么', '如何', '为什么', '为啥', '求', '帮忙', '求助', '有没有人', '谁知道', '怎么办',
  '报错', '失败', '不会', '卡住', '救命', '教教', '指教', '请问',
];

/** 征求意见类词。 */
const OPINION_TERMS = ['你觉得', '你认为', '咋看', '有什么建议', '好不好', '行不行', '可以吗'];

/** 技术/兴趣领域词 —— 让"聊技术"也能得分，而不是只认求助。 */
const TECH_TERMS = [
  'qq', '机器人', 'bot', 'napcat', 'onebot', 'api', '代码', '脚本', '程序', '函数',
  'python', 'javascript', 'node', 'docker', 'linux', 'windows', '服务器', '数据库', 'git',
  'ai', '模型', '提示词', 'prompt', '插件', '部署', '编译', '端口', '进程', '内存',
];

/** 纯短反应：整窗都是这类内容就不该插话。 */
const SHORT_REACTIONS = new Set([
  '哈哈', '哈哈哈', '草', '笑死', '好', '嗯', '啊', '哦', '6', '666', '?', '？',
  '。。。', '...', '喵', 'az', '收到', '好的',
]);

/** 明确的"别说话"信号，命中即无条件沉默。 */
const STAY_OUT_TERMS = ['别说话', '闭嘴', '别插嘴', '不用你', '没问你', '滚'];

const QUESTION_MARKS = /[?？]/;

/**
 * 「不算内容」的字符：标点 `\p{P}` · 符号 `\p{S}`（emoji 在这一类）·
 * 格式控制符 `\p{Cf}`（含零宽连接符 U+200D）· 圈选符 `\p{Me}` · 变体选择符 · 空白。
 *
 * 拿它把文本"擦"一遍，剩下的就是实义字符（汉字/字母/数字）。见 `hasContent`。
 */
const PUNCT_ONLY_RE = /[\p{P}\p{S}\p{Cf}\p{Me}\uFE0E\uFE0F\s]/gu;

/**
 * 是否像在问问题。
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeQuestion(text) {
  const t = String(text ?? '').trim();
  if (t === '') return false;
  if (QUESTION_MARKS.test(t)) return true;
  // 「…吗 / …呢」结尾通常也是问句。长度下限取 3：
  // 「然后呢」「在哪呢」这类三字追问很常见，卡 4 会漏掉它们。
  return t.length >= 3 && /[吗呢]$/.test(t);
}

/**
 * 是否是「整窗都是短反应」的批次。
 *
 * ⚠️ **它只是文本层面的判断，不再是"沉默"的充分条件。**
 * 2026-10-07 之前，命中即无条件沉默；现在由 `score()` 加上下文条件：
 *
 * ```
 * 整窗都是短反应 且 没人跟我说话 且 没有复读  → 才沉默
 * ```
 *
 * 根因（用户 2026-10-06 的原话场景）：同样一句「可以」，**我刚问完就是回答（该回）**，
 * **别人互相聊中间就是附和（不该回）**。字面上分不开，只能看"有没有人在跟我说话"。
 *
 * @param {Array<{text?: string}>} window
 * @returns {boolean}
 */
export function isShortReactionBatch(window) {
  const texts = (Array.isArray(window) ? window : [])
    .map((m) => String(m?.text ?? '').trim())
    .filter((t) => t !== '');
  if (texts.length === 0) return true;
  return texts.every((t) => SHORT_REACTIONS.has(t) || t.length <= 2);
}

/**
 * 「这条消息去掉标点 / 符号（含 emoji）/ 格式控制符 / 空白之后，还剩不剩字符」。
 *
 * 这就是旧的 `text.trim().length >= 4` 那个魔数的替代品 —— **一个正则，不是词表**。
 * 用户 2026-10-06 否掉了词表方案：「难不成要拉一个表，把那些话都塞进去？有点笨了，
 * 而且如果想办法更新其中内容，要么后台手搓、要么负责对话的会话来搞，问题是它现在默认
 * 没推理能力，感觉徒增工作量吃力不讨好。」
 *
 * 效果：`何意味`（3 字）拿基础分 ✅ · `可以` / `不行` / `是的` **也**拿基础分 ——
 * 但没关系：整窗都短时仍会被 `isShortReactionBatch` 拦住，而"有人跟我说话"时本来就该回。
 *
 * 细节：`\p{Cf}`（含 ZWJ）与 `\uFE0E/\uFE0F`（变体选择符）、`\p{Me}`（圈选符）
 * 也要去掉 —— 否则 `❤️` 会因为残留一个 U+FE0F 被当成"有内容"。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasContent(text) {
  return String(text ?? '').replace(PUNCT_ONLY_RE, '') !== '';
}

/** 复读机起算条数：窗口里同样的文本出现几条才算"在复读"。 */
export const REPEAT_MIN_COUNT = 3;
/** 复读机每条加多少分。 */
export const REPEAT_POINTS = 6;

/**
 * 复读机：窗口内**同样的文本 ≥ 3 条**时，这些消息**每条 +6**。
 *
 * 「一样」的口径是 `trim` 后**严格相等**（只去首尾空白；标点、大小写不归一）——
 * 用户 2026-10-07 定稿。窗口沿用 `lookback`（默认 8 条）。
 *
 * 为什么单独一项而不塞进 `content`：复读是"群里在玩梗"的信号，与"这条有没有内容"
 * 是两件事；分开也便于以后单独调它。
 *
 * 注：纯空白文本不计入（否则一串空消息会互相"复读"）。
 * ⚠️ 占位符（`[图片]` / `[合并转发]`）目前**照常参与**计数 —— 这是有意的（不因缺描述而误降分）。
 * 的"已知取舍"。
 *
 * @param {Array<{text?: string}>} window
 * @returns {{messages: number, points: number}} `messages` = 参与复读的消息条数
 */
export function repetitionScore(window) {
  const counts = new Map();
  for (const m of Array.isArray(window) ? window : []) {
    const text = String(m?.text ?? '').trim();
    if (text === '') continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  let messages = 0;
  for (const n of counts.values()) {
    if (n >= REPEAT_MIN_COUNT) messages += n;
  }
  return { messages, points: REPEAT_POINTS * messages };
}

/**
 * 窗口里「我说了几次」。
 *
 * 两个来源相加：
 *   1. 转录里真的带了 `fromSelf` 的条目（历史形态/兜底）；
 *   2. 引擎传来的**发言时间戳数组**（`request.selfAt`）中落在窗口时间跨度内的那些。
 *
 * 为什么需要 ②：小鲸鱼自己的消息**根本不进转录**（`engine.decide` 在 `transcript.push`
 * 之前就对 `fromSelf` 提前 return 了），所以旧实现里 `selfRatio` 恒为 0 →
 * **存在感惩罚是死代码**（2026-10-07 查实）。转录一个字不动，改由引擎把时间戳带进来。
 *
 * @param {Array<{fromSelf?: boolean, at?: number}>} window
 * @param {unknown} selfAt 机器人最近若干次发言的时间戳
 * @returns {number}
 */
export function selfCountInWindow(window, selfAt) {
  let count = window.filter((m) => m?.fromSelf === true).length;
  const times = Array.isArray(selfAt) ? selfAt.filter((t) => Number.isFinite(t)) : [];
  if (times.length === 0) return count;
  const stamps = window.map((m) => Number(m?.at)).filter((t) => Number.isFinite(t));
  if (stamps.length === 0) return count;
  const from = Math.min(...stamps);
  const to = Math.max(...stamps);
  for (const t of times) {
    if (t >= from && t <= to) count += 1;
  }
  return count;
}

function countOccurrences(text, terms) {
  const lower = String(text ?? '').toLowerCase();
  let n = 0;
  for (const term of terms) {
    if (lower.includes(term.toLowerCase())) n += 1;
  }
  return n;
}

/**
 * 压力分：**一条直线 + 封顶**。
 *
 * `pressure = maxPressure × clamp((n − floor) / (full − floor), 0, 1)`
 *
 * 2026-10-07 改。旧的实现是两段拼接（阈值内二次、超阈值转对数），接缝处**断了**：
 * `pressureFull = 4` 时 n=4 是满分 25，n=5 只有 10.2 —— **多一条消息反而更不想说话**，
 * 而那段区间恰恰最常用。用户原话：「pressure 数值的话先搞个一次函数糊弄吧」。
 */
function pressureScore(messageCount, cfg) {
  const floor = Number.isFinite(Number(cfg.pressureFloor)) ? Number(cfg.pressureFloor) : 0;
  const full = Number(cfg.pressureFull);
  const max = Math.max(0, Number.isFinite(Number(cfg.maxPressure)) ? Number(cfg.maxPressure) : 25);
  if (!Number.isFinite(full) || full <= floor) return 0;
  const ratio = (Number(messageCount) - floor) / (full - floor);
  return max * Math.min(1, Math.max(0, ratio));
}

/**
 * 存在感惩罚：我最近说得越多，越不该再说。
 *
 * ⚠️ **2026-10-13 起打分不再调用它** —— 拟合显示 `selfRatio` 的系数是**正号**
 * （+2.9636，整个模型里唯一的主力），用户拍板「跟着数据走」（见文件头）。
 * ⇒ 现在用的是 `presence`（加分），不再有"惩罚"这个语义。
 *
 * 函数本身留着，因为它是旧行为的**参考实现**（想恢复"用存在感压话痨"时照着改回来），
 * 也便于对照读旧日志。
 *
 * @param {number} selfRatio 我占"窗口 + 我"的比例（见 `selfCountInWindow`）
 */
function presencePenalty(selfRatio, cfg) {
  const free = Number(cfg.selfRatioFree);
  const full = Number(cfg.selfRatioFull);
  const max = Math.max(0, Number(cfg.maxPresencePenalty) || 25);
  if (!Number.isFinite(selfRatio) || selfRatio <= free) return 0;
  if (selfRatio >= full) return max;
  return max * ((selfRatio - free) / (full - free));
}

/**
 * 算一次"回复必要性"。
 *
 * @param {object} request
 * @param {Array<{text?: string, fromSelf?: boolean, userId?: string, at?: number,
 *   mentionsOthers?: boolean}>} request.recent
 * @param {string} [request.kind] `'group'` | `'private'`
 * @param {boolean} [request.mentioned] 是否 @ 了我
 * @param {boolean} [request.replyToSelf] 是否回复了我的消息
 * @param {boolean} [request.nameMentioned] 是否提到了我的名字
 * @param {number[]} [request.selfAt] 机器人最近若干次发言的时间戳（含被动回复）
 * @param {boolean} [request.botSpokeRecently] 机器人是否刚说过话（专注窗口内）
 * @param {number} [request.declineBonus] **攒劲儿加分**（第 6 项，2026-10-14）——
 *   由引擎算好带进来（它才知道"闸门放行过几次、距上次计数多久"）。
 *   见 `defaultTriggerConfig().decline_bonus`（`src/proactive/engine.mjs`）。
 * @param {object} [request.gaugeOverrides] **按群的打分配置覆盖**（2026-10-16）——
 *   由引擎从 `this.#cfgFor(chatId).gauge` 带进来。**优先级最高**（见下面 `cfg` 那行）。
 *   例：`[proactive.groups."30000013".gauge] contentFitFloor = -0.30` 让示例群保住旧地板。
 * @param {object} [options]
 * @param {object} [options.config]
 * @returns {{score: number, threshold: number, speak: boolean, detail: object}|null}
 *   配置关闭、窗口为空、命中"别说话"、整窗短反应**且没人跟我说话** → 返回 null（表示"不说"）。
 */
export function score(request, { config } = {}) {
  // ⚠️ 2026-10-16：**按群的覆盖**（`request.gaugeOverrides`）优先级**最高** —— 排在全局配置之后，
  // 理由和引擎里 `#cfgFor` 一样："我改了那个群的门槛可它没变"是最难查的一类。
  //
  // 为什么要有这一层：在这之前 `gauge` 的配置**全局只有一份**
  //（`index.mjs` 的 `resolveConfig` 里 `gauge: {...}` 没有任何按群入口），
  // 而引擎的 `overrides` 只作用于**闸门/配额**那一半 ⇒ 留下这个缺口：
  // **"按群覆盖能改冷却和阈值，却改不了打分本身"。**
  // 用户 2026-10-16 要的"负分全改、除了示例群"正好撞上它 ⇒ 顺手把缺口补上。
  const cfg = { ...defaultGaugeConfig(), ...(config ?? {}), ...(request?.gaugeOverrides ?? {}) };
  if (!cfg.enabled) return null;

  const all = Array.isArray(request?.recent) ? request.recent : [];
  const lookback = Math.max(1, Number(cfg.lookback) || 8);
  const window = all.slice(-lookback);
  if (window.length === 0) return null;

  const joined = window.map((m) => String(m?.text ?? '')).join('\n');

  // 明确要求安静：无条件沉默。
  for (const term of STAY_OUT_TERMS) {
    if (joined.includes(term)) return null;
  }

  const isPrivate = request?.kind === 'private';
  const mentioned = request?.mentioned === true;
  const replyToSelf = request?.replyToSelf === true;
  const nameMentioned = request?.nameMentioned === true;
  /**
   * 被点名 = 别人**明确在找小鲸鱼**（@我 / 喊名字 / 引用回复我 / 私聊）。
   * 两处用它：短反应的豁免，以及"被点名保底"（`addressedFloor`）。
   *
   * ⚠️ **`replyToSelf` 必须在这里**（2026-10-13 补）：`protocol.mjs` L452 把
   * 「引用回复我」并进了 `mentioned`，**但引擎的 `#gate`（`engine.mjs` L617-618）
   * 只认 `mentioned / 私聊 / 喊名字`，不认 `replyToSelf`** ⇒ 一条"引用我但没 @"
   * 的消息会**走到打分这一层**。而这一层里它只靠 `relevance` 的 **+35** —— 在阈值 50 下
   * 本来就够不着，再被内容项一扣就彻底沉底 ⇒ **"我刚说的那句被引用，却装死"**。
   *
   * （顺带记一笔历史：在手拍权重下 `+35` 也几乎没用 —— `helpHits +36` 与
   *  `opinionHits +30` 正好把 `+35` 抵掉，≈ 0 分。**那是"抵消出来的假死代码"**。
   *  现在 `helpHits` / `opinionHits` 都砍了，这条路的生死**完全**取决于它。）
   */
  const addressed = mentioned || nameMentioned || replyToSelf || isPrivate;
  /** 我刚说过话（引擎传下来）—— 也是"有人在跟我说话"的一种。 */
  const botSpokeRecently = request?.botSpokeRecently === true;

  // ---- 复读机（2026-10-07 新增）
  //
  // 放在短反应判断之前：整窗都是短反应会一刀 kill，**但复读命中时豁免** ——
  // 群里连着刷同一句话恰恰是该接的时候，而那种内容通常极短。
  const repeat = repetitionScore(window);

  // ---- 纯短反应批次：**有条件**沉默
  //
  // 从"无条件 kill"改成"有条件 kill"（2026-10-07）：只在**没人跟我说话**、
  // 也不是在复读时才沉默。整窗「哈哈/666」而有人 @ 我，当然还是要回。
  const shortBatch = isShortReactionBatch(window);
  const someoneTalkingToMe = addressed || botSpokeRecently;
  if (shortBatch && !someoneTalkingToMe && repeat.points === 0) return null;

  // ---- 强相关
  let relevance = 0;
  if (mentioned) relevance += 60;
  else if (nameMentioned) relevance += 55;
  else if (replyToSelf) relevance += 35;
  else if (isPrivate) relevance += 30;

  // ---- 内容
  //
  // **基线分**是用户反馈后加的：原先只有"求助/技术/问句"才有分，于是
  // 「今天好累啊」这种再正常不过的闲聊恒为 0 分 —— 小鲸鱼永远接不上话，
  // 那就不像群里的人了。用户原话：「没必要一定要求助之类的吧」。
  //
  // 门槛从"数字数"（`length >= 4`）改成"**去掉标点和 emoji 之后还剩不剩字符**"
  // （2026-10-07，见 `hasContent`）—— 一个正则取代一个魔数，且不依赖任何词表。
  const questions = window.filter((m) => looksLikeQuestion(m?.text)).length;
  const helpHits = countOccurrences(joined, HELP_TERMS);
  const opinionHits = countOccurrences(joined, OPINION_TERMS);
  const techHits = countOccurrences(joined, TECH_TERMS);
  const longest = window.reduce((n, m) => Math.max(n, String(m?.text ?? '').length), 0);
  /**
   * `@` 了**别人**的消息（2026-10-07 定）：在 content 里只算 **+3**，
   * 不再按"有内容"给基础分。用户原话：「别人 @ 别人和小鲸鱼关系太小了，
   * content 那边 +3 分算了，一般情况下不吭声，只有之前各种分攒多了才会说一声」。
   *
   * 标记由 `protocol.mjs` 的 `normalizeEvent` 打在消息上（`mentionsOthers`），
   * 所以这一条对**窗口里每一条**都成立，而不只是触发的那条。
   *
   * ⚠️ 口径是「@ 的**不是小鲸鱼**」——`@小鲸鱼 @黑猫 你们看看` 这种同时 @ 了我的，
   * 强相关那 60 分已经拿了，内容也该照常算；只有"整条都不是冲我来的"才压到 +3。
   */
  const atOtherOnly = (m) => m?.mentionsOthers === true && m?.mentioned !== true;
  const atOthers = window.filter(atOtherOnly).length;
  const substantive = window.filter(
    (m) => !atOtherOnly(m) && hasContent(m?.text),
  ).length;

  // ---- 内容：按拟合系数加权（2026-10-13）
  //
  // 2026-10-13 之前这里是 `+46/+36/+30/+18` 那一套**手拍**的加法（`content` 累计到
  // 144 分）。现在整组换成拟合系数 —— 口径也变了：
  // `substantive` / `questions` / `helpHits` / `opinionHits` / `techHits` 在拟合里
  // 都是**次数**（不是"有没有"）⇒ 不再封顶。
  // 拟合表里没有 `longest`（长文）和 `atOthers`（@别人）这两个特征 ⇒ 那两项**没有证据**，
  // 原样保留（量级小，不影响大局）。
  const w = { ...defaultGaugeConfig().fitWeights, ...(cfg.fitWeights ?? {}) };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  /**
   * 内容项（拟合加权）。
   *
   * ⚠️ 2026-10-13 砍掉 `helpHits` / `opinionHits` 两项（理由见 `fitWeights` 的注释）
   * ⇒ **现在只剩三个特征**：`substantive`（负）、`questions`（正、很小）、
   * `techHits`（正、很小）。
   * ⚠️ 这也意味着：**没有任何一个内容特征能单独把分推过阈值** ——
   * 主动插话实际上主要靠**存在感**（`selfRatio`）那一项。见文件头的口径说明。
   */
  const contentFitRaw =
    num(w.substantive) * substantive
    + num(w.questions) * questions
    + num(w.techHits) * techHits;
  const contentFit = Math.max(num(cfg.contentFitFloor === undefined ? -0.10 : cfg.contentFitFloor), contentFitRaw);
  /** 历史项（不在拟合表里）：@别人 +3/条 · 长文 +8/+12。 */
  const contentLegacy = 3 * atOthers + (longest >= 80 ? 12 : longest >= 25 ? 8 : 0);

  // ---- 压力（2026-10-13：默认 `maxPressure = 0` ⇒ 恒为 0，等于砍掉）
  //
  // 用**完整窗口**计数，不用被 `lookback` 截断的那个子窗：
  // 内容评分只看最近几条就够了，但"多少人攒着话"该反映真实积压量。
  // `pressureWeight` 是额外的倍率旋钮（扫描脚本用它单独关掉这一项）。
  const pressure = pressureScore(all.length, cfg) * num(
    cfg.pressureWeight === undefined ? 1 : cfg.pressureWeight,
  );

  // ---- 存在感（2026-10-13：从"扣分"改成"加分"，见文件头第 1 条）
  //
  // 占比口径是 `我 / (窗口 + 我)`：转录里根本没有小鲸鱼自己的消息（`fromSelf` 提前
  // return），分母只用窗口的话，分子一变大就会出现"占比 > 100%"这种没意义的数。
  //
  // ⚠️ 被明确点名（@ / 喊名字 / 回复 / 私聊）时**不算这一项** —— 那是别人在找小鲸鱼，
  // 不是小鲸鱼主动插话。原来这条豁免是为了"别误伤喊了名字却不回"，现在语义变了
  // （加分项不参与），但豁免的道理没变，所以照旧保留。
  const selfCount = selfCountInWindow(window, request?.selfAt);
  const total = window.length + selfCount;
  const selfRatio = total === 0 ? 0 : selfCount / total;
  const presence = addressed ? 0 : num(w.selfRatio) * selfRatio;

  // ---- 合计
  //
  // ⚠️ **只把"拟合出来的项"乘 `weightScale`**：
  //   · `relevance`（60/55/35/30）和两个历史项（@别人 / 长文 / 复读）**一个数都没动** ——
  //     拟合**排除了所有 `relevance > 0` 的行**，对它**没有证据** ⇒ SPEC 明确要求"不动"
  //     （把它也乘 100 等于凭空给它安排一个权重）。
  //   · 拟合项（内容 5 个 + 存在感 1 个）是 logit 尺度 ⇒ 乘 `weightScale` 换算到分数尺度。
  // （另注：历史项乘不乘 K 其实**不影响取舍**，只影响阈值落在哪个数上 ——
  //   因为它对所有样本是同一个常数/同尺度偏移。放在外面纯粹为了"别动没证据的东西"。）
  const logitRaw = contentFit + presence;
  const raw = logitRaw * num(cfg.weightScale === undefined ? 100 : cfg.weightScale)
    + relevance + contentLegacy + repeat.points + pressure;
  /**
   * ---- **第 6 项：「攒劲儿」加分**（2026-10-14）
   *
   * 「判定了但她没说」每攒够一次就 +`decline_bonus` 分（封顶 `decline_bonus_cap`），
   * 引擎算好之后通过 `request.declineBonus` 带进来（**它才知道"闸门放行过几次、
   * 距上次计数多久"** —— 打分层是纯函数、看不到跨消息的状态，也不该看到）。
   *
   * ## 为什么它能打破"结构性反馈锁"
   *
   * `presence` 只有在小鲸鱼自己刚说过话时才非零，而内容项触到地板时
   * 非被点名消息的上界是 `contentFit(−30) + legacy(≤23) + repetition(≤42) < 50`
   * ⇒ 她**必须是"已经在说话"才可能说话**（2026-10-14 诊断，用力群 12 小时 23 条
   * 一条都没到 30 分）。这一项是**唯一一个只看"时间在推进"、不看她说过话**的正项
   * ⇒ 一直沉默 ⇒ 它一直涨 ⇒ 最终必然过线 ⇒ 她开口 ⇒ 引擎把计数归零。
   *
   * ## 三条口径（写死在这里，别在别处再算一遍）
   *
   * 1. **加在 `raw` 里、参与 `>= threshold` 判定** —— 这是"加在打分层的 content 上"
   *    而不是"闸门欠账"（账本 §4.2 那个悬案的答案，理由见任务报告）。
   *    加在阈值判定**之外**的话，分涨了却永远不会说话 —— 等于没实现。
   * 2. **在 `multiplier` 之前**：和其余各项同尺度（`frequency` 是"整体打折"，
   *    攒劲儿不该是唯一一个免打折的项）。
   * 3. **被点名的保底（`addressedFloor`）作用在含攒劲儿的 `raw` 上**：保底本来就是
   *    `max(raw, threshold×floor)`，攒劲儿只是把 `raw` 抬高 —— 不会互斥。
   *
   * ⚠️ **不配 `declineBonus` 时恒为 0** ⇒ `score()` 的行为与改动前**逐字一致**
   * （既有测试与所有不传它的调用点都不受影响）。
   */
  const declineBonus = Math.max(0, num(request?.declineBonus));
  const rawWithBonus = raw + declineBonus;
  /**
   * **被点名的"抬分"上限**（见 `addressedFloor` 的注释）。
   * ⚠️ 用的是外层的 `addressed`（@我 / 喊名字 / 引用我 / 私聊），不是"分高"。
   *
   * **2026-10-13 03:2x：默认值改成 0 ⇒ 这条保底默认【不生效】**（用户给了反例：
   * 引用/@ 都可能是吐槽）。旋钮留着，设成 1 就恢复"被点名必回"。
   */
  const addressedFloor = num(cfg.addressedFloor === undefined ? 0 : cfg.addressedFloor);

  // 倍率：0–1 的纯倍率。`null` / `undefined` / 空串当"没配"处理（配置分层里很常见），
  // 退回默认的 1 —— 否则 `frequency: null` 会被 `Number(null) === 0` 静音掉。
  const rawFrequency = cfg.frequency;
  const unset = rawFrequency === null || rawFrequency === undefined || rawFrequency === '';
  const frequency = unset
    ? 1
    : Math.min(1, Math.max(0, Number.isFinite(Number(rawFrequency)) ? Number(rawFrequency) : 1));
  const multiplier = frequency;
  const threshold = Number(cfg.threshold) || 50;
  const scale = num(cfg.weightScale === undefined ? 100 : cfg.weightScale);
  /**
   * `final` 的口径（**判定只有一个条件：`final >= threshold`**）：
   *
   * ```
   * addressedFloor > 0 且被点名 ⇒ final = max(raw + 攒劲儿, threshold × addressedFloor)
   * 否则                        ⇒ final = raw + 攒劲儿
   * ```
   *
   * ⚠️ 写成 if/else 而不是 `Math.max(raw, addressed ? … : -Infinity)`：
   * 后者在**没被点名**时会算出 `-Infinity × multiplier`，再 `Math.max(0, -Infinity)`，
   * 虽然结果也是 0，但表达式本身在语义上"把 raw 丢掉了"，容易读错。
   */
  const floor = addressed ? threshold * addressedFloor : 0;
  const final = Math.max(0, (floor > 0 ? Math.max(rawWithBonus, floor) : rawWithBonus) * multiplier);

  return {
    score: Math.round(final * 10) / 10,
    threshold,
    speak: final >= threshold,
    detail: {
      relevance,
      /**
       * **本次生效的攒劲儿加分**（0 = 没配或还没攒到）。
       * 放在 `detail` 里是为了让 `d_bonus` 那条 journal 能与打分对账
       * —— 引擎会把同一个数写进 `d_bonus`（它算的，这里是它加进去的）。
       */
      declineBonus: Math.round(declineBonus * 10) / 10,
      /**
       * 内容项合计（2026-10-13 起 = 拟合加权后的分 + 两个历史项），
       * **单位与分数同尺度**（weightScale 已乘进去）。
       */
      content: Math.round((contentFit * scale + contentLegacy) * 10) / 10,
      /** 内容项的 logit 原值（拟合尺度）—— 排查"为什么这项给了这么多"时看它。 */
      contentFit: Math.round(contentFit * 1000) / 1000,
      pressure: Math.round(pressure * 10) / 10,
      repetition: repeat.points,
      /** 存在感项（**正号**：占比越高越该说）。2026-10-13 前这里叫 `penalty`、是负的。 */
      presence: Math.round(presence * scale * 10) / 10,
      weightScale: scale,
      multiplier: Math.round(multiplier * 100) / 100,
      questions,
      helpHits,
      opinionHits,
      techHits,
      substantive,
      atOthers,
      contentLegacy,
      repeatMessages: repeat.messages,
      selfCount,
      selfRatio: Math.round(selfRatio * 100) / 100,
      messages: window.length,
      shortBatch,
      botSpokeRecently,
    },
  };
}

/**
 * 判定并给出要说什么 —— 引擎的 gauge 接口。
 *
 * 与旧实现同样返回 `{text}` 或 `null`，但依据从"关键词计数"换成打分。
 *
 * @param {object} request
 * @param {object} [options]
 * @param {object} [options.config]
 * @param {() => number} [options.random]
 * @returns {{speak: boolean, text?: string, score: number, threshold: number, detail: object}|null}
 *   返回 `null` 表示**压根没打分**（窗口为空 / 命中"别说话" / 打分关闭）；
 *   打了分但不够阈值时返回 `{speak: false, score, threshold}` —— 分数照样报上去，
 *   否则判定日记里只剩 `null`，"差多少分"这个最该看的数就没了。
 */
export function judge(request, { config, random = Math.random } = {}) {
  const result = score(request, { config });
  if (result === null) return null;
  if (!result.speak) {
    return { speak: false, score: result.score, threshold: result.threshold, detail: result.detail };
  }
  const cfg = { ...defaultGaugeConfig(), ...(config ?? {}) };
  const templates =
    Array.isArray(cfg.templates) && cfg.templates.length > 0
      ? cfg.templates
      : defaultGaugeConfig().templates;
  const index = normalizeIndex(random(), templates.length);
  // `threshold` 一并带出去：它决定"说不说"，是排查「为什么没冒泡」时第一个要看的值。
  return {
    speak: true,
    text: templates[index],
    score: result.score,
    threshold: result.threshold,
    detail: result.detail,
  };
}

/**
 * 兼容旧名：数一数命中多少"求助/疑问"信号。
 *
 * 保留是因为调试与旧测试还在用；**判定本身已不再依赖它**。
 *
 * @param {Array<{text?: string, userId?: string}>} window
 * @returns {{hits: number, distinctSenders: number}}
 */
export function countSignals(window) {
  const list = Array.isArray(window) ? window : [];
  let hits = 0;
  for (const m of list) {
    const text = String(m?.text ?? '');
    if (countOccurrences(text, HELP_TERMS) > 0) hits += 1;
    if (looksLikeQuestion(text)) hits += 1;
  }
  const senders = new Set(list.map((m) => String(m?.userId ?? '')).filter((s) => s !== ''));
  return { hits, distinctSenders: senders.size };
}

/**
 * 模板下标取整。
 * @param {number} value 0–1 的随机数
 * @param {number} length 模板数量
 */
export function normalizeIndex(value, length) {
  const n = Math.max(1, Number(length) || 1);
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  return Math.min(n - 1, Math.max(0, Math.floor(v * n)));
}

/** 旧名兼容（老代码/调试脚本引用 SIGNALS）。 */
export const SIGNALS = Object.freeze({ HELP: HELP_TERMS, STAY_OUT: STAY_OUT_TERMS });
