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
export type BodyLinkConfig = DaughterConfig['vpet']['body_link'];
/** 从 HTTP 载荷里取归一化后的生理信号；字段缺失或非法时返回 null（旧版 bridge 兼容） */
export declare function normalizeBodySignal(raw: unknown, at: string, source?: BodySignal['source']): BodySignal | null;
/** 外部信号对疲劳/压力的抬升量；失效、关闭或缺失时返回 null */
export declare function bodyInfluence(signal: BodySignal | null | undefined, config: BodyLinkConfig, now: string): {
    fatigue: number;
    stress: number;
} | null;
/**
 * 派生「有效状态」：外部信号只抬升、不降低；返回新对象，入参保持原样。
 * 存盘与写回一律用原始状态，避免外部信号沉淀进人格层。
 */
export declare function applyBodySignal(l5: L5State, config: BodyLinkConfig, now: string): L5State;
export interface MotionCandidate {
    assetId: string;
    motionId: string;
    pad: PadState;
}
/**
 * 反向表现选择：在已固化的 MOT 资产里按 PAD 距离挑最接近当前情绪的一个。
 * 没有任何 `padMatch` 时返回 null，交由调用方走原有逻辑，不做猜测。
 */
export declare function pickMotionByPad(assets: AssetPackage[], current: PadState): MotionCandidate | null;
