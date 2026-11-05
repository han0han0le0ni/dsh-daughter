import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createInitialL5, sentimentPolarity, sentimentStrength, updateL5 } from '../src/runtime/state.js';
import { relaxL5 } from '../src/runtime/maintenance.js';
import { linkNewEvent } from '../src/runtime/memory.js';
import type { DaughterConfig, EventRecord, L5State } from '../src/types.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-emotion-'));
}

function makeConfig(): DaughterConfig {
  const config = structuredClone(defaultConfig);
  config.random_surprise_enabled = false;
  return config;
}

let seq = 0;

function makeEvent(store: Store, overrides: Partial<EventRecord> = {}): EventRecord {
  seq += 1;
  const base: EventRecord = {
    id: `EVT-20261105-${String(seq).padStart(6, '0')}`,
    characterId: store.characterId,
    workspaceId: 'ws-1',
    createdAt: '2026-11-05T10:00:00.000Z',
    source: 'chat',
    kind: 'dialogue',
    title: '测试事件',
    summary: '测试用事件摘要',
    tags: ['测试'],
    participants: ['self', 'user'],
    place: null,
    emotionAtTime: { pleasure: 0.1, arousal: 0, dominance: 0, intensity: 0.3 },
    emotionNowHistory: [],
    salience: 0.6,
    weight: 0.5,
    importance: 0.5,
    links: [],
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
    ...overrides,
  };
  store.addEvent(base);
  return base;
}

test('§8.3 情绪极性：负面句为负，单字寒暄的强度远低于真实情绪表达', () => {
  assert.ok(sentimentPolarity('今天有点累，压力好大') < 0, '负面句应得负极性');

  // "你好"只是单字命中（权重 0.35），"太好了"是多字命中（权重 1）
  assert.ok(sentimentPolarity('你好') > 0, '单字命中仍算正面');
  assert.ok(sentimentStrength('你好') < sentimentStrength('特别开心'), '单字寒暄的强度应更低');
  assert.ok(sentimentStrength('你好') < 0.25, `寒暄强度应很小，实际 ${sentimentStrength('你好')}`);
});

test('§8.3 情绪推进：连续负面输入让 pleasure 落到负半轴', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const persona = store.loadPersona()!;

  let l5: L5State = createInitialL5('daughter-default', 's-1', '2026-11-05T09:00:00.000Z', persona, 0);
  for (let index = 0; index < 3; index += 1) {
    l5 = updateL5(l5, '今天好累，压力好大，有点难受', '2026-11-05T10:00:00.000Z', persona);
  }
  assert.ok(l5.emotion.pleasure < 0, `pleasure 应变负，实际 ${l5.emotion.pleasure}`);
  assert.ok(l5.stress > 0.2, 'stress 应因压力词上升');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§8.3 情感回落：闲置足够久时 safety/stress 向基线回归', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();

  const l5 = createInitialL5('daughter-default', 's-relax', '2026-11-05T00:00:00.000Z', store.loadPersona()!, 0);
  l5.safety = 1;
  l5.stress = 0;
  l5.fatigue = 0.95;
  l5.lastTickAt = '2026-11-05T00:00:00.000Z';
  store.saveL5(l5);

  const changed = relaxL5(store, config, '2026-11-05T10:00:00.000Z');
  assert.equal(changed, 1, '应回落 1 个会话');

  const after = store.loadL5('s-relax')!;
  assert.ok(after.safety < 1, `safety 应从 1.0 回落，实际 ${after.safety}`);
  assert.ok(after.stress > 0, `stress 应从 0 向基线 0.2 回升，实际 ${after.stress}`);
  assert.ok(after.fatigue < 0.95, `fatigue 应回落，实际 ${after.fatigue}`);
  // lastTickAt 不能被回落本身刷新，否则下一轮 idle 会被自己清零
  assert.equal(after.lastTickAt, '2026-11-05T00:00:00.000Z');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§8.3 情感回落：闲置不足 idle_hours 时不动', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();

  const l5 = createInitialL5('daughter-default', 's-fresh', '2026-11-05T09:50:00.000Z', store.loadPersona()!, 0);
  l5.safety = 1;
  l5.lastTickAt = '2026-11-05T09:50:00.000Z';
  store.saveL5(l5);

  assert.equal(relaxL5(store, config, '2026-11-05T10:00:00.000Z'), 0);
  assert.equal(store.loadL5('s-fresh')!.safety, 1);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§8.5 关联图：单条事件出边不超过 12 条', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');

  const target = makeEvent(store, { tags: ['火锅'], participants: ['self', 'user'] });
  const fat = makeEvent(store, { tags: ['火锅'], participants: ['self', 'user'] });
  // 手工把目标灌满出边
  store.updateEventMutable(target.id, {
    links: Array.from({ length: 12 }, (_, index) => ({
      targetId: `EVT-filler-${index}`,
      kind: 'topic' as const,
      strength: 1,
      createdAt: '2026-11-05T09:00:00.000Z',
    })),
  });

  const created = linkNewEvent(store, store.listAllEvents().find((event) => event.id === fat.id)!, 3);
  assert.equal(created, 0, '已满 12 条出边的事件不再建链');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§5.4 归档摘链：detachLinks 清掉指向已归档事件的引用', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');

  const a = makeEvent(store, { title: '事件 A' });
  const b = makeEvent(store, { title: '事件 B' });
  store.updateEventMutable(b.id, {
    links: [{ targetId: a.id, kind: 'topic', strength: 1, createdAt: '2026-11-05T09:00:00.000Z' }],
  });

  const touched = store.detachLinks([a.id]);
  assert.equal(touched, 1, '应清理 1 条事件的引用');
  assert.equal(store.listAllEvents().find((event) => event.id === b.id)!.links.length, 0);

  store.close();
  rmSync(root, { recursive: true, force: true });
});
