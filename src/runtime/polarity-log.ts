/**
 * A1 情绪日志（可观测层）。
 *
 * 只把每轮识别出的派生结果追加到 `logs/polarity/<角色>.jsonl`：
 * 命中词、否定词、极性、强度、PAD 增量。不存原文，只存文本哈希。
 * 它不参与任何决策，也不改 `sentimentPolarity` 的公式。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PolarityLogEntry } from '../types.js';
import { atomicWriteFile, withFileLock } from '../util.js';

const MAX_BYTES = 2 * 1024 * 1024;

export function polarityLogPath(dataRoot: string, characterId: string): string {
  return join(dataRoot, 'logs', 'polarity', `${characterId}.jsonl`);
}

/** 追加一条日志；单文件超过 2MB 时轮转为 .1.jsonl，避免长期运行无限增长 */
export function logPolarity(dataRoot: string, entry: PolarityLogEntry): void {
  if (!entry || !entry.characterId || !entry.at) return;
  const path = polarityLogPath(dataRoot, entry.characterId);
  mkdirSync(dirname(path), { recursive: true });
  withFileLock(path, () => {
    if (existsSync(path) && statSync(path).size >= MAX_BYTES) {
      const rotated = path.replace(/\.jsonl$/, '.1.jsonl');
      rmSync(rotated, { force: true });
      renameSync(path, rotated);
    }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  });
}

/** 按保留天数裁剪；返回删除的行数。无法解析的行按过期处理。 */
export function prunePolarityLog(
  dataRoot: string,
  characterId: string,
  retentionDays: number,
  now: string,
): number {
  const path = polarityLogPath(dataRoot, characterId);
  if (!existsSync(path)) return 0;

  const nowMs = Date.parse(now);
  const days = Math.max(1, Math.round(Number.isFinite(retentionDays) ? retentionDays : 90));
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);

  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as PolarityLogEntry;
      const at = Date.parse(entry.at);
      if (Number.isFinite(at) && Number.isFinite(nowMs) && nowMs - at > days * 86_400_000) {
        removed += 1;
        continue;
      }
      kept.push(line);
    } catch {
      removed += 1;
    }
  }

  if (removed > 0) {
    withFileLock(path, () => atomicWriteFile(path, kept.length > 0 ? `${kept.join('\n')}\n` : ''));
  }
  return removed;
}
