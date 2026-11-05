import type { L4Contextual, L5State, PersonaBundle, SubPersona } from '../types.js';
export declare function createInitialL5(characterId: string, sessionId: string, now: string, persona: PersonaBundle, overdraft: number): L5State;
export declare function updateL5(prev: L5State, text: string, now: string, persona: PersonaBundle): L5State;
export declare function selectSubpersona(l4: L4Contextual, preferredId?: string): SubPersona;
export declare function sentimentPolarity(text: string): number;
/**
 * 情绪强度 0..1：极性只说方向，"你好"和"今天好累压力好大"都是 |1|，
 * 必须再乘一个强度，否则单字寒暄和真正的情绪波动在 L5 里等权。
 * 两个多字词命中即视为满强度。
 */
export declare function sentimentStrength(text: string): number;
export declare function countHits(text: string, words: string[]): number;
