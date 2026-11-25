import type { SpeakConversationConfig, SpeakPlan } from '../types.js';

/**
 * 会话窗口投递的记账与框架。
 *
 * 设计约束：
 * - 只负责"要不要送、送什么"，真正的 followup 由宿主层完成，便于单测。
 * - 送进会话的是"插件来源的用户消息"，模型看到后生成真正的回复，
 *   因此文案必须防注入：把动态内容与指令分开，且不暴露内部机制。
 */

export interface ConversationLedger {
  /** 记账所属的自然日（本地时区 key，如 2026-11-25） */
  day: string;
  /** 当天已送次数 */
  count: number;
  /** 上次送出的时间（ISO），跨天保留，用于最小间隔判断 */
  lastAt: string | null;
}

export interface ConversationGate {
  ok: boolean;
  reason?: 'cap' | 'gap';
}

/** 空账本；解析失败也退化为它，不能因为脏数据就放开限额。 */
export function emptyLedger(day: string): ConversationLedger {
  return { day, count: 0, lastAt: null };
}

/** 读账本；跨天只重置计数，保留 lastAt 以便跨零点仍然遵守最小间隔。 */
export function readLedger(raw: string | null, day: string): ConversationLedger {
  if (!raw) return emptyLedger(day);
  try {
    const parsed = JSON.parse(raw) as Partial<ConversationLedger>;
    const count = Number.isFinite(parsed.count) ? Math.max(0, Math.floor(Number(parsed.count))) : 0;
    const lastAt = typeof parsed.lastAt === 'string' && !Number.isNaN(Date.parse(parsed.lastAt)) ? parsed.lastAt : null;
    if (parsed.day !== day) return { day, count: 0, lastAt };
    return { day, count, lastAt };
  } catch {
    return emptyLedger(day);
  }
}

/** 判断这一刻能不能送：先看日上限，再看最小间隔。 */
export function allowSend(ledger: ConversationLedger, config: SpeakConversationConfig, now: string): ConversationGate {
  if (config.max_per_day <= 0) return { ok: false, reason: 'cap' };
  if (ledger.count >= config.max_per_day) return { ok: false, reason: 'cap' };
  if (ledger.lastAt) {
    const elapsedMin = (Date.parse(now) - Date.parse(ledger.lastAt)) / 60_000;
    if (Number.isFinite(elapsedMin) && elapsedMin < config.min_gap_min) return { ok: false, reason: 'gap' };
  }
  return { ok: true };
}

/** 记一次送出。跨天只重置换算后的计数，lastAt 照常更新。 */
export function recordSend(ledger: ConversationLedger, day: string, now: string): ConversationLedger {
  return {
    day,
    count: ledger.day === day ? ledger.count + 1 : 1,
    lastAt: now,
  };
}

/** 账本序列化（留给需要落盘的调用方）。 */
export function serializeLedger(ledger: ConversationLedger): string {
  return JSON.stringify(ledger);
}

const DEFAULT_INSTRUCTION = '请直接以你自己的角色身份说一到两句话，自然地找主人搭话。';

/**
 * 生成送进会话的消息。
 *
 * 结构化框架而非自然语言转述：模型能分清哪句是指令、哪句是素材，
 * 动态字段（动机、强度、模板句）一律作为参考值，不冒充用户原话。
 */
export function buildProactiveMessage(
  plan: SpeakPlan,
  config: Pick<SpeakConversationConfig, 'prompt'>,
): { summary: string; text: string } {
  const instruction = config.prompt.trim() || DEFAULT_INSTRUCTION;
  const lines = [
    '[DSH-DAUGHTER PROACTIVE]',
    `现在是主动开口时机（动机 ${plan.reason}，强度 ${plan.urge.toFixed(2)}）。`,
    instruction,
    '不要解释这条提示，不要提到插件、系统、规则或“主动开口”这个机制。',
  ];
  if (plan.text) lines.push(`想表达的意思（仅供参考，可以用自己的说法）：${plan.text}`);
  return { summary: '主动开口', text: lines.join('\n') };
}
