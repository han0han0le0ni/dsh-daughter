/**
 * daughter_self：让她读取自己的当前设定。
 *
 * 为什么单独做成工具，而不是每轮塞进 prompt：
 * 五维、依恋、自我叙事、锁定状态和画像都是「按需才用」的信息，每轮注入只会挤占记忆预算；
 * 工具只在被问到时读一次，而且每次都重新取——设置页改完、重抽之后立刻能看到新值。
 */
import type { PersonalitySnapshot, PortraitBundle } from '../types.js';
import { type Logger, type ToolGate } from '../util.js';
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
        render(args: unknown, value: SelfProfileValue): ToolRenderBlock[];
    };
    execute(args: Record<string, unknown>, exec: unknown): Promise<SelfProfileValue>;
}
export interface SelfProfileValue {
    text: string;
    readAt: string;
}
export interface SelfProfileOptions {
    /** 每次都重新读：不缓存，保证反映最新设置 */
    readPersonality(): PersonalitySnapshot;
    readPortraits(): PortraitBundle;
    logger?: Partial<Logger>;
    guard?: ToolGate;
}
/** 把快照与画像拼成她读得懂的几段；空字段直接省略，不编造 */
export declare function renderSelfProfile(snapshot: PersonalitySnapshot, portraits: PortraitBundle): string;
export declare function createSelfProfileTool(options: SelfProfileOptions): ToolDefinitionLike;
export declare function registerSelfProfileTool(ctx: {
    get(name: string): unknown;
    logger?: Partial<Logger>;
}, options: SelfProfileOptions): () => void;
export {};
