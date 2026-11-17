function pad(value) {
    return value.toFixed(2);
}
/** 纯函数：按压力/疲劳优先，其次愉悦度与唤醒度决定动作；平静时返回 null。 */
export function selectMoodMotion(l5) {
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
    lastAt = 0;
    lastBand = null;
    minIntervalMs;
    repeatIntervalMs;
    constructor(options = {}) {
        this.minIntervalMs = options.minIntervalMs ?? 20_000;
        this.repeatIntervalMs = options.repeatIntervalMs ?? 120_000;
    }
    next(l5, nowMs) {
        const motion = selectMoodMotion(l5);
        if (!motion)
            return null;
        if (nowMs - this.lastAt < this.minIntervalMs)
            return null;
        if (motion.band === this.lastBand && nowMs - this.lastAt < this.repeatIntervalMs)
            return null;
        this.lastAt = nowMs;
        this.lastBand = motion.band;
        return motion;
    }
}
