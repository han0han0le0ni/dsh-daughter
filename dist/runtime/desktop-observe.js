import { checkToolGate } from '../util.js';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47614';
function clampInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number))
        return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
}
function optionalInteger(value, min, max) {
    if (value === undefined || value === null || value === '')
        return undefined;
    const number = Number(value);
    if (!Number.isFinite(number))
        return undefined;
    return Math.min(max, Math.max(min, Math.round(number)));
}
async function fetchJson(fetchImpl, url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`${url} 返回 ${response.status}${body ? `：${body.slice(0, 200)}` : ''}`);
        }
        return await response.json();
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchBinary(fetchImpl, url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`${url} 返回 ${response.status}${body ? `：${body.slice(0, 200)}` : ''}`);
        }
        return new Uint8Array(await response.arrayBuffer());
    }
    finally {
        clearTimeout(timer);
    }
}
export function createDesktopObserveTool(options = {}) {
    const bridgeUrl = String(options.bridgeUrl ?? process.env.DSH_DESKTOP_BRIDGE_URL ?? DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? 15000;
    const logger = options.logger;
    return {
        name: 'desktop_observe',
        description: '看一眼当前电脑屏幕：返回前台窗口、正在播放的媒体（如有）和一帧压缩截图。截图默认叠加亮绿色鼠标十字准星；' +
            '可用 focus_cursor 放大鼠标周围，或用 x/y 放大指定点，确认瞄准后再调用 desktop_input。' +
            '结果同时给出前台窗口位置与客户区起点/尺寸；操作窗口化应用或游戏时，用 desktop_input({relative:true, window:..., x, y}) 按客户区坐标点击。' +
            '仅在需要了解屏幕时调用，不要连续高频调用。',
        timeoutMs,
        parameters: {
            type: 'object',
            properties: {
                width: {
                    type: 'integer',
                    default: 1280,
                    description: '截图目标宽度，范围 320–3840，默认 1280；越大越清晰、占用越多。',
                },
                quality: {
                    type: 'integer',
                    default: 70,
                    description: 'JPEG 质量，范围 30–95，默认 70；越高越清晰、带宽越大。',
                },
                include_windows: {
                    type: 'boolean',
                    default: false,
                    description: '是否附带当前可见窗口标题列表。',
                },
                include_media: {
                    type: 'boolean',
                    default: true,
                    description: '是否附带系统媒体会话信息（视频/音乐标题）。',
                },
                cursor: {
                    type: 'boolean',
                    default: true,
                    description: '是否在截图上叠加鼠标十字准星，默认 true。',
                },
                focus_cursor: {
                    type: 'boolean',
                    default: false,
                    description: '是否截取鼠标周围的局部放大图，用于确认瞄准；默认 false。',
                },
                x: { type: 'number', description: '局部放大中心的屏幕 X 坐标（物理像素）。' },
                y: { type: 'number', description: '局部放大中心的屏幕 Y 坐标（物理像素）。' },
                crop_width: {
                    type: 'integer',
                    default: 480,
                    description: '局部放大图宽度，默认 480，范围 64–4096。',
                },
                crop_height: {
                    type: 'integer',
                    default: 320,
                    description: '局部放大图高度，默认 320，范围 64–4096。',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    observedAt: { type: 'string' },
                    foreground: { type: 'object' },
                    media: { type: 'object' },
                    windows: { type: 'array', items: { type: 'string' } },
                    image: { type: 'object' },
                },
                required: ['text', 'observedAt'],
            },
            render(_args, value) {
                const blocks = [{ type: 'text', text: value.text }];
                if (value.image)
                    blocks.push({ type: 'image', attachment: value.image });
                return blocks;
            },
        },
        async execute(args) {
            if (!fetchImpl)
                throw new Error('当前运行环境没有 fetch，无法调用桌面桥接');
            checkToolGate(options.guard, 'read', 'desktop_observe');
            const width = clampInteger(args.width, 1280, 320, 3840);
            const quality = clampInteger(args.quality, 70, 30, 95);
            const includeWindows = args.include_windows === true;
            const includeMedia = args.include_media !== false;
            const showCursor = args.cursor !== false;
            const focusCursor = args.focus_cursor === true;
            const centerX = optionalInteger(args.x, -10000, 10000);
            const centerY = optionalInteger(args.y, -10000, 10000);
            const cropWidth = clampInteger(args.crop_width, 480, 64, 4096);
            const cropHeight = clampInteger(args.crop_height, 320, 64, 4096);
            let foreground;
            try {
                const payload = (await fetchJson(fetchImpl, `${bridgeUrl}/foreground`, timeoutMs));
                foreground = payload.foreground ?? {};
            }
            catch (error) {
                throw new Error(`桌面桥接不可用（${bridgeUrl}）：${String(error)}。请先运行 node connectors/desktop/bridge.mjs`);
            }
            const shotParams = new URLSearchParams({
                format: 'jpeg',
                width: String(width),
                quality: String(quality),
                cursor: String(showCursor),
            });
            if (focusCursor)
                shotParams.set('focus_cursor', 'true');
            if (!focusCursor && centerX !== undefined && centerY !== undefined) {
                shotParams.set('x', String(centerX));
                shotParams.set('y', String(centerY));
            }
            shotParams.set('crop_width', String(cropWidth));
            shotParams.set('crop_height', String(cropHeight));
            const shotUrl = `${bridgeUrl}/screenshot?${shotParams.toString()}`;
            const [imageBytes, media, windows] = await Promise.all([
                fetchBinary(fetchImpl, shotUrl, timeoutMs),
                includeMedia
                    ? fetchJson(fetchImpl, `${bridgeUrl}/media`, timeoutMs)
                        .then((payload) => payload.media)
                        .catch((error) => {
                        logger?.debug?.('desktop_observe: 媒体信息不可用', { error: String(error) });
                        return undefined;
                    })
                    : Promise.resolve(undefined),
                includeWindows
                    ? fetchJson(fetchImpl, `${bridgeUrl}/windows`, timeoutMs)
                        .then((payload) => {
                        const list = payload.windows ?? [];
                        return list
                            .map((item) => String(item.MainWindowTitle ?? '').trim())
                            .filter(Boolean)
                            .slice(0, 8);
                    })
                        .catch(() => [])
                    : Promise.resolve([]),
            ]);
            if (!imageBytes.length)
                throw new Error('桌面截图为空');
            const service = options.attachments ?? options.getAttachments?.();
            if (!service?.saveImage && !service?.saveImages) {
                throw new Error('宿主未提供 attachments 服务，桌面截图无法送入模型');
            }
            const image = service.saveImage
                ? await service.saveImage({ data: imageBytes, mediaType: 'image/jpeg', name: 'desktop-observe.jpg' })
                : (await service.saveImages([
                    { data: imageBytes, mediaType: 'image/jpeg', name: 'desktop-observe.jpg' },
                ]))[0];
            if (!image)
                throw new Error('桌面截图附件保存失败');
            const observedAt = new Date().toISOString();
            const title = String(foreground.title ?? '').trim();
            const processName = String(foreground.processName ?? '').trim();
            const bounds = foreground.bounds;
            const client = foreground.client;
            const lines = [`桌面画面（${observedAt}）`, `前台：${title || '未知窗口'}${processName ? `（${processName}）` : ''}`];
            if (bounds?.width && bounds?.height) {
                const origin = `位置 (${bounds.left ?? 0}, ${bounds.top ?? 0})，`;
                lines.push(`窗口：${origin}尺寸 ${bounds.width}x${bounds.height}`);
            }
            if (client?.width && client?.height) {
                lines.push(`客户区：起点 (${client.left ?? 0}, ${client.top ?? 0})，尺寸 ${client.width}x${client.height}（点击该窗口内元素时按此坐标传 relative=true）`);
            }
            if (focusCursor) {
                lines.push(`焦点：鼠标周围 ${cropWidth}x${cropHeight}（局部放大）`);
            }
            else if (centerX !== undefined && centerY !== undefined) {
                lines.push(`焦点：(${centerX}, ${centerY}) 周围 ${cropWidth}x${cropHeight}（局部放大）`);
            }
            if (showCursor)
                lines.push('鼠标准星：亮绿色十字已叠加');
            const shotWidth = image.width;
            const shotHeight = image.height;
            if (shotWidth) {
                lines.push(`截图：${shotWidth}x${shotHeight ?? '?'}（可能已缩放；desktop_input 坐标按主屏物理像素，若按本图比例估算请传 normalized=true）`);
            }
            const mediaInfo = media;
            if (mediaInfo?.available && mediaInfo.title) {
                lines.push(`正在播放：${mediaInfo.title}${mediaInfo.artist ? ` - ${mediaInfo.artist}` : ''}${mediaInfo.status ? `（${mediaInfo.status}）` : ''}`);
            }
            if (windows && windows.length > 0)
                lines.push(`可见窗口：${windows.join(' / ')}`);
            return {
                text: lines.join('\n'),
                observedAt,
                foreground,
                ...(media ? { media: mediaInfo } : {}),
                ...(windows && windows.length > 0 ? { windows } : {}),
                image,
            };
        },
    };
}
export function registerDesktopObserveTool(ctx, options = {}) {
    const logger = options.logger ?? ctx.logger;
    const tools = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') {
        logger?.warn?.('dsh-daughter: 无 tools 服务，跳过 desktop_observe 注册');
        return () => { };
    }
    try {
        const dispose = tools.register(createDesktopObserveTool({
            ...options,
            logger,
            getAttachments: () => ctx.get('attachments'),
        }));
        logger?.info?.('dsh-daughter: desktop_observe 已注册');
        return typeof dispose === 'function' ? dispose : () => { };
    }
    catch (error) {
        logger?.warn?.('dsh-daughter: desktop_observe 注册失败', { error: String(error) });
        return () => { };
    }
}
