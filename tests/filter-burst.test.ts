import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { decideIngest } from '../src/runtime/filter.js';
import { reconstructOnRecall } from '../src/runtime/memory.js';
import { Store } from '../src/store.js';
import type { DaughterConfig, EventRecord, L5State } from '../src/types.js';

const NOW = '2026-11-06T10:00:00.000Z';

function makeConfig(): DaughterConfig {
  return structuredClone(defaultConfig);
}

function makeEvent(
  id: string,
  source: EventRecord['source'],
  createdAt: string,
  title = '刷抖音刷到一条视频：星空',
): EventRecord {
  return {
    id,
    characterId: 'daughter-default',
    title,
    summary: '刷到了 @星空 的一条视频，看了两遍',
    tags: ['生活'],
    participants: ['self'],
    emotionAtTime: { pleasure: 0.098, arousal: 0, dominance: 0, intensity: 0.14 },
    emotionNowHistory: [],
    importance: 0.4,
    weight: 0.5,
    links: [],
    source,
    createdAt,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

test('同源爆发：非对话来源超过配额即丢弃', () => {
  const config = makeConfig();
  const recent = [
    makeEvent('EVT-1', 'douyin_content', '2026-11-06T09:50:00.000Z'),
    makeEvent('EVT-2', 'douyin_content', '2026-11-06T09:40:00.000Z'),
    makeEvent('EVT-3', 'douyin_content', '2026-11-06T09:30:00.000Z'),
  ];
  const decision = decideIngest(makeEvent('EVT-4', 'douyin_content', NOW), recent, config, NOW);

  assert.equal(decision.action, 'drop', '一小时里第四条抖音不该再入库');
  assert.match(decision.reason, /同源「douyin_content」/);
  assert.match(decision.reason, /爆发抑制/);
});

test('同源爆发：对话来源不受配额限制', () => {
  const config = makeConfig();
  const recent = [
    makeEvent('CHAT-1', 'chat', '2026-11-06T09:58:00.000Z', '今天有点累'),
    makeEvent('CHAT-2', 'chat', '2026-11-06T09:56:00.000Z', '晚饭吃了吗'),
    makeEvent('CHAT-3', 'chat', '2026-11-06T09:54:00.000Z', '我换了新工作'),
    makeEvent('CHAT-4', 'chat', '2026-11-06T09:52:00.000Z', '周末去看房子'),
  ];
  const decision = decideIngest(makeEvent('CHAT-5', 'chat', NOW, '她回了很长一段'), recent, config, NOW);

  assert.equal(decision.action, 'keep', '真人对话连着说五句也是真实发生过的事，不该被限流');
});

test('同源爆发：窗口之外的不计入配额', () => {
  const config = makeConfig();
  const recent = [
    makeEvent('OLD-1', 'douyin_content', '2026-11-06T07:00:00.000Z', '刷到阿猫的视频'),
    makeEvent('OLD-2', 'douyin_content', '2026-11-06T06:00:00.000Z', '刷到阿狗的视频'),
    makeEvent('OLD-3', 'douyin_content', '2026-11-06T05:00:00.000Z', '刷到阿鸟的视频'),
  ];
  const decision = decideIngest(
    makeEvent('NEW-1', 'douyin_content', NOW, '刷到阿鱼的视频'),
    recent,
    config,
    NOW,
  );

  assert.equal(decision.action, 'keep', '五小时前的三条不该把现在的这条顶掉');
});

test('回忆重构的门槛是配置项，默认档在真实分布内可达', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reconstruct-'));
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();
  const event = makeEvent('EVT-EMO', 'chat', '2026-11-01T10:00:00.000Z', '一次大吵');
  store.addEvent(event);

  // PAD 距离 = 0.0417：低于默认 0.08，高于 0.03
  const l5 = { emotion: { pleasure: 0.35, arousal: 0, dominance: 0 } } as L5State;
  assert.equal(
    reconstructOnRecall(store, event, l5, NOW, config.retrieval.reconstruct_distance),
    false,
    '默认门槛下这点位移还不够写回看感受',
  );
  assert.equal(reconstructOnRecall(store, event, l5, NOW, 0.03), true, '调小门槛后应写入');
  assert.equal(store.getEvent(event.id)?.emotionNowHistory.length, 1);

  store.close();
  rmSync(root, { recursive: true, force: true });
});
