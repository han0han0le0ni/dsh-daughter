/**
 * VPet 下行事件队列：序号 + 游标 + ack，保证 MOD 短暂掉线时不丢事件。
 *
 * 旧版 MOD 不带 `since` 调用 /vpet/events，这里保留一次性领取（legacy）语义；
 * 新版 MOD 带游标读取，处理完再 ack，服务端只裁剪已确认的事件。
 */
/** MOD 每秒轮询，超过 10s 无请求视为掉线 */
const CONSUMER_WINDOW_MS = 10_000;
/** bridge.mjs 默认 30s 一轮，超过 120s 无心跳视为掉线 */
const BRIDGE_WINDOW_MS = 120_000;
/** MOD 主动上报状态；超过 60s 没有新上报视为上报链路失效 */
const REPORT_WINDOW_MS = 60_000;
function clampInt(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number))
        return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
}
function shortText(value, max) {
    if (typeof value !== 'string')
        return undefined;
    const text = value.trim();
    return text ? text.slice(0, max) : undefined;
}
function stringList(value, max, itemMax) {
    if (!Array.isArray(value))
        return undefined;
    const result = [];
    for (const item of value) {
        const text = typeof item === 'string' ? item.trim().slice(0, itemMax) : '';
        if (text)
            result.push(text);
        if (result.length >= max)
            break;
    }
    return result;
}
/** MOD 上报在 HTTP 边界上做一次收敛：只接受已知字段，长度与范围都限制住。 */
export function normalizeConsumerReport(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const input = raw;
    const stateRaw = input.state;
    if (!stateRaw || typeof stateRaw !== 'object')
        return null;
    const state = stateRaw;
    const windowRaw = state.window;
    const window = windowRaw && typeof windowRaw === 'object'
        ? {
            left: clampInt(windowRaw.left, 0, -100_000, 100_000),
            top: clampInt(windowRaw.top, 0, -100_000, 100_000),
            width: clampInt(windowRaw.width, 0, 0, 10_000),
            height: clampInt(windowRaw.height, 0, 0, 10_000),
        }
        : undefined;
    const capabilitiesRaw = input.capabilities;
    const capabilities = capabilitiesRaw && typeof capabilitiesRaw === 'object'
        ? {
            graphs: stringList(capabilitiesRaw.graphs, 128, 64) ?? [],
            actions: stringList(capabilitiesRaw.actions, 16, 32) ?? [],
            queue: capabilitiesRaw.queue === true,
            queueCapacity: clampInt(capabilitiesRaw.queueCapacity, 16, 0, 1000),
        }
        : undefined;
    return {
        version: shortText(input.version, 64),
        pollMs: clampInt(input.pollMs, 1000, 100, 60_000),
        capabilities,
        state: {
            busy: state.busy === true,
            reason: shortText(state.reason, 32),
            currentGraph: shortText(state.currentGraph, 64),
            playerActive: state.playerActive === true,
            lastInteractionAt: shortText(state.lastInteractionAt, 64),
            queued: clampInt(state.queued, 0, 0, 1000),
            dropped: clampInt(state.dropped, 0, 0, 1_000_000),
            activity: shortText(state.activity, 64),
            topmost: state.topmost === true,
            lastSeq: clampInt(state.lastSeq, 0, 0, 1_000_000),
            window,
        },
    };
}
/** 队列容量：MOD 每秒轮询一次，200 条约等于 3 分钟缓冲 */
const DEFAULT_CAPACITY = 200;
export class VpetBridgeState {
    events = [];
    latestSeq = 0;
    evictedFrom = 0;
    evictedUpTo = 0;
    legacyCursor = 0;
    lastPollAt = 0;
    pollCount = 0;
    ackedUpTo = 0;
    lastAckAt = 0;
    capacity;
    lastHeartbeatAt = 0;
    lastHeartbeat = null;
    lastReportAt = 0;
    lastConsumerReport = null;
    constructor(capacity = DEFAULT_CAPACITY) {
        this.capacity = capacity;
    }
    /** 入队并分配递增序号；超过容量时丢弃最旧事件并计入 dropped。 */
    push(input) {
        const event = { ...input, seq: ++this.latestSeq };
        this.events.push(event);
        while (this.events.length > this.capacity) {
            const evicted = this.events.shift();
            if (this.evictedFrom === 0)
                this.evictedFrom = evicted.seq;
            this.evictedUpTo = evicted.seq;
        }
        return event;
    }
    /**
     * 游标读取：返回 seq > since 的事件，不删除。
     * 不传 since 时按旧版 MOD 的"一次性领取"处理。
     * `lost` 表示 since 之后已被容量淘汰、无法补发的事件数。
     */
    read(since, now = Date.now()) {
        this.lastPollAt = now;
        this.pollCount += 1;
        if (since === undefined) {
            const events = this.events.filter((event) => event.seq > this.legacyCursor);
            this.legacyCursor = this.latestSeq;
            return { seq: this.latestSeq, oldestSeq: this.oldestSeq(), events, lost: 0 };
        }
        const events = this.events.filter((event) => event.seq > since);
        return { seq: this.latestSeq, oldestSeq: this.oldestSeq(), events, lost: this.lostSince(since) };
    }
    /** 确认已处理到 seq；返回本次裁剪的事件数。 */
    ack(seq, now = Date.now()) {
        if (seq > this.ackedUpTo)
            this.ackedUpTo = seq;
        this.lastAckAt = now;
        let removed = 0;
        while (this.events.length > 0 && this.events[0].seq <= seq) {
            this.events.shift();
            removed += 1;
        }
        return removed;
    }
    /** 旧版 /vpet/say 兼容：取走最早一条 reply。 */
    takeReply() {
        const index = this.events.findIndex((event) => event.kind === 'reply');
        if (index < 0)
            return undefined;
        const [removed] = this.events.splice(index, 1);
        return removed?.text;
    }
    heartbeat(payload, now = Date.now()) {
        this.lastHeartbeat = { ...payload, at: new Date(now).toISOString() };
        this.lastHeartbeatAt = now;
    }
    /** 接收 MOD 自报的能力与状态；返回归一化后的报告，非法载荷返回 null。 */
    reportConsumer(raw, now = Date.now()) {
        const report = normalizeConsumerReport(raw);
        if (!report)
            return null;
        this.lastConsumerReport = report;
        this.lastReportAt = now;
        return report;
    }
    /** MOD 最近一次上报的摘要；从未上报时返回 null。 */
    consumerInfo(now = Date.now()) {
        if (!this.lastConsumerReport)
            return null;
        const ageMs = this.lastReportAt === 0 ? null : now - this.lastReportAt;
        return {
            online: ageMs !== null && ageMs <= REPORT_WINDOW_MS,
            ageMs,
            version: this.lastConsumerReport.version,
            pollMs: this.lastConsumerReport.pollMs,
            capabilities: this.lastConsumerReport.capabilities,
            state: this.lastConsumerReport.state,
        };
    }
    /** MOD 上报的原生动画清单；没有新鲜上报时返回 null（不启用能力校验）。 */
    supportedGraphs(now = Date.now()) {
        const info = this.consumerInfo(now);
        if (!info || !info.online)
            return null;
        const graphs = info.capabilities?.graphs;
        return graphs && graphs.length > 0 ? graphs : null;
    }
    /** MOD 是否正忙或玩家正在交互：用于给自主情绪动作让行。 */
    playerActive(now = Date.now()) {
        const info = this.consumerInfo(now);
        if (!info || !info.online || !info.state)
            return false;
        return info.state.playerActive || info.state.busy;
    }
    status(now = Date.now()) {
        const dropped = this.evictedUpTo === 0 ? 0 : this.evictedUpTo - this.evictedFrom + 1;
        const consumerStale = this.lastPollAt === 0 ? null : now - this.lastPollAt;
        const heartbeatStale = this.lastHeartbeatAt === 0 ? null : now - this.lastHeartbeatAt;
        const bridge = this.lastHeartbeat;
        return {
            latestSeq: this.latestSeq,
            pending: this.events.length,
            oldestSeq: this.oldestSeq(),
            dropped,
            consumer: {
                online: consumerStale !== null && consumerStale <= CONSUMER_WINDOW_MS,
                lastPollAt: this.lastPollAt === 0 ? null : new Date(this.lastPollAt).toISOString(),
                staleMs: consumerStale,
                pollCount: this.pollCount,
                ackedUpTo: this.ackedUpTo,
                lastAckAt: this.lastAckAt === 0 ? null : new Date(this.lastAckAt).toISOString(),
                unread: Math.max(0, this.latestSeq - this.ackedUpTo),
                info: this.consumerInfo(now),
            },
            bridge: {
                online: heartbeatStale !== null && heartbeatStale <= BRIDGE_WINDOW_MS,
                lastHeartbeatAt: bridge?.at ?? null,
                staleMs: heartbeatStale,
                saveFound: bridge ? bridge.saveFound : null,
                saveFile: bridge?.saveFile,
                saveMtimeMs: bridge?.saveMtimeMs,
                name: bridge?.name,
                level: bridge?.level,
                mode: bridge?.mode,
                strengthPct: bridge?.strengthPct,
                feelingPct: bridge?.feelingPct,
            },
        };
    }
    oldestSeq() {
        return this.events[0]?.seq ?? null;
    }
    lostSince(since) {
        if (this.evictedUpTo === 0)
            return 0;
        return Math.max(0, this.evictedUpTo - Math.max(since, this.evictedFrom - 1));
    }
}
