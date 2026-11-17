import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { defaultConfig, mergeConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { localDayKey } from '../src/runtime/speak.js';
import { readSpeakStats, recordSpeakStats } from '../src/runtime/speak-stats.js';
import type { L5State, SpeakPlan } from '../src/types.js';

const CHAR = 'daughter-default';
const NOW = '2026-11-10T10:00:00.000Z';
const DAY = localDayKey(NOW);

function makeL5(at: string): L5State {
  return {
    sessionId: 's-speak',
    characterId: CHAR,
    emotion: { pleasure: 0.5, arousal: 0.4, dominance: 0.4 },
    stress: 0.2,
    safety: 0.6,
    fatigue: 0.1,
    emotionalOverdraft: 0,
    boundary: 0.5,
    activeSubPersonaId: 'default',
    lastTickAt: at,
    snapshotAt: at,
    schemaVersion: 1,
  };
}

function plan(decision: SpeakPlan['decision'], reason: SpeakPlan['reason']): SpeakPlan {
  return { decision, urge: 0.5, threshold: 0.5, reason, carry: 0.1 };
}

test('DEF-18 统计聚合：act/hold/silent 计数与沉默占比', () => {
  let raw = recordSpeakStats(null, plan('silent', 'bored'), DAY, NOW);
  raw = recordSpeakStats(raw, plan('silent', 'miss'), DAY, NOW);
  raw = recordSpeakStats(raw, plan('hold', 'miss'), DAY, NOW);
  raw = recordSpeakStats(raw, plan('act', 'miss'), DAY, NOW);

  const stats = readSpeakStats(raw, DAY);
  assert.equal(stats.total, 4);
  assert.equal(stats.act, 1);
  assert.equal(stats.hold, 1);
  assert.equal(stats.silent, 2);
  assert.equal(stats.silentRatio, 0.5);
  assert.equal(stats.reasons.miss, 3);

  // 坏数据当没有：统计是旁路，不能反过来影响开口
  assert.equal(readSpeakStats('{not-json', DAY).total, 0);
  assert.equal(readSpeakStats(null, '2026-01-01').silentRatio, 0);
});

test('DEF-18 影子模式：照常评估、只记统计，不写冷却/计数/记忆', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-speak-shadow-'));
  const seeding = new Store(root, CHAR);
  seeding.saveL5(makeL5('2026-11-09T22:00:00.000Z'));
  seeding.setMeta('speak.bootAt', '2026-11-09T20:00:00.000Z');
  seeding.close();

  const config = mergeConfig(defaultConfig, {
    speak: { enabled: false, shadow: true, stats: true, quiet_hours: [] },
    desktop: { enabled: false },
  });
  const plugin = createDaughterPlugin({ pluginRoot: root, config });
  try {
    const result = await plugin.speakPlan({ characterId: CHAR, now: NOW, jitter: 0 });
    assert.ok(result, '影子模式即使 speak 关闭也要评估');
    assert.equal(result.shadow, true);
    assert.equal(result.decision, 'act', '沉默 12 小时应达到开口强度');
  } finally {
    plugin.close();
  }

  const verify = new Store(root, CHAR);
  try {
    assert.equal(verify.getMeta('speak.lastAt'), null, '影子模式不能写冷却锚点');
    assert.equal(verify.getMetaNumber('speak.carry', 0), 0, '影子模式不能搬 carry');
    assert.equal(verify.getMetaNumber(`speak.count.${DAY}`, 0), 0, '影子模式不计入当天开口');
    assert.equal(verify.countEvents().total, 0, '影子模式不能写记忆');
    assert.equal(readSpeakStats(verify.getMeta('speak.stats'), DAY).act, 1, '应记录一次 act 统计');
  } finally {
    verify.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEF-18 正式模式：照常写状态并累计统计', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-speak-live-'));
  const seeding = new Store(root, CHAR);
  seeding.saveL5(makeL5('2026-11-09T22:00:00.000Z'));
  seeding.setMeta('speak.bootAt', '2026-11-09T20:00:00.000Z');
  seeding.setMeta('speak.lastAt', '2026-11-09T22:00:00.000Z');
  seeding.close();

  const config = mergeConfig(defaultConfig, {
    speak: { enabled: true, shadow: false, stats: true, quiet_hours: [] },
    desktop: { enabled: false },
  });
  const plugin = createDaughterPlugin({ pluginRoot: root, config });
  try {
    const result = await plugin.speakPlan({ characterId: CHAR, now: NOW, jitter: 0 });
    assert.ok(result);
    assert.equal(result.shadow, undefined, '正式模式不应带影子标记');
    assert.equal(result.decision, 'act');
  } finally {
    plugin.close();
  }

  const verify = new Store(root, CHAR);
  try {
    assert.equal(verify.getMeta('speak.lastAt'), NOW, '正式开口要更新冷却锚点');
    assert.equal(verify.getMetaNumber(`speak.count.${DAY}`, 0), 1);
    assert.equal(verify.countEvents().total, 1, '正式开口应留下一条低权重自我发言');
    assert.equal(readSpeakStats(verify.getMeta('speak.stats'), DAY).act, 1);
  } finally {
    verify.close();
    rmSync(root, { recursive: true, force: true });
  }
});
