import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventRecord } from '../src/types.js';
import { defaultConfig, mergeConfig } from '../src/config.js';
import { retentionOf } from '../src/runtime/memory.js';

const NOW = '2026-11-25T12:00:00.000Z';

function daysAgo(days: number): string {
  return new Date(new Date(NOW).getTime() - days * 86_400_000).toISOString();
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'EVT-20260101-test',
    characterId: 'daughter-default',
    title: '项目进度',
    summary: '项目进度正常',
    tags: ['工作'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0, arousal: 0, dominance: 0, intensity: 0.2 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: 'chat',
    createdAt: NOW,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return mergeConfig(structuredClone(defaultConfig), overrides);
}

test('遗忘曲线：同样 120 天间隔，保留率比旧半衰期明显更高', () => {
  const conf = config();
  const event = makeEvent({ createdAt: daysAgo(120), weight: 0 });
  const retention = retentionOf(event, NOW, conf);
  const legacy = 0.5 ** (120 / conf.retrieval.half_life_days);

  // e^-1 ≈ 0.368
  assert.ok(Math.abs(retention - 0.368) < 0.01, `实际 ${retention}`);
  assert.ok(retention > legacy * 5, `新 ${retention} 应远高于旧 ${legacy}`);
});

test('情绪影响：唤醒越高，同一时刻记得越牢', () => {
  const conf = config();
  const calm = retentionOf(makeEvent({ createdAt: daysAgo(180) }), NOW, conf);
  const intense = retentionOf(
    makeEvent({
      createdAt: daysAgo(180),
      emotionAtTime: { pleasure: -0.8, arousal: 0.9, dominance: 0, intensity: 0.9 },
    }),
    NOW,
    conf,
  );

  assert.ok(intense > calm, `激动 ${intense} 应高于平静 ${calm}`);
});

test('重要度影响：分量越重衰减越慢', () => {
  const conf = config();
  const light = retentionOf(makeEvent({ createdAt: daysAgo(200), weight: 0.1 }), NOW, conf);
  const heavy = retentionOf(makeEvent({ createdAt: daysAgo(200), weight: 0.9 }), NOW, conf);

  assert.ok(heavy > light, `重 ${heavy} 应高于轻 ${light}`);
});

test('关闭遗忘曲线时退回旧半衰期算法', () => {
  const conf = config({ retrieval: { forgetting: { enabled: false } } });
  const event = makeEvent({ createdAt: daysAgo(30) });
  const expected = 0.5 ** (30 / conf.retrieval.half_life_days);

  assert.ok(Math.abs(retentionOf(event, NOW, conf) - expected) < 1e-12);
});

test('边界：刚发生保留约 1，未来时间不越界，久远不出现负数', () => {
  const conf = config();
  assert.equal(retentionOf(makeEvent({ createdAt: NOW }), NOW, conf), 1);
  assert.equal(retentionOf(makeEvent({ createdAt: daysAgo(-3) }), NOW, conf), 1);

  const ancient = retentionOf(makeEvent({ createdAt: daysAgo(5000) }), NOW, conf);
  assert.ok(ancient >= 0 && ancient < 1e-6, `实际 ${ancient}`);
});

test('配置归一化：稳定度与放大系数都被夹到合法区间', () => {
  const tiny = config({ retrieval: { forgetting: { base_stability_days: 0, arousal_gain: -1, weight_gain: 99 } } });
  assert.equal(tiny.retrieval.forgetting.base_stability_days, 1);
  assert.equal(tiny.retrieval.forgetting.arousal_gain, 0);
  assert.equal(tiny.retrieval.forgetting.weight_gain, 5);

  const huge = config({ retrieval: { forgetting: { base_stability_days: 99999 } } });
  assert.equal(huge.retrieval.forgetting.base_stability_days, 3650);
});
