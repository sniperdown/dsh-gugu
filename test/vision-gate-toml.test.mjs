/**
 * `[vision_gate]` 的 toml 装载测试（`index.mjs` 的 `loadVisionGate`）。
 *
 * ## 为什么这一节要单独测
 *
 * 这一节在**用户手改的 toml** 里，而它的坏法**全是静默的**：
 *
 * - 段名写错（`[vision-gate]` / `[visionGate]`）⇒ 门控整个关闭，表现为"永远走云"；
 * - `localProvider` 拼错 ⇒ 门控开着但**没有本地路** ⇒ 也永远走云；
 * - 阈值写成 `7000000`（把 MiB 当字节）⇒ 夹到上界 ⇒ **也永远走云**。
 *
 * 三种现象**一模一样**（都只是"走了云"），而日志里如果不多说一句就没人查得出来。
 * ⇒ 所以这里既钉"读对了"，也钉"没配/读不到时**说了什么**"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginModule = await import('../src/index.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 写一份临时 toml（只含被测的段），返回路径。
 *
 * ⚠️ **刻意不用 `os.tmpdir()`**：本机的 DSH 文件沙箱把
 * `%LOCALAPPDATA%\Temp` 挡在外面，`mkdtempSync` 会直接 **EPERM** ——
 * 那会让这组测试**在本机永远是红的**（而且看起来像"代码坏了"）。
 * 工作区内的路径不受这个限制，所以落在这里，跑完自己删。
 */
function tempToml(body) {
  const dir = fs.mkdtempSync(path.join(HERE, '.tmp-vision-gate-'));
  const file = path.join(dir, 'qq-gugu.toml');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/** 收尾：删掉这一轮建出来的临时目录（测试失败也不留垃圾）。 */
process.on('exit', () => {
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (name.startsWith('.tmp-vision-gate-')) {
        fs.rmSync(path.join(HERE, name), { recursive: true, force: true });
      }
    }
  } catch { /* 收尾失败不该影响测试结果 */ }
});

const FULL = [
  '[vision_gate]',
  'freeMiB = 7168',
  'cacheMs = 3000',
  '',
  '[vision_gate.cloud]',
  'provider = "p-vision-test"',
  'model = "vision-test-model"',
  '',
  '[vision_gate.local]',
  'provider = "local-llamacpp"',
  'model = "qwen3.5-4b-q4km-vision"',
  '',
].join('\n');

test('★ 完整的一节：阈值 + 缓存 + 两条路的名字都读到了', () => {
  const gate = pluginModule.loadVisionGate({ tomlPath: tempToml(FULL) }, () => {});
  assert.equal(gate.freeMiB, 7168);
  assert.equal(gate.cacheMs, 3000);
  assert.equal(gate.cloud.provider, 'p-vision-test');
  assert.equal(gate.cloud.model, 'vision-test-model');
  assert.equal(gate.local.provider, 'local-llamacpp');
  assert.equal(gate.local.model, 'qwen3.5-4b-q4km-vision');
});

test('★ 缺字段 ⇒ 按字段补默认（不是整节丢掉）', () => {
  const gate = pluginModule.loadVisionGate({
    tomlPath: tempToml('[vision_gate]\n[vision_gate.local]\nprovider = "local-llamacpp"\n'),
  }, () => {});
  assert.equal(gate.freeMiB, 7168, '阈值默认就是用户说的 7g');
  assert.equal(gate.cacheMs, 5000);
  assert.equal(gate.probeTimeoutMs, 5000);
  assert.equal(gate.local.provider, 'local-llamacpp');
  assert.equal(gate.local.model, '', '本地 model 没写就是空（调用方要能看出来）');
  assert.equal(gate.cloud.provider, 'your-provider', '云那半没写就用代码里的占位默认（必须自己配）');
  assert.equal(gate.enableThinking, false, '没写就关着 —— 加这个键之前的行为一个字节不变');
});

// ───────────────────────────── enableThinking（图片描述那条路，2026-11-06）
//
// ⚠️ 它和 `[sticker_gate] enableThinking` 是**两个键**：那个管「认」（表情包审核），
// 这个管「转发里那张图配一句话」。两个都默认 false，谁也别替谁决定。

test('★ [vision_gate] enableThinking 从 toml 读进来（true / false 都认）', () => {
  const on = pluginModule.loadVisionGate({
    tomlPath: tempToml('[vision_gate]\nenableThinking = true\n'),
  }, () => {});
  assert.equal(on.enableThinking, true, '显式打开要能读到（否则这个开关等于不存在）');

  const off = pluginModule.loadVisionGate({
    tomlPath: tempToml('[vision_gate]\nenableThinking = false\n'),
  }, () => {});
  assert.equal(off.enableThinking, false);
});

test('★ [vision_gate] enableThinking 不是布尔值 ⇒ 回退 false 并**打一条 warn**（夹了必须吭声）', () => {
  const logs = [];
  const gate = pluginModule.loadVisionGate({
    tomlPath: tempToml('[vision_gate]\nenableThinking = "true"\n'),
  }, (level, message, meta) => logs.push({ level, message, meta }));
  assert.equal(gate.enableThinking, false, '字符串 true 不认（免得方向猜反）');
  const warned = logs.find((l) => l.level === 'warn' && String(l.message).includes('enableThinking'));
  assert.ok(warned, '回退了却没留痕 = "配置写了却不生效"那一族坑，必须有一条 warn');
  assert.equal(warned.meta.wrote, 'true');
  assert.equal(warned.meta.using, false);
});

test('★ 没有 [vision_gate] 这一节 ⇒ 返回 null（门控关闭），并留一条 info 说明"恒走云"', () => {
  const logs = [];
  const gate = pluginModule.loadVisionGate({ tomlPath: tempToml('[proactive]\nmaxPerHour = 5\n') },
    (level, message, meta) => logs.push({ level, message, meta }));
  assert.equal(gate, null);
  const line = logs.find((l) => l.message.includes('vision_gate'));
  assert.ok(line, '必须留一条日志：静默关闭是最难查的一种');
  assert.equal(line.level, 'info');
  assert.match(line.message, /恒走云/);
});

test('★ toml 文件不存在 ⇒ 返回 null 并打 warn（不是崩、也不是静默）', () => {
  const logs = [];
  const gate = pluginModule.loadVisionGate({ tomlPath: 'H:\\nope\\nope-vision.toml' },
    (level, message) => logs.push({ level, message }));
  assert.equal(gate, null);
  assert.equal(logs[0].level, 'warn');
});

test('★ 越界的阈值被夹到边界，而且**逐个打 warn**（夹了却不吭声是最贵的坑）', () => {
  const logs = [];
  const gate = pluginModule.loadVisionGate({
    tomlPath: tempToml([
      '[vision_gate]',
      'freeMiB = 7000000',   // 把 MiB 写成字节的那种错
      'cacheMs = 99999999',
      'probeTimeoutMs = 1',
      '',
    ].join('\n')),
  }, (level, message, meta) => logs.push({ level, message, meta }));
  assert.equal(gate.freeMiB, 64 * 1024);
  assert.equal(gate.cacheMs, 600_000);
  assert.equal(gate.probeTimeoutMs, 200);
  const warned = logs.filter((l) => l.level === 'warn');
  assert.equal(warned.length, 3, '三个越界字段各一条 warn');
  const aboutThreshold = warned.find((l) => l.message.includes('freeMiB'));
  assert.equal(aboutThreshold.meta.wrote, 7_000_000);
  assert.equal(aboutThreshold.meta.using, 64 * 1024);
});

test('★ 段名写错（vision-gate）⇒ 门控关闭 —— 这正是要"说了什么"的那种静默失效', () => {
  const logs = [];
  const gate = pluginModule.loadVisionGate({ tomlPath: tempToml('[vision-gate]\nfreeMiB = 100\n') },
    (level, message) => logs.push({ level, message }));
  assert.equal(gate, null, '段名一个字符都不能错');
  assert.equal(logs.some((l) => l.message.includes('[vision_gate]')), true);
});

test('★ 嵌套段写全了但本地 provider 是空串 ⇒ 读出来就是空串（门控会因此恒走云，并打 warn）', () => {
  const logs = [];
  const gate = pluginModule.loadVisionGate({
    tomlPath: tempToml([
      '[vision_gate]',
      'freeMiB = 7168',
      '[vision_gate.local]',
      'provider = ""',
      'model = ""',
      '',
    ].join('\n')),
  }, (level, message) => logs.push({ level, message }));
  assert.notEqual(gate, null, '这一节**存在**，所以不是 null（只是没有本地路）');
  assert.equal(gate.local.provider, '');
  assert.equal(gate.freeMiB, 7168);
});
