import type { BigFive, DaughterConfig, L5State, SpeakPlan, SpeakReason } from '../types.js';
/**
 * 主动开口的评估上下文。
 *
 * 与 `motivation.ts` 的分工：那边回答"这条技能该不该用"，需要用户输入；
 * 这边回答"没人跟我说话时，我想不想开口"，信号来自沉默时长而不是文本。
 */
export interface SpeakContext {
    now: string;
    bigFive?: BigFive;
    l5?: L5State;
    /** L2 关系深度，越熟越随意 */
    relationshipDepth?: number;
    /** 距最后一次对话（用户说的或她说的）多少分钟 */
    idleMinutes: number;
    /** 距上次主动开口多少分钟；从未开口传 null */
    sinceLastSpeakMinutes: number | null;
    /** 今天已经主动开口几次 */
    todayCount: number;
    /** 上一轮 hold 留下的"憋着"压力 */
    carry: number;
    /** 当前前台窗口；桌面桥接不可用时为空，按"看不见屏幕"处理 */
    foreground?: {
        title?: string;
        processName?: string;
    } | null;
    /** 抖动，[-1,1]，由调用方注入（便于测试给定值） */
    jitter?: number;
}
export interface SpeakOptions {
    /** 最近用过的文案下标，用来避开重复（建议保留最近 5 条） */
    recentLines?: number[];
    /** 文案种子；默认用 now */
    seed?: string;
}
/** 支持跨午夜，例如 [23, 7] 表示 23:00–次日 06:59 */
export declare function inQuietHours(hour: number | null, range: number[]): boolean;
/**
 * 思念累积：随时间单调上升并饱和，但比指数曲线更慢。
 * idle = half 时约 0.5，idle = 3×half 时才 0.75——人不会因为两小时没说话就急。
 */
export declare function idleUrge(idleMinutes: number, halfMinutes: number): number;
/**
 * 人格对"想不想开口"的影响。这里是**强度侧**，不是门槛侧：
 * 外向的人不是门槛低，而是同样的沉默时长下更坐不住。
 */
export declare function personalityUrge(bigFive: BigFive | undefined, config: DaughterConfig): number;
/** 情绪：高兴想分享，累/压力/没安全感就不想开口 */
export declare function emotionUrge(l5: L5State | undefined): number;
export declare function relationshipUrge(depth: number | undefined): number;
/** 想说不想说，0..1 */
export declare function computeSpeakUrge(ctx: SpeakContext, config: DaughterConfig): number;
/**
 * 从当前前台窗口猜"这会儿打扰她/他的代价" 0..1。
 * 看不见屏幕（null）返回 0——不该因为探测失败就整天沉默。
 */
export declare function foregroundBusy(foreground?: {
    title?: string;
    processName?: string;
} | null): number;
/**
 * 该不该说，0..1。只有"合不合适"，不含人格——
 * 人格属于"想不想"，走 `computeSpeakUrge`，这样两条边不互相污染。
 */
export declare function computeSpeakThreshold(ctx: SpeakContext, config: DaughterConfig): number;
/** 判断"她当时在想什么"，决定文案池 */
export declare function pickSpeakReason(ctx: SpeakContext): SpeakReason;
/** 按种子从对应池里挑一句；`avoid` 是最近说过的那几句，尽量避开 */
export declare function pickSpeakLine(reason: SpeakReason, seed: string, avoid?: number[]): {
    text: string;
    index: number;
};
/** 本地日期键，用于"每天最多说几次"的计数分桶 */
export declare function localDayKey(now: string): string;
/**
 * 主入口：返回这一轮"说不说、为什么、说什么"。
 * 纯函数，不碰存储——冷却、日上限、carry 都由调用方读写。
 */
export declare function evaluateSpeak(ctx: SpeakContext, config: DaughterConfig, options?: SpeakOptions): SpeakPlan;
