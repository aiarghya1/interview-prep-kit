import type { Kit } from '../src/schema.js';
import { buildSchedule } from '../src/schedule.js';
import { GENERATED } from '../src/merge.js';
import { q, req } from './fixtures.js';

export function sampleKit(): Kit {
  const requirements = [req('r1'), req('r2'), req('r3', 'must', 'behavioural'), req('r4', 'nice', 'domain')];
  const questions = [
    { ...q('q1', ['r1'], 3, 'technical'), state: { ...GENERATED } },
    { ...q('q2', ['r2'], 2, 'technical'), state: { ...GENERATED } },
    { ...q('q3', ['r3'], 2, 'behavioural'), state: { ...GENERATED } },
    { ...q('q4', ['r4'], 1, 'company-fit'), state: { ...GENERATED } },
  ];
  return {
    source: { company: 'Acme', company_url: 'https://acme.example', role: 'Engineer', location: '', jd_chars: 500, researched_at: '2026-11-20T00:00:00Z', pages_used: [] },
    company_brief: { summary: 'S', what_they_do: 'W', sources: [], state: { ...GENERATED } },
    role: { title: 'Engineer', seniority: 'senior', responsibilities: [], requirements },
    questions,
    flashcards: [
      { id: 'f1', front: 'A', back: 'a', requirement_ids: ['r1'], state: { ...GENERATED } },
      { id: 'f2', front: 'B', back: 'b', requirement_ids: ['r4'], state: { ...GENERATED } },
    ],
    schedule: buildSchedule({ days: 3, requirements, questions }),
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };
}
