import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { GenerationProgress } from '@/components/kit/GenerationProgress';
import { InlineText } from '@/components/kit/InlineText';
import { RegenButton } from '@/components/kit/RegenButton';
import { Schedule } from '@/components/kit/Schedule';
import { Flashcards } from '@/components/kit/Flashcards';
import { Overview } from '@/components/kit/Overview';
import { NOTE_TONE, prettyNote } from '@/components/kit/labels';
import { richKit, view } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('GenerationProgress', () => {
  it('shows steps with their states, elapsed time, provider waits and the latest message', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-20T00:01:05Z'));
    const now = '2026-11-20T00:01:00Z';
    render(
      <GenerationProgress
        onRetry={async () => {}}
        view={view({
          status: 'running',
          kit: null,
          createdAt: '2026-11-20T00:00:00Z',
          input: { jd: '', company_url: 'acme.com', days: 1 },
          progress: [
            { step: 'queued', status: 'running', message: 'Waiting', at: '2026-11-20T00:00:00Z' },
            { step: 'extract', status: 'done', message: '5 requirement(s)', at: '2026-11-20T00:00:30Z' },
            { step: 'crawl', status: 'running', message: 'Fetched /about', at: now },
            { step: 'discussion', status: 'skipped', message: 'no name', at: now },
            { step: 'questions:technical', status: 'running', message: '', at: now },
            { step: 'custom-step', status: 'failed', message: 'odd', at: now },
            { step: 'llm', status: 'running', message: 'Provider asked us to slow down (waiting 8s)', at: now },
          ],
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Building your kit' })).toBeInTheDocument();
    expect(screen.getByText('acme.com · 1 day')).toBeInTheDocument();
    expect(screen.getByLabelText('Elapsed time')).toHaveTextContent('0:35');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByLabelText('Elapsed time')).toHaveTextContent('0:36');
    const steps = within(screen.getByRole('list', { name: 'Generation steps' }));
    expect(steps.getByText('Reading the job description')).toHaveTextContent('— done');
    expect(steps.getByText('Crawling the company site')).toHaveTextContent('— running');
    expect(steps.getByText('Technical questions')).toBeInTheDocument();
    expect(steps.queryByText('Behavioural questions')).toBeNull();
    expect(steps.getByText('custom-step')).toHaveTextContent('— failed');
    expect(steps.getByText('Writing flashcards')).toHaveTextContent('— pending');
    expect(screen.getByText(/slow down \(waiting 8s\)\. Free-tier AI limits/)).toBeInTheDocument();
    expect(screen.getByText('Latest: Provider asked us to slow down (waiting 8s)')).toBeInTheDocument();
  });

  it('queued state without progress uses the creation time and says "Starting…"', () => {
    render(<GenerationProgress onRetry={async () => {}} view={view({ status: 'queued', kit: null, progress: [] })} />);
    expect(screen.getByRole('heading', { name: 'Waiting to start…' })).toBeInTheDocument();
    expect(screen.getByText('Latest: Starting…')).toBeInTheDocument();
  });

  it('failure: plain-language reason, stopped steps, and retry', async () => {
    let finish!: () => void;
    const onRetry = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const { rerender } = render(
      <GenerationProgress
        onRetry={onRetry}
        view={view({ status: 'failed', kit: null, error: { code: 'LLM_RATE_LIMITED', message: 'quota' }, progress: [{ step: 'crawl', status: 'running', message: 'x', at: '' }, { step: 'failed', status: 'failed', message: 'quota', at: '' }] })}
      />,
    );
    expect(screen.getByRole('heading', { name: "We couldn't build this kit" })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("free quota is used up");
    expect(screen.getByText('Crawling the company site')).toHaveTextContent('— stopped');
    expect(screen.queryByLabelText('Elapsed time')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveAttribute('aria-busy', 'true');
    await act(async () => finish());
    expect(onRetry).toHaveBeenCalled();
    rerender(<GenerationProgress onRetry={onRetry} view={view({ status: 'failed', kit: null, error: { code: 'WHO_KNOWS', message: 'x' } })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while generating.');
    rerender(<GenerationProgress onRetry={onRetry} view={view({ status: 'failed', kit: null, error: null })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
  });
});

/** InlineText as the app uses it: the parent stores what was committed. */
function Controlled({ initial, onCommit, ...rest }: { initial: string; onCommit: (v: string) => void; label: string; required?: boolean }) {
  const [value, setValue] = useState(initial);
  return <InlineText {...rest} value={value} onCommit={(v) => { onCommit(v); setValue(v); }} />;
}

describe('InlineText', () => {
  it('commits on blur, trims, skips unchanged text, and reverts on Escape', async () => {
    const onCommit = vi.fn();
    render(<Controlled initial="Hello" label="Field" onCommit={onCommit} />);
    const box = screen.getByLabelText('Field');
    await userEvent.click(box);
    await userEvent.type(box, ' world ');
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledWith('Hello world');
    await userEvent.click(box);
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledTimes(1);
    await userEvent.click(box);
    await userEvent.type(box, 'xx{Escape}');
    expect(box).toHaveValue('Hello world');
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('commits with Ctrl/Cmd+Enter or after a pause; required fields refuse empty text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onCommit = vi.fn();
    render(<Controlled initial="A" label="Req" required onCommit={onCommit} />);
    const box = screen.getByLabelText('Req');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'AB' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onCommit).toHaveBeenLastCalledWith('AB');
    fireEvent.change(box, { target: { value: 'ABC' } });
    fireEvent.keyDown(box, { key: 'Enter' }); // plain Enter in a multi-line field is a newline
    expect(onCommit).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1200));
    expect(onCommit).toHaveBeenLastCalledWith('ABC');
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.blur(box);
    expect(box).toHaveValue('ABC');
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('single-line mode strips newlines and commits on Enter; picks up outside changes when not editing', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<InlineText value="One" label="Title" multiline={false} placeholder="p" onCommit={onCommit} />);
    const box = screen.getByLabelText('Title');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Two\nlines' } });
    expect(box).toHaveValue('Two lines');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('Two lines');
    rerender(<InlineText value="From server" label="Title" multiline={false} onCommit={onCommit} />);
    expect(box).toHaveValue('Two lines'); // still focused: user's text wins
    fireEvent.blur(box);
    rerender(<InlineText value="From server 2" label="Title" multiline={false} onCommit={onCommit} />);
    expect(box).toHaveValue('From server 2');
  });
});

describe('RegenButton', () => {
  it('starts a regeneration, shows busy state, and reports errors', async () => {
    const onRegenerate = vi.fn().mockRejectedValueOnce(new Error('Already regenerating brief')).mockResolvedValue(undefined);
    render(<RegenButton section="brief" label="Regenerate brief" regen={null} onRegenerate={onRegenerate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate brief' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Already regenerating brief');
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate brief' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('shows its own run as busy and disables while another section runs', () => {
    const { rerender } = render(<RegenButton section="brief" label="Regenerate brief" regen={{ section: 'brief', status: 'running' }} onRegenerate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Regenerating…' })).toHaveAttribute('aria-busy', 'true');
    rerender(<RegenButton section="brief" label="Regenerate brief" regen={{ section: 'flashcards', status: 'running' }} onRegenerate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Regenerate brief' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Regenerate brief' })).toHaveAttribute('title', 'Wait for flashcards to finish');
  });
});

describe('Schedule', () => {
  it('lists days with focus, durations and questions; offers a rebuild when stale', async () => {
    const kit = richKit();
    kit.schedule.days[0] = { ...kit.schedule.days[0]!, minutes: 125, question_ids: ['q1', 'q99'] };
    kit.schedule.days[1] = { ...kit.schedule.days[1]!, minutes: 60, question_ids: ['q2'] };
    kit.schedule.days[2] = { ...kit.schedule.days[2]!, minutes: 45, question_ids: [] };
    const onRegenerate = vi.fn().mockResolvedValue(undefined);
    render(<Schedule kit={kit} stale regen={null} onRegenerate={onRegenerate} />);
    expect(screen.getByText(/3 days · 3h 50m total/)).toBeInTheDocument();
    expect(screen.getByText('2h 5m')).toBeInTheDocument();
    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('45m')).toBeInTheDocument();
    expect(screen.getByText('2 questions')).toBeInTheDocument();
    expect(screen.getByText('1 question')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Rebuild now' }));
    expect(onRegenerate).toHaveBeenCalledWith('schedule');
  });
  it('singular day wording and no stale banner', () => {
    const kit = richKit();
    kit.schedule = { days_available: 1, days: [{ day: 1, focus: 'All', question_ids: [], minutes: 30 }] };
    render(<Schedule kit={kit} stale={false} regen={null} onRegenerate={vi.fn()} />);
    expect(screen.getByText(/1 day · 30m total/)).toBeInTheDocument();
    expect(screen.queryByText('Rebuild now')).toBeNull();
  });
});

describe('Flashcards', () => {
  it('edits, pins, deletes and adds cards', async () => {
    const kit = richKit();
    kit.flashcards[1] = { ...kit.flashcards[1]!, state: { origin: 'generated', edited: false, pinned: true } };
    const dispatch = vi.fn();
    render(<Flashcards kit={kit} dispatch={dispatch} regen={null} onRegenerate={vi.fn()} />);
    expect(screen.getByText('2 cards. Practise them in the Practice tab.')).toBeInTheDocument();
    const back = screen.getByLabelText('Card 1 back');
    fireEvent.focus(back);
    fireEvent.change(back, { target: { value: 'New back' } });
    fireEvent.blur(back);
    expect(dispatch).toHaveBeenCalledWith({ op: 'flashcard.update', id: 'f1', patch: { back: 'New back' } });
    const front = screen.getByLabelText('Card 1 front');
    fireEvent.focus(front);
    fireEvent.change(front, { target: { value: 'New front' } });
    fireEvent.blur(front);
    expect(dispatch).toHaveBeenCalledWith({ op: 'flashcard.update', id: 'f1', patch: { front: 'New front' } });
    await userEvent.click(screen.getAllByRole('button', { name: 'Pin' })[0]!);
    expect(dispatch).toHaveBeenCalledWith({ op: 'pin', target: 'flashcard', id: 'f1', pinned: true });
    await userEvent.click(screen.getByRole('button', { name: 'Unpin' }));
    expect(dispatch).toHaveBeenCalledWith({ op: 'pin', target: 'flashcard', id: 'f2', pinned: false });
    await userEvent.click(screen.getByRole('button', { name: 'Delete card 2' }));
    expect(dispatch).toHaveBeenCalledWith({ op: 'flashcard.delete', id: 'f2' });
    expect(screen.getByRole('button', { name: 'Add card' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Front'), 'Q?');
    await userEvent.type(screen.getByLabelText('Back'), 'A.');
    await userEvent.click(screen.getByRole('button', { name: 'Add card' }));
    expect(dispatch).toHaveBeenLastCalledWith({ op: 'flashcard.add', tempId: expect.stringMatching(/^tmp-/), card: { front: 'Q?', back: 'A.' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Add card' }).closest('form')!);
    expect(dispatch).toHaveBeenCalledTimes(6);
  });
  it('empty state', () => {
    const kit = richKit();
    kit.flashcards = [];
    render(<Flashcards kit={kit} dispatch={vi.fn()} regen={null} onRegenerate={vi.fn()} />);
    expect(screen.getByText('No flashcards')).toBeInTheDocument();
  });
});

describe('Overview', () => {
  it('shows brief, interview process, requirements with coverage, responsibilities and the research log', async () => {
    const kit = richKit();
    kit.role.responsibilities = ['Own the API'];
    kit.questions = kit.questions.filter((q) => !q.requirement_ids.includes('r3'));
    kit.company_brief.state = { origin: 'generated', edited: true, pinned: true };
    kit.source.location = 'Remote';
    kit.source.pages_used = ['https://acme.example/', 'not a url'];
    const dispatch = vi.fn();
    const goToQuestions = vi.fn();
    render(<Overview kit={kit} dispatch={dispatch} regen={null} onRegenerate={vi.fn()} goToQuestions={goToQuestions} />);
    expect(screen.getByText('Edited')).toBeInTheDocument();
    const summary = screen.getByLabelText('Company summary');
    fireEvent.focus(summary);
    fireEvent.change(summary, { target: { value: 'Mine' } });
    fireEvent.blur(summary);
    expect(dispatch).toHaveBeenCalledWith({ op: 'brief.update', patch: { summary: 'Mine' } });
    const what = screen.getByLabelText('What the company does');
    fireEvent.focus(what);
    fireEvent.change(what, { target: { value: 'Payments' } });
    fireEvent.blur(what);
    expect(dispatch).toHaveBeenCalledWith({ op: 'brief.update', patch: { what_they_do: 'Payments' } });
    await userEvent.click(screen.getByRole('button', { name: 'Unpin' }));
    expect(dispatch).toHaveBeenCalledWith({ op: 'pin', target: 'brief', pinned: false });
    expect(screen.getByRole('link', { name: 'acme.example/about' })).toHaveAttribute('href', 'https://acme.example/about');
    expect(screen.getByText('From the company’s own hiring page.')).toBeInTheDocument();
    expect(screen.getByText('Screen')).toBeInTheDocument();
    expect(screen.getByText('— Recruiter call')).toBeInTheDocument();
    expect(screen.getByText('Take-home')).toBeInTheDocument();
    expect(screen.getByText('mystery')).toBeInTheDocument();
    expect(screen.getByText('Write a README')).toBeInTheDocument();
    expect(screen.getByText('senior · Remote · Acme')).toBeInTheDocument();
    expect(screen.getByTitle('From the posting: “Strong Node.js and TypeScript”')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'No questions' }));
    expect(goToQuestions).toHaveBeenCalled();
    expect(screen.getByText('Own the API')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'acme.example' })).toBeInTheDocument();
    expect(screen.getByText('not a url')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Acme interview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'reddit.com/r/x' })).toBeInTheDocument();
    expect(screen.getByText('acme.example/careers: HTTP 404')).toBeInTheDocument();
    expect(screen.getByText('Pass 2 closed no gaps; stopping early.')).toBeInTheDocument();
  });

  it('is honest when nothing is known: sparse brief, anecdotal or missing process, no requirements', () => {
    const kit = richKit();
    kit.company_brief.sources = [];
    delete kit.company_brief.state;
    kit.research!.hiring_process = { ...kit.research!.hiring_process, source_type: 'discussion', stages: [], formats: [], tips: [] };
    kit.research!.discussion = [];
    kit.research!.skipped_sources = [];
    kit.coverage = { uncovered_requirement_ids: [], passes: 1 };
    kit.role.requirements = [];
    kit.role.title = '';
    render(<Overview kit={kit} dispatch={vi.fn()} regen={null} onRegenerate={vi.fn()} goToQuestions={vi.fn()} />);
    expect(screen.getByText(/deliberately sparse instead of guessed/)).toBeInTheDocument();
    expect(screen.getByText(/anecdotal, may be out of date/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The role' })).toBeInTheDocument();
    expect(screen.getByText(/doesn.t state any specific requirements/)).toBeInTheDocument();
    expect(screen.getByText(/checked in 1 pass\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pin' })).toBeInTheDocument();
  });

  it('says when no interview process was found, and copes with kits without research', () => {
    const kit = richKit();
    delete kit.research;
    render(<Overview kit={kit} dispatch={vi.fn()} regen={null} onRegenerate={vi.fn()} goToQuestions={vi.fn()} />);
    expect(screen.getByText(/No published interview process was found/)).toBeInTheDocument();
  });
});

describe('labels', () => {
  it('flags warning notes and strips machine prefixes', () => {
    expect(NOTE_TONE('COMPANY_UNREACHABLE: x')).toBe('warn');
    expect(NOTE_TONE('NO_HIRING_PAGE: x')).toBe('info');
    expect(prettyNote('NO_HIRING_PAGE: nothing found')).toBe('nothing found');
  });
});

void waitFor;
