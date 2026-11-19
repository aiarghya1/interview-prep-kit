import { describe, expect, it } from 'vitest';
import { applyEditOps, EditOpsSchema, type EditOpInput } from '../src/edit.js';
import { mergeRegenerated } from '../src/regenerate.js';
import { validateKit } from '../src/schema.js';
import { sampleKit } from './kitFixture.js';

const ops = (x: EditOpInput[]) => EditOpsSchema.parse(x);

describe('applyEditOps', () => {
  it('edits mark generated items as edited and keep the kit valid', () => {
    const r = applyEditOps(sampleKit(), ops([{ op: 'question.update', id: 'q1', patch: { prompt: 'Mine' } }]));
    expect(r.kit.questions[0]).toMatchObject({ prompt: 'Mine', state: { origin: 'generated', edited: true } });
    expect(validateKit(r.kit).ok).toBe(true);
  });

  it('adds user items with fresh ids and reports tempId mapping', () => {
    const r = applyEditOps(sampleKit(), ops([
      { op: 'question.add', tempId: 't1', question: { category: 'technical', prompt: 'New Q', requirement_ids: ['r1'] }, index: 1 },
      { op: 'flashcard.add', tempId: 't2', card: { front: 'New card' } },
    ]));
    expect(r.created).toEqual({ t1: 'q5', t2: 'f3' });
    expect(r.kit.questions[1]).toMatchObject({ id: 'q5', state: { origin: 'user' } });
    expect(r.questionsChanged).toBe(true);
  });

  it('never reuses an id retired by deletion (high-water mark)', () => {
    const a = applyEditOps(sampleKit(), ops([{ op: 'question.add', question: { category: 'technical', prompt: 'X' } }]));
    const b = applyEditOps(a.kit, ops([{ op: 'question.delete', id: 'q5' }]), a.highWater);
    const c = applyEditOps(b.kit, ops([{ op: 'question.add', question: { category: 'technical', prompt: 'Y' } }]), b.highWater);
    expect(c.kit.questions.at(-1)!.id).toBe('q6');
  });

  it('delete prunes schedule refs and recomputes coverage', () => {
    const r = applyEditOps(sampleKit(), ops([{ op: 'question.delete', id: 'q3' }]));
    expect(r.kit.schedule.days.flatMap((d) => d.question_ids)).not.toContain('q3');
    expect(r.kit.coverage.uncovered_requirement_ids).toEqual(['r3']);
    expect(validateKit(r.kit).ok).toBe(true);
  });

  it('moving to another category is an edit; plain reorder is not', () => {
    const r = applyEditOps(sampleKit(), ops([
      { op: 'question.move', id: 'q2', toIndex: 3, category: 'system-design' },
      { op: 'question.reorder', ids: ['q4', 'q1'] },
    ]));
    expect(r.kit.questions.map((x) => x.id)).toEqual(['q4', 'q1', 'q3', 'q2']);
    expect(r.kit.questions.find((x) => x.id === 'q2')).toMatchObject({ category: 'system-design', state: { edited: true } });
    expect(r.kit.questions.find((x) => x.id === 'q4')!.state!.edited).toBe(false);
  });

  it('reorder tolerates stale id lists from a concurrent add/delete', () => {
    const r = applyEditOps(sampleKit(), ops([{ op: 'question.reorder', ids: ['q3', 'q99', 'q1'] }]));
    expect(r.kit.questions.map((x) => x.id)).toEqual(['q3', 'q1', 'q2', 'q4']);
  });

  it('pins, and rejects unknown ids and requirement refs', () => {
    const r = applyEditOps(sampleKit(), ops([{ op: 'pin', target: 'question', id: 'q2', pinned: true }, { op: 'pin', target: 'brief', pinned: true }]));
    expect(r.kit.questions[1]!.state!.pinned).toBe(true);
    expect(r.kit.company_brief.state!.pinned).toBe(true);
    expect(() => applyEditOps(sampleKit(), ops([{ op: 'question.delete', id: 'q42' }]))).toThrow(/not found/);
    expect(() => applyEditOps(sampleKit(), ops([{ op: 'question.update', id: 'q1', patch: { requirement_ids: ['r9'] } }]))).toThrow(/Unknown requirement/);
  });

  it('rejects malformed ops at the schema', () => {
    expect(EditOpsSchema.safeParse([{ op: 'question.update', id: 'q1', patch: { difficulty: 7 } }]).success).toBe(false);
    expect(EditOpsSchema.safeParse([{ op: 'question.add', question: { category: 'coding', prompt: 'x' } }]).success).toBe(false);
    expect(EditOpsSchema.safeParse([]).success).toBe(false);
  });
});

describe('regeneration preserves edits made elsewhere and meanwhile', () => {
  it('an edit made while the category was regenerating survives the merge', () => {
    const before = sampleKit();
    // 1. regeneration starts from `before`; meanwhile the user edits q2 and writes q5
    const during = applyEditOps(before, ops([
      { op: 'question.update', id: 'q2', patch: { prompt: 'Edited during regen' } },
      { op: 'question.add', question: { category: 'technical', prompt: 'Hand-written', requirement_ids: ['r2'] } },
      { op: 'brief.update', patch: { summary: 'My brief' } },
    ]));
    // 2. model returns fresh technical questions; merge into the LATEST kit
    const out = mergeRegenerated(during.kit, {
      section: 'questions:technical',
      questions: [{ category: 'technical', prompt: 'Fresh 1', answer_outline: '', difficulty: 2, requirement_ids: ['r1'] }],
    }, during.highWater);
    const ids = out.kit.questions.map((x) => x.id);
    expect(out.removed).toEqual(['q1']);
    expect(ids).toEqual(expect.arrayContaining(['q2', 'q5', 'q3', 'q4', 'q6']));
    expect(out.kit.questions.find((x) => x.id === 'q2')!.prompt).toBe('Edited during regen');
    expect(out.kit.company_brief.summary).toBe('My brief'); // other section untouched
    expect(out.kit.flashcards).toBe(during.kit.flashcards);
    expect(validateKit(out.kit).ok).toBe(true);
  });

  it('a protected brief is not replaced', () => {
    const k = applyEditOps(sampleKit(), ops([{ op: 'pin', target: 'brief', pinned: true }])).kit;
    const out = mergeRegenerated(k, { section: 'brief', brief: { summary: 'new', what_they_do: 'new', sources: [] } }, { q: 4, f: 2 });
    expect(out.skippedProtected).toBe(true);
    expect(out.kit.company_brief.summary).toBe('S');
  });
});
