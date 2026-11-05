/**
 * 验证 toml 的分层配置能不能被正确读出来。
 *
 * 用户 2026-10-04 要的：
 *   > toml 做成一套通配的规则 + 指定某几个群聊的特殊规则
 *
 * 这个脚本读真实的那份 qq-gugu.toml，打印解析结果 —— 用来确认
 * "通配段"和"覆盖段"都进了该进的地方。
 */
import { loadProactiveConfig } from '../src/index.mjs';
import { dshHome } from '../src/dsh/paths.mjs';

const tomlPath = process.env.QQ_GUGU_TOML ?? path.join(dshHome(), 'profiles', 'desktop', 'qq-gugu.toml');
const { config, overrides } = loadProactiveConfig({ tomlPath });

console.log('toml:', tomlPath);
console.log('');
console.log('=== 通配段 [proactive] ===');
for (const [k, v] of Object.entries(config)) {
  console.log(`  ${k.padEnd(22)} = ${JSON.stringify(v)}`);
}
if (Object.keys(config).length === 0) console.log('  （空）');

console.log('');
console.log('=== 覆盖段 [proactive.groups.*] ===');
for (const [chatId, ov] of Object.entries(overrides)) {
  console.log(`  ${chatId}`);
  for (const [k, v] of Object.entries(ov)) {
    console.log(`      ${k.padEnd(18)} = ${JSON.stringify(v)}`);
  }
}
if (Object.keys(overrides).length === 0) console.log('  （空）');

console.log('');
console.log('=== 关键判断 ===');
const keys = Object.keys(overrides);
console.log(`  覆盖的会话数: ${keys.length}`);
console.log(`  群号有没有被补上 'group:' 前缀: ${keys.every((k) => k.includes(':')) ? '✅ 是' : '★ 否'}`);
console.log(`  30000014 被关掉了吗: ${overrides['group:30000014']?.enabled === false ? '✅ 是' : '★ 否'}`);
console.log(`  burstMinMessages = ${config.burstMinMessages}（用户拍板 2）`);
console.log(`  maxPerHour = ${config.maxPerHour}（用户拍板 60）`);
console.log(`  cooldownAfterBotMs = ${config.cooldownAfterBotMs}（用户拍板 10000）`);
