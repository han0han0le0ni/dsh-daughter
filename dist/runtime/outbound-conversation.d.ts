import type { SpeakConversationConfig, SpeakPlan } from '../types.js';
/**
 * 会话窗口投递的记账与框架。
 *
 * 设计约束：
 * - 只负责"要不要送、送什么"，真正的 followup 由宿主层完成，便于单测。
 * - 送进会话的是"插件来源的用户消息"，模型看到后生成真正的回复，
 *   因此文案必须防注入：把动态内容与指令分开，且不暴露内部机制。
 */
export interface ConversationLedger {
    /** 记账所属的自然日（本地时区 key，如 2026-11-25） */
    day: string;
    /** 当天已送次数 */
    count: number;
    /** 上次送出的时间（ISO），跨天保留，用于最小间隔判断 */
    lastAt: string | null;
}
export interface ConversationGate {
    ok: boolean;
    reason?: 'cap' | 'gap';
}
/** 空账本；解析失败也退化为它，不能因为脏数据就放开限额。 */
export declare function emptyLedger(day: string): ConversationLedger;
/** 读账本；跨天只重置计数，保留 lastAt 以便跨零点仍然遵守最小间隔。 */
export declare function readLedger(raw: string | null, day: string): ConversationLedger;
/** 判断这一刻能不能送：先看日上限，再看最小间隔。 */
export declare function allowSend(ledger: ConversationLedger, config: SpeakConversationConfig, now: string): ConversationGate;
/** 记一次送出。跨天只重置换算后的计数，lastAt 照常更新。 */
export declare function recordSend(ledger: ConversationLedger, day: string, now: string): ConversationLedger;
/** 账本序列化（留给需要落盘的调用方）。 */
export declare function serializeLedger(ledger: ConversationLedger): string;
/**
 * 生成送进会话的消息。
 *
 * 结构化框架而非自然语言转述：模型能分清哪句是指令、哪句是素材，
 * 动态字段（动机、强度、模板句）一律作为参考值，不冒充用户原话。
 */
export declare function buildProactiveMessage(plan: SpeakPlan, config: Pick<SpeakConversationConfig, 'prompt'>): {
    summary: string;
    text: string;
};
