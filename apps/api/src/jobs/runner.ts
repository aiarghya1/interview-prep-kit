/**
 * Background jobs: kit generation and section regeneration.
 *
 * - In-process queue, concurrency 1 by default: every job draws on the same
 *   rate-limited LLM budget, so running two at once just makes both slower.
 * - The queue is rebuilt from MongoDB on start: kits left `running` by a
 *   crash/redeploy go back to `queued`, interrupted regenerations are marked
 *   failed. Nothing is lost because the state lives in the document.
 * - Progress events are appended to the kit document (capped), so the
 *   interface can poll them and a reload shows where generation is.
 */
import {
  computeCoverage,
  categoryForRequirement,
  generateCategoryQuestions,
  isProtected,
  mergeRegenerated,
  regenerateBrief,
  regenerateCategory,
  regenerateFlashcards,
  runPipeline,
  type Fetcher,
  type Kit,
  type Llm,
  type LlmEvent,
  type ProgressEvent,
  type QuestionCategory,
  type RegenPayload,
  type RegenSection,
  type ResearchCorpus,
  type DiscussionResult,
} from '@kit/core';
import { KitModel } from '../db/models.js';
import { loadKit, maxIdNum, updateKitWithRetry, type StoredKit } from '../kits/store.js';

export type Job = { kind: 'generate'; kitId: string } | { kind: 'regenerate'; kitId: string; section: RegenSection };

export interface JobDeps {
  createLlm: (onEvent: (e: LlmEvent) => void) => Llm;
  fetcher: Fetcher;
  search?: (company: string) => Promise<DiscussionResult>;
  timeoutMs: number;
  concurrency?: number;
}

export class JobRunner {
  private queue: Job[] = [];
  private active = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly deps: JobDeps) {}

  enqueue(job: Job) {
    this.queue.push(job);
    this.pump();
  }

  /** Resolves when nothing is queued or running (tests, graceful shutdown). */
  idle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  async recover() {
    await KitModel.updateMany({ status: 'running' }, { $set: { status: 'queued' }, $push: { progress: progressEntry('restart', 'running', 'Server restarted; generation will start again') } });
    await KitModel.updateMany({ 'regen.status': 'running' }, { $set: { 'regen.status': 'failed', 'regen.message': 'Interrupted by a server restart. Try again.' } });
    const queued = await KitModel.find({ status: 'queued' }).sort({ createdAt: 1 }).select('_id').lean();
    queued.forEach((d) => this.enqueue({ kind: 'generate', kitId: String(d._id) }));
  }

  private pump() {
    while (this.active < (this.deps.concurrency ?? 1) && this.queue.length) {
      const job = this.queue.shift()!;
      this.active += 1;
      this.run(job)
        .catch((err) => console.error(`job ${job.kind} ${job.kitId} crashed`, err))
        .finally(() => {
          this.active -= 1;
          this.pump();
          if (this.active === 0 && this.queue.length === 0) this.idleWaiters.splice(0).forEach((r) => r());
        });
    }
  }

  private run(job: Job) {
    return job.kind === 'generate' ? this.generate(job.kitId) : this.regenerate(job.kitId, job.section);
  }

  private progressWriter(kitId: string) {
    let chain = Promise.resolve();
    return (e: Omit<ProgressEvent, 'at'> & { at?: string }) => {
      const entry = progressEntry(e.step, e.status, e.message, e.at);
      chain = chain
        .then(() => KitModel.updateOne({ _id: kitId }, { $push: { progress: { $each: [entry], $slice: -150 } } }).then(() => undefined))
        .catch(() => undefined);
      return chain;
    };
  }

  private llmFor(write: ReturnType<JobRunner['progressWriter']>) {
    return this.deps.createLlm((e) => {
      if (e.type === 'rate_limited' || e.type === 'retry' || e.type === 'model_fallback' || e.type === 'repair') {
        const wait = e.waitMs ? ` (waiting ${Math.ceil(e.waitMs / 1000)}s)` : '';
        void write({ step: 'llm', status: 'running', message: `${e.message}${wait}` });
      }
    });
  }

  private async generate(kitId: string) {
    const claimed = await KitModel.findOneAndUpdate(
      { _id: kitId, status: 'queued' },
      { $set: { status: 'running', startedAt: new Date(), progress: [], error: null } },
      { new: true },
    ).lean<StoredKit>();
    if (!claimed) return; // deleted or already handled
    const write = this.progressWriter(kitId);
    try {
      const { kit, corpus } = await runPipeline(claimed.input, {
        llm: this.llmFor(write),
        fetcher: this.deps.fetcher,
        search: this.deps.search,
        deadline: Date.now() + this.deps.timeoutMs,
        onProgress: (e) => void write(e),
      });
      await write({ step: 'done', status: 'done', message: 'Kit ready' });
      await KitModel.updateOne(
        { _id: kitId, status: 'running' },
        {
          $set: {
            status: 'ready',
            kit,
            corpus,
            version: 1,
            highWater: { q: maxIdNum(kit.questions.map((q) => q.id)), f: maxIdNum(kit.flashcards.map((f) => f.id)) },
            title: kit.role.title || 'Untitled role',
            company: kit.source.company,
            finishedAt: new Date(),
          },
        },
      );
    } catch (err) {
      const e = err as Error & { code?: string };
      await write({ step: 'failed', status: 'failed', message: e.message });
      await KitModel.updateOne({ _id: kitId }, { $set: { status: 'failed', error: { code: e.code ?? 'INTERNAL', message: e.message }, finishedAt: new Date() } });
    }
  }

  private async regenerate(kitId: string, section: RegenSection) {
    const write = this.progressWriter(kitId);
    try {
      const doc = await KitModel.findById(kitId).select('+corpus').lean<StoredKit & { corpus?: ResearchCorpus }>();
      if (!doc?.kit) return;
      const llm = this.llmFor(write);
      const payload = await this.produce(doc.kit, doc.corpus, section, llm);
      // Merge into the *latest* kit, not `doc`: edits made while the model ran survive.
      let summary = '';
      await updateKitWithRetry(kitId, undefined, (latest) => {
        const out = mergeRegenerated(latest.kit, payload, latest.highWater);
        summary = out.skippedProtected
          ? 'Brief left unchanged: you edited or pinned it. Unpin it to allow regeneration.'
          : `Replaced ${out.removed.length}, kept ${out.kept.length} edited/pinned/hand-written, added ${out.added.length}`;
        return {
          kit: out.kit,
          highWater: out.highWater,
          set: {
            regen: { section, status: 'done', startedAt: doc.regen?.startedAt, finishedAt: new Date(), message: summary },
            ...(section.startsWith('questions:') ? { scheduleStale: true } : {}),
          },
        };
      });
    } catch (err) {
      await KitModel.updateOne({ _id: kitId }, { $set: { 'regen.status': 'failed', 'regen.finishedAt': new Date(), 'regen.message': (err as Error).message } });
    }
  }

  /** Produce fresh content for a section (slow, model-bound). */
  private async produce(kit: Kit, corpus: ResearchCorpus | undefined, section: RegenSection, llm: Llm): Promise<RegenPayload> {
    if (section === 'brief') {
      return { section, brief: await regenerateBrief(kit, corpus ?? { jd: '', pages: [], discussion: [] }, llm) };
    }
    if (section === 'flashcards') return { section, flashcards: await regenerateFlashcards(kit, llm) };
    if (section === 'schedule') throw new Error('schedule is regenerated synchronously');
    const category = section.slice('questions:'.length) as QuestionCategory;
    const kept = kit.questions.filter((q) => q.category !== category || isProtected(q));
    const fresh = await regenerateCategory(kit, category, kept, llm);
    // Code-side coverage check on the would-be result: fill must-have gaps
    // this category is responsible for before merging.
    const report = computeCoverage(kit.role.requirements, [...kept, ...fresh.map((q, i) => ({ ...q, id: `tmp${i}` }))]);
    const gaps = kit.role.requirements.filter((r) => report.uncoveredMust.includes(r.id) && categoryForRequirement(r) === category);
    if (gaps.length) {
      const extra = await generateCategoryQuestions({
        llm,
        plan: { category, requirements: gaps, count: gaps.length, reason: 'coverage gap after regeneration' },
        ctx: {
          roleTitle: kit.role.title,
          seniority: kit.role.seniority,
          brief: { ...kit.company_brief, found: kit.company_brief.sources.length > 0 },
          hiring: (kit.research?.hiring_process as never) ?? { found: false, source_type: 'none', stages: [], formats: [], tips: [], sources: [] },
        },
        gapMode: true,
      }).catch(() => []);
      fresh.push(...extra);
    }
    return { section, questions: fresh };
  }
}

function progressEntry(step: string, status: string, message: string, at?: string) {
  return { step, status, message: message.slice(0, 500), at: at ?? new Date().toISOString() };
}

export { loadKit };
