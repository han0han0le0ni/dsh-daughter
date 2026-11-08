/**
 * 权重化判定：0.00–1.00、两位小数。
 *
 * 旧的档位是单点硬判断（`preference >= 0.15` 才算"喜欢"），数据挪动 0.01，
 * 整行文字就消失或翻面，也没法同时表达"有点喜欢、但更多是习惯"这种混合状态。
 * 这里统一成锚点表：每个档位有明确位置，值落在两档之间时按线性关系分配权重，
 * 结果总和恒为 1.00——一组档位因此可以同时成立（多心情 / 多性格），且都保留两位小数。
 */
export interface WeightedLabel {
    label: string;
    /** 0.00–1.00；同一组权重总和为 1.00 */
    weight: number;
}
export interface Anchor {
    label: string;
    /** 锚点位置：值落在这里时该档取 1.00 */
    at: number;
}
/** 两位小数，并夹在 0.00–1.00 */
export declare function round2(value: number): number;
/**
 * 极性强度：0.50 为中性取 0.00，越靠近端点越强，端点取 1.00。
 * 性格各维彼此独立，不做归一化——一个人可以既好奇又黏人，不必此消彼长。
 */
export declare function poleWeight(value: number): number;
/** 值当前落在哪一档：取 at 不超过该值的最后一个锚点，与旧的硬阈值口径一致 */
export declare function bucketIndex(value: number, anchors: readonly Anchor[]): number;
/**
 * 多标签分布：相邻锚点之间线性过渡，总和恰好 1.00。
 * 用于"可以同时成立"的语义（一件事既让人喜欢、又有点累）。
 */
export declare function distribute(value: number, anchors: readonly Anchor[]): WeightedLabel[];
/**
 * 主档 + 进度：主档恒 ≥ 0.50，剩余权重给下一档，总和 1.00。
 * 用于"同一时刻只有一个阶段"的场景（关系阶段），既保住主档稳定，又能说出在往哪走。
 * 传 fromLabel 时以已存阶段为准，尊重"回退需要低于阈值 0.1"的迟滞。
 */
export declare function progress(value: number, anchors: readonly Anchor[], fromLabel?: string): WeightedLabel[];
/** 权重最高的档；并列时取更靠前（锚点更低）的那个 */
export declare function primary(list: readonly WeightedLabel[]): WeightedLabel;
/** 按权重从高到低，去掉 0.00 的档 */
export declare function topLabels(list: readonly WeightedLabel[], count?: number): WeightedLabel[];
/** 跨档合计权重：用来表达"喜欢"这种各占几档的语义 */
export declare function labelWeight(list: readonly WeightedLabel[], labels: readonly string[]): number;
/** `喜欢 0.80、中性 0.20`；min 以下的不写，避免一堆 0.01 噪声 */
export declare function formatWeights(list: readonly WeightedLabel[], options?: {
    min?: number;
    count?: number;
}): string;
/**
 * 事物偏好：preference ∈ [-1, 1]。
 * ±0.50 对应"明确喜欢/不喜欢"，±1.00 才是"很喜欢/很不喜欢"，中间一直有过渡。
 */
export declare const PREFERENCE_ANCHORS: readonly Anchor[];
/** 关系阶段：深度 0.00–1.00，与 L2 阶段推进共用同一张表 */
export declare const STAGE_ANCHORS: readonly Anchor[];
/** 情绪心情：pleasure ∈ [-1, 1]，±0.25 起才开始算"轻快/偏低落"，与旧阈值对齐 */
export declare const MOOD_ANCHORS: readonly Anchor[];
