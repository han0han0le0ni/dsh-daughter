import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, mergeConfig } from '../src/config.js';
import {
  CONNECTOR_PROTOCOL,
  buildIngestRegistry,
  loadIngestRegistry,
  readConnectorManifests,
} from '../src/runtime/connector-registry.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-connector-'));
}

function writeManifest(root: string, dir: string, body: string): void {
  mkdirSync(join(root, 'connectors', dir), { recursive: true });
  writeFileSync(join(root, 'connectors', dir, 'connector.json'), body, 'utf8');
}

test('DEF-03 清单读取：协议不一致、未知来源、坏 JSON 都会被拒绝', () => {
  const root = makeRoot();
  try {
    writeManifest(root, 'android', JSON.stringify({ source: 'android', protocol: 1, version: '1.0.0' }));
    writeManifest(root, 'qq', JSON.stringify({ source: 'qq', protocol: 2, version: '0.9.0' }));
    writeManifest(root, 'minecraft', JSON.stringify({ source: 'minecraft', protocol: 1 }));
    writeManifest(root, 'unknown', JSON.stringify({ source: 'telegram', protocol: 1 }));
    writeManifest(root, 'game', '{ broken json');

    const { manifests, rejected } = readConnectorManifests(join(root, 'connectors'));
    assert.equal(manifests.length, 2, 'android 与缺省版本的 minecraft 应通过');
    assert.ok(manifests.some((entry) => entry.source === 'android' && entry.version === '1.0.0'));
    assert.ok(manifests.some((entry) => entry.source === 'minecraft' && entry.protocol === CONNECTOR_PROTOCOL));
    assert.deepEqual(
      rejected.map((entry) => entry.source).sort(),
      ['game', 'qq', 'telegram'],
    );
    assert.ok(rejected.find((entry) => entry.source === 'qq')!.reason.includes('协议版本'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEF-03 注册表：配置白名单与清单校验取交集', () => {
  const { manifests, rejected } = {
    manifests: [{ source: 'android' as const, protocol: 1, version: '1.0.0' }],
    rejected: [{ source: 'qq', reason: '协议版本不一致' }],
  };
  const registry = buildIngestRegistry(manifests, rejected, ['android', 'qq', 'system', 'unknown_source']);
  assert.deepEqual([...registry.sources].sort(), ['android', 'system']);
  assert.equal(registry.rejected.length, 1);
});

test('DEF-03 装载：没有 connectors 目录时退化为按配置放行', () => {
  const root = makeRoot();
  try {
    const config = mergeConfig(defaultConfig, { connectors: { ingest_sources: ['qq', 'android'] } });
    const registry = loadIngestRegistry(root, config);
    assert.deepEqual([...registry.sources].sort(), ['android', 'qq']);
    assert.equal(registry.rejected.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEF-03 配置归一化：来源统一小写并过滤非法写法', () => {
  const config = mergeConfig(defaultConfig, {
    connectors: { ingest_sources: [' QQ ', 'douyin-dm', 'qq', 'Minecraft'], manifests_dir: '' },
  });
  assert.deepEqual(config.connectors.ingest_sources, ['qq', 'minecraft']);
  assert.equal(config.connectors.manifests_dir, 'connectors');
});
