/**
 * 聊天回想（M1）的离线测试：存储、字面召回、压缩解析。
 * 模型调用用假 stream（异步生成器），不联网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RECALL_DEFAULTS,
  createRecallStore,
  formatRecall,
  grams,
  overlapScore,
  parseRecallPayload,
} from '../src/dsh/recall.mjs';
import { buildCompressPrompt, createRecallCompressor } from '../src/dsh/recall-compress.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(HERE, '.tmp-recall-'));
  return { dir, file: path.join(dir, 'qq-recall.json') };
}

test('grams / overlapScore：字面重合的基本性质', () => {
  assert.deepEqual([...grams('ab')].sort(), ['ab']);
  assert.ok(grams('考研').size >= 1);
  assert.equal(overlapScore('', '任何'), 0);
  assert.equal(overlapScore('考研', '考研'), 1);
  assert.ok(overlapScore('考研复试', '考研') > 0);
  assert.equal(overlapScore('完全无关', '考研'), 0);
});

test('parseRecallPayload：容忍围栏/坏 JSON/空结果', () => {
  assert.deepEqual(parseRecallPayload('```json\n{"summary":"聊了考研","cues":["考研","择校"]}\n```'), {
    summary: '聊了考研',
    cues: ['考研', '择校'],
  });
  assert.equal(parseRecallPayload('不是 json'), null);
  assert.equal(parseRecallPayload('null'), null);
  assert.equal(parseRecallPayload('{"summary":"","cues":[]}'), null);
  assert.deepEqual(parseRecallPayload({ summary: 'x', cues: ['a', 'b', 'c', 'd', 'e', 'f'] }).cues.length, 5);
});

test('store：add / recent 上限 / 召回命中与未命中', () => {
  const store = createRecallStore({ filePath: '' });
  const first = store.add({
    chatId: 'group:1',
    summary: '聊了考研择校，他说想考计算机',
    cues: ['考研', '择校'],
  });
  assert.ok(first !== null, 'add 应返回条目');
  const hit = store.recall({ chatId: 'group:1', text: '你考研准备得怎么样了' });
  assert.ok(hit !== null, '应该命中');
  assert.match(hit.summary, /考研/);
  assert.ok(hit.hits >= 1);
  assert.equal(store.recall({ chatId: 'group:1', text: '今晚吃什么' }), null);
  for (let i = 0; i < RECALL_DEFAULTS.maxEntries + 5; i++) {
    store.add({ chatId: 'group:1', summary: `第 ${i} 段`, cues: ['x'] });
  }
  assert.equal(store.recent('group:1').length, RECALL_DEFAULTS.maxEntries);
});

test('store：3 天前的回想降权（同分时新的优先）', () => {
  const old = Date.UTC(2026, 9, 1);
  const fresh = Date.UTC(2026, 10, 3);
  const store = createRecallStore({ filePath: '', now: () => Date.UTC(2026, 10, 4) });
  store.add({ chatId: 'group:1', summary: '考研的事聊过', cues: ['考研'], at: old });
  store.add({ chatId: 'group:1', summary: '考研的事又聊了', cues: ['考研'], at: fresh });
  const hit = store.recall({ chatId: 'group:1', text: '考研' });
  assert.match(hit.summary, /又聊了/);
});

test('formatRecall：群 150 / 私聊 300 的截断', () => {
  const entry = { summary: '啊'.repeat(300), cues: ['甲', '乙', '丙'] };
  const g = formatRecall(entry, { maxChars: RECALL_DEFAULTS.injectChars.group });
  const p = formatRecall(entry, { maxChars: RECALL_DEFAULTS.injectChars.private });
  assert.ok(g.length <= 151, `群超了：${g.length}`);
  assert.ok(p.length <= 301, `私聊超了：${p.length}`);
  assert.match(g, /^【之前聊过】/);
});

test('写盘往返：flush 后新实例读得回', () => {
  const { dir, file } = tmpFile();
  try {
    const a = createRecallStore({ filePath: file, debounceMs: 0 });
    a.add({ chatId: 'group:1', summary: '聊了搬家', cues: ['搬家'] });
    assert.equal(a.flush(), true);
    const b = createRecallStore({ filePath: file });
    assert.equal(b.recent('group:1').length, 1);
    assert.equal(b.recent('group:1')[0].summary, '聊了搬家');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('压缩：提示词含消息，假 stream 返回 JSON 能解析', async () => {
  const prompt = buildCompressPrompt([
    { nickname: '用户', text: '我下周要去复试了', at: Date.UTC(2026, 10, 3, 20, 30) },
    { nickname: '小鲸鱼', text: '那你要准备英语吧', at: Date.UTC(2026, 10, 3, 20, 31) },
  ]);
  assert.match(prompt, /用户: 我下周要去复试了/);
  assert.match(prompt, /JSON/);

  const fakeStream = async function* () {
    yield { type: 'text-delta', text: '{"summary":"聊了复试准备","cues":["复试","英语"]}' };
  };
  const c = createRecallCompressor({ stream: fakeStream, provider: 'p', model: 'm' });
  assert.equal(c.enabled, true);
  const out = await c.compress([{ nickname: '用户', text: '我下周要去复试了' }]);
  assert.deepEqual(out, { summary: '聊了复试准备', cues: ['复试', '英语'] });
});

test('压缩：没配模型 / stream 抛错 / 输出不是 JSON ⇒ null（不抛）', async () => {
  assert.equal(createRecallCompressor({ stream: null, provider: '', model: '' }).enabled, false);
  const boom = async function* () {
    throw new Error('网络挂了');
  };
  const c1 = createRecallCompressor({ stream: boom, provider: 'p', model: 'm' });
  assert.equal(await c1.compress([{ text: 'x' }]), null);
  const garbage = async function* () {
    yield { type: 'text-delta', text: '我不知道' };
  };
  const c2 = createRecallCompressor({ stream: garbage, provider: 'p', model: 'm' });
  assert.equal(await c2.compress([{ text: 'x' }]), null);
});
