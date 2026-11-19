/**
 * Step: flashcards for quick recall, generated after the question bank is
 * final so they reinforce the same requirements. If generation fails, cards
 * are derived from the questions by code, so the kit is never left without.
 */
import { z } from 'zod';
import type { Flashcard, Question, Requirement } from '../schema.js';
import type { Llm } from '../llm/types.js';
import { UNTRUSTED_RULES } from '../llm/untrusted.js';

const CardsOut = z.object({
  flashcards: z
    .array(z.object({ front: z.string().min(2), back: z.string().catch(''), requirement_ids: z.array(z.string()).catch([]) }))
    .catch([]),
});

const SYSTEM = `You write flashcards for interview preparation. Output JSON only.

${UNTRUSTED_RULES}

Each card: front = a short prompt (a concept, term, or "how would you..." cue); back = a concise answer of 1-4 sentences or key points. Cards test knowledge the candidate needs for the listed requirements; prefer must-have [must] requirements. requirement_ids: ids from the list only.

Return: {"flashcards": [{"front": "", "back": "", "requirement_ids": ["r1"]}]}`;

export function flashcardCount(requirements: Requirement[]): number {
  const must = requirements.filter((r) => r.priority === 'must').length;
  return Math.max(3, Math.min(16, must * 2 + (requirements.length - must)));
}

export function cardsFromQuestions(questions: Question[], n: number): Omit<Flashcard, 'id'>[] {
  return questions.slice(0, n).map((q) => ({
    front: q.prompt,
    back: q.answer_outline || 'Draft your own answer.',
    requirement_ids: q.requirement_ids,
    state: { origin: 'template' as const, edited: false, pinned: false },
  }));
}

export async function generateFlashcards(args: {
  llm: Llm;
  requirements: Requirement[];
  questions: Question[];
  roleTitle: string;
}): Promise<Omit<Flashcard, 'id'>[]> {
  const { llm, requirements, questions } = args;
  const n = flashcardCount(requirements);
  const out = await llm.json({
    task: 'flashcards',
    system: SYSTEM,
    user: [
      `Role: ${args.roleTitle || 'unspecified'}`,
      `Write ${n} flashcards.`,
      `Requirements:\n${requirements.map((r) => `- ${r.id} [${r.priority}] ${r.text}`).join('\n') || '(none stated: write general cards for the role)'}`,
      `Interview questions in the kit (for context):\n${questions.slice(0, 20).map((q) => `- ${q.prompt.slice(0, 140)}`).join('\n')}`,
    ].join('\n\n'),
    schema: CardsOut,
    maxTokens: Math.min(2500, 200 + n * 130),
    temperature: 0.3,
  });
  const allowed = new Set(requirements.map((r) => r.id));
  return out.flashcards.slice(0, n + 2).map((c) => ({
    front: c.front.trim().slice(0, 500),
    back: c.back.trim().slice(0, 1500),
    requirement_ids: [...new Set(c.requirement_ids)].filter((id) => allowed.has(id)),
    state: { origin: 'generated' as const, edited: false, pinned: false },
  }));
}
