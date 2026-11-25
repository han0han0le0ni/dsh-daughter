import { type IncomingMessage, type ServerResponse } from 'node:http';
import { createDaughterPlugin } from './index.js';
import type { EventRecord } from './types.js';
import type { Logger } from './util.js';
interface HostMessageBlock {
    type?: string;
    text?: string;
}
interface HostMessage {
    id?: string;
    role?: string;
    content?: string | HostMessageBlock[];
    source?: {
        kind?: string;
        [key: string]: unknown;
    };
}
/** 宿主注册表里的活体 agent：会话投递只依赖 followup 这一个能力 */
interface HostLiveAgent {
    followup?(message: HostMessage): void;
}
interface HostCtx {
    logger?: Partial<Logger>;
    get(name: string): unknown;
    on(name: string, listener: (...args: any[]) => unknown, options?: {
        prepend?: boolean;
    }): () => void;
    effect(fn: () => (() => void) | void, label?: string): () => void;
    emit?(name: string, payload: unknown): void;
    webServer?: {
        /** 宿主实际监听的端口（配置写 0 时由系统分配），dsh-pet 出口靠它拼本机地址 */
        port?: number;
        register(route: {
            kind: 'exact' | 'prefix';
            path: string;
            handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
        }): () => void;
    };
    /**
     * 宿主网络准入服务（可选注入）。返回 undefined 表示放行，否则是要回给请求方的状态码。
     * 星图这类会暴露记忆内容的接口必须先过它；拿不到服务或它抛错时一律拒绝，
     * 不能退化成"只看 Host / Origin / 环回地址"的判断。
     */
    connection?: {
        requestRejection(req: IncomingMessage): number | undefined;
    };
    /** 宿主 agent 注册表（可选注入）：会话窗口投递靠它找活体 agent */
    agents?: {
        get(id: string): HostLiveAgent | undefined;
    };
}
/** 解析 `/connectors/<source>/ingest`：来源必须在允许集合内，否则返回 null */
export declare function parseExternalIngestPath(url: string, allowed?: ReadonlySet<EventRecord['source']>): EventRecord['source'] | null;
export declare function createHost(ctx: HostCtx, rawConfig: unknown, pluginRoot: string): ReturnType<typeof createDaughterPlugin>;
export {};
