import type {
  BigFive,
  DaughterConfig,
  EventRecord,
  L5State,
  MotivationBreakdown,
  MotivationDecision,
  PersonaBundle,
  SignalChannel,
  SkillCard,
  SubPersona,
} from '../types.js';
import { clamp01, diceSimilarity } from '../util.js';

/**
 * 行为动机决策层所需的上下文。
 * 全部可选：缺省时退化为中性值（人格/情绪不偏移、情境乘子为 1）。
 */
export interface MotivationContext {
  now?: string;
  l5?: L5State;
  persona?: PersonaBundle;
  subPersona?: SubPersona;
  /** 近段时间的事件，用于情绪记忆路径 */
  recentEvents?: EventRecord[];
}

export interface ScoredSkill {
  skill: SkillCard;
  breakdown: MotivationBreakdown;
}

/** 通道词典：按技能文本命中的词数归类，命中最多者胜出 */
const CHANNEL_LEXICON: Record<SignalChannel, string[]> = {
  social: [
    '聊天', '对话', '回复', '消息', '问候', '打招呼', '安慰', '陪伴', '陪', '朋友',
    '关系', '邀请', '联系', '抱', '亲', '关心', '倾听', '分享', 'qq', '微信', '电话', '见面',
  ],
  achievement: [
    '完成', '整理', '计划', '任务', '工作', '项目', '学习', '写', '做', '修复',
    '构建', '生成', '文件', '代码', '检查', '执行', '自动化', '流程', '效率', '目标', '报告', '统计',
  ],
  exploration: [
    '探索', '尝试', '试', '新', '实验', '搜索', '查', '发现', '游戏', '玩',
    '看', '电影', '音乐', '浏览', '逛', '兴趣', '好奇', '随机',
  ],
  safety: [
    '安全', '备份', '清理', '保护', '隐私', '风险', '紧急', '报警', '密码', '删除',
    '危险', '边界', '拒绝', '谨慎', '确认',
  ],
  harmony: [
    '和好', '道歉', '协调', '沟通', '冲突', '情绪', '包容', '理解', '体谅',
    '让步', '共识', '温柔', '耐心', '调解', '和谐',
  ],
};

/**
 * 通道与人格维度的映射。sign=1 表示该维度越高越谨慎（阈值升高），
 * sign=-1 表示该维度越高越容易触发（阈值降低）。
 * 安全通道是反向的：神经质越高越保守。
 */
const CHANNEL_TRAITS: Record<SignalChannel, Array<{ key: keyof BigFive; sign: number }>> = {
  social: [
    { key: 'extraversion', sign: -1 },
    { key: 'agreeableness', sign: -1 },
  ],
  achievement: [{ key: 'conscientiousness', sign: -1 }],
  exploration: [{ key: 'openness', sign: -1 }],
  safety: [{ key: 'neuroticism', sign: 1 }],
  harmony: [{ key: 'agreeableness', sign: -1 }],
};

/**
 * 方向舵：哪一维人格越高，这个通道越容易被"打动"（进入分数侧当乘子）。
 * 与 CHANNEL_TRAITS 是两条独立通路——那边改门槛，这边改力气。
 * safety 刻意留空：安全行为是焦虑驱动的回避，不该给"越神经质越主动做安全事"的增益。
 */
const CHANNEL_DRIVE: Record<SignalChannel, Array<keyof BigFive>> = {
  social: ['extraversion', 'agreeableness'],
  achievement: ['conscientiousness'],
  exploration: ['openness'],
  safety: [],
  harmony: ['agreeableness'],
};

const CHANNEL_ORDER: SignalChannel[] = ['social', 'achievement', 'exploration', 'safety', 'harmony'];

/** 按名称/意图/关键词的命中情况判断技能属于哪个动机通道 */
export function classifySkillChannel(skill: SkillCard): { channel: SignalChannel; strength: number } {
  const text = `${skill.name} ${skill.intent} ${skill.keywords.join(' ')}`.toLowerCase();
  let channel: SignalChannel = 'achievement';
  let bestHits = 0;
  for (const candidate of CHANNEL_ORDER) {
    const hits = CHANNEL_LEXICON[candidate].filter((word) => text.includes(word)).length;
    if (hits > bestHits) {
      bestHits = hits;
      channel = candidate;
    }
  }
  // 没有命中时给一个低强度默认值，避免通道强度为 0 让人格完全失效
  const strength = bestHits === 0 ? 0.3 : Math.min(1, 0.4 + bestHits * 0.2);
  return { channel, strength };
}

/**
 * 人格只调阈值：Σ gain * (trait - 0.5) * 2 * strength * sign。
 * 正数表示更难触发，负数表示更容易触发。
 */
export function computePersonalityOffset(
  bigFive: BigFive | undefined,
  channel: SignalChannel,
  strength: number,
  config: DaughterConfig,
): number {
  if (!bigFive) return 0;
  const gain = config.motivation.trait_threshold_gain;
  return CHANNEL_TRAITS[channel].reduce((sum, item) => {
    const trait = Number(bigFive[item.key]);
    if (!Number.isFinite(trait)) return sum;
    return sum + gain * (trait - 0.5) * 2 * strength * item.sign;
  }, 0);
}

/**
 * 人格对分数的增益（方向舵）。返回乘子 1±gain：
 * >1 的通道"更想走"，<1 的通道"没那么想走"。
 * 它改变通道之间的比分排序，但不会凭空造信号——signal=0 时乘完仍是 0。
 */
export function computeTraitSignalGain(
  bigFive: BigFive | undefined,
  channel: SignalChannel,
  config: DaughterConfig,
): number {
  const gain = config.motivation.trait_signal_gain;
  if (!bigFive || !(gain > 0)) return 1;

  const traits = CHANNEL_DRIVE[channel];
  if (traits.length === 0) return 1;

  let sum = 0;
  let counted = 0;
  for (const key of traits) {
    const trait = Number(bigFive[key]);
    if (!Number.isFinite(trait)) continue;
    sum += clamp01(trait) * 2 - 1; // -1..1
    counted += 1;
  }
  if (counted === 0) return 1;

  const drive = sum / counted;
  return Math.max(0.1, 1 + gain * drive);
}

/** 情绪覆盖：安全感低/压力高/愉悦低/疲劳高时更谨慎，唤醒高时更容易行动 */
export function computeEmotionOffset(l5: L5State | undefined, config: DaughterConfig): number {
  if (!l5) return 0;
  const o = config.motivation.emotion_override;
  let offset = 0;
  if (l5.safety < o.safety_low) offset += o.safety_low_offset;
  if (l5.stress > o.stress_high) offset += o.stress_high_offset;
  if (l5.emotion.pleasure < o.pleasure_low) offset += o.pleasure_low_offset;
  if (l5.emotion.arousal > o.arousal_high) offset += o.arousal_high_offset;
  if (l5.fatigue > o.fatigue_high) offset += o.fatigue_high_offset;
  return Math.min(o.clamp_max, Math.max(o.clamp_min, offset));
}

/**
 * 熟悉度倒 U：用得太少会犹豫，用得太多会厌倦，峰值落在 exposure≈peak 处。
 * exposure = uses / (uses + k)。
 */
export function computeFamiliarityGain(skill: SkillCard, config: DaughterConfig): number {
  const f = config.motivation.familiarity;
  const uses = Math.max(0, skill.successCount) + Math.max(0, skill.failCount);
  const exposure = uses / (uses + f.k);
  const delta = exposure - f.peak;
  return Math.exp(-(delta * delta) / (2 * f.sigma * f.sigma));
}

/** 情绪记忆：近期事件里与技能关键词相关事件的平均愉悦度 */
export function computeEmotionMemory(skill: SkillCard, ctx: MotivationContext, config: DaughterConfig): number {
  const keywords = skill.keywords.filter(Boolean);
  const events = ctx.recentEvents ?? [];
  if (keywords.length === 0 || events.length === 0) return 0;

  const nowMs = ctx.now ? Date.parse(ctx.now) : Number.NaN;
  const lookbackMs = config.motivation.memory.lookback_days * 86_400_000;
  const matched = events.filter((event) => {
    if (nowMs && Number.isFinite(nowMs)) {
      const age = nowMs - Date.parse(event.createdAt);
      if (Number.isFinite(age) && age > lookbackMs) return false;
    }
    const text = `${event.title} ${event.summary} ${event.tags.join(' ')}`;
    return keywords.some((keyword) => text.includes(keyword));
  });
  if (matched.length === 0) return 0;
  return matched.reduce((sum, event) => sum + event.emotionAtTime.pleasure, 0) / matched.length;
}

/**
 * 记忆三路径合成：结果预期（按上次使用时间衰减）、情绪记忆、自我效能。
 * 返回 0..1，0.5 为中性。
 */
export function computeMemoryGain(
  skill: SkillCard,
  config: DaughterConfig,
  ctx: MotivationContext = {},
): number {
  const m = config.motivation.memory;
  const success = Math.max(0, skill.successCount);
  const fail = Math.max(0, skill.failCount);

  // 结果预期：拉普拉斯平滑后映射到 -1..1，再按上次使用时间半衰
  const raw = (success + 1) / (success + fail + 2);
  let outcome = raw * 2 - 1;
  if (skill.lastUsedAt && ctx.now) {
    const ageDays = Math.max(0, (Date.parse(ctx.now) - Date.parse(skill.lastUsedAt)) / 86_400_000);
    if (Number.isFinite(ageDays)) outcome *= Math.pow(0.5, ageDays / m.half_life_days);
  }

  const efficacyRaw = ctx.persona?.l3.narrative?.selfWorth ?? 0.5;
  const efficacy = 2 * clamp01(efficacyRaw) - 1;
  const emotionMem = computeEmotionMemory(skill, ctx, config);

  const weighted = m.outcome_weight * outcome + m.emotion_weight * emotionMem + m.efficacy_weight * efficacy;
  return clamp01(0.5 + 0.5 * weighted);
}

/**
 * 情境乘子：social 通道按亲和度（关系深度 + 当前子人格披露度）放大或缩小，
 * 其余通道只吃一半影响。
 */
export function computeSituationMultiplier(
  channel: SignalChannel,
  persona: PersonaBundle | undefined,
  subPersona: SubPersona | undefined,
  config: DaughterConfig,
): number {
  const depth = persona?.l2.relationshipDepth ?? 0.5;
  const disclosure = subPersona?.disclosureLevel ?? 0.5;
  const affinity = clamp01(0.5 * (clamp01(depth) + clamp01(disclosure)));
  const raw = 0.75 + 0.5 * affinity;
  const clamped = Math.min(
    config.motivation.situation.max_multiplier,
    Math.max(config.motivation.situation.min_multiplier, raw),
  );
  return channel === 'social' ? clamped : 1 + (clamped - 1) * 0.5;
}

/** 熔断期内该技能只避不做 */
export function isBreakerActive(skill: SkillCard, now: string | undefined): boolean {
  if (!skill.breakerUntil) return false;
  if (!now) return true;
  const until = Date.parse(skill.breakerUntil);
  const current = Date.parse(now);
  if (!Number.isFinite(until) || !Number.isFinite(current)) return true;
  return until > current;
}

/**
 * 阈值 = 基础分 + 人格偏移 + 情绪偏移，再被 min_threshold 兜底。
 * 没有这个下限时，极端人格（外向/宜人拉满）能把阈值压到 0，
 * 于是 score=0 的"零信号"也能满足 score >= threshold。
 */
export function computeThreshold(
  base: number,
  personalityOffset: number,
  emotionOffset: number,
  config: DaughterConfig,
): number {
  const raw = base + personalityOffset + emotionOffset;
  const floor = Number(config.motivation.min_threshold);
  const min = Number.isFinite(floor) ? Math.min(1, Math.max(0, floor)) : 0;
  return clamp01(Math.max(min, raw));
}

function decide(
  score: number,
  threshold: number,
  holdRatio: number,
  breakerActive: boolean,
  silent: boolean,
): MotivationDecision {
  if (breakerActive) return 'avoid';
  // 零信号直接收口：不依赖阈值兜底，否则 min_threshold=0 时又会误触发
  if (silent) return 'avoid';
  if (score >= threshold) return 'act';
  if (score >= threshold * holdRatio) return 'hold';
  return 'avoid';
}

/**
 * 动机评分主入口：返回每个技能的分数与决策明细，按分数降序。
 * 纯函数，不读写存储，便于测试与复现。
 */
export function scoreSkills(
  skills: SkillCard[],
  userText: string,
  config: DaughterConfig,
  ctx: MotivationContext = {},
): ScoredSkill[] {
  return skills
    // draft 也参与激活（§9.1「可执行，需确认」），deprecated 永不激活
    .filter((skill) => skill.status === 'active' || skill.status === 'frozen' || skill.status === 'draft')
    .map((skill) => {
      const keywordHits = skill.keywords.filter((keyword) => keyword && userText.includes(keyword)).length;
      const similarity = diceSimilarity(userText, `${skill.name} ${skill.intent} ${skill.keywords.join(' ')}`);
      // 草稿是刚沉淀的，证据不足，打分打八折
      const penalty = skill.status === 'draft' ? 0.8 : 1;
      const signal = clamp01((similarity + keywordHits * 0.2) * penalty);
      // 完全没有刺激时不该产生行动意图，与阈值下限共同构成双保险
      const silent = signal <= 0;

      const { channel, strength } = classifySkillChannel(skill);
      const personalityOffset = computePersonalityOffset(ctx.persona?.l1.bigFive, channel, strength, config);
      const emotionOffset = computeEmotionOffset(ctx.l5, config);
      const threshold = computeThreshold(config.skills.min_main_score, personalityOffset, emotionOffset, config);

      const familiarityGain = computeFamiliarityGain(skill, config);
      const memoryGain = computeMemoryGain(skill, config, ctx);
      const situationMultiplier = computeSituationMultiplier(channel, ctx.persona, ctx.subPersona, config);
      const traitSignalGain = computeTraitSignalGain(ctx.persona?.l1.bigFive, channel, config);
      const breakerActive = isBreakerActive(skill, ctx.now);

      const score = breakerActive
        ? 0
        : clamp01(
            signal *
              (0.5 + 0.5 * familiarityGain) *
              (0.5 + 0.5 * memoryGain) *
              situationMultiplier *
              traitSignalGain,
          );
      const decision = decide(score, threshold, config.motivation.hold_ratio, breakerActive, silent);

      return {
        skill,
        breakdown: {
          skillId: skill.id,
          channel,
          signal,
          personalityOffset,
          emotionOffset,
          threshold,
          familiarityGain,
          memoryGain,
          situationMultiplier,
          traitSignalGain,
          score,
          decision,
          breakerActive,
        },
      };
    })
    .sort((a, b) => b.breakdown.score - a.breakdown.score);
}
