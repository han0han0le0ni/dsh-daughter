import type { BigFive, DaughterConfig, L5State, SpeakPlan, SpeakReason } from '../types.js';
import { clamp01 } from '../util.js';

/**
 * 主动开口的评估上下文。
 *
 * 与 `motivation.ts` 的分工：那边回答"这条技能该不该用"，需要用户输入；
 * 这边回答"没人跟我说话时，我想不想开口"，信号来自沉默时长而不是文本。
 */
export interface SpeakContext {
  now: string;
  bigFive?: BigFive;
  l5?: L5State;
  /** L2 关系深度，越熟越随意 */
  relationshipDepth?: number;
  /** 距最后一次对话（用户说的或她说的）多少分钟 */
  idleMinutes: number;
  /** 距上次主动开口多少分钟；从未开口传 null */
  sinceLastSpeakMinutes: number | null;
  /** 今天已经主动开口几次 */
  todayCount: number;
  /** 上一轮 hold 留下的"憋着"压力 */
  carry: number;
  /** 当前前台窗口；桌面桥接不可用时为空，按"看不见屏幕"处理 */
  foreground?: { title?: string; processName?: string } | null;
  /** 抖动，[-1,1]，由调用方注入（便于测试给定值） */
  jitter?: number;
}

export interface SpeakOptions {
  /** 最近用过的文案下标，用来避开重复（建议保留最近 5 条） */
  recentLines?: number[];
  /** 文案种子；默认用 now */
  seed?: string;
}

function unit(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? clamp01(number) : fallback;
}

/** 0..1 的维度映射到 -1..1，0.5 为中性 */
function centered(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return clamp01(number) * 2 - 1;
}

function localHour(now: string): number | null {
  const ms = Date.parse(now);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).getHours();
}

/** 支持跨午夜，例如 [23, 7] 表示 23:00–次日 06:59 */
export function inQuietHours(hour: number | null, range: number[]): boolean {
  if (hour === null) return false;
  const start = Number(range[0] ?? 0);
  const end = Number(range[1] ?? 0);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * 思念累积：随时间单调上升并饱和，但比指数曲线更慢。
 * idle = half 时约 0.5，idle = 3×half 时才 0.75——人不会因为两小时没说话就急。
 */
export function idleUrge(idleMinutes: number, halfMinutes: number): number {
  const idle = Math.max(0, idleMinutes);
  if (idle <= 0) return 0;
  return idle / (idle + Math.max(1, halfMinutes));
}

/**
 * 人格对"想不想开口"的影响。这里是**强度侧**，不是门槛侧：
 * 外向的人不是门槛低，而是同样的沉默时长下更坐不住。
 */
export function personalityUrge(bigFive: BigFive | undefined, config: DaughterConfig): number {
  if (!bigFive) return 0;
  const gain = config.speak.trait_urge_gain;
  if (!(gain > 0)) return 0;
  // 外向：话多；宜人：想关心人；神经质：容易不安地想确认
  const score =
    0.10 * centered(bigFive.extraversion) + 0.06 * centered(bigFive.agreeableness) + 0.04 * centered(bigFive.neuroticism);
  return gain * score;
}

/** 情绪：高兴想分享，累/压力/没安全感就不想开口 */
export function emotionUrge(l5: L5State | undefined): number {
  if (!l5) return 0;
  const pleasure = Number.isFinite(l5.emotion?.pleasure) ? Math.max(-1, Math.min(1, l5.emotion.pleasure)) : 0;
  const arousal = unit(l5.emotion?.arousal);
  const fatigue = unit(l5.fatigue);
  const stress = unit(l5.stress);
  const safety = unit(l5.safety, 0.7);
  return (
    0.10 * pleasure +
    0.05 * (arousal - 0.4) -
    0.10 * fatigue -
    0.05 * stress -
    0.04 * Math.max(0, 0.4 - safety)
  );
}

export function relationshipUrge(depth: number | undefined): number {
  return 0.06 * centered(depth);
}

/** 想说不想说，0..1 */
export function computeSpeakUrge(ctx: SpeakContext, config: DaughterConfig): number {
  const s = config.speak;
  const base = 0.85 * idleUrge(ctx.idleMinutes, s.idle_half_min);
  const rawJitter = Number.isFinite(ctx.jitter) ? Math.max(-1, Math.min(1, ctx.jitter as number)) : 0;
  const jitter = rawJitter * s.jitter;
  const raw =
    base +
    personalityUrge(ctx.bigFive, config) +
    emotionUrge(ctx.l5) +
    relationshipUrge(ctx.relationshipDepth) +
    clamp01(ctx.carry) +
    jitter;
  return clamp01(raw);
}

/** 开会时不该说话——打扰成本最高的一类 */
const MEETING_HINTS = ['zoom', 'teams', 'wemeet', 'voov', 'tencent meeting', '飞书', 'feishu', 'lark', 'webex', 'discord'];
/** 游戏/全屏娱乐时次之 */
const GAME_HINTS = ['steam', 'vpet', 'genshin', 'league', 'minecraft', 'unity', 'unreal', 'game'];
/** 专注工作：可以说话，但别在她写到一半时打断 */
const FOCUS_HINTS = ['code', 'devenv', 'idea', 'pycharm', 'webstorm', 'rider', 'goland', 'sublime', 'notepad', 'pwsh', 'powershell', 'cmd', 'wt', 'terminal', 'vim', 'emacs'];

/**
 * 从当前前台窗口猜"这会儿打扰她/他的代价" 0..1。
 * 看不见屏幕（null）返回 0——不该因为探测失败就整天沉默。
 */
export function foregroundBusy(foreground?: { title?: string; processName?: string } | null): number {
  if (!foreground) return 0;
  const processName = String(foreground.processName ?? '').toLowerCase().replace(/\.exe$/, '');
  const title = String(foreground.title ?? '').toLowerCase();
  const haystack = `${processName} ${title}`;
  if (MEETING_HINTS.some((hint) => haystack.includes(hint))) return 0.85;
  if (GAME_HINTS.some((hint) => haystack.includes(hint))) return 0.7;
  if (FOCUS_HINTS.some((hint) => processName.includes(hint))) return 0.4;
  return 0.15;
}

/**
 * 该不该说，0..1。只有"合不合适"，不含人格——
 * 人格属于"想不想"，走 `computeSpeakUrge`，这样两条边不互相污染。
 */
export function computeSpeakThreshold(ctx: SpeakContext, config: DaughterConfig): number {
  const s = config.speak;
  let threshold = s.threshold;
  if (inQuietHours(localHour(ctx.now), s.quiet_hours)) threshold += s.quiet_penalty;
  // 压力大时不想把情绪倒给别人
  if (unit(ctx.l5?.stress) > 0.7) threshold += 0.06;
  // 看得见屏幕就按场景加权：开会 > 游戏 > 写代码 > 其它
  const busy = foregroundBusy(ctx.foreground);
  if (busy > 0) threshold += busy * s.busy_penalty;
  return Math.min(1, Math.max(s.threshold_min, threshold));
}

/** 判断"她当时在想什么"，决定文案池 */
export function pickSpeakReason(ctx: SpeakContext): SpeakReason {
  const pleasureRaw = Number(ctx.l5?.emotion?.pleasure);
  const pleasure = Number.isFinite(pleasureRaw) ? Math.max(-1, Math.min(1, pleasureRaw)) : 0;
  const extraversion = centered(ctx.bigFive?.extraversion);
  const agreeableness = centered(ctx.bigFive?.agreeableness);
  const neuroticism = centered(ctx.bigFive?.neuroticism);
  const idle = Math.max(0, ctx.idleMinutes);

  if (pleasure > 0.25) return 'share';
  // 容易不安的人，安静三小时就开始反复确认（而不是单纯想人）
  if (neuroticism > 0.2 && idle >= 3 * 60) return 'worry';
  if (agreeableness > 0.1 && idle >= 4 * 60) return 'care';
  if (idle >= 3 * 60) return 'miss';
  if (extraversion > 0.3) return 'bored';
  return 'bored';
}

/**
 * 文案池。刻意保留省略号、半截话和不完整句——
 * 主动开口的第一句通常不是完整表达，而是试探。
 * 接模型生成后可替换，但这一层先保证"没有模型也能说话"。
 */
const LINES: Record<SpeakReason, string[]> = {
  miss: [
    '……在忙吗',
    '好久没听到你说话了',
    '突然有点想你',
    '刚才翻到之前的聊天记录',
    '你今天去哪儿了',
    '好像挺久没聊了',
    '有点安静',
    '你那边还顺利吗',
  ],
  care: ['记得喝水', '别熬太晚啊', '吃了吗', '今天还顺利吗', '累了就歇会儿', '别太拼了', '早点睡', '有事记得跟我说'],
  share: [
    '今天心情莫名不错',
    '刚想到一件事想跟你说',
    '有点想聊聊天',
    '我刚才在发呆',
    '诶，你说……算了',
    '今天遇到点小事，挺好的',
    '想跟你说个事，又觉得没什么',
    '忽然挺想讲话的',
  ],
  worry: [
    '你还在吗',
    '是不是我说错话了',
    '好久没动静了，有点担心',
    '在的话回我一下',
    '……我是不是烦到你了',
    '你是不是不想理我了',
    '算了，你忙吧',
    '我就是有点不安',
  ],
  bored: [
    '有点无聊',
    '在干嘛呢',
    '陪我待一会儿吧',
    '好安静啊',
    '你忙你的，我就在这儿',
    '有点想找人说话',
    '今天好长啊',
    '在的话吱一声',
  ],
};

function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 按种子从对应池里挑一句；`avoid` 是最近说过的那几句，尽量避开 */
export function pickSpeakLine(
  reason: SpeakReason,
  seed: string,
  avoid: number[] = [],
): { text: string; index: number } {
  const lines = LINES[reason];
  const size = lines.length;
  let index = hashText(seed) % size;
  if (avoid.includes(index)) {
    for (let step = 1; step <= size; step += 1) {
      const candidate = (index + step) % size;
      if (!avoid.includes(candidate)) {
        index = candidate;
        break;
      }
    }
  }
  return { text: lines[index]!, index };
}

/** 本地日期键，用于"每天最多说几次"的计数分桶 */
export function localDayKey(now: string): string {
  const ms = Date.parse(now);
  if (!Number.isFinite(ms)) return 'unknown';
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function nextCarry(current: number, config: DaughterConfig, decision: 'act' | 'hold' | 'silent'): number {
  const s = config.speak;
  const value = clamp01(current);
  if (decision === 'act') return 0;
  if (decision === 'hold') return Math.min(s.carry_max, value + s.carry_step);
  return Math.max(0, value - s.carry_decay);
}

/**
 * 主入口：返回这一轮"说不说、为什么、说什么"。
 * 纯函数，不碰存储——冷却、日上限、carry 都由调用方读写。
 */
export function evaluateSpeak(ctx: SpeakContext, config: DaughterConfig, options: SpeakOptions = {}): SpeakPlan {
  const s = config.speak;
  const reason = pickSpeakReason(ctx);
  const urge = computeSpeakUrge(ctx, config);
  const threshold = computeSpeakThreshold(ctx, config);

  const plan = (decision: 'act' | 'hold' | 'silent', text?: string): SpeakPlan => ({
    decision,
    urge,
    threshold,
    reason,
    carry: nextCarry(ctx.carry, config, decision),
    ...(text ? { text } : {}),
  });

  // 影子模式要能独立于正式开关工作：先看几天"她会说什么"，再决定开不开
  if (!s.enabled && !s.shadow) return plan('silent');
  // 刚说过话，先安静一会儿
  if (ctx.sinceLastSpeakMinutes !== null && ctx.sinceLastSpeakMinutes < s.refractory_min) return plan('silent');
  // 沉默还不够久，没到想说话的时候
  if (Math.max(0, ctx.idleMinutes) < s.min_idle_min) return plan('silent');
  // 今天已经说够多了
  if (ctx.todayCount >= s.max_per_day) return plan('silent');

  if (urge >= threshold) {
    const line = pickSpeakLine(reason, options.seed ?? ctx.now, options.recentLines);
    return { ...plan('act'), text: line.text, lineIndex: line.index };
  }
  // 想说但忍住了：这次的憋劲会累积到下一轮
  if (urge >= threshold * s.hold_ratio) return plan('hold');
  return plan('silent');
}
