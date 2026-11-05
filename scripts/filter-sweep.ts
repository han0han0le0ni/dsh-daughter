/**
 * 存量记忆清理（认知滤网的一次性回填）。
 *
 * 默认 dry-run，只报告不落盘；加 `--apply` 才执行。
 *
 * 做两件事：
 * 1. 同题压缩：数字/单位归一化后签名相同的事件视为一件事，保留权重最高的一条，
 *    其余归档并把次数累加到 `merged_count`；
 * 2. 低价值忘却：显著性低 + 从未被想起 + 闲置超期 → 归档。
 *
 * 用法：
 *   npm run filter:sweep            # 只报告
 *   npm run filter:sweep -- --apply # 实际执行（建议先停掉正在运行的 DSH）
 */
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { eventSignature, forgetSweep, sourceWeightOf } from '../src/runtime/filter.js';
import type { EventRecord } from '../src/types.js';
import { silentLogger } from '../src/util.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const rootArg = argv.find((item) => item.startsWith('--root='));
const root = resolve(rootArg ? rootArg.slice('--root='.length) : process.cwd());
const now = new Date().toISOString();

const config = loadConfig(root, silentLogger);
const store = new Store(root, config.character_id);
const events = store.listAllEvents().filter((event) => !event.archived);

const groups = new Map<string, EventRecord[]>();
for (const event of events) {
  // 与运行时 decideIngest 保持同一口径：只在同来源内判同题，
  // 避免把真人对话并进"窗口切换到 xx"这类系统事件
  const signature = event.source + '\u0000' + eventSignature(event);
  const bucket = groups.get(signature);
  if (bucket) bucket.push(event);
  else groups.set(signature, [event]);
}

// 存量事件的显著性：按来源保守估计，与 forgetSweep 的兜底口径一致
const needSalience = events.filter((event) => event.salience === undefined);
const estimateSalience = (event: EventRecord): number =>
  Number((sourceWeightOf(event.source, config) * 0.4).toFixed(3));

const duplicates = [...groups.values()].filter((group) => group.length > 1);
const duplicateTargets: Array<{ keep: EventRecord; archive: EventRecord[] }> = [];
for (const group of duplicates) {
  const sorted = [...group].sort((a, b) => b.weight - a.weight || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  duplicateTargets.push({ keep: sorted[0]!, archive: sorted.slice(1) });
}

const forget = forgetSweep(events, config, now);
const forgetIds = new Set(forget.ids);

// 按显著性强制清理存量：忽略闲置时间（forgetSweep 要求 idle_days），
// 用于一次性扫掉"窗口切换到 xx"这类从未有用过的系统事件
const salienceArg = argv.find((item) => item.startsWith('--salience='));
const salienceBelow = salienceArg ? Number(salienceArg.slice('--salience='.length)) : null;
const lowValue =
  salienceBelow !== null && Number.isFinite(salienceBelow)
    ? events.filter((event) => (event.salience ?? estimateSalience(event)) < salienceBelow)
    : [];
for (const event of lowValue) forgetIds.add(event.id);
const duplicateIds = new Set(duplicateTargets.flatMap((item) => item.archive.map((event) => event.id)));
const toArchive = [...new Set([...duplicateIds, ...forgetIds])]
  .map((id) => events.find((event) => event.id === id))
  .filter((event): event is EventRecord => Boolean(event));

const bySource = new Map<string, number>();
for (const event of toArchive) bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1);

console.log(`数据根：${root}`);
console.log(`未归档事件：${events.length}`);
console.log(`待补显著性：${needSalience.length} 条（按 来源可信度 × 0.4 估算）`);
console.log(`同题分组：${duplicates.length} 组，可压缩 ${duplicateIds.size} 条`);
if (salienceBelow !== null && Number.isFinite(salienceBelow)) {
  console.log(`显著性低于 ${salienceBelow} 的存量：${lowValue.length} 条（强制清理，忽略闲置时间）`);
}
console.log(`低价值可忘却：${forgetIds.size} 条`);
console.log(`合计待归档：${toArchive.length} 条`);
console.log('按来源：', Object.fromEntries([...bySource.entries()].sort((a, b) => b[1] - a[1])));
console.log('重复最多的 5 组：');
for (const item of [...duplicateTargets].sort((a, b) => b.archive.length - a.archive.length).slice(0, 5)) {
  console.log(`  ×${item.archive.length + 1}  ${item.keep.title.slice(0, 40)}  （保留 ${item.keep.id}）`);
}

if (!apply) {
  console.log('\n这是 dry-run。确认无误后执行：npm run filter:sweep -- --apply');
  store.close();
  process.exit(0);
}

let backfilled = 0;
for (const event of needSalience) {
  store.updateEventMutable(event.id, { salience: estimateSalience(event) });
  backfilled += 1;
}

let archived = 0;
for (const target of duplicateTargets) {
  const merged = target.archive.length;
  // 保留的那条不归档，只累加合并次数
  store.updateEventMutable(target.keep.id, { mergedCount: (target.keep.mergedCount ?? 0) + merged });
  for (const event of target.archive) {
    store.archiveEvent(event);
    store.updateEventMutable(event.id, { archived: true });
    archived += 1;
  }
  store.bumpCounter('filter.merge', merged);
}
for (const id of forgetIds) {
  if (duplicateIds.has(id)) continue;
  const event = events.find((item) => item.id === id);
  if (!event) continue;
  store.archiveEvent(event);
  store.updateEventMutable(id, { archived: true });
  store.bumpCounter('filter.forget');
  archived += 1;
}

// 归档后摘链：连历史归档留下的悬空边一起收掉，否则 links 一直指向已归档事件
const detached = store.detachLinks(
  store.listAllEvents().filter((event) => event.archived).map((event) => event.id),
);
// 存量出边修剪：历史热点事件可能挂着上百条边，让 linkProximity 对所有候选都成立
const trimmed = store.trimLinks();

console.log(`\n已补显著性 ${backfilled} 条；已归档 ${archived} 条；清理 ${detached} 条事件的残留链接；修剪 ${trimmed} 条事件的出度。`);
console.log(`剩余未归档 ${store.listCandidates(false, 10_000).length} 条。`);
store.close();
