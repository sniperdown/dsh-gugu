/**
 * 小鲸鱼的**推理等级**（reasoning effort）配置（2026-10-21）。
 *
 * ## 为什么要有它
 *
 * 在这之前，这一项只能写在 profile 的 `cordis.patch.yml` 里
 * （`- id: qq-proactive` → `reasoningEffort: low`），配置页既看不到也改不了。
 * 用户 2026-10-21 明确要求：「插件应当有一个能改小鲸鱼推理等级的地方」。
 *
 * ## 合法取值是**查证过的**，不是猜的
 *
 * DSH 的 `AgentOptions.reasoningEffort` **没有全局枚举** —— `dsh-agent` README 的原话是
 * 「optional **adapter-owned** `reasoningEffort`」；真正的校验发生在请求发出之前
 * （`@deepseek-ai/dsh-llm/lib/index.js` 的 `resolveCallWithInfo`：值不在模型声明的
 * `reasoning.efforts` 里就抛 `UNSUPPORTED_REASONING_EFFORT`）。
 *
 * 本插件现在跑的那条路由是 `deepseek-official`（适配器 `dsh-llm-deepseek`），
 * 它的合法档位**写死在源码里**：
 *
 *   - `node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:321-326`
 *     → `reasoningEffort: z.union(["off","low","high","max"])`
 *   - 同文件 `:465-485` → `REASONING_EFFORTS = [off, low, high, max]`
 *
 * ⇒ **没有 `medium` / `minimal` / `xhigh`**。给这条路由传 `medium` 不会"降级成 low"，
 *   而是**每一次调用都抛错**（那一轮就没有任何回复）。所以取值必须钉死在这里。
 *
 * 另一个随 DSH 发布的适配器 `dsh-llm-pi-ai` 的档位是
 * `THINKING_LEVELS = off/minimal/low/medium/high/xhigh/max`
 * （`dsh-llm-pi-ai/lib/index.js:299-307`），但**每个模型只接受自己在
 * `reasoningEfforts` 里声明过的那些**。两个适配器的**交集**恰好是 `off/low/high/max`
 * —— 配置页只给这四个：以后把 provider/model 换到任何一条 DSH 自带路由上，
 * 都不会踩到"选了个不存在的档"。
 *
 * ## 非法值怎么办：**夹到默认 `low`，并 warn**（不拒绝加载、也不静默忽略）
 *
 * 配置文件写错不该让小鲸鱼整个起不来（和本项目所有 toml 读取器同一条规矩：永不 throw），
 * 但也**不许装作没事**：写错时必须留一条 warn（带写错的值与合法清单），然后按 `low` 跑。
 *
 * ⚠️ 为什么"夹到默认"而不是"当成没写、回落到 patch 里的旧值"：
 * 后者会让「我写了 high」和「我把 high 打成 highh」在快照里**长得一模一样**
 * （都是 patch 那个值）—— 那正是这个项目最贵的一类坑（"配置写了却不生效"）。
 */

import fs from 'node:fs';

import { parseToml } from './toml.mjs';

/**
 * 推理等级的合法取值 —— **查证过**（见文件头），不是照 brief 抄的
 * `low | medium | high`：`medium` 在这条路由上会直接抛错。
 */
export const REASONING_EFFORT_VALUES = Object.freeze(['off', 'low', 'high', 'max']);

/**
 * 缺省值（2026-10-21 之前的行为就是这个值，改动**不偷偷换档**）。
 *
 * 它来自 profile 的 `cordis.patch.yml`（`reasoningEffort: low`）——
 * 用户当时的决定：「闲聊用 low」（高推理会把一句闲聊当调研跑满 50 步、堵住私聊）。
 */
export const DEFAULT_REASONING_EFFORT = 'low';

/**
 * 把 `[agent]` 段（或任意对象）收敛成 `{reasoning, source}`。
 *
 * 优先级（三层）：
 * 1. `[agent] reasoning` 写了且合法 ⇒ 用它，`source: 'config'`；
 * 2. 写了但**不合法** ⇒ 夹到 {@link DEFAULT_REASONING_EFFORT}，`source: 'default'`，**并 warn**；
 * 3. 没写 ⇒ 回落到旧的 `cordis.patch.yml` 值（`legacyEffort`，`source: 'config'`）；
 *    连它也没有 ⇒ `low` / `source: 'default'`。
 *
 * @param {unknown} section `parseToml` 里的 `doc.agent`（可能不存在 / 类型不对）
 * @param {object} [options]
 * @param {string} [options.legacyEffort] 旧的插件配置值（`config.reasoningEffort`，来自 patch）
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @returns {{reasoning: string, source: 'config'|'default'}}
 */
export function normalizeAgentConfig(section, { legacyEffort = '', log = () => {} } = {}) {
  const raw = section !== null && typeof section === 'object' && !Array.isArray(section) ? section : {};
  const value = raw.reasoning;

  if (typeof value === 'string' && REASONING_EFFORT_VALUES.includes(value.trim())) {
    return { reasoning: value.trim(), source: 'config' };
  }
  if (value !== undefined && value !== null) {
    // 写错（拼错 / 大小写错 / 写了这条路由没有的 medium）⇒ 夹到缺省 + 留痕。
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
    log(
      'warn',
      `[agent] reasoning 的值不合法（${shown}），按缺省值 ${DEFAULT_REASONING_EFFORT} 跑`,
      { allowed: [...REASONING_EFFORT_VALUES], fallback: DEFAULT_REASONING_EFFORT },
    );
    return { reasoning: DEFAULT_REASONING_EFFORT, source: 'default' };
  }

  const legacy = String(legacyEffort ?? '').trim();
  if (legacy !== '') return { reasoning: legacy, source: 'config' };
  return { reasoning: DEFAULT_REASONING_EFFORT, source: 'default' };
}

/**
 * 读 `qq-gugu.toml` 的 `[agent]`：小鲸鱼的推理等级（2026-10-21）。
 *
 * ```toml
 * [agent]
 * reasoning = "low"   # off | low | high | max（以 DSH 实际支持的为准，见文件头）
 * ```
 *
 * 读不到文件 / 那一节不存在 ⇒ 走 {@link normalizeAgentConfig} 的缺省路径（**不抛异常**）。
 * 路径由调用方给（`config.tomlPath`，由 `resolveConfig()` 统一定，见 index.mjs 里的说明）；
 * 空串 = 没有 toml 可读 ⇒ 只用 `legacyEffort` / 缺省，**不去猜部署路径**。
 *
 * @param {{tomlPath?: string, reasoningEffort?: string}} [config] 经 `resolveConfig` 的配置
 * @param {(level: string, message: string, meta?: object) => void} [log]
 * @returns {{reasoning: string, source: 'config'|'default'}}
 */
export function loadAgentConfig(config = {}, log = () => {}) {
  const tomlPath = String(config?.tomlPath ?? '');
  let section = null;
  if (tomlPath !== '') {
    try {
      const doc = parseToml(fs.readFileSync(tomlPath, 'utf8'));
      section = doc?.agent ?? null;
    } catch (error) {
      log('warn', '读 qq-gugu.toml 的 [agent] 失败，推理等级按缺省值处理', {
        tomlPath,
        error: error instanceof Error ? error.message : String(error),
      });
      section = null;
    }
  }
  return normalizeAgentConfig(section, { legacyEffort: config?.reasoningEffort, log });
}
