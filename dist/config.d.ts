import type { DaughterConfig } from './types.js';
import type { Logger } from './util.js';
export declare const defaultConfig: DaughterConfig;
export declare function loadConfig(pluginRoot: string, logger?: Logger): DaughterConfig;
/** 合并宿主下发的 config 补丁，供 cordis 插件入口使用 */
export declare function mergeConfig(base: DaughterConfig, override: unknown): DaughterConfig;
/** 配置中的 data_root 相对于插件根目录解析 */
export declare function resolveDataRoot(pluginRoot: string, config: DaughterConfig): string;
