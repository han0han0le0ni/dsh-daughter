import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfig, mergeConfig } from '../src/config.js';
import {
  allowSend,
  buildProactiveMessage,
  emptyLedger,
  readLedger,
  recordSend,
  serializeLedger,
} from '../src/runtime/outbound-conversation.js';
import type { SpeakConversationConfig, SpeakPlan } from '../src/types.js';

const config: SpeakConversationConfig = {
  enabled: true,
  session_id: '',
  prompt: '',
  max_per_day: 2,
  min_gap_min: 120,
  dry_run: false,
};

const plan: SpeakPlan = {
  decision: 'act',
  reason: 'miss',
  text: '我刚才在发呆',
  urge: 0.62,
  threshold: 0.52,
};

test('账本：坏数据按空账本处理，跨天只重置计数', () => {
  assert.deepEqual(readLedger(null, '2026-11-25'), emptyLedger('2026-11-25'));
  assert.deepEqual(readLedger('{not json', '2026-11-25'), emptyLedger('2026-11-25'));

  const raw = serializeLedger({ day: '2026-11-24', count: 3, lastAt: '2026-11-24T23:00:00.000Z' });
  const crossed = readLedger(raw, '2026-11-25');
  assert.equal(crossed.count, 0, '跨天计数归零');
  assert.equal(crossed.lastAt, '2026-11-24T23:00:00.000Z', 'lastAt 保留，跨零点仍受间隔约束');
});

test('限额：日上限与最小间隔各自拦得住', () => {
  const now = '2026-11-25T12:00:00.000Z';
  assert.equal(allowSend({ day: '2026-11-25', count: 0, lastAt: null }, config, now).ok, true);

  const capped = allowSend({ day: '2026-11-25', count: 2, lastAt: null }, config, now);
  assert.deepEqual(capped, { ok: false, reason: 'cap' });

  const gapped = allowSend({ day: '2026-11-25', count: 1, lastAt: '2026-11-25T11:30:00.000Z' }, config, now);
  assert.deepEqual(gapped, { ok: false, reason: 'gap' });

  const passed = allowSend({ day: '2026-11-25', count: 1, lastAt: '2026-11-25T09:00:00.000Z' }, config, now);
  assert.equal(passed.ok, true);
});

test('记账：同日累加，跨天从 1 重新开始', () => {
  const first = recordSend(emptyLedger('2026-11-25'), '2026-11-25', '2026-11-25T10:00:00.000Z');
  assert.equal(first.count, 1);
  const second = recordSend(first, '2026-11-25', '2026-11-25T13:00:00.000Z');
  assert.equal(second.count, 2);
  const nextDay = recordSend(second, '2026-11-26', '2026-11-26T09:00:00.000Z');
  assert.equal(nextDay.count, 1);
  assert.equal(nextDay.lastAt, '2026-11-26T09:00:00.000Z');
});

test('文案：默认框架不被模板句冒充成用户原话', () => {
  const message = buildProactiveMessage(plan, config);
  assert.equal(message.summary, '主动开口');
  assert.match(message.text, /\[DSH-DAUGHTER PROACTIVE\]/);
  assert.match(message.text, /动机 miss/);
  assert.match(message.text, /不要解释这条提示/);
  assert.match(message.text, /仅供参考/, '模板句只作为参考值出现');
});

test('文案：自定义 prompt 替换指令句但保留框架', () => {
  const message = buildProactiveMessage(plan, { prompt: '用简短的一句方言跟她打招呼。' });
  assert.match(message.text, /用简短的一句方言跟她打招呼。/);
  assert.doesNotMatch(message.text, /自然地找主人搭话/);
  assert.match(message.text, /\[DSH-DAUGHTER PROACTIVE\]/);
});

test('配置：会话投递的限额与字段会被归一化', () => {
  const normalized = mergeConfig(defaultConfig, {
    speak: {
      conversation: {
        enabled: true,
        session_id: '  sess-1  ',
        prompt: '  随便说点什么  ',
        max_per_day: 99,
        min_gap_min: 1,
        dry_run: true,
      },
    },
  });
  const conversation = normalized.speak.conversation;
  assert.equal(conversation.enabled, true);
  assert.equal(conversation.session_id, 'sess-1');
  assert.equal(conversation.prompt, '随便说点什么');
  assert.equal(conversation.max_per_day, 24, '日上限封顶 24');
  assert.equal(conversation.min_gap_min, 5, '间隔不得低于 5 分钟');
  assert.equal(conversation.dry_run, true);

  const fallback = mergeConfig(defaultConfig, { speak: { conversation: undefined as never } });
  assert.equal(fallback.speak.conversation.enabled, false, '缺省时回退到关闭');
});
