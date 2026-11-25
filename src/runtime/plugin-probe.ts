/**
 * 插件探测（只读）：看看宿主里装了哪些插件、哪些已经是她自己的出口、
 * 还有哪些具备 IM 通道能力但尚未接管。
 *
 * 边界：
 * - 只读。这里不写任何第三方插件的配置、人格或记忆，也不改宿主插件清单。
 * - 判定只依据插件模块名与宿主报告的 fiber 状态，不猜对方内部结构。
 * - 不认识的一律算"不兼容"，宁可漏报也不把无关插件列成可接管对象。
 */

/** 宿主插件清单里的一行（字段取自 host-plugin-inventory） */
export interface ProbeEntry {
  moduleName: string;
  enabled: boolean;
  /** 'active' 才算在线；pending/loading/failed/null 都按离线报告 */
  fiberPhase: string | null;
}

/** 她已经开通的表达出口（vpet / pet / http / file） */
export interface ProbeSink {
  type: string;
}

/** 已声明的收件适配器（connectors/<source>/connector.json） */
export interface ProbeInbound {
  source: string;
  version: string;
}

export interface ProbeRejected {
  source: string;
  reason: string;
}

export interface TakeoverCandidate {
  moduleName: string;
  /** 命中的通道名，如 onebot / wecom */
  transport: string;
  enabled: boolean;
  alive: boolean;
}

export interface TakeoverReport {
  generatedAt: string;
  /** 已经在用的出口：这些不必再问一遍 */
  sinks: string[];
  /** 装有 IM 能力、但还没接管的插件 */
  candidates: TakeoverCandidate[];
  inbound: ProbeInbound[];
  rejectedInbound: ProbeRejected[];
  summary: {
    plugins: number;
    self: number;
    candidates: number;
    incompatible: number;
    sinks: number;
    inbound: number;
  };
}

/** 自己：本插件的模块名，永远不列为候选 */
export const SELF_MODULE = 'dsh-daughter';

const SEP = '[/@._-]';

/**
 * 已知的 IM 通道。只认独立词段，不用 chat/bot/message 这类泛词——
 * `dsh-client-ui-chat` 这种也会被当成聊天插件，等于每次启动都在报假候选。
 */
const TRANSPORTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['onebot', new RegExp(`(^|${SEP})onebot(${SEP}|$)`)],
  ['napcat', new RegExp(`(^|${SEP})napcat(${SEP}|$)`)],
  ['lagrange', new RegExp(`(^|${SEP})lagrange(${SEP}|$)`)],
  ['qqbot', new RegExp(`(^|${SEP})qq-?bot(${SEP}|$)`)],
  ['wecom', new RegExp(`(^|${SEP})we(com|work)(${SEP}|$)`)],
  ['wechat', new RegExp(`(^|${SEP})(wechat|weixin|wxbot)(${SEP}|$)`)],
  ['telegram', new RegExp(`(^|${SEP})telegram(${SEP}|$)`)],
  ['discord', new RegExp(`(^|${SEP})discord(${SEP}|$)`)],
  ['slack', new RegExp(`(^|${SEP})slack(${SEP}|$)`)],
  ['feishu', new RegExp(`(^|${SEP})(feishu|lark)(${SEP}|$)`)],
  ['dingtalk', new RegExp(`(^|${SEP})dingtalk(${SEP}|$)`)],
  ['matrix', new RegExp(`(^|${SEP})matrix(${SEP}|$)`)],
  ['kook', new RegExp(`(^|${SEP})kook(${SEP}|$)`)],
  ['douyin', new RegExp(`(^|${SEP})douyin(${SEP}|$)`)],
];

/** 模块名归一化：Windows 路径分隔符与大小写都不该影响判定 */
export function normalizeModuleName(moduleName: string): string {
  return moduleName.trim().toLowerCase().replace(/\\/g, '/');
}

/** 命中的通道名；不是已知通道返回 null */
export function detectTransport(moduleName: string): string | null {
  const name = normalizeModuleName(moduleName);
  for (const [label, pattern] of TRANSPORTS) {
    if (pattern.test(name)) return label;
  }
  return null;
}

/** 是不是自己（dsh-daughter 本体或带路径的副本） */
export function isSelf(moduleName: string): boolean {
  return new RegExp(`(^|${SEP})${SELF_MODULE}(${SEP}|$)`).test(normalizeModuleName(moduleName));
}

/**
 * 生成接管清单。纯函数：宿主清单、已有出口、连接器清单都由调用方取好传进来，
 * 方便单测，也避免这里偷偷去读第三方文件。
 */
export function probePlugins(input: {
  entries: readonly ProbeEntry[];
  sinks: readonly ProbeSink[];
  inbound: readonly ProbeInbound[];
  rejectedInbound?: readonly ProbeRejected[];
  now: string;
}): TakeoverReport {
  const candidates: TakeoverCandidate[] = [];
  let self = 0;
  let incompatible = 0;

  for (const entry of input.entries) {
    if (isSelf(entry.moduleName)) {
      self += 1;
      continue;
    }
    const transport = detectTransport(entry.moduleName);
    if (!transport) {
      incompatible += 1;
      continue;
    }
    candidates.push({
      moduleName: entry.moduleName,
      transport,
      enabled: entry.enabled,
      alive: entry.fiberPhase === 'active',
    });
  }

  // 在线的排前面，其余按名字稳定排序：同样的输入每次输出的顺序一致，便于对比
  candidates.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return a.moduleName.localeCompare(b.moduleName);
  });

  const sinks = [...new Set(input.sinks.map((sink) => sink.type))].sort();

  return {
    generatedAt: input.now,
    sinks,
    candidates,
    inbound: [...input.inbound],
    rejectedInbound: [...(input.rejectedInbound ?? [])],
    summary: {
      plugins: input.entries.length,
      self,
      candidates: candidates.length,
      incompatible,
      sinks: sinks.length,
      inbound: input.inbound.length,
    },
  };
}
