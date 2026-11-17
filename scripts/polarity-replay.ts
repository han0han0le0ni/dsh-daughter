/**
 * 极性日志离线复算（B3 / DEF-01 第三步）。
 *
 * 两种数据源：
 * - 默认读 `logs/polarity/<角色>.jsonl`（A1 日志层，先跑真实对话才有）
 * - `--events` 直接重放库里已有事件：对 `title + summary` 重跑 `analyzeSentiment`，
 *   与入库时记录的 `emo_pleasure` 对比，回答「全正」是语料问题还是符号饱和
 *
 * 只读，不连服务；输出负向占比、命中词分布与 PAD 均值。
 *
 * 用法：
 * - `npm run polarity:replay`：读默认数据目录下的日志
 * - `npm run polarity:replay -- --events`：重放库里已有事件（不需要极性日志）
 * - `npm run polarity:replay -- --character daughter-default`
 * - `npm run polarity:replay -- --file ./logs/polarity/x.jsonl --json`
 * - `npm run polarity:replay -- --days 14`：只看最近 14 天
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, resolveDataRoot } from '../src/config.js';
import { polarityLogPath } from '../src/runtime/polarity-log.js';
import { analyzeSentiment } from '../src/runtime/state.js';
import type { EventRecord, PolarityLogEntry } from '../src/types.js';

/** 中性带宽：|polarity| 小于该值视为没有明确情绪方向 */
const NEUTRAL_BAND = 0.05;

export interface PolarityReport {
  file: string;
  total: number;
  invalid: number;
  buckets: { negative: number; neutral: number; positive: number };
  negativeShare: number;
  meanPolarity: number;
  meanStrength: number;
  meanPadDelta: { pleasure: number; arousal: number; dominance: number };
  words: Array<{ word: string; count: number; sign: '正' | '负' }>;
  daily: Array<{ day: string; total: number; negative: number }>;
  /** `--events` 模式才有：入库时的极性分布，用来和复算结果对照 */
  stored?: { negative: number; neutral: number; positive: number };
  /** `--events` 模式才有：入库判正、复算判负的条目（符号饱和的直接证据） */
  flipped?: Array<{ id: string; title: string; at: string; stored: number; replayed: number }>;
  /** `--events` 模式才有：上述条目总数（`flipped` 只留前 5 条示例） */
  flippedTotal?: number;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

/** 解析 JSONL：坏行只计数不抛错，避免一行截断让整份统计失败 */
export function parseLog(text: string): { entries: PolarityLogEntry[]; invalid: number } {
  const entries: PolarityLogEntry[] = [];
  let invalid = 0;
  // 手工导出的日志可能带 BOM，先剥掉，否则首行解析必失败
  for (const line of text.replace(/^\uFEFF/, '').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as PolarityLogEntry);
    } catch {
      invalid += 1;
    }
  }
  return { entries, invalid };
}

export function buildReport(
  entries: PolarityLogEntry[],
  invalid = 0,
  file = '',
  extra: Pick<PolarityReport, 'stored' | 'flipped' | 'flippedTotal'> = {},
): PolarityReport {
  const buckets = { negative: 0, neutral: 0, positive: 0 };
  const daily = new Map<string, { total: number; negative: number }>();
  const words = new Map<string, { count: number; sign: '正' | '负' }>();

  for (const entry of entries) {
    if (entry.polarity <= -NEUTRAL_BAND) buckets.negative += 1;
    else if (entry.polarity >= NEUTRAL_BAND) buckets.positive += 1;
    else buckets.neutral += 1;

    const day = entry.at.slice(0, 10);
    const bucket = daily.get(day) ?? { total: 0, negative: 0 };
    bucket.total += 1;
    if (entry.polarity <= -NEUTRAL_BAND) bucket.negative += 1;
    daily.set(day, bucket);

    for (const word of entry.positives) {
      const row = words.get(word) ?? { count: 0, sign: '正' as const };
      row.count += 1;
      words.set(word, row);
    }
    for (const word of entry.negatives) {
      const row = words.get(word) ?? { count: 0, sign: '负' as const };
      // 同一个词既被当正面又被当负面时保留首次出现的符号，后续再看原文
      row.count += 1;
      words.set(word, row);
    }
  }

  return {
    file,
    total: entries.length,
    invalid,
    buckets,
    negativeShare: entries.length === 0 ? 0 : round(buckets.negative / entries.length),
    meanPolarity: round(mean(entries.map((entry) => entry.polarity))),
    meanStrength: round(mean(entries.map((entry) => entry.strength))),
    meanPadDelta: {
      pleasure: round(mean(entries.map((entry) => entry.padDelta.pleasure))),
      arousal: round(mean(entries.map((entry) => entry.padDelta.arousal))),
      dominance: round(mean(entries.map((entry) => entry.padDelta.dominance))),
    },
    words: [...words.entries()]
      .map(([word, row]) => ({ word, count: row.count, sign: row.sign }))
      .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
      .slice(0, 20),
    daily: [...daily.entries()]
      .map(([day, row]) => ({ day, total: row.total, negative: row.negative }))
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-14),
    ...extra,
  };
}

/** 库里事件的最小投影：只取复算需要的字段 */
export interface StoredEventRow {
  id: string;
  title: string;
  summary: string;
  emoPleasure: number;
  createdAt: string;
  source: string;
  /** 原文（全文文件存在时优先用它复算，标题只是摘要） */
  text?: string;
}

/**
 * 用当前算法重放历史事件：同一条文本各自算一遍，再和入库时的 `emo_pleasure` 对照。
 * 分开统计「入库判定」与「复算判定」，才能看出旧算法是不是把负向一律压成了正。
 */
export function replayEvents(rows: StoredEventRow[]): {
  entries: PolarityLogEntry[];
  stored: { negative: number; neutral: number; positive: number };
  flipped: Array<{ id: string; title: string; at: string; stored: number; replayed: number }>;
} {
  const stored = { negative: 0, neutral: 0, positive: 0 };
  const flipped: Array<{ id: string; title: string; at: string; stored: number; replayed: number }> = [];
  const entries: PolarityLogEntry[] = [];

  for (const row of rows) {
    const detail = analyzeSentiment((row.text ?? `${row.title} ${row.summary}`).trim());
    const padding = { pleasure: 0, arousal: 0, dominance: 0 };
    entries.push({
      at: row.createdAt,
      characterId: '',
      sessionId: '',
      turnId: row.id,
      textHash: null,
      hits: detail.hits,
      negations: detail.negations,
      positives: detail.positives,
      negatives: detail.negatives,
      polarity: detail.polarity,
      strength: detail.strength,
      padDelta: detail.pad,
      padAfter: padding,
      source: row.source as EventRecord['source'],
    });

    if (row.emoPleasure <= -NEUTRAL_BAND) stored.negative += 1;
    else if (row.emoPleasure >= NEUTRAL_BAND) stored.positive += 1;
    else stored.neutral += 1;

    if (row.emoPleasure >= NEUTRAL_BAND && detail.polarity <= -NEUTRAL_BAND) {
      flipped.push({
        id: row.id,
        title: row.title,
        at: row.createdAt,
        stored: round(row.emoPleasure),
        replayed: round(detail.polarity),
      });
    }
  }

  // 按差额排序：翻得最狠的排前面，抽样复核先看这几条
  flipped.sort((a, b) => (a.stored - a.replayed) - (b.stored - b.replayed));
  return { entries, stored, flipped };
}

/** 读库里的历史事件；只读打开，缺库时返回 null 交给调用方提示 */
export function readStoredEvents(dataRoot: string, characterId: string): StoredEventRow[] | null {
  const dbPath = join(dataRoot, 'brain', 'hippocampus', 'index', 'memory.db');
  if (!existsSync(dbPath)) return null;
  const fulltextDir = join(dataRoot, 'brain', 'hippocampus', 'fulltext', characterId);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, title, summary, emo_pleasure AS emoPleasure, created_at AS createdAt, source
         FROM events WHERE character_id = ? ORDER BY created_at ASC`,
      )
      .all(characterId) as unknown as StoredEventRow[];
    // 原文比标题更接近当时的输入；全文缺失时才退回标题 + 摘要
    return rows.map((row) => {
      const file = join(fulltextDir, `${row.id}.txt`);
      if (!existsSync(file)) return row;
      const text = readFileSync(file, 'utf8').trim();
      return text ? { ...row, text } : row;
    });
  } finally {
    db.close();
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** 日志与事件共用同一条时间窗：以最新一条为基准往回推 */
function scopeByDays<T extends { at: string }>(items: T[], days: number): T[] {
  if (!Number.isFinite(days) || days <= 0 || items.length === 0) return items;
  const cutoff = Date.parse(items[items.length - 1]!.at) - days * 86_400_000;
  return items.filter((item) => Date.parse(item.at) >= cutoff);
}

function main(): void {
  const config = loadConfig(process.cwd());
  const characterId = argValue('--character') ?? 'daughter-default';
  const dataRoot = resolveDataRoot(process.cwd(), config);
  const days = Number(argValue('--days'));
  const fromEvents = process.argv.includes('--events');

  let entries: PolarityLogEntry[];
  let invalid = 0;
  let label: string;
  let extra: Pick<PolarityReport, 'stored' | 'flipped' | 'flippedTotal'> = {};

  if (fromEvents) {
    const rows = readStoredEvents(dataRoot, characterId);
    if (rows === null) {
      console.log(`没有找到记忆库：${join(dataRoot, 'brain', 'hippocampus', 'index', 'memory.db')}`);
      return;
    }
    const replay = (() => {
      // 先在行层面按天裁剪再复算，保证「入库分布」和「复算分布」是同一批
      const cutoff = Number.isFinite(days) && days > 0 && rows.length > 0
        ? Date.parse(rows[rows.length - 1]!.createdAt) - days * 86_400_000
        : Number.NEGATIVE_INFINITY;
      return replayEvents(rows.filter((row) => Date.parse(row.createdAt) >= cutoff));
    })();
    entries = replay.entries;
    extra = {
      stored: replay.stored,
      flipped: replay.flipped.slice(0, 5),
      flippedTotal: replay.flipped.length,
    };
    label = `记忆库事件重放：${characterId}（${rows.length} 条）`;
  } else {
    const file = argValue('--file') ?? polarityLogPath(dataRoot, characterId);
    if (!existsSync(file)) {
      console.log(`没有找到极性日志：${file}`);
      console.log('先跑几轮真实对话（polarity_log.enabled=true），或指定 --file；也可以加 --events 直接重放库里事件。');
      return;
    }
    const parsed = parseLog(readFileSync(file, 'utf8'));
    entries = scopeByDays(parsed.entries, days);
    invalid = parsed.invalid;
    label = `极性日志复算：${resolve(file)}`;
  }

  const report = buildReport(entries, invalid, label, extra);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(report.file);
  console.log(`  条数 ${report.total}（坏行 ${report.invalid}）`);
  console.log(
    `  分布 负 ${report.buckets.negative} / 中性 ${report.buckets.neutral} / 正 ${report.buckets.positive}，负向占比 ${report.negativeShare}`,
  );
  console.log(`  均值 polarity ${report.meanPolarity}，strength ${report.meanStrength}`);
  console.log(
    `  PAD 增量均值 pleasure ${report.meanPadDelta.pleasure} / arousal ${report.meanPadDelta.arousal} / dominance ${report.meanPadDelta.dominance}`,
  );

  if (report.stored) {
    console.log(
      `  入库时判定 负 ${report.stored.negative} / 中性 ${report.stored.neutral} / 正 ${report.stored.positive}` +
      `；复算判负 ${report.buckets.negative}，其中入库判正 ${report.flippedTotal ?? 0} 条`,
    );
    for (const row of report.flipped ?? []) {
      console.log(`    翻向 ${row.id} ${row.at.slice(0, 10)} 入库 ${row.stored} → 复算 ${row.replayed}`);
    }
  }

  if (report.words.length > 0) {
    console.log('  命中词 Top：');
    for (const row of report.words) console.log(`    ${row.sign} ${row.word} × ${row.count}`);
  }
  if (report.daily.length > 0) {
    console.log('  按日：');
    for (const row of report.daily) console.log(`    ${row.day}  ${row.total} 条（负 ${row.negative}）`);
  }

  if (report.total > 0 && report.buckets.negative === 0) {
    console.log('  结论：样本里没有任何负向表达，先怀疑语料，不要直接改算法参数。');
  }
}

if (process.argv[1] && /polarity-replay\.(ts|js)$/.test(process.argv[1])) {
  main();
}
