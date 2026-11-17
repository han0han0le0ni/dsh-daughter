import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.js';
import type { Logger } from '../src/util.js';

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type Listener = (...args: any[]) => unknown;

function makeHostContext() {
  const listeners = new Map<string, Listener[]>();
  const cleanups: Array<() => void> = [];
  const ctx = {
    logger: silent,
    get: () => undefined,
    on(name: string, listener: Listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(fn: () => (() => void) | void) {
      const dispose = fn();
      if (dispose) cleanups.push(dispose);
      return () => undefined;
    },
    emit: () => undefined,
  };
  return { ctx, listeners, cleanups };
}

let dataDir = '';
let stop: (() => void) | undefined;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'dsh-daughter-host-'));
});

after(() => {
  stop?.();
  rmSync(dataDir, { recursive: true, force: true });
});

test('host adapter 注入提示块并落盘回复事件', async () => {
  const host = makeHostContext();
  const plugin = createHost(host.ctx as any, { storage: { data_root: dataDir } }, dataDir);
  stop = () => host.cleanups.forEach((fn) => fn());

  const session = { id: 'session-a', header: { cwd: 'e:\\workspace-a' } };
  const userMessage = {
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text: '今天有点累，想和你说说话' }],
    source: { kind: 'user' },
  };

  const preStep = host.listeners.get('agent/pre-step')?.[0];
  assert.ok(preStep);

  const decision = (await preStep!(
    { agent: { session }, messages: [userMessage], turn: 1 },
    async () => ({ kind: 'enter', messages: [userMessage] }),
  )) as { messages: Array<{ source?: { kind?: string }; content?: Array<{ text?: string }> }> };

  assert.equal(decision.messages.length, 2);
  const injected = decision.messages[1];
  assert.equal(injected?.source?.kind, 'dsh-daughter');
  const text = injected?.content?.[0]?.text ?? '';
  assert.ok(text.includes('你是一个有稳定底色的存在'));

  const sessionEvent = host.listeners.get('session/event')?.[0];
  assert.ok(sessionEvent);
  await sessionEvent!(session, {
    type: 'assistant/message',
    data: {
      turn: 1,
      message: {
        role: 'assistant',
        source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'text', text: '嗯，我在。' }],
      },
    },
  });

  const hits = await plugin.retrieve({
    characterId: 'daughter-default',
    query: '累',
    now: new Date().toISOString(),
    topK: 5,
    currentEmotion: { pleasure: 0, arousal: 0, dominance: 0 },
    excludeArchived: false,
  });
  assert.ok(hits.length >= 1);

  // 默认配置下反射命中不短路：照常进入模型，聊天记录不丢
  const hello = {
    id: 'm2',
    role: 'user',
    content: [{ type: 'text', text: '你好' }],
    source: { kind: 'user' },
  };
  const continued = (await preStep!(
    { agent: { session: { id: 'session-b', header: { cwd: 'e:\\workspace-b' } } }, messages: [hello], turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [hello] }),
  )) as { messages: unknown[] };
  assert.equal(continued.messages.length, 2);

  // short_circuit 打开时才短路（G4），命中后不调用 next()
  const shortDir = mkdtempSync(join(tmpdir(), 'dsh-daughter-host-sc-'));
  const shortHostCtx = makeHostContext();
  const shortHost = createHost(
    shortHostCtx.ctx as any,
    { storage: { data_root: shortDir }, reflex: { short_circuit: true } },
    shortDir,
  );
  try {
    const shortPreStep = shortHostCtx.listeners.get('agent/pre-step')?.[0];
    assert.ok(shortPreStep);
    const rejection = await shortPreStep!(
      { agent: { session: { id: 'session-c', header: { cwd: 'e:\\workspace-c' } } }, messages: [hello], turn: 1, step: 1 },
      async () => {
        throw new Error('反射短路时不应调用 next()');
      },
    );
    assert.deepEqual(rejection, { kind: 'reject' });
  } finally {
    shortHostCtx.cleanups.forEach((fn) => fn());
    rmSync(shortDir, { recursive: true, force: true });
  }
});
