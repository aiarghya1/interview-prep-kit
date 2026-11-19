import { describe, expect, it } from 'vitest';
import { EditOpsSchema } from '@kit/core/edit';
import { applyOpsLeniently, coalesce, remapOpIds } from '@/lib/applyOps';
import { parseBatchFile } from '@/lib/parseBatch';
import { sampleKit } from '../../../packages/core/test/kitFixture';

const ops = (x: unknown[]) => EditOpsSchema.parse(x);

describe('optimistic edit helpers', () => {
  it('coalesces consecutive edits to the same item, keeps others in order', () => {
    const out = coalesce(ops([
      { op: 'question.update', id: 'q1', patch: { prompt: 'a' } },
      { op: 'question.update', id: 'q1', patch: { answer_outline: 'b' } },
      { op: 'question.update', id: 'q2', patch: { prompt: 'c' } },
      { op: 'question.reorder', ids: ['q2', 'q1'] },
      { op: 'question.reorder', ids: ['q1', 'q2'] },
    ]));
    expect(out).toEqual([
      { op: 'question.update', id: 'q1', patch: { prompt: 'a', answer_outline: 'b' } },
      { op: 'question.update', id: 'q2', patch: { prompt: 'c' } },
      { op: 'question.reorder', ids: ['q1', 'q2'] },
    ]);
  });

  it('remaps optimistic ids to server ids in pending ops', () => {
    const out = remapOpIds(ops([
      { op: 'question.update', id: 'q5', patch: { prompt: 'x' } },
      { op: 'question.reorder', ids: ['q5', 'q1'] },
      { op: 'pin', target: 'question', id: 'q5', pinned: true },
    ]), { q5: 'q7' });
    expect(out.map((o) => ('id' in o ? o.id : (o as { ids: string[] }).ids.join()))).toEqual(['q7', 'q7,q1', 'q7']);
  });

  it('applies leniently: an op on an item that vanished is skipped, the rest apply', () => {
    const r = applyOpsLeniently(sampleKit(), ops([
      { op: 'question.update', id: 'q99', patch: { prompt: 'gone' } },
      { op: 'question.update', id: 'q1', patch: { prompt: 'kept' } },
    ]), { q: 4, f: 2 });
    expect(r.skipped).toHaveLength(1);
    expect(r.kit.questions[0]!.prompt).toBe('kept');
  });
});

describe('parseBatchFile', () => {
  it('reads JSON with defaults and validation', () => {
    const r = parseBatchFile('x.json', JSON.stringify([
      { jd: 'A long enough job description here', company_url: 'acme.com' },
      { jd: 'short', company_url: 'b.com', days: 3 },
      { id: 'case', jd: 'Another long enough description', url: 'c.com', days: 7 },
    ]), 5);
    expect(r.rows).toEqual([
      { jd: 'A long enough job description here', company_url: 'acme.com', days: 5 },
      { jd: 'Another long enough description', company_url: 'c.com', days: 7 },
    ]);
    expect(r.errors[0]).toMatch(/Row 2/);
  });

  it('reads CSV with quoted multi-line fields', () => {
    const csv = 'jd,company_url,days\n"Senior Engineer\nRequirements: ""Go"", Kubernetes",acme.com,3\n';
    const r = parseBatchFile('x.csv', csv, 5);
    expect(r.rows).toEqual([{ jd: 'Senior Engineer\nRequirements: "Go", Kubernetes', company_url: 'acme.com', days: 3 }]);
  });

  it('explains a bad file', () => {
    expect(parseBatchFile('x.json', '{nope', 5).errors[0]).toMatch(/not valid JSON/);
    expect(parseBatchFile('x.csv', 'a,b\n1,2', 5).errors[0]).toMatch(/header row/);
  });
});
