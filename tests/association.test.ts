import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { associateEvents, pickAssociationSeed } from '../src/runtime/memory.js';
import type { DaughterConfig, EventRecord, PluginContext } from '../src/types.js';
import { relativeTime, silentLogger } from '../src/util.js';

const CHAR = 'daughter-default';
let turn = 0;

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-association-'));
}

function makeConfig(): DaughterConfig {
  const config = structuredClone(defaultConfig);
  config.random_surprise_enabled = false;
  return config;
}

function makeCtx(now = '2026-11-06T10:00:00.000Z'): PluginContext {
  turn += 1;
  return {
    characterId: CHAR,
    sessionId: 's-assoc',
    workspaceId: 'ws-1',
    turnId: `turn-${turn}`,
    now: () => now,
    logger: silentLogger,
    tools: { invoke: async () => null },
  };
}

function makeEvent(id: string, title: string, summary: string, links: EventRecord['links'] = []): EventRecord {
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
    links,
    source: 'chat',
    createdAt: '2026-11-01T10:00:00.000Z',
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

test('联想按边强度排序，弱边不参与', () => {
  const seed = makeEvent('EVT-SEED', '种子', '种子事件', [
    { targetId: 'EVT-STRONG', kind: 'topic', strength: 0.9 },
    { targetId: 'EVT-WEAK', kind: 'topic', strength: 0.05 },
  ]);
  const candidates = [
    seed,
    makeEvent('EVT-STRONG', '强关联', '强关联事件'),
    makeEvent('EVT-WEAK', '弱关联', '弱关联事件'),
  ];

  const hits = associateEvents(['EVT-SEED'], candidates, 2, 5, 0.6);
  assert.deepEqual(hits.map((hit) => hit.eventId), ['EVT-STRONG'], '弱边不该被当成联想带出来');
  assert.equal(hits[0].depth, 1);
  assert.deepEqual(hits[0].path, ['EVT-SEED', 'EVT-STRONG']);
});

test('多条线索指向同一段记忆时分数更高', () => {
  const seed = makeEvent('EVT-SEED', '种子', '种子事件', [
    { targetId: 'EVT-A', kind: 'topic', strength: 0.9 },
    { targetId: 'EVT-B', kind: 'person', strength: 0.9 },
  ]);
  const candidates = [
    seed,
    makeEvent('EVT-A', '线索甲', '甲', [
      { targetId: 'EVT-C', kind: 'topic', strength: 1 },
      { targetId: 'EVT-D', kind: 'topic', strength: 1 },
    ]),
    makeEvent('EVT-B', '线索乙', '乙', [{ targetId: 'EVT-C', kind: 'topic', strength: 1 }]),
    makeEvent('EVT-C', '共同指向', '两条路径都到这里'),
    makeEvent('EVT-D', '单独指向', '只有一条路径'),
  ];

  const hits = associateEvents(['EVT-SEED'], candidates, 2, 5, 0.6);
  const c = hits.find((hit) => hit.eventId === 'EVT-C');
  const d = hits.find((hit) => hit.eventId === 'EVT-D');
  assert.ok(c && d);
  assert.equal(hits.filter((hit) => hit.eventId === 'EVT-C').length, 1, '同一目标只出现一次');
  assert.ok(c.score > d.score, `两条路径都指向的应更高：C=${c.score} D=${d.score}`);
});

test('字面命中之外，联想把相关内容一起注入', async () => {
  const root = makeRoot();
  const seedStore = new Store(root, CHAR);
  seedStore.addEvent(makeEvent('EVT-A', '今天加班到很晚', '项目上线前一直在改需求', [
    { targetId: 'EVT-B', kind: 'topic', strength: 0.9 },
  ]));
  seedStore.addEvent(makeEvent('EVT-B', '周末想去爬山', '约了朋友早起看日出'));
  seedStore.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx();
  await plugin.onUserMessage({ ctx, text: '今天加班到很晚', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 4000 });

  const digest = result.blocks.find((block) => block.kind === 'event_digest');
  assert.ok(digest, '缺少事件块');
  assert.match(digest.text, /今天加班到很晚/);
  assert.match(digest.text, /周末想去爬山/, '字面无关但有关联的记忆应该一起注入');

  const association = result.blocks.find((block) => block.kind === 'association');
  assert.ok(association, '缺少联想块');
  assert.match(association.text, /周末想去爬山/, '联想块必须带内容，不能只有 eventId');
  assert.match(association.text, /由「/, '要说明是从哪条记忆想到的');
  assert.equal(result.memoryHit, true);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('一条都没命中时，从最近的事件顺下去（可关）', async () => {
  const root = makeRoot();
  const seedStore = new Store(root, CHAR);
  seedStore.addEvent(makeEvent('EVT-A', '今天加班到很晚', '项目上线前一直在改需求', [
    { targetId: 'EVT-B', kind: 'topic', strength: 0.9 },
  ]));
  seedStore.addEvent(makeEvent('EVT-B', '周末想去爬山', '约了朋友早起看日出'));
  seedStore.close();

  const config = makeConfig();
  const plugin = createDaughterPlugin({ pluginRoot: root, config });
  const ctx = makeCtx();
  await plugin.onUserMessage({ ctx, text: '量子纠缠的退相干时间怎么算', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 4000 });

  const digest = result.blocks.find((block) => block.kind === 'event_digest');
  assert.ok(digest, '没有字面命中时也应该靠联想带出内容');
  assert.match(digest.text, /周末想去爬山/);

  // 关掉兜底后，完全无关的提问不应再凭空拉出记忆
  const strict = makeConfig();
  strict.association.fallback_when_no_match = false;
  const strictRoot = makeRoot();
  const strictStore = new Store(strictRoot, CHAR);
  strictStore.addEvent(makeEvent('EVT-A', '今天加班到很晚', '项目上线前一直在改需求', [
    { targetId: 'EVT-B', kind: 'topic', strength: 0.9 },
  ]));
  strictStore.addEvent(makeEvent('EVT-B', '周末想去爬山', '约了朋友早起看日出'));
  strictStore.close();

  const strictPlugin = createDaughterPlugin({ pluginRoot: strictRoot, config: strict });
  const strictCtx = makeCtx();
  await strictPlugin.onUserMessage({ ctx: strictCtx, text: '量子纠缠的退相干时间怎么算', source: 'chat' });
  const strictResult = await strictPlugin.beforePromptBuild({ ctx: strictCtx, tokenBudget: 4000 });
  assert.equal(strictResult.memoryHit, false, '关掉兜底后不该命中');
  assert.equal(strictResult.blocks.find((block) => block.kind === 'event_digest'), undefined);

  plugin.close();
  strictPlugin.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(strictRoot, { recursive: true, force: true });
});

test('无命中时种子按情绪挑，不按出边多少挑', () => {
  const config = makeConfig();
  const now = '2026-11-06T10:00:00.000Z';
  // 出边最多但情绪无关：早期实现会挑它，于是不管问什么都从这段热闹的记忆顺下去
  const busy = makeEvent('EVT-BUSY', '开了一整天会', '连着三场评审', [
    { targetId: 'EVT-1', kind: 'topic', strength: 0.9 },
    { targetId: 'EVT-2', kind: 'topic', strength: 0.8 },
    { targetId: 'EVT-3', kind: 'topic', strength: 0.7 },
  ]);
  const tired = {
    ...makeEvent('EVT-TIRED', '累到不想说话', '加班到凌晨', [
      { targetId: 'EVT-4', kind: 'emotion', strength: 0.8 },
    ]),
    emotionAtTime: { pleasure: -0.6, arousal: -0.4, dominance: -0.2, intensity: 0.5 },
  };
  const tiredNow = { pleasure: -0.55, arousal: -0.4, dominance: -0.2 };

  const seed = pickAssociationSeed([busy, tired], tiredNow, now, config);
  assert.equal(seed?.id, 'EVT-TIRED', '当下也很累时，应该从"上次很累"那段顺下去');

  // 没有出边就顺不出内容：宁可返回空去走无记忆约束，也不挑一条联想不出去的
  const orphan = { ...tired, id: 'EVT-ORPHAN', links: [] };
  assert.equal(pickAssociationSeed([orphan], tiredNow, now, config), undefined);
});

test('记忆行带相对时间，模型才说得出"上次"', () => {
  const now = '2026-11-06T10:00:00.000Z';
  assert.equal(relativeTime('2026-11-06T09:59:40.000Z', now), '刚刚');
  assert.equal(relativeTime('2026-11-06T09:00:00.000Z', now), '1 小时前');
  assert.equal(relativeTime('2026-11-05T09:00:00.000Z', now), '昨天');
  assert.equal(relativeTime('2026-11-01T10:00:00.000Z', now), '5 天前');
  assert.equal(relativeTime('not-a-date', now), '', '坏时间戳不该渲染成"0 分钟前"');
});

test('同一个对话框的后续轮次无命中时，仍从记忆网里顺一跳', async () => {
  const root = makeRoot();
  const seedStore = new Store(root, CHAR);
  seedStore.addEvent(makeEvent('EVT-A', '今天加班到很晚', '项目上线前一直在改需求', [
    { targetId: 'EVT-B', kind: 'topic', strength: 0.9 },
  ]));
  seedStore.addEvent(makeEvent('EVT-B', '周末想去爬山', '约了朋友早起看日出'));
  seedStore.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  // 首轮走"续接上一个对话"，把这条路先走掉
  const first = makeCtx();
  await plugin.onUserMessage({ ctx: first, text: '量子纠缠的退相干时间怎么算', source: 'chat' });
  await plugin.beforePromptBuild({ ctx: first, tokenBudget: 4000 });

  // 第二轮没有任何字面命中，但记忆网里还有得顺：种子 → 一跳
  const second = makeCtx();
  await plugin.onUserMessage({ ctx: second, text: '还是量子纠缠', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx: second, tokenBudget: 4000 });
  const digest = result.blocks.find((block) => block.kind === 'event_digest');
  assert.ok(digest, '后续轮次不该因为首轮用过续接就再也想不起东西');
  assert.match(digest.text, /周末想去爬山/);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('换对话框第一句接上一个对话的结尾，第二轮不再重复', async () => {
  const root = makeRoot();
  const seedStore = new Store(root, CHAR);
  seedStore.addEvent(makeEvent('EVT-OLD-1', '上次说到搬家', '周末要去看新房子'));
  seedStore.addEvent(makeEvent('EVT-OLD-2', '答应帮忙挑沙发', '说好一起看家具'));
  seedStore.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx();
  await plugin.onUserMessage({ ctx, text: '量子纠缠的退相干时间怎么算', source: 'chat' });
  const first = await plugin.beforePromptBuild({ ctx, tokenBudget: 4000 });

  const digest = first.blocks.find((block) => block.kind === 'event_digest');
  assert.ok(digest, '新对话框的第一句应该接上上个对话');
  assert.match(digest.text, /上次说到搬家|答应帮忙挑沙发/);
  assert.match(digest.text, /天前|小时前|刚刚/, '记忆行要带相对时间');
  assert.equal(
    first.blocks.some((block) => block.kind === 'constraint'),
    false,
    '块里已经列了往事，就不能再挂"没有任何记录"',
  );

  // 同一个对话框的第二轮：不再续接，回到正常的检索语义
  const next = makeCtx();
  await plugin.onUserMessage({ ctx: next, text: '还是量子纠缠', source: 'chat' });
  const second = await plugin.beforePromptBuild({ ctx: next, tokenBudget: 4000 });
  assert.equal(second.blocks.find((block) => block.kind === 'event_digest'), undefined);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});
