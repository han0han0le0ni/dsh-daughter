import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultConfig } from '../src/config.js';
import { activateSkills } from '../src/runtime/content.js';
import {
  bumpSkill,
  learnDraftSkill,
  observeShadow,
  parseSkillProposalCommand,
  reviewSkillProposal,
} from '../src/runtime/maintenance.js';
import { buildStarPanels } from '../src/runtime/panels.js';
import { Store } from '../src/store.js';

const NOW = '2026-11-25T12:00:00.000Z';

function makeConfig() {
  const config = structuredClone(defaultConfig);
  config.skills.min_steps_to_learn = 2;
  config.skills.shadow.enabled = true;
  config.skills.shadow.min_samples = 2;
  config.skills.shadow.win_rate = 0.75;
  config.skills.shadow.margin = 0.2;
  return config;
}

function withStore(run: (store: Store) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skill-proposal-'));
  const store = new Store(root, 'daughter-default', 42, undefined, { lock: false });
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function propose(store: Store) {
  const learned = learnDraftSkill(store, makeConfig(), {
    userText: '帮我查资料并总结成文件',
    tools: ['search', 'write_file'],
    now: NOW,
    proposal: true,
  });
  assert.ok(learned);
  return learned.skill;
}

test('主动学习先形成待确认提案：不参与激活，重复序列不重复提议', () => {
  withStore((store) => {
    const config = makeConfig();
    const skill = propose(store);
    assert.equal(skill.approval, 'pending');
    assert.equal(skill.status, 'draft');
    assert.equal(activateSkills([skill], '帮我查资料并总结成文件', config).breakdown.length, 0);
    assert.equal(
      learnDraftSkill(store, config, { userText: '再做一次', tools: ['search', 'write_file'], now: NOW, proposal: true }),
      null,
    );

    const panel = buildStarPanels(store, NOW, { nodes: 0, edges: 0, galaxies: 0 }).runtime.find((group) => group.id === 'program');
    assert.equal(panel?.params.find((item) => item.key === `skill.${skill.id}.approval`)?.value, '待主人确认');
    assert.equal(panel?.params.find((item) => item.key === `skill.${skill.id}.review`)?.value, `确认学习 ${skill.id}`);
  });
});

test('确认后进入影子试用：首次成功不直接转正，达标样本才 active', () => {
  withStore((store) => {
    const config = makeConfig();
    const proposed = propose(store);
    const reviewed = reviewSkillProposal(store, proposed.id, true, NOW);
    assert.equal(reviewed.changed, true);
    assert.equal(reviewed.skill?.approval, 'approved');
    assert.equal(reviewed.skill?.trialOnly, true);
    assert.equal(reviewed.skill?.status, 'draft');
    assert.equal(activateSkills([reviewed.skill!], '帮我查资料并总结成文件', config).breakdown.length, 1, '已确认草稿可以参与激活');

    const first = bumpSkill(store, reviewed.skill!, true, config, NOW);
    assert.equal(first.status, 'draft', '试用期首次成功不能直接转正');
    const firstObserved = observeShadow(store, first, ['search', 'write_file'], config, NOW);
    assert.equal(firstObserved.promoted, false);

    const second = bumpSkill(store, firstObserved.skill, true, config, NOW);
    const secondObserved = observeShadow(store, second, ['search', 'write_file'], config, NOW);
    assert.equal(secondObserved.promoted, true);
    assert.equal(secondObserved.skill.status, 'active');
    assert.equal(secondObserved.skill.trialOnly, undefined);
    assert.equal(secondObserved.skill.shadow, undefined);
    assert.ok(secondObserved.skill.previous, '转正前保留旧版快照');
  });
});

test('影子试用胜率不足就继续观察，不靠激活自证成功', () => {
  withStore((store) => {
    const config = makeConfig();
    const proposed = propose(store);
    const approved = reviewSkillProposal(store, proposed.id, true, NOW).skill!;
    const first = bumpSkill(store, approved, true, config, NOW);
    const firstObserved = observeShadow(store, first, ['search', 'write_file'], config, NOW);
    const second = bumpSkill(store, firstObserved.skill, false, config, NOW);
    const secondObserved = observeShadow(store, second, ['search'], config, NOW);

    assert.equal(secondObserved.recorded, true);
    assert.equal(secondObserved.promoted, false);
    assert.equal(secondObserved.skill.status, 'draft');
    assert.equal(secondObserved.skill.shadow?.success, 1);
    assert.equal(secondObserved.skill.shadow?.fail, 1);
    assert.equal(observeShadow(store, secondObserved.skill, [], config, NOW).recorded, false);
  });
});

test('相同工具集合的顺序变体不重复生成，编号缺口不会覆盖现存技能', () => {
  let template!: ReturnType<typeof propose>;
  withStore((store) => {
    const config = makeConfig();
    template = propose(store);
    assert.equal(
      learnDraftSkill(store, config, {
        userText: '换成先写文件再查资料',
        tools: ['write_file', 'search'],
        now: NOW,
        proposal: true,
      }),
      null,
      '相同工具集合只换顺序仍是同一个技能',
    );
  });

  withStore((store) => {
    store.saveSkill({
      ...template,
      id: 'SKL-search-write-file-002',
      name: '另一张现存技能',
      requiredTools: ['other_tool'],
      steps: [{ order: 1, description: '调用 other_tool', tool: 'other_tool', onFailure: 'continue' }],
      approval: undefined,
    });
    const learned = learnDraftSkill(store, makeConfig(), {
      userText: '查资料并写文件',
      tools: ['search', 'write_file'],
      now: NOW,
      proposal: true,
    });
    assert.ok(learned);
    assert.equal(learned.skill.id, 'SKL-search-write-file-001');
    assert.equal(store.loadSkill('SKL-search-write-file-002')?.name, '另一张现存技能');
  });
});

test('删除只移除当前角色选中的技能卡，不接受路径穿越或其他角色', () => {
  withStore((store) => {
    const selected = propose(store);
    const other = learnDraftSkill(store, makeConfig(), {
      userText: '打开面板再截图',
      tools: ['open_panel', 'screenshot'],
      now: NOW,
      proposal: true,
    })!.skill;
    store.saveSkill({ ...other, id: 'SKL-foreign-001', characterId: 'another-character' });

    assert.equal(store.deleteSkill('../SKL-outside'), false);
    assert.equal(store.deleteSkill('SKL-foreign-001'), false);
    assert.ok(store.loadSkill('SKL-foreign-001'), '其他角色的卡不能被删掉');

    assert.equal(store.deleteSkill(selected.id), true);
    assert.equal(store.loadSkill(selected.id), null);
    assert.ok(store.loadSkill(other.id), '未勾选技能保留');
    assert.equal(store.deleteSkill(selected.id), false, '重复删除返回未找到');
  });
});

test('星图提供技能勾选、二次确认与删除接口', () => {
  const html = readFileSync(join(process.cwd(), 'web', 'star-map', 'index.html'), 'utf8');
  assert.match(html, /data-skill-id/);
  assert.match(html, /delete-skills/);
  assert.match(html, /window\.confirm/);
  assert.match(html, /\/skills\/delete/);
  assert.match(html, /wireSkillDeletion\(body\)/);
});

test('拒绝提案会停用；口令必须完整，普通聊天里的同意不授权', () => {
  withStore((store) => {
    const skill = propose(store);
    assert.deepEqual(parseSkillProposalCommand(`确认学习 ${skill.id}`), { skillId: skill.id, approve: true });
    assert.deepEqual(parseSkillProposalCommand(`拒绝技能 ${skill.id}`), { skillId: skill.id, approve: false });
    assert.equal(parseSkillProposalCommand('我同意你学这个'), null);

    const rejected = reviewSkillProposal(store, skill.id, false, NOW);
    assert.equal(rejected.changed, true);
    assert.equal(rejected.skill?.approval, 'rejected');
    assert.equal(rejected.skill?.status, 'deprecated');
    assert.equal(reviewSkillProposal(store, skill.id, true, NOW).changed, false, '已拒绝不能再次被确认');
  });
});
