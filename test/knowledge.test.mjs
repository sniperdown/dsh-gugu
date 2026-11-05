/**
 * 知识库（阶段 1）的测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KnowledgeBase } from '../src/dsh/knowledge.mjs';

const kb = new KnowledgeBase({
  graphNodes: [
    { concept: '设计', memory: '（通用词，长度2，但太通用）' },
    { concept: '奈雪', memory: '群里聊过奈雪的奶茶，大家觉得好喝' },
    { concept: '第五人格', memory: '群里常玩的游戏，有神童角色' },
  ],
  personInfo: [
    { user_id: '10000001', nickname: '用户', memory: '喜欢深夜调试，对小鲸鱼有特别关注' },
    { user_id: '999', nickname: '阿猫', memory: '喜欢猫头鹰' },
  ],
});

test('retrieve：按 userId 检索当前发言人画像', () => {
  const r = kb.retrieve({ text: '随便说点', userId: '10000001' });
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'person');
  assert.equal(r[0].name, '用户');
  assert.ok(r[0].memory.includes('深夜调试'));
});

test('retrieve：按 concept 匹配话题', () => {
  const r = kb.retrieve({ text: '今天喝奈雪了' });
  assert.ok(r.some((x) => x.type === 'concept' && x.name === '奈雪'));
});

test('retrieve：长度 < 2 的概念不匹配（避免通用词）', () => {
  // '设计' 长度 2，但这里构造一个长度 1 的场景
  const kb2 = new KnowledgeBase({
    graphNodes: [{ concept: '猫', memory: 'xx' }],
    personInfo: [],
  });
  const r = kb2.retrieve({ text: '我喜欢猫' });
  assert.equal(r.length, 0, '单字概念不该匹配');
});

test('retrieve：topK 截断', () => {
  const r = kb.retrieve({ text: '奈雪和第五人格都聊过', topK: 1 });
  assert.equal(r.length, 1);
});

test('retrieve：没有匹配返回空', () => {
  const r = kb.retrieve({ text: '今天天气不错' });
  assert.equal(r.length, 0);
});

test('render：渲染成 prompt 片段，空返回空串', () => {
  const r = kb.retrieve({ text: '喝奈雪', topK: 2 });
  const rendered = kb.render(r);
  assert.ok(rendered.includes('奈雪'));
  assert.equal(kb.render([]), '');
});

test('load：从 shared/knowledge.json 加载', () => {
  // ⚠️ 2026-10-05：这个测试原来写的是 `if (!fs.existsSync(path)) return;` ——
  // **文件不在就静默跳过**。后果实测发生过：知识库从 `<maibot>\`
  // 搬到 `shared\` 之后，这个测试**照样显示通过**（10/10 绿），
  // 但它其实一步都没跑。**静默跳过比失败危险得多** —— 失败会有人看，跳过不会。
  //
  // 所以改成：**文件不在就失败**，并且把期望值写死（数量级不对也算失败）。
  //
  // ⚠️ 2026-11-05（开源版）：原来读的是部署机上的 `shared/knowledge.json`
  //   （1000+ 节点、400+ 画像）。公开仓库里没有那份数据 ⇒ 依赖它等于
  //   "只有作者的机器能跑绿"。现在改成**自己造一份最小样本**：
  //   钉的是**加载器**的行为（键名、映射、条数），不是数据量。
  //   要拿真实知识库回归，设 `QQ_KB_PATH` 指过去即可。
  const samplePath = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-kb-'));
    const file = path.join(dir, 'knowledge.json');
    fs.writeFileSync(file, JSON.stringify({
      graph_nodes: [
        { concept: '示例概念', memory: '这是一条示例记忆，长度足够跑通匹配' },
        { concept: '第二个概念', memory: '再来一条，验证数组真被读进来了' },
      ],
      person_info: [
        { user_id: '30000001', nickname: '用户', memory: '[事实] 示例画像' },
      ],
    }), 'utf8');
    return file;
  })();
  const kbPath = process.env.QQ_KB_PATH ?? samplePath;
  assert.ok(fs.existsSync(kbPath), `知识库文件不存在: ${kbPath}`);
  const loaded = KnowledgeBase.load(kbPath, { readFileSync: (p, enc) => fs.readFileSync(p, enc) });
  if (process.env.QQ_KB_PATH === undefined) {
    assert.equal(loaded.graphNodes.length, 2, '样本里写了 2 个概念节点');
    assert.equal(loaded.personInfo.length, 1, '样本里写了 1 条画像');
  } else {
    assert.ok(loaded.graphNodes.length > 0, '真实知识库不应为空');
  }
});

test('remember：追加到已有画像（去重）', () => {
  const kb = new KnowledgeBase({
    personInfo: [{ user_id: '10000001', nickname: '用户', memory: '喜欢深夜调试' }],
  });
  kb.remember('10000001', '在做 QQ 机器人');
  kb.remember('10000001', '在做 QQ 机器人'); // 重复
  const p = kb.personInfo.find((x) => x.user_id === '10000001');
  assert.ok(p.memory.includes('在做 QQ 机器人'));
  // ⚠️ 2026-10-05：`remember` 现在会自动补来源标记（`[事实] ` 前缀），
  // 所以判重不能再用"整串相等"，要看**去掉标记后**出现几次。
  const points = p.memory.split('；').map((s) => s.replace(/^\[(事实|推测)\]\s*/, '').trim());
  assert.equal(points.filter((s) => s === '在做 QQ 机器人').length, 1, '重复事实不重复记');
  assert.equal(points.length, 2, `原有那条 + 新那条 = 2，实际 ${points.length}`);
});

test('remember：不认识的人新建画像', () => {
  const kb = new KnowledgeBase({ personInfo: [] });
  kb.remember('999', '喜欢猫头鹰');
  assert.equal(kb.personInfo.length, 1);
  assert.equal(kb.personInfo[0].user_id, '999');
  // 没标来源 → 自动补 `[事实]`（保守：宁可少标推测，也不把事实降级）
  assert.equal(kb.personInfo[0].memory, '[事实] 喜欢猫头鹰');
});

test('dumpLearned：导出学来的事实（可持久化）', () => {
  const kb = new KnowledgeBase({ personInfo: [] });
  kb.remember('10000001', '在做 QQ 机器人');
  kb.remember('10000001', '喜欢深夜');
  kb.remember('10000001', '在做 QQ 机器人'); // 重复不重复记
  const dumped = kb.dumpLearned();
  assert.equal(dumped.length, 2, '两条不同事实');
  assert.deepEqual(dumped[0], { user_id: '10000001', fact: '[事实] 在做 QQ 机器人' });
});
