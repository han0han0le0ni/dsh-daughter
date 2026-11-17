import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { createHost } from '../src/host.js';
import { defaultConfig, loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { bumpSkill, learnDraftSkill } from '../src/runtime/maintenance.js';
import type { DaughterConfig, EventRecord, PluginContext, ReflexRule, SkillCard } from '../src/types.js';
import { silentLogger } from '../src/util.js';
import type { Logger } from '../src/util.js';

const NOW = '2026-11-04T10:00:00.000Z';
let turn = 0;

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-daughter-hard-'));
}

function makeConfig(overrides: Partial<DaughterConfig> = {}): DaughterConfig {
  const config = structuredClone(defaultConfig);
  config.random_surprise_enabled = false;
  return { ...config, ...overrides } as DaughterConfig;
}

function makeCtx(sessionId: string, now = NOW): PluginContext {
  turn += 1;
  return {
    characterId: 'daughter-default',
    sessionId,
    workspaceId: 'ws-1',
    turnId: `turn-${turn}`,
    now: () => now,
    logger: silentLogger,
    tools: { invoke: async () => null },
  };
}

function makeSkill(overrides: Partial<SkillCard> = {}): SkillCard {
  return {
    id: 'SKL-demo-001',
    characterId: 'daughter-default',
    name: '演示技能',
    intent: '演示流程',
    keywords: ['演示'],
    requiredTools: [],
    steps: [{ order: 1, description: '第一步', onFailure: 'abort' }],
    boundary: { requiresConfirm: false, costLevel: 'low', forbiddenContexts: [] },
    maturity: 0.3,
    successCount: 0,
    failCount: 0,
    version: 1,
    status: 'active',
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  };
}

function makeEvent(id: string, overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id,
    characterId: 'daughter-default',
    title: '项目进度',
    summary: '项目进度正常',
    tags: ['工作'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0, arousal: 0, dominance: 0, intensity: 0.2 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: 'chat',
    createdAt: NOW,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
    ...overrides,
  };
}

test('§5.3 原子写：技能落盘后没有残留临时文件', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  store.saveSkill(makeSkill());

  const files = readdirSync(join(root, 'brain', 'basal_ganglia', 'skills', 'daughter-default'));
  assert.deepEqual(files, ['SKL-demo-001.yaml']);
  assert.equal(store.loadSkill('SKL-demo-001')!.name, '演示技能');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§5.3 并发写：两个实例交替累计成熟度不丢计数', () => {
  const root = makeRoot();
  const storeA = new Store(root, 'daughter-default');
  const storeB = new Store(root, 'daughter-default');
  const config = makeConfig();
  const base = makeSkill();
  storeA.saveSkill(base);

  let fromA = base;
  let fromB = base;
  for (let i = 0; i < 5; i += 1) {
    fromA = bumpSkill(storeA, fromA, true, config, NOW);
    fromB = bumpSkill(storeB, fromB, true, config, NOW);
  }

  const current = storeA.loadSkill(base.id)!;
  assert.equal(current.successCount, 10);
  assert.ok(Math.abs(current.maturity - 0.8) < 1e-6, `实际 ${current.maturity}`);

  storeA.close();
  storeB.close();
  rmSync(root, { recursive: true, force: true });
});

test('§9.1 技能状态机：草稿沉淀 → 首次成功转正 → 连续失败作废', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();

  const learned = learnDraftSkill(store, config, {
    userText: '帮我把抖音刷一遍，看到有趣的总结给我',
    tools: ['douyin_next', 'douyin_like'],
    now: NOW,
  });
  assert.ok(learned, '多步工具序列应沉淀成草稿');
  assert.equal(learned!.skill.status, 'draft');
  assert.equal(learned!.skill.steps.length, 2);
  assert.equal(learned!.skill.boundary.requiresConfirm, true);

  // 同样的工具序列不重复沉淀
  assert.equal(
    learnDraftSkill(store, config, { userText: '再来一次', tools: ['douyin_next', 'douyin_like'], now: NOW }),
    null,
  );

  const promoted = bumpSkill(store, learned!.skill, true, config, NOW);
  assert.equal(promoted.status, 'active');
  assert.equal(store.loadSkill(learned!.skill.id)!.status, 'active');

  let current = promoted;
  for (let i = 0; i < 5; i += 1) current = bumpSkill(store, current, false, config, NOW);
  assert.equal(current.status, 'deprecated');
  assert.equal(store.loadSkill(learned!.skill.id)!.status, 'deprecated');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§9.1 单步工具不沉淀技能草稿', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();
  assert.equal(learnDraftSkill(store, config, { userText: '看下屏幕', tools: ['desktop_observe'], now: NOW }), null);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§4.6 反射 tool_call 在安全档位 ≥2 时被丢弃', async () => {
  const root = makeRoot();
  const config = makeConfig();
  const plugin = createDaughterPlugin({ pluginRoot: root, config });
  const ctx = makeCtx('s-reflex');

  const rules: ReflexRule[] = [
    {
      id: 'RFX-900',
      enabled: true,
      priority: 99,
      cooldownMs: 0,
      match: { type: 'keyword', patterns: ['开工'] },
      action: { kind: 'tool_call', tool: 'shell', argsTemplate: { cmd: 'echo 1' } },
    },
  ];
  const store = new Store(root, 'daughter-default');
  writeFileSync(join(store.paths.reflexes, 'rules.yaml'), JSON.stringify(rules), 'utf8');
  store.close();

  const healthy = {
    sessionId: 's-reflex',
    characterId: 'daughter-default',
    emotion: { pleasure: 0, arousal: 0, dominance: 0 },
    stress: 0.2,
    safety: 0.7,
    fatigue: 0.2,
    emotionalOverdraft: 0,
    boundary: 0.6,
    activeSubPersonaId: 'alone',
    lastTickAt: NOW,
    snapshotAt: NOW,
    schemaVersion: 1 as const,
  };

  const hit = await plugin.reflexMatch({ ctx, userText: '开工', l5: healthy });
  assert.equal(hit?.ruleId, 'RFX-900');

  const degraded = await plugin.reflexMatch({ ctx, userText: '开工', l5: { ...healthy, safety: 0.2 } });
  assert.equal(degraded, null, '档位 ≥2 时不应该执行反射工具动作');

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('§9.2 旧版 rules.yaml（缺 enabled/priority/cooldownMs）仍被识别为启用', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  writeFileSync(
    join(store.paths.reflexes, 'rules.yaml'),
    ['- id: RFX-LEGACY', '  match: { type: keyword, patterns: [开灯] }', '  action: { kind: template_reply, text: 好 }'].join('\n'),
    'utf8',
  );

  const rules = store.loadReflexRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.id, 'RFX-LEGACY');
  assert.equal(rules[0]!.enabled, true, '缺省应视为启用，否则整条规则会被跳过');
  assert.equal(rules[0]!.priority, 0);
  assert.equal(rules[0]!.cooldownMs, 0);

  // 显式停用仍然生效
  writeFileSync(
    join(store.paths.reflexes, 'rules.yaml'),
    ['- id: RFX-OFF', '  enabled: false', '  match: { type: keyword, patterns: [关灯] }', '  action: { kind: template_reply, text: 好 }'].join('\n'),
    'utf8',
  );
  assert.equal(store.loadReflexRules()[0]!.enabled, false);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§4.4 全文层：长文本命中时注入摘录', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-fulltext');
  const longText =
    '今天在做一个很麻烦的项目，需求改了三遍，上午开会下午改代码，晚上还要写文档，' +
    '中间还被拉去处理线上问题，整个人有点撑不住，但还是想把这件事做完再说。';

  await plugin.onUserMessage({ ctx, text: longText, source: 'chat' });
  await plugin.afterResponse({ ctx, userText: longText, assistantText: '先把手头最急的一件做完，剩下的明天再说。' });

  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });
  const digest = result.blocks.find((block) => block.kind === 'event_digest');
  assert.ok(digest, '应命中刚写入的事件');
  assert.match(digest!.text, /摘录：/);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('§10.1 档位 ≥2 时注入只保留中性记忆', async () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  store.addEvent(
    makeEvent('EVT-20261104-000001', {
      summary: '项目进度很慢，我很烦',
      emotionAtTime: { pleasure: -0.8, arousal: 0.5, dominance: -0.3, intensity: 0.9 },
    }),
  );
  store.addEvent(makeEvent('EVT-20261104-000002', { summary: '项目进度正常' }));
  store.close();

  const config = makeConfig();
  config.safety.thresholds.fatigue_level2 = 0.1;
  const plugin = createDaughterPlugin({ pluginRoot: root, config });
  const ctx = makeCtx('s-neutral');

  await plugin.onUserMessage({ ctx, text: '项目进度怎么样了', source: 'chat' });
  const result = await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });
  const digest = result.blocks.find((block) => block.kind === 'event_digest');

  assert.ok(digest, '中性事件仍应注入');
  assert.match(digest!.text, /正常/);
  assert.equal(/很烦/.test(digest!.text), false, '高情绪记忆在降级时应被过滤');

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('§10.2 诊断词检查受 diagnosis_labels_forbidden 控制', async () => {
  const root = makeRoot();
  const config = makeConfig();
  config.safety.diagnosis_labels_forbidden = false;
  const plugin = createDaughterPlugin({ pluginRoot: root, config });
  const ctx = makeCtx('s-label');

  await plugin.onUserMessage({ ctx, text: '最近状态不好', source: 'chat' });
  const result = await plugin.afterResponse({
    ctx,
    userText: '最近状态不好',
    assistantText: '听起来像抑郁症，建议就医。',
  });

  assert.deepEqual(result.evolutionIds, []);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('§11 未实现分支的配置项会显式告警；shared_across_* 已生效不再告警', () => {
  const root = makeRoot();
  writeFileSync(
    join(root, 'config.yaml'),
    [
      'storage:',
      '  scope: session',
      '  shared_across_sessions: false',
      '  single_writer: false',
      'safety:',
      '  diagnosis_labels_forbidden: false',
    ].join('\n'),
    'utf8',
  );

  const warnings: string[] = [];
  const infos: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: (msg) => infos.push(msg),
    warn: (msg) => warnings.push(msg),
    error: () => undefined,
  };

  const config = loadConfig(root, logger);
  assert.equal(config.storage.scope, 'session');
  assert.ok(warnings.some((line) => line.includes('storage.scope')));
  // shared_across_* 从"占位告警"变成真开关：不再进警告，只在 info 里说明按哪种隔离跑
  assert.equal(config.storage.shared_across_sessions, false);
  assert.ok(!warnings.some((line) => line.includes('shared_across_*')));
  assert.ok(infos.some((line) => line.includes('shared_across_sessions')));
  assert.ok(warnings.some((line) => line.includes('single_writer')));
  assert.ok(warnings.some((line) => line.includes('diagnosis_labels_forbidden')));

  rmSync(root, { recursive: true, force: true });
});

test('宿主：同一轮只注入一次上下文块', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-daughter-host-once-'));
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const cleanups: Array<() => void> = [];
  const ctx = {
    logger: silentLogger,
    get: () => undefined,
    on(name: string, listener: (...args: any[]) => unknown) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => undefined;
    },
    effect(fn: () => (() => void) | void) {
      const dispose = fn();
      if (dispose) cleanups.push(dispose);
      return () => undefined;
    },
    emit: () => undefined,
  };

  createHost(ctx as any, { storage: { data_root: root } }, root);
  const preStep = listeners.get('agent/pre-step')?.[0];
  assert.ok(preStep);

  const session = { id: 'session-once', header: { cwd: 'e:\\ws' } };
  const message = { id: 'm1', role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } };

  const first = (await preStep!({ agent: { session }, messages: [message], turn: 1, step: 1 }, async () => ({
    kind: 'enter',
    messages: [message],
  }))) as { messages: unknown[] };
  assert.equal(first.messages.length, 2);

  const second = (await preStep!({ agent: { session }, messages: [message], turn: 1, step: 2 }, async () => ({
    kind: 'enter',
    messages: [message],
  }))) as { messages: unknown[] };
  assert.equal(second.messages.length, 1, '同一轮第二个 step 不应重复注入');

  cleanups.forEach((fn) => fn());
  rmSync(root, { recursive: true, force: true });
});

test('技能草稿会写进演化日志并可回溯', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();
  const learned = learnDraftSkill(store, config, {
    userText: '先把窗口切过去再截图',
    tools: ['desktop_input', 'desktop_observe'],
    now: NOW,
  });
  assert.ok(learned);

  const entries = store.listEvolution(5);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.target, 'skill');
  assert.match(readFileSync(join(root, 'logs', 'evolution', 'daughter-default.jsonl'), 'utf8'), /draft/);

  store.close();
  rmSync(root, { recursive: true, force: true });
});
