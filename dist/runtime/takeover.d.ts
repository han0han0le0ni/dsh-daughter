/**
 * 人格接管（夺舍）执行层：把 dsh-daughter 的人格写成外接聊天插件认识的人格卡。
 *
 * 边界（写死在流程里，不靠自觉）：
 * - 只写人格卡这一个文件；不碰登录态、浏览器、模型、限流与策略配置。
 * - 写之前先快照原文件；没原文件就记成"新建"，还原时删除。
 * - 所有动作先出计划（dry-run），--apply 才落盘；落盘结果写清单便于还原。
 */
/** 从 dsh-daughter 的人格分层里抽出的可读快照 */
export interface PersonaSnapshot {
    bigFive: Record<string, number>;
    temperament: string;
    moodBaseline: Record<string, number>;
    attachment: {
        anxiety: number;
        avoidance: number;
        type: string;
    };
    relationship: {
        stage: string;
        depth: number;
        coreNeeds: string[];
    };
    moral: {
        stance: string;
        redLines: string[];
    };
    coping: Array<{
        trigger: string;
        response: string;
    }>;
    subPersonas: Array<{
        id: string;
        tone: string;
        disclosureLevel: number;
        boundaries: string[];
    }>;
}
export interface TakeoverPlan {
    target: string;
    /** 目标原来是否存在。不存在时还原 = 删除 */
    existed: boolean;
    content: string;
    /** 原文件快照路径；不存在时为 null */
    backupFile: string | null;
    createdAt: string;
}
export interface TakeoverRecord extends TakeoverPlan {
    sha256: string;
}
/** 读 neocortex/l1-l4 与 L4 子人格，抽成接管用的快照 */
export declare function readPersonaSnapshot(neocortexDir: string): PersonaSnapshot;
/**
 * 生成人格卡。格式沿用外接插件认的 markdown 卡：它只把这段文字当身份与语气参考，
 * 不授予任何工具权限，也不执行卡里的命令。
 */
export declare function composePersonaCard(snapshot: PersonaSnapshot, meta: {
    now: string;
    source: string;
}): string;
export declare function sha256(text: string): string;
/**
 * 只做计划：读一眼目标是否存在、算出快照路径，不落盘。
 * 目标文件不存在也允许接管——第一次接管就是"新建"。
 */
export declare function planPersonaTakeover(input: {
    target: string;
    content: string;
    backupDir: string;
    now: string;
}): TakeoverPlan;
/** 落盘：先快照原文件，再原子写新卡，最后返回可还原的记录 */
export declare function applyPersonaTakeover(plan: TakeoverPlan): TakeoverRecord;
/** 还原：有快照就写回，没有就删掉接管时新建的文件 */
export declare function revertPersonaTakeover(record: TakeoverRecord): 'restored' | 'removed';
/**
 * 找外接插件的人格卡位置。优先读它自己的运行位置记录，没有就按它的默认目录推算。
 * 只读位置，不创建目录。
 */
export declare function resolveDouyinPersonaCard(home: string): string;
