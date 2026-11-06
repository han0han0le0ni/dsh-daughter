import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  defaultDouyinDbPath,
  readDouyinMemory,
  renderDouyinEventText,
  resolveDouyinDbPath,
  type DouyinMemoryItem,
} from '../src/runtime/douyin-link.js';

interface Seed {
  id: number;
  title: string;
  author?: string;
  content?: string;
  origin?: string;
  updatedAt: number;
}

/** 造一个和抖音插件结构一致的库（只建用得到的列），插完就关，之后全程只读 */
async function makeDb(seeds: Seed[]): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-douyin-'));
  const dbPath = join(dir, 'shared.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, kind TEXT, content TEXT, url TEXT, author TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, origin TEXT)',
  );
  const insert = db.prepare(
    'INSERT INTO memory_entries (id, kind, content, url, author, title, created_at, updated_at, origin) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  for (const seed of seeds) {
    insert.run(
      seed.id,
      'video',
      seed.content ?? '',
      'https://www.douyin.com/video/1',
      seed.author ?? '',
      seed.title,
      seed.updatedAt,
      seed.updatedAt,
      seed.origin ?? 'video',
    );
  }
  db.close();
  return { dir, dbPath };
}

function makeItem(overrides: Partial<DouyinMemoryItem> = {}): DouyinMemoryItem {
  return {
    id: 1,
    title: '9月1日还不还 #小品搞笑',
    author: '喜欢看小品吗',
    content: '',
    url: '',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

test('抖音联动：库路径支持 ~ 与留空', () => {
  assert.equal(resolveDouyinDbPath('', 'C:/Users/x'), defaultDouyinDbPath('C:/Users/x'));
  assert.equal(
    resolveDouyinDbPath('~/.dsh/douyin-browser/memory/shared.sqlite', 'C:/Users/x'),
    join('C:/Users/x', '.dsh/douyin-browser/memory/shared.sqlite'),
  );
  assert.equal(resolveDouyinDbPath('E:/data/shared.sqlite', 'C:/Users/x'), 'E:/data/shared.sqlite');
});

test('抖音联动：只取视频记录，按时间从早到晚', async (t) => {
  const { dir, dbPath } = await makeDb([
    { id: 1, title: '早的', author: 'A', updatedAt: 1_000 },
    { id: 2, title: '晚的', author: 'B', updatedAt: 3_000 },
    // 聊天记录不该被当成"刷到的视频"
    { id: 3, title: '聊天', updatedAt: 2_000, origin: 'chat' },
  ]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await readDouyinMemory({ dbPath, limit: 10 });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.items.map((item) => item.title),
    ['早的', '晚的'],
    '倒序会让"上周刷的"排到"刚刷的"后面',
  );
  assert.equal(result.items[0]!.author, 'A');
});

test('抖音联动：游标之后才算新内容，条数有上限', async (t) => {
  const { dir, dbPath } = await makeDb([
    { id: 1, title: '一', updatedAt: 1_000 },
    { id: 2, title: '二', updatedAt: 2_000 },
    { id: 3, title: '三', updatedAt: 3_000 },
  ]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const afterCursor = await readDouyinMemory({ dbPath, sinceMs: 1_000, limit: 10 });
  assert.deepEqual(afterCursor.items.map((item) => item.title), ['二', '三']);

  const capped = await readDouyinMemory({ dbPath, sinceMs: 0, limit: 1 });
  assert.deepEqual(capped.items.map((item) => item.title), ['一'], '先追早的，游标才会稳定往前挪');
});

test('抖音联动：库不存在或表结构不对都只是"这次没有新内容"', async (t) => {
  const missing = await readDouyinMemory({ dbPath: join(tmpdir(), 'dsh-no-such-dir', 'shared.sqlite') });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.items, []);
  assert.ok(missing.reason);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-douyin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const emptyDb = join(dir, 'empty.sqlite');
  new DatabaseSync(emptyDb).close();

  const noTable = await readDouyinMemory({ dbPath: emptyDb });
  assert.equal(noTable.ok, false, '表被改名或还没建，也不该抛到宿主');
  assert.deepEqual(noTable.items, []);
});

test('抖音联动：事件文本带作者，去掉话题尾巴与换行', () => {
  const text = renderDouyinEventText(makeItem({ title: '9月1日还不还 #小品搞笑 展开相关搜索：沈腾' }));
  assert.equal(text, '刷抖音刷到 喜欢看小品吗 的视频：9月1日还不还 #小品搞笑');

  // 没有作者时退回中性说法
  assert.equal(renderDouyinEventText(makeItem({ author: '' })), '刷抖音刷到一条视频：9月1日还不还 #小品搞笑');

  // 标题空但正文有内容 → 用正文
  assert.ok(renderDouyinEventText(makeItem({ title: '  ', content: '画面里有只猫' })).includes('画面里有只猫'));

  // 什么都没有 → 不产生事件
  assert.equal(renderDouyinEventText(makeItem({ title: '', content: '' })), '');
});

test('抖音联动：超长标题会被截断，不把事件摘要撑爆', () => {
  const long = '看'.repeat(400);
  const text = renderDouyinEventText(makeItem({ title: long }));
  const body = text.split('：')[1]!;
  assert.ok(body.length <= 160, `实际 ${body.length}`);
  assert.ok(body.endsWith('…'));
});
