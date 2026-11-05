/**
 * **视觉调用的后端选择**（`image-desc.mjs` 里 `callVision` 那一段）测试。
 *
 * ## 为什么要单独一组
 *
 * 显存门控的**决策**在 `vram-gate.mjs`（`test/vram-gate.test.mjs` 钉住了），
 * 但"决策真的作用到了这次视觉调用上"是**另一件事** —— 中间还隔着一层接线：
 *
 * ```
 * 门控说"用本地" → callVision 真的把 provider/model 换成本地
 * 门控说"用云"   → 真的换成 v4f
 * 本地调用失败   → 真的改走云（用户要求：别让"本地优先"变成"没有视觉"）
 * 手动配了 provider → 门控**不许**插手（配置是人写的，自动化不该改它）
 * ```
 *
 * 这四条的坏法都是**静默**的：门控选了本地而调用还是发给云，你只会看到"走了云"，
 * 看不出"门控根本没接上"。所以这里用假 `stream` **把实际发出去的 provider/model 记下来**，
 * 逐条断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createImageDescriber } from '../src/dsh/image-desc.mjs';

/** 一段合法的 PNG 头（够 `sniffImageMediaType` 认出来）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const IMAGE_INPUT = { data: PNG_BYTES, mediaType: 'image/png', name: 'a.png' };

/** 假装是 `ctx.llm.stream`：记下每次调用的 provider/model，可以按 provider 让它失败。 */
function fakeStream(reply = '一只橘猫趴在键盘上', { failProviders = [] } = {}) {
  const calls = [];
  const fn = (opts) => {
    calls.push({ provider: opts.provider, model: opts.model });
    const shouldFail = failProviders.includes(opts.provider);
    return (async function* gen() {
      if (shouldFail) throw new Error(`stream failed for ${opts.provider}`);
      yield { type: 'text-delta', text: reply };
    })();
  };
  fn.calls = calls;
  fn.providers = () => calls.map((c) => c.provider);
  return fn;
}

/** 假装是 `ctx.attachments`。 */
function fakeAttachments() {
  return {
    async saveImage(input) {
      return { id: 'att-1', mediaType: input.mediaType, name: input.name };
    },
  };
}

/**
 * 造一个**门控替身**。
 *
 * ⚠️ 这里刻意用替身而不是真的 `createVisionGate`：那一条路（阈值/缓存/故障默认）
 * 已经在 `vram-gate.test.mjs` 里钉过了。这一组要测的是**接线**，
 * 用替身才能精确控制"门控说走哪条路"，而不用去凑显存数。
 */
function fakeGate(decision) {
  const fn = async () => decision;
  fn.config = () => ({ freeMiB: 7168, cacheMs: 5000, local: decision.local, cloud: decision.cloud });
  return fn;
}

const LOCAL_DECISION = {
  use: 'local',
  reason: 'vram-enough',
  freeMiB: 9000,
  thresholdMiB: 7168,
  cached: false,
  ageMs: 0,
  provider: 'local-llamacpp',
  model: 'qwen3.5-4b-q4km-vision',
  cloud: { provider: 'discovery-intern-ai', model: 'deepseek-v4-flash-vision' },
  local: { provider: 'local-llamacpp', model: 'qwen3.5-4b-q4km-vision' },
};

const CLOUD_DECISION = {
  ...LOCAL_DECISION,
  use: 'cloud',
  reason: 'vram-low',
  freeMiB: 3000,
  provider: 'discovery-intern-ai',
  model: 'deepseek-v4-flash-vision',
};

/** 造一个带门控的描述器。 */
function makeDescriber({ gate, stream, stickerGate = null }) {
  return createImageDescriber({
    attachments: fakeAttachments(),
    stream,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    log: () => {},
    tablePath: '',
    visionGate: gate,
    visionGateConfig: gate === null ? null : gate.config(),
    stickerGate,
  });
}

// ─────────────────────────────────────────────── ★ 门控真的接上了

test('★★ 门控说"用本地" ⇒ 这次视觉调用真的发给本地 provider', async () => {
  const stream = fakeStream();
  const desc = makeDescriber({ gate: fakeGate(LOCAL_DECISION), stream });
  const text = await desc.describe(IMAGE_INPUT);
  assert.equal(text, '一只橘猫趴在键盘上');
  assert.deepEqual(stream.providerCalls ?? stream.calls, [
    { provider: 'local-llamacpp', model: 'qwen3.5-4b-q4km-vision' },
  ]);
  const st = desc.stats().visionGate;
  assert.equal(st.enabled, true);
  assert.equal(st.local, 1);
  assert.equal(st.cloudLowVram, 0);
  assert.equal(desc.stats().visionGate.last.reason, 'vram-enough');
  assert.equal(desc.stats().visionGate.last.freeMiB, 9000);
});

test('★★ 门控说"用云" ⇒ 这次视觉调用真的发给 v4f，而且计数记在 cloudLowVram 上', async () => {
  const stream = fakeStream();
  const desc = makeDescriber({ gate: fakeGate(CLOUD_DECISION), stream });
  await desc.describe(IMAGE_INPUT);
  assert.deepEqual(stream.calls, [
    { provider: 'discovery-intern-ai', model: 'deepseek-v4-flash-vision' },
  ]);
  const st = desc.stats().visionGate;
  assert.equal(st.cloudLowVram, 1);
  assert.equal(st.local, 0);
  assert.equal(desc.stats().visionGate.last.reason, 'vram-low');
});

test('★ 门控没传 ⇒ 走实例级 provider/model（老行为，一个字节没变）', async () => {
  const stream = fakeStream();
  const desc = makeDescriber({ gate: null, stream });
  await desc.describe(IMAGE_INPUT);
  assert.deepEqual(stream.calls, [{ provider: 'deepseek-official', model: 'deepseek-flash' }]);
  const st = desc.stats().visionGate;
  assert.equal(st.enabled, false);
  assert.equal(st.off, 1);
});

// ─────────────────────────────────────────────── ★ 本地失败 ⇒ 退回云

test('★★ 本地调用失败 ⇒ **同一次**调用改走云（用户要求：别变成"没有视觉"）', async () => {
  const stream = fakeStream('云看出来了：一只猫', { failProviders: ['local-llamacpp'] });
  const desc = makeDescriber({ gate: fakeGate(LOCAL_DECISION), stream });
  const text = await desc.describe(IMAGE_INPUT);
  assert.equal(text, '云看出来了：一只猫');
  assert.deepEqual(stream.calls, [
    { provider: 'local-llamacpp', model: 'qwen3.5-4b-q4km-vision' },
    { provider: 'discovery-intern-ai', model: 'deepseek-v4-flash-vision' },
  ]);
  const st = desc.stats().visionGate;
  assert.equal(st.localFailed, 1);
  assert.equal(st.localCircuitOpen, false);
});

test('★★ 本地连续失败 3 次 ⇒ 熔断：第 4 条**连试都不试**，直接走云', async () => {
  const stream = fakeStream('云的结果', { failProviders: ['local-llamacpp'] });
  const desc = makeDescriber({ gate: fakeGate(LOCAL_DECISION), stream });
  await desc.describe(IMAGE_INPUT);
  await desc.describe({ ...IMAGE_INPUT, name: 'b.png' });
  await desc.describe({ ...IMAGE_INPUT, name: 'c.png' });

  const beforeTrips = stream.calls.length;
  assert.equal(beforeTrips, 6, '3 次各"本地失败 + 云成功"= 6 次调用');
  assert.equal(desc.stats().visionGate.localCircuitOpen, true);

  stream.calls.length = 0;
  await desc.describe({ ...IMAGE_INPUT, name: 'd.png' });
  assert.deepEqual(stream.calls, [
    { provider: 'discovery-intern-ai', model: 'deepseek-v4-flash-vision' },
  ], '熔断之后不该再去碰本地（否则每条图消息都白等一次本地超时）');
  const st = desc.stats().visionGate;
  assert.equal(st.localAttempts !== undefined ? st.localAttempts : 0, 0);
  assert.equal(typeof st.localFailed, 'number');
});

test('★ 本地成功一次 ⇒ 连败清零（偶发失败不该把本地永久判死）', async () => {
  let failLocal = true;
  const calls = [];
  const stream = (opts) => {
    calls.push({ provider: opts.provider, model: opts.model });
    return (async function* gen() {
      if (opts.provider === 'local-llamacpp' && failLocal) throw new Error('boom');
      yield { type: 'text-delta', text: 'ok' };
    })();
  };
  stream.calls = calls;
  const desc = makeDescriber({ gate: fakeGate(LOCAL_DECISION), stream });

  await desc.describe(IMAGE_INPUT);
  await desc.describe({ ...IMAGE_INPUT, name: 'b.png' });
  assert.equal(desc.stats().visionGate.localFailed, 2);
  assert.equal(desc.stats().visionGate.localCircuitOpen, false);

  failLocal = false;
  await desc.describe({ ...IMAGE_INPUT, name: 'c.png' });   // 这次本地成功
  assert.equal(desc.stats().visionGate.localFailed, 2, '成功不该让"失败计数"变小');
  // 再来 2 次失败也不该熔断（因为中间成功过，连败被清零了）
  failLocal = true;
  await desc.describe({ ...IMAGE_INPUT, name: 'd.png' });
  await desc.describe({ ...IMAGE_INPUT, name: 'e.png' });
  assert.equal(desc.stats().visionGate.localCircuitOpen, false, '连败只该数"连续"的那几次');
});

// ─────────────────────────────────────────────── ★ 手动配置赢

test('★★ 手动指定了 provider/model ⇒ 门控**完全不插手**（手动赢）', async () => {
  const stream = fakeStream('{"isSticker":true,"portrait":false,"screenshot":false,"scores":{"nsfw":0,"violence":0,"gore":0,"ugly":0},"caption":"","desc":"一只猫","tags":[],"unmatched":""}');
  const desc = makeDescriber({
    gate: fakeGate(CLOUD_DECISION),
    stream,
    // 手动配到**本地**（哪怕门控这会儿说"显存不够，用云"）。
    stickerGate: { provider: 'local-llamacpp', model: 'qwen3.5-4b-q4km-vision' },
  });
  await desc.describeSticker({ data: PNG_BYTES, mediaType: 'image/png', name: 's.png' });
  assert.deepEqual(stream.calls, [
    { provider: 'local-llamacpp', model: 'qwen3.5-4b-q4km-vision' },
  ], '手动配的是人写的值，自动门控不许改它');
  const st = desc.stats().visionGate;
  assert.equal(st.manualOverride, 1);
  assert.equal(st.cloudLowVram, 0, '被门控接管的调用才记门控的账');
  assert.equal(st.last, null, '手动那条路不该去问门控');});
test('★ 手动只写了一半（只给 model）⇒ 缺的那半沿用手动侧的实例值，不混门控', async () => {
  const stream = fakeStream();
  const desc = makeDescriber({
    gate: fakeGate(LOCAL_DECISION),
    stream,
    stickerGate: { provider: '', model: 'deepseek-v4-flash-vision' },
  });
  await desc.describeSticker({ data: PNG_BYTES, mediaType: 'image/png', name: 's.png' });
  assert.deepEqual(stream.calls, [
    { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision' },
  ]);
});

// ─────────────────────────────────────────────── 统计快照

test('调试快照里能看出"门控开没开 / 阈值 / 本地配了哪条"（否则只能靠猜）', async () => {
  const desc = makeDescriber({ gate: fakeGate(CLOUD_DECISION), stream: fakeStream() });
  const st = desc.stats().visionGate;
  assert.equal(st.enabled, true);
  assert.equal(st.thresholdMiB, 7168);
  assert.equal(st.cacheMs, 5000);
  assert.equal(st.localProvider, 'local-llamacpp');
  assert.equal(st.localModel, 'qwen3.5-4b-q4km-vision');
  assert.equal(st.cloudProvider, 'discovery-intern-ai');
  assert.equal(st.cloudModel, 'deepseek-v4-flash-vision');
  assert.equal(st.localCircuitOpen, false);
  assert.equal(st.localFailStreak, 0);
  // 计数器全都在（缺字段会让调试快照看不出"到底哪条路在跑"）
  for (const k of ['off', 'local', 'cloudLowVram', 'cloudNoProbe', 'cloudNoLocal', 'manualOverride', 'localFailed', 'localCircuitOpen']) {
    const kind = k === 'localCircuitOpen' ? 'boolean' : 'number';
    assert.equal(typeof st[k], kind, `visionGate.${k} 类型不对`);
  }
});

test('门控关闭时，统计快照**不许**谎报本地/云的名字（会误导成"接线坏了"）', async () => {
  const desc = makeDescriber({ gate: null, stream: fakeStream() });
  const st = desc.stats().visionGate;
  assert.equal(st.enabled, false);
  assert.equal(st.localProvider, '');
  assert.equal(st.cloudProvider, 'discovery-intern-ai', '没配门控时这里报的是代码默认的云');
});

// ─────────────────────────────────────────────── 审核留样（sticker-audit 接线）

const STICKER_JSON_ACCEPT = '{"isSticker":true,"portrait":false,"screenshot":false,"political":false,"pureText":false,"scores":{"nsfw":0,"violence":0,"gore":0,"ugly":1,"funny":8},"caption":"我裂开了","desc":"一只猫","tags":["调侃吐槽"],"unmatched":""}';
const STICKER_JSON_REJECT = '{"isSticker":true,"portrait":false,"screenshot":false,"political":false,"pureText":false,"scores":{"nsfw":0,"violence":0,"gore":0,"ugly":8,"funny":8},"caption":"","desc":"很怪的一张","tags":[],"unmatched":""}';

/** 假的留样器：把每次 save 的入参记下来。 */
function fakeAudit({ mode = 'ok' } = {}) {
  const calls = [];
  return {
    calls,
    async save(input) {
      calls.push(input);
      if (mode === 'throw') throw new Error('audit exploded');
      return { md5: 'fake', file: 'fake.png' };
    },
    stats: () => ({ wrote: calls.length, enabled: true, disabled: false, dir: 'H:\\fake' }),
  };
}

test('★★ 审核留样：**被拒的那张也要存**，而且带上"当时生效的阈值"', async () => {
  const audit = fakeAudit();
  const desc = createImageDescriber({
    attachments: fakeAttachments(),
    stream: fakeStream(STICKER_JSON_REJECT),
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    log: () => {},
    tablePath: '',
    stickerGate: null,
    stickerAudit: audit,
  });
  const verdict = await desc.describeSticker(
    { data: PNG_BYTES, mediaType: 'image/png', name: 's.png', source: { chatId: 'group:30000011', userId: '3410284724', subType: 1 } },
  );
  assert.equal(verdict.accept, false);
  assert.equal(verdict.reject, 'ugly');
  assert.equal(audit.calls.length, 1, '被拒的图必须留样 —— 这是这个功能的全部意义');
  const call = audit.calls[0];
  assert.equal(call.source.chatId, 'group:30000011');
  assert.equal(call.source.userId, '3410284724');
  assert.deepEqual(call.thresholds, {
    nsfwMax: 4, violenceMax: 4, goreMax: 4, uglyMax: 4, funnyMin: 3, captionMaxChars: 120,
    // ⭐ 2026-10-10：`maxTokens` 也进来了 —— 它决定"这张到底有没有被截断"，
    //    而"被截断"与"模型判它不合格"在结果上长得一模一样（所以必须留档）。
    maxTokens: 420,
    // ⭐ 2026-10-10：`enableThinking`（这次关没关思考）。它在 `thresholds` 里而不是
    //    `notes` 里是**故意的** —— `thresholds` 同时进侧车 json 和 index.jsonl 那一行。
    enableThinking: false,
  }, '留样里必须写下**当时生效的全部参数**（含 funnyMin、caption 红线、输出预算 maxTokens、思考开关 enableThinking）');
  assert.equal(call.verdict.reject, 'ugly');
  assert.deepEqual(call.verdict.scores, { nsfw: 0, violence: 0, gore: 0, ugly: 8, funny: 8 });
  assert.equal(call.data, PNG_BYTES, '存的必须是模型真看的那份字节');
  assert.equal(call.mediaType, 'image/png');
});

test('★ 收下的那张也留样；`ok:false`（没看成）时留样里的 ok 也是 false', async () => {
  const audit = fakeAudit();
  const descOk = createImageDescriber({
    attachments: fakeAttachments(), stream: fakeStream(STICKER_JSON_ACCEPT),
    provider: 'p', model: 'm', log: () => {}, tablePath: '', stickerAudit: audit,
  });
  await descOk.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(audit.calls.length, 1);
  assert.equal(audit.calls[0].verdict.accept, true);

  // 模型回了一段不是 JSON 的东西 ⇒ ok:false，但**照样留样**（那类"看不见"的失败要能标）
  const audit2 = fakeAudit();
  const descBad = createImageDescriber({
    attachments: fakeAttachments(), stream: fakeStream('我不知道这是什么'),
    provider: 'p', model: 'm', log: () => {}, tablePath: '', stickerAudit: audit2,
  });
  const v = await descBad.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(v.ok, false);
  assert.equal(audit2.calls.length, 1);
  assert.equal(audit2.calls[0].verdict.ok, false);
  assert.equal(audit2.calls[0].verdict.reject, null, '"没看成"不许伪装成"判它不合格"');
});

test('★★ 留样写盘抛异常 ⇒ **判定结果一点都不能变**', async () => {
  const audit = fakeAudit({ mode: 'throw' });
  const desc = createImageDescriber({
    attachments: fakeAttachments(), stream: fakeStream(STICKER_JSON_ACCEPT),
    provider: 'p', model: 'm', log: () => {}, tablePath: '', stickerAudit: audit,
  });
  const v = await desc.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(v.ok, true);
  assert.equal(v.accept, true);
  assert.equal(audit.calls.length, 1);
});

test('★ 不传 stickerAudit ⇒ 快照里 stickerAudit 是 null（"没接"与"接了但没写"要分得开）', async () => {
  const desc = makeDescriber({ gate: null, stream: fakeStream() });
  assert.equal(desc.stats().stickerAudit, null);
  const audit = fakeAudit();
  const desc2 = createImageDescriber({
    attachments: fakeAttachments(), stream: fakeStream(), provider: 'p', model: 'm',
    log: () => {}, tablePath: '', stickerAudit: audit,
  });
  assert.equal(desc2.stats().stickerAudit.dir, 'H:\\fake');
});

test('★★ 接线契约：`sticker-library` 传 `(image, meta)`，`index.mjs` 的桥必须把 meta 并进 input', async () => {
  // ⚠️ 这条钉的是**一个只有一个字之差就会静默失效**的接线：
  //
  //   `sticker-library.mjs` 的调用是 `recognize(image, meta)`（**两个参数**），
  //   而 `image-desc.mjs` 的 `describeSticker(input)` **只收一个对象** ⇒
  //   中间必须有一句 `(image, meta) => describeSticker({ ...image, source: meta })`。
  //
  //   少写那个 `...image`：`input.data` 就没了 ⇒ 走"从段里找原件"，多一次下载甚至失败；
  //   少写 `source: meta`：留样里 `source.chatId` 永远是空串 ⇒ 用户看到一张被拒的图
  //   也答不出"这是谁在哪个群发的"（**而审核结果本身完全正常，所以查不出来**）。
  //
  // 这里用**和 index.mjs 逐字相同的桥**，按 sticker-library 的**逐字相同的调用形状**去调。
  const audit = fakeAudit();
  const desc = createImageDescriber({
    attachments: fakeAttachments(), stream: fakeStream(STICKER_JSON_REJECT),
    provider: 'deepseek-official', model: 'deepseek-flash',
    log: () => {}, tablePath: '', stickerAudit: audit,
  });
  const bridge = (image, meta) => desc.describeSticker({ ...image, source: meta ?? null });

  // ← 这一行的形状抄自 `sticker-library.mjs` 的 `keepOne`：
  const image = { data: PNG_BYTES, mediaType: 'image/png', name: 'a.gif' };
  const meta = { chatId: 'group:30000011', userId: '3410284724', subType: 1 };
  const verdict = await bridge(image, meta);

  assert.equal(verdict.ok, true);
  assert.equal(audit.calls.length, 1);
  assert.equal(audit.calls[0].data, PNG_BYTES, '`...image` 少了 ⇒ 字节就丢了');
  assert.equal(audit.calls[0].source.chatId, 'group:30000011', '`source: meta` 少了 ⇒ 来源就丢了');
  assert.equal(audit.calls[0].source.userId, '3410284724');
  assert.equal(audit.calls[0].source.subType, 1);
});
