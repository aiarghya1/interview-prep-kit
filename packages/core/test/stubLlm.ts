import type { Llm, LlmJsonRequest } from '../src/llm/types.js';

type Responder = unknown | ((req: LlmJsonRequest<unknown>) => unknown);

/** Minimal scripted model: one canned answer (or function) per task name. */
export function stubLlm(answers: Record<string, Responder>): Llm & { calls: LlmJsonRequest<unknown>[] } {
  const calls: LlmJsonRequest<unknown>[] = [];
  return {
    name: 'stub',
    calls,
    async json<T>(req: LlmJsonRequest<T>): Promise<T> {
      calls.push(req as LlmJsonRequest<unknown>);
      const key = Object.keys(answers).find((k) => req.task === k || req.task.startsWith(k));
      if (!key) throw new Error(`stubLlm: no answer for ${req.task}`);
      const a = answers[key];
      const value = typeof a === 'function' ? (a as (r: LlmJsonRequest<unknown>) => unknown)(req as LlmJsonRequest<unknown>) : a;
      return req.schema.parse(value);
    },
  };
}
