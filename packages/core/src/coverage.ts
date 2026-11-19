/**
 * Coverage checking and the gap-filling loop.
 *
 * Deciding what is covered is code, not a model call: a requirement is covered
 * iff at least one question lists its id in `requirement_ids`. The model only
 * ever gets asked to *write* questions for gaps this module has identified.
 */
import type { Question, QuestionCategory, Requirement } from './schema.js';
import { createIdAllocator } from './ids.js';

export interface CoverageReport {
  covered: string[];
  uncovered: string[];
  uncoveredMust: string[];
  /** requirement id -> number of questions covering it */
  counts: Record<string, number>;
}

export function computeCoverage(requirements: Requirement[], questions: Question[]): CoverageReport {
  const counts: Record<string, number> = Object.fromEntries(requirements.map((r) => [r.id, 0]));
  for (const q of questions) {
    for (const rid of new Set(q.requirement_ids)) {
      if (rid in counts) counts[rid]! += 1;
    }
  }
  const uncovered = requirements.filter((r) => counts[r.id] === 0);
  return {
    covered: requirements.filter((r) => counts[r.id]! > 0).map((r) => r.id),
    uncovered: uncovered.map((r) => r.id),
    uncoveredMust: uncovered.filter((r) => r.priority === 'must').map((r) => r.id),
    counts,
  };
}

/** Remove references to requirements that don't exist (model hallucinated ids). */
export function dropDanglingRequirementRefs<T extends { requirement_ids: string[] }>(
  items: T[],
  requirements: Requirement[],
): T[] {
  const known = new Set(requirements.map((r) => r.id));
  return items.map((it) => ({ ...it, requirement_ids: [...new Set(it.requirement_ids)].filter((id) => known.has(id)) }));
}

/** The category a gap question should be asked in, decided by requirement kind. */
export function categoryForRequirement(r: Requirement): QuestionCategory {
  switch (r.kind) {
    case 'behavioural':
      return 'behavioural';
    case 'domain':
      return 'company-fit';
    default:
      return 'technical';
  }
}

/**
 * Last-resort question written by code, used only if the model failed to cover
 * a must-have after every pass. Marked origin=template so the UI and README can
 * be honest that it is generic.
 */
export function templateQuestion(r: Requirement): Omit<Question, 'id'> {
  const behavioural = r.kind === 'behavioural';
  return {
    requirement_ids: [r.id],
    category: categoryForRequirement(r),
    prompt: behavioural
      ? `Tell me about a time you demonstrated this: "${r.text}". What was the situation, what did you do, and what was the outcome?`
      : `The role asks for: "${r.text}". Walk me through a concrete piece of work where you applied this, and the trade-offs you made.`,
    answer_outline: behavioural
      ? 'Use STAR: situation, task, the specific actions you took, a measurable result, and what you would do differently.'
      : 'Name a specific project; explain the problem, your approach, alternatives you rejected and why, and the result. Be ready for follow-up depth questions.',
    difficulty: 2,
    state: { origin: 'template', edited: false, pinned: false },
  };
}

export type GapFiller = (
  gaps: Requirement[],
  context: { pass: number; existing: Question[] },
) => Promise<Omit<Question, 'id'>[]>;

export interface CoverageLoopOptions {
  requirements: Requirement[];
  /** First-draft questions (pass 1 already happened). */
  questions: Question[];
  fillGaps: GapFiller;
  /** Total generation passes including the first draft. */
  maxPasses?: number;
  /** Cover still-uncovered must-haves with code-written questions at the end. */
  templateFallback?: boolean;
  /** Called after every check, for progress reporting. */
  onPass?: (pass: number, report: CoverageReport) => void;
}

export interface CoverageLoopResult {
  questions: Question[];
  passes: number;
  report: CoverageReport;
  notes: string[];
}

/**
 * check -> fill gaps -> check again, until:
 *   - nothing is uncovered, or
 *   - maxPasses generation passes have run, or
 *   - a pass made no progress (the model can't/won't cover what's left, so
 *     asking again just burns rate-limited tokens).
 * Gaps include nice-to-haves; the stop condition and the fallback only insist
 * on must-haves.
 */
export async function runCoverageLoop(opts: CoverageLoopOptions): Promise<CoverageLoopResult> {
  const { requirements, fillGaps, maxPasses = 3, templateFallback = true, onPass } = opts;
  const notes: string[] = [];
  let questions = dropDanglingRequirementRefs(opts.questions, requirements);
  const ids = createIdAllocator('q', questions.map((q) => q.id));

  let passes = 1;
  let report = computeCoverage(requirements, questions);
  onPass?.(passes, report);

  while (report.uncovered.length > 0 && passes < maxPasses) {
    const gaps = requirements.filter((r) => report.uncovered.includes(r.id));
    passes += 1;
    let generated: Omit<Question, 'id'>[] = [];
    try {
      generated = await fillGaps(gaps, { pass: passes, existing: questions });
    } catch (err) {
      notes.push(`Gap-fill pass ${passes} failed: ${(err as Error).message}`);
    }
    // Only keep questions that actually target a gap; ignore off-target output.
    const gapIds = new Set(report.uncovered);
    const useful = dropDanglingRequirementRefs(generated, requirements).filter((q) =>
      q.requirement_ids.some((rid) => gapIds.has(rid)),
    );
    questions = [...questions, ...useful.map((q) => ({ ...q, id: ids.next() }))];

    const before = report.uncovered.length;
    report = computeCoverage(requirements, questions);
    onPass?.(passes, report);
    if (report.uncovered.length === before) {
      notes.push(`Pass ${passes} closed no gaps; stopping early.`);
      break;
    }
  }

  if (templateFallback && report.uncoveredMust.length > 0) {
    const missing = requirements.filter((r) => report.uncoveredMust.includes(r.id));
    questions = [...questions, ...missing.map((r) => ({ ...templateQuestion(r), id: ids.next() }))];
    notes.push(`Template questions added for must-haves the model did not cover: ${missing.map((r) => r.id).join(', ')}.`);
    report = computeCoverage(requirements, questions);
  }

  return { questions, passes, report, notes };
}
