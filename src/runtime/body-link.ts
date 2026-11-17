/**
 * 桌宠 ↔ 角色的「弱耦合」身体通道。
 *
 * 设计约束（与 §12 连接契约一致）：
 * 1. 桌宠只是可选的生理信号源，缺席时本模块全部返回原值，插件行为与没有桌宠一致；
 * 2. 外部信号只抬升 L5 的 fatigue / stress，不写回 L1–L4，也不覆盖对话驱动的值；
 * 3. 信号带时间戳，超过 stale_ms 自动失效，疲劳/压力自然回落；
 * 4. 反向只做「表现层」选择（按 PAD 挑 MOT 动作），不写回游戏存档。
 */
import type { AssetPackage, BodySignal, DaughterConfig, L5State, PadState } from '../types.js';
import { clamp01, padDistance } from '../util.js';

export type BodyLinkConfig = DaughterConfig['vpet']['body_link'];

/** 从 HTTP 载荷里取归一化后的生理信号；字段缺失或非法时返回 null（旧版 bridge 兼容） */
export function normalizeBodySignal(raw: unknown, at: string, source: BodySignal['source'] = 'vpet'): BodySignal | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const strength = toUnit(input.strengthPct ?? input.strength);
  const feeling = toUnit(input.feelingPct ?? input.feeling);
  if (strength === null && feeling === null) return null;
  return {
    strength: strength ?? 1,
    feeling: feeling ?? 1,
    source,
    at,
  };
}

function toUnit(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  // 允许 0..100 的百分比与 0..1 的小数两种写法
  return clamp01(number > 1 ? number / 100 : number);
}

/** 外部信号对疲劳/压力的抬升量；失效、关闭或缺失时返回 null */
export function bodyInfluence(
  signal: BodySignal | null | undefined,
  config: BodyLinkConfig,
  now: string,
): { fatigue: number; stress: number } | null {
  if (!config.enabled || !signal) return null;
  const age = Date.parse(now) - Date.parse(signal.at);
  if (!Number.isFinite(age) || age > config.stale_ms || age < -60_000) return null;

  const fatigue = Math.min(config.max_influence, clamp01((1 - clamp01(signal.strength)) * config.fatigue_weight));
  const stress = Math.min(config.max_influence, clamp01((1 - clamp01(signal.feeling)) * config.stress_weight));
  if (fatigue <= 0 && stress <= 0) return null;
  return { fatigue, stress };
}

/**
 * 派生「有效状态」：外部信号只抬升、不降低；返回新对象，入参保持原样。
 * 存盘与写回一律用原始状态，避免外部信号沉淀进人格层。
 */
export function applyBodySignal(l5: L5State, config: BodyLinkConfig, now: string): L5State {
  const influence = bodyInfluence(l5.body ?? null, config, now);
  if (!influence) return l5;

  const fatigue = Math.max(l5.fatigue, influence.fatigue);
  const stress = Math.max(l5.stress, influence.stress);
  if (fatigue === l5.fatigue && stress === l5.stress) return l5;
  return { ...l5, fatigue, stress };
}

export interface MotionCandidate {
  assetId: string;
  motionId: string;
  pad: PadState;
}

/**
 * 反向表现选择：在已固化的 MOT 资产里按 PAD 距离挑最接近当前情绪的一个。
 * 没有任何 `padMatch` 时返回 null，交由调用方走原有逻辑，不做猜测。
 */
export function pickMotionByPad(
  assets: AssetPackage[],
  current: PadState,
): MotionCandidate | null {
  const candidates: MotionCandidate[] = [];
  for (const asset of assets) {
    if (asset.kind !== 'MOT' || asset.status !== 'active' || !asset.padMatch) continue;
    const motionId = typeof asset.payload.motionId === 'string' ? asset.payload.motionId.trim() : '';
    if (!motionId) continue;
    candidates.push({ assetId: asset.id, motionId, pad: asset.padMatch });
  }
  if (candidates.length === 0) return null;

  let best = candidates[0]!;
  let bestDistance = padDistance(current, best.pad);
  for (const candidate of candidates.slice(1)) {
    const distance = padDistance(current, candidate.pad);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
