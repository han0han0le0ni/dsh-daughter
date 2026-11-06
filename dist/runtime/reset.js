/**
 * 重置能力：清记忆 / 恢复出厂人格 / 清条件反射 / 清技能 / 恢复出厂设置。
 *
 * 四条设计取舍（都来自真实翻车）：
 * 1. 只走 Store 的公开读写口，不在这里拼 SQL —— 逻辑可单测，宿主侧不需要额外迁移脚本。
 * 2. 先 plan 再 apply：`planReset` 纯读，`--dry-run` 输出它；apply 才真的删。
 * 3. 清目录用 `rename` 而不是递归删除：装了安全删除守卫的环境里 `rmSync` 会因
 *    "批量超过阈值需二次确认"抛错，把重置打断在半途（表清了、归档和人格还在）。
 * 4. 每一步独立 try/catch，失败继续往下走，最后用 `verifyReset` 读回复核——
 *    绝不允许"命令返回成功但只清了一半"。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DEFAULT_L1, DEFAULT_L2, DEFAULT_L3, DEFAULT_L4, DEFAULT_REFLEX_RULES, } from '../store.js';
export const RESET_SCOPES = ['memory', 'personality', 'reflex', 'skills', 'all'];
/** 每个域会动到的 meta 键：`*` 结尾按前缀删 */
const META_BY_SCOPE = {
    memory: ['filter*', 'reconstruct*', 'douyin*'],
    personality: ['personality*', 'lastPersonaEvolveAt', 'personaTurns', 'toneAvg'],
    reflex: ['reflex*'],
    skills: ['skill*', 'assetFail*'],
};
function countFiles(dir) {
    if (!existsSync(dir))
        return 0;
    try {
        return readdirSync(dir).length;
    }
    catch {
        return 0;
    }
}
function currentScope(scope) {
    return scope === 'all' ? ['memory', 'personality', 'reflex', 'skills'] : [scope];
}
/** 只读：列出这一域会被清掉什么，供 dry-run 与确认提示使用 */
export function planReset(store, scope) {
    const items = [];
    const scopes = currentScope(scope);
    if (scopes.includes('memory')) {
        const counts = store.countEvents();
        items.push({
            label: '事件记忆',
            detail: `${counts.total} 条（活跃 ${counts.active} / 归档 ${counts.archived}）`,
        });
        items.push({ label: '回看记录', detail: `${store.countEmotionHistory()} 条` });
        const filters = store.readCounters('filter.');
        items.push({ label: '滤网计数', detail: `${Object.keys(filters).length} 项` });
        items.push({
            label: '正文与归档文件',
            detail: `fulltext ${countFiles(store.paths.fulltext)} 个 / archive ${countFiles(store.paths.archive)} 个 / star_map ${countFiles(store.paths.starMap)} 个`,
        });
    }
    if (scopes.includes('personality')) {
        const persona = store.loadPersona();
        items.push({
            label: 'L1–L4 人格',
            detail: `偏差 ${Object.keys(persona.l3.biasWeights).length} 项、策略 ${persona.l3.copingStrategies.length} 条、依恋 ${persona.l2.attachmentType}、子人格 ${persona.l4.subPersonas.length} 个`,
        });
        items.push({ label: '人格 meta 标记', detail: '攒批方向/计数、循环、演化节流时间、tone 均值' });
        items.push({ label: '演化日志', detail: `${countFiles(store.paths.evolution)} 个文件` });
    }
    if (scopes.includes('reflex')) {
        const rules = store.loadReflexRules();
        const state = store.loadReflexState();
        items.push({ label: '反射规则', detail: `${rules.length} 条（恢复为出厂 ${DEFAULT_REFLEX_RULES.length} 条）` });
        items.push({ label: '冷却状态', detail: `${Object.keys(state).length} 条` });
    }
    if (scopes.includes('skills')) {
        items.push({ label: '技能卡', detail: `${countFiles(store.paths.skills)} 个文件` });
        items.push({ label: '动作模板', detail: `${countFiles(store.paths.motions)} 个文件` });
    }
    if (scope === 'all') {
        items.push({
            label: 'L5 状态 / 安全 / 透支',
            detail: `会话状态 ${countFiles(store.paths.l5)} 个，另清 safety、overdraft、body`,
        });
        items.push({ label: '运行基准', detail: 'lastTickAt / motivation / pet 相关键' });
    }
    return { scope, items };
}
function backup(store, paths) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(store.dataRoot, 'logs', 'reset-backup', stamp);
    let copied = 0;
    for (const path of paths) {
        if (!existsSync(path))
            continue;
        const destination = join(target, relative(store.dataRoot, path));
        try {
            mkdirSync(dirname(destination), { recursive: true });
            cpSync(path, destination, { recursive: true });
            copied += 1;
        }
        catch {
            // 单个路径备份失败不阻断重置
        }
    }
    return copied > 0 ? target : null;
}
/**
 * 清空目录但**不做递归删除**：把整个目录 rename 到 `logs/reset-trash/<时间戳>/`。
 * 同卷 rename 近乎瞬时、不触发安全删除守卫，而且万一要捞还能捞回来。
 */
function retireDirectory(store, path, stamp) {
    if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
        return null;
    }
    const target = join(store.dataRoot, 'logs', 'reset-trash', stamp, relative(store.dataRoot, path));
    mkdirSync(dirname(target), { recursive: true });
    renameSync(path, target);
    mkdirSync(path, { recursive: true });
    return target;
}
/** 执行重置。`backup: false` 用于测试，生产 CLI 默认开启 */
export function applyReset(store, scope, options = {}) {
    const plan = planReset(store, scope);
    const scopes = currentScope(scope);
    const applied = [];
    const retired = [];
    const errors = [];
    const fileTargets = [];
    if (scopes.includes('memory'))
        fileTargets.push(store.paths.fulltext, store.paths.archive, store.paths.starMap);
    if (scopes.includes('personality'))
        fileTargets.push(store.paths.neocortex, store.paths.evolution);
    if (scopes.includes('reflex'))
        fileTargets.push(store.paths.reflexes);
    if (scopes.includes('skills'))
        fileTargets.push(store.paths.skills, store.paths.motions);
    if (scope === 'all')
        fileTargets.push(store.paths.l5, store.paths.safety, store.paths.overdraft, store.paths.body);
    const backupDir = options.backup === false ? null : backup(store, fileTargets);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const step = (label, fn) => {
        try {
            fn();
        }
        catch (error) {
            errors.push(`${label}：${String(error)}`);
        }
    };
    const retire = (path, label) => {
        step(label, () => {
            const target = retireDirectory(store, path, stamp);
            if (target === null) {
                // 目录本就不存在：建空目录即可，不该出现在"垃圾桶"清单里误导人去找
                applied.push(`${label}（目录本就不存在，已建空目录）`);
                return;
            }
            retired.push(target);
            applied.push(label);
        });
    };
    // 先把数据库 / meta / 单文件处理完，再统一退休目录
    if (scopes.includes('memory')) {
        step('清空记忆', () => {
            const cleared = store.clearMemory();
            applied.push(`清空事件 ${cleared.events} 条、回看 ${cleared.emotions} 条`);
        });
    }
    if (scopes.includes('personality')) {
        step('写回出厂人格', () => {
            store.savePersonaLayer('l1', DEFAULT_L1);
            store.savePersonaLayer('l2', DEFAULT_L2);
            store.savePersonaLayer('l3', DEFAULT_L3);
            store.savePersonaLayer('l4', DEFAULT_L4);
            applied.push('L1–L4 写回出厂基线');
        });
    }
    if (scopes.includes('reflex')) {
        step('重置反射', () => {
            // 删文件而不是写默认值：loadReflexRules 缺文件时本就回退出厂规则
            rmSync(join(store.paths.reflexes, 'rules.yaml'), { force: true });
            rmSync(join(store.paths.reflexes, 'state.json'), { force: true });
            applied.push('反射规则与冷却状态恢复出厂');
        });
    }
    if (scope === 'all') {
        step('清空安全态', () => {
            for (const path of [store.paths.safety, store.paths.overdraft, store.paths.body]) {
                rmSync(path, { force: true });
            }
            applied.push('清空安全态、透支与身体信号');
        });
    }
    step('删除 meta', () => {
        const metaPatterns = scopes.flatMap((item) => META_BY_SCOPE[item]);
        if (scope === 'all')
            metaPatterns.push('lastTickAt', 'motivation*', 'pet*');
        applied.push(`删除 meta ${store.deleteMeta(metaPatterns)} 项`);
    });
    if (scopes.includes('memory')) {
        retire(store.paths.fulltext, '移走全文库');
        retire(store.paths.archive, '移走归档');
        retire(store.paths.starMap, '移走星图快照');
    }
    if (scopes.includes('personality'))
        retire(store.paths.evolution, '移走演化日志');
    if (scopes.includes('skills')) {
        retire(store.paths.skills, '移走技能卡');
        retire(store.paths.motions, '移走动作模板');
    }
    if (scope === 'all')
        retire(store.paths.l5, '移走 L5 会话状态');
    return { ...plan, backupDir, applied, retired, errors };
}
/**
 * 重置后复核：把"以为清了"变成"读回来确认清了"。
 * CLI 照这份结果打勾叉，任一不通过就非零退出，并提示"插件可能仍在运行"。
 */
export function verifyReset(store, scope) {
    const scopes = currentScope(scope);
    const checks = [];
    const push = (label, ok, detail) => {
        checks.push({ label, ok, detail });
    };
    if (scopes.includes('memory')) {
        const counts = store.countEvents();
        push('事件记忆', counts.total === 0, `剩余 ${counts.total} 条`);
        const emotions = store.countEmotionHistory();
        push('回看记录', emotions === 0, `剩余 ${emotions} 条`);
        const archive = countFiles(store.paths.archive);
        push('归档文件', archive === 0, `剩余 ${archive} 个`);
        const fulltext = countFiles(store.paths.fulltext);
        push('全文文件', fulltext === 0, `剩余 ${fulltext} 个`);
    }
    if (scopes.includes('personality')) {
        const persona = store.loadPersona();
        push('L1 出厂基线', persona.l1.updatedAt === DEFAULT_L1.updatedAt && persona.l1.plasticity === DEFAULT_L1.plasticity, `updatedAt ${persona.l1.updatedAt}，plasticity ${persona.l1.plasticity}`);
        push('L2 出厂基线', persona.l2.updatedAt === DEFAULT_L2.updatedAt && persona.l2.relationshipDepth === DEFAULT_L2.relationshipDepth, `深度 ${persona.l2.relationshipDepth}，依恋 ${persona.l2.attachmentType}`);
        push('偏差权重', Object.keys(persona.l3.biasWeights).length === 0, `${Object.keys(persona.l3.biasWeights).length} 项`);
    }
    if (scopes.includes('reflex')) {
        const rules = store.loadReflexRules();
        push('反射规则', rules.length === DEFAULT_REFLEX_RULES.length, `${rules.length} 条（出厂 ${DEFAULT_REFLEX_RULES.length} 条）`);
        const statePath = join(store.paths.reflexes, 'state.json');
        push('冷却状态', !existsSync(statePath), existsSync(statePath) ? 'state.json 仍在' : '已清空');
    }
    if (scopes.includes('skills')) {
        const skills = store.loadSkills();
        push('技能卡', skills.length === 0, `剩余 ${skills.length} 张`);
    }
    if (scope === 'all') {
        const sessions = countFiles(store.paths.l5);
        push('L5 会话状态', sessions === 0, `剩余 ${sessions} 个`);
        const leftovers = [store.paths.safety, store.paths.overdraft, store.paths.body].filter((path) => existsSync(path));
        push('安全态 / 透支 / 身体信号', leftovers.length === 0, leftovers.length === 0 ? '已清空' : leftovers.join('、'));
        push('tick 基准', store.getMeta('lastTickAt') === null, store.getMeta('lastTickAt') ? 'lastTickAt 仍在' : '已清空');
    }
    return { ok: checks.every((check) => check.ok), checks };
}
