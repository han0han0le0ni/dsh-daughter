import { checkToolGate } from '../util.js';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47612';
function clampInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number))
        return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
}
async function requestJson(fetchImpl, url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        const text = await response.text();
        if (!response.ok)
            throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
        return text ? JSON.parse(text) : {};
    }
    finally {
        clearTimeout(timer);
    }
}
function formatStatus(payload) {
    const consumer = payload.consumer ?? {};
    const bridge = payload.bridge ?? {};
    const consumerState = consumer.online
        ? `在线（最近一次轮询 ${consumer.staleMs ?? 0}ms 前）`
        : '离线（桌宠 MOD 未轮询）';
    const bridgeState = bridge.online
        ? `在线（${bridge.name ?? '桌宠'} Lv.${bridge.level ?? '?'} / ${bridge.mode ?? '未知模式'}）`
        : '离线（bridge.mjs 未运行）';
    const info = consumer.info;
    const modState = info?.state
        ? `MOD 状态：${info.state.busy ? `忙碌（${info.state.reason ?? 'unknown'}）` : '空闲'}` +
            `${info.state.playerActive ? ' / 玩家交互中' : ''}` +
            `${info.state.queued ? ` / 排队 ${info.state.queued}` : ''}` +
            `${info.state.dropped ? ` / 丢弃 ${info.state.dropped}` : ''}` +
            `${info.state.currentGraph ? ` / 当前 ${info.state.currentGraph}` : ''}`
        : consumer.online
            ? 'MOD 状态：未上报（旧版 MOD）'
            : null;
    const lines = [
        `桌宠连接：${consumerState}`,
        `存档桥接：${bridgeState}`,
        `待播事件：${payload.pending ?? 0}，已丢弃：${payload.dropped ?? 0}，序号：${payload.latestSeq ?? 0}`,
    ];
    if (modState)
        lines.push(modState);
    if (typeof bridge.strengthPct === 'number' || typeof bridge.feelingPct === 'number') {
        lines.push(`身体信号：体力 ${bridge.strengthPct ?? '?'}% / 心情 ${bridge.feelingPct ?? '?'}%（只影响角色疲劳与压力）`);
    }
    return lines.join('\n');
}
export function createVpetControlTool(options = {}) {
    const bridgeUrl = String(options.bridgeUrl ?? process.env.DSH_VPET_ENDPOINT ?? DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? 5000;
    const logger = options.logger;
    return {
        name: 'vpet_control',
        description: '控制桌面宠物（VPet）的动画与位置。平时不必调用，桌宠会自主活动；只有需要让它做出特定动作或移动到指定位置时才使用。可用动作：animate（播放原生动画，常用 GraphType：Say / Touch_Head / Touch_Body / Idel / Sleep / Work / StateONE / StateTWO）、move（相对当前位置平移）、status（查看连接状态）。',
        timeoutMs,
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['animate', 'move', 'status'],
                    description: '要执行的动作。',
                },
                graph: {
                    type: 'string',
                    description: 'animate 时必填：VPet 原生 GraphType 名称（不区分大小写），如 Say / Touch_Head / Touch_Body / Idel / Sleep / Work / StateONE / StateTWO。',
                },
                loops: {
                    type: 'integer',
                    default: 1,
                    description: 'animate 时动画循环次数，0–10，默认 1。',
                },
                text: {
                    type: 'string',
                    description: 'animate 时可选：同时让桌宠气泡显示的文字。',
                },
                dx: {
                    type: 'integer',
                    default: 0,
                    description: 'move 时相对当前位置的横向位移（像素），范围 -2000–2000。',
                },
                dy: {
                    type: 'integer',
                    default: 0,
                    description: 'move 时相对当前位置的纵向位移（像素），范围 -2000–2000。',
                },
                duration_ms: {
                    type: 'integer',
                    default: 600,
                    description: 'move 的动画时长，范围 100–5000 毫秒。',
                },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
            },
            render(_args, value) {
                return [{ type: 'text', text: value.text }];
            },
        },
        async execute(args) {
            if (!fetchImpl)
                throw new Error('当前运行环境没有 fetch，无法控制桌宠');
            const action = String(args.action ?? '');
            checkToolGate(options.guard, action === 'status' ? 'read' : 'write', 'vpet_control');
            if (action === 'status') {
                const payload = (await requestJson(fetchImpl, `${bridgeUrl}/vpet/status`, undefined, timeoutMs));
                return { text: formatStatus(payload) };
            }
            if (action === 'animate') {
                const graph = String(args.graph ?? '').trim();
                if (!graph)
                    throw new Error('animate 需要 graph 参数，例如 "Say" 或 "Touch_Head"');
                const loops = clampInteger(args.loops, 1, 0, 10);
                const text = typeof args.text === 'string' && args.text.trim() ? args.text.trim() : undefined;
                const payload = await requestJson(fetchImpl, `${bridgeUrl}/vpet/control`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'animate', graph, loops, ...(text ? { text } : {}) }),
                }, timeoutMs);
                logger?.debug?.('vpet_control: animate', { graph, loops, ok: payload.ok });
                return { text: `已让桌宠播放 ${graph} 动画${loops > 0 ? ` ×${loops}` : ''}${text ? '，并显示气泡' : ''}。` };
            }
            if (action === 'move') {
                const dx = clampInteger(args.dx, 0, -2000, 2000);
                const dy = clampInteger(args.dy, 0, -2000, 2000);
                if (dx === 0 && dy === 0)
                    throw new Error('move 需要 dx 或 dy 至少一个非 0');
                const durationMs = clampInteger(args.duration_ms, 600, 100, 5000);
                const payload = await requestJson(fetchImpl, `${bridgeUrl}/vpet/control`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'move', dx, dy, durationMs }),
                }, timeoutMs);
                logger?.debug?.('vpet_control: move', { dx, dy, durationMs, ok: payload.ok });
                return { text: `已让桌宠相对移动 (${dx}, ${dy}) 像素，用时 ${durationMs}ms。` };
            }
            throw new Error(`未知 action：${action}，可用 animate / move / status`);
        },
    };
}
export function registerVpetControlTool(ctx, options = {}) {
    const logger = options.logger ?? ctx.logger;
    const tools = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') {
        logger?.warn?.('dsh-daughter: 无 tools 服务，跳过 vpet_control 注册');
        return () => { };
    }
    try {
        const dispose = tools.register(createVpetControlTool({ ...options, logger }));
        logger?.info?.('dsh-daughter: vpet_control 已注册');
        return typeof dispose === 'function' ? dispose : () => { };
    }
    catch (error) {
        logger?.warn?.('dsh-daughter: vpet_control 注册失败', { error: String(error) });
        return () => { };
    }
}
