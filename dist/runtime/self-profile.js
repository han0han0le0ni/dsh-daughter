import { checkToolGate } from '../util.js';
const TEMPERAMENT_WORDS = {
    slow_warmup: '慢热',
    eager: '急切',
    steady: '稳定',
    guarded: '戒备',
};
const STAGE_WORDS = {
    stranger: '陌生',
    acquaintance: '初识',
    familiar: '熟悉',
    close: '亲近',
    dependent: '依赖',
};
const DIM_WORDS = {
    openness: '开放性',
    conscientiousness: '尽责性',
    extraversion: '外向性',
    agreeableness: '宜人性',
    neuroticism: '神经质',
    attachment: '依恋',
    narrative: '自我叙事',
};
function round2(value) {
    return (Number.isFinite(value) ? value : 0).toFixed(2);
}
/** 把快照与画像拼成她读得懂的几段；空字段直接省略，不编造 */
export function renderSelfProfile(snapshot, portraits) {
    const card = portraits.self;
    const lines = [];
    const identity = [];
    if (card.name)
        identity.push(`名字：${card.name}`);
    if (card.selfRef)
        identity.push(`自称：${card.selfRef}`);
    if (card.userRef)
        identity.push(`称呼对方：${card.userRef}`);
    if (identity.length > 0)
        lines.push(`【身份】${identity.join('；')}。`);
    if (card.background)
        lines.push(`【背景】${card.background}`);
    if (card.voice)
        lines.push(`【说话风格】${card.voice}`);
    if (card.taboos.length > 0)
        lines.push(`【绝不主动提起】${card.taboos.join('、')}。`);
    const dims = Object.entries(DIM_WORDS)
        .filter(([key]) => key in snapshot.bigFive)
        .map(([key, label]) => `${label} ${round2(snapshot.bigFive[key])}`);
    if (dims.length > 0)
        lines.push(`【五维】${dims.join('、')}。`);
    lines.push(`【气质】${TEMPERAMENT_WORDS[snapshot.temperament] ?? snapshot.temperament}。`);
    lines.push(`【依恋】焦虑 ${round2(snapshot.attachment.anxiety)}、回避 ${round2(snapshot.attachment.avoidance)}。`);
    lines.push(`【自我叙事】世界安全 ${round2(snapshot.narrative.worldSafe)}、`
        + `他人可靠 ${round2(snapshot.narrative.othersReliable)}、`
        + `我值得被爱 ${round2(snapshot.narrative.selfWorth)}。`);
    const relation = `${STAGE_WORDS[snapshot.stage] ?? snapshot.stage}`
        + (portraits.user ? `，亲密度 ${Math.round(portraits.user.intimacy * 100)}%，最近${portraits.user.trend}` : '');
    lines.push(`【和主人的关系】${relation}。`);
    const locked = snapshot.locked.length > 0
        ? snapshot.locked.map((key) => DIM_WORDS[key] ?? key).join('、')
        : '无';
    lines.push(`【演化】${snapshot.evolving ? '开启' : '已关闭'}；被锁定的维度：${locked}。`);
    if (snapshot.seed !== null)
        lines.push(`【重抽种子】${snapshot.seed}。`);
    if (portraits.things.likes.length > 0) {
        lines.push(`【喜欢】${portraits.things.likes.map((item) => `${item.label}（${item.mood}）`).join('、')}。`);
    }
    if (portraits.things.dislikes.length > 0) {
        lines.push(`【不喜欢】${portraits.things.dislikes.map((item) => `${item.label}（${item.mood}）`).join('、')}。`);
    }
    if (portraits.others.length > 0) {
        lines.push(`【她眼里的其他人】${portraits.others
            .slice(0, 5)
            .map((person) => `${person.name}（${person.relationship}，亲密度 ${Math.round(person.intimacy * 100)}%）`)
            .join('、')}。`);
    }
    return lines.join('\n');
}
export function createSelfProfileTool(options) {
    return {
        name: 'daughter_self',
        description: '读取你自己当前的人格与身份设定：名字、自称、称呼对方、背景、说话风格、禁忌、五维、依恋、自我叙事、'
            + '和主人的关系，以及哪些维度被锁定、演化是否开启。'
            + '当需要确认「我叫什么」「我是什么性格」「我现在的设定」时调用，不要凭印象编。只读，不修改任何设定。',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    readAt: { type: 'string' },
                },
                required: ['text', 'readAt'],
            },
            render(_args, value) {
                return [{ type: 'text', text: value.text }];
            },
        },
        async execute() {
            checkToolGate(options.guard, 'read', 'daughter_self');
            const readAt = new Date().toISOString();
            // 每次现读：不缓存，设置页改完或重抽后立即可见
            const snapshot = options.readPersonality();
            const portraits = options.readPortraits();
            return { text: renderSelfProfile(snapshot, portraits), readAt };
        },
    };
}
export function registerSelfProfileTool(ctx, options) {
    const logger = options.logger ?? ctx.logger;
    const tools = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') {
        logger?.warn?.('dsh-daughter: 无 tools 服务，跳过 daughter_self 注册');
        return () => { };
    }
    try {
        const dispose = tools.register(createSelfProfileTool({ ...options, logger }));
        logger?.info?.('dsh-daughter: daughter_self 已注册');
        return typeof dispose === 'function' ? dispose : () => { };
    }
    catch (error) {
        logger?.warn?.('dsh-daughter: daughter_self 注册失败', { error: String(error) });
        return () => { };
    }
}
