import { type IncomingMessage, type ServerResponse } from 'node:http';
import { createDaughterPlugin } from './index.js';
import type { EventRecord } from './types.js';
import type { Logger } from './util.js';
interface HostCtx {
    logger?: Partial<Logger>;
    get(name: string): unknown;
    on(name: string, listener: (...args: any[]) => unknown, options?: {
        prepend?: boolean;
    }): () => void;
    effect(fn: () => (() => void) | void, label?: string): () => void;
    emit?(name: string, payload: unknown): void;
    webServer?: {
        register(route: {
            kind: 'exact' | 'prefix';
            path: string;
            handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
        }): () => void;
    };
}
/** 解析 `/connectors/<source>/ingest`，非法来源返回 null */
export declare function parseExternalIngestPath(url: string): EventRecord['source'] | null;
export declare function createHost(ctx: HostCtx, rawConfig: unknown, pluginRoot: string): ReturnType<typeof createDaughterPlugin>;
export {};
