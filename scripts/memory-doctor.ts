/**
 * 记忆体检：只读扫描海马体索引与文件层，找出"数据库和文件对不上"的地方。
 *
 * 默认什么也不改；`--fix` 才动手，且只做可逆/安全的修补：
 * - 孤儿回看记录 → 直接删（事件已经不在了，留着没有意义）
 * - 孤儿全文/归档文件 → 移到 logs/memory-doctor-trash/<时间戳>/，不删
 * - links 里的悬空边（指向不存在/已归档/自环/重复）→ 从出边里摘掉
 * - archived 不是 0/1、weight/salience 越界 → 就地修正
 *
 * 用法：
 *   npm run memory:doctor -- [--root=<数据根>] [--character=<id>] [--fix] [--json]
 * 数据根默认当前目录（和 config.yaml 的 data_root 一致）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Level = 'ok' | 'warn' | 'error';

interface Finding {
  level: Level;
  code: string;
  title: string;
  detail: string;
  fixed?: string;
}

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const hit = argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const root = path.resolve(option('root', process.cwd()));
const character = option('character', 'daughter-default');
const fix = flag('fix');
const asJson = flag('json');

const paths = {
  root,
  db: path.join(root, 'brain', 'hippocampus', 'index', 'memory.db'),
  fulltext: path.join(root, 'brain', 'hippocampus', 'fulltext', character),
  archive: path.join(root, 'archive'),
  starMap: path.join(root, 'star_map'),
  trash: path.join(root, 'logs', 'memory-doctor-trash'),
};

const findings: Finding[] = [];
const add = (level: Level, code: string, title: string, detail: string) => {
  findings.push({ level, code, title, detail });
};
const markFixed = (code: string, detail: string) => {
  const target = findings.find((item) => item.code === code);
  if (target) target.fixed = detail;
};

function listFiles(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => pattern.test(name));
  } catch {
    return [];
  }
}

function moveToTrash(file: string, stamp: string): string {
  const relative = path.relative(paths.root, file).replace(/[\\/]/g, '__');
  const target = path.join(paths.trash, stamp, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(file, target);
  return target;
}

interface EventRow {
  id: string;
  title: string;
  summary: string;
  tags: string;
  links: string;
  weight: number;
  importance: number;
  salience: number | null;
  recall_count: number;
  archived: number;
  created_at: string;
  last_recalled_at: string | null;
  merged_count: number;
}

function safeArray(text: string): Array<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}

function main(): void {
  if (!existsSync(paths.db)) {
    add('error', 'db-missing', '找不到记忆库', `${paths.db} 不存在。数据根或角色 ID 填错了？`);
    return;
  }

  const db = new DatabaseSync(paths.db, { readOnly: !fix });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  try {
    /* 1. 库本身 */
    const integrity = db.prepare('PRAGMA integrity_check').all() as unknown as Array<{ integrity_check: string }>;
    const integrityText = integrity.map((row) => row.integrity_check).join('; ');
    if (integrityText === 'ok') add('ok', 'db-integrity', 'SQLite 完整性', 'ok');
    else add('error', 'db-integrity', 'SQLite 完整性', integrityText);

    const sizeMb = (statSync(paths.db).size / 1024 / 1024).toFixed(2);
    const wal = existsSync(`${paths.db}-wal`) ? (statSync(`${paths.db}-wal`).size / 1024).toFixed(0) : '0';
    add('ok', 'db-size', '库大小', `${sizeMb} MB（WAL ${wal} KB）`);

    /* 2. 事件与回看 */
    const events = db
      .prepare('SELECT * FROM events WHERE character_id = ?')
      .all(character) as unknown as EventRow[];
    const archived = events.filter((event) => event.archived === 1).length;
    add('ok', 'events', '事件', `${events.length} 条（归档 ${archived} / 活跃 ${events.length - archived}）`);

    const orphanEmotions = db
      .prepare(
        `SELECT COUNT(*) AS n FROM emotion_history h
         WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = h.event_id)`,
      )
      .get() as unknown as { n: number };
    if (orphanEmotions.n > 0) {
      if (fix) {
        const removed = db
          .prepare('DELETE FROM emotion_history WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = event_id)')
          .run();
        add('warn', 'orphan-emotions', '孤儿回看记录', `${orphanEmotions.n} 条指向已不存在的事件`);
        markFixed('orphan-emotions', `已删除 ${Number(removed.changes ?? 0)} 条`);
      } else {
        add('warn', 'orphan-emotions', '孤儿回看记录', `${orphanEmotions.n} 条指向已不存在的事件（--fix 可清）`);
      }
    } else {
      add('ok', 'orphan-emotions', '孤儿回看记录', '无');
    }

    /* 2b. 参与者与来源一致性：单向来源不该挂 user */
    // 早期一律写 ['self','user']，于是刷到的视频也被算成"和用户一起做的事"，
    // 社交性恒为 1、显著性虚高、人物画像与 L2 亲密度一起歪。存量已由 migrate 修过一次，
    // 但外部写入（ingestExternalEvent 之外的手工数据）还会再犯，所以这里常驻检查。
    const wrongParticipants = db
      .prepare(
        `SELECT id, source, participants FROM events
          WHERE character_id = ?
            AND ((source IN ('douyin_content', 'system', 'android') AND participants LIKE '%user%')
              OR (source IN ('chat', 'qq', 'douyin_dm') AND participants NOT LIKE '%user%'))`,
      )
      .all(character) as unknown as Array<{ id: string; source: string; participants: string }>;
    if (wrongParticipants.length === 0) {
      add('ok', 'participants-source', '参与者与来源', '一致');
    } else {
      const sample = wrongParticipants
        .slice(0, 3)
        .map((row) => `${row.id}(${row.source})`)
        .join('、');
      add(
        'warn',
        'participants-source',
        '参与者与来源不一致',
        `${wrongParticipants.length} 条（例：${sample}）${fix ? '' : '，--fix 可修正'}`,
      );
      if (fix) {
        const stmt = db.prepare('UPDATE events SET participants = ? WHERE id = ?');
        let repaired = 0;
        for (const row of wrongParticipants) {
          const names = safeArray(row.participants)?.map(String) ?? ['self'];
          const dialogue = row.source === 'chat' || row.source === 'qq' || row.source === 'douyin_dm';
          const next = dialogue
            ? [...new Set(['self', ...names.filter((name) => name !== 'user'), 'user'])]
            : names.filter((name) => name !== 'user');
          if (next.length === 0) next.push('self');
          stmt.run(JSON.stringify(next), row.id);
          repaired += 1;
        }
        markFixed('participants-source', `已修正 ${repaired} 条`);
      }
    }

    /* 2c. 演化日志 ID 唯一性：早期随机后缀在 Store 重建时会重放，同一天最早的几条必撞 */
    // 随机后缀时代（createRng 抽 4 位 hex）写到这一条为止，之后改走「当天最大号 + 1」。
    // 分界之前的撞号是既有历史，按设计不重写（日志只追加，按行序 + at 区分），只说明不告警；
    // 分界之后还撞号，说明写入侧退回了随机或重号，必须 warn——历史噪声不能盖住回归信号。
    const RANDOM_SUFFIX_ERA_END = '2026-11-06T14:32:08.917Z';
    const evolutionFile = path.join(paths.root, 'logs', 'evolution', `${character}.jsonl`);
    if (!existsSync(evolutionFile)) {
      add('ok', 'evolution-ids', '演化日志 ID', '还没有演化日志');
    } else {
      const atById = new Map<string, string[]>();
      let unreadable = 0;
      let total = 0;
      for (const line of readFileSync(evolutionFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        total += 1;
        let id = '';
        let at = '';
        try {
          const entry = JSON.parse(line) as { id?: unknown; at?: unknown };
          id = String(entry.id ?? '');
          at = String(entry.at ?? '');
        } catch {
          unreadable += 1;
          continue;
        }
        if (!id) continue;
        atById.set(id, [...(atById.get(id) ?? []), at]);
      }
      const collisions = [...atById.entries()].filter(([, ats]) => ats.length > 1);
      // ISO 串可直接比较；at 缺失的条目算「新写入」，宁可报出来也不静默归入历史
      const isHistorical = (ats: string[]) => ats.every((at) => at !== '' && at <= RANDOM_SUFFIX_ERA_END);
      const regressions = collisions.filter(([, ats]) => !isHistorical(ats));
      const historical = collisions.filter(([, ats]) => isHistorical(ats));
      const sample = (groups: Array<[string, string[]]>) =>
        groups
          .slice(0, 3)
          .map(([id, ats]) => `${id}×${ats.length}`)
          .join('、');
      if (regressions.length > 0) {
        add(
          'warn',
          'evolution-ids',
          '演化日志 ID 撞号',
          `${total} 条只有 ${atById.size} 个唯一 ID，新写入段重复 ${regressions.length} 组（例：${sample(
            regressions,
          )}）。查重不改写——日志只追加，历史按行序 + at 区分`,
        );
      } else if (unreadable > 0) {
        add('warn', 'evolution-ids', '演化日志有坏行', `${unreadable} 行解析失败（共 ${total} 行）`);
      } else if (historical.length > 0) {
        add(
          'ok',
          'evolution-ids',
          '演化日志 ID',
          `新写入无撞号；${historical.length} 组历史撞号（随机后缀时代：${sample(
            historical,
          )}，按行序 + at 区分，不重写）`,
        );
      } else {
        add('ok', 'evolution-ids', '演化日志 ID', `${atById.size} 条全部唯一`);
      }
    }

    /* 3. FTS 索引 */
    let ftsRows = -1;
    try {
      ftsRows = (db.prepare('SELECT COUNT(*) AS n FROM events_fts').get() as unknown as { n: number }).n;
    } catch (error) {
      add('error', 'fts-missing', 'FTS 索引', `events_fts 不可用：${String(error)}`);
    }
    if (ftsRows >= 0) {
      // 注意：外部内容表的 COUNT(*) 与 integrity-check 读的都是 events 本身，
      // 索引被清空也照样报"正常"。唯一可靠的探针是拿真实标题真查一次。
      const sample = events.find((event) => [...event.title].length >= 4);
      if (!sample) {
        add('ok', 'fts-probe', 'FTS 索引', `暂无可抽检事件（索引 ${ftsRows} 行）`);
      } else {
        const probe = [...sample.title].slice(0, 3).join('').replace(/["*()]/g, ' ');
        try {
          const hit = db
            .prepare('SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH ?')
            .get(`"${probe}"`) as unknown as { n: number };
          if (hit.n > 0) {
            add('ok', 'fts-probe', 'FTS 抽检', `「${probe}」命中 ${hit.n} 条`);
          } else {
            add('warn', 'fts-probe', 'FTS 索引查不到已有事件', `「${probe}」应命中 ${sample.id} 但查不到，索引需要 rebuild`);
            if (fix) {
              db.exec("INSERT INTO events_fts(events_fts) VALUES ('rebuild')");
              const again = db
                .prepare('SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH ?')
                .get(`"${probe}"`) as unknown as { n: number };
              markFixed('fts-probe', again.n > 0 ? `已 rebuild（命中 ${again.n} 条）` : '已 rebuild，但抽检仍未命中');
            }
          }
        } catch (error) {
          add('warn', 'fts-probe', 'FTS 抽检报错', String(error));
        }
      }
    }

    /* 4. 文件层：全文与归档 */
    const textFiles = new Set(listFiles(paths.fulltext, /\.txt$/i));
    const expected = new Set(events.map((event) => `${event.id}.txt`));
    const missingText = [...expected].filter((name) => !textFiles.has(name));
    const orphanText = [...textFiles].filter((name) => !expected.has(name));

    if (missingText.length > 0) {
      add('warn', 'fulltext-missing', '全文文件缺失', `${missingText.length} 条事件有索引没有全文（例：${missingText.slice(0, 3).join('、')}）`);
      if (fix) {
        const stmt = db.prepare('UPDATE events SET summary = summary WHERE id = ?');
        let rebuilt = 0;
        for (const name of missingText) {
          const id = name.replace(/\.txt$/i, '');
          const row = events.find((event) => event.id === id);
          if (!row) continue;
          mkdirSync(paths.fulltext, { recursive: true });
          // 用摘要补一份最小全文，保证"索引里的事件一定能读到正文"
          writeFileSync(path.join(paths.fulltext, name), row.summary, 'utf8');
          stmt.run(id);
          rebuilt += 1;
        }
        markFixed('fulltext-missing', `已用摘要补写 ${rebuilt} 份`);
      }
    } else {
      add('ok', 'fulltext-missing', '全文文件', `齐全（${textFiles.size} 份）`);
    }

    if (orphanText.length > 0) {
      if (fix) {
        for (const name of orphanText) moveToTrash(path.join(paths.fulltext, name), stamp);
        add('warn', 'fulltext-orphan', '孤儿全文文件', `${orphanText.length} 份没有对应事件`);
        markFixed('fulltext-orphan', `已移入 ${paths.trash}`);
      } else {
        add('warn', 'fulltext-orphan', '孤儿全文文件', `${orphanText.length} 份没有对应事件（--fix 移入垃圾桶）`);
      }
    } else {
      add('ok', 'fulltext-orphan', '孤儿全文文件', '无');
    }

    const archiveFiles = listFiles(paths.archive, /\.json$/i);
    const archiveIds = new Set(events.map((event) => `${event.id}.json`));
    const orphanArchive = archiveFiles.filter((name) => !archiveIds.has(name));
    if (orphanArchive.length > 0) {
      if (fix) {
        for (const name of orphanArchive) moveToTrash(path.join(paths.archive, name), stamp);
        add('warn', 'archive-orphan', '孤儿归档文件', `${orphanArchive.length} 份没有对应事件`);
        markFixed('archive-orphan', `已移入 ${paths.trash}`);
      } else {
        add('warn', 'archive-orphan', '孤儿归档文件', `${orphanArchive.length} 份没有对应事件（--fix 移入垃圾桶）`);
      }
    } else {
      add('ok', 'archive-orphan', '归档文件', `无孤儿（共 ${archiveFiles.length} 份）`);
    }

    /* 5. 字段边界 */
    const badWeight = events.filter((event) => !(event.weight >= 0 && event.weight <= 1));
    const badImportance = events.filter((event) => !(event.importance >= 0 && event.importance <= 1));
    const badSalience = events.filter((event) => event.salience !== null && !(event.salience >= 0 && event.salience <= 1));
    const badArchived = events.filter((event) => event.archived !== 0 && event.archived !== 1);
    const badRecall = events.filter((event) => !Number.isInteger(event.recall_count) || event.recall_count < 0);
    const badTime = events.filter((event) => !Number.isFinite(Date.parse(event.created_at)));

    const boundary = badWeight.length + badImportance.length + badSalience.length + badArchived.length + badRecall.length + badTime.length;
    if (boundary === 0) {
      add('ok', 'boundary', '字段边界', '权重/重要性/显著性/归档标记/计数/时间戳都在合理范围');
    } else {
      add(
        'error',
        'boundary',
        '字段越界',
        `权重 ${badWeight.length}、重要性 ${badImportance.length}、显著性 ${badSalience.length}、归档标记 ${badArchived.length}、回看计数 ${badRecall.length}、时间戳 ${badTime.length}`,
      );
      if (fix) {
        const clampStmt = db.prepare('UPDATE events SET weight = ?, salience = ? WHERE id = ?');
        for (const event of events) {
          const weight = Number.isFinite(event.weight) ? Math.min(1, Math.max(0, event.weight)) : 0;
          const salience = event.salience === null
            ? null
            : Number.isFinite(event.salience) ? Math.min(1, Math.max(0, event.salience)) : null;
          if (weight !== event.weight || salience !== event.salience) clampStmt.run(weight, salience, event.id);
        }
        const archStmt = db.prepare('UPDATE events SET archived = ? WHERE id = ?');
        for (const event of badArchived) archStmt.run(event.archived === 1 ? 1 : 0, event.id);
        markFixed('boundary', '已把越界值夹回 0..1，归档标记归一为 0/1');
      }
    }

    /* 6. 链接完整性 */
    const byId = new Map(events.map((event) => [event.id, event]));
    let badJson = 0;
    let dangling = 0;
    let toArchived = 0;
    let selfLoop = 0;
    let duplicate = 0;
    let overCap = 0;
    const repairs: Array<{ id: string; links: Array<Record<string, unknown>> }> = [];

    for (const event of events) {
      const links = safeArray(event.links);
      if (links === null) {
        badJson += 1;
        repairs.push({ id: event.id, links: [] });
        continue;
      }
      const seen = new Set<string>();
      const kept: Array<Record<string, unknown>> = [];
      let touched = false;
      for (const link of links) {
        const targetId = typeof link.targetId === 'string' ? link.targetId : '';
        if (!targetId) { touched = true; continue; }
        if (targetId === event.id) { selfLoop += 1; touched = true; continue; }
        if (seen.has(targetId)) { duplicate += 1; touched = true; continue; }
        const target = byId.get(targetId);
        if (!target) { dangling += 1; touched = true; continue; }
        if (target.archived === 1) { toArchived += 1; touched = true; continue; }
        seen.add(targetId);
        kept.push(link);
      }
      if (kept.length > 12) { overCap += 1; touched = true; kept.length = 12; }
      if (touched) repairs.push({ id: event.id, links: kept });
    }

    const linkProblems = badJson + dangling + toArchived + selfLoop + duplicate + overCap;
    if (linkProblems === 0) {
      add('ok', 'links', '链接完整性', '没有悬空边、自环或重复出边');
    } else {
      add(
        'warn',
        'links',
        '链接有问题',
        `坏 JSON ${badJson}、悬空 ${dangling}、指向已归档 ${toArchived}、自环 ${selfLoop}、重复 ${duplicate}、超上限 ${overCap}`,
      );
      if (fix) {
        const stmt = db.prepare('UPDATE events SET links = ? WHERE id = ?');
        for (const repair of repairs) stmt.run(JSON.stringify(repair.links), repair.id);
        markFixed('links', `已修剪 ${repairs.length} 条事件的出边`);
      }
    }

    /* 7. 星图 */
    const starFile = path.join(paths.starMap, `${character}.json`);
    if (!existsSync(starFile)) {
      add('warn', 'starmap', '星图产物', '还没有生成过（下次 tick 会写）');
    } else {
      try {
        const payload = JSON.parse(readFileSync(starFile, 'utf8')) as { nodes?: Array<{ id?: string }>; edges?: Array<{ from?: string; to?: string }> };
        const nodeIds = new Set((payload.nodes ?? []).map((node) => String(node.id ?? '')));
        const ghost = (payload.edges ?? []).filter((edge) => !nodeIds.has(String(edge.from)) || !nodeIds.has(String(edge.to)));
        if (ghost.length === 0) add('ok', 'starmap', '星图产物', `${nodeIds.size} 节点 / ${(payload.edges ?? []).length} 边，引用一致`);
        else add('warn', 'starmap', '星图有悬空边', `${ghost.length} 条边指向不存在的节点（下次 tick 重建即修）`);
      } catch (error) {
        add('warn', 'starmap', '星图解析失败', String(error));
      }
    }

    /* 8. meta 一览 */
    const metaRows = db.prepare('SELECT key FROM meta').all() as unknown as Array<{ key: string }>;
    add('ok', 'meta', 'meta 键', `${metaRows.length} 个：${metaRows.slice(0, 8).map((row) => row.key).join('、')}${metaRows.length > 8 ? '…' : ''}`);
  } finally {
    db.close();
  }
}

main();

/* ------------------------------ 输出 ------------------------------ */

const order: Record<Level, number> = { error: 0, warn: 1, ok: 2 };
findings.sort((a, b) => order[a.level] - order[b.level]);

if (asJson) {
  console.log(JSON.stringify({ root, character, fix, findings }, null, 2));
} else {
  console.log(`记忆体检：${paths.root}（角色 ${character}${fix ? '，已允许修复' : '，只读'}）`);
  console.log('');
  for (const finding of findings) {
    const badge = finding.level === 'ok' ? '[OK]' : finding.level === 'warn' ? '[!!]' : '[XX]';
    console.log(`${badge} ${finding.title}：${finding.detail}`);
    if (finding.fixed) console.log(`     → ${finding.fixed}`);
  }
  const errors = findings.filter((item) => item.level === 'error').length;
  const warns = findings.filter((item) => item.level === 'warn').length;
  const fixed = findings.filter((item) => item.fixed).length;
  const unfixed = findings.filter((item) => item.level !== 'ok' && !item.fixed).length;
  console.log('');
  console.log(`合计：错误 ${errors}、警告 ${warns}${fixed > 0 ? `、已修 ${fixed}` : ''}、待处理 ${unfixed}`);
  if (unfixed > 0 && !fix) console.log('加 --fix 可以修掉可安全修复的那几项。');
}
if (findings.some((item) => item.level === 'error')) process.exitCode = 1;
