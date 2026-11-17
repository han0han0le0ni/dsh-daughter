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
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureScreenFrame, createFfmpegStream, hasFfmpeg } from './capture.mjs';
import { createDesktopSystem } from './system.mjs';
import { createDesktopInput, InputValidationError, normalizeInput } from './input.mjs';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:47612';
const DEFAULT_PORT = 47614;
const BOUNDARY = 'dshframe';
const TOKEN_HEADER = 'x-dsh-token';
/** 默认令牌文件：插件根目录下的 brain/brainstem/connector_token（与本文件差两级） */
const DEFAULT_TOKEN_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'brain',
  'brainstem',
  'connector_token',
);

/** 与插件侧 connector-auth 同一套判定：浏览器来源一律不认，令牌走常量时间比较 */
function readTokenFile(path) {
  try {
    if (!existsSync(path)) return '';
    const raw = readFileSync(path, 'utf8').trim();
    return raw.length >= 16 ? raw : '';
  } catch {
    return '';
  }
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function tokenMatches(expected, actual) {
  if (!expected || !actual) return false;
  return timingSafeEqual(digest(expected), digest(actual));
}

function incomingToken(req) {
  const direct = req.headers[TOKEN_HEADER];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const matched = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (matched?.[1]) return matched[1].trim();
  }
  return null;
}

/**
 * 浏览器发起的请求直接拒绝：连接器用 fetch/HttpClient，不会带这些头。
 * 这一条比令牌更早生效——即使令牌泄露，页面里的脚本也打不进来。
 */
function isBrowserInitiated(req) {
  // 不用 sec-fetch-mode：Node 自带的 fetch 也会发它（cors），会把自家工具误判成浏览器
  if (req.headers.origin !== undefined) return true;
  if (req.headers['sec-fetch-site'] !== undefined) return true;
  const referer = req.headers.referer;
  return typeof referer === 'string' && /^https?:/i.test(referer.trim());
}

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
    /** 连接器令牌；为空时**服务端拒绝一切数据请求**（不因"本机来的"放行） */
    token = '',
  } = options;

  const authToken = String(token ?? '').trim();
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
      headers: { 'content-type': 'application/json', ...(authToken ? { [TOKEN_HEADER]: authToken } : {}) },
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

        // 健康检查只回"活着 + 要认证"：以前这里会吐窗口标题、ffmpeg 状态、帧率，
        // 等于给本机扫描器免费做一次能力探测
        if (req.method === 'GET' && path === '/health') {
          sendJson(res, 200, { ok: true, auth: 'token' });
          return;
        }
        if (isBrowserInitiated(req)) {
          logger.warn?.('[desktop-bridge] 拒绝浏览器来源的请求', { path, method: req.method });
          sendJson(res, 403, { ok: false, error: 'browser_origin' });
          return;
        }
        if (!authToken) {
          sendJson(res, 503, { ok: false, error: 'token_unavailable' });
          return;
        }
        if (!tokenMatches(authToken, incomingToken(req))) {
          sendJson(res, 401, { ok: false, error: 'token_mismatch' });
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

  // 令牌优先级：--token > 环境变量 > 令牌文件。三处都没有就拒绝启动，
  // 不提供"无认证但只监听 127.0.0.1"这种降级——环回地址不是权限边界。
  const token = String(
    option(
      'token',
      process.env.DSH_DAUGHTER_TOKEN ??
        readTokenFile(option('token-file', process.env.DSH_DAUGHTER_TOKEN_FILE ?? DEFAULT_TOKEN_FILE)),
    ),
  ).trim();
  if (!token) {
    console.error(
      '[desktop-bridge] 缺少连接器令牌，已拒绝启动。\n' +
        '  先启动一次插件生成 brain/brainstem/connector_token，或用 --token / DSH_DAUGHTER_TOKEN 指定。',
    );
    process.exitCode = 1;
    return;
  }

  const bridge = createDesktopBridge({
    endpoint,
    token,
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
