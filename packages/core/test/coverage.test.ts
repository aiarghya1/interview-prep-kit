import { describe, expect, it, vi } from 'vitest';
import { computeCoverage, runCoverageLoop, dropDanglingRequirementRefs } from '../src/coverage.js';
import { q, req } from './fixtures.js';

const reqs = [req('r1'), req('r2'), req('r3', 'nice'), req('r4', 'must', 'behavioural')];

describe('computeCoverage', () => {
  it('reports uncovered and uncovered must-haves', () => {
    const r = computeCoverage(reqs, [q('q1', ['r1']), q('q2', ['r1', 'r3'])]);
    expect(r.uncovered).toEqual(['r2', 'r4']);
    expect(r.uncoveredMust).toEqual(['r2', 'r4']);
    expect(r.counts).toEqual({ r1: 2, r2: 0, r3: 1, r4: 0 });
  });

  it('ignores references to unknown requirements', () => {
    const r = computeCoverage(reqs, [q('q1', ['r99'])]);
    expect(r.uncovered).toHaveLength(4);
  });

  it('dropDanglingRequirementRefs strips unknown and duplicate ids', () => {
    expect(dropDanglingRequirementRefs([q('q1', ['r1', 'r1', 'r99'])], reqs)[0]!.requirement_ids).toEqual(['r1']);
  });
});

describe('runCoverageLoop', () => {
  it('fills gaps on a second pass and stops when covered', async () => {
    const fill = vi.fn(async (gaps: typeof reqs) => gaps.map((g) => ({ ...q('x', [g.id]), id: undefined })));
    const res = await runCoverageLoop({ requirements: reqs, questions: [q('q1', ['r1'])], fillGaps: fill });
    expect(fill).toHaveBeenCalledTimes(1);
    expect(fill.mock.calls[0]![0].map((r) => r.id)).toEqual(['r2', 'r3', 'r4']);
    expect(res.passes).toBe(2);
    expect(res.report.uncovered).toEqual([]);
    expect(res.questions.map((x) => x.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
  });

  it('needs only one pass when the draft already covers everything', async () => {
    const fill = vi.fn();
    const res = await runCoverageLoop({
      requirements: reqs,
      questions: reqs.map((r, i) => q(`q${i + 1}`, [r.id])),
      fillGaps: fill,
    });
    expect(fill).not.toHaveBeenCalled();
    expect(res.passes).toBe(1);
  });

  it('closes gaps across multiple passes, one at a time', async () => {
    const fill = vi.fn(async (gaps: typeof reqs) => [{ ...q('x', [gaps[0]!.id]) }]);
    const res = await runCoverageLoop({ requirements: reqs, questions: [], fillGaps: fill, maxPasses: 3 });
    expect(res.passes).toBe(3);
    // two passes closed r1, r2; template fallback covers remaining must r4; nice r3 stays uncovered
    expect(res.report.uncoveredMust).toEqual([]);
    expect(res.report.uncovered).toEqual(['r3']);
    expect(res.questions.find((x) => x.requirement_ids.includes('r4'))!.state?.origin).toBe('template');
  });

  it('stops early when a pass makes no progress, and never ships uncovered must-haves', async () => {
    const fill = vi.fn(async () => [q('x', ['r99'])]); // off-target output
    const res = await runCoverageLoop({ requirements: reqs, questions: [], fillGaps: fill, maxPasses: 5 });
    expect(fill).toHaveBeenCalledTimes(1);
    expect(res.notes.join(' ')).toMatch(/closed no gaps/);
    expect(res.report.uncoveredMust).toEqual([]);
  });

  it('survives a gap-filler that throws', async () => {
    const res = await runCoverageLoop({
      requirements: reqs, questions: [], fillGaps: async () => { throw new Error('429'); },
    });
    expect(res.notes[0]).toMatch(/429/);
    expect(res.report.uncoveredMust).toEqual([]);
  });

  it('can report uncovered must-haves honestly when fallback is disabled', async () => {
    const res = await runCoverageLoop({ requirements: reqs, questions: [], fillGaps: async () => [], templateFallback: false });
    expect(res.report.uncoveredMust).toEqual(['r1', 'r2', 'r4']);
  });
});
