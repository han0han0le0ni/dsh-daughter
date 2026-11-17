import { clamp01 } from '../util.js';
const DIAGNOSIS_LABELS = [
    '抑郁症',
    '焦虑症',
    '创伤后应激',
    'PTSD',
    '人格障碍',
    '精神分裂',
    '强迫症',
    '自闭症',
    '躁郁',
    '双相',
];
/** 诊断性标签检查：仅用于日志与拦截，不做任何推断 */
export function containsDiagnosisLabel(text) {
    for (const label of DIAGNOSIS_LABELS) {
        if (text.includes(label))
            return label;
    }
    return null;
}
export function evaluateSafety(l5, previous, config, now) {
    if (!config.safety.enabled) {
        return {
            verdict: { level: 0, allowTools: true, suppressExpressiveness: false, reasons: [] },
            state: { ...previous, level: 0, reasons: [], triggers: [] },
        };
    }
    const th = config.safety.thresholds;
    const h = config.safety.hysteresis;
    const prevLevel = previous.level;
    const reasons = [];
    const stressDurationMs = l5.stressHighSince ? Date.parse(now) - Date.parse(l5.stressHighSince) : 0;
    const stressActive = prevLevel >= 1 ? l5.stress >= th.stress_level1 - h : l5.stress >= th.stress_level1;
    const level1 = stressActive && stressDurationMs >= config.safety.level1_min_duration_min * 60_000;
    if (level1)
        reasons.push(`压力偏高已持续 ${Math.round(stressDurationMs / 60_000)} 分钟`);
    const safetyLow = prevLevel >= 2 ? l5.safety <= th.safety_level2 + h : l5.safety <= th.safety_level2;
    const fatigueHigh = prevLevel >= 2 ? l5.fatigue >= th.fatigue_level2 - h : l5.fatigue >= th.fatigue_level2;
    const level2 = safetyLow || fatigueHigh;
    if (safetyLow)
        reasons.push('安全感偏低');
    if (fatigueHigh)
        reasons.push('疲劳偏高');
    const overdraftHigh = prevLevel >= 3 ? l5.emotionalOverdraft >= th.overdraft_level3 - h : l5.emotionalOverdraft >= th.overdraft_level3;
    const level3 = overdraftHigh;
    if (overdraftHigh)
        reasons.push('情感透支偏高');
    const level = (level3 ? 3 : level2 ? 2 : level1 ? 1 : 0);
    const state = {
        level,
        reasons,
        overstressDurationMs: stressDurationMs,
        functionalImpairment: clamp01((l5.stress + l5.fatigue + (1 - l5.safety)) / 3),
        triggers: reasons,
        since: level !== previous.level ? now : previous.since,
    };
    return {
        verdict: {
            level,
            allowTools: level < 2,
            suppressExpressiveness: level >= 1,
            reasons,
        },
        state,
    };
}
