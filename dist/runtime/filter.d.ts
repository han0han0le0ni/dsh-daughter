/**
 * 认知滤网（cognitive filter）。
 *
 * 大脑不会把每一条感官输入都写进长期记忆：重复的会被习惯化，无关的会被忽略，
 * 危险的会被主动屏蔽，剩下的才值得记。这个模块把这三件事做成可配置、可观测的决策，
 * 而不是散落在各处的 if 判断。
 *
 * 四类决策：
 * - `shield`：命中认知屏蔽，不入库（来源 / 关键词 / 正则）
 * - `drop`：显著性过低且来源可信度低，不入库（噪声）
 * - `merge`：与窗口内已有事件同题（数字归一化后仍高度相似），只累加计数，不新增条目
 * - `keep`：正常入库，并记录显著性供忘却扫描使用
 *
 * 保守原则：真人对话（`source_weight = 1`）永远不会因为显著性低被丢弃，只会被降权。
 */
import type { DaughterConfig, EventRecord, ISOTime } from '../types.js';
export type FilterAction = 'keep' | 'merge' | 'drop' | 'shield';
export interface FilterDecision {
    action: FilterAction;
    reason: string;
    /** 0..1，写入事件的显著性，供忘却扫描与面板展示 */
    salience: number;
    /** 来源可信度，同时用于检索降权 */
    sourceWeight: number;
    /** merge 时的合并目标 */
    targetId?: string;
}
export type FilterStatKind = 'keep' | 'merge' | 'drop' | 'shield';
export declare function sourceWeightOf(source: string, config: DaughterConfig): number;
/**
 * 入库前的内容完整性筛：不是完整的话、带半截工具/模板标记的，直接丢。
 * 真实库里出现过「看到我刚刚在其他工作区的提问了吗 → </｜｜DSML｜｜ invoke>」这种条目，
 * 既占着相关记忆的开头，又没法被接上。
 */
export declare function contentGuardReason(event: EventRecord, config: DaughterConfig): string | null;
/**
 * 事件签名：数字与数量单位一起归一化，
 * 避免"好感度涨到 58410547"和"涨到 5.8 万亿""涨到 1.2 亿"被当成三件事。
 */
export declare function eventSignature(event: Pick<EventRecord, 'title' | 'summary'>): string;
/** 认知屏蔽：命中即不入库 */
export declare function shieldReason(event: Pick<EventRecord, 'source' | 'title' | 'summary'>, config: DaughterConfig): string | null;
/**
 * 显著性 = 情绪强度 × 0.34 + 新颖性 × 0.28 + 社交性 × 0.24 + 信息量 × 0.14，
 * 再乘来源可信度。四项都能从事件本身算出来，不依赖模型调用。
 */
export declare function salienceOf(event: Pick<EventRecord, 'title' | 'summary' | 'participants' | 'emotionAtTime' | 'source'>, recent: EventRecord[], config: DaughterConfig): number;
/** 写入前的唯一决策点 */
export declare function decideIngest(event: EventRecord, recent: EventRecord[], config: DaughterConfig, now: ISOTime): FilterDecision;
export interface ForgetResult {
    archived: number;
    ids: string[];
}
/**
 * 忘却扫描：低显著性 + 从未被想起 + 长期闲置 → 归档。
 * 被想起过的事件即使显著性低也保留，因为"用得上"本身就是价值。
 */
export declare function forgetSweep(events: EventRecord[], config: DaughterConfig, now: ISOTime): ForgetResult;
