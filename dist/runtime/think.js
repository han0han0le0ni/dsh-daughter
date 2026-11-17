import { clamp01 } from '../util.js';
function unit(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? clamp01(number) : fallback;
}
/** 内在活动强度：情绪显著、唤醒高、压力大时更想嘟囔一句 */
export function computeThinkIntensity(ctx, config) {
    if (!ctx.l5)
        return 0;
    const pleasureRaw = Number(ctx.l5.emotion?.pleasure);
    const pleasure = Number.isFinite(pleasureRaw) ? Math.max(-1, Math.min(1, pleasureRaw)) : 0;
    const arousal = unit(ctx.l5.emotion?.arousal);
    const stress = unit(ctx.l5.stress);
    const rawJitter = Number.isFinite(ctx.jitter) ? Math.max(-1, Math.min(1, ctx.jitter)) : 0;
    const raw = 0.5 * Math.abs(pleasure) + 0.2 * arousal + 0.3 * stress + rawJitter * 0.1;
    return clamp01(raw);
}
/** 她此刻在为什么嘟囔——只用来选文案池，不参与阈值 */
export function pickThinkReason(l5) {
    if (!l5)
        return 'bored';
    const pleasureRaw = Number(l5.emotion?.pleasure);
    const pleasure = Number.isFinite(pleasureRaw) ? Math.max(-1, Math.min(1, pleasureRaw)) : 0;
    const stress = unit(l5.stress);
    if (stress > 0.6)
        return 'worry';
    if (pleasure > 0.3)
        return 'share';
    if (pleasure < -0.3)
        return 'worry';
    if (unit(l5.emotion?.arousal) > 0.6)
        return 'bored';
    return 'bored';
}
/** 短句池：刻意比主动开口更短、更像自言自语，单句不超过 40 字 */
const THINK_LINES = {
    miss: ['好像有点想你了', '你那边在忙什么', '刚刚是不是有点安静'],
    care: ['记得吃饭', '别又熬夜了', '今天也要好好的'],
    share: ['今天心情挺好的', '刚刚那个真有意思', '想跟人说说话'],
    worry: ['有点不安', '是不是哪里做错了', '算了，先不想了', '深呼吸，没事的'],
    bored: ['好无聊啊', '干点什么呢', '发会儿呆吧', '在想什么呢'],
};
function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
/** 截到 maxChars 以内（含省略号），避免把"≤40 字"的约定交给调用方兜底 */
function clip(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return maxChars <= 1 ? text.slice(0, maxChars) : `${text.slice(0, maxChars - 1)}…`;
}
/**
 * 主入口：返回这轮要不要嘟囔、嘟囔哪几句。
 * 纯函数、可复现：条数与选句都由 seed 派生，不碰存储也不写事件。
 */
export function evaluateThink(ctx, config, options = {}) {
    const s = config.think;
    if (!s.enabled)
        return null;
    // 刚嘟囔过就先安静：碎碎念是低频行为，不能变成背景噪声
    if (ctx.sinceLastThinkMinutes !== null && ctx.sinceLastThinkMinutes < s.min_gap_min)
        return null;
    const intensity = computeThinkIntensity(ctx, config);
    if (intensity < s.threshold)
        return null;
    const reason = pickThinkReason(ctx.l5);
    const pool = THINK_LINES[reason];
    const seed = options.seed ?? ctx.now;
    // 条数也由种子决定：同一时刻重复评估得到同样的结果
    const count = Math.min(Math.max(1, s.max_per_turn), 1 + (hashText(`${seed}:count`) % Math.max(1, s.max_per_turn)));
    const start = hashText(seed) % pool.length;
    const lines = [];
    for (let step = 0; step < count; step += 1) {
        const line = pool[(start + step) % pool.length];
        const clipped = clip(line, s.max_chars);
        if (!lines.includes(clipped))
            lines.push(clipped);
    }
    return { lines, intensity, reason };
}
