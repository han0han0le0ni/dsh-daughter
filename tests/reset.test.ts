import test from 'node:test';

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { DEFAULT_L1, DEFAULT_L3, DEFAULT_REFLEX_RULES, Store } from '../src/store.js';
import { applyReset, planReset, verifyReset } from '../src/runtime/reset.js';
import type { EventRecord, L5State, SafetyState, SkillCard } from '../src/types.js';

const CHAR = 'daughter-default';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-reset-'));
}

function makeEvent(id: string): EventRecord {
  return {
    id,
    characterId: CHAR,
    title: '一起吃饭',
    summary: '晚上一起吃了饭',
    tags: ['生活'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0.3, arousal: 0, dominance: 0, intensity: 0.4 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: 'chat',
    createdAt: '2026-11-01T10:00:00.000Z',
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

function makeSkill(): SkillCard {
  return {
    id: 'SK-001',
    characterId: CHAR,
    name: '泡茶',
    intent: '对方说想喝茶',
    keywords: ['茶'],
    requiredTools: [],
    steps: [],
    boundary: { requiresConfirm: false, costLevel: 'low', forbiddenContexts: [] },
    maturity: 0.5,
    successCount: 1,
    failCount: 0,
    version: 1,
    status: 'active',
    updatedAt: '2026-11-01T10:00:00.000Z',
    schemaVersion: 1,
  };
}

function makeL5(): L5State {
  return {
    sessionId: 's-1',
    characterId: CHAR,
    emotion: { pleasure: 0.2, arousal: 0, dominance: 0 },
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

function makeSafety(): SafetyState {
  return {
    level: 1,
    reasons: ['连续高压'],
    overstressDurationMs: 1000,
    functionalImpairment: 0.2,
    triggers: ['stress'],
    since: '2026-11-05T10:00:00.000Z',
  };
}

test('planReset 纯读：列出待清内容但不改动数据', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-1'));
  store.addEvent(makeEvent('EVT-2'));

  const plan = planReset(store, 'memory');
  const memory = plan.items.find((item) => item.label === '事件记忆');
  assert.ok(memory);
  assert.match(memory.detail, /2 条/);
  assert.equal(store.countEvents().total, 2, 'dry-run 不应删数据');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('清记忆：事件、回看、全文与归档文件一起清掉，并复核通过', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  const event = makeEvent('EVT-1');
  store.addEvent(event, '晚上一起吃了饭，聊到了小时候');
  store.appendEmotionHistory(event.id, {
    at: '2026-11-02T10:00:00.000Z',
    emotion: { pleasure: 0.1, arousal: 0, dominance: 0 },
    reason: '回看',
  });
  store.writeStarMap(CHAR, { nodes: [], edges: [] });
  store.bumpCounter('filter.keep');
  assert.equal(existsSync(join(store.paths.fulltext, 'EVT-1.txt')), true);
  assert.equal(existsSync(join(store.paths.archive, 'EVT-1.json')), false);

  const result = applyReset(store, 'memory');
  assert.deepEqual(result.errors, []);
  assert.ok(result.backupDir && existsSync(result.backupDir), '默认应留备份');
  assert.ok(result.retired.some((path) => path.includes('reset-trash')));

  assert.equal(store.countEvents().total, 0);
  assert.equal(store.countEmotionHistory(), 0);
  assert.equal(readdirSync(store.paths.fulltext).length, 0);
  assert.equal(readdirSync(store.paths.archive).length, 0);
  assert.equal(readdirSync(store.paths.starMap).length, 0);
  assert.equal(store.getMeta('filter.keep'), null, '滤网计数应一并清掉');

  const verdict = verifyReset(store, 'memory');
  assert.equal(verdict.ok, true, verdict.checks.map((check) => `${check.label}:${check.detail}`).join('; '));

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('恢复出厂人格：L1–L4 写回基线，偏差权重清空', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.savePersonaLayer('l3', {
    ...DEFAULT_L3,
    biasWeights: { confirmation: 0.4 },
    copingStrategies: [],
    updatedAt: '2026-11-05T10:00:00.000Z',
  });
  assert.equal(Object.keys(store.loadPersona().l3.biasWeights).length, 1);
  store.setMeta('personalityTurns', '12');

  const result = applyReset(store, 'personality', { backup: false });
  assert.deepEqual(result.errors, []);
  assert.equal(result.backupDir, null, 'backup:false 时不留备份');

  const persona = store.loadPersona();
  assert.deepEqual(persona.l3.biasWeights, {});
  assert.equal(persona.l1.updatedAt, DEFAULT_L1.updatedAt);
  assert.equal(store.getMeta('personalityTurns'), null);

  const verdict = verifyReset(store, 'personality');
  assert.equal(verdict.ok, true, verdict.checks.map((check) => `${check.label}:${check.detail}`).join('; '));

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('清条件反射：删掉 rules.yaml 与 state.json，读回即出厂规则', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.saveReflexState({ 'RFX-001': '2026-11-05T10:00:00.000Z' });
  store.setMeta('reflex.hits', '3');
  writeFileSync(
    join(store.paths.reflexes, 'rules.yaml'),
    YAML.stringify([...DEFAULT_REFLEX_RULES, { ...DEFAULT_REFLEX_RULES[0], id: 'RFX-003' }]),
    'utf8',
  );
  assert.equal(store.loadReflexRules().length, DEFAULT_REFLEX_RULES.length + 1);

  const result = applyReset(store, 'reflex');
  assert.deepEqual(result.errors, []);
  assert.equal(store.loadReflexRules().length, DEFAULT_REFLEX_RULES.length);
  assert.deepEqual(store.loadReflexState(), {});
  assert.equal(existsSync(join(store.paths.reflexes, 'state.json')), false);
  assert.equal(store.getMeta('reflex.hits'), null);

  const verdict = verifyReset(store, 'reflex');
  assert.equal(verdict.ok, true, verdict.checks.map((check) => `${check.label}:${check.detail}`).join('; '));

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('清技能：技能卡与动作模板都移走', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.saveSkill(makeSkill());
  writeFileSync(join(store.paths.motions, 'wave.json'), '{}', 'utf8');
  store.setMeta('skill.SK-001.fails', '2');
  assert.equal(store.loadSkills().length, 1);

  const result = applyReset(store, 'skills');
  assert.deepEqual(result.errors, []);
  assert.equal(store.loadSkills().length, 0);
  assert.equal(readdirSync(store.paths.motions).length, 0);
  assert.equal(store.getMeta('skill.SK-001.fails'), null);

  const verdict = verifyReset(store, 'skills');
  assert.equal(verdict.ok, true, verdict.checks.map((check) => `${check.label}:${check.detail}`).join('; '));

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('恢复出厂设置：四个域一起清，安全态与运行基准也归零', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  const event = makeEvent('EVT-1');
  store.addEvent(event, '全文');
  store.saveSkill(makeSkill());
  store.saveL5(makeL5());
  store.saveSafetyState(makeSafety());
  store.saveOverdraft(0.6);
  store.saveReflexState({ 'RFX-001': '2026-11-05T10:00:00.000Z' });
  store.setMeta('lastTickAt', '2026-11-05T10:00:00.000Z');
  store.setMeta('motivation.stress', '0.8');
  store.setMeta('personalityTurns', '3');

  const result = applyReset(store, 'all');
  assert.deepEqual(result.errors, []);
  assert.equal(result.retired.length > 0, true);

  // 目录被移走后又重建，后续写者不会因为目录不存在而报错
  assert.equal(existsSync(store.paths.fulltext), true);
  assert.equal(existsSync(store.paths.l5), true);
  assert.equal(existsSync(store.paths.skills), true);
  assert.equal(existsSync(store.paths.safety), false);
  assert.equal(existsSync(store.paths.overdraft), false);
  assert.equal(store.listL5Sessions().length, 0);

  const verdict = verifyReset(store, 'all');
  assert.equal(verdict.ok, true, verdict.checks.map((check) => `${check.label}:${check.detail}`).join('; '));

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('复核能抓出未清干净：残留事件时 verifyReset 不过', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-1'));

  const verdict = verifyReset(store, 'memory');
  assert.equal(verdict.ok, false, '还没清就复核，必须判失败而不是默认通过');
  assert.equal(verdict.checks.find((check) => check.label === '事件记忆')?.ok, false);

  store.close();
  rmSync(root, { recursive: true, force: true });
});
