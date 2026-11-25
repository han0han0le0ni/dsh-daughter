import assert from 'node:assert/strict';
import test from 'node:test';
import type { BondEmotion, L2Relationship, L5State } from '../src/types.js';
import { analyzeSentiment } from '../src/runtime/state.js';
import {
  bondForAudience,
  bondFromL2,
  buildAffectHint,
  mixFromPad,
  relaxEmotionMix,
  updateBondEmotion,
  updateEmotionMix,
} from '../src/runtime/affect.js';

const NOW = '2026-11-25T12:00:00.000Z';

function makeL2(): L2Relationship {
  return {
    attachmentAnxiety: 0.35,
    attachmentAvoidance: 0.4,
    coreNeeds: [],
    trustBaseline: 0.3,
    relationshipStage: 'acquaintance',
    relationshipDepth: 0.2,
    updatedAt: NOW,
  };
}

function makeBond(overrides: Partial<BondEmotion> = {}): BondEmotion {
  return { affection: 0.85, trust: 0.7, hurt: 0, resentment: 0, longing: 0, updatedAt: NOW, ...overrides };
}

function makeL5(mix = mixFromPad({ pleasure: 0, arousal: 0, dominance: 0 })): L5State {
  return {
    sessionId: 's1',
    characterId: 'daughter-default',
    emotion: { pleasure: 0, arousal: 0, dominance: 0 },
    emotionMix: mix,
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

test('心情向量：先说开心再说难过，两种成分不会互相抵消', () => {
  const first = updateEmotionMix(
    mixFromPad({ pleasure: 0, arousal: 0, dominance: 0 }),
    analyzeSentiment('今天终于成功了，我很开心'),
    true,
  );
  const second = updateEmotionMix(first, analyzeSentiment('可是想到他我还是很难过'), false);

  assert.ok(second.joy > 0.2, `喜悦 ${second.joy}`);
  assert.ok(second.sadness > 0.18, `悲伤 ${second.sadness}`);
});

test('对人情感：争吵留下怨意但不抹掉亲近，示好也不把旧伤清零', () => {
  const hurt = updateBondEmotion(makeBond(), analyzeSentiment('我讨厌你，真的很生气'), NOW);
  assert.ok(hurt.affection > 0.8);
  assert.ok(hurt.resentment > 0.05);
  assert.ok(hurt.hurt > 0.05);

  const repaired = updateBondEmotion(hurt, analyzeSentiment('谢谢你，我还是很喜欢你'), NOW);
  assert.ok(repaired.affection > hurt.affection);
  assert.ok(repaired.resentment > 0, '怨意仍应保留');
  assert.ok(repaired.hurt > 0, '旧伤不应被一句示好清零');
});

test('语气提示：爱恨共存与苦乐参半都被明确写出', () => {
  const text = buildAffectHint(
    makeL5({ joy: 0.6, sadness: 0.5, anger: 0, fear: 0, disgust: 0, surprise: 0 }),
    makeBond({ hurt: 0.55, resentment: 0.35 }),
  );

  assert.match(text, /喜悦 0\.60/);
  assert.match(text, /悲伤 0\.50/);
  assert.match(text, /亲近与不满可以同时成立/);
  assert.match(text, /带一点刺/);
  assert.match(text, /欣慰里带一点难过/);
});

test('无有效情绪词时对人情感保持原对象，避免无意义写盘', () => {
  const bond = makeBond();
  assert.equal(updateBondEmotion(bond, analyzeSentiment('今天天气怎么样'), NOW), bond);
});

test('闲置回落按成分独立进行，不归一化也不清掉混合状态', () => {
  const previous = { joy: 0.8, sadness: 0.6, anger: 0, fear: 0, disgust: 0, surprise: 0 };
  const next = relaxEmotionMix(previous, mixFromPad({ pleasure: 0, arousal: 0, dominance: 0 }), 0.5);

  assert.equal(next.joy, 0.4);
  assert.equal(next.sadness, 0.3);
});

test('旧存档与对话对象兼容：缺失向量从 L2 推导，独处不注入对人情感', () => {
  const l2 = makeL2();
  const derived = bondForAudience(l2, 'to_father', NOW);
  assert.ok(derived);
  assert.equal(derived.affection, bondFromL2(l2, NOW).affection);
  assert.equal(bondForAudience(l2, 'alone', NOW), undefined);

  const stranger = makeBond({ affection: 0.1 });
  l2.bonds = { stranger };
  assert.equal(bondForAudience(l2, 'to_stranger', NOW), stranger);
  assert.equal(buildAffectHint(makeL5()), '');
});
