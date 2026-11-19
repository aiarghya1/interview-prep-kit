'use client';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import type { useKit } from '@/lib/useKit';
import { Badge, Banner, Button, cx } from '../ui';
import { Flashcards } from './Flashcards';
import { NOTE_TONE, prettyNote } from './labels';
import { Overview } from './Overview';
import { Practice } from './Practice';
import { QuestionBoard } from './QuestionBoard';
import { Schedule } from './Schedule';
import { StoryBank } from './StoryBank';

const TABS = ['overview', 'questions', 'flashcards', 'schedule', 'practice', 'stories'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { overview: 'Overview', questions: 'Questions', flashcards: 'Flashcards', schedule: 'Schedule', practice: 'Practice', stories: 'Your stories' };

function SaveIndicator({ state, error, unsaved }: { state: string; error: string | null; unsaved: number }) {
  const text =
    state === 'saving' ? `Saving${unsaved > 1 ? ` ${unsaved} changes` : ''}…` : state === 'retrying' ? 'Offline. Will retry saving' : state === 'error' ? 'Some changes were not saved' : state === 'saved' ? 'All changes saved' : '';
  return (
    <p role="status" aria-live="polite" className={cx('text-xs', state === 'error' ? 'text-red-700' : state === 'retrying' ? 'text-amber-700' : 'text-slate-500')} title={error ?? undefined}>
      {text}
    </p>
  );
}

export function KitWorkspace({ k, note }: { k: ReturnType<typeof useKit>; note?: string | null }) {
  const { view, kit, dispatch, regenerate } = k;
  const [tab, setTab] = useState<Tab>('overview');
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [dismissedRegen, setDismissedRegen] = useState<string | null>(null);

  useEffect(() => {
    const h = window.location.hash.slice(1) as Tab;
    if (TABS.includes(h)) setTab(h);
  }, []);
  const select = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `#${t}`);
  };
  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const next = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i - 1 + TABS.length) % TABS.length] : e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS.at(-1) : null;
    if (next) {
      e.preventDefault();
      select(next);
      tabRefs.current[next]?.focus();
    }
  };

  if (!view || !kit) return null;
  const uncoveredMust = kit.coverage.uncovered_requirement_ids.filter((id) => kit.role.requirements.find((r) => r.id === id)?.priority === 'must');
  const notes = (kit.source.notes ?? []).filter((n) => !/^NO_PUBLIC_DISCUSSION/.test(n));
  const regen = view.regen;
  const regenKey = regen ? `${regen.section}-${regen.finishedAt}` : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <Link href="/kits" className="text-sm text-slate-500 hover:text-slate-800">← All kits</Link>
          <h1 className="mt-1 truncate text-2xl font-semibold">{kit.role.title || view.title}</h1>
          <p className="text-sm text-slate-600">
            {kit.source.company || view.input.company_url} · {kit.schedule.days_available} day{kit.schedule.days_available === 1 ? '' : 's'} · {kit.questions.length} questions · {kit.flashcards.length} cards
          </p>
        </div>
        <SaveIndicator state={k.saveState} error={k.saveError} unsaved={k.unsavedCount} />
      </div>

      {note === 'in_progress' && <Banner>You already submitted this posting; showing the kit that was being built.</Banner>}
      {note === 'existing' && <Banner>You already have a kit for this posting, so here it is instead of a duplicate.</Banner>}
      {note === 'rescheduled' && <Banner tone="success">Same posting as an earlier kit: research reused, schedule rebuilt for {kit.schedule.days_available} days.</Banner>}
      {k.saveState === 'error' && <Banner tone="error" title="Some changes couldn't be saved">{k.saveError} The kit has been reloaded from the server.</Banner>}
      {regen?.status === 'running' && <Banner>Regenerating {regen.section.replace('questions:', '')}… You can keep editing; your changes will be kept.</Banner>}
      {regen && regen.status !== 'running' && regenKey !== dismissedRegen && Date.now() - Date.parse(regen.finishedAt ?? '0') < 120_000 && (
        <Banner tone={regen.status === 'failed' ? 'error' : 'success'} title={regen.status === 'failed' ? `Regenerating ${regen.section} failed` : `Regenerated ${regen.section}`} action={<Button size="sm" variant="ghost" onClick={() => setDismissedRegen(regenKey)}>Dismiss</Button>}>
          {regen.message}
        </Banner>
      )}
      {uncoveredMust.length > 0 && (
        <Banner tone="warn" title={`${uncoveredMust.length} must-have requirement(s) have no question`} action={<Button size="sm" onClick={() => select('questions')}>Go to questions</Button>}>
          {uncoveredMust.map((id) => kit.role.requirements.find((r) => r.id === id)?.text).join('; ')}
        </Banner>
      )}
      {notes.length > 0 && (
        <details className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm" open={notes.some((n) => NOTE_TONE(n) === 'warn')}>
          <summary className="cursor-pointer font-medium text-slate-700">
            Research notes <Badge tone={notes.some((n) => NOTE_TONE(n) === 'warn') ? 'amber' : 'slate'}>{notes.length}</Badge>
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">{notes.map((n) => <li key={n}>{prettyNote(n)}</li>)}</ul>
        </details>
      )}

      <div role="tablist" aria-label="Kit sections" className="-mx-4 flex overflow-x-auto border-b border-slate-200 px-4 sm:mx-0 sm:px-0" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[t] = el;
            }}
            role="tab"
            id={`tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => select(t)}
            className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === t ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}
          >
            {TAB_LABEL[t]}
            {t === 'schedule' && view.scheduleStale && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle" aria-label="(out of date)" />}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'overview' && <Overview kit={kit} dispatch={dispatch} regen={regen} onRegenerate={regenerate} goToQuestions={() => select('questions')} />}
        {tab === 'questions' && <QuestionBoard kit={kit} dispatch={dispatch} regen={regen} onRegenerate={regenerate} />}
        {tab === 'flashcards' && <Flashcards kit={kit} dispatch={dispatch} regen={regen} onRegenerate={regenerate} />}
        {tab === 'schedule' && <Schedule kit={kit} stale={view.scheduleStale} regen={regen} onRegenerate={regenerate} />}
        {tab === 'practice' && <Practice kitId={view.id} kit={kit} />}
        {tab === 'stories' && <StoryBank kitId={view.id} kit={kit} initial={view.stories ?? []} />}
      </div>
    </div>
  );
}
