import type { Store } from '../store.js';
/**
 * 星图只读信息栏：把人格 L1–L4、运行时 L5、安全、存储统计与演化日志摊平成参数行。
 * 全部只做读取与展示，不回写任何状态；偏移 = 当前值 - 出厂默认值。
 */
export interface StarMapParam {
    key: string;
    label: string;
    value: number | string | string[] | null;
    /** 出厂默认值，只有数值型才有意义 */
    base?: number;
    /** 当前值 - 出厂默认值 */
    delta?: number;
    kind: 'number' | 'text' | 'list';
    note?: string;
}
export interface StarMapGroup {
    id: string;
    title: string;
    subtitle: string;
    /** 分组里数值型参数的规模，前端据此画条形 */
    params: StarMapParam[];
}
export interface StarMapChange {
    key: string;
    from: string;
    to: string;
}
export interface StarMapEvolution {
    at: string;
    target: string;
    reason: string;
    changes: StarMapChange[];
}
/** 会话级状态序列：给侧栏画安全/压力/疲劳的走势，单个快照看不出「在变好还是变坏」 */
export interface StarMapSeriesPoint {
    sessionId: string;
    at: string;
    safety: number;
    stress: number;
    fatigue: number;
    pleasure: number;
}
export interface StarMapPanels {
    persona: StarMapGroup[];
    runtime: StarMapGroup[];
    evolution: StarMapEvolution[];
    series: StarMapSeriesPoint[];
    generatedAt: string;
}
export declare function buildStarPanels(store: Store, now: string, counts: {
    nodes: number;
    edges: number;
    galaxies: number;
}): StarMapPanels;
