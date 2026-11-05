/**
 * 按会话覆盖配置（proactive overrides）的测试。
 *
 * 用户 2026-10-04 的诉求（原话）：
 *   > 这个群聊不太活跃，可能得改下；似乎还没有单独群聊的规则，
 *   > 要不 toml 做成一套通配的规则 + 指定某几个群聊的特殊规则吧？
 *
 * 在那之前所有闸门读的是同一份全局配置 —— 想给一个安静的群放宽门槛，
 * 就得把所有群一起放宽。这个测试钉住"通配 + 覆盖"的语义。
 *
 * ⚠️ 2026-10-07 更新：原来这几条行为验证是拿 `burst-too-small` 当样例的，
 * 那道闸门已经**删除**（连同 quiet-hours，见 `proactive/engine.mjs`）。
 * 现在改用**仍然存在**的闸门 —— 预热门槛（`afterUserMsgCount`）与小时配额
 * （`maxPerHour`）—— 来验证同一件事：覆盖只作用于那个会话、且是浅合并。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProactiveEngine, defaultTriggerConfig } from '../src/proactive/engine.mjs';

/** 造一个最小可用的引擎；gauge 永远不发言，这样结果只取决于闸门。 */
function makeEngine(overrides, config = {}) {
  return new ProactiveEngine({
    config: { enabled: true, ...config },
    // 打分通道永远不触发 → 只测闸门
    gauge: async () => null,
    speak: async () => {},
    allowed: () => true,
    log: () => {},
    names: ['小鲸鱼'],
    overrides,
  });
}

/** 造一条群消息（**不 @ 机器人**，所以会走全部闸门）。 */
function groupMsg(chatId, at, text = '随便说句话') {
  const [kind, target] = chatId.split(':');
  return {
    chatId,
    kind,
    target,
    userId: '10001',
    at,
    text,
    mentioned: false,
    replyToSelf: false,
  };
}

test('没配覆盖时，用的就是全局配置', () => {
  const e = makeEngine(null, { maxPerHour: 3 });
  assert.equal(e.overrides.size, 0);
  assert.equal(e.config.maxPerHour, 3);
});

test('★ 覆盖只作用于那个会话，别的会话照旧走全局', () => {
  const e = makeEngine({ 'group:AAA': { maxPerHour: 99 } });
  assert.equal(e.overrides.size, 1, '覆盖被归一成 Map');
  // 覆盖对象的字段要能读到（行为差异见下面两条）
  assert.equal(e.overrides.get('group:AAA').maxPerHour, 99);
});

test('★ 行为验证：把某群的预热门槛降下来，它一条消息就过闸门', async () => {
  const at = 1_700_000_000_000;
  // 全局要求累计 5 条人类消息；给 AAA 覆盖成 1 条。
  const e = makeEngine({ 'group:AAA': { afterUserMsgCount: 1 } }, {
    afterUserMsgCount: 5,
    focusSpeakThreshold: 2, // 让 focus 通道永不触发，纯测闸门
    minIntervalMs: 0,
    cooldownAfterBotMs: 0,
  });

  // AAA：一条消息就够门槛 → 放行（gauge 返回 null，所以最终仍不说话；
  //      这里看的是 reason —— 放行后 reason 是打分那一路，不是 warming-up）
  const r1 = await e.decide(groupMsg('group:AAA', at));
  assert.notEqual(r1.reason, 'warming-up(1/5)', 'AAA 的门槛应该被覆盖成 1');

  // BBB：没配覆盖 → 全局 5 条 → 一条消息过不去
  const r2 = await e.decide(groupMsg('group:BBB', at));
  assert.match(
    String(r2.reason),
    /^warming-up\(1\/5\)$/,
    `BBB 该走全局门槛，实际 reason=${r2.reason}`,
  );
});

test('★ 覆盖是【浅合并】：只改写的字段，其余**向全局要**（不是回默认值）', async () => {
  // 这是最关键的一条语义。整段替换的话，以后每加一个配置项，
  // 所有覆盖规则都会悄悄退回默认值 —— 那种 bug 极难查。
  //
  // 验证手法：全局把配额设成 0（一句都不许说），覆盖里**只**改预热门槛。
  // 于是 AAA 过了预热门槛，却**照样**被全局的 maxPerHour 拦住 ——
  // 若覆盖是"整段替换"，maxPerHour 会退回引擎默认的 6，这条就过了。
  const at = 1_700_000_000_000;
  const e = makeEngine({ 'group:AAA': { afterUserMsgCount: 1 } }, {
    afterUserMsgCount: 5,
    maxPerHour: 0,
    minIntervalMs: 0,
    cooldownAfterBotMs: 0,
  });
  const r = await e.decide(groupMsg('group:AAA', at));
  assert.equal(r.reason, 'hourly-cap', '没写的字段必须继承全局（浅合并）');
});

test('★ 可以用覆盖单独关掉一个群（enabled: false）', async () => {
  const at = 1_700_000_000_000;
  const e = makeEngine({ 'group:QUIET': { enabled: false } }, { enabled: true });
  const r = await e.decide(groupMsg('group:QUIET', at));
  assert.equal(r.reason, 'proactive-disabled');
  assert.equal(r.speak, false);
});

test('关掉一个群不影响别的群', async () => {
  const at = 1_700_000_000_000;
  const e = makeEngine({ 'group:QUIET': { enabled: false } }, {
    enabled: true,
    afterUserMsgCount: 0,
    focusSpeakThreshold: 2,
    minIntervalMs: 0,
    cooldownAfterBotMs: 0,
  });
  const r = await e.decide(groupMsg('group:LOUD', at));
  assert.notEqual(r.reason, 'proactive-disabled', 'LOUD 没被关，不该是 disabled');
});

test('被点名时覆盖也拦不住（@ 是直接请求，且私聊永远是 addressed）', async () => {
  const at = 1_700_000_000_000;
  const e = makeEngine({ 'group:QUIET': { enabled: false } }, { enabled: true });
  const mentioned = { ...groupMsg('group:QUIET', at), mentioned: true };
  const r = await e.decide(mentioned);
  assert.notEqual(r.reason, 'proactive-disabled', '@ 了就该放行，不该被 enabled:false 挡住');
});

test('坏数据不会让引擎起不来（null / 数组 / 空键都丢掉）', () => {
  const e = makeEngine({
    'group:OK': { afterUserMsgCount: 2 },
    '': { x: 1 },
    'group:NULL': null,
    'group:ARR': [1, 2, 3],
  });
  assert.equal(e.overrides.size, 1, `只该留下合法的那条，实际 ${e.overrides.size}`);
  assert.ok(e.overrides.has('group:OK'));
});

test('默认配置里不该有 overrides（不传就是空 Map）', () => {
  const e = new ProactiveEngine({ config: defaultTriggerConfig(), gauge: async () => null, speak: async () => {}, allowed: () => true });
  assert.equal(e.overrides.size, 0);
});
