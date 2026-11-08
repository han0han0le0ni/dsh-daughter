import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { defaultConfig } from '../src/config.js';
import { buildThreadDigest } from '../src/runtime/content.js';
import { assignThread, isClosingUtterance, isDialogueSource, pruneOpenThreads } from '../src/runtime/threading.js';
import { silentLogger, windowName } from '../src/util.js';
import type { DaughterConfig, EventRecord, PluginContext } from '../src/types.js';

const CHAR = 'daughter-default';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-thread-'));
}

function makeConfig(patch: Partial<DaughterConfig['threading']> = {}): DaughterConfig {
  const config = structuredClone(defaultConfig);
  config.random_surprise_enabled = false;
  Object.assign(config.threading, patch);
  return config;
}

let turn = 0;

function makeCtx(sessionId: string, now: string, workspaceId = 'ws-A'): PluginContext {
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

function makeEvent(id: string, title: string, createdAt: string, sessionId?: string): EventRecord {
  return {
    id,
    characterId: CHAR,
    title,
    summary: title,
    tags: ['对话'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure: 0.1, arousal: 0.1, dominance: 0, intensity: 0.4 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: 'chat',
    createdAt,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
    sessionId,
  };
}

test('assignThread：时间相邻 + 话题相似归同一局，否则开新局', () => {
  const config = makeConfig();

  const first = assignThread(makeEvent('e1', '玩捉迷藏，猜猜我在哪', '2026-11-07T10:00:00.000Z', 'w1'), [], config);
  assert.equal(first.heads.length, 1);
  assert.equal(first.heads[0]!.turnCount, 1);
  assert.equal(first.heads[0]!.windowCount, 1);

  // 同题、隔 5 分钟、跨窗口 → 接上
  const second = assignThread(
    makeEvent('e2', '捉迷藏呀，忘记了吗？', '2026-11-07T10:05:00.000Z', 'w2'),
    first.heads,
    config,
  );
  assert.equal(second.heads.length, 1, '不该开新局');
  assert.equal(second.heads[0]!.turnCount, 2);
  assert.equal(second.heads[0]!.windowCount, 2, '跨了窗口要记下来');
  assert.equal(second.threadId, first.heads[0]!.id);

  // 无关话题 → 新局
  const other = assignThread(
    makeEvent('e3', '今天天气不错', '2026-11-07T10:06:00.000Z', 'w2'),
    second.heads,
    config,
  );
  assert.equal(other.heads.length, 2);

  // 时间隔太久（超过 gap_minutes）→ 即使同题也开新局
  const stale = assignThread(
    makeEvent('e4', '捉迷藏继续', '2026-11-07T12:00:00.000Z', 'w2'),
    other.heads,
    config,
  );
  assert.equal(stale.heads.length, 3, '超过间隔就该是另一局');
});

test('pruneOpenThreads：没动静的局到期即收尾，但还留着当落脚处', () => {
  const config = makeConfig();
  const { heads } = assignThread(makeEvent('e1', '玩捉迷藏', '2026-11-07T10:00:00.000Z', 'w1'), [], config);
  assert.equal(pruneOpenThreads(heads, '2026-11-07T10:30:00.000Z', 180).length, 1);
  const later = pruneOpenThreads(heads, '2026-11-07T14:00:00.000Z', 180);
  assert.equal(later.length, 1, '过了 TTL 仍要留个落脚处');
  assert.equal(later[0]!.status, 'closed');
  assert.equal(later[0]!.closedReason, '一直没动静');
  assert.equal(
    pruneOpenThreads(heads, '2026-11-08T14:00:00.000Z', 180).length,
    0,
    '过了留存期才彻底出寄存器',
  );
});

test('一局留一句原话（40 字截断）与开合状态：最后一句要能接得上', () => {
  const config = makeConfig();
  const first = assignThread(
    makeEvent('e1', '玩捉迷藏，猜猜我在哪', '2026-11-07T10:00:00.000Z', 'w1'),
    [],
    config,
    '玩捉迷藏，猜猜我在哪，我藏在你床底下的柜子里，你肯定找不到我，数到十就开始，不许偷看',
  );
  assert.equal(first.heads[0]!.status, 'open');
  assert.equal(first.heads[0]!.recentEvents[0]!.quote!.length, 41, '40 字 + 省略号');

  const second = assignThread(
    makeEvent('e2', '捉迷藏，我卡住了', '2026-11-07T10:05:00.000Z', 'w2'),
    first.heads,
    config,
    '卡在我看不见，等她给线索',
  );
  const text = buildThreadDigest(second.heads, '2026-11-07T10:05:00.000Z', 'w2');
  assert.match(text, /「卡在我看不见，等她给线索」/, '要给出最后一句原话，不是只给话题');
  assert.match(text, /还开着/);
  assert.match(text, new RegExp(`这儿·${windowName('w2')}`), '本窗口说的标这儿');

  const elsewhere = buildThreadDigest(second.heads, '2026-11-07T10:06:00.000Z', 'w3');
  assert.match(elsewhere, /别处·窗/, '别的窗口说的标别处');
});

test('换了说法接着聊还是同一局：整句不像、但有同一个词就算', () => {
  const config = makeConfig();
  const first = assignThread(
    makeEvent('e1', '玩捉迷藏，猜猜我在哪，我藏在你床底下', '2026-11-07T10:00:00.000Z', 'w1'),
    [],
    config,
  );
  // 换窗口、换说法：整句 Dice 只有 0.12，靠"捉迷藏"这个词认出来
  const next = assignThread(
    makeEvent('e2', '捉迷藏呀，忘记了吗？我卡在看不见，等她给线索', '2026-11-07T10:05:00.000Z', 'w2'),
    first.heads,
    config,
  );
  assert.equal(next.heads.length, 1, '不该拆成两局');
  assert.equal(next.heads[0]!.turnCount, 2);
  assert.equal(next.heads[0]!.windowCount, 2);
});

test('收尾话术：说了"先这样"这一局就结了，之后同题发言是新的一局', () => {
  const config = makeConfig();
  const first = assignThread(makeEvent('e1', '玩捉迷藏', '2026-11-07T10:00:00.000Z', 'w1'), [], config, '玩捉迷藏');
  assert.equal(isClosingUtterance('捉迷藏先这样吧，我睡了', config), true);
  assert.equal(isClosingUtterance('捉迷藏继续', config), false);

  const bye = assignThread(
    makeEvent('e2', '捉迷藏先这样吧', '2026-11-07T10:05:00.000Z', 'w1'),
    first.heads,
    config,
    '捉迷藏先这样吧，我睡了',
  );
  assert.equal(bye.heads[0]!.status, 'closed');
  assert.equal(bye.heads[0]!.closedReason, '对方说了收尾的话');
  assert.match(buildThreadDigest(bye.heads, '2026-11-07T10:06:00.000Z', 'w1'), /已结束/);

  // 收尾之后再说同一件事：不能悄悄接回已经结了的那一局
  const again = assignThread(
    makeEvent('e3', '捉迷藏继续', '2026-11-07T10:10:00.000Z', 'w1'),
    bye.heads,
    config,
    '捉迷藏继续吧',
  );
  const open = again.heads.filter((head) => head.status === 'open');
  assert.equal(open.length, 1);
  assert.notEqual(open[0]!.id, bye.heads[0]!.id);
});

test('旧局不再当进行中：13 小时前那局标成"已结束"，留着但不占进行中的位置', () => {
  const config = makeConfig();
  const stale = assignThread(makeEvent('e1', '玩捉迷藏', '2026-11-06T21:00:00.000Z', 'w1'), [], config);
  const kept = pruneOpenThreads(stale.heads, '2026-11-07T10:00:00.000Z', 180);
  assert.equal(kept.length, 1, '昨晚那局要留着落脚处');
  assert.equal(kept[0]!.status, 'closed');
  assert.equal(kept[0]!.closedReason, '一直没动静');
  assert.match(buildThreadDigest(kept, '2026-11-07T10:00:00.000Z', 'w2'), /已结束（一直没动静）/);

  const closed = assignThread(makeEvent('e2', '捉迷藏先这样', '2026-11-07T10:00:00.000Z', 'w1'), [], config, '先这样');
  assert.equal(pruneOpenThreads(closed.heads, '2026-11-07T11:00:00.000Z', 180).length, 1, '刚收尾的留着交代');
  assert.equal(
    pruneOpenThreads(closed.heads, '2026-11-08T11:00:00.000Z', 180).length,
    0,
    '过了留存期才消失',
  );
});

test('非对话来源不开局', () => {
  assert.equal(isDialogueSource('chat'), true);
  assert.equal(isDialogueSource('douyin_content'), false);
  assert.equal(isDialogueSource('system'), false);
});

test('端到端：一局跨两个窗口，两个窗口看到同一局前情', async () => {
  const root = makeRoot();
  const plugin = createDaughterPlugin({ pluginRoot: root, config: makeConfig() });

  const win1 = makeCtx('win-1', '2026-11-07T10:00:00.000Z');
  await plugin.onUserMessage({ ctx: win1, text: '玩捉迷藏，猜猜我在哪', source: 'chat' });
  await plugin.afterResponse({ ctx: win1, userText: '玩捉迷藏，猜猜我在哪', assistantText: '我先找找' });

  const win2 = makeCtx('win-2', '2026-11-07T10:05:00.000Z');
  await plugin.onUserMessage({ ctx: win2, text: '捉迷藏呀，忘记了吗？', source: 'chat' });
  await plugin.afterResponse({ ctx: win2, userText: '捉迷藏呀，忘记了吗？', assistantText: '记起来了，你在躲' });

  // 第三个窗口进来，应该能看到这一局的前情（跨 2 个窗口）
  const win3 = makeCtx('win-3', '2026-11-07T10:06:00.000Z');
  await plugin.onUserMessage({ ctx: win3, text: '你好', source: 'chat' });
  const built = await plugin.beforePromptBuild({ ctx: win3, tokenBudget: 3000 });
  const thread = built.blocks.find((block) => block.kind === 'thread');
  assert.ok(thread, '应有「进行中的局」块');
  assert.match(thread!.text, /捉迷藏/);
  assert.match(thread!.text, /跨 2 个窗口/);

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});
