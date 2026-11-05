import test from 'node:test';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import {
  applyPersonalitySignal,
  createInitialL1,
  createInitialL2,
  deriveAttachment,
  scoreImpact,
} from '../src/runtime/personality.js';
import type { DaughterConfig, L5State } from '../src/types.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-personality-'));
}

function makeConfig(): DaughterConfig {
  return structuredClone(defaultConfig);
}

function makeL5(pleasure = 0, arousal = 0): L5State {
  return {
    sessionId: 's-1',
    characterId: 'daughter-default',
    emotion: { pleasure, arousal, dominance: 0 },
    stress: 0.2,
    safety: 0.7,
    fatigue: 0.2,
    emotionalOverdraft: 0,
    boundary: 0,
    activeSubPersonaId: 'to_father',
    lastTickAt: '2026-11-05T10:00:00.000Z',
    snapshotAt: '2026-11-05T10:00:00.000Z',
    schemaVersion: 1,
  };
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `EVT-20261105-${String(seq).padStart(6, '0')}`;
}

/* ------------------------------- 出生抽样 ------------------------------- */

test('出生人格：同角色同种子可复现，落在抽样区间内', () => {
  const first = createInitialL1('daughter-default', 42);
  const second = createInitialL1('daughter-default', 42);
  assert.deepEqual(first.bigFive, second.bigFive);

  const other = createInitialL1('another-character', 42);
  assert.notDeepEqual(first.bigFive, other.bigFive, '不同角色应抽到不同起点');

  const ranges = defaultConfig.personality.initial.ranges;
  for (const [key, value] of Object.entries(first.bigFive) as [keyof typeof ranges, number][]) {
    const [min, max] = ranges[key];
    assert.ok(value >= min - 0.01 && value <= max + 0.01, `${key} 超出抽样区间：${value}`);
  }
  assert.deepEqual(first.innate, first.bigFive, '先天锚点应等于出生值');
});

test('出生依恋：只会是安全 / 焦虑 / 回避，混乱型不可出生', () => {
  const seen = new Set<string>();
  for (let index = 0; index < 60; index += 1) {
    const l2 = createInitialL2(`character-${index}`, 42);
    seen.add(String(l2.attachmentType));
    assert.notEqual(l2.attachmentType, 'disorganized');
  }
  assert.ok(seen.has('secure'), '安全型应占多数');
});

/* ------------------------------- 冲击分级 ------------------------------- */

test('冲击分级：日常句子落在 routine，关键语句才能过线', () => {
  const config = makeConfig();
  const plain = scoreImpact('最近状态不好', makeL5(-0.2, 0), {
    cumulative: config.personality.cumulative_threshold,
    critical: config.personality.critical_threshold,
  });
  assert.equal(plain.kind, 'routine');

  const critical = scoreImpact('我们分手吧，我再也不回来了', makeL5(-0.7, 0.6), {
    cumulative: config.personality.cumulative_threshold,
    critical: config.personality.critical_threshold,
  });
  assert.notEqual(critical.kind, 'routine');
  assert.ok(critical.impact >= config.personality.cumulative_threshold);
});

test('日常对话不写人格，关键事件才推进并留证据', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default', 42, undefined, { lock: false });
  const config = makeConfig();
  const now = '2026-11-05T10:00:00.000Z';

  const routine = applyPersonalitySignal(store, config, {
    text: '今天要开会，先忙一下',
    eventId: nextId(),
    l5: makeL5(0, 0),
    now,
  });
  assert.equal(routine.changed, false);

  const before = store.loadPersona().l1.bigFive;
  const critical = applyPersonalitySignal(store, config, {
    text: '我们分手吧，我再也不回来了',
    eventId: nextId(),
    l5: makeL5(-0.7, 0.6),
    now: '2026-11-05T11:00:00.000Z',
  });
  assert.equal(critical.changed, true);
  assert.ok(critical.layers.includes('L1'));

  const after = store.loadPersona();
  assert.notDeepEqual(after.l1.bigFive, before);
  assert.ok((after.l3.evidence?.length ?? 0) > 0, '应留下人格证据');
  assert.ok(after.l3.narrative, '应写入自我叙事');
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------- 漂移上限 ------------------------------- */

test('五维漂移不超过出生锚点 ±drift_cap', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default', 42, undefined, { lock: false });
  const config = makeConfig();
  const anchor = store.loadPersona().l1.innate!;

  for (let index = 0; index < 40; index += 1) {
    applyPersonalitySignal(store, config, {
      text: '你走吧，我再也不回来了，别来找我',
      eventId: nextId(),
      l5: makeL5(-0.9, 0.8),
      now: `2026-11-${String(5 + Math.floor(index / 20)).padStart(2, '0')}T${String(index % 20).padStart(2, '0')}:00:00.000Z`,
    });
  }

  const l1 = store.loadPersona().l1;
  const cap = config.personality.drift_cap;
  for (const key of ['neuroticism', 'extraversion', 'agreeableness'] as const) {
    const drift = l1.bigFive[key] - anchor[key];
    assert.ok(Math.abs(drift) <= cap + 1e-6, `${key} 漂出上限：${drift}`);
    assert.ok(l1.bigFive[key] >= 0 && l1.bigFive[key] <= 1);
  }
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------- 修复不对称 ------------------------------- */

test('修复按依恋类型打折：焦虑型同样的道歉改得更少', () => {
  const root = makeRoot();
  const config = makeConfig();
  const text = '对不起，我一直在，不会走';
  const repair = (type: 'secure' | 'anxious') => {
    const store = new Store(root, `repair-${type}`, 42, undefined, { lock: false });
    const l2 = store.loadPersona().l2;
    store.savePersonaLayer('l2', { ...l2, attachmentAnxiety: 0.6, attachmentAvoidance: 0.3, attachmentType: type });
    applyPersonalitySignal(store, config, { text, eventId: nextId(), l5: makeL5(0.3, 0.1), now: '2026-11-05T10:00:00.000Z' });
    const value = store.loadPersona().l2.attachmentAnxiety;
    store.close();
    return value;
  };

  const secure = repair('secure');
  const anxious = repair('anxious');
  // 焦虑型更难被安慰：同样的道歉，焦虑下降更少（值更高）
  assert.ok(anxious > secure, `焦虑型 ${anxious} 应高于安全型 ${secure}`);
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------- 混乱型演化 ------------------------------- */

test('混乱型只能演化：两轮矛盾经历 + 两维同时偏高才成立', () => {
  const calm = { ...makeL5(0, 0) };
  const base = {
    attachmentAnxiety: 0.6,
    attachmentAvoidance: 0.55,
  } as const;
  assert.notEqual(deriveAttachment({ ...base } as never, false), 'disorganized', '条件不足时不能是混乱型');
  assert.equal(deriveAttachment({ ...base } as never, true), 'disorganized');

  const root = makeRoot();
  const store = new Store(root, 'disorganized', 42, undefined, { lock: false });
  const config = makeConfig();
  store.setMeta('personality_cycles', '2');
  const l2 = store.loadPersona().l2;
  store.savePersonaLayer('l2', { ...l2, ...base, attachmentType: 'anxious' });
  applyPersonalitySignal(store, config, {
    text: '我们分手吧，别来找我',
    eventId: nextId(),
    l5: calm,
    now: '2026-11-05T10:00:00.000Z',
  });
  assert.equal(store.loadPersona().l2.attachmentType, 'disorganized');
  store.close();
  rmSync(root, { recursive: true, force: true });
});
