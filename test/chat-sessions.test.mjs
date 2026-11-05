/**
 * 会话映射表（`src/dsh/chat-sessions.mjs`）的测试。
 *
 * 这一层管的是"QQ 聊天 ↔ DSH 会话 id"的**唯一真相**，所以重点钉三件事：
 *
 * 1. **纯读 vs 分配分开**：`lookup` 绝不许建 id / 写盘（启动路径就靠它不抛）。
 * 2. **坏文件不能把插件带下去**：JSON 坏了、类型不对 ⇒ 当空表 + warn。
 * 3. **表是唯一真相**：已有绑定不许被顺手覆盖；退休的 id 不许复活。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSessionMap,
  createSessionResolver,
  defaultRetiredPath,
  defaultSessionsPath,
} from '../src/dsh/chat-sessions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-chat-sessions-';

function tempDir() {
  return fs.mkdtempSync(path.join(HERE, PREFIX));
}

/** 造一份隔离的表（文件在校内 temp 目录，跑完删）。 */
function makeMap(overrides = {}) {
  const dir = tempDir();
  return createSessionMap({
    mappingFile: path.join(dir, 'qq-chat-sessions.json'),
    retiredFile: path.join(dir, 'qq-retired-sessions.json'),
    log: () => {},
    ...overrides,
  });
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith(PREFIX)) fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
    }
  } catch {
    /* 清理失败不影响测试结论 */
  }
});

// ---------------------------------------------------------------- 纯读 / 分配

test('lookup：查不到返回 null，且**不建 id、不写盘**（启动路径就靠它不抛）', () => {
  const dir = tempDir();
  const mappingFile = path.join(dir, 'qq-chat-sessions.json');
  const map = createSessionMap({ mappingFile, retiredFile: path.join(dir, 'r.json'), log: () => {} });

  assert.equal(map.lookup('private:30000001'), null);
  assert.equal(fs.existsSync(mappingFile), false, 'lookup 不许产生文件');
});

test('ensure：分配 `session-<uuid>`、写进表、同一条聊天永远同一个 id', () => {
  const dir = tempDir();
  const mappingFile = path.join(dir, 'qq-chat-sessions.json');
  const map = createSessionMap({ mappingFile, retiredFile: path.join(dir, 'r.json'), log: () => {} });

  const first = map.ensure('private:30000001');
  assert.match(first, /^session-[0-9a-f-]{36}$/);
  assert.equal(map.lookup('private:30000001'), first, '同一 chatId 必须稳定');
  assert.equal(map.ensure('private:30000001'), first, '再 ensure 不许换 id');

  // 落盘的是合法 JSON，键还是 chatId。
  const doc = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
  assert.equal(doc['private:30000001'], first);

  // 新实例重读 ⇒ 还是同一个 id（这就是"重启后能接回同一个会话"）。
  const again = createSessionMap({ mappingFile, retiredFile: path.join(dir, 'r.json'), log: () => {} });
  assert.equal(again.lookup('private:30000001'), first);
});

test('ensure：chatId 不合法 ⇒ null，不写盘', () => {
  const map = makeMap();
  assert.equal(map.ensure('channel:1'), null);
  assert.equal(map.ensure(''), null);
  assert.equal(map.entries().length, 0);
});

test('note：迁移期把"当前实际在用的旧 id"记进表', () => {
  const map = makeMap();
  assert.equal(map.note('group:30000011', 'qq-group-30000011'), true);
  assert.equal(map.lookup('group:30000011'), 'qq-group-30000011');
});

test('note：已有**不同**绑定 ⇒ 保留旧的 + warn（表是唯一真相，不许被顺手改掉）', () => {
  const logs = [];
  const map = makeMap({ log: (level, msg) => logs.push([level, msg]) });
  map.note('group:30000011', 'qq-group-30000011');
  assert.equal(map.note('group:30000011', 'session-ffffffff-ffff-4fff-8fff-ffffffffffff'), false);
  assert.equal(map.lookup('group:30000011'), 'qq-group-30000011');
  assert.ok(logs.some(([level, msg]) => level === 'warn' && String(msg).includes('不同的 id')));
});

// ---------------------------------------------------------------- 反查

test('反查：chatIdOfSession / kindOfSession / userIdOfSession / hasSession', () => {
  const map = makeMap();
  const priv = map.ensure('private:30000001');
  const group = map.ensure('group:30000011');

  assert.equal(map.chatIdOfSession(priv), 'private:30000001');
  assert.equal(map.chatIdOfSession(group), 'group:30000011');
  assert.equal(map.chatIdOfSession('session-unknown'), null);

  assert.equal(map.kindOfSession(priv), 'private');
  assert.equal(map.kindOfSession(group), 'group');
  assert.equal(map.kindOfSession('qq-private-30000001'), 'unknown', '表里没有就说不认识（旧前缀由 resolver 兜）');

  assert.equal(map.userIdOfSession(priv), '30000001');
  assert.equal(map.userIdOfSession(group), '', '群没有"私聊对方 QQ 号"');

  assert.equal(map.hasSession(priv), true);
  assert.equal(map.hasSession('qq-private-30000001'), false);
});

// ---------------------------------------------------------------- 退休

test('retire：从表里摘掉 + 进退休名单，两个文件都落盘', () => {
  const dir = tempDir();
  const mappingFile = path.join(dir, 'qq-chat-sessions.json');
  const retiredFile = path.join(dir, 'qq-retired-sessions.json');
  const map = createSessionMap({ mappingFile, retiredFile, log: () => {} });
  map.note('private:30000001', 'qq-private-30000001');

  assert.equal(map.retire('qq-private-30000001'), true);
  assert.equal(map.lookup('private:30000001'), null, '退休后不再绑定');
  assert.equal(map.isRetired('qq-private-30000001'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(retiredFile, 'utf8')), ['qq-private-30000001']);
  assert.deepEqual(JSON.parse(fs.readFileSync(mappingFile, 'utf8')), {});
});

test('退休的 id 不许写回表（防"下次启动又把旧历史救回来"）', () => {
  const logs = [];
  const map = makeMap({ log: (level, msg) => logs.push([level, msg]) });
  map.retire('qq-private-30000001');
  assert.equal(map.note('private:30000001', 'qq-private-30000001'), false);
  assert.equal(map.lookup('private:30000001'), null);
  assert.ok(logs.some(([level, msg]) => level === 'warn' && String(msg).includes('退休')));
});

test('表里出现已退休的 id ⇒ 以退休名单为准（加载时清掉）', () => {
  const dir = tempDir();
  const mappingFile = path.join(dir, 'qq-chat-sessions.json');
  const retiredFile = path.join(dir, 'qq-retired-sessions.json');
  fs.writeFileSync(mappingFile, JSON.stringify({ 'private:30000001': 'qq-private-30000001' }));
  fs.writeFileSync(retiredFile, JSON.stringify(['qq-private-30000001']));
  const map = createSessionMap({ mappingFile, retiredFile, log: () => {} });
  assert.equal(map.lookup('private:30000001'), null);
});

// ---------------------------------------------------------------- 坏文件 / 原子写

test('坏文件：JSON 语法错 / 不是对象 ⇒ 当空表 + warn，**不抛**', () => {
  const dir = tempDir();
  const mappingFile = path.join(dir, 'qq-chat-sessions.json');
  const retiredFile = path.join(dir, 'qq-retired-sessions.json');
  fs.writeFileSync(mappingFile, '{ 这不是 JSON');
  fs.writeFileSync(retiredFile, '["x", 42, null]');
  const logs = [];
  const map = createSessionMap({ mappingFile, retiredFile, log: (level, msg) => logs.push([level, msg]) });

  assert.equal(map.lookup('private:30000001'), null);
  assert.doesNotThrow(() => map.ensure('private:30000001'));
  assert.ok(logs.some(([level]) => level === 'warn'));
});

test('脏条目：不合法的 chatId / 空 id 直接跳过（不污染表）', () => {
  const dir = tempDir();
  const mappingFile = path.join(dir, 'qq-chat-sessions.json');
  const retiredFile = path.join(dir, 'qq-retired-sessions.json');
  fs.writeFileSync(mappingFile, JSON.stringify({
    'private:30000001': 'session-ok',
    'channel:1': 'session-bad-chat',
    'group:30000011': '',
    'group:1': 42,
  }));
  fs.writeFileSync(retiredFile, '[]');
  const map = createSessionMap({ mappingFile, retiredFile, log: () => {} });
  assert.deepEqual(map.entries(), [{ chatId: 'private:30000001', sessionId: 'session-ok' }]);
});

test('写盘原子：不残留 tmp；第二次写之前留一份 .bak', () => {
  const dir = tempDir();
  const mappingFile = path.join(dir, 'qq-chat-sessions.json');
  const map = createSessionMap({ mappingFile, retiredFile: path.join(dir, 'r.json'), log: () => {} });
  map.ensure('private:30000001');
  map.ensure('group:30000011');

  const names = fs.readdirSync(dir);
  assert.equal(names.some((n) => n.includes('.tmp-')), false, '不许残留临时文件');
  assert.equal(fs.existsSync(`${mappingFile}.bak`), true, '要留上一版备份');
  const doc = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
  assert.equal(Object.keys(doc).length, 2);
});

// ---------------------------------------------------------------- resolver（P1-4 的接线点）

test('resolver.resolve：表优先，查不到回退旧前缀（这一版不分配新 id）', () => {
  const map = makeMap();
  const resolver = createSessionResolver({ map });
  map.note('private:30000001', 'session-8f3a0000-0000-4000-8000-000000000000');

  assert.deepEqual(resolver.resolve('private:30000001'), {
    sessionId: 'session-8f3a0000-0000-4000-8000-000000000000',
    source: 'map',
  });
  assert.deepEqual(resolver.resolve('group:30000011'), {
    sessionId: 'qq-group-30000011',
    source: 'legacy',
  });
  assert.deepEqual(resolver.resolve('channel:1'), { sessionId: '', source: 'unresolvable' });
});

test('resolver：kindOf / userIdOf / scopeOf / has 对**新旧两种 id** 都成立', () => {
  const map = makeMap();
  const resolver = createSessionResolver({ map });
  const newId = map.ensure('private:30000001');
  map.ensure('group:30000011');

  // 新 id
  assert.equal(resolver.kindOf(newId), 'private');
  assert.equal(resolver.userIdOf(newId), '30000001');
  assert.deepEqual(resolver.scopeOf(newId), { kind: 'private', id: '30000001' });

  // 旧 id（迁移期必须继续认）
  assert.equal(resolver.kindOf('qq-private-30000001'), 'private');
  assert.equal(resolver.userIdOf('qq-private-30000001'), '30000001');
  assert.deepEqual(resolver.scopeOf('qq-group-30000011'), { kind: 'group', id: '30000011' });

  // 直接传 chatId（历史行为，测试也在用）
  assert.equal(resolver.kindOf('group:100'), 'group');
  assert.equal(resolver.kindOf('private:2001'), 'private');
  assert.equal(resolver.kindOf('session-unknown'), 'unknown');

  assert.equal(resolver.has(newId), true);
  assert.equal(resolver.has('qq-group-1'), true);
  assert.equal(resolver.has('session-unknown'), false);
  assert.equal(resolver.has(''), false);
});

test('resolver.note：把当前实际在用的 id 记进表（迁移期积累旧 id 靠它）', () => {
  const map = makeMap();
  const resolver = createSessionResolver({ map });
  assert.equal(resolver.note('group:30000011', 'qq-group-30000011'), true);
  assert.equal(map.lookup('group:30000011'), 'qq-group-30000011');
  assert.equal(resolver.stats().entries, 1);
});

test('resolver：legacy 策略下 afterResumeFailure 什么都不做（回滚开关的行为）', () => {
  const map = makeMap();
  const resolver = createSessionResolver({ map, policy: 'legacy' });
  assert.equal(resolver.policy, 'legacy');
  assert.equal(resolver.afterResumeFailure('private:30000001', 'qq-private-30000001'), null);
  assert.equal(map.lookup('private:30000001'), null, 'legacy 不分配、不写表');
});

test('resolver：new-if-no-legacy 在 resume 失败后分配 `session-<uuid>` 并写表（P2-6）', () => {
  const map = makeMap();
  const resolver = createSessionResolver({ map, policy: 'new-if-no-legacy' });
  assert.equal(resolver.policy, 'new-if-no-legacy');

  // resolve 仍是"纯路由"：表里没有就返回旧前缀候选（给 binder 拿去 resume）。
  assert.deepEqual(resolver.resolve('private:30000001'), {
    sessionId: 'qq-private-30000001',
    source: 'legacy',
  });

  // resume 失败 ⇒ 分配新 id。
  const decision = resolver.afterResumeFailure('private:30000001', 'qq-private-30000001');
  assert.match(decision.sessionId, /^session-[0-9a-f-]{36}$/);
  assert.equal(decision.source, 'new');
  assert.equal(map.lookup('private:30000001'), decision.sessionId, '新 id 必须进表');

  // 之后再 resolve ⇒ 直接查表（不会再走旧前缀）。
  assert.deepEqual(resolver.resolve('private:30000001'), {
    sessionId: decision.sessionId,
    source: 'map',
  });
});

test('resolver：afterResumeFailure 对非法 chatId ⇒ null（不造垃圾条目）', () => {
  const map = makeMap();
  const resolver = createSessionResolver({ map, policy: 'new-if-no-legacy' });
  assert.equal(resolver.afterResumeFailure('channel:1', 'qq-channel-1'), null);
  assert.equal(resolver.afterResumeFailure('', ''), null);
  assert.equal(map.entries().length, 0);
});

test('persist:false：纯内存（不读盘、不写盘）—— 测试/无 state 目录的部署靠它', () => {
  const dir = tempDir();
  const mappingFile = path.join(dir, 'qq-chat-sessions.json');
  const map = createSessionMap({
    mappingFile,
    retiredFile: path.join(dir, 'qq-retired-sessions.json'),
    log: () => {},
    persist: false,
  });
  const id = map.ensure('private:30000001');
  assert.equal(map.lookup('private:30000001'), id, '内存里照常工作');
  assert.equal(fs.existsSync(mappingFile), false, '一个字节都不许落盘');
  assert.equal(map.retire(id), true);
  assert.equal(map.isRetired(id), true);
  assert.equal(fs.existsSync(path.join(dir, 'qq-retired-sessions.json')), false);
});

test('默认路径：<DSH_HOME>/media/qq-chat-sessions.json（可用 env 覆盖）', () => {
  assert.equal(
    defaultSessionsPath({ DSH_HOME: '<DSH_HOME>' }).replaceAll('/', '\\'),
    '<DSH_HOME>\\media\\qq-chat-sessions.json',
  );
  assert.equal(
    defaultRetiredPath({ DSH_HOME: '<DSH_HOME>' }).replaceAll('/', '\\'),
    '<DSH_HOME>\\media\\qq-retired-sessions.json',
  );
  assert.equal(defaultSessionsPath({ QQ_SESSION_MAP_FILE: 'X:\\a.json' }), 'X:\\a.json');
});
