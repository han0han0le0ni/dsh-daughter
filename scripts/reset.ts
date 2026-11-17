/**
 * 重置：清记忆 / 恢复出厂人格 / 清条件反射 / 清技能 / 恢复出厂设置。
 *
 * 默认 dry-run，只列清单不落盘；`--apply` 才真的删。
 * 删除前会把受影响的目录拷到 `logs/reset-backup/<时间戳>/`，
 * 被清空的目录不是删除而是整体 rename 到 `logs/reset-trash/<时间戳>/`，
 * 想捞回来直接搬回去就行。
 *
 * 用法（建议先停掉正在运行的 DSH，避免写者一边写一边被清）：
 *   npm run reset -- memory                 # 只报告
 *   npm run reset -- memory --apply         # 清记忆
 *   npm run reset -- personality --apply    # 人格恢复出厂
 *   npm run reset -- reflex --apply         # 条件反射与冷却
 *   npm run reset -- skills --apply         # 技能卡与动作模板
 *   npm run reset -- all --apply --yes      # 恢复出厂设置（需二次确认）
 *
 * 可选参数：
 *   --apply         真的执行（不加则 dry-run）
 *   --yes           确认执行 `all`（恢复出厂设置）
 *   --no-backup     跳过备份（出问题不可回滚，仅测试用）
 *   --root=<路径>   数据根，默认当前目录
 */
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { RESET_SCOPES, applyReset, planReset, verifyReset, type ResetScope } from '../src/runtime/reset.js';
import { silentLogger } from '../src/util.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const confirmed = argv.includes('--yes');
const backup = !argv.includes('--no-backup');
const rootArg = argv.find((item) => item.startsWith('--root='));
const root = resolve(rootArg ? rootArg.slice('--root='.length) : process.cwd());
const scopeArg = argv.find((item) => !item.startsWith('--')) ?? '';

function usage(reason?: string): never {
  if (reason) console.error(`参数错误：${reason}`);
  console.error('用法：npm run reset -- <scope> [--apply] [--yes] [--no-backup] [--root=<路径>]');
  console.error(`可用 scope：${RESET_SCOPES.join(' / ')}`);
  console.error('不加 --apply 时只打印清单（dry-run）。');
  process.exit(2);
}

if (!scopeArg) usage('缺少 scope');
if (!(RESET_SCOPES as string[]).includes(scopeArg)) usage(`未知 scope：${scopeArg}`);
const scope = scopeArg as ResetScope;

const config = loadConfig(root, silentLogger);
const store = new Store(root, config.character_id);

const plan = planReset(store, scope);
console.log(`数据根：${root}`);
console.log(`角色：${config.character_id}`);
console.log(`范围：${scope}${scope === 'all' ? '（恢复出厂设置）' : ''}`);
console.log('将被清除：');
for (const item of plan.items) console.log(`  - ${item.label}：${item.detail}`);

if (!apply) {
  console.log(`\n这是 dry-run。确认无误后执行：npm run reset -- ${scope} --apply${scope === 'all' ? ' --yes' : ''}`);
  store.close();
  process.exit(0);
}

if (scope === 'all' && !confirmed) {
  console.error('\n恢复出厂设置会清掉记忆、人格演化、反射、技能与运行状态，请加 --yes 确认。');
  store.close();
  process.exit(2);
}

const result = applyReset(store, scope, { backup });
console.log('\n已执行：');
for (const line of result.applied) console.log(`  [OK] ${line}`);
if (result.retired.length > 0) {
  console.log('已移入垃圾桶（可手动搬回）：');
  for (const path of result.retired) console.log(`  [TRASH] ${path}`);
}
if (result.backupDir) console.log(`备份：${result.backupDir}`);
if (result.errors.length > 0) {
  console.log('执行中失败的步骤：');
  for (const line of result.errors) console.log(`  [FAIL] ${line}`);
}

const verdict = verifyReset(store, scope);
console.log('\n复核（读回真实状态）：');
for (const check of verdict.checks) console.log(`  ${check.ok ? '[OK]' : '[!!]'} ${check.label}：${check.detail}`);

store.close();

if (!verdict.ok) {
  console.error('\n复核未通过：上面标 [!!] 的项仍有残留。若 DSH 正在运行，插件可能已经把状态写回去了，请停掉后重跑。');
  process.exit(1);
}
console.log(`\n完成：${scope} 已清空并复核通过。`);
