/**
 * 群名缓存（2026-10-21）。
 *
 * ## 这一组在钉什么
 *
 * 1. **路径走配置**：默认 `<DSH_HOME>\media\qq-group-names.json`，
 *    **不写死**（与 `qq-nicknames.json` 同族）。
 * 2. **落盘结构**：`{ "<群号>": { "name": "…", "at": "ISO" } }`。
 * 3. **坏文件容忍**：JSON 坏了 / 顶层不是对象 ⇒ 整份当空，照常工作。
 * 4. **失败只 warn、绝不抛**：没 transport、动作失败、写盘失败都一样。
 * 5. **取不到名字 ⇒ 空串**（不编名字，前端回退显示号码）。
 *
 * ⚠️ 测试里的 transport 是**纯替身**：只回 `get_group_info`，
 * **不接线、不发送任何消息**（出站安全）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_GROUP_NAME_TABLE_PATH,
  createGroupNameCache,
  defaultGroupNameTablePath,
  normalizeGroupNameTable,
  readGroupNameTable,
} from '../src/dsh/group-names.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-groupnames-';

function tempDir() {
  return fs.mkdtempSync(path.join(HERE, PREFIX));
}

function tempFile(dir, name = 'qq-group-names.json') {
  return path.join(dir, name);
}

/**
 * 假 transport：只实现 `action()`，只认 `get_group_info`。
 * @param {Record<string, string>|Error|null} names 群号 → 群名；`Error` = 一律抛
 */
function fakeTransport(names) {
  const calls = [];
  return {
    calls,
    async action(action, params) {
      calls.push({ action, params });
      if (names instanceof Error) throw names;
      if (action !== 'get_group_info') throw new Error(`不认识的 action: ${action}`);
      const id = String(params.group_id);
      const name = names[id];
      if (name === undefined) throw new Error('群不存在');
      return { group_id: Number(id), group_name: name };
    },
  };
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith(PREFIX)) fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
    }
  } catch {
    /* 收尾失败不影响测试结果 */
  }
});

// ---------------------------------------------------------------- 路径 / 配置

test('defaultGroupNameTablePath：优先 DSH_HOME', () => {
  const got = defaultGroupNameTablePath({ DSH_HOME: 'D:\\fake-home' });
  assert.equal(got, path.join('D:\\fake-home', 'media', 'qq-group-names.json'));
});

test('defaultGroupNameTablePath：没有 DSH_HOME ⇒ 本部署写死目录（不是空串）', () => {
  const got = defaultGroupNameTablePath({});
  assert.ok(got.endsWith('qq-group-names.json'));
  assert.ok(got.includes('media'));
  assert.equal(got, DEFAULT_GROUP_NAME_TABLE_PATH);
});

test('normalizeGroupNameTable：空路径 = 明确关掉', () => {
  assert.equal(normalizeGroupNameTable({ file: '' }).enabled, false);
  assert.equal(normalizeGroupNameTable({ file: ' x.json ' }).file, 'x.json');
  assert.equal(normalizeGroupNameTable({ file: 'x.json', enabled: false }).enabled, false);
});

// ---------------------------------------------------------------- 读盘

test('readGroupNameTable：坏 JSON ⇒ 空表 + warn，不抛', () => {
  const dir = tempDir();
  const file = tempFile(dir);
  fs.writeFileSync(file, '{ 这不是 json', 'utf8');
  const warnings = [];
  const got = readGroupNameTable(file, { log: (level, message) => warnings.push({ level, message }) });
  assert.deepEqual(got.entries, {});
  assert.equal(got.degraded, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'warn');
});

test('readGroupNameTable：顶层是数组 ⇒ 空表 + warn', () => {
  const dir = tempDir();
  const file = tempFile(dir);
  fs.writeFileSync(file, '[]', 'utf8');
  const warnings = [];
  const got = readGroupNameTable(file, { log: (level) => warnings.push(level) });
  assert.deepEqual(got.entries, {});
  assert.equal(got.degraded, true);
  assert.equal(warnings[0], 'warn');
});

test('readGroupNameTable：文件不存在 ⇒ 空表且不算坏', () => {
  const got = readGroupNameTable(path.join(tempDir(), 'nope.json'));
  assert.deepEqual(got.entries, {});
  assert.equal(got.degraded, false);
});

test('readGroupNameTable：跳过空名字与非数字群号，容忍裸字符串', () => {
  const dir = tempDir();
  const file = tempFile(dir);
  fs.writeFileSync(file, JSON.stringify({
    111: { name: ' 群一 ', at: '2026-10-21T00:00:00.000Z' },
    222: { name: '' },
    abc: { name: '不该要' },
    333: '裸字符串群名',
  }), 'utf8');
  const got = readGroupNameTable(file);
  assert.deepEqual(got.entries, {
    111: { name: '群一', at: '2026-10-21T00:00:00.000Z' },
    333: { name: '裸字符串群名', at: '' },
  });
});

// ---------------------------------------------------------------- 拉取 / 落盘

test('★ ensure：拉到群名 ⇒ 落盘结构是 { 群号: { name, at } }', async () => {
  const dir = tempDir();
  const file = tempFile(dir);
  const now = Date.parse('2026-10-21T01:02:03.000Z');
  const transport = fakeTransport({ 30000013: '示例群' });
  const cache = createGroupNameCache({
    config: { file },
    transport,
    now: () => now,
  });
  const got = await cache.ensure(['30000013']);
  assert.equal(got, 1);
  assert.equal(cache.get('30000013'), '示例群');
  assert.deepEqual(cache.names(), { 30000013: '示例群' });

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw, {
    30000013: { name: '示例群', at: new Date(now).toISOString() },
  });
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].action, 'get_group_info');
  assert.deepEqual(transport.calls[0].params, { group_id: 30000013 });
});

test('★ 构造时读已有缓存；已缓存的群 ensure 不再拉', async () => {
  const dir = tempDir();
  const file = tempFile(dir);
  fs.writeFileSync(file, JSON.stringify({ 111: { name: '群一', at: 'x' } }), 'utf8');
  const transport = fakeTransport({ 111: '群一（新）', 222: '群二' });
  const cache = createGroupNameCache({ config: { file }, transport });
  assert.equal(cache.get(111), '群一');
  assert.equal(await cache.ensure(['111', '222']), 1, '111 已缓存，只拉 222');
  assert.equal(transport.calls.length, 1);
  assert.equal(cache.get('222'), '群二');
});

test('★ 拉取失败 ⇒ 只记 warn，不抛，接口里是空串', async () => {
  const dir = tempDir();
  const file = tempFile(dir);
  const warnings = [];
  const cache = createGroupNameCache({
    config: { file },
    transport: fakeTransport(new Error('OneBot 未连接，无法调用 get_group_info')),
    log: (level, message) => warnings.push({ level, message }),
  });
  const got = await cache.ensure(['30000013']);
  assert.equal(got, 0);
  assert.equal(cache.get('30000013'), '', '取不到名字 ⇒ 空串（宿主不编名字）');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'warn');
  assert.equal(fs.existsSync(file), false, '失败不该写盘');
});

test('★ 没有 transport ⇒ 只 warn，不抛', async () => {
  const dir = tempDir();
  const warnings = [];
  const cache = createGroupNameCache({
    config: { file: tempFile(dir) },
    transport: null,
    log: (level) => warnings.push(level),
  });
  assert.equal(await cache.ensure(['1']), 0);
  assert.equal(cache.get('1'), '');
  assert.equal(warnings[0], 'warn');
});

test('get_group_info 返回空群名 ⇒ 不写盘、不编名字', async () => {
  const dir = tempDir();
  const file = tempFile(dir);
  const transport = {
    calls: [],
    async action(action, params) {
      this.calls.push({ action, params });
      return { group_id: Number(params.group_id), group_name: '   ' };
    },
  };
  const cache = createGroupNameCache({ config: { file }, transport });
  assert.equal(await cache.ensure(['1']), 0);
  assert.equal(cache.get('1'), '');
  assert.equal(fs.existsSync(file), false);
});

test('refresh：改过名的群会更新（启动拉一次就是靠它）', async () => {
  const dir = tempDir();
  const file = tempFile(dir);
  fs.writeFileSync(file, JSON.stringify({ 111: { name: '旧名', at: 'x' } }), 'utf8');
  const cache = createGroupNameCache({
    config: { file },
    transport: fakeTransport({ 111: '新名' }),
  });
  assert.equal(await cache.refresh(['111']), 1);
  assert.equal(cache.get('111'), '新名');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['111'].name, '新名');
});

test('并发 ensure 同一个群 ⇒ 只发一次请求（pending 去重）', async () => {
  const dir = tempDir();
  const file = tempFile(dir);
  let calls = 0;
  const transport = {
    async action() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { group_name: '群一' };
    },
  };
  const cache = createGroupNameCache({ config: { file }, transport });
  const [a, b] = await Promise.all([cache.ensure(['111']), cache.ensure(['111'])]);
  assert.equal(calls, 1);
  assert.equal(a, 1);
  assert.equal(b, 1, '两个调用方都拿到同一次拉取的结果');
  assert.equal(cache.get('111'), '群一');
});

test('写盘失败 ⇒ 只记 warn，不抛（缓存坏了不能把主流程带下去）', async () => {
  const dir = tempDir();
  const warnings = [];
  const brokenFs = {
    ...fs,
    writeFileSync() {
      throw new Error('EPERM: operation not permitted');
    },
  };
  const cache = createGroupNameCache({
    config: { file: tempFile(dir) },
    transport: fakeTransport({ 1: '群一' }),
    fsImpl: brokenFs,
    log: (level, message) => warnings.push({ level, message }),
  });
  assert.equal(await cache.ensure(['1']), 1, '名字在内存里拿到了');
  assert.equal(cache.get('1'), '群一');
  assert.equal(warnings.some((item) => item.level === 'warn'), true);
  assert.equal(cache.stats().failedWrites, 1);
});

test('record：同名不重复写盘；不同名改一次', () => {
  const dir = tempDir();
  const file = tempFile(dir);
  const cache = createGroupNameCache({
    config: { file },
    transport: fakeTransport({}),
    now: () => 1000,
  });
  assert.equal(cache.record('1', '群一'), true);
  assert.equal(cache.record('1', '群一'), false, '同名不该再写');
  assert.equal(cache.record('1', '群一改名'), true);
  assert.equal(cache.get('1'), '群一改名');
  assert.equal(cache.stats().writes, 2);
});

test('★ 拉取失败后在 minRetryMs 内不再重试（免得每次轮询刷一条 warn）', async () => {
  const dir = tempDir();
  const warnings = [];
  let calls = 0;
  let clock = 0;
  const transport = {
    async action() {
      calls += 1;
      throw new Error('未连接');
    },
  };
  const cache = createGroupNameCache({
    config: { file: tempFile(dir) },
    transport,
    now: () => clock,
    minRetryMs: 60000,
    log: (level) => warnings.push(level),
  });
  await cache.ensure(['1']);
  assert.equal(calls, 1);
  clock += 1000;
  await cache.ensure(['1']);
  assert.equal(calls, 1, '还在节流窗口里');
  assert.equal(warnings.length, 1, '只该 warn 一次');
  clock += 60000;
  await cache.ensure(['1']);
  assert.equal(calls, 2, '过了窗口可以重试');
});

test('路径为空 = 关掉：不读不写、ensure 直接返回 0', async () => {
  const cache = createGroupNameCache({ config: { file: '' }, transport: fakeTransport({ 1: '群一' }) });
  assert.equal(cache.enabled(), false);
  assert.equal(await cache.ensure(['1']), 0);
  assert.equal(cache.get('1'), '');
});
