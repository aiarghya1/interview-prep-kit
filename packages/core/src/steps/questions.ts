/**
 * Step: question generation, one call per category, each with its own brief.
 *
 * Code decides which categories run, for which requirements, and how many
 * questions (planCategories). A requirement's kind routes it: technical and
 * domain skills go to technical prompts, behavioural ones to STAR prompts,
 * so "5 years of React" and "mentoring juniors" never share a call. What
 * retrieval found about the hiring process changes the instructions: a
 * published take-home, system-design round or pairing session each add
 * specific guidance.
 */
import { z } from 'zod';
import type { Question, QuestionCategory, Requirement } from '../schema.js';
import type { Llm } from '../llm/types.js';
import { untrusted, UNTRUSTED_RULES } from '../llm/untrusted.js';
import type { CompanyBrief, HiringProcess } from './research.js';

export interface CategoryPlan {
  category: QuestionCategory;
  requirements: Requirement[];
  count: number;
  reason: string;
}

export interface QuestionContext {
  roleTitle: string;
  seniority: string;
  brief: CompanyBrief;
  hiring: HiringProcess;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const SENIOR = /\b(mid|senior|sr\.?|staff|lead|principal|architect|manager|head)\b/i;

export function planCategories(requirements: Requirement[], ctx: QuestionContext): CategoryPlan[] {
  const technical = requirements.filter((r) => r.kind === 'technical');
  const behavioural = requirements.filter((r) => r.kind === 'behavioural');
  const domain = requirements.filter((r) => r.kind === 'domain');
  const plans: CategoryPlan[] = [];

  if (technical.length) {
    plans.push({ category: 'technical', requirements: technical, count: clamp(Math.ceil(technical.length * 1.3), 2, 9), reason: `${technical.length} technical requirement(s)` });
  }
  plans.push({
    category: 'behavioural',
    requirements: behavioural,
    count: clamp(behavioural.length + 1, 2, 5),
    reason: behavioural.length ? `${behavioural.length} behavioural requirement(s)` : 'every interview has behavioural questions; none were stated, so these stay general',
  });

  const publishedSD = ctx.hiring.formats.includes('system_design');
  const seniorRole = SENIOR.test(`${ctx.seniority} ${ctx.roleTitle}`);
  if (technical.length && (publishedSD || seniorRole)) {
    plans.push({
      category: 'system-design',
      requirements: technical,
      count: publishedSD ? 3 : 2,
      reason: publishedSD ? 'the hiring process includes a system-design round' : `role seniority (${ctx.seniority || ctx.roleTitle})`,
    });
  }

  plans.push({
    category: 'company-fit',
    requirements: domain,
    count: clamp(2 + domain.length, 2, 5),
    reason: ctx.brief.found ? 'company brief available' : 'motivation and role-fit only: nothing reliable is known about the company',
  });
  return plans;
}

const QuestionsOut = z.object({
  questions: z
    .array(
      z.object({
        prompt: z.string().min(5),
        answer_outline: z.string().catch(''),
        difficulty: z.coerce.number().catch(2),
        requirement_ids: z.array(z.string()).catch([]),
      }),
    )
    .catch([]),
});

const CATEGORY_BRIEF: Record<QuestionCategory, string> = {
  technical: `Write TECHNICAL interview questions that test real depth in the listed requirements: concepts, practical trade-offs, debugging and "how would you" scenarios at the stated seniority. Avoid trivia and yes/no questions.
answer_outline: the 3-6 key points a strong answer covers, as a compact list in one string.`,
  behavioural: `Write BEHAVIOURAL interview questions ("Tell me about a time...") that let the candidate show the listed qualities with a real story.
answer_outline: how to structure the answer with STAR (situation, task, action, result) and what the interviewer is listening for.`,
  'system-design': `Write SYSTEM DESIGN interview prompts sized for a 45-minute discussion, at the stated seniority, using the listed technologies where natural. If the company brief says what the company builds, set the prompts in that domain; otherwise use a neutral domain.
answer_outline: requirements clarification, core components, data model, scaling and failure modes, key trade-offs.`,
  'company-fit': `Write COMPANY-FIT questions: motivation for this company and role, how the candidate's experience maps to what the company does, and the listed domain requirements. Use only facts in the company brief. If the brief says nothing is known, ask about motivation and role fit without stating facts about the company.
answer_outline: what a well-researched, specific answer includes.`,
};

function processGuidance(category: QuestionCategory, hiring: HiringProcess): string {
  if (!hiring.found) return 'No information about this company\'s interview process was found; do not assume a particular format.';
  const f = new Set(hiring.formats);
  const lines: string[] = [`Published interview stages (${hiring.source_type}): ${hiring.stages.map((s) => s.name).join(' -> ') || 'not itemised'}.`];
  if (category === 'technical') {
    if (f.has('take_home')) lines.push('The process includes a take-home exercise: include one question asking the candidate to walk through and defend design decisions in a take-home solution, and one about extending it.');
    if (f.has('live_coding')) lines.push('The process includes live coding / pairing: include at least one practical, talk-through-your-code question rather than only conceptual ones.');
  }
  if (category === 'system-design' && f.has('system_design')) lines.push('A dedicated system-design round is confirmed: make one prompt a full end-to-end design.');
  if (category === 'behavioural' && f.has('behavioural')) lines.push('A behavioural/values interview is confirmed: tie questions to the company\'s stated values where the material gives them.');
  if (hiring.tips.length) lines.push(`Candidate advice the company or candidates give: ${hiring.tips.join(' | ')}`);
  return lines.join('\n');
}

export interface GenerateArgs {
  llm: Llm;
  plan: CategoryPlan;
  ctx: QuestionContext;
  /** Gap-filling mode: one question per listed requirement, each targeting it. */
  gapMode?: boolean;
  avoidPrompts?: string[];
}

export async function generateCategoryQuestions(args: GenerateArgs): Promise<Omit<Question, 'id'>[]> {
  const { llm, plan, ctx, gapMode } = args;
  const reqList = plan.requirements.length
    ? plan.requirements.map((r) => `- ${r.id} [${r.priority}] ${r.text}`).join('\n')
    : '(none stated: write general questions for this category and use an empty requirement_ids list)';
  const system = `You write interview preparation questions. Output JSON only.

${UNTRUSTED_RULES}

${CATEGORY_BRIEF[plan.category]}

Rules:
- requirement_ids: the ids (from the list given) that the question genuinely tests. Use only ids from the list.
- difficulty: 1 (warm-up), 2 (solid), 3 (hard / senior-level).
- Must-have [must] requirements matter most; every one of them should be tested by at least one question.
- No duplicate or near-duplicate questions.
${gapMode ? '- GAP MODE: write exactly one question per listed requirement; each question\'s requirement_ids must include that requirement\'s id.' : ''}

Return: {"questions": [{"prompt": "", "answer_outline": "", "difficulty": 2, "requirement_ids": ["r1"]}]}`;

  const user = [
    `Role: ${ctx.roleTitle || 'unspecified'}${ctx.seniority ? ` (${ctx.seniority})` : ''}`,
    `Write ${plan.count} ${plan.category} question(s).`,
    `Requirements:\n${reqList}`,
    `Interview process context:\n${processGuidance(plan.category, ctx.hiring)}`,
    plan.category === 'company-fit' || plan.category === 'system-design'
      ? `Company brief:\n${untrusted('company-brief', `${ctx.brief.summary}\n${ctx.brief.what_they_do}`, 1500)}`
      : '',
    args.avoidPrompts?.length ? `Already asked (do not repeat):\n${args.avoidPrompts.slice(0, 25).map((p) => `- ${p.slice(0, 140)}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const out = await llm.json({
    task: `questions_${plan.category}${gapMode ? '_gap' : ''}`,
    system,
    user,
    schema: QuestionsOut,
    maxTokens: Math.min(3000, 250 + plan.count * 260),
    temperature: 0.4,
  });

  const allowed = new Set(plan.requirements.map((r) => r.id));
  return out.questions.slice(0, plan.count + 2).map((q) => ({
    category: plan.category,
    prompt: q.prompt.trim().slice(0, 1000),
    answer_outline: q.answer_outline.trim().slice(0, 2000),
    difficulty: clamp(Math.round(Number.isFinite(q.difficulty) ? q.difficulty : 2), 1, 3),
    requirement_ids: [...new Set(q.requirement_ids)].filter((id) => allowed.has(id)),
    state: { origin: 'generated' as const, edited: false, pinned: false },
  }));
}
