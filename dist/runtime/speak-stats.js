const MAX_DAYS = 7;
function parseBuckets(raw) {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .filter((entry) => {
            if (!entry || typeof entry !== 'object')
                return false;
            const bucket = entry;
            return typeof bucket.day === 'string';
        })
            .map((bucket) => ({
            day: bucket.day,
            act: Number(bucket.act) || 0,
            hold: Number(bucket.hold) || 0,
            silent: Number(bucket.silent) || 0,
            reasons: bucket.reasons && typeof bucket.reasons === 'object' ? bucket.reasons : {},
            updatedAt: typeof bucket.updatedAt === 'string' ? bucket.updatedAt : '',
        }));
    }
    catch {
        // 统计只是旁路数据，坏了就当没有，不能影响开口本身
        return [];
    }
}
/** 记一次评估结果，返回要写回 meta 的 JSON */
export function recordSpeakStats(raw, plan, day, now) {
    const buckets = parseBuckets(raw);
    let bucket = buckets.find((entry) => entry.day === day);
    if (!bucket) {
        bucket = { day, act: 0, hold: 0, silent: 0, reasons: {}, updatedAt: now };
        buckets.push(bucket);
    }
    bucket[plan.decision] += 1;
    bucket.reasons[plan.reason] = (bucket.reasons[plan.reason] ?? 0) + 1;
    bucket.updatedAt = now;
    return JSON.stringify(buckets.sort((a, b) => a.day.localeCompare(b.day)).slice(-MAX_DAYS));
}
/** 读某一天的汇总，供面板展示 */
export function readSpeakStats(raw, day) {
    const bucket = parseBuckets(raw).find((entry) => entry.day === day);
    if (!bucket) {
        return { day, total: 0, act: 0, hold: 0, silent: 0, silentRatio: 0, reasons: {} };
    }
    const total = bucket.act + bucket.hold + bucket.silent;
    return {
        day,
        total,
        act: bucket.act,
        hold: bucket.hold,
        silent: bucket.silent,
        silentRatio: total > 0 ? bucket.silent / total : 0,
        reasons: bucket.reasons,
    };
}
