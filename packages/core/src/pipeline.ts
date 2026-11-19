/**
 * The kit pipeline. One implementation, used by both the API and the batch
 * command.
 *
 *   extract requirements  (pasted JD: no retrieval)   ┐ in parallel
 *   crawl company site    (homepage -> ranked links)  ┘
 *   -> company name (JD, then site metadata, then URL)
 *   -> public discussion search          (needs the name)
 *   -> hiring-process summary            (only if a hiring page or discussion was found)
 *   -> company brief                     (only from pages actually fetched)
 *   -> questions, one call per category  (plan depends on requirements + hiring process)
 *   -> coverage loop: check -> fill gaps -> check   (code decides gaps)
 *   -> flashcards
 *   -> schedule                          (code, no model)
 *   -> structural validation before returning
 *
 * Partial research is normal and recorded in `research` / notes; only a
 * missing or unusable description, or a model that can't extract at all,
 * fails the case.
 */
import { createIdAllocator } from './ids.js';
import { categoryForRequirement, runCoverageLoop } from './coverage.js';
import { buildSchedule } from './schedule.js';
import { validateKit, type Kit, type Question, type QuestionCategory, type Requirement, type Research } from './schema.js';
import { crawlCompanySite, type CrawledPage, type CrawlResult, type SkippedSource } from './retrieval/crawler.js';
import type { Fetcher } from './retrieval/fetcher.js';
import { normaliseUserUrl } from './retrieval/url.js';
import { RetrievalError } from './retrieval/errors.js';
import { searchInterviewDiscussion, type DiscussionItem, type DiscussionResult } from './discussion/search.js';
import { LlmError, type Llm } from './llm/types.js';
import { extractRole, type ExtractedRole } from './steps/extract.js';
import { NO_HIRING_PROCESS, notFoundBrief, summariseHiringProcess, writeCompanyBrief, type CompanyBrief, type HiringProcess } from './steps/research.js';
import { generateCategoryQuestions, planCategories, type QuestionContext } from './steps/questions.js';
import { cardsFromQuestions, flashcardCount, generateFlashcards } from './steps/flashcards.js';
import { normaliseForMatch } from './steps/extract.js';

export interface KitInput {
  jd: string;
  company_url: string;
  days: number;
}

export type StepStatus = 'running' | 'done' | 'skipped' | 'failed';

export interface ProgressEvent {
  step: string;
  status: StepStatus;
  message: string;
  at: string;
}

export interface PipelineDeps {
  llm: Llm;
  fetcher: Fetcher;
  search?: (company: string) => Promise<DiscussionResult>;
  onProgress?: (e: ProgressEvent) => void;
  /** Epoch ms after which optional steps are skipped to finish in time. */
  deadline?: number;
  now?: () => Date;
  maxCoveragePasses?: number;
}

export type PipelineErrorCode = 'INVALID_INPUT' | 'EXTRACTION_FAILED' | 'LLM_UNAVAILABLE' | 'KIT_INVALID';

export class PipelineError extends Error {
  constructor(
    readonly code: PipelineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

export const MIN_JD_CHARS = 20;
export const MAX_JD_CHARS = 30_000;
export const MAX_DAYS = 365;

export function validateKitInput(input: KitInput): void {
  if (typeof input.jd !== 'string' || input.jd.trim().length < MIN_JD_CHARS) {
    throw new PipelineError('INVALID_INPUT', `Job description is empty or too short (min ${MIN_JD_CHARS} characters)`);
  }
  if (input.jd.length > MAX_JD_CHARS) throw new PipelineError('INVALID_INPUT', `Job description is too long (max ${MAX_JD_CHARS} characters)`);
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_DAYS) {
    throw new PipelineError('INVALID_INPUT', `days must be an integer from 1 to ${MAX_DAYS}`);
  }
}

/** Company name from site metadata, falling back to the URL. */
export function deriveCompanyName(url: URL | null, siteName?: string, title?: string): string {
  if (siteName?.trim()) return siteName.trim().slice(0, 80);
  const fromTitle = title?.split(/\s[|\-–—:·]\s/)[0]?.trim();
  if (fromTitle && fromTitle.length <= 40 && !/^(home|welcome|index)$/i.test(fromTitle)) return fromTitle;
  if (!url) return '';
  const isLocal = /^(localhost|127\.|\[?::1\]?$)/.test(url.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
  const seg = isLocal ? url.pathname.split('/').filter(Boolean)[0] : url.hostname.replace(/^www\./, '').split('.')[0];
  if (!seg) return url.hostname;
  return seg.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Retrieved material kept with a kit so a section can be regenerated without re-crawling. */
export interface ResearchCorpus {
  jd: string;
  pages: CrawledPage[];
  discussion: DiscussionItem[];
}

export async function generateKit(input: KitInput, deps: PipelineDeps): Promise<Kit> {
  return (await runPipeline(input, deps)).kit;
}

export async function runPipeline(input: KitInput, deps: PipelineDeps): Promise<{ kit: Kit; corpus: ResearchCorpus }> {
  validateKitInput(input);
  const now = deps.now ?? (() => new Date());
  const steps: Research['steps'] = [];
  const skipped: SkippedSource[] = [];
  const sourceNotes: string[] = [];
  const emit = (step: string, status: StepStatus, message: string) =>
    deps.onProgress?.({ step, status, message, at: now().toISOString() });
  const timeLeft = () => (deps.deadline ? deps.deadline - Date.now() : Number.POSITIVE_INFINITY);

  async function step<T>(name: string, label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    emit(name, 'running', label);
    try {
      const out = await fn();
      steps.push({ step: name, status: 'done', ms: Date.now() - t0 });
      return out;
    } catch (err) {
      steps.push({ step: name, status: 'failed', detail: (err as Error).message, ms: Date.now() - t0 });
      emit(name, 'failed', (err as Error).message);
      throw err;
    }
  }
  const skip = (name: string, why: string) => {
    steps.push({ step: name, status: 'skipped', detail: why });
    emit(name, 'skipped', why);
  };

  // ---- 1. Extract + crawl, in parallel ----
  let startUrl: URL | null = null;
  let urlProblem: string | undefined;
  try {
    startUrl = normaliseUserUrl(input.company_url);
  } catch (err) {
    urlProblem = (err as Error).message;
    skipped.push({ url: input.company_url, reason: urlProblem, code: 'INVALID_URL' });
  }

  const extractP = step('extract', 'Extracting requirements from the description', () => extractRole(input.jd, deps.llm)).then(
    (r) => {
      emit('extract', 'done', `${r.requirements.length} requirement(s), ${r.requirements.filter((x) => x.priority === 'must').length} must-have`);
      return r;
    },
  );
  const crawlP: Promise<CrawlResult | null> = startUrl
    ? step('crawl', `Crawling ${startUrl.href}`, () =>
        crawlCompanySite(startUrl!, deps.fetcher, {
          onPage: (p) => emit('crawl', 'running', `Fetched ${p.url} (${p.kind})`),
        }),
      ).then((c) => {
        emit('crawl', 'done', c.reachable ? `${c.pages.length} page(s); hiring page ${c.hiringPage ? 'found' : 'not found'}` : 'site unreachable');
        return c;
      })
    : Promise.resolve(null).then(() => {
        skip('crawl', `Invalid company URL: ${urlProblem}`);
        return null;
      });

  const [extracted, crawl] = await Promise.all([
    extractP.catch((err) => {
      if (err instanceof LlmError) {
        throw new PipelineError(err.code === 'LLM_INVALID_OUTPUT' ? 'EXTRACTION_FAILED' : 'LLM_UNAVAILABLE', err.message);
      }
      throw new PipelineError('EXTRACTION_FAILED', (err as Error).message);
    }) as Promise<ExtractedRole>,
    crawlP.catch((err) => {
      skipped.push({ url: input.company_url, reason: (err as Error).message, code: err instanceof RetrievalError ? err.code : undefined });
      return null;
    }),
  ]);

  const pages = crawl?.pages ?? [];
  if (crawl) skipped.push(...crawl.skipped);
  const unreachable = !crawl?.reachable;
  if (unreachable && startUrl) {
    const why = crawl?.skipped[0]?.reason ?? 'unknown error';
    sourceNotes.push(`COMPANY_UNREACHABLE: ${startUrl.href} could not be retrieved (${why}). The kit is built from the job description alone.`);
  } else if (urlProblem) {
    sourceNotes.push(`INVALID_COMPANY_URL: ${urlProblem}. The kit is built from the job description alone.`);
  }
  if (crawl?.reachable && !crawl.hiringPage) {
    sourceNotes.push('NO_HIRING_PAGE: no page describing the interview process was found on the company site.');
  }

  const home = pages.find((p) => p.kind === 'home');
  const company = extracted.company || deriveCompanyName(startUrl, home?.siteName, home?.title);
  // A name guessed only from the URL (site unreachable, posting doesn't name
  // the company) is too weak to search the web with: it finds namesakes.
  const nameIsGuess = !extracted.company && !home;

  // ---- 2. Public discussion ----
  let discussion: DiscussionResult = { items: [], searched: [], skipped: [] };
  if (!company) skip('discussion', 'No company name to search for');
  else if (nameIsGuess) {
    skip('discussion', `Company name "${company}" is only a guess from the URL; not searching to avoid unrelated results`);
    sourceNotes.push('NO_PUBLIC_DISCUSSION: not searched, because the company could not be identified (site unreachable and not named in the posting).');
  }
  else if (timeLeft() < 60_000) skip('discussion', 'Skipped to finish within the time budget');
  else {
    const search = deps.search ?? ((c: string) => searchInterviewDiscussion(c, { tavilyApiKey: process.env.TAVILY_API_KEY }));
    discussion = await step('discussion', `Searching public discussion of ${company}'s interviews`, () => search(company)).catch(
      (err) => ({ items: [], searched: [], skipped: [{ url: 'search', reason: (err as Error).message }] }),
    );
    skipped.push(...discussion.skipped);
    emit('discussion', 'done', `${discussion.items.length} relevant result(s)`);
    if (discussion.items.length === 0) sourceNotes.push('NO_PUBLIC_DISCUSSION: no relevant public discussion of this company\'s interviews was found.');
  }

  // ---- 3. Hiring process (conditional) ----
  let hiring: HiringProcess = NO_HIRING_PROCESS;
  const hasHiringMaterial = pages.some((p) => p.kind === 'hiring-process' || (p.kind === 'careers' && p.hiringSignals.includes('interview')));
  if (!hasHiringMaterial && discussion.items.length === 0) skip('hiring', 'No hiring page or discussion to summarise');
  else {
    hiring = await step('hiring', 'Summarising the interview process', () =>
      summariseHiringProcess({ llm: deps.llm, company, pages, discussion: discussion.items }),
    ).catch(() => NO_HIRING_PROCESS);
    emit('hiring', 'done', hiring.found ? `Stages: ${hiring.stages.map((s) => s.name).join(' → ') || 'n/a'}; formats: ${hiring.formats.join(', ') || 'n/a'}` : 'No process described');
  }

  // ---- 4. Company brief ----
  let brief: CompanyBrief;
  if (pages.length === 0) {
    brief = notFoundBrief(company, input.company_url, urlProblem ?? crawl?.skipped[0]?.reason ?? 'the site could not be retrieved');
    skip('brief', 'Nothing retrieved: wrote an explicit "not found" brief');
  } else {
    brief = await step('brief', 'Writing the company brief', () =>
      writeCompanyBrief({ llm: deps.llm, company, companyUrl: input.company_url, pages, jd: input.jd }),
    ).catch(() => {
      const fallback = home?.description;
      return fallback
        ? { summary: fallback, what_they_do: fallback, sources: [home!.url], found: true }
        : notFoundBrief(company, input.company_url, 'brief generation failed');
    });
    emit('brief', 'done', brief.found ? 'Brief written from fetched pages' : 'Not enough information: honest brief');
  }

  // ---- 5. Questions, one call per category ----
  const ctx: QuestionContext = { roleTitle: extracted.title, seniority: extracted.seniority, brief, hiring };
  const requirements = extracted.requirements;
  const plans = planCategories(requirements, ctx);
  const ids = createIdAllocator('q', []);
  let questions: Question[] = [];
  const seenPrompts = new Set<string>();
  const addQuestions = (qs: Omit<Question, 'id'>[]) => {
    const added: Question[] = [];
    for (const q of qs) {
      const key = normaliseForMatch(q.prompt);
      if (seenPrompts.has(key)) continue;
      seenPrompts.add(key);
      const withId = { ...q, id: ids.next() } as Question;
      questions.push(withId);
      added.push(withId);
    }
    return added;
  };

  for (const plan of plans) {
    const name = `questions:${plan.category}`;
    try {
      const qs = await step(name, `Generating ${plan.count} ${plan.category} question(s): ${plan.reason}`, () =>
        generateCategoryQuestions({ llm: deps.llm, plan, ctx, avoidPrompts: questions.map((q) => q.prompt) }),
      );
      const added = addQuestions(qs);
      emit(name, 'done', `${added.length} question(s)`);
    } catch {
      sourceNotes.push(`Question generation for ${plan.category} failed; the coverage pass will try to fill the gap.`);
    }
  }

  // ---- 6. Coverage loop: code finds gaps, model fills them, code re-checks ----
  emit('coverage', 'running', 'Checking every requirement has a question');
  const loop = await runCoverageLoop({
    requirements,
    questions,
    maxPasses: timeLeft() < 45_000 ? 1 : (deps.maxCoveragePasses ?? 3),
    fillGaps: async (gaps, { pass, existing }) => {
      const byCat = new Map<QuestionCategory, Requirement[]>();
      for (const g of gaps) {
        const c = categoryForRequirement(g);
        byCat.set(c, [...(byCat.get(c) ?? []), g]);
      }
      const out: Omit<Question, 'id'>[] = [];
      for (const [category, reqs] of byCat) {
        emit('coverage', 'running', `Pass ${pass}: ${category} questions for ${reqs.map((r) => r.id).join(', ')}`);
        const qs = await generateCategoryQuestions({
          llm: deps.llm,
          plan: { category, requirements: reqs, count: reqs.length, reason: 'coverage gap' },
          ctx,
          gapMode: true,
          avoidPrompts: existing.map((q) => q.prompt),
        }).catch(() => []);
        out.push(...qs.filter((q) => !seenPrompts.has(normaliseForMatch(q.prompt))));
      }
      return out;
    },
    onPass: (pass, report) =>
      emit('coverage', 'running', `Check ${pass}: ${report.uncovered.length} uncovered (${report.uncoveredMust.length} must-have)`),
  });
  questions = loop.questions;
  steps.push({ step: 'coverage', status: 'done', detail: `${loop.passes} pass(es); uncovered: ${loop.report.uncovered.join(', ') || 'none'}` });
  emit('coverage', 'done', `${loop.passes} pass(es); ${loop.report.uncovered.length} requirement(s) uncovered`);

  // ---- 7. Flashcards ----
  const cardIds = createIdAllocator('f', []);
  let cards: Omit<Kit['flashcards'][number], 'id'>[];
  try {
    cards = await step('flashcards', 'Writing flashcards', () =>
      generateFlashcards({ llm: deps.llm, requirements, questions, roleTitle: extracted.title }),
    );
    if (cards.length === 0) throw new Error('no cards returned');
    emit('flashcards', 'done', `${cards.length} card(s)`);
  } catch {
    cards = cardsFromQuestions(questions, flashcardCount(requirements));
    sourceNotes.push('Flashcard generation failed; cards were derived from the question bank.');
  }
  const flashcards = cards.map((c) => ({ ...c, id: cardIds.next() }));

  // ---- 8. Schedule (code) ----
  emit('schedule', 'running', `Allocating ${questions.length} question(s) across ${input.days} day(s)`);
  const schedule = buildSchedule({ days: input.days, requirements, questions });
  steps.push({ step: 'schedule', status: 'done' });
  emit('schedule', 'done', `${schedule.days.length} day(s)`);

  // ---- 9. Assemble + validate ----
  const kit: Kit = {
    source: {
      company,
      company_url: input.company_url,
      role: extracted.title,
      location: extracted.location,
      jd_chars: input.jd.length,
      researched_at: now().toISOString(),
      pages_used: pages.map((p) => p.url),
      notes: [...extracted.notes, ...sourceNotes],
    },
    company_brief: {
      summary: brief.summary,
      what_they_do: brief.what_they_do,
      sources: brief.sources,
      state: { origin: 'generated', edited: false, pinned: false },
    },
    role: {
      title: extracted.title,
      seniority: extracted.seniority,
      responsibilities: extracted.responsibilities,
      requirements,
    },
    questions,
    flashcards,
    schedule,
    coverage: { uncovered_requirement_ids: loop.report.uncovered, passes: loop.passes, notes: loop.notes },
    research: {
      hiring_page_found: Boolean(crawl?.hiringPage),
      hiring_process: hiring,
      discussion: discussion.items.map((d) => ({ source: d.source, url: d.url, title: d.title })),
      skipped_sources: skipped,
      steps,
      thin_description: extracted.thin,
    },
  };

  const valid = validateKit(kit);
  if (!valid.ok) throw new PipelineError('KIT_INVALID', `Generated kit failed validation: ${valid.issues.slice(0, 5).join('; ')}`);
  emit('validate', 'done', 'Kit structure valid');
  return {
    kit: valid.kit,
    corpus: { jd: input.jd, pages: pages.map((p) => ({ ...p, text: p.text.slice(0, 8000) })), discussion: discussion.items },
  };
}
