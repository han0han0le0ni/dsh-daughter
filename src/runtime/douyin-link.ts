/**
 * 抖音联动（读侧）：只读 `dsh-douyin-browser-local` 的共享记忆库，
 * 把"主人今天刷了什么"变成她自己的一条事件。
 *
 * 为什么是读而不是收：那个插件没有对外 webhook 或事件，它把观看记录写进自己的
 * SQLite 共享记忆（`memory_entries`，`origin='video'`，时间是毫秒）。
 * 她这边虽然早有 `/connectors/douyin_content` 入口，但没人会主动调——所以改成她定时去读。
 *
 * 边界：**只读**（`readOnly: true`），绝不写对方的库；库不存在、表结构变了、
 * 运行环境没有 `node:sqlite`，都只是"这次没有新内容"，不抛、不影响插件其余部分。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 一条观看记录，只留拼接事件文本要用的字段 */
export interface DouyinMemoryItem {
  id: number;
  title: string;
  author: string;
  content: string;
  url: string;
  /** 毫秒 */
  createdAt: number;
  /** 毫秒，游标就靠它往前挪 */
  updatedAt: number;
}

/** 只声明用得到的那几个方法，测试里可以塞一个假实现 */
export interface DouyinStatement {
  all(...params: unknown[]): unknown[];
}

export interface DouyinDatabase {
  prepare(sql: string): DouyinStatement;
  close(): void;
}

export interface DouyinReadOptions {
  dbPath: string;
  /** 只取 `updated_at` 大于它的条目（毫秒）；缺省 0 = 不限 */
  sinceMs?: number;
  /** 单次最多取几条，缺省 5 */
  limit?: number;
  /** 注入打开实现（测试用）；缺省动态 import('node:sqlite') */
  open?: (path: string) => DouyinDatabase;
}

export interface DouyinReadResult {
  ok: boolean;
  items: DouyinMemoryItem[];
  /** 失败原因，只用于日志 */
  reason?: string;
}

/** 抖音插件的默认共享记忆库位置 */
export function defaultDouyinDbPath(home: string = homedir()): string {
  return join(home, '.dsh', 'douyin-browser', 'memory', 'shared.sqlite');
}

/** 展开配置里的 `~`；空值回默认位置 */
export function resolveDouyinDbPath(raw: string, home: string = homedir()): string {
  const value = String(raw ?? '').trim();
  if (!value) return defaultDouyinDbPath(home);
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2));
  return value;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function millis(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toItem(row: Record<string, unknown>): DouyinMemoryItem {
  return {
    id: Number(row.id) || 0,
    title: text(row.title),
    author: text(row.author),
    content: text(row.content),
    url: text(row.url),
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

/**
 * 读一批新的观看记录，按时间从早到晚返回——事件流有时序意义，
 * 倒序灌进去会让"上周刷的"排到"刚刷的"后面。
 */
export async function readDouyinMemory(options: DouyinReadOptions): Promise<DouyinReadResult> {
  const limit = Math.min(50, Math.max(1, Math.round(options.limit ?? 5)));
  const since = Number.isFinite(options.sinceMs) ? Number(options.sinceMs) : 0;

  let open = options.open;
  let db: DouyinDatabase | null = null;
  try {
    if (!open) {
      const sqlite = (await import('node:sqlite')) as unknown as {
        DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DouyinDatabase;
      };
      open = (path) => new sqlite.DatabaseSync(path, { readOnly: true });
    }
    db = open(options.dbPath);
    const rows = db
      .prepare(
        "SELECT id, title, author, content, url, created_at, updated_at FROM memory_entries WHERE origin = 'video' AND updated_at > ? ORDER BY updated_at ASC LIMIT ?",
      )
      .all(since, limit);
    const items = rows
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      .map(toItem);
    return { ok: true, items };
  } catch (error) {
    // 没装 sqlite / 库被删 / 表名变了 —— 都只在日志里留一句，不打断任何东西
    return { ok: false, items: [], reason: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      db?.close();
    } catch {
      /* 关不掉就算了，只读连接，进程退出会回收 */
    }
  }
}

const MAX_TEXT = 160;

/** 压成一行：抖音的 title 里常带换行与话题串，直接塞进事件会把摘要撑爆 */
function squeeze(raw: string): string {
  const flat = raw
    .replace(/\s+/g, ' ')
    .replace(/展开.*$/, '')
    .trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

/**
 * 把一条观看记录写成她的事件文本。
 * 用第一人称的观察口吻，而不是"用户观看了视频：xxx"——她是要把这件事记成自己的经历。
 */
export function renderDouyinEventText(item: DouyinMemoryItem): string {
  const title = squeeze(item.title) || squeeze(item.content);
  if (!title) return '';
  const author = squeeze(item.author);
  return author ? `刷抖音刷到 ${author} 的视频：${title}` : `刷抖音刷到一条视频：${title}`;
}
