import type {
  DaughterConfig,
  EventRecord,
  L5State,
  MoralOutlook,
  PersonaBundle,
  PromptBlock,
  ReflexAction,
  ReflexRule,
  RetrievalHit,
  SafetyVerdict,
  SkillActivation,
  SkillCard,
  SubPersona,
  WindowNamer,
} from '../types.js';
import type { PersonProfile, ThingProfile } from './maintenance.js';
import type { ThreadHead } from './threading.js';
import { scoreSkills, type MotivationContext } from './motivation.js';
import {
  MOOD_ANCHORS,
  STAGE_ANCHORS,
  distribute,
  formatWeights,
  labelWeight,
  poleWeight,
  progress,
  topLabels,
  type WeightedLabel,
} from './weights.js';
import { clamp01, diceSimilarity, estimateTokens, formatTimestamp, relativeTime, truncate, windowName } from '../util.js';

/* -------------------------------- 人格小段 -------------------------------- */

/** 做任务时的说话节奏：不让模型在连续工具调用中保持沉默。 */
export const WORKING_STYLE = [
  '[边做边说]',
  '做任务时不要沉默：动手前用一句不超过 25 字的话说明你要做什么，看到结果后用一句说发现或下一步。',
  '像坐在对方旁边一起盯着屏幕，不要念工具名、参数和坐标。',
  '一次只交代一步，不要一次说完整个计划。',
].join('\n');

/**
 * 五维性格的两极措辞。判断只用 0.50 分个方向，强度交给 `poleWeight`：
 * 0.86 是"对新东西好奇 0.72"，0.52 只有 0.04，说不出口就不说，避免把噪声写成性格。
 */
const TRAIT_POLES = [
  { key: 'extraversion', high: '愿意主动说话', low: '话不多，先观察' },
  { key: 'agreeableness', high: '不太会拒绝', low: '该拒绝时会拒绝' },
  { key: 'neuroticism', high: '容易反复想', low: '情绪不太起浪' },
  { key: 'openness', high: '对新东西好奇', low: '更信熟悉的做法' },
  { key: 'conscientiousness', high: '按部就班', low: '想到哪做到哪' },
] as const;

/** 性格权重：各维独立强度（0.00–1.00，两位小数），取最强三档，彼此不归一 */
export function traitWeights(bigFive: PersonaBundle['l1']['bigFive']): WeightedLabel[] {
  return TRAIT_POLES.map((pole) => {
    const value = bigFive[pole.key];
    return { label: value >= 0.5 ? pole.high : pole.low, weight: poleWeight(value) };
  })
    .filter((trait) => trait.weight >= 0.3)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);
}

/** 关系：主档按已存阶段（回退有迟滞），括号里给权重，顺带说在往哪一档走 */
export function stageLine(l2: PersonaBundle['l2']): string {
  const weights = progress(l2.relationshipDepth, STAGE_ANCHORS, l2.relationshipStage);
  const current = weights[0];
  if (!current) return '还在认识';
  const next = weights[1];
  // 权重放在括号里当读数：它是描述关系的量，不该喧宾夺主盖过"已经比较熟"这几个字
  const head = `${stageWord(current.label)}（${current.weight.toFixed(2)}）`;
  if (!next || next.weight <= 0) return head;
  return `${head}，正在往"${stageWord(next.label)}"走（${next.weight.toFixed(2)}）`;
}

export function buildPersonaText(persona: PersonaBundle, sub: SubPersona): string {
  const traits = traitWeights(persona.l1.bigFive)
    .map((trait) => `${trait.label}（${trait.weight.toFixed(2)}）`)
    .join('，');
  const base = traits.length > 0 ? `${temperamentWord(persona.l1.temperament)}，${traits}` : temperamentWord(persona.l1.temperament);

  return [
    `你是一个有稳定底色的存在：${base}。`,
    `和对方的关系：${stageLine(persona.l2)}，信任还在慢慢建立。`,
    `此刻面对对方的方式：${sub.tone}。`,
    sub.boundaries.length > 0 ? `不主动提起：${sub.boundaries.join('、')}。` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 关系与偏好注入：把人物画像（亲密度/关系变化）、事物喜好、善恶观压缩成几行。
 * 星图与 prompt 共用同一套计算，避免两处口径不一致。
 *
 * 偏好行不再静默消失：没有明确喜恶时退成"最近常聊"，把她攒下来的相处量说出来——
 * 主档叫"中性"不等于这段关系没内容，只是还没长出喜恶。
 */
export function buildRelationText(input: {
  person?: PersonProfile;
  things: ThingProfile[];
  moral: MoralOutlook;
}): string {
  const lines: string[] = [];
  if (input.person) {
    lines.push(
      `和对方的关系：${input.person.relationship}（亲密度 ${Math.round(input.person.intimacy * 100)}%），最近${input.person.trend}。`,
    );
  }

  // 判"明确"用两档合计（喜欢 + 很喜欢 ≥ 0.60），写出去用最强那一档的自身权重，
  // 免得把"喜欢 0.80 + 很喜欢 0.20"报成"1.00"，读起来像满分好评
  const likes_ = ['喜欢', '很喜欢'];
  const dislikes_ = ['不喜欢', '很不喜欢'];
  const strongest = (moods: WeightedLabel[], labels: string[]): WeightedLabel =>
    topLabels(moods.filter((item) => labels.includes(item.label)), 1)[0] ?? { label: '', weight: 0 };
  const scored = input.things.map((thing) => {
    const positive = strongest(thing.moods, likes_);
    const negative = strongest(thing.moods, dislikes_);
    return {
      label: thing.label,
      eventCount: thing.eventCount,
      liked: labelWeight(thing.moods, likes_),
      disliked: labelWeight(thing.moods, dislikes_),
      likedWord: positive.label,
      likedWeight: positive.weight,
      dislikedWord: negative.label,
      dislikedWeight: negative.weight,
    };
  });
  const likes = scored.filter((thing) => thing.liked >= 0.6).sort((a, b) => b.liked - a.liked).slice(0, 3);
  const dislikes = scored.filter((thing) => thing.disliked >= 0.6).sort((a, b) => b.disliked - a.disliked).slice(0, 3);
  const named = new Set([...likes, ...dislikes].map((thing) => thing.label));
  const chats = scored
    .filter((thing) => !named.has(thing.label))
    .sort((a, b) => b.eventCount - a.eventCount)
    .slice(0, 3);

  if (input.things.length > 0) {
    const parts: string[] = [];
    // 写成「项目 喜欢 0.80」：主题在前、档位在后，一句话就能看出是哪一档在起作用
    if (likes.length > 0) {
      parts.push(likes.map((thing) => `${thing.label} ${thing.likedWord} ${thing.likedWeight.toFixed(2)}`).join('、'));
    }
    if (dislikes.length > 0) {
      parts.push(
        dislikes.map((thing) => `${thing.label} ${thing.dislikedWord} ${thing.dislikedWeight.toFixed(2)}`).join('、'),
      );
    }
    if (parts.length === 0) parts.push('暂时没有明确的喜恶');
    if (chats.length > 0) {
      parts.push(`最近常聊 ${chats.map((thing) => `${thing.label}（${thing.eventCount} 次）`).join('、')}`);
    }
    lines.push(`对方的偏好：${parts.join('；')}。`);
  }
  lines.push(`善恶观：${input.moral.stance}；红线：${input.moral.redLines.join('、')}。`);
  return lines.join('\n');
}

function temperamentWord(temperament: PersonaBundle['l1']['temperament']): string {
  switch (temperament) {
    case 'slow_warmup':
      return '慢热，先观察再回应';
    case 'eager':
      return '容易兴奋，回应快';
    case 'steady':
      return '稳定，不急不慢';
    case 'guarded':
      return '有防备，话留三分';
    default:
      return '安静';
  }
}

function stageWord(stage: string): string {
  switch (stage) {
    case 'stranger':
      return '还不熟悉';
    case 'acquaintance':
      return '认识不久';
    case 'familiar':
      return '已经比较熟';
    case 'close':
      return '关系亲近';
    case 'dependent':
      return '很依赖对方';
    default:
      return '还在认识';
  }
}

/* -------------------------------- 状态提示 -------------------------------- */

export function buildStateHint(l5: L5State, verdict: SafetyVerdict): string {
  // 心情摊成五档分布：pleasure 0.30 是"轻快 0.93、高涨 0.07"，不是非黑即白地贴一个词
  const moods = formatWeights(topLabels(distribute(l5.emotion.pleasure, MOOD_ANCHORS), 2), { min: 0.1 });
  const stress = l5.stress > 0.6 ? '偏高' : l5.stress > 0.3 ? '有一些' : '很低';
  const safety = l5.safety > 0.6 ? '较稳' : l5.safety > 0.35 ? '一般' : '偏低';
  const fatigue = l5.fatigue > 0.7 ? '明显' : l5.fatigue > 0.35 ? '有一些' : '不明显';

  const lines = [`情绪：${moods || '平静 1.00'}；压力${stress}，安全感${safety}，疲劳${fatigue}。`];
  if (verdict.level >= 1) lines.push('表达幅度收一些，不主动展开。');
  if (verdict.level >= 3) lines.push('现在只说必要的话。');
  return lines.join('\n');
}

/* -------------------------------- 技能激活 -------------------------------- */

/**
 * 技能激活：动机决策层的入口。
 * 默认走动机评分（人格/情绪调阈值，熟悉度/记忆/情境调分数）；
 * motivation.enabled=false 时退回旧的相似度打分，保证可随时对照。
 */
export function activateSkills(
  skills: SkillCard[],
  userText: string,
  config: DaughterConfig,
  ctx: MotivationContext = {},
): SkillActivation {
  if (!config.motivation.enabled) return activateBySimilarity(skills, userText, config);

  const scored = scoreSkills(skills, userText, config, ctx);
  const main = scored.find((item) => item.breakdown.decision === 'act');
  const associated = scored
    .filter(
      (item) =>
        item.skill.id !== main?.skill.id &&
        item.breakdown.decision !== 'avoid' &&
        item.breakdown.score >= config.skills.min_associated_score,
    )
    .slice(0, config.skills.max_associated)
    .map((item) => item.skill);

  return {
    main: main?.skill,
    associated,
    confidence: main?.breakdown.score ?? 0,
    breakdown: scored.map((item) => item.breakdown),
  };
}

/** 旧版打分：只按文本相似度 + 关键词命中，不含人格与状态 */
function activateBySimilarity(skills: SkillCard[], userText: string, config: DaughterConfig): SkillActivation {
  const scored = skills
    // draft 也参与激活（§9.1「可执行，需确认」），deprecated 永不激活
    .filter((skill) => skill.status === 'active' || skill.status === 'frozen' || skill.status === 'draft')
    .map((skill) => {
      const keywordHits = skill.keywords.filter((keyword) => keyword && userText.includes(keyword)).length;
      const similarity = diceSimilarity(userText, `${skill.name} ${skill.intent} ${skill.keywords.join(' ')}`);
      // 草稿是刚沉淀的，证据不足，打分打八折
      const penalty = skill.status === 'draft' ? 0.8 : 1;
      return { skill, confidence: clamp01((similarity + keywordHits * 0.2) * penalty) };
    })
    .sort((a, b) => b.confidence - a.confidence);

  const main = scored.find((item) => item.confidence >= config.skills.min_main_score);
  const associated = scored
    .filter((item) => item.skill.id !== main?.skill.id && item.confidence >= config.skills.min_associated_score)
    .slice(0, config.skills.max_associated)
    .map((item) => item.skill);

  return {
    main: main?.skill,
    associated,
    confidence: main?.confidence ?? 0,
  };
}

/* -------------------------------- 条件反射 -------------------------------- */

export function matchReflex(
  rules: ReflexRule[],
  userText: string,
  l5: L5State,
  lastFired: Record<string, string>,
  now: string,
  config: DaughterConfig,
  source?: EventRecord['source'],
): { rule: ReflexRule; action: ReflexAction } | null {
  if (!config.reflex.enabled) return null;

  const ordered = [...rules].filter((rule) => rule.enabled).sort((a, b) => b.priority - a.priority);
  for (const rule of ordered) {
    const firedAt = lastFired[rule.id] ?? rule.lastFiredAt;
    if (firedAt && Date.parse(now) - Date.parse(firedAt) < rule.cooldownMs) continue;
    if (!matches(rule, userText, l5, source)) continue;
    return { rule, action: rule.action };
  }
  return null;
}

/**
 * 反射规则归一化：旧版 rules.yaml 可能没有 enabled / priority / cooldownMs，
 * 直接按原值使用会让 `if (!rule.enabled)` 把所有规则当成停用。这里补齐默认值。
 */
export function normalizeReflexRule(raw: unknown): ReflexRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const match = input.match as Record<string, unknown> | undefined;
  const action = input.action as Record<string, unknown> | undefined;
  if (!id || !match || !action) return null;
  if (typeof match.type !== 'string' || typeof action.kind !== 'string') return null;
  if (match.type === 'keyword' && !Array.isArray(match.patterns)) return null;
  if (match.type === 'regex' && typeof match.pattern !== 'string') return null;

  return {
    ...(input as unknown as ReflexRule),
    id,
    enabled: input.enabled !== false,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
    cooldownMs: Number.isFinite(Number(input.cooldownMs)) ? Math.max(0, Number(input.cooldownMs)) : 0,
  };
}

/** §9.2「加载时把 regex 编译为匹配器」：按 pattern 缓存，编译失败也缓存，避免每轮重复抛错 */
const REGEX_CACHE = new Map<string, RegExp | null>();

function compileRegex(pattern: string): RegExp | null {
  if (REGEX_CACHE.has(pattern)) return REGEX_CACHE.get(pattern)!;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(pattern, 'u');
  } catch {
    compiled = null;
  }
  REGEX_CACHE.set(pattern, compiled);
  return compiled;
}

function matches(rule: ReflexRule, userText: string, l5: L5State, source?: EventRecord['source']): boolean {
  const match = rule.match;
  switch (match.type) {
    case 'keyword':
      return match.patterns.some((pattern) => pattern && userText.includes(pattern));
    case 'regex': {
      const compiled = compileRegex(match.pattern);
      return compiled !== null && compiled.test(userText);
    }
    case 'state':
      // 压力/疲劳按「达到阈值」判定，安全感按「低于阈值」判定，与 §10.1 的档位语义一致
      return Object.entries(match.predicate).every(([key, value]) => {
        const current = l5[key as 'stress' | 'safety' | 'fatigue'];
        if (typeof value !== 'number' || typeof current !== 'number') return false;
        return key === 'safety' ? current <= value : current >= value;
      });
    case 'event':
      return source !== undefined && match.source === source;
    default:
      return false;
  }
}

/* -------------------------------- 注入与预算 -------------------------------- */

/**
 * 事件摘要块。命中事件若在全文层有更完整的记录（§4.4），
 * 且调用方已按预算取出摘录，就拼在同一行末尾，避免多占行数影响裁剪顺序。
 *
 * 每行带一个相对时间（"3 小时前"/"昨天"）：没有这个锚，模型分不清是刚才还是上个月，
 * `now` 缺省时不显示，便于只关心内容的调用方与测试。
 */
export function buildEventDigest(
  hits: RetrievalHit[],
  excerpts?: Map<string, string>,
  now?: string,
  currentSessionId?: string,
  /** 窗口名字的来源：生产环境传落库的编号（窗1/窗2），缺省用稳定短哈希 */
  namer: WindowNamer = windowName,
): string {
  if (hits.length === 0) return '';
  const lines = hits.map((hit) => {
    const when = now ? relativeTime(hit.event.createdAt, now) : '';
    // 检索是按人查的，命中可能来自任何窗口：不是这儿的就标出是哪个窗，
    // 否则两边的话混在一列里，分不清哪句是自己刚说的
    const fromElsewhere = Boolean(hit.event.sessionId && currentSessionId && hit.event.sessionId !== currentSessionId);
    const place = hit.window
      ? `${fromElsewhere ? '别处' : '这儿'}·${hit.window}｜`
      : fromElsewhere && hit.event.sessionId
        ? `别处·${namer(hit.event.sessionId)}｜`
        : hit.reason.includes('跨窗口')
          ? '别处｜'
          : '';
    const stamp = `${place}${when ? `${when}｜` : ''}`;
    const base = `- 【${hit.event.id}】${stamp}${truncate(hit.event.title, 24)}｜${truncate(hit.event.summary, 70)}`;
    const excerpt = excerpts?.get(hit.event.id);
    return excerpt ? `${base}｜摘录：${excerpt}` : base;
  });
  return `[相关记忆]\n${lines.join('\n')}`;
}

/**
 * 跨窗口轨道：单独一块、独立预算，不跟"当前话题检索"混在同一块里。
 * 这样它不受当前窗口上下文影响——无论这边聊什么、检索出多少，这一块都在。
 *
 * 每行都标"别处·窗XX"，块头写清这边是哪个窗：不给名字时，本窗口刚说的话
 * 会被当成别处的，模型就开始对着自己的回声往下推。
 */
export function buildCrossWindowDigest(
  hits: RetrievalHit[],
  now?: string,
  currentSessionId?: string,
  namer: WindowNamer = windowName,
): string {
  if (hits.length === 0) return '';
  const lines = hits.map((hit) => {
    // 绝对时间戳在前（10:00 / 11-06 23:00），相对时间跟在括号里——两条窗口之间靠时钟排成一条线
    const clock = now ? formatTimestamp(hit.event.createdAt, now) : '';
    const ago = now ? relativeTime(hit.event.createdAt, now) : '';
    const stamp = [clock, ago ? `（${ago}）` : ''].filter(Boolean).join('');
    const place = `别处·${hit.window ?? namer(hit.event.sessionId)}`;
    return `- ${place}｜${stamp ? `${stamp}｜` : ''}${truncate(hit.event.title, 24)}｜${truncate(hit.event.summary, 60)}`;
  });
  const header = currentSessionId ? `[另一个窗口] 这边是「${namer(currentSessionId)}」，下面都是别处说的` : '[另一个窗口]';
  return `${header}\n${lines.join('\n')}`;
}

/**
 * "局"前情摘要：把同一局跨窗口、跨轮的几条事件合成一行，让两个窗口看到的是同一局，
 * 而不是各捡一条残迹。只给结构（几轮、跨几个窗口、最后一句原话）与开合状态，
 * 不塞整局全文——"卡在我看不见，等她给线索"这种原话才是下次能接上的地方。
 */
export function buildThreadDigest(
  heads: ThreadHead[],
  now?: string,
  currentSessionId?: string,
  namer: WindowNamer = windowName,
): string {
  if (heads.length === 0) return '';
  const lines = heads.map((head) => {
    const start = now ? formatTimestamp(head.startedAt, now) : '';
    const last = head.recentEvents[head.recentEvents.length - 1];
    const state = head.status === 'closed' ? `已结束（${head.closedReason ?? '收尾了'}）` : '还开着';
    const meta = [start ? `${start} 开始` : '', `${head.turnCount} 轮、跨 ${head.windowCount} 个窗口`, state]
      .filter(Boolean)
      .join('；');

    // 最后一句原话：标清是这儿还是别处说的，免得把自己的话当成对方的
    const said = last ? truncate(last.quote ?? last.summary, 40) : '';
    const where = last?.sessionId && currentSessionId
      ? last.sessionId === currentSessionId
        ? `这儿·${namer(currentSessionId)}`
        : `别处·${namer(last.sessionId)}`
      : '';
    const at = last && now ? formatTimestamp(last.at, now) : '';
    const tail = said ? `最后一句 ${[where, at].filter(Boolean).join(' ')}：「${said}」` : '';
    return `- ${head.label}｜${meta}${tail ? `；${tail}` : ''}`;
  });
  const header = currentSessionId ? `[进行中的局]（这边是「${namer(currentSessionId)}」）` : '[进行中的局]';
  return `${header}\n${lines.join('\n')}`;
}

export function buildSkillDigest(activation: SkillActivation): string {
  const items = [activation.main, ...activation.associated].filter((skill): skill is SkillCard => Boolean(skill));
  if (items.length === 0) return '';
  return `[技能]\n${items.map((skill) => `- ${skill.id}：${skill.name}（成熟度 ${skill.maturity.toFixed(2)}${skillFlags(skill)}）`).join('\n')}`;
}

/** 草稿与需确认技能必须在注入里标出来，否则模型会当成熟技能直接用 */
function skillFlags(skill: SkillCard): string {
  const flags: string[] = [];
  if (skill.status === 'draft') flags.push('草稿');
  if (skill.boundary.requiresConfirm) flags.push('需确认');
  return flags.length > 0 ? `｜${flags.join('·')}` : '';
}

export const NO_MEMORY_CONSTRAINT = [
  '[无记忆约束]',
  '当前没有任何与用户相关的共同经历记录。',
  '禁止编造“上次你说过”“我们之前”等具体往事。',
  '你可以表达性格与当前状态，但不得声称记得未记录的事。',
].join('\n');

export function buildBlocks(input: {
  personaText: string;
  stateHint: string;
  eventDigest: string;
  crossWindowText: string;
  threadText: string;
  skillDigest: string;
  associationText: string;
  constraint: string | null;
  config: DaughterConfig;
}): { blocks: PromptBlock[]; usedTokens: number } {
  const { config } = input;
  const caps = config.budget.block_caps;
  const blocks: PromptBlock[] = [];

  // 顺序即权重：先说"这局进行到哪儿、别处刚说了什么"，再说"我是谁、此刻什么状态"。
  // 性格与关系的 0.72/0.64 是读数，不是这一句该接的地方，所以排在记忆后面。
  if (input.constraint) blocks.push(makeBlock('constraint', input.constraint, caps.constraint, 1000));
  // 进行中的局：最该被两个窗口共享，优先级最高；预算裁剪碰不到它
  if (input.threadText) blocks.push(makeBlock('thread', input.threadText, caps.thread, 980));
  // 跨窗口块优先级高于当前话题检索：预算裁剪先动事件块，也动不到它
  if (input.crossWindowText) blocks.push(makeBlock('cross_window', input.crossWindowText, caps.cross_window, 940));
  if (input.eventDigest) blocks.push(makeBlock('event_digest', input.eventDigest, caps.event_digest, 900));
  blocks.push(makeBlock('persona', input.personaText, caps.persona, 600));
  blocks.push(makeBlock('state_hint', input.stateHint, caps.state_hint, 560));
  if (input.associationText) blocks.push(makeBlock('association', input.associationText, caps.association, 350));
  if (input.skillDigest) blocks.push(makeBlock('skill_digest', input.skillDigest, caps.skill_digest, 300));

  return clipBlocks(blocks, config.budget.max_total_tokens);
}

function makeBlock(kind: PromptBlock['kind'], text: string, cap: number, priority: number): PromptBlock {
  const clipped = clipToTokens(text, cap);
  return { kind, text: clipped, tokens: estimateTokens(clipped), priority };
}

/** 超预算时按优先级丢弃：联想 → 低分事件 → 技能压缩 */
export function clipBlocks(
  blocks: PromptBlock[],
  maxTotal: number,
): { blocks: PromptBlock[]; usedTokens: number } {
  let current = blocks.map((block) => ({ ...block, tokens: estimateTokens(block.text) }));
  let total = sumTokens(current);

  if (total > maxTotal) {
    current = current.filter((block) => block.kind !== 'association');
    total = sumTokens(current);
  }

  while (total > maxTotal) {
    const digest = current.find((block) => block.kind === 'event_digest');
    if (!digest) break;
    const lines = digest.text.split('\n');
    if (lines.length <= 2) {
      current = current.filter((block) => block.kind !== 'event_digest');
    } else {
      digest.text = lines.slice(0, -1).join('\n');
      digest.tokens = estimateTokens(digest.text);
    }
    total = sumTokens(current);
  }

  while (total > maxTotal) {
    const skill = current.find((block) => block.kind === 'skill_digest');
    if (!skill) break;
    const reduced = skill.text.split('\n').slice(0, 2).join('\n');
    if (reduced === skill.text) {
      current = current.filter((block) => block.kind !== 'skill_digest');
    } else {
      skill.text = reduced;
      skill.tokens = estimateTokens(skill.text);
    }
    total = sumTokens(current);
  }

  // 高优先级块（跨窗口 / 进行中的局）平时不裁，但连它们一起都放不下时，
  // 作为最后手段从低到高裁：先跨窗口、再进行中的局——保住绝对预算，也保住优先级。
  for (const kind of ['cross_window', 'thread'] as const) {
    while (total > maxTotal) {
      const block = current.find((item) => item.kind === kind);
      if (!block) break;
      const lines = block.text.split('\n');
      if (lines.length <= 1) {
        current = current.filter((item) => item.kind !== kind);
      } else {
        block.text = lines.slice(0, -1).join('\n');
        block.tokens = estimateTokens(block.text);
      }
      total = sumTokens(current);
    }
  }

  return { blocks: current, usedTokens: sumTokens(current) };
}

function sumTokens(blocks: PromptBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.tokens, 0);
}

function clipToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}
