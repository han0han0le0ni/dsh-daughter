const fields = [];
const b = (path, label, group, hint) => fields.push({ path, label, group, type: 'boolean', hint });
const n = (path, label, group, min, max, hint) => fields.push({ path, label, group, type: 'number', min, max, hint });
const MEM = '记忆与检索';
const LINK = '联想与连续性';
const EMOTE = '情感与表达';
const LEARN = '学习与技能';
const SAFE = '安全与隐私';
const KEEP = '记忆维护与性格';
// 记忆与检索
n('retrieval.top_k', '每次注入几条记忆', MEM, 1, 20, '越大越容易想起旧事，但会占用注入预算');
n('retrieval.min_score', '检索总分门槛', MEM, 0, 1, '越低越容易带出记忆');
n('retrieval.min_semantic', '语义相似度门槛', MEM, 0, 1);
b('retrieval.prefer_quotes', '优先带出有原话的记忆', MEM, '有原话的证据比摘要更可信');
b('retrieval.exclude_archived', '排除已归档记忆', MEM);
b('retrieval.expand_fulltext', '展开全文片段', MEM);
n('retrieval.max_candidates', '候选记忆上限', MEM, 50, 5000, '一次检索最多看多少条');
n('retrieval.fts_merge_max', '全文结果合并上限', MEM, 10, 1000);
n('retrieval.fulltext_excerpt_chars', '全文片段字数', MEM, 20, 500);
n('retrieval.max_unquoted', '无原话记忆上限', MEM, 0, 10);
n('retrieval.half_life_days', '记忆新鲜度半衰期（天）', MEM, 1, 90);
b('retrieval.forgetting.enabled', '启用遗忘曲线', MEM, '按艾宾浩斯曲线衰减；关掉退回旧的半衰期算法');
n('retrieval.forgetting.base_stability_days', '遗忘曲线稳定度（天）', MEM, 1, 3650, '越大忘得越慢；间隔等于它时只剩约 37%');
n('retrieval.forgetting.arousal_gain', '情绪唤醒延长记忆', MEM, 0, 5, '越激动或越难受的时刻，忘得越慢');
n('retrieval.forgetting.pleasure_gain', '情绪强度延长记忆', MEM, 0, 5);
n('retrieval.forgetting.weight_gain', '重要度延长记忆', MEM, 0, 5, '分量越重的事，稳定度越高');
n('retrieval.surprise_eta', '意外感加成', MEM, 0, 0.5);
n('retrieval.reconstruct_distance', '回忆重构距离', MEM, 0, 1);
n('retrieval.reconstruct_cooldown_minutes', '重构冷却（分钟）', MEM, 0, 1440);
n('retrieval.score_weights.semantic', '权重：语义', MEM, 0, 1);
n('retrieval.score_weights.recency', '权重：新鲜度', MEM, 0, 1);
n('retrieval.score_weights.weight', '权重：重要度', MEM, 0, 1);
n('retrieval.score_weights.emotion_match', '权重：情绪匹配', MEM, 0, 1);
n('retrieval.score_weights.link_proximity', '权重：联想邻近', MEM, 0, 1);
b('random_surprise_enabled', '偶尔冒出意外联想', MEM, '关掉后回忆更稳定但更刻板');
// 联想与连续性
n('association.max_depth', '联想最多跳几层', LINK, 0, 5);
n('association.max_injected', '最多注入几条联想', LINK, 0, 10);
n('association.hop_decay', '每跳衰减', LINK, 0, 1);
b('association.fallback_when_no_match', '没匹配到时也给一条关联', LINK);
b('association.contradiction_enabled', '允许“两种说法”并存', LINK, '冲突不做覆盖，而是并排呈现');
n('association.contradiction_min_gap', '判为冲突的极性差', LINK, 0, 1.5);
b('continuity.enabled', '跨会话连续性', LINK, '换窗口后仍知道上次聊到哪');
n('continuity.cross_window_minutes', '跨窗口时间窗（分钟）', LINK, 1, 480);
n('continuity.cross_window_max', '最多带几条跨窗口状态', LINK, 0, 10);
b('threading.enabled', '话题线归并', LINK, '把零散消息串成同一话题');
n('threading.gap_minutes', '话题断开间隔（分钟）', LINK, 1, 480);
n('threading.similarity', '话题相似度', LINK, 0, 1);
n('threading.same_window_minutes', '同窗判定（分钟）', LINK, 1, 240);
n('threading.activity_ttl_minutes', '话题活跃期（分钟）', LINK, 1, 1440);
n('threading.closed_retention_minutes', '已结束话题保留（分钟）', LINK, 1, 10080);
n('threading.max_summary_turns', '话题摘要最多几轮', LINK, 1, 20);
n('threading.max_injected', '最多注入几条话题', LINK, 0, 10);
// 情感与表达
b('speak.enabled', '主动开口', EMOTE, '没人说话时自己说一句');
b('speak.shadow', '主动开口影子模式', EMOTE, '只评估，不投递也不写记忆');
b('speak.stats', '记录主动开口统计', EMOTE, '只记计数，不记正文');
n('speak.check_interval_min', '开口检查间隔（分钟）', EMOTE, 1, 60);
n('speak.min_idle_min', '安静多久才考虑开口（分钟）', EMOTE, 1, 720);
n('speak.idle_half_min', '思念半饱和（分钟）', EMOTE, 1, 1440);
n('speak.threshold', '开口触发阈值', EMOTE, 0, 1);
n('speak.threshold_min', '开口阈值下限', EMOTE, 0, 1);
n('speak.refractory_min', '开口后冷却（分钟）', EMOTE, 0, 720);
n('speak.max_per_day', '一天最多主动开口几次', EMOTE, 0, 50);
n('speak.quiet_penalty', '免打扰时段抑制', EMOTE, 0, 1);
n('speak.busy_penalty', '忙碌时抑制', EMOTE, 0, 1);
n('speak.hold_ratio', '开口犹豫比例', EMOTE, 0, 1);
n('speak.carry_step', '冲动累积步长', EMOTE, 0, 1);
n('speak.carry_decay', '冲动衰减', EMOTE, 0, 1);
n('speak.carry_max', '冲动上限', EMOTE, 0, 1);
n('speak.jitter', '开口随机扰动', EMOTE, 0, 1);
b('think.enabled', '碎碎念', EMOTE, '不占正式回复的自言自语');
n('think.max_per_turn', '每轮最多几条碎碎念', EMOTE, 0, 5);
n('think.max_chars', '单条碎碎念字数', EMOTE, 1, 80);
n('think.min_gap_min', '碎碎念最小间隔（分钟）', EMOTE, 0, 240);
n('think.threshold', '碎碎念触发阈值', EMOTE, 0, 1);
b('expression.enabled', '表达出口总开关', EMOTE, '关掉后所有表达都不出站');
b('reflex.enabled', '毫秒级条件反射', EMOTE);
n('reflex.max_match_ms', '反射匹配耗时上限（毫秒）', EMOTE, 1, 100);
b('reflex.short_circuit', '反射命中时跳过模型', EMOTE, '高级选项，可能打断对话');
b('emotion_relax.enabled', '情绪自然回落', EMOTE, '长时间没有刺激时压力与疲劳缓慢下降');
n('emotion_relax.rate_per_hour', '每小时回落速度', EMOTE, 0, 1);
n('emotion_relax.idle_hours', '多久算闲置（小时）', EMOTE, 0.1, 24);
n('emotion_relax.stress_baseline', '压力基线', EMOTE, 0, 1);
n('emotion_relax.fatigue_baseline', '疲劳基线', EMOTE, 0, 1);
n('emotion_relax.safety_baseline', '安全感基线', EMOTE, 0, 1);
// 学习与技能
b('motivation.enabled', '用动机评分挑技能', LEARN, '关掉后退回文本相似度');
n('motivation.hold_ratio', '保持当前技能倾向', LEARN, 0, 1);
n('motivation.trait_threshold_gain', '性格对门槛的影响', LEARN, 0, 1);
n('motivation.min_threshold', '技能触发最低门槛', LEARN, 0, 1);
n('motivation.trait_signal_gain', '性格对信号的影响', LEARN, 0, 1);
n('skills.max_main', '常驻技能上限', LEARN, 0, 10);
n('skills.max_associated', '关联技能上限', LEARN, 0, 10);
n('skills.maturity_threshold_automate', '自动执行成熟阈值', LEARN, 0, 1);
n('skills.min_success_for_freeze', '冻结所需成功次数', LEARN, 1, 100);
n('skills.min_main_score', '常驻技能最低分', LEARN, 0, 1);
n('skills.min_associated_score', '关联技能最低分', LEARN, 0, 1);
n('skills.min_steps_to_learn', '学会一个技能最少步骤', LEARN, 1, 20);
b('skills.shadow.enabled', '技能影子池', LEARN, '候选技能先并行试错，达标再转正');
n('skills.shadow.min_samples', '转正最少样本', LEARN, 3, 100);
n('skills.shadow.win_rate', '转正最低胜率', LEARN, 0, 1);
n('skills.shadow.margin', '转正领先幅度', LEARN, 0, 1);
b('polarity_log.enabled', '情绪极性日志', LEARN, '只存文本哈希，不存正文');
n('polarity_log.retention_days', '极性日志保留天数', LEARN, 1, 365);
b('polarity_log.include_text_hash', '记录文本哈希', LEARN, '用于复现统计，不含原文');
// 安全与隐私
b('filter.enabled', '认知滤网', SAFE, '不是看见什么都记');
n('filter.habituation.max_repeat', '重复内容最多记几次', SAFE, 1, 20);
n('filter.burst.max_keep', '刷屏时最多留几条', SAFE, 1, 20);
n('filter.salience.drop_below', '显著性丢弃线', SAFE, 0, 1);
b('filter.forget.enabled', '定期遗忘', SAFE, '长期不用的低价值记忆会淡出');
n('filter.forget.idle_days', '遗忘闲置天数', SAFE, 1, 365);
n('filter.forget.min_salience', '遗忘显著性下限', SAFE, 0, 1);
b('filter.content_guard.enabled', '拦截乱码与模板残片', SAFE);
n('filter.content_guard.min_content_chars', '最短入库字数', SAFE, 1, 50);
b('safety.enabled', '安全降级', SAFE, '压力过高时收敛表达');
b('safety.diagnosis_labels_forbidden', '禁止输出诊断标签', SAFE);
n('safety.hysteresis', '降级滞回', SAFE, 0, 0.5, '防止等级来回抖动');
n('safety.level1_min_duration_min', '一级降级最短持续（分钟）', SAFE, 1, 240);
n('safety.thresholds.stress_level1', '压力触发一级', SAFE, 0, 1);
n('safety.thresholds.safety_level2', '安全感触发二级', SAFE, 0, 1);
n('safety.thresholds.fatigue_level2', '疲劳触发二级', SAFE, 0, 1);
n('safety.thresholds.overdraft_level3', '透支触发三级', SAFE, 0, 1);
b('storage.shared_across_sessions', '换对话框时接力状态', SAFE);
b('storage.shared_across_workspaces', '跨工作区共享记忆', SAFE, '正式工作对话建议关闭');
b('storage.single_writer', '单写入者锁', SAFE, '避免多实例同时写记忆库');
n('budget.max_total_tokens', '注入预算上限（token）', SAFE, 500, 8000);
n('budget.block_caps.persona', '预算：人格', SAFE, 0, 2000);
n('budget.block_caps.state_hint', '预算：状态提示', SAFE, 0, 2000);
n('budget.block_caps.event_digest', '预算：事件摘要', SAFE, 0, 4000);
n('budget.block_caps.cross_window', '预算：跨窗口', SAFE, 0, 2000);
n('budget.block_caps.thread', '预算：话题线', SAFE, 0, 2000);
n('budget.block_caps.skill_digest', '预算：技能摘要', SAFE, 0, 2000);
n('budget.block_caps.association', '预算：联想', SAFE, 0, 2000);
n('budget.block_caps.constraint', '预算：硬约束', SAFE, 0, 2000, '这一块永远不会被裁掉');
// 记忆维护与性格
n('decay.weight_decay_rate', '记忆权重衰减率', KEEP, 0, 0.5);
n('decay.recall_boost', '回忆后的加强量', KEEP, 0, 0.5);
n('decay.archive_threshold', '归档阈值', KEEP, 0, 1);
n('decay.archive_idle_days', '归档闲置天数', KEEP, 1, 365);
n('decay.link_idle_days', '关联闲置天数', KEEP, 1, 365);
n('decay.link_decay_rate', '关联衰减率', KEEP, 0, 1);
n('decay.link_min_strength', '关联最低强度', KEEP, 0, 1);
n('evolution.l1_max_delta_per_write', '单次性格最大变化', KEEP, 0, 0.2);
n('evolution.min_turns_between_writes', '性格写入间隔（轮）', KEEP, 1, 200);
n('evolution.log_retention_days', '演化日志保留天数', KEEP, 1, 730);
b('personality.enabled', '性格缓慢演化', KEEP);
n('personality.drift_cap', '性格漂移上限', KEEP, 0, 1);
n('personality.critical_threshold', '关键事件阈值', KEEP, 0, 1);
n('personality.cumulative_threshold', '累积变化阈值', KEEP, 0, 1);
n('personality.critical_step', '关键事件步长', KEEP, 0, 0.5);
n('personality.cumulative_step', '累积步长', KEEP, 0, 0.2);
n('personality.same_direction_bonus_after', '同向几次后加速', KEEP, 1, 20);
n('personality.evidence_cap', '证据条数上限', KEEP, 10, 1000);
n('personality.l3_evidence_min_repeats', 'L3 转正同向重复次数', KEEP, 1, 20);
n('personality.l3_evidence_step', 'L3 每次变化步长', KEEP, 0, 0.2);
/** 设置弹窗与 Config schema 共用的唯一字段表；新增开关只改这里。 */
export const SETTINGS_FIELDS = fields;
export function settingField(path) {
    return SETTINGS_FIELDS.find((field) => field.path === path);
}
export function getPath(obj, path) {
    let current = obj;
    for (const key of path.split('.')) {
        if (!current || typeof current !== 'object')
            return undefined;
        current = current[key];
    }
    return current;
}
export function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.at(-1);
    if (!last)
        return;
    let current = obj;
    for (const key of keys.slice(0, -1)) {
        const next = current[key];
        if (!next || typeof next !== 'object' || Array.isArray(next))
            return;
        current = next;
    }
    current[last] = value;
}
export function deletePath(obj, path) {
    const keys = path.split('.');
    const last = keys.at(-1);
    if (!last)
        return;
    let current = obj;
    for (const key of keys.slice(0, -1)) {
        if (!current || typeof current !== 'object')
            return;
        current = current[key];
    }
    if (current && typeof current === 'object')
        delete current[last];
}
export function coerceSetting(field, value) {
    if (field.type === 'boolean') {
        if (typeof value === 'boolean')
            return value;
        if (value === 'true')
            return true;
        if (value === 'false')
            return false;
        return undefined;
    }
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    if (!Number.isFinite(number))
        return undefined;
    const min = field.min ?? -Infinity;
    const max = field.max ?? Infinity;
    return Math.min(max, Math.max(min, number));
}
export function settingsSnapshot(config, overrides) {
    return SETTINGS_FIELDS.map((field) => {
        const override = getPath(overrides, field.path);
        return {
            ...field,
            value: override === undefined ? getPath(config, field.path) : override,
            overridden: override !== undefined,
        };
    });
}
