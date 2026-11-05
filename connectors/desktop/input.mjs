import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_INPUT_WORKER = join(HERE, 'input-worker.ps1');

const ACTIONS = new Set(['move', 'click', 'drag', 'scroll', 'key', 'type', 'activate', 'screen']);
const BUTTONS = new Set(['left', 'right', 'middle']);
const KEY_MODES = new Set(['press', 'down', 'up']);

export class InputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputValidationError';
  }
}

function readNumber(raw, name, min = -Infinity, max = Infinity) {
  if (raw[name] === undefined || raw[name] === null || raw[name] === '') return undefined;
  const value = Number(raw[name]);
  if (!Number.isFinite(value)) throw new InputValidationError(`${name} 必须是数字`);
  if (value < min || value > max) throw new InputValidationError(`${name} 超出范围（${min}–${max}）`);
  return value;
}

function readText(raw, name, maxLength) {
  if (raw[name] === undefined || raw[name] === null) return undefined;
  const value = String(raw[name]).trim();
  if (!value) return undefined;
  if (value.length > maxLength) throw new InputValidationError(`${name} 最长 ${maxLength} 个字符`);
  return value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeInput(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputValidationError('input 参数必须是对象');
  }
  const action = String(raw.action ?? '').trim().toLowerCase();
  if (!ACTIONS.has(action)) {
    throw new InputValidationError(`不支持的 action：${action || '(空)'}`);
  }

  const normalized = raw.normalized === true;
  const coordRange = normalized ? [0, 1] : [-10000, 10000];
  const readCoord = (name) => readNumber(raw, name, coordRange[0], coordRange[1]);
  const request = { action, normalized };
  const window = readText(raw, 'window', 256);
  const process = readText(raw, 'process', 256);
  const relative = raw.relative === true;
  // 指针类动作可按窗口客户区坐标定位：window/process 指定目标窗口，
  // 缺省时 worker 回退到当前前台窗口。
  const applyWindowTarget = (target) => {
    if (window) target.window = window;
    if (process) target.process = process;
    if (relative) target.relative = true;
  };

  if (action === 'move') {
    const x = readCoord('x');
    const y = readCoord('y');
    const dx = readNumber(raw, 'dx', -10000, 10000);
    const dy = readNumber(raw, 'dy', -10000, 10000);
    if (x !== undefined && y !== undefined) {
      request.x = x;
      request.y = y;
      const duration = readNumber(raw, 'duration_ms', 0, 5000);
      if (duration !== undefined) request.duration_ms = duration;
      applyWindowTarget(request);
    } else if (dx !== undefined || dy !== undefined) {
      // 相对当前位置微调，用于瞄准闭环的最后几像素修正
      request.dx = dx ?? 0;
      request.dy = dy ?? 0;
      if (request.dx === 0 && request.dy === 0) {
        throw new InputValidationError('move 的 dx/dy 不能同时为 0');
      }
    } else {
      throw new InputValidationError('move 需要 x/y 或 dx/dy');
    }
  }

  if (action === 'click') {
    const x = readCoord('x');
    const y = readCoord('y');
    if ((x === undefined) !== (y === undefined)) {
      throw new InputValidationError('click 的 x 与 y 需要同时提供');
    }
    if (x !== undefined && y !== undefined) {
      request.x = x;
      request.y = y;
    }
    const button = String(raw.button ?? 'left').trim().toLowerCase();
    if (!BUTTONS.has(button)) throw new InputValidationError(`不支持的鼠标按键：${button}`);
    request.button = button;
    request.count = clamp(Math.round(readNumber(raw, 'count') ?? 1), 1, 3);
    const interval = readNumber(raw, 'interval_ms', 20, 500);
    if (interval !== undefined) request.interval_ms = interval;
    applyWindowTarget(request);
  }

  if (action === 'drag') {
    const fromX = readCoord('from_x');
    const fromY = readCoord('from_y');
    const toX = readCoord('to_x');
    const toY = readCoord('to_y');
    if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
      throw new InputValidationError('drag 需要 from_x/from_y/to_x/to_y');
    }
    request.from_x = fromX;
    request.from_y = fromY;
    request.to_x = toX;
    request.to_y = toY;
    const button = String(raw.button ?? 'left').trim().toLowerCase();
    if (!BUTTONS.has(button)) throw new InputValidationError(`不支持的鼠标按键：${button}`);
    request.button = button;
    const duration = readNumber(raw, 'duration_ms', 0, 5000);
    if (duration !== undefined) request.duration_ms = duration;
    applyWindowTarget(request);
  }

  if (action === 'scroll') {
    const x = readCoord('x');
    const y = readCoord('y');
    if ((x === undefined) !== (y === undefined)) {
      throw new InputValidationError('scroll 的 x 与 y 需要同时提供');
    }
    if (x !== undefined && y !== undefined) {
      request.x = x;
      request.y = y;
    }
    const delta = readNumber(raw, 'delta', -1200, 1200);
    if (delta === undefined || delta === 0) throw new InputValidationError('scroll 需要非 0 的 delta');
    request.delta = delta;
    applyWindowTarget(request);
  }

  if (action === 'key') {
    const key = readText(raw, 'key', 64);
    if (!key) throw new InputValidationError('key 需要 key 参数，例如 a 或 ctrl+a');
    request.key = key;
    const mode = String(raw.mode ?? 'press').trim().toLowerCase();
    if (!KEY_MODES.has(mode)) throw new InputValidationError(`不支持的 key mode：${mode}`);
    request.mode = mode;
    const hold = readNumber(raw, 'hold_ms', 0, 2000);
    if (hold !== undefined) request.hold_ms = hold;
  }

  if (action === 'type') {
    if (raw.text === undefined || raw.text === null) throw new InputValidationError('type 需要 text');
    const text = String(raw.text);
    if (!text) throw new InputValidationError('type 需要 text');
    if (text.length > 200) throw new InputValidationError('type 的 text 最长 200 个字符');
    request.text = text;
  }

  if (action === 'activate') {
    const window = readText(raw, 'window', 256);
    const process = readText(raw, 'process', 256);
    if (!window && !process) throw new InputValidationError('activate 需要 window 或 process');
    if (window) request.window = window;
    if (process) request.process = process;
  }

  return request;
}

export function createDesktopInput(options = {}) {
  const {
    powershell = 'powershell.exe',
    workerScript = DEFAULT_INPUT_WORKER,
    timeoutMs = 15000,
    spawnImpl = spawn,
    send = null,
    logger = null,
  } = options;

  let child = null;
  let buffer = '';
  let sequence = 0;
  let closed = false;
  const pending = new Map();

  function rejectAll(error) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  function handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    const id = String(payload.id ?? '');
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    clearTimeout(item.timer);
    if (payload.ok) item.resolve(payload.result ?? {});
    else item.reject(new Error(payload.error || '输入执行失败'));
  }

  function ensureWorker() {
    if (closed) throw new Error('输入 worker 已关闭');
    if (child && child.exitCode === null && !child.killed) return child;
    buffer = '';
    child = spawnImpl(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', workerScript],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    let stderr = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on('exit', () => {
      const suffix = stderr.trim() ? `：${stderr.trim()}` : '';
      child = null;
      rejectAll(new Error(`输入 worker 退出${suffix}`));
    });
    child.on('error', (error) => {
      child = null;
      rejectAll(error);
    });
    return child;
  }

  async function perform(raw) {
    if (closed) throw new Error('输入 worker 已关闭');
    const request = normalizeInput(raw);
    if (send) return send(request);

    const worker = ensureWorker();
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`输入执行超时（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        worker.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function close() {
    closed = true;
    rejectAll(new Error('输入 worker 已关闭'));
    if (child) {
      child.kill();
      child = null;
    }
  }

  return { perform, close };
}
