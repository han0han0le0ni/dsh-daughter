/**
 * 认知滤网（cognitive filter）。
 *
 * 大脑不会把每一条感官输入都写进长期记忆：重复的会被习惯化，无关的会被忽略，
 * 危险的会被主动屏蔽，剩下的才值得记。这个模块把这三件事做成可配置、可观测的决策，
 * 而不是散落在各处的 if 判断。
 *
 * 四类决策：
 * - `shield`：命中认知屏蔽，不入库（来源 / 关键词 / 正则）
 * - `drop`：显著性过低且来源可信度低，不入库（噪声）
 * - `merge`：与窗口内已有事件同题（数字归一化后仍高度相似），只累加计数，不新增条目
 * - `keep`：正常入库，并记录显著性供忘却扫描使用
 *
 * 保守原则：真人对话（`source_weight = 1`）永远不会因为显著性低被丢弃，只会被降权。
 */
import type { DaughterConfig, EventRecord, ISOTime } from '../types.js';
import { clamp01, diceSimilarity } from '../util.js';

export type FilterAction = 'keep' | 'merge' | 'drop' | 'shield';

export interface FilterDecision {
  action: FilterAction;
  reason: string;
  /** 0..1，写入事件的显著性，供忘却扫描与面板展示 */
  salience: number;
  /** 来源可信度，同时用于检索降权 */
  sourceWeight: number;
  /** merge 时的合并目标 */
  targetId?: string;
}

export type FilterStatKind = 'keep' | 'merge' | 'drop' | 'shield';

const DEFAULT_SOURCE_WEIGHT = 1;
const REGEX_CACHE = new Map<string, RegExp | null>();

export function sourceWeightOf(source: string, config: DaughterConfig): number {
  const weights = config.filter.source_weights as Record<string, number>;
  const value = weights[source];
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : DEFAULT_SOURCE_WEIGHT;
}

function compile(pattern: string): RegExp | null {
  if (REGEX_CACHE.has(pattern)) return REGEX_CACHE.get(pattern)!;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(pattern, 'u');
  } catch {
    compiled = null;
  }
  REGEX_CACHE.set(pattern, compiled);
  return compiled;
}

/**
 * 事件签名：数字与数量单位一起归一化，
 * 避免"好感度涨到 58410547"和"涨到 5.8 万亿""涨到 1.2 亿"被当成三件事。
 */
export function eventSignature(event: Pick<EventRecord, 'title' | 'summary'>): string {
  return `${event.title}\n${event.summary}`
    .replace(/\d+(?:[.,]\d+)?\s*(?:万亿|亿|万|千|百|k|m|b|%|次|个|条|分钟|小时)?/gi, '#')
    // 标题会在 24 字截断，长数字被切掉一半时补个省略号，这里一并抹平
    .replace(/#(?:…|\.\.\.)/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 认知屏蔽：命中即不入库 */
export function shieldReason(
  event: Pick<EventRecord, 'source' | 'title' | 'summary'>,
  config: DaughterConfig,
): string | null {
  const shield = config.filter.shield;
  if (shield.sources.some((source) => source === event.source)) {
    return `来源「${event.source}」在屏蔽清单`;
  }
  const text = `${event.title}\n${event.summary}`;
  for (const keyword of shield.keywords) {
    if (keyword && text.includes(keyword)) return `命中屏蔽词「${keyword}」`;
  }
  for (const pattern of shield.patterns) {
    if (!pattern) continue;
    const compiled = compile(pattern);
    if (compiled?.test(text)) return `命中屏蔽规则 ${pattern}`;
  }
  return null;
}

/**
 * 显著性 = 情绪强度 × 0.34 + 新颖性 × 0.28 + 社交性 × 0.24 + 信息量 × 0.14，
 * 再乘来源可信度。四项都能从事件本身算出来，不依赖模型调用。
 */
export function salienceOf(
  event: Pick<EventRecord, 'title' | 'summary' | 'participants' | 'emotionAtTime' | 'source'>,
  recent: EventRecord[],
  config: DaughterConfig,
): number {
  const emotional = clamp01(event.emotionAtTime.intensity * 0.8 + Math.abs(event.emotionAtTime.pleasure) * 0.4);
  const signature = eventSignature(event);
  let maxSimilarity = 0;
  for (const other of recent) {
    const similarity = diceSimilarity(signature, eventSignature(other));
    if (similarity > maxSimilarity) maxSimilarity = similarity;
  }
  const novelty = clamp01(1 - maxSimilarity);
  const social = event.participants.includes('user') ? 1 : 0.5;
  const info = clamp01((event.title.length + event.summary.length) / 120);

  const base = emotional * 0.34 + novelty * 0.28 + social * 0.24 + info * 0.14;
  return clamp01(base * sourceWeightOf(event.source, config));
}

/** 写入前的唯一决策点 */
export function decideIngest(
  event: EventRecord,
  recent: EventRecord[],
  config: DaughterConfig,
  now: ISOTime,
): FilterDecision {
  const sourceWeight = sourceWeightOf(event.source, config);
  const salience = salienceOf(event, recent, config);
  const base = { salience, sourceWeight };

  if (!config.filter.enabled) {
    return { action: 'keep', reason: '滤网已关闭', ...base };
  }

  const shield = shieldReason(event, config);
  if (shield) return { action: 'shield', reason: shield, ...base };

  const habituation = config.filter.habituation;
  const windowMs = Math.max(1, habituation.window_minutes) * 60_000;
  const nowMs = Date.parse(now);

  // 同源爆发抑制：外部来源短时间灌进来一串（刷视频、切窗口、连发通知），
  // 前几条还可能值得记，第五条只是"又在刷"。习惯化按"内容像不像"合并，
  // 但模板相同、条目不同的输入相似度不够 0.9，于是照样一条条写库——
  // 真实库里抖音内容一度占到事件总数的一半以上，且全是零召回。这里改按条数设上限。
  const burst = config.filter.burst;
  if (!burst.exempt_sources.includes(event.source)) {
    const burstWindowMs = Math.max(1, burst.window_minutes) * 60_000;
    let sameSource = 0;
    for (const other of recent) {
      if (other.source !== event.source) continue;
      if (Math.abs(nowMs - Date.parse(other.createdAt)) > burstWindowMs) continue;
      sameSource += 1;
    }
    if (sameSource >= burst.max_keep) {
      return {
        action: 'drop',
        reason: `同源「${event.source}」在 ${burst.window_minutes} 分钟内已有 ${sameSource} 条，按爆发抑制丢弃`,
        ...base,
      };
    }
  }

  let duplicate: { event: EventRecord; similarity: number } | null = null;
  for (const other of recent) {
    if (other.source !== event.source) continue;
    if (Math.abs(nowMs - Date.parse(other.createdAt)) > windowMs) continue;
    const similarity = diceSimilarity(eventSignature(event), eventSignature(other));
    if (!duplicate || similarity > duplicate.similarity) duplicate = { event: other, similarity };
  }

  if (duplicate && duplicate.similarity >= 0.9) {
    const repeats = (duplicate.event.mergedCount ?? 0) + 1;
    if (repeats > habituation.max_repeat) {
      return {
        action: 'drop',
        reason: `与 ${duplicate.event.id} 同题重复 ${repeats} 次，已习惯化`,
        targetId: duplicate.event.id,
        ...base,
      };
    }
    return {
      action: 'merge',
      reason: `与 ${duplicate.event.id} 同题（相似度 ${duplicate.similarity.toFixed(2)}），合并计数`,
      targetId: duplicate.event.id,
      ...base,
    };
  }

  if (salience < config.filter.salience.drop_below && sourceWeight <= 0.5) {
    return {
      action: 'drop',
      reason: `显著性 ${salience.toFixed(2)} 低于门限，且来源可信度 ${sourceWeight.toFixed(2)}`,
      ...base,
    };
  }

  return { action: 'keep', reason: '通过滤网', ...base };
}

export interface ForgetResult {
  archived: number;
  ids: string[];
}

/**
 * 忘却扫描：低显著性 + 从未被想起 + 长期闲置 → 归档。
 * 被想起过的事件即使显著性低也保留，因为"用得上"本身就是价值。
 */
export function forgetSweep(
  events: EventRecord[],
  config: DaughterConfig,
  now: ISOTime,
): ForgetResult {
  if (!config.filter.enabled || !config.filter.forget.enabled) return { archived: 0, ids: [] };
  const nowMs = Date.parse(now);
  const ids: string[] = [];
  for (const event of events) {
    if (event.archived) continue;
    if (event.recallCount > 0) continue;
    // 旧数据没有 salience：按来源保守估计，低可信来源更容易被忘却
    const salience = event.salience ?? sourceWeightOf(event.source, config) * 0.4;
    if (salience >= config.filter.forget.min_salience) continue;
    const idleDays = (nowMs - Date.parse(event.lastRecalledAt ?? event.createdAt)) / 86_400_000;
    if (idleDays < config.filter.forget.idle_days) continue;
    ids.push(event.id);
  }
  return { archived: ids.length, ids };
}
