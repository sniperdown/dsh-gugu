/**
 * 「什么上下文发什么表情」—— **挑的先验**（语境 → 2~4 个候选桶）。
 *
 * ## 这一层是什么、不是什么（先把边界说死）
 *
 * **是**：一张**从 13320 条真实配对算出来的** lift 表，加一个**纯函数**
 * （给一段语境文本 → 返回 2~4 个候选桶）。
 *
 * **不是**：「自动挑一张发出去」。**那是下一批，而且是产品决定**（骰子还是视觉）——
 * 本模块**不查库、不随机、不发消息**，只把"该往哪几个桶看"缩下来。
 * `sticker-library.mjs` 那边有一条测试专门断言库里没有 `pick`/`random`；
 * 这里同样一个副作用都没有（纯函数 + 冻结常量）。
 *
 * ## 数据来源（可复核）
 *
 * `shared/表情包-2026-10-08/emoji2-context.txt` 的 §4.3 lift 表：
 *
 * ```
 * lift = P(桶 | 语境) / P(桶 | 全体)
 * ```
 *
 * 样本 = 小鲸鱼**真实发出去的 16820 次**表情包里，能跟 `action_records` 的
 * `action_data.reason`（模型自己写的理由）+ 前 5 条前文**配对上**的 **13320 条（79.2%）**。
 * 表里只收 **lift ≥ 1.4 且 n ≥ 15** 的项 —— 阈值是报告定的，本模块照抄不重算。
 *
 * ## ⚠️ 三条必须跟着表一起看的边界（报告 §4.1 / §4.3 明写的）
 *
 * 1. **配对是"同 chat_id + 就近时间窗"的最近邻，不是外键**（库里没有外键）。
 *    ⇒ 百分比**带这个噪声**。
 * 2. **`reason` 是"给这个动作打分的说明"，不是决策日志**（13185 条 emoji 动作全部
 *    `action_done=1`，其中 99 条理由写着"故选择不执行任何动作"）。所以它是**语境线索**，
 *    不能当"发/不发"的判据。
 * 3. **两条语境在数据里没有显著偏好**（`图片/表情包回应` n=13319、
 *    `工作/学习/日常吐槽` n=823）—— 它们被**显式排除**在 {@link CONTEXT_PRIORS} 之外，
 *    见 {@link CONTEXT_WITHOUT_SIGNAL}。**别给它们编一个先验**。
 *
 * ## ⚠️ 名字统一：`关心安慰` → `治愈陪伴`
 *
 * `emoji2-context.txt` 的 lift 表里写的是「关心安慰」，而**定稿的枚举名是「治愈陪伴」**
 * （同一份报告 §2.3 说"已统一"，映射表 `emoji2-enum-map-v4.json` 里用的就是后者）。
 * 本模块**一律用 `治愈陪伴`** —— 这是那个统一动作在代码里的落点。
 * 若哪天真去 grep "关心安慰"，在 `emoji2-context.txt` 里还能看到它，那是历史文本，不是枚举。
 *
 * @module qq-gugu/sticker-context
 */

import { isStickerTag, STICKER_TAG_COVERAGE } from './sticker-tags.mjs';

/**
 * 语境 → 桶 的 lift 表（**只收 lift ≥ 1.4 的项**，每个语境内按 lift 降序）。
 *
 * `keywords` = 用来判"这段语境文本属不属于这个语境"的中文关键词。
 * 它们是**从报告 §4.2 那张交叉表的"语境"名字拆出来的**（那 12 行本身就是
 * "在 reason 里命中"的关键词分组），不是我们新想的。
 *
 * ⚠️ **关键词是按"包含"匹配的纯中文串**：`text.includes(kw)`。
 * 没做分词（这个项目没有分词器，硬上一个只会引入新的不确定性）。
 * 代价：`梗` 这种单字会误命中（"梗概"），所以**关键词表刻意不放大宽的单字**
 * —— 唯一例外见 `玩笑/调侃`（那一行的 lift 本来就只有 1.41，误命中的代价最小）。
 *
 * @type {ReadonlyArray<{id: string, keywords: readonly string[], buckets: ReadonlyArray<{tag: string, lift: number, n: number}>}>}
 */
export const CONTEXT_PRIORS = Object.freeze([
  Object.freeze({
    id: '困惑/看不懂',
    keywords: Object.freeze(['困惑', '看不懂', '没看懂', '不明白', '不理解', '迷惑', '懵逼', '不解', '啥意思', '什么意思']),
    // 最强的一条：看懂 → 困惑不解，几乎没有例外（lift 4.14）
    buckets: Object.freeze([
      Object.freeze({ tag: '困惑不解', lift: 4.14, n: 304 }),
      Object.freeze({ tag: '生气不满', lift: 1.91, n: 34 }),
      Object.freeze({ tag: '无语无奈', lift: 1.88, n: 192 }),
      Object.freeze({ tag: '尴尬社死', lift: 1.71, n: 76 }),
      Object.freeze({ tag: '吃瓜围观', lift: 1.42, n: 35 }),
    ]),
  }),
  Object.freeze({
    id: '无语/无奈/尴尬',
    keywords: Object.freeze(['无语', '无奈', '尴尬', '社死', '不知所措', '懒得', '服了', '麻了']),
    // ⚠️ 无语与尴尬是**两个桶**，别合并（lift 3.30 / 2.75）
    buckets: Object.freeze([
      Object.freeze({ tag: '无语无奈', lift: 3.30, n: 585 }),
      Object.freeze({ tag: '尴尬社死', lift: 2.75, n: 212 }),
      Object.freeze({ tag: '困惑不解', lift: 1.87, n: 238 }),
      Object.freeze({ tag: '生气不满', lift: 1.79, n: 55 }),
      Object.freeze({ tag: '难过不安', lift: 1.67, n: 101 }),
    ]),
  }),
  Object.freeze({
    id: '震惊/意外/离谱',
    keywords: Object.freeze(['震惊', '惊讶', '意外', '离谱', '难以置信', '震撼', '夸张', '居然', '竟然']),
    // 离谱事件会**同时**抬震惊和吃瓜（2.87 / 1.99）
    buckets: Object.freeze([
      Object.freeze({ tag: '震惊惊讶', lift: 2.87, n: 396 }),
      Object.freeze({ tag: '困惑不解', lift: 2.03, n: 237 }),
      Object.freeze({ tag: '吃瓜围观', lift: 1.99, n: 78 }),
      Object.freeze({ tag: '生气不满', lift: 1.74, n: 49 }),
    ]),
  }),
  Object.freeze({
    id: '对方负面情绪/求安慰',
    keywords: Object.freeze(['难过', '伤心', '低落', '安慰', '沮丧', '崩溃', '委屈', '不开心', 'emo', '痛苦', '焦虑', '烦']),
    // ⚠️ 报告 §4.3 的原话：小鲸鱼**实测行为**是"经常用『无语无奈』回应别人的低落"，
    //    而不是「难过不安」（2.50 那个 lift 是"该不该关心"，不是"它实际发什么"）。
    //    ⇒ 这张表要按 lift 读，但挑的时候心里要有这一条。
    buckets: Object.freeze([
      Object.freeze({ tag: '难过不安', lift: 2.50, n: 108 }),
      Object.freeze({ tag: '无语无奈', lift: 2.20, n: 277 }),
      Object.freeze({ tag: '生气不满', lift: 1.92, n: 42 }),
      Object.freeze({ tag: '尴尬社死', lift: 1.63, n: 89 }),
    ]),
  }),
  Object.freeze({
    id: '好消息/开心/庆祝',
    keywords: Object.freeze(['好消息', '开心', '庆祝', '太好了', '成功', '赢了', '顺利', '恭喜', '厉害', '棒', '干得漂亮']),
    buckets: Object.freeze([
      Object.freeze({ tag: '开心满足', lift: 2.09, n: 247 }),
      Object.freeze({ tag: '得意自信', lift: 1.57, n: 61 }),
      Object.freeze({ tag: '赞同支持', lift: 1.50, n: 31 }),
    ]),
  }),
  Object.freeze({
    id: '可爱/萌/亲密/喜欢',
    keywords: Object.freeze(['可爱', '萌', '亲亲', '喜欢', '爱你', '贴贴', '抱抱', '撒娇', '心动', '想你了']),
    // ⚠️ 三个桶**同时**被抬 ⇒ 这是区分度最低的一组（报告 §4.3 点名）。
    //    挑选不准时**先怀疑这里**。
    buckets: Object.freeze([
      Object.freeze({ tag: '害羞心动', lift: 2.00, n: 531 }),
      Object.freeze({ tag: '卖萌可爱', lift: 1.94, n: 1132 }),
      Object.freeze({ tag: '治愈陪伴', lift: 1.65, n: 276 }),
    ]),
  }),
  Object.freeze({
    id: '吃瓜/围观/看戏',
    keywords: Object.freeze(['吃瓜', '围观', '看戏', '看热闹', '瓜子']),
    // 干净的一条：只有一个桶
    buckets: Object.freeze([
      Object.freeze({ tag: '吃瓜围观', lift: 2.90, n: 52 }),
    ]),
  }),
  Object.freeze({
    id: '打招呼/问候/祝福',
    keywords: Object.freeze(['早安', '晚安', '早上好', '晚上好', '你好', '问候', '祝福', '生日快乐', '新年', '节日', '欢迎', '在吗']),
    // 问候场景偏"暖心/萌"，**不是**社交互动（报告 §4.3 原话）
    buckets: Object.freeze([
      Object.freeze({ tag: '治愈陪伴', lift: 2.84, n: 90 }),
      Object.freeze({ tag: '社交互动', lift: 2.02, n: 74 }),
      Object.freeze({ tag: '卖萌可爱', lift: 1.80, n: 199 }),
      Object.freeze({ tag: '开心满足', lift: 1.63, n: 106 }),
      Object.freeze({ tag: '害羞心动', lift: 1.59, n: 80 }),
    ]),
  }),
  Object.freeze({
    id: '嘲讽/怼人/反击',
    keywords: Object.freeze(['嘲讽', '怼', '反击', '喷', '讽刺', '阴阳', '看不起', '不屑']),
    // 真怼起来就切到「生气不满」（lift 2.84），不是「调侃吐槽」
    buckets: Object.freeze([
      Object.freeze({ tag: '生气不满', lift: 2.84, n: 19 }),
      Object.freeze({ tag: '调侃吐槽', lift: 1.64, n: 151 }),
      Object.freeze({ tag: '得意自信', lift: 1.61, n: 19 }),
    ]),
  }),
  Object.freeze({
    id: '玩笑/调侃',
    keywords: Object.freeze(['玩笑', '调侃', '开玩笑', '逗', '乐子', '搞笑', '梗']),
    // ⚠️ 最弱的一条（1.41，而且是**单桶**）：基线本身就 27.9%，抬不高。
    //    保留它是因为"调侃语境"在真实数据里占 6542/13320（最大的一类），
    //    完全不给先验等于把最大的一类交给平铺随机。
    buckets: Object.freeze([
      Object.freeze({ tag: '调侃吐槽', lift: 1.41, n: 2565 }),
    ]),
  }),
]);

/**
 * **在数据里没有显著偏好**的语境 —— 显式记在这里，就是为了让"我们没有它的先验"
 * 这件事**看得见**，而不是靠"表里没有"去暗示。
 *
 * - `图片/表情包回应`（n=13319，最大的一类）：这个语境词太泛，等于基线本身；
 * - `工作/学习/日常吐槽`（n=823）：同上。
 *
 * ⇒ 这两类文本**不会**被 {@link candidatesForContext} 认出（返回 `[]`），
 * 除非调用方显式传 `fallback`（见 {@link BASELINE_BUCKETS}）。
 */
export const CONTEXT_WITHOUT_SIGNAL = Object.freeze([
  Object.freeze({ id: '图片/表情包回应', n: 13319, why: '语境词太泛（占样本 100% 量级），等于基线' }),
  Object.freeze({ id: '工作/学习/日常吐槽', n: 823, why: '各桶占比与基线几乎一致，无 lift ≥ 1.4 的项' }),
]);

/** lift 的入选阈值（照抄报告，不重算）。 */
export const CONTEXT_PRIOR_MIN_LIFT = 1.4;

/**
 * **全体基线**占比（%，来自 `emoji2-context.txt` 的"基线（全部 16820 条）"一节）。
 *
 * ⚠️ 它和 {@link STICKER_TAG_COVERAGE} **不是一回事**，别混：
 * - 这里的分母是 **16820 条发送**、且**一张图可能有多个桶**（所以总和不等于 100）；
 * - 后者是**标签实例**（30458）的占比。
 * 用途：{@link candidatesForContext} 的默认兜底池（见 {@link BASELINE_BUCKETS}）。
 */
export const BASELINE_SHARE = Object.freeze({
  调侃吐槽: 27.9, 幽默搞笑: 22.1, 卖萌可爱: 18.6, 无语无奈: 11.7, 玩梗接梗: 11.5,
  开心满足: 10.9, 震惊惊讶: 10.0, 害羞心动: 8.4, 困惑不解: 8.4, 社交互动: 6.2,
  治愈陪伴: 5.3, 尴尬社死: 5.1, 难过不安: 4.0, 得意自信: 3.6, 吃瓜围观: 2.8,
  生气不满: 2.0, 赞同支持: 1.9,
});

/**
 * 兜底的候选桶（**基线最高的 4 个**，按基线占比降序）。
 *
 * 它是 {@link candidatesForContext} 的默认 `fallback` **池** —— 但**只按需取用**：
 * 只有当语境抬高的桶不足 `min`（默认 2）个时才从这里补，**补到 `min` 就停**。
 * ⇒ 所以"认不出语境"的输入得到的是**基线前二**（调侃吐槽 / 幽默搞笑），
 * 不是这四个全上；而"只抬高了一个桶"的语境（吃瓜）得到的是
 * `[吃瓜围观, 调侃吐槽]`（第 2 个是兜底补进来的）。
 *
 * ⚠️ **兜底不是"平铺 17 个"**：平铺等于把"挑"那一步的难度原样丢回给模型。
 * 也**不是**"越多越好"：补进来的每一个都是**基线先验**、不含这段语境的信息
 * （要区分"语境证据"和"基线兜底"，先调 {@link contextCandidates}）。
 */
export const BASELINE_BUCKETS = Object.freeze(
  Object.entries(BASELINE_SHARE)
    .filter(([tag]) => isStickerTag(tag))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tag]) => tag),
);

/**
 * 这段文本命中了哪些语境（按 {@link CONTEXT_PRIORS} 的顺序返回 id）。
 *
 * 纯函数：没有状态、没有 I/O。命中规则 = `text.includes(关键词)` 任一。
 *
 * @param {unknown} text 语境文本（聊天前文 / 模型写的理由 / 别人的一句话都行）
 * @returns {string[]} 语境 id（可能为空）
 */
export function matchedContexts(text) {
  const s = typeof text === 'string' ? text : '';
  if (s === '') return [];
  return CONTEXT_PRIORS
    .filter((ctx) => ctx.keywords.some((kw) => s.includes(kw)))
    .map((ctx) => ctx.id);
}

/**
 * **严格版**：只返回"这段语境真的抬高过"的桶（lift ≥ {@link CONTEXT_PRIOR_MIN_LIFT}）。
 *
 * 排序规则（刻意简单，便于复核）：
 * 1. 主序 = 该桶在命中语境里的**最高 lift**（大的在前）；
 * 2. 次序 = 把它抬高的**语境个数**（多的在前）—— 两个语境同时抬同一个桶，
 *    比只有一个语境抬它更可信；
 * 3. 末序 = {@link STICKER_TAG_COVERAGE} 降序（桶越大越可能有一张合适的，
 *    这只是让结果**稳定**，不是"越大越该发"）。
 *
 * ⚠️ 命中多个语境时**不做加权求和**：lift 是比值，求和没有统计意义。
 * ⚠️ 结果可能是 **1 个**（"吃瓜/围观/看戏"在数据里就只抬高了一个桶）
 *    —— 那是**真实信息**，凑数会把它抹掉。要"永远 2~4 个"请用
 *    {@link candidatesForContext}（它会用基线兜底，并说清哪部分是兜底）。
 *
 * @param {unknown} text 语境文本
 * @param {object} [options]
 * @param {number} [options.max] 最多给几个（默认 4）
 * @param {number} [options.minLift] lift 下限（默认 {@link CONTEXT_PRIOR_MIN_LIFT}）
 * @returns {string[]} 0~4 个桶名（只含 17 个枚举值之一）
 */
export function contextCandidates(text, {
  max = 4,
  minLift = CONTEXT_PRIOR_MIN_LIFT,
} = {}) {
  const capMax = Number.isFinite(max) && max > 0 ? Math.floor(max) : 4;
  const floor = Number.isFinite(minLift) ? minLift : CONTEXT_PRIOR_MIN_LIFT;

  const s = typeof text === 'string' ? text : '';
  const hits = CONTEXT_PRIORS.filter((ctx) => ctx.keywords.some((kw) => s.includes(kw)));

  /** 桶 → {lift, hits} */
  const best = new Map();
  for (const ctx of hits) {
    for (const { tag, lift } of ctx.buckets) {
      if (lift < floor) continue;
      if (!isStickerTag(tag)) continue;
      const found = best.get(tag);
      if (found === undefined) best.set(tag, { lift, hits: 1 });
      else {
        found.hits += 1;
        if (lift > found.lift) found.lift = lift;
      }
    }
  }

  const share = (tag) => STICKER_TAG_COVERAGE[tag] ?? 0;
  return [...best.entries()]
    .sort((a, b) => (b[1].lift - a[1].lift) || (b[1].hits - a[1].hits) || (share(b[0]) - share(a[0])))
    .map(([tag]) => tag)
    .slice(0, capMax);
}

/**
 * **给一段语境文本，返回 2~4 个候选桶** —— 这是给"挑"那一步用的那一个。
 *
 * = {@link contextCandidates} 的结果，**不够 `min` 个时用 `fallback`（默认基线）补足**。
 *
 * ⚠️ **必须知道补进来的那部分是"基线先验"，不是"这段语境的证据"**：
 * - 例：`吃瓜/围观/看戏` 在数据里只抬高 `吃瓜围观` 一个桶（lift 2.90），
 *   补足到 2 个会加进基线最大的 `调侃吐槽` —— 这个补充**恰好也和那份数据一致**
 *   （同一张交叉表里，吃瓜语境发得最多的是调侃吐槽 33%），但它不是 lift 推出来的；
 * - 要区分两者，**先调 {@link contextCandidates}**（它绝不会掺基线）。
 *
 * ⚠️ 默认兜底不是"平铺 17 个"，而是**基线最高的 4 个**（{@link BASELINE_BUCKETS}）；
 * 而且**只补到 `min` 为止**（默认 2）—— 补多了等于用"没有信息"的桶
 * 把语境给的那点信号稀释掉。平铺 17 个更是等于把"挑"的难度原样丢回给模型。
 *
 * @param {unknown} text 语境文本
 * @param {object} [options]
 * @param {number} [options.min] 至少给几个（默认 2）
 * @param {number} [options.max] 最多给几个（默认 4）
 * @param {readonly string[]} [options.fallback] 补足用的兜底桶（默认 {@link BASELINE_BUCKETS}；
 *   传 `[]` 就退化成 {@link contextCandidates} 的行为）
 * @param {number} [options.minLift] lift 下限
 * @returns {string[]} 2~4 个桶名（`fallback` 传空且认不出语境时是 `[]`）
 */
export function candidatesForContext(text, {
  min = 2,
  max = 4,
  fallback = BASELINE_BUCKETS,
  minLift = CONTEXT_PRIOR_MIN_LIFT,
} = {}) {
  const capMax = Number.isFinite(max) && max > 0 ? Math.floor(max) : 4;
  const capMin = Number.isFinite(min) && min > 0 ? Math.min(Math.floor(min), capMax) : 2;
  const ranked = contextCandidates(text, { max: capMax, minLift });
  if (ranked.length >= capMin) return ranked;
  for (const tag of (Array.isArray(fallback) ? fallback : [])) {
    if (ranked.length >= capMin) break;
    if (!isStickerTag(tag) || ranked.includes(tag)) continue;
    ranked.push(tag);
  }
  return ranked.slice(0, capMax);
}
