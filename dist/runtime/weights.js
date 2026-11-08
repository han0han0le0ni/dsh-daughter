/**
 * 权重化判定：0.00–1.00、两位小数。
 *
 * 旧的档位是单点硬判断（`preference >= 0.15` 才算"喜欢"），数据挪动 0.01，
 * 整行文字就消失或翻面，也没法同时表达"有点喜欢、但更多是习惯"这种混合状态。
 * 这里统一成锚点表：每个档位有明确位置，值落在两档之间时按线性关系分配权重，
 * 结果总和恒为 1.00——一组档位因此可以同时成立（多心情 / 多性格），且都保留两位小数。
 */
/** 两位小数，并夹在 0.00–1.00 */
export function round2(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}
/**
 * 极性强度：0.50 为中性取 0.00，越靠近端点越强，端点取 1.00。
 * 性格各维彼此独立，不做归一化——一个人可以既好奇又黏人，不必此消彼长。
 */
export function poleWeight(value) {
    const unit = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
    return round2(Math.abs(unit - 0.5) * 2);
}
/** 锚点按位置排序（不改调用方传入的数组） */
function ordered(anchors) {
    return [...anchors].sort((a, b) => a.at - b.at);
}
/** 值当前落在哪一档：取 at 不超过该值的最后一个锚点，与旧的硬阈值口径一致 */
export function bucketIndex(value, anchors) {
    const list = ordered(anchors);
    if (list.length === 0)
        return -1;
    const target = Number.isFinite(value) ? value : list[0].at;
    let index = 0;
    for (let i = 0; i < list.length; i += 1) {
        if (target >= list[i].at)
            index = i;
    }
    return index;
}
/**
 * 多标签分布：相邻锚点之间线性过渡，总和恰好 1.00。
 * 用于"可以同时成立"的语义（一件事既让人喜欢、又有点累）。
 */
export function distribute(value, anchors) {
    const list = ordered(anchors);
    if (list.length === 0)
        return [];
    const index = bucketIndex(value, list);
    const target = Number.isFinite(value) ? value : list[index].at;
    const current = list[index];
    const next = list[index + 1];
    const weights = list.map(() => 0);
    if (!next) {
        weights[index] = 1;
    }
    else {
        const span = next.at - current.at;
        const ratio = span > 0 ? Math.min(1, Math.max(0, (target - current.at) / span)) : 1;
        weights[index] = 1 - ratio;
        weights[index + 1] = ratio;
    }
    return settle(list, weights);
}
/**
 * 主档 + 进度：主档恒 ≥ 0.50，剩余权重给下一档，总和 1.00。
 * 用于"同一时刻只有一个阶段"的场景（关系阶段），既保住主档稳定，又能说出在往哪走。
 * 传 fromLabel 时以已存阶段为准，尊重"回退需要低于阈值 0.1"的迟滞。
 */
export function progress(value, anchors, fromLabel) {
    const list = ordered(anchors);
    if (list.length === 0)
        return [];
    const found = fromLabel ? list.findIndex((anchor) => anchor.label === fromLabel) : -1;
    const index = found >= 0 ? found : bucketIndex(value, list);
    const current = list[index];
    const next = list[index + 1];
    if (!next)
        return [{ label: current.label, weight: 1 }];
    const span = next.at - current.at;
    const target = Number.isFinite(value) ? value : current.at;
    const ratio = span > 0 ? Math.min(1, Math.max(0, (target - current.at) / span)) : 1;
    const ahead = round2(Math.min(0.5, ratio * 0.5));
    return [
        { label: current.label, weight: round2(1 - ahead) },
        { label: next.label, weight: ahead },
    ];
}
/** 权重最高的档；并列时取更靠前（锚点更低）的那个 */
export function primary(list) {
    let best = { label: '', weight: 0 };
    for (const item of list) {
        if (item.weight > best.weight)
            best = item;
    }
    return best;
}
/** 按权重从高到低，去掉 0.00 的档 */
export function topLabels(list, count = 3) {
    return [...list]
        .filter((item) => item.weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, count);
}
/** 跨档合计权重：用来表达"喜欢"这种各占几档的语义 */
export function labelWeight(list, labels) {
    const wanted = new Set(labels);
    return round2(list.reduce((total, item) => (wanted.has(item.label) ? total + item.weight : total), 0));
}
/** `喜欢 0.80、中性 0.20`；min 以下的不写，避免一堆 0.01 噪声 */
export function formatWeights(list, options = {}) {
    const min = options.min ?? 0;
    return topLabels(list.filter((item) => item.weight >= min), options.count ?? 3)
        .map((item) => `${item.label} ${item.weight.toFixed(2)}`)
        .join('、');
}
/** 四舍五入会破坏"总和 1.00"，把误差补给最大的一项，保持分布可读可加 */
function settle(anchors, weights) {
    const rounded = weights.map((weight) => round2(weight));
    const sum = rounded.reduce((total, weight) => total + weight, 0);
    const diff = Math.round((1 - sum) * 100) / 100;
    if (diff !== 0) {
        let target = 0;
        for (let i = 1; i < rounded.length; i += 1) {
            if (rounded[i] > rounded[target])
                target = i;
        }
        rounded[target] = round2(rounded[target] + diff);
    }
    return anchors.map((anchor, index) => ({ label: anchor.label, weight: rounded[index] }));
}
/* ------------------------------- 锚点表 ------------------------------- */
/**
 * 事物偏好：preference ∈ [-1, 1]。
 * ±0.50 对应"明确喜欢/不喜欢"，±1.00 才是"很喜欢/很不喜欢"，中间一直有过渡。
 */
export const PREFERENCE_ANCHORS = [
    { label: '很不喜欢', at: -1 },
    { label: '不喜欢', at: -0.5 },
    { label: '中性', at: 0 },
    { label: '喜欢', at: 0.5 },
    { label: '很喜欢', at: 1 },
];
/** 关系阶段：深度 0.00–1.00，与 L2 阶段推进共用同一张表 */
export const STAGE_ANCHORS = [
    { label: 'stranger', at: 0 },
    { label: 'acquaintance', at: 0.15 },
    { label: 'familiar', at: 0.35 },
    { label: 'close', at: 0.65 },
    { label: 'dependent', at: 0.85 },
];
/** 情绪心情：pleasure ∈ [-1, 1]，±0.25 起才开始算"轻快/偏低落"，与旧阈值对齐 */
export const MOOD_ANCHORS = [
    { label: '低落', at: -1 },
    { label: '偏低落', at: -0.25 },
    { label: '平静', at: 0 },
    { label: '轻快', at: 0.25 },
    { label: '高涨', at: 1 },
];
