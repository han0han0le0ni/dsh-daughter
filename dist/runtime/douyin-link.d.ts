/** 一条观看记录，只留拼接事件文本要用的字段 */
export interface DouyinMemoryItem {
    id: number;
    title: string;
    author: string;
    content: string;
    url: string;
    /** 毫秒 */
    createdAt: number;
    /** 毫秒，游标就靠它往前挪 */
    updatedAt: number;
}
/** 只声明用得到的那几个方法，测试里可以塞一个假实现 */
export interface DouyinStatement {
    all(...params: unknown[]): unknown[];
}
export interface DouyinDatabase {
    prepare(sql: string): DouyinStatement;
    close(): void;
}
export interface DouyinReadOptions {
    dbPath: string;
    /** 只取 `updated_at` 大于它的条目（毫秒）；缺省 0 = 不限 */
    sinceMs?: number;
    /** 单次最多取几条，缺省 5 */
    limit?: number;
    /** 注入打开实现（测试用）；缺省动态 import('node:sqlite') */
    open?: (path: string) => DouyinDatabase;
}
export interface DouyinReadResult {
    ok: boolean;
    items: DouyinMemoryItem[];
    /** 失败原因，只用于日志 */
    reason?: string;
}
/** 抖音插件的默认共享记忆库位置 */
export declare function defaultDouyinDbPath(home?: string): string;
/** 展开配置里的 `~`；空值回默认位置 */
export declare function resolveDouyinDbPath(raw: string, home?: string): string;
/**
 * 读一批新的观看记录，按时间从早到晚返回——事件流有时序意义，
 * 倒序灌进去会让"上周刷的"排到"刚刷的"后面。
 */
export declare function readDouyinMemory(options: DouyinReadOptions): Promise<DouyinReadResult>;
/**
 * 把一条观看记录写成她的事件文本。
 * 用第一人称的观察口吻，而不是"用户观看了视频：xxx"——她是要把这件事记成自己的经历。
 */
export declare function renderDouyinEventText(item: DouyinMemoryItem): string;
