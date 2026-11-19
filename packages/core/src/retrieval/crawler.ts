/**
 * Company-site crawler: find what the company does and how it hires, without
 * a hard-coded list of paths.
 *
 *   1. Fetch the start URL. If that fails the site is unreachable (the caller
 *      records it; the kit is still built from the description alone).
 *   2. Collect candidate links from the homepage and the sitemap (robots.txt
 *      Sitemap lines, then <base>/sitemap.xml), scoped to the start URL's
 *      origin *and path prefix* so /acme/ never wanders into /other-co/.
 *   3. Score every candidate by URL path + anchor text (scoreLink) and fetch
 *      the best first. Links found on fetched pages join the frontier with a
 *      bonus when the parent looked hiring-related (careers -> "our process").
 *   4. Classify each fetched page by its *content* (classifyPage), because a
 *      path called /team might be the hiring handbook, and /careers might be
 *      only a job list with no process.
 *   5. Stop at the page budget, or when nothing left scores above the floor.
 */
import { cleanHtml, parseSitemap, type CleanPage, type PageLink } from './clean.js';
import { RetrievalError } from './errors.js';
import type { Fetcher } from './fetcher.js';

export type PageKind = 'home' | 'hiring-process' | 'careers' | 'about' | 'engineering' | 'other';

export interface CrawledPage {
  url: string;
  title: string;
  kind: PageKind;
  text: string;
  description?: string;
  siteName?: string;
  linkScore: number;
  hiringSignals: string[];
}

export interface SkippedSource {
  url: string;
  reason: string;
  code?: string;
}

export interface CrawlResult {
  startUrl: string;
  reachable: boolean;
  pages: CrawledPage[];
  skipped: SkippedSource[];
  candidatesConsidered: number;
  hiringPage?: string;
}

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  minScore?: number;
  onPage?: (p: { url: string; kind: PageKind; score: number }) => void;
}

// ---------- link scoring ----------

const POSITIVE: [RegExp, number, 'hiring' | 'about' | 'engineering'][] = [
  [/\binterview(s|ing)?\b/, 10, 'hiring'],
  [/how[\s-]?we[\s-]?hire|hiring[\s-]?process|our[\s-]?process|recruit(ing|ment)?[\s-]?process/, 10, 'hiring'],
  [/\bhiring\b/, 8, 'hiring'],
  [/\bcareers?\b/, 7, 'hiring'],
  [/\bjobs?\b|open[\s-]?(roles|positions)|vacanc/, 6, 'hiring'],
  [/\brecruit/, 6, 'hiring'],
  [/join[\s-]?(us|the[\s-]?team|our[\s-]?team)|work[\s-]?(with|for|at)[\s-]?us/, 6, 'hiring'],
  [/\bhandbook\b/, 5, 'hiring'],
  [/\bpeople\b|\btalent\b/, 3, 'hiring'],
  [/\bculture\b|\bvalues\b/, 3, 'about'],
  [/\babout\b/, 6, 'about'],
  [/who[\s-]?we[\s-]?are|what[\s-]?we[\s-]?do|our[\s-]?story|\bmission\b/, 5, 'about'],
  [/\bcompany\b/, 3, 'about'],
  [/\bproducts?\b|\bplatform\b|\bcustomers\b|\bsolutions\b/, 2, 'about'],
  [/\bengineering\b|\btech(nology)?\b|\bstack\b/, 3, 'engineering'],
  [/\bblog\b/, 1, 'engineering'],
];

const NEGATIVE: [RegExp, number][] = [
  [/\.(pdf|png|jpe?g|gif|svg|webp|zip|mp4|mp3|css|js|json|ico|woff2?)$/, -50],
  [/log[\s-]?in|sign[\s-]?(in|up)|register|account|\bcart\b|checkout|password/, -15],
  [/privacy|terms|legal|cookie|gdpr|imprint|disclaimer|security\.txt/, -10],
  [/\btag\/|\bcategory\/|\bpage\/\d+|\?page=|\bauthor\//, -4],
  [/\bfeed\b|\brss\b|\bstatus\b/, -6],
];

export interface LinkScore {
  score: number;
  kind: 'hiring' | 'about' | 'engineering' | 'other';
}

export function scoreLink(link: PageLink): LinkScore {
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    return { score: -100, kind: 'other' };
  }
  const path = decodeURIComponent(url.pathname + url.search).toLowerCase().replace(/[_/.]+/g, ' ');
  const text = link.text.toLowerCase();
  const pathLower = url.pathname.toLowerCase();
  let score = 0;
  const byKind = { hiring: 0, about: 0, engineering: 0 };
  for (const [re, w, kind] of POSITIVE) {
    const inPath = re.test(path);
    const inText = re.test(text);
    if (inPath || inText) {
      // Anchor text and path agreeing is stronger evidence than either alone.
      const gain = w * (inPath && inText ? 1.5 : 1);
      score += gain;
      byKind[kind] += gain;
    }
  }
  for (const [re, w] of NEGATIVE) if (re.test(pathLower) || re.test(text)) score += w;
  const depth = url.pathname.split('/').filter(Boolean).length;
  if (depth > 3) score -= depth - 3;
  const best = (Object.entries(byKind) as [LinkScore['kind'], number][]).sort((a, b) => b[1] - a[1])[0]!;
  return { score, kind: best[1] > 0 ? best[0] : 'other' };
}

// ---------- page classification ----------

const HIRING_SIGNALS: [string, RegExp][] = [
  ['interview', /\binterview(s|ing|er)?\b/i],
  ['process', /hiring process|interview process|how we hire|our process|recruiting process|stages?\b/i],
  ['take-home', /take[- ]home|home assignment|coding (exercise|assignment|challenge)/i],
  ['system-design', /system[s]? design|architecture (interview|discussion)/i],
  ['pair-programming', /pair(ing)?[- ]programming|live coding|pairing session/i],
  ['screen', /recruiter (call|screen)|phone screen|screening call|intro call/i],
  ['onsite', /on[- ]?site|final round|loop\b|panel/i],
  ['behavioural', /behaviou?ral|values interview|culture (fit|add)|STAR\b/i],
  ['offer', /\boffer\b|reference check/i],
];

const ABOUT_SIGNALS = /\b(we (build|make|help|are)|our (mission|customers|product|platform)|founded in|headquartered|company)\b/i;

export function hiringSignals(text: string): string[] {
  return HIRING_SIGNALS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export function classifyPage(url: string, page: CleanPage, linkKind: LinkScore['kind'], isHome: boolean): PageKind {
  if (isHome) return 'home';
  const signals = hiringSignals(page.text);
  if (signals.includes('interview') && signals.length >= 3) return 'hiring-process';
  if (linkKind === 'hiring' || /career|jobs|join|open roles/i.test(page.title + ' ' + url)) return 'careers';
  if (linkKind === 'engineering') return 'engineering';
  if (linkKind === 'about' || ABOUT_SIGNALS.test(page.text.slice(0, 2000))) return 'about';
  return 'other';
}

// ---------- crawl ----------

function inScope(candidate: URL, base: URL): boolean {
  if (candidate.origin !== base.origin) return false;
  return candidate.pathname.startsWith(base.pathname);
}

/** Base path = the start URL's directory, e.g. /acme/index.html -> /acme/ */
export function scopeBase(start: URL): URL {
  const b = new URL(start.href);
  b.search = '';
  if (!b.pathname.endsWith('/')) b.pathname = b.pathname.replace(/[^/]*$/, '');
  return b;
}

function canonical(u: string): string {
  const url = new URL(u);
  url.hash = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  url.pathname = url.pathname.replace(/\/index\.html?$/i, '') || '/';
  return url.href;
}

function describeError(err: unknown): { reason: string; code?: string } {
  if (err instanceof RetrievalError) return { reason: err.message, code: err.code };
  return { reason: (err as Error)?.message ?? String(err) };
}

export async function crawlCompanySite(startUrl: URL, fetcher: Fetcher, options: CrawlOptions = {}): Promise<CrawlResult> {
  const { maxPages = 8, maxDepth = 2, minScore = 3, onPage } = options;
  const base = scopeBase(startUrl);
  const result: CrawlResult = { startUrl: startUrl.href, reachable: false, pages: [], skipped: [], candidatesConsidered: 0 };

  type Candidate = { link: PageLink; score: number; kind: LinkScore['kind']; depth: number };
  const visited = new Set<string>();
  const frontier = new Map<string, Candidate>();

  const consider = (link: PageLink, depth: number, bonus = 0) => {
    let u: URL;
    try {
      u = new URL(link.url);
    } catch {
      return;
    }
    if (!inScope(u, base)) return;
    const key = canonical(u.href);
    if (visited.has(key)) return;
    const s = scoreLink(link);
    const score = s.score + bonus;
    const prev = frontier.get(key);
    if (!prev || prev.score < score) frontier.set(key, { link: { ...link, url: u.href }, score, kind: s.kind, depth });
  };

  const record = (url: string, page: CleanPage, kind: PageKind, score: number) => {
    const p: CrawledPage = {
      url,
      title: page.title,
      kind,
      text: page.text,
      description: page.description,
      siteName: page.siteName,
      linkScore: score,
      hiringSignals: hiringSignals(page.text),
    };
    result.pages.push(p);
    if (kind === 'hiring-process' && !result.hiringPage) result.hiringPage = url;
    onPage?.({ url, kind, score });
    return p;
  };

  // 1. Home page — the one fetch whose failure means "unreachable".
  let home: CleanPage;
  try {
    const res = await fetcher.get(startUrl);
    home = cleanHtml(res.body, res.finalUrl);
    visited.add(canonical(startUrl.href));
    visited.add(canonical(res.finalUrl));
    result.reachable = true;
    record(res.finalUrl, home, 'home', 0);
  } catch (err) {
    result.skipped.push({ url: startUrl.href, ...describeError(err) });
    return result;
  }
  home.links.forEach((l) => consider(l, 1));

  // 2. Sitemap: finds pages that are not linked from the homepage.
  const sitemapUrls = new Set<string>([...(await fetcher.sitemapsFor(startUrl)), new URL('sitemap.xml', base).href]);
  for (const sm of sitemapUrls) {
    try {
      const smUrl = new URL(sm);
      if (smUrl.origin !== base.origin) continue;
      const res = await fetcher.get(smUrl);
      if (!/xml|text\/plain/.test(res.contentType) && !res.body.trimStart().startsWith('<?xml')) continue;
      parseSitemap(res.body)
        .slice(0, 500)
        .forEach((loc) => consider({ url: loc, text: '' }, 1));
      break;
    } catch {
      // No sitemap is normal; don't report it as a skipped source.
    }
  }

  // 3. Best-first fetch.
  while (result.pages.length < maxPages && frontier.size > 0) {
    const [key, best] = [...frontier.entries()].sort((a, b) => b[1].score - a[1].score)[0]!;
    frontier.delete(key);
    if (best.score < minScore) break;
    visited.add(key);
    result.candidatesConsidered += 1;
    try {
      const res = await fetcher.get(best.link.url);
      if (!/html|xml\+xhtml|text\/plain/i.test(res.contentType || 'text/html')) continue;
      const page = /text\/plain/i.test(res.contentType)
        ? { title: best.link.text, text: res.body.slice(0, 20_000), links: [] }
        : cleanHtml(res.body, res.finalUrl);
      visited.add(canonical(res.finalUrl));
      const kind = classifyPage(res.finalUrl, page, best.kind, false);
      record(res.finalUrl, page, kind, best.score);
      if (best.depth < maxDepth) {
        const bonus = kind === 'careers' || kind === 'hiring-process' || best.kind === 'hiring' ? 3 : 0;
        page.links.forEach((l) => consider(l, best.depth + 1, bonus));
      }
    } catch (err) {
      result.skipped.push({ url: best.link.url, ...describeError(err) });
    }
  }
  result.candidatesConsidered += frontier.size;
  return result;
}
