/**
 * 从旧记忆里补名字。
 *
 * 背景：角色卡是后来才加的，之前主人给过的名字只存在对话记忆里。
 * 这里用几条高精度句式从事件里捞候选，要求至少出现两次才认，
 * 宁可空着也不把「什么名字」这种问句当成名字。
 */
import { loadPersonaCard, savePersonaCard, type PersonaCard } from './persona-card.js';

export interface NameEvent {
  title: string;
  summary: string;
  createdAt: string;
  archived?: boolean;
}

const PATTERNS: RegExp[] = [
  /(?:起了?|取了?|起了个|取了个)名字[：:，,\s]*[「“"]?([\u4e00-\u9fa5A-Za-z]{2,6})/g,
  /名字(?:是|叫)[：:，,\s]*[「“"]?([\u4e00-\u9fa5A-Za-z]{2,6})/g,
  /(?:你叫|我叫|叫做)[：:，,\s]*[「“"]?([\u4e00-\u9fa5A-Za-z]{2,6})/g,
  /→\s*[「“"]?([\u4e00-\u9fa5]{2,6})[」”"]?[。，,\s]/g,
];

/** 问句和泛称不算名字 */
const BLOCK_WORDS = ['什么', '名字', '啥', '谁', '怎么', '为什么', '东西', '自己', '对方'];

const MIN_COUNT = 2;

function cleanCandidate(raw: string): string {
  const name = raw.replace(/[。，,、！!？?：:；;「」“”"'《》\s]/g, '').trim();
  if (name.length < 2 || name.length > 6) return '';
  if (BLOCK_WORDS.some((word) => name.includes(word))) return '';
  return name;
}

/** 返回出现次数最多且至少两次的候选；同票取最近出现的 */
export function inferNameFromEvents(events: NameEvent[]): string {
  const counts = new Map<string, { count: number; last: string }>();
  for (const event of events) {
    if (event.archived) continue;
    const text = `${event.title}\n${event.summary}`;
    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const name = cleanCandidate(match[1] ?? '');
        if (!name) continue;
        const entry = counts.get(name) ?? { count: 0, last: event.createdAt };
        entry.count += 1;
        if (event.createdAt > entry.last) entry.last = event.createdAt;
        counts.set(name, entry);
      }
    }
  }
  const ranked = [...counts.entries()]
    .filter(([, entry]) => entry.count >= MIN_COUNT)
    .sort((a, b) => b[1].count - a[1].count || (a[1].last < b[1].last ? 1 : -1));
  return ranked[0]?.[0] ?? '';
}

/**
 * 角色卡没有名字时，从记忆里补一个并落盘；已有名字就原样返回。
 * 调用方负责控制「只在没有名字时跑一次」，避免每轮扫全库。
 */
export function adoptNameFromMemory(dataRoot: string, events: NameEvent[]): PersonaCard {
  const card = loadPersonaCard(dataRoot);
  if (card.name) return card;
  const inferred = inferNameFromEvents(events);
  if (!inferred) return card;
  return savePersonaCard(dataRoot, { ...card, name: inferred });
}
