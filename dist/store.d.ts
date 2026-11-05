import type { InitialPersonalityInput } from './runtime/personality.js';
import type { Logger } from './util.js';
import type { AssetPackage, BodySignal, EvolutionLogEntry, EventRecord, L1Baseline, L2Relationship, L3Cognition, L4Contextual, L5State, PersonaBundle, ReflexRule, SafetyState, SkillCard } from './types.js';
/** 出厂人格基线：星图面板用它算“相对出厂值的偏移”，只读，不参与写回 */
export declare const DEFAULT_L1: L1Baseline;
export declare const DEFAULT_L2: L2Relationship;
export declare const DEFAULT_L3: L3Cognition;
export declare const DEFAULT_L4: L4Contextual;
export interface StoreOptions {
    /** §5.3 单写者：false 时退化为无锁写，仅用于确认无并发写者的场景 */
    lock?: boolean;
    /** 出生人格抽样区间与依恋先验（只影响新建角色，已有存档不动） */
    personality?: InitialPersonalityInput;
}
export declare class Store {
    readonly characterId: string;
    readonly dataRoot: string;
    private db;
    private logger;
    private rand;
    private readonly seed;
    private readonly initialPersonality?;
    private ftsAvailable;
    /** 最近一次 FTS 检索的失败原因；null 表示正常，供 index 计入降级指标 */
    lastFtsError: string | null;
    private readonly lockEnabled;
    constructor(dataRoot: string, characterId: string, seed?: number, logger?: Logger, options?: StoreOptions);
    get paths(): {
        root: string;
        brain: string;
        db: string;
        fulltext: string;
        neocortex: string;
        prefrontal: string;
        l5: string;
        safety: string;
        overdraft: string;
        body: string;
        skills: string;
        assets: string;
        reflexes: string;
        motions: string;
        evolution: string;
        archive: string;
        starMap: string;
    };
    /** FTS5 索引是否可用（不可用时检索退回 Dice 字面匹配） */
    get ftsReady(): boolean;
    close(): void;
    /** 带角色级锁的原子写（§5.3）：所有 YAML/JSON 落盘统一走这里 */
    private writeLocked;
    /** fullText 缺省时退化为摘要，避免全文层与摘要层完全重复 */
    addEvent(event: EventRecord, fullText?: string): void;
    getEvent(id: string): EventRecord | null;
    /** 检索候选集：按权重与时间排序的非归档事件 */
    listCandidates(includeArchived: boolean, limit: number): EventRecord[];
    listAllEvents(): EventRecord[];
    updateEventMutable(id: string, patch: Partial<Pick<EventRecord, 'weight' | 'lastRecalledAt' | 'recallCount' | 'archived' | 'links' | 'salience' | 'mergedCount'>>): void;
    /** 归档事件落盘到 archive/：完整记录留档，索引里只保留 archived 标记与薄字段 */
    archiveEvent(event: EventRecord): void;
    /**
     * 修剪存量出边：按 strength 保留前 cap 条。
     * 新事件已由 linkNewEvent 限流，但历史库里的热点事件仍可能挂着上百条边。
     */
    trimLinks(cap?: number): number;
    /**
     * 归档之后从其它事件里摘掉指向它的链接。
     * 只打 archived 标记而不清 links，会让出度统计与联想 BFS 一直空转（真实库曾有单事件 607 条出边）。
     */
    detachLinks(ids: Iterable<string>): number;
    appendEmotionHistory(eventId: string, entry: EventRecord['emotionNowHistory'][number]): void;
    readFullText(eventId: string): string;
    loadPersona(): PersonaBundle;
    savePersonaLayer(layer: 'l1' | 'l2' | 'l3' | 'l4', value: unknown): void;
    loadL5(sessionId: string): L5State | null;
    saveL5(state: L5State): void;
    listL5Sessions(): string[];
    /** 外部生理信号（桌宠体力/心情）；没有文件视为没有桌宠，返回 null */
    loadBodySignal(): BodySignal | null;
    saveBodySignal(signal: BodySignal): void;
    loadOverdraft(): number;
    saveOverdraft(value: number): void;
    loadSafetyState(): SafetyState;
    saveSafetyState(state: SafetyState): void;
    loadSkills(): SkillCard[];
    saveSkill(skill: SkillCard): void;
    loadSkill(id: string): SkillCard | null;
    /**
     * 读-改-写技能（持锁）：两个进程同时累计成熟度时，后写者基于磁盘最新值重算，
     * 不会把对方的 successCount/maturity 覆盖掉。
     */
    mutateSkill(id: string, mutate: (current: SkillCard) => SkillCard): SkillCard | null;
    private skillPath;
    loadAsset(id: string): AssetPackage | null;
    /** 角色级资产列表，供面板与测试按类型核对 */
    loadAssets(): AssetPackage[];
    saveAsset(asset: AssetPackage): void;
    private assetDirs;
    /** 只读星图产物 */
    writeStarMap(characterId: string, payload: unknown): void;
    loadReflexRules(): ReflexRule[];
    loadReflexState(): Record<string, string>;
    saveReflexState(state: Record<string, string>): void;
    getMeta(key: string): string | null;
    /** 累计计数器（认知滤网统计等）：返回累加后的值 */
    bumpCounter(key: string, delta?: number): number;
    /** 按前缀读取计数器，例如 readCounters('filter.') → { keep: 12, drop: 3 } */
    readCounters(prefix: string): Record<string, number>;
    setMeta(key: string, value: string): void;
    getMetaNumber(key: string, fallback: number): number;
    appendEvolution(entry: EvolutionLogEntry): void;
    listEvolution(limit?: number): EvolutionLogEntry[];
    /** 按保留天数裁剪演化日志（log_retention_days），返回删除条数 */
    pruneEvolutionLogs(retentionDays: number, now: string): number;
    newEvolutionId(now: string): string;
    /**
     * FTS5 字面检索（D-02）：返回 eventId → 归一化分数（0..1，排名靠前越接近 1）。
     * trigram 分词器要求查询至少 3 个字符，更短的查询返回空，由 Dice 字面匹配兜底。
     */
    searchFts(query: string, limit?: number): Map<string, number>;
    private migrate;
    /** 老库补列：认知滤网引入的 salience / merged_count，缺列时原地 ALTER */
    private migrateFilterColumns;
    /**
     * FTS5 全文索引（D-02）：外部内容表 + 触发器保持与 events 同步。
     * 用 trigram 分词器以支持中文子串检索；若运行环境未编译 FTS5，降级为仅 Dice 字面匹配。
     */
    private migrateFts;
    private seedDefaults;
    private ensureLayout;
    private writeIfMissing;
    private readYaml;
    private readYamlDir;
    private listFiles;
    private mapRow;
    private loadEmotionHistory;
    /**
     * 回忆重构合并：超过上限时不丢弃中间记录，而是把情绪最接近的相邻两条合并成一条平均记录。
     * 首条（最早的回看）与末条（最近的回看）原样保留，只在中间段合并。
     */
    private compactEmotionHistory;
}
