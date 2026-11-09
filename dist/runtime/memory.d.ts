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
/**
 * 一条字面命中都没有时，从记忆网里挑一个种子往外摸（`fallback_when_no_match`）。
 *
 * 早期实现挑"出边最多"的那条：不管用户说了什么，都从同一段最热闹的记忆顺下去，
 * 当下情绪完全没参与，情绪共鸣（"今天很累"想起上次也很累的那天）就落不了地。
 * 现在先按"情绪像 + 近"排序，出边只作为能否联想的前提——没有出边的种子顺不出东西，
 * 挑它等于白挑，不如不挑，让上层走 `[无记忆约束]`。
 */
export declare function pickAssociationSeed(candidates: EventRecord[], currentEmotion: PadState, now: string, config: DaughterConfig): EventRecord | undefined;
/**
 * 沿联想边扩展（BFS）。返回的是"经由哪条边、走了几步、为什么想起"。
 *
 * 两处和早期实现的差异：
 * - 边的遍历按 strength 降序，弱边直接跳过。之前 12 条出边等权遍历，
 *   取前 2 条基本等于随机挑。
 * - 同一目标被多条路径命中时做残值累加：多条线索都指向它，说明这段记忆在
 *   记忆网里更"中心"，分数应当更高，而不是被 visited 直接丢弃。
 */
export declare function associateEvents(seedIds: string[], candidates: EventRecord[], maxDepth: number, maxInjected: number, hopDecay: number): AssociationHit[];
/**
 * 概率联想条目的 reason。调用方据此把它排除出「真实召回」：
 * 随机抽中的事件不能写 recallCount / weight，否则会被忘却扫描当成「被想起过」永久保活。
 */
export declare const SURPRISE_REASON = "\u968F\u673A\u8054\u60F3\uFF08\u53EF\u590D\u73B0\uFF09";
/** 概率联想：从最近 30 天的非归档事件中随机挑 1 条，同种子可复现 */
export declare function applySurprise(hits: RetrievalHit[], candidates: EventRecord[], config: DaughterConfig, rng: () => number, now: string): RetrievalHit[];
/**
 * 当前情绪与这条记忆"上次被想起时的感受"之间的位移。
 * 没有回看记录时以事件发生当下的情绪为基准。
 */
export declare function recallDrift(event: EventRecord, emotion: PadState): number;
/** 回忆重构：命中事件时按当前情绪追加一条 emotion_now_history，不覆盖 emotion_at_time */
export declare function reconstructOnRecall(store: Store, event: EventRecord, l5: L5State, now: string, minDistance?: number, cooldownMinutes?: number): boolean;
/**
 * 参与者按来源推导。
 *
 * 早期所有事件都写 ['self','user']，可"刷到一条视频""后台切了个窗口"这类单向输入里
 * 根本没有用户参与：社交性项恒为 1 让显著性虚高，人物画像把这些噪声算成"一起做的事"，
 * L2 亲密度的锚点跟着失真——一处口径错，三处下游一起歪。
 * 单机游戏与外部内容暂时只记自己（还没有识别同场玩家的通道）。
 */
export declare function participantsFor(source: EventRecord['source'], audience?: 'to_father' | 'to_stranger' | 'alone'): string[];
export declare function extractEvent(ctx: PluginContext, userText: string, assistantText: string, l5: L5State, rng: () => number, source?: EventRecord['source']): EventRecord;
/**
 * 新事件入库后，与最近的相似事件建立弱链接（双向，最多 maxLinks 条）。
 * 相似度 = 共享标签 + 共享人物 ×0.5 + 7 天内 ×0.2。
 */
export declare function linkNewEvent(store: Store, event: EventRecord, maxLinks?: number): number;
