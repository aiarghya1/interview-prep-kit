/**
 * Public discussion of a company's interview process.
 *
 * Sources (each independently optional; a failure is recorded, not fatal):
 *   - Tavily search API (needs TAVILY_API_KEY): general web, good recall on
 *     Glassdoor/Blind/blog write-ups via their snippets
 *   - Reddit public search JSON (no key; often rate-limited or blocked)
 *   - Hacker News via the Algolia API (no key)
 *
 * We only keep snippets, never whole pages. Code decides relevance: a result
 * must mention the company name *and* an interview-ish word, otherwise it is
 * dropped. That matters for generic names ("Acme"), where search returns noise.
 */
import type { SkippedSource } from '../retrieval/crawler.js';
import { USER_AGENT } from '../retrieval/fetcher.js';

export interface DiscussionItem {
  source: 'tavily' | 'reddit' | 'hackernews';
  url: string;
  title: string;
  snippet: string;
}

export interface DiscussionResult {
  items: DiscussionItem[];
  searched: string[];
  skipped: SkippedSource[];
}

export interface DiscussionOptions {
  tavilyApiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxItems?: number;
}

const INTERVIEW_WORDS = /\binterview|hiring process|onsite|on-site|take[- ]home|recruiter|leetcode|system design|offer\b/i;

export function isRelevant(item: Pick<DiscussionItem, 'title' | 'snippet'>, company: string): boolean {
  const text = `${item.title} ${item.snippet}`;
  const name = company.trim();
  if (name.length < 2) return false;
  // Lookarounds, not \b: \b never matches after punctuation ("Yahoo!", "Acme Inc.").
  const nameRe = new RegExp(`(?<![\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i');
  return nameRe.test(text) && INTERVIEW_WORDS.test(text);
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

async function getJson(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) throw new Error(`unexpected content type ${type}`);
  return res.json();
}

export async function searchInterviewDiscussion(company: string, opts: DiscussionOptions = {}): Promise<DiscussionResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxItems = opts.maxItems ?? 8;
  const result: DiscussionResult = { items: [], searched: [], skipped: [] };
  const query = `${company} interview process`;

  const sources: [DiscussionItem['source'], string, () => Promise<DiscussionItem[]>][] = [];

  if (opts.tavilyApiKey) {
    sources.push([
      'tavily',
      'https://api.tavily.com/search',
      async () => {
        const data = await getJson(
          fetchImpl,
          'https://api.tavily.com/search',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.tavilyApiKey}` },
            body: JSON.stringify({ query: `${company} interview process experience`, max_results: 8, search_depth: 'basic' }),
          },
          timeoutMs,
        );
        return (data.results ?? []).map((r: any) => ({
          source: 'tavily' as const,
          url: String(r.url ?? ''),
          title: String(r.title ?? ''),
          snippet: stripHtml(String(r.content ?? '')).slice(0, 600),
        }));
      },
    ]);
  } else {
    result.skipped.push({ url: 'https://api.tavily.com/search', reason: 'TAVILY_API_KEY not set', code: 'NOT_CONFIGURED' });
  }

  const redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=10&sort=relevance`;
  sources.push([
    'reddit',
    redditUrl,
    async () => {
      const data = await getJson(fetchImpl, redditUrl, { headers: { 'user-agent': USER_AGENT } }, timeoutMs);
      return (data.data?.children ?? []).map((c: any) => ({
        source: 'reddit' as const,
        url: `https://www.reddit.com${c.data?.permalink ?? ''}`,
        title: String(c.data?.title ?? ''),
        snippet: String(c.data?.selftext ?? '').slice(0, 600),
      }));
    },
  ]);

  const hnUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=(story,comment)&hitsPerPage=10`;
  sources.push([
    'hackernews',
    hnUrl,
    async () => {
      const data = await getJson(fetchImpl, hnUrl, { headers: { 'user-agent': USER_AGENT } }, timeoutMs);
      return (data.hits ?? []).map((h: any) => ({
        source: 'hackernews' as const,
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        title: String(h.title ?? h.story_title ?? ''),
        snippet: stripHtml(String(h.comment_text ?? h.story_text ?? '')).slice(0, 600),
      }));
    },
  ]);

  const settled = await Promise.allSettled(sources.map(([, , run]) => run()));
  settled.forEach((s, i) => {
    const [name, url] = sources[i]!;
    result.searched.push(name);
    if (s.status === 'rejected') {
      result.skipped.push({ url, reason: `${name} search failed: ${(s.reason as Error).message}`, code: 'SEARCH_FAILED' });
      return;
    }
    for (const item of s.value) {
      if (item.url && isRelevant(item, company) && !result.items.some((x) => x.url === item.url)) result.items.push(item);
    }
  });
  result.items = result.items.slice(0, maxItems);
  return result;
}
