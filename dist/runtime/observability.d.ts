import type { DaughterMetrics } from '../types.js';
/** 单轮运行观测：耗时、注入 token、检索命中、是否降级 */
export interface TurnObservation {
    at: string;
    sessionId: string;
    turnId: string;
    characterId: string;
    tookMs: number;
    /** 检索阶段耗时，用于核对 §6.1 的 150ms 预算 */
    retrieveMs?: number;
    /** 本轮是否超出 §6.1 时延预算（retrieve >150ms 或整轮 >100ms） */
    overBudget?: boolean;
    injectTokens: number;
    hits: number;
    skills: number;
    memoryHit: boolean;
    degraded: boolean;
}
/** 反射命中观测：规则、耗时、动作结果 */
export interface ReflexObservation {
    at: string;
    sessionId: string;
    turnId: string;
    characterId: string;
    ruleId: string;
    actionKind: string;
    tookMs: number;
    ok: boolean;
}
/**
 * 运行/反射日志与指标（§13）。日志按角色追加到 logs/run、logs/reflex；
 * 指标保留最近 200 轮的环形窗口，同时落盘到 logs/metrics，进程重启后可继续累积。
 */
export declare class Observability {
    private readonly characterId;
    private readonly runDir;
    private readonly reflexDir;
    private readonly metricsDir;
    private readonly metricsPath;
    private turns;
    private reflexHits;
    private degradedTurns;
    private memoryHitTurns;
    private overBudgetTurns;
    private tokens;
    private readonly maxLogBytes;
    constructor(dataRoot: string, characterId: string, options?: {
        maxLogBytes?: number;
    });
    recordTurn(observation: TurnObservation): void;
    recordReflex(observation: ReflexObservation): void;
    metrics(): DaughterMetrics;
    private append;
    private persist;
    private restore;
}
