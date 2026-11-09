/**
 * 表情包**人工标注**（2026-11-06）：给配置页「表情标注」页用的后端。
 *
 * ## 为什么要有这一层
 *
 * 用户反馈模型给表情包打的 `tags` / 写的 `desc` **大部分和真实想表达的意思对不上**
 * （例：竖大拇指被判成「玩梗接梗」而不是「赞同支持」）。要改判据，先得有一把尺子：
 * 人工逐张复标一小批，再拿模型原判去对。
 *
 * 所以这里的职责只有四件，而且**刻意不碰模型那条路**：
 *
 * 1. **抽样**：从未标注的条目里抽一批，尽量让这一批的原始标签不重复（见 {@link sampleBatch}）；
 * 2. **落库**：把人工结果写回 `qq-stickers.json`，**先备份、临时文件 + rename、失败回滚**；
 * 3. **对账**：标签级命中（人工标签被模型命中多少 / 模型多给了多少）+ 三档对错分布；
 * 4. **导出**：整份人工标注集导成 JSON，留着当长期评估集。
 *
 * ## 字段契约（写进 `entries[<md5>]`）
 *
 * | 字段 | 谁写 | 说明 |
 * |---|---|---|
 * | `tags` / `desc` | 模型 | **原样不动** —— 这是被评估的对象 |
 * | `modelTags` / `modelDesc` | 首次标注时从 `tags` / `desc` 拷一份 | 之后模型重跑（原路写 `tags`）也不会污染评估基准 |
 * | `manualTags` | 人工 | 17 个枚举值，按 {@link ANNOTATE_TAGS} 顺序规范化 |
 * | `manualDesc` | 人工 | 一句描述（超长截断，见 {@link MAX_MANUAL_DESC_CHARS}） |
 * | `manualVerdict` | 人工 | `对` / `半对` / `错`（空串 = 还没评） |
 * | `manualAt` | 自动 | ISO 时间；**有它才算标过**（抽样"未标注优先"就看这个） |
 *
 * ⚠️ `modelTags` / `modelDesc` 只在**缺失时**补：第二次保存不许用当时的 `tags`
 * 覆盖第一次的基准，否则"模型改名 → 人工重标"会把历史判断一起改掉，评估集就没意义了。
 *
 * ⚠️ 同一条素材可能被别人同时写（`sticker-library` 的 `seen` 自增、`look_sticker` 回写
 * `desc`）。所以保存走**读盘 → 只改这一条的标注字段 → 整份原子写**，并且写成功后把
 * 标注字段同步回 `sticker-library` 的内存条目（`applyAnnotation`），否则它下一次
 * `persist()` 会按内存里的旧形状把 `manual*` 整段抹掉。
 * 残留的窗口：如果库恰好在"我们读盘"与"我们 rename"之间自己 `persist()` 了一次，
 * 那一笔（例如 `seen` 的 +1）会被这次整份写覆盖掉。窗口是毫秒级、且只影响计数，
 * 所以不做文件锁 —— 但知道它存在，比事后猜"计数怎么少了一个"强。
 *
 * ## 接口永不 500
 *
 * 这些 handler 挂在宿主 `webServer` 上，抛出去就是配置页整页挂掉。所以每个 handler
 * 自己 `try/catch`，坏数据一律降级成 `{ok:false, error}`（HTTP 200）+ 一条 warn。
 *
 * @module qq-gugu/sticker-labeling
 */

import fs from 'node:fs';
import path from 'node:path';

import { STICKER_TAG_COVERAGE } from './sticker-tags.mjs';

/**
 * 人工标注可选标签（**17 个**：2026-11-06 用户给的 16 个清单与顺序 + 同日追加的 `幸灾乐祸`）。
 *
 * 与模型那 18 个的差别：**不含** `社交互动`（用户这份清单里没有），
 * 也不含兜底桶 `其他`。对账时模型给了清单外的标签（例如 `社交互动`）
 * 不算"遗漏"，只算"多余"，并且单独列在报告的 `otherTags` 里 ——
 * 归到哪一档是**口径**，不是错误，所以显式写在这里。
 *
 * ⚠️ 新标签**追加在末尾**，不动前 16 个的顺序：页面上胶囊的顺序、以及
 * `normalizeManualTags` 的排序都按这个数组，插在中间会让老标注的显示顺序变。
 */
export const ANNOTATE_TAGS = Object.freeze([
  '卖萌可爱',
  '幽默搞笑',
  '无语无奈',
  '玩梗接梗',
  '调侃吐槽',
  '开心满足',
  '困惑不解',
  '害羞心动',
  '治愈陪伴',
  '生气不满',
  '难过不安',
  '震惊惊讶',
  '尴尬社死',
  '吃瓜围观',
  '得意自信',
  '赞同支持',
  // 2026-11-06 第 17 个：看别人倒霉时的笑（不是安慰、也不是自嘲）。
  // 用户标注时发现「像素笑脸抱着自己笑到流泪」这类图没有对应标签，
  // 最接近的「调侃吐槽」（嘴上损人）语义不够、「得意自信」（笑自己/炫耀）也不对。
  '幸灾乐祸',
]);

/** 三档人工判词（顺序即页面按钮顺序）。 */
export const MANUAL_VERDICTS = Object.freeze(['对', '半对', '错']);

/** 一屏默认几张（用户原话"10 张 15 张"，取中间值 12）。 */
export const DEFAULT_BATCH_SIZE = 12;

/** 上限（再多页面就滚成一条线了；也给"手改 URL"留个闸）。 */
export const MAX_BATCH_SIZE = 30;

/** 人工描述的字数上限（一句描述，不要写成小作文）。 */
export const MAX_MANUAL_DESC_CHARS = 200;

/** 路由前缀（挂在宿主 webServer 上，经临时配置服务转发）。 */
export const STICKER_LABEL_ROUTE_BASE = '/dsh-qq-proactive/sticker-label';

/** 导出文件的 schema 标识：以后评估脚本按它认版本。 */
export const LABEL_DATASET_SCHEMA = 'qq-sticker-manual-label-v1';

/** 单张图的体积上限（与 `sticker-library` 的 `MAX_STICKER_BYTES` 同量级）。 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** 请求体上限（一条标注就几百字节，64 KiB 已经非常宽）。 */
const MAX_BODY_BYTES = 64 * 1024;

const EXT_TYPES = new Map([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);

const MD5_RE = /^[a-f0-9]{32}$/;

/** 把任意值压成去空白的字符串。 */
function textOf(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/** md5 规范化：小写 + 只认 32 位十六进制（顺带挡掉 `../` 一类路径穿越）。 */
export function normalizeMd5(value) {
  const key = textOf(value).trim().toLowerCase();
  return MD5_RE.test(key) ? key : '';
}

/**
 * 人工标签规范化：只认 {@link ANNOTATE_TAGS}，去重，按枚举顺序排。
 *
 * 认不出的值**静默丢掉**（页面只会发这 17 个；能落到这里的未知值说明客户端被改过）。
 */
export function normalizeManualTags(raw) {
  const list = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  const wanted = new Set(list.map((item) => textOf(item).trim()).filter((item) => item !== ''));
  return ANNOTATE_TAGS.filter((tag) => wanted.has(tag));
}

/** 三档判词规范化：认不出的当"没评"。 */
export function normalizeVerdict(raw) {
  const text = textOf(raw).trim();
  return MANUAL_VERDICTS.includes(text) ? text : '';
}

/** 模型标签规范化：**不裁剪**（模型给过什么就记什么，包括清单外的值）。 */
export function normalizeModelTags(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const tag = textOf(item).trim();
    if (tag !== '' && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** 人工描述规范化：去首尾空白 + 截断到 {@link MAX_MANUAL_DESC_CHARS} 字。 */
export function normalizeManualDesc(raw) {
  const text = textOf(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length > MAX_MANUAL_DESC_CHARS ? text.slice(0, MAX_MANUAL_DESC_CHARS) : text;
}

/** 一批几张：非数字回落默认值，越界夹到 `[1, MAX_BATCH_SIZE]`。 */
export function clampBatchSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(n)));
}

/**
 * 一个条目的"主标签"：`tags[0]`（入库时按枚举顺序排过，第一个就是最主的那一类）。
 * 没有标签的归到 `未标` 这个桶 —— 它反而是**最该被看**的一批（模型什么都没说）。
 */
function primaryTagOf(entry) {
  const tags = normalizeModelTags(entry?.tags);
  if (tags.length > 0) return tags[0];
  // 已经标过的条目，报告/重标时用冻结的模型标签做桶（`tags` 被模型重跑改过也不影响）
  const frozen = normalizeModelTags(entry?.modelTags);
  return frozen.length > 0 ? frozen[0] : '未标';
}

/** 冷门优先的排序键：占比越低越靠前；认不出的（含 `未标`）按 0 处理，最先抽到。 */
function rarityOf(tag) {
  const value = STICKER_TAG_COVERAGE[tag];
  return Number.isFinite(value) ? value : 0;
}

/**
 * 从候选里抽一批：**未标注优先 + 主标签轮转**。
 *
 * 用户的原话是"别 12 张全是「卖萌可爱」"。库里 180/228 都是「卖萌可爱」，
 * 纯随机抽出来的那一批几乎必然是它 —— 所以这里不随机：
 *
 * 1. 先只留**没标过**的（`manualAt` 为空）；不够一批时才退回全库（重标）；
 * 2. 按主标签分桶，**桶按冷门优先排序**（`STICKER_TAG_COVERAGE` 升序；
 *    `未标` 与清单外标签按最冷处理），再按 `cursor` 轮转起点；
 * 3. **逐桶轮流各取一张**，取满为止 —— 一屏 12 张因此最多 12 个不同主标签；
 * 4. 桶内从 `cursor × size` 处开始取，所以「换一批」（cursor+1）换的是**另一屏**，
 *    而不是只挪一张。
 *
 * 确定性：同样的 `entries` + `cursor` 一定给出同一批（可测，也不会有"翻回上一批全变了"）。
 *
 * @param {Array<object>} entries 条目（至少要有 `md5` / `tags` / `manualAt`）
 * @param {{size?: number, cursor?: number}} [options]
 * @returns {{items: object[], nextCursor: number, poolSize: number, freshOnly: boolean}}
 */
export function sampleBatch(entries, { size = DEFAULT_BATCH_SIZE, cursor = 0 } = {}) {
  const limit = clampBatchSize(size);
  const c = Number.isFinite(Number(cursor)) ? Math.max(0, Math.floor(Number(cursor))) : 0;
  const list = Array.isArray(entries) ? entries.filter((entry) => entry !== null && typeof entry === 'object') : [];
  const fresh = list.filter((entry) => textOf(entry.manualAt).trim() === '');
  const freshOnly = fresh.length >= limit;
  const pool = freshOnly ? fresh : list.slice();
  if (pool.length === 0) return { items: [], nextCursor: c, poolSize: 0, freshOnly };

  /** @type {Map<string, object[]>} */
  const buckets = new Map();
  for (const entry of pool) {
    const tag = primaryTagOf(entry);
    if (!buckets.has(tag)) buckets.set(tag, []);
    buckets.get(tag).push(entry);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => textOf(left.md5).localeCompare(textOf(right.md5)));
  }

  const order = [...buckets.keys()].sort((left, right) => {
    const delta = rarityOf(left) - rarityOf(right);
    return delta !== 0 ? delta : left.localeCompare(right);
  });
  const start = c % order.length;
  const rotated = order.slice(start).concat(order.slice(0, start));

  // 每桶的起点随 cursor 平移**一整批**：cursor 每 +1，各桶都换一屏
  // （只挪 1 张的话，两批之间会重叠 11/12 —— "换一批"点下去看起来几乎没变）。
  const stride = c * limit;
  const pointers = new Map();
  for (const tag of rotated) {
    const bucket = buckets.get(tag);
    pointers.set(tag, (stride + bucket.length) % bucket.length);
  }

  const picked = [];
  const used = new Set();
  let guard = 0;
  while (picked.length < limit && guard <= pool.length + 8) {
    let added = false;
    for (const tag of rotated) {
      if (picked.length >= limit) break;
      const bucket = buckets.get(tag);
      const from = pointers.get(tag) ?? 0;
      for (let offset = 0; offset < bucket.length; offset += 1) {
        const candidate = bucket[(from + offset) % bucket.length];
        const key = textOf(candidate.md5);
        if (used.has(key)) continue;
        used.add(key);
        pointers.set(tag, (from + offset + 1) % bucket.length);
        picked.push(candidate);
        added = true;
        break;
      }
    }
    guard += 1;
    if (!added) break;
  }

  return { items: picked, nextCursor: c + 1, poolSize: pool.length, freshOnly };
}

/**
 * 对账：**纯函数**，不读盘。
 *
 * 口径：
 * - `tagRecall` = 人工标签里被模型命中的比例（"模型漏了多少"看 `1 - tagRecall`）；
 * - `tagExtraRate` = 模型给的标签里人工没选的比例（"模型多给了多少"）；
 * - `tagPrecision` = `1 - tagExtraRate`（同一条也报两种说法，避免有人把方向看反）；
 * - 三档：`对` / `半对` / `错` 各几张；`strict` = 对/已标注，`soft` = (对 + 半对/2)/已标注。
 *
 * 空集一律返回 `null` 比率而不是 0/NaN —— "还没标"和"标了全错"必须分得开。
 *
 * @param {Array<object>} items 带 `manualTags` / `manualVerdict` / `modelTags`（或 `tags`）的条目
 */
export function computeAccuracy(items) {
  const rows = new Map();
  for (const tag of ANNOTATE_TAGS) rows.set(tag, { tag, manual: 0, hit: 0, model: 0, extra: 0 });
  /** 模型给了、但不在 16 个枚举里的标签（例如 `社交互动` / `其他`）。 */
  const otherRows = new Map();
  const verdicts = { 对: 0, 半对: 0, 错: 0 };
  let annotated = 0;
  let tagRated = 0;
  let manualTagTotal = 0;
  let manualTagHit = 0;
  let modelTagTotal = 0;
  let modelTagExtra = 0;

  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object') continue;
    const manual = normalizeManualTags(item.manualTags);
    const verdict = normalizeVerdict(item.manualVerdict);
    const model = normalizeModelTags(
      Array.isArray(item.modelTags) ? item.modelTags : item.tags,
    );
    const marked = textOf(item.manualAt).trim() !== '';
    if (!marked && manual.length === 0 && verdict === '') continue;
    annotated += 1;
    if (verdict !== '') verdicts[verdict] += 1;
    if (manual.length === 0) continue;
    tagRated += 1;
    const manualSet = new Set(manual);
    const modelSet = new Set(model);
    for (const tag of manual) {
      manualTagTotal += 1;
      const row = rows.get(tag);
      if (row !== undefined) row.manual += 1;
      if (modelSet.has(tag)) {
        manualTagHit += 1;
        if (row !== undefined) row.hit += 1;
      }
    }
    for (const tag of model) {
      modelTagTotal += 1;
      const row = rows.get(tag);
      const hit = manualSet.has(tag);
      if (row !== undefined) {
        row.model += 1;
        if (!hit) row.extra += 1;
      } else {
        const other = otherRows.get(tag) ?? { tag, model: 0, extra: 0 };
        other.model += 1;
        if (!hit) other.extra += 1;
        otherRows.set(tag, other);
      }
      if (!hit) modelTagExtra += 1;
    }
  }

  const ratio = (part, total) => (total > 0 ? part / total : null);
  return {
    annotated,
    tagRated,
    manualTagTotal,
    manualTagHit,
    manualTagMiss: manualTagTotal - manualTagHit,
    modelTagTotal,
    modelTagExtra,
    modelTagCorrect: modelTagTotal - modelTagExtra,
    tagRecall: ratio(manualTagHit, manualTagTotal),
    tagExtraRate: ratio(modelTagExtra, modelTagTotal),
    tagPrecision: modelTagTotal > 0 ? ratio(modelTagTotal - modelTagExtra, modelTagTotal) : null,
    verdicts,
    verdictStrict: ratio(verdicts.对, annotated),
    verdictSoft: ratio(verdicts.对 + verdicts.半对 / 2, annotated),
    perTag: [...rows.values()].map((row) => ({
      ...row,
      recall: ratio(row.hit, row.manual),
      extraRate: ratio(row.extra, row.model),
    })),
    otherTags: [...otherRows.values()].sort((a, b) => b.model - a.model),
  };
}

/** 备份文件名里的时间戳：`20261106-194032-123`（Windows 不认冒号，这里一次换干净）。 */
export function backupStamp(date) {
  const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const iso = d.toISOString(); // 2026-11-06T11:40:32.123Z
  return iso.replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '');
}

/** 造一个"同目录、名字可读"的备份路径；同一毫秒重复时加序号。 */
function uniqueBackupPath(target, stamp, exists) {
  const base = `${target}.bak-${stamp}`;
  if (!exists(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** 从磁盘读到的 JSON 里取一个条目的标注字段（缺失 = 空）。 */
function annotationOf(entry) {
  return {
    modelTags: normalizeModelTags(entry?.modelTags),
    modelDesc: textOf(entry?.modelDesc),
    manualTags: normalizeManualTags(entry?.manualTags),
    manualDesc: textOf(entry?.manualDesc),
    manualVerdict: normalizeVerdict(entry?.manualVerdict),
    manualAt: textOf(entry?.manualAt),
  };
}

/**
 * 造一个标注器（读库 / 抽样 / 落库 / 对账 / 导出 / 读图）。
 *
 * @param {object} options
 * @param {string} options.indexPath `qq-stickers.json`
 * @param {string} options.dir 图片目录
 * @param {object} [options.fsImpl] 注入 fs（测试用）
 * @param {Function} [options.log]
 * @param {() => number} [options.now]
 * @param {(md5: string, patch: object) => void} [options.onSaved]
 *   写盘成功后回调（`src/index.mjs` 用它把标注字段同步回 `sticker-library` 的内存条目）
 * @returns {object}
 */
export function createStickerAnnotator({
  indexPath = '',
  dir = '',
  fsImpl = fs,
  log = () => {},
  now = () => Date.now(),
  onSaved = null,
} = {}) {
  const target = textOf(indexPath).trim();
  const imageDir = textOf(dir).trim();
  const stats = { batches: 0, saves: 0, saveFailed: 0, images: 0, imageMisses: 0 };

  /**
   * 读库并拆成条目数组。
   *
   * 坏条目**跳过这一条**并记一条 debug —— 整库坏掉才返回 `{ok:false}`，
   * 那时页面显示一行提示，不抛异常、不影响别的页。
   */
  function readLibrary() {
    if (target === '') {
      return { ok: false, error: '表情包库没有配置（stickerIndexPath 为空）' };
    }
    let raw = '';
    try {
      raw = fsImpl.readFileSync(target, 'utf8');
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : '';
      return {
        ok: false,
        error: code === 'ENOENT'
          ? `表情包库还不存在：${target}`
          : `读不到表情包库：${textOf(error?.message ?? error)}`,
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log('warn', '表情包库不是合法 JSON，标注页按空库处理', {
        path: target,
        error: textOf(error?.message ?? error),
      });
      return { ok: false, error: '表情包库不是合法 JSON（文件坏了，标注页不动它）' };
    }
    const table = parsed !== null && typeof parsed === 'object' ? parsed.entries : null;
    if (table === null || typeof table !== 'object' || Array.isArray(table)) {
      return { ok: false, error: '表情包库结构不对：缺少 entries' };
    }

    const entries = [];
    let skipped = 0;
    for (const [key, value] of Object.entries(table)) {
      const md5 = normalizeMd5(key);
      const file = textOf(value?.file).trim();
      if (md5 === '' || file === '' || value === null || typeof value !== 'object') {
        skipped += 1;
        continue;
      }
      const tags = normalizeModelTags(value.tags);
      const desc = textOf(value.desc);
      entries.push({
        md5,
        file,
        path: textOf(value.path),
        tags,
        desc,
        ...annotationOf(value),
        // 只有"模型标签冻结副本"存在时，人工对账才用得到原判；报告统一从这里取。
        annotated: textOf(value.manualAt).trim() !== '',
      });
    }
    if (skipped > 0) {
      log('debug', '表情包库里有坏条目，标注页跳过它们', { skipped, path: target, total: Object.keys(table).length });
    }
    return { ok: true, raw, parsed, entries, skipped };
  }

  /** 条目 → 页面用的批次项（补上图片地址与"已标注"标记）。 */
  function toItem(entry) {
    return {
      md5: entry.md5,
      file: entry.file,
      tags: [...entry.tags],
      desc: entry.desc,
      modelTags: [...entry.modelTags],
      modelDesc: entry.modelDesc,
      manualTags: [...entry.manualTags],
      manualDesc: entry.manualDesc,
      manualVerdict: entry.manualVerdict,
      manualAt: entry.manualAt,
      annotated: entry.annotated,
      imageUrl: `${STICKER_LABEL_ROUTE_BASE}/image?md5=${entry.md5}`,
    };
  }

  /** 条目数组里，文件确实还在盘上的那些（不在的跳过并计数，免得页面上一排碎图）。 */
  function withExistingFile(entries, skippedFiles) {
    const out = [];
    for (const entry of entries) {
      try {
        if (fsImpl.existsSync(path.join(imageDir, entry.file))) {
          out.push(entry);
        } else {
          skippedFiles.push(entry.md5);
        }
      } catch {
        skippedFiles.push(entry.md5);
      }
    }
    return out;
  }

  /**
   * 抽一批。
   *
   * @param {{size?: number, cursor?: number}} [options]
   */
  function batch({ size = DEFAULT_BATCH_SIZE, cursor = 0 } = {}) {
    // 没有图片目录时这一页什么都显示不了（一排碎图比一句提示糟得多）。
    if (imageDir === '') {
      return { ok: false, error: '图片目录没有配置（stickerDir 为空），标注页看不了图' };
    }
    const library = readLibrary();
    if (!library.ok) return library;
    const missing = [];
    // 抽样只看元信息，不碰图；但**文件不在盘上的条目**在页面上就是碎图，
    // 所以抽样阶段就剔掉（缺图的条目仍然留在报告/导出里）。
    const usable = withExistingFile(library.entries, missing);
    const sampled = sampleBatch(usable, { size, cursor });
    stats.batches += 1;
    if (missing.length > 0) {
      log('debug', '标注抽样跳过了图片已不在盘上的条目', { count: missing.length, sample: missing.slice(0, 3) });
    }
    return {
      ok: true,
      size: clampBatchSize(size),
      cursor: sampled.nextCursor - 1,
      nextCursor: sampled.nextCursor,
      poolSize: sampled.poolSize,
      freshOnly: sampled.freshOnly,
      total: library.entries.length,
      annotated: library.entries.filter((entry) => entry.annotated).length,
      missingFiles: missing.length,
      tagOptions: [...ANNOTATE_TAGS],
      verdictOptions: [...MANUAL_VERDICTS],
      items: sampled.items.map(toItem),
    };
  }

  /**
   * 保存一条人工标注。
   *
   * 顺序是**备份 → 写临时文件 → 校验临时文件 → rename**。任何一步失败：
   * 目标文件保持原样（rename 是原子的），临时文件删掉，尽力从备份恢复一次，
   * 返回值里带上 `backup` / `rollback`，页面能原话告诉用户。
   *
   * @param {{md5: unknown, manualTags?: unknown, manualDesc?: unknown, manualVerdict?: unknown}} input
   */
  function save(input) {
    const md5 = normalizeMd5(input?.md5);
    if (md5 === '') return { ok: false, error: 'md5 不合法（要 32 位十六进制）' };
    const library = readLibrary();
    if (!library.ok) return library;
    const entry = library.parsed.entries[md5];
    if (entry === null || typeof entry !== 'object') return { ok: false, error: '表情包库里没有这一条' };

    const manualTags = normalizeManualTags(input?.manualTags);
    const manualDesc = normalizeManualDesc(input?.manualDesc);
    const manualVerdict = normalizeVerdict(input?.manualVerdict);
    if (manualTags.length === 0 && manualDesc === '' && manualVerdict === '') {
      return { ok: false, error: '这一条什么都没写（标签 / 描述 / 三档至少要有一项）' };
    }

    const savedAt = new Date(now()).toISOString();
    // 首次标注时把模型原判冻结一份；**已经有了就不再覆盖**（第二次保存也不许改基准）。
    const frozenTags = normalizeModelTags(entry.modelTags);
    const hasFrozen = Array.isArray(entry.modelTags);
    const next = { ...entry };
    if (!hasFrozen) next.modelTags = normalizeModelTags(entry.tags);
    else next.modelTags = frozenTags;
    if (typeof entry.modelDesc !== 'string') next.modelDesc = textOf(entry.desc);
    next.manualTags = manualTags;
    next.manualDesc = manualDesc;
    next.manualVerdict = manualVerdict;
    next.manualAt = savedAt;

    const before = library.parsed;
    const after = {
      ...before,
      updatedAt: savedAt,
      entries: { ...before.entries, [md5]: next },
    };

    const exists = (candidate) => {
      try {
        return fsImpl.existsSync(candidate);
      } catch {
        return true; // 判不清就当它存在，换个名字，别覆盖
      }
    };
    const backup = uniqueBackupPath(target, backupStamp(new Date(now())), exists);
    try {
      fsImpl.copyFileSync(target, backup);
    } catch (error) {
      // 没有退路的写入比不写更糟 —— 备份失败就一个字节都不动。
      return { ok: false, error: `备份失败，未写入：${textOf(error?.message ?? error)}` };
    }

    const tmp = `${target}.tmp-${process.pid}-${now()}`;
    try {
      fsImpl.writeFileSync(tmp, JSON.stringify(after, null, 2), 'utf8');
      const check = JSON.parse(fsImpl.readFileSync(tmp, 'utf8'));
      if (check?.entries?.[md5]?.manualAt !== savedAt) {
        throw new Error('临时文件校验失败：读不回刚写的标注');
      }
      fsImpl.renameSync(tmp, target);
    } catch (error) {
      try {
        fsImpl.rmSync(tmp, { force: true });
      } catch {
        /* 临时文件删不掉不影响结论 */
      }
      let rollback = 'not-needed';
      try {
        // rename 是原子的：它抛了，目标通常一个字节都没变。所以先**核对**目标
        // 是否真的被改过 —— 没改就不用回滚（回滚标签说"恢复了"也是假话），
        // 改过了才从备份盖回去。
        const current = fsImpl.readFileSync(target, 'utf8');
        if (current !== library.raw) {
          fsImpl.copyFileSync(backup, target);
          rollback = 'restored';
        }
      } catch {
        rollback = 'failed';
        log('warn', '标注保存失败后回滚也失败（备份仍在，可手工恢复）', { path: target, backup });
      }
      stats.saveFailed += 1;
      log('warn', '表情包标注写库失败（原文件保持原样）', {
        path: target,
        backup,
        rollback,
        error: textOf(error?.message ?? error),
      });
      return {
        ok: false,
        error: `写库失败：${textOf(error?.message ?? error)}`,
        backup,
        rollback,
      };
    }

    stats.saves += 1;
    // 同步回 sticker-library 的内存条目：它下一次 persist() 会按内存形状覆盖整份文件，
    // 不同步的话 `manual*` 会被静默抹掉（seen 自增 / look_sticker 回写 desc 都会触发）。
    if (typeof onSaved === 'function') {
      try {
        onSaved(md5, {
          modelTags: next.modelTags,
          modelDesc: next.modelDesc,
          manualTags,
          manualDesc,
          manualVerdict,
          manualAt: savedAt,
        });
      } catch (error) {
        log('debug', '标注字段同步回表情包库内存失败（文件已经写好了）', {
          error: textOf(error?.message ?? error),
        });
      }
    }
    return {
      ok: true,
      md5,
      manualTags,
      manualDesc,
      manualVerdict,
      manualAt: savedAt,
      modelTags: next.modelTags,
      modelDesc: next.modelDesc,
      backup: path.basename(backup),
    };
  }

  /**
   * 读一张图（给 `<img>` 用）。
   *
   * md5 必须是 32 位十六进制，文件名取 `path.basename` —— 两道一起挡路径穿越。
   *
   * @param {unknown} rawMd5
   * @returns {{ok: true, bytes: Buffer, contentType: string, file: string}|{ok: false, error: string}}
   */
  function readImage(rawMd5) {
    const md5 = normalizeMd5(rawMd5);
    if (md5 === '') return { ok: false, error: 'md5 不合法' };
    const library = readLibrary();
    if (!library.ok) return { ok: false, error: library.error };
    const entry = library.entries.find((item) => item.md5 === md5);
    if (entry === undefined) return { ok: false, error: '库里没有这一条' };
    const safeName = path.basename(entry.file);
    if (safeName !== entry.file || imageDir === '') {
      return { ok: false, error: '条目里的文件名不安全或图片目录未配置' };
    }
    const full = path.join(imageDir, safeName);
    const ext = path.extname(safeName).replace('.', '').toLowerCase();
    const contentType = EXT_TYPES.get(ext) ?? 'application/octet-stream';
    try {
      const stat = fsImpl.statSync(full);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
        stats.imageMisses += 1;
        return { ok: false, error: '图片不在盘上或体积不合适' };
      }
      const bytes = fsImpl.readFileSync(full);
      stats.images += 1;
      return { ok: true, bytes, contentType, file: safeName };
    } catch {
      stats.imageMisses += 1;
      return { ok: false, error: '图片读不到' };
    }
  }

  /**
   * 报告：已标注条目的对账 + 逐张明细（页面用 `items` 做"这一批逐张对比"，
   * 导出则拿全量）。
   */
  function report() {
    const library = readLibrary();
    if (!library.ok) return library;
    const annotatedItems = library.entries
      .filter((entry) => entry.annotated)
      .map((entry) => ({
        md5: entry.md5,
        file: entry.file,
        tags: [...entry.tags],
        desc: entry.desc,
        modelTags: [...entry.modelTags],
        modelDesc: entry.modelDesc,
        manualTags: [...entry.manualTags],
        manualDesc: entry.manualDesc,
        manualVerdict: entry.manualVerdict,
        manualAt: entry.manualAt,
      }))
      .sort((left, right) => (left.manualAt < right.manualAt ? 1 : -1));
    return {
      ok: true,
      total: library.entries.length,
      annotated: annotatedItems.length,
      accuracy: computeAccuracy(annotatedItems),
      items: annotatedItems,
    };
  }

  /** 导出评估集：字段全量、口径固定，以后改页面也不影响这份文件的含义。 */
  function exportDataset() {
    const library = readLibrary();
    if (!library.ok) return library;
    const items = library.entries
      .filter((entry) => entry.annotated)
      .map((entry) => ({
        md5: entry.md5,
        file: entry.file,
        modelTags: [...entry.modelTags],
        modelDesc: entry.modelDesc,
        manualTags: [...entry.manualTags],
        manualDesc: entry.manualDesc,
        manualVerdict: entry.manualVerdict,
        manualAt: entry.manualAt,
        // 库里此刻的 `tags` / `desc` 也带上：模型重跑过的话，能看出"冻结基准 ≠ 现在"
        tags: [...entry.tags],
        desc: entry.desc,
      }))
      .sort((left, right) => (left.manualAt < right.manualAt ? -1 : 1));
    return {
      ok: true,
      payload: {
        schema: LABEL_DATASET_SCHEMA,
        exportedAt: new Date(now()).toISOString(),
        libraryPath: target,
        tagOptions: [...ANNOTATE_TAGS],
        verdictOptions: [...MANUAL_VERDICTS],
        total: library.entries.length,
        annotated: items.length,
        accuracy: computeAccuracy(items),
        items,
      },
    };
  }

  return { batch, save, report, exportDataset, readImage, stats: () => ({ ...stats }) };
}

// ---------------------------------------------------------------- HTTP 层

/** 与 `config-server` / `index.mjs` 同口径的 JSON 响应；连接断了就什么都不做。 */
function sendJson(res, status, body, headers = {}) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(body));
  } catch {
    /* 连接已经断了 */
  }
}

/** 送二进制（图片）。 */
function sendBytes(res, status, type, body, headers = {}) {
  try {
    res.writeHead(status, {
      'content-type': type,
      'content-length': body.length,
      ...headers,
    });
    res.end(body);
  } catch {
    /* 连接已经断了 */
  }
}

/** 读 JSON 请求体：空体 = `{}`，坏 JSON / 超长 / 出错 = `null`。 */
function readJsonBody(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      req.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > limitBytes) {
          try {
            req.destroy();
          } catch {
            /* 已断开 */
          }
          finish(null);
          return;
        }
        chunks.push(buf);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (text === '') {
          finish({});
          return;
        }
        try {
          const parsed = JSON.parse(text);
          finish(parsed !== null && typeof parsed === 'object' ? parsed : null);
        } catch {
          finish(null);
        }
      });
      req.on('error', () => finish(null));
      req.on('aborted', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 造「表情标注」的四条数据路由 + 一条图片路由（不注册，调用方负责 `webServer.register`）。
 *
 * | 路由 | 作用 |
 * |---|---|
 * | `GET  /dsh-qq-proactive/sticker-label/batch?size=12&cursor=0` | 抽一批 |
 * | `POST /dsh-qq-proactive/sticker-label/save` | 保存一条人工标注 |
 * | `GET  /dsh-qq-proactive/sticker-label/report` | 准确率汇总 + 已标注明细 |
 * | `GET  /dsh-qq-proactive/sticker-label/export` | 导出整份评估集 JSON |
 * | `GET  /dsh-qq-proactive/sticker-label/image?md5=<md5>` | 图片字节（页面 `<img>` 用） |
 *
 * **任何 handler 都不抛**：内部异常降级成 `{ok:false, error}`（200）+ 一条 warn，
 * 否则配置页整页会被 500 打断。
 *
 * @param {object} options
 * @param {object} options.annotator {@link createStickerAnnotator} 的返回值
 * @param {Function} [options.log]
 */
export function createStickerLabelRoutes({ annotator = null, log = () => {} } = {}) {
  const requireAnnotator = () => {
    if (annotator === null || annotator === undefined) throw new Error('标注器未注入');
    return annotator;
  };

  const handleBatch = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '只接受 GET' });
        return;
      }
      const url = new URL(textOf(req.url) || '/', 'http://127.0.0.1');
      const size = clampBatchSize(url.searchParams.get('size'));
      const rawCursor = Number(url.searchParams.get('cursor'));
      const cursor = Number.isFinite(rawCursor) && rawCursor >= 0 ? Math.floor(rawCursor) : 0;
      const payload = requireAnnotator().batch({ size, cursor });
      sendJson(res, 200, payload);
    } catch (error) {
      log('warn', '读取标注批次失败', { error: errorText(error) });
      sendJson(res, 200, { ok: false, error: `读取标注批次失败：${errorText(error)}` });
    }
  };

  const handleSave = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只接受 POST' });
        return;
      }
      const body = await readJsonBody(req);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON（或超过 64 KiB）' });
        return;
      }
      const result = requireAnnotator().save(body);
      sendJson(res, result.ok === true ? 200 : 400, result);
    } catch (error) {
      log('warn', '保存表情包标注失败', { error: errorText(error) });
      sendJson(res, 200, { ok: false, error: `保存标注失败：${errorText(error)}` });
    }
  };

  const handleReport = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '只接受 GET' });
        return;
      }
      sendJson(res, 200, requireAnnotator().report());
    } catch (error) {
      log('warn', '读取标注报告失败', { error: errorText(error) });
      sendJson(res, 200, { ok: false, error: `读取标注报告失败：${errorText(error)}` });
    }
  };

  const handleExport = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '只接受 GET' });
        return;
      }
      const result = requireAnnotator().exportDataset();
      if (result.ok !== true) {
        sendJson(res, 200, result);
        return;
      }
      const stamp = backupStamp(new Date());
      sendJson(res, 200, result.payload, {
        'content-disposition': `attachment; filename="sticker-labels-${stamp}.json"`,
      });
    } catch (error) {
      log('warn', '导出标注集失败', { error: errorText(error) });
      sendJson(res, 200, { ok: false, error: `导出标注集失败：${errorText(error)}` });
    }
  };

  const handleImage = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '只接受 GET' });
        return;
      }
      const url = new URL(textOf(req.url) || '/', 'http://127.0.0.1');
      const got = requireAnnotator().readImage(url.searchParams.get('md5'));
      if (got.ok !== true) {
        sendJson(res, 404, { ok: false, error: got.error });
        return;
      }
      sendBytes(res, 200, got.contentType, got.bytes, {
        // 内容按 md5 寻址 ⇒ 不会变；给一天缓存，翻回上一批时不用重下。
        'cache-control': 'private, max-age=86400',
      });
    } catch (error) {
      log('warn', '读表情包图片失败', { error: errorText(error) });
      sendJson(res, 200, { ok: false, error: `读图片失败：${errorText(error)}` });
    }
  };

  return [
    { kind: 'exact', path: `${STICKER_LABEL_ROUTE_BASE}/batch`, handler: handleBatch },
    { kind: 'exact', path: `${STICKER_LABEL_ROUTE_BASE}/save`, handler: handleSave },
    { kind: 'exact', path: `${STICKER_LABEL_ROUTE_BASE}/report`, handler: handleReport },
    { kind: 'exact', path: `${STICKER_LABEL_ROUTE_BASE}/export`, handler: handleExport },
    { kind: 'exact', path: `${STICKER_LABEL_ROUTE_BASE}/image`, handler: handleImage },
  ];
}
