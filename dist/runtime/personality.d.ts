/**
 * 性格演化：写实为基，关键事件才能把人推到极端。
 *
 * 三条不变量（见设计文档「性格多样性演化」）：
 *   1. 日常聊天不动 L1——只走 L5 情绪；人格只被「累积/关键」事件推动
 *   2. 五维只能在出生锚点 ±drift_cap 内漂移，既保稳定又留极端空间
 *   3. 修复按依恋类型不对称：焦虑型一次失约就回退，回避型被逼问会倒退
 *
 * 出生只抽安全 / 焦虑 / 回避三种，混乱型只能由「靠近 → 被伤害」的循环演化出来。
 */
import type { AttachmentType, BigFive, DaughterConfig, ImpactKind, L1Baseline, L2Relationship, L5State, SelfNarrative } from '../types.js';
import type { Store } from '../store.js';
import { type PersonalityControl } from './personality-control.js';
export interface InitialPersonalityInput {
    ranges: Record<keyof BigFive, [number, number]>;
    attachment_priors: {
        secure: number;
        anxious: number;
        avoidant: number;
    };
}
export declare const DEFAULT_INITIAL_RANGES: Record<keyof BigFive, [number, number]>;
export declare const DEFAULT_ATTACHMENT_PRIORS: {
    secure: number;
    anxious: number;
    avoidant: number;
};
/**
 * 出生人格：同一角色（character_id + seed）永远抽到同一组值，不同角色落在不同点。
 * 五维先在有界区间内抽样，再按弱相关拉一点 O/E 与 N/A 的关系，避免出现"出生即极端"。
 */
export declare function createInitialL1(characterId: string, seed: number, initial?: InitialPersonalityInput, now?: string): L1Baseline;
/** 气质由五维里最外显的两维决定；手填五维后也要按同一口径重算 */
export declare function temperamentOf(bigFive: BigFive): L1Baseline['temperament'];
/** 出生依恋：先验决定落点；混乱型不出生 */
export declare function createInitialL2(characterId: string, seed: number, initial?: InitialPersonalityInput, now?: string): L2Relationship;
/** 中性自我叙事（旧存档补齐用） */
export declare function defaultNarrative(now?: string): SelfNarrative;
/** 由焦虑/回避两维 + 是否具备混乱条件推导依恋底色 */
export declare function deriveAttachment(l2: L2Relationship, disorganizedEligible: boolean): AttachmentType;
export interface PersonalitySignalInput {
    /** 用户原话 */
    text: string;
    /** 写入记忆的事件 id，证据链会引用它 */
    eventId: string;
    l5: L5State;
    now: string;
}
export interface PersonalitySignalResult {
    changed: boolean;
    kind: ImpactKind;
    impact: number;
    layers: string[];
    evolutionIds: string[];
}
/**
 * 冲击度：情绪强度打底，关键/修复语句加权。
 * 没有关键标记时上限定在 0.5，普通闲聊（"最近状态不好"这类）落在 routine——
 * 这就是"写实"的闸门：人格不会被日常情绪推着走。
 */
export declare function scoreImpact(text: string, l5: L5State, thresholds?: {
    cumulative: number;
    critical: number;
}): {
    impact: number;
    kind: ImpactKind;
    repair: boolean;
};
/**
 * 把一次对话的冲击落到人格上。
 * 只有 cumulative / critical 会写 L1–L3；回复 routine 直接返回 changed=false。
 */
export declare function applyPersonalitySignal(store: Store, config: DaughterConfig, input: PersonalitySignalInput, control?: PersonalityControl): PersonalitySignalResult;
/**
 * 主人手填五维：同时改写出生锚点。
 * 只改当前值而不动 innate，下一次演化会立刻被 drift_cap 夹回旧锚点，
 * 等于「填了但没生效」，所以这里把锚点和当前值一起落下去。
 */
export declare function applyBigFiveSetup(store: Store, values: Partial<BigFive>, now: string): L1Baseline;
/**
 * 重抽初始人格：按新种子重新抽五维与依恋底色。
 * 保留关系进度、对人情感、记忆与技能——重抽的是「她本来是什么样」，
 * 不是把处出来的关系一起抹掉。
 */
export declare function rerollInitialPersonality(store: Store, config: DaughterConfig, seed: number, now: string): {
    l1: L1Baseline;
    l2: L2Relationship;
};
