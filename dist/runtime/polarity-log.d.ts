import type { PolarityLogEntry } from '../types.js';
export declare function polarityLogPath(dataRoot: string, characterId: string): string;
/** 追加一条日志；单文件超过 2MB 时轮转为 .1.jsonl，避免长期运行无限增长 */
export declare function logPolarity(dataRoot: string, entry: PolarityLogEntry): void;
/** 按保留天数裁剪；返回删除的行数。无法解析的行按过期处理。 */
export declare function prunePolarityLog(dataRoot: string, characterId: string, retentionDays: number, now: string): number;
