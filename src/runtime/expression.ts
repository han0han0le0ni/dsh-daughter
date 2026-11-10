/**
 * 表达层出口：她"想表达点什么"之后，这句话发给谁。
 *
 * 早先只有一条硬编码通路——塞进 VPet 的事件队列靠 MOD 轮询。
 * 现在改成总线：事件结构统一，出口可配（游戏桌宠 / HTTP 应用 / JSONL 文件），
 * 任一出口挂掉不影响其它出口。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ExpressionSinkConfig } from '../types.js';
import type { Logger } from '../util.js';
import { createPetSink } from './pet-link.js';

/**
 * 表达事件的种类：speak = 她主动说的话（正式开口）；
 * think = 思考碎碎念（DEF-23），只在出口显示短句，不构成回复、不写记忆。
 */
export type ExpressionKind = 'speak' | 'think';

export interface ExpressionEvent {
  kind: ExpressionKind;
  characterId: string;
  at: string;
  /** 要显示或播报的文本 */
  text?: string;
  /** 动机分类（miss / care / share / worry / bored），对端可据此换表情 */
  reason?: string;
  /** 想说的强度 0..1，对端可用来决定音量或动画力度 */
  intensity?: number;
}

export type ExpressionSink = (event: ExpressionEvent) => void | Promise<void>;

export interface DispatchResult {
  delivered: number;
  failed: number;
  /** 失败原因，最多保留 3 条，避免日志爆炸 */
  errors: string[];
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  text?(): Promise<string>;
}

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/**
 * 并发投递到所有出口。单个出口抛错只记一笔，不影响其他出口——
 * 桌宠没开不该导致 webhook 也收不到。
 */
export async function dispatchExpression(
  event: ExpressionEvent,
  sinks: ExpressionSink[],
): Promise<DispatchResult> {
  if (sinks.length === 0) return { delivered: 0, failed: 0, errors: [] };
  const results = await Promise.allSettled(
    sinks.map((sink) => Promise.resolve().then(() => sink(event))),
  );

  let delivered = 0;
  const errors: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      delivered += 1;
      continue;
    }
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    if (errors.length < 3) errors.push(reason);
  }
  return { delivered, failed: results.length - delivered, errors };
}

/** HTTP 出口：POST 一份 JSON 给任意应用（自建服务、机器人桥、桌面壳） */
export function createHttpSink(
  url: string,
  options: { timeoutMs?: number; fetchImpl?: FetchLike; logger?: Partial<Logger> } = {},
): ExpressionSink {
  const endpoint = String(url).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 3000;

  return async (event) => {
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!fetchImpl) throw new Error('当前运行环境没有 fetch，无法投递 HTTP 出口');
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
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 文件出口：追加 JSONL，任何本地进程都能 tail -f 跟着看 */
export function createFileSink(
  filePath: string,
  options: { logger?: Partial<Logger> } = {},
): ExpressionSink {
  return async (event) => {
    const line = `${JSON.stringify(event)}\n`;
    try {
      await appendFile(filePath, line, 'utf8');
    } catch (error) {
      // 目录不存在是首次运行的常态，补建后重试一次
      const code = (error as { code?: string }).code;
      if (code !== 'ENOENT') throw error;
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, line, 'utf8');
    }
  };
}

/**
 * 按配置组装出口。`vpet` 需要宿主的事件队列、`pet` 需要宿主自己的监听地址，
 * 都由调用方注入；未知 type 在配置归一化阶段已被剔除，这里再挡一次。
 */
export function buildExpressionSinks(
  sinks: ExpressionSinkConfig[],
  deps: {
    vpetSink?: ExpressionSink;
    logger?: Partial<Logger>;
    resolvePath?: (path: string) => string;
    /** pet 出口的缺省基地址（本机 webServer）；配置里写了 url 就以配置为准 */
    petBaseUrl?: string | null;
  } = {},
): ExpressionSink[] {
  const out: ExpressionSink[] = [];
  for (const item of sinks) {
    if (item.type === 'vpet') {
      if (deps.vpetSink) out.push(deps.vpetSink);
      continue;
    }
    if (item.type === 'pet') {
      const baseUrl = item.url?.trim() || deps.petBaseUrl || '';
      // 拿不到地址就跳过：宁可少一个出口，也不要让整条表达链在构造期抛错
      if (!baseUrl) {
        deps.logger?.warn?.('dsh-daughter: 桌宠出口缺少地址，已跳过', { pet: item.pet });
        continue;
      }
      out.push(
        createPetSink({
          baseUrl,
          petId: item.pet,
          route: item.route,
          timeoutMs: item.timeout_ms,
          durationMs: item.duration_ms,
        }),
      );
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
