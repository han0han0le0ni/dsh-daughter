import type { DaughterConfig, L4Contextual, L5State, PadState, PersonaBundle, SubPersona } from '../types.js';
import { clamp01, clampPad } from '../util.js';

const POSITIVE_WORDS = [
  '好', '喜欢', '开心', '高兴', '谢谢', '厉害', '不错', '爱', '舒服', '顺利', '棒',
  '满意', '放心', '期待', '温暖', '踏实', '有意思', '感动', '轻松', '靠谱',
];
/**
 * 负向词表。早期只有 11 个，真实库 56 条事件全是正极性——
 * "我怕又失败了""撑不住了"这类最典型的话一个都没命中，情绪维度等于常数。
 */
const NEGATIVE_WORDS = [
  '难受', '难过', '烦', '累', '压力', '讨厌', '生气', '失望', '焦虑', '崩溃', '疼',
  '害怕', '担心', '紧张', '委屈', '孤独', '想哭', '没意思', '无语', '搞砸', '完蛋',
  '撑不住', '受不了', '自责', '愧疚', '后悔', '心累', '失败', '算了', '唉',
];
/** 否定词：紧挨在正面词前面时，这一处命中作废——"不开心"不是开心 */
const NEGATION_WORDS = ['不', '没', '别', '无'];
const STRESS_WORDS = ['压力', '烦', '累', '急', '赶', ' deadline', '加班', '吵架', '崩溃', '来不及', '心累', '撑不住', '搞砸', '担心'];
const FATIGUE_WORDS = ['困', '累', '熬夜', '失眠', '没睡', '疲惫', '睡不着', '没力气'];
const BOUNDARY_WORDS = ['滚', '闭嘴', '别管', '烦死了'];

/** 单轮情绪推进幅度。0.16 时实测 pleasure 几乎不动（均值 |p|≈0.11），情绪维度在检索里退化成常数 */
const PAD_GAIN = 0.3;

export function createInitialL5(
  characterId: string,
  sessionId: string,
  now: string,
  persona: PersonaBundle,
  overdraft: number,
): L5State {
  return {
    sessionId,
    characterId,
    emotion: { ...persona.l1.moodBaseline },
    stress: 0.2,
    safety: 0.7,
    fatigue: 0.15,
    emotionalOverdraft: overdraft,
    boundary: 0.6,
    activeSubPersonaId: selectSubpersona(persona.l4).id,
    lastTickAt: now,
    snapshotAt: now,
    schemaVersion: 1,
  };
}

/**
 * 跨会话接力：换对话框后不是从基线重新出生，而是把上一段的 L5 按闲置时长向基线回落。
 *
 * 隔五分钟基本原样（还没到 idle_hours），隔一夜明显平复但不会归零——人换房间不清空情绪，
 * 但也不会带着上周的疲惫。是否跨会话、是否跨工作区由调用方按配置决定，这里只管衰减。
 */
export function carryL5(
  previous: L5State,
  sessionId: string,
  now: string,
  persona: PersonaBundle,
  config: DaughterConfig,
): L5State {
  const relax = config.emotion_relax;
  const gapHours = (Date.parse(now) - Date.parse(previous.lastTickAt)) / 3_600_000;
  const idleHours = Number.isFinite(gapHours) && gapHours > 0 ? gapHours : 0;
  // 与 relaxL5 同一套复利：连续对话里几乎不动，隔夜才明显回落
  const ratio =
    relax.enabled && relax.rate_per_hour > 0 && idleHours >= relax.idle_hours
      ? 1 - Math.pow(1 - relax.rate_per_hour, idleHours)
      : 0;
  const baseline = persona.l1.moodBaseline;
  const pull = (value: number, target: number): number => Number((value + (target - value) * ratio).toFixed(4));

  const next: L5State = {
    ...previous,
    sessionId,
    emotion: {
      pleasure: pull(previous.emotion.pleasure, baseline.pleasure),
      arousal: pull(previous.emotion.arousal, baseline.arousal),
      dominance: pull(previous.emotion.dominance, baseline.dominance),
    },
    stress: pull(previous.stress, relax.stress_baseline),
    fatigue: pull(previous.fatigue, relax.fatigue_baseline),
    safety: pull(previous.safety, relax.safety_baseline),
    // 生理信号是"当时那个桌宠"的状态，跨会话不继承，等新会话自己上报
    body: null,
    lastTickAt: now,
    snapshotAt: now,
    schemaVersion: 1,
  };
  next.stressHighSince = next.stress >= 0.7 ? previous.stressHighSince ?? now : undefined;
  next.safetyLowSince = next.safety <= 0.35 ? previous.safetyLowSince ?? now : undefined;
  return next;
}

export function updateL5(prev: L5State, text: string, now: string, persona: PersonaBundle): L5State {
  const detail = analyzeSentiment(text);
  const polarity = detail.polarity;
  const strength = detail.strength;
  const exclamatory = /[!！?？]/.test(text);
  const stressDelta = countHits(text, STRESS_WORDS) > 0 ? 0.12 : -0.04;
  const fatigueDelta = countHits(text, FATIGUE_WORDS) > 0 ? 0.06 : 0.008;

  const nextEmotion: PadState = {
    // 幅度 0.3 × 强度：0.16 时实测平均 |pleasure| 只有 0.11，情绪维度在打分里等于常数
    pleasure: clampPad(prev.emotion.pleasure * 0.9 + polarity * strength * PAD_GAIN),
    arousal: clampPad(prev.emotion.arousal * 0.92 + (exclamatory ? 0.18 : -0.02)),
    dominance: clampPad(prev.emotion.dominance * 0.95 + (polarity < 0 ? -0.04 : 0.02)),
  };

  const nextStress = clamp01(prev.stress + stressDelta);
  const nextSafety = clamp01(prev.safety + (polarity < 0 ? -0.06 : 0.02));
  const nextFatigue = clamp01(prev.fatigue + fatigueDelta);
  const nextBoundary = clamp01(prev.boundary + (countHits(text, BOUNDARY_WORDS) > 0 ? -0.08 : 0.005));

  return {
    ...prev,
    emotion: nextEmotion,
    stress: nextStress,
    safety: nextSafety,
    fatigue: nextFatigue,
    boundary: nextBoundary,
    stressHighSince: nextStress >= 0.7 ? prev.stressHighSince ?? now : undefined,
    safetyLowSince: nextSafety <= 0.35 ? prev.safetyLowSince ?? now : undefined,
    activeSubPersonaId: selectSubpersona(persona.l4, prev.activeSubPersonaId).id,
    snapshotAt: now,
    lastTickAt: now,
  };
}

export function selectSubpersona(l4: L4Contextual, preferredId?: string): SubPersona {
  const personas = l4.subPersonas.filter((item) => item.weight > 0);
  if (preferredId) {
    const found = personas.find((item) => item.id === preferredId);
    if (found) return found;
  }
  if (personas.length === 0) {
    return { id: 'alone', weight: 1, tone: '安静', disclosureLevel: 0.5, boundaries: [] };
  }
  return personas.reduce((best, item) => (item.weight > best.weight ? item : best), personas[0]!);
}

export interface SentimentDetail {
  polarity: number;
  strength: number;
  /** 所有命中的情绪词（含被否定的正面词），供日志排查 */
  hits: string[];
  /** 命中的否定词 */
  negations: string[];
  /** 未被否定的正面词 */
  positives: string[];
  /** 命中的负面词 */
  negatives: string[];
}

/** 同一句话里至少有一次未被否定的出现，才算正面命中 */
function hasUnnegated(text: string, word: string): boolean {
  let from = 0;
  for (;;) {
    const index = text.indexOf(word, from);
    if (index < 0) return false;
    if (!isNegated(text, index)) return true;
    from = index + 1;
  }
}

function matchedWords(text: string, words: string[]): string[] {
  return words.filter((word) => Boolean(word) && text.includes(word));
}

/**
 * 情绪识别明细（A1 日志层）：极性/强度仍然是原公式的输出，
 * 只是把命中词、否定词一并带出来，供 logs/polarity 离线标定。
 * 不改 `sentimentPolarity` / `sentimentStrength` 的返回语义。
 */
export function analyzeSentiment(text: string): SentimentDetail {
  const allPositive = matchedWords(text, POSITIVE_WORDS);
  const positives = allPositive.filter((word) => hasUnnegated(text, word));
  const negatives = matchedWords(text, NEGATIVE_WORDS);
  const negations = matchedWords(text, NEGATION_WORDS);

  const pos = weightedHits(text, POSITIVE_WORDS, true);
  // 被否定的正面词反过来算负面："不开心""没意思""不舒服"都在说不好
  const neg = weightedHits(text, NEGATIVE_WORDS) + negatedHits(text, POSITIVE_WORDS);
  const polarity = pos === 0 && neg === 0 ? 0 : clampPad((pos - neg) / Math.max(1, pos + neg));

  const total = weightedHits(text, POSITIVE_WORDS) + weightedHits(text, NEGATIVE_WORDS);
  const strength = clamp01(total / 2);

  return {
    polarity,
    strength,
    hits: [...new Set([...allPositive, ...negatives])],
    negations,
    positives,
    negatives,
  };
}

export function sentimentPolarity(text: string): number {
  return analyzeSentiment(text).polarity;
}

/**
 * 词典极性。单字词（好/爱/棒/累/烦/疼）在中文里太容易误命中——
 * "你好""好像""还好"都会算成正面，实测让 pleasure 长期贴正半轴、方差几乎为零，
 * 所以单字给 0.35 的权重，多字词才按 1 计。
 */
function weightedHits(text: string, words: string[], skipNegated = false): number {
  let score = 0;
  for (const word of words) {
    if (!word) continue;
    let from = 0;
    let hit = false;
    while (true) {
      const index = text.indexOf(word, from);
      if (index < 0) break;
      if (skipNegated && isNegated(text, index)) {
        from = index + 1;
        continue;
      }
      hit = true;
      break;
    }
    if (hit) score += word.length >= 2 ? 1 : 0.35;
  }
  return score;
}

/**
 * 词前面是不是否定：允许中间隔一个程度副词——"不太舒服""没那么好"同样是否定，
 * 只认紧挨着的前一个字会漏掉最常见的那几种说法。
 */
function isNegated(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - 2), index);
  return NEGATION_WORDS.some((negation) => window.includes(negation));
}

/** 被否定的正面词按负面计（"不开心""没意思"），权重与命中口径保持一致 */
function negatedHits(text: string, words: string[]): number {
  let score = 0;
  for (const word of words) {
    if (!word) continue;
    let from = 0;
    while (true) {
      const index = text.indexOf(word, from);
      if (index < 0) break;
      if (isNegated(text, index)) {
        score += word.length >= 2 ? 0.6 : 0.2;
        break;
      }
      from = index + 1;
    }
  }
  return score;
}

/**
 * 情绪强度 0..1：极性只说方向，"你好"和"今天好累压力好大"都是 |1|，
 * 必须再乘一个强度，否则单字寒暄和真正的情绪波动在 L5 里等权。
 * 两个多字词命中即视为满强度。
 */
export function sentimentStrength(text: string): number {
  return analyzeSentiment(text).strength;
}

export function countHits(text: string, words: string[]): number {
  let count = 0;
  for (const word of words) {
    if (word && text.includes(word)) count += 1;
  }
  return count;
}
