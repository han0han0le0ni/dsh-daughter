#!/usr/bin/env node
/**
 * Windows 桌面 ↔ dsh-daughter 双向桥。
 *
 * 状态面：窗口列表、前台窗口、系统媒体会话。
 * 画面面：`/screenshot` 单帧、`/frames` 低帧率 MJPEG、`/stream` ffmpeg 实时流。
 * 感知面：前台窗口变化推送到宿主 `/connectors/system/ingest`。
 *
 * 用法：
 *   node connectors/desktop/bridge.mjs
 *   node connectors/desktop/bridge.mjs --fps 2 --stream-fps 30
 *   node connectors/desktop/bridge.mjs --stream-width 960 --stream-quality 8
 *   node connectors/desktop/bridge.mjs --window "游戏窗口" --backend ffmpeg
 *   node connectors/desktop/bridge.mjs --once
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { captureScreenFrame, createFfmpegStream, hasFfmpeg } from './capture.mjs';
import { createDesktopSystem } from './system.mjs';
import { createDesktopInput, InputValidationError, normalizeInput } from './input.mjs';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:47612';
const DEFAULT_PORT = 47614;
const BOUNDARY = 'dshframe';

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let text = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new InputValidationError('请求体过大'));
        req.destroy();
        return;
      }
      text += chunk;
    });
    req.on('end', () => {
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new InputValidationError(`JSON 无效：${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function clampFps(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.max(1, number));
}

function clampQuality(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function clampWidth(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(3840, Math.round(number));
}

function writeFrame(res, frame, contentType = 'image/jpeg') {
  res.write(`--${BOUNDARY}\r\nContent-Type: ${contentType}\r\nContent-Length: ${frame.length}\r\n\r\n`);
  res.write(frame);
  res.write('\r\n');
}

export function createDesktopBridge(options = {}) {
  const {
    endpoint = DEFAULT_ENDPOINT,
    port = DEFAULT_PORT,
    host = '127.0.0.1',
    fps = 2,
    streamFps = 30,
    streamWidth = 1280,
    streamQuality = 7,
    frameQuality = 60,
    windowTitle = '',
    backend = 'auto',
    powershell = 'powershell.exe',
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
    system = createDesktopSystem(),
    captureFrame = (input) => captureScreenFrame(input),
    openStream = (input) => createFfmpegStream(input),
    fetchImpl = globalThis.fetch,
    logger = console,
    pollMs = 5000,
    autoPoll = false,
    input: providedInput = undefined,
  } = options;

  const base = String(endpoint).replace(/\/+$/, '');
  const desktopInput = providedInput === undefined
    ? createDesktopInput({ powershell, logger })
    : providedInput;
  let actualPort = port;
  let timer = null;
  let lastForegroundKey = null;
  let ffmpegReady = null;

  async function ensureFfmpeg() {
    if (backend === 'powershell') return false;
    if (backend === 'ffmpeg') return true;
    if (ffmpegReady === null) ffmpegReady = hasFfmpeg({ ffmpegPath });
    return ffmpegReady;
  }

  async function pollOnce() {
    const foreground = await system.foreground();
    if (!foreground?.title) return null;
    const key = `${foreground.processId}:${foreground.title}`;
    if (key === lastForegroundKey) return null;
    lastForegroundKey = key;
    const process = foreground.processName ? `（${foreground.processName}）` : '';
    const text = `电脑前台切换到 ${foreground.title}${process}`;
    const response = await fetchImpl(`${base}/connectors/system/ingest`, {
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
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const path = url.pathname;

        if (req.method === 'GET' && path === '/health') {
          sendJson(res, 200, {
            ok: true,
            platform: process.platform,
            fps,
            streamFps,
            streamWidth,
            streamQuality,
            frameQuality,
            windowTitle,
            ffmpeg: await ensureFfmpeg(),
            input: Boolean(desktopInput),
          });
          return;
        }
        if (req.method === 'GET' && path === '/windows') {
          sendJson(res, 200, { ok: true, windows: await system.listWindows() });
          return;
        }
        if (req.method === 'GET' && path === '/foreground') {
          sendJson(res, 200, { ok: true, foreground: await system.foreground() });
          return;
        }
        if (req.method === 'GET' && path === '/media') {
          sendJson(res, 200, { ok: true, media: await system.media() });
          return;
        }
        if (req.method === 'POST' && path === '/input') {
          if (!desktopInput) {
            sendJson(res, 503, { ok: false, error: '桌面输入未启用' });
            return;
          }
          try {
            const payload = normalizeInput(await readJsonBody(req));
            const result = await desktopInput.perform(payload);
            sendJson(res, 200, { ok: true, ...result });
          } catch (error) {
            const status = error instanceof InputValidationError ? 400 : 500;
            sendJson(res, status, { ok: false, error: error?.message ? String(error.message) : String(error) });
          }
          return;
        }
        if (req.method === 'GET' && path === '/screenshot') {
          const format = url.searchParams.get('format') === 'jpeg' ? 'jpeg' : 'png';
          const useWidth = clampWidth(url.searchParams.get('width'), 0);
          const useQuality = clampQuality(url.searchParams.get('quality'), 70, 10, 95);
          const readNumber = (name) => {
            const value = url.searchParams.get(name);
            if (value === null || value === '') return undefined;
            const number = Number(value);
            return Number.isFinite(number) ? number : undefined;
          };
          const frame = await captureFrame({
            powershell,
            format,
            width: useWidth,
            quality: useQuality,
            dpi: true,
            cursor: url.searchParams.get('cursor') === 'true',
            focusCursor: url.searchParams.get('focus_cursor') === 'true',
            centerX: readNumber('x'),
            centerY: readNumber('y'),
            cropWidth: readNumber('crop_width'),
            cropHeight: readNumber('crop_height'),
          });
          res.writeHead(200, {
            'content-type': format === 'jpeg' ? 'image/jpeg' : 'image/png',
            'cache-control': 'no-store',
          });
          res.end(frame);
          return;
        }
        if (req.method === 'GET' && path === '/frames') {
          const useFps = clampFps(url.searchParams.get('fps'), fps, 10);
          const useQuality = clampQuality(url.searchParams.get('quality'), frameQuality, 10, 95);
          res.writeHead(200, {
            'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            'cache-control': 'no-store',
          });
          let closed = false;
          let next = null;
          const stop = () => {
            closed = true;
            if (next) clearTimeout(next);
          };
          req.on('close', stop);
          res.on('close', stop);

          const loop = async () => {
            if (closed) return;
            try {
              const frame = await captureFrame({ powershell, format: 'jpeg', quality: useQuality });
              if (!closed && !res.writableEnded) writeFrame(res, frame, 'image/jpeg');
            } catch (error) {
              logger.warn?.('desktop-bridge 截图失败', String(error));
            }
            if (!closed) next = setTimeout(loop, 1000 / useFps);
          };
          void loop();
          return;
        }
        if (req.method === 'GET' && path === '/stream') {
          if (!(await ensureFfmpeg())) {
            sendJson(res, 501, { ok: false, error: 'ffmpeg 不可用，请安装 ffmpeg 或使用 /frames' });
            return;
          }
          const useFps = clampFps(url.searchParams.get('fps'), streamFps, 60);
          const useWidth = clampWidth(url.searchParams.get('width'), streamWidth);
          const useQuality = clampQuality(url.searchParams.get('quality'), streamQuality, 2, 31);
          const target = (url.searchParams.get('window') ?? windowTitle).trim();
          res.writeHead(200, {
            'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            'cache-control': 'no-store',
          });
          let closed = false;
          const stream = openStream({
            fps: useFps,
            width: useWidth,
            quality: useQuality,
            windowTitle: target,
            ffmpegPath,
            onFrame: (frame) => {
              if (!closed && !res.writableEnded) writeFrame(res, frame);
            },
            onError: (error) => logger.warn?.('desktop-bridge 推流失败', String(error)),
          });
          const stop = () => {
            closed = true;
            stream.stop();
          };
          req.on('close', stop);
          res.on('close', stop);
          return;
        }

        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        logger.warn?.('desktop-bridge 请求失败', String(error));
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error) });
        else res.end();
      }
    })();
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const address = server.address();
        actualPort = typeof address === 'object' && address ? address.port : port;
        if (autoPoll && pollMs > 0) {
          timer = setInterval(() => {
            pollOnce().catch((error) => logger.warn?.('desktop-bridge 轮询失败', String(error)));
          }, pollMs);
        }
        resolve({ port: actualPort });
      });
    });
  }

  function close() {
    if (timer) clearInterval(timer);
    timer = null;
    desktopInput?.close?.();
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
  }

  return {
    server,
    start,
    close,
    pollOnce,
    get port() {
      return actualPort;
    },
    get endpoint() {
      return base;
    },
  };
}

export async function startDesktopBridge(options = {}) {
  const bridge = createDesktopBridge(options);
  await bridge.start();
  return bridge;
}

/* -------------------------------- CLI -------------------------------- */

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };

  const endpoint = option('endpoint', process.env.DSH_DAUGHTER_ENDPOINT ?? DEFAULT_ENDPOINT);
  const system = createDesktopSystem();

  if (flag('once')) {
    const [foreground, windows, media] = await Promise.all([
      system.foreground(),
      system.listWindows(),
      system.media(),
    ]);
    console.log(JSON.stringify({ foreground, windowCount: windows.length, media }, null, 2));
    return;
  }

  const bridge = createDesktopBridge({
    endpoint,
    port: Number(option('port', String(DEFAULT_PORT))),
    fps: Number(option('fps', '2')),
    streamFps: Number(option('stream-fps', '30')),
    streamWidth: Number(option('stream-width', '1280')),
    streamQuality: Number(option('stream-quality', '7')),
    frameQuality: Number(option('frame-quality', '60')),
    windowTitle: option('window', ''),
    backend: option('backend', 'auto'),
    powershell: option('powershell', 'powershell.exe'),
    ffmpegPath: option('ffmpeg', process.env.FFMPEG_PATH ?? 'ffmpeg'),
    pollMs: Number(option('interval', '5')) * 1000,
    autoPoll: !flag('no-poll'),
    system,
  });

  await bridge.start();
  console.log(`[desktop-bridge] listening=${bridge.port} endpoint=${bridge.endpoint}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[desktop-bridge] 启动失败：', error);
    process.exitCode = 1;
  });
}
