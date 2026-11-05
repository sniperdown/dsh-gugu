/**
 * 出站语音合成器（2026-10-26，`tts.mjs`）：`edge-tts` → mp3。
 *
 * ## 这组测试钉什么
 *
 * 全部走注入（假 `spawnImpl` + 真临时目录），**不真的调 edge-tts、不联网**：
 * 1. **没开就得说清楚为什么**（`enabled` 关 / python 不存在）—— 否则"她为什么不发语音"只能猜；
 * 2. **截断按码点**、且结果里带上"从几个字截到几个字"（调用方要能把这事告诉她）；
 * 3. **缓存命中不 spawn**（短句复用率很高，命中就是 0 ms）；
 * 4. **失败是返回值，不是异常**：python 说失败 / 结果文件读不出来 / 起不了进程 / 超时。
 *
 * ⚠️ 临时目录用 `test/.tmp-tts-*`（不用 `os.tmpdir()`：受限沙箱里 `%TEMP%` 会被挡，
 * 那会让这组测试在本机永远是红的 —— 同 `voice-transcribe.test.mjs` 的理由）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { createTtsSpeaker, DEFAULT_TTS } from '../src/dsh/tts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-tts-';

function tempDir() {
  return fs.mkdtempSync(path.join(HERE, PREFIX));
}

process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith(PREFIX)) fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
    }
  } catch {
    /* 收尾失败不该影响测试结果 */
  }
});

function touch(file, body = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/** 从 argv 里取 `--name value`。 */
function argOf(args, name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? '' : String(args[i + 1] ?? '');
}

/**
 * 假 python：按 `--out` / `--result` 把文件写出来，行为由 `behavior` 决定。
 *
 * @param {{ok?: boolean, error?: string, bytes?: number, spawnThrows?: boolean, hang?: boolean}} behavior
 */
function fakeSpawn(behavior = {}) {
  const calls = [];
  const spawnImpl = (exe, args) => {
    const textFile = argOf(args, 'text-file');
    let text = '';
    try {
      text = fs.readFileSync(textFile, 'utf8');
    } catch {
      text = '';
    }
    calls.push({ exe, args, text });
    if (behavior.spawnThrows === true) throw new Error('ENOENT: 找不到 python');
    const out = argOf(args, 'out');
    const result = argOf(args, 'result');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    if (behavior.hang === true) return child; // 永不 close ⇒ 交给超时那一路
    setImmediate(() => {
      try {
        if (behavior.ok === false) {
          fs.mkdirSync(path.dirname(result), { recursive: true });
          fs.writeFileSync(result, JSON.stringify({ ok: false, error: behavior.error ?? '合成失败' }), 'utf8');
        } else {
          const bytes = behavior.bytes ?? 1024;
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, Buffer.alloc(bytes, 7));
          fs.mkdirSync(path.dirname(result), { recursive: true });
          fs.writeFileSync(result, JSON.stringify({ ok: true, ms: 5, bytes }), 'utf8');
        }
      } catch {
        /* 写不进去就让被测代码自己报"结果文件读不出来" */
      }
      child.emit('close', behavior.ok === false ? 1 : 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}

/** 一个"配齐了"的合成器（python / 脚本都指向真存在的临时文件）。 */
function speaker(overrides = {}) {
  const dir = tempDir();
  return createTtsSpeaker({
    enabled: true,
    pythonPath: touch(path.join(dir, 'python.exe')),
    scriptPath: touch(path.join(dir, 'tts-say.py')),
    cacheDir: path.join(dir, 'cache'),
    timeoutMs: 5_000,
    log: () => {},
    now: () => 1_700_000_000_000,
    ...overrides,
  });
}

test('没开（enabled=false）⇒ 直接拒，并把原因说清楚', async () => {
  const s = createTtsSpeaker({ enabled: false, log: () => {} });
  assert.equal(s.enabled, false);
  const r = await s.synthesize({ text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.error, /没开/);
  assert.match(s.describe().notReadyReason, /enabled/);
});

test('enabled 但 python 路径不存在 ⇒ 也算没开（别让她调了才发现没声音）', async () => {
  const s = createTtsSpeaker({
    enabled: true,
    pythonPath: path.join(HERE, '.tmp-tts-does-not-exist.exe'),
    scriptPath: path.join(HERE, '.tmp-tts-does-not-exist.py'),
    log: () => {},
  });
  assert.equal(s.enabled, false);
  assert.match(s.describe().notReadyReason, /python/);
});

test('★ 正常合成：走参数数组、报告字节数与耗时，并落一个 mp3', async () => {
  const { spawnImpl, calls } = fakeSpawn({ bytes: 2048 });
  const s = speaker({ spawnImpl });
  const r = await s.synthesize({ text: '喂喂，能听见吗？' });
  assert.equal(r.ok, true);
  assert.equal(r.cached, false);
  assert.equal(r.bytes, 2048);
  assert.ok(fs.existsSync(r.path), 'mp3 应该真的存在');
  // **参数走数组**：一条 spawn、argv 里能看到 --text-file/--out/--result（不经过 shell）。
  assert.equal(calls.length, 1);
  const argv = calls[0].args;
  assert.ok(argv.includes('--text-file') && argv.includes('--out') && argv.includes('--result'));
  assert.equal(calls[0].exe.endsWith('python.exe'), true);
  const d = s.describe();
  assert.equal(d.ok, 1);
  assert.equal(d.lastBytes, 2048);
});

test('★ 文本走文件、不塞进命令行（中文 + 引号都不该出现在 argv 里）', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  const s = speaker({ spawnImpl });
  const tricky = '他说"别念"——然后笑了 ~ ♡';
  const r = await s.synthesize({ text: tricky });
  assert.equal(r.ok, true);
  // ⚠️ 成功后 `.txt` 会被清掉（缓存目录别越堆越大），所以文本是在假 spawn 里读下来存的。
  assert.equal(calls[0].text, tricky);
  assert.ok(!calls[0].args.some((a) => a.includes('别念')), '正文不能出现在 argv 里');
});

test('★ 超长截断：按码点切，并把 from/to 报给调用方', async () => {
  const { spawnImpl } = fakeSpawn();
  const s = speaker({ spawnImpl, maxChars: 5 });
  const r = await s.synthesize({ text: '一二三四五六七八九十' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.truncated, { from: 10, to: 5 });
  assert.equal(r.chars, 5);
  assert.equal(s.describe().truncated, 1);
});

test('emoji 不会因为截断被切成半个代理对', async () => {
  const { spawnImpl } = fakeSpawn();
  const s = speaker({ spawnImpl, maxChars: 2 });
  const r = await s.synthesize({ text: '😀😀😀' });
  assert.equal(r.ok, true);
  assert.equal(r.chars, 2);
});

test('★ 缓存：同音色同参数同文本 ⇒ 第二次不 spawn', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  const s = speaker({ spawnImpl });
  const first = await s.synthesize({ text: '晚安' });
  const second = await s.synthesize({ text: '晚安' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1, '第二次应该命中缓存，不该再起 python');
  assert.equal(s.describe().cached, 1);
});

test('换音色 ⇒ 不是同一个缓存（同一个文件不能给两种声音）', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  const s = speaker({ spawnImpl });
  await s.synthesize({ text: '晚安' });
  await s.synthesize({ text: '晚安', voice: 'zh-CN-YunxiNeural' });
  assert.equal(calls.length, 2);
});

test('★ python 说失败 ⇒ 把它的原因原样带出来（不静默丢）', async () => {
  const { spawnImpl } = fakeSpawn({ ok: false, error: 'Invalid voice' });
  const s = speaker({ spawnImpl });
  const r = await s.synthesize({ text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Invalid voice/);
  assert.equal(s.describe().failed, 1);
});

test('起不了 python（spawn 抛）⇒ 失败但**不抛**', async () => {
  const { spawnImpl } = fakeSpawn({ spawnThrows: true });
  const s = speaker({ spawnImpl });
  const r = await s.synthesize({ text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.error, /起不了 python/);
});

test('结果文件读不出来（比如 python 崩了）⇒ 报退出码，不假装成功', async () => {
  const dir = tempDir();
  const s = createTtsSpeaker({
    enabled: true,
    pythonPath: touch(path.join(dir, 'python.exe')),
    scriptPath: touch(path.join(dir, 'tts-say.py')),
    cacheDir: path.join(dir, 'cache'),
    log: () => {},
    // 什么都不写的假进程：模拟"python 直接崩了、没落结果文件"。
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit('close', 3));
      return child;
    },
  });
  const r = await s.synthesize({ text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.error, /结果文件|退出码/);
});

test('超时 ⇒ 杀掉进程、当失败处理（别把这一轮挂住）', async () => {
  const { spawnImpl } = fakeSpawn({ hang: true });
  const s = speaker({ spawnImpl, timeoutMs: 50 });
  const r = await s.synthesize({ text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.error, /超时/);
});

test('空文本 ⇒ 直接拒（不去起进程）', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  const s = speaker({ spawnImpl });
  const r = await s.synthesize({ text: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /空的/);
  assert.equal(calls.length, 0);
});

test('DEFAULT_TTS：默认**关**、群里默认**不许**、上限 120 字', () => {
  assert.equal(DEFAULT_TTS.enabled, false);
  assert.equal(DEFAULT_TTS.allowGroups, false);
  assert.equal(DEFAULT_TTS.maxChars, 120);
  assert.equal(DEFAULT_TTS.voice, 'zh-CN-XiaoxiaoNeural');
});
