import type { DaughterConfig, EventRecord, L5State, MoralOutlook, PersonaBundle, PromptBlock, ReflexAction, ReflexRule, RetrievalHit, SafetyVerdict, SkillActivation, SkillCard, SubPersona, WindowNamer } from '../types.js';
import type { PersonProfile, ThingProfile } from './maintenance.js';
import type { ThreadHead } from './threading.js';
import { type MotivationContext } from './motivation.js';
import { type WeightedLabel } from './weights.js';
/** 做任务时的说话节奏：不让模型在连续工具调用中保持沉默。 */
export declare const WORKING_STYLE: string;
/** 性格权重：各维独立强度（0.00–1.00，两位小数），取最强三档，彼此不归一 */
export declare function traitWeights(bigFive: PersonaBundle['l1']['bigFive']): WeightedLabel[];
/** 关系：主档按已存阶段（回退有迟滞），括号里给权重，顺带说在往哪一档走 */
export declare function stageLine(l2: PersonaBundle['l2']): string;
export declare function buildPersonaText(persona: PersonaBundle, sub: SubPersona): string;
/**
 * 关系与偏好注入：把人物画像（亲密度/关系变化）、事物喜好、善恶观压缩成几行。
 * 星图与 prompt 共用同一套计算，避免两处口径不一致。
 *
 * 偏好行不再静默消失：没有明确喜恶时退成"最近常聊"，把她攒下来的相处量说出来——
 * 主档叫"中性"不等于这段关系没内容，只是还没长出喜恶。
 */
export declare function buildRelationText(input: {
    person?: PersonProfile;
    things: ThingProfile[];
    moral: MoralOutlook;
}): string;
export declare function buildStateHint(l5: L5State, verdict: SafetyVerdict): string;
/**
 * 技能激活：动机决策层的入口。
 * 默认走动机评分（人格/情绪调阈值，熟悉度/记忆/情境调分数）；
 * motivation.enabled=false 时退回旧的相似度打分，保证可随时对照。
 */
export declare function activateSkills(skills: SkillCard[], userText: string, config: DaughterConfig, ctx?: MotivationContext): SkillActivation;
export declare function matchReflex(rules: ReflexRule[], userText: string, l5: L5State, lastFired: Record<string, string>, now: string, config: DaughterConfig, source?: EventRecord['source']): {
    rule: ReflexRule;
    action: ReflexAction;
} | null;
/**
 * 反射规则归一化：旧版 rules.yaml 可能没有 enabled / priority / cooldownMs，
 * 直接按原值使用会让 `if (!rule.enabled)` 把所有规则当成停用。这里补齐默认值。
 */
export declare function normalizeReflexRule(raw: unknown): ReflexRule | null;
/**
 * 事件摘要块。命中事件若在全文层有更完整的记录（§4.4），
 * 且调用方已按预算取出摘录，就拼在同一行末尾，避免多占行数影响裁剪顺序。
 *
 * 每行带一个相对时间（"3 小时前"/"昨天"）：没有这个锚，模型分不清是刚才还是上个月，
 * `now` 缺省时不显示，便于只关心内容的调用方与测试。
 */
export declare function buildEventDigest(hits: RetrievalHit[], excerpts?: Map<string, string>, now?: string, currentSessionId?: string, 
/** 窗口名字的来源：生产环境传落库的编号（窗1/窗2），缺省用稳定短哈希 */
namer?: WindowNamer): string;
/**
 * 跨窗口轨道：单独一块、独立预算，不跟"当前话题检索"混在同一块里。
 * 这样它不受当前窗口上下文影响——无论这边聊什么、检索出多少，这一块都在。
 *
 * 每行都标"别处·窗XX"，块头写清这边是哪个窗：不给名字时，本窗口刚说的话
 * 会被当成别处的，模型就开始对着自己的回声往下推。
 */
export declare function buildCrossWindowDigest(hits: RetrievalHit[], now?: string, currentSessionId?: string, namer?: WindowNamer): string;
/**
 * "局"前情摘要：把同一局跨窗口、跨轮的几条事件合成一行，让两个窗口看到的是同一局，
 * 而不是各捡一条残迹。只给结构（几轮、跨几个窗口、最后一句原话）与开合状态，
 * 不塞整局全文——"卡在我看不见，等她给线索"这种原话才是下次能接上的地方。
 */
export declare function buildThreadDigest(heads: ThreadHead[], now?: string, currentSessionId?: string, namer?: WindowNamer): string;
export declare function buildSkillDigest(activation: SkillActivation): string;
export declare const NO_MEMORY_CONSTRAINT: string;
export declare function buildBlocks(input: {
    personaText: string;
    stateHint: string;
    eventDigest: string;
    crossWindowText: string;
    threadText: string;
    skillDigest: string;
    associationText: string;
    constraint: string | null;
    config: DaughterConfig;
}): {
    blocks: PromptBlock[];
    usedTokens: number;
};
/** 超预算时按优先级丢弃：联想 → 低分事件 → 技能压缩 */
export declare function clipBlocks(blocks: PromptBlock[], maxTotal: number): {
    blocks: PromptBlock[];
    usedTokens: number;
};
