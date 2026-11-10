import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, parseLog, replayEvents } from '../scripts/polarity-replay.js';
import type { StoredEventRow } from '../scripts/polarity-replay.js';
import type { PolarityLogEntry } from '../src/types.js';

function entry(overrides: Partial<PolarityLogEntry> = {}): PolarityLogEntry {
  return {
    at: '2026-11-09T10:00:00.000Z',
    characterId: 'daughter-default',
    sessionId: 's',
    turnId: 't1',
    textHash: null,
    hits: [],
    negations: [],
    positives: [],
    negatives: [],
    polarity: 0,
    strength: 0,
    padDelta: { pleasure: 0, arousal: 0, dominance: 0 },
    padAfter: { pleasure: 0, arousal: 0, dominance: 0 },
    source: 'chat',
    ...overrides,
  };
}

test('极性复算：BOM 与坏行只计数，不让整份统计失败', () => {
  const good = JSON.stringify(entry({ polarity: -0.2 }));
  const { entries, invalid } = parseLog(`\uFEFF${good}\n{ 截断行\n\n${good}`);

  assert.equal(entries.length, 2);
  assert.equal(invalid, 1);
});

test('极性复算：负/中性/正分桶按 0.05 带宽，负向占比可解释 77/77 全正', () => {
  const report = buildReport([
    entry({ polarity: -0.2, negatives: ['烦'], strength: 0.2 }),
    entry({ polarity: 0.02 }),
    entry({ polarity: 0.9, positives: ['开心'], strength: 0.5 }),
  ]);

  assert.deepEqual(report.buckets, { negative: 1, neutral: 1, positive: 1 });
  assert.equal(report.negativeShare, 0.333);
  assert.equal(report.words.find((row) => row.word === '烦')?.sign, '负');
  assert.equal(report.words.find((row) => row.word === '开心')?.count, 1);

  const allPositive = buildReport([entry({ polarity: 0.5 }), entry({ polarity: 0.4 })]);
  assert.equal(allPositive.buckets.negative, 0);
  assert.equal(allPositive.negativeShare, 0);
});

test('极性复算：空日志返回零值而不是 NaN', () => {
  const report = buildReport([]);

  assert.equal(report.total, 0);
  assert.equal(report.negativeShare, 0);
  assert.equal(report.meanPolarity, 0);
  assert.equal(report.meanStrength, 0);
  assert.deepEqual(report.daily, []);
});

function row(overrides: Partial<StoredEventRow> = {}): StoredEventRow {
  return {
    id: 'e1',
    title: '今天很开心',
    summary: '',
    emoPleasure: 0.4,
    createdAt: '2026-11-01T10:00:00.000Z',
    source: 'chat',
    ...overrides,
  };
}

test('事件重放：入库判定与复算判定分开统计，翻向条目能定位到具体事件', () => {
  const replay = replayEvents([
    row({ id: 'e1', title: '她说她崩溃了', emoPleasure: 0.5 }),
    row({ id: 'e2', title: '今天很开心', emoPleasure: 0.4 }),
    row({ id: 'e3', title: '天气一般', emoPleasure: 0 }),
  ]);

  assert.equal(replay.entries.length, 3, '每条事件都要有复算记录');
  assert.deepEqual(replay.stored, { negative: 0, neutral: 1, positive: 2 }, '入库时全判成中性/正向');
  assert.equal(replay.flipped.length, 1, '只有 e1 是入库判正、复算判负');
  assert.equal(replay.flipped[0]!.id, 'e1');
  assert.ok(replay.flipped[0]!.replayed < 0, '复算结果要能给出负向值');
  assert.equal(replay.entries.find((item) => item.turnId === 'e1')!.negatives.length > 0, true);
});

test('事件重放：复算不会把负向压成全正，负向占比可算', () => {
  const replay = replayEvents([
    row({ id: 'e1', title: '有点烦', emoPleasure: 0.2 }),
    row({ id: 'e2', title: '崩溃', emoPleasure: 0.2 }),
    row({ id: 'e3', title: '开心', emoPleasure: 0.2 }),
  ]);
  const report = buildReport(replay.entries, 0, 'events', {
    stored: replay.stored,
    flipped: replay.flipped.slice(0, 5),
    flippedTotal: replay.flipped.length,
  });

  assert.equal(report.buckets.negative, 2, '有点烦 / 崩溃 都应落在负向桶');
  assert.equal(report.buckets.positive, 1);
  assert.equal(report.flippedTotal, 2);
  assert.ok(report.negativeShare > 0);
});
