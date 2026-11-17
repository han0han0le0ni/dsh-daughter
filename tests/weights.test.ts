import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { buildThingProfiles } from '../src/runtime/maintenance.js';
import { buildPersonaText, buildRelationText, buildStateHint } from '../src/runtime/content.js';
import {
  MOOD_ANCHORS,
  PREFERENCE_ANCHORS,
  STAGE_ANCHORS,
  distribute,
  poleWeight,
  progress,
  round2,
} from '../src/runtime/weights.js';
import type { EventRecord, L5State, PersonaBundle, SafetyVerdict, SubPersona } from '../src/types.js';

const CHAR = 'daughter-default';
const NOW = '2026-11-02T10:00:00.000Z';

function total(list: Array<{ weight: number }>): number {
  return Number(list.reduce((sum, item) => sum + item.weight, 0).toFixed(2));
}

function isTwoDecimals(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}

function makeEvent(id: string, tag: string, pleasure: number, createdAt: string): EventRecord {
  return {
    id,
    characterId: CHAR,
    title: `聊到${tag}`,
    summary: `关于${tag}的一次交流`,
    tags: [tag],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure, arousal: 0.1, dominance: 0, intensity: 0.5 },
    emotionNowHistory: [],
    importance: 0.6,
    weight: 0.6,
    links: [],
    source: 'chat',
    createdAt,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

function makePersona(overrides: Partial<PersonaBundle['l1']['bigFive']> = {}): PersonaBundle {
  return {
    l1: {
      bigFive: {
        openness: 0.5,
        conscientiousness: 0.5,
        extraversion: 0.5,
        agreeableness: 0.5,
        neuroticism: 0.5,
        ...overrides,
      },
      temperament: 'slow_warmup',
      moodBaseline: { pleasure: 0, arousal: 0, dominance: 0 },
      noveltySeeking: 0.5,
      plasticityBase: 0.5,
      plasticity: 0.5,
      updatedAt: NOW,
    } as PersonaBundle['l1'],
    l2: {
      attachmentAnxiety: 0.78,
      attachmentAvoidance: 0.31,
      coreNeeds: [],
      trustBaseline: 0.37,
      relationshipStage: 'acquaintance',
      relationshipDepth: 0.212,
      updatedAt: NOW,
    },
    l3: {
      biasWeights: {},
      defenseMaturity: 0.5,
      copingStrategies: [],
      moral: { altruism: 0.6, principle: 0.55, stance: '先善意假设', redLines: ['不伤害自己与他人'] },
      narrative: { worldSafe: 0.6, othersReliable: 0.5, selfWorth: 0.6, lockedAxes: [], updatedAt: NOW },
      evidence: [],
      updatedAt: NOW,
    },
    l4: { subPersonas: [], updatedAt: NOW },
  };
}

const SUB = { id: 'SUB-1', name: '日常', audience: 'user', tone: '更放松', boundaries: [] } as unknown as SubPersona;

test('权重分布：两位小数、总和恒为 1.00、锚点处取满值', () => {
  const half = distribute(0.25, PREFERENCE_ANCHORS).filter((item) => item.weight > 0);
  assert.deepEqual(half, [
    { label: '中性', weight: 0.5 },
    { label: '喜欢', weight: 0.5 },
  ], '正好落在两档中间时，两档各占一半——这就是"多心情"');

  const exact = distribute(0.5, PREFERENCE_ANCHORS).filter((item) => item.weight > 0);
  assert.deepEqual(exact, [{ label: '喜欢', weight: 1 }]);

  for (const probe of [-1.4, -0.62, -0.01, 0.13, 0.37, 0.9, 2]) {
    const list = distribute(probe, PREFERENCE_ANCHORS);
    assert.equal(total(list), 1, `总和必须 1.00（probe=${probe}）`);
    for (const item of list) {
      assert.equal(isTwoDecimals(item.weight), true, `权重只能有两位小数（${item.label}=${item.weight}）`);
      assert.ok(item.weight >= 0 && item.weight <= 1);
    }
  }
});

test('主档 + 进度：主档恒 ≥ 0.50，且尊重已存阶段的迟滞', () => {
  const weights = progress(0.212, STAGE_ANCHORS);
  assert.deepEqual(weights.map((item) => item.label), ['acquaintance', 'familiar']);
  assert.ok(weights[0]!.weight >= 0.5, '主档不能低于 0.50，否则等于阶段来回抖');
  assert.equal(total(weights), 1);

  // 已存阶段还是 stranger 时，深度越线也不该把她写成"初识"
  const held = progress(0.212, STAGE_ANCHORS, 'stranger');
  assert.equal(held[0]!.label, 'stranger');
  assert.ok(held[0]!.weight >= 0.5);
  assert.equal(held[1]!.label, 'acquaintance');
});

test('性格强度：0.50 为 0.00、端点为 1.00，两位小数', () => {
  assert.equal(poleWeight(0.5), 0);
  assert.equal(poleWeight(1), 1);
  assert.equal(poleWeight(0), 1);
  assert.equal(poleWeight(0.86), 0.72);
  assert.equal(poleWeight(0.4888473670246086), 0.02);
  assert.equal(isTwoDecimals(round2(0.1234)), true);
});

test('事物偏好：五档分布与主档一起产出，中性也保留情绪构成', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-weights-'));
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-20261101-000001', '项目', 0.6, '2026-11-01T09:00:00.000Z'));
  store.addEvent(makeEvent('EVT-20261101-000002', '加班', -0.5, '2026-11-01T10:00:00.000Z'));

  const things = buildThingProfiles(store, NOW);
  const project = things.find((thing) => thing.label === '项目')!;
  const overtime = things.find((thing) => thing.label === '加班')!;

  assert.equal(project.mood, '喜欢', '主档口径要和旧的 ±0.15 判定一致');
  assert.equal(overtime.mood, '不喜欢');
  assert.equal(project.preference, 0.6);
  assert.equal(total(project.moods), 1);
  assert.deepEqual(
    project.moods.filter((item) => item.weight > 0),
    [
      { label: '喜欢', weight: 0.8 },
      { label: '很喜欢', weight: 0.2 },
    ],
    '0.60 的偏好是"喜欢 0.80 / 很喜欢 0.20"，不是一句"喜欢"',
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('偏好行不再静默消失：没有明确喜恶时退成最近常聊', () => {
  const things = [
    { label: '社交', eventCount: 31, preference: 0.1, mood: '中性', moods: distribute(0.1, PREFERENCE_ANCHORS) },
    { label: '对话', eventCount: 29, preference: 0.13, mood: '中性', moods: distribute(0.13, PREFERENCE_ANCHORS) },
    { label: '约定', eventCount: 6, preference: 0.13, mood: '中性', moods: distribute(0.13, PREFERENCE_ANCHORS) },
  ];
  const text = buildRelationText({
    things,
    moral: { altruism: 0.6, principle: 0.55, stance: '先善意假设', redLines: ['不伤害自己与他人'] },
  });

  assert.match(text, /对方的偏好/, '这一行不许再整行消失');
  assert.match(text, /暂时没有明确的喜恶/);
  assert.match(text, /最近常聊 社交（31 次）、对话（29 次）、约定（6 次）/);

  const strong = buildRelationText({
    things: [{ label: '项目', eventCount: 3, preference: 0.6, mood: '喜欢', moods: distribute(0.6, PREFERENCE_ANCHORS) }],
    moral: { altruism: 0.6, principle: 0.55, stance: '先善意假设', redLines: [] },
  });
  assert.match(strong, /项目 喜欢 0\.80/);
  assert.doesNotMatch(strong, /最近常聊/);
});

test('人格文案：多档性格并存，噪声项（< 0.30）不写', () => {
  const text = buildPersonaText(
    makePersona({ openness: 0.86, conscientiousness: 0.82, extraversion: 0.4888, agreeableness: 0.5795, neuroticism: 0.8483 }),
    SUB,
  );

  // 权重写成括号里的读数：字在前、数在后，读起来不像满分好评
  assert.match(text, /对新东西好奇（0\.72）/);
  assert.match(text, /容易反复想（0\.70）/);
  assert.match(text, /按部就班（0\.64）/);
  assert.doesNotMatch(text, /愿意主动说话/, '0.49 的外向度只值 0.02，说不出口就不说');
  assert.doesNotMatch(text, /话不多，先观察/);
  assert.match(text, /认识不久（0\.84）/, '主档按已存阶段，0.212 的深度只是在往下一档走');
  assert.match(text, /正在往"已经比较熟"走（0\.16）/);
});

test('状态提示：心情同样是多档分布', () => {
  const l5 = {
    emotion: { pleasure: 0.3, arousal: 0.1, dominance: 0 },
    stress: 0.2,
    safety: 0.7,
    fatigue: 0.2,
  } as unknown as L5State;
  const hint = buildStateHint(l5, { level: 0 } as SafetyVerdict);
  assert.match(hint, /情绪：轻快 0\.\d\d/);

  const neutral = buildStateHint(
    { emotion: { pleasure: 0, arousal: 0, dominance: 0 }, stress: 0.1, safety: 0.8, fatigue: 0.1 } as unknown as L5State,
    { level: 0 } as SafetyVerdict,
  );
  assert.match(neutral, /情绪：平静 1\.00/);
});

test('心情锚点：±0.25 之外才算偏离平静', () => {
  const near = distribute(0.02, MOOD_ANCHORS).filter((item) => item.weight > 0);
  assert.equal(near[0]!.label, '平静');
  const mild = distribute(0.6, MOOD_ANCHORS);
  assert.equal(mild.reduce((best, item) => (item.weight > best.weight ? item : best)).label, '轻快');
});
