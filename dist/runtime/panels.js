import { DEFAULT_L1, DEFAULT_L2, DEFAULT_L3, DEFAULT_L4 } from '../store.js';
const TEMPERAMENT_LABEL = {
    slow_warmup: '慢热',
    eager: '急切',
    steady: '稳定',
    guarded: '戒备',
};
const STAGE_LABEL = {
    stranger: '陌生',
    acquaintance: '初识',
    familiar: '熟悉',
    close: '亲近',
    dependent: '依赖',
};
const SAFETY_LABEL = {
    0: 'L0 正常',
    1: 'L1 过载',
    2: 'L2 降级',
    3: 'L3 保护',
};
function round(value, digits = 3) {
    if (!Number.isFinite(value))
        return 0;
    return Number(value.toFixed(digits));
}
function param(key, label, value, base, note) {
    if (typeof value === 'number') {
        const item = { key, label, value: round(value, 4), kind: 'number' };
        if (typeof base === 'number') {
            item.base = round(base, 4);
            item.delta = round(value - base, 4);
        }
        if (note)
            item.note = note;
        return item;
    }
    const item = {
        key,
        label,
        value,
        kind: Array.isArray(value) ? 'list' : 'text',
    };
    if (note)
        item.note = note;
    return item;
}
function l1Group(current, base) {
    const bigFive = [
        ['openness', '开放性'],
        ['conscientiousness', '尽责性'],
        ['extraversion', '外向性'],
        ['agreeableness', '宜人性'],
        ['neuroticism', '神经质'],
    ];
    const params = bigFive.map(([key, label]) => param(`bigFive.${key}`, label, current.bigFive[key], base.bigFive[key]));
    params.push(param('noveltySeeking', '新奇寻求', current.noveltySeeking, base.noveltySeeking), param('plasticityBase', '可塑性', current.plasticityBase, base.plasticityBase), param('moodBaseline.pleasure', '情绪基线 · 愉悦', current.moodBaseline.pleasure, base.moodBaseline.pleasure), param('moodBaseline.arousal', '情绪基线 · 唤醒', current.moodBaseline.arousal, base.moodBaseline.arousal), param('moodBaseline.dominance', '情绪基线 · 掌控', current.moodBaseline.dominance, base.moodBaseline.dominance), param('temperament', '气质', TEMPERAMENT_LABEL[current.temperament] ?? current.temperament), param('updatedAt', '更新时间', current.updatedAt));
    return { id: 'L1', title: 'L1 人格基线', subtitle: '出厂默认 → 当前', params };
}
function l2Group(current, base) {
    return {
        id: 'L2',
        title: 'L2 依恋与关系',
        subtitle: '对「你」的关系底色',
        params: [
            param('attachmentAnxiety', '依恋焦虑', current.attachmentAnxiety, base.attachmentAnxiety),
            param('attachmentAvoidance', '依恋回避', current.attachmentAvoidance, base.attachmentAvoidance),
            param('trustBaseline', '信任基线', current.trustBaseline, base.trustBaseline),
            param('relationshipDepth', '关系深度', current.relationshipDepth, base.relationshipDepth),
            param('relationshipStage', '关系阶段', STAGE_LABEL[current.relationshipStage] ?? current.relationshipStage),
            param('coreNeeds', '核心需求', current.coreNeeds),
            param('updatedAt', '更新时间', current.updatedAt),
        ],
    };
}
function l3Group(current, base) {
    const params = [
        param('defenseMaturity', '防御成熟度', current.defenseMaturity, base.defenseMaturity),
        param('moral.altruism', '善恶观 · 利他', current.moral.altruism, base.moral.altruism),
        param('moral.principle', '善恶观 · 守原则', current.moral.principle, base.moral.principle),
        param('moral.stance', '善恶观 · 立场', current.moral.stance),
        param('moral.redLines', '红线', current.moral.redLines),
    ];
    for (const key of Object.keys(current.biasWeights)) {
        params.push(param(`biasWeights.${key}`, `认知偏差 · ${key}`, current.biasWeights[key], base.biasWeights[key]));
    }
    for (const strategy of current.copingStrategies) {
        const baseStrategy = base.copingStrategies.find((item) => item.id === strategy.id);
        params.push(param(`coping.${strategy.id}.weight`, `应对 · ${strategy.trigger} 权重`, strategy.weight, baseStrategy?.weight), param(`coping.${strategy.id}.response`, `应对 · ${strategy.trigger}`, strategy.response));
    }
    params.push(param('updatedAt', '更新时间', current.updatedAt));
    return { id: 'L3', title: 'L3 认知应对', subtitle: '压力下的策略与善恶观', params };
}
function l4Group(current, base) {
    const params = [];
    for (const sub of current.subPersonas) {
        const baseSub = base.subPersonas.find((item) => item.id === sub.id);
        params.push(param(`sub.${sub.id}.weight`, `${sub.id} · 权重`, sub.weight, baseSub?.weight), param(`sub.${sub.id}.disclosure`, `${sub.id} · 自我暴露`, sub.disclosureLevel, baseSub?.disclosureLevel), param(`sub.${sub.id}.tone`, `${sub.id} · 语气`, sub.tone));
        if (sub.boundaries.length > 0) {
            params.push(param(`sub.${sub.id}.boundaries`, `${sub.id} · 边界`, sub.boundaries));
        }
    }
    params.push(param('updatedAt', '更新时间', current.updatedAt));
    return { id: 'L4', title: 'L4 情境子人格', subtitle: '按场景切换的表达面具', params };
}
function runtimeGroups(store, now) {
    const groups = [];
    const sessions = store
        .listL5Sessions()
        .map((sessionId) => store.loadL5(sessionId))
        .filter((state) => state !== null)
        .sort((a, b) => Date.parse(b.lastTickAt) - Date.parse(a.lastTickAt));
    const l5 = sessions[0];
    if (l5) {
        groups.push({
            id: 'L5',
            title: 'L5 当下状态',
            subtitle: `最近会话 ${l5.sessionId.slice(0, 16)}`,
            params: [
                param('emotion.pleasure', '愉悦', l5.emotion.pleasure),
                param('emotion.arousal', '唤醒', l5.emotion.arousal),
                param('emotion.dominance', '掌控', l5.emotion.dominance),
                param('stress', '压力', l5.stress),
                param('safety', '安全感', l5.safety),
                param('fatigue', '疲劳', l5.fatigue),
                param('boundary', '边界', l5.boundary),
                param('emotionalOverdraft', '会话内透支', l5.emotionalOverdraft),
                param('activeSubPersonaId', '当前子人格', l5.activeSubPersonaId ?? '未标注'),
                param('lastTickAt', '最后心跳', l5.lastTickAt),
                param('snapshotAt', '快照时间', l5.snapshotAt),
            ],
        });
    }
    else {
        groups.push({ id: 'L5', title: 'L5 当下状态', subtitle: '暂无会话快照', params: [] });
    }
    const safety = store.loadSafetyState();
    groups.push({
        id: 'safety',
        title: '安全与边界',
        subtitle: '脑干降级链',
        params: [
            param('level', '安全等级', SAFETY_LABEL[safety.level] ?? `L${safety.level}`),
            param('functionalImpairment', '功能受损', safety.functionalImpairment),
            param('overstressHours', '过载时长（小时）', round(safety.overstressDurationMs / 3_600_000, 1)),
            param('reasons', '原因', safety.reasons),
            param('triggers', '触发', safety.triggers),
            param('since', '起始时间', safety.since),
        ],
    });
    groups.push({
        id: 'overdraft',
        title: '全局情感透支',
        subtitle: '不随会话重置',
        params: [param('overdraft', '累计透支', store.loadOverdraft())],
    });
    return groups;
}
/** 程序记忆明细：技能成熟度、反射开关、固化资产包，全部只读 */
function programMemoryGroup(store) {
    const params = [];
    for (const skill of store.loadSkills()) {
        params.push(param(`skill.${skill.id}`, `${skill.name} · 成熟度`, skill.maturity, undefined, `${skill.status} · 成功 ${skill.successCount} 次`));
    }
    for (const rule of store.loadReflexRules()) {
        const trigger = rule.match.type === 'keyword' ? rule.match.patterns[0] ?? rule.id : rule.id;
        params.push(param(`reflex.${rule.id}`, `反射 · ${trigger}`, rule.enabled ? '启用' : '停用', undefined, `冷却 ${Math.round(rule.cooldownMs / 1000)} 秒 · 优先级 ${rule.priority}`));
    }
    const assets = store.loadAssets();
    if (assets.length > 0) {
        params.push(param('assets', '固化资产包', assets.map((asset) => `${asset.id}(${asset.status})`)));
    }
    return { id: 'program', title: '技能与资产', subtitle: '程序记忆明细', params };
}
function storageGroup(store, counts) {
    const events = store.listAllEvents();
    const live = events.filter((event) => !event.archived);
    const tags = new Set();
    const people = new Set();
    let links = 0;
    for (const event of live) {
        for (const tag of event.tags)
            if (tag)
                tags.add(tag);
        for (const participant of event.participants)
            if (participant)
                people.add(participant);
        links += event.links.length;
    }
    const filterStats = store.readCounters('filter.');
    const salience = live.map((event) => event.salience).filter((value) => typeof value === 'number');
    const avgSalience = salience.length > 0 ? salience.reduce((sum, value) => sum + value, 0) / salience.length : null;
    const merged = live.reduce((sum, event) => sum + (event.mergedCount ?? 0), 0);
    return {
        id: 'storage',
        title: '记忆与认知滤网',
        subtitle: '只读计数',
        params: [
            param('events.live', '未归档事件', live.length),
            param('events.archived', '归档事件', events.length - live.length),
            param('events.links', '事件链接', links),
            param('events.max_links', '单条最大出度', live.reduce((max, event) => Math.max(max, event.links.length), 0), undefined, '上限 12，超过会被 trimLinks 修剪'),
            param('events.recalls', '累计召回', live.reduce((sum, event) => sum + event.recallCount, 0)),
            param('events.never', '从未被想起', live.filter((event) => event.recallCount === 0).length, undefined, '这些记忆一次都没进过注入'),
            param('tags', '主题标签', tags.size),
            param('people', '出现人物', people.size),
            param('skills', '技能卡', store.loadSkills().length),
            param('reflexes', '反射规则', store.loadReflexRules().length),
            param('nodes', '星图节点', counts.nodes),
            param('edges', '星图边', counts.edges),
            param('galaxies', '星系', counts.galaxies),
            param('filter.keep', '滤网放行', filterStats.keep ?? 0),
            param('filter.merge', '同题合并', filterStats.merge ?? 0),
            param('filter.drop', '显著性丢弃', filterStats.drop ?? 0),
            param('filter.shield', '认知屏蔽', filterStats.shield ?? 0),
            param('filter.forget', '忘却归档', filterStats.forget ?? 0),
            param('filter.merged_total', '合并计数合计', merged),
            param('filter.salience', '平均显著性', avgSalience === null ? '—' : Number(avgSalience.toFixed(3))),
        ],
    };
}
function flatten(value, prefix = '') {
    const out = {};
    if (value === null || value === undefined)
        return out;
    if (Array.isArray(value)) {
        out[prefix || 'value'] = value
            .map((item) => (typeof item === 'number' ? String(Number(item.toFixed(4))) : String(item)))
            .join('、');
        return out;
    }
    if (typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            const path = prefix ? `${prefix}.${key}` : key;
            Object.assign(out, flatten(item, path));
        }
        return out;
    }
    out[prefix || 'value'] = typeof value === 'number' ? String(Number(value.toFixed(4))) : String(value);
    return out;
}
function evolutionEntries(store, limit = 10) {
    const rows = store
        .listEvolution(120)
        .filter((entry) => ['L1', 'L2', 'L3', 'L4'].includes(entry.target))
        .slice(-limit)
        .reverse();
    return rows.map((entry) => {
        const before = flatten(entry.before);
        const after = flatten(entry.after);
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        const changes = [];
        for (const key of keys) {
            const from = before[key] ?? '—';
            const to = after[key] ?? '—';
            if (from !== to)
                changes.push({ key, from, to });
        }
        return { at: entry.at, target: entry.target, reason: entry.reason, changes };
    });
}
export function buildStarPanels(store, now, counts) {
    const persona = store.loadPersona();
    return {
        persona: [
            l1Group(persona.l1, DEFAULT_L1),
            l2Group(persona.l2, DEFAULT_L2),
            l3Group(persona.l3, DEFAULT_L3),
            l4Group(persona.l4, DEFAULT_L4),
        ],
        runtime: [...runtimeGroups(store, now), programMemoryGroup(store), storageGroup(store, counts)],
        evolution: evolutionEntries(store),
        series: store
            .listL5Sessions()
            .map((sessionId) => store.loadL5(sessionId))
            .filter((state) => state !== null)
            .sort((a, b) => Date.parse(a.lastTickAt) - Date.parse(b.lastTickAt))
            .map((state) => ({
            sessionId: state.sessionId,
            at: state.lastTickAt,
            safety: Number(state.safety.toFixed(3)),
            stress: Number(state.stress.toFixed(3)),
            fatigue: Number(state.fatigue.toFixed(3)),
            pleasure: Number(state.emotion.pleasure.toFixed(3)),
        })),
        generatedAt: now,
    };
}
