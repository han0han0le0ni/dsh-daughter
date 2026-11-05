#!/usr/bin/env node
/**
 * Android ADB ↔ dsh-daughter 双向桥。
 *
 * 工具面：HTTP `POST /action` 执行受限 ADB 动作（打开应用/点击/滑动/输入/按键/截图）。
 * 感知面：轮询前台 Activity，变化时推送到宿主 `/connectors/android/ingest`，写入记忆。
 *
 * 用法：
 *   node connectors/android/bridge.mjs
 *   node connectors/android/bridge.mjs --once
 *   node connectors/android/bridge.mjs --serial emulator-5554 --interval 10
 *   node connectors/android/bridge.mjs --action open_app --param package=com.android.settings
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { ACTIONS, buildAdbArgs, createAdbRunner, parseDevices, parseForeground } from './adb.mjs';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:47612';
const DEFAULT_PORT = 47613;

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function stdoutOf(result) {
  if (Buffer.isBuffer(result?.stdout)) return result.stdout;
  return Buffer.from(String(result?.stdout ?? ''));
}

export function createAndroidBridge(options = {}) {
  const {
    endpoint = DEFAULT_ENDPOINT,
    serial = '',
    adb = createAdbRunner(),
    fetchImpl = globalThis.fetch,
    logger = console,
    pollMs = 20000,
    autoPoll = false,
    host = '127.0.0.1',
    port = DEFAULT_PORT,
  } = options;

  const base = String(endpoint).replace(/\/+$/, '');
  let lastForegroundKey = null;
  let timer = null;
  let actualPort = port;

  async function execute(action, params = {}) {
    const args = buildAdbArgs(action, params, serial);
    const result = await adb(args);
    const buffer = stdoutOf(result);
    const text = buffer.toString('utf8').trim();
    const payload = { ok: true, action, args, stdout: text };

    if (action === 'devices') payload.devices = parseDevices(text);
    if (action === 'foreground') payload.foreground = parseForeground(text);
    if (action === 'screenshot') {
      payload.base64 = buffer.toString('base64');
      payload.contentType = 'image/png';
    }
    return payload;
  }

  async function pollOnce() {
    const result = await adb(buildAdbArgs('foreground', {}, serial));
    const foreground = parseForeground(stdoutOf(result).toString('utf8'));
    if (!foreground || foreground.key === lastForegroundKey) return null;
    lastForegroundKey = foreground.key;

    const text = `手机前台切换到 ${foreground.key}`;
    const response = await fetchImpl(`${base}/connectors/android/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(`ingest ${response.status}: ${await response.text()}`);
    return { ...foreground, text };
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = (req.url ?? '/').split('?')[0];
        if (req.method === 'GET' && url === '/health') {
          sendJson(res, 200, { ok: true, serial, actions: ACTIONS });
          return;
        }
        if (req.method === 'GET' && url === '/devices') {
          sendJson(res, 200, await execute('devices'));
          return;
        }
        if (req.method === 'GET' && url === '/foreground') {
          sendJson(res, 200, await execute('foreground'));
          return;
        }
        if (req.method === 'POST' && url === '/action') {
          const payload = await readBody(req);
          const action = String(payload.action ?? '').trim();
          if (!ACTIONS.includes(action)) {
            sendJson(res, 400, { ok: false, error: `未知动作：${action}` });
            return;
          }
          sendJson(res, 200, await execute(action, payload));
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        logger.warn?.('android-bridge 请求失败', String(error));
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    })();
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        actualPort = server.address().port;
        if (autoPoll && pollMs > 0) {
          timer = setInterval(() => {
            pollOnce().catch((error) => logger.warn?.('android-bridge 轮询失败', String(error)));
          }, pollMs);
        }
        resolve({ port: actualPort });
      });
    });
  }

  function close() {
    if (timer) clearInterval(timer);
    timer = null;
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  return {
    server,
    start,
    close,
    execute,
    pollOnce,
    get port() {
      return actualPort;
    },
    get endpoint() {
      return base;
    },
  };
}

export async function startAndroidBridge(options = {}) {
  const bridge = createAndroidBridge(options);
  await bridge.start();
  return bridge;
}

/* -------------------------------- CLI -------------------------------- */

function parseParams(pairs) {
  const params = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`--param 需要 key=value：${pair}`);
    params[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return params;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const paramPairs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--param' && args[i + 1]) {
      paramPairs.push(args[i + 1]);
      i += 1;
    }
  }

  const endpoint = option('endpoint', process.env.DSH_DAUGHTER_ENDPOINT ?? DEFAULT_ENDPOINT);
  const serial = option('serial', process.env.ANDROID_SERIAL ?? '');
  const pollMs = Number(option('interval', '20')) * 1000;
  const action = option('action', '');

  if (action) {
    const bridge = createAndroidBridge({ endpoint, serial, adb: createAdbRunner({ adbPath: option('adb', 'adb') }) });
    const result = await bridge.execute(action, parseParams(paramPairs));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const bridge = createAndroidBridge({
    endpoint,
    serial,
    port: Number(option('port', String(DEFAULT_PORT))),
    pollMs,
    autoPoll: !flag('no-poll') && !flag('once'),
    adb: createAdbRunner({ adbPath: option('adb', 'adb') }),
  });

  if (flag('once')) {
    const event = await bridge.pollOnce();
    console.log(JSON.stringify(event ?? { changed: false }, null, 2));
    return;
  }

  await bridge.start();
  console.log(`[android-bridge] listening=${bridge.port} endpoint=${bridge.endpoint} serial=${serial || 'default'}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[android-bridge] 启动失败：', error);
    process.exitCode = 1;
  });
}
