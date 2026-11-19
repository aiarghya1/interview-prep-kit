import type { Question, Requirement } from '../src/schema.js';

export const req = (id: string, priority: 'must' | 'nice' = 'must', kind: Requirement['kind'] = 'technical'): Requirement => ({
  id, text: `Requirement ${id}`, kind, priority,
});

export const q = (id: string, requirement_ids: string[], difficulty = 2, category: Question['category'] = 'technical'): Question => ({
  id, requirement_ids, category, prompt: `Prompt ${id}`, answer_outline: 'outline', difficulty,
});
