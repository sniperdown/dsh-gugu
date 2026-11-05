/**
 * QQ 小鲸鱼配置页（独立网页）的浏览器侧入口。
 *
 * ## 运行形态
 *
 * 本文件是 **ES module**，由宿主临时启动的回环 HTTP 服务以静态文件送出
 * （`GET /app.js?t=<令牌>`），不需要任何构建步骤：没有 JSX、没有打包器、
 * 没有 npm 依赖。React 使用 `web/index.html` 里以 `<script src>` 加载的
 * 本地 UMD 构建（`preview/vendor/react.development.js` 与 `react-dom.development.js`），
 * 因此页面完全离线可用。
 *
 * 纯逻辑一律来自 `./logic.mjs`，本文件只负责取数、状态与渲染。这样安排的原因是：
 * 字段选择、整段折叠、草稿比较这些判定在浏览器里出错时没有报错线索，
 * 必须能脱离 DOM 单独测试（见 `test/web-config-page.test.mjs`）。
 *
 * ## 令牌
 *
 * 令牌只从页面地址的 `?t=` 取出，保存在模块作用域的常量里，**不写入
 * localStorage / sessionStorage / Cookie**。所有请求都用 `X-Config-Token` 头带上它；
 * 静态资源（`index.html` 里的 `<link>` / `<script>`）用 `?t=` 查询参数带上它，
 * 服务端对静态文件同样做令牌校验。
 *
 * `logic.mjs` 是一个 ES module，静态 `import` 无法附带查询参数，因此改用
 * 动态 `import('./logic.mjs?t=<令牌>')`。这也是本文件没有顶层静态 import 的原因。
 *
 * ## 心跳
 *
 * 页面每 5 秒 `POST /heartbeat` 一次。**不判断 `document.hidden`**：切走标签页
 * 就不发心跳的话，服务会在 15 秒后自行关闭，回来时页面已经是个死页。
 * 页面重新可见时再补发一次，用于抵消浏览器对后台页面定时器的节流。
 *
 * ## 写入（2026-10-28：合并成「保存全部」）
 *
 * **整页只有一个保存入口**：页面底部的固定条（`.save-bar`）。以前每张卡片各有
 * 一个「保存」，改了三个地方只点了其中一两个时，剩下的改动**根本没写进文件**，
 * 而界面上没有任何"还有东西没保存"的痕迹 —— 表现就是"改了配置没生效"。
 *
 * 一次「保存全部」提交**所有脏字段**（宿主 `POST /dsh-qq-proactive/config`
 * 一次只收一个 `{ scope, key, value }`），包括当前没显示的那个作用域的改动。
 * 只提交改动过的键 ⇒ 文件里没改的行逐字节不变（手写注释与格式不会被冲掉）。
 * 危险键（用户名单、provider / model…）照样先展开内联确认条，确认后才附带
 * `confirm: true`。写入成功不等于生效：宿主只改文件、不触发重载，界面因此显示
 * 「未生效（重载后生效）」；底部同一条里还有「重载插件」
 * （`POST /dsh-qq-proactive/reload`），先就地确认，再由宿主碰 `src/` 的 mtime
 * 逼 HMR 重载。
 *
 * ## 草稿表只有一张
 *
 * 「通道」页与「原文件」页**共用** `scopeDraft`，键为 `draftKey(作用域, key)`。
 * 两页曾经各有一张表，于是同一个键可以躺着两份互相矛盾的草稿，合并保存时无从
 * 判断该提交哪一份；现在同一个字段在哪个页面改过都只算一处改动。
 *
 * ## 重载后自动重连（2026-10-29）
 *
 * 点「重载插件」⇒ 插件重载 ⇒ **页面背后的临时 HTTP 服务跟着消失** ⇒ 这个页面再也
 * 请求不到东西。以前只能让用户自己回 DSH 重新点一次「QQ 小鲸鱼」；现在改成：
 *
 * 1. **任何一次请求失败**（网络错误 / 连接被拒 / 5xx / 响应不是 JSON）⇒ 进入重连态。
 *    判据在 `logic.isDisconnectError`：**4xx 不算** —— 那是活着的服务在拒绝这个请求
 *    （TOML 校验失败、需要 confirm），把整页盖住只会妨碍他看清那行错误；
 * 2. 整页盖一层轻量提示（不是 `alert`，它会连心跳一起停掉），写着"插件正在重载"、
 *    已等几秒、最多等多久；
 * 3. 每 1.5 秒重试一次 `GET /settings`，最多 30 秒（`logic.RECONNECT_*`）；
 *    成功 ⇒ 用**新数据**重渲染整页 ⇒「未生效（重载后生效）」那些红字由
 *    `logic.fieldInactive` 拿新的 `effective` 重算，一致了自然消失（不是"清空"）；
 *    超时 ⇒ 停止轮询，改成"去 DSH 看一眼"并给一个「再试一次」；
 * 4. 重连期间**只读**：只发那一个 GET，不写文件、不自动保存、不触发重载；
 * 5. **草稿全程保留**（页面没有刷新，`scopeDraft` 一直在内存里），连上之后还会明确
 *    写出"还有 N 处改动没保存"。
 */

/** 令牌的查询参数名（与服务端 `TOKEN_QUERY_KEY` 一致）。 */
const TOKEN_PARAM = 't';

/** 令牌的请求头名（服务端按小写读取）。 */
const TOKEN_HEADER = 'x-config-token';

/** 心跳间隔：5 秒。服务端 15 秒没有心跳就关闭。 */
const HEARTBEAT_MS = 5000;

/** 页面用到的两个既有 HTTP 路由；服务端把它们原样挂到临时服务上。 */
const ROUTES = {
  settings: '/dsh-qq-proactive/settings',
  config: '/dsh-qq-proactive/config',
  reload: '/dsh-qq-proactive/reload',
  heartbeat: '/heartbeat',
};

/**
 * 写入成功后的重载提示。
 *
 * 独立网页没有独立的「重载」标签页，但页面底部的保存条里就有「重载插件」按钮；
 * 文案同时保留「到 DSH 里重载」这条不依赖本页面的路。
 */
const RELOAD_HINT = '重载后生效（写入已落盘；点「重载插件」或到 DSH 里重载一次插件）';

/** 「重载插件」的就地确认文案（不用 `window.confirm`：它会阻塞整页渲染）。 */
const RELOAD_CONFIRM_TEXT = '重载会掐断她正在说的那一轮，确定重载？';

/**
 * 触发成功后的提示。
 *
 * 成功只代表**已经触发**：宿主碰完 mtime 就返回，HMR 随后才重载。临时配置服务的
 * 生命周期跟着插件，所以页面随后会断开 —— 这一点必须写出来，否则用户会以为页面坏了。
 * 2026-10-29 起断开之后**页面会自己接回来**（见 `web/logic.mjs` 的「重载后自动重连」
 * 一节与 `startReconnect`），因此这里改成"会自动重连，不用重开"。
 */
const RELOAD_DONE_TEXT = '已触发重载，2~3 秒后生效。配置页会自动重连，不用重新打开（最多等 30 秒）。';

/**
 * 「重载插件」按钮的内联小尺寸。
 *
 * 样式表里只有 `.button`（次级灰）与 `.button-primary`（主色），没有小号次级；
 * 重载不是主操作（保存才是），所以尺寸收在这个常量里，颜色仍由 `.button` 决定。
 */
const RELOAD_BUTTON_STYLE = { fontSize: '12px', padding: '2px 8px', minHeight: '26px' };

/**
 * 未保存改动的提醒文案（按卡片 / 整页两处共用）。
 *
 * 这句话必须点出「去哪儿保存」：只在控件旁边写"未保存"，用户仍然可能扫过去就忘。
 */
const DIRTY_CARD_HINT = '处未保存（底部「保存全部」）';

/** 页面顶层标签，顺序固定（2026-10-30：旁路模型拆成独立文件后，一页对应一份文件）。 */
const TABS = [
  { id: 'channel', label: '自定义', file: 'main' },
  { id: 'mood', label: '心情', file: 'mood' },
  { id: 'vision', label: '识图', file: 'vision' },
  { id: 'sticker', label: '表情包', file: 'sticker' },
  // 「语音」= 入站一条链（转写 `[voice]` + 情绪 `[emotion]`，同一个文件）＋出站 `[tts]`。
  // 出站为什么单独一个文件：换音色和换转写模型互不相干，合在一起回滚会连坐。
  { id: 'voice', label: '语音', files: ['voice', 'tts'] },
  // 提示词那几句固定话（身份/说话方式/群聊骨架）在主文件里，但单独一页 —— 2026-10-30。
  { id: 'prompt', label: '提示词', file: 'main' },
  { id: 'raw', label: '原文件' },
];

/** 页面地址里的令牌。只存在内存里，不落盘。 */
const TOKEN = new URLSearchParams(window.location.search).get(TOKEN_PARAM) || '';

/** 把异常压成一行可读文本。 */
function errorText(error) {
  if (error === null || error === undefined) return '未知错误';
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 在页面顶部显示启动失败的原因；用于模块加载或 React 缺失这类无法渲染的情况。 */
function showBootError(message) {
  const box = document.getElementById('boot-error');
  if (box === null) return;
  box.textContent = String(message);
  box.hidden = false;
  try {
    console.error('[qq-config]', message);
  } catch {
    /* 控制台不可用时无处可去 */
  }
}

/**
 * 请求临时服务上的路径并解析 JSON。
 *
 * 令牌放在 `X-Config-Token` 头里；响应不是 2xx 时抛出带 `line` / `detail` 的 `Error`，
 * 使 TOML 校验失败的行号与原因能显示到界面上。
 *
 * ## 抛出的错误带三种标记（供「该不该重连」判定，见 `logic.isDisconnectError`）
 *
 * - `network: true` —— `fetch` 自己抛了：连接被拒 / 服务已随插件消失。**没有响应**；
 * - `status` —— 有响应时的状态码。**4xx 是活着的服务在拒绝这个请求**，不是断开；
 * - `notJson: true` —— 2xx 但响应体不是 JSON（路由没挂上、被中间层换成了 HTML）。
 *
 * 之所以在这里打标记而不是让判定去猜：断开的判据是"有没有拿到一个像样的回答"，
 * 这个信息只有在拿到 `Response` 的这一层才有。
 */
async function api(pathname, { method = 'GET', body } = {}) {
  const init = {
    method,
    cache: 'no-store',
    headers: { [TOKEN_HEADER]: TOKEN },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(pathname, init);
  } catch (error) {
    const wrapped = new Error(errorText(error));
    wrapped.network = true;
    wrapped.cause = error;
    throw wrapped;
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail = payload !== null && (payload.error || payload.message)
      ? String(payload.error || payload.message)
      : `HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    error.line = payload !== null && payload.line !== undefined ? payload.line : null;
    error.detail = payload !== null && payload.detail !== undefined ? payload.detail : null;
    throw error;
  }
  if (payload === null) {
    const error = new Error('服务返回的不是 JSON（路由没挂上？）');
    error.status = response.status;
    error.notJson = true;
    throw error;
  }
  return payload;
}

/**
 * 用 React 造配置页组件。
 *
 * 写成工厂而非常量组件，是为了让组件闭包拿到本次加载的 `logic` 模块与
 * `React.createElement`；模块只加载一次，组件也只创建一次。
 *
 * @param {object} options
 * @param {Function} options.h `React.createElement`
 * @param {object} options.logic `web/logic.mjs` 的模块命名空间
 * @param {object} options.React React UMD 构建（`window.React`）
 * @returns {Function} React 组件
 */
function createApp({ h, logic, React }) {
  const { useState, useEffect, useCallback } = React;

  /**
   * 重连轮询的定时器句柄（**跨渲染**，因此放在这个作用域而不是组件函数体里）。
   *
   * 这里没有 `useRef` 可用：组件是拿一个**极简 React 替身**在 Node 里跑的
   * （`test/web-config-merged-save.test.mjs`、`test/web-config-reconnect.test.mjs`），
   * 那个替身只实现 useState / useEffect / useCallback。而 `createApp` 每挂载一次只
   * 被调用一次，把可变状态放在它的闭包里效果与 `useRef` 相同，且两个替身都认得。
   *
   * - `generation`：哪一轮轮询在跑。取消时 +1，在途的那一条下一次检查就自己退出；
   * - `timer`：正在等的那个 timeout 的 id（取消时要清掉，否则页面卡在旧的等待上）；
   * - `active`：是否已有一轮在跑，防止心跳失败 + 保存失败各起一条循环；
   * - `gaveUp`：已经放弃过（等满 30 秒）。**放弃之后不许被"顺手"重启** ——
   *   心跳每 5 秒失败一次，每失败一次都会调 `startReconnect('heartbeat')`；如果不挡住，
   *   界面会在"放弃了"和"又在等"之间来回翻，用户永远看不到那个「再试一次」按钮，
   *   而且轮询实际上根本没停。只有用户亲手点「再试一次」（`reason === 'retry'`）才算数。
   */
  const reconnectCtl = { generation: 0, timer: null, active: false, gaveUp: false };

  /**
   * 配置页主体。
   *
   * 数据只有一条来源：`GET /dsh-qq-proactive/settings` 的文件值 / 生效值 / 用户 /
   * 会话列表 / 字段表。写入只有一条通道：`POST /dsh-qq-proactive/config`。
   */
  function App() {
    // ---- 远程数据 ----
    const [remote, setRemote] = useState(null);
    const [remoteError, setRemoteError] = useState(null);
    const [loading, setLoading] = useState(true);

    // ---- 界面状态 ----
    const [activeTab, setActiveTab] = useState(TABS[0].id);
    /**
     * 旁路文件的备份列表（2026-10-30）。`files` 是 `{文件键: [{name, bytes, at}]}`；
     * 只有点过「载入备份列表」的文件才有键 —— "没查"与"查了没有备份"必须能分开。
     */
    const [backupState, setBackupState] = useState({ files: {}, error: '', busy: false });
    /** 「提示词」页的最终提示词预览（2026-10-30）：`{data, loading, error}`。 */
    const [promptPreview, setPromptPreview] = useState({ data: null, loading: false, error: '' });
    const [service, setService] = useState({ state: 'connecting', port: 0, error: '' });

    // ---- 「通道 / 原文件」共用的写入状态 ----
    //
    // 草稿表只保存改动过的字段：未改动的字段在渲染时现取 fields[].value，
    // 因此文件值刷新后控件会跟着更新，不会拿着一份过期快照写回文件。
    //
    // 键为 `draftKey(作用域, key)`，**两页共用同一张表**（详见文件头「草稿表只有
    // 一张」）。用户名单也在表里（`global::admins`）：它由「身份」卡与「原文件」
    // 页的 [owner] 卡两处渲染，共用一份草稿才不会出现两份互相矛盾的待写值。
    const [scopeId, setScopeId] = useState('global');
    const [scopeDraft, setScopeDraft] = useState({});
    const [zoomOpen, setZoomOpen] = useState({});
    const [channelFoldOpen, setChannelFoldOpen] = useState({});
    const [rawFoldOpen, setRawFoldOpen] = useState(false);
    const [writeBusy, setWriteBusy] = useState(false);
    const [writeMsg, setWriteMsg] = useState(null);
    // 危险键的内联确认条：整页只有一次保存，因此只用一个布尔量（不再按卡片 tag 归属）。
    const [confirmOpen, setConfirmOpen] = useState(false);

    // ---- 「重载插件」状态（与写入分开：重载不是保存流程的一部分） ----
    //
    // 重载不是保存的一部分，所以确认条与保存的确认条**互不挤掉**，各占一个状态位。
    const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
    const [reloadMsg, setReloadMsg] = useState(null);
    const [reloadBusy, setReloadBusy] = useState(false);

    // ---- 「重载后自动重连」状态（2026-10-29） ----
    //
    // `phase`：`idle`（正常）/ `waiting`（正在等插件回来，整页盖一层提示）/
    // `gaveUp`（等满 30 秒还没回来，停止轮询，给「再试一次」）。
    // `waitedMs` 由轮询本身累加（每等一次加一次），不另开一个计时器 —— 多一个每秒
    // 跳的定时器只为了让数字更平滑，却要在卸载时多管一份生命周期。
    // `recovered` 是"刚从断开里回来"的一次性提示（保存条上显示"已重新连上…"）。
    const [reconnect, setReconnect] = useState({ phase: 'idle', waitedMs: 0, recovered: false });

    // 「把改动抄下来」的结果：`copied`（已进剪贴板）/ `manual`（浏览器不让复制，
    // 于是把文本摊在框里让人自己全选）。只在重连失败后用得上。
    const [dumpState, setDumpState] = useState({ kind: '', text: '' });

    /**
     * 读取整份配置页数据。
     *
     * `quiet` 用于写入之后的静默刷新：不清空已有数据、不显示「正在读取」，
     * 以免界面在写入结果提示旁边闪一下空白。
     */
    const loadSettings = useCallback(async ({ quiet = false } = {}) => {
      if (!quiet) setLoading(true);
      try {
        const payload = await api(ROUTES.settings);
        if (payload !== null && payload.ok === false) {
          throw new Error(String(payload.error || '读取配置失败'));
        }
        setRemote(payload);
        setRemoteError(null);
        return payload;
      } catch (error) {
        setRemoteError(errorText(error));
        // 读不到配置有两种：服务活着但拒绝（4xx / `ok:false`，留在横幅里给他看），
        // 和服务**不在了**（连接被拒 / 5xx / 不是 JSON）—— 后者就是重载把服务带走了，
        // 进重连，别让他自己去猜"是不是页面坏了"。
        if (logic.isDisconnectError(error)) startReconnect('settings');
        return null;
      } finally {
        if (!quiet) setLoading(false);
      }
    }, []);

    // ------------------------------------------------------------------ //
    // 重连（2026-10-29）
    //
    // 为什么要这一段：点「重载插件」之后，插件重载 ⇒ **页面背后的临时 HTTP 服务跟着
    // 消失** ⇒ 这个页面从此请求不到任何东西，以前只能让用户自己回 DSH 重新打开
    // 「QQ 小鲸鱼」。现在改成：发现断开 ⇒ 整页盖一层轻量提示 ⇒ 每 1.5 秒重试
    // `GET /settings`，最多 30 秒 ⇒ 一回来就用**新数据**重渲染整页。
    //
    // 两条硬约束：
    //
    // 1. **重连期间只读**：轮询只发这一个 GET，不写文件、不自动保存、不触发重载。
    //    用户的草稿还在内存里（页面没有刷新），连上之后照旧点「保存全部」。
    // 2. **这里的异常一律自己吞掉**：轮询挂在定时器上，属于"热路径上的回调"，
    //    抛出去会打到 `window.onerror`（插件项目里这条规矩是血泪换来的）。所以
    //    循环体全程 try/catch，外层的 promise 还有一个 `.catch` 兜底。
    // ------------------------------------------------------------------ //

    /**
     * 取一个定时器函数：优先 `window` 上的（浏览器与测试替身），回落全局，都没有则 null。
     *
     * 不直接写 `window.setTimeout`：`window` 在 Node 侧的测试里是替身，可能只提供
     * 部分函数；拿不到时"立即继续"比"永远等下去"安全。
     */
    function timerOf(name) {
      try {
        if (typeof window !== 'undefined' && window !== null && typeof window[name] === 'function') {
          return window[name].bind(window);
        }
      } catch {
        /* 取不到就回落 */
      }
      try {
        if (typeof globalThis !== 'undefined' && typeof globalThis[name] === 'function') {
          return globalThis[name].bind(globalThis);
        }
      } catch {
        /* 同上 */
      }
      return null;
    }

    /** 等 `ms` 毫秒。没有定时器可用时立即返回（宁可多试一次，也不要把重连卡死）。 */
    function waitFor(ms) {
      return new Promise((resolve) => {
        const setTimer = timerOf('setTimeout');
        if (setTimer === null) {
          resolve();
          return;
        }
        try {
          reconnectCtl.timer = setTimer(() => {
            reconnectCtl.timer = null;
            resolve();
          }, ms);
        } catch {
          resolve();
        }
      });
    }

    /** 停掉在途的等待，并让正在跑的那一轮轮询作废（generation +1 是判据）。 */
    function cancelReconnect() {
      reconnectCtl.generation += 1;
      reconnectCtl.active = false;
      reconnectCtl.gaveUp = false;
      const clear = timerOf('clearTimeout');
      if (reconnectCtl.timer !== null && clear !== null) {
        try {
          clear(reconnectCtl.timer);
        } catch {
          /* 定时器已经跑过了 */
        }
      }
      reconnectCtl.timer = null;
    }

    /**
     * 进入「重连中」并启动轮询。
     *
     * `reason` 决定两件事：首轮要不要先等一个宽限期（`'reload'` 是"我们刚让它重载"，
     * 服务还要过 1~2 秒才真的消失），以及**这一下能不能越过"已放弃"**（只有用户亲手点
     * 的 `'retry'` 可以）。见 `reconnectCtl.gaveUp` 的说明。
     */
    function startReconnect(reason) {
      if (reconnectCtl.active === true) return;
      if (reconnectCtl.gaveUp === true && reason !== 'retry') return;
      reconnectCtl.active = true;
      reconnectCtl.gaveUp = false;
      reconnectCtl.generation += 1;
      const generation = reconnectCtl.generation;
      const graceMs = reason === 'reload' ? logic.RECONNECT_RELOAD_GRACE_MS : 0;
      // 先盖上提示再轮询：断开的这 1.5 秒里界面必须已经在说"我在等"，否则又是一次
      // "点了没反应"。
      setDumpState({ kind: '', text: '' });
      setReconnect({ phase: 'waiting', waitedMs: 0, recovered: false });
      runReconnect(generation, graceMs).catch((error) => {
        // 兜底：轮询里任何没预料到的异常都降级成"放弃"，绝不抛回事件循环。
        if (reconnectCtl.generation !== generation) return;
        reconnectCtl.active = false;
        reconnectCtl.gaveUp = true;
        setReconnect({ phase: 'gaveUp', waitedMs: logic.RECONNECT_MAX_WAIT_MS, recovered: false });
        try {
          console.warn('[qq-config] 重连轮询出错：', errorText(error));
        } catch {
          /* 控制台不可用 */
        }
      });
    }

    /**
     * 轮询本体：每 `RECONNECT_INTERVAL_MS` 试一次 `GET /settings`，成功即用新数据重渲染。
     *
     * 为什么"成功"就等于"插件回来了"：临时服务是插件启动时起的，服务能回答 `/settings`，
     * 说明新的插件实例已经起来了 —— 这也正是 `/settings` 里 `effective` 会跟着变的时刻，
     * 因此「未生效（重载后生效）」那些红字**不需要专门去清**：`setRemote(payload)` 之后
     * 渲染时 `logic.fieldInactive` 会拿**新的** `effective` 重算一遍，一致了自然不显示。
     *
     * 预算按**累计等待时间**算，不按次数：宽限期（2 秒）也算在里面，所以"最多等 30 秒"
     * 是墙上的 30 秒，而不是"30 次 × 1.5 秒"。
     */
    async function runReconnect(generation, graceMs) {
      let waitedMs = 0;
      let attempt = 0;
      for (;;) {
        if (reconnectCtl.generation !== generation) return;
        const budget = logic.RECONNECT_MAX_WAIT_MS - waitedMs;
        if (budget <= 0) break;
        const delay = Math.min(logic.reconnectPollDelay(attempt, graceMs), budget);
        await waitFor(delay);
        if (reconnectCtl.generation !== generation) return;
        waitedMs += delay;
        attempt += 1;
        let payload = null;
        try {
          // 只发这一个 GET：重连期间不碰写接口。
          payload = await api(ROUTES.settings);
          if (payload !== null && payload.ok === false) {
            throw new Error(String(payload.error || '读取配置失败'));
          }
        } catch {
          if (reconnectCtl.generation !== generation) return;
          // 还连不上（或者回来了但这次读失败）：只更新已等待秒数，继续等。
          setReconnect({ phase: 'waiting', waitedMs, recovered: false });
          continue;
        }
        if (reconnectCtl.generation !== generation) return;
        cancelReconnect();
        setRemote(payload);
        setRemoteError(null);
        setLoading(false);
        setReconnect({ phase: 'idle', waitedMs: 0, recovered: true });
        try {
          // 2026-10-29：源侧改成固定端口 + 令牌跨重载复用之后，端口**通常**没变；
          // 但「端口被占 ⇒ 回退随机」和「状态文件被删」两种情况下仍会变。补一次心跳
          // 拿真实端口，比假设它没变稳。它没有副作用，也不算"写配置"。
          const beat = await api(ROUTES.heartbeat, { method: 'POST' });
          setService({ state: beat.state, port: beat.port, error: '' });
        } catch {
          // 心跳失败不影响"重连成功"这个结论：`/settings` 已经回话了。
          setService((prev) => ({ ...prev, state: 'running', error: '' }));
        }
        return;
      }
      // 预算用完 ⇒ 停止轮询，把"去 DSH 看一眼"和「再试一次」交给人。
      reconnectCtl.active = false;
      reconnectCtl.gaveUp = true;
      setReconnect({ phase: 'gaveUp', waitedMs: logic.RECONNECT_MAX_WAIT_MS, recovered: false });
    }

    useEffect(() => {
      loadSettings();
    }, [loadSettings]);

    // 心跳：每 5 秒一次，页面隐藏时照常发送（服务端以 15 秒无心跳为唯一关闭判据）。
    // 页面重新可见时补发一次，抵消浏览器对后台标签页定时器的节流。
    useEffect(() => {
      let cancelled = false;
      const beat = async () => {
        try {
          const got = await api(ROUTES.heartbeat, { method: 'POST' });
          if (!cancelled) {
            setService({ state: got.state, port: got.port, error: '' });
          }
        } catch (error) {
          if (!cancelled) {
            setService((prev) => ({ ...prev, state: 'unreachable', error: errorText(error) }));
          }
          // 心跳是**最早发现"服务没了"的那条线**（每 5 秒一次，比用户动手快），
          // 所以断开检测也挂在这里。`cancelled` 只管"组件还在不在"，重连该不该起
          // 由 `startReconnect` 自己按 active 去重。
          if (logic.isDisconnectError(error)) startReconnect('heartbeat');
        }
      };
      beat();
      const timer = window.setInterval(beat, HEARTBEAT_MS);
      const onVisible = () => {
        beat();
      };
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', onVisible);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
      };
    }, []);

    const remoteFields = remote !== null && Array.isArray(remote.fields) ? remote.fields : [];
    const remoteScopes = remote !== null && Array.isArray(remote.scopes) ? remote.scopes : [];
    const fileAdmins = remote !== null && remote.owner && Array.isArray(remote.owner.admins)
      ? remote.owner.admins.map((id) => String(id))
      : [];
    const tabs = logic.scopeTabs(remoteScopes);
    const currentScope = logic.resolveScopeId(tabs, scopeId);
    const currentKind = logic.scopeKindOf(currentScope);
    const currentFields = logic.selectScopeFields(remoteFields, currentScope);

    /** 拉「最终提示词预览」（2026-10-30）。作用域跟着上面的全局/私聊/群选择走。 */
    async function loadPromptPreview() {
      setPromptPreview((prev) => ({ ...prev, loading: true, error: '' }));
      try {
        const data = await api(`/dsh-qq-proactive/prompt-preview?scope=${encodeURIComponent(currentScope)}`);
        setPromptPreview({ data, loading: false, error: '' });
      } catch (error) {
        setPromptPreview({ data: null, loading: false, error: errorText(error) });
      }
    }

    // 切到「提示词」页且还没拉过 ⇒ 自动拉一次（用户点进来就该看见东西，不用再点按钮）。
    useEffect(() => {
      if (activeTab !== 'prompt') return;
      if (promptPreview.data !== null || promptPreview.loading) return;
      loadPromptPreview();
    }, [activeTab]);


    /**
     * 「身份」卡渲染的 admins 字段。
     *
     * 宿主每次都会把 `admins` 放进字段表（`CONFIG_FIELDS` 里有一项），这里仍留一条
     * 兜底：字段表里没有它时自己造一个，**并且照样进「保存全部」的收集范围** ——
     * 少了它，身份卡上改的名字会落在收集范围之外，那正是"改了没保存"的形状。
     */
    const adminField = remoteFields.find((field) => logic.textOf(field && field.key) === 'admins')
      ?? {
        key: 'admins',
        section: 'owner',
        scope: 'global',
        type: 'array',
        value: fileAdmins,
        effective: fileAdmins,
      };

    /** 把某个字段的草稿值写入指定的草稿表（键带作用域前缀）。 */
    const setDraftValue = (setStore, prefix, field, value) => {
      setStore((prev) => ({ ...prev, [logic.draftKey(prefix, field.key)]: value }));
    };

    /** 从指定草稿表中删除若干键；只删明确指定的键，未写入成功的草稿必须保留。 */
    const dropDrafts = (setStore, keys) => {
      setStore((prev) => {
        const next = { ...prev };
        for (const key of keys) delete next[key];
        return next;
      });
    };

    /** 切换单个多行输入框的放大状态；键带作用域前缀，不跨会话串用。 */
    const toggleZoom = (key) => {
      setZoomOpen((prev) => {
        const next = { ...prev };
        if (next[key] === true) delete next[key];
        else next[key] = true;
        return next;
      });
    };

    /** 某个作用域里**可写**的全部字段（global 含 `admins`，会话层只有人格五段）。 */
    function writableFieldsFor(id) {
      const list = logic.writableScopeFields(remoteFields, id);
      if (logic.scopeKindOf(id) !== 'global') return list;
      if (list.some((field) => logic.textOf(field && field.key) === 'admins')) return list;
      return [...list, adminField];
    }

    /**
     * 参与「保存全部」的全部条目：**跨作用域、跨两页**，只含改动过的字段。
     *
     * 这是合并保存的核心。草稿里躺着哪个作用域、哪个字段的改动，就提交哪些 ——
     * 用户改了 A 群、切到 B 群、又改了两处，一次保存要全部落盘；只在当前卡片里
     * 找改动，就等于把"没点的那几个保存"重新发明了一遍。
     *
     * 每个 `(scope, key)` 只会出现一次：草稿表本身按这个口径做键
     * （见文件头「草稿表只有一张」）。
     */
    function allDirtyEntries() {
      const ids = [];
      for (const tab of tabs) {
        const id = logic.textOf(tab && tab.id);
        if (id !== '' && !ids.includes(id)) ids.push(id);
      }
      // 当前选中的作用域一定在列表里，但留这条兜底：选中项若因白名单变化被剔除，
      // `resolveScopeId` 会回落到 global，而 global 永远在 tabs 里 —— 不重复加入。
      if (!ids.includes(currentScope)) ids.push(currentScope);
      const entries = [];
      for (const id of ids) {
        entries.push(...logic.dirtyEntriesFor(writableFieldsFor(id), scopeDraft, id));
      }
      return entries;
    }

    /**
     * 清除写入成功条目的草稿，使控件回到「显示文件值」的状态。
     *
     * 只清**明确成功**的那些键：失败项与没轮到的项必须留着，否则用户以为改动还在、
     * 界面却已经摆出文件值，下一次保存就悄无声息地少了这几处。
     */
    function forgetEntries(entries) {
      const keys = entries.map((entry) => logic.draftKey(entry.scope, entry.key));
      if (keys.length > 0) dropDrafts(setScopeDraft, keys);
    }

    /** 一张卡片里有多少处未保存的改动（只用于提示，不参与写入）。 */
    function dirtyCountFor(fields, prefix) {
      return logic.dirtyEntriesFor(fields, scopeDraft, prefix).length;
    }

    /** 丢弃一张卡片的草稿，回到文件里的值（不碰文件，只丢草稿）。 */
    function restoreFields(fields, prefix) {
      dropDrafts(setScopeDraft, fields.map((field) => logic.draftKey(prefix, field.key)));
      setConfirmOpen(false);
    }

    /**
     * 逐字段写入。
     *
     * 宿主一次只接受一个键，因此必须逐个发送；第一个失败即停止 —— 后续写入以
     * 「前面全部成功」为前提，继续发送只会留下半套已写、半套未写的状态。
     */
    async function writeEntries(entries) {
      const results = [];
      for (const entry of entries) {
        const body = { scope: entry.scope, key: entry.key, value: entry.value };
        if (entry.confirm === true) body.confirm = true;
        try {
          const got = await api(ROUTES.config, { method: 'POST', body });
          results.push({ ok: true, key: entry.key, label: entry.label, payload: got });
        } catch (error) {
          results.push({
            ok: false,
            key: entry.key,
            label: entry.label,
            error: errorText(error),
            line: error && error.line !== undefined ? error.line : null,
            detail: error && error.detail !== undefined ? error.detail : null,
          });
          // 写配置时连接被拒 ⇒ 插件正在重载/已经没了。这里既要报"这一条没写进去"，
          // 也要把页面切到重连态 —— 否则之后的每一条都会各报一次同样的错。
          if (logic.isDisconnectError(error)) startReconnect('write');
          break;
        }
      }
      return results;
    }

    /**
     * 执行一次写入，并按结果更新提示、清除草稿、刷新文件值与生效值。
     *
     * 只有经过确认条时，危险键才附带 `confirm: true`；写入成功不等于生效，
     * 因此这里不触发重载，只静默重读一次 `/settings`。
     *
     * 结果提示是**整页一条**（不再按卡片归属）：一次保存可能横跨几个作用域、
     * 两页的卡片，提示如果挂在哪张卡上，其余卡片上的改动成功与否就没人说。
     */
    async function doWrite(entries, confirmed) {
      setWriteBusy(true);
      setConfirmOpen(false);
      setWriteMsg(null);
      // 「已重新连上」那条提示只说明"刚回来"这一件事；开始写入了就该让位给写入结果。
      setReconnect((prev) => (prev.recovered === true ? { ...prev, recovered: false } : prev));
      try {
        const results = await writeEntries(
          entries.map((entry) => ({
            ...entry,
            confirm: confirmed === true && entry.danger === true,
          })),
        );
        setWriteMsg(logic.describeWriteResults(results, RELOAD_HINT));
        // 只认**明确成功**的条目：`writeEntries` 在第一个失败处停下，后面的条目
        // 在 results 里没有位置，草稿必须留着（否则那几处改动就凭空消失了）。
        const written = entries.filter((entry, index) => results[index] !== undefined
          && results[index].ok === true);
        forgetEntries(written);
        if (written.length > 0) await loadSettings({ quiet: true });
      } catch (error) {
        setWriteMsg({ kind: 'error', text: errorText(error) });
      } finally {
        setWriteBusy(false);
      }
    }

    /**
     * 触发一次插件重载（`POST /dsh-qq-proactive/reload`）。
     *
     * 宿主只碰 `src/` 的 mtime 逼 HMR 重载，因此这里不等"重载完成"：响应回来就说明
     * 已经触发。**失败必须把原因显示出来** —— 重载是让写入生效的唯一手段，吞掉错误
     * 就等于"点了没反应"。
     *
     * 2026-10-29：触发成功**立刻**进入重连态。这里不等断开确实发生再反应 ——
     * 那时页面已经有几秒钟"看着好好的、其实背后已经没人了"，用户可能正在改东西。
     * 首轮轮询会延后一个宽限期（`RECONNECT_RELOAD_GRACE_MS`），避开"服务还没死"的抖动。
     */
    async function doReload() {
      setReloadBusy(true);
      setReloadConfirmOpen(false);
      setReloadMsg(null);
      try {
        await api(ROUTES.reload, { method: 'POST' });
        setReloadMsg({ kind: 'ok', text: RELOAD_DONE_TEXT });
        startReconnect('reload');
      } catch (error) {
        setReloadMsg({ kind: 'error', text: `重载失败：${errorText(error)}` });
        if (logic.isDisconnectError(error)) startReconnect('reload');
      } finally {
        setReloadBusy(false);
      }
    }

    /**
     * 「保存全部」的入口：无改动直接提示，命中危险键先展开确认条，否则直接写入。
     *
     * 条目在这里现算一遍（`allDirtyEntries()`），不用渲染时的快照。
     */
    function askSave() {
      // 重连期间不写文件：服务那边可能正处在"旧实例已卸载、新实例还没起"的中间态，
      // 这时写进去的每一条都可能落进一个马上要被丢掉的文件句柄里。草稿不会丢，
      // 等回来再点一次就行。
      if (reconnect.phase !== 'idle') {
        setWriteMsg({ kind: 'warn', text: '正在等插件回来，这期间的改动只留在页面上；连上之后再点「保存全部」。' });
        return;
      }
      const entries = allDirtyEntries();
      if (entries.length === 0) {
        setWriteMsg({ kind: 'info', text: '没有改动（只提交动过的字段）' });
        return;
      }
      if (entries.some((entry) => entry.danger === true)) {
        setConfirmOpen(true);
        setWriteMsg(null);
        return;
      }
      doWrite(entries, false);
    }

    /** 丢弃整页的草稿（等于把这次所有未保存的改动都撤掉，不碰文件）。 */
    function discardAllDrafts() {
      setScopeDraft({});
      setConfirmOpen(false);
    }

    /**
     * 把写入结果提示按种类换成配色类名。
     *
     * 沿用原来的三档：失败红、成功绿、其余灰。
     */
    function messageClass(kind) {
      if (kind === 'error') return 'error';
      if (kind === 'ok') return 'hint-ok';
      if (kind === 'warn') return 'hint-warn';
      return 'hint';
    }

    /**
     * 渲染一张卡片的操作行：**只留「恢复为文件里的值」**与本卡的未保存提示。
     *
     * 保存已经不在这里了 —— 它是整页一个动作（页面底部固定的「保存全部」）。
     * 病根就是"每张卡各有一个保存按钮"：改了三个地方只点一两个，剩下的改动
     * 根本没写入文件，而界面上没有任何痕迹。
     *
     * 恢复仍按卡片走：它只丢**本卡**的草稿、不碰文件，误伤的代价只是重新输入本卡，
     * 比"整页一起恢复"小得多。
     */
    function renderCardActions(fields, prefix) {
      const count = dirtyCountFor(fields, prefix);
      return h(
        'div',
        { className: 'actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'button',
            disabled: writeBusy,
            title: '丢弃本卡的草稿，回到文件里的值（不碰文件）',
            onClick: () => restoreFields(fields, prefix),
          },
          '恢复为文件里的值',
        ),
        count === 0
          ? null
          : h('span', { className: 'hint-warn' }, `本卡 ${count} ${DIRTY_CARD_HINT}`),
      );
    }

    /**
     * 「重载插件」的就地确认条。
     *
     * 与保存确认同一套 `.confirm` 样式，但**不共用 `confirmOpen`**：重载不是写入，
     * 两者可以同时展开（例如保存确认条还开着又点了重载），互不挤掉。
     */
    function reloadConfirmBar() {
      if (reloadConfirmOpen !== true) return null;
      return h(
        'div',
        { className: 'confirm' },
        h('div', { className: 'confirm-text' }, RELOAD_CONFIRM_TEXT),
        h(
          'div',
          { className: 'actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'button button-warning',
              disabled: reloadBusy,
              onClick: () => doReload(),
            },
            '确定',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'button',
              disabled: reloadBusy,
              onClick: () => setReloadConfirmOpen(false),
            },
            '取消',
          ),
        ),
      );
    }

    /**
     * 页面底部的固定保存条：**整页唯一的保存入口**。
     *
     * 位置固定在视口底边（`position: sticky; bottom: 0`），切页、滚到哪儿都在 ——
     * 用户找不到它，这次合并就白做了。条里从上到下是：
     *
     * 1. 危险键的内联确认条（合并保存时牵涉危险键仍然要确认）；
     * 2. 上一次写入的结果；
     * 3. 还有几处没保存（把条目摘要写出来，形如「全局 · 人格、群 30000013 · 行为规则」）；
     * 4. 按钮：保存全部（带处数）/ 重载插件 / 撤销全部改动；
     * 5. 重载确认条与重载结果。
     *
     * `entries` 由调用方现算（`allDirtyEntries()`），因此确认条里的条目始终是
     * 当前草稿算出来的，不会写着旧值。
     */
    function renderSaveBar(entries) {
      const count = entries.length;
      const dangerKeys = entries.filter((entry) => entry.danger === true).map((entry) => entry.key);
      // 重连期间把**联网**的两个按钮关掉（写文件 / 触发重载）：服务那边可能正处于
      // "旧实例已卸载、新实例还没起"的中间态，这时的请求要么失败要么打到马上就要
      // 消失的实例上。草稿与本地的「撤销全部改动」不受影响。
      const offline = reconnect.phase !== 'idle';
      return h(
        'div',
        { className: 'save-bar', role: 'group', 'aria-label': '保存' },
        confirmOpen
          ? h(
              'div',
              { className: 'confirm' },
              h(
                'div',
                { className: 'confirm-text' },
                count === 0
                  ? '这些改动已经恢复成文件里的值，没有要写的内容了。'
                  : `即将写入 ${count} 处：${entries.map((entry) => `${entry.scope} · ${entry.key}`).join('、')}。确认后带 confirm:true 重发；写入前宿主会先备份整份 toml。\n${logic.dangerNote(dangerKeys)}`,
              ),
              h(
                'div',
                { className: 'actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'button button-warning',
                    disabled: writeBusy || count === 0 || offline,
                    onClick: () => doWrite(entries, true),
                  },
                  '确认写入',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'button',
                    disabled: writeBusy,
                    onClick: () => setConfirmOpen(false),
                  },
                  '取消',
                ),
              ),
            )
          : null,
        writeMsg === null
          ? null
          : h('div', { className: messageClass(writeMsg.kind) }, writeMsg.text),
        // 「刚重新连上」那一条：处数**每次渲染现算**（`count` 来自当前草稿），因此
        // 用户接着改了几处它也跟着变，不会写着一个过期的数字。
        reconnect.phase === 'idle' && reconnect.recovered === true
          ? h(
              'div',
              { className: count > 0 ? 'hint-warn' : 'hint-ok' },
              logic.reconnectRecoveredText(count),
            )
          : null,
        count === 0
          ? null
          : h(
              'div',
              { className: 'hint-warn' },
              `还有 ${count} 处没保存：${logic.describeDirtyEntries(entries, scopeLabels())}`,
            ),
        h(
          'div',
          { className: 'actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'button button-primary',
              disabled: writeBusy || remote === null || count === 0 || offline,
              title: '把所有改动过的字段逐个写进它所属的那份文件（旁路写自己的、主文件写 qq-gugu.toml；没改的键原样不动）',
              onClick: () => askSave(),
            },
            writeBusy ? '写入中…' : logic.saveAllLabel(count),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'button',
              style: RELOAD_BUTTON_STYLE,
              disabled: writeBusy || reloadBusy || offline,
              title: '触发插件重载（碰 src/ 的 mtime 逼 HMR）；写入要靠它才生效',
              onClick: () => {
                setReloadConfirmOpen(true);
                setReloadMsg(null);
              },
            },
            reloadBusy ? '重载中…' : '重载插件',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'button',
              disabled: writeBusy || count === 0,
              title: '丢弃整页的草稿（不碰文件）',
              onClick: () => discardAllDrafts(),
            },
            '撤销全部改动',
          ),
        ),
        reloadConfirmBar(),
        reloadMsg === null
          ? null
          : h(
              'div',
              { className: reloadMsg.kind === 'error' ? 'field-error' : 'hint-ok' },
              reloadMsg.text,
            ),
      );
    }

    /**
     * 作用域 id → 摘要里用的短名（`{ global: '全局', 'group:1': '群 1', … }`）。
     *
     * 摘要给的是"改在哪儿"，所以群/私聊用号码或昵称，不用 `group:30000013` 这种
     * 技术标识；名字取不到时回落成号码。
     */
    function scopeLabels() {
      const labels = { global: '全局' };
      for (const tab of tabs) {
        if (tab.id === 'global' || tab.id === '') continue;
        const raw = tab.id.replace(/^(private|group):/, '');
        const name = tab.top !== '' ? tab.top : raw;
        labels[tab.id] = `${tab.kind === 'group' ? '群' : '私聊'} ${name}`;
      }
      return labels;
    }

    /**
     * 渲染单个配置字段，占一行：左侧为字段名与 key，右侧为控件与状态行。
     *
     * 控件形态由 `type` 决定：bool 为勾选框，enum 为下拉，multiline 与 array 为
     * 多行文本框（仅前者可双击放大），number 为数字输入框，其余为单行输入框。
     */
    function renderField(field, store, setStore, prefix, first) {
      const draft = logic.draftOf(store, prefix, field);
      const set = (value) => setDraftValue(setStore, prefix, field, value);
      const type = logic.textOf(field.type);
      const zoomable = logic.isZoomableField(field);
      const key = logic.zoomKey(prefix, field.key);
      const zoomed = zoomable && zoomOpen[key] === true;
      const placeholder = logic.fieldPlaceholder(field);
      let control;
      if (type === 'bool') {
        control = h(
          'label',
          { className: 'checkbox-row' },
          h('input', {
            type: 'checkbox',
            checked: draft === true,
            onChange: (event) => set(event.target.checked),
          }),
          draft === true ? '开' : '关',
        );
      } else if (type === 'enum') {
        const options = logic.fieldOptions(field);
        const current = logic.textOf(draft);
        control = h(
          'select',
          { className: 'input', value: current, onChange: (event) => set(event.target.value) },
          current === '' || !options.includes(current)
            ? h('option', { value: '', className: 'option' }, '（未写）')
            : null,
          ...options.map((option) => h('option', { key: option, value: option, className: 'option' }, option)),
        );
      } else if (type === 'multiline' || type === 'array') {
        // array 按「一行一个」显示；逗号与空格同样可作分隔符，本文件与宿主两侧都接受。
        control = h('textarea', {
          className: zoomed ? 'textarea zoomed' : 'textarea',
          value: logic.textOf(draft),
          placeholder,
          // 平时固定三行；放大后按内容计算行数，不设上限。
          rows: zoomed ? logic.textareaZoomRows(logic.toInputValue(field, draft)) : logic.TEXTAREA_ROWS,
          // 悬停提示随放大状态切换；array 不参与放大，因此没有这个提示。
          title: zoomable ? logic.zoomTitle(zoomed) : undefined,
          // 必须绑定双击：单击需要保留给「把光标放进输入框」，不能被布局切换抢走。
          onDoubleClick: zoomable ? () => toggleZoom(key) : undefined,
          onChange: (event) => set(event.target.value),
        });
      } else {
        control = h('input', {
          className: 'input',
          type: type === 'number' ? 'number' : 'text',
          value: logic.textOf(draft),
          placeholder,
          onChange: (event) => set(event.target.value),
        });
      }
      const rowClass = zoomed
        ? (first === true ? 'field-row zoomed first' : 'field-row zoomed')
        : `${logic.fieldCompact(field) ? 'field-row compact' : 'field-row'}${first === true ? ' first' : ''}`;
      const hint = logic.fieldHint(field);
      return h(
        'div',
        { key: field.key, className: rowClass },
        h(
          'div',
          { className: 'field-label-box' },
          h('div', { className: 'field-label' }, logic.fieldLabel(field)),
          h('div', { className: 'field-key' }, logic.textOf(field.key)),
        ),
        h(
          'div',
          { className: 'field-control-box' },
          control,
          // 说明那一行小字（2026-10-29）：只有客户端登记过 / 载荷带了的字段才有，
          // 没有就**不渲染**（空的说明行比没有说明更像坏了）。
          hint === '' ? null : h('div', { className: 'hint' }, hint),
          logic.fieldInactive(field)
            ? h('div', { className: 'field-error' }, '未生效（重载后生效）')
            : null,
        ),
      );
    }

    /**
     * 渲染一串字段（2026-10-30）：宽字段一行一个，**窄字段两三个挤一行**。
     *
     * 判据在 `logic.fieldCompact()`：数字 / 开关 / 下拉是窄的（一行放 2~3 个），
     * 文本与多行是宽的全行（可能是路径、提示词、名单）。
     * 连续几个窄字段会攒进一个 `.field-grid`，由 CSS 的 auto-fill 决定一行几个 ——
     * 窗口窄时自动掉到一行两个/一个，不用 JS 量宽度。
     *
     * @param {object[]} fields
     * @param {string} prefix 草稿前缀（作用域名）
     * @returns {object[]} React 节点
     */
    function renderFields(fields, prefix) {
      const nodes = [];
      let grid = [];
      const flush = () => {
        if (grid.length === 0) return;
        nodes.push(h(
          'div',
          { key: `grid-${prefix}-${grid[0].key}`, className: 'field-grid' },
          ...grid.map((field) => renderField(field, scopeDraft, setScopeDraft, prefix, false)),
        ));
        grid = [];
      };
      for (const field of fields) {
        if (logic.fieldCompact(field)) {
          grid.push(field);
          continue;
        }
        flush();
        nodes.push(renderField(field, scopeDraft, setScopeDraft, prefix, nodes.length === 0));
      }
      flush();
      return nodes;
    }

    /**
     * 渲染「按会话配置」的二级标签栏。
     *
     * 两层文字：上层为会话名、下层为号码；名字为空时整行只显示号码。
     *
     * 切标签**只换作用域，不动草稿与提示**：草稿两页共用一张表、按作用域分键，
     * 提示挂在底部保存条上 —— 两者都与"当前显示哪一段"无关。以前这里顺手清了
     * 确认条与提示（它们当时按卡片归属），现在照着清就会把没保存的改动提示抹掉，
     * 正是这次要治的"改完就忘"。
     */
    function renderScopeTabs() {
      return h(
        'div',
        { className: 'subtabs', role: 'group', 'aria-label': '按会话配置' },
        ...tabs.map((tab) => {
          const active = tab.id === currentScope;
          const bottom = tab.bottom === '' ? tab.id : tab.bottom;
          const badge = tab.badge === ''
            ? null
            : h('span', { className: 'pill-warn' }, tab.badge);
          return h(
            'button',
            {
              key: tab.id,
              type: 'button',
              'aria-pressed': active,
              className: 'subtab',
              onClick: () => setScopeId(tab.id),
            },
            tab.twoLine
              ? h('span', { className: 'subtab-top' }, tab.top, badge)
              : h('span', { className: 'subtab-only' }, bottom, badge),
            tab.twoLine ? h('span', { className: 'subtab-bottom' }, bottom) : null,
          );
        }),
      );
    }

    /**
     * 渲染「通道」页。
     *
     * 字段分两张卡片：
     *
     * 1. **按会话配置**：人格四段（行为规则已挪到第二张卡）+ 推理等级、定时任务、
     *    心情这些"每段一叠"的设置；
     * 2. **规则、记忆与判定**：行为规则、发 QQ 的规矩、记忆、判定模式。
     *
     * 两张卡共用同一套渲染：分组条只在**该段 ≥2 项**时出现（`logic.sectionFoldable`），
     * 只有 1 项的段直接平铺成一行 —— 推理等级就属于这种。
     *
     * 私聊与群作用域只列人格五段（`logic.SCOPE_KEEP_KEYS`），因此第二张卡在那里
     * 只剩行为规则；字段为空时整张卡不渲染。
     */
    function renderChannelTab() {
      const cardFields = logic.splitChannelCardFields(currentFields.filter((field) => {
        const file = logic.textOf(field && field.file);
        // 2026-10-30：旁路的字段有自己的标签页，这里只留主文件的（老载荷没有 `file` ⇒ 当主文件）。
        return file === '' || file === 'main';
      }));
      const firstGroups = logic.groupFields(cardFields.first);
      const personalityGroups = firstGroups.filter((group) => group.section === 'personality');
      const otherGroups = firstGroups.filter((group) => group.section !== 'personality');
      const secondGroups = logic.channelSecondCardGroups(cardFields.second);

      /**
       * 把一组分组渲染成字段行 / 折叠条。
       *
       * `rows` 在**一张卡片内**累计，只有卡片的第一行去掉上边框：平铺的 1 项段之间
       * 仍保留分隔线，折叠段展开后的第一行紧跟折叠条，也不再画线。
       */
      const renderGroups = (groups, options = {}) => {
        let rows = 0;
        const nodes = [];
        // 2026-10-30：窄字段（数字/开关/下拉）在这里被攒成一行 2~3 个，见 renderFields。
        const renderRows = (fields) => {
          for (const node of renderFields(fields, currentScope)) nodes.push(node);
          rows += fields.length;
        };
        for (const group of groups) {
          // 人格段永远平铺：它是这张卡片的主体，折起来等于把"她是谁"藏了。
          const alwaysFlat = options.personalityFlat === true && group.section === 'personality';
          if (alwaysFlat || !logic.sectionFoldable(group.fields.length)) {
            renderRows(group.fields, false);
            continue;
          }
          const open = channelFoldOpen[group.section] === true;
          nodes.push(h(
            'button',
            {
              key: `${group.section || group.title}-bar`,
              type: 'button',
              className: 'fold-bar',
              'aria-expanded': open,
              disabled: writeBusy,
              onClick: () => setChannelFoldOpen((prev) => ({
                ...prev,
                [group.section]: prev[group.section] !== true,
              })),
            },
            logic.sectionFoldLabel(group.title, group.fields.length, open),
          ));
          if (open) renderRows(group.fields, true);
        }
        return nodes;
      };

      return h(
        'div',
        { className: 'panel' },
        // ① 身份：用户名单。该项属于危险键，保存前必定经过内联确认条。
        h(
          'div',
          { className: 'card' },
          h('div', { className: 'card-title' }, '身份'),
          h(
            'div',
            { className: 'field-row first' },
            h(
              'div',
              { className: 'field-label-box' },
              h('div', { className: 'field-label' }, '用户（管理员）'),
              h('div', { className: 'field-key' }, 'owner.admins'),
            ),
            h(
              'div',
              { className: 'field-control-box' },
              h('input', {
                className: 'input',
                type: 'text',
                // 与「原文件」页的 [owner] 卡共用同一份草稿（`global::admins`），
                // 因此这里显示的是 `draftOf` 算出来的值，而不是自己存一份。
                value: logic.textOf(logic.draftOf(scopeDraft, 'global', adminField)),
                placeholder: '多个用英文逗号隔开（例 30000001）',
                onChange: (event) => setDraftValue(setScopeDraft, 'global', adminField, event.target.value),
              }),
              h(
                'div',
                { className: 'hint' },
                '用户号码取列表第一个：定时任务叫醒的私聊是 private:<第一个号>。留空时宿主回退到白名单第一个。',
              ),
            ),
          ),
          // 危险键：本卡改了之后，「保存全部」会先展开确认条再写。
          renderCardActions([adminField], 'global'),
        ),

        // ② 按会话配置：二级标签，global 固定为第一项，其后依次为私聊与群。
        h(
          'div',
          { className: 'card' },
          h('div', { className: 'card-title' }, '按会话配置'),
          h(
            'div',
            { className: 'hint' },
            '列出来的是白名单里的号码，加上 toml 里已经写过人格覆盖的号码；群名由宿主异步补拉，取不到就只显示号码。',
          ),
          renderScopeTabs(),
          h(
            'div',
            { className: 'hint' },
            currentKind === 'global'
              ? '全局是基准：这里改的是所有没覆盖的会话共用的值。'
              : '会话层只列人格五段（阈值类不在会话层生效）。清空某一框 = 删掉这条覆盖、回退到基准值。',
          ),
          currentFields.length === 0
            ? h(
                'div',
                { className: 'hint' },
                remote === null ? '正在读取字段…' : '这个会话没有可显示的字段。',
              )
            : null,
          // 人格四段常显；其余每段 ≥2 项一条折叠条、1 项直接平铺。
          ...renderGroups([...personalityGroups, ...otherGroups], { personalityFlat: true }),
          renderCardActions(cardFields.first, currentScope),
          h(
            'div',
            { className: 'hint' },
            '改动先留在页面上：点页面底部的「保存全部」才写入文件，写入不会自动重载（重载会掐断她正在说的那一轮）。要生效再点同一条里的「重载插件」并确认，约 2~3 秒后生效——配置页会跟着断开一下，然后自动重连回来（不用重开），最多等 30 秒。',
          ),
        ),

        // ③ 第二张卡：行为规则 / 发 QQ 的规矩 / 记忆 / 判定模式。
        cardFields.second.length === 0
          ? null
          : h(
              'div',
              { className: 'card' },
              h('div', { className: 'card-title' }, '规则、记忆与判定'),
              h(
                'div',
                { className: 'hint' },
                currentKind === 'global'
                  ? '行为规则、发 QQ 的规矩、记忆与判定模式。其中只有行为规则参与按会话覆盖，其余几项改的是全局文件值。'
                  : '这一层只有行为规则参与按会话覆盖；发 QQ 的规矩、记忆与判定模式写在全局。留空并保存 = 删掉这条覆盖。',
              ),
              ...renderGroups(secondGroups),
              renderCardActions(cardFields.second, currentScope),
            ),
      );
    }

    /**
     * 渲染「原文件」页的一张段落卡片。
     *
     * card key 与提示标签都带序号：分界字段把同一段切开后会出现两张 section 相同的
     * 卡片，仅用段名会导致 key 冲突。本卡片只负责**自己的那些控件与「恢复」**：
     * 保存是整页共用的一个动作（底部「保存全部」），所以这里没有保存按钮。
     *
     * 草稿前缀固定为 `global`（这一页只显示基准值），与「通道」页全局作用域同键，
     * 因此同一个字段在两页改过也只是一处改动。
     */
    /**
     * 拉某几份文件的备份列表（2026-10-30）。
     *
     * 用 `files` 映射而不是一个数组：标签页可能管两份文件（「语音」= voice + tts），
     * 混成一个列表会让人分不清哪份备份属于谁。
     */
    async function loadBackups(keys) {
      setBackupState((prev) => ({ ...prev, error: '', busy: true }));
      const files = {};
      const errors = [];
      for (const key of keys) {
        try {
          const payload = await api(`/dsh-qq-proactive/backups?file=${encodeURIComponent(key)}`);
          files[key] = Array.isArray(payload.backups) ? payload.backups : [];
        } catch (error) {
          errors.push(`${key}: ${errorText(error)}`);
        }
      }
      setBackupState({ files, error: errors.join('；'), busy: false });
    }

    /**
     * 把一份备份还原回去（2026-10-30）。
     *
     * ⚠️ 这是**覆盖整份文件**：先弹一次浏览器确认，成功后重新读 `/settings`
     * 让页面上的"文件值"跟上；还原前宿主会自己把当前版本再备一份。
     */
    async function restoreBackup(key, name) {
      const ok = window.confirm(
        `把备份 ${name} 还原到 ${key} 那份文件？\n\n当前版本会先自动备份一份，所以这一步也能撤回。`,
      );
      if (!ok) return;
      setBackupState((prev) => ({ ...prev, busy: true, error: '' }));
      try {
        await api('/dsh-qq-proactive/restore', {
          method: 'POST',
          body: { file: key, name, confirm: true },
        });
        await loadSettings();
        await loadBackups([key]);
      } catch (error) {
        setBackupState((prev) => ({ ...prev, busy: false, error: errorText(error) }));
      }
    }

    /**
     * 渲染「提示词」页（2026-10-30）：`[prompt]` 那几句 + **最终提示词预览**。
     *
     * 预览放在这一页的最上面，因为它回答的是"我改完之后她到底读到什么" ——
     * 这个项目里"改完以为生效了"是最贵的一类错，能看见才是改得动的前提。
     */
    function renderPromptTab() {
      const fields = remoteFields.filter((field) => field !== null
        && logic.textOf(field.scope) === 'global'
        && logic.textOf(field.section) === 'prompt');
      const groups = logic.groupFields(fields);
      const data = promptPreview.data;
      return h(
        'div',
        { className: 'panel' },
        h(
          'div',
          { className: 'card' },
          h('div', { className: 'card-title' }, '最终提示词预览'),
          h(
            'div',
            { className: 'hint' },
            '每轮真正会进模型的那几段（人格 / 工作目录 / 发 QQ 规矩）。'
              + '不含历史对话、工具描述、知识与心情 —— 那几样是运行期数据，不是配置文本。',
          ),
          h(
            'div',
            { className: 'actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'button',
                disabled: promptPreview.loading === true,
                onClick: () => { loadPromptPreview(); },
              },
              promptPreview.loading === true ? '读取中…' : '重新拼一次',
            ),
            data === null ? null : h('span', { className: 'hint' }, `合计 ${data.totalChars} 字符 · 作用域 ${data.scope}`),
          ),
          promptPreview.error !== '' ? h('div', { className: 'field-error' }, promptPreview.error) : null,
          data === null
            ? h('div', { className: 'hint' }, '还没读。点上面那个按钮。')
            : h('div', null, ...data.parts.map((part) => h(
              'div',
              { key: part.name },
              h('div', { className: 'hint' }, `${part.label}　${part.chars} 字符`),
              h(
                'div',
                { className: 'hint', style: { whiteSpace: 'pre-wrap', marginTop: '4px' } },
                part.text === '' ? '（这一段现在是空的 —— 对应的规矩没配）' : part.text,
              ),
            ))),
        ),
        data === null || !Array.isArray(data.side)
          ? null
          : h(
            'div',
            { className: 'card' },
            h('div', { className: 'card-title' }, '旁路模型的提示词'),
            h(
              'div',
              { className: 'hint' },
              `这些不在每轮上下文里，只在各自那条调用上出现（合计 ${data.sideTotalChars} 字符）。改它们要重载才生效。`,
            ),
            ...data.side.map((part) => h(
              'div',
              { key: part.name },
              h('div', { className: 'hint' }, `${part.label}　${part.chars} 字符`),
              h(
                'div',
                { className: 'hint', style: { whiteSpace: 'pre-wrap', marginTop: '4px' } },
                part.text === '' ? '（空 —— 用代码里的原文）' : part.text,
              ),
            )),
          ),
        ...groups.map((group, index) => h(
          'div',
          { key: `prompt-${index}`, className: 'card' },
          h('div', { className: 'card-title' }, group.title),
          h(
            'div',
            { className: 'hint' },
            '留空 = 用代码里的原文（行为和没配这一项完全相同）；写什么就照什么发。',
          ),
          ...renderFields(group.fields, 'global'),
          renderCardActions(group.fields, 'global'),
        )),
      );
    }

    /**
     * 渲染某个旁路模型页（2026-10-30）：心情 / 识图 / 表情包 / 语音。
     *
     * 只显示**这几份文件里**的字段（`field.file` 命中），作用域固定为 `global` ——
     * 按会话覆盖只对人格五段有意义，旁路设置没有"某个群单独一套"的概念。
     *
     * 顶部两张卡是这次拆文件的目的所在：**看得见文件在哪**、**单独回滚得动**。
     */
    function renderFileTab(tab) {
      const keys = Array.isArray(tab.files) ? tab.files : [tab.file];
      const allMeta = remote !== null && Array.isArray(remote.files) ? remote.files : [];
      const fileMeta = allMeta.filter((item) => item !== null && keys.includes(logic.textOf(item.key)));
      const flat = remoteFields.filter((field) => field !== null
        && logic.textOf(field.scope) === 'global'
        && keys.includes(logic.textOf(field.file)));
      const groups = logic.groupFields(flat);
      const loaded = backupState.files ?? {};

      return h(
        'div',
        { className: 'panel' },
        h(
          'div',
          { className: 'card' },
          h('div', { className: 'card-title' }, `${tab.label} · 文件`),
          fileMeta.length === 0
            ? h('div', { className: 'hint' }, '宿主没有报出这几份文件的路径（版本不匹配？）')
            : fileMeta.map((item) => h(
              'div',
              { key: item.key, className: 'hint' },
              `${item.path}　${item.split === true ? '已拆分' : '尚未拆分（当前读写主文件）'}`,
            )),
          h(
            'div',
            { className: 'hint' },
            '这一页的改动只写进上面这些文件；每份文件有独立的备份，改坏了可以单独还原，不会牵连人格与其它旁路。',
          ),
        ),
        h(
          'div',
          { className: 'card' },
          h('div', { className: 'card-title' }, '备份与还原'),
          h(
            'div',
            { className: 'actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'button',
                disabled: backupState.busy === true,
                onClick: () => { loadBackups(keys); },
              },
              backupState.busy === true ? '读取中…' : '载入备份列表',
            ),
            h('span', { className: 'hint' }, `备份目录：${logic.textOf(remote && remote.backupDir)}`),
          ),
          backupState.error !== ''
            ? h('div', { className: 'field-error' }, backupState.error)
            : null,
          ...keys.map((key) => {
            const list = loaded[key];
            if (list === undefined) return null;
            return h(
              'div',
              { key: `bk-${key}` },
              h('div', { className: 'hint' }, `${key}：${list.length === 0 ? '还没有备份' : `${list.length} 份`}`),
              ...list.slice(0, 6).map((item) => h(
                'div',
                { key: item.name, className: 'actions' },
                h('span', { className: 'hint' }, `${item.name}（${Math.max(1, Math.round(item.bytes / 1024))} KB）`),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'button',
                    disabled: backupState.busy === true,
                    onClick: () => { restoreBackup(key, item.name); },
                  },
                  '还原',
                ),
              )),
            );
          }),
        ),
        groups.length === 0
          ? h('div', { className: 'card' }, h('div', { className: 'hint' }, '这一页暂时没有可改的字段。'))
          : null,
        ...groups.map((group, index) => h(
          'div',
          { key: `${group.section}:${index}`, className: 'card' },
          h('div', { className: 'card-title' }, group.title),
          ...renderFields(group.fields, 'global'),
          renderCardActions(group.fields, 'global'),
        )),
      );
    }

    function renderRawGroupCard(group, index) {
      return h(
        'div',
        { key: `${group.section}:${index}`, className: 'card' },
        h('div', { className: 'card-title' }, `${group.title}（[${group.section}]）`),
        ...renderFields(group.fields, 'global'),
        renderCardActions(group.fields, 'global'),
      );
    }

    /**
     * 渲染「原文件」页：说明卡片、显示段各卡片与折叠条、展开后的折叠段卡片。
     *
     * 分组与切分由 `groupFieldsBySection` 与 `splitRawGroups` 完成，本函数只负责排布；
     * 折叠段在未展开时完全不构造，而不是渲染后隐藏。
     */
    function renderRawTab() {
      const groups = logic.groupFieldsBySection(remoteFields, 'global');
      const split = logic.splitRawGroups(groups, logic.RAW_FOLD_AFTER_KEY);
      return h(
        'div',
        { className: 'panel' },
        h(
          'div',
          { className: 'card' },
          h('div', { className: 'card-title' }, '原文件（六份合计）'),
          h(
            'div',
            { className: 'hint' },
            '按 toml 的段落分组，每个字段一个控件。改动先留在页面上，点页面底部的「保存全部」才写盘：它只重写改动的那些键，其余字节原样（手写注释与格式不会被冲掉），每个键单独提交，长文本不会撞到 64 KiB 的请求体上限。',
          ),
          h(
            'div',
            { className: 'hint' },
            '写入一律「重载后生效」。多行文本平时 3 行，双击该输入框放大（占满整行宽、高度按内容放开），再双击收回；'
              + '「硬规矩」之后的字段整段收在下面的折叠条里，默认不显示，展开后是按段分好的完整卡片。',
          ),
        ),
        groups.length === 0
          ? h(
              'div',
              { className: 'card' },
              h(
                'div',
                { className: 'hint' },
                remoteError === null ? '正在读取字段…' : `读不到字段表：${remoteError}`,
              ),
            )
          : null,
        ...split.shown.map((group, index) => renderRawGroupCard(group, index)),
        split.folded.length === 0
          ? null
          : h(
              'div',
              { key: 'raw-fold', className: 'card' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'fold-bar',
                  'aria-expanded': rawFoldOpen === true,
                  disabled: writeBusy,
                  onClick: () => setRawFoldOpen((prev) => prev !== true),
                },
                logic.rawFoldLabel(split.folded, rawFoldOpen === true),
              ),
            ),
        rawFoldOpen !== true
          ? null
          : split.folded.map((group, index) => renderRawGroupCard(group, split.shown.length + index)),
      );
    }

    const serviceText = service.state === 'unreachable'
      ? '临时服务暂时连不上（多半是插件正在重载）—— 页面会自动重连，最多等 30 秒。'
      : service.state === 'running'
        ? `临时服务运行中 · 端口 ${service.port}`
        : '正在连接临时服务…';

    /**
     * 当前所有未保存的改动（跨作用域、跨两页），保存条与「保存全部」都读它。
     *
     * 每次渲染现算：控件每敲一个字都会重渲染，因此处数、摘要、确认条里的条目
     * 始终是**当前**草稿算出来的，不会写着旧值。
     */
    const dirtyEntries = remote === null ? [] : allDirtyEntries();

    /**
     * 把"还没保存的改动"导出成一段纯文本并放进剪贴板。
     *
     * 为什么这个按钮必须存在：重连失败时唯一的路是**重开配置页**，而新页面是另一个
     * origin（新端口 + 新令牌），读不到这个页面里的草稿 —— 也就是说重开一定会把那批
     * 改动丢掉。能把它们变成"用户手里的文本"，是这一页能做的最后一件事。
     *
     * 剪贴板接口不可用（旧浏览器、非安全上下文、被策略拦）时不报错，改成把文本摊在
     * 输入框里让人自己全选复制 —— 两条路都得留着，否则那个按钮就是骗人的。
     */
    async function copyDirtyEntries(entries) {
      const text = logic.dirtyEntriesDump(entries, scopeLabels());
      if (text === '') return;
      try {
        const clip = typeof navigator !== 'undefined' && navigator !== null ? navigator.clipboard : null;
        if (clip !== null && clip !== undefined && typeof clip.writeText === 'function') {
          await clip.writeText(text);
          setDumpState({ kind: 'copied', text: '' });
          return;
        }
      } catch {
        /* 落到下面的手工复制 */
      }
      setDumpState({ kind: 'manual', text });
    }

    /**
     * 「重连中」的整页覆盖层。
     *
     * 为什么是覆盖层而不是弹窗 / `alert`：
     *
     * 1. `alert` 会阻塞整页渲染与定时器（连心跳都会被它停掉），而这整件事就是"等"；
     * 2. 一个必须点「确定」的对话框会在插件回来之前就被人点掉，点掉之后界面还是空壳；
     * 3. 覆盖层**同时挡住下面那些输入框**：断开期间不该再改配置 —— 改的东西照样只在
     *    内存里，但它会让人误以为"我正在改的东西服务那边知道"。
     *
     * 文案与"要不要给重试按钮"全在 `logic.reconnectNotice` 里（可在 Node 里钉住），
     * 这里只负责铺 DOM。
     */
    function renderReconnectOverlay(entries) {
      const notice = logic.reconnectNotice({
        phase: reconnect.phase,
        waitedMs: reconnect.waitedMs,
        dirtyCount: entries.length,
      });
      if (notice.visible !== true) return null;
      return h(
        'div',
        { className: 'reconnect-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': '等待插件重连', 'data-phase': notice.phase },
        h(
          'div',
          { className: 'reconnect-card' },
          h('div', { className: 'reconnect-title' }, notice.title),
          h('div', { className: 'reconnect-detail' }, notice.detail),
          notice.retry === true
            ? h(
                'div',
                { className: 'actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'button button-primary',
                    // 重新开一轮：`cancelReconnect` 先把旧 generation 作废并清掉在途等待，
                    // 否则 `startReconnect` 会因为 `active` 还挂着而不理这一下。
                    onClick: () => {
                      cancelReconnect();
                      startReconnect('retry');
                    },
                  },
                  '再试一次',
                ),
                entries.length === 0
                  ? null
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'button',
                        title: '把还没保存的改动导出成文本（重开配置页之后照着填回去）',
                        onClick: () => { copyDirtyEntries(entries).catch(() => undefined); },
                      },
                      '复制改动',
                    ),
              )
            : null,
          // 复制不进去时的兜底：把文本摊开，让人自己全选。
          dumpState.kind === 'copied'
            ? h('div', { className: 'hint-ok' }, '已复制到剪贴板。重开配置页后照着填回去。')
            : null,
          dumpState.kind === 'manual'
            ? h(
                'div',
                { className: 'reconnect-dump' },
                h('div', { className: 'hint' }, '浏览器不让直接写剪贴板，请手动全选下面这段复制：'),
                h('textarea', {
                  className: 'textarea',
                  readOnly: true,
                  rows: 6,
                  value: dumpState.text,
                  onFocus: (event) => {
                    // 聚焦即全选：省掉"点一下、再 ctrl+A"。
                    try {
                      event.target.select();
                    } catch {
                      /* 选不了就算了 */
                    }
                  },
                }),
              )
            : null,
        ),
      );
    }

    /*
     * 未保存提醒（最后一道）。底部保存条一直写着"还有 N 处没保存"，这里再补一条：
     * 带脏草稿时关闭/刷新页面，浏览器先问一句。草稿只在内存里 —— 刷新就全没了，
     * 而"改完以为存了、其实没存"正是这次要治的病。
     */
    useEffect(() => {
      if (dirtyEntries.length === 0) return undefined;
      const onBeforeUnload = (event) => {
        event.preventDefault();
        // 现代浏览器忽略返回值，但赋值仍是"要不要弹确认"的判据之一。
        event.returnValue = '';
        return '';
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [dirtyEntries.length]);

    return h(
      'div',
      { className: 'app' },
      h(
        'div',
        { className: 'app-header' },
        h('h1', { className: 'app-title' }, 'QQ 小鲸鱼 · 配置页'),
        h(
          'span',
          { className: 'service' },
          serviceText,
        ),
        remote !== null && typeof remote.tomlPath === 'string' && remote.tomlPath !== ''
          ? h('span', { className: 'app-sub' }, `文件：${remote.tomlPath}`)
          : null,
      ),
      h(
        'div',
        { className: 'actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'button',
            disabled: loading,
            onClick: () => loadSettings(),
          },
          loading ? '读取中…' : '重新读取',
        ),
        h(
          'span',
          { className: 'hint' },
          '改完点页面底部的「保存全部」才写进文件；本页代码改完按 F5 即生效，不需要重启 DSH。',
        ),
      ),
      // 重连期间**不显示**"读取配置失败"横幅：它要说的事覆盖层已经说清楚了，
      // 两条并排只会让人以为出了两个问题。恢复之后（`remoteError` 已被重连成功置空）
      // 它自然也不会出现。
      remoteError !== null && reconnect.phase === 'idle'
        ? h('div', { className: 'banner' }, `读取配置失败：${remoteError}`)
        : null,
      h(
        'div',
        { className: 'tabbar', role: 'group', 'aria-label': 'QQ 小鲸鱼的配置分类' },
        ...TABS.map((tab) => h(
          'button',
          {
            key: tab.id,
            type: 'button',
            className: 'tab',
            'aria-pressed': activeTab === tab.id,
            // 切页**不清**草稿/提示：草稿两页共用一张表，提示挂在底部保存条上，
            // 切页后两者都还在（这正是"改完就忘"要防的那一类）。
            onClick: () => setActiveTab(tab.id),
          },
          tab.label,
        )),
      ),
      remote === null
        ? h(
            'div',
            { className: 'card' },
            h(
              'div',
              { className: 'hint' },
              loading ? '正在读取配置…' : '未能读取配置。',
            ),
          )
        : (activeTab === 'raw'
          ? renderRawTab()
          : (activeTab === 'channel'
            ? renderChannelTab()
            : (activeTab === 'prompt'
              ? renderPromptTab()
              : renderFileTab(TABS.find((tab) => tab.id === activeTab) ?? TABS[0])))),
      // 整页唯一的保存入口，固定在视口底边（见 `renderSaveBar` 的注释）。
      renderSaveBar(dirtyEntries),
      // 重连覆盖层放在**最后**：它是 `position: fixed` 的整页层，DOM 顺序决定它盖在
      // 保存条（z-index 10）之上 —— 见 style.css 里的 `z-index: 40`。
      renderReconnectOverlay(dirtyEntries),
    );
  }

  return App;
}

/*
 * 只给 Node 侧的测试用（`test/web-config-merged-save.test.mjs` 在假 React 上跑这个
 * 组件，验证「保存全部」真的会把所有脏字段一次提交）。浏览器里没人 import 它，
 * 因此这行导出不影响页面。
 */
export { createApp };

/** 入口：加载 logic 模块、创建组件并挂载。任何一步失败都显示成页面顶部的错误框。 */
async function boot() {
  if (TOKEN === '') {
    showBootError('地址里没有令牌（?t=…）。请从 DSH 的「QQ 小鲸鱼」卡片重新打开配置页。');
    return;
  }
  if (!window.React || !window.ReactDOM) {
    showBootError('React 没有加载成功：请确认 preview/vendor/ 下的两个 UMD 文件存在。');
    return;
  }
  const React = window.React;
  const ReactDOM = window.ReactDOM;
  // 静态 import 无法附带令牌，因此用动态 import；logic.mjs 同样走服务端的令牌校验。
  const logic = await import(`./logic.mjs?t=${encodeURIComponent(TOKEN)}`);
  const App = createApp({ h: React.createElement, logic, React });
  const container = document.getElementById('root');
  if (container === null) throw new Error('页面缺少 #root 挂载点');
  /*
   * 幂等守卫。本模块若被加载两次（重复的 script 标签、动态 import 被重复触发，
   * 或标签页从历史恢复导致脚本重跑），每次都会 createRoot 出一个新的 React 根，
   * 表现就是同一个容器里叠出多份界面，而且刷新只会再叠一层。
   * 在容器上记住已创建的根，再次进入时直接复用它，保证一个容器只有一个根。
   */
  const BOOT_MARK = '__qqConfigRoot';
  const existingRoot = container[BOOT_MARK];
  if (existingRoot !== undefined && existingRoot !== null) {
    existingRoot.render(React.createElement(App));
    return;
  }
  const root = ReactDOM.createRoot(container);
  container[BOOT_MARK] = root;
  root.render(React.createElement(App));
}

boot().catch((error) => {
  showBootError(`配置页启动失败：${errorText(error)}`);
});
