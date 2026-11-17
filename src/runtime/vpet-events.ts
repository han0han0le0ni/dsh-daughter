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
  window?: { left: number; top: number; width: number; height: number };
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

/** MOD 每秒轮询，超过 10s 无请求视为掉线 */
const CONSUMER_WINDOW_MS = 10_000;
/** bridge.mjs 默认 30s 一轮，超过 120s 无心跳视为掉线 */
const BRIDGE_WINDOW_MS = 120_000;
/** MOD 主动上报状态；超过 60s 没有新上报视为上报链路失效 */
const REPORT_WINDOW_MS = 60_000;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function shortText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function stringList(value: unknown, max: number, itemMax: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim().slice(0, itemMax) : '';
    if (text) result.push(text);
    if (result.length >= max) break;
  }
  return result;
}

/** MOD 上报在 HTTP 边界上做一次收敛：只接受已知字段，长度与范围都限制住。 */
export function normalizeConsumerReport(raw: unknown): VpetConsumerReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const stateRaw = input.state;
  if (!stateRaw || typeof stateRaw !== 'object') return null;
  const state = stateRaw as Record<string, unknown>;
  const windowRaw = state.window;
  const window =
    windowRaw && typeof windowRaw === 'object'
      ? {
          left: clampInt((windowRaw as Record<string, unknown>).left, 0, -100_000, 100_000),
          top: clampInt((windowRaw as Record<string, unknown>).top, 0, -100_000, 100_000),
          width: clampInt((windowRaw as Record<string, unknown>).width, 0, 0, 10_000),
          height: clampInt((windowRaw as Record<string, unknown>).height, 0, 0, 10_000),
        }
      : undefined;
  const capabilitiesRaw = input.capabilities;
  const capabilities =
    capabilitiesRaw && typeof capabilitiesRaw === 'object'
      ? {
          graphs: stringList((capabilitiesRaw as Record<string, unknown>).graphs, 128, 64) ?? [],
          actions: stringList((capabilitiesRaw as Record<string, unknown>).actions, 16, 32) ?? [],
          queue: (capabilitiesRaw as Record<string, unknown>).queue === true,
          queueCapacity: clampInt((capabilitiesRaw as Record<string, unknown>).queueCapacity, 16, 0, 1000),
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
  private readonly events: VpetEvent[] = [];
  private latestSeq = 0;
  private evictedFrom = 0;
  private evictedUpTo = 0;
  private legacyCursor = 0;

  private lastPollAt = 0;
  private pollCount = 0;
  private ackedUpTo = 0;
  private lastAckAt = 0;

  private readonly capacity: number;
  private lastHeartbeatAt = 0;
  private lastHeartbeat: VpetHeartbeat | null = null;
  private lastReportAt = 0;
  private lastConsumerReport: VpetConsumerReport | null = null;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  /** 入队并分配递增序号；超过容量时丢弃最旧事件并计入 dropped。 */
  push(input: Omit<VpetEvent, 'seq'>): VpetEvent {
    const event: VpetEvent = { ...input, seq: ++this.latestSeq };
    this.events.push(event);
    while (this.events.length > this.capacity) {
      const evicted = this.events.shift()!;
      if (this.evictedFrom === 0) this.evictedFrom = evicted.seq;
      this.evictedUpTo = evicted.seq;
    }
    return event;
  }

  /**
   * 游标读取：返回 seq > since 的事件，不删除。
   * 不传 since 时按旧版 MOD 的"一次性领取"处理。
   * `lost` 表示 since 之后已被容量淘汰、无法补发的事件数。
   */
  read(
    since?: number,
    now = Date.now(),
  ): { seq: number; oldestSeq: number | null; events: VpetEvent[]; lost: number } {
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
  ack(seq: number, now = Date.now()): number {
    if (seq > this.ackedUpTo) this.ackedUpTo = seq;
    this.lastAckAt = now;
    let removed = 0;
    while (this.events.length > 0 && this.events[0]!.seq <= seq) {
      this.events.shift();
      removed += 1;
    }
    return removed;
  }

  /** 旧版 /vpet/say 兼容：取走最早一条 reply。 */
  takeReply(): string | undefined {
    const index = this.events.findIndex((event) => event.kind === 'reply');
    if (index < 0) return undefined;
    const [removed] = this.events.splice(index, 1);
    return removed?.text;
  }

  heartbeat(payload: Omit<VpetHeartbeat, 'at'>, now = Date.now()): void {
    this.lastHeartbeat = { ...payload, at: new Date(now).toISOString() };
    this.lastHeartbeatAt = now;
  }

  /** 接收 MOD 自报的能力与状态；返回归一化后的报告，非法载荷返回 null。 */
  reportConsumer(raw: unknown, now = Date.now()): VpetConsumerReport | null {
    const report = normalizeConsumerReport(raw);
    if (!report) return null;
    this.lastConsumerReport = report;
    this.lastReportAt = now;
    return report;
  }

  /** MOD 最近一次上报的摘要；从未上报时返回 null。 */
  consumerInfo(now = Date.now()): VpetConsumerInfo | null {
    if (!this.lastConsumerReport) return null;
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
  supportedGraphs(now = Date.now()): string[] | null {
    const info = this.consumerInfo(now);
    if (!info || !info.online) return null;
    const graphs = info.capabilities?.graphs;
    return graphs && graphs.length > 0 ? graphs : null;
  }

  /** MOD 是否正忙或玩家正在交互：用于给自主情绪动作让行。 */
  playerActive(now = Date.now()): boolean {
    const info = this.consumerInfo(now);
    if (!info || !info.online || !info.state) return false;
    return info.state.playerActive || info.state.busy;
  }

  status(now = Date.now()): {
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
  } {
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

  private oldestSeq(): number | null {
    return this.events[0]?.seq ?? null;
  }

  private lostSince(since: number): number {
    if (this.evictedUpTo === 0) return 0;
    return Math.max(0, this.evictedUpTo - Math.max(since, this.evictedFrom - 1));
  }
}
