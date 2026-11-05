/**
 * 用**线上配置**离线重放主动层判定：回答「这份代码到底会不会开口」。
 *
 * 场景：改了 gauge 却看不到冒泡时，第一件事是分清"代码不开口"还是
 * "跑的压根不是这份代码"。这个脚本给的是前者——它直接在单进程里装配
 * `ProactiveEngine` + 真 `judge`，喂进一段对话，把判定日记打出来。
 * 后者由调试快照里的 `staleCode` 回答（见 debug-snapshot.mjs）。
 *
 * 用法：
 *   node tools/replay-proactive.mjs                 # 内置场景（私聊三句 + 群聊闲聊）
 *   node tools/replay-proactive.mjs "消息1" "消息2"  # 自定义私聊内容
 */
import { ProactiveEngine, defaultTriggerConfig } from '../src/proactive/engine.mjs';
import { judge, defaultGaugeConfig, score } from '../src/dsh/heuristic-gauge.mjs';

const gaugeConfig = defaultGaugeConfig();
/**
 * 引擎门槛：直接用真源默认值。
 *
 * ⚠️ 2026-10-07 之前这里还塞了 `burstMinMessages: 3`（照抄线上 patch 的突发门槛）。
 * 那道闸门已经**删除**，键也不再被读取 —— 留着只会让人以为 replay 的结果受它影响。
 * 线上 toml / patch 里可能还有同名的残留键，同样不生效。
 */
const triggerConfig = defaultTriggerConfig();

const spoken = [];
const engine = new ProactiveEngine({
  config: triggerConfig,
  gauge: (request) => judge(request, { config: gaugeConfig }),
  speak: async ({ chatId, text }) => spoken.push({ chatId, text }),
  allowed: () => true,
  log: () => {},
});

const custom = process.argv.slice(2);
const privateLines = custom.length > 0
  ? custom
  : ['测试测试，小鲸鱼在嘛', '话说我在这边说话你核心能看到吗', '我现在躺在沙发上，你有事直接喊我'];
const groupLines = custom.length > 0
  ? []
  : ['今天天气不错', '晚上吃什么', '随便吧', '在吗'];

const T = Date.UTC(2026, 9, 1, 15, 30, 0); // 2026-10-01 23:30（UTC+8）
let seq = 0;
/**
 * 喂一条消息。
 *
 * ⚠️ 2026-10-07 修：这里原来调的是 `engine.ingest(...)` —— 那个方法在
 * "统一判定"重构后就没了，脚本**一直是坏的**（TypeError，跑不起来），
 * 离线重放是调参时的标准手段。
 * 现在改成统一的入口 `engine.decide(...)`（返回值即判定结果）。
 */
const send = (chatId, kind, text, at) =>
  engine.decide({
    chatId, kind, userId: '30000001', nickname: '用户', text, at, mentioned: false, messageId: (seq += 1),
  });

for (const [i, text] of privateLines.entries()) {
  await send('private:10001', 'private', text, T + i * 120_000);
}
for (const [i, text] of groupLines.entries()) {
  await send('group:20001', 'group', text, T + i * 30_000);
}

console.log(`阈值 ${gaugeConfig.threshold}（频率倍率 ${gaugeConfig.frequency}）`);
console.log('\n判定日记：');
for (const entry of engine.journal) console.log('  ', JSON.stringify(entry));
console.log('\n主动发言：', JSON.stringify(spoken));

// 单独把"群里那几句"的分打出来，便于调权重。
if (groupLines.length > 0) {
  const recent = groupLines.map((text, i) => ({
    text, userId: '2001', fromSelf: false, at: T + i * 30_000,
  }));
  console.log('\n群聊窗口打分：', JSON.stringify(score({ kind: 'group', recent }, { config: gaugeConfig })));
}
