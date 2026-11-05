import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { applyBodySignal, bodyInfluence, normalizeBodySignal, pickMotionByPad } from '../src/runtime/body-link.js';
import type { AssetPackage, DaughterConfig, PluginContext } from '../src/types.js';
import { silentLogger } from '../src/util.js';

let turn = 0;

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-daughter-body-'));
}

function makeConfig(mutate: (config: DaughterConfig) => void = () => {}): DaughterConfig {
  const config = structuredClone(defaultConfig);
  config.random_surprise_enabled = false;
  mutate(config);
  return config;
}

function makeCtx(sessionId: string, now: string): PluginContext {
  turn += 1;
  return {
    characterId: 'daughter-default',
    sessionId,
    workspaceId: 'ws-1',
    turnId: `turn-${turn}`,
    now: () => now,
    logger: silentLogger,
    tools: { invoke: async () => null },
  };
}

const LINK = defaultConfig.vpet.body_link;

test('生理信号归一化：百分比与小数都接受，缺字段返回 null', () => {
  const at = '2026-11-04T10:00:00.000Z';
  assert.deepEqual(normalizeBodySignal({ strengthPct: 25, feelingPct: 80 }, at), {
    strength: 0.25,
    feeling: 0.8,
    source: 'vpet',
    at,
  });
  assert.equal(normalizeBodySignal({ strength: 0.4 }, at)?.strength, 0.4);
  assert.equal(normalizeBodySignal({}, at), null, '旧版 bridge 不带字段时不应产生信号');
  assert.equal(normalizeBodySignal(null, at), null);
  assert.equal(normalizeBodySignal({ strengthPct: 'abc' }, at), null);
});

test('外部影响：关闭、过期、缺失一律不生效', () => {
  const signal = { strength: 0.1, feeling: 0.1, source: 'vpet' as const, at: '2026-11-04T10:00:00.000Z' };

  assert.ok(bodyInfluence(signal, LINK, '2026-11-04T10:01:00.000Z'));
  assert.equal(bodyInfluence(signal, LINK, '2026-11-04T12:00:00.000Z'), null, '超过 stale_ms 失效');
  assert.equal(bodyInfluence(signal, { ...LINK, enabled: false }, '2026-11-04T10:01:00.000Z'), null);
  assert.equal(bodyInfluence(null, LINK, '2026-11-04T10:01:00.000Z'), null);

  const influence = bodyInfluence(signal, { ...LINK, max_influence: 0.3 }, '2026-11-04T10:01:00.000Z')!;
  assert.ok(influence.fatigue <= 0.3 && influence.stress <= 0.3, '受 max_influence 约束');
});

test('有效状态只抬升不降低，且不修改入参', () => {
  const base = {
    sessionId: 's',
    characterId: 'daughter-default',
    emotion: { pleasure: 0, arousal: 0, dominance: 0 },
    stress: 0.8,
    safety: 0.7,
    fatigue: 0.05,
    emotionalOverdraft: 0,
    boundary: 0.6,
    activeSubPersonaId: 'alone',
    lastTickAt: '2026-11-04T10:00:00.000Z',
    snapshotAt: '2026-11-04T10:00:00.000Z',
    body: { strength: 0.1, feeling: 0.1, source: 'vpet' as const, at: '2026-11-04T10:00:00.000Z' },
    schemaVersion: 1 as const,
  };

  const effective = applyBodySignal(base, LINK, '2026-11-04T10:00:30.000Z');
  assert.ok(effective.fatigue > base.fatigue);
  assert.equal(effective.stress, 0.8, '对话驱动的更高压力不被外部信号压低');
  assert.equal(base.fatigue, 0.05, '入参必须保持原样');

  const stale = applyBodySignal(base, LINK, '2026-11-05T10:00:00.000Z');
  assert.equal(stale, base, '信号过期时原样返回');
});

test('MOT 资产按 PAD 选最接近的动作；没有 padMatch 时不猜', () => {
  const asset = (id: string, motionId: string, pleasure: number): AssetPackage => ({
    id,
    kind: 'MOT',
    name: id,
    payload: { motionId },
    padMatch: { pleasure, arousal: 0, dominance: 0 },
    rollbackVersion: 0,
    status: 'active',
    createdAt: '2026-11-04T10:00:00.000Z',
    schemaVersion: 1,
  });

  const picked = pickMotionByPad(
    [asset('MOT-happy', 'MOT-HAPPY', 0.8), asset('MOT-sad', 'MOT-SAD', -0.8)],
    { pleasure: -0.7, arousal: 0, dominance: 0 },
  );
  assert.equal(picked?.motionId, 'MOT-SAD');

  const noPad: AssetPackage = {
    id: 'MOT-plain',
    kind: 'MOT',
    name: 'plain',
    payload: { motionId: 'MOT-PAT' },
    rollbackVersion: 0,
    status: 'active',
    createdAt: '2026-11-04T10:00:00.000Z',
    schemaVersion: 1,
  };
  assert.equal(pickMotionByPad([noPad], { pleasure: 0, arousal: 0, dominance: 0 }), null);
});

test('插件端到端：桌宠信号抬升有效状态，但存盘的仍是原始状态', async () => {
  const root = makeRoot();
  const now = new Date().toISOString();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-body', now);

  plugin.syncBodySignal({ characterId: 'daughter-default', strength: 0.1, feeling: 0.1 });
  const { l5 } = await plugin.onUserMessage({ ctx, text: '今天还行', source: 'chat' });

  assert.ok(l5.fatigue >= 0.4, `疲劳应被抬升，实际 ${l5.fatigue}`);
  assert.ok(l5.stress >= 0.25, `压力应被抬升，实际 ${l5.stress}`);

  const store = new Store(root, 'daughter-default');
  const saved = store.loadL5('s-body')!;
  assert.ok(saved.fatigue < 0.3, `存盘应是原始疲劳，实际 ${saved.fatigue}`);
  assert.equal(saved.body, undefined, '原始状态不带 body 字段');
  assert.ok(store.loadBodySignal(), '信号本身按角色落盘');

  store.close();
  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('插件端到端：没有桌宠时不产生任何影响', async () => {
  const root = makeRoot();
  const now = new Date().toISOString();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-nobody', now);

  const { l5 } = await plugin.onUserMessage({ ctx, text: '今天还行', source: 'chat' });
  assert.ok(l5.fatigue < 0.25, `无信号时疲劳保持基准，实际 ${l5.fatigue}`);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('插件端到端：关掉 body_link 后桌宠信号被忽略', async () => {
  const root = makeRoot();
  const now = new Date().toISOString();
  const plugin = createDaughterPlugin({
    pluginRoot: root,
    config: makeConfig((config) => {
      config.vpet.body_link.enabled = false;
    }),
  });
  const ctx = makeCtx('s-off', now);

  plugin.syncBodySignal({ characterId: 'daughter-default', strength: 0.05, feeling: 0.05 });
  const { l5 } = await plugin.onUserMessage({ ctx, text: '今天还行', source: 'chat' });
  assert.ok(l5.fatigue < 0.25, `关闭后疲劳不应被抬升，实际 ${l5.fatigue}`);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});
