import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { loadConfig, mergeConfig } from './config.js';
import { createDaughterPlugin } from './index.js';
import { normalizeBodySignal } from './runtime/body-link.js';
import { registerDesktopObserveTool } from './runtime/desktop-observe.js';
import { registerDesktopInputTool } from './runtime/desktop-input.js';
import { MoodMotionGate } from './runtime/mood-motion.js';
import { VpetBridgeState, type VpetEvent } from './runtime/vpet-events.js';
import { registerVpetControlTool } from './runtime/vpet-control.js';
import type {
  DaughterConfig,
  DaughterPlugin,
  EventRecord,
  L5State,
  PluginContext,
  PromptBlock,
  ToolInvoker,
} from './types.js';
import type { Logger, ToolGate } from './util.js';

/* -------------------------- 宿主（cordis）最小类型 -------------------------- */

interface HostMessageBlock {
  type?: string;
  text?: string;
}

interface HostMessage {
  id?: string;
  role?: string;
  content?: string | HostMessageBlock[];
  source?: { kind?: string; [key: string]: unknown };
}

interface HostSessionHeader {
  cwd?: string;
  parentSession?: string;
  origin?: string;
}

interface HostSession {
  id: string;
  header?: HostSessionHeader;
  events?: ReadonlyArray<HostEvent>;
}

interface HostEvent {
  type?: string;
  data?: {
    turn?: number;
    step?: number;
    message?: HostMessage;
    [key: string]: unknown;
  };
}

interface HostAgent {
  session?: HostSession;
}

interface HostPreStepPayload {
  agent?: HostAgent;
  messages?: HostMessage[];
  turn?: number;
  step?: number;
  signal?: { aborted?: boolean };
}

interface HostDecision {
  kind?: string;
  messages?: HostMessage[];
  [key: string]: unknown;
}

interface HostCtx {
  logger?: Partial<Logger>;
  get(name: string): unknown;
  on(name: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }): () => void;
  effect(fn: () => (() => void) | void, label?: string): () => void;
  emit?(name: string, payload: unknown): void;
  webServer?: {
    register(route: {
      kind: 'exact' | 'prefix';
      path: string;
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
  };
  /**
   * 宿主网络准入服务（可选注入）。返回 undefined 表示放行，否则是要回给请求方的状态码。
   * 星图这类会暴露记忆内容的接口必须先过它；拿不到服务或它抛错时一律拒绝，
   * 不能退化成"只看 Host / Origin / 环回地址"的判断。
   */
  connection?: {
    requestRejection(req: IncomingMessage): number | undefined;
  };
}

/** 取宿主准入结论：没服务、签名不对、抛错都按 403 处理。 */
function admissionRejection(ctx: HostCtx, req: IncomingMessage): number | undefined {
  let service = ctx.connection;
  if (!service || typeof service.requestRejection !== 'function') {
    try {
      const viaGet = ctx.get('connection') as { requestRejection?: unknown } | undefined;
      if (viaGet && typeof viaGet.requestRejection === 'function') {
        service = viaGet as { requestRejection(req: IncomingMessage): number | undefined };
      }
    } catch {
      service = undefined;
    }
  }
  if (!service || typeof service.requestRejection !== 'function') return 403;
  try {
    return service.requestRejection(req);
  } catch {
    return 403;
  }
}

/* ------------------------------ 常量与工具 ------------------------------ */

const CONTEXT_SOURCE = 'dsh-daughter';
const TICK_INTERVAL_MS = 30 * 60 * 1000;
const BRIDGE_PORT = Number(process.env.DSH_DAUGHTER_BRIDGE_PORT ?? 47612);
const EXTERNAL_SESSION_ID = 'vpet-bridge';

/** 桌宠事件队列：DSH 的思考/工具/回复/报错都入队，VPet MOD 按游标轮询并在处理后 ack */
const vpetState = new VpetBridgeState();
let lastMoodMotion: { band: string; graph: string; at: number } | null = null;

const MAX_BUBBLE_LINES = 3;
const MAX_BUBBLE_CHARS = 120;

function queueEvent(event: Omit<VpetEvent, 'seq'>): void {
  const text = typeof event.text === 'string' ? plainText(event.text) : '';
  if (text) event.text = text.length > MAX_BUBBLE_CHARS ? `${text.slice(0, MAX_BUBBLE_CHARS - 2)}…` : text;
  else delete event.text;
  vpetState.push(event);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** 桌宠气泡只渲染纯文本：去掉模型回复里可能带的 HTML 标签与实体，保留换行。 */
function plainText(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** 取回复的前几行（不按句号截断），让气泡能显示换行后的内容。 */
function bubbleText(text: string): string {
  const lines = plainText(text).split('\n');
  const picked: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (picked.length >= MAX_BUBBLE_LINES || used >= MAX_BUBBLE_CHARS) break;
    const rest = MAX_BUBBLE_CHARS - used;
    picked.push(line.length > rest ? `${line.slice(0, rest - 2)}…` : line);
    used += line.length;
  }
  return picked.join('\n');
}

const TOOL_LABELS: Record<string, string> = {
  read: '翻看文件…',
  write: '写文件…',
  edit: '改代码…',
  shell: '跑命令…',
  bash: '跑命令…',
  grep: '搜内容…',
  glob: '找文件…',
  websearch: '上网查资料…',
  web_search: '上网查资料…',
  webfetch: '打开网页…',
  web_fetch: '打开网页…',
  todo_write: '整理计划…',
  todo: '整理计划…',
  desktop_observe: '看看屏幕…',
  desktop_input: '动手试试…',
};

function toolLabel(name: string): string {
  const key = name.toLowerCase();
  return TOOL_LABELS[key] ?? `正在用 ${name}…`;
}

function messageText(message: HostMessage | undefined): string {
  if (!message || message.role !== 'user') return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function claimedUserText(messages: HostMessage[] | undefined): string {
  if (!messages || messages.length === 0) return '';
  const parts: string[] = [];
  for (const message of messages) {
    if (message?.source?.kind === 'runtime-context') continue;
    if (message?.source?.kind === 'agent-instructions') continue;
    const text = messageText(message).trim();
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

function assistantText(message: HostMessage | undefined): string {
  if (!message || message.role !== 'assistant') return '';
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function isToolResultError(message: HostMessage | undefined): boolean {
  if (!message) return false;
  if ((message as { isError?: unknown }).isError === true) return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block) => (block as { isError?: unknown })?.isError === true);
}

function renderBlocks(blocks: PromptBlock[]): string {
  return blocks
    .filter((block) => block.text.trim().length > 0)
    .map((block) => block.text.trim())
    .join('\n\n');
}

function hostLogger(ctx: HostCtx): Logger {
  const backing = ctx.logger;
  return {
    debug: (msg, meta) => backing?.debug?.(msg, meta),
    info: (msg, meta) => backing?.info?.(msg, meta),
    warn: (msg, meta) => backing?.warn?.(msg, meta),
    error: (msg, meta) => backing?.error?.(msg, meta),
  };
}

function toolInvoker(ctx: HostCtx): ToolInvoker {
  return {
    async invoke(tool: string, args: Record<string, unknown>): Promise<unknown> {
      const service = ctx.get('tools') as
        | { invoke?: (name: string, params: Record<string, unknown>) => Promise<unknown> }
        | undefined;
      if (!service || typeof service.invoke !== 'function') {
        throw new Error('tools service is unavailable');
      }
      return service.invoke(tool, args);
    },
  };
}

function isChildSession(session: HostSession): boolean {
  return session.header?.parentSession !== undefined || session.header?.origin === 'subagent';
}

/* --------------------------- 外部连接器桥接端点 --------------------------- */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

const EXTERNAL_SOURCES = new Set<EventRecord['source']>([
  'qq',
  'douyin_dm',
  'douyin_content',
  'minecraft',
  'game',
  'android',
  'system',
]);

/** 解析 `/connectors/<source>/ingest`，非法来源返回 null */
export function parseExternalIngestPath(url: string): EventRecord['source'] | null {
  const matched = /^\/connectors\/([a-z_]+)\/ingest$/.exec(url);
  if (!matched) return null;
  const source = matched[1] as EventRecord['source'];
  return EXTERNAL_SOURCES.has(source) ? source : null;
}

function startBridge(
  plugin: ReturnType<typeof createDaughterPlugin>,
  pluginContext: PluginContext,
  config: DaughterConfig,
  logger: Logger,
): { close: () => void } {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        const url = requestUrl.pathname.replace(/\/+$/, '') || '/';
        if (req.method === 'GET' && url === '/health') {
          const status = vpetState.status();
          sendJson(res, 200, {
            ok: true,
            character: config.character_id,
            vpet: {
              consumerOnline: status.consumer.online,
              bridgeOnline: status.bridge.online,
              pending: status.pending,
              dropped: status.dropped,
            },
          });
          return;
        }
        if (req.method === 'GET' && url === '/vpet/status') {
          sendJson(res, 200, { ok: true, character: config.character_id, ...vpetState.status() });
          return;
        }
        if (req.method === 'POST' && url === '/vpet/heartbeat') {
          const payload = (await readBody(req)) as Record<string, unknown>;
          const signal = normalizeBodySignal(payload, new Date().toISOString());
          vpetState.heartbeat({
            saveFound: payload.saveFound === true,
            saveFile: typeof payload.saveFile === 'string' ? payload.saveFile.slice(0, 512) : undefined,
            saveMtimeMs: typeof payload.saveMtimeMs === 'number' ? payload.saveMtimeMs : undefined,
            name: typeof payload.name === 'string' ? payload.name.slice(0, 64) : undefined,
            level: typeof payload.level === 'number' ? payload.level : undefined,
            mode: typeof payload.mode === 'string' ? payload.mode.slice(0, 32) : undefined,
            strengthPct: signal ? Math.round(signal.strength * 100) : undefined,
            feelingPct: signal ? Math.round(signal.feeling * 100) : undefined,
          });
          // 桌宠信号只抬升 L5 的疲劳/压力；旧版 bridge 不带这两个字段时什么也不会发生
          if (signal) {
            try {
              plugin.syncBodySignal({
                characterId: config.character_id,
                strength: signal.strength,
                feeling: signal.feeling,
                source: 'vpet',
              });
            } catch (error) {
              logger.warn('dsh-daughter: 生理信号处理失败', { error: String(error) });
            }
          }
          sendJson(res, 200, { ok: true, body: signal ? { strength: signal.strength, feeling: signal.feeling } : null });
          return;
        }
        if (req.method === 'POST' && url === '/vpet/consumer/report') {
          const payload = await readBody(req);
          const report = vpetState.reportConsumer(payload);
          if (!report) {
            sendJson(res, 400, { ok: false, error: 'state is required' });
            return;
          }
          logger.debug('dsh-daughter: MOD 状态上报', {
            version: report.version,
            busy: report.state.busy,
            reason: report.state.reason,
            playerActive: report.state.playerActive,
            queued: report.state.queued,
          });
          sendJson(res, 200, { ok: true, accepted: true, latestSeq: vpetState.status().latestSeq });
          return;
        }
        const externalSource = parseExternalIngestPath(url);
        if (req.method === 'POST' && externalSource) {
          const payload = (await readBody(req)) as { text?: unknown };
          const text = String(payload.text ?? '').trim();
          if (!text) {
            sendJson(res, 400, { ok: false, error: 'text is required' });
            return;
          }
          const { eventId } = await plugin.ingestExternalEvent({ ctx: pluginContext, text, source: externalSource });
          sendJson(res, 200, { ok: true, eventId, source: externalSource });
          return;
        }
        if (req.method === 'POST' && url === '/vpet/ingest') {
          const payload = (await readBody(req)) as { text?: unknown };
          const text = String(payload.text ?? '').trim();
          if (!text) {
            sendJson(res, 400, { ok: false, error: 'text is required' });
            return;
          }
          const { eventId } = await plugin.ingestExternalEvent({ ctx: pluginContext, text, source: 'game' });
          sendJson(res, 200, { ok: true, eventId });
          return;
        }
        if (req.method === 'POST' && url === '/vpet/control') {
          const payload = (await readBody(req)) as Record<string, unknown>;
          const action = String(payload.action ?? '');
          if (action === 'animate') {
            const graph = typeof payload.graph === 'string' ? payload.graph.trim().slice(0, 64) : '';
            if (!graph) {
              sendJson(res, 400, { ok: false, error: 'graph is required' });
              return;
            }
            const loops = clampNumber(payload.loops, 1, 0, 10);
            const text = typeof payload.text === 'string' ? payload.text : undefined;
            const supported = vpetState.supportedGraphs();
            if (supported && !supported.some((name) => name.toLowerCase() === graph.toLowerCase())) {
              sendJson(res, 400, { ok: false, error: `MOD 不支持该动画：${graph}`, graphs: supported });
              return;
            }
            queueEvent({ kind: 'motion', graph, loops, ...(text ? { text } : {}) });
            sendJson(res, 200, { ok: true, queued: 'motion', graph, loops });
            return;
          }
          if (action === 'move') {
            const dx = clampNumber(payload.dx, 0, -2000, 2000);
            const dy = clampNumber(payload.dy, 0, -2000, 2000);
            if (dx === 0 && dy === 0) {
              sendJson(res, 400, { ok: false, error: 'dx or dy is required' });
              return;
            }
            const durationMs = clampNumber(payload.durationMs, 600, 100, 5000);
            queueEvent({ kind: 'move', dx, dy, durationMs });
            sendJson(res, 200, { ok: true, queued: 'move', dx, dy, durationMs });
            return;
          }
          if (action === 'status') {
            sendJson(res, 200, { ok: true, ...vpetState.status(), mood: lastMoodMotion });
            return;
          }
          sendJson(res, 400, { ok: false, error: 'unknown action' });
          return;
        }
        if (req.method === 'GET' && url === '/vpet/events') {
          const raw = requestUrl.searchParams.get('since');
          const since = raw === null ? undefined : Number(raw);
          if (since !== undefined && !Number.isFinite(since)) {
            sendJson(res, 400, { ok: false, error: 'since must be a number' });
            return;
          }
          sendJson(res, 200, vpetState.read(since));
          return;
        }
        if (req.method === 'POST' && url === '/vpet/events/ack') {
          const payload = (await readBody(req)) as { seq?: unknown };
          const seq = Number(payload.seq);
          if (!Number.isFinite(seq) || seq < 0) {
            sendJson(res, 400, { ok: false, error: 'seq must be a non-negative number' });
            return;
          }
          sendJson(res, 200, { ok: true, trimmed: vpetState.ack(seq) });
          return;
        }
        if (req.method === 'GET' && url === '/vpet/say') {
          const text = vpetState.takeReply() ?? '';
          sendJson(res, 200, text ? { text } : {});
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        logger.warn('dsh-daughter: 桥接请求失败', { error: String(error) });
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    })();
  });

  server.on('error', (error) => logger.warn('dsh-daughter: 桥接端口监听失败', { port: BRIDGE_PORT, error: String(error) }));
  server.listen(BRIDGE_PORT, '127.0.0.1', () => logger.info('dsh-daughter: 桥接端点已就绪', { port: BRIDGE_PORT }));

  return { close: () => server.close() };
}

/* ------------------------------ 插件入口 ------------------------------ */

export function createHost(
  ctx: HostCtx,
  rawConfig: unknown,
  pluginRoot: string,
): ReturnType<typeof createDaughterPlugin> {
  const logger = hostLogger(ctx);
  const base = loadConfig(pluginRoot, logger);
  const config: DaughterConfig = mergeConfig(base, rawConfig);
  const plugin = createDaughterPlugin({
    pluginRoot,
    config,
    logger,
    onMotion: (motionId) => queueEvent({ kind: 'motion', motionId }),
  });
  const lastUserText = new Map<string, string>();
  const lastClaimedKey = new Map<string, string>();
  const lastThinkingKey = new Map<string, string>();
  const lastThinkingAt = new Map<string, number>();
  /** 每轮已注入过上下文的 (sessionId, turn)，保证单轮只注入一次 */
  const injectedTurns = new Set<string>();
  /** 每轮调用过的工具名，用于技能沉淀与成败判定 */
  const turnTools = new Map<string, { turn: number; tools: string[] }>();
  let lastToolName = '';
  let lastToolAt = 0;
  /** 最近一次安全性判定档位（角色级），供工具闸门使用 */
  let lastSafetyLevel = 0;
  const moodMotionGate = new MoodMotionGate();
  const tools = toolInvoker(ctx);

  /** §10.1：档位 ≥2 只放行只读工具，避免降级期间还能操作鼠标/窗口 */
  const toolGate: ToolGate = (intent) => {
    if (lastSafetyLevel < 2) return { allowed: true };
    if (intent === 'read') return { allowed: true };
    return { allowed: false, reason: `当前处于安全档位 L${lastSafetyLevel}` };
  };

  const recordToolCall = (sessionId: string, turn: number, name: string): void => {
    const current = turnTools.get(sessionId);
    if (!current || current.turn !== turn) {
      turnTools.set(sessionId, { turn, tools: [name] });
      return;
    }
    current.tools.push(name);
  };

  const takeTurnTools = (sessionId: string, turn: number): string[] => {
    const current = turnTools.get(sessionId);
    if (!current || current.turn !== turn) return [];
    turnTools.delete(sessionId);
    return current.tools;
  };

  const maybeQueueThinking = (session: HostSession, payload: HostPreStepPayload): void => {
    if (typeof payload.turn === 'number') {
      const key = `turn:${payload.turn}`;
      if (lastThinkingKey.get(session.id) === key) return;
      lastThinkingKey.set(session.id, key);
      queueEvent({ kind: 'thinking' });
      return;
    }
    const now = Date.now();
    if (now - (lastThinkingAt.get(session.id) ?? 0) < 4000) return;
    lastThinkingAt.set(session.id, now);
    queueEvent({ kind: 'thinking' });
  };

  const maybeQueueTool = (name: string): void => {
    const now = Date.now();
    if (name === lastToolName && now - lastToolAt < 1500) return;
    lastToolName = name;
    lastToolAt = now;
    queueEvent({ kind: 'tool', tool: name, text: toolLabel(name) });
  };

  const pluginContext = (session: HostSession, turn: number, sessionId = session.id): PluginContext => ({
    characterId: config.character_id,
    sessionId,
    workspaceId: session.header?.cwd ?? pluginRoot,
    turnId: String(turn),
    now: () => new Date().toISOString(),
    logger,
    tools,
    emit: (event, payload) => ctx.emit?.(event, payload),
  });

  const onPreStep = async (payload: HostPreStepPayload, next: () => Promise<HostDecision>): Promise<HostDecision> => {
    const session = payload.agent?.session;
    const eligible = session !== undefined && !isChildSession(session);
    const turn = payload.turn ?? 0;
    const step = payload.step ?? 1;
    const userText = claimedUserText(payload.messages);

    // 反射先行：命中即短路，本轮不发起模型调用（G4）。只在首步判定新的用户输入。
    let l5: L5State | null = null;
    if (eligible && session && userText) {
      const claimedKey = `${turn}::${(payload.messages ?? []).map((message) => message.id ?? '').join(',') || userText}`;
      if (lastClaimedKey.get(session.id) !== claimedKey) {
        lastClaimedKey.set(session.id, claimedKey);
        lastUserText.set(session.id, userText);
        try {
          const outcome = await plugin.onUserMessage({
            ctx: pluginContext(session, turn),
            text: userText,
            source: 'chat',
          });
          l5 = outcome.l5;
          lastSafetyLevel = outcome.verdict.level;
          // PAD 情绪动作：只在情绪带变化或间隔足够久时下发，平时保持桌宠自主活动；
          // MOD 报忙或玩家正在交互时这轮先不下发，也不消耗节流窗口。
          const playerBusy = vpetState.playerActive();
          const moodMotion = playerBusy ? null : moodMotionGate.next(l5, Date.now());
          if (moodMotion) {
            queueEvent({ kind: 'motion', graph: moodMotion.graph, loops: moodMotion.loops });
            lastMoodMotion = { band: moodMotion.band, graph: moodMotion.graph, at: Date.now() };
            logger.debug('dsh-daughter: 情绪动作', {
              band: moodMotion.band,
              graph: moodMotion.graph,
              reason: moodMotion.reason,
            });
          }
        } catch (error) {
          logger.warn('dsh-daughter: 用户消息处理失败', { sessionId: session.id, error: String(error) });
        }
      }
    }

    if (eligible && session && l5 && step === 1) {
      const outcome = await applyReflex(
        plugin,
        pluginContext(session, turn),
        userText,
        l5,
        logger,
        config.reflex.short_circuit,
      );
      if (outcome === 'short-circuit') return { kind: 'reject' };
    }

    if (session && eligible) maybeQueueThinking(session, payload);

    const decision = await next();
    if (decision.kind === 'reject' || payload.signal?.aborted) return decision;

    if (!session || !eligible) return decision;

    // 单轮只注入一次：后续 step 的历史里仍带着第一次的上下文块，重复插入只会放大 token
    const injectKey = `${session.id}:${turn}`;
    if (injectedTurns.has(injectKey)) return decision;

    const pc = pluginContext(session, turn);

    let blocks: PromptBlock[] = [];
    try {
      const result = await plugin.beforePromptBuild({ ctx: pc, tokenBudget: config.budget.max_total_tokens });
      blocks = result.blocks;
    } catch (error) {
      logger.warn('dsh-daughter: 提示块构建失败', { sessionId: session.id, error: String(error) });
    }

    const text = renderBlocks(blocks);
    if (!text) return decision;

    const contextMessage: HostMessage = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: CONTEXT_SOURCE },
    };

    const claimed = payload.messages ?? [];
    const lastClaimedIndex = (decision.messages ?? []).findLastIndex((message) => claimed.includes(message));
    const messages = (decision.messages ?? []).toSpliced(lastClaimedIndex + 1, 0, contextMessage);
    injectedTurns.add(injectKey);
    if (injectedTurns.size > 512) {
      const oldest = injectedTurns.values().next();
      if (!oldest.done) injectedTurns.delete(oldest.value);
    }
    return { ...decision, messages };
  };

  const onSessionEvent = (session: HostSession, event: HostEvent): Promise<void> | void => {
    if (!session || isChildSession(session)) return;

    const data = event?.data as
      | { name?: unknown; message?: HostMessage; error?: unknown; turn?: number; [key: string]: unknown }
      | undefined;

    if (event?.type === 'tool/call') {
      if (typeof data?.name === 'string' && data.name.trim()) {
        const name = data.name.trim();
        maybeQueueTool(name);
        recordToolCall(session.id, data?.turn ?? 0, name);
      }
      return;
    }

    if (event?.type === 'tool/result') {
      if (isToolResultError(data?.message)) {
        queueEvent({ kind: 'error', text: '刚才有个工具报错了…' });
      }
      return;
    }

    if (event?.type === 'turn/end' && data?.error) {
      queueEvent({ kind: 'error', text: '这一轮出了点问题…' });
      return;
    }

    if (event?.type !== 'assistant/message') return;

    const message = data?.message;
    if (!message || message.source?.kind !== 'model') return;
    const text = assistantText(message);
    if (!text) return;

    const userText = lastUserText.get(session.id) ?? '';
    const pc = pluginContext(session, data?.turn ?? 0);
    const toolsUsed = takeTurnTools(session.id, data?.turn ?? 0);
    return plugin
      .afterResponse({ ctx: pc, userText, assistantText: text, toolsUsed })
      .then(() => {
        queueEvent({ kind: 'reply', text: bubbleText(text) });
      })
      .catch((error) => {
        logger.warn('dsh-daughter: 回复后处理失败', { sessionId: session.id, error: String(error) });
        queueEvent({ kind: 'error', text: '刚才走神了一下…' });
      });
  };

  const offPreStep = ctx.on('agent/pre-step', onPreStep);
  const offSession = ctx.on('session/event', onSessionEvent as (...args: unknown[]) => unknown);

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setInterval(() => {
        plugin
          .tick({ characterId: config.character_id, now: new Date().toISOString() })
          .catch((error) => logger.warn('dsh-daughter: 定时维护失败', { error: String(error) }));
      }, TICK_INTERVAL_MS);
      if (typeof (timer as { unref?: () => void }).unref === 'function') timer.unref();

      const offStarMap = registerStarMapPanel(ctx, plugin, pluginRoot, config.character_id, logger);

      const bridge = startBridge(plugin, pluginContext({ id: EXTERNAL_SESSION_ID }, 0), config, logger);
      const offVpetControl = registerVpetControlTool(ctx, { logger, guard: toolGate });
      const offDesktopObserve =
        config.desktop?.enabled === false
          ? () => {}
          : registerDesktopObserveTool(ctx, {
              bridgeUrl: config.desktop?.bridge_url,
              logger,
              guard: toolGate,
            });
      const offDesktopInput =
        config.desktop?.enabled === false
          ? () => {}
          : registerDesktopInputTool(ctx, {
              bridgeUrl: config.desktop?.bridge_url,
              logger,
              guard: toolGate,
            });

      return () => {
        clearInterval(timer);
        offStarMap();
        offVpetControl();
        offDesktopObserve();
        offDesktopInput();
        bridge.close();
        offPreStep();
        offSession();
        plugin.close();
      };
    }, 'dsh-daughter.lifecycle');
  }

  return plugin;
}

/** 星图正式入口：/star-map 页面、/star-map/api 数据、/star-map/metrics 指标 */
function registerStarMapPanel(
  ctx: HostCtx,
  plugin: DaughterPlugin,
  pluginRoot: string,
  characterId: string,
  logger: Logger,
): () => void {
  // webServer 由 index.js 以可选注入声明；宿主没有这个服务就跳过
  const server = ctx.webServer;
  if (!server || typeof server.register !== 'function') {
    logger.warn('dsh-daughter: 无 webServer 服务，跳过星图面板');
    return () => {};
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    // 星图接口会吐出记忆与情绪数据，先过宿主准入（Host/Origin fence + 登录令牌）
    const rejection = admissionRejection(ctx, req);
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://dsh.local');
    if (url.pathname.replace(/\/+$/, '') === '/star-map/api') {
      try {
        const counts = plugin.starMap(characterId, new Date().toISOString());
        const body = readFileSync(join(pluginRoot, 'star_map', `${characterId}.json`), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
        logger.debug('star_map_served', counts);
      } catch (error) {
        sendJson(res, 500, { error: String(error) });
      }
      return;
    }
    if (url.pathname.replace(/\/+$/, '') === '/star-map/metrics') {
      try {
        sendJson(res, 200, { characterId, ...plugin.metrics(characterId) });
      } catch (error) {
        sendJson(res, 500, { error: String(error) });
      }
      return;
    }
    try {
      const html = readFileSync(join(pluginRoot, 'web', 'star-map', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } catch (error) {
      sendJson(res, 404, { error: `星图页面缺失：${String(error)}` });
    }
  };

  try {
    const dispose = ctx.effect(
      () => server.register({ kind: 'prefix', path: '/star-map', handler }),
      'dsh-daughter:star-map',
    );
    logger.info('dsh-daughter: 星图面板已挂载 /star-map');
    return dispose;
  } catch (error) {
    logger.warn('dsh-daughter: 星图面板注册失败', { error: String(error) });
    return () => {};
  }
}

async function applyReflex(
  plugin: ReturnType<typeof createDaughterPlugin>,
  ctx: PluginContext,
  userText: string,
  l5: L5State,
  logger: Logger,
  shortCircuit: boolean,
): Promise<'short-circuit' | 'continue' | null> {
  let matched: Awaited<ReturnType<typeof plugin.reflexMatch>>;
  try {
    matched = await plugin.reflexMatch({ ctx, userText, l5 });
  } catch (error) {
    logger.warn('dsh-daughter: 反射匹配失败', { error: String(error) });
    return null;
  }
  if (!matched) return null;

  logger.debug('dsh-daughter: 反射命中', { ruleId: matched.ruleId, action: matched.action.kind, shortCircuit });

  switch (matched.action.kind) {
    case 'template_reply':
      // 短路关闭时交给模型回复，避免同一条消息既弹固定文案又弹模型回复
      if (!shortCircuit) return 'continue';
      queueEvent({ kind: 'reply', text: matched.action.text });
      await plugin.afterResponse({ ctx, userText, assistantText: matched.action.text }).catch((error) => {
        logger.warn('dsh-daughter: 反射后处理失败', { ruleId: matched.ruleId, error: String(error) });
      });
      return 'short-circuit';
    case 'motion':
      // motionPlay 由 reflexMatch 内部发出，短路时本轮同样不进入模型
      return shortCircuit ? 'short-circuit' : 'continue';
    case 'tool_call': {
      const { tool, argsTemplate } = matched.action;
      queueEvent({ kind: 'tool', tool, text: toolLabel(tool) });
      await ctx.tools.invoke(tool, argsTemplate).catch((error) => {
        logger.warn('dsh-daughter: 反射工具调用失败', { tool, error: String(error) });
      });
      return 'continue';
    }
    default:
      return 'continue';
  }
}
