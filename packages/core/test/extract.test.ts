import { describe, expect, it } from 'vitest';
import { finaliseRequirements, isGrounded, priorityFromPosting } from '../src/steps/extract.js';

const JD = `Senior Backend Engineer

What you'll do:
- Build services

Requirements:
- 5+ years of backend development
- Strong Node.js and TypeScript
Experience with PostgreSQL

Nice to have:
- Kubernetes
- Payments experience is a plus

About the team:
- We are remote-first`;

describe('grounding', () => {
  it('accepts verbatim and lightly-reworded evidence', () => {
    expect(isGrounded(JD, '5+ years of backend development', '5+ years backend')).toBe(true);
    expect(isGrounded(JD, 'Strong Node.js & TypeScript', 'Node.js and TypeScript')).toBe(true);
  });
  it('rejects requirements the posting does not contain', () => {
    expect(isGrounded(JD, 'Expert COBOL programmer', '10+ years of COBOL')).toBe(false);
    expect(isGrounded(JD, '', 'Machine learning experience')).toBe(false);
  });
});

describe('priority from the posting', () => {
  it.each([
    ['5+ years of backend development', 'must'],
    ['Experience with PostgreSQL', 'must'],
    ['Kubernetes', 'nice'],
    ['Payments experience is a plus', 'nice'],
    ['We are remote-first', null],
  ])('%s -> %s', (ev, expected) => expect(priorityFromPosting(JD, ev)).toBe(expected));

  it('handles inline wording without headings', () => {
    expect(priorityFromPosting('Frontend developer wanted. Must know React.', 'Must know React')).toBe('must');
    expect(priorityFromPosting('You know Go. Rust is a bonus.', 'Rust is a bonus')).toBe('nice');
  });
});

describe('finaliseRequirements', () => {
  it('drops invented items, overrides priority from the posting, dedupes, orders and numbers', () => {
    const { requirements, dropped } = finaliseRequirements(JD, [
      { text: 'Kubernetes', kind: 'technical', priority: 'must', evidence: 'Kubernetes' },
      { text: '5+ years backend', kind: 'technical', priority: 'nice', evidence: '5+ years of backend development' },
      { text: '10+ years of COBOL', kind: 'technical', priority: 'must', evidence: 'COBOL' },
      { text: 'kubernetes', kind: 'technical', priority: 'must', evidence: 'Kubernetes' },
    ]);
    expect(dropped).toEqual(['10+ years of COBOL']);
    expect(requirements.map((r) => [r.id, r.text, r.priority])).toEqual([
      ['r1', '5+ years backend', 'must'],
      ['r2', 'Kubernetes', 'nice'],
    ]);
  });
});
