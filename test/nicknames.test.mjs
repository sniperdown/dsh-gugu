/**
 * `dsh/nicknames.mjs`：**`QQ → 昵称` 表**（2026-10-14）。
 *
 * ## 这些用例在钉什么（都是用户点名要求的）
 *
 * | 组 | 钉的是 |
 * |---|---|
 * | 两层结构 | **(群, QQ) → 群名片** 优先、`QQ → 昵称` 回落 |
 * | 退化 | 查不到 ⇒ **空串**（由 `formatAtSegment` 退回 `@QQ号`，不许编名字） |
 * | 持久化 | 写下来、**新实例读得到**；名字没变就**不写盘** |
 * | 坏了怎么办 | 读不出来当空表、写不进去不抛、连续失败自己断开 |
 * | 上限 | 三个上限都要真的淘汰（**绝不允许无限增长**） |
 * | 配置陷阱 | `{}`（什么都不传）**必须走默认路径且开着** —— 同 `outbound-ledger` 那个坑 |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_NICKNAME_TABLE_PATH,
  NICKNAME_TABLE_VERSION,
  createNicknameTable,
  defaultNicknameTablePath,
  normalizeNicknameTable,
} from '../src/dsh/nicknames.mjs';

/** 造一个临时目录（测试都写在里面，绝不碰 <DSH_HOME>）。 */
function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqnick-${tag}-`));
}

/** 临时表路径。 */
function tmpTable(tag) {
  return path.join(tmpdir(tag), 'qq-nicknames.json');
}

/** 造一张表（默认写在临时目录里）。 */
function makeTable(tag, options = {}) {
  const file = options.file ?? tmpTable(tag);
  const table = createNicknameTable({
    config: { file, ...(options.config ?? {}) },
    log: options.log ?? (() => {}),
    fsImpl: options.fsImpl,
    now: options.now,
  });
  return { table, file };
}

// ─────────────────────────────────────────────────────────── 两层结构与退化

test('★ 学到就查得到：`@30000002` 要能查成「小鲸鱼」（本次改动的**全部意义**）', () => {
  const { table } = makeTable('core');
  table.learn({ userId: '30000002', nickname: '小鲸鱼', card: '', groupId: '200000001' });
  assert.equal(table.resolve('30000002', '200000001'), '小鲸鱼');
  // 换个没记过名片的群，全局昵称照样能查（这就是"两层"的意义）
  assert.equal(table.resolve('30000002', '999999999'), '小鲸鱼');
});

test('★ 两层结构：**先本群名片、再全局昵称**（实测：同一个人的群名片在不同群不一样）', () => {
  const { table } = makeTable('two-layer');
  // 真机实测的形状：QQ 30000021 在测试群没名片、在群 30000011 有「本群名片A」
  table.learn({ userId: '30000021', nickname: '用户A', card: '', groupId: '30000012' });
  table.learn({ userId: '30000021', nickname: '用户A', card: '本群名片A', groupId: '30000011' });

  assert.equal(table.resolve('30000021', '30000011'), '本群名片A', '本群有群名片 ⇒ 用群名片');
  assert.equal(table.resolve('30000021', '30000012'), '用户A', '本群没名片 ⇒ 回落全局昵称');
  assert.equal(table.resolve('30000021', ''), '用户A', '没有群上下文（如私聊）⇒ 只用全局昵称');
  // **绝不串群**：A 群的名片不许出现在 B 群
  assert.notEqual(table.resolve('30000021', '30000012'), '本群名片A');
});

test('③ 查不到 ⇒ **空串**（调用方据此退回 `@QQ号`，绝不编一个"未知用户"）', () => {
  const { table } = makeTable('miss');
  assert.equal(table.resolve('123456', '200000001'), '');
  assert.equal(table.resolve('', '200000001'), '');
  assert.equal(table.resolve(undefined), '');
  assert.equal(table.resolve(null), '');
  const s = table.stats();
  // ⚠️ 空 QQ / 缺 QQ **不算未命中**（那是畸形段，不是"查了没查到"）——
  //    协议层那边 `formatAtSegment` 在 target 为空时压根不会来查。
  assert.equal(s.misses, 1);
  assert.equal(s.hits, 0);
});

test('`all`（@全体成员）不是一个人，永远不进表、也查不出来', () => {
  const { table } = makeTable('all');
  assert.equal(table.learn({ userId: 'all', nickname: '全体成员' }), false);
  assert.equal(table.resolve('all', '200000001'), '');
  assert.equal(table.people(), 0);
});

test('空值**绝不覆盖**已有的名字（某条消息没带 card ≠ 名片被清了）', () => {
  const { table } = makeTable('no-clobber');
  table.learn({ userId: '1', nickname: '阿猫', card: '猫猫', groupId: 'g1' });
  // 后面来的消息没有名字字段（NapCat 有些事件就是这样）⇒ 旧名字必须留着
  table.learn({ userId: '1', nickname: undefined, card: undefined, groupId: 'g1' });
  assert.equal(table.resolve('1', 'g1'), '猫猫');
  assert.equal(table.resolve('1'), '阿猫');
});

test('名字会更新（改名/换名片），而且**前导 @ 与换行都被清理**', () => {
  const { table } = makeTable('update');
  table.learn({ userId: '2', nickname: '旧名', groupId: 'g1' });
  table.learn({ userId: '2', nickname: '@新\n名', groupId: 'g1' });
  assert.equal(table.resolve('2'), '新 名', '换行变空格、前导 @ 去掉');
  const long = 'x'.repeat(80);
  table.learn({ userId: '3', nickname: long });
  assert.equal(table.resolve('3').length, 32, '超长昵称截到 32 字（同 sanitizeNickname）');
});

// ─────────────────────────────────────────────────────────── 写盘的闸门

test('**名字没变就不写盘**（变了才写）—— 这是"每条消息都写一次整个 JSON"的闸门', () => {
  const { table } = makeTable('write-gate');
  assert.equal(table.learn({ userId: '1', nickname: '阿猫', card: '猫猫', groupId: 'g1' }), true);
  const afterFirst = table.stats();
  assert.equal(afterFirst.writes, 1, '第一次学到名字 ⇒ 落一次盘');

  // 同一个人同一张名片连说 20 句：记忆在更新（seen 在涨），但**盘只写那一次**
  for (let i = 0; i < 20; i += 1) {
    assert.equal(table.learn({ userId: '1', nickname: '阿猫', card: '猫猫', groupId: 'g1' }), false);
  }
  assert.equal(table.stats().writes, 1, '名字没变 ⇒ 一次都不该多写');
  assert.equal(table.stats().learned, 21, '但"被喂了几次"要如实记下来');
  assert.equal(table.stats().updated, 1, '真正改写的次数只有 1');

  // 改了名片 ⇒ 又写一次
  assert.equal(table.learn({ userId: '1', nickname: '阿猫', card: '新名片', groupId: 'g1' }), true);
  assert.equal(table.stats().writes, 2);
});

test('② 持久化：**新实例读得到**（HMR 重载后表还在，这是"要落盘"的全部理由）', () => {
  const file = tmpTable('persist');
  const first = createNicknameTable({ config: { file } });
  first.learn({ userId: '30000002', nickname: '小鲸鱼', groupId: '200000001' });
  first.learn({ userId: '2001', nickname: '用户A', card: '本群名片A', groupId: '30000011' });
  assert.ok(fs.statSync(file).size > 0, '文件必须真的写下来了');

  // 模拟一次 HMR 重载：**新实例、同一个文件**
  const second = createNicknameTable({ config: { file } });
  assert.equal(second.resolve('30000002'), '小鲸鱼');
  assert.equal(second.resolve('2001', '30000011'), '本群名片A');
  // `loaded` = 人名条目 + 名片条目（这里：2 个人 + 1 张名片）
  assert.equal(second.stats().loaded, 3);
  assert.equal(second.stats().size, 2);
  assert.equal(second.stats().cardEntries, 1);
  assert.equal(second.stats().degraded, false);
});

test('磁盘上的 JSON 形状是稳的（`version` + `people` + `cards`）', () => {
  const { table, file } = makeTable('shape');
  table.learn({ userId: '1', nickname: '阿猫', card: '猫猫', groupId: 'g1' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, NICKNAME_TABLE_VERSION);
  assert.equal(raw.people['1'].nickname, '阿猫');
  assert.equal(raw.cards.g1['1'].card, '猫猫');
  assert.match(raw.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(table.read().people['1'].nickname, '阿猫');
});

test('批量学：**全部学完只落盘一次**（灌历史时几十个人不该写几十次）', () => {
  const { table } = makeTable('batch');
  const n = table.learnBatch([
    { userId: '1', nickname: 'A', groupId: 'g1' },
    { userId: '2', nickname: 'B', groupId: 'g1' },
    { userId: '3', nickname: 'C', groupId: 'g1' },
  ]);
  assert.equal(n, 3);
  assert.equal(table.stats().writes, 1, '3 个人只写 1 次');
  assert.equal(table.resolve('2', 'g1'), 'B');
});

// ─────────────────────────────────────────────────────────── 坏了怎么办

test('读不出来 ⇒ **当空表**（degraded + 一条 warn），照常能学、能查', () => {
  const file = tmpTable('broken');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  const logs = [];
  const table = createNicknameTable({ config: { file }, log: (l, m) => logs.push([l, m]) });
  assert.equal(table.stats().degraded, true);
  assert.equal(table.stats().loaded, 0);
  assert.equal(table.resolve('1'), '', '空表 ⇒ 查不到（@ 退回 QQ 号）');
  assert.equal(logs.length, 1, '坏了一次要留一行日志（不能完全静默）');
  // 坏表不影响继续学
  assert.equal(table.learn({ userId: '1', nickname: '阿猫' }), true);
  assert.equal(table.resolve('1'), '阿猫');
});

test('版本对不上 ⇒ 也当空表（表是缓存，不是真相）', () => {
  const file = tmpTable('version');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 99, people: { 1: { nickname: 'X' } } }), 'utf8');
  const table = createNicknameTable({ config: { file } });
  assert.equal(table.stats().degraded, true);
  assert.equal(table.resolve('1'), '');
});

test('**写盘失败不抛**（只记日志），连续失败若干次就本次进程内断开', () => {
  const logs = [];
  const boom = {
    readFileSync() {
      const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
    },
    mkdirSync() {},
    writeFileSync() {
      const err = new Error('EPERM: operation not permitted'); err.code = 'EPERM'; throw err;
    },
    renameSync() { throw new Error('不该走到 rename'); },
  };
  const table = createNicknameTable({
    config: { file: 'X:\\nope\\qq-nicknames.json' }, fsImpl: boom, log: (l, m) => logs.push([l, m]),
  });
  // 5 次**改名**（每次都该触发一次写盘尝试）—— 一次都不许抛出去
  for (let i = 0; i < 5; i += 1) {
    assert.doesNotThrow(() => table.learn({ userId: '1', nickname: `名字${i}` }));
  }
  const s = table.stats();
  assert.equal(s.failed, 5);
  assert.equal(s.disabled, true, '连续 5 次失败 ⇒ 本次进程内自己断开（免得每条消息都撞一次）');
  assert.equal(table.enabled(), false);
  // 断开之后照样能查（内存里学到的名字还在用）
  assert.equal(table.resolve('1'), '名字4');
  assert.ok(logs.some(([level]) => level === 'warn'));
});

test('`{file: \'\'}` = **明确关掉**：一条都不记、也不写盘', () => {
  const { table } = makeTable('off', { config: { file: '' } });
  assert.equal(table.stats().enabled, false);
  assert.equal(table.enabled(), false);
  assert.equal(table.learn({ userId: '1', nickname: '阿猫' }), false);
  assert.equal(table.stats().writes, 0);
  assert.equal(table.resolve('1'), '', '关掉 ⇒ 查不到 ⇒ @ 退回 QQ 号');
});

test('★ `{}`（什么都不传）⇒ **走默认路径、而且是开着的**（outbound-ledger 那个坑的镜像）', () => {
  // 只在**纯函数**上验：真去造表会写 <DSH_HOME>，测试绝不碰那里。
  const cfg = normalizeNicknameTable({});
  assert.equal(cfg.file, DEFAULT_NICKNAME_TABLE_PATH);
  assert.notEqual(cfg.file, '', '默认路径不许是空串（空串 = 静默关掉）');
  assert.equal(cfg.enabled, true, '什么都没配 ⇒ 默认必须是**开**的');
  // 显式关掉仍然是关掉（不会"关了却还在写"）
  assert.equal(normalizeNicknameTable({ file: '' }).enabled, false);
  assert.equal(normalizeNicknameTable({ enabled: false }).enabled, false);
});

test('默认路径跟着 DSH_HOME 走，推不出来时落到用户主目录下的 .dsh/media', () => {
  assert.equal(defaultNicknameTablePath({ DSH_HOME: 'D:\\home' }), path.join('D:\\home', 'media', 'qq-nicknames.json'));
  const fallback = path.join(os.homedir(), '.dsh', 'media', 'qq-nicknames.json');
  assert.equal(defaultNicknameTablePath({}), fallback);
  assert.equal(defaultNicknameTablePath({ DSH_HOME: '  ' }), fallback);
});

// ─────────────────────────────────────────────────────────── 上限（不许无限增长）

test('④ 上限：`maxPeople` 满了就丢**最旧的**（按最近一次更新）', () => {
  const { table } = makeTable('cap-people', { config: { maxPeople: 2 } });
  table.learn({ userId: '1', nickname: 'A', at: 1000 });
  table.learn({ userId: '2', nickname: 'B', at: 2000 });
  table.learn({ userId: '3', nickname: 'C', at: 3000 });
  const s = table.stats();
  assert.equal(s.size, 2, '不许超过上限');
  assert.equal(s.droppedPeople, 1);
  assert.equal(table.resolve('1'), '', '最旧的那个（1）被淘汰');
  assert.equal(table.resolve('3'), 'C');
});

test('④ 上限：`maxGroups` 满了就丢"最久没人说话"的那个群（防一个群吃掉全部额度）', () => {
  const { table } = makeTable('cap-groups', { config: { maxGroups: 2 } });
  table.learn({ userId: '1', nickname: 'A', card: '甲', groupId: 'g-old', at: 1000 });
  table.learn({ userId: '1', nickname: 'A', card: '乙', groupId: 'g-mid', at: 2000 });
  table.learn({ userId: '1', nickname: 'A', card: '丙', groupId: 'g-new', at: 3000 });
  const s = table.stats();
  assert.equal(s.groups, 2);
  assert.equal(s.droppedGroups, 1);
  assert.equal(table.resolve('1', 'g-old'), 'A', 'g-old 的名片没了 ⇒ 回落全局昵称');
  assert.equal(table.resolve('1', 'g-new'), '丙');
});

test('④ 上限：`maxCards` 是**全局**名片条目上限（大群也不许把表撑爆）', () => {
  const { table } = makeTable('cap-cards', { config: { maxCards: 3 } });
  for (let i = 1; i <= 5; i += 1) {
    table.learn({ userId: String(i), nickname: `N${i}`, card: `C${i}`, groupId: 'g1', at: i * 1000 });
  }
  const s = table.stats();
  assert.equal(s.cardEntries, 3, '全局名片条目不许超过上限');
  assert.equal(s.droppedCards, 2);
  assert.equal(table.resolve('1', 'g1'), 'N1', '最旧的名片被丢 ⇒ 回落全局昵称');
  assert.equal(table.resolve('5', 'g1'), 'C5');
});

test('上限=0 表示**不限**（而不是"全丢"）', () => {
  const { table } = makeTable('cap-zero', { config: { maxPeople: 0, maxCards: 0, maxGroups: 0 } });
  for (let i = 1; i <= 5; i += 1) table.learn({ userId: String(i), nickname: `N${i}`, card: `C${i}`, groupId: 'g1' });
  assert.equal(table.stats().size, 5);
  assert.equal(table.stats().cardEntries, 5);
  assert.equal(table.stats().droppedPeople, 0);
  assert.equal(table.stats().droppedCards, 0);
});

test('淘汰过的表**落盘之后**是真的少了（不是只在内存里淘汰）', () => {
  const { table, file } = makeTable('cap-persist', { config: { maxPeople: 2 } });
  for (let i = 1; i <= 4; i += 1) table.learn({ userId: String(i), nickname: `N${i}`, at: i * 1000 });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(raw.people).length, 2);
  assert.deepEqual(Object.keys(raw.people).sort(), ['3', '4']);
});
