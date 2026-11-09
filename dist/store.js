import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import YAML from 'yaml';
import { atomicWriteFile, padDistance, safeFileName, silentLogger, withFileLock } from './util.js';
import { normalizeReflexRule } from './runtime/content.js';
import { createInitialL1, createInitialL2, defaultNarrative, deriveAttachment } from './runtime/personality.js';
/** emotion_now_history 上限；超出后按相邻合并，而不是截断丢弃 */
const EMOTION_HISTORY_CAP = 8;
const MERGED_RECALL_REASON = '回忆重构：多次回看感受接近，已合并';
/** 跨会话状态接力的 meta 键前缀，以及最多保留多少个隔离范围（character + 各 workspace） */
const L5_CARRY_PREFIX = 'l5.carry.';
const L5_CARRY_MAX_SCOPES = 12;
/** 出厂人格基线：星图面板用它算“相对出厂值的偏移”，只读，不参与写回 */
export const DEFAULT_L1 = {
    bigFive: {
        openness: 0.6,
        conscientiousness: 0.55,
        extraversion: 0.35,
        agreeableness: 0.65,
        neuroticism: 0.4,
    },
    innate: {
        openness: 0.6,
        conscientiousness: 0.55,
        extraversion: 0.35,
        agreeableness: 0.65,
        neuroticism: 0.4,
    },
    temperament: 'slow_warmup',
    moodBaseline: { pleasure: 0.1, arousal: -0.1, dominance: 0 },
    noveltySeeking: 0.45,
    plasticityBase: 0.35,
    plasticity: 0.65,
    updatedAt: '1970-01-01T00:00:00.000Z',
};
export const DEFAULT_L2 = {
    attachmentAnxiety: 0.35,
    attachmentAvoidance: 0.4,
    coreNeeds: ['被需要', '稳定回应'],
    trustBaseline: 0.3,
    relationshipStage: 'acquaintance',
    relationshipDepth: 0.2,
    attachmentType: 'secure',
    updatedAt: '1970-01-01T00:00:00.000Z',
};
export const DEFAULT_L3 = {
    biasWeights: {},
    defenseMaturity: 0.5,
    moral: {
        altruism: 0.6,
        principle: 0.55,
        stance: '先善意假设，再守住底线；不替对方做重大决定',
        redLines: ['不伤害自己与他人', '不替对方做人生重大决定', '不越界评价对方的家人'],
    },
    copingStrategies: [
        { id: 'CS-001', trigger: '被忽视', response: '先沉默，再试探性回应', weight: 0.4 },
        { id: 'CS-002', trigger: '压力很大', response: '降低表达幅度，先处理最急的事', weight: 0.6 },
    ],
    narrative: defaultNarrative(),
    evidence: [],
    updatedAt: '1970-01-01T00:00:00.000Z',
};
export const DEFAULT_L4 = {
    subPersonas: [
        { id: 'to_father', weight: 0.5, tone: '更放松，愿意多说一点', disclosureLevel: 0.7, boundaries: [] },
        { id: 'to_stranger', weight: 0.3, tone: '克制、客气，先观察', disclosureLevel: 0.2, boundaries: ['私人往事'] },
        { id: 'alone', weight: 0.2, tone: '安静，自言自语式', disclosureLevel: 0.5, boundaries: [] },
    ],
    updatedAt: '1970-01-01T00:00:00.000Z',
};
const DEFAULT_SAFETY = {
    level: 0,
    reasons: [],
    overstressDurationMs: 0,
    functionalImpairment: 0,
    triggers: [],
    since: '1970-01-01T00:00:00.000Z',
};
export const DEFAULT_REFLEX_RULES = [
    {
        id: 'RFX-001',
        enabled: true,
        priority: 100,
        cooldownMs: 60_000,
        match: { type: 'keyword', patterns: ['你好', '在吗'] },
        action: { kind: 'template_reply', text: '嗯，我在。' },
    },
    {
        id: 'RFX-002',
        enabled: true,
        priority: 80,
        cooldownMs: 300_000,
        match: { type: 'state', predicate: { stress: 0.85 } },
        action: { kind: 'template_reply', text: '先歇一会儿吧，不急。' },
    },
];
export class Store {
    characterId;
    dataRoot;
    db;
    logger;
    seed;
    /** 演化日志当天已用到的最大序号；跨天或首次调用时从文件重建 */
    evolutionSeq = 0;
    evolutionSeqDate = null;
    initialPersonality;
    ftsAvailable = false;
    /** 最近一次 FTS 检索的失败原因；null 表示正常，供 index 计入降级指标 */
    lastFtsError = null;
    /** 打开时是否重建过索引：'created' 新建、'repaired' 行数不一致后修复、null 未重建（供体检/观测） */
    ftsRebuilt = null;
    lockEnabled;
    constructor(dataRoot, characterId, seed = 42, logger = silentLogger, options = {}) {
        this.dataRoot = resolve(dataRoot);
        this.characterId = characterId;
        this.logger = logger;
        this.seed = seed;
        this.initialPersonality = options.personality;
        this.lockEnabled = options.lock !== false;
        this.ensureLayout();
        this.db = new DatabaseSync(this.paths.db);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.migrate();
        this.seedDefaults();
    }
    get paths() {
        const ch = this.characterId;
        const root = this.dataRoot;
        return {
            root,
            brain: join(root, 'brain'),
            db: join(root, 'brain', 'hippocampus', 'index', 'memory.db'),
            fulltext: join(root, 'brain', 'hippocampus', 'fulltext', ch),
            neocortex: join(root, 'brain', 'neocortex', ch),
            prefrontal: join(root, 'brain', 'prefrontal', ch),
            l5: join(root, 'brain', 'prefrontal', ch, 'l5_state'),
            safety: join(root, 'brain', 'prefrontal', ch, 'safety_state.yaml'),
            overdraft: join(root, 'brain', 'prefrontal', ch, 'emotional_overdraft.json'),
            body: join(root, 'brain', 'prefrontal', ch, 'body_signal.json'),
            skills: join(root, 'brain', 'basal_ganglia', 'skills', ch),
            assets: join(root, 'brain', 'basal_ganglia'),
            reflexes: join(root, 'brain', 'basal_ganglia', 'reflexes', ch),
            motions: join(root, 'brain', 'cerebellum', 'motions'),
            evolution: join(root, 'logs', 'evolution'),
            archive: join(root, 'archive'),
            starMap: join(root, 'star_map'),
        };
    }
    /** FTS5 索引是否可用（不可用时检索退回 Dice 字面匹配） */
    get ftsReady() {
        return this.ftsAvailable;
    }
    close() {
        this.db.close();
    }
    /** 带角色级锁的原子写（§5.3）：所有 YAML/JSON 落盘统一走这里 */
    writeLocked(path, content) {
        withFileLock(path, () => atomicWriteFile(path, content), {
            enabled: this.lockEnabled,
            onTimeout: () => this.logger.warn('dsh-daughter: 写锁等待超时，降级为无锁写', { path }),
        });
    }
    /* ------------------------------ 事件 ------------------------------ */
    /** fullText 缺省时退化为摘要，避免全文层与摘要层完全重复 */
    addEvent(event, fullText) {
        this.db
            .prepare(`INSERT INTO events (id, character_id, title, summary, tags, participants,
          emo_pleasure, emo_arousal, emo_dominance, emo_intensity,
          importance, weight, links, source, created_at, last_recalled_at, recall_count, archived, schema_version,
          salience, merged_count, session_id, workspace_id, thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(event.id, event.characterId, event.title, event.summary, JSON.stringify(event.tags), JSON.stringify(event.participants), event.emotionAtTime.pleasure, event.emotionAtTime.arousal, event.emotionAtTime.dominance, event.emotionAtTime.intensity, event.importance, event.weight, JSON.stringify(event.links), event.source, event.createdAt, event.lastRecalledAt ?? null, event.recallCount, event.archived ? 1 : 0, event.schemaVersion, event.salience ?? null, event.mergedCount ?? 0, event.sessionId ?? null, event.workspaceId ?? null, event.threadId ?? null);
        if (event.emotionNowHistory.length > 0) {
            const stmt = this.db.prepare('INSERT INTO emotion_history (event_id, at, pleasure, arousal, dominance, reason) VALUES (?, ?, ?, ?, ?, ?)');
            for (const entry of event.emotionNowHistory) {
                stmt.run(event.id, entry.at, entry.emotion.pleasure, entry.emotion.arousal, entry.emotion.dominance, entry.reason);
            }
        }
        const text = (fullText ?? event.summary).trim();
        this.writeLocked(join(this.paths.fulltext, `${safeFileName(event.id)}.txt`), text.length > 0 ? text : event.summary);
    }
    getEvent(id) {
        const row = this.db
            .prepare('SELECT * FROM events WHERE id = ? AND character_id = ?')
            .get(id, this.characterId);
        if (!row)
            return null;
        const event = this.mapRow(row);
        event.emotionNowHistory = this.loadEmotionHistory(id);
        return event;
    }
    /** 检索候选集：按权重与时间排序的非归档事件 */
    listCandidates(includeArchived, limit) {
        const sql = includeArchived
            ? 'SELECT * FROM events WHERE character_id = ? ORDER BY weight DESC, created_at DESC LIMIT ?'
            : 'SELECT * FROM events WHERE character_id = ? AND archived = 0 ORDER BY weight DESC, created_at DESC LIMIT ?';
        const rows = this.db.prepare(sql).all(this.characterId, limit);
        return rows.map((row) => this.mapRow(row));
    }
    listAllEvents() {
        const rows = this.db
            .prepare('SELECT * FROM events WHERE character_id = ? ORDER BY created_at ASC')
            .all(this.characterId);
        return rows.map((row) => this.mapRow(row));
    }
    /**
     * "刚在别处说的话"：时间窗口内、且不来自当前窗口的非归档事件。
     * 旧存档没有 session_id（NULL），无法判定来自哪，按"可能是别的窗口"处理——
     * 反正在时间窗内、又在当前检索里没出现，补进来正是用户要的"跨窗口记忆"。
     */
    listRecentElsewhere(since, limit, sessionId) {
        const rows = this.db
            .prepare(`SELECT * FROM events
         WHERE character_id = ? AND archived = 0 AND created_at >= ?
           AND (session_id IS NULL OR session_id <> ?)
         ORDER BY created_at DESC LIMIT ?`)
            .all(this.characterId, since, sessionId, limit);
        return rows.map((row) => this.mapRow(row));
    }
    /** 同一局的全部事件（按时间正序）：用来拼这一局的前情摘要或回放 */
    listThreadEvents(threadId) {
        const rows = this.db
            .prepare('SELECT * FROM events WHERE character_id = ? AND thread_id = ? ORDER BY created_at ASC')
            .all(this.characterId, threadId);
        return rows.map((row) => this.mapRow(row));
    }
    /** 进行中的局：只存头部索引（最近几轮），是"当前正在做什么"的共享寄存器 */
    saveOpenThreads(threads) {
        this.setMeta('threads.open', JSON.stringify(threads));
    }
    loadOpenThreads() {
        const raw = this.getMeta('threads.open');
        if (!raw)
            return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    }
    /**
     * 窗口的名字：会话 id → 「窗1」「窗2」…
     * 按第一次出现的顺序排号并落库，所以同一窗口重启后还叫同一个名，
     * 也不会像哈希那样给出"SX"这种看不出意思的编号。
     */
    saveWindowNames(names) {
        this.setMeta('window.names', JSON.stringify(names));
    }
    loadWindowNames() {
        const raw = this.getMeta('window.names');
        if (!raw)
            return {};
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return {};
            return parsed;
        }
        catch {
            return {};
        }
    }
    /** 时间窗口内的非归档事件：动机的情绪记忆只用近段事件，避免全表扫描 */
    listRecentEvents(since, limit = 200) {
        const rows = this.db
            .prepare('SELECT * FROM events WHERE character_id = ? AND archived = 0 AND created_at >= ? ORDER BY created_at DESC LIMIT ?')
            .all(this.characterId, since, limit);
        return rows.map((row) => this.mapRow(row));
    }
    updateEventMutable(id, patch) {
        const current = this.getEvent(id);
        if (!current)
            return;
        const next = {
            weight: patch.weight ?? current.weight,
            lastRecalledAt: patch.lastRecalledAt ?? current.lastRecalledAt ?? null,
            recallCount: patch.recallCount ?? current.recallCount,
            archived: patch.archived ?? current.archived,
            links: patch.links ?? current.links,
            salience: patch.salience ?? current.salience ?? null,
            mergedCount: patch.mergedCount ?? current.mergedCount ?? 0,
        };
        this.db
            .prepare('UPDATE events SET weight = ?, last_recalled_at = ?, recall_count = ?, archived = ?, links = ?, salience = ?, merged_count = ? WHERE id = ? AND character_id = ?')
            .run(next.weight, next.lastRecalledAt, next.recallCount, next.archived ? 1 : 0, JSON.stringify(next.links), next.salience, next.mergedCount, id, this.characterId);
    }
    /**
     * 回填专用：只改 thread_id。
     * 不走 updateEventMutable，免得顺手改写权重/召回计数——回填不是一次召回。
     */
    setEventThreadId(id, threadId) {
        this.db
            .prepare('UPDATE events SET thread_id = ? WHERE id = ? AND character_id = ?')
            .run(threadId, id, this.characterId);
    }
    /**
     * 衰减/归档专用的轻量写：只动 weight 与 archived，不读整行、不读回看记录。
     * 维护轮次要对全库每个事件跑一遍，走 updateEventMutable 每次都会多查一次
     * emotion_history，事件上万条时这一项就是纯浪费。
     */
    updateEventDecay(id, weight, archived) {
        this.db
            .prepare('UPDATE events SET weight = ?, archived = ? WHERE id = ? AND character_id = ?')
            .run(weight, archived ? 1 : 0, id, this.characterId);
    }
    /** 归档事件落盘到 archive/：完整记录留档，索引里只保留 archived 标记与薄字段 */
    archiveEvent(event) {
        this.writeLocked(join(this.paths.archive, `${safeFileName(event.id)}.json`), JSON.stringify(event, null, 2));
    }
    /* ------------------------------ 重置支持 ------------------------------ */
    /** 该角色的事件计数，供重置计划展示（只走索引，不读正文） */
    countEvents() {
        const row = this.db
            .prepare(`SELECT COUNT(*) AS total, SUM(archived = 0) AS active, SUM(archived = 1) AS archived
         FROM events WHERE character_id = ?`)
            .get(this.characterId);
        return {
            total: Number(row?.total ?? 0),
            active: Number(row?.active ?? 0),
            archived: Number(row?.archived ?? 0),
        };
    }
    /** 回看记录（emotion_now_history）条数 */
    countEmotionHistory() {
        const row = this.db
            .prepare(`SELECT COUNT(*) AS total FROM emotion_history
         WHERE event_id IN (SELECT id FROM events WHERE character_id = ?)`)
            .get(this.characterId);
        return Number(row?.total ?? 0);
    }
    /**
     * 清空该角色的记忆：事件、回看记录，以及它们的全文/归档文件。
     * FTS 由 DELETE 触发器自动同步。人格、条件反射、技能卡、L5 状态不动——它们属于另外的重置域。
     *
     * 文件层必须一起删：只清表会留下永远读不到的 .txt/.json，
     * 下次有人按文件统计就会看到"事件 0 条、文件 120 份"这种对不上的状态。
     */
    clearMemory() {
        const ids = this.db.prepare('SELECT id FROM events WHERE character_id = ?').all(this.characterId).map((row) => row.id);
        let emotions = 0;
        let events = 0;
        this.db.exec('BEGIN');
        try {
            emotions = Number(this.db
                .prepare(`DELETE FROM emotion_history
             WHERE event_id IN (SELECT id FROM events WHERE character_id = ?)`)
                .run(this.characterId).changes ?? 0);
            events = Number(this.db.prepare('DELETE FROM events WHERE character_id = ?').run(this.characterId).changes ?? 0);
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        // 归档目录是跨角色共享的，只按本次删掉的 id 摘文件
        for (const id of ids) {
            for (const file of [
                join(this.paths.fulltext, `${safeFileName(id)}.txt`),
                join(this.paths.archive, `${safeFileName(id)}.json`),
            ]) {
                try {
                    if (existsSync(file))
                        unlinkSync(file);
                }
                catch (error) {
                    this.logger.warn('dsh-daughter: 清除记忆文件失败', { file, error: String(error) });
                }
            }
        }
        return { events, emotions };
    }
    /** 删除 meta：`foo*` 结尾不带百分号时按前缀匹配，其余按精确键 */
    deleteMeta(patterns) {
        let removed = 0;
        for (const pattern of patterns) {
            const byPrefix = pattern.endsWith('*');
            const stmt = this.db.prepare(byPrefix ? 'DELETE FROM meta WHERE key LIKE ?' : 'DELETE FROM meta WHERE key = ?');
            removed += Number(stmt.run(byPrefix ? `${pattern.slice(0, -1)}%` : pattern).changes ?? 0);
        }
        return removed;
    }
    /**
     * 修剪存量出边：按 strength 保留前 cap 条。
     * 新事件已由 linkNewEvent 限流，但历史库里的热点事件仍可能挂着上百条边。
     */
    trimLinks(cap = 12) {
        let changed = 0;
        for (const event of this.listAllEvents()) {
            if (event.archived || event.links.length <= cap)
                continue;
            const kept = [...event.links].sort((a, b) => b.strength - a.strength).slice(0, cap);
            this.updateEventMutable(event.id, { links: kept });
            changed += 1;
        }
        return changed;
    }
    /**
     * 归档之后从其它事件里摘掉指向它的链接。
     * 只打 archived 标记而不清 links，会让出度统计与联想 BFS 一直空转（真实库曾有单事件 607 条出边）。
     */
    detachLinks(ids) {
        const target = new Set(ids);
        if (target.size === 0)
            return 0;
        let changed = 0;
        for (const event of this.listAllEvents()) {
            const kept = event.links.filter((link) => !target.has(link.targetId));
            if (kept.length === event.links.length)
                continue;
            this.updateEventMutable(event.id, { links: kept });
            changed += 1;
        }
        return changed;
    }
    appendEmotionHistory(eventId, entry) {
        this.db
            .prepare('INSERT INTO emotion_history (event_id, at, pleasure, arousal, dominance, reason) VALUES (?, ?, ?, ?, ?, ?)')
            .run(eventId, entry.at, entry.emotion.pleasure, entry.emotion.arousal, entry.emotion.dominance, entry.reason);
        this.compactEmotionHistory(eventId);
    }
    readFullText(eventId) {
        const path = join(this.paths.fulltext, `${safeFileName(eventId)}.txt`);
        if (!existsSync(path))
            return '';
        return readFileSync(path, 'utf8');
    }
    /* ------------------------------ 人格 ------------------------------ */
    loadPersona() {
        const l3 = this.readYaml(join(this.paths.neocortex, 'l3_cognition.yaml'), DEFAULT_L3);
        // 旧存档没有人格新增字段时补默认，避免善恶观整块丢失
        l3.moral = { ...DEFAULT_L3.moral, ...(l3.moral ?? {}), redLines: l3.moral?.redLines ?? DEFAULT_L3.moral.redLines };
        // 自我叙事与证据链是后加的：老存档按中性值补齐，不追认历史
        l3.narrative = { ...defaultNarrative(), ...(l3.narrative ?? {}), lockedAxes: l3.narrative?.lockedAxes ?? [] };
        l3.evidence = l3.evidence ?? [];
        const l1 = this.readYaml(join(this.paths.neocortex, 'l1_baseline.yaml'), DEFAULT_L1);
        // 先天锚点缺失时用当前值兜底：旧存档等于"从现在开始不再有可漂移的起源"
        l1.innate = l1.innate ?? { ...l1.bigFive };
        l1.plasticity = l1.plasticity ?? Math.max(0, 1 - l1.plasticityBase);
        const l2 = this.readYaml(join(this.paths.neocortex, 'l2_relationship.yaml'), DEFAULT_L2);
        l2.attachmentType = l2.attachmentType ?? deriveAttachment(l2, false);
        return {
            l1,
            l2,
            l3,
            l4: this.readYaml(join(this.paths.neocortex, 'l4_subpersonas.yaml'), DEFAULT_L4),
        };
    }
    savePersonaLayer(layer, value) {
        const names = {
            l1: 'l1_baseline.yaml',
            l2: 'l2_relationship.yaml',
            l3: 'l3_cognition.yaml',
            l4: 'l4_subpersonas.yaml',
        };
        this.writeLocked(join(this.paths.neocortex, names[layer]), YAML.stringify(value));
    }
    /* ------------------------------ L5 / 透支 / 安全 ------------------------------ */
    loadL5(sessionId) {
        const path = join(this.paths.l5, `${safeFileName(sessionId)}.json`);
        if (!existsSync(path))
            return null;
        try {
            return JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            return null;
        }
    }
    saveL5(state) {
        this.writeLocked(join(this.paths.l5, `${safeFileName(state.sessionId)}.json`), JSON.stringify(state, null, 2));
    }
    listL5Sessions() {
        if (!existsSync(this.paths.l5))
            return [];
        return this.listFiles(this.paths.l5)
            .filter((name) => name.endsWith('.json'))
            .map((name) => name.slice(0, -'.json'.length));
    }
    /* --------------------------- 跨会话状态接力（L5） --------------------------- */
    /**
     * 记下"这段会话结束时的此刻"，供下一次同范围的新会话接力。
     * 存在 meta 表而不是 l5_state/ 目录：那里每多一个文件都会被 listL5Sessions 当成一个会话，
     * 星图面板会凭空多出一个"会话"。按范围分键，character 一份、每个 workspace 各一份。
     */
    saveL5Carry(scope, state) {
        this.setMeta(`${L5_CARRY_PREFIX}${scope}`, JSON.stringify({ at: state.lastTickAt, state }));
        this.pruneL5Carry();
    }
    /** 最近一次落盘的会话快照：给"升级前没有接力快照"的旧存档兜底，让升级当次就能接力 */
    latestL5() {
        let latest = null;
        for (const sessionId of this.listL5Sessions()) {
            const state = this.loadL5(sessionId);
            if (!state)
                continue;
            if (!latest || String(state.lastTickAt) > String(latest.lastTickAt))
                latest = state;
        }
        return latest;
    }
    loadL5Carry(scope) {
        const raw = this.getMeta(`${L5_CARRY_PREFIX}${scope}`);
        if (!raw)
            return null;
        try {
            const parsed = JSON.parse(raw);
            const state = parsed.state;
            if (!state || typeof state.lastTickAt !== 'string')
                return null;
            return state;
        }
        catch {
            return null;
        }
    }
    /** 只保留最近若干范围的快照：长期跑下去 workspace 会换很多个，旧的留着只是噪声 */
    pruneL5Carry(keep = L5_CARRY_MAX_SCOPES) {
        try {
            const rows = this.db
                .prepare('SELECT key, value FROM meta WHERE key LIKE ?')
                .all(`${L5_CARRY_PREFIX}%`);
            if (rows.length <= keep)
                return;
            const ranked = rows
                .map((row) => {
                let at = '';
                try {
                    at = String(JSON.parse(row.value).at ?? '');
                }
                catch {
                    at = '';
                }
                return { key: row.key, at };
            })
                .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
            const remove = this.db.prepare('DELETE FROM meta WHERE key = ?');
            for (const stale of ranked.slice(keep))
                remove.run(stale.key);
        }
        catch (error) {
            this.logger.warn('dsh-daughter: 清理 L5 接力快照失败', { error: String(error) });
        }
    }
    /** 外部生理信号（桌宠体力/心情）；没有文件视为没有桌宠，返回 null */
    loadBodySignal() {
        if (!existsSync(this.paths.body))
            return null;
        try {
            const parsed = JSON.parse(readFileSync(this.paths.body, 'utf8'));
            if (typeof parsed.strength !== 'number' || typeof parsed.feeling !== 'number')
                return null;
            return {
                strength: parsed.strength,
                feeling: parsed.feeling,
                source: parsed.source === 'pet-shell' ? 'pet-shell' : 'vpet',
                at: typeof parsed.at === 'string' ? parsed.at : new Date().toISOString(),
            };
        }
        catch {
            return null;
        }
    }
    saveBodySignal(signal) {
        this.writeLocked(this.paths.body, JSON.stringify(signal, null, 2));
    }
    loadOverdraft() {
        if (!existsSync(this.paths.overdraft))
            return 0;
        try {
            const parsed = JSON.parse(readFileSync(this.paths.overdraft, 'utf8'));
            return typeof parsed.value === 'number' ? parsed.value : 0;
        }
        catch {
            return 0;
        }
    }
    saveOverdraft(value) {
        this.writeLocked(this.paths.overdraft, JSON.stringify({ value, updatedAt: new Date().toISOString() }));
    }
    loadSafetyState() {
        const path = this.paths.safety;
        if (!existsSync(path))
            return { ...DEFAULT_SAFETY };
        try {
            return { ...DEFAULT_SAFETY, ...YAML.parse(readFileSync(path, 'utf8')) };
        }
        catch {
            return { ...DEFAULT_SAFETY };
        }
    }
    saveSafetyState(state) {
        this.writeLocked(this.paths.safety, YAML.stringify(state));
    }
    /* ------------------------------ 技能 / 资产 / 反射 ------------------------------ */
    loadSkills() {
        return this.readYamlDir(this.paths.skills).filter((skill) => skill.characterId === this.characterId);
    }
    saveSkill(skill) {
        this.writeLocked(this.skillPath(skill.id), YAML.stringify(skill));
    }
    loadSkill(id) {
        const path = this.skillPath(id);
        if (!existsSync(path))
            return null;
        try {
            return YAML.parse(readFileSync(path, 'utf8'));
        }
        catch {
            return null;
        }
    }
    /**
     * 读-改-写技能（持锁）：两个进程同时累计成熟度时，后写者基于磁盘最新值重算，
     * 不会把对方的 successCount/maturity 覆盖掉。
     */
    mutateSkill(id, mutate) {
        const path = this.skillPath(id);
        return withFileLock(path, () => {
            const current = this.loadSkill(id);
            if (!current)
                return null;
            const next = mutate(current);
            atomicWriteFile(path, YAML.stringify(next));
            return next;
        }, {
            enabled: this.lockEnabled,
            onTimeout: () => this.logger.warn('dsh-daughter: 技能写锁超时，降级为直接写', { id }),
        });
    }
    skillPath(id) {
        return join(this.paths.skills, `${safeFileName(id)}.yaml`);
    }
    loadAsset(id) {
        for (const dir of this.assetDirs()) {
            const path = join(this.paths.assets, dir, this.characterId, `${safeFileName(id)}.yaml`);
            if (existsSync(path)) {
                try {
                    return YAML.parse(readFileSync(path, 'utf8'));
                }
                catch {
                    return null;
                }
            }
        }
        return null;
    }
    /** 角色级资产列表，供面板与测试按类型核对 */
    loadAssets() {
        const result = [];
        for (const dir of this.assetDirs()) {
            result.push(...this.readYamlDir(join(this.paths.assets, dir, this.characterId)));
        }
        return result;
    }
    saveAsset(asset) {
        const dirs = {
            MAC: 'macros',
            CON: 'connections',
            MOT: 'motions',
            CMB: 'combos',
        };
        const dir = join(this.paths.assets, dirs[asset.kind], this.characterId);
        this.writeLocked(join(dir, `${safeFileName(asset.id)}.yaml`), YAML.stringify(asset));
    }
    assetDirs() {
        return ['macros', 'connections', 'combos', 'motions'];
    }
    /** 只读星图产物 */
    writeStarMap(characterId, payload) {
        this.writeLocked(join(this.paths.starMap, `${safeFileName(characterId)}.json`), JSON.stringify(payload, null, 2));
    }
    loadReflexRules() {
        const path = join(this.paths.reflexes, 'rules.yaml');
        if (!existsSync(path))
            return DEFAULT_REFLEX_RULES;
        try {
            const parsed = YAML.parse(readFileSync(path, 'utf8'));
            if (!Array.isArray(parsed))
                return DEFAULT_REFLEX_RULES;
            const rules = parsed
                .map((rule) => normalizeReflexRule(rule))
                .filter((rule) => rule !== null);
            return rules.length > 0 ? rules : DEFAULT_REFLEX_RULES;
        }
        catch {
            return DEFAULT_REFLEX_RULES;
        }
    }
    loadReflexState() {
        const path = join(this.paths.reflexes, 'state.json');
        if (!existsSync(path))
            return {};
        try {
            return JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            return {};
        }
    }
    saveReflexState(state) {
        this.writeLocked(join(this.paths.reflexes, 'state.json'), JSON.stringify(state));
    }
    /* ------------------------------ 演化日志 ------------------------------ */
    getMeta(key) {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
        return row?.value ?? null;
    }
    /** 累计计数器（认知滤网统计等）：返回累加后的值 */
    bumpCounter(key, delta = 1) {
        const current = Number(this.getMeta(key) ?? 0) || 0;
        const next = current + delta;
        this.setMeta(key, String(next));
        return next;
    }
    /** 按前缀读取计数器，例如 readCounters('filter.') → { keep: 12, drop: 3 } */
    readCounters(prefix) {
        const rows = this.db
            .prepare('SELECT key, value FROM meta WHERE key LIKE ?')
            .all(`${prefix}%`);
        const out = {};
        for (const row of rows)
            out[row.key.slice(prefix.length)] = Number(row.value) || 0;
        return out;
    }
    setMeta(key, value) {
        this.db
            .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, value);
    }
    getMetaNumber(key, fallback) {
        const raw = this.getMeta(key);
        const parsed = raw === null ? Number.NaN : Number(raw);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    appendEvolution(entry) {
        const path = join(this.paths.evolution, `${safeFileName(this.characterId)}.jsonl`);
        withFileLock(path, () => {
            mkdirSync(dirname(path), { recursive: true });
            appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
        }, { enabled: this.lockEnabled });
    }
    listEvolution(limit = 20) {
        const path = join(this.paths.evolution, `${safeFileName(this.characterId)}.jsonl`);
        if (!existsSync(path))
            return [];
        const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
        return lines.slice(-limit).map((line) => JSON.parse(line));
    }
    /** 按保留天数裁剪演化日志（log_retention_days），返回删除条数 */
    pruneEvolutionLogs(retentionDays, now) {
        if (!Number.isFinite(retentionDays) || retentionDays <= 0)
            return 0;
        const path = join(this.paths.evolution, `${safeFileName(this.characterId)}.jsonl`);
        if (!existsSync(path))
            return 0;
        const cutoff = Date.parse(now) - retentionDays * 86_400_000;
        if (!Number.isFinite(cutoff))
            return 0;
        return withFileLock(path, () => {
            const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0);
            const kept = [];
            let removed = 0;
            for (const line of lines) {
                let at = Number.NaN;
                try {
                    at = Date.parse(JSON.parse(line).at);
                }
                catch {
                    at = Number.NaN;
                }
                // 时间戳缺失或无法解析的记录保留，避免误删
                if (Number.isFinite(at) && at < cutoff)
                    removed += 1;
                else
                    kept.push(line);
            }
            if (removed > 0)
                atomicWriteFile(path, kept.length > 0 ? `${kept.join('\n')}\n` : '');
            return removed;
        }, { enabled: this.lockEnabled });
    }
    /**
     * 演化日志 ID：`EVO-<日期>-<当天序号>`。
     *
     * 早期用 `createRng(seed)` 抽 4 位 hex，可 Store 一重建随机流就从头重放，
     * 同一天最早的几条必然撞号（真实库 8 条日志只有 5 个唯一 ID），
     * G5 要求的"可追溯"直接失效。改成读日志里的最大序号往上递增：
     * 不依赖随机、进程重启和多实例写同一份日志都不会撞。
     */
    newEvolutionId(now) {
        const date = now.slice(0, 10).replace(/-/g, '');
        if (this.evolutionSeqDate !== date) {
            this.evolutionSeq = this.maxEvolutionSeq(date);
            this.evolutionSeqDate = date;
        }
        this.evolutionSeq += 1;
        return `EVO-${date}-${this.evolutionSeq.toString(16).padStart(4, '0')}`;
    }
    /** 当天日志里已用的最大序号；旧记录是随机后缀，按 hex 解析后接着往上走，避免与存量撞。 */
    maxEvolutionSeq(date) {
        const path = join(this.paths.evolution, `${safeFileName(this.characterId)}.jsonl`);
        if (!existsSync(path))
            return 0;
        const prefix = `EVO-${date}-`;
        let max = 0;
        try {
            for (const line of readFileSync(path, 'utf8').split('\n')) {
                if (!line.includes(prefix))
                    continue;
                let id = '';
                try {
                    id = String(JSON.parse(line).id ?? '');
                }
                catch {
                    continue;
                }
                if (!id.startsWith(prefix))
                    continue;
                const value = Number.parseInt(id.slice(prefix.length), 16);
                if (Number.isFinite(value) && value > max)
                    max = value;
            }
        }
        catch {
            // 日志读不出来就从头编号：ID 重复比写入失败轻，但不能让演化记录写不进去
            return 0;
        }
        return max;
    }
    /**
     * FTS5 字面检索（D-02）：返回 eventId → 归一化分数（0..1，排名靠前越接近 1）。
     * trigram 分词器要求查询至少 3 个字符，更短的查询返回空，由 Dice 字面匹配兜底。
     */
    searchFts(query, limit = 20) {
        const scores = new Map();
        if (!this.ftsAvailable) {
            this.lastFtsError = 'fts unavailable';
            return scores;
        }
        const expression = ftsExpression(query);
        if (!expression)
            return scores;
        try {
            const rows = this.db
                .prepare(`SELECT e.id AS id FROM events_fts JOIN events e ON e.rowid = events_fts.rowid
           WHERE events_fts MATCH ? AND e.character_id = ?
           ORDER BY rank LIMIT ?`)
                .all(expression, this.characterId, limit);
            rows.forEach((row, index) => scores.set(row.id, 1 - index / Math.max(1, rows.length)));
            this.lastFtsError = null;
        }
        catch (error) {
            // 之前这里是静默 return：索引坏掉也只会退化成 Dice，指标上看不出降级
            this.lastFtsError = String(error);
            return scores;
        }
        return scores;
    }
    /* ------------------------------ 内部 ------------------------------ */
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags TEXT NOT NULL,
        participants TEXT NOT NULL,
        emo_pleasure REAL NOT NULL,
        emo_arousal REAL NOT NULL,
        emo_dominance REAL NOT NULL,
        emo_intensity REAL NOT NULL,
        importance REAL NOT NULL,
        weight REAL NOT NULL,
        links TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_recalled_at TEXT,
        recall_count INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        schema_version INTEGER NOT NULL DEFAULT 1,
        salience REAL,
        merged_count INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        workspace_id TEXT,
        thread_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_character ON events(character_id, archived, weight, created_at);
      CREATE TABLE IF NOT EXISTS emotion_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        at TEXT NOT NULL,
        pleasure REAL NOT NULL,
        arousal REAL NOT NULL,
        dominance REAL NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_emotion_event ON emotion_history(event_id);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
        this.migrateFts();
        this.migrateFilterColumns();
        this.migrateParticipants();
    }
    /**
     * 单向来源的事件不该挂 'user'：早期一律写 ['self','user']，
     * 社交性项恒为 1 让显著性虚高，人物画像把"刷到的视频"算成"和用户一起做的事"，
     * L2 亲密度的锚点跟着失真。把已经写错的这批改回 ['self']（幂等）。
     */
    migrateParticipants() {
        const single = JSON.stringify(['self']);
        this.db
            .prepare(`UPDATE events SET participants = ?
          WHERE source IN ('douyin_content', 'system', 'android')
            AND participants <> ?`)
            .run(single, single);
    }
    /** 老库补列：认知滤网（salience/merged_count）与"窗口只是工位"（session/workspace），缺列时原地 ALTER */
    migrateFilterColumns() {
        try {
            const columns = new Set(this.db.prepare('PRAGMA table_info(events)').all().map((column) => column.name));
            if (!columns.has('salience'))
                this.db.exec('ALTER TABLE events ADD COLUMN salience REAL');
            if (!columns.has('merged_count')) {
                this.db.exec('ALTER TABLE events ADD COLUMN merged_count INTEGER NOT NULL DEFAULT 0');
            }
            if (!columns.has('session_id'))
                this.db.exec('ALTER TABLE events ADD COLUMN session_id TEXT');
            if (!columns.has('workspace_id'))
                this.db.exec('ALTER TABLE events ADD COLUMN workspace_id TEXT');
            if (!columns.has('thread_id'))
                this.db.exec('ALTER TABLE events ADD COLUMN thread_id TEXT');
        }
        catch (error) {
            this.logger.warn('dsh-daughter: 老库补列迁移失败', { error: String(error) });
        }
    }
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
    migrateFts() {
        try {
            const existed = this.db
                .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'events_fts'")
                .get();
            this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
          title, summary, tags,
          content='events', content_rowid='rowid',
          tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
          INSERT INTO events_fts(rowid, title, summary, tags)
          VALUES (new.rowid, new.title, new.summary, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
          INSERT INTO events_fts(events_fts, rowid, title, summary, tags)
          VALUES ('delete', old.rowid, old.title, old.summary, old.tags);
        END;
      `);
            // 旧版本的整表 UPDATE 触发器必须先拆掉，否则收窄后的新触发器根本建不上
            this.db.exec('DROP TRIGGER IF EXISTS events_fts_au');
            this.db.exec(`
        CREATE TRIGGER events_fts_au AFTER UPDATE OF title, summary, tags ON events BEGIN
          INSERT INTO events_fts(events_fts, rowid, title, summary, tags)
          VALUES ('delete', old.rowid, old.title, old.summary, old.tags);
          INSERT INTO events_fts(rowid, title, summary, tags)
          VALUES (new.rowid, new.title, new.summary, new.tags);
        END;
      `);
            this.ftsAvailable = true;
            if (Number(existed?.n ?? 0) === 0) {
                this.db.exec("INSERT INTO events_fts(events_fts) VALUES ('rebuild')");
                this.ftsRebuilt = 'created';
            }
            else if (!this.ftsIndexUsable()) {
                // 外部内容表的 COUNT(*) 与 integrity-check 都只看内容表，
                // 索引被清空也照样报"正常"（实测 delete-all 后 MATCH 命中 0 而两者都不报错）。
                // 唯一可靠的探针是拿真实标题真查一次。
                this.db.exec("INSERT INTO events_fts(events_fts) VALUES ('rebuild')");
                this.ftsRebuilt = 'repaired';
                this.logger.warn('dsh-daughter: FTS 索引与事件表不一致，已重建');
            }
        }
        catch (error) {
            this.ftsAvailable = false;
            this.logger.warn('dsh-daughter: FTS5 不可用，检索退回字面匹配', { error: String(error) });
        }
    }
    /**
     * 功能性探针：取几条标题够长的真实事件，按子串查一次索引。
     * 命中说明索引和内容表对得上；查不到说明索引缺内容（需要 rebuild）。
     * 空库直接按健康处理，避免每次启动都重建。
     */
    ftsIndexUsable() {
        try {
            const rows = this.db
                .prepare('SELECT title FROM events WHERE length(title) >= 3 ORDER BY rowid DESC LIMIT 5')
                .all();
            if (rows.length === 0)
                return true;
            for (const row of rows) {
                const token = [...String(row.title)].slice(0, 3).join('').replace(/["*()]/g, ' ').trim();
                if ([...token].length < 3)
                    continue;
                const hit = this.db
                    .prepare('SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH ?')
                    .get(`"${token}"`);
                return Number(hit.n) > 0;
            }
            return true;
        }
        catch {
            return false;
        }
    }
    seedDefaults() {
        mkdirSync(this.paths.neocortex, { recursive: true });
        mkdirSync(this.paths.skills, { recursive: true });
        mkdirSync(this.paths.reflexes, { recursive: true });
        mkdirSync(this.paths.motions, { recursive: true });
        mkdirSync(this.paths.archive, { recursive: true });
        mkdirSync(this.paths.starMap, { recursive: true });
        // 出生人格：按 character_id + seed 抽样，不同角色落在不同点；同一角色重启不变
        const initialL1 = createInitialL1(this.characterId, this.seed, this.initialPersonality);
        const initialL2 = createInitialL2(this.characterId, this.seed, this.initialPersonality);
        this.writeIfMissing(join(this.paths.neocortex, 'l1_baseline.yaml'), initialL1);
        this.writeIfMissing(join(this.paths.neocortex, 'l2_relationship.yaml'), initialL2);
        this.writeIfMissing(join(this.paths.neocortex, 'l3_cognition.yaml'), DEFAULT_L3);
        this.writeIfMissing(join(this.paths.neocortex, 'l4_subpersonas.yaml'), DEFAULT_L4);
        this.writeIfMissing(join(this.paths.reflexes, 'rules.yaml'), DEFAULT_REFLEX_RULES);
    }
    ensureLayout() {
        const dirs = [
            join(this.dataRoot, 'brain', 'hippocampus', 'index'),
            join(this.dataRoot, 'brain', 'hippocampus', 'matches'),
            join(this.dataRoot, 'brain', 'hippocampus', 'links'),
            join(this.dataRoot, 'brain', 'neocortex', 'semantic'),
            join(this.dataRoot, 'brain', 'amygdala'),
            join(this.dataRoot, 'brain', 'prefrontal', 'working_memory'),
            join(this.dataRoot, 'brain', 'basal_ganglia', 'macros'),
            join(this.dataRoot, 'brain', 'basal_ganglia', 'connections'),
            join(this.dataRoot, 'brain', 'basal_ganglia', 'combos'),
            join(this.dataRoot, 'brain', 'cerebellum', 'templates'),
            join(this.dataRoot, 'brain', 'brainstem'),
            join(this.dataRoot, 'logs'),
            join(this.dataRoot, 'star_map'),
            join(this.dataRoot, 'archive'),
        ];
        for (const dir of dirs)
            mkdirSync(dir, { recursive: true });
    }
    writeIfMissing(path, value) {
        if (existsSync(path))
            return;
        this.writeLocked(path, YAML.stringify(value));
    }
    readYaml(path, fallback) {
        if (!existsSync(path)) {
            this.writeLocked(path, YAML.stringify(fallback));
            return fallback;
        }
        try {
            return { ...fallback, ...YAML.parse(readFileSync(path, 'utf8')) };
        }
        catch {
            this.logger.warn('人格文件解析失败，使用默认值', { path });
            return fallback;
        }
    }
    readYamlDir(dir) {
        if (!existsSync(dir))
            return [];
        const result = [];
        for (const name of this.listFiles(dir)) {
            if (!/\.(yaml|yml)$/i.test(name))
                continue;
            try {
                const parsed = YAML.parse(readFileSync(join(dir, name), 'utf8'));
                if (Array.isArray(parsed))
                    result.push(...parsed);
                else if (parsed)
                    result.push(parsed);
            }
            catch (error) {
                this.logger.warn('技能/资产文件解析失败', { name, error: String(error) });
            }
        }
        return result;
    }
    listFiles(dir) {
        try {
            return readdirSync(dir);
        }
        catch {
            return [];
        }
    }
    mapRow(row) {
        return {
            id: row.id,
            characterId: row.character_id,
            title: row.title,
            summary: row.summary,
            tags: safeJsonArray(row.tags),
            participants: safeJsonArray(row.participants),
            emotionAtTime: {
                pleasure: row.emo_pleasure,
                arousal: row.emo_arousal,
                dominance: row.emo_dominance,
                intensity: row.emo_intensity,
            },
            emotionNowHistory: [],
            importance: row.importance,
            weight: row.weight,
            links: safeJsonArray(row.links),
            source: row.source,
            createdAt: row.created_at,
            lastRecalledAt: row.last_recalled_at ?? undefined,
            recallCount: row.recall_count,
            archived: row.archived === 1,
            salience: typeof row.salience === 'number' ? row.salience : undefined,
            mergedCount: typeof row.merged_count === 'number' ? row.merged_count : 0,
            sessionId: row.session_id ?? undefined,
            workspaceId: row.workspace_id ?? undefined,
            threadId: row.thread_id ?? undefined,
            schemaVersion: 1,
        };
    }
    loadEmotionHistory(eventId) {
        const rows = this.db
            .prepare('SELECT at, pleasure, arousal, dominance, reason FROM emotion_history WHERE event_id = ? ORDER BY id ASC')
            .all(eventId);
        return rows.map((row) => ({
            at: row.at,
            emotion: { pleasure: row.pleasure, arousal: row.arousal, dominance: row.dominance },
            reason: row.reason,
        }));
    }
    /**
     * 回忆重构合并：超过上限时不丢弃中间记录，而是把情绪最接近的相邻两条合并成一条平均记录。
     * 首条（最早的回看）与末条（最近的回看）原样保留，只在中间段合并。
     */
    compactEmotionHistory(eventId) {
        const history = this.loadEmotionHistory(eventId);
        if (history.length <= EMOTION_HISTORY_CAP)
            return;
        while (history.length > EMOTION_HISTORY_CAP) {
            let mergeAt = -1;
            let bestDistance = Number.POSITIVE_INFINITY;
            for (let i = 2; i <= history.length - 2; i += 1) {
                const distance = padDistance(history[i - 1].emotion, history[i].emotion);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    mergeAt = i;
                }
            }
            if (mergeAt < 0)
                break;
            const earlier = history[mergeAt - 1];
            const later = history[mergeAt];
            history.splice(mergeAt - 1, 2, {
                at: later.at,
                emotion: {
                    pleasure: (earlier.emotion.pleasure + later.emotion.pleasure) / 2,
                    arousal: (earlier.emotion.arousal + later.emotion.arousal) / 2,
                    dominance: (earlier.emotion.dominance + later.emotion.dominance) / 2,
                },
                reason: earlier.reason === later.reason ? later.reason : MERGED_RECALL_REASON,
            });
        }
        this.db.prepare('DELETE FROM emotion_history WHERE event_id = ?').run(eventId);
        const stmt = this.db.prepare('INSERT INTO emotion_history (event_id, at, pleasure, arousal, dominance, reason) VALUES (?, ?, ?, ?, ?, ?)');
        for (const entry of history) {
            stmt.run(eventId, entry.at, entry.emotion.pleasure, entry.emotion.arousal, entry.emotion.dominance, entry.reason);
        }
    }
}
/**
 * 把自然语言查询转成 FTS5 表达式。
 *
 * trigram 分词器要求每个检索词至少 3 个字符，而短语匹配意味着查询里的空格必须
 * 原样出现在正文里——中文正文没有空格，于是「下雨 心情」这类多词查询永远 0 命中，
 * 只能靠 Dice 字面匹配兜底。这里拆词后逐词短语化、再用 AND 取交集：
 * 单词查询仍然等价于子串匹配，多词查询变成"每个词都要出现"。
 */
function ftsExpression(query) {
    const cleaned = query
        .replace(/["*():^]/g, ' ')
        .replace(/[，。！？、；：,.!?;:\n\r\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned)
        return null;
    const tokens = [...new Set(cleaned.split(' ').filter((token) => [...token].length >= 3))].slice(0, 8);
    if (tokens.length === 0)
        return null;
    return tokens.map((token) => `"${token}"`).join(' AND ');
}
function safeJsonArray(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
