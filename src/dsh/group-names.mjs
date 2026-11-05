/**
 * **QQ 群号 → 群名** 缓存（2026-10-21）。
 *
 * ## 为什么需要它
 *
 * 配置页要显示"这个群叫什么"（例如「示例群」）。宿主原来**没有任何来源**：
 *
 * - 入站事件里带的是 `group_id`，不带群名；
 * - `qq-nicknames.json` 只存**人名**（`(群, QQ) → 群名片` + `QQ → 昵称`）；
 * - `get_group_list` 只在诊断时调过一次，而且不落盘。
 *
 * 所以这里单独攒一张表：通过现有 transport 调 `get_group_info`（只读动作），
 * 把 `{群号: 群名}` 落到 `<DSH_HOME>\media\qq-group-names.json`
 * （与 `qq-nicknames.json` 同一族，**路径走配置**，不写死）。
 *
 * ## 文件结构
 *
 * ```json
 * { "30000013": { "name": "示例群", "at": "2026-10-21T01:00:00.000Z" } }
 * ```
 *
 * ## 四条硬约束
 *
 * 1. **失败只记 warn，不抛**：它是观测/便利设施，不是必需品。取不到群名的后果
 *    只是接口里 `name: ''`，由前端回退显示号码。
 * 2. **绝不编名字**：拿不到就是空串，不返回"未知群"之类的占位文本
 *    （那等于把"我不知道"包装成一句看起来像信息的话）。
 * 3. **坏文件整份当空**：JSON 坏了 / 结构不对 ⇒ 空表，照常工作
 *    （表是缓存，不是真相）。
 * 4. **不阻塞启动**：拉取全是异步、fire-and-forget；写盘失败只记一条日志。
 *
 * @module qq-dsh/group-names
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `DSH_HOME` 推不出来时的兜底目录 —— 用户主目录下的 `.dsh/media`。
 *
 * 与 `nicknames.mjs` 的 `DEFAULT_NICKNAME_TABLE_DIR` 同一条规矩：
 * 兜底必须落到一个**真实可写**的位置（空串会让功能静默关闭，
 * 而那种状态下所有计数看起来都正常）。
 */
export const DEFAULT_GROUP_NAME_DIR = path.join(os.homedir(), '.dsh', 'media');

/**
 * 默认表路径：`<DSH_HOME>/media/qq-group-names.json`。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function defaultGroupNameTablePath(env = process.env) {
  const home = String(env?.DSH_HOME ?? '').trim();
  if (home === '') return path.join(DEFAULT_GROUP_NAME_DIR, 'qq-group-names.json');
  return path.join(home, 'media', 'qq-group-names.json');
}

/** 本进程推出来的默认路径（`CONFIG_SHAPE.groupNameTablePath` 的默认值）。 */
export const DEFAULT_GROUP_NAME_TABLE_PATH = defaultGroupNameTablePath();

/** 默认开关。 */
export const DEFAULT_GROUP_NAME_TABLE = Object.freeze({ enabled: true });

/**
 * 把配置收拾成能用的形状。
 *
 * **路径为空 = 明确关掉**（没有路径就没地方写；"以为自己开着"只会更坏）。
 *
 * @param {object} [raw]
 * @returns {{file: string, enabled: boolean}}
 */
export function normalizeGroupNameTable(raw = {}) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const file = src.file === undefined ? DEFAULT_GROUP_NAME_TABLE_PATH
    : (typeof src.file === 'string' ? src.file.trim() : '');
  const enabled = (typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_GROUP_NAME_TABLE.enabled)
    && file !== '';
  return { file, enabled };
}

/** 群号规范化：只留纯数字。 */
function normalizeGroupId(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return /^\d+$/.test(text) ? text : '';
}

/** 群名规范化：去空白；非字符串当空串。 */
function normalizeGroupName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 读缓存文件；**坏文件整份当空**（不抛）。
 *
 * @param {string} file
 * @param {object} [options]
 * @param {object} [options.fsImpl] 注入 fs（测试用）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @returns {{entries: Record<string, {name: string, at: string}>, degraded: boolean, loaded: number}}
 */
export function readGroupNameTable(file, { fsImpl = null, log = () => {} } = {}) {
  const f = fsImpl ?? fs;
  const target = String(file ?? '');
  if (target === '') return { entries: {}, degraded: false, loaded: 0 };
  let parsed;
  try {
    parsed = JSON.parse(f.readFileSync(target, 'utf8'));
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : '';
    if (code === 'ENOENT') return { entries: {}, degraded: false, loaded: 0 };
    // 坏了就是坏了：整份当空，不逐条抢救（缓存不该把别的事带着坏）。
    log('warn', '群名缓存读不了，按空表继续（配置页显示号码，等下次拉取）', {
      file: target,
      error: error instanceof Error ? error.message : String(error),
    });
    return { entries: {}, degraded: true, loaded: 0 };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log('warn', '群名缓存结构不对（顶层不是对象），按空表继续', { file: target });
    return { entries: {}, degraded: true, loaded: 0 };
  }
  const entries = {};
  for (const [rawId, value] of Object.entries(parsed)) {
    const id = normalizeGroupId(rawId);
    if (id === '') continue;
    // 容忍两种形状：`{name, at}` 与裸字符串。
    const name = normalizeGroupName(
      value !== null && typeof value === 'object' ? value.name : value,
    );
    if (name === '') continue;
    const at = value !== null && typeof value === 'object' && typeof value.at === 'string' ? value.at : '';
    entries[id] = { name, at };
  }
  return { entries, degraded: false, loaded: Object.keys(entries).length };
}

/**
 * 造一个群名缓存。
 *
 * @param {object} [options]
 * @param {object} [options.config] `{ file, enabled }`（也接受 `normalizeGroupNameTable` 的输出）
 * @param {object|null} [options.transport] OneBot transport（只调用 `action()`）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {object} [options.fsImpl] 注入 fs（测试用）
 * @param {() => number} [options.now] 时钟（测试用）
 * @param {number} [options.timeoutMs] 单次 `get_group_info` 超时
 * @returns {{
 *   file: () => string,
 *   enabled: () => boolean,
 *   get: (groupId: unknown) => string,
 *   names: () => Record<string, string>,
 *   stats: () => object,
 *   ensure: (ids: unknown) => Promise<number>,
 *   refresh: (ids: unknown) => Promise<number>,
 *   record: (groupId: unknown, name: unknown) => boolean,
 * }}
 */
export function createGroupNameCache({
  config = null,
  transport = null,
  log = () => {},
  fsImpl = null,
  now = () => Date.now(),
  timeoutMs = 15000,
  minRetryMs = 60000,
} = {}) {
  const cfg = normalizeGroupNameTable(config ?? DEFAULT_GROUP_NAME_TABLE);
  const f = fsImpl ?? fs;

  /** `群号 → { name, at }`。 */
  const entries = new Map();
  /** 正在拉取的群号 → Promise（同一个群只发一次）。 */
  const pending = new Map();
  /**
   * 群号 → 上次尝试拉取的时刻。
   *
   * 用途：配置页的 `/settings` 会被前端轮询，而 NapCat 没连上时每次都失败。
   * 没有这个节流，**每次轮询都会打一条 warn**（日志被刷满，真正的问题反而看不见）。
   * 失败之后 `minRetryMs` 内不再重试。
   */
  const lastAttempt = new Map();

  const stats = {
    enabled: cfg.enabled,
    loaded: 0,
    fetched: 0,
    /** 拉到了名字的次数。 */
    named: 0,
    /** 拉到了但名字是空的（有的实现会这样）。 */
    empty: 0,
    /** 拉取失败（未连接 / 超时 / 动作失败）。 */
    failed: 0,
    writes: 0,
    failedWrites: 0,
    degraded: false,
  };

  if (cfg.enabled) {
    const read = readGroupNameTable(cfg.file, { fsImpl: f, log });
    for (const [id, value] of Object.entries(read.entries)) entries.set(id, value);
    stats.loaded = read.loaded;
    stats.degraded = read.degraded;
  }

  const action = transport !== null && typeof transport?.action === 'function'
    ? (name, params, options) => transport.action(name, params, options)
    : null;

  /** 落盘（原子写）。**绝不抛异常**。 */
  function persist() {
    if (!stats.enabled) return false;
    try {
      const payload = {};
      for (const [id, value] of entries) payload[id] = { name: value.name, at: value.at };
      f.mkdirSync(path.dirname(cfg.file), { recursive: true });
      const tmp = `${cfg.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      f.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      f.renameSync(tmp, cfg.file);
      stats.writes += 1;
      return true;
    } catch (error) {
      stats.failedWrites += 1;
      log('warn', '群名缓存写盘失败（配置页显示号码，收消息回消息不受影响）', {
        file: cfg.file,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 记一条群名。群名没变就不写盘。
   * @returns {boolean} 是否写了盘
   */
  function record(groupId, name) {
    const id = normalizeGroupId(groupId);
    const text = normalizeGroupName(name);
    if (id === '' || text === '' || !stats.enabled) return false;
    const before = entries.get(id);
    if (before !== undefined && before.name === text) return false;
    entries.set(id, { name: text, at: new Date(now()).toISOString() });
    return persist();
  }

  /** 从 `get_group_info` 的返回里取群名；取不到 ⇒ 空串（**不猜**）。 */
  function pickName(data) {
    if (typeof data === 'string') return normalizeGroupName(data);
    if (data === null || typeof data !== 'object') return '';
    return normalizeGroupName(data.group_name)
      || normalizeGroupName(data.group?.group_name)
      || '';
  }

  /** 拉一个群。**永不 reject**。 */
  async function fetchOne(id) {
    stats.fetched += 1;
    if (action === null) {
      stats.failed += 1;
      log('warn', '群名拉取不可用：没有 transport（配置页显示号码）', { groupId: id });
      return '';
    }
    try {
      const data = await action('get_group_info', { group_id: Number(id) }, { timeoutMs });
      const name = pickName(data);
      if (name === '') {
        stats.empty += 1;
        log('debug', 'get_group_info 没返回群名（配置页显示号码）', { groupId: id });
        return '';
      }
      stats.named += 1;
      record(id, name);
      return name;
    } catch (error) {
      stats.failed += 1;
      log('warn', '拉群名失败（只影响显示，接口用空串回退号码）', {
        groupId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return '';
    }
  }

  /** 同一个群号只发一次请求；运行中的请求直接复用。 */
  function request(id) {
    if (pending.has(id)) return pending.get(id);
    lastAttempt.set(id, now());
    const task = fetchOne(id);
    pending.set(id, task);
    // ⚠️ 用 `finally` 清理而不是 `.then`：失败时也必须把 pending 摘掉，
    //    否则这个群号从此再也拉不到（一个超时会永久堵死一个群）。
    task.finally(() => {
      if (pending.get(id) === task) pending.delete(id);
    }).catch(() => {});
    return task;
  }

  /**
   * 缺了才补拉（配置页按需触发）。
   * @param {unknown} ids 群号数组（或逗号分隔的字符串）
   * @returns {Promise<number>} 这次真的拉到名字的条数
   */
  async function ensure(ids) {
    return pull(ids, { onlyMissing: true, force: false });
  }

  /**
   * 全部重拉（启动后拉一次白名单里的群，顺带更新改名）。
   * @param {unknown} ids
   * @returns {Promise<number>}
   */
  async function refresh(ids) {
    return pull(ids, { onlyMissing: false, force: true });
  }

  async function pull(ids, { onlyMissing, force }) {
    if (!stats.enabled) return 0;
    const list = Array.isArray(ids) ? ids : String(ids ?? '').split(/[\s,，]+/);
    const targets = [];
    const at = now();
    for (const item of list) {
      const id = normalizeGroupId(item);
      if (id === '' || targets.includes(id)) continue;
      if (onlyMissing && entries.has(id)) continue;
      // 刚失败过就别再试（每次轮询都撞一次的话，日志里只剩这一条 warn）。
      // ⚠️ 正在拉取的**不跳过**：那种情况由 `request()` 复用同一个 Promise。
      if (!force && !pending.has(id)) {
        const tried = lastAttempt.get(id);
        if (tried !== undefined && at - tried < minRetryMs) continue;
      }
      targets.push(id);
    }
    if (targets.length === 0) return 0;
    let got = 0;
    try {
      const results = await Promise.all(targets.map((id) => request(id)));
      for (const name of results) if (name !== '') got += 1;
    } catch (error) {
      // 单个请求内部已经吞掉了失败；走到这里只能是意外 —— 同样不许抛给调用方。
      log('warn', '群名批量拉取出现意外错误（已吞掉）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return got;
  }

  return {
    file: () => cfg.file,
    enabled: () => stats.enabled,
    get: (groupId) => {
      const id = normalizeGroupId(groupId);
      return id === '' ? '' : (entries.get(id)?.name ?? '');
    },
    names: () => Object.fromEntries([...entries].map(([id, value]) => [id, value.name])),
    stats: () => ({ ...stats }),
    ensure,
    refresh,
    record,
  };
}
