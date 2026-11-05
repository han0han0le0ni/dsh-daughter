import type { DaughterConfig, L5State, SafetyState, SafetyVerdict } from '../types.js';
/** 诊断性标签检查：仅用于日志与拦截，不做任何推断 */
export declare function containsDiagnosisLabel(text: string): string | null;
export declare function evaluateSafety(l5: L5State, previous: SafetyState, config: DaughterConfig, now: string): {
    verdict: SafetyVerdict;
    state: SafetyState;
};
