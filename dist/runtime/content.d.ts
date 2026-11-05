import type { DaughterConfig, EventRecord, L5State, MoralOutlook, PersonaBundle, PromptBlock, ReflexAction, ReflexRule, RetrievalHit, SafetyVerdict, SkillActivation, SkillCard, SubPersona } from '../types.js';
import type { PersonProfile, ThingProfile } from './maintenance.js';
/** 做任务时的说话节奏：不让模型在连续工具调用中保持沉默。 */
export declare const WORKING_STYLE: string;
export declare function buildPersonaText(persona: PersonaBundle, sub: SubPersona): string;
/**
 * 关系与偏好注入：把人物画像（亲密度/关系变化）、事物喜好、善恶观压缩成三行。
 * 星图与 prompt 共用同一套计算，避免两处口径不一致。
 */
export declare function buildRelationText(input: {
    person?: PersonProfile;
    things: ThingProfile[];
    moral: MoralOutlook;
}): string;
export declare function buildStateHint(l5: L5State, verdict: SafetyVerdict): string;
export declare function activateSkills(skills: SkillCard[], userText: string, config: DaughterConfig): SkillActivation;
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
 */
export declare function buildEventDigest(hits: RetrievalHit[], excerpts?: Map<string, string>): string;
export declare function buildSkillDigest(activation: SkillActivation): string;
export declare const NO_MEMORY_CONSTRAINT: string;
export declare function buildBlocks(input: {
    personaText: string;
    stateHint: string;
    eventDigest: string;
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
