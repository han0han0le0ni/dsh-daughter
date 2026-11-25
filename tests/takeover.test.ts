import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyPersonaTakeover,
  composePersonaCard,
  planPersonaTakeover,
  readPersonaSnapshot,
  resolveDouyinPersonaCard,
  revertPersonaTakeover,
  sha256,
} from '../src/runtime/takeover.js';

const NOW = '2026-11-25T12:00:00.000Z';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-takeover-'));
}

function seedBrain(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'l1_baseline.yaml'),
    [
      'bigFive:',
      '  openness: 0.8612',
      '  neuroticism: 0.8491',
      'temperament: guarded',
      'moodBaseline:',
      '  pleasure: 0.1012',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'l2_relationship.yaml'),
    ['attachmentAnxiety: 0.8264', 'attachmentAvoidance: 0.34', 'attachmentType: anxious', 'relationshipStage: close', 'relationshipDepth: 0.8161', 'coreNeeds:', '  - 稳定回应'].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'l3_cognition.yaml'),
    ['moral:', '  stance: 先善意假设，再守住底线', '  redLines:', '    - 不伤害自己与他人', 'copingStrategies:', '  - trigger: 被忽视', '    response: 先沉默'].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'l4_subpersonas.yaml'),
    ['subPersonas:', '  - id: to_stranger', '    tone: 克制、客气', '    disclosureLevel: 0.2', '    boundaries:', '      - 私人往事'].join('\n'),
  );
}

test('人格快照：只抽接管要用的字段并做两位取整', () => {
  const dir = tempDir();
  seedBrain(dir);
  const snapshot = readPersonaSnapshot(dir);

  assert.equal(snapshot.bigFive.openness, 0.86);
  assert.equal(snapshot.attachment.anxiety, 0.83);
  assert.equal(snapshot.relationship.stage, 'close');
  assert.deepEqual(snapshot.moral.redLines, ['不伤害自己与他人']);
  assert.equal(snapshot.subPersonas[0]?.id, 'to_stranger');
});

test('人格卡：身份、底线与对外口径都在，且不授予权限', () => {
  const dir = tempDir();
  seedBrain(dir);
  const card = composePersonaCard(readPersonaSnapshot(dir), { now: NOW, source: 'test' });

  assert.match(card, /^# 她的人格卡/);
  assert.match(card, /不授予工具权限/);
  assert.match(card, /## 对外人/);
  assert.match(card, /克制、客气/);
  assert.match(card, /不伤害自己与他人/);
});

test('计划：目标不存在时记为新建，没有快照路径', () => {
  const dir = tempDir();
  const target = path.join(dir, 'memory', 'persona', 'role-card.md');
  const plan = planPersonaTakeover({ target, content: '卡', backupDir: path.join(dir, 'backups'), now: NOW });

  assert.equal(plan.existed, false);
  assert.equal(plan.backupFile, null);
  assert.equal(fs.existsSync(target), false);
});

test('接管后还原：原来没有文件就删掉新建的卡', () => {
  const dir = tempDir();
  const target = path.join(dir, 'memory', 'persona', 'role-card.md');
  const plan = planPersonaTakeover({ target, content: '新卡', backupDir: path.join(dir, 'backups'), now: NOW });
  const record = applyPersonaTakeover(plan);

  assert.equal(fs.readFileSync(target, 'utf8'), '新卡');
  assert.equal(record.sha256, sha256('新卡'));
  assert.equal(revertPersonaTakeover(record), 'removed');
  assert.equal(fs.existsSync(target), false);
});

test('接管后还原：原有文件先快照再写回', () => {
  const dir = tempDir();
  const target = path.join(dir, 'role-card.md');
  fs.writeFileSync(target, '原卡', 'utf8');
  const plan = planPersonaTakeover({ target, content: '新卡', backupDir: path.join(dir, 'backups'), now: NOW });
  const record = applyPersonaTakeover(plan);

  assert.equal(plan.existed, true);
  assert.equal(fs.readFileSync(plan.backupFile as string, 'utf8'), '原卡');
  assert.equal(fs.readFileSync(target, 'utf8'), '新卡');
  assert.equal(revertPersonaTakeover(record), 'restored');
  assert.equal(fs.readFileSync(target, 'utf8'), '原卡');
});

test('抖音人格卡位置：默认目录，或按插件自己记录的位置', () => {
  const home = tempDir();
  assert.equal(resolveDouyinPersonaCard(home), path.join(home, '.dsh', 'douyin-browser', 'memory', 'persona', 'role-card.md'));

  const custom = path.join(home, 'elsewhere', 'memory');
  fs.mkdirSync(path.join(home, '.dsh', 'douyin-browser'), { recursive: true });
  fs.writeFileSync(path.join(home, '.dsh', 'douyin-browser', 'runtime-location.json'), JSON.stringify({ memoryDir: custom }));
  assert.equal(resolveDouyinPersonaCard(home), path.join(custom, 'persona', 'role-card.md'));
});
