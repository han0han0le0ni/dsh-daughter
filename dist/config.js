import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import YAML from 'yaml';
import { silentLogger } from './util.js';
export const defaultConfig = {
    version: 1,
    character_id: 'daughter-default',
    seed: 42,
    random_surprise_enabled: true,
    retrieval: {
        top_k: 5,
        half_life_days: 7,
        surprise_eta: 0.05,
        exclude_archived: true,
        max_candidates: 1000,
        score_weights: {
            semantic: 0.42,
            recency: 0.22,
            weight: 0.16,
            emotion_match: 0.1,
            link_proximity: 0.1,
        },
        min_score: 0.12,
        expand_fulltext: true,
        fulltext_excerpt_chars: 120,
    },
    association: {
        max_depth: 2,
        max_injected: 2,
        hop_decay: 0.6,
    },
    skills: {
        max_main: 1,
        max_associated: 2,
        maturity_threshold_automate: 0.7,
        min_success_for_freeze: 5,
        min_main_score: 0.25,
        min_associated_score: 0.15,
        min_steps_to_learn: 2,
    },
    reflex: {
        enabled: true,
        max_match_ms: 5,
        short_circuit: false,
    },
    budget: {
        max_total_tokens: 3000,
        block_caps: {
            persona: 300,
            state_hint: 150,
            event_digest: 1400,
            skill_digest: 500,
            association: 300,
            constraint: 120,
        },
    },
    safety: {
        enabled: true,
        diagnosis_labels_forbidden: true,
        thresholds: {
            stress_level1: 0.7,
            safety_level2: 0.35,
            fatigue_level2: 0.8,
            overdraft_level3: 0.8,
        },
        hysteresis: 0.1,
        level1_min_duration_min: 30,
    },
    storage: {
        scope: 'character',
        shared_across_sessions: true,
        shared_across_workspaces: true,
        data_root: '.',
        backend: 'sqlite',
        single_writer: true,
    },
    decay: {
        weight_decay_rate: 0.02,
        recall_boost: 0.05,
        archive_threshold: 0.15,
        archive_idle_days: 90,
    },
    evolution: {
        l1_max_delta_per_write: 0.02,
        min_turns_between_writes: 20,
        log_retention_days: 365,
    },
    personality: {
        enabled: true,
        drift_cap: 0.6,
        critical_threshold: 0.6,
        cumulative_threshold: 0.3,
        critical_step: 0.12,
        cumulative_step: 0.02,
        same_direction_bonus_after: 3,
        repair: { secure: 1, anxious: 0.34, avoidant: 0.25, disorganized: 0.2 },
        initial: {
            ranges: {
                openness: [0.45, 0.75],
                conscientiousness: [0.4, 0.7],
                extraversion: [0.3, 0.7],
                agreeableness: [0.45, 0.8],
                neuroticism: [0.25, 0.65],
            },
            attachment_priors: { secure: 0.7, anxious: 0.18, avoidant: 0.12 },
        },
        evidence_cap: 200,
    },
    desktop: {
        enabled: true,
        bridge_url: 'http://127.0.0.1:47614',
    },
    filter: {
        enabled: true,
        source_weights: {
            chat: 1,
            game: 0.9,
            qq: 1,
            douyin_dm: 1,
            douyin_content: 0.85,
            minecraft: 0.9,
            android: 0.85,
            system: 0.4,
        },
        shield: { sources: [], keywords: [], patterns: [] },
        habituation: { window_minutes: 30, max_repeat: 3 },
        salience: { drop_below: 0.2 },
        forget: { enabled: true, idle_days: 30, min_salience: 0.2 },
    },
    emotion_relax: {
        enabled: true,
        rate_per_hour: 0.06,
        idle_hours: 0.5,
        stress_baseline: 0.2,
        fatigue_baseline: 0.15,
        safety_baseline: 0.7,
    },
    vpet: {
        enabled: true,
        body_link: {
            enabled: true,
            stale_ms: 300_000,
            fatigue_weight: 0.5,
            stress_weight: 0.3,
            max_influence: 0.6,
        },
    },
};
export function loadConfig(pluginRoot, logger = silentLogger) {
    const path = resolve(pluginRoot, 'config.yaml');
    if (!existsSync(path)) {
        logger.warn('config.yaml 不存在，使用内置默认配置', { path });
        warnUnsupported(defaultConfig, logger);
        return defaultConfig;
    }
    try {
        const parsed = YAML.parse(readFileSync(path, 'utf8'));
        const config = normalizeConfig(mergeDeep(defaultConfig, parsed ?? {}));
        warnUnsupported(config, logger);
        return config;
    }
    catch (error) {
        logger.error('config.yaml 解析失败，使用内置默认配置', { error: String(error) });
        return defaultConfig;
    }
}
/** 合并宿主下发的 config 补丁，供 cordis 插件入口使用 */
export function mergeConfig(base, override) {
    return normalizeConfig(mergeDeep(base, override ?? {}));
}
/**
 * 只声明、未实现分支的配置项：显式告警一次，
 * 避免评审时把「配置里写了」误读成「行为已支持」。
 */
function warnUnsupported(config, logger) {
    if (config.storage.scope !== 'character') {
        logger.warn('dsh-daughter: storage.scope 仅支持 character，已按角色级存储运行', {
            scope: config.storage.scope,
        });
    }
    if (!config.storage.shared_across_sessions || !config.storage.shared_across_workspaces) {
        logger.warn('dsh-daughter: 跨会话/跨工作区共享固定开启，shared_across_* 目前不生效');
    }
    if (!config.storage.single_writer) {
        logger.warn('dsh-daughter: single_writer=false，已关闭写锁，请确认没有并发写者');
    }
    if (config.storage.backend !== 'sqlite') {
        logger.warn('dsh-daughter: storage.backend 目前只实现 sqlite，配置值已忽略', {
            backend: config.storage.backend,
        });
    }
    if (config.desktop.enabled) {
        logger.warn('dsh-daughter: desktop.enabled=true，但桌面端能力尚未实现（§14 里程碑 P9），配置值已忽略');
    }
    if (!config.safety.diagnosis_labels_forbidden) {
        logger.warn('dsh-daughter: diagnosis_labels_forbidden=false，输出侧诊断词检查已关闭（不建议）');
    }
}
/** 配置中的 data_root 相对于插件根目录解析 */
export function resolveDataRoot(pluginRoot, config) {
    const root = config.storage.data_root;
    return isAbsolute(root) ? root : resolve(pluginRoot, root);
}
function mergeDeep(base, override) {
    if (override === null || override === undefined)
        return base;
    if (Array.isArray(base) || Array.isArray(override))
        return override;
    if (typeof base !== 'object' || typeof override !== 'object')
        return override;
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const current = result[key];
        result[key] = current !== undefined ? mergeDeep(current, value) : value;
    }
    return result;
}
function normalizeConfig(config) {
    config.retrieval.top_k = Math.max(1, Math.round(num(config.retrieval.top_k, 5)));
    // 打分权重归一化到和为 1：min_score 是绝对门限，权重整体放大 3 倍会让召回条数
    // 静默变化，不归一化等于把两个无关参数耦合在一起
    const weights = config.retrieval.score_weights;
    const keys = ['semantic', 'recency', 'weight', 'emotion_match', 'link_proximity'];
    let sum = 0;
    for (const key of keys) {
        weights[key] = Math.max(0, num(weights[key], 0));
        sum += weights[key];
    }
    if (!(sum > 0)) {
        config.retrieval.score_weights = { ...defaultConfig.retrieval.score_weights };
    }
    else {
        for (const key of keys)
            weights[key] = Number((weights[key] / sum).toFixed(4));
    }
    config.retrieval.expand_fulltext = config.retrieval.expand_fulltext !== false;
    config.retrieval.fulltext_excerpt_chars = Math.min(400, Math.max(40, Math.round(num(config.retrieval.fulltext_excerpt_chars, 120))));
    config.skills.min_steps_to_learn = Math.min(8, Math.max(2, Math.round(num(config.skills.min_steps_to_learn, 2))));
    config.association.max_depth = Math.min(3, Math.max(1, Math.round(num(config.association.max_depth, 2))));
    config.budget.max_total_tokens = Math.max(200, Math.round(num(config.budget.max_total_tokens, 3000)));
    config.safety.thresholds.stress_level1 = num(config.safety.thresholds.stress_level1, 0.7);
    config.safety.thresholds.safety_level2 = num(config.safety.thresholds.safety_level2, 0.35);
    config.safety.thresholds.fatigue_level2 = num(config.safety.thresholds.fatigue_level2, 0.8);
    config.safety.thresholds.overdraft_level3 = num(config.safety.thresholds.overdraft_level3, 0.8);
    config.decay.weight_decay_rate = Math.min(1, Math.max(0, num(config.decay.weight_decay_rate, 0.02)));
    config.evolution.l1_max_delta_per_write = Math.min(0.1, Math.max(0, num(config.evolution.l1_max_delta_per_write, 0.02)));
    const filter = config.filter;
    filter.habituation.window_minutes = Math.min(1440, Math.max(1, Math.round(num(filter.habituation.window_minutes, 30))));
    filter.habituation.max_repeat = Math.min(20, Math.max(1, Math.round(num(filter.habituation.max_repeat, 3))));
    filter.salience.drop_below = clampUnit(filter.salience.drop_below, 0.2);
    filter.forget.idle_days = Math.min(3650, Math.max(1, Math.round(num(filter.forget.idle_days, 30))));
    filter.forget.min_salience = clampUnit(filter.forget.min_salience, 0.2);
    for (const [source, weight] of Object.entries(filter.source_weights)) {
        filter.source_weights[source] = clampUnit(weight, 1);
    }
    const relax = config.emotion_relax;
    relax.enabled = relax.enabled !== false;
    relax.rate_per_hour = clampUnit(relax.rate_per_hour, 0.06);
    relax.idle_hours = Math.min(168, Math.max(0, num(relax.idle_hours, 0.5)));
    relax.stress_baseline = clampUnit(relax.stress_baseline, 0.2);
    relax.fatigue_baseline = clampUnit(relax.fatigue_baseline, 0.15);
    relax.safety_baseline = clampUnit(relax.safety_baseline, 0.7);
    const bodyLink = config.vpet.body_link;
    bodyLink.stale_ms = Math.min(3_600_000, Math.max(30_000, Math.round(num(bodyLink.stale_ms, 300_000))));
    bodyLink.fatigue_weight = clampUnit(bodyLink.fatigue_weight, 0.5);
    bodyLink.stress_weight = clampUnit(bodyLink.stress_weight, 0.3);
    bodyLink.max_influence = clampUnit(bodyLink.max_influence, 0.6);
    return config;
}
function num(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function clampUnit(value, fallback) {
    const number = num(value, fallback);
    return Math.min(1, Math.max(0, number));
}
