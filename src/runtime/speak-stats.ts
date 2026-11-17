import type { SpeakPlan, SpeakReason } from '../types.js';

/**
 * 主动开口的按日聚合（DEF-18）。
 *
 * 只存计数，不存正文：目的是回答"她多久沉默一次""想说的都在什么动机下"，
 * 用来调阈值，不是第二套记忆。超出 7 天的桶直接丢弃。
 */
export interface SpeakStatsBucket {
  day: string;
  act: number;
  hold: number;
  silent: number;
  /** decision → 次数；silent 也有动机，便于看"哪类动机最常被阈值挡住" */
  reasons: Partial<Record<SpeakReason, number>>;
  updatedAt: string;
}

export interface SpeakStatsSummary {
  day: string;
  total: number;
  act: number;
  hold: number;
  silent: number;
  /** 沉默占比 0..1；没有样本时为 0 */
  silentRatio: number;
  reasons: Partial<Record<SpeakReason, number>>;
}

const MAX_DAYS = 7;

function parseBuckets(raw: string | null): SpeakStatsBucket[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is SpeakStatsBucket => {
        if (!entry || typeof entry !== 'object') return false;
        const bucket = entry as Partial<SpeakStatsBucket>;
        return typeof bucket.day === 'string';
      })
      .map((bucket) => ({
        day: bucket.day,
        act: Number(bucket.act) || 0,
        hold: Number(bucket.hold) || 0,
        silent: Number(bucket.silent) || 0,
        reasons: bucket.reasons && typeof bucket.reasons === 'object' ? bucket.reasons : {},
        updatedAt: typeof bucket.updatedAt === 'string' ? bucket.updatedAt : '',
      }));
  } catch {
    // 统计只是旁路数据，坏了就当没有，不能影响开口本身
    return [];
  }
}

/** 记一次评估结果，返回要写回 meta 的 JSON */
export function recordSpeakStats(raw: string | null, plan: SpeakPlan, day: string, now: string): string {
  const buckets = parseBuckets(raw);
  let bucket = buckets.find((entry) => entry.day === day);
  if (!bucket) {
    bucket = { day, act: 0, hold: 0, silent: 0, reasons: {}, updatedAt: now };
    buckets.push(bucket);
  }
  bucket[plan.decision] += 1;
  bucket.reasons[plan.reason] = (bucket.reasons[plan.reason] ?? 0) + 1;
  bucket.updatedAt = now;
  return JSON.stringify(buckets.sort((a, b) => a.day.localeCompare(b.day)).slice(-MAX_DAYS));
}

/** 读某一天的汇总，供面板展示 */
export function readSpeakStats(raw: string | null, day: string): SpeakStatsSummary {
  const bucket = parseBuckets(raw).find((entry) => entry.day === day);
  if (!bucket) {
    return { day, total: 0, act: 0, hold: 0, silent: 0, silentRatio: 0, reasons: {} };
  }
  const total = bucket.act + bucket.hold + bucket.silent;
  return {
    day,
    total,
    act: bucket.act,
    hold: bucket.hold,
    silent: bucket.silent,
    silentRatio: total > 0 ? bucket.silent / total : 0,
    reasons: bucket.reasons,
  };
}
