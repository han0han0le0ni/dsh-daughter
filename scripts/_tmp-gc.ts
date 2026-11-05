import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('brain/hippocampus/index/memory.db', { readOnly: true });

console.log('按来源:', db.prepare('SELECT source, COUNT(*) c FROM events WHERE archived = 0 GROUP BY source ORDER BY c DESC').all());
console.log(
  '低价值（显著性<0.25）:',
  db.prepare('SELECT COUNT(*) c FROM events WHERE archived = 0 AND salience < 0.25').get(),
);
console.log(
  '前台切换类:',
  db.prepare("SELECT COUNT(*) c FROM events WHERE archived = 0 AND (title LIKE '%前台切换%' OR title LIKE '%切到了%')").get(),
);
console.log(
  '标题分布 top8:',
  db.prepare('SELECT substr(title, 1, 18) t, COUNT(*) c FROM events WHERE archived = 0 GROUP BY t ORDER BY c DESC LIMIT 8').all(),
);
console.log(
  '事件链接指向活跃事件的比例:',
  db.prepare('SELECT COUNT(*) c FROM events WHERE archived = 0').get(),
);
db.close();
