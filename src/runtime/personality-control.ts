/**
 * 人格控制：演化总开关之外，主人还能逐项锁定。
 *
 * 与配置的分工：总开关是配置项 `personality.enabled`（可被设置覆盖文件改写）；
 * 锁定是数据，存在 `settings/personality.json`，只影响演化写入，不改任何默认配置。
 * 两者都只在「写人格」时生效，读人格、注入、记忆与情绪不受影响。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 可锁定的演化目标：五维逐项、依恋两维、自我叙事三轴 */
export const LOCK_KEYS = [
  'openness',
  'conscientiousness',
  'extraversion',
  'agreeableness',
  'neuroticism',
  'attachment',
  'narrative',
] as const;

export type LockKey = typeof LOCK_KEYS[number];

export interface PersonalityControl {
  /** 被锁定的维度：锁定后经历不再推动它 */
  locked: LockKey[];
  /** 上次重抽用的种子；null 表示沿用出生种子 */
  seed: number | null;
}

export const EMPTY_CONTROL: PersonalityControl = { locked: [], seed: null };

export function personalityControlPath(dataRoot: string): string {
  return join(dataRoot, 'settings', 'personality.json');
}

function isLockKey(value: string): value is LockKey {
  return (LOCK_KEYS as readonly string[]).includes(value);
}

/** 非法键直接丢弃：控制文件损坏或手改出错都不该让人格整块停摆 */
export function normalizePersonalityControl(raw: unknown): PersonalityControl {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const lockedRaw = Array.isArray(source.locked) ? source.locked : [];
  const locked = [...new Set(
    lockedRaw.filter((key): key is string => typeof key === 'string' && isLockKey(key)),
  )] as LockKey[];
  const seed = typeof source.seed === 'number' && Number.isFinite(source.seed)
    ? Math.trunc(source.seed) >>> 0
    : null;
  return { locked, seed };
}

export function loadPersonalityControl(dataRoot: string): PersonalityControl {
  try {
    const path = personalityControlPath(dataRoot);
    if (!existsSync(path)) return { ...EMPTY_CONTROL };
    return normalizePersonalityControl(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { ...EMPTY_CONTROL };
  }
}

export function savePersonalityControl(dataRoot: string, raw: unknown): PersonalityControl {
  const control = normalizePersonalityControl(raw);
  const path = personalityControlPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(control, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
  return control;
}
