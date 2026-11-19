/**
 * Stable id allocation. Ids are `<prefix><n>` and are never reused within a
 * kit: a deleted q7 stays retired, so practice history and schedule
 * references that mention q7 can never silently point at a different question.
 *
 * `highWater` lets the caller carry the highest id ever issued (persisted on
 * the kit) so deletions don't lower it.
 */
export function maxIdNumber(ids: Iterable<string>, prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

export function createIdAllocator(prefix: string, existing: Iterable<string>, highWater = 0) {
  let next = Math.max(maxIdNumber(existing, prefix), highWater) + 1;
  return {
    next: () => `${prefix}${next++}`,
    /** Highest id issued so far — persist this. */
    get highWater() {
      return next - 1;
    },
  };
}
