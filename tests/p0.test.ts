import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Observability } from '../src/runtime/observability.js';
import { evaluateSafety, containsDiagnosisLabel } from '../src/runtime/safety.js';
import { applySurprise, retrieveEvents, reconstructOnRecall, associateEvents, linkNewEvent } from '../src/runtime/memory.js';
import { maybeFreezeSkill, buildStarMap, applyPersonaDrift } from '../src/runtime/maintenance.js';
import { matchReflex } from '../src/runtime/content.js';
import { createRng } from '../src/util.js';
import type {
  AssetPackage,
  DaughterConfig,
  EventRecord,
  L5State,
  PluginContext,
  ReflexRule,
  SafetyState,
  SkillCard,
} from '../src/types.js';
import { silentLogger } from '../src/util.js';

let turn = 0;

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-daughter-'));
}

function makeConfig(overrides: Partial<DaughterConfig> = {}): DaughterConfig {
  const config = structuredClone(defaultConfig);
  config.random_surprise_enabled = false;
  return { ...config, ...overrides } as DaughterConfig;
}

function makeCtx(
  sessionId: string,
  characterId = 'daughter-default',
  now = '2026-11-02T10:00:00.000Z',
  workspaceId = 'ws-1',
): PluginContext {
  turn += 1;
  return {
    characterId,
    sessionId,
    workspaceId,
    turnId: `turn-${turn}`,
    now: () => now,
    logger: silentLogger,
    tools: { invoke: async () => null },
  };
}

test('空事件库：注入无记忆硬约束，且不超预算', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-empty');

  await plugin.onUserMessage({ ctx, text: '你好', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });

  assert.equal(result.memoryHit, false);
  const constraint = result.blocks.find((block) => block.kind === 'constraint');
  assert.ok(constraint, '缺少无记忆约束块');
  assert.match(constraint.text, /禁止编造/);
  assert.ok(result.usedTokens <= 3000);
  assert.match(result.blocks.find((block) => block.kind === 'state_hint')!.text, /情绪/);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('跨会话、跨工作区共享事件记忆', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });

  const ctxA = makeCtx('s-a');
  await plugin.onUserMessage({ ctx: ctxA, text: '我昨天在做一个项目，压力有点大', source: 'chat' });
  await plugin.afterResponse({ ctx: ctxA, userText: '我昨天在做一个项目，压力有点大', assistantText: '嗯，慢慢来。' });

  const ctxB = makeCtx('s-b', 'daughter-default', '2026-11-02T10:05:00.000Z', 'ws-2');
  await plugin.onUserMessage({ ctx: ctxB, text: '项目进展怎么样了', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx: ctxB, tokenBudget: 3000 });

  assert.equal(result.memoryHit, true);
  assert.equal(result.blocks.some((block) => block.kind === 'constraint'), false);
  assert.ok(result.blocks.some((block) => block.kind === 'event_digest'));

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('预算硬上限：超限时按顺序裁剪', async () => {
  const root = makeRoot();
  const config = makeConfig();
  config.budget.max_total_tokens = 300;
  const plugin = createDaughterPlugin({ pluginRoot: root, config });

  const ctx = makeCtx('s-budget');
  for (let i = 0; i < 8; i += 1) {
    const text = `第 ${i} 次聊到项目里的一个很长的问题，压力有点大，需要慢慢处理`;
    await plugin.onUserMessage({ ctx, text, source: 'chat' });
    await plugin.afterResponse({ ctx, userText: text, assistantText: '嗯，先记下了。' });
  }

  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 400 });
  assert.ok(result.usedTokens <= 300, `实际 ${result.usedTokens}`);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('emotion_at_time 永不覆盖，emotion_now_history 追加', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');

  const event: EventRecord = {
    id: 'EVT-20261101-000001',
    characterId: 'daughter-default',
    title: '一次争执',
    summary: '和对方争执了几句',
    tags: ['情绪'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: -0.4, arousal: 0.3, dominance: -0.2, intensity: 0.6 },
    emotionNowHistory: [],
    importance: 0.6,
    weight: 0.6,
    links: [],
    source: 'chat',
    createdAt: '2026-11-01T09:00:00.000Z',
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };

  store.addEvent(event);
  store.appendEmotionHistory(event.id, {
    at: '2026-11-02T10:00:00.000Z',
    emotion: { pleasure: 0.1, arousal: 0.0, dominance: 0.1 },
    reason: '现在回看已经平复',
  });

  const reloaded = store.getEvent(event.id)!;
  assert.deepEqual(reloaded.emotionAtTime, event.emotionAtTime);
  assert.equal(reloaded.emotionNowHistory.length, 1);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('emotion_now_history 超限时合并相邻记录，保留首末条', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const eventId = 'EVT-20261101-000002';
  store.addEvent({
    id: eventId,
    characterId: 'daughter-default',
    title: '反复回看的一天',
    summary: '一件被多次回忆的小事',
    tags: ['回忆'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: -0.2, arousal: 0.1, dominance: 0, intensity: 0.3 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: 'chat',
    createdAt: '2026-11-01T00:00:00.000Z',
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  });

  const base = Date.parse('2026-11-01T00:00:00.000Z');
  const stamps = Array.from({ length: 12 }, (_, index) => new Date(base + index * 3_600_000).toISOString());
  stamps.forEach((at, index) => {
    store.appendEmotionHistory(eventId, {
      at,
      emotion: { pleasure: -0.2 + index * 0.02, arousal: 0.1, dominance: 0 },
      reason: `第 ${index} 次回看`,
    });
  });

  const history = store.getEvent(eventId)!.emotionNowHistory;
  assert.equal(history.length, 8);
  assert.equal(history[0]!.at, stamps[0]);
  assert.equal(history[0]!.reason, '第 0 次回看');
  assert.equal(history[history.length - 1]!.at, stamps[stamps.length - 1]);
  assert.equal(history[history.length - 1]!.reason, '第 11 次回看');
  assert.equal(
    history.filter((entry) => entry.reason === '回忆重构：多次回看感受接近，已合并').length,
    4,
    '超出的 4 条应以合并而非删除收场',
  );
  for (let index = 1; index < history.length; index += 1) {
    assert.ok(Date.parse(history[index]!.at) >= Date.parse(history[index - 1]!.at), '合并后时间仍需单调');
  }

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('tick 按 log_retention_days 裁剪演化日志', async () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  store.appendEvolution({
    id: 'EVO-old',
    characterId: 'daughter-default',
    target: 'L1',
    before: {},
    after: {},
    reason: '很久以前的漂移',
    at: '2024-01-01T00:00:00.000Z',
  });
  store.appendEvolution({
    id: 'EVO-new',
    characterId: 'daughter-default',
    target: 'L1',
    before: {},
    after: {},
    reason: '最近的漂移',
    at: '2026-10-01T00:00:00.000Z',
  });
  store.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const report = await plugin.tick({ characterId: 'daughter-default', now: '2026-11-02T10:00:00.000Z' });
  assert.equal(report.prunedLogs, 1);
  plugin.close();

  const reopened = new Store(root, 'daughter-default');
  const kept = reopened.listEvolution(10);
  assert.ok(kept.some((entry) => entry.id === 'EVO-new'), '保留期内的日志应保留');
  assert.ok(!kept.some((entry) => entry.id === 'EVO-old'), '过期日志应被裁剪');
  reopened.close();
  rmSync(root, { recursive: true, force: true });
});

test('FTS5 字面检索：中文子串命中并参与打分', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const quarrelId = 'EVT-20261101-000003';
  const foodId = 'EVT-20261101-000004';

  const base = {
    characterId: 'daughter-default',
    tags: ['生活'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0, arousal: 0, dominance: 0, intensity: 0.2 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: 'chat' as const,
    createdAt: '2026-11-01T08:00:00.000Z',
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
  store.addEvent({ ...base, id: quarrelId, title: '一次大吵', summary: '为了一件小事大吵一架，晚上又和好了' });
  store.addEvent({ ...base, id: foodId, title: '周末火锅', summary: '周末一起去吃了顿火锅' });

  const hits = store.searchFts('大吵一架');
  assert.ok(hits.has(quarrelId), '4 字中文子串应命中');
  assert.equal(hits.has(foodId), false);
  assert.equal(store.searchFts('火锅').size, 0, '2 字查询低于 trigram 下限，应交给 Dice 兜底');

  const config = makeConfig();
  const candidates = store.listAllEvents();
  const ranked = retrieveEvents({
    characterId: 'daughter-default',
    query: '大吵一架',
    now: '2026-11-02T10:00:00.000Z',
    topK: 3,
    currentEmotion: { pleasure: 0, arousal: 0, dominance: 0 },
    excludeArchived: true,
    config,
    candidates,
    ftsScores: (query) => store.searchFts(query),
  });
  assert.equal(ranked[0]!.event.id, quarrelId);

  const boosted = retrieveEvents({
    characterId: 'daughter-default',
    query: 'zzz',
    now: '2026-11-02T10:00:00.000Z',
    topK: 3,
    currentEmotion: { pleasure: 0, arousal: 0, dominance: 0 },
    excludeArchived: true,
    config,
    candidates,
    ftsScores: () => new Map([[foodId, 0.9]]),
  });
  assert.equal(boosted[0]!.event.id, foodId, 'FTS 命中应进入语义分并改变排序');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('安全档位：压力/安全感/透支阈值与滞回', () => {
  const config = makeConfig();
  const l5: L5State = {
    sessionId: 's',
    characterId: 'daughter-default',
    emotion: { pleasure: 0, arousal: 0, dominance: 0 },
    stress: 0.9,
    safety: 0.1,
    fatigue: 0.2,
    emotionalOverdraft: 0.9,
    boundary: 0.5,
    activeSubPersonaId: 'alone',
    stressHighSince: '2026-11-02T09:00:00.000Z',
    lastTickAt: '2026-11-02T10:00:00.000Z',
    snapshotAt: '2026-11-02T10:00:00.000Z',
    schemaVersion: 1,
  };
  const prev: SafetyState = {
    level: 0,
    reasons: [],
    overstressDurationMs: 0,
    functionalImpairment: 0,
    triggers: [],
    since: '1970-01-01T00:00:00.000Z',
  };

  const { verdict } = evaluateSafety(l5, prev, config, '2026-11-02T10:00:00.000Z');
  assert.equal(verdict.level, 3);
  assert.equal(verdict.allowTools, false);

  const recovered = evaluateSafety(
    { ...l5, emotionalOverdraft: 0.75, safety: 0.5, stress: 0.6, fatigue: 0.2, stressHighSince: undefined, safetyLowSince: undefined },
    { ...prev, level: 3 },
    config,
    '2026-11-02T10:10:00.000Z',
  );
  assert.equal(recovered.verdict.level, 3, '滞回带内不应降档');

  assert.equal(containsDiagnosisLabel('可能是抑郁症'), '抑郁症');
  assert.equal(containsDiagnosisLabel('有点低落'), null);
});

test('反射命中不走 LLM，且有冷却', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-reflex');

  const l5 = (await plugin.onUserMessage({ ctx, text: '你好', source: 'chat' })).l5;
  const hit = await plugin.reflexMatch({ ctx, userText: '你好', l5 });
  assert.equal(hit?.ruleId, 'RFX-001');
  assert.equal(hit?.action.kind, 'template_reply');

  const nextCtx = makeCtx('s-reflex', 'daughter-default', '2026-11-02T10:00:20.000Z');
  const cooled = await plugin.reflexMatch({ ctx: nextCtx, userText: '你好', l5 });
  assert.equal(cooled, null, '冷却期内不应再次命中');

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('tick 衰减并归档低权重事件', async () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  store.addEvent({
    id: 'EVT-20260701-000001',
    characterId: 'daughter-default',
    title: '很久以前的小事',
    summary: '一段不太重要的记录',
    tags: ['生活'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0, arousal: 0, dominance: 0, intensity: 0.1 },
    emotionNowHistory: [],
    importance: 0.2,
    weight: 0.2,
    links: [],
    source: 'chat',
    createdAt: '2026-07-01T00:00:00.000Z',
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  });
  store.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const report = await plugin.tick({ characterId: 'daughter-default', now: '2026-11-02T10:00:00.000Z' });
  assert.ok(report.decayed >= 1);
  assert.ok(report.archived >= 1);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('随机联想可复现且受开关控制', () => {
  const config = makeConfig();
  config.random_surprise_enabled = true;
  const candidates = [1, 2, 3, 4, 5].map<EventRecord>((index) => ({
    id: `EVT-2026110${index}-00000${index}`,
    characterId: 'daughter-default',
    title: `事件 ${index}`,
    summary: `第 ${index} 条`,
    tags: ['生活'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0, arousal: 0, dominance: 0, intensity: 0.2 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: 'chat',
    createdAt: '2026-11-01T00:00:00.000Z',
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  }));

  const run = (seed: number) => applySurprise([], candidates, config, createRng(seed), '2026-11-02T10:00:00.000Z');
  const first = run(42);
  const second = run(42);
  assert.deepEqual(first.map((hit) => hit.event.id), second.map((hit) => hit.event.id));

  config.random_surprise_enabled = false;
  assert.equal(applySurprise([], candidates, config, createRng(42), '2026-11-02T10:00:00.000Z').length, 0);

  const weak = retrieveEvents({
    characterId: 'daughter-default',
    query: '',
    now: '2026-11-02T10:00:00.000Z',
    topK: 3,
    currentEmotion: { pleasure: 0, arousal: 0, dominance: 0 },
    excludeArchived: true,
    config,
    candidates,
  });
  assert.ok(weak.length <= 3);
});

test('技能成熟度达标后固化为 MAC 指令包', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();

  const skill: SkillCard = {
    id: 'SKL-demo-001',
    characterId: 'daughter-default',
    name: '演示技能',
    intent: '演示流程',
    keywords: ['演示'],
    requiredTools: [],
    steps: [{ order: 1, description: '第一步', onFailure: 'abort' }],
    boundary: { requiresConfirm: false, costLevel: 'low', forbiddenContexts: [] },
    maturity: 0.72,
    successCount: 5,
    failCount: 0,
    version: 1,
    status: 'active',
    updatedAt: '2026-11-01T00:00:00.000Z',
    schemaVersion: 1,
  };
  store.saveSkill(skill);

  const result = maybeFreezeSkill(store, skill, config, '2026-11-02T10:00:00.000Z');
  assert.equal(result.frozen, true);
  assert.equal(store.loadAsset(result.assetId!)?.compiledFromSkillId, 'SKL-demo-001');
  assert.equal(store.loadSkills()[0]!.status, 'frozen');
  assert.equal(store.listEvolution().length, 1);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('回忆重构追加当前情绪，不改 emotion_at_time', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const event: EventRecord = {
    id: 'EVT-20261101-000002',
    characterId: 'daughter-default',
    title: '一次争执',
    summary: '争执了几句',
    tags: ['情绪'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: -0.5, arousal: 0.4, dominance: -0.2, intensity: 0.7 },
    emotionNowHistory: [],
    importance: 0.6,
    weight: 0.6,
    links: [],
    source: 'chat',
    createdAt: '2026-11-01T09:00:00.000Z',
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
  store.addEvent(event);

  const l5: L5State = {
    sessionId: 's',
    characterId: 'daughter-default',
    emotion: { pleasure: 0.5, arousal: -0.2, dominance: 0.3 },
    stress: 0.2,
    safety: 0.7,
    fatigue: 0.2,
    emotionalOverdraft: 0,
    boundary: 0.6,
    activeSubPersonaId: 'alone',
    lastTickAt: '2026-11-02T10:00:00.000Z',
    snapshotAt: '2026-11-02T10:00:00.000Z',
    schemaVersion: 1,
  };

  assert.equal(reconstructOnRecall(store, store.getEvent(event.id)!, l5, '2026-11-02T10:00:00.000Z'), true);
  const first = store.getEvent(event.id)!;
  assert.deepEqual(first.emotionAtTime, event.emotionAtTime);
  assert.equal(first.emotionNowHistory.length, 1);

  assert.equal(reconstructOnRecall(store, first, l5, '2026-11-02T10:05:00.000Z'), false, '同情绪不重复追加');
  assert.equal(store.getEvent(event.id)!.emotionNowHistory.length, 1);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('tick 生成只读星图产物', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  store.addEvent({
    id: 'EVT-20261101-000003',
    characterId: 'daughter-default',
    title: '星图节点',
    summary: '用于星图测试',
    tags: ['生活'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0.1, arousal: 0, dominance: 0, intensity: 0.2 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: 'chat',
    createdAt: '2026-11-01T00:00:00.000Z',
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  });

  store.saveSkill({
    id: 'SKL-star-001',
    characterId: 'daughter-default',
    name: '星图技能',
    intent: '演示',
    keywords: ['星图'],
    requiredTools: [],
    steps: [{ order: 1, description: '第一步', onFailure: 'abort' }],
    boundary: { requiresConfirm: false, costLevel: 'low', forbiddenContexts: [] },
    maturity: 0.3,
    successCount: 1,
    failCount: 0,
    version: 1,
    status: 'active',
    updatedAt: '2026-11-01T00:00:00.000Z',
    schemaVersion: 1,
  });

  const l5Base = {
    characterId: 'daughter-default',
    emotion: { pleasure: 0.2, arousal: 0.1, dominance: 0 },
    stress: 0.3,
    safety: 0.7,
    fatigue: 0.2,
    emotionalOverdraft: 0.1,
    boundary: 0.6,
    activeSubPersonaId: 'alone',
    snapshotAt: '2026-11-02T09:00:00.000Z',
    schemaVersion: 1,
  };
  store.saveL5({ ...l5Base, sessionId: 'session-star-old', lastTickAt: '2026-11-01T09:00:00.000Z' });
  store.saveL5({ ...l5Base, sessionId: 'session-star-1', lastTickAt: '2026-11-02T09:00:00.000Z' });

  const counts = buildStarMap(store, '2026-11-02T10:00:00.000Z');
  assert.equal(counts.galaxies, 9, '九个星系');
  assert.ok(counts.nodes >= 12, '事件/人物/事物/情绪/认知/安全/技能都有节点');

  const path = join(root, 'star_map', 'daughter-default.json');
  assert.equal(existsSync(path), true);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    galaxies: Array<{ id: string; name: string; part: string }>;
    nodes: Array<{ type: string; id: string; galaxy: string; meta?: Record<string, unknown> }>;
    edges: Array<{ kind: string }>;
  };
  assert.equal(parsed.galaxies.length, 9);
  for (const galaxyId of [
    'hippocampus.event',
    'hippocampus.place',
    'amygdala.emotion',
    'neocortex.person',
    'neocortex.thing',
    'neocortex.cognition',
    'prefrontal.state',
    'basal_ganglia.skill',
    'brainstem.safety',
  ]) {
    assert.ok(parsed.galaxies.some((galaxy) => galaxy.id === galaxyId), `缺少星系 ${galaxyId}`);
  }

  assert.equal(parsed.nodes.filter((node) => node.type === 'event').length, 1);
  assert.equal(parsed.nodes.filter((node) => node.type === 'person').length, 2);
  assert.equal(parsed.nodes.filter((node) => node.type === 'place').length, 1, '未提到地点时按来源归入默认场域');
  assert.ok(parsed.nodes.some((node) => node.type === 'skill' && node.id === 'SKL-star-001'));
  assert.equal(parsed.nodes.filter((node) => node.type === 'cognition').length, 8, '认知八维');
  assert.equal(parsed.nodes.filter((node) => node.type === 'emotion').length, 2, '情绪标签 + 情感透支');
  const stateNodes = parsed.nodes.filter((node) => node.type === 'state');
  assert.equal(stateNodes.length, 7, 'L5 当下状态七维');
  assert.ok(stateNodes.every((node) => node.meta?.sessionId === 'session-star-1'), '取最近活跃的会话快照');
  assert.ok(parsed.nodes.every((node) => typeof node.galaxy === 'string'));
  // person = 两个人物共同参与过事件时建立的关系边（本轮新增）
  assert.deepEqual(
    new Set(parsed.edges.map((edge) => edge.kind)),
    new Set(['participant', 'topic', 'emotion', 'place', 'person']),
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('人物画像：亲密度随互动累积，关系趋势按近 7 天对比', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const makeEvent = (id: string, createdAt: string): EventRecord => ({
    id,
    characterId: 'daughter-default',
    title: '一起聊天',
    summary: '聊了一会儿',
    tags: ['生活'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0.2, arousal: 0, dominance: 0, intensity: 0.4 },
    emotionNowHistory: [],
    importance: 0.6,
    weight: 0.8,
    links: [],
    source: 'chat',
    createdAt,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  });
  store.addEvent(makeEvent('EVT-OLD', '2026-10-13T10:00:00.000Z')); // 20 天前
  store.addEvent(makeEvent('EVT-NEW', '2026-11-01T10:00:00.000Z')); // 1 天前

  buildStarMap(store, '2026-11-02T10:00:00.000Z');
  const parsed = JSON.parse(readFileSync(join(root, 'star_map', 'daughter-default.json'), 'utf8')) as {
    nodes: Array<{ id: string; meta?: Record<string, unknown> }>;
  };
  const person = parsed.nodes.find((node) => node.id === 'person:user')!;
  assert.equal(person.meta?.eventCount, 2);
  assert.ok(Number(person.meta?.intimacy) > 0 && Number(person.meta?.intimacy) <= 1);
  assert.equal(person.meta?.trend, '升温', '只有近 7 天有新互动');
  assert.ok(Number(person.meta?.delta) > 0);
  assert.equal(typeof person.meta?.relationship, 'string');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('外部消息归一化为事件并可检索', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-external');

  const { eventId } = await plugin.ingestExternalEvent({ ctx, text: '今天群里有人发了作业', source: 'qq' });
  assert.match(eventId, /^EVT-/);

  const hits = await plugin.retrieve({
    characterId: 'daughter-default',
    query: '作业',
    now: '2026-11-02T10:00:00.000Z',
    topK: 3,
    currentEmotion: { pleasure: 0, arousal: 0, dominance: 0 },
    excludeArchived: true,
  });
  assert.equal(hits[0]?.event.id, eventId);
  assert.equal(hits[0]?.event.source, 'qq');

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

/* ---------------------------- P5 动作包出口 ---------------------------- */

test('P5 动作包出口：motionPlay 派发给连接器', async () => {
  const root = makeRoot();
  const motions: string[] = [];
  const plugin = createDaughterPlugin({
    pluginRoot: root,
    config: makeConfig(),
    onMotion: (motionId) => motions.push(motionId),
  });
  const ctx = makeCtx('s-motion');

  const result = await plugin.motionPlay({ ctx, motionId: 'MOT-HUG' });
  assert.equal(result.ok, true);
  assert.deepEqual(motions, ['MOT-HUG']);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

/* ---------------------------- P3 链接与概率联想 ---------------------------- */

function makeLinkedEvent(id: string, links: EventRecord['links'] = [], archived = false): EventRecord {
  return {
    id,
    characterId: 'daughter-default',
    title: id,
    summary: id,
    tags: ['生活'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0, arousal: 0, dominance: 0, intensity: 0.2 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links,
    source: 'chat',
    createdAt: '2026-11-01T00:00:00.000Z',
    recallCount: 0,
    archived,
    schemaVersion: 1,
  };
}

test('P3 链接联想：1–2 跳、条数上限、同输入可复现', () => {
  const link = (targetId: string): EventRecord['links'][number] => ({ targetId, kind: 'topic', strength: 0.8 });
  const a = makeLinkedEvent('EVT-A', [link('EVT-B')]);
  const b = makeLinkedEvent('EVT-B', [link('EVT-C')]);
  const c = makeLinkedEvent('EVT-C', [link('EVT-A')]);
  const d = makeLinkedEvent('EVT-D');
  const candidates = [a, b, c, d];

  const twoHop = associateEvents(['EVT-A'], candidates, 2, 2, 0.5);
  assert.deepEqual(twoHop.map((hit) => hit.eventId), ['EVT-B', 'EVT-C']);
  assert.ok(twoHop[0]!.score > twoHop[1]!.score, '近跳得分应更高');
  assert.equal(twoHop.length, 2, '不应超过 maxInjected');
  assert.deepEqual(associateEvents(['EVT-A'], candidates, 2, 2, 0.5), twoHop, '同输入应可复现');

  const oneHop = associateEvents(['EVT-A'], candidates, 1, 5, 0.5);
  assert.deepEqual(oneHop.map((hit) => hit.eventId), ['EVT-B'], 'maxDepth=1 时只走一跳');

  const capped = associateEvents(['EVT-A'], candidates, 2, 1, 0.5);
  assert.equal(capped.length, 1);

  const withArchived = [a, b, makeLinkedEvent('EVT-C', [link('EVT-A')], true), d];
  assert.deepEqual(associateEvents(['EVT-A'], withArchived, 2, 5, 0.5).map((hit) => hit.eventId), ['EVT-B']);
});

test('P3 链接回写：新事件与相似事件双向建边', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const older = makeLinkedEvent('EVT-OLDER');
  const newer = makeLinkedEvent('EVT-NEWER');
  store.addEvent(older);
  store.addEvent(newer);

  const created = linkNewEvent(store, newer);
  assert.equal(created, 1);
  assert.equal(store.getEvent('EVT-NEWER')!.links[0]!.targetId, 'EVT-OLDER');
  assert.equal(store.getEvent('EVT-NEWER')!.links[0]!.kind, 'topic');
  assert.equal(store.getEvent('EVT-OLDER')!.links[0]!.targetId, 'EVT-NEWER', '应双向建边');

  const counts = buildStarMap(store, '2026-11-02T10:00:00.000Z');
  assert.equal(counts.galaxies, 9);
  assert.ok(counts.nodes >= 12, '两个事件带出人物/事物/情绪/认知/安全节点');
  assert.ok(counts.edges >= 8, '参与者、标签、情绪与事件链接边');

  const parsed = JSON.parse(readFileSync(join(root, 'star_map', 'daughter-default.json'), 'utf8')) as {
    edges: Array<{ from: string; to: string; kind: string }>;
  };
  assert.ok(parsed.edges.some((edge) => edge.kind === 'topic' && edge.from === 'EVT-NEWER' && edge.to === 'EVT-OLDER'));

  store.close();
  rmSync(root, { recursive: true, force: true });
});

/* --------------------------- P7 性格演化与 plasticity --------------------------- */
test('P7 性格演化：单次 Δ 受限且每次变更可追溯', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();
  config.evolution.min_turns_between_writes = 1;

  const persona = store.loadPersona();
  const before = persona.l1.bigFive.neuroticism;

  const first = applyPersonaDrift(store, config, persona, 1, '2026-11-02T10:00:00.000Z');
  assert.equal(first.changed, true);
  const afterFirst = store.loadPersona().l1.bigFive.neuroticism;
  assert.ok(before - afterFirst > 0, '正向语气应降低神经质');
  assert.ok(
    before - afterFirst <= config.evolution.l1_max_delta_per_write + 1e-9,
    `单次变化 ${before - afterFirst} 超过上限 ${config.evolution.l1_max_delta_per_write}`,
  );

  const second = applyPersonaDrift(store, config, store.loadPersona(), 1, '2026-11-02T10:01:00.000Z');
  assert.equal(second.changed, true);
  const log = store.listEvolution();
  assert.equal(log.length, 2, '每次写入应留下一条演化记录');
  for (const entry of log) {
    assert.equal(entry.target, 'L1');
    assert.match(entry.reason, /plasticity/);
    assert.ok(entry.before.bigFive && entry.after.bigFive, '记录应含 before/after');
  }
  assert.notEqual(log[0]!.id, log[1]!.id);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('善恶观：独立于八维，旧存档自动补默认，星图单独成节点', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const persona = store.loadPersona();

  assert.ok(persona.l3.moral, 'L3 应带善恶观字段');
  assert.ok(persona.l3.moral.stance.length > 0);
  assert.ok(persona.l3.moral.redLines.length > 0, '旧 l3_cognition.yaml 没有人格新增字段时应补默认红线');

  buildStarMap(store, '2026-11-02T10:00:00.000Z');
  const map = JSON.parse(readFileSync(join(root, 'star_map', 'daughter-default.json'), 'utf8')) as {
    nodes: Array<{ type: string; id: string; meta: Record<string, unknown> }>;
  };
  const moral = map.nodes.find((node) => node.type === 'moral');
  assert.ok(moral, '星图应出现善恶观节点');
  assert.equal(moral!.id, 'moral:outlook');
  assert.equal(typeof moral!.meta.altruism, 'number');
  assert.equal(
    map.nodes.filter((node) => node.type === 'cognition').length,
    8,
    '善恶观不挤占认知八维的计数',
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('事物喜好：按事件情绪累积偏好，并参与 prompt 注入', async () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');

  const pushEvent = (id: string, tags: string[], pleasure: number, createdAt: string) => {
    store.addEvent({
      id,
      characterId: 'daughter-default',
      title: `聊到${tags[0]}`,
      summary: `关于${tags[0]}的一次交流`,
      tags,
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
    });
  };

  pushEvent('EVT-20261101-000001', ['项目'], 0.6, '2026-11-01T09:00:00.000Z');
  pushEvent('EVT-20261101-000002', ['加班'], -0.5, '2026-11-01T10:00:00.000Z');

  buildStarMap(store, '2026-11-02T10:00:00.000Z');
  const map = JSON.parse(readFileSync(join(root, 'star_map', 'daughter-default.json'), 'utf8')) as {
    nodes: Array<{ type: string; id: string; meta: Record<string, unknown> }>;
  };
  const project = map.nodes.find((node) => node.id === 'tag:项目')!;
  const overtime = map.nodes.find((node) => node.id === 'tag:加班')!;
  assert.equal(project.meta.mood, '喜欢');
  assert.equal(overtime.meta.mood, '不喜欢');
  assert.ok(Number(project.meta.preference) > 0);
  store.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const result = await plugin.beforePromptBuild({ ctx: makeCtx('s-preference'), tokenBudget: 3000 });
  const personaBlock = result.blocks.find((block) => block.kind === 'persona')!;
  assert.match(personaBlock.text, /善恶观/);
  assert.match(personaBlock.text, /对方的偏好/);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

function makeSkill(id: string, overrides: Partial<SkillCard> = {}): SkillCard {
  return {
    id,
    characterId: 'daughter-default',
    name: id,
    intent: '演示流程',
    keywords: [id],
    requiredTools: [],
    steps: [{ order: 1, description: '第一步', onFailure: 'abort' }],
    boundary: { requiresConfirm: false, costLevel: 'low', forbiddenContexts: [] },
    maturity: 0.72,
    successCount: 5,
    failCount: 0,
    version: 1,
    status: 'active',
    updatedAt: '2026-11-01T00:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  };
}

test('P5 资产分类：技能形态固化为 MAC/CON/CMB/MOT', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();
  const now = '2026-11-02T10:00:00.000Z';

  const cases: Array<[SkillCard, AssetPackage['kind']]> = [
    [makeSkill('SKL-mac-001'), 'MAC'],
    [
      makeSkill('SKL-con-001', {
        requiredTools: ['send_qq_message'],
        steps: [
          { order: 1, description: '发送消息', tool: 'send_qq_message', argsTemplate: { text: '早' }, onFailure: 'abort' },
        ],
      }),
      'CON',
    ],
    [
      makeSkill('SKL-cmb-001', {
        requiredTools: ['douyin_next', 'douyin_like'],
        steps: [
          { order: 1, description: '翻到下一条', tool: 'douyin_next', onFailure: 'abort' },
          { order: 2, description: '点赞', tool: 'douyin_like', onFailure: 'abort' },
        ],
      }),
      'CMB',
    ],
    [
      makeSkill('SKL-mot-001', {
        requiredTools: ['motion.play'],
        steps: [
          {
            order: 1,
            description: '抱一下',
            tool: 'motion.play',
            argsTemplate: { motionId: 'MOT-HUG' },
            onFailure: 'abort',
          },
        ],
      }),
      'MOT',
    ],
  ];

  for (const [skill, expectedKind] of cases) {
    store.saveSkill(skill);
    const result = maybeFreezeSkill(store, skill, config, now);
    assert.equal(result.frozen, true, `${skill.id} 应固化`);
    const asset = store.loadAsset(result.assetId!)!;
    assert.equal(asset.kind, expectedKind, `${skill.id} 类型`);
    assert.equal(asset.compiledFromSkillId, skill.id);
  }

  const mot = store.loadAssets().find((asset) => asset.kind === 'MOT')!;
  assert.equal(mot.payload.motionId, 'MOT-HUG');
  assert.ok(mot.payload.padMatch, 'MOT 应带 PAD 匹配基线');

  // 需要确认的技能不自动固化
  const guarded = makeSkill('SKL-guard-001', {
    boundary: { requiresConfirm: true, costLevel: 'medium', forbiddenContexts: [] },
  });
  store.saveSkill(guarded);
  assert.equal(maybeFreezeSkill(store, guarded, config, now).frozen, false);

  assert.deepEqual(
    new Set(store.loadAssets().map((asset) => asset.kind)),
    new Set(['MAC', 'CON', 'CMB', 'MOT']),
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('P5 资产失败两次后持久化回退到技能态', async () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const now = '2026-11-02T10:00:00.000Z';
  const skill = makeSkill('SKL-fail-001', {
    status: 'frozen',
    requiredTools: ['demo.tool'],
    steps: [
      { order: 1, description: '调用演示工具', tool: 'demo.tool', argsTemplate: { value: 1 }, onFailure: 'abort' },
    ],
  });
  store.saveSkill(skill);
  const asset: AssetPackage = {
    id: 'CON-fail-001-v1',
    kind: 'CON',
    name: '失败资产',
    compiledFromSkillId: skill.id,
    payload: { requiredTools: skill.requiredTools, steps: skill.steps, boundary: skill.boundary },
    rollbackVersion: 0,
    status: 'active',
    createdAt: now,
    schemaVersion: 1,
  };
  store.saveAsset(asset);
  store.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const calls: Array<Record<string, unknown>> = [];
  const ctx: PluginContext = {
    ...makeCtx('s-asset'),
    tools: {
      invoke: async (_tool, args) => {
        calls.push(args);
        throw new Error('boom');
      },
    },
  };

  const first = await plugin.assetInvoke({ ctx, assetId: asset.id, args: { extra: 'x' } });
  assert.equal(first.ok, false);
  assert.equal(first.rolledBack, undefined);
  assert.equal(calls[0]!.value, 1, '应使用 argsTemplate 而不是 args 字段');
  assert.equal(calls[0]!.extra, 'x');

  const second = await plugin.assetInvoke({ ctx, assetId: asset.id, args: { extra: 'x' } });
  assert.equal(second.ok, false);
  assert.equal(second.rolledBack, true, '连续两次失败应回退');

  plugin.close();

  const check = new Store(root, 'daughter-default');
  const rolledBack = check.loadAsset(asset.id)!;
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.rollbackVersion, 1);
  assert.equal(check.loadSkills().find((item) => item.id === skill.id)!.status, 'active', '技能应回到 active');
  assert.ok(
    check.listEvolution(10).some((entry) => entry.target === 'asset' && entry.after.status === 'rolled_back'),
    '回退应写入演化日志',
  );

  check.close();
  rmSync(root, { recursive: true, force: true });
});

test('P5 动作包资产经 motionPlay 输出', async () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();
  const skill = makeSkill('SKL-mot-play-001', {
    requiredTools: ['motion.play'],
    steps: [
      {
        order: 1,
        description: '摸摸头',
        tool: 'motion.play',
        argsTemplate: { motionId: 'MOT-PAT' },
        onFailure: 'abort',
      },
    ],
  });
  store.saveSkill(skill);
  const freeze = maybeFreezeSkill(store, skill, config, '2026-11-02T10:00:00.000Z');
  assert.equal(freeze.frozen, true);
  store.close();

  const motions: string[] = [];
  const plugin = createDaughterPlugin({
    pluginRoot: root,
    config: makeConfig(),
    onMotion: (motionId) => motions.push(motionId),
  });
  const result = await plugin.assetInvoke({
    ctx: makeCtx('s-mot-asset'),
    assetId: freeze.assetId!,
    args: {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(motions, ['MOT-PAT']);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('P5 反射 event 匹配按来源生效', () => {
  const config = makeConfig();
  const l5: L5State = {
    sessionId: 's',
    characterId: 'daughter-default',
    emotion: { pleasure: 0, arousal: 0, dominance: 0 },
    stress: 0.2,
    safety: 0.7,
    fatigue: 0.2,
    emotionalOverdraft: 0,
    boundary: 0.6,
    activeSubPersonaId: 'alone',
    lastTickAt: '2026-11-02T10:00:00.000Z',
    snapshotAt: '2026-11-02T10:00:00.000Z',
    schemaVersion: 1,
  };
  const rule: ReflexRule = {
    id: 'RFX-EVT-001',
    enabled: true,
    priority: 10,
    cooldownMs: 0,
    match: { type: 'event', source: 'qq' },
    action: { kind: 'template_reply', text: '嗯，我在。' },
  };

  const hit = matchReflex([rule], '随便说点什么', l5, {}, '2026-11-02T10:00:00.000Z', config, 'qq');
  assert.equal(hit?.rule.id, 'RFX-EVT-001');
  assert.equal(matchReflex([rule], '随便说点什么', l5, {}, '2026-11-02T10:00:00.000Z', config, 'chat'), null);
});

test('P7 演化节流：未达 min_turns_between_writes 不写入', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();
  config.evolution.min_turns_between_writes = 20;

  const persona = store.loadPersona();
  const first = applyPersonaDrift(store, config, persona, 1, '2026-11-02T10:00:00.000Z');
  assert.equal(first.changed, false, '第 1 轮不应写入');
  assert.equal(store.listEvolution().length, 0);

  for (let index = 1; index < 20; index += 1) {
    const report = applyPersonaDrift(store, config, store.loadPersona(), 1, `2026-11-02T10:${String(index).padStart(2, '0')}:00.000Z`);
    if (index < 19) assert.equal(report.changed, false);
  }
  assert.equal(store.listEvolution().length, 1, '第 20 轮才写入一次');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§13 运行日志：耗时/注入 token/命中数落盘并计入指标', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-obs');

  await plugin.onUserMessage({ ctx, text: '今天有点累想休息一下', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });

  const runLog = join(root, 'logs', 'run', 'daughter-default.jsonl');
  assert.ok(existsSync(runLog), '运行日志应落盘');
  const entries = readFileSync(runLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.sessionId, 's-obs');
  assert.equal(entry.turnId, ctx.turnId);
  assert.equal(entry.injectTokens, result.usedTokens);
  assert.equal(entry.hits, 0);
  assert.equal(entry.memoryHit, false);
  assert.equal(entry.degraded, false, 'FTS 可用且未裁剪时不应降级');
  assert.ok((entry.tookMs as number) >= 0);

  const first = plugin.metrics('daughter-default');
  assert.equal(first.turns, 1);
  assert.equal(first.memoryHitRate, 0);
  assert.equal(first.injectTokenP95, result.usedTokens);
  plugin.close();

  // 指标跨进程重启延续
  const again = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx2 = makeCtx('s-obs-2');
  await again.onUserMessage({ ctx: ctx2, text: '在吗', source: 'chat' });
  await again.beforePromptBuild({ ctx: ctx2, tokenBudget: 3000 });
  const second = again.metrics('daughter-default');
  assert.equal(second.turns, 2, '重启后应在已有计数上累加');
  assert.ok(existsSync(join(root, 'logs', 'metrics', 'daughter-default.json')));

  again.close();
  rmSync(root, { recursive: true, force: true });
});

test('§13 降级率：短查询退 Dice 记为检索降级', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });

  const shortCtx = makeCtx('s-degrade-short');
  await plugin.onUserMessage({ ctx: shortCtx, text: '你好', source: 'chat' });
  await plugin.beforePromptBuild({ ctx: shortCtx, tokenBudget: 400 });

  const longCtx = makeCtx('s-degrade-long');
  await plugin.onUserMessage({ ctx: longCtx, text: '今天和同事因为排期吵架了', source: 'chat' });
  await plugin.beforePromptBuild({ ctx: longCtx, tokenBudget: 400 });

  const runLog = join(root, 'logs', 'run', 'daughter-default.jsonl');
  const entries = readFileSync(runLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { degraded: boolean });
  assert.equal(entries[0]!.degraded, true, '2 字查询应记为检索降级');
  assert.equal(entries[1]!.degraded, false, '长查询走 FTS 不应降级');

  const metrics = plugin.metrics('daughter-default');
  assert.equal(metrics.turns, 2);
  assert.equal(metrics.degradeRate, 0.5);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('§13 反射日志：命中规则与动作结果落盘，命中率按轮次计算', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-reflex-log');

  const { l5 } = await plugin.onUserMessage({ ctx, text: '你好', source: 'chat' });
  await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });
  const hit = await plugin.reflexMatch({ ctx, userText: '你好', l5 });
  assert.equal(hit?.ruleId, 'RFX-001');

  const reflexLog = join(root, 'logs', 'reflex', 'daughter-default.jsonl');
  assert.ok(existsSync(reflexLog), '反射日志应落盘');
  const entries = readFileSync(reflexLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.ruleId, 'RFX-001');
  assert.equal(entries[0]!.actionKind, 'template_reply');
  assert.equal(entries[0]!.ok, true);
  assert.ok((entries[0]!.tookMs as number) >= 0);

  const metrics = plugin.metrics('daughter-default');
  assert.equal(metrics.reflexHits, 1);
  assert.equal(metrics.reflexHitRate, 1);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('§13 日志轮转：超过体积上限只保留一个 .1 备份', () => {
  const root = makeRoot();
  const observer = new Observability(root, 'daughter-default', { maxLogBytes: 400 });

  for (let index = 0; index < 12; index += 1) {
    observer.recordTurn({
      at: new Date().toISOString(),
      sessionId: `s-rotate-${index}`,
      turnId: `turn-${index}`,
      characterId: 'daughter-default',
      tookMs: 12,
      injectTokens: 300,
      hits: 1,
      skills: 0,
      memoryHit: true,
      degraded: false,
    });
  }

  const dir = join(root, 'logs', 'run');
  const current = join(dir, 'daughter-default.jsonl');
  assert.ok(existsSync(join(dir, 'daughter-default.1.jsonl')), '超限后应生成 .1 备份');
  assert.ok(statSync(current).size < 800, '当前文件最多超出约一行，不应无限增长');
  assert.ok(!existsSync(join(dir, 'daughter-default.2.jsonl')), '只保留一个备份');

  rmSync(root, { recursive: true, force: true });
});

test('§6.3 after_response 幂等：同一轮重复调用只写一条事件', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const store = new Store(root, 'daughter-default');
  const ctx = makeCtx('s-idem');

  await plugin.onUserMessage({ ctx, text: '今天去看了电影', source: 'chat' });
  const first = await plugin.afterResponse({ ctx, userText: '今天去看了电影', assistantText: '好看吗？' });
  const afterFirst = store.listAllEvents().length;
  const second = await plugin.afterResponse({ ctx, userText: '今天去看了电影', assistantText: '好看吗？' });

  assert.ok(first.eventId, '首次调用应写入事件');
  assert.equal(second.eventId, undefined, '同一 (sessionId, turnId) 重复调用应跳过');
  assert.equal(store.listAllEvents().length, afterFirst, '重复调用不应再写事件');

  store.close();
  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('§4.2 人格写回：L2/L3/L4 变更落盘并写 evolution 日志', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const store = new Store(root, 'daughter-default');

  for (let index = 0; index < 5; index += 1) {
    await plugin.onUserMessage({ ctx: makeCtx(`s-evolve-${index}`), text: '今天和朋友一起吃饭，聊得很开心', source: 'chat' });
  }

  // 人为制造非归一化权重，验证写回时会被归一化
  const seeded = store.loadPersona();
  store.savePersonaLayer('l3', {
    ...seeded.l3,
    copingStrategies: seeded.l3.copingStrategies.map((strategy) => ({ ...strategy, weight: 3 })),
  });
  store.savePersonaLayer('l4', {
    ...seeded.l4,
    subPersonas: seeded.l4.subPersonas.map((sub) => ({ ...sub, weight: 2 })),
  });

  const result = await plugin.tick({ characterId: 'daughter-default', now: '2026-11-04T00:00:00.000Z' });
  assert.deepEqual([...(result.evolved ?? [])].sort(), ['L2', 'L3', 'L4']);

  const next = store.loadPersona();
  assert.ok(next.l2.relationshipDepth > 0, '关系深度应随互动上升');
  const weightSum = next.l4.subPersonas.reduce((sum, sub) => sum + sub.weight, 0);
  assert.ok(Math.abs(weightSum - 1) < 0.01, `子人格权重应归一化，实际 ${weightSum}`);
  const copingSum = next.l3.copingStrategies.reduce((sum, strategy) => sum + strategy.weight, 0);
  assert.ok(Math.abs(copingSum - 1) < 0.01, `应对策略权重应归一化，实际 ${copingSum}`);

  const targets = store.listEvolution(50).map((entry) => entry.target);
  for (const layer of ['L2', 'L3', 'L4'] as const) {
    assert.ok(targets.includes(layer), `${layer} 变更应写入 evolution 日志`);
  }

  store.close();
  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('§5.4 归档落盘：归档事件写入 archive/ 目录', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const store = new Store(root, 'daughter-default');
  const ctx = makeCtx('s-archive');

  await plugin.afterResponse({ ctx, userText: '昨晚和同事吃了火锅', assistantText: '好吃吗？' });
  const event = store.listAllEvents()[0]!;
  store.updateEventMutable(event.id, { weight: 0.05, lastRecalledAt: event.createdAt });

  await plugin.tick({ characterId: 'daughter-default', now: '2027-03-01T00:00:00.000Z' });

  const path = join(root, 'archive', `${event.id}.json`);
  assert.ok(existsSync(path), '归档文件应写入 archive/');
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { id: string; title: string };
  assert.equal(saved.id, event.id);
  assert.ok(store.listAllEvents().find((item) => item.id === event.id)?.archived, '索引应保留薄记录并置 archived');

  store.close();
  plugin.close();
  rmSync(root, { recursive: true, force: true });
});
