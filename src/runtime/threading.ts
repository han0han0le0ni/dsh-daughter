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

import { diceSimilarity, truncate } from '../util.js';
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

const DIALOGUE_SOURCES = new Set(['chat', 'qq', 'douyin_dm']);

/** 没有 session_id 的存量事件共用这一格：它们没法按窗口分开，只能按时间连 */
const LEGACY_WINDOW = '__legacy__';

/** 只有对话类来源才算"局"：刷到的视频（douyin_content）不该进来开一局 */
export function isDialogueSource(source: EventRecord['source']): boolean {
  return DIALOGUE_SOURCES.has(source);
}

/**
 * 用户自己起局名：「这局叫 X」「给这局起名 X」「把这局改成 Y」。
 * 只认明确的命名句式；「这局聊什么」「这局是不是该收了」不会被误判。
 */
export function extractThreadName(text: string): string | null {
  if (!text) return null;
  const match =
    /(?:这局|这一局|这个局|当前这局)(?:的名字)?(?:叫做|叫作|叫|改成|改为|命名为|名字是|起名(?:叫|为)?|取名(?:叫|为)?)\s*[：:]?\s*[「『"'《]?([^」』"'》\s，,。.！!？?；;：:]{1,20})[」』"'》]?/u.exec(
      text,
    );
  const name = match?.[1]?.trim();
  return name ? truncate(name, 20) : null;
}

/** 口语里这些词天天出现，靠它们认局会认错，先抠掉再比 */
const FILLER_RUNS = [
  '我觉得',
  '不知道',
  '怎么办',
  '是不是',
  '你们',
  '我们',
  '你好',
  '哈哈',
  '这个',
  '那个',
  '可以',
  '然后',
  '就是',
  '其实',
  '应该',
  '什么',
  '怎么',
  '为什么',
  '现在',
  '之后',
  '还是',
  '真的',
  '有点',
  '一下',
];

function scrubFillers(text: string): string {
  let out = text;
  for (const filler of FILLER_RUNS) out = out.split(filler).join('｜');
  return out;
}

/** 两句话最长的连续共同片段：同一个活动往往就靠一个词认出来（"捉迷藏"） */
function longestCommonRun(a: string, b: string): number {
  let best = 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  const curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : 0;
      if ((curr[j] ?? 0) > best) best = curr[j] ?? 0;
    }
    for (let j = 0; j <= b.length; j += 1) {
      prev[j] = curr[j] ?? 0;
      curr[j] = 0;
    }
  }
  return best;
}

/**
 * 两句是不是在说同一件事。
 *
 * Dice 比的是整句像不像，而"换个说法接着聊"恰恰是整句不像、只有一个词重叠：
 * "玩捉迷藏，猜猜我在哪" vs "捉迷藏呀，忘记了吗？我卡在看不见" 的 Dice 只有 0.12，
 * 于是同一局被拆成两局、每局都只剩一轮。口语里认的是那个词，不是整句。
 */
function sameTopicScore(a: string, b: string): number {
  const dice = diceSimilarity(a, b);
  if (longestCommonRun(scrubFillers(a), scrubFillers(b)) >= 3) return Math.max(dice, 0.3);
  return dice;
}

/**
 * 对方说了收尾的话（"先这样""不玩了""睡了"）：这一局到此为止。
 * 不靠模型判断，只认配置里的几个说法——判错了也只是少挂一局，不会丢记忆。
 */
export function isClosingUtterance(text: string, config: DaughterConfig): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const phrases = config.threading.closing_phrases ?? [];
  return phrases.some((phrase) => Boolean(phrase) && normalized.includes(phrase));
}

/** 给新事件找归属：能接上某个进行中的局就接，接不上就开新局 */
export function assignThread(
  event: EventRecord,
  open: ThreadHead[],
  config: DaughterConfig,
  /** 这一轮的原话：只看标题会被截到 24 字，接不上"卡在哪" */
  quote?: string,
): { threadId: string; heads: ThreadHead[] } {
  const threading = config.threading;
  const createdMs = Date.parse(event.createdAt);
  // 已经收尾的局不再接新话：说了"先这样"，五分钟后的同题发言是新的一局
  const active = open.filter((head) => head.status !== 'closed');

  const ranked = active
    .filter((head) => createdMs - Date.parse(head.lastTurnAt) <= threading.gap_minutes * 60_000)
    .map((head) => ({
      head,
      // 跟这一局的每一轮比，不只跟最近一句：换了三轮说法之后，最早的局名往往还认得出来
      sim: Math.max(
        ...head.recentEvents.map((turn) => sameTopicScore(event.title, turn.title)),
        sameTopicScore(event.title, head.label),
      ),
    }))
    .filter((candidate) => candidate.sim >= threading.similarity)
    .sort((a, b) => b.sim - a.sim);

  // 同一个窗口里隔得很近的连续发言，不看话题也并成一局：
  // "这一段在干什么"本来就是连续的，话题归并会把一句随口的话拆成一个空壳局。
  // 老事件没有 session_id（那时还没盖戳）：它们同属"旧窗口"这一格，
  // 仍然按时间间隔连成一段——否则回填出来全是单轮的碎片。
  const sameWindowMinutes = threading.same_window_minutes ?? 0;
  const windowKey = (sessionId?: string): string => sessionId ?? LEGACY_WINDOW;
  const nearby =
    sameWindowMinutes > 0
      ? active
          .filter((head) => windowKey(head.lastSessionId) === windowKey(event.sessionId))
          .filter((head) => createdMs - Date.parse(head.lastTurnAt) <= sameWindowMinutes * 60_000)
          .sort((a, b) => Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt))[0]
      : undefined;

  const entry: ThreadTurn = {
    at: event.createdAt,
    title: event.title,
    summary: event.summary,
    quote: quote?.trim() ? truncate(quote.trim(), 40) : undefined,
    sessionId: event.sessionId,
  };
  const closing = isClosingUtterance(quote ?? event.title, config);

  // 用户自己起局名：这一轮仍然算进局里，但标题换成他给的名字
  const named = quote ? extractThreadName(quote) : null;

  const target = nearby ?? ranked[0]?.head;
  if (target) {
    const head = target;
    const crossed = Boolean(event.sessionId && head.lastSessionId && event.sessionId !== head.lastSessionId);
    const next: ThreadHead = {
      ...head,
      lastTurnAt: event.createdAt,
      turnCount: head.turnCount + 1,
      windowCount: head.windowCount + (crossed ? 1 : 0),
      lastSessionId: event.sessionId ?? head.lastSessionId,
      recentTitle: event.title,
      recentEvents: [...head.recentEvents, entry].slice(-threading.max_summary_turns),
    };
    if (named) {
      next.label = named;
      next.labelByUser = true;
    }
    if (closing) {
      next.status = 'closed';
      next.closedAt = event.createdAt;
      next.closedReason = '对方说了收尾的话';
    }
    return { threadId: head.id, heads: open.map((item) => (item.id === head.id ? next : item)) };
  }

  // 新局：id 用时间戳 + 序号，跨天也不撞；序号只求同一批 open 里不重复
  const stamp = event.createdAt.replace(/\D/g, '').slice(0, 14);
  const head: ThreadHead = {
    id: `THR-${stamp}-${String(open.length + 1).padStart(2, '0')}`,
    label: named ?? truncate(event.title, 20),
    labelByUser: Boolean(named),
    startedAt: event.createdAt,
    lastTurnAt: event.createdAt,
    turnCount: 1,
    windowCount: 1,
    lastSessionId: event.sessionId,
    recentTitle: event.title,
    status: closing ? 'closed' : 'open',
    closedAt: closing ? event.createdAt : undefined,
    closedReason: closing ? '对方说了收尾的话' : undefined,
    recentEvents: [entry],
  };
  return { threadId: head.id, heads: [...open, head] };
}

/**
 * 门的开合：
 * - 开着但超过 ttl 没动静的，标成"已结束（一直没动静）"：不删，留个落脚处，
 *   但明说它已经过去了，别再当成进行中的事往下推；
 * - 说了收尾话的局同样标"已结束"，让"结了没"能写出来；
 * - 已结束的局再留 `retentionMinutes`（默认 24 小时）才彻底出寄存器，
 *   免得越攒越多、开头三分之一全是旧账；
 * - 开着的排前面，避免一条"已结束"挤掉真正进行中的那一局。
 */
export function pruneOpenThreads(
  heads: ThreadHead[],
  now: string,
  ttlMinutes: number,
  max = 6,
  retentionMinutes = 1440,
): ThreadHead[] {
  const nowMs = Date.parse(now);
  const within = (at: string, minutes: number): boolean => {
    const ms = Date.parse(at);
    return Number.isFinite(ms) && nowMs - ms <= minutes * 60_000;
  };

  const marked = heads.map((head) =>
    head.status !== 'closed' && !within(head.lastTurnAt, ttlMinutes)
      ? { ...head, status: 'closed' as const, closedAt: head.lastTurnAt, closedReason: '一直没动静' }
      : head,
  );

  return marked
    .filter((head) =>
      head.status === 'closed'
        ? within(head.closedAt ?? head.lastTurnAt, retentionMinutes)
        : within(head.lastTurnAt, ttlMinutes),
    )
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      return Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt);
    })
    .slice(0, max);
}
