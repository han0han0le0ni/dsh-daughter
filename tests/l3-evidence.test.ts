import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { evolvePersona } from '../src/runtime/maintenance.js';
import { Store } from '../src/store.js';
import type { EventRecord } from '../src/types.js';

const CHAR = 'daughter-default';
const DAY = 86_400_000;
const NOW = '2026-11-10T10:00:00.000Z';

function withStore(run: (store: Store) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'dsh-l3-evidence-'));
  const store = new Store(root, CHAR);
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

let seq = 0;
function makeEvent(pleasure: number, at: string): EventRecord {
  seq += 1;
  return {
    id: `EVT-L3-${seq}`,
    characterId: CHAR,
    title: `第 ${seq} 次相处`,
    summary: '一段普通的相处',
    tags: ['对话'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure, arousal: 0.2, dominance: 0, intensity: Math.abs(pleasure) },
    emotionNowHistory: [],
    importance: 0.6,
    weight: 0.6,
    links: [],
    source: 'chat',
    createdAt: at,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

/** 一批同向事件：同一时间的 3 条，模拟"这阵子都还不错" */
function addBatch(store: Store, pleasure: number, at: string): void {
  for (let index = 0; index < 3; index += 1) store.addEvent(makeEvent(pleasure, at));
}

test('DEF-08 单批事件只写证据、不动防御成熟度', () => {
  withStore((store) => {
    addBatch(store, 0.4, '2026-11-10T06:00:00.000Z');
    const before = store.loadPersona().l3.defenseMaturity;

    const changed = evolvePersona(store, NOW, defaultConfig);
    const l3 = store.loadPersona().l3;
    assert.equal(l3.defenseMaturity, before, '单批事件不能改权重');
    assert.equal(changed.includes('L3'), false);
    const evidence = (l3.evidence ?? []).filter((entry) => entry.layer === 'L3');
    assert.equal(evidence.length, 1, '应留下一条 delta=0 的证据');
    assert.equal(evidence[0]!.delta, 0);
    assert.ok(evidence[0]!.impact > 0);
  });
});

test('DEF-08 同向重复达到 N 次才转正，并写演化日志', () => {
  withStore((store) => {
    const before = store.loadPersona().l3.defenseMaturity;
    const step = defaultConfig.personality.l3_evidence_step;

    addBatch(store, 0.4, '2026-11-09T06:00:00.000Z');
    evolvePersona(store, NOW, defaultConfig);
    addBatch(store, 0.4, '2026-11-09T18:00:00.000Z');
    evolvePersona(store, new Date(Date.parse(NOW) + DAY).toISOString(), defaultConfig);
    assert.equal(store.loadPersona().l3.defenseMaturity, before, '两次同向还不够');

    addBatch(store, 0.4, '2026-11-10T02:00:00.000Z');
    const changed = evolvePersona(store, new Date(Date.parse(NOW) + 2 * DAY).toISOString(), defaultConfig);

    const l3 = store.loadPersona().l3;
    assert.equal(l3.defenseMaturity, Math.round((before + step) * 1000) / 1000, '第三次同向证据应转正');
    assert.ok(changed.includes('L3'));
    const applied = (l3.evidence ?? []).filter((entry) => entry.layer === 'L3' && entry.delta !== 0);
    assert.equal(applied.length, 1, '转正要留一条带 delta 的证据');
    const evolution = store.listEvolution(50).filter((entry) => entry.target === 'L3');
    assert.equal(evolution.length, 1, '应有 L3 演化日志供回滚');
    assert.equal(evolution[0]!.before.defenseMaturity, before);
  });
});

test('DEF-08 方向不一致的证据不推动权重', () => {
  withStore((store) => {
    const before = store.loadPersona().l3.defenseMaturity;
    addBatch(store, 0.4, '2026-11-09T06:00:00.000Z');
    evolvePersona(store, NOW, defaultConfig);
    addBatch(store, 0.4, '2026-11-09T18:00:00.000Z');
    evolvePersona(store, new Date(Date.parse(NOW) + DAY).toISOString(), defaultConfig);
    addBatch(store, -0.5, '2026-11-10T02:00:00.000Z');
    evolvePersona(store, new Date(Date.parse(NOW) + 2 * DAY).toISOString(), defaultConfig);

    const l3 = store.loadPersona().l3;
    assert.equal(l3.defenseMaturity, before, '两正一负不是同向模式，不能动权重');
    assert.equal((l3.evidence ?? []).filter((entry) => entry.layer === 'L3').length, 3);
  });
});

