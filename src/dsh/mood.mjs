/**
 * 动态心情系统（对齐 MaiBot 的 `mood_manager.py`）。
 *
 * 用户点名：为了拟人化，**心情不该写死在表面配置**。MaiBot 的做法是分两层：
 * - `emotion_style`（情绪特点）= 固定底色，留在 toml（用户可改）；
 * - `mood_state`（当前心情）= 动态内部状态，随对话演化。
 *
 * 这里实现 mood_state 这一层：
 * 1. 收到消息时，按概率用 LLM 更新心情（聊到色色 → 兴奋、被夸 → 开心……）；
 * 2. 一段时间没关注，心情定时平复（最多平复两次，不会无限回落）。
 *
 * @module qq-gugu/mood
 */

/** 更新概率的三个参数（2026-10-30 从写死改成可配）。默认值 = 改动前的行为。 */
export const DEFAULT_MOOD_PROB = Object.freeze({ base: 0.1, perMinute: 0.1, max: 0.5 });

/**
 * 更新概率：距离上次心情变化越久，越容易被新消息刺激到（心情平复后需要新刺激）。
 *
 * 2026-10-30：三个系数可配（`[mood] update_base_prob / update_ramp_per_min / update_max_prob`）。
 * 不传 = 用 {@link DEFAULT_MOOD_PROB}，与改动前逐字节一致。
 *
 * @param {number} elapsedMs 距上次成功更新的毫秒数
 * @param {{base?: number, perMinute?: number, max?: number}} [params]
 * @returns {number} 0~1
 */
export function moodUpdateProbability(
  elapsedMs,
  { base = DEFAULT_MOOD_PROB.base, perMinute = DEFAULT_MOOD_PROB.perMinute, max = DEFAULT_MOOD_PROB.max } = {},
) {
  const minutes = Math.max(0, Number(elapsedMs) / 60_000);
  const b = Number.isFinite(base) ? base : DEFAULT_MOOD_PROB.base;
  const step = Number.isFinite(perMinute) ? perMinute : DEFAULT_MOOD_PROB.perMinute;
  const cap = Number.isFinite(max) ? max : DEFAULT_MOOD_PROB.max;
  return Math.min(cap, b + minutes * step);
}

/**
 * 构造心情管理器。
 * @param {object} options
 * @param {(opts: {provider: string, model: string, system: string, messages: Array<any>, maxTokens: number}) => AsyncIterable<any>} options.stream
 * @param {string} options.provider
 * @param {string} options.model
 * @param {string} [options.reasoningEffort] 推理强度档位。**由装配层从 toml 的
 *   `[mood] reasoning_effort` 读进来**（2026-10-14）：模型清单里没声明档位的路由
 *   收到这个字段会直接抛 `UNSUPPORTED_REASONING_EFFORT`（注释里记着实测），
 *   所以"换模型要连带改档位"这件事必须能靠改配置解决，而不是改代码。
 * @param {string} [options.emotionStyle] 情绪特点（toml 里的 emotion_style，作底色）
 * @param {string[]} [options.names]
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 */
/**
 * 心情后台任务的三段提示词（2026-10-30 从代码搬进 `[mood]`）。
 *
 * 这三个字符串**就是搬迁前的原文**：`[mood]` 里没写时逐个回退到它们，
 * 所以"没配"与"配成空"都不会改变行为。
 */
export const DEFAULT_MOOD_SYSTEM = '你是心情描述器，只输出一句描述心情的话，不输出其他内容。';
export const DEFAULT_MOOD_UPDATE_NOTE = '现在有消息引起了你的注意，你阅读和思考之后，输出一句话描述你新的情绪状态。';
export const DEFAULT_MOOD_REGRESS_NOTE = '距离你上次关注群消息已经过去了一段时间，你平复了一些情绪，输出一句话描述你现在的情绪状态。';

export function createMood({  stream,
  provider,
  model,  // 推理强度。默认 `off`：心情更新是**后台小任务**（输出上限 100 token，
  // 每条消息按概率触发），不需要任何推理。不显式传的话会继承模型默认档
  // （flash 的默认是 `high`），纯粹浪费钱。
  // 这一项是小鲸鱼自己扒 request/header 时发现并建议的。
  reasoningEffort = 'off',
  emotionStyle = '',
  names = ['小鲸鱼'],
  log = () => {},
  // ── 提示词的三段固定话（2026-10-30 从代码搬进 `[mood]`）──
  // 空 / 非字符串 ⇒ 用内置默认（= 搬迁前原文，逐字节相同）。
  systemPrompt = '',
  updateNote = '',
  regressNote = '',
  // ── 节奏（2026-10-30 上配置页）──
  // 硬冷却：距上次成功更新不到这么多分钟**必然不更新**（默认 0 = 现状：没有硬冷却，
  // 只靠下面的概率曲线；想"至少隔 5 分钟才换一次心情"就把它设成 5）。
  cooldownMinutes = 0,
  baseProb = DEFAULT_MOOD_PROB.base,
  rampPerMinute = DEFAULT_MOOD_PROB.perMinute,
  maxProb = DEFAULT_MOOD_PROB.max,
  // 平复：连续安静这么多秒后回落一次，最多回落几次（默认 200s / 2 次 = 改动前）。
  regressAfterSeconds = 200,
  regressMax = 2,
}) {
  const pick = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value : fallback);
  const systemText = pick(systemPrompt, DEFAULT_MOOD_SYSTEM);
  const updateText = pick(updateNote, DEFAULT_MOOD_UPDATE_NOTE);
  const regressText = pick(regressNote, DEFAULT_MOOD_REGRESS_NOTE);
  /**
   * @type {Map<string, {
   *   mood: string, lastChangeAt: number, regressCount: number,
   *   calls: number, tries: number, fails: number, lastTryAt: number, lastError: string
   * }>}
   *
   * ⚠️ **`calls` / `tries` / `fails` / `lastError` 只为可观测性存在**（2026-10-15 加）。
   *
   * 为什么要它们：这个模块原来**失败是静默的** —— `generate()` 抛错时只记一行日志
   * （而日志没有出口），然后返回空串，调用方 `if (next === '') return s.mood`
   * **看不出任何区别**。于是线上现象是"心情永远是初始值"，而
   * 「没触发」「触发了但抛错」「生成了但恰好等于初始值」**三者长得一模一样**。
   *
   * 这四个数的**判别矩阵**：
   * ```
   * calls = 0              ⇒ gateway 根本没调 updateMood（接线断了）
   * calls > 0, tries = 0   ⇒ 调了，但概率没中（正常，不是故障）
   * tries > 0, fails = tries ⇒ 每次都失败 ⇒ 看 lastError ★
   * tries > 0, fails < tries ⇒ 成功过 ⇒ mood 应该是生成的文本
   * ```
   */
  const states = new Map();

  function state(chatId) {
    let s = states.get(chatId);
    if (s === undefined) {
      s = {
        mood: '感觉很平静',
        lastChangeAt: 0,
        regressCount: 0,
        calls: 0,
        tries: 0,
        fails: 0,
        lastTryAt: 0,
        lastError: '',
      };
      states.set(chatId, s);
    }
    return s;
  }

  /** 取当前心情（无记录则平静）。 */
  function getMood(chatId) {
    return state(chatId).mood;
  }

  /** 用 LLM 生成一句新的心情描述。`s` 传了就把尝试/失败记进那个会话的状态。 */
  async function generate(prompt, s = null) {
    let text = '';
    // ⚠️ 诊断用（2026-10-15 加）：记下流里出现过哪些 chunk 类型。
    // 为什么需要：调用不抛错、返回空文本时，光知道"是空的"没法往下查 ——
    // 得知道模型到底吐了什么（只有 reasoning 没有 text？还是一个 chunk 都没来？）。
    const chunkTypes = new Map();
    // 诊断：`finish`（结束原因）与 `usage`（token 计数）。
    // 为什么需要（2026-10-15 实测）：`qwen3-30b-a3b-instruct-2507` 回来的流里
    // **只有 `usage×1 finish×1`，一个内容 chunk 都没有** ⇒ 只记 chunk 类型还不足以
    // 区分「预算被吃光」（finish=length）和「模型真的什么都没说」（finish=stop）。
    let finishInfo = '';
    let usageInfo = '';
    if (s !== null) {
      s.tries += 1;
      s.lastTryAt = Date.now();
    }
    try {
      const chunks = stream({
        provider,
        model,
        // ⚠️ **空串/未设 ⇒ 一个字段都不发**（不是发一个空值）。
        //
        // 🔴 2026-10-14 16:4x 读到真源码后纠正过这里的说法（原先写错了）：
        // `@deepseek-ai/dsh-llm/lib/index.js` L2169-2184 `resolveCallWithInfo()`：
        //     const reasoning = info.reasoning;
        //     const requested = defaulted.reasoningEffort;
        //     if (reasoning === void 0) {
        //       if (requested !== void 0) throw new LlmError(`... does not support reasoning effort "${requested}"`)
        //     }
        // ⇒ **模型没声明 `reasoningEfforts` 时，传【任何值】都抛 —— `off` 也不例外。**
        //   （不是"只认 off"。）所以给这类模型必须【一个字段都不发】= 空串。
        // ⇒ 哪天在 `cordis.patch.yml` 里给模型补上 `reasoningEfforts`，才能写回具体档位。
        ...reasoningEffort === '' || reasoningEffort === null || reasoningEffort === undefined
          ? {}
          : { reasoningEffort },
        system: systemText,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 100,
      });
      for await (const chunk of chunks) {
        const type = String(chunk?.type ?? '(无 type)');
        chunkTypes.set(type, (chunkTypes.get(type) ?? 0) + 1);
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        if (chunk?.type === 'finish') finishInfo = JSON.stringify(chunk).slice(0, 240);
        if (chunk?.type === 'usage') usageInfo = JSON.stringify(chunk).slice(0, 240);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (s !== null) {
        s.fails += 1;
        s.lastError = msg;
      }
      log('warn', '心情更新失败', { error: msg });
      return '';
    }
    const trimmed = text.trim();
    if (trimmed === '' && s !== null) {
      const types = [...chunkTypes.entries()].map(([k, v]) => `${k}×${v}`).join(' ') || '(一个 chunk 都没来)';
      const extra = [finishInfo && `finish=${finishInfo}`, usageInfo && `usage=${usageInfo}`].filter(Boolean).join(' ');
      s.lastError = `模型返回了空文本；收到的 chunk：${types}${extra ? `；${extra}` : ''}`;
    }
    return trimmed;
  }

  /**
   * 收到消息时尝试更新心情（概率触发）。
   * @param {object} input
   * @param {string} input.chatId
   * @param {string} input.transcript 最近聊天文本
   * @param {number} [input.now]
   * @returns {Promise<string>} 更新后的心情（可能没变）
   */
  async function updateMood({ chatId, transcript, now = Date.now() }) {
    const s = state(chatId);
    // `calls` 数的是"gateway 真的来调过几次"（含概率没中的那些）。
    // 它和 `tries` 的差就是"概率没中"的次数 —— 用来区分【接线断了】和【只是没抽中】。
    s.calls += 1;
    // ⚠️ 2026-10-15：**【这个进程里从没试过】时必定试一次**，不抽签。
    //
    // 为什么（实测踩到的）：`moodUpdateProbability` 的上限只有 0.5，而它算的是
    // `now - s.lastChangeAt` —— 从没成功过时 `lastChangeAt = 0` ⇒ 差值巨大 ⇒ 概率封顶 0.5。
    // 于是**每次重载之后，第一个心情要靠抛硬币**：连发 3 条消息全没中的概率是 12.5%，
    // 2026-10-15 真的连着撞了两轮（`calls=3 tries=0`）—— 排查时这极难分辨，
    // 因为线上表现和"没接线"一模一样（都是 `tries=0`）。
    //
    // ⇒ 用 `s.tries === 0` 而不是 `s.lastChangeAt === 0` 当条件：
    //   后者在【持续失败】时也不为 0 ⇒ 会变成"每条消息都真发一次请求"（烧钱）。
    //   前者只保证**每个会话、每个进程生命周期内恰好多这一次**，有界。
    // ⇒ 抽签本身留着（它防的是"每条消息都问一次模型"），只是不再决定"能不能被验到"。
    const prob = s.tries === 0
      ? 1
      : moodUpdateProbability(now - s.lastChangeAt, {
        base: baseProb, perMinute: rampPerMinute, max: maxProb,
      });
    // 硬冷却（2026-10-30）：距上次成功更新还不到 `cooldownMinutes` ⇒ 连抽签都不抽。
    // 默认 0 = 关掉，与改动前完全一致（那时只有概率曲线，没有硬间隔）。
    const cooldownMs = Math.max(0, Number(cooldownMinutes) || 0) * 60_000;
    if (cooldownMs > 0 && s.lastChangeAt > 0 && now - s.lastChangeAt < cooldownMs) {
      s.skippedCooldown = (s.skippedCooldown ?? 0) + 1;
      return s.mood;
    }
    if (Math.random() > prob) return s.mood;

    const prompt = [
      transcript,
      '以上是群里最近的聊天记录',
      '',
      `你的名字是${names[0] ?? '小鲸鱼'}`,
      `你刚刚的情绪状态是：${s.mood}`,
      '',
      updateText,
      emotionStyle === '' ? '' : `你的情绪特点是：${emotionStyle}`,
      '请只输出新的情绪状态本身，不要输出其他内容。',
    ].filter((l) => l !== '').join('\n');

    const next = await generate(prompt, s);
    if (next === '') return s.mood;
    s.mood = next;
    s.lastChangeAt = now;
    s.regressCount = 0;
    s.lastError = '';
    log('debug', `心情更新 ${chatId}`, { mood: next });
    return next;
  }

  /**
   * 心情平复：一段时间没关注，心情回落（最多平复两次）。
   * @param {string} chatId
   * @param {number} [now]
   * @param {number} [quietMs] 多久没变化才平复（默认 200 秒，对齐 MaiBot）
   * @returns {Promise<string>}
   */
  async function regress(chatId, now = Date.now(), quietMs = Math.max(0, Number(regressAfterSeconds) || 200) * 1000) {
    const s = state(chatId);
    if (s.regressCount >= (Number(regressMax) || 2)) return s.mood;
    if (s.lastChangeAt === 0 || now - s.lastChangeAt < quietMs) return s.mood;

    const prompt = [
      `你的名字是${names[0] ?? '小鲸鱼'}`,
      `你之前的情绪状态是：${s.mood}`,
      '',
      regressText,
      emotionStyle === '' ? '' : `你的情绪特点是：${emotionStyle}`,
      '请只输出新的情绪状态本身。',
    ].filter((l) => l !== '').join('\n');

    const next = await generate(prompt, s);
    if (next === '') return s.mood;
    s.mood = next;
    s.regressCount += 1;
    s.lastError = '';
    log('debug', `心情平复 ${chatId}`, { mood: next, regressCount: s.regressCount });
    return next;
  }

  /** 对所有会话做一次平复（定时任务用）。 */
  async function regressAll(now = Date.now()) {
    for (const chatId of [...states.keys()]) {
      await regress(chatId, now);
    }
  }

  /**
   * 全部会话的当前心情快照（`{chatId: mood}`）。
   *
   * ⚠️ **只为可观测性存在，不参与任何判断逻辑。**
   *
   * 为什么要有它（2026-10-14）：心情原本是**纯内存状态**，
   * `qq-proactive-debug.json` 里一个字都没有 ⇒ "它到底跑没跑、现在是什么心情"
   * 只能靠猜 —— 而心情是**每条入站消息都可能触发一次 LLM 调用**的东西，
   * 看不见它就等于看不见一笔持续的账。
   *
   * ⚠️ 返回的是**浅拷贝**：调用方拿去序列化时不会碰到内部 Map。
   * 还没更新过任何会话时返回 `{}` —— **空也必须是"看得出来的空"**，
   * 不能和"没接上"混成一个 `null`（所以调用方拿到的是对象，不是 null）。
   *
   * @returns {Record<string, string>}
   */
  function getAllMoods() {
    const out = {};
    for (const [chatId, s] of states) out[String(chatId)] = String(s.mood);
    return out;
  }

  /**
   * 各会话的心情**诊断计数**（`{chatId: {calls, tries, fails, lastTryAt, lastChangeAt, lastError}}`）。
   *
   * ⚠️ **只为可观测性存在，不参与任何判断逻辑。**
   *
   * 为什么必须有它（2026-10-15）：`getAllMoods()` 只说"现在是什么心情"，
   * 而 `getMood()` 会**顺手创建默认值** ⇒ 快照里出现 `"感觉很平静"` 时，
   * 「没触发过」「触发了但抛错」「生成了、恰好就是这个词」**三者完全同形**。
   * 2026-10-14~15 我就是卡在这个歧义上没法判断 30B 那条路到底通没通。
   *
   * ⇒ `calls`/`tries`/`fails` 一摆出来，四种状态立刻分得开（见 `states` 的判别矩阵）。
   * `lastError` 尤其关键：**它是这个模块唯一的失败出口**。
   *
   * @returns {Record<string, {calls:number, tries:number, fails:number, lastTryAt:number, lastChangeAt:number, lastError:string}>}
   */
  function getMoodDiag() {
    const out = {};
    for (const [chatId, s] of states) {
      out[String(chatId)] = {
        calls: s.calls ?? 0,
        tries: s.tries ?? 0,
        fails: s.fails ?? 0,
        lastTryAt: s.lastTryAt ?? 0,
        lastChangeAt: s.lastChangeAt ?? 0,
        lastError: String(s.lastError ?? ''),
      };
    }
    return out;
  }

  return { getMood, updateMood, regress, regressAll, getAllMoods, getMoodDiag };
}

/**
 * 把"心情"压成快照里那一段（`debug-snapshot.mjs` 用）。
 *
 * 形状：
 * ```js
 * { enabled, provider, model, reasoningEffort, states: { "group:123": "当前心情" } }
 * ```
 *
 * **两个刻意的选择**：
 *
 * 1. **`mood === null` 时仍然返回对象**（`enabled:false` + `states:null`），
 *    而不是返回 `null` 让整段消失 —— "关掉了"和"没接上"在快照里必须分得开，
 *    而"整段没有"这两种都可能。配置值照抄下来，用户才能看见"关掉的是哪条路"。
 * 2. **`states` 空就是 `{}`**，不是 `null`：空 = "接着的，但还没更新过"，
 *    这正是排查"它到底跑没跑"时要的那个信息。
 *
 * 取不到东西时不抛异常（调试设施绝不拖垮主流程），退化成字段为空的形状。
 *
 * @param {{getAllMoods?: () => Record<string, string>, getMoodDiag?: () => Record<string, object>}|null} mood
 * @param {{enabled?: boolean, provider?: string, model?: string, reasoningEffort?: string}} [config]
 * @returns {{enabled: boolean, provider: string, model: string, reasoningEffort: string, states: Record<string,string>|null, diag: Record<string,object>|null}}
 */
export function moodSnapshotState(mood, config = {}) {
  const cfg = config !== null && typeof config === 'object' ? config : {};
  const enabled = cfg.enabled === true;
  const base = {
    enabled,
    provider: String(cfg.provider ?? ''),
    model: String(cfg.model ?? ''),
    reasoningEffort: String(cfg.reasoningEffort ?? ''),
  };
  let states = null;
  let diag = null;
  if (mood !== null && mood !== undefined) {
    try {
      states = typeof mood.getAllMoods === 'function' ? mood.getAllMoods() : {};
      if (states === null || typeof states !== 'object' || Array.isArray(states)) states = {};
    } catch {
      states = {};
    }
    try {
      diag = typeof mood.getMoodDiag === 'function' ? mood.getMoodDiag() : {};
      if (diag === null || typeof diag !== 'object' || Array.isArray(diag)) diag = {};
    } catch {
      diag = {};
    }
  }
  return { ...base, states, diag };
}

// 2026-10-14 16:5x 逼重载：让 toml 的 [mood] 新值被读到（改 toml 必须碰一次 src/）

// ⚠️ 2026-10-15：`reasoningEffort` 这一项**必须和 cordis.patch.yml 里的模型声明配成一对**，
//    单改一边都会静默失败（这个模块的失败是"返回空文本"，不抛错、计数正常）：
//      · 模型条目只有 id+name ⇒ 传任何档位（含 'off'）都抛 UNSUPPORTED_REASONING_EFFORT
//        （dsh-llm/lib/index.js L2169-2184）；
//      · 模型条目声明了档位、但调用方一个字段都不发（空串）⇒ 端点默认开思考
//        ⇒ maxTokens 全被推理吃掉 ⇒ 模型返回空文本。
//    ⇒ 正确组合：patch 里 `reasoningEfforts: {off: null, low: low}` + `compat.thinkingFormat: qwen`，
//      调用方传 `reasoningEffort: 'off'`。两边都改完**要再逼一次重载**（改 toml 不会自己生效）。
