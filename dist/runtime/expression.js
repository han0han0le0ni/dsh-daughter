/**
 * 表达层出口：她"想表达点什么"之后，这句话发给谁。
 *
 * 早先只有一条硬编码通路——塞进 VPet 的事件队列靠 MOD 轮询。
 * 现在改成总线：事件结构统一，出口可配（游戏桌宠 / HTTP 应用 / JSONL 文件），
 * 任一出口挂掉不影响其它出口。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createPetSink } from './pet-link.js';
/**
 * 并发投递到所有出口。单个出口抛错只记一笔，不影响其他出口——
 * 桌宠没开不该导致 webhook 也收不到。
 */
export async function dispatchExpression(event, sinks) {
    if (sinks.length === 0)
        return { delivered: 0, failed: 0, errors: [] };
    const results = await Promise.allSettled(sinks.map((sink) => Promise.resolve().then(() => sink(event))));
    let delivered = 0;
    const errors = [];
    for (const result of results) {
        if (result.status === 'fulfilled') {
            delivered += 1;
            continue;
        }
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        if (errors.length < 3)
            errors.push(reason);
    }
    return { delivered, failed: results.length - delivered, errors };
}
/** HTTP 出口：POST 一份 JSON 给任意应用（自建服务、机器人桥、桌面壳） */
export function createHttpSink(url, options = {}) {
    const endpoint = String(url).replace(/\/+$/, '');
    const timeoutMs = options.timeoutMs ?? 3000;
    return async (event) => {
        const fetchImpl = options.fetchImpl ?? globalThis.fetch;
        if (!fetchImpl)
            throw new Error('当前运行环境没有 fetch，无法投递 HTTP 出口');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(event),
                signal: controller.signal,
            });
            if (!response.ok) {
                const body = await response.text?.().catch(() => '');
                throw new Error(`${endpoint} 返回 ${response.status}${body ? `：${body.slice(0, 120)}` : ''}`);
            }
        }
        finally {
            clearTimeout(timer);
        }
    };
}
/** 文件出口：追加 JSONL，任何本地进程都能 tail -f 跟着看 */
export function createFileSink(filePath, options = {}) {
    return async (event) => {
        const line = `${JSON.stringify(event)}\n`;
        try {
            await appendFile(filePath, line, 'utf8');
        }
        catch (error) {
            // 目录不存在是首次运行的常态，补建后重试一次
            const code = error.code;
            if (code !== 'ENOENT')
                throw error;
            await mkdir(dirname(filePath), { recursive: true });
            await appendFile(filePath, line, 'utf8');
        }
    };
}
/**
 * 按配置组装出口。`vpet` 需要宿主的事件队列、`pet` 需要宿主自己的监听地址，
 * 都由调用方注入；未知 type 在配置归一化阶段已被剔除，这里再挡一次。
 */
export function buildExpressionSinks(sinks, deps = {}) {
    const out = [];
    for (const item of sinks) {
        if (item.type === 'vpet') {
            if (deps.vpetSink)
                out.push(deps.vpetSink);
            continue;
        }
        if (item.type === 'pet') {
            const baseUrl = item.url?.trim() || deps.petBaseUrl || '';
            // 拿不到地址就跳过：宁可少一个出口，也不要让整条表达链在构造期抛错
            if (!baseUrl) {
                deps.logger?.warn?.('dsh-daughter: 桌宠出口缺少地址，已跳过', { pet: item.pet });
                continue;
            }
            out.push(createPetSink({
                baseUrl,
                petId: item.pet,
                route: item.route,
                timeoutMs: item.timeout_ms,
                durationMs: item.duration_ms,
            }));
            continue;
        }
        if (item.type === 'http' && item.url) {
            out.push(createHttpSink(item.url, { timeoutMs: item.timeout_ms, logger: deps.logger }));
            continue;
        }
        if (item.type === 'file' && item.path) {
            out.push(createFileSink(deps.resolvePath ? deps.resolvePath(item.path) : item.path, { logger: deps.logger }));
        }
    }
    return out;
}
