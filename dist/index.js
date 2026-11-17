import { loadConfig, resolveDataRoot } from './config.js';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { Store } from './store.js';
import { Observability } from './runtime/observability.js';
import { createRng, relativeTime, safeFileName, silentLogger, truncate } from './util.js';
import { applyBodySignal, pickMotionByPad } from './runtime/body-link.js';
import { decideIngest } from './runtime/filter.js';
import { analyzeSentiment, carryL5, createInitialL5, selectSubpersona, sentimentPolarity, updateL5, } from './runtime/state.js';
import { assignThread, isDialogueSource, pruneOpenThreads } from './runtime/threading.js';
import { evaluateSpeak, localDayKey } from './runtime/speak.js';
import { recordSpeakStats } from './runtime/speak-stats.js';
import { evaluateThink } from './runtime/think.js';
import { readForeground } from './runtime/desktop-observe.js';
import { containsDiagnosisLabel, evaluateSafety } from './runtime/safety.js';
import { logPolarity, prunePolarityLog } from './runtime/polarity-log.js';
import { SURPRISE_REASON, applySurprise, associateEvents, extractEvent, linkNewEvent, pickAssociationSeed, recallDrift, reconstructOnRecall, retrieveEvents, } from './runtime/memory.js';
import { NO_MATCH_CONSTRAINT, NO_MEMORY_CONSTRAINT, activateSkills, buildBlocks, buildCrossWindowDigest, buildEventDigest, buildPersonaText, buildThreadDigest, buildRelationText, buildSkillDigest, buildStateHint, clipBlocks, matchReflex, quotePriority, WORKING_STYLE, } from './runtime/content.js';
import { applyPersonalitySignal } from './runtime/personality.js';
import { applyPersonaDrift, buildPersonProfiles, buildStarMap, buildThingProfiles, bumpSkill, observeShadow, learnDraftSkill, maybeFreezeSkill, runTick, } from './runtime/maintenance.js';
/** §6.1 时延预算：超时只告警与记日志，不做硬中断（SQLite 同步查询无法中途取消） */
const RETRIEVE_BUDGET_MS = 150;
const BEFORE_PROMPT_BUDGET_MS = 100;
/** 换对话框后的第一句：接上"上一段对话的结尾"最多带几条、往前看多久 */
const CONTINUATION_LIMIT = 3;
const CONTINUATION_WINDOW_MS = 7 * 86_400_000;
/** 已见过首轮的会话集合上限（超出按最久未用淘汰，不再整体清空） */
const SEEN_SESSIONS_CAP = 512;
export function createDaughterPlugin(options) {
    return new Daughter(options);
}
export default createDaughterPlugin;
class Daughter {
    config;
    dataRoot;
    logger;
    stores = new Map();
    sessions = new Map();
    promptCache = new Map();
    observers = new Map();
    /** 角色级外部生理信号缓存（桌宠体力/心情），只参与派生有效状态 */
    bodyCache = new Map();
    /** 已处理过的 (sessionId, turnId)，用于 after_response 幂等，避免同一轮重复写事件记忆 */
    handledTurns = new Map();
    /** 已经构建过 prompt 的会话：只有第一次才允许"续接上一个对话" */
    seenSessions = new Set();
    /** 每个窗口已经贴过的"别处刚说的话"，跨窗口轨道靠它去重，避免同一件事反复提醒 */
    injectedCross = new Map();
    rng;
    onMotion;
    /** 连接器令牌：主动开口探测桌面桥时带上（§12.2） */
    connectorToken;
    constructor(options) {
        this.logger = options.logger ?? silentLogger;
        this.config = options.config ?? loadConfig(options.pluginRoot, this.logger);
        this.dataRoot = resolveDataRoot(options.pluginRoot, this.config);
        this.rng = createRng(this.config.seed);
        this.onMotion = options.onMotion;
        this.connectorToken = String(options.connectorToken ?? '');
    }
    async onUserMessage(input) {
        const { ctx, text } = input;
        const store = this.store(ctx.characterId);
        const persona = store.loadPersona();
        const now = ctx.now();
        const prev = this.getL5(ctx, persona);
        this.userTextCache.set(sessionKey(ctx), text);
        this.sourceCache.set(sessionKey(ctx), input.source);
        // 原始状态只由对话驱动；桌宠信号在 effective() 里叠加，存盘存原始值（§4.3）
        const l5 = updateL5(prev, text, now, persona);
        // A1 日志层：只记派生结果与命中词，不存原文；关闭时不留任何痕迹
        if (this.config.polarity_log?.enabled !== false) {
            const detail = analyzeSentiment(text);
            logPolarity(this.dataRoot, {
                at: now,
                characterId: ctx.characterId,
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                textHash: this.config.polarity_log?.include_text_hash === false
                    ? null
                    : createHash('sha256').update(text).digest('hex').slice(0, 16),
                hits: detail.hits,
                negations: detail.negations,
                positives: detail.positives,
                negatives: detail.negatives,
                polarity: detail.polarity,
                strength: detail.strength,
                padDelta: {
                    pleasure: Number((l5.emotion.pleasure - prev.emotion.pleasure).toFixed(4)),
                    arousal: Number((l5.emotion.arousal - prev.emotion.arousal).toFixed(4)),
                    dominance: Number((l5.emotion.dominance - prev.emotion.dominance).toFixed(4)),
                },
                padAfter: { ...l5.emotion },
                source: input.source,
            });
        }
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
    async beforePromptBuild(input) {
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
        const retrievalDegraded = ftsUnavailable ||
            (Boolean(query) && store.lastFtsError !== null) ||
            ((query ?? '').trim().length > 0 && (query ?? '').trim().length < 3);
        if (Boolean(query) && store.lastFtsError !== null) {
            this.logger.warn('dsh-daughter: FTS 检索失败，本轮退回 Dice 兜底', { error: store.lastFtsError });
        }
        const withSurprise = applySurprise(hits, store.listCandidates(true, this.config.retrieval.max_candidates), this.config, this.rng, now);
        const candidatePool = store.listCandidates(!this.config.retrieval.exclude_archived, this.config.retrieval.max_candidates);
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
        const continued = firstTurn && this.config.association.fallback_when_no_match
            ? store
                .listRecentEvents(new Date(Number.isFinite(nowMs) ? nowMs - CONTINUATION_WINDOW_MS : 0).toISOString(), CONTINUATION_LIMIT + hitIds.size)
                .filter((event) => !hitIds.has(event.id))
                .slice(0, CONTINUATION_LIMIT)
                .map((event) => ({ event, score: event.weight, reason: '续接（上一段对话的结尾）' }))
            : [];
        const continuedIds = new Set(continued.map((hit) => hit.event.id));
        // 窗口只是工位，不是记忆分区：别的窗口里刚说的话，每轮都补进来，
        // 这样"在 1 里说要去跑步，到 2 里说你好"才会接上一句"不是跑了吗"。
        const injectedCross = this.injectedCross.get(cacheKey) ?? new Set();
        const contentKey = (event) => `${event.title}\u0000${event.summary}`;
        const crossCandidates = this.config.continuity.enabled
            ? store
                .listRecentElsewhere(new Date(Number.isFinite(nowMs) ? nowMs - this.config.continuity.cross_window_minutes * 60_000 : 0).toISOString(), this.config.continuity.cross_window_max + injectedCross.size + hitIds.size + continuedIds.size, 
            // 原样会话 id：库里存的就是它，换成缓存键会让"排除本窗口"失效
            ctx.sessionId)
                .filter((event) => !hitIds.has(event.id) && !continuedIds.has(event.id) && !injectedCross.has(event.id))
                .map((event) => ({
                event,
                score: event.weight,
                reason: '跨窗口（刚在别处说的）',
                window: namer(event.sessionId),
            }))
            : [];
        // 同一个东西被记过好几次（同一个视频刷到五次），这一块只留最新的一条
        const seenCross = new Set();
        const crossWindow = crossCandidates.filter((hit) => {
            const key = contentKey(hit.event);
            if (seenCross.has(key))
                return false;
            seenCross.add(key);
            return true;
        }).slice(0, this.config.continuity.cross_window_max);
        for (const hit of crossWindow)
            injectedCross.add(hit.event.id);
        this.injectedCross.set(cacheKey, injectedCross);
        // 一条字面命中都没有时，仍然可以从记忆网里往外摸：
        // 人想不起直接对应的事，不会因此停止联想，而是从"当下情绪最像、时间最近"的那段记忆顺下去。
        let seedIds = withSurprise.map((hit) => hit.event.id);
        if (seedIds.length === 0 && this.config.association.fallback_when_no_match && continued.length === 0) {
            const seed = pickAssociationSeed(candidatePool, l5.emotion, now, this.config);
            if (seed)
                seedIds = [seed.id];
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
            .filter((item) => Boolean(item.event))
            // §10.1 档位 ≥2 的注入只保留情绪中性的引用
            .filter((item) => verdict.level < 2 || Math.abs(item.event.emotionAtTime.pleasure) <= 0.2)
            // 联想块也不收「用户没参与、又没有原话」的模板条目（刷视频、闲聊对答）
            .filter((item) => this.config.retrieval.prefer_quotes === false || quotePriority(item.event) > 0);
        // §10.1 降级收紧主动联想：档位 1 砍半，档位 2 起整个联想块不再注入
        const associationLimit = verdict.level >= 2 ? 0 : verdict.level >= 1 ? Math.ceil(associatedViews.length / 2) : associatedViews.length;
        // 联想块保留内容而不是只给 eventId：事件块可能被预算裁掉，联想块是它被裁后的备份；
        // 同时带上"由哪条想到"，这是事件块给不出的路径信息
        const associationText = associationLimit > 0
            ? `[联想]\n${associatedViews
                .slice(0, associationLimit)
                .map(({ hit, event }) => {
                const seed = hit.path && hit.path.length > 1 ? candidateById.get(hit.path[0]) : undefined;
                const bridge = seed ? `，由「${truncate(seed.title, 12)}」想到` : '';
                const hops = hit.depth ?? 1;
                // DEF-09：矛盾链接要和普通联想分开说，让两边说法并列出现，而不是挑一条当事实
                const relation = hit.via.kind === 'contradiction' ? '另一种说法' : hit.via.kind;
                return `- 【${event.id}】${relativeTime(event.createdAt, now)}｜${truncate(event.title, 24)}｜${truncate(event.summary, 60)}（${relation}${bridge}，${hops} 跳）`;
            })
                .join('\n')}`
            : '';
        // §10.1 档位 ≥2：注入只保留情绪中性的记忆，避免降级时被高强度情绪记录带偏
        const digestHits = verdict.level >= 2
            ? withSurprise.filter((hit) => Math.abs(hit.event.emotionAtTime.pleasure) <= 0.2)
            : withSurprise;
        // 联想出来的记忆也进事件块：联想块优先级低，预算一紧就被裁，
        // 内容先进事件块，才不会变成"想了但没说出口"
        const directIds = new Set(digestHits.map((hit) => hit.event.id));
        const associationDigest = associatedViews
            .filter(({ event }) => !directIds.has(event.id))
            .map(({ hit, event }) => ({
            event,
            score: hit.score,
            reason: `联想（${hit.via.kind}，${hit.depth ?? 1} 跳）`,
        }));
        const injectedHits = [...digestHits, ...associationDigest];
        // 选条目按「有没有原话」，不按话题标签：带具体原话、用户参与过的对话优先，
        // 模板化的刷视频/闲聊对答最多留 max_unquoted 条（默认 0），不再占着开头的位置。
        const maxUnquoted = Math.max(0, Math.round(this.config.retrieval.max_unquoted ?? 0));
        let unquotedLeft = maxUnquoted;
        const orderedHits = this.config.retrieval.prefer_quotes === false
            ? injectedHits
            : injectedHits
                .filter((hit) => {
                if (quotePriority(hit.event) > 0)
                    return true;
                if (unquotedLeft > 0) {
                    unquotedLeft -= 1;
                    return true;
                }
                return false;
            })
                .sort((a, b) => quotePriority(b.event) - quotePriority(a.event));
        // 续接条目不算召回强化：不进 promptCache.hits，也就不写 recallCount / weight，
        // 否则每开一个新窗口它都被强化一次，最后永远排在最前面。
        // 但它确实是注入内容，memoryHit 与约束判定统一在 openThreads 之后按「注入了什么」计算。
        // 跨窗口不进事件块：单独一块，独立预算，不受当前话题检索与预算裁剪影响
        // 同一条只贴一个地方：跨窗口块已经给过的内容，事件块不再重复贴一遍；
        // 事件块内部也按内容去重（同一个视频刷到五次，也只占一行）
        const crossKeys = new Set(crossWindow.map((hit) => contentKey(hit.event)));
        const seenContent = new Set();
        const injected = [...orderedHits, ...continued].filter((hit) => {
            const key = contentKey(hit.event);
            if (crossKeys.has(key) || seenContent.has(key))
                return false;
            seenContent.add(key);
            return true;
        });
        // §4.4 全文层：只在命中且全文确实比摘要更长时取摘录，由事件块的 cap 兜底
        const excerpts = this.config.retrieval.expand_fulltext
            ? this.collectExcerpts(store, injected)
            : undefined;
        // 进行中的局：角色级共享，两个窗口看到同一局的前情摘要（§8.2）
        const prunedThreads = this.config.threading.enabled
            ? pruneOpenThreads(store.loadOpenThreads(), now, this.config.threading.activity_ttl_minutes, 6, this.config.threading.closed_retention_minutes)
            : [];
        // 开着的最多 max_injected 局；另外固定带一条最近收尾的——
        // "结了没"得有个交代，昨晚那局也要留着落脚处，不能整段砍掉
        const openHeads = prunedThreads
            .filter((head) => head.status !== 'closed')
            .slice(0, this.config.threading.max_injected);
        const closedHead = prunedThreads.find((head) => head.status === 'closed');
        const openThreads = closedHead ? [...openHeads, closedHead] : openHeads;
        // 带上本窗口的名字与 id：局的最后一句要标清"这儿/别处"，不然自己的话会被当成对方的
        const threadText = buildThreadDigest(openThreads, now, ctx.sessionId, namer, this.config.threading.heading_source ?? 'first');
        // 与注入内容同口径：续接 / 跨窗口 / 局都算「有记忆可看」，只是不算召回强化
        const hasInjectedMemory = injected.length > 0 || crossWindow.length > 0 || openThreads.length > 0;
        const memoryHit = hasInjectedMemory;
        const { blocks, usedTokens } = buildBlocks({
            personaText: [buildPersonaText(persona, sub), relationText, WORKING_STYLE].filter(Boolean).join('\n'),
            stateHint: buildStateHint(l5, verdict),
            eventDigest: buildEventDigest(injected, excerpts, now, ctx.sessionId, namer),
            crossWindowText: buildCrossWindowDigest(crossWindow, now, ctx.sessionId, namer),
            threadText,
            skillDigest: buildSkillDigest(activation),
            associationText,
            // 只有空库才说「没有任何记录」；库非空但本轮零命中时只说「没检索到」，不撒谎
            constraint: hasInjectedMemory
                ? null
                : store.listCandidates(false, 1).length > 0
                    ? NO_MATCH_CONSTRAINT
                    : NO_MEMORY_CONSTRAINT,
            config: this.config,
        });
        const budget = Math.min(input.tokenBudget, this.config.budget.max_total_tokens);
        const clipped = usedTokens > budget ? clipBlocks(blocks, budget) : { blocks, usedTokens };
        this.promptCache.set(sessionKey(ctx), {
            sessionId: ctx.sessionId,
            // 随机联想只是「额外看一条」，不是真的被想起：不写 recallCount / weight，也不参与重构
            hits: withSurprise.filter((hit) => hit.reason !== SURPRISE_REASON),
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
    async afterResponse(input) {
        const { ctx, userText, assistantText } = input;
        const turnKey = `${ctx.sessionId}:${ctx.turnId}`;
        if (this.handledTurns.has(turnKey)) {
            this.logger.debug('afterResponse_skipped_duplicate', { sessionId: ctx.sessionId, turnId: ctx.turnId });
            return { skillsUpdated: [], evolutionIds: [] };
        }
        this.handledTurns.set(turnKey, Date.now());
        if (this.handledTurns.size > 512) {
            const oldest = this.handledTurns.keys().next();
            if (!oldest.done)
                this.handledTurns.delete(oldest.value);
        }
        const store = this.store(ctx.characterId);
        const persona = store.loadPersona();
        const now = ctx.now();
        const l5 = this.getL5(ctx, persona);
        const toolsUsed = input.toolsUsed ?? [];
        const event = extractEvent(ctx, userText, assistantText, l5, this.rng);
        // "局"归并：时间相邻 + 话题相似的事件归成一个 thread（跨窗口也算同一局）
        let openThreads = null;
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
                store.saveOpenThreads(pruneOpenThreads(openThreads, now, this.config.threading.activity_ttl_minutes, 6, this.config.threading.closed_retention_minutes));
            }
            linkNewEvent(store, event, 3, {
                enabled: this.config.association.contradiction_enabled,
                minGap: this.config.association.contradiction_min_gap,
            });
        }
        const cache = this.promptCache.get(sessionKey(ctx));
        const skillsUpdated = [];
        const evolutionIds = [];
        if (cache) {
            // 一次召回的多条记忆共享同一个"此刻"，只给情绪位移最大的那条记回看感受：
            // 否则一轮命中十几条就写十几行同样的情绪（真实库 24 行只用了两轮），
            // 而单条事件的 emotionNowHistory 上限只有 8 条，很快就被合并挤掉。
            let recallTarget = null;
            for (const hit of cache.hits) {
                const current = store.getEvent(hit.event.id);
                if (!current)
                    continue;
                store.updateEventMutable(hit.event.id, {
                    weight: Math.min(1, current.weight + this.config.decay.recall_boost),
                    recallCount: current.recallCount + 1,
                    lastRecalledAt: now,
                });
                const drift = recallDrift(current, l5.emotion);
                if (!recallTarget || drift > recallTarget.drift)
                    recallTarget = { event: current, drift };
            }
            if (recallTarget) {
                reconstructOnRecall(store, recallTarget.event, l5, now, this.config.retrieval.reconstruct_distance, this.config.retrieval.reconstruct_cooldown_minutes);
            }
            const main = cache.activation.main;
            if (main) {
                // 宿主给了工具证据就以证据判定成败，否则沿用「被激活即算成功」
                const succeeded = main.requiredTools.length === 0
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
                // 影子池（DEF-19）：同一轮的工具证据顺带判候选版本；没有证据的轮次不记样本
                observeShadow(store, updated, toolsUsed, this.config, now);
                const freeze = maybeFreezeSkill(store, updated, this.config, now);
                if (freeze.evolutionId)
                    evolutionIds.push(freeze.evolutionId);
            }
        }
        // §9.1 状态机入口：一轮里跑通了多步工具序列就沉淀成技能草稿
        const learned = learnDraftSkill(store, this.config, { userText, tools: toolsUsed, now });
        if (learned) {
            skillsUpdated.push(learned.skill.id);
            evolutionIds.push(learned.evolutionId);
        }
        const drift = applyPersonaDrift(store, this.config, persona, sentimentPolarity(userText), now);
        if (drift.changed && drift.evolutionId)
            evolutionIds.push(drift.evolutionId);
        // 性格演化：只有「累积 / 关键」事件才动 L1–L3，日常闲聊交给 L5（写实口径）
        const signal = applyPersonalitySignal(store, this.config, {
            text: userText,
            eventId: ingested.eventId,
            l5,
            now,
        });
        if (signal.changed)
            evolutionIds.push(...signal.evolutionIds);
        const label = this.config.safety.diagnosis_labels_forbidden ? containsDiagnosisLabel(assistantText) : null;
        if (label) {
            const entry = {
                id: store.newEvolutionId(now),
                characterId: store.characterId,
                target: 'safety',
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
    async retrieve(input) {
        const store = this.store(input.characterId);
        const candidates = store.listCandidates(!input.excludeArchived, this.config.retrieval.max_candidates);
        // FTS 已独立查全库：命中但不在权重候选池里的事件也要放行，
        // 否则事件超过 max_candidates 后，字面命中会被"权重前 N 条"截断。
        // 合并数量单独设上限，避免绕过 max_candidates。
        const mergeCap = Math.max(0, Math.round(this.config.retrieval.fts_merge_max ?? 200));
        // FTS 查询上限不能跟着候选池走：两者被同一个参数卡住时，池外命中根本取不到，
        // "合并放行"就失去意义。多取 mergeCap 条，保证池外候选有来源。
        const fts = store.searchFts(input.query, Math.max(20, this.config.retrieval.max_candidates + mergeCap));
        let pool = candidates;
        if (mergeCap > 0 && fts.size > 0) {
            const known = new Set(candidates.map((event) => event.id));
            const extra = [];
            for (const id of fts.keys()) {
                if (extra.length >= mergeCap)
                    break;
                if (known.has(id))
                    continue;
                const event = store.getEvent(id);
                if (event && !event.archived) {
                    known.add(id);
                    extra.push(event);
                }
            }
            if (extra.length > 0)
                pool = [...candidates, ...extra];
        }
        return retrieveEvents({
            ...input,
            config: this.config,
            candidates: pool,
            ftsScores: () => fts,
        });
    }
    async associate(input) {
        const store = this.store(input.characterId);
        const candidates = store.listCandidates(false, this.config.retrieval.max_candidates);
        return associateEvents(input.seedEventIds, candidates, Math.min(input.maxDepth, this.config.association.max_depth), Math.min(input.maxInjected, this.config.association.max_injected), this.config.association.hop_decay);
    }
    async skillActivate(input) {
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
        return activateSkills(skills, input.userText, {
            ...this.config,
            skills: {
                ...this.config.skills,
                max_main: Math.min(input.maxMain, this.config.skills.max_main),
                max_associated: Math.min(input.maxAssociated, this.config.skills.max_associated),
            },
        }, { now, l5, persona, subPersona, recentEvents });
    }
    async assetInvoke(input) {
        const store = this.store(input.ctx.characterId);
        const asset = store.loadAsset(input.assetId);
        if (!asset)
            return { ok: false, reason: 'asset_not_found' };
        if (asset.status !== 'active')
            return { ok: false, reason: 'asset_inactive' };
        const l5 = this.getL5(input.ctx, store.loadPersona());
        const verdict = this.safetyCheck({ ctx: input.ctx, l5 });
        if (!verdict.allowTools)
            return { ok: false, reason: 'safety_blocked' };
        const boundary = asset.payload.boundary;
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
        }
        catch (error) {
            return this.registerAssetFailure(asset, input.ctx, String(error));
        }
    }
    async reflexMatch(input) {
        const startedAt = performance.now();
        const store = this.store(input.ctx.characterId);
        const state = store.loadReflexState();
        const source = input.source ?? this.sourceCache.get(sessionKey(input.ctx));
        const matched = matchReflex(store.loadReflexRules(), input.userText, this.effective(input.ctx.characterId, input.l5, input.ctx.now()), state, input.ctx.now(), this.config, source);
        if (!matched)
            return null;
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
            const next = { ...input.l5, emotion: { ...input.l5.emotion } };
            for (const [key, value] of Object.entries(matched.action.delta)) {
                if (typeof value !== 'number')
                    continue;
                if (key === 'stress')
                    next.stress = Math.min(1, Math.max(0, next.stress + value));
                else
                    next.emotion[key] = Math.min(1, Math.max(-1, next.emotion[key] + value));
            }
            this.commitL5(store, input.ctx, next);
        }
        let ok = true;
        if (matched.action.kind === 'motion') {
            const played = await this.motionPlay({ ctx: input.ctx, motionId: matched.action.motionId });
            ok = played.ok;
            if (!played.ok)
                this.logger.warn('反射动作播放失败', { ruleId: matched.rule.id, motionId: matched.action.motionId });
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
    async motionPlay(input) {
        if (!input.ctx.emit && !this.onMotion)
            return { ok: false };
        this.onMotion?.(input.motionId);
        input.ctx.emit?.('motion.play', { motionId: input.motionId, sessionId: input.ctx.sessionId });
        return { ok: true };
    }
    async ingestExternalEvent(input) {
        const store = this.store(input.ctx.characterId);
        const persona = store.loadPersona();
        const l5 = this.getL5(input.ctx, persona);
        // 来源要在建事件时就定：参与者、显著性都要按来源推导，事后改 source 已经来不及
        const event = extractEvent(input.ctx, input.text, '', l5, this.rng, input.source);
        const ingested = this.ingest(store, event, input.text);
        if (ingested.action === 'keep') {
            linkNewEvent(store, event, 3, {
                enabled: this.config.association.contradiction_enabled,
                minGap: this.config.association.contradiction_min_gap,
            });
        }
        this.logger.debug('ingest_external_event', {
            source: input.source,
            eventId: ingested.eventId,
            action: ingested.action,
        });
        return { eventId: ingested.eventId };
    }
    async tick(input) {
        const result = runTick(this.store(input.characterId), this.config, input.now);
        if (this.config.polarity_log?.enabled !== false) {
            prunePolarityLog(this.dataRoot, input.characterId, this.config.polarity_log.retention_days, input.now);
        }
        return result;
    }
    /** 最近活跃会话的 L5 快照：回答"她此刻在跟谁相处"，供开口/碎碎念共用 */
    latestL5State(characterId) {
        const store = this.store(characterId);
        let latest = null;
        let latestAt = Number.NEGATIVE_INFINITY;
        for (const sessionId of store.listL5Sessions()) {
            const candidate = store.loadL5(sessionId);
            if (!candidate)
                continue;
            const at = Date.parse(candidate.lastTickAt);
            if (Number.isFinite(at) && at > latestAt) {
                latestAt = at;
                latest = candidate;
            }
        }
        return latest;
    }
    /**
     * 主动开口评估：没人说话的时候，她想不想开口。
     * 决策在 `runtime/speak.ts` 里是纯函数，这里只负责取上下文、读写
     * "今天说了几次 / 憋了多久"，投递（气泡、面板）交给宿主。
     */
    async speakPlan(input) {
        // 影子模式也要评估：它本来就是用来"先看会说什么"的
        if (!this.config.speak.enabled && !this.config.speak.shadow)
            return null;
        const shadow = this.config.speak.shadow;
        const nowMs = Date.parse(input.now);
        if (!Number.isFinite(nowMs))
            return null;
        const store = this.store(input.characterId);
        const persona = store.loadPersona();
        // 首次运行记一个锚点：刚装上不该立刻自言自语
        if (store.getMeta('speak.bootAt') === null)
            store.setMeta('speak.bootAt', input.now);
        // 用最近活跃的会话当"她此刻在跟谁说话"
        const latestL5 = this.latestL5State(input.characterId);
        const l5 = latestL5 ? this.effective(input.characterId, latestL5, input.now) : undefined;
        const lastAtRaw = store.getMeta('speak.lastAt');
        // 第一次评估（刚打开开关）先当"刚联系过"：否则沉默几小时后一开启就冒一句，
        // 像定时任务而不是想起你。之后交给冷却与 min_idle 管。
        // 影子模式不写冷却锚点：只观察，不能改变真实开口的节奏。
        if (!shadow && lastAtRaw === null) {
            store.setMeta('speak.lastAt', input.now);
            return null;
        }
        const lastAtMs = lastAtRaw === null ? Number.NaN : Date.parse(lastAtRaw);
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
        const plan = evaluateSpeak({
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
        }, this.config, {
            recentLines,
            seed: `${input.characterId}:${localDayKey(input.now)}:${todayCount}:${Math.round(idleMinutes)}`,
        });
        // 统计先记账：影子模式与正式模式都记，面板才能看到真实的沉默比例
        if (this.config.speak.stats) {
            store.setMeta('speak.stats', recordSpeakStats(store.getMeta('speak.stats'), plan, localDayKey(input.now), input.now));
        }
        // 影子模式到此为止：不写冷却、不写日计数、不写记忆、不搬 carry——
        // 观察动作本身不能改变被观察的行为。
        if (shadow) {
            this.logger.debug('speak_shadow', {
                decision: plan.decision,
                reason: plan.reason,
                urge: Number(plan.urge.toFixed(3)),
                threshold: Number(plan.threshold.toFixed(3)),
                idleMinutes: Math.round(idleMinutes),
            });
            return { ...plan, shadow: true };
        }
        store.setMeta('speak.carry', String(plan.carry));
        if (plan.decision === 'act') {
            store.setMeta('speak.lastAt', input.now);
            store.setMeta(dayKey, String(todayCount + 1));
            // 主动开口也留进记忆：否则"她说过的话"只有面板能翻到，检索不到。
            // 低权重 + participants 只记 self：可被想起，但不构成共同经历、不推关系。
            if (plan.text)
                this.recordSelfSpeech(input.characterId, plan.text, input.now, l5);
            if (plan.lineIndex !== undefined) {
                store.setMeta('speak.recentLines', [...recentLines, plan.lineIndex].slice(-5).join(','));
            }
            // 留痕：面板要能翻到"她说过什么"，否则这个功能是黑盒
            const historyRaw = store.getMeta('speak.history');
            let history = [];
            if (historyRaw) {
                try {
                    history = JSON.parse(historyRaw);
                }
                catch {
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
        }
        else if (plan.decision === 'hold') {
            // "想说但忍住"只记次数，不记全文——否则一天几百条噪声
            const holdKey = `speak.hold.${localDayKey(input.now)}`;
            store.setMeta(holdKey, String(store.getMetaNumber(holdKey, 0) + 1));
        }
        return plan;
    }
    /**
     * 碎碎念评估（DEF-23）：只返回短句，**不写事件、不推关系、不占正式回复**。
     * 决策在 `runtime/think.ts` 里是纯函数；这里只管节流锚点与上下文。
     */
    async thinkPlan(input) {
        if (!this.config.think.enabled)
            return null;
        const nowMs = Date.parse(input.now);
        if (!Number.isFinite(nowMs))
            return null;
        const store = this.store(input.characterId);
        const lastAtRaw = store.getMeta('think.lastAt');
        const lastAtMs = lastAtRaw === null ? Number.NaN : Date.parse(lastAtRaw);
        const sinceLastThinkMinutes = Number.isFinite(lastAtMs)
            ? Math.max(0, (nowMs - lastAtMs) / 60_000)
            : null;
        const latest = this.latestL5State(input.characterId);
        const l5 = latest ? this.effective(input.characterId, latest, input.now) : undefined;
        const minute = Math.floor(nowMs / 60_000);
        const plan = evaluateThink({
            now: input.now,
            l5,
            sinceLastThinkMinutes,
            jitter: input.jitter,
        }, this.config, { seed: `${input.characterId}:think:${minute}` });
        if (!plan)
            return null;
        store.setMeta('think.lastAt', input.now);
        this.logger.debug('think_act', {
            reason: plan.reason,
            intensity: Number(plan.intensity.toFixed(3)),
            count: plan.lines.length,
        });
        return plan;
    }
    /**
     * 主动开口写回（DEF-02）：低权重、participants 只记 self。
     * 它不参与关系推进（evolvePersona 只在 afterResponse 走），只让"我说过的话"可被检索。
     */
    recordSelfSpeech(characterId, text, now, l5) {
        const content = text.trim();
        if (!content)
            return null;
        const store = this.store(characterId);
        const stamp = now.replace(/\D/g, '').slice(0, 14);
        const intensity = l5
            ? Math.max(0, Math.min(1, Math.abs(l5.emotion.pleasure) * 0.6 + l5.stress * 0.4))
            : 0;
        const event = {
            id: `EVT-${stamp}-self-${Math.floor(this.rng() * 1e6).toString(16)}`,
            characterId,
            title: truncate(content, 40),
            summary: content,
            tags: ['自我开口'],
            participants: ['self'],
            emotionAtTime: { ...(l5?.emotion ?? { pleasure: 0, arousal: 0, dominance: 0 }), intensity },
            emotionNowHistory: [],
            importance: 0.3,
            weight: 0.3,
            links: [],
            source: 'self_speech',
            createdAt: now,
            recallCount: 0,
            archived: false,
            schemaVersion: 1,
        };
        const result = this.ingest(store, event, content);
        return { eventId: result.eventId };
    }
    /** 面板入口读取星图：按当前库实时重算并落盘 */
    starMap(characterId, now) {
        return buildStarMap(this.store(characterId), now);
    }
    /**
     * 接收桌宠上报的生理信号。关闭 body_link 时直接忽略：
     * 桌宠在不在，插件的记忆与人格路径完全一致。
     */
    syncBodySignal(input) {
        if (!this.config.vpet.enabled || !this.config.vpet.body_link.enabled)
            return;
        const signal = {
            strength: Math.min(1, Math.max(0, Number(input.strength))),
            feeling: Math.min(1, Math.max(0, Number(input.feeling))),
            source: input.source ?? 'vpet',
            at: new Date().toISOString(),
        };
        if (!Number.isFinite(signal.strength) || !Number.isFinite(signal.feeling))
            return;
        this.bodyCache.set(input.characterId, signal);
        try {
            this.store(input.characterId).saveBodySignal(signal);
        }
        catch (error) {
            this.logger.warn('dsh-daughter: 生理信号落盘失败', { error: String(error) });
        }
    }
    safetyCheck(input) {
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
    close() {
        for (const store of this.stores.values())
            store.close();
        this.stores.clear();
        this.sessions.clear();
        this.promptCache.clear();
        this.userTextCache.clear();
        this.sourceCache.clear();
        this.injectedCross.clear();
        this.observers.clear();
        this.bodyCache.clear();
    }
    metrics(characterId) {
        return this.observer(characterId).metrics();
    }
    /** 最近一次可用的外部生理信号；缓存优先，重启后从 prefrontal 读回，过期自然失效 */
    bodySignal(characterId) {
        if (this.bodyCache.has(characterId))
            return this.bodyCache.get(characterId) ?? null;
        let signal = null;
        try {
            signal = this.store(characterId).loadBodySignal();
        }
        catch {
            signal = null;
        }
        this.bodyCache.set(characterId, signal);
        return signal;
    }
    /** 派生有效状态：只抬升疲劳/压力，不写回、不落盘 */
    effective(characterId, l5, now) {
        const config = this.config.vpet.body_link;
        if (!config.enabled)
            return l5;
        const signal = l5.body ?? this.bodySignal(characterId);
        return applyBodySignal({ ...l5, body: signal }, config, now);
    }
    observer(characterId) {
        let observer = this.observers.get(characterId);
        if (!observer) {
            observer = new Observability(this.dataRoot, characterId);
            this.observers.set(characterId, observer);
        }
        return observer;
    }
    /** 注入里摘要行可见的字符数（与 buildEventDigest 的 truncate 上限一致） */
    static DIGEST_SUMMARY_CHARS = 70;
    /**
     * 认知滤网的唯一落地点：keep 才写库，merge 只累加计数，drop/shield 仅记统计。
     * 判据全部在 runtime/filter.ts，这里只负责落地。
     */
    ingest(store, event, fullText) {
        // 滤网要的是「最近」而不是「权重最高」：listCandidates 按 weight DESC 排序，
        // 事件一多，高权重旧事会把刚发生的新事件挤出去，爆发抑制、同题合并与新颖性一起漏判。
        // 回溯窗口取三个判据里最长的一个，覆盖所有需要比对的历史。
        const windowMinutes = Math.max(this.config.filter.habituation.window_minutes, this.config.filter.habituation.identical_window_minutes, this.config.filter.burst.window_minutes);
        const createdMs = Date.parse(event.createdAt);
        const since = Number.isFinite(createdMs)
            ? new Date(Math.max(0, createdMs - windowMinutes * 60_000)).toISOString()
            : new Date(0).toISOString();
        const decision = decideIngest(event, store.listRecentEvents(since, 80), this.config, event.createdAt);
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
        if (decision.reason.startsWith('内容筛：'))
            store.bumpCounter('filter.invalid');
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
    collectExcerpts(store, hits) {
        const excerpts = new Map();
        for (const hit of hits) {
            const full = store.readFullText(hit.event.id).replace(/\s+/g, ' ').trim();
            const visible = Math.min(hit.event.summary.length, Daughter.DIGEST_SUMMARY_CHARS);
            if (full.length <= visible + 20)
                continue;
            excerpts.set(hit.event.id, truncate(full, Math.max(40, this.config.retrieval.fulltext_excerpt_chars)));
        }
        return excerpts;
    }
    /**
     * 窗口名字：按第一次出现的顺序发「窗1」「窗2」并落库。
     * 早先用会话 id 的哈希（"窗SX"），谁也看不出那是什么意思；序号才是"哪个窗"。
     * 名字一旦发出去就不再变，换个窗口才拿新号。
     */
    windowNamer(characterId) {
        const store = this.store(characterId);
        const names = store.loadWindowNames();
        const used = new Set(Object.values(names)
            .map((name) => Number(name.replace(/\D/g, '')))
            .filter((value) => Number.isFinite(value) && value > 0));
        return (sessionId) => {
            if (!sessionId)
                return '旧窗口';
            const known = names[sessionId];
            if (known)
                return known;
            let next = 1;
            while (used.has(next))
                next += 1;
            used.add(next);
            names[sessionId] = `窗${next}`;
            store.saveWindowNames(names);
            return names[sessionId];
        };
    }
    store(characterId) {
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
    getL5(ctx, persona) {
        const cached = this.sessions.get(sessionKey(ctx));
        if (cached)
            return cached;
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
    carriedL5(store, ctx, persona) {
        const scope = this.carryScope(ctx);
        if (!scope)
            return null;
        // character 范围允许回退到"最近一次会话"：旧存档没有接力快照，升级当次也要能接上。
        // workspace 范围不回退——旧快照里没有 workspace 字段，猜一个等于把工作窗口串到私人窗口。
        const previous = store.loadL5Carry(scope) ?? (scope === 'character' ? store.latestL5() : null);
        if (!previous || previous.sessionId === ctx.sessionId)
            return null;
        return carryL5(previous, ctx.sessionId, ctx.now(), persona, this.config);
    }
    /** null = 不接力（每个会话从基线重新出生） */
    carryScope(ctx) {
        if (!this.config.storage.shared_across_sessions)
            return null;
        if (this.config.storage.shared_across_workspaces)
            return 'character';
        return `ws.${safeFileName(ctx.workspaceId)}`;
    }
    /** 写回 L5 的唯一出口：落盘 + 刷新接力快照，避免两条写入路径有一处忘了同步 */
    commitL5(store, ctx, l5) {
        store.saveL5(l5);
        const scope = this.carryScope(ctx);
        if (scope)
            store.saveL5Carry(scope, l5);
        this.sessions.set(sessionKey(ctx), l5);
    }
    /** 记「这个会话已经走过首轮」。超上限按最久未用淘汰；早年是整体 clear()，会把老会话全打回首轮 */
    markSeen(sessionId) {
        this.seenSessions.delete(sessionId);
        this.seenSessions.add(sessionId);
        while (this.seenSessions.size > SEEN_SESSIONS_CAP) {
            const oldest = this.seenSessions.values().next().value;
            if (oldest === undefined)
                break;
            this.seenSessions.delete(oldest);
        }
    }
    pickSubpersona(persona, audience, currentId) {
        if (audience) {
            const found = persona.l4.subPersonas.find((item) => item.id === audience);
            if (found)
                return found;
        }
        return selectSubpersona(persona.l4, currentId);
    }
    lastUserText(ctx) {
        return this.userTextCache.get(sessionKey(ctx)) ?? null;
    }
    userTextCache = new Map();
    sourceCache = new Map();
    peekSafety(ctx, l5) {
        const store = this.store(ctx.characterId);
        return evaluateSafety(l5, store.loadSafetyState(), this.config, ctx.now()).verdict;
    }
    /** 按资产类型执行：MOT 走动作播放，其余按步骤调用工具 */
    async executeAsset(asset, ctx, args, l5) {
        if (asset.kind === 'MOT') {
            const raw = asset.payload.motionId;
            const explicit = typeof raw === 'string' && raw ? raw : typeof args.motionId === 'string' ? args.motionId : '';
            // 没有显式动作时按 PAD 在已固化的 MOT 资产里挑最接近的一个；都没标 padMatch 就不猜
            const picked = explicit ? null : pickMotionByPad(this.store(ctx.characterId).loadAssets(), l5.emotion);
            const motionId = explicit || picked?.motionId || '';
            if (!motionId)
                throw new Error('motion_id_missing');
            const played = await this.motionPlay({ ctx, motionId });
            if (!played.ok)
                throw new Error('motion_play_unavailable');
            return { motionId, assetId: asset.id };
        }
        const steps = asset.payload.steps ?? [];
        const invokeArgs = Object.fromEntries(Object.entries(args).filter(([key]) => !key.startsWith('__')));
        let output;
        for (const step of steps) {
            if (!step.tool)
                continue;
            try {
                output = await ctx.tools.invoke(step.tool, { ...step.argsTemplate, ...invokeArgs });
            }
            catch (error) {
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
        if (output !== undefined)
            return output;
        if (asset.kind === 'CON')
            return { connections: asset.payload.requiredTools ?? [] };
        if (asset.kind === 'CMB')
            return { components: asset.payload.components ?? [] };
        return { instructions: asset.payload.instructions ?? [] };
    }
    registerAssetFailure(asset, ctx, reason) {
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
    rollbackAsset(asset, ctx, reason) {
        const store = this.store(ctx.characterId);
        const now = ctx.now();
        const rolledBack = {
            ...asset,
            status: 'rolled_back',
            rollbackVersion: asset.rollbackVersion + 1,
        };
        store.saveAsset(rolledBack);
        // 回退到技能态：编译来源技能从 frozen 恢复为 active
        let skillStatus;
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
function sessionKey(ctx) {
    return `${ctx.characterId}::${ctx.sessionId}`;
}
function round(value) {
    return Math.round(value * 100) / 100;
}
