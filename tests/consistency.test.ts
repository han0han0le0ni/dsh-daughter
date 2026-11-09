import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { decideIngest } from '../src/runtime/filter.js';
import { NO_MATCH_CONSTRAINT, NO_MEMORY_CONSTRAINT } from '../src/runtime/content.js';
import { SURPRISE_REASON, applySurprise, retrieveEvents } from '../src/runtime/memory.js';
import { sentimentPolarity } from '../src/runtime/state.js';
import { silentLogger } from '../src/util.js';
import type { DaughterConfig, EventRecord, EventLink, PluginContext } from '../src/types.js';

const CHAR = 'daughter-default';
const NOW = '2026-11-09T10:00:00.000Z';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-consistency-'));
}

function makeConfig(patch: (config: DaughterConfig) => void = () => {}): DaughterConfig {
  const config = structuredClone(defaultConfig);
  config.random_surprise_enabled = false;
  config.speak.enabled = false;
  config.expression.enabled = false;
  patch(config);
  return config;
}

let turn = 0;

function makeCtx(sessionId: string, now = NOW): PluginContext {
  turn += 1;
  return {
    characterId: CHAR,
    sessionId,
    workspaceId: 'ws-1',
    turnId: `turn-${turn}`,
    now: () => now,
    logger: silentLogger,
    tools: { invoke: async () => null },
  };
}

function minutesBefore(from: string, minutes: number): string {
  return new Date(Date.parse(from) - minutes * 60_000).toISOString();
}

interface EventOptions {
  title?: string;
  summary?: string;
  createdAt?: string;
  weight?: number;
  source?: EventRecord['source'];
  links?: EventLink[];
}

function makeEvent(id: string, options: EventOptions = {}): EventRecord {
  return {
    id,
    characterId: CHAR,
    title: options.title ?? '一起聊了会儿天',
    summary: options.summary ?? '聊了点日常的事',
    tags: ['对话'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0.1, arousal: 0.1, dominance: 0, intensity: 0.2 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: options.weight ?? 0.5,
    links: options.links ?? [],
    source: options.source ?? 'chat',
    createdAt: options.createdAt ?? NOW,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

function constraintOf(blocks: Array<{ kind: string; text: string }>): string | undefined {
  return blocks.find((block) => block.kind === 'constraint')?.text;
}

/* ---------------- 1. 无记忆约束：空库 vs 库非空零命中 ---------------- */

test('空事件库才注入「没有任何共同经历记录」', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-empty');

  await plugin.onUserMessage({ ctx, text: '你好', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });

  assert.equal(constraintOf(result.blocks), NO_MEMORY_CONSTRAINT);
  assert.equal(result.memoryHit, false);
  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('库里有记忆但本轮零命中：只说没检索到，不谎称没有任何记录', async () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  // 40 天前：超出 7 天续接窗口，确保这一轮真的零命中、零续接
  store.addEvent(makeEvent('EVT-OLD', {
    title: '一起去了海边',
    summary: '那天风很大，我们沿着海边走了很久',
    createdAt: minutesBefore(NOW, 40 * 1440),
  }));
  store.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-nomatch');
  await plugin.onUserMessage({ ctx, text: '量子纠缠到底是什么', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });

  const constraint = constraintOf(result.blocks);
  assert.equal(constraint, NO_MATCH_CONSTRAINT);
  assert.equal(constraint?.includes('没有任何与用户相关的共同经历记录'), false);
  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('检索命中时没有约束块，memoryHit 为真', async () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-HIT', {
    title: '周末火锅',
    summary: '周末一起去吃了顿火锅',
    createdAt: minutesBefore(NOW, 60),
  }));
  store.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-hit');
  await plugin.onUserMessage({ ctx, text: '周末火锅', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });

  assert.equal(constraintOf(result.blocks), undefined);
  assert.equal(result.memoryHit, true);
  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('首轮续接也算「有记忆可看」：memoryHit 与注入内容同口径', async () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-RECENT', {
    title: '上周的星空',
    summary: '一起看了很久的星星',
    createdAt: minutesBefore(NOW, 120),
  }));
  store.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-first-turn');
  await plugin.onUserMessage({ ctx, text: '随便聊点别的吧', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });

  assert.equal(result.memoryHit, true, '续接条目进了事件块，就不该报「没有命中」');
  assert.equal(constraintOf(result.blocks), undefined);
  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

/* ---------------- 2. 随机联想不算真实召回 ---------------- */

test('概率联想条目不写 recallCount，低价值事件仍可被忘却', async () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-RAND', {
    title: '很早以前的琐事',
    summary: '一条几乎不会被想起的记录',
    createdAt: minutesBefore(NOW, 2 * 1440),
  }));
  store.close();

  const config = makeConfig((c) => {
    c.random_surprise_enabled = true;
    c.retrieval.surprise_eta = 1;
  });
  const plugin = createDaughterPlugin({ pluginRoot: root, config });
  const ctx = makeCtx('s-surprise');
  await plugin.onUserMessage({ ctx, text: '说点完全不相干的话', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });

  const digest = result.blocks.find((block) => block.kind === 'event_digest')?.text ?? '';
  assert.ok(digest.includes('EVT-RAND'), '随机联想确实被注入了，用例前提成立');

  await plugin.afterResponse({ ctx, userText: '说点完全不相干的话', assistantText: '嗯。', toolsUsed: [] });
  plugin.close();

  const after = new Store(root, CHAR);
  assert.equal(after.getEvent('EVT-RAND')?.recallCount, 0, '随机抽中不等于被想起，不该被 recallCount 永久保活');
  after.close();
  rmSync(root, { recursive: true, force: true });
});

test('applySurprise 用可识别的 reason 标记随机条目', () => {
  const config = makeConfig((c) => {
    c.random_surprise_enabled = true;
    c.retrieval.surprise_eta = 1;
  });
  const candidate = makeEvent('EVT-S', { createdAt: minutesBefore(NOW, 60) });
  const hits = applySurprise([], [candidate], config, () => 0, NOW);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.reason, SURPRISE_REASON);
});

/* ---------------- 3. L1 漂移与 L5 共用极性口径 ---------------- */

test('「不开心」在 L1 漂移与 L5 情绪里同为负，不再反号', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-tone');

  assert.ok(sentimentPolarity('今天不开心') < 0, '用例前提：新识别器判负');
  await plugin.onUserMessage({ ctx, text: '今天不开心', source: 'chat' });
  await plugin.afterResponse({ ctx, userText: '今天不开心', assistantText: '嗯。', toolsUsed: [] });
  plugin.close();

  const store = new Store(root, CHAR);
  const toneAvg = Number(store.getMeta('toneAvg') ?? 0);
  store.close();
  assert.ok(toneAvg < 0, `语气均值应与 L5 极性同号，实际 ${toneAvg}`);
  rmSync(root, { recursive: true, force: true });
});

/* ---------------- 4. linkProximity 只由已命中事件决定 ---------------- */

test('链接邻近度不再由未过门禁的候选决定，命中之间的邻近度仍生效', () => {
  const config = makeConfig();
  const currentEmotion = { pleasure: 0.1, arousal: 0.1, dominance: 0 };
  // 三条事件的字面都不含查询词，语义分完全由 ftsScores 控制
  const missed = makeEvent('EVT-MISSED', {
    title: '别的事', summary: '和当前话题无关', weight: 1, createdAt: NOW,
  });
  const anchor = makeEvent('EVT-ANCHOR', {
    title: '那次聚餐', summary: '记得那回一起吃饭', weight: 0.5, createdAt: NOW,
  });
  const linked = makeEvent('EVT-LINKED', {
    title: '那家店', summary: '后来又提过一次', weight: 0.5, createdAt: NOW,
  });
  // 旧口径下 semantic=0 / weight=1 的 missed 会按 semantic*0.42+weight*0.16 排到首位
  const fts = () => new Map([[anchor.id, 0.05], [linked.id, 0.05]]);
  const base = {
    characterId: CHAR,
    query: '火锅',
    now: NOW,
    topK: 5,
    currentEmotion,
    excludeArchived: true,
    config,
    ftsScores: fts,
  } as const;

  const plain = retrieveEvents({ ...base, candidates: [missed, anchor, linked] });
  const linkedToMissed = retrieveEvents({
    ...base,
    candidates: [missed, anchor, { ...linked, links: [{ targetId: missed.id, kind: 'topic', strength: 0.9 }] }],
  });
  const linkedToAnchor = retrieveEvents({
    ...base,
    candidates: [missed, anchor, { ...linked, links: [{ targetId: anchor.id, kind: 'topic', strength: 0.9 }] }],
  });

  assert.ok(plain.some((hit) => hit.event.id === linked.id), '用例前提：linked 过了门禁');
  assert.ok(!plain.some((hit) => hit.event.id === missed.id), '用例前提：missed 没过语义门禁');
  assert.equal(
    linkedToMissed.find((hit) => hit.event.id === linked.id)?.score,
    plain.find((hit) => hit.event.id === linked.id)?.score,
    '连到一条根本没注入的事件，不该加分',
  );
  assert.ok(
    (linkedToAnchor.find((hit) => hit.event.id === linked.id)?.score ?? 0) >
      (plain.find((hit) => hit.event.id === linked.id)?.score ?? 0),
    '连到已命中锚点仍应有 0.6 邻近度加分',
  );
});

/* ---------------- 5. 滤网的 recent 是时间窗内最近 N 条 ---------------- */

test('事件超过 80 条时，爆发抑制仍能看见刚发生的新事件', () => {
  const root = makeRoot();
  const config = makeConfig();
  const store = new Store(root, CHAR);

  // 80 条高权重旧事件：旧口径 listCandidates(权重前 80) 会全部被它们占满
  for (let i = 0; i < 80; i += 1) {
    store.addEvent(makeEvent(`OLD-${i}`, {
      title: `很久以前的第 ${i} 条`,
      summary: '早就过去的事',
      weight: 1,
      source: 'douyin_content',
      createdAt: minutesBefore(NOW, 20 * 60),
    }));
  }
  // 3 条低权重、但刚发生的同源事件
  for (let i = 0; i < 3; i += 1) {
    store.addEvent(makeEvent(`NEW-${i}`, {
      title: `刚刷到第 ${i} 条`,
      summary: '刚刚发生的事',
      weight: 0.01,
      source: 'douyin_content',
      createdAt: minutesBefore(NOW, 30 - i),
    }));
  }

  const byWeight = store.listCandidates(false, 80);
  assert.equal(byWeight.some((event) => event.id.startsWith('NEW-')), false, '旧口径确实把新事件挤出候选');

  const windowMinutes = Math.max(
    config.filter.habituation.window_minutes,
    config.filter.habituation.identical_window_minutes,
    config.filter.burst.window_minutes,
  );
  const recent = store.listRecentEvents(minutesBefore(NOW, windowMinutes), 80);
  const decision = decideIngest(
    makeEvent('NEXT', {
      title: '又刷到一条新的',
      summary: '紧接着发生的事',
      source: 'douyin_content',
      createdAt: NOW,
    }),
    recent,
    config,
    NOW,
  );
  assert.equal(decision.action, 'drop', '按时间窗取最近事件，第四条同源输入应被爆发抑制拦下');

  store.close();
  rmSync(root, { recursive: true, force: true });
});
