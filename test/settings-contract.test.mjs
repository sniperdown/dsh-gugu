/**
 * 设置契约测试。
 *
 * 这个模块存在的唯一理由就是"让宿主半与浏览器半不漂移"，所以测试重点在
 * **契约本身的完整性**、**脱敏**、以及**非法输入必须被挡住**——最后一条尤其重要：
 * 一个手滑填错的 QQ 号或端口，如果在设置页保存成功却在运行时静默失效，
 * 排查成本远高于当场报错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNEL,
  ENDPOINT,
  FIELDS,
  STATUS_FIELDS,
  SECRET_PLACEHOLDER,
  fieldsByGroup,
  toPublicConfig,
  sanitizePatch,
} from '../src/dsh/settings-contract.mjs';

// ---------------------------------------------------------------- 契约完整性

test('通道名符合 Connection RPC 的 grammar', () => {
  // grammar: /^\/[A-Za-z0-9._~-]+$/
  assert.match(CHANNEL, /^\/[A-Za-z0-9._~-]+$/);
});

test('端点名非空且唯一', () => {
  const names = Object.values(ENDPOINT);
  assert.ok(names.length >= 3);
  for (const name of names) assert.ok(typeof name === 'string' && name.length > 0);
  assert.equal(new Set(names).size, names.length, '端点名不能重复');
});

test('字段声明完整：键唯一、每组至少一个、类型在支持范围内', () => {
  const supported = new Set(['string', 'number', 'boolean', 'stringList', 'enum']);
  const keys = new Set();
  for (const field of FIELDS) {
    assert.ok(typeof field.key === 'string' && field.key.length > 0, 'key 必填');
    assert.equal(keys.has(field.key), false, `key 重复：${field.key}`);
    keys.add(field.key);
    assert.ok(supported.has(field.kind), `不支持的 kind：${field.kind}（${field.key}）`);
    assert.ok(typeof field.label === 'string' && field.label.length > 0, `label 必填：${field.key}`);
    assert.ok(typeof field.group === 'string' && field.group.length > 0, `group 必填：${field.key}`);
    if (field.kind === 'enum') {
      assert.ok(Array.isArray(field.options) && field.options.length >= 2, `enum 需要至少两个选项：${field.key}`);
    }
  }
});

test('契约里不暴露嵌套对象字段（表单控件管不了，留在 YAML）', () => {
  // 这三个是有意排除的：它们的调参低频且复杂，塞进 GUI 只会让表单变形。
  for (const nested of ['proactive', 'gauge', 'report']) {
    assert.equal(
      FIELDS.some((f) => f.key === nested),
      false,
      `${nested} 不该出现在设置页字段里`,
    );
  }
});

test('accessToken 是 secret，且只有它是', () => {
  const secrets = FIELDS.filter((f) => f.secret === true).map((f) => f.key);
  assert.deepEqual(secrets, ['accessToken']);
});

test('fieldsByGroup 覆盖全部字段且不丢不重', () => {
  const groups = fieldsByGroup();
  const collected = groups.flatMap((g) => g.fields.map((f) => f.key));
  assert.equal(collected.length, FIELDS.length);
  assert.deepEqual(new Set(collected), new Set(FIELDS.map((f) => f.key)));
});

test('STATUS_FIELDS 是非空的只读字段表', () => {
  assert.ok(Array.isArray(STATUS_FIELDS) && STATUS_FIELDS.length > 0);
  for (const field of STATUS_FIELDS) {
    assert.ok(typeof field.key === 'string' && field.key.length > 0);
    assert.ok(typeof field.label === 'string' && field.label.length > 0);
  }
});

// ---------------------------------------------------------------- 脱敏

test('toPublicConfig：secret 字段脱敏成占位符，绝不回显明文', () => {
  const out = toPublicConfig({ accessToken: 'super-secret-value' });
  assert.equal(out.accessToken, SECRET_PLACEHOLDER);
  assert.equal(JSON.stringify(out).includes('super-secret-value'), false, '明文不能出现在任何地方');
});

test('toPublicConfig：未配的 secret 返回空串（区别于"配了"）', () => {
  assert.equal(toPublicConfig({ accessToken: '' }).accessToken, '');
  assert.equal(toPublicConfig({}).accessToken, '');
  assert.equal(toPublicConfig({ accessToken: null }).accessToken, '');
});

test('toPublicConfig：只输出声明过的字段', () => {
  const out = toPublicConfig({ accessToken: 'x', 内部字段: '不该出去', proactive: { enabled: true } });
  assert.equal('内部字段' in out, false);
  assert.equal('proactive' in out, false);
});

test('toPublicConfig：缺字段时按类型给出中性默认值', () => {
  const out = toPublicConfig({});
  assert.deepEqual(out.adminUsers, []);
  assert.equal(out.requireMention, false);
  assert.equal(out.host, '');
});

// ---------------------------------------------------------------- 补丁校验

test('sanitizePatch：忽略未知键（前端可能比宿主新）', () => {
  const r = sanitizePatch({ host: '127.0.0.1', 未来字段: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { host: '127.0.0.1' });
});

test('sanitizePatch：脱敏占位符表示"不改这一项"', () => {
  const r = sanitizePatch({ accessToken: SECRET_PLACEHOLDER, host: '0.0.0.0' });
  assert.equal(r.ok, true);
  assert.equal('accessToken' in r.value, false);
  assert.equal(r.value.host, '0.0.0.0');
});

test('sanitizePatch：真的改了 token 时会带上', () => {
  const r = sanitizePatch({ accessToken: 'new-token' });
  assert.equal(r.ok, true);
  assert.equal(r.value.accessToken, 'new-token');
});

test('sanitizePatch：非对象输入被拒', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(sanitizePatch(bad).ok, false, String(bad));
  }
});

test('sanitizePatch：数字字段拒绝非数字', () => {
  assert.equal(sanitizePatch({ port: 'abc' }).ok, false);
  const ok = sanitizePatch({ port: '8643' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.port, 8643, '字符串数字应收敛成数字');
});

test('sanitizePatch：数字字段拒绝空白与 null（不能让 Number("") 的 0 蒙混过关）', () => {
  // 回归：`Number('')` 是 0，早期实现会把它当成合法端口存进去。
  // 端口 0 这类"悄悄坏掉"的配置比当场报错难查得多。
  for (const blank of ['', '   ', null, undefined]) {
    const r = sanitizePatch({ port: blank });
    assert.equal(r.ok, false, `port=${JSON.stringify(blank)} 应被拒`);
    assert.match(r.error, /不能为空/);
  }
});

test('sanitizePatch：数字字段拒绝越界与小数', () => {
  assert.equal(sanitizePatch({ port: 0 }).ok, false, '端口 0 不合法');
  assert.equal(sanitizePatch({ port: -1 }).ok, false);
  assert.equal(sanitizePatch({ port: 70000 }).ok, false, '超出 65535');
  assert.equal(sanitizePatch({ port: 1.5 }).ok, false, '端口必须整数');
  assert.equal(sanitizePatch({ port: 1 }).ok, true);
  assert.equal(sanitizePatch({ port: 65535 }).ok, true);
});

test('sanitizePatch：maxReplyChars 也受边界保护', () => {
  assert.equal(sanitizePatch({ maxReplyChars: 0 }).ok, false);
  assert.equal(sanitizePatch({ maxReplyChars: -5 }).ok, false);
  assert.equal(sanitizePatch({ maxReplyChars: 1 }).ok, true);
});

test('sanitizePatch：sessionIdleEvictHours 允许 0（表示关闭淘汰）', () => {
  const r = sanitizePatch({ sessionIdleEvictHours: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.value.sessionIdleEvictHours, 0);
});

test('sanitizePatch：布尔字段接受布尔与字符串', () => {
  assert.equal(sanitizePatch({ requireMention: true }).value.requireMention, true);
  assert.equal(sanitizePatch({ requireMention: 'true' }).value.requireMention, true);
  assert.equal(sanitizePatch({ requireMention: false }).value.requireMention, false);
  assert.equal(sanitizePatch({ requireMention: 'anything' }).value.requireMention, false);
});

test('sanitizePatch：枚举字段只接受声明过的选项', () => {
  assert.equal(sanitizePatch({ mode: 'reverse' }).ok, true);
  assert.equal(sanitizePatch({ mode: 'carrier-pigeon' }).ok, false);
  assert.equal(sanitizePatch({ dmPolicy: 'open' }).ok, true);
  assert.equal(sanitizePatch({ dmPolicy: 'whatever' }).ok, false);
});

test('sanitizePatch：QQ 列表拒绝非法项，而不是悄悄存进去', () => {
  // 这是刻意的严格：一个手滑的 QQ 号如果保存成功却在运行时静默失效，
  // 排查成本远高于当场报错。
  assert.equal(sanitizePatch({ adminUsers: ['123', 'abc'] }).ok, false);
  assert.equal(sanitizePatch({ adminUsers: ['-1'] }).ok, false);
  assert.equal(sanitizePatch({ groupAllowFrom: ['1.5'] }).ok, false);

  const ok = sanitizePatch({ adminUsers: [' 123 ', '456', '123'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.adminUsers, ['123', '456'], '应去空白并去重');
});

test('sanitizePatch：字符串列表也接受逗号/空格分隔的字符串', () => {
  const r = sanitizePatch({ allowFrom: '111, 222 333' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.allowFrom, ['111', '222', '333']);
});

test('sanitizePatch：空列表是合法的（表示清空白名单）', () => {
  const r = sanitizePatch({ adminUsers: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.adminUsers, []);
});

test('sanitizePatch：报错信息里带字段的中文标签，便于运维定位', () => {
  const r = sanitizePatch({ port: 'abc' });
  assert.equal(r.ok, false);
  assert.match(r.error, /监听端口/);
});

test('sanitizePatch：不修改传入对象', () => {
  const patch = { adminUsers: ['123'], host: 'x' };
  const snapshot = JSON.stringify(patch);
  sanitizePatch(patch);
  assert.equal(JSON.stringify(patch), snapshot);
});

// ---------------------------------------------------------------- 往返

test('往返：toPublicConfig 的输出可以直接喂回 sanitizePatch 而不改变任何东西', () => {
  // 刻意**从字段表生成配置**而不是硬编码：硬编码的样本每加一个字段就会过期
  // （这条测试第一次失败就是这么来的）。而且它顺带校验了字段表的类型自洽性。
  const config = {
    accessToken: 'secret',
  };
  for (const field of FIELDS) {
    if (field.secret === true) continue;
    switch (field.kind) {
      case 'boolean':
        config[field.key] = true;
        break;
      case 'number':
        config[field.key] = (field.min ?? 0) + 1;
        break;
      case 'stringList':
        config[field.key] = ['10001', '20001'];
        break;
      case 'enum':
        config[field.key] = field.options[0];
        break;
      default:
        config[field.key] = 'sample';
    }
  }

  const pub = toPublicConfig(config);
  assert.equal(pub.accessToken, SECRET_PLACEHOLDER, 'secret 应被脱敏');
  const r = sanitizePatch(pub);
  assert.equal(r.ok, true, r.ok === false ? r.error : '');

  // token 是占位符，会被丢弃；其余字段应原样回来。
  assert.equal('accessToken' in r.value, false);
  const { accessToken, ...expected } = config;
  void accessToken;
  assert.deepEqual(r.value, expected);
});

test('往返覆盖了契约里的每一个可编辑字段（防止漏字段）', () => {
  // 从字段表生成**合法**值：枚举要用它自己的第一个选项，数字要落在 min/max 内，
  // 否则失败的原因会是"我造的值不合法"，而不是"往返坏了"。
  const config = {};
  for (const field of FIELDS) {
    if (field.secret === true) {
      // 必须给个**非空**值：空串会被 toPublicConfig 视作"未配置"并原样返回空串，
      // 而空串是合法真实值、会被 sanitizePatch 保留（对未配置的 secret 而言是对的）。
      // 只有"已配置"的 secret 才走占位符 → 被丢弃这条路。
      config[field.key] = 'secret-value';
      continue;
    }
    switch (field.kind) {
      case 'stringList':
        config[field.key] = ['1'];
        break;
      case 'boolean':
        config[field.key] = true;
        break;
      case 'number':
        config[field.key] = field.min ?? 1;
        break;
      case 'enum':
        config[field.key] = field.options[0];
        break;
      default:
        config[field.key] = 'x';
    }
  }
  const r = sanitizePatch(toPublicConfig(config));
  assert.equal(r.ok, true, r.ok === false ? r.error : '');
  const editable = FIELDS.filter((f) => f.secret !== true).map((f) => f.key).sort();
  assert.deepEqual(Object.keys(r.value).sort(), editable, '每个非 secret 字段都应能往返');
});
