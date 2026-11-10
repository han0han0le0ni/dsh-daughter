import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { defaultConfig } from '../src/config.js';
import { analyzeSentiment, sentimentPolarity, sentimentStrength } from '../src/runtime/state.js';
import { logPolarity, polarityLogPath, prunePolarityLog } from '../src/runtime/polarity-log.js';
import { silentLogger } from '../src/util.js';
import type { DaughterConfig, PluginContext, PolarityLogEntry } from '../src/types.js';

const CHAR = 'daughter-default';
const NOW = '2026-11-10T12:00:00.000Z';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-polarity-'));
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

function makeEntry(at: string, overrides: Partial<PolarityLogEntry> = {}): PolarityLogEntry {
  return {
    at,
    characterId: CHAR,
    sessionId: 's-1',
    turnId: 'turn-x',
    textHash: '0123456789abcdef',
    hits: ['烦'],
    negations: [],
    positives: [],
    negatives: ['烦'],
    polarity: -0.35,
    strength: 0.175,
    padDelta: { pleasure: -0.018, arousal: 0, dominance: -0.04 },
    padAfter: { pleasure: 0.08, arousal: 0.1, dominance: 0 },
    source: 'chat',
    ...overrides,
  };
}

test('analyzeSentiment 的极性与强度与原函数逐条一致', () => {
  const samples = [
    '你好',
    '今天有点烦',
    '太崩溃了',
    '不开心',
    '很开心',
    '压力好大，好累',
    '还行吧',
    '没意思',
    '谢谢你',
    '不太舒服',
  ];
  for (const text of samples) {
    const detail = analyzeSentiment(text);
    assert.equal(detail.polarity, sentimentPolarity(text), `polarity 不一致：${text}`);
    assert.equal(detail.strength, sentimentStrength(text), `strength 不一致：${text}`);
    assert.ok(detail.polarity >= -1 && detail.polarity <= 1);
    assert.ok(detail.strength >= 0 && detail.strength <= 1);
  }
});

test('日志字段完整：命中词、PAD 增量与 padAfter 都落盘', () => {
  const root = makeRoot();
  logPolarity(root, makeEntry(NOW));
  const path = polarityLogPath(root, CHAR);
  assert.equal(existsSync(path), true);

  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!) as PolarityLogEntry;
  assert.deepEqual(entry.hits, ['烦']);
  assert.deepEqual(entry.negatives, ['烦']);
  assert.equal(entry.polarity, -0.35);
  assert.equal(entry.strength, 0.175);
  assert.deepEqual(entry.padDelta, { pleasure: -0.018, arousal: 0, dominance: -0.04 });
  assert.deepEqual(entry.padAfter, { pleasure: 0.08, arousal: 0.1, dominance: 0 });
  rmSync(root, { recursive: true, force: true });
});

test('include_text_hash=false 时 textHash 为 null', async () => {
  const root = makeRoot();
  const config = makeConfig((c) => {
    c.polarity_log.include_text_hash = false;
  });
  const plugin = createDaughterPlugin({ pluginRoot: root, config });
  const ctx = makeCtx('s-hash');
  await plugin.onUserMessage({ ctx, text: '今天有点烦', source: 'chat' });
  plugin.close();

  const lines = readFileSync(polarityLogPath(root, CHAR), 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[0]!) as PolarityLogEntry;
  assert.equal(entry.textHash, null);
  rmSync(root, { recursive: true, force: true });
});

test('retention_days=1 时三天前的日志行被裁掉', () => {
  const root = makeRoot();
  logPolarity(root, makeEntry(NOW));
  logPolarity(root, makeEntry(new Date(Date.parse(NOW) - 3 * 86_400_000).toISOString()));

  const removed = prunePolarityLog(root, CHAR, 1, NOW);
  assert.equal(removed, 1);

  const lines = readFileSync(polarityLogPath(root, CHAR), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal((JSON.parse(lines[0]!) as PolarityLogEntry).at, NOW);
  rmSync(root, { recursive: true, force: true });
});

test('关闭 polarity_log 时不写文件、不报错', async () => {
  const root = makeRoot();
  const config = makeConfig((c) => {
    c.polarity_log.enabled = false;
  });
  const plugin = createDaughterPlugin({ pluginRoot: root, config });
  const ctx = makeCtx('s-off');
  await plugin.onUserMessage({ ctx, text: '今天有点烦', source: 'chat' });
  plugin.close();

  assert.equal(existsSync(polarityLogPath(root, CHAR)), false);
  rmSync(root, { recursive: true, force: true });
});
