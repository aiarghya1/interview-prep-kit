import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { startFixtureServer } from '../fixtures/serve.js';
import { crawlCompanySite } from '../src/retrieval/crawler.js';
import { Fetcher } from '../src/retrieval/fetcher.js';

let server: Server;
let origin: string;
const fetcher = () => new Fetcher({ policy: { allowPrivate: true }, minIntervalMs: 0, timeoutMs: 1500, retries: 1, sleep: async () => {} });

beforeAll(async () => {
  ({ server, origin } = await startFixtureServer(0));
});
afterAll(() => server.close());

describe('crawlCompanySite (fixture sites)', () => {
  it('finds a hiring process buried in the handbook, and never fetches robots-disallowed pages', async () => {
    const r = await crawlCompanySite(new URL(`${origin}/acme/`), fetcher());
    expect(r.reachable).toBe(true);
    expect(r.hiringPage).toBe(`${origin}/acme/handbook/people-ops/how-we-interview.html`);
    const urls = r.pages.map((p) => p.url);
    expect(urls.some((u) => u.includes('/private/'))).toBe(false);
    expect(urls.some((u) => u.includes('privacy'))).toBe(false);
    expect(r.pages.find((p) => p.kind === 'about')).toBeDefined();
    expect(r.pages.length).toBeLessThanOrEqual(8);
  });

  it('stays inside the start path (one host serving several companies)', async () => {
    const r = await crawlCompanySite(new URL(`${origin}/acme/`), fetcher());
    r.pages.forEach((p) => expect(p.url.startsWith(`${origin}/acme/`)).toBe(true));
  });

  it('reports no hiring page when the site has none', async () => {
    const r = await crawlCompanySite(new URL(`${origin}/globex/`), fetcher());
    expect(r.reachable).toBe(true);
    expect(r.hiringPage).toBeUndefined();
    expect(r.pages.map((p) => p.kind)).toContain('about');
  });

  it('discovers unlinked pages through the sitemap', async () => {
    const r = await crawlCompanySite(new URL(`${origin}/initech/`), fetcher());
    expect(r.hiringPage).toBe(`${origin}/initech/team/hiring-process.html`);
  });

  it('records a 404 homepage as unreachable rather than throwing', async () => {
    const r = await crawlCompanySite(new URL(`${origin}/nope/`), fetcher());
    expect(r.reachable).toBe(false);
    expect(r.skipped[0]).toMatchObject({ code: 'HTTP_ERROR' });
  });

  it('records a timeout', async () => {
    const r = await crawlCompanySite(new URL(`${origin}/slow/`), new Fetcher({ policy: { allowPrivate: true }, minIntervalMs: 0, timeoutMs: 200, retries: 0 }));
    expect(r.reachable).toBe(false);
    expect(r.skipped[0]).toMatchObject({ code: 'TIMEOUT' });
  });

  it('records a connection failure', async () => {
    const r = await crawlCompanySite(new URL('http://localhost:1/'), fetcher());
    expect(r.reachable).toBe(false);
    expect(r.skipped[0]!.code).toBe('NETWORK');
  });
});
