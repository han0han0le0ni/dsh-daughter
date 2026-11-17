import { closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 进程级 nonce：让事件 id 在重启后不重复。
 * 用 pid + 启动时间戳派生，不再调用 Math.random（§6.1 禁止直接使用随机源）。
 */
const PROCESS_NONCE = ((process.pid * 2654435761) ^ Date.now()) & 0xffffff;

/** 跨进程写锁的默认参数：10s 视为陈旧锁，2s 拿不到就降级为无锁写并告警 */
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 5;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export interface FileLockOptions {
  /** false 时退化为无锁写（对应 storage.single_writer: false） */
  enabled?: boolean;
  timeoutMs?: number;
  staleMs?: number;
  /** 拿不到锁时调用，便于上层记日志 */
  onTimeout?: () => void;
}

function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

/**
 * 角色级写锁（§5.3 单写者）：以 `<目标文件>.lock` 的独占创建实现跨进程互斥。
 * 拿不到锁超过 timeoutMs 时释放降级为无锁写，避免阻塞会话主流程。
 */
export function withFileLock<T>(target: string, fn: () => T, options: FileLockOptions = {}): T {
  if (options.enabled === false) return fn();

  const lockPath = `${target}.lock`;
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;

  for (;;) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      fd = openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        options.onTimeout?.();
        break;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 已关闭 */
      }
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* 已被回收 */
    }
  }
}

let tempCounter = 0;

/**
 * 原子写文件：先写同目录临时文件再 rename 覆盖，避免进程中断留下半截 YAML/JSON。
 * Windows 上 rename 覆盖偶发失败时退化为直写。
 */
export function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  tempCounter += 1;
  const temp = join(dir, `.${basename(path)}.${process.pid}.${tempCounter}.tmp`);
  writeFileSync(temp, content, 'utf8');
  try {
    renameSync(temp, path);
  } catch {
    writeFileSync(path, content, 'utf8');
    try {
      unlinkSync(temp);
    } catch {
      /* 临时文件已被清理 */
    }
  }
}

/** 原子写 + 角色级锁的最小组合，供 Store 的各类落盘复用 */
export function writeLocked(path: string, content: string, options: FileLockOptions = {}): void {
  withFileLock(path, () => atomicWriteFile(path, content), options);
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * 工具级安全闸门（§10.1）：安全档位 ≥2 时只有只读工具放行。
 * 由宿主注入到各连接器工具里，避免降级期间仍能操作鼠标/窗口。
 */
export type ToolGate = (intent: 'read' | 'write') => { allowed: boolean; reason?: string };

export function checkToolGate(gate: ToolGate | undefined, intent: 'read' | 'write', tool: string): void {
  if (!gate) return;
  const verdict = gate(intent);
  if (verdict.allowed) return;
  throw new Error(`${tool} 已被安全降级暂停${verdict.reason ? `：${verdict.reason}` : ''}`);
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function clampPad(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}

/** 粗略 token 估算：CJK 字符按 1 token，其他字符按 4 字符 1 token */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** PAD 距离，归一化到 0..1（每维量程为 2） */
export function padDistance(a: { pleasure: number; arousal: number; dominance: number }, b: { pleasure: number; arousal: number; dominance: number }): number {
  const d =
    Math.abs(a.pleasure - b.pleasure) / 2 +
    Math.abs(a.arousal - b.arousal) / 2 +
    Math.abs(a.dominance - b.dominance) / 2;
  return clamp01(d / 3);
}

/** 字符二元组 Dice 相似度，作为无语义向量时的退化实现 */
export function diceSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const gramsA = bigrams(na);
  const gramsB = bigrams(nb);
  if (gramsA.size === 0 || gramsB.size === 0) return 0;

  let inter = 0;
  for (const [gram, count] of gramsA) {
    const other = gramsB.get(gram);
    if (other) inter += Math.min(count, other);
  }
  return clamp01((2 * inter) / (na.length + nb.length - 2));
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .trim();
}

function bigrams(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    map.set(gram, (map.get(gram) ?? 0) + 1);
  }
  return map;
}

/** FNV-1a 字符串哈希：把稳定字符串折成种子，同输入同输出 */
export function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32，确定性随机源 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newEventId(now: string, rand: () => number): string {
  const date = now.slice(0, 10).replace(/-/g, '');
  // 与进程级 nonce 混合，避免重启后种子序列重置导致 id 重复
  const suffix = (Math.floor(rand() * 0xffffff) ^ PROCESS_NONCE).toString(16).padStart(6, '0');
  return `EVT-${date}-${suffix}`;
}

export function safeFileName(value: string): string {
  return value.replace(/[^\w.-]/g, '_');
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (b - a) / 86_400_000);
}

/**
 * 相对时间（"3 小时前""昨天"），注入记忆行时用。
 *
 * 记忆里只有绝对时间戳，模型拿到一列标题和摘要，分不清是刚才还是上个月，
 * 于是不敢说"上次"、也不会说"刚才"。给它一个相对锚点，指代才有落点。
 * 一天以上按 24 小时折算（"昨天"= 24–48 小时前），不做日历日边界——注入不需要那么精确。
 */
export function relativeTime(from: string, to: string): string {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return '';
  const minutes = Math.floor(Math.max(0, toMs - fromMs) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months} 个月前` : `${Math.floor(months / 12)} 年前`;
}

/**
 * 绝对时间戳（本地时钟）：今天的显示 `HH:MM`，更早的显示 `MM-DD HH:MM`。
 * 跨窗口连贯性用它：相对时间只说"多久前"，绝对时钟才能把"我跑了 → 你好"接成一条时间线。
 */
export function formatTimestamp(iso: string, now?: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const nowMs = now ? Date.parse(now) : Date.now();
  const sameDay =
    Number.isFinite(nowMs) &&
    new Date(nowMs).toDateString() === date.toDateString();
  return sameDay ? hhmm : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hhmm}`;
}

/**
 * 窗口的名字：同一个会话每次都叫同一个名，换个窗口就换个名。
 *
 * 没有名字时，注入的每行只有时间戳，"这句话是我在这边刚说的"和"是那边说的"分不开，
 * 本窗口的话被当成别处的、自己跟自己的回声往下推。给窗口一个能念出来的短名，
 * 贴过来时就能标清哪句是这儿、哪句是别处。
 */
export function windowName(sessionId?: string | null): string {
  if (!sessionId) return '旧窗口';
  const code = (hashText(sessionId) % 1296).toString(36).toUpperCase().padStart(2, '0');
  return `窗${code}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
