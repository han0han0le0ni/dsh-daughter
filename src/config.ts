import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import YAML from 'yaml';
import type { DaughterConfig } from './types.js';
import type { Logger } from './util.js';
import { silentLogger } from './util.js';

export const defaultConfig: DaughterConfig = {
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
    min_semantic: 0.01,
    reconstruct_distance: 0.08,
    reconstruct_cooldown_minutes: 360,
    expand_fulltext: true,
    fulltext_excerpt_chars: 120,
    prefer_quotes: true,
    max_unquoted: 0,
    fts_merge_max: 200,
  },
  association: {
    max_depth: 2,
    max_injected: 2,
    hop_decay: 0.6,
    fallback_when_no_match: true,
    contradiction_enabled: true,
    contradiction_min_gap: 0.4,
  },
  continuity: {
    enabled: true,
    cross_window_minutes: 45,
    cross_window_max: 2,
  },
  threading: {
    enabled: true,
    gap_minutes: 45,
    similarity: 0.25,
    same_window_minutes: 10,
    activity_ttl_minutes: 180,
    closed_retention_minutes: 1440,
    closing_phrases: [
      '先这样',
      '不玩了',
      '不聊了',
      '下次再说',
      '回头再说',
      '就到这儿',
      '到此为止',
      '收工',
      '晚安',
      '睡了',
    ],
    max_summary_turns: 4,
    max_injected: 2,
    heading_source: 'first',
  },
  skills: {
    max_main: 1,
    max_associated: 2,
    maturity_threshold_automate: 0.7,
    min_success_for_freeze: 5,
    min_main_score: 0.25,
    min_associated_score: 0.15,
    min_steps_to_learn: 2,
    shadow: {
      enabled: true,
      min_samples: 10,
      win_rate: 0.6,
      margin: 0.1,
    },
  },
  motivation: {
    enabled: true,
    trait_threshold_gain: 0.25,
    min_threshold: 0.05,
    trait_signal_gain: 0.2,
    familiarity: { k: 3, peak: 0.45, sigma: 0.35 },
    memory: {
      outcome_weight: 0.4,
      emotion_weight: 0.3,
      efficacy_weight: 0.3,
      half_life_days: 30,
      lookback_days: 30,
    },
    breaker: { fail_streak: 3, base_cooldown_min: 10, max_cooldown_min: 1440 },
    emotion_override: {
      safety_low: 0.35,
      safety_low_offset: 0.1,
      stress_high: 0.7,
      stress_high_offset: 0.08,
      pleasure_low: -0.25,
      pleasure_low_offset: 0.06,
      arousal_high: 0.4,
      arousal_high_offset: -0.05,
      fatigue_high: 0.8,
      fatigue_high_offset: 0.08,
      clamp_min: -0.15,
      clamp_max: 0.2,
    },
    situation: { min_multiplier: 0.85, max_multiplier: 1.15 },
    hold_ratio: 0.7,
  },
  speak: {
    // 默认关闭：主动开口是自主行为，必须显式开启，不能装完就自己说话
    enabled: false,
    check_interval_min: 3,
    // 活跃档：安静 25 分钟就进入考虑区间，思念 2 小时就到半饱和。
    // 早期 45/180/0.62 的组合在写代码的场景下要沉默四五个小时才开口，等于装了个哑巴。
    min_idle_min: 25,
    idle_half_min: 120,
    trait_urge_gain: 1,
    threshold: 0.52,
    threshold_min: 0.4,
    refractory_min: 60,
    max_per_day: 8,
    quiet_hours: [0, 7],
    quiet_penalty: 0.35,
    busy_penalty: 0.25,
    hold_ratio: 0.75,
    carry_step: 0.05,
    carry_decay: 0.02,
    carry_max: 0.25,
    jitter: 0.04,
    // 影子模式默认关：本机已经调到活跃档，先按真实节奏跑；想调参时再打开
    shadow: false,
    // 统计默认开：只记计数不记正文，代价可以忽略
    stats: true,
  },
  think: {
    // 碎碎念默认开：它不占正式回复，只是一句很短的自言自语
    enabled: true,
    // 一次评估最多两条；再多就从"碎碎念"变成刷屏
    max_per_turn: 2,
    max_chars: 40,
    // 二十分钟内不会重复嘟囔
    min_gap_min: 20,
    threshold: 0.55,
  },
  connectors: {
    // 通用收件口允许的来源；QQ/MC 之类的适配器放在 connectors/<source>/ 下自带清单
    ingest_sources: ['qq', 'douyin_dm', 'douyin_content', 'minecraft', 'game', 'android', 'system'],
    manifests_dir: 'connectors',
  },
  expression: {
    enabled: true,
    // 默认只发桌宠；要接别的应用，在 config.yaml 里加 pet / http / file 出口
    sinks: [{ type: 'vpet' }],
    // 出厂配置下若 dsh-pet 在跑，就让它接管，避免两套桌宠各弹一遍
    prefer_pet: true,
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
      cross_window: 200,
      thread: 200,
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
  security: {
    // 留空 = 使用 brain/brainstem/connector_token；显式填写则固定用它（§12.2）
    connector_token: '',
  },
  decay: {
    weight_decay_rate: 0.02,
    recall_boost: 0.05,
    archive_threshold: 0.15,
    archive_idle_days: 90,
    link_idle_days: 30,
    link_decay_rate: 0.9,
    link_min_strength: 0.05,
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
    // L3 证据表（DEF-08）：先攒证据，同向重复够多才动防御成熟度；单次事件不改权重
    l3_evidence_min_repeats: 3,
    l3_evidence_step: 0.02,
  },
  desktop: {
    // 默认关闭（§12.2）：桌面连接器能给的是屏幕画面与键鼠注入，
    // 属于"开了就有风险"的能力，必须由用户显式打开。
    enabled: false,
    bridge_url: 'http://127.0.0.1:47614',
  },
  douyin: {
    enabled: true,
    // 抖音插件的共享记忆库（QQ／抖音共用的那份），只读
    memory_db: '~/.dsh/douyin-browser/memory/shared.sqlite',
    poll_interval_min: 10,
    max_items: 5,
  },
  filter: {
    enabled: true,
    source_weights: {
      chat: 1,
      self_speech: 0.6,
      game: 0.9,
      qq: 1,
      douyin_dm: 1,
      douyin_content: 0.85,
      minecraft: 0.9,
      android: 0.85,
      system: 0.4,
    },
    shield: { sources: [], keywords: [], patterns: [] },
    habituation: { window_minutes: 30, identical_window_minutes: 1440, max_repeat: 3 },
    burst: { window_minutes: 60, max_keep: 3, exempt_sources: ['chat', 'qq', 'douyin_dm'] },
    salience: { drop_below: 0.2 },
    forget: { enabled: true, idle_days: 30, min_salience: 0.2 },
    content_guard: {
      enabled: true,
      min_content_chars: 2,
      patterns: ['</', '｜｜', 'DSML', 'invoke>', 'calls>', '<|', '|＞'],
    },
  },
  polarity_log: { enabled: true, retention_days: 90, include_text_hash: true },
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

export function loadConfig(pluginRoot: string, logger: Logger = silentLogger): DaughterConfig {
  const path = resolve(pluginRoot, 'config.yaml');
  if (!existsSync(path)) {
    logger.warn('config.yaml 不存在，使用内置默认配置', { path });
    warnUnsupported(defaultConfig, logger);
    return defaultConfig;
  }
  try {
    const parsed = YAML.parse(readFileSync(path, 'utf8')) as Partial<DaughterConfig> | null;
    const config = normalizeConfig(mergeDeep(defaultConfig, parsed ?? {}));
    warnUnsupported(config, logger);
    return config;
  } catch (error) {
    logger.error('config.yaml 解析失败，使用内置默认配置', { error: String(error) });
    return defaultConfig;
  }
}

/** 合并宿主下发的 config 补丁，供 cordis 插件入口使用 */
export function mergeConfig(base: DaughterConfig, override: unknown): DaughterConfig {
  return normalizeConfig(mergeDeep(base, override ?? {}));
}

/**
 * 只声明、未实现分支的配置项：显式告警一次，
 * 避免评审时把「配置里写了」误读成「行为已支持」。
 */
function warnUnsupported(config: DaughterConfig, logger: Logger): void {
  if (config.storage.scope !== 'character') {
    logger.warn('dsh-daughter: storage.scope 仅支持 character，已按角色级存储运行', {
      scope: config.storage.scope,
    });
  }
  // shared_across_* 现在真的生效了：只作用于「此刻」的 L5 接力，事件库与人格仍是角色级
  if (!config.storage.shared_across_sessions) {
    logger.info('dsh-daughter: shared_across_sessions=false，每个会话从基线重新出生（L5 不接力）');
  } else if (!config.storage.shared_across_workspaces) {
    logger.info('dsh-daughter: shared_across_workspaces=false，L5 只在同一工作区内接力');
  }
  if (!config.storage.single_writer) {
    logger.warn('dsh-daughter: single_writer=false，已关闭写锁，请确认没有并发写者');
  }
  if (config.storage.backend !== 'sqlite') {
    logger.warn('dsh-daughter: storage.backend 目前只实现 sqlite，配置值已忽略', {
      backend: config.storage.backend,
    });
  }
  if (!config.safety.diagnosis_labels_forbidden) {
    logger.warn('dsh-daughter: diagnosis_labels_forbidden=false，输出侧诊断词检查已关闭（不建议）');
  }
}

/** 配置中的 data_root 相对于插件根目录解析 */
export function resolveDataRoot(pluginRoot: string, config: DaughterConfig): string {
  const root = config.storage.data_root;
  return isAbsolute(root) ? root : resolve(pluginRoot, root);
}

function mergeDeep<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override as T;
  if (typeof base !== 'object' || typeof override !== 'object') return override as T;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const current = result[key];
    result[key] = current !== undefined ? mergeDeep(current, value) : value;
  }
  return result as T;
}

function normalizeConfig(config: DaughterConfig): DaughterConfig {
  // 隔离开关：只有明确写 false 才关，其它写法（缺省、字符串、undefined）都按默认开启
  config.storage.shared_across_sessions = config.storage.shared_across_sessions !== false;
  config.storage.shared_across_workspaces = config.storage.shared_across_workspaces !== false;

  // 跨窗口时间感：分钟取整且至少 1，条数夹在 0–8
  config.continuity.enabled = config.continuity.enabled !== false;
  config.continuity.cross_window_minutes = Math.max(1, Math.round(num(config.continuity.cross_window_minutes, 45)));
  config.continuity.cross_window_max = Math.max(0, Math.min(8, Math.round(num(config.continuity.cross_window_max, 2))));

  // 局的归并：相似度夹在 0–1，时间窗口与条数取整
  config.threading.enabled = config.threading.enabled !== false;
  config.threading.similarity = clampUnit(config.threading.similarity, 0.25);
  config.threading.gap_minutes = Math.max(1, Math.round(num(config.threading.gap_minutes, 45)));
  config.threading.same_window_minutes = Math.min(
    1440,
    Math.max(0, Math.round(num(config.threading.same_window_minutes, 10))),
  );
  config.threading.activity_ttl_minutes = Math.max(1, Math.round(num(config.threading.activity_ttl_minutes, 180)));
  config.threading.closed_retention_minutes = Math.max(
    1,
    Math.round(num(config.threading.closed_retention_minutes, 1440)),
  );
  // 收尾话术：只留非空字符串；整组被写成空时退回默认，否则"结了没"永远判不出来
  const closing = Array.isArray(config.threading.closing_phrases)
    ? config.threading.closing_phrases.filter((phrase) => typeof phrase === 'string' && phrase.trim().length > 0)
    : [];
  config.threading.closing_phrases = closing.length > 0 ? closing : [...defaultConfig.threading.closing_phrases];
  config.threading.max_summary_turns = Math.max(2, Math.min(12, Math.round(num(config.threading.max_summary_turns, 4))));
  config.threading.max_injected = Math.max(0, Math.min(6, Math.round(num(config.threading.max_injected, 2))));

  config.retrieval.top_k = Math.max(1, Math.round(num(config.retrieval.top_k, 5)));
  config.retrieval.min_semantic = clampUnit(num(config.retrieval.min_semantic, 0.01), 0.01);
  // 回看感受的触发距离：0 会让每次召回都写一条，1 等于永不写，两端都无意义
  config.retrieval.reconstruct_distance = Math.min(0.5, clampUnit(num(config.retrieval.reconstruct_distance, 0.08), 0.08));
  config.retrieval.reconstruct_cooldown_minutes = Math.min(1440, Math.max(0, Math.round(num(config.retrieval.reconstruct_cooldown_minutes, 360))));
  // 打分权重归一化到和为 1：min_score 是绝对门限，权重整体放大 3 倍会让召回条数
  // 静默变化，不归一化等于把两个无关参数耦合在一起
  const weights = config.retrieval.score_weights;
  const keys = ['semantic', 'recency', 'weight', 'emotion_match', 'link_proximity'] as const;
  let sum = 0;
  for (const key of keys) {
    weights[key] = Math.max(0, num(weights[key], 0));
    sum += weights[key];
  }
  if (!(sum > 0)) {
    config.retrieval.score_weights = { ...defaultConfig.retrieval.score_weights };
  } else {
    for (const key of keys) weights[key] = Number((weights[key] / sum).toFixed(4));
  }
  config.retrieval.expand_fulltext = config.retrieval.expand_fulltext !== false;
  config.retrieval.fulltext_excerpt_chars = Math.min(
    400,
    Math.max(40, Math.round(num(config.retrieval.fulltext_excerpt_chars, 120))),
  );
  config.skills.min_steps_to_learn = Math.min(8, Math.max(2, Math.round(num(config.skills.min_steps_to_learn, 2))));

  const shadow = config.skills.shadow ?? { ...defaultConfig.skills.shadow };
  config.skills.shadow = {
    enabled: shadow.enabled !== false,
    // 样本数下限强制 ≥3，否则「1 次成功」就能转正
    min_samples: Math.max(3, Math.round(num(shadow.min_samples, 10))),
    win_rate: Math.min(1, Math.max(0, num(shadow.win_rate, 0.6))),
    margin: Math.min(1, Math.max(0, num(shadow.margin, 0.1))),
  };

  if (!config.motivation || typeof config.motivation !== 'object') {
    config.motivation = structuredClone(defaultConfig.motivation);
  }
  const motivation = config.motivation;
  const defaults = defaultConfig.motivation;
  motivation.familiarity ??= { ...defaults.familiarity };
  motivation.memory ??= { ...defaults.memory };
  motivation.breaker ??= { ...defaults.breaker };
  motivation.emotion_override ??= { ...defaults.emotion_override };
  motivation.situation ??= { ...defaults.situation };
  motivation.enabled = motivation.enabled !== false;
  motivation.trait_threshold_gain = clampUnit(motivation.trait_threshold_gain, 0.25);
  // 下限不能超过基础阈值，否则 skill 永远不可能 act
  motivation.min_threshold = clampRange(
    motivation.min_threshold,
    0,
    Math.max(0, Math.min(0.5, config.skills.min_main_score)),
    defaults.min_threshold,
  );
  // 上限 0.9：乘子最低留 0.1，避免人格把某个通道直接归零
  motivation.trait_signal_gain = clampRange(motivation.trait_signal_gain, 0, 0.9, defaults.trait_signal_gain);
  motivation.familiarity.k = Math.max(1, num(motivation.familiarity.k, 3));
  motivation.familiarity.peak = clampUnit(motivation.familiarity.peak, 0.45);
  motivation.familiarity.sigma = clampRange(motivation.familiarity.sigma, 0.05, 1, 0.35);
  const memory = motivation.memory;
  const memoryKeys = ['outcome_weight', 'emotion_weight', 'efficacy_weight'] as const;
  let memorySum = 0;
  for (const key of memoryKeys) {
    memory[key] = Math.max(0, num(memory[key], defaultConfig.motivation.memory[key]));
    memorySum += memory[key];
  }
  if (!(memorySum > 0)) {
    Object.assign(memory, defaultConfig.motivation.memory);
  } else {
    for (const key of memoryKeys) memory[key] = Number((memory[key] / memorySum).toFixed(4));
  }
  memory.half_life_days = clampRange(memory.half_life_days, 0.1, 3650, 30);
  memory.lookback_days = Math.min(3650, Math.max(1, Math.round(num(memory.lookback_days, 30))));
  const breaker = motivation.breaker;
  breaker.fail_streak = Math.min(20, Math.max(1, Math.round(num(breaker.fail_streak, 3))));
  breaker.base_cooldown_min = clampRange(breaker.base_cooldown_min, 0, 1440, 10);
  breaker.max_cooldown_min = clampRange(breaker.max_cooldown_min, breaker.base_cooldown_min, 10080, 1440);
  const override = motivation.emotion_override;
  override.safety_low = clampUnit(override.safety_low, 0.35);
  override.safety_low_offset = clampRange(override.safety_low_offset, -0.5, 0.5, 0.1);
  override.stress_high = clampUnit(override.stress_high, 0.7);
  override.stress_high_offset = clampRange(override.stress_high_offset, -0.5, 0.5, 0.08);
  override.pleasure_low = clampRange(override.pleasure_low, -1, 1, -0.25);
  override.pleasure_low_offset = clampRange(override.pleasure_low_offset, -0.5, 0.5, 0.06);
  override.arousal_high = clampRange(override.arousal_high, -1, 1, 0.4);
  override.arousal_high_offset = clampRange(override.arousal_high_offset, -0.5, 0.5, -0.05);
  override.fatigue_high = clampUnit(override.fatigue_high, 0.8);
  override.fatigue_high_offset = clampRange(override.fatigue_high_offset, -0.5, 0.5, 0.08);
  override.clamp_min = clampRange(override.clamp_min, -0.5, 0.5, -0.15);
  override.clamp_max = clampRange(override.clamp_max, override.clamp_min, 0.5, 0.2);
  motivation.situation.min_multiplier = clampRange(motivation.situation.min_multiplier, 0.5, 2, 0.85);
  motivation.situation.max_multiplier = clampRange(
    motivation.situation.max_multiplier,
    motivation.situation.min_multiplier,
    2,
    1.15,
  );
  motivation.hold_ratio = clampUnit(motivation.hold_ratio, 0.7);

  if (!config.speak || typeof config.speak !== 'object') {
    config.speak = structuredClone(defaultConfig.speak);
  }
  const speak = config.speak;
  speak.enabled = speak.enabled !== false;
  speak.check_interval_min = clampRange(speak.check_interval_min, 1, 120, 3);
  speak.min_idle_min = clampRange(speak.min_idle_min, 1, 2880, 25);
  speak.idle_half_min = clampRange(speak.idle_half_min, 5, 2880, 120);
  speak.trait_urge_gain = clampRange(speak.trait_urge_gain, 0, 2, 1);
  speak.threshold = clampRange(speak.threshold, 0.1, 1, 0.52);
  // 下限不能高于基础阈值，否则等于把门槛整体抬高
  speak.threshold_min = clampRange(speak.threshold_min, 0, speak.threshold, 0.4);
  speak.refractory_min = clampRange(speak.refractory_min, 0, 10080, 60);
  speak.max_per_day = Math.min(48, Math.max(0, Math.round(num(speak.max_per_day, 8))));
  speak.quiet_penalty = clampRange(speak.quiet_penalty, 0, 1, 0.35);
  // 会议/游戏仍然要能拦住：这个系数调小，长时间沉默会连开会都敢插话
  speak.busy_penalty = clampRange(speak.busy_penalty, 0, 1, 0.25);
  speak.hold_ratio = clampRange(speak.hold_ratio, 0.1, 1, 0.75);
  speak.carry_step = clampRange(speak.carry_step, 0, 0.5, 0.05);
  speak.carry_decay = clampRange(speak.carry_decay, 0, 0.5, 0.02);
  speak.carry_max = clampRange(speak.carry_max, 0, 1, 0.25);
  speak.jitter = clampRange(speak.jitter, 0, 0.3, 0.04);
  // 安静时段：YAML 可能写成字符串或只有一个值，统一收敛成 [起, 止)
  const quietRaw = Array.isArray(speak.quiet_hours) ? speak.quiet_hours : defaultConfig.speak.quiet_hours;
  const quietStart = Math.min(23, Math.max(0, Math.round(num(quietRaw[0], 0))));
  const quietEnd = Math.min(24, Math.max(0, Math.round(num(quietRaw[1], 7))));
  speak.quiet_hours = [quietStart, quietEnd];

  if (!config.think || typeof config.think !== 'object') {
    config.think = structuredClone(defaultConfig.think);
  }
  const think = config.think;
  think.enabled = think.enabled !== false;
  // 上限写死在归一化里：「每轮 ≤2 条、≤40 字」是对外约定，不交给配置随意放大
  think.max_per_turn = Math.min(2, Math.max(1, Math.round(num(think.max_per_turn, 2))));
  think.max_chars = Math.min(40, Math.max(8, Math.round(num(think.max_chars, 40))));
  think.min_gap_min = clampRange(think.min_gap_min, 1, 240, 20);
  think.threshold = clampRange(think.threshold, 0, 1, 0.55);

  if (!config.connectors || typeof config.connectors !== 'object') {
    config.connectors = structuredClone(defaultConfig.connectors);
  }
  const connectors = config.connectors;
  const sources = Array.isArray(connectors.ingest_sources)
    ? connectors.ingest_sources
    : defaultConfig.connectors.ingest_sources;
  // 来源统一成小写下划线：适配器清单和 URL 两边写法不一致时不该靠猜
  connectors.ingest_sources = [...new Set(
    sources
      .map((source) => String(source).trim().toLowerCase())
      .filter((source) => /^[a-z][a-z0-9_]*$/.test(source)),
  )];
  connectors.manifests_dir = String(connectors.manifests_dir ?? 'connectors').trim() || 'connectors';

  if (!config.expression || typeof config.expression !== 'object') {
    config.expression = structuredClone(defaultConfig.expression);
  }
  const expression = config.expression;
  expression.enabled = expression.enabled !== false;
  expression.prefer_pet = expression.prefer_pet !== false;
  const rawSinks = Array.isArray(expression.sinks) ? expression.sinks : [];
  const sinks: DaughterConfig['expression']['sinks'] = [];
  for (const item of rawSinks) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type ?? '');
    if (type === 'vpet') {
      sinks.push({ type: 'vpet' });
      continue;
    }
    if (type === 'http') {
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      if (!url) continue;
      sinks.push({ type: 'http', url, timeout_ms: clampRange(item.timeout_ms, 200, 30000, 3000) });
      continue;
    }
    if (type === 'pet') {
      // url 可省略：缺省由宿主在运行时用自己监听的端口拼出来，省得用户抄端口
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      const petId = typeof item.pet === 'string' ? item.pet.trim() : '';
      const route = typeof item.route === 'string' ? item.route.trim() : '';
      sinks.push({
        type: 'pet',
        ...(url ? { url } : {}),
        ...(petId ? { pet: petId } : {}),
        ...(route ? { route } : {}),
        timeout_ms: clampRange(item.timeout_ms, 200, 30000, 3000),
        // 0 是合法值（只要动作不要文字），所以下限放 0
        duration_ms: clampRange(item.duration_ms, 0, 60000, 10000),
      });
      continue;
    }
    if (type === 'file') {
      const path = typeof item.path === 'string' ? item.path.trim() : '';
      if (!path) continue;
      sinks.push({ type: 'file', path });
      continue;
    }
    // 未知 type 静默丢弃，配置手滑不该拖垮整个插件
  }
  // 一个都没配成时退回桌宠：宁可只到气泡，也不要静默丢消息
  expression.sinks = sinks.length > 0 ? sinks : [{ type: 'vpet' }];

  config.association.max_depth = Math.min(3, Math.max(1, Math.round(num(config.association.max_depth, 2))));
  config.association.fallback_when_no_match = config.association.fallback_when_no_match !== false;
  config.association.contradiction_enabled = config.association.contradiction_enabled !== false;
  config.association.contradiction_min_gap = Math.max(
    0,
    Math.min(1.5, num(config.association.contradiction_min_gap, 0.4)),
  );
  config.budget.max_total_tokens = Math.max(200, Math.round(num(config.budget.max_total_tokens, 3000)));
  config.safety.thresholds.stress_level1 = num(config.safety.thresholds.stress_level1, 0.7);
  config.safety.thresholds.safety_level2 = num(config.safety.thresholds.safety_level2, 0.35);
  config.safety.thresholds.fatigue_level2 = num(config.safety.thresholds.fatigue_level2, 0.8);
  config.safety.thresholds.overdraft_level3 = num(config.safety.thresholds.overdraft_level3, 0.8);
  config.decay.weight_decay_rate = Math.min(1, Math.max(0, num(config.decay.weight_decay_rate, 0.02)));
  config.evolution.l1_max_delta_per_write = Math.min(0.1, Math.max(0, num(config.evolution.l1_max_delta_per_write, 0.02)));
  const filter = config.filter;
  filter.habituation.window_minutes = Math.min(1440, Math.max(1, Math.round(num(filter.habituation.window_minutes, 30))));
  filter.habituation.identical_window_minutes = Math.min(
    10080,
    Math.max(1, Math.round(num(filter.habituation.identical_window_minutes, 1440))),
  );
  filter.habituation.max_repeat = Math.min(20, Math.max(1, Math.round(num(filter.habituation.max_repeat, 3))));
  filter.burst.window_minutes = Math.min(1440, Math.max(1, Math.round(num(filter.burst.window_minutes, 60))));
  filter.burst.max_keep = Math.min(20, Math.max(1, Math.round(num(filter.burst.max_keep, 3))));
  filter.burst.exempt_sources = (Array.isArray(filter.burst.exempt_sources) ? filter.burst.exempt_sources : [])
    .filter((source): source is string => typeof source === 'string' && source.length > 0);
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

  const douyin = config.douyin;
  douyin.enabled = douyin.enabled !== false;
  douyin.memory_db = typeof douyin.memory_db === 'string' ? douyin.memory_db.trim() : '';
  // 1 分钟一次已经比自己刷得还勤，再快只是空读；上限一天一次的量级足够追平
  douyin.poll_interval_min = Math.min(1440, Math.max(1, Math.round(num(douyin.poll_interval_min, 10))));
  douyin.max_items = Math.min(20, Math.max(1, Math.round(num(douyin.max_items, 5))));

  // 连接器认证（§12.2）：空字符串表示"用文件令牌"，过短的显式令牌在运行时会被忽略并告警
  config.security ??= { connector_token: '' };
  config.security.connector_token = String(config.security.connector_token ?? '').trim();
  config.desktop.enabled = config.desktop.enabled === true;
  config.desktop.bridge_url = String(config.desktop.bridge_url ?? '').trim() || 'http://127.0.0.1:47614';
  return config;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampUnit(value: unknown, fallback: number): number {
  const number = num(value, fallback);
  return Math.min(1, Math.max(0, number));
}

function clampRange(value: unknown, min: number, max: number, fallback: number): number {
  return Math.min(max, Math.max(min, num(value, fallback)));
}
