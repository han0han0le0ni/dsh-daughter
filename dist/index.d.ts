import type { DaughterConfig, DaughterPlugin } from './types.js';
import type { Logger } from './util.js';
export interface PluginOptions {
    pluginRoot: string;
    config?: DaughterConfig;
    logger?: Logger;
    /** 动作包播放出口（桌宠等连接器消费） */
    onMotion?: (motionId: string) => void;
}
export declare function createDaughterPlugin(options: PluginOptions): DaughterPlugin;
export default createDaughterPlugin;
