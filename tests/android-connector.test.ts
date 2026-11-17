import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { startAndroidBridge } from '../connectors/android/bridge.mjs';
import { buildAdbArgs, parseDevices, parseForeground } from '../connectors/android/adb.mjs';
import { parseExternalIngestPath } from '../src/host.js';

// 连接器端点要求令牌（§12.2）：测试同样要带，顺带覆盖"认证通过才可用"这条链路
const TEST_TOKEN = 'test-token-0123456789abcdef';
const authFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, {
    ...init,
    headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), 'x-dsh-token': TEST_TOKEN },
  });

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('P9 ADB 动作编译与输出解析', () => {
  assert.deepEqual(
    buildAdbArgs('open_app', { package: 'com.example.music', activity: '.MainActivity' }, 'emulator-5554'),
    ['-s', 'emulator-5554', 'shell', 'am', 'start', '-n', 'com.example.music/.MainActivity'],
  );
  assert.deepEqual(buildAdbArgs('tap', { x: 120.4, y: '80' }), [
    'shell',
    'input',
    'tap',
    '120',
    '80',
  ]);
  assert.deepEqual(buildAdbArgs('text', { text: 'hello world' }), [
    'shell',
    'input',
    'text',
    'hello%sworld',
  ]);
  assert.throws(() => buildAdbArgs('open_app', { package: 'com.example; rm -rf /' }));
  assert.throws(() => buildAdbArgs('nope', {}));

  const devices = parseDevices('List of devices attached\nemulator-5554 device product:sdk_gphone model:Pixel_6\n');
  assert.deepEqual(devices[0], {
    serial: 'emulator-5554',
    state: 'device',
    detail: 'product:sdk_gphone model:Pixel_6',
  });

  const foreground = parseForeground(
    'mResumedActivity: ActivityRecord{abc u0 com.example.music/.MainActivity t12}',
  );
  assert.deepEqual(foreground, {
    package: 'com.example.music',
    activity: '.MainActivity',
    key: 'com.example.music/.MainActivity',
  });
});

test('P9 Android ADB：动作执行与前台事件端到端', async () => {
  const received: Array<{ url: string; body: unknown }> = [];
  const dsh = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, eventId: 'EVT-android' }));
    });
  });
  const dshPort = await listen(dsh);

  const calls: string[][] = [];
  const bridge = await startAndroidBridge({
    token: TEST_TOKEN,
    endpoint: `http://127.0.0.1:${dshPort}`,
    port: 0,
    serial: 'emulator-5554',
    autoPoll: false,
    adb: async (args: string[]) => {
      calls.push(args);
      if (args.join(' ').includes('dumpsys activity')) {
        return {
          stdout: Buffer.from('mResumedActivity: ActivityRecord{abc u0 com.example.music/.MainActivity t12}'),
        };
      }
      if (args.join(' ').includes('screencap')) {
        return { stdout: Buffer.from([1, 2, 3]) };
      }
      return { stdout: Buffer.from('ok') };
    },
  });

  try {
    const base = `http://127.0.0.1:${bridge.port}`;

    const health = await authFetch(`${base}/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.auth, 'token');
    // 串号与可用动作清单不再从 /health 泄露
    assert.equal(health.serial, undefined);

    const opened = await authFetch(`${base}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'open_app', package: 'com.example.music' }),
    }).then((response) => response.json());
    assert.equal(opened.ok, true);
    assert.deepEqual(calls.at(-1), [
      '-s',
      'emulator-5554',
      'shell',
      'monkey',
      '-p',
      'com.example.music',
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);

    const tapped = await authFetch(`${base}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'tap', x: 10, y: 20 }),
    }).then((response) => response.json());
    assert.equal(tapped.ok, true);
    assert.deepEqual(calls.at(-1), ['-s', 'emulator-5554', 'shell', 'input', 'tap', '10', '20']);

    const shot = await authFetch(`${base}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'screenshot' }),
    }).then((response) => response.json());
    assert.equal(shot.base64, Buffer.from([1, 2, 3]).toString('base64'));

    const first = await bridge.pollOnce();
    assert.equal(first?.text, '手机前台切换到 com.example.music/.MainActivity');
    assert.equal(received[0]?.url, '/connectors/android/ingest');
    assert.deepEqual(received[0]?.body, { text: '手机前台切换到 com.example.music/.MainActivity' });

    const second = await bridge.pollOnce();
    assert.equal(second, null, '前台未变化时不应重复写入记忆');
  } finally {
    await bridge.close();
    await close(dsh);
  }
});

test('P9 外部事件入口只接受合法来源', () => {
  assert.equal(parseExternalIngestPath('/connectors/android/ingest'), 'android');
  assert.equal(parseExternalIngestPath('/connectors/qq/ingest'), 'qq');
  assert.equal(parseExternalIngestPath('/connectors/chat/ingest'), null);
  assert.equal(parseExternalIngestPath('/vpet/ingest'), null);
});
