import { createHash } from 'node:crypto';
import { MAX_DAYS, MAX_JD_CHARS, MIN_JD_CHARS, rescheduleKit, type Kit } from '@kit/core';
import { z } from 'zod';
import { KitModel } from '../db/models.js';
import { ApiError } from '../errors.js';
import type { JobRunner } from '../jobs/runner.js';
import { toSummary, type StoredKit } from './store.js';

export const KitInputSchema = z.object({
  jd: z.string().trim().min(MIN_JD_CHARS, `Paste the job description (at least ${MIN_JD_CHARS} characters)`).max(MAX_JD_CHARS),
  company_url: z.string().trim().min(1, 'Company website is required').max(2000),
  days: z.coerce.number().int().min(1, 'At least 1 day').max(MAX_DAYS, `At most ${MAX_DAYS} days`),
});
export type KitInputBody = z.infer<typeof KitInputSchema>;

/** Same description + same site = same research, whatever the whitespace or trailing slash. */
export function inputHash(jd: string, companyUrl: string): string {
  const url = companyUrl.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  return createHash('sha256').update(`${jd.replace(/\s+/g, ' ').trim()}\n${url}`).digest('hex');
}

export type CreateOutcome = { status: 201 | 202 | 200; deduplicated: false | 'in_progress' | 'existing' | 'rescheduled'; kit: ReturnType<typeof toSummary> };

export async function createKit(userId: string, input: KitInputBody, runner: JobRunner, opts: { force?: boolean; maxActive: number }): Promise<CreateOutcome> {
  const hash = inputHash(input.jd, input.company_url);
  if (!opts.force) {
    const existing = await KitModel.findOne({ userId, inputHash: hash, status: { $in: ['queued', 'running', 'ready'] } })
      .sort({ createdAt: -1 })
      .select('+corpus')
      .lean<StoredKit & { corpus?: unknown }>();
    if (existing) {
      if (existing.status !== 'ready') return { status: 200, deduplicated: 'in_progress', kit: toSummary(existing) };
      if (existing.input.days === input.days) return { status: 200, deduplicated: 'existing', kit: toSummary(existing) };
      // Same posting, different time frame: reuse the research, rebuild only the schedule (no model calls).
      const kit: Kit = rescheduleKit(existing.kit!, input.days);
      const doc = await KitModel.create({
        userId,
        status: 'ready',
        input,
        inputHash: hash,
        title: existing.title,
        company: existing.company,
        kit,
        corpus: existing.corpus,
        version: 1,
        highWater: existing.highWater,
        progress: [{ step: 'done', status: 'done', message: `Reused research from an earlier kit; rebuilt schedule for ${input.days} day(s)`, at: new Date().toISOString() }],
      });
      return { status: 201, deduplicated: 'rescheduled', kit: toSummary(doc.toObject() as StoredKit) };
    }
  }
  const active = await KitModel.countDocuments({ userId, status: { $in: ['queued', 'running'] } });
  if (active >= opts.maxActive) {
    throw new ApiError(429, 'TOO_MANY_ACTIVE', `You already have ${active} kits generating. Wait for one to finish.`);
  }
  const doc = await KitModel.create({
    userId,
    status: 'queued',
    input,
    inputHash: hash,
    title: input.jd.split('\n').find((l) => l.trim())!.trim().slice(0, 120),
    progress: [{ step: 'queued', status: 'running', message: 'Waiting to start', at: new Date().toISOString() }],
  });
  runner.enqueue({ kind: 'generate', kitId: String(doc._id) });
  return { status: 202, deduplicated: false, kit: toSummary(doc.toObject() as StoredKit) };
}
