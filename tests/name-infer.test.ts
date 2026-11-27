import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { adoptNameFromMemory, inferNameFromEvents } from '../src/runtime/name-infer.js';
import { EMPTY_PERSONA_CARD, loadPersonaCard } from '../src/runtime/persona-card.js';

const at = '2026-11-06T14:00:00.000Z';

function event(title: string, summary = ''): { title: string; summary: string; createdAt: string } {
  return { title, summary, createdAt: at };
}

test('从旧记忆里认出名字：同一候选至少出现两次才认', () => {
  const name = inferNameFromEvents([
    event('刷抖音刷到一条视频：她给我起了名字：玲依渡。'),
    event('你好呀，玲依渡', '→ 在。名字被你叫得挺顺口的。'),
    event('你叫什么名字呀', '→ 玲依渡。 你起的，我记着呢。'),
  ]);
  assert.equal(name, '玲依渡');
});

test('问句不被当成名字，只出现一次也不认', () => {
  assert.equal(inferNameFromEvents([
    event('你叫什么名字呀', '→ 玲依渡。'),
  ]), '');
  assert.equal(inferNameFromEvents([
    event('你叫什么名字呀', '→ 什么名字呀。'),
    event('我叫什么来着', '→ 我叫什么。'),
  ]), '');
});

test('多个候选时取出现次数最多的，平票取最近的', () => {
  const name = inferNameFromEvents([
    event('她给我起了名字：小满。'),
    event('她给我起了名字：小满。'),
    event('她给我起了名字：阿沅。'),
    event('她给我起了名字：阿沅。'),
    { title: '她给我起了名字：阿沅。', summary: '', createdAt: '2026-11-20T14:00:00.000Z' },
  ]);
  assert.equal(name, '阿沅');
});

test('补名字：空卡才写盘，已有名字不会被覆盖', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-name-'));
  try {
    const first = adoptNameFromMemory(root, [
      event('她给我起了名字：玲依渡。'),
      event('你叫什么名字呀', '→ 玲依渡。'),
    ]);
    assert.equal(first.name, '玲依渡');
    assert.equal(loadPersonaCard(root).name, '玲依渡');

    const second = adoptNameFromMemory(root, [event('她给我起了名字：别的人。')]);
    assert.equal(second.name, '玲依渡', '手写或已补到的名字优先，不被记忆覆盖');
    assert.deepEqual(loadPersonaCard(root).taboos, EMPTY_PERSONA_CARD.taboos);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
