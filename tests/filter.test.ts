import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { runTick } from '../src/runtime/maintenance.js';
import { buildStarPanels } from '../src/runtime/panels.js';
import {
  decideIngest,
  eventSignature,
  forgetSweep,
  salienceOf,
  shieldReason,
} from '../src/runtime/filter.js';
import type { DaughterConfig, EventRecord, PluginContext } from '../src/types.js';
import { silentLogger } from '../src/util.js';

let turn = 0;

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-daughter-filter-'));
}

function makeConfig(mutate: (config: DaughterConfig) => void = () => {}): DaughterConfig {
  const config = structuredClone(defaultConfig);
  config.random_surprise_enabled = false;
  mutate(config);
  return config;
}

function makeCtx(now: string): PluginContext {
  turn += 1;
  return {
    characterId: 'daughter-default',
    sessionId: 's-filter',
    workspaceId: 'ws-1',
    turnId: `turn-${turn}`,
    now: () => now,
    logger: silentLogger,
    tools: { invoke: async () => null },
  };
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const now = overrides.createdAt ?? '2026-11-05T10:00:00.000Z';
  return {
    id: overrides.id ?? `EVT-TEST-${Math.random().toString(16).slice(2, 8)}`,
    characterId: 'daughter-default',
    title: '电脑前台切换到 Chrome',
    summary: '电脑前台切换到 Chrome（Chrome）',
    tags: ['对话'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0, arousal: 0, dominance: 0, intensity: 0.05 },
    emotionNowHistory: [],
    importance: 0.4,
    weight: 0.45,
    links: [],
    source: 'system',
    createdAt: now,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
    ...overrides,
  };
}

test('认知屏蔽：关键词 / 来源命中即不入库', () => {
  const config = makeConfig((cfg) => {
    cfg.filter.shield.keywords = ['密码'];
    cfg.filter.shield.sources = ['minecraft'];
  });

  assert.match(shieldReason(makeEvent({ title: '我的密码是 123' }), config) ?? '', /屏蔽词/);
  assert.match(shieldReason(makeEvent({ source: 'minecraft' }), config) ?? '', /来源/);
  assert.equal(shieldReason(makeEvent(), config), null);

  const decision = decideIngest(makeEvent({ title: '我的密码是 123' }), [], config, '2026-11-05T10:00:00.000Z');
  assert.equal(decision.action, 'shield');
});

test('显著性：系统噪声低、真人对话高', () => {
  const config = makeConfig();
  const noise = salienceOf(makeEvent(), [], config);
  const talk = salienceOf(
    makeEvent({ source: 'chat', title: '今天被骂了', summary: '今天被骂了 → 嗯，我在', emotionAtTime: { pleasure: -0.5, arousal: 0.4, dominance: -0.2, intensity: 0.6 } }),
    [],
    config,
  );
  assert.ok(talk > noise, `真人对话 ${talk} 应高于系统噪声 ${noise}`);
  assert.ok(noise < 0.3, `系统噪声 ${noise} 应显著偏低`);
});

test('习惯化：窗口内同题只保留一条并累加计数，超过上限后不再入库', () => {
  const config = makeConfig();
  const base = makeEvent({ id: 'EVT-A', createdAt: '2026-11-05T10:00:00.000Z' });

  const first = decideIngest(base, [], config, base.createdAt);
  assert.equal(first.action, 'keep');

  const merged = { ...base, mergedCount: 0 };
  const second = decideIngest(
    makeEvent({ id: 'EVT-B', createdAt: '2026-11-05T10:05:00.000Z' }),
    [merged],
    config,
    '2026-11-05T10:05:00.000Z',
  );
  assert.equal(second.action, 'merge');

  const exhausted = { ...base, mergedCount: 3 };
  const third = decideIngest(
    makeEvent({ id: 'EVT-C', createdAt: '2026-11-05T10:10:00.000Z' }),
    [exhausted],
    config,
    '2026-11-05T10:10:00.000Z',
  );
  assert.equal(third.action, 'drop');
  assert.match(third.reason, /习惯化/);
});

test('数字归一化：好感度涨到不同数值视为同题', () => {
  assert.equal(
    eventSignature({ title: '好感度涨到 58410547', summary: '好感度涨到 5.8 万亿' }),
    eventSignature({ title: '好感度涨到 999', summary: '好感度涨到 1.2 亿' }),
  );
  // 标题截断把长数字切成 "…"，也要视为同题
  assert.equal(
    eventSignature({ title: '桌宠好感度涨到 584105479771…', summary: '好感度涨到 5.8 万亿' }),
    eventSignature({ title: '桌宠好感度涨到 5.8 万亿', summary: '好感度涨到 5.8 万亿' }),
  );

  const config = makeConfig();
  const base = makeEvent({ source: 'game', title: '好感度涨到 999', summary: '好感度涨到 999' });
  const decision = decideIngest(
    makeEvent({ source: 'game', title: '好感度涨到 58410547', summary: '好感度涨到 58410547' }),
    [base],
    config,
    '2026-11-05T10:05:00.000Z',
  );
  assert.equal(decision.action, 'merge');
});

test('同一条的合并窗口：五小时内的照并，跨天的不并', () => {
  const config = makeConfig();
  // 真实库的毛病：同一段视频隔两三个小时又刷到，30 分钟窗拦不住，一条记成五份
  const fiveHoursAgo = makeEvent({ source: 'game', createdAt: '2026-11-05T05:00:00.000Z' });
  const near = decideIngest(
    makeEvent({ source: 'game', createdAt: '2026-11-05T10:00:00.000Z' }),
    [fiveHoursAgo],
    config,
    '2026-11-05T10:00:00.000Z',
  );
  assert.equal(near.action, 'merge', '五小时后同一条仍算重复');

  // 跨天的同一条不再合并：那已经是"又看了一遍"，该留新的一条
  const twoDaysAgo = makeEvent({ source: 'game', createdAt: '2026-11-03T06:00:00.000Z' });
  const far = decideIngest(
    makeEvent({ source: 'game', createdAt: '2026-11-05T10:00:00.000Z' }),
    [twoDaysAgo],
    config,
    '2026-11-05T10:00:00.000Z',
  );
  assert.notEqual(far.action, 'merge');
});

test('真人对话永远不会因显著性低被丢弃', () => {
  const config = makeConfig((cfg) => {
    cfg.filter.salience.drop_below = 0.99;
  });
  const decision = decideIngest(
    makeEvent({ source: 'chat', title: '嗯', summary: '嗯', participants: ['self', 'user'] }),
    [],
    config,
    '2026-11-05T10:00:00.000Z',
  );
  assert.equal(decision.action, 'keep', '真人对话只降权不丢弃');
});

test('关闭滤网时一切放行', () => {
  const config = makeConfig((cfg) => {
    cfg.filter.enabled = false;
    cfg.filter.shield.keywords = ['密码'];
  });
  const decision = decideIngest(makeEvent({ title: '我的密码是 123' }), [], config, '2026-11-05T10:00:00.000Z');
  assert.equal(decision.action, 'keep');
});

test('检索降权：同语义下系统事件排在真人对话之后', async () => {
  const root = makeRoot();
  // 这条只验证排序。系统事件的社交性项现在按"没有用户参与"记 0.5（此前恒为 1），
  // 显性值贴着默认门限，可能直接被丢掉，那就测不到"降权"了，所以这里把门限放低。
  const config = makeConfig((cfg) => {
    cfg.filter.salience.drop_below = 0.1;
  });
  const plugin = createDaughterPlugin({ pluginRoot: root, config });
  const now = new Date().toISOString();
  const ctx = makeCtx(now);

  await plugin.ingestExternalEvent({ ctx, text: '电脑前台切换到浏览器', source: 'system' });
  await plugin.ingestExternalEvent({ ctx, text: '电脑前台切换到浏览器', source: 'chat' });

  const hits = await plugin.retrieve({
    characterId: 'daughter-default',
    query: '电脑前台切换到浏览器',
    now,
    topK: 5,
    currentEmotion: { pleasure: 0, arousal: 0, dominance: 0 },
    excludeArchived: false,
  });
  assert.ok(hits.length >= 2, `应命中两条，实际 ${hits.length}`);
  assert.equal(hits[0]!.event.source, 'chat', '同语义时真人对话优先');

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('忘却扫描：低显著性 + 从未被想起 + 长期闲置 → 归档', () => {
  const config = makeConfig();
  const idle = '2026-09-01T10:00:00.000Z';
  const noise = makeEvent({ id: 'EVT-NOISE', salience: 0.05, createdAt: idle });
  const used = makeEvent({ id: 'EVT-USED', salience: 0.05, createdAt: idle, recallCount: 2 });
  const important = makeEvent({ id: 'EVT-IMPORTANT', salience: 0.8, createdAt: idle });
  const fresh = makeEvent({ id: 'EVT-FRESH', salience: 0.05, createdAt: '2026-11-04T10:00:00.000Z' });

  const result = forgetSweep([noise, used, important, fresh], config, '2026-11-05T10:00:00.000Z');
  assert.deepEqual(result.ids, ['EVT-NOISE']);
  assert.equal(result.archived, 1);
});

test('旧数据没有 salience 时按来源保守估计，系统事件会被忘却', () => {
  const config = makeConfig();
  const legacy = makeEvent({ id: 'EVT-LEGACY', salience: undefined, createdAt: '2026-09-01T10:00:00.000Z' });
  const legacyChat = makeEvent({
    id: 'EVT-LEGACY-CHAT',
    source: 'chat',
    salience: undefined,
    createdAt: '2026-09-01T10:00:00.000Z',
  });
  const result = forgetSweep([legacy, legacyChat], config, '2026-11-05T10:00:00.000Z');
  assert.deepEqual(result.ids, ['EVT-LEGACY']);
});

test('tick 会把忘却结果落到归档并计数', () => {
  const root = makeRoot();
  const config = makeConfig();
  const store = new Store(root, 'daughter-default');

  const noise = makeEvent({ id: 'EVT-OLD-NOISE', salience: 0.05, createdAt: '2026-09-01T10:00:00.000Z' });
  store.addEvent(noise);

  const result = runTick(store, config, '2026-11-05T10:00:00.000Z');
  assert.equal(result.forgotten, 1);
  assert.equal(store.getEvent('EVT-OLD-NOISE')!.archived, true);
  assert.equal(store.readCounters('filter.').forget, 1);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('面板能看到滤网统计与平均显著性', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  store.addEvent(makeEvent({ id: 'EVT-P1', salience: 0.4 }));
  store.bumpCounter('filter.drop', 3);

  const panels = buildStarPanels(store, '2026-11-05T10:00:00.000Z', { nodes: 1, edges: 0, galaxies: 1 });
  const group = panels.runtime.find((item) => item.id === 'storage');
  assert.ok(group);
  const keys = group!.params.map((item) => item.key);
  assert.ok(keys.includes('filter.drop'));
  assert.ok(keys.includes('filter.salience'));
  assert.equal(group!.params.find((item) => item.key === 'filter.drop')!.value, 3);

  store.close();
  rmSync(root, { recursive: true, force: true });
});
