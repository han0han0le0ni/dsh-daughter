import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { defaultConfig, mergeConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { evaluateThink } from '../src/runtime/think.js';
import { silentLogger } from '../src/util.js';
import type { DaughterConfig, L5State, PluginContext } from '../src/types.js';

const NOW = '2026-11-10T10:00:00.000Z';

function makeL5(overrides: Partial<L5State> = {}): L5State {
  return {
    sessionId: 's-think',
    characterId: 'daughter-default',
    emotion: { pleasure: 0.9, arousal: 0.8, dominance: 0.5 },
    stress: 0.7,
    safety: 0.5,
    fatigue: 0.1,
    emotionalOverdraft: 0,
    boundary: 0.5,
    activeSubPersonaId: 'default',
    lastTickAt: NOW,
    snapshotAt: NOW,
    schemaVersion: 1,
    ...overrides,
  };
}

/** 只打开碎碎念、关掉宿主联动，避免测试受身体信号等旁路影响 */
function makeConfig(overrides: Partial<DaughterConfig['think']> = {}): DaughterConfig {
  const config = structuredClone(defaultConfig);
  config.think = { ...config.think, ...overrides };
  config.vpet.body_link.enabled = false;
  return config;
}

test('DEF-23 碎碎念：关闭、间隔不足、强度不足都不出声', () => {
  const l5 = makeL5();
  assert.equal(
    evaluateThink({ now: NOW, l5, sinceLastThinkMinutes: null, jitter: 0 }, makeConfig({ enabled: false })),
    null,
    '关闭时不应出声',
  );
  assert.equal(
    evaluateThink({ now: NOW, l5, sinceLastThinkMinutes: 5, jitter: 0 }, makeConfig({ min_gap_min: 20 })),
    null,
    '间隔不足时不应重复嘟囔',
  );
  const calm = makeL5({ emotion: { pleasure: 0, arousal: 0, dominance: 0 }, stress: 0 });
  assert.equal(
    evaluateThink({ now: NOW, l5: calm, sinceLastThinkMinutes: null, jitter: 0 }, makeConfig({ threshold: 0.55 })),
    null,
    '情绪平缓时没有碎碎念',
  );
});

test('DEF-23 碎碎念：每轮 1–2 条、单条 ≤40 字、同种子可复现', () => {
  const config = makeConfig();
  const ctx = { now: NOW, l5: makeL5(), sinceLastThinkMinutes: null, jitter: 0 };
  const plan = evaluateThink(ctx, config, { seed: 'seed-a' });
  assert.ok(plan, '高情绪强度下应出声');
  assert.ok(plan.lines.length >= 1 && plan.lines.length <= 2, `条数应在 1–2，实际 ${plan.lines.length}`);
  for (const line of plan.lines) {
    assert.ok(line.length <= 40, `单条应 ≤40 字，实际 ${line.length}：${line}`);
  }
  const again = evaluateThink(ctx, config, { seed: 'seed-a' });
  assert.deepEqual(again, plan, '同一种子必须得到同一结果');
});

test('DEF-23 碎碎念：max_chars 截断后仍不超过上限', () => {
  const config = makeConfig({ max_chars: 8 });
  const plan = evaluateThink({ now: NOW, l5: makeL5(), sinceLastThinkMinutes: null, jitter: 0 }, config, {
    seed: 'seed-clip',
  });
  assert.ok(plan);
  for (const line of plan.lines) {
    assert.ok(line.length <= 8, `截断后应 ≤8 字，实际 ${line.length}：${line}`);
  }
});

test('DEF-23 节流参数归一化：条数上限 2、字数上限 40', () => {
  const merged = mergeConfig(defaultConfig, {
    think: { max_per_turn: 9, max_chars: 99, min_gap_min: 0, threshold: 2 },
  });
  assert.equal(merged.think.max_per_turn, 2);
  assert.equal(merged.think.max_chars, 40);
  assert.equal(merged.think.min_gap_min, 1);
  assert.equal(merged.think.threshold, 1);
});

test('DEF-23 碎碎念不写事件、不影响 memoryHit，且有最小间隔', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-daughter-think-'));
  // 先放一份高强度 L5，否则没有"心里有事"可念
  const seeding = new Store(root, 'daughter-default');
  seeding.saveL5(makeL5());
  seeding.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig({ min_gap_min: 20 }) });
  const ctx: PluginContext = {
    characterId: 'daughter-default',
    sessionId: 's-think',
    workspaceId: 'ws-think',
    turnId: 'turn-think',
    now: () => NOW,
    logger: silentLogger,
    tools: { invoke: async () => null },
  };
  try {
    const first = await plugin.thinkPlan({ characterId: 'daughter-default', now: NOW, jitter: 0 });
    assert.ok(first && first.lines.length > 0, '应产出碎碎念');

    const second = await plugin.thinkPlan({ characterId: 'daughter-default', now: NOW, jitter: 0 });
    assert.equal(second, null, '最小间隔内应被节流');

    // 碎碎念不进记忆：空库仍然是空库，检索也不会因此命中
    const prompt = await plugin.beforePromptBuild({ ctx, tokenBudget: 2000 });
    assert.equal(prompt.memoryHit, false, '碎碎念不应让 memoryHit 变真');
  } finally {
    plugin.close();
  }

  const verify = new Store(root, 'daughter-default');
  try {
    assert.equal(verify.countEvents().total, 0, '碎碎念不能产生事件');
    assert.equal(verify.getMeta('think.lastAt'), NOW, '应留下节流锚点');
    assert.equal(verify.getMeta('think.history'), null, '不写全文历史，避免变成第二套记忆');
  } finally {
    verify.close();
    rmSync(root, { recursive: true, force: true });
  }
});
