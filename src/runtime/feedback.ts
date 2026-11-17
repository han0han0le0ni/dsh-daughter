import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const FEEDBACK_REPO = 'han0han0le0ni/dsh-daughter';
export const FEEDBACK_CATEGORIES = ['投诉', '意见', '故障', '其他'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export interface FeedbackInput {
  category: FeedbackCategory;
  title: string;
  body: string;
  contact: string;
  includeDiagnostics: boolean;
}

export interface FeedbackMeta {
  pluginVersion: string;
  dshVersion?: string;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
}

export interface FeedbackRecord extends FeedbackInput {
  id: string;
  createdAt: string;
  status: 'pending' | 'synced';
  issueNumber?: number;
  issueHtmlUrl?: string;
  error?: string;
}

export interface SubmitOptions {
  /** 显式传空串表示本次不联网；不传则读 DSH_GITHUB_TOKEN 或 gh auth token */
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const MAX_TITLE = 120;
const MAX_BODY = 5000;
const MAX_CONTACT = 120;
const MAX_QUEUE = 500;

function clean(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max)
    : '';
}

export function normalizeFeedback(input: unknown): FeedbackInput {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const category = FEEDBACK_CATEGORIES.includes(raw.category as FeedbackCategory)
    ? (raw.category as FeedbackCategory)
    : '意见';
  const title = clean(raw.title, MAX_TITLE);
  const body = clean(raw.body, MAX_BODY);
  const contact = clean(raw.contact, MAX_CONTACT);
  if (!title) throw new Error('请填写标题');
  if (!body) throw new Error('请填写内容');
  return {
    category,
    title,
    body,
    contact,
    includeDiagnostics: raw.includeDiagnostics === true,
  };
}

export function buildIssueTitle(record: FeedbackRecord): string {
  return `[${record.category}] ${record.title}`;
}

export function buildIssueBody(record: FeedbackRecord, meta: FeedbackMeta): string {
  const lines = [
    `分类：${record.category}`,
    `提交时间：${record.createdAt}`,
    '',
    '## 内容',
    '',
    record.body,
  ];
  if (record.contact) lines.push('', '## 联系方式（用户自愿填写）', '', record.contact);
  if (record.includeDiagnostics) {
    lines.push(
      '',
      '## 环境信息（用户勾选后附带）',
      '',
      `- 插件版本：${meta.pluginVersion}`,
      `- 宿主版本：${meta.dshVersion ?? '未知'}`,
      `- 平台：${meta.platform ?? '未知'} / ${meta.arch ?? '未知'}`,
      `- Node：${meta.nodeVersion ?? process.version}`,
    );
  }
  lines.push('', '---', '', '由 dsh-daughter 意见反馈面板提交，请勿在此帖发布密码、令牌等敏感信息。');
  return lines.join('\n');
}

export function buildIssueUrl(record: FeedbackRecord, meta: FeedbackMeta): string {
  const url = new URL(`https://github.com/${FEEDBACK_REPO}/issues/new`);
  url.searchParams.set('title', buildIssueTitle(record));
  url.searchParams.set('body', buildIssueBody(record, meta));
  return url.toString();
}

export function feedbackQueuePath(dataRoot: string): string {
  return join(dataRoot, 'logs', 'feedback', 'queue.jsonl');
}

export function readFeedbackQueue(path: string): FeedbackRecord[] {
  if (!existsSync(path)) return [];
  const records: FeedbackRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as FeedbackRecord;
      if (parsed && typeof parsed.id === 'string' && typeof parsed.body === 'string') records.push(parsed);
    } catch {
      // 坏行只跳过，不让一条截断记录毁掉整个反馈队列
    }
  }
  return records;
}

export function appendFeedbackRecord(path: string, record: FeedbackRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

export function rewriteFeedbackQueue(path: string, records: FeedbackRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  renameSync(temp, path);
}

export function pendingFeedback(path: string): FeedbackRecord[] {
  return readFeedbackQueue(path).filter((record) => record.status === 'pending' && !record.issueNumber);
}

/** 只使用环境中的令牌或本机 gh 登录态；绝不把令牌写入队列、日志或返回值。 */
export async function resolveGitHubToken(): Promise<string | undefined> {
  const envToken = process.env.DSH_GITHUB_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 3000, maxBuffer: 64 * 1024 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function submitToGitHub(
  record: FeedbackRecord,
  meta: FeedbackMeta,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ number: number; html_url: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${FEEDBACK_REPO}/issues`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ title: buildIssueTitle(record), body: buildIssueBody(record, meta) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub 返回 ${response.status}`);
    }
    const data = (await response.json()) as { number?: number; html_url?: string };
    if (!data.number || !data.html_url) throw new Error('GitHub 响应缺少 issue 编号');
    return { number: data.number, html_url: data.html_url };
  } finally {
    clearTimeout(timer);
  }
}

function makeRecord(input: FeedbackInput, now: Date): FeedbackRecord {
  return { ...input, id: randomUUID(), createdAt: now.toISOString(), status: 'pending' };
}

function queueReport(path: string) {
  const records = readFeedbackQueue(path);
  return { total: records.length, synced: records.filter((r) => r.status === 'synced').length, pending: records.filter((r) => r.status === 'pending').length };
}

/** 写入本地队列；有 GitHub 令牌时直接开 issue，没令牌也能一键跳转到预填页面。 */
export async function submitFeedback(
  path: string,
  raw: unknown,
  meta: FeedbackMeta,
  options: SubmitOptions = {},
): Promise<FeedbackRecord & { issueUrl: string }> {
  const input = normalizeFeedback(raw);
  const record = makeRecord(input, options.now?.() ?? new Date());
  appendFeedbackRecord(path, record);

  const token = options.token === undefined ? await resolveGitHubToken() : options.token;
  if (!token) {
    return { ...record, issueUrl: buildIssueUrl(record, meta) };
  }
  try {
    const issue = await submitToGitHub(record, meta, token, options.fetchImpl);
    const updated: FeedbackRecord = { ...record, status: 'synced', issueNumber: issue.number, issueHtmlUrl: issue.html_url };
    rewriteFeedbackQueue(path, readFeedbackQueue(path).map((item) => (item.id === record.id ? updated : item)));
    return { ...updated, issueUrl: issue.html_url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const updated: FeedbackRecord = { ...record, error: message.slice(0, 200) };
    rewriteFeedbackQueue(path, readFeedbackQueue(path).map((item) => (item.id === record.id ? updated : item)));
    return { ...updated, issueUrl: buildIssueUrl(record, meta) };
  }
}

/** 用户后来登录了 gh 或设置了令牌时，把此前留下的待同步条目补发出去。 */
export async function retryPendingFeedback(
  path: string,
  meta: FeedbackMeta,
  options: SubmitOptions = {},
): Promise<{ scanned: number; synced: number }> {
  const waiting = pendingFeedback(path).slice(0, 20);
  if (waiting.length === 0) return { scanned: 0, synced: 0 };
  const token = options.token === undefined ? await resolveGitHubToken() : options.token;
  if (!token) return { scanned: waiting.length, synced: 0 };

  const byId = new Map(waiting.map((item) => [item.id, item]));
  let synced = 0;
  for (const record of waiting) {
    try {
      const issue = await submitToGitHub(record, meta, token, options.fetchImpl);
      byId.set(record.id, { ...record, status: 'synced', issueNumber: issue.number, issueHtmlUrl: issue.html_url });
      synced += 1;
    } catch {
      // 单条失败不影响其余条目，状态保持 pending，下次仍可重试
    }
  }
  const all = readFeedbackQueue(path).map((item) => byId.get(item.id) ?? item);
  rewriteFeedbackQueue(path, all.slice(-MAX_QUEUE));
  return { scanned: waiting.length, synced };
}

export function feedbackStatus(path: string) {
  const report = queueReport(path);
  return { ...report, repo: FEEDBACK_REPO };
}
