/**
 * 预览页的引导：按**宿主的方式**调用 client.js 的 installer，把组件取出来挂上去。
 *
 * client.js 是「installer 形态」而不是「导出组件」形态（见它文件头那几条硬约束）：
 *
 *   window.__ModuleLoader__.load({ id: 'dsh-qq-proactive', factory(require) { ... } });
 *
 * factory 返回的是一个 cordis 插件对象（`{ inject: ['connection','slots'], apply(ctx) }`），
 * 组件是在 `apply()` 里通过 `ctx.slots.register(参数, 组件)` 交给宿主的。
 * 所以这里做的**就是宿主做的事**：
 *
 *   1. 接住 client.js 注册进来的 factory；
 *   2. 给它一个只认 react / react-dom 的 `require`；
 *   3. 造一个最小 `ctx`（只实现 `slots.inject` / `slots.register` 和 `connection.rpc`）；
 *   4. 调 `plugin.apply(ctx)` → 在 `main` 槽里拿到 key 为 `qq-config` 的那个组件；
 *   5. 把 `参数.inject()` 的结果当 props 渲染它。
 *
 * ⚠️ 全程**没有** import client.js 里的任何组件名 —— 它没有 ESM 导出可 import。
 *    这样改 client.js 之后，预览页永远是新的，不存在「复制一份组件、两边漂移」。
 */

import { settings, status, rpcConfig } from './fixtures.mjs';

const h = (type, props, ...children) => window.React.createElement(type, props, ...children);

/** 出错时把话说清楚（白屏是最难查的）。 */
function fail(title, detail) {
  const box = document.getElementById('boot-error');
  box.style.display = 'block';
  box.textContent = `${title}\n\n${detail || ''}`.trim();
  console.error('[preview]', title, detail);
}

/**
 * 假 `fetch`：只截 `PAGE_BASE` 那几道路由，其余照旧走真的。
 *
 * client.js 里「记忆 / 定时任务 / 原文件」读的是纯 HTTP 端点
 * （`/dsh-qq-proactive/settings` 等），不走 RPC —— 所以要在这里喂假 JSON。
 */
function installFakeHost() {
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input);
    const method = String((init && init.method) || 'GET').toUpperCase();

    if (url.startsWith('/dsh-qq-proactive/')) {
      const path = url.slice('/dsh-qq-proactive'.length);
      const json = (payload) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      if (path === '/settings' && method === 'GET') return json(settings);
      // 写入类：预览里不落盘，回个 ok 让按钮的行为可点可看。
      if (path === '/config' || path === '/free-time' || path === '/reload') {
        return json({ ok: true, preview: true });
      }
      return new Response(JSON.stringify({ error: `preview 没有这条路由：${path}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    return realFetch(input, init);
  };
}

/**
 * 假 `ctx`：只实现 client.js 的 `apply()` 用到的那几样。
 *
 * `slots.inject(name, cb)` 在宿主里是"这个槽可用时再执行 cb"，这里直接执行；
 * `slots.register(参数, 组件)` 把注册项收进数组，`参数`（含 `inject`）原样留着 ——
 * 后面要用它当 props。
 */
function makeFakeCtx(registered) {
  return {
    slots: {
      inject: (name, callback) => {
        callback();
        return () => {};
      },
      register: (params, component) => {
        registered.push({ params, component });
        return () => {};
      },
    },
    // settings RPC 那一层（连接 / 权限 / 行为 三张卡 + 状态行）。
    connection: {
      rpc: {
        call: async (channel, endpoint) => {
          if (endpoint === 'get') return { ok: true, value: { config: rpcConfig } };
          if (endpoint === 'status') return { ok: true, value: status };
          if (endpoint === 'patch') return { ok: true, value: { preview: true } };
          return { ok: false, error: { code: 'preview/unknown-endpoint', message: `preview 没有这个 RPC：${channel}/${endpoint}` } };
        },
      },
    },
  };
}

/** 说明 React 是从本机 vendor 来的还是 CDN 来的（写进顶部说明条，别让人以为离线也能跑）。 */
function noteReactSource() {
  const label = document.getElementById('react-source');
  if (label === null) return;
  // 老浏览器 / 非浏览器环境可能没有 getEntriesByType —— 拿不到就照实说"不确定"，别崩。
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
    label.textContent = 'React：已加载';
    return;
  }
  const names = performance.getEntriesByType('resource').map((entry) => entry.name);
  const viaCdn = names.some((name) => name.includes('unpkg.com') || name.includes('jsdelivr'));
  label.textContent = viaCdn
    ? 'React：来自 CDN（需要联网；放进 preview/vendor/ 可离线）'
    : 'React：本机 preview/vendor/（离线可用）';
}

function boot() {
  const React = window.React;
  const ReactDOM = window.ReactDOM;

  if (!React || !ReactDOM) {
    fail(
      'React / ReactDOM 没加载出来。',
      '预览页需要真 React。两种办法：\n'
      + '  ① 联网（当前用的是 CDN 兜底）；\n'
      + '  ② 把 react.development.js 与 react-dom.development.js 放进 preview/vendor/，'
      + '重新刷新即可离线使用。\n\n'
      + '（检查浏览器控制台里 /react.development.js 那条请求是不是失败了。）',
    );
    return;
  }

  noteReactSource();

  const entries = Array.isArray(window.__previewModules) ? window.__previewModules : [];
  const entry = entries.find((item) => item && item.id === 'dsh-qq-proactive');
  if (!entry || typeof entry.factory !== 'function') {
    fail(
      '没有接到 client.js 的注册。',
      `client.js 应当调用 window.__ModuleLoader__.load({ id: 'dsh-qq-proactive', factory })，\n`
      + `实际接到：${entries.map((item) => item && item.id).join(', ') || '（一个都没有）'}\n\n`
      + '先确认 /client.js 真的加载成功（控制台有没有 404 / 语法错误）。',
    );
    return;
  }

  // 宿主那张种子模块表里，client.js 只用得上 react（别的一律报错，免得静默糊过去）。
  const requireShim = (spec) => {
    if (spec === 'react') return React;
    if (spec === 'react-dom') return ReactDOM;
    throw new Error(`预览页只提供了 react / react-dom，client.js 要的是 "${spec}"`);
  };

  const registered = [];
  let plugin;
  try {
    plugin = entry.factory(requireShim);
  } catch (error) {
    fail('client.js 的 factory 抛错了。', String((error && error.stack) || error));
    return;
  }

  try {
    installFakeHost();
    plugin.apply(makeFakeCtx(registered));
  } catch (error) {
    fail('client.js 的 apply() 抛错了（假 ctx 可能少实现了什么）。', String((error && error.stack) || error));
    return;
  }

  // 宿主那里：`main` 槽的 keyed 注册（key 与左栏格子的 id 逐字相同）就是主面板。
  const main = registered.find(
    (item) => item.params && item.params.name === 'main' && item.params.key === 'qq-config',
  );
  if (main === undefined) {
    fail(
      'apply() 里没有注册 main / qq-config。',
      `已注册：${registered.map((item) => `${item.params && item.params.name}${item.params && item.params.key ? `(${item.params.key})` : ''}`).join(', ')}`,
    );
    return;
  }

  // props 就是注册参数里的 `inject()` —— 宿主也是这么把 `actions.call` 递给组件的。
  const injected = typeof main.params.inject === 'function' ? main.params.inject() : {};

  // 留个把手，方便在控制台里翻：window.__preview.plugin / .registered / .settings
  window.__preview = { plugin, registered, settings, props: injected };

  ReactDOM.createRoot(document.getElementById('root')).render(
    h('div', { style: { height: '100%' } }, h(main.component, injected)),
  );
}

boot();
