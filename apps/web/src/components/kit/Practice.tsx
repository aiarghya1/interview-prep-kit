'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Kit } from '@kit/core/schema';
import { api } from '@/lib/api';
import type { PracticeView } from '@/lib/types';
import { Banner, Button, Card, EmptyState, Spinner, cx } from '../ui';

const CONF = [
  { v: 1 as const, label: "Didn't know", key: '1', cls: 'border-red-200 hover:bg-red-50 text-red-800' },
  { v: 2 as const, label: 'Shaky', key: '2', cls: 'border-amber-200 hover:bg-amber-50 text-amber-800' },
  { v: 3 as const, label: 'Solid', key: '3', cls: 'border-emerald-200 hover:bg-emerald-50 text-emerald-800' },
];

export function Practice({ kitId, kit }: { kitId: string; kit: Kit }) {
  const [data, setData] = useState<PracticeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const requeued = useRef(new Set<string>());
  const cardRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<PracticeView>(`/kits/${kitId}/practice`));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [kitId]);
  useEffect(() => {
    void load();
  }, [load]);

  const cards = new Map(kit.flashcards.map((f) => [f.id, f]));
  const current = queue?.[0] ? cards.get(queue[0]) : undefined;

  const start = () => {
    setQueue(data!.order.filter((id) => cards.has(id)));
    setDone(0);
    setRevealed(false);
    requeued.current.clear();
    setTimeout(() => cardRef.current?.focus(), 0);
  };

  const rate = useCallback(
    async (confidence: 1 | 2 | 3) => {
      if (!current || busy) return;
      setBusy(true);
      try {
        const res = await api<PracticeView>(`/kits/${kitId}/practice`, { body: { cardId: current.id, confidence } });
        setData(res);
        setDone((d) => d + 1);
        setQueue((q) => {
          const rest = (q ?? []).slice(1);
          // A card you didn't know comes back once at the end of this session.
          if (confidence === 1 && !requeued.current.has(current.id)) {
            requeued.current.add(current.id);
            return [...rest, current.id];
          }
          return rest;
        });
        setRevealed(false);
        cardRef.current?.focus();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [current, busy, kitId],
  );

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select')) return;
      if ((e.key === ' ' || e.key === 'Enter') && !revealed && t === cardRef.current) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && ['1', '2', '3'].includes(e.key)) {
        e.preventDefault();
        void rate(Number(e.key) as 1 | 2 | 3);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, revealed, rate]);

  if (error) return <Banner tone="error" title="Practice couldn't load" action={<Button size="sm" onClick={load}>Retry</Button>}>{error}</Banner>;
  if (!data) return <p className="flex items-center gap-2 text-sm text-slate-500"><Spinner label="Loading practice" /> Loading…</p>;
  if (kit.flashcards.length === 0) return <EmptyState title="No flashcards to practise">Add some in the Flashcards tab.</EmptyState>;

  const s = data.summary;
  const reqName = (id: string) => kit.role.requirements.find((r) => r.id === id)?.text ?? id;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div>
        {queue === null || queue.length === 0 ? (
          <Card className="text-center">
            {queue && queue.length === 0 ? (
              <>
                <p className="text-lg font-semibold">Session done: {done} card{done === 1 ? '' : 's'} reviewed</p>
                <p className="mt-1 text-sm text-slate-600">Next session starts with whatever you were least sure of.</p>
              </>
            ) : (
              <>
                <p className="text-lg font-semibold">Ready to practise</p>
                <p className="mt-1 text-sm text-slate-600">
                  {s.due > 0 ? `${s.due} card${s.due === 1 ? '' : 's'} due for review, least confident first` : s.unseen > 0 ? `${s.unseen} new card${s.unseen === 1 ? '' : 's'}, must-haves first` : 'Nothing due. Review anyway, soonest-due first'}.
                </p>
              </>
            )}
            <Button variant="primary" className="mt-4" onClick={start}>{queue ? 'Start another session' : 'Start session'}</Button>
          </Card>
        ) : (
          current && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm text-slate-500">
                <span>{done} done · {queue.length} left</span>
                <Button size="sm" variant="ghost" onClick={() => setQueue(null)}>End session</Button>
              </div>
              <div
                ref={cardRef}
                tabIndex={0}
                role="group"
                aria-roledescription="flashcard"
                aria-label={revealed ? 'Answer shown. Rate with 1, 2 or 3.' : 'Press space to reveal the answer.'}
                className="min-h-[14rem] rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Question</p>
                <p className="mt-1 text-lg font-medium text-slate-900">{current.front}</p>
                {revealed ? (
                  <div className="mt-4 border-t border-slate-100 pt-4" aria-live="polite">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Answer</p>
                    <p className="mt-1 whitespace-pre-wrap text-slate-700">{current.back || 'No answer written for this card.'}</p>
                  </div>
                ) : (
                  <Button variant="primary" className="mt-6" onClick={() => setRevealed(true)}>Reveal answer <kbd className="ml-1 rounded bg-white/20 px-1 text-xs">Space</kbd></Button>
                )}
              </div>
              {revealed && (
                <div className="grid grid-cols-3 gap-2" role="group" aria-label="How confident were you?">
                  {CONF.map((c) => (
                    <button key={c.v} type="button" disabled={busy} onClick={() => rate(c.v)} className={cx('rounded-lg border bg-white px-3 py-3 text-sm font-medium', c.cls)}>
                      {c.label} <kbd className="ml-1 text-xs opacity-60">{c.key}</kbd>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        )}
      </div>

      <Card>
        <h3 className="font-semibold">Progress</h3>
        <p className="mt-1 text-sm text-slate-600">{s.seen} of {s.total} cards practised</p>
        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${s.byConfidence[3]} solid, ${s.byConfidence[2]} shaky, ${s.byConfidence[1]} not known, ${s.unseen} not seen`}>
          <div className="bg-emerald-500" style={{ width: `${(s.byConfidence[3] / s.total) * 100}%` }} />
          <div className="bg-amber-400" style={{ width: `${(s.byConfidence[2] / s.total) * 100}%` }} />
          <div className="bg-red-400" style={{ width: `${(s.byConfidence[1] / s.total) * 100}%` }} />
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-1 text-sm">
          <dt className="text-slate-500">Solid</dt><dd className="text-right tabular-nums">{s.byConfidence[3]}</dd>
          <dt className="text-slate-500">Shaky</dt><dd className="text-right tabular-nums">{s.byConfidence[2]}</dd>
          <dt className="text-slate-500">Didn&apos;t know</dt><dd className="text-right tabular-nums">{s.byConfidence[1]}</dd>
          <dt className="text-slate-500">Not seen yet</dt><dd className="text-right tabular-nums">{s.unseen}</dd>
        </dl>
        {s.requirementsUntouched.length > 0 && (
          <div className="mt-4">
            <p className="text-sm font-medium">Not practised yet</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-slate-600">{s.requirementsUntouched.map((r) => <li key={r}>{reqName(r)}</li>)}</ul>
          </div>
        )}
        {s.requirementsSolid.length > 0 && (
          <div className="mt-4">
            <p className="text-sm font-medium">Feeling solid on</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-slate-600">{s.requirementsSolid.map((r) => <li key={r}>{reqName(r)}</li>)}</ul>
          </div>
        )}
        {s.seen > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-4"
            onClick={async () => {
              if (!window.confirm('Reset all practice progress for this kit?')) return;
              setData(await api<PracticeView>(`/kits/${kitId}/practice`, { method: 'DELETE' }));
              setQueue(null);
            }}
          >
            Reset progress
          </Button>
        )}
      </Card>
    </div>
  );
}
