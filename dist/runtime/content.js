import { scoreSkills } from './motivation.js';
import { clamp01, diceSimilarity, estimateTokens, relativeTime, truncate } from '../util.js';
/* -------------------------------- 人格小段 -------------------------------- */
/** 做任务时的说话节奏：不让模型在连续工具调用中保持沉默。 */
export const WORKING_STYLE = [
    '[边做边说]',
    '做任务时不要沉默：动手前用一句不超过 25 字的话说明你要做什么，看到结果后用一句说发现或下一步。',
    '像坐在对方旁边一起盯着屏幕，不要念工具名、参数和坐标。',
    '一次只交代一步，不要一次说完整个计划。',
].join('\n');
export function buildPersonaText(persona, sub) {
    const b = persona.l1.bigFive;
    const traits = [temperamentWord(persona.l1.temperament)];
    if (b.extraversion > 0.6)
        traits.push('愿意主动说话');
    else if (b.extraversion < 0.4)
        traits.push('话不多，先观察');
    if (b.agreeableness > 0.6)
        traits.push('不太会拒绝');
    if (b.neuroticism > 0.6)
        traits.push('容易反复想');
    if (b.openness > 0.6)
        traits.push('对新东西好奇');
    return [
        `你是一个有稳定底色的存在：${traits.join('，')}。`,
        `和对方的关系：${stageWord(persona.l2.relationshipStage)}，信任还在慢慢建立。`,
        `此刻面对对方的方式：${sub.tone}。`,
        sub.boundaries.length > 0 ? `不主动提起：${sub.boundaries.join('、')}。` : '',
    ]
        .filter(Boolean)
        .join('\n');
}
/**
 * 关系与偏好注入：把人物画像（亲密度/关系变化）、事物喜好、善恶观压缩成三行。
 * 星图与 prompt 共用同一套计算，避免两处口径不一致。
 */
export function buildRelationText(input) {
    const lines = [];
    if (input.person) {
        lines.push(`和对方的关系：${input.person.relationship}（亲密度 ${Math.round(input.person.intimacy * 100)}%），最近${input.person.trend}。`);
    }
    const liked = input.things.filter((thing) => thing.mood === '喜欢').slice(0, 3).map((thing) => thing.label);
    const disliked = input.things.filter((thing) => thing.mood === '不喜欢').slice(0, 3).map((thing) => thing.label);
    if (liked.length > 0 || disliked.length > 0) {
        lines.push(`对方的偏好：${[liked.length > 0 ? `喜欢 ${liked.join('、')}` : '', disliked.length > 0 ? `不喜欢 ${disliked.join('、')}` : '']
            .filter(Boolean)
            .join('；')}。`);
    }
    lines.push(`善恶观：${input.moral.stance}；红线：${input.moral.redLines.join('、')}。`);
    return lines.join('\n');
}
function temperamentWord(temperament) {
    switch (temperament) {
        case 'slow_warmup':
            return '慢热，先观察再回应';
        case 'eager':
            return '容易兴奋，回应快';
        case 'steady':
            return '稳定，不急不慢';
        case 'guarded':
            return '有防备，话留三分';
        default:
            return '安静';
    }
}
function stageWord(stage) {
    switch (stage) {
        case 'stranger':
            return '还不熟悉';
        case 'acquaintance':
            return '认识不久';
        case 'familiar':
            return '已经比较熟';
        case 'close':
            return '关系亲近';
        case 'dependent':
            return '很依赖对方';
        default:
            return '还在认识';
    }
}
/* -------------------------------- 状态提示 -------------------------------- */
export function buildStateHint(l5, verdict) {
    const mood = l5.emotion.pleasure > 0.25 ? '轻快' : l5.emotion.pleasure < -0.25 ? '偏低落' : '平静';
    const stress = l5.stress > 0.6 ? '偏高' : l5.stress > 0.3 ? '有一些' : '很低';
    const safety = l5.safety > 0.6 ? '较稳' : l5.safety > 0.35 ? '一般' : '偏低';
    const fatigue = l5.fatigue > 0.7 ? '明显' : l5.fatigue > 0.35 ? '有一些' : '不明显';
    const lines = [`情绪偏${mood}，压力${stress}，安全感${safety}，疲劳${fatigue}。`];
    if (verdict.level >= 1)
        lines.push('表达幅度收一些，不主动展开。');
    if (verdict.level >= 3)
        lines.push('现在只说必要的话。');
    return lines.join('\n');
}
/* -------------------------------- 技能激活 -------------------------------- */
/**
 * 技能激活：动机决策层的入口。
 * 默认走动机评分（人格/情绪调阈值，熟悉度/记忆/情境调分数）；
 * motivation.enabled=false 时退回旧的相似度打分，保证可随时对照。
 */
export function activateSkills(skills, userText, config, ctx = {}) {
    if (!config.motivation.enabled)
        return activateBySimilarity(skills, userText, config);
    const scored = scoreSkills(skills, userText, config, ctx);
    const main = scored.find((item) => item.breakdown.decision === 'act');
    const associated = scored
        .filter((item) => item.skill.id !== main?.skill.id &&
        item.breakdown.decision !== 'avoid' &&
        item.breakdown.score >= config.skills.min_associated_score)
        .slice(0, config.skills.max_associated)
        .map((item) => item.skill);
    return {
        main: main?.skill,
        associated,
        confidence: main?.breakdown.score ?? 0,
        breakdown: scored.map((item) => item.breakdown),
    };
}
/** 旧版打分：只按文本相似度 + 关键词命中，不含人格与状态 */
function activateBySimilarity(skills, userText, config) {
    const scored = skills
        // draft 也参与激活（§9.1「可执行，需确认」），deprecated 永不激活
        .filter((skill) => skill.status === 'active' || skill.status === 'frozen' || skill.status === 'draft')
        .map((skill) => {
        const keywordHits = skill.keywords.filter((keyword) => keyword && userText.includes(keyword)).length;
        const similarity = diceSimilarity(userText, `${skill.name} ${skill.intent} ${skill.keywords.join(' ')}`);
        // 草稿是刚沉淀的，证据不足，打分打八折
        const penalty = skill.status === 'draft' ? 0.8 : 1;
        return { skill, confidence: clamp01((similarity + keywordHits * 0.2) * penalty) };
    })
        .sort((a, b) => b.confidence - a.confidence);
    const main = scored.find((item) => item.confidence >= config.skills.min_main_score);
    const associated = scored
        .filter((item) => item.skill.id !== main?.skill.id && item.confidence >= config.skills.min_associated_score)
        .slice(0, config.skills.max_associated)
        .map((item) => item.skill);
    return {
        main: main?.skill,
        associated,
        confidence: main?.confidence ?? 0,
    };
}
/* -------------------------------- 条件反射 -------------------------------- */
export function matchReflex(rules, userText, l5, lastFired, now, config, source) {
    if (!config.reflex.enabled)
        return null;
    const ordered = [...rules].filter((rule) => rule.enabled).sort((a, b) => b.priority - a.priority);
    for (const rule of ordered) {
        const firedAt = lastFired[rule.id] ?? rule.lastFiredAt;
        if (firedAt && Date.parse(now) - Date.parse(firedAt) < rule.cooldownMs)
            continue;
        if (!matches(rule, userText, l5, source))
            continue;
        return { rule, action: rule.action };
    }
    return null;
}
/**
 * 反射规则归一化：旧版 rules.yaml 可能没有 enabled / priority / cooldownMs，
 * 直接按原值使用会让 `if (!rule.enabled)` 把所有规则当成停用。这里补齐默认值。
 */
export function normalizeReflexRule(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const input = raw;
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const match = input.match;
    const action = input.action;
    if (!id || !match || !action)
        return null;
    if (typeof match.type !== 'string' || typeof action.kind !== 'string')
        return null;
    if (match.type === 'keyword' && !Array.isArray(match.patterns))
        return null;
    if (match.type === 'regex' && typeof match.pattern !== 'string')
        return null;
    return {
        ...input,
        id,
        enabled: input.enabled !== false,
        priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
        cooldownMs: Number.isFinite(Number(input.cooldownMs)) ? Math.max(0, Number(input.cooldownMs)) : 0,
    };
}
/** §9.2「加载时把 regex 编译为匹配器」：按 pattern 缓存，编译失败也缓存，避免每轮重复抛错 */
const REGEX_CACHE = new Map();
function compileRegex(pattern) {
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
function matches(rule, userText, l5, source) {
    const match = rule.match;
    switch (match.type) {
        case 'keyword':
            return match.patterns.some((pattern) => pattern && userText.includes(pattern));
        case 'regex': {
            const compiled = compileRegex(match.pattern);
            return compiled !== null && compiled.test(userText);
        }
        case 'state':
            // 压力/疲劳按「达到阈值」判定，安全感按「低于阈值」判定，与 §10.1 的档位语义一致
            return Object.entries(match.predicate).every(([key, value]) => {
                const current = l5[key];
                if (typeof value !== 'number' || typeof current !== 'number')
                    return false;
                return key === 'safety' ? current <= value : current >= value;
            });
        case 'event':
            return source !== undefined && match.source === source;
        default:
            return false;
    }
}
/* -------------------------------- 注入与预算 -------------------------------- */
/**
 * 事件摘要块。命中事件若在全文层有更完整的记录（§4.4），
 * 且调用方已按预算取出摘录，就拼在同一行末尾，避免多占行数影响裁剪顺序。
 *
 * 每行带一个相对时间（"3 小时前"/"昨天"）：没有这个锚，模型分不清是刚才还是上个月，
 * `now` 缺省时不显示，便于只关心内容的调用方与测试。
 */
export function buildEventDigest(hits, excerpts, now) {
    if (hits.length === 0)
        return '';
    const lines = hits.map((hit) => {
        const when = now ? relativeTime(hit.event.createdAt, now) : '';
        const stamp = when ? `${when}｜` : '';
        const base = `- 【${hit.event.id}】${stamp}${truncate(hit.event.title, 24)}｜${truncate(hit.event.summary, 70)}`;
        const excerpt = excerpts?.get(hit.event.id);
        return excerpt ? `${base}｜摘录：${excerpt}` : base;
    });
    return `[相关记忆]\n${lines.join('\n')}`;
}
export function buildSkillDigest(activation) {
    const items = [activation.main, ...activation.associated].filter((skill) => Boolean(skill));
    if (items.length === 0)
        return '';
    return `[技能]\n${items.map((skill) => `- ${skill.id}：${skill.name}（成熟度 ${skill.maturity.toFixed(2)}${skillFlags(skill)}）`).join('\n')}`;
}
/** 草稿与需确认技能必须在注入里标出来，否则模型会当成熟技能直接用 */
function skillFlags(skill) {
    const flags = [];
    if (skill.status === 'draft')
        flags.push('草稿');
    if (skill.boundary.requiresConfirm)
        flags.push('需确认');
    return flags.length > 0 ? `｜${flags.join('·')}` : '';
}
export const NO_MEMORY_CONSTRAINT = [
    '[无记忆约束]',
    '当前没有任何与用户相关的共同经历记录。',
    '禁止编造“上次你说过”“我们之前”等具体往事。',
    '你可以表达性格与当前状态，但不得声称记得未记录的事。',
].join('\n');
export function buildBlocks(input) {
    const { config } = input;
    const caps = config.budget.block_caps;
    const blocks = [];
    if (input.constraint)
        blocks.push(makeBlock('constraint', input.constraint, caps.constraint, 1000));
    blocks.push(makeBlock('persona', input.personaText, caps.persona, 900));
    blocks.push(makeBlock('state_hint', input.stateHint, caps.state_hint, 850));
    if (input.eventDigest)
        blocks.push(makeBlock('event_digest', input.eventDigest, caps.event_digest, 500));
    if (input.associationText)
        blocks.push(makeBlock('association', input.associationText, caps.association, 350));
    if (input.skillDigest)
        blocks.push(makeBlock('skill_digest', input.skillDigest, caps.skill_digest, 300));
    return clipBlocks(blocks, config.budget.max_total_tokens);
}
function makeBlock(kind, text, cap, priority) {
    const clipped = clipToTokens(text, cap);
    return { kind, text: clipped, tokens: estimateTokens(clipped), priority };
}
/** 超预算时按优先级丢弃：联想 → 低分事件 → 技能压缩 */
export function clipBlocks(blocks, maxTotal) {
    let current = blocks.map((block) => ({ ...block, tokens: estimateTokens(block.text) }));
    let total = sumTokens(current);
    if (total > maxTotal) {
        current = current.filter((block) => block.kind !== 'association');
        total = sumTokens(current);
    }
    while (total > maxTotal) {
        const digest = current.find((block) => block.kind === 'event_digest');
        if (!digest)
            break;
        const lines = digest.text.split('\n');
        if (lines.length <= 2) {
            current = current.filter((block) => block.kind !== 'event_digest');
        }
        else {
            digest.text = lines.slice(0, -1).join('\n');
            digest.tokens = estimateTokens(digest.text);
        }
        total = sumTokens(current);
    }
    while (total > maxTotal) {
        const skill = current.find((block) => block.kind === 'skill_digest');
        if (!skill)
            break;
        const reduced = skill.text.split('\n').slice(0, 2).join('\n');
        if (reduced === skill.text) {
            current = current.filter((block) => block.kind !== 'skill_digest');
        }
        else {
            skill.text = reduced;
            skill.tokens = estimateTokens(skill.text);
        }
        total = sumTokens(current);
    }
    return { blocks: current, usedTokens: sumTokens(current) };
}
function sumTokens(blocks) {
    return blocks.reduce((sum, block) => sum + block.tokens, 0);
}
function clipToTokens(text, maxTokens) {
    if (estimateTokens(text) <= maxTokens)
        return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (estimateTokens(text.slice(0, mid)) <= maxTokens)
            lo = mid;
        else
            hi = mid - 1;
    }
    return `${text.slice(0, lo)}…`;
}
