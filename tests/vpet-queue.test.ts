import test from 'node:test';
import assert from 'node:assert/strict';
import { VpetBridgeState } from '../src/runtime/vpet-events.js';

test('游标读取：ack 前重复读取不丢事件', () => {
  const state = new VpetBridgeState();
  state.push({ kind: 'reply', text: '第一句' });
  state.push({ kind: 'thinking' });

  const first = state.read(0, 1000);
  assert.equal(first.seq, 2);
  assert.deepEqual(first.events.map((event) => event.seq), [1, 2]);
  assert.equal(first.lost, 0);

  const second = state.read(0, 2000);
  assert.deepEqual(second.events.map((event) => event.seq), [1, 2]);

  assert.equal(state.ack(2, 3000), 2);
  assert.equal(state.read(0).events.length, 0);
});

test('ack 只裁剪已确认的事件', () => {
  const state = new VpetBridgeState();
  state.push({ kind: 'reply', text: 'a' });
  state.push({ kind: 'reply', text: 'b' });
  state.push({ kind: 'reply', text: 'c' });

  assert.equal(state.ack(2), 2);
  const rest = state.read(2);
  assert.deepEqual(rest.events.map((event) => event.seq), [3]);
});

test('队列超容量时保留最新事件并报告 lost', () => {
  const state = new VpetBridgeState(3);
  for (let index = 0; index < 10; index += 1) state.push({ kind: 'reply', text: `第 ${index + 1} 条` });

  const result = state.read(0);
  assert.deepEqual(result.events.map((event) => event.seq), [8, 9, 10]);
  assert.equal(result.lost, 7);
  assert.equal(state.status(1000).dropped, 7);

  assert.equal(state.read(10).lost, 0);
});

test('在线状态：MOD 轮询与桥接心跳分别判定', () => {
  const state = new VpetBridgeState();
  assert.equal(state.status(1000).consumer.online, false);
  assert.equal(state.status(1000).bridge.online, false);

  state.read(0, 1000);
  assert.equal(state.status(1500).consumer.online, true);
  assert.equal(state.status(12000).consumer.online, false);

  state.heartbeat({ saveFound: true, name: '桌宠', level: 3, mode: 'Nomal' }, 1000);
  const online = state.status(2000);
  assert.equal(online.bridge.online, true);
  assert.equal(online.bridge.saveFound, true);
  assert.equal(online.bridge.level, 3);
  assert.equal(state.status(130000).bridge.online, false);
});

test('旧版 MOD 的 one-shot 读取仍可用', () => {
  const state = new VpetBridgeState();
  state.push({ kind: 'reply', text: '一次性' });
  state.push({ kind: 'reply', text: '第二次' });

  assert.equal(state.read(undefined, 1000).events.length, 2);
  assert.equal(state.read(undefined, 2000).events.length, 0);
});

test('旧版 /vpet/say 兼容：取走最早一条 reply', () => {
  const state = new VpetBridgeState();
  state.push({ kind: 'thinking' });
  state.push({ kind: 'reply', text: '在的' });
  state.push({ kind: 'reply', text: '后来' });

  assert.equal(state.takeReply(), '在的');
  assert.equal(state.status(1000).pending, 2);
  assert.equal(state.takeReply(), '后来');
  assert.equal(state.takeReply(), undefined);
});

test('MOD 状态上报：能力、忙闲与玩家交互可被 DSH 读取', () => {
  const state = new VpetBridgeState();
  assert.equal(state.consumerInfo(1000), null);
  assert.equal(state.supportedGraphs(1000), null);
  assert.equal(state.playerActive(1000), false);

  const report = state.reportConsumer(
    {
      version: 'dsh-daughter-mod/1.1',
      pollMs: 1000,
      capabilities: { graphs: ['Say', 'Touch_Head', 'Sleep'], actions: ['animate', 'move'], queue: true },
      state: { busy: true, reason: 'player', playerActive: true, queued: 2, dropped: 0, activity: 'Idle' },
    },
    1000,
  );
  assert.ok(report);
  assert.equal(state.supportedGraphs(1500)?.length, 3);
  assert.equal(state.playerActive(1500), true);

  const status = state.status(1500);
  assert.equal(status.consumer.info?.online, true);
  assert.equal(status.consumer.info?.state?.busy, true);
  assert.equal(status.consumer.info?.state?.queued, 2);

  // 超过上报窗口后不再参与动作校验与让行判断
  assert.equal(state.consumerInfo(70_000)?.online, false);
  assert.equal(state.supportedGraphs(70_000), null);
  assert.equal(state.playerActive(70_000), false);
});

test('MOD 状态上报：非法载荷被拒绝', () => {
  const state = new VpetBridgeState();
  assert.equal(state.reportConsumer(null, 1000), null);
  assert.equal(state.reportConsumer({ version: 'x' }, 1000), null);
  assert.equal(state.consumerInfo(1000), null);
});
