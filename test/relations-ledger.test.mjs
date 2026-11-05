/**
 * 关系记账（A 段）的离线测试。零依赖。
 *
 * 这里测的是"记账本身不会错、不会涨"：计数、档位阈值、淘汰上限、写盘容错。
 * 它**不**测"该不该对这人更热络" —— 那是提示词层的事，不是账本的职责。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RELATIONS_VERSION,
  createRelationsLedger,
  parseStore,
  relationLine,
  tierFromCounts,
} from '../src/dsh/relations-ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(HERE, '.tmp-relations-'));
  return { dir, file: path.join(dir, 'qq-relations.json') };
}

test('tierFromCounts：三档阈值', () => {
  assert.equal(tierFromCounts({ msgs: 0, ats: 0, days: 0 }), 'stranger');
  assert.equal(tierFromCounts({ msgs: 4, ats: 0, days: 1 }), 'stranger');
  assert.equal(tierFromCounts({ msgs: 5, ats: 0, days: 0 }), 'known');
  assert.equal(tierFromCounts({ msgs: 0, ats: 0, days: 3 }), 'known');
  // 熟人要三样都够：量、时间跨度、被点名
  assert.equal(tierFromCounts({ msgs: 30, ats: 2, days: 6 }), 'known');
  assert.equal(tierFromCounts({ msgs: 30, ats: 1, days: 30 }), 'known');
  assert.equal(tierFromCounts({ msgs: 29, ats: 5, days: 30 }), 'known');
  assert.equal(tierFromCounts({ msgs: 30, ats: 2, days: 7 }), 'familiar');
});

test('relationLine：短、含档位、不超 40 字', () => {
  const now = Date.UTC(2026, 10, 4);
  const line = relationLine({
    nickname: '用户',
    counts: { msgs: 42, ats: 3, firstSeen: now - 9 * DAY },
    now,
  });
  assert.match(line, /^跟用户：熟人/);
  assert.match(line, /认识 9 天/);
  assert.match(line, /说过 42 句/);
  assert.match(line, /被点名 3 次/);
  assert.ok([...line].length <= 40, `太长了：${line}`);
  // 没有昵称时用 userId 兜底，别渲染出「跟这个人」
  const noName = relationLine({ userId: '10086', counts: { msgs: 1 }, now });
  assert.match(noName, /^跟10086：生面孔/);
});

test('parseStore：坏 JSON / 缺字段 / 非对象一律回空库', () => {
  assert.deepEqual(parseStore('不是 json'), { version: RELATIONS_VERSION, chats: {} });
  assert.deepEqual(parseStore('null'), { version: RELATIONS_VERSION, chats: {} });
  assert.deepEqual(parseStore('{"chats":[]}'), { version: RELATIONS_VERSION, chats: {} });
  const good = parseStore('{"chats":{"group:1":{"users":{"9":{"msgs":3}}}}}');
  assert.equal(good.chats['group:1'].users['9'].msgs, 3);
});

test('observe：累加计数、维护首末时间、被点名单独计数', () => {
  const led = createRelationsLedger({ filePath: '' });
  const t1 = Date.UTC(2026, 10, 1, 10);
  const t2 = t1 + 60_000;
  assert.equal(led.observe({ chatId: 'group:1', userId: '9', at: t1 }), true);
  assert.equal(led.observe({ chatId: 'group:1', userId: '9', at: t2, mentioned: true }), true);
  const c = led.countsOf('group:1', '9');
  assert.equal(c.msgs, 2);
  assert.equal(c.ats, 1);
  assert.equal(c.firstSeen, t1);
  assert.equal(c.lastSeen, t2);
});

test('observe：缺 chatId / userId 直接拒绝，不抛也不写', () => {
  const led = createRelationsLedger({ filePath: '' });
  assert.equal(led.observe({ userId: '9' }), false);
  assert.equal(led.observe({ chatId: 'group:1' }), false);
  assert.equal(led.observe({}), false);
  assert.deepEqual(led.toJSON().chats, {});
});

test('tierOf / lineFor：没记过的人是生面孔且没有关系行', () => {
  const led = createRelationsLedger({ filePath: '' });
  assert.equal(led.tierOf('group:1', '404'), 'stranger');
  assert.equal(led.lineFor({ chatId: 'group:1', userId: '404', nickname: '路人' }), '');
});

test('写盘往返：flush 之后新实例能读回同样的计数', () => {
  const { dir, file } = tmpFile();
  try {
    const t = Date.UTC(2026, 10, 4, 12);
    const a = createRelationsLedger({ filePath: file, debounceMs: 0 });
    a.observe({ chatId: 'group:1', userId: '9', at: t, mentioned: true });
    assert.equal(a.flush(), true);
    const b = createRelationsLedger({ filePath: file });
    const c = b.countsOf('group:1', '9');
    assert.equal(c.msgs, 1);
    assert.equal(c.ats, 1);
    assert.equal(c.firstSeen, t);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('写盘容错：目录不可写也只记 warn，observe 照常返回 true', () => {
  const warns = [];
  // 用一个"父路径是文件"的路径制造失败
  const { dir, file } = tmpFile();
  try {
    fs.writeFileSync(file, 'x', 'utf8');
    const led = createRelationsLedger({
      filePath: path.join(file, 'nested.json'),
      debounceMs: 0,
      log: (level, msg) => warns.push([level, msg]),
    });
    assert.equal(led.observe({ chatId: 'group:1', userId: '9' }), true);
    assert.equal(led.flush(), false);
    assert.ok(warns.some(([level, msg]) => level === 'warn' && msg.includes('写盘失败')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('淘汰：单个会话的用户数有上限，按 lastSeen 淘汰最旧', () => {
  const led = createRelationsLedger({ filePath: '', maxUsersPerChat: 3 });
  const base = Date.UTC(2026, 10, 1);
  for (let i = 0; i < 6; i++) {
    led.observe({ chatId: 'group:1', userId: String(i), at: base + i * 1000 });
  }
  const users = led.toJSON().chats['group:1'].users;
  assert.deepEqual(Object.keys(users).sort(), ['3', '4', '5']);
});

test('淘汰：会话数有上限，按最新一条的时间淘汰最旧', () => {
  const led = createRelationsLedger({ filePath: '', maxChats: 2 });
  const base = Date.UTC(2026, 10, 1);
  led.observe({ chatId: 'group:1', userId: '9', at: base });
  led.observe({ chatId: 'group:2', userId: '9', at: base + 1000 });
  led.observe({ chatId: 'group:3', userId: '9', at: base + 2000 });
  assert.deepEqual(Object.keys(led.toJSON().chats).sort(), ['group:2', 'group:3']);
});

test('dispose：把没写完的缓冲刷掉', () => {
  const { dir, file } = tmpFile();
  try {
    const led = createRelationsLedger({ filePath: file, debounceMs: 60_000 });
    led.observe({ chatId: 'group:1', userId: '9', at: Date.UTC(2026, 10, 4) });
    led.dispose();
    assert.equal(fs.existsSync(file), true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.chats['group:1'].users['9'].msgs, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('昵称：记账时存下最新昵称，摘要优先用它（调用方不给名字时）', () => {
  const led = createRelationsLedger({ filePath: '' });
  const t = Date.UTC(2026, 10, 4);
  led.observe({ chatId: 'group:1', userId: '9', at: t, nickname: '用户' });
  led.observe({ chatId: 'group:1', userId: '9', at: t + 1000, nickname: '僵哥' });
  assert.equal(led.countsOf('group:1', '9').nickname, '僵哥');
  assert.match(led.lineFor({ chatId: 'group:1', userId: '9' }), /^跟僵哥：/);
  // 调用方显式给名字时以调用方为准
  assert.match(led.lineFor({ chatId: 'group:1', userId: '9', nickname: '阿僵' }), /^跟阿僵：/);
});
