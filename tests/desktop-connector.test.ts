import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { startDesktopBridge } from '../connectors/desktop/bridge.mjs';
import { buildFfmpegArgs, createJpegFrameReader } from '../connectors/desktop/capture.mjs';
import { parseJsonList } from '../connectors/desktop/system.mjs';
import { parseExternalIngestPath } from '../src/host.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);

function fakeSystem() {
  return {
    async listWindows() {
      return [
        { Id: 12, ProcessName: 'chrome', MainWindowTitle: '视频 - Chrome' },
        { Id: 34, ProcessName: 'game', MainWindowTitle: '游戏窗口' },
      ];
    },
    async foreground() {
      return {
        title: '视频 - Chrome',
        processId: 12,
        processName: 'chrome',
        bounds: { left: 0, top: 0, width: 1920, height: 1080 },
      };
    },
    async media() {
      return { available: true, title: '测试视频', artist: 'UP', status: 'Playing' };
    },
  };
}

test('P9 桌面：ffmpeg 参数与 JPEG 帧切分', () => {
  const desktop = buildFfmpegArgs({ fps: 30 });
  assert.ok(desktop.includes('ddagrab=output_idx=0:framerate=30'));
  assert.ok(desktop.includes('scale=1280:-2'));
  assert.equal(desktop[desktop.indexOf('-q:v') + 1], '7');
  assert.deepEqual(desktop.slice(-5), ['-f', 'image2pipe', '-vcodec', 'mjpeg', '-']);

  const native = buildFfmpegArgs({ fps: 30, width: 0, quality: 3 });
  assert.ok(!native.includes('-vf'));
  assert.equal(native[native.indexOf('-q:v') + 1], '3');

  const windowArgs = buildFfmpegArgs({ fps: 30, windowTitle: '游戏窗口' });
  assert.ok(windowArgs.includes('title=游戏窗口'));
  assert.ok(windowArgs.includes('gdigrab'));

  const frames: Buffer[] = [];
  const read = createJpegFrameReader((frame) => frames.push(frame));
  read(Buffer.from([0xff, 0xd8, 9]));
  read(Buffer.from([9, 0xff]));
  read(Buffer.from([0xd9, 0xff, 0xd8, 8, 8, 0xff, 0xd9]));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], Buffer.from([0xff, 0xd8, 9, 9, 0xff, 0xd9]));

  assert.deepEqual(parseJsonList('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(parseJsonList('{"a":1}'), [{ a: 1 }]);
});

test('P9 桌面：状态、截图、抽帧与前台事件端到端', async () => {
  const received: Array<{ url: string; body: unknown }> = [];
  const dsh = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, eventId: 'EVT-desktop' }));
    });
  });
  const dshPort = await listen(dsh);
  let captures = 0;

  const bridge = await startDesktopBridge({
    endpoint: `http://127.0.0.1:${dshPort}`,
    port: 0,
    backend: 'powershell',
    autoPoll: false,
    system: fakeSystem(),
    captureFrame: async (input: { format?: string } = {}) => {
      captures += 1;
      return input.format === 'jpeg' ? JPEG : PNG;
    },
  });

  try {
    const base = `http://127.0.0.1:${bridge.port}`;
    const health = await fetch(`${base}/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.ffmpeg, false);
    assert.equal(health.streamWidth, 1280);
    assert.equal(health.streamQuality, 7);

    const windows = await fetch(`${base}/windows`).then((response) => response.json());
    assert.equal(windows.windows.length, 2);
    assert.equal(windows.windows[0].MainWindowTitle, '视频 - Chrome');

    const foreground = await fetch(`${base}/foreground`).then((response) => response.json());
    assert.equal(foreground.foreground.processName, 'chrome');

    const media = await fetch(`${base}/media`).then((response) => response.json());
    assert.equal(media.media.title, '测试视频');

    const screenshot = await fetch(`${base}/screenshot`);
    assert.equal(screenshot.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await screenshot.arrayBuffer()), PNG);

    const controller = new AbortController();
    const frames = await fetch(`${base}/frames?fps=10`, { signal: controller.signal });
    assert.match(frames.headers.get('content-type') ?? '', /multipart\/x-mixed-replace/);
    const reader = frames.body!.getReader();
    let head = '';
    for (let i = 0; i < 5 && !head.includes('dshframe'); i += 1) {
      const { value } = await reader.read();
      head += new TextDecoder().decode(value);
    }
    controller.abort();
    assert.match(head, /^--dshframe/);
    assert.match(head, /image\/jpeg/);
    assert.ok(captures >= 1);

    const first = await bridge.pollOnce();
    assert.equal(first?.text, '电脑前台切换到 视频 - Chrome（chrome）');
    assert.equal(received[0]?.url, '/connectors/system/ingest');
    assert.deepEqual(received[0]?.body, { text: '电脑前台切换到 视频 - Chrome（chrome）' });
    assert.equal(await bridge.pollOnce(), null, '前台未变化时不应重复写入记忆');
  } finally {
    await bridge.close();
    await closeServer(dsh);
  }
});

test('P9 桌面：ffmpeg 实时流可输出 JPEG 帧', async () => {
  const bridge = await startDesktopBridge({
    endpoint: 'http://127.0.0.1:9',
    port: 0,
    backend: 'ffmpeg',
    autoPoll: false,
    system: fakeSystem(),
    captureFrame: async () => PNG,
    openStream: ({ onFrame }) => {
      const timer = setTimeout(() => onFrame(JPEG), 10);
      return { stop: () => clearTimeout(timer) };
    },
  });

  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${bridge.port}/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const head = new TextDecoder().decode(value);
    controller.abort();
    assert.match(head, /^--dshframe/);
    assert.match(head, /image\/jpeg/);
  } finally {
    await bridge.close();
  }
});

test('P9 桌面事件来源合法', () => {
  assert.equal(parseExternalIngestPath('/connectors/system/ingest'), 'system');
});
