/**
 * Practice scheduling: a small Leitner system driven by self-rated confidence.
 *
 * Why Leitner rather than SM-2: interview prep runs for days, not months, and
 * people rate themselves coarsely ("didn't know / shaky / solid"). Five boxes
 * with short intervals are easy to explain and to predict, and a card you
 * didn't know comes back in the *same* session.
 *
 *   confidence 1 (didn't know) -> box 0, due now (re-queued this session)
 *   confidence 2 (shaky)       -> box stays (min 1), due in BOX_INTERVAL
 *   confidence 3 (solid)       -> box + 1, due in BOX_INTERVAL
 *
 * Next-session order: due cards, least confident first (then most overdue);
 * then never-seen cards, cards for must-have requirements first; then
 * not-yet-due cards, soonest first.
 */
import { z } from 'zod';
import type { Flashcard, Requirement } from './schema.js';

export const Confidence = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Confidence = z.infer<typeof Confidence>;

export const CardProgressSchema = z.object({
  box: z.number().int().min(0).max(4),
  reviews: z.number().int().min(0),
  lastConfidence: Confidence,
  lastReviewedAt: z.string(),
  dueAt: z.string(),
});
export type CardProgress = z.infer<typeof CardProgressSchema>;

const HOUR = 3_600_000;
/** Interval after landing in each box. Short: prep horizons are days. */
export const BOX_INTERVAL_MS = [0, 12 * HOUR, 24 * HOUR, 48 * HOUR, 96 * HOUR];

export function recordReview(prev: CardProgress | undefined, confidence: Confidence, now: Date): CardProgress {
  const box = confidence === 1 ? 0 : confidence === 2 ? Math.max(1, prev?.box ?? 1) : Math.min(4, (prev?.box ?? 0) + 1);
  return {
    box,
    reviews: (prev?.reviews ?? 0) + 1,
    lastConfidence: confidence,
    lastReviewedAt: now.toISOString(),
    dueAt: new Date(now.getTime() + BOX_INTERVAL_MS[box]!).toISOString(),
  };
}

export function orderSession(
  cards: Flashcard[],
  progress: Record<string, CardProgress | undefined>,
  requirements: Requirement[],
  now: Date,
): string[] {
  const must = new Set(requirements.filter((r) => r.priority === 'must').map((r) => r.id));
  const t = now.getTime();
  const due: Flashcard[] = [];
  const unseen: Flashcard[] = [];
  const later: Flashcard[] = [];
  for (const c of cards) {
    const p = progress[c.id];
    if (!p) unseen.push(c);
    else if (Date.parse(p.dueAt) <= t) due.push(c);
    else later.push(c);
  }
  const pr = (c: Flashcard) => progress[c.id]!;
  due.sort((a, b) => pr(a).lastConfidence - pr(b).lastConfidence || Date.parse(pr(a).dueAt) - Date.parse(pr(b).dueAt));
  const isMust = (c: Flashcard) => (c.requirement_ids.some((r) => must.has(r)) ? 0 : 1);
  unseen.sort((a, b) => isMust(a) - isMust(b)); // stable: keeps kit order within groups
  later.sort((a, b) => Date.parse(pr(a).dueAt) - Date.parse(pr(b).dueAt));
  return [...due, ...unseen, ...later].map((c) => c.id);
}

export interface PracticeSummary {
  total: number;
  seen: number;
  unseen: number;
  byConfidence: Record<Confidence, number>;
  due: number;
  /** Requirements with at least one card rated 3 most recently. */
  requirementsSolid: string[];
  /** Requirements with cards, none of which have been practised. */
  requirementsUntouched: string[];
}

export function summarisePractice(cards: Flashcard[], progress: Record<string, CardProgress | undefined>, now: Date): PracticeSummary {
  const byConfidence: Record<Confidence, number> = { 1: 0, 2: 0, 3: 0 };
  let seen = 0;
  let due = 0;
  const solid = new Set<string>();
  const touched = new Set<string>();
  const withCards = new Set<string>();
  for (const c of cards) {
    c.requirement_ids.forEach((r) => withCards.add(r));
    const p = progress[c.id];
    if (!p) continue;
    seen += 1;
    byConfidence[p.lastConfidence] += 1;
    if (Date.parse(p.dueAt) <= now.getTime()) due += 1;
    c.requirement_ids.forEach((r) => {
      touched.add(r);
      if (p.lastConfidence === 3) solid.add(r);
    });
  }
  return {
    total: cards.length,
    seen,
    unseen: cards.length - seen,
    byConfidence,
    due,
    requirementsSolid: [...solid],
    requirementsUntouched: [...withCards].filter((r) => !touched.has(r)),
  };
}
