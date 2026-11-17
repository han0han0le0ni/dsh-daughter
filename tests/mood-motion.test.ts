import test from 'node:test';
import assert from 'node:assert/strict';
import { MoodMotionGate, selectMoodMotion } from '../src/runtime/mood-motion.js';

function makeL5(pleasure: number, arousal: number, stress = 0.2, fatigue = 0.2) {
  return { emotion: { pleasure, arousal, dominance: 0 }, stress, fatigue };
}

test('情绪动作：高压/高疲劳优先进入 tired', () => {
  assert.equal(selectMoodMotion(makeL5(0.6, 0.4, 0.8))?.graph, 'Sleep');
  assert.equal(selectMoodMotion(makeL5(0.6, 0.4, 0.2, 0.75))?.graph, 'Sleep');
});

test('情绪动作：高愉悦高唤醒进入 joy', () => {
  assert.equal(selectMoodMotion(makeL5(0.5, 0.3))?.graph, 'Touch_Head');
});

test('情绪动作：低愉悦进入 low，平静返回 null', () => {
  assert.equal(selectMoodMotion(makeL5(-0.4, 0))?.graph, 'Say');
  assert.equal(selectMoodMotion(makeL5(0.1, -0.1)), null);
});

test('情绪动作节流：最小间隔与同带重复间隔生效', () => {
  const gate = new MoodMotionGate({ minIntervalMs: 20_000, repeatIntervalMs: 120_000 });

  assert.equal(gate.next(makeL5(0.5, 0.3), 100_000)?.band, 'joy');
  assert.equal(gate.next(makeL5(0.5, 0.3), 110_000), null);
  assert.equal(gate.next(makeL5(0.5, 0.3), 200_000), null);
  assert.equal(gate.next(makeL5(0.5, 0.3), 230_000)?.band, 'joy');
});
