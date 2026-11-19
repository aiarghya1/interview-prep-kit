/**
 * Edge cases and fallback paths of the smaller modules, so every branch is
 * pinned down by a test rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import { categoryForRequirement, runCoverageLoop } from '../src/coverage.js';
import { maxIdNumber } from '../src/ids.js';
import { parseDurationMs, TokenBucket } from '../src/llm/rate.js';
import { untrusted } from '../src/llm/untrusted.js';
import { applyUserEdit, isProtected, mergeSection } from '../src/merge.js';
import { orderSession, recordReview, summarisePractice } from '../src/practice.js';
import { RetrievalError } from '../src/retrieval/errors.js';
import { isAllowed, parseRobots } from '../src/retrieval/robots.js';
import { buildSchedule } from '../src/schedule.js';
import { validateKit } from '../src/schema.js';
import { rescheduleKit } from '../src/reschedule.js';
import { applyEditOps, EditOpsSchema, type EditOpInput } from '../src/edit.js';
import { mergeRegenerated, regenerateBrief, regenerateCategory, regenerateFlashcards, regenerateSchedule } from '../src/regenerate.js';
import { GENERATED } from '../src/merge.js';
import { sampleKit } from './kitFixture.js';
import { q, req } from './fixtures.js';
import { stubLlm } from './stubLlm.js';

const ops = (x: EditOpInput[]) => EditOpsSchema.parse(x);

describe('index', () => {
  it('re-exports the public surface', () => {
    expect(typeof core.generateKit).toBe('function');
    expect(typeof core.buildSchedule).toBe('function');
    expect(typeof core.analyseStories).toBe('function');
  });
});

describe('coverage / ids / rate / untrusted', () => {
  it('routes domain requirements to company-fit', () => {
    expect(categoryForRequirement(req('r1', 'must', 'domain'))).toBe('company-fit');
  });
  it('template fallback writes a behavioural STAR prompt for behavioural gaps', async () => {
    const r = await runCoverageLoop({ requirements: [req('r1', 'must', 'behavioural')], questions: [], fillGaps: async () => [], maxPasses: 1 });
    expect(r.questions[0]).toMatchObject({ category: 'behavioural', state: { origin: 'template' } });
    expect(r.questions[0]!.prompt).toMatch(/Tell me about a time/);
  });
  it('maxIdNumber ignores other prefixes', () => {
    expect(maxIdNumber(['f9', 'q2', 'qx'], 'q')).toBe(2);
  });
  it('token bucket trusts provider remaining counts, never raising them', () => {
    let t = 0;
    const b = new TokenBucket(1000, () => t);
    b.observeRemaining(100);
    expect(b.reserve(200)).toBeGreaterThan(0);
    b.observeRemaining(Number.NaN);
    b.setLimit(1000); // unchanged limit: no-op
    t = 120_000;
    expect(b.reserve(10)).toBe(0);
  });
  it('parses hour durations', () => {
    expect(parseDurationMs('1h2m')).toBe(3_720_000);
  });
  it('truncates long untrusted content', () => {
    expect(untrusted('x', 'a'.repeat(50), 10)).toMatch(/a{10}\n\[\.\.\.truncated\]/);
  });
});

describe('merge / practice / errors / robots', () => {
  it('items without state are unprotected and become edited generated items', () => {
    expect(isProtected({})).toBe(false);
    expect(applyUserEdit({ id: 'q1' } as { id: string; state?: never }, {}).state).toEqual({ origin: 'generated', edited: true, pinned: false });
  });
  it('regenerating an empty section appends at the end', () => {
    const r = mergeSection([{ id: 'a1', cat: 'x', t: 'keep' }], (i) => i.cat === 'y', [{ cat: 'y', t: 'new' }], () => 'a2', (i) => i.t);
    expect(r.items.map((i) => i.id)).toEqual(['a1', 'a2']);
  });
  it('orders equally-confident due cards by due date, and counts due cards', () => {
    const now = new Date('2026-11-20T00:00:00Z');
    const cards = [
      { id: 'f1', front: 'a', back: '', requirement_ids: [] },
      { id: 'f2', front: 'b', back: '', requirement_ids: [] },
    ];
    const progress = {
      f1: { ...recordReview(undefined, 1, now), dueAt: '2026-11-19T12:00:00Z' },
      f2: { ...recordReview(undefined, 1, now), dueAt: '2026-11-19T06:00:00Z' },
    };
    expect(orderSession(cards, progress, [], now)).toEqual(['f2', 'f1']);
    expect(summarisePractice(cards, progress, now).due).toBe(2);
  });
  it('transient: non-retryable HTTP errors and unknown statuses', () => {
    expect(new RetrievalError('HTTP_ERROR', 'x', 'u').transient).toBe(false);
    expect(new RetrievalError('HTTP_ERROR', 'x', 'u', 404).transient).toBe(false);
    expect(new RetrievalError('HTTP_ERROR', 'x', 'u', 503).transient).toBe(true);
  });
  it('robots: ignores junk lines and rules before any user-agent; Allow wins a tie', () => {
    const r = parseRobots('garbage line\nDisallow: /early\nSitemap:\nUser-agent: *\nDisallow: /x\nAllow: /x\nCrawl-delay: soon', 'Bot');
    expect(isAllowed(r, '/early')).toBe(true);
    expect(isAllowed(r, '/x')).toBe(true);
    expect(r.crawlDelayMs).toBeUndefined();
    expect(r.sitemaps).toEqual([]);
  });
});

describe('schedule / schema / reschedule', () => {
  it('final day falls back to the top questions when there are no must-haves', () => {
    const s = buildSchedule({ days: 3, requirements: [req('r1', 'nice')], questions: [q('q1', ['r1']), q('q2', [])] });
    expect(s.days.at(-1)!.question_ids.length).toBeGreaterThan(0);
  });
  it('schema reports mis-numbered days, unknown uncovered ids and root-level errors', () => {
    const k = sampleKit();
    k.schedule.days[0]!.day = 7;
    k.coverage.uncovered_requirement_ids = ['r42'];
    const r = validateKit(k);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join('\n')).toMatch(/expected day 1, got 7[\s\S]*unknown requirement r42/);
    const root = validateKit(null);
    expect(!root.ok && root.issues[0]).toMatch(/^\(root\)/);
  });
  it('rescheduleKit keeps everything but the schedule', () => {
    const k = sampleKit();
    const r = rescheduleKit(k, 6);
    expect(r.schedule.days).toHaveLength(6);
    expect(r.questions).toBe(k.questions);
  });
});

describe('edit ops: flashcards and pins', () => {
  it('updates, reorders, pins and deletes flashcards', () => {
    const r = applyEditOps(sampleKit(), ops([
      { op: 'flashcard.update', id: 'f1', patch: { back: 'new', requirement_ids: ['r2'] } },
      { op: 'flashcard.reorder', ids: ['f2', 'f1'] },
      { op: 'pin', target: 'flashcard', id: 'f2', pinned: true },
      { op: 'flashcard.delete', id: 'f1' },
    ]));
    expect(r.kit.flashcards).toEqual([expect.objectContaining({ id: 'f2', state: expect.objectContaining({ pinned: true }) })]);
  });
  it('changing linked requirements counts as a question change; pinning a stateless item works', () => {
    const k = sampleKit();
    delete k.questions[0]!.state;
    const r = applyEditOps(k, ops([
      { op: 'question.update', id: 'q1', patch: { requirement_ids: ['r2'] } },
      { op: 'pin', target: 'question', id: 'q2', pinned: true },
    ]));
    expect(r.questionsChanged).toBe(true);
    const k2 = sampleKit();
    delete k2.questions[1]!.state;
    expect(applyEditOps(k2, ops([{ op: 'pin', target: 'question', id: 'q2', pinned: true }])).kit.questions[1]!.state).toEqual({ origin: 'generated', edited: false, pinned: true });
  });
  it('rejects a pin without an id and unknown flashcards', () => {
    expect(() => applyEditOps(sampleKit(), ops([{ op: 'pin', target: 'question', pinned: true }]))).toThrow(/needs an id/);
    expect(() => applyEditOps(sampleKit(), ops([{ op: 'flashcard.delete', id: 'f9' }]))).toThrow(/Flashcard f9/);
  });
});

describe('regenerate', () => {
  const kit = sampleKit();
  kit.research = {
    hiring_page_found: true,
    hiring_process: { found: true, source_type: 'official', stages: [], formats: ['system_design'], tips: [], sources: [] },
    discussion: [],
    skipped_sources: [],
    steps: [],
    thin_description: false,
  };
  const llm = stubLlm({
    company_brief: { enough_information: true, summary: 'S2', what_they_do: 'W2', sources: [] },
    questions_: (r: { task: string }) => ({ questions: [{ prompt: `fresh ${r.task}`, answer_outline: '', difficulty: 2, requirement_ids: ['r1'] }] }),
    flashcards: { flashcards: [{ front: 'Front', back: 'B', requirement_ids: ['r1'] }] },
  });

  it('produces content for each section from stored research', async () => {
    const corpus = { jd: 'jd', pages: [{ url: 'https://a.example/', title: 'A', kind: 'home' as const, text: 'A company that builds things for people. '.repeat(5), linkScore: 0, hiringSignals: [] }], discussion: [] };
    expect(await regenerateBrief(kit, corpus, llm)).toMatchObject({ summary: 'S2', sources: ['https://a.example/'] });
    expect((await regenerateCategory(kit, 'system-design', [], llm))[0]!.category).toBe('system-design');
    expect((await regenerateCategory({ ...kit, research: undefined }, 'company-fit', kit.questions, llm))[0]!.category).toBe('company-fit');
    expect(await regenerateFlashcards(kit, llm)).toHaveLength(1);
    expect(regenerateSchedule(kit).days).toHaveLength(3);
  });

  it('plans a category the original plan skipped when the user asks for it', async () => {
    const junior = { ...sampleKit(), role: { ...sampleKit().role, seniority: 'junior', title: 'Engineer' } };
    const out = await regenerateCategory(junior, 'system-design', [], llm);
    expect(out[0]!.category).toBe('system-design');
  });

  it('merges a brief, a schedule and flashcards into the latest kit', () => {
    const hw = { q: 4, f: 2 };
    const b = mergeRegenerated(kit, { section: 'brief', brief: { summary: 'n', what_they_do: 'n', sources: [] } }, hw);
    expect(b).toMatchObject({ added: ['brief'], kept: [], skippedProtected: false });
    expect(b.kit.company_brief.summary).toBe('n');
    const s = mergeRegenerated(kit, { section: 'schedule', schedule: rescheduleKit(kit, 2).schedule }, hw);
    expect(s.kit.schedule.days).toHaveLength(2);
    const f = mergeRegenerated(kit, { section: 'flashcards', flashcards: [{ front: 'New', back: '', requirement_ids: [], state: { ...GENERATED } }] }, hw);
    expect(f.added).toEqual(['f3']);
    expect(f.highWater).toEqual({ q: 4, f: 3 });
  });
});
