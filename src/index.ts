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
  SubPersona,
} from './types.js';
import type { Logger } from './util.js';
import { createRng, silentLogger, truncate } from './util.js';
import { applyBodySignal, pickMotionByPad } from './runtime/body-link.js';
import { decideIngest, type FilterAction } from './runtime/filter.js';
import { createInitialL5, selectSubpersona, updateL5 } from './runtime/state.js';
import { containsDiagnosisLabel, evaluateSafety } from './runtime/safety.js';
import {
  applySurprise,
  associateEvents,
  extractEvent,
  linkNewEvent,
  reconstructOnRecall,
  retrieveEvents,
} from './runtime/memory.js';
import {
  NO_MEMORY_CONSTRAINT,
  activateSkills,
  buildBlocks,
  buildEventDigest,
  buildPersonaText,
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

export interface PluginOptions {
  pluginRoot: string;
  config?: DaughterConfig;
  logger?: Logger;
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
  private readonly rng: () => number;
  private readonly onMotion?: (motionId: string) => void;

  constructor(options: PluginOptions) {
    this.logger = options.logger ?? silentLogger;
    this.config = options.config ?? loadConfig(options.pluginRoot, this.logger);
    this.dataRoot = resolveDataRoot(options.pluginRoot, this.config);
    this.rng = createRng(this.config.seed);
    this.onMotion = options.onMotion;
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
    store.saveL5(l5);
    this.sessions.set(sessionKey(ctx), l5);

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

    const associated = await this.associate({
      characterId: ctx.characterId,
      seedEventIds: withSurprise.map((hit) => hit.event.id),
      maxDepth: this.config.association.max_depth,
      maxInjected: this.config.association.max_injected,
    });

    const sub = this.pickSubpersona(persona, ctx.audience, l5.activeSubPersonaId);
    const memoryHit = withSurprise.length > 0;

    // 关系画像参与注入：亲密度/关系变化、事物偏好、善恶观
    const relationText = buildRelationText({
      person: buildPersonProfiles(store, now).find((profile) => !profile.self && profile.name === 'user'),
      things: buildThingProfiles(store, now).slice(0, 8),
      moral: persona.l3.moral,
    });

    // §10.1 降级收紧主动联想：档位 1 砍半，档位 2 起整个联想块不再注入
    const associationLimit =
      verdict.level >= 2 ? 0 : verdict.level >= 1 ? Math.ceil(associated.length / 2) : associated.length;
    const associationText =
      associationLimit > 0
        ? `[联想]\n${associated.slice(0, associationLimit).map((hit) => `- ${hit.eventId}（${hit.via.kind}）`).join('\n')}`
        : '';

    // §10.1 档位 ≥2：注入只保留情绪中性的记忆，避免降级时被高强度情绪记录带偏
    const digestHits =
      verdict.level >= 2
        ? withSurprise.filter((hit) => Math.abs(hit.event.emotionAtTime.pleasure) <= 0.2)
        : withSurprise;

    // §4.4 全文层：只在命中且全文确实比摘要更长时取摘录，由事件块的 cap 兜底
    const excerpts = this.config.retrieval.expand_fulltext
      ? this.collectExcerpts(store, digestHits)
      : undefined;

    const { blocks, usedTokens } = buildBlocks({
      personaText: [buildPersonaText(persona, sub), relationText, WORKING_STYLE].filter(Boolean).join('\n'),
      stateHint: buildStateHint(l5, verdict),
      eventDigest: buildEventDigest(digestHits, excerpts),
      skillDigest: buildSkillDigest(activation),
      associationText,
      constraint: memoryHit ? null : NO_MEMORY_CONSTRAINT,
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
    // 全文层写完整的问 + 答，摘要层只留压缩版（§4.4）
    const ingested = this.ingest(store, event, `${userText.trim()}\n→ ${assistantText.trim()}`.trim());
    if (ingested.action === 'keep') linkNewEvent(store, event);

    const cache = this.promptCache.get(sessionKey(ctx));
    const skillsUpdated: string[] = [];
    const evolutionIds: string[] = [];
    if (cache) {
      for (const hit of cache.hits) {
        const current = store.getEvent(hit.event.id);
        if (!current) continue;
        store.updateEventMutable(hit.event.id, {
          weight: Math.min(1, current.weight + this.config.decay.recall_boost),
          recallCount: current.recallCount + 1,
          lastRecalledAt: now,
        });
        reconstructOnRecall(store, current, l5, now);
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
    const skills = this.store(input.ctx.characterId).loadSkills();
    return activateSkills(skills, input.userText, {
      ...this.config,
      skills: {
        ...this.config.skills,
        max_main: Math.min(input.maxMain, this.config.skills.max_main),
        max_associated: Math.min(input.maxAssociated, this.config.skills.max_associated),
      },
    });
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
      store.saveL5(next);
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
    const event = extractEvent(input.ctx, input.text, '', l5, this.rng);
    event.source = input.source;
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
    const loaded = this.store(ctx.characterId).loadL5(ctx.sessionId);
    const l5 = loaded ?? createInitialL5(ctx.characterId, ctx.sessionId, ctx.now(), persona, this.store(ctx.characterId).loadOverdraft());
    this.sessions.set(sessionKey(ctx), l5);
    return l5;
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
