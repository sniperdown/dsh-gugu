/**
 * 路由与访问控制测试。
 *
 * 这一层的每个分支都对应一个"机器人会不会在不该说话的地方说话"的后果，
 * 所以默认值和不放行路径要测得比放行路径更细。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Router,
  DM_ROUTING,
  resolveSessionTarget,
  POLICY,
  ACTION,
  defaultConfig,
  normalizeIdList,
  sessionKeyFor,
  sessionKeyFromChatId,
  parseChatId,
  chatIdFromSessionKey,
  renderPrompt,
  truncateReply,
} from '../src/dsh/routing.mjs';

/** 造一条群消息。 */
function groupMsg(overrides = {}) {
  return {
    chatId: 'group:100',
    kind: 'group',
    userId: '2001',
    nickname: '阿猫',
    text: '今天这个 bug 有意思',
    at: Date.UTC(2026, 2, 1, 12, 0, 0),
    mentioned: false,
    groupId: '100',
    ...overrides,
  };
}

/** 造一条私聊消息。 */
function dmMsg(overrides = {}) {
  return {
    chatId: 'private:2001',
    kind: 'private',
    userId: '2001',
    nickname: '阿猫',
    text: '在吗',
    at: Date.UTC(2026, 2, 1, 12, 0, 0),
    mentioned: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------- 默认值

test('默认配置偏保守：私聊仅管理员、群聊需 @', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.dmPolicy, POLICY.ADMIN);
  assert.equal(cfg.groupPolicy, POLICY.ADMIN);
  assert.equal(cfg.requireMention, true);
  assert.equal(cfg.restrictMembers, true);
});

test('默认配置下，没有配置管理员时谁都不能私聊', () => {
  const router = new Router();
  const verdict = router.resolve(dmMsg());
  assert.equal(verdict.action, ACTION.IGNORE);
  assert.match(verdict.reason, /dm-denied/);
});

// ---------------------------------------------------------------- normalizeIdList

test('normalizeIdList：去空白、去重、丢非法项', () => {
  assert.deepEqual(normalizeIdList([' 1 ', '2', '2', '', 'abc', null, undefined, '3']), ['1', '2', '3']);
  assert.deepEqual(normalizeIdList('42'), ['42']);
  assert.deepEqual(normalizeIdList(undefined), []);
  assert.deepEqual(normalizeIdList(123), ['123'], '数字也接受');
  assert.deepEqual(normalizeIdList(['-1', '1.5']), [], '负数与小数不是合法 QQ 号');
});

// ---------------------------------------------------------------- 私聊策略

test('私聊 admin 策略：仅管理员可聊', () => {
  const router = new Router({ adminUsers: ['9001'] });
  assert.equal(router.resolve(dmMsg({ userId: '9001' })).action, ACTION.DISPATCH);
  assert.equal(router.resolve(dmMsg({ userId: '2001' })).action, ACTION.IGNORE);
});

test('私聊 allowlist 策略：白名单可聊，不必是管理员', () => {
  const router = new Router({ dmPolicy: POLICY.ALLOWLIST, allowFrom: ['2001'] });
  const verdict = router.resolve(dmMsg({ userId: '2001' }));
  assert.equal(verdict.action, ACTION.DISPATCH);
  assert.equal(router.resolve(dmMsg({ userId: '3000' })).action, ACTION.IGNORE);
});

test('私聊 open 策略：所有人都可聊', () => {
  const router = new Router({ dmPolicy: POLICY.OPEN });
  assert.equal(router.resolve(dmMsg({ userId: '1' })).action, ACTION.DISPATCH);
});

test('私聊 disabled 策略：谁都不行', () => {
  const router = new Router({ dmPolicy: POLICY.DISABLED, adminUsers: ['9001'] });
  assert.equal(router.resolve(dmMsg({ userId: '9001' })).action, ACTION.IGNORE);
});

test('私聊策略值非法时按最严处理（fail-closed）', () => {
  const router = new Router({ dmPolicy: 'nonsense', adminUsers: ['9001'] });
  assert.equal(router.resolve(dmMsg({ userId: '9001' })).action, ACTION.DISPATCH, '管理员仍可用');
  assert.equal(router.resolve(dmMsg({ userId: '2001' })).action, ACTION.IGNORE);
});

test('私聊非管理员被标记为受限', () => {
  const router = new Router({ dmPolicy: POLICY.OPEN, adminUsers: ['9001'] });
  assert.equal(router.resolve(dmMsg({ userId: '2001' })).restricted, true);
  assert.equal(router.resolve(dmMsg({ userId: '9001' })).restricted, false);
});

// ---------------------------------------------------------------- 群聊策略

test('群聊 admin 策略：群要在白名单，且只有管理员能唤起', () => {
  const router = new Router({
    groupPolicy: POLICY.ADMIN,
    groupAllowFrom: ['100'],
    adminUsers: ['9001'],
  });
  // 管理员在允许的群里 @ 机器人 → 处理
  assert.equal(
    router.resolve(groupMsg({ mentioned: true, userId: '9001' })).action,
    ACTION.DISPATCH,
  );
  // 普通成员在允许的群里 @ 机器人 → 只观察（admin 策略下发言人也受限）
  const member = router.resolve(groupMsg({ mentioned: true, userId: '2001' }));
  assert.equal(member.action, ACTION.OBSERVE);
  assert.equal(member.reason, 'group-speaker-denied');
  // 不在白名单的群 → 只观察
  const other = router.resolve(groupMsg({ groupId: '999', chatId: 'group:999', mentioned: true }));
  assert.equal(other.action, ACTION.OBSERVE);
  assert.match(other.reason, /group-denied/);
});

test('群聊 allowlist 策略：白名单群内任何人都能唤起（需 @）', () => {
  const router = new Router({ groupPolicy: POLICY.ALLOWLIST, groupAllowFrom: ['100'] });
  assert.equal(router.resolve(groupMsg({ mentioned: true, userId: '2001' })).action, ACTION.DISPATCH);
  assert.equal(router.resolve(groupMsg({ groupId: '999', chatId: 'group:999', mentioned: true })).action, ACTION.OBSERVE);
});

test('群聊 open 策略：任何群，任何人（需 @）', () => {
  const router = new Router({ groupPolicy: POLICY.OPEN });
  assert.equal(
    router.resolve(groupMsg({ groupId: '999', chatId: 'group:999', mentioned: true })).action,
    ACTION.DISPATCH,
  );
});

test('群聊 disabled 策略：连转录都不记', () => {
  const router = new Router({ groupPolicy: POLICY.DISABLED });
  const verdict = router.resolve(groupMsg({ mentioned: true, groupId: '100' }));
  assert.equal(verdict.action, ACTION.IGNORE);
});

test('群聊没被 @ 时**不再**被路由挡掉（@ 不再是切换通道的开关）', () => {
  // 统一判定后：路由只回答"能不能跟这个会话说话"，"要不要回"交给判定层。
  // `requireMention` 这个开关因此失效 —— 未 @ 的消息同样进入 DISPATCH，
  // 由 engine 打分决定说不说（MaiBot 的做法：@ 只是加分，不是另一个通道）。
  const router = new Router({ groupPolicy: POLICY.OPEN, requireMention: true });
  const verdict = router.resolve(groupMsg({ mentioned: false }));
  assert.equal(verdict.action, ACTION.DISPATCH);
  assert.equal(verdict.reason, 'group-allowed');
});

test('requireMention 已不影响路由（未 @ 也是 DISPATCH）', () => {
  const router = new Router({ groupPolicy: POLICY.OPEN, requireMention: false });
  assert.equal(router.resolve(groupMsg({ mentioned: false })).action, ACTION.DISPATCH);
});

test('群聊成员受限标记：restrictMembers 开关与非管理员', () => {
  const on = new Router({ groupPolicy: POLICY.OPEN, restrictMembers: true, adminUsers: ['9001'] });
  assert.equal(on.resolve(groupMsg({ mentioned: true, userId: '2001' })).restricted, true);
  assert.equal(on.resolve(groupMsg({ mentioned: true, userId: '9001' })).restricted, false);

  const off = new Router({ groupPolicy: POLICY.OPEN, restrictMembers: false });
  assert.equal(off.resolve(groupMsg({ mentioned: true, userId: '2001' })).restricted, false);
});

// ---------------------------------------------------------------- 畸形输入

test('畸形消息一律 ignore，不抛异常', () => {
  const router = new Router({ groupPolicy: POLICY.OPEN, dmPolicy: POLICY.OPEN });
  for (const bad of [null, undefined, 'x', 42, []]) {
    const verdict = router.resolve(bad);
    assert.equal(verdict.action, ACTION.IGNORE);
    assert.equal(verdict.sessionKey, '');
  }
});

test('未知 kind 一律 ignore', () => {
  const router = new Router({ groupPolicy: POLICY.OPEN });
  assert.equal(router.resolve({ kind: 'channel', chatId: 'channel:1' }).action, ACTION.IGNORE);
});

test('群消息缺 groupId 时不放行', () => {
  const router = new Router({ groupPolicy: POLICY.OPEN, requireMention: false });
  const verdict = router.resolve(groupMsg({ groupId: undefined }));
  // groupId 为空串 → 不在白名单语义下都会走到 deny 或 observe。
  assert.notEqual(verdict.action, ACTION.DISPATCH);
});

// ---------------------------------------------------------------- 会话键

test('会话键从 chatId 稳定派生，且群/私聊分开', () => {
  assert.equal(sessionKeyFromChatId('group:100'), 'qq-group-100');
  assert.equal(sessionKeyFromChatId('private:2001'), 'qq-private-2001');
  assert.equal(sessionKeyFor(groupMsg()), 'qq-group-100');
  assert.equal(sessionKeyFor(dmMsg()), 'qq-private-2001');
});

test('会话键与 chatId 互为逆运算', () => {
  for (const chatId of ['group:100', 'private:2001', 'group:999999999']) {
    assert.equal(chatIdFromSessionKey(sessionKeyFromChatId(chatId)), chatId);
  }
});

test('会话键：同群不同人是同一个会话（群是共享上下文）', () => {
  const a = sessionKeyFor(groupMsg({ userId: '2001' }));
  const b = sessionKeyFor(groupMsg({ userId: '3000' }));
  assert.equal(a, b, '同一个群必须共用一个会话，否则群里每个人都各说各话');
});

test('会话键：私聊按人分开', () => {
  assert.notEqual(
    sessionKeyFor(dmMsg({ userId: '2001', chatId: 'private:2001' })),
    sessionKeyFor(dmMsg({ userId: '3000', chatId: 'private:3000' })),
  );
});

test('会话键：非法 chatId 返回空串而不是抛错或造出脏键', () => {
  for (const bad of ['', 'group', 'group:abc', 'channel:1', 'group:-1', null, undefined]) {
    assert.equal(sessionKeyFromChatId(bad), '', `chatId=${JSON.stringify(bad)}`);
  }
  assert.equal(chatIdFromSessionKey('qq-channel-1'), '');
  assert.equal(chatIdFromSessionKey(''), '');
});

test('会话键不含随机或时间成分（重启后必须能 resume 回同一个）', () => {
  // 这是硬约束：连算两次必须一模一样，且不同进程也一致。
  const first = sessionKeyFromChatId('group:100');
  const second = sessionKeyFromChatId('group:100');
  assert.equal(first, second);
  assert.equal(first, 'qq-group-100');
});

test('parseChatId：纯格式解析，不查表、不碰状态（P0-2 的启动路径校验器）', () => {
  // 存在的理由：`report.target` 的校验**只许**问"这个字符串形状对不对"。
  // 一旦它开始查映射表，表里没有这条 chatId（新装/清状态）就会抛 ⇒ 插件加载失败 ⇒
  // 整个 App 起不来。所以这个函数必须是纯的。
  assert.deepEqual(parseChatId('group:123456'), { kind: 'group', id: '123456' });
  assert.deepEqual(parseChatId('private:30000001'), { kind: 'private', id: '30000001' });

  for (const bad of ['', 'group', 'group:', ':123', 'group:abc', 'channel:1', 'group:-1',
    'group:1:2', null, undefined, 42, {}]) {
    assert.equal(parseChatId(bad), null, `chatId=${JSON.stringify(bad)}`);
  }
});

test('parseChatId 与 sessionKeyFromChatId 口径一致（同一个判据，不许两套）', () => {
  for (const chatId of ['group:100', 'private:2001', 'group:abc', 'channel:1', '', 'group:']) {
    const parsed = parseChatId(chatId);
    const key = sessionKeyFromChatId(chatId);
    assert.equal(key === '', parsed === null, `两者必须同时认/同时拒：${JSON.stringify(chatId)}`);
  }
});

// ---------------------------------------------------------------- 提示词渲染

/**
 * "今天" —— 和 `groupMsg`/`dmMsg` 的 `at` **同一个 UTC+8 日历日**。
 *
 * 改动前这里只需要 `at`（只有裸 `HH:MM`）；现在要判一次"是不是当天"
 * （当天裸时钟 / 否则带日期），所以每条用例都得把 `now` 钉死 ——
 * 不然跑测试的那一天一变，断言就跟着变（`formatStamp` 就是这么设计的：时钟由调用方给）。
 */
const SAME_DAY = Date.UTC(2026, 2, 1, 12, 0, 0);

test('renderPrompt：群聊带时钟与发言人前缀（当天：裸 HH:MM，不加噪音）', () => {
  const text = renderPrompt(groupMsg({ at: SAME_DAY, text: '看这个' }), { now: SAME_DAY });
  assert.equal(text, '[20:00 阿猫(2001)] 看这个');
});

test('renderPrompt：不是当天的消息带日期（2026-10-13 新行为）', () => {
  // 用户原话：「还是带，所有的消息都带时间戳」。
  // 判据是"这条是哪天说的"，不是"过了多少小时" —— 所以 `now` 换成 10-13。
  const now = Date.UTC(2026, 9, 13, 6, 50); // UTC+8 的 10-13 14:50
  assert.equal(
    renderPrompt(groupMsg({ at: Date.UTC(2026, 2, 1, 12, 0), text: '看这个' }), { now }),
    '[03-01 20:00 阿猫(2001)] 看这个',
  );
  assert.equal(
    renderPrompt(groupMsg({ at: Date.UTC(2025, 11, 31, 15, 50), text: '看这个' }), { now }),
    '[2025-12-31 23:50 阿猫(2001)] 看这个',
    '跨年才补年份',
  );
});

test('renderPrompt：私聊不带【发言人】前缀，但时间戳照带', () => {
  // 改动前私聊是**一个字符都不加**（`return body`）⇒ 模型看不出这条是什么时候说的。
  // 2026-10-13 起：发言人仍然不加（上下文里只有两个人），时间戳两边一样带。
  assert.equal(renderPrompt(dmMsg({ text: '在吗' }), { now: SAME_DAY }), '[20:00] 在吗');
  assert.equal(
    renderPrompt(
      dmMsg({ at: Date.UTC(2026, 2, 1, 12, 0), text: '在吗' }),
      { now: Date.UTC(2026, 9, 13, 6, 50) },
    ),
    '[03-01 20:00] 在吗',
  );
});

test('renderPrompt：受限标记排在时间戳之前', () => {
  const text = renderPrompt(groupMsg({ text: '帮我删库' }), { restricted: true, now: SAME_DAY });
  assert.match(text, /^\[受限用户:仅问答\]\[20:00 阿猫\(2001\)\]/);
});

test('renderPrompt：昵称缺失时回退 QQ 号', () => {
  const text = renderPrompt(groupMsg({ nickname: '' }), { now: SAME_DAY });
  assert.match(text, /\(2001\)/);
  assert.match(text, /2001\(2001\)/, '昵称空则用 QQ 号占位');
});

test('renderPrompt：时区偏移影响前缀时钟', () => {
  const at = Date.UTC(2026, 2, 1, 12, 0);
  assert.match(renderPrompt(groupMsg({ at }), { utcOffsetMinutes: 0, now: at }), /^\[12:00 /);
  assert.match(renderPrompt(groupMsg({ at }), { utcOffsetMinutes: 480, now: at }), /^\[20:00 /);
});

test('renderPrompt：空正文不产出只有前缀的噪音', () => {
  assert.equal(renderPrompt(dmMsg({ text: '   ' }), { now: SAME_DAY }), '');
});

test('renderPrompt：`at` 缺失/非法时退回"现在"（改动前的兜底行为）', () => {
  // `routing.mjs` 原来那份私有 `formatClock` 就是 `Number.isFinite(at) ? at : Date.now()`。
  // 这条钉住：别把一条时间未知的消息渲染成 `[NaN:NaN 阿猫(2001)]`。
  assert.equal(
    renderPrompt(groupMsg({ at: undefined }), { now: SAME_DAY }),
    '[20:00 阿猫(2001)] 今天这个 bug 有意思',
  );
});

// ---------------------------------------------------------------- 截断

test('truncateReply：未超限时原样返回', () => {
  assert.equal(truncateReply('短', 10), '短');
  assert.equal(truncateReply('', 10), '');
});

test('truncateReply：超限时截断并加省略号', () => {
  const out = truncateReply('abcdefghij', 5);
  assert.equal(Array.from(out).length, 5, '结果长度应等于上限');
  assert.ok(out.endsWith('…'));
  assert.equal(out, 'abcd…');
});

test('truncateReply：按码点切，不把 emoji 拆成半个', () => {
  const out = truncateReply('😀😀😀😀😀', 3);
  assert.equal(Array.from(out).length, 3);
  assert.equal(out, '😀😀…');
  // 不能出现孤立的代理项。
  assert.equal(out.includes('\uFFFD'), false);
});

test('truncateReply：limit 非法时不截断（而不是把内容清空）', () => {
  assert.equal(truncateReply('内容', 0), '内容');
  assert.equal(truncateReply('内容', -1), '内容');
  assert.equal(truncateReply('内容', Number.NaN), '内容');
});

// ---------------------------------------------------------------- 主动发言放行

test('proactiveAllowed：私聊跟随私聊策略', () => {
  const router = new Router({ dmPolicy: POLICY.ALLOWLIST, allowFrom: ['2001'] });
  assert.equal(router.proactiveAllowed('private:2001'), true);
  assert.equal(router.proactiveAllowed('private:3000'), false);
});

test('proactiveAllowed：群聊在 disabled 下永不放行', () => {
  const router = new Router({ groupPolicy: POLICY.DISABLED, groupAllowFrom: ['100'] });
  assert.equal(router.proactiveAllowed('group:100'), false);
});

test('proactiveAllowed：admin/allowlist 策略下要求群在白名单', () => {
  for (const policy of [POLICY.ADMIN, POLICY.ALLOWLIST]) {
    const router = new Router({ groupPolicy: policy, groupAllowFrom: ['100'] });
    assert.equal(router.proactiveAllowed('group:100'), true, policy);
    assert.equal(router.proactiveAllowed('group:999'), false, policy);
  }
});

test('proactiveAllowed：群聊这一路与 groupAllowed 完全一致（同一个策略字段只有一种解释）', () => {
  // 回归：早先 proactiveAllowed 在 `open` + 白名单非空时会**收窄**到白名单，
  // 而 groupAllowed 在 `open` 下允许任何群。同一个策略字段两种含义的后果是：
  // 群能用机器人、消息也进了转录、判定也跑了，但冒泡被静默拒绝——
  // 用户只看到"机器人在群里但从不说主动话"。
  for (const policy of [POLICY.ADMIN, POLICY.ALLOWLIST, POLICY.OPEN, POLICY.DISABLED]) {
    for (const allowFrom of [[], ['100']]) {
      const router = new Router({ groupPolicy: policy, groupAllowFrom: allowFrom });
      for (const group of ['100', '999']) {
        assert.equal(
          router.proactiveAllowed(`group:${group}`),
          router.groupAllowed(group),
          `策略 ${policy} / 白名单 ${JSON.stringify(allowFrom)} / 群 ${group}：` +
            '主动发言准入必须与群聊准入一致',
        );
      }
    }
  }
});

test('proactiveAllowed：open 策略且白名单为空时放行任何群', () => {
  const router = new Router({ groupPolicy: POLICY.OPEN });
  assert.equal(router.proactiveAllowed('group:999'), true);
});

test('proactiveAllowed：open 策略但白名单非空时——群聊仍放行（与 groupAllowed 一致）', () => {
  // `open` 的字面意思就是"任何群"。一旦写了白名单，运维应当用 allowlist 策略，
  // 而不是让 open 悄悄变成 allowlist。
  const router = new Router({ groupPolicy: POLICY.OPEN, groupAllowFrom: ['100'] });
  assert.equal(router.proactiveAllowed('group:100'), true);
  assert.equal(
    router.proactiveAllowed('group:999'),
    true,
    'open 就是 open；要限范围请用 allowlist 策略',
  );
});

test('proactiveAllowed：非法 chatId 一律 false', () => {
  const router = new Router({ groupPolicy: POLICY.OPEN, dmPolicy: POLICY.OPEN });
  for (const bad of ['', 'nonsense', 'channel:1', 'group:abc', null, undefined]) {
    assert.equal(router.proactiveAllowed(bad), false, String(bad));
  }
});

// ---------------------------------------------------------------- 私聊去向

test('resolveSessionTarget：默认私聊各自独立会话', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.dmRouting, DM_ROUTING.ISOLATED);
  assert.equal(cfg.mainSessionKey, '');
  const t = resolveSessionTarget(dmMsg({ userId: '2001' }), cfg);
  assert.equal(t.sessionKey, 'qq-private-2001');
  assert.equal(t.reason, 'dm-isolated');
});

test('resolveSessionTarget：dmRouting=main 且有 key 时统一进主会话', () => {
  const t = resolveSessionTarget(dmMsg({ userId: '2001' }), {
    dmRouting: DM_ROUTING.MAIN,
    mainSessionKey: 'session-00000000',
  });
  assert.equal(t.sessionKey, 'session-00000000');
  assert.equal(t.reason, 'dm-main');
});

test('resolveSessionTarget：dmRouting=main 但缺 key 时回落到独立会话（不隐式挑）', () => {
  // 隐式挑一个"主会话"会让"它为什么答的是那个会话的内容"极难排查，
  // 所以宁可显式回落并说明原因。
  for (const bad of ['', '   ', undefined, null]) {
    const t = resolveSessionTarget(dmMsg({ userId: '2001' }), {
      dmRouting: DM_ROUTING.MAIN,
      mainSessionKey: bad,
    });
    assert.equal(t.sessionKey, 'qq-private-2001');
    assert.match(t.reason, /dm-main-missing-key/);
  }
});

test('resolveSessionTarget：不同私聊联系人在 main 模式下落到同一个会话', () => {
  const cfg = { dmRouting: DM_ROUTING.MAIN, mainSessionKey: 'session-main' };
  const a = resolveSessionTarget(dmMsg({ userId: '2001', chatId: 'private:2001' }), cfg);
  const b = resolveSessionTarget(dmMsg({ userId: '3000', chatId: 'private:3000' }), cfg);
  assert.equal(a.sessionKey, b.sessionKey, 'main 模式下必须进同一个会话');
});

test('resolveSessionTarget：群聊永远隔离，不受 dmRouting 影响', () => {
  const cfg = { dmRouting: DM_ROUTING.MAIN, mainSessionKey: 'session-main' };
  const t = resolveSessionTarget(groupMsg({ groupId: '100' }), cfg);
  assert.equal(t.sessionKey, 'qq-group-100');
  assert.equal(t.reason, 'group-isolated');
});

test('resolveSessionTarget：畸形消息与非法 chatId 返回空键', () => {
  for (const bad of [null, undefined, 'x', 42]) {
    assert.equal(resolveSessionTarget(bad, {}).sessionKey, '');
  }
  assert.equal(resolveSessionTarget({ kind: 'private', chatId: 'bogus' }, {}).sessionKey, '');
  assert.equal(resolveSessionTarget({ kind: 'private', chatId: 'private:abc' }, {}).sessionKey, '');
});

test('resolveSessionTarget：默认参数不炸', () => {
  const t = resolveSessionTarget(dmMsg({ userId: '2001' }));
  assert.equal(t.sessionKey, 'qq-private-2001');
});
