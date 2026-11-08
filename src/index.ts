import { loadConfig, resolveDataRoot } from './config.js';
import { performance } from 'node:perf_hooks';
import { Store } from './store.js';
import { Observability } from './runtime/observability.js';
import type {
  AssetPackage,
  AssociationHit,
  BodySignal,
  DaughterConfig,
  DaughterMetrics,
  DaughterPlugin,
  EventRecord,
  L5State,
  PersonaBundle,
  PluginContext,
  PromptBlock,
  ReflexAction,
  RetrievalHit,
  SafetyVerdict,
  SkillActivation,
  SpeakPlan,
  SubPersona,
  WindowNamer,
} from './types.js';
import type { Logger } from './util.js';
import { createRng, relativeTime, safeFileName, silentLogger, truncate } from './util.js';
import { applyBodySignal, pickMotionByPad } from './runtime/body-link.js';
import { decideIngest, type FilterAction } from './runtime/filter.js';
import { carryL5, createInitialL5, selectSubpersona, updateL5 } from './runtime/state.js';
import { assignThread, isDialogueSource, pruneOpenThreads, type ThreadHead } from './runtime/threading.js';
import { evaluateSpeak, localDayKey } from './runtime/speak.js';
import { readForeground } from './runtime/desktop-observe.js';
import { containsDiagnosisLabel, evaluateSafety } from './runtime/safety.js';
import {
  applySurprise,
  associateEvents,
  extractEvent,
  linkNewEvent,
  pickAssociationSeed,
  recallDrift,
  reconstructOnRecall,
  retrieveEvents,
} from './runtime/memory.js';
import {
  NO_MEMORY_CONSTRAINT,
  activateSkills,
  buildBlocks,
  buildCrossWindowDigest,
  buildEventDigest,
  buildPersonaText,
  buildThreadDigest,
  buildRelationText,
  buildSkillDigest,
  buildStateHint,
  clipBlocks,
  matchReflex,
  WORKING_STYLE,
} from './runtime/content.js';
import { applyPersonalitySignal } from './runtime/personality.js';
import {
  applyPersonaDrift,
  buildPersonProfiles,
  buildStarMap,
  buildThingProfiles,
  bumpSkill,
  learnDraftSkill,
  maybeFreezeSkill,
  runTick,
} from './runtime/maintenance.js';

/** §6.1 时延预算：超时只告警与记日志，不做硬中断（SQLite 同步查询无法中途取消） */
const RETRIEVE_BUDGET_MS = 150;
const BEFORE_PROMPT_BUDGET_MS = 100;

/** 换对话框后的第一句：接上"上一段对话的结尾"最多带几条、往前看多久 */
const CONTINUATION_LIMIT = 3;
const CONTINUATION_WINDOW_MS = 7 * 86_400_000;
/** 已见过首轮的会话集合上限（超出按最久未用淘汰，不再整体清空） */
const SEEN_SESSIONS_CAP = 512;

export interface PluginOptions {
  pluginRoot: string;
  config?: DaughterConfig;
  logger?: Logger;
  /** 连接器令牌（§12.2）：主动开口前的场景探测要访问桌面桥，必须带令牌 */
  connectorToken?: string;
  /** 动作包播放出口（桌宠等连接器消费） */
  onMotion?: (motionId: string) => void;
}

interface PromptCache {
  sessionId: string;
  hits: RetrievalHit[];
  activation: SkillActivation;
  mainSkillId?: string;
}

export function createDaughterPlugin(options: PluginOptions): DaughterPlugin {
  return new Daughter(options);
}

export default createDaughterPlugin;

class Daughter implements DaughterPlugin {
  private readonly config: DaughterConfig;
  private readonly dataRoot: string;
  private readonly logger: Logger;
  private readonly stores = new Map<string, Store>();
  private readonly sessions = new Map<string, L5State>();
  private readonly promptCache = new Map<string, PromptCache>();
  private readonly observers = new Map<string, Observability>();
  /** 角色级外部生理信号缓存（桌宠体力/心情），只参与派生有效状态 */
  private readonly bodyCache = new Map<string, BodySignal | null>();
  /** 已处理过的 (sessionId, turnId)，用于 after_response 幂等，避免同一轮重复写事件记忆 */
  private readonly handledTurns = new Map<string, number>();
  /** 已经构建过 prompt 的会话：只有第一次才允许"续接上一个对话" */
  private readonly seenSessions = new Set<string>();
  /** 每个窗口已经贴过的"别处刚说的话"，跨窗口轨道靠它去重，避免同一件事反复提醒 */
  private readonly injectedCross = new Map<string, Set<string>>();
  private readonly rng: () => number;
  private readonly onMotion?: (motionId: string) => void;
  /** 连接器令牌：主动开口探测桌面桥时带上（§12.2） */
  private readonly connectorToken: string;

  constructor(options: PluginOptions) {
    this.logger = options.logger ?? silentLogger;
    this.config = options.config ?? loadConfig(options.pluginRoot, this.logger);
    this.dataRoot = resolveDataRoot(options.pluginRoot, this.config);
    this.rng = createRng(this.config.seed);
    this.onMotion = options.onMotion;
    this.connectorToken = String(options.connectorToken ?? '');
  }

  async onUserMessage(input: {
    ctx: PluginContext;
    text: string;
    source: EventRecord['source'];
  }): Promise<{ l5: L5State; verdict: SafetyVerdict }> {
    const { ctx, text } = input;
    const store = this.store(ctx.characterId);
    const persona = store.loadPersona();
    const now = ctx.now();
    const prev = this.getL5(ctx, persona);
    this.userTextCache.set(sessionKey(ctx), text);
    this.sourceCache.set(sessionKey(ctx), input.source);

    // 原始状态只由对话驱动；桌宠信号在 effective() 里叠加，存盘存原始值（§4.3）
    const l5 = updateL5(prev, text, now, persona);
    l5.emotionalOverdraft = store.loadOverdraft();

    const effective = this.effective(ctx.characterId, l5, now);
    const verdict = this.safetyCheck({ ctx, l5: effective });

    const overdraftDelta = l5.stress > 0.7 ? 0.03 : -0.01;
    l5.emotionalOverdraft = Math.min(1, Math.max(0, l5.emotionalOverdraft + overdraftDelta));
    store.saveOverdraft(l5.emotionalOverdraft);
    this.commitL5(store, ctx, l5);

    this.logger.debug('on_user_message', {
      sessionId: ctx.sessionId,
      level: verdict.level,
      stress: round(effective.stress),
      body: effective.fatigue > l5.fatigue ? 'vpet' : undefined,
    });
    return { l5: effective, verdict };
  }

  async beforePromptBuild(input: {
    ctx: PluginContext;
    tokenBudget: number;
  }): Promise<{ blocks: PromptBlock[]; usedTokens: number; memoryHit: boolean }> {
    const startedAt = performance.now();
    const { ctx } = input;
    const store = this.store(ctx.characterId);
    const persona = store.loadPersona();
    const now = ctx.now();
    const l5 = this.effective(ctx.characterId, this.getL5(ctx, persona), now);
    const verdict = this.peekSafety(ctx, l5);

    const query = this.lastUserText(ctx);

    // §6.3 固定顺序：技能激活先于检索，技能决定「怎么做」，检索补充「发生过什么」
    const activation = await this.skillActivate({
      ctx,
      userText: query ?? '',
      maxMain: this.config.skills.max_main,
      maxAssociated: this.config.skills.max_associated,
    });

    const ftsUnavailable = !store.ftsReady;
    const retrieveStarted = performance.now();
    const hits = query
      ? await this.retrieve({
          characterId: ctx.characterId,
          query,
          now,
          topK: this.config.retrieval.top_k,
          currentEmotion: l5.emotion,
          excludeArchived: this.config.retrieval.exclude_archived,
        })
      : [];
    const retrieveMs = Math.round(performance.now() - retrieveStarted);

    // 检索降级三种来源：FTS5 索引不可用、本次 FTS 查询抛错（之前被静默吞掉）、查询短于 trigram 最小长度
    const retrievalDegraded =
      ftsUnavailable ||
      (Boolean(query) && store.lastFtsError !== null) ||
      ((query ?? '').trim().length > 0 && (query ?? '').trim().length < 3);
    if (Boolean(query) && store.lastFtsError !== null) {
      this.logger.warn('dsh-daughter: FTS 检索失败，本轮退回 Dice 兜底', { error: store.lastFtsError });
    }

    const withSurprise = applySurprise(hits, store.listCandidates(true, this.config.retrieval.max_candidates), this.config, this.rng, now);

    const candidatePool = store.listCandidates(
      !this.config.retrieval.exclude_archived,
      this.config.retrieval.max_candidates,
    );

    // 换对话框后的第一句：先接上"上一个对话的结尾"。
    // 换窗口时"刚才"比"情绪像"更该被想起，所以它排在一跳联想之前——
    // 这条路径只在该会话第一次构建 prompt 时走一次。
    // 缓存键（角色::会话）与库里的 session_id 是两回事：查库必须用原样的会话 id，
    // 否则"排除本窗口"这条永远不成立，本窗口刚说的话会被当成别处说的贴回来。
    const cacheKey = sessionKey(ctx);
    const firstTurn = !this.seenSessions.has(cacheKey);
    this.markSeen(cacheKey);
    // 窗口名字：按第一次出现的顺序发「窗1」「窗2」并落库，重启后还是同一个名
    const namer = this.windowNamer(ctx.characterId);

    const nowMs = Date.parse(now);
    // 续接是个固定槽位，不再给字面命中让位：早期要求"这一句没撞上任何旧事"才续接，
    // 于是换窗口后正好提到某件旧事时，"刚才说到哪儿"反而被顶掉了——那正是最该接上的时候。
    const hitIds = new Set(withSurprise.map((hit) => hit.event.id));
    const continued: RetrievalHit[] =
      firstTurn && this.config.association.fallback_when_no_match
        ? store
            .listRecentEvents(
              new Date(Number.isFinite(nowMs) ? nowMs - CONTINUATION_WINDOW_MS : 0).toISOString(),
              CONTINUATION_LIMIT + hitIds.size,
            )
            .filter((event) => !hitIds.has(event.id))
            .slice(0, CONTINUATION_LIMIT)
            .map((event) => ({ event, score: event.weight, reason: '续接（上一段对话的结尾）' }))
        : [];
    const continuedIds = new Set(continued.map((hit) => hit.event.id));

    // 窗口只是工位，不是记忆分区：别的窗口里刚说的话，每轮都补进来，
    // 这样"在 1 里说要去跑步，到 2 里说你好"才会接上一句"不是跑了吗"。
    const injectedCross = this.injectedCross.get(cacheKey) ?? new Set<string>();
    const contentKey = (event: EventRecord): string => `${event.title}\u0000${event.summary}`;
    const crossCandidates = this.config.continuity.enabled
      ? store
          .listRecentElsewhere(
            new Date(
              Number.isFinite(nowMs) ? nowMs - this.config.continuity.cross_window_minutes * 60_000 : 0,
            ).toISOString(),
            this.config.continuity.cross_window_max + injectedCross.size + hitIds.size + continuedIds.size,
            // 原样会话 id：库里存的就是它，换成缓存键会让"排除本窗口"失效
            ctx.sessionId,
          )
          .filter(
            (event) => !hitIds.has(event.id) && !continuedIds.has(event.id) && !injectedCross.has(event.id),
          )
          .map((event) => ({
            event,
            score: event.weight,
            reason: '跨窗口（刚在别处说的）',
            window: namer(event.sessionId),
          }))
      : [];
    // 同一个东西被记过好几次（同一个视频刷到五次），这一块只留最新的一条
    const seenCross = new Set<string>();
    const crossWindow = crossCandidates.filter((hit) => {
      const key = contentKey(hit.event);
      if (seenCross.has(key)) return false;
      seenCross.add(key);
      return true;
    }).slice(0, this.config.continuity.cross_window_max);
    for (const hit of crossWindow) injectedCross.add(hit.event.id);
    this.injectedCross.set(cacheKey, injectedCross);

    // 一条字面命中都没有时，仍然可以从记忆网里往外摸：
    // 人想不起直接对应的事，不会因此停止联想，而是从"当下情绪最像、时间最近"的那段记忆顺下去。
    let seedIds = withSurprise.map((hit) => hit.event.id);
    if (seedIds.length === 0 && this.config.association.fallback_when_no_match && continued.length === 0) {
      const seed = pickAssociationSeed(candidatePool, l5.emotion, now, this.config);
      if (seed) seedIds = [seed.id];
    }

    const associated = seedIds.length > 0
      ? await this.associate({
          characterId: ctx.characterId,
          seedEventIds: seedIds,
          maxDepth: this.config.association.max_depth,
          maxInjected: this.config.association.max_injected,
        })
      : [];

    const sub = this.pickSubpersona(persona, ctx.audience, l5.activeSubPersonaId);

    // 关系画像参与注入：亲密度/关系变化、事物偏好、善恶观
    const relationText = buildRelationText({
      person: buildPersonProfiles(store, now).find((profile) => !profile.self && profile.name === 'user'),
      things: buildThingProfiles(store, now).slice(0, 8),
      moral: persona.l3.moral,
    });

    // 联想命中要带上内容：只给 eventId 的联想块，模型根本用不上，等于没联想
    const candidateById = new Map(candidatePool.map((event) => [event.id, event]));
    const associatedViews = associated
      .map((hit) => ({ hit, event: candidateById.get(hit.eventId) }))
      .filter((item): item is { hit: AssociationHit; event: EventRecord } => Boolean(item.event))
      // §10.1 档位 ≥2 的注入只保留情绪中性的引用
      .filter((item) => verdict.level < 2 || Math.abs(item.event.emotionAtTime.pleasure) <= 0.2);

    // §10.1 降级收紧主动联想：档位 1 砍半，档位 2 起整个联想块不再注入
    const associationLimit =
      verdict.level >= 2 ? 0 : verdict.level >= 1 ? Math.ceil(associatedViews.length / 2) : associatedViews.length;
    // 联想块保留内容而不是只给 eventId：事件块可能被预算裁掉，联想块是它被裁后的备份；
    // 同时带上"由哪条想到"，这是事件块给不出的路径信息
    const associationText =
      associationLimit > 0
        ? `[联想]\n${associatedViews
            .slice(0, associationLimit)
            .map(({ hit, event }) => {
              const seed = hit.path && hit.path.length > 1 ? candidateById.get(hit.path[0]!) : undefined;
              const bridge = seed ? `，由「${truncate(seed.title, 12)}」想到` : '';
              const hops = hit.depth ?? 1;
              return `- 【${event.id}】${relativeTime(event.createdAt, now)}｜${truncate(event.title, 24)}｜${truncate(event.summary, 60)}（${hit.via.kind}${bridge}，${hops} 跳）`;
            })
            .join('\n')}`
        : '';

    // §10.1 档位 ≥2：注入只保留情绪中性的记忆，避免降级时被高强度情绪记录带偏
    const digestHits =
      verdict.level >= 2
        ? withSurprise.filter((hit) => Math.abs(hit.event.emotionAtTime.pleasure) <= 0.2)
        : withSurprise;

    // 联想出来的记忆也进事件块：联想块优先级低，预算一紧就被裁，
    // 内容先进事件块，才不会变成"想了但没说出口"
    const directIds = new Set(digestHits.map((hit) => hit.event.id));
    const associationDigest: RetrievalHit[] = associatedViews
      .filter(({ event }) => !directIds.has(event.id))
      .map(({ hit, event }) => ({
        event,
        score: hit.score,
        reason: `联想（${hit.via.kind}，${hit.depth ?? 1} 跳）`,
      }));
    const injectedHits = [...digestHits, ...associationDigest];

    // 续接条目不算命中：不进 promptCache.hits，也就不写 recallCount / weight，
    // 否则每开一个新窗口它都被强化一次，最后永远排在最前面。
    const memoryHit = withSurprise.length > 0 || associationDigest.length > 0;
    // 跨窗口不进事件块：单独一块，独立预算，不受当前话题检索与预算裁剪影响
    // 同一条只贴一个地方：跨窗口块已经给过的内容，事件块不再重复贴一遍；
    // 事件块内部也按内容去重（同一个视频刷到五次，也只占一行）
    const crossKeys = new Set(crossWindow.map((hit) => contentKey(hit.event)));
    const seenContent = new Set<string>();
    const injected = [...injectedHits, ...continued].filter((hit) => {
      const key = contentKey(hit.event);
      if (crossKeys.has(key) || seenContent.has(key)) return false;
      seenContent.add(key);
      return true;
    });

    // §4.4 全文层：只在命中且全文确实比摘要更长时取摘录，由事件块的 cap 兜底
    const excerpts = this.config.retrieval.expand_fulltext
      ? this.collectExcerpts(store, injected)
      : undefined;

    // 进行中的局：角色级共享，两个窗口看到同一局的前情摘要（§8.2）
    const prunedThreads = this.config.threading.enabled
      ? pruneOpenThreads(
          store.loadOpenThreads(),
          now,
          this.config.threading.activity_ttl_minutes,
          6,
          this.config.threading.closed_retention_minutes,
        )
      : [];
    // 开着的最多 max_injected 局；另外固定带一条最近收尾的——
    // "结了没"得有个交代，昨晚那局也要留着落脚处，不能整段砍掉
    const openHeads = prunedThreads
      .filter((head) => head.status !== 'closed')
      .slice(0, this.config.threading.max_injected);
    const closedHead = prunedThreads.find((head) => head.status === 'closed');
    const openThreads = closedHead ? [...openHeads, closedHead] : openHeads;
    // 带上本窗口的名字与 id：局的最后一句要标清"这儿/别处"，不然自己的话会被当成对方的
    const threadText = buildThreadDigest(openThreads, now, ctx.sessionId, namer);

    const { blocks, usedTokens } = buildBlocks({
      personaText: [buildPersonaText(persona, sub), relationText, WORKING_STYLE].filter(Boolean).join('\n'),
      stateHint: buildStateHint(l5, verdict),
      eventDigest: buildEventDigest(injected, excerpts, now, ctx.sessionId, namer),
      crossWindowText: buildCrossWindowDigest(crossWindow, now, ctx.sessionId, namer),
      threadText,
      skillDigest: buildSkillDigest(activation),
      associationText,
      // 有内容就不能说"没有任何记录"：续接/跨窗口不算命中，但块里确实列了往事
      constraint: injected.length > 0 || crossWindow.length > 0 || openThreads.length > 0 ? null : NO_MEMORY_CONSTRAINT,
      config: this.config,
    });

    const budget = Math.min(input.tokenBudget, this.config.budget.max_total_tokens);
    const clipped = usedTokens > budget ? clipBlocks(blocks, budget) : { blocks, usedTokens };

    this.promptCache.set(sessionKey(ctx), {
      sessionId: ctx.sessionId,
      hits: withSurprise,
      activation,
      mainSkillId: activation.main?.id,
    });

    this.logger.debug('before_prompt_build', {
      sessionId: ctx.sessionId,
      usedTokens: clipped.usedTokens,
      memoryHit,
      level: verdict.level,
    });

    const tookMs = Math.round(performance.now() - startedAt);
    const overBudget = retrieveMs > RETRIEVE_BUDGET_MS || tookMs > BEFORE_PROMPT_BUDGET_MS;
    if (overBudget) {
      this.logger.warn('before_prompt_over_budget', {
        sessionId: ctx.sessionId,
        tookMs,
        retrieveMs,
      });
    }

    this.observer(ctx.characterId).recordTurn({
      at: now,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      characterId: ctx.characterId,
      tookMs,
      retrieveMs,
      overBudget,
      injectTokens: clipped.usedTokens,
      hits: withSurprise.length,
      skills: (activation.main ? 1 : 0) + activation.associated.length,
      memoryHit,
      // 降级：仅统计检索层降级（FTS5 不可用 / 短查询退 Dice）
      degraded: retrievalDegraded,
    });

    return { blocks: clipped.blocks, usedTokens: clipped.usedTokens, memoryHit };
  }

  async afterResponse(input: {
    ctx: PluginContext;
    userText: string;
    assistantText: string;
    toolsUsed?: string[];
  }): Promise<{ eventId?: string; skillsUpdated: string[]; evolutionIds: string[] }> {
    const { ctx, userText, assistantText } = input;
    const turnKey = `${ctx.sessionId}:${ctx.turnId}`;
    if (this.handledTurns.has(turnKey)) {
      this.logger.debug('afterResponse_skipped_duplicate', { sessionId: ctx.sessionId, turnId: ctx.turnId });
      return { skillsUpdated: [], evolutionIds: [] };
    }
    this.handledTurns.set(turnKey, Date.now());
    if (this.handledTurns.size > 512) {
      const oldest = this.handledTurns.keys().next();
      if (!oldest.done) this.handledTurns.delete(oldest.value);
    }
    const store = this.store(ctx.characterId);
    const persona = store.loadPersona();
    const now = ctx.now();
    const l5 = this.getL5(ctx, persona);
    const toolsUsed = input.toolsUsed ?? [];

    const event = extractEvent(ctx, userText, assistantText, l5, this.rng);
    // "局"归并：时间相邻 + 话题相似的事件归成一个 thread（跨窗口也算同一局）
    let openThreads: ThreadHead[] | null = null;
    if (this.config.threading.enabled && isDialogueSource(event.source)) {
      // 原话一起交给归并：摘要只记话题，"卡在哪"要靠原话才接得上
      const assigned = assignThread(event, store.loadOpenThreads(), this.config, userText);
      event.threadId = assigned.threadId;
      openThreads = assigned.heads;
    }
    // 全文层写完整的问 + 答，摘要层只留压缩版（§4.4）
    const ingested = this.ingest(store, event, `${userText.trim()}\n→ ${assistantText.trim()}`.trim());
    if (ingested.action === 'keep') {
      if (openThreads) {
        store.saveOpenThreads(
          pruneOpenThreads(
            openThreads,
            now,
            this.config.threading.activity_ttl_minutes,
            6,
            this.config.threading.closed_retention_minutes,
          ),
        );
      }
      linkNewEvent(store, event);
    }

    const cache = this.promptCache.get(sessionKey(ctx));
    const skillsUpdated: string[] = [];
    const evolutionIds: string[] = [];
    if (cache) {
      // 一次召回的多条记忆共享同一个"此刻"，只给情绪位移最大的那条记回看感受：
      // 否则一轮命中十几条就写十几行同样的情绪（真实库 24 行只用了两轮），
      // 而单条事件的 emotionNowHistory 上限只有 8 条，很快就被合并挤掉。
      let recallTarget: { event: EventRecord; drift: number } | null = null;
      for (const hit of cache.hits) {
        const current = store.getEvent(hit.event.id);
        if (!current) continue;
        store.updateEventMutable(hit.event.id, {
          weight: Math.min(1, current.weight + this.config.decay.recall_boost),
          recallCount: current.recallCount + 1,
          lastRecalledAt: now,
        });
        const drift = recallDrift(current, l5.emotion);
        if (!recallTarget || drift > recallTarget.drift) recallTarget = { event: current, drift };
      }
      if (recallTarget) {
        reconstructOnRecall(
          store,
          recallTarget.event,
          l5,
          now,
          this.config.retrieval.reconstruct_distance,
          this.config.retrieval.reconstruct_cooldown_minutes,
        );
      }
      const main = cache.activation.main;
      if (main) {
        // 宿主给了工具证据就以证据判定成败，否则沿用「被激活即算成功」
        const succeeded =
          main.requiredTools.length === 0
          || toolsUsed.length === 0
          || main.requiredTools.some((tool) => toolsUsed.includes(tool));
        const updated = bumpSkill(store, main, succeeded, this.config, now);
        skillsUpdated.push(updated.id);
        if (updated.status !== main.status) {
          store.appendEvolution({
            id: store.newEvolutionId(now),
            characterId: store.characterId,
            target: 'skill',
            before: { skillId: main.id, status: main.status },
            after: { skillId: updated.id, status: updated.status },
            reason: succeeded ? '技能首次成功，草稿转正' : `连续失败 ${updated.failCount} 次，技能作废`,
            at: now,
          });
        }
        const freeze = maybeFreezeSkill(store, updated, this.config, now);
        if (freeze.evolutionId) evolutionIds.push(freeze.evolutionId);
      }
    }

    // §9.1 状态机入口：一轮里跑通了多步工具序列就沉淀成技能草稿
    const learned = learnDraftSkill(store, this.config, { userText, tools: toolsUsed, now });
    if (learned) {
      skillsUpdated.push(learned.skill.id);
      evolutionIds.push(learned.evolutionId);
    }

    const drift = applyPersonaDrift(store, this.config, persona, sentimentOf(userText), now);
    if (drift.changed && drift.evolutionId) evolutionIds.push(drift.evolutionId);

    // 性格演化：只有「累积 / 关键」事件才动 L1–L3，日常闲聊交给 L5（写实口径）
    const signal = applyPersonalitySignal(store, this.config, {
      text: userText,
      eventId: ingested.eventId,
      l5,
      now,
    });
    if (signal.changed) evolutionIds.push(...signal.evolutionIds);

    const label = this.config.safety.diagnosis_labels_forbidden ? containsDiagnosisLabel(assistantText) : null;
    if (label) {
      const entry = {
        id: store.newEvolutionId(now),
        characterId: store.characterId,
        target: 'safety' as const,
        before: {},
        after: { labelDetected: label },
        reason: '输出侧检测到诊断性标签，仅记录不推断',
        at: now,
      };
      store.appendEvolution(entry);
      evolutionIds.push(entry.id);
      this.logger.warn('输出包含诊断性标签', { label, sessionId: ctx.sessionId });
    }

    this.promptCache.delete(sessionKey(ctx));
    return { eventId: ingested.eventId, skillsUpdated, evolutionIds };
  }

  async retrieve(input: {
    characterId: string;
    query: string;
    now: string;
    topK: number;
    currentEmotion: L5State['emotion'];
    excludeArchived: boolean;
  }): Promise<RetrievalHit[]> {
    const store = this.store(input.characterId);
    return retrieveEvents({
      ...input,
      config: this.config,
      candidates: store.listCandidates(!input.excludeArchived, this.config.retrieval.max_candidates),
      ftsScores: (query) => store.searchFts(query, this.config.retrieval.max_candidates),
    });
  }

  async associate(input: {
    characterId: string;
    seedEventIds: string[];
    maxDepth: number;
    maxInjected: number;
  }): Promise<AssociationHit[]> {
    const store = this.store(input.characterId);
    const candidates = store.listCandidates(false, this.config.retrieval.max_candidates);
    return associateEvents(
      input.seedEventIds,
      candidates,
      Math.min(input.maxDepth, this.config.association.max_depth),
      Math.min(input.maxInjected, this.config.association.max_injected),
      this.config.association.hop_decay,
    );
  }

  async skillActivate(input: {
    ctx: PluginContext;
    userText: string;
    maxMain: number;
    maxAssociated: number;
  }): Promise<SkillActivation> {
    const store = this.store(input.ctx.characterId);
    const skills = store.loadSkills();
    // 没有可激活的技能时不读人格与事件，避免每轮都做无谓的全表扫描
    if (skills.length === 0) {
      return { main: undefined, associated: [], confidence: 0, breakdown: [] };
    }
    const persona = store.loadPersona();
    const now = input.ctx.now();
    const l5 = this.effective(input.ctx.characterId, this.getL5(input.ctx, persona), now);
    const subPersona = this.pickSubpersona(persona, input.ctx.audience, l5.activeSubPersonaId);
    // 情绪记忆只看配置的近期窗口；归档事件不参与动机判断
    const lookbackMs = this.config.motivation.memory.lookback_days * 86_400_000;
    const nowMs = Date.parse(now);
    const recentEvents = Number.isFinite(nowMs)
      ? store.listRecentEvents(new Date(nowMs - lookbackMs).toISOString())
      : [];

    return activateSkills(
      skills,
      input.userText,
      {
        ...this.config,
        skills: {
          ...this.config.skills,
          max_main: Math.min(input.maxMain, this.config.skills.max_main),
          max_associated: Math.min(input.maxAssociated, this.config.skills.max_associated),
        },
      },
      { now, l5, persona, subPersona, recentEvents },
    );
  }

  async assetInvoke(input: {
    ctx: PluginContext;
    assetId: string;
    args: Record<string, unknown>;
  }): Promise<{ ok: boolean; output?: unknown; rolledBack?: boolean; reason?: string }> {
    const store = this.store(input.ctx.characterId);
    const asset = store.loadAsset(input.assetId);
    if (!asset) return { ok: false, reason: 'asset_not_found' };
    if (asset.status !== 'active') return { ok: false, reason: 'asset_inactive' };

    const l5 = this.getL5(input.ctx, store.loadPersona());
    const verdict = this.safetyCheck({ ctx: input.ctx, l5 });
    if (!verdict.allowTools) return { ok: false, reason: 'safety_blocked' };

    const boundary = asset.payload.boundary as
      | { requiresConfirm?: boolean; forbiddenContexts?: string[] }
      | undefined;
    if (boundary?.requiresConfirm && input.args.__confirmed !== true) {
      return { ok: false, reason: 'confirmation_required' };
    }
    const context = typeof input.args.__context === 'string' ? input.args.__context : '';
    if (boundary?.forbiddenContexts?.some((item) => item && context.includes(item))) {
      return { ok: false, reason: 'forbidden_context' };
    }

    try {
      const output = await this.executeAsset(asset, input.ctx, input.args, l5);
      store.setMeta(`assetFail:${asset.id}`, '0');
      return { ok: true, output };
    } catch (error) {
      return this.registerAssetFailure(asset, input.ctx, String(error));
    }
  }

  async reflexMatch(input: {
    ctx: PluginContext;
    userText: string;
    l5: L5State;
    source?: EventRecord['source'];
  }): Promise<{ ruleId: string; action: ReflexAction } | null> {
    const startedAt = performance.now();
    const store = this.store(input.ctx.characterId);
    const state = store.loadReflexState();
    const source = input.source ?? this.sourceCache.get(sessionKey(input.ctx));
    const matched = matchReflex(
      store.loadReflexRules(),
      input.userText,
      this.effective(input.ctx.characterId, input.l5, input.ctx.now()),
      state,
      input.ctx.now(),
      this.config,
      source,
    );
    if (!matched) return null;

    // §4.6：反射动作也必须先过安全闸门。降级档位下工具类动作直接丢弃，其余照常。
    if (matched.action.kind === 'tool_call') {
      const verdict = this.peekSafety(input.ctx, input.l5);
      if (!verdict.allowTools) {
        this.logger.warn('dsh-daughter: 安全降级中，反射工具动作被丢弃', {
          ruleId: matched.rule.id,
          level: verdict.level,
          tool: matched.action.tool,
        });
        return null;
      }
    }

    const matchMs = performance.now() - startedAt;
    if (matchMs > this.config.reflex.max_match_ms) {
      this.logger.warn('dsh-daughter: 反射匹配超出预算', {
        ruleId: matched.rule.id,
        matchMs: Math.round(matchMs),
        budgetMs: this.config.reflex.max_match_ms,
      });
    }

    state[matched.rule.id] = input.ctx.now();
    store.saveReflexState(state);

    if (matched.action.kind === 'state_shift') {
      const next: L5State = { ...input.l5, emotion: { ...input.l5.emotion } };
      for (const [key, value] of Object.entries(matched.action.delta)) {
        if (typeof value !== 'number') continue;
        if (key === 'stress') next.stress = Math.min(1, Math.max(0, next.stress + value));
        else next.emotion[key as 'pleasure' | 'arousal' | 'dominance'] = Math.min(
          1,
          Math.max(-1, next.emotion[key as 'pleasure' | 'arousal' | 'dominance'] + value),
        );
      }
      this.commitL5(store, input.ctx, next);
    }
    let ok = true;
    if (matched.action.kind === 'motion') {
      const played = await this.motionPlay({ ctx: input.ctx, motionId: matched.action.motionId });
      ok = played.ok;
      if (!played.ok) this.logger.warn('反射动作播放失败', { ruleId: matched.rule.id, motionId: matched.action.motionId });
    }

    this.observer(input.ctx.characterId).recordReflex({
      at: input.ctx.now(),
      sessionId: input.ctx.sessionId,
      turnId: input.ctx.turnId,
      characterId: input.ctx.characterId,
      ruleId: matched.rule.id,
      actionKind: matched.action.kind,
      tookMs: Math.round(performance.now() - startedAt),
      ok,
    });

    return { ruleId: matched.rule.id, action: matched.action };
  }

  async motionPlay(input: { ctx: PluginContext; motionId: string }): Promise<{ ok: boolean }> {
    if (!input.ctx.emit && !this.onMotion) return { ok: false };
    this.onMotion?.(input.motionId);
    input.ctx.emit?.('motion.play', { motionId: input.motionId, sessionId: input.ctx.sessionId });
    return { ok: true };
  }

  async ingestExternalEvent(input: {
    ctx: PluginContext;
    text: string;
    source: EventRecord['source'];
  }): Promise<{ eventId: string }> {
    const store = this.store(input.ctx.characterId);
    const persona = store.loadPersona();
    const l5 = this.getL5(input.ctx, persona);
    // 来源要在建事件时就定：参与者、显著性都要按来源推导，事后改 source 已经来不及
    const event = extractEvent(input.ctx, input.text, '', l5, this.rng, input.source);
    const ingested = this.ingest(store, event, input.text);
    if (ingested.action === 'keep') linkNewEvent(store, event);
    this.logger.debug('ingest_external_event', {
      source: input.source,
      eventId: ingested.eventId,
      action: ingested.action,
    });
    return { eventId: ingested.eventId };
  }

  async tick(input: { characterId: string; now: string }): Promise<{
    decayed: number;
    archived: number;
    forgotten: number;
    recovered: boolean;
    prunedLogs: number;
  }> {
    return runTick(this.store(input.characterId), this.config, input.now);
  }

  /**
   * 主动开口评估：没人说话的时候，她想不想开口。
   * 决策在 `runtime/speak.ts` 里是纯函数，这里只负责取上下文、读写
   * "今天说了几次 / 憋了多久"，投递（气泡、面板）交给宿主。
   */
  async speakPlan(input: { characterId: string; now: string; jitter?: number }): Promise<SpeakPlan | null> {
    if (!this.config.speak.enabled) return null;
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) return null;

    const store = this.store(input.characterId);
    const persona = store.loadPersona();
    // 首次运行记一个锚点：刚装上不该立刻自言自语
    if (store.getMeta('speak.bootAt') === null) store.setMeta('speak.bootAt', input.now);

    // 用最近活跃的会话当"她此刻在跟谁说话"
    let latestL5: L5State | null = null;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const sessionId of store.listL5Sessions()) {
      const candidate = store.loadL5(sessionId);
      if (!candidate) continue;
      const at = Date.parse(candidate.lastTickAt);
      if (Number.isFinite(at) && at > latestAt) {
        latestAt = at;
        latestL5 = candidate;
      }
    }
    const l5 = latestL5 ? this.effective(input.characterId, latestL5, input.now) : undefined;

    const lastAtRaw = store.getMeta('speak.lastAt');
    // 第一次评估（刚打开开关）先当"刚联系过"：否则沉默几小时后一开启就冒一句，
    // 像定时任务而不是想起你。之后交给冷却与 min_idle 管。
    if (lastAtRaw === null) {
      store.setMeta('speak.lastAt', input.now);
      return null;
    }
    const lastAtMs = Date.parse(lastAtRaw);
    const sinceLastSpeakMinutes = Number.isFinite(lastAtMs) ? Math.max(0, (nowMs - lastAtMs) / 60_000) : null;

    // 沉默时长以"最后一次对话"为准；没有对话记录时退到安装锚点
    const anchorRaw = latestL5?.lastTickAt ?? store.getMeta('speak.bootAt') ?? input.now;
    const anchorMs = Date.parse(anchorRaw);
    // 她刚说完话也算"刚联系过"：对方没回时，不该让自己的沉默继续累积成刷屏
    const idleAnchorMs = Number.isFinite(anchorMs) && Number.isFinite(lastAtMs) ? Math.max(anchorMs, lastAtMs) : anchorMs;
    const idleMinutes = Number.isFinite(idleAnchorMs) ? Math.max(0, (nowMs - idleAnchorMs) / 60_000) : 0;

    const dayKey = `speak.count.${localDayKey(input.now)}`;
    const todayCount = store.getMetaNumber(dayKey, 0);
    // 最近说过的几句，避免翻来覆去同一句
    const recentRaw = store.getMeta('speak.recentLines');
    const recentLines = recentRaw === null
      ? []
      : recentRaw
          .split(',')
          .map((item) => Number(item))
          .filter((item) => Number.isFinite(item));

    // 看得见屏幕的话，先看一眼她现在是不是在开会/打游戏。
    // 桥接没在跑会静默返回 null，按"看不见"处理，不会因此不再开口。
    const foreground = this.config.desktop.enabled
      ? await readForeground({
          bridgeUrl: this.config.desktop.bridge_url,
          token: this.connectorToken,
          timeoutMs: 1200,
        })
      : null;

    const plan = evaluateSpeak(
      {
        now: input.now,
        bigFive: persona?.l1.bigFive,
        l5,
        relationshipDepth: persona?.l2.relationshipDepth,
        idleMinutes,
        sinceLastSpeakMinutes,
        todayCount,
        carry: store.getMetaNumber('speak.carry', 0),
        foreground,
        jitter: input.jitter,
      },
      this.config,
      {
        recentLines,
        seed: `${input.characterId}:${localDayKey(input.now)}:${todayCount}:${Math.round(idleMinutes)}`,
      },
    );

    store.setMeta('speak.carry', String(plan.carry));
    if (plan.decision === 'act') {
      store.setMeta('speak.lastAt', input.now);
      store.setMeta(dayKey, String(todayCount + 1));
      if (plan.lineIndex !== undefined) {
        store.setMeta('speak.recentLines', [...recentLines, plan.lineIndex].slice(-5).join(','));
      }
      // 留痕：面板要能翻到"她说过什么"，否则这个功能是黑盒
      const historyRaw = store.getMeta('speak.history');
      let history: Array<{ at: string; text?: string; reason: string }> = [];
      if (historyRaw) {
        try {
          history = JSON.parse(historyRaw) as typeof history;
        } catch {
          history = [];
        }
      }
      history.push({ at: input.now, text: plan.text, reason: plan.reason });
      store.setMeta('speak.history', JSON.stringify(history.slice(-10)));
      this.logger.debug('speak_act', {
        reason: plan.reason,
        urge: Number(plan.urge.toFixed(3)),
        threshold: Number(plan.threshold.toFixed(3)),
        idleMinutes: Math.round(idleMinutes),
      });
    } else if (plan.decision === 'hold') {
      // "想说但忍住"只记次数，不记全文——否则一天几百条噪声
      const holdKey = `speak.hold.${localDayKey(input.now)}`;
      store.setMeta(holdKey, String(store.getMetaNumber(holdKey, 0) + 1));
    }
    return plan;
  }

  /** 面板入口读取星图：按当前库实时重算并落盘 */
  starMap(characterId: string, now: string): { nodes: number; edges: number; galaxies: number } {
    return buildStarMap(this.store(characterId), now);
  }

  /**
   * 接收桌宠上报的生理信号。关闭 body_link 时直接忽略：
   * 桌宠在不在，插件的记忆与人格路径完全一致。
   */
  syncBodySignal(input: {
    characterId: string;
    strength: number;
    feeling: number;
    source?: BodySignal['source'];
  }): void {
    if (!this.config.vpet.enabled || !this.config.vpet.body_link.enabled) return;
    const signal: BodySignal = {
      strength: Math.min(1, Math.max(0, Number(input.strength))),
      feeling: Math.min(1, Math.max(0, Number(input.feeling))),
      source: input.source ?? 'vpet',
      at: new Date().toISOString(),
    };
    if (!Number.isFinite(signal.strength) || !Number.isFinite(signal.feeling)) return;
    this.bodyCache.set(input.characterId, signal);
    try {
      this.store(input.characterId).saveBodySignal(signal);
    } catch (error) {
      this.logger.warn('dsh-daughter: 生理信号落盘失败', { error: String(error) });
    }
  }

  safetyCheck(input: { ctx: PluginContext; l5: L5State }): SafetyVerdict {
    const store = this.store(input.ctx.characterId);
    const previous = store.loadSafetyState();
    const { verdict, state } = evaluateSafety(input.l5, previous, this.config, input.ctx.now());
    store.saveSafetyState(state);

    if (state.level !== previous.level) {
      store.appendEvolution({
        id: store.newEvolutionId(input.ctx.now()),
        characterId: input.ctx.characterId,
        target: 'safety',
        before: { level: previous.level },
        after: { level: state.level, reasons: state.reasons },
        reason: '安全档位变化',
        at: input.ctx.now(),
      });
    }
    return verdict;
  }

  /* ------------------------------ 内部 ------------------------------ */

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
    this.sessions.clear();
    this.promptCache.clear();
    this.userTextCache.clear();
    this.sourceCache.clear();
    this.injectedCross.clear();
    this.observers.clear();
    this.bodyCache.clear();
  }

  metrics(characterId: string): DaughterMetrics {
    return this.observer(characterId).metrics();
  }

  /** 最近一次可用的外部生理信号；缓存优先，重启后从 prefrontal 读回，过期自然失效 */
  private bodySignal(characterId: string): BodySignal | null {
    if (this.bodyCache.has(characterId)) return this.bodyCache.get(characterId) ?? null;
    let signal: BodySignal | null = null;
    try {
      signal = this.store(characterId).loadBodySignal();
    } catch {
      signal = null;
    }
    this.bodyCache.set(characterId, signal);
    return signal;
  }

  /** 派生有效状态：只抬升疲劳/压力，不写回、不落盘 */
  private effective(characterId: string, l5: L5State, now: string): L5State {
    const config = this.config.vpet.body_link;
    if (!config.enabled) return l5;
    const signal = l5.body ?? this.bodySignal(characterId);
    return applyBodySignal({ ...l5, body: signal }, config, now);
  }

  private observer(characterId: string): Observability {
    let observer = this.observers.get(characterId);
    if (!observer) {
      observer = new Observability(this.dataRoot, characterId);
      this.observers.set(characterId, observer);
    }
    return observer;
  }

  /** 注入里摘要行可见的字符数（与 buildEventDigest 的 truncate 上限一致） */
  private static readonly DIGEST_SUMMARY_CHARS = 70;

  /**
   * 认知滤网的唯一落地点：keep 才写库，merge 只累加计数，drop/shield 仅记统计。
   * 判据全部在 runtime/filter.ts，这里只负责落地。
   */
  private ingest(store: Store, event: EventRecord, fullText?: string): { eventId: string; action: FilterAction } {
    const decision = decideIngest(event, store.listCandidates(false, 80), this.config, event.createdAt);
    event.salience = decision.salience;

    if (decision.action === 'keep') {
      store.addEvent(event, fullText);
      store.bumpCounter('filter.keep');
      return { eventId: event.id, action: 'keep' };
    }

    if (decision.action === 'merge' && decision.targetId) {
      const target = store.getEvent(decision.targetId);
      if (target && !target.archived) {
        store.updateEventMutable(target.id, { mergedCount: (target.mergedCount ?? 0) + 1 });
        store.bumpCounter('filter.merge');
        return { eventId: target.id, action: 'merge' };
      }
      // 合并目标已归档：退化为正常写入，别把内容弄丢
      store.addEvent(event, fullText);
      store.bumpCounter('filter.keep');
      return { eventId: event.id, action: 'keep' };
    }

    store.bumpCounter(decision.action === 'shield' ? 'filter.shield' : 'filter.drop');
    this.logger.debug('dsh-daughter: 认知滤网拦截', {
      action: decision.action,
      reason: decision.reason,
      title: event.title,
      salience: Number(decision.salience.toFixed(3)),
    });
    return { eventId: event.id, action: decision.action };
  }

  /** 取命中事件的全文摘录；全文不比摘要行更长时返回空，避免重复占预算 */
  private collectExcerpts(store: Store, hits: RetrievalHit[]): Map<string, string> {
    const excerpts = new Map<string, string>();
    for (const hit of hits) {
      const full = store.readFullText(hit.event.id).replace(/\s+/g, ' ').trim();
      const visible = Math.min(hit.event.summary.length, Daughter.DIGEST_SUMMARY_CHARS);
      if (full.length <= visible + 20) continue;
      excerpts.set(
        hit.event.id,
        truncate(full, Math.max(40, this.config.retrieval.fulltext_excerpt_chars)),
      );
    }
    return excerpts;
  }

  /**
   * 窗口名字：按第一次出现的顺序发「窗1」「窗2」并落库。
   * 早先用会话 id 的哈希（"窗SX"），谁也看不出那是什么意思；序号才是"哪个窗"。
   * 名字一旦发出去就不再变，换个窗口才拿新号。
   */
  private windowNamer(characterId: string): WindowNamer {
    const store = this.store(characterId);
    const names = store.loadWindowNames();
    const used = new Set(
      Object.values(names)
        .map((name) => Number(name.replace(/\D/g, '')))
        .filter((value) => Number.isFinite(value) && value > 0),
    );
    return (sessionId?: string | null): string => {
      if (!sessionId) return '旧窗口';
      const known = names[sessionId];
      if (known) return known;
      let next = 1;
      while (used.has(next)) next += 1;
      used.add(next);
      names[sessionId] = `窗${next}`;
      store.saveWindowNames(names);
      return names[sessionId]!;
    };
  }

  private store(characterId: string): Store {
    let store = this.stores.get(characterId);
    if (!store) {
      store = new Store(this.dataRoot, characterId, this.config.seed, this.logger, {
        lock: this.config.storage.single_writer,
        // 出生人格：抽样区间与依恋先验只在新建角色时生效
        personality: this.config.personality?.initial,
      });
      this.stores.set(characterId, store);
    }
    return store;
  }

  private getL5(ctx: PluginContext, persona: PersonaBundle): L5State {
    const cached = this.sessions.get(sessionKey(ctx));
    if (cached) return cached;
    const store = this.store(ctx.characterId);
    const loaded = store.loadL5(ctx.sessionId);
    // 新会话没有自己的快照时，接着上一段走（受 storage.shared_across_* 控制）
    const carried = loaded ? null : this.carriedL5(store, ctx, persona);
    const l5 = loaded
      ?? carried
      ?? createInitialL5(ctx.characterId, ctx.sessionId, ctx.now(), persona, store.loadOverdraft());
    l5.emotionalOverdraft = store.loadOverdraft();
    this.sessions.set(sessionKey(ctx), l5);
    return l5;
  }

  /**
   * 接力上一段「此刻」：间隔按 emotion_relax 复利回落，所以隔五分钟原样、隔一夜平复但不归零。
   * 隔离范围由配置决定：session（不接力）/ workspace（只在同一工作区内接力）/ character（默认）。
   */
  private carriedL5(store: Store, ctx: PluginContext, persona: PersonaBundle): L5State | null {
    const scope = this.carryScope(ctx);
    if (!scope) return null;
    // character 范围允许回退到"最近一次会话"：旧存档没有接力快照，升级当次也要能接上。
    // workspace 范围不回退——旧快照里没有 workspace 字段，猜一个等于把工作窗口串到私人窗口。
    const previous = store.loadL5Carry(scope) ?? (scope === 'character' ? store.latestL5() : null);
    if (!previous || previous.sessionId === ctx.sessionId) return null;
    return carryL5(previous, ctx.sessionId, ctx.now(), persona, this.config);
  }

  /** null = 不接力（每个会话从基线重新出生） */
  private carryScope(ctx: PluginContext): string | null {
    if (!this.config.storage.shared_across_sessions) return null;
    if (this.config.storage.shared_across_workspaces) return 'character';
    return `ws.${safeFileName(ctx.workspaceId)}`;
  }

  /** 写回 L5 的唯一出口：落盘 + 刷新接力快照，避免两条写入路径有一处忘了同步 */
  private commitL5(store: Store, ctx: PluginContext, l5: L5State): void {
    store.saveL5(l5);
    const scope = this.carryScope(ctx);
    if (scope) store.saveL5Carry(scope, l5);
    this.sessions.set(sessionKey(ctx), l5);
  }

  /** 记「这个会话已经走过首轮」。超上限按最久未用淘汰；早年是整体 clear()，会把老会话全打回首轮 */
  private markSeen(sessionId: string): void {
    this.seenSessions.delete(sessionId);
    this.seenSessions.add(sessionId);
    while (this.seenSessions.size > SEEN_SESSIONS_CAP) {
      const oldest = this.seenSessions.values().next().value;
      if (oldest === undefined) break;
      this.seenSessions.delete(oldest);
    }
  }

  private pickSubpersona(persona: PersonaBundle, audience: PluginContext['audience'], currentId: string): SubPersona {
    if (audience) {
      const found = persona.l4.subPersonas.find((item) => item.id === audience);
      if (found) return found;
    }
    return selectSubpersona(persona.l4, currentId);
  }

  private lastUserText(ctx: PluginContext): string | null {
    return this.userTextCache.get(sessionKey(ctx)) ?? null;
  }

  private readonly userTextCache = new Map<string, string>();
  private readonly sourceCache = new Map<string, EventRecord['source']>();

  private peekSafety(ctx: PluginContext, l5: L5State): SafetyVerdict {
    const store = this.store(ctx.characterId);
    return evaluateSafety(l5, store.loadSafetyState(), this.config, ctx.now()).verdict;
  }

  /** 按资产类型执行：MOT 走动作播放，其余按步骤调用工具 */
  private async executeAsset(
    asset: AssetPackage,
    ctx: PluginContext,
    args: Record<string, unknown>,
    l5: L5State,
  ): Promise<unknown> {
    if (asset.kind === 'MOT') {
      const raw = asset.payload.motionId;
      const explicit =
        typeof raw === 'string' && raw ? raw : typeof args.motionId === 'string' ? args.motionId : '';
      // 没有显式动作时按 PAD 在已固化的 MOT 资产里挑最接近的一个；都没标 padMatch 就不猜
      const picked = explicit ? null : pickMotionByPad(this.store(ctx.characterId).loadAssets(), l5.emotion);
      const motionId = explicit || picked?.motionId || '';
      if (!motionId) throw new Error('motion_id_missing');
      const played = await this.motionPlay({ ctx, motionId });
      if (!played.ok) throw new Error('motion_play_unavailable');
      return { motionId, assetId: asset.id };
    }

    const steps =
      (asset.payload.steps as
        | Array<{
            tool?: string;
            argsTemplate?: Record<string, unknown>;
            onFailure?: 'abort' | 'continue' | 'fallback';
          }>
        | undefined) ?? [];
    const invokeArgs = Object.fromEntries(Object.entries(args).filter(([key]) => !key.startsWith('__')));
    let output: unknown;

    for (const step of steps) {
      if (!step.tool) continue;
      try {
        output = await ctx.tools.invoke(step.tool, { ...step.argsTemplate, ...invokeArgs });
      } catch (error) {
        if (step.onFailure === 'continue' || step.onFailure === 'fallback') {
          this.logger.warn('资产步骤失败，按策略继续', {
            assetId: asset.id,
            tool: step.tool,
            error: String(error),
          });
          continue;
        }
        throw error;
      }
    }

    if (output !== undefined) return output;
    if (asset.kind === 'CON') return { connections: asset.payload.requiredTools ?? [] };
    if (asset.kind === 'CMB') return { components: asset.payload.components ?? [] };
    return { instructions: asset.payload.instructions ?? [] };
  }

  private registerAssetFailure(
    asset: AssetPackage,
    ctx: PluginContext,
    reason: string,
  ): { ok: boolean; rolledBack?: boolean; reason: string } {
    const store = this.store(ctx.characterId);
    const key = `assetFail:${asset.id}`;
    const failures = store.getMetaNumber(key, 0) + 1;
    store.setMeta(key, String(failures));
    if (failures >= 2) {
      this.rollbackAsset(asset, ctx, `连续失败自动回退：${reason}`);
      return { ok: false, rolledBack: true, reason };
    }
    return { ok: false, reason };
  }

  private rollbackAsset(asset: AssetPackage, ctx: PluginContext, reason: string): void {
    const store = this.store(ctx.characterId);
    const now = ctx.now();
    const rolledBack: AssetPackage = {
      ...asset,
      status: 'rolled_back',
      rollbackVersion: asset.rollbackVersion + 1,
    };
    store.saveAsset(rolledBack);

    // 回退到技能态：编译来源技能从 frozen 恢复为 active
    let skillStatus: string | undefined;
    if (asset.compiledFromSkillId) {
      const skill = store.loadSkills().find((item) => item.id === asset.compiledFromSkillId);
      if (skill && skill.status === 'frozen') {
        store.saveSkill({ ...skill, status: 'active', updatedAt: now });
        skillStatus = 'active';
      }
    }
    store.setMeta(`assetFail:${asset.id}`, '0');

    store.appendEvolution({
      id: store.newEvolutionId(now),
      characterId: ctx.characterId,
      target: 'asset',
      before: { status: asset.status, rollbackVersion: asset.rollbackVersion },
      after: { status: 'rolled_back', rollbackVersion: rolledBack.rollbackVersion, skillStatus },
      reason,
      at: now,
    });
    this.logger.warn('资产包回退到技能态', { assetId: asset.id, reason, skillStatus });
  }
}

function sessionKey(ctx: PluginContext): string {
  return `${ctx.characterId}::${ctx.sessionId}`;
}

function sentimentOf(text: string): number {
  const positive = ['好', '喜欢', '开心', '谢谢', '顺利'].filter((word) => text.includes(word)).length;
  const negative = ['烦', '累', '难过', '压力', '失望'].filter((word) => text.includes(word)).length;
  return positive === 0 && negative === 0 ? 0 : (positive - negative) / (positive + negative);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
