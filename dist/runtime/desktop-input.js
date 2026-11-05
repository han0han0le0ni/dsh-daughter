import { checkToolGate } from '../util.js';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47614';
const ACTIONS = ['move', 'click', 'drag', 'scroll', 'key', 'type', 'activate', 'screen'];
function describe(args, value) {
    const action = value.action;
    const normalized = args.normalized === true;
    const suffix = normalized ? '（归一化坐标）' : '';
    const buttons = { left: '左键', right: '右键', middle: '中键' };
    const relative = args.relative === true || args.window !== undefined || args.process !== undefined;
    const windowTitle = String(value.window?.title ?? args.window ?? args.process ?? '前台窗口');
    const target = relative ? `窗口「${windowTitle}」客户区` : '屏幕';
    if (action === 'move') {
        if (args.dx !== undefined || args.dy !== undefined) {
            const cursor = value.cursor;
            return `鼠标已微调 (${args.dx ?? 0}, ${args.dy ?? 0})，现在位于 (${cursor?.x ?? '?'}, ${cursor?.y ?? '?'})。`;
        }
        return `鼠标已移到${target} (${args.x}, ${args.y})${suffix}。`;
    }
    if (action === 'click') {
        const point = args.x !== undefined ? ` (${args.x}, ${args.y})${suffix}` : '';
        return `已用${buttons[String(args.button ?? 'left')] ?? '左键'}在${point ? `${target}${point}` : '当前光标位置'}点击 ${args.count ?? 1} 次。`;
    }
    if (action === 'drag') {
        return `已从${target} (${args.from_x}, ${args.from_y}) 拖到 (${args.to_x}, ${args.to_y})${suffix}。`;
    }
    if (action === 'scroll') {
        const delta = Number(args.delta ?? 0);
        return `已向${delta > 0 ? '上' : '下'}滚动 ${Math.abs(delta)}。`;
    }
    if (action === 'key') {
        const mode = String(args.mode ?? 'press');
        const label = mode === 'down' ? '按下并保持' : mode === 'up' ? '松开' : '按下';
        const hold = Number(args.hold_ms ?? 0);
        return `已${label}按键 ${args.key}${hold > 0 && mode === 'press' ? `，按住 ${hold}ms` : ''}。`;
    }
    if (action === 'type') {
        return `已输入 ${String(args.text ?? '').length} 个字符。`;
    }
    if (action === 'activate') {
        const window = value.window ?? {};
        const title = window.title ?? args.window ?? args.process ?? '目标窗口';
        const process = window.processName ? `（${String(window.processName)}）` : '';
        const focused = window.focused === false ? '，但系统未允许置前' : '';
        return `已切换到窗口「${String(title)}」${process}${focused}。`;
    }
    if (action === 'screen') {
        const screen = value.screen;
        const cursor = value.cursor;
        const size = screen ? `主屏 ${screen.width}x${screen.height}` : '主屏尺寸未知';
        const point = cursor ? `，光标在 (${cursor.x}, ${cursor.y})` : '';
        return `${size}${point}。`;
    }
    return `已完成 ${action}。`;
}
export function createDesktopInputTool(options = {}) {
    const bridgeUrl = (options.bridgeUrl ?? DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? 15000;
    return {
        name: 'desktop_input',
        description: '操作 Windows 电脑的鼠标、键盘和窗口。先用 desktop_observe 观察屏幕，再用本工具执行操作；' +
            '坐标默认是主屏物理像素，也可用 normalized=true 传 0–1 的相对坐标。' +
            '瞄准闭环：move 到目标附近 → desktop_observe({focus_cursor:true}) 放大查看亮绿准星 → 用 move 的 dx/dy 微调几像素 → 准星对准后 click（不传坐标即点击当前光标位置）。' +
            '窗口化应用或游戏传 window（或 process）与 relative=true，x/y 按该窗口客户区像素计算，避免窗口偏移与 DPI 缩放误差。' +
            '游戏通常需要先 activate 聚焦窗口，再用 key 的 down/up 模式控制按住与松开。',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [...ACTIONS],
                    description: 'move=移动鼠标；click=点击；drag=拖拽；scroll=滚轮；key=按键；type=输入文本；' +
                        'activate=聚焦窗口；screen=读取主屏尺寸与光标位置。',
                },
                x: { type: 'number', description: '屏幕 X 坐标；normalized=true 时为 0–1；relative=true 时为窗口客户区 X。' },
                y: { type: 'number', description: '屏幕 Y 坐标；normalized=true 时为 0–1；relative=true 时为窗口客户区 Y。' },
                dx: { type: 'number', description: '相对当前光标的横向微调像素（与 x/y 二选一，用于瞄准微调）。' },
                dy: { type: 'number', description: '相对当前光标的纵向微调像素（与 x/y 二选一，用于瞄准微调）。' },
                normalized: {
                    type: 'boolean',
                    description: '为 true 时所有坐标按主屏比例 0–1 解释，适合直接从截图估算位置。',
                },
                relative: {
                    type: 'boolean',
                    description: '为 true 时 x/y（及拖拽坐标）按目标窗口客户区像素解释；目标窗口由 window/process 指定，缺省用当前前台窗口。',
                },
                button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标按键，默认 left。' },
                count: { type: 'integer', minimum: 1, maximum: 3, description: '点击次数，默认 1。' },
                interval_ms: {
                    type: 'integer',
                    minimum: 20,
                    maximum: 500,
                    description: '多次点击之间的间隔毫秒数，默认 80。',
                },
                from_x: { type: 'number', description: '拖拽起点 X。' },
                from_y: { type: 'number', description: '拖拽起点 Y。' },
                to_x: { type: 'number', description: '拖拽终点 X。' },
                to_y: { type: 'number', description: '拖拽终点 Y。' },
                duration_ms: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 5000,
                    description: '移动或拖拽的持续时间，0 表示瞬间完成。',
                },
                delta: {
                    type: 'integer',
                    minimum: -1200,
                    maximum: 1200,
                    description: '滚轮位移，正数向上、负数向下。',
                },
                key: {
                    type: 'string',
                    description: '按键名，如 a、space、enter、f1、left，或组合键 ctrl+a。',
                },
                mode: {
                    type: 'string',
                    enum: ['press', 'down', 'up'],
                    description: 'press=按一下；down=按住；up=松开。游戏长按需要 down 后再 up。',
                },
                hold_ms: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 2000,
                    description: 'press 模式下按住时长。',
                },
                text: { type: 'string', description: '要输入的文本，最长 200 字符。' },
                window: {
                    type: 'string',
                    description: '窗口标题的一部分。activate 时用于聚焦；move/click/drag/scroll 时作为坐标基准窗口（配合 relative=true）。',
                },
                process: {
                    type: 'string',
                    description: '进程名的一部分。activate 时用于聚焦；move/click/drag/scroll 时作为坐标基准窗口（配合 relative=true）。',
                },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    action: { type: 'string' },
                    screen: { type: 'object' },
                    cursor: { type: 'object' },
                },
                required: ['text', 'action'],
            },
            render(_args, value) {
                return [{ type: 'text', text: value.text }];
            },
        },
        timeoutMs,
        async execute(args) {
            const action = String(args.action ?? '').trim().toLowerCase();
            if (!ACTIONS.includes(action)) {
                throw new Error(`不支持的 action：${action || '(空)'}`);
            }
            // screen 只读，其余都会真实操作桌面
            checkToolGate(options.guard, action === 'screen' ? 'read' : 'write', 'desktop_input');
            const payload = { action };
            for (const key of [
                'x',
                'y',
                'dx',
                'dy',
                'normalized',
                'relative',
                'button',
                'count',
                'interval_ms',
                'from_x',
                'from_y',
                'to_x',
                'to_y',
                'duration_ms',
                'delta',
                'key',
                'mode',
                'hold_ms',
                'text',
                'window',
                'process',
            ]) {
                if (args[key] !== undefined)
                    payload[key] = args[key];
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let text = '';
            try {
                const response = await fetchImpl(`${bridgeUrl}/input`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
                text = await response.text();
                let body;
                try {
                    body = JSON.parse(text);
                }
                catch {
                    throw new Error(`桌面输入返回了无法解析的内容（HTTP ${response.status}）`);
                }
                if (!response.ok || body.ok === false) {
                    throw new Error(`桌面输入失败：${body.error ?? `HTTP ${response.status}`}`);
                }
                const value = {
                    text: '',
                    action,
                    at: new Date().toISOString(),
                };
                if (body.screen?.width && body.screen?.height) {
                    value.screen = { width: body.screen.width, height: body.screen.height };
                }
                if (typeof body.cursor?.x === 'number' && typeof body.cursor?.y === 'number') {
                    value.cursor = { x: body.cursor.x, y: body.cursor.y };
                }
                if (body.window)
                    value.window = body.window;
                value.text = describe(payload, value);
                return value;
            }
            catch (error) {
                if (controller.signal.aborted) {
                    throw new Error(`桌面输入超时（${timeoutMs}ms）`);
                }
                const message = error instanceof Error ? error.message : String(error);
                if (/ECONNREFUSED|fetch failed|Failed to fetch/i.test(message)) {
                    throw new Error('桌面桥接不可用，请先运行 node connectors/desktop/bridge.mjs');
                }
                throw error;
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
export function registerDesktopInputTool(ctx, options = {}) {
    const logger = options.logger ?? ctx.logger;
    const tools = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') {
        logger?.warn?.('dsh-daughter: 无 tools 服务，跳过 desktop_input 注册');
        return () => { };
    }
    try {
        const dispose = tools.register(createDesktopInputTool({ ...options, logger }));
        logger?.info?.('dsh-daughter: desktop_input 已注册');
        return typeof dispose === 'function' ? dispose : () => { };
    }
    catch (error) {
        logger?.warn?.('dsh-daughter: desktop_input 注册失败', { error: String(error) });
        return () => { };
    }
}
