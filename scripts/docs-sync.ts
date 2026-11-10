/**
 * 文档数字同步：把设计文档里会随代码变化的数字（测试项数、自检项数、版本号）
 * 交给占位符渲染，避免「文档写 203、实测 263」这类漂移。
 *
 * 占位符写法：`{{test_count}}` / `{{check_items}}` / `{{version}}`
 *
 * 用法：
 * - `npm run docs:sync`：就地渲染 `docs/*.md`
 * - `npm run docs:sync -- --check`：只检查不写，有漂移时退出码 1（`check:link` 第 22 项复用）
 *
 * 口径说明：测试项数按 `tests/*.test.ts` 里顶层 `test(` 声明静态计数，
 * 与 `node --test` 的 `pass` 数一致（循环里动态生成的用例不计，本项目没有这种写法）；
 * 自检项数按 `scripts/link-check.ts` 的 `await check(` 加手动 `record('PASS'` 计数。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type DocMetricKey = 'version' | 'test_count' | 'check_items';

/**
 * 可渲染标记：`<!--docsync:key-->当前值<!--/docsync-->`。
 * 必须把值留在标记里——纯 `{{key}}` 渲染一次就变成裸数字，之后既看不出来源也检测不到漂移。
 * Markdown 渲染时 HTML 注释不可见，读者只看到数字。
 */
const MARKER = /<!--\s*docsync:(version|test_count|check_items)\s*-->[\s\S]*?<!--\s*\/docsync\s*-->/g;

export type DocMetrics = Record<DocMetricKey, string>;

/** 静态统计 `tests/*.test.ts` 的顶层测试声明数 */
function countTests(root: string): number {
  const dir = join(root, 'tests');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.test.ts'))
    .reduce((sum, name) => {
      const text = readFileSync(join(dir, name), 'utf8');
      return sum + (text.match(/^test\(/gm)?.length ?? 0);
    }, 0);
}

/**
 * 静态统计 `check:link` 的检查项数：
 * `await check(` 是标准项，`record('PASS', '名称'` 是手工分支项（如 dist 新旧）；
 * 辅助函数里的 `record('PASS', name, …)` 第二参是变量而不是字符串，不会被计入。
 */
function countChecks(root: string): number {
  const text = readFileSync(join(root, 'scripts', 'link-check.ts'), 'utf8');
  const auto = text.match(/await check\(/g)?.length ?? 0;
  const manual = text.match(/record\('PASS', '/g)?.length ?? 0;
  return auto + manual;
}

export function collectMetrics(root: string = process.cwd()): DocMetrics {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
  return {
    version: pkg.version ?? '0.0.0',
    test_count: String(countTests(root)),
    check_items: String(countChecks(root)),
  };
}

/** 渲染单个文件：返回新文本、是否变化、命中的标记 */
export function renderDoc(text: string, metrics: DocMetrics): { text: string; changed: boolean; keys: DocMetricKey[] } {
  const keys = new Set<DocMetricKey>();
  const next = text.replace(MARKER, (_match, key: DocMetricKey) => {
    keys.add(key);
    return `<!--docsync:${key}-->${metrics[key]}<!--/docsync-->`;
  });
  return { text: next, changed: next !== text, keys: [...keys] };
}

export interface DocDrift {
  file: string;
  keys: DocMetricKey[];
}

/** 扫描 `docs/*.md`，返回与实际值不一致的文件（write=true 时就地修正） */
export function syncDocs(root: string = process.cwd(), write = true): DocDrift[] {
  const metrics = collectMetrics(root);
  const dir = join(root, 'docs');
  const drift: DocDrift[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const file = join(dir, name);
    const source = readFileSync(file, 'utf8');
    const rendered = renderDoc(source, metrics);
    if (!rendered.changed) continue;
    drift.push({ file: name, keys: rendered.keys });
    if (write) writeFileSync(file, rendered.text, 'utf8');
  }
  return drift;
}

if (process.argv[1] && /docs-sync\.(ts|js)$/.test(process.argv[1])) {
  const checkOnly = process.argv.includes('--check');
  const drift = syncDocs(process.cwd(), !checkOnly);
  if (drift.length === 0) {
    console.log('文档数字已同步');
  } else if (checkOnly) {
    for (const item of drift) console.error(`✖ ${item.file} — ${item.keys.join(' / ')} 与实际值不一致`);
    console.error('请运行 npm run docs:sync');
    process.exitCode = 1;
  } else {
    for (const item of drift) console.log(`✔ ${item.file} — 已更新 ${item.keys.join(' / ')}`);
  }
}
