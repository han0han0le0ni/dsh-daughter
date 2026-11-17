/**
 * 存量事件回填 thread_id（"局"的一次性回填）。
 *
 * 为什么需要：`assignThread` 是写入侧才跑的，老库里的对话事件 thread_id 全是空，
 * 于是"昨晚那局"在注入时没有落脚处——只有回填之后，历史才跟新写的走同一套归并口径。
 *
 * 口径就是当前配置：同窗口 `same_window_minutes` 内的连续发言并成一局，
 * 跨窗口/跨时间再按话题（最长共同片段或整句相似）归并；间隔超过 `gap_minutes` 另起。
 *
 * 默认 dry-run，只报告不写库；加 `--apply` 才执行。
 *
 * 用法：
 *   npm run threads:backfill              # 只报告
 *   npm run threads:backfill -- --apply   # 实际执行（建议先退出正在运行的 DSH）
 */
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { isDialogueSource, pruneOpenThreads, assignThread, type ThreadHead } from '../src/runtime/threading.js';
import { silentLogger } from '../src/util.js';
import type { EventRecord } from '../src/types.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const rootArg = argv.find((item) => item.startsWith('--root='));
const root = resolve(rootArg ? rootArg.slice('--root='.length) : process.cwd());
const now = new Date().toISOString();

const config = loadConfig(root, silentLogger);
const store = new Store(root, config.character_id);
const events = store.listAllEvents().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

/** 全文层存的是「用户原话\n→ 助手回应」：回填只取用户那一半 */
function quoteOf(event: EventRecord): string | undefined {
  let full: string;
  try {
    full = store.readFullText(event.id);
  } catch {
    return undefined;
  }
  if (!full) return undefined;
  const [userPart] = full.split('\n→');
  return userPart?.trim() || undefined;
}

let heads: ThreadHead[] = [];
const planned: Array<{ id: string; from: string | undefined; to: string }> = [];
let skipped = 0;

for (const event of events) {
  if (event.archived || !isDialogueSource(event.source)) {
    skipped += 1;
    continue;
  }
  const assigned = assignThread(event, heads, config, quoteOf(event));
  heads = assigned.heads;
  if (event.threadId !== assigned.threadId) {
    planned.push({ id: event.id, from: event.threadId, to: assigned.threadId });
  }
}

const pruned = pruneOpenThreads(
  heads,
  now,
  config.threading.activity_ttl_minutes,
  6,
  config.threading.closed_retention_minutes,
);
const sizes = heads.map((head) => head.turnCount).sort((a, b) => b - a);
const multi = sizes.filter((size) => size >= 2).length;

console.log(`数据根：${root}　角色：${config.character_id}`);
console.log(`事件 ${events.length} 条（对话参与归并，已归档/非对话跳过 ${skipped} 条）`);
console.log(`按当前口径：会并成 ${heads.length} 局（≥2 轮 ${multi} 局，最大 ${sizes[0] ?? 0} 轮，单轮 ${sizes.length - multi} 局）`);
console.log(`需要改 thread_id 的事件：${planned.length} 条（其中原本为空 ${planned.filter((item) => !item.from).length} 条）`);
console.log('最大的 3 局：');
for (const head of [...heads].sort((a, b) => b.turnCount - a.turnCount).slice(0, 3)) {
  console.log(`  ${head.turnCount} 轮 | ${head.startedAt.slice(5, 16)} → ${head.lastTurnAt.slice(5, 16)} | ${head.label}`);
}

if (!apply) {
  console.log('\n这是 dry-run。确认无误后执行：npm run threads:backfill -- --apply');
  store.close();
  process.exit(0);
}

for (const item of planned) store.setEventThreadId(item.id, item.to);
store.saveOpenThreads(pruned);
console.log(`\n已回填 ${planned.length} 条；寄存器写入 ${pruned.length} 局（进行中/刚收尾）。`);
store.close();
