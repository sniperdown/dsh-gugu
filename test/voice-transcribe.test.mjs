/**
 * B4 真答案（2026-10-25）：**语音转文字** —— 本地 faster-whisper。
 *
 * 真机定论过：NapCat 的 `record` 段只有 `file`/`path`/`url`/`file_size`，**没有 `text`**。
 * 所以链路是：
 *
 * ```
 * record 段 → action('get_record', {file, out_format:'wav'})   ← NapCat 把 SILK 解成 WAV
 *           → spawn(.venv python, tools/transcribe-voice.py)   ← faster-whisper
 *           → message.text 里的 [语音（未转写）] 换成 [语音：<文字>]
 * ```
 *
 * ## 这组测试**不 spawn 真 python**
 *
 * 全部走注入：`spawnImpl` 假进程（按 `--out` 参数把 JSON 写出来）+ 假 `fs` 里的真实临时目录。
 * 真机链路已经手动验过（3.6 秒的语音 → 「测试测试123123」，约 4.9 秒含模型加载），
 * 这里钉的是**编排**：取音频、超时、缓存、失败降级、以及"网关把文字放进提示词"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVoiceTranscriber, DEFAULT_VOICE } from '../src/dsh/voice.mjs';
import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { createOutboundAllow } from '../src/dsh/outbound-allow.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-voice-';

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

/** 造一个"存在"的文件（转写器只检查存在性，不执行）。 */
function touch(file) {
  fs.writeFileSync(file, 'x', 'utf8');
  return file;
}

/** 从参数里取 `--flag value`。 */
function argOf(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? '' : String(args[index + 1] ?? '');
}

/**
 * 假 spawn：**按 `--out` 把 JSON 写出来**，然后走到 `close(0)`。
 * @param {object} [options]
 * @param {string} [options.text] 写进结果的 text
 * @param {number} [options.code] 退出码
 * @param {boolean} [options.neverClose] 永不 close（测超时）
 * @param {() => void} [options.before] close 之前的回调（测并发/计数）
 */
function fakeSpawn(options = {}) {
  const calls = [];
  const spawnImpl = (exe, args) => {
    calls.push({ exe, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let killed = false;
    child.kill = () => { killed = true; return true; };
    child.__killed = () => killed;
    if (options.neverClose !== true) {
      setImmediate(() => {
        if (typeof options.before === 'function') options.before();
        const out = argOf(args, '--out');
        if (out !== '' && options.writeJson !== false) {
          fs.writeFileSync(
            out,
            JSON.stringify({ ok: true, text: options.text ?? '你好呀', language: 'zh', duration: 1.2 }),
            'utf8',
          );
        }
        child.emit('close', options.code ?? 0);
      });
    }
    return child;
  };
  return { spawnImpl, calls };
}

function liveTranscriber(overrides = {}) {
  const dir = tempDir();
  return createVoiceTranscriber({
    enabled: true,
    pythonPath: touch(path.join(dir, 'python.exe')),
    scriptPath: touch(path.join(dir, 'transcribe.py')),
    modelPath: '',
    cachePath: path.join(dir, 'cache.json'),
    tempDir: path.join(dir, 'tmp'),
    log: () => {},
    ...overrides,
  });
}

/** 一段"真实形状"的 record 段（2026-10-25 真机抓到的键）。 */
const RECORD = Object.freeze({
  type: 'record',
  file: '0aaf0b0abc189e20565a1a629f6afbff.amr',
  path: 'D:\\QQNT\\data\\30000002\\nt_qq\\nt_data\\Ptt\\2026-10\\Ori\\0aaf0b0abc189e20565a1a629f6afbff.amr',
  url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc',
  file_size: '7035',
});

// ---------------------------------------------------------------- 开关与配置

test('★ 没启用 ⇒ 立刻返回失败，且**绝不**去取音频（省一次网络/一次 spawn）', async () => {
  let called = 0;
  const transcriber = createVoiceTranscriber({
    enabled: false,
    pythonPath: 'x',
    scriptPath: 'y',
    log: () => {},
    spawnImpl: () => { called += 1; throw new Error('不该 spawn'); },
  });
  assert.equal(transcriber.enabled, false);
  const result = await transcriber.transcribe({
    segment: RECORD,
    action: async () => { called += 1; return {}; },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /没启用/);
  assert.equal(called, 0);
});

test('配了 enabled 但 python 路径不存在 ⇒ enabled=false + 一条 warn（别等到真有语音才失败）', () => {
  const logs = [];
  const transcriber = createVoiceTranscriber({
    enabled: true,
    pythonPath: path.join(HERE, '.tmp-voice-missing-python.exe'),
    scriptPath: path.join(HERE, '.tmp-voice-missing-script.py'),
    log: (level, message) => logs.push({ level, message }),
  });
  assert.equal(transcriber.enabled, false);
  assert.equal(logs.some((entry) => entry.level === 'warn' && /python/.test(entry.message)), true);
});

test('默认值只有一份：DEFAULT_VOICE 里 enabled 是 false（转写不是插件的默认决定）', () => {
  assert.equal(DEFAULT_VOICE.enabled, false);
  assert.equal(DEFAULT_VOICE.device, 'cuda');
});

// ---------------------------------------------------------------- 成功路径

test('★ get_record 给本地 wav ⇒ 转出文字，并写进缓存', async () => {
  const dir = tempDir();
  const wav = touch(path.join(dir, 'a.amr.wav'));
  const { spawnImpl, calls } = fakeSpawn({ text: '测试测试123123' });
  const transcriber = liveTranscriber({ spawnImpl });
  let actionCalls = 0;
  const result = await transcriber.transcribe({
    segment: RECORD,
    action: async (name, params) => {
      actionCalls += 1;
      assert.equal(name, 'get_record');
      assert.equal(params.file, RECORD.file);
      assert.equal(params.out_format, 'wav', '必须让 NapCat 自己把 SILK 解成 wav');
      return { file: wav, url: wav, file_name: RECORD.file };
    },
  });
  assert.equal(actionCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.text, '测试测试123123');
  assert.equal(result.cached, false);
  // 参数走数组、不经过 shell；路径是脚本 + --audio/--out/--device/--language
  assert.equal(argOf(calls[0].args, '--audio'), wav);
  assert.equal(argOf(calls[0].args, '--device'), 'cuda');
  assert.equal(argOf(calls[0].args, '--language'), 'zh');
  // describe() 只给计数，不给文本
  const described = transcriber.describe();
  assert.equal(described.attempts, 1);
  assert.equal(described.ok, 1);
  assert.equal(JSON.stringify(described).includes('测试'), false, '快照里不该出现转写出来的文字');
});

test('★ 第二次同一个 file ⇒ 命中缓存，不再 spawn（QQ 会重发同一个文件）', async () => {
  const dir = tempDir();
  const wav = touch(path.join(dir, 'a.wav'));
  const { spawnImpl, calls } = fakeSpawn({ text: '缓存命中' });
  const transcriber = liveTranscriber({ spawnImpl });
  const action = async () => ({ file: wav });
  const first = await transcriber.transcribe({ segment: RECORD, action });
  const second = await transcriber.transcribe({ segment: RECORD, action });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1, '第二次不该再起 python');
  assert.equal(transcriber.describe().cached, 1);
});

test('缓存落盘：新实例读同一个 cache.json ⇒ 直接命中（进程重载不用重转）', async () => {
  const dir = tempDir();
  const wav = touch(path.join(dir, 'a.wav'));
  const cachePath = path.join(dir, 'cache.json');
  const first = fakeSpawn({ text: '落盘的缓存' });
  const one = liveTranscriber({ spawnImpl: first.spawnImpl, cachePath });
  await one.transcribe({ segment: RECORD, action: async () => ({ file: wav }) });
  assert.equal(first.calls.length, 1);

  const second = fakeSpawn({ text: '不该用到我' });
  const two = liveTranscriber({ spawnImpl: second.spawnImpl, cachePath });
  const result = await two.transcribe({ segment: RECORD, action: async () => ({ file: wav }) });
  assert.equal(result.ok, true);
  assert.equal(result.text, '落盘的缓存');
  assert.equal(second.calls.length, 0);
});

test('get_record 只给 base64 ⇒ 落成临时 wav、转完删掉（不留在盘上）', async () => {
  const dir = tempDir();
  const tmp = path.join(dir, 'tmp');
  const { spawnImpl } = fakeSpawn({ text: '来自 base64' });
  const transcriber = liveTranscriber({ spawnImpl, tempDir: tmp });
  const payload = Buffer.from('RIFFfake', 'utf8').toString('base64');
  const result = await transcriber.transcribe({
    segment: RECORD,
    action: async () => ({ base64: payload }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '来自 base64');
  const left = fs.existsSync(tmp) ? fs.readdirSync(tmp) : [];
  assert.deepEqual(left, [], '临时 wav / 结果 json 都该清掉');
});

// ---------------------------------------------------------------- 失败都要降级

test('get_record 抛 ⇒ ok:false（调用方照旧发占位符），不抛出去', async () => {
  const transcriber = liveTranscriber({ spawnImpl: fakeSpawn().spawnImpl });
  const result = await transcriber.transcribe({
    segment: RECORD,
    action: async () => { throw new Error('NapCat 未连接'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /get_record 失败/);
});

test('没有传输层 ⇒ ok:false（纯单测 / 没有 OneBot 的环境）', async () => {
  const transcriber = liveTranscriber({ spawnImpl: fakeSpawn().spawnImpl });
  const result = await transcriber.transcribe({ segment: RECORD, action: null });
  assert.equal(result.ok, false);
  assert.match(result.error, /传输层/);
});

test('whisper 退出码非 0 ⇒ ok:false，错误里带 stderr 尾巴', async () => {
  const dir = tempDir();
  const wav = touch(path.join(dir, 'a.wav'));
  const transcriber = liveTranscriber({ spawnImpl: fakeSpawn({ code: 3, writeJson: false }).spawnImpl });
  const result = await transcriber.transcribe({ segment: RECORD, action: async () => ({ file: wav }) });
  assert.equal(result.ok, false);
  assert.match(result.error, /转写失败（exit=3）/);
});

test('转写结果为空（纯静音）⇒ ok:false，别把空串当成"听见了"', async () => {
  const dir = tempDir();
  const wav = touch(path.join(dir, 'a.wav'));
  const transcriber = liveTranscriber({ spawnImpl: fakeSpawn({ text: '   ' }).spawnImpl });
  const result = await transcriber.transcribe({ segment: RECORD, action: async () => ({ file: wav }) });
  assert.equal(result.ok, false);
  assert.match(result.error, /为空/);
});

test('★ 超时 ⇒ 杀掉进程并返回失败（卡住的 python 会一直占显存）', async () => {
  const dir = tempDir();
  const wav = touch(path.join(dir, 'a.wav'));
  let spawned = null;
  const transcriber = createVoiceTranscriber({
    enabled: true,
    pythonPath: touch(path.join(dir, 'python.exe')),
    scriptPath: touch(path.join(dir, 'transcribe.py')),
    cachePath: path.join(dir, 'cache.json'),
    tempDir: path.join(dir, 'tmp'),
    timeoutMs: 60,
    spawnImpl: (exe, args) => {
      const fake = fakeSpawn({ neverClose: true }).spawnImpl(exe, args);
      spawned = fake;
      return fake;
    },
    log: () => {},
  });
  const result = await transcriber.transcribe({ segment: RECORD, action: async () => ({ file: wav }) });
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
  assert.equal(spawned.__killed(), true, '超时必须 kill 掉子进程');
});

test('describe()：失败计数与最后一条错误都留痕（排查要它）', async () => {
  const transcriber = liveTranscriber({ spawnImpl: fakeSpawn().spawnImpl });
  await transcriber.transcribe({ segment: RECORD, action: async () => { throw new Error('boom'); } });
  const described = transcriber.describe();
  assert.equal(described.failed, 1);
  assert.match(described.lastError, /boom/);
  assert.equal(described.enabled, true);
});

// ---------------------------------------------------------------- 配置读取（[voice]）

test('★ loadVoiceConfig：整段读出来（python / model / device / language / timeout/cache）', async () => {
  const { loadVoiceConfig } = await import('../src/index.mjs');
  const dir = tempDir();
  const tomlPath = path.join(dir, 'qq-gugu.toml');
  fs.writeFileSync(tomlPath, [
    '[voice]',
    'enabled = true',
    'python = "C:\\\\x\\\\python.exe"',
    'script = ""',
    'model = "C:\\\\models\\\\large-v3"',
    'device = "cpu"',
    'language = "zh"',
    'timeout_ms = 45000',
    'cache_path = "C:\\\\x\\\\cache.json"',
    'temp_dir = "C:\\\\x\\\\tmp"',
    '',
  ].join('\n'), 'utf8');
  const cfg = loadVoiceConfig({ tomlPath });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.python, 'C:\\x\\python.exe');
  assert.equal(cfg.script, '');
  assert.equal(cfg.model, 'C:\\models\\large-v3');
  assert.equal(cfg.device, 'cpu');
  assert.equal(cfg.language, 'zh');
  assert.equal(cfg.timeoutMs, 45000);
  assert.equal(cfg.cachePath, 'C:\\x\\cache.json');
  assert.equal(cfg.tempDir, 'C:\\x\\tmp');
});

test('loadVoiceConfig：没有 [voice] ⇒ 全默认（enabled=false，别偷偷开 GPU 活）', async () => {
  const { loadVoiceConfig } = await import('../src/index.mjs');
  const dir = tempDir();
  const tomlPath = path.join(dir, 'qq-gugu.toml');
  fs.writeFileSync(tomlPath, '[personality]\nname = "小鲸鱼"\n', 'utf8');
  const cfg = loadVoiceConfig({ tomlPath });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.device, 'cuda');
  assert.equal(cfg.language, 'zh');
  assert.equal(cfg.timeoutMs, DEFAULT_VOICE.timeoutMs);
});

test('loadVoiceConfig：写坏的值不猜 —— enabled 只认 true、device 只认 cuda/cpu、timeout 有下限', async () => {
  const { loadVoiceConfig } = await import('../src/index.mjs');
  const dir = tempDir();
  const tomlPath = path.join(dir, 'qq-gugu.toml');
  fs.writeFileSync(tomlPath, [
    '[voice]',
    'enabled = "false"',
    'device = "gpu"',
    'timeout_ms = 10',
    'language = 7',
    '',
  ].join('\n'), 'utf8');
  const cfg = loadVoiceConfig({ tomlPath });
  assert.equal(cfg.enabled, false, '字符串 "false" 不算开启');
  assert.equal(cfg.device, 'cuda', '不认识的 device 回 cuda');
  assert.equal(cfg.timeoutMs, DEFAULT_VOICE.timeoutMs, '10ms 太短 ⇒ 回默认');
  assert.equal(cfg.language, 'zh', '非字符串语言 ⇒ 回默认');
});

test('loadVoiceConfig：toml 不存在 ⇒ 默认值，绝不抛', async () => {
  const { loadVoiceConfig } = await import('../src/index.mjs');
  const cfg = loadVoiceConfig({ tomlPath: path.join(HERE, '.tmp-voice-does-not-exist.toml') });
  assert.equal(cfg.enabled, false);
});

test('★ 默认临时目录**绝不落在 `<DSH_HOME>` 那边**（子进程对那儿只读，2026-10-25 实线事故）', async () => {
  const dir = tempDir();
  // 模拟"缓存放在 dsh-home、临时目录没配"的真实配置（当日线上就是这样）
  const transcriber = createVoiceTranscriber({
    enabled: true,
    pythonPath: touch(path.join(dir, 'python.exe')),
    scriptPath: touch(path.join(dir, 'transcribe.py')),
    cachePath: '<DSH_HOME>\\media\\qq-voice-cache.json',
    log: () => {},
    spawnImpl: fakeSpawn().spawnImpl,
  });
  const described = transcriber.describe();
  assert.equal(described.tempDir.startsWith('<DSH_HOME>'), false, `临时目录不能是只读的那棵树：${described.tempDir}`);
  assert.equal(described.tempDir.includes('dsh-home'), false);
});

test('配了 temp_dir ⇒ 结果 JSON 就写在那个目录里（不跟 cachePath 走）', async () => {
  const dir = tempDir();
  const tmp = path.join(dir, 'work');
  const wav = touch(path.join(dir, 'a.wav'));
  const { spawnImpl, calls } = fakeSpawn({ text: '写在配置目录里' });
  const transcriber = liveTranscriber({ spawnImpl, tempDir: tmp });
  const result = await transcriber.transcribe({ segment: RECORD, action: async () => ({ file: wav }) });
  assert.equal(result.ok, true);
  const out = argOf(calls[0].args, '--out');
  assert.equal(path.dirname(out), tmp);
});

// ---------------------------------------------------------------- 引擎优先级（QQ 自己的转写）

test('★ auto：**先问 QQ 自己**（fetch_ptt_text）—— 成功就不 spawn、不花 GPU', async () => {
  const dir = tempDir();
  const { spawnImpl, calls } = fakeSpawn({ text: '本地 whisper 的结果' });
  const transcriber = liveTranscriber({ spawnImpl });
  const actions = [];
  const result = await transcriber.transcribe({
    segment: RECORD,
    messageId: 30000025,
    action: async (name, params) => {
      actions.push({ name, params });
      if (name === 'fetch_ptt_text') return { text: 'QQ 自己转出来的话' };
      throw new Error(`不该走到 ${name}`);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'QQ 自己转出来的话');
  assert.equal(result.source, 'ntqq');
  assert.deepEqual(actions.map((a) => a.name), ['fetch_ptt_text']);
  assert.equal(actions[0].params.message_id, 30000025, '必须传消息 id（不是文件名）');
  assert.equal(calls.length, 0, 'ntqq 成功时不该起 python');
  assert.equal(transcriber.describe().lastSource, 'ntqq');
});

test('★ auto：fetch_ptt_text 失败 ⇒ 落到本地 whisper，并把"ntqq 为什么不行"记下来', async () => {
  const dir = tempDir();
  const wav = touch(path.join(dir, 'a.wav'));
  const { spawnImpl, calls } = fakeSpawn({ text: '本地转的' });
  // 这个用例钉的是"落 whisper"这条分支，不是重试节奏 ⇒ 把重试关掉（否则白等 1 s）。
  const transcriber = liveTranscriber({ spawnImpl, ntqqRetryDelaysMs: [] });
  let ntqqCalls = 0;
  const result = await transcriber.transcribe({
    segment: RECORD,
    messageId: 30000025,
    action: async (name) => {
      if (name === 'fetch_ptt_text') {
        ntqqCalls += 1;
        throw new Error('获取语音转文字结果失败');
      }
      if (name === 'get_record') return { file: wav };
      throw new Error(`未知 action ${name}`);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '本地转的');
  assert.equal(result.source, 'whisper');
  assert.equal(calls.length, 1);
  assert.equal(ntqqCalls, 1, '重试关掉时只查一次');
  const described = transcriber.describe();
  assert.equal(described.ntqqFailed, 1);
  assert.equal(described.lastSource, 'whisper');
});

test('★ auto：**第 1 次空、第 2 次有字** ⇒ 用 QQ 的，不落 whisper（2026-10-26 的写回时序）', async () => {
  const dir = tempDir();
  const { spawnImpl, calls } = fakeSpawn({ text: '不该用到 whisper' });
  // 真实的写回延迟是秒级；测试里把节奏压到 5 ms，只钉"会重试、重试会成功"。
  const transcriber = liveTranscriber({ spawnImpl, ntqqRetryDelaysMs: [5, 5] });
  let ntqqCalls = 0;
  const result = await transcriber.transcribe({
    segment: RECORD,
    messageId: 30000025,
    action: async (name) => {
      if (name !== 'fetch_ptt_text') throw new Error(`不该走到 ${name}`);
      ntqqCalls += 1;
      // 第 1 次：QQ 内核还没写回（NapCat 抛"获取语音转文字结果失败"）
      if (ntqqCalls === 1) throw new Error('获取语音转文字结果失败');
      return { text: '第二次才拿到的话' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '第二次才拿到的话');
  assert.equal(result.source, 'ntqq');
  assert.equal(ntqqCalls, 2);
  assert.equal(calls.length, 0, '拿到 QQ 的文本就不该起 python');
  const described = transcriber.describe();
  assert.equal(described.ntqqCalls, 2);
  assert.equal(described.ntqqRetries, 1);
  assert.equal(described.ntqqFailed, 0, '最终成功了，不该记"落 whisper"');
});

test('★ auto：**三次都空** ⇒ 用完预算才落 whisper，且次数记在 ntqqCalls', async () => {
  const dir = tempDir();
  const wav = touch(path.join(dir, 'a.wav'));
  const { spawnImpl } = fakeSpawn({ text: '本地兜底' });
  const transcriber = liveTranscriber({ spawnImpl, ntqqRetryDelaysMs: [5, 5] });
  let ntqqCalls = 0;
  const result = await transcriber.transcribe({
    segment: RECORD,
    messageId: 30000025,
    action: async (name) => {
      if (name === 'fetch_ptt_text') {
        ntqqCalls += 1;
        throw new Error('获取语音转文字结果失败');
      }
      if (name === 'get_record') return { file: wav };
      throw new Error(`未知 action ${name}`);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'whisper');
  assert.equal(ntqqCalls, 3, '查一次 + 两次重试');
  const described = transcriber.describe();
  assert.equal(described.ntqqCalls, 3);
  assert.equal(described.ntqqRetries, 2);
  assert.equal(described.ntqqFailed, 1);
});

test('auto：ntqq 返回空文本（不是抛错）也算"没拿到"，会重试', async () => {
  const dir = tempDir();
  const { spawnImpl } = fakeSpawn({ text: '不该用到 whisper' });
  const transcriber = liveTranscriber({ spawnImpl, ntqqRetryDelaysMs: [5] });
  let ntqqCalls = 0;
  const result = await transcriber.transcribe({
    segment: RECORD,
    messageId: 30000025,
    action: async (name) => {
      if (name !== 'fetch_ptt_text') throw new Error(`不该走到 ${name}`);
      ntqqCalls += 1;
      return ntqqCalls === 1 ? { text: '   ' } : { text: '空文本之后拿到了' };
    },
  });
  assert.equal(result.source, 'ntqq');
  assert.equal(result.text, '空文本之后拿到了');
  assert.equal(ntqqCalls, 2);
});

test('auto：没有 message_id（老消息 / 别的实现）⇒ 跳过 ntqq，直接 whisper', async () => {
  const dir = tempDir();
  const wav = touch(path.join(dir, 'a.wav'));
  const { spawnImpl } = fakeSpawn({ text: '没有 id 也能转' });
  const transcriber = liveTranscriber({ spawnImpl });
  const names = [];
  const result = await transcriber.transcribe({
    segment: RECORD,
    action: async (name) => {
      names.push(name);
      if (name === 'get_record') return { file: wav };
      throw new Error(`不该调用 ${name}`);
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(names, ['get_record']);
  assert.equal(result.source, 'whisper');
});

test('engine=ntqq：只认 QQ 的 —— 失败就是失败，不偷偷花 GPU', async () => {
  const dir = tempDir();
  const { spawnImpl, calls } = fakeSpawn({ text: '不该用到我' });
  // 重试关掉：这条用例钉的是"不落 whisper"，不是节奏。
  const transcriber = liveTranscriber({ spawnImpl, engine: 'ntqq', ntqqRetryDelaysMs: [] });
  const result = await transcriber.transcribe({
    segment: RECORD,
    messageId: 123,
    action: async () => { throw new Error('获取语音转文字结果失败'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /fetch_ptt_text/);
  assert.equal(calls.length, 0);
});

test('engine=whisper：连 fetch_ptt_text 都不问（省一次往返）', async () => {
  const dir = tempDir();
  const wav = touch(path.join(dir, 'a.wav'));
  const { spawnImpl } = fakeSpawn({ text: '只用本地' });
  const transcriber = liveTranscriber({ spawnImpl, engine: 'whisper' });
  const names = [];
  const result = await transcriber.transcribe({
    segment: RECORD,
    messageId: 123,
    action: async (name) => {
      names.push(name);
      if (name === 'get_record') return { file: wav };
      throw new Error(`不该调用 ${name}`);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'whisper');
  assert.deepEqual(names, ['get_record']);
  assert.equal(transcriber.describe().engine, 'whisper');
});

// ---------------------------------------------------------------- 网关接线

function voiceHarness(options = {}) {
  const transport = {
    selfId: '999',
    sent: [],
    on: () => {},
    off: () => {},
    emit: () => {},
    async sendToChat(chatId, message) {
      this.sent.push({ chatId, message });
      return this.sent.length;
    },
    async action() {
      throw new Error('这组测试里 action 不该被调用（转写器是假的）');
    },
  };
  const logs = [];
  const prompts = [];
  const engine = new ProactiveEngine({
    config: { enabled: false, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0, afterUserMsgCount: 1 },
    gauge: async () => ({ speak: false, text: '' }),
    speak: async () => undefined,
    log: () => {},
    now: () => Date.UTC(2026, 4, 1, 12, 0, 0),
  });
  const gateway = new Gateway({
    transport,
    router: new Router({ dmPolicy: POLICY.OPEN, groupPolicy: POLICY.OPEN, requireMention: true, adminUsers: ['9001'] }),
    engine,
    outboundAllow: createOutboundAllow({ allowFrom: ['2001'], groupAllowFrom: [] }),
    responder: async (request) => {
      prompts.push(request.prompt);
      return '';
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    maxReplyChars: 2000,
    voiceTranscriber: options.voiceTranscriber ?? null,
  });
  gateway.attach();
  return { gateway, transport, logs, prompts };
}

function dmVoiceEvent(file = RECORD.file) {
  return {
    time: Math.floor(Date.UTC(2026, 4, 1, 12, 0, 0) / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 7,
    user_id: 2001,
    message: [{ type: 'record', data: { file, url: 'https://example.invalid/a.amr', file_size: '7035' } }],
    raw_message: '',
    sender: { nickname: '阿猫' },
  };
}

test('★ 网关：把**消息 id** 也交给转写器（`fetch_ptt_text` 那条路要它）', async () => {
  const seen = [];
  const fake = {
    enabled: true,
    describe: () => ({}),
    transcribe: async (input) => {
      seen.push({ id: input.messageId, file: input.segment?.file });
      return { ok: true, text: '收到', ms: 1 };
    },
  };
  const h = voiceHarness({ voiceTranscriber: fake });
  await h.gateway.handleEvent(dmVoiceEvent());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 7, 'dmVoiceEvent 的 message_id 是 7');
  assert.equal(seen[0].file, RECORD.file);
});

test('网关：转写成功 ⇒ 提示词里是 [语音：文字]，**没有**"听不到"那句', async () => {
  const seen = [];
  const fake = {
    enabled: true,
    describe: () => ({}),
    transcribe: async ({ segment }) => {
      seen.push(segment.file);
      return { ok: true, text: '测试测试123123', ms: 12 };
    },
  };
  const h = voiceHarness({ voiceTranscriber: fake });
  await h.gateway.handleEvent(dmVoiceEvent());
  assert.deepEqual(seen, [RECORD.file]);
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /\[语音：测试测试123123\]/);
  assert.doesNotMatch(h.prompts[0], /没有转写文字/);
  assert.doesNotMatch(h.prompts[0], /\[语音（未转写）\]/);
});

test('★ 网关：转写失败 ⇒ 保留 [语音（未转写）] + "你听不到"那句（别让她假装听见）', async () => {
  const fake = {
    enabled: true,
    describe: () => ({}),
    transcribe: async () => ({ ok: false, error: '转写超时（60000ms）', ms: 60000 }),
  };
  const h = voiceHarness({ voiceTranscriber: fake });
  await h.gateway.handleEvent(dmVoiceEvent());
  assert.match(h.prompts[0], /\[语音（未转写）\]/);
  assert.match(h.prompts[0], /没有转写文字/);
  assert.match(h.prompts[0], /听不到/);
});

test('网关：转写器没接（null）⇒ 和改动前完全一样（占位符 + 听不到）', async () => {
  const h = voiceHarness({ voiceTranscriber: null });
  await h.gateway.handleEvent(dmVoiceEvent());
  assert.match(h.prompts[0], /\[语音（未转写）\]/);
  assert.match(h.prompts[0], /没有转写文字/);
});

test('网关：转写器自己抛 ⇒ 降级成占位符，这一轮照常走（不把消息弄没）', async () => {
  const fake = {
    enabled: true,
    describe: () => ({}),
    transcribe: async () => { throw new Error('意外炸了'); },
  };
  const h = voiceHarness({ voiceTranscriber: fake });
  await h.gateway.handleEvent(dmVoiceEvent());
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /\[语音（未转写）\]/);
  assert.equal(h.logs.some((entry) => entry.level === 'warn' && /语音转写抛了/.test(entry.message)), true);
});

test('网关：转写出来的文字里带 $& 也不会把占位符替换搞坏（replace 用函数形式）', async () => {
  const fake = {
    enabled: true,
    describe: () => ({}),
    transcribe: async () => ({ ok: true, text: '价格是 $& 元', ms: 1 }),
  };
  const h = voiceHarness({ voiceTranscriber: fake });
  await h.gateway.handleEvent(dmVoiceEvent());
  assert.match(h.prompts[0], /\[语音：价格是 \$& 元\]/);
});
