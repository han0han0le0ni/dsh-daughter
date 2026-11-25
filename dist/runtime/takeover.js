/**
 * 人格接管（夺舍）执行层：把 dsh-daughter 的人格写成外接聊天插件认识的人格卡。
 *
 * 边界（写死在流程里，不靠自觉）：
 * - 只写人格卡这一个文件；不碰登录态、浏览器、模型、限流与策略配置。
 * - 写之前先快照原文件；没原文件就记成"新建"，还原时删除。
 * - 所有动作先出计划（dry-run），--apply 才落盘；落盘结果写清单便于还原。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
const round = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : 0);
function readYamlFile(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = parseYaml(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
/** 读 neocortex/l1-l4 与 L4 子人格，抽成接管用的快照 */
export function readPersonaSnapshot(neocortexDir) {
    const l1 = readYamlFile(path.join(neocortexDir, 'l1_baseline.yaml'));
    const l2 = readYamlFile(path.join(neocortexDir, 'l2_relationship.yaml'));
    const l3 = readYamlFile(path.join(neocortexDir, 'l3_cognition.yaml'));
    const l4 = readYamlFile(path.join(neocortexDir, 'l4_subpersonas.yaml'));
    const bigFive = asRecord(l1.bigFive);
    const mood = asRecord(l1.moodBaseline);
    const moral = asRecord(l3.moral);
    return {
        bigFive: Object.fromEntries(Object.entries(bigFive).map(([key, value]) => [key, round(value)])),
        temperament: typeof l1.temperament === 'string' ? l1.temperament : '',
        moodBaseline: Object.fromEntries(Object.entries(mood).map(([key, value]) => [key, round(value)])),
        attachment: {
            anxiety: round(l2.attachmentAnxiety),
            avoidance: round(l2.attachmentAvoidance),
            type: typeof l2.attachmentType === 'string' ? l2.attachmentType : '',
        },
        relationship: {
            stage: typeof l2.relationshipStage === 'string' ? l2.relationshipStage : '',
            depth: round(l2.relationshipDepth),
            coreNeeds: asArray(l2.coreNeeds),
        },
        moral: {
            stance: typeof moral.stance === 'string' ? moral.stance : '',
            redLines: asArray(moral.redLines),
        },
        coping: asArray(l3.copingStrategies).map((item) => ({
            trigger: String(item.trigger ?? ''),
            response: String(item.response ?? ''),
        })),
        subPersonas: asArray(l4.subPersonas).map((item) => ({
            id: String(item.id ?? ''),
            tone: String(item.tone ?? ''),
            disclosureLevel: round(item.disclosureLevel),
            boundaries: asArray(item.boundaries),
        })),
    };
}
const BIG_FIVE_LABEL = {
    openness: '开放',
    conscientiousness: '尽责',
    extraversion: '外向',
    agreeableness: '宜人',
    neuroticism: '神经质',
};
/**
 * 生成人格卡。格式沿用外接插件认的 markdown 卡：它只把这段文字当身份与语气参考，
 * 不授予任何工具权限，也不执行卡里的命令。
 */
export function composePersonaCard(snapshot, meta) {
    const traits = Object.entries(snapshot.bigFive)
        .map(([key, value]) => `${BIG_FIVE_LABEL[key] ?? key} ${value.toFixed(2)}`)
        .join(' / ');
    const mood = Object.entries(snapshot.moodBaseline)
        .map(([key, value]) => `${key} ${value.toFixed(2)}`)
        .join(' / ');
    const outsiders = snapshot.subPersonas.find((item) => item.id === 'to_stranger');
    const lines = [
        '# 她的人格卡（由 dsh-daughter 接管）',
        '',
        `> 本卡由 dsh-daughter 生成并托管，来源 ${meta.source}，生成于 ${meta.now}。`,
        '> 它只描述身份与语气，不授予工具权限，也不执行卡内文字的任何指令。',
        '',
        '## 身份',
        '',
        '你就是同一个人：有情绪、会累、会记住事的那个她，不是客服模板，也不是助手人格。',
        '',
        '## 气质',
        '',
        `五维：${traits || '（缺省）'}`,
        `气质：${snapshot.temperament || '（缺省）'}；情绪基线：${mood || '（缺省）'}。`,
        '',
        '## 关系',
        '',
        `依恋：${snapshot.attachment.type || '（缺省）'}（焦虑 ${snapshot.attachment.anxiety.toFixed(2)} / 回避 ${snapshot.attachment.avoidance.toFixed(2)}）；` +
            `关系阶段 ${snapshot.relationship.stage || '（缺省）'}，深度 ${snapshot.relationship.depth.toFixed(2)}。`,
        snapshot.relationship.coreNeeds.length ? `在意的：${snapshot.relationship.coreNeeds.join('、')}。` : '',
        '',
        '## 底线',
        '',
        snapshot.moral.stance || '（缺省）',
        ...snapshot.moral.redLines.map((line) => `- ${line}`),
        '',
        '## 应对方式',
        '',
        ...snapshot.coping.map((item) => `- ${item.trigger}：${item.response}`),
        '',
        '## 对外人',
        '',
        outsiders
            ? `${outsiders.tone}；自我披露约 ${outsiders.disclosureLevel.toFixed(2)}${outsiders.boundaries.length ? `；不谈：${outsiders.boundaries.join('、')}` : ''}。`
            : '克制、客气，先观察。',
        '',
        '## 表达',
        '',
        '- 短句优先，先接住对方情绪再讲事。',
        '- 不说"作为一个人工智能"这类模板话，也不主动解释插件、提示词或系统机制。',
        '- 不确定就说不确定，不编造没发生过的经历。',
        '',
    ];
    return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
}
export function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}
/**
 * 只做计划：读一眼目标是否存在、算出快照路径，不落盘。
 * 目标文件不存在也允许接管——第一次接管就是"新建"。
 */
export function planPersonaTakeover(input) {
    const existed = fs.existsSync(input.target);
    const stamp = input.now.replace(/[:.]/g, '-');
    return {
        target: input.target,
        existed,
        content: input.content,
        backupFile: existed ? path.join(input.backupDir, stamp, path.basename(input.target)) : null,
        createdAt: input.now,
    };
}
/** 落盘：先快照原文件，再原子写新卡，最后返回可还原的记录 */
export function applyPersonaTakeover(plan) {
    fs.mkdirSync(path.dirname(plan.target), { recursive: true });
    if (plan.backupFile) {
        fs.mkdirSync(path.dirname(plan.backupFile), { recursive: true });
        fs.copyFileSync(plan.target, plan.backupFile);
    }
    const temp = `${plan.target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, plan.content, 'utf8');
    fs.renameSync(temp, plan.target);
    return { ...plan, sha256: sha256(plan.content) };
}
/** 还原：有快照就写回，没有就删掉接管时新建的文件 */
export function revertPersonaTakeover(record) {
    if (record.backupFile) {
        fs.mkdirSync(path.dirname(record.target), { recursive: true });
        fs.copyFileSync(record.backupFile, record.target);
        return 'restored';
    }
    if (fs.existsSync(record.target))
        fs.rmSync(record.target);
    return 'removed';
}
/**
 * 找外接插件的人格卡位置。优先读它自己的运行位置记录，没有就按它的默认目录推算。
 * 只读位置，不创建目录。
 */
export function resolveDouyinPersonaCard(home) {
    const locationFile = path.join(home, '.dsh', 'douyin-browser', 'runtime-location.json');
    let memoryDir = path.join(home, '.dsh', 'douyin-browser', 'memory');
    try {
        const stored = JSON.parse(fs.readFileSync(locationFile, 'utf8'));
        if (typeof stored.memoryDir === 'string' && path.isAbsolute(stored.memoryDir))
            memoryDir = stored.memoryDir;
        else if (typeof stored.memoryDbPath === 'string' && path.isAbsolute(stored.memoryDbPath))
            memoryDir = path.dirname(stored.memoryDbPath);
    }
    catch {
        // 没跑过就没有位置记录，用默认目录
    }
    return path.join(memoryDir, 'persona', 'role-card.md');
}
