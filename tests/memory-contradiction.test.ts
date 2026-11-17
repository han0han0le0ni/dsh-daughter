import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { isContradiction, linkNewEvent } from '../src/runtime/memory.js';
import type { EventRecord } from '../src/types.js';

/** 临时库 + 自动 close/清理：Store 持有文件句柄，不关会 EPERM */
function withStore(run: (store: Store) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'dsh-daughter-conflict-'));
  const store = new Store(root, 'daughter-default');
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function makeEvent(id: string, pleasure: number, tags: string[] = ['生活'], summary = id): EventRecord {
  return {
    id,
    characterId: 'daughter-default',
    title: id,
    summary,
    tags,
    participants: ['self', 'user'],
    emotionAtTime: { pleasure, arousal: 0, dominance: 0, intensity: Math.abs(pleasure) },
    emotionNowHistory: [],
    importance: 0.5,
    weight: 0.5,
    links: [],
    source: 'chat',
    createdAt: '2026-11-01T00:00:00.000Z',
    recallCount: 0,
    archived: false,
    schemaVersion: 1,
  };
}

test('DEF-09 冲突判定：必须极性相反且差值过线', () => {
  assert.equal(isContradiction(makeEvent('A', 0.6), makeEvent('B', -0.6), 0.4), true);
  assert.equal(isContradiction(makeEvent('A', 0.2), makeEvent('B', -0.1), 0.4), false, '差值不够不算冲突');
  assert.equal(isContradiction(makeEvent('A', 0.6), makeEvent('B', 0.7), 0.4), false, '同向不算冲突');
  assert.equal(isContradiction(makeEvent('A', 0), makeEvent('B', -0.6), 0.4), false, '中性不算冲突');
});

test('DEF-09 冲突写入：双方各写一条 contradiction 链接，且不覆盖事实字段', () => {
  withStore((store) => {
    store.addEvent(makeEvent('EVT-LIKE', 0.6, ['食物'], '她说喜欢香菜'));
    store.addEvent(makeEvent('EVT-HATE', -0.6, ['食物'], '她说讨厌香菜'));

    const created = linkNewEvent(store, store.getEvent('EVT-HATE')!, 3, { enabled: true, minGap: 0.4 });
    assert.equal(created, 1);

    const forward = store.getEvent('EVT-HATE')!.links.find((link) => link.targetId === 'EVT-LIKE')!;
    const backward = store.getEvent('EVT-LIKE')!.links.find((link) => link.targetId === 'EVT-HATE')!;
    assert.equal(forward.kind, 'contradiction');
    assert.equal(backward.kind, 'contradiction', '应双向建边');
    assert.ok(forward.strength >= 0.5, `矛盾链接强度不应过低，实际 ${forward.strength}`);

    const kept = store.getEvent('EVT-LIKE')!;
    assert.equal(kept.summary, '她说喜欢香菜', '摘要不能被覆盖');
    assert.deepEqual(kept.tags, ['食物'], '标签不能被覆盖');
    assert.equal(kept.emotionAtTime.pleasure, 0.6, '原始情绪不能被改写');
  });
});

test('DEF-09 冲突写入：同向、差值不足、无共同标签、开关关闭都不建矛盾边', () => {
  const kindOf = (
    event: EventRecord,
    candidate: EventRecord,
    options: { enabled: boolean; minGap: number },
  ): string | undefined =>
    (() => {
      let kind: string | undefined;
      withStore((store) => {
        store.addEvent(candidate);
        store.addEvent(event);
        linkNewEvent(store, event, 3, options);
        kind = store.getEvent(event.id)!.links.find((link) => link.targetId === candidate.id)?.kind;
      });
      return kind;
    })();

  assert.equal(
    kindOf(makeEvent('N1', 0.3, ['食物']), makeEvent('N2', 0.5, ['食物']), { enabled: true, minGap: 0.4 }),
    'topic',
    '同向只做话题链接',
  );
  assert.equal(
    kindOf(makeEvent('N3', -0.15, ['食物']), makeEvent('N4', 0.15, ['食物']), { enabled: true, minGap: 0.4 }),
    'topic',
    '差值不足 0.4 只做话题链接',
  );
  assert.equal(
    kindOf(makeEvent('N5', -0.9, ['食物']), makeEvent('N6', 0.9, ['工作']), { enabled: true, minGap: 0.4 }),
    'person',
    '没有共同标签时只按共同人物建边，不会因为情绪相反就判成矛盾',
  );
  assert.equal(
    kindOf(makeEvent('N7', -0.9, ['食物']), makeEvent('N8', 0.9, ['食物']), { enabled: false, minGap: 0.4 }),
    'topic',
    '开关关闭时退回普通话题链接',
  );
});
