import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditOpsSchema } from '@kit/core/edit';
import { coalesce, remapOpIds } from '@/lib/applyOps';
import { parseBatchFile } from '@/lib/parseBatch';
import { useKit } from '@/lib/useKit';
import { BatchUpload } from '@/components/BatchUpload';
import { Overview } from '@/components/kit/Overview';
import { Practice } from '@/components/kit/Practice';
import { QuestionBoard } from '@/components/kit/QuestionBoard';
import { StoryBank } from '@/components/kit/StoryBank';
import { mockApi } from './http';
import { richKit, view } from './fixtures';

// Mark q1 as "being dragged" so the drag styling is exercised.
vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/sortable')>();
  return { ...actual, useSortable: (args: { id: string }) => ({ ...actual.useSortable(args), isDragging: args.id === 'q1' }) };
});

afterEach(() => vi.unstubAllGlobals());

describe('applyOps helpers', () => {
  it('remaps leaves id-less ops alone and coalesces consecutive brief edits', () => {
    const ops = EditOpsSchema.parse([
      { op: 'pin', target: 'brief', pinned: true },
      { op: 'question.add', question: { category: 'technical', prompt: 'x' } },
      { op: 'brief.update', patch: { summary: 'a' } },
      { op: 'brief.update', patch: { what_they_do: 'b' } },
    ]);
    expect(remapOpIds(ops, { q1: 'q2' })).toEqual(ops);
    expect(coalesce(ops).at(-1)).toEqual({ op: 'brief.update', patch: { summary: 'a', what_they_do: 'b' } });
  });
});

describe('parseBatchFile edge cases', () => {
  const JD = 'A sufficiently long job description';
  it('CSV with CRLF line endings, missing columns and bad values', () => {
    const csv = `jd,company_url,days\r\n"${JD}",a.com,3\r\n"${JD}",,2\r\n"${JD}",b.com,0\r\n"${JD}"\r\n`;
    const r = parseBatchFile('x.csv', csv, 5);
    expect(r.rows).toEqual([{ jd: JD, company_url: 'a.com', days: 3 }]);
    expect(r.errors).toEqual(['Row 2: company_url is missing.', 'Row 3: days must be a whole number from 1 to 365.', 'Row 4: company_url is missing.']);
  });
  it('empty CSV, non-array JSON, and objects missing every field', () => {
    expect(parseBatchFile('x.csv', '', 5).errors[0]).toMatch(/header row/);
    expect(parseBatchFile('x.json', '{"a":1}', 5).errors).toEqual(['The JSON file must contain an array of objects.']);
    expect(parseBatchFile('x.json', '[{}]', 5).errors).toEqual(['Row 1: job description is missing or too short.']);
  });
  it('keeps only the first 10 rows and says so', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ jd: JD, company_url: `c${i}.com` }));
    const r = parseBatchFile('x.json', JSON.stringify(rows), 5);
    expect(r.rows).toHaveLength(10);
    expect(r.errors).toEqual(['Only the first 10 of 12 rows will be used.']);
  });
});

describe('component branches', () => {
  it('BatchUpload ignores a cleared file input', () => {
    render(<BatchUpload onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Batch file'), { target: { files: [] } });
    expect(screen.queryByRole('button', { name: /Create/ })).toBeNull();
  });

  it('Overview lists several sources and pluralises passes', () => {
    const kit = richKit();
    kit.company_brief.sources = ['https://a.example/', 'https://a.example/about'];
    kit.coverage.passes = 2;
    render(<Overview kit={kit} dispatch={vi.fn()} regen={null} onRegenerate={vi.fn()} goToQuestions={vi.fn()} />);
    expect(screen.getByText(/Sources:/)).toHaveTextContent('Sources: a.example, a.example/about');
    expect(screen.getByText(/checked in 2 passes\./)).toBeInTheDocument();
  });

  it('Practice: singular new-card copy', async () => {
    mockApi({ 'GET /kits/k1/practice': { progress: {}, order: ['f1'], summary: { total: 2, seen: 1, unseen: 1, byConfidence: { 1: 0, 2: 1, 3: 0 }, due: 0, requirementsSolid: [], requirementsUntouched: [] } } });
    render(<Practice kitId="k1" kit={richKit()} />);
    expect(await screen.findByText(/^1 new card, must-haves first/)).toBeInTheDocument();
  });

  it('Practice: a one-card session ends with singular copy', async () => {
    mockApi({
      'GET /kits/k1/practice': { progress: {}, order: ['f1'], summary: { total: 2, seen: 0, unseen: 2, byConfidence: { 1: 0, 2: 0, 3: 0 }, due: 0, requirementsSolid: [], requirementsUntouched: [] } },
      'POST /kits/k1/practice': { progress: {}, order: ['f1'], summary: { total: 2, seen: 1, unseen: 1, byConfidence: { 1: 0, 2: 0, 3: 1 }, due: 0, requirementsSolid: [], requirementsUntouched: [] } },
    });
    render(<Practice kitId="k1" kit={richKit()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start session' }));
    await userEvent.click(screen.getByRole('button', { name: /Reveal answer/ }));
    await userEvent.click(screen.getByRole('button', { name: /Solid/ }));
    expect(await screen.findByText('Session done: 1 card reviewed')).toBeInTheDocument();
  });

  it('QuestionBoard: drag styling and truncated requirement chips', () => {
    const kit = richKit();
    kit.role.requirements[0]!.text = 'A requirement whose text is far longer than thirty-two characters';
    render(<QuestionBoard kit={kit} dispatch={vi.fn()} regen={null} onRegenerate={vi.fn()} />);
    expect(screen.getByRole('listitem', { name: 'Technical question 1 of 2' })).toHaveClass('z-10');
    expect(screen.getByText(/^r1 · A requirement whose text is far\s?…$/)).toBeInTheDocument();
  });

  it('StoryBank shows "Saving…" while the request is in flight', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release!: () => void;
    mockApi({ 'PUT /kits/k1/stories': () => new Promise((r) => (release = () => r({ stories: [] }))) });
    render(<StoryBank kitId="k1" kit={richKit()} initial={[]} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add a story' }));
    await act(() => vi.advanceTimersByTimeAsync(700));
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    await act(async () => release());
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });
});

describe('useKit unmount during a poll', () => {
  it('drops a status response that arrives after unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let release!: () => void;
    const api = mockApi({
      'GET /kits/k1': view({ status: 'running', kit: null, version: 0 }),
      'GET /kits/k1/status': () => new Promise((r) => (release = () => r({ status: 'ready', progress: [], error: null, regen: null, version: 1, scheduleStale: false }))),
    });
    const { unmount } = renderHook(() => useKit('k1'));
    await act(() => vi.advanceTimersByTimeAsync(0)); // initial load
    await act(() => vi.advanceTimersByTimeAsync(1500)); // first poll starts
    unmount();
    await act(async () => release());
    expect(api.calls.filter((c) => c.path === '/kits/k1')).toHaveLength(1); // no reload after unmount
  });
});

