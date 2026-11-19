/**
 * User edits to a kit, expressed as small operations rather than whole-kit
 * replacements. The builder applies them optimistically in the browser and
 * sends them in batches; the server applies the *same function* to the latest
 * stored kit. Because ops are granular (one field of one item), edits made in
 * two tabs, or while a regeneration is running, compose instead of
 * overwriting each other.
 *
 * Editing rules (see merge.ts for how these are used):
 *   - changing content or category marks a generated item `edited`
 *   - added items are `origin: user`
 *   - plain reordering is not an edit (it doesn't protect an item)
 *   - deleting retires the id: high-water marks stop it being reissued
 * After any op, coverage is recomputed by code and schedule references to
 * deleted questions are pruned.
 */
import { z } from 'zod';
import { computeCoverage } from './coverage.js';
import { createIdAllocator } from './ids.js';
import { applyUserEdit, pruneScheduleRefs, USER } from './merge.js';
import { QuestionCategory, type Flashcard, type Kit, type Question } from './schema.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const Id = z.string().min(1).max(40);

export const QuestionPatch = z
  .object({
    prompt: text(1000),
    answer_outline: z.string().max(4000),
    difficulty: z.number().int().min(1).max(3),
    category: QuestionCategory,
    requirement_ids: z.array(Id).max(20),
  })
  .partial();

export const FlashcardPatch = z
  .object({ front: text(500), back: z.string().max(2000), requirement_ids: z.array(Id).max(20) })
  .partial();

export const EditOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('question.update'), id: Id, patch: QuestionPatch }),
  z.object({
    op: z.literal('question.add'),
    tempId: z.string().max(60).optional(),
    index: z.number().int().min(0).optional(),
    question: z.object({
      category: QuestionCategory,
      prompt: text(1000),
      answer_outline: z.string().max(4000).default(''),
      difficulty: z.number().int().min(1).max(3).default(2),
      requirement_ids: z.array(Id).max(20).default([]),
    }),
  }),
  z.object({ op: z.literal('question.delete'), id: Id }),
  z.object({ op: z.literal('question.move'), id: Id, toIndex: z.number().int().min(0), category: QuestionCategory.optional() }),
  z.object({ op: z.literal('question.reorder'), ids: z.array(Id).max(500) }),
  z.object({ op: z.literal('flashcard.update'), id: Id, patch: FlashcardPatch }),
  z.object({
    op: z.literal('flashcard.add'),
    tempId: z.string().max(60).optional(),
    card: z.object({ front: text(500), back: z.string().max(2000).default(''), requirement_ids: z.array(Id).max(20).default([]) }),
  }),
  z.object({ op: z.literal('flashcard.delete'), id: Id }),
  z.object({ op: z.literal('flashcard.reorder'), ids: z.array(Id).max(500) }),
  z.object({ op: z.literal('brief.update'), patch: z.object({ summary: z.string().max(4000), what_they_do: z.string().max(4000) }).partial() }),
  z.object({ op: z.literal('pin'), target: z.enum(['question', 'flashcard', 'brief']), id: Id.optional(), pinned: z.boolean() }),
]);
export type EditOp = z.infer<typeof EditOpSchema>;
export type EditOpInput = z.input<typeof EditOpSchema>;
export const EditOpsSchema = z.array(EditOpSchema).min(1).max(200);

export interface IdHighWater {
  q: number;
  f: number;
}

export class EditError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'EditError';
  }
}

export interface ApplyResult {
  kit: Kit;
  highWater: IdHighWater;
  /** tempId -> assigned id, so the client can swap its optimistic ids. */
  created: Record<string, string>;
  questionsChanged: boolean;
}

/** Order `items` by `ids`; ids that no longer exist are ignored, unmentioned items keep their relative place at the end. */
function reorderBy<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of ids) {
    const it = byId.get(id);
    if (it && !seen.has(id)) {
      ordered.push(it);
      seen.add(id);
    }
  }
  return [...ordered, ...items.filter((i) => !seen.has(i.id))];
}

export function applyEditOps(kit: Kit, ops: EditOp[], highWater: IdHighWater = { q: 0, f: 0 }): ApplyResult {
  const reqIds = new Set(kit.role.requirements.map((r) => r.id));
  const checkReqs = (ids: string[] | undefined) => {
    const bad = (ids ?? []).filter((id) => !reqIds.has(id));
    if (bad.length) throw new EditError('INVALID', `Unknown requirement id(s): ${bad.join(', ')}`);
  };
  const qIds = createIdAllocator('q', kit.questions.map((q) => q.id), highWater.q);
  const fIds = createIdAllocator('f', kit.flashcards.map((f) => f.id), highWater.f);
  let questions: Question[] = [...kit.questions];
  let flashcards: Flashcard[] = [...kit.flashcards];
  let brief = kit.company_brief;
  const created: Record<string, string> = {};
  let questionsChanged = false;

  const findQ = (id: string) => {
    const i = questions.findIndex((q) => q.id === id);
    if (i < 0) throw new EditError('NOT_FOUND', `Question ${id} not found`);
    return i;
  };
  const findF = (id: string) => {
    const i = flashcards.findIndex((f) => f.id === id);
    if (i < 0) throw new EditError('NOT_FOUND', `Flashcard ${id} not found`);
    return i;
  };

  for (const op of ops) {
    switch (op.op) {
      case 'question.update': {
        checkReqs(op.patch.requirement_ids);
        const i = findQ(op.id);
        questions[i] = applyUserEdit(questions[i]!, op.patch);
        if (op.patch.requirement_ids) questionsChanged = true;
        break;
      }
      case 'question.add': {
        checkReqs(op.question.requirement_ids);
        const q: Question = { ...op.question, id: qIds.next(), state: { ...USER } };
        const at = op.index === undefined ? questions.length : Math.min(op.index, questions.length);
        questions.splice(at, 0, q);
        if (op.tempId) created[op.tempId] = q.id;
        questionsChanged = true;
        break;
      }
      case 'question.delete': {
        questions.splice(findQ(op.id), 1);
        questionsChanged = true;
        break;
      }
      case 'question.move': {
        const i = findQ(op.id);
        let [q] = questions.splice(i, 1);
        if (op.category && op.category !== q!.category) q = applyUserEdit(q!, { category: op.category });
        questions.splice(Math.min(op.toIndex, questions.length), 0, q!);
        break;
      }
      case 'question.reorder':
        questions = reorderBy(questions, op.ids);
        break;
      case 'flashcard.update': {
        checkReqs(op.patch.requirement_ids);
        const i = findF(op.id);
        flashcards[i] = applyUserEdit(flashcards[i]!, op.patch);
        break;
      }
      case 'flashcard.add': {
        checkReqs(op.card.requirement_ids);
        const f: Flashcard = { ...op.card, id: fIds.next(), state: { ...USER } };
        flashcards.push(f);
        if (op.tempId) created[op.tempId] = f.id;
        break;
      }
      case 'flashcard.delete':
        flashcards.splice(findF(op.id), 1);
        break;
      case 'flashcard.reorder':
        flashcards = reorderBy(flashcards, op.ids);
        break;
      case 'brief.update':
        brief = applyUserEdit(brief, op.patch);
        break;
      case 'pin': {
        const set = <T extends { state?: Question['state'] }>(item: T): T => ({
          ...item,
          state: { ...(item.state ?? { origin: 'generated', edited: false }), pinned: op.pinned } as NonNullable<T['state']>,
        });
        if (op.target === 'brief') brief = set(brief);
        else if (!op.id) throw new EditError('INVALID', 'pin needs an id');
        else if (op.target === 'question') {
          const i = findQ(op.id);
          questions[i] = set(questions[i]!);
        } else {
          const i = findF(op.id);
          flashcards[i] = set(flashcards[i]!);
        }
        break;
      }
    }
  }

  const live = new Set(questions.map((q) => q.id));
  const report = computeCoverage(kit.role.requirements, questions);
  return {
    kit: {
      ...kit,
      company_brief: brief,
      questions,
      flashcards,
      schedule: { ...kit.schedule, days: pruneScheduleRefs(kit.schedule.days, live) },
      coverage: { ...kit.coverage, uncovered_requirement_ids: report.uncovered },
    },
    highWater: { q: qIds.highWater, f: fIds.highWater },
    created,
    questionsChanged,
  };
}
