import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildExpressionSinks,
  createFileSink,
  createHttpSink,
  dispatchExpression,
  type ExpressionEvent,
} from '../src/runtime/expression.js';

const NOW = new Date(2026, 10, 6, 14, 0, 0).toISOString();

function makeEvent(overrides: Partial<ExpressionEvent> = {}): ExpressionEvent {
  return {
    kind: 'speak',
    characterId: 'daughter-default',
    at: NOW,
    text: '……在忙吗',
    reason: 'miss',
    intensity: 0.62,
    ...overrides,
  };
}

test('表达投递：单个出口失败不影响其他出口', async () => {
  const received: string[] = [];
  const event = makeEvent();
  const result = await dispatchExpression(event, [
    (item) => {
      received.push(`bubble:${item.text}`);
    },
    () => {
      throw new Error('boom');
    },
    async (item) => {
      received.push(`log:${item.reason}`);
    },
  ]);

  assert.equal(result.delivered, 2);
  assert.equal(result.failed, 1, '一个出口炸了不该连累其他出口');
  assert.deepEqual(result.errors, ['boom']);
  assert.deepEqual(received, [`bubble:${event.text}`, `log:${event.reason}`]);
});

test('表达投递：没配出口时安静返回，不抛错', async () => {
  assert.deepEqual(await dispatchExpression(makeEvent(), []), { delivered: 0, failed: 0, errors: [] });
});

test('表达投递：失败原因最多留 3 条，避免日志爆炸', async () => {
  const sinks = Array.from({ length: 5 }, (_, index) => () => {
    throw new Error(`fail-${index}`);
  });
  const result = await dispatchExpression(makeEvent(), sinks);

  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 5, '失败计数要如实，不能只数被截断的那几条');
  assert.deepEqual(result.errors, ['fail-0', 'fail-1', 'fail-2']);
});

test('表达投递：事件结构原样交给出口，不被加工', async () => {
  const event = makeEvent({ kind: 'speak', intensity: 0.5 });
  let seen: ExpressionEvent | null = null;
  await dispatchExpression(event, [(item) => {
    seen = item;
  }]);
  assert.deepEqual(seen, event);
});

test('文件出口：目录不存在时补建后写入一行 JSON', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-expr-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const filePath = join(root, 'nested', 'expression.jsonl');
  const sink = createFileSink(filePath);
  const first = makeEvent({ text: '第一句' });
  const second = makeEvent({ text: '第二句', reason: 'care' });

  await sink(first);
  await sink(second);

  const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2, '一条表达一行，方便 tail -f');
  assert.deepEqual(JSON.parse(lines[0]!), first);
  assert.deepEqual(JSON.parse(lines[1]!), second);
});

test('HTTP 出口：POST 一份 JSON 给配置的地址', async () => {
  const calls: { url: string; init?: { method?: string; body?: string } }[] = [];
  const sink = createHttpSink('http://127.0.0.1:9999/hook///', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    },
  });

  await sink(makeEvent());

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:9999/hook', '末尾斜杠要收敛，避免拼出双斜杠');
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0]!.init?.body ?? '{}'), makeEvent());
});

test('HTTP 出口：非 2xx 与网络错误都要抛出来，交给上层统计', async () => {
  const failing = createHttpSink('http://127.0.0.1:9999/hook', {
    fetchImpl: async () => ({ ok: false, status: 502, text: async () => 'bad gateway' }),
  });
  await assert.rejects(() => failing(makeEvent()), /502/);

  const broken = createHttpSink('http://127.0.0.1:9999/hook', {
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(() => broken(makeEvent()), /ECONNREFUSED/);
});

test('HTTP 出口：环境没有 fetch 时明确报错，而不是静默丢弃', async () => {
  // 故意抹掉 fetch 模拟老运行时
  const holder = globalThis as { fetch?: unknown };
  const globalFetch = holder.fetch;
  Reflect.deleteProperty(holder, 'fetch');
  try {
    const sink = createHttpSink('http://127.0.0.1:9999/hook');
    await assert.rejects(() => sink(makeEvent()), /没有 fetch/);
  } finally {
    holder.fetch = globalFetch;
  }
});

test('出口组装：vpet 由宿主注入，未知类型与缺字段的条目跳过', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-expr-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const seen: string[] = [];
  const sinks = buildExpressionSinks(
    [
      { type: 'vpet' },
      { type: 'http' } as never,
      { type: 'file' } as never,
      { type: 'bogus' } as never,
      { type: 'file', path: 'out/expression.jsonl' },
    ],
    {
      vpetSink: () => {
        seen.push('vpet');
      },
      resolvePath: (path) => join(root, path),
    },
  );

  assert.equal(sinks.length, 2, '只有配置完整的出口才该进总线');

  const event = makeEvent();
  await dispatchExpression(event, sinks);

  assert.deepEqual(seen, ['vpet']);
  const written = (await readFile(join(root, 'out', 'expression.jsonl'), 'utf8')).trim();
  assert.deepEqual(JSON.parse(written), event, '相对路径要按插件根目录解析');
});

test('出口组装：没注入 vpet 实现时不硬塞一个空出口', () => {
  assert.deepEqual(buildExpressionSinks([{ type: 'vpet' }]), []);
});

test('出口组装：pet 出口用宿主端口拼地址，缺地址就不硬造一个', async () => {
  const recorded: { url: string; body?: string }[] = [];
  const holder = globalThis as { fetch?: unknown };
  const globalFetch = holder.fetch;
  holder.fetch = async (url: string, init?: { body?: string }) => {
    recorded.push({ url: String(url), body: init?.body });
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    const sinks = buildExpressionSinks([{ type: 'pet' }], { petBaseUrl: 'http://127.0.0.1:3456' });
    assert.equal(sinks.length, 1, 'pet 出口该被构造出来');

    await dispatchExpression(makeEvent({ text: '在忙吗' }), sinks);
    assert.equal(recorded.length, 1);
    const url = new URL(recorded[0]!.url);
    assert.equal(url.pathname, '/dsh-pet-7340/broadcast', '地址该落在 dsh-pet 的路由段下');
    assert.equal(url.searchParams.get('pet'), 'main');
    assert.deepEqual(JSON.parse(recorded[0]!.body ?? '{}'), { text: '在忙吗', duration: 10000 });
  } finally {
    holder.fetch = globalFetch;
  }

  // 既没配 url、宿主也没给端口 → 跳过，不造一个永远失败的出口
  assert.deepEqual(buildExpressionSinks([{ type: 'pet' }]), []);
});
