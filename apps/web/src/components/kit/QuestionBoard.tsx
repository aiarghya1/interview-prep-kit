'use client';
import { useMemo, useState, type FormEvent } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Kit, Question, QuestionCategory, Requirement } from '@kit/core/schema';
import type { EditOpInput } from '@kit/core/edit';
import type { RegenState } from '@/lib/types';
import { Badge, Button, cx, EmptyState, Input } from '../ui';
import { InlineText } from './InlineText';
import { CATEGORIES, CATEGORY_LABEL } from './labels';
import { RegenButton } from './RegenButton';

type Dispatch = (op: EditOpInput | EditOpInput[]) => void;

export function StateBadges({ state }: { state?: Question['state'] }) {
  if (!state) return null;
  return (
    <>
      {state.origin === 'user' && <Badge tone="violet">Yours</Badge>}
      {state.origin === 'template' && <Badge tone="amber">Generic fallback</Badge>}
      {state.edited && state.origin !== 'user' && <Badge tone="brand">Edited</Badge>}
      {state.pinned && <Badge tone="emerald">Pinned</Badge>}
    </>
  );
}

const DIFFICULTY = ['', 'Warm-up', 'Solid', 'Hard'];

function QuestionItem({
  q,
  index,
  total,
  requirements,
  dispatch,
  onMove,
}: {
  q: Question;
  index: number;
  total: number;
  requirements: Requirement[];
  dispatch: Dispatch;
  onMove: (id: string, delta: -1 | 1) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: q.id });
  const reqText = (id: string) => requirements.find((r) => r.id === id);
  // Numbering restarts per category, so labels name the category to stay unique.
  const name = `${CATEGORY_LABEL[q.category]} question ${index + 1}`;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx('rounded-lg border bg-white p-3 shadow-sm', isDragging ? 'z-10 border-brand-500 shadow-lg' : 'border-slate-200')}
      aria-label={`${name} of ${total}`}
    >
      <div className="flex items-start gap-2">
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${name}. Press space to pick up, arrow keys to move, space to drop.`}
          className="mt-1 cursor-grab touch-none rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:cursor-grabbing"
        >
          <span aria-hidden>⋮⋮</span>
        </button>
        <div className="min-w-0 flex-1 space-y-2">
          <InlineText value={q.prompt} label={name} required className="font-medium text-slate-900" onCommit={(v) => dispatch({ op: 'question.update', id: q.id, patch: { prompt: v } })} />
          <details className="group">
            <summary className="cursor-pointer select-none text-xs font-medium text-slate-500 hover:text-slate-800">Answer outline</summary>
            <InlineText
              value={q.answer_outline}
              label={`Answer outline for ${name}`}
              placeholder="Key points a strong answer covers…"
              className="mt-1 whitespace-pre-wrap text-sm text-slate-700"
              onCommit={(v) => dispatch({ op: 'question.update', id: q.id, patch: { answer_outline: v } })}
            />
          </details>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <StateBadges state={q.state} />
            {q.requirement_ids.map((rid) => {
              const r = reqText(rid);
              return (
                <span key={rid} title={r?.text} className={cx('rounded px-1.5 py-0.5', r?.priority === 'must' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700')}>
                  {rid} {r ? `· ${r.text.slice(0, 32)}${r.text.length > 32 ? '…' : ''}` : ''}
                </span>
              );
            })}
            {q.requirement_ids.length === 0 && <span className="text-slate-400">No linked requirement</span>}
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-800">Edit details</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <label className="space-y-1">
                <span className="block text-slate-600">Difficulty</span>
                <select
                  value={q.difficulty}
                  onChange={(e) => dispatch({ op: 'question.update', id: q.id, patch: { difficulty: Number(e.target.value) } })}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1"
                >
                  {[1, 2, 3].map((d) => <option key={d} value={d}>{d} · {DIFFICULTY[d]}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="block text-slate-600">Category</span>
                <select
                  value={q.category}
                  onChange={(e) => dispatch({ op: 'question.move', id: q.id, toIndex: 9999, category: e.target.value as QuestionCategory })}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1"
                >
                  {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                </select>
              </label>
              <fieldset className="space-y-1 sm:col-span-3">
                <legend className="text-slate-600">Covers requirements</legend>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {requirements.map((r) => (
                    <label key={r.id} className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={q.requirement_ids.includes(r.id)}
                        onChange={(e) =>
                          dispatch({
                            op: 'question.update',
                            id: q.id,
                            patch: { requirement_ids: e.target.checked ? [...q.requirement_ids, r.id] : q.requirement_ids.filter((x) => x !== r.id) },
                          })
                        }
                      />
                      <span title={r.text}>{r.id} {r.text.slice(0, 28)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </details>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex gap-0.5">
            <Button size="sm" variant="ghost" onClick={() => onMove(q.id, -1)} disabled={index === 0} aria-label="Move up">↑</Button>
            <Button size="sm" variant="ghost" onClick={() => onMove(q.id, 1)} disabled={index === total - 1} aria-label="Move down">↓</Button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={!!q.state?.pinned}
            onClick={() => dispatch({ op: 'pin', target: 'question', id: q.id, pinned: !q.state?.pinned })}
            title="Pinned questions survive regeneration"
          >
            {q.state?.pinned ? 'Unpin' : 'Pin'}
          </Button>
          <Button size="sm" variant="ghost" className="text-red-700 hover:bg-red-50" onClick={() => dispatch({ op: 'question.delete', id: q.id })} aria-label={`Delete ${name}`}>
            Delete
          </Button>
        </div>
      </div>
    </li>
  );
}

function AddQuestion({ category, requirements, dispatch }: { category: QuestionCategory; requirements: Requirement[]; dispatch: Dispatch }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [req, setReq] = useState('');
  const id = `add-${category}`;
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>+ Add a {CATEGORY_LABEL[category].toLowerCase()} question</Button>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    dispatch({ op: 'question.add', tempId: `tmp-${Date.now()}`, question: { category, prompt: prompt.trim(), requirement_ids: req ? [req] : [] } });
    setPrompt('');
    setReq('');
    setOpen(false);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-dashed border-slate-300 bg-white p-3 sm:flex-row sm:items-end">
      <label htmlFor={id} className="sr-only">New question</label>
      <Input id={id} autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Write your own question…" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
      <label className="sr-only" htmlFor={`${id}-req`}>Requirement</label>
      <select id={`${id}-req`} value={req} onChange={(e) => setReq(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-2 text-sm sm:w-48">
        <option value="">No requirement</option>
        {requirements.map((r) => <option key={r.id} value={r.id}>{r.id} · {r.text.slice(0, 30)}</option>)}
      </select>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={!prompt.trim()}>Add</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function QuestionBoard({
  kit,
  dispatch,
  regen,
  onRegenerate,
}: {
  kit: Kit;
  dispatch: Dispatch;
  regen: RegenState | null;
  onRegenerate: (section: string) => Promise<void>;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [filter, setFilter] = useState('');
  const byCat = useMemo(() => {
    const m = new Map<QuestionCategory, Question[]>(CATEGORIES.map((c) => [c, []]));
    const f = filter.trim().toLowerCase();
    for (const q of kit.questions) if (!f || q.prompt.toLowerCase().includes(f) || q.requirement_ids.includes(f)) m.get(q.category)!.push(q);
    return m;
  }, [kit.questions, filter]);

  /** Reorder within a category, expressed as a full ordering of all questions. */
  const reorderCategory = (category: QuestionCategory, newOrder: string[]) => {
    const queue = [...newOrder];
    const ids = kit.questions.map((q) => (q.category === category ? queue.shift()! : q.id));
    dispatch({ op: 'question.reorder', ids });
  };

  const onDragEnd = (category: QuestionCategory) => (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = kit.questions.filter((q) => q.category === category).map((q) => q.id);
    reorderCategory(category, arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
  };

  const move = (category: QuestionCategory) => (id: string, delta: -1 | 1) => {
    const ids = kit.questions.filter((q) => q.category === category).map((q) => q.id);
    const i = ids.indexOf(id);
    reorderCategory(category, arrayMove(ids, i, i + delta));
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-600">
          Click any text to edit it. Drag the handle (or use ↑ ↓) to reorder. Change a question&apos;s category in <em>Edit details</em>.
        </p>
        <label className="sr-only" htmlFor="q-filter">Filter questions</label>
        <Input id="q-filter" className="sm:w-56" placeholder="Filter by text or r-id…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {CATEGORIES.map((category) => {
        const list = byCat.get(category)!;
        const all = kit.questions.filter((q) => q.category === category);
        return (
          <section key={category} aria-labelledby={`cat-${category}`} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={`cat-${category}`} className="text-base font-semibold">
                {CATEGORY_LABEL[category]} <span className="font-normal text-slate-500">({all.length})</span>
              </h3>
              <RegenButton section={`questions:${category}`} label={`Regenerate ${CATEGORY_LABEL[category].toLowerCase()}`} regen={regen} onRegenerate={onRegenerate} />
            </div>
            {list.length === 0 ? (
              <EmptyState title={filter ? 'No matches in this category' : `No ${CATEGORY_LABEL[category].toLowerCase()} questions`}>
                {!filter && (category === 'system-design' ? 'Not generated for this role: no system-design round was published and the seniority did not suggest one.' : 'Add one yourself or regenerate this category.')}
              </EmptyState>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd(category)} accessibility={{ screenReaderInstructions: { draggable: 'Press space to pick up a question, arrow keys to move it, space to drop, escape to cancel.' } }}>
                <SortableContext items={list.map((q) => q.id)} strategy={verticalListSortingStrategy}>
                  <ol className="space-y-2">
                    {list.map((q, i) => (
                      <QuestionItem key={q.id} q={q} index={i} total={list.length} requirements={kit.role.requirements} dispatch={dispatch} onMove={move(category)} />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
            )}
            <AddQuestion category={category} requirements={kit.role.requirements} dispatch={dispatch} />
          </section>
        );
      })}
    </div>
  );
}
