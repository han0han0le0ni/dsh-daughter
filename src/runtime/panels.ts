import type { L1Baseline, L2Relationship, L3Cognition, L4Contextual, PersonaBundle } from '../types.js';
import type { Store } from '../store.js';
import { DEFAULT_L1, DEFAULT_L2, DEFAULT_L3, DEFAULT_L4 } from '../store.js';
import { localDayKey } from './speak.js';
import { readSpeakStats } from './speak-stats.js';

/**
 * 星图只读信息栏：把人格 L1–L4、运行时 L5、安全、存储统计与演化日志摊平成参数行。
 * 全部只做读取与展示，不回写任何状态；偏移 = 当前值 - 出厂默认值。
 */

export interface StarMapParam {
  key: string;
  label: string;
  value: number | string | string[] | null;
  /** 出厂默认值，只有数值型才有意义 */
  base?: number;
  /** 当前值 - 出厂默认值 */
  delta?: number;
  kind: 'number' | 'text' | 'list';
  note?: string;
}

export interface StarMapGroup {
  id: string;
  title: string;
  subtitle: string;
  /** 分组里数值型参数的规模，前端据此画条形 */
  params: StarMapParam[];
}

export interface StarMapChange {
  key: string;
  from: string;
  to: string;
}

export interface StarMapEvolution {
  at: string;
  target: string;
  reason: string;
  changes: StarMapChange[];
}

/** 会话级状态序列：给侧栏画安全/压力/疲劳的走势，单个快照看不出「在变好还是变坏」 */
export interface StarMapSeriesPoint {
  sessionId: string;
  at: string;
  safety: number;
  stress: number;
  fatigue: number;
  pleasure: number;
}

export interface StarMapPanels {
  persona: StarMapGroup[];
  runtime: StarMapGroup[];
  evolution: StarMapEvolution[];
  series: StarMapSeriesPoint[];
  generatedAt: string;
}

const TEMPERAMENT_LABEL: Record<string, string> = {
  slow_warmup: '慢热',
  eager: '急切',
  steady: '稳定',
  guarded: '戒备',
};

const STAGE_LABEL: Record<string, string> = {
  stranger: '陌生',
  acquaintance: '初识',
  familiar: '熟悉',
  close: '亲近',
  dependent: '依赖',
};

const SAFETY_LABEL: Record<number, string> = {
  0: 'L0 正常',
  1: 'L1 过载',
  2: 'L2 降级',
  3: 'L3 保护',
};

function round(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function param(
  key: string,
  label: string,
  value: number | string | string[] | null,
  base?: number | string,
  note?: string,
): StarMapParam {
  if (typeof value === 'number') {
    const item: StarMapParam = { key, label, value: round(value, 4), kind: 'number' };
    if (typeof base === 'number') {
      item.base = round(base, 4);
      item.delta = round(value - base, 4);
    }
    if (note) item.note = note;
    return item;
  }
  const item: StarMapParam = {
    key,
    label,
    value,
    kind: Array.isArray(value) ? 'list' : 'text',
  };
  if (note) item.note = note;
  return item;
}

function l1Group(current: L1Baseline, base: L1Baseline): StarMapGroup {
  const bigFive: Array<[keyof L1Baseline['bigFive'], string]> = [
    ['openness', '开放性'],
    ['conscientiousness', '尽责性'],
    ['extraversion', '外向性'],
    ['agreeableness', '宜人性'],
    ['neuroticism', '神经质'],
  ];
  const params: StarMapParam[] = bigFive.map(([key, label]) =>
    param(`bigFive.${key}`, label, current.bigFive[key], base.bigFive[key]),
  );
  params.push(
    param('noveltySeeking', '新奇寻求', current.noveltySeeking, base.noveltySeeking),
    param('plasticityBase', '可塑性', current.plasticityBase, base.plasticityBase),
    param('moodBaseline.pleasure', '情绪基线 · 愉悦', current.moodBaseline.pleasure, base.moodBaseline.pleasure),
    param('moodBaseline.arousal', '情绪基线 · 唤醒', current.moodBaseline.arousal, base.moodBaseline.arousal),
    param('moodBaseline.dominance', '情绪基线 · 掌控', current.moodBaseline.dominance, base.moodBaseline.dominance),
    param('temperament', '气质', TEMPERAMENT_LABEL[current.temperament] ?? current.temperament),
    param('updatedAt', '更新时间', current.updatedAt),
  );
  return { id: 'L1', title: 'L1 人格基线', subtitle: '出厂默认 → 当前', params };
}

function l2Group(current: L2Relationship, base: L2Relationship): StarMapGroup {
  return {
    id: 'L2',
    title: 'L2 依恋与关系',
    subtitle: '对「你」的关系底色',
    params: [
      param('attachmentAnxiety', '依恋焦虑', current.attachmentAnxiety, base.attachmentAnxiety),
      param('attachmentAvoidance', '依恋回避', current.attachmentAvoidance, base.attachmentAvoidance),
      param('trustBaseline', '信任基线', current.trustBaseline, base.trustBaseline),
      param('relationshipDepth', '关系深度', current.relationshipDepth, base.relationshipDepth),
      param('relationshipStage', '关系阶段', STAGE_LABEL[current.relationshipStage] ?? current.relationshipStage),
      param('coreNeeds', '核心需求', current.coreNeeds),
      param('updatedAt', '更新时间', current.updatedAt),
    ],
  };
}

function l3Group(current: L3Cognition, base: L3Cognition): StarMapGroup {
  const params: StarMapParam[] = [
    param('defenseMaturity', '防御成熟度', current.defenseMaturity, base.defenseMaturity),
    param('moral.altruism', '善恶观 · 利他', current.moral.altruism, base.moral.altruism),
    param('moral.principle', '善恶观 · 守原则', current.moral.principle, base.moral.principle),
    param('moral.stance', '善恶观 · 立场', current.moral.stance),
    param('moral.redLines', '红线', current.moral.redLines),
  ];
  for (const key of Object.keys(current.biasWeights)) {
    params.push(param(`biasWeights.${key}`, `认知偏差 · ${key}`, current.biasWeights[key]!, base.biasWeights[key]));
  }
  for (const strategy of current.copingStrategies) {
    const baseStrategy = base.copingStrategies.find((item) => item.id === strategy.id);
    params.push(
      param(`coping.${strategy.id}.weight`, `应对 · ${strategy.trigger} 权重`, strategy.weight, baseStrategy?.weight),
      param(`coping.${strategy.id}.response`, `应对 · ${strategy.trigger}`, strategy.response),
    );
  }
  // 自我叙事三轴：只给数值，不翻译成"她是 X 型"——类型判断留给用户自己推
  const narrative = current.narrative;
  if (narrative) {
    params.push(
      param('narrative.worldSafe', '叙事 · 世界安全', narrative.worldSafe, base.narrative?.worldSafe),
      param('narrative.othersReliable', '叙事 · 他人可靠', narrative.othersReliable, base.narrative?.othersReliable),
      param('narrative.selfWorth', '叙事 · 我值得被爱', narrative.selfWorth, base.narrative?.selfWorth),
    );
  }
  params.push(param('updatedAt', '更新时间', current.updatedAt));
  return { id: 'L3', title: 'L3 认知应对', subtitle: '压力下的策略与善恶观', params };
}

/**
 * 人格证据：把"哪句话推动了哪一维"摊开给人看。
 * 这里故意不输出依恋类型、极端标记之类的结论，只列事实（时间 / 维度 / 幅度 / 原话）。
 */
function evidenceGroup(current: L3Cognition): StarMapGroup | null {
  const evidence = [...(current.evidence ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 12);
  if (evidence.length === 0) return null;
  const params: StarMapParam[] = evidence.map((item, index) => {
    const sign = item.delta > 0 ? '+' : '';
    const when = item.at.slice(5, 16).replace('T', ' ');
    return {
      key: `evidence.${index}`,
      label: `${when} · ${item.layer}/${item.dimension}`,
      value: `${sign}${item.delta.toFixed(3)} ｜ ${item.quote || '（无原文）'}`,
      kind: 'text',
      note: `${item.impactKind} · 冲击 ${item.impact.toFixed(2)}`,
    };
  });
  return {
    id: 'evidence',
    title: '人格证据',
    subtitle: '只列事实：哪几句推动了哪一维，结论自己推',
    params,
  };
}

function l4Group(current: L4Contextual, base: L4Contextual): StarMapGroup {
  const params: StarMapParam[] = [];
  for (const sub of current.subPersonas) {
    const baseSub = base.subPersonas.find((item) => item.id === sub.id);
    params.push(
      param(`sub.${sub.id}.weight`, `${sub.id} · 权重`, sub.weight, baseSub?.weight),
      param(`sub.${sub.id}.disclosure`, `${sub.id} · 自我暴露`, sub.disclosureLevel, baseSub?.disclosureLevel),
      param(`sub.${sub.id}.tone`, `${sub.id} · 语气`, sub.tone),
    );
    if (sub.boundaries.length > 0) {
      params.push(param(`sub.${sub.id}.boundaries`, `${sub.id} · 边界`, sub.boundaries));
    }
  }
  params.push(param('updatedAt', '更新时间', current.updatedAt));
  return { id: 'L4', title: 'L4 情境子人格', subtitle: '按场景切换的表达面具', params };
}

function runtimeGroups(store: Store, now: string): StarMapGroup[] {
  const groups: StarMapGroup[] = [];
  const sessions = store
    .listL5Sessions()
    .map((sessionId) => store.loadL5(sessionId))
    .filter((state) => state !== null)
    .sort((a, b) => Date.parse(b.lastTickAt) - Date.parse(a.lastTickAt));
  const l5 = sessions[0];

  if (l5) {
    groups.push({
      id: 'L5',
      title: 'L5 当下状态',
      subtitle: `最近会话 ${l5.sessionId.slice(0, 16)}`,
      params: [
        param('emotion.pleasure', '愉悦', l5.emotion.pleasure),
        param('emotion.arousal', '唤醒', l5.emotion.arousal),
        param('emotion.dominance', '掌控', l5.emotion.dominance),
        param('stress', '压力', l5.stress),
        param('safety', '安全感', l5.safety),
        param('fatigue', '疲劳', l5.fatigue),
        param('boundary', '边界', l5.boundary),
        param('emotionalOverdraft', '会话内透支', l5.emotionalOverdraft),
        param('activeSubPersonaId', '当前子人格', l5.activeSubPersonaId ?? '未标注'),
        param('lastTickAt', '最后心跳', l5.lastTickAt),
        param('snapshotAt', '快照时间', l5.snapshotAt),
      ],
    });
  } else {
    groups.push({ id: 'L5', title: 'L5 当下状态', subtitle: '暂无会话快照', params: [] });
  }

  const safety = store.loadSafetyState();
  groups.push({
    id: 'safety',
    title: '安全与边界',
    subtitle: '脑干降级链',
    params: [
      param('level', '安全等级', SAFETY_LABEL[safety.level] ?? `L${safety.level}`),
      param('functionalImpairment', '功能受损', safety.functionalImpairment),
      param('overstressHours', '过载时长（小时）', round(safety.overstressDurationMs / 3_600_000, 1)),
      param('reasons', '原因', safety.reasons),
      param('triggers', '触发', safety.triggers),
      param('since', '起始时间', safety.since),
    ],
  });

  groups.push({
    id: 'overdraft',
    title: '全局情感透支',
    subtitle: '不随会话重置',
    params: [param('overdraft', '累计透支', store.loadOverdraft())],
  });

  return groups;
}

/** 程序记忆明细：技能成熟度、反射开关、固化资产包，全部只读 */
function programMemoryGroup(store: Store): StarMapGroup {
  const params: StarMapParam[] = [];
  for (const skill of store.loadSkills()) {
    params.push(
      param(
        `skill.${skill.id}`,
        `${skill.name} · 成熟度`,
        skill.maturity,
        undefined,
        `${skill.status} · 成功 ${skill.successCount} 次`,
      ),
    );
  }
  for (const rule of store.loadReflexRules()) {
    const trigger = rule.match.type === 'keyword' ? rule.match.patterns[0] ?? rule.id : rule.id;
    params.push(
      param(
        `reflex.${rule.id}`,
        `反射 · ${trigger}`,
        rule.enabled ? '启用' : '停用',
        undefined,
        `冷却 ${Math.round(rule.cooldownMs / 1000)} 秒 · 优先级 ${rule.priority}`,
      ),
    );
  }
  const assets = store.loadAssets();
  if (assets.length > 0) {
    params.push(param('assets', '固化资产包', assets.map((asset) => `${asset.id}(${asset.status})`)));
  }
  return { id: 'program', title: '技能与资产', subtitle: '程序记忆明细', params };
}

function storageGroup(store: Store, counts: { nodes: number; edges: number; galaxies: number }): StarMapGroup {
  const events = store.listAllEvents();
  const live = events.filter((event) => !event.archived);
  const tags = new Set<string>();
  const people = new Set<string>();
  let links = 0;
  for (const event of live) {
    for (const tag of event.tags) if (tag) tags.add(tag);
    for (const participant of event.participants) if (participant) people.add(participant);
    links += event.links.length;
  }
  const filterStats = store.readCounters('filter.');
  const salience = live.map((event) => event.salience).filter((value): value is number => typeof value === 'number');
  const avgSalience = salience.length > 0 ? salience.reduce((sum, value) => sum + value, 0) / salience.length : null;
  const merged = live.reduce((sum, event) => sum + (event.mergedCount ?? 0), 0);

  return {
    id: 'storage',
    title: '记忆与认知滤网',
    subtitle: '只读计数',
    params: [
      param('events.live', '未归档事件', live.length),
      param('events.archived', '归档事件', events.length - live.length),
      param('events.links', '事件链接', links),
      param('events.max_links', '单条最大出度', live.reduce((max, event) => Math.max(max, event.links.length), 0), undefined, '上限 12，超过会被 trimLinks 修剪'),
      param('events.recalls', '累计召回', live.reduce((sum, event) => sum + event.recallCount, 0)),
      param('events.never', '从未被想起', live.filter((event) => event.recallCount === 0).length, undefined, '这些记忆一次都没进过注入'),
      param('tags', '主题标签', tags.size),
      param('people', '出现人物', people.size),
      param('skills', '技能卡', store.loadSkills().length),
      param('reflexes', '反射规则', store.loadReflexRules().length),
      param('nodes', '星图节点', counts.nodes),
      param('edges', '星图边', counts.edges),
      param('galaxies', '星系', counts.galaxies),
      param('filter.keep', '滤网放行', filterStats.keep ?? 0),
      param('filter.merge', '同题合并', filterStats.merge ?? 0),
      param('filter.drop', '显著性丢弃', filterStats.drop ?? 0),
      param('filter.shield', '认知屏蔽', filterStats.shield ?? 0),
      param('filter.forget', '忘却归档', filterStats.forget ?? 0),
      param('filter.merged_total', '合并计数合计', merged),
      param('filter.salience', '平均显著性', avgSalience === null ? '—' : Number(avgSalience.toFixed(3))),
    ],
  };
}

function flatten(value: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    out[prefix || 'value'] = value
      .map((item) => (typeof item === 'number' ? String(Number(item.toFixed(4))) : String(item)))
      .join('、');
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      Object.assign(out, flatten(item, path));
    }
    return out;
  }
  out[prefix || 'value'] = typeof value === 'number' ? String(Number(value.toFixed(4))) : String(value);
  return out;
}

function evolutionEntries(store: Store, limit = 10): StarMapEvolution[] {
  const rows = store
    .listEvolution(120)
    .filter((entry) => ['L1', 'L2', 'L3', 'L4'].includes(entry.target))
    .slice(-limit)
    .reverse();
  return rows.map((entry) => {
    const before = flatten(entry.before);
    const after = flatten(entry.after);
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changes: StarMapChange[] = [];
    for (const key of keys) {
      const from = before[key] ?? '—';
      const to = after[key] ?? '—';
      if (from !== to) changes.push({ key, from, to });
    }
    return { at: entry.at, target: entry.target, reason: entry.reason, changes };
  });
}

/**
 * 主动开口的账本：今天说了几次、几次想说但忍住、憋着多少劲、最近说过什么。
 * 这些全在 `speak.*` 元数据里，面板只读不回写。
 */
function speakGroup(store: Store, now: string): StarMapGroup {
  const day = localDayKey(now);
  const params: StarMapParam[] = [
    { key: 'speak.today', label: '今天主动开口', value: store.getMetaNumber(`speak.count.${day}`, 0), kind: 'number' },
    { key: 'speak.hold', label: '今天欲言又止', value: store.getMetaNumber(`speak.hold.${day}`, 0), kind: 'number' },
    { key: 'speak.carry', label: '憋着的劲', value: Number(store.getMetaNumber('speak.carry', 0).toFixed(3)), kind: 'number' },
  ];

  const lastAt = store.getMeta('speak.lastAt');
  if (lastAt) params.push({ key: 'speak.lastAt', label: '上次开口', value: lastAt, kind: 'text' });

  // DEF-18：沉默比例是调阈值的依据；只有真的评估过才显示，避免面板出现误导性的 0%
  const stats = readSpeakStats(store.getMeta('speak.stats'), day);
  if (stats.total > 0) {
    params.push({ key: 'speak.stats.total', label: '今天评估次数', value: stats.total, kind: 'number' });
    params.push({
      key: 'speak.stats.silent',
      label: '沉默占比',
      value: `${Math.round(stats.silentRatio * 100)}%`,
      kind: 'text',
    });
  }

  const raw = store.getMeta('speak.history');
  if (raw) {
    try {
      const history = JSON.parse(raw) as Array<{ text?: string }>;
      const lines = history
        .slice(-5)
        .reverse()
        .map((item) => String(item.text ?? ''))
        .filter(Boolean);
      if (lines.length > 0) params.push({ key: 'speak.history', label: '最近说过', value: lines, kind: 'list' });
    } catch {
      // 历史坏了就当没有，不影响面板其它分组
    }
  }

  return { id: 'speak', title: '主动开口', subtitle: '没人说话时她自己开口的账本', params };
}

export function buildStarPanels(
  store: Store,
  now: string,
  counts: { nodes: number; edges: number; galaxies: number },
): StarMapPanels {
  const persona: PersonaBundle = store.loadPersona();
  return {
    persona: [
      l1Group(persona.l1, DEFAULT_L1),
      l2Group(persona.l2, DEFAULT_L2),
      l3Group(persona.l3, DEFAULT_L3),
      l4Group(persona.l4, DEFAULT_L4),
      ...(evidenceGroup(persona.l3) ? [evidenceGroup(persona.l3)!] : []),
    ],
    runtime: [...runtimeGroups(store, now), speakGroup(store, now), programMemoryGroup(store), storageGroup(store, counts)],
    evolution: evolutionEntries(store),
    series: store
      .listL5Sessions()
      .map((sessionId) => store.loadL5(sessionId))
      .filter((state) => state !== null)
      .sort((a, b) => Date.parse(a.lastTickAt) - Date.parse(b.lastTickAt))
      .map((state) => ({
        sessionId: state.sessionId,
        at: state.lastTickAt,
        safety: Number(state.safety.toFixed(3)),
        stress: Number(state.stress.toFixed(3)),
        fatigue: Number(state.fatigue.toFixed(3)),
        pleasure: Number(state.emotion.pleasure.toFixed(3)),
      })),
    generatedAt: now,
  };
}
