'use client';
import { useState, type FormEvent } from 'react';
import type { Kit } from '@kit/core/schema';
import type { EditOpInput } from '@kit/core/edit';
import type { RegenState } from '@/lib/types';
import { Button, EmptyState, Input } from '../ui';
import { InlineText } from './InlineText';
import { RegenButton } from './RegenButton';
import { StateBadges } from './QuestionBoard';

export function Flashcards({ kit, dispatch, regen, onRegenerate }: { kit: Kit; dispatch: (op: EditOpInput) => void; regen: RegenState | null; onRegenerate: (s: string) => Promise<void> }) {
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!front.trim()) return;
    dispatch({ op: 'flashcard.add', tempId: `tmp-${Date.now()}`, card: { front: front.trim(), back: back.trim() } });
    setFront('');
    setBack('');
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">{kit.flashcards.length} cards. Practise them in the Practice tab.</p>
        <RegenButton section="flashcards" label="Regenerate flashcards" regen={regen} onRegenerate={onRegenerate} />
      </div>
      {kit.flashcards.length === 0 && <EmptyState title="No flashcards">Add your own below or regenerate.</EmptyState>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {kit.flashcards.map((f, i) => (
          <li key={f.id} className="flex flex-col rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
            <div className="mb-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
              <span className="font-mono">{f.id}</span>
              <StateBadges state={f.state} />
              {f.requirement_ids.map((r) => <span key={r} className="rounded bg-slate-100 px-1">{r}</span>)}
            </div>
            <InlineText value={f.front} label={`Card ${i + 1} front`} required className="font-medium" onCommit={(v) => dispatch({ op: 'flashcard.update', id: f.id, patch: { front: v } })} />
            <InlineText value={f.back} label={`Card ${i + 1} back`} placeholder="Answer…" className="mt-1 text-sm text-slate-700" onCommit={(v) => dispatch({ op: 'flashcard.update', id: f.id, patch: { back: v } })} />
            <div className="mt-auto flex justify-end gap-1 pt-2">
              <Button size="sm" variant="ghost" aria-pressed={!!f.state?.pinned} onClick={() => dispatch({ op: 'pin', target: 'flashcard', id: f.id, pinned: !f.state?.pinned })}>{f.state?.pinned ? 'Unpin' : 'Pin'}</Button>
              <Button size="sm" variant="ghost" className="text-red-700 hover:bg-red-50" onClick={() => dispatch({ op: 'flashcard.delete', id: f.id })} aria-label={`Delete card ${i + 1}`}>Delete</Button>
            </div>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="grid gap-2 rounded-lg border border-dashed border-slate-300 bg-white p-3 sm:grid-cols-[1fr_1fr_auto]">
        <label className="sr-only" htmlFor="new-front">Front</label>
        <Input id="new-front" placeholder="Front (prompt)" value={front} onChange={(e) => setFront(e.target.value)} />
        <label className="sr-only" htmlFor="new-back">Back</label>
        <Input id="new-back" placeholder="Back (answer)" value={back} onChange={(e) => setBack(e.target.value)} />
        <Button type="submit" variant="primary" disabled={!front.trim()}>Add card</Button>
      </form>
    </div>
  );
}
