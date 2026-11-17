/**
 * PAD → 桌宠动作：把当前情绪状态映射成一个可解释的桌宠动画。
 *
 * 只使用 VPet GraphType 中确实存在的成员（Say / Touch_Head / Sleep），
 * 避免因枚举名不存在而回落到默认动画。是否真正下发由 MoodMotionGate 控制，
 * 防止每轮对话都抢走桌宠的自主活动。
 */
import type { L5State } from '../types.js';

export type MoodBand = 'tired' | 'joy' | 'low';

export interface MoodMotion {
  band: MoodBand;
  graph: string;
  loops: number;
  reason: string;
}

export interface MoodMotionGateOptions {
  /** 任意两次情绪动作的最小间隔 */
  minIntervalMs?: number;
  /** 同一情绪带重复触发的最小间隔 */
  repeatIntervalMs?: number;
}

function pad(value: number): string {
  return value.toFixed(2);
}

/** 纯函数：按压力/疲劳优先，其次愉悦度与唤醒度决定动作；平静时返回 null。 */
export function selectMoodMotion(
  l5: Pick<L5State, 'emotion' | 'stress' | 'fatigue'>,
): MoodMotion | null {
  const { pleasure, arousal } = l5.emotion;

  if (l5.fatigue >= 0.7 || l5.stress >= 0.75) {
    return {
      band: 'tired',
      graph: 'Sleep',
      loops: 1,
      reason: `疲劳 ${pad(l5.fatigue)} / 压力 ${pad(l5.stress)}`,
    };
  }

  if (pleasure >= 0.2 && arousal >= -0.05) {
    return {
      band: 'joy',
      graph: 'Touch_Head',
      loops: 1,
      reason: `愉悦 ${pad(pleasure)} / 唤醒 ${pad(arousal)}`,
    };
  }

  if (pleasure <= -0.25) {
    return {
      band: 'low',
      graph: 'Say',
      loops: 1,
      reason: `愉悦 ${pad(pleasure)} / 唤醒 ${pad(arousal)}`,
    };
  }

  return null;
}

/** 带节流的情绪动作选择器：状态跨带时较快响应，同带重复则显著放慢。 */
export class MoodMotionGate {
  private lastAt = 0;
  private lastBand: MoodBand | null = null;
  private readonly minIntervalMs: number;
  private readonly repeatIntervalMs: number;

  constructor(options: MoodMotionGateOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 20_000;
    this.repeatIntervalMs = options.repeatIntervalMs ?? 120_000;
  }

  next(l5: Pick<L5State, 'emotion' | 'stress' | 'fatigue'>, nowMs: number): MoodMotion | null {
    const motion = selectMoodMotion(l5);
    if (!motion) return null;
    if (nowMs - this.lastAt < this.minIntervalMs) return null;
    if (motion.band === this.lastBand && nowMs - this.lastAt < this.repeatIntervalMs) return null;

    this.lastAt = nowMs;
    this.lastBand = motion.band;
    return motion;
  }
}
