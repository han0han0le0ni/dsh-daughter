import type { DaughterConfig, DaughterPlugin } from './types.js';
import type { Logger } from './util.js';
export interface PluginOptions {
    pluginRoot: string;
    config?: DaughterConfig;
    logger?: Logger;
    /** 连接器令牌（§12.2）：主动开口前的场景探测要访问桌面桥，必须带令牌 */
    connectorToken?: string;
    /** 动作包播放出口（桌宠等连接器消费） */
    onMotion?: (motionId: string) => void;
}
export declare function createDaughterPlugin(options: PluginOptions): DaughterPlugin;
export default createDaughterPlugin;
