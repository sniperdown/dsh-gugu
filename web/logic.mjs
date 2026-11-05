/**
 * 配置页的纯逻辑：字段选择、标签文字、整段折叠、草稿比较、写入结果文案。
 *
 * ## 这一层的来源
 *
 * 以下函数与常量**逐字搬自** `client.js` 的「配置页（scope + key 契约）的纯逻辑」一节，
 * 不是另外写的一份实现。搬移而不是重写的原因有两条：
 *
 * 1. 这些判定一旦写错，在浏览器里只表现为某一行不出现、多出一个输入框，
 *    或者一段本应折叠的字段冒出来，没有任何报错线索；
 * 2. 两处实现只要有一句文案不同，同一个写入在旧界面和新界面会给出不同的结论。
 *
 * ## 与 `client.js` 的关系
 *
 * `client.js` 是经典脚本（宿主要求），不能 `import` 本模块；因此目前
 * **两份逻辑并存**，暂时只能靠测试各自钉住。第三步会把 `client.js` 里的配置界面
 * 删掉、只留遥控器卡片，届时应把 `client.js` 里的这一节整体去掉，本模块成为唯一来源。
 * 在那之前，改动其中一份必须同步另一份（`test/web-config-page.test.mjs` 会核对
 * 两份的常量与关键文案是否一致）。
 *
 * 本模块不访问 DOM、不发请求、不读全局状态，可直接在 Node 里 import 后测试。
 *
 * @module qq-web/logic
 */

/**
 * toml 段名到卡片标题的映射表，同时决定「原文件」页卡片的默认排列顺序。
 *
 * 元素为 `[段名, 标题]` 二元数组。新增段落时必须在此追加，否则该段落会排在
 * 所有已登记段落之后；未登记的段由 {@link sectionTitle} 回落为段名本身。
 */
export const SECTION_TITLES = [
  ['personality', '人格'],
  ['agent', '推理等级'],
  ['owner', '用户'],
  ['free_time', '定时任务'],
  ['memory', '记忆'],
  ['send', '发 QQ 的规矩'],
  ['mood', '心情'],
  ['proactive', '判定模式'],
];

/**
 * 字段 key 到界面显示名的映射表。
 *
 * 宿主载荷只提供 key / section / scope / value / type / effective，不提供 label，
 * 因此显示名只能维护在客户端。新增字段时须同步补一条，否则界面会直接显示 key
 * （不隐藏、不留空：显示 key 至少能定位到配置项）。
 */
export const FIELD_LABELS = {
  personality: '人格',
  reply_style: '表达风格',
  emotion_style: '情绪特征',
  interest: '兴趣',
  rules: '行为规则',
  admins: '用户 QQ',
  'free_time.enabled': '定时任务开关',
  'free_time.intervalHours': '间隔（小时）',
  'free_time.followupMinutes': '追问间隔（分钟）',
  'free_time.windowStartHour': '窗口开始（时）',
  'free_time.windowEndHour': '窗口结束（时）',
  'free_time.tokenBudgetPerTurn': '单轮 token 预算',
  'free_time.quietWhenNothing': '没什么可说时保持安静',
  'free_time.wakePrompt': '长唤醒提示词',
  'free_time.followupPrompt': '短追问提示词',
  'free_time.screenshots': '唤醒前截屏（每块屏一张）',
  'free_time.screenshotsKeep': '截图保留轮数（每轮=每块屏一张）',
  'free_time.screenshotsMaxPerWake': '每轮最多带几张截图',
  'memory.learned_enabled': '学来的记忆',
  'memory.inject_max_chars': '注入字数上限',
  'memory.inject_private_as_section': '私聊知识走 section',
  'send.rule': '发送消息的规则',
  'mood.enabled': '心情更新开关',
  'mood.provider': '心情 provider',
  'mood.model': '心情 model',
  'proactive.judge_mode': '判定模式',
};

/**
 * 字段的**一句说明**（显示在控件下面那行小字），键为字段 key。
 *
 * 和 {@link FIELD_LABELS} 同一个道理：宿主载荷不提供说明文字，只提供
 * key / section / scope / value / type / effective，所以说明维护在客户端。
 * 没登记 ⇒ 不显示说明（**不留空行**：空白说明比没有说明更像坏了）。
 *
 * 只写"改了会怎样 / 留空是什么意思"这类**操作后果**，不写实现细节。
 */
export const FIELD_HINTS = {
  'free_time.wakePrompt': '留空 = 用内置文案。占位符：{{budget}} 换成预算数字，{{date}} / {{time}} 换成这次唤醒的日期与时刻。',
  'free_time.followupPrompt': '留空 = 用内置文案。占位符：{{minutes}} 换成追问间隔的分钟数，{{date}} / {{time}} 换成这次唤醒的日期与时刻。',
  'free_time.screenshotsKeep': '磁盘上留最近几轮（一轮 = 一次唤醒 = 每块屏一张）。管的是删旧图，不是这一轮带几张。',
  'free_time.screenshotsMaxPerWake': '这一轮最多按屏幕顺序带前几张给模型；和上面的「保留轮数」是两件事。',
};

/**
 * 取字段的说明文字（没有则空串）。
 *
 * 载荷自带 `hint` 时以载荷为准，其次回落到 {@link FIELD_HINTS}；
 * 前后空白裁掉，空白等于"没有说明"。
 */
export function fieldHint(field) {
  const fromPayload = textOf(field && field.hint).trim();
  if (fromPayload !== '') return fromPayload;
  return FIELD_HINTS[textOf(field && field.key)] || '';
}

/**
 * enum 类型字段的可选值表，键为字段 key，值为候选值数组。
 *
 * 宿主载荷只声明 `type: 'enum'`；若载荷自带 `options`，以载荷为准，
 * 回落逻辑见 {@link fieldOptions}。
 */
export const ENUM_OPTIONS = { 'proactive.judge_mode': ['heuristic', 'precheck', 'inTurn'] };

/**
 * 危险键清单，决定写入前是否需要二次确认。
 *
 * 内容须与宿主 `src/dsh/toml-edit.mjs` 的 `DANGER_KEYS` 保持一致：写入这些键时
 * 若不带 `confirm: true`，宿主返回 400（需要二次确认）。命中口径见
 * {@link isDangerFieldKey}（整键命中，或末段命中）。
 */
export const DANGER_KEYS = ['allowFrom', 'groupAllowFrom', 'provider', 'model', 'admins'];

/**
 * 会话层（`private:<号>` / `group:<号>`）允许显示的字段白名单，即人格五段。
 *
 * 阈值类字段不参与会话层判定，因此不在会话层出现。给出一个改了也不生效的输入框
 * 会误导使用者，故直接不渲染。数组顺序即会话层字段的显示顺序，见
 * {@link selectScopeFields}。
 */
export const SCOPE_KEEP_KEYS = ['persona', 'reply_style', 'emotion_style', 'interest', 'rules'];

/**
 * 通道页第二张卡按**单个字段**划出来的项。
 *
 * `rules` 与人格段里其余字段同处 `[personality]`，但它属于行为规矩，
 * 不跟人格正文放在一张卡片里；因此按 key 点名，而不是按段划。
 */
export const CHANNEL_SECOND_CARD_KEYS = ['rules'];

/**
 * 通道页第二张卡按**段**划出来的项，数组顺序即显示顺序。
 *
 * 顺序刻意不跟 {@link SECTION_TITLES}：那张卡片按「发 QQ → 记忆 → 判定」
 * 读起来才连贯（`SECTION_TITLES` 是原文件页的卡片顺序，管的是另一页）。
 */
export const CHANNEL_SECOND_CARD_SECTIONS = ['send', 'memory', 'proactive'];

/**
 * 分组条出现的门槛：一段**至少 2 项**才折叠，只有 1 项时直接平铺成一行。
 *
 * 折叠条是给"一长串字段"用的收纳手段；只有 1 项的段折起来只是多一次点击，
 * 还会让人以为那里藏着别的东西。`[agent]`（推理等级）就是只有 1 项的那一段。
 */
export const SECTION_FOLD_MIN_FIELDS = 2;

/** 这一段是否值得折叠。非数字按 0 处理（宁可不折叠，也不隐藏内容）。 */
export function sectionFoldable(fieldCount) {
  const count = typeof fieldCount === 'number' && Number.isFinite(fieldCount) ? fieldCount : 0;
  return count >= SECTION_FOLD_MIN_FIELDS;
}

/** 该字段是否属于通道页的第二张卡（行为规则 / 发 QQ 的规矩 / 记忆 / 判定模式）。 */
export function isSecondCardField(field) {
  if (field === null || typeof field !== 'object') return false;
  if (CHANNEL_SECOND_CARD_KEYS.includes(textOf(field.key))) return true;
  return CHANNEL_SECOND_CARD_SECTIONS.includes(textOf(field.section));
}

/**
 * 把通道页的字段切成两张卡片的内容，**保持传入顺序**。
 *
 * 返回 `{ first, second }`：`first` 留在人格/会话卡，`second` 进第二张卡。
 * 本函数不按作用域过滤，调用方先经 {@link selectScopeFields} 取当前作用域的字段。
 */
export function splitChannelCardFields(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const first = [];
  const second = [];
  for (const field of list) {
    // 2026-10-30：旁路模型拆成独立文件后各自有标签页（心情/识图/表情包/语音），
    // 「自定义」页只管主文件 —— 这里按 `file` 挡掉旁路的字段，否则同一条设置
    // 会在两个页上各出现一次，改哪边生效取决于谁先保存，纯属自找。
    const file = textOf(field && field.file);
    if (file !== '' && file !== 'main') continue;
    // 提示词那几句在主文件里，但归「提示词」标签页（2026-10-30）。
    if (textOf(field && field.section) === 'prompt') continue;
    if (isSecondCardField(field)) second.push(field);
    else first.push(field);
  }
  return { first, second };
}

/**
 * 第二张卡的分组：先按 {@link CHANNEL_SECOND_CARD_KEYS} 逐字段成组，再按
 * {@link CHANNEL_SECOND_CARD_SECTIONS} 的顺序把各段接上。
 *
 * 每项为 `{ key, section, title, fields }`。`key` 只用作渲染 key 与折叠状态键，
 * 与段名同名（单字段组的 key 就是字段 key，不会与段名撞）。空组不产出。
 */
export function channelSecondCardGroups(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const groups = [];
  for (const key of CHANNEL_SECOND_CARD_KEYS) {
    const own = list.filter((field) => textOf(field && field.key) === key);
    if (own.length === 0) continue;
    groups.push({
      key,
      section: textOf(own[0].section),
      title: FIELD_LABELS[key] || key,
      fields: own,
    });
  }
  for (const section of CHANNEL_SECOND_CARD_SECTIONS) {
    const own = list.filter((field) => textOf(field && field.section) === section
      && !CHANNEL_SECOND_CARD_KEYS.includes(textOf(field && field.key)));
    if (own.length === 0) continue;
    groups.push({ key: section, section, title: sectionTitle(section), fields: own });
  }
  return groups;
}

/**
 * 整段折叠的分界字段：该字段及其之前的字段默认显示，其后的字段归入折叠段。
 *
 * 「原文件」页与「通道」页共用同一套分组、切分与文案函数
 * （{@link splitRawGroups} / {@link splitChannelGroups} / {@link rawFoldLabel}），
 * 两页的措辞与数量算法因此完全一致。
 */
export const RAW_FOLD_AFTER_KEY = 'interest';

/** 多行输入框的默认行数：固定三行，需要查看全文时由双击放大承担。 */
export const TEXTAREA_ROWS = 3;

/**
 * 放大态估算折行时使用的每行字符数：96。
 *
 * 取值依据：等宽字体 12.5px、输入框占满整行（约 820px）时可容纳的字符数，
 * 并向下取整作为保守估计。该值只影响放大态的高度，不影响内容本身。
 */
export const TEXTAREA_CHARS_PER_LINE = 96;

/**
 * 写入成功后的固定后缀。文案里必须出现「重载后生效」，否则使用者会以为保存即生效。
 *
 * 旧界面（`client.js`）的这句还提到「重载」标签页；独立网页没有那一页，
 * 因此由调用方通过 {@link describeWriteResults} 的第二个参数覆盖。
 */
export const RELOAD_HINT = '重载后生效（重载仍要手动点「重载」标签页）';

/** 把任意值安全地转成字符串，`null` 与 `undefined` 统一转为空串。 */
export function textOf(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 取字段的界面显示名。
 *
 * 不返回空串：显示名缺失时宁可显示 key，也不要留空，否则界面上会出现一行
 * 没有名字的控件，无法判断它对应哪个配置项。
 */
export function fieldLabel(field) {
  const key = textOf(field && field.key);
  // 2026-10-30：宿主现在把 `label` 一起发过来。
  // **顺序是"客户端表 → 宿主 label → key"**：
  //   · 表里的老名字是用户看惯的（`rules` = 「行为规则」，不是「硬规矩」），不能因为宿主换了个名字就跳；
  //   · 表里没有的新字段 ⇒ 用宿主给的中文名，**不用再改两次**；
  //   · 都没有 ⇒ 显示 key（不隐藏、不留空：至少能定位到配置项）。
  return FIELD_LABELS[key] || textOf(field && field.label) || key;
}

/**
 * 这个字段能不能和别的**挤在一行里**（2026-10-30）。
 *
 * 判据是"控件有多宽"而不是"字段是什么语义"：
 * - `number` / `bool` / `enum` ⇒ 窄，一行放 2~3 个；
 * - `text` / `multiline` / `array` 可能是路径、提示词、名单 ⇒ 整行。
 *
 * 故意**不**按"值短不短"动态判：值一改布局就跳，输入到一半控件会跑掉。
 */
export function fieldCompact(field) {
  const type = textOf(field && field.type);
  return type === 'number' || type === 'bool' || type === 'enum';
}

/** 取 toml 段对应的卡片标题；未登记的段回落为段名本身。 */
export function sectionTitle(section) {
  const name = textOf(section);
  const hit = SECTION_TITLES.find((item) => item[0] === name);
  return hit === undefined ? name : hit[1];
}

/**
 * 取 enum 字段的候选值。
 *
 * 优先采用载荷自带的 `options`，其次才用 {@link ENUM_OPTIONS}；返回副本而非原数组，
 * 避免调用方修改到常量表。
 */
export function fieldOptions(field) {
  if (field && Array.isArray(field.options) && field.options.length > 0) return field.options.slice();
  return (ENUM_OPTIONS[textOf(field && field.key)] || []).slice();
}

/**
 * 从作用域标识解析出作用域种类。
 *
 * 只识别 `global`、`private:<号>`、`group:<号>` 三种形式。识别失败返回空串，
 * 由调用方决定如何回落；本函数不擅自把未知形式当成 global。
 */
export function scopeKindOf(scopeId) {
  const id = textOf(scopeId);
  if (id === 'global') return 'global';
  const match = /^(private|group):(\d+)$/.exec(id);
  return match === null ? '' : match[1];
}

/**
 * 判断某个字段 key 是否属于危险键。
 *
 * 整键命中 {@link DANGER_KEYS}，或其最后一个点号之后的段命中，均返回 true。
 * 口径必须与宿主一致，否则确认条与实际拦截行为会对不上：`mood.provider`
 * 与 `mood.model` 同样算危险键（末段为 provider / model）。
 */
export function isDangerFieldKey(key) {
  const text = textOf(key).trim();
  if (text === '') return false;
  if (DANGER_KEYS.includes(text)) return true;
  const parts = text.split('.');
  return DANGER_KEYS.includes(parts[parts.length - 1]);
}

/**
 * 把宿主给出的 `scopes` 整理成二级标签所需的显示数据。
 *
 * 顺序为 global、私聊、群；同一类内部保持 `scopes` 中的原始顺序。每项为
 * `{ id, kind, top, bottom, twoLine, badge, overriddenCount }`。
 *
 * `name` 为空时只显示 `idText`，不生成占位名字：群名由宿主异步补拉，
 * 首次 GET 时可能为空，编造一个名字会让人误以为群名就是该文本。
 */
export function scopeTabs(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  const globals = list.filter((item) => scopeKindOf(item && item.id) === 'global');
  const privates = list.filter((item) => scopeKindOf(item && item.id) === 'private');
  const groups = list.filter((item) => scopeKindOf(item && item.id) === 'group');
  const ordered = globals.concat(privates, groups);
  return ordered.map((item) => {
    const id = textOf(item && item.id);
    const kind = scopeKindOf(id);
    const top = textOf(item && item.name).trim();
    const bottom = textOf(item && item.idText).trim();
    const overridden = Array.isArray(item && item.overridden) ? item.overridden : [];
    return {
      id,
      kind,
      top,
      bottom,
      twoLine: top !== '',
      badge: overridden.length > 0 ? '有覆盖' : '',
      overriddenCount: overridden.length,
    };
  });
}

/**
 * 校正当前选中的作用域。
 *
 * `wanted` 存在于列表时原样返回，否则返回 `global`。白名单或会话层覆盖被改动后，
 * 原选中项可能已不存在；不回落会让「按会话配置」出现一个没有任何字段的空列表。
 */
export function resolveScopeId(tabs, wanted) {
  const list = Array.isArray(tabs) ? tabs : [];
  const id = textOf(wanted);
  if (list.some((tab) => tab.id === id)) return id;
  return 'global';
}

/**
 * 计算某个作用域下应当显示哪些字段。
 *
 * global 返回该作用域的字段并去掉 `admins`（用户名单由身份卡单独负责，两处各存
 * 一份草稿会互相覆盖）；会话层只返回人格五段，并按 {@link SCOPE_KEEP_KEYS} 排序。
 */
export function selectScopeFields(fields, scopeId) {
  const list = Array.isArray(fields) ? fields : [];
  const id = textOf(scopeId) || 'global';
  const kind = scopeKindOf(id);
  const mine = list.filter((field) => textOf(field && field.scope) === id);
  if (kind !== 'private' && kind !== 'group') {
    return mine.filter((field) => textOf(field && field.key) !== 'admins');
  }
  return mine
    .filter((field) => SCOPE_KEEP_KEYS.includes(textOf(field && field.key)))
    .sort(
      (left, right) => SCOPE_KEEP_KEYS.indexOf(textOf(left && left.key))
        - SCOPE_KEEP_KEYS.indexOf(textOf(right && right.key)),
    );
}

/**
 * 某个作用域**能写**的全部字段。
 *
 * 与 {@link selectScopeFields} 的差别只有一条：global 作用域返回**全部**字段
 * （含 `admins`），会话层仍然只是人格五段。
 *
 * 为什么 global 要含 `admins`：它在界面上由「身份」卡单独渲染（`selectScopeFields`
 * 故意把它摘掉，免得两张卡各存一份草稿互相覆盖），但**「保存全部」必须收得到它**——
 * 少了它，身份卡上改的用户名单就落在收集范围之外，那正是"改了没保存"的形状。
 */
export function writableScopeFields(fields, scopeId) {
  const list = Array.isArray(fields) ? fields : [];
  const id = textOf(scopeId) || 'global';
  if (scopeKindOf(id) === 'global') {
    return list.filter((field) => textOf(field && field.scope) === id);
  }
  return selectScopeFields(list, id);
}

/**
 * 把一批字段按 `section` 分组，一组对应一张卡片。
 *
 * 排列顺序按 {@link SECTION_TITLES}；未登记的段按出现顺序接在末尾，字段不会丢失。
 * 本函数不按作用域过滤，调用方负责先过滤：「原文件」页经
 * {@link groupFieldsBySection} 过滤，「通道」页的字段已由
 * {@link selectScopeFields} 过滤。
 */
export function groupFields(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const buckets = new Map();
  for (const field of list) {
    const section = textOf(field && field.section);
    if (!buckets.has(section)) buckets.set(section, []);
    buckets.get(section).push(field);
  }
  const order = SECTION_TITLES
    .map((item) => item[0])
    .filter((section) => buckets.has(section));
  for (const section of buckets.keys()) {
    if (!order.includes(section)) order.push(section);
  }
  return order.map((section) => ({
    section,
    title: sectionTitle(section),
    fields: buckets.get(section),
  }));
}

/**
 * 「原文件」页的分组入口：先取指定作用域的字段，再按 section 分组。
 *
 * 只取指定作用域的字段，因此「原文件」页显示的是基准值，不含会话层覆盖。
 */
export function groupFieldsBySection(fields, scopeId) {
  const list = Array.isArray(fields) ? fields : [];
  const id = textOf(scopeId) || 'global';
  return groupFields(list.filter((field) => textOf(field && field.scope) === id));
}

/**
 * 按分界字段把分组切成「显示段」与「折叠段」两部分。
 *
 * 返回 `{ shown, folded, boundary }`。分界字段本身留在显示段，其后的字段全部归入
 * 折叠段（不是压低高度，而是不渲染）。分界字段不存在时返回
 * `{ shown: 原数组副本, folded: [], boundary: '' }`。
 *
 * 分界字段若不位于某段末尾，该段会被切开，同一段落因此出现两张卡片
 * （前一半显示、后一半折叠），这是预期行为而非缺陷。
 */
export function splitRawGroups(groups, boundaryKey) {
  const list = Array.isArray(groups) ? groups : [];
  const key = textOf(boundaryKey) || RAW_FOLD_AFTER_KEY;
  const shown = [];
  const folded = [];
  let passed = false;
  let hit = false;
  for (const group of list) {
    if (group === null || typeof group !== 'object') continue;
    const fields = Array.isArray(group.fields) ? group.fields : [];
    if (passed) {
      if (fields.length > 0) folded.push({ ...group, fields });
      continue;
    }
    const at = fields.findIndex((field) => textOf(field && field.key) === key);
    if (at === -1) {
      if (fields.length > 0) shown.push({ ...group, fields });
      continue;
    }
    hit = true;
    shown.push({ ...group, fields: fields.slice(0, at + 1) });
    if (at + 1 < fields.length) folded.push({ ...group, fields: fields.slice(at + 1) });
    passed = true;
  }
  if (!hit) return { shown: list.slice(), folded: [], boundary: '' };
  return { shown, folded, boundary: key };
}

/**
 * 「通道」页 global 作用域的分组与折叠，完全复用「原文件」页的整套逻辑。
 *
 * 入参必须已经按作用域过滤（通道页传入 `currentFields`）；通道页的用户在身份卡内、
 * 不在该列表中，因此段名与字段数量按通道页的实际字段计算，不得写死具体数字。
 */
export function splitChannelGroups(fields, boundaryKey) {
  return splitRawGroups(groupFields(fields), boundaryKey);
}

/**
 * 生成折叠条上的文案，形如「记忆 / 心情 —— 共 6 个字段 [展开 ▾]」。
 *
 * 分组为空时以「其余字段」代替段名；字段总数为 0 时仍返回完整句式。
 * 文案只陈述事实，不评价字段内容；方括号后缀随 `open` 在展开与收起之间切换。
 */
export function rawFoldLabel(foldedGroups, open) {
  const groups = Array.isArray(foldedGroups) ? foldedGroups : [];
  const titles = groups
    .map((group) => textOf(group && group.title) || textOf(group && group.section))
    .filter((title) => title !== '');
  const count = groups.reduce(
    (sum, group) => sum + (Array.isArray(group && group.fields) ? group.fields.length : 0),
    0,
  );
  const what = titles.length === 0 ? '其余字段' : titles.join(' / ');
  return `${what} —— 共 ${count} 个字段 ${open === true ? '[收起 ▴]' : '[展开 ▾]'}`;
}

/**
 * 生成通道页分段折叠条的文案，形如「▸ 定时任务　8 项」。
 *
 * 与 {@link rawFoldLabel} 并列使用，两者互不替代：前者管整段字段的折叠，
 * 后者管通道页每一段的独立折叠。
 */
export function sectionFoldLabel(title, count, open) {
  return `${open ? '▾' : '▸'} ${textOf(title)}　${count} 项`;
}

/**
 * 把文件值转换成控件中的草稿值。
 *
 * `bool` 返回布尔；`array` 返回以逗号连接的字符串；其余返回字符串。
 *
 * `value === null`（文件中未写）必须转为空串，不得把 null 原样回传，
 * 否则宿主按非法值处理并返回 400。
 */
export function draftFromField(field) {
  if (field === null || field === undefined) return '';
  const value = field.value;
  switch (textOf(field.type)) {
    case 'bool':
      return value === true;
    case 'array':
      return Array.isArray(value) ? value.join(', ') : textOf(value);
    default:
      return textOf(value);
  }
}

/**
 * 生成草稿表的键。
 *
 * `prefix` 为空时返回 key，否则返回 `${prefix}::${key}`。
 *
 * 会话层必须带前缀：人格五段在全局、私聊与各群使用同一批 key（personality、rules 等），
 * 不带前缀时会出现「在 A 群改过人格，切到 B 群看到 A 的草稿」，此时按保存会把
 * A 的文本写入 B。
 */
export function draftKey(prefix, key) {
  const name = textOf(key);
  const scope = textOf(prefix);
  return scope === '' ? name : `${scope}::${name}`;
}

/**
 * 读取某个字段当前的草稿值。
 *
 * 草稿表中已存在时返回它；不存在时现取 {@link draftFromField} 的结果，即文件值。
 * 草稿表只保存改动过的字段，因此文件值刷新时未改动过的控件会跟着更新，
 * 不会拿着一份过期快照写回文件。
 */
export function draftOf(store, prefix, field) {
  const key = draftKey(prefix, field && field.key);
  const table = store === null || store === undefined ? {} : store;
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  return draftFromField(field);
}

/**
 * 把列表文本切成字符串数组。
 *
 * 按英文逗号、中文逗号、顿号、分号与空白切分；结果去空、去重并保持原有顺序。
 * 分隔符集合须同时覆盖中英文输入法：只认英文逗号时，用中文逗号输入的名单
 * 会被当成一个号码。
 */
export function splitList(text) {
  const out = [];
  for (const item of textOf(text).split(/[\s,，、;；]+/)) {
    const value = item.trim();
    if (value !== '' && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * 比较两个字段值是否相等。
 *
 * 数组按顺序逐项比较（顺序有意义：`admins` 的第一个元素才是用户号码）；
 * 布尔按真假比较，字符串 `'true'` 视为真；其余按文本比较。
 */
export function sameFieldValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    const a = (Array.isArray(left) ? left : splitList(left)).map(textOf);
    const b = (Array.isArray(right) ? right : splitList(right)).map(textOf);
    return a.join('\u0000') === b.join('\u0000');
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return (left === true || left === 'true') === (right === true || right === 'true');
  }
  return textOf(left) === textOf(right);
}

/**
 * 判断某项草稿相对文件值是否发生过改动。
 *
 * 没有改动就不提交：这是 `value === null` 时唯一正确的处理方式。不提交不等于清空；
 * 提交空串会删掉文件中已有的值。
 */
export function draftChanged(field, draft) {
  if (field === null || field === undefined) return false;
  const before = draftFromField(field);
  const type = textOf(field.type);
  if (type === 'bool') return (draft === true) !== (before === true);
  if (type === 'array') return splitList(draft).join(',') !== splitList(before).join(',');
  if (type === 'number') {
    const a = Number(textOf(draft).trim());
    const b = Number(textOf(before).trim());
    // 两侧都能解析为数字时按数值比较，3 与 3.0 视为同一值。任一侧无法解析时退回
    // 文本比较，使非法输入仍会被提交，由宿主返回「不是合法数字」，而不是在此处静默丢弃。
    if (Number.isFinite(a) && Number.isFinite(b)) return a !== b;
    return textOf(draft).trim() !== textOf(before).trim();
  }
  return textOf(draft) !== textOf(before);
}

/**
 * 把草稿转换成可以提交给宿主的值。
 *
 * `bool` 返回布尔；`array` 返回数组；`number` 以字符串返回（由宿主完成数字校验，
 * 客户端不预先拦截）；其余返回字符串。空串表示明确的清空：会话层清空等于删除
 * 该条覆盖并回退到基准值。
 */
export function submitValueFor(field, draft) {
  if (field === null || field === undefined) return draft;
  switch (textOf(field.type)) {
    case 'bool':
      return draft === true;
    case 'array':
      return splitList(draft);
    case 'number':
      return textOf(draft).trim();
    default:
      return textOf(draft);
  }
}

/**
 * 生成控件的占位文字。
 *
 * 值为 null 时返回说明缺失原因的文案（全局为「按默认值」，会话层为「继承基准值」）；
 * `array` 类型返回输入格式说明；其余返回空串。文案必须说清「文件里没写」，
 * 否则一个空输入框会被误认为功能异常。
 */
export function fieldPlaceholder(field) {
  if (field === null || field === undefined) return '';
  if (field.value === null || field.value === undefined) {
    return scopeKindOf(field.scope) === 'global'
      ? '（文件里未写，按默认值）'
      : '（文件里未写，继承基准值）';
  }
  if (textOf(field.type) === 'array') return '一行一个（也可以用英文逗号分隔）';
  return '';
}

/**
 * 判断字段的文件值是否尚未生效。
 *
 * 两者不同即返回 true；`value` 为 null 时返回 false：文件里没写不能算作
 * 「写了但未生效」，否则每个未配置的字段都会挂上未生效标记，标记本身失去意义。
 */
export function fieldInactive(field) {
  if (field === null || field === undefined) return false;
  if (field.value === null || field.value === undefined) return false;
  if (sameFieldValue(field.value, field.effective)) return false;
  // 多行文本**尾随空白不算改动**（2026-10-29 线上误报）。
  //
  // 现场：`[personality] reply_style` 写成 `"""` 块，parseToml 读回来**保留结尾换行**
  // （309 字节），而进程里那份在拼人格时被 trim 过（308 字节）⇒ `fieldInactive` 判
  // "文件值 ≠ 生效值" ⇒ 用户一个字节都没改，页面上却挂着「未生效（重载后生效）」。
  // 只有 reply_style 中招、另外四段没中，就是因为只有它以换行结尾。
  //
  // ⚠️ 归一**只做在这里**，不进 `sameFieldValue` / `draftChanged`：
  // 那两处判的是"用户改没改"，末尾空格是真实改动，不该被吞掉；
  // 这里判的是"该不该提示没生效"，尾随空白不改变生效结果。
  if (typeof field.value === 'string' && typeof field.effective === 'string') {
    return field.value.trim() !== field.effective.trim();
  }
  return true;
}

/** 从备份路径中取出文件名；Windows 与 POSIX 两类分隔符都要识别。 */
export function backupBasename(backupPath) {
  const text = textOf(backupPath).trim();
  if (text === '') return '';
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/**
 * 把逐字段的写入结果汇总成一行提示文案。
 *
 * 返回 `{ kind, text }`，`kind` 为 `'error'` / `'ok'` / `'info'` 之一。四条口径：
 *
 * 1. `wrote: false` 表示值没有变化、也没有产生备份，不属于失败；
 * 2. 成功时显示备份文件名与 TOML 校验结论；
 * 3. 失败时原样带出宿主给出的 `error`，宿主给了 `line` 就附上行号，不得吞掉；
 * 4. 写入成功不等于生效，因此文案末尾固定追加一条重载提示。
 *
 * 第二个参数覆盖末尾的重载提示：旧界面写「重载」标签页，独立网页没有那一页，
 * 由调用方给出符合当前界面的说法。缺省值与原实现逐字一致。
 */
export function describeWriteResults(results, reloadHint = RELOAD_HINT) {
  const list = Array.isArray(results) ? results : [];
  const failed = list.find((item) => item !== null && item !== undefined && item.ok === false);
  if (failed !== undefined) {
    const line = failed.line === null || failed.line === undefined ? '' : `（第 ${failed.line} 行）`;
    const what = textOf(failed.label) || textOf(failed.key) || '字段';
    // 宿主给出的 detail 说明校验未通过的具体原因（例如段头缺少右方括号）。必须一并
    // 带出，否则界面只剩「TOML 校验未通过」一句，使用者无法自行修正。
    const detail = textOf(failed.detail).trim();
    return {
      kind: 'error',
      text: `${what} 写入失败：${textOf(failed.error) || '宿主没有给出原因'}${line}${detail === '' ? '' : `：${detail}`}`,
    };
  }
  const wrote = list.filter(
    (item) => item && item.ok === true && item.payload && item.payload.wrote === true,
  );
  const unchanged = list.filter(
    (item) => item && item.ok === true && item.payload && item.payload.wrote === false,
  );
  const parts = [];
  if (wrote.length > 0) {
    const names = wrote
      .map((item) => backupBasename(item.payload.backup))
      .filter((name) => name !== '');
    if (names.length === 0) parts.push('已写入（宿主未回备份路径）；TOML 校验通过');
    else if (names.length === 1) parts.push(`已备份（${names[0]}）；TOML 校验通过`);
    else parts.push(`已备份 ${names.length} 份（${names[0]} 等）；TOML 校验通过`);
  }
  if (unchanged.length > 0) parts.push(`${unchanged.length} 项值没有变化，未写入`);
  if (parts.length === 0) return { kind: 'info', text: '没有改动' };
  parts.push(textOf(reloadHint) || RELOAD_HINT);
  return { kind: wrote.length > 0 ? 'ok' : 'info', text: parts.join(' · ') };
}

/**
 * 生成危险键的后果说明，供内联确认条显示。
 *
 * 只陈述实际后果，不写评价与情绪词。未命中任何已知危险键时返回通用提示
 * 「写入会立刻改文件，但不会触发重载」。
 */
export function dangerNote(keys) {
  const list = Array.isArray(keys) ? keys : [];
  const notes = [];
  const has = (name) => list.some((key) => textOf(key) === name || textOf(key).endsWith(`.${name}`));
  if (has('admins')) {
    notes.push('⚠️ 用户号码取列表第一个：定时任务叫醒的私聊是 private:<第一个号>；为空时回退白名单第一个。');
  }
  if (has('provider') || has('model')) {
    notes.push('⚠️ provider / model 决定请求发往哪个端点：填错时这一步请求会失败。');
  }
  if (has('allowFrom') || has('groupAllowFrom')) {
    notes.push('⚠️ 白名单收紧会让她不再回应名单外的人。');
  }
  if (notes.length === 0) notes.push('写入会立刻改文件，但不会触发重载。');
  return notes.join(' ');
}

/**
 * 把配置值转成表单控件可显示的字符串。
 *
 * `kind` 为 `stringList` 时数组以「逗号 + 空格」连接；`null` 与 `undefined`
 * 返回空串。返回值用于比较是否改动，因此同一组值必须稳定地转成同一个字符串。
 */
export function toInputValue(field, value) {
  if (value === undefined || value === null) return '';
  if (field.kind === 'stringList') {
    return Array.isArray(value) ? value.join(', ') : String(value);
  }
  return String(value);
}

/**
 * 判断字段是否使用「可双击放大」的多行文本框。
 *
 * 仅 `type` 为 `'multiline'` 时返回 true。`array` 类型同样渲染为多行文本框，
 * 但它表示的是一份名单而非长文本，因此不参与放大：同样占三行高，双击不改变布局。
 */
export function isZoomableField(field) {
  if (field === null || typeof field !== 'object') return false;
  return textOf(field.type) === 'multiline';
}

/**
 * 计算放大状态下多行输入框应有的行数。
 *
 * 按显式换行与按字符数折算的折行数相加，最少三行、不设上限；内容为空时返回三行。
 * 结果只用于 `rows` 属性；内容高于一屏时的滚动由样式中的 `max-height` 与
 * `overflow-y` 承担，不在此处截断。
 */
export function textareaZoomRows(value) {
  const text = textOf(value);
  if (text === '') return TEXTAREA_ROWS;
  let lines = 0;
  for (const line of text.split('\n')) {
    lines += Math.max(1, Math.ceil(line.length / TEXTAREA_CHARS_PER_LINE));
  }
  return Math.max(TEXTAREA_ROWS, lines);
}

/**
 * 生成多行输入框的悬停提示文字。
 *
 * 文案必须与当前可执行的动作一致：已放大时「双击收回」，否则「双击放大」。
 */
export function zoomTitle(zoomed) {
  return zoomed === true ? '双击收回' : '双击放大';
}

/**
 * 生成放大状态的键。
 *
 * 与草稿表同口径（见 {@link draftKey}），必须带作用域前缀：人格五段在各会话同名，
 * 不带前缀时在一个会话放大，切到另一个会话仍显示为放大状态。
 */
export function zoomKey(prefix, key) {
  return draftKey(prefix, key);
}

/* ------------------------------------------------------------------ *
 * 「保存全部」（2026-10-28）
 *
 * 以前每张卡片各有自己的「保存」按钮，改了三个地方只点其中一两个时，剩下的改动
 * **根本没写进文件**，而界面上没有任何痕迹 —— 表现就是"改了配置没生效"。
 * 现在整页只有一个保存入口，它要提交的条目由下面这几个纯函数算出来。
 * ------------------------------------------------------------------ */

/**
 * 把一批字段里**改动过的**收成待提交条目。
 *
 * 条目形如 `{ scope, key, label, value, danger, section }`，`value` 已经过
 * {@link submitValueFor}，是可以直接交给宿主的形态。**没改的字段不进条目**：
 * 这是"只重写改动的那个键、文件里其余字节原样（手写注释与格式不被冲掉）"的前提。
 *
 * `danger` 取两侧的**并集**：宿主在字段表里自己标的 `danger: true`，与按 key
 * 判出来的结果（{@link isDangerFieldKey}）。只按 key 判会漏掉前者 ——
 * `voice.python` 这类键名的最后一段不在 {@link DANGER_KEYS} 里，而宿主照样要求
 * `confirm: true`，漏判的结果是"一保存就报『需要二次确认』"。
 */
export function dirtyEntriesFor(fields, draft, scopeId) {
  const list = Array.isArray(fields) ? fields : [];
  const id = textOf(scopeId) || 'global';
  const entries = [];
  for (const field of list) {
    if (field === null || typeof field !== 'object') continue;
    const value = draftOf(draft, id, field);
    if (!draftChanged(field, value)) continue;
    const key = textOf(field.key);
    entries.push({
      scope: id,
      key,
      label: fieldLabel(field),
      value: submitValueFor(field, value),
      danger: field.danger === true || isDangerFieldKey(key),
      section: textOf(field.section),
    });
  }
  return entries;
}

/**
 * 「保存全部」按钮上的文字。
 *
 * 有改动时必须把**处数**写出来：这个按钮是整页唯一的保存入口，而"用户以为已经
 * 保存了"正是这次要治的病 —— 按钮上直接写着还剩几处，是最后一道提醒。
 */
export function saveAllLabel(count) {
  const n = typeof count === 'number' && Number.isFinite(count) ? count : 0;
  return n > 0 ? `保存全部（${n} 处改动）` : '保存全部';
}

/**
 * 把脏条目压成一行摘要，形如「全局 · 人格、群 30000013 · 行为规则 等 5 处」。
 *
 * `scopeLabels` 是「作用域 id → 短名」的映射；缺项时回落成作用域 id ——
 * 宁可显示 `group:30000013`，也不要留空：留空等于没告诉用户改在哪儿。
 * 超过 `max` 条时只列前几条，并给出总处数。
 */
export function describeDirtyEntries(entries, scopeLabels, max = 3) {
  const list = Array.isArray(entries) ? entries : [];
  const labels = scopeLabels !== null && typeof scopeLabels === 'object' ? scopeLabels : {};
  const limit = typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.floor(max) : 3;
  const parts = [];
  for (const entry of list) {
    const scope = textOf(entry && entry.scope) || 'global';
    const name = textOf(labels[scope]) || scope;
    const label = textOf(entry && entry.label) || textOf(entry && entry.key);
    parts.push(`${name} · ${label}`);
  }
  if (parts.length === 0) return '';
  if (parts.length <= limit) return parts.join('、');
  return `${parts.slice(0, limit).join('、')} 等 ${parts.length} 处`;
}

/* ------------------------------------------------------------------ *
 * 「重载后自动重连」（2026-10-29）
 *
 * 病根：点「重载插件」⇒ 插件重载 ⇒ **页面背后的临时 HTTP 服务跟着消失** ⇒
 * 页面成了一个空壳，用户只能自己回 DSH 重新点一次「QQ 小鲸鱼」。
 *
 * 这一节只放**判定与文案**（什么时候该重连、等多久、提示怎么写），不碰 DOM、不发
 * 请求，因此能在 Node 里直接钉住（见 `test/web-config-reconnect.test.mjs`）。
 * 真正的轮询循环在 `app.js`：它要定时器，属于运行环境而不是判定。
 * ------------------------------------------------------------------ */

/**
 * 重连的轮询间隔：1.5 秒。
 *
 * 为什么是 1.5 秒而不是更短：一次重载大约 2~3 秒就回来，1.5 秒意味着**平均多等
 * 0.75 秒**就能发现它回来了 —— 人已经盯着一个覆盖层了，这段时间感知得到但不刺眼。
 * 更短（例如 300 毫秒）只是让「已等待」这个数字跳得更快，请求次数却翻五倍，
 * 而服务刚重载完的那几秒正是它最忙的时候。
 *
 * 也不能更长：超过 2 秒，用户会开始怀疑"它是不是把我的页面搞坏了"。
 */
export const RECONNECT_INTERVAL_MS = 1500;

/**
 * 最多等多久：30 秒。超过就认为插件没回来，停止轮询并给出「再试一次」。
 *
 * 取 30 秒的依据：正常重载 2~3 秒，慢一点的（宿主忙、HMR 排队）十几秒也有过；
 * 30 秒已经比"正常"宽一个数量级，仍能回来。再长就变成"页面永远在转圈"，
 * 而真正的原因（插件没起来 / 宿主崩了 / 端口变了）不是多等能解决的 ——
 * 那时该让人去 DSH 看一眼。
 */
export const RECONNECT_MAX_WAIT_MS = 30000;

/**
 * 点完「重载插件」之后，第一次轮询前先等的这两天多一点。
 *
 * 重载是**异步**的：`POST /reload` 只碰 mtime 就返回，服务还要再过 1~2 秒才真的消失。
 * 若立刻轮询，第一次几乎必然打在**还没死的旧服务**上 ⇒ 覆盖层闪一下就消失，
 * 两秒后再冒出来，看起来像坏了。先等 2 秒，避开这个抖动。
 *
 * ⚠️ 反过来的情形：万一 HMR 根本没重载（服务一直活着），第一轮就会连上，
 * 界面显示"已重新连上"—— 那也是真话（页面确实还能用），不算误报。
 */
export const RECONNECT_RELOAD_GRACE_MS = 2000;

/**
 * 第 `attempt` 次尝试之前要等多久（毫秒）。
 *
 * `attempt` 从 0 开始。第一次若给了 `firstDelayMs`（点重载后的宽限期）就用它，
 * 其余一律是 {@link RECONNECT_INTERVAL_MS}。非法输入按 0 次处理。
 */
export function reconnectPollDelay(attempt, firstDelayMs = 0) {
  const n = Number(attempt);
  if (!Number.isFinite(n) || n <= 0) {
    const first = Number(firstDelayMs);
    return Number.isFinite(first) && first > 0 ? first : RECONNECT_INTERVAL_MS;
  }
  return RECONNECT_INTERVAL_MS;
}

/** 已等待的毫秒数 → 覆盖层上显示的整秒数（向下取整，不四舍五入）。 */
export function reconnectWaitedSeconds(waitedMs) {
  const ms = Number(waitedMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 1000);
}

/** 预算是否已经用完（用完就该停下来给「再试一次」，而不是继续转圈）。 */
export function reconnectExhausted(waitedMs, maxMs = RECONNECT_MAX_WAIT_MS) {
  const waited = Number(waitedMs);
  const max = Number(maxMs);
  const limit = Number.isFinite(max) && max > 0 ? max : RECONNECT_MAX_WAIT_MS;
  if (!Number.isFinite(waited)) return true;
  return waited >= limit;
}

/**
 * 判断一个请求失败**是不是"服务不在了"**，即该不该进重连。
 *
 * 命中三种（与用户描述的口径一致）：
 *
 * 1. `network`：`fetch` 自己抛了 —— 连接被拒、DNS/代理异常，服务跟着插件一起没了；
 * 2. `notJson`：2xx 但响应体不是 JSON（路由没挂上、被中间层换成了 HTML）；
 * 3. 状态码 **≥ 500**：502/503/504 这类"网关知道后端没了"的回答。
 *
 * **4xx 不算**：那是活着的服务在说"你这个请求不对"（TOML 校验失败、需要 confirm、
 * 键不在白名单……）。把它当成断开，就会因为填错一个数字而整页被盖住 30 秒，
 * 而真正该做的是把那行错误显示给他。
 */
export function isDisconnectError(error) {
  if (error === null || error === undefined) return false;
  if (typeof error !== 'object') return false;
  if (error.network === true) return true;
  if (error.notJson === true) return true;
  const status = Number(error.status);
  return Number.isFinite(status) && status >= 500;
}

/**
 * 重连覆盖层要显示的东西。
 *
 * 入参 `{ phase, waitedMs, dirtyCount }`，`phase` 为 `idle` / `waiting` / `gaveUp`。
 * 返回 `{ visible, phase, title, detail, retry, waitedText }`。
 *
 * 两条文案口径：
 *
 * 1. **等待中**必须给出"还在等"的确定性信息（已等几秒、多久试一次、最多等多久），
 *    否则一个转圈的空壳和"页面死了"看起来一模一样；
 * 2. **放弃时**把下一步写清楚（去 DSH 看一眼 / 重新点「QQ 小鲸鱼」），并给出重试按钮。
 *
 * 两态都要提**没保存的改动还在**：重连期间不写文件、也不自动保存，但草稿留在内存里
 * —— 不说这一句，用户会以为那批改动已经随断开一起丢了。
 */
export function reconnectNotice(state) {
  const source = state !== null && typeof state === 'object' ? state : {};
  const phase = textOf(source.phase);
  const waitedMs = Number(source.waitedMs);
  const waited = Number.isFinite(waitedMs) && waitedMs > 0 ? waitedMs : 0;
  const dirtyRaw = Number(source.dirtyCount);
  const dirtyCount = Number.isFinite(dirtyRaw) && dirtyRaw > 0 ? Math.floor(dirtyRaw) : 0;
  if (phase !== 'waiting' && phase !== 'gaveUp') {
    return { visible: false, phase: '', title: '', detail: '', retry: false, waitedText: '' };
  }
  const waitedText = `${reconnectWaitedSeconds(waited)} 秒`;
  if (phase === 'gaveUp') {
    // 2026-10-29：源侧改成「固定端口 + 令牌跨重载复用」之后，这个页面**能**回到新实例上
    // （同 origin、同令牌），所以文案不能再写"新端口 + 新的一次性令牌" —— 那是旧行为。
    // 现在等满 30 秒还没回来，只剩两种可能：插件真没起来，或者端口被别的程序占了。
    // 「再试一次」因此是**有意义**的：地址没变，服务一回来就接得上（旧文案把它说成了徒劳）。
    // ⚠️ 但"重开配置页"仍然是另一个 origin（新标签页读不到本页草稿），dirtyLine 那条不变。
    const dirtyLine = dirtyCount > 0
      ? `⚠️ 那 ${dirtyCount} 处改动只在这个页面里，重开配置页就读不到了 —— 先点下面的「复制改动」把它们抄下来。`
      : '';
    return {
      visible: true,
      phase,
      retry: true,
      waitedText,
      title: '插件好像没回来，去 DSH 里看一眼',
      detail: `已经等了 ${reconnectWaitedSeconds(RECONNECT_MAX_WAIT_MS)} 秒还没连上。`
        + '正常重载 2~3 秒就回来了，这么久没响应，多半是插件没起来、或者端口被别的程序占了：'
        + '到 DSH 里确认插件恢复运行，然后再点一次「再试一次」—— 地址没变，服务一回来就接得上。'
        + dirtyLine,
    };
  }
  const dirtyLine = dirtyCount > 0
    ? `你那 ${dirtyCount} 处改动还在，连上之后点底部「保存全部」才写入；重连期间不会写文件、也不会自动保存。`
    : '重连期间不会写文件、也不会自动保存。';
  return {
    visible: true,
    phase,
    retry: false,
    waitedText,
    title: '插件正在重载，等它回来…',
    detail: `已等待 ${waitedText}（每 ${RECONNECT_INTERVAL_MS / 1000} 秒重试一次，`
      + `最多等 ${RECONNECT_MAX_WAIT_MS / 1000} 秒）。${dirtyLine}`,
  };
}

/**
 * 重连成功后的那行提示。
 *
 * 必须把**还剩几处没保存**说出来：草稿在断开期间一直留着，重连成功后界面显示的是
 * 新的文件值，而草稿仍在 —— 不提这一句，用户会以为重连把改动吃掉了，或者反过来以为
 * 已经保存了。
 */
export function reconnectRecoveredText(dirtyCount) {
  const raw = Number(dirtyCount);
  const count = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  if (count > 0) {
    return `已重新连上插件（配置已重新读取）。还有 ${count} 处改动没保存，点底部「保存全部」写入。`;
  }
  return '已重新连上插件（配置已重新读取）。';
}

/**
 * 把未保存的改动导成一段**纯文本**，供"重连不上、只能重开页面"时抄回去。
 *
 * 为什么需要它：配置页的草稿只在内存里，而且按 `origin`（旧端口 + 旧令牌）隔离 ——
 * 重开出来的新页面是另一个 origin，**读不到旧页面的任何存储**。也就是说"重开"这条路
 * 一定会把没保存的改动丢掉，唯一的救法是把它们变成用户手里的文本。
 *
 * 形态刻意是"每项一行标题 + 一段正文"的纯文本，不是表格、不补空格对齐：
 * 这段东西最终会被粘到手机 QQ 或聊天窗口里，等宽对齐会长行折断成一团。
 */
export function dirtyEntriesDump(entries, scopeLabels) {
  const list = Array.isArray(entries) ? entries : [];
  const labels = scopeLabels !== null && typeof scopeLabels === 'object' ? scopeLabels : {};
  const blocks = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const scope = textOf(entry.scope) || 'global';
    const name = textOf(labels[scope]) || scope;
    const label = textOf(entry.label) || textOf(entry.key);
    const raw = entry.value;
    let text;
    if (Array.isArray(raw)) text = raw.map(textOf).join(', ');
    else if (typeof raw === 'boolean') text = raw ? '开' : '关';
    else text = textOf(raw);
    blocks.push(`【${name} · ${label}】${textOf(entry.key)}\n${text === '' ? '（空）' : text}`);
  }
  if (blocks.length === 0) return '';
  return `QQ 小鲸鱼配置页：还有 ${blocks.length} 处没保存的改动\n\n${blocks.join('\n\n')}`;
}
