/**
 * 显存门控测试（`src/dsh/vram-gate.mjs`）。
 *
 * ## 为什么这组测试必须存在
 *
 * 用户要的是一个 **if**：「空闲显存 < 7G ⇒ 云，否则本地」。
 * 一个 if 的坏法**全都不报错**：
 *
 * - 方向写反（显存少反而去拉 6 GB 的本地模型）—— 照样跑，只是在真机上把卡挤爆；
 * - 阈值单位搞错（7168 MiB 写成 7000 或 7×1024×1024）—— 只在边界那几百 MiB 上表现不同，
 *   平时看不出来；
 * - 探针失败时**默认走本地** —— 表现为"偶尔一次加载 10 秒然后失败"，最像"网络抖动"；
 * - 每次都真跑 `nvidia-smi` —— 每条带图消息 fork 一个进程，机器慢慢变卡；
 * - 缓存失败结果 —— 一次偶发超时会锁死好几秒。
 *
 * ⇒ 这里**注入假探针**把两个分支都钉死（不用真显卡、测起来也是毫秒级），
 * 再单独钉"失败 ⇒ 云""缓存""并发合并""夹紧"这几条行为。
 *
 * ⚠️ 测试**不碰真显卡**：只有 `DEFAULT_VISION_GATE` 的默认值测试是纯常量断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VISION_GATE,
  GIB,
  createVisionGate,
  normalizeVisionGate,
  probeFreeVram,
} from '../src/dsh/vram-gate.mjs';

/** 假探针：固定读数 / 固定失败 / 抛异常 / 计数。 */
function fakeProbe(value, { throws = false } = {}) {
  const fn = async () => {
    fn.calls += 1;
    if (throws) throw new Error('probe exploded');
    if (value === 'invalid') return { freeMiB: 'not-a-number' };
    if (value === null) return null;
    return { freeMiB: value };
  };
  fn.calls = 0;
  return fn;
}

/** 可控时钟。 */
function fakeClock(t0 = 1_000_000) {
  let t = t0;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  return fn;
}

// ─────────────────────────────────────────────── 默认值与夹紧

test('★ 默认阈值就是用户说的「7g」= 7168 MiB（不是 7000，也不是 7×1024×1024）', () => {
  // 单位口径：`nvidia-smi --query-gpu=memory.free` 的原生单位是 **MiB**，
  // 所以 7 GB 要按 7 × 1024 换算。写成 7000 会让阈值悄悄低 168 MiB，
  // 写成 7×1024×1024 会让它高到永远走云（**那是最坏的一种**：本地永远不启用，
  // 而日志里只显示"走了云"，看起来像功能没坏）。
  assert.equal(GIB, 1024);
  assert.equal(DEFAULT_VISION_GATE.freeMiB, 7 * 1024);
  assert.equal(DEFAULT_VISION_GATE.freeMiB, 7168);
  assert.equal(DEFAULT_VISION_GATE.cacheMs, 5000);
  assert.equal(DEFAULT_VISION_GATE.cloud.provider, 'your-provider');
  assert.equal(DEFAULT_VISION_GATE.cloud.model, 'your-vision-model');
  // 本地那半**默认空** ⇒ 默认没有本地路（没配 provider 的部署不该"看起来能走本地"）。
  assert.equal(DEFAULT_VISION_GATE.local.provider, '');
  assert.equal(DEFAULT_VISION_GATE.local.model, '');
});

test('夹紧：越界的数夹到边界（不抛、不静默丢弃）', () => {
  const g = normalizeVisionGate({ freeMiB: 7_000_000, cacheMs: -5, probeTimeoutMs: 0 });
  assert.equal(g.freeMiB, 64 * 1024, '把 MiB 当字节写的那种错要夹到上界');
  assert.equal(g.cacheMs, 0, '负缓存 = 关掉缓存');
  assert.equal(g.probeTimeoutMs, 200, '探针超时下限 200 ms');

  const g2 = normalizeVisionGate({ freeMiB: 0, cacheMs: 99_999_999 });
  assert.equal(g2.freeMiB, 1);
  assert.equal(g2.cacheMs, 600_000);
});

test('夹紧：认不出的、缺的字段回退默认值；cloud 缺一半时**按字段**补默认', () => {
  const g = normalizeVisionGate({ freeMiB: 'abc', cloud: { provider: 'x' }, local: 'nonsense' });
  assert.equal(g.freeMiB, DEFAULT_VISION_GATE.freeMiB);
  assert.equal(g.cloud.provider, 'x');
  assert.equal(g.cloud.model, DEFAULT_VISION_GATE.cloud.model, '缺的字段补默认，不是整块丢掉');
  assert.equal(g.local.provider, '');
  assert.equal(g.local.model, '');
});

// ─────────────────────────────────────────────── ★ 两个分支（用户要的那个 if）

test('★★ 空闲显存 < 阈值 ⇒ 用云（云）', async () => {
  const probe = fakeProbe(3000);
  const decide = createVisionGate({
    gate: { freeMiB: 7168, local: { provider: 'local-llamacpp', model: 'qwen3.5-4b-q4km-vision' } },
    probe,
  });
  const d = await decide({ localProvider: 'local-llamacpp', localModel: 'qwen3.5-4b-q4km-vision' });
  assert.equal(d.use, 'cloud');
  assert.equal(d.reason, 'vram-low');
  assert.equal(d.provider, 'your-provider');
  assert.equal(d.model, 'your-vision-model');
  assert.equal(d.freeMiB, 3000);
  assert.equal(d.thresholdMiB, 7168);
  assert.equal(probe.calls, 1);
});

test('★★ 空闲显存 ≥ 阈值 ⇒ 用本地', async () => {
  const probe = fakeProbe(9000);
  const decide = createVisionGate({
    gate: { freeMiB: 7168, local: { provider: 'local-llamacpp', model: 'qwen3.5-4b-q4km-vision' } },
    probe,
  });
  const d = await decide({ localProvider: 'local-llamacpp', localModel: 'qwen3.5-4b-q4km-vision' });
  assert.equal(d.use, 'local');
  assert.equal(d.reason, 'vram-enough');
  assert.equal(d.provider, 'local-llamacpp');
  assert.equal(d.model, 'qwen3.5-4b-q4km-vision');
  assert.equal(d.freeMiB, 9000);
});

test('★ 边界：**正好等于**阈值 ⇒ 本地（判据是 `<` 不够，不是 `<=`）', async () => {
  // 这条是"方向"最容易写错的地方：`<` 和 `<=` 只差一个数，
  // 但在阈值上反复横跳的机器上，就是"时好时坏"的来源。
  const decide = createVisionGate({
    gate: { freeMiB: 7168, local: { provider: 'p', model: 'm' } },
    probe: fakeProbe(7168),
  });
  const d = await decide({ localProvider: 'p', localModel: 'm' });
  assert.equal(d.use, 'local');

  const decide2 = createVisionGate({
    gate: { freeMiB: 7168, local: { provider: 'p', model: 'm' } },
    probe: fakeProbe(7167),
  });
  const d2 = await decide2({ localProvider: 'p', localModel: 'm' });
  assert.equal(d2.use, 'cloud', '少 1 MiB 就该走云');
});

// ─────────────────────────────────────────────── ★ 保守默认：问不出来就用云

test('★★ 探针失败（null）⇒ 用云，而且**不去缓存这次失败**', async () => {
  let value = null;
  const probe = async () => { probe.calls = (probe.calls ?? 0) + 1; return value === null ? null : { freeMiB: value }; };
  probe.calls = 0;
  const decide = createVisionGate({
    gate: { freeMiB: 7168, cacheMs: 5000, local: { provider: 'p', model: 'm' } },
    probe,
  });
  const d = await decide({ localProvider: 'p', localModel: 'm' });
  assert.equal(d.use, 'cloud');
  assert.equal(d.reason, 'probe-failed');
  assert.equal(d.freeMiB, null);
  assert.equal(d.cached, false);

  // 下一次**立刻重试**（失败不进缓存）：成功了就该按成功的结果走。
  value = 9000;
  const d2 = await decide({ localProvider: 'p', localModel: 'm' });
  assert.equal(probe.calls, 2, '失败不该被缓存住');
  assert.equal(d2.use, 'local');
});

test('★★ 探针**抛异常**也不许冒出来（这条路在每条带图消息上）', async () => {
  const decide = createVisionGate({
    gate: { freeMiB: 7168, local: { provider: 'p', model: 'm' } },
    probe: fakeProbe(0, { throws: true }),
  });
  const d = await decide({ localProvider: 'p', localModel: 'm' });
  assert.equal(d.use, 'cloud');
  assert.equal(d.reason, 'probe-failed');
});

test('探针返回一个**非数字**的读数 ⇒ 当问不出来（走云）', async () => {
  const decide = createVisionGate({
    gate: { freeMiB: 7168, local: { provider: 'p', model: 'm' } },
    probe: fakeProbe('invalid'),
  });
  const d = await decide({ localProvider: 'p', localModel: 'm' });
  assert.equal(d.use, 'cloud');
  assert.equal(d.reason, 'probe-failed');
});

test('★ 没有本地 provider ⇒ 用云，而且**连显存都不查**（省一次 fork）', async () => {
  const probe = fakeProbe(99999);
  const decide = createVisionGate({ gate: { freeMiB: 7168 }, probe });
  const d = await decide({ localProvider: '', localModel: '' });
  assert.equal(d.use, 'cloud');
  assert.equal(d.reason, 'no-local-provider');
  assert.equal(probe.calls, 0, '没有本地路时查显存是纯浪费');
});

// ─────────────────────────────────────────────── 缓存

test('★ 几秒内连问多次只跑一次探针（缓存），过了窗口才重查', async () => {
  const probe = fakeProbe(9000);
  const clock = fakeClock();
  const decide = createVisionGate({
    gate: { freeMiB: 7168, cacheMs: 5000, local: { provider: 'p', model: 'm' } },
    probe,
    now: clock,
  });
  const a = await decide({ localProvider: 'p', localModel: 'm' });
  const b = await decide({ localProvider: 'p', localModel: 'm' });
  const c = await decide({ localProvider: 'p', localModel: 'm' });
  assert.equal(probe.calls, 1, '三条消息只该 fork 一次 nvidia-smi');
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(c.cached, true);
  assert.equal(b.ageMs, 0);
  assert.equal(b.freeMiB, 9000);

  clock.advance(4999);
  await decide({ localProvider: 'p', localModel: 'm' });
  assert.equal(probe.calls, 1, '还没过期');

  clock.advance(2); // 累计 5001 > 5000
  const d = await decide({ localProvider: 'p', localModel: 'm' });
  assert.equal(probe.calls, 2, '过期了要重查');
  assert.equal(d.cached, false);
});

test('★ cacheMs=0 ⇒ 每次都真查（测试与"刚有大变化"时用）', async () => {
  const probe = fakeProbe(9000);
  const decide = createVisionGate({
    gate: { freeMiB: 7168, cacheMs: 0, local: { provider: 'p', model: 'm' } },
    probe,
  });
  await decide({ localProvider: 'p', localModel: 'm' });
  await decide({ localProvider: 'p', localModel: 'm' });
  assert.equal(probe.calls, 2);
});

test('★ 并发：同一时刻的多个请求**共享一次**探针（不是一个请求一个进程）', async () => {
  let release;
  const gate1 = new Promise((r) => { release = r; });
  let calls = 0;
  const probe = async () => { calls += 1; await gate1; return { freeMiB: 9000 }; };
  const decide = createVisionGate({
    gate: { freeMiB: 7168, cacheMs: 5000, local: { provider: 'p', model: 'm' } },
    probe,
  });
  const all = [
    decide({ localProvider: 'p', localModel: 'm' }),
    decide({ localProvider: 'p', localModel: 'm' }),
    decide({ localProvider: 'p', localModel: 'm' }),
  ];
  release();
  const [a, b, c] = await Promise.all(all);
  assert.equal(calls, 1, '三个并发请求只该有一次读数');
  for (const d of [a, b, c]) assert.equal(d.use, 'local');
});

// ─────────────────────────────────────────────── 决策结果的形状

test('决策结果带齐"事后能复盘"的字段（日志里要能看出为什么这么选）', async () => {
  const decide = createVisionGate({
    gate: {
      freeMiB: 7168,
      cacheMs: 3000,
      cloud: { provider: 'your-provider', model: 'your-vision-model' },
      local: { provider: 'local-llamacpp', model: 'qwen3.5-4b-q4km-vision' },
    },
    probe: fakeProbe(2000),
  });
  const d = await decide({});
  // 这一组就是 `visionGateLast` 往调试快照里写的那些字段。
  assert.deepEqual(Object.keys(d).sort(), [
    'ageMs', 'cached', 'cloud', 'freeMiB', 'local', 'model', 'provider', 'reason',
    'thresholdMiB', 'use',
  ]);
  assert.equal(d.cloud.provider, 'your-provider');
  assert.equal(d.local.provider, 'local-llamacpp');
  assert.equal(d.thresholdMiB, 7168);
  assert.equal(d.cached, false);
});

test('`peek()` / `reset()`：缓存能被看见、也能被清掉', async () => {
  const probe = fakeProbe(9000);
  const decide = createVisionGate({
    gate: { freeMiB: 7168, cacheMs: 5000, local: { provider: 'p', model: 'm' } },
    probe,
  });
  assert.equal(decide.peek(), null);
  await decide({ localProvider: 'p', localModel: 'm' });
  assert.equal(decide.peek().freeMiB, 9000);
  decide.reset();
  assert.equal(decide.peek(), null);
  await decide({ localProvider: 'p', localModel: 'm' });
  assert.equal(probe.calls, 2);
});

test('`decide.config()` 报出当前生效的参数（"toml 到底读到没有"用它）', () => {
  const decide = createVisionGate({
    gate: { freeMiB: 4096, cacheMs: 0, local: { provider: 'lp', model: 'lm' } },
    probe: fakeProbe(9000),
  });
  const cfg = decide.config();
  assert.equal(cfg.freeMiB, 4096);
  assert.equal(cfg.local.provider, 'lp');
  assert.equal(cfg.cloud.provider, 'your-provider');
});

// ─────────────────────────────────────────────── 真探针（不依赖显卡）

test('真探针：跑不到 nvidia-smi / 解析不出来 ⇒ 返回 null（不抛，也不编一个数）', async () => {
  const execError = (cmd, args, opts, cb) => cb(new Error('not found'), '');
  assert.equal(await probeFreeVram({ execFileImpl: execError, timeoutMs: 500 }), null);

  const garbage = (cmd, args, opts, cb) => cb(null, 'N/A\n');
  assert.equal(await probeFreeVram({ execFileImpl: garbage, timeoutMs: 500 }), null);

  const negative = (cmd, args, opts, cb) => cb(null, '-1\n');
  assert.equal(await probeFreeVram({ execFileImpl: negative, timeoutMs: 500 }), null);
});

test('真探针：取**第一行**（多卡时至少是确定的，而不是随机挑一张）', async () => {
  const twoGpus = (cmd, args, opts, cb) => cb(null, '5120\n9000\n');
  const got = await probeFreeVram({ execFileImpl: twoGpus, timeoutMs: 500 });
  assert.deepEqual(got, { freeMiB: 5120, raw: '5120\n9000' });
});

test('真探针：正常一行 ⇒ 解析成整数；带 CRLF 也不影响', async () => {
  const ok = (cmd, args, opts, cb) => cb(null, '6287\r\n');
  assert.deepEqual(await probeFreeVram({ execFileImpl: ok, timeoutMs: 500 }), { freeMiB: 6287, raw: '6287' });
});
