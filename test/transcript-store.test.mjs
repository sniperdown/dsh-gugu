/**
 * 转录落盘（M1b）的离线测试：存什么、丢什么、重启后能不能灌回去。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TRANSCRIPT_DEFAULTS,
  createTranscriptStore,
  parseStore,
  slimEntry,
} from '../src/dsh/transcript-store.mjs';
import { ProactiveEngine, defaultTriggerConfig } from '../src/proactive/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(HERE, '.tmp-transcript-'));
  return { dir, file: path.join(dir, 'qq-transcripts.json') };
}

test('slimEntry：只留重建上下文要的字段，坏条目丢', () => {
  const m = slimEntry({ messageId: 7, chatId: 'group:1', userId: '9', nickname: '用户', text: '在吗', at: 1000, fromSelf: false, kind: 'group', extra: 'x' });
  assert.deepEqual(m, { messageId: 7, chatId: 'group:1', userId: '9', nickname: '用户', text: '在吗', at: 1000, fromSelf: false, kind: 'group' });
  assert.equal(slimEntry({ text: '', at: 1 }), null);
  assert.equal(slimEntry({ text: 'x', at: 0 }), null);
  assert.equal(slimEntry(null), null);
});

test('parseStore：坏 JSON / 非对象 / 缺字段一律回空库', () => {
  assert.deepEqual(parseStore('nope'), { version: 1, chats: {} });
  assert.deepEqual(parseStore('{"chats":[]}'), { version: 1, chats: {} });
  const good = parseStore('{"chats":{"g":[{"text":"x","at":1}]}}');
  assert.equal(good.chats.g.length, 1);
});

test('replaceAll：每会话截到上限、会话数封顶、淘汰最旧会话', () => {
  const store = createTranscriptStore({ filePath: '', maxPerChat: 3, maxChats: 2 });
  const make = (n, base) => Array.from({ length: n }, (_, i) => ({ chatId: 'c', text: `t${i}`, at: base + i }));
  store.replaceAll({ a: make(10, 100), b: make(1, 200), c: make(1, 300) });
  const json = store.toJSON();
  assert.deepEqual(Object.keys(json.chats).sort(), ['b', 'c']);
  assert.equal(json.chats.c.length, 1);
});

test('写盘往返：flush 后新实例读得回', () => {
  const { dir, file } = tmpFile();
  try {
    const a = createTranscriptStore({ filePath: file, debounceMs: 0 });
    a.replaceAll({ 'group:1': [{ chatId: 'group:1', text: '在吗', at: 1000, userId: '9', kind: 'group' }] });
    assert.equal(a.flush(), true);
    const b = createTranscriptStore({ filePath: file });
    assert.equal(b.load()['group:1'].length, 1);
    assert.equal(b.load()['group:1'][0].text, '在吗');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('引擎：exportTranscripts 与 restoreTranscript 往返（乱序会被排好）', () => {
  const engine = new ProactiveEngine({
    config: { ...defaultTriggerConfig(), enabled: true, minIntervalMs: 0, afterUserMsgCount: 0, cooldownAfterBotMs: 0 },
    names: ['小鲸鱼'],
    allowed: () => true,
    gauge: () => ({ text: '在' }),
    speak: async () => true,
    log: () => {},
    now: () => 10_000,
  });
  const restored = engine.restoreTranscript('group:1', [
    { chatId: 'group:1', userId: '9', nickname: '用户', text: '第二条', at: 2000, kind: 'group' },
    { chatId: 'group:1', userId: '9', nickname: '用户', text: '第一条', at: 1000, kind: 'group' },
  ]);
  assert.equal(restored, 2);
  const exported = engine.exportTranscripts();
  assert.equal(exported['group:1'].length, 2);
  assert.deepEqual(exported['group:1'].map((m) => m.text), ['第一条', '第二条']);
});

test('引擎：restore 跳过坏条目，不抛', () => {
  const engine = new ProactiveEngine({
    config: { ...defaultTriggerConfig(), enabled: true, minIntervalMs: 0, afterUserMsgCount: 0, cooldownAfterBotMs: 0 },
    names: ['小鲸鱼'],
    allowed: () => true,
    gauge: () => ({ text: '在' }),
    speak: async () => true,
    log: () => {},
    now: () => 10_000,
  });
  assert.equal(engine.restoreTranscript('group:1', [null, { text: 'x', at: 0 }, { text: '', at: 5 }]), 0);
  assert.equal(engine.restoreTranscript('', [{ text: 'x', at: 5 }]), 0);
});
