import type { SpeakPlan, SpeakReason } from '../types.js';
/**
 * 主动开口的按日聚合（DEF-18）。
 *
 * 只存计数，不存正文：目的是回答"她多久沉默一次""想说的都在什么动机下"，
 * 用来调阈值，不是第二套记忆。超出 7 天的桶直接丢弃。
 */
export interface SpeakStatsBucket {
    day: string;
    act: number;
    hold: number;
    silent: number;
    /** decision → 次数；silent 也有动机，便于看"哪类动机最常被阈值挡住" */
    reasons: Partial<Record<SpeakReason, number>>;
    updatedAt: string;
}
export interface SpeakStatsSummary {
    day: string;
    total: number;
    act: number;
    hold: number;
    silent: number;
    /** 沉默占比 0..1；没有样本时为 0 */
    silentRatio: number;
    reasons: Partial<Record<SpeakReason, number>>;
}
/** 记一次评估结果，返回要写回 meta 的 JSON */
export declare function recordSpeakStats(raw: string | null, plan: SpeakPlan, day: string, now: string): string;
/** 读某一天的汇总，供面板展示 */
export declare function readSpeakStats(raw: string | null, day: string): SpeakStatsSummary;
