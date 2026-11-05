#!/usr/bin/env node
/**
 * 一条命令体检：这台机器**还差什么**才能把 QQ 机器人跑起来。
 *
 * 写给谁看：产品负责人，不是开发者。所以：
 *   - 输出是**人话**（缺什么、去哪填、填错会怎样），不是堆技术错误；
 *   - **默认不往控制台打中文**（Windows 控制台是 GBK，中文/emoji 会变乱码），
 *     而是把完整报告写成 UTF-8 文件，控制台只回一行 ASCII 摘要 + 文件路径；
 *   - 想直接在终端看中文：加 `--stdout`（前提是你的终端按 UTF-8 解码）。
 *
 * 用法：
 *   node tools/bootstrap.mjs                 # 体检 + 写报告文件
 *   node tools/bootstrap.mjs --stdout        # 顺便把中文报告打到控制台
 *   node tools/bootstrap.mjs --home <DSH_HOME> --profile desktop
 *   node tools/bootstrap.mjs --napcat D:\QQNT\napcat\config
 *
 * 退出码：0 = 没有「必须处理」的问题；1 = 有。
 *
 * ⚠️ 本脚本**只读**：不写 profile、不改配置、不动别人的文件。
 *    唯一的写入是仓库里 `runtime/`（已在 .gitignore 里）下的报告文件。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { dshHome } from '../src/dsh/paths.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ── 基本位置 ────────────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO, 'runtime');
const OUT_FILE = path.join(OUT_DIR, 'bootstrap-report.txt');

// ── 命令行参数 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const WANT_STDOUT = argv.includes('--stdout');

const DSH_HOME = argOf('--home') || process.env.DSH_HOME || dshHome();
const PROFILE = argOf('--profile') || process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const NAPCAT_CONFIG_DIR = argOf('--napcat') || 'D:\QQNT\\napcat\\config';

const PROFILE_PATCH = path.join(PROFILE_DIR, 'cordis.patch.yml');
const PROFILE_PKG = path.join(PROFILE_DIR, 'package.json');
const GUGU_TOML = process.env.QQ_GUGU_TOML || path.join(PROFILE_DIR, 'qq-gugu.toml');

// ── 体检结果收集 ────────────────────────────────────────────────────────────
/** @type {{level:'fail'|'warn'|'ok'|'info', title:string, now:string, where:string, why:string}[]} */
const findings = [];
const add = (level, title, now = '', where = '', why = '') =>
  findings.push({ level, title, now, where, why });
const fail = (...a) => add('fail', ...a);
const warn = (...a) => add('warn', ...a);
const ok = (...a) => add('ok', ...a);
const info = (...a) => add('info', ...a);

/** 把 QQ 号/群号中间打码 —— 报告可能被贴到别处，没必要带全量号码。 */
const mask = (v) => {
  const s = String(v ?? '');
  if (s === '') return '(空)';
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 3)}${'*'.repeat(Math.max(1, s.length - 5))}${s.slice(-2)}`;
};
const maskList = (v) => (Array.isArray(v) && v.length > 0 ? v.map(mask).join('、') : '(空)');
/** chatId（`private:123` / `group:456`）里的号码也要打码。 */
const maskChat = (v) => String(v ?? '').replace(/\d{5,}/g, (d) => mask(d));

// ── 小工具 ──────────────────────────────────────────────────────────────────
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // 存在但解析失败
  }
}
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 读 profile 的 cordis.patch.yml。
 *
 * 优先用**真 YAML 解析器**（profile 自己的 node_modules 里通常有），
 * 解析不了就退回文本扫描 —— 体检脚本不能因为一个解析器缺失就整个罢工。
 */
function loadPatch() {
  const text = readText(PROFILE_PATCH);
  if (text === null) return { text: null, entries: null, how: 'missing', reason: '' };
  // profile 的 node_modules 里通常有 `yaml`，退一步也有 `js-yaml`。都不在就文本扫描。
  const errors = [];
  let jsTags = false;
  for (const mod of ['yaml', 'js-yaml']) {
    try {
      const req = createRequire(path.join(PROFILE_DIR, 'node_modules', mod, 'package.json'));
      const lib = req(mod);
      const parse = lib?.parse ?? lib?.load ?? lib?.default?.parse ?? lib?.default?.load;
      if (typeof parse !== 'function') {
        errors.push(`${mod}: 没有 parse/load 方法`);
        continue;
      }
      const doc = parse(text);
      if (Array.isArray(doc)) return { text, entries: doc, how: 'yaml', parser: mod, reason: '', jsTags: false };
      errors.push(`${mod}: 顶层不是数组（是 ${doc === null ? 'null' : typeof doc}）`);
    } catch (e) {
      const msg = String(e?.message ?? e?.code ?? e).split('\n')[0];
      // Cordis 的 patch 文件里有 `!js` 自定义标签，普通 YAML 解析器不认 —— 这是正常的，不是错误。
      if (/tag:yaml\.org,2002:js/.test(msg) || /!js\b/.test(msg)) jsTags = true;
      errors.push(`${mod}: ${msg}`);
    }
  }
  return { text, entries: null, how: 'text', parser: '', reason: errors.join('；'), jsTags };
}

/**
 * 文本扫描：把 `- id: qq-proactive` 那一段抠出来，按**缩进**还原成嵌套对象。
 *
 * 为什么不用正则一把梭：`proactive:` / `report:` 下面的键是嵌套的，
 * 全平铺到一层会互相覆盖（`report.enabled` 和 `proactive.enabled` 撞名），
 * 于是"工作了汇报开没开、目标填没填"就会judged错 —— 假警报比不报还糟。
 */
function scanPluginBlock(text, id) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(l));
  if (start === -1) return null;

  const stripQuotes = (v) => v.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  const root = {};
  /** @type {{indent:number, obj:object}[]} */
  const stack = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-\s/.test(line)) break; // 下一个顶层条目（本段配置里没有块状列表项）
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue; // 空行/注释不算
    const m = line.match(/^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue; // 数组项等不关心的行
    const indent = m[1].length;
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1].obj : root;
    if (m[3].trim() === '') {
      const child = {};
      parent[m[2]] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[m[2]] = stripQuotes(m[3]);
    }
  }

  // 顶层是 `- id: X` 然后 `config:` 下面才是真正的配置，所以取 config 那层。
  const cfgObj = root.config !== null && typeof root.config === 'object' ? root.config : root;
  const listOf = (key) => {
    const raw = cfgObj[key];
    if (typeof raw === 'string' && raw.trim().startsWith('[')) {
      return raw
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => stripQuotes(s))
        .filter((s) => s !== '');
    }
    return Array.isArray(raw) ? raw : [];
  };
  return { fields: cfgObj, listOf, start };
}

/** 端口有没有人占着。`free:true` = 我们能绑上。 */
function probePort(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    const done = (r) => {
      try {
        srv.close(() => resolve(r));
      } catch {
        resolve(r);
      }
    };
    srv.once('error', (e) => resolve({ free: false, code: e.code }));
    srv.once('listening', () => done({ free: true }));
    try {
      srv.listen(port, host);
    } catch (e) {
      resolve({ free: false, code: e.code });
    }
  });
}

// ============================================================================
// 体检开始
// ============================================================================

// ── 1. 本机基础环境 ─────────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 22) {
  ok('Node 版本', `v${process.versions.node}（要求 >= 22）`);
} else {
  fail(
    'Node 版本太旧',
    `现在：v${process.versions.node}`,
    '去 https://nodejs.org 装 Node 22 或更高（装 LTS 就行）',
    '插件用了 Node 22 才有的特性，版本低了会直接报语法错误。',
  );
}

for (const [label, file] of [
  ['插件入口 src/index.mjs', path.join(REPO, 'src', 'index.mjs')],
  ['插件清单 package.json', path.join(REPO, 'package.json')],
  ['插件自带的 cordis.patch.yml', path.join(REPO, 'cordis.patch.yml')],
  ['设置页 client.js', path.join(REPO, 'client.js')],
  ['测试入口 tools/run-all-tests.mjs', path.join(REPO, 'tools', 'run-all-tests.mjs')],
]) {
  if (isFile(file)) ok(label, '在');
  else fail(label, '找不到', `确认仓库完整：${REPO}`, '文件缺失说明仓库没拉全（或被杀软删了）。');
}

// ── 2. DSH 主目录与 profile ─────────────────────────────────────────────────
const homeFromArg = argOf('--home');
const homeSource = homeFromArg ? '--home 参数' : process.env.DSH_HOME ? '环境变量 DSH_HOME' : '内置默认值';
if (homeFromArg || process.env.DSH_HOME) {
  ok(`DSH 主目录（来自${homeSource}）`, DSH_HOME);
} else {
  warn(
    '环境变量 DSH_HOME 没设',
    `本脚本按默认值往下走：${DSH_HOME}`,
    'Windows「系统属性 → 环境变量」里新建**用户变量** DSH_HOME，值填你的 DSH 主目录（例如 <DSH_HOME>）',
    'DSH 靠这个变量找配置和会话；不设的话它会用默认位置，你的旧配置就"看不见"了。',
  );
}
if (!process.env.DSH_PROFILE) {
  info('环境变量 DSH_PROFILE 没设', `按默认 profile 名往下走：${PROFILE}`, '', '多 profile 并存时才需要设。');
}
if (isDir(PROFILE_DIR)) {
  ok('profile 目录', PROFILE_DIR);
} else {
  fail(
    'profile 目录不存在',
    `找不到：${PROFILE_DIR}`,
    `确认 DSH 装好并至少启动过一次；目录名要和 DSH_PROFILE（现在=「${PROFILE}」）对得上`,
    '插件的配置就写在 profile 目录里，目录不在就无从谈起。',
  );
}

// ── 3. profile 里挂没挂这个插件 ─────────────────────────────────────────────
const profilePkg = readJson(PROFILE_PKG);
if (profilePkg === null) {
  fail('profile 的 package.json 不存在', `找不到：${PROFILE_PKG}`, '先让 DSH 正常启动一次，它会生成这个文件', '');
} else if (profilePkg === undefined) {
  fail('profile 的 package.json 解析失败', '文件在，但不是合法 JSON', `修一下：${PROFILE_PKG}`, '多半是编辑时多了/少了逗号。');
} else {
  const deps = profilePkg.dependencies ?? {};
  const bundles = profilePkg.dsh?.profile?.bundles ?? [];
  if (Object.keys(deps).includes('dsh-qq-proactive')) ok('插件已装进 profile', String(deps['dsh-qq-proactive']));
  else
    fail(
      '插件没装进 profile',
      'package.json 的 dependencies 里没有 dsh-qq-proactive',
      `在 ${PROFILE_PKG} 的 dependencies 里加一行： "dsh-qq-proactive": "link:${REPO}"`,
      '没装进 profile，DSH 根本不会加载它。',
    );
  if (Array.isArray(bundles) && bundles.includes('dsh-qq-proactive')) ok('插件已在 bundles 列表里', '');
  else
    fail(
      '插件没进 bundles',
      `bundles 现在是：${Array.isArray(bundles) ? bundles.join('、') : '(读不到)'}`,
      `在 ${PROFILE_PKG} 的 dsh.profile.bundles 数组里加上 "dsh-qq-proactive"`,
      'bundles 决定哪些插件会被激活；不在里面 = 装了也不生效。',
    );
}

// ── 4. 插件配置本体 ─────────────────────────────────────────────────────────
const patch = loadPatch();
let cfg = null; // 归一化后的配置对象
let cfgHow = '';

if (patch.text === null) {
  fail(
    'profile 的 cordis.patch.yml 不存在',
    `找不到：${PROFILE_PATCH}`,
    '从备份拷回来，或照 docs/config.example.cordis.patch.yml 新建一份',
    '插件的行为配置全在这个文件里。',
  );
} else if (patch.entries) {
  const entry = patch.entries.find((e) => e && e.id === 'qq-proactive');
  if (entry) {
    cfg = entry.config ?? {};
    cfgHow = 'yaml';
  }
} else {
  const block = scanPluginBlock(patch.text, 'qq-proactive');
  if (block) {
    cfg = {
      ...block.fields,
      _listOf: block.listOf,
    };
    cfgHow = 'text';
  }
}

if (patch.text !== null && cfg === null) {
  fail(
    'cordis.patch.yml 里没有 qq-proactive 这一条',
    `文件在（${PROFILE_PATCH}），但找不到 \`- id: qq-proactive\``,
    '照 docs/config.example.cordis.patch.yml 把这一段追加到文件末尾',
    '没有这一条，插件不会被激活——表现是"啥都没发生"。',
  );
}

if (cfg) {
  if (cfgHow === 'text') {
    if (patch.jsTags) {
      info(
        '配置读取方式：文本扫描（正常，不是毛病）',
        '文件里有 Cordis 自己的 `!js` 标签，普通 YAML 解析器不认——这是 DSH 的正常写法',
        '',
        '所以本报告的"嵌套字段"（proactive / report）是按文本估的，个别结论可能偏保守。',
      );
    } else {
      warn(
        'cordis.patch.yml 没能按 YAML 解析',
        patch.reason || '（没拿到原因）',
        `这份体检退回了"文本扫描"，结论仍可用；但**解析不了本身可能就是启动失败的原因** —— 打开 ${PROFILE_PATCH} 检查缩进/引号/重复键`,
        'DSH 启动时要解析这个文件；解析失败会让整个 profile 起不来。',
      );
    }
  }

  const listOf = (key) =>
    typeof cfg._listOf === 'function'
      ? cfg._listOf(key)
      : Array.isArray(cfg[key])
        ? cfg[key]
        : typeof cfg[key] === 'string' && cfg[key].trim() !== ''
          ? String(cfg[key]).split(',').map((s) => s.trim())
          : [];

  const pick = (obj, key) => (obj && typeof obj === 'object' ? obj[key] : undefined);
  const mode = String(cfg.mode ?? 'reverse');

  // 连接方式
  if (['reverse', 'forward', 'http'].includes(mode)) ok('连接方式 mode', mode);
  else fail('连接方式 mode 不合法', `现在：${JSON.stringify(cfg.mode)}`, '只能是 reverse / forward / http', '插件不会激活。');

  let port = 0;
  if (mode === 'reverse') {
    const token = String(cfg.accessToken ?? '');
    if (token !== '') ok('accessToken', `已填（${mask(token)}）`);
    else
      fail(
        '反向模式缺 accessToken',
        '现在是空的',
        `在 ${PROFILE_PATCH} 的 qq-proactive 条目里补： accessToken: '<一串口令>'，并与 NapCat 侧填**一模一样**的值`,
        '反向模式下留空会**直接拒绝启动**（端口都不开）——空的监听端口等于把 QQ 号交给整个同网段。',
      );
    port = Number(cfg.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ok('监听端口 port', String(port));
    else fail('监听端口 port 不合法', JSON.stringify(cfg.port), '填 1~65535 之间的整数（部署用的是 18661）', '插件不会激活。');
    const host = String(cfg.host ?? '127.0.0.1');
    info('监听地址 host', host, '', '保持 127.0.0.1 就只对本机开放；改成 0.0.0.0 会暴露到局域网。');
  } else if (mode === 'forward') {
    const url = String(cfg.url ?? '');
    if (/^wss?:\/\//.test(url)) ok('正向地址 url', url);
    else fail('正向模式缺合法 url', `现在：${JSON.stringify(cfg.url)}`, '填 ws:// 或 wss:// 开头的地址', '插件不会激活。');
  } else {
    const url = String(cfg.httpUrl ?? '');
    if (/^https?:\/\//.test(url)) ok('HTTP 地址 httpUrl', url);
    else fail('http 模式缺合法 httpUrl', `现在：${JSON.stringify(cfg.httpUrl)}`, '填 http:// 或 https:// 开头的 NapCat API 地址', '插件不会激活。');
    warn('http 模式收不到群消息', '只发不收', '想让小鲸鱼"能主动插话"，用 reverse 模式', '主动插话要靠群消息转录判断话题，收不到事件就永远不开口。');
  }

  // 身份
  if (String(cfg.botQQ ?? '') !== '') ok('机器人自己的 QQ botQQ', mask(cfg.botQQ));
  else warn('没填 botQQ', '空', '填机器人（小鲸鱼）自己的 QQ 号', '部分场景要靠它区分"谁是自己"，不填可能把机器人自己的发言当人类消息。');

  const admins = listOf('adminUsers');
  if (admins.length > 0) ok('管理员 adminUsers', maskList(admins));
  else
    fail(
      '没配 adminUsers',
      '空列表',
      `填**你自己的 QQ 号**（至少一个）： adminUsers: [ '你的QQ' ]`,
      '私聊和斜杠命令只对管理员开放；一个都不配 = 你自己也被当"受限用户"，让小鲸鱼干活会被拒。',
    );

  // 出站白名单（用户硬边界）
  const dmPolicy = String(cfg.dmPolicy ?? 'admin');
  const allowFrom = listOf('allowFrom');
  const groupPolicy = String(cfg.groupPolicy ?? 'admin');
  const groupAllow = listOf('groupAllowFrom');

  if (dmPolicy !== 'allowlist') {
    warn('私聊白名单不是 allowlist', `现在：${dmPolicy}`, '建议 dmPolicy: allowlist + allowFrom: [ 你的QQ ]', '白名单是这个项目最要紧的一道闸门，别放开。');
  } else if (allowFrom.length === 0) {
    fail(
      '私聊白名单是空的',
      'dmPolicy=allowlist 但 allowFrom 为空',
      `填你自己： allowFrom: [ '你的QQ' ]`,
      '出站全被拒：上线播报、工作汇报都会静默失败（看起来像"插件没反应"）。',
    );
  } else {
    ok('私聊出站白名单 allowFrom', maskList(allowFrom));
  }

  if (groupPolicy !== 'allowlist') {
    warn('群白名单不是 allowlist', `现在：${groupPolicy}`, '建议 groupPolicy: allowlist + groupAllowFrom: [ 群号 ]', '同上：这是硬边界，改成 open 等于哪个群都能被机器人说话。');
  } else if (groupAllow.length === 0) {
    fail(
      '群白名单是空的',
      'groupPolicy=allowlist 但 groupAllowFrom 为空',
      `填目标群号： groupAllowFrom: [ '群号1', '群号2' ]`,
      '群方向的主动发言与汇报全部被拒。',
    );
  } else {
    ok('群出站白名单 groupAllowFrom', maskList(groupAllow));
  }

  // 模型与会话
  const preset = String(cfg.agentPreset ?? '');
  const hasGuguPreset = patch.text !== null && /id:\s*preset-gugu/.test(patch.text);
  if (preset === '') {
    warn('没配 agentPreset', '空 → 会用 standard preset', '填 agentPreset: gugu', 'standard 的人格是"编码助手"，小鲸鱼会用错口吻说话。');
  } else if (preset === 'gugu' && !hasGuguPreset) {
    fail(
      '配了 agentPreset: gugu，但 profile 里没有 preset-gugu',
      '两者对不上',
      `照 docs/config.example.gugu-preset.md 把 preset-gugu 补进 ${PROFILE_PATCH}`,
      '会话会退回默认 preset，小鲸鱼的人设不生效。',
    );
  } else {
    ok('agentPreset', `${preset}${preset === 'gugu' && hasGuguPreset ? '（preset-gugu 已在 profile 里）' : ''}`);
  }

  if (String(cfg.provider ?? '') !== '' && String(cfg.model ?? '') !== '') {
    ok('小鲸鱼用的模型', `${cfg.provider} / ${cfg.model}`);
  } else {
    warn('没显式配 provider/model', '会跟部署全局默认走', '填 provider 与 model（要选**支持识图**的那个）', '全局默认可能是不支持图片的模型，小鲸鱼就"看不见"图了。');
  }

  const wsPath = String(cfg.workspacePath ?? '');
  if (wsPath === '') warn('没配 workspacePath', '空', '填会话的工作目录', '会话的工作目录会落到 DSH 进程的目录，GUI 里的归属会跑偏。');
  else if (isDir(wsPath)) ok('会话工作目录 workspacePath', wsPath);
  else warn('workspacePath 指向的目录不存在', wsPath, '确认这个目录在这台机器上存在（换机器最容易忘这一条）', '');

  const online = String(cfg.onlineAnnounce ?? '');
  if (online === '') info('没配 onlineAnnounce', '留空 = 不播报上线', '', '');
  else ok('上线播报目标 onlineAnnounce', maskChat(online));

  // 主动发言（文本扫描模式下拿不到嵌套对象，只能整串找 `enabled: true`）
  const proactive = pick(cfg, 'proactive');
  const proactiveOn =
    typeof proactive === 'object' && proactive !== null
      ? proactive.enabled
      : /enabled\s*:\s*true/.test(String(cfg.proactive ?? '')) || cfg.enabled === 'true' || cfg.enabled === true
        ? true
        : cfg.proactive;
  if (proactiveOn === true || proactiveOn === 'true') ok('主动发言 proactive.enabled', '开着');
  else info('主动发言没开', 'enabled 不是 true', '', '不开的话小鲸鱼只在被 @ / 私聊时说话，不会自己冒泡。');

  // 工作汇报
  const report = pick(cfg, 'report');
  const reportRaw = String(cfg.report ?? '');
  const reportOn =
    typeof report === 'object' && report !== null
      ? report.enabled
      : /enabled\s*:\s*true/.test(reportRaw) || cfg.enabled === 'true' || cfg.enabled === true
        ? true
        : undefined;
  const reportTarget =
    typeof report === 'object' && report !== null
      ? String(report.target ?? '')
      : (reportRaw.match(/target\s*:\s*['"]?([^'"\s,}]+)/)?.[1] ?? '');
  if (reportOn === true || reportOn === 'true') {
    if (reportTarget !== '') ok('工作汇报目标 report.target', maskChat(reportTarget));
    else
      fail(
        '工作汇报开了但没填目标',
        'report.enabled=true 而 report.target 为空',
        `补上 report.target，形如 private:<你的QQ> 或 group:<群号>`,
        'enabled=true 时 target 为空会**拒绝启动**。',
      );
  } else {
    info('工作汇报没开', '', '', '开了才能在任务卡住时喊你。');
  }
}

// ── 5. 人格文件 ─────────────────────────────────────────────────────────────
const tomlText = readText(GUGU_TOML);
if (tomlText === null) {
  warn(
    '人格文件找不到',
    `找不到：${GUGU_TOML}`,
    '照 docs/config.example.qq-gugu.toml 建一份，或设环境变量 QQ_GUGU_TOML 指向它',
    '找不到不是致命错：插件会退回配置里的 persona 字段；但那个字段通常是空的 ⇒ 小鲸鱼没有性格。',
  );
} else {
  const personality = tomlText.match(/^\s*personality\s*=\s*"""([\s\S]*?)"""/m)?.[1]?.trim() ?? '';
  const inlinePersonality = tomlText.match(/^\s*personality\s*=\s*"([^"]*)"/m)?.[1]?.trim() ?? '';
  const len = (personality || inlinePersonality).length;
  if (len > 0) ok('人格文件 [personality]', `${GUGU_TOML}（人格文本 ${len} 字）`);
  else warn('[personality] 段是空的', GUGU_TOML, '把人格文本填进 personality = """…"""', '空人格 = 小鲸鱼说话没有性格，措辞会退化成通用模板。');

  const missingSection = !/^\s*\[proactive\]/m.test(tomlText);
  if (missingSection) info('toml 里没有 [proactive] 段', '主动发言参数会全走代码默认值', '', '');
  else ok('toml 的 [proactive] 段', '在');
}

// ── 6. NapCat 侧 ────────────────────────────────────────────────────────────
const wantPort = cfg ? Number(cfg.port) : 0;
let napcatFile = null;
if (isDir(NAPCAT_CONFIG_DIR)) {
  const candidates = fs.readdirSync(NAPCAT_CONFIG_DIR).filter((n) => /^onebot11_.*\.json$/.test(n));
  if (candidates.length > 0) {
    napcatFile = path.join(NAPCAT_CONFIG_DIR, candidates[0]);
    if (candidates.length > 1) {
      info('NapCat 配置有好几份', candidates.join('、'), '本报告只看第一份，换机器时容易看错', '');
    }
  } else {
    warn('NapCat 配置目录里没有 onebot11_*.json', NAPCAT_CONFIG_DIR, '在 NapCat 的 WebUI 里新建一个 OneBot11 网络配置', '没有它，NapCat 不知道要把消息推给谁。');
  }
} else {
  warn(
    '找不到 NapCat 配置目录',
    `默认找的是：${NAPCAT_CONFIG_DIR}`,
    'NapCat 装在别处就用参数指一下： node tools/bootstrap.mjs --napcat <你的配置目录>',
    '找不到就没法核对"两边端口/口令对不对得上"——这俩对不上是最常见的"完全没反应"。',
  );
}

if (napcatFile) {
  const nap = readJson(napcatFile);
  if (nap === undefined) {
    warn('NapCat 配置解析失败', napcatFile, '用 NapCat 的 WebUI 重新保存一次', '');
  } else if (nap === null) {
    warn('NapCat 配置读不到', napcatFile, '', '');
  } else {
    ok('NapCat 配置文件', napcatFile);
    const net_ = nap.network ?? {};
    const clients = Array.isArray(net_.websocketClients) ? net_.websocketClients : [];
    const servers = Array.isArray(net_.websocketServers) ? net_.websocketServers : [];
    const httpServers = Array.isArray(net_.httpServers) ? net_.httpServers : [];

    if (wantPort > 0) {
      const wantUrl = `ws://127.0.0.1:${wantPort}`;
      const hit = [...clients, ...servers].find((c) => String(c?.url ?? '').includes(`:${wantPort}`));
      if (hit && hit.enable === true) {
        ok('NapCat → 插件的反向连接', `${hit.name ?? '(未命名)'} → ${hit.url}（已启用）`);
        const napToken = String(hit.token ?? '');
        const ourToken = String(cfg?.accessToken ?? '');
        if (napToken !== '' && ourToken !== '' && napToken !== ourToken) {
          fail(
            '两边的口令（token）不一致',
            'NapCat 侧与插件侧填的不是同一个值',
            `让两边一样：NapCat 的 ${napcatFile}，插件的 ${PROFILE_PATCH}`,
            '口令对不上，握手会被拒（HTTP 401），表现就是"完全收不到消息"。',
          );
        } else if (napToken === '') {
          warn('NapCat 侧没填 token', String(hit.name ?? ''), '填成和插件 accessToken 一样的值', '插件侧是 fail-closed 的，口令我这边有、你那边没有，照样连不上。');
        } else {
          ok('两边口令一致', `（${mask(ourToken)}）`);
        }
      } else if (hit) {
        fail(
          'NapCat → 插件的连接没启用',
          `${hit.name ?? '(未命名)'} → ${hit.url}，enable 不是 true`,
          `在 NapCat 的 WebUI 里把这条「WebSocket 客户端」打开，或直接在 ${napcatFile} 里把 enable 改成 true`,
          '连接没开 = 消息永远推不过来。',
        );
      } else {
        fail(
          'NapCat 侧没有指向插件的连接',
          `没有任何 WebSocket 客户端/服务端的 url 命中端口 ${wantPort}（期望 ${wantUrl}）`,
          `在 NapCat 的 WebUI 里新增一条「WebSocket 客户端」，上报地址填 ${wantUrl}，token 与插件 accessToken 一致`,
          '反向模式下是 **NapCat 主动拨给插件**，所以这条必须在 NapCat 侧配。',
        );
      }
    }

    const httpPort = String(cfg?.httpUrl ?? '').match(/:(\d+)/)?.[1];
    if (httpPort) {
      const hit = httpServers.find((s) => String(s?.port ?? '') === httpPort);
      if (hit) {
        if (hit.enable === true) ok('NapCat 的 HTTP 服务', `端口 ${httpPort} 已启用`);
        else warn('NapCat 的 HTTP 服务没启用', `端口 ${httpPort}`, `在 NapCat 里打开它，或改 ${napcatFile}`, '');
      } else {
        warn('NapCat 侧没有对应的 HTTP 服务', `插件配了 httpUrl 用端口 ${httpPort}`, '在 NapCat 里加一个 HTTP 服务器，端口对上', '');
      }
    }
  }
}

// ── 7. 端口的实际占用情况 ───────────────────────────────────────────────────
if (cfg && String(cfg.mode ?? 'reverse') === 'reverse' && wantPort > 0) {
  const host = String(cfg.host ?? '127.0.0.1');
  const r = await probePort(host, wantPort);
  if (r.free) {
    ok('端口可用性', `${host}:${wantPort} 现在没人占（DSH 没在跑时就是这样）`);
  } else if (r.code === 'EADDRINUSE') {
    info(
      '端口已被占用',
      `${host}:${wantPort}`,
      '如果 DSH 正开着，这就是插件自己在监听 —— 正常；DSH 没开却占用，说明有别的程序抢了这个端口，换一个（两边都要改）',
      '',
    );
  } else {
    info('端口没测成', `${host}:${wantPort}（${r.code ?? '未知原因'}）`, '', '');
  }
}

// ── 8. 凭据与密钥 ───────────────────────────────────────────────────────────
// 只按"名字里带 credential"去找，不写死具体文件名和绝对路径。
let credFiles = [];
if (isDir(DSH_HOME)) {
  try {
    credFiles = fs.readdirSync(DSH_HOME).filter((n) => /credential/i.test(n));
  } catch {
    /* 读不到就算了 */
  }
}
if (credFiles.length > 0) {
  ok('DSH 凭据文件', `找到 ${credFiles.length} 个（即本报告里的「<凭据文件>」）`);
  warn(
    '凭据文件在外面跑之前确认一下',
    '里面是 API 密钥等敏感内容',
    '恢复时从旧机器整个拷过来即可（放回 DSH_HOME 根目录）；**不要**拷进这个 git 仓库、不要发给别人',
    '这个仓库是要给人看的，密钥绝不能进去。',
  );
} else {
  warn(
    'DSH 凭据文件没找到',
    `在 ${DSH_HOME} 下没找到名字含 credential 的文件`,
    '启动 DSH，在界面里登录 / 填 API 密钥；或把旧机器的凭据文件整个拷到 DSH_HOME 根目录',
    '没有它，模型调不通 —— 表现是"消息收到了但永远不回"。',
  );
}

// ── 9. 生成报告 ─────────────────────────────────────────────────────────────
const fails = findings.filter((f) => f.level === 'fail');
const warns = findings.filter((f) => f.level === 'warn');
const oks = findings.filter((f) => f.level === 'ok');
const infos = findings.filter((f) => f.level === 'info');

const L = [];
const rule = (ch = '─') => ch.repeat(72);
L.push(rule('='));
L.push(' 小鲸鱼 QQ 机器人 · 从零恢复体检报告');
L.push(rule('='));
L.push(` 生成时间：${new Date().toLocaleString('zh-CN')}`);
L.push(` 仓库位置：${REPO}`);
L.push(` 体检对象：${PROFILE_DIR}`);
L.push(` NapCat 配置：${napcatFile ?? NAPCAT_CONFIG_DIR + '（没找到）'}`);
L.push('');
L.push(' 【结论】');
if (fails.length === 0 && warns.length === 0) {
  L.push('   ✅ 一切就绪，可以直接启动 DSH 试跑了。');
} else if (fails.length === 0) {
  L.push(`   🟡 没有"跑不起来"的问题；有 ${warns.length} 处建议看一眼（见第三节）。`);
} else {
  L.push(`   ⛔ 有 ${fails.length} 项**必须处理**才能跑起来，见第二节。`);
}
L.push(`   （必须处理 ${fails.length} · 建议看一眼 ${warns.length} · 已就绪 ${oks.length}）`);
L.push('');

const section = (no, title, list, render, emptyNote) => {
  L.push(rule());
  L.push(` ${no}、${title}`);
  L.push(rule());
  if (list.length === 0) {
    L.push(`  （${emptyNote}）`);
    L.push('');
    return;
  }
  list.forEach((f, i) => render(f, i));
  L.push('');
};

section('一', '已经就绪', oks, (f) => {
  L.push(`  ✓ ${f.title}${f.now ? `：${f.now}` : ''}`);
}, '一项都没就绪 —— 从第一节开始按顺序做吧');

section('二', '必须处理（不处理跑不起来）', fails, (f, i) => {
  L.push(`  ${i + 1}. ⛔ ${f.title}`);
  if (f.now) L.push(`     现在： ${f.now}`);
  if (f.where) L.push(`     去哪填： ${f.where}`);
  if (f.why) L.push(`     为什么： ${f.why}`);
  L.push('');
}, '没有 —— 这一节空着是好事');

section('三', '建议看一眼（不致命，但会以奇怪的方式表现出来）', warns, (f, i) => {
  L.push(`  ${i + 1}. 🟡 ${f.title}`);
  if (f.now) L.push(`     现在： ${f.now}`);
  if (f.where) L.push(`     怎么办： ${f.where}`);
  if (f.why) L.push(`     为什么： ${f.why}`);
  L.push('');
}, '没有 —— 全是小毛病也没有');

section('四', '只是说明（不用管）', infos, (f, i) => {
  L.push(`  ${i + 1}. · ${f.title}${f.now ? `：${f.now}` : ''}`);
  if (f.where) L.push(`     ${f.where}`);
}, '没有');

L.push(rule('='));
L.push(' 下一步');
L.push(rule('='));
L.push('  1. 把上面「必须处理」的逐条填掉，再跑一次本脚本，直到它说"一切就绪"。');
L.push('  2. 完整步骤见 README.md 的「从零部署」（装什么、每个字段填什么、怎么验证）。');
L.push('  3. 字段样板见 docs/config.example.cordis.patch.yml 与 docs/config.example.qq-gugu.toml。');
L.push('  4. 启动 DSH 之后，在 QQ 里私聊机器人发一句话 —— 能回就说明整条链路通了。');
L.push('');
L.push(' 提醒：本报告不含完整 QQ 号（中间打了码），但**依然不要**贴到公开的地方。');
L.push(rule('='));

const reportText = `${L.join('\n')}\n`;

try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, reportText, 'utf8');
} catch (e) {
  // 写不了文件也要把结论吐出来，不能让体检脚本自己变成一个问题
  process.stdout.write(`[bootstrap] cannot write report file: ${e.code ?? e.message}\n`);
  process.stdout.write('[bootstrap] run with --stdout to see the report\n');
  if (WANT_STDOUT) process.stdout.write(reportText);
  process.exitCode = fails.length > 0 ? 1 : 0;
}

// ── 10. 控制台只打 ASCII（GBK 控制台不会乱码）────────────────────────────────
// 注意：这里**故意不打中文**。报告正文在 UTF-8 文件里，需要时用 --stdout 看。
if (fs.existsSync(OUT_FILE)) {
  const out = [];
  out.push('='.repeat(72));
  out.push(' dsh-qq-proactive bootstrap check');
  out.push('='.repeat(72));
  out.push(` report (UTF-8, Chinese): ${OUT_FILE}`);
  out.push(` result: ${fails.length} FAIL / ${warns.length} WARN / ${oks.length} OK`);
  if (fails.length > 0) out.push(' verdict: NOT READY - fix the FAIL items');
  else if (warns.length > 0) out.push(' verdict: RUNNABLE - but read the WARN items');
  else out.push(' verdict: READY');
  out.push('-'.repeat(72));
  out.push(' open the report file above, or re-run with --stdout');
  out.push('='.repeat(72));
  process.stdout.write(`${out.join('\n')}\n`);

  if (WANT_STDOUT) {
    process.stdout.write('\n');
    process.stdout.write(reportText);
  }
}

process.exitCode = fails.length > 0 ? 1 : 0;
