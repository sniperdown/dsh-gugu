/**
 * 表情包库：**偷**（从消息里捞）→ **存**（md5 去重 + 使用计数）→ 给**认/挑**留接口。
 *
 * ## 为什么单独一个模块
 *
 * 调研（`shared/2026-10-06-表情包链路调研-session-00000000.md`）的结论是一句话：
 *
 * > 我们缺的不是「识别表情包」，是「**记住它、攒起来、会挑一张发出去**」。
 *
 * 四件事 **偷 → 认 → 存 → 挑**，本次只做 **偷 + 存**，外加把 **认 / 挑** 的接口
 * 留出来（`tags` 字段 + 只读查询 + `recordUse`）。**"挑"刻意不实现** ——
 * 那是下一批，而且它属于产品决定（骰子选还是视觉选）。
 *
 * ## ① 判据是**位判据**：`emoji_id` 非空 **或** `sub_type & 1`
 *
 * ```
 * emoji_id 非空  或  ( sub_type 存在 且 (Number(sub_type) & 1) === 1 )
 * ```
 *
 * ### 为什么是位判据（2026-10-08，**1495 张真实样本**）
 *
 * | `sub_type` | 张数 | 占比 | 最低位 |
 * |---|---|---|---|
 * | `0` | 1260 | 84.28% | 0 |
 * | `1` | 217 | 14.52% | **1** |
 * | `11` | 10 | 0.67% | **1** |
 * | `7` | 6 | 0.40% | **1** |
 * | 无此键（商城表情） | 2 | 0.13% | — |
 *
 * `sub_type` 就是 QQ 原生的 `picElement.picSubType`（NapCat 在 `napcat.mjs:72874`
 * **原样透传**，不是它造的），它是**位域**：非零值 `1 / 7 / 11` 的最低位全是 1，
 * 而 `0` 的最低位是 0 ⇒ `sub_type & 1` 正好把五类切成"表情 / 普通图"两组。
 * 用 `sub_type === 1` 会把 `7` / `11` 那 **16 张**漏掉，位判据只多不少。
 *
 * `emoji_id` 那一支继续留着：它是唯一能识别 **QQ 表情商城**的一条
 * （那 2 张来自 `marketFaceElement`、**没有 `sub_type` 键**，位判据抓不到）。
 * 两支**不相交**：2 + 233 = **235 张（15.72%）**。
 *
 * ### ⚠️ 三条被这次采样推翻的旧说法（别再翻回去）
 *
 * 1. **`summary` 不是独立证据，已弃用。** `napcat.mjs:13535`：
 *    `this.summary = picElement.summary === "" ? (picSubType === 0 ? "[图片]" : "[动画表情]") : ···`
 *    ⇒ `summary` 是 **NapCat 按 `sub_type` 合成**出来的。实测"`sub_type === 1`"和
 *    "`summary === '[动画表情]'`"都正好命中 217 张 —— 那是**同一个证据的两种写法**，
 *    不是两个。旧判据里"`summary` 是 QQ 类型标签"那一支**已删除**。
 * 2. **不能用 `file` 扩展名判动图**：实测 26 张里 **14 张对不上**（段里写 `.jpg`，
 *    磁盘真身是 GIF）。
 * 3. **`sub_type: 1` 不等于"群友的照片/截图"。** 上一批把 2026-10-07 私聊里那几张
 *    `sub_type:1` + `summary:""` + `gchat.qpic.cn` 判成"普通图"，
 *    **用户本人看着图推翻了它**：那是他**从「我的表情」面板发出来的**
 *    （`shared/表情包-2026-10-08/用户人工标注-判据真值-2026-10-08.md`，真值独立）。
 *    同一份标注里两张"很确定的梗图"落在 `sub_type: 0` ⇒ **判据不收它们**，
 *    这才是最干净的对照。
 *
 * ### 假阳性率说到哪一步为止（诚实边界，别省）
 *
 * 能拿到原件的 **26 张** `sub_type & 1` 目视**零误收**；但 26 张的零误收
 * ⇒ 95% 置信上界仍有约 **11%**。剩下 209 张的原件在这台机器上拿不到
 * （QQ 缓存只覆盖 2026-10，且只留最近一小部分）。这条边界要跟判据一起说。
 *
 * ## ② 落盘与索引
 *
 * ```
 * <DSH_HOME>\media\stickers\<md5>.<ext>      ← 图本身（文件名就是内容 md5）
 * <DSH_HOME>\media\qq-stickers.json          ← 索引（md5 → 元信息）
 * ```
 *
 * 两个路径都**从配置来**（`index.mjs` 的 `stickerDir` / `stickerIndexPath`），
 * 这里的常量只是默认值 —— 与 `image-cache.mjs` 同一条规矩：
 * **环境相关的东西绝不硬编码**。
 *
 * 索引的结构刻意与既有的 `<DSH_HOME>\media\qq-image-desc.json` 同构
 * （`{version, updatedAt, entries:{…}}`）：同一个目录下两份表，形状一样才好读。
 *
 * ## ③ 库里坏了怎么办：**一律当空库**
 *
 * 读不到 / JSON 坏了 / 版本对不上 / 写不进去 → `degraded = true` + 一条 warn，
 * 然后照常收消息、照常回消息（只是这一轮偷不到东西）。
 * **它绝不能变成单点故障** —— 这是用户的硬要求，也是那张描述表的原则（照抄）。
 *
 * @module qq-gugu/sticker-library
 */

import nodeFs from 'node:fs';
import path from 'node:path';

import { MAX_IMAGE_BYTES, fetchImageBytes, sniffImageMediaType } from './media.mjs';
import { dshHome } from './paths.mjs';
import { createOriginalFinder, md5Hex } from './image-cache.mjs';
// ⚠️ 这里**不再** import `image-desc.mjs` 的 `isAnimationClaimLabel` / `isUnknownImageLabel`：
//    位判据下 `summary` 一个字节都不参与判定（它是 NapCat 按 `sub_type` 合成的），
//    留着那两个函数只会让人以为"summary 还在参与判断"。

/**
 * 表情包库的默认目录（用户拍板：`<DSH_HOME>\` 下，与既有的运行期产物同处）。
 *
 * 参考 MaiBot 是 `IMAGES/emoji/`（`utils_image.py:203-228`）——
 * 我们跟它一致的地方是"**一个专门的表情包目录**"，不一致的地方是
 * **路径进配置而不是写死在代码里**。
 */
export const DEFAULT_STICKER_DIR = path.join(dshHome(), 'media', 'stickers');

/** 表情包索引的默认路径（与 `qq-image-desc.json` 同一个目录）。 */
export const DEFAULT_STICKER_INDEX_PATH = path.join(dshHome(), 'media', 'qq-stickers.json');

/**
 * 审核留样的**索引**（每行一条 JSON，含 `md5` 和 `desc`）—— 2026-10-19 新增。
 *
 * 库里（qq-stickers.json）**不存画面描述**，描述是审核那一步写进这里的。
 * 实测 120 张里只有 79 张（66%）有非空 `desc`；**没描述的那 41 张只能靠标签挑**。
 * ⚠️ 目录与 `sticker-audit.mjs` 的 `DEFAULT_STICKER_AUDIT.dir` 必须一致（那边只存图 + 索引）。
 */
export const DEFAULT_STICKER_AUDIT_INDEX_PATH = path.join(dshHome(), 'media', 'sticker-audit', 'index.jsonl');

/** 索引版本号。对不上就**当空库**（宁可重新攒，也不要误读旧格式）。 */
export const STICKER_INDEX_VERSION = 1;

/** 库的容量上限。超了按「用得少的先走」淘汰（见 {@link createStickerIndex}）。 */
export const DEFAULT_MAX_STICKERS = 500;

/** 一条消息最多偷几张。群里连发一串表情包是常事，但一次几十张就是刷屏了。 */
export const MAX_STICKERS_PER_MESSAGE = 3;

/**
 * 单张表情包的字节上限（4MB）。
 *
 * 比 `MAX_IMAGE_BYTES`（20MB，入站识图那条路）**刻意更严**：
 * 真实表情包实测在 100KB~1MB 量级，几 MB 的"表情包"更可能是有人把大图/视频截图
 * 发了进来。偷它进库除了占地方没有任何好处，而且出站时还要整份读出来发。
 */
export const MAX_STICKER_BYTES = 4 * 1024 * 1024;

/**
 * 同时在跑的"偷"最多几个。
 *
 * 偷是 fire-and-forget 的，下载又可能几秒。不设闸的话，一个刷屏的群会瞬间
 * 堆出几十个并发下载 —— 那是把用户的带宽和 NapCat 的连接当免费资源用。
 * 超了就**直接跳过**（并计数），不排队：偷表情包晚一轮完全没关系。
 */
export const MAX_PENDING_HARVESTS = 8;

/** 只认这几种能再发出去的格式（认不出就不入库，别存一个发不回来的文件）。 */
const EXT_BY_MEDIA_TYPE = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

/** 取一个可能被 `data` 包着的字符串字段（入站两种形状都认）。 */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 标签数组的形状保真（**不校验枚举**）。
 *
 * 2026-11-06 增：人工标注那几组字段（`modelTags` / `manualTags`）要原样穿过
 * 索引的读写 —— 它们的值域校验在 `sticker-labeling.mjs`，这一层只管"别丢"。
 */
function tagListOf(value) {
  return Array.isArray(value) ? value.map((tag) => String(tag).trim()).filter((tag) => tag !== '') : [];
}

/**
 * **这条段的"表情包证据"是什么** —— 判定 + 诊断二合一。
 *
 * 判据（2026-10-08 定稿）：
 *
 * ```
 * emoji_id 非空  或  ( sub_type 存在 且 subType 是整数 且 (subType & 1) === 1 )
 * ```
 *
 * | `verdict` | 含义 | 怎么处理 |
 * |---|---|---|
 * | `sticker` | 命中位判据 **或** 有 `emoji_id` | 入库（还要过"认"那一道审核闸） |
 * | `near-miss` | 只有 `emoji_package_id`、既没 `emoji_id` 也没位证据 | **不入库**，但记一笔 |
 * | `not-sticker` | 普通图（`sub_type: 0`）/ 没有 `sub_type` 也没有 `emoji_id` | 忽略 |
 *
 * ### `reason` 的取值（对外可见，别随手改）
 *
 * - `emoji_id` —— QQ 表情商城（`marketFaceElement` 合成的那条路）；
 * - `sub_type-bit` —— 位判据（`picElement` 那条路，绝大多数表情包走这条）；
 * - `package-id-without-emoji-id` —— 唯一的 `near-miss`；
 * - `not-image` / `no-sticker-evidence` —— 不收。
 *
 * ### ⚠️ 2026-10-08 删掉的两条旧理由（**别复活**）
 *
 * 1. **`animated-summary`（near-miss）**：上一批把
 *    `{sub_type: 1, summary: "[动画表情]", 无 emoji_id}` 记成"疑似但不收"。
 *    那正是用户确认的**收藏的表情包**的形状 —— 现在是 `sticker`。
 *    留着这个计数会变成一个**恒为 0 的死字段**。
 * 2. **用 `summary` 当证据**：`summary` 是 NapCat 按 `sub_type` 合成的
 *    （`napcat.mjs:13535`），和 `sub_type` 是**同一个证据**，不是第二个。
 *    所以这里**根本不读 `summary`**（连"辅助判断"都不做）。
 *
 * @param {Record<string, unknown>} segment
 * @returns {{verdict: 'sticker'|'near-miss'|'not-sticker', emojiId: string, packageId: string|null, reason: string}}
 */
export function stickerEvidence(segment) {
  const type = String(segment?.type ?? '');
  if (type !== 'image') {
    return { verdict: 'not-sticker', emojiId: '', packageId: null, reason: 'not-image' };
  }
  const emojiId = textOf(segment?.emoji_id ?? segment?.data?.emoji_id);
  const packageRaw = segment?.emoji_package_id ?? segment?.data?.emoji_package_id;
  const packageId = packageRaw === undefined || packageRaw === null || String(packageRaw).trim() === ''
    ? null
    : String(packageRaw).trim();

  // ① 商城表情：唯一会带 `emoji_id` 的一类（它**没有** `sub_type` 键）。
  if (emojiId !== '') {
    return { verdict: 'sticker', emojiId, packageId, reason: 'emoji_id' };
  }

  // ② 位判据：`sub_type` 是 QQ 的 `picSubType` 位域，最低位 = "这是不是表情"。
  //    ⚠️ 必须要求**整数**：`1.5 & 1` 会先截断成 1，把"字段坏了"当成"是表情"。
  const subTypeRaw = segment?.sub_type ?? segment?.data?.sub_type;
  const hasSubType = subTypeRaw !== undefined && subTypeRaw !== null && String(subTypeRaw).trim() !== '';
  const subType = hasSubType ? Number(subTypeRaw) : Number.NaN;
  if (Number.isInteger(subType) && (subType & 1) === 1) {
    return { verdict: 'sticker', emojiId: '', packageId, reason: 'sub_type-bit' };
  }

  // ③ 只有包 id：疑似但不收（`0` / 空串是 QQ 表达"没有包"的写法，不算证据）。
  if (packageId !== null && packageId !== '0') {
    return { verdict: 'near-miss', emojiId: '', packageId, reason: 'package-id-without-emoji-id' };
  }
  return { verdict: 'not-sticker', emojiId: '', packageId, reason: 'no-sticker-evidence' };
}

/**
 * 这条段是**表情包**吗。
 *
 * ⚠️ 判据是**位判据**：`emoji_id` 非空 **或** `sub_type & 1`（理由见模块注释与
 * {@link stickerEvidence}）。**不是**只看 `emoji_id` —— 那只覆盖实测样本的 2/1495。
 *
 * @param {Record<string, unknown>} segment
 * @returns {boolean}
 */
export function isStickerSegment(segment) {
  return stickerEvidence(segment).verdict === 'sticker';
}

/**
 * 把一段字节的**媒体类型**换成文件扩展名（认不出返回 `null`）。
 * @param {Uint8Array} bytes
 * @returns {{mediaType: string, ext: string}|null}
 */
export function stickerFormatOf(bytes) {
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === null) return null;
  const ext = EXT_BY_MEDIA_TYPE.get(mediaType);
  return ext === undefined ? null : { mediaType, ext };
}

/**
 * 跨会话的**表情包索引**（`<DSH_HOME>\media\qq-stickers.json`）。
 *
 * 形状（与 `qq-image-desc.json` 同构）：
 *
 * ```json
 * { "version": 1, "updatedAt": "…",
 *   "entries": {
 *     "<md5>": {
 *       "file": "<md5>.gif",           // 库目录里的文件名（**权威**）
 *       "path": "H:\\…\\<md5>.gif",     // 入库时写下的绝对路径（信息性，可能因搬家过期）
 *       "emojiId": "…",                 // QQ 给的 emoji_id（有则与 md5 相同 —— 见下）
 *       "packageId": "240387",
 *       "at": "…",                      // 入库时间（ISO）
 *       "seen": 3,                      // 后来又见到几次（**不是**发出次数）
 *       "uses": 0,                      // **发出次数**（"挑"的依据，见 recordUse）
 *       "lastUsedAt": null,
 *       "tags": [],                     // 「认」写进来的 1–3 个枚举标签，**允许为空**
 *                                       // （没配 `recognize` / 模型没选出来时就是空数组）
 *       "source": { "chatId": "group:…", "userId": "…" }
 *     } } }
 * ```
 *
 * ## ⚠️ `emoji_id` **不是**内容 md5 —— 这是 2026-10-08 实测推翻的一个假设
 *
 * 本来想当然：真样本里 `emoji_id` = `674cbcb1606d656525fb8615f2648198`，而段里的
 * `file` 是 `67-674cbcb1606d656525fb8615f2648198.gif`（NapCat 合成的名字，
 * 见 `napcat.mjs:73012`），看起来"就是内容哈希"。
 *
 * **但真机下载之后不是。** 那张表情包的 URL 是 `…/raw300.gif`
 * （NapCat 写死的 300px 渲染版），下载 41074 字节，**内容 md5 = `155912a0…`**，
 * 与 `emoji_id` 完全不同。
 *
 * ⇒ 所以"按 `emoji_id` 前缀猜内容"这条路是**错的**，绝不能拿它当内容身份。
 * ⇒ 内容身份只有一个：**下载到的字节的 md5**（同 `image-cache.mjs` 的"哈希算原件"）。
 *
 * ## 那 `getByEmojiId` 靠什么去重
 *
 * 靠**观测到的配对**，不是靠猜哈希：一条条目里记着 `emojiId`，
 * 那是"这份字节和这个 `emoji_id` 是**同一条消息段一起到达的**"——
 * 这个事实是 harvesting 那一刻亲眼看到的，不是推断出来的。
 *
 * 于是段里一带 `emoji_id` 就能**零网络**回答"这张表情包我有没有"。
 * （同一张表情包在群里被反复发是常态，这条省掉的是每一次的 CDN 往返。）
 *
 * 唯一的代价说清楚：`raw300.gif` 是渲染版，若 QQ 哪天换了渲染，
 * 我们留的还是当初那份字节 —— 对"表情包"这种东西是可以接受的
 * （`emoji_id` 本来就是 QQ 对这张表情的**身份**）。
 *
 * @param {object} options
 * @param {string} options.filePath
 * @param {Function} [options.log]
 * @param {object} [options.fsImpl]
 * @param {number} [options.maxEntries]
 * @param {() => number} [options.now]
 * @returns {object}
 */
export function createStickerIndex({
  filePath,
  log = () => {},
  fsImpl = nodeFs,
  maxEntries = DEFAULT_MAX_STICKERS,
  now = () => Date.now(),
} = {}) {
  const target = String(filePath ?? '').trim();
  /** @type {Map<string, object>} */
  const entries = new Map();
  const stats = { writes: 0, dropped: 0, seenBumps: 0, reads: 0 };
  let degraded = false;
  const usable = target !== '';

  if (usable) {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
      if (parsed !== null && typeof parsed === 'object'
        && parsed.version === STICKER_INDEX_VERSION
        && parsed.entries !== null && typeof parsed.entries === 'object') {
        for (const [key, value] of Object.entries(parsed.entries)) {
          const md5 = String(key ?? '').trim().toLowerCase();
          const file = textOf(value?.file);
          if (md5 === '' || file === '') continue; // 缺文件名的条目是坏条目，丢掉
          entries.set(md5, {
            file,
            path: textOf(value?.path),
            emojiId: textOf(value?.emojiId).toLowerCase(),
            packageId: value?.packageId === undefined || value?.packageId === null
              ? null
              : String(value.packageId),
            at: textOf(value?.at) || new Date(0).toISOString(),
            seen: Number.isFinite(value?.seen) ? Number(value.seen) : 0,
            uses: Number.isFinite(value?.uses) ? Number(value.uses) : 0,
            lastUsedAt: textOf(value?.lastUsedAt) || null,
            tags: Array.isArray(value?.tags) ? value.tags.map((t) => String(t)).filter((t) => t !== '') : [],
            // 2026-10-19：描述也存（pick 拿它打分；空串 = 这库还是老的，靠审核表兜）。
            desc: textOf(value?.desc),
            // 2026-11-06：人工标注字段（`sticker-labeling.mjs` 写）**必须一起收进来**。
            // 理由：`persist()` 是按内存里的形状整份重写的 —— 这里漏掉一个字段，
            // 下一次 `seen` 自增就会把它静默抹掉，而磁盘上看起来"什么都没发生"。
            // 这里**只做形状保真**（数组/字符串），枚举校验留给写的那一方。
            modelTags: tagListOf(value?.modelTags),
            modelDesc: textOf(value?.modelDesc),
            manualTags: tagListOf(value?.manualTags),
            manualDesc: textOf(value?.manualDesc),
            manualVerdict: textOf(value?.manualVerdict),
            manualAt: textOf(value?.manualAt),
            source: value?.source !== null && typeof value?.source === 'object'
              ? { chatId: textOf(value.source.chatId), userId: textOf(value.source.userId) }
              : { chatId: '', userId: '' },
          });
        }
      } else {
        degraded = true;
      }
    } catch (error) {
      // 文件不存在是**正常情况**（第一次跑），不算坏。
      const code = error !== null && typeof error === 'object' ? error.code : '';
      if (code === 'ENOENT') {
        degraded = false;
      } else {
        degraded = true;
        log('warn', '表情包索引读不了，按空库继续（不影响收发消息，只是这一轮偷不到）', {
          path: target,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * 淘汰：**先淘汰用得最少的，同次数再淘汰最早入库的**。
   *
   * 依据来自 MaiBot 的淘汰抽样（`emoji_manager.py:815-889`）：
   * `probabilities = [1 / (usage_count + 1) …]` —— 用得越少越可能被淘汰。
   * 我们不做随机抽样（那要小模型来裁），只做确定性的同向淘汰，够用且可测。
   */
  function evict() {
    const limit = Number.isFinite(maxEntries) && maxEntries > 0
      ? Math.floor(maxEntries)
      : DEFAULT_MAX_STICKERS;
    while (entries.size > limit) {
      let victim = null;
      let victimRank = null;
      for (const [md5, entry] of entries) {
        const rank = [entry.uses, entry.at, md5];
        if (victimRank === null
          || rank[0] < victimRank[0]
          || (rank[0] === victimRank[0] && rank[1] < victimRank[1])) {
          victim = md5;
          victimRank = rank;
        }
      }
      if (victim === null) break;
      entries.delete(victim);
      stats.dropped += 1;
    }
  }

  /**
   * 落盘（**先写临时文件再改名**）。
   *
   * 与 `image-cache.mjs` 的 `createDescTable` 直写目标文件不同，这里用原子写：
   * 库目录是**新开的一个目录**，多一个临时文件不违反任何约束；
   * 而索引是 500 条元信息（比描述表更值钱），半截 JSON 会让整库作废。
   * 反正"坏了当空库"兜着，但能不错过就不错过。
   */
  function persist() {
    if (!usable) return false;
    try {
      evict();
      const payload = JSON.stringify({
        version: STICKER_INDEX_VERSION,
        updatedAt: new Date(now()).toISOString(),
        entries: Object.fromEntries(entries),
      }, null, 2);
      const tmp = `${target}.tmp`;
      fsImpl.writeFileSync(tmp, payload, 'utf8');
      fsImpl.renameSync(tmp, target);
      stats.writes += 1;
      return true;
    } catch (error) {
      log('warn', '表情包索引写不进去（本轮照常，只是重启后可能少几条）', {
        path: target,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** 把内部条目变成**只读快照**（调用方改不到库内部状态）。 */
  const snapshot = (md5, entry) => ({
    md5,
    ...entry,
    tags: [...entry.tags],
    modelTags: [...entry.modelTags],
    manualTags: [...entry.manualTags],
    source: { ...entry.source },
  });

  return {
    /** 按内容 md5 取一条（只读快照）。 */
    get(md5) {
      stats.reads += 1;
      const key = String(md5 ?? '').trim().toLowerCase();
      const found = entries.get(key);
      return found === undefined ? null : snapshot(key, found);
    },
    /**
     * 按 QQ 的 `emoji_id` 找 —— **零网络去重**的捷径（段里就带着 `emoji_id`）。
     *
     * 匹配的是**入库时观测到的配对**（`entry.emojiId`），不是"哈希前缀"：
     * 实测 `emoji_id` **不等于**内容 md5（见模块注释里 `155912a0…` 那条），
     * 所以猜哈希那条路是错的；而"这份字节和这个 id 同一条消息段到达"是事实。
     *
     * `emoji_id` 只出现在真的表情包段上（NapCat 从 `marketFaceElement` 合成的），
     * 所以这条查询**不可能**命中一张普通图 —— 隐私上不会误伤。
     */
    getByEmojiId(emojiId) {
      const wanted = String(emojiId ?? '').trim().toLowerCase();
      if (wanted === '') return null;
      for (const [md5, entry] of entries) {
        if (entry.emojiId !== '' && entry.emojiId.toLowerCase() === wanted) return snapshot(md5, entry);
      }
      return null;
    },
    /** 全部条目（只读快照数组）。给"认/挑"与诊断用 —— **纯读，不做任何选择**。 */
    all() {
      return [...entries.entries()].map(([md5, entry]) => snapshot(md5, entry));
    },
    /**
     * 按标签过滤（**纯查询**）。
     *
     * ⚠️ 这里**不实现"挑"**：不随机、不排序、不发出去。
     * 挑哪一张是下一批的事（且是个产品决定：骰子还是视觉），
     * 本模块只负责"把符合条件的取出来"。
     *
     * @param {{tags?: string[]}} [options] 不传/空数组 = 全部
     */
    findByTags({ tags = [] } = {}) {
      const wanted = (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter((t) => t !== '');
      const list = [...entries.entries()].map(([md5, entry]) => snapshot(md5, entry));
      if (wanted.length === 0) return list;
      return list.filter((entry) => entry.tags.some((tag) => wanted.includes(tag)));
    },

    /** 写入/覆盖一条（harvest 用）。返回是否**被记住**（落盘是尽力而为）。 */
    set(md5, value) {
      const key = String(md5 ?? '').trim().toLowerCase();
      const file = textOf(value?.file);
      if (!usable || key === '' || file === '') return false;
      // 2026-11-06：人工标注那几组字段**在调用方没写时沿用旧值**。
      // `harvest` 传的是一条全新的对象（没有 manual*），若直接覆盖，
      // 一条已经被人工标过的图只要再被偷到一次（`set` 覆盖同一 md5），标注就没了。
      const existing = entries.get(key);
      entries.set(key, {
        file,
        path: textOf(value?.path),
        emojiId: textOf(value?.emojiId).toLowerCase(),
        packageId: value?.packageId === undefined || value?.packageId === null
          ? null
          : String(value.packageId),
        at: textOf(value?.at) || new Date(now()).toISOString(),
        seen: Number.isFinite(value?.seen) ? Number(value.seen) : 0,
        uses: Number.isFinite(value?.uses) ? Number(value.uses) : 0,
        lastUsedAt: textOf(value?.lastUsedAt) || null,
        tags: Array.isArray(value?.tags) ? value.tags.map((t) => String(t)).filter((t) => t !== '') : [],
        // 2026-10-19：set 这条也要存 desc —— 只改解析那处，回填会跑了但没落库。
        desc: textOf(value?.desc),
        modelTags: Array.isArray(value?.modelTags) ? tagListOf(value.modelTags) : (existing?.modelTags ?? []),
        modelDesc: typeof value?.modelDesc === 'string' ? textOf(value.modelDesc) : (existing?.modelDesc ?? ''),
        manualTags: Array.isArray(value?.manualTags) ? tagListOf(value.manualTags) : (existing?.manualTags ?? []),
        manualDesc: typeof value?.manualDesc === 'string' ? textOf(value.manualDesc) : (existing?.manualDesc ?? ''),
        manualVerdict: typeof value?.manualVerdict === 'string'
          ? textOf(value.manualVerdict)
          : (existing?.manualVerdict ?? ''),
        manualAt: typeof value?.manualAt === 'string' ? textOf(value.manualAt) : (existing?.manualAt ?? ''),
        source: value?.source !== null && typeof value?.source === 'object'
          ? { chatId: textOf(value.source.chatId), userId: textOf(value.source.userId) }
          : { chatId: '', userId: '' },
      });
      persist();
      return true;
    },
    /**
     * 把**人工标注字段**同步进内存条目（**不落盘**）。
     *
     * `sticker-labeling.mjs` 的保存路径是"自己带备份 + 原子写文件"，写完之后调这里
     * 把同一条内存记录也更新掉。不同步的话，下一次 `bumpSeen` / `recordUse` 的
     * `persist()` 会按内存里的旧形状重写整份文件，`manual*` 就被静默抹掉了。
     *
     * @returns {boolean} 内存里有没有这一条（没有 = 这次多半是新写的，忽略即可）
     */
    applyAnnotation(md5, patch) {
      const key = String(md5 ?? '').trim().toLowerCase();
      const found = entries.get(key);
      if (found === undefined || patch === null || typeof patch !== 'object') return false;
      if (Array.isArray(patch.modelTags)) found.modelTags = tagListOf(patch.modelTags);
      if (typeof patch.modelDesc === 'string') found.modelDesc = textOf(patch.modelDesc);
      if (Array.isArray(patch.manualTags)) found.manualTags = tagListOf(patch.manualTags);
      if (typeof patch.manualDesc === 'string') found.manualDesc = textOf(patch.manualDesc);
      if (typeof patch.manualVerdict === 'string') found.manualVerdict = textOf(patch.manualVerdict);
      if (typeof patch.manualAt === 'string') found.manualAt = textOf(patch.manualAt);
      return true;
    },
    /** 又见到同一张（**不是**发出）：`seen` 加一。 */
    bumpSeen(md5) {
      const key = String(md5 ?? '').trim().toLowerCase();
      const found = entries.get(key);
      if (found === undefined) return false;
      found.seen += 1;
      stats.seenBumps += 1;
      persist();
      return true;
    },
    /** **记一次使用**（真的发出去了才调，见 `gateway.mjs` 的 `#send`）。 */
    recordUse(md5) {
      const key = String(md5 ?? '').trim().toLowerCase();
      const found = entries.get(key);
      if (found === undefined) return false;
      found.uses += 1;
      found.lastUsedAt = new Date(now()).toISOString();
      persist();
      return true;
    },
    /** 给"认"回写标签（**允许空数组** = 还没认过）。 */
    setTags(md5, tags) {
      const key = String(md5 ?? '').trim().toLowerCase();
      const found = entries.get(key);
      if (found === undefined) return false;
      found.tags = (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter((t) => t !== '');
      persist();
      return true;
    },
    size: () => entries.size,
    persist,
    stats: () => ({ ...stats, size: entries.size, degraded, enabled: usable }),
  };
}

/**
 * 造一个表情包库：**偷**（harvest）+ 给"认/挑"用的只读接口。
 *
 * ## 任何一步失败都只是"这一张没入库"
 *
 * `harvest` **永不 reject**（网关是 fire-and-forget 调的，抛出去只会变成
 * 一条未捕获的 rejection）。失败分类计数，都在 `stats()` 里，可观测：
 * 下载失败 / 格式认不出 / 太大 / 不是表情包 / 并发闸跳过。
 *
 * ## 只收"判定为表情包"的
 *
 * 普通图（`sub_type: 0` 的照片/截图/梗图）**一个字节都不落盘** —— 判据是**位判据**
 * （`emoji_id` 非空 或 `sub_type & 1`），见 {@link isStickerSegment} 与模块注释。
 *
 * 注入了 `recognize` 时还有**第二道闸**：落盘前先"认"一次，
 * **`accept !== true`**（含"没看成"与"判了不收"）都**不入库**（见 `keepOne` 的 JSDoc）。
 *
 * @param {object} options
 * @param {object} [options.index] 注入一张索引（不传就按 `indexPath` 新建）
 * @param {string} [options.indexPath]
 * @param {string} [options.dir] 库目录（图往这里落）
 * @param {boolean} [options.enabled] `false` = 整个"偷"关掉（发图那半边不受影响）
 * @param {Function} [options.log]
 * @param {object} [options.fsImpl]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.botQQ] 用于按名字找本地原件（同 `image-cache.mjs`）
 * @param {string[]} [options.originalDirs] 本地原件目录模板
 * @param {() => number} [options.now]
 * @param {number} [options.maxEntries]
 * @param {((image: {data: Uint8Array, mediaType: string, name?: string}, meta: {chatId: string, userId: string, subType: unknown}) => Promise<{ok?: boolean, accept?: boolean, reject?: string|null, rejects?: string[], scores?: object, isSticker?: boolean, portrait?: boolean, screenshot?: boolean, captionChars?: number, tags?: string[], desc?: string}|null>)|null} [options.recognize]
 *   「认」那一步（`image-desc.mjs` 的 `describeSticker`）。**不传 = 这一档整个不跑**
 *   （没有视觉服务的部署照样能攒图，只是 tags 全空、也没有审核闸）。
 *   传了就是 **fail-closed**：`ok !== true`（没看成）或 `accept !== true`（判了不收）都不入库。
 *   ⚠️ **阈值比较不在这里**：判定只有一份，在 `image-desc.mjs` 的 `sanitizeStickerVerdict`
 *   里做完（打分 vs 阈值、配文长度、真人/截图），这一层只读 `ok` / `accept` 两个布尔 ——
 *   两处各写一遍阈值，迟早分叉，而分叉的表现是"两条路的结论不一样"。
 * @returns {object}
 */
export function createStickerLibrary({
  index = null,
  indexPath = DEFAULT_STICKER_INDEX_PATH,
  auditPath = DEFAULT_STICKER_AUDIT_INDEX_PATH,
  dir = DEFAULT_STICKER_DIR,
  enabled = true,
  log = () => {},
  fsImpl = nodeFs,
  fetchImpl = fetch,
  botQQ = '',
  originalDirs = [],
  now = () => Date.now(),
  maxEntries = DEFAULT_MAX_STICKERS,
  recognize = null,
} = {}) {
  const stickerDir = String(dir ?? '').trim();
  const indexPathSafe = String(indexPath ?? '').trim();
  const auditPathSafe = String(auditPath ?? '').trim();
  // 没给目录 = 明确关掉（不猜一个默认目录往用户磁盘上写）。
  const usable = enabled === true && stickerDir !== '';
  const table = index ?? createStickerIndex({
    filePath: indexPathSafe,
    log,
    fsImpl,
    maxEntries,
    now,
  });

  const stats = {
    harvested: 0, stored: 0, dedup: 0, nearMiss: 0,
    nearMissPackage: 0,
    // 「认」（注入 `recognize` 时才有）的两档结果：
    // `rejected` = 审核闸判**不收**（真人 / 截图 / 配文超长 / 打分过了阈值，不入库）；
    // `auditFailed` = **没看成**（模型没答全，也不入库 —— 但它下次出现会重认）。
    // ⚠️ 这两档**必须分开计**：`rejected` 涨 = 判据在拦（该调阈值或判据）；
    //    `auditFailed` 涨 = 模型/链路的问题（该改提示词）。合成一个数就分不出该修哪边了。
    // ⚠️ 上一批的 `nearMissAnimated` **已删**：它数的那一类（`sub_type & 1`）
    //    现在直接入库，留着就是一个恒为 0 的死字段（这个项目专门记过这一类坑）。
    rejected: 0, auditFailed: 0,
    failed: 0, unrecognized: 0, tooLarge: 0, skipped: 0, idMatched: 0, idMismatch: 0,
  };
  let pending = 0;
  /** 串行链：偷是后台活，没必要并发下载（也让测试里可确定地 await）。 */
  let chain = Promise.resolve();

  const finder = createOriginalFinder({
    dirs: originalDirs,
    botQQ,
    log,
    ...(fsImpl === null ? {} : { fsImpl }),
  });

  /** 取一张图的**原件字节**：本地优先（零网络）→ 下载。 */
  async function bytesOf(segment) {
    const local = finder.find(segment);
    if (local !== null) return { data: local.data, via: local.via };
    const got = await fetchImageBytes(segment, {
      fetchImpl,
      ...(fsImpl === null ? {} : { fsImpl }),
    });
    return got === null ? null : { data: got.data, via: 'download' };
  }

  /**
   * 把一条表情包段落盘入库。
   * 返回 `'stored' | 'dedup' | 'rejected' | 'audit-failed' | 'failed' | …`。
   *
   * ## 「认」这一步（只有注入了 `recognize` 才跑）
   *
   * 顺序是**先认后存**，因为审核闸的结论要能**拦下这一张**：
   *
   * ```
   * 判据 → 零网络去重 → 取字节 → 体积/格式 → 内容去重 → ★认 → 落盘 + 写索引（tags 一起写）
   * ```
   *
   * ⚠️ 「认」在**两种去重之后**：同一张图第二次出现时一次调用都不花
   * （这条容易写错，错了的表现是"同一张刷屏的图被反复送去认"，而计数上完全看不出来）。
   *
   * 三种结果：
   * - **没配 `recognize`**（没有视觉服务的部署）→ 行为与上一批一致：存，`tags: []`；
   * - **`ok !== true`**（没看成：没有视觉服务 / 取不到字节 / 不是 JSON / `scores` 不完整）
   *   → **不入库**，计 `auditFailed`。
   *   ⚠️ 这是 **fail-closed**：宁可让它下次再出现时重认一次（一次调用），
   *   也不把一张**没看过**的图塞进"以后要发出去"的库里。
   *   ⚠️ 而且**这就是天然的重试**：没入库 ⇒ md5 没写进索引 ⇒ 同一张图下次出现会重来一遍。
   *   所以「认」那一层**不再自己重试**（理由见 `image-desc.mjs` 的模块注释）。
   * - **`accept !== true`**（看成了，但判不收：真人 / 截图 / 配文超长 / 四项打分有超阈值的）
   *   → **不入库**，计 `rejected`。审核闸若什么都不拦，那它就只是个装饰
   *   —— `image-desc.mjs` 的判据会白写。
   */
  async function keepOne(segment, { chatId, userId }) {
    const evidence = stickerEvidence(segment);
    if (evidence.verdict === 'near-miss') {
      stats.nearMiss += 1;
      stats.nearMissPackage += 1;
      // ⚠️ 这条日志是**判据覆盖面**的现场证据：它一直涨就说明"库里几乎没东西"
      //    不是坏了，而是判据没覆盖到这一类（要不要收是一个要拍板的决定）。
      log('info', '疑似表情包但只有包 id（本次判据不收，仅记录）', {
        reason: evidence.reason,
        packageId: evidence.packageId,
        subType: segment?.sub_type ?? segment?.data?.sub_type ?? null,
        summary: String(segment?.summary ?? segment?.data?.summary ?? '').slice(0, 20),
        chatId,
      });
      return 'near-miss';
    }
    if (evidence.verdict !== 'sticker') {
      return 'not-sticker';
    }

    // ① 零网络去重：`emoji_id` 核对过的条目可以直接命中（见 createStickerIndex 的说明）。
    const known = typeof table.getByEmojiId === 'function' ? table.getByEmojiId(evidence.emojiId) : null;
    if (known !== null) {
      stats.dedup += 1;
      table.bumpSeen(known.md5);
      return 'dedup';
    }

    // ② 取字节
    const got = await bytesOf(segment);
    if (got === null) {
      stats.failed += 1;
      log('debug', '表情包取字节失败（本地没找到、下载也没成功）', {
        emojiId: evidence.emojiId,
        chatId,
      });
      return 'failed';
    }
    if (got.data.length > MAX_STICKER_BYTES) {
      stats.tooLarge += 1;
      log('info', '表情包超过单张上限，不入库', {
        bytes: got.data.length,
        limit: MAX_STICKER_BYTES,
      });
      return 'too-large';
    }
    const format = stickerFormatOf(got.data);
    if (format === null) {
      // 认不出的格式**不入库**：存下去也发不回来（出站要靠格式判断扩展名）。
      stats.unrecognized += 1;
      log('debug', '表情包格式认不出，不入库', { bytes: got.data.length });
      return 'unrecognized';
    }

    // ③ 内容 md5 就是身份 —— 也顺手把这次观测到的 `emoji_id` 补进条目里
    //    （补上之后，这张表情包下次就是**零网络**命中，见 `getByEmojiId`）。
    const md5 = md5Hex(got.data);
    const already = table.get(md5);
    if (already !== null) {
      stats.dedup += 1;
      table.bumpSeen(md5);
      if (already.emojiId === '' && evidence.emojiId !== '') {
        table.set(md5, { ...already, emojiId: evidence.emojiId });
      }
      return 'dedup';
    }

    // ③b 「认」：一次调用出 safe / text / desc / tags（见本函数的 JSDoc）。
    //     ⚠️ 位置是**内容去重之后**，两个理由：
    //     1. 同一张图第二次出现时 md5 命中就 return 了 ⇒ **不再花一次"认"的钱**
    //        （实测这条很容易写错：放在去重之前，一张刷屏的图会被反复送去认）；
    //     2. 它只该喂给**真正要入库的那一张** —— 认完是要落盘的，而落盘用的是这份字节。
    //     拿字节直接问（**不要再下载一次** —— 字节已经在手上）。
    /**
     * 「认」的返回：**审核闸的判定全在 `image-desc.mjs` 里做完**（打分 vs 阈值），
     * 这一层只读 `ok` 与 `accept` 两个布尔。别在这儿再写一遍阈值比较 ——
     * 判定逻辑只能有一份，写两遍迟早分叉。
     * @type {{ok?: boolean, accept?: boolean, reject?: string|null, rejects?: string[], scores?: object, isSticker?: boolean, portrait?: boolean, screenshot?: boolean, captionChars?: number, caption?: string, tags?: string[], desc?: string}|null}
     */
    let verdict = null;
    if (typeof recognize === 'function') {
      try {
        verdict = await recognize(
          { data: got.data, mediaType: format.mediaType, name: String(segment?.file ?? segment?.data?.file ?? '') },
          { chatId, userId, subType: segment?.sub_type ?? segment?.data?.sub_type ?? null },
        );
      } catch (error) {
        verdict = null;
        log('warn', '「认」这一步抛错（按没看成处理，不入库）', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (verdict === null || verdict?.ok !== true) {
        stats.auditFailed += 1;
        log('info', '「认」没看成（不可信 ⇒ 不入库，等它下次再出现时重认）', { chatId });
        return 'audit-failed';
      }
      if (verdict.accept !== true) {
        stats.rejected += 1;
        log('info', '表情包没过审核闸，不入库', {
          // 把"哪几条判据在拦"连同**当时的分数**一起打出来 ——
          // 用户要靠这行日志调阈值（"模型打分偏松还是偏紧"只能从这儿看出来）。
          reject: verdict.reject ?? null,
          rejects: Array.isArray(verdict.rejects) ? verdict.rejects : [],
          scores: verdict.scores ?? null,
          isSticker: verdict.isSticker === true,
          portrait: verdict.portrait === true,
          screenshot: verdict.screenshot === true,
          captionChars: verdict.captionChars ?? 0,
          caption: String(verdict.caption ?? '').slice(0, 40),
          desc: String(verdict.desc ?? '').slice(0, 40),
          chatId,
        });
        return 'rejected';
      }
    }

    // 顺手记一笔"QQ 给的 emoji_id 是不是内容 md5"——实测**不是**（见模块注释），
    // 这个计数就是那条结论的持续证据。它不参与任何判断。
    if (evidence.emojiId.toLowerCase() === md5) stats.idMatched += 1;
    else stats.idMismatch += 1;

    // ④ 落盘 + 写索引
    try {
      fsImpl.mkdirSync(stickerDir, { recursive: true });
      const name = `${md5}.${format.ext}`;
      const full = path.join(stickerDir, name);
      fsImpl.writeFileSync(full, Buffer.from(got.data));
      // 标签就是「认」给的那 1–3 个枚举值（没配 `recognize` 时是空数组 —— **允许为空**）。
      const tags = Array.isArray(verdict?.tags) ? verdict.tags.map((t) => String(t)).filter((t) => t !== '') : [];
      table.set(md5, {
        file: name,
        path: full,
        emojiId: evidence.emojiId,
        packageId: evidence.packageId,
        at: new Date(now()).toISOString(),
        seen: 0,
        uses: 0,
        lastUsedAt: null,
        tags,
        // 2026-10-19：**描述也进库**。以前 desc 只留在审核留样的 index.jsonl 里，
        // 于是 pick 只能靠标签 —— 「troll 表情被当成开心满足」就是这么来的。
        desc: String(verdict?.desc ?? '').trim(),
        source: { chatId: String(chatId ?? ''), userId: String(userId ?? '') },
      });
      stats.stored += 1;
      log('info', '表情包入库', {
        md5,
        name,
        via: got.via,
        bytes: got.data.length,
        emojiIdMatched: evidence.emojiId.toLowerCase() === md5,
        tags,
        chatId,
      });
      return 'stored';
    } catch (error) {
      stats.failed += 1;
      log('warn', '表情包落盘失败', {
        error: error instanceof Error ? error.message : String(error),
        dir: stickerDir,
      });
      return 'failed';
    }
  }

  /**
   * 描述表（`md5 → 一句画面描述`），从审核留样的 `index.jsonl` 读 —— 2026-10-19。
   *
   * - 一个 md5 可能有多条记录（审核重跑过）⇒ **后写的覆盖先写的**；
   * - 缓存 60 秒（**不 stat**：`fsImpl` 是注入的，测试替身不一定有 `statSync`）；
   * - 读不到就返回空 Map，**永不抛** —— 没描述只是挑得粗一点，
   *   不该让"发表情包"这件事整个失败。
   */
  let descCache = { at: 0, map: new Map() };
  /** 老库「desc 回填」只做一次（见 pick 里那段）。 */
  let didBackfill = false;
  const DESC_TTL_MS = 60_000;
  function descriptionsMap() {
    const at = now();
    // 2026-10-19：**空表也缓存** —— 否则"库里有图但没描述"时每次 pick 都整份重读 jsonl。
    if (descCache.at > 0 && at - descCache.at < DESC_TTL_MS) return descCache.map;
    const map = new Map();
    if (auditPathSafe !== '') {
      try {
        const text = String(fsImpl.readFileSync(auditPathSafe, 'utf8'));
        for (const line of text.split(/\r?\n/)) {
          if (line.trim() === '') continue;
          let record = null;
          try {
            record = JSON.parse(line);
          } catch {
            continue; // 坏行跳过 —— 这是"追加写"的日志，尾部半行很常见
          }
          const md5 = String(record?.md5 ?? '').trim().toLowerCase();
          const desc = String(record?.desc ?? '').trim();
          if (md5 !== '' && desc !== '') map.set(md5, desc);
        }
      } catch {
        // 文件不在 / 读不了 ⇒ 空表（不是错误）
      }
    }
    descCache = { at, map };
    return map;
  }

  return {
    /**
     * **偷**：把消息段里的表情包捞进库。
     *
     * 返回一个**永不 reject** 的 promise，结果对象是给日志/测试看的计数。
     * 同一个库内部**串行**执行（不并发下载）；同时在跑的超过
     * {@link MAX_PENDING_HARVESTS} 时**直接跳过**这一批。
     *
     * @param {Array<Record<string, unknown>>} segments
     * @param {{chatId?: string, userId?: string}} [meta]
     * @returns {Promise<{stored: number, dedup: number, nearMiss: number, skipped: number, failed: number, rejected: number, auditFailed: number, unrecognized: number, tooLarge: number}>}
     */
    harvest(segments, { chatId = '', userId = '' } = {}) {
      const empty = {
        stored: 0, dedup: 0, nearMiss: 0, skipped: 0, failed: 0,
        rejected: 0, auditFailed: 0, unrecognized: 0, tooLarge: 0,
      };
      if (!usable) return Promise.resolve(empty);
      // ⚠️ 过滤器要**连 `near-miss` 一起放进来**（它在 `keepOne` 里计数并记日志）。
      //    只留 `verdict === 'sticker'` 会让"只有包 id"这一档永远为 0 ——
      //    于是判据该放宽的时候，日志里一点迹象都没有（静默不生效那一类）。
      const list = (Array.isArray(segments) ? segments : [])
        .filter((s) => stickerEvidence(s).verdict !== 'not-sticker');
      if (list.length === 0) return Promise.resolve(empty);
      if (pending >= MAX_PENDING_HARVESTS) {
        stats.skipped += 1;
        log('debug', '偷表情包的并发闸挡住了这一批（跳过，不排队）', { pending });
        return Promise.resolve({ ...empty, skipped: list.length });
      }

      const picked = list.slice(0, MAX_STICKERS_PER_MESSAGE);
      stats.harvested += picked.length;
      pending += 1;
      const task = chain
        .catch(() => undefined)
        .then(async () => {
          const result = { ...empty, skipped: list.length - picked.length };
          for (const segment of picked) {
            const outcome = await keepOne(segment, { chatId, userId });
            if (outcome === 'stored') result.stored += 1;
            else if (outcome === 'dedup') result.dedup += 1;
            else if (outcome === 'near-miss') result.nearMiss += 1;
            else if (outcome === 'rejected') result.rejected += 1;
            else if (outcome === 'audit-failed') result.auditFailed += 1;
            else if (outcome === 'too-large') result.tooLarge += 1;
            else if (outcome === 'unrecognized') result.unrecognized += 1;
            else if (outcome === 'failed') result.failed += 1;
          }
          return result;
        });
      // chain 永远保持"已 resolve"（`catch` 兜住），否则一次失败会毒死后面所有偷。
      chain = task.then(() => undefined, () => undefined);
      return task.finally(() => {
        pending -= 1;
      });
    },

    /** 库里有没有这一条。 */
    has(md5) {
      return table.get(md5) !== null;
    },
    /** 取一条（只读快照）。 */
    get(md5) {
      return table.get(md5);
    },
    /** 全部条目（只读快照）。 **纯读，不做选择。** */
    all() {
      return table.all();
    },
    /**
     * 按标签取一批（**纯查询，不挑**）。
     * @param {{tags?: string[]}} [options]
     */
    findByTags(options) {
      return table.findByTags(options);
    },
    /**
     * 一条表情包的**可发送来源**（本地绝对路径）。
     *
     * 返回 `null` = 库里没有 / 文件已经不在盘上。**两种情况都不猜**：
     * 路径搬家、文件被人删了，都应该表现为"发不出去"，而不是发一张别的图。
     *
     * @param {string} md5
     * @returns {string|null}
     */
    /**
     * **挑一张发出去**（2026-10-19 补上；当初刻意留白的那一步）。
     *
     * ## 为什么之前没做
     * 模块开头那句原话：「挑刻意不实现 —— 那是下一批，而且属于产品决定（骰子还是视觉）」。
     * 用户 2026-10-19 拍了**骰子**，并且采纳了小鲸鱼的三条建议：
     *
     * 1. **先按标签筛候选**（聊天里的情绪 → 她给 1~2 个类）；
     * 2. **有描述的按描述挑**（描述来自审核留样的 `index.jsonl`；没描述就退回标签本身）；
     * 3. **同类内按"该类数量"反比加权** —— 否则永远只发「卖萌可爱」（95/120 = 79%）。
     *
     * ## 实现口径
     * - 权重 = Σ(1 / 该类张数) —— 匹配到的每个标签各贡献一份，越冷门的类权重越高；
     * - 给了 `mood` 时，对**有描述**的候选再乘一个「字面贴合」系数（中文二元组重合率，
     *   `1 + 3 × 重合率`，上限 ×4）。**刻意不调模型**：那会变成每发一张图一次请求，
     *   而且她本来就知道自己想表达什么，用一个词的骰子更划算；
     * - 最后按权重做**加权随机**（同样贴合的两张，仍然随机 —— 不然每次都是同一张）。
     *
     * @param {{tags?: string[], mood?: string}} [options]
     *   `tags` 空 = 全库；`mood` 空 = 只看标签。
     * @returns {object|null} 一条快照（含 `md5`）；挑不出来返回 `null`（**不抛**）
     */
    pick({ tags = [], mood = '' } = {}) {
      const wanted = (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter((t) => t !== '');
      const all = table.all();
      if (all.length === 0) return null;

      // 反比加权需要**全库**的标签计数（不是候选内的 —— 那是同一批，比不出冷热）。
      const counts = new Map();
      for (const entry of all) {
        for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }

      const candidates = wanted.length === 0
        ? all
        : all.filter((entry) => entry.tags.some((tag) => wanted.includes(tag)));
      if (candidates.length === 0) return null;

      const descs = descriptionsMap();

      // 2026-10-19：**老库一次性回填**。120 条是"desc 还没进库"之前存的，
      // 空着就等于永远只能靠标签挑。这里从审核表补一次（只补空，不覆盖已有的），
      // 之后走的是条目自带的 desc —— 审核表没了也不影响。
      if (!didBackfill && descs.size > 0) {
        didBackfill = true;
        let filled = 0;
        for (const entry of table.all()) {
          if (String(entry.desc ?? '') !== '') continue;
          const fromAudit = descs.get(entry.md5);
          if (fromAudit === undefined || fromAudit === '') continue;
          table.set(entry.md5, { ...entry, desc: fromAudit });
          filled += 1;
        }
        if (filled > 0) log('info', '表情包描述已回填进库（老条目只有标签）', { filled });
      }
      const key = String(mood ?? '').trim();

      // 中文二元组重合率（0~1）。够便宜，也不依赖分词。
      const bigrams = (text) => {
        const clean = String(text).replace(/[\s\p{P}\p{S}]/gu, '');
        const out = new Set();
        for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2));
        return out;
      };
      const keyGrams = key === '' ? null : bigrams(key);

      const scored = candidates.map((entry) => {
        let weight = 1;
        if (wanted.length > 0) {
          weight = 0;
          for (const tag of entry.tags) {
            if (wanted.includes(tag)) weight += 1 / Math.max(1, counts.get(tag) ?? 1);
          }
          if (!(weight > 0)) weight = 1;
        }
        if (keyGrams !== null && keyGrams.size > 0) {
          const desc = String(entry.desc ?? '') !== '' ? String(entry.desc) : (descs.get(entry.md5) ?? '');
          if (desc !== '') {
            const grams = bigrams(desc);
            let hit = 0;
            for (const g of keyGrams) if (grams.has(g)) hit += 1;
            weight *= 1 + 3 * (hit / keyGrams.size);
          }
        }
        return { entry, weight };
      });

      const total = scored.reduce((sum, item) => sum + item.weight, 0);
      if (!(total > 0)) return scored[Math.floor(Math.random() * scored.length)].entry;
      let r = Math.random() * total;
      for (const item of scored) {
        r -= item.weight;
        if (r <= 0) return item.entry;
      }
      return scored[scored.length - 1].entry;
    },
    pathOf(md5) {
      const entry = table.get(md5);
      if (entry === null || entry.file === '') return null;
      const full = path.join(stickerDir, entry.file);
      try {
        const stat = fsImpl.statSync(full);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) return null;
      } catch {
        return null;
      }
      return full;
    },
    /** **记一次使用**（真发出去了才调）。给"挑"留的依据。 */
    recordUse(md5) {
      return table.recordUse(md5);
    },
    /**
     * 直接写/覆盖一条（2026-10-19 补：给 `look_sticker` **回写 `desc`** 用）。
     *
     * 为什么现在才加：包装层原来只暴露 `setTags`，而 `desc` 的回写发生在
     * `gateway.lookFromTool`（它手上只有**库**，不是索引对象）——
     * 没有这个方法，那条"看一次补一条描述"就会**静默地什么都不写**
     * （`typeof set !== 'function'` ⇒ `saved:false`，只有一条 warn）。
     *
     * 内部就是 `table.set`：形状校验与**落盘**都在那里（原子写 + 1:1 覆盖）。
     * @param {string} md5
     * @param {object} value 至少要有 `file`（否则 `table.set` 返回 false）
     * @returns {boolean} 是否被记住（落盘是尽力而为）
     */
    set(md5, value) {
      return table.set(md5, value);
    },
    /** 给"认"回写情感标签（**允许空数组**）。 */
    setTags(md5, tags) {
      return table.setTags(md5, tags);
    },
    /**
     * 人工标注字段的**内存同步**（不落盘）。
     *
     * 见 `createStickerIndex.applyAnnotation`：保存那条路自己写文件（带备份），
     * 这里只负责让内存形状跟上去，避免下一次 `persist()` 把 `manual*` 抹掉。
     */
    applyAnnotation(md5, patch) {
      return table.applyAnnotation(md5, patch);
    },
    /** 库目录（诊断用）。 */
    dir: () => stickerDir,
    /** 计数 + 索引自身状态（`degraded` / `enabled` / `size`）。 */
    stats: () => ({ ...stats, pending, dir: stickerDir, index: table.stats() }),
  };
}
