/**
 * 配置层不变式测试：**群里那份 preset 真的存在，且真的是「私聊那份减去几个工具」。**
 *
 * 为什么需要它：`binding.mjs` 里的群 preset 名是**推导**出来的
 * （`<私聊 preset> + '-lite'`），而那份 preset 本身定义在 profile 的
 * `cordis.patch.yml` 里 —— 一边是代码、一边是配置，天然会漂。
 * 这条测试把"两边必须对得上"变成一次**测试失败**，而不是一次静默回退：
 * 名字对不上的后果很具体 —— `mount()` 抛 `Unknown agent preset`，
 * 群会话退回私聊那份（**又带上 shell，而且子会话会继承它**）。
 *
 * ⚠️ 这份配置在**用户环境**里（`<DSH_HOME>\profiles\desktop\cordis.patch.yml`），
 * 不在仓库里。所以：
 *   - 找得到 → **严格断言**；
 *   - 找不到 / 解析不了（没装 js-yaml）→ **skip**，而不是假绿或假红。
 *
 * 找文件的位置按这个顺序：`QQ_PRESET_CONFIG` → `DSH_HOME` → `~/.dsh` → `<DSH_HOME>`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

import { resolveSessionPreset, GROUP_PRESET_SUFFIX } from '../src/dsh/binding.mjs';

/** 这份 preset 比私聊那份少的几个插件行。 */
const GROUP_DROPPED_ROWS = ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-plugin-manager'];

/** 私聊挂的那份 / 群挂的那份（后者由前者推导）。 */
const PRIVATE_PRESET = 'gugu';
const GROUP_PRESET = `${PRIVATE_PRESET}${GROUP_PRESET_SUFFIX}`;

/** 候选位置，第一个存在的就用。 */
function locateConfig() {
  const candidates = [];
  if (typeof process.env.QQ_PRESET_CONFIG === 'string' && process.env.QQ_PRESET_CONFIG !== '') {
    candidates.push(process.env.QQ_PRESET_CONFIG);
  }
  for (const home of [process.env.DSH_HOME, path.join(homedir(), '.dsh'), '<DSH_HOME>']) {
    if (typeof home === 'string' && home !== '') {
      candidates.push(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'));
    }
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

const configPath = locateConfig();

/**
 * 用 DSH 自己的 entry-list 方言解析（`!!js` 是标量，构造出 `{ __jsExpr }` 节点）。
 *
 * schema 和 `@deepseek-ai/cordis-plugin-include` 的 `entryListSchema` 逐字段一致；
 * 那份在宿主安装树里，第三方插件解析不到，所以这里照抄一份（就这 6 行）。
 * js-yaml 从 profile 的 node_modules 里借 —— 借不到就跳过。
 */
function loadPatch(file) {
  // require 基准 = 配置所在的那个目录（配置就住在 profile 目录里，
  // 它的 node_modules 里有 js-yaml）。带尾斜杠的目录路径即可。
  const require = createRequire(path.join(path.dirname(file), path.sep));
  const yaml = require('js-yaml');
  const jsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: String(data) }),
  });
  return yaml.load(readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA.extend(jsExpr) });
}

/** 从一份 patch 文档里取出某个 preset 声明的 `plugins`。 */
function presetRows(doc, id) {
  for (const entry of doc ?? []) {
    if (!Array.isArray(entry?.insert)) continue;
    for (const row of entry.insert) {
      if (row?.config?.id === id) return row.config.plugins;
    }
  }
  return null;
}

const skipReason =
  configPath === null
    ? '没找到 profile 的 cordis.patch.yml（设 QQ_PRESET_CONFIG 或 DSH_HOME 可指定）'
    : undefined;

test('配置不变式：群那份 preset 存在，且 = 私聊那份减去那几个工具行', { skip: skipReason }, () => {
  let doc;
  try {
    doc = loadPatch(configPath);
  } catch (error) {
    // js-yaml 借不到（profile 里没装）—— 跳过而不是判失败。
    assert.ok(true, `跳过：解析不了 ${configPath}（${error.message}）`);
    return;
  }

  const privateRows = presetRows(doc, PRIVATE_PRESET);
  const groupRows = presetRows(doc, GROUP_PRESET);

  assert.ok(privateRows !== null, `配置里必须有 preset ${PRIVATE_PRESET}（条目 config.id）`);
  assert.ok(
    groupRows !== null,
    `配置里必须有 preset ${GROUP_PRESET} —— 代码里群会话是按 "${PRIVATE_PRESET}${GROUP_PRESET_SUFFIX}" 推导的；` +
      '没有它，群会话会静默退回私聊那份（又带上 shell，子会话还会继承）',
  );

  // ★ 逐字段相等，不是"行数对得上"：人格文本、工具 config、disabled、嵌套组都要一致，
  //   否则"群和私聊只差那几个工具"这句话就是假的。
  const expected = privateRows.filter((row) => !GROUP_DROPPED_ROWS.includes(row.id));
  assert.deepEqual(
    groupRows,
    expected,
    `${GROUP_PRESET} 必须**恰好**等于 ${PRIVATE_PRESET} 去掉 ${GROUP_DROPPED_ROWS.join(' / ')}`,
  );

  const ids = new Set(groupRows.map((row) => row.id));
  for (const dropped of GROUP_DROPPED_ROWS) {
    assert.equal(ids.has(dropped), false, `${GROUP_PRESET} 里不该有 ${dropped}`);
  }
});

test('配置不变式：代码推导出来的名字 == 配置里那个 preset 的 config.id', { skip: skipReason }, () => {
  // 这条是"两边接线接对了"的最小断言：改代码后缀、或改配置里的 id，
  // 任意一边动了这里就红。
  assert.equal(
    resolveSessionPreset({ sessionKey: 'qq-group-30000011', agentPreset: PRIVATE_PRESET }),
    GROUP_PRESET,
  );

  let doc;
  try {
    doc = loadPatch(configPath);
  } catch {
    assert.ok(true, '跳过：js-yaml 借不到');
    return;
  }
  assert.ok(presetRows(doc, GROUP_PRESET) !== null, `配置里找不到 ${GROUP_PRESET}`);
});
