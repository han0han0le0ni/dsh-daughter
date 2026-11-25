import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { L5State } from '../src/types.js';
import { Store } from '../src/store.js';
import { buildStarPanels } from '../src/runtime/panels.js';

const NOW = '2026-11-25T12:00:00.000Z';

function makeL5(): L5State {
  return {
    sessionId: 'affect-ui',
    characterId: 'affect-ui',
    emotion: { pleasure: 0.2, arousal: 0.3, dominance: 0 },
    stress: 0.2,
    safety: 0.7,
    fatigue: 0.15,
    emotionalOverdraft: 0,
    boundary: 0.6,
    activeSubPersonaId: 'to_father',
    lastTickAt: NOW,
    snapshotAt: NOW,
    schemaVersion: 1,
  };
}

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-affect-ui-'));
  const store = new Store(root, 'affect-ui', 42, undefined, { lock: false });
  return { root, store };
}

test('脑星图：L2 展示爱恨共存，L5 展示苦乐参半', () => {
  const { root, store } = makeStore();
  try {
    const persona = store.loadPersona();
    persona.l2.bonds = {
      user: { affection: 0.85, trust: 0.7, hurt: 0.55, resentment: 0.35, longing: 0.2, updatedAt: NOW },
      stranger: { affection: 0.1, trust: 0.2, hurt: 0, resentment: 0, longing: 0, updatedAt: NOW },
    };
    store.savePersonaLayer('l2', persona.l2);
    store.saveL5({
      ...makeL5(),
      emotionMix: { joy: 0.6, sadness: 0.5, anger: 0, fear: 0, disgust: 0, surprise: 0 },
    });

    const panels = buildStarPanels(store, NOW, { nodes: 0, edges: 0, galaxies: 0 });
    const l2 = panels.persona.find((group) => group.id === 'L2');
    const l5 = panels.runtime.find((group) => group.id === 'L5');

    assert.equal(l2?.params.find((item) => item.key === 'bonds.user.affection')?.value, 0.85);
    assert.equal(l2?.params.find((item) => item.key === 'bonds.user.resentment')?.value, 0.35);
    assert.match(String(l2?.params.find((item) => item.key === 'bonds.user.coexistence')?.value), /爱恨共存/);
    assert.ok(l2?.params.some((item) => item.key === 'bonds.stranger.affection'));

    assert.equal(l5?.params.find((item) => item.key === 'emotionMix.joy')?.value, 0.6);
    assert.equal(l5?.params.find((item) => item.key === 'emotionMix.sadness')?.value, 0.5);
    assert.match(String(l5?.params.find((item) => item.key === 'emotionMix.coexistence')?.value), /苦乐参半/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('脑星图兼容旧存档：自动推导主人情感与心情，不虚构陌生人关系', () => {
  const { root, store } = makeStore();
  try {
    store.saveL5(makeL5());
    const panels = buildStarPanels(store, NOW, { nodes: 0, edges: 0, galaxies: 0 });
    const l2 = panels.persona.find((group) => group.id === 'L2');
    const l5 = panels.runtime.find((group) => group.id === 'L5');

    assert.ok(l2?.params.some((item) => item.key === 'bonds.user.affection'));
    assert.equal(l2?.params.some((item) => item.key === 'bonds.stranger.affection'), false);
    assert.equal(l2?.params.some((item) => item.key === 'bonds.user.coexistence'), false);

    assert.ok(l5?.params.some((item) => item.key === 'emotionMix.joy'));
    assert.equal(l5?.params.some((item) => item.key === 'emotionMix.coexistence'), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
