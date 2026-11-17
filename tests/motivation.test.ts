import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, mergeConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { bumpSkill } from '../src/runtime/maintenance.js';
import {
  classifySkillChannel,
  computeEmotionOffset,
  computeFamiliarityGain,
  computeMemoryGain,
  computeSituationMultiplier,
  scoreSkills,
} from '../src/runtime/motivation.js';
import { activateSkills } from '../src/runtime/content.js';
import type {
  BigFive,
  DaughterConfig,
  EventRecord,
  L5State,
  PersonaBundle,
  SkillCard,
} from '../src/types.js';

const NOW = '2026-11-02T10:00:00.000Z';

function makeConfig(mutate: (config: DaughterConfig) => void = () => {}): DaughterConfig {
  const config = structuredClone(defaultConfig);
  mutate(config);
  return config;
}

function makeSkill(overrides: Partial<SkillCard> = {}): SkillCard {
  return {
    id: 'SKL-motivation-001',
    characterId: 'daughter-default',
    name: '陪聊',
    intent: '聊天',
    keywords: ['聊天'],
    requiredTools: [],
    steps: [{ order: 1, description: '第一步', onFailure: 'abort' }],
    boundary: { requiresConfirm: false, costLevel: 'low', forbiddenContexts: [] },
    maturity: 0.5,
    successCount: 0,
    failCount: 0,
    version: 1,
    status: 'active',
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  };
}

function makePersona(bigFive: Partial<BigFive> = {}, selfWorth = 0.5): PersonaBundle {
  return {
    l1: {
      bigFive: {
        openness: 0.5,
        conscientiousness: 0.5,
        extraversion: 0.5,
        agreeableness: 0.5,
        neuroticism: 0.5,
        ...bigFive,
      },
      temperament: 'steady',
      moodBaseline: { pleasure: 0, arousal: 0, dominance: 0 },
      noveltySeeking: 0.5,
      plasticityBase: 0.5,
      updatedAt: NOW,
    },
    l2: {
      attachmentAnxiety: 0.3,
      attachmentAvoidance: 0.3,
      coreNeeds: [],
      trustBaseline: 0.5,
      relationshipStage: 'familiar',
      relationshipDepth: 0.5,
      updatedAt: NOW,
    },
    l3: {
      biasWeights: {},
      defenseMaturity: 0.5,
      copingStrategies: [],
      moral: { altruism: 0.5, principle: 0.5, stance: '中性', redLines: [] },
      narrative: { worldSafe: 0.5, othersReliable: 0.5, selfWorth, lockedAxes: [], updatedAt: NOW },
      updatedAt: NOW,
    },
    l4: { subPersonas: [], updatedAt: NOW },
  };
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
    lastTickAt: NOW,
    snapshotAt: NOW,
    schemaVersion: 1,
    ...overrides,
  };
}

function makeEvent(id: string, pleasure: number, createdAt = NOW): EventRecord {
  return {
    id,
    characterId: 'daughter-default',
    title: '聊到聊天',
    summary: '一次关于聊天的交流',
    tags: ['聊天'],
    participants: ['self', 'user'],
    emotionAtTime: { pleasure, arousal: 0, dominance: 0, intensity: 0.5 },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: 'chat',
    createdAt,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

test('动机：人格双通路——降阈值 + 升分数，外向/宜人越高社交技能越容易被选中', () => {
  const config = makeConfig();
  const skill = makeSkill();
  const userText = '聊天';

  const low = scoreSkills([skill], userText, config, {
    persona: makePersona({ extraversion: 0.1, agreeableness: 0.1 }),
  })[0]!.breakdown;
  const high = scoreSkills([skill], userText, config, {
    persona: makePersona({ extraversion: 0.9, agreeableness: 0.9 }),
  })[0]!.breakdown;

  assert.equal(high.channel, 'social');
  // 通路一：阈值侧（"够不够力"）
  assert.ok(high.personalityOffset < 0, '高外向/宜人应降低阈值');
  assert.ok(low.personalityOffset > 0, '低外向/宜人应抬高阈值');
  assert.ok(high.threshold < low.threshold);
  // 通路二：分数侧（方向舵，"更想走哪条路"）
  assert.ok(high.traitSignalGain > 1, `高外向/宜人的社交增益应 >1，实际 ${high.traitSignalGain}`);
  assert.ok(low.traitSignalGain < 1, `低外向/宜人的社交增益应 <1，实际 ${low.traitSignalGain}`);
  assert.ok(high.score > low.score, '方向舵应让同一信号在社交通道拿到更高分');
  // 两条通路都不该改动基础信号本身
  assert.equal(high.signal, low.signal, '人格不改变基础信号');
});

test('动机：方向舵能改变通道排序——外向的人选聊天，尽责的人选整理', () => {
  const config = makeConfig();
  const social = makeSkill({ id: 'SKL-social', name: '陪聊', intent: '聊天', keywords: ['聊天'] });
  const achieve = makeSkill({ id: 'SKL-achieve', name: '整理计划', intent: '完成计划', keywords: ['计划'] });
  const userText = '聊天 计划';

  const neutral = scoreSkills([social, achieve], userText, config, { persona: makePersona() });
  assert.equal(neutral[0]!.breakdown.traitSignalGain, 1, '中性人格不产生偏向');
  assert.equal(neutral[0]!.breakdown.skillId, 'SKL-social', '中性时社交技能基线分更高');

  const outgoing = scoreSkills([social, achieve], userText, config, {
    persona: makePersona({ extraversion: 1, agreeableness: 1, conscientiousness: 0 }),
  });
  assert.equal(outgoing[0]!.breakdown.channel, 'social', '外向/宜人拉满时社交应排第一');
  assert.equal(outgoing[0]!.breakdown.decision, 'act');
  assert.equal(outgoing[1]!.breakdown.decision, 'avoid', '被压低的成就通道应落到 avoid');

  const dutiful = scoreSkills([social, achieve], userText, config, {
    persona: makePersona({ conscientiousness: 1, extraversion: 0, agreeableness: 0 }),
  });
  assert.equal(dutiful[0]!.breakdown.channel, 'achievement', '尽责拉满时成就通道应反超');
  assert.equal(dutiful[0]!.breakdown.decision, 'act');
  assert.notEqual(dutiful[0]!.breakdown.skillId, neutral[0]!.breakdown.skillId, '排序确实翻转了');
});

test('动机：方向舵不凭空造信号——零信号时乘子再高也不动', () => {
  const config = makeConfig();
  const skill = makeSkill({ name: '备份保护', intent: '安全备份', keywords: ['备份'] });
  const extreme = makePersona({ extraversion: 1, agreeableness: 1, openness: 1, conscientiousness: 1 });

  const rows = scoreSkills([skill], '你好呀', config, { persona: extreme })[0]!.breakdown;
  assert.equal(rows.signal, 0);
  assert.equal(rows.score, 0, '乘子不能把 0 变成非 0');
  assert.equal(rows.decision, 'avoid');

  // trait_signal_gain 是乘子，不是加分项：关掉它信号也不该受影响
  const noDrive = makeConfig((c) => {
    c.motivation.trait_signal_gain = 0;
  });
  const same = scoreSkills([skill], '你好呀', noDrive, { persona: extreme })[0]!.breakdown;
  assert.equal(same.traitSignalGain, 1);
  assert.equal(same.signal, 0);
});

test('动机：安全通道反向——神经质越高越谨慎', () => {
  const config = makeConfig();
  const skill = makeSkill({ keywords: ['备份', '保护'], name: '备份保护', intent: '安全备份' });

  const calm = scoreSkills([skill], '备份', config, { persona: makePersona({ neuroticism: 0.1 }) })[0]!.breakdown;
  const anxious = scoreSkills([skill], '备份', config, { persona: makePersona({ neuroticism: 0.9 }) })[0]!.breakdown;

  assert.equal(classifySkillChannel(skill).channel, 'safety');
  assert.ok(anxious.personalityOffset > calm.personalityOffset);
  assert.ok(anxious.threshold > calm.threshold);
});

test('动机：熟悉度倒 U，用得太少或太多都会降低增益', () => {
  const config = makeConfig();
  const f = config.motivation.familiarity;

  const rarely = computeFamiliarityGain(makeSkill(), config);
  const nearPeak = computeFamiliarityGain(makeSkill({ successCount: 2 }), config);
  const overused = computeFamiliarityGain(makeSkill({ successCount: 50 }), config);

  assert.ok(nearPeak > rarely, `2 次使用 ${nearPeak} 应高于 0 次 ${rarely}`);
  assert.ok(nearPeak > overused, `2 次使用 ${nearPeak} 应高于 50 次 ${overused}`);
  assert.ok(nearPeak <= 1);
  assert.ok(rarely > 0 && overused > 0);

  // 峰值语义：exposure 越接近 peak，增益越接近 1
  const peakUses = (f.peak * f.k) / (1 - f.peak);
  const atPeak = computeFamiliarityGain(
    makeSkill({ successCount: Math.round(peakUses) }),
    config,
  );
  assert.ok(atPeak > 0.98, `峰值附近应接近 1，实际 ${atPeak}`);
});

test('动机：记忆三路径——结果预期、情绪记忆与自我效能都参与', () => {
  const config = makeConfig();

  const neutral = computeMemoryGain(makeSkill(), config);
  const successful = computeMemoryGain(makeSkill({ successCount: 9 }), config);
  const failing = computeMemoryGain(makeSkill({ failCount: 9 }), config);
  assert.ok(successful > neutral, '成功历史应提高记忆增益');
  assert.ok(failing < neutral, '失败历史应降低记忆增益');

  const happy = computeMemoryGain(makeSkill(), config, { now: NOW, recentEvents: [makeEvent('EVT-HAPPY', 0.8)] });
  const sad = computeMemoryGain(makeSkill(), config, { now: NOW, recentEvents: [makeEvent('EVT-SAD', -0.8)] });
  assert.ok(happy > sad, '与技能相关的愉快记忆应提高增益');

  const confident = computeMemoryGain(makeSkill(), config, { persona: makePersona({}, 0.9) });
  const doubting = computeMemoryGain(makeSkill(), config, { persona: makePersona({}, 0.1) });
  assert.ok(confident > doubting, '自我效能高应提高增益');

  const stale = computeMemoryGain(
    makeSkill({ successCount: 9, lastUsedAt: '2026-06-01T00:00:00.000Z' }),
    config,
    { now: NOW },
  );
  assert.ok(stale < successful, '久未使用的结果预期应按时间衰减');
});

test('动机：情绪覆盖有方向且总偏移被 clamp', () => {
  const config = makeConfig();
  const o = config.motivation.emotion_override;

  const risky = computeEmotionOffset(
    makeL5({ safety: 0.2, stress: 0.9, fatigue: 0.9 }, { pleasure: -0.6, arousal: 0.8 }),
    config,
  );
  assert.equal(risky, o.clamp_max, '多项叠加后应被上限截断');

  const calm = computeEmotionOffset(makeL5(), config);
  assert.equal(calm, 0);

  const aroused = computeEmotionOffset(makeL5({}, { arousal: o.arousal_high + 0.1 }), config);
  assert.equal(aroused, o.arousal_high_offset, '高唤醒应降低阈值');
});

test('动机：情境乘子对社交通道影响更大', () => {
  const config = makeConfig();
  const highAffinity = makePersona();
  highAffinity.l2.relationshipDepth = 0.9;
  const sub = { id: 'to_father', weight: 1, tone: '温和', disclosureLevel: 0.9, boundaries: [] };

  const social = computeSituationMultiplier('social', highAffinity, sub, config);
  const other = computeSituationMultiplier('achievement', highAffinity, sub, config);
  assert.equal(social, config.motivation.situation.max_multiplier);
  assert.ok(other < social, `非 social 通道影响应减半，实际 ${other}`);
  assert.ok(other > 1);

  const distant = computeSituationMultiplier('social', { ...highAffinity, l2: { ...highAffinity.l2, relationshipDepth: 0 } }, { ...sub, disclosureLevel: 0 }, config);
  assert.equal(distant, config.motivation.situation.min_multiplier);
});

test('动机：熔断期内该技能只避不做，成功后解除', () => {
  const config = makeConfig();
  const skill = makeSkill({ failStreak: 3, breakerUntil: '2026-11-02T10:10:00.000Z' });

  const blocked = scoreSkills([skill], '聊天', config, { now: NOW })[0]!.breakdown;
  assert.equal(blocked.breakerActive, true);
  assert.equal(blocked.decision, 'avoid');
  assert.equal(blocked.score, 0);

  const released = scoreSkills([skill], '聊天', config, { now: '2026-11-02T10:11:00.000Z' })[0]!.breakdown;
  assert.equal(released.breakerActive, false);
  assert.notEqual(released.decision, 'avoid');
});

test('动机：bumpSkill 连续失败进入指数冷却，成功清零', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-motivation-'));
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();
  const skill = makeSkill({ id: 'SKL-breaker-001' });
  store.saveSkill(skill);
  store.close();

  const reopened = new Store(root, 'daughter-default');
  let current = reopened.loadSkill(skill.id)!;

  current = bumpSkill(reopened, current, false, config, '2026-11-02T10:00:00.000Z');
  assert.equal(current.failStreak, 1);
  assert.equal(current.breakerUntil, undefined);

  current = bumpSkill(reopened, current, false, config, '2026-11-02T10:01:00.000Z');
  assert.equal(current.failStreak, 2);
  assert.equal(current.breakerUntil, undefined);

  current = bumpSkill(reopened, current, false, config, '2026-11-02T10:02:00.000Z');
  assert.equal(current.failStreak, 3);
  assert.equal(current.breakerUntil, '2026-11-02T10:12:00.000Z', '第 3 次失败冷却 10 分钟');

  current = bumpSkill(reopened, current, false, config, '2026-11-02T10:03:00.000Z');
  assert.equal(current.failStreak, 4);
  assert.equal(current.breakerUntil, '2026-11-02T10:23:00.000Z', '第 4 次失败冷却翻倍到 20 分钟');

  current = bumpSkill(reopened, current, true, config, '2026-11-02T10:04:00.000Z');
  assert.equal(current.failStreak, 0);
  assert.equal(current.breakerUntil, undefined, '成功应清除熔断');
  assert.equal(current.successCount, 1);

  reopened.close();
  rmSync(root, { recursive: true, force: true });
});

test('动机：零信号不因阈值下限被误触发', () => {
  const config = makeConfig();
  const skill = makeSkill({ name: '备份保护', intent: '安全备份', keywords: ['备份'] });
  // 极端人格：安全通道偏移把阈值压到 0，这是修复前"零信号也能 act"的来源
  const extreme = makePersona({ extraversion: 1, agreeableness: 1, neuroticism: 0 });

  const silent = scoreSkills([skill], '你好呀', config, { persona: extreme, now: NOW })[0]!.breakdown;
  assert.equal(silent.signal, 0, '文本与技能毫无交集时信号应为 0');
  assert.ok(silent.threshold >= config.motivation.min_threshold, `阈值不应被压到 0，实际 ${silent.threshold}`);
  assert.equal(silent.score, 0);
  assert.equal(silent.decision, 'avoid');

  // 即使显式把下限配成 0，零信号也必须 avoid——守卫不依赖阈值兜底
  const noFloor = makeConfig((c) => {
    c.motivation.min_threshold = 0;
  });
  const guarded = scoreSkills([skill], '你好呀', noFloor, { persona: extreme })[0]!.breakdown;
  assert.equal(guarded.threshold, 0);
  assert.equal(guarded.decision, 'avoid', 'min_threshold=0 时零信号仍不应 act');

  // 正常信号不受影响
  const real = scoreSkills([skill], '备份', config, { persona: extreme })[0]!.breakdown;
  assert.ok(real.signal > 0);
  assert.equal(real.decision, 'act');
});

test('动机：min_threshold 不能高于基础阈值（否则永不 act）', () => {
  const config = makeConfig((c) => {
    c.skills.min_main_score = 0.2;
    c.motivation.min_threshold = 0.9;
  });
  const normalized = mergeConfig(structuredClone(config), {});
  assert.ok(normalized.motivation.min_threshold <= normalized.skills.min_main_score);
});

test('动机：activateSkills 用动机决策，关闭后回退旧打分', () => {
  const config = makeConfig();
  const skill = makeSkill();
  const activation = activateSkills([skill], '聊天', config, { now: NOW });
  assert.ok(activation.breakdown && activation.breakdown.length === 1);
  assert.equal(activation.main?.id, skill.id);
  assert.ok(activation.confidence > 0);

  config.motivation.enabled = false;
  const legacy = activateSkills([skill], '聊天', config);
  assert.equal(legacy.main?.id, skill.id);
  assert.equal(legacy.breakdown, undefined, '关闭动机时不产出明细');
  assert.ok(legacy.confidence >= config.skills.min_main_score);
});

test('动机：main 取 act 最高，associated 排除 avoid', () => {
  const config = makeConfig();
  const first = makeSkill({ id: 'SKL-first', keywords: ['聊天'], name: '陪聊', intent: '聊天' });
  const second = makeSkill({ id: 'SKL-second', keywords: ['聊天'], name: '闲聊', intent: '聊天' });
  const blocked = makeSkill({
    id: 'SKL-blocked',
    keywords: ['聊天'],
    name: '聊天',
    intent: '聊天',
    failStreak: 3,
    breakerUntil: '2026-11-02T11:00:00.000Z',
  });

  const activation = activateSkills([first, second, blocked], '聊天', config, { now: NOW });
  assert.ok(activation.main);
  assert.ok(!activation.associated.some((item) => item.id === 'SKL-blocked'), '熔断技能不应进入 associated');
  assert.equal(activation.breakdown?.find((item) => item.skillId === 'SKL-blocked')?.decision, 'avoid');
});
