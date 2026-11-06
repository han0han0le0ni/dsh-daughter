import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { loadConfig, mergeConfig } from './config.js';
import { createDaughterPlugin } from './index.js';
import { normalizeBodySignal } from './runtime/body-link.js';
import { registerDesktopObserveTool } from './runtime/desktop-observe.js';
import { registerDesktopInputTool } from './runtime/desktop-input.js';
import { MoodMotionGate } from './runtime/mood-motion.js';
import { VpetBridgeState } from './runtime/vpet-events.js';
import { buildExpressionSinks, dispatchExpression } from './runtime/expression.js';
import { readDouyinMemory, renderDouyinEventText, resolveDouyinDbPath } from './runtime/douyin-link.js';
import { PET_MOOD_ANIM, createPetAnimSink, createPetSink, petBaseUrlOf, petWorkAnimFor, probePet } from './runtime/pet-link.js';
import { registerVpetControlTool } from './runtime/vpet-control.js';
/** 取宿主准入结论：没服务、签名不对、抛错都按 403 处理。 */
function admissionRejection(ctx, req) {
    let service = ctx.connection;
    if (!service || typeof service.requestRejection !== 'function') {
        try {
            const viaGet = ctx.get('connection');
            if (viaGet && typeof viaGet.requestRejection === 'function') {
                service = viaGet;
            }
        }
        catch {
            service = undefined;
        }
    }
    if (!service || typeof service.requestRejection !== 'function')
        return 403;
    try {
        return service.requestRejection(req);
    }
    catch {
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
let lastMoodMotion = null;
/**
 * dsh-pet 工作动作转发器：宿主在 dsh-pet 接管后设置，queueEvent 里顺手调一下。
 * 模块级共享是为了让所有事件产生点（thinking/tool/reply/error）走同一个汇聚口，
 * 不必在每个调用点重复判断"是不是该投给桌宠插件"。
 */
let petWorkForward = null;
const MAX_BUBBLE_LINES = 3;
const MAX_BUBBLE_CHARS = 120;
/**
 * 桌宠出口：沿用原来的事件队列，文本进气泡。
 * 出口本身由 `config.expression.sinks` 决定，这里只是其中一种实现。
 */
const vpetExpressionSink = (event) => {
    if (event.text)
        queueEvent({ kind: 'reply', text: event.text });
};
function queueEvent(event) {
    const text = typeof event.text === 'string' ? plainText(event.text) : '';
    if (text)
        event.text = text.length > MAX_BUBBLE_CHARS ? `${text.slice(0, MAX_BUBBLE_CHARS - 2)}…` : text;
    else
        delete event.text;
    // dsh-pet 接管时，把 thinking/tool/reply/error 也点播成它的工作状态动画；
    // 仍照写 VPet 队列（无消费者时不产生任何副作用，不影响既有桥接）。
    const kind = String(event.kind ?? '');
    if (kind && petWorkForward)
        petWorkForward(kind);
    vpetState.push(event);
}
function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number))
        return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
}
/** 桌宠气泡只渲染纯文本：去掉模型回复里可能带的 HTML 标签与实体，保留换行。 */
function plainText(text) {
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
function bubbleText(text) {
    const lines = plainText(text).split('\n');
    const picked = [];
    let used = 0;
    for (const line of lines) {
        if (picked.length >= MAX_BUBBLE_LINES || used >= MAX_BUBBLE_CHARS)
            break;
        const rest = MAX_BUBBLE_CHARS - used;
        picked.push(line.length > rest ? `${line.slice(0, rest - 2)}…` : line);
        used += line.length;
    }
    return picked.join('\n');
}
const TOOL_LABELS = {
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
function toolLabel(name) {
    const key = name.toLowerCase();
    return TOOL_LABELS[key] ?? `正在用 ${name}…`;
}
function messageText(message) {
    if (!message || message.role !== 'user')
        return '';
    if (typeof message.content === 'string')
        return message.content;
    if (!Array.isArray(message.content))
        return '';
    return message.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
}
function claimedUserText(messages) {
    if (!messages || messages.length === 0)
        return '';
    const parts = [];
    for (const message of messages) {
        if (message?.source?.kind === 'runtime-context')
            continue;
        if (message?.source?.kind === 'agent-instructions')
            continue;
        const text = messageText(message).trim();
        if (text)
            parts.push(text);
    }
    return parts.join('\n');
}
function assistantText(message) {
    if (!message || message.role !== 'assistant')
        return '';
    if (!Array.isArray(message.content))
        return '';
    return message.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
}
function isToolResultError(message) {
    if (!message)
        return false;
    if (message.isError === true)
        return true;
    if (!Array.isArray(message.content))
        return false;
    return message.content.some((block) => block?.isError === true);
}
function renderBlocks(blocks) {
    return blocks
        .filter((block) => block.text.trim().length > 0)
        .map((block) => block.text.trim())
        .join('\n\n');
}
/**
 * 取宿主实际监听的端口。`get` 在服务缺失时会抛，这里一律按"拿不到"处理——
 * 端口只用于拼 dsh-pet 的地址，缺了最多少一个出口，不该连累插件装载。
 */
function resolveWebServerPort(ctx) {
    const direct = Number(ctx.webServer?.port);
    if (Number.isFinite(direct) && direct > 0)
        return direct;
    try {
        const service = ctx.get('webServer');
        const port = Number(service?.port);
        return Number.isFinite(port) && port > 0 ? port : undefined;
    }
    catch {
        return undefined;
    }
}
function hostLogger(ctx) {
    const backing = ctx.logger;
    return {
        debug: (msg, meta) => backing?.debug?.(msg, meta),
        info: (msg, meta) => backing?.info?.(msg, meta),
        warn: (msg, meta) => backing?.warn?.(msg, meta),
        error: (msg, meta) => backing?.error?.(msg, meta),
    };
}
function toolInvoker(ctx) {
    return {
        async invoke(tool, args) {
            const service = ctx.get('tools');
            if (!service || typeof service.invoke !== 'function') {
                throw new Error('tools service is unavailable');
            }
            return service.invoke(tool, args);
        },
    };
}
function isChildSession(session) {
    return session.header?.parentSession !== undefined || session.header?.origin === 'subagent';
}
/* --------------------------- 外部连接器桥接端点 --------------------------- */
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
async function readBody(req) {
    let raw = '';
    for await (const chunk of req)
        raw += chunk;
    if (!raw.trim())
        return {};
    return JSON.parse(raw);
}
const EXTERNAL_SOURCES = new Set([
    'qq',
    'douyin_dm',
    'douyin_content',
    'minecraft',
    'game',
    'android',
    'system',
]);
/** 解析 `/connectors/<source>/ingest`，非法来源返回 null */
export function parseExternalIngestPath(url) {
    const matched = /^\/connectors\/([a-z_]+)\/ingest$/.exec(url);
    if (!matched)
        return null;
    const source = matched[1];
    return EXTERNAL_SOURCES.has(source) ? source : null;
}
function startBridge(plugin, pluginContext, config, logger) {
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
                    const payload = (await readBody(req));
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
                        }
                        catch (error) {
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
                    const payload = (await readBody(req));
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
                    const payload = (await readBody(req));
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
                    const payload = (await readBody(req));
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
                    const payload = (await readBody(req));
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
            }
            catch (error) {
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
export function createHost(ctx, rawConfig, pluginRoot) {
    const logger = hostLogger(ctx);
    const base = loadConfig(pluginRoot, logger);
    const config = mergeConfig(base, rawConfig);
    // dsh-pet 挂在宿主自己的 webServer 上，端口只有宿主知道——从服务里取，别让用户抄端口
    const petBaseUrl = petBaseUrlOf(resolveWebServerPort(ctx));
    const petConfig = config.expression.sinks.find((item) => item.type === 'pet');
    // 表达出口：DSH 内置桌宠 / 游戏桌宠 / HTTP 应用 / JSONL 文件，可同时开，任一挂掉不影响其它
    const expressionSinks = config.expression.enabled
        ? buildExpressionSinks(config.expression.sinks, {
            vpetSink: vpetExpressionSink,
            logger,
            resolvePath: (path) => (isAbsolute(path) ? path : join(pluginRoot, path)),
            petBaseUrl,
        })
        : [];
    // 动作出口与说话出口共用同一只宠物、同一个基地址与同一个路由段，避免各投各的；
    // 配置里写了 url 就以它为准（反代 / 远程桌面壳），否则用本机端口
    const petEndpointBase = petConfig?.url?.trim() || petBaseUrl || null;
    const petAnimSink = petEndpointBase
        ? createPetAnimSink({ baseUrl: petEndpointBase, petId: petConfig?.pet, route: petConfig?.route })
        : null;
    /** dsh-pet 是否在接她的表达：配了可用的 pet 出口，或启动探测后由它接管 */
    let petTakesOver = petConfig !== undefined && petAnimSink !== null;
    // 工作动作转发器：dsh-pet 接管后，把 thinking/tool/reply/error 点播成它的 workStatus 动画。
    // 显式配了 pet 出口时 createHost 阶段就挂上；让位（探测接管）成功后再补挂一次。
    const syncPetWorkForward = () => {
        if (petTakesOver && petAnimSink) {
            petWorkForward = (kind) => {
                const anim = petWorkAnimFor(kind);
                if (!anim)
                    return;
                petAnimSink(anim).catch((error) => {
                    logger.warn('dsh-daughter: 桌宠工作动作点播失败', { anim, kind, error: String(error) });
                });
            };
        }
        else {
            petWorkForward = null;
        }
    };
    syncPetWorkForward();
    const plugin = createDaughterPlugin({
        pluginRoot,
        config,
        logger,
        onMotion: (motionId) => queueEvent({ kind: 'motion', motionId }),
    });
    const lastUserText = new Map();
    const lastClaimedKey = new Map();
    const lastThinkingKey = new Map();
    const lastThinkingAt = new Map();
    /** 每轮已注入过上下文的 (sessionId, turn)，保证单轮只注入一次 */
    const injectedTurns = new Set();
    /** 每轮调用过的工具名，用于技能沉淀与成败判定 */
    const turnTools = new Map();
    let lastToolName = '';
    let lastToolAt = 0;
    /** 最近一次安全性判定档位（角色级），供工具闸门使用 */
    let lastSafetyLevel = 0;
    const moodMotionGate = new MoodMotionGate();
    const tools = toolInvoker(ctx);
    /** §10.1：档位 ≥2 只放行只读工具，避免降级期间还能操作鼠标/窗口 */
    const toolGate = (intent) => {
        if (lastSafetyLevel < 2)
            return { allowed: true };
        if (intent === 'read')
            return { allowed: true };
        return { allowed: false, reason: `当前处于安全档位 L${lastSafetyLevel}` };
    };
    const recordToolCall = (sessionId, turn, name) => {
        const current = turnTools.get(sessionId);
        if (!current || current.turn !== turn) {
            turnTools.set(sessionId, { turn, tools: [name] });
            return;
        }
        current.tools.push(name);
    };
    const takeTurnTools = (sessionId, turn) => {
        const current = turnTools.get(sessionId);
        if (!current || current.turn !== turn)
            return [];
        turnTools.delete(sessionId);
        return current.tools;
    };
    const maybeQueueThinking = (session, payload) => {
        if (typeof payload.turn === 'number') {
            const key = `turn:${payload.turn}`;
            if (lastThinkingKey.get(session.id) === key)
                return;
            lastThinkingKey.set(session.id, key);
            queueEvent({ kind: 'thinking' });
            return;
        }
        const now = Date.now();
        if (now - (lastThinkingAt.get(session.id) ?? 0) < 4000)
            return;
        lastThinkingAt.set(session.id, now);
        queueEvent({ kind: 'thinking' });
    };
    const maybeQueueTool = (name) => {
        const now = Date.now();
        if (name === lastToolName && now - lastToolAt < 1500)
            return;
        lastToolName = name;
        lastToolAt = now;
        queueEvent({ kind: 'tool', tool: name, text: toolLabel(name) });
    };
    const pluginContext = (session, turn, sessionId = session.id) => ({
        characterId: config.character_id,
        sessionId,
        workspaceId: session.header?.cwd ?? pluginRoot,
        turnId: String(turn),
        now: () => new Date().toISOString(),
        logger,
        tools,
        emit: (event, payload) => ctx.emit?.(event, payload),
    });
    const onPreStep = async (payload, next) => {
        const session = payload.agent?.session;
        const eligible = session !== undefined && !isChildSession(session);
        const turn = payload.turn ?? 0;
        const step = payload.step ?? 1;
        const userText = claimedUserText(payload.messages);
        // 反射先行：命中即短路，本轮不发起模型调用（G4）。只在首步判定新的用户输入。
        let l5 = null;
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
                        // 两个桌宠的动作词汇表不通用：VPet 认 GraphType（Say/Touch_Head/Sleep），
                        // dsh-pet 认自己素材里的动画名，所以按接管方选一套，不混着发。
                        const anim = PET_MOOD_ANIM[moodMotion.band];
                        if (petTakesOver && petAnimSink) {
                            petAnimSink(anim).catch((error) => {
                                logger.warn('dsh-daughter: 桌宠动作点播失败', { anim, error: String(error) });
                            });
                        }
                        else {
                            queueEvent({ kind: 'motion', graph: moodMotion.graph, loops: moodMotion.loops });
                        }
                        lastMoodMotion = {
                            band: moodMotion.band,
                            graph: petTakesOver ? anim : moodMotion.graph,
                            at: Date.now(),
                        };
                        logger.debug('dsh-daughter: 情绪动作', {
                            band: moodMotion.band,
                            graph: lastMoodMotion.graph,
                            reason: moodMotion.reason,
                        });
                    }
                }
                catch (error) {
                    logger.warn('dsh-daughter: 用户消息处理失败', { sessionId: session.id, error: String(error) });
                }
            }
        }
        if (eligible && session && l5 && step === 1) {
            const outcome = await applyReflex(plugin, pluginContext(session, turn), userText, l5, logger, config.reflex.short_circuit);
            if (outcome === 'short-circuit')
                return { kind: 'reject' };
        }
        if (session && eligible)
            maybeQueueThinking(session, payload);
        const decision = await next();
        if (decision.kind === 'reject' || payload.signal?.aborted)
            return decision;
        if (!session || !eligible)
            return decision;
        // 单轮只注入一次：后续 step 的历史里仍带着第一次的上下文块，重复插入只会放大 token
        const injectKey = `${session.id}:${turn}`;
        if (injectedTurns.has(injectKey))
            return decision;
        const pc = pluginContext(session, turn);
        let blocks = [];
        try {
            const result = await plugin.beforePromptBuild({ ctx: pc, tokenBudget: config.budget.max_total_tokens });
            blocks = result.blocks;
        }
        catch (error) {
            logger.warn('dsh-daughter: 提示块构建失败', { sessionId: session.id, error: String(error) });
        }
        const text = renderBlocks(blocks);
        if (!text)
            return decision;
        const contextMessage = {
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
            if (!oldest.done)
                injectedTurns.delete(oldest.value);
        }
        return { ...decision, messages };
    };
    const onSessionEvent = (session, event) => {
        if (!session || isChildSession(session))
            return;
        const data = event?.data;
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
        if (event?.type !== 'assistant/message')
            return;
        const message = data?.message;
        if (!message || message.source?.kind !== 'model')
            return;
        const text = assistantText(message);
        if (!text)
            return;
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
    const offSession = ctx.on('session/event', onSessionEvent);
    if (typeof ctx.effect === 'function') {
        ctx.effect(() => {
            // 出厂配置只有 vpet：探一下 dsh-pet 在不在，在就让它接管出口。这就是「让位」——
            // 两套桌宠同时开只会把同一句话各弹一遍，而 VPet 卸掉之后 vpet 出口根本没人消费。
            // 探测异步、失败即忽略，不阻塞插件装载；用户显式配了 vpet 或关掉 prefer_pet 时不动。
            const factoryVpetOnly = config.expression.sinks.length === 1 && config.expression.sinks[0]?.type === 'vpet';
            if (config.expression.enabled && config.expression.prefer_pet && petBaseUrl && factoryVpetOnly) {
                // 插件加载顺序不保证：dsh-pet 可能比我们晚一步注册路由，所以失败再试两次，
                // 总共约 5 秒内结案。之后就当它不在，不长期空转探测。
                const attempt = (left) => {
                    void probePet({ baseUrl: petBaseUrl, petId: petConfig?.pet, route: petConfig?.route, timeoutMs: 1200 })
                        .then((alive) => {
                        if (alive) {
                            expressionSinks.length = 0;
                            expressionSinks.push(createPetSink({ baseUrl: petBaseUrl, petId: petConfig?.pet, route: petConfig?.route }));
                            petTakesOver = true;
                            syncPetWorkForward();
                            logger.info('dsh-daughter: 检测到 dsh-pet，表达出口已交给它', { baseUrl: petBaseUrl });
                            return;
                        }
                        if (left <= 0)
                            return;
                        const retry = setTimeout(() => attempt(left - 1), 2000);
                        if (typeof retry.unref === 'function')
                            retry.unref();
                    })
                        .catch((error) => logger.debug('dsh-daughter: 桌宠探测失败', { error: String(error) }));
                };
                attempt(2);
            }
            // 抖音联动：只读它的共享记忆库，把新刷到的内容写成她的事件。
            // 游标只在内存里推进；首次启动或长时间关机后从"最近一天"重新对齐，
            // 免得把一周前刷的视频当成"刚看到的"。
            let douyinCursor = 0;
            const douyinEnabled = config.douyin.enabled;
            const douyinDb = resolveDouyinDbPath(config.douyin.memory_db);
            const pullDouyin = async () => {
                const nowMs = Date.now();
                if (douyinCursor === 0 || nowMs - douyinCursor > 24 * 60 * 60 * 1000) {
                    douyinCursor = nowMs - 24 * 60 * 60 * 1000;
                }
                const result = await readDouyinMemory({
                    dbPath: douyinDb,
                    sinceMs: douyinCursor,
                    limit: config.douyin.max_items,
                });
                if (!result.ok) {
                    // 没装抖音插件 / 库还没建 / 运行环境没有 sqlite，都走这里，只留一条 debug
                    logger.debug('dsh-daughter: 抖音记忆读取失败', { reason: result.reason });
                    return;
                }
                if (result.items.length === 0)
                    return;
                const pc = pluginContext({ id: EXTERNAL_SESSION_ID }, 0);
                for (const item of result.items) {
                    douyinCursor = Math.max(douyinCursor, item.updatedAt);
                    const text = renderDouyinEventText(item);
                    if (!text)
                        continue;
                    try {
                        await plugin.ingestExternalEvent({ ctx: pc, text, source: 'douyin_content' });
                    }
                    catch (error) {
                        logger.warn('dsh-daughter: 抖音内容入库失败', { error: String(error) });
                    }
                }
                logger.debug('dsh-daughter: 抖音内容已入库', { count: result.items.length });
            };
            const douyinTimer = douyinEnabled
                ? setInterval(() => void pullDouyin(), Math.max(60_000, config.douyin.poll_interval_min * 60_000))
                : null;
            if (douyinTimer && typeof douyinTimer.unref === 'function')
                douyinTimer.unref();
            // 启动 20 秒后先拉一次：刚开机时主人往往正在刷
            const douyinKick = douyinEnabled ? setTimeout(() => void pullDouyin(), 20_000) : null;
            if (douyinKick && typeof douyinKick.unref === 'function')
                douyinKick.unref();
            const timer = setInterval(() => {
                plugin
                    .tick({ characterId: config.character_id, now: new Date().toISOString() })
                    .catch((error) => logger.warn('dsh-daughter: 定时维护失败', { error: String(error) }));
            }, TICK_INTERVAL_MS);
            if (typeof timer.unref === 'function')
                timer.unref();
            // 主动开口用独立节拍：维护半小时一次够用，但"她什么时候开口"需要更细的粒度。
            // 关闭时不注册定时器——关掉的功能不该留一个空转的 timer。
            const speakTimer = config.speak.enabled
                ? setInterval(() => {
                    const now = new Date().toISOString();
                    plugin
                        .speakPlan({ characterId: config.character_id, now, jitter: Math.random() * 2 - 1 })
                        .then(async (plan) => {
                        // hold 是她"想说但忍住了"，只留在存储里累积压力，不打扰任何人
                        if (!plan || plan.decision !== 'act' || !plan.text)
                            return;
                        const result = await dispatchExpression({
                            kind: 'speak',
                            characterId: config.character_id,
                            at: now,
                            text: plan.text,
                            reason: plan.reason,
                            intensity: Number(plan.urge.toFixed(3)),
                        }, expressionSinks);
                        if (result.failed > 0) {
                            logger.warn('dsh-daughter: 表达投递部分失败', {
                                failed: result.failed,
                                delivered: result.delivered,
                                errors: result.errors,
                            });
                        }
                    })
                        .catch((error) => logger.warn('dsh-daughter: 主动开口评估失败', { error: String(error) }));
                }, Math.max(60_000, config.speak.check_interval_min * 60_000))
                : null;
            if (speakTimer && typeof speakTimer.unref === 'function')
                speakTimer.unref();
            const offStarMap = registerStarMapPanel(ctx, plugin, pluginRoot, config.character_id, logger);
            const bridge = startBridge(plugin, pluginContext({ id: EXTERNAL_SESSION_ID }, 0), config, logger);
            const offVpetControl = registerVpetControlTool(ctx, { logger, guard: toolGate });
            const offDesktopObserve = config.desktop?.enabled === false
                ? () => { }
                : registerDesktopObserveTool(ctx, {
                    bridgeUrl: config.desktop?.bridge_url,
                    logger,
                    guard: toolGate,
                });
            const offDesktopInput = config.desktop?.enabled === false
                ? () => { }
                : registerDesktopInputTool(ctx, {
                    bridgeUrl: config.desktop?.bridge_url,
                    logger,
                    guard: toolGate,
                });
            return () => {
                clearInterval(timer);
                if (speakTimer)
                    clearInterval(speakTimer);
                if (douyinTimer)
                    clearInterval(douyinTimer);
                if (douyinKick)
                    clearTimeout(douyinKick);
                petWorkForward = null;
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
function registerStarMapPanel(ctx, plugin, pluginRoot, characterId, logger) {
    // webServer 由 index.js 以可选注入声明；宿主没有这个服务就跳过
    const server = ctx.webServer;
    if (!server || typeof server.register !== 'function') {
        logger.warn('dsh-daughter: 无 webServer 服务，跳过星图面板');
        return () => { };
    }
    const handler = (req, res) => {
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
            }
            catch (error) {
                sendJson(res, 500, { error: String(error) });
            }
            return;
        }
        if (url.pathname.replace(/\/+$/, '') === '/star-map/metrics') {
            try {
                sendJson(res, 200, { characterId, ...plugin.metrics(characterId) });
            }
            catch (error) {
                sendJson(res, 500, { error: String(error) });
            }
            return;
        }
        try {
            const html = readFileSync(join(pluginRoot, 'web', 'star-map', 'index.html'), 'utf8');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(html);
        }
        catch (error) {
            sendJson(res, 404, { error: `星图页面缺失：${String(error)}` });
        }
    };
    try {
        const dispose = ctx.effect(() => server.register({ kind: 'prefix', path: '/star-map', handler }), 'dsh-daughter:star-map');
        logger.info('dsh-daughter: 星图面板已挂载 /star-map');
        return dispose;
    }
    catch (error) {
        logger.warn('dsh-daughter: 星图面板注册失败', { error: String(error) });
        return () => { };
    }
}
async function applyReflex(plugin, ctx, userText, l5, logger, shortCircuit) {
    let matched;
    try {
        matched = await plugin.reflexMatch({ ctx, userText, l5 });
    }
    catch (error) {
        logger.warn('dsh-daughter: 反射匹配失败', { error: String(error) });
        return null;
    }
    if (!matched)
        return null;
    logger.debug('dsh-daughter: 反射命中', { ruleId: matched.ruleId, action: matched.action.kind, shortCircuit });
    switch (matched.action.kind) {
        case 'template_reply':
            // 短路关闭时交给模型回复，避免同一条消息既弹固定文案又弹模型回复
            if (!shortCircuit)
                return 'continue';
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
