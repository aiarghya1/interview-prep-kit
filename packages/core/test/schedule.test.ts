import { describe, expect, it } from 'vitest';
import { buildSchedule, orderForStudy, partitionByWeight, MAX_DAILY_MINUTES } from '../src/schedule.js';
import type { Question, Requirement, Schedule } from '../src/schema.js';
import { q, req } from './fixtures.js';

const reqs: Requirement[] = [req('r1'), req('r2'), req('r3', 'nice'), req('r4', 'must', 'behavioural'), req('r5', 'nice')];
const qs: Question[] = [
  q('q1', ['r3'], 1),
  q('q2', ['r1'], 3),
  q('q3', ['r2'], 2, 'system-design'),
  q('q4', ['r4'], 2, 'behavioural'),
  q('q5', ['r5'], 1),
  q('q6', ['r1', 'r2'], 3),
  q('q7', [], 1, 'company-fit'),
  q('q8', ['r3'], 3),
];

function assertInvariants(s: Schedule, days: number, questions: Question[], requirements: Requirement[]) {
  expect(s.days_available).toBe(days);
  expect(s.days).toHaveLength(days);
  s.days.forEach((d, i) => {
    expect(d.day).toBe(i + 1);
    expect(Number.isInteger(d.minutes)).toBe(true);
    expect(d.minutes).toBeGreaterThan(0);
    expect(d.focus.length).toBeGreaterThan(0);
  });
  const ids = new Set(questions.map((x) => x.id));
  const scheduledQ = new Set(s.days.flatMap((d) => d.question_ids));
  scheduledQ.forEach((id) => expect(ids.has(id)).toBe(true));
  questions.forEach((x) => expect(scheduledQ.has(x.id)).toBe(true));
  const scheduledR = new Set(s.days.flatMap((d) => d.requirement_ids ?? []));
  requirements.filter((r) => r.priority === 'must').forEach((r) => expect(scheduledR.has(r.id)).toBe(true));
}

describe('buildSchedule', () => {
  it.each([1, 2, 3, 5, 7, 14, 30, 60])('produces exactly %i valid days', (days) => {
    assertInvariants(buildSchedule({ days, requirements: reqs, questions: qs }), days, qs, reqs);
  });

  it('puts must-have, harder questions first', () => {
    const order = orderForStudy(qs, reqs).map((x) => x.id);
    expect(order.slice(0, 2)).toEqual(['q2', 'q6']); // must + difficulty 3
    expect(order.at(-1)).toBe('q7'); // no requirement
    const s = buildSchedule({ days: 5, requirements: reqs, questions: qs });
    expect(s.days[0]!.question_ids).toContain('q2');
  });

  it('never introduces new material on the final day', () => {
    const s = buildSchedule({ days: 5, requirements: reqs, questions: qs });
    const final = s.days.at(-1)!;
    const earlier = new Set(s.days.slice(0, -1).flatMap((d) => d.question_ids));
    final.question_ids.forEach((id) => expect(earlier.has(id)).toBe(true));
    expect(final.focus).toMatch(/Final review/);
  });

  it('final day touches every must-have', () => {
    const s = buildSchedule({ days: 4, requirements: reqs, questions: qs });
    const final = new Set(s.days.at(-1)!.requirement_ids);
    ['r1', 'r2', 'r4'].forEach((id) => expect(final.has(id)).toBe(true));
  });

  it('1-day schedule includes everything and compresses time', () => {
    const many = Array.from({ length: 30 }, (_, i) => q(`q${i + 1}`, ['r1'], 3));
    const s = buildSchedule({ days: 1, requirements: [reqs[0]!], questions: many });
    assertInvariants(s, 1, many, [reqs[0]!]);
    expect(s.days[0]!.question_ids).toHaveLength(30);
    expect(s.days[0]!.minutes).toBeLessThanOrEqual(MAX_DAILY_MINUTES);
    expect(s.days[0]!.focus).toMatch(/Compressed/);
  });

  it('60-day schedule fills slack with review rather than thin learning days', () => {
    const s = buildSchedule({ days: 60, requirements: reqs, questions: qs });
    expect(s.days.filter((d) => d.focus.startsWith('Review')).length).toBeGreaterThan(50);
  });

  it('names must-haves that have no question on day 1', () => {
    const s = buildSchedule({ days: 3, requirements: [...reqs, req('r9')], questions: qs });
    expect(s.days[0]!.requirement_ids).toContain('r9');
  });

  it('handles zero questions honestly', () => {
    const s = buildSchedule({ days: 3, requirements: reqs, questions: [] });
    expect(s.days).toHaveLength(3);
    expect(s.days[0]!.requirement_ids).toEqual(reqs.map((r) => r.id));
  });

  it('is deterministic', () => {
    const a = buildSchedule({ days: 6, requirements: reqs, questions: qs });
    const b = buildSchedule({ days: 6, requirements: reqs, questions: qs });
    expect(a).toEqual(b);
  });

  it('rejects invalid day counts', () => {
    expect(() => buildSchedule({ days: 0, requirements: reqs, questions: qs })).toThrow(RangeError);
    expect(() => buildSchedule({ days: 2.5, requirements: reqs, questions: qs })).toThrow(RangeError);
  });
});

describe('partitionByWeight', () => {
  it('makes exactly N non-empty contiguous chunks', () => {
    const items = [5, 5, 5, 5, 30, 1, 1, 1];
    for (let n = 1; n <= items.length; n++) {
      const parts = partitionByWeight(items, n, (x) => x);
      expect(parts).toHaveLength(n);
      parts.forEach((p) => expect(p.length).toBeGreaterThan(0));
      expect(parts.flat()).toEqual(items);
    }
  });
});
