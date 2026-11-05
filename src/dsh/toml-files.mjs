/**
 * 旁路模型的**分文件配置**（2026-10-30）。
 *
 * ## 为什么会有这个模块
 *
 * 用户原话：「除开说话的主模型，别的模型的设置，比如负责心情的、负责决定开口的、
 * 负责识图的、审核表情包的，诸如此类的，我觉得**文件最好分开**，这样方便备份与回滚」。
 *
 * 主对话的设置留在 `qq-gugu.toml`；每条旁路一个文件：
 *
 * ```
 * qq-gugu.toml          主对话 + 通道 + 决定开口 + 唤醒 + agent/memory
 * qq-gugu.mood.toml     心情
 * qq-gugu.vision.toml   识图（显存门控 + 云/本地 + 图片描述）
 * qq-gugu.sticker.toml  表情包审核 + 留样
 * qq-gugu.voice.toml    入站语音：转写 + 情绪（同一条链，见下）
 * qq-gugu.tts.toml      出站语音
 * ```
 *
 * ## 三条硬规则（每一条都是为了不"静默失效"）
 *
 * 1. **段名不改**。分文件之后仍然叫 `[mood]` / `[sticker_gate]` / `[voice]` …
 *    —— 解析器、字段表、写盘工具全都按段名走，改名等于把整套重写一遍。
 * 2. **文件不存在 ⇒ 回落主文件**。老部署一个字节都不用改就能继续跑；
 *    也让"文件放好了但没人读"这种事故**不可能**发生（读的永远是同一套解析器）。
 * 3. **读和写用同一个解析结果**。`resolveModelToml()` 是唯一入口 ——
 *    配置页写盘、加载器读值、备份取名都从它拿路径。**别在别处拼文件名**。
 *
 * ## 情绪为什么在 voice 那个文件里
 *
 * 用户 2026-10-30 拍板合并：「语音转写和情绪旁路是合作关系吧？识别语音，判断情绪，
 * 应该是每次有语音进来都会做的事」。代码里它们确实是同一条链：
 * `gateway.mjs` 的 `#transcribeVoice` 在转写成功之后才 `#senseEmotion`（同一个 record 段），
 * 而且 `[voice] enabled=false` 时情绪也一起停。分开放反而会让人以为它们独立。
 *
 * @module qq-dsh/toml-files
 */

import fs from 'node:fs';
import path from 'node:path';

/** 允许出现在文件名里的旁路键（`main` = 主文件本身）。顺序 = 配置页标签顺序。 */
export const MODEL_FILE_KEYS = Object.freeze(['main', 'mood', 'vision', 'sticker', 'voice', 'tts']);

/** 键 → 文件名里那一段（`qq-gugu.<suffix>.toml`）。`main` 不在表里。 */
const FILE_SUFFIX = Object.freeze({
  mood: 'mood',
  vision: 'vision',
  sticker: 'sticker',
  voice: 'voice',
  tts: 'tts',
});

/** 键是否合法（写盘点、读接口都会先过这一关）。 */
export function isModelFileKey(key) {
  return MODEL_FILE_KEYS.includes(String(key ?? '').trim());
}

/**
 * 分文件的路径（**不检查存在性**）：`…\qq-gugu.toml` + `mood` ⇒ `…\qq-gugu.mood.toml`。
 *
 * 保留原目录、原基名，只在中缀上加一段；`main` / 未知键 ⇒ 原样返回主路径。
 *
 * @param {unknown} mainPath
 * @param {unknown} key
 * @returns {string}
 */
export function splitTomlPath(mainPath, key) {
  const main = String(mainPath ?? '').trim();
  const id = String(key ?? '').trim();
  if (main === '' || id === 'main' || id === '') return main;
  const suffix = FILE_SUFFIX[id];
  if (suffix === undefined) return main;
  const dir = path.dirname(main);
  const base = path.basename(main).replace(/\.toml$/i, '');
  return path.join(dir, `${base}.${suffix}.toml`);
}

/** 文件是否存在（**只认普通文件**，目录/权限问题一律当"没有"）。 */
function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析某个旁路**这一轮该读/写哪个文件**。
 *
 * - 分文件存在 ⇒ 用它（`split: true`）；
 * - 不存在 ⇒ **回落主文件**（`split: false`，`path === mainPath`）。
 *
 * ⚠️ 这个函数**不做缓存**：配置页每轮都现读磁盘（改完能立刻看到），
 * 而加载器只在重载时调一次。缓存会让"文件刚建好但进程还在看旧路径"这种
 * 事故变得可能 —— 那正是本模块存在的理由。
 *
 * @param {unknown} mainPath
 * @param {unknown} key
 * @returns {{key: string, mainPath: string, splitPath: string, path: string, split: boolean, splitExists: boolean, exists: boolean}}
 */
export function resolveModelToml(mainPath, key) {
  const main = String(mainPath ?? '').trim();
  const id = isModelFileKey(key) ? String(key) : 'main';
  const candidate = splitTomlPath(main, id);
  const isSplit = candidate !== main;
  const splitExists = isSplit && fileExists(candidate);
  const chosen = splitExists ? candidate : main;
  return {
    key: id,
    mainPath: main,
    splitPath: candidate,
    path: chosen,
    // `split` = **这次真的用了分文件**；`splitExists` = 那个文件在不在。
    // 两者分开是给配置页用的：还没拆分时要显示"尚未拆分（当前读写主文件）"，
    // 而不是含糊的"不存在"（那会让人以为配置丢了）。
    split: splitExists,
    splitExists,
    exists: fileExists(chosen),
  };
}

/**
 * 所有旁路文件的现状（配置页 / 日志用）。
 *
 * @param {unknown} mainPath
 * @returns {Array<{key: string, path: string, splitPath: string, split: boolean, splitExists: boolean, exists: boolean}>}
 */
export function describeModelFiles(mainPath) {
  return MODEL_FILE_KEYS.map((key) => {
    const resolved = resolveModelToml(mainPath, key);
    return {
      key,
      path: resolved.path,
      splitPath: resolved.splitPath,
      split: resolved.split,
      splitExists: resolved.splitExists,
      exists: resolved.exists,
    };
  });
}

/**
 * `[voice]` 与 `[emotion]` 共享一个文件 —— 判断某个段名属于哪个文件。
 *
 * 这张表**不在别处复制**：加载器 / 字段表 / 测试都从这里取。
 *
 * @param {unknown} sectionPath 第一段或完整段路径（两种都接受）
 * @returns {'main'|'mood'|'vision'|'sticker'|'voice'|'tts'}
 */
export function fileKeyForSection(sectionPath) {
  const head = Array.isArray(sectionPath) ? sectionPath[0] : sectionPath;
  const name = String(head ?? '').trim();
  if (name === 'mood') return 'mood';
  if (name === 'vision_gate') return 'vision';
  if (name === 'sticker_gate' || name === 'sticker_audit') return 'sticker';
  if (name === 'voice' || name === 'emotion') return 'voice';
  if (name === 'tts') return 'tts';
  return 'main';
}
