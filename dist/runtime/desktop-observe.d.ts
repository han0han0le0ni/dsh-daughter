/**
 * desktop_observe：让角色按需“看”一眼电脑屏幕。
 *
 * 调用 `connectors/desktop` 桥接取前台窗口与一帧 JPEG，保存为宿主附件后
 * 随工具结果一起送入模型；不做持续推流，避免无谓的带宽与隐私开销。
 */
import type { Logger, ToolGate } from '../util.js';
interface ImageAttachmentRef {
    attachmentId: string;
    mediaType: string;
    bytes: number;
    width: number;
    height: number;
    name?: string;
}
interface AttachmentService {
    saveImage?(input: {
        data: Uint8Array;
        mediaType: 'image/jpeg';
        name?: string;
    }): Promise<ImageAttachmentRef>;
    saveImages?(inputs: ReadonlyArray<{
        data: Uint8Array;
        mediaType: 'image/jpeg';
        name?: string;
    }>): Promise<ReadonlyArray<ImageAttachmentRef>>;
}
interface FetchResponseLike {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
}
type FetchLike = (url: string, init?: {
    signal?: AbortSignal;
}) => Promise<FetchResponseLike>;
interface ToolRenderBlock {
    type: 'text' | 'image';
    text?: string;
    attachment?: ImageAttachmentRef;
}
interface ToolDefinitionLike {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: DesktopObserveValue): ToolRenderBlock[];
    };
    timeoutMs?: number;
    execute(args: Record<string, unknown>, exec: unknown): Promise<DesktopObserveValue>;
}
export interface DesktopObserveOptions {
    bridgeUrl?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    logger?: Partial<Logger>;
    /** 宿主附件服务；测试或直接调用时可传入 */
    attachments?: AttachmentService;
    /** 运行时解析附件服务，避免注册时服务尚未就绪 */
    getAttachments?: () => AttachmentService | undefined;
    /** 安全降级闸门（§10.1）：观察属只读，通常放行 */
    guard?: ToolGate;
}
export interface DesktopObserveValue {
    text: string;
    observedAt: string;
    foreground?: Record<string, unknown>;
    media?: Record<string, unknown>;
    windows?: string[];
    image?: ImageAttachmentRef;
}
export declare function createDesktopObserveTool(options?: DesktopObserveOptions): ToolDefinitionLike;
export declare function registerDesktopObserveTool(ctx: {
    get(name: string): unknown;
    logger?: Partial<Logger>;
}, options?: DesktopObserveOptions): () => void;
export {};
