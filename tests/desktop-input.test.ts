import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopInput, InputValidationError, normalizeInput } from '../connectors/desktop/input.mjs';
import { createDesktopInputTool, registerDesktopInputTool } from '../src/runtime/desktop-input.js';
import { startDesktopBridge } from '../connectors/desktop/bridge.mjs';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function fakeSystem() {
  return {
    async listWindows() {
      return [];
    },
    async foreground() {
      return { title: '', processId: 0, processName: '' };
    },
    async media() {
      return { available: false };
    },
  };
}

test('desktop_input：参数校验与归一化坐标', () => {
  const click = normalizeInput({ action: 'click', x: 100, y: 200, count: 9 });
  assert.equal(click.action, 'click');
  assert.equal(click.normalized, false);
  assert.equal(click.button, 'left');
  assert.equal(click.count, 3, '点击次数应被限制在 1–3');

  const normalized = normalizeInput({ action: 'move', x: 0.5, y: 0.25, normalized: true });
  assert.equal(normalized.x, 0.5);
  assert.equal(normalized.y, 0.25);

  const nudge = normalizeInput({ action: 'move', dx: 4, dy: -3 });
  assert.equal(nudge.dx, 4);
  assert.equal(nudge.dy, -3);

  assert.throws(() => normalizeInput({ action: 'nope' }), InputValidationError);
  assert.throws(() => normalizeInput({ action: 'move', x: 2, y: 0.5, normalized: true }), /超出范围/);
  assert.throws(() => normalizeInput({ action: 'move' }), /需要 x\/y 或 dx\/dy/);
  assert.throws(() => normalizeInput({ action: 'move', dx: 0, dy: 0 }), /不能同时为 0/);
  assert.throws(() => normalizeInput({ action: 'click', x: 1 }), /同时提供/);
  assert.throws(() => normalizeInput({ action: 'drag', from_x: 1 }), /drag/);
  assert.throws(() => normalizeInput({ action: 'scroll', delta: 0 }), /非 0/);
  assert.throws(() => normalizeInput({ action: 'key' }), /key/);
  assert.throws(() => normalizeInput({ action: 'type', text: 'x'.repeat(201) }), /200/);
  assert.throws(() => normalizeInput({ action: 'activate' }), /window 或 process/);
  assert.throws(() => normalizeInput({ action: 'key', key: 'a', mode: 'hold' }), /mode/);

  const hold = normalizeInput({ action: 'key', key: 'a', mode: 'down' });
  assert.equal(hold.mode, 'down');
});

test('desktop_input：客户端把规范化请求交给传输层', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const input = createDesktopInput({
    send: async (request: Record<string, unknown>) => {
      sent.push(request);
      return { screen: { width: 1920, height: 1080 }, cursor: { x: 5, y: 6 } };
    },
  });

  const result = await input.perform({ action: 'move', x: 10, y: 20 });
  assert.deepEqual(result, { screen: { width: 1920, height: 1080 }, cursor: { x: 5, y: 6 } });
  assert.deepEqual(sent[0], { action: 'move', normalized: false, x: 10, y: 20 });

  await input.perform({ action: 'move', dx: 3, dy: -4 });
  assert.deepEqual(sent[1], { action: 'move', normalized: false, dx: 3, dy: -4 });

  await assert.rejects(input.perform({ action: 'unknown' }), InputValidationError);
  input.close();
  await assert.rejects(input.perform({ action: 'screen' }), /已关闭/);
});

test('desktop_input：桥接 /input 路由与校验错误', async () => {
  const received: Array<Record<string, unknown>> = [];
  let closed = false;
  const bridge = await startDesktopBridge({
    endpoint: 'http://127.0.0.1:9',
    port: 0,
    backend: 'powershell',
    autoPoll: false,
    system: fakeSystem(),
    captureFrame: async () => Buffer.from([]),
    input: {
      async perform(request: Record<string, unknown>) {
        received.push(request);
        return { screen: { width: 1920, height: 1080 }, cursor: { x: 11, y: 22 } };
      },
      close() {
        closed = true;
      },
    },
  });

  try {
    const base = `http://127.0.0.1:${bridge.port}`;
    const health = await fetch(`${base}/health`).then((response) => response.json());
    assert.equal(health.input, true);

    const ok = await fetch(`${base}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'screen' }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.screen, { width: 1920, height: 1080 });
    assert.deepEqual(received[0], { action: 'screen', normalized: false });

    const invalid = await fetch(`${base}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'nope' }),
    });
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json();
    assert.match(invalidBody.error, /不支持的 action/);

    const broken = await fetch(`${base}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(broken.status, 400);
  } finally {
    await bridge.close();
    assert.equal(closed, true);
  }
});

test('desktop_input：窗口客户区相对坐标', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const input = createDesktopInput({
    send: async (request: Record<string, unknown>) => {
      sent.push(request);
      return { screen: { width: 2560, height: 1600 }, cursor: { x: 144, y: 780 } };
    },
  });

  await input.perform({ action: 'click', window: '杀戮尖塔', relative: true, x: 96, y: 520 });
  assert.deepEqual(sent[0], {
    action: 'click',
    normalized: false,
    x: 96,
    y: 520,
    button: 'left',
    count: 1,
    window: '杀戮尖塔',
    relative: true,
  });

  const foreground = await input.perform({ action: 'move', relative: true, x: 10, y: 20 });
  assert.deepEqual(sent[1], {
    action: 'move',
    normalized: false,
    x: 10,
    y: 20,
    relative: true,
  });
  assert.deepEqual(foreground, { screen: { width: 2560, height: 1600 }, cursor: { x: 144, y: 780 } });
  input.close();
});

test('desktop_input：工具调用、文本输出与注册', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return jsonResponse(200, {
      ok: true,
      screen: { width: 2560, height: 1600 },
      cursor: { x: 100, y: 200 },
      window: {
        title: '游戏窗口',
        processName: 'game',
        processId: 42,
        focused: true,
      },
    });
  };

  const tool = createDesktopInputTool({
    bridgeUrl: 'http://bridge.test',
    fetchImpl,
    timeoutMs: 1000,
  });

  const click = await tool.execute({ action: 'click', x: 100, y: 200, count: 2 }, {});
  assert.match(click.text, /已用左键/);
  assert.match(click.text, /点击 2 次/);
  assert.deepEqual(calls[0], {
    url: 'http://bridge.test/input',
    body: { action: 'click', x: 100, y: 200, count: 2 },
  });

  const activate = await tool.execute({ action: 'activate', window: '游戏窗口' }, {});
  assert.match(activate.text, /已切换到窗口「游戏窗口」（game）/);
  assert.deepEqual(calls[1].body, { action: 'activate', window: '游戏窗口' });

  const screen = await tool.execute({ action: 'screen' }, {});
  assert.equal(screen.text, '主屏 2560x1600，光标在 (100, 200)。');

  const windowClick = await tool.execute(
    { action: 'click', window: '游戏窗口', relative: true, x: 96, y: 520 },
    {},
  );
  assert.deepEqual(calls[3].body, {
    action: 'click',
    window: '游戏窗口',
    relative: true,
    x: 96,
    y: 520,
  });
  assert.match(windowClick.text, /窗口「游戏窗口」客户区 \(96, 520\)/);
  assert.deepEqual(tool.output.render({}, click), [{ type: 'text', text: click.text }]);

  const failing = createDesktopInputTool({
    bridgeUrl: 'http://bridge.test',
    timeoutMs: 1000,
    fetchImpl: async () => jsonResponse(400, { ok: false, error: '不支持的 action：nope' }),
  });
  await assert.rejects(failing.execute({ action: 'screen' }, {}), /桌面输入失败/);

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
      return undefined;
    },
  };
  const dispose = registerDesktopInputTool(ctx, { fetchImpl: fetchImpl as never, timeoutMs: 1000 });
  assert.equal(registered?.name, 'desktop_input');
  dispose();
  assert.equal(disposed, true);
});
