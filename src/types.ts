import type { Logger } from './util.js';

export type ISOTime = string;
/** 统一 0..1 区间 */
export type Unit = number;

export interface PadState {
  /** -1..1 */
  pleasure: number;
  /** -1..1 */
  arousal: number;
  /** -1..1 */
  dominance: number;
}

/* -------------------------------- 人格 L1–L4 -------------------------------- */

export interface BigFive {
  openness: Unit;
  conscientiousness: Unit;
  extraversion: Unit;
  agreeableness: Unit;
  neuroticism: Unit;
}

/** 依恋底色：出生只抽前三种，混乱型只能由经历演化出来 */
export type AttachmentType = 'secure' | 'anxious' | 'avoidant' | 'disorganized';

/** 影响人格的"冲击等级"：日常不动人格，关键事件才大步推进 */
export type ImpactKind = 'routine' | 'cumulative' | 'critical' | 'phase';

export interface L1Baseline {
  bigFive: BigFive;
  /**
   * 先天段锚点：出生时抽定，之后不再改写。
   * 五维只能在这组锚点的 ±personality.drift_cap 内漂移，既保证"人还是那个人"，又留出极端空间。
   */
  innate?: BigFive;
  temperament: 'slow_warmup' | 'eager' | 'steady' | 'guarded';
  moodBaseline: PadState;
  noveltySeeking: Unit;
  plasticityBase: Unit;
  /** 当前可塑性：随经历衰减，极端后减半；缺省按 1 - plasticityBase 计算 */
  plasticity?: Unit;
  updatedAt: ISOTime;
}

export interface L2Relationship {
  attachmentAnxiety: Unit;
  attachmentAvoidance: Unit;
  coreNeeds: string[];
  trustBaseline: Unit;
  relationshipStage: 'stranger' | 'acquaintance' | 'familiar' | 'close' | 'dependent';
  relationshipDepth: Unit;
  /** 依恋底色，由焦虑/回避两维推导；混乱型只能靠"靠近—伤害"循环演化 */
  attachmentType?: AttachmentType;
  updatedAt: ISOTime;
}

/** 自我叙事三轴：不是结论标签，只作为后续事件的解读滤镜 */
export interface SelfNarrative {
  /** 世界是善意的还是危险的 */
  worldSafe: Unit;
  /** 亲近的人会不会离开 */
  othersReliable: Unit;
  /** 我值不值得被爱 */
  selfWorth: Unit;
  /** 曾经跨过锁定阈值的轴（只记录事实，不对外当标签用） */
  lockedAxes: string[];
  updatedAt: ISOTime;
}

/** 一条人格证据：面板只展示事实，不下"你现在是 X 型"的结论 */
export interface PersonalityEvidence {
  id: string;
  at: ISOTime;
  eventId: string;
  layer: 'L1' | 'L2' | 'L3';
  dimension: string;
  delta: number;
  impactKind: ImpactKind;
  impact: number;
  /** 当时的原话片段，供用户自己判断 */
  quote: string;
}

export interface CopingStrategy {
  id: string;
  trigger: string;
  response: string;
  weight: Unit;
}

/** 善恶观：独立于八维的价值取向，只描述倾向，不做道德评判 */
export interface MoralOutlook {
  /** 0 偏自保/功利，1 偏利他/共情 */
  altruism: Unit;
  /** 0 灵活变通，1 守原则 */
  principle: Unit;
  /** 一句话立场 */
  stance: string;
  /** 红线：任何情况下都不做 */
  redLines: string[];
}

export interface L3Cognition {
  biasWeights: Record<string, Unit>;
  defenseMaturity: Unit;
  copingStrategies: CopingStrategy[];
  moral: MoralOutlook;
  /** 自我叙事三轴（缺省时按中性值补齐） */
  narrative?: SelfNarrative;
  /** 人格证据链：只存事实，最多保留最近若干条 */
  evidence?: PersonalityEvidence[];
  updatedAt: ISOTime;
}

export interface SubPersona {
  id: 'to_father' | 'to_stranger' | 'alone' | string;
  weight: Unit;
  tone: string;
  disclosureLevel: Unit;
  boundaries: string[];
}

export interface L4Contextual {
  subPersonas: SubPersona[];
  updatedAt: ISOTime;
}

export interface PersonaBundle {
  l1: L1Baseline;
  l2: L2Relationship;
  l3: L3Cognition;
  l4: L4Contextual;
}

/* -------------------------------- 运行时 L5 -------------------------------- */

/**
 * 外部生理信号（桌宠存档）。
 * 只作为运行时状态的「外部分量」，不写回 L1–L4，也不覆盖对话驱动的疲劳/压力；
 * 过期后自动失效，插件在没有桌宠时与本字段为空完全等价。
 */
export interface BodySignal {
  /** 1 = 满值；来源不同时用归一化后的 0..1 */
  strength: Unit;
  /** 心情，1 = 满值 */
  feeling: Unit;
  source: 'vpet' | 'pet-shell';
  at: ISOTime;
}

export interface L5State {
  sessionId: string;
  characterId: string;

  emotion: PadState;
  stress: Unit;
  safety: Unit;
  fatigue: Unit;
  /** 角色级全局量的会话内缓存，权威值见 Store 的透支文件 */
  emotionalOverdraft: Unit;
  boundary: Unit;
  /** 最近一次收到的外部生理信号；仅用于派生有效状态，不参与写回 */
  body?: BodySignal | null;

  activeSubPersonaId: string;
  /** stress 连续高于阈值的起点，用于 level1 持续时间判定 */
  stressHighSince?: ISOTime;
  /** safety 连续低于阈值的起点 */
  safetyLowSince?: ISOTime;

  lastTickAt: ISOTime;
  snapshotAt: ISOTime;
  schemaVersion: 1;
}

/* -------------------------------- 事件记忆 -------------------------------- */

export interface EmotionTag extends PadState {
  intensity: Unit;
}

export interface EventLink {
  targetId: string;
  kind: 'topic' | 'causal' | 'person' | 'emotion' | 'contradiction';
  strength: Unit;
}

export interface EmotionHistoryEntry {
  at: ISOTime;
  emotion: PadState;
  reason: string;
}

export interface EventRecord {
  id: string;
  characterId: string;
  title: string;
  summary: string;
  tags: string[];
  participants: string[];

  emotionAtTime: EmotionTag;
  emotionNowHistory: EmotionHistoryEntry[];

  importance: Unit;
  weight: Unit;
  links: EventLink[];

  source: 'chat' | 'qq' | 'douyin_dm' | 'douyin_content' | 'minecraft' | 'game' | 'android' | 'system';
  createdAt: ISOTime;
  lastRecalledAt?: ISOTime;
  recallCount: number;
  /** 认知滤网给出的显著性（0..1）；旧数据缺省视为未知，不参与忘却 */
  salience?: Unit;
  /** 同题重复被合并的次数（习惯化），不新增事件条目 */
  mergedCount?: number;
  archived: boolean;

  schemaVersion: 1;
}

/* -------------------------------- 技能与资产 -------------------------------- */

export type SkillStatus = 'draft' | 'active' | 'frozen' | 'deprecated';

export interface SkillStep {
  order: number;
  description: string;
  tool?: string;
  argsTemplate?: Record<string, unknown>;
  onFailure: 'abort' | 'continue' | 'fallback';
}

export interface SkillBoundary {
  requiresConfirm: boolean;
  costLevel: 'low' | 'medium' | 'high';
  forbiddenContexts: string[];
}

export interface SkillCard {
  id: string;
  characterId: string;
  name: string;
  intent: string;
  keywords: string[];
  requiredTools: string[];
  steps: SkillStep[];
  boundary: SkillBoundary;

  maturity: Unit;
  successCount: number;
  failCount: number;
  version: number;
  status: SkillStatus;
  lastUsedAt?: ISOTime;
  /** 连续失败次数：成功即清零，用于习得性无助熔断 */
  failStreak?: number;
  /** 熔断解除时间：此前该技能只避不做，冷却按失败次数指数增长 */
  breakerUntil?: ISOTime;
  updatedAt: ISOTime;
  schemaVersion: 1;
}

export type AssetKind = 'MAC' | 'CON' | 'MOT' | 'CMB';

export interface AssetPackage {
  id: string;
  kind: AssetKind;
  name: string;
  compiledFromSkillId?: string;
  payload: Record<string, unknown>;
  padMatch?: PadState;
  rollbackVersion: number;
  status: 'active' | 'rolled_back' | 'deprecated';
  createdAt: ISOTime;
  schemaVersion: 1;
}

/* -------------------------------- 条件反射 -------------------------------- */

export type ReflexMatch =
  | { type: 'keyword'; patterns: string[] }
  | { type: 'regex'; pattern: string }
  | { type: 'state'; predicate: Partial<Pick<L5State, 'stress' | 'safety' | 'fatigue'>> }
  | { type: 'event'; source: string };

export type ReflexAction =
  | { kind: 'template_reply'; text: string }
  | { kind: 'tool_call'; tool: string; argsTemplate: Record<string, unknown> }
  | { kind: 'motion'; motionId: string }
  | { kind: 'state_shift'; delta: Partial<PadState> & { stress?: number } };

export interface ReflexRule {
  id: string;
  enabled: boolean;
  priority: number;
  cooldownMs: number;
  match: ReflexMatch;
  action: ReflexAction;
  lastFiredAt?: ISOTime;
}

/* -------------------------------- 安全与日志 -------------------------------- */

export interface SafetyState {
  level: 0 | 1 | 2 | 3;
  reasons: string[];
  overstressDurationMs: number;
  functionalImpairment: Unit;
  triggers: string[];
  since: ISOTime;
}

export interface EvolutionLogEntry {
  id: string;
  characterId: string;
  target: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'skill' | 'asset' | 'safety';
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string;
  triggerEventId?: string;
  at: ISOTime;
}

/* -------------------------------- 对外接口 -------------------------------- */

export interface ToolInvoker {
  invoke(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface PluginContext {
  characterId: string;
  sessionId: string;
  workspaceId: string;
  turnId: string;
  now(): ISOTime;
  logger: Logger;
  tools: ToolInvoker;
  /** 可选：对话对象，用于 L4 子人格选择 */
  audience?: 'to_father' | 'to_stranger' | 'alone';
  /** 可选：SSE 事件通道（桌宠动作播放等） */
  emit?(event: string, payload: Record<string, unknown>): void;
}

export interface SafetyVerdict {
  level: 0 | 1 | 2 | 3;
  allowTools: boolean;
  suppressExpressiveness: boolean;
  reasons: string[];
}

export interface PromptBlock {
  kind: 'persona' | 'state_hint' | 'event_digest' | 'skill_digest' | 'association' | 'constraint';
  text: string;
  tokens: number;
  priority: number;
}

export interface RetrievalHit {
  event: EventRecord;
  score: number;
  reason: string;
}

export interface AssociationHit {
  eventId: string;
  via: EventLink;
  score: number;
  /** 从种子往下走了几跳；1 表示直接相连 */
  depth?: number;
  /** 联想路径上的事件 ID，path[0] 是种子，用于向用户解释"为什么想起这段" */
  path?: string[];
}

/** 动机信号通道：人格只调这些通道的阈值，不直接改分数 */
export type SignalChannel = 'social' | 'achievement' | 'exploration' | 'safety' | 'harmony';

export type MotivationDecision = 'act' | 'hold' | 'avoid';

/** 单个技能的动机评分明细，便于调试与可复现审计 */
export interface MotivationBreakdown {
  skillId: string;
  channel: SignalChannel;
  /** 基础信号：文本相似度 + 关键词命中 */
  signal: number;
  /** 人格对阈值的偏移（正数更难触发） */
  personalityOffset: number;
  /** 情绪对阈值的偏移 */
  emotionOffset: number;
  /** 最终生效阈值 */
  threshold: number;
  familiarityGain: number;
  memoryGain: number;
  situationMultiplier: number;
  /** 人格对分数的增益（方向舵：>1 表示该通道更想动，<1 表示更不想动） */
  traitSignalGain: number;
  score: number;
  decision: MotivationDecision;
  breakerActive: boolean;
}

export interface SkillActivation {
  main?: SkillCard;
  associated: SkillCard[];
  confidence: number;
  /** 动机评分明细（关闭 motivation 时为空） */
  breakdown?: MotivationBreakdown[];
}

export interface DaughterPlugin {
  onUserMessage(input: {
    ctx: PluginContext;
    text: string;
    source: EventRecord['source'];
  }): Promise<{ l5: L5State; verdict: SafetyVerdict }>;

  beforePromptBuild(input: {
    ctx: PluginContext;
    tokenBudget: number;
  }): Promise<{ blocks: PromptBlock[]; usedTokens: number; memoryHit: boolean }>;

  afterResponse(input: {
    ctx: PluginContext;
    userText: string;
    assistantText: string;
    /** 本轮实际调用过的工具名（按调用顺序），用于沉淀技能草稿与判定技能成败 */
    toolsUsed?: string[];
  }): Promise<{ eventId?: string; skillsUpdated: string[]; evolutionIds: string[] }>;

  retrieve(input: {
    characterId: string;
    query: string;
    now: ISOTime;
    topK: number;
    currentEmotion: PadState;
    excludeArchived: boolean;
  }): Promise<RetrievalHit[]>;

  associate(input: {
    characterId: string;
    seedEventIds: string[];
    maxDepth: number;
    maxInjected: number;
  }): Promise<AssociationHit[]>;

  skillActivate(input: {
    ctx: PluginContext;
    userText: string;
    maxMain: number;
    maxAssociated: number;
  }): Promise<SkillActivation>;

  assetInvoke(input: {
    ctx: PluginContext;
    assetId: string;
    args: Record<string, unknown>;
  }): Promise<{ ok: boolean; output?: unknown; rolledBack?: boolean; reason?: string }>;

  reflexMatch(input: {
    ctx: PluginContext;
    userText: string;
    l5: L5State;
    /** 触发消息来源，用于 event 类型反射匹配 */
    source?: EventRecord['source'];
  }): Promise<{ ruleId: string; action: ReflexAction } | null>;

  motionPlay(input: { ctx: PluginContext; motionId: string }): Promise<{ ok: boolean }>;

  /** 外部应用（QQ/抖音/MC/游戏/手机）入站消息归一化为事件 */
  ingestExternalEvent(input: {
    ctx: PluginContext;
    text: string;
    source: EventRecord['source'];
  }): Promise<{ eventId: string }>;

  tick(input: { characterId: string; now: ISOTime }): Promise<{
    decayed: number;
    archived: number;
    recovered: boolean;
  }>;

  /**
   * 主动开口评估：没人说话时她想不想开口。
   * `jitter` 由调用方给随机值（-1..1），避免行为像定时任务。
   */
  speakPlan(input: { characterId: string; now: ISOTime; jitter?: number }): Promise<SpeakPlan | null>;

  /** 星图面板：按当前库实时重算并落盘，返回节点/边/星系计数 */
  starMap(characterId: string, now: ISOTime): { nodes: number; edges: number; galaxies: number };

  /**
   * 接收桌宠上报的生理信号（体力/心情）。缺席即视为没有桌宠：
   * 不调用时插件行为与不带 `vpet` 配置完全一致。
   */
  syncBodySignal(input: { characterId: string; strength: Unit; feeling: Unit; source?: BodySignal['source'] }): void;

  safetyCheck(input: { ctx: PluginContext; l5: L5State }): SafetyVerdict;

  /** §13 指标：记忆命中率、注入 token P95、反射命中率、降级率 */
  metrics(characterId: string): DaughterMetrics;

  /** 关闭底层存储句柄 */
  close(): void;
}

export interface DaughterMetrics {
  memoryHitRate: number;
  injectTokenP95: number;
  reflexHitRate: number;
  degradeRate: number;
  /** 超出 §6.1 时延预算的轮次占比（retrieve >150ms 或整轮 >100ms） */
  overBudgetRate: number;
  turns: number;
  reflexHits: number;
  window: number;
}

/* -------------------------------- 主动开口 -------------------------------- */

/** 她为什么想说——决定文案池，也解释得清动机来源 */
export type SpeakReason = 'miss' | 'care' | 'share' | 'worry' | 'bored';

/**
 * act：说；hold：想但忍住了（累积压力）；silent：没到那份上。
 * hold 是拟人的关键——真实的主动开口前面通常有几次欲言又止。
 */
export type SpeakDecision = 'act' | 'hold' | 'silent';

export interface SpeakPlan {
  decision: SpeakDecision;
  /** 想说话的强度 0..1 */
  urge: number;
  /** 本轮阈值，受人格/情绪/时段影响 */
  threshold: number;
  reason: SpeakReason;
  /** 本轮结束后的"憋着"压力，调用方写回存储 */
  carry: number;
  /** decision=act 时的气泡文案 */
  text?: string;
  /** 本次用的文案下标，调用方可写回以避开连续重复 */
  lineIndex?: number;
}

/**
 * 主动开口的参数。默认高频检查、低频开口：
 * 每 `check_interval_min` 分钟评估一次，但真开口要同时过冷却、日上限与安静时段。
 */
export interface SpeakConfig {
  enabled: boolean;
  /** 评估间隔（分钟），不是开口间隔 */
  check_interval_min: number;
  /** 至少沉默多久才开始考虑开口 */
  min_idle_min: number;
  /** 思念累积的半饱和时间：idle = half 时想说话的强度约 0.5 */
  idle_half_min: number;
  /** 人格对"想说话"强度的放大倍数（0 = 人格不影响，1 = 原始权重） */
  trait_urge_gain: number;
  /** 基础阈值 */
  threshold: number;
  /** 阈值下限，防止极端人格把门槛压到"见谁都说话" */
  threshold_min: number;
  /** 上次主动开口后的强制沉默，冷却期内一律 silent */
  refractory_min: number;
  /** 每天最多主动开口几次 */
  max_per_day: number;
  /** 安静时段 [起, 止)，按 0–24 小时。深夜不打扰 */
  quiet_hours: number[];
  /** 安静时段抬升的阈值 */
  quiet_penalty: number;
  /** 用户正在开会/游戏/写代码时抬升的阈值（乘以场景权重） */
  busy_penalty: number;
  /** 想但忍住的门槛比例：urge ≥ ratio × threshold 记 hold */
  hold_ratio: number;
  /** 一次 hold 累积的压力 */
  carry_step: number;
  /** 未达 hold 时压力自然消退的速率 */
  carry_decay: number;
  /** 压力上限，避免憋久了必然开口 */
  carry_max: number;
  /** 外部注入的抖动幅度，避免像定时任务一样精确 */
  jitter: number;
}

/* -------------------------------- 表达出口 -------------------------------- */

/**
 * 出口配置。`vpet` 走游戏的事件队列；`pet` 走 DSH 内置桌宠（dsh-pet）的路由；
 * `http` 把 JSON POST 给任意应用；`file` 追加 JSONL，供本地进程 tail。
 * 可同时启用多个。
 */
export interface ExpressionSinkConfig {
  type: 'vpet' | 'pet' | 'http' | 'file';
  /** http / pet 出口的目标地址；pet 缺省用宿主自己监听的端口 */
  url?: string;
  /** file 出口路径，相对路径按插件根目录解析 */
  path?: string;
  /** 请求超时（毫秒） */
  timeout_ms?: number;
  /** pet 出口：要投给哪只桌宠，缺省 main（dsh-pet 的默认宠物） */
  pet?: string;
  /** pet 出口：气泡停留时长（毫秒），0 = 只要动画不要文字 */
  duration_ms?: number;
  /** pet 出口：dsh-pet 的路由段覆盖，缺省 /dsh-pet-7340（插件升级改段时用） */
  route?: string;
}

export interface ExpressionConfig {
  enabled: boolean;
  /** 出口列表；留空或全部非法时退回桌宠，避免"开了却没人收到" */
  sinks: ExpressionSinkConfig[];
  /**
   * 出口只配了出厂默认的 `vpet` 时，若探测到 DSH 内置桌宠（dsh-pet）在跑，
   * 就让它接管表达——两套桌宠同时开只会把同一句话各弹一遍。
   * 想守着 VPet 就把这里设为 false。
   */
  prefer_pet: boolean;
}

/* -------------------------------- 配置 -------------------------------- */

/**
 * 动机算法参数。所有数值可配置，关闭 enabled 即退回旧的相似度打分。
 */
export interface MotivationConfig {
  enabled: boolean;
  /** 人格对阈值的最大影响强度（0 表示人格不影响决策） */
  trait_threshold_gain: number;
  /** 阈值下限：人格/情绪偏移再大也不会让阈值低于此值（0 表示不设下限） */
  min_threshold: number;
  /**
   * 人格对分数的增益上限（0 表示人格不影响分数）。
   * 与 trait_threshold_gain 分工：那个管"多少力才能推开门"，这个管"哪个方向更想走"。
   */
  trait_signal_gain: number;
  /** 熟悉度倒 U：exposure = uses / (uses + k) */
  familiarity: {
    k: number;
    peak: number;
    sigma: number;
  };
  /** 记忆三路径权重与时间衰减 */
  memory: {
    outcome_weight: number;
    emotion_weight: number;
    efficacy_weight: number;
    /** 结果预期按上次使用时间衰减的半衰期（天） */
    half_life_days: number;
    /** 情绪记忆只看最近多少天的事件 */
    lookback_days: number;
  };
  /** 习得性无助熔断 */
  breaker: {
    fail_streak: number;
    base_cooldown_min: number;
    max_cooldown_min: number;
  };
  /** 情绪覆盖：阈值偏移的触发条件与幅度 */
  emotion_override: {
    safety_low: number;
    safety_low_offset: number;
    stress_high: number;
    stress_high_offset: number;
    pleasure_low: number;
    pleasure_low_offset: number;
    arousal_high: number;
    arousal_high_offset: number;
    fatigue_high: number;
    fatigue_high_offset: number;
    clamp_min: number;
    clamp_max: number;
  };
  /** 情境乘子：社交通道按亲密度放大/缩小，其余通道影响减半 */
  situation: {
    min_multiplier: number;
    max_multiplier: number;
  };
  /** hold 与阈值之比：score ≥ ratio * threshold 时保留但不主动 */
  hold_ratio: number;
}

export interface ScoreWeights {
  semantic: number;
  recency: number;
  weight: number;
  emotion_match: number;
  link_proximity: number;
}

export interface DaughterConfig {
  version: number;
  character_id: string;
  seed: number;
  random_surprise_enabled: boolean;
  retrieval: {
    top_k: number;
    half_life_days: number;
    surprise_eta: number;
    exclude_archived: boolean;
    max_candidates: number;
    score_weights: ScoreWeights;
    min_score: number;
    /**
     * 直接命中要求的最低语义分。语义为 0（与提问毫无字面/子串重合）的事件即使
     * 近因、权重、情绪都很高也不算"相关记忆"——它们该由联想通道带出来，
     * 否则每次提问都会固定返回最近那几条，联想永远排不上用场。
     */
    min_semantic: number;
    /**
     * 回忆重构的最小情绪位移（PAD 距离，满量程 1）。
     * 只有当前情绪与事件快照差到这一步，才记一条"回看感受"。
     * 真实库的标定：事件两两距离 p50≈0.04、p90≈0.14，所以 0.08 大约只对四分之一的召回生效；
     * 想让回看更密集就往下调（0.04 起），想让记录更稀有就往上调。
     */
    reconstruct_distance: number;
    /**
     * 同一条记忆的回看冷却（分钟）。距离门槛挡不住高频召回，
     * 一轮十几条、两轮就能写满 `emotionNowHistory`，所以要按时间限流。
     */
    reconstruct_cooldown_minutes: number;
    /** 命中事件是否在预算允许时展开全文层摘录（§4.4 摘要层/全文层分离） */
    expand_fulltext: boolean;
    /** 单条摘录的最大字符数 */
    fulltext_excerpt_chars: number;
  };
  association: {
    max_depth: number;
    max_injected: number;
    hop_decay: number;
    /** 字面检索一条都没命中时，用最近事件当种子跑一跳联想（"想不起对应的事，就从近的事顺下去"） */
    fallback_when_no_match: boolean;
  };
  skills: {
    max_main: number;
    max_associated: number;
    maturity_threshold_automate: number;
    min_success_for_freeze: number;
    min_main_score: number;
    min_associated_score: number;
    /** 一轮里至少用到几个工具才沉淀成技能草稿（<2 视为 2） */
    min_steps_to_learn: number;
  };
  /**
   * 行为动机：决策层用动机评分替代单一文本相似度。
   * 阈值由人格与情绪偏移决定，分数由熟悉度、记忆与情境乘子决定。
   */
  motivation: MotivationConfig;
  /** 主动开口：空下来多久会忍不住说话。与 motivation 共用同一套人格/情绪输入 */
  speak: SpeakConfig;
  /** 表达出口：她主动说的话发给谁（游戏桌宠 / HTTP 应用 / JSONL） */
  expression: ExpressionConfig;
  reflex: {
    enabled: boolean;
    max_match_ms: number;
    /** 命中即不调用模型。宿主 reject 会丢弃该条用户消息，聊天里看不到，默认关闭 */
    short_circuit: boolean;
  };
  budget: {
    max_total_tokens: number;
    block_caps: {
      persona: number;
      state_hint: number;
      event_digest: number;
      skill_digest: number;
      association: number;
      constraint: number;
    };
  };
  safety: {
    enabled: boolean;
    diagnosis_labels_forbidden: boolean;
    thresholds: {
      stress_level1: number;
      safety_level2: number;
      fatigue_level2: number;
      overdraft_level3: number;
    };
    hysteresis: number;
    level1_min_duration_min: number;
  };
  storage: {
    scope: 'character';
    shared_across_sessions: boolean;
    shared_across_workspaces: boolean;
    data_root: string;
    backend: 'sqlite';
    single_writer: boolean;
  };
  decay: {
    weight_decay_rate: number;
    recall_boost: number;
    archive_threshold: number;
    archive_idle_days: number;
  };
  evolution: {
    l1_max_delta_per_write: number;
    min_turns_between_writes: number;
    log_retention_days: number;
  };
  /**
   * 性格演化：写实为基（日常不动人格），关键事件才能把人推到极端。
   * 五维只能在「出生锚点 ± drift_cap」内移动；混乱型只能演化、不能出生。
   */
  personality: {
    enabled: boolean;
    drift_cap: number;
    critical_threshold: number;
    cumulative_threshold: number;
    critical_step: number;
    cumulative_step: number;
    same_direction_bonus_after: number;
    /** 修复效率乘数（按依恋类型），越小越难修 */
    repair: { secure: number; anxious: number; avoidant: number; disorganized: number };
    initial: {
      ranges: Record<keyof BigFive, [number, number]>;
      attachment_priors: { secure: number; anxious: number; avoidant: number };
    };
    evidence_cap: number;
  };
  desktop: {
    enabled: boolean;
    bridge_url: string;
  };
  /** 抖音联动：只读 dsh-douyin-browser-local 的共享记忆库，把刷到的内容记成她的事件 */
  douyin: {
    enabled: boolean;
    /** 共享记忆库路径，支持 `~`；留空用 ~/.dsh/douyin-browser/memory/shared.sqlite */
    memory_db: string;
    /** 多久拉一次新记录（分钟） */
    poll_interval_min: number;
    /** 单次最多入库几条，避免一口气灌满事件流 */
    max_items: number;
  };
  /** 认知滤网：写入门控 / 习惯化 / 忘却（见 §8.5） */
  filter: {
    enabled: boolean;
    /** 来源可信度：同时用于写入门控与检索降权 */
    source_weights: Record<string, number>;
    shield: {
      sources: string[];
      keywords: string[];
      patterns: string[];
    };
    habituation: {
      /** 同题重复判定的时间窗（分钟） */
      window_minutes: number;
      /** 窗口内同题条目最多保留几次计数，超过后不再入库 */
      max_repeat: number;
    };
    /**
     * 同源爆发抑制：外部来源短时间涌进来一串内容时（刷视频、切窗口）不能照单全收。
     * 习惯化按"内容像不像"合并，模板相同但条目不同的输入相似度不够，
     * 于是照样一条条写库——真实库里抖音一度占到事件总数的一半以上。
     */
    burst: {
      /** 计数窗口（分钟） */
      window_minutes: number;
      /** 窗口内同一来源最多保留几条，超出即丢弃 */
      max_keep: number;
      /** 不受配额限制的来源：对话是真实发生的事，不该被限流 */
      exempt_sources: string[];
    };
    salience: {
      /** 显著性低于该值且来源可信度 ≤0.5 时直接丢弃 */
      drop_below: Unit;
    };
    forget: {
      enabled: boolean;
      /** 闲置多少天后归档 */
      idle_days: number;
      /** 显著性低于该值才可能被忘却 */
      min_salience: Unit;
    };
  };
  /**
   * 情感回落：L5 的 stress / fatigue / safety 若只增不减，量程会失效
   * （实测 safety 贴 1.00、stress 贴 0.00 之后不再产生任何信息）。
   * tick 里按闲置时长向基线回归，情绪三维同步向 L1 心情基线靠拢。
   */
  emotion_relax: {
    enabled: boolean;
    /** 每小时向基线回归的比例（0..1） */
    rate_per_hour: Unit;
    /** 闲置多少小时后才开始回落，避免连续对话时被削平 */
    idle_hours: number;
    stress_baseline: Unit;
    fatigue_baseline: Unit;
    safety_baseline: Unit;
  };
  /** 桌宠联动：全部可选能力，缺任一方的运行时行为都不变 */
  vpet: {
    enabled: boolean;
    /** 桌宠生理信号 → 角色运行时状态（只影响 L5，不写回人格） */
    body_link: {
      enabled: boolean;
      /** 超过该时长没有新信号就视为失效 */
      stale_ms: number;
      /** 体力低 → 疲劳的映射强度 */
      fatigue_weight: Unit;
      /** 心情低 → 压力的映射强度 */
      stress_weight: Unit;
      /** 外部信号最多把疲劳/压力推到多少，给对话留余量 */
      max_influence: Unit;
    };
  };
}
