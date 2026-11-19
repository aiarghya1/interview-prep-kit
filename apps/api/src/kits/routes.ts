import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  applyEditOps,
  CardProgressSchema,
  Confidence,
  EditOpsSchema,
  orderSession,
  recordReview,
  REGEN_SECTIONS,
  regenerateSchedule,
  summarisePractice,
  type CardProgress,
  type RegenSection,
} from '@kit/core';
import type { Config } from '../config.js';
import { KitModel } from '../db/models.js';
import { ApiError, asyncHandler } from '../errors.js';
import type { JobRunner } from '../jobs/runner.js';
import { createKit, KitInputSchema } from './service.js';
import { loadKit, ownerFilter, toSummary, toView, updateKitWithRetry, type StoredKit } from './store.js';

const CreateBody = KitInputSchema.extend({ force: z.boolean().optional() });
const BatchBody = z.object({ items: z.array(z.unknown()).min(1).max(10) });
const RegenBody = z.object({ section: z.enum(REGEN_SECTIONS as [RegenSection, ...RegenSection[]]) });
const ReviewBody = z.object({ cardId: z.string().regex(/^f\d+$/), confidence: Confidence });

function practiceView(doc: StoredKit) {
  const kit = doc.kit;
  if (!kit) throw new ApiError(409, 'KIT_NOT_READY', 'This kit is still being generated');
  const progress: Record<string, CardProgress> = {};
  for (const [id, p] of Object.entries(doc.practice ?? {})) {
    const parsed = CardProgressSchema.safeParse(p);
    if (parsed.success) progress[id] = parsed.data;
  }
  const now = new Date();
  return { progress, order: orderSession(kit.flashcards, progress, kit.role.requirements, now), summary: summarisePractice(kit.flashcards, progress, now) };
}

export function kitsRouter(config: Config, runner: JobRunner) {
  const r = Router();
  const createLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: config.NODE_ENV === 'test' ? 1000 : 30,
    keyGenerator: (req) => req.userId ?? req.ip ?? 'anon',
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'You have created a lot of kits this hour. Try again later.' } }),
  });

  r.get(
    '/',
    asyncHandler(async (req, res) => {
      const docs = await KitModel.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(100).lean<StoredKit[]>();
      res.json({ kits: docs.map(toSummary) });
    }),
  );

  r.post(
    '/',
    createLimiter,
    asyncHandler(async (req, res) => {
      const { force, ...input } = CreateBody.parse(req.body);
      const out = await createKit(req.userId!, input, runner, { force, maxActive: config.MAX_ACTIVE_JOBS_PER_USER });
      res.status(out.status).json({ kit: out.kit, deduplicated: out.deduplicated });
    }),
  );

  r.post(
    '/batch',
    createLimiter,
    asyncHandler(async (req, res) => {
      const { items } = BatchBody.parse(req.body);
      const results: { index: number; kit?: unknown; deduplicated?: unknown; error?: { code: string; message: string } }[] = [];
      for (const [index, item] of items.entries()) {
        const parsed = KitInputSchema.safeParse(item);
        if (!parsed.success) {
          results.push({ index, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
          continue;
        }
        try {
          const out = await createKit(req.userId!, parsed.data, runner, { maxActive: config.MAX_ACTIVE_JOBS_PER_USER + items.length });
          results.push({ index, kit: out.kit, deduplicated: out.deduplicated });
        } catch (err) {
          const e = err as ApiError;
          results.push({ index, error: { code: e.code ?? 'INTERNAL', message: e.message } });
        }
      }
      res.status(202).json({ results });
    }),
  );

  r.get(
    '/:id',
    asyncHandler(async (req, res) => {
      res.json(toView(await loadKit(req.params.id!, req.userId)));
    }),
  );

  /** Lightweight polling endpoint for generation / regeneration progress. */
  r.get(
    '/:id/status',
    asyncHandler(async (req, res) => {
      const doc = await KitModel.findOne(ownerFilter(req.params.id!, req.userId)).select('status progress error regen version scheduleStale').lean<StoredKit>();
      if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Kit not found');
      res.json({ status: doc.status, progress: doc.progress ?? [], error: doc.error?.code ? doc.error : null, regen: doc.regen?.section ? doc.regen : null, version: doc.version, scheduleStale: Boolean(doc.scheduleStale) });
    }),
  );

  r.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const ops = EditOpsSchema.parse(req.body?.ops);
      let created: Record<string, string> = {};
      const doc = await updateKitWithRetry(req.params.id!, req.userId, (latest) => {
        const out = applyEditOps(latest.kit, ops, latest.highWater);
        created = out.created;
        return { kit: out.kit, highWater: out.highWater, set: out.questionsChanged ? { scheduleStale: true } : undefined };
      });
      res.json({ kit: doc.kit, version: doc.version, created, scheduleStale: Boolean(doc.scheduleStale) });
    }),
  );

  r.post(
    '/:id/regenerate',
    asyncHandler(async (req, res) => {
      const { section } = RegenBody.parse(req.body);
      if (section === 'schedule') {
        const doc = await updateKitWithRetry(req.params.id!, req.userId, (latest) => ({
          kit: { ...latest.kit, schedule: regenerateSchedule(latest.kit) },
          set: { scheduleStale: false, regen: { section, status: 'done', startedAt: new Date(), finishedAt: new Date(), message: 'Schedule rebuilt from the current questions' } },
        }));
        res.json(toView(doc));
        return;
      }
      // Claim the regeneration slot atomically: one regeneration per kit at a time.
      const claimed = await KitModel.findOneAndUpdate(
        { ...ownerFilter(req.params.id!, req.userId), status: 'ready', 'regen.status': { $ne: 'running' } },
        { $set: { regen: { section, status: 'running', startedAt: new Date(), message: `Regenerating ${section}` } } },
        { new: true },
      ).lean<StoredKit>();
      if (!claimed) {
        const doc = await loadKit(req.params.id!, req.userId);
        if (doc.status !== 'ready') throw new ApiError(409, 'KIT_NOT_READY', 'This kit is still being generated');
        throw new ApiError(409, 'REGEN_IN_PROGRESS', `Already regenerating ${doc.regen?.section}. Wait for it to finish.`);
      }
      runner.enqueue({ kind: 'regenerate', kitId: String(claimed._id), section });
      res.status(202).json({ regen: claimed.regen });
    }),
  );

  r.post(
    '/:id/retry',
    asyncHandler(async (req, res) => {
      const doc = await KitModel.findOneAndUpdate(
        { ...ownerFilter(req.params.id!, req.userId), status: 'failed' },
        { $set: { status: 'queued', error: null, progress: [{ step: 'queued', status: 'running', message: 'Retrying', at: new Date().toISOString() }] } },
        { new: true },
      ).lean<StoredKit>();
      if (!doc) throw new ApiError(409, 'NOT_RETRYABLE', 'Only failed kits can be retried');
      runner.enqueue({ kind: 'generate', kitId: String(doc._id) });
      res.status(202).json({ kit: toSummary(doc) });
    }),
  );

  r.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const out = await KitModel.deleteOne(ownerFilter(req.params.id!, req.userId));
      if (out.deletedCount === 0) throw new ApiError(404, 'NOT_FOUND', 'Kit not found');
      res.status(204).end();
    }),
  );

  r.get(
    '/:id/practice',
    asyncHandler(async (req, res) => {
      res.json(practiceView(await loadKit(req.params.id!, req.userId)));
    }),
  );

  r.post(
    '/:id/practice',
    asyncHandler(async (req, res) => {
      const { cardId, confidence } = ReviewBody.parse(req.body);
      const doc = await loadKit(req.params.id!, req.userId);
      if (!doc.kit?.flashcards.some((f) => f.id === cardId)) throw new ApiError(404, 'NOT_FOUND', `Flashcard ${cardId} not found`);
      const prev = CardProgressSchema.safeParse(doc.practice?.[cardId]);
      const next = recordReview(prev.success ? prev.data : undefined, confidence, new Date());
      await KitModel.updateOne({ _id: doc._id }, { $set: { [`practice.${cardId}`]: next } });
      res.json(practiceView({ ...doc, practice: { ...doc.practice, [cardId]: next } }));
    }),
  );

  r.delete(
    '/:id/practice',
    asyncHandler(async (req, res) => {
      const doc = await loadKit(req.params.id!, req.userId);
      await KitModel.updateOne({ _id: doc._id }, { $set: { practice: {} } });
      res.json(practiceView({ ...doc, practice: {} }));
    }),
  );
  return r;
}
