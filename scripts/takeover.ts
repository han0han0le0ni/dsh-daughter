/**
 * 人格接管命令：把 dsh-daughter 的人格卡写给外接聊天插件。
 *
 * 用法：
 *   npm run takeover -- --target douyin            只看计划（默认 dry-run）
 *   npm run takeover -- --target douyin --apply    落盘（先快照原文件）
 *   npm run takeover -- --revert                   按清单还原上一次接管
 *
 * 只写人格卡；登录、浏览器、模型、限流、策略一概不碰。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyPersonaTakeover,
  composePersonaCard,
  planPersonaTakeover,
  readPersonaSnapshot,
  resolveDouyinPersonaCard,
  revertPersonaTakeover,
  type TakeoverRecord,
} from '../src/runtime/takeover.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueOf = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const target = valueOf('--target') ?? 'douyin';
const nev = path.join(root, 'brain', 'neocortex', 'daughter-default');
const manifestFile = path.join(root, 'takeover', 'manifest.json');

function readManifest(): TakeoverRecord | null {
  try {
    return JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as TakeoverRecord;
  } catch {
    return null;
  }
}

if (has('--revert')) {
  const record = readManifest();
  if (!record) {
    console.log('没有接管清单，先 --apply 一次再来还原');
    process.exit(0);
  }
  const result = revertPersonaTakeover(record);
  fs.rmSync(manifestFile, { force: true });
  console.log(`${result === 'restored' ? '已还原原人格卡' : '已删除接管时新建的人格卡'}：${record.target}`);
  process.exit(0);
}

if (target !== 'douyin') {
  console.log(`暂只支持 douyin，收到 ${target}`);
  process.exit(1);
}

const cardFile = resolveDouyinPersonaCard(os.homedir());
const snapshot = readPersonaSnapshot(nev);
const now = new Date().toISOString();
const content = composePersonaCard(snapshot, { now, source: 'neocortex/daughter-default' });
const plan = planPersonaTakeover({
  target: cardFile,
  content,
  backupDir: path.join(root, 'takeover', 'backups'),
  now,
});

console.log(`目标：${plan.target}`);
console.log(`原文件：${plan.existed ? '存在，将快照' : '不存在，将新建'}`);
console.log(`快照位置：${plan.backupFile ?? '（无）'}`);
console.log(`卡片字数：${content.length}`);
console.log('--- 卡首 ---');
console.log(content.split('\n').slice(0, 14).join('\n'));

if (!has('--apply')) {
  console.log('\n这是干跑。确认无误后加 --apply 落盘。');
  process.exit(0);
}

const record = applyPersonaTakeover(plan);
fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
fs.writeFileSync(manifestFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
console.log(`\n已写入，校验 sha256 ${record.sha256.slice(0, 12)}…`);
console.log(`还原：npm run takeover -- --revert`);
