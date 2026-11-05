/**
 * 内容质量过滤的测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isMeaningless } from '../src/dsh/content-filter.mjs';

test('isMeaningless：空/过短 → 过滤', () => {
  assert.equal(isMeaningless(''), true);
  assert.equal(isMeaningless(' '), true);
  assert.equal(isMeaningless('哦'), true);
});

test('isMeaningless：纯数字/符号/表情 → 过滤', () => {
  assert.equal(isMeaningless('12345'), true);
  assert.equal(isMeaningless('！！！'), true);
  assert.equal(isMeaningless('😂😂😂'), true);
});

test('isMeaningless：打卡/签到/运势/文字冒险 → 过滤', () => {
  assert.equal(isMeaningless('打卡'), true);
  assert.equal(isMeaningless('今日签到'), true);
  assert.equal(isMeaningless('运势：大吉'), true);
  assert.equal(isMeaningless('文字冒险开始'), true);
  assert.equal(isMeaningless('今天运势如何'), true);
});

test('isMeaningless：命令前缀 → 过滤', () => {
  assert.equal(isMeaningless('#帮助'), true);
  assert.equal(isMeaningless('/菜单'), true);
});

test('isMeaningless：正常聊天 → 保留', () => {
  assert.equal(isMeaningless('今天写代码写到头大'), false);
  assert.equal(isMeaningless('有没有人用过 NapCat'), false);
  assert.equal(isMeaningless('我觉得这个 bug 是内存泄漏'), false);
});
