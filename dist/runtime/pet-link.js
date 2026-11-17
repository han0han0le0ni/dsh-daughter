/** dsh-pet 的默认路由段 */
export const PET_ROUTE_SEGMENT = '/dsh-pet-7340';
/** dsh-pet 默认宠物 id（config.jsonc 里 pets[0]） */
export const DEFAULT_PET_ID = 'main';
/**
 * 情绪带 → 动画名。
 *
 * 名字必须落在 dsh-pet 该宠物的可点播池里（菜单树叶 ∪ 玩法池），否则它回
 * `unknown-animation` 而前端"点了没反应"——所以这里刻意选池内确实存在的三个：
 * 小憩沉眠在「小动作」类，可爱宅舞在「玩耍」类，东张西望在转向池。
 */
export const PET_MOOD_ANIM = {
    tired: '原地小憩沉眠',
    joy: '可爱宅舞',
    low: '东张西望',
};
/**
 * 工作状态事件 → dsh-pet 内置 workStatus 动画名。
 * 索引与 dsh-pet 的 `animations.events.workStatus` 档位一一对应：
 *   thinking→思考冒泡、tool→忙碌点按、reply→清点归档、error→垂头叹气冒汗。
 * 名字必须落在它的池内，否则 /anim 回 unknown-animation。
 */
export const PET_WORK_ANIM = {
    thinking: '工作状态-思考冒泡',
    tool: '工作状态-忙碌点按',
    reply: '工作状态-清点归档',
    error: '工作状态-垂头叹气冒汗',
};
/** 按事件 kind 取对应的桌宠工作动画名；没有对应关系时返回 undefined */
export function petWorkAnimFor(kind) {
    return PET_WORK_ANIM[kind];
}
function trimSlashes(value) {
    return String(value ?? '').trim().replace(/\/+$/, '');
}
/** 路由段统一成 "/xxx" 形态；空值回默认 */
export function petRouteOf(route) {
    const raw = String(route ?? '').trim();
    if (!raw)
        return PET_ROUTE_SEGMENT;
    const withLead = raw.startsWith('/') ? raw : `/${raw}`;
    return withLead.replace(/\/+$/, '');
}
/** 宠物 id：空白一律回默认，不在代码里赌 `pets[""]` */
export function petIdOf(petId) {
    const raw = String(petId ?? '').trim();
    return raw || DEFAULT_PET_ID;
}
/** 宿主端口 → 本机基地址；端口非法时返回 null，由调用方决定不接这个出口 */
export function petBaseUrlOf(port) {
    const value = Number(port);
    if (!Number.isFinite(value) || value <= 0 || value > 65535)
        return null;
    return `http://127.0.0.1:${Math.round(value)}`;
}
/** 拼出一次调用的完整地址 */
export function petEndpointUrl(options, rest, query = {}) {
    const base = trimSlashes(options.baseUrl);
    const url = new URL(`${base}${petRouteOf(options.route)}/${rest.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query))
        url.searchParams.set(key, value);
    return url.toString();
}
async function postJson(options, rest, payload, query) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl)
        throw new Error('当前运行环境没有 fetch，无法投递桌宠出口');
    const url = petEndpointUrl(options, rest, query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
    try {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        if (!response.ok) {
            const body = await response.text?.().catch(() => '');
            throw new Error(`桌宠 ${url} 返回 ${response.status}${body ? `：${body.slice(0, 120)}` : ''}`);
        }
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * 说话出口：把表达事件的文本写进 dsh-pet 的气泡。
 * 没有文本时静默跳过——`/broadcast` 对空 text 回 bad-request，没必要发一趟。
 */
export function createPetSink(options) {
    const duration = Math.max(0, Math.round(options.durationMs ?? 10_000));
    return async (event) => {
        const text = typeof event?.text === 'string' ? event.text.trim() : '';
        if (!text)
            return;
        await postJson(options, 'broadcast', { text, duration }, { pet: petIdOf(options.petId) });
    };
}
/** 动作出口：点播一个动画，用于把情绪带映射成桌宠动作 */
export function createPetAnimSink(options) {
    return async (name) => {
        const anim = String(name ?? '').trim();
        if (!anim)
            return;
        await postJson(options, 'anim', { name: anim }, { pet: petIdOf(options.petId) });
    };
}
/**
 * 探测 dsh-pet 是否在跑：GET <route>/config 回 2xx 即认为可用。
 * 任何异常都算"不可用"——它只是决定要不要让路，失败不该把插件装载搞崩。
 */
export async function probePet(options) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl)
        return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2000);
    try {
        const response = await fetchImpl(petEndpointUrl(options, 'config'), { signal: controller.signal });
        return response.ok;
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timer);
    }
}
