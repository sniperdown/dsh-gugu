/**
 * **图片描述那条路的思考开关**（`[vision_gate] enableThinking`，2026-11-06）。
 *
 * ## 为什么是**另一个**键（别和「认」那个混）
 *
 * 「认」（表情包审核，`describeStickerWithVision`）从 2026-10-10 起就有
 * `[sticker_gate] enableThinking`。而**图片描述**（转发里那张图配一句话，
 * `describeWithVision` → `callVision`）**从来没有**传过 `reasoningEffort` ——
 * 它一直吃 `callVision` 的默认参数 `'off'`，等于**永远关着思考、且没有任何配置能改**。
 *
 * 2026-11-06 加了这一项：两个键各管一条路，**谁也别替谁决定**。
 *
 * ## 它盯的三件事（每件的坏法都是静默的）
 *
 * 1. **默认 `false` ⇒ 请求里就是 `reasoningEffort: 'off'`** —— 与加这个键之前**逐字节相同**
 *    （这是给用户做 A/B 的前提：不配置 = 现在线上什么样，还是什么样）；
 * 2. **`true` ⇒ 请求里【完全没有】`reasoningEffort` 这个字段** —— **不是** `'low'`：
 *    DSH 的 LLM 环缝只认 `GenerateOptions.reasoningEffort`，"不发"才是"让 provider 用默认档"
 *    （手写进配置的模型只声明了 `off`，发别的会直接抛 `UNSUPPORTED_REASONING_EFFORT`）；
 * 3. **能被看见**：配置页白名单里有它、调试快照 `imageDesc.visionGate.enableThinking` 里有它 ——
 *    否则"toml 里写了到底读到没有"只能翻代码，而这正是本项目最贵的那类坑。
 *
 * ⚠️ 这里**不测** toml 装载那一层（`loadVisionGate`）—— 那是 `vision-gate-toml.test.mjs` 的家。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createImageDescriber } from '../src/dsh/image-desc.mjs';
import { DEFAULT_VISION_GATE, normalizeVisionGate } from '../src/dsh/vram-gate.mjs';
import { CONFIG_FIELDS, coerceFieldValue, effectiveFieldValue, fileFieldValue } from '../src/dsh/config-fields.mjs';
import { buildSnapshot } from '../src/dsh/debug-snapshot.mjs';
import { parseToml } from '../src/dsh/toml.mjs';

/** 一段合法的 PNG 头（够 `sniffImageMediaType` 认出来）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const IMAGE_INPUT = { data: PNG_BYTES, mediaType: 'image/png', name: 'a.png' };

/**
 * 假装是 `ctx.llm.stream`：**把整份调用参数记下来**。
 *
 * ⚠️ 这里不能只记 provider/model —— 本组要断言的是"请求里有没有 `reasoningEffort`
 * 这个字段"，而"字段不存在"和"字段值是 undefined"在语义上不是一回事
 * （`'reasoningEffort' in call` 才是判据）。
 */
function fakeStream(reply = '一只橘猫趴在键盘上') {
  const calls = [];
  const fn = (opts) => {
    calls.push(opts);
    return (async function* gen() { yield { type: 'text-delta', text: reply }; })();
  };
  fn.calls = calls;
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
 * 造一个描述器。
 *
 * `visionGateConfig` 就是 `index.mjs` 从 `[vision_gate]` 读出来、`normalizeVisionGate`
 * 收拾过的那份（`loadVisionGate` 的返回值再 normalize 一次的那个形状）。
 */
function makeDescriber({ stream, visionGateConfig = null, visionGate = null } = {}) {
  return createImageDescriber({
    attachments: fakeAttachments(),
    stream,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    log: () => {},
    tablePath: '',
    visionGate,
    visionGateConfig,
  });
}

// ─────────────────────────────────────────────── 默认值 / 解析口径

test('★ [vision_gate] enableThinking：默认 false（= 老行为）、只认真布尔、认不出就回退', () => {
  assert.equal(
    DEFAULT_VISION_GATE.enableThinking, false,
    '默认必须是"不思考" —— 它就是加这个键之前的行为，A/B 的对照组',
  );
  assert.equal(normalizeVisionGate({}).enableThinking, false, '没写就用默认');
  assert.equal(normalizeVisionGate({ enableThinking: false }).enableThinking, false);
  assert.equal(normalizeVisionGate({ enableThinking: true }).enableThinking, true, '显式打开要能读到');
  // ⚠️ 只认真布尔：`"true"` / `0` / `1` 这类值语义有歧义，猜错的方向是
  //    "把图片描述的思考悄悄打开或关掉"，而且**不报错、计数正常** ⇒ 一律回退 + 留 warn。
  assert.equal(normalizeVisionGate({ enableThinking: 'true' }).enableThinking, false, '字符串 true 不认（免得方向猜反）');
  assert.equal(normalizeVisionGate({ enableThinking: 'false' }).enableThinking, false);
  assert.equal(normalizeVisionGate({ enableThinking: 0 }).enableThinking, false);
  assert.equal(normalizeVisionGate({ enableThinking: 1 }).enableThinking, false);
  assert.equal(normalizeVisionGate({ enableThinking: null }).enableThinking, false);
});

// ─────────────────────────────────────────────── ★ 真的进了那次调用

test('★★ 默认（false）⇒ 结果图那次调用带 `reasoningEffort: "off"`（与加这个键之前逐字节相同）', async () => {
  const stream = fakeStream();
  const desc = makeDescriber({ stream });
  assert.equal(await desc.describe(IMAGE_INPUT), '一只橘猫趴在键盘上');

  assert.equal(stream.calls.length, 1, '一张图一次调用（别悄悄多调）');
  assert.equal(stream.calls[0].reasoningEffort, 'off', '默认走的就是老路：显式 off');
  // 顺带钉住"别的都没动"：provider/model 仍是实例级那对（门控没配 ⇒ 老行为）。
  assert.equal(stream.calls[0].provider, 'deepseek-official');
  assert.equal(stream.calls[0].model, 'deepseek-flash');
  assert.equal(desc.stats().visionGate.enableThinking, false, '调试快照里也要能看见它');
});

test('★★ true ⇒ 请求里**完全没有** `reasoningEffort` 这个字段（不是 "low"）', async () => {
  const stream = fakeStream();
  const desc = makeDescriber({ stream, visionGateConfig: { enableThinking: true } });
  assert.equal(await desc.describe(IMAGE_INPUT), '一只橘猫趴在键盘上');

  assert.equal(
    'reasoningEffort' in stream.calls[0], false,
    'true 只能"不发这个字段"：手写进配置的模型只声明了 off，发 low 会直接抛 UNSUPPORTED_REASONING_EFFORT',
  );
  // 其余一切照旧 —— 这个开关只动思考档，不许顺带换模型 / 改预算。
  assert.equal(stream.calls[0].provider, 'deepseek-official');
  assert.equal(stream.calls[0].model, 'deepseek-flash');
  assert.equal(desc.stats().visionGate.enableThinking, true);
});

test('★ 开关与"走本地还是走云"无关：门控选本地时 true 一样不发这个字段', async () => {
  // 决策函数替身（决策本身由 vram-gate.test.mjs 钉，这里只测接线）。
  const decide = async () => ({
    use: 'local',
    reason: 'vram-enough',
    freeMiB: 9000,
    thresholdMiB: 7168,
    cached: false,
    ageMs: 0,
    provider: 'local-llamacpp',
    model: 'qwen3.5-4b-q4km-vision',
    cloud: { provider: 'p-vision-test', model: 'vision-test-model' },
    local: { provider: 'local-llamacpp', model: 'qwen3.5-4b-q4km-vision' },
  });
  decide.config = () => ({ freeMiB: 7168, cacheMs: 5000, enableThinking: true, local: { provider: 'local-llamacpp', model: 'qwen3.5-4b-q4km-vision' } });

  const stream = fakeStream();
  const desc = makeDescriber({ stream, visionGate: decide });
  await desc.describe(IMAGE_INPUT);
  assert.equal(stream.calls[0].provider, 'local-llamacpp', '本地那半照旧被选中');
  assert.equal('reasoningEffort' in stream.calls[0], false);
  assert.equal(desc.stats().visionGate.enableThinking, true, '从决策函数自报的 config 里也要能读到');
});

// ─────────────────────────────────────────────── 配置页白名单

test('★ 配置页：`vision_gate.enableThinking` 在白名单里，落在 qq-gugu.vision.toml，能读能写', () => {
  const field = CONFIG_FIELDS.find((item) => item.key === 'vision_gate.enableThinking');
  assert.ok(field, '不白名单 = 页面上根本看不见这个开关');
  assert.equal(field.label, '识图 · 开思考');
  assert.equal(field.section, 'vision_gate');
  assert.deepEqual(field.sectionPath, ['vision_gate'], '写回的是 [vision_gate] 段（不是 [vision_gate.cloud] 之类）');
  assert.equal(field.tomlKey, 'enableThinking');
  assert.equal(field.type, 'bool');
  assert.equal(field.default, false);
  assert.deepEqual(
    field.effectivePath, ['vision', 'enableThinking'],
    '生效值要指向 `index.mjs` 组装的那棵树（`effective.vision = {...visionGateConfig}`）',
  );
  assert.equal(field.file, 'vision', '必须写进 qq-gugu.vision.toml —— 写错文件就是"保存成功但没生效"');

  // **生效值**（进程里读到的）：取不到 ⇒ 默认 false（不是 undefined）。
  assert.equal(effectiveFieldValue(field, { vision: { enableThinking: true } }), true);
  assert.equal(effectiveFieldValue(field, { vision: { enableThinking: false } }), false);
  assert.equal(effectiveFieldValue(field, {}), false, '还没读到 / 没有这一节 ⇒ 显示 false');

  // **文件值**：toml 里写的东西读得回来（没写 ⇒ null，页面显示"未设置"）。
  assert.equal(fileFieldValue(field, parseToml('[vision_gate]\nenableThinking = true\n')), true);
  assert.equal(fileFieldValue(field, parseToml('[vision_gate]\nenableThinking = "true"\n')), null, '类型不对 ⇒ null（不猜）');
  assert.equal(fileFieldValue(field, parseToml('[vision_gate]\n')), null);

  // **页面提交值**：boolean 与 "true" / "false" 都收，"maybe" 直接拒。
  assert.deepEqual(coerceFieldValue(field, true), { ok: true, value: true });
  assert.deepEqual(coerceFieldValue(field, 'false'), { ok: true, value: false });
  assert.equal(coerceFieldValue(field, 'maybe').ok, false);
});

test('★ 两个 enableThinking 是**两个字段**：白名单里同时有 vision_gate 与 sticker_gate 那两条', () => {
  const vision = CONFIG_FIELDS.find((item) => item.key === 'vision_gate.enableThinking');
  const sticker = CONFIG_FIELDS.find((item) => item.key === 'sticker_gate.enableThinking');
  assert.ok(vision, '图片描述的那个');
  assert.ok(sticker, '「认」的那个（语义不许被这次改动碰）');
  assert.notEqual(vision.section, sticker.section);
  assert.notEqual(vision.file, sticker.file, '一个在 vision.toml、一个在 sticker.toml');
  assert.deepEqual(sticker.effectivePath, ['sticker', 'enableThinking'], '「认」那条的生效路径一个字都没改');
});

// ─────────────────────────────────────────────── 快照能查到

test('★ 调试快照：`imageDesc.visionGate.enableThinking` 能直接查到（不用翻代码）', () => {
  // `debug-snapshot.mjs` 的 `imageDescStats` 把描述器 `stats().visionGate` 整块搬进快照，
  // 所以这里只要钉住"那一块里有这个字段"，就钉住了落盘路径：
  //   `<DSH_HOME>\media\qq-proactive-debug.json` → `imageDesc.visionGate.enableThinking`
  const snap = buildSnapshot({
    gateway: {
      stats: {},
      imageDescriber: {
        stats: () => ({
          visionGate: { enabled: true, enableThinking: true, thresholdMiB: 7168 },
        }),
      },
    },
    engine: {},
    transport: {},
    config: {},
  });
  assert.equal(snap.imageDesc.visionGate.enableThinking, true, '配置页以外，这条是"toml 读到没有"唯一能直接查的地方');
});
