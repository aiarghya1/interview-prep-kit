'use client';
import { useEffect, useState } from 'react';
import type { KitView, ProgressEntry } from '@/lib/types';
import { Banner, Button, Card, Spinner, cx } from '../ui';
import { ERROR_HELP, STEP_LABEL, STEP_ORDER } from './labels';

function latestByStep(progress: ProgressEntry[]) {
  const m = new Map<string, ProgressEntry>();
  for (const p of progress) if (p.step !== 'llm' && p.step !== 'queued') m.set(p.step, p);
  return m;
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return <span className="tabular-nums">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>;
}

export function GenerationProgress({ view, onRetry }: { view: KitView; onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);
  const steps = latestByStep(view.progress);
  const known = STEP_ORDER.filter((s) => steps.has(s) || !s.startsWith('questions:'));
  const extra = [...steps.keys()].filter((s) => !STEP_ORDER.includes(s) && s !== 'done' && s !== 'failed' && s !== 'restart');
  const lastLlm = [...view.progress].reverse().find((p) => p.step === 'llm');
  const latest = view.progress.at(-1);
  const failed = view.status === 'failed';
  const start = view.progress.find((p) => p.step !== 'queued')?.at ?? view.createdAt;

  return (
    <Card className="mx-auto max-w-2xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{failed ? "We couldn't build this kit" : view.status === 'queued' ? 'Waiting to start…' : 'Building your kit'}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {view.input.company_url} · {view.input.days} day{view.input.days === 1 ? '' : 's'}
          </p>
        </div>
        {!failed && (
          <p className="text-sm text-slate-500" aria-label="Elapsed time">
            <Elapsed since={start} />
          </p>
        )}
      </div>

      {failed && (
        <div className="mt-4">
          <Banner
            tone="error"
            title={ERROR_HELP[view.error?.code ?? ''] ?? 'Something went wrong while generating.'}
            action={
              <Button
                variant="primary"
                busy={retrying}
                onClick={async () => {
                  setRetrying(true);
                  await onRetry().finally(() => setRetrying(false));
                }}
              >
                Try again
              </Button>
            }
          >
            <p className="text-xs opacity-80">
              {view.error?.code}: {view.error?.message}
            </p>
          </Banner>
        </div>
      )}

      <ol className="mt-6 space-y-2" aria-label="Generation steps">
        {[...known, ...extra].map((step) => {
          const p = steps.get(step);
          const raw = p?.status ?? 'pending';
          // A step still 'running' when the kit failed was abandoned, not in progress.
          const state = failed && raw === 'running' ? 'stopped' : raw;
          return (
            <li key={step} className="flex items-start gap-3 text-sm">
              <span aria-hidden className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center">
                {state === 'running' ? (
                  <Spinner className="h-4 w-4 text-brand-600" />
                ) : state === 'done' ? (
                  <span className="text-emerald-600">✓</span>
                ) : state === 'skipped' || state === 'stopped' ? (
                  <span className="text-slate-400">–</span>
                ) : state === 'failed' ? (
                  <span className="text-red-600">!</span>
                ) : (
                  <span className="h-2 w-2 rounded-full bg-slate-300" />
                )}
              </span>
              <div className="min-w-0">
                <p className={cx('font-medium', state === 'pending' || state === 'stopped' ? 'text-slate-400' : 'text-slate-800')}>
                  {STEP_LABEL[step] ?? step}
                  <span className="sr-only"> — {state}</span>
                </p>
                {p?.message && state !== 'pending' && <p className={cx('break-words text-xs', state === 'failed' ? 'text-red-700' : 'text-slate-500')}>{p.message}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      {!failed && (
        <div className="mt-6 space-y-2 border-t border-slate-100 pt-4 text-xs text-slate-500" aria-live="polite">
          {lastLlm && Date.now() - Date.parse(lastLlm.at) < 60_000 && <p className="text-amber-700">{lastLlm.message}. Free-tier AI limits; this is expected.</p>}
          <p>Latest: {latest?.message ?? 'Starting…'}</p>
          <p>This usually takes one to three minutes. You can leave this page; the kit keeps building and will be in your list.</p>
        </div>
      )}
    </Card>
  );
}
