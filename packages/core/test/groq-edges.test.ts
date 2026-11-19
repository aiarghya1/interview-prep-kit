import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_GROQ_MODELS, GroqLlm, llmFromEnv } from '../src/llm/groq.js';
import type { LlmEvent } from '../src/llm/types.js';

const schema = z.object({ answer: z.number() });
const req = { task: 't', system: 's', user: 'u', schema };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = (content: unknown, headers: Record<string, string> = {}, usage: unknown = { total_tokens: 10 }) =>
  json({ choices: [{ message: { content } }], usage }, 200, headers);

function client(responses: (Response | Error)[], opts: Partial<ConstructorParameters<typeof GroqLlm>[0]> = {}) {
  const waits: number[] = [];
  const events: LlmEvent[] = [];
  const bodies: Record<string, unknown>[] = [];
  const llm = new GroqLlm({
    apiKey: 'k',
    models: ['m1', 'm2'],
    fetchImpl: (async (_u: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
    sleep: async (ms) => void waits.push(ms),
    onEvent: (e) => events.push(e),
    ...opts,
  });
  return { llm, waits, events, bodies };
}

describe('GroqLlm construction and configuration', () => {
  it('requires a key and at least one model; has defaults', () => {
    expect(() => new GroqLlm({ apiKey: '', models: ['m'] })).toThrow(/GROQ_API_KEY/);
    expect(() => new GroqLlm({ apiKey: 'k', models: [] })).toThrow(/No Groq model/);
    const bare = new GroqLlm({ apiKey: 'k', models: ['m'] });
    expect(bare.model).toBe('m');
    expect(bare.name).toBe('groq:m');
  });
  it('llmFromEnv reads GROQ_MODELS, then GROQ_MODEL, then defaults', () => {
    expect((llmFromEnv({ GROQ_API_KEY: 'k', GROQ_MODELS: ' a , b ,', GROQ_TPM: '9000' }) as GroqLlm).model).toBe('a');
    expect((llmFromEnv({ GROQ_API_KEY: 'k', GROQ_MODEL: 'single' }) as GroqLlm).model).toBe('single');
    expect((llmFromEnv({ GROQ_API_KEY: 'k', GROQ_TPM: 'nope' }) as GroqLlm).model).toBe(DEFAULT_GROQ_MODELS[0]);
    expect(() => llmFromEnv({})).toThrow(/GROQ_API_KEY/);
  });
});

describe('GroqLlm request handling', () => {
  it('paces itself when the token budget is spent', async () => {
    const c = client([ok('{"answer":1}', {}, { total_tokens: 1900 }), ok('{"answer":2}')], { tokensPerMinute: 2000 });
    await c.llm.json({ ...req, maxTokens: 1500 });
    await c.llm.json({ ...req, maxTokens: 1500 });
    expect(c.events.some((e) => e.type === 'rate_limited' && /Pacing/.test(e.message))).toBe(true);
    expect(c.waits[0]).toBeGreaterThan(0);
  });

  it('retries network errors with backoff, then gives up with LLM_UNAVAILABLE', async () => {
    const c = client([new Error('ECONNRESET'), ok('{"answer":3}')]);
    await expect(c.llm.json(req)).resolves.toEqual({ answer: 3 });
    expect(c.events.map((e) => e.type)).toContain('retry');
    const d = client([new Error('down'), new Error('down')], { maxAttempts: 2 });
    await expect(d.llm.json(req)).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE', message: /unreachable: down/ });
  });

  it('adopts provider limit headers; tolerates missing usage and content', async () => {
    const c = client([ok(null, { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '7000' }, null), ok('{"answer":4}')]);
    await expect(c.llm.json(req)).resolves.toEqual({ answer: 4 });
    expect(c.events.find((e) => e.type === 'call')!.message).toMatch(/\? tokens/);
  });

  it('reports root-level validation errors when the model returns the wrong shape', async () => {
    const c = client([ok('[1]'), ok('{"answer":5}')]);
    await c.llm.json(req);
    expect(String((c.bodies[1]!.messages as { content: string }[]).at(-1)!.content)).toMatch(/\(root\)/);
  });

  it('handles non-JSON error bodies and decommissioned models', async () => {
    const c = client([new Response('<html>bad gateway</html>', { status: 400 })]);
    await expect(c.llm.json(req)).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE', message: /bad gateway/ });
    const d = client([json({ error: { code: 'model_decommissioned', message: 'gone' } }, 400), ok('{"answer":6}')]);
    await expect(d.llm.json(req)).resolves.toEqual({ answer: 6 });
    expect(d.bodies.map((b) => b.model)).toEqual(['m1', 'm2']);
  });

  it('does not retry a 400 for non-reasoning models even if it mentions a property', async () => {
    const c = client([json({ error: { message: 'property foo is unsupported' } }, 400)]);
    await expect(c.llm.json(req)).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
  });

  it('429: uses the "try again in" hint, gives up on very long waits or after max attempts', async () => {
    const c = client([json({ error: { message: 'Rate limit. Please try again in 1.5s.' } }, 429), ok('{"answer":7}')]);
    await c.llm.json(req);
    expect(c.waits).toContain(1750);
    const long = client([json({ error: { message: 'slow down' } }, 429, { 'retry-after': '600' })]);
    await expect(long.llm.json(req)).rejects.toMatchObject({ code: 'LLM_RATE_LIMITED' });
    const many = client([json({}, 429), json({}, 429)], { maxAttempts: 2 });
    await expect(many.llm.json(req)).rejects.toMatchObject({ code: 'LLM_RATE_LIMITED', message: /HTTP 429/ });
  });

  it('a JSON-mode rejection without a failed generation is repaired as empty output; 403 means bad key', async () => {
    const c = client([json({ error: { code: 'json_validate_failed' } }, 400), ok('{"answer":8}')]);
    await expect(c.llm.json(req)).resolves.toEqual({ answer: 8 });
    const d = client([json({ error: { message: 'forbidden' } }, 403)]);
    await expect(d.llm.json(req)).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
  });

  it('a failed call does not block the next one', async () => {
    const c = client([json({ error: { message: 'x' } }, 401), ok('{"answer":9}')]);
    await expect(c.llm.json(req)).rejects.toBeTruthy();
    await expect(c.llm.json(req)).resolves.toEqual({ answer: 9 });
  });
});
