import type { AssociationHit, DaughterConfig, EventRecord, L5State, PadState, RetrievalHit } from '../types.js';
import type { PluginContext } from '../types.js';
import type { Store } from '../store.js';
export interface RetrieveArgs {
    characterId: string;
    query: string;
    now: string;
    topK: number;
    currentEmotion: PadState;
    excludeArchived: boolean;
    config: DaughterConfig;
    candidates: EventRecord[];
    /** 可选 FTS5 字面检索（D-02）：query → eventId → 0..1 的匹配分；缺省时只用 Dice */
    ftsScores?: (query: string) => Map<string, number>;
}
export declare function retrieveEvents(args: RetrieveArgs): RetrievalHit[];
export declare function associateEvents(seedIds: string[], candidates: EventRecord[], maxDepth: number, maxInjected: number, hopDecay: number): AssociationHit[];
/** 概率联想：从最近 30 天的非归档事件中随机挑 1 条，同种子可复现 */
export declare function applySurprise(hits: RetrievalHit[], candidates: EventRecord[], config: DaughterConfig, rng: () => number, now: string): RetrievalHit[];
/** 回忆重构：命中事件时按当前情绪追加一条 emotion_now_history，不覆盖 emotion_at_time */
export declare function reconstructOnRecall(store: Store, event: EventRecord, l5: L5State, now: string): boolean;
export declare function extractEvent(ctx: PluginContext, userText: string, assistantText: string, l5: L5State, rng: () => number): EventRecord;
/**
 * 新事件入库后，与最近的相似事件建立弱链接（双向，最多 maxLinks 条）。
 * 相似度 = 共享标签 + 共享人物 ×0.5 + 7 天内 ×0.2。
 */
export declare function linkNewEvent(store: Store, event: EventRecord, maxLinks?: number): number;
