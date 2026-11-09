/**
 * 插件文件路径的统一解析（2026-11-05）。
 *
 * 背景：此前插件的状态文件分散在三处 —— `workspace/shared`（跨会话协作区）、
 * `<DSH_HOME>/media`（宿主媒体目录）与 profile 目录。`workspace/shared` 的定位是
 * 跨会话协作文件，不应承载插件运行态；`<DSH_HOME>/media` 与宿主其它产物混放，
 * 备份与迁移时边界不清。
 *
 * 本模块把插件自己的数据收进 `<DSH_HOME>/qq-gugu`：
 *
 * ```
 * <home>/
 *   state/   运行态（关系、回想、转录、话题、学习到的记忆）
 *   media/   快照与台账（后续迁入）
 *   config/  配置（后续迁入）
 * ```
 *
 * 迁移策略：**只复制、不删除**。新路径不存在且旧路径存在时，复制一份并写日志；
 * 旧文件保留，观察一段时间后再由人工清理。环境变量覆盖仍然优先（测试与排障依赖它）。
 *
 * 尚未迁入的部分（有意保留原位）：
 * - 配置（`profiles/<profile>/qq-gugu*.toml`）：由 profile 引用，移动需同步改 profile；
 * - 调试快照与出站台账（`<DSH_HOME>/media`）：路径已写在多个会话的文档里，
 *   迁移会造成跨会话文档漂移，待协调后再动。
 */

import fsSync from 'node:fs';
import path from 'node:path';

/** 解析 DSH home：`DSH_HOME` 优先，否则回退到 `~/.dsh`。 */
export function dshHome(env = process.env) {
  const home = String(env.DSH_HOME ?? '').trim();
  if (home !== '') return home;
  return path.join(env.USERPROFILE ?? env.HOME ?? '.', '.dsh');
}

/** 插件数据根目录：`QQ_GUGU_HOME` 优先。 */
export function qqGuguHome(env = process.env) {
  const override = String(env.QQ_GUGU_HOME ?? '').trim();
  if (override !== '') return override;
  return path.join(dshHome(env), 'qq-gugu');
}

export function stateDir(env = process.env) {
  return path.join(qqGuguHome(env), 'state');
}

export function mediaDir(env = process.env) {
  return path.join(qqGuguHome(env), 'media');
}

export function configDir(env = process.env) {
  return path.join(qqGuguHome(env), 'config');
}

/** 状态文件的完整路径。 */
export function statePath(name, env = process.env) {
  return path.join(stateDir(env), name);
}

/**
 * 宿主媒体目录：`<DSH_HOME>/media`。
 *
 * ⚠️ **和上面的 `mediaDir()` 不是一个目录**，别合并：
 *   · `mediaDir()` = `<DSH_HOME>/qq-gugu/media`（插件归拢出来的新家，空的）；
 *   · 这个是 `<DSH_HOME>/media` —— **既有文件都在这里**：`qq-outbound.jsonl`、
 *     `qq-proactive-debug.json`、`qq-stickers.json`、`sticker-audit\`。
 *     它们的路径写在多个会话的文档里（见文件头「尚未迁入的部分」），
 *     所以新文件要用这个位置时**走这里、别自己拼字符串**（拼出来的迟早和
 *     `outbound-ledger.mjs` 那份默认路径分叉，而分叉的表现是"什么都没记"）。
 */
export function dshMediaDir(env = process.env) {
  return path.join(dshHome(env), 'media');
}

/**
 * 媒体文件的完整路径 + 环境变量覆盖（与 {@link resolveStatePath} 同一条约定）。
 *
 * 环境变量优先（排障时用户自己指定一个临时文件），否则 `<DSH_HOME>/media/<name>`。
 * **不做迁移** —— 这里放的都是新文件，没有旧位置可迁。
 *
 * @param {object} options
 * @param {string} options.name 文件名
 * @param {string} [options.envVar] 覆盖用环境变量名
 * @param {object} [options.env]
 * @returns {string}
 */
export function resolveMediaPath({ name, envVar = '', env = process.env } = {}) {
  const override = envVar === '' ? '' : String(env[envVar] ?? '').trim();
  if (override !== '') return override;
  return path.join(dshMediaDir(env), name);
}

/**
 * 迁移辅助：新路径不存在且旧路径存在时，复制一份。
 *
 * @param {object} options
 * @param {string} options.next 新路径
 * @param {string[]} [options.candidates] 旧路径候选（按顺序取第一个存在的）
 * @param {object} [options.fs]
 * @param {(level: string, msg: string, meta?: object) => void} [options.log]
 * @returns {{path: string, migratedFrom: string|null}}
 */
export function migrateIfNeeded({ next, candidates = [], fs = fsSync, log = () => {} } = {}) {
  try {
    if (typeof next !== 'string' || next === '') return { path: next, migratedFrom: null };
    if (fs.existsSync(next)) return { path: next, migratedFrom: null };
    for (const candidate of candidates) {
      const from = String(candidate ?? '').trim();
      if (from === '' || from === next) continue;
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(next), { recursive: true });
      fs.copyFileSync(from, next);
      log('info', `路径归拢：已从旧位置复制 ${path.basename(next)}`, { from, to: next });
      return { path: next, migratedFrom: from };
    }
  } catch (error) {
    log('warn', '路径归拢：迁移失败（继续用新路径）', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { path: next, migratedFrom: null };
}

/**
 * 解析状态文件路径并按需迁移。环境变量覆盖优先，且不做迁移（排障时用户自己指定）。
 *
 * @param {object} options
 * @param {string} options.name 文件名
 * @param {string} [options.envVar] 覆盖用环境变量名
 * @param {string[]} [options.legacy] 旧路径候选
 * @param {object} [options.env]
 * @param {object} [options.fs]
 * @param {(level: string, msg: string, meta?: object) => void} [options.log]
 * @returns {string}
 */
export function resolveStatePath({ name, envVar = '', legacy = [], env = process.env, fs = fsSync, log = () => {} } = {}) {
  const override = envVar === '' ? '' : String(env[envVar] ?? '').trim();
  if (override !== '') return override;
  const next = statePath(name, env);
  return migrateIfNeeded({ next, candidates: legacy, fs, log }).path;
}
