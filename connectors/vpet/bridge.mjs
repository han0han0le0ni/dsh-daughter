#!/usr/bin/env node
/**
 * VPet 桌宠 ↔ dsh-daughter 双向桥。
 *
 * 感知：读取 VPet 存档（Saves/Save_*.lps），把体力/心情/等级/好感度/摸头等变化推给插件，
 *       并每个周期发送心跳，供插件判断桥接与存档是否在线。
 * 演出：由 VPet 代码 MOD（mod-src/）按游标轮询插件端点 /vpet/events，处理完回写 ack。
 *
 * 用法：
 *   node connectors/vpet/bridge.mjs                 # 常驻，默认 30s 轮询
 *   node connectors/vpet/bridge.mjs --once          # 只跑一轮，便于验证
 *   node connectors/vpet/bridge.mjs --vpet "E:\...\VPet" --endpoint http://127.0.0.1:47612
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function option(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const VPET_ROOT = option('vpet', process.env.VPET_ROOT ?? 'E:\\SteamLibrary\\steamapps\\common\\VPet');
const ENDPOINT = option('endpoint', process.env.DSH_DAUGHTER_ENDPOINT ?? 'http://127.0.0.1:47612');
const INTERVAL_MS = Number(option('interval', '30')) * 1000;
const ONCE = flag('once');

/** 默认令牌文件：插件根目录 brain/brainstem/connector_token */
const DEFAULT_TOKEN_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'brain',
  'brainstem',
  'connector_token',
);

function readToken() {
  const explicit = String(option('token', process.env.DSH_DAUGHTER_TOKEN ?? '')).trim();
  if (explicit) return explicit;
  const file = option('token-file', process.env.DSH_DAUGHTER_TOKEN_FILE ?? DEFAULT_TOKEN_FILE);
  try {
    if (!existsSync(file)) return '';
    const raw = readFileSync(file, 'utf8').trim();
    return raw.length >= 16 ? raw : '';
  } catch {
    return '';
  }
}

const TOKEN = readToken();
if (!TOKEN) {
  console.error(
    '[vpet-bridge] 缺少连接器令牌，已拒绝启动。\n' +
      '  先启动一次插件生成 brain/brainstem/connector_token，或用 --token / DSH_DAUGHTER_TOKEN 指定。',
  );
  process.exit(1);
}

/** 出站请求统一带令牌：插件的 /vpet/* 不再对"本机来的"放行 */
function authHeaders(extra = {}) {
  return { ...extra, 'x-dsh-token': TOKEN };
}

function log(...parts) {
  console.log(`[vpet-bridge] ${parts.join(' ')}`);
}

/* ------------------------------ 存档解析 ------------------------------ */

/** LinePutScript：`段名:|键#值:|键#值:|` */
export function parseLps(raw) {
  const sections = {};
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf(':|');
    if (at <= 0) continue;
    const name = line.slice(0, at);
    const entries = {};
    for (const segment of line.slice(at + 2).split(':|')) {
      const trimmed = segment.replace(/\|$/, '');
      if (!trimmed) continue;
      const hash = trimmed.indexOf('#');
      if (hash <= 0) continue;
      entries[trimmed.slice(0, hash)] = trimmed.slice(hash + 1);
    }
    sections[name] = entries;
  }
  return sections;
}

async function findSaveFile() {
  const dir = path.join(VPET_ROOT, 'Saves');
  const names = await readdir(dir);
  const candidates = names.filter((n) => /^Save[-_].*\.lps$/.test(n));
  let newest = null;
  for (const name of candidates) {
    const full = path.join(dir, name);
    const s = await stat(full);
    if (!newest || s.mtimeMs > newest.mtimeMs) newest = { full, mtimeMs: s.mtimeMs };
  }
  return newest;
}

const num = (value) => Number(value ?? 0) || 0;
const MAX_STAT = 1e11; // VPet 体力/心情等满值量级
const pct = (value) => Math.round((num(value) / MAX_STAT) * 100);

/** 把 VPet 的超大数值压成可读单位 */
function humanNumber(value) {
  const n = num(value);
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} 万亿`;
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return String(n);
}

async function readSnapshot() {
  const info = await findSaveFile();
  if (!info) return { file: null, mtimeMs: null, snapshot: null };
  const raw = await readFile(info.full, 'utf8');
  const s = parseLps(raw);
  const v = s.vpet ?? {};
  const st = s.statistics ?? {};
  const snapshot = {
    name: v.name ?? '桌宠',
    level: num(v.Level),
    mode: v.mode ?? 'Nomal',
    strength: num(v.strength),
    feeling: num(v.feeling),
    health: num(v.health),
    likability: num(v.likability),
    money: num(v.money),
    touchHead: num(st.stat_touch_head),
    sayTimes: num(st.stat_say_times),
    activeDays: num(st.eval_active_days),
  };
  return { file: info.full, mtimeMs: info.mtimeMs, snapshot };
}

const MODE_TEXT = { Nomal: '正常', Sleep: '睡觉', Work: '工作', Idel: '闲逛', Idle: '闲逛' };

/** 对比两次快照，产出值得写入记忆的差异 */
export function diffSnapshots(prev, next) {
  if (!prev) return [];
  const events = [];
  const name = next.name;

  if (next.level > prev.level) events.push(`桌宠${name}升到了 ${next.level} 级。`);
  if (next.likability > prev.likability) events.push(`桌宠${name}的好感度涨到 ${humanNumber(next.likability)}。`);
  if (next.mode !== prev.mode) {
    events.push(`桌宠${name}进入了${MODE_TEXT[next.mode] ?? next.mode}状态。`);
  }
  const strengthDrop = pct(prev.strength) - pct(next.strength);
  if (strengthDrop >= 5) events.push(`桌宠${name}的体力降到 ${pct(next.strength)}%，有点饿了。`);
  const feelingDrop = pct(prev.feeling) - pct(next.feeling);
  if (feelingDrop >= 5) events.push(`桌宠${name}的心情低了一些，现在是 ${pct(next.feeling)}%。`);
  if (next.touchHead > prev.touchHead) {
    events.push(`你摸了摸桌宠${name}的头（累计 ${next.touchHead} 次）。`);
  }
  return events;
}

/* -------------------------------- 主循环 -------------------------------- */

async function ingest(text) {
  const response = await fetch(`${ENDPOINT}/vpet/ingest`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`ingest ${response.status}: ${await response.text()}`);
  return response.json();
}

/** 心跳：让插件知道桥接进程与存档是否在线（不写入记忆）。 */
async function heartbeat(snapshot, file, mtimeMs) {
  const response = await fetch(`${ENDPOINT}/vpet/heartbeat`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      saveFound: snapshot !== null,
      saveFile: file ?? undefined,
      saveMtimeMs: mtimeMs ?? undefined,
      name: snapshot?.name,
      level: snapshot?.level,
      mode: snapshot?.mode,
      // 体力/心情：插件侧用它派生 L5 的疲劳与压力（旧版插件忽略这两个字段，互不影响）
      strengthPct: snapshot ? pct(snapshot.strength) : undefined,
      feelingPct: snapshot ? pct(snapshot.feeling) : undefined,
    }),
  });
  if (!response.ok) throw new Error(`heartbeat ${response.status}: ${await response.text()}`);
}

async function cycle(state) {
  const { file, mtimeMs, snapshot } = await readSnapshot();
  try {
    await heartbeat(snapshot, file, mtimeMs);
  } catch (error) {
    log(`心跳失败：${error.message}`);
  }
  if (!snapshot) {
    log('未找到 VPet 存档，跳过');
    return;
  }

  for (const text of diffSnapshots(state.snapshot, snapshot)) {
    try {
      const result = await ingest(text);
      log(`感知 -> ${text}（${result.eventId}）`);
    } catch (error) {
      log(`推送失败：${error.message}`);
    }
  }
  state.snapshot = snapshot;
}

async function main() {
  log(`VPet=${VPET_ROOT} endpoint=${ENDPOINT} interval=${INTERVAL_MS / 1000}s`);

  const state = { snapshot: null };
  await cycle(state);
  if (ONCE) return;

  setInterval(() => {
    cycle(state).catch((error) => log(`轮询失败：${error.message}`));
  }, INTERVAL_MS);
}

main().catch((error) => {
  console.error('[vpet-bridge] 启动失败：', error);
  process.exit(1);
});
