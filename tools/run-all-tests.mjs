/**
 * 在**单个进程**里跑完全部测试。
 *
 * 为什么需要它：`node --test test/a.mjs test/b.mjs …`（即 `npm run test:isolated`）
 * 会为每个文件 spawn 一个子进程，而受限沙箱里子进程的管道会撞
 * `spawn EPERM`——整套测试直接变红，看起来像代码坏了。
 * 好在这些测试文件本身不 spawn 任何东西（纯内存 + 本机 socket），
 * 所以串行 `import` 它们与逐个跑等价，只是共用了一个进程。
 *
 * 用法：
 *   node tools/run-all-tests.mjs              # 全部
 *   node tools/run-all-tests.mjs engine gauge # 只跑文件名含这些关键字的
 *
 * 注意：共同一个进程意味着**模块级状态是共享的**。目前每个测试文件都自成一体，
 * 所以安全；将来若出现"跨文件互相影响"的测试，就得回到 `npm run test:isolated`
 * （逐文件独立进程，非沙箱环境）。
 *
 * ⚠️ **2026-10-07 起 `npm test` 就是本脚本**（以前它叫 `test:sandbox`，
 * 而 `test` 是一份手写枚举的文件清单 —— 那份清单漏了 16 个既有测试文件，
 * 于是跑 `npm test` 的人会"以为全过了"）。它自己扫目录，所以**不会再漏**。
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.resolve(here, '..', 'test');
const filters = process.argv.slice(2);

const all = (await readdir(testDir)).filter((f) => f.endsWith('.test.mjs')).sort();
const picked = filters.length === 0 ? all : all.filter((f) => filters.some((k) => f.includes(k)));

if (picked.length === 0) {
  console.error(`没有匹配的测试文件（过滤词：${filters.join(', ')}）`);
  process.exit(1);
}

console.error(`单进程运行 ${picked.length}/${all.length} 个测试文件`);
for (const file of picked) {
  await import(pathToFileURL(path.join(testDir, file)).href);
}
