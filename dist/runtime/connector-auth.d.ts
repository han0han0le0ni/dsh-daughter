import type { Logger } from '../util.js';
/** 请求头名。大小写不敏感，Node 会把收到的头统一转小写。 */
export declare const CONNECTOR_TOKEN_HEADER = "x-dsh-token";
/** 令牌文件位置（相对 data_root）。放在脑干的"安全协议"区，和运行时数据一起被 gitignore。 */
export declare const CONNECTOR_TOKEN_FILE: string;
/** 低于这个长度的令牌视为无效（手填时拦掉 `123456` 这种） */
export declare const CONNECTOR_TOKEN_MIN_LENGTH = 16;
export interface ConnectorTokenState {
    /** 空字符串表示拿不到令牌：此时服务端必须拒绝所有连接器请求 */
    token: string;
    source: 'config' | 'file' | 'created' | 'unavailable';
    /** 令牌文件绝对路径，便于日志与排查 */
    path: string;
}
/**
 * 取得连接器令牌，顺序是「配置 > 已有文件 > 新建文件」。
 *
 * 配置里显式给了就用配置（便于多机/容器固定），否则读文件，文件不存在就生成一份 0600。
 * 三步都失败时返回 `unavailable`，调用方必须据此拒绝服务，**不能退化成无认证**。
 */
export declare function ensureConnectorToken(dataRoot: string, explicit: string | undefined, logger?: Partial<Logger>): ConnectorTokenState;
/** 出站调用用的请求头：本插件自己的工具访问桥接端点时带上 */
export declare function tokenHeader(token: string): Record<string, string>;
/** 从请求里取令牌：优先专用头，其次 `Authorization: Bearer`（方便 curl / 通用客户端） */
export declare function readIncomingToken(req: {
    headers: Record<string, string | string[] | undefined>;
}): string | null;
/**
 * 是否浏览器发起。连接器用 `fetch`/`HttpClient`，不会带这些头；
 * 带了就说明是页面里的脚本（或 `<img src>` 之类），一律不认。
 *
 * 注意**不能**用 `sec-fetch-mode` 判断：Node 自带的 fetch（undici）也会发
 * `sec-fetch-mode: cors`，用它会把插件自己的工具误判成浏览器。
 * 浏览器在跨源请求上必带 `Origin`，在导航/子资源上必带 `Sec-Fetch-Site`，
 * 这两个才是可靠的区分点。
 */
export declare function isBrowserInitiated(req: {
    headers: Record<string, string | string[] | undefined>;
}): boolean;
/** 常量时间比较：长度不同也走同一路径，避免按响应时间区分 */
export declare function tokenMatches(expected: string, actual: string | null): boolean;
export interface ConnectorAuthVerdict {
    ok: boolean;
    status?: number;
    reason?: string;
}
/**
 * 连接器端点统一判定。返回 `ok: false` 时调用方直接回 `status`，不要再往下走。
 *
 * - 浏览器来源 → 403（即使带了正确令牌）
 * - 服务端没令牌 → 503（fail closed）
 * - 令牌缺失/不匹配 → 401
 */
export declare function authorizeConnectorRequest(req: {
    headers: Record<string, string | string[] | undefined>;
}, expectedToken: string): ConnectorAuthVerdict;
