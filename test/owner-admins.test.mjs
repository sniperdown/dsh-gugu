/**
 * `[owner] admins`（2026-10-21）。
 *
 * ## 这一组在钉什么
 *
 * 1. **加载器规范化**：去空白、只留数字、去重、保序；留空/缺失 ⇒ 空数组。
 * 2. **回退规则**：`admins[0] ?? allowFrom[0]` —— **admins 为空才回退**，
 *    而不是"白名单第一个永远是用户"（那是改动前的隐含约定）。
 * 3. **快照契约**：`snapshot.owner = { admins, source }`，
 *    `source` 只能是 `owner` / `allowFrom` / `none`。
 * 4. **新配置项 `groupNameTablePath`** 也是字符串（与 `nicknameTablePath` 同一条规矩）。
 *
 * ⚠️ 全组不碰线上 `qq-gugu.toml`，全部在 `test/.tmp-owner-*` 下现造。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OWNER_SOURCE,
  loadOwnerConfig,
  normalizeAdminList,
  ownerFromTomlDocument,
  ownerSnapshot,
  resolveOwner,
} from '../src/dsh/owner.mjs';
import { buildSnapshot } from '../src/dsh/debug-snapshot.mjs';
import { DEFAULT_GROUP_NAME_TABLE_PATH } from '../src/dsh/group-names.mjs';
import { configShape, resolveConfig } from '../src/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-owner-';

function tempDir() {
  return fs.mkdtempSync(path.join(HERE, PREFIX));
}

function writeFile(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
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

// ---------------------------------------------------------------- 规范化

test('normalizeAdminList：数组去空白、只留数字、去重、保序', () => {
  assert.deepEqual(
    normalizeAdminList([' 30000001 ', '30000001', 'abc', '123', 456]),
    ['30000001', '123', '456'],
  );
});

test('normalizeAdminList：字符串按英文/中文逗号、顿号、空白切分', () => {
  assert.deepEqual(normalizeAdminList('1, 2，3、4 5; 6'), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(normalizeAdminList('1\n2\t3'), ['1', '2', '3']);
});

test('normalizeAdminList：空 / 缺失 / 全是非数字 ⇒ 空数组', () => {
  assert.deepEqual(normalizeAdminList(undefined), []);
  assert.deepEqual(normalizeAdminList(null), []);
  assert.deepEqual(normalizeAdminList(''), []);
  assert.deepEqual(normalizeAdminList([]), []);
  assert.deepEqual(normalizeAdminList(['abc', '  ']), []);
});

// ---------------------------------------------------------------- 回退

test('resolveOwner：admins 非空 ⇒ 用第一个，source=owner', () => {
  const got = resolveOwner({ admins: ['900', '901'], allowFrom: ['100'] });
  assert.deepEqual(got, { admins: ['900', '901'], source: OWNER_SOURCE.OWNER, qq: '900' });
});

test('★ resolveOwner：admins 为空 ⇒ 回退 allowFrom 第一个（不是"白名单永远是用户"）', () => {
  const got = resolveOwner({ admins: [], allowFrom: ['100', '200'] });
  assert.equal(got.qq, '100');
  assert.equal(got.source, OWNER_SOURCE.ALLOW_FROM);
  assert.deepEqual(got.admins, [], 'admins 保留原样（空），不把回退项混进去');
});

test('resolveOwner：两处都空 ⇒ none，qq 是空串', () => {
  assert.deepEqual(resolveOwner({}), { admins: [], source: OWNER_SOURCE.NONE, qq: '' });
});

test('resolveOwner：allowFrom 里的非数字项被忽略（不会当用户）', () => {
  const got = resolveOwner({ admins: [], allowFrom: ['abc', ' 123 '] });
  assert.equal(got.qq, '123');
});

// ---------------------------------------------------------------- 读 toml

test('ownerFromTomlDocument：读 [owner] admins', () => {
  const doc = { owner: { admins: ['7', '7', '8'] } };
  assert.deepEqual(ownerFromTomlDocument(doc, { allowFrom: ['1'] }), {
    admins: ['7', '8'],
    source: 'owner',
    qq: '7',
  });
});

test('loadOwnerConfig：读临时 toml 的 [owner] 段', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', [
    '[personality]',
    'personality = "x"',
    '',
    '[owner]',
    'admins = ["30000001", " 123 "]',
    '',
  ].join('\n'));
  const got = loadOwnerConfig({ tomlPath, allowFrom: ['999'] });
  assert.deepEqual(got.admins, ['30000001', '123']);
  assert.equal(got.source, 'owner');
  assert.equal(got.qq, '30000001');
});

test('loadOwnerConfig：没有 [owner] 段 ⇒ 回退 allowFrom，且不抛', () => {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', '[personality]\npersonality = "x"\n');
  const got = loadOwnerConfig({ tomlPath, allowFrom: ['42'] });
  assert.equal(got.qq, '42');
  assert.equal(got.source, 'allowFrom');
});

test('loadOwnerConfig：文件读不到 ⇒ 回退，只记 warn，不抛', () => {
  const warnings = [];
  const got = loadOwnerConfig(
    { tomlPath: path.join(HERE, '.tmp-owner-does-not-exist.toml'), allowFrom: ['42'] },
    (level, message) => warnings.push({ level, message }),
  );
  assert.equal(got.qq, '42');
  assert.equal(got.source, 'allowFrom');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'warn');
});

// ---------------------------------------------------------------- 快照契约

test('ownerSnapshot：只吐 { admins, source }，非法 source 归 none', () => {
  assert.deepEqual(ownerSnapshot({ admins: ['1', '1', 'x'], source: 'owner' }), {
    admins: ['1'],
    source: 'owner',
  });
  assert.deepEqual(ownerSnapshot({ admins: [], source: '瞎写的' }), {
    admins: [],
    source: 'none',
  });
  assert.deepEqual(ownerSnapshot(null), { admins: [], source: 'none' });
});

test('★ buildSnapshot：默认就有 owner = { admins: [], source: "none" }', () => {
  const snapshot = buildSnapshot({});
  assert.deepEqual(snapshot.owner, { admins: [], source: 'none' });
});

test('★ buildSnapshot：owner 按契约落盘（不额外塞字段）', () => {
  const snapshot = buildSnapshot({ owner: { admins: ['30000001'], source: 'owner', qq: '不该出现' } });
  assert.deepEqual(snapshot.owner, { admins: ['30000001'], source: 'owner' });
});

// ---------------------------------------------------------------- 配置形状

test('configShape.groupNameTablePath：默认指向 media\\qq-group-names.json', () => {
  assert.equal(typeof configShape.groupNameTablePath, 'string');
  assert.equal(configShape.groupNameTablePath, DEFAULT_GROUP_NAME_TABLE_PATH);
  assert.ok(configShape.groupNameTablePath.endsWith('qq-group-names.json'));
});

test('resolveConfig：groupNameTablePath 非字符串 ⇒ 当场报错（不静默）', () => {
  assert.throws(
    () => resolveConfig({ groupNameTablePath: 123 }),
    /groupNameTablePath/,
  );
});
