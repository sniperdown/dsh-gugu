/**
 * 旁路模型的**分文件配置**（2026-10-30）。
 *
 * ## 这一组在钉什么
 *
 * 用户原话：「除开说话的主模型，别的模型的设置…文件最好分开，这样方便备份与回滚，
 * 但最终落到同一个配置页」。所以这里钉四件事，每一件都对应一种会**静默失效**的写法：
 *
 * 1. **解析**：分文件存在就用它；不存在就**回落主文件**（老部署一个字节都不用改）。
 * 2. **加载器**：`loadMoodConfig` 这类函数读到的必须是**分文件里那份** ——
 *    否则「文件放好了但没人读」，页面显示一切正常。
 * 3. **写盘**：`POST /config` 要把键写进**它所属的那个文件**，备份名也跟着变
 *    （`qq-gugu.mood.toml.bak-*`）—— 不然"分文件"只是换了个位置放，回滚仍然连坐。
 * 4. **还原**：`GET /backups` + `POST /restore` 能真的把某一文件退回上一份，
 *    且还原前会把当前版本再备一份（还原本身也可还原）。
 *
 * ⚠️ 全组在 `test/.tmp-modelfiles-*` 下现造 toml 与备份目录，不碰线上那份 `qq-gugu.toml`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pluginModule from '../src/index.mjs';
import {
  describeModelFiles,
  fileKeyForSection,
  resolveModelToml,
  splitTomlPath,
} from '../src/dsh/toml-files.mjs';
import { CONFIG_FIELDS } from '../src/dsh/config-fields.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-modelfiles-';

function tempDir() {
  return fs.mkdtempSync(path.join(HERE, PREFIX));
}

function writeFile(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith(PREFIX)) fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
    }
  } catch {
    /* 收尾失败不影响测试结果 */
  }
});

// ---------------------------------------------------------------- 解析

test('splitTomlPath：只在中缀上加一段，其它原样', () => {
  assert.equal(splitTomlPath('H:\\p\\qq-gugu.toml', 'mood'), 'H:\\p\\qq-gugu.mood.toml');
  assert.equal(splitTomlPath('H:/p/qq-gugu.toml', 'voice'), path.join('H:/p', 'qq-gugu.voice.toml'));
  // `main` / 未知键 / 空路径 ⇒ 原样返回（绝不凭空造一个文件名出来）
  assert.equal(splitTomlPath('H:\\p\\qq-gugu.toml', 'main'), 'H:\\p\\qq-gugu.toml');
  assert.equal(splitTomlPath('H:\\p\\qq-gugu.toml', 'nope'), 'H:\\p\\qq-gugu.toml');
  assert.equal(splitTomlPath('', 'mood'), '');
});

test('resolveModelToml：分文件不存在 ⇒ 回落主文件（老部署不用改一个字）', () => {
  const dir = tempDir();
  const main = writeFile(dir, 'qq-gugu.toml', '[mood]\nprovider = "p"\n');
  const hit = resolveModelToml(main, 'mood');
  assert.equal(hit.split, false);
  assert.equal(hit.path, main);
  assert.equal(hit.splitPath, path.join(dir, 'qq-gugu.mood.toml'));
});

test('resolveModelToml：分文件存在 ⇒ 用它（不该读主文件里那份）', () => {
  const dir = tempDir();
  const main = writeFile(dir, 'qq-gugu.toml', '[mood]\nprovider = "main"\n');
  const split = writeFile(dir, 'qq-gugu.mood.toml', '[mood]\nprovider = "split"\n');
  const hit = resolveModelToml(main, 'mood');
  assert.equal(hit.split, true);
  assert.equal(hit.path, split);
});

test('describeModelFiles：六份文件都报出来，main 永远存在、旁路按需', () => {
  const dir = tempDir();
  const main = writeFile(dir, 'qq-gugu.toml', '');
  const files = describeModelFiles(main);
  assert.deepEqual(files.map((f) => f.key), ['main', 'mood', 'vision', 'sticker', 'voice', 'tts']);
  assert.equal(files[0].exists, true);
  assert.equal(files[1].splitExists, false, '还没拆分');
  assert.equal(files[1].split, false, '这次没用分文件');
  assert.equal(files[1].path, main, '不存在时分文件的 path 就是主文件');
  assert.equal(files[1].exists, true, '回落主文件 ⇒ 读得到');
});

test('fileKeyForSection：段名 → 文件键（情绪与语音共用一个文件）', () => {
  assert.equal(fileKeyForSection(['mood']), 'mood');
  assert.equal(fileKeyForSection(['vision_gate', 'cloud']), 'vision');
  assert.equal(fileKeyForSection(['sticker_gate']), 'sticker');
  assert.equal(fileKeyForSection(['sticker_audit']), 'sticker');
  assert.equal(fileKeyForSection(['voice']), 'voice');
  assert.equal(fileKeyForSection(['emotion']), 'voice', '情绪与转写是同一条链，共用一个文件');
  assert.equal(fileKeyForSection(['tts']), 'tts');
  assert.equal(fileKeyForSection(['personality']), 'main');
  assert.equal(fileKeyForSection(['send']), 'main');
});

test('CONFIG_FIELDS：每一项都有 file，且与段名对得上', () => {
  for (const field of CONFIG_FIELDS) {
    assert.ok(['main', 'mood', 'vision', 'sticker', 'voice', 'tts'].includes(field.file),
      `${field.key} 的 file 不合法：${field.file}`);
    assert.equal(field.file, fileKeyForSection(field.sectionPath), `${field.key} 的 file 与段名不一致`);
  }
});

// ---------------------------------------------------------------- 加载器

test('loadMoodConfig：有分文件就读分文件', () => {
  const dir = tempDir();
  const main = writeFile(dir, 'qq-gugu.toml', '[mood]\nprovider = "main-p"\nmodel = "main-m"\n');
  writeFile(dir, 'qq-gugu.mood.toml', '[mood]\nprovider = "split-p"\nmodel = "split-m"\n');
  const cfg = pluginModule.loadMoodConfig({ tomlPath: main });
  assert.equal(cfg.provider, 'split-p');
  assert.equal(cfg.model, 'split-m');
});

test('loadMoodConfig：没有分文件就照旧读主文件', () => {
  const dir = tempDir();
  const main = writeFile(dir, 'qq-gugu.toml', '[mood]\nprovider = "main-p"\nmodel = "main-m"\n');
  const cfg = pluginModule.loadMoodConfig({ tomlPath: main });
  assert.equal(cfg.provider, 'main-p');
  assert.equal(cfg.model, 'main-m');
});

test('loadEmotionConfig 与 loadVoiceConfig 共用 qq-gugu.voice.toml', () => {
  const dir = tempDir();
  const main = writeFile(dir, 'qq-gugu.toml', '[voice]\nenabled = false\n[emotion]\nenabled = false\n');
  writeFile(dir, 'qq-gugu.voice.toml', '[voice]\nenabled = true\n[emotion]\nenabled = true\n');
  assert.equal(pluginModule.loadVoiceConfig({ tomlPath: main }).enabled, true);
  assert.equal(pluginModule.loadEmotionConfig({ tomlPath: main }).enabled, true);
});

// ---------------------------------------------------------------- 写盘 / 备份 / 还原

/** 极简 req：`on` 收集监听，测试在 handler 开始 await 后再 `fire()`。 */
function makeReq(method, body) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method,
    url: '/',
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
      return req;
    },
    destroy() {},
  };
  const fire = () => {
    if (body !== undefined) {
      const chunk = Buffer.from(JSON.stringify(body), 'utf8');
      for (const fn of listeners.data) fn(chunk);
    }
    for (const fn of listeners.end) fn();
  };
  return { req, fire };
}

function makeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body += chunk === undefined ? '' : String(chunk);
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function routeOf(routes, suffix) {
  const route = routes.find((r) => r.path === `/dsh-qq-proactive/${suffix}`);
  assert.ok(route !== undefined, `缺路由 ${suffix}`);
  return route;
}

async function call(routes, suffix, method, body, query = '') {
  const { req, fire } = makeReq(method, body);
  if (query !== '') req.url = `/dsh-qq-proactive/${suffix}?${query}`;
  const res = makeRes();
  const pending = routeOf(routes, suffix).handler(req, res);
  fire();
  await pending;
  return res;
}

function makeRoutes() {
  const dir = tempDir();
  const tomlPath = writeFile(dir, 'qq-gugu.toml', [
    '[mood]',
    'provider = "main-p"',
    'model = "main-m"',
    '',
    '[personality]',
    'personality = """人格"""',
    '',
  ].join('\n'));
  const moodPath = writeFile(dir, 'qq-gugu.mood.toml', [
    '[mood]',
    'provider = "split-p"',
    'model = "split-m"',
    '',
  ].join('\n'));
  const backupDir = path.join(dir, 'backups');
  const routes = pluginModule.createFreeTimeHttpRoutes({ tomlPath, backupDir });
  return { dir, tomlPath, moodPath, backupDir, routes };
}

test('POST /config：心情的键写进 qq-gugu.mood.toml，不碰主文件', async () => {
  const { tomlPath, moodPath, routes } = makeRoutes();
  const beforeMain = fs.readFileSync(tomlPath, 'utf8');
  const res = await call(routes, 'config', 'POST', { scope: 'global', key: 'mood.model', value: 'new-m', confirm: true });
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.wrote, true);
  assert.equal(body.file, 'mood');
  assert.equal(body.tomlPath, moodPath);
  assert.ok(body.backup.includes('qq-gugu.mood.toml.bak-'), `备份名该带分文件名：${body.backup}`);
  assert.match(fs.readFileSync(moodPath, 'utf8'), /model = "new-m"/);
  assert.equal(fs.readFileSync(tomlPath, 'utf8'), beforeMain, '主文件一个字节都不该动');
});

test('POST /config：主文件的键仍然写主文件', async () => {
  const { tomlPath, routes } = makeRoutes();
  const res = await call(routes, 'config', 'POST', { scope: 'global', key: 'persona', value: '新人格' });
  assert.equal(res.status, 200);
  assert.equal(res.json().file, 'main');
  assert.match(fs.readFileSync(tomlPath, 'utf8'), /人格|新人格/);
});

test('GET /backups：只列这一份文件的备份（新 → 旧）', async () => {
  const { routes } = makeRoutes();
  await call(routes, 'config', 'POST', { scope: 'global', key: 'mood.model', value: 'v1', confirm: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await call(routes, 'config', 'POST', { scope: 'global', key: 'mood.model', value: 'v2', confirm: true });
  const res = await call(routes, 'backups', 'GET', undefined, 'file=mood');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.file, 'mood');
  assert.ok(body.backups.length >= 2, `至少两份备份，实得 ${body.backups.length}`);
  for (const item of body.backups) {
    assert.ok(item.name.startsWith('qq-gugu.mood.toml.bak-'), `不该列别的文件的备份：${item.name}`);
  }
});

test('POST /restore：把分文件退回上一份，且还原前先备了当前版本', async () => {
  const { moodPath, routes } = makeRoutes();
  await call(routes, 'config', 'POST', { scope: 'global', key: 'mood.model', value: 'after', confirm: true });
  assert.match(fs.readFileSync(moodPath, 'utf8'), /model = "after"/);
  const list = (await call(routes, 'backups', 'GET', undefined, 'file=mood')).json();
  const newest = list.backups[0].name;
  const res = await call(routes, 'restore', 'POST', { file: 'mood', name: newest, confirm: true });
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.restored, moodPath);
  assert.ok(body.safety.includes('qq-gugu.mood.toml.bak-'), '还原前该给当前版本再备一份');
  assert.match(fs.readFileSync(moodPath, 'utf8'), /model = "split-m"/, '应回到写入前那一版');
});

test('POST /restore：没带 confirm / 备份名带路径 / 不是这份文件的备份 ⇒ 全部拒绝', async () => {
  const { routes } = makeRoutes();
  await call(routes, 'config', 'POST', { scope: 'global', key: 'mood.model', value: 'x', confirm: true });
  const list = (await call(routes, 'backups', 'GET', undefined, 'file=mood')).json();
  const name = list.backups[0].name;
  const noConfirm = await call(routes, 'restore', 'POST', { file: 'mood', name });
  assert.equal(noConfirm.status, 400);
  const traversal = await call(routes, 'restore', 'POST', { file: 'mood', name: `../${name}`, confirm: true });
  assert.equal(traversal.status, 400);
  const wrongFile = await call(routes, 'restore', 'POST', {
    file: 'mood', name: name.replace('qq-gugu.mood.toml', 'qq-gugu.toml'), confirm: true,
  });
  assert.equal(wrongFile.status, 400);
});

// ---------------------------------------------------------------- 一次性搬迁（POST /split）

test('extractSectionBlock：带上注释块、带上子表、到下一个表头为止', () => {
  const lines = [
    '[alpha]',
    'a = 1',
    '',
    '# 这段注释属于 beta',
    '[beta]',
    'b = 1',
    '[beta.sub]',
    'c = 2',
    '',
    '[gamma]',
    'g = 3',
  ];
  const block = pluginModule.extractSectionBlock(lines, 'beta');
  assert.ok(block !== null);
  assert.equal(block.body.split('\n')[0], '# 这段注释属于 beta');
  assert.ok(block.body.includes('[beta.sub]'));
  assert.ok(!block.body.includes('[gamma]'));
  assert.equal(pluginModule.extractSectionBlock(lines, 'nope'), null);
});

test('POST /split：把五段搬进各自文件，读出来的值一个都不变', async () => {
  const dir = tempDir();
  const body = [
    '[personality]',
    'personality = """人格"""',
    '',
    '# 心情为什么这么配（注释要跟着走）',
    '[mood]',
    'enabled = true',
    'provider = "p-mood"',
    'model = "m-mood"',
    '',
    '[vision_gate]',
    'freeMiB = 4096',
    '[vision_gate.cloud]',
    'provider = "p-vision"',
    'model = "m-vision"',
    '[vision_gate.local]',
    'provider = ""',
    'model = ""',
    '',
    '[sticker_gate]',
    'provider = "p-sticker"',
    'model = "m-sticker"',
    'nsfwMax = 2',
    '',
    '[sticker_audit]',
    'enabled = false',
    '',
    '[voice]',
    'enabled = true',
    'language = "zh"',
    '',
    '[emotion]',
    'enabled = true',
    'arousal_high = 0.5',
    '',
    '[tts]',
    'enabled = true',
    'voice = "v-test"',
    '',
  ].join('\n');
  const tomlPath = path.join(dir, 'qq-gugu.toml');
  fs.writeFileSync(tomlPath, body, 'utf8');
  const backupDir = path.join(dir, 'backups');
  const routes = pluginModule.createFreeTimeHttpRoutes({ tomlPath, backupDir });

  const beforeMood = pluginModule.loadMoodConfig({ tomlPath });
  const beforeVoice = pluginModule.loadVoiceConfig({ tomlPath });
  const beforeEmotion = pluginModule.loadEmotionConfig({ tomlPath });
  const beforeTts = pluginModule.loadTtsConfig({ tomlPath });
  const beforeSticker = pluginModule.loadStickerGate({ tomlPath });
  const beforeVision = pluginModule.loadVisionGate({ tomlPath });

  const noConfirm = await call(routes, 'split', 'POST', {});
  assert.equal(noConfirm.status, 400);

  const res = await call(routes, 'split', 'POST', { confirm: true });
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.wrote.length, 5, `该拆出五份：${JSON.stringify(payload.wrote)}`);
  assert.ok(payload.backup.includes('qq-gugu.toml.bak-'), '主文件要先备份');

  const mainAfter = fs.readFileSync(tomlPath, 'utf8');
  for (const header of ['[mood]', '[vision_gate]', '[sticker_gate]', '[sticker_audit]', '[voice]', '[emotion]', '[tts]']) {
    assert.ok(!mainAfter.includes(header), `主文件里不该再有 ${header}`);
  }
  assert.ok(mainAfter.includes('[personality]'), '主文件的其它段要原样留着');
  assert.equal(fs.readFileSync(path.join(dir, 'qq-gugu.mood.toml'), 'utf8').includes('# 心情为什么这么配'), true,
    '注释要跟着段走');
  assert.equal(fs.readFileSync(path.join(dir, 'qq-gugu.vision.toml'), 'utf8').includes('[vision_gate.cloud]'), true,
    '子表要跟着段走');
  assert.equal(fs.readFileSync(path.join(dir, 'qq-gugu.sticker.toml'), 'utf8').includes('[sticker_audit]'), true);
  assert.equal(fs.readFileSync(path.join(dir, 'qq-gugu.voice.toml'), 'utf8').includes('[emotion]'), true);
  assert.equal(fs.readFileSync(path.join(dir, 'qq-gugu.tts.toml'), 'utf8').includes('[tts]'), true);

  // 读出来的值必须一模一样（这才是"搬到哪儿都一样"的判据）
  assert.deepEqual(pluginModule.loadMoodConfig({ tomlPath }), beforeMood);
  assert.deepEqual(pluginModule.loadVoiceConfig({ tomlPath }), beforeVoice);
  assert.deepEqual(pluginModule.loadEmotionConfig({ tomlPath }), beforeEmotion);
  assert.deepEqual(pluginModule.loadTtsConfig({ tomlPath }), beforeTts);
  assert.deepEqual(pluginModule.loadStickerGate({ tomlPath }), beforeSticker);
  assert.deepEqual(pluginModule.loadVisionGate({ tomlPath }), beforeVision);

  // 第二次调用：分文件已存在 ⇒ 一律跳过，不覆盖
  const again = (await call(routes, 'split', 'POST', { confirm: true })).json();
  assert.equal(again.wrote.length, 0);
  assert.equal(again.skipped.length, 5);
});
