import { describe, expect, it } from 'vitest';
import { orderSession, recordReview, summarisePractice, type CardProgress } from '../src/practice.js';
import { sampleKit } from './kitFixture.js';

const now = new Date('2026-11-20T10:00:00Z');
const later = (h: number) => new Date(now.getTime() + h * 3_600_000);

describe('recordReview (Leitner)', () => {
  it('low confidence resets to box 0, due immediately', () => {
    const p = recordReview(undefined, 1, now);
    expect(p).toMatchObject({ box: 0, reviews: 1, dueAt: now.toISOString() });
  });
  it('high confidence promotes; medium holds', () => {
    const a = recordReview(undefined, 3, now);
    const b = recordReview(a, 3, later(1));
    expect(b.box).toBe(2);
    expect(recordReview(b, 2, later(2)).box).toBe(2);
    expect(recordReview(b, 1, later(2)).box).toBe(0);
    let p: CardProgress | undefined;
    for (let i = 0; i < 10; i++) p = recordReview(p, 3, now);
    expect(p!.box).toBe(4);
  });
});

describe('orderSession', () => {
  it('due least-confident first, then unseen must-haves, then not-yet-due', () => {
    const kit = sampleKit();
    const cards = [...kit.flashcards, { id: 'f3', front: 'C', back: '', requirement_ids: ['r2'] }, { id: 'f4', front: 'D', back: '', requirement_ids: [] }];
    const progress: Record<string, CardProgress> = {
      f1: recordReview(undefined, 2, later(-30)), // due (12h interval elapsed), confidence 2
      f4: recordReview(undefined, 1, later(-1)), // due, confidence 1
      f3: recordReview(undefined, 3, now), // not due yet
    };
    // f2 unseen (nice requirement r4)
    expect(orderSession(cards, progress, kit.role.requirements, now)).toEqual(['f4', 'f1', 'f2', 'f3']);
  });

  it('summarises what has and has not been covered', () => {
    const kit = sampleKit();
    const s = summarisePractice(kit.flashcards, { f1: recordReview(undefined, 3, now) }, now);
    expect(s).toMatchObject({ total: 2, seen: 1, unseen: 1, requirementsSolid: ['r1'], requirementsUntouched: ['r4'] });
  });
});
