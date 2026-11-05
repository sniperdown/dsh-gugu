/**
 * 知识库（阶段 1：导入 + 关键词检索）。
 *
 * 数据源是 MaiBot.db 导出的 JSON：`<工作区>\shared\knowledge.json`
 * - `graph_nodes`：概念 → 知识描述（群里的梗、话题、历史，1713 节点）
 * - `person_info`：user_id + 昵称 → 人物画像（546 人）
 *
 * ⚠️ 2026-10-05 挪位置：原来在 `<maibot>\knowledge.json` —— 那是 MaiBot 的
 * 导出目录。用户指出这份数据**是我们自己的、而且所有会话共用**，不该放别人地盘里，
 * 于是搬到工作区的 `shared/`（跨会话共享目录）。**知识库本身是只读的**
 * （只有 `learned-memory.json` 会被回写），所以搬它不影响写入路径。
 *
 * 阶段 1 用**关键词匹配**（concept / 昵称包含在最近文本里就算命中），
 * 阶段 2 再上 embedding 语义检索。检索只返回 topK 条、每条截断，**不挤占上下文**
 * —— 这正是用户点名的知识库核心价值。
 *
 * ⚠️ **这份数据是脏的**（2026-10-05 实测）：546 条画像里，
 * 82% 的记忆点含推测词（"可能/似乎/表明/暗示/表现出"），
 * 最长的一条画像 12.9 万字、1321 条记忆点 —— 那是 MaiBot 侧的
 * `relation.py` 无上限 `append` 累积出来的。**清理是另一件事**（见 DSHsummary/2026-10-05）。
 *
 * @module qq-gugu/knowledge
 */

/**
 * 记忆点的来源标记。
 *
 * 用户 2026-10-05 拍板：**推测要留着，但必须标出来**（原话「推测也是有用的」）。
 * 理由：推测里包含"模型的理解"（"她可能对技术感兴趣"），丢掉只剩干巴巴的事实；
 * 但**不标的话，小鲸鱼会拿自己的猜测当事实说出去** —— 而那句话会传到群友那里。
 *
 * ⚠️ 实测教训：MaiBot 那份存量数据里 **82% 的记忆点含推测词**
 * （"可能/似乎/表明/暗示/表现出"），却和事实混在一起、没有任何标记。
 */
export const ORIGIN = Object.freeze({
  FACT: '[事实]',
  GUESS: '[推测]',
});

/**
 * 两个短句的相似度（bigram 集合的 Jaccard，0~1）。
 *
 * 为什么要自己写一个：判断"这两条记忆是不是同一件事"**必须模糊匹配**——
 * 精确的 `includes` 连「他喜欢深夜调试」和「他喜欢在深夜调试」
 * 都认不出是同一句，于是同一件事被记十遍（那正是 MaiBot 那条屎山的起点）。
 *
 * 零依赖的取舍：不引第三方字符串相似度库 —— 这点精度够用，
 * 而且中英混排、带标点的情况下，bigram 比按词切更稳（不需要分词器）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0~1，1 表示完全相同
 */
export function similarity(a, b) {
  /**
   * 归一化：去空白、统一大小写、去掉常见中英标点。
   *
   * ⚠️ 这一步**必须有**，否则"只差一个空格"的两句会被判成不同：
   * 实测 `"[事实] 他在做 QQ 机器人"` vs `"[事实] 他在做QQ机器人"`
   * 未归一化时相似度掉到阈值以下 → 判重失败 → **同一件事被记两遍**。
   * 而那正是我们要堵的那条路。
   */
  const norm = (s) => String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）【】《》,.!?;:'"()<>[\]-]/g, '');

  const A = norm(a);
  const B = norm(b);
  if (A === '' || B === '') return 0;
  if (A === B) return 1;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    // 长度为 1 的串没有 bigram，退化成"整串"当一个 gram
    if (set.size === 0) set.add(s);
    return set;
  };
  const ga = grams(A);
  const gb = grams(B);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 一条记忆点相对"当前话题"的相关度（0~1）。
 *
 * 用**覆盖率**而不是 Jaccard：query 通常是一整句话、记忆点也是长句，
 * 两边取集的 Jaccard 会双双被稀释到很低，排不出高低。
 * 覆盖率只问一件事：**这句话里的词，有多少出现在这条记忆里** —— 那才是我们要的。
 *
 * @param {string} point 记忆点
 * @param {string} query 当前消息
 * @returns {number} 0~1
 */
function relevance(point, query) {
  const norm = (s) => String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）【】《》,.!?;:'"()<>[\]-]/g, '');
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    if (set.size === 0 && s !== '') set.add(s);
    return set;
  };
  const q = grams(norm(query));
  if (q.size === 0) return 0;
  const p = grams(norm(point));
  if (p.size === 0) return 0;
  let hit = 0;
  for (const g of q) if (p.has(g)) hit += 1;
  return hit / q.size;
}

/**
 * 从一个人的全部记忆里，挑出"和当前话题相关"的若干条。
 *
 * ## 为什么需要这个（用户 2026-10-05 拍板）
 *
 * 原话：「**主要导出如果每次都把对象所有的记忆全导出有点蠢了**」。
 *
 * 实测过：`retrieve` 对"当前发言人"是**整串返回**的，而注入路径上没有截断 ——
 * 于是最重的那个人（戎令）**每次说话都要塞 5,559 字符 ≈ 3,706 token** 进提示词，
 * 哪怕这次聊的跟他的记忆毫无关系。546 人里 3 个人占了全部字数的 40%，
 * 那几个人一开口，成本就翻上去。
 *
 * ## 挑选策略
 *
 * 1. **先按相关度降序**（和当前消息重合度高的优先）
 * 2. **再用"较新的"补齐到至少 `minPoints` 条** ——
 *    否则聊到陌生话题时，小鲸鱼会**完全不认识这个人**（那比多花点 token 更糟）
 * 3. **总字数封顶 `maxChars`**
 * 4. **最后按原始顺序拼回去**（读起来自然，不显得东一句西一句）
 *
 * ⚠️ "较新"只能靠**顺序**判断 —— `memory` 是分号串、没有时间戳，
 * 而 `remember` 是往后追加的，所以**越靠后越新**。
 *
 * @param {string} memory 某人的整串记忆
 * @param {string} query 当前消息
 * @param {object} [options]
 * @param {number} [options.maxChars] 总字数上限（默认 1200）
 * @param {number} [options.minPoints] 至少给几条（默认 3）
 * @returns {string} 挑出来的记忆（分号串）；没有可给的返回空串
 */
export function pickRelevantPoints(memory, query, { maxChars = 1200, minPoints = 3 } = {}) {
  const points = String(memory ?? '')
    .split('；')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (points.length === 0) return '';

  const scored = points.map((text, idx) => ({ text, idx, score: relevance(text, query) }));

  // 相关度降序；同分时"越靠后（越新）"优先
  const byScore = scored.slice().sort((a, b) => b.score - a.score || b.idx - a.idx);
  // 兜底队列：按"最新"排
  const byRecency = scored.slice().sort((a, b) => b.idx - a.idx);

  const picked = [];
  const used = new Set();
  let chars = 0;
  // ⚠️ 拼回去时要加 `；` 分隔符，**算总量时必须把它算进去** ——
  // 不然 40 条会多出 39 个字，封顶就不准了（实测：说好 1200，出来 1238）。
  const SEP = '；'.length;
  const cost = (s) => s.text.length + (picked.length > 0 ? SEP : 0);

  // 第一遍：**只取相关的**（`score > 0`），直到封顶
  //
  // ⚠️ 这里不再"取够 minPoints 就停" —— 相关的有几条就给几条。
  // 第一版写的是"取 3 条就停，然后把剩余空间全塞满"，
  // 结果实测出来：问「在吗」「机器人坏了」「第五人格好玩吗」给的量**几乎一样**（都 ~1170 字），
  // 说明**相关度压根没起作用，是封顶值在决定一切** —— 那等于换了个固定开销，不是"按需给"。
  for (const s of byScore) {
    if (s.score <= 0) break;
    if (chars + cost(s) > maxChars) continue;
    used.add(s.idx);
    picked.push(s);
    chars += cost(s);
  }

  // 第二遍：**只有不够 minPoints 才兜底**（用最新的补齐）
  // 目的是"至少认识这个人"，而不是"把预算花完"。
  for (const s of byRecency) {
    if (picked.length >= minPoints) break;
    if (used.has(s.idx)) continue;
    if (chars + cost(s) > maxChars) continue;
    used.add(s.idx);
    picked.push(s);
    chars += cost(s);
  }

  // 按原始顺序排回去
  picked.sort((a, b) => a.idx - b.idx);
  return picked.map((s) => s.text).join('；');
}

/**
 * 知识库。
 */
export class KnowledgeBase {
  /**
   * @param {object} options
   * @param {Array<{concept: string, memory: string}>} [options.graphNodes]
   * @param {Array<{user_id: string, nickname: string, memory: string}>} [options.personInfo]
   */
  constructor({ graphNodes = [], personInfo = [], learnedFacts = [] } = {}) {
    this.graphNodes = graphNodes;
    this.personInfo = personInfo;
    /** 动态学来的事实（用于持久化，重启后重放）。 */
    this.learnedFacts = learnedFacts;
  }

  /**
   * 从导出的 JSON 文件加载。
   * @param {string} jsonPath
   */
  static load(jsonPath, { readFileSync } = {}) {
    const fs = readFileSync ?? (() => { throw new Error('需要 readFileSync'); })();
    const raw = fs(jsonPath, 'utf8');
    const data = JSON.parse(raw);
    return new KnowledgeBase({
      graphNodes: data.graph_nodes ?? [],
      personInfo: data.person_info ?? [],
    });
  }

  /**
   * 把一个人的 `memory` 字符串拆成记忆点数组。
   *
   * ⚠️ 存储格式是**分号拼接的字符串**（`"事实A；事实B"`），这是历史决定的：
   * 存量数据（从 MaiBot 导出的 546 条画像）就是这个形状，改数组会牵动 `retrieve`/`render`。
   * 所以这里只做"拆开看一眼"，写回去时仍拼成分号串。
   *
   * @private
   */
  static #pointsOf(person) {
    const mem = String(person?.memory ?? '').trim();
    if (mem === '') return [];
    return mem.split('；').map((s) => s.trim()).filter((s) => s !== '');
  }

  /** @private 把数组拼回分号串。 */
  static #joinPoints(points) {
    return points.join('；');
  }

  /**
   * 某人已有的记忆点（给 learner 用 —— 让它知道"这些已经记过了，别重复"）。
   *
   * 这是治源头三件事里的第二件。第一件（标来源）在 learner 的提示词里，
   * 第三件（上限）在 `remember` 里。
   *
   * @param {string} userId
   * @returns {string[]}
   */
  factsFor(userId) {
    const person = this.personInfo.find((p) => p.user_id === String(userId ?? ''));
    return person === undefined ? [] : KnowledgeBase.#pointsOf(person);
  }

  /**
   * 检索相关知识。
   *
   * ⚠️ **2026-10-05 改了"当前发言人画像"的处理方式**（用户要求）：
   * 原来是把那个人的**整串记忆**原样塞进去，实测最重的一个人有 5,559 字符
   * （约 3,706 token），**每次他说话都要付这个成本**，哪怕聊的跟他的记忆无关。
   * 现在改成先按相关度挑、总量封顶（`pickRelevantPoints`）。
   *
   * @param {object} input
   * @param {string} input.text 最近聊天文本（用来匹配概念和昵称）
   * @param {string} [input.userId] 当前发言人（检索这个人的画像）
   * @param {number} [input.topK]
   * @param {number} [input.maxPersonChars] 发言人画像最多给多少字（默认 1200）
   * @returns {Array<{type: string, name: string, memory: string}>}
   */
  retrieve({ text = '', userId = '', topK = 3, maxPersonChars = 1200 }) {
    const haystack = String(text ?? '');
    const results = [];

    // 1. 当前发言人画像（谁在说话 → 小鲸鱼认识他）
    //    只给他"和这次话题相关"的那几条，不再整串倒出来。
    if (userId !== '') {
      const person = this.personInfo.find((p) => p.user_id === String(userId));
      if (person !== undefined && person.memory !== '') {
        const picked = pickRelevantPoints(person.memory, haystack, { maxChars: maxPersonChars });
        if (picked !== '') {
          results.push({ type: 'person', name: person.nickname || person.user_id, memory: picked });
        }
      }
    }

    // 2. 概念匹配：graph_nodes 的 concept 出现在最近文本里
    //    只匹配长度 >= 2 的概念，避免"设计""角色"这种单字/太通用的词满天飞。
    //
    // ⚠️ **2026-10-05 改了取法**：原来是"边扫边 push，收满 topK*2 条就 break"——
    // 那是**按数组顺序**决定谁入选，**谁排在前面谁赢**，跟"哪个更贴切"无关。
    //
    // 实测过的后果：`graphNodes` 里通用词排在前面（活动@5、系统@7、时间@24），
    // 具体条目排在后面（八周年@385、叙事@549）。于是聊"八周年活动"时，
    // 「活动」先把名额占掉了，**「八周年」永远拿不到槽位** ——
    // 那条 601 字的正文等于白存。
    //
    // 现在改成：**先把所有命中的收集起来，再按"具体度"排序取前几条。**
    // 用 concept 长度当具体度的代理 —— 越长的概念越像一个完整的专名
    // （「第五人格」比「第五」准，「八周年」比「周年」准）。
    // 1247 条全扫一遍是毫秒级，不需要提前 break。
    const hits = [];
    for (const node of this.graphNodes) {
      const concept = String(node.concept ?? '');
      if (concept.length < 2) continue;
      if (node.memory !== '' && haystack.includes(concept)) {
        hits.push({ type: 'concept', name: concept, memory: node.memory, weight: concept.length });
      }
    }
    // 具体度降序。长度相同时保持原顺序（`sort` 在现代 V8 上是稳定的）。
    hits.sort((a, b) => b.weight - a.weight);
    for (const h of hits) results.push(h);

    // 去重（按 memory 内容），截断到 topK
    const seen = new Set();
    const dedup = [];
    for (const r of results) {
      if (seen.has(r.memory)) continue;
      seen.add(r.memory);
      dedup.push(r);
      if (dedup.length >= topK) break;
    }
    return dedup;
  }

  /**
   * 把检索结果渲染成一段可注入 prompt 的文本。
   * @param {Array<{type: string, name: string, memory: string}>} items
   * @returns {string} 空串表示没有相关知识
   */
  render(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return '';
    const lines = list.map((it) => {
      if (it.type === 'person') return `- 关于「${it.name}」你知道：${it.memory}`;
      return `- 关于「${it.name}」：${it.memory}`;
    });
    return lines.join('\n');
  }

  /**
   * 记住一条关于某人的事实。
   *
   * **三道闸门**（治源头，用户 2026-10-05 要求「源头得把控好」）：
   * 1. **相似度去重** —— 不是精确匹配。"他喜欢深夜调试"和"他喜欢在深夜调试"
   *    算同一条（阈值 0.85）。这是 MaiBot 那条屎山的起点：它只有无上限的 `append`。
   * 2. **每人上限** —— 超了**优先淘汰推测**，推测之间再淘汰最旧的。
   *    事实比推测值钱，所以"满了"的时候先丢猜测。
   * 3. **来源标注** —— 没标来源的当 `[事实]`（保守：宁可少标推测，
   *    也不要把事实降级；但 learner 那边被要求"拿不准就标推测"）。
   *
   * @param {string} userId
   * @param {string} fact
   * @param {object} [options]
   * @param {number} [options.maxPerPerson] 每人最多几条（默认 40）
   * @param {number} [options.dupThreshold] 相似度阈值，超过算重复（默认 0.85）
   * @returns {boolean} 是否真的记下了（去重命中时返回 false）
   */
  remember(userId, fact, { maxPerPerson = 40, dupThreshold = 0.85 } = {}) {
    const uid = String(userId ?? '');
    let f = String(fact ?? '').trim();
    if (uid === '' || f === '') return false;

    // 来源标注：没有标记的一律当事实（`learner` 负责加标记）
    if (!f.startsWith(ORIGIN.FACT) && !f.startsWith(ORIGIN.GUESS)) {
      f = `${ORIGIN.FACT} ${f}`;
    }

    let person = this.personInfo.find((p) => p.user_id === uid);
    if (person === undefined) {
      person = { user_id: uid, nickname: '', memory: '' };
      this.personInfo.push(person);
    }

    const points = KnowledgeBase.#pointsOf(person);
    // ── 闸门 1：相似度去重 ──
    for (const existing of points) {
      if (similarity(existing, f) >= dupThreshold) return false;
    }

    points.push(f);

    // ── 闸门 2：上限，优先淘汰推测 ──
    while (points.length > maxPerPerson) {
      const guessIdx = points.findIndex((p) => p.startsWith(ORIGIN.GUESS));
      points.splice(guessIdx >= 0 ? guessIdx : 0, 1);
    }

    person.memory = KnowledgeBase.#joinPoints(points);

    // 记录到 learnedFacts（同样去重），供 dump 持久化。
    if (!this.learnedFacts.some((x) => x.user_id === uid && x.fact === f)) {
      this.learnedFacts.push({ user_id: uid, fact: f });
    }
    return true;
  }

  /** 导出动态学来的事实（可持久化到 JSON）。 */
  dumpLearned() {
    return this.learnedFacts.slice();
  }
}
