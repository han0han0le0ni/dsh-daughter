import { closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
function sleepSync(ms) {
    Atomics.wait(sleepCell, 0, 0, ms);
}
/**
 * 角色级写锁（§5.3 单写者）：以 `<目标文件>.lock` 的独占创建实现跨进程互斥。
 * 拿不到锁超过 timeoutMs 时释放降级为无锁写，避免阻塞会话主流程。
 */
export function withFileLock(target, fn, options = {}) {
    if (options.enabled === false)
        return fn();
    const lockPath = `${target}.lock`;
    const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
    const staleMs = options.staleMs ?? LOCK_STALE_MS;
    const deadline = Date.now() + timeoutMs;
    let fd = null;
    for (;;) {
        try {
            mkdirSync(dirname(lockPath), { recursive: true });
            fd = openSync(lockPath, 'wx');
            break;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            try {
                if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
                    unlinkSync(lockPath);
                    continue;
                }
            }
            catch {
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
    }
    finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            }
            catch {
                /* 已关闭 */
            }
        }
        try {
            unlinkSync(lockPath);
        }
        catch {
            /* 已被回收 */
        }
    }
}
let tempCounter = 0;
/**
 * 原子写文件：先写同目录临时文件再 rename 覆盖，避免进程中断留下半截 YAML/JSON。
 * Windows 上 rename 覆盖偶发失败时退化为直写。
 */
export function atomicWriteFile(path, content) {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    tempCounter += 1;
    const temp = join(dir, `.${basename(path)}.${process.pid}.${tempCounter}.tmp`);
    writeFileSync(temp, content, 'utf8');
    try {
        renameSync(temp, path);
    }
    catch {
        writeFileSync(path, content, 'utf8');
        try {
            unlinkSync(temp);
        }
        catch {
            /* 临时文件已被清理 */
        }
    }
}
/** 原子写 + 角色级锁的最小组合，供 Store 的各类落盘复用 */
export function writeLocked(path, content, options = {}) {
    withFileLock(path, () => atomicWriteFile(path, content), options);
}
export function checkToolGate(gate, intent, tool) {
    if (!gate)
        return;
    const verdict = gate(intent);
    if (verdict.allowed)
        return;
    throw new Error(`${tool} 已被安全降级暂停${verdict.reason ? `：${verdict.reason}` : ''}`);
}
export const silentLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
export function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
export function clampPad(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(-1, value));
}
/** 粗略 token 估算：CJK 字符按 1 token，其他字符按 4 字符 1 token */
export function estimateTokens(text) {
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
        if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch))
            cjk += 1;
        else
            other += 1;
    }
    return cjk + Math.ceil(other / 4);
}
/** PAD 距离，归一化到 0..1（每维量程为 2） */
export function padDistance(a, b) {
    const d = Math.abs(a.pleasure - b.pleasure) / 2 +
        Math.abs(a.arousal - b.arousal) / 2 +
        Math.abs(a.dominance - b.dominance) / 2;
    return clamp01(d / 3);
}
/** 字符二元组 Dice 相似度，作为无语义向量时的退化实现 */
export function diceSimilarity(a, b) {
    const na = normalizeForMatch(a);
    const nb = normalizeForMatch(b);
    if (!na || !nb)
        return 0;
    if (na === nb)
        return 1;
    const gramsA = bigrams(na);
    const gramsB = bigrams(nb);
    if (gramsA.size === 0 || gramsB.size === 0)
        return 0;
    let inter = 0;
    for (const [gram, count] of gramsA) {
        const other = gramsB.get(gram);
        if (other)
            inter += Math.min(count, other);
    }
    return clamp01((2 * inter) / (na.length + nb.length - 2));
}
function normalizeForMatch(text) {
    return text
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]/gu, '')
        .trim();
}
function bigrams(text) {
    const map = new Map();
    for (let i = 0; i < text.length - 1; i += 1) {
        const gram = text.slice(i, i + 2);
        map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
}
/** mulberry32，确定性随机源 */
export function createRng(seed) {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export function newEventId(now, rand) {
    const date = now.slice(0, 10).replace(/-/g, '');
    // 与进程级 nonce 混合，避免重启后种子序列重置导致 id 重复
    const suffix = (Math.floor(rand() * 0xffffff) ^ PROCESS_NONCE).toString(16).padStart(6, '0');
    return `EVT-${date}-${suffix}`;
}
export function safeFileName(value) {
    return value.replace(/[^\w.-]/g, '_');
}
export function daysBetween(from, to) {
    const a = Date.parse(from);
    const b = Date.parse(to);
    if (!Number.isFinite(a) || !Number.isFinite(b))
        return 0;
    return Math.max(0, (b - a) / 86_400_000);
}
export function truncate(text, max) {
    if (text.length <= max)
        return text;
    return `${text.slice(0, max)}…`;
}
