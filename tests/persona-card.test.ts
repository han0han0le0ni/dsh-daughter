import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  EMPTY_PERSONA_CARD,
  isEmptyPersonaCard,
  loadPersonaCard,
  normalizePersonaCard,
  personaCardPath,
  renderPersonaCard,
  savePersonaCard,
} from '../src/runtime/persona-card.js';

test('空卡不产生任何注入文本', () => {
  assert.equal(renderPersonaCard({ ...EMPTY_PERSONA_CARD }), '');
  assert.equal(isEmptyPersonaCard(normalizePersonaCard(null)), true);
});

test('只填部分字段时只渲染填过的部分', () => {
  const text = renderPersonaCard(normalizePersonaCard({ name: '小满', voice: '句子很短' }));
  assert.match(text, /名字：小满/);
  assert.match(text, /【说话风格】句子很短/);
  assert.doesNotMatch(text, /【背景】/);
  assert.doesNotMatch(text, /【绝不主动提起】/);
});

test('身份、背景、风格、禁忌按固定顺序出现，禁忌用顿号连接', () => {
  const text = renderPersonaCard(normalizePersonaCard({
    name: '小满',
    self_ref: '我',
    user_ref: '主人',
    background: '旧书店门口捡回来的',
    voice: '短句',
    taboos: ['工作', '体检'],
  }));
  const order = ['【身份】', '【背景】', '【说话风格】', '【绝不主动提起】'].map((mark) => text.indexOf(mark));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(text, /绝不主动提起】工作、体检。/);
  assert.match(text, /优先于下面由经历推演出的性格/);
});

test('超长与超量输入被裁剪，字符串禁忌按分隔符拆开并去重', () => {
  const card = normalizePersonaCard({
    name: '名'.repeat(40),
    background: '背'.repeat(500),
    taboos: '工作，体检、工作；前任\n房贷, 甲, 乙, 丙, 丁, 戊, 己',
  });
  assert.equal(card.name.length, 24);
  assert.equal(card.background.length, 160);
  assert.deepEqual(card.taboos, ['工作', '体检', '前任', '房贷', '甲', '乙']);
});

test('保存后可原样读回，坏文件回退成空卡', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-persona-'));
  try {
    const saved = savePersonaCard(dir, { name: '小满', taboos: ['打雷', '打雷'] });
    assert.deepEqual(loadPersonaCard(dir), saved);
    writeFileSync(personaCardPath(dir), '{坏 json', 'utf8');
    assert.deepEqual(loadPersonaCard(dir), EMPTY_PERSONA_CARD);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未写过角色卡时返回空卡，不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-persona-empty-'));
  try {
    assert.deepEqual(loadPersonaCard(dir), EMPTY_PERSONA_CARD);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
