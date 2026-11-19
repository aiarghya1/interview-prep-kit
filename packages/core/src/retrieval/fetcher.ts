/**
 * Polite, defensive HTTP fetching for untrusted sites.
 *
 * - URL policy checked on the initial URL and on every redirect hop
 * - robots.txt respected (cached per origin), including Crawl-delay
 * - per-host minimum interval between requests
 * - timeout, retries with exponential backoff + jitter on transient failures,
 *   Retry-After honoured (capped)
 * - only text/html, xhtml, text/plain and xml accepted; body size capped while
 *   streaming, so a huge response is cut off rather than buffered
 */
import { RetrievalError } from './errors.js';
import { assertFetchable, defaultUrlPolicy, type UrlPolicy } from './url.js';
import { ALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from './robots.js';

export const USER_AGENT = 'InterviewPrepKitBot/1.0 (+https://github.com/aiarghya1/interview-prep-kit)';

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

export interface FetcherOptions {
  policy?: UrlPolicy;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  minIntervalMs?: number;
  respectRobots?: boolean;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const ACCEPTED_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml)/i;
const MAX_REDIRECTS = 5;
const MAX_RETRY_AFTER_MS = 15_000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Fetcher {
  private readonly opts: Required<Omit<FetcherOptions, 'fetchImpl' | 'sleep' | 'policy'>>;
  private readonly policy: UrlPolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nextSlot = new Map<string, number>();
  private readonly robots = new Map<string, Promise<RobotsRules>>();
  private readonly crawlDelay = new Map<string, number>();

  constructor(options: FetcherOptions = {}) {
    this.policy = options.policy ?? defaultUrlPolicy();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.opts = {
      timeoutMs: options.timeoutMs ?? 10_000,
      maxBytes: options.maxBytes ?? 1_500_000,
      retries: options.retries ?? 3,
      minIntervalMs: options.minIntervalMs ?? 750,
      respectRobots: options.respectRobots ?? true,
    };
  }

  /** Fetch a page as text. Throws RetrievalError. */
  async get(input: string | URL, opts: { skipRobots?: boolean } = {}): Promise<FetchedPage> {
    const url = typeof input === 'string' ? new URL(input) : input;
    await assertFetchable(url, this.policy);
    if (this.opts.respectRobots && !opts.skipRobots) {
      const rules = await this.robotsFor(url);
      if (!isAllowed(rules, url.pathname + url.search)) {
        throw new RetrievalError('ROBOTS_DISALLOWED', `robots.txt disallows ${url.pathname}`, url.href);
      }
    }
    return this.withRetries(url);
  }

  /** Sitemaps declared in robots.txt for this origin. */
  async sitemapsFor(url: URL): Promise<string[]> {
    return (await this.robotsFor(url)).sitemaps;
  }

  private robotsFor(url: URL): Promise<RobotsRules> {
    const origin = url.origin;
    let p = this.robots.get(origin);
    if (!p) {
      p = this.withRetries(new URL('/robots.txt', origin), 1)
        .then((res) => (res.status === 200 ? parseRobots(res.body, USER_AGENT) : ALLOW_ALL))
        .catch(() => ALLOW_ALL)
        .then((rules) => {
          if (rules.crawlDelayMs) this.crawlDelay.set(origin, Math.min(rules.crawlDelayMs, 10_000));
          return rules;
        });
      this.robots.set(origin, p);
    }
    return p;
  }

  private async throttle(url: URL): Promise<void> {
    const host = url.host;
    const delay = Math.max(this.opts.minIntervalMs, this.crawlDelay.get(url.origin) ?? 0);
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + delay);
    if (slot > now) await this.sleep(slot - now);
  }

  private async withRetries(url: URL, retries = this.opts.retries): Promise<FetchedPage> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.once(url);
      } catch (err) {
        const e = err instanceof RetrievalError ? err : new RetrievalError('NETWORK', String(err), url.href);
        attempt += 1;
        if (!e.transient || attempt > retries) throw e;
        const backoff = (e as RetrievalError & { retryAfterMs?: number }).retryAfterMs ?? 500 * 2 ** (attempt - 1);
        await this.sleep(Math.min(backoff, MAX_RETRY_AFTER_MS) + Math.floor(Math.random() * 250));
      }
    }
  }

  private async once(start: URL): Promise<FetchedPage> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await this.throttle(url);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(this.opts.timeoutMs),
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1' },
        });
      } catch (err) {
        const name = (err as Error).name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new RetrievalError('TIMEOUT', `Timed out after ${this.opts.timeoutMs}ms`, url.href);
        }
        throw new RetrievalError('NETWORK', `Could not connect: ${(err as Error).message}`, url.href);
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location')!, url);
        await assertFetchable(next, this.policy);
        url = next;
        continue;
      }
      if (!res.ok) {
        const e = new RetrievalError('HTTP_ERROR', `HTTP ${res.status}`, url.href, res.status) as RetrievalError & {
          retryAfterMs?: number;
        };
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = ra * 1000;
        await res.body?.cancel().catch(() => {});
        throw e;
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType && !ACCEPTED_TYPES.test(contentType)) {
        await res.body?.cancel().catch(() => {});
        throw new RetrievalError('UNSUPPORTED_CONTENT', `Unsupported content type ${contentType}`, url.href);
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.opts.maxBytes * 4) {
        await res.body?.cancel().catch(() => {});
        throw new RetrievalError('TOO_LARGE', `Response is ${declared} bytes`, url.href);
      }
      const { text, truncated } = await readCapped(res, this.opts.maxBytes);
      return { url: start.href, finalUrl: url.href, status: res.status, contentType, body: text, truncated };
    }
    throw new RetrievalError('TOO_MANY_REDIRECTS', `More than ${MAX_REDIRECTS} redirects`, start.href);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks)), truncated };
}
