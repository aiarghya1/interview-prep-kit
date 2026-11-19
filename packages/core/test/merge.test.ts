import { describe, expect, it } from 'vitest';
import { applyUserEdit, isProtected, mergeSection, mergeSingle, GENERATED, USER } from '../src/merge.js';
import { createIdAllocator } from '../src/ids.js';
import type { Question } from '../src/schema.js';
import { q } from './fixtures.js';

const gen = (x: Question): Question => ({ ...x, state: { ...GENERATED } });

describe('mergeSection (regenerate one question category)', () => {
  const base: Question[] = [
    gen(q('q1', ['r1'], 2, 'technical')),
    gen(q('q2', ['r4'], 2, 'behavioural')),
    applyUserEdit(gen(q('q3', ['r1'], 2, 'technical')), { prompt: 'My edited prompt' }),
    { ...q('q4', ['r2'], 1, 'technical'), state: { ...USER } },
    gen(q('q5', ['r2'], 1, 'technical')),
    { ...gen(q('q6', ['r2'], 1, 'technical')), state: { ...GENERATED, pinned: true } },
  ];

  const run = (generated: Omit<Question, 'id'>[]) => {
    const ids = createIdAllocator('q', base.map((x) => x.id));
    return mergeSection(base, (x) => x.category === 'technical', generated, ids.next, (x) => x.prompt);
  };

  it('keeps edited, user-written and pinned items; replaces the rest of the section only', () => {
    const r = run([{ ...q('_', ['r1'], 3), prompt: 'Fresh A' }, { ...q('_', ['r2'], 2), prompt: 'Fresh B' }]);
    expect(r.removed).toEqual(['q1', 'q5']);
    expect(r.kept).toEqual(['q3', 'q4', 'q6']);
    expect(r.added).toEqual(['q7', 'q8']);
    const ids = r.items.map((x) => x.id);
    expect(ids).toEqual(['q2', 'q3', 'q4', 'q6', 'q7', 'q8']);
    expect(r.items.find((x) => x.id === 'q3')!.prompt).toBe('My edited prompt');
  });

  it('leaves other categories untouched, by reference', () => {
    const r = run([]);
    expect(r.items.find((x) => x.id === 'q2')).toBe(base[1]);
  });

  it('drops regenerated items that duplicate a kept one', () => {
    const r = run([{ ...q('_', ['r1']), prompt: 'my edited prompt!' }]);
    expect(r.added).toEqual([]);
  });

  it('never reuses retired ids', () => {
    const r = run([{ ...q('_', ['r1']), prompt: 'New' }]);
    expect(r.added[0]).toBe('q7');
    expect(r.removed).not.toContain('q7');
  });
});

describe('state helpers', () => {
  it('applyUserEdit marks generated items edited, leaves user items as user', () => {
    expect(applyUserEdit(gen(q('q1', [])), { prompt: 'x' }).state).toEqual({ origin: 'generated', edited: true, pinned: false });
    expect(applyUserEdit({ ...q('q1', []), state: { ...USER } }, { prompt: 'x' }).state!.origin).toBe('user');
  });

  it('template-origin items are replaceable', () => {
    expect(isProtected({ state: { origin: 'template', edited: false, pinned: false } })).toBe(false);
  });

  it('mergeSingle keeps an edited brief unless forced', () => {
    const brief = { summary: 'mine', what_they_do: '', sources: [], state: { ...GENERATED, edited: true } };
    expect(mergeSingle(brief, { summary: 'new', what_they_do: '', sources: [] }).summary).toBe('mine');
    expect(mergeSingle(brief, { summary: 'new', what_they_do: '', sources: [] }, true).summary).toBe('new');
  });
});
