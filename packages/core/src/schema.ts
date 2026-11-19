/**
 * Kit structure (brief, Appendix A) and batch I/O (Appendix B).
 *
 * The Appendix A field names are exact. Extensions are all optional, so a kit
 * written by this code is always a superset of the required shape:
 *   - `state` on editable items: origin / edited / pinned (see merge.ts)
 *   - `evidence` on requirements: the line of the posting it was taken from
 *   - `requirement_ids` on schedule days: which requirements a day touches
 *   - `notes` on source / coverage: honest reporting of what was missing
 */
import { z } from 'zod';

// ---------- shared ----------

export const ItemStateSchema = z.object({
  /** Who created the item. `template` = code-written fallback question. */
  origin: z.enum(['generated', 'user', 'template']),
  /** The user changed a generated item; regeneration must not replace it. */
  edited: z.boolean(),
  /** The user explicitly asked to keep it through regeneration. */
  pinned: z.boolean(),
});
export type ItemState = z.infer<typeof ItemStateSchema>;

const Url = z.string().min(1);
const IntMinutes = z.number().int().nonnegative();

// ---------- Appendix A ----------

export const RequirementKind = z.enum(['technical', 'behavioural', 'domain']);
export const RequirementPriority = z.enum(['must', 'nice']);
export const QuestionCategory = z.enum(['technical', 'behavioural', 'system-design', 'company-fit']);
export type QuestionCategory = z.infer<typeof QuestionCategory>;

export const RequirementSchema = z.object({
  id: z.string().regex(/^r\d+$/),
  text: z.string().min(1),
  kind: RequirementKind,
  priority: RequirementPriority,
  evidence: z.string().optional(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const QuestionSchema = z.object({
  id: z.string().regex(/^q\d+$/),
  requirement_ids: z.array(z.string()),
  category: QuestionCategory,
  prompt: z.string().min(1),
  answer_outline: z.string(),
  difficulty: z.number().int().min(1).max(3),
  state: ItemStateSchema.optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const FlashcardSchema = z.object({
  id: z.string().regex(/^f\d+$/),
  front: z.string().min(1),
  back: z.string(),
  requirement_ids: z.array(z.string()),
  state: ItemStateSchema.optional(),
});
export type Flashcard = z.infer<typeof FlashcardSchema>;

export const ScheduleDaySchema = z.object({
  day: z.number().int().positive(),
  focus: z.string().min(1),
  question_ids: z.array(z.string()),
  minutes: IntMinutes,
  requirement_ids: z.array(z.string()).optional(),
});
export type ScheduleDay = z.infer<typeof ScheduleDaySchema>;

export const ScheduleSchema = z.object({
  days_available: z.number().int().positive(),
  days: z.array(ScheduleDaySchema),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

/** Extension: what research found and skipped, for honest reporting in the UI. */
export const ResearchSchema = z.object({
  hiring_page_found: z.boolean(),
  hiring_process: z.object({
    found: z.boolean(),
    source_type: z.enum(['official', 'discussion', 'none']),
    stages: z.array(z.object({ name: z.string(), description: z.string() })),
    formats: z.array(z.string()),
    tips: z.array(z.string()),
    sources: z.array(z.string()),
  }),
  discussion: z.array(z.object({ source: z.string(), url: z.string(), title: z.string() })),
  skipped_sources: z.array(z.object({ url: z.string(), reason: z.string(), code: z.string().optional() })),
  steps: z.array(
    z.object({ step: z.string(), status: z.enum(['done', 'skipped', 'failed']), detail: z.string().optional(), ms: z.number().int().optional() }),
  ),
  thin_description: z.boolean(),
});
export type Research = z.infer<typeof ResearchSchema>;

export const KitShape = z.object({
    source: z.object({
      company: z.string(),
      company_url: z.string(),
      role: z.string(),
      location: z.string(),
      jd_chars: z.number().int().nonnegative(),
      researched_at: z.string(),
      pages_used: z.array(Url),
      notes: z.array(z.string()).optional(),
    }),
    company_brief: z.object({
      summary: z.string(),
      what_they_do: z.string(),
      sources: z.array(Url),
      state: ItemStateSchema.optional(),
    }),
    role: z.object({
      title: z.string(),
      seniority: z.string(),
      responsibilities: z.array(z.string()),
      requirements: z.array(RequirementSchema),
    }),
    questions: z.array(QuestionSchema),
    flashcards: z.array(FlashcardSchema),
    schedule: ScheduleSchema,
    coverage: z.object({
      uncovered_requirement_ids: z.array(z.string()),
      passes: z.number().int().nonnegative(),
      notes: z.array(z.string()).optional(),
    }),
    research: ResearchSchema.optional(),
});
export type Kit = z.infer<typeof KitShape>;
export const KitSchema = KitShape.superRefine((kit, ctx) => checkReferentialIntegrity(kit, ctx));

/**
 * Cross-field rules zod can't express per-field: unique ids, references that
 * resolve, and the schedule spanning exactly the days requested.
 */
function checkReferentialIntegrity(kit: Kit, ctx: z.RefinementCtx) {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  const dupes = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);
  const reqIds = new Set(kit.role.requirements.map((r) => r.id));
  const qIds = new Set(kit.questions.map((q) => q.id));

  for (const [path, ids] of [
    [['role', 'requirements'], kit.role.requirements.map((r) => r.id)],
    [['questions'], kit.questions.map((q) => q.id)],
    [['flashcards'], kit.flashcards.map((f) => f.id)],
  ] as const) {
    const d = dupes([...ids]);
    if (d.length) issue([...path], `duplicate ids: ${[...new Set(d)].join(', ')}`);
  }

  kit.questions.forEach((q, i) =>
    q.requirement_ids.forEach((rid) => {
      if (!reqIds.has(rid)) issue(['questions', i, 'requirement_ids'], `unknown requirement ${rid}`);
    }),
  );
  kit.flashcards.forEach((f, i) =>
    f.requirement_ids.forEach((rid) => {
      if (!reqIds.has(rid)) issue(['flashcards', i, 'requirement_ids'], `unknown requirement ${rid}`);
    }),
  );

  const { schedule } = kit;
  if (schedule.days.length !== schedule.days_available) {
    issue(['schedule', 'days'], `has ${schedule.days.length} days, expected ${schedule.days_available}`);
  }
  schedule.days.forEach((d, i) => {
    if (d.day !== i + 1) issue(['schedule', 'days', i, 'day'], `expected day ${i + 1}, got ${d.day}`);
    d.question_ids.forEach((qid) => {
      if (!qIds.has(qid)) issue(['schedule', 'days', i, 'question_ids'], `unknown question ${qid}`);
    });
  });

  kit.coverage.uncovered_requirement_ids.forEach((rid) => {
    if (!reqIds.has(rid)) issue(['coverage', 'uncovered_requirement_ids'], `unknown requirement ${rid}`);
  });
}

// ---------- Appendix B ----------

export const BatchCaseSchema = z.object({
  id: z.string().min(1),
  jd: z.string(),
  company_url: z.string(),
  days: z.number().int().positive(),
});
export type BatchCase = z.infer<typeof BatchCaseSchema>;
export const BatchInputSchema = z.array(BatchCaseSchema);

export const BatchErrorSchema = z.object({ code: z.string(), message: z.string() });

export const BatchResultSchema = z.discriminatedUnion('status', [
  z.object({ id: z.string(), status: z.literal('ok'), kit: KitSchema, error: z.null() }),
  z.object({ id: z.string(), status: z.literal('failed'), kit: z.null(), error: BatchErrorSchema }),
]);
export type BatchResult = z.infer<typeof BatchResultSchema>;

export const BatchOutputSchema = z.object({
  version: z.literal('1.0'),
  generated_at: z.string(),
  kits: z.array(BatchResultSchema),
});
export type BatchOutput = z.infer<typeof BatchOutputSchema>;

/** Validate a kit; returns readable issue strings instead of throwing. */
export function validateKit(kit: unknown): { ok: true; kit: Kit } | { ok: false; issues: string[] } {
  const r = KitSchema.safeParse(kit);
  if (r.success) return { ok: true, kit: r.data };
  return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
