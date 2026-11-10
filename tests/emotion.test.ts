import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import {
  analyzeSentiment,
  createInitialL5,
  sentimentPolarity,
  sentimentStrength,
  updateL5,
} from '../src/runtime/state.js';
import { relaxL5 } from '../src/runtime/maintenance.js';
import { linkNewEvent } from '../src/runtime/memory.js';
import type { DaughterConfig, EventRecord, L5State } from '../src/types.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-emotion-'));
}

function makeConfig(): DaughterConfig {
  const config = structuredClone(defaultConfig);
  config.random_surprise_enabled = false;
  return config;
}

let seq = 0;

function makeEvent(store: Store, overrides: Partial<EventRecord> = {}): EventRecord {
  seq += 1;
  const base: EventRecord = {
    id: `EVT-20261105-${String(seq).padStart(6, '0')}`,
    characterId: store.characterId,
    workspaceId: 'ws-1',
    createdAt: '2026-11-05T10:00:00.000Z',
    source: 'chat',
    kind: 'dialogue',
    title: '测试事件',
    summary: '测试用事件摘要',
    tags: ['测试'],
    participants: ['self', 'user'],
    place: null,
    emotionAtTime: { pleasure: 0.1, arousal: 0, dominance: 0, intensity: 0.3 },
    emotionNowHistory: [],
    salience: 0.6,
    weight: 0.5,
    importance: 0.5,
    links: [],
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
    ...overrides,
  };
  store.addEvent(base);
  return base;
}

test('§8.3 情绪极性：负面句为负，单字寒暄的强度远低于真实情绪表达', () => {
  assert.ok(sentimentPolarity('今天有点累，压力好大') < 0, '负面句应得负极性');

  // "你好"只是单字命中（权重 0.35），"太好了"是多字命中（权重 1）
  assert.ok(sentimentPolarity('你好') > 0, '单字命中仍算正面');
  assert.ok(sentimentStrength('你好') < sentimentStrength('特别开心'), '单字寒暄的强度应更低');
  assert.ok(sentimentStrength('你好') < 0.25, `寒暄强度应很小，实际 ${sentimentStrength('你好')}`);
});

test('§8.3 情绪极性：口语负面与否定前缀', () => {
  assert.ok(sentimentPolarity('我怕又失败了') < 0, '"失败"应判负，这是真实库里最常见的一句');
  assert.ok(sentimentPolarity('撑不住了') < 0, '"撑不住"应判负');
  assert.ok(sentimentPolarity('今天不开心') < 0, '"不开心"不能被算成开心');
  assert.ok(sentimentPolarity('不太舒服') < 0, '"不舒服"应判负');
  assert.ok(sentimentPolarity('还行，谢谢你') > 0, '正常致谢仍算正面');
});

test('DEF-01 程度分级：「有点烦」与「崩溃」不再都判成 -1', () => {
  const slight = sentimentPolarity('有点烦');
  const intense = sentimentPolarity('崩溃');

  assert.ok(slight < 0 && slight > -0.35, `轻度负面应弱，实际 ${slight}`);
  assert.ok(Math.abs(slight + 0.2) < 0.05, `「有点烦」应约 -0.2，实际 ${slight}`);
  assert.ok(intense < -0.8, `「崩溃」应约 -0.9，实际 ${intense}`);
  assert.ok(intense < slight, '极端词必须比程度轻微的更负');
  assert.ok(sentimentStrength('有点烦') < sentimentStrength('崩溃'), '强度也应拉开');
});

test('DEF-01 程度分级：加强词抬升、单句多命中叠加但仍被 clamp', () => {
  assert.ok(sentimentPolarity('很烦') < sentimentPolarity('烦'), '"很"应加强负面');
  assert.ok(sentimentPolarity('比较开心') > sentimentPolarity('有点开心'), '"比较"应强于"有点"');
  assert.equal(sentimentPolarity('非常非常崩溃'), -1, '叠加后应被 clamp 到 -1');
});

test('DEF-01 反问不误判：「靠不靠谱」不再算满强度负面', () => {
  assert.equal(sentimentPolarity('靠不靠谱'), 0, 'X不X 问的是"是否"，不是否定');
  assert.equal(sentimentPolarity('开不开心'), 0, '反问里的另一个词同样不吃命中');
  assert.ok(sentimentPolarity('不靠谱') < -0.2, '真否定仍要判负');
  assert.ok(sentimentPolarity('他很靠谱') > 0.2, '正常正面命中不受影响');
  assert.equal(analyzeSentiment('靠不靠谱').hits.length, 0, '反问不该留命中词，日志才不会误导');
});

test('DEF-01 PAD 派生：极性由 pleasure 回算，唤醒只看命中总量', () => {
  const positive = analyzeSentiment('特别开心');
  const negative = analyzeSentiment('特别难受');

  assert.equal(positive.polarity, positive.pad.pleasure, '极性应等于派生 pleasure');
  assert.ok(positive.pad.arousal > 0.5, `强情绪应抬高唤醒，实际 ${positive.pad.arousal}`);
  assert.ok(positive.pad.dominance > 0 && negative.pad.dominance < 0, '掌控感应随极性走');
  assert.equal(analyzeSentiment('').polarity, 0, '空白句不产生极性');
  assert.equal(analyzeSentiment('').strength, 0);
  assert.equal(analyzeSentiment('有点烦').degrees['烦'], 0.64, '程度倍数应可离线复算');
});

test('§8.3 情绪推进：连续负面输入让 pleasure 落到负半轴', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const persona = store.loadPersona()!;

  let l5: L5State = createInitialL5('daughter-default', 's-1', '2026-11-05T09:00:00.000Z', persona, 0);
  for (let index = 0; index < 3; index += 1) {
    l5 = updateL5(l5, '今天好累，压力好大，有点难受', '2026-11-05T10:00:00.000Z', persona);
  }
  assert.ok(l5.emotion.pleasure < 0, `pleasure 应变负，实际 ${l5.emotion.pleasure}`);
  assert.ok(l5.stress > 0.2, 'stress 应因压力词上升');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§8.3 情感回落：闲置足够久时 safety/stress 向基线回归', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();

  const l5 = createInitialL5('daughter-default', 's-relax', '2026-11-05T00:00:00.000Z', store.loadPersona()!, 0);
  l5.safety = 1;
  l5.stress = 0;
  l5.fatigue = 0.95;
  l5.lastTickAt = '2026-11-05T00:00:00.000Z';
  store.saveL5(l5);

  const changed = relaxL5(store, config, '2026-11-05T10:00:00.000Z');
  assert.equal(changed, 1, '应回落 1 个会话');

  const after = store.loadL5('s-relax')!;
  assert.ok(after.safety < 1, `safety 应从 1.0 回落，实际 ${after.safety}`);
  assert.ok(after.stress > 0, `stress 应从 0 向基线 0.2 回升，实际 ${after.stress}`);
  assert.ok(after.fatigue < 0.95, `fatigue 应回落，实际 ${after.fatigue}`);
  // lastTickAt 不能被回落本身刷新，否则下一轮 idle 会被自己清零
  assert.equal(after.lastTickAt, '2026-11-05T00:00:00.000Z');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§8.3 情感回落：闲置不足 idle_hours 时不动', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');
  const config = makeConfig();

  const l5 = createInitialL5('daughter-default', 's-fresh', '2026-11-05T09:50:00.000Z', store.loadPersona()!, 0);
  l5.safety = 1;
  l5.lastTickAt = '2026-11-05T09:50:00.000Z';
  store.saveL5(l5);

  assert.equal(relaxL5(store, config, '2026-11-05T10:00:00.000Z'), 0);
  assert.equal(store.loadL5('s-fresh')!.safety, 1);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§8.5 关联图：单条事件出边不超过 12 条', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');

  const target = makeEvent(store, { tags: ['火锅'], participants: ['self', 'user'] });
  const fat = makeEvent(store, { tags: ['火锅'], participants: ['self', 'user'] });
  // 手工把目标灌满出边
  store.updateEventMutable(target.id, {
    links: Array.from({ length: 12 }, (_, index) => ({
      targetId: `EVT-filler-${index}`,
      kind: 'topic' as const,
      strength: 1,
      createdAt: '2026-11-05T09:00:00.000Z',
    })),
  });

  const created = linkNewEvent(store, store.listAllEvents().find((event) => event.id === fat.id)!, 3);
  assert.equal(created, 0, '已满 12 条出边的事件不再建链');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('§5.4 归档摘链：detachLinks 清掉指向已归档事件的引用', () => {
  const root = makeRoot();
  const store = new Store(root, 'daughter-default');

  const a = makeEvent(store, { title: '事件 A' });
  const b = makeEvent(store, { title: '事件 B' });
  store.updateEventMutable(b.id, {
    links: [{ targetId: a.id, kind: 'topic', strength: 1, createdAt: '2026-11-05T09:00:00.000Z' }],
  });

  const touched = store.detachLinks([a.id]);
  assert.equal(touched, 1, '应清理 1 条事件的引用');
  assert.equal(store.listAllEvents().find((event) => event.id === b.id)!.links.length, 0);

  store.close();
  rmSync(root, { recursive: true, force: true });
});
