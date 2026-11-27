/**
 * 角色卡：主人亲手写下的「她是谁」。
 *
 * 与 L1–L4 的分工：人格是插件抽出来、再被经历推动的；角色卡是主人给定的身份约束，
 * 只放在人格注入块最前面，不参与演化，也不会被日常情绪冲掉。
 * 空卡不产生任何文本，旧存档与不填写的用户行为完全不变。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export const EMPTY_PERSONA_CARD = {
    name: '',
    self_ref: '',
    user_ref: '',
    background: '',
    voice: '',
    taboos: [],
};
/** 单项上限：角色卡和生成人格共用同一个注入预算，写太长会挤掉后面的推演 */
const LIMITS = { name: 24, self_ref: 16, user_ref: 16, background: 160, voice: 160 };
const MAX_TABOOS = 6;
const MAX_TABOO_CHARS = 12;
export function personaCardPath(dataRoot) {
    return join(dataRoot, 'settings', 'persona.json');
}
function text(value, limit) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}
/** 非法输入一律收敛成空卡：角色卡不该因为一个手滑的字段让整块注入报错 */
export function normalizePersonaCard(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const rawTaboos = Array.isArray(source.taboos)
        ? source.taboos
        : typeof source.taboos === 'string'
            ? source.taboos.split(/[，,、;；\n]/)
            : [];
    const taboos = [
        ...new Set(rawTaboos.map((item) => text(item, MAX_TABOO_CHARS)).filter(Boolean)),
    ].slice(0, MAX_TABOOS);
    return {
        name: text(source.name, LIMITS.name),
        self_ref: text(source.self_ref, LIMITS.self_ref),
        user_ref: text(source.user_ref, LIMITS.user_ref),
        background: text(source.background, LIMITS.background),
        voice: text(source.voice, LIMITS.voice),
        taboos,
    };
}
export function isEmptyPersonaCard(card) {
    return !card.name && !card.self_ref && !card.user_ref && !card.background && !card.voice && card.taboos.length === 0;
}
export function loadPersonaCard(dataRoot) {
    try {
        const path = personaCardPath(dataRoot);
        if (!existsSync(path))
            return { ...EMPTY_PERSONA_CARD };
        return normalizePersonaCard(JSON.parse(readFileSync(path, 'utf8')));
    }
    catch {
        return { ...EMPTY_PERSONA_CARD };
    }
}
/** 原子写入：中途失败不会留下半截 JSON，下次读到坏文件也只会回空卡 */
export function savePersonaCard(dataRoot, raw) {
    const card = normalizePersonaCard(raw);
    const path = personaCardPath(dataRoot);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(card, null, 2) + '\n', 'utf8');
    renameSync(temp, path);
    return card;
}
/**
 * 渲染成注入文本：只写填过的项，空卡返回空串。
 * 抬头写明「优先于推演」，避免模型把角色卡当成又一段可忽略的背景描述。
 */
export function renderPersonaCard(card) {
    if (isEmptyPersonaCard(card))
        return '';
    const lines = ['[角色卡·主人亲手写下，优先于下面由经历推演出的性格]'];
    const identity = [];
    if (card.name)
        identity.push(`名字：${card.name}`);
    if (card.self_ref)
        identity.push(`自称：${card.self_ref}`);
    if (card.user_ref)
        identity.push(`称呼对方：${card.user_ref}`);
    if (identity.length > 0)
        lines.push(`【身份】${identity.join('；')}。`);
    if (card.background)
        lines.push(`【背景】${card.background}`);
    if (card.voice)
        lines.push(`【说话风格】${card.voice}`);
    if (card.taboos.length > 0)
        lines.push(`【绝不主动提起】${card.taboos.join('、')}。`);
    return lines.join('\n');
}
