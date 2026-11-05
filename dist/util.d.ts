export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface FileLockOptions {
    /** false 时退化为无锁写（对应 storage.single_writer: false） */
    enabled?: boolean;
    timeoutMs?: number;
    staleMs?: number;
    /** 拿不到锁时调用，便于上层记日志 */
    onTimeout?: () => void;
}
/**
 * 角色级写锁（§5.3 单写者）：以 `<目标文件>.lock` 的独占创建实现跨进程互斥。
 * 拿不到锁超过 timeoutMs 时释放降级为无锁写，避免阻塞会话主流程。
 */
export declare function withFileLock<T>(target: string, fn: () => T, options?: FileLockOptions): T;
/**
 * 原子写文件：先写同目录临时文件再 rename 覆盖，避免进程中断留下半截 YAML/JSON。
 * Windows 上 rename 覆盖偶发失败时退化为直写。
 */
export declare function atomicWriteFile(path: string, content: string): void;
/** 原子写 + 角色级锁的最小组合，供 Store 的各类落盘复用 */
export declare function writeLocked(path: string, content: string, options?: FileLockOptions): void;
export interface Logger {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
}
/**
 * 工具级安全闸门（§10.1）：安全档位 ≥2 时只有只读工具放行。
 * 由宿主注入到各连接器工具里，避免降级期间仍能操作鼠标/窗口。
 */
export type ToolGate = (intent: 'read' | 'write') => {
    allowed: boolean;
    reason?: string;
};
export declare function checkToolGate(gate: ToolGate | undefined, intent: 'read' | 'write', tool: string): void;
export declare const silentLogger: Logger;
export declare function clamp01(value: number): number;
export declare function clampPad(value: number): number;
/** 粗略 token 估算：CJK 字符按 1 token，其他字符按 4 字符 1 token */
export declare function estimateTokens(text: string): number;
/** PAD 距离，归一化到 0..1（每维量程为 2） */
export declare function padDistance(a: {
    pleasure: number;
    arousal: number;
    dominance: number;
}, b: {
    pleasure: number;
    arousal: number;
    dominance: number;
}): number;
/** 字符二元组 Dice 相似度，作为无语义向量时的退化实现 */
export declare function diceSimilarity(a: string, b: string): number;
/** mulberry32，确定性随机源 */
export declare function createRng(seed: number): () => number;
export declare function newEventId(now: string, rand: () => number): string;
export declare function safeFileName(value: string): string;
export declare function daysBetween(from: string, to: string): number;
export declare function truncate(text: string, max: number): string;
