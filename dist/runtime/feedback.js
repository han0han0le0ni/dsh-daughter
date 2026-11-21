import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export const FEEDBACK_REPO = 'han0han0le0ni/dsh-daughter';
export const FEEDBACK_CATEGORIES = ['投诉', '意见', '故障', '其他'];
const MAX_TITLE = 120;
const MAX_BODY = 5000;
const MAX_CONTACT = 120;
const MAX_QUEUE = 500;
function clean(value, max) {
    return typeof value === 'string'
        ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max)
        : '';
}
export function normalizeFeedback(input) {
    const raw = (input && typeof input === 'object' ? input : {});
    const category = FEEDBACK_CATEGORIES.includes(raw.category)
        ? raw.category
        : '意见';
    const title = clean(raw.title, MAX_TITLE);
    const body = clean(raw.body, MAX_BODY);
    const contact = clean(raw.contact, MAX_CONTACT);
    if (!title)
        throw new Error('请填写标题');
    if (!body)
        throw new Error('请填写内容');
    return {
        category,
        title,
        body,
        contact,
        includeDiagnostics: raw.includeDiagnostics === true,
    };
}
export function buildIssueTitle(record) {
    return `[${record.category}] ${record.title}`;
}
export function buildIssueBody(record, meta) {
    const lines = [
        `分类：${record.category}`,
        `提交时间：${record.createdAt}`,
        '',
        '## 内容',
        '',
        record.body,
    ];
    if (record.contact)
        lines.push('', '## 联系方式（用户自愿填写）', '', record.contact);
    if (record.includeDiagnostics) {
        lines.push('', '## 环境信息（用户勾选后附带）', '', `- 插件版本：${meta.pluginVersion}`, `- 宿主版本：${meta.dshVersion ?? '未知'}`, `- 平台：${meta.platform ?? '未知'} / ${meta.arch ?? '未知'}`, `- Node：${meta.nodeVersion ?? process.version}`);
    }
    lines.push('', '---', '', '由 dsh-daughter 意见反馈面板提交，请勿在此帖发布密码、令牌等敏感信息。');
    return lines.join('\n');
}
export function buildIssueUrl(record, meta) {
    const url = new URL(`https://github.com/${FEEDBACK_REPO}/issues/new`);
    url.searchParams.set('title', buildIssueTitle(record));
    url.searchParams.set('body', buildIssueBody(record, meta));
    return url.toString();
}
export function feedbackQueuePath(dataRoot) {
    return join(dataRoot, 'logs', 'feedback', 'queue.jsonl');
}
export function readFeedbackQueue(path) {
    if (!existsSync(path))
        return [];
    const records = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim())
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed.id === 'string' && typeof parsed.body === 'string')
                records.push(parsed);
        }
        catch {
            // 坏行只跳过，不让一条截断记录毁掉整个反馈队列
        }
    }
    return records;
}
export function appendFeedbackRecord(path, record) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}
export function rewriteFeedbackQueue(path, records) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
    renameSync(temp, path);
}
export function pendingFeedback(path) {
    return readFeedbackQueue(path).filter((record) => record.status === 'pending' && !record.issueNumber);
}
/** 只使用环境中的令牌或本机 gh 登录态；绝不把令牌写入队列、日志或返回值。 */
export async function resolveGitHubToken() {
    const envToken = process.env.DSH_GITHUB_TOKEN?.trim();
    if (envToken)
        return envToken;
    try {
        const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 3000, maxBuffer: 64 * 1024 });
        return stdout.trim() || undefined;
    }
    catch {
        return undefined;
    }
}
function parseIssueResponse(text) {
    const data = JSON.parse(text);
    if (!data.number || !data.html_url)
        throw new Error('GitHub 响应缺少 issue 编号');
    return { number: data.number, html_url: data.html_url };
}
function postViaFetch(url, token, json, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    return fetchImpl(url, {
        method: 'POST',
        headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-github-api-version': '2022-11-28',
        },
        body: json,
        signal: controller.signal,
    }).then(async (response) => {
        if (!response.ok)
            throw new Error(`GitHub 返回 ${response.status}`);
        return parseIssueResponse(await response.text());
    }).finally(() => clearTimeout(timer));
}
/**
 * Windows 上 Node 自带 CA 常不信任本机代理证书，直接用系统 curl（走 Windows 证书链）。
 * 令牌只经 stdin 配置传入，不进进程参数与文件。
 */
function postViaCurl(url, token, json) {
    const escaped = json.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const config = [
        'request = POST',
        `url = "${url}"`,
        'header = "Accept: application/vnd.github+json"',
        `header = "Authorization: Bearer ${token}"`,
        'header = "Content-Type: application/json"',
        'header = "X-GitHub-Api-Version: 2022-11-28"',
        `data = "${escaped}"`,
        'silent', 'show-error', 'max-time = 25',
        'write-out = "\\n%{http_code}"',
    ].join('\n');
    const args = process.platform === 'win32' ? ['--ssl-no-revoke', '--config', '-'] : ['--config', '-'];
    return new Promise((resolve, reject) => {
        const child = spawn('curl.exe', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('网络请求超时')); }, 30_000);
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', (error) => { clearTimeout(timer); reject(new Error(`网络请求失败：${error.message}`)); });
        child.on('close', () => {
            clearTimeout(timer);
            const cut = stdout.lastIndexOf('\n');
            const status = (cut >= 0 ? stdout.slice(cut + 1) : '').trim();
            if (!/^2\d\d$/.test(status)) {
                reject(new Error(status ? `GitHub 返回 ${status}` : `网络请求失败：${stderr.trim().slice(0, 160) || '无响应'}`));
                return;
            }
            try {
                resolve(parseIssueResponse(cut >= 0 ? stdout.slice(0, cut) : stdout));
            }
            catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
        child.stdin.end(config);
    });
}
/** 传输方式按平台一次选好：Windows 走 curl，其余平台走 fetch；测试可注入 fetch。 */
export async function submitToGitHub(record, meta, token, fetchImpl = fetch) {
    const url = `https://api.github.com/repos/${FEEDBACK_REPO}/issues`;
    const json = JSON.stringify({ title: buildIssueTitle(record), body: buildIssueBody(record, meta) });
    if (fetchImpl !== fetch)
        return postViaFetch(url, token, json, fetchImpl);
    if (process.platform === 'win32')
        return postViaCurl(url, token, json);
    return postViaFetch(url, token, json, fetch);
}
function makeRecord(input, now) {
    return { ...input, id: randomUUID(), createdAt: now.toISOString(), status: 'pending' };
}
function queueReport(path) {
    const records = readFeedbackQueue(path);
    return { total: records.length, synced: records.filter((r) => r.status === 'synced').length, pending: records.filter((r) => r.status === 'pending').length };
}
async function tokenFor(options) {
    return options.token === undefined ? await resolveGitHubToken() : options.token;
}
/** 一条反馈只有两种结果：同步成功，或留下预填链接。新提交与补发共用这一条路径。 */
async function sendOne(record, meta, options, token) {
    if (!token)
        return { ...record, issueUrl: buildIssueUrl(record, meta) };
    try {
        const issue = await submitToGitHub(record, meta, token, options.fetchImpl);
        return {
            ...record,
            status: 'synced',
            issueNumber: issue.number,
            issueHtmlUrl: issue.html_url,
            issueUrl: issue.html_url,
        };
    }
    catch (error) {
        return {
            ...record,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
            issueUrl: buildIssueUrl(record, meta),
        };
    }
}
/** 用户提交：校验 → 同步一次 → 写一条最终记录。 */
export async function submitFeedback(path, raw, meta, options = {}) {
    const record = makeRecord(normalizeFeedback(raw), options.now?.() ?? new Date());
    const result = await sendOne(record, meta, options, await tokenFor(options));
    appendFeedbackRecord(path, result);
    return result;
}
/** 打开面板时自动补发之前没发出去的条目；用户不需要再点按钮。 */
export async function retryPendingFeedback(path, meta, options = {}) {
    const waiting = pendingFeedback(path).slice(0, 20);
    const token = await tokenFor(options);
    if (waiting.length === 0 || !token)
        return { scanned: waiting.length, synced: 0 };
    const all = readFeedbackQueue(path);
    const byId = new Map(all.map((item) => [item.id, item]));
    let synced = 0;
    for (const pending of waiting) {
        const record = byId.get(pending.id);
        if (!record)
            continue;
        const result = await sendOne(record, meta, options, token);
        if (result.status === 'synced') {
            record.status = 'synced';
            record.issueNumber = result.issueNumber;
            record.issueHtmlUrl = result.issueHtmlUrl;
            delete record.error;
            synced += 1;
        }
        else if (result.error) {
            record.error = result.error;
        }
    }
    rewriteFeedbackQueue(path, all.slice(-MAX_QUEUE));
    return { scanned: waiting.length, synced };
}
export function feedbackStatus(path) {
    const report = queueReport(path);
    return { ...report, repo: FEEDBACK_REPO };
}
