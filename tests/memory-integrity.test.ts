import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultConfig } from '../src/config.js';
import { runTick } from '../src/runtime/maintenance.js';
import { Store } from '../src/store.js';
import type { DaughterConfig, EventRecord } from '../src/types.js';

const CHAR = 'daughter-default';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-integrity-'));
}

function dbPath(root: string): string {
  return join(root, 'brain', 'hippocampus', 'index', 'memory.db');
}

function makeEvent(id: string, title: string, summary: string): EventRecord {
  return {
    id,
    characterId: CHAR,
    title,
    summary,
    tags: ['生活'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0.2, arousal: 0, dominance: 0, intensity: 0.3 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: 'chat',
    createdAt: '2026-11-01T10:00:00.000Z',
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

function makeConfig(): DaughterConfig {
  const config = structuredClone(defaultConfig);
  config.random_surprise_enabled = false;
  return config;
}

test('FTS 多词查询走交集，不再被当成一整句短语', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-1', '今天下雨了心情不太好', '下班路上被雨淋了，回家有点低落'));
  store.addEvent(makeEvent('EVT-2', '周末去打了羽毛球', '和朋友一起打了两小时'));

  // 空格分开的两个词：正文里从来没有"下雨了 心情不太好"这种带空格的连续串，
  // 按整句短语查必然 0 命中，这是原来的缺陷
  const multi = store.searchFts('下雨了 心情不太好');
  assert.equal(multi.has('EVT-1'), true, '两个词都出现在同一条事件里，应该命中');
  assert.equal(multi.has('EVT-2'), false);

  // 不带空格的查询仍然是子串语义
  assert.equal(store.searchFts('下雨了心情').has('EVT-1'), true);
  // 少于 3 个字符：trigram 建不出索引，交给 Dice 兜底（这里应返回空）
  assert.equal(store.searchFts('下雨').size, 0);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('权重更新不重写全文索引：触发器只绑文本列', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-1', '你好呀老朋友', '很久没见了'));

  const raw = new DatabaseSync(dbPath(root), { readOnly: true });
  const trigger = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'events_fts_au'").get() as unknown as {
    sql: string;
  };
  raw.close();
  assert.match(trigger.sql, /UPDATE OF title, summary, tags/);

  store.updateEventDecay('EVT-1', 0.3, false);
  assert.equal(store.searchFts('你好呀').has('EVT-1'), true, '改权重后索引仍应可用');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('索引丢失时重开自动修复，新建库才标记为首次建库', () => {
  const root = makeRoot();
  const first = new Store(root, CHAR);
  assert.equal(first.ftsRebuilt, 'created');
  first.addEvent(makeEvent('EVT-1', '你好呀老朋友', '很久没见了'));
  assert.equal(first.searchFts('你好呀').has('EVT-1'), true);
  first.close();

  const raw = new DatabaseSync(dbPath(root));
  raw.exec("INSERT INTO events_fts(events_fts) VALUES ('delete-all')");
  raw.close();

  const reopened = new Store(root, CHAR);
  assert.equal(reopened.ftsRebuilt, 'repaired', '行数对不上应该自动重建');
  assert.equal(reopened.searchFts('你好呀').has('EVT-1'), true);

  reopened.close();
  rmSync(root, { recursive: true, force: true });
});

test('清空记忆时连全文与归档文件一起删，不留孤儿', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-1', '一起吃了饭', '晚上一起吃了饭'), '完整的问答正文');
  const event = store.getEvent('EVT-1')!;
  store.archiveEvent(event);

  const textFile = join(root, 'brain', 'hippocampus', 'fulltext', CHAR, 'EVT-1.txt');
  const archiveFile = join(root, 'archive', 'EVT-1.json');
  assert.equal(existsSync(textFile), true);
  assert.equal(existsSync(archiveFile), true);

  const cleared = store.clearMemory();
  assert.equal(cleared.events, 1);
  assert.equal(store.countEvents().total, 0);
  assert.equal(existsSync(textFile), false, '全文文件应一并清除');
  assert.equal(existsSync(archiveFile), false, '归档文件应一并清除');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('lastTickAt 是 ISO 字符串时不会把权重算成 NaN', () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-1', '一起吃了饭', '晚上一起吃了饭'));
  // 老库或外部工具可能写 ISO；Number(ISO) 是 NaN，旧实现会让全库权重永久 NaN
  store.setMeta('lastTickAt', '2026-10-30T10:00:00.000Z');

  runTick(store, makeConfig(), '2026-11-06T10:00:00.000Z');

  const event = store.getEvent('EVT-1')!;
  assert.equal(Number.isFinite(event.weight), true, '权重必须是有限数');
  assert.equal(event.weight <= 1 && event.weight >= 0, true);

  store.close();
  rmSync(root, { recursive: true, force: true });
});
