import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const WINDOW = 200;
const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
function round(value) {
    return Math.round(value * 1000) / 1000;
}
function p95(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
    return sorted[index] ?? 0;
}
/**
 * 运行/反射日志与指标（§13）。日志按角色追加到 logs/run、logs/reflex；
 * 指标保留最近 200 轮的环形窗口，同时落盘到 logs/metrics，进程重启后可继续累积。
 */
export class Observability {
    characterId;
    runDir;
    reflexDir;
    metricsDir;
    metricsPath;
    turns = 0;
    reflexHits = 0;
    degradedTurns = 0;
    memoryHitTurns = 0;
    overBudgetTurns = 0;
    tokens = [];
    maxLogBytes;
    constructor(dataRoot, characterId, options = {}) {
        this.characterId = characterId;
        const logs = join(dataRoot, 'logs');
        this.runDir = join(logs, 'run');
        this.reflexDir = join(logs, 'reflex');
        this.metricsDir = join(logs, 'metrics');
        this.metricsPath = join(this.metricsDir, `${characterId}.json`);
        this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
        this.restore();
    }
    recordTurn(observation) {
        this.turns += 1;
        if (observation.memoryHit)
            this.memoryHitTurns += 1;
        if (observation.degraded)
            this.degradedTurns += 1;
        if (observation.overBudget)
            this.overBudgetTurns += 1;
        this.tokens.push(observation.injectTokens);
        if (this.tokens.length > WINDOW)
            this.tokens = this.tokens.slice(-WINDOW);
        this.append(join(this.runDir, `${this.characterId}.jsonl`), observation);
        this.persist();
    }
    recordReflex(observation) {
        this.reflexHits += 1;
        this.append(join(this.reflexDir, `${this.characterId}.jsonl`), observation);
        this.persist();
    }
    metrics() {
        return {
            memoryHitRate: this.turns > 0 ? round(this.memoryHitTurns / this.turns) : 0,
            injectTokenP95: Math.round(p95(this.tokens)),
            reflexHitRate: this.turns > 0 ? round(this.reflexHits / this.turns) : 0,
            degradeRate: this.turns > 0 ? round(this.degradedTurns / this.turns) : 0,
            overBudgetRate: this.turns > 0 ? round(this.overBudgetTurns / this.turns) : 0,
            turns: this.turns,
            reflexHits: this.reflexHits,
            window: this.tokens.length,
        };
    }
    append(path, entry) {
        mkdirSync(dirname(path), { recursive: true });
        // 单文件超过上限时轮转为 .1.jsonl（只保留一个旧文件），避免长期运行无限增长
        if (existsSync(path) && statSync(path).size >= this.maxLogBytes) {
            const rotated = path.replace(/\.jsonl$/, '.1.jsonl');
            rmSync(rotated, { force: true });
            renameSync(path, rotated);
        }
        appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
    }
    persist() {
        mkdirSync(this.metricsDir, { recursive: true });
        const data = {
            turns: this.turns,
            reflexHits: this.reflexHits,
            degradedTurns: this.degradedTurns,
            memoryHitTurns: this.memoryHitTurns,
            overBudgetTurns: this.overBudgetTurns,
            tokens: this.tokens,
        };
        writeFileSync(this.metricsPath, JSON.stringify(data), 'utf8');
    }
    restore() {
        if (!existsSync(this.metricsPath))
            return;
        try {
            const data = JSON.parse(readFileSync(this.metricsPath, 'utf8'));
            this.turns = data.turns ?? 0;
            this.reflexHits = data.reflexHits ?? 0;
            this.degradedTurns = data.degradedTurns ?? 0;
            this.memoryHitTurns = data.memoryHitTurns ?? 0;
            this.overBudgetTurns = data.overBudgetTurns ?? 0;
            this.tokens = Array.isArray(data.tokens) ? data.tokens.slice(-WINDOW) : [];
        }
        catch {
            // 指标文件损坏时从零开始，不影响主流程
        }
    }
}
