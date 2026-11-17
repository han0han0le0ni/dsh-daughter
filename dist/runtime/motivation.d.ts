import type { BigFive, DaughterConfig, EventRecord, L5State, MotivationBreakdown, PersonaBundle, SignalChannel, SkillCard, SubPersona } from '../types.js';
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
/** 按名称/意图/关键词的命中情况判断技能属于哪个动机通道 */
export declare function classifySkillChannel(skill: SkillCard): {
    channel: SignalChannel;
    strength: number;
};
/**
 * 人格只调阈值：Σ gain * (trait - 0.5) * 2 * strength * sign。
 * 正数表示更难触发，负数表示更容易触发。
 */
export declare function computePersonalityOffset(bigFive: BigFive | undefined, channel: SignalChannel, strength: number, config: DaughterConfig): number;
/**
 * 人格对分数的增益（方向舵）。返回乘子 1±gain：
 * >1 的通道"更想走"，<1 的通道"没那么想走"。
 * 它改变通道之间的比分排序，但不会凭空造信号——signal=0 时乘完仍是 0。
 */
export declare function computeTraitSignalGain(bigFive: BigFive | undefined, channel: SignalChannel, config: DaughterConfig): number;
/** 情绪覆盖：安全感低/压力高/愉悦低/疲劳高时更谨慎，唤醒高时更容易行动 */
export declare function computeEmotionOffset(l5: L5State | undefined, config: DaughterConfig): number;
/**
 * 熟悉度倒 U：用得太少会犹豫，用得太多会厌倦，峰值落在 exposure≈peak 处。
 * exposure = uses / (uses + k)。
 */
export declare function computeFamiliarityGain(skill: SkillCard, config: DaughterConfig): number;
/** 情绪记忆：近期事件里与技能关键词相关事件的平均愉悦度 */
export declare function computeEmotionMemory(skill: SkillCard, ctx: MotivationContext, config: DaughterConfig): number;
/**
 * 记忆三路径合成：结果预期（按上次使用时间衰减）、情绪记忆、自我效能。
 * 返回 0..1，0.5 为中性。
 */
export declare function computeMemoryGain(skill: SkillCard, config: DaughterConfig, ctx?: MotivationContext): number;
/**
 * 情境乘子：social 通道按亲和度（关系深度 + 当前子人格披露度）放大或缩小，
 * 其余通道只吃一半影响。
 */
export declare function computeSituationMultiplier(channel: SignalChannel, persona: PersonaBundle | undefined, subPersona: SubPersona | undefined, config: DaughterConfig): number;
/** 熔断期内该技能只避不做 */
export declare function isBreakerActive(skill: SkillCard, now: string | undefined): boolean;
/**
 * 阈值 = 基础分 + 人格偏移 + 情绪偏移，再被 min_threshold 兜底。
 * 没有这个下限时，极端人格（外向/宜人拉满）能把阈值压到 0，
 * 于是 score=0 的"零信号"也能满足 score >= threshold。
 */
export declare function computeThreshold(base: number, personalityOffset: number, emotionOffset: number, config: DaughterConfig): number;
/**
 * 动机评分主入口：返回每个技能的分数与决策明细，按分数降序。
 * 纯函数，不读写存储，便于测试与复现。
 */
export declare function scoreSkills(skills: SkillCard[], userText: string, config: DaughterConfig, ctx?: MotivationContext): ScoredSkill[];
