import type {
  AssociationHit,
  DaughterConfig,
  EventLink,
  EventRecord,
  L5State,
  PadState,
  RetrievalHit,
} from '../types.js';
import type { PluginContext } from '../types.js';
import type { Store } from '../store.js';
import { clamp01, daysBetween, diceSimilarity, newEventId, padDistance, truncate } from '../util.js';
import { sentimentPolarity } from './state.js';
import { sourceWeightOf } from './filter.js';

const TAG_LEXICON: Array<{ tag: string; words: string[] }> = [
  { tag: '工作', words: ['工作', '项目', '开会', '加班', '需求', '上线'] },
  { tag: '学习', words: ['学习', '考试', '作业', '课', '复习', '论文'] },
  { tag: '情绪', words: ['难过', '烦', '压力', '焦虑', '开心', '累'] },
  { tag: '生活', words: ['吃饭', '睡觉', '起床', '家', '天气', '周末'] },
  { tag: '游戏', words: ['游戏', '打本', '联机', 'Minecraft', '我的世界', '植物大战僵尸'] },
  { tag: '社交', words: ['朋友', '同学', '聊天', '群里', '抖音', 'QQ'] },
  { tag: '约定', words: ['下次', '记得', '答应', '说好', '约定'] },
];

export interface RetrieveArgs {
  characterId: string;
  query: string;
  now: string;
  topK: number;
  currentEmotion: PadState;
  excludeArchived: boolean;
  config: DaughterConfig;
  candidates: EventRecord[];
  /** 可选 FTS5 字面检索（D-02）：query → eventId → 0..1 的匹配分；缺省时只用 Dice */
  ftsScores?: (query: string) => Map<string, number>;
}

/** 单字弱命中分：只保证不被 `min_semantic` 挡掉，排序上仍低于二字以上的真实重合 */
const SINGLE_CHAR_HIT = 0.3;

/**
 * 单字查询（"累""饿"）在 bigram Dice 下恒为 0——两个字符才凑得出一个二元组。
 * 可这类一字问句恰恰是最常见的输入，正文里明明写着却检不到，等于把最该命中的场景漏掉。
 * 这里按"正文包含"补一个弱命中分，归一化口径与 Dice 一致（去空白与标点）。
 */
function singleCharHit(query: string, event: EventRecord): number {
  const q = normalizeQuery(query);
  if ([...q].length !== 1) return 0;
  const haystack = normalizeQuery(`${event.title}${event.summary}${event.tags.join('')}`);
  return haystack.includes(q) ? SINGLE_CHAR_HIT : 0;
}

function normalizeQuery(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

export function retrieveEvents(args: RetrieveArgs): RetrievalHit[] {
  const { query, now, topK, currentEmotion, config } = args;
  const w = config.retrieval.score_weights;
  const fts = args.ftsScores?.(query);

  const scored = args.candidates.map((event) => {
    const dice = Math.max(
      diceSimilarity(query, event.title) * 1.0,
      diceSimilarity(query, event.summary) * 0.95,
      diceSimilarity(query, event.tags.join(' ')) * 0.6,
      singleCharHit(query, event),
    );
    // FTS5 命中优先，Dice 作为短查询与索引不可用时的兜底
    const semantic = Math.max(dice, fts?.get(event.id) ?? 0);
    const recency = 0.5 ** (daysBetween(event.createdAt, now) / Math.max(1, config.retrieval.half_life_days));
    const emotionMatch = 1 - padDistance(currentEmotion, event.emotionAtTime);
    return {
      event,
      semantic,
      recency,
      weight: event.weight,
      emotionMatch,
      linkProximity: 0,
      score: 0,
    };
  });

  const sourceMultiplier = (event: EventRecord): number =>
    config.filter.enabled ? sourceWeightOf(event.source, config) : 1;

  // 基础分先不含链接邻近度：门禁必须过在「没有邻近度加持」的原始分上
  for (const item of scored) {
    const raw =
      w.semantic * item.semantic +
      w.recency * item.recency +
      w.weight * item.weight +
      w.emotion_match * item.emotionMatch;
    // 认知滤网：低可信来源整体降权（窗口标题这类系统事件不该挤掉真人对话）
    item.score = raw * sourceMultiplier(item.event);
  }

  // 命中才叫相关记忆：语义为 0 的候选只是"最近、最重、情绪最像"，
  // 每次都把它塞进相关记忆，联想通道就永远没有位置。
  // 一条都没命中时不在这里硬凑，交给 pickAssociationSeed 从记忆网里挑种子，
  // 由联想块（低优先级、限深限条）把内容带出来。
  const eligible = scored.filter(
    (item) => item.semantic >= config.retrieval.min_semantic && item.score >= config.retrieval.min_score,
  );
  if (eligible.length === 0) return [];

  // 链接邻近度只由「已命中」的事件决定：锚点取门禁后基础分最高的那条。
  // 早期实现锚在按 semantic+weight 排序的全部候选首条，那条可能随后被门禁挡掉，
  // 于是一条根本没注入的记忆也能给其它候选加 0.10 权重。
  const anchor = eligible.reduce((best, item) => (item.score > best.score ? item : best), eligible[0]!);
  for (const item of eligible) {
    if (item.event.id === anchor.event.id) continue;
    if (item.event.links.some((link) => link.targetId === anchor.event.id)) item.linkProximity = 0.6;
    else if (
      anchor.event.links.some((direct) =>
        item.event.links.some((link) => link.targetId === direct.targetId),
      )
    ) {
      item.linkProximity = 0.3;
    }
    item.score += w.link_proximity * item.linkProximity * sourceMultiplier(item.event);
  }

  return eligible
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((item) => ({
      event: item.event,
      score: round(item.score),
      reason: `语义 ${round(item.semantic)} / 近因 ${round(item.recency)} / 权重 ${round(item.weight)} / 情绪 ${round(item.emotionMatch)}`,
    }));
}

/** 种子选择的权重：情绪像不像比近不近更贴近"共鸣"，近因只作次要参考 */
const SEED_EMOTION_WEIGHT = 0.6;
const SEED_RECENCY_WEIGHT = 0.4;

/**
 * 一条字面命中都没有时，从记忆网里挑一个种子往外摸（`fallback_when_no_match`）。
 *
 * 早期实现挑"出边最多"的那条：不管用户说了什么，都从同一段最热闹的记忆顺下去，
 * 当下情绪完全没参与，情绪共鸣（"今天很累"想起上次也很累的那天）就落不了地。
 * 现在先按"情绪像 + 近"排序，出边只作为能否联想的前提——没有出边的种子顺不出东西，
 * 挑它等于白挑，不如不挑，让上层走 `[无记忆约束]`。
 */
export function pickAssociationSeed(
  candidates: EventRecord[],
  currentEmotion: PadState,
  now: string,
  config: DaughterConfig,
): EventRecord | undefined {
  let best: { event: EventRecord; score: number } | undefined;
  for (const event of candidates) {
    if (event.links.length === 0) continue;
    const emotionMatch = 1 - padDistance(currentEmotion, event.emotionAtTime);
    const recency = 0.5 ** (daysBetween(event.createdAt, now) / Math.max(1, config.retrieval.half_life_days));
    const score = SEED_EMOTION_WEIGHT * emotionMatch + SEED_RECENCY_WEIGHT * recency;
    if (!best || score > best.score) best = { event, score };
  }
  return best?.event;
}

/** 边太弱时不配叫联想：真实库里一条事件能挂满 12 条出边，弱边会把 BFS 变成随机游走 */
const MIN_LINK_STRENGTH = 0.2;
/** 多条线索指向同一条记忆时的强化系数：第二次到达只按残值累加，避免刷分 */
const MULTI_PATH_BONUS = 0.25;

/**
 * 沿联想边扩展（BFS）。返回的是"经由哪条边、走了几步、为什么想起"。
 *
 * 两处和早期实现的差异：
 * - 边的遍历按 strength 降序，弱边直接跳过。之前 12 条出边等权遍历，
 *   取前 2 条基本等于随机挑。
 * - 同一目标被多条路径命中时做残值累加：多条线索都指向它，说明这段记忆在
 *   记忆网里更"中心"，分数应当更高，而不是被 visited 直接丢弃。
 */
export function associateEvents(
  seedIds: string[],
  candidates: EventRecord[],
  maxDepth: number,
  maxInjected: number,
  hopDecay: number,
): AssociationHit[] {
  const byId = new Map(candidates.map((event) => [event.id, event]));
  const visited = new Set(seedIds);
  const queue: Array<{ id: string; depth: number; score: number; path: string[] }> = seedIds.map((id) => ({
    id,
    depth: 0,
    score: 1,
    path: [id],
  }));
  const found = new Map<string, AssociationHit>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    const event = byId.get(current.id);
    if (!event) continue;

    const links = [...event.links].sort((a, b) => b.strength - a.strength);
    for (const link of links) {
      if (link.strength < MIN_LINK_STRENGTH) continue;
      const target = byId.get(link.targetId);
      if (!target || target.archived) continue;
      const pathScore = current.score * hopDecay * link.strength;
      const existing = found.get(link.targetId);
      if (existing) {
        existing.score = round(Math.min(1, existing.score + pathScore * MULTI_PATH_BONUS));
        continue;
      }
      if (visited.has(link.targetId)) continue;
      visited.add(link.targetId);
      const hit: AssociationHit = {
        eventId: link.targetId,
        via: link,
        score: round(pathScore),
        depth: current.depth + 1,
        path: [...current.path, link.targetId],
      };
      found.set(link.targetId, hit);
      queue.push({ id: link.targetId, depth: current.depth + 1, score: pathScore, path: hit.path! });
    }
  }

  return [...found.values()].sort((a, b) => b.score - a.score || a.depth! - b.depth!).slice(0, maxInjected);
}

/**
 * 概率联想条目的 reason。调用方据此把它排除出「真实召回」：
 * 随机抽中的事件不能写 recallCount / weight，否则会被忘却扫描当成「被想起过」永久保活。
 */
export const SURPRISE_REASON = '随机联想（可复现）';

/** 概率联想：从最近 30 天的非归档事件中随机挑 1 条，同种子可复现 */
export function applySurprise(
  hits: RetrievalHit[],
  candidates: EventRecord[],
  config: DaughterConfig,
  rng: () => number,
  now: string,
): RetrievalHit[] {
  if (!config.random_surprise_enabled) return hits;
  if (rng() >= config.retrieval.surprise_eta) return hits;

  const recent = candidates.filter(
    (event) => !event.archived && daysBetween(event.createdAt, now) <= 30 && !hits.some((hit) => hit.event.id === event.id),
  );
  if (recent.length === 0) return hits;

  const picked = recent[Math.floor(rng() * recent.length)]!;
  return [
    ...hits,
    { event: picked, score: 0.05, reason: SURPRISE_REASON },
  ].sort((a, b) => b.score - a.score).slice(0, config.retrieval.top_k + 1);
}

/**
 * 回忆重构的最小情绪位移。
 *
 * `padDistance` 满量程是 1（每维差满 2 才凑满），不是早期注释写的 0.5——按 0.5 估，
 * 会把 0.08 误当成"满量程 16%"的宽松门槛。它实际等于"平均每维差 0.16"。
 * 真实库标定：55 条事件两两距离 p50≈0.04、p90≈0.14，约四分之一的召回会过线。
 * 想让回看记录更密就调小 `retrieval.reconstruct_distance`。
 */
const RECONSTRUCT_MIN_DISTANCE = 0.08;

/**
 * 同一条记忆的回看冷却：6 小时内不重复记。
 *
 * 光有距离门槛挡不住高频召回——一轮命中十几条、每条都写一行，两轮就能填满 24 行，
 * 而 `emotionNowHistory` 上限只有 8 条，很快就被合并/挤掉，历史反而变短。
 */
const RECONSTRUCT_COOLDOWN_MINUTES = 360;

/**
 * 当前情绪与这条记忆"上次被想起时的感受"之间的位移。
 * 没有回看记录时以事件发生当下的情绪为基准。
 */
export function recallDrift(event: EventRecord, emotion: PadState): number {
  const last = event.emotionNowHistory[event.emotionNowHistory.length - 1]?.emotion ?? event.emotionAtTime;
  return padDistance(last, emotion);
}

/** 回忆重构：命中事件时按当前情绪追加一条 emotion_now_history，不覆盖 emotion_at_time */
export function reconstructOnRecall(
  store: Store,
  event: EventRecord,
  l5: L5State,
  now: string,
  minDistance = RECONSTRUCT_MIN_DISTANCE,
  cooldownMinutes = RECONSTRUCT_COOLDOWN_MINUTES,
): boolean {
  const lastEntry = event.emotionNowHistory[event.emotionNowHistory.length - 1];
  if (lastEntry && daysBetween(lastEntry.at, now) * 1440 < cooldownMinutes) return false;
  if (recallDrift(event, l5.emotion) < minDistance) return false;

  store.appendEmotionHistory(event.id, {
    at: now,
    emotion: { ...l5.emotion },
    reason: '回忆重构：此刻的感受与当时不同',
  });
  return true;
}

/**
 * 参与者按来源推导。
 *
 * 早期所有事件都写 ['self','user']，可"刷到一条视频""后台切了个窗口"这类单向输入里
 * 根本没有用户参与：社交性项恒为 1 让显著性虚高，人物画像把这些噪声算成"一起做的事"，
 * L2 亲密度的锚点跟着失真——一处口径错，三处下游一起歪。
 * 单机游戏与外部内容暂时只记自己（还没有识别同场玩家的通道）。
 */
export function participantsFor(
  source: EventRecord['source'],
  audience?: 'to_father' | 'to_stranger' | 'alone',
): string[] {
  if (source === 'chat' || source === 'qq' || source === 'douyin_dm') {
    return ['self', audience ?? 'user'];
  }
  return ['self'];
}

export function extractEvent(
  ctx: PluginContext,
  userText: string,
  assistantText: string,
  l5: L5State,
  rng: () => number,
  source: EventRecord['source'] = 'chat',
): EventRecord {
  const tags = TAG_LEXICON.filter((entry) => entry.words.some((word) => userText.includes(word))).map(
    (entry) => entry.tag,
  );
  const polarity = sentimentPolarity(userText);
  const importance = clamp01(0.3 + Math.min(0.3, userText.length / 300) + tags.length * 0.05 + Math.abs(polarity) * 0.1);
  const now = ctx.now();

  return {
    id: newEventId(now, rng),
    characterId: ctx.characterId,
    title: truncate(userText.replace(/\s+/g, ' ').trim(), 24),
    // 摘要层只留压缩版（进索引）；完整问答另存全文层，命中且预算允许时再展开（§4.4）
    summary:
      truncate(userText.replace(/\s+/g, ' ').trim(), 80) +
      (assistantText ? ` → ${truncate(assistantText.replace(/\s+/g, ' ').trim(), 40)}` : ''),
    tags: tags.length > 0 ? tags : ['对话'],
    participants: participantsFor(source, ctx.audience),
    emotionAtTime: {
      ...l5.emotion,
      intensity: clamp01(Math.abs(l5.emotion.pleasure) * 0.6 + l5.stress * 0.4),
    },
    emotionNowHistory: [],
    importance,
    weight: importance,
    links: [],
    source,
    createdAt: now,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
    // 窗口只是"工位"，不是记忆分区；但"刚在别处说的话"要靠它认出来
    sessionId: ctx.sessionId,
    workspaceId: ctx.workspaceId,
  };
}

/**
 * 单条事件的出边上限。
 * 不设上限时，早期热点事件会被后续每轮都连一次，真实库曾出现单事件 607 条出边，
 * `linkProximity` 的 0.6/0.3 于是对所有候选都成立，这个维度彻底失去区分度。
 */
const MAX_LINKS_PER_EVENT = 12;

/**
 * 新事件入库后，与最近的相似事件建立弱链接（双向，最多 maxLinks 条）。
 * 相似度 = 共享标签 + 共享人物 ×0.5 + 7 天内 ×0.2。
 */
export function linkNewEvent(store: Store, event: EventRecord, maxLinks = 3): number {
  if (event.links.length >= MAX_LINKS_PER_EVENT) return 0;
  const candidates = store.listAllEvents().filter(
    (candidate) =>
      candidate.id !== event.id &&
      !candidate.archived &&
      candidate.links.length < MAX_LINKS_PER_EVENT,
  );
  const scored = candidates
    .map((candidate) => {
      const sharedTags = candidate.tags.filter((tag) => event.tags.includes(tag)).length;
      const sharedPeople = candidate.participants.filter(
        (person) => person && event.participants.includes(person),
      ).length;
      const recent = daysBetween(candidate.createdAt, event.createdAt) <= 7 ? 1 : 0;
      const score = sharedTags + sharedPeople * 0.5 + recent * 0.2;
      const kind: EventLink['kind'] = sharedTags > 0 ? 'topic' : 'person';
      return { candidate, score, kind };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(maxLinks, MAX_LINKS_PER_EVENT - event.links.length));

  let created = 0;
  for (const { candidate, score, kind } of scored) {
    const strength = Math.min(1, score / 3);
    if (!event.links.some((link) => link.targetId === candidate.id)) {
      const forward: EventLink = { targetId: candidate.id, kind, strength };
      event.links.push(forward);
      store.updateEventMutable(event.id, { links: event.links });
      created += 1;
    }
    if (!candidate.links.some((link) => link.targetId === event.id)) {
      store.updateEventMutable(candidate.id, {
        links: [...candidate.links, { targetId: event.id, kind, strength }],
      });
    }
  }
  return created;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
