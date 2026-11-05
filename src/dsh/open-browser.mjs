/**
 * 用系统默认浏览器打开一个 URL（零依赖）。
 *
 * 它是宿主侧临时配置服务的最后一步：把服务地址（默认固定端口 + 跨重载复用的令牌，
 * 见 `config-server.mjs`）交到用户眼前的浏览器里。只有一行子进程，但三个细节决定了
 * 它会不会把宿主带下去：
 *
 * 1. **必须 `unref()`。** 宿主是长驻进程，浏览器进程交出去之后不该再被它
 *    挂在事件循环上。
 * 2. **必须接住 `error` 事件。** `spawn` 只在参数非法时同步抛错；"命令不存在"
 *    这类失败是**异步**的 `error` 事件，没有监听器时它就是宿主进程里的未捕获
 *    异常。本项目的规矩是：挂在外部系统上的回调必须自己吞掉异常。
 * 3. **失败不 reject。** 地址本身仍然有效，用户手工粘贴也能打开，所以这里统一
 *    返回 `{ok, error}`，让调用方只记一条 warn 即可。
 *
 * 平台分支：Windows 走 `cmd /c start`（`start` 的**第一个参数是窗口标题**，
 * 必须留一个占位空串，否则带引号的地址会被当成标题、浏览器根本不打开）；
 * macOS 走 `open`；其余平台走 `xdg-open`。
 *
 * @module qq-dsh/open-browser
 */
import { spawn } from 'node:child_process';

/**
 * 按平台给出「打开浏览器」的命令与参数。
 *
 * @param {string} url 要打开的地址
 * @param {string} [platform] 目标平台（默认 `process.platform`）
 * @returns {{command: string, args: string[]}}
 */
export function browserCommand(url, platform = process.platform) {
  const target = String(url ?? '');
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', target] };
  if (platform === 'darwin') return { command: 'open', args: [target] };
  return { command: 'xdg-open', args: [target] };
}

/**
 * 打开浏览器；**永不 reject**。
 *
 * 成功以子进程的 `spawn` 事件为准（那一刻操作系统确实把它建起来了）；
 * `error` 事件（命令不存在、权限不足等）按失败返回。
 *
 * @param {string} url 要打开的地址
 * @param {object} [options]
 * @param {typeof spawn} [options.spawn] 注入点（测试用；默认 `node:child_process` 的 `spawn`）
 * @param {string} [options.platform] 目标平台（测试用）
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function openBrowser(url, { spawn: spawnImpl = spawn, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const { command, args } = browserCommand(url, platform);
      child = spawnImpl(command, args, {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
    } catch (error) {
      resolve({ ok: false, error: errorText(error) });
      return;
    }

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      child?.once?.('spawn', () => settle({ ok: true }));
      child?.once?.('error', (error) => settle({ ok: false, error: errorText(error) }));
    } catch (error) {
      settle({ ok: false, error: errorText(error) });
      return;
    }

    try {
      child?.unref?.();
    } catch {
      /* 子进程已经退出时 unref 会抛，这里不需要它成功 */
    }
  });
}

/** 异常压成一行可读文本。 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
