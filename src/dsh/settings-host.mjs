/**
 * 设置页的宿主半：通过 Connection RPC 把配置读写暴露给浏览器半。
 *
 * 传输机制是 `ctx.connection.register(owner, channel, handler)` ——
 * **不是** VM 沙箱动态包那套 `harness.handle`/`host.call`。
 *
 * handler 的契约（源码 `dsh-client-connection` 的 `rpcFetchHandler`）：
 *
 *     handler(endpoint, payload, signal, peer) => Promise<{ok:true, value} | {ok:false, error}>
 *
 * 两点容易错：
 * 1. **必须自己返回信封**。抛异常会让整条通道变成 HTTP 500，
 *    浏览器侧只能看到"请求失败"，看不到原因；返回 `{ok:false,error}` 才能把
 *    校验信息原样送到界面上。
 * 2. handler 收到的 `endpoint` 是**路径里的那一段**，而不是我们自己选的枚举值；
 *    这里以它为准做分派，并和契约里的 `ENDPOINT` 对齐。
 *
 * 写入走 ConfigEditor 服务：它负责校验、持久化进 profile 的 patch 层，并触发
 * Loader 重载——也就是和运维手改 `cordis.patch.yml` **同一层、同一条路径**，
 * 不会出现"设置页改了但 YAML 里看不到"的两套状态。
 *
 * @module qq-dsh/settings-host
 */
import {
  CHANNEL,
  ENDPOINT,
  toPublicConfig,
  sanitizePatch,
} from './settings-contract.mjs';

/** 我们的 Loader 行 id，用来在 ConfigEditor 的条目表里定位自己。 */
const ENTRY_ID = 'qq-proactive';

/**
 * 造出给 `connection.register` 用的 handler。
 *
 * @param {object} options
 * @param {object} options.ctx Cordis 上下文
 * @param {() => object} options.getConfig 读当前生效配置
 * @param {() => object} options.getStatus 读运行时状态
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @returns {(endpoint: string, payload: any, signal: AbortSignal, peer: any) => Promise<object>}
 */
export function createSettingsHandler({ ctx, getConfig, getStatus, log = () => {} }) {
  return async function handle(endpoint, payload, signal) {
    try {
      if (signal?.aborted === true) return fail('cancelled', '请求已取消');

      switch (endpoint) {
        case ENDPOINT.GET:
          return ok({
            config: toPublicConfig(getConfig()),
            channel: CHANNEL,
            entryId: ENTRY_ID,
          });

        case ENDPOINT.STATUS:
          return ok(getStatus());

        case ENDPOINT.PATCH:
          return await applyPatch({ ctx, payload, getConfig, log });

        default:
          return fail('unknown-endpoint', `未知端点：${endpoint}`);
      }
    } catch (error) {
      // 兜底：绝不让异常逃出去变成 500，否则界面只能显示"请求失败"。
      const message = error instanceof Error ? error.message : String(error);
      log('warn', '设置页请求失败', { endpoint, error: message });
      return fail('internal', message);
    }
  };
}

/**
 * 应用一个配置补丁：校验 → 写进 profile 的 patch 层。
 */
async function applyPatch({ ctx, payload, getConfig, log }) {
  const sanitized = sanitizePatch(payload);
  if (sanitized.ok === false) return fail('invalid', sanitized.error);

  const patch = sanitized.value;
  if (Object.keys(patch).length === 0) {
    return ok({ changed: false, config: toPublicConfig(getConfig()) });
  }

  // 反向模式必须有 token，否则监听端口会把机器人控制权开放给整个局域网。
  // 只在这一项被改到时校验，避免"别的字段一并保存"时被无关规则挡住。
  if (patch.mode === 'reverse' || Object.hasOwn(patch, 'accessToken')) {
    const effective = { ...getConfig(), ...patch };
    if (effective.mode === 'reverse' && (effective.accessToken ?? '').trim() === '') {
      return fail(
        'invalid',
        '反向模式必须填 Access Token：空 token 的监听端口会让同网段任何人都能控制这个 QQ 号。',
      );
    }
  }

  const editor = ctx?.configEditor;
  if (editor === undefined || editor === null || typeof editor.edit !== 'function') {
    return fail(
      'no-editor',
      '当前 profile 没有 configEditor 服务，无法持久化配置。请改为手工编辑 profile 的 cordis.patch.yml。',
    );
  }

  const entry = findEntry(editor);
  if (entry === undefined) {
    return fail(
      'no-entry',
      `在 profile 的 Loader 树里找不到 id 为 ${JSON.stringify(ENTRY_ID)} 的条目，无法写回配置。`,
    );
  }

  try {
    // change 是 (current, inherited) => next。ConfigEditor 负责校验、
    // 原子写入与 Loader 重载；这里只做"在现有 config 上叠加补丁"。
    await editor.edit(entry, (current) => ({ ...current, ...patch }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('warn', '写入配置失败', { error: message });
    return fail('write-failed', `写入 profile 配置失败：${message}`);
  }

  log('info', '设置页已更新配置', { keys: Object.keys(patch) });
  return ok({
    changed: true,
    applied: Object.keys(patch),
    // 回读当前生效值（含脱敏），让界面立刻反映真实状态。
    config: toPublicConfig(getConfig()),
  });
}

/** 在 ConfigEditor 的条目表里找我们这一行。 */
function findEntry(editor) {
  try {
    const entries = editor.entries();
    if (!Array.isArray(entries)) return undefined;
    return entries.find((entry) => entry?.options?.id === ENTRY_ID);
  } catch {
    return undefined;
  }
}

function ok(value) {
  return { ok: true, value };
}

function fail(code, message) {
  return { ok: false, error: { code: `qq-proactive/${code}`, message } };
}

export { CHANNEL, ENDPOINT, ENTRY_ID };
