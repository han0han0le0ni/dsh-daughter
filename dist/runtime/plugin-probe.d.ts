/**
 * 插件探测（只读）：看看宿主里装了哪些插件、哪些已经是她自己的出口、
 * 还有哪些具备 IM 通道能力但尚未接管。
 *
 * 边界：
 * - 只读。这里不写任何第三方插件的配置、人格或记忆，也不改宿主插件清单。
 * - 判定只依据插件模块名与宿主报告的 fiber 状态，不猜对方内部结构。
 * - 不认识的一律算"不兼容"，宁可漏报也不把无关插件列成可接管对象。
 */
/** 宿主插件清单里的一行（字段取自 host-plugin-inventory） */
export interface ProbeEntry {
    moduleName: string;
    enabled: boolean;
    /** 'active' 才算在线；pending/loading/failed/null 都按离线报告 */
    fiberPhase: string | null;
}
/** 她已经开通的表达出口（vpet / pet / http / file） */
export interface ProbeSink {
    type: string;
}
/** 已声明的收件适配器（connectors/<source>/connector.json） */
export interface ProbeInbound {
    source: string;
    version: string;
}
export interface ProbeRejected {
    source: string;
    reason: string;
}
export interface TakeoverCandidate {
    moduleName: string;
    /** 命中的通道名，如 onebot / wecom */
    transport: string;
    enabled: boolean;
    alive: boolean;
}
export interface TakeoverReport {
    generatedAt: string;
    /** 已经在用的出口：这些不必再问一遍 */
    sinks: string[];
    /** 装有 IM 能力、但还没接管的插件 */
    candidates: TakeoverCandidate[];
    inbound: ProbeInbound[];
    rejectedInbound: ProbeRejected[];
    summary: {
        plugins: number;
        self: number;
        candidates: number;
        incompatible: number;
        sinks: number;
        inbound: number;
    };
}
/** 自己：本插件的模块名，永远不列为候选 */
export declare const SELF_MODULE = "dsh-daughter";
/** 模块名归一化：Windows 路径分隔符与大小写都不该影响判定 */
export declare function normalizeModuleName(moduleName: string): string;
/** 命中的通道名；不是已知通道返回 null */
export declare function detectTransport(moduleName: string): string | null;
/** 是不是自己（dsh-daughter 本体或带路径的副本） */
export declare function isSelf(moduleName: string): boolean;
/**
 * 生成接管清单。纯函数：宿主清单、已有出口、连接器清单都由调用方取好传进来，
 * 方便单测，也避免这里偷偷去读第三方文件。
 */
export declare function probePlugins(input: {
    entries: readonly ProbeEntry[];
    sinks: readonly ProbeSink[];
    inbound: readonly ProbeInbound[];
    rejectedInbound?: readonly ProbeRejected[];
    now: string;
}): TakeoverReport;
