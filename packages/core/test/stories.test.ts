import { describe, expect, it } from 'vitest';
import { analyseStories, StoriesSchema, type Story } from '../src/stories.js';
import { GENERATED } from '../src/merge.js';
import type { Kit } from '../src/schema.js';
import { sampleKit } from './kitFixture.js';
import { q } from './fixtures.js';

const story = (id: string, requirement_ids: string[], text = ''): Story => ({ id, title: `Story ${id}`, situation: text, action: '', result: '', requirement_ids });

function kitWithBehavioural(): Kit {
  const k = sampleKit();
  k.role.requirements[2] = { ...k.role.requirements[2]!, text: 'Mentoring junior engineers' };
  k.questions.push(
    { ...q('q5', [], 2, 'behavioural'), prompt: 'Tell me about a disagreement with a teammate over a technical decision', state: { ...GENERATED } },
    { ...q('q6', ['r3'], 2, 'behavioural'), prompt: 'Describe how you helped a junior engineer grow', state: { ...GENERATED } },
  );
  return k;
}

describe('analyseStories', () => {
  it('reports must-haves no story demonstrates, behavioural/domain before technical', () => {
    const a = analyseStories(kitWithBehavioural(), [story('s1', ['r1'])]);
    expect(a.mustGaps.map((r) => r.id)).toEqual(['r3', 'r2']);
    expect(a.byRequirement.r1).toEqual(['s1']);
  });

  it('matches stories to questions by shared requirement first, then by words', () => {
    const stories = [
      story('s1', ['r3'], 'I mentored two junior engineers through their first on-call rotation'),
      story('s2', [], 'A disagreement with a teammate about the database schema; we prototyped both'),
    ];
    const a = analyseStories(kitWithBehavioural(), stories);
    expect(a.byQuestion.q3![0]).toMatchObject({ storyId: 's1', sharedRequirements: ['r3'] });
    expect(a.byQuestion.q5![0]!.storyId).toBe('s2');
    expect(a.byQuestion.q6![0]!.storyId).toBe('s1');
    expect(a.unmatchedQuestions).toEqual(['q4']);
    expect(a.usage).toEqual({ s1: 2, s2: 1 });
  });

  it('flags a story that answers most questions, and stories that do nothing', () => {
    const k = kitWithBehavioural();
    k.questions.push({ ...q('q7', ['r3'], 1, 'behavioural'), state: { ...GENERATED } }, { ...q('q8', ['r3'], 1, 'company-fit'), state: { ...GENERATED } });
    const a = analyseStories(k, [story('s1', ['r3']), story('s2', [], 'gardening')]);
    expect(a.overused).toEqual(['s1']);
    expect(a.unused).toEqual(['s2']);
  });

  it('ignores tags for requirements that no longer exist', () => {
    const a = analyseStories(sampleKit(), [story('s1', ['r99'])]);
    expect(Object.keys(a.byRequirement)).not.toContain('r99');
  });

  it('validates the bank', () => {
    expect(StoriesSchema.safeParse([story('s1', []), story('s1', [])]).success).toBe(false);
    expect(StoriesSchema.safeParse([{ id: 's1', title: '' }]).success).toBe(false);
    expect(StoriesSchema.parse([{ id: 's1', title: 'Ok' }])[0]).toMatchObject({ situation: '', requirement_ids: [] });
  });
});
