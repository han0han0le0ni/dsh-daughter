import type { DaughterConfig, EventRecord } from '../types.js';
/**
 * 外部连接器注册表（DEF-03）。
 *
 * 核心只承诺两件事：通用收件口 `/connectors/<source>/ingest`，以及协议版本。
 * QQ / Minecraft / 游戏等适配器是外置插件，自己在 `connectors/<source>/connector.json`
 * 里声明来源与版本；核心不把任何适配器的版本号写死在代码里。
 */
/** 核心认识的收件协议版本；适配器清单声明不一致时会被拒绝 */
export declare const CONNECTOR_PROTOCOL = 1;
export interface ConnectorManifest {
    source: EventRecord['source'];
    protocol: number;
    version: string;
}
export interface RejectedConnector {
    source: string;
    reason: string;
}
export interface IngestRegistry {
    /** 真正允许写入的来源：配置白名单 ∩ 未被清单拒绝 */
    sources: Set<EventRecord['source']>;
    manifests: ConnectorManifest[];
    rejected: RejectedConnector[];
}
/** 读取 `connectors/<source>/connector.json`；目录不存在时视为"没有清单"，全部按配置放行 */
export declare function readConnectorManifests(dir: string): {
    manifests: ConnectorManifest[];
    rejected: RejectedConnector[];
};
/** 组合配置白名单与清单校验结果 */
export declare function buildIngestRegistry(manifests: ConnectorManifest[], rejected: RejectedConnector[], configured: string[]): IngestRegistry;
/** 从 pluginRoot 装载注册表；路径或清单有问题时退化为"按配置白名单放行" */
export declare function loadIngestRegistry(pluginRoot: string, config: DaughterConfig): IngestRegistry;
