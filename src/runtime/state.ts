import type { L4Contextual, L5State, PadState, PersonaBundle, SubPersona } from '../types.js';
import { clamp01, clampPad } from '../util.js';

const POSITIVE_WORDS = ['好', '喜欢', '开心', '高兴', '谢谢', '厉害', '不错', '爱', '舒服', '顺利', '棒'];
const NEGATIVE_WORDS = ['难受', '难过', '烦', '累', '压力', '讨厌', '生气', '失望', '焦虑', '崩溃', '疼'];
const STRESS_WORDS = ['压力', '烦', '累', '急', '赶', ' deadline', '加班', '吵架', '崩溃', '来不及'];
const FATIGUE_WORDS = ['困', '累', '熬夜', '失眠', '没睡', '疲惫'];
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

export function updateL5(prev: L5State, text: string, now: string, persona: PersonaBundle): L5State {
  const polarity = sentimentPolarity(text);
  const strength = sentimentStrength(text);
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

export function sentimentPolarity(text: string): number {
  const pos = weightedHits(text, POSITIVE_WORDS);
  const neg = weightedHits(text, NEGATIVE_WORDS);
  if (pos === 0 && neg === 0) return 0;
  return clampPad((pos - neg) / (pos + neg));
}

/**
 * 词典极性。单字词（好/爱/棒/累/烦/疼）在中文里太容易误命中——
 * "你好""好像""还好"都会算成正面，实测让 pleasure 长期贴正半轴、方差几乎为零，
 * 所以单字给 0.35 的权重，多字词才按 1 计。
 */
function weightedHits(text: string, words: string[]): number {
  let score = 0;
  for (const word of words) {
    if (word && text.includes(word)) score += word.length >= 2 ? 1 : 0.35;
  }
  return score;
}

/**
 * 情绪强度 0..1：极性只说方向，"你好"和"今天好累压力好大"都是 |1|，
 * 必须再乘一个强度，否则单字寒暄和真正的情绪波动在 L5 里等权。
 * 两个多字词命中即视为满强度。
 */
export function sentimentStrength(text: string): number {
  const total = weightedHits(text, POSITIVE_WORDS) + weightedHits(text, NEGATIVE_WORDS);
  return clamp01(total / 2);
}

export function countHits(text: string, words: string[]): number {
  let count = 0;
  for (const word of words) {
    if (word && text.includes(word)) count += 1;
  }
  return count;
}
