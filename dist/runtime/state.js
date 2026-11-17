import { clamp01, clampPad } from '../util.js';
const POSITIVE_WORDS = [
    '好', '喜欢', '开心', '高兴', '谢谢', '厉害', '不错', '爱', '舒服', '顺利', '棒',
    '满意', '放心', '期待', '温暖', '踏实', '有意思', '感动', '轻松', '靠谱',
];
/**
 * 负向词表。早期只有 11 个，真实库 56 条事件全是正极性——
 * "我怕又失败了""撑不住了"这类最典型的话一个都没命中，情绪维度等于常数。
 */
const NEGATIVE_WORDS = [
    '难受', '难过', '烦', '累', '压力', '讨厌', '生气', '失望', '焦虑', '崩溃', '疼',
    '害怕', '担心', '紧张', '委屈', '孤独', '想哭', '没意思', '无语', '搞砸', '完蛋',
    '撑不住', '受不了', '自责', '愧疚', '后悔', '心累', '失败', '算了', '唉',
];
/** 否定词：紧挨在正面词前面时，这一处命中作废——"不开心"不是开心 */
const NEGATION_WORDS = ['不', '没', '别', '无'];
const STRESS_WORDS = ['压力', '烦', '累', '急', '赶', ' deadline', '加班', '吵架', '崩溃', '来不及', '心累', '撑不住', '搞砸', '担心'];
const FATIGUE_WORDS = ['困', '累', '熬夜', '失眠', '没睡', '疲惫', '睡不着', '没力气'];
const BOUNDARY_WORDS = ['滚', '闭嘴', '别管', '烦死了'];
/** 单轮情绪推进幅度。0.16 时实测 pleasure 几乎不动（均值 |p|≈0.11），情绪维度在检索里退化成常数 */
const PAD_GAIN = 0.3;
/**
 * 派生 PAD 折算回 L5 的系数。
 * 「满强度词 × 0.9 极性」再乘这个系数，量级与旧的 polarity×strength 接近，
 * 换的是分级能力，不是整体情绪摆幅。
 */
const PAD_DERIVE_TO_L5 = 0.6;
/**
 * 程度词分级（DEF-01）：只按词表二值化会让「有点烦」和「崩溃」都判成 -1，
 * 情绪维度失去分辨力。这里给每档一个倍数，命中词前后 3 字内取最强的一档。
 */
const DEGREE_WORDS = [
    { words: ['有点', '有些', '稍微', '略', '一点', '不太'], factor: 0.64 },
    { words: ['比较', '还算', '挺', '稍'], factor: 0.8 },
    { words: ['非常', '特别', '太', '真的', '超级', '极其', '超', '巨', '很', '好'], factor: 1.3 },
];
/** 单词满强度的极性上限：留 0.1 余量，叠词/加强词还能往上顶 */
const HIT_POLARITY_SCALE = 0.9;
export function createInitialL5(characterId, sessionId, now, persona, overdraft) {
    return {
        sessionId,
        characterId,
        emotion: { ...persona.l1.moodBaseline },
        stress: 0.2,
        safety: 0.7,
        fatigue: 0.15,
        emotionalOverdraft: overdraft,
        boundary: 0.6,
        activeSubPersonaId: selectSubpersona(persona.l4).id,
        lastTickAt: now,
        snapshotAt: now,
        schemaVersion: 1,
    };
}
/**
 * 跨会话接力：换对话框后不是从基线重新出生，而是把上一段的 L5 按闲置时长向基线回落。
 *
 * 隔五分钟基本原样（还没到 idle_hours），隔一夜明显平复但不会归零——人换房间不清空情绪，
 * 但也不会带着上周的疲惫。是否跨会话、是否跨工作区由调用方按配置决定，这里只管衰减。
 */
export function carryL5(previous, sessionId, now, persona, config) {
    const relax = config.emotion_relax;
    const gapHours = (Date.parse(now) - Date.parse(previous.lastTickAt)) / 3_600_000;
    const idleHours = Number.isFinite(gapHours) && gapHours > 0 ? gapHours : 0;
    // 与 relaxL5 同一套复利：连续对话里几乎不动，隔夜才明显回落
    const ratio = relax.enabled && relax.rate_per_hour > 0 && idleHours >= relax.idle_hours
        ? 1 - Math.pow(1 - relax.rate_per_hour, idleHours)
        : 0;
    const baseline = persona.l1.moodBaseline;
    const pull = (value, target) => Number((value + (target - value) * ratio).toFixed(4));
    const next = {
        ...previous,
        sessionId,
        emotion: {
            pleasure: pull(previous.emotion.pleasure, baseline.pleasure),
            arousal: pull(previous.emotion.arousal, baseline.arousal),
            dominance: pull(previous.emotion.dominance, baseline.dominance),
        },
        stress: pull(previous.stress, relax.stress_baseline),
        fatigue: pull(previous.fatigue, relax.fatigue_baseline),
        safety: pull(previous.safety, relax.safety_baseline),
        // 生理信号是"当时那个桌宠"的状态，跨会话不继承，等新会话自己上报
        body: null,
        lastTickAt: now,
        snapshotAt: now,
        schemaVersion: 1,
    };
    next.stressHighSince = next.stress >= 0.7 ? previous.stressHighSince ?? now : undefined;
    next.safetyLowSince = next.safety <= 0.35 ? previous.safetyLowSince ?? now : undefined;
    return next;
}
export function updateL5(prev, text, now, persona) {
    const detail = analyzeSentiment(text);
    const polarity = detail.polarity;
    const exclamatory = /[!！?？]/.test(text);
    const stressDelta = countHits(text, STRESS_WORDS) > 0 ? 0.12 : -0.04;
    const fatigueDelta = countHits(text, FATIGUE_WORDS) > 0 ? 0.06 : 0.008;
    const nextEmotion = {
        // 用派生 PAD 增量而不是 polarity×strength：程度词已经折算进 pleasure，
        // 「有点累」只轻推、「崩溃」才重推
        pleasure: clampPad(prev.emotion.pleasure * 0.9 + detail.pad.pleasure * PAD_GAIN * PAD_DERIVE_TO_L5),
        arousal: clampPad(prev.emotion.arousal * 0.92 + (exclamatory ? 0.18 : -0.02)),
        dominance: clampPad(prev.emotion.dominance * 0.95 + (polarity < 0 ? -0.04 : 0.02)),
    };
    const nextStress = clamp01(prev.stress + stressDelta);
    const nextSafety = clamp01(prev.safety + (polarity < 0 ? -0.06 : 0.02));
    const nextFatigue = clamp01(prev.fatigue + fatigueDelta);
    const nextBoundary = clamp01(prev.boundary + (countHits(text, BOUNDARY_WORDS) > 0 ? -0.08 : 0.005));
    return {
        ...prev,
        emotion: nextEmotion,
        stress: nextStress,
        safety: nextSafety,
        fatigue: nextFatigue,
        boundary: nextBoundary,
        stressHighSince: nextStress >= 0.7 ? prev.stressHighSince ?? now : undefined,
        safetyLowSince: nextSafety <= 0.35 ? prev.safetyLowSince ?? now : undefined,
        activeSubPersonaId: selectSubpersona(persona.l4, prev.activeSubPersonaId).id,
        snapshotAt: now,
        lastTickAt: now,
    };
}
export function selectSubpersona(l4, preferredId) {
    const personas = l4.subPersonas.filter((item) => item.weight > 0);
    if (preferredId) {
        const found = personas.find((item) => item.id === preferredId);
        if (found)
            return found;
    }
    if (personas.length === 0) {
        return { id: 'alone', weight: 1, tone: '安静', disclosureLevel: 0.5, boundaries: [] };
    }
    return personas.reduce((best, item) => (item.weight > best.weight ? item : best), personas[0]);
}
/**
 * 「靠不靠谱」「开不开心」这类 X不X 反问：否定字夹在同一个词中间，
 * 问的是"是否"，不是在否定它；整段也不该被当成情绪命中。
 * 真实库里一条正常提问曾因此被判成满强度负向，重放时才暴露出来。
 */
function isQuestionRepeat(text, index, word) {
    // 双字词只重复首字（靠不靠谱 / 开不开心），单字词就是整词重复（好不好）
    const head = word.slice(0, 1);
    for (const negation of NEGATION_WORDS) {
        if (text.startsWith(`${head}${negation}${word}`, index))
            return true;
        const negStart = index - negation.length;
        const prevStart = negStart - head.length;
        if (prevStart >= 0 && text.slice(prevStart, negStart) === head && text.slice(negStart, index) === negation) {
            return true;
        }
    }
    return false;
}
/** 词在句中的有效出现位置（排除 X不X 反问的两端） */
function wordIndexes(text, word) {
    const indexes = [];
    let from = 0;
    for (;;) {
        const index = text.indexOf(word, from);
        if (index < 0)
            return indexes;
        if (!isQuestionRepeat(text, index, word))
            indexes.push(index);
        from = index + 1;
    }
}
/** 同一句话里至少有一次未被否定的出现，才算正面命中 */
function hasUnnegated(text, word) {
    return wordIndexes(text, word).some((index) => !isNegated(text, index));
}
function matchedWords(text, words) {
    return words.filter((word) => Boolean(word) && text.includes(word));
}
/** 单字词（好/爱/棒/累/烦/疼）在中文里太容易误命中；多字词才按满权重计 */
function wordBase(word) {
    return word.length >= 2 ? 1 : 0.35;
}
/** 命中词前 3 字内的程度词倍数；没有程度词按 1 计，命中多档时取最强的一档 */
function degreeAt(text, index) {
    const window = text.slice(Math.max(0, index - 3), index);
    const factors = DEGREE_WORDS.filter((tier) => tier.words.some((word) => window.includes(word))).map((tier) => tier.factor);
    // 减弱档（<1）同样要生效，不能和默认值 1 取 max
    return factors.length > 0 ? Math.max(...factors) : 1;
}
/** 正向词第一次"没被否定"出现的位置；整句都被否定时返回 -1 */
function firstUnnegatedIndex(text, word) {
    return wordIndexes(text, word).find((index) => !isNegated(text, index)) ?? -1;
}
/**
 * 把词表摊平成带符号、带程度的命中项。
 * 正面词只在"至少有一次未被否定"时算正面；整句都被否定时反过来算负面
 * （"不开心""没意思""不舒服"），此时程度词不叠加，避免双重放大。
 */
function collectHits(text) {
    const hits = [];
    for (const word of POSITIVE_WORDS) {
        const indexes = wordIndexes(text, word);
        // 只出现在「靠不靠谱」这类反问里时，不算命中
        if (indexes.length === 0)
            continue;
        const index = firstUnnegatedIndex(text, word);
        if (index >= 0) {
            hits.push({ word, sign: 1, base: wordBase(word), degree: degreeAt(text, index) });
            continue;
        }
        hits.push({ word, sign: -1, base: wordBase(word), degree: 1 });
    }
    for (const word of NEGATIVE_WORDS) {
        const index = text.indexOf(word);
        if (index >= 0) {
            hits.push({ word, sign: -1, base: wordBase(word), degree: degreeAt(text, index) });
        }
    }
    return hits;
}
/**
 * 情绪识别明细（DEF-01 派生改造）。
 *
 * 词表 → 带符号和程度的命中项 → PAD 增量 → 极性/强度由 PAD 回算：
 * - `pleasure` 直接决定极性，「有点烦」≈ -0.20、「崩溃」≈ -0.90，不再都判成 -1；
 * - `arousal` 只看命中总量，正负情绪都会唤醒；
 * - `dominance` 随极性走，负面情绪压低掌控感。
 * 空白句返回全零，不产生任何情绪推进。命中词与程度倍数一并带出，供 logs/polarity 离线复算。
 */
export function analyzeSentiment(text) {
    const hits = collectHits(text);
    const magnitude = hits.reduce((sum, hit) => sum + hit.base * hit.degree, 0);
    const signed = hits.reduce((sum, hit) => sum + hit.sign * hit.base * hit.degree, 0);
    const pad = {
        pleasure: clampPad(signed * HIT_POLARITY_SCALE),
        arousal: clampPad(magnitude * 0.5),
        dominance: clampPad(signed * 0.3),
    };
    // 只出现在反问里的词不算命中，日志里的 hits/positives 也要一致
    const allPositive = POSITIVE_WORDS.filter((word) => Boolean(word) && wordIndexes(text, word).length > 0);
    return {
        polarity: pad.pleasure,
        strength: clamp01(magnitude / 2),
        pad,
        hits: [...new Set([...allPositive, ...matchedWords(text, NEGATIVE_WORDS)])],
        negations: matchedWords(text, NEGATION_WORDS),
        positives: allPositive.filter((word) => hasUnnegated(text, word)),
        negatives: matchedWords(text, NEGATIVE_WORDS),
        degrees: Object.fromEntries(hits.map((hit) => [hit.word, hit.degree])),
    };
}
export function sentimentPolarity(text) {
    return analyzeSentiment(text).polarity;
}
/**
 * 词前面是不是否定：允许中间隔一个程度副词——"不太舒服""没那么好"同样是否定，
 * 只认紧挨着的前一个字会漏掉最常见的那几种说法。
 */
function isNegated(text, index) {
    let window = text.slice(Math.max(0, index - 2), index);
    // 程度词里的字不算否定："特别开心"的"别"、"非常好"里的"好"都不是否定；
    // 但「不太」本身带否定语义，不能摘掉
    for (const tier of DEGREE_WORDS) {
        for (const word of tier.words) {
            // 只有以否定字开头的程度词（「不太」）保留否定语义；「特别」里的「别」要摘掉
            if (NEGATION_WORDS.some((negation) => word.startsWith(negation)))
                continue;
            window = window.split(word).join('');
        }
    }
    return NEGATION_WORDS.some((negation) => window.includes(negation));
}
/**
 * 情绪强度 0..1：极性只说方向，"你好"和"今天好累压力好大"都是 |1|，
 * 必须再乘一个强度，否则单字寒暄和真正的情绪波动在 L5 里等权。
 * 两个多字词命中即视为满强度。
 */
export function sentimentStrength(text) {
    return analyzeSentiment(text).strength;
}
export function countHits(text, words) {
    let count = 0;
    for (const word of words) {
        if (word && text.includes(word))
            count += 1;
    }
    return count;
}
