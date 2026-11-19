import { describe, expect, it } from 'vitest';
import { Fetcher } from '../src/retrieval/fetcher.js';
import { cleanHtml } from '../src/retrieval/clean.js';
import { assertFetchable, defaultUrlPolicy, dnsResolve } from '../src/retrieval/url.js';
import { classifyPage, crawlCompanySite, scopeBase, scoreLink } from '../src/retrieval/crawler.js';
import { isRelevant, searchInterviewDiscussion } from '../src/discussion/search.js';

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });

/** Fetcher with a fake network: routes by path; robots.txt 404 unless routed. */
function fakeFetcher(routes: Record<string, Route>, opts: ConstructorParameters<typeof Fetcher>[0] = {}) {
  const seen: string[] = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit) => {
    const url = new URL(String(input));
    seen.push(url.pathname);
    const r = routes[url.pathname];
    return r ? r(url, init) : new Response('nope', { status: 404 });
  }) as typeof fetch;
  const fetcher = new Fetcher({ policy: { allowPrivate: true }, minIntervalMs: 0, retries: 1, sleep: async () => {}, fetchImpl, ...opts });
  return { fetcher, seen };
}

describe('Fetcher', () => {
  it('uses safe defaults when constructed bare', () => {
    expect(new Fetcher()).toBeInstanceOf(Fetcher);
  });

  it('respects robots.txt disallow rules and crawl-delay', async () => {
    const sleeps: number[] = [];
    const { fetcher } = fakeFetcher(
      { '/robots.txt': () => new Response('User-agent: *\nDisallow: /secret\nCrawl-delay: 2', { headers: { 'content-type': 'text/plain' } }), '/ok': () => html('ok') },
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    await expect(fetcher.get('https://x.test/secret')).rejects.toMatchObject({ code: 'ROBOTS_DISALLOWED' });
    await fetcher.get('https://x.test/ok');
    await fetcher.get('https://x.test/ok');
    expect(sleeps.some((ms) => ms > 1000)).toBe(true);
  });

  it('follows redirects (re-validating each hop) and stops after five', async () => {
    const { fetcher } = fakeFetcher({ '/a': () => new Response(null, { status: 301, headers: { location: '/b' } }), '/b': () => html('landed') });
    const r = await fetcher.get('https://x.test/a');
    expect(r).toMatchObject({ finalUrl: 'https://x.test/b', body: 'landed' });
    const loop = fakeFetcher({ '/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }) });
    await expect(loop.fetcher.get('https://x.test/loop')).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
  });

  it('honours Retry-After on 429 and retries', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const { fetcher } = fakeFetcher(
      { '/p': () => (n++ === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }) : html('ok')) },
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    await expect(fetcher.get('https://x.test/p')).resolves.toMatchObject({ body: 'ok' });
    expect(sleeps.some((ms) => ms >= 3000)).toBe(true);
  });

  it('rejects unsupported content types and oversized responses; accepts a missing type', async () => {
    const { fetcher } = fakeFetcher({
      '/img': () => new Response('x', { headers: { 'content-type': 'image/png' } }),
      '/big': () => new Response('x', { headers: { 'content-type': 'text/html', 'content-length': String(50_000_000) } }),
      '/untyped': () => new Response(new TextEncoder().encode('plain bytes')),
    });
    await expect(fetcher.get('https://x.test/img')).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
    await expect(fetcher.get('https://x.test/big')).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const untyped = await fetcher.get('https://x.test/untyped');
    expect(untyped.body).toBe('plain bytes');
  });

  it('truncates long bodies while streaming, and handles empty bodies', async () => {
    const { fetcher } = fakeFetcher(
      { '/long': () => html('a'.repeat(5000)), '/empty': () => new Response(null, { status: 200, headers: { 'content-type': 'text/html' } }) },
      { maxBytes: 100 },
    );
    const long = await fetcher.get('https://x.test/long');
    expect(long).toMatchObject({ truncated: true });
    expect(long.body).toHaveLength(100);
    expect((await fetcher.get('https://x.test/empty')).body).toBe('');
  });

  it('wraps unexpected failures as network errors', async () => {
    const broken = new ReadableStream({ pull() { throw new Error('socket hang up'); } });
    const { fetcher } = fakeFetcher({ '/x': () => new Response(broken, { headers: { 'content-type': 'text/html' } }) }, { retries: 0 });
    await expect(fetcher.get('https://x.test/x')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('cleanHtml edge cases', () => {
  it('skips unparseable and non-http links, merges anchor text of repeated links, uses aria-label', () => {
    const page = cleanHtml(
      `<a href="http://[bad">bad</a><a href="ftp://x/y">ftp</a>
       <a href="/careers">Careers</a><a href="/careers">Join us</a><a href="/careers">Careers</a>
       <a href="/about" aria-label="About the company"><svg></svg></a>`,
      'https://a.example/',
    );
    expect(page.links).toEqual([
      { url: 'https://a.example/careers', text: 'Careers Join us' },
      { url: 'https://a.example/about', text: 'About the company' },
    ]);
  });
  it('falls back from <title> to <h1>, and from short <main> to the body', () => {
    const page = cleanHtml('<body><h1>Heading</h1><main>tiny</main><p>Body text that is the real content.</p></body>', 'https://a/');
    expect(page.title).toBe('Heading');
    expect(page.text).toMatch(/Body text/);
    expect(cleanHtml('', 'https://a/').text).toBe('');
  });
});

describe('URL policy', () => {
  it('defaults from the environment', () => {
    expect(defaultUrlPolicy({ ALLOW_PRIVATE_URLS: 'true', NODE_ENV: 'production' })).toEqual({ allowPrivate: true });
    expect(defaultUrlPolicy({ ALLOW_PRIVATE_URLS: 'false' })).toEqual({ allowPrivate: false });
    expect(defaultUrlPolicy({ NODE_ENV: 'production' })).toEqual({ allowPrivate: false });
    expect(defaultUrlPolicy({})).toEqual({ allowPrivate: true });
  });
  it('rejects non-http protocols even when private addresses are allowed', async () => {
    await expect(assertFetchable(new URL('ftp://x.test/'), { allowPrivate: true })).rejects.toMatchObject({ code: 'INVALID_URL' });
  });
  it('resolves hostnames and blocks those pointing at private addresses', async () => {
    const policy = { allowPrivate: false };
    await expect(assertFetchable(new URL('https://public.test/'), policy, async () => ['93.184.216.34'])).resolves.toBeUndefined();
    await expect(assertFetchable(new URL('https://rebind.test/'), policy, async () => ['93.184.216.34', '10.0.0.5'])).rejects.toMatchObject({ code: 'BLOCKED_URL' });
    await expect(assertFetchable(new URL('https://nx.test/'), policy, async () => { throw new Error('ENOTFOUND'); })).rejects.toMatchObject({ code: 'NETWORK' });
  });
  it('the default resolver uses the system resolver', async () => {
    expect((await dnsResolve('localhost')).length).toBeGreaterThan(0);
  });
});

describe('crawler edge cases', () => {
  it('scores an unparseable link as junk and classifies pages', () => {
    expect(scoreLink({ url: 'not a url', text: '' }).score).toBe(-100);
    expect(classifyPage('https://a/', { title: '', text: '', links: [] }, 'other', true)).toBe('home');
    expect(classifyPage('https://a/x', { title: 'X', text: 'Lorem ipsum', links: [] }, 'other', false)).toBe('other');
    expect(classifyPage('https://a/x', { title: 'X', text: 'We build tools for teams', links: [] }, 'other', false)).toBe('about');
    expect(classifyPage('https://a/eng', { title: 'X', text: '', links: [] }, 'engineering', false)).toBe('engineering');
  });
  it('scopes to the directory of a file start URL', () => {
    expect(scopeBase(new URL('https://a.test/acme/index.html?x=1')).href).toBe('https://a.test/acme/');
  });
  it('handles foreign/invalid sitemaps, plain-text and non-HTML pages, and failing links', async () => {
    const { fetcher } = fakeFetcher({
      '/robots.txt': () => new Response('Sitemap: https://elsewhere.test/sitemap.xml', { headers: { 'content-type': 'text/plain' } }),
      '/': () => html('<a href="/index.html">Home</a><a href="/careers">Careers</a><a href="/about-us">About us</a><a href="/jobs.json">Jobs feed</a><a href="/hiring">Hiring</a>'),
      '/sitemap.xml': () => html('<p>not a sitemap</p>'),
      '/careers': () => new Response('Careers at X. Our interview process has a recruiter screen and an onsite.', { headers: { 'content-type': 'text/plain' } }),
      '/about-us': () => new Response('<feed/>', { headers: { 'content-type': 'application/xml' } }),
      '/hiring': () => new Response('gone', { status: 410 }),
    });
    const r = await crawlCompanySite(new URL('https://x.test/'), fetcher);
    expect(r.pages.map((p) => [p.url, p.kind])).toEqual([
      ['https://x.test/', 'home'],
      ['https://x.test/careers', 'hiring-process'],
    ]);
    expect(r.skipped).toEqual([expect.objectContaining({ url: 'https://x.test/hiring', code: 'HTTP_ERROR' })]);
  });
  it('ignores invalid sitemap entries and reports non-retrieval errors from the home page', async () => {
    const { fetcher } = fakeFetcher({
      '/': () => html('home'),
      '/sitemap.xml': () => new Response('<?xml version="1.0"?><urlset><url><loc>not a url</loc></url><url><loc>https://x.test/about</loc></url></urlset>', { headers: { 'content-type': 'text/html' } }),
      '/about': () => html('<main>About X: we build things.</main>'),
    });
    const r = await crawlCompanySite(new URL('https://x.test/'), fetcher);
    expect(r.pages.map((p) => p.url)).toContain('https://x.test/about');
    const boom = { get: async () => { throw new Error('boom'); }, sitemapsFor: async () => [] } as unknown as Fetcher;
    const r2 = await crawlCompanySite(new URL('https://x.test/'), boom);
    expect(r2.skipped[0]).toEqual({ url: 'https://x.test/', reason: 'boom' });
  });
});

describe('discussion search', () => {
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  function fakeNet(handlers: Record<string, () => Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (u: string, init: RequestInit) => {
      calls.push({ url: u, init });
      const key = Object.keys(handlers).find((k) => u.includes(k))!;
      return handlers[key]!();
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('combines Tavily, Reddit and HN; keeps only relevant, unique results; caps the count', async () => {
    const { fetchImpl, calls } = fakeNet({
      tavily: () => json({ results: [
        { url: 'https://blog.test/acme', title: 'My Acme interview process', content: '<b>Acme</b> had a take-home' },
        { url: 'https://blog.test/other', title: 'Acme pricing', content: 'nothing about hiring' },
        { title: 'no url', content: 'Acme interview' },
      ] }),
      reddit: () => json({ data: { children: [
        { data: { permalink: '/r/x/1', title: 'Acme onsite interview experience', selftext: 'long day' } },
        { data: {} },
      ] } }),
      algolia: () => json({ hits: [
        { objectID: '9', story_title: 'Acme', comment_text: 'Their recruiter call was <i>short</i>' },
        { objectID: '10', title: 'Acme interview', story_text: null },
        { objectID: '11' },
      ] }),
    });
    const r = await searchInterviewDiscussion('Acme', { tavilyApiKey: 'k', fetchImpl, maxItems: 3 });
    expect(r.searched).toEqual(['tavily', 'reddit', 'hackernews']);
    expect(r.items.map((i) => i.url)).toEqual([
      'https://blog.test/acme',
      'https://www.reddit.com/r/x/1',
      'https://news.ycombinator.com/item?id=9',
    ]);
    expect(r.items[0]!.snippet).toBe('Acme had a take-home');
    expect(String(calls[0]!.init.headers && (calls[0]!.init.headers as Record<string, string>).authorization)).toBe('Bearer k');
  });

  it('records failures per source without failing the search, and notes a missing Tavily key', async () => {
    const { fetchImpl } = fakeNet({
      reddit: () => new Response('blocked', { status: 403 }),
      algolia: () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    });
    const r = await searchInterviewDiscussion('Acme', { fetchImpl });
    expect(r.items).toEqual([]);
    expect(r.skipped.map((s) => s.code)).toEqual(['NOT_CONFIGURED', 'SEARCH_FAILED', 'SEARCH_FAILED']);
    expect(r.skipped[1]!.reason).toMatch(/HTTP 403/);
    expect(r.skipped[2]!.reason).toMatch(/unexpected content type/);
  });

  it('handles empty payloads and uses the global fetch by default', async () => {
    const { fetchImpl } = fakeNet({ tavily: () => json({}), reddit: () => json({}), algolia: () => json({}) });
    expect((await searchInterviewDiscussion('Acme', { tavilyApiKey: 'k', fetchImpl })).items).toEqual([]);
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      expect((await searchInterviewDiscussion('Acme')).searched).toEqual(['reddit', 'hackernews']);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('relevance needs the company name as a word plus an interview term', () => {
    expect(isRelevant({ title: 'Acme interview', snippet: '' }, 'A')).toBe(false);
    expect(isRelevant({ title: 'Acmeco interview', snippet: '' }, 'Acme')).toBe(false);
    expect(isRelevant({ title: 'Acme (YC) interview', snippet: '' }, 'Acme (YC)')).toBe(true);
    expect(isRelevant({ title: 'Interviewing at Yahoo! was fun', snippet: '' }, 'Yahoo!')).toBe(true);
  });
});
