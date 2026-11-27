export interface PersonaCard {
    /** 她的名字 */
    name: string;
    /** 她怎么自称 */
    self_ref: string;
    /** 她怎么称呼对方 */
    user_ref: string;
    /** 一句话背景：她是谁、从哪来、和对方什么关系 */
    background: string;
    /** 说话风格：句长、语气、口头禅 */
    voice: string;
    /** 绝不主动提起的话题 */
    taboos: string[];
}
export declare const EMPTY_PERSONA_CARD: PersonaCard;
export declare function personaCardPath(dataRoot: string): string;
/** 非法输入一律收敛成空卡：角色卡不该因为一个手滑的字段让整块注入报错 */
export declare function normalizePersonaCard(raw: unknown): PersonaCard;
export declare function isEmptyPersonaCard(card: PersonaCard): boolean;
export declare function loadPersonaCard(dataRoot: string): PersonaCard;
/** 原子写入：中途失败不会留下半截 JSON，下次读到坏文件也只会回空卡 */
export declare function savePersonaCard(dataRoot: string, raw: unknown): PersonaCard;
/**
 * 渲染成注入文本：只写填过的项，空卡返回空串。
 * 抬头写明「优先于推演」，避免模型把角色卡当成又一段可忽略的背景描述。
 */
export declare function renderPersonaCard(card: PersonaCard): string;
