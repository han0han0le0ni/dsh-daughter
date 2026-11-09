/**
 * "局"（进行中的活动）归并。
 *
 * 记忆是按"轮"存的：一局捉迷藏跨三个窗口、四条事件，每条还被截断成摘要，
 * 换到新窗口只能看到其中一条的残迹，于是"两个窗口的我像共用一本笔记、各写一页"。
 * 这里在写入侧把"时间相邻 + 话题相似"的事件归并成一个 thread，
 * 注入时给这一局的前情摘要，让两个窗口看到的是同一局。
 *
 * 纯规则、不调模型：时间间隔 + 话题判定（整句 Dice 或共享一个词）+ 收尾话术，
 * 跨窗口不隔离（窗口只是工位）。
 */
import type { DaughterConfig, EventRecord } from '../types.js';
/** 一局是开着还是已经收了尾：收尾的局只再交代一两轮，然后从寄存器里消失 */
export type ThreadStatus = 'open' | 'closed';
/**
 * 一局里的一条。
 * `quote` 是当时的原话（已截断）：摘要记的是话题，"卡在我看不见，等她给线索"
 * 这种才是下次能接上的地方，所以原话要单独留一份。
 */
export interface ThreadTurn {
    at: string;
    title: string;
    summary: string;
    quote?: string;
    sessionId?: string;
}
/** 一个 thread 的头部索引，只存最近几轮，够注入"前情"即可 */
export interface ThreadHead {
    id: string;
    /** 一局的名称：默认取开局事件标题，也可由用户说「这局叫 X」手动命名 */
    label: string;
    /** 名字是用户起的，不是自动截出来的 */
    labelByUser?: boolean;
    startedAt: string;
    lastTurnAt: string;
    turnCount: number;
    /** 跨了几个对话窗口 */
    windowCount: number;
    lastSessionId?: string;
    /** 用于相似度比对的最近标题 */
    recentTitle: string;
    /** 开着 / 已收尾：旧局不能一直挂着，"结了没"要能写出来 */
    status: ThreadStatus;
    closedAt?: string;
    closedReason?: string;
    recentEvents: ThreadTurn[];
}
/** 只有对话类来源才算"局"：刷到的视频（douyin_content）不该进来开一局 */
export declare function isDialogueSource(source: EventRecord['source']): boolean;
/**
 * 用户自己起局名：「这局叫 X」「给这局起名 X」「把这局改成 Y」。
 * 只认明确的命名句式；「这局聊什么」「这局是不是该收了」不会被误判。
 */
export declare function extractThreadName(text: string): string | null;
/**
 * 对方说了收尾的话（"先这样""不玩了""睡了"）：这一局到此为止。
 * 不靠模型判断，只认配置里的几个说法——判错了也只是少挂一局，不会丢记忆。
 */
export declare function isClosingUtterance(text: string, config: DaughterConfig): boolean;
/** 给新事件找归属：能接上某个进行中的局就接，接不上就开新局 */
export declare function assignThread(event: EventRecord, open: ThreadHead[], config: DaughterConfig, 
/** 这一轮的原话：只看标题会被截到 24 字，接不上"卡在哪" */
quote?: string): {
    threadId: string;
    heads: ThreadHead[];
};
/**
 * 门的开合：
 * - 开着但超过 ttl 没动静的，标成"已结束（一直没动静）"：不删，留个落脚处，
 *   但明说它已经过去了，别再当成进行中的事往下推；
 * - 说了收尾话的局同样标"已结束"，让"结了没"能写出来；
 * - 已结束的局再留 `retentionMinutes`（默认 24 小时）才彻底出寄存器，
 *   免得越攒越多、开头三分之一全是旧账；
 * - 开着的排前面，避免一条"已结束"挤掉真正进行中的那一局。
 */
export declare function pruneOpenThreads(heads: ThreadHead[], now: string, ttlMinutes: number, max?: number, retentionMinutes?: number): ThreadHead[];
