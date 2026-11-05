/**
 * 「要不要说话」判定器（模式 2 `precheck`）的**计数器**（2026-10-28 加）。
 *
 * ## 为什么需要它
 *
 * 用户问的是「判定器有在正常工作吗？**通过率**多少」。加这一段之前，快照里能看到的
 * 只有每个会话的**最后状态**（`gauges` / `thresholdPassed` / `declineCount`）——
 * 那是"此刻攒了多少劲"，回答不了「一共问了几次 / 几次说该说 / 几次说不该 /
 * 几次根本没答上来」。而 `journal` 只有 20 条上界，早的已经被滚掉了。
 *
 * ## 三条硬约束（写在这里，免得改的人去别处找）
 *
 * 1. **这是计数器，不是判定逻辑。** 它只**读** `PrecheckOutcome.source`，
 *    不产生、不修改任何判定结果 —— 阈值、攒劲儿、precheck 的重试与降级策略
 *    一个字节都没动。
 * 2. **绝不抛。** 它挂在**每条消息的热路径**上（`createPrecheck().check()` 的返回处）。
 *    本项目历史上因为热路径上的回调抛异常把宿主带崩过三次（见 `AGENTS.md`）
 *    ⇒ `record()` / `snapshot()` 各自 try/catch，算错了最多是一个数不对。
 * 3. **不持久化。** 与其它 diag 同口径：重载 / 重启归零可以接受；
 *    要历史去看 `journal`（有界流水）与日志。**数字必须进快照**，否则用户看不见。
 *
 * ## 计数口径（分类**只看 `source`**，不猜别的字段）
 *
 * | `PrecheckOutcome.source` | 计到哪 | 含义 |
 * |---|---|---|
 * | `reply` | `passed` | 判定说「该说」 |
 * | `decline` | `declined` | 判定说「不该说」 |
 * | `timeout` | `failed` + `failedTimeout` | 超时 ⇒ 降级成「该说」（**算失败，不算通过**）|
 * | `error` | `failed` + `failedError` | 调用报错（含重试后仍失败）⇒ 降级成「该说」|
 * | `unparsed` | `failed` + `failedUnparsed` | 答非所问（空 / 乱码）⇒ 降级成「该说」|
 * | `busy` | `skipped` + `skippedBusy` | 上一个调用还没回来 ⇒ 这一条**没问成**（不是失败）|
 * | `no-model` | `skipped` + `skippedNoModel` | 没配模型 / 没有 llm 服务 ⇒ 降级（配置问题，不是失败）|
 * | 其它 / 缺失 | `other` | 兜底：**不改前面任何一个数**（绝不猜它算通过还是失败）|
 *
 * ⚠️ **恒等式**（调用方可以拿它自检）：
 * ```
 * calls === passed + declined + failed + skipped + other
 * failed === failedTimeout + failedError + failedUnparsed
 * ```
 *
 * ⚠️ **三种失败必须能分开**（用户点名的要求）：`timeout`（超时）/ `error`（报错）/
 * `unparsed`（返回格式不对）。它们的处置完全不同：超时改 `precheck_timeout_ms`、
 * 报错看 provider、格式不对要看模型是不是在瞎聊。
 *
 * ⚠️ **`passed` 里不含"降级成该说"的那些** —— 那三种失败回来后 `speak === true`
 * （`judge-mode.mjs` 文件头：失败一律退回"该说"），但它们在**判定器是否正常**这个问题上
 * 是"没答上来"。混进 `passed` 会把通过率算虚高，也会把"判定器早就挂了但一直在降级"
 * 藏起来（这正是本项目最贵的一类坑：不报错、计数正常、只是什么都没发生）。
 *
 * @module qq-gugu/judge-stats
 */

/** 每个会话 / 全局都要有的那些计数（形状钉死，快照才能跨版本读）。 */
function emptyCounts() {
  return {
    /** 判定器被问过多少次「要不要说」。 */
    calls: 0,
    /** 判定说「该说」。 */
    passed: 0,
    /** 判定说「不该说」。 */
    declined: 0,
    /**
     * 判定说「还没说完，等一等」（2026-11-01 第三态）。
     *
     * 它既不是 passed（没让它说）也不是 declined（不是"这话不值得接"）——
     * 混进任何一边都会让通过率/拒绝率读错。
     */
    wait: 0,
    /** 没答上来（超时 / 报错 / 格式不对 —— 三者之和）。 */
    failed: 0,
    failedTimeout: 0,
    failedError: 0,
    failedUnparsed: 0,
    /** 压根没问成（busy / 没配模型）。**不是失败**，所以与 `failed` 分开。 */
    skipped: 0,
    skippedBusy: 0,
    skippedNoModel: 0,
    /** 认不出的 `source`（兜底桶）。恒为 0 是正常的。 */
    other: 0,
    /** 最近一次判定的时刻（ISO 字符串；`''` = 还没判过）。 */
    lastAt: '',
    /** 最近一次判定的耗时（毫秒）。 */
    lastMs: 0,
    /** 最近一次的 `source` 原文（`reply` / `decline` / `timeout` / `error` / `unparsed` / `busy` / `no-model`）。 */
    lastSource: '',
    /** 最近一次**失败**的时刻（ISO；`''` = 没失败过）。 */
    lastFailedAt: '',
    /** 最近一次失败的原因：`timeout` / `error` / `unparsed` / `''`。 */
    lastFailedReason: '',
  };
}

/**
 * 把 `source` 归到桶里。
 *
 * 认不出的**一律 `other`**，绝不"默认算通过" —— 猜错的代价是让一个坏掉的判定器
 * 看起来在正常工作（这一条比少一个数严重）。
 *
 * @param {unknown} source
 * @returns {'passed'|'declined'|'timeout'|'error'|'unparsed'|'busy'|'no-model'|'other'}
 */
export function classifySource(source) {
  const raw = typeof source === 'string' ? source.trim().toLowerCase() : '';
  if (raw === 'reply') return 'passed';
  if (raw === 'decline') return 'declined';
  // 2026-11-01：第三态「等」（对方还没说完）。**不是失败、也不是拒绝**。
  if (raw === 'wait') return 'wait';
  if (raw === 'timeout') return 'timeout';
  if (raw === 'error') return 'error';
  if (raw === 'unparsed') return 'unparsed';
  if (raw === 'busy') return 'busy';
  // `judge-mode.mjs` 里是 `'no-model'`，宽容一点也认 `no_model` / `nomodel`。
  if (raw === 'no-model' || raw === 'no_model' || raw === 'nomodel') return 'no-model';
  return 'other';
}

/** 有限数字，其余一律 0（`NaN` 混进快照会变成 `null`，读的人分不清是"没有"还是"算坏了"）。 */
function numberOr0(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 毫秒时间戳 → ISO；非法值给 `''`（`new Date(NaN).toISOString()` 会抛）。 */
function isoText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    return new Date(n).toISOString();
  } catch {
    return '';
  }
}

/** `passed / (passed + declined)`，三位小数；没有一次"答上来"时给 `null`（不是 0）。 */
function passRateOf(counts) {
  const answered = numberOr0(counts.passed) + numberOr0(counts.declined);
  if (answered === 0) return null;
  return Math.round((numberOr0(counts.passed) / answered) * 1000) / 1000;
}

/** `failed / calls`，三位小数；一次都没问过时给 `null`。 */
function failRateOf(counts) {
  const calls = numberOr0(counts.calls);
  if (calls === 0) return null;
  return Math.round((numberOr0(counts.failed) / calls) * 1000) / 1000;
}

/**
 * 造一个判定器计数器。
 *
 * 用法（只有一处）：`judge-mode.mjs` 的 `createPrecheck()` 持有它，
 * `check()` 每次返回时 `record(input.chatId, outcome)`；快照侧调 `snapshot()`。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] 注入时钟（测试用）
 * @param {number} [options.maxSessions] 最多跟多少个会话（防止无关会话把内存撑大）
 * @param {number} [options.tail] `snapshot()` 里最多给几个会话（按最近判定时间倒序）
 * @returns {{record: (chatId: unknown, outcome: unknown) => void, snapshot: () => object}}
 */
export function createJudgeStats({ now = Date.now, maxSessions = 64, tail = 10 } = {}) {
  /** @type {Map<string, ReturnType<typeof emptyCounts> & {lastAtMs: number, lastFailedAtMs: number}>} */
  const sessions = new Map();
  const total = { ...emptyCounts(), lastAtMs: 0, lastFailedAtMs: 0, lastChatId: '' };
  const limit = Number.isFinite(maxSessions) && maxSessions > 0 ? Math.floor(maxSessions) : 64;
  const tailLimit = Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 10;
  const createdAt = (() => {
    try {
      return isoText(typeof now === 'function' ? now() : Date.now());
    } catch {
      return '';
    }
  })();

  /** 给一份计数 +1（`bucket` 已经归一过）。 */
  function bump(counts, bucket) {
    counts.calls += 1;
    if (bucket === 'passed') counts.passed += 1;
    else if (bucket === 'declined') counts.declined += 1;
    else if (bucket === 'wait') counts.wait += 1;
    else if (bucket === 'timeout') {
      counts.failed += 1;
      counts.failedTimeout += 1;
    } else if (bucket === 'error') {
      counts.failed += 1;
      counts.failedError += 1;
    } else if (bucket === 'unparsed') {
      counts.failed += 1;
      counts.failedUnparsed += 1;
    } else if (bucket === 'busy') {
      counts.skipped += 1;
      counts.skippedBusy += 1;
    } else if (bucket === 'no-model') {
      counts.skipped += 1;
      counts.skippedNoModel += 1;
    } else {
      counts.other += 1;
    }
  }

  /** 记"最近一次"的几样东西（时间戳取**最大值**，与项目里其它 `last*At` 同一条道理）。 */
  function touch(counts, bucket, ms, atMs, sourceText) {
    if (atMs > counts.lastAtMs) {
      counts.lastAtMs = atMs;
      counts.lastAt = isoText(atMs);
    }
    counts.lastMs = ms;
    if (sourceText !== '') counts.lastSource = sourceText;
    if (bucket === 'timeout' || bucket === 'error' || bucket === 'unparsed') {
      if (atMs >= counts.lastFailedAtMs) {
        counts.lastFailedAtMs = atMs;
        counts.lastFailedAt = isoText(atMs);
        counts.lastFailedReason = bucket;
      }
    }
  }

  /** 会话数超上限时，淘汰**最久没判定过**的那个（全局 `total` 不受影响，它是独立累加的）。 */
  function evictIfNeeded() {
    if (sessions.size <= limit) return;
    let oldestKey = '';
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, row] of sessions) {
      if (row.lastAtMs < oldestAt) {
        oldestAt = row.lastAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== '') sessions.delete(oldestKey);
  }

  /**
   * 记一次判定。**这是热路径上的函数 —— 它绝不抛，也绝不返回任何东西。**
   *
   * @param {unknown} chatId `group:xxx` / `private:xxx`
   * @param {unknown} outcome `PrecheckOutcome`（只读 `source` 与 `ms`）
   */
  function record(chatId, outcome) {
    try {
      const key = typeof chatId === 'string' && chatId !== '' ? chatId : '(未知)';
      const rawSource = outcome !== null && typeof outcome === 'object' && typeof outcome.source === 'string'
        ? outcome.source.trim()
        : '';
      const bucket = classifySource(rawSource);
      // 耗时归一：`NaN` / 负数都是坏数据 ⇒ 0（别让它们进快照，读的人分不清"没有"和"算坏了"）。
      const ms = Math.max(0, numberOr0(outcome !== null && typeof outcome === 'object' ? outcome.ms : 0));
      let atMs = 0;
      try {
        atMs = numberOr0(typeof now === 'function' ? now() : Date.now());
      } catch {
        atMs = 0;
      }

      let row = sessions.get(key);
      if (row === undefined) {
        row = { ...emptyCounts(), lastAtMs: 0, lastFailedAtMs: 0 };
        sessions.set(key, row);
      }
      bump(row, bucket);
      touch(row, bucket, ms, atMs, rawSource);
      // ⚠️ 淘汰**必须放在 `touch` 之后**：`touch` 才刚把这一条的 `lastAtMs` 写进去。
      //    放在插入之后、`touch` 之前的话，新会话的 `lastAtMs` 还是 0 ⇒
      //    **刚记下的那一条会被当成"最久没判定"淘汰掉**（第一版就是这么写的，测试抓到了）。
      evictIfNeeded();

      bump(total, bucket);
      touch(total, bucket, ms, atMs, rawSource);
      total.lastChatId = key;
    } catch {
      /* 计数失败不是故障：热路径上宁可少一个数，也不能把消息链炸掉 */
    }
  }

  /**
   * 出一份可落盘的快照（**纯标量，形状钉死**）。
   *
   * 会话按"最近判定时间"倒序取前 `tail` 个 —— 与 `proactive.states` 同样的取尾部口径。
   * ⚠️ `total` **永远是全部会话的加总**，与这里显示几个会话无关（它是增量累加的）。
   *
   * @returns {{enabled?: boolean, since: string, sessionCount: number,
   *   sessions: Array<[string, object]>, total: object}}
   */
  function snapshot() {
    try {
      const rows = [];
      for (const [key, row] of sessions) {
        rows.push([
          key,
          {
            calls: row.calls,
            passed: row.passed,
            declined: row.declined,
            wait: row.wait,
            failed: row.failed,
            failedTimeout: row.failedTimeout,
            failedError: row.failedError,
            failedUnparsed: row.failedUnparsed,
            skipped: row.skipped,
            skippedBusy: row.skippedBusy,
            skippedNoModel: row.skippedNoModel,
            other: row.other,
            passRate: passRateOf(row),
            failRate: failRateOf(row),
            lastAt: row.lastAt,
            lastMs: row.lastMs,
            lastSource: row.lastSource,
            lastFailedAt: row.lastFailedAt,
            lastFailedReason: row.lastFailedReason,
          },
        ]);
      }
      rows.sort((a, b) => numberOr0(sessions.get(b[0])?.lastAtMs) - numberOr0(sessions.get(a[0])?.lastAtMs));
      return {
        since: createdAt,
        sessionCount: sessions.size,
        sessions: rows.slice(0, tailLimit),
        total: {
          calls: total.calls,
          passed: total.passed,
          declined: total.declined,
          wait: total.wait,
          failed: total.failed,
          failedTimeout: total.failedTimeout,
          failedError: total.failedError,
          failedUnparsed: total.failedUnparsed,
          skipped: total.skipped,
          skippedBusy: total.skippedBusy,
          skippedNoModel: total.skippedNoModel,
          other: total.other,
          passRate: passRateOf(total),
          failRate: failRateOf(total),
          lastAt: total.lastAt,
          lastMs: total.lastMs,
          lastSource: total.lastSource,
          lastChatId: total.lastChatId,
          lastFailedAt: total.lastFailedAt,
          lastFailedReason: total.lastFailedReason,
        },
      };
    } catch {
      // 连出一份快照都失败 ⇒ 给个**固定形状**的空结果，别让读的人判断"这个键在不在"。
      return {
        since: createdAt,
        sessionCount: 0,
        sessions: [],
        total: { ...emptyCounts(), passRate: null, failRate: null, lastChatId: '' },
      };
    }
  }

  return { record, snapshot };
}
