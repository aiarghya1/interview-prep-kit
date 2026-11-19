/**
 * Groq chat-completions client (OpenAI-compatible) with the failure handling
 * a free tier needs:
 *
 * - TokenBucket paces requests under the tokens-per-minute budget
 * - 429: wait for retry-after / x-ratelimit-reset-* and retry; if the error
 *   says the *daily* budget is gone, fall over to the next configured model
 * - 5xx / network: exponential backoff with jitter
 * - output: JSON mode, lenient parse, zod validation; on failure, send the
 *   validation errors back to the model as a repair turn (bounded)
 */
import { z } from 'zod';
import { parseJsonLoose } from './json.js';
import { parseDurationMs, TokenBucket } from './rate.js';
import { LlmError, type Llm, type LlmEvent, type LlmJsonRequest } from './types.js';

export interface GroqOptions {
  apiKey: string;
  models: string[];
  tokensPerMinute?: number;
  baseUrl?: string;
  maxAttempts?: number;
  repairAttempts?: number;
  timeoutMs?: number;
  onEvent?: (e: LlmEvent) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_GROQ_MODELS = ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.1-8b-instant'];

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GroqLlm implements Llm {
  readonly name: string;
  private modelIndex = 0;
  private readonly bucket: TokenBucket;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Serialise calls: one in flight keeps TPM accounting honest. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: GroqOptions) {
    if (!opts.apiKey) throw new LlmError('LLM_NOT_CONFIGURED', 'GROQ_API_KEY is not set');
    if (!opts.models.length) throw new LlmError('LLM_NOT_CONFIGURED', 'No Groq model configured');
    this.bucket = new TokenBucket(opts.tokensPerMinute ?? 6000);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.name = `groq:${opts.models[0]}`;
  }

  get model(): string {
    return this.opts.models[this.modelIndex]!;
  }

  json<T>(req: LlmJsonRequest<T>): Promise<T> {
    const run = this.queue.then(() => this.jsonNow(req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async jsonNow<T>(req: LlmJsonRequest<T>): Promise<T> {
    const messages: Message[] = [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ];
    const repairs = this.opts.repairAttempts ?? 2;
    let lastIssue = '';
    for (let i = 0; i <= repairs; i++) {
      const content = await this.complete(req, messages);
      let parsed: unknown;
      try {
        parsed = parseJsonLoose(content);
      } catch {
        lastIssue = 'The output was not valid JSON.';
      }
      if (parsed !== undefined) {
        const r = req.schema.safeParse(parsed);
        if (r.success) return r.data;
        lastIssue = r.error.issues
          .slice(0, 8)
          .map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`)
          .join('; ');
      }
      if (i < repairs) {
        this.opts.onEvent?.({ type: 'repair', task: req.task, message: `Invalid output, asking model to repair: ${lastIssue}` });
        messages.push(
          { role: 'assistant', content: content.slice(0, 4000) },
          {
            role: 'user',
            content: `That response did not match the required JSON shape: ${lastIssue}\nReturn the corrected JSON object only.`,
          },
        );
      }
    }
    throw new LlmError('LLM_INVALID_OUTPUT', `${req.task}: model output failed validation (${lastIssue})`);
  }

  private async complete(req: LlmJsonRequest<unknown>, messages: Message[]): Promise<string> {
    const maxTokens = req.maxTokens ?? 1500;
    const estimate = Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 3.5) + maxTokens;
    const maxAttempts = this.opts.maxAttempts ?? 8;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const wait = this.bucket.reserve(estimate);
      if (wait > 0) {
        this.opts.onEvent?.({ type: 'rate_limited', task: req.task, message: `Pacing to stay under the token budget`, waitMs: wait });
        await this.sleep(wait);
      }

      let res: Response;
      try {
        res = await this.fetchImpl(`${this.opts.baseUrl ?? 'https://api.groq.com/openai/v1'}/chat/completions`, {
          method: 'POST',
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: req.temperature ?? 0.2,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
          }),
        });
      } catch (err) {
        if (attempt >= maxAttempts) throw new LlmError('LLM_UNAVAILABLE', `Groq unreachable: ${(err as Error).message}`);
        await this.backoff(req.task, attempt, `network error: ${(err as Error).message}`);
        continue;
      }

      const remaining = Number(res.headers.get('x-ratelimit-remaining-tokens'));
      if (Number.isFinite(remaining) && res.headers.has('x-ratelimit-remaining-tokens')) this.bucket.observeRemaining(remaining);

      if (res.ok) {
        const data = (await res.json()) as any;
        const used = Number(data?.usage?.total_tokens);
        if (Number.isFinite(used)) this.bucket.refund(estimate - used);
        this.opts.onEvent?.({ type: 'call', task: req.task, message: `${this.model} ok (${used || '?'} tokens)` });
        return String(data?.choices?.[0]?.message?.content ?? '');
      }

      const body = await res.text().catch(() => '');
      let errInfo: { message?: string; code?: string; failed_generation?: string } = {};
      try {
        errInfo = (JSON.parse(body) as any)?.error ?? {};
      } catch {
        /* non-JSON error */
      }

      if (res.status === 429) {
        const perDay = /per day|TPD|RPD/i.test(errInfo.message ?? '');
        if (perDay && this.modelIndex < this.opts.models.length - 1) {
          const from = this.model;
          this.modelIndex += 1;
          this.opts.onEvent?.({ type: 'model_fallback', task: req.task, message: `Daily limit on ${from}; switching to ${this.model}` });
          continue;
        }
        const waitMs =
          parseDurationMs(res.headers.get('retry-after')) ??
          parseDurationMs(res.headers.get('x-ratelimit-reset-tokens')) ??
          parseDurationMs((errInfo.message ?? '').match(/try again in ([\d.ms]+)/i)?.[1]) ??
          2000 * attempt;
        if (perDay || attempt >= maxAttempts || waitMs > 120_000) {
          throw new LlmError('LLM_RATE_LIMITED', `Groq rate limit: ${errInfo.message ?? 'HTTP 429'}`);
        }
        this.opts.onEvent?.({ type: 'rate_limited', task: req.task, message: 'Provider asked us to slow down', waitMs });
        await this.sleep(waitMs + 250);
        continue;
      }

      // JSON mode failure: Groq rejects the generation; treat it as bad output to repair.
      if (res.status === 400 && errInfo.code === 'json_validate_failed') {
        return errInfo.failed_generation ?? '';
      }
      if (res.status >= 500 && attempt < maxAttempts) {
        await this.backoff(req.task, attempt, `HTTP ${res.status}`);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new LlmError('LLM_NOT_CONFIGURED', `Groq rejected the API key (HTTP ${res.status})`);
      throw new LlmError('LLM_UNAVAILABLE', `Groq HTTP ${res.status}: ${errInfo.message ?? body.slice(0, 200)}`);
    }
  }

  private async backoff(task: string, attempt: number, why: string) {
    const ms = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
    this.opts.onEvent?.({ type: 'retry', task, message: `Retrying after ${why}`, waitMs: ms });
    await this.sleep(ms);
  }
}

/** Build the configured LLM from environment variables. */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env, onEvent?: (e: LlmEvent) => void): Llm {
  const models = (env.GROQ_MODELS ?? env.GROQ_MODEL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new GroqLlm({
    apiKey: env.GROQ_API_KEY ?? '',
    models: models.length ? models : DEFAULT_GROQ_MODELS,
    tokensPerMinute: Number(env.GROQ_TPM) > 0 ? Number(env.GROQ_TPM) : 6000,
    onEvent,
  });
}

