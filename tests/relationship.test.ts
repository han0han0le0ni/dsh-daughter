import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evolvePersona } from '../src/runtime/maintenance.js';
import { reconstructOnRecall } from '../src/runtime/memory.js';
import { Store, DEFAULT_L2 } from '../src/store.js';
import type { EventRecord, L5State } from '../src/types.js';

const CHAR = 'daughter-default';
const NOW = '2026-11-06T10:00:00.000Z';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-rel-'));
}

let seq = 0;
function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  seq += 1;
  return {
    id: `EVT-REL-${seq}`,
    characterId: CHAR,
    title: `聊了第 ${seq} 件事`,
    summary: '说了很久的话，情绪起伏明显',
    tags: ['对话'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0.1, arousal: 0.1, dominance: 0, intensity: 0.2 },
    emotionNowHistory: [],
    importance: 0.6,
    weight: 0.6,
    links: [],
    source: 'chat',
    createdAt: '2026-11-06T09:00:00.000Z',
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
    ...overrides,
  };
}

test('回忆重构：同一条记忆在冷却期内不重复写', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  const event = makeEvent();
  store.addEvent(event);

  const l5 = { emotion: { pleasure: 0.35, arousal: 0.1, dominance: 0 } } as L5State;
  assert.equal(reconstructOnRecall(store, event, l5, NOW, 0.03, 360), true, '首次回看应该记一笔');

  const after = store.getEvent(event.id)!;
  assert.equal(after.emotionNowHistory.length, 1);
  assert.equal(
    reconstructOnRecall(store, after, l5, '2026-11-06T12:00:00.000Z', 0.03, 360),
    false,
    '两小时后还在冷却期，不该再写一条',
  );
  // 过了冷却期、且情绪又变了一截，才该重新记一笔
  const later = store.getEvent(event.id)!;
  const shifted = { emotion: { pleasure: 0.6, arousal: 0.1, dominance: 0 } } as L5State;
  assert.equal(
    reconstructOnRecall(store, later, shifted, '2026-11-06T17:00:00.000Z', 0.03, 360),
    true,
    '过了六小时且情绪位移够大，可以重新记',
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('关系推进：同一天攒够 8 轮也会往前走，不足则不跑', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  for (let i = 0; i < 12; i += 1) store.addEvent(makeEvent());

  store.setMeta('personaTurns', '0');
  const first = evolvePersona(store, NOW);
  const depthAfterFirst = store.loadPersona().l2.relationshipDepth;
  assert.ok(first.includes('L2'), '首次演化应推动关系');
  assert.ok(depthAfterFirst > DEFAULT_L2.relationshipDepth, '有 12 条对话，深度该往上走');

  // 只聊了 4 轮：不到 8 轮、也不到 24 小时，不该再跑
  store.setMeta('personaTurns', '4');
  assert.deepEqual(evolvePersona(store, '2026-11-06T10:30:00.000Z'), []);

  // 攒够 8 轮：同一天里继续推进
  store.setMeta('personaTurns', '8');
  const second = evolvePersona(store, '2026-11-06T11:00:00.000Z');
  assert.ok(second.includes('L2'), '32 轮对话不该只推进一次');
  assert.ok(
    store.loadPersona().l2.relationshipDepth > depthAfterFirst,
    '关系深度应继续上升',
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('关系推进：依恋焦虑越高，靠拢得越快', () => {
  const run = (anxiety: number): number => {
    const root = makeRoot();
    const store = new Store(root, CHAR);
    store.savePersonaLayer('l2', {
      ...DEFAULT_L2,
      attachmentAnxiety: anxiety,
      relationshipDepth: 0.12,
      relationshipStage: 'stranger',
    });
    for (let i = 0; i < 12; i += 1) store.addEvent(makeEvent());
    evolvePersona(store, NOW);
    const depth = store.loadPersona().l2.relationshipDepth;
    store.close();
    rmSync(root, { recursive: true, force: true });
    return depth;
  };

  const calm = run(0.1);
  const anxious = run(0.9);
  assert.ok(anxious > calm, `焦虑型该更快靠近（calm ${calm} vs anxious ${anxious}）`);
  assert.ok(anxious >= 0.15, '焦虑型一轮就该跨过"初识"的 0.15 门槛');
});
