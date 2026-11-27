/** 可锁定的演化目标：五维逐项、依恋两维、自我叙事三轴 */
export declare const LOCK_KEYS: readonly ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism", "attachment", "narrative"];
export type LockKey = typeof LOCK_KEYS[number];
export interface PersonalityControl {
    /** 被锁定的维度：锁定后经历不再推动它 */
    locked: LockKey[];
    /** 上次重抽用的种子；null 表示沿用出生种子 */
    seed: number | null;
}
export declare const EMPTY_CONTROL: PersonalityControl;
export declare function personalityControlPath(dataRoot: string): string;
/** 非法键直接丢弃：控制文件损坏或手改出错都不该让人格整块停摆 */
export declare function normalizePersonalityControl(raw: unknown): PersonalityControl;
export declare function loadPersonalityControl(dataRoot: string): PersonalityControl;
export declare function savePersonalityControl(dataRoot: string, raw: unknown): PersonalityControl;
