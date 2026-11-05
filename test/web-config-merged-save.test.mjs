/**
 * 「保存全部」的整页行为（2026-10-28）—— 在假 React 上跑**真的** `web/app.js`。
 *
 * ## 为什么要有这一层
 *
 * `test/web-config-save-all.test.mjs` 钉的是收集条目的纯逻辑（`web/logic.mjs`）。
 * 但这次的病根在**页面本身**：以前每张卡片各有自己的保存按钮，改了三个地方只点
 * 一两个，剩下的改动根本没写进文件。所以必须验证「点一下底部的保存全部，两次
 * 改动都发出去了」这件事，而不是只验证某个函数算得对不对。
 *
 * 浏览器打不开（配置页由宿主临时服务带着令牌送出，测试里拿不到），因此这里用
 * 一个**极简的 React 替身**跑真组件：
 *
 * - `h` 造普通对象，`useState` 用一份跨渲染保留的槽位数组，`useEffect` 只跑首轮；
 * - `fetch` 换成假的：GET `/settings` 回一份现造的载荷，POST `/config` 记下请求
 *   并把值写回那份载荷（因此"保存后草稿清掉、条上回到 0 处"也被验到）。
 *
 * 它不验证样式、布局与真实浏览器里的交互细节 —— 那部分只能靠人打开页面看。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

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
  const rt = {
    slots: [],
    cursor: 0,
    dirty: false,
    effects: [],
    seenEffects: new Set(),
  };
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

/** 按按钮上的文字找按钮（整段文字精确匹配）。 */
function findButton(tree, label) {
  return findAll(
    tree,
    (node) => node.type === 'button' && nodeText(node).trim() === label,
  )[0] ?? null;
}

/** 按按钮文字里的片段找按钮（用于「保存全部（2 处改动）」这种带数字的）。 */
function findButtonContaining(tree, text) {
  return findAll(
    tree,
    (node) => node.type === 'button' && nodeText(node).includes(text),
  )[0] ?? null;
}

function hasClass(node, name) {
  return node && node.props && String(node.props.className || '').split(' ').includes(name);
}

/** 找某个字段所在的行（按显示名 + key），再取行里的控件。 */
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
      (node) => node.type === 'textarea'
        || (node.type === 'input' && hasClass(node, 'input')),
    )[0];
    if (control !== undefined) return control;
  }
  return null;
}

// ---------------------------------------------------------------- 假服务

/** 造一份 `/settings` 载荷：全局 8 个字段 + 一个群的人格五段。 */
function makePayload() {
  const fieldOf = (key, scope, value) => {
    const base = CONFIG_FIELDS.find((item) => item.key === key);
    if (base === undefined) throw new Error(`CONFIG_FIELDS 里没有 ${key}`);
    return { ...base, scope, value, effective: value };
  };
  const globals = [
    fieldOf('persona', 'global', '全局人格'),
    fieldOf('reply_style', 'global', '全局风格'),
    fieldOf('emotion_style', 'global', '全局情绪'),
    fieldOf('interest', 'global', '全局兴趣'),
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
 * 起一套"页面 + 假服务"，返回渲染好的树、请求记录与操作方法。
 *
 * 每个测试各起一套：`useState` 的槽位、请求记录都不共享，互不串味。
 */
async function mountPage() {
  const store = makePayload();
  const requests = [];

  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method, body });
    if (String(url).endsWith('/heartbeat')) {
      return { ok: true, status: 200, json: async () => ({ state: 'running', port: 1, ok: true }) };
    }
    if (String(url).endsWith('/settings')) {
      // 每次给一份**新的**对象：真服务也是每次都序列化一份，`setRemote` 才会重渲染。
      return { ok: true, status: 200, json: async () => structuredClone(store) };
    }
    if (String(url).endsWith('/config') && method === 'POST') {
      const field = store.fields.find(
        (item) => item.scope === body.scope && item.key === body.key,
      );
      if (field !== undefined) {
        field.value = body.value;
        field.effective = body.value;
      }
      if (body.key === 'admins') store.owner.admins = body.value;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          wrote: true,
          backup: 'C:/tmp/qq-gugu.toml.bak-1',
          restartNeeded: true,
          key: body.key,
          scope: body.scope,
        }),
      };
    }
    throw new Error(`假服务没实现 ${method} ${String(url)}`);
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
      fn();
    }
    return tree;
  };

  /** 渲染到稳定（假服务的 promise 落地、状态设完为止）。 */
  const settle = async () => {
    let tree = render();
    for (let round = 0; round < 30; round += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      if (!rt.dirty) return tree;
      tree = render();
    }
    throw new Error('渲染一直不收敛（状态每轮都在变）');
  };

  /** 跑一个交互（点击 / 输入），再渲染到稳定。 */
  const act = async (fn) => {
    fn();
    return settle();
  };

  const tree = await settle();
  return {
    store,
    requests,
    settle,
    act,
    tree: () => tree,
    // tree 是每次 settle 的结果；调用方用 `page.act(...)` 的返回值拿到新树。
  };
}

/** 只取 POST /config 的请求（其余是 GET settings 与心跳）。 */
function configWrites(requests) {
  return requests.filter((item) => item.method === 'POST' && item.url.endsWith('/config'));
}

// 这些全局替身在收尾时还原：run-all-tests 是**单进程串行 import**，
// 留一份假 window / fetch 给后面的测试文件，就是"跨文件互相影响"。
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  fetch: globalThis.fetch,
};
const noop = () => {};
globalThis.window = {
  location: { search: '' },
  addEventListener: noop,
  removeEventListener: noop,
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

// ---------------------------------------------------------------- 一个保存按钮

test('★ 整页只有一个保存按钮，且位置在底部的保存条里', async () => {
  const page = await mountPage();
  const tree = page.tree();

  const saveButtons = findAll(
    tree,
    (node) => node.type === 'button' && /保存/.test(nodeText(node)) && !/恢复/.test(nodeText(node)),
  );
  // 唯一的保存按钮就是底部条里那一个：卡片上不再有「保存」「保存全局」「保存这一段」。
  assert.equal(saveButtons.length, 1, `页面上的保存按钮应只有 1 个，实际 ${saveButtons.length}`);
  assert.equal(nodeText(saveButtons[0]).trim(), '保存全部');

  // 它必须在 `.save-bar` 里（fixed/sticky 定位由样式表负责，测试只认结构）。
  const bars = findAll(tree, (node) => hasClass(node, 'save-bar'));
  assert.equal(bars.length, 1, '底部保存条必须存在且只有一个');
  assert.ok(findAll(bars[0], (node) => node === saveButtons[0]).length === 1, '保存按钮要在保存条里');

  // 没有任何改动时它是禁用的
  assert.equal(saveButtons[0].props.disabled, true, '没有改动时「保存全部」应禁用');
});

test('★ 改了哪几处，按钮上就写几处', async () => {
  const page = await mountPage();
  let tree = page.tree();

  const personality = fieldControl(tree, '角色设定', 'persona');
  assert.ok(personality !== null, '找不到人格输入框');
  tree = await page.act(() => {
    personality.props.onChange({ target: { value: '改过的人格' } });
  });

  const save = findButtonContaining(tree, '保存全部');
  assert.equal(nodeText(save).trim(), '保存全部（1 处改动）');
  assert.equal(save.props.disabled, false, '有改动时必须能点');

  // 摘要说清改在哪儿
  const warn = findAll(tree, (node) => hasClass(node, 'hint-warn')).map(nodeText).join(' | ');
  assert.match(warn, /还有 1 处没保存/);
  assert.match(warn, /全局 · 角色设定/);
});

// ---------------------------------------------------------------- 一次提交所有脏字段

test('★ 一次「保存全部」提交所有脏字段（跨作用域），没改的键一个都不发', async () => {
  const page = await mountPage();
  let tree = page.tree();

  // ① 全局：改人格
  const personality = fieldControl(tree, '角色设定', 'persona');
  tree = await page.act(() => {
    personality.props.onChange({ target: { value: '新人格' } });
  });

  // ② 切到群，改这个群的「行为规则」
  const groupTab = findAll(
    tree,
    (node) => node.type === 'button' && hasClass(node, 'subtab') && nodeText(node).includes('示例群'),
  )[0];
  assert.ok(groupTab !== undefined, '找不到群作用域的标签');
  tree = await page.act(() => { groupTab.props.onClick(); });
  assert.equal(nodeText(findButtonContaining(tree, '保存全部')).trim(), '保存全部（1 处改动）', '切页不该丢草稿');

  const groupRules = fieldControl(tree, '行为规则', 'rules');
  assert.ok(groupRules !== null, '找不到群的行为规则输入框');
  tree = await page.act(() => {
    groupRules.props.onChange({ target: { value: '这个群专用的规矩' } });
  });
  assert.equal(nodeText(findButtonContaining(tree, '保存全部')).trim(), '保存全部（2 处改动）');

  // ③ 切回全局：群那处改动仍然在（草稿不随切页消失）
  const globalTab = findAll(
    tree,
    (node) => node.type === 'button' && hasClass(node, 'subtab') && nodeText(node).includes('基准值'),
  )[0];
  tree = await page.act(() => { globalTab.props.onClick(); });
  assert.equal(nodeText(findButtonContaining(tree, '保存全部')).trim(), '保存全部（2 处改动）');

  // ④ 点保存全部
  const before = configWrites(page.requests).length;
  const save = findButtonContaining(tree, '保存全部');
  tree = await page.act(() => { save.props.onClick(); });

  const writes = configWrites(page.requests).slice(before);
  assert.deepEqual(
    writes.map((item) => `${item.body.scope}/${item.body.key}`),
    ['global/persona', 'group:30000013/rules'],
    '两处改动都要提交，且没有第三条（没改的键不重写）',
  );
  assert.equal(writes[0].body.value, '新人格');
  assert.equal(writes[1].body.value, '这个群专用的规矩');
  // 不带 confirm：这两个不是危险键
  assert.equal(writes.some((item) => item.body.confirm === true), false);

  // ⑤ 写完草稿清掉：条上回到 0 处，按钮禁用，且提示是"已备份"
  const bar = findAll(tree, (node) => hasClass(node, 'save-bar'))[0];
  assert.match(nodeText(bar), /保存全部/);
  assert.doesNotMatch(nodeText(bar), /处改动/);
  assert.match(nodeText(bar), /已备份/);
  assert.equal(findButtonContaining(tree, '保存全部').props.disabled, true);
});

// ---------------------------------------------------------------- 危险键仍然要确认

test('★ 牵涉用户名单（危险键）时先展开确认条，确认后才带 confirm:true 写入', async () => {
  const page = await mountPage();
  let tree = page.tree();

  const admins = findAll(
    tree,
    (node) => node.type === 'input' && String(node.props.placeholder || '').includes('英文逗号'),
  )[0];
  assert.ok(admins !== undefined, '找不到用户名单输入框');
  tree = await page.act(() => {
    admins.props.onChange({ target: { value: '30000001, 900' } });
  });

  const before = configWrites(page.requests).length;
  tree = await page.act(() => { findButtonContaining(tree, '保存全部').props.onClick(); });

  // 点保存不会直接写：先出确认条
  assert.equal(configWrites(page.requests).length, before, '危险键不许不经确认就写');
  const confirm = findAll(tree, (node) => hasClass(node, 'confirm'))[0];
  assert.ok(confirm !== undefined, '没有展开确认条');
  assert.match(nodeText(confirm), /即将写入 1 处/);
  assert.match(nodeText(confirm), /global · admins/);
  assert.match(nodeText(confirm), /用户号码取列表第一个/, '确认条要讲清后果');

  tree = await page.act(() => { findButton(tree, '确认写入').props.onClick(); });

  const writes = configWrites(page.requests).slice(before);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.key, 'admins');
  assert.deepEqual(writes[0].body.value, ['30000001', '900']);
  assert.equal(writes[0].body.confirm, true, '确认过才带 confirm:true');
});

test('取消确认条 ⇒ 一个字节都不写，草稿还在', async () => {
  const page = await mountPage();
  let tree = page.tree();

  const admins = findAll(
    tree,
    (node) => node.type === 'input' && String(node.props.placeholder || '').includes('英文逗号'),
  )[0];
  tree = await page.act(() => { admins.props.onChange({ target: { value: '900' } }); });

  const before = configWrites(page.requests).length;
  tree = await page.act(() => { findButtonContaining(tree, '保存全部').props.onClick(); });
  tree = await page.act(() => { findButton(tree, '取消').props.onClick(); });

  assert.equal(configWrites(page.requests).length, before);
  assert.equal(findAll(tree, (node) => hasClass(node, 'confirm')).length, 0, '确认条收起来了');
  assert.equal(nodeText(findButtonContaining(tree, '保存全部')).trim(), '保存全部（1 处改动）');
});

// ---------------------------------------------------------------- 两页共用草稿

test('★ 「原文件」页与「通道」页共用一份草稿：同一个键只算一处改动、只写一次', async () => {
  const page = await mountPage();
  let tree = page.tree();

  // ① 通道页改人格
  const personality = fieldControl(tree, '角色设定', 'persona');
  tree = await page.act(() => { personality.props.onChange({ target: { value: '新人格' } }); });
  assert.equal(nodeText(findButtonContaining(tree, '保存全部')).trim(), '保存全部（1 处改动）');

  // ② 切到「原文件」页：同一个字段显示的是**同一份草稿**（不是文件旧值）
  tree = await page.act(() => { findButton(tree, '原文件').props.onClick(); });
  const rawPersonality = fieldControl(tree, '角色设定', 'persona');
  assert.ok(rawPersonality !== null, '原文件页应有人格这一项');
  assert.equal(rawPersonality.props.value, '新人格', '两页共用草稿：原文件页也要显示未保存的新值');
  assert.equal(
    nodeText(findButtonContaining(tree, '保存全部')).trim(),
    '保存全部（1 处改动）',
    '同一个键不许被算成两处改动',
  );

  // ③ 在原文件页点保存全部 ⇒ 只发一条（不是"两页各发一条"）
  const before = configWrites(page.requests).length;
  tree = await page.act(() => { findButtonContaining(tree, '保存全部').props.onClick(); });
  const writes = configWrites(page.requests).slice(before);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.key, 'persona');
  assert.equal(writes[0].body.value, '新人格');
});

// ---------------------------------------------------------------- 恢复

test('「恢复」只丢本卡的草稿，别的卡片与保存条各算各的', async () => {
  const page = await mountPage();
  let tree = page.tree();

  const personality = fieldControl(tree, '角色设定', 'persona');
  tree = await page.act(() => { personality.props.onChange({ target: { value: 'A' } }); });
  const interest = fieldControl(tree, '兴趣', 'interest');
  tree = await page.act(() => { interest.props.onChange({ target: { value: 'B' } }); });
  assert.equal(nodeText(findButtonContaining(tree, '保存全部')).trim(), '保存全部（2 处改动）');

  // 人格与兴趣都在「人格卡」里 ⇒ 恢复该卡会把这两处一起丢掉；
  // 其余卡片（身份卡、第二张卡）各有自己的「恢复」，互不牵扯。
  const card = findAll(tree, (node) => hasClass(node, 'card'))
    .find((node) => fieldControl(node, '角色设定', 'persona') !== null);
  assert.ok(card !== undefined, '找不到人格那张卡');
  const restore = findAll(
    card,
    (node) => node.type === 'button' && nodeText(node).trim() === '恢复为文件里的值',
  )[0];
  assert.ok(restore !== undefined, '卡片上应保留「恢复为文件里的值」');
  tree = await page.act(() => { restore.props.onClick(); });

  assert.equal(findButtonContaining(tree, '保存全部').props.disabled, true, '恢复后没有脏字段');
  const restored = fieldControl(tree, '角色设定', 'persona');
  assert.equal(restored.props.value, '全局人格', '控件回到文件里的值');
  assert.equal(fieldControl(tree, '兴趣', 'interest').props.value, '全局兴趣', '同一张卡的另一处也回到文件值');
});

test('「撤销全部改动」清空整页草稿（不碰文件）', async () => {
  const page = await mountPage();
  let tree = page.tree();

  const personality = fieldControl(tree, '角色设定', 'persona');
  tree = await page.act(() => { personality.props.onChange({ target: { value: 'X' } }); });

  const before = configWrites(page.requests).length;
  tree = await page.act(() => { findButton(tree, '撤销全部改动').props.onClick(); });

  assert.equal(configWrites(page.requests).length, before, '撤销不许写文件');
  assert.equal(nodeText(findButtonContaining(tree, '保存全部')).trim(), '保存全部');
});

// ---------------------------------------------------------------- 重载

test('「重载插件」仍在保存条里，点了先就地确认（重载不是保存）', async () => {
  const page = await mountPage();
  const tree = page.tree();

  const reload = findButton(tree, '重载插件');
  assert.ok(reload !== undefined, '保存条里必须有「重载插件」');
  const next = await page.act(() => { reload.props.onClick(); });

  const confirm = findAll(next, (node) => hasClass(node, 'confirm'))[0];
  assert.ok(confirm !== undefined, '重载前要就地确认');
  assert.match(nodeText(confirm), /掐断/);
  // 确认条不是保存的确认条：保存按钮不受影响
  assert.equal(
    page.requests.some((item) => item.url.endsWith('/reload')),
    false,
    '没确认之前不许触发重载',
  );
});
