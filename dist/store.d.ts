import type { InitialPersonalityInput } from './runtime/personality.js';
import type { Logger } from './util.js';
import type { AssetPackage, BodySignal, EvolutionLogEntry, EventRecord, L1Baseline, L2Relationship, L3Cognition, L4Contextual, L5State, PersonaBundle, ReflexRule, SafetyState, SkillCard } from './types.js';
import type { ThreadHead } from './runtime/threading.js';
/** 出厂人格基线：星图面板用它算“相对出厂值的偏移”，只读，不参与写回 */
export declare const DEFAULT_L1: L1Baseline;
export declare const DEFAULT_L2: L2Relationship;
export declare const DEFAULT_L3: L3Cognition;
export declare const DEFAULT_L4: L4Contextual;
export declare const DEFAULT_REFLEX_RULES: ReflexRule[];
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
    private readonly seed;
    /** 演化日志当天已用到的最大序号；跨天或首次调用时从文件重建 */
    private evolutionSeq;
    private evolutionSeqDate;
    private readonly initialPersonality?;
    private ftsAvailable;
    /** 最近一次 FTS 检索的失败原因；null 表示正常，供 index 计入降级指标 */
    lastFtsError: string | null;
    /** 打开时是否重建过索引：'created' 新建、'repaired' 行数不一致后修复、null 未重建（供体检/观测） */
    ftsRebuilt: 'created' | 'repaired' | null;
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
    /**
     * "刚在别处说的话"：时间窗口内、且不来自当前窗口的非归档事件。
     * 旧存档没有 session_id（NULL），无法判定来自哪，按"可能是别的窗口"处理——
     * 反正在时间窗内、又在当前检索里没出现，补进来正是用户要的"跨窗口记忆"。
     */
    listRecentElsewhere(since: string, limit: number, sessionId: string): EventRecord[];
    /** 同一局的全部事件（按时间正序）：用来拼这一局的前情摘要或回放 */
    listThreadEvents(threadId: string): EventRecord[];
    /** 进行中的局：只存头部索引（最近几轮），是"当前正在做什么"的共享寄存器 */
    saveOpenThreads(threads: ThreadHead[]): void;
    loadOpenThreads(): ThreadHead[];
    /**
     * 窗口的名字：会话 id → 「窗1」「窗2」…
     * 按第一次出现的顺序排号并落库，所以同一窗口重启后还叫同一个名，
     * 也不会像哈希那样给出"SX"这种看不出意思的编号。
     */
    saveWindowNames(names: Record<string, string>): void;
    loadWindowNames(): Record<string, string>;
    /** 时间窗口内的非归档事件：动机的情绪记忆只用近段事件，避免全表扫描 */
    listRecentEvents(since: string, limit?: number): EventRecord[];
    updateEventMutable(id: string, patch: Partial<Pick<EventRecord, 'weight' | 'lastRecalledAt' | 'recallCount' | 'archived' | 'links' | 'salience' | 'mergedCount'>>): void;
    /**
     * 回填专用：只改 thread_id。
     * 不走 updateEventMutable，免得顺手改写权重/召回计数——回填不是一次召回。
     */
    setEventThreadId(id: string, threadId: string): void;
    /**
     * 衰减/归档专用的轻量写：只动 weight 与 archived，不读整行、不读回看记录。
     * 维护轮次要对全库每个事件跑一遍，走 updateEventMutable 每次都会多查一次
     * emotion_history，事件上万条时这一项就是纯浪费。
     */
    updateEventDecay(id: string, weight: number, archived: boolean): void;
    /** 长边批量降权专用：只改 links，不重读整行与回看记录 */
    updateEventLinks(id: string, links: EventRecord['links']): void;
    /** 归档事件落盘到 archive/：完整记录留档，索引里只保留 archived 标记与薄字段 */
    archiveEvent(event: EventRecord): void;
    /** 该角色的事件计数，供重置计划展示（只走索引，不读正文） */
    countEvents(): {
        total: number;
        active: number;
        archived: number;
    };
    /** 回看记录（emotion_now_history）条数 */
    countEmotionHistory(): number;
    /**
     * 清空该角色的记忆：事件、回看记录，以及它们的全文/归档文件。
     * FTS 由 DELETE 触发器自动同步。人格、条件反射、技能卡、L5 状态不动——它们属于另外的重置域。
     *
     * 文件层必须一起删：只清表会留下永远读不到的 .txt/.json，
     * 下次有人按文件统计就会看到"事件 0 条、文件 120 份"这种对不上的状态。
     */
    clearMemory(): {
        events: number;
        emotions: number;
    };
    /** 删除 meta：`foo*` 结尾不带百分号时按前缀匹配，其余按精确键 */
    deleteMeta(patterns: string[]): number;
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
    /**
     * 记下"这段会话结束时的此刻"，供下一次同范围的新会话接力。
     * 存在 meta 表而不是 l5_state/ 目录：那里每多一个文件都会被 listL5Sessions 当成一个会话，
     * 星图面板会凭空多出一个"会话"。按范围分键，character 一份、每个 workspace 各一份。
     */
    saveL5Carry(scope: string, state: L5State): void;
    /** 最近一次落盘的会话快照：给"升级前没有接力快照"的旧存档兜底，让升级当次就能接力 */
    latestL5(): L5State | null;
    loadL5Carry(scope: string): L5State | null;
    /** 只保留最近若干范围的快照：长期跑下去 workspace 会换很多个，旧的留着只是噪声 */
    private pruneL5Carry;
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
    /**
     * 演化日志 ID：`EVO-<日期>-<当天序号>`。
     *
     * 早期用 `createRng(seed)` 抽 4 位 hex，可 Store 一重建随机流就从头重放，
     * 同一天最早的几条必然撞号（真实库 8 条日志只有 5 个唯一 ID），
     * G5 要求的"可追溯"直接失效。改成读日志里的最大序号往上递增：
     * 不依赖随机、进程重启和多实例写同一份日志都不会撞。
     */
    newEvolutionId(now: string): string;
    /** 当天日志里已用的最大序号；旧记录是随机后缀，按 hex 解析后接着往上走，避免与存量撞。 */
    private maxEvolutionSeq;
    /**
     * FTS5 字面检索（D-02）：返回 eventId → 归一化分数（0..1，排名靠前越接近 1）。
     * trigram 分词器要求查询至少 3 个字符，更短的查询返回空，由 Dice 字面匹配兜底。
     */
    searchFts(query: string, limit?: number): Map<string, number>;
    private migrate;
    /**
     * 单向来源的事件不该挂 'user'：早期一律写 ['self','user']，
     * 社交性项恒为 1 让显著性虚高，人物画像把"刷到的视频"算成"和用户一起做的事"，
     * L2 亲密度的锚点跟着失真。把已经写错的这批改回 ['self']（幂等）。
     */
    private migrateParticipants;
    /** 老库补列：认知滤网（salience/merged_count）与"窗口只是工位"（session/workspace），缺列时原地 ALTER */
    private migrateFilterColumns;
    /**
     * FTS5 全文索引（D-02）：外部内容表 + 触发器保持与 events 同步。
     * 用 trigram 分词器以支持中文子串检索；若运行环境未编译 FTS5，降级为仅 Dice 字面匹配。
     *
     * 两条运维修正：
     * - UPDATE 触发器收窄到 `UPDATE OF title, summary, tags`。之前是整表 UPDATE，
     *   而衰减/召回/归档每轮都会 UPDATE 权重，等于每次 tick 把所有事件的全文重写一遍。
     * - `rebuild` 只在"新建索引"或"行数对不上"时执行。之前每次开进程都重建，
     *   库越大启动越慢，而且对只读场景是白做功。
     */
    private migrateFts;
    /**
     * 功能性探针：取几条标题够长的真实事件，按子串查一次索引。
     * 命中说明索引和内容表对得上；查不到说明索引缺内容（需要 rebuild）。
     * 空库直接按健康处理，避免每次启动都重建。
     */
    private ftsIndexUsable;
    private seedDefaults;
    private ensureLayout;
    private writeIfMissing;
    private readYaml;
    private readYamlDir;
    private listFiles;
    private mapRow;
    /**
     * 回忆重构去重（DEF-07）：同一事件同一小时内只保留「位移最大」的一条。
     * 位移 = 与该事件前一条回看记录的 PAD 距离；组内第一条与上一条（可能跨小时）比。
     * apply=false 只统计不删除，供 filter:sweep 的 dry-run 使用。
     */
    dedupeEmotionHistory(apply?: boolean): number;
    private loadEmotionHistory;
    /**
     * 回忆重构合并：超过上限时不丢弃中间记录，而是把情绪最接近的相邻两条合并成一条平均记录。
     * 首条（最早的回看）与末条（最近的回看）原样保留，只在中间段合并。
     */
    private compactEmotionHistory;
}
