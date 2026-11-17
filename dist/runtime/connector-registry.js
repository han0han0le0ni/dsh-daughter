import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * 外部连接器注册表（DEF-03）。
 *
 * 核心只承诺两件事：通用收件口 `/connectors/<source>/ingest`，以及协议版本。
 * QQ / Minecraft / 游戏等适配器是外置插件，自己在 `connectors/<source>/connector.json`
 * 里声明来源与版本；核心不把任何适配器的版本号写死在代码里。
 */
/** 核心认识的收件协议版本；适配器清单声明不一致时会被拒绝 */
export const CONNECTOR_PROTOCOL = 1;
/** 事件来源的封闭集合：抽取、显著性、参与者推导都按它分支，不能随便放开 */
const KNOWN_SOURCES = new Set([
    'qq',
    'douyin_dm',
    'douyin_content',
    'minecraft',
    'game',
    'android',
    'system',
]);
/** 读取 `connectors/<source>/connector.json`；目录不存在时视为"没有清单"，全部按配置放行 */
export function readConnectorManifests(dir) {
    const manifests = [];
    const rejected = [];
    if (!existsSync(dir))
        return { manifests, rejected };
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const file = join(dir, entry.name, 'connector.json');
        if (!existsSync(file))
            continue;
        try {
            const raw = JSON.parse(readFileSync(file, 'utf8'));
            const source = String(raw.source ?? entry.name);
            if (!KNOWN_SOURCES.has(source)) {
                rejected.push({ source, reason: `未知来源（核心不认识的 source）` });
                continue;
            }
            const protocol = raw.protocol === undefined ? CONNECTOR_PROTOCOL : Number(raw.protocol);
            if (!Number.isFinite(protocol) || protocol !== CONNECTOR_PROTOCOL) {
                rejected.push({ source, reason: `协议版本 ${String(raw.protocol)} 与核心 ${CONNECTOR_PROTOCOL} 不一致` });
                continue;
            }
            manifests.push({
                source: source,
                protocol,
                version: String(raw.version ?? '0'),
            });
        }
        catch (error) {
            rejected.push({ source: entry.name, reason: `清单解析失败：${String(error)}` });
        }
    }
    return { manifests, rejected };
}
/** 组合配置白名单与清单校验结果 */
export function buildIngestRegistry(manifests, rejected, configured) {
    const sources = new Set();
    for (const source of configured) {
        if (KNOWN_SOURCES.has(source))
            sources.add(source);
    }
    // 清单声明了不兼容协议：即使配置里开着也要摘掉，否则等于绕过适配器契约
    for (const bad of rejected)
        sources.delete(bad.source);
    return { sources, manifests, rejected };
}
/** 从 pluginRoot 装载注册表；路径或清单有问题时退化为"按配置白名单放行" */
export function loadIngestRegistry(pluginRoot, config) {
    const { manifests, rejected } = readConnectorManifests(join(pluginRoot, config.connectors.manifests_dir));
    return buildIngestRegistry(manifests, rejected, config.connectors.ingest_sources);
}
