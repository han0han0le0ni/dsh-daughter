import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { decideIngest, contentGuardReason } from '../src/runtime/filter.js';
import { buildThreadDigest, quotePriority } from '../src/runtime/content.js';
import { assignThread, extractThreadName, type ThreadHead } from '../src/runtime/threading.js';
import { silentLogger } from '../src/util.js';
import type { DaughterConfig, EventRecord, PluginContext } from '../src/types.js';

const CHAR = 'daughter-default';
const NOW = '2026-11-09T16:00:00.000Z';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-feedback-'));
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
  source?: EventRecord['source'];
  participants?: string[];
  sessionId?: string;
}

function makeEvent(id: string, options: EventOptions = {}): EventRecord {
  return {
    id,
    characterId: CHAR,
    title: options.title ?? '一起聊了会儿天',
    summary: options.summary ?? '聊了点日常的事',
    tags: ['对话'],
    participants: options.participants ?? ['self', 'user'],
    emotionAtTime: { pleasure: 0.1, arousal: 0.1, dominance: 0, intensity: 0.2 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: options.source ?? 'chat',
    sessionId: options.sessionId,
    createdAt: options.createdAt ?? NOW,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

/* ---------------- 一、局名 ---------------- */

function longThread(): ThreadHead {
  return {
    id: 'THR-1',
    label: '现在感觉如何',
    startedAt: minutesBefore(NOW, 60),
    lastTurnAt: NOW,
    turnCount: 4,
    windowCount: 1,
    lastSessionId: 'w1',
    recentTitle: '好诚实啊',
    status: 'open',
    recentEvents: [
      { at: minutesBefore(NOW, 60), title: '现在感觉如何', summary: '你问我现在感觉如何', quote: '现在感觉如何', sessionId: 'w1' },
      { at: minutesBefore(NOW, 30), title: '优化记忆', summary: '你列了三条反馈', quote: '优化记忆', sessionId: 'w1' },
      { at: minutesBefore(NOW, 10), title: '好诚实啊', summary: '好诚实啊', quote: '好诚实啊', sessionId: 'w1' },
    ],
  };
}

test('局名默认取开局那句，不再拿最后一句回话当标题', () => {
  const first = buildThreadDigest([longThread()], NOW, 'w1');
  const line = first.split('\n')[1] ?? '';
  assert.match(line, /^- 现在感觉如何｜/, '三天后回来看得懂这局在聊什么');
  assert.equal(line.startsWith('- 好诚实啊｜'), false);

  const recent = buildThreadDigest([longThread()], NOW, 'w1', undefined, 'recent');
  assert.match(recent.split('\n')[1] ?? '', /^- 好诚实啊｜/, '显式配置 recent 仍可用最近一句');

  const none = buildThreadDigest([longThread()], NOW, 'w1', undefined, 'none');
  const noTitle = none.split('\n')[1] ?? '';
  assert.equal(noTitle.startsWith('- 现在感觉如何｜'), false);
  assert.equal(noTitle.startsWith('- 好诚实啊｜'), false);
  assert.match(noTitle, /4 轮/, '不自动起名时仍保留轮次、状态与最后一句原话');
});

test('用户说「这局叫 X」就用自己的名字，普通句子不误判', () => {
  assert.equal(extractThreadName('这局叫「优化记忆」'), '优化记忆');
  assert.equal(extractThreadName('这局叫优化记忆，顺便看看还有啥'), '优化记忆');
  assert.equal(extractThreadName('这局聊什么好呢'), null);
  assert.equal(extractThreadName('这一局是不是该收了'), null);

  const config = makeConfig();
  const first = assignThread(
    makeEvent('E1', { title: '现在感觉如何', createdAt: minutesBefore(NOW, 5), sessionId: 'w1' }),
    [],
    config,
    '现在感觉如何',
  );
  const named = assignThread(
    makeEvent('E2', { title: '这局叫优化记忆', createdAt: NOW, sessionId: 'w1' }),
    first.heads,
    config,
    '这局叫优化记忆，顺便看看还有啥',
  );
  const head = named.heads[0]!;
  assert.equal(head.turnCount, 2, '命名这一轮仍然算进局里');
  assert.equal(head.label, '优化记忆');
  assert.equal(head.labelByUser, true);
  assert.match(buildThreadDigest(named.heads, NOW, 'w1').split('\n')[1] ?? '', /^- 优化记忆｜/);
});

/* ---------------- 二、入库前的内容完整性筛 ---------------- */

const BAD_TITLE = '看到我刚刚在其他工作区的提问了吗？';
const BAD_SUMMARY = '看到我刚刚在其他工作区的提问了吗？ → </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>';

test('半截 DSML / 工具标记残留判为不完整，正常对话不误伤', () => {
  const config = makeConfig();
  const bad = makeEvent('BAD', { title: BAD_TITLE, summary: BAD_SUMMARY });
  assert.ok(contentGuardReason(bad, config));
  const decision = decideIngest(bad, [], config, NOW);
  assert.equal(decision.action, 'drop');
  assert.match(decision.reason, /内容筛/);

  const good = makeEvent('GOOD', {
    title: '你只给了三个字，没附带条件',
    summary: '你只给了三个字，没附带条件 → 我收下了。',
  });
  assert.equal(contentGuardReason(good, config), null);
  assert.equal(decideIngest(good, [], config, NOW).action, 'keep');

  const off = makeConfig((c) => {
    c.filter.content_guard.enabled = false;
  });
  assert.equal(contentGuardReason(bad, off), null, '开关可关');
});

test('坏回复整条不入库，并单独计入 filter.invalid', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-bad');

  await plugin.onUserMessage({ ctx, text: BAD_TITLE, source: 'chat' });
  await plugin.afterResponse({
    ctx,
    userText: BAD_TITLE,
    assistantText: '</｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>',
    toolsUsed: [],
  });
  plugin.close();

  const store = new Store(root, CHAR);
  assert.equal(Number(store.getMeta('filter.invalid') ?? 0), 1);
  assert.equal(store.listCandidates(false, 20).length, 0, '坏条目一条都没进库');
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/* ---------------- 三、选条目按「有没有原话」 ---------------- */

test('原话分级：模板刷视频 0、有叙述但没参与 1、用户参与的对话 2', () => {
  assert.equal(
    quotePriority(makeEvent('A', {
      title: '刷抖音刷到 星空 的视频：@星空· 10月26日…',
      source: 'douyin_content',
      participants: ['self'],
    })),
    0,
  );
  assert.equal(
    quotePriority(makeEvent('B', {
      title: '玲依渡这个名字的来历',
      summary: '她给我起了名字：玲依渡',
      source: 'system',
      participants: ['self'],
    })),
    1,
  );
  assert.equal(
    quotePriority(makeEvent('C', {
      title: '你只给了三个字，没附带条件',
      summary: '你只给了三个字，没附带条件 → 我收下了。',
      source: 'chat',
      participants: ['self', 'user'],
    })),
    2,
  );
});

function seedMemory(root: string): void {
  const store = new Store(root, CHAR);
  for (let i = 0; i < 3; i += 1) {
    store.addEvent(makeEvent(`DY-${i}`, {
      title: `刷抖音刷到 火锅 的视频：@第${i}位 · 今天吃火锅`,
      summary: `刷抖音刷到 火锅 的视频：@第${i}位 · 今天吃火锅#搞笑`,
      source: 'douyin_content',
      participants: ['self'],
      createdAt: minutesBefore(NOW, 30 + i),
    }));
  }
  store.addEvent(makeEvent('QUOTE', {
    title: '你只给了三个字，没附带条件',
    summary: '你只给了三个字，没附带条件 → 我收下了。',
    source: 'chat',
    participants: ['self', 'user'],
    createdAt: minutesBefore(NOW, 5),
  }));
  store.close();
}

async function digestFor(root: string, config: DaughterConfig, sessionId: string): Promise<string> {
  const plugin = createDaughterPlugin({ pluginRoot: root, config });
  const ctx = makeCtx(sessionId);
  await plugin.onUserMessage({ ctx, text: '火锅', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });
  plugin.close();
  return result.blocks.find((block) => block.kind === 'event_digest')?.text ?? '';
}

test('相关记忆不再被「用户没参与、又没原话」的模板条目占位置', async () => {
  const root = makeRoot();
  seedMemory(root);
  const config = makeConfig((c) => {
    c.association.fallback_when_no_match = false;
  });

  const digest = await digestFor(root, config, 's-quote-on');
  assert.equal(digest.includes('刷抖音刷到'), false, '三条模板条目都不该进事件块');

  const off = makeConfig((c) => {
    c.association.fallback_when_no_match = false;
    c.retrieval.prefer_quotes = false;
  });
  const legacy = await digestFor(root, off, 's-quote-off');
  assert.ok(legacy.includes('刷抖音刷到'), '关掉 prefer_quotes 后回到旧行为，对照成立');
  rmSync(root, { recursive: true, force: true });
});
