import type { BondEmotion, EmotionMix, L2Relationship, L5State, PadState, PluginContext } from '../types.js';
import type { SentimentDetail } from './state.js';
/** 旧快照没有心情向量时，从 PAD 做一次保守投影；这只是兼容入口，不替代共存成分 */
export declare function mixFromPad(pad: PadState): EmotionMix;
/** 跨会话/闲置回落：所有成分独立向基线靠拢，不做归一化，也不抹掉共存关系 */
export declare function relaxEmotionMix(previous: EmotionMix, baseline: EmotionMix, ratio: number): EmotionMix;
/** 一轮对话只衰减 10%，新成分独立叠加：先说开心、再讲难过，两种心情都还在 */
export declare function updateEmotionMix(previous: EmotionMix, detail: SentimentDetail, exclamatory: boolean): EmotionMix;
/** 没有对象级存档时，由既有 L2 关系基线推导；不写盘也能让旧角色立刻使用 */
export declare function bondFromL2(l2: L2Relationship, now: string): BondEmotion;
/** 当前宿主只给出对话对象类型：主人与陌生人分开记，独处时不注入对人情感 */
export declare function bondForAudience(l2: L2Relationship, audience: PluginContext['audience'], now: string): BondEmotion | undefined;
/**
 * 对人的情感是慢变量：一次争吵会留下委屈和怨意，但只轻微碰亲近。
 * 后续示好能修复信任，却不会把旧伤直接清零，因此"还在乎，也还在生气"可以持续存在。
 * 没有有效情绪词时返回原对象，调用方据此避免无意义写盘。
 */
export declare function updateBondEmotion(previous: BondEmotion, detail: SentimentDetail, now: string): BondEmotion;
/**
 * 把"心情 × 对人情感"翻成语气和说话方式。
 * 冲突成分必须并列写出，否则模型很容易把高亲近 + 高怨意误读成中性。
 */
export declare function buildAffectHint(l5: L5State, bond?: BondEmotion): string;
