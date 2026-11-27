import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import {
  applyBigFiveSetup,
  applyPersonalitySignal,
  createInitialL1,
  createInitialL2,
  rerollInitialPersonality,
} from '../src/runtime/personality.js';
import { applyPersonaDrift } from '../src/runtime/maintenance.js';
import {
  loadPersonalityControl,
  savePersonalityControl,
} from '../src/runtime/personality-control.js';
import type { DaughterConfig, L5State } from '../src/types.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-personality-setup-'));
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
    lastTickAt: '2026-11-27T10:00:00.000Z',
    snapshotAt: '2026-11-27T10:00:00.000Z',
    schemaVersion: 1,
  };
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `EVT-20261127-${String(seq).padStart(6, '0')}`;
}

test('控制文件：非法锁定键被丢弃，种子取整，保存后可读回', () => {
  const root = makeRoot();
  try {
    const saved = savePersonalityControl(root, { locked: ['openness', 'bogus', 'openness'], seed: 12.9 });
    assert.deepEqual(saved, { locked: ['openness'], seed: 12 });
    assert.deepEqual(loadPersonalityControl(root), saved);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('五维锁定：锁住的维度不动，没锁的维度照常演化', () => {
  const root = makeRoot();
  const store = new Store(root, 'lock-test', 9, undefined, { lock: false });
  try {
    const config = makeConfig();
    const before = store.loadPersona().l1.bigFive;
    const result = applyPersonalitySignal(store, config, {
      text: '下个月我要搬去上海工作了',
      eventId: nextId(),
      l5: makeL5(0.1, 0.2),
      now: '2026-11-27T10:00:00.000Z',
    }, { locked: ['openness'], seed: null });
    const after = store.loadPersona().l1.bigFive;
    assert.equal(result.changed, true, '生活转折本应推动其它维度');
    assert.equal(after.openness, before.openness, '锁定的开放性不能变');
    assert.notEqual(after.conscientiousness, before.conscientiousness, '未锁的尽责性应随生活转折移动');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('依恋锁定：关系事件不再移动依恋两维', () => {
  const root = makeRoot();
  const store = new Store(root, 'lock-test', 9, undefined, { lock: false });
  try {
    const config = makeConfig();
    const before = store.loadPersona().l2;
    applyPersonalitySignal(store, config, {
      text: '我们分手吧，我再也不回来了，别来找我',
      eventId: nextId(),
      l5: makeL5(-0.9, 0.8),
      now: '2026-11-27T10:00:00.000Z',
    }, { locked: ['attachment'], seed: null });
    const after = store.loadPersona().l2;
    assert.equal(after.attachmentAnxiety, before.attachmentAnxiety);
    assert.equal(after.attachmentAvoidance, before.attachmentAvoidance);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('叙事锁定：自我叙事三轴保持不变', () => {
  const root = makeRoot();
  const store = new Store(root, 'lock-test', 9, undefined, { lock: false });
  try {
    const config = makeConfig();
    const before = store.loadPersona().l3.narrative!;
    applyPersonalitySignal(store, config, {
      text: '我们分手吧，我再也不回来了，别来找我',
      eventId: nextId(),
      l5: makeL5(-0.9, 0.8),
      now: '2026-11-27T10:00:00.000Z',
    }, { locked: ['narrative'], seed: null });
    const after = store.loadPersona().l3.narrative!;
    assert.equal(after.worldSafe, before.worldSafe);
    assert.equal(after.othersReliable, before.othersReliable);
    assert.equal(after.selfWorth, before.selfWorth);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('语气微调同样受锁定约束：三维全锁时整轮不写盘', () => {
  const root = makeRoot();
  const store = new Store(root, 'lock-test', 9, undefined, { lock: false });
  try {
    const config = makeConfig();
    const persona = store.loadPersona();
    store.setMeta('personaTurns', '19');
    const before = persona.l1.bigFive;
    const result = applyPersonaDrift(store, config, persona, 0.9, '2026-11-27T10:00:00.000Z', [
      'neuroticism',
      'extraversion',
      'agreeableness',
    ]);
    assert.deepEqual(result, { changed: false });
    assert.deepEqual(store.loadPersona().l1.bigFive, before);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('手填五维：越界值被夹回，出生锚点同步改写，气质按新值重算', () => {
  const root = makeRoot();
  const store = new Store(root, 'setup-test', 9, undefined, { lock: false });
  try {
    const l1 = applyBigFiveSetup(store, {
      openness: 1.8,
      extraversion: 0.2,
      agreeableness: -1,
    }, '2026-11-27T10:00:00.000Z');
    assert.equal(l1.bigFive.openness, 1);
    assert.equal(l1.bigFive.agreeableness, 0);
    assert.equal(l1.bigFive.extraversion, 0.2);
    assert.deepEqual(l1.innate, l1.bigFive, '锚点必须跟着当前值一起改');
    assert.equal(l1.temperament, 'slow_warmup');
    assert.deepEqual(store.loadPersona().l1.bigFive, l1.bigFive);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('重抽初始人格：换一组五维与依恋，关系进度与情感保留', () => {
  const root = makeRoot();
  const store = new Store(root, 'reroll-test', 9, undefined, { lock: false });
  try {
    const config = makeConfig();
    const current = store.loadPersona();
    store.savePersonaLayer('l2', {
      ...current.l2,
      relationshipDepth: 0.72,
      relationshipStage: 'close',
      attachmentAnxiety: 0.91,
    });
    const { l1, l2 } = rerollInitialPersonality(store, config, 123, '2026-11-27T10:00:00.000Z');

    const expectedL1 = createInitialL1('reroll-test', 123, config.personality.initial);
    const expectedL2 = createInitialL2('reroll-test', 123, config.personality.initial);
    assert.deepEqual(l1.bigFive, expectedL1.bigFive, '五维应回到新种子的出生值');
    assert.equal(l2.attachmentAnxiety, expectedL2.attachmentAnxiety, '依恋应回到新锚点');
    assert.equal(l2.relationshipDepth, 0.72, '关系进度不能被重抽抹掉');
    assert.equal(l2.relationshipStage, 'close');
    assert.ok(store.listEvolution(10).some((entry) => entry.reason.includes('重抽初始人格')));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
