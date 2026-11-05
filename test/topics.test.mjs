/**
 * 话题状态（M3 影子）的离线测试：归一化、解析、存储上限、抽取提示词与容错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TOPIC_DEFAULTS,
  createTopicStore,
  normalizeTopic,
  parseStore,
  parseTopicsPayload,
} from '../src/dsh/topics.mjs';
import { buildTopicPrompt, createTopicExtractor } from '../src/dsh/topics-extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(HERE, '.tmp-topics-'));
  return { dir, file: path.join(dir, 'qq-topics.json') };
}

test('normalizeTopic：去空白、截断、非法 kind 归 other、缺时间补默认', () => {
  const t = normalizeTopic({ text: '  谁去问一下  复试时间 ', who: '用户', kind: 'x', openedAt: 123 }, { now: 999 });
  assert.equal(t.text, '谁去问一下 复试时间');
  assert.equal(t.kind, 'other');
  assert.equal(t.openedAt, 123);
  assert.equal(t.updatedAt, 123);
  assert.equal(normalizeTopic({ text: '' }), null);
  assert.equal(normalizeTopic({ text: 'a'.repeat(200) }).text.length, TOPIC_DEFAULTS.textMax);
});

test('parseTopicsPayload：围栏、坏 JSON、超上限截断', () => {
  const ok = parseTopicsPayload('```json\n{"open":[{"text":"等她查复试时间","kind":"promise"}]}\n```');
  assert.equal(ok.open.length, 1);
  assert.equal(ok.open[0].text, '等她查复试时间');
  assert.equal(parseTopicsPayload('不是 json'), null);
  assert.equal(parseTopicsPayload('null'), null);
  const many = parseTopicsPayload({ open: [1, 2, 3, 4, 5].map((i) => ({ text: `事项${i}` })) });
  assert.equal(many.open.length, TOPIC_DEFAULTS.maxOpen);
});

test('store：setOpen 整体替换、超过上限截断、空列表即清除', () => {
  const store = createTopicStore({ filePath: '' });
  store.setOpen('group:1', [{ text: 'A' }, { text: 'B' }]);
  assert.equal(store.openOf('group:1').length, 2);
  store.setOpen('group:1', [{ text: 'C' }]);
  assert.deepEqual(store.openOf('group:1').map((t) => t.text), ['C']);
  store.setOpen('group:1', []);
  assert.deepEqual(store.openOf('group:1'), []);
  store.setOpen('group:1', [1, 2, 3, 4].map((i) => ({ text: `X${i}` })));
  assert.equal(store.openOf('group:1').length, TOPIC_DEFAULTS.maxOpen);
});

test('写盘往返：flush 后新实例读得回；坏文件回空库', () => {
  const { dir, file } = tmpFile();
  try {
    const a = createTopicStore({ filePath: file, debounceMs: 0 });
    a.setOpen('group:1', [{ text: '等她查复试时间', kind: 'promise' }]);
    assert.equal(a.flush(), true);
    const b = createTopicStore({ filePath: file });
    assert.equal(b.openOf('group:1')[0].text, '等她查复试时间');
    fs.writeFileSync(file, '坏数据', 'utf8');
    const c = createTopicStore({ filePath: file });
    assert.deepEqual(c.openOf('group:1'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseStore：非数组/坏条目被丢掉', () => {
  const s = parseStore('{"chats":{"g":{"bad":true},"h":[{"text":"ok"}]}}');
  assert.deepEqual(Object.keys(s.chats), ['h']);
});

test('抽取：提示词含旧事项，假 stream 返回 JSON，未配模型时 null', async () => {
  const prompt = buildTopicPrompt({
    messages: [{ nickname: '用户', text: '你帮我查下复试时间', at: Date.UTC(2026, 10, 4, 22) }],
    open: [{ text: '等她查复试时间', who: '用户' }],
  });
  assert.match(prompt, /用户: 你帮我查下复试时间/);
  assert.match(prompt, /等她查复试时间/);
  assert.match(prompt, /JSON/);

  const stream = async function* () {
    yield { type: 'text-delta', text: '{"open":[{"text":"她要查复试时间","who":"用户","kind":"promise"}]}' };
  };
  const ex = createTopicExtractor({ stream, provider: 'p', model: 'm' });
  const out = await ex.extract({ messages: [{ text: '帮我查下复试时间', nickname: '用户' }], open: [] });
  assert.equal(out.open[0].kind, 'promise');

  const off = createTopicExtractor({ stream: null, provider: '', model: '' });
  assert.equal(off.enabled, false);
  assert.equal(await off.extract({ messages: [{ text: 'x' }] }), null);
});

test('抽取：stream 抛错或输出坏 JSON ⇒ null（不抛）', async () => {
  const boom = async function* () {
    throw new Error('超时');
  };
  assert.equal(await createTopicExtractor({ stream: boom, provider: 'p', model: 'm' }).extract({ messages: [{ text: 'x' }] }), null);
  const junk = async function* () {
    yield { type: 'text-delta', text: '不知道' };
  };
  assert.equal(await createTopicExtractor({ stream: junk, provider: 'p', model: 'm' }).extract({ messages: [{ text: 'x' }] }), null);
});
