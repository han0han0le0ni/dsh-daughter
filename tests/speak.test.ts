import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { createDaughterPlugin } from '../src/index.js';
import {
  computeSpeakThreshold,
  computeSpeakUrge,
  evaluateSpeak,
  foregroundBusy,
  idleUrge,
  inQuietHours,
  localDayKey,
  pickSpeakLine,
  pickSpeakReason,
  type SpeakContext,
} from '../src/runtime/speak.js';
import type { BigFive, DaughterConfig, L5State } from '../src/types.js';

// 用本地时间构造，避免测试结果随时区漂移
const DAYTIME = new Date(2026, 10, 6, 14, 0, 0).toISOString();
const NIGHT = new Date(2026, 10, 6, 3, 0, 0).toISOString();

function makeConfig(mutate: (config: DaughterConfig) => void = () => {}): DaughterConfig {
  const config = structuredClone(defaultConfig);
  // 出厂默认是关闭的（自主行为必须显示开启），这里打开以便测决策逻辑；
  // 默认值本身另有一条用例覆盖
  config.speak.enabled = true;
  mutate(config);
  return config;
}

function makeL5(overrides: Partial<L5State> = {}, emotion: Partial<L5State['emotion']> = {}): L5State {
  return {
    sessionId: 's',
    characterId: 'daughter-default',
    emotion: { pleasure: 0, arousal: 0, dominance: 0, ...emotion },
    stress: 0.3,
    safety: 0.7,
    fatigue: 0.2,
    emotionalOverdraft: 0,
    boundary: 0.5,
    activeSubPersonaId: 'alone',
    lastTickAt: DAYTIME,
    snapshotAt: DAYTIME,
    schemaVersion: 1,
    ...overrides,
  };
}

function makeBigFive(overrides: Partial<BigFive> = {}): BigFive {
  return {
    openness: 0.5,
    conscientiousness: 0.5,
    extraversion: 0.5,
    agreeableness: 0.5,
    neuroticism: 0.5,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<SpeakContext> = {}): SpeakContext {
  return {
    now: DAYTIME,
    bigFive: makeBigFive(),
    l5: makeL5(),
    relationshipDepth: 0.5,
    idleMinutes: 1200,
    sinceLastSpeakMinutes: null,
    todayCount: 0,
    carry: 0,
    ...overrides,
  };
}

test('主动开口：沉默不够久不开口', () => {
  const config = makeConfig();
  const plan = evaluateSpeak(makeCtx({ idleMinutes: 20 }), config);
  assert.equal(plan.decision, 'silent');
  assert.equal(plan.text, undefined, 'silent 不该产出文案');
});

test('主动开口：沉默够久会开口，且带上拟人文案', () => {
  const config = makeConfig();
  const plan = evaluateSpeak(makeCtx(), config);
  assert.equal(plan.decision, 'act');
  assert.ok(plan.urge >= plan.threshold, `urge ${plan.urge} 应达到 threshold ${plan.threshold}`);
  assert.ok(typeof plan.text === 'string' && plan.text.length > 0);
  assert.equal(plan.carry, 0, '开口后"憋着"的压力清零');
});

test('主动开口：思念随时长饱和，不会线性的两小时就急', () => {
  const oneHour = idleUrge(60, 180);
  const threeHours = idleUrge(180, 180);
  const tenHours = idleUrge(600, 180);

  assert.ok(oneHour < 0.3, `1 小时应还克制，实际 ${oneHour}`);
  assert.ok(Math.abs(threeHours - 0.5) < 0.01, `半饱和点应约 0.5，实际 ${threeHours}`);
  assert.ok(tenHours > 0.75 && tenHours < 0.8, `10 小时应接近但不超过 0.8，实际 ${tenHours}`);
});

test('主动开口：外向/宜人的人同样的沉默更坐不住', () => {
  const config = makeConfig();
  const introvert = computeSpeakUrge(
    makeCtx({ bigFive: makeBigFive({ extraversion: 0.1, agreeableness: 0.1 }) }),
    config,
  );
  const extravert = computeSpeakUrge(
    makeCtx({ bigFive: makeBigFive({ extraversion: 0.9, agreeableness: 0.9 }) }),
    config,
  );
  assert.ok(extravert > introvert, `外向者应更想说话：${extravert} vs ${introvert}`);

  // 人格只影响"想不想"，不改变"合不合适"
  const introvertThreshold = computeSpeakThreshold(
    makeCtx({ bigFive: makeBigFive({ extraversion: 0.1 }) }),
    config,
  );
  const extravertThreshold = computeSpeakThreshold(
    makeCtx({ bigFive: makeBigFive({ extraversion: 0.9 }) }),
    config,
  );
  assert.equal(introvertThreshold, extravertThreshold, '门槛不吃人格，只吃时段与压力');
});

test('主动开口：累了/压力大时不想说话', () => {
  const config = makeConfig();
  const rested = computeSpeakUrge(makeCtx(), config);
  const tired = computeSpeakUrge(makeCtx({ l5: makeL5({ fatigue: 0.95, stress: 0.9 }) }), config);
  assert.ok(tired < rested, `疲劳压力应压低想说话的强度：${tired} vs ${rested}`);

  // 压力大同时抬高门槛，两头夹
  const stressedThreshold = computeSpeakThreshold(makeCtx({ l5: makeL5({ stress: 0.9 }) }), config);
  assert.ok(stressedThreshold > computeSpeakThreshold(makeCtx(), config));
});

test('主动开口：深夜门槛抬高，不该半夜找人聊天', () => {
  const config = makeConfig();
  const daytime = evaluateSpeak(makeCtx({ now: DAYTIME }), config);
  const night = evaluateSpeak(makeCtx({ now: NIGHT }), config);

  assert.equal(daytime.decision, 'act');
  assert.ok(night.threshold > daytime.threshold);
  assert.notEqual(night.decision, 'act', '同样的思念强度，深夜不该开口');
});

test('主动开口：安静时段支持跨午夜', () => {
  assert.equal(inQuietHours(23, [23, 7]), true);
  assert.equal(inQuietHours(3, [23, 7]), true);
  assert.equal(inQuietHours(9, [23, 7]), false);
  assert.equal(inQuietHours(3, [0, 7]), true);
  assert.equal(inQuietHours(7, [0, 7]), false);
  assert.equal(inQuietHours(3, [7, 0]), false, '起止相同视为不启用');
});

test('主动开口：刚说过话有冷却期，冷静期内一律不开口', () => {
  const config = makeConfig();
  const cooling = evaluateSpeak(makeCtx({ sinceLastSpeakMinutes: 10 }), config);
  assert.equal(cooling.decision, 'silent');

  const ready = evaluateSpeak(makeCtx({ sinceLastSpeakMinutes: config.speak.refractory_min + 1 }), config);
  assert.equal(ready.decision, 'act');
});

test('主动开口：日上限到了就不再主动', () => {
  const config = makeConfig();
  const plan = evaluateSpeak(makeCtx({ todayCount: config.speak.max_per_day }), config);
  assert.equal(plan.decision, 'silent');
});

test('主动开口：想说但忍住会攒劲，攒够了下一次才真开口', () => {
  const config = makeConfig();
  // 约 4 小时：够到"想说"，但还差临门一脚
  const first = evaluateSpeak(makeCtx({ idleMinutes: 240 }), config);
  assert.equal(first.decision, 'hold', `应判 hold，实际 ${first.decision}`);
  assert.ok(first.carry > 0, '忍住应累积压力');
  assert.equal(first.text, undefined);

  // 攒下的压力让下一次跨过门槛
  const second = evaluateSpeak(makeCtx({ idleMinutes: 240, carry: first.carry }), config);
  assert.equal(second.decision, 'act');
  assert.ok(second.urge > first.urge);
});

test('主动开口：压力有上限，憋久了不会必然开口', () => {
  const config = makeConfig();
  const plan = evaluateSpeak(makeCtx({ idleMinutes: 50, carry: 1 }), config);
  assert.ok(plan.carry <= config.speak.carry_max);
});

test('主动开口：动机分类决定文案池', () => {
  const config = makeConfig();
  // 心情好 → 分享
  assert.equal(pickSpeakReason(makeCtx({ l5: makeL5({}, { pleasure: 0.6 }) })), 'share');
  // 神经质高 + 很久没消息 → 担心
  assert.equal(
    pickSpeakReason(makeCtx({ bigFive: makeBigFive({ neuroticism: 0.9 }), idleMinutes: 600 })),
    'worry',
  );
  // 宜人高 + 半天空闲 → 关心
  assert.equal(
    pickSpeakReason(makeCtx({ bigFive: makeBigFive({ agreeableness: 0.9 }), idleMinutes: 300 })),
    'care',
  );
  // 单纯想人
  assert.equal(pickSpeakReason(makeCtx({ idleMinutes: 200 })), 'miss');

  // 各分类都能产出文案
  for (const reason of ['miss', 'care', 'share', 'worry', 'bored'] as const) {
    const line = pickSpeakLine(reason, 'seed');
    assert.ok(line.text.length > 0);
  }
});

test('主动开口：最近说过的句子会被避开', () => {
  const first = pickSpeakLine('miss', 'same-seed');
  const second = pickSpeakLine('miss', 'same-seed', [first.index]);
  assert.notEqual(second.index, first.index);
  assert.notEqual(second.text, first.text);

  // 避开列表给满时仍要返回一句，不能死循环
  const all = Array.from({ length: 8 }, (_, index) => index);
  assert.ok(pickSpeakLine('miss', 'same-seed', all).text.length > 0);
});

test('主动开口：关掉开关就完全沉默', () => {
  const config = makeConfig((item) => {
    item.speak.enabled = false;
  });
  assert.equal(evaluateSpeak(makeCtx(), config).decision, 'silent');
});

test('主动开口：看得见屏幕时按场景抬门槛', () => {
  const config = makeConfig();
  const base = computeSpeakThreshold(makeCtx(), config);
  const meeting = computeSpeakThreshold(
    makeCtx({ foreground: { processName: 'Zoom.exe', title: 'Zoom 会议' } }),
    config,
  );
  const gaming = computeSpeakThreshold(
    makeCtx({ foreground: { processName: 'steam.exe', title: 'Steam' } }),
    config,
  );
  const coding = computeSpeakThreshold(
    makeCtx({ foreground: { processName: 'Code.exe', title: 'index.ts - Visual Studio Code' } }),
    config,
  );
  const other = computeSpeakThreshold(
    makeCtx({ foreground: { processName: 'explorer.exe', title: '文件夹' } }),
    config,
  );

  assert.ok(meeting > gaming && gaming > coding && coding > other, '场景权重应递减');
  assert.ok(meeting - base > 0.2, `开会应显著抬门槛，实际 ${meeting} vs ${base}`);
  // 桥接没在跑时不该受罚
  assert.equal(computeSpeakThreshold(makeCtx({ foreground: null }), config), base);
  assert.equal(foregroundBusy(null), 0);
  assert.equal(foregroundBusy({}), 0.15);
});

test('主动开口：正在开会时，再闲也不开口', () => {
  const config = makeConfig();
  const normal = evaluateSpeak(makeCtx({ idleMinutes: 600 }), config);
  const inMeeting = evaluateSpeak(
    makeCtx({ idleMinutes: 600, foreground: { processName: 'Teams.exe', title: 'Microsoft Teams' } }),
    config,
  );

  assert.equal(normal.decision, 'act', '空闲这么久，正常情况下已经开口了');
  assert.notEqual(inMeeting.decision, 'act', '开会时不该冒出来');
  assert.ok(inMeeting.threshold > normal.threshold);
});

test('主动开口：日计数按本地日期分桶', () => {
  assert.equal(localDayKey(DAYTIME), '2026-11-06');
  assert.equal(localDayKey(NIGHT), '2026-11-06');
});

test('主动开口：出厂默认关闭，装完插件不会自己开口', () => {
  const config = structuredClone(defaultConfig);
  assert.equal(config.speak.enabled, false, '自主行为必须显式开启');
  assert.equal(evaluateSpeak(makeCtx(), config).decision, 'silent');
});

test('主动开口：刚打开开关先记锚点，不会立刻冒一句', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-speak-'));
  // 不碰真实桌面桥：否则这条用例的判定会随当前前台窗口漂移
  const plugin = createDaughterPlugin({
    pluginRoot: root,
    config: makeConfig((cfg) => {
      cfg.desktop.enabled = false;
    }),
  });

  const first = await plugin.speakPlan({ characterId: 'daughter-default', now: DAYTIME });
  assert.equal(first, null, '第一次评估只记锚点，不产出任何决定');

  // 沉默时长还不够（1 分钟）：冷却期内一律 silent
  const tooSoon = await plugin.speakPlan({
    characterId: 'daughter-default',
    now: new Date(Date.parse(DAYTIME) + 60_000).toISOString(),
  });
  assert.equal(tooSoon?.decision, 'silent');

  // 过了冷却与最小沉默后，才进入正常决策（至少不是 null）
  const later = await plugin.speakPlan({
    characterId: 'daughter-default',
    now: new Date(Date.parse(DAYTIME) + 70 * 60_000).toISOString(),
  });
  assert.ok(later, '过了锚点与冷却期应进入决策');

  plugin.close();
  rmSync(root, { recursive: true, force: true });
});
