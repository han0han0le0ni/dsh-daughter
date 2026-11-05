/**
 * desktop_input：让角色真正“动手”操作电脑。
 *
 * 通过 `connectors/desktop` 桥接的 `/input` 端点驱动 Windows 鼠标与键盘；
 * 配合 `desktop_observe` 形成“观察 → 决策 → 操作”的闭环，可用于窗口化
 * 单机游戏、普通桌面应用与自动化操作。
 */
import type { Logger, ToolGate } from '../util.js';
interface FetchResponseLike {
    ok: boolean;
    status: number;
    text(): Promise<string>;
}
type FetchLike = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<FetchResponseLike>;
interface ToolRenderBlock {
    type: 'text' | 'image';
    text?: string;
}
interface ToolDefinitionLike {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: DesktopInputValue): ToolRenderBlock[];
    };
    timeoutMs?: number;
    execute(args: Record<string, unknown>, exec: unknown): Promise<DesktopInputValue>;
}
export interface DesktopInputOptions {
    bridgeUrl?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    logger?: Partial<Logger>;
    /** 安全降级闸门（§10.1）：level ≥2 时拒绝写操作 */
    guard?: ToolGate;
}
export interface DesktopInputValue {
    text: string;
    action: string;
    screen?: {
        width: number;
        height: number;
    };
    cursor?: {
        x: number;
        y: number;
    };
    window?: Record<string, unknown>;
    at: string;
}
export declare function createDesktopInputTool(options?: DesktopInputOptions): ToolDefinitionLike;
export declare function registerDesktopInputTool(ctx: {
    get(name: string): unknown;
    logger?: Partial<Logger>;
}, options?: DesktopInputOptions): () => void;
export {};
