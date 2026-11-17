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
/** FNV-1a 字符串哈希：把稳定字符串折成种子，同输入同输出 */
export declare function hashText(value: string): number;
/** mulberry32，确定性随机源 */
export declare function createRng(seed: number): () => number;
export declare function newEventId(now: string, rand: () => number): string;
export declare function safeFileName(value: string): string;
export declare function daysBetween(from: string, to: string): number;
/**
 * 相对时间（"3 小时前""昨天"），注入记忆行时用。
 *
 * 记忆里只有绝对时间戳，模型拿到一列标题和摘要，分不清是刚才还是上个月，
 * 于是不敢说"上次"、也不会说"刚才"。给它一个相对锚点，指代才有落点。
 * 一天以上按 24 小时折算（"昨天"= 24–48 小时前），不做日历日边界——注入不需要那么精确。
 */
export declare function relativeTime(from: string, to: string): string;
/**
 * 绝对时间戳（本地时钟）：今天的显示 `HH:MM`，更早的显示 `MM-DD HH:MM`。
 * 跨窗口连贯性用它：相对时间只说"多久前"，绝对时钟才能把"我跑了 → 你好"接成一条时间线。
 */
export declare function formatTimestamp(iso: string, now?: string): string;
/**
 * 窗口的名字：同一个会话每次都叫同一个名，换个窗口就换个名。
 *
 * 没有名字时，注入的每行只有时间戳，"这句话是我在这边刚说的"和"是那边说的"分不开，
 * 本窗口的话被当成别处的、自己跟自己的回声往下推。给窗口一个能念出来的短名，
 * 贴过来时就能标清哪句是这儿、哪句是别处。
 */
export declare function windowName(sessionId?: string | null): string;
export declare function truncate(text: string, max: number): string;
