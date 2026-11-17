import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DaughterMetrics } from '../types.js';

/** 单轮运行观测：耗时、注入 token、检索命中、是否降级 */
export interface TurnObservation {
  at: string;
  sessionId: string;
  turnId: string;
  characterId: string;
  tookMs: number;
  /** 检索阶段耗时，用于核对 §6.1 的 150ms 预算 */
  retrieveMs?: number;
  /** 本轮是否超出 §6.1 时延预算（retrieve >150ms 或整轮 >100ms） */
  overBudget?: boolean;
  injectTokens: number;
  hits: number;
  skills: number;
  memoryHit: boolean;
  degraded: boolean;
}

/** 反射命中观测：规则、耗时、动作结果 */
export interface ReflexObservation {
  at: string;
  sessionId: string;
  turnId: string;
  characterId: string;
  ruleId: string;
  actionKind: string;
  tookMs: number;
  ok: boolean;
}

interface PersistedMetrics {
  turns: number;
  reflexHits: number;
  degradedTurns: number;
  memoryHitTurns: number;
  overBudgetTurns: number;
  tokens: number[];
}

const WINDOW = 200;
const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[index] ?? 0;
}

/**
 * 运行/反射日志与指标（§13）。日志按角色追加到 logs/run、logs/reflex；
 * 指标保留最近 200 轮的环形窗口，同时落盘到 logs/metrics，进程重启后可继续累积。
 */
export class Observability {
  private readonly runDir: string;
  private readonly reflexDir: string;
  private readonly metricsDir: string;
  private readonly metricsPath: string;

  private turns = 0;
  private reflexHits = 0;
  private degradedTurns = 0;
  private memoryHitTurns = 0;
  private overBudgetTurns = 0;
  private tokens: number[] = [];
  private readonly maxLogBytes: number;

  constructor(dataRoot: string, private readonly characterId: string, options: { maxLogBytes?: number } = {}) {
    const logs = join(dataRoot, 'logs');
    this.runDir = join(logs, 'run');
    this.reflexDir = join(logs, 'reflex');
    this.metricsDir = join(logs, 'metrics');
    this.metricsPath = join(this.metricsDir, `${characterId}.json`);
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.restore();
  }

  recordTurn(observation: TurnObservation): void {
    this.turns += 1;
    if (observation.memoryHit) this.memoryHitTurns += 1;
    if (observation.degraded) this.degradedTurns += 1;
    if (observation.overBudget) this.overBudgetTurns += 1;
    this.tokens.push(observation.injectTokens);
    if (this.tokens.length > WINDOW) this.tokens = this.tokens.slice(-WINDOW);

    this.append(join(this.runDir, `${this.characterId}.jsonl`), observation);
    this.persist();
  }

  recordReflex(observation: ReflexObservation): void {
    this.reflexHits += 1;
    this.append(join(this.reflexDir, `${this.characterId}.jsonl`), observation);
    this.persist();
  }

  metrics(): DaughterMetrics {
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

  private append(path: string, entry: TurnObservation | ReflexObservation): void {
    mkdirSync(dirname(path), { recursive: true });
    // 单文件超过上限时轮转为 .1.jsonl（只保留一个旧文件），避免长期运行无限增长
    if (existsSync(path) && statSync(path).size >= this.maxLogBytes) {
      const rotated = path.replace(/\.jsonl$/, '.1.jsonl');
      rmSync(rotated, { force: true });
      renameSync(path, rotated);
    }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  private persist(): void {
    mkdirSync(this.metricsDir, { recursive: true });
    const data: PersistedMetrics = {
      turns: this.turns,
      reflexHits: this.reflexHits,
      degradedTurns: this.degradedTurns,
      memoryHitTurns: this.memoryHitTurns,
      overBudgetTurns: this.overBudgetTurns,
      tokens: this.tokens,
    };
    writeFileSync(this.metricsPath, JSON.stringify(data), 'utf8');
  }

  private restore(): void {
    if (!existsSync(this.metricsPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.metricsPath, 'utf8')) as Partial<PersistedMetrics>;
      this.turns = data.turns ?? 0;
      this.reflexHits = data.reflexHits ?? 0;
      this.degradedTurns = data.degradedTurns ?? 0;
      this.memoryHitTurns = data.memoryHitTurns ?? 0;
      this.overBudgetTurns = data.overBudgetTurns ?? 0;
      this.tokens = Array.isArray(data.tokens) ? data.tokens.slice(-WINDOW) : [];
    } catch {
      // 指标文件损坏时从零开始，不影响主流程
    }
  }
}
