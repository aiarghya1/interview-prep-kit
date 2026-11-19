import { describe, expect, it } from 'vitest';
import { validateKit, BatchOutputSchema, type Kit } from '../src/schema.js';
import { buildSchedule } from '../src/schedule.js';
import { q, req } from './fixtures.js';

function validKit(): Kit {
  const requirements = [req('r1'), req('r2', 'nice')];
  const questions = [q('q1', ['r1']), q('q2', ['r2'], 1)];
  return {
    source: { company: 'Acme', company_url: 'http://localhost:8099/acme/', role: 'Engineer', location: '', jd_chars: 120, researched_at: new Date().toISOString(), pages_used: [] },
    company_brief: { summary: '', what_they_do: '', sources: [] },
    role: { title: 'Engineer', seniority: 'senior', responsibilities: [], requirements },
    questions,
    flashcards: [{ id: 'f1', front: 'a', back: 'b', requirement_ids: ['r1'] }],
    schedule: buildSchedule({ days: 3, requirements, questions }),
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };
}

describe('validateKit', () => {
  it('accepts a well-formed kit', () => {
    const r = validateKit(validKit());
    expect(r.ok).toBe(true);
  });

  const broken: [string, (k: Kit) => void, RegExp][] = [
    ['float minutes', (k) => { k.schedule.days[0]!.minutes = 12.5; }, /minutes/],
    ['difficulty out of range', (k) => { k.questions[0]!.difficulty = 4; }, /difficulty/],
    ['bad priority', (k) => { (k.role.requirements[0] as any).priority = 'required'; }, /priority/],
    ['bad category', (k) => { (k.questions[0] as any).category = 'coding'; }, /category/],
    ['unknown requirement ref', (k) => { k.questions[0]!.requirement_ids = ['r9']; }, /unknown requirement r9/],
    ['schedule refers to missing question', (k) => { k.schedule.days[0]!.question_ids.push('q99'); }, /unknown question q99/],
    ['wrong number of days', (k) => { k.schedule.days.pop(); }, /expected 3/],
    ['duplicate question ids', (k) => { k.questions[1]!.id = 'q1'; }, /duplicate ids/],
    ['missing required field', (k) => { delete (k as any).coverage; }, /coverage/],
    ['malformed id', (k) => { k.role.requirements[0]!.id = 'req-1'; }, /id/],
  ];

  it.each(broken)('rejects %s', (_name, mutate, pattern) => {
    const k = validKit();
    mutate(k);
    const r = validateKit(k);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join('\n')).toMatch(pattern);
  });
});

describe('BatchOutputSchema', () => {
  it('accepts ok and failed entries', () => {
    const out = {
      version: '1.0', generated_at: new Date().toISOString(),
      kits: [
        { id: 'case-01', status: 'ok', kit: validKit(), error: null },
        { id: 'case-04', status: 'failed', kit: null, error: { code: 'COMPANY_UNREACHABLE', message: 'x' } },
      ],
    };
    expect(BatchOutputSchema.safeParse(out).success).toBe(true);
  });

  it('rejects a failed entry carrying a kit', () => {
    const out = { version: '1.0', generated_at: '', kits: [{ id: 'x', status: 'failed', kit: validKit(), error: { code: 'X', message: '' } }] };
    expect(BatchOutputSchema.safeParse(out).success).toBe(false);
  });
});
