import test from 'node:test';
import assert from 'node:assert/strict';
import { createVpetControlTool } from '../src/runtime/vpet-control.js';

function fakeFetch(calls: Array<{ url: string; body?: string }>) {
  return async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => (url.endsWith('/vpet/status') ? JSON.stringify(VpetStatusFixture) : '{"ok":true}'),
    };
  };
}

const VpetStatusFixture = {
  latestSeq: 7,
  pending: 0,
  dropped: 0,
  consumer: { online: true, staleMs: 800 },
  bridge: { online: true, saveFound: true, name: '大肥鱼', level: 1183, mode: 'Happy' },
};

test('vpet_control animate 下发 graph/loops/text', async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const tool = createVpetControlTool({ fetchImpl: fakeFetch(calls) });

  const value = await tool.execute({ action: 'animate', graph: 'Touch_Head', loops: 2, text: '摸摸头' }, {});
  assert.match(value.text, /Touch_Head/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:47612/vpet/control');
  assert.deepEqual(JSON.parse(calls[0]!.body!), {
    action: 'animate',
    graph: 'Touch_Head',
    loops: 2,
    text: '摸摸头',
  });
});

test('vpet_control move 拒绝零位移', async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const tool = createVpetControlTool({ fetchImpl: fakeFetch(calls) });

  await assert.rejects(
    () => tool.execute({ action: 'move', dx: 0, dy: 0 }, {}),
    /dx 或 dy/,
  );
  assert.equal(calls.length, 0);
});

test('vpet_control status 汇总在线状态', async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const tool = createVpetControlTool({ fetchImpl: fakeFetch(calls) });

  const value = await tool.execute({ action: 'status' }, {});
  assert.match(value.text, /在线/);
  assert.match(value.text, /大肥鱼/);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:47612/vpet/status');
});
