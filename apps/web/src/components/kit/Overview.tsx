'use client';
import type { Kit } from '@kit/core/schema';
import type { EditOpInput } from '@kit/core/edit';
import type { RegenState } from '@/lib/types';
import { Badge, Banner, Button, Card, cx } from '../ui';
import { InlineText } from './InlineText';
import { RegenButton } from './RegenButton';
import { StateBadges } from './QuestionBoard';

const FORMAT_LABEL: Record<string, string> = {
  take_home: 'Take-home',
  system_design: 'System design',
  live_coding: 'Live coding / pairing',
  behavioural: 'Behavioural',
  recruiter_screen: 'Recruiter screen',
  onsite: 'Onsite / final loop',
};

function host(u: string) {
  try {
    const url = new URL(u);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return u;
  }
}

export function Overview({ kit, dispatch, regen, onRegenerate, goToQuestions }: { kit: Kit; dispatch: (op: EditOpInput) => void; regen: RegenState | null; onRegenerate: (s: string) => Promise<void>; goToQuestions: () => void }) {
  const brief = kit.company_brief;
  const counts = new Map(kit.role.requirements.map((r) => [r.id, kit.questions.filter((q) => q.requirement_ids.includes(r.id)).length]));
  const hp = kit.research?.hiring_process;
  const nothingKnown = brief.sources.length === 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-6">
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              Company brief <StateBadges state={brief.state} />
            </h2>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" aria-pressed={!!brief.state?.pinned} onClick={() => dispatch({ op: 'pin', target: 'brief', pinned: !brief.state?.pinned })}>
                {brief.state?.pinned ? 'Unpin' : 'Pin'}
              </Button>
              <RegenButton section="brief" label="Regenerate brief" regen={regen} onRegenerate={onRegenerate} note="An edited or pinned brief is never replaced." />
            </div>
          </div>
          {nothingKnown && <div className="mb-3"><Banner tone="warn">We couldn&apos;t find reliable information about this company, so this brief is deliberately sparse instead of guessed.</Banner></div>}
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Summary</h3>
          <InlineText value={brief.summary} label="Company summary" className="text-sm leading-relaxed text-slate-800" onCommit={(v) => dispatch({ op: 'brief.update', patch: { summary: v } })} />
          <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">What they do</h3>
          <InlineText value={brief.what_they_do} label="What the company does" className="text-sm leading-relaxed text-slate-800" onCommit={(v) => dispatch({ op: 'brief.update', patch: { what_they_do: v } })} />
          {brief.sources.length > 0 && (
            <p className="mt-3 text-xs text-slate-500">
              Sources:{' '}
              {brief.sources.map((s, i) => (
                <span key={s}>
                  {i > 0 && ', '}
                  <a href={s} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2 hover:text-slate-800">{host(s)}</a>
                </span>
              ))}
            </p>
          )}
        </Card>

        <Card>
          <h2 className="text-lg font-semibold">How they interview</h2>
          {hp?.found ? (
            <div className="mt-2 space-y-3 text-sm">
              <p className="text-slate-600">
                {hp.source_type === 'official' ? 'From the company’s own hiring page.' : 'From public discussion: anecdotal, may be out of date.'}
              </p>
              {hp.stages.length > 0 && (
                <ol className="space-y-1.5">
                  {hp.stages.map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{i + 1}</span>
                      <span><strong className="font-medium">{s.name}</strong>{s.description && <span className="text-slate-600"> — {s.description}</span>}</span>
                    </li>
                  ))}
                </ol>
              )}
              {hp.formats.length > 0 && <div className="flex flex-wrap gap-1">{hp.formats.map((f) => <Badge key={f} tone="brand">{FORMAT_LABEL[f] ?? f}</Badge>)}</div>}
              {hp.tips.length > 0 && <ul className="list-disc space-y-1 pl-5 text-slate-700">{hp.tips.map((t) => <li key={t}>{t}</li>)}</ul>}
              <p className="text-xs text-slate-500">Questions were tailored to these stages.</p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-slate-600">No published interview process was found on the company site or in public discussion, so questions don&apos;t assume a particular format.</p>
          )}
        </Card>
      </div>

      <div className="space-y-6">
        <Card>
          <h2 className="text-lg font-semibold">{kit.role.title || 'The role'}</h2>
          <p className="text-sm text-slate-500">{[kit.role.seniority, kit.source.location, kit.source.company].filter(Boolean).join(' · ')}</p>
          <h3 className="mt-4 text-sm font-semibold">Requirements &amp; coverage</h3>
          {kit.role.requirements.length === 0 ? (
            <p className="mt-1 text-sm text-slate-600">The description doesn&apos;t state any specific requirements.</p>
          ) : (
            <ul className="mt-2 space-y-1.5 text-sm">
              {kit.role.requirements.map((r) => {
                const n = counts.get(r.id)!;
                const gap = n === 0;
                return (
                  <li key={r.id} className={cx('flex items-start justify-between gap-2 rounded px-2 py-1', gap && r.priority === 'must' && 'bg-red-50')}>
                    <span className="min-w-0">
                      <span className="mr-1 font-mono text-xs text-slate-400">{r.id}</span>
                      <span title={r.evidence ? `From the posting: “${r.evidence}”` : undefined}>{r.text}</span>
                      <span className="ml-1 inline-flex gap-1 align-middle">
                        <Badge tone={r.priority === 'must' ? 'slate' : 'amber'}>{r.priority === 'must' ? 'Must' : 'Nice'}</Badge>
                        <Badge>{r.kind}</Badge>
                      </span>
                    </span>
                    <button type="button" onClick={goToQuestions} className={cx('shrink-0 rounded px-1.5 text-xs', gap ? 'font-semibold text-red-700' : 'text-slate-500 hover:text-slate-900')}>
                      {gap ? 'No questions' : `${n} Q`}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">Coverage checked in {kit.coverage.passes} pass{kit.coverage.passes === 1 ? '' : 'es'}. Hover a requirement to see the posting text it came from.</p>
        </Card>

        {kit.role.responsibilities.length > 0 && (
          <Card>
            <h3 className="text-sm font-semibold">Responsibilities</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">{kit.role.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul>
          </Card>
        )}

        <Card>
          <details>
            <summary className="cursor-pointer text-sm font-semibold">Research log</summary>
            <div className="mt-3 space-y-3 text-xs text-slate-600">
              <div>
                <p className="font-medium text-slate-800">Pages used ({kit.source.pages_used.length})</p>
                <ul className="mt-1 space-y-0.5">{kit.source.pages_used.map((p) => <li key={p} className="truncate"><a className="underline underline-offset-2" href={p} target="_blank" rel="noopener noreferrer nofollow">{host(p)}</a></li>)}</ul>
              </div>
              {(kit.research?.discussion.length ?? 0) > 0 && (
                <div>
                  <p className="font-medium text-slate-800">Public discussion</p>
                  <ul className="mt-1 space-y-0.5">{kit.research!.discussion.map((d) => <li key={d.url} className="truncate">[{d.source}] <a className="underline underline-offset-2" href={d.url} target="_blank" rel="noopener noreferrer nofollow">{d.title || host(d.url)}</a></li>)}</ul>
                </div>
              )}
              {(kit.research?.skipped_sources.length ?? 0) > 0 && (
                <div>
                  <p className="font-medium text-slate-800">Skipped sources</p>
                  <ul className="mt-1 space-y-0.5">{kit.research!.skipped_sources.map((s, i) => <li key={i} className="break-all">{host(s.url)}: {s.reason}</li>)}</ul>
                </div>
              )}
              {(kit.coverage.notes?.length ?? 0) > 0 && (
                <div>
                  <p className="font-medium text-slate-800">Coverage notes</p>
                  <ul className="mt-1 list-disc pl-4">{kit.coverage.notes!.map((n) => <li key={n}>{n}</li>)}</ul>
                </div>
              )}
              <p>Researched {new Date(kit.source.researched_at).toLocaleString()}</p>
            </div>
          </details>
        </Card>
      </div>
    </div>
  );
}
