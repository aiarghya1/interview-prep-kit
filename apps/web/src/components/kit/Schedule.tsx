'use client';
import type { Kit } from '@kit/core/schema';
import type { RegenState } from '@/lib/types';
import { Banner, Button, Card } from '../ui';
import { CATEGORY_LABEL } from './labels';
import { RegenButton } from './RegenButton';

function fmt(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

export function Schedule({ kit, stale, regen, onRegenerate }: { kit: Kit; stale: boolean; regen: RegenState | null; onRegenerate: (s: string) => Promise<void> }) {
  const qById = new Map(kit.questions.map((q) => [q.id, q]));
  const total = kit.schedule.days.reduce((s, d) => s + d.minutes, 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          {kit.schedule.days_available} day{kit.schedule.days_available === 1 ? '' : 's'} · {fmt(total)} total. Must-have and harder material comes first; the last day is review.
        </p>
        <RegenButton section="schedule" label="Rebuild schedule" regen={regen} onRegenerate={onRegenerate} note="Recomputed from your current questions. Instant." />
      </div>
      {stale && (
        <Banner tone="warn" title="Questions changed since this schedule was built" action={<Button size="sm" variant="primary" onClick={() => onRegenerate('schedule')}>Rebuild now</Button>}>
          New questions aren&apos;t scheduled yet, and deleted ones have been removed.
        </Banner>
      )}
      <ol className="space-y-3">
        {kit.schedule.days.map((d) => (
          <li key={d.day}>
            <Card className="!p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">Day {d.day}</h3>
                <span className="text-sm tabular-nums text-slate-500">{fmt(d.minutes)}</span>
              </div>
              <p className="mt-0.5 text-sm text-slate-700">{d.focus}</p>
              {d.question_ids.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-800">{d.question_ids.length} question{d.question_ids.length === 1 ? '' : 's'}</summary>
                  <ul className="mt-2 space-y-1 text-sm">
                    {d.question_ids.map((id) => {
                      const q = qById.get(id);
                      return q ? (
                        <li key={id} className="flex gap-2">
                          <span className="shrink-0 rounded bg-slate-100 px-1 text-xs text-slate-600">{CATEGORY_LABEL[q.category]}</span>
                          <span>{q.prompt}</span>
                        </li>
                      ) : null;
                    })}
                  </ul>
                </details>
              )}
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}
