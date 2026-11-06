/**
 * 连接器认证（§12.2）。
 *
 * 这里守的是三条不能退让的规则：
 *   1. 拿不到令牌时服务端一律拒绝（503），不能因为"本机来的"就放行；
 *   2. 令牌不符一律 401；
 *   3. 浏览器来源一律 403 —— 即便令牌正确，页面里的脚本也打不进来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONNECTOR_TOKEN_HEADER,
  authorizeConnectorRequest,
  ensureConnectorToken,
  isBrowserInitiated,
  readIncomingToken,
  tokenHeader,
  tokenMatches,
} from '../src/runtime/connector-auth.js';
import { startDesktopBridge } from '../connectors/desktop/bridge.mjs';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-connector-auth-'));
}

test('首次调用生成 0600 令牌文件，再次调用复用同一个值', () => {
  const root = tempRoot();
  try {
    const first = ensureConnectorToken(root, '');
    assert.equal(first.source, 'created');
    assert.equal(first.token.length, 64, '应生成 32 字节 hex');
    const stat = statSync(first.path);
    // Windows 上权限位不可靠，只在 POSIX 断言 0600
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);

    const second = ensureConnectorToken(root, '');
    assert.equal(second.source, 'file');
    assert.equal(second.token, first.token);
    assert.equal(readFileSync(first.path, 'utf8').trim(), first.token);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('配置里的显式令牌优先；过短的令牌被忽略并回落到文件', () => {
  const root = tempRoot();
  try {
    const explicit = 'x'.repeat(40);
    const fromConfig = ensureConnectorToken(root, explicit);
    assert.equal(fromConfig.source, 'config');
    assert.equal(fromConfig.token, explicit);

    const created = ensureConnectorToken(root, '');
    assert.equal(created.source, 'created');

    // 填了但太短：忽略配置，继续用文件里的值，而不是"用短令牌凑合"
    const tooShort = ensureConnectorToken(root, '123456');
    assert.equal(tooShort.source, 'file');
    assert.notEqual(tooShort.token, '123456');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('令牌文件被手动改坏（过短）时视为不可用并重新生成', () => {
  const root = tempRoot();
  try {
    const first = ensureConnectorToken(root, '');
    writeFileSync(first.path, 'short\n', 'utf8');
    const again = ensureConnectorToken(root, '');
    assert.notEqual(again.token, 'short');
    assert.ok(again.token.length >= 16);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无令牌 503、错令牌 401、对令牌放行', () => {
  const token = 'a'.repeat(64);
  const noServerToken = authorizeConnectorRequest({ headers: {} }, '');
  assert.equal(noServerToken.ok, false);
  assert.equal(noServerToken.status, 503);

  const missing = authorizeConnectorRequest({ headers: {} }, token);
  assert.equal(missing.status, 401);

  const wrong = authorizeConnectorRequest({ headers: { [CONNECTOR_TOKEN_HEADER]: 'b'.repeat(64) }, }, token);
  assert.equal(wrong.status, 401);

  const right = authorizeConnectorRequest({ headers: { [CONNECTOR_TOKEN_HEADER]: token } }, token);
  assert.deepEqual(right, { ok: true });
});

test('浏览器来源一律 403，即便令牌正确', () => {
  const token = 'c'.repeat(64);
  for (const headers of [
    { [CONNECTOR_TOKEN_HEADER]: token, origin: 'http://evil.example' },
    { [CONNECTOR_TOKEN_HEADER]: token, 'sec-fetch-site': 'cross-site' },
    { [CONNECTOR_TOKEN_HEADER]: token, referer: 'https://evil.example/page' },
  ] as Array<Record<string, string>>) {
    const verdict = authorizeConnectorRequest({ headers }, token);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 403);
    assert.equal(verdict.reason, 'browser_origin');
  }
  assert.equal(isBrowserInitiated({ headers: { origin: 'null' } }), true);
  assert.equal(isBrowserInitiated({ headers: { 'content-type': 'application/json' } }), false);
});

test('支持 Authorization: Bearer，且比较是常量时间实现', () => {
  assert.equal(readIncomingToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(readIncomingToken({ headers: { authorization: 'basic abc' } }), null);
  assert.equal(readIncomingToken({ headers: { [CONNECTOR_TOKEN_HEADER]: ' direct ' } }), 'direct');
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('', ''), false);
  assert.deepEqual(tokenHeader('t'), { [CONNECTOR_TOKEN_HEADER]: 't' });
  assert.deepEqual(tokenHeader(''), {});
});

test('桌面连接器：无令牌 503、错令牌 401、浏览器 403、正确令牌可用', async () => {
  const token = 'd'.repeat(64);
  const bridge = await startDesktopBridge({
    port: 0,
    token,
    autoPoll: false,
    backend: 'powershell',
    system: {
      foreground: async () => ({ title: '测试', processName: 'test' }),
      listWindows: async () => [],
      media: async () => ({}),
      close: () => undefined,
    },
    captureFrame: async () => Buffer.from([1]),
    input: undefined as unknown as never,
  });
  try {
    const base = `http://127.0.0.1:${bridge.port}`;
    assert.equal((await fetch(`${base}/windows`)).status, 401);
    assert.equal((await fetch(`${base}/windows`, { headers: { 'x-dsh-token': 'e'.repeat(64) } })).status, 401);
    assert.equal(
      (await fetch(`${base}/windows`, { headers: { 'x-dsh-token': token, origin: 'http://evil.example' } })).status,
      403,
    );
    const ok = await fetch(`${base}/windows`, { headers: { 'x-dsh-token': token } });
    assert.equal(ok.status, 200);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, auth: 'token' });
  } finally {
    await bridge.close();
  }
});

test('桌面连接器：没有令牌时拒绝所有数据请求', async () => {
  const bridge = await startDesktopBridge({
    port: 0,
    autoPoll: false,
    backend: 'powershell',
    system: {
      foreground: async () => ({ title: '测试' }),
      listWindows: async () => [],
      media: async () => ({}),
      close: () => undefined,
    },
    captureFrame: async () => Buffer.from([1]),
    input: undefined as unknown as never,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/screenshot`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'token_unavailable');
  } finally {
    await bridge.close();
  }
});
