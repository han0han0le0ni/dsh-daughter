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
export declare function submitToGitHub(record: FeedbackRecord, meta: FeedbackMeta, token: string, fetchImpl?: typeof fetch): Promise<IssueResult>;
/** 写入本地队列；有 GitHub 令牌时直接开 issue，没令牌也能一键跳转到预填页面。 */
export declare function submitFeedback(path: string, raw: unknown, meta: FeedbackMeta, options?: SubmitOptions): Promise<FeedbackRecord & {
    issueUrl: string;
}>;
/** 用户后来登录了 gh 或设置了令牌时，把此前留下的待同步条目补发出去。 */
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
