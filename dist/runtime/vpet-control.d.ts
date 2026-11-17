/**
 * vpet_control：让角色在需要时接管桌宠的动画与位置。
 *
 * 默认不动桌宠：VPet 自己会自主活动，只有模型显式调用这个工具时才会
 * 通过本地桥接下发一次性指令，播完即回到桌宠的自主状态。
 */
import type { Logger, ToolGate } from '../util.js';
interface FetchResponseLike {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}
type FetchLike = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<FetchResponseLike>;
interface ToolRenderBlock {
    type: 'text';
    text: string;
}
interface ToolDefinitionLike {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: VpetControlValue): ToolRenderBlock[];
    };
    timeoutMs?: number;
    execute(args: Record<string, unknown>, exec: unknown): Promise<VpetControlValue>;
}
export interface VpetControlOptions {
    bridgeUrl?: string;
    /** 连接器令牌（§12.2）：桥接端点不再对"本机来的"放行 */
    token?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    logger?: Partial<Logger>;
    /** 安全降级闸门（§10.1）：status 只读，animate/move 属写操作 */
    guard?: ToolGate;
}
interface VpetControlValue {
    text: string;
}
export declare function createVpetControlTool(options?: VpetControlOptions): ToolDefinitionLike;
export declare function registerVpetControlTool(ctx: {
    get(name: string): unknown;
    logger?: Partial<Logger>;
}, options?: VpetControlOptions): () => void;
export {};
