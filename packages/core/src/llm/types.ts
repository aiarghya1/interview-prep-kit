import type { z } from 'zod';

export interface LlmJsonRequest<T> {
  /** Stable name of the step, used for logs, progress and test fakes. */
  task: string;
  system: string;
  user: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmEvent {
  type: 'rate_limited' | 'retry' | 'repair' | 'model_fallback' | 'call';
  task: string;
  message: string;
  waitMs?: number;
}

/** The only thing pipeline steps know about a model. */
export interface Llm {
  readonly name: string;
  json<T>(req: LlmJsonRequest<T>): Promise<T>;
}

export type LlmErrorCode = 'LLM_NOT_CONFIGURED' | 'LLM_UNAVAILABLE' | 'LLM_RATE_LIMITED' | 'LLM_INVALID_OUTPUT';

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
