/**
 * 浏览器半的静态验证。
 *
 * 客户端产物必须在真实浏览器里跑，但它的**形态错误**完全可以离线抓出来——
 * 而且这些错误在浏览器里只表现为"设置页不出现"，没有任何报错线索，最难查：
 *
 * - 注册的 `id` 与包名不一致 → 宿主报 `loaded without registering "<id>"`
 * - 出现顶层 `import`/`export`/JSX → 它是被 `<script src>` 加载的经典脚本，会直接语法错误
 * - `require()` 了模块表里没有的包 → `require("<spec>") missed the module table`
 * - 忘了调 `__ModuleLoader__.load` → 文件被加载但什么都没注册
 *
 * 这个测试用一个假的 `window.__ModuleLoader__` 在 Node 里求值整个文件，
 * 把上面几条都钉住。
 *
 * 配置界面已经搬去临时服务提供的独立网页（`web/`），本文件验证的对象因此只剩
 * 一张「遥控器」卡片：注册形状、图标、两个纯函数（状态文案 / 主按钮文案）、
 * "点按钮之后发的是哪个请求、会不会多开一个窗口"，以及**它的视觉契约** ——
 * 配色只能走宿主的 `--dsw-alias-*` token、任何按钮都必须有可见文字、
 * 卡片必须占满可用宽度。视觉契约用断言钉住的理由：这类错误在浏览器里
 * 不报错、不留日志，只表现为"整块看不见"，没有离线可查的线索。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import { CONFIG_SERVER_ROUTE_BASE } from '../src/dsh/config-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const clientPath = join(root, 'client.js');
const source = readFileSync(clientPath, 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** 模块表里的 9 个种子包（宿主 PLATFORM_MODULES）。 */
const SEED_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]);

/**
 * 在一个隔离的 vm 里求值客户端脚本，返回它注册的内容。
 *
 * @param {string} code
 * @param {object} [options]
 * @param {(spec: string) => unknown} [options.requireImpl] 自定义 require
 * @param {object} [options.globals] 额外注入的全局（`fetch` / `setInterval` 等）。
 *   卡片只在事件回调里用它们，所以这些用例必须显式提供，否则 vm 里没有。
 */
function evaluateClient(code, { requireImpl, globals } = {}) {
  const registered = [];
  const requested = [];
  /** 被注册的 effect（挂载时由宿主执行；测试里手动调用）。 */
  const effects = [];
  /** 一个够用的 React 桩：createElement 返回普通对象，hooks 直接调实现。 */
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (fn) => {
      effects.push(fn);
    },
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
  };
  const requireFn = (spec) => {
    requested.push(spec);
    if (requireImpl !== undefined) return requireImpl(spec);
    if (spec === 'react') return React;
    if (SEED_MODULES.has(spec)) return {};
    throw new Error(`require("${spec}") missed the module table`);
  };
  const sandbox = {
    ...globals,
    window: {
      __ModuleLoader__: {
        load(entry) {
          registered.push(entry);
        },
      },
      // 气泡定位用到的一小撮浏览器 API：给空实现，够组件安静地跑完即可。
      addEventListener: () => {},
      removeEventListener: () => {},
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      innerWidth: 1280,
      innerHeight: 800,
      ...(globals !== undefined && globals.window !== undefined ? globals.window : {}),
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(code, { filename: clientPath }).runInContext(sandbox);
  return { registered, requested, requireFn, sandbox, effects, React };
}

/**
 * 取模块出口（工厂的返回值）。配置页已经不再需要 connection RPC，
 * 所以这里只喂 react 与剩下的种子包。
 */
function exportsOf(code, options) {
  const { registered } = evaluateClient(code, options);
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  };
  return registered[0].factory((spec) => {
    if (spec === 'react') return React;
    if (SEED_MODULES.has(spec)) return {};
    throw new Error(`require("${spec}") missed the module table`);
  });
}

/**
 * 深度优先找第一个**文字等于 label 的按钮**。
 *
 * 卡片用 `h()` 构造，没有 DOM，所以直接遍历返回的元素树即可；
 * `children` 里可能夹着 `null`（条件渲染）与嵌套元素。
 */
function findButton(node, label) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  const props = node.props ?? {};
  const children = Array.isArray(node.children) ? node.children : [];
  if (node.type === 'button' && typeof props.onClick === 'function') {
    const text = children.filter((child) => typeof child === 'string').join('');
    if (text === label) return node;
  }
  for (const child of children) {
    const found = findButton(child, label);
    if (found !== null) return found;
  }
  return null;
}

/**
 * 渲染一次主面板卡片，并返回那个「重新打开」按钮（服务未启动时主按钮的文案）。
 *
 * 桩 `useState` 不保存状态，所以每次 `mountCard()` 都从"刚挂载"那一刻开始 ——
 * 这正是点击时用户看到的状态。
 */
function mountCard() {
  const { registered, sandbox } = evaluateClient(source);
  // 挂载即把气泡展开（bubbleOpen = true）并给一个锚点：UI 现在默认收起气泡的话，
  // 树里只会有面板，按钮就在面板里。hook 顺序见 renderCard 的注释。
  const seeds = [null, false, '', '', true, false];
  let hookIndex = 0;
  const moduleExports = registered[0].factory((spec) => {
    if (spec === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useState: (v) => {
          const index = hookIndex;
          hookIndex += 1;
          const initial = typeof v === 'function' ? v() : v;
          return [index < seeds.length ? seeds[index] : initial, () => {}];
        },
        useEffect: () => {},
        useCallback: (fn) => fn,
        useRef: (value) => ({ current: value }),
      };
    }
    if (SEED_MODULES.has(spec)) return {};
    throw new Error(`require("${spec}") missed the module table`);
  });
  let card = null;
  const ctx = {
    slots: {
      inject: (_key, run) => run(),
      register: (options, component) => {
        if (options.name === 'sidebar.footer.action' || options.name === 'settings.section' || options.name === 'main') { if (card === null || options.name === 'sidebar.footer.action') card = component; }
        return () => {};
      },
    },
  };
  moduleExports.apply(ctx);
  assert.equal(typeof card, 'function', 'main 槽里应有卡片组件');
  const tree = card({});
  const button = findButton(tree, '打开配置页');
  assert.ok(button !== null, '服务未启动时主按钮文案应是「打开配置页」');
  return { sandbox, tree, button };
}

/**
 * 渲染一次卡片，并允许指定挂载那一刻的状态。
 *
 * 入参：`{ status, collapsed }` —— 依次对应组件里前两个 `useState` 的初值；
 *   其余 hook 用默认值。
 * 返回：渲染出来的元素树（普通对象，含 `type` / `props` / `children`）。
 * 约束：桩 `useState` 只对前两次调用回注指定初值，之后一律用默认值 ——
 *   组件内部的 hook 顺序一旦变化，本函数会立刻失配，这本身也是一道回归检查。
 */
/**
 * 渲染一次组件，并允许指定挂载那一刻的状态。
 *
 * 入参：`{ status, open, opened }` —— 轮询结果、浮层是否打开、是否已打开过配置页。
 * 返回：渲染出来的元素树（普通对象，含 `type` / `props` / `children`）。
 * 约束：桩 `useState` 按【调用顺序】回注初值，因此 hook 顺序一旦变化，本函数立刻失配
 *   —— 这本身是一道回归检查。当前顺序：status / busy / notice / manualUrl / open / opened。
 */
function renderCard({ status = null, open = true, opened = false } = {}) {
  const { registered } = evaluateClient(source);
  const initialState = [status, false, '', '', open, opened];
  let hookIndex = 0;
  const moduleExports = registered[0].factory((spec) => {
    if (spec === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useState: (value) => {
          const index = hookIndex;
          hookIndex += 1;
          const initial = typeof value === 'function' ? value() : value;
          const injected = index < initialState.length ? initialState[index] : initial;
          return [injected, () => {}];
        },
        useEffect: () => {},
        useCallback: (fn) => fn,
        useRef: (value) => ({ current: value }),
      };
    }
    if (SEED_MODULES.has(spec)) return {};
    throw new Error(`require("${spec}") missed the module table`);
  });
  let card = null;
  moduleExports.apply({
    slots: {
      inject: (_key, run) => run(),
      register: (options, component) => {
        if (options.name === 'sidebar.footer.action' || options.name === 'settings.section' || options.name === 'main') { if (card === null || options.name === 'sidebar.footer.action') card = component; }
        return () => {};
      },
    },
  });
  assert.equal(typeof card, 'function', 'main 槽里应有卡片组件');
  return card({});
}

/**
 * 深度优先遍历元素树。`children` 里可能夹着 `null`（条件渲染）与字符串。
 */
function walkTree(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkTree(item, visit);
    return;
  }
  visit(node);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) walkTree(child, visit);
}

/** 取出某棵子树里全部 `<button>`。 */
function collectButtons(tree) {
  const found = [];
  walkTree(tree, (node) => {
    if (node.type === 'button') found.push(node);
  });
  return found;
}

/** 按钮的可见文字：直接作为子元素的字符串拼接。 */
function buttonText(button) {
  const children = Array.isArray(button.children) ? button.children : [];
  return children.filter((child) => typeof child === 'string').join('');
}

/** 在树里找第一个满足条件的元素。 */
function findNode(tree, predicate) {
  let hit = null;
  walkTree(tree, (node) => {
    if (hit === null && predicate(node) === true) hit = node;
  });
  return hit;
}

// ---------------------------------------------------------------- 形态

test('client.js 注册的 id 必须等于包名（否则宿主报 loaded without registering）', () => {
  const { registered } = evaluateClient(source);
  assert.equal(registered.length, 1, '必须恰好注册一次');
  assert.equal(registered[0].id, pkg.name, `id 应为 ${pkg.name}`);
});

test('client.js 是经典脚本：没有顶层 import/export', () => {
  // 忽略注释里的内容，只看真实语句。
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/^\s*import\s/m.test(withoutComments), false, '不能有顶层 import');
  assert.equal(/^\s*export\s/m.test(withoutComments), false, '不能有顶层 export');
  assert.equal(/import\.meta/.test(withoutComments), false, '不能有 import.meta');
});

test('client.js 不含 JSX（宿主不编译，原样送出）', () => {
  // 粗略但有效：JSX 会以 `<标识符` 或 `</标识符` 出现在表达式里。
  // 字符串里的 HTML 比较会误报，好在我们的代码里没有比较字符串。
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/<[A-Za-z][A-Za-z0-9.]*[\s/>]/.test(codeOnly), false, '不该出现 JSX 标签');
});

test('client.js 可以真的被求值（未引用未声明的全局）', () => {
  assert.doesNotThrow(() => evaluateClient(source));
});

// ---------------------------------------------------------------- 模块表

test('client.js 只 require 模块表里有的包', () => {
  // 用一个"会用真 requireFn 记录"的桩跑一次工厂，才能看到它到底 require 了什么。
  const { registered } = evaluateClient(source);
  // 工厂是惰性的，必须显式调用才会 require。
  const seen = [];
  const factory = registered[0].factory;
  const React = {
    createElement: () => ({}),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  };
  const fakeRequire = (spec) => {
    seen.push(spec);
    if (spec === 'react') return React;
    if (SEED_MODULES.has(spec)) return {};
    throw new Error(`require("${spec}") missed the module table`);
  };
  assert.doesNotThrow(() => factory(fakeRequire), '工厂不该 require 模块表外的包');
  for (const spec of seen) {
    assert.ok(SEED_MODULES.has(spec), `require 了非种子包：${spec}`);
  }
  assert.ok(seen.includes('react'), '至少要用到 React');
});

// ---------------------------------------------------------------- 工厂返回值

test('工厂返回 { inject, apply }：只依赖 slots，不要求 connection', () => {
  const moduleExports = exportsOf(source);
  assert.equal(typeof moduleExports.apply, 'function', '必须导出 apply');
  assert.ok(Array.isArray(moduleExports.inject), 'inject 应是数组');
  // 卡片读写的是普通 HTTP 路由，不调用宿主的 connection RPC：没有 connection
  // 服务的部署里它也应当可用，所以这里不允许把它加回 inject。
  // 用展开复制一份：`inject` 数组来自 vm 上下文，原型与测试进程里的 Array 不同，
  // 直接 deepEqual 会因为原型不等而误报。
  assert.deepEqual([...moduleExports.inject], ['slots']);
});

test('apply 注册两处：设置页 + 侧栏底部动作（「咕」），且不再注册 main / panellist', () => {
  const names = [];
  const regs = [];
  const { registered } = evaluateClient(source);
  registered[0].factory((spec) => {
    if (spec === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        Fragment: Symbol.for('fragment'),
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
        useRef: (v) => ({ current: v }),
      };
    }
    if (spec === 'react-dom') return { createPortal: (node) => node };
    if (SEED_MODULES.has(spec)) return {};
    throw new Error(`require("${spec}") missed the module table`);
  }).apply({
    slots: {
      inject: (slotName, run) => {
        names.push(slotName);
        return run();
      },
      register: (options, component) => {
        regs.push({ name: options.name, id: options.id ?? options.key ?? '', component });
        return { options, component };
      },
    },
  });

  assert.ok(names.includes('settings.section'), '设置页入口要保留');
  assert.ok(names.includes('sidebar.footer.action'), '入口要挂在侧栏底部动作区');
  assert.equal(names.includes('main'), false, '不能再注册 main 面板（点它会被切到空白页）');
  assert.equal(names.includes('sidebar.panellist'), false, '不能再注册 sidebar.panellist');

  const footer = regs.find((item) => item.name === 'sidebar.footer.action');
  assert.notEqual(footer, undefined, '底部动作条目必须注册');
  assert.equal(typeof footer.id, 'string');
  assert.notEqual(footer.id, '', '底部动作条目必须带 id');
});

test('两个注册都指向同一个组件：设置页里也能渲染，不抛异常', () => {
  const regs = [];
  const { registered } = evaluateClient(source);
  registered[0].factory((spec) => {
    if (spec === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        Fragment: Symbol.for('fragment'),
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
        useRef: (v) => ({ current: v }),
      };
    }
    if (spec === 'react-dom') return { createPortal: (node) => node };
    if (SEED_MODULES.has(spec)) return {};
    throw new Error(`require("${spec}") missed the module table`);
  }).apply({
    slots: {
      inject: (_slotName, run) => run(),
      register: (options, component) => {
        regs.push({ name: options.name, component });
        return { options, component };
      },
    },
  });
  assert.equal(regs.length, 2, '设置页 + 侧栏底部动作，共两处');
  for (const { name, component } of regs) {
    assert.equal(typeof component, 'function', `${name} 注册的必须是组件`);
    const tree = component({});
    assert.notEqual(tree, null, `${name} 渲染结果不能是空`);
  }
});


test('路由前缀与宿主一致：卡片请求的 status / open 都挂在 CONFIG_SERVER_ROUTE_BASE 下', () => {
  const pure = exportsOf(source).__pure;
  // 两侧无法共享模块，所以逐字比对宿主导出的那份常量。不一致时卡片会一直
  // 显示「状态未知」（404 被当成轮询失败），宿主日志里也没有记录。
  assert.equal(pure.CONFIG_SERVER_BASE, CONFIG_SERVER_ROUTE_BASE);
  assert.equal(pure.STATUS_URL, `${CONFIG_SERVER_ROUTE_BASE}/status`);
  assert.equal(pure.OPEN_URL, `${CONFIG_SERVER_ROUTE_BASE}/open`);
  assert.equal(pure.POLL_INTERVAL_MS, 2000);
});

test('纯函数出口齐全（__pure 是离线测试的契约）', () => {
  const pure = exportsOf(source).__pure;
  for (const name of ['describeService', 'openButtonLabel']) {
    assert.equal(typeof pure[name], 'function', `__pure.${name} 应是函数`);
  }
});

test('状态文案：运行中给端口、已关闭给灰点、读不到降级成未知而不抛错', () => {
  const pure = exportsOf(source).__pure;

  const running = pure.describeService({ state: 'running', port: 61195, url: 'http://127.0.0.1:61195/?t=abc' });
  assert.equal(running.tone, 'running');
  assert.match(running.text, /服务运行中/);
  assert.match(running.text, /61195/);
  assert.equal(running.port, 61195);

  // 端口缺失时仍然说"运行中"，不显示 undefined。
  const noPort = pure.describeService({ state: 'running' });
  assert.equal(noPort.tone, 'running');
  assert.equal(noPort.text, '服务运行中');
  assert.equal(noPort.port, 0);
  assert.equal(noPort.text.includes('undefined'), false);

  const closed = pure.describeService({ state: 'closed', url: '', port: 0 });
  assert.equal(closed.tone, 'closed');
  assert.equal(closed.text, '已关闭');

  // 第一次还没读到：显示读取中，而不是"已关闭"（那是两件事）。
  // `undefined` 与 `null` 同义：都表示"还没有状态"。
  assert.equal(pure.describeService(null).tone, 'unknown');
  assert.equal(pure.describeService(null).text, '正在读取状态…');
  assert.equal(pure.describeService(undefined).text, '正在读取状态…');

  // 形状不对 / 含义不明：一律 unknown，且绝不抛异常。
  for (const garbage of [{}, { state: 'weird' }, 'boom']) {
    assert.doesNotThrow(() => pure.describeService(garbage));
    assert.equal(pure.describeService(garbage).tone, 'unknown');
    assert.equal(pure.describeService(garbage).text, '状态未知');
  }
});

test('主按钮文案：运行中「打开配置页」，其余「重新打开」', () => {
  const pure = exportsOf(source).__pure;
  assert.equal(pure.openButtonLabel({ state: 'running' }), '打开配置页');
  assert.equal(pure.openButtonLabel({ state: 'closed' }), '重新打开');
  assert.equal(pure.openButtonLabel(null), '重新打开');
  assert.equal(pure.openButtonLabel({}), '重新打开');
});

// ---------------------------------------------------------------- 卡片行为

test('点主按钮只发一个 POST open，请求体带 openBrowser:true', async () => {
  const requests = [];
  const { sandbox, button } = mountCard();
  sandbox.fetch = async (url, init) => {
    requests.push({ url: String(url), method: String(init && init.method), body: String(init && init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        state: 'running',
        port: 61195,
        url: 'http://127.0.0.1:61195/?t=abc',
        browserOpened: true,
      }),
    };
  };
  sandbox.window.open = () => {
    throw new Error('宿主已经开过浏览器，卡片不该再开一个窗口');
  };

  await button.props.onClick();

  assert.equal(requests.length, 1, '一个按钮只对应一个请求');
  assert.equal(requests[0].url, '/dsh-qq-proactive/config-server/open');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].body), { openBrowser: true });
});

test('宿主已开浏览器（browserOpened:true）时卡片不再开窗口；复用（false）时补一个标签页', async () => {
  const makeFetch = (browserOpened) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      state: 'running',
      port: 61195,
      url: 'http://127.0.0.1:61195/?t=abc',
      browserOpened,
    }),
  });

  // ① 冷启动：宿主自己 spawn 了系统浏览器，卡片什么都不做。
  const cold = mountCard();
  const coldOpened = [];
  cold.sandbox.fetch = makeFetch(true);
  cold.sandbox.window.open = (url) => coldOpened.push(url);
  await cold.button.props.onClick();
  assert.deepEqual(coldOpened, [], '宿主已经开过，再开就是两个窗口');

  // ② 复用：宿主没有开窗口，卡片用返回的地址补一个标签页。
  const reuse = mountCard();
  const reuseOpened = [];
  reuse.sandbox.fetch = makeFetch(false);
  reuse.sandbox.window.open = (url) => reuseOpened.push(url);
  await reuse.button.props.onClick();
  assert.deepEqual(reuseOpened, ['http://127.0.0.1:61195/?t=abc']);
});

test('请求失败：只显示错误文字，不把异常抛给 React', async () => {
  const { sandbox, button, tree } = mountCard();
  sandbox.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ ok: false, error: '起不来' }),
  });
  await assert.doesNotReject(() => button.props.onClick());

  // 渲染结果里要出现失败提示（桩 useState 不保存状态，所以这里只验证
  // "点击本身不抛"，文案由下一次真实渲染负责）。
  assert.notEqual(tree, null);
});

test('轮询：挂载即读 status、每 2 秒一次；请求失败只降级不抛异常', async () => {
  const calls = [];
  const intervals = [];
  const { registered, effects } = evaluateClient(source, {
    globals: {
      fetch: async (url) => {
        calls.push(String(url));
        // 第一次失败：验证 try/catch（宿主没答时不能把组件炸掉）。
        if (calls.length === 1) throw new Error('宿主没答');
        return { ok: true, status: 200, json: async () => ({ state: 'closed', url: '', port: 0 }) };
      },
      setInterval: (fn, ms) => {
        intervals.push({ fn, ms });
        return { unref() {} };
      },
      clearInterval: () => {
        intervals.length = 0;
      },
      // 气泡的定位 effect 会在展开时挂 resize/scroll 监听；这里给空实现即可 ——
      // 本用例只关心"轮询有没有挂上、失败会不会抛"，不关心位置。
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1280,
      innerHeight: 800,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
    },
  });
  const moduleExports = registered[0].factory((spec) => {
    if (spec === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: (fn) => {
          effects.push(fn);
        },
        useCallback: (fn) => fn,
        useRef: (value) => ({ current: value }),
      };
    }
    if (SEED_MODULES.has(spec)) return {};
    throw new Error(`require("${spec}") missed the module table`);
  });
  let card = null;
  moduleExports.apply({
    slots: {
      inject: (_k, run) => run(),
      register: (options, component) => {
        if (options.name === 'sidebar.footer.action' || options.name === 'settings.section' || options.name === 'main') { if (card === null || options.name === 'sidebar.footer.action') card = component; }
        return () => {};
      },
    },
  });
  assert.doesNotThrow(() => card({}));
  // 组件现在有三条 effect：轮询、量气泡位置、以及"点外面关闭"的监听。
  // 后两条只在气泡展开时才真正挂监听，收起态下可以直接返回 undefined，
  // 因此这里改为断言【恰好一条 effect 注册了 interval】—— 那才是轮询的判据。
  assert.ok(effects.length >= 1, '挂载时至少要注册轮询 effect');
  const cleanups = effects.map((fn) => (typeof fn === 'function' ? fn() : null));
  const cleanup = () => {
    for (const item of cleanups) {
      if (typeof item === 'function') item();
    }
  };
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  assert.deepEqual(calls, ['/dsh-qq-proactive/config-server/status'], '挂载即读一次状态');
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 2000, '轮询间隔 2 秒');

  // 手动跑一次轮询节拍：这一次请求成功，同样不抛。
  await assert.doesNotReject(async () => {
    intervals[0].fn();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  });
  assert.equal(calls.length, 2);

  assert.doesNotThrow(() => cleanup(), '卸载时清掉定时器');
});

// ---------------------------------------------------------------- 视觉契约
//
// 这一组断言全部来自一次真实的线上事故：卡片的配色用了宿主**不存在**的变量名
// （`--dsw-alias-text-primary` / `--dsw-alias-bg-elevated` / `--dsw-alias-accent`），
// `var()` 于是整段回落到兜底值 —— 白底 + `color: inherit`（深色主题下是近白文字），
// 表现为「整块白板 + 几个没有文字的空框」。浏览器不会为这种错误报任何一条日志。

test('浮层：收起时只有「咕」，点开后出现遮罩 + 面板 + 一个动作按钮', () => {
  const closed = renderCard({ open: false });
  assert.equal(collectButtons(closed).length, 1, '收起时只有一个球');
  assert.equal(findNode(closed, (n) => n.props?.role === 'dialog'), null, '收起时没有浮层');

  const opened = renderCard({
    status: { state: 'running', port: 61195, url: 'http://127.0.0.1:61195/?t=a' },
    open: true,
  });
  const dialog = findNode(opened, (n) => n.props?.role === 'dialog');
  assert.notEqual(dialog, null, '打开后要有 role=dialog 的面板');
  assert.equal(dialog.props['aria-modal'], 'true');
  const labels = collectButtons(opened).map(buttonText);
  assert.deepEqual(labels, ['咕', '打开配置页'], '球 + 面板里那一个按钮');
});

test('浮层里没有任何"空按钮"：四种状态下每个 button 的文字都非空', () => {
  const states = [
    { open: false },
    { status: null, open: true },
    { status: { state: 'running', port: 61195, url: 'http://127.0.0.1:61195/?t=a' }, open: true },
    { status: { state: 'closed', url: '', port: 0 }, open: true, opened: true },
  ];
  for (const options of states) {
    const buttons = collectButtons(renderCard(options));
    assert.ok(buttons.length > 0, `状态 ${JSON.stringify(options)} 下应有按钮`);
    for (const button of buttons) {
      assert.notEqual(buttonText(button).trim(), '', `状态 ${JSON.stringify(options)} 下有没文字的按钮`);
      assert.notEqual(button.props.style.color, 'inherit', '按钮文字必须显式给色，不能继承');
      assert.equal(typeof button.props.style.color, 'string');
    }
  }
});

test('打开过一次之后，浮层里的按钮文案变成「再次打开」', () => {
  const tree = renderCard({
    status: { state: 'running', port: 61195, url: 'http://127.0.0.1:61195/?t=a' },
    open: true,
    opened: true,
  });
  const labels = collectButtons(tree).map(buttonText);
  assert.equal(labels[labels.length - 1], '再次打开');
});

test('配色只走宿主真实存在的 token，不存在"白底回落"的可能', () => {
  const tree = renderCard({ open: true });
  const dialog = findNode(tree, (n) => n.props?.role === 'dialog');
  assert.equal(dialog.props.style.background, 'var(--dsw-alias-bg-layer-1, #2b2b2b)');
  assert.equal(dialog.props.style.color, 'var(--dsw-alias-label-primary, #e6e6e6)');

  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const ghost of ['bg-elevated', 'text-primary', 'text-secondary', 'border-subtle', 'alias-accent']) {
    assert.equal(
      codeOnly.includes(`--dsw-alias-${ghost}`),
      false,
      `不许再引用宿主不存在的变量 --dsw-alias-${ghost}`,
    );
  }
});

test('浮层定位：遮罩 fixed inset:0、面板 fixed 居中且尺寸按内容收小', () => {
  const tree = renderCard({ open: true });
  const dialog = findNode(tree, (n) => n.props?.role === 'dialog');
  const mask = findNode(tree, (n) => n.props?.style?.inset === '0');
  assert.notEqual(mask, null, '要有全屏遮罩');
  assert.equal(mask.props.style.position, 'fixed');
  assert.equal(dialog.props.style.position, 'fixed');
  assert.equal(dialog.props.style.left, '50%');
  assert.equal(dialog.props.style.top, '50%');
  assert.equal(dialog.props.style.transform, 'translate(-50%, -50%)');
  assert.match(dialog.props.style.width, /min\(420px/, '尺寸按我们的内容量收小，不用记忆那个 1240');
});

test('浮层的关闭方式：点遮罩 + Esc 两种都要有', () => {
  const tree = renderCard({ open: true });
  const mask = findNode(tree, (n) => n.props?.style?.inset === '0');
  assert.equal(typeof mask.props.onMouseDown, 'function', '点遮罩要能关');

  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(codeOnly, /event\.key === 'Escape'/, 'Esc 要能关');
  assert.match(codeOnly, /removeEventListener\('keydown'/, '卸载时必须摘掉监听');
});

test('浮层挂在 document.body 上（createPortal），并带 react-dom 兜底', () => {
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(codeOnly, /createPortal/, '浮层要用 createPortal 挂到 body');
  assert.match(codeOnly, /document\.body/, 'portal 的目标是 document.body');
  assert.match(codeOnly, /ReactDOM === null|ReactDOM !== null/, '没有 react-dom 时要有兜底分支');
});

test('状态点用宿主的状态语义 token，三种状态各用各的颜色', () => {
  const toneOf = (status) => {
    const tree = renderCard({ status, open: true });
    const dot = findNode(tree, (node) => node.props.style?.borderRadius === '50%' && node.type === 'span');
    assert.notEqual(dot, null, '应有状态圆点');
    return dot.props.style.background;
  };

  const running = toneOf({ state: 'running', port: 61195, url: '' });
  const closed = toneOf({ state: 'closed', url: '', port: 0 });
  const unknown = toneOf(null);

  assert.match(running, /--dsw-alias-state-success-primary/);
  assert.match(closed, /--dsw-alias-state-idle-primary/);
  assert.match(unknown, /--dsw-alias-state-warn-primary/);
  assert.notEqual(running, closed);
  assert.notEqual(closed, unknown);
});

test('悬停：浮层里可用的按钮带 onMouseEnter / onMouseLeave', () => {
  const running = renderCard({
    status: { state: 'running', port: 61195, url: 'http://127.0.0.1:61195/?t=a' },
    open: true,
  });
  const action = collectButtons(running).find((button) => buttonText(button) === '打开配置页');
  assert.notEqual(action, undefined);
  assert.equal(typeof action.props.onMouseEnter, 'function');
  assert.equal(typeof action.props.onMouseLeave, 'function');
});

test('「咕」的位置：插到「知」的容器里（同一行、右侧），找不到才回落', () => {
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // 优先插进「知」自己的容器：它是 display:flex，append 进去才是"同一行、右侧相邻"。
  assert.match(codeOnly, /#dsh-zhihu-floating-entry/, '要先找「知」的容器');
  assert.match(codeOnly, /parent\.appendChild\(host\)/, '插法是 append 进那个容器右侧');
  // 退路：侧栏底部设置区（纵向，只能保证同侧）+ 最终回落原位。
  assert.match(codeOnly, /\[class\*="settingsArea"\]/, '找不到「知」时退回设置区');
  assert.match(codeOnly, /holder !== null/, '要显式判空决定是否 portal');
  // 不许改「知」自己的结构/样式：我们对它的容器只做 appendChild，不 setAttribute/style。
  assert.equal(/zhihu[a-zA-Z]*\.style\s*=/.test(codeOnly), false, '不许改知乎容器的样式');
  assert.equal(/setAttribute\(['"]class['"],\s*['"]dsh-zhihu/.test(codeOnly), false, '不许改知乎的 class');
  // 反复插也只插一份：宿主元素要被记住。
  assert.match(codeOnly, /hostElRef/, '宿主元素要复用，避免重复插入');
  assert.match(codeOnly, /MutationObserver/, '侧栏重渲染会换容器，要盯着重新插');
});

