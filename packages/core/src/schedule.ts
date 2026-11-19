/**
 * Deterministic study-schedule allocation. No model involved.
 *
 * Shape of a plan for N days:
 *   [ learning days ... ][ review days ... ][ final day ]
 *
 * - Learning days take every question exactly once, sorted so higher-priority
 *   and harder material comes first, split into contiguous chunks of roughly
 *   equal minutes. How many learning days are used depends on the total load
 *   (target ~TARGET_DAILY_MINUTES a day), so a 60-day horizon doesn't spread
 *   15 questions thinly over 60 days.
 * - Review days cycle back through questions, must-haves first, at a third of
 *   the original time. These only exist when there's slack.
 * - The final day (N >= 3) rehearses one question per must-have requirement,
 *   so the last day is review, never new hard material.
 *
 * Invariants (tested): exactly N days, numbered 1..N; integer minutes; every
 * question appears; every must-have requirement appears on some day.
 */
import type { Question, Requirement, Schedule, ScheduleDay } from './schema.js';

export const TARGET_DAILY_MINUTES = 90;
/** Above this, a single day's question time is compressed (1-day cram case). */
export const MAX_DAILY_MINUTES = 240;
export const MIN_MINUTES_PER_QUESTION = 5;
const REVIEW_BATCH_MIN = 3;
const REVIEW_BATCH_MAX = 6;

const CATEGORY_LABEL: Record<Question['category'], string> = {
  technical: 'Technical',
  behavioural: 'Behavioural',
  'system-design': 'System design',
  'company-fit': 'Company fit',
};

/** Estimated minutes to prepare one question properly. */
export function estimateMinutes(q: Question): number {
  const base = q.difficulty === 3 ? 30 : q.difficulty === 2 ? 20 : 10;
  return q.category === 'system-design' ? base + 15 : base;
}

function reviewMinutes(q: Question): number {
  return Math.max(MIN_MINUTES_PER_QUESTION, Math.ceil(estimateMinutes(q) / 3));
}

/** 2 = covers a must-have, 1 = only nice-to-haves, 0 = no requirement. */
export function priorityScore(q: Question, reqById: Map<string, Requirement>): number {
  let s = 0;
  for (const rid of q.requirement_ids) {
    const r = reqById.get(rid);
    if (r) s = Math.max(s, r.priority === 'must' ? 2 : 1);
  }
  return s;
}

/** Priority desc, difficulty desc, then original order (stable). */
export function orderForStudy(questions: Question[], requirements: Requirement[]): Question[] {
  const reqById = new Map(requirements.map((r) => [r.id, r]));
  return questions
    .map((q, i) => ({ q, i, p: priorityScore(q, reqById) }))
    .sort((a, b) => b.p - a.p || b.q.difficulty - a.q.difficulty || a.i - b.i)
    .map((x) => x.q);
}

/**
 * Split items (order preserved) into exactly `parts` non-empty contiguous
 * chunks with roughly equal weight. Requires items.length >= parts.
 */
export function partitionByWeight<T>(items: T[], parts: number, weight: (t: T) => number): T[][] {
  const chunks: T[][] = [];
  let i = 0;
  let remaining = items.reduce((s, t) => s + weight(t), 0);
  for (let c = 0; c < parts; c++) {
    const chunksLeft = parts - c;
    const target = remaining / chunksLeft;
    const chunk: T[] = [];
    let w = 0;
    // Leave at least one item for each later chunk.
    while (i < items.length && items.length - i > chunksLeft - 1) {
      const next = weight(items[i]!);
      // Stop if adding the next item overshoots the target more than stopping undershoots it.
      if (chunk.length > 0 && c < parts - 1 && w + next - target > target - w) break;
      chunk.push(items[i]!);
      w += next;
      i++;
      if (c < parts - 1 && w >= target) break;
    }
    remaining -= w;
    chunks.push(chunk);
  }
  return chunks;
}

/** Pick a small set of questions that together touch every given requirement. */
function coverWithFewestQuestions(reqIds: string[], ordered: Question[]): Question[] {
  const need = new Set(reqIds);
  const picked: Question[] = [];
  while (need.size > 0) {
    let best: Question | undefined;
    let bestHits = 0;
    for (const q of ordered) {
      const hits = q.requirement_ids.filter((r) => need.has(r)).length;
      if (hits > bestHits) {
        best = q;
        bestHits = hits;
      }
    }
    if (!best) break; // remaining requirements have no question at all
    picked.push(best);
    best.requirement_ids.forEach((r) => need.delete(r));
  }
  return picked;
}

function shorten(s: string, n = 40): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

function describe(prefix: string, qs: Question[], reqById: Map<string, Requirement>): string {
  const cats = new Map<string, number>();
  qs.forEach((q) => cats.set(q.category, (cats.get(q.category) ?? 0) + 1));
  const topCats = [...cats.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([c]) => CATEGORY_LABEL[c as Question['category']]);
  const topics: string[] = [];
  for (const q of qs) {
    for (const rid of q.requirement_ids) {
      const t = reqById.get(rid)?.text;
      if (t && !topics.includes(shorten(t))) topics.push(shorten(t));
    }
  }
  const head = `${prefix}${topCats.join(' + ')}`;
  return topics.length ? `${head} — ${topics.slice(0, 3).join('; ')}` : head;
}

function reqIdsOf(qs: Question[]): string[] {
  return [...new Set(qs.flatMap((q) => q.requirement_ids))];
}

export interface BuildScheduleInput {
  days: number;
  requirements: Requirement[];
  questions: Question[];
}

export function buildSchedule({ days, requirements, questions }: BuildScheduleInput): Schedule {
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`days must be a positive integer, got ${days}`);

  const reqById = new Map(requirements.map((r) => [r.id, r]));
  const mustIds = requirements.filter((r) => r.priority === 'must').map((r) => r.id);
  const ordered = orderForStudy(questions, requirements);
  const out: ScheduleDay[] = [];

  if (ordered.length === 0) {
    // Nothing to study from — still return N honest days, and spread
    // requirements so each must-have is named somewhere.
    for (let d = 1; d <= days; d++) {
      out.push({
        day: d,
        focus: d === 1 ? 'Re-read the job description and draft your own examples for each requirement' : 'Self-directed practice on the role requirements',
        question_ids: [],
        minutes: 30,
        requirement_ids: d === 1 ? requirements.map((r) => r.id) : [],
      });
    }
    return { days_available: days, days: out };
  }

  const hasFinal = days >= 3;
  const learnSlots = hasFinal ? days - 1 : days;
  const totalMinutes = ordered.reduce((s, q) => s + estimateMinutes(q), 0);
  const learnDays = Math.max(1, Math.min(learnSlots, ordered.length, Math.ceil(totalMinutes / TARGET_DAILY_MINUTES)));
  const reviewDays = learnSlots - learnDays;

  // Learning days.
  for (const chunk of partitionByWeight(ordered, learnDays, estimateMinutes)) {
    const raw = chunk.reduce((s, q) => s + estimateMinutes(q), 0);
    const cap = Math.max(MAX_DAILY_MINUTES, MIN_MINUTES_PER_QUESTION * chunk.length);
    const compressed = raw > cap;
    out.push({
      day: out.length + 1,
      focus: describe(compressed ? 'Compressed: ' : '', chunk, reqById),
      question_ids: chunk.map((q) => q.id),
      minutes: Math.min(raw, cap),
      requirement_ids: reqIdsOf(chunk),
    });
  }

  // Review days: walk the study order in a cycle.
  if (reviewDays > 0) {
    const batch = Math.min(ordered.length, Math.max(REVIEW_BATCH_MIN, Math.min(REVIEW_BATCH_MAX, Math.ceil(ordered.length / reviewDays))));
    let cursor = 0;
    for (let r = 0; r < reviewDays; r++) {
      const chunk: Question[] = [];
      for (let k = 0; k < batch; k++) chunk.push(ordered[(cursor + k) % ordered.length]!);
      cursor = (cursor + batch) % ordered.length;
      out.push({
        day: out.length + 1,
        focus: describe('Review: ', chunk, reqById),
        question_ids: chunk.map((q) => q.id),
        minutes: chunk.reduce((s, q) => s + reviewMinutes(q), 0),
        requirement_ids: reqIdsOf(chunk),
      });
    }
  }

  if (hasFinal) {
    let finalQs = coverWithFewestQuestions(mustIds, ordered);
    if (finalQs.length === 0) finalQs = ordered.slice(0, REVIEW_BATCH_MAX);
    out.push({
      day: out.length + 1,
      focus: 'Final review: rehearse one answer per must-have requirement, out loud',
      question_ids: finalQs.map((q) => q.id),
      minutes: finalQs.reduce((s, q) => s + reviewMinutes(q), 0),
      requirement_ids: reqIdsOf(finalQs),
    });
  }

  // Must-haves with no question at all can't appear via question ids; name
  // them on day 1 so they are still scheduled rather than silently dropped.
  const scheduled = new Set(out.flatMap((d) => d.requirement_ids!));
  const orphanMust = mustIds.filter((id) => !scheduled.has(id));
  if (orphanMust.length > 0) {
    const first = out[0]!;
    first.requirement_ids = [...first.requirement_ids!, ...orphanMust];
    first.focus = `${first.focus} (+ self-study: ${orphanMust.map((id) => shorten(reqById.get(id)!.text, 30)).join('; ')})`;
    first.minutes += 20 * orphanMust.length;
  }

  return { days_available: days, days: out };
}
