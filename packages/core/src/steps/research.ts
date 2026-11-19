/**
 * Steps: company brief, and hiring-process summary.
 *
 * Both are conditional on what retrieval actually found. With nothing to work
 * from, they return an explicit "not found" result written by code, so the
 * model never gets the chance to fill the gap from its training data.
 */
import { z } from 'zod';
import type { CrawledPage } from '../retrieval/crawler.js';
import type { DiscussionItem } from '../discussion/search.js';
import type { Llm } from '../llm/types.js';
import { untrusted, UNTRUSTED_RULES } from '../llm/untrusted.js';
import { hiringSignals } from '../retrieval/crawler.js';

// ---------- company brief ----------

export interface CompanyBrief {
  summary: string;
  what_they_do: string;
  sources: string[];
  found: boolean;
}

const BriefSchema = z.object({
  enough_information: z.boolean().catch(true),
  summary: z.string().catch(''),
  what_they_do: z.string().catch(''),
  sources: z.array(z.string()).catch([]),
});

const BRIEF_SYSTEM = `You write a short, factual company brief for someone preparing for an interview. Output JSON only.

${UNTRUSTED_RULES}

Use ONLY the provided pages (and the "About us" parts of the job description, if any). Do not use outside knowledge about the company, even if you recognise the name.
- summary: 2-4 sentences: who they are, what matters to them, anything an interviewer would expect a candidate to know
- what_they_do: 1-3 sentences: products/services and customers, in plain language
- sources: the source URLs (from the provided source attributes) you actually used
- enough_information: false if the material does not say what the company does; then say so plainly in summary instead of guessing

Return: {"enough_information": true, "summary": "", "what_they_do": "", "sources": []}`;

const BRIEF_PAGE_ORDER: Record<string, number> = { home: 0, about: 1, engineering: 2, careers: 3, 'hiring-process': 4, other: 5 };

export function notFoundBrief(company: string, companyUrl: string, reason: string): CompanyBrief {
  return {
    summary: `No reliable information about ${company || 'this company'} could be gathered: ${reason}. This brief is left deliberately sparse rather than guessed. Read the company's site, recent news and product pages yourself before the interview.`,
    what_they_do: `Unknown: nothing retrievable from ${companyUrl || 'the given address'} described the company's products or customers.`,
    sources: [],
    found: false,
  };
}

export async function writeCompanyBrief(args: {
  llm: Llm;
  company: string;
  companyUrl: string;
  pages: CrawledPage[];
  jd: string;
  unreachableReason?: string;
}): Promise<CompanyBrief> {
  const { llm, company, companyUrl, jd } = args;
  const pages = [...args.pages].sort((a, b) => (BRIEF_PAGE_ORDER[a.kind] ?? 9) - (BRIEF_PAGE_ORDER[b.kind] ?? 9)).slice(0, 4);
  const material = pages.reduce((s, p) => s + p.text.length + (p.description?.length ?? 0), 0);
  if (pages.length === 0 || material < 80) {
    return notFoundBrief(company, companyUrl, args.unreachableReason ?? 'the company website returned no usable content');
  }

  const perPage = Math.floor(7000 / pages.length);
  const blocks = pages.map((p) => untrusted(p.url, [p.title, p.description, p.text].filter(Boolean).join('\n'), perPage));
  const out = await llm.json({
    task: 'company_brief',
    system: BRIEF_SYSTEM,
    user: `Company: ${company}\n\nPages:\n${blocks.join('\n\n')}\n\nJob description (for any "About us" section only):\n${untrusted('job-description', jd, 2500)}`,
    schema: BriefSchema,
    maxTokens: 600,
    temperature: 0.1,
  });

  // Only cite pages we actually fetched and showed the model.
  const shown = new Set(pages.map((p) => p.url));
  let sources = out.sources.filter((s) => shown.has(s));
  if (sources.length === 0) sources = pages.map((p) => p.url);
  if (!out.enough_information || !out.what_they_do.trim()) {
    return {
      ...notFoundBrief(company, companyUrl, 'the pages that could be retrieved do not say what the company does'),
      summary: out.summary.trim() || notFoundBrief(company, companyUrl, 'insufficient content').summary,
      sources,
    };
  }
  return { summary: out.summary.trim(), what_they_do: out.what_they_do.trim(), sources, found: true };
}

// ---------- hiring process ----------

export const FORMATS = ['take_home', 'system_design', 'live_coding', 'behavioural', 'recruiter_screen', 'onsite'] as const;
export type InterviewFormat = (typeof FORMATS)[number];

export interface HiringProcess {
  found: boolean;
  source_type: 'official' | 'discussion' | 'none';
  stages: { name: string; description: string }[];
  formats: InterviewFormat[];
  tips: string[];
  sources: string[];
}

export const NO_HIRING_PROCESS: HiringProcess = { found: false, source_type: 'none', stages: [], formats: [], tips: [], sources: [] };

const HiringSchema = z.object({
  described: z.boolean().catch(false),
  stages: z.array(z.object({ name: z.string(), description: z.string().catch('') })).catch([]),
  formats: z.array(z.string()).catch([]),
  tips: z.array(z.string()).catch([]),
  sources: z.array(z.string()).catch([]),
});

const HIRING_SYSTEM = `You summarise how a company interviews candidates, for someone preparing to interview there. Output JSON only.

${UNTRUSTED_RULES}

Use ONLY the provided material. Company pages are official; forum/search snippets are anecdotal.
- described: true only if the material actually describes interview stages or formats
- stages: ordered interview stages, each {name, description} (empty if not described)
- formats: any of ${FORMATS.map((f) => `"${f}"`).join(', ')} that the material says are used
- tips: up to 4 concrete pieces of advice the material itself gives candidates
- sources: the source URLs you used

Return: {"described": false, "stages": [], "formats": [], "tips": [], "sources": []}`;

/** Which formats the raw text actually supports (code-side grounding). */
function formatsSupportedBy(text: string): Set<InterviewFormat> {
  const s = new Set(hiringSignals(text));
  const out = new Set<InterviewFormat>();
  if (s.has('take-home')) out.add('take_home');
  if (s.has('system-design')) out.add('system_design');
  if (s.has('pair-programming')) out.add('live_coding');
  if (s.has('behavioural')) out.add('behavioural');
  if (s.has('screen')) out.add('recruiter_screen');
  if (s.has('onsite')) out.add('onsite');
  return out;
}

export async function summariseHiringProcess(args: {
  llm: Llm;
  company: string;
  pages: CrawledPage[];
  discussion: DiscussionItem[];
}): Promise<HiringProcess> {
  const { llm, company, discussion } = args;
  const official = args.pages
    .filter((p) => p.kind === 'hiring-process' || (p.kind === 'careers' && p.hiringSignals.includes('interview')))
    .sort((a, b) => b.hiringSignals.length - a.hiringSignals.length)
    .slice(0, 2);
  if (official.length === 0 && discussion.length === 0) return NO_HIRING_PROCESS;

  const blocks = [
    ...official.map((p) => untrusted(p.url, p.text, 5000)),
    ...discussion.slice(0, 6).map((d) => untrusted(d.url, `[${d.source}] ${d.title}\n${d.snippet}`, 700)),
  ];
  const out = await llm.json({
    task: 'hiring_process',
    system: HIRING_SYSTEM,
    user: `Company: ${company}\n\nMaterial:\n${blocks.join('\n\n')}`,
    schema: HiringSchema,
    maxTokens: 700,
    temperature: 0.1,
  });

  const allowed = [...official.map((p) => p.url), ...discussion.map((d) => d.url)];
  const sources = out.sources.filter((s) => allowed.includes(s));
  const supported = formatsSupportedBy([...official.map((p) => p.text), ...discussion.map((d) => `${d.title} ${d.snippet}`)].join('\n'));
  const formats = out.formats.filter((f): f is InterviewFormat => (FORMATS as readonly string[]).includes(f) && supported.has(f as InterviewFormat));

  if (!out.described && formats.length === 0) return { ...NO_HIRING_PROCESS, sources };
  return {
    found: true,
    source_type: official.length ? 'official' : 'discussion',
    stages: out.stages.slice(0, 8).map((s) => ({ name: s.name.slice(0, 80), description: s.description.slice(0, 300) })),
    formats,
    tips: out.tips.slice(0, 4).map((t) => t.slice(0, 300)),
    sources: sources.length ? sources : allowed.slice(0, 3),
  };
}
