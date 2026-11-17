import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PET_ID,
  PET_MOOD_ANIM,
  PET_WORK_ANIM,
  PET_ROUTE_SEGMENT,
  createPetAnimSink,
  createPetSink,
  petBaseUrlOf,
  petEndpointUrl,
  petIdOf,
  petRouteOf,
  petWorkAnimFor,
  probePet,
} from '../src/runtime/pet-link.js';

interface Recorded {
  url: string;
  method?: string;
  body?: string;
}

function makeFetch(recorded: Recorded[], response: { ok: boolean; status: number } = { ok: true, status: 200 }) {
  return async (url: string, init?: { method?: string; body?: string }) => {
    recorded.push({ url, method: init?.method, body: init?.body });
    return { ...response, text: async () => '' };
  };
}

test('桌宠出口：地址按 dsh-pet 的路由段拼，不去猜端口', () => {
  assert.equal(PET_ROUTE_SEGMENT, '/dsh-pet-7340');

  const url = new URL(
    petEndpointUrl({ baseUrl: 'http://127.0.0.1:3456/' }, 'broadcast', { pet: 'main' }),
  );
  assert.equal(url.origin + url.pathname, `http://127.0.0.1:3456${PET_ROUTE_SEGMENT}/broadcast`);
  assert.equal(url.searchParams.get('pet'), 'main');

  // 路由段可覆盖（dsh-pet 升级改段时的后门）
  const custom = new URL(petEndpointUrl({ baseUrl: 'http://127.0.0.1:3456', route: '/pet' }, 'anim'));
  assert.equal(custom.pathname, '/pet/anim');
});

test('桌宠出口：宠物 id 与路由段都归一化，不往 pets[""] 里写', () => {
  assert.equal(petIdOf(undefined), DEFAULT_PET_ID);
  assert.equal(petIdOf('   '), DEFAULT_PET_ID);
  assert.equal(petIdOf(' main '), 'main');
  assert.equal(petRouteOf(''), PET_ROUTE_SEGMENT);
  assert.equal(petRouteOf('dsh-pet-7340'), PET_ROUTE_SEGMENT);
  assert.equal(petRouteOf('/pet///'), '/pet');
});

test('桌宠出口：端口只有合法值才拼得出基地址', () => {
  assert.equal(petBaseUrlOf(3456), 'http://127.0.0.1:3456');
  assert.equal(petBaseUrlOf('3456'), 'http://127.0.0.1:3456');
  assert.equal(petBaseUrlOf(0), null, '0 表示系统分配，此刻还不知道真端口');
  assert.equal(petBaseUrlOf(undefined), null);
  assert.equal(petBaseUrlOf(70000), null);
});

test('桌宠出口：说话走 /broadcast，只提交文本与停留时长', async () => {
  const recorded: Recorded[] = [];
  const sink = createPetSink({
    baseUrl: 'http://127.0.0.1:3456',
    petId: 'main',
    durationMs: 8000,
    fetchImpl: makeFetch(recorded),
  });

  await sink({ text: '  好久没听到你说话了  ' });

  assert.equal(recorded.length, 1);
  const url = new URL(recorded[0]!.url);
  assert.equal(url.pathname, `${PET_ROUTE_SEGMENT}/broadcast`);
  assert.equal(url.searchParams.get('pet'), 'main');
  assert.equal(recorded[0]!.method, 'POST');
  assert.deepEqual(JSON.parse(recorded[0]!.body ?? '{}'), { text: '好久没听到你说话了', duration: 8000 });
});

test('桌宠出口：没有文本就不发请求（/broadcast 对空 text 只会回 400）', async () => {
  const recorded: Recorded[] = [];
  const sink = createPetSink({ baseUrl: 'http://127.0.0.1:3456', fetchImpl: makeFetch(recorded) });

  await sink({});
  await sink({ text: '   ' });

  assert.equal(recorded.length, 0);
});

test('桌宠出口：动作用 /anim，点名池内动画', async () => {
  const recorded: Recorded[] = [];
  const sink = createPetAnimSink({ baseUrl: 'http://127.0.0.1:3456', fetchImpl: makeFetch(recorded) });

  await sink('原地小憩沉眠');

  const url = new URL(recorded[0]!.url);
  assert.equal(url.pathname, `${PET_ROUTE_SEGMENT}/anim`);
  assert.equal(url.searchParams.get('pet'), DEFAULT_PET_ID);
  assert.deepEqual(JSON.parse(recorded[0]!.body ?? '{}'), { name: '原地小憩沉眠' });
});

test('桌宠出口：失败要把状态码抛出来，交给 express 层统计', async () => {
  const sink = createPetSink({
    baseUrl: 'http://127.0.0.1:3456',
    fetchImpl: makeFetch([], { ok: false, status: 404 }),
  });
  await assert.rejects(() => sink({ text: '在吗' }), /404/);

  const broken = createPetSink({
    baseUrl: 'http://127.0.0.1:3456',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(() => broken({ text: '在吗' }), /ECONNREFUSED/);
});

test('桌宠探测：2xx 算在跑，异常一律算不在，绝不抛', async () => {
  const ok = await probePet({
    baseUrl: 'http://127.0.0.1:3456',
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(ok, true);

  const missing = await probePet({
    baseUrl: 'http://127.0.0.1:3456',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(missing, false);

  const notInstalled = await probePet({
    baseUrl: 'http://127.0.0.1:3456',
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(notInstalled, false);
});

test('桌宠出口：三个情绪带都有池内动画，且互不重复', () => {
  const names = Object.values(PET_MOOD_ANIM);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3, '不同情绪不该播同一段动画');
  for (const name of names) assert.ok(name.length > 0);
});

test('桌宠工作动作：thinking/tool/reply/error 各有池内动画，其余事件不转发', () => {
  assert.equal(petWorkAnimFor('thinking'), '工作状态-思考冒泡');
  assert.equal(petWorkAnimFor('tool'), '工作状态-忙碌点按');
  assert.equal(petWorkAnimFor('reply'), '工作状态-清点归档');
  assert.equal(petWorkAnimFor('error'), '工作状态-垂头叹气冒汗');

  // 名字必须落在 dsh-pet 的 events.workStatus 池内，否则 /anim 回 unknown-animation
  const names = Object.values(PET_WORK_ANIM);
  assert.equal(new Set(names).size, 4, '四个工作状态动画名互不重复');

  assert.equal(petWorkAnimFor('motion'), undefined, '情绪动作走 PET_MOOD_ANIM，不经工作动作');
  assert.equal(petWorkAnimFor('move'), undefined);
  assert.equal(petWorkAnimFor(''), undefined);
});
