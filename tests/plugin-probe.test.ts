import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectTransport,
  isSelf,
  normalizeModuleName,
  probePlugins,
  type ProbeEntry,
} from '../src/runtime/plugin-probe.js';

const NOW = '2026-11-25T12:00:00.000Z';

function entry(moduleName: string, fiberPhase: string | null = 'active', enabled = true): ProbeEntry {
  return { moduleName, enabled, fiberPhase };
}

test('模块名归一化：大小写与 Windows 路径分隔符不影响判定', () => {
  assert.equal(normalizeModuleName(' C:\\Plugins\\Dsh-WeCom\\index.js '), 'c:/plugins/dsh-wecom/index.js');
});

test('只认独立词段：不把 chat / 粘连写法当成 IM 通道', () => {
  assert.equal(detectTransport('dsh-wecom'), 'wecom');
  assert.equal(detectTransport('@acme/dsh-onebot'), 'onebot');
  assert.equal(detectTransport('dsh-qq-bot'), 'qqbot');
  assert.equal(detectTransport('C:\\plugins\\dsh-napcat\\index.js'), 'napcat');
  assert.equal(detectTransport('dsh-douyin-browser-local'), 'douyin');
  assert.equal(detectTransport('dsh-client-ui-chat'), null);
  assert.equal(detectTransport('telegrambridge'), null);
  assert.equal(detectTransport('dsh-daughter'), null);
});

test('自己是 dsh-daughter 本体及其路径副本', () => {
  assert.equal(isSelf('dsh-daughter'), true);
  assert.equal(isSelf('E:\\DSH-Data\\dsh-daughter'), true);
  assert.equal(isSelf('dsh-wecom'), false);
});

test('清单分类：自己单列，候选保留离线与停用状态', () => {
  const report = probePlugins({
    entries: [
      entry('dsh-daughter'),
      entry('dsh-wecom'),
      entry('dsh-onebot', 'failed', false),
      entry('dsh-files'),
    ],
    sinks: [],
    inbound: [],
    now: NOW,
  });

  assert.deepEqual(report.summary, {
    plugins: 4,
    self: 1,
    candidates: 2,
    incompatible: 1,
    sinks: 0,
    inbound: 0,
  });
  // 在线的排前面，其余按名字稳定排序
  assert.deepEqual(
    report.candidates.map((item) => [item.moduleName, item.alive, item.enabled]),
    [
      ['dsh-wecom', true, true],
      ['dsh-onebot', false, false],
    ],
  );
  assert.equal(report.candidates[0]?.transport, 'wecom');
});

test('出口去重排序，连接器原样带出，拒绝项缺省为空数组', () => {
  const report = probePlugins({
    entries: [],
    sinks: [{ type: 'vpet' }, { type: 'file' }, { type: 'vpet' }],
    inbound: [{ source: 'qq', version: '1.2.0' }],
    now: NOW,
  });

  assert.deepEqual(report.sinks, ['file', 'vpet']);
  assert.deepEqual(report.inbound, [{ source: 'qq', version: '1.2.0' }]);
  assert.deepEqual(report.rejectedInbound, []);
  assert.equal(report.generatedAt, NOW);
});

test('插件清单读取失败时，清单仍能只凭出口生成', () => {
  const report = probePlugins({
    entries: [],
    sinks: [{ type: 'http' }],
    inbound: [],
    rejectedInbound: [{ source: 'qq', reason: '协议版本不一致' }],
    now: NOW,
  });

  assert.deepEqual(report.sinks, ['http']);
  assert.equal(report.summary.plugins, 0);
  assert.equal(report.rejectedInbound.length, 1);
});
