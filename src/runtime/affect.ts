import type { BondEmotion, EmotionMix, L2Relationship, L5State, PadState, PluginContext } from '../types.js';
import { clamp01 } from '../util.js';
import type { SentimentDetail } from './state.js';

/** 词表只负责把命中词分给不同成分；强度仍沿用统一的极性与程度词结果 */
const SADNESS_WORDS = ['难过', '难受', '委屈', '孤独', '想哭', '失望', '心累', '撑不住', '后悔', '愧疚', '自责', '没意思'];
const ANGER_WORDS = ['烦', '讨厌', '生气', '滚', '闭嘴', '烦死了', '受不了'];
const FEAR_WORDS = ['害怕', '担心', '紧张', '焦虑', '崩溃', '怕', '完蛋', '失败'];
const DISGUST_WORDS = ['恶心', '讨厌', '无语'];

const MIX_LABELS: Array<[keyof EmotionMix, string]> = [
  ['joy', '喜悦'],
  ['sadness', '悲伤'],
  ['anger', '怒气'],
  ['fear', '不安'],
  ['disgust', '反感'],
  ['surprise', '惊讶'],
];
const BOND_LABELS: Array<[keyof Omit<BondEmotion, 'updatedAt'>, string]> = [
  ['affection', '亲近'],
  ['trust', '信任'],
  ['hurt', '委屈'],
  ['resentment', '怨意'],
  ['longing', '想念'],
];

/** 旧快照没有心情向量时，从 PAD 做一次保守投影；这只是兼容入口，不替代共存成分 */
export function mixFromPad(pad: PadState): EmotionMix {
  const negative = Math.max(0, -pad.pleasure);
  const arousal = Math.max(0, pad.arousal);
  return {
    joy: clamp01(Math.max(0, pad.pleasure)),
    sadness: clamp01(negative * (1 - arousal * 0.4)),
    anger: clamp01(negative * arousal * Math.max(0, pad.dominance)),
    fear: clamp01(negative * arousal * Math.max(0, -pad.dominance)),
    disgust: 0,
    surprise: clamp01(arousal * 0.15),
  };
}

/** 跨会话/闲置回落：所有成分独立向基线靠拢，不做归一化，也不抹掉共存关系 */
export function relaxEmotionMix(previous: EmotionMix, baseline: EmotionMix, ratio: number): EmotionMix {
  const pull = (value: number, target: number) => clamp01(value + (target - value) * ratio);
  return {
    joy: pull(previous.joy, baseline.joy),
    sadness: pull(previous.sadness, baseline.sadness),
    anger: pull(previous.anger, baseline.anger),
    fear: pull(previous.fear, baseline.fear),
    disgust: pull(previous.disgust, baseline.disgust),
    surprise: pull(previous.surprise, baseline.surprise),
  };
}

/** 一轮对话只衰减 10%，新成分独立叠加：先说开心、再讲难过，两种心情都还在 */
export function updateEmotionMix(
  previous: EmotionMix,
  detail: SentimentDetail,
  exclamatory: boolean,
): EmotionMix {
  const positive = Math.max(0, detail.polarity) * detail.strength;
  const negative = Math.max(0, -detail.polarity) * detail.strength;
  const has = (words: string[]) => words.some((word) => detail.negatives.includes(word));
  const categorized = has(SADNESS_WORDS) || has(ANGER_WORDS) || has(FEAR_WORDS) || has(DISGUST_WORDS);

  return {
    joy: clamp01(previous.joy * 0.9 + positive * 0.35),
    sadness: clamp01(previous.sadness * 0.9 + negative * (has(SADNESS_WORDS) ? 0.3 : categorized ? 0 : 0.12)),
    anger: clamp01(previous.anger * 0.9 + negative * (has(ANGER_WORDS) ? 0.32 : 0)),
    fear: clamp01(previous.fear * 0.9 + negative * (has(FEAR_WORDS) ? 0.32 : 0)),
    disgust: clamp01(previous.disgust * 0.9 + negative * (has(DISGUST_WORDS) ? 0.24 : 0)),
    surprise: clamp01(previous.surprise * 0.9 + (exclamatory ? 0.12 : 0)),
  };
}

/** 没有对象级存档时，由既有 L2 关系基线推导；不写盘也能让旧角色立刻使用 */
export function bondFromL2(l2: L2Relationship, now: string): BondEmotion {
  return {
    affection: clamp01(0.2 + l2.relationshipDepth * 0.8),
    trust: clamp01(l2.trustBaseline),
    hurt: 0,
    resentment: 0,
    longing: 0,
    updatedAt: now,
  };
}

/** 当前宿主只给出对话对象类型：主人与陌生人分开记，独处时不注入对人情感 */
export function bondForAudience(
  l2: L2Relationship,
  audience: PluginContext['audience'],
  now: string,
): BondEmotion | undefined {
  if (audience === 'alone') return undefined;
  const key = audience === 'to_stranger' ? 'stranger' : 'user';
  return l2.bonds?.[key] ?? bondFromL2(l2, now);
}

/**
 * 对人的情感是慢变量：一次争吵会留下委屈和怨意，但只轻微碰亲近。
 * 后续示好能修复信任，却不会把旧伤直接清零，因此"还在乎，也还在生气"可以持续存在。
 * 没有有效情绪词时返回原对象，调用方据此避免无意义写盘。
 */
export function updateBondEmotion(previous: BondEmotion, detail: SentimentDetail, now: string): BondEmotion {
  const positive = Math.max(0, detail.polarity) * detail.strength;
  const negative = Math.max(0, -detail.polarity) * detail.strength;
  if (positive <= 0 && negative <= 0) return previous;
  const angry = ANGER_WORDS.some((word) => detail.negatives.includes(word));

  return {
    affection: clamp01(previous.affection + positive * 0.04 - negative * 0.005),
    trust: clamp01(previous.trust + positive * 0.025 - negative * 0.04),
    hurt: clamp01(previous.hurt + negative * 0.08 - positive * 0.025),
    resentment: clamp01(previous.resentment + negative * (angry ? 0.1 : 0.035) - positive * 0.015),
    longing: clamp01(previous.longing + positive * 0.02 - negative * 0.01),
    updatedAt: now,
  };
}

/**
 * 把"心情 × 对人情感"翻成语气和说话方式。
 * 冲突成分必须并列写出，否则模型很容易把高亲近 + 高怨意误读成中性。
 */
export function buildAffectHint(l5: L5State, bond?: BondEmotion): string {
  const mix = l5.emotionMix ?? mixFromPad(l5.emotion);
  const moods = MIX_LABELS.filter(([key]) => mix[key] >= 0.18)
    .sort((a, b) => mix[b[0]] - mix[a[0]])
    .slice(0, 3)
    .map(([key, label]) => `${label} ${mix[key].toFixed(2)}`);
  const lines: string[] = [];
  if (moods.length > 0) {
    lines.push(`心情成分：${moods.join('、')}。不同成分可以并存，不要把它们平均成平静。`);
  }

  let bondConflict = false;
  if (bond) {
    const feelings = BOND_LABELS.filter(([key]) => bond[key] >= 0.15)
      .sort((a, b) => bond[b[0]] - bond[a[0]])
      .map(([key, label]) => `${label} ${bond[key].toFixed(2)}`);
    bondConflict = bond.affection >= 0.4 && (bond.resentment >= 0.2 || bond.hurt >= 0.25);
    if (feelings.length > 0) {
      lines.push(`对对方的情感：${feelings.join('、')}。${bondConflict ? '亲近与不满可以同时成立。' : ''}`);
    }
  }

  const tones: string[] = [];
  if (bondConflict) tones.push('仍可以关心对方，但允许带一点刺；不要强迫自己温柔或冷漠');
  if (mix.joy >= 0.25 && mix.sadness >= 0.25) tones.push('可以欣慰里带一点难过，不必装成单纯开心');
  if (mix.anger >= 0.35) tones.push('不满可以说直接些，但不攻击人格');
  if (mix.fear >= 0.35) tones.push('不确定的地方多确认，不要装得笃定');
  if (l5.fatigue >= 0.65 || l5.stress >= 0.7) tones.push('回复稍短，少讲大道理');
  if (tones.length === 0 && bond && bond.affection >= 0.6) tones.push('语气自然亲近，不必刻意客套');
  if (tones.length > 0) lines.push(`语气：${tones.slice(0, 2).join('；')}。`);
  return lines.join('\n');
}
