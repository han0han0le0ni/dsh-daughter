import { clamp01, daysBetween, diceSimilarity, newEventId, padDistance, truncate } from '../util.js';
import { sentimentPolarity } from './state.js';
import { sourceWeightOf } from './filter.js';
const TAG_LEXICON = [
    { tag: '工作', words: ['工作', '项目', '开会', '加班', '需求', '上线'] },
    { tag: '学习', words: ['学习', '考试', '作业', '课', '复习', '论文'] },
    { tag: '情绪', words: ['难过', '烦', '压力', '焦虑', '开心', '累'] },
    { tag: '生活', words: ['吃饭', '睡觉', '起床', '家', '天气', '周末'] },
    { tag: '游戏', words: ['游戏', '打本', '联机', 'Minecraft', '我的世界', '植物大战僵尸'] },
    { tag: '社交', words: ['朋友', '同学', '聊天', '群里', '抖音', 'QQ'] },
    { tag: '约定', words: ['下次', '记得', '答应', '说好', '约定'] },
];
export function retrieveEvents(args) {
    const { query, now, topK, currentEmotion, config } = args;
    const w = config.retrieval.score_weights;
    const fts = args.ftsScores?.(query);
    const scored = args.candidates.map((event) => {
        const dice = Math.max(diceSimilarity(query, event.title) * 1.0, diceSimilarity(query, event.summary) * 0.95, diceSimilarity(query, event.tags.join(' ')) * 0.6);
        // FTS5 命中优先，Dice 作为短查询与索引不可用时的兜底
        const semantic = Math.max(dice, fts?.get(event.id) ?? 0);
        const recency = 0.5 ** (daysBetween(event.createdAt, now) / Math.max(1, config.retrieval.half_life_days));
        const emotionMatch = 1 - padDistance(currentEmotion, event.emotionAtTime);
        return {
            event,
            semantic,
            recency,
            weight: event.weight,
            emotionMatch,
            linkProximity: 0,
            score: 0,
        };
    });
    scored.sort((a, b) => b.semantic * w.semantic + b.weight * w.weight - (a.semantic * w.semantic + a.weight * w.weight));
    const top = scored[0];
    if (top) {
        const topId = top.event.id;
        for (const item of scored) {
            if (item.event.id === topId)
                continue;
            if (item.event.links.some((link) => link.targetId === topId))
                item.linkProximity = 0.6;
            else if (item.event.links.some((link) => top.event.links.some((direct) => direct.targetId === link.targetId))) {
                item.linkProximity = 0.3;
            }
        }
    }
    for (const item of scored) {
        const raw = w.semantic * item.semantic +
            w.recency * item.recency +
            w.weight * item.weight +
            w.emotion_match * item.emotionMatch +
            w.link_proximity * item.linkProximity;
        // 认知滤网：低可信来源整体降权（窗口标题这类系统事件不该挤掉真人对话）
        item.score = raw * (config.filter.enabled ? sourceWeightOf(item.event.source, config) : 1);
    }
    return scored
        .filter((item) => item.score >= config.retrieval.min_score)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((item) => ({
        event: item.event,
        score: round(item.score),
        reason: `语义 ${round(item.semantic)} / 近因 ${round(item.recency)} / 权重 ${round(item.weight)} / 情绪 ${round(item.emotionMatch)}`,
    }));
}
export function associateEvents(seedIds, candidates, maxDepth, maxInjected, hopDecay) {
    const byId = new Map(candidates.map((event) => [event.id, event]));
    const visited = new Set(seedIds);
    const queue = seedIds.map((id) => ({ id, depth: 0, score: 1 }));
    const hits = [];
    while (queue.length > 0) {
        const current = queue.shift();
        if (current.depth >= maxDepth)
            continue;
        const event = byId.get(current.id);
        if (!event)
            continue;
        for (const link of event.links) {
            if (visited.has(link.targetId))
                continue;
            const target = byId.get(link.targetId);
            if (!target || target.archived)
                continue;
            visited.add(link.targetId);
            const score = current.score * hopDecay * link.strength;
            hits.push({ eventId: link.targetId, via: link, score: round(score) });
            queue.push({ id: link.targetId, depth: current.depth + 1, score });
        }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, maxInjected);
}
/** 概率联想：从最近 30 天的非归档事件中随机挑 1 条，同种子可复现 */
export function applySurprise(hits, candidates, config, rng, now) {
    if (!config.random_surprise_enabled)
        return hits;
    if (rng() >= config.retrieval.surprise_eta)
        return hits;
    const recent = candidates.filter((event) => !event.archived && daysBetween(event.createdAt, now) <= 30 && !hits.some((hit) => hit.event.id === event.id));
    if (recent.length === 0)
        return hits;
    const picked = recent[Math.floor(rng() * recent.length)];
    return [
        ...hits,
        { event: picked, score: 0.05, reason: '随机联想（可复现）' },
    ].sort((a, b) => b.score - a.score).slice(0, config.retrieval.top_k + 1);
}
/**
 * 回忆重构的最小情绪位移。
 * padDistance 满量程约 0.5，原来卡 0.15（满量程 30%）在实际分布下永远达不到，
 * 真实库 emotion_history 因此 0 行；0.08 约等于 pleasure 变化 0.2 的量级。
 */
const RECONSTRUCT_MIN_DISTANCE = 0.08;
/** 回忆重构：命中事件时按当前情绪追加一条 emotion_now_history，不覆盖 emotion_at_time */
export function reconstructOnRecall(store, event, l5, now) {
    const last = event.emotionNowHistory[event.emotionNowHistory.length - 1]?.emotion ?? event.emotionAtTime;
    if (padDistance(last, l5.emotion) < RECONSTRUCT_MIN_DISTANCE)
        return false;
    store.appendEmotionHistory(event.id, {
        at: now,
        emotion: { ...l5.emotion },
        reason: '回忆重构：此刻的感受与当时不同',
    });
    return true;
}
export function extractEvent(ctx, userText, assistantText, l5, rng) {
    const tags = TAG_LEXICON.filter((entry) => entry.words.some((word) => userText.includes(word))).map((entry) => entry.tag);
    const polarity = sentimentPolarity(userText);
    const importance = clamp01(0.3 + Math.min(0.3, userText.length / 300) + tags.length * 0.05 + Math.abs(polarity) * 0.1);
    const now = ctx.now();
    return {
        id: newEventId(now, rng),
        characterId: ctx.characterId,
        title: truncate(userText.replace(/\s+/g, ' ').trim(), 24),
        // 摘要层只留压缩版（进索引）；完整问答另存全文层，命中且预算允许时再展开（§4.4）
        summary: truncate(userText.replace(/\s+/g, ' ').trim(), 80) +
            (assistantText ? ` → ${truncate(assistantText.replace(/\s+/g, ' ').trim(), 40)}` : ''),
        tags: tags.length > 0 ? tags : ['对话'],
        participants: ['self', ctx.audience ?? 'user'],
        emotionAtTime: {
            ...l5.emotion,
            intensity: clamp01(Math.abs(l5.emotion.pleasure) * 0.6 + l5.stress * 0.4),
        },
        emotionNowHistory: [],
        importance,
        weight: importance,
        links: [],
        source: 'chat',
        createdAt: now,
        recallCount: 0,
        archived: false,
        schemaVersion: 1,
    };
}
/**
 * 单条事件的出边上限。
 * 不设上限时，早期热点事件会被后续每轮都连一次，真实库曾出现单事件 607 条出边，
 * `linkProximity` 的 0.6/0.3 于是对所有候选都成立，这个维度彻底失去区分度。
 */
const MAX_LINKS_PER_EVENT = 12;
/**
 * 新事件入库后，与最近的相似事件建立弱链接（双向，最多 maxLinks 条）。
 * 相似度 = 共享标签 + 共享人物 ×0.5 + 7 天内 ×0.2。
 */
export function linkNewEvent(store, event, maxLinks = 3) {
    if (event.links.length >= MAX_LINKS_PER_EVENT)
        return 0;
    const candidates = store.listAllEvents().filter((candidate) => candidate.id !== event.id &&
        !candidate.archived &&
        candidate.links.length < MAX_LINKS_PER_EVENT);
    const scored = candidates
        .map((candidate) => {
        const sharedTags = candidate.tags.filter((tag) => event.tags.includes(tag)).length;
        const sharedPeople = candidate.participants.filter((person) => person && event.participants.includes(person)).length;
        const recent = daysBetween(candidate.createdAt, event.createdAt) <= 7 ? 1 : 0;
        const score = sharedTags + sharedPeople * 0.5 + recent * 0.2;
        const kind = sharedTags > 0 ? 'topic' : 'person';
        return { candidate, score, kind };
    })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(maxLinks, MAX_LINKS_PER_EVENT - event.links.length));
    let created = 0;
    for (const { candidate, score, kind } of scored) {
        const strength = Math.min(1, score / 3);
        if (!event.links.some((link) => link.targetId === candidate.id)) {
            const forward = { targetId: candidate.id, kind, strength };
            event.links.push(forward);
            store.updateEventMutable(event.id, { links: event.links });
            created += 1;
        }
        if (!candidate.links.some((link) => link.targetId === event.id)) {
            store.updateEventMutable(candidate.id, {
                links: [...candidate.links, { targetId: event.id, kind, strength }],
            });
        }
    }
    return created;
}
function round(value) {
    return Math.round(value * 100) / 100;
}
