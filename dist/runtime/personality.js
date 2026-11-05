import { clamp01, createRng, truncate } from '../util.js';
import { sentimentPolarity } from './state.js';
/** 冲击度权重：出现即说明这不是一句普通闲聊 */
const CRITICAL_MARKERS = [
    '分手', '离开我', '不要我', '别来找我', '再也不', '永远不', '背叛', '滚开',
    '我走了', '讨厌你', '恨你', '受够了', '结束吧', '搬走', '出国', '删了你',
];
/** 修复侧标记：道歉、保证、回来——但按依恋类型打折 */
const REPAIR_MARKERS = ['对不起', '我错了', '我回来了', '一直在', '不会走', '答应你', '保证', '别怕', '我在'];
const EVIDENCE_SOFT_CAP = 200;
export const DEFAULT_INITIAL_RANGES = {
    openness: [0.45, 0.75],
    conscientiousness: [0.4, 0.7],
    extraversion: [0.3, 0.7],
    agreeableness: [0.45, 0.8],
    neuroticism: [0.25, 0.65],
};
export const DEFAULT_ATTACHMENT_PRIORS = { secure: 0.7, anxious: 0.18, avoidant: 0.12 };
/** 依恋先验 → 焦虑/回避两维的落点（先验只决定起点，不直接写类型） */
const ATTACHMENT_ANCHORS = {
    secure: { anxiety: 0.28, avoidance: 0.3 },
    anxious: { anxiety: 0.62, avoidance: 0.32 },
    avoidant: { anxiety: 0.3, avoidance: 0.62 },
};
function hashId(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
function between(rand, range) {
    return range[0] + (range[1] - range[0]) * rand();
}
function pickAttachment(rand, priors) {
    const total = Math.max(0.0001, priors.secure + priors.anxious + priors.avoidant);
    const roll = rand() * total;
    if (roll < priors.secure)
        return 'secure';
    if (roll < priors.secure + priors.anxious)
        return 'anxious';
    return 'avoidant';
}
/**
 * 出生人格：同一角色（character_id + seed）永远抽到同一组值，不同角色落在不同点。
 * 五维先在有界区间内抽样，再按弱相关拉一点 O/E 与 N/A 的关系，避免出现"出生即极端"。
 */
export function createInitialL1(characterId, seed, initial = { ranges: DEFAULT_INITIAL_RANGES, attachment_priors: DEFAULT_ATTACHMENT_PRIORS }, now = '1970-01-01T00:00:00.000Z') {
    const rand = createRng((hashId(characterId) ^ seed) >>> 0);
    const ranges = initial.ranges ?? DEFAULT_INITIAL_RANGES;
    const pick = (key) => round3(between(rand, ranges[key] ?? DEFAULT_INITIAL_RANGES[key]));
    let openness = pick('openness');
    let conscientiousness = pick('conscientiousness');
    let extraversion = pick('extraversion');
    let agreeableness = pick('agreeableness');
    let neuroticism = pick('neuroticism');
    // 弱相关：O 高的略微更外向；N 高的略微更不易相处（幅度刻意压小，只做"同一个人"的连贯性）
    extraversion = clamp01(extraversion + (openness - 0.6) * 0.15);
    agreeableness = clamp01(agreeableness - (neuroticism - 0.45) * 0.15);
    const bigFive = {
        openness: round3(openness),
        conscientiousness: round3(conscientiousness),
        extraversion: round3(extraversion),
        agreeableness: round3(agreeableness),
        neuroticism: round3(neuroticism),
    };
    const temperament = extraversion < 0.42
        ? 'slow_warmup'
        : extraversion > 0.6 ? 'eager' : neuroticism > 0.5 ? 'guarded' : 'steady';
    return {
        bigFive,
        innate: { ...bigFive },
        temperament,
        moodBaseline: { pleasure: round3(0.1 + (agreeableness - 0.6) * 0.1), arousal: -0.1, dominance: 0 },
        noveltySeeking: round3(0.35 + (openness - 0.5) * 0.3),
        plasticityBase: 0.35,
        plasticity: 0.65,
        updatedAt: now,
    };
}
/** 出生依恋：先验决定落点；混乱型不出生 */
export function createInitialL2(characterId, seed, initial = { ranges: DEFAULT_INITIAL_RANGES, attachment_priors: DEFAULT_ATTACHMENT_PRIORS }, now = '1970-01-01T00:00:00.000Z') {
    const rand = createRng((hashId(`l2:${characterId}`) ^ seed) >>> 0);
    const type = pickAttachment(rand, initial.attachment_priors ?? DEFAULT_ATTACHMENT_PRIORS);
    const anchor = ATTACHMENT_ANCHORS[type];
    const jitter = () => round3((rand() - 0.5) * 0.08);
    return {
        attachmentAnxiety: round3(clamp01(anchor.anxiety + jitter())),
        attachmentAvoidance: round3(clamp01(anchor.avoidance + jitter())),
        coreNeeds: type === 'anxious' ? ['稳定回应', '被记得'] : type === 'avoidant' ? ['不被打扰', '被尊重'] : ['被需要', '稳定回应'],
        trustBaseline: round3(type === 'secure' ? 0.4 : 0.26),
        relationshipStage: 'stranger',
        relationshipDepth: 0.12,
        attachmentType: type,
        updatedAt: now,
    };
}
/** 中性自我叙事（旧存档补齐用） */
export function defaultNarrative(now = '1970-01-01T00:00:00.000Z') {
    return { worldSafe: 0.6, othersReliable: 0.5, selfWorth: 0.6, lockedAxes: [], updatedAt: now };
}
/** 由焦虑/回避两维 + 是否具备混乱条件推导依恋底色 */
export function deriveAttachment(l2, disorganizedEligible) {
    if (disorganizedEligible && l2.attachmentAnxiety >= 0.55 && l2.attachmentAvoidance >= 0.5)
        return 'disorganized';
    if (l2.attachmentAnxiety >= 0.5 && l2.attachmentAvoidance < 0.5)
        return 'anxious';
    if (l2.attachmentAvoidance >= 0.5)
        return 'avoidant';
    return 'secure';
}
function round3(value) {
    return Math.round(clamp01(value) * 1000) / 1000;
}
function countMarkers(text, markers) {
    let hits = 0;
    for (const marker of markers)
        if (text.includes(marker))
            hits += 1;
    return hits;
}
/**
 * 冲击度：情绪强度打底，关键/修复语句加权。
 * 没有关键标记时上限定在 0.5，普通闲聊（"最近状态不好"这类）落在 routine——
 * 这就是"写实"的闸门：人格不会被日常情绪推着走。
 */
export function scoreImpact(text, l5, thresholds = { cumulative: 0.3, critical: 0.6 }) {
    const polarity = sentimentPolarity(text);
    const critical = countMarkers(text, CRITICAL_MARKERS);
    const repair = countMarkers(text, REPAIR_MARKERS) > 0 && polarity >= 0;
    const strength = Math.abs(polarity) * 0.5
        + Math.abs(l5.emotion.pleasure) * 0.3
        + Math.max(0, l5.emotion.arousal) * 0.2;
    let impact = strength * 0.5;
    if (critical > 0)
        impact += 0.3 + 0.1 * (critical - 1);
    if (repair)
        impact += 0.25;
    impact = clamp01(impact);
    const kind = impact >= thresholds.critical
        ? 'critical'
        : impact >= thresholds.cumulative ? 'cumulative' : 'routine';
    return { impact, kind, repair };
}
/**
 * 把一次对话的冲击落到人格上。
 * 只有 cumulative / critical 会写 L1–L3；回复 routine 直接返回 changed=false。
 */
export function applyPersonalitySignal(store, config, input) {
    const settings = config.personality;
    const empty = { changed: false, kind: 'routine', impact: 0, layers: [], evolutionIds: [] };
    if (!settings?.enabled)
        return empty;
    const { impact, kind, repair } = scoreImpact(input.text, input.l5, {
        cumulative: settings.cumulative_threshold,
        critical: settings.critical_threshold,
    });
    if (kind === 'routine')
        return { ...empty, kind, impact };
    const polarity = sentimentPolarity(input.text);
    const direction = polarity >= 0 ? 1 : -1;
    const persona = store.loadPersona();
    const l1 = persona.l1;
    const l2 = persona.l2;
    const l3 = persona.l3;
    const now = input.now;
    const layers = [];
    const evolutionIds = [];
    const evidence = [];
    const quote = truncate(input.text.trim(), 60);
    const anxiety = l2.attachmentAnxiety;
    const avoidance = l2.attachmentAvoidance;
    const cycles = store.getMetaNumber('personality_cycles', 0);
    const disorganizedEligible = cycles >= 2;
    const attachment = l2.attachmentType ?? deriveAttachment(l2, disorganizedEligible);
    const repairFactor = settings.repair?.[attachment] ?? 1;
    // 伤害侧：越难修的类型，同样一句话打得更深
    const damageFactor = attachment === 'secure' ? 1 : 2 - repairFactor;
    /* ------------------------------ L1 五维 ------------------------------ */
    const anchors = l1.innate ?? l1.bigFive;
    const cap = Math.max(0.1, settings.drift_cap);
    const extreme = Math.max(Math.abs(l1.bigFive.neuroticism - anchors.neuroticism), Math.abs(l1.bigFive.extraversion - anchors.extraversion), Math.abs(l1.bigFive.agreeableness - anchors.agreeableness)) >= 0.35;
    const plasticity = clamp01((l1.plasticity ?? 0.65) * (extreme ? 0.5 : 1));
    const baseStep = (kind === 'critical' ? settings.critical_step : settings.cumulative_step) * impact * plasticity;
    const lastPendingDir = Number(store.getMeta('personality_pending_dir') ?? 0);
    const pendingCount = lastPendingDir === direction
        ? store.getMetaNumber('personality_pending_count', 0) + 1
        : 1;
    store.setMeta('personality_pending_dir', String(direction));
    store.setMeta('personality_pending_count', String(pendingCount));
    // 同向经历攒够若干次，额外推一把；每到一个整数倍触发一次，避免永久加成
    const bonusEvery = Math.max(2, settings.same_direction_bonus_after);
    const streakBonus = pendingCount % bonusEvery === 0 ? 0.5 : 0;
    // 修复方向本来就被"打折"，而且只有偏离锚点足够远时才允许往回走
    const repairScale = direction > 0 && repair ? repairFactor : direction < 0 ? damageFactor : 1;
    const step = baseStep * (1 + streakBonus) * repairScale;
    const drift = (key, weight) => {
        const anchor = anchors[key];
        const current = l1.bigFive[key];
        const lower = Math.max(0.02, anchor - cap);
        const upper = Math.min(0.98, anchor + cap);
        const target = clamp01(current + direction * step * weight);
        const next = round3(Math.min(upper, Math.max(lower, target)));
        const delta = round3(next - current);
        if (delta === 0)
            return 0;
        l1.bigFive = { ...l1.bigFive, [key]: next };
        evidence.push(makeEvidence(store, now, input.eventId, 'L1', key, delta, kind, impact, quote));
        return delta;
    };
    // 负面语气把神经质推高、外向与宜人压低；正面反之
    const nDelta = drift('neuroticism', -0.6);
    const eDelta = drift('extraversion', 0.3);
    const aDelta = drift('agreeableness', 0.2);
    const l1Changed = nDelta !== 0 || eDelta !== 0 || aDelta !== 0;
    if (l1Changed) {
        l1.plasticity = round3(plasticity);
        l1.updatedAt = now;
        store.savePersonaLayer('l1', l1);
        layers.push('L1');
        const entryId = store.newEvolutionId(now);
        store.appendEvolution({
            id: entryId,
            characterId: store.characterId,
            target: 'L1',
            before: {},
            after: { bigFive: l1.bigFive },
            reason: `${kind === 'critical' ? '关键事件' : '累积经历'}（冲击 ${impact.toFixed(2)}，方向 ${direction > 0 ? '正向' : '负向'}）推动五维`,
            at: now,
        });
        evolutionIds.push(entryId);
    }
    /* ------------------------------ L2 依恋 ------------------------------ */
    const anxietyDelta = direction > 0
        ? -0.06 * impact * (repair ? repairFactor : 1)
        : 0.08 * impact * damageFactor;
    const avoidanceDelta = direction > 0
        ? -0.05 * impact * (repair ? repairFactor : 1)
        : 0.05 * impact * damageFactor;
    const nextAnxiety = round3(clamp01(anxiety + anxietyDelta));
    const nextAvoidance = round3(clamp01(avoidance + avoidanceDelta));
    if (Math.abs(nextAnxiety - anxiety) >= 0.001 || Math.abs(nextAvoidance - avoidance) >= 0.001) {
        // 关键事件交替（靠近→伤害→靠近）累计到 2 轮，才允许转成混乱型
        const lastDir = Number(store.getMeta('personality_last_critical_dir') ?? 0);
        const lastAt = store.getMeta('personality_last_critical_at');
        let nextCycles = cycles;
        if (kind === 'critical') {
            const withinDay = lastAt !== null && Date.parse(now) - Date.parse(lastAt) <= 86_400_000;
            if (withinDay && lastDir !== 0 && lastDir !== direction)
                nextCycles = cycles + 1;
            store.setMeta('personality_cycles', String(nextCycles));
            store.setMeta('personality_last_critical_dir', String(direction));
            store.setMeta('personality_last_critical_at', now);
        }
        const nextAttachment = deriveAttachment({ ...l2, attachmentAnxiety: nextAnxiety, attachmentAvoidance: nextAvoidance }, nextCycles >= 2);
        const l2Next = {
            ...l2,
            attachmentAnxiety: nextAnxiety,
            attachmentAvoidance: nextAvoidance,
            attachmentType: nextAttachment,
            updatedAt: now,
        };
        store.savePersonaLayer('l2', l2Next);
        layers.push('L2');
        evidence.push(makeEvidence(store, now, input.eventId, 'L2', 'attachmentAnxiety', round3(nextAnxiety - anxiety), kind, impact, quote));
        evidence.push(makeEvidence(store, now, input.eventId, 'L2', 'attachmentAvoidance', round3(nextAvoidance - avoidance), kind, impact, quote));
        const entryId = store.newEvolutionId(now);
        store.appendEvolution({
            id: entryId,
            characterId: store.characterId,
            target: 'L2',
            before: { attachmentAnxiety: anxiety, attachmentAvoidance: avoidance, attachmentType: attachment },
            after: { attachmentAnxiety: nextAnxiety, attachmentAvoidance: nextAvoidance, attachmentType: nextAttachment },
            reason: nextAttachment !== attachment
                ? `依恋底色变化：${attachment} → ${nextAttachment}（${kind === 'critical' ? '关键事件交替' : '累积经历'}）`
                : `依恋两维随${kind === 'critical' ? '关键时刻' : '累积经历'}移动`,
            at: now,
        });
        evolutionIds.push(entryId);
        if (nextAttachment !== attachment)
            layers.push('phase');
    }
    /* --------------------------- L3 自我叙事 --------------------------- */
    const narrative = l3.narrative ?? defaultNarrative(now);
    const nextNarrative = {
        worldSafe: round3(clamp01(narrative.worldSafe + direction * 0.04 * impact)),
        othersReliable: round3(clamp01(narrative.othersReliable + direction * 0.1 * impact)),
        selfWorth: round3(clamp01(narrative.selfWorth + direction * 0.05 * impact)),
        lockedAxes: [...(narrative.lockedAxes ?? [])],
        updatedAt: now,
    };
    const lock = (axis, value) => {
        if ((value <= 0.25 || value >= 0.8) && !nextNarrative.lockedAxes.includes(axis))
            nextNarrative.lockedAxes.push(axis);
    };
    lock('worldSafe', nextNarrative.worldSafe);
    lock('othersReliable', nextNarrative.othersReliable);
    lock('selfWorth', nextNarrative.selfWorth);
    const narrativeChanged = Math.abs(nextNarrative.othersReliable - narrative.othersReliable) >= 0.005
        || Math.abs(nextNarrative.selfWorth - narrative.selfWorth) >= 0.005
        || Math.abs(nextNarrative.worldSafe - narrative.worldSafe) >= 0.005;
    const l3Next = {
        ...l3,
        narrative: nextNarrative,
        evidence: [...(l3.evidence ?? []), ...evidence].slice(-Math.max(20, settings.evidence_cap ?? EVIDENCE_SOFT_CAP)),
        updatedAt: narrativeChanged ? now : l3.updatedAt,
    };
    if (evidence.length > 0 || narrativeChanged) {
        store.savePersonaLayer('l3', l3Next);
        if (narrativeChanged) {
            layers.push('L3');
            const entryId = store.newEvolutionId(now);
            store.appendEvolution({
                id: entryId,
                characterId: store.characterId,
                target: 'L3',
                before: { narrative },
                after: { narrative: nextNarrative },
                reason: '自我叙事三轴随经历移动（仅在面板给事实，不给类型标签）',
                at: now,
            });
            evolutionIds.push(entryId);
        }
    }
    return {
        changed: layers.length > 0,
        kind: layers.includes('phase') ? 'phase' : kind,
        impact,
        layers,
        evolutionIds,
    };
}
function makeEvidence(store, now, eventId, layer, dimension, delta, impactKind, impact, quote) {
    return {
        id: `${store.newEvolutionId(now)}-${dimension}`,
        at: now,
        eventId,
        layer,
        dimension,
        delta,
        impactKind,
        impact: Math.round(impact * 1000) / 1000,
        quote,
    };
}
