/**
 * Merging a regenerated section into a kit the user has already shaped.
 *
 * Every editable item carries `state = { origin, edited, pinned }`:
 *   origin  generated | template | user  — who created it
 *   edited  the user changed a generated item
 *   pinned  the user explicitly asked to keep it
 *
 * An item is *protected* if the user wrote it, edited it, or pinned it.
 * Regenerating a section replaces only unprotected items in that section;
 * protected items keep their id, content and position. Items outside the
 * section are never touched. Ids of replaced items are retired, not reused.
 */
import type { ItemState } from './schema.js';

export const GENERATED: ItemState = { origin: 'generated', edited: false, pinned: false };
export const USER: ItemState = { origin: 'user', edited: false, pinned: false };

export function isProtected(item: { state?: ItemState }): boolean {
  const s = item.state;
  if (!s) return false;
  return s.origin === 'user' || s.edited || s.pinned;
}

/** Apply a user edit: content changes and the item becomes protected. */
export function applyUserEdit<T extends { state?: ItemState }>(item: T, patch: Partial<Omit<T, 'state' | 'id'>>): T {
  const state = item.state ?? GENERATED;
  return { ...item, ...patch, state: { ...state, edited: state.origin !== 'user' ? true : state.edited } };
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export interface MergeResult<T> {
  items: T[];
  added: string[];
  removed: string[];
  kept: string[];
}

/**
 * @param items        the whole list (e.g. all questions)
 * @param inSection    which items belong to the section being regenerated
 * @param generated    fresh model output for that section (no ids yet)
 * @param nextId       id allocator for new items
 * @param dedupeKey    text used to drop regenerated items that duplicate a kept one
 */
export function mergeSection<T extends { id: string; state?: ItemState }>(
  items: T[],
  inSection: (item: T) => boolean,
  generated: Omit<T, 'id'>[],
  nextId: () => string,
  dedupeKey: (item: Omit<T, 'id'>) => string,
): MergeResult<T> {
  const removed: string[] = [];
  const kept: string[] = [];
  const result: T[] = [];
  let insertAt = -1;

  items.forEach((item) => {
    if (!inSection(item)) {
      result.push(item);
      return;
    }
    if (isProtected(item)) {
      kept.push(item.id);
      result.push(item);
      insertAt = result.length; // after the last kept item of the section
    } else {
      removed.push(item.id);
      if (insertAt === -1) insertAt = result.length; // where the section started
    }
  });
  if (insertAt === -1) insertAt = result.length;

  const seen = new Set(result.filter(inSection).map((i) => normalise(dedupeKey(i))));
  const fresh: T[] = [];
  for (const g of generated) {
    const key = normalise(dedupeKey(g));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push({ ...g, id: nextId(), state: { ...GENERATED } } as T);
  }

  result.splice(insertAt, 0, ...fresh);
  return { items: result, added: fresh.map((f) => f.id), removed, kept };
}

/** Single-object sections (company brief): replace unless protected. */
export function mergeSingle<T extends { state?: ItemState }>(current: T, regenerated: Omit<T, 'state'>, force = false): T {
  if (isProtected(current) && !force) return current;
  return { ...regenerated, state: { ...GENERATED } } as T;
}

/** Drop schedule references to questions that no longer exist. */
export function pruneScheduleRefs<D extends { question_ids: string[] }>(days: D[], liveQuestionIds: Set<string>): D[] {
  return days.map((d) => ({ ...d, question_ids: d.question_ids.filter((id) => liveQuestionIds.has(id)) }));
}
