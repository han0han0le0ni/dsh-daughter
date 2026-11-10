import type { ExpressionSinkConfig } from '../types.js';
import type { Logger } from '../util.js';
/**
 * 表达事件的种类：speak = 她主动说的话（正式开口）；
 * think = 思考碎碎念（DEF-23），只在出口显示短句，不构成回复、不写记忆。
 */
export type ExpressionKind = 'speak' | 'think';
export interface ExpressionEvent {
    kind: ExpressionKind;
    characterId: string;
    at: string;
    /** 要显示或播报的文本 */
    text?: string;
    /** 动机分类（miss / care / share / worry / bored），对端可据此换表情 */
    reason?: string;
    /** 想说的强度 0..1，对端可用来决定音量或动画力度 */
    intensity?: number;
}
export type ExpressionSink = (event: ExpressionEvent) => void | Promise<void>;
export interface DispatchResult {
    delivered: number;
    failed: number;
    /** 失败原因，最多保留 3 条，避免日志爆炸 */
    errors: string[];
}
interface FetchResponseLike {
    ok: boolean;
    status: number;
    text?(): Promise<string>;
}
type FetchLike = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<FetchResponseLike>;
/**
 * 并发投递到所有出口。单个出口抛错只记一笔，不影响其他出口——
 * 桌宠没开不该导致 webhook 也收不到。
 */
export declare function dispatchExpression(event: ExpressionEvent, sinks: ExpressionSink[]): Promise<DispatchResult>;
/** HTTP 出口：POST 一份 JSON 给任意应用（自建服务、机器人桥、桌面壳） */
export declare function createHttpSink(url: string, options?: {
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    logger?: Partial<Logger>;
}): ExpressionSink;
/** 文件出口：追加 JSONL，任何本地进程都能 tail -f 跟着看 */
export declare function createFileSink(filePath: string, options?: {
    logger?: Partial<Logger>;
}): ExpressionSink;
/**
 * 按配置组装出口。`vpet` 需要宿主的事件队列、`pet` 需要宿主自己的监听地址，
 * 都由调用方注入；未知 type 在配置归一化阶段已被剔除，这里再挡一次。
 */
export declare function buildExpressionSinks(sinks: ExpressionSinkConfig[], deps?: {
    vpetSink?: ExpressionSink;
    logger?: Partial<Logger>;
    resolvePath?: (path: string) => string;
    /** pet 出口的缺省基地址（本机 webServer）；配置里写了 url 就以配置为准 */
    petBaseUrl?: string | null;
}): ExpressionSink[];
export {};
