import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from '../fixtures/serve.js';
import { deriveCompanyName, generateKit, validateKitInput, type ProgressEvent } from '../src/pipeline.js';
import { Fetcher } from '../src/retrieval/fetcher.js';
import { LlmError } from '../src/llm/types.js';
import { BatchOutputSchema } from '../src/schema.js';
import { defaultDeps, errorOf, main, parseArgs, type EvaluateDeps } from '../src/cli/evaluate.js';
import { FakeLlm } from './fakeLlm.js';
import cases from '../../../examples/cases.sample.json';

let server: Server;
let origin: string;
beforeAll(async () => {
  ({ server, origin } = await startFixtureServer(0));
});
afterAll(() => server.close());

const fetcher = () => new Fetcher({ policy: { allowPrivate: true }, minIntervalMs: 0, timeoutMs: 2000, retries: 0 });
const noSearch = async () => ({ items: [], searched: [], skipped: [] });
const acme = () => ({ ...cases[0]!, company_url: `${origin}/acme/` });
const globex = () => ({ ...cases[1]!, company_url: `${origin}/globex/` });

describe('input validation and naming', () => {
  it('rejects oversized descriptions and bad day counts', () => {
    expect(() => validateKitInput({ jd: 'x'.repeat(30_001), company_url: '', days: 1 })).toThrow(/too long/);
    expect(() => validateKitInput({ jd: 'x'.repeat(50), company_url: '', days: 0 })).toThrow(/days/);
    expect(() => validateKitInput({ jd: 'x'.repeat(50), company_url: '', days: 1.5 })).toThrow(/days/);
  });
  it('falls back to the host when a local URL has no path segment', () => {
    expect(deriveCompanyName(new URL('http://localhost:8099/'))).toBe('localhost');
    expect(deriveCompanyName(null)).toBe('');
    expect(deriveCompanyName(null, undefined, 'Home | Acme')).toBe('');
  });
});

describe('pipeline paths', () => {
  it('reports progress, and skips optional work as the deadline approaches', async () => {
    const events: ProgressEvent[] = [];
    const llm = new FakeLlm();
    const kit = await generateKit(acme(), { llm, fetcher: fetcher(), search: noSearch, onProgress: (e) => events.push(e), deadline: Date.now() + 30_000 });
    expect(events.find((e) => e.step === 'discussion')).toMatchObject({ status: 'skipped', message: expect.stringMatching(/time budget/) });
    expect(kit.coverage.passes).toBe(1);
    expect(events.at(-1)).toMatchObject({ step: 'validate', status: 'done' });
  });

  it('maps an extraction that produced invalid output to EXTRACTION_FAILED', async () => {
    const llm = new FakeLlm();
    llm.json = async () => { throw new LlmError('LLM_INVALID_OUTPUT', 'bad json'); };
    await expect(generateKit(acme(), { llm, fetcher: fetcher(), search: noSearch })).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' });
  });

  it('survives a crawler that throws, and a discussion search that throws', async () => {
    const broken = { get: async (u: string | URL) => ({ url: String(u), finalUrl: String(u), status: 200, contentType: 'text/html', body: '', truncated: false }), sitemapsFor: async () => { throw new Error('robots exploded'); } } as unknown as Fetcher;
    const kit = await generateKit(acme(), { llm: new FakeLlm(), fetcher: broken, search: async () => { throw new Error('search down'); } });
    expect(kit.research!.skipped_sources[0]).toMatchObject({ reason: 'robots exploded' });
    expect(kit.source.notes!.join(' ')).toMatch(/COMPANY_UNREACHABLE[\s\S]*unknown error/);
    expect(kit.company_brief.summary).toMatch(/could not be retrieved/);
  });

  it('uses the real discussion search by default, and summarises a process with no named stages', async () => {
    const f = fetcher(); // created before swapping global fetch, so crawling stays real
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ hits: [{ objectID: '1', title: 'Acme interview: recruiter screen then onsite', story_text: '' }] }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      const llm = new FakeLlm();
      const realJson = llm.json.bind(llm);
      llm.json = (async (req) => (req.task === 'hiring_process' ? req.schema.parse({ described: true, stages: [], formats: [], tips: [], sources: [] }) : realJson(req))) as FakeLlm['json'];
      const events: ProgressEvent[] = [];
      const kit = await generateKit(globex(), { llm, fetcher: f, onProgress: (e) => events.push(e) });
      expect(kit.research!.discussion.length).toBe(0); // HN result mentions Acme, not Globex: filtered as irrelevant
      expect(events.find((e) => e.step === 'discussion' && e.status === 'done')).toBeTruthy();
    } finally {
      globalThis.fetch = original;
    }
    const llm = new FakeLlm();
    const realJson = llm.json.bind(llm);
    llm.json = (async (req) => (req.task === 'hiring_process' ? req.schema.parse({ described: true, stages: [], formats: [], tips: [], sources: [] }) : realJson(req))) as FakeLlm['json'];
    const events: ProgressEvent[] = [];
    await generateKit(acme(), { llm, fetcher: fetcher(), search: noSearch, onProgress: (e) => events.push(e) });
    expect(events.find((e) => e.step === 'hiring' && e.status === 'done')!.message).toMatch(/Stages: n\/a; formats: n\/a/);
  });

  it('falls back when the brief call fails: page description if any, else an honest brief', async () => {
    const llm = new FakeLlm();
    llm.failTasks = new Set(['company_brief']);
    const a = await generateKit(acme(), { llm, fetcher: fetcher(), search: noSearch });
    expect(a.company_brief.summary).toBe('Payment APIs for online marketplaces.');
    const b = await generateKit(globex(), { llm, fetcher: fetcher(), search: noSearch });
    expect(b.company_brief.summary).toMatch(/brief generation failed/);
  });

  it('reports a brief the model says is insufficient', async () => {
    const llm = new FakeLlm();
    const realJson = llm.json.bind(llm);
    llm.json = (async (req) => (req.task === 'company_brief' ? req.schema.parse({ enough_information: false, summary: '', what_they_do: '', sources: [] }) : realJson(req))) as FakeLlm['json'];
    const events: ProgressEvent[] = [];
    await generateKit(globex(), { llm, fetcher: fetcher(), search: noSearch, onProgress: (e) => events.push(e) });
    expect(events.find((e) => e.step === 'brief' && e.status === 'done')!.message).toMatch(/honest brief/);
  });

  it('drops duplicate questions across categories and replaces an empty flashcard set', async () => {
    const llm = new FakeLlm();
    const realJson = llm.json.bind(llm);
    llm.json = (async (req) => {
      if (req.task.startsWith('questions_') && !req.task.endsWith('_gap')) return req.schema.parse({ questions: [{ prompt: 'Same question everywhere', answer_outline: '', difficulty: 2, requirement_ids: [] }] });
      if (req.task === 'flashcards') return req.schema.parse({ flashcards: [] });
      return realJson(req);
    }) as FakeLlm['json'];
    const kit = await generateKit(globex(), { llm, fetcher: fetcher(), search: noSearch });
    expect(kit.questions.filter((q) => q.prompt === 'Same question everywhere')).toHaveLength(1);
    expect(kit.flashcards.length).toBeGreaterThan(0);
    expect(kit.source.notes!.join(' ')).toMatch(/derived from the question bank/);
  });
});

describe('batch command (evaluate)', () => {
  async function run(argv: string[], input: unknown, overrides: Partial<EvaluateDeps> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'eval-'));
    if (input !== undefined) await writeFile(join(dir, 'in.json'), typeof input === 'string' ? input : JSON.stringify(input));
    const logs: string[] = [];
    const llm = new FakeLlm();
    const code = await main(argv, {
      env: {},
      cwd: dir,
      log: (m) => logs.push(m),
      createLlm: () => llm,
      createFetcher: () => fetcher(),
      search: noSearch,
      ...overrides,
    });
    const out = await readFile(join(dir, 'out.json'), 'utf8').then(JSON.parse).catch(() => null);
    return { code, logs, out, llm };
  }

  it('writes Appendix B output, records failures, reuses duplicate research', async () => {
    const input = [
      { ...cases[0], company_url: `${origin}/acme/` },
      { id: 'bad', jd: 'x', company_url: 'y' },
      null,
      { ...cases[0], id: 'dup', company_url: `${origin}/acme/`, days: 2 },
    ];
    const { code, out, logs } = await run(['--input', 'in.json', '--output=out.json'], input);
    expect(code).toBe(0);
    expect(BatchOutputSchema.safeParse(out).success).toBe(true);
    expect(out.kits.map((k: { id: string; status: string }) => [k.id, k.status])).toEqual([
      ['case-01', 'ok'], ['bad', 'failed'], ['case-3', 'failed'], ['dup', 'ok'],
    ]);
    expect(out.kits[3].kit.schedule.days).toHaveLength(2);
    expect(logs.join('\n')).toMatch(/duplicate of an earlier case/);
  });

  it('records a failed case and continues; reports every case failed when the LLM is not configured', async () => {
    const failing = new FakeLlm();
    failing.failTasks = new Set(['extract_requirements']);
    const a = await run(['--input', 'in.json', '--output', 'out.json'], [{ ...cases[1], company_url: `${origin}/globex/` }], { createLlm: () => failing });
    expect(a.out.kits[0]).toMatchObject({ status: 'failed', error: { code: 'EXTRACTION_FAILED' } });
    const b = await run(['--input', 'in.json', '--output', 'out.json'], [cases[1]], { createLlm: () => { throw new LlmError('LLM_NOT_CONFIGURED', 'GROQ_API_KEY is not set'); } });
    expect(b.out.kits[0].error).toEqual({ code: 'LLM_NOT_CONFIGURED', message: 'GROQ_API_KEY is not set' });
  });

  it('logs model events other than successful calls', async () => {
    const { logs } = await run(['--input', 'in.json', '--output', 'out.json'], [], {
      createLlm: (_env, onEvent) => {
        onEvent({ type: 'call', task: 't', message: 'quiet' });
        onEvent({ type: 'rate_limited', task: 't', message: 'slow', waitMs: 2000 });
        onEvent({ type: 'retry', task: 't', message: 'again' });
        return new FakeLlm();
      },
    });
    expect(logs.join('\n')).toMatch(/llm rate_limited \[t\] slow \(2s\)\n.*llm retry \[t\] again$/m);
    expect(logs.join('\n')).not.toMatch(/quiet/);
  });

  it('usage errors exit with code 2', async () => {
    expect((await run([], undefined)).code).toBe(2);
    expect((await run(['--input', 'missing.json', '--output', 'out.json'], undefined)).code).toBe(2);
    expect((await run(['--input', 'in.json', '--output', 'out.json'], '{not json')).code).toBe(2);
    expect((await run(['--input', 'in.json', '--output', 'out.json'], { not: 'an array' })).code).toBe(2);
  });

  it('helpers: argument parsing, error mapping, default dependencies', () => {
    expect(parseArgs(['--input=a.json', '--output', 'b.json'])).toEqual({ input: 'a.json', output: 'b.json' });
    expect(errorOf('plain')).toEqual({ code: 'INTERNAL', message: 'plain' });
    expect(errorOf(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' });
    const d = defaultDeps();
    expect(d.createFetcher({ ALLOW_PRIVATE_URLS: 'false', CRAWL_MIN_INTERVAL_MS: '10' })).toBeInstanceOf(Fetcher);
    expect(d.createFetcher({})).toBeInstanceOf(Fetcher);
    expect(() => d.createLlm({}, () => {})).toThrow(/GROQ_API_KEY/);
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (writes.push(s), true)) as typeof process.stderr.write;
    try {
      d.log('hello');
    } finally {
      process.stderr.write = orig;
    }
    expect(writes[0]).toMatch(/^\[\d\d:\d\d:\d\d\] hello\n$/);
  });
});
