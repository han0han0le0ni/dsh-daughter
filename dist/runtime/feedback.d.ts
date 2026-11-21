export declare const FEEDBACK_REPO = "han0han0le0ni/dsh-daughter";
export declare const FEEDBACK_CATEGORIES: readonly ["投诉", "意见", "故障", "其他"];
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export interface FeedbackInput {
    category: FeedbackCategory;
    title: string;
    body: string;
    contact: string;
    includeDiagnostics: boolean;
}
export interface FeedbackMeta {
    pluginVersion: string;
    dshVersion?: string;
    platform?: string;
    arch?: string;
    nodeVersion?: string;
}
export interface FeedbackRecord extends FeedbackInput {
    id: string;
    createdAt: string;
    status: 'pending' | 'synced';
    issueNumber?: number;
    issueHtmlUrl?: string;
    error?: string;
}
export interface SubmitOptions {
    /** 显式传空串表示本次不联网；不传则读 DSH_GITHUB_TOKEN 或 gh auth token */
    token?: string;
    fetchImpl?: typeof fetch;
    now?: () => Date;
}
export declare function normalizeFeedback(input: unknown): FeedbackInput;
export declare function buildIssueTitle(record: FeedbackRecord): string;
export declare function buildIssueBody(record: FeedbackRecord, meta: FeedbackMeta): string;
export declare function buildIssueUrl(record: FeedbackRecord, meta: FeedbackMeta): string;
export declare function feedbackQueuePath(dataRoot: string): string;
export declare function readFeedbackQueue(path: string): FeedbackRecord[];
export declare function appendFeedbackRecord(path: string, record: FeedbackRecord): void;
export declare function rewriteFeedbackQueue(path: string, records: FeedbackRecord[]): void;
export declare function pendingFeedback(path: string): FeedbackRecord[];
/** 只使用环境中的令牌或本机 gh 登录态；绝不把令牌写入队列、日志或返回值。 */
export declare function resolveGitHubToken(): Promise<string | undefined>;
interface IssueResult {
    number: number;
    html_url: string;
}
/** 传输方式按平台一次选好：Windows 走 curl，其余平台走 fetch；测试可注入 fetch。 */
export declare function submitToGitHub(record: FeedbackRecord, meta: FeedbackMeta, token: string, fetchImpl?: typeof fetch): Promise<IssueResult>;
type FeedbackResult = FeedbackRecord & {
    issueUrl: string;
};
/** 用户提交：校验 → 同步一次 → 写一条最终记录。 */
export declare function submitFeedback(path: string, raw: unknown, meta: FeedbackMeta, options?: SubmitOptions): Promise<FeedbackResult>;
/** 打开面板时自动补发之前没发出去的条目；用户不需要再点按钮。 */
export declare function retryPendingFeedback(path: string, meta: FeedbackMeta, options?: SubmitOptions): Promise<{
    scanned: number;
    synced: number;
}>;
export declare function feedbackStatus(path: string): {
    repo: string;
    total: number;
    synced: number;
    pending: number;
};
export {};
