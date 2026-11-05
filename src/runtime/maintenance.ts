import type {
  AssetKind,
  AssetPackage,
  DaughterConfig,
  EvolutionLogEntry,
  L1Baseline,
  L2Relationship,
  L5State,
  PadState,
  PersonaBundle,
  SkillCard,
} from '../types.js';
import type { Store } from '../store.js';
import { buildStarPanels } from './panels.js';
import { clamp01, daysBetween, truncate } from '../util.js';
import { forgetSweep } from './filter.js';

export function runTick(
  store: Store,
  config: DaughterConfig,
  now: string,
): {
  decayed: number;
  archived: number;
  forgotten: number;
  recovered: boolean;
  prunedLogs: number;
  evolved: string[];
  /** 本轮做了回落（向基线回归）的会话数 */
  relaxed: number;
} {
  let decayed = 0;
  let archived = 0;

  const events = store.listAllEvents();
  const lastTickRaw = store.getMeta('lastTickAt');
  const fallbackMs = events.length > 0 ? Math.min(...events.map((event) => Date.parse(event.createdAt))) : Date.parse(now);
  const lastTickMs = lastTickRaw === null ? fallbackMs : Number(lastTickRaw);
  const elapsedDays = Math.min(365, Math.max(0.01, (Date.parse(now) - lastTickMs) / 86_400_000));
  const factor = Math.pow(1 - config.decay.weight_decay_rate, elapsedDays);

  const archivedIds: string[] = [];

  for (const event of events) {
    if (event.archived) continue;
    // importance 是写入时算出的固有重要性，之前只算不用。用它调衰减指数而不是设地板：
    // 重要的事掉得慢，但依然单调衰减、迟早能归档（设地板会让热点事件永不消失）
    const importanceFactor = Math.pow(factor, Math.max(0.25, 1 - event.importance));
    const nextWeight = clamp01(event.weight * importanceFactor);
    const idleReference = event.lastRecalledAt ?? event.createdAt;
    const shouldArchive =
      nextWeight < config.decay.archive_threshold && daysBetween(idleReference, now) >= config.decay.archive_idle_days;

    if (shouldArchive) {
      // 归档落盘：完整记录写入 archive/，索引行只置 archived 标记
      store.archiveEvent(event);
      archivedIds.push(event.id);
    }
    store.updateEventMutable(event.id, { weight: nextWeight, archived: shouldArchive });
    if (nextWeight !== event.weight) decayed += 1;
    if (shouldArchive) archived += 1;
  }

  store.setMeta('lastTickAt', String(Date.parse(now)));

  // 认知滤网的忘却扫描：显著性低 + 从未被想起 + 长期闲置 → 归档（不物理删除）
  const newlyArchived = new Set(events.filter((event) => event.archived).map((event) => event.id));
  const forget = forgetSweep(events, config, now);
  let forgotten = 0;
  for (const id of forget.ids) {
    if (newlyArchived.has(id)) continue;
    const event = store.getEvent(id);
    if (!event || event.archived) continue;
    store.archiveEvent(event);
    store.updateEventMutable(id, { archived: true });
    store.bumpCounter('filter.forget');
    archivedIds.push(id);
    forgotten += 1;
  }

  // 归档后摘链：不做的话 links 会一直指向已归档事件，出度虚高、联想空转。
  // 传全量归档集合而不是本轮 ids——历史归档（含早期批量清理）留下的悬空边也要一起收掉
  if (archivedIds.length > 0) {
    store.detachLinks(store.listAllEvents().filter((event) => event.archived).map((event) => event.id));
  }

  const overdraft = store.loadOverdraft();
  const nextOverdraft = clamp01(overdraft - 0.1 * elapsedDays);
  if (nextOverdraft !== overdraft) store.saveOverdraft(nextOverdraft);

  const prunedLogs = store.pruneEvolutionLogs(config.evolution.log_retention_days, now);

  const relaxed = relaxL5(store, config, now);

  const evolved = evolvePersona(store, now);

  buildStarMap(store, now);

  return { decayed, archived, forgotten, recovered: nextOverdraft < overdraft, prunedLogs, evolved, relaxed };
}

/**
 * 情感回落：stress / fatigue / safety 与 PAD 一起向基线回归。
 *
 * 之前只有对话内的「+0.12 / −0.04」，没有任何回落，于是 safety 一路贴到 1.00、
 * stress 贴到 0.00，量程耗尽后情绪维度不再产生信息。按闲置小时数复利回归，
 * 连续对话时几乎不生效，隔夜才会明显回落——这也是「情绪会自己淡下去」的样子。
 */
export function relaxL5(store: Store, config: DaughterConfig, now: string): number {
  const relax = config.emotion_relax;
  if (!relax.enabled || relax.rate_per_hour <= 0) return 0;

  const persona = store.loadPersona();
  if (!persona) return 0;
  const baseline = persona.l1.moodBaseline;
  let changed = 0;

  for (const sessionId of store.listL5Sessions()) {
    const l5 = store.loadL5(sessionId);
    if (!l5) continue;
    const idleHours = (Date.parse(now) - Date.parse(l5.lastTickAt)) / 3_600_000;
    if (!Number.isFinite(idleHours) || idleHours < relax.idle_hours) continue;

    // 按小时复利：离线一天也不会一步跳回基线
    const ratio = 1 - Math.pow(1 - relax.rate_per_hour, idleHours);
    const pull = (value: number, target: number): number => Number((value + (target - value) * ratio).toFixed(4));

    const next: L5State = {
      ...l5,
      emotion: {
        pleasure: pull(l5.emotion.pleasure, baseline.pleasure),
        arousal: pull(l5.emotion.arousal, baseline.arousal),
        dominance: pull(l5.emotion.dominance, baseline.dominance),
      },
      stress: pull(l5.stress, relax.stress_baseline),
      fatigue: pull(l5.fatigue, relax.fatigue_baseline),
      safety: pull(l5.safety, relax.safety_baseline),
      snapshotAt: now,
    };
    // 与 updateL5 保持一致：回落后不再满足「持续超阈值」，计时起点要清掉
    next.stressHighSince = next.stress >= 0.7 ? l5.stressHighSince : undefined;
    next.safetyLowSince = next.safety <= 0.35 ? l5.safetyLowSince : undefined;

    const moved =
      Math.abs(next.stress - l5.stress) >= 0.005 ||
      Math.abs(next.fatigue - l5.fatigue) >= 0.005 ||
      Math.abs(next.safety - l5.safety) >= 0.005 ||
      Math.abs(next.emotion.pleasure - l5.emotion.pleasure) >= 0.005 ||
      Math.abs(next.emotion.arousal - l5.emotion.arousal) >= 0.005 ||
      Math.abs(next.emotion.dominance - l5.emotion.dominance) >= 0.005;
    if (!moved) continue;

    // 只更新 snapshotAt，lastTickAt 保持「最后一次对话时间」，否则下一轮 idle 会被自己清零
    store.saveL5(next);
    changed += 1;
  }

  return changed;
}

const REL_STAGES = ['stranger', 'acquaintance', 'familiar', 'close', 'dependent'] as const;
const REL_THRESHOLDS = [0, 0.15, 0.35, 0.65, 0.85];

function round3(value: number): number {
  return Number(value.toFixed(3));
}

/** 关系阶段只允许逐级推进；回退要求深度低于当前阶段阈值 0.1，避免边界抖动 */
function nextRelationshipStage(
  current: L2Relationship['relationshipStage'],
  depth: number,
): L2Relationship['relationshipStage'] {
  const index = REL_STAGES.indexOf(current);
  let target = index;
  for (let i = REL_STAGES.length - 1; i >= 0; i -= 1) {
    if (depth >= REL_THRESHOLDS[i]!) {
      target = i;
      break;
    }
  }
  if (target > index) return REL_STAGES[Math.min(index + 1, REL_STAGES.length - 1)]!;
  if (target < index && depth < REL_THRESHOLDS[index]! - 0.1) return REL_STAGES[index - 1]!;
  return current;
}

/** 归一化一组权重；总和为 0 时退化为等权，保证永不全零 */
function normalizeValues(values: number[]): { values: number[]; changed: boolean } {
  const sum = values.reduce((total, value) => total + value, 0);
  const next = sum > 0
    ? values.map((value) => round3(value / sum))
    : values.map(() => round3(1 / Math.max(1, values.length)));
  const changed = next.some((value, index) => Math.abs(value - values[index]!) >= 0.001);
  return { values: next, changed };
}

/**
 * L2/L3/L4 低频写回：每天最多一次，每次变更都写 evolution 日志（G5）。
 * L2 关系深度向与「self」的亲密度平滑靠拢；L3 依近 7 天情绪缓慢调整防御成熟度并归一化权重；
 * L4 子人格权重每次更新后归一化。
 */
export function evolvePersona(store: Store, now: string): string[] {
  const last = store.getMeta('lastPersonaEvolveAt');
  if (last !== null && daysBetween(last, now) < 1) return [];

  const persona: PersonaBundle = store.loadPersona();
  const changed: string[] = [];
  const nowMs = Date.parse(now);
  /** 近 7 天非归档事件：L2 的互动质量与 L3 的防御成熟度都基于它 */
  const recent = store
    .listAllEvents()
    .filter((event) => !event.archived && nowMs - Date.parse(event.createdAt) <= 7 * 86_400_000);

  // L2 关系动机
  // 原实现拿 self.intimacy 当目标：self 出现在全部事件里，intimacy 必然逼近 1.0，
  // 关系深度于是只会单向爬升，跟「最近聊得好不好」完全无关。
  const profiles = buildPersonProfiles(store, now);
  const user = profiles.find((profile) => !profile.self && profile.name === 'user');
  const weightSum = recent.reduce((sum, event) => sum + Math.max(0.01, event.weight), 0);
  const avgPleasure = weightSum > 0
    ? recent.reduce((sum, event) => sum + event.emotionAtTime.pleasure * Math.max(0.01, event.weight), 0) / weightSum
    : 0;
  // 0..1 的互动质量：负面多时趋近 0，正面多时趋近 1
  const quality = clamp01(0.5 + avgPleasure);
  const beforeL2 = persona.l2;
  const rawTarget = user ? clamp01(user.intimacy) : beforeL2.relationshipDepth;
  // 目标按互动质量打折：长期被冷落或吵架时，关系深度要能被拉回来
  const targetDepth = clamp01(rawTarget * (0.55 + 0.45 * quality));
  const gap = targetDepth - beforeL2.relationshipDepth;
  const step = gap > 0 ? 0.04 + 0.08 * quality : 0.12;
  const depth = Math.abs(gap) <= 0.01
    ? targetDepth
    : clamp01(beforeL2.relationshipDepth + Math.sign(gap) * Math.min(Math.abs(gap), step));
  const stage = nextRelationshipStage(beforeL2.relationshipStage, depth);
  const trustBaseline = clamp01(beforeL2.trustBaseline * 0.9 + depth * 0.1);
  const l2: L2Relationship = {
    ...beforeL2,
    relationshipDepth: round3(depth),
    relationshipStage: stage,
    trustBaseline: round3(trustBaseline),
    updatedAt: now,
  };
  if (
    stage !== beforeL2.relationshipStage ||
    Math.abs(l2.relationshipDepth - beforeL2.relationshipDepth) >= 0.01 ||
    Math.abs(l2.trustBaseline - beforeL2.trustBaseline) >= 0.01
  ) {
    store.savePersonaLayer('l2', l2);
    store.appendEvolution({
      id: store.newEvolutionId(now),
      characterId: store.characterId,
      target: 'L2',
      before: {
        relationshipStage: beforeL2.relationshipStage,
        relationshipDepth: beforeL2.relationshipDepth,
        trustBaseline: beforeL2.trustBaseline,
      },
      after: {
        relationshipStage: l2.relationshipStage,
        relationshipDepth: l2.relationshipDepth,
        trustBaseline: l2.trustBaseline,
      },
      reason: `与 user 的亲密度 ${rawTarget.toFixed(2)} × 互动质量 ${quality.toFixed(2)} → 目标 ${targetDepth.toFixed(2)}（近 7 天 ${recent.length} 条）`,
      at: now,
    });
    changed.push('L2');
  }

  // L3 认知应对
  const beforeL3 = persona.l3;
  let defense = beforeL3.defenseMaturity;
  if (recent.length >= 3) {
    const avgPleasure = recent.reduce((sum, event) => sum + event.emotionAtTime.pleasure, 0) / recent.length;
    defense = clamp01(defense + (avgPleasure >= 0.1 ? 0.02 : avgPleasure <= -0.2 ? -0.01 : 0));
  }
  const biasKeys = Object.keys(beforeL3.biasWeights);
  const bias = normalizeValues(biasKeys.map((key) => beforeL3.biasWeights[key]!));
  const coping = normalizeValues(beforeL3.copingStrategies.map((strategy) => strategy.weight));
  if (Math.abs(defense - beforeL3.defenseMaturity) >= 0.01 || bias.changed || coping.changed) {
    const l3 = {
      ...beforeL3,
      defenseMaturity: round3(defense),
      biasWeights: Object.fromEntries(biasKeys.map((key, index) => [key, bias.values[index]!])),
      copingStrategies: beforeL3.copingStrategies.map((strategy, index) => ({
        ...strategy,
        weight: coping.values[index]!,
      })),
      updatedAt: now,
    };
    store.savePersonaLayer('l3', l3);
    store.appendEvolution({
      id: store.newEvolutionId(now),
      characterId: store.characterId,
      target: 'L3',
      before: { defenseMaturity: beforeL3.defenseMaturity, biasWeights: beforeL3.biasWeights },
      after: { defenseMaturity: l3.defenseMaturity, biasWeights: l3.biasWeights },
      reason: `近 7 天 ${recent.length} 条事件的防御成熟度微调与权重归一化`,
      at: now,
    });
    changed.push('L3');
  }

  // L4 情境人格
  const beforeL4 = persona.l4;
  const weights = normalizeValues(beforeL4.subPersonas.map((sub) => sub.weight));
  if (weights.changed) {
    const l4 = {
      ...beforeL4,
      subPersonas: beforeL4.subPersonas.map((sub, index) => ({ ...sub, weight: weights.values[index]! })),
      updatedAt: now,
    };
    store.savePersonaLayer('l4', l4);
    store.appendEvolution({
      id: store.newEvolutionId(now),
      characterId: store.characterId,
      target: 'L4',
      before: { weights: beforeL4.subPersonas.map((sub) => sub.weight) },
      after: { weights: l4.subPersonas.map((sub) => sub.weight) },
      reason: '子人格权重归一化',
      at: now,
    });
    changed.push('L4');
  }

  if (changed.length > 0) store.setMeta('lastPersonaEvolveAt', now);
  return changed;
}

export function applyPersonaDrift(
  store: Store,
  config: DaughterConfig,
  persona: PersonaBundle,
  polarity: number,
  now: string,
): { changed: boolean; evolutionId?: string } {
  const turns = store.getMetaNumber('personaTurns', 0) + 1;
  store.setMeta('personaTurns', String(turns));

  const toneAvg = store.getMetaNumber('toneAvg', 0) * 0.8 + polarity * 0.2;
  store.setMeta('toneAvg', String(toneAvg));

  if (turns % Math.max(1, config.evolution.min_turns_between_writes) !== 0) {
    return { changed: false };
  }
  if (Math.abs(toneAvg) < 0.05) return { changed: false };

  const before: L1Baseline = JSON.parse(JSON.stringify(persona.l1)) as L1Baseline;
  const maxDelta = config.evolution.l1_max_delta_per_write;
  const plasticity = 1 - persona.l1.plasticityBase;
  const delta = Math.max(-maxDelta, Math.min(maxDelta, toneAvg * maxDelta * plasticity));

  const l1: L1Baseline = {
    ...before,
    bigFive: {
      ...before.bigFive,
      neuroticism: clamp01(before.bigFive.neuroticism - delta * 0.6),
      extraversion: clamp01(before.bigFive.extraversion + delta * 0.3),
      agreeableness: clamp01(before.bigFive.agreeableness + delta * 0.2),
    },
    updatedAt: now,
  };

  store.savePersonaLayer('l1', l1);

  const entry: EvolutionLogEntry = {
    id: store.newEvolutionId(now),
    characterId: store.characterId,
    target: 'L1',
    before: { bigFive: before.bigFive },
    after: { bigFive: l1.bigFive },
    reason: `累计语气均值 ${toneAvg.toFixed(2)}，按 plasticity ${plasticity.toFixed(2)} 微调`,
    at: now,
  };
  store.appendEvolution(entry);
  return { changed: true, evolutionId: entry.id };
}

/**
 * 技能成熟度累计（§9.1 状态机）：
 * draft 首次成功 → active；连续失败 5 次 → deprecated；其余保持原状态。
 * 走 store.mutateSkill 的读-改-写，避免并发下覆盖对方的累计值。
 */
export function bumpSkill(
  store: Store,
  skill: SkillCard,
  success: boolean,
  config: DaughterConfig,
  now: string,
): SkillCard {
  const apply = (current: SkillCard): SkillCard => {
    const failCount = current.failCount + (success ? 0 : 1);
    let status: SkillCard['status'] = current.status;
    if (status === 'draft' && success) status = 'active';
    else if (status === 'active' && failCount >= DEPRECATE_AFTER_FAILS) status = 'deprecated';
    return {
      ...current,
      maturity: clamp01(current.maturity + (success ? 0.05 : -0.03)),
      successCount: current.successCount + (success ? 1 : 0),
      failCount,
      lastUsedAt: now,
      updatedAt: now,
      status,
    };
  };

  const updated = store.mutateSkill(skill.id, apply);
  if (updated) return updated;

  // 磁盘上还没有这个技能（调用方只传了内存对象），补写一次
  const fallback = apply(skill);
  store.saveSkill(fallback);
  return fallback;
}

/** 连续失败多少次后技能作废，与 §9.1 的 deprecated 出口对应 */
const DEPRECATE_AFTER_FAILS = 5;

/**
 * 从一次成功的工具序列里沉淀技能草稿（§9.1「draft：新学技能」）。
 * 纯启发式：只看工具序列，不调用模型；同样的工具序列只沉淀一次。
 */
export function learnDraftSkill(
  store: Store,
  config: DaughterConfig,
  input: { userText: string; tools: string[]; now: string },
): { skill: SkillCard; evolutionId: string } | null {
  const tools = [...new Set(input.tools.map((tool) => tool.trim()).filter(Boolean))];
  if (tools.length < Math.max(2, config.skills.min_steps_to_learn)) return null;

  const intent = truncate(input.userText.replace(/\s+/g, ' ').trim(), 60);
  if (!intent) return null;

  const existing = store.loadSkills();
  const signature = tools.join('>');
  const duplicated = existing.some(
    (skill) => skill.steps.map((step) => step.tool).filter(Boolean).join('>') === signature,
  );
  if (duplicated) return null;

  const slug =
    tools
      .slice(0, 2)
      .map((tool) => tool.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase())
      .join('-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'learned';
  const serial = String(existing.length + 1).padStart(3, '0');

  const skill: SkillCard = {
    id: `SKL-${slug}-${serial}`,
    characterId: store.characterId,
    name: `刚学会的流程：${truncate(intent, 16)}`,
    intent,
    keywords: [...new Set(tools.flatMap((tool) => tool.split(/[_\-.]/)).filter((word) => word.length >= 2))].slice(0, 6),
    requiredTools: tools,
    steps: tools.map((tool, index) => ({
      order: index + 1,
      description: `调用 ${tool}`,
      tool,
      onFailure: 'continue' as const,
    })),
    boundary: { requiresConfirm: true, costLevel: 'medium', forbiddenContexts: [] },
    maturity: 0.3,
    successCount: 0,
    failCount: 0,
    version: 1,
    status: 'draft',
    updatedAt: input.now,
    schemaVersion: 1,
  };
  store.saveSkill(skill);

  const entry: EvolutionLogEntry = {
    id: store.newEvolutionId(input.now),
    characterId: store.characterId,
    target: 'skill',
    before: {},
    after: { skillId: skill.id, status: 'draft', steps: tools },
    reason: `从一次 ${tools.length} 步的工具序列沉淀技能草稿`,
    at: input.now,
  };
  store.appendEvolution(entry);
  return { skill, evolutionId: entry.id };
}

const MOTION_TOOLS = new Set(['motion.play', 'motionPlay', 'motion_play']);

/** 按技能形态决定固化后的资产类型，与设计文档 4.5 的四类资产对应 */
export function classifyAssetKind(skill: SkillCard): AssetKind {
  const toolSteps = skill.steps.filter((step) => step.tool);
  if (toolSteps.some((step) => MOTION_TOOLS.has(step.tool!))) return 'MOT';

  const toolNames = new Set(toolSteps.map((step) => step.tool!));
  if (toolSteps.length >= 2 && toolNames.size >= 2) return 'CMB';
  if (toolNames.size > 0 || skill.requiredTools.length > 0) return 'CON';
  return 'MAC';
}

function buildAssetPayload(kind: AssetKind, skill: SkillCard, persona: PersonaBundle): Record<string, unknown> {
  const base = {
    intent: skill.intent,
    requiredTools: skill.requiredTools,
    steps: skill.steps,
    boundary: skill.boundary,
  };

  switch (kind) {
    case 'MOT': {
      const motionStep = skill.steps.find((step) => step.tool && MOTION_TOOLS.has(step.tool));
      const raw = motionStep?.argsTemplate?.motionId;
      const motionId = typeof raw === 'string' && raw.trim() ? raw : motionStep?.description ?? skill.id;
      // MOT 按 PAD 匹配动作；默认取人格底色的情绪基线
      return { ...base, motionId, padMatch: persona.l1.moodBaseline };
    }
    case 'CMB':
      return { ...base, components: [...new Set(skill.steps.map((step) => step.tool).filter(Boolean))] };
    case 'CON':
      return { ...base, connectionTool: skill.steps.find((step) => step.tool)?.tool };
    default:
      return { ...base, instructions: skill.steps.map((step) => step.description) };
  }
}

/** 成熟度与成功次数达标后固化为资产包，按技能形态区分 MAC/CON/CMB/MOT */
export function maybeFreezeSkill(
  store: Store,
  skill: SkillCard,
  config: DaughterConfig,
  now: string,
): { frozen: boolean; assetId?: string; evolutionId?: string } {
  if (skill.status !== 'active') return { frozen: false };
  if (skill.maturity <= config.skills.maturity_threshold_automate) return { frozen: false };
  if (skill.successCount < config.skills.min_success_for_freeze) return { frozen: false };
  // 需要确认的技能不自动固化，避免绕过确认流程
  if (skill.boundary.requiresConfirm) return { frozen: false };

  const kind = classifyAssetKind(skill);
  const suffix = skill.id.replace(/^SKL-/, '').replace(/[^a-zA-Z0-9-]/g, '');
  const asset: AssetPackage = {
    id: `${kind}-${suffix}-v${skill.version}`,
    kind,
    name: skill.name,
    compiledFromSkillId: skill.id,
    payload: buildAssetPayload(kind, skill, store.loadPersona()),
    rollbackVersion: 0,
    status: 'active',
    createdAt: now,
    schemaVersion: 1,
  };
  store.saveAsset(asset);

  const frozen: SkillCard = { ...skill, status: 'frozen', updatedAt: now };
  store.saveSkill(frozen);

  const entry: EvolutionLogEntry = {
    id: store.newEvolutionId(now),
    characterId: store.characterId,
    target: 'asset',
    before: { skillId: skill.id, status: 'active' },
    after: { assetId: asset.id, kind, status: 'frozen' },
    reason: `成熟度 ${skill.maturity.toFixed(2)}、成功 ${skill.successCount} 次，固化为${kind}资产包`,
    at: now,
  };
  store.appendEvolution(entry);

  return { frozen: true, assetId: asset.id, evolutionId: entry.id };
}

/** 亲密度分档：陌生 → 初识 → 熟悉 → 亲近 → 亲密 */
function relationshipLabel(intimacy: number): string {
  if (intimacy < 0.15) return '陌生';
  if (intimacy < 0.35) return '初识';
  if (intimacy < 0.65) return '熟悉';
  if (intimacy < 0.85) return '亲近';
  return '亲密';
}

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
export function buildPersonProfiles(store: Store, now: string): PersonProfile[] {
  const events = store.listAllEvents().filter((event) => !event.archived);
  const nowMs = Date.parse(now);
  const stats = new Map<string, { count: number; score: number; recent: number; prior: number; first: string; last: string }>();

  for (const event of events) {
    const ageDays = Math.max(0, (nowMs - Date.parse(event.createdAt)) / 86_400_000);
    const recency = Math.pow(0.5, ageDays / 14);
    for (const participant of event.participants) {
      if (!participant) continue;
      const stat = stats.get(participant) ?? { count: 0, score: 0, recent: 0, prior: 0, first: event.createdAt, last: event.createdAt };
      stat.count += 1;
      stat.score += event.weight * recency;
      if (ageDays <= 7) stat.recent += event.weight;
      else if (ageDays <= 14) stat.prior += event.weight;
      if (event.createdAt < stat.first) stat.first = event.createdAt;
      if (event.createdAt > stat.last) stat.last = event.createdAt;
      stats.set(participant, stat);
    }
  }

  return [...stats.entries()].map(([name, stat]) => {
    const intimacy = 1 - Math.exp(-stat.score / 3);
    const delta = (stat.recent - stat.prior) / Math.max(stat.recent + stat.prior, 1);
    return {
      name,
      eventCount: stat.count,
      intimacy: Number(intimacy.toFixed(3)),
      relationship: relationshipLabel(intimacy),
      trend: delta > 0.15 ? '升温' : delta < -0.15 ? '降温' : '稳定',
      delta: Number(delta.toFixed(3)),
      firstMet: stat.first,
      lastAt: stat.last,
      self: name === 'self',
    };
  });
}

export interface ThingProfile {
  label: string;
  eventCount: number;
  /** -1..1：负值偏不喜欢，正值偏喜欢 */
  preference: number;
  mood: '喜欢' | '不喜欢' | '中性';
}

/** 事物喜好：同一主题在事件里的情绪加权平均，14 天半衰期 */
export function buildThingProfiles(store: Store, now: string): ThingProfile[] {
  const events = store.listAllEvents().filter((event) => !event.archived);
  const nowMs = Date.parse(now);
  const stats = new Map<string, { count: number; weightSum: number; pleasureSum: number }>();

  for (const event of events) {
    const ageDays = Math.max(0, (nowMs - Date.parse(event.createdAt)) / 86_400_000);
    const recency = Math.pow(0.5, ageDays / 14);
    for (const tag of event.tags) {
      if (!tag) continue;
      const stat = stats.get(tag) ?? { count: 0, weightSum: 0, pleasureSum: 0 };
      stat.count += 1;
      stat.weightSum += event.weight * recency;
      stat.pleasureSum += event.weight * recency * event.emotionAtTime.pleasure;
      stats.set(tag, stat);
    }
  }

  return [...stats.entries()]
    .map(([label, stat]) => {
      const preference = stat.weightSum > 0 ? stat.pleasureSum / stat.weightSum : 0;
      return {
        label,
        eventCount: stat.count,
        preference: Number(preference.toFixed(3)),
        mood: (preference >= 0.15 ? '喜欢' : preference <= -0.15 ? '不喜欢' : '中性') as ThingProfile['mood'],
      };
    })
    .sort((a, b) => b.eventCount - a.eventCount);
}

/**
 * 只读星图产物：九个星系对应脑区，节点按来源归类，链接与参与者/主题/地点/情绪为边。
 * 星系只是可视化分组，不参与运行时决策。
 */
const STAR_GALAXIES = [
  { id: 'hippocampus.event', name: '情景记忆', part: '海马体', hint: '发生过什么' },
  { id: 'hippocampus.place', name: '地点', part: '海马体', hint: '在哪里发生' },
  { id: 'amygdala.emotion', name: '情绪标记', part: '杏仁核', hint: '事件的情绪着色' },
  { id: 'neocortex.person', name: '人物', part: '新皮层', hint: '社交人物画像' },
  { id: 'neocortex.thing', name: '事物', part: '新皮层', hint: '主题与关注点' },
  { id: 'neocortex.cognition', name: '认知八维', part: '新皮层', hint: '性格与应对策略' },
  { id: 'prefrontal.state', name: '当下状态', part: '前额叶', hint: 'L5 运行时快照' },
  { id: 'basal_ganglia.skill', name: '技能', part: '基底节', hint: '程序记忆' },
  { id: 'brainstem.safety', name: '安全', part: '脑干', hint: '降级与边界' },
] as const;

/** 文本里找不到具体地点时，按事件来源归入一个默认场域 */
const DEFAULT_PLACE_BY_SOURCE: Record<string, string> = {
  chat: '线上',
  qq: '线上',
  douyin_dm: '线上',
  douyin_content: '线上',
  minecraft: '桌面',
  game: '桌面',
  android: '桌面',
  system: '桌面',
};

const PLACE_LEXICON: Array<{ place: string; words: string[] }> = [
  { place: '家', words: ['家', '家里', '在家'] },
  { place: '公司', words: ['公司', '办公室', '工位'] },
  { place: '学校', words: ['学校', '教室', '宿舍', '图书馆'] },
  { place: '线上', words: ['线上', '网上', '群里', 'QQ', '抖音'] },
  { place: '户外', words: ['公园', '外面', '户外', '路上'] },
  { place: '医院', words: ['医院', '看病'] },
];

function emotionLabel(pad: PadState): string {
  if (pad.pleasure >= 0.25 && pad.arousal >= 0.2) return '兴奋';
  if (pad.pleasure >= 0.2) return '开心';
  if (pad.pleasure <= -0.25) return '低落';
  if (pad.pleasure <= -0.1) return '烦躁';
  return '平静';
}

export function buildStarMap(store: Store, now: string): { nodes: number; edges: number; galaxies: number } {
  const events = store.listAllEvents().filter((event) => !event.archived);
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<{ from: string; to: string; kind: string; strength: number }> = [];

  // 1. 海马体 · 情景记忆（历史感受 + 当下回顾感受）
  for (const event of events) {
    const review = event.emotionNowHistory[event.emotionNowHistory.length - 1];
    nodes.push({
      type: 'event',
      galaxy: 'hippocampus.event',
      id: event.id,
      label: event.title,
      value: event.weight,
      meta: {
        tags: event.tags,
        emotion: emotionLabel(event.emotionAtTime),
        createdAt: event.createdAt,
        reviewedEmotion: review ? emotionLabel(review.emotion) : undefined,
        reviewedAt: review?.at,
        reviewReason: review?.reason,
        emotionShift: review ? Number((review.emotion.pleasure - event.emotionAtTime.pleasure).toFixed(2)) : undefined,
        source: event.source,
        // 画布用的视觉编码字段：热度决定大小、情绪决定色温、显著性决定不透明度
        recallCount: event.recallCount,
        salience: event.salience,
        importance: event.importance,
        mergedCount: event.mergedCount ?? 0,
        pleasure: Number(event.emotionAtTime.pleasure.toFixed(3)),
        intensity: Number(event.emotionAtTime.intensity.toFixed(3)),
        ageDays: Math.max(0, Math.round((Date.parse(now) - Date.parse(event.createdAt)) / 86_400_000)),
      },
    });
  }

  // 2. 海马体 · 地点
  const placeCounts = new Map<string, number>();
  for (const event of events) {
    const text = `${event.title} ${event.summary}`;
    const matched = PLACE_LEXICON.filter((entry) => entry.words.some((word) => text.includes(word)));
    const places = matched.length > 0
      ? matched.map((entry) => entry.place)
      : [DEFAULT_PLACE_BY_SOURCE[event.source] ?? '线上'];
    for (const place of places) {
      placeCounts.set(place, (placeCounts.get(place) ?? 0) + 1);
      edges.push({ from: event.id, to: `place:${place}`, kind: 'place', strength: 0.4 });
    }
  }
  for (const [place, count] of placeCounts) {
    nodes.push({
      type: 'place',
      galaxy: 'hippocampus.place',
      id: `place:${place}`,
      label: place,
      value: clamp01(count / 6),
      meta: { eventCount: count },
    });
  }

  // 3. 杏仁核 · 情绪
  const emotionCounts = new Map<string, number>();
  for (const event of events) {
    const label = emotionLabel(event.emotionAtTime);
    emotionCounts.set(label, (emotionCounts.get(label) ?? 0) + 1);
    edges.push({ from: event.id, to: `emotion:${label}`, kind: 'emotion', strength: 0.3 });
  }
  for (const [label, count] of emotionCounts) {
    nodes.push({
      type: 'emotion',
      galaxy: 'amygdala.emotion',
      id: `emotion:${label}`,
      label,
      value: clamp01(count / 8),
      meta: { eventCount: count },
    });
  }
  const overdraft = store.loadOverdraft();
  nodes.push({
    type: 'emotion',
    galaxy: 'amygdala.emotion',
    id: 'emotion:透支',
    label: '情感透支',
    value: overdraft,
    meta: { note: '全局累积，不随会话重置' },
  });

  // 4. 新皮层 · 人物画像：互动次数 + 亲密度 + 关系变化
  for (const profile of buildPersonProfiles(store, now)) {
    nodes.push({
      type: 'person',
      galaxy: 'neocortex.person',
      id: `person:${profile.name}`,
      label: profile.name,
      value: clamp01(profile.intimacy),
      meta: {
        eventCount: profile.eventCount,
        intimacy: profile.intimacy,
        relationship: profile.relationship,
        trend: profile.trend,
        delta: profile.delta,
        firstMet: profile.firstMet,
        lastAt: profile.lastAt,
        self: profile.self,
      },
    });
  }
  for (const event of events) {
    for (const participant of event.participants) {
      if (!participant) continue;
      edges.push({ from: event.id, to: `person:${participant}`, kind: 'participant', strength: 0.5 });
    }
  }

  // 人物之间的关系边：按共同参与的事件数加权（真实数据里通常只有「我↔你」一条，但这条本身就说明问题）
  const pairCounts = new Map<string, number>();
  for (const event of events) {
    const people = [...new Set(event.participants.filter(Boolean))].sort();
    for (let i = 0; i < people.length; i += 1) {
      for (let j = i + 1; j < people.length; j += 1) {
        const key = `${people[i]}|${people[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [key, count] of pairCounts) {
    const [left, right] = key.split('|');
    edges.push({
      from: `person:${left}`,
      to: `person:${right}`,
      kind: 'person',
      strength: clamp01(0.3 + count / 60),
    });
  }

  // 5. 新皮层 · 事物（事件标签 + 喜好权重）
  for (const profile of buildThingProfiles(store, now)) {
    nodes.push({
      type: 'thing',
      galaxy: 'neocortex.thing',
      id: `tag:${profile.label}`,
      label: profile.label,
      value: clamp01(profile.eventCount / 8),
      meta: { eventCount: profile.eventCount, preference: profile.preference, mood: profile.mood },
    });
  }
  for (const event of events) {
    for (const tag of event.tags) {
      if (!tag) continue;
      edges.push({ from: event.id, to: `tag:${tag}`, kind: 'topic', strength: 0.3 });
    }
  }

  // 6. 新皮层 · 认知八维
  const persona = store.loadPersona();
  const cognition: Array<{ label: string; value: number; source: string }> = [
    { label: '开放性', value: persona.l1.bigFive.openness, source: 'L1 基线' },
    { label: '尽责性', value: persona.l1.bigFive.conscientiousness, source: 'L1 基线' },
    { label: '外向性', value: persona.l1.bigFive.extraversion, source: 'L1 基线' },
    { label: '宜人性', value: persona.l1.bigFive.agreeableness, source: 'L1 基线' },
    { label: '神经质', value: persona.l1.bigFive.neuroticism, source: 'L1 基线' },
    { label: '新奇寻求', value: persona.l1.noveltySeeking, source: 'L1 基线' },
    { label: '可塑性', value: persona.l1.plasticityBase, source: 'L1 基线' },
    { label: '防御成熟度', value: persona.l3.defenseMaturity, source: 'L3 认知应对' },
  ];
  for (const item of cognition) {
    nodes.push({
      type: 'cognition',
      galaxy: 'neocortex.cognition',
      id: `dim:${item.label}`,
      label: item.label,
      value: clamp01(item.value),
      meta: { source: item.source },
    });
  }
  // 善恶观独立于八维，放进同一星系但单独成节点
  nodes.push({
    type: 'moral',
    galaxy: 'neocortex.cognition',
    id: 'moral:outlook',
    label: '善恶观',
    value: clamp01(persona.l3.moral.altruism),
    meta: {
      altruism: persona.l3.moral.altruism,
      principle: persona.l3.moral.principle,
      stance: persona.l3.moral.stance,
      redLines: persona.l3.moral.redLines,
      source: 'L3 认知应对',
    },
  });

  // 7. 前额叶 · 当下状态（取最近活跃的会话快照）
  const l5 = store
    .listL5Sessions()
    .map((sessionId) => store.loadL5(sessionId))
    .filter((state): state is L5State => state !== null)
    .sort((a, b) => Date.parse(b.lastTickAt) - Date.parse(a.lastTickAt))[0];
  if (l5) {
    const state: Array<{ label: string; value: number }> = [
      { label: '愉悦', value: (l5.emotion.pleasure + 1) / 2 },
      { label: '唤醒', value: (l5.emotion.arousal + 1) / 2 },
      { label: '掌控', value: (l5.emotion.dominance + 1) / 2 },
      { label: '压力', value: l5.stress },
      { label: '安全感', value: l5.safety },
      { label: '疲劳', value: l5.fatigue },
      { label: '边界', value: l5.boundary },
    ];
    for (const item of state) {
      nodes.push({
        type: 'state',
        galaxy: 'prefrontal.state',
        id: `state:${item.label}`,
        label: item.label,
        value: clamp01(item.value),
        meta: { sessionId: l5.sessionId },
      });
    }
  }

  // 8. 基底节 · 技能与反射（都是程序记忆）
  for (const skill of store.loadSkills()) {
    nodes.push({
      type: 'skill',
      galaxy: 'basal_ganglia.skill',
      id: skill.id,
      label: skill.name,
      value: clamp01(skill.maturity),
      meta: { maturity: skill.maturity, status: skill.status, successCount: skill.successCount },
    });
  }
  for (const rule of store.loadReflexRules()) {
    const trigger = rule.match.type === 'keyword'
      ? rule.match.patterns[0]
      : rule.action.kind === 'motion'
        ? rule.action.motionId
        : rule.id;
    nodes.push({
      type: 'skill',
      galaxy: 'basal_ganglia.skill',
      id: rule.id,
      label: `反射 · ${trigger ?? rule.id}`,
      value: rule.enabled ? 0.8 : 0.3,
      meta: { source: '反射', kind: rule.action.kind, priority: rule.priority, cooldownMs: rule.cooldownMs, enabled: rule.enabled },
    });
  }

  // 9. 脑干 · 安全
  const safety = store.loadSafetyState();
  nodes.push({
    type: 'safety',
    galaxy: 'brainstem.safety',
    id: 'safety:level',
    label: `安全等级 L${safety.level}`,
    value: clamp01(1 - safety.functionalImpairment),
    meta: {
      reasons: safety.reasons,
      triggers: safety.triggers,
      overstressHours: Math.round(safety.overstressDurationMs / 3_600_000),
      since: safety.since,
    },
  });

  // 事件之间的链接边（只保留两端都在图里的）
  const nodeIds = new Set(nodes.map((node) => node.id as string));
  for (const event of events) {
    for (const link of event.links) {
      if (!nodeIds.has(link.targetId)) continue;
      edges.push({ from: event.id, to: link.targetId, kind: link.kind, strength: link.strength });
    }
  }

  const validEdges = edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));

  // 只读信息栏：人格参数与相对出厂值的偏移、运行时快照、存储统计、演化记录
  const panels = buildStarPanels(store, now, {
    nodes: nodes.length,
    edges: validEdges.length,
    galaxies: STAR_GALAXIES.length,
  });

  // 归档事件只带 id 与时间，前端画成星团外围的暗尘——让「遗忘」本身可见，而不只是侧栏一个数字
  const archived = store
    .listAllEvents()
    .filter((event) => event.archived)
    .slice(-240)
    .map((event) => ({ id: event.id, at: event.createdAt }));

  store.writeStarMap(store.characterId, {
    characterId: store.characterId,
    generatedAt: now,
    galaxies: STAR_GALAXIES,
    nodes,
    edges: validEdges,
    panels,
    archived,
  });

  return { nodes: nodes.length, edges: validEdges.length, galaxies: STAR_GALAXIES.length };
}
