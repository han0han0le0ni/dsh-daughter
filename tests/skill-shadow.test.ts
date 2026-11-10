import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { observeShadow, rollbackSkill } from '../src/runtime/maintenance.js';
import type { DaughterConfig, SkillCard } from '../src/types.js';

const NOW = '2026-11-10T10:00:00.000Z';

/** 临时库 + 自动 close/清理：Store 持有文件句柄，不关会 EPERM */
function withStore(run: (store: Store) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'dsh-daughter-shadow-'));
  const store = new Store(root, 'daughter-default');
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function makeConfig(mutate: (config: DaughterConfig) => void = () => {}): DaughterConfig {
  const config = structuredClone(defaultConfig);
  mutate(config);
  return config;
}

function makeSkill(overrides: Partial<SkillCard> = {}): SkillCard {
  return {
    id: 'SKL-shadow-001',
    characterId: 'daughter-default',
    name: '查资料',
    intent: '查资料',
    keywords: ['查资料'],
    requiredTools: ['search'],
    steps: [{ order: 1, description: '搜索', tool: 'search', onFailure: 'abort' }],
    boundary: { requiresConfirm: false, costLevel: 'low', forbiddenContexts: [] },
    maturity: 0.5,
    successCount: 5,
    failCount: 5,
    version: 1,
    status: 'active',
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  };
}

function shadowOf(success: number, fail: number, patch: NonNullable<SkillCard['shadow']>['patch'] = {}) {
  return { patch, success, fail, since: NOW };
}

test('DEF-19 影子池：关闭开关、没有候选、没有工具证据都不记样本', () => {
  const config = makeConfig((c) => {
    c.skills.shadow.enabled = false;
  });
  withStore((store) => {
    const skill = makeSkill({ shadow: shadowOf(2, 1) });
    store.saveSkill(skill);

    const off = observeShadow(store, skill, ['search'], config, NOW);
    assert.equal(off.recorded, false);
    assert.equal(off.reason, '影子池未开启');
    assert.equal(store.loadSkill(skill.id)!.shadow!.success, 2, '关闭时不能动候选战绩');

    const enabled = makeConfig();
    const none = observeShadow(store, makeSkill(), ['search'], enabled, NOW);
    assert.equal(none.recorded, false);
    assert.equal(none.reason, '没有候选版本');

    // 被激活即成功那种"自证"轮次没有工具证据，不能当训练信号
    const noEvidence = observeShadow(store, skill, [], enabled, NOW);
    assert.equal(noEvidence.recorded, false);
    assert.equal(noEvidence.reason, '本轮没有工具证据，不记样本');
    assert.equal(store.loadSkill(skill.id)!.shadow!.success, 2);
  });
});

test('DEF-19 候选判定用严格口径：候选要求的工具缺一个就记失败', () => {
  withStore((store) => {
    // 在用版本只要求 search，宽松口径下本轮算成功；候选要求 search + browser，严格口径下算失败
    const skill = makeSkill({ shadow: shadowOf(0, 0, { requiredTools: ['search', 'browser'] }) });
    store.saveSkill(skill);

    const result = observeShadow(store, skill, ['search'], makeConfig(), NOW);
    assert.equal(result.recorded, true);
    assert.equal(result.promoted, false);
    const saved = store.loadSkill(skill.id)!;
    assert.equal(saved.shadow!.success, 0);
    assert.equal(saved.shadow!.fail, 1, '缺 browser 应记失败而不是成功');
  });
});

test('DEF-19 样本不足不转正，候选战绩继续累计', () => {
  const config = makeConfig((c) => {
    c.skills.shadow.min_samples = 5;
  });
  withStore((store) => {
    const skill = makeSkill({ shadow: shadowOf(2, 0) });
    store.saveSkill(skill);

    const result = observeShadow(store, skill, ['search'], config, NOW);
    assert.equal(result.recorded, true);
    assert.equal(result.promoted, false);
    assert.equal(result.samples, 3);
    const saved = store.loadSkill(skill.id)!;
    assert.equal(saved.version, 1, '样本不足时版本不变');
    assert.equal(saved.shadow!.success, 3);
    assert.equal(saved.previous, undefined);
  });
});

test('DEF-19 胜率或 margin 不足不转正', () => {
  // 胜率线 0.9：2 胜 1 负 = 0.67，样本够也不转正
  const strictWinRate = makeConfig((c) => {
    c.skills.shadow.min_samples = 3;
    c.skills.shadow.win_rate = 0.9;
    c.skills.shadow.margin = 0;
  });
  withStore((store) => {
    const skill = makeSkill({ shadow: shadowOf(1, 1) });
    store.saveSkill(skill);
    const result = observeShadow(store, skill, ['search'], strictWinRate, NOW);
    assert.equal(result.promoted, false);
    assert.equal(store.loadSkill(skill.id)!.version, 1);
  });

  // margin 0.6：候选 1.0，在用 0.5，差 0.5 不够 0.6，不转正
  const strictMargin = makeConfig((c) => {
    c.skills.shadow.min_samples = 3;
    c.skills.shadow.win_rate = 0;
    c.skills.shadow.margin = 0.6;
  });
  withStore((store) => {
    const skill = makeSkill({ shadow: shadowOf(2, 0) });
    store.saveSkill(skill);
    const result = observeShadow(store, skill, ['search'], strictMargin, NOW);
    assert.equal(result.promoted, false);
    assert.equal(store.loadSkill(skill.id)!.version, 1);
  });
});

test('DEF-19 达标转正：版本 +1、候选内容落盘、写快照与演化日志', () => {
  const config = makeConfig((c) => {
    c.skills.shadow.min_samples = 3;
    c.skills.shadow.win_rate = 0.6;
    c.skills.shadow.margin = 0.1;
  });
  withStore((store) => {
    const skill = makeSkill({
      shadow: shadowOf(2, 0, {
        name: '查资料 v2',
        keywords: ['查资料', '比价'],
        steps: [
          { order: 1, description: '搜索', tool: 'search', onFailure: 'abort' },
          { order: 2, description: '核对来源', tool: 'search', onFailure: 'continue' },
        ],
        boundary: { requiresConfirm: true, costLevel: 'medium', forbiddenContexts: ['支付'] },
      }),
    });
    store.saveSkill(skill);

    const result = observeShadow(store, skill, ['search'], config, NOW);
    assert.equal(result.recorded, true);
    assert.equal(result.promoted, true);
    assert.equal(result.samples, 3);
    assert.equal(result.shadowWinRate, 1);

    const saved = store.loadSkill(skill.id)!;
    assert.equal(saved.version, 2);
    assert.equal(saved.name, '查资料 v2');
    assert.deepEqual(saved.keywords, ['查资料', '比价']);
    assert.equal(saved.steps.length, 2);
    assert.equal(saved.boundary.costLevel, 'medium');
    assert.equal(saved.maturity, 0.55);
    // 候选战绩原样接管：3 次全胜
    assert.equal(saved.successCount, 3);
    assert.equal(saved.failCount, 0);
    assert.equal(saved.status, 'active');
    assert.equal(saved.shadow, undefined, '转正后清掉候选');

    const previous = saved.previous!;
    assert.equal(previous.version, 1);
    assert.equal(previous.name, '查资料');
    assert.deepEqual(previous.keywords, ['查资料']);
    assert.equal(previous.successCount, 5);
    assert.equal(previous.failCount, 5);
    assert.equal(previous.savedAt, NOW);

    const evolutions = store.listEvolution(5);
    const promoted = evolutions.find((entry) => entry.target === 'skill' && entry.reason.includes('影子池转正'));
    assert.ok(promoted, '应写一条转正演化日志');
    assert.deepEqual(promoted.before, { skillId: skill.id, version: 1, name: '查资料' });
    assert.deepEqual(promoted.after, { skillId: skill.id, version: 2, name: '查资料 v2' });
  });
});

test('DEF-19 回滚：按快照精确恢复上一版，没有快照时是无操作', () => {
  const config = makeConfig((c) => {
    c.skills.shadow.min_samples = 3;
  });
  withStore((store) => {
    const skill = makeSkill({ shadow: shadowOf(2, 0, { name: '查资料 v2', keywords: ['查资料', '比价'] }) });
    store.saveSkill(skill);
    assert.equal(observeShadow(store, skill, ['search'], config, NOW).promoted, true);

    const restored = rollbackSkill(store, skill.id, '2026-11-11T00:00:00.000Z')!;
    assert.equal(restored.version, 1);
    assert.equal(restored.name, '查资料');
    assert.deepEqual(restored.keywords, ['查资料']);
    assert.equal(restored.maturity, 0.5);
    assert.equal(restored.successCount, 5);
    assert.equal(restored.failCount, 5);
    assert.equal(restored.status, 'active');
    assert.equal(restored.previous, undefined, '回滚后清掉快照，避免来回抖动');
    assert.equal(restored.shadow, undefined);
    assert.equal(store.loadSkill(skill.id)!.name, '查资料', '回滚结果应落盘');

    // 没有快照的技能再回滚不应报错，也不应改动
    const plain = makeSkill({ id: 'SKL-shadow-plain', shadow: undefined, previous: undefined });
    store.saveSkill(plain);
    const untouched = rollbackSkill(store, plain.id, NOW)!;
    assert.equal(untouched.version, 1);
    assert.equal(untouched.name, '查资料');
  });
});
