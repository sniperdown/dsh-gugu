// 量一下"一个人的记忆"实际会占多少上下文。
//
// 起因：用户问「对于一个特定对象，记忆是有文本上限的对吗？」
// 然后拍板：「**导出如果每次都把对象所有的记忆全导出有点蠢了**」→ 改了 retrieve。
//
// 这个脚本对比**改之前**（整串）和**改之后**（按相关度挑 + 封顶）的差距。

import fs from 'node:fs';
import { KnowledgeBase } from '../src/dsh/knowledge.mjs';

const kb = KnowledgeBase.load(
  '<workspace>/shared/knowledge.json',
  { readFileSync: (p, e) => fs.readFileSync(p, e) },
);

const toTok = (n) => Math.round(n / 1.5);

const sorted = kb.personInfo
  .slice()
  .sort((a, b) => String(b.memory ?? '').length - String(a.memory ?? '').length);

console.log('== 前 8 长的画像：改之前 vs 改之后 ==');
console.log('  名字              整串字符  整串token   挑完后   挑完token   条数');
let beforeSum = 0;
let afterSum = 0;
for (const p of sorted.slice(0, 8)) {
  const mem = String(p.memory ?? '');
  const n = mem.split('；').filter((s) => s.trim() !== '').length;
  // 用一个"和记忆无关"的普通话题来量最坏情况（挑不出相关的）
  const picked = kb.retrieve({ text: '在吗，今天天气不错', userId: p.user_id, topK: 1 })
    .find((x) => x.type === 'person');
  const pl = picked ? picked.memory.length : 0;
  beforeSum += mem.length;
  afterSum += pl;
  console.log(
    `  ${(p.nickname || p.user_id).padEnd(16)} ${String(mem.length).padStart(8)} ${String(toTok(mem.length)).padStart(10)} ${String(pl).padStart(8)} ${String(toTok(pl)).padStart(11)} ${String(n).padStart(6)}`,
  );
}
console.log('');
console.log(`  这 8 个人合计: ${beforeSum} → ${afterSum} 字符（省 ${Math.round((1 - afterSum / beforeSum) * 100)}%）`);

console.log('');
console.log('== 你自己（30000001）==');
const me = kb.personInfo.find((p) => p.user_id === '30000001');
if (me) {
  const whole = String(me.memory).length;
  for (const q of ['在吗', '我的 QQ 机器人坏了', '第五人格好玩吗']) {
    const got = kb.retrieve({ text: q, userId: '30000001', topK: 1 }).find((x) => x.type === 'person');
    const l = got ? got.memory.length : 0;
    console.log(`  问「${q}」 → 给 ${l} 字（约 ${toTok(l)} token）   [整串原本是 ${whole} 字 / ${toTok(whole)} token]`);
  }
}

console.log('');
console.log('== 参数 ==');
console.log('  默认 maxPersonChars = 1200（约 800 token）');
console.log('  默认 minPoints = 3（保证至少认识这个人）');
console.log('  改法: kb.retrieve({ text, userId, maxPersonChars: N })');
