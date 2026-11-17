import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { linkNewEvent } from '../src/runtime/memory.js';
import { buildStarMap } from '../src/runtime/maintenance.js';
import type { EventRecord } from '../src/types.js';

/** 临时库 + 自动 close/清理：Store 持有文件句柄，不关会 EPERM */
function withStore(run: (store: Store) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'dsh-daughter-starmap-'));
  const store = new Store(root, 'daughter-default');
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function makeEvent(
  id: string,
  pleasure: number,
  tags: string[] = ['食物'],
  createdAt = '2026-11-01T00:00:00.000Z',
): EventRecord {
  return {
    id,
    characterId: 'daughter-default',
    title: id,
    summary: `${id} 的原话`,
    tags,
    participants: ['self', 'user'],
    emotionAtTime: { pleasure, arousal: 0, dominance: 0, intensity: Math.abs(pleasure) },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: 'chat',
    createdAt,
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

/** 生成星图后读回写入的 JSON，断言的是前端真正拿到的数据 */
function readStarMap(store: Store, now: string): any {
  buildStarMap(store, now);
  return JSON.parse(readFileSync(join(store.paths.starMap, 'daughter-default.json'), 'utf8'));
}

test('DEF-09 星图详情：矛盾双方互相带上对方的说法与当时感受', () => {
  withStore((store) => {
    store.addEvent(makeEvent('EVT-LIKE', 0.6));
    store.addEvent(makeEvent('EVT-HATE', -0.6));
    linkNewEvent(store, store.getEvent('EVT-HATE')!, 3, { enabled: true, minGap: 0.4 });

    const map = readStarMap(store, '2026-11-10T00:00:00.000Z');
    const byId = new Map(map.nodes.map((node: any) => [node.id, node]));

    const like = (byId.get('EVT-LIKE') as any).meta.contradictions;
    const hate = (byId.get('EVT-HATE') as any).meta.contradictions;
    assert.equal(like.length, 1, '喜欢的一方应带一条对立说法');
    assert.equal(like[0].id, 'EVT-HATE');
    assert.equal(like[0].label, 'EVT-HATE', '并列要显示对面标题');
    assert.equal(like[0].pleasure, -0.6, '并列要带对面当时的愉悦值');
    assert.equal(hate[0].id, 'EVT-LIKE', '另一边同样指回来');
    assert.equal(hate[0].pleasure, 0.6);
    assert.ok(like[0].createdAt && like[0].emotion, '时间与感受标签缺一不可');
  });
});

test('DEF-09 星图详情：没有冲突边的事件不带 contradictions 字段', () => {
  withStore((store) => {
    store.addEvent(makeEvent('EVT-ALONE', 0.2, ['独处']));

    const map = readStarMap(store, '2026-11-10T00:00:00.000Z');
    const node = map.nodes.find((item: any) => item.id === 'EVT-ALONE') as any;
    assert.equal(node.meta.contradictions, undefined, '普通事件不该多出一个空数组');
  });
});

test('DEF-09 星图详情：冲突说法最多并列 5 条，避免刷屏', () => {
  withStore((store) => {
    store.addEvent(makeEvent('EVT-BASE', -0.9));
    for (let index = 0; index < 7; index += 1) {
      store.addEvent(makeEvent(`EVT-OK-${index}`, 0.9, ['食物']));
      linkNewEvent(store, store.getEvent(`EVT-OK-${index}`)!, 3, { enabled: true, minGap: 0.4 });
    }

    const map = readStarMap(store, '2026-11-10T00:00:00.000Z');
    const base = map.nodes.find((item: any) => item.id === 'EVT-BASE') as any;
    assert.equal(base.meta.contradictions.length, 5);
  });
});
