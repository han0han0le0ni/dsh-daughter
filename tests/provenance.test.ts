import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { participantsFor } from '../src/runtime/memory.js';
import { Store } from '../src/store.js';
import type { EventRecord } from '../src/types.js';

const CHAR = 'daughter-default';
const NOW = '2026-11-06T10:00:00.000Z';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-provenance-'));
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'EVT-DY-1',
    characterId: CHAR,
    title: '刷抖音刷到一条视频：星空',
    summary: '刷到了 @星空 的一条视频',
    tags: ['生活'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0.098, arousal: 0, dominance: 0, intensity: 0.14 },
    emotionNowHistory: [],
    importance: 0.4,
    weight: 0.5,
    links: [],
    source: 'douyin_content',
    createdAt: NOW,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
    ...overrides,
  };
}

test('演化日志 ID：连续生成不重复，重建 Store 后接着最大号走', () => {
  const root = makeRoot();
  const first = new Store(root, CHAR);
  const ids = [first.newEvolutionId(NOW), first.newEvolutionId(NOW), first.newEvolutionId(NOW)];
  assert.equal(new Set(ids).size, 3, '同一个 Store 里连抽三次必须互不相同');

  for (const id of ids) {
    first.appendEvolution({
      id,
      characterId: CHAR,
      target: 'L1',
      before: {},
      after: {},
      reason: '测试',
      at: NOW,
    });
  }
  first.close();

  // 重建 Store：随机流会从头重放，旧实现到这里必然撞上前面的号
  const second = new Store(root, CHAR);
  const next = second.newEvolutionId(NOW);
  assert.equal(ids.includes(next), false, '重启后的第一条不能撞已有 ID');
  assert.equal(next, 'EVO-20261106-0004');

  second.close();
  rmSync(root, { recursive: true, force: true });
});

test('参与者按来源推导：单向输入不挂 user', () => {
  assert.deepEqual(participantsFor('chat'), ['self', 'user']);
  assert.deepEqual(participantsFor('chat', 'to_father'), ['self', 'to_father']);
  assert.deepEqual(participantsFor('qq'), ['self', 'user']);
  assert.deepEqual(participantsFor('douyin_dm'), ['self', 'user']);
  assert.deepEqual(participantsFor('douyin_content'), ['self'], '刷到的视频里没有用户参与');
  assert.deepEqual(participantsFor('system'), ['self']);
  assert.deepEqual(participantsFor('android'), ['self']);
});

test('存量迁移：已写错的单向事件改回只记自己', () => {
  const root = makeRoot();
  const writer = new Store(root, CHAR);
  writer.addEvent(makeEvent());
  assert.deepEqual(writer.getEvent('EVT-DY-1')?.participants, ['self', 'user']);
  writer.close();

  // 重开即重跑 migrate：抖音/系统/手机事件不该再挂着 user
  const reader = new Store(root, CHAR);
  assert.deepEqual(reader.getEvent('EVT-DY-1')?.participants, ['self']);

  reader.close();
  rmSync(root, { recursive: true, force: true });
});
