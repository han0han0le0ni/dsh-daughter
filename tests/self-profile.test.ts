import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelfProfileTool, registerSelfProfileTool, renderSelfProfile } from '../src/runtime/self-profile.js';
import type { PersonalitySnapshot, PortraitBundle } from '../src/types.js';

function snapshot(overrides: Partial<PersonalitySnapshot> = {}): PersonalitySnapshot {
  return {
    bigFive: {
      openness: 0.62,
      conscientiousness: 0.55,
      extraversion: 0.35,
      agreeableness: 0.65,
      neuroticism: 0.4,
    },
    innate: {
      openness: 0.6,
      conscientiousness: 0.55,
      extraversion: 0.35,
      agreeableness: 0.65,
      neuroticism: 0.4,
    },
    temperament: 'slow_warmup',
    attachment: { anxiety: 0.28, avoidance: 0.3 },
    narrative: { worldSafe: 0.6, othersReliable: 0.5, selfWorth: 0.6 },
    stage: 'acquaintance',
    evolving: true,
    locked: ['openness', 'attachment'],
    seed: 123,
    updatedAt: '2026-11-27T10:00:00.000Z',
    ...overrides,
  };
}

function bundle(overrides: Partial<PortraitBundle> = {}): PortraitBundle {
  return {
    self: {
      name: '小满',
      selfRef: '我',
      userRef: '主人',
      background: '旧书店门口捡回来的',
      voice: '句子短，少用感叹号',
      taboos: ['工作'],
      temperament: 'slow_warmup',
      attachment: { anxiety: 0.28, avoidance: 0.3 },
      narrative: { worldSafe: 0.6, othersReliable: 0.5, selfWorth: 0.6 },
      stage: 'acquaintance',
      intimacy: 0.2,
    },
    user: {
      name: 'user',
      eventCount: 12,
      intimacy: 0.2,
      relationship: '初识',
      trend: '稳定',
      firstMet: '2026-11-01T10:00:00.000Z',
      lastAt: '2026-11-27T10:00:00.000Z',
    },
    others: [],
    things: { likes: [], dislikes: [] },
    ...overrides,
  };
}

test('自读文本包含身份、五维、依恋、锁定与关系', () => {
  const text = renderSelfProfile(snapshot(), bundle());
  assert.match(text, /名字：小满；自称：我；称呼对方：主人/);
  assert.match(text, /【五维】开放性 0\.62、尽责性 0\.55/);
  assert.match(text, /【依恋】焦虑 0\.28、回避 0\.30/);
  assert.match(text, /被锁定的维度：开放性、依恋/);
  assert.match(text, /【重抽种子】123/);
  assert.match(text, /和主人的关系】初识，亲密度 20%/);
});

test('没填的字段直接省略，不编造身份与喜恶', () => {
  const empty = bundle();
  empty.self = {
    ...empty.self,
    name: '',
    selfRef: '',
    userRef: '',
    background: '',
    voice: '',
    taboos: [],
  };
  const text = renderSelfProfile(snapshot({ seed: null }), empty);
  assert.doesNotMatch(text, /【身份】/);
  assert.doesNotMatch(text, /【背景】/);
  assert.doesNotMatch(text, /【喜欢】/);
  assert.doesNotMatch(text, /重抽种子/);
  assert.match(text, /【五维】/, '数值部分仍可读');
});

test('工具每次调用都重新读取，不会缓存旧设定', async () => {
  let name = '小满';
  const tool = createSelfProfileTool({
    readPersonality: () => snapshot(),
    readPortraits: () => {
      const data = bundle();
      data.self = { ...data.self, name };
      return data;
    },
  });
  const first = await tool.execute({}, null);
  assert.match(first.text, /名字：小满/);
  name = '阿沅';
  const second = await tool.execute({}, null);
  assert.match(second.text, /名字：阿沅/);
  assert.notEqual(first.text, second.text);
});

test('注册：有 tools 服务时注册 daughter_self，卸载时调用 dispose', () => {
  let captured: { name: string } | null = null;
  let disposed = false;
  const dispose = registerSelfProfileTool(
    {
      get(name: string) {
        if (name !== 'tools') return undefined;
        return {
          register(definition: { name: string }) {
            captured = definition;
            return () => { disposed = true; };
          },
        };
      },
    },
    {
      readPersonality: () => snapshot(),
      readPortraits: () => bundle(),
    },
  );
  assert.equal(captured?.name, 'daughter_self');
  dispose();
  assert.equal(disposed, true);

  // 没有 tools 服务时安静返回，不影响宿主启动
  const noop = registerSelfProfileTool({ get: () => undefined }, {
    readPersonality: () => snapshot(),
    readPortraits: () => bundle(),
  });
  assert.equal(typeof noop, 'function');
  noop();
});
