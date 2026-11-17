import type { DaughterConfig, L5State, SpeakReason, ThinkPlan } from '../types.js';
/**
 * 碎碎念（DEF-23）：她一个人待着时冒出的短句。
 *
 * 与 `speak.ts` 的分工：主动开口是**社交**意愿（想你、想分享、想照顾），
 * 这里只是**心里有事**——情绪强度、唤醒和压力推着一句很短的话出来。
 * 因此不合并进 speak：两边的触发条件、文案长度和出口语义都不同。
 */
export interface ThinkContext {
    now: string;
    l5?: L5State;
    /** 距上次碎碎念多少分钟；从未有过传 null */
    sinceLastThinkMinutes: number | null;
    /** 抖动 [-1,1]，由调用方注入（便于测试给定值） */
    jitter?: number;
}
/** 内在活动强度：情绪显著、唤醒高、压力大时更想嘟囔一句 */
export declare function computeThinkIntensity(ctx: ThinkContext, config: DaughterConfig): number;
/** 她此刻在为什么嘟囔——只用来选文案池，不参与阈值 */
export declare function pickThinkReason(l5: L5State | undefined): SpeakReason;
/**
 * 主入口：返回这轮要不要嘟囔、嘟囔哪几句。
 * 纯函数、可复现：条数与选句都由 seed 派生，不碰存储也不写事件。
 */
export declare function evaluateThink(ctx: ThinkContext, config: DaughterConfig, options?: {
    seed?: string;
}): ThinkPlan | null;
