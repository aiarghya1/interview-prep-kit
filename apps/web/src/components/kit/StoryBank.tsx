'use client';
/**
 * Story bank (creative feature). The candidate writes their own STAR stories
 * and tags the requirements each one demonstrates; code shows which
 * must-haves no story covers, which story to use for each behavioural /
 * company-fit question, and which story is being leaned on too hard.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Kit } from '@kit/core/schema';
import { analyseStories, type Story } from '@kit/core/stories';
import { api } from '@/lib/api';
import { Badge, Banner, Button, Card, EmptyState, cx } from '../ui';
import { InlineText } from './InlineText';
import { CATEGORY_LABEL } from './labels';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function nextId(stories: Story[]) {
  return `s${stories.reduce((m, s) => Math.max(m, Number(s.id.slice(1))), 0) + 1}`;
}

export function StoryBank({ kitId, kit, initial }: { kitId: string; kit: Kit; initial: Story[] }) {
  const [stories, setStories] = useState<Story[]>(initial);
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const dirty = useRef(false);

  const persist = async (list: Story[]) => {
    setSave('saving');
    try {
      await api(`/kits/${kitId}/stories`, { method: 'PUT', body: { stories: list } });
      dirty.current = false;
      setSave('saved');
      setError(null);
    } catch (err) {
      setSave('error');
      setError((err as Error).message);
    }
  };

  const update = (fn: (s: Story[]) => Story[]) => {
    setStories((cur) => {
      const next = fn(cur);
      dirty.current = true;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void persist(next), 700);
      return next;
    });
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const patch = (id: string, p: Partial<Story>) => update((list) => list.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const analysis = useMemo(() => analyseStories(kit, stories), [kit, stories]);
  const title = (id: string) => stories.find((s) => s.id === id)!.title;
  const questions = kit.questions.filter((q) => q.category === 'behavioural' || q.category === 'company-fit');
  const must = kit.role.requirements.filter((r) => r.priority === 'must');

  return (
    <div className="space-y-4">
      <Banner>
        You can&apos;t rehearse fifteen stories, but four or five well-practised ones can answer almost anything. Write yours here and tag what each one shows; the checks on the right
        tell you what&apos;s missing. Nothing here is generated: it&apos;s your experience.
      </Banner>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Your stories <span className="font-normal text-slate-500">({stories.length})</span></h2>
            <span role="status" aria-live="polite" className={cx('text-xs', save === 'error' ? 'text-red-700' : 'text-slate-500')}>
              {save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved' : save === 'error' ? `Not saved: ${error}` : ''}
            </span>
          </div>
          {stories.length === 0 && <EmptyState title="No stories yet">Start with the project you&apos;re proudest of, a conflict you resolved, and a time something went wrong.</EmptyState>}
          {stories.map((s) => (
            <Card key={s.id} className="!p-4">
              <div className="flex items-start justify-between gap-2">
                <InlineText value={s.title} label={`Story ${s.id} title`} required multiline={false} className="text-base font-semibold" onCommit={(v) => patch(s.id, { title: v })} />
                <div className="flex shrink-0 items-center gap-1">
                  {analysis.overused.includes(s.id) && <Badge tone="amber">Overused</Badge>}
                  <span className="text-xs text-slate-500">{analysis.usage[s.id]} Q</span>
                  <Button size="sm" variant="ghost" className="text-red-700 hover:bg-red-50" aria-label={`Delete story ${s.title}`} onClick={() => update((l) => l.filter((x) => x.id !== s.id))}>
                    Delete
                  </Button>
                </div>
              </div>
              {(['situation', 'action', 'result'] as const).map((f) => (
                <div key={f} className="mt-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{f === 'situation' ? 'Situation & task' : f === 'action' ? 'What you did' : 'Result'}</p>
                  <InlineText
                    value={s[f]}
                    label={`${s.title}: ${f}`}
                    placeholder={f === 'situation' ? 'Context and what was at stake…' : f === 'action' ? 'The specific things you did (say “I”, not “we”)…' : 'Measurable outcome, and what you learned…'}
                    className="text-sm text-slate-700"
                    onCommit={(v) => patch(s.id, { [f]: v })}
                  />
                </div>
              ))}
              <fieldset className="mt-3">
                <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">This story shows</legend>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {kit.role.requirements.map((r) => {
                    const on = s.requirement_ids.includes(r.id);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => patch(s.id, { requirement_ids: on ? s.requirement_ids.filter((x) => x !== r.id) : [...s.requirement_ids, r.id] })}
                        className={cx('rounded-full border px-2 py-0.5 text-xs', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400')}
                      >
                        {r.text.length > 40 ? `${r.text.slice(0, 39)}…` : r.text}
                        {r.priority === 'must' && !on && <span className="ml-0.5 text-red-600" aria-label="must-have">*</span>}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            </Card>
          ))}
          <Button
            variant="primary"
            disabled={stories.length >= 15}
            onClick={() => update((l) => [...l, { id: nextId(l), title: 'New story', situation: '', action: '', result: '', requirement_ids: [] }])}
          >
            + Add a story
          </Button>
        </div>

        <div className="space-y-4">
          <Card>
            <h3 className="font-semibold">Must-haves your stories cover</h3>
            {must.length === 0 ? (
              <p className="mt-1 text-sm text-slate-600">The posting lists no must-have requirements.</p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-sm">
                {must.map((r) => {
                  const by = analysis.byRequirement[r.id]!;
                  return (
                    <li key={r.id} className={cx('rounded px-2 py-1', by.length === 0 && 'bg-amber-50')}>
                      <span className={cx(by.length === 0 && 'font-medium')}>{r.text}</span>
                      <span className="block text-xs text-slate-500">{by.length ? by.map(title).join(', ') : r.kind === 'technical' ? 'No story yet: a project walkthrough would cover this' : 'No story yet: worth writing one'}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {stories.length > 0 && analysis.mustGaps.length === 0 && must.length > 0 && <p className="mt-2 text-sm font-medium text-emerald-700">Every must-have has a story behind it.</p>}
          </Card>

          <Card>
            <h3 className="font-semibold">Which story for which question</h3>
            {questions.length === 0 ? (
              <p className="mt-1 text-sm text-slate-600">No behavioural or company-fit questions in this kit.</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {questions.map((q) => {
                  const m = analysis.byQuestion[q.id]!;
                  return (
                    <li key={q.id}>
                      <p className="text-slate-800"><span className="mr-1 text-xs text-slate-400">{CATEGORY_LABEL[q.category]}</span>{q.prompt}</p>
                      <p className={cx('text-xs', m.length ? 'text-brand-700' : 'text-amber-700')}>
                        {m.length ? <>Use <strong>{title(m[0]!.storyId)}</strong>{m[1] && <> (or {title(m[1].storyId)})</>}</> : 'No story fits yet'}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {(analysis.overused.length > 0 || analysis.unused.length > 0) && (
            <Card>
              {analysis.overused.map((id) => (
                <p key={id} className="text-sm text-amber-800">
                  <strong>{title(id)}</strong> is your best answer to {analysis.usage[id]} questions. Interviewers notice the same story twice, so prepare a second one for some of them.
                </p>
              ))}
              {analysis.unused.map((id) => (
                <p key={id} className="mt-1 text-sm text-slate-600"><strong>{title(id)}</strong> isn&apos;t tagged with any requirement and doesn&apos;t fit any question yet.</p>
              ))}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
