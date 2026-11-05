import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import YAML from 'yaml';
import { atomicWriteFile, createRng, padDistance, safeFileName, silentLogger, withFileLock } from './util.js';
import { normalizeReflexRule } from './runtime/content.js';
/** emotion_now_history 上限；超出后按相邻合并，而不是截断丢弃 */
const EMOTION_HISTORY_CAP = 8;
const MERGED_RECALL_REASON = '回忆重构：多次回看感受接近，已合并';
/** 出厂人格基线：星图面板用它算“相对出厂值的偏移”，只读，不参与写回 */
export const DEFAULT_L1 = {
    bigFive: {
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
    updatedAt: '1970-01-01T00:00:00.000Z',
};
export const DEFAULT_L2 = {
    attachmentAnxiety: 0.35,
    attachmentAvoidance: 0.4,
    coreNeeds: ['被需要', '稳定回应'],
    trustBaseline: 0.3,
    relationshipStage: 'acquaintance',
    relationshipDepth: 0.2,
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
const DEFAULT_REFLEX_RULES = [
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
    rand;
    ftsAvailable = false;
    /** 最近一次 FTS 检索的失败原因；null 表示正常，供 index 计入降级指标 */
    lastFtsError = null;
    lockEnabled;
    constructor(dataRoot, characterId, seed = 42, logger = silentLogger, options = {}) {
        this.dataRoot = resolve(dataRoot);
        this.characterId = characterId;
        this.logger = logger;
        this.rand = createRng(seed);
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
          salience, merged_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(event.id, event.characterId, event.title, event.summary, JSON.stringify(event.tags), JSON.stringify(event.participants), event.emotionAtTime.pleasure, event.emotionAtTime.arousal, event.emotionAtTime.dominance, event.emotionAtTime.intensity, event.importance, event.weight, JSON.stringify(event.links), event.source, event.createdAt, event.lastRecalledAt ?? null, event.recallCount, event.archived ? 1 : 0, event.schemaVersion, event.salience ?? null, event.mergedCount ?? 0);
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
    /** 归档事件落盘到 archive/：完整记录留档，索引里只保留 archived 标记与薄字段 */
    archiveEvent(event) {
        this.writeLocked(join(this.paths.archive, `${safeFileName(event.id)}.json`), JSON.stringify(event, null, 2));
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
        return {
            l1: this.readYaml(join(this.paths.neocortex, 'l1_baseline.yaml'), DEFAULT_L1),
            l2: this.readYaml(join(this.paths.neocortex, 'l2_relationship.yaml'), DEFAULT_L2),
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
    newEvolutionId(now) {
        const date = now.slice(0, 10).replace(/-/g, '');
        const suffix = Math.floor(this.rand() * 0xffff)
            .toString(16)
            .padStart(4, '0');
        return `EVO-${date}-${suffix}`;
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
        const normalized = query.replace(/["*()]/g, ' ').replace(/\s+/g, ' ').trim();
        if ([...normalized.replace(/\s/g, '')].length < 3)
            return scores;
        try {
            const rows = this.db
                .prepare(`SELECT e.id AS id FROM events_fts JOIN events e ON e.rowid = events_fts.rowid
           WHERE events_fts MATCH ? AND e.character_id = ?
           ORDER BY rank LIMIT ?`)
                .all(`"${normalized}"`, this.characterId, limit);
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
        merged_count INTEGER NOT NULL DEFAULT 0
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
    }
    /** 老库补列：认知滤网引入的 salience / merged_count，缺列时原地 ALTER */
    migrateFilterColumns() {
        try {
            const columns = new Set(this.db.prepare('PRAGMA table_info(events)').all().map((column) => column.name));
            if (!columns.has('salience'))
                this.db.exec('ALTER TABLE events ADD COLUMN salience REAL');
            if (!columns.has('merged_count')) {
                this.db.exec('ALTER TABLE events ADD COLUMN merged_count INTEGER NOT NULL DEFAULT 0');
            }
        }
        catch (error) {
            this.logger.warn('dsh-daughter: 认知滤网列迁移失败', { error: String(error) });
        }
    }
    /**
     * FTS5 全文索引（D-02）：外部内容表 + 触发器保持与 events 同步。
     * 用 trigram 分词器以支持中文子串检索；若运行环境未编译 FTS5，降级为仅 Dice 字面匹配。
     */
    migrateFts() {
        try {
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
        CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE ON events BEGIN
          INSERT INTO events_fts(events_fts, rowid, title, summary, tags)
          VALUES ('delete', old.rowid, old.title, old.summary, old.tags);
          INSERT INTO events_fts(rowid, title, summary, tags)
          VALUES (new.rowid, new.title, new.summary, new.tags);
        END;
        INSERT INTO events_fts(events_fts) VALUES ('rebuild');
      `);
            this.ftsAvailable = true;
        }
        catch (error) {
            this.ftsAvailable = false;
            this.logger.warn('dsh-daughter: FTS5 不可用，检索退回字面匹配', { error: String(error) });
        }
    }
    seedDefaults() {
        mkdirSync(this.paths.neocortex, { recursive: true });
        mkdirSync(this.paths.skills, { recursive: true });
        mkdirSync(this.paths.reflexes, { recursive: true });
        mkdirSync(this.paths.motions, { recursive: true });
        mkdirSync(this.paths.archive, { recursive: true });
        mkdirSync(this.paths.starMap, { recursive: true });
        this.writeIfMissing(join(this.paths.neocortex, 'l1_baseline.yaml'), DEFAULT_L1);
        this.writeIfMissing(join(this.paths.neocortex, 'l2_relationship.yaml'), DEFAULT_L2);
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
function safeJsonArray(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
