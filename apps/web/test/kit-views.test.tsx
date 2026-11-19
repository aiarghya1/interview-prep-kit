import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordReview } from '@kit/core/practice';
import { Practice } from '@/components/kit/Practice';
import { StoryBank } from '@/components/kit/StoryBank';
import { KitWorkspace } from '@/components/kit/KitWorkspace';
import KitPage from '@/app/kits/[id]/page';
import type { useKit } from '@/lib/useKit';
import type { PracticeView } from '@/lib/types';
import { mockApi } from './http';
import { nav } from './nav';
import { richKit, view } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', window.location.pathname); // tabs read the hash
});

const practice = (o: Partial<PracticeView['summary']> = {}, order = ['f1', 'f2'], progress = {}): PracticeView => ({
  progress,
  order,
  summary: { total: 2, seen: 0, unseen: 2, byConfidence: { 1: 0, 2: 0, 3: 0 }, due: 0, requirementsSolid: [], requirementsUntouched: [], ...o },
});

describe('Practice', () => {
  it('runs a session: reveal, rate by click and by key, requeue a card you did not know, finish', async () => {
    const posts: unknown[] = [];
    mockApi({
      'GET /kits/k1/practice': practice({ unseen: 2 }, ['f2', 'f1', 'f-gone']),
      'POST /kits/k1/practice': (b) => (posts.push(b), practice({ seen: 1, unseen: 1, byConfidence: { 1: 1, 2: 0, 3: 0 }, requirementsUntouched: ['r4', 'rX'], requirementsSolid: ['r1'] })),
    });
    render(<Practice kitId="k1" kit={richKit()} />);
    expect(screen.getByText(/Loading…/)).toBeInTheDocument();
    expect(await screen.findByText(/2 new cards, must-haves first/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start session' }));
    const card = screen.getByRole('group', { name: /Press space to reveal/ });
    expect(card).toHaveTextContent('B'); // f2 first, per server order
    expect(screen.getByText('0 done · 2 left')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Reveal answer/ }));
    expect(screen.getByText('b')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Didn't know/ }));
    await waitFor(() => expect(screen.getByText('1 done · 2 left')).toBeInTheDocument()); // f2 requeued at the end
    expect(posts[0]).toEqual({ cardId: 'f2', confidence: 1 });
    card.focus();
    fireEvent.keyDown(card, { key: ' ' });
    expect(screen.getByText('a')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: '3' });
    await waitFor(() => expect(screen.getByText('2 done · 1 left')).toBeInTheDocument());
    fireEvent.keyDown(screen.getByRole('group', { name: /flashcard|reveal/i }), { key: 'Enter' });
    fireEvent.keyDown(document.body, { key: '1' });
    await waitFor(() => expect(screen.getByText('Session done: 3 cards reviewed')).toBeInTheDocument());
    expect(posts).toHaveLength(3); // the requeued card isn't requeued twice
    expect(screen.getByText('Not practised yet')).toBeInTheDocument();
    expect(screen.getByText('rX')).toBeInTheDocument();
    expect(screen.getByText('Feeling solid on')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start another session' }));
    await userEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect(screen.getByRole('button', { name: 'Start session' })).toBeInTheDocument();
  });

  it('ignores keys typed into fields and before reveal; shows cards without answers', async () => {
    const kit = richKit();
    kit.flashcards[0]!.back = '';
    const api = mockApi({ 'GET /kits/k1/practice': practice({ due: 1 }, ['f1']), 'POST /kits/k1/practice': practice() });
    render(<><input aria-label="elsewhere" /><Practice kitId="k1" kit={kit} /></>);
    expect(await screen.findByText(/1 card due for review, least confident first/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start session' }));
    fireEvent.keyDown(document.body, { key: '3' }); // not revealed yet
    fireEvent.keyDown(screen.getByLabelText('elsewhere'), { key: ' ' });
    expect(screen.queryByText('No answer written for this card.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Reveal answer/ }));
    expect(screen.getByText('No answer written for this card.')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('elsewhere'), { key: '2' });
    fireEvent.keyDown(document.body, { key: 'x' });
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('shows due/plural copy, a rating error, a load error with retry, and resets progress', async () => {
    let fail = true;
    const solid = recordReview(undefined, 3, new Date());
    mockApi({
      'GET /kits/k1/practice': () => (fail ? { status: 500, body: { error: { code: 'X', message: 'Practice down' } } } : practice({ seen: 2, unseen: 0, due: 2, byConfidence: { 1: 0, 2: 1, 3: 1 } }, ['f1', 'f2'], { f1: solid })),
      'POST /kits/k1/practice': { status: 500, body: { error: { code: 'X', message: 'Could not save rating' } } },
      'DELETE /kits/k1/practice': practice(),
    });
    render(<Practice kitId="k1" kit={richKit()} />);
    expect(await screen.findByText('Practice down')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/2 cards due for review/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /1 solid, 1 shaky, 0 not known, 0 not seen/ })).toBeInTheDocument();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Reset progress' }));
    expect(screen.getByText(/2 of 2 cards practised/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reset progress' }));
    expect(await screen.findByText(/0 of 2 cards practised/)).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole('button', { name: 'Start session' }));
    await userEvent.click(screen.getByRole('button', { name: /Reveal answer/ }));
    await userEvent.click(screen.getByRole('button', { name: /Solid/ }));
    expect(await screen.findByText('Could not save rating')).toBeInTheDocument();
  });

  it('nothing due and nothing new; no flashcards at all', async () => {
    mockApi({ 'GET /kits/k1/practice': practice({ seen: 2, unseen: 0, due: 0 }) });
    render(<Practice kitId="k1" kit={richKit()} />);
    expect(await screen.findByText(/Nothing due\. Review anyway/)).toBeInTheDocument();
    const empty = richKit();
    empty.flashcards = [];
    render(<Practice kitId="k1" kit={empty} />);
    expect(await screen.findByText('No flashcards to practise')).toBeInTheDocument();
  });

  it('ignores a second rating while the first is saving', async () => {
    let release!: () => void;
    const api = mockApi({ 'GET /kits/k1/practice': practice(), 'POST /kits/k1/practice': () => new Promise((r) => (release = () => r(practice()))) });
    render(<Practice kitId="k1" kit={richKit()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start session' }));
    await userEvent.click(screen.getByRole('button', { name: /Reveal answer/ }));
    fireEvent.keyDown(document.body, { key: '2' });
    fireEvent.keyDown(document.body, { key: '2' });
    await act(async () => release());
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('StoryBank', () => {
  it('adds, edits, tags and deletes stories; saves after a pause; shows coverage and matches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const saves: unknown[] = [];
    mockApi({ 'PUT /kits/k1/stories': (b) => (saves.push(b), b) });
    const kit = richKit();
    kit.questions[2]!.prompt = 'Tell me about mentoring a junior engineer';
    render(<StoryBank kitId="k1" kit={kit} initial={[]} />);
    expect(screen.getByText('No stories yet')).toBeInTheDocument();
    expect(screen.getAllByText(/No story yet/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '+ Add a story' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add a story' }));
    const title = screen.getAllByLabelText('Story s1 title')[0]!;
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Mentoring Sam' } });
    fireEvent.blur(title);
    const action = screen.getByLabelText('Mentoring Sam: action');
    fireEvent.focus(action);
    fireEvent.change(action, { target: { value: 'I paired with a junior engineer weekly' } });
    fireEvent.blur(action);
    const shows = within(screen.getByLabelText('Mentoring Sam: situation').closest('section')!);
    fireEvent.click(shows.getByRole('button', { name: /Requirement r3/ }));
    fireEvent.click(shows.getByRole('button', { name: /Node\.js/ }));
    fireEvent.click(shows.getByRole('button', { name: /Node\.js/ }));
    expect(shows.getByRole('button', { name: /Requirement r3/ })).toHaveAttribute('aria-pressed', 'true');
    await act(() => vi.advanceTimersByTimeAsync(700));
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(saves).toHaveLength(1);
    expect((saves[0] as { stories: { id: string }[] }).stories.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(screen.getByText('Use')).toBeInTheDocument();
    expect(screen.getByText(/isn.t tagged with any requirement and doesn.t fit any question yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete story New story' }));
    await act(() => vi.advanceTimersByTimeAsync(700));
    expect((saves.at(-1) as { stories: unknown[] }).stories).toHaveLength(1);
  });

  it('flags an overused story, shows full must-have coverage and alternatives, and save errors', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockApi({ 'PUT /kits/k1/stories': { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Story ids must be unique' } } } });
    const kit = richKit();
    kit.questions.push(
      { id: 'q7', category: 'behavioural', prompt: 'Another', answer_outline: '', difficulty: 1, requirement_ids: ['r3'] },
      { id: 'q8', category: 'company-fit', prompt: 'Yet another', answer_outline: '', difficulty: 1, requirement_ids: ['r3'] },
    );
    const story = (id: string, tags: string[]) => ({ id, title: `Story ${id}`, situation: '', action: '', result: '', requirement_ids: tags });
    render(<StoryBank kitId="k1" kit={kit} initial={[story('s1', ['r1', 'r2', 'r3']), story('s2', ['r3'])]} />);
    expect(screen.getByText('Overused')).toBeInTheDocument();
    expect(screen.getByText(/is your best answer to 3 questions/)).toBeInTheDocument();
    expect(screen.getByText('Every must-have has a story behind it.')).toBeInTheDocument();
    expect(screen.getAllByText(/\(or Story s2\)/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '+ Add a story' }));
    await act(() => vi.advanceTimersByTimeAsync(700));
    expect(screen.getByText('Not saved: Story ids must be unique')).toBeInTheDocument();
  });

  it('copes with no must-haves, no story questions, long requirement text and the 15-story limit', () => {
    const kit = richKit();
    kit.role.requirements = kit.role.requirements.map((r) => ({ ...r, priority: 'nice' as const, text: `${r.text} with a very long description that goes on` }));
    kit.questions = kit.questions.filter((q) => q.category === 'technical');
    const stories = Array.from({ length: 15 }, (_, i) => ({ id: `s${i + 1}`, title: `S${i + 1}`, situation: '', action: '', result: '', requirement_ids: [] }));
    render(<StoryBank kitId="k1" kit={kit} initial={stories} />);
    expect(screen.getByText('The posting lists no must-have requirements.')).toBeInTheDocument();
    expect(screen.getByText('No behavioural or company-fit questions in this kit.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add a story' })).toBeDisabled();
    expect(screen.getAllByText(/…$/).length).toBeGreaterThan(0);
  });
});

function kitHook(overrides: Partial<ReturnType<typeof useKit>> = {}): ReturnType<typeof useKit> {
  const v = view();
  return {
    view: v,
    kit: v.kit,
    loadError: null,
    reload: vi.fn(),
    dispatch: vi.fn(),
    saveState: 'idle',
    saveError: null,
    unsavedCount: 0,
    regenerate: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn(),
    flush: vi.fn(),
    ...overrides,
  } as ReturnType<typeof useKit>;
}

describe('KitWorkspace', () => {
  it('tabs: click, arrow keys, Home/End, and the URL hash', async () => {
    mockApi({ 'GET /kits/k1/practice': practice() });
    window.history.replaceState(null, '', '#schedule');
    render(<KitWorkspace k={kitHook()} />);
    expect(screen.getByRole('tab', { name: 'Schedule' })).toHaveAttribute('aria-selected', 'true');
    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Practice' })).toHaveFocus();
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Your stories' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Your stories' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tablist, { key: 'a' });
    for (const name of ['Questions', 'Flashcards', 'Schedule', 'Practice', 'Your stories', 'Overview']) {
      await userEvent.click(screen.getByRole('tab', { name }));
      expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', expect.stringMatching(/^tab-/));
    }
    expect(window.location.hash).toBe('#overview');
    window.history.replaceState(null, '', '#nonsense');
    render(<KitWorkspace k={kitHook()} />);
  });

  it('shows dedupe notes, save states, regeneration banners, coverage gaps and research notes', async () => {
    const kit = richKit();
    kit.coverage.uncovered_requirement_ids = ['r3', 'r4'];
    kit.source.notes = ['COMPANY_UNREACHABLE: x', 'NO_PUBLIC_DISCUSSION: hidden'];
    const v = view({ kit, scheduleStale: true, regen: { section: 'questions:technical', status: 'running' } });
    const k = kitHook({ view: v, kit, saveState: 'saving', unsavedCount: 3 });
    const { rerender } = render(<KitWorkspace k={k} note="in_progress" />);
    expect(screen.getByText(/already submitted this posting/)).toBeInTheDocument();
    expect(screen.getByText('Saving 3 changes…')).toBeInTheDocument();
    expect(screen.getByText(/Regenerating technical… You can keep editing/)).toBeInTheDocument();
    expect(screen.getByText('1 must-have requirement(s) have no question')).toBeInTheDocument();
    expect(screen.getByLabelText('(out of date)')).toBeInTheDocument();
    expect(screen.getByText('x')).toBeInTheDocument();
    expect(screen.queryByText('hidden')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Go to questions' }));
    expect(screen.getByRole('tab', { name: 'Questions' })).toHaveAttribute('aria-selected', 'true');

    const finished = new Date().toISOString();
    rerender(<KitWorkspace k={kitHook({ view: view({ regen: { section: 'brief', status: 'done', finishedAt: finished, message: 'Replaced 1' } }), saveState: 'retrying' })} note="existing" />);
    expect(screen.getByText(/already have a kit for this posting/)).toBeInTheDocument();
    expect(screen.getByText('Offline. Will retry saving')).toBeInTheDocument();
    expect(screen.getByText('Regenerated brief')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Regenerated brief')).toBeNull();

    rerender(<KitWorkspace k={kitHook({ view: view({ regen: { section: 'brief', status: 'failed', finishedAt: finished, message: 'boom' } }), saveState: 'error', saveError: 'Question q1 not found' })} note="rescheduled" />);
    expect(screen.getByText('Regenerating brief failed')).toBeInTheDocument();
    expect(screen.getByText(/research reused, schedule rebuilt for 3 days/)).toBeInTheDocument();
    expect(screen.getByText("Some changes couldn't be saved")).toBeInTheDocument();
    expect(screen.getByText('Some changes were not saved')).toHaveAttribute('title', 'Question q1 not found');

    rerender(<KitWorkspace k={kitHook({ view: view({ regen: { section: 'brief', status: 'done' } }), saveState: 'saved', unsavedCount: 1 })} />);
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
    expect(screen.queryByText('Regenerated brief')).toBeNull(); // no finish time: too old to announce
    rerender(<KitWorkspace k={kitHook({ saveState: 'saving', unsavedCount: 1 })} />);
  });

  it('falls back to the stored title and URL, singular days, no notes; renders nothing without a kit', () => {
    const kit = richKit();
    kit.role.title = '';
    kit.source.company = '';
    kit.source.notes = undefined;
    kit.schedule = { days_available: 1, days: [{ day: 1, focus: 'x', question_ids: [], minutes: 10 }] };
    render(<KitWorkspace k={kitHook({ kit, view: view({ kit, title: 'Stored title', input: { jd: '', company_url: 'acme.com', days: 1 } }) })} />);
    expect(screen.getByRole('heading', { name: 'Stored title' })).toBeInTheDocument();
    expect(screen.getByText(/acme\.com · 1 day ·/)).toBeInTheDocument();
    const { container } = render(<KitWorkspace k={kitHook({ kit: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('wires every tab’s actions to the hook', async () => {
    const k = kitHook();
    mockApi({ 'GET /kits/k1/practice': practice() });
    render(<KitWorkspace k={k} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Pin' })[0]!);
    expect(k.dispatch).toHaveBeenCalledWith({ op: 'pin', target: 'brief', pinned: true });
    await userEvent.click(screen.getAllByRole('button', { name: '1 Q' })[0]!);
    expect(screen.getByRole('tab', { name: 'Questions' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate technical' }));
    expect(k.regenerate).toHaveBeenCalledWith('questions:technical');
  });
});

describe('kit page', () => {
  it('shows loading, then the workspace with the dedupe note', async () => {
    nav.searchParams = new URLSearchParams('note=existing');
    mockApi({ 'GET /kits/k1': view() });
    render(<KitPage params={{ id: 'k1' }} />);
    expect(screen.getByText(/Loading kit…/)).toBeInTheDocument();
    expect(await screen.findByText(/already have a kit for this posting/)).toBeInTheDocument();
  });
  it('shows generation progress for kits still building', async () => {
    mockApi({ 'GET /kits/k1': view({ status: 'queued', kit: null }), 'GET /kits/k1/status': { status: 'queued', progress: [], error: null, regen: null, version: 0, scheduleStale: false } });
    render(<KitPage params={{ id: 'k1' }} />);
    expect(await screen.findByRole('heading', { name: 'Waiting to start…' })).toBeInTheDocument();
  });
  it('not found and load errors (with retry)', async () => {
    mockApi({ 'GET /kits/gone': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Kit not found' } } }, 'GET /kits/err': { status: 500, body: { error: { code: 'X', message: 'Server sad' } } } });
    render(<KitPage params={{ id: 'gone' }} />);
    expect(await screen.findByText('Kit not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All kits' })).toHaveAttribute('href', '/kits');
    render(<KitPage params={{ id: 'err' }} />);
    expect(await screen.findByText('Server sad')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  });
});
