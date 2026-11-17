import type { Store } from '../store.js';
export type ResetScope = 'memory' | 'personality' | 'reflex' | 'skills' | 'all';
export declare const RESET_SCOPES: ResetScope[];
export interface ResetItem {
    label: string;
    detail: string;
}
export interface ResetPlan {
    scope: ResetScope;
    items: ResetItem[];
}
export interface ResetResult extends ResetPlan {
    backupDir: string | null;
    /** 实际执行的动作摘要，供 CLI 打印 */
    applied: string[];
    /** 被移走的目录（logs/reset-trash/<时间戳>/ 下），可手动清理或回滚 */
    retired: string[];
    /** 分步执行中失败的步骤；空数组表示每一步都跑通 */
    errors: string[];
}
export interface ResetCheck {
    label: string;
    ok: boolean;
    detail: string;
}
export interface ResetVerification {
    ok: boolean;
    checks: ResetCheck[];
}
/** 只读：列出这一域会被清掉什么，供 dry-run 与确认提示使用 */
export declare function planReset(store: Store, scope: ResetScope): ResetPlan;
/** 执行重置。`backup: false` 用于测试，生产 CLI 默认开启 */
export declare function applyReset(store: Store, scope: ResetScope, options?: {
    backup?: boolean;
}): ResetResult;
/**
 * 重置后复核：把"以为清了"变成"读回来确认清了"。
 * CLI 照这份结果打勾叉，任一不通过就非零退出，并提示"插件可能仍在运行"。
 */
export declare function verifyReset(store: Store, scope: ResetScope): ResetVerification;
