/**
 * 插件生命周期定时器登记（2026-11-15）。
 *
 * 背景：插件热重载时 `apply` 可能在同一进程内被**重复调用**，而不一定伴随一次完整的
 * dispose。此前三个 `setInterval`（回想泵 / 转录落盘 / 话题影子）直接挂在 `apply`
 * 作用域里，重复 apply 就会叠加出多套定时器；每套定时器的闭包都会把那一代插件实例
 * （engine、store、会话句柄等）钉在内存中，最终把宿主堆推到上限。
 *
 * 本模块只做一件事：把"这一代 apply 创建的定时器"登记起来，并在**新的一代开始**时
 * 先清掉上一代未清理的定时器。旧一代的 `clear()` 在换代之后变为空操作，避免旧实例的
 * dispose 误伤新一代。
 *
 * 判据：`startGeneration()` 的返回值代表"当前有效的一代"；只有它的 `clear()` 会真正
 * 清理定时器。
 */

/**
 * 开始新的一代：先清掉上一代登记的所有定时器，再建立本代登记表。
 *
 * @param {object} [options]
 * @param {(level: string, msg: string, meta?: object) => void} [options.log]
 * @param {(timer: unknown) => void} [options.clear] 清理函数（测试注入）
 * @returns {{register: (timer: unknown) => void, clear: () => number, size: () => number, generation: number, active: () => boolean}}
 */
export function startGeneration({ log = () => {}, clear = (timer) => clearInterval(timer) } = {}) {
  if (current !== null) {
    const stale = current;
    current = null;
    const cleared = stale.clear();
    if (cleared > 0) {
      log('warn', '插件重复 apply：已清理上一代遗留定时器', { 数量: cleared });
    }
  }
  const registry = createRegistry({ log, clear });
  current = registry;
  return registry;
}

/**
 * 当前这一代的登记表；没有则返回 null（例如模块被单独加载时）。
 * @returns {ReturnType<typeof createRegistry>|null}
 */
export function activeGeneration() {
  return current;
}

/** 清掉当前一代（dispose 用），并解除"当前"引用。 */
export function endGeneration(log = () => {}, expectedGeneration) {
  if (current === null) return 0;
  // 换代之后旧实例的 dispose 迟到：不能让它清掉新一代的定时器。
  if (expectedGeneration !== undefined && current.generation !== expectedGeneration) return -1;
  const gen = current;
  current = null;
  return gen.clear(log);
}

let current = null;

function createRegistry({ log = () => {}, clear = (timer) => clearInterval(timer) } = {}) {
  /** @type {unknown[]} */
  let timers = [];
  let live = true;
  const generation = ++generationSeq;

  function register(timer) {
    if (timer === null || timer === undefined) return;
    if (!live) {
      // 旧一代还在登记：说明有一次迟到的创建，立即清掉，不能让它继续响。
      try {
        clear(timer);
      } catch {
        /* 清理失败只影响这一只定时器 */
      }
      log('warn', '插件重复 apply：旧一代尝试登记新定时器，已立即清理', { generation });
      return;
    }
    timers.push(timer);
  }

  function clearAll(l = log) {
    if (!live) return 0;
    live = false;
    const n = timers.length;
    for (const timer of timers) {
      try {
        clear(timer);
      } catch (error) {
        l('debug', '定时器清理失败（忽略）', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    timers = [];
    return n;
  }

  return {
    register,
    clear: clearAll,
    size: () => timers.length,
    generation,
    active: () => live,
  };
}

let generationSeq = 0;

/** 测试用：重置模块状态。 */
export function resetGenerationForTest() {
  current = null;
  generationSeq = 0;
}
