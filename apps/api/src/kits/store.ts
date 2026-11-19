import mongoose from 'mongoose';
import { validateKit, type IdHighWater, type Kit } from '@kit/core';
import { KitModel } from '../db/models.js';
import { ApiError } from '../errors.js';

export interface StoredKit {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  status: 'queued' | 'running' | 'ready' | 'failed';
  input: { jd: string; company_url: string; days: number };
  inputHash: string;
  title?: string;
  company?: string;
  kit: Kit | null;
  version: number;
  highWater: IdHighWater;
  progress: { step: string; status: string; message: string; at: string }[];
  error?: { code?: string; message?: string };
  practice: Record<string, unknown>;
  regen?: { section?: string; status?: string; startedAt?: Date; finishedAt?: Date; message?: string };
  scheduleStale: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function ownerFilter(id: string, userId?: string) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'NOT_FOUND', 'Kit not found');
  return userId ? { _id: id, userId } : { _id: id };
}

export async function loadKit(id: string, userId?: string): Promise<StoredKit> {
  const doc = await KitModel.findOne(ownerFilter(id, userId)).lean<StoredKit>();
  if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Kit not found');
  return doc;
}

/**
 * Read-modify-write guarded by `version`. If someone else wrote in between,
 * re-read and re-apply the mutation to the newer kit. Mutations are pure
 * functions of the latest kit (edit ops, merges), so re-applying is safe.
 */
export async function updateKitWithRetry(
  id: string,
  userId: string | undefined,
  mutate: (doc: StoredKit & { kit: Kit }) => { kit: Kit; highWater?: IdHighWater; set?: Record<string, unknown> },
): Promise<StoredKit & { kit: Kit }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const doc = await loadKit(id, userId);
    if (doc.status !== 'ready' || !doc.kit) throw new ApiError(409, 'KIT_NOT_READY', 'This kit is still being generated');
    const out = mutate(doc as StoredKit & { kit: Kit });
    const valid = validateKit(out.kit);
    if (!valid.ok) throw new ApiError(422, 'KIT_INVALID', 'That change would leave the kit invalid', valid.issues.slice(0, 10));
    const res = await KitModel.updateOne(
      { _id: doc._id, version: doc.version },
      { $set: { kit: valid.kit, highWater: out.highWater ?? doc.highWater, ...(out.set ?? {}) }, $inc: { version: 1 } },
    );
    if (res.modifiedCount === 1) {
      return { ...doc, ...(out.set ?? {}), kit: valid.kit, highWater: out.highWater ?? doc.highWater, version: doc.version + 1 };
    }
  }
  throw new ApiError(409, 'CONFLICT', 'The kit kept changing while saving; please retry');
}

export function maxIdNum(ids: string[]): number {
  return ids.reduce((m, id) => Math.max(m, Number(id.slice(1)) || 0), 0);
}

/** What the interface gets. Never includes the stored research corpus. */
export function toView(doc: StoredKit) {
  return {
    id: String(doc._id),
    status: doc.status,
    title: doc.title ?? '',
    company: doc.company ?? '',
    input: doc.input,
    kit: doc.kit,
    version: doc.version,
    highWater: doc.highWater ?? { q: 0, f: 0 },
    progress: doc.progress ?? [],
    error: doc.error?.code ? doc.error : null,
    regen: doc.regen?.section ? doc.regen : null,
    scheduleStale: Boolean(doc.scheduleStale),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function toSummary(doc: StoredKit) {
  const kit = doc.kit;
  return {
    id: String(doc._id),
    status: doc.status,
    title: doc.title || kit?.role.title || 'Untitled role',
    company: doc.company || kit?.source.company || '',
    days: doc.input?.days,
    questions: kit?.questions.length ?? 0,
    flashcards: kit?.flashcards.length ?? 0,
    lastProgress: doc.progress?.at(-1)?.message ?? null,
    error: doc.error?.code ? doc.error : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
