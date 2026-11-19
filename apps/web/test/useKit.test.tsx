import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKit } from '@/lib/useKit';
import { mockApi } from './http';
import { view } from './fixtures';

// Only timers the hook uses; Response.json() needs real setImmediate.
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.unstubAllGlobals());

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
async function mount() {
  const hook = renderHook(() => useKit('k1'));
  await tick(0);
  return hook;
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('useKit: loading and polling', () => {
  it('loads the kit, and reports load errors', async () => {
    mockApi({ 'GET /kits/k1': view() });
    const { result } = await mount();
    expect(result.current.view?.id).toBe('k1');
    expect(result.current.kit?.questions).toHaveLength(4);

    mockApi({ 'GET /kits/k1': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'gone' } } } });
    const other = await mount();
    expect(other.result.current.loadError?.status).toBe(404);
    expect(other.result.current.kit).toBeNull();
  });

  it('polls while generating, merging progress, then reloads when it finishes', async () => {
    let status = 'running';
    const api = mockApi({
      'GET /kits/k1': () => view({ status: status as 'running', kit: status === 'ready' ? view().kit : null, version: status === 'ready' ? 1 : 0 }),
      'GET /kits/k1/status': () => ({ status, progress: [{ step: 'crawl', status: 'running', message: 'Fetching', at: '' }], error: null, regen: null, version: 0, scheduleStale: false }),
    });
    const { result } = await mount();
    expect(result.current.kit).toBeNull();
    await tick(1500);
    expect(result.current.view?.progress[0]?.message).toBe('Fetching');
    status = 'ready';
    await tick(1500);
    expect(result.current.view?.status).toBe('ready');
    const polls = api.calls.filter((c) => c.path === '/kits/k1/status').length;
    await tick(5000);
    expect(api.calls.filter((c) => c.path === '/kits/k1/status').length).toBe(polls);
  });

  it('keeps polling through transient status errors', async () => {
    let fail = true;
    mockApi({
      'GET /kits/k1': view({ status: 'queued', kit: null, version: 0 }),
      'GET /kits/k1/status': () => (fail ? { status: 500, body: null } : { status: 'queued', progress: [], error: null, regen: null, version: 0, scheduleStale: false }),
    });
    const { result } = await mount();
    await tick(1500);
    fail = false;
    await tick(1500);
    expect(result.current.view?.status).toBe('queued');
  });

  it('polls during a regeneration and reloads when it is done', async () => {
    let regenStatus = 'running';
    mockApi({
      'GET /kits/k1': () => view({ regen: { section: 'brief', status: regenStatus as 'running' }, version: regenStatus === 'done' ? 2 : 1 }),
      'GET /kits/k1/status': () => ({ status: 'ready', progress: [], error: null, regen: { section: 'brief', status: regenStatus }, version: regenStatus === 'done' ? 2 : 1, scheduleStale: false }),
    });
    const { result } = await mount();
    regenStatus = 'done';
    await tick(1500);
    expect(result.current.view?.regen?.status).toBe('done');
    expect(result.current.view?.version).toBe(2);
  });

  it('ignores an older version of the kit but keeps its progress', async () => {
    let version = 3;
    mockApi({ 'GET /kits/k1': () => view({ version, progress: [{ step: 'x', status: 'done', message: `v${version}`, at: '' }] }) });
    const { result } = await mount();
    version = 2;
    await act(() => result.current.reload());
    expect(result.current.view?.version).toBe(3);
    expect(result.current.view?.progress[0]?.message).toBe('v2');
  });
});

describe('useKit: optimistic edits', () => {
  it('applies edits instantly, batches them, and saves after a pause', async () => {
    const api = mockApi({ 'GET /kits/k1': view(), 'PATCH /kits/k1': (b) => ({ kit: view().kit, version: 2, highWater: { q: 4, f: 2 }, created: {}, scheduleStale: false, b }) });
    const { result } = await mount();
    act(() => result.current.dispatch({ op: 'question.update', id: 'q1', patch: { prompt: 'Typed' } }));
    act(() => result.current.dispatch([{ op: 'question.update', id: 'q1', patch: { answer_outline: 'More' } }]));
    expect(result.current.kit!.questions[0]!.prompt).toBe('Typed');
    expect(result.current.saveState).toBe('saving');
    expect(result.current.unsavedCount).toBe(1);
    await tick(450);
    expect(api.calls.filter((c) => c.method === 'PATCH')).toEqual([
      expect.objectContaining({ body: { ops: [{ op: 'question.update', id: 'q1', patch: { prompt: 'Typed', answer_outline: 'More' } }] } }),
    ]);
    expect(result.current.saveState).toBe('saved');
    expect(result.current.view?.version).toBe(2);
    await act(() => result.current.flush()); // nothing pending: no request
    expect(api.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('remaps a new item’s local id to the server’s id in edits queued while saving', async () => {
    const gate = deferred<void>();
    const api = mockApi({
      'GET /kits/k1': view(),
      'PATCH /kits/k1': async (b: { ops: { op: string; tempId?: string }[] }) => {
        if (b.ops[0]!.op === 'question.add') {
          await gate.promise;
          const k = view().kit!;
          return { kit: { ...k, questions: [...k.questions, { id: 'q9', category: 'technical', prompt: 'Mine', answer_outline: '', difficulty: 2, requirement_ids: [] }] }, version: 2, highWater: { q: 9, f: 2 }, created: { [b.ops[0]!.tempId!]: 'q9' }, scheduleStale: true };
        }
        return { kit: view().kit, version: 3, highWater: { q: 9, f: 2 }, created: {}, scheduleStale: true };
      },
    });
    const { result } = await mount();
    act(() => result.current.dispatch({ op: 'question.add', tempId: 't1', question: { category: 'technical', prompt: 'Mine' } }));
    await tick(450); // add is now in flight
    const localId = result.current.kit!.questions.at(-1)!.id;
    expect(localId).toBe('q5');
    act(() => result.current.dispatch({ op: 'question.update', id: localId, patch: { prompt: 'Mine, edited' } }));
    gate.resolve();
    await tick(0);
    await tick(450);
    const patches = api.calls.filter((c) => c.method === 'PATCH');
    expect(patches[1]!.body).toEqual({ ops: [{ op: 'question.update', id: 'q9', patch: { prompt: 'Mine, edited' } }] });
  });

  it('retries saves with backoff when offline, without losing edits', async () => {
    let attempts = 0;
    mockApi({ 'GET /kits/k1': view(), 'PATCH /kits/k1': () => (++attempts < 3 ? { status: 503, body: null } : { kit: view().kit, version: 2, highWater: { q: 4, f: 2 }, created: {}, scheduleStale: false }) });
    const { result } = await mount();
    act(() => result.current.dispatch({ op: 'question.update', id: 'q1', patch: { prompt: 'Offline edit' } }));
    await tick(450);
    expect(result.current.saveState).toBe('retrying');
    expect(result.current.kit!.questions[0]!.prompt).toBe('Offline edit');
    await tick(1000);
    expect(result.current.saveState).toBe('retrying');
    await tick(2000);
    expect(result.current.saveState).toBe('saved');
    expect(attempts).toBe(3);
  });

  it('shows a rejected edit and reloads the kit', async () => {
    const api = mockApi({ 'GET /kits/k1': view(), 'PATCH /kits/k1': { status: 404, body: { error: { code: 'EDIT_NOT_FOUND', message: 'Question q1 not found' } } } });
    const { result } = await mount();
    act(() => result.current.dispatch({ op: 'question.delete', id: 'q1' }));
    await tick(450);
    expect(result.current.saveState).toBe('error');
    expect(result.current.saveError).toBe('Question q1 not found');
    expect(api.calls.filter((c) => c.method === 'GET' && c.path === '/kits/k1')).toHaveLength(2);
  });

  it('ignores a save response older than a newer kit already shown, and keeps saving queued edits', async () => {
    const gate = deferred<void>();
    let n = 0;
    mockApi({
      'GET /kits/k1': () => view({ version: n > 0 ? 5 : 1 }),
      'PATCH /kits/k1': async () => {
        n++;
        if (n === 1) await gate.promise;
        return { kit: view().kit, version: n === 1 ? 2 : 6, highWater: { q: 4, f: 2 }, created: {}, scheduleStale: false };
      },
    });
    const { result } = await mount();
    act(() => result.current.dispatch({ op: 'question.update', id: 'q1', patch: { prompt: 'A' } }));
    await tick(450);
    act(() => result.current.dispatch({ op: 'question.update', id: 'q2', patch: { prompt: 'B' } }));
    await act(() => result.current.reload()); // newer version 5 arrives meanwhile
    gate.resolve();
    await tick(0);
    expect(result.current.view?.version).toBe(5);
    expect(result.current.saveState).toBe('saving');
    await tick(450);
    expect(result.current.view?.version).toBe(6);
  });

  it('warns before unload with unsaved edits and saves when the tab is hidden', async () => {
    const api = mockApi({ 'GET /kits/k1': view(), 'PATCH /kits/k1': { kit: view().kit, version: 2, highWater: { q: 4, f: 2 }, created: {}, scheduleStale: false } });
    const { result, unmount } = await mount();
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    act(() => result.current.dispatch({ op: 'question.update', id: 'q1', patch: { prompt: 'x' } }));
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(0);
    expect(api.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    unmount();
  });
});

describe('useKit: regenerate and retry', () => {
  it('rebuilds the schedule synchronously; queues other sections; retries failed kits', async () => {
    const api = mockApi({
      'GET /kits/k1': view(),
      'POST /kits/k1/regenerate': (b: { section: string }) => (b.section === 'schedule' ? view({ version: 4, scheduleStale: false }) : { regen: { section: b.section, status: 'running' } }),
      'GET /kits/k1/status': { status: 'ready', progress: [], error: null, regen: { section: 'brief', status: 'running' }, version: 4, scheduleStale: false },
      'POST /kits/k1/retry': {},
    });
    const { result } = await mount();
    await act(() => result.current.regenerate('schedule'));
    expect(result.current.view?.version).toBe(4);
    await act(() => result.current.regenerate('brief'));
    expect(result.current.view?.regen).toEqual({ section: 'brief', status: 'running' });
    await act(() => result.current.retry());
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /kits/k1/retry');
  });
});
