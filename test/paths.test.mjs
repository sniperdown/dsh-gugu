/**
 * 路径归拢（2026-11-05）的离线测试：目录解析、环境变量优先级、一次性复制迁移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  configDir,
  dshHome,
  mediaDir,
  migrateIfNeeded,
  qqGuguHome,
  resolveStatePath,
  stateDir,
  statePath,
} from '../src/dsh/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function tmpDir() {
  return fs.mkdtempSync(path.join(HERE, '.tmp-paths-'));
}

test('目录解析：DSH_HOME 优先，QQ_GUGU_HOME 再覆盖', () => {
  assert.equal(dshHome({ DSH_HOME: 'H:\\x' }), 'H:\\x');
  const base = qqGuguHome({ DSH_HOME: 'H:\\x' });
  assert.equal(base, path.join('H:\\x', 'qq-gugu'));
  assert.equal(stateDir({ DSH_HOME: 'H:\\x' }), path.join('H:\\x', 'qq-gugu', 'state'));
  assert.equal(mediaDir({ DSH_HOME: 'H:\\x' }), path.join('H:\\x', 'qq-gugu', 'media'));
  assert.equal(configDir({ DSH_HOME: 'H:\\x' }), path.join('H:\\x', 'qq-gugu', 'config'));
  assert.equal(statePath('a.json', { DSH_HOME: 'H:\\x' }), path.join('H:\\x', 'qq-gugu', 'state', 'a.json'));
  const moved = qqGuguHome({ DSH_HOME: 'H:\\x', QQ_GUGU_HOME: 'D:\\g' });
  assert.equal(moved, 'D:\\g');
});

test('migrateIfNeeded：旧文件存在则复制到新位置，且不动旧文件', () => {
  const dir = tmpDir();
  try {
    const oldFile = path.join(dir, 'old', 'relations.json');
    const newFile = path.join(dir, 'new', 'relations.json');
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, '{"a":1}', 'utf8');
    const logs = [];
    const result = migrateIfNeeded({ next: newFile, candidates: [oldFile], log: (l) => logs.push(l) });
    assert.equal(result.path, newFile);
    assert.equal(result.migratedFrom, oldFile);
    assert.equal(fs.readFileSync(newFile, 'utf8'), '{"a":1}');
    assert.equal(fs.existsSync(oldFile), true, '旧文件必须保留');
    assert.ok(logs.includes('info'));
    // 第二次：新文件已存在，不再迁移
    const again = migrateIfNeeded({ next: newFile, candidates: [oldFile], log: () => {} });
    assert.equal(again.migratedFrom, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveStatePath：环境变量优先，且不触发迁移', () => {
  const dir = tmpDir();
  try {
    const oldFile = path.join(dir, 'old.json');
    fs.writeFileSync(oldFile, 'x', 'utf8');
    const override = path.join(dir, 'custom.json');
    const got = resolveStatePath({
      name: 'recall.json',
      envVar: 'QQ_RECALL_PATH',
      legacy: [oldFile],
      env: { DSH_HOME: dir, QQ_RECALL_PATH: override },
      log: () => {},
    });
    assert.equal(got, override);
    assert.equal(fs.existsSync(override), false);
    // 无覆盖时走 state/ 并迁移
    const normal = resolveStatePath({
      name: 'recall.json',
      envVar: 'QQ_RECALL_PATH',
      legacy: [oldFile],
      env: { DSH_HOME: dir },
      log: () => {},
    });
    assert.equal(normal, path.join(dir, 'qq-gugu', 'state', 'recall.json'));
    assert.equal(fs.existsSync(normal), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
