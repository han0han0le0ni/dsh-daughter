/**
 * PAD → 桌宠动作：把当前情绪状态映射成一个可解释的桌宠动画。
 *
 * 只使用 VPet GraphType 中确实存在的成员（Say / Touch_Head / Sleep），
 * 避免因枚举名不存在而回落到默认动画。是否真正下发由 MoodMotionGate 控制，
 * 防止每轮对话都抢走桌宠的自主活动。
 */
import type { L5State } from '../types.js';
export type MoodBand = 'tired' | 'joy' | 'low';
export interface MoodMotion {
    band: MoodBand;
    graph: string;
    loops: number;
    reason: string;
}
export interface MoodMotionGateOptions {
    /** 任意两次情绪动作的最小间隔 */
    minIntervalMs?: number;
    /** 同一情绪带重复触发的最小间隔 */
    repeatIntervalMs?: number;
}
/** 纯函数：按压力/疲劳优先，其次愉悦度与唤醒度决定动作；平静时返回 null。 */
export declare function selectMoodMotion(l5: Pick<L5State, 'emotion' | 'stress' | 'fatigue'>): MoodMotion | null;
/** 带节流的情绪动作选择器：状态跨带时较快响应，同带重复则显著放慢。 */
export declare class MoodMotionGate {
    private lastAt;
    private lastBand;
    private readonly minIntervalMs;
    private readonly repeatIntervalMs;
    constructor(options?: MoodMotionGateOptions);
    next(l5: Pick<L5State, 'emotion' | 'stress' | 'fatigue'>, nowMs: number): MoodMotion | null;
}
