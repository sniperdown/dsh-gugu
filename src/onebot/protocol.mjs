/**
 * OneBot 11 协议层：消息段解析、CQ 码、事件归一化。
 *
 * 纯函数，零依赖，零网络。这一层是 QQ 插件里最容易出错的地方——不是因为它复杂，
 * 而是因为 NapCat / Lagrange / go-cqhttp 在细节上各有偏差，而偏差只在真机上暴露。
 * 所以把它单独切出来，用表格驱动的方式全量测。
 *
 * 协议参考：OneBot 11 标准 https://github.com/botuniverse/onebot-11
 *
 * @module qq-onebot/protocol
 */

/**
 * OneBot 消息段。`type` 是段类型，其余字段随类型而变。
 * @typedef {{ type: string } & Record<string, unknown>} Segment
 */

/**
 * 归一化后的入站消息——这是插件其余部分唯一需要认识的形状。
 * 刻意与 OneBot 的原始事件解耦：真机偏差全部在这一层被吸收。
 *
 * @typedef {object} InboundMessage
 * @property {string} chatId      `private:<QQ>` 或 `group:<群号>`
 * @property {'private'|'group'} kind
 * @property {string} userId      发送者 QQ
 * @property {string} nickname    昵称/群名片（已清理，可直接展示）
 * @property {string} text        纯文本正文（非文本段压成占位符、**@ 段渲染成 `@目标`**，已去首尾空白）
 * @property {number} at          事件时间戳（毫秒）
 * @property {boolean} mentioned  是否 @ 了机器人（或回复了机器人）
 * @property {boolean} replyToSelf 是否是"引用回复机器人"（`mentioned` 有一部分来自它）
 * @property {boolean} mentionsOthers 是否有 @ 段、且 @ 的**不是**机器人（判定层用来压 content 分）
 * @property {string} [replyToId] 被引用消息的 id（`reply` 段的 `id`）。
 *   **不是判定信号**（判定只看 `replyToSelf`），只是给提示词用：
 *   网关拿它回查转录，把被引用的原文一起塞进提示词（见 `gateway.mjs` 的 `#quoteLines`）。
 *   段里没有可用 id（畸形段 / 实现不给）时不设这个键。
 * @property {number} [messageId]
 * @property {string} [groupId]
 * @property {string} [selfId]
 * @property {Segment[]} segments 原始消息段（媒体处理要用）
 * @property {string} raw         `raw_message` 原文（诊断用）
 */

/** 非文本段 → 占位符。占位符进上下文是为了让模型知道"这里有个东西"。 */
export const SEGMENT_PLACEHOLDERS = {
  image: '[图片]',
  // 语音（B4，2026-10-25 真机定论）：NapCat 的 record 段**不带任何转写**
  // （实测键只有 `file` / `path` / `url` / `file_size`）⇒ 内容她真的听不到。
  // 所以占位符必须把"未转写"说出来 —— 光写 `[语音]` 她会当成"听过了"，
  // 然后按想象回答（比沉默更糟）。
  record: '[语音（未转写）]',
  video: '[视频]',
  file: '[文件]',
  face: '[表情]',
  mface: '[表情]',
  json: '[卡片]',
  xml: '[卡片]',
  music: '[音乐]',
  forward: '[合并转发]',
  // 回复引用**仍然不占正文位置**，但它的 id 现在会被单独留一份
  // （`InboundMessage.replyToId`，2026-11-02）—— 正文不变、判定不变，
  // 只是"被引用的是哪一条"从"整段丢弃"变成"另存一个字段"。
  reply: '',
  // ⚠️ `at` **刻意不在这张表里**：它不是一个"这里有个东西"的占位符，而是**内容** ——
  // 必须渲染出"@ 的是谁"（见 `formatAtSegment`）。
  // 曾经写成 `at: ''`，而下面 `placeholder !== ''` 才 push，于是 `@黑猫 你看看`
  // 到达模型时只剩 `你看看`：**目标是谁、甚至"这里发生过一个 @"都丢了**。
  poke: '[戳一戳]',
  rps: '[猜拳]',
  dice: '[骰子]',
  shake: '[窗口抖动]',
  share: '[链接分享]',
  contact: '[推荐联系人]',
  location: '[位置]',
  markdown: '[富文本]',
  node: '[转发节点]',
};

/** `@全体成员` 的渲染文本（OneBot 用 `qq: 'all'` 表示）。 */
export const AT_ALL_TEXT = '@全体成员';

/**
 * at 段 → 正文里的 `@目标`。
 *
 * **实测事实**（2026-10-06，`get_group_msg_history` 群 200000002 的 100 条里
 * 20 个 at 段）：NapCat 的 at 段只有 `{type:'at', data:{qq}}` ——
 * `qq` 是**字符串**（`"10000003"` / `"all"`），`data` 的键只有 `qq`，
 * **没有任何昵称/名字字段**。
 * （2026-10-14 又用真机历史复核了一遍：测试群 40 条、群 30000011 30 条、
 *  群 30000014 20 条，at 段的键集合仍然**只有 `{qq}`**。）
 *
 * ⇒ 所以取名顺序是：
 *   1. **段上带的昵称**（`name` / `nickname` / `card`）—— NapCat 不带，
 *      这是给别的实现（Lagrange 等）留的容错；
 *   2. **名字表**（`resolveAt`）—— **现实中的主路径**：NapCat 不给名字，
 *      所以由插件自己从每条消息的 `sender` 攒一张 `QQ → 昵称` 的表
 *      （`dsh/nicknames.mjs`），渲染时查它；
 *   3. `qq` 号 —— 查不到时的**退化行为**（2026-10-14 用户明确要求保留：
 *      「查不到怎么办 ⇒ 保留现在的退化行为（`@QQ号`），别改成别的」）；
 *   4. 裸 `@` —— 连 qq 都没有的畸形段也不静默消失
 *      （同「未知段类型有兜底占位符」的规矩）。
 *
 * ⚠️ **`resolveAt` 抛异常不许影响渲染**：名字表是锦上添花，
 * 它坏了的后果只能是"这次退回 `@QQ号`"，绝不能变成"正文渲染不出来"。
 *
 * @param {{type?: string} & Record<string, unknown>} segment 已压平或未压平（`data` 嵌套）都认
 * @param {object} [options]
 * @param {(qq: string, groupId?: string) => string} [options.resolveAt]
 *   查名字的函数（**由调用方注入**：`protocol.mjs` 是纯函数层，不认识任何表）。
 *   返回空串 = 查不到。抛异常也当查不到。
 * @param {string} [options.groupId] 当前会话的群号（`(群, QQ) → 群名片` 那一层要用）
 * @returns {string} 非空串（最差是 `@`）
 */
export function formatAtSegment(segment, { resolveAt, groupId } = {}) {
  const qq = segment?.qq ?? segment?.data?.qq;
  const target = qq === undefined || qq === null ? '' : String(qq).trim();
  if (target === 'all') return AT_ALL_TEXT;

  const name = sanitizeNickname(
    segment?.name ?? segment?.nickname ?? segment?.card
      ?? segment?.data?.name ?? segment?.data?.nickname ?? segment?.data?.card,
  ).replace(/^@+/, '');
  if (name !== '') return `@${name}`;

  // ② 名字表：`@某人` 要渲染成 `@昵称`，而不是 `@QQ号`（2026-10-14）。
  if (typeof resolveAt === 'function' && target !== '') {
    try {
      const looked = sanitizeNickname(resolveAt(target, groupId)).replace(/^@+/, '');
      if (looked !== '') return `@${looked}`;
    } catch {
      /* 查表坏了 ⇒ 照旧退化成 @QQ号（下面那行） */
    }
  }
  return target === '' ? '@' : `@${target}`;
}

/**
 * CQ 码反转义。**NapCat 会把 URL 里的 `&` 转成 `&amp;`**，不反转义去下载
 * 图片就会 403——这是 dsh-onebot 的 DEVLOG 里记的真实事故，这里直接吸收。
 * @param {string} value
 * @returns {string}
 */
export function cqUnescape(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/**
 * CQ 码转义（出站方向）。
 * @param {string} value
 * @returns {string}
 */
export function cqEscape(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

/**
 * 解析 CQ 字符串为段数组。仅在实现只给 `raw_message` 不给段数组时作为回退路径。
 *
 * 标准要求实现上报段数组（`message`），但 go-cqhttp 老配置与部分实现只给 CQ 串，
 * 所以这条路必须留着——而且它必须是**回退**，不是主路径。
 *
 * @param {string} raw
 * @returns {Segment[]}
 */
export function parseCqString(raw) {
  if (typeof raw !== 'string' || raw === '') return [];
  const segments = [];
  // [CQ:type,key=value,...] —— 用非贪婪匹配到第一个 `]`。
  const pattern = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const before = raw.slice(cursor, match.index);
    if (before !== '') segments.push({ type: 'text', text: cqUnescape(before) });
    cursor = match.index + match[0].length;

    const fields = {};
    const body = match[2] ?? '';
    if (body !== '') {
      for (const pair of body.slice(1).split(',')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const key = pair.slice(0, eq);
        if (key === '') continue;
        fields[key] = cqUnescape(pair.slice(eq + 1));
      }
    }
    segments.push({ type: match[1], ...fields });
  }
  const tail = raw.slice(cursor);
  if (tail !== '') segments.push({ type: 'text', text: cqUnescape(tail) });
  return segments;
}

/**
 * 把任意形态的 `message` 字段收敛成段数组。
 * 段数组优先，字符串走 CQ 解析回退。
 *
 * 段数组里的字符串值一律过一遍 CQ 反转义：NapCat 的 `&amp;` 转义**不只出现在
 * CQ 串里**，段数组的 `url` 字段同样会被转义。不处理的话拿这个 URL 去下载
 * 图片就是 403——这正是历史上踩过的坑。
 *
 * @param {unknown} message
 * @param {string} [raw]
 * @returns {Segment[]}
 */
export function toSegments(message, raw) {
  if (Array.isArray(message)) {
    const out = [];
    for (const item of message) {
      if (item === null || typeof item !== 'object') continue;
      const type = item.type;
      if (typeof type !== 'string' || type === '') continue;
      // **把 `data` 压平到顶层。**
      //
      // OneBot 规范的段形状是 `{type, data:{...}}`，而本模块其余部分一律读顶层
      // （`segment.text`、`segment.qq`、`segment.url`…）。历史上这里只做了 CQ
      // 反转义、没有压平，后果是**真实 NapCat（messagePostFormat: "array"）来的
      // 消息全是空文本、且永远检测不到 @**：
      //   `{type:'text', data:{text:'hi'}}` → segmentsToText → `""`
      //   `{type:'at',   data:{qq:...}}`    → detectMention → false
      //
      // 测试一直绿，是因为项目里的夹具手写成已压平的 `{type:'text', text:'hi'}`
      // —— 又一个"测试替身与真实对端不一致"的盲区（同握手 key、同 OneBot 请求
      // 格式）。所以修在源头：两种形状都接受，统一输出压平形状。
      const segment = { ...item, type };
      if (segment.data !== null && typeof segment.data === 'object') {
        for (const [key, value] of Object.entries(segment.data)) {
          if (segment[key] === undefined) segment[key] = value;
        }
      }
      for (const [key, value] of Object.entries(segment)) {
        if (key === 'type' || key === 'data') continue;
        if (typeof value === 'string') segment[key] = cqUnescape(value);
      }
      out.push(segment);
    }
    if (out.length > 0) return out;
    // 段数组是空数组时，仍可能 raw 里有内容（实现异常），回退。
  }
  if (typeof message === 'string' && message !== '') return parseCqString(message);
  if (typeof raw === 'string' && raw !== '') return parseCqString(raw);
  return [];
}

/**
 * 段数组 → 纯文本。非文本段压成占位符，**@ 段渲染成 `@目标`**。
 * @param {Segment[]} segments
 * @param {object} [options]
 * @param {boolean} [options.keepPlaceholders] false 则丢掉所有占位符
 * @param {boolean} [options.keepMentions] false 则连 `@目标` 一起丢掉。
 *   给"这条消息到底说没说话"的判断用（`@小鲸鱼` 却没打字仍该算空正文），
 *   别拿去构造给模型看的正文。
 * @param {boolean} [options.trim] false 则保留每段自带的空白（不 `trim`）。
 *   段与段之间的分隔空格**在文本段自己的开头**（`@黑猫` + `" 你看看"`），
 *   调用方若用 `''` 拼接就必须留着它，否则会粘成 `@黑猫你看看`。
 * @param {(qq: string, groupId?: string) => string} [options.resolveAt]
 *   查名字的函数（见 {@link formatAtSegment}）。不给 ⇒ @ 段落回退成 `@QQ号`。
 * @param {string} [options.groupId] 当前会话的群号（查群名片那一层要用）
 * @returns {string}
 */
export function segmentsToText(segments, {
  keepPlaceholders = true,
  keepMentions = true,
  trim = true,
  resolveAt,
  groupId,
} = {}) {
  const parts = [];
  for (const segment of segments) {
    if (segment.type === 'text') {
      const text = typeof segment.text === 'string' ? segment.text : '';
      if (text !== '') parts.push(text);
      continue;
    }
    if (!keepPlaceholders) continue;
    // `at` 是内容，不是"这里有个东西"的占位符：必须渲染出 **@ 的是谁**。
    if (segment.type === 'at') {
      if (keepMentions) parts.push(formatAtSegment(segment, { resolveAt, groupId }));
      continue;
    }
    // 语音（B4，2026-10-25）：**本部署的 NapCat 不给转写**（真机实测：record 段的
    // 键只有 `file`/`path`/`url`/`file_size`，没有 `text`）⇒ 走向下面的
    // `[语音（未转写）]`。这里保留"有 text 就用"的分支：换实现 / 以后 NapCat
    // 开始给转写时，这一段**一个字都不用改**就能用上。
    if (segment.type === 'record') {
      const spoken = typeof segment.text === 'string' ? segment.text.trim() : '';
      if (spoken !== '') {
        parts.push(`[语音：${spoken}]`);
        continue;
      }
    }
    const placeholder = SEGMENT_PLACEHOLDERS[segment.type];
    if (placeholder === undefined) parts.push(`[${segment.type}]`);
    else if (placeholder !== '') parts.push(placeholder);
  }
  const joined = parts.join('');
  return trim ? joined.trim() : joined;
}

/**
 * 该消息是否 @ 了机器人。
 *
 * **fail-closed**：不知道机器人 QQ 时一律视为「没有 @」。多回一句废话的代价
 * 远小于在群里对每条消息都应答。
 *
 * **段数组是权威**：只要段数组非空就只看段数组，绝不回头查 `raw_message`。
 * 否则当实现上报的段数组与 CQ 串不一致时（真实发生过），raw 里的陈旧 @ 码
 * 会把一条普通消息误判成 @ 机器人。
 * 段数组**完全为空**（老实现只给 CQ 串）时才走 CQ 串回退。
 *
 * @param {Segment[]} segments
 * @param {string} raw
 * @param {string} selfId 机器人 QQ（来自事件或配置）
 * @param {string} [botQQ] 配置里显式指定的机器人 QQ
 * @returns {boolean}
 */
export function detectMention(segments, raw, selfId, botQQ) {
  const targets = new Set();
  if (isNonEmptyString(selfId)) targets.add(String(selfId));
  if (isNonEmptyString(botQQ)) targets.add(String(botQQ));
  if (targets.size === 0) return false;

  const authoritative = Array.isArray(segments) && segments.length > 0;

  if (authoritative) {
    for (const segment of segments) {
      if (segment.type !== 'at') continue;
      const qq = segment.qq;
      if (qq === undefined || qq === null) continue;
      const text = String(qq);
      if (text === 'all') continue;
      if (targets.has(text)) return true;
    }
    return false;
  }

  // 回退：段数组为空，只能看 CQ 串。
  if (typeof raw === 'string' && raw.includes('[CQ:at')) {
    for (const target of targets) {
      if (raw.includes(`qq=${target}]`)) return true;
    }
  }
  return false;
}

/**
 * 这条消息是否 @ 了**别人**（不是机器人自己）。
 *
 * 用户 2026-10-07 定的规则：「别人 @ 别人和小鲸鱼关系太小了，content 那边 +3 分算了，
 * 一般情况下不吭声，只有之前各种分攒多了才会说一声」。
 * 所以判定层需要知道"这条消息里的 @ 是不是冲着小鲸鱼来的"。
 *
 * 与 `detectMention` 的关系：
 *   - `detectMention` 问的是「有没有 @ 机器人」（驱动"要不要回"）；
 *   - 这里问的是「有 @，但那些 @ 都不是机器人」。
 * 两者**互补但不互斥**：一条消息可以既 @ 了小鲸鱼又 @ 了别人（那时 `detectMention`
 * 为真、这条为真，判定层按"被点名"处理，不受 +3 规则影响）。
 *
 * `@全体成员`（`qq: 'all'`）算「不是小鲸鱼」→ 也走 +3。它是广播，不是在跟小鲸鱼说话；
 * 按字面口径（"@ 的不是小鲸鱼"）就该这么算。
 *
 * 段数组是权威（同 `detectMention`）：`normalizeEvent` 已保证段数组非空。
 *
 * @param {Segment[]} segments
 * @param {string} selfId 机器人 QQ（来自事件）
 * @param {string} [botQQ] 配置里显式指定的机器人 QQ
 * @returns {boolean}
 */
export function detectMentionOfOthers(segments, selfId, botQQ) {
  const targets = new Set();
  if (isNonEmptyString(selfId)) targets.add(String(selfId));
  if (isNonEmptyString(botQQ)) targets.add(String(botQQ));
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (segment === null || typeof segment !== 'object' || segment.type !== 'at') continue;
    const qq = segment.qq ?? segment.data?.qq;
    if (qq === undefined || qq === null) continue;
    // 缺 qq 的畸形 at 段不算"@ 了别人"（它连目标都没有）。
    if (!targets.has(String(qq))) return true;
  }
  return false;
}

/**
 * 该消息是否是「回复机器人自己的消息」——也算提及。
 * 判定不了时返回 false（fail-closed）。
 *
 * ⚠️ **真机事实（2026-11-02 复核）**：本机 NapCat 的 reply 段**只有 `id`**，
 * 没有 `user_id` / `qq` ⇒ 这个函数在真机上**恒为 false**。
 * 不是本次改出来的，也**没有**在此改动（判定的语义归 `src/proactive/engine.mjs`）——
 * 需要"引的是谁"的地方请用 {@link detectReplyToId} 回查，别指望这个布尔。
 *
 * @param {Segment[]} segments
 * @param {string} selfId
 * @returns {boolean}
 */
export function isReplyToSelf(segments, selfId) {
  if (!isNonEmptyString(selfId)) return false;
  for (const segment of segments) {
    if (segment.type !== 'reply') continue;
    // 部分实现给 user_id，部分只给 id；只在能判定时才认。
    const userId = segment.user_id ?? segment.userId;
    if (userId !== undefined && String(userId) === String(selfId)) return true;
  }
  return false;
}

/**
 * 取出「被引用消息」的 id —— `reply` 段里的 `id`（2026-11-02）。
 *
 * ## 真机形状（2026-11-02 用本机 NapCat 的 `get_group_msg_history` 复核）
 *
 * 段数组里是**规范形状** `{type:'reply', data:{id:'<数字串>'}}`，
 * CQ 串里是 `[CQ:reply,id=<数字串>]`；**两种都只有 `id` 一个键** ——
 * 没有 `qq` / `user_id` / 内嵌原文（`text`）。所以这里只认 `id`。
 *
 * 被引用的数字就是那条消息自己的 `message_id`（夹具里 6 条实例全部对得上），
 * 所以拿它 `String()` 之后能直接和转录里的 `messageId` 比。
 *
 * ⚠️ 与 {@link isReplyToSelf} 的关系：**两件事**。
 *   - `isReplyToSelf` 问"引的是不是机器人自己"（判定层用，只看 `user_id`——真机
 *     NapCat 不给这个键，所以它在真机上恒为 false，见那边的注释）；
 *   - 这里问"引的是哪一条"（提示词层用，只看 `id`）。
 * 刻意**不合并**：合并会改掉 `mentioned` / `replyToSelf` 的既有语义，
 * 而那两条是发言准入判定的输入（`engine.mjs` 的 `#gate`）。
 *
 * @param {Segment[]} segments
 * @returns {string} 被引用消息的 id；没有 reply 段 / 段里没 id ⇒ 空串
 */
export function detectReplyToId(segments) {
  if (!Array.isArray(segments)) return '';
  for (const segment of segments) {
    if (segment === null || typeof segment !== 'object' || segment.type !== 'reply') continue;
    // `toSegments` 已经把 `data` 压平到顶层；两种形状都认（同 `at` 段那条口径）。
    const raw = segment.id ?? segment.data?.id;
    if (raw === undefined || raw === null) continue;
    const id = String(raw).trim();
    if (id !== '') return id;
  }
  return '';
}

/**
 * 清理昵称：把换行/制表等控制字符**替换成空格**再压空白（不是直接删掉——
 * 直接删会让 `阿\n猫` 粘成 `阿猫`），并截断到 32 字，防止昵称撑爆消息前缀。
 * @param {unknown} nickname
 * @returns {string}
 */
export function sanitizeNickname(nickname) {
  if (typeof nickname !== 'string') return '';
  return nickname
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

/** 会话标识。 */
export function buildChatId(kind, target) {
  return `${kind}:${target}`;
}

/**
 * 解析会话标识。
 * @param {string} chatId
 * @returns {{kind:'private'|'group', target:string}}
 */
export function splitChatId(chatId) {
  const text = String(chatId ?? '');
  const index = text.indexOf(':');
  if (index === -1) throw new Error(`无效的 chatId：${JSON.stringify(chatId)}`);
  const kind = text.slice(0, index);
  const target = text.slice(index + 1);
  if (kind !== 'private' && kind !== 'group') {
    throw new Error(`无效的会话类型：${JSON.stringify(kind)}`);
  }
  if (!/^\d+$/.test(target)) {
    throw new Error(`无效的会话目标：${JSON.stringify(target)}`);
  }
  return { kind, target };
}

/**
 * 把 OneBot 事件归一化成 InboundMessage。
 *
 * 返回 `null` 表示"这不是一条要处理的消息"（元事件、机器人自己发的、群系统提示等）。
 * **归一化失败绝不抛异常**——一条畸形事件不能炸掉整个消息循环。
 *
 * @param {any} event
 * @param {object} [options]
 * @param {string} [options.botQQ]
 * @param {boolean} [options.ignoreSelf]
 * @param {(qq: string, groupId?: string) => string} [options.resolveAt]
 *   `QQ → 昵称` 的查表函数（见 {@link formatAtSegment}）。**由调用方注入**
 *   （生产上是 `dsh/nicknames.mjs` 那张表），因为这一层是纯函数、不认识任何表。
 *   不给 / 查不到 ⇒ `@` 段落回退成 `@QQ号`（原有行为）。抛异常也当查不到。
 * @returns {InboundMessage|null}
 */
export function normalizeEvent(event, { botQQ, ignoreSelf = true, resolveAt } = {}) {
  if (event === null || typeof event !== 'object') return null;
  if (event.post_type !== 'message') return null;

  const messageType = event.message_type;
  if (messageType !== 'private' && messageType !== 'group') return null;

  const selfId = event.self_id === undefined || event.self_id === null ? '' : String(event.self_id);
  const senderId = event.user_id === undefined || event.user_id === null ? '' : String(event.user_id);
  if (senderId === '') return null;

  // 防自循环：机器人自己发的消息（含其他账号形状）直接忽略。
  if (ignoreSelf) {
    if (selfId !== '' && senderId === selfId) return null;
    if (isNonEmptyString(botQQ) && senderId === String(botQQ)) return null;
  }

  // 群系统提示（匿名开关变更等）不是人说的话。
  if (messageType === 'group' && event.sub_type === 'notice') return null;

  const segments = toSegments(event.message, event.raw_message);
  // 段数组与 raw 双双缺失 = 内容字段损坏。这不是"一条空消息"，是坏事件，
  // 返回 null 让上层跳过，而不是把空文本喂进上下文。
  if (segments.length === 0) return null;
  const raw = typeof event.raw_message === 'string' ? event.raw_message : '';
  const groupId = event.group_id === undefined || event.group_id === null ? '' : String(event.group_id);
  if (messageType === 'group' && groupId === '') return null;

  const sender = event.sender !== null && typeof event.sender === 'object' ? event.sender : {};
  const nickname =
    sanitizeNickname(sender.card) || sanitizeNickname(sender.nickname) || senderId;

  // `mentioned` 把「@ 我」和「引用回复我」合并成一个信号（判定层用它做"被点名"）。
  // `replyToSelf` 单独留一份，因为两者在有些地方**必须区分**：
  //   - 「纯 @ 没打字」= 叫我一声，要回
  //   - 「引用我但没打字」= 更像手滑，静默
  // 早先只算了 `mentioned`，于是 heuristic-gauge 里那条 `replyToSelf: +35`
  // 的相关性加成**一直是死代码**（字段压根不存在，恒为 undefined）。
  const replyToSelf = isReplyToSelf(segments, selfId);
  /**
   * 「引用了哪一条」（2026-11-02 加）。**只给提示词用**，不进任何判定：
   * 判定侧照旧只看 `mentioned` / `replyToSelf`（见上一段注释）。
   */
  const replyToId = detectReplyToId(segments);
  const mentioned = detectMention(segments, raw, selfId, botQQ) || replyToSelf;
  /**
   * `@` 了**别人**（不是小鲸鱼）。判定层用它把 content 压到 +3（见 `heuristic-gauge`）。
   *
   * 刻意与 `mentioned` 并存而不是二选一：引用回复别人的消息也可能带 at 段，
   * 而"@ 的是谁"和"是不是在叫我"是两件事。
   */
  const mentionsOthers = detectMentionOfOthers(segments, selfId, botQQ);

  const time = Number(event.time);
  const at = Number.isFinite(time) && time > 0 ? time * 1000 : Date.now();

  const text = segmentsToText(segments, { resolveAt, groupId });
  const messageId = Number(event.message_id);

  /** @type {InboundMessage} */
  const normalized = {
    chatId: messageType === 'group' ? buildChatId('group', groupId) : buildChatId('private', senderId),
    kind: messageType,
    userId: senderId,
    nickname,
    text,
    at,
    mentioned,
    replyToSelf,
    mentionsOthers,
    segments,
    raw,
  };
  if (Number.isFinite(messageId)) normalized.messageId = messageId;
  if (replyToId !== '') normalized.replyToId = replyToId;
  if (groupId !== '') normalized.groupId = groupId;
  if (selfId !== '') normalized.selfId = selfId;
  return normalized;
}

/**
 * 把待发送的文本转成消息段数组。
 *
 * ⚠️ **注意形状**：这里产出的是**压平**形状（`{type:'text', text}`），那是
 * `toSegments` 对**入站**做归一化的产物。出站发到 NapCat 的那一端要的是
 * **规范形状**（`{type, data:{…}}`）—— 见 {@link imageSegment} 的说明。
 * 文本段恰好两种实现都认（NapCat 的 `text` 段两种写法都能解析），
 * 但**图片段不行**，别把这里的形状当成出站模板。
 *
 * 本函数目前**没有生产调用方**（只有测试），保留是为了兼容既有契约。
 *
 * @param {string} text
 * @returns {Segment[]}
 */
export function textToSegments(text) {
  const body = typeof text === 'string' ? text : String(text ?? '');
  return body === '' ? [] : [{ type: 'text', text: body }];
}

/**
 * 组装一条「@ 某人 + 正文」的消息。群聊里主动发言应在开头 @ 相关的人，
 * 否则没人知道你在跟谁说话。
 *
 * ⚠️ 与 {@link textToSegments} 同一个坑：这是**压平**形状，**没有生产调用方**
 * （只有测试）。真往外发要用 `{type:'at', data:{qq}}`（见 {@link imageSegment}）。
 *
 * @param {string} userId
 * @param {string} text
 * @returns {Segment[]}
 */
export function mentionSegments(userId, text) {
  const segments = [];
  if (isNonEmptyString(userId)) segments.push({ type: 'at', qq: String(userId) });
  const body = typeof text === 'string' ? text : '';
  if (body !== '') {
    if (segments.length > 0) segments.push({ type: 'text', text: ' ' });
    segments.push({ type: 'text', text: body });
  }
  return segments;
}

/**
 * 一条出站消息最多带几张图。
 *
 * 与入站的 `MAX_IMAGES_PER_MESSAGE`（4）**刻意不同**：入站多收几张是"看得见"，
 * 出站多发几张是"刷屏"。3 张足够表达，也让一次发送的载荷有上界。
 */
export const MAX_OUTBOUND_IMAGES = 3;

/**
 * 出站**图片段**：产出 OneBot 11 的**规范形状** `{type:'image', data:{…}}`。
 *
 * ## ⚠️ 为什么是 `data` 嵌套，而不是本项目内部那个压平形状
 *
 * 这是**本次改动里唯一一处刻意的形状分歧**，理由全是硬的：
 *
 * 1. **本项目从来没有真的发过段数组。** `textToSegments` / `mentionSegments`
 *    那两个压平形状的构造函数**只有测试在调**（生产代码一处都没有），
 *    也就是说"压平形状能发出去"这件事**从未被验证过**。
 * 2. **本机唯一验证过的发图实现用的是 `data` 嵌套**：
 *    `dsh-onebot-qq/lib/tools.js` 的 `qq_send_image` 发的是
 *    `{type:'image', data:{url}}` / `{type:'image', data:{file:'base64://…'}}`，
 *    它的 `lib/interim.js` 也是 `{type:'image', data:{file: b64}}`。
 * 3. **OneBot 11 规范与 NapCat 自己的 schema 都是 `{type, data}`**：
 *    NapCat 的 `OB11MessageImage` 定义在 `D:\QQNT\napcat\napcat.mjs` 里，
 *    运行期读段也是 `seg.data.file` / `seg.data.id`（`aye()` 那段）。
 *
 * 压平形状是 **`toSegments` 对入站的归一化产物**，把它当出站模板是"从内部
 * 表示反推线上协议"——那正是本项目栽过三次的那类错误（握手 key、`params` 包装、
 * `data` 没压平）。所以这里**照已验证的线上形状写**，不照内部形状写。
 *
 * ## 接受的输入
 *
 * - 字符串：`http(s)://…` → `{url}`；其余（绝对路径 / `file://` / `base64://`）→ `{file}`
 * - 对象：`{url}` / `{file}` / `{path}`（后两者等价，`file` 优先）
 * - 已经是图片段（`type === 'image'`）：把 `data` 里的 `url`/`file` 归一化后重发
 *
 * 认不出（空、非图片、既没有 url 也没有 file）返回 `null` —— 调用方跳过它，
 * 绝不发一个半残的段出去。
 *
 * @param {unknown} source
 * @returns {{type: 'image', data: {url?: string, file?: string}}|null}
 */
export function imageSegment(source) {
  const pick = (obj, key) => {
    if (obj === null || typeof obj !== 'object') return '';
    const raw = obj[key] ?? obj.data?.[key];
    return typeof raw === 'string' ? raw.trim() : '';
  };

  // 已经是图片段：把两种形状都收敛到规范形状。
  if (source !== null && typeof source === 'object' && String(source.type ?? '') === 'image') {
    const url = pick(source, 'url');
    if (url !== '') return { type: 'image', data: { url } };
    const file = pick(source, 'file') || pick(source, 'path');
    if (file !== '') return { type: 'image', data: { file } };
    return null;
  }

  if (typeof source === 'string') {
    const text = source.trim();
    if (text === '') return null;
    return /^https?:\/\//i.test(text)
      ? { type: 'image', data: { url: text } }
      : { type: 'image', data: { file: text } };
  }

  if (source !== null && typeof source === 'object') {
    const url = pick(source, 'url');
    if (url !== '') return { type: 'image', data: { url } };
    const file = pick(source, 'file') || pick(source, 'path');
    if (file !== '') return { type: 'image', data: { file } };
  }
  return null;
}

/**
 * 组装一条**出站消息**：正文 + 若干图片。
 *
 * ## 没有图片时返回**字符串**，不是单段数组
 *
 * 这个"返回两种类型"的签名是**有意的**，而且是本次改动"不弄坏文本路径"的核心：
 * 出站有 6 个调用点，其中 4 个是纯文本回复。只要没有图片就**原样返回那个字符串**
 * —— 与改动前**逐字节相同**的载荷、相同的传输层分支、相同的测试断言。
 * 想"统一成段数组更干净"的人请注意：那会让所有文本回复的线上形态一起变，
 * 而段数组这条路在本项目**从来没有真机验证过**（见 {@link imageSegment}）。
 *
 * 有图片时产出 `[{type:'text', data:{text}}, …图片段]`（正文为空则不发空文本段）。
 *
 * ## 🔴 2026-10-26 真机教训：段数组里的文本段**也必须是 `data` 嵌套**
 *
 * 这里原来写的是**压平**的 `{type:'text', text}`（本项目内部那个形状）。
 * 纯文本路径发的是**字符串**，从来没暴露它；而"图文一起发"时正文会被包成段，
 * 于是 NapCat 直接报：
 *
 * ```
 * {"status":"failed","retcode":200,
 *  "message":"Cannot read properties of undefined (reading 'text')"}
 * ```
 *
 * 实测对照（同一张 png，`send_msg` 段数组）：
 *
 * | 载荷 | 结果 |
 * |---|---|
 * | `[{type:'text', text:'…'}]` | ❌ `Cannot read properties of undefined (reading 'text')` |
 * | `[{type:'text', data:{text:'…'}}]` | ✅ `message_id` |
 * | `[{type:'image', data:{file}}]` | ✅（图片段本来就是嵌套的） |
 *
 * ⇒ **出站的一切段都照 OneBot 11 的规范形状写**：`{type, data:{…}}`。
 * 压平形状只属于**入站归一化**（`toSegments`），别拿它当出站模板。
 * 回归：`test/outbound-image.test.mjs` 有一条"文本段必须是 data 嵌套"的用例。
 *
 * @param {string} text
 * @param {unknown[]} [images] 图片源（见 {@link imageSegment}）；认不出的**静默跳过**
 * @returns {string|Array<object>}
 */
export function outboundMessage(text, images = []) {
  const body = typeof text === 'string' ? text : String(text ?? '');
  const list = Array.isArray(images) ? images : [];
  const segments = [];
  for (const source of list) {
    if (segments.length >= MAX_OUTBOUND_IMAGES) break;
    const seg = imageSegment(source);
    if (seg === null) continue;
    segments.push(seg);
  }
  if (segments.length === 0) return body;
  return body === '' ? segments : [{ type: 'text', data: { text: body } }, ...segments];
}

/**
 * 出站**语音段**（2026-10-26）：产出 OneBot 11 的 `{type:'record', data:{…}}`。
 *
 * ## 形状照「已验证的线上形状」写，理由同 {@link imageSegment}
 *
 * `send_msg` 的段数组这条路**发图已经真机验过**，语音走的是同一套转换管线：
 * `createSendElements` 按 `type` 分派 → `record` 走 `createValidSendPttElement`
 * （内部把非 silk 的音频用 native addon 转成 silk）。2026-10-26 真机实测：
 * 传一个**本地 mp3 绝对路径**，QQ 侧落库是 `type:"record"`、文件头 `#!SILK_V3`、`send_msg` 往返 0.70 s。
 *
 * ## 接受的输入
 *
 * - 字符串：`http(s)://…` → `{url}`；其余（绝对路径 / `file://` / `base64://`）→ `{file}`
 * - 对象：`{url}` / `{file}` / `{path}`，**`file` 优先**（`path` 只是别名）
 *
 * 认不出（空、非字符串且没有 url/file/path）返回 `null` —— 调用方**跳过它**，
 * 绝不发一个半残的段出去（半个段在 QQ 上就是一条红叹号）。
 *
 * @param {unknown} source
 * @returns {{type: 'record', data: {url?: string, file?: string}}|null}
 */
export function voiceSegment(source) {
  const pick = (obj, key) => {
    if (obj === null || typeof obj !== 'object') return '';
    const raw = obj[key] ?? obj.data?.[key];
    return typeof raw === 'string' ? raw.trim() : '';
  };

  // 已经是语音段：把两种形状都收敛到规范形状（幂等 —— 传进来再传一次不会变形）。
  if (source !== null && typeof source === 'object' && String(source.type ?? '') === 'record') {
    const url = pick(source, 'url');
    if (url !== '') return { type: 'record', data: { url } };
    const file = pick(source, 'file') || pick(source, 'path');
    if (file !== '') return { type: 'record', data: { file } };
    return null;
  }

  if (typeof source === 'string') {
    const text = source.trim();
    if (text === '') return null;
    return /^https?:\/\//i.test(text)
      ? { type: 'record', data: { url: text } }
      : { type: 'record', data: { file: text } };
  }

  if (source !== null && typeof source === 'object') {
    const url = pick(source, 'url');
    if (url !== '') return { type: 'record', data: { url } };
    const file = pick(source, 'file') || pick(source, 'path');
    if (file !== '') return { type: 'record', data: { file } };
  }
  return null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}
