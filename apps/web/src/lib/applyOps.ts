import { applyEditOps, type EditOp, type IdHighWater } from '@kit/core/edit';
import type { Kit } from '@kit/core/schema';

/**
 * Apply ops one at a time, skipping any that no longer apply (e.g. the item
 * was removed by a regeneration that just landed). Returns which were skipped
 * so the UI can say so.
 */
export function applyOpsLeniently(kit: Kit, ops: EditOp[], highWater: IdHighWater) {
  let current = kit;
  let hw = highWater;
  const created: Record<string, string> = {};
  const skipped: EditOp[] = [];
  for (const op of ops) {
    try {
      const r = applyEditOps(current, [op], hw);
      current = r.kit;
      hw = r.highWater;
      Object.assign(created, r.created);
    } catch {
      skipped.push(op);
    }
  }
  return { kit: current, highWater: hw, created, skipped };
}

/** Rewrite item ids inside ops (local optimistic id -> id the server assigned). */
export function remapOpIds(ops: EditOp[], map: Record<string, string>): EditOp[] {
  if (Object.keys(map).length === 0) return ops;
  const m = (id: string) => map[id] ?? id;
  return ops.map((op) => {
    switch (op.op) {
      case 'question.update':
      case 'question.delete':
      case 'question.move':
      case 'flashcard.update':
      case 'flashcard.delete':
        return { ...op, id: m(op.id) };
      case 'question.reorder':
      case 'flashcard.reorder':
        return { ...op, ids: op.ids.map(m) };
      case 'pin':
        return op.id ? { ...op, id: m(op.id) } : op;
      default:
        return op;
    }
  });
}

/** Merge consecutive updates to the same item so typing doesn't produce dozens of ops. */
export function coalesce(ops: EditOp[]): EditOp[] {
  const out: EditOp[] = [];
  for (const op of ops) {
    const prev = out.at(-1);
    if (prev && prev.op === op.op && (op.op === 'question.update' || op.op === 'flashcard.update') && 'id' in prev && prev.id === op.id) {
      out[out.length - 1] = { ...op, patch: { ...(prev as typeof op).patch, ...op.patch } } as EditOp;
    } else if (prev && prev.op === 'brief.update' && op.op === 'brief.update') {
      out[out.length - 1] = { ...op, patch: { ...prev.patch, ...op.patch } };
    } else if (prev && prev.op === op.op && (op.op === 'question.reorder' || op.op === 'flashcard.reorder')) {
      out[out.length - 1] = op;
    } else out.push(op);
  }
  return out;
}
