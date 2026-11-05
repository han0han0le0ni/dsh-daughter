import type { AssetKind, DaughterConfig, PersonaBundle, SkillCard } from '../types.js';
import type { Store } from '../store.js';
export declare function runTick(store: Store, config: DaughterConfig, now: string): {
    decayed: number;
    archived: number;
    forgotten: number;
    recovered: boolean;
    prunedLogs: number;
    evolved: string[];
    /** 本轮做了回落（向基线回归）的会话数 */
    relaxed: number;
};
/**
 * 情感回落：stress / fatigue / safety 与 PAD 一起向基线回归。
 *
 * 之前只有对话内的「+0.12 / −0.04」，没有任何回落，于是 safety 一路贴到 1.00、
 * stress 贴到 0.00，量程耗尽后情绪维度不再产生信息。按闲置小时数复利回归，
 * 连续对话时几乎不生效，隔夜才会明显回落——这也是「情绪会自己淡下去」的样子。
 */
export declare function relaxL5(store: Store, config: DaughterConfig, now: string): number;
/**
 * L2/L3/L4 低频写回：每天最多一次，每次变更都写 evolution 日志（G5）。
 * L2 关系深度向与「self」的亲密度平滑靠拢；L3 依近 7 天情绪缓慢调整防御成熟度并归一化权重；
 * L4 子人格权重每次更新后归一化。
 */
export declare function evolvePersona(store: Store, now: string): string[];
export declare function applyPersonaDrift(store: Store, config: DaughterConfig, persona: PersonaBundle, polarity: number, now: string): {
    changed: boolean;
    evolutionId?: string;
};
/**
 * 技能成熟度累计（§9.1 状态机）：
 * draft 首次成功 → active；连续失败 5 次 → deprecated；其余保持原状态。
 * 走 store.mutateSkill 的读-改-写，避免并发下覆盖对方的累计值。
 */
export declare function bumpSkill(store: Store, skill: SkillCard, success: boolean, config: DaughterConfig, now: string): SkillCard;
/**
 * 从一次成功的工具序列里沉淀技能草稿（§9.1「draft：新学技能」）。
 * 纯启发式：只看工具序列，不调用模型；同样的工具序列只沉淀一次。
 */
export declare function learnDraftSkill(store: Store, config: DaughterConfig, input: {
    userText: string;
    tools: string[];
    now: string;
}): {
    skill: SkillCard;
    evolutionId: string;
} | null;
/** 按技能形态决定固化后的资产类型，与设计文档 4.5 的四类资产对应 */
export declare function classifyAssetKind(skill: SkillCard): AssetKind;
/** 成熟度与成功次数达标后固化为资产包，按技能形态区分 MAC/CON/CMB/MOT */
export declare function maybeFreezeSkill(store: Store, skill: SkillCard, config: DaughterConfig, now: string): {
    frozen: boolean;
    assetId?: string;
    evolutionId?: string;
};
export interface PersonProfile {
    name: string;
    eventCount: number;
    intimacy: number;
    relationship: string;
    trend: '升温' | '降温' | '稳定';
    delta: number;
    firstMet: string;
    lastAt: string;
    self: boolean;
}
/**
 * 人物画像：互动次数 + 亲密度 + 关系变化。
 * 亲密度按事件权重累加并做 14 天半衰期；趋势对比最近 7 天与此前 7 天。
 */
export declare function buildPersonProfiles(store: Store, now: string): PersonProfile[];
export interface ThingProfile {
    label: string;
    eventCount: number;
    /** -1..1：负值偏不喜欢，正值偏喜欢 */
    preference: number;
    mood: '喜欢' | '不喜欢' | '中性';
}
/** 事物喜好：同一主题在事件里的情绪加权平均，14 天半衰期 */
export declare function buildThingProfiles(store: Store, now: string): ThingProfile[];
export declare function buildStarMap(store: Store, now: string): {
    nodes: number;
    edges: number;
    galaxies: number;
};
