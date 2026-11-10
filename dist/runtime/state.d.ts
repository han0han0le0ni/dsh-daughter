import type { DaughterConfig, L4Contextual, L5State, PersonaBundle, SubPersona } from '../types.js';
export declare function createInitialL5(characterId: string, sessionId: string, now: string, persona: PersonaBundle, overdraft: number): L5State;
/**
 * 跨会话接力：换对话框后不是从基线重新出生，而是把上一段的 L5 按闲置时长向基线回落。
 *
 * 隔五分钟基本原样（还没到 idle_hours），隔一夜明显平复但不会归零——人换房间不清空情绪，
 * 但也不会带着上周的疲惫。是否跨会话、是否跨工作区由调用方按配置决定，这里只管衰减。
 */
export declare function carryL5(previous: L5State, sessionId: string, now: string, persona: PersonaBundle, config: DaughterConfig): L5State;
export declare function updateL5(prev: L5State, text: string, now: string, persona: PersonaBundle): L5State;
export declare function selectSubpersona(l4: L4Contextual, preferredId?: string): SubPersona;
export interface SentimentDetail {
    polarity: number;
    strength: number;
    /** 所有命中的情绪词（含被否定的正面词），供日志排查 */
    hits: string[];
    /** 命中的否定词 */
    negations: string[];
    /** 未被否定的正面词 */
    positives: string[];
    /** 命中的负面词 */
    negatives: string[];
}
/**
 * 情绪识别明细（A1 日志层）：极性/强度仍然是原公式的输出，
 * 只是把命中词、否定词一并带出来，供 logs/polarity 离线标定。
 * 不改 `sentimentPolarity` / `sentimentStrength` 的返回语义。
 */
export declare function analyzeSentiment(text: string): SentimentDetail;
export declare function sentimentPolarity(text: string): number;
/**
 * 情绪强度 0..1：极性只说方向，"你好"和"今天好累压力好大"都是 |1|，
 * 必须再乘一个强度，否则单字寒暄和真正的情绪波动在 L5 里等权。
 * 两个多字词命中即视为满强度。
 */
export declare function sentimentStrength(text: string): number;
export declare function countHits(text: string, words: string[]): number;
