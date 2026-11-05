/**
 * `[prompt]` 段 + 最终提示词预览（2026-10-30）。
 *
 * 用户在配置页上"看不见那行字"的根因是：身份第一行、说话方式那四条、群聊骨架、
 * 工作目录那句，全都写死在代码里。这一组钉四件事：
 *
 * 1. **默认值 = 搬迁前的原文**（没配时一个字节都不变）；
 * 2. **配了就照配的来**（`buildPersona` 与网关/人格尾句各取所需）；
 * 3. **空串/纯空白 = 用默认**（配置写错不该让她变成另一个人）；
 * 4. **`/prompt-preview` 能把最终提示词拼出来**（"改完能看见"才谈得上敢改）。
 *
 * ⚠️ 临时 toml 落在 `test/.tmp-promptcfg-*`，不碰线上那份。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pluginModule from '../src/index.mjs';
import {
  DEFAULT_PROMPT_CONFIG,
  normalizePromptConfig,
  promptConfigFromDocument,
} from '../src/dsh/prompt-config.mjs';
import { parseToml } from '../src/dsh/toml.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-promptcfg-';

function tempDir() {
  return fs.mkdtempSync(path.join(HERE, PREFIX));
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

test('默认值就是内置兜底文案（身份第一行 / 说话方式四条 / 三句骨架）', () => {
  const cfg = normalizePromptConfig({});
  assert.equal(cfg.identity, '你是「小鲸鱼」，DeepSeek 出品的一只 AI 小鲸鱼，现在通过 QQ 和大家聊天。');
  assert.ok(cfg.personaStyle.includes('- 简短优先'));
  assert.ok(cfg.personaStyle.includes('- 不要每次自我介绍'));
  assert.equal(cfg.turnGroupHeader, '群里刚在聊：');
  assert.equal(cfg.turnAtHeader, '【刚 @ 你的那条】');
  assert.ok(cfg.turnPureAt.includes('@ 了你，但没说话'));
  assert.equal(cfg.workdir, 'Your working directory is ');
  // 六项齐全
  assert.deepEqual(Object.keys(cfg).sort(), Object.keys(DEFAULT_PROMPT_CONFIG).sort());
});

test('配了就照配的来；空串 / 纯空白 ⇒ 回默认（不许把默认顶成空）', () => {
  const cfg = normalizePromptConfig({
    identity: '你是小白鱼。',
    personaStyle: '   ',
    turnGroupHeader: '刚才在聊：',
    workdir: 'cwd=',
    turnPureAt: '',
  });
  assert.equal(cfg.identity, '你是小白鱼。');
  assert.equal(cfg.personaStyle, DEFAULT_PROMPT_CONFIG.personaStyle);
  assert.equal(cfg.turnGroupHeader, '刚才在聊：');
  assert.equal(cfg.workdir, 'cwd=');
  assert.equal(cfg.turnPureAt, DEFAULT_PROMPT_CONFIG.turnPureAt);
});

test('buildPersona：身份与【说话方式】跟着配置走，其余段不受影响', () => {
  const p = { persona: 'P', reply_style: 'R', emotion_style: 'E', interest: 'I', rules: 'RULES' };
  const text = pluginModule.buildPersona(p, { identity: '你是小白鱼。', personaStyle: '- 只说一句' });
  assert.ok(text.includes('你是小白鱼。'));
  assert.ok(text.includes('- 只说一句'));
  assert.ok(!text.includes('简洁优先'));
  for (const section of ['【人格】', '【表达风格】', '【情绪】', '【兴趣】', 'RULES']) {
    assert.ok(text.includes(section), `缺 ${section}`);
  }
  // 不传 promptCfg ⇒ 和搬迁前逐字节一样
  assert.equal(pluginModule.buildPersona(p), pluginModule.buildPersona(p, null));
  assert.ok(pluginModule.buildPersona(p).includes('你是「小鲸鱼」'));
});

test('buildPersona：新段按顺序出现、空串整段跳过、自称填了才加一行', () => {
  const full = pluginModule.buildPersona({
    persona: 'P',
    relations: 'REL',
    reply_style: 'R',
    emotion_style: 'E',
    interest: 'I',
    chat_sense: 'SENSE',
    ai_flavor: 'BLACK',
    examples: 'EX',
  }, { selfName: '本鱼' });
  const order = ['【人格】', '【跟谁说话】', '【表达风格】', '【情绪】', '【兴趣】', '【说话方式】', '【群聊里怎么判断】', '【AI 味】', '【例子】'];
  let last = -1;
  for (const title of order) {
    const at = full.indexOf(title);
    assert.ok(at > last, `${title} 没出现或顺序不对（at=${at}, last=${last}）`);
    last = at;
  }
  assert.ok(full.includes('自称固定用「本鱼」'), '填了 self_name 就该注入那一行');

  // 新段全空 + 不填自称 ⇒ 与"扩段之前"逐字节相同（老 toml 不用改也能跑）
  const legacy = pluginModule.buildPersona({ persona: 'P', reply_style: 'R', emotion_style: 'E', interest: 'I' });
  assert.ok(!legacy.includes('【跟谁说话】'), '空串的段不该出现');
  assert.ok(!legacy.includes('【AI 味】'));
  assert.ok(!legacy.includes('自称固定用'));
  assert.equal(legacy, pluginModule.buildPersona({ persona: 'P', reply_style: 'R', emotion_style: 'E', interest: 'I' }, { selfName: '  ' }), '只有空白的自称等于没填');
});

test('从 toml 文档/文件读 [prompt]：没这一节就全默认', () => {
  const doc = parseToml('[prompt]\nidentity = "你是测试鱼。"\nturn_at_header = "【这条 @ 你】"\n');
  const cfg = promptConfigFromDocument(doc);
  assert.equal(cfg.identity, '你是测试鱼。');
  assert.equal(cfg.turnAtHeader, '【这条 @ 你】');
  assert.equal(cfg.turnGroupHeader, DEFAULT_PROMPT_CONFIG.turnGroupHeader);

  const dir = tempDir();
  const file = path.join(dir, 'qq-gugu.toml');
  fs.writeFileSync(file, '[prompt]\npersona_style = "- 短"\n', 'utf8');
  const loaded = pluginModule.loadPromptConfig({ tomlPath: file });
  assert.equal(loaded.personaStyle, '- 短');
  assert.equal(loaded.identity, DEFAULT_PROMPT_CONFIG.identity);

  const empty = path.join(dir, 'empty.toml');
  fs.writeFileSync(empty, '[personality]\npersonality = "P"\n', 'utf8');
  const fallback = pluginModule.loadPromptConfig({ tomlPath: empty });
  assert.equal(fallback.identity, DEFAULT_PROMPT_CONFIG.identity);
});

// ---------------------------------------------------------------- /prompt-preview

function makeReq() {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method: 'GET',
    url: '/',
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
      return req;
    },
    destroy() {},
  };
  return {
    req,
    fire: () => {
      for (const fn of listeners.end) fn();
    },
  };
}

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(chunk) { this.body += chunk === undefined ? '' : String(chunk); },
    json() { return JSON.parse(this.body); },
  };
}

async function call(routes, suffix, query = '') {
  const route = routes.find((r) => r.path === `/dsh-qq-proactive/${suffix}`);
  assert.ok(route !== undefined, `缺路由 ${suffix}`);
  const { req, fire } = makeReq();
  req.url = query === '' ? `/dsh-qq-proactive/${suffix}` : `/dsh-qq-proactive/${suffix}?${query}`;
  const res = makeRes();
  const pending = route.handler(req, res);
  fire();
  await pending;
  return res;
}

function makeRoutes() {
  const dir = tempDir();
  const tomlPath = path.join(dir, 'qq-gugu.toml');
  fs.writeFileSync(tomlPath, '[personality]\npersona = "全局人格"\nskill = ""\n', 'utf8');
  const personaSections = {
    global: {
      persona: '全局人格', reply_style: '', emotion_style: '', interest: '', rules: '',
    },
    groups: { 123: { persona: '这个群的人格' } },
    privates: {},
  };
  const routes = pluginModule.createFreeTimeHttpRoutes({
    tomlPath,
    backupDir: path.join(dir, 'backups'),
    personaSections,
    promptCfg: normalizePromptConfig({ identity: '你是测试鱼。' }),
    workspacePath: 'H:\\ws',
    effective: {
      send: { rule: '发 QQ 的规矩正文' },
    },
  });
  return { routes };
}

test('GET /prompt-preview：拼出人格 / 工作目录 / 发 QQ 规矩，并给字数', async () => {
  const { routes } = makeRoutes();
  const res = await call(routes, 'prompt-preview', 'scope=global');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.scope, 'global');
  const byName = new Map(body.parts.map((part) => [part.name, part]));
  assert.ok(byName.get('persona').text.includes('你是测试鱼。'));
  assert.ok(byName.get('persona').text.includes('全局人格'));
  assert.equal(byName.get('workdir').text, 'Your working directory is H:\\ws.');
  assert.ok(byName.get('send-rule').text.includes('发 QQ 的规矩正文'));
  const sum = body.parts.reduce((n, part) => n + part.chars, 0);
  assert.equal(body.totalChars, sum);
  for (const part of body.parts) assert.equal(part.chars, part.text.length);
});

test('GET /prompt-preview：群作用域用合并后的人格', async () => {
  const { routes } = makeRoutes();
  const body = (await call(routes, 'prompt-preview', 'scope=group:123')).json();
  const persona = body.parts.find((part) => part.name === 'persona');
  assert.ok(persona.text.includes('这个群的人格'));
  assert.deepEqual(body.overridden, ['persona']);
});

test('GET /prompt-preview：scope 写错 ⇒ 400（不猜、不回落全局）', async () => {
  const { routes } = makeRoutes();
  const res = await call(routes, 'prompt-preview', 'scope=group:abc');
  assert.equal(res.status, 400);
});
