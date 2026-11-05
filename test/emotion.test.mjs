/**
 * 语音情绪旁路（2026-10-26，`wav2small`）：`emotion.mjs` + 网关挂载。
 *
 * ## 这组测试钉什么
 *
 * 用户 2026-10-26 拍板的四条口径，每条都要有用例：
 * 1. **只留 arousal** —— 返回值里**不许有** valence / dominance（源头就不该给，别"记着不用"）。
 * 2. **必须 clip 到 [0,1]** —— RAVEDSS 640 条里有 14 条 arousal >1（最大 1.1756）。
 * 3. **时长 / RMS 门限** —— 纯静音会输出胡话（实测 valence −0.78）；太短/太静直接跳过、**不给分**。
 * 4. **只记录、不进提示词** —— `#buildPrompt` 里不该出现情绪字样（v1）。
 *
 * 另外两条工程约束：
 * - **旁路不能影响转写**：推理失败/取音频失败只留计数与日志，转写照常、`message.text` 照常替换。
 * - **开关关了就不跑**：`enabled:false` 时连 python 都不 spawn、`get_record` 都不调。
 *
 * ⚠️ 全程不 spawn 真 python：`spawnImpl` 假进程按 `--out` 把结果 JSON 写出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEmotionSenser, DEFAULT_EMOTION } from '../src/dsh/emotion.mjs';
import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { createOutboundAllow } from '../src/dsh/outbound-allow.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '.tmp-emotion-';

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

function argOf(args, name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? '' : String(args[i + 1] ?? '');
}

/** 假 python：按 `--out` 写结果 JSON（`--wav` 的文件也必须存在，否则模拟"读不到"）。 */
function fakeSpawn(payload) {
  const calls = [];
  const spawnImpl = (exe, args) => {
    calls.push({ exe, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      const out = argOf(args, 'out');
      try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(payload), 'utf8');
      } catch {
        /* 写不进去 ⇒ 被测代码报"结果文件读不出来" */
      }
      child.emit('close', payload?.ok === false ? 1 : 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}

/** 一个"配齐了"的旁路器。 */
function senser({ payload = { ok: true, skipped: '', arousal: 0.42, secs: 3.5, rms: 0.05, ms: 61 }, overrides = {} } = {}) {
  const dir = tempDir();
  const { spawnImpl, calls } = fakeSpawn(payload);
  // 仓库**不带权重**（CC-BY-NC-SA 与 MIT 不兼容），所以这里造一个假权重文件，
  // 让"配齐了"这条路径成立 —— 测试不该依赖仓库里有个二进制。
  const modelDir = path.join(dir, 'models');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'model.safetensors'), 'fake', 'utf8');
  const made = createEmotionSenser({
    enabled: true,
    pythonPath: touch(path.join(dir, 'python.exe')),
    scriptPath: touch(path.join(dir, 'emotion-adv.py')),
    modelDir,
    tempDir: path.join(dir, 'tmp'),
    log: () => {},
    spawnImpl,
    ...overrides,
  });
  return { senser: made, calls, dir };
}

/** 一个存在的 wav（假 python 不读内容，但 `cacheKeyOf` 要 stat 它）。 */
function audioFile(dir = tempDir()) {
  return touch(path.join(dir, 'a.wav'), 'RIFF....WAVEfake');
}

// ---------------------------------------------------------------- 合成器

test('开关关着（enabled=false）⇒ skipped=disabled、ok:false、不起进程', async () => {
  const dir = tempDir();
  const s = createEmotionSenser({ enabled: false, log: () => {} });
  const r = await s.sense({ audioPath: audioFile(dir), text: '你好' });
  assert.equal(r.ok, false, '没开就是"没听到"，不算跑过');
  assert.equal(r.skipped, 'disabled');
  assert.equal(r.arousal, null);
  assert.match(s.describe().notReadyReason, /enabled/);
});

test('★ 正常算出来：只返回 arousal，**没有** valence/dominance', async () => {
  const { senser: s, calls } = senser({ payload: { ok: true, skipped: '', arousal: 0.8213, secs: 4.2, rms: 0.07, ms: 55 } });
  const r = await s.sense({ audioPath: audioFile(), text: '你怎么又没回我消息' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, '');
  assert.equal(r.arousal, 0.8213);
  assert.equal(r.textLen, 9);
  assert.equal(r.textSha.length, 8);
  // 🔴 口径：valence / dominance **一个字都不许出现在返回值里**
  assert.equal('valence' in r, false);
  assert.equal('dominance' in r, false);
  assert.equal(calls.length, 1, '应该起了一次 python');
  assert.equal(s.describe().scored, 1);
});

test('★ 超界被 clip 到 [0,1]（模型输出没有 clamp）', async () => {
  const over = senser({ payload: { ok: true, skipped: '', arousal: 1.1756, secs: 5, rms: 0.05, ms: 40 } });
  const r1 = await over.senser.sense({ audioPath: audioFile(), text: 'x' });
  assert.equal(r1.arousal, 1);

  const under = senser({ payload: { ok: true, skipped: '', arousal: -0.3, secs: 5, rms: 0.05, ms: 40 } });
  const r2 = await under.senser.sense({ audioPath: audioFile(), text: 'x' });
  assert.equal(r2.arousal, 0);
});

test('★ 太短 ⇒ skipped=too_short，arousal 是 null（不给分）', async () => {
  const { senser: s } = senser({ payload: { ok: true, skipped: 'too_short', secs: 0.6, rms: 0.05 } });
  const r = await s.sense({ audioPath: audioFile(), text: '嗯' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 'too_short');
  assert.equal(r.arousal, null);
  assert.equal(s.describe().tooShort, 1);
  assert.equal(s.describe().scored, 0);
});

test('★ 静音 ⇒ skipped=too_quiet，不给分', async () => {
  const { senser: s } = senser({ payload: { ok: true, skipped: 'too_quiet', secs: 5, rms: 0 } });
  const r = await s.sense({ audioPath: audioFile(), text: '（静音）' });
  assert.equal(r.skipped, 'too_quiet');
  assert.equal(r.arousal, null);
  assert.equal(s.describe().tooQuiet, 1);
});

test('★ 越过门槛 ⇒ overThreshold=true（只是记下来，v1 不进提示词）', async () => {
  const { senser: s } = senser({ payload: { ok: true, skipped: '', arousal: 0.83, secs: 3, rms: 0.06, ms: 50 } });
  const r = await s.sense({ audioPath: audioFile(), text: '气死我了' });
  assert.equal(r.overThreshold, true);
  assert.equal(s.describe().overThreshold, 1);

  const low = senser({ payload: { ok: true, skipped: '', arousal: 0.41, secs: 3, rms: 0.06, ms: 50 } });
  const lowR = await low.senser.sense({ audioPath: audioFile(), text: '嗯嗯' });
  assert.equal(lowR.overThreshold, false);
  assert.equal(low.senser.describe().overThreshold, 0);
});

test('python 说失败 ⇒ ok:false + error（永不抛）', async () => {
  const { senser: s } = senser({ payload: { ok: false, error: '推理失败：RuntimeError: boom' } });
  const r = await s.sense({ audioPath: audioFile(), text: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'error');
  assert.match(r.error, /boom/);
  assert.equal(s.describe().failed, 1);
});

test('结果文件读不出来 ⇒ ok:false（不假装有分）', async () => {
  const dir = tempDir();
  const modelDir = path.join(dir, 'models');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'model.safetensors'), 'fake', 'utf8');
  const s = createEmotionSenser({
    enabled: true,
    pythonPath: touch(path.join(dir, 'python.exe')),
    scriptPath: touch(path.join(dir, 'emotion-adv.py')),
    modelDir,
    tempDir: path.join(dir, 'tmp'),
    log: () => {},
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit('close', 2));
      return child;
    },
  });
  const r = await s.sense({ audioPath: audioFile(dir), text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /结果文件|退出码/);
});

test('同一个音频第二次走缓存（不再 spawn）', async () => {
  const dir = tempDir();
  const wav = audioFile(dir);
  const { senser: s, calls } = senser();
  await s.sense({ audioPath: wav, text: 'x' });
  const r2 = await s.sense({ audioPath: wav, text: 'x' });
  assert.equal(r2.cached, true);
  assert.equal(calls.length, 1, '第二次应该命中缓存');
});

test('python 路径不存在 ⇒ enabled=false 并说清楚原因（别让她调了才发现）', async () => {
  const dir = tempDir();
  const s = createEmotionSenser({
    enabled: true,
    pythonPath: path.join(dir, '.tmp-emotion-no-such-python.exe'),
    scriptPath: touch(path.join(dir, 'emotion-adv.py')),
    log: () => {},
  });
  assert.equal(s.enabled, false);
  assert.match(s.describe().notReadyReason, /python/);
});

test('门限与阈值可以从外面配（默认值见 DEFAULT_EMOTION）', async () => {
  const { senser: s } = senser({ overrides: { minSeconds: 2, minRms: 0.02, arousalHigh: 0.9 } });
  const d = s.describe();
  assert.equal(d.minSeconds, 2);
  assert.equal(d.minRms, 0.02);
  assert.equal(d.threshold, 0.9);
  assert.equal(DEFAULT_EMOTION.arousalHigh, 0.75);
  assert.equal(DEFAULT_EMOTION.minSeconds, 1);
  assert.equal(DEFAULT_EMOTION.minRms, 0.001);
});

// ---------------------------------------------------------------- 网关挂载（旁路）

function makeTransport() {
  const emitter = new EventEmitter();
  const sent = [];
  return {
    selfId: '999',
    sent,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async sendToChat(chatId, message) {
      sent.push({ chatId, message });
      return sent.length;
    },
  };
}

/** 一条**原始 OneBot 事件**（`handleEvent` 吃的是这个，不是归一化后的消息）。 */
function voiceEvent(file = 'abc.amr') {
  return {
    time: Math.floor(Date.UTC(2026, 4, 1, 12, 0, 0) / 1000),
    self_id: 999,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 777,
    user_id: 2001,
    message: [{ type: 'record', data: { file, url: 'https://example.invalid/a.amr', file_size: '7035' } }],
    raw_message: '',
    sender: { nickname: '阿猫' },
  };
}

/** 装一套网关：真 Router/Engine + 假 transport/转录器 + 假情绪旁路。 */
function harness({ emotionSenser = null, transcribeText = '你怎么又没回我消息', audioPath = '<tmp>\\abc.wav', recordFails = false } = {}) {
  const transport = makeTransport();
  const logs = [];
  const router = new Router({ dmPolicy: POLICY.OPEN, groupPolicy: POLICY.OPEN, requireMention: true, adminUsers: ['9001'] });
  const engine = new ProactiveEngine({
    config: { enabled: false, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0, afterUserMsgCount: 0 },
    gauge: async () => ({ speak: false }),
    speak: async () => undefined,
    log: () => {},
  });
  const actions = [];
  const prompts = [];
  transport.action = async (name, params) => {
    actions.push({ name, params });
    if (name === 'get_record') {
      if (recordFails) throw new Error('get_record 失败（模拟）');
      return { file: audioPath };
    }
    throw new Error(`未知 action ${name}`);
  };
  const transcriber = {
    enabled: true,
    describe: () => ({}),
    transcribe: async () => ({ ok: true, text: transcribeText, ms: 10, source: 'whisper' }),
  };
  const gateway = new Gateway({
    transport,
    router,
    engine,
    outboundAllow: createOutboundAllow({ allowFrom: ['2001'], groupAllowFrom: [] }),
    responder: async (request) => {
      prompts.push(String(request?.prompt ?? ''));
      return '';
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    maxReplyChars: 2000,
    voiceTranscriber: transcriber,
    emotionSenser,
  });
  gateway.attach();
  return { gateway, transport, logs, actions, prompts };
}

/** 等着 fire-and-forget 的旁路跑完（它不 await，所以轮询到条件成立）。 */
async function settle(check, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test('★ 网关：转写之后旁路算一次，结果落在 lastEmotion / recentEmotions', async () => {
  const { senser: s, calls } = senser({ payload: { ok: true, skipped: '', arousal: 0.62, secs: 3, rms: 0.05, ms: 30 } });
  const h = harness({ emotionSenser: s });
  await h.gateway.handleEvent(voiceEvent());

  assert.equal(await settle(() => h.gateway.lastEmotion !== null), true, '旁路应该算完');
  const last = h.gateway.lastEmotion;
  assert.equal(last.arousal, 0.62);
  assert.equal(last.textSha.length, 8, '要能对回正文（哈希）');
  assert.equal(last.textLen, Array.from('你怎么又没回我消息').length);
  assert.equal(h.gateway.recentEmotions.length, 1);
  // 取音频走的是 `get_record`（转写走 ntqq 时 voice.mjs 根本不取音频）
  assert.ok(h.actions.some((a) => a.name === 'get_record'));
  assert.equal(calls.length, 1);
});

test('★ 旁路不阻塞转写：`handleEvent` 返回时提示词里已经有 [语音：…]', async () => {
  const { senser: s } = senser({ payload: { ok: true, skipped: '', arousal: 0.5, secs: 3, rms: 0.05, ms: 30 } });
  const h = harness({ emotionSenser: s });
  const t0 = Date.now();
  await h.gateway.handleEvent(voiceEvent());
  const elapsed = Date.now() - t0;
  assert.ok(h.prompts.some((p) => p.includes('[语音：你怎么又没回我消息]')), '转写结果要进提示词');
  assert.ok(elapsed < 1000, `不该等旁路（实际 ${elapsed}ms）`);
});

test('★ 推理失败**不影响转写**：文字照常进提示词、只有计数变了', async () => {
  const { senser: s } = senser({ payload: { ok: false, error: '推理失败：boom' } });
  const h = harness({ emotionSenser: s });
  await h.gateway.handleEvent(voiceEvent());
  assert.ok(h.prompts.some((p) => p.includes('[语音：你怎么又没回我消息]')));
  assert.equal(await settle(() => s.describe().failed === 1), true);
  assert.equal(h.gateway.lastEmotion, null, '失败不该写 lastEmotion');
});

test('★ 取音频失败也不影响转写（旁路只是放弃）', async () => {
  const { senser: s, calls } = senser();
  const h = harness({ emotionSenser: s, recordFails: true });
  await h.gateway.handleEvent(voiceEvent());
  assert.ok(h.prompts.some((p) => p.includes('[语音：你怎么又没回我消息]')));
  assert.equal(calls.length, 0, '取不到音频就不该起 python');
  assert.equal(h.gateway.lastEmotion, null);
});

test('★ 开关关着（senser=null）⇒ 连 get_record 都不调', async () => {
  const h = harness({ emotionSenser: null });
  await h.gateway.handleEvent(voiceEvent());
  assert.equal(h.actions.filter((a) => a.name === 'get_record').length, 0);
  assert.equal(h.gateway.lastEmotion, null);
});

test('★ v1 只记录：提示词里**没有**情绪字样（别偷偷进 prompt）', async () => {
  const { senser: s } = senser({ payload: { ok: true, skipped: '', arousal: 0.95, secs: 3, rms: 0.05, ms: 30 } });
  const h = harness({ emotionSenser: s });
  await h.gateway.handleEvent(voiceEvent());
  await settle(() => h.gateway.lastEmotion !== null);

  // 提示词是**这一轮真正发给模型的东西**：它里面只能有转写文字，不能有情绪话术。
  const prompt = h.prompts.join('\n');
  assert.ok(prompt.length > 0, '这一轮应该走了一次 responder');
  assert.ok(!/听着挺急|听感参考|arousal|激动程度/.test(prompt), 'v1 不许把情绪写进提示词');
  // 但分数**确实**记下来了（只是没给模型看）
  assert.equal(h.gateway.lastEmotion.arousal, 0.95);
  assert.equal(h.gateway.lastEmotion.overThreshold, true);
});
