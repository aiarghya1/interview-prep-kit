import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GroqLlm } from '../src/llm/groq.js';
import { parseDurationMs, TokenBucket } from '../src/llm/rate.js';
import { parseJsonLoose } from '../src/llm/json.js';
import type { LlmEvent } from '../src/llm/types.js';

const ok = (content: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 50 } }), { status: 200, headers });
const err = (status: number, message: string, headers: Record<string, string> = {}, code?: string, extra: object = {}) =>
  new Response(JSON.stringify({ error: { message, code, ...extra } }), { status, headers });

function client(responses: Response[], models = ['big', 'small']) {
  const bodies: any[] = [];
  const waits: number[] = [];
  const events: LlmEvent[] = [];
  const llm = new GroqLlm({
    apiKey: 'k', models, tokensPerMinute: 100_000,
    fetchImpl: (async (_u: any, init: any) => { bodies.push(JSON.parse(init.body)); return responses.shift()!; }) as typeof fetch,
    sleep: async (ms) => { waits.push(ms); },
    onEvent: (e) => events.push(e),
  });
  return { llm, bodies, waits, events };
}
const schema = z.object({ answer: z.number() });

describe('GroqLlm', () => {
  it('waits for retry-after on 429 and retries', async () => {
    const c = client([err(429, 'Rate limit reached on tokens per minute (TPM). Please try again in 7.5s.', { 'retry-after': '3' }), ok('{"answer": 1}')]);
    await expect(c.llm.json({ task: 't', system: 's JSON', user: 'u', schema })).resolves.toEqual({ answer: 1 });
    expect(c.waits.some((w) => w >= 3000)).toBe(true);
    expect(c.events.map((e) => e.type)).toContain('rate_limited');
  });

  it('falls over to the next model when the daily budget is exhausted', async () => {
    const c = client([err(429, 'Rate limit reached on tokens per day (TPD)'), ok('{"answer": 2}')]);
    await c.llm.json({ task: 't', system: 's', user: 'u', schema });
    expect(c.bodies.map((b) => b.model)).toEqual(['big', 'small']);
  });

  it('gives up with LLM_RATE_LIMITED when every model is out of daily budget', async () => {
    const c = client([err(429, 'tokens per day (TPD)'), err(429, 'tokens per day (TPD)')]);
    await expect(c.llm.json({ task: 't', system: 's', user: 'u', schema })).rejects.toMatchObject({ code: 'LLM_RATE_LIMITED' });
  });

  it('asks the model to repair invalid output, with the validation errors', async () => {
    const c = client([ok('not json at all'), ok('{"answer": "two"}'), ok('```json\n{"answer": 2,}\n```')]);
    await expect(c.llm.json({ task: 't', system: 's', user: 'u', schema })).resolves.toEqual({ answer: 2 });
    expect(c.bodies[2].messages.at(-1).content).toMatch(/answer: Expected number/);
  });

  it('treats a JSON-mode rejection as output to repair', async () => {
    const c = client([err(400, 'Failed to generate JSON', {}, 'json_validate_failed', { failed_generation: '{"answer": 3' }), ok('{"answer": 3}')]);
    await expect(c.llm.json({ task: 't', system: 's', user: 'u', schema })).resolves.toEqual({ answer: 3 });
  });

  it('retries 5xx with backoff, and fails clearly on a bad key', async () => {
    const c = client([err(503, 'down'), ok('{"answer": 4}')]);
    await expect(c.llm.json({ task: 't', system: 's', user: 'u', schema })).resolves.toEqual({ answer: 4 });
    const d = client([err(401, 'Invalid API Key')]);
    await expect(d.llm.json({ task: 't', system: 's', user: 'u', schema })).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
  });

  it('fails with LLM_INVALID_OUTPUT after bounded repairs', async () => {
    const c = client([ok('x'), ok('y'), ok('z')]);
    await expect(c.llm.json({ task: 't', system: 's', user: 'u', schema })).rejects.toMatchObject({ code: 'LLM_INVALID_OUTPUT' });
  });
});

describe('rate helpers', () => {
  it('parses provider durations', () => {
    expect(parseDurationMs('7.66s')).toBe(7660);
    expect(parseDurationMs('1m2.5s')).toBe(62_500);
    expect(parseDurationMs('350ms')).toBe(350);
    expect(parseDurationMs('2')).toBe(2000);
    expect(parseDurationMs('soon')).toBeUndefined();
  });
  it('token bucket makes callers wait once the minute budget is spent', () => {
    let t = 0;
    const b = new TokenBucket(6000, () => t);
    expect(b.reserve(4000)).toBe(0);
    expect(b.reserve(4000)).toBe(20_000); // 2000 short at 100 tokens/s
    t = 20_000;
    expect(b.reserve(100)).toBeGreaterThan(0);
  });
  it('parses loose JSON', () => {
    expect(parseJsonLoose('Sure! ```json\n{"a": [1,2,],}\n``` hope that helps')).toEqual({ a: [1, 2] });
  });
});
