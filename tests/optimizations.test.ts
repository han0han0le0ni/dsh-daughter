import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { decayStaleLinks } from '../src/runtime/maintenance.js';
import { silentLogger } from '../src/util.js';
import type { DaughterConfig, EventLink, EventRecord, PluginContext } from '../src/types.js';

const CHAR = 'daughter-default';
const NOW = '2026-11-10T12:00:00.000Z';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-optimizations-'));
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
  participants?: string[];
  links?: EventLink[];
  lastRecalledAt?: string;
  emotionNowHistory?: EventRecord['emotionNowHistory'];
}

function makeEvent(id: string, options: EventOptions = {}): EventRecord {
  return {
    id,
    characterId: CHAR,
    title: options.title ?? '一起聊了会儿天',
    summary: options.summary ?? '聊了点日常的事',
    tags: ['对话'],
    participants: options.participants ?? ['self', 'user'],
    emotionAtTime: { pleasure: 0, arousal: 0, dominance: 0, intensity: 0 },
    emotionNowHistory: options.emotionNowHistory ?? [],
    importance: 0.5,
    weight: options.weight ?? 0.5,
    links: options.links ?? [],
    source: options.source ?? 'chat',
    createdAt: options.createdAt ?? NOW,
    lastRecalledAt: options.lastRecalledAt,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

/* ---------------- DEF-20：FTS 命中池外放行 ---------------- */

test('FTS 命中但不在权重候选池里的事件也会放行', async (t) => {
  const root = makeRoot();
  const seed = new Store(root, CHAR);
  seed.addEvent(makeEvent('HIGH', { title: '权重很高但和查询无关', weight: 1, createdAt: NOW }));
  seed.addEvent(makeEvent('FTS-1', { title: '星空洞的岩壁', weight: 0.01, createdAt: NOW }));
  seed.addEvent(makeEvent('FTS-2', { title: '星空洞的传说', weight: 0.01, createdAt: NOW }));
  const ftsReady = seed.ftsReady;
  seed.close();
  if (!ftsReady) {
    t.skip('当前 SQLite 不支持 FTS5');
    return;
  }

  const config = makeConfig((c) => {
    c.retrieval.max_candidates = 1;
    c.retrieval.fts_merge_max = 10;
  });
  const plugin = createDaughterPlugin({ pluginRoot: root, config });
  const hits = await plugin.retrieve({
    characterId: CHAR,
    query: '星空洞',
    now: NOW,
    topK: 5,
    currentEmotion: { pleasure: 0, arousal: 0, dominance: 0 },
    excludeArchived: true,
  });
  assert.ok(hits.some((hit) => hit.event.id === 'FTS-1'), '池外 FTS 命中应被放行');
  assert.ok(hits.some((hit) => hit.event.id === 'FTS-2'));
  plugin.close();

  const off = makeConfig((c) => {
    c.retrieval.max_candidates = 1;
    c.retrieval.fts_merge_max = 0;
  });
  const without = createDaughterPlugin({ pluginRoot: root, config: off });
  const noHits = await without.retrieve({
    characterId: CHAR,
    query: '星空洞',
    now: NOW,
    topK: 5,
    currentEmotion: { pleasure: 0, arousal: 0, dominance: 0 },
    excludeArchived: true,
  });
  assert.ok(!noHits.some((hit) => hit.event.id === 'FTS-1'), '关闭合并后应回到旧行为');
  without.close();
  rmSync(root, { recursive: true, force: true });
});

/* ---------------- DEF-02：主动开口写回 ---------------- */

test('主动开口以 self_speech 低权写回，可召回但不推关系', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });

  const before = new Store(root, CHAR);
  before.loadPersona();
  const l2Before = JSON.stringify(before.loadPersona()?.l2 ?? null);
  before.close();

  const recorded = plugin.recordSelfSpeech(CHAR, '夜深了，记得喝水。', NOW);
  assert.ok(recorded);

  const store = new Store(root, CHAR);
  const event = store.listCandidates(false, 10).find((item) => item.source === 'self_speech');
  assert.ok(event, '主动开口应写入事件库');
  assert.deepEqual(event.participants, ['self']);
  assert.equal(event.weight, 0.3);
  const l2After = JSON.stringify(store.loadPersona()?.l2 ?? null);
  store.close();
  assert.equal(l2After, l2Before, '主动开口不推关系');

  const hits = await plugin.retrieve({
    characterId: CHAR,
    query: '喝水',
    now: NOW,
    topK: 5,
    currentEmotion: { pleasure: 0, arousal: 0, dominance: 0 },
    excludeArchived: true,
  });
  assert.ok(hits.some((hit) => hit.event.id === event.id), '说过的话应能被检索到');
  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

/* ---------------- DEF-07：同事件同小时回看去重 ---------------- */

test('同一事件同一小时的回看只保留位移最大一条', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-RECALL', {
    createdAt: minutesBefore(NOW, 60),
    emotionNowHistory: [
      { at: minutesBefore(NOW, 50), emotion: { pleasure: 0.1, arousal: 0, dominance: 0 }, reason: '回忆重构' },
      { at: minutesBefore(NOW, 40), emotion: { pleasure: 0.5, arousal: 0, dominance: 0 }, reason: '回忆重构' },
      { at: minutesBefore(NOW, 30), emotion: { pleasure: 0.15, arousal: 0, dominance: 0 }, reason: '回忆重构' },
    ],
  }));

  assert.equal(store.dedupeEmotionHistory(false), 2);
  assert.equal(store.getEvent('EVT-RECALL')?.emotionNowHistory.length, 3, 'dry-run 不删除');
  assert.equal(store.dedupeEmotionHistory(true), 2);

  const history = store.getEvent('EVT-RECALL')?.emotionNowHistory ?? [];
  assert.equal(history.length, 1);
  assert.equal(history[0]?.emotion.pleasure, 0.5, '保留位移最大的那条');
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/* ---------------- DEF-15：长期未激活边批量降权 ---------------- */

test('40 天没被召回的边批量降权，低于门限摘掉', () => {
  const root = makeRoot();
  const config = makeConfig();
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-LINK', {
    createdAt: minutesBefore(NOW, 40 * 1440),
    lastRecalledAt: minutesBefore(NOW, 40 * 1440),
    links: [
      { targetId: 'T-1', kind: 'topic', strength: 0.5 },
      { targetId: 'T-2', kind: 'topic', strength: 0.03 },
    ],
  }));

  const result = decayStaleLinks(store, config, NOW);
  assert.equal(result.decayed, 2);
  assert.equal(result.removed, 1);

  const links = store.getEvent('EVT-LINK')?.links ?? [];
  assert.equal(links.length, 1);
  assert.ok(Math.abs((links[0]?.strength ?? 0) - 0.45) < 1e-6);
  store.close();
  rmSync(root, { recursive: true, force: true });
});
