/**
 * 适配性 / 联动性自检。
 *
 * 用法：`npm run check:link`（会用一个临时数据目录与临时端口，不碰真实存档）
 *
 * 分两组：
 * - 适配性：旧配置、旧数据、旧连接器、dist 产物是否还认；
 * - 联动性：宿主 → 插件 → 桌宠队列 → 回执 → L5 → 表现，整条链路是否闭合。
 *
 * 输出 PASS / WARN / FAIL，有 FAIL 时以非 0 退出。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaughterPlugin } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { normalizeBodySignal, pickMotionByPad } from '../src/runtime/body-link.js';
import type { AssetPackage, Logger } from '../src/types.js';
import { silentLogger } from '../src/util.js';

type Status = 'PASS' | 'WARN' | 'FAIL';
const results: Array<{ status: Status; name: string; evidence: string }> = [];

function record(status: Status, name: string, evidence: string): void {
  results.push({ status, name, evidence });
  console.log(`${status === 'PASS' ? '✔' : status === 'WARN' ? '!' : '✖'} ${name} — ${evidence}`);
}

function check(name: string, run: () => string | void | Promise<string | void>): Promise<void> {
  return Promise.resolve()
    .then(run)
    .then((evidence) => record('PASS', name, evidence ?? 'ok'))
    .catch((error) => record('FAIL', name, String(error instanceof Error ? error.message : error)));
}

function warn(name: string, evidence: string): void {
  record('WARN', name, evidence);
}

function makeLogger(sink: string[]): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => sink.push(message),
    error: (message) => sink.push(`ERROR ${message}`),
  };
}

// 自检默认用 47912：47612 是插件在 DSH 里真实监听的端口，若共用会连到正在运行的应用实例，
// 读到别人队列里的残留事件。端口必须先写进环境变量，宿主模块再按它监听（见下方动态 import）。
const PORT = Number(process.env.DSH_DAUGHTER_BRIDGE_PORT ?? 47912);
process.env.DSH_DAUGHTER_BRIDGE_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;

// host.ts 在模块求值时读取端口常量，所以必须在设置环境变量之后再加载它
const { createHost } = await import('../src/host.js');

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/**
 * 桥接端点从 v0.6.1 起要求令牌（§12.2），自检脚本同样是"连接器"，
 * 必须像 MOD / 桌面桥那样带上 `x-dsh-token`，顺带验证这条链路真的通。
 */
let TOKEN = '';
const authHeaders = (extra: Record<string, string> = {}): Record<string, string> =>
  TOKEN ? { ...extra, 'x-dsh-token': TOKEN } : extra;

function get(path: string): Promise<{ status: number; body: any }> {
  return json(path, { headers: authHeaders() });
}

function post(path: string, payload: unknown): Promise<{ status: number; body: any }> {
  return json(path, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-daughter-link-'));

  /* ------------------------------ 适配性 ------------------------------ */

  await check('旧版 config.yaml（无 vpet / 新检索字段）', () => {
    const dir = join(root, 'legacy-config');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'config.yaml'),
      ['version: 1', 'character_id: daughter-default', 'retrieval:', '  top_k: 3', 'reflex:', '  enabled: true'].join('\n'),
      'utf8',
    );
    const config = loadConfig(dir, silentLogger);
    if (config.retrieval.top_k !== 3) throw new Error('旧字段未生效');
    if (!config.vpet?.body_link || config.retrieval.expand_fulltext !== true) throw new Error('新字段未取默认');
    return `top_k=${config.retrieval.top_k}，vpet.body_link.max_influence=${config.vpet.body_link.max_influence}`;
  });

  await check('非法 / 未支持配置项告警', () => {
    const dir = join(root, 'bad-config');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'config.yaml'),
      [
        'storage:',
        '  scope: session',
        '  single_writer: false',
        'safety:',
        '  diagnosis_labels_forbidden: false',
        'vpet:',
        '  body_link:',
        '    max_influence: 9',
        '    stale_ms: 1',
      ].join('\n'),
      'utf8',
    );
    const sink: string[] = [];
    const config = loadConfig(dir, makeLogger(sink));
    const warns = sink.length;
    // shared_across_* 已转为「真正生效的隔离开关」，只在 info 里说明，不再计入告警
    if (warns < 3) throw new Error(`告警不足：${warns}`);
    if (config.vpet.body_link.max_influence !== 1) throw new Error('max_influence 未收敛');
    if (config.vpet.body_link.stale_ms !== 30_000) throw new Error('stale_ms 未收敛');
    return `${warns} 条告警，max_influence=${config.vpet.body_link.max_influence}，stale_ms=${config.vpet.body_link.stale_ms}`;
  });

  await check('旧 L5 快照（无 body 字段）可读且能派生', () => {
    const store = new Store(join(root, 'legacy-l5'), 'daughter-default');
    const l5 = {
      sessionId: 'old-session',
      characterId: 'daughter-default',
      emotion: { pleasure: 0, arousal: 0, dominance: 0 },
      stress: 0.2,
      safety: 0.8,
      fatigue: 0.1,
      emotionalOverdraft: 0,
      boundary: 0.6,
      activeSubPersonaId: 'alone',
      lastTickAt: '2026-01-01T00:00:00.000Z',
      snapshotAt: '2026-01-01T00:00:00.000Z',
      schemaVersion: 1,
    };
    mkdirSync(store.paths.l5, { recursive: true });
    writeFileSync(join(store.paths.l5, 'old-session.json'), JSON.stringify(l5), 'utf8');
    const loaded = store.loadL5('old-session');
    if (!loaded) throw new Error('旧快照读不回');
    if (loaded.body !== undefined) throw new Error('不应凭空补 body');
    store.close();
    return '读取正常，body 保持缺省';
  });

  await check('旧 bridge 心跳（无体力/心情字段）', () => {
    const signal = normalizeBodySignal({ saveFound: true, level: 12, mode: 'Nomal' }, new Date().toISOString());
    if (signal !== null) throw new Error('缺字段时不应产生身体信号');
    return '返回 null，插件状态不受影响';
  });

  {
    const distIndex = statSync(join(process.cwd(), 'dist', 'index.js'));
    const srcDir = join(process.cwd(), 'src');
    const newest = readdirSync(srcDir, { recursive: true })
      .map((name) => String(name))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => statSync(join(srcDir, name)).mtimeMs)
      .reduce((a, b) => Math.max(a, b), 0);
    if (distIndex.mtimeMs < newest) {
      record('WARN', 'dist 产物是否比源码新', 'dist 落后于 src，需要 npm run build');
    } else {
      record('PASS', 'dist 产物是否比源码新', `dist 更新于 ${new Date(distIndex.mtimeMs).toISOString().slice(0, 19)}`);
    }
  }

  /* ------------------------------ 联动性 ------------------------------ */

  const listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const cleanups: Array<() => void> = [];
  const hostLoggerSink: string[] = [];
  const hostCtx = {
    logger: makeLogger(hostLoggerSink),
    get: () => undefined,
    on(name: string, listener: (...args: any[]) => unknown) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => undefined;
    },
    effect(fn: () => (() => void) | void) {
      const dispose = fn();
      if (dispose) cleanups.push(dispose);
      return () => undefined;
    },
    emit: () => undefined,
    webServer: undefined,
  };

  const plugin = createHost(hostCtx as any, { storage: { data_root: join(root, 'live') }, vpet: { body_link: { max_influence: 0.9, fatigue_weight: 0.9 } } } as any, process.cwd());

  // createHost 会在 data_root 下生成连接器令牌；自检后续的 /vpet/* 请求都要带上它
  TOKEN = readFileSync(join(root, 'live', 'brain', 'brainstem', 'connector_token'), 'utf8').trim();

  const preStep = () => {
    const handler = listeners.get('agent/pre-step')?.[0];
    if (!handler) throw new Error('宿主未注册 agent/pre-step');
    return handler;
  };
  const sessionEvent = () => {
    const handler = listeners.get('session/event')?.[0];
    if (!handler) throw new Error('宿主未注册 session/event');
    return handler;
  };

  const session = { id: 'link-session', header: { cwd: 'e:\\link' } };
  const userMessage = (text: string, id = `m-${Math.random().toString(16).slice(2, 8)}`) => ({
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });

  await new Promise((resolve) => setTimeout(resolve, 120));

  await check('桥接端点在线（健康检查不再泄露队列信息）', async () => {
    const { status, body } = await get('/health');
    if (status !== 200 || body?.ok !== true) throw new Error(`/health 返回 ${status}`);
    if (body.character !== undefined || body.vpet !== undefined) {
      throw new Error('/health 仍在暴露队列与角色信息');
    }
    return `auth=${body.auth}`;
  });

  await check('无令牌 → 401，浏览器来源 → 403', async () => {
    const anonymous = await json('/vpet/events?since=0');
    if (anonymous.status !== 401) throw new Error(`无令牌访问返回 ${anonymous.status}，应为 401`);
    const wrong = await json('/vpet/status', { headers: { 'x-dsh-token': 'f'.repeat(64) } });
    if (wrong.status !== 401) throw new Error(`错误令牌返回 ${wrong.status}，应为 401`);
    const browser = await json('/vpet/events?since=0', {
      headers: authHeaders({ origin: 'http://evil.example', 'sec-fetch-mode': 'cors' }),
    });
    if (browser.status !== 403) throw new Error(`浏览器来源返回 ${browser.status}，应为 403`);
    return '匿名 401 / 错误令牌 401 / 浏览器来源 403';
  });

  await check('用户消息 → 桌宠 thinking 事件', async () => {
    const message = userMessage('今天有点累');
    await preStep()({ agent: { session }, messages: [message], turn: 1, step: 1 }, async () => ({
      kind: 'enter',
      messages: [message],
    }));
    const { body } = await get('/vpet/events?since=0');
    const kinds = (body.events ?? []).map((event: any) => event.kind);
    if (!kinds.includes('thinking')) throw new Error(`事件里没有 thinking：${kinds.join(',')}`);
    return `队列 ${body.events.length} 条：${kinds.join(' / ')}`;
  });

  await check('模型回复 → 事件落盘 + reply 气泡 + ack 裁剪', async () => {
    await sessionEvent()(session, {
      type: 'assistant/message',
      data: {
        turn: 1,
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: 'test', model: 'test' },
          content: [{ type: 'text', text: '嗯，我在。先歇一会儿。' }],
        },
      },
    });
    const before = await get('/vpet/events?since=0');
    const reply = (before.body.events ?? []).find((event: any) => event.kind === 'reply');
    if (!reply) throw new Error('没有 reply 事件');
    const acked = await post('/vpet/events/ack', { seq: before.body.seq });
    const after = await get('/vpet/events?since=0');
    if ((after.body.events ?? []).length !== 0) {
      const left = (after.body.events ?? []).map((event: any) => `${event.kind}#${event.seq}`).join(',');
      throw new Error(
        `ack 后仍有 ${left}；ack 返回 trimmed=${acked.body?.trimmed}，ackSeq=${before.body.seq}，seq=${after.body.seq}`,
      );
    }

    const hits = await plugin.retrieve({
      characterId: 'daughter-default',
      query: '累',
      now: new Date().toISOString(),
      topK: 5,
      currentEmotion: { pleasure: 0, arousal: 0, dominance: 0 },
      excludeArchived: false,
    });
    if (hits.length === 0) throw new Error('回复后没有写入可检索的事件');
    return `reply=「${String(reply.text).slice(0, 12)}…」，ack 后 pending=0，事件可检索 ${hits.length} 条`;
  });

  await check('桌宠体力 → L5 疲劳 → 表现动作（body 通道闭环）', async () => {
    const beat = await post('/vpet/heartbeat', {
      saveFound: true,
      name: '测试桌宠',
      level: 12,
      mode: 'Nomal',
      strengthPct: 5,
      feelingPct: 40,
    });
    if (beat.body?.body?.strength !== 0.05) throw new Error(`心跳未回身体信号：${JSON.stringify(beat.body)}`);

    const status = await get('/vpet/status');
    if (status.body?.bridge?.strengthPct !== 5) throw new Error('/vpet/status 未带体力');

    const now = new Date().toISOString();
    const { l5 } = await plugin.onUserMessage({ ctx: makeCtx(now), text: '你还好吗', source: 'chat' });
    if (l5.fatigue < 0.7) throw new Error(`疲劳未抬升到 tired 带：${l5.fatigue}`);

    const message = userMessage('你还好吗');
    await preStep()({ agent: { session }, messages: [message], turn: 2, step: 1 }, async () => ({
      kind: 'enter',
      messages: [message],
    }));
    const { body } = await get('/vpet/events?since=0');
    const motion = (body.events ?? []).find((event: any) => event.kind === 'motion');
    if (!motion || motion.graph !== 'Sleep') throw new Error(`情绪动作未下发：${JSON.stringify(body.events)}`);
    return `体力 5% → 有效疲劳 ${l5.fatigue.toFixed(2)} → 动作 ${motion.graph}`;
  });

  await check('MOD 忙 / 玩家交互时情绪动作让行', async () => {
    await post('/vpet/consumer/report', {
      version: 'test',
      capabilities: { graphs: ['Say', 'Sleep', 'Touch_Head'], actions: ['animate', 'move'], queue: true },
      state: { busy: true, reason: 'player', playerActive: true, queued: 0, dropped: 0 },
    });
    await post('/vpet/events/ack', { seq: (await get('/vpet/events?since=0')).body.seq });
    const message = userMessage('还在忙吗');
    await preStep()({ agent: { session }, messages: [message], turn: 3, step: 1 }, async () => ({
      kind: 'enter',
      messages: [message],
    }));
    const { body } = await get('/vpet/events?since=0');
    const motions = (body.events ?? []).filter((event: any) => event.kind === 'motion');
    if (motions.length > 0) throw new Error(`让行失败，仍下发 motion：${JSON.stringify(motions)}`);
    return 'playerActive=true 时未下发 motion';
  });

  await check('vpet_control：能力校验与接管', async () => {
    await post('/vpet/consumer/report', {
      capabilities: { graphs: ['Say', 'Sleep'], actions: ['animate'], queue: true },
      state: { busy: false, playerActive: false, queued: 0, dropped: 0 },
    });
    const bad = await post('/vpet/control', { action: 'animate', graph: 'NotAGraph' });
    if (bad.status !== 400) throw new Error(`不支持的动画应 400，实际 ${bad.status}`);
    const good = await post('/vpet/control', { action: 'animate', graph: 'Say', loops: 2, text: '在的' });
    if (good.status !== 200) throw new Error(`合法动画被拒：${good.status}`);
    const { body } = await get('/vpet/events?since=0');
    const motion = (body.events ?? []).find((event: any) => event.kind === 'motion' && event.graph === 'Say');
    if (!motion) throw new Error('接管动作未入队');
    return `非法 graph 400，Say 入队（loops=${motion.loops}）`;
  });

  await check('外部连接通用入口（合法 / 非法来源）', async () => {
    const ok = await post('/connectors/android/ingest', { text: '手机上前台切到了浏览器' });
    if (ok.status !== 200 || !ok.body?.eventId) throw new Error(`合法来源失败：${ok.status}`);
    const bad = await post('/connectors/unknown/ingest', { text: 'x' });
    if (bad.status !== 404) throw new Error(`非法来源应 404，实际 ${bad.status}`);
    return `${ok.body.eventId} 写入成功，unknown 被拒`;
  });

  await check('星图与指标可用', () => {
    const counts = plugin.starMap('daughter-default', new Date().toISOString());
    const metrics = plugin.metrics('daughter-default');
    if (counts.nodes <= 0) throw new Error('星图节点为空');
    if (metrics.turns <= 0) throw new Error('指标未累计轮次');
    return `${counts.galaxies} 星系 / ${counts.nodes} 节点 / ${counts.edges} 边，turns=${metrics.turns}`;
  });

  await check('MOT 资产按 PAD 自动选动作', () => {
    const asset = (id: string, motionId: string, pleasure: number): AssetPackage => ({
      id,
      kind: 'MOT',
      name: id,
      payload: { motionId },
      padMatch: { pleasure, arousal: 0, dominance: 0 },
      rollbackVersion: 0,
      status: 'active',
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    const picked = pickMotionByPad([asset('A', 'MOT-HAPPY', 0.9), asset('B', 'MOT-SAD', -0.9)], {
      pleasure: -0.8,
      arousal: 0,
      dominance: 0,
    });
    if (picked?.motionId !== 'MOT-SAD') throw new Error('PAD 选择错误');
    return '低愉悦时选中 MOT-SAD';
  });

  await check('插件缺席时桌宠侧仍可独立（/vpet/status 无 MOD 上报）', async () => {
    const { status, body } = await get('/vpet/status');
    if (status !== 200) throw new Error('/vpet/status 不可用');
    if (typeof body.consumer?.online !== 'boolean') throw new Error('缺少在线判定');
    return `consumer.online=${body.consumer.online}，bridge.online=${body.bridge.online}（判定逻辑独立于数据是否新鲜）`;
  });

  await check('旧版 MOD 兼容：不带 since 一次性领取 + /vpet/say', async () => {
    const message = userMessage('老版本 MOD 测试');
    await preStep()({ agent: { session }, messages: [message], turn: 4, step: 1 }, async () => ({
      kind: 'enter',
      messages: [message],
    }));
    const first = await get('/vpet/events');
    if ((first.body.events ?? []).length === 0) throw new Error('旧版领取为空');
    const second = await get('/vpet/events');
    if ((second.body.events ?? []).length !== 0) throw new Error('旧版游标未前进，重复领取');
    const say = await get('/vpet/say');
    if (say.status !== 200) throw new Error(`/vpet/say 返回 ${say.status}`);
    return `首次 ${first.body.events.length} 条，二次 0 条，/vpet/say 可用`;
  });

  await check('旧格式反射规则（缺 enabled/priority/cooldownMs）', async () => {
    const store = new Store(join(root, 'live'), 'daughter-default');
    writeFileSync(
      join(store.paths.reflexes, 'rules.yaml'),
      ['- id: RFX-LEGACY', '  match: { type: keyword, patterns: [开灯] }', '  action: { kind: template_reply, text: 好 }'].join('\n'),
      'utf8',
    );
    store.close();

    const fresh = createDaughterPlugin({ pluginRoot: join(root, 'live'), config: loadConfig(join(root, 'live'), silentLogger) });
    const now = new Date().toISOString();
    const hit = await fresh.reflexMatch({
      ctx: makeCtx(now),
      userText: '帮我开灯',
      l5: {
        sessionId: 'legacy',
        characterId: 'daughter-default',
        emotion: { pleasure: 0, arousal: 0, dominance: 0 },
        stress: 0.1,
        safety: 0.9,
        fatigue: 0.1,
        emotionalOverdraft: 0,
        boundary: 0.6,
        activeSubPersonaId: 'alone',
        lastTickAt: now,
        snapshotAt: now,
        schemaVersion: 1,
      },
    });
    fresh.close();
    if (hit?.ruleId !== 'RFX-LEGACY') throw new Error(`旧规则未命中：${JSON.stringify(hit)}`);
    return '缺省字段补齐，规则正常命中';
  });

  await check('打包产物：入口模块与 cordis patch 引用齐全', async () => {
    const entry = await import('../index.js');
    if (typeof entry.apply !== 'function') throw new Error('index.js 缺少 apply');
    if (!Array.isArray(entry.inject) || !entry.inject.includes('webServer')) throw new Error('inject 声明异常');

    const { readFileSync } = await import('node:fs');
    const YAML = await import('yaml');
    const raw = YAML.parse(readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8'));
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        if (/^[\w./-]+\.(js|json|html|svg|yml|yaml)$/.test(node)) refs.push(node);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === 'object') Object.values(node as Record<string, unknown>).forEach(walk);
    };
    walk(raw);
    const missing = refs.filter((ref) => {
      try {
        statSync(join(process.cwd(), ref.replace(/^\.\//, '')));
        return false;
      } catch {
        return true;
      }
    });
    if (missing.length > 0) throw new Error(`patch 引用了不存在的文件：${missing.join(', ')}`);

    // package.json 的 files 列表里点名的静态资源必须真实存在
    const required = ['index.js', 'client.js', 'config.yaml', 'icon.svg', 'locale/zh.json', 'locale/en.json', 'web/star-map/index.html', 'dist/host.js'];
    const absent = required.filter((file) => {
      try {
        statSync(join(process.cwd(), file));
        return false;
      } catch {
        return true;
      }
    });
    if (absent.length > 0) throw new Error(`缺少静态资源：${absent.join(', ')}`);
    return `apply/inject 正常，patch 引用 ${refs.length} 个文件 + ${required.length} 个发布资源齐全`;
  });

  /* ------------------------------ 收尾 ------------------------------ */

  cleanups.forEach((fn) => fn());
  plugin.close();
  rmSync(root, { recursive: true, force: true });

  const passed = results.filter((item) => item.status === 'PASS').length;
  const warned = results.filter((item) => item.status === 'WARN').length;
  const failed = results.filter((item) => item.status === 'FAIL').length;
  console.log(`\n汇总：PASS ${passed} / WARN ${warned} / FAIL ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

function makeCtx(now: string) {
  return {
    characterId: 'daughter-default',
    sessionId: 'link-session',
    workspaceId: 'e:\\link',
    turnId: `check-${now}`,
    now: () => now,
    logger: silentLogger,
    tools: { invoke: async () => null },
  };
}

main().catch((error) => {
  console.error('检测脚本异常', error);
  process.exitCode = 1;
});
