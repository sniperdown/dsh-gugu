/**
 * 校准表生成器：**用真实代码**跑一遍典型场景，把结果打成 Markdown。
 *
 * 为什么需要它：阈值是"判定层"的口径，
 * 但那些分数是算出来的 —— 手算容易错，改完权重也容易忘了同步文档。
 * 这个脚本把「配置合并结果 + 场景表 + 压力曲线」一次性打出来，直接粘进文档。
 *
 * 它顺带回答那个**踩过两次的坑**：`CONFIG_SHAPE.gauge` 的优先级高于
 * `defaultGaugeConfig()`，所以改默认值必须两处一起改 —— 脚本第 ① 段就是
 * 逐键对比 `defaultGaugeConfig()` 与 `resolveConfig()` 的结果。
 *
 * 用法：
 *   node tools/gen-calibration.mjs                # 打到标准输出
 *   node tools/gen-calibration.mjs out.md         # 写文件（推荐：控制台是 GBK，中文会乱）
 */
import { writeFileSync } from 'node:fs';
import { score, defaultGaugeConfig } from '../src/dsh/heuristic-gauge.mjs';
import { resolveConfig } from '../src/index.mjs';

const out = [];
const say = (line = '') => out.push(line);

// ---------------------------------------------------------------- ① 配置真源 vs 合并结果
const bare = resolveConfig({ mode: 'reverse', accessToken: 't' }).gauge;
const defaults = defaultGaugeConfig();
say('## ① CONFIG_SHAPE 有没有顶掉真源');
say('');
say('| 键 | defaultGaugeConfig() | resolveConfig() 之后 | 一致？ |');
say('|---|---|---|---|');
for (const key of Object.keys(defaults)) {
  const a = JSON.stringify(defaults[key]);
  const b = JSON.stringify(bare[key]);
  say(`| ${key} | ${a} | ${b} | ${a === b ? 'OK' : '**不一致**'} |`);
}
say('');
const proactive = resolveConfig({ mode: 'reverse', accessToken: 't' }).proactive;
say(`proactive 里残留的废弃键：${JSON.stringify({
  quietHoursStart: proactive.quietHoursStart,
  burstMinMessages: proactive.burstMinMessages,
})}`);
say('');

// ---------------------------------------------------------------- ② 场景表
const T0 = 1_700_000_000_000;
const msg = (text, i = 0, extra = {}) => ({
  chatId: 'group:1', at: T0 + i * 1000, text, userId: 'u1', nickname: 'u1', kind: 'group', ...extra,
});
const rows = [];

/** 跑一个场景，记下 raw / 乘完倍率 / 结果。 */
function run(label, request, config) {
  const r = score(request, config === undefined ? {} : { config });
  if (r === null) {
    rows.push({ label, raw: '—', score: '—', verdict: '沉默（压根没打分）' });
    return;
  }
  const d = r.detail;
  const raw = d.relevance + d.content + d.pressure + d.repetition - d.penalty;
  rows.push({ label, raw: `${Math.round(raw * 10) / 10}`, score: `${r.score}`, verdict: r.speak ? '✔ 说' : '✘ 不说' });
}

run('@我（单条）', { kind: 'group', recent: [msg('@小鲸鱼 在吗')], mentioned: true });
run('喊我名字（单条）', { kind: 'group', recent: [msg('小鲸鱼这个你怎么看')], nameMentioned: true });
run('技术词 + 问句', { kind: 'group', recent: [msg('这个 API 怎么调')] });
run('求助（一个人一条）', { kind: 'group', recent: [msg('有没有人知道这个报错怎么解决')] });
run('征求意见（单条）', { kind: 'group', recent: [msg('你觉得这个方案好不好')] });
run('问句单条（软性邀约）', { kind: 'group', recent: [msg('今晚一起吃饭吗')] });
run('闲聊单条', { kind: 'group', recent: [msg('今天好累啊')] });
run('闲聊 2 条', { kind: 'group', recent: [msg('今天好累啊', 0), msg('晚上吃什么', 1)] });
run('闲聊 3 条', { kind: 'group', recent: [msg('今天好累啊', 0), msg('晚上吃什么', 1), msg('好困', 2)] });
run('闲聊 4 条', {
  kind: 'group',
  recent: [msg('今天好累啊', 0), msg('晚上吃什么', 1), msg('好困', 2), msg('想睡觉', 3)],
});
run('复读 3 条', { kind: 'group', recent: [msg('确实', 0), msg('确实', 1), msg('确实', 2)] });
run('复读 4 条', { kind: 'group', recent: [msg('确实', 0), msg('确实', 1), msg('确实', 2), msg('确实', 3)] });
run('复读 5 条', { kind: 'group', recent: [0, 1, 2, 3, 4].map((i) => msg('确实', i)) });
run('@别人（单条）', {
  kind: 'group',
  recent: [msg('@30000024 你看看', 0, { mentionsOthers: true })],
});
run('@别人 8 条（攒起来）', {
  kind: 'group',
  recent: Array.from({ length: 8 }, (_, i) => msg(`@30000024 你看看${i}`, i, { mentionsOthers: true })),
});
run('纯短反应（没人找我）', { kind: 'group', recent: [msg('哈哈', 0), msg('666', 1)] });
run('短反应 + @我', { kind: 'group', recent: [msg('可以', 0)], mentioned: true });
run('短反应 + 我刚说过话', { kind: 'group', recent: [msg('可以', 0), msg('不行', 1)], botSpokeRecently: true });
run('命中"别说话"', { kind: 'group', recent: [msg('别说话', 0)], mentioned: true });
run('私聊（问句）', { kind: 'private', recent: [msg('这个怎么弄啊')] });
run('被我刷屏：窗口 8 条我说 5 次', {
  kind: 'group',
  recent: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => msg('这个 API 怎么调', i)),
  selfAt: [T0, T0 + 1000, T0 + 2000, T0 + 3000, T0 + 4000],
});

say(`## ② 场景表（倍率 ${defaults.frequency} / 阈值 ${defaults.threshold}）`);
say('');
say('| 场景 | raw 合计 | ×倍率后 | 结果 |');
say('|---|---|---|---|');
for (const r of rows) say(`| ${r.label} | ${r.raw} | **${r.score}** | ${r.verdict} |`);
say('');

// ---------------------------------------------------------------- ③ 压力曲线逐点
say('## ③ 压力曲线（光压力这一项的分数）');
say('');
const pressureOnly = (n) => {
  // 纯标点（hasContent=false）+ 每条长度不同（不被当复读）+ botSpokeRecently（跳过短反应豁免）
  // → 分数里只剩压力这一项。
  const r = score({
    kind: 'group',
    recent: Array.from({ length: n }, (_, i) => msg('。'.repeat(i + 1), i)),
    botSpokeRecently: true,
  });
  return r === null ? '—' : r.detail.pressure;
};
const ns = [0, 1, 2, 3, 4, 5, 8, 10, 13, 16, 20, 40];
say(`| n（窗口条数） | ${ns.join(' | ')} |`);
say(`|${'---|'.repeat(ns.length + 1)}`);
say(`| pressure | ${ns.map((n) => pressureOnly(n)).join(' | ')} |`);
say('');
say(`threshold = ${defaults.threshold}；frequency = ${defaults.frequency}；`
  + `pressureFloor = ${defaults.pressureFloor}；pressureFull = ${defaults.pressureFull}；`
  + `maxPressure = ${defaults.maxPressure}`);

const target = process.argv[2] ?? '';
if (target === '') {
  process.stdout.write(`${out.join('\n')}\n`);
} else {
  writeFileSync(target, `${out.join('\n')}\n`, 'utf8');
  console.log(`写入 ${target}（${out.length} 行）`);
}
