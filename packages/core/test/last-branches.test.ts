import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultDeps } from '../src/cli/evaluate.js';
import { searchInterviewDiscussion } from '../src/discussion/search.js';
import { GroqLlm } from '../src/llm/groq.js';
import { generateKit } from '../src/pipeline.js';
import { orderSession } from '../src/practice.js';
import { cleanHtml } from '../src/retrieval/clean.js';
import { crawlCompanySite } from '../src/retrieval/crawler.js';
import { RetrievalError } from '../src/retrieval/errors.js';
import { Fetcher } from '../src/retrieval/fetcher.js';
import { isPrivateAddress } from '../src/retrieval/url.js';
import { priorityFromPosting } from '../src/steps/extract.js';
import { planCategories } from '../src/steps/questions.js';
import { FakeLlm } from './fakeLlm.js';
import { req } from './fixtures.js';

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
function fake(routes: Record<string, () => Response>) {
  return new Fetcher({
    policy: { allowPrivate: true },
    minIntervalMs: 0,
    retries: 0,
    sleep: async () => {},
    fetchImpl: (async (u: URL | string) => (routes[new URL(String(u)).pathname] ?? (() => new Response('', { status: 404 })))()) as typeof fetch,
  });
}

describe('remaining branches', () => {
  it('batch command falls back to process.cwd() outside npm', () => {
    const saved = process.env.INIT_CWD;
    delete process.env.INIT_CWD;
    try {
      expect(defaultDeps().cwd).toBe(process.cwd());
    } finally {
      if (saved !== undefined) process.env.INIT_CWD = saved;
    }
  });

  it('discussion search: responses without a content type fail; Tavily results without title/content are dropped', async () => {
    const fetchImpl = (async (u: string) =>
      u.includes('tavily')
        ? new Response(JSON.stringify({ results: [{ url: 'https://x/1' }] }), { headers: { 'content-type': 'application/json' } })
        : new Response(new Uint8Array([123, 125]))) as unknown as typeof fetch;
    const r = await searchInterviewDiscussion('Acme', { tavilyApiKey: 'k', fetchImpl });
    expect(r.items).toEqual([]);
    expect(r.skipped.every((s) => /unexpected content type $/.test(s.reason))).toBe(true);
  });

  it('Groq: real sleep is used by default; a 400 without a message on a reasoning model is not retried', async () => {
    let n = 0;
    const llm = new GroqLlm({
      apiKey: 'k',
      models: ['openai/gpt-oss-120b'],
      fetchImpl: (async () =>
        n++ === 0
          ? new Response(JSON.stringify({ error: { message: 'slow' } }), { status: 429, headers: { 'retry-after': '0.001' } })
          : n === 2
            ? new Response(JSON.stringify({ error: {} }), { status: 400 })
            : new Response('{}')) as typeof fetch,
    });
    const t0 = Date.now();
    await expect(llm.json({ task: 't', system: 's', user: 'u', schema: z.object({}) })).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });

  it('pipeline: crawl failures keep their retrieval code; an undescribed process is reported as such', async () => {
    const throwing = { get: async (u: string | URL) => ({ url: String(u), finalUrl: String(u), status: 200, contentType: 'text/html', body: '<a href="/careers">Careers</a>', truncated: false }), sitemapsFor: async () => { throw new RetrievalError('TIMEOUT', 'robots timed out', 'x'); } } as unknown as Fetcher;
    const kit = await generateKit({ jd: 'Frontend developer wanted. Must know React.', company_url: 'https://x.test/', days: 1 }, { llm: new FakeLlm(), fetcher: throwing, search: async () => ({ items: [], searched: [], skipped: [] }) });
    expect(kit.research!.skipped_sources[0]).toMatchObject({ code: 'TIMEOUT' });

    const llm = new FakeLlm();
    const real = llm.json.bind(llm);
    llm.json = (async (r) => (r.task === 'hiring_process' ? r.schema.parse({ described: false, stages: [], formats: [], tips: [], sources: [] }) : real(r))) as FakeLlm['json'];
    const site = fake({
      '/': () => html('<a href="/how-we-hire">How we hire</a>'),
      '/how-we-hire': () => html('<main>Our interview process: a recruiter screen, a take-home, then an onsite interview loop with the team.</main>'),
    });
    const events: string[] = [];
    await generateKit({ jd: 'Frontend developer wanted. Must know React.', company_url: 'https://x.test/', days: 1 }, { llm, fetcher: site, search: async () => ({ items: [], searched: [], skipped: [] }), onProgress: (e) => e.step === 'hiring' && events.push(e.message) });
    expect(events).toContain('No process described');
  });

  it('practice: unseen cards for must-haves come before others', () => {
    const order = orderSession(
      [{ id: 'f1', front: 'a', back: '', requirement_ids: ['r2'] }, { id: 'f2', front: 'b', back: '', requirement_ids: ['r1'] }],
      {},
      [req('r1', 'must'), req('r2', 'nice')],
      new Date(),
    );
    expect(order).toEqual(['f2', 'f1']);
  });

  it('cleanHtml uses a link title attribute when there is no text or aria-label', () => {
    expect(cleanHtml('<a href="/x" title="Careers page"></a>', 'https://a/').links[0]!.text).toBe('Careers page');
    expect(cleanHtml('<a href="/y"><img src="logo.png"></a>', 'https://a/').links[0]).toEqual({ url: 'https://a/y', text: '' });
  });

  it('crawler: non-Error throws, invalid sitemap URLs, missing sitemap, untyped pages; robots 204 means allow all', async () => {
    const weird = { get: async () => { throw 'plain string'; }, sitemapsFor: async () => [] } as unknown as Fetcher;
    expect((await crawlCompanySite(new URL('https://x.test/'), weird)).skipped[0]!.reason).toBe('plain string');

    const withBadSitemap = fake({
      '/robots.txt': () => new Response(null, { status: 204 }),
      '/': () => html('<a href="/about">About us</a>'),
      '/sitemap.xml': () => new Response('<?xml version="1.0"?><urlset><url><loc>http://[bad</loc></url></urlset>', { headers: { 'content-type': 'application/xml' } }),
      '/about': () => new Response(new TextEncoder().encode('<main>About X. We build tools.</main>')),
    });
    const r = await crawlCompanySite(new URL('https://x.test/'), withBadSitemap);
    expect(r.pages.map((p) => p.url)).toEqual(['https://x.test/', 'https://x.test/about']);

    const noSitemap = fake({ '/': () => html('<a href="/about">About us</a>'), '/about': () => html('<main>About X</main>') });
    expect((await crawlCompanySite(new URL('https://x.test/'), noSitemap)).pages).toHaveLength(2);
  });

  it('anything that is not an IP address is treated as unsafe', () => {
    expect(isPrivateAddress('example.com')).toBe(true);
  });

  it('extract: sentences, bullets and long lines are not headings', () => {
    const jd = 'Nice to have:\nWe move fast.\n- a bullet\none two three four five six seven eight\nKubernetes';
    expect(priorityFromPosting(jd, 'Kubernetes')).toBe('nice');
  });

  it('questions: senior titles trigger system design even without a stated seniority', () => {
    const plan = planCategories([req('r1')], {
      roleTitle: 'Senior Engineer',
      seniority: '',
      brief: { summary: '', what_they_do: '', sources: [], found: false },
      hiring: { found: false, source_type: 'none', stages: [], formats: [], tips: [], sources: [] },
    }).find((p) => p.category === 'system-design')!;
    expect(plan.reason).toBe('role seniority (Senior Engineer)');
  });
});
