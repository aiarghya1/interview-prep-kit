/**
 * Story bank: the candidate's own experiences, mapped onto the kit.
 *
 * Behavioural and company-fit rounds are answered with real stories, and
 * nobody can rehearse fifteen of them. The practical strategy is a handful of
 * well-rehearsed stories that together cover everything the role asks for.
 * This module checks that, deterministically:
 *
 *   - which must-have requirements no story demonstrates (gaps in *your*
 *     preparation, not the kit's)
 *   - which story best answers each behavioural / company-fit question
 *     (shared requirement tags first, then word overlap)
 *   - which story you are leaning on for too many questions
 *
 * No model involved: it can't invent experience the candidate doesn't have.
 */
import { z } from 'zod';
import type { Kit, Question, Requirement } from './schema.js';

export const StorySchema = z.object({
  id: z.string().regex(/^s\d+$/),
  title: z.string().trim().min(1).max(120),
  situation: z.string().max(2000).default(''),
  action: z.string().max(3000).default(''),
  result: z.string().max(2000).default(''),
  requirement_ids: z.array(z.string()).max(20).default([]),
});
export type Story = z.infer<typeof StorySchema>;

export const StoriesSchema = z
  .array(StorySchema)
  .max(15)
  .refine((s) => new Set(s.map((x) => x.id)).size === s.length, 'Story ids must be unique');

const STOP = new Set(
  'about above after again also because been before being both could does doing during each from have having into more most other over same should some such than that their them then there these they this those through very what when where which while with would your yours tell time describe example walk give share talk'.split(' '),
);

function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, '');
}

export function storyTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9+#]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 3 && !STOP.has(w))
      .map(stem),
  );
}

export interface StoryMatch {
  storyId: string;
  score: number;
  sharedRequirements: string[];
}

export interface StoryAnalysis {
  /** requirement id -> story ids that demonstrate it */
  byRequirement: Record<string, string[]>;
  /** must-have requirements no story demonstrates, behavioural/domain first */
  mustGaps: Requirement[];
  /** question id -> ranked story matches (best first, max 2) */
  byQuestion: Record<string, StoryMatch[]>;
  /** questions that need a story but have no reasonable match */
  unmatchedQuestions: string[];
  /** story id -> number of questions it is the best match for */
  usage: Record<string, number>;
  /** stories that are the best answer to too many questions */
  overused: string[];
  /** stories that neither demonstrate a requirement nor answer a question */
  unused: string[];
}

export const STORY_CATEGORIES: Question['category'][] = ['behavioural', 'company-fit'];

export function scoreStory(q: Question, story: Story, storyText: Set<string>): StoryMatch {
  const shared = q.requirement_ids.filter((r) => story.requirement_ids.includes(r));
  const qTokens = storyTokens(q.prompt);
  let overlap = 0;
  qTokens.forEach((t) => storyText.has(t) && overlap++);
  return { storyId: story.id, score: shared.length * 3 + Math.min(overlap, 3), sharedRequirements: shared };
}

export function analyseStories(kit: Kit, stories: Story[]): StoryAnalysis {
  const byRequirement: Record<string, string[]> = Object.fromEntries(kit.role.requirements.map((r) => [r.id, []]));
  for (const s of stories) for (const r of s.requirement_ids) byRequirement[r]?.push(s.id);

  const kindRank = (r: Requirement) => (r.kind === 'technical' ? 1 : 0);
  const mustGaps = kit.role.requirements
    .filter((r) => r.priority === 'must' && (byRequirement[r.id]?.length ?? 0) === 0)
    .sort((a, b) => kindRank(a) - kindRank(b));

  const texts = new Map(stories.map((s) => [s.id, storyTokens(`${s.title} ${s.situation} ${s.action} ${s.result}`)]));
  const byQuestion: Record<string, StoryMatch[]> = {};
  const unmatchedQuestions: string[] = [];
  const usage: Record<string, number> = Object.fromEntries(stories.map((s) => [s.id, 0]));

  for (const q of kit.questions.filter((x) => STORY_CATEGORIES.includes(x.category))) {
    const ranked = stories
      .map((s) => scoreStory(q, s, texts.get(s.id)!))
      .filter((m) => m.score >= 2)
      .sort((a, b) => b.score - a.score || a.storyId.localeCompare(b.storyId, undefined, { numeric: true }))
      .slice(0, 2);
    byQuestion[q.id] = ranked;
    if (ranked.length === 0) unmatchedQuestions.push(q.id);
    else usage[ranked[0]!.storyId]! += 1;
  }

  const answered = Object.values(usage).reduce((a, b) => a + b, 0);
  const overused =
    stories.length >= 2 ? Object.entries(usage).filter(([, n]) => n >= 3 && n > answered / 2).map(([id]) => id) : [];
  const unused = stories.filter((s) => s.requirement_ids.length === 0 && (usage[s.id] ?? 0) === 0).map((s) => s.id);

  return { byRequirement, mustGaps, byQuestion, unmatchedQuestions, usage, overused, unused };
}
