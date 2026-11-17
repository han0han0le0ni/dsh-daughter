import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SETTINGS_FIELDS,
  coerceSetting,
  deletePath,
  getPath,
  setPath,
  settingField,
  settingsSnapshot,
} from '../src/runtime/settings-ui.js';

test('设置字段表唯一且覆盖两组典型开关', () => {
  const paths = SETTINGS_FIELDS.map((field) => field.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.length >= 30);
  assert.ok(paths.includes('speak.enabled'));
  assert.ok(paths.includes('budget.max_total_tokens'));
  assert.equal(settingField('speak.enabled')?.type, 'boolean');
  assert.equal(settingField('不存在'), undefined);
});

test('嵌套路径可读、可写、可删除', () => {
  const target: Record<string, unknown> = { speak: { enabled: false } };
  assert.equal(getPath(target, 'speak.enabled'), false);
  setPath(target, 'speak.enabled', true);
  assert.equal(getPath(target, 'speak.enabled'), true);
  deletePath(target, 'speak.enabled');
  assert.equal(getPath(target, 'speak.enabled'), undefined);
  setPath(target, '顶层项', 1);
  assert.equal(getPath(target, '顶层项'), 1);
  deletePath(target, '顶层项');
  assert.equal(getPath(target, '顶层项'), undefined);
});

test('数值设置夹在范围内，非法值拒绝', () => {
  const topK = settingField('retrieval.top_k')!;
  assert.equal(coerceSetting(topK, '8'), 8);
  assert.equal(coerceSetting(topK, 999), 20);
  assert.equal(coerceSetting(topK, -1), 1);
  assert.equal(coerceSetting(topK, 'abc'), undefined);

  const speak = settingField('speak.enabled')!;
  assert.equal(coerceSetting(speak, 'true'), true);
  assert.equal(coerceSetting(speak, false), false);
  assert.equal(coerceSetting(speak, 'yes'), undefined);
});

test('设置快照以覆盖值优先并标注来源', () => {
  const config = { retrieval: { top_k: 5, min_score: 0.12 } };
  const snapshot = settingsSnapshot(config, { retrieval: { top_k: 9 } });
  const topK = snapshot.find((field) => field.path === 'retrieval.top_k')!;
  const minScore = snapshot.find((field) => field.path === 'retrieval.min_score')!;
  assert.equal(topK.value, 9);
  assert.equal(topK.overridden, true);
  assert.equal(minScore.value, 0.12);
  assert.equal(minScore.overridden, false);
});
