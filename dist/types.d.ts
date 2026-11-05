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
export interface L1Baseline {
    bigFive: {
        openness: Unit;
        conscientiousness: Unit;
        extraversion: Unit;
        agreeableness: Unit;
        neuroticism: Unit;
    };
    temperament: 'slow_warmup' | 'eager' | 'steady' | 'guarded';
    moodBaseline: PadState;
    noveltySeeking: Unit;
    plasticityBase: Unit;
    updatedAt: ISOTime;
}
export interface L2Relationship {
    attachmentAnxiety: Unit;
    attachmentAvoidance: Unit;
    coreNeeds: string[];
    trustBaseline: Unit;
    relationshipStage: 'stranger' | 'acquaintance' | 'familiar' | 'close' | 'dependent';
    relationshipDepth: Unit;
    updatedAt: ISOTime;
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
export type ReflexMatch = {
    type: 'keyword';
    patterns: string[];
} | {
    type: 'regex';
    pattern: string;
} | {
    type: 'state';
    predicate: Partial<Pick<L5State, 'stress' | 'safety' | 'fatigue'>>;
} | {
    type: 'event';
    source: string;
};
export type ReflexAction = {
    kind: 'template_reply';
    text: string;
} | {
    kind: 'tool_call';
    tool: string;
    argsTemplate: Record<string, unknown>;
} | {
    kind: 'motion';
    motionId: string;
} | {
    kind: 'state_shift';
    delta: Partial<PadState> & {
        stress?: number;
    };
};
export interface ReflexRule {
    id: string;
    enabled: boolean;
    priority: number;
    cooldownMs: number;
    match: ReflexMatch;
    action: ReflexAction;
    lastFiredAt?: ISOTime;
}
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
}
export interface SkillActivation {
    main?: SkillCard;
    associated: SkillCard[];
    confidence: number;
}
export interface DaughterPlugin {
    onUserMessage(input: {
        ctx: PluginContext;
        text: string;
        source: EventRecord['source'];
    }): Promise<{
        l5: L5State;
        verdict: SafetyVerdict;
    }>;
    beforePromptBuild(input: {
        ctx: PluginContext;
        tokenBudget: number;
    }): Promise<{
        blocks: PromptBlock[];
        usedTokens: number;
        memoryHit: boolean;
    }>;
    afterResponse(input: {
        ctx: PluginContext;
        userText: string;
        assistantText: string;
        /** 本轮实际调用过的工具名（按调用顺序），用于沉淀技能草稿与判定技能成败 */
        toolsUsed?: string[];
    }): Promise<{
        eventId?: string;
        skillsUpdated: string[];
        evolutionIds: string[];
    }>;
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
    }): Promise<{
        ok: boolean;
        output?: unknown;
        rolledBack?: boolean;
        reason?: string;
    }>;
    reflexMatch(input: {
        ctx: PluginContext;
        userText: string;
        l5: L5State;
        /** 触发消息来源，用于 event 类型反射匹配 */
        source?: EventRecord['source'];
    }): Promise<{
        ruleId: string;
        action: ReflexAction;
    } | null>;
    motionPlay(input: {
        ctx: PluginContext;
        motionId: string;
    }): Promise<{
        ok: boolean;
    }>;
    /** 外部应用（QQ/抖音/MC/游戏/手机）入站消息归一化为事件 */
    ingestExternalEvent(input: {
        ctx: PluginContext;
        text: string;
        source: EventRecord['source'];
    }): Promise<{
        eventId: string;
    }>;
    tick(input: {
        characterId: string;
        now: ISOTime;
    }): Promise<{
        decayed: number;
        archived: number;
        recovered: boolean;
    }>;
    /** 星图面板：按当前库实时重算并落盘，返回节点/边/星系计数 */
    starMap(characterId: string, now: ISOTime): {
        nodes: number;
        edges: number;
        galaxies: number;
    };
    /**
     * 接收桌宠上报的生理信号（体力/心情）。缺席即视为没有桌宠：
     * 不调用时插件行为与不带 `vpet` 配置完全一致。
     */
    syncBodySignal(input: {
        characterId: string;
        strength: Unit;
        feeling: Unit;
        source?: BodySignal['source'];
    }): void;
    safetyCheck(input: {
        ctx: PluginContext;
        l5: L5State;
    }): SafetyVerdict;
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
        /** 命中事件是否在预算允许时展开全文层摘录（§4.4 摘要层/全文层分离） */
        expand_fulltext: boolean;
        /** 单条摘录的最大字符数 */
        fulltext_excerpt_chars: number;
    };
    association: {
        max_depth: number;
        max_injected: number;
        hop_decay: number;
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
    desktop: {
        enabled: boolean;
        bridge_url: string;
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
