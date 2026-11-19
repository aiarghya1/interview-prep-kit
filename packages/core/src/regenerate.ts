/**
 * Regenerating one section of an existing kit.
 *
 * These functions only *produce* fresh content from the kit's stored research
 * (no re-crawl). Merging it into the user's current kit is merge.ts's job, and
 * the caller must merge into the latest stored version, not the version it
 * read before the slow model call, so edits made meanwhile survive.
 */
import type { Kit, Question, QuestionCategory, Requirement } from './schema.js';
import type { Llm } from './llm/types.js';
import type { ResearchCorpus } from './pipeline.js';
import { writeCompanyBrief, NO_HIRING_PROCESS, type HiringProcess } from './steps/research.js';
import { generateCategoryQuestions, planCategories, type CategoryPlan, type QuestionContext } from './steps/questions.js';
import { generateFlashcards } from './steps/flashcards.js';
import { categoryForRequirement, computeCoverage } from './coverage.js';
import { buildSchedule } from './schedule.js';
import { createIdAllocator } from './ids.js';
import { isProtected, mergeSection, mergeSingle, pruneScheduleRefs } from './merge.js';
import type { IdHighWater } from './edit.js';

export type RegenSection = 'brief' | 'schedule' | 'flashcards' | `questions:${QuestionCategory}`;
export const REGEN_SECTIONS: RegenSection[] = [
  'brief',
  'schedule',
  'flashcards',
  'questions:technical',
  'questions:behavioural',
  'questions:system-design',
  'questions:company-fit',
];

function contextOf(kit: Kit): QuestionContext {
  const hp = kit.research?.hiring_process;
  const hiring: HiringProcess = hp
    ? { ...hp, formats: hp.formats as HiringProcess['formats'] }
    : NO_HIRING_PROCESS;
  return {
    roleTitle: kit.role.title,
    seniority: kit.role.seniority,
    brief: { ...kit.company_brief, found: kit.company_brief.sources.length > 0 },
    hiring,
  };
}

export async function regenerateBrief(kit: Kit, corpus: ResearchCorpus, llm: Llm) {
  const b = await writeCompanyBrief({
    llm,
    company: kit.source.company,
    companyUrl: kit.source.company_url,
    pages: corpus.pages,
    jd: corpus.jd,
  });
  return { summary: b.summary, what_they_do: b.what_they_do, sources: b.sources };
}

/**
 * Fresh questions for one category. Requirements that the *kept* questions
 * (user-written / edited / pinned, or other categories) leave uncovered are
 * listed first so regeneration can't silently drop coverage.
 */
export async function regenerateCategory(
  kit: Kit,
  category: QuestionCategory,
  kept: Question[],
  llm: Llm,
): Promise<Omit<Question, 'id'>[]> {
  const ctx = contextOf(kit);
  const planned = planCategories(kit.role.requirements, ctx).find((p) => p.category === category);
  const routed: Requirement[] = kit.role.requirements.filter((r) =>
    category === 'system-design' ? r.kind === 'technical' : categoryForRequirement(r) === category,
  );
  const plan: CategoryPlan = planned ?? {
    category,
    requirements: routed,
    count: 2,
    reason: 'requested by the user',
  };
  const report = computeCoverage(kit.role.requirements, kept);
  const needed = new Set(report.uncovered);
  plan.requirements = [...plan.requirements].sort((a, b) => Number(needed.has(b.id)) - Number(needed.has(a.id)));
  return generateCategoryQuestions({ llm, plan, ctx, avoidPrompts: kept.map((q) => q.prompt) });
}

export async function regenerateFlashcards(kit: Kit, llm: Llm) {
  return generateFlashcards({ llm, requirements: kit.role.requirements, questions: kit.questions, roleTitle: kit.role.title });
}

export function regenerateSchedule(kit: Kit) {
  return buildSchedule({ days: kit.schedule.days_available, requirements: kit.role.requirements, questions: kit.questions });
}

export type RegenPayload =
  | { section: 'brief'; brief: { summary: string; what_they_do: string; sources: string[] } }
  | { section: 'schedule'; schedule: Kit['schedule'] }
  | { section: 'flashcards'; flashcards: Omit<Kit['flashcards'][number], 'id'>[] }
  | { section: `questions:${QuestionCategory}`; questions: Omit<Question, 'id'>[] };

export interface MergeOutcome {
  kit: Kit;
  highWater: IdHighWater;
  kept: string[];
  removed: string[];
  added: string[];
  /** A brief the user edited/pinned was left untouched. */
  skippedProtected?: boolean;
}

/**
 * Merge regenerated content into `latest` (re-read after generation finished).
 * Only the named section changes; protected items survive (merge.ts).
 */
export function mergeRegenerated(latest: Kit, payload: RegenPayload, highWater: IdHighWater): MergeOutcome {
  if (payload.section === 'brief') {
    const protectedBrief = isProtected(latest.company_brief);
    return {
      kit: protectedBrief ? latest : { ...latest, company_brief: mergeSingle(latest.company_brief, payload.brief) },
      highWater,
      kept: protectedBrief ? ['brief'] : [],
      removed: [],
      added: protectedBrief ? [] : ['brief'],
      skippedProtected: protectedBrief,
    };
  }
  if (payload.section === 'schedule') {
    return { kit: { ...latest, schedule: payload.schedule }, highWater, kept: [], removed: [], added: [] };
  }
  if (payload.section === 'flashcards') {
    const ids = createIdAllocator('f', latest.flashcards.map((f) => f.id), highWater.f);
    const r = mergeSection(latest.flashcards, () => true, payload.flashcards, ids.next, (f) => f.front);
    return { kit: { ...latest, flashcards: r.items }, highWater: { ...highWater, f: ids.highWater }, kept: r.kept, removed: r.removed, added: r.added };
  }
  const category = payload.section.slice('questions:'.length) as QuestionCategory;
  const ids = createIdAllocator('q', latest.questions.map((q) => q.id), highWater.q);
  const r = mergeSection(latest.questions, (q) => q.category === category, payload.questions, ids.next, (q) => q.prompt);
  const live = new Set(r.items.map((q) => q.id));
  const report = computeCoverage(latest.role.requirements, r.items);
  return {
    kit: {
      ...latest,
      questions: r.items,
      schedule: { ...latest.schedule, days: pruneScheduleRefs(latest.schedule.days, live) },
      coverage: { ...latest.coverage, uncovered_requirement_ids: report.uncovered },
    },
    highWater: { ...highWater, q: ids.highWater },
    kept: r.kept,
    removed: r.removed,
    added: r.added,
  };
}
