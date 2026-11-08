import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { carryL5 } from '../src/runtime/state.js';
import { silentLogger, windowName } from '../src/util.js';
import type { DaughterConfig, EventRecord, L5State, PersonaBundle, PluginContext } from '../src/types.js';

const CHAR = 'daughter-default';
const NOW = '2026-11-07T10:00:00.000Z';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-continuity-'));
}

function makeConfig(patch: Partial<DaughterConfig['storage']> = {}): DaughterConfig {
  const config = structuredClone(defaultConfig);
  config.random_surprise_enabled = false;
  Object.assign(config.storage, patch);
  return config;
}

let turn = 0;

function makeCtx(sessionId: string, now = NOW, workspaceId = 'ws-1'): PluginContext {
  turn += 1;
  return {
    characterId: CHAR,
    sessionId,
    workspaceId,
    turnId: `turn-${turn}`,
    now: () => now,
    logger: silentLogger,
    tools: { invoke: async () => null },
  };
}

function hoursLater(from: string, hours: number): string {
  return new Date(Date.parse(from) + hours * 3_600_000).toISOString();
}

function makePersona(): PersonaBundle {
  return {
    l1: {
      bigFive: { openness: 0.6, conscientiousness: 0.55, extraversion: 0.35, agreeableness: 0.65, neuroticism: 0.4 },
      temperament: 'slow_warmup',
      moodBaseline: { pleasure: 0.1, arousal: -0.1, dominance: 0 },
      noveltySeeking: 0.45,
      plasticity: 0.65,
      updatedAt: NOW,
    } as PersonaBundle['l1'],
    l2: {
      attachmentAnxiety: 0.35,
      attachmentAvoidance: 0.4,
      coreNeeds: [],
      trustBaseline: 0.3,
      relationshipStage: 'acquaintance',
      relationshipDepth: 0.2,
      updatedAt: NOW,
    },
    l3: {
      biasWeights: {},
      defenseMaturity: 0.5,
      copingStrategies: [],
      moral: { altruism: 0.6, principle: 0.55, stance: '善意假设', redLines: [] },
      narrative: { worldSafe: 0.6, othersReliable: 0.5, selfWorth: 0.6, lockedAxes: [], updatedAt: NOW },
      evidence: [],
      updatedAt: NOW,
    },
    l4: { subPersonas: [], updatedAt: NOW },
  };
}

function makeL5(overrides: Partial<L5State> = {}): L5State {
  return {
    sessionId: 's1',
    characterId: CHAR,
    emotion: { pleasure: 0.5, arousal: 0.2, dominance: 0 },
    stress: 0.9,
    safety: 0.5,
    fatigue: 0.6,
    emotionalOverdraft: 0.3,
    boundary: 0.6,
    body: { strength: 0.4, feeling: 0.2, source: 'vpet', at: NOW },
    activeSubPersonaId: 'SUB-1',
    lastTickAt: NOW,
    snapshotAt: NOW,
    schemaVersion: 1,
    ...overrides,
  };
}

function makeEvent(id: string, title: string, summary: string, createdAt: string): EventRecord {
  return {
    id,
    characterId: CHAR,
    title,
    summary,
    tags: ['对话'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0.1, arousal: 0.1, dominance: 0, intensity: 0.4 },
    emotionNowHistory: [],
    importance: 0.6,
    weight: 0.6,
    links: [],
    source: 'chat',
    createdAt,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

test('接力衰减：隔一会儿原样，隔一天变淡但不归零，生理信号不带过去', () => {
  const config = makeConfig();
  const persona = makePersona();
  const previous = makeL5();

  const soon = carryL5(previous, 's2', hoursLater(NOW, 0.1), persona, config);
  assert.equal(soon.stress, 0.9, '半小时内几乎不衰减：换窗口不该等于睡了一觉');
  assert.equal(soon.emotion.pleasure, 0.5);
  assert.equal(soon.sessionId, 's2');
  assert.equal(soon.body, null, '桌宠信号是当时那个人的，不该跨会话继承');

  const day = carryL5(previous, 's2', hoursLater(NOW, 24), persona, config);
  assert.ok(day.stress < 0.9, '隔一天应该回落');
  assert.ok(day.stress > config.emotion_relax.stress_baseline, '但不该直接归到基线');
  assert.ok(day.emotion.pleasure < 0.5 && day.emotion.pleasure > persona.l1.moodBaseline.pleasure);

  const week = carryL5(previous, 's2', hoursLater(NOW, 168), persona, config);
  assert.ok(week.stress < day.stress, '越久越平');
  assert.equal(week.lastTickAt, hoursLater(NOW, 168));
});

test('换会话：默认接着上一段的情绪，而不是从基线重新出生', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });

  const first = await plugin.onUserMessage({
    ctx: makeCtx('s1', NOW),
    text: '项目又要上线了，压力很大，我很担心搞砸',
    source: 'chat',
  });
  assert.ok(first.l5.stress > 0.25, '先让状态被推起来');

  const carried = await plugin.onUserMessage({
    ctx: makeCtx('s2', hoursLater(NOW, 0.2)),
    text: '你好',
    source: 'chat',
  });
  assert.ok(carried.l5.stress > 0.25, `新会话应继承压力，实际 ${carried.l5.stress}`);

  plugin.close();

  // 对照组：关掉跨会话共享，回到"每个会话从基线出生"的旧行为
  const isolated = createDaughterPlugin({
    pluginRoot: root,
    config: makeConfig({ shared_across_sessions: false }),
  });
  const fresh = await isolated.onUserMessage({
    ctx: makeCtx('s3', hoursLater(NOW, 0.3)),
    text: '你好',
    source: 'chat',
  });
  assert.ok(fresh.l5.stress < 0.2, `关掉接力后应回到基线，实际 ${fresh.l5.stress}`);
  isolated.close();

  rmSync(root, { recursive: true, force: true });
});

test('旧存档没有接力快照时，回退到最近一次会话快照', async () => {
  const root = makeRoot();
  // 模拟升级前的存量：只有 l5_state/ 里的会话快照，没有 l5.carry.*
  const store = new Store(root, CHAR);
  store.saveL5(makeL5({ sessionId: 'legacy-session', stress: 0.88, lastTickAt: '2026-11-07T09:00:00.000Z' }));
  store.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const next = await plugin.onUserMessage({
    ctx: makeCtx('s-new', '2026-11-07T09:20:00.000Z'),
    text: '你好',
    source: 'chat',
  });
  assert.ok(next.l5.stress > 0.5, `旧快照也应被接力，实际 ${next.l5.stress}`);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('工作区隔离：shared_across_workspaces=false 时只在同一目录内接力', async () => {
  const root = makeRoot();
  const config = makeConfig({ shared_across_workspaces: false });
  const plugin = createDaughterPlugin({ pluginRoot: root, config });

  await plugin.onUserMessage({
    ctx: makeCtx('a1', NOW, 'ws-A'),
    text: '压力很大，我很担心搞砸',
    source: 'chat',
  });

  const same = await plugin.onUserMessage({
    ctx: makeCtx('a2', hoursLater(NOW, 0.2), 'ws-A'),
    text: '你好',
    source: 'chat',
  });
  assert.ok(same.l5.stress > 0.25, '同一个工作区应该接力');

  const other = await plugin.onUserMessage({
    ctx: makeCtx('b1', hoursLater(NOW, 0.3), 'ws-B'),
    text: '你好',
    source: 'chat',
  });
  assert.ok(other.l5.stress < 0.2, '换工作区不串味');

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('跨窗口轨道：1 号窗口说"我跑了"，2 号窗口会被接上且带时间', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });

  const win1 = makeCtx('win-1', '2026-11-07T10:00:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win1, text: '我跑了', source: 'chat' });
  await plugin.afterResponse({ ctx: win1, userText: '我跑了', assistantText: '去吧，注意安全' });

  // 5 分钟后在另一个窗口说"你好"——"你好"检索不到"我跑了"。
  // 首轮由"续接槽位"给出（上一段对话的结尾），第二轮续接退场后由"跨窗口轨道"接力。
  const win2 = makeCtx('win-2', '2026-11-07T10:05:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win2, text: '你好', source: 'chat' });
  const first = await plugin.beforePromptBuild({ ctx: win2, tokenBudget: 3000 });
  const digestFirst = first.blocks.find((block) => block.kind === 'event_digest')!.text;
  assert.match(digestFirst, /我跑了/, '别处刚说的话首轮要接上');

  const win2Again = makeCtx('win-2', '2026-11-07T10:06:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win2Again, text: '在吗', source: 'chat' });
  const second = await plugin.beforePromptBuild({ ctx: win2Again, tokenBudget: 3000 });
  // 跨窗口在独立块里，不在"当前话题检索"的 event_digest 里
  const cross = second.blocks.find((block) => block.kind === 'cross_window');
  assert.ok(cross, '跨窗口内容应是独立块');
  assert.match(cross!.text, /我跑了/, '跨窗口轨道每轮都补，不限于首轮');
  assert.match(cross!.text, /另一个窗口/, '要标明这不是当前窗口的检索命中');
  assert.match(cross!.text, /\d{2}:\d{2}/, '带绝对时间戳，两条窗口之间能排成一条线');

  // 第三轮：同一窗口已经贴过，不再重复
  const win2Third = makeCtx('win-2', '2026-11-07T10:07:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win2Third, text: '吃了吗', source: 'chat' });
  const third = await plugin.beforePromptBuild({ ctx: win2Third, tokenBudget: 3000 });
  const thirdCross = third.blocks.find((block) => block.kind === 'cross_window');
  assert.ok(!thirdCross || !/我跑了/.test(thirdCross.text), '跨窗口同一窗口只提醒一次');

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('本窗口刚说的话不能被贴成"别处"：跨窗口块只装别的窗口的话', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });

  const win1 = makeCtx('win-same', '2026-11-07T10:00:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win1, text: '我跑了', source: 'chat' });
  await plugin.afterResponse({ ctx: win1, userText: '我跑了', assistantText: '去吧，注意安全' });

  // 同一个窗口的下一轮：这句是"这儿"刚说的，不该出现在"另一个窗口"里
  const same = makeCtx('win-same', '2026-11-07T10:01:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: same, text: '在吗', source: 'chat' });
  const built = await plugin.beforePromptBuild({ ctx: same, tokenBudget: 3000 });

  const cross = built.blocks.find((block) => block.kind === 'cross_window');
  assert.ok(!cross || !/我跑了/.test(cross.text), '本窗口的话不该被当成别处说的');
  // 只有一轮、又发生在本窗口的局仍然贴着（那是"落脚处"），但必须标成"这儿"
  const thread = built.blocks.find((block) => block.kind === 'thread');
  assert.ok(thread, '局块不该整段没了');
  const threadLine = thread!.text.split('\n').find((line) => line.includes('我跑了'));
  assert.ok(threadLine, '这一局应该在块里');
  assert.ok(!threadLine!.includes('别处·'), '本窗口的话不能被标成别处');
  assert.match(thread!.text, /这儿·/, '要写清这句是这儿说的');

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('跨窗口块带窗口名字：这边是哪个窗、每行是哪个窗说的', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });

  const win1 = makeCtx('win-alpha', '2026-11-07T10:00:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win1, text: '我跑了', source: 'chat' });
  await plugin.afterResponse({ ctx: win1, userText: '我跑了', assistantText: '去吧' });

  const win2 = makeCtx('win-beta', '2026-11-07T10:05:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win2, text: '你好', source: 'chat' });
  await plugin.beforePromptBuild({ ctx: win2, tokenBudget: 3000 });

  const win2Again = makeCtx('win-beta', '2026-11-07T10:06:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win2Again, text: '在吗', source: 'chat' });
  const built = await plugin.beforePromptBuild({ ctx: win2Again, tokenBudget: 3000 });

  const cross = built.blocks.find((block) => block.kind === 'cross_window');
  assert.ok(cross, '跨窗口块应存在');
  assert.match(cross!.text, /这边是「窗\d+」/, '块头要写清这边是哪个窗口');
  assert.match(cross!.text, /别处·窗\d+/, '每行要标出是哪个窗口说的');
  const here = /这边是「(.+?)」/.exec(cross!.text)?.[1];
  assert.ok(here, '要能读出这边的窗口名');
  assert.doesNotMatch(cross!.text, new RegExp(`别处·${here}`), '不能把本窗口标成别处');

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('窗口名字：按出现顺序发「窗1」「窗2」，重启后名字不变', async () => {
  const root = makeRoot();
  const config = makeConfig();
  const plugin = createDaughterPlugin({ pluginRoot: root, config });

  // 第一个窗口先建 prompt，拿到 窗1
  const win1 = makeCtx('sess-A', '2026-11-07T10:00:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win1, text: '我跑了', source: 'chat' });
  const first = await plugin.beforePromptBuild({ ctx: win1, tokenBudget: 3000 });
  assert.ok(first.blocks.some((block) => block.kind !== 'constraint'));
  await plugin.afterResponse({ ctx: win1, userText: '我跑了', assistantText: '去吧' });

  // 第二个窗口：第一句走续接，第二轮才看得到跨窗口块
  const win2a = makeCtx('sess-B', '2026-11-07T10:02:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win2a, text: '你好', source: 'chat' });
  await plugin.beforePromptBuild({ ctx: win2a, tokenBudget: 3000 });
  await plugin.afterResponse({ ctx: win2a, userText: '你好', assistantText: '在' });

  const win2b = makeCtx('sess-B', '2026-11-07T10:02:30.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win2b, text: '在吗', source: 'chat' });
  const built = await plugin.beforePromptBuild({ ctx: win2b, tokenBudget: 3000 });
  const cross = built.blocks.find((block) => block.kind === 'cross_window');
  assert.ok(cross, '跨窗口块应存在');
  assert.match(cross!.text, /这边是「窗2」/, '第二个窗口是窗2');
  assert.match(cross!.text, /别处·窗1/, '先说那句话的是窗1');
  plugin.close();

  // 重启：老的号不能变，新窗口接着排
  const again = createDaughterPlugin({ pluginRoot: root, config });
  const win3a = makeCtx('sess-C', '2026-11-07T10:03:00.000Z', 'ws-A');
  await again.onUserMessage({ ctx: win3a, text: '在吗', source: 'chat' });
  await again.beforePromptBuild({ ctx: win3a, tokenBudget: 3000 });

  const win3b = makeCtx('sess-C', '2026-11-07T10:03:30.000Z', 'ws-A');
  await again.onUserMessage({ ctx: win3b, text: '嗯', source: 'chat' });
  const built3 = await again.beforePromptBuild({ ctx: win3b, tokenBudget: 3000 });
  const cross3 = built3.blocks.find((block) => block.kind === 'cross_window');
  assert.ok(cross3, '重启后跨窗口块仍应存在');
  assert.match(cross3!.text, /这边是「窗3」/, '新窗口拿新号，不从窗1 重发');
  assert.match(cross3!.text, /别处·窗1/, '老的号不能变');

  again.close();
  rmSync(root, { recursive: true, force: true });
});

test('同一条只贴一个地方：内容相同的事件不在两块里各贴一遍', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });

  // 同一个东西被记了两次（不同窗口、不同 id，内容一字不差）
  for (const [sessionId, at] of [
    ['win-dup-1', '2026-11-07T10:00:00.000Z'],
    ['win-dup-2', '2026-11-07T10:05:00.000Z'],
  ] as const) {
    const ctx = makeCtx(sessionId, at, 'ws-A');
    await plugin.onUserMessage({ ctx, text: '贞贞老师讲的语文', source: 'chat' });
    await plugin.afterResponse({ ctx, userText: '贞贞老师讲的语文', assistantText: '哦，语文啊' });
  }

  const win3 = makeCtx('win-dup-3', '2026-11-07T10:06:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win3, text: '贞贞老师讲的语文', source: 'chat' });
  const built = await plugin.beforePromptBuild({ ctx: win3, tokenBudget: 3000 });

  const count = (kind: string): number => {
    const block = built.blocks.find((item) => item.kind === kind);
    return (block?.text ?? '').split('\n').filter((line) => line.includes('贞贞老师')).length;
  };
  const total = count('event_digest') + count('cross_window');
  assert.ok(total <= 1, `同一条只该贴一处，现在贴了 ${total} 处`);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('跨窗口时间窗：太久之前的"别处"不再当"刚才"接', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });

  const win1 = makeCtx('win-1', '2026-11-07T09:00:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win1, text: '我跑了', source: 'chat' });
  await plugin.afterResponse({ ctx: win1, userText: '我跑了', assistantText: '去吧' });

  // 2 小时后（超出默认 45 分钟窗）。首轮"我跑了"由续接槽位给出（那是另一条路），
  // 这里只看第二轮：续接退场、跨窗口又超时窗，它就不该再出现。
  const win2 = makeCtx('win-2', '2026-11-07T11:00:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win2, text: '你好', source: 'chat' });
  await plugin.beforePromptBuild({ ctx: win2, tokenBudget: 3000 });

  const win2Again = makeCtx('win-2', '2026-11-07T11:01:00.000Z', 'ws-A');
  await plugin.onUserMessage({ ctx: win2Again, text: '在吗', source: 'chat' });
  const built = await plugin.beforePromptBuild({ ctx: win2Again, tokenBudget: 3000 });
  // 跨窗口轨道：2 小时已超出 45 分钟窗，不该出现在跨窗口块里
  const cross = built.blocks.find((block) => block.kind === 'cross_window');
  assert.ok(!cross || !/我跑了/.test(cross.text), '超出时间窗就不该再当"刚才"提');
  plugin.close();
  rmSync(root, { recursive: true, force: true });
});

test('续接是固定槽位：字面命中也在，第二轮不再重复', async () => {
  const root = makeRoot();
  const store = new Store(root, CHAR);
  store.addEvent(makeEvent('EVT-20261106-000001', '露营计划', '上周说好周末去露营', '2026-11-06T09:00:00.000Z'));
  store.addEvent(makeEvent('EVT-20261105-000002', '想养猫', '昨天聊到想养一只猫', '2026-11-05T09:00:00.000Z'));
  store.close();

  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });
  const ctx = makeCtx('s-first', NOW);

  await plugin.onUserMessage({ ctx, text: '露营计划', source: 'chat' });
  const built = await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });
  const digest = built.blocks.find((block) => block.kind === 'event_digest')!;

  assert.match(digest.text, /露营计划/, '当前这句话命中的记忆要进来');
  assert.match(digest.text, /想养猫/, '上一段对话的结尾不能被字面命中挤掉');

  const again = await plugin.beforePromptBuild({ ctx, tokenBudget: 3000 });
  const digestAgain = again.blocks.find((block) => block.kind === 'event_digest')!;
  assert.doesNotMatch(digestAgain.text, /想养猫/, '续接只在该会话第一轮出现一次');

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});
