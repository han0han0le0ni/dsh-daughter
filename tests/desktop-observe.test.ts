import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDesktopObserveTool,
  registerDesktopObserveTool,
} from '../src/runtime/desktop-observe.js';

const JPEG = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
    async text() {
      return '';
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  };
}

function binaryResponse(data: Uint8Array) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {};
    },
    async text() {
      return '';
    },
    async arrayBuffer() {
      return data.buffer.slice(0, data.byteLength) as ArrayBuffer;
    },
  };
}

function createFakeFetch() {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.endsWith('/foreground')) {
      return jsonResponse({
        ok: true,
        foreground: {
          title: '测试窗口',
          processName: 'chrome',
          bounds: { left: 100, top: 80, width: 1920, height: 1080 },
          client: { left: 108, top: 120, width: 1904, height: 1016 },
        },
      });
    }
    if (url.includes('/screenshot')) return binaryResponse(JPEG);
    if (url.endsWith('/media')) {
      return jsonResponse({
        ok: true,
        media: { available: true, title: '测试视频', artist: 'UP', status: 'Playing' },
      });
    }
    if (url.endsWith('/windows')) {
      return jsonResponse({
        ok: true,
        windows: [
          { MainWindowTitle: '测试窗口' },
          { MainWindowTitle: '另一个窗口' },
          { MainWindowTitle: '' },
        ],
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchImpl, calls };
}

test('desktop_observe：取前台、截图并保存附件', async () => {
  const { fetchImpl, calls } = createFakeFetch();
  const saved: Uint8Array[] = [];
  const tool = createDesktopObserveTool({
    bridgeUrl: 'http://bridge.test',
    fetchImpl,
    timeoutMs: 1000,
    attachments: {
      async saveImage(input) {
        saved.push(input.data);
        return {
          attachmentId: 'att-desktop',
          mediaType: 'image/jpeg',
          bytes: input.data.length,
          width: 1280,
          height: 720,
        };
      },
    },
  });

  const value = await tool.execute(
    { width: 960, quality: 60, include_windows: true, include_media: true },
    {},
  );

  assert.match(value.text, /前台：测试窗口（chrome）/);
  assert.match(value.text, /窗口：位置 \(100, 80\)，尺寸 1920x1080/);
  assert.match(value.text, /客户区：起点 \(108, 120\)，尺寸 1904x1016/);
  assert.match(value.text, /截图：1280x720/);
  assert.match(value.text, /正在播放：测试视频 - UP/);
  assert.match(value.text, /可见窗口：测试窗口 \/ 另一个窗口/);
  assert.equal(value.image?.attachmentId, 'att-desktop');
  assert.deepEqual(saved[0], JPEG);
  assert.ok(calls.some((url) => url.includes('/screenshot?format=jpeg&width=960&quality=60')));
  assert.deepEqual(
    tool.output.render({}, value).map((block) => block.type),
    ['text', 'image'],
  );
});

test('desktop_observe：桥接不可用时返回可操作错误', async () => {
  const tool = createDesktopObserveTool({
    bridgeUrl: 'http://127.0.0.1:9',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    timeoutMs: 1000,
    attachments: {
      async saveImage() {
        return {
          attachmentId: 'x',
          mediaType: 'image/jpeg',
          bytes: 1,
          width: 1,
          height: 1,
        };
      },
    },
  });

  await assert.rejects(tool.execute({}, {}), /桌面桥接不可用.*connectors\/desktop\/bridge\.mjs/);
});

test('desktop_observe：焦点放大与准星参数', async () => {
  const { fetchImpl, calls } = createFakeFetch();
  const tool = createDesktopObserveTool({
    bridgeUrl: 'http://bridge.test',
    fetchImpl,
    timeoutMs: 1000,
    attachments: {
      async saveImage(input) {
        return {
          attachmentId: 'att-zoom',
          mediaType: 'image/jpeg',
          bytes: input.data.length,
          width: 640,
          height: 480,
        };
      },
    },
  });

  const cursorView = await tool.execute({ focus_cursor: true, crop_width: 640, crop_height: 480 }, {});
  assert.match(cursorView.text, /焦点：鼠标周围 640x480/);
  assert.match(cursorView.text, /鼠标准星：亮绿色十字已叠加/);
  assert.ok(
    calls.some(
      (url) =>
        url.includes('focus_cursor=true') &&
        url.includes('crop_width=640') &&
        url.includes('crop_height=480'),
    ),
  );

  const pointView = await tool.execute({ x: 300, y: 200, crop_width: 320, crop_height: 240 }, {});
  assert.match(pointView.text, /焦点：\(300, 200\) 周围 320x240/);
  assert.ok(calls.some((url) => url.includes('x=300') && url.includes('y=200')));
});

test('desktop_observe：注册到 tools 服务并支持卸载', async () => {
  const { fetchImpl } = createFakeFetch();
  let registered: { name?: string } | null = null;
  let disposed = false;
  const ctx = {
    get(name: string) {
      if (name === 'tools') {
        return {
          register(definition: { name?: string }) {
            registered = definition;
            return () => {
              disposed = true;
            };
          },
        };
      }
      if (name === 'attachments') {
        return {
          async saveImage() {
            return {
              attachmentId: 'att-register',
              mediaType: 'image/jpeg',
              bytes: JPEG.length,
              width: 1280,
              height: 720,
            };
          },
        };
      }
      return undefined;
    },
  };

  const dispose = registerDesktopObserveTool(ctx, { fetchImpl, timeoutMs: 1000 });
  assert.equal(registered?.name, 'desktop_observe');
  dispose();
  assert.equal(disposed, true);
});
