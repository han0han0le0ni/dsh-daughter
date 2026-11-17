/**
 * VPet 下行事件队列：序号 + 游标 + ack，保证 MOD 短暂掉线时不丢事件。
 *
 * 旧版 MOD 不带 `since` 调用 /vpet/events，这里保留一次性领取（legacy）语义；
 * 新版 MOD 带游标读取，处理完再 ack，服务端只裁剪已确认的事件。
 */
export type VpetEventKind = 'thinking' | 'tool' | 'reply' | 'error' | 'motion' | 'move';
export interface VpetEvent {
    kind: VpetEventKind;
    text?: string;
    tool?: string;
    /** 动作包 ID（MOT-HUG / MOT-PAT …），用于兼容旧映射 */
    motionId?: string;
    /** VPet 原生 GraphType 名称，DSH 接管动画时直接指定 */
    graph?: string;
    /** 循环次数，0 表示只播放入场和收尾 */
    loops?: number;
    /** 窗口相对位移（像素） */
    dx?: number;
    dy?: number;
    durationMs?: number;
    seq: number;
}
export interface VpetHeartbeat {
    at: string;
    saveFound: boolean;
    saveFile?: string;
    saveMtimeMs?: number;
    name?: string;
    level?: number;
    mode?: string;
    /** 存档里的体力/心情（0..100），旧版 bridge 不带 */
    strengthPct?: number;
    feelingPct?: number;
}
/** 桌宠 MOD 自报能力：支持哪些原生动画、能做什么，DSH 不必再猜。 */
export interface VpetConsumerCapabilities {
    graphs: string[];
    actions: string[];
    queue: boolean;
    queueCapacity?: number;
}
/** 桌宠 MOD 自报运行状态：忙闲、玩家是否在交互、队列积压、窗口位置。 */
export interface VpetConsumerState {
    busy: boolean;
    reason?: string;
    currentGraph?: string;
    playerActive: boolean;
    lastInteractionAt?: string;
    queued: number;
    dropped: number;
    activity?: string;
    topmost?: boolean;
    lastSeq?: number;
    window?: {
        left: number;
        top: number;
        width: number;
        height: number;
    };
}
export interface VpetConsumerReport {
    version?: string;
    pollMs?: number;
    capabilities?: VpetConsumerCapabilities;
    state: VpetConsumerState;
}
/** `/vpet/status` 里呈现的 MOD 自报摘要。 */
export interface VpetConsumerInfo {
    online: boolean;
    ageMs: number | null;
    version?: string;
    pollMs?: number;
    capabilities?: VpetConsumerCapabilities;
    state?: VpetConsumerState;
}
/** MOD 上报在 HTTP 边界上做一次收敛：只接受已知字段，长度与范围都限制住。 */
export declare function normalizeConsumerReport(raw: unknown): VpetConsumerReport | null;
export declare class VpetBridgeState {
    private readonly events;
    private latestSeq;
    private evictedFrom;
    private evictedUpTo;
    private legacyCursor;
    private lastPollAt;
    private pollCount;
    private ackedUpTo;
    private lastAckAt;
    private readonly capacity;
    private lastHeartbeatAt;
    private lastHeartbeat;
    private lastReportAt;
    private lastConsumerReport;
    constructor(capacity?: number);
    /** 入队并分配递增序号；超过容量时丢弃最旧事件并计入 dropped。 */
    push(input: Omit<VpetEvent, 'seq'>): VpetEvent;
    /**
     * 游标读取：返回 seq > since 的事件，不删除。
     * 不传 since 时按旧版 MOD 的"一次性领取"处理。
     * `lost` 表示 since 之后已被容量淘汰、无法补发的事件数。
     */
    read(since?: number, now?: number): {
        seq: number;
        oldestSeq: number | null;
        events: VpetEvent[];
        lost: number;
    };
    /** 确认已处理到 seq；返回本次裁剪的事件数。 */
    ack(seq: number, now?: number): number;
    /** 旧版 /vpet/say 兼容：取走最早一条 reply。 */
    takeReply(): string | undefined;
    heartbeat(payload: Omit<VpetHeartbeat, 'at'>, now?: number): void;
    /** 接收 MOD 自报的能力与状态；返回归一化后的报告，非法载荷返回 null。 */
    reportConsumer(raw: unknown, now?: number): VpetConsumerReport | null;
    /** MOD 最近一次上报的摘要；从未上报时返回 null。 */
    consumerInfo(now?: number): VpetConsumerInfo | null;
    /** MOD 上报的原生动画清单；没有新鲜上报时返回 null（不启用能力校验）。 */
    supportedGraphs(now?: number): string[] | null;
    /** MOD 是否正忙或玩家正在交互：用于给自主情绪动作让行。 */
    playerActive(now?: number): boolean;
    status(now?: number): {
        latestSeq: number;
        pending: number;
        oldestSeq: number | null;
        dropped: number;
        consumer: {
            online: boolean;
            lastPollAt: string | null;
            staleMs: number | null;
            pollCount: number;
            ackedUpTo: number;
            lastAckAt: string | null;
            unread: number;
            info: VpetConsumerInfo | null;
        };
        bridge: {
            online: boolean;
            lastHeartbeatAt: string | null;
            staleMs: number | null;
            saveFound: boolean | null;
            saveFile?: string;
            saveMtimeMs?: number;
            name?: string;
            level?: number;
            mode?: string;
            strengthPct?: number;
            feelingPct?: number;
        };
    };
    private oldestSeq;
    private lostSince;
}
