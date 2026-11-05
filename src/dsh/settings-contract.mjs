/**
 * 浏览器半 ↔ 宿主半的通信契约。
 *
 * 宿主与浏览器是两份独立产物，最容易出的错是**两边对通道名/端点名/字段名的理解
 * 不一致**——那不会在构建时暴露，只会在运行时静默失败（"设置页打不开"或
 * "保存了但没生效"）。所以把契约抽成一个共享模块，两边都从这里取，
 * 并由测试钉住它。
 *
 * 传输机制是 Connection RPC（`ctx.connection.rpc.handle` / `.call`），
 * **不是** VM 沙箱动态包那套 `harness.handle`/`host.call`。
 *
 * @module qq-dsh/settings-contract
 */

/** RPC 通道。grammar 要求形如 `/name`，只允许 `[A-Za-z0-9._~-]`。 */
export const CHANNEL = '/qq-proactive';

/** 端点名。 */
export const ENDPOINT = {
  /** 读当前配置（token 脱敏）。 */
  GET: 'get',
  /** 写部分配置。 */
  PATCH: 'patch',
  /** 读运行时状态（连接状态、会话数、统计）。 */
  STATUS: 'status',
};

/**
 * 可以在设置页编辑的字段。
 *
 * **每个字段都必须是"标量或字符串数组"**：设置页的表单控件有限，
 * 嵌套对象（如 `proactive`、`gauge`、`report`）不在这里暴露，仍在
 * `cordis.patch.yml` 里手改。这样划分是刻意的——把低频的调参留给 YAML，
 * 把"配错了机器人就完全不工作"的高频项放进 GUI。
 *
 * `secret: true` 的字段读回来会脱敏成 `••••`（不回显明文）。
 */
export const FIELDS = [
  { key: 'mode', label: '连接模式', kind: 'enum', options: ['reverse', 'forward'], group: 'connection' },
  { key: 'host', label: '监听地址', kind: 'string', group: 'connection' },
  { key: 'port', label: '监听端口', kind: 'number', min: 1, max: 65535, integer: true, group: 'connection' },
  { key: 'url', label: '正向目标地址', kind: 'string', group: 'connection' },
  { key: 'accessToken', label: 'Access Token', kind: 'string', secret: true, group: 'connection' },
  { key: 'botQQ', label: '机器人 QQ（留空自动学习）', kind: 'string', group: 'connection' },

  { key: 'dmPolicy', label: '私聊策略', kind: 'enum', options: ['admin', 'allowlist', 'open', 'disabled'], group: 'permissions' },
  { key: 'dmRouting', label: '私聊去向', kind: 'enum', options: ['isolated', 'main'], group: 'permissions' },
  { key: 'mainSessionKey', label: '主会话 id（dmRouting=main 时必填）', kind: 'string', group: 'permissions' },
  { key: 'groupPolicy', label: '群聊策略', kind: 'enum', options: ['admin', 'allowlist', 'open', 'disabled'], group: 'permissions' },
  { key: 'requireMention', label: '群聊必须 @ 才回应', kind: 'boolean', group: 'permissions' },
  { key: 'restrictMembers', label: '群成员加软限制（仅问答）', kind: 'boolean', group: 'permissions' },
  { key: 'adminUsers', label: '管理员 QQ', kind: 'stringList', group: 'permissions' },
  { key: 'allowFrom', label: '私聊白名单 QQ', kind: 'stringList', group: 'permissions' },
  { key: 'groupAllowFrom', label: '群白名单', kind: 'stringList', group: 'permissions' },

  { key: 'maxReplyChars', label: '回复字符上限', kind: 'number', min: 1, max: 100000, integer: true, group: 'behavior' },
  { key: 'emptyReplyFallback', label: '无纯文本时的兜底回复', kind: 'string', group: 'behavior' },
  { key: 'agentPreset', label: 'Agent Preset（留空用部署默认）', kind: 'string', group: 'behavior' },
  { key: 'workspacePath', label: '会话工作目录', kind: 'string', group: 'behavior' },
  { key: 'sessionIdleEvictHours', label: '空闲会话释放（小时）', kind: 'number', min: 0, max: 8760, integer: true, group: 'behavior' },
];

/** 只读状态字段（设置页展示，不可编辑）。 */
export const STATUS_FIELDS = [
  { key: 'connected', label: '连接状态' },
  { key: 'selfId', label: '机器人 QQ' },
  { key: 'liveSessions', label: '活跃会话数' },
  { key: 'stats', label: '统计' },
];

/** 脱敏后的占位文本；写回时看到它表示"不改这一项"。 */
export const SECRET_PLACEHOLDER = '••••••••';

/** 按 group 分组，给设置页渲染用。 */
export function fieldsByGroup() {
  const groups = new Map();
  for (const field of FIELDS) {
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(field);
  }
  return [...groups.entries()].map(([group, fields]) => ({ group, fields }));
}

/**
 * 把配置对象收敛成"可以发给浏览器"的形状（脱敏 + 只留可编辑字段）。
 * @param {object} config
 * @returns {object}
 */
export function toPublicConfig(config) {
  const out = {};
  for (const field of FIELDS) {
    const value = config?.[field.key];
    if (field.secret === true) {
      // 只告诉浏览器"有没有配"，不把明文送出去。
      out[field.key] = value === undefined || value === null || value === '' ? '' : SECRET_PLACEHOLDER;
      continue;
    }
    out[field.key] = value ?? (field.kind === 'stringList' ? [] : field.kind === 'boolean' ? false : '');
  }
  return out;
}

/**
 * 校验并收敛浏览器提交的补丁。
 *
 * 只接受 `FIELDS` 里声明过的键；未知键忽略（而不是报错——前端版本可能比宿主新）。
 * 脱敏占位符表示"不要改这一项"，直接丢弃。
 *
 * @param {unknown} patch
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function sanitizePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: '补丁必须是一个对象' };
  }
  const declared = new Map(FIELDS.map((f) => [f.key, f]));
  const value = {};
  for (const [key, raw] of Object.entries(patch)) {
    const field = declared.get(key);
    if (field === undefined) continue;
    if (field.secret === true && raw === SECRET_PLACEHOLDER) continue;
    const coerced = coerce(field, raw);
    if (coerced.ok === false) return { ok: false, error: `${field.label}：${coerced.error}` };
    value[key] = coerced.value;
  }
  return { ok: true, value };
}

/** 按字段类型收敛单个值。 */
function coerce(field, raw) {
  switch (field.kind) {
    case 'boolean':
      return { ok: true, value: raw === true || raw === 'true' };
    case 'number': {
      // 空白与 null 必须拒绝，不能让 `Number('')` 的 0 蒙混过关——
      // 端口 0、上限 0 这类"悄悄坏掉"的配置比报错难查得多。
      if (raw === null || raw === undefined) return { ok: false, error: '不能为空' };
      const text = typeof raw === 'number' ? raw : String(raw).trim();
      if (text === '') return { ok: false, error: '不能为空' };
      const n = typeof text === 'number' ? text : Number(text);
      if (!Number.isFinite(n)) return { ok: false, error: '不是合法数字' };
      if (field.integer === true && !Number.isInteger(n)) return { ok: false, error: '必须是整数' };
      if (typeof field.min === 'number' && n < field.min) return { ok: false, error: `不能小于 ${field.min}` };
      if (typeof field.max === 'number' && n > field.max) return { ok: false, error: `不能大于 ${field.max}` };
      return { ok: true, value: n };
    }
    case 'stringList': {
      const items = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,，]+/);
      const out = [];
      for (const item of items) {
        const text = String(item ?? '').trim();
        if (text === '') continue;
        // QQ 号必须是纯数字：非法项直接丢，而不是存进去等着以后炸。
        if (!/^\d+$/.test(text)) return { ok: false, error: `不是合法 QQ 号：${text}` };
        if (!out.includes(text)) out.push(text);
      }
      return { ok: true, value: out };
    }
    case 'enum': {
      const text = String(raw ?? '');
      if (!Array.isArray(field.options) || !field.options.includes(text)) {
        return { ok: false, error: `只能是 ${(field.options ?? []).join(' / ')}` };
      }
      return { ok: true, value: text };
    }
    default:
      return { ok: true, value: String(raw ?? '') };
  }
}
