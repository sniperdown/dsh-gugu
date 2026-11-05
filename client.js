/**
 * 作用：QQ 小鲸鱼配置入口的浏览器侧实现 —— 一张「遥控器」卡片。
 *
 * 它不是配置界面：真正的配置页是宿主的临时配置服务提供的独立网页
 * （`web/` 目录，按 F5 即生效）。卡片只做三件事：读服务状态、请求起服务、
 * 把地址交给用户。这样拆分的理由是生效成本：浏览器半属于 client 侧，任何改动
 * 都要重启 DSH 才能看到；字段渲染留在这一侧，改一个标签也要重启。配置界面搬进
 * 独立网页之后，改 `web/` 只要刷新页面。
 *
 * 入参：无。加载时向 window.__ModuleLoader__ 注册一个模块，模块 id 等于包名。
 * 返回：无返回值。注册完成后由宿主按槽位调用其中的组件。
 * 约束：加载形态由宿主决定，下列四条不可违反，否则页面无法打开或直接报错。
 *   1. 必须是经典脚本，不能是 ESM。宿主按字节原样送出、以 <script src> 加载，
 *      并可能与其他插件的脚本拼进同一个响应，因此不允许顶层 import / export / JSX。
 *   2. 必须调用 window.__ModuleLoader__.load({ id, factory })，且 id 与包名逐字相同，
 *      否则宿主报 loaded without registering "<id>"。
 *   3. require() 只能取模块表中的种子包，共九个：react、react-dom、@deepseek-ai/cordis、
 *      dsh-client-store、dsh-client-ui-slots、dsh-client-ui-primitives、
 *      dsh-client-ui-dockkit 等。本文件只取 react：依赖越少，
 *      在其他部署中因缺包而加载失败的可能越小。
 *   4. 界面文字直接写成中文常量，不接 locale 服务。接入该服务需要额外维护一份字典
 *      与绑定关系，而本卡片属于内部工具，收益不足以抵偿这份成本。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-proactive',
  factory(require) {
    const React = require('react');
    // `react-dom` 只在浮层挂到 document.body 时用（createPortal）。宿主模块表里
    // 有它；万一某个部署没有，`ReactDOM` 会是 undefined，此时浮层渲染在组件树里
    // （样式仍是 fixed，视觉差别只在层叠上下文），不会崩。
    let ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch {
      ReactDOM = null;
    }
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    /**
     * 作用：侧栏底部动作条目的标识。
     * 取值：'qq-config'。
     * 约束：注册在 `sidebar.footer.action`（**动作槽**），不是 `sidebar.panellist`
     *   （面板列表）—— 后者被点击时宿主必然执行 `ctx.layout.selectPanel(id)`，会把
     *   主面板切走；动作槽只渲染按钮，点击完全由插件自己处理，因此"底下对话不被
     *   切走"才有可能。同机的记忆插件（`@modusensus/dsh-mneme`）与知乎插件
     *   （`@zhengjunyao/dsh-zhihu`）都是这个路子。
     *   `id` 必填且需唯一；`order`/`label` 可选。条目外观由注册的组件自己画。
     */
    const PANEL_KEY = 'qq-config';
    const PANEL_LABEL = 'QQ 小鲸鱼';
    /** 「咕」球体尺寸（像素）。与知乎插件侧栏内联态一致（36×36）。 */

    /**
     * 作用：临时配置服务的启停路由前缀。
     * 取值：`/dsh-qq-proactive/config-server`。
     * 约束：必须与宿主 `src/dsh/config-server.mjs` 的 CONFIG_SERVER_ROUTE_BASE
     *   逐字一致。浏览器侧与宿主侧无法共享同一个模块，只能各存一份副本；
     *   不一致时的现象是卡片一直显示「状态未知」（请求 404 被当成轮询失败），
     *   而宿主日志里不会有任何记录。
     */
    const CONFIG_SERVER_BASE = '/dsh-qq-proactive/config-server';

    /** 状态轮询端点：只读，返回 `{ok, state, url, port, ageMs, lastBeatMs}`。 */
    const STATUS_URL = `${CONFIG_SERVER_BASE}/status`;

    /** 起服务端点：`POST`，可选体 `{openBrowser}`。这是唯一会 spawn 浏览器的入口。 */
    const OPEN_URL = `${CONFIG_SERVER_BASE}/open`;

    /**
     * 作用：状态轮询间隔（毫秒）。
     * 取值：2000。
     * 约束：不要调大太多。临时服务在没有心跳 15 秒后自行关闭，轮询间隔决定
     *   「页面关掉之后卡片多久变灰」；2 秒相对 15 秒的判据足够密。
     */
    const POLL_INTERVAL_MS = 2000;

    /**
     * 作用：三种服务状态对应的圆点颜色。
     * 取值：运行中绿色、已关闭灰色、未知（读不到）琥珀色。
     * 约束：优先取宿主的状态语义 token（`--dsw-alias-state-*`），宿主没有定义时
     *   回落到固定的深色主题色。三种状态的语义彼此独立，因此不能共用一个
     *   token —— 否则"读不到"会被画成"已关闭"的样子。
     */
    const DOT_COLOR = {
      running: 'var(--dsw-alias-state-success-primary, #3fb950)',
      closed: 'var(--dsw-alias-state-idle-primary, #8b8b8b)',
      unknown: 'var(--dsw-alias-state-warn-primary, #d29922)',
    };

    /**
     * 作用：卡片引用的设计 token。
     *
     * 取值：一律写成 `var(--dsw-alias-*, 回落值)`。变量名取自宿主主题
     *   `dsh-client-ui-theme` 实际导出的那套（`label-*` / `bg-*` / `border-l*` /
     *   `settings-card-*` / `button-primary-*`），与内置的设置卡片（
     *   `dsh-client-ui-settings-account`）用的是同一组。
     *
     * 约束：两条，都不能违反。
     *   1. **变量名必须逐字存在**。宿主里不存在 `--dsw-alias-text-primary`、
     *      `--dsw-alias-bg-elevated`、`--dsw-alias-accent` 这类名字；一旦写成
     *      不存在的名字，`var()` 会整段回落到兜底值 —— 若兜底值是浅色，就会出现
     *      「浅底 + 继承来的浅色文字」＝ 整块看不见。回落的这一组刻意配成同一套
     *      深色，保证在任何主题下都不可能白底浅字。
     *   2. **颜色只从这一处取**。组件里不再出现裸写的十六进制颜色，避免某一处
     *      漏改后与其余部分不同步。
     */
    const COLOR = {
      /** 正文：主文字。深色主题下是近白，浅色主题下是近黑。 */
      text: 'var(--dsw-alias-label-primary, #e6e6e6)',
      /** 次要文字：提示、状态行、禁用按钮。 */
      textMuted: 'var(--dsw-alias-label-tertiary, #9a9a9a)',
      /** 卡片底色：宿主设置卡片同款（深色主题是 --bg-layer-2）。 */
      cardFill: 'var(--dsw-alias-settings-card-fill, #2b2b2b)',
      /** 卡片描边：宿主设置卡片同款。 */
      cardStroke: 'var(--dsw-alias-settings-card-stroke, #3a3a3a)',
      /** 按钮描边。 */
      buttonStroke: 'var(--dsw-alias-border-l3, #3a3a3a)',
      /** 按钮悬停底色。 */
      buttonHover: 'var(--dsw-alias-interactive-bg-hover, #333333)',
      /** 主按钮底色与悬停底色：宿主按钮自己用的那一对。 */
      primaryFill: 'var(--dsw-alias-button-primary-fill, #2f6feb)',
      primaryFillHover: 'var(--dsw-alias-button-primary-hover, #3b7ef0)',
      /** 主按钮文字：与 primaryFill 成对出现，保证深浅两套主题都有对比度。 */
      primaryText: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      /** 分隔线。 */
      divider: 'var(--dsw-alias-border-l2, #3a3a3a)',
    };

    /**
     * 作用：把 `/status` 的返回值整理成可直接渲染的三个字段。
     * 入参：status —— 宿主 status() 的结果；`null` 表示"第一次还没读到"。
     * 返回：`{ tone: 'running' | 'closed' | 'unknown', text: string, port: number }`。
     * 约束：**不抛异常**。字段缺失、类型不对一律落到 unknown —— 卡片的职责之一是
     *   把"宿主没答"如实显示出来，如果这里抛错，整块面板会白屏。
     */
    function describeService(status) {
      if (status === null || status === undefined) {
        return { tone: 'unknown', text: '正在读取状态…', port: 0 };
      }
      if (status.state === 'running') {
        const port = typeof status.port === 'number' && status.port > 0 ? status.port : 0;
        return {
          tone: 'running',
          text: port > 0 ? `服务运行中 · 端口 ${port}` : '服务运行中',
          port,
        };
      }
      if (status.state === 'closed') {
        return { tone: 'closed', text: '已关闭', port: 0 };
      }
      return { tone: 'unknown', text: '状态未知', port: 0 };
    }

    /**
     * 作用：主按钮的文案。
     * 入参：status —— 同 {@link describeService}。
     * 返回：服务在跑 ⇒「打开配置页」；已关闭或读不到 ⇒「重新打开」。
     * 约束：两个文案走同一个点击处理（{@link RemoteControlBall} 的 startService），
     *   区别只在措辞：服务没起来时"打开"没有意义。
     */
    function openButtonLabel(status) {
      return status !== null && status !== undefined && status.state === 'running'
        ? '打开配置页'
        : '重新打开';
    }

    /**
     * 作用：按钮共用的几何尺寸。
     * 约束：只在 `BUTTON_BASE` 里定义一次，三个按钮样式（普通 / 主按钮 / 禁用）
     *   都以展开语法继承它，这样按钮行不会因为文案长短而高低不齐。
     */
    const BUTTON_BASE = {
      boxSizing: 'border-box',
      minHeight: '30px',
      padding: '5px 14px',
      borderRadius: '6px',
      fontSize: '12.5px',
      lineHeight: 1.6,
      fontFamily: 'inherit',
      whiteSpace: 'nowrap',
      /** 按钮文字一律显式给色，绝不 `inherit` —— 继承链一旦断在浅色底上就是空框。 */
      color: COLOR.text,
    };

    /**
     * 作用：卡片的全部内联样式。
     * 约束：保持对象字面量写法，不引入 CSS-in-JS 库，也不写 `<style>` 标签 ——
     *   这张卡片要足够轻，且宿主不保证提供任何样式基础设施。所有颜色都从
     *   {@link COLOR} 取，见该常量对变量名与回落值的说明。
     */
    const styles = {
      card: {
        /** 占满可用宽度：宿主把卡片放进列容器时，块级宽度默认会缩到内容宽度。 */
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        alignSelf: 'stretch',
        width: '100%',
        boxSizing: 'border-box',
        gap: '10px',
        padding: '14px',
        borderRadius: '12px',
        border: `1px solid ${COLOR.cardStroke}`,
        background: COLOR.cardFill,
        color: COLOR.text,
        fontSize: '13px',
        lineHeight: 1.6,
      },
      /** 收起态：只留一行，横向排布。 */
      cardCompact: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        alignSelf: 'stretch',
        width: '100%',
        boxSizing: 'border-box',
        gap: '8px',
        padding: '10px 14px',
        borderRadius: '12px',
        border: `1px solid ${COLOR.cardStroke}`,
        background: COLOR.cardFill,
        color: COLOR.text,
        fontSize: '13px',
        lineHeight: 1.6,
      },
      /** 触发按钮：一个贴着侧栏入口的小圆角按钮，气泡挂在它右侧。 */
      launcher: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 12px',
        borderRadius: '8px',
        border: `1px solid ${COLOR.buttonStroke}`,
        background: 'transparent',
        color: COLOR.text,
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        lineHeight: 1.4,
      },
      /** 触发按钮被点开时的样子（与收起态同一套尺寸，只换底色）。 */
      launcherActive: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 12px',
        borderRadius: '8px',
        border: `1px solid ${COLOR.buttonStroke}`,
        background: COLOR.buttonHover,
        color: COLOR.text,
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        lineHeight: 1.4,
      },
      /**
       * 气泡外壳。位置由 `left/top` 在渲染时按实测坐标写入，这里只管长相。
       * `position: fixed` 是刻意的：侧栏容器常常 `overflow: hidden`，
       * 用 absolute 会被裁掉一半。
       */
      bubble: {
        position: 'fixed',
        zIndex: 2147483000,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        boxSizing: 'border-box',
        padding: '12px 14px',
        borderRadius: '10px',
        border: `1px solid ${COLOR.cardStroke}`,
        background: COLOR.cardFill,
        color: COLOR.text,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
        fontSize: '13px',
        lineHeight: 1.6,
      },
      bubbleTitle: { fontWeight: 600, color: COLOR.text },
      head: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, color: COLOR.text },
      statusRow: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px',
        fontSize: '12.5px',
        color: COLOR.textMuted,
      },
      footer: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' },
      /**
       * 侧栏底部那颗「咕」。36×36 圆、单字、主色底、白字 —— 形状照搬同机的
       * 知乎插件（其侧栏内联态就是 36×36 圆 + 单字），那是用户认可的参照物。
       * 颜色走宿主 token，主题切换时自动跟着变。
       */
      ball: {
        width: '36px',
        height: '36px',
        margin: '0',
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        border: 'none',
        outline: 'none',
        cursor: 'pointer',
        fontSize: '15px',
        fontWeight: 600,
        lineHeight: 1,
        background: 'var(--dsw-alias-button-primary-fill, #056DE8)',
        color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      },
      /** 浮层打开时的样子：只是浅一号的主色，不另起一套配色。 */
      ballActive: {
        width: '36px',
        height: '36px',
        margin: '0',
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        border: 'none',
        outline: 'none',
        cursor: 'pointer',
        fontSize: '15px',
        fontWeight: 600,
        lineHeight: 1,
        background: 'var(--dsw-alias-button-primary-hover, #3b7ef0)',
        color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      },
      /** 遮罩：数值照抄记忆插件（16% 主文字色 + 2px 模糊）。 */
      overlayMask: {
        position: 'fixed',
        inset: '0',
        zIndex: 2147483000,
        background: 'color-mix(in srgb, var(--dsw-alias-label-primary, #e6e6e6) 16%, transparent)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      /**
       * 面板：定位方式照抄记忆插件（fixed + 50%/50% + translate），**尺寸按我们的
       * 内容量收小** —— 记忆那个是 1240×920 的资料库，我们这里只有三行。
       */
      overlayPanel: {
        position: 'fixed',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 2147483001,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        boxSizing: 'border-box',
        width: 'min(420px, calc(100vw - 48px))',
        padding: '16px 18px',
        borderRadius: '14px',
        border: `1px solid ${COLOR.cardStroke}`,
        background: 'var(--dsw-alias-bg-layer-1, #2b2b2b)',
        color: COLOR.text,
        boxShadow: '0 24px 64px rgba(0, 0, 0, 0.32)',
        fontSize: '13px',
        lineHeight: 1.6,
      },
      overlayTitle: { fontWeight: 600, color: COLOR.text },
      /** 按钮横排：固定 8px 间距，宽度不够时整行换行而不是挤压。 */
      actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' },
      dot: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', flex: 'none' },
      button: {
        ...BUTTON_BASE,
        cursor: 'pointer',
        border: `1px solid ${COLOR.buttonStroke}`,
        background: 'transparent',
      },
      /** 主按钮：与宿主按钮同一对「底色 + 前景色」token，深浅主题都有对比度。 */
      buttonPrimary: {
        ...BUTTON_BASE,
        cursor: 'pointer',
        fontWeight: 500,
        border: '1px solid transparent',
        background: COLOR.primaryFill,
        color: COLOR.primaryText,
      },
      /** 不可用外观：只降透明度，不改变尺寸，避免按钮行跳动。 */
      buttonOff: {
        ...BUTTON_BASE,
        cursor: 'default',
        opacity: 0.6,
        border: `1px solid ${COLOR.buttonStroke}`,
        background: 'transparent',
        color: COLOR.textMuted,
      },
      /** 主按钮的忙态：保留主按钮形状，只降透明度。 */
      buttonPrimaryOff: {
        ...BUTTON_BASE,
        cursor: 'default',
        fontWeight: 500,
        opacity: 0.6,
        border: '1px solid transparent',
        background: COLOR.primaryFill,
        color: COLOR.primaryText,
      },
      divider: { height: '1px', background: COLOR.divider, flex: 'none' },
      hint: { fontSize: '11.5px', color: COLOR.textMuted, whiteSpace: 'pre-wrap' },
      /** 剪贴板不可用时的退化输入框：地址可被鼠标选中、Ctrl+C 复制。 */
      manual: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: '28px',
        padding: '4px 10px',
        borderRadius: '6px',
        border: `1px solid ${COLOR.buttonStroke}`,
        background: 'transparent',
        color: COLOR.text,
        fontSize: '12px',
        lineHeight: 1.6,
        fontFamily: 'ui-monospace, Consolas, monospace',
      },
    };

    /**
     * 作用：给按钮补一对悬停处理器。
     *
     * 入参：idleBackground —— 静止态底色（与按钮自身 style.background 一致）；
     *   hoverBackground —— 悬停态底色。
     * 返回：可直接展开进 `h('button', {...})` 的两个事件处理器。
     * 约束：卡片全部使用内联样式，而内联样式无法表达 `:hover`，因此这里在
     *   指针进入/离开时直接改 `currentTarget.style.background`。两种回调都用
     *   try/catch 包住 —— 它们挂在宿主事件循环上，抛出会中断整棵树的渲染。
     */
    function hoverProps(idleBackground, hoverBackground) {
      return {
        onMouseEnter: (event) => {
          try {
            event.currentTarget.style.background = hoverBackground;
          } catch {
            /* 取不到目标元素时保持静止态，不影响功能 */
          }
        },
        onMouseLeave: (event) => {
          try {
            event.currentTarget.style.background = idleBackground;
          } catch {
            /* 同上 */
          }
        },
      };
    }


    /**
     * 作用：启动器本体 —— 一个触发按钮，加一只贴着它的气泡。
     *
     * 界面：
     *
     * ```
     * [QQ 小鲸鱼 · 配置 ●]        ← 触发按钮（常驻，就是侧栏里那一小格）
     *        ↓ 点它，气泡贴着它右侧出现（右边放不下就翻到左侧）
     *        ┌──────────────────────────┐
     *        │ QQ 小鲸鱼 · 配置            │
     *        │ ● 服务运行中 · 端口 61195 │  ← 绿点运行中 / 灰点已关闭 / 琥珀点读不到
     *        │ [ 打开配置页 ]            │  ← 打开过后变「再次打开」
     *        └──────────────────────────┘
     * ```
     *
     * 行为：
     * - 挂载时 `GET /config-server/status`，之后每 2 秒轮询一次。
     * - 「打开配置页」= `POST /config-server/open`（体里带 `openBrowser: true`）。
     *   **这是唯一会 spawn 系统浏览器的入口**：服务已在跑时宿主走复用分支、
     *   不再开窗口，此时气泡自己用 `window.open` 打开返回的地址；宿主报告
     *   `browserOpened: true` 时气泡不再打开，避免同一页两个窗口。
     * - 气泡位置**不写死**：每次展开都用 `getBoundingClientRect()` 现量触发按钮，
     *   并在 `resize` / `scroll`（捕获阶段）与 `ResizeObserver` 触发时重算。
     * - 关气泡：点气泡外任意处、按 `Esc`、或再点一次触发按钮。
     * - **点气泡不关服务**。服务生死只认配置页的心跳：页面每 5 秒报到一次，
     *   15 秒没有心跳服务自行关闭。气泡上的按钮不会去关服务，因为"收起气泡"
     *   与"关掉服务"是两件事。
     *
     * 约束：所有网络调用都自带 try/catch。轮询失败只把状态降级成未知，
     *   绝不把异常抛给 React —— 那会让整个面板白屏，而卡片显示不出来
     *   等于用户失去了唯一的配置入口。
     */
    function RemoteControlBall() {
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const [manualUrl, setManualUrl] = useState('');
      /** 浮层是否打开。入口是侧栏底部那颗「咕」，点它切换这里。 */
      const [open, setOpen] = useState(false);
      /** 本次是否已经打开过配置页（只影响按钮文案）。 */
      const [opened, setOpened] = useState(false);
      /** 「咕」要落进的容器：侧栏底部 settingsArea（「知」也在那里）；null = 找不到就回落原位。 */
      const [holder, setHolder] = useState(null);

      // 状态轮询。`cancelled` 挡住卸载之后到达的响应：宿主切换面板时会卸载
      // 组件，此时 setState 会触发 React 的"已卸载组件"告警。
      useEffect(() => {
        let cancelled = false;

        const readStatus = async () => {
          try {
            const response = await fetch(STATUS_URL, {
              method: 'GET',
              headers: { accept: 'application/json' },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (cancelled) return;
            setStatus(payload !== null && typeof payload === 'object' ? payload : { state: 'unknown' });
          } catch {
            // 宿主没答（插件没挂上、路由被移除、页面刚启动）：如实降级，
            // 不重试、不冒泡。下一次轮询自然会再试一次。
            if (!cancelled) setStatus({ state: 'unknown' });
          }
        };

        readStatus();
        const timer = setInterval(readStatus, POLL_INTERVAL_MS);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, []);

      // Esc 关闭浮层。点遮罩关闭在渲染里用 onMouseDown 处理（见 overlayMask），
      // 这里只补键盘：键盘事件只挂在 document 上才收得到，所以需要一条 effect。
      // 非浏览器环境（离线测试）没有 document，直接不挂。
      useEffect(() => {
        if (open !== true || typeof document === 'undefined') return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      /**
       * 找到「咕」的落点 —— 一个**我们自己创建的宿主元素**，插在「知」那一排的右侧。
       *
       * 为什么不用槽位解决：`sidebar.settings` 是 **single** 槽（只能有一个条目），
       * 我们不能去抢；知乎插件也是绕过槽位、直接往 DOM 里塞的。
       * 我们保留在 list 槽（`sidebar.footer.action`）上的注册 —— 生命周期归 slot 管 ——
       * 只把渲染结果 portal 进这个宿主元素。
       *
       * 位置策略（按优先级，全部 additive，**不改「知」的任何节点与样式**）：
       *   1. `#dsh-zhihu-floating-entry`（「知」自己的容器，`display:flex`）
       *      ⇒ 把宿主元素 append 进去 ⇒ 同一行、紧贴「知」右侧；
       *   2. 退回 `[class*="settingsArea"]`（纵向容器）⇒ 会上下堆，但至少在同侧；
       *   3. 都找不到 ⇒ `holder = null`，渲染回原位（不 portal）。
       *
       * 侧栏/知乎容器都会重渲染替换，所以用 MutationObserver 盯着 body 重新插；
       * 用 `hostEl` 记住我们那个宿主元素，反复插也只插一份。全部 try/catch。
       */
      const hostElRef = React.useRef(null);
      useEffect(() => {
        if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
        let observer = null;
        let scheduled = 0;

        const ensureHost = () => {
          if (hostElRef.current === null) {
            const host = document.createElement('span');
            host.id = 'qq-gugu-entry';
            host.style.display = 'inline-flex';
            host.style.alignItems = 'center';
            hostElRef.current = host;
          }
          return hostElRef.current;
        };

        /** 把宿主元素插到「知」旁边；返回它实际挂进的容器（没找到返回 null）。 */
        const attach = () => {
          const host = ensureHost();
          let parent = null;
          try {
            // 优先级 1：知乎那条自己的容器（display:flex ⇒ 同一行）。
            const zhihu = document.querySelector('#dsh-zhihu-floating-entry');
            if (zhihu !== null) parent = zhihu;
            else {
              // 优先级 2：侧栏底部的设置区（纵向 ⇒ 只能保证在同侧）。
              parent = document.querySelector('[class*="settingsArea"]');
            }
          } catch {
            parent = null;
          }
          if (parent === null) return null;
          try {
            if (host.parentNode !== parent) parent.appendChild(host);
          } catch {
            return null;
          }
          return parent;
        };

        const sync = () => {
          scheduled = 0;
          const next = attach();
          setHolder((prev) => (prev === next ? prev : next));
        };
        const schedule = () => {
          if (scheduled !== 0) return;
          scheduled = window.setTimeout(sync, 60);
        };
        sync();
        if (typeof window.MutationObserver === 'function' && document.body !== null) {
          observer = new window.MutationObserver(schedule);
          observer.observe(document.body, { childList: true, subtree: true });
        }
        return () => {
          if (scheduled !== 0) window.clearTimeout(scheduled);
          if (observer !== null) observer.disconnect();
          const host = hostElRef.current;
          if (host !== null && host.parentNode !== null) {
            try {
              host.parentNode.removeChild(host);
            } catch {
              /* 容器已经整个被移除，无需处理 */
            }
          }
          hostElRef.current = null;
        };
      }, []);

      /**
       * 作用：请求宿主起服务，并把地址交给系统浏览器。
       * 返回：Promise<void>（不向调用方抛异常，失败写进 notice）。
       * 约束：请求体固定带 `openBrowser: true`：冷启动时由宿主用系统默认浏览器
       *   打开；复用分支宿主不会开窗口，此时由气泡补一个标签页。
       */
      const startService = async () => {
        if (busy === true) return;
        setBusy(true);
        setNotice('');
        setManualUrl('');
        try {
          const response = await fetch(OPEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ openBrowser: true }),
          });
          const payload = await response.json();
          if (!response.ok || payload === null || payload.ok !== true) {
            const reason = payload !== null && typeof payload.error === 'string'
              ? payload.error
              : `HTTP ${response.status}`;
            throw new Error(reason);
          }
          setStatus({ state: payload.state, port: payload.port, url: payload.url });
          setOpened(true);
          const url = typeof payload.url === 'string' ? payload.url : '';
          if (payload.browserOpened !== true && url !== '') {
            try {
              window.open(url, '_blank', 'noopener');
            } catch {
              setManualUrl(url);
              setNotice('浏览器没有允许自动打开，请手工复制下面的地址。');
            }
          }
        } catch (error) {
          setNotice(`打开失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setBusy(false);
        }
      };

      const info = describeService(status);

      /**
       * 入口：一颗只有一个字「咕」的小圆球。
       *
       * 形状照搬同机上的知乎插件（36×36 圆、单字、主色底、白字）：那是用户
       * 认可的参照物，所以这里不做原创设计。点击切换浮层，**不碰任何面板**。
       *
       * **位置**：宿主侧栏底部有两块容器 —— `footerActions`（`sidebar.footer.action`，
       * list 槽）和它下面的 `settingsArea`（`sidebar.settings`，**single 槽，只能有
       * 一个条目**）。用户要的是"排到「知」旁边"，而「知」在 `settingsArea` 里
       * （知乎插件绕过 single 槽直接往那个容器塞 DOM）。我们不抢 single 槽，而是
       * **继续注册在合法的 list 槽上，再把球 portal 到 `settingsArea` 容器**里：
       * 生命周期仍归 slot 管，位置与「知」同排。容器找不到（宿主结构变了/侧栏
       * 收起）就退回原位渲染，绝不崩。
       */
      const ball = h(
        'button',
        {
          type: 'button',
          style: open === true ? styles.ballActive : styles.ball,
          'aria-label': PANEL_LABEL,
          'aria-expanded': open === true,
          title: PANEL_LABEL,
          onClick: () => setOpen((prev) => prev !== true),
        },
        '咕',
      );

      /**
       * 球的落点：`settingsArea` 那个真实 DOM 容器。
       * 侧栏会重渲染并整体替换容器，所以用一个 MutationObserver 盯着 body 变化
       * 重新找；找不到就写 `null`（回落原位）。
       */
      const placed = holder !== null && ReactDOM !== null
        && typeof ReactDOM.createPortal === 'function'
        ? ReactDOM.createPortal(ball, holder)
        : ball;

      if (open !== true) return placed;

      /**
       * 浮层内容。遮罩与面板两层都是 position:fixed —— 不吃父容器的 overflow，
       * 也不需要跟着任何元素定位（它是居中的模态，不是气泡）。
       */
      const overlay = h(
        'div',
        {
          style: styles.overlayMask,
          onMouseDown: (event) => {
            // 只有点遮罩本身才关；点面板内部不算（面板的点击会冒泡到遮罩）。
            if (event.target === event.currentTarget) setOpen(false);
          },
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': `${PANEL_LABEL} 配置服务`,
            style: styles.overlayPanel,
          },
          h('div', { style: styles.overlayTitle }, `${PANEL_LABEL} · 配置`),
          h(
            'div',
            { style: styles.statusRow },
            h('span', { style: { ...styles.dot, background: DOT_COLOR[info.tone] } }),
            h('span', null, info.text),
          ),
          h(
            'button',
            {
              style: busy === true ? styles.buttonPrimaryOff : styles.buttonPrimary,
              disabled: busy === true,
              onClick: startService,
              ...(busy === true ? {} : hoverProps(COLOR.primaryFill, COLOR.primaryFillHover)),
            },
            busy === true
              ? '正在打开…'
              : (opened === true ? '再次打开' : '打开配置页'),
          ),
          notice === '' ? null : h('div', { style: styles.hint }, notice),
          manualUrl === '' ? null : h('input', {
            style: styles.manual,
            type: 'text',
            readOnly: true,
            value: manualUrl,
            'aria-label': '配置页地址',
            onFocus: (event) => {
              try {
                event.target.select();
              } catch {
                /* 选中失败不影响手工复制 */
              }
            },
          }),
        ),
      );

      // 挂到 document.body：浮层不参与侧栏的布局与层叠上下文。
      // 没有 react-dom（或没有 document）时退回渲染在原位 —— 样式仍是 fixed，
      // 只是可能被祖先的 transform/overflow 影响，但不会崩。
      if (ReactDOM !== null && typeof ReactDOM.createPortal === 'function'
        && typeof document !== 'undefined') {
        return h(React.Fragment, null, placed, ReactDOM.createPortal(overlay, document.body));
      }
      return h(React.Fragment, null, placed, overlay);
    }

    return {
      // 只依赖 slots。卡片不调用宿主的 connection RPC：它读写的是几条普通 HTTP
      // 路由，因此没有 connection 服务的部署里这张卡片同样可用。
      inject: ['slots'],

      /**
       * 纯逻辑出口。浏览器侧不使用本字段，仅供测试读取。
       * 内容：路由常量与两个纯函数（状态文案、主按钮文案）。
       * 约束：这里的每一项都是模块内部实现，不属于对外 API；集中导出是因为
       *   "状态文案写错"在浏览器里只表现为一行字不对，没有报错线索，只能靠
       *   直接调用纯函数来核对。
       */
      __pure: {
        CONFIG_SERVER_BASE,
        STATUS_URL,
        OPEN_URL,
        POLL_INTERVAL_MS,
        describeService,
        openButtonLabel,
      },

      apply(ctx) {
        // ① 设置里的原入口。内容同样是这张卡片：真正的配置界面在临时服务
        //    提供的独立网页里，设置页只保留入口本身，不重复实现一份表单。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'qq-proactive',
              order: 40,
              label: () => 'QQ 通道',
            },
            RemoteControlBall,
          ),
        );

        // ② 侧栏底部动作区的小圆球（「咕」）。**不注册面板**：注册在这里的
        //    条目是"动作"，点它不会触发宿主的 `selectPanel`，所以底下的对话
        //    不会被切走。形状照搬同机上的知乎插件（36×36 圆、单字、蓝色主色），
        //    那是用户认可的参照物。
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: PANEL_KEY,
              order: 0,
              label: () => PANEL_LABEL,
            },
            RemoteControlBall,
          ),
        );
      },
    };
  },
});
