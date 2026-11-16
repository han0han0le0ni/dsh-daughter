import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  appendFeedbackRecord,
  buildIssueUrl,
  feedbackQueuePath,
  normalizeFeedback,
  pendingFeedback,
  readFeedbackQueue,
  retryPendingFeedback,
  rewriteFeedbackQueue,
  submitFeedback,
  type FeedbackMeta,
  type FeedbackRecord,
} from '../src/runtime/feedback.js';

const meta: FeedbackMeta = {
  pluginVersion: '0.8.0',
  dshVersion: '0.2.1',
  platform: 'win32',
  arch: 'x64',
  nodeVersion: 'v24.0.0',
};

function tempQueue() {
  const root = mkdtempSync(join(tmpdir(), 'dd-feedback-'));
  return { root, path: feedbackQueuePath(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function record(id: string, status: 'pending' | 'synced' = 'pending'): FeedbackRecord {
  return {
    id,
    createdAt: '2026-11-16T00:00:00.000Z',
    status,
    category: '投诉',
    title: '测试标题',
    body: '测试内容',
    contact: '',
    includeDiagnostics: false,
  };
}

test('normalizeFeedback 清洗控制字符、限长并校验必填项', () => {
  const input = normalizeFeedback({
    category: '不存在',
    title: `  标题\u0000\u0007  `,
    body: '正文'.repeat(3000),
    contact: '  mail@example.com  ',
    includeDiagnostics: true,
  });
  assert.equal(input.category, '意见');
  assert.equal(input.title, '标题');
  assert.equal(input.body.length, 5000);
  assert.equal(input.contact, 'mail@example.com');
  assert.equal(input.includeDiagnostics, true);
  assert.throws(() => normalizeFeedback({ title: '', body: '正文' }), /标题/);
  assert.throws(() => normalizeFeedback({ title: '标题', body: '  ' }), /内容/);
});

test('buildIssueUrl 生成预填 GitHub issue 链接且不泄露环境信息', () => {
  const url = buildIssueUrl({ ...record('abc'), includeDiagnostics: false }, meta);
  assert.equal(new URL(url).origin, 'https://github.com');
  assert.match(url, /han0han0le0ni\/dsh-daughter\/issues\/new/);
  assert.equal(new URL(url).searchParams.get('title'), '[投诉] 测试标题');
  assert.doesNotMatch(new URL(url).searchParams.get('body') ?? '', /v24\.0\.0/);

  const withDiag = buildIssueUrl({ ...record('def'), includeDiagnostics: true }, meta);
  assert.match(new URL(withDiag).searchParams.get('body') ?? '', /插件版本：0\.8\.0/);
});

test('反馈队列可读可写，坏行跳过且待同步筛选正确', () => {
  const { path, cleanup } = tempQueue();
  try {
    appendFeedbackRecord(path, record('a'));
    appendFeedbackRecord(path, record('b', 'synced'));
    assert.deepEqual(readFeedbackQueue(path).map((item) => item.id), ['a', 'b']);
    assert.deepEqual(pendingFeedback(path).map((item) => item.id), ['a']);
    rewriteFeedbackQueue(path, [record('b', 'synced'), record('c')]);
    assert.deepEqual(readFeedbackQueue(path).map((item) => item.id), ['b', 'c']);
  } finally {
    cleanup();
  }
});

test('无令牌时提交写入本地队列并返回预填链接', async () => {
  const { path, cleanup } = tempQueue();
  try {
    const result = await submitFeedback(
      path,
      { category: '故障', title: '打不开', body: '启动就退出', contact: '', includeDiagnostics: false },
      meta,
      { token: '', now: () => new Date('2026-11-16T00:00:00.000Z') },
    );
    assert.equal(result.status, 'pending');
    assert.match(result.issueUrl, /issues\/new/);
    assert.equal(readFeedbackQueue(path).length, 1);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /DSH_GITHUB_TOKEN|Bearer/);
  } finally {
    cleanup();
  }
});

test('有令牌时同步到 GitHub，且令牌不进入本地记录', async () => {
  const { path, cleanup } = tempQueue();
  let seenAuth = '';
  let seenBody = '';
  const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    seenAuth = init?.headers?.authorization ?? '';
    seenBody = init?.body ?? '';
    return {
      ok: true,
      status: 201,
      json: async () => ({ number: 42, html_url: 'https://github.com/han0han0le0ni/dsh-daughter/issues/42' }),
    };
  }) as unknown as typeof fetch;
  try {
    const result = await submitFeedback(
      path,
      { category: '意见', title: '加个开关', body: '想要设置页里有开关', contact: '', includeDiagnostics: true },
      meta,
      { token: 'super-secret-token', fetchImpl },
    );
    assert.equal(result.status, 'synced');
    assert.equal(result.issueNumber, 42);
    assert.equal(seenAuth, 'Bearer super-secret-token');
    assert.match(seenBody, /加个开关/);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /super-secret-token/);
  } finally {
    cleanup();
  }
});

test('重试只补发待同步条目，成功的不重复发送', async () => {
  const { path, cleanup } = tempQueue();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 201,
      json: async () => ({ number: 100 + calls, html_url: `https://github.com/han0han0le0ni/dsh-daughter/issues/${100 + calls}` }),
    };
  }) as unknown as typeof fetch;
  try {
    rewriteFeedbackQueue(path, [record('done', 'synced'), record('wait')]);
    const result = await retryPendingFeedback(path, meta, { token: 'token', fetchImpl });
    assert.deepEqual(result, { scanned: 1, synced: 1 });
    assert.equal(calls, 1);
    assert.equal(readFeedbackQueue(path).filter((item) => item.status === 'synced').length, 2);
    appendFeedbackRecord(path, record('noop'));
  } finally {
    cleanup();
  }
});

