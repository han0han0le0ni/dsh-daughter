import assert from 'node:assert/strict';
import test from 'node:test';
import { recentTopicLabels } from '../src/runtime/maintenance.js';

const now = '2026-11-27T12:00:00.000Z';
const recent = '2026-11-20T12:00:00.000Z';
const old = '2026-09-01T12:00:00.000Z';

function event(tags: string[], createdAt = recent, archived = false) {
  return { tags, createdAt, archived };
}

test('最近常聊：按出现次数排序并截断', () => {
  const labels = recentTopicLabels([
    event(['工作']),
    event(['工作', '猫']),
    event(['猫', '游戏']),
    event(['工作']),
  ], now, 2);
  assert.deepEqual(labels, ['工作', '猫']);
});

test('最近常聊：归档与 30 天外的事件不计入', () => {
  const labels = recentTopicLabels([
    event(['工作']),
    event(['旧事'], old),
    event(['猫'], recent, true),
  ], now);
  assert.deepEqual(labels, ['工作']);
});

test('最近常聊：同次数按名称稳定排序，空标签被忽略', () => {
  const first = recentTopicLabels([event(['乙', '甲', ''])], now);
  const second = recentTopicLabels([event(['甲', '乙'])], now);
  assert.deepEqual(first, ['乙', '甲'].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(first, second, '同样输入顺序不同也给出同样结果');
});
