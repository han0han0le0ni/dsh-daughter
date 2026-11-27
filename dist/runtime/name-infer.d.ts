/**
 * 从旧记忆里补名字。
 *
 * 背景：角色卡是后来才加的，之前主人给过的名字只存在对话记忆里。
 * 这里用几条高精度句式从事件里捞候选，要求至少出现两次才认，
 * 宁可空着也不把「什么名字」这种问句当成名字。
 */
import { type PersonaCard } from './persona-card.js';
export interface NameEvent {
    title: string;
    summary: string;
    createdAt: string;
    archived?: boolean;
}
/** 返回出现次数最多且至少两次的候选；同票取最近出现的 */
export declare function inferNameFromEvents(events: NameEvent[]): string;
/**
 * 角色卡没有名字时，从记忆里补一个并落盘；已有名字就原样返回。
 * 调用方负责控制「只在没有名字时跑一次」，避免每轮扫全库。
 */
export declare function adoptNameFromMemory(dataRoot: string, events: NameEvent[]): PersonaCard;
