/**
 * 「重载后自动重连」（2026-10-29）—— 判定、文案，以及**真的跑一遍页面**。
 *
 * ## 这一组在钉什么
 *
 * 病根：点「重载插件」⇒ 插件重载 ⇒ 页面背后的临时 HTTP 服务跟着消失 ⇒ 页面成了空壳。
 * 修法分两半：源侧改成「固定端口 + 令牌跨重载复用」（同 origin 能接回来），前端这边
 * 断开后轮询把页面接回去。**只有两边都在，页面才不会变空壳。**
 *
 * 三层：
 *
 * 1. **纯判定**（`web/logic.mjs`）：`isDisconnectError` 认哪些失败、`reconnectPollDelay`
 *    等多久、`reconnectNotice` 说什么。这层不碰 DOM，直接钉；
 * 2. **整页行为**：用假 React + 假定时器 + 假 fetch 跑**真的** `web/app.js`，验
 *    "请求失败 ⇒ 覆盖层 ⇒ 每 1.5 秒重试 ⇒ 回来后用新数据重渲染、草稿还在、一个写请求
 *    都不发"；
 * 3. **放弃与重试**：等满 30 秒后停止轮询、给「再试一次」，点它之后能重新连上。
 *
 * ## 定时器为什么要假
 *
 * 重连是"等 + 重试"，真等 30 秒的测试没人愿意跑第二遍。这里的 `window.setTimeout`
 * 换成一个**由测试推进的队列**：`timers.advance(1500)` 就等价于"过了 1.5 秒"，
 * 而且记录着虚拟时钟，能精确验证"点完重载后第一轮是在 2 秒而不是 1.5 秒"。
 *
 * 局限：它不验样式、不验真实浏览器的网络栈，也不验 HMR 真的把服务带走 —— 那几条
 * 只能靠人点一次重载。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECONNECT_INTERVAL_MS,
  RECONNECT_MAX_WAIT_MS,
  RECONNECT_RELOAD_GRACE_MS,
  dirtyEntriesDump,
  isDisconnectError,
  reconnectNotice,
  reconnectPollDelay,
  reconnectRecoveredText,
  reconnectWaitedSeconds,
} from '../web/logic.mjs';
import { CONFIG_FIELDS } from '../src/dsh/config-fields.mjs';

// ---------------------------------------------------------------- 极简 React

function flatten(child, out) {
  if (child === null || child === undefined || child === true || child === false) return;
  if (Array.isArray(child)) {
    for (const item of child) flatten(item, out);
    return;
  }
  out.push(child);
}

/** `React.createElement` 的替身：只保留 type / props / children。 */
function h(type, props, ...children) {
  const flat = [];
  for (const child of children) flatten(child, flat);
  return { type, props: props === null || props === undefined ? {} : props, children: flat };
}

/** 造一个"够跑这个组件"的 React：useState / useEffect / useCallback。 */
function makeFakeReact() {
  const rt = { slots: [], cursor: 0, dirty: false, effects: [], seenEffects: new Set() };
  const React = {
    useState(initial) {
      const at = rt.cursor;
      rt.cursor += 1;
      if (!(at in rt.slots)) {
        rt.slots[at] = typeof initial === 'function' ? initial() : initial;
      }
      const set = (next) => {
        const value = typeof next === 'function' ? next(rt.slots[at]) : next;
        if (!Object.is(value, rt.slots[at])) {
          rt.slots[at] = value;
          rt.dirty = true;
        }
      };
      return [rt.slots[at], set];
    },
    useEffect(fn) {
      const at = rt.cursor;
      rt.cursor += 1;
      rt.effects.push({ at, fn });
    },
    useCallback(fn) {
      const at = rt.cursor;
      rt.cursor += 1;
      if (!(at in rt.slots)) rt.slots[at] = fn;
      return rt.slots[at];
    },
  };
  React.createElement = h;
  return { React, rt };
}

// ---------------------------------------------------------------- 页面树工具

function nodeText(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (node !== null && typeof node === 'object' && Array.isArray(node.children)) {
    return node.children.map(nodeText).join('');
  }
  return '';
}

function findAll(node, pred, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  for (const child of node.children || []) findAll(child, pred, out);
  return out;
}

function findButton(tree, label) {
  return findAll(tree, (node) => node.type === 'button' && nodeText(node).trim() === label)[0] ?? null;
}

function findButtonContaining(tree, text) {
  return findAll(tree, (node) => node.type === 'button' && nodeText(node).includes(text))[0] ?? null;
}

function hasClass(node, name) {
  return node && node.props && String(node.props.className || '').split(' ').includes(name);
}

function fieldControl(tree, label, key) {
  const rows = findAll(tree, (node) => hasClass(node, 'field-row'));
  for (const row of rows) {
    const labelHit = findAll(row, (node) => hasClass(node, 'field-label'))
      .some((node) => nodeText(node).trim() === label);
    if (!labelHit) continue;
    if (key !== undefined && !findAll(row, (node) => hasClass(node, 'field-key'))
      .some((node) => nodeText(node).trim() === key)) continue;
    const control = findAll(
      row,
      (node) => node.type === 'textarea' || (node.type === 'input' && hasClass(node, 'input')),
    )[0];
    if (control !== undefined) return control;
  }
  return null;
}

// ---------------------------------------------------------------- 假定时器

/**
 * 由测试推进的定时器队列。
 *
 * `advance(ms)` 按到期顺序跑回调，并把虚拟时钟走到每个回调**自己那一刻**：
 * 回调里再 `setTimeout` 时看到的 `now` 才是对的。
 * `setInterval` 一律返回一个永不触发的 id（心跳在测试里不该自己跑起来）。
 */
function makeTimers() {
  const queue = [];
  let seq = 0;
  const timers = {
    now: 0,
    pending: () => queue.length,
    setTimeout(fn, ms) {
      seq += 1;
      const id = seq;
      queue.push({ id, at: timers.now + (Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) {
      const at = queue.findIndex((timer) => timer.id === id);
      if (at >= 0) queue.splice(at, 1);
    },
    setInterval() {
      seq += 1;
      return seq;
    },
    clearInterval() {},
    advance(ms) {
      const target = timers.now + ms;
      for (;;) {
        queue.sort((left, right) => left.at - right.at);
        const due = queue[0];
        if (due === undefined || due.at > target) break;
        queue.shift();
        timers.now = due.at;
        due.fn();
      }
      timers.now = target;
    },
  };
  return timers;
}

// ---------------------------------------------------------------- 假服务

function makePayload() {
  const fieldOf = (key, scope, value, effective = value) => {
    const base = CONFIG_FIELDS.find((item) => item.key === key);
    if (base === undefined) throw new Error(`CONFIG_FIELDS 里没有 ${key}`);
    return { ...base, scope, value, effective };
  };
  const globals = [
    fieldOf('persona', 'global', '全局人格'),
    fieldOf('reply_style', 'global', '全局风格'),
    fieldOf('emotion_style', 'global', '全局情绪'),
    // 这一项刻意让 `effective` 与 `value` 不同 ⇒ 首屏会挂一条「未生效（重载后生效）」。
    // 重连成功时换成"一致的新数据"，用来验红字是**重算**掉的、不是写死清空的。
    fieldOf('interest', 'global', '新兴趣', '旧兴趣'),
    fieldOf('rules', 'global', '全局规矩'),
    fieldOf('admins', 'global', ['30000001']),
    fieldOf('free_time.enabled', 'global', false),
    fieldOf('proactive.judge_mode', 'global', 'heuristic'),
  ];
  const groupFields = ['persona', 'reply_style', 'emotion_style', 'interest', 'rules']
    .map((key) => fieldOf(key, 'group:30000013', null));
  return {
    ok: true,
    tomlPath: '<tmp>/qq-gugu.toml',
    file: {},
    effective: {},
    owner: { admins: ['30000001'], source: 'owner' },
    scopes: [
      { id: 'global', kind: 'global', name: '全局', idText: '基准值', overridden: [] },
      {
        id: 'group:30000013',
        kind: 'group',
        name: '示例群',
        idText: 'QQ群30000013',
        overridden: ['rules'],
      },
    ],
    fields: [...globals, ...groupFields],
  };
}

/**
 * 起一套"页面 + 假服务 + 假定时器"。
 *
 * `control` 由测试改：
 * - `settingsDown`：`/settings` 直接抛（连接被拒 —— 插件重载后就是这个形状）；
 * - `settingsHtml502`：`/settings` 回 502 + 非 JSON 正文（网关换了后端的情形）。
 */
async function mountPage() {
  const store = makePayload();
  const timers = makeTimers();
  // 把窗口上的定时器转发到这一套推进器（见 `activeTimers` 的说明）。
  activeTimers.current = timers;
  const requests = [];
  const control = { settingsDown: false, settingsHtml502: false, heartbeatDown: false };

  const ok = (payload, status = 200) => ({
    ok: true,
    status,
    json: async () => structuredClone(payload),
  });

  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    requests.push({
      url: path,
      method,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      at: timers.now,
    });
    if (path.endsWith('/heartbeat')) {
      if (control.heartbeatDown) throw new TypeError('Failed to fetch');
      return ok({ state: 'running', port: 40211, ok: true });
    }
    if (path.endsWith('/settings')) {
      if (control.settingsDown) throw new TypeError('Failed to fetch');
      if (control.settingsHtml502) {
        return {
          ok: false,
          status: 502,
          json: async () => { throw new SyntaxError('Unexpected token <'); },
        };
      }
      return ok(store);
    }
    if (path.endsWith('/config') && method === 'POST') {
      throw new Error('重连测试不该发写请求');
    }
    if (path.endsWith('/reload') && method === 'POST') {
      return ok({ ok: true, triggered: true });
    }
    throw new Error(`假服务没实现 ${method} ${path}`);
  };

  const { React, rt } = makeFakeReact();
  const logic = await import('../web/logic.mjs');
  const { createApp } = await import('../web/app.js');
  const App = createApp({ h, logic, React });

  const render = () => {
    rt.cursor = 0;
    rt.effects = [];
    rt.dirty = false;
    const tree = App();
    for (const { at, fn } of rt.effects) {
      if (rt.seenEffects.has(at)) continue;
      rt.seenEffects.add(at);
      try {
        fn();
      } catch (error) {
        // 组件里的 effect 与页面里一样：不许把异常丢回调用方。
        throw new Error(`effect 抛了：${error && error.message}`);
      }
    }
    return tree;
  };

  /** 渲染到稳定：先让微任务（假 fetch 的 promise 链）跑完，再看状态有没有动。 */
  const settle = async () => {
    let tree = render();
    for (let round = 0; round < 40; round += 1) {
      // 两轮宏任务：`api()` 里 fetch → json() 至少要跨几层微任务。
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      // ⚠️ 这里**不能**清 `rt.dirty`：要清的时机在 `render()` 里。清在这里会把
      // "渲染前那一刻刚发生的状态变化"抹掉，于是返回一棵用旧状态画出来的树。
      if (!rt.dirty) return tree;
      tree = render();
    }
    throw new Error('渲染一直不收敛（状态每轮都在变）');
  };

  const act = async (fn) => {
    fn();
    return settle();
  };

  /** 推进虚拟时间再渲染到稳定 —— 等价于"过了 ms 毫秒，界面该做的都做了"。 */
  const tick = async (ms) => {
    timers.advance(ms);
    return settle();
  };

  /**
   * 连续推进 `steps` 个 1.5 秒。
   *
   * 为什么不能一次 `advance(30000)`：心跳/轮询是**串**起来的 —— 上一个请求失败之后
   * 才排下一个定时器，而"失败"发生在 `advance` 返回之后的微任务里。所以一次 advance
   * 只能推完一轮，必须一轮一轮地来。
   */
  const pump = async (steps, stepMs = RECONNECT_INTERVAL_MS) => {
    let tree = null;
    for (let i = 0; i < steps; i += 1) tree = await tick(stepMs);
    return tree;
  };

  const tree = await settle();
  return { store, requests, timers, control, rt, settle, tick, pump, act, tree: () => tree };
}

function settingsRequests(requests) {
  return requests.filter((item) => item.method === 'GET' && item.url.endsWith('/settings'));
}

function configWrites(requests) {
  return requests.filter((item) => item.method === 'POST' && item.url.endsWith('/config'));
}

function overlayText(tree) {
  const layers = findAll(tree, (node) => hasClass(node, 'reconnect-overlay'));
  assert.equal(layers.length, 1, `覆盖层应恰好 1 层，实际 ${layers.length}`);
  return nodeText(layers[0]);
}

// 全局替身：收尾时还原（run-all-tests 是单进程串行 import，别把假 window 留给后面的文件）。
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  fetch: globalThis.fetch,
};
const noop = () => {};
/**
 * `web/app.js` 在**模块加载时**就读 `window.location.search` 取令牌，所以 window 必须
 * 在 import 之前就在。
 *
 * 定时器是"转发"的：`window.setTimeout` 落到 `activeTimers.current` 上，而每个
 * `mountPage` 会把自己那套推进器换成当前这套。测试是串行跑的，同一时刻只有一个页面在
 * 等定时器，因此这样够用 —— 而且这正是**必须**的做法：一次 import 只绑定一份 window，
 * 若在这里写死一个队列，页面等的定时器就不会被测试的 `advance` 推到了。
 */
const activeTimers = { current: makeTimers() };
globalThis.window = {
  location: { search: '' },
  addEventListener: noop,
  removeEventListener: noop,
  setTimeout: (fn, ms) => activeTimers.current.setTimeout(fn, ms),
  clearTimeout: (id) => activeTimers.current.clearTimeout(id),
  setInterval: () => 0,
  clearInterval: noop,
  focus: noop,
};
globalThis.document = {
  hidden: false,
  getElementById: () => null,
  addEventListener: noop,
  removeEventListener: noop,
};

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  globalThis.fetch = originals.fetch;
});

// ---------------------------------------------------------------- ① 判定

test('① 什么算"服务不在了"：网络错误 / 非 JSON / 5xx 算，4xx 不算', () => {
  const network = new Error('Failed to fetch');
  network.network = true;
  assert.equal(isDisconnectError(network), true, '连接被拒 = 服务跟着插件没了');

  const notJson = new Error('服务返回的不是 JSON');
  notJson.status = 200;
  notJson.notJson = true;
  assert.equal(isDisconnectError(notJson), true, '2xx 却不是 JSON（路由没挂上）也算断开');

  assert.equal(isDisconnectError({ status: 502 }), true);
  assert.equal(isDisconnectError({ status: 500 }), true);
  assert.equal(isDisconnectError({ status: 503 }), true);

  // 4xx 是**活着的服务**在拒绝这个请求：TOML 校验失败、需要 confirm、键不在白名单。
  // 把它当成断开，就会因为填错一个数字而整页被盖住 30 秒，而该看的那行错误看不见。
  assert.equal(isDisconnectError({ status: 400 }), false);
  assert.equal(isDisconnectError({ status: 404 }), false);
  assert.equal(isDisconnectError({ status: 409 }), false);

  assert.equal(isDisconnectError(null), false);
  assert.equal(isDisconnectError(undefined), false);
  assert.equal(isDisconnectError(new Error('随便什么')), false, '没标记的普通错误不猜');
  assert.equal(isDisconnectError('boom'), false);
});

test('① 轮询参数：间隔 1.5 秒、最多 30 秒、点重载后首轮先等 2 秒', () => {
  assert.equal(RECONNECT_INTERVAL_MS, 1500);
  assert.equal(RECONNECT_MAX_WAIT_MS, 30000);
  assert.equal(RECONNECT_RELOAD_GRACE_MS, 2000);

  assert.equal(reconnectPollDelay(0), 1500, '首轮也是 1.5 秒（没有宽限期时）');
  assert.equal(reconnectPollDelay(0, RECONNECT_RELOAD_GRACE_MS), 2000, '点完重载先等宽限期');
  assert.equal(reconnectPollDelay(1, RECONNECT_RELOAD_GRACE_MS), 1500, '宽限期只作用于第一轮');
  assert.equal(reconnectPollDelay(7), 1500);
  // 非法输入按 0 次处理：宁可多试一次，也不要算出 NaN 毫秒而卡住。
  assert.equal(reconnectPollDelay(undefined), 1500);
  assert.equal(reconnectPollDelay(Number.NaN), 1500);
  assert.equal(reconnectPollDelay(0, -5), 1500);
});

test('① 30 秒预算：按累计等待算，正好 20 轮后停下，且不超预算', () => {
  // 这段循环与 `app.js` 的 `runReconnect` 同一口径：预算按"已等毫秒"扣，不按次数。
  const simulate = (graceMs) => {
    let waitedMs = 0;
    let attempt = 0;
    while (RECONNECT_MAX_WAIT_MS - waitedMs > 0) {
      const delay = Math.min(reconnectPollDelay(attempt, graceMs), RECONNECT_MAX_WAIT_MS - waitedMs);
      waitedMs += delay;
      attempt += 1;
    }
    return { waitedMs, attempt };
  };
  const withGrace = simulate(RECONNECT_RELOAD_GRACE_MS);
  assert.equal(withGrace.waitedMs, 30000, '墙上的时间正好 30 秒，不多不少');
  assert.equal(withGrace.attempt, 20, '2 秒宽限 + 18 次 1.5 秒 + 最后 1 次补满 = 20 轮');

  const noGrace = simulate(0);
  assert.equal(noGrace.waitedMs, 30000);
  assert.equal(noGrace.attempt, 20, '1.5×20 = 30 秒');
});

test('① 已等待秒数向下取整（不四舍五入，宁可少说一秒）', () => {
  assert.equal(reconnectWaitedSeconds(0), 0);
  assert.equal(reconnectWaitedSeconds(999), 0);
  assert.equal(reconnectWaitedSeconds(1500), 1);
  assert.equal(reconnectWaitedSeconds(2900), 2);
  assert.equal(reconnectWaitedSeconds(30000), 30);
  assert.equal(reconnectWaitedSeconds(-1), 0);
  assert.equal(reconnectWaitedSeconds('x'), 0);
});

// ---------------------------------------------------------------- ② 文案

test('② 等待中的提示：说清"在等"、已等几秒、多久试一次、草稿还在', () => {
  assert.equal(reconnectNotice({ phase: 'idle' }).visible, false);
  assert.equal(reconnectNotice(null).visible, false);
  assert.equal(reconnectNotice({ phase: 'idle', waitedMs: 9999 }).visible, false);

  const notice = reconnectNotice({ phase: 'waiting', waitedMs: 3200, dirtyCount: 2 });
  assert.equal(notice.visible, true);
  assert.equal(notice.retry, false);
  assert.equal(notice.waitedText, '3 秒');
  assert.match(notice.title, /插件正在重载/);
  assert.match(notice.detail, /已等待 3 秒/);
  assert.match(notice.detail, /1\.5 秒重试一次/);
  assert.match(notice.detail, /最多等 30 秒/);
  // 草稿这一句是硬要求：不写，用户会以为断开时那批改动已经丢了。
  assert.match(notice.detail, /2 处改动还在/);
  assert.match(notice.detail, /不会写文件/);

  const clean = reconnectNotice({ phase: 'waiting', waitedMs: 0, dirtyCount: 0 });
  assert.match(clean.detail, /已等待 0 秒/);
  assert.doesNotMatch(clean.detail, /处改动还在/);
});

test('② 放弃时的提示：改口"去 DSH 看一眼"并给「再试一次」', () => {
  const notice = reconnectNotice({ phase: 'gaveUp', waitedMs: RECONNECT_MAX_WAIT_MS, dirtyCount: 1 });
  assert.equal(notice.visible, true);
  assert.equal(notice.retry, true);
  assert.match(notice.title, /没回来/);
  assert.match(notice.title, /DSH/);
  assert.match(notice.detail, /30 秒/);
  assert.match(notice.detail, /再试一次/);
  // 2026-10-29：源侧改成固定端口 + 令牌跨重载复用之后，"回不去"这个前提没了 ——
  // 30 秒还不回来 = 插件真没起来 / 端口被占。文案必须指向这两个真实原因，
  // 并说明「再试一次」是**有意义**的（地址没变，服务一回来就接得上）。
  assert.match(notice.detail, /2~3 秒/);
  assert.match(notice.detail, /端口/);
  assert.match(notice.detail, /地址没变/);
  assert.doesNotMatch(notice.detail, /新端口/);
  assert.doesNotMatch(notice.detail, /一次性令牌/);
  // 草稿只在本页：重开就读不到 ⇒ 提示先抄下来（否则那批改动必然丢）。
  assert.match(notice.detail, /1 处改动只在这个页面里/);
  assert.match(notice.detail, /复制改动/);

  const clean = reconnectNotice({ phase: 'gaveUp', waitedMs: RECONNECT_MAX_WAIT_MS, dirtyCount: 0 });
  assert.doesNotMatch(clean.detail, /只在这个页面里/);
});

test('② 未保存改动能导成纯文本（重开页面之后照着填回去）', async () => {
  const labels = { global: '全局', 'group:30000013': '群 示例群' };
  const dump = dirtyEntriesDump([
    { scope: 'global', key: 'persona', label: '角色设定', value: '重载前改的人格' },
    { scope: 'group:30000013', key: 'rules', label: '行为规则', value: '群规' },
    { scope: 'global', key: 'admins', label: '用户 QQ', value: ['30000001', '900'] },
    { scope: 'global', key: 'free_time.enabled', label: '定时任务开关', value: true },
    { scope: 'global', key: 'interest', label: '兴趣', value: '' },
  ], labels);
  assert.match(dump, /还有 5 处没保存的改动/);
  assert.match(dump, /【全局 · 角色设定】persona\n重载前改的人格/);
  assert.match(dump, /【群 示例群 · 行为规则】rules\n群规/);
  assert.match(dump, /30000001, 900/, '数组按逗号连起来，不要 [object Object]');
  assert.match(dump, /\n开$|\n开\n/, '布尔写成"开"');
  assert.match(dump, /（空）/, '清空也是一处改动，不能省成空白');
  assert.equal(dirtyEntriesDump([], labels), '');
  assert.equal(dirtyEntriesDump(null, labels), '');
});

test('② 重连成功的提示必须点出"还有 N 处没保存"', () => {
  assert.equal(reconnectRecoveredText(0), '已重新连上插件（配置已重新读取）。');
  assert.match(reconnectRecoveredText(3), /还有 3 处改动没保存/);
  assert.match(reconnectRecoveredText(3), /保存全部/);
  assert.match(reconnectRecoveredText('2'), /还有 2 处改动没保存/);
  assert.equal(reconnectRecoveredText(Number.NaN), '已重新连上插件（配置已重新读取）。');
});

// ---------------------------------------------------------------- ③ 整页：断开

test('★ 断开 ⇒ 整页盖一层提示，每 1.5 秒重试，回来后用新数据重渲染且草稿还在', async () => {
  const page = await mountPage();
  let tree = page.tree();

  // ① 首屏：`interest` 的 value 与 effective 不一致 ⇒ 挂着「未生效（重载后生效）」
  assert.match(
    findAll(tree, (node) => hasClass(node, 'field-error')).map(nodeText).join(' | '),
    /未生效（重载后生效）/,
    '首屏应有一条未生效标记（这是重连后要"用真实数据重算掉"的东西）',
  );
  assert.equal(findAll(tree, (node) => hasClass(node, 'reconnect-overlay')).length, 0, '正常情况下没有覆盖层');

  // ② 先改一处，制造一份"重载前没保存的草稿"
  const personality = fieldControl(tree, '角色设定', 'persona');
  assert.ok(personality !== null, '找不到人格输入框');
  tree = await page.act(() => { personality.props.onChange({ target: { value: '重载前改的人格' } }); });
  assert.equal(nodeText(findButtonContaining(tree, '保存全部')).trim(), '保存全部（1 处改动）');

  // ③ 服务没了（等价于插件正在重载），下一次请求就会撞上
  page.control.settingsDown = true;
  tree = await page.act(() => { findButton(tree, '重新读取').props.onClick(); });
  const before = settingsRequests(page.requests).length;

  // ④ 覆盖层出现：不是弹窗、不是 alert，写着"插件正在重载"与已等待秒数
  const waiting = overlayText(tree);
  assert.match(waiting, /插件正在重载，等它回来/);
  assert.match(waiting, /已等待 0 秒/);
  assert.match(waiting, /最多等 30 秒/);
  assert.match(waiting, /1 处改动还在/, '覆盖层要说明草稿没丢');
  assert.equal(findAll(tree, (node) => hasClass(node, 'banner')).length, 0, '重连期间不再重复报"读取配置失败"');

  // ⑤ 重连期间不许保存：按钮禁用（覆盖层也挡住了它）
  assert.equal(findButtonContaining(tree, '保存全部').props.disabled, true);
  assert.equal(findButton(tree, '重载插件').props.disabled, true);

  // ⑥ 每 1.5 秒试一次：推进时间，看到请求变多、秒数变大
  tree = await page.tick(RECONNECT_INTERVAL_MS);
  assert.equal(settingsRequests(page.requests).length, before + 1, '每 1.5 秒重试一次');
  assert.match(overlayText(tree), /已等待 1 秒/);

  tree = await page.tick(RECONNECT_INTERVAL_MS);
  assert.equal(settingsRequests(page.requests).length, before + 2);
  assert.match(overlayText(tree), /已等待 3 秒/);

  // ⑦ 插件回来了：新数据里 `interest` 的 effective 已经追上 value（红字该自己消失），
  //    人格也换成了重载后读到的值（value 与 effective 一致 —— 重载后本该如此）。
  const interest = page.store.fields.find((field) => field.key === 'interest' && field.scope === 'global');
  interest.effective = interest.value;
  const personalityField = page.store.fields.find(
    (field) => field.key === 'persona' && field.scope === 'global',
  );
  personalityField.value = '重载后的人格';
  personalityField.effective = '重载后的人格';
  page.control.settingsDown = false;
  tree = await page.tick(RECONNECT_INTERVAL_MS);

  assert.equal(findAll(tree, (node) => hasClass(node, 'reconnect-overlay')).length, 0, '连上后覆盖层消失');
  assert.equal(settingsRequests(page.requests).length, before + 3);
  assert.doesNotMatch(
    findAll(tree, (node) => hasClass(node, 'field-error')).map(nodeText).join(' | '),
    /未生效/,
    '红字必须由新数据重算掉，而不是"清空"',
  );

  // ⑧ 草稿没被吃掉：处数还是 1，控件里仍是重载前输入的值，保存按钮重新可用
  assert.equal(
    nodeText(findButtonContaining(tree, '保存全部')).trim(),
    '保存全部（1 处改动）',
    '重连不许把重载前的草稿丢掉',
  );
  assert.equal(fieldControl(tree, '角色设定', 'persona').props.value, '重载前改的人格');
  assert.equal(findButtonContaining(tree, '保存全部').props.disabled, false);
  assert.match(nodeText(tree), /还有 1 处改动没保存/, '连上之后要明确说出还剩几处没保存');

  // ⑨ 全程一条写请求都没发（重连期间只读）
  assert.equal(configWrites(page.requests).length, 0, '重连期间绝不写文件');
  // 重连期间的请求也只该是 GET /settings 与心跳（心跳是页面原来的节律，不是重连发的）
  for (const item of page.requests) {
    assert.ok(
      item.url.endsWith('/settings') || item.url.endsWith('/heartbeat') || item.url.endsWith('/reload'),
      `意外的请求：${item.method} ${item.url}`,
    );
  }
});

test('★ 502 + 非 JSON 也算断开（网关把后端换掉了）', async () => {
  const page = await mountPage();
  page.control.settingsHtml502 = true;
  const tree = await page.act(() => { findButton(page.tree(), '重新读取').props.onClick(); });
  assert.match(overlayText(tree), /插件正在重载/);
  assert.equal(configWrites(page.requests).length, 0);
});

// ---------------------------------------------------------------- ④ 放弃与重试

test('★ 等满 30 秒还没回来 ⇒ 停止轮询、改口"去 DSH 看一眼"、给「再试一次」', async () => {
  const page = await mountPage();
  let tree = page.tree();
  // 先留一处没保存的改动：放弃之后它必须能被导出成文本（重开页面会读不到它）。
  const personality = fieldControl(tree, '角色设定', 'persona');
  tree = await page.act(() => { personality.props.onChange({ target: { value: '重开前要抄下来的改动' } }); });

  page.control.settingsDown = true;
  tree = await page.act(() => { findButton(tree, '重新读取').props.onClick(); });
  assert.match(overlayText(tree), /插件正在重载/);

  // 一次推进 30 秒（20 轮"1.5 秒"，每轮之间让状态落地），等价于真的等了半分钟。
  tree = await page.pump(22);
  const gaveUp = overlayText(tree);
  assert.match(gaveUp, /插件好像没回来/, '超时后要改口让人去 DSH 看一眼');
  assert.match(gaveUp, /DSH/);
  assert.match(gaveUp, /30 秒/);
  assert.match(gaveUp, /重开配置页就读不到了/, '要提醒草稿只在这个页面里');
  assert.equal(findButton(tree, '再试一次') !== null, true, '超时后必须给一个重试入口');

  // ⑥ 已经停了：再推进时间，请求数一个都不涨
  const stopped = settingsRequests(page.requests).length;
  tree = await page.tick(RECONNECT_INTERVAL_MS);
  tree = await page.tick(RECONNECT_INTERVAL_MS);
  assert.equal(settingsRequests(page.requests).length, stopped, '放弃之后不许继续轮询');
  assert.match(overlayText(tree), /插件好像没回来/, '放弃的提示要一直留着，别闪一下就回去');

  // ⑥.5 "放弃"必须**粘住**：心跳每 5 秒失败一次、每失败一次都想再开一轮，
  //      要是不挡住，界面会在"放弃了"和"又在等"之间来回翻，「再试一次」永远看不见。
  //      这里用「重新读取」模拟"又一发请求失败"（它走同一条 `isDisconnectError` 分支）。
  const afterGiveUp = settingsRequests(page.requests).length;
  tree = await page.act(() => { findButton(tree, '重新读取').props.onClick(); });
  assert.match(overlayText(tree), /插件好像没回来/, '放弃之后再来一次失败，不许把覆盖层翻回"正在重载"');
  tree = await page.tick(RECONNECT_INTERVAL_MS);
  assert.equal(
    settingsRequests(page.requests).length,
    afterGiveUp + 1,
    '只有那一次手动读取，重连轮询不许自己重开',
  );

  // ⑦ 放弃态下可以把改动导出来（重开页面读不到旧 origin 的任何存储 ⇒ 这是唯一救法）。
  //    测试环境没有 navigator.clipboard ⇒ 走"摊在输入框里自己全选"的兜底。
  const copy = findButton(tree, '复制改动');
  assert.ok(copy !== null, '有未保存改动时，放弃态必须给「复制改动」');
  tree = await page.act(() => { copy.props.onClick(); });
  const dumpBox = findAll(
    tree,
    (node) => node.type === 'textarea' && node.props.readOnly === true,
  )[0];
  assert.ok(dumpBox !== undefined, '剪贴板写不进去时要摊开文本让人手工复制');
  assert.match(dumpBox.props.value, /重开前要抄下来的改动/);
  assert.match(dumpBox.props.value, /角色设定/);

  // ⑧ 点「再试一次」：插件这时回来了 ⇒ 重新连上
  page.control.settingsDown = false;
  tree = await page.act(() => { findButton(tree, '再试一次').props.onClick(); });
  tree = await page.tick(RECONNECT_INTERVAL_MS);
  assert.equal(findAll(tree, (node) => hasClass(node, 'reconnect-overlay')).length, 0, '再试一次要能真的连上');
  assert.match(nodeText(tree), /已重新连上插件/);
  assert.equal(nodeText(findButtonContaining(tree, '保存全部')).trim(), '保存全部（1 处改动）', '草稿必须还在');
  assert.equal(configWrites(page.requests).length, 0);
});

// ---------------------------------------------------------------- ⑤ 点重载之后

test('★ 点「重载插件」并确认 ⇒ 马上盖提示，2 秒后才开始轮询', async () => {
  const page = await mountPage();
  let tree = page.tree();
  tree = await page.act(() => { findButton(tree, '重载插件').props.onClick(); });
  assert.equal(findAll(tree, (node) => hasClass(node, 'confirm')).length, 1, '重载前要就地确认');
  const before = settingsRequests(page.requests).length;

  tree = await page.act(() => { findButton(tree, '确定').props.onClick(); });
  // 覆盖层立刻出现：不等"真的断开"再反应，那几秒界面看着好好的、其实背后已经没人了。
  assert.match(overlayText(tree), /插件正在重载/);
  assert.match(overlayText(tree), /已等待 0 秒/);
  assert.equal(settingsRequests(page.requests).length, before, '刚触发重载时不该立刻去打 /settings');

  // 服务这时才真的没了（等价于插件重载把临时服务带走）
  page.control.settingsDown = true;

  // 1.5 秒：还没到宽限期 ⇒ 一次都不打
  tree = await page.tick(RECONNECT_INTERVAL_MS);
  assert.equal(settingsRequests(page.requests).length, before, '宽限期没到，不该轮询');

  // 再 0.5 秒（累计 2 秒）：第一轮才发出
  tree = await page.tick(RECONNECT_RELOAD_GRACE_MS - RECONNECT_INTERVAL_MS);
  assert.equal(settingsRequests(page.requests).length, before + 1, '宽限期一到就开始轮询');
  const first = settingsRequests(page.requests)[before];
  assert.equal(first.at, RECONNECT_RELOAD_GRACE_MS, '首轮发生在第 2 秒');
  assert.match(overlayText(tree), /已等待 2 秒/);

  // 之后恢复正常节律，插件回来 ⇒ 自动接上
  page.control.settingsDown = false;
  tree = await page.tick(RECONNECT_INTERVAL_MS);
  assert.equal(findAll(tree, (node) => hasClass(node, 'reconnect-overlay')).length, 0);
  assert.match(nodeText(tree), /已重新连上插件/);
  assert.equal(configWrites(page.requests).length, 0, '重连期间不写文件、不自动保存');
});
