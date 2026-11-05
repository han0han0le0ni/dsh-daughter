import { clamp01, diceSimilarity } from '../util.js';
const DEFAULT_SOURCE_WEIGHT = 1;
const REGEX_CACHE = new Map();
export function sourceWeightOf(source, config) {
    const weights = config.filter.source_weights;
    const value = weights[source];
    return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : DEFAULT_SOURCE_WEIGHT;
}
function compile(pattern) {
    if (REGEX_CACHE.has(pattern))
        return REGEX_CACHE.get(pattern);
    let compiled = null;
    try {
        compiled = new RegExp(pattern, 'u');
    }
    catch {
        compiled = null;
    }
    REGEX_CACHE.set(pattern, compiled);
    return compiled;
}
/**
 * 事件签名：数字与数量单位一起归一化，
 * 避免"好感度涨到 58410547"和"涨到 5.8 万亿""涨到 1.2 亿"被当成三件事。
 */
export function eventSignature(event) {
    return `${event.title}\n${event.summary}`
        .replace(/\d+(?:[.,]\d+)?\s*(?:万亿|亿|万|千|百|k|m|b|%|次|个|条|分钟|小时)?/gi, '#')
        // 标题会在 24 字截断，长数字被切掉一半时补个省略号，这里一并抹平
        .replace(/#(?:…|\.\.\.)/g, '#')
        .replace(/\s+/g, ' ')
        .trim();
}
/** 认知屏蔽：命中即不入库 */
export function shieldReason(event, config) {
    const shield = config.filter.shield;
    if (shield.sources.some((source) => source === event.source)) {
        return `来源「${event.source}」在屏蔽清单`;
    }
    const text = `${event.title}\n${event.summary}`;
    for (const keyword of shield.keywords) {
        if (keyword && text.includes(keyword))
            return `命中屏蔽词「${keyword}」`;
    }
    for (const pattern of shield.patterns) {
        if (!pattern)
            continue;
        const compiled = compile(pattern);
        if (compiled?.test(text))
            return `命中屏蔽规则 ${pattern}`;
    }
    return null;
}
/**
 * 显著性 = 情绪强度 × 0.34 + 新颖性 × 0.28 + 社交性 × 0.24 + 信息量 × 0.14，
 * 再乘来源可信度。四项都能从事件本身算出来，不依赖模型调用。
 */
export function salienceOf(event, recent, config) {
    const emotional = clamp01(event.emotionAtTime.intensity * 0.8 + Math.abs(event.emotionAtTime.pleasure) * 0.4);
    const signature = eventSignature(event);
    let maxSimilarity = 0;
    for (const other of recent) {
        const similarity = diceSimilarity(signature, eventSignature(other));
        if (similarity > maxSimilarity)
            maxSimilarity = similarity;
    }
    const novelty = clamp01(1 - maxSimilarity);
    const social = event.participants.includes('user') ? 1 : 0.5;
    const info = clamp01((event.title.length + event.summary.length) / 120);
    const base = emotional * 0.34 + novelty * 0.28 + social * 0.24 + info * 0.14;
    return clamp01(base * sourceWeightOf(event.source, config));
}
/** 写入前的唯一决策点 */
export function decideIngest(event, recent, config, now) {
    const sourceWeight = sourceWeightOf(event.source, config);
    const salience = salienceOf(event, recent, config);
    const base = { salience, sourceWeight };
    if (!config.filter.enabled) {
        return { action: 'keep', reason: '滤网已关闭', ...base };
    }
    const shield = shieldReason(event, config);
    if (shield)
        return { action: 'shield', reason: shield, ...base };
    const habituation = config.filter.habituation;
    const windowMs = Math.max(1, habituation.window_minutes) * 60_000;
    const nowMs = Date.parse(now);
    let duplicate = null;
    for (const other of recent) {
        if (other.source !== event.source)
            continue;
        if (Math.abs(nowMs - Date.parse(other.createdAt)) > windowMs)
            continue;
        const similarity = diceSimilarity(eventSignature(event), eventSignature(other));
        if (!duplicate || similarity > duplicate.similarity)
            duplicate = { event: other, similarity };
    }
    if (duplicate && duplicate.similarity >= 0.9) {
        const repeats = (duplicate.event.mergedCount ?? 0) + 1;
        if (repeats > habituation.max_repeat) {
            return {
                action: 'drop',
                reason: `与 ${duplicate.event.id} 同题重复 ${repeats} 次，已习惯化`,
                targetId: duplicate.event.id,
                ...base,
            };
        }
        return {
            action: 'merge',
            reason: `与 ${duplicate.event.id} 同题（相似度 ${duplicate.similarity.toFixed(2)}），合并计数`,
            targetId: duplicate.event.id,
            ...base,
        };
    }
    if (salience < config.filter.salience.drop_below && sourceWeight <= 0.5) {
        return {
            action: 'drop',
            reason: `显著性 ${salience.toFixed(2)} 低于门限，且来源可信度 ${sourceWeight.toFixed(2)}`,
            ...base,
        };
    }
    return { action: 'keep', reason: '通过滤网', ...base };
}
/**
 * 忘却扫描：低显著性 + 从未被想起 + 长期闲置 → 归档。
 * 被想起过的事件即使显著性低也保留，因为"用得上"本身就是价值。
 */
export function forgetSweep(events, config, now) {
    if (!config.filter.enabled || !config.filter.forget.enabled)
        return { archived: 0, ids: [] };
    const nowMs = Date.parse(now);
    const ids = [];
    for (const event of events) {
        if (event.archived)
            continue;
        if (event.recallCount > 0)
            continue;
        // 旧数据没有 salience：按来源保守估计，低可信来源更容易被忘却
        const salience = event.salience ?? sourceWeightOf(event.source, config) * 0.4;
        if (salience >= config.filter.forget.min_salience)
            continue;
        const idleDays = (nowMs - Date.parse(event.lastRecalledAt ?? event.createdAt)) / 86_400_000;
        if (idleDays < config.filter.forget.idle_days)
            continue;
        ids.push(event.id);
    }
    return { archived: ids.length, ids };
}
