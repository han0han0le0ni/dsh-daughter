/**
 * dsh-pet（DSH 内置电子桌宠）出口。
 *
 * 与 `vpet` 出口的区别：VPet 走游戏的事件队列，要有 MOD 轮询才有人消费；
 * dsh-pet 是宿主自己的插件，路由挂在同一个 webServer 上，进程内直接可达，
 * 不需要额外的桥接脚本，也不需要用户填端口。
 *
 * 契约（dsh-pet 0.4.x，见其 `src/host/routes/interaction.ts` / `motion.ts`）：
 *   POST <route>/broadcast?pet=<id>   { text, duration?, anim? }  把外部给定文本写进气泡（不生成）
 *   POST <route>/anim?pet=<id>        { name, facing? }           点播一个池内动画
 *   GET  <route>/config                                           读配置，用来探测它是否在跑
 *
 * 路由段是 dsh-pet 的常量（其 `src/shared/constants.ts` 的 ROUTE_SEGMENT）。
 * 它属于别家的内部约定，升级可能改；配置里的 `route` 就是给那一天准备的后门。
 */
import type { MoodBand } from './mood-motion.js';

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
export const PET_MOOD_ANIM: Record<MoodBand, string> = {
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
export const PET_WORK_ANIM: Record<string, string> = {
  thinking: '工作状态-思考冒泡',
  tool: '工作状态-忙碌点按',
  reply: '工作状态-清点归档',
  error: '工作状态-垂头叹气冒汗',
};

/** 按事件 kind 取对应的桌宠工作动画名；没有对应关系时返回 undefined */
export function petWorkAnimFor(kind: string): string | undefined {
  return PET_WORK_ANIM[kind];
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

export interface PetEndpointOptions {
  /** DSH 基地址，如 http://127.0.0.1:3456；尾部斜杠会被收敛 */
  baseUrl: string;
  /** 要投给哪只桌宠，缺省 main */
  petId?: string;
  /** 路由段覆盖，缺省 PET_ROUTE_SEGMENT */
  route?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/** 只读她要说的话；不依赖 expression 模块，避免两边互相 import */
export interface PetSpeechLike {
  text?: string;
}

function trimSlashes(value: string): string {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/** 路由段统一成 "/xxx" 形态；空值回默认 */
export function petRouteOf(route?: string): string {
  const raw = String(route ?? '').trim();
  if (!raw) return PET_ROUTE_SEGMENT;
  const withLead = raw.startsWith('/') ? raw : `/${raw}`;
  return withLead.replace(/\/+$/, '');
}

/** 宠物 id：空白一律回默认，不在代码里赌 `pets[""]` */
export function petIdOf(petId?: string): string {
  const raw = String(petId ?? '').trim();
  return raw || DEFAULT_PET_ID;
}

/** 宿主端口 → 本机基地址；端口非法时返回 null，由调用方决定不接这个出口 */
export function petBaseUrlOf(port: unknown): string | null {
  const value = Number(port);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) return null;
  return `http://127.0.0.1:${Math.round(value)}`;
}

/** 拼出一次调用的完整地址 */
export function petEndpointUrl(options: PetEndpointOptions, rest: string, query: Record<string, string> = {}): string {
  const base = trimSlashes(options.baseUrl);
  const url = new URL(`${base}${petRouteOf(options.route)}/${rest.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

async function postJson(options: PetEndpointOptions, rest: string, payload: unknown, query: Record<string, string>): Promise<void> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) throw new Error('当前运行环境没有 fetch，无法投递桌宠出口');
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
  } finally {
    clearTimeout(timer);
  }
}

export interface PetSinkOptions extends PetEndpointOptions {
  /** 气泡停留毫秒；0 = 不显示文字 */
  durationMs?: number;
}

/**
 * 说话出口：把表达事件的文本写进 dsh-pet 的气泡。
 * 没有文本时静默跳过——`/broadcast` 对空 text 回 bad-request，没必要发一趟。
 */
export function createPetSink(options: PetSinkOptions): (event: PetSpeechLike) => Promise<void> {
  const duration = Math.max(0, Math.round(options.durationMs ?? 10_000));
  return async (event) => {
    const text = typeof event?.text === 'string' ? event.text.trim() : '';
    if (!text) return;
    await postJson(
      options,
      'broadcast',
      { text, duration },
      { pet: petIdOf(options.petId) },
    );
  };
}

/** 动作出口：点播一个动画，用于把情绪带映射成桌宠动作 */
export function createPetAnimSink(options: PetEndpointOptions): (name: string) => Promise<void> {
  return async (name) => {
    const anim = String(name ?? '').trim();
    if (!anim) return;
    await postJson(options, 'anim', { name: anim }, { pet: petIdOf(options.petId) });
  };
}

/**
 * 探测 dsh-pet 是否在跑：GET <route>/config 回 2xx 即认为可用。
 * 任何异常都算"不可用"——它只是决定要不要让路，失败不该把插件装载搞崩。
 */
export async function probePet(options: PetEndpointOptions): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2000);
  try {
    const response = await fetchImpl(petEndpointUrl(options, 'config'), { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
