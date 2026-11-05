/**
 * **审核留样**（sticker audit）：把**每一张被审核过的图**（含被拒的）存一份，
 * 让用户可以自己当数据标注员校准阈值。
 *
 * ## 用户原话（2026-10-09 06:05）
 *
 * > 「这样吧，**所有的图暂时性的都保存到另一个文件夹下**，然后**看哪些被拒了就知道了**；
 * > **我来客串一回数据标注员**」
 *
 * ## 为什么必须单独一个目录（而不是往 `media\stickers\` 里塞）
 *
 * | 目录 | 语义 | 谁在用 |
 * |---|---|---|
 * | `media\stickers\` + `qq-stickers.json` | **入库的**（过了审核闸、以后要发出去的） | 小鲸鱼发图 |
 * | `<auditDir>`（本模块） | **所有见过的**（含被拒的、没看成的） | 只有人看 |
 *
 * 两者混在一起会同时坏掉两件事：库里会混进**故意不该发**的图；而"审核拒了哪些"
 * 再也数不清（因为库里的都是收下的）。所以**不合并**。
 *
 * ## 为什么调用点选在 `image-desc.mjs` 的「认」之后
 *
 * 因为**拒掉的图没有任何别的落盘机会** —— `sticker-library.mjs` 的 `recognize`
 * 一返回 `accept:false` 就 `return 'rejected'`，字节就地丢掉。留样必须挂在
 * "已经算出判定、但还没决定收不收"的那一刻，也就是 `describeSticker` 里
 * `sanitizeStickerVerdict` 之后。顺带三个好处：
 *
 * 1. **收下的图也留样**（同一张 `md5` 两个目录都有副本 —— 用户要的对照）；
 * 2. **`ok:false`（没看成/超时）也能留**（那类"看不见"的失败同样要能标）；
 * 3. 留样拿到的是**模型当时真看的那些字节**（多帧 GIF 是拼好的那张联络图），
 *    不是"原始文件"—— 这样"它看的是哪一帧"永远可复核。
 *
 * ## 四条硬约束
 *
 * 1. **绝不抛异常、绝不拖慢主流程**：这条路在"偷表情包"的 fire-and-forget 链上，
 *    写盘失败只记日志（连续失败会**自动断开**，见 `failStreak`）。
 * 2. **有上限、会淘汰**：用户说"暂时性"，所以默认只留 **最近 200 张 / 256 MB**，
 *    超出按"最旧的先走"淘汰（阈值在 `qq-gugu.toml` 的 `[sticker_audit]` 里可配）。
 * 3. **`.json` 是覆盖写、`index.jsonl` 是追加写**：同一张图第二次被审核时，
 *    结果文件更新成最新那次（分数会变，而用户要按最新那次校准）；
 *    索引留成逐行的历史（便于"一眼扫"）。
 * 4. **写文件一律走临时文件 + rename**：半截的 JSON 比没有 JSON 更坏
 *    （用户会以为"这张图当时就是这么判的"）。
 *
 * @module qq-gugu/sticker-audit
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from './paths.mjs';

/** 兜底默认值（真源是 `qq-gugu.toml` 的 `[sticker_audit]`）。 */
export const DEFAULT_STICKER_AUDIT = Object.freeze({
  /** 本地文件系统路径（Linux 部署时换成 POSIX 路径）。 */
  dir: path.join(dshHome(), 'media', 'sticker-audit'),
  enabled: true,
  /** 最多留多少张图（`.json` 侧车不算，它们跟着图一起淘汰）。 */
  maxFiles: 200,
  /** 全部留样加起来最多多少字节（默认 256 MB）。 */
  maxBytes: 256 * 1024 * 1024,
  /** 要不要写 `index.jsonl`（一眼扫用的）。 */
  index: true,
  /** `index.jsonl` 最多保留多少行（超出只留尾部 —— 它不该无声长大）。 */
  maxIndexLines: 2000,
});

/** 媒体类型 → 扩展名。认不出来用 `.bin`（**不猜**：扩展名错了会让预览器打不开）。 */
const EXT_BY_MEDIA = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
});

/**
 * 把 toml / 配置给的参数收拾成能用的形状（越界一律夹到边界，不抛）。
 *
 * @param {unknown} raw
 * @returns {{dir: string, enabled: boolean, maxFiles: number, maxBytes: number, index: boolean, maxIndexLines: number}}
 */
export function normalizeStickerAudit(raw = {}) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const intIn = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  return {
    // ⚠️ 空串 = **明确关掉**（和 `stickerDir` / `imageDescCachePath` 同一条规矩：
    //    "没配" 与 "配成空" 要能分开 —— 空串是关，缺字段才是走默认）。
    dir: src.dir === undefined ? DEFAULT_STICKER_AUDIT.dir : text(src.dir),
    enabled: bool(src.enabled, DEFAULT_STICKER_AUDIT.enabled),
    // 上限 20000 张 / 8 GB：再大就不是"临时留样"了，那是长期归档（该另想办法）。
    maxFiles: intIn(src.maxFiles, DEFAULT_STICKER_AUDIT.maxFiles, 0, 20_000),
    maxBytes: intIn(src.maxBytes, DEFAULT_STICKER_AUDIT.maxBytes, 0, 8 * 1024 * 1024 * 1024),
    index: bool(src.index, DEFAULT_STICKER_AUDIT.index),
    maxIndexLines: intIn(src.maxIndexLines, DEFAULT_STICKER_AUDIT.maxIndexLines, 0, 1_000_000),
  };
}

/** 内容 md5（**和表情包库同一套身份**：这样两边能对着看同一张图）。 */
export function auditHashOf(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * 造一个留样器。
 *
 * @param {object} [options]
 * @param {object} [options.config] `normalizeStickerAudit` 收拾过的参数（或原始 toml 段）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {object} [options.fsImpl] 注入 fs（测试用）
 * @param {() => number} [options.now] 时钟（测试用）
 * @returns {{save: (input: object) => Promise<object|null>, stats: () => object, dir: () => string, enabled: () => boolean, prune: () => Promise<object>}}
 */
export function createStickerAudit({
  config = null,
  log = () => {},
  fsImpl = null,
  now = () => Date.now(),
} = {}) {
  const cfg = normalizeStickerAudit(config ?? DEFAULT_STICKER_AUDIT);
  const f = fsImpl ?? fs;
  // 连续写失败几次就断开（这条链是 fire-and-forget，不能因为一个坏目录
  // 每次都去撞一次 EPERM 再吞掉 —— 那会变成每条消息一次无意义的系统调用）。
  const FAILS_BEFORE_DISABLE = 5;

  const stats = {
    enabled: cfg.enabled && cfg.dir !== '',
    wrote: 0, updated: 0, failed: 0, evicted: 0, evictedBytes: 0,
    fileSkips: 0, prunes: 0, indexLines: 0, disabled: false,
    last: null,
  };
  let failStreak = 0;

  const dirOf = () => cfg.dir;
  /** 侧车 JSON 的路径（`.json` 去掉最后的 `.json` 就是图 + 扩展名的基名 `md5`）。 */
  const jsonPathOf = (hash) => path.join(cfg.dir, `${hash}.json`);
  const imgPathOf = (hash, ext) => path.join(cfg.dir, `${hash}${ext}`);

  /**
   * 原子写：先写 `<name>.tmp-<pid>-<rnd>` 再 rename。
   * 半截文件比没有文件更坏（用户会当成"当时就是这么判的"）。
   */
  function writeAtomic(filePath, data) {
    const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    f.writeFileSync(tmp, data);
    f.renameSync(tmp, filePath);
  }

  /** 追加一行到 `index.jsonl`（失败不影响主流程）。 */
  function appendIndex(line) {
    if (!cfg.index || cfg.maxIndexLines === 0) return;
    try {
      const p = path.join(cfg.dir, 'index.jsonl');
      f.appendFileSync(p, `${JSON.stringify(line)}\n`, 'utf8');
      stats.indexLines += 1;
    } catch (error) {
      log('debug', '留样索引追加失败（不影响审核结果）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 索引行数超上限时只留尾部（它不该无声长大）。 */
  function trimIndexIfNeeded() {
    if (!cfg.index || cfg.maxIndexLines <= 0) return;
    try {
      const p = path.join(cfg.dir, 'index.jsonl');
      const text = f.readFileSync(p, 'utf8');
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      // 留 1.5 倍余量再裁：每裁一次都读整份，太频繁不值当。
      const keep = Math.ceil(cfg.maxIndexLines * 1.5);
      if (lines.length <= keep) return;
      const tail = lines.slice(lines.length - cfg.maxIndexLines);
      writeAtomic(p, `${tail.join('\n')}\n`);
      log('info', '留样索引超上限，已只保留尾部', { had: lines.length, kept: tail.length, maxIndexLines: cfg.maxIndexLines });
    } catch (error) {
      log('debug', '留样索引裁剪失败（不影响审核结果）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * **淘汰**：按"最旧的先走"把总量压回上限内。
   *
   * 判据用**文件 mtime**（不是内存里记的顺序）—— 那样重启之后照样对，
   * 而且人工往目录里塞/删过文件也不会算错。**只动本目录里的 `.json` / 图片**，
   * 不认识的扩展名不去碰（万一有人往这儿放了别的东西）。
   */
  async function prune() {
    if (!stats.enabled) return { evicted: 0 };
    let evicted = 0;
    let evictedBytes = 0;
    try {
      const names = f.readdirSync(cfg.dir).filter((n) => !n.startsWith('.') && !n.includes('.tmp-'));
      const imgs = [];
      for (const n of names) {
        const ext = path.extname(n).toLowerCase();
        if (!Object.values(EXT_BY_MEDIA).includes(ext)) continue;
        try {
          const st = f.statSync(path.join(cfg.dir, n));
          imgs.push({ n, mtimeMs: st.mtimeMs ?? 0, bytes: st.size ?? 0 });
        } catch { /* 读不到就当没有 */ }
      }
      imgs.sort((a, b) => a.mtimeMs - b.mtimeMs); // 最旧的在前

      let totalBytes = imgs.reduce((s, x) => s + x.bytes, 0);
      let count = imgs.length;
      for (const img of imgs) {
        if (count <= cfg.maxFiles && totalBytes <= cfg.maxBytes) break;
        const base = img.n.slice(0, img.n.length - path.extname(img.n).length);
        try {
          f.rmSync(path.join(cfg.dir, img.n), { force: true });
          // 侧车跟着走：留着孤立的 .json 会让标注员点进去发现图没了。
          try { f.rmSync(jsonPathOf(base), { force: true }); } catch { /* 没有就算了 */ }
          count -= 1;
          totalBytes -= img.bytes;
          evicted += 1;
          evictedBytes += img.bytes;
        } catch { /* 删不掉就留着，下次再说 */ }
      }
      stats.evicted += evicted;
      stats.evictedBytes += evictedBytes;
      stats.prunes += 1;
      if (evicted > 0) {
        log('info', '留样超出上限，淘汰了最旧的几张', {
          evicted, evictedBytes, maxFiles: cfg.maxFiles, maxBytes: cfg.maxBytes, left: count,
        });
      }
      trimIndexIfNeeded();
    } catch (error) {
      log('debug', '留样淘汰失败（不影响审核结果）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { evicted, evictedBytes };
  }

  /**
   * **存一份**（含被拒的、没看成的）。**绝不抛异常，绝不改变 verdict。**
   *
   * @param {object} input
   * @param {Uint8Array} input.data **模型当时真看的那些字节**（多帧 GIF 是拼好的那张）
   * @param {string} input.mediaType
   * @param {string} [input.name] 原始文件名
   * @param {{chatId?: string, userId?: string, subType?: unknown}} [input.source]
   * @param {object} input.verdict `sanitizeStickerVerdict` 的结果（可能是 `ok:false` 那份）
   * @param {object} [input.thresholds] **当时生效的**四个阈值 + 配文上限
   * @param {(w: object, i: object) => Promise<object>} [input.next] 串下一个消费者（可选）
   * @returns {Promise<object|null>} 写成功返回落盘信息，否则 null
   */
  async function save(input) {
    if (!stats.enabled || stats.disabled) return null;
    try {
      const data = input?.data;
      if (!(data instanceof Uint8Array) || data.length === 0) return null;
      const hash = auditHashOf(data);
      const ext = EXT_BY_MEDIA[String(input?.mediaType ?? '')] ?? '.bin';
      const imgPath = imgPathOf(hash, ext);
      const verdict = input?.verdict ?? null;

      f.mkdirSync(cfg.dir, { recursive: true });

      // ⚠️ 图**已存在就不重写**（同一张图第二次被审核时，只有 `.json` 需要更新）。
      //    `fileSkips` 就是"这一条省掉了"的证据。
      if (f.existsSync(imgPath)) {
        stats.fileSkips += 1;
      } else {
        writeAtomic(imgPath, data);
      }

      const record = {
        md5: hash,
        at: new Date(now()).toISOString(),
        source: {
          chatId: String(input?.source?.chatId ?? ''),
          userId: String(input?.source?.userId ?? ''),
          subType: input?.source?.subType ?? null,
        },
        // 判定：`ok:false` 时 accept/reject 都是 null（"没看成"和"判它不合格"必须分得开）
        ok: verdict?.ok === true,
        accept: verdict?.accept === true,
        reject: verdict?.reject ?? null,
        rejects: Array.isArray(verdict?.rejects) ? verdict.rejects : [],
        scores: verdict?.scores ?? null,
        // ⚠️ **当时生效的阈值**必须一起记：阈值会调，事后光看分数不知道是按哪套拒的。
        thresholds: input?.thresholds ?? null,
        // ⭐ 2026-10-09：**这张图本身是不是表情包** —— 标注员要能一眼看出
        //    "它是被判成非表情包才拒的"（`reject: 'not-sticker'`）。
        //    `ok:false`（没看成）时这里是 false，与 portrait/screenshot 同一条口径：
        //    "没看成"和"判它不是"靠 `ok` 与 `reject:null` 区分。
        isSticker: verdict?.isSticker === true,
        portrait: verdict?.portrait === true,
        screenshot: verdict?.screenshot === true,
        // ⭐ 2026-10-09 判据重写新加的两个"命中即拒"的红线：
        //    `political`（涉政，全禁）/ `pureText`（纯文字图）。
        //    标注员要能分辨"这张是因为涉政被拒"还是"因为纯文字被拒" —— 两种的处置完全不同。
        political: verdict?.political === true,
        pureText: verdict?.pureText === true,
        // ⭐ 感知哈希（dHash，16 个十六进制字符）；**算不出来就是空串**
        //    （插件零依赖，只有 GIF 有解码器 —— 见 `image-desc.mjs` 的 `perceptualHashHex`）。
        //    记它的用途：将来"近似图去重"要拿它比，而且**事后能核对**这一条对应的是哪张图。
        phash: String(verdict?.phash ?? ''),
        caption: String(verdict?.caption ?? ''),
        captionChars: Number.isFinite(verdict?.captionChars) ? verdict.captionChars : null,
        desc: String(verdict?.desc ?? ''),
        tags: Array.isArray(verdict?.tags) ? verdict.tags : [],
        unmatched: String(verdict?.unmatched ?? ''),
        // 留样的字节信息：**哪一份**被看了（多帧 GIF 拼图 vs 原图）也在这里
        image: {
          file: path.basename(imgPath),
          bytes: data.length,
          mediaType: String(input?.mediaType ?? ''),
          originalName: String(input?.name ?? ''),
          frames: Number.isFinite(input?.frames) ? input.frames : 0,
        },
        // 附注（护栏丢掉某字段之类的），给标注员看"这条为什么不全"
        notes: Array.isArray(input?.notes) ? input.notes : [],
      };
      const existed = f.existsSync(jsonPathOf(hash));
      writeAtomic(jsonPathOf(hash), `${JSON.stringify(record, null, 2)}\n`);
      if (existed) stats.updated += 1; else stats.wrote += 1;

      appendIndex({
        at: record.at, md5: hash, ok: record.ok, accept: record.accept, reject: record.reject,
        rejects: record.rejects, scores: record.scores, thresholds: record.thresholds,
        captionChars: record.captionChars, desc: record.desc, file: record.image.file,
        bytes: record.image.bytes, chatId: record.source.chatId,
        // 2026-10-09：索引里也带上这两个红线 + 感知哈希 —— 用 `jq`/一行 grep 就能筛出
        // "哪些图是因为涉政/纯文字被拒的"、"哪些图哈希相同"，不用逐个打开侧车 json。
        political: record.political, pureText: record.pureText, phash: record.phash,
      });

      stats.last = { at: record.at, md5: hash, accept: record.accept, reject: record.reject, scores: record.scores };
      failStreak = 0;
      return { md5: hash, file: record.image.file, json: path.basename(jsonPathOf(hash)) };
    } catch (error) {
      stats.failed += 1;
      failStreak += 1;
      log('warn', '留样写盘失败（审核结果不受影响）', {
        dir: cfg.dir,
        error: error instanceof Error ? error.message : String(error),
        failStreak,
      });
      if (failStreak >= FAILS_BEFORE_DISABLE) {
        stats.disabled = true;
        log('warn', '留样连续写盘失败，**本次进程内已断开**（免得每条消息都撞一次）', {
          dir: cfg.dir, failStreak,
        });
      }
      return null;
    }
  }

  return {
    save,
    stats: () => ({ ...stats, dir: cfg.dir, maxFiles: cfg.maxFiles, maxBytes: cfg.maxBytes, index: cfg.index, maxIndexLines: cfg.maxIndexLines, failStreak }),
    dir: dirOf,
    enabled: () => stats.enabled && !stats.disabled,
    prune,
  };
}
