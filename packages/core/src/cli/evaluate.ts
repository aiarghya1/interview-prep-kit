/**
 * Batch entry point (brief, Section 9):
 *   npm run evaluate -- --input cases.json --output kits.json
 *
 * Runs the same runPipeline() the API uses, one case at a time (the LLM
 * budget is shared, so parallel cases would only fight over it). Writes the
 * output file after every case, so a crash still leaves completed results.
 * A failing case is recorded and the run continues.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BatchCaseSchema, type BatchOutput, type BatchResult, type Kit } from '../schema.js';
import { generateKit, PipelineError, type PipelineDeps } from '../pipeline.js';
import { Fetcher } from '../retrieval/fetcher.js';
import { llmFromEnv } from '../llm/groq.js';
import { LlmError, type Llm, type LlmEvent } from '../llm/types.js';
import { rescheduleKit } from '../reschedule.js';

export interface EvaluateDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  log: (msg: string) => void;
  createLlm: (env: NodeJS.ProcessEnv, onEvent: (e: LlmEvent) => void) => Llm;
  createFetcher: (env: NodeJS.ProcessEnv) => Fetcher;
  search?: PipelineDeps['search'];
}

export function parseArgs(argv: string[]): { input?: string; output?: string } {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) return argv[i + 1];
    return argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  };
  return { input: get('input'), output: get('output') };
}

export function errorOf(err: unknown): { code: string; message: string } {
  if (err instanceof PipelineError || err instanceof LlmError) return { code: err.code, message: err.message };
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
}

async function writeAtomic(path: string, data: unknown) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

export const defaultDeps = (): EvaluateDeps => ({
  env: process.env,
  cwd: process.env.INIT_CWD ?? process.cwd(),
  log: (msg) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`),
  createLlm: (env, onEvent) => llmFromEnv(env, onEvent),
  // Batch cases may point at local fixture sites, so private addresses are
  // allowed here unless explicitly disabled.
  createFetcher: (env) =>
    new Fetcher({
      policy: { allowPrivate: env.ALLOW_PRIVATE_URLS !== 'false' },
      minIntervalMs: Number(env.CRAWL_MIN_INTERVAL_MS) || 300,
      timeoutMs: 8000,
      retries: 2,
    }),
});

/** Returns the process exit code: 0 when the output was written (even if cases failed), 2 on usage errors. */
export async function main(argv: string[], deps: EvaluateDeps = defaultDeps()): Promise<number> {
  const { input, output } = parseArgs(argv);
  const { env, log } = deps;
  if (!input || !output) {
    log('Usage: npm run evaluate -- --input <cases.json> --output <kits.json>');
    return 2;
  }
  const inPath = resolve(deps.cwd, input);
  const outPath = resolve(deps.cwd, output);

  let cases: unknown;
  try {
    cases = JSON.parse(await readFile(inPath, 'utf8'));
  } catch (err) {
    log(`Could not read ${inPath}: ${(err as Error).message}`);
    return 2;
  }
  if (!Array.isArray(cases)) {
    log('Input must be a JSON array of cases');
    return 2;
  }

  const totalBudget = Number(env.EVAL_TOTAL_BUDGET_MS) || 14 * 60_000;
  const maxCase = Number(env.EVAL_CASE_BUDGET_MS) || 170_000;
  const out: BatchOutput = { version: '1.0', generated_at: new Date().toISOString(), kits: [] };
  const started = Date.now();

  let llm: Llm | null = null;
  let llmError: { code: string; message: string } | null = null;
  try {
    llm = deps.createLlm(env, (e) => {
      if (e.type !== 'call') log(`  llm ${e.type} [${e.task}] ${e.message}${e.waitMs ? ` (${Math.round(e.waitMs / 1000)}s)` : ''}`);
    });
  } catch (err) {
    llmError = errorOf(err);
    log(`LLM not configured: ${llmError.message}`);
  }

  const fetcher = deps.createFetcher(env);
  const cache = new Map<string, Kit>();

  for (let i = 0; i < cases.length; i++) {
    const raw = cases[i] as { id?: unknown } | null;
    const id = typeof raw?.id === 'string' && raw.id ? raw.id : `case-${i + 1}`;
    const parsed = BatchCaseSchema.safeParse(raw);
    let result: BatchResult;

    if (!parsed.success) {
      result = { id, status: 'failed', kit: null, error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') } };
    } else if (!llm) {
      result = { id, status: 'failed', kit: null, error: llmError! };
    } else {
      const c = parsed.data;
      const budget = Math.min(maxCase, (totalBudget - (Date.now() - started)) / (cases.length - i));
      const key = createHash('sha256').update(`${c.jd.trim()}\n${c.company_url.trim().toLowerCase()}`).digest('hex');
      const t0 = Date.now();
      log(`case ${id}: ${c.company_url} (${c.days} days, budget ${Math.round(budget / 1000)}s)`);
      try {
        const cached = cache.get(key);
        const kit = cached
          ? rescheduleKit(cached, c.days)
          : await generateKit(
              { jd: c.jd, company_url: c.company_url, days: c.days },
              {
                llm,
                fetcher,
                search: deps.search,
                deadline: Date.now() + budget,
                onProgress: (e) => {
                  if (e.status !== 'running' || e.step === 'crawl' || e.step === 'coverage') log(`  ${e.step} ${e.status}: ${e.message}`);
                },
              },
            );
        if (cached) log('  duplicate of an earlier case: reused research, rebuilt schedule');
        cache.set(key, kit);
        result = { id, status: 'ok', kit, error: null };
        log(`case ${id}: ok in ${Math.round((Date.now() - t0) / 1000)}s — ${kit.role.requirements.length} reqs, ${kit.questions.length} questions, uncovered: ${kit.coverage.uncovered_requirement_ids.join(',') || 'none'}`);
      } catch (err) {
        result = { id, status: 'failed', kit: null, error: errorOf(err) };
        log(`case ${id}: FAILED ${result.error.code}: ${result.error.message}`);
      }
    }
    out.kits.push(result);
    out.generated_at = new Date().toISOString();
    await writeAtomic(outPath, out);
  }

  const ok = out.kits.filter((k) => k.status === 'ok').length;
  log(`done: ${ok}/${out.kits.length} ok in ${Math.round((Date.now() - started) / 1000)}s -> ${outPath}`);
  return 0;
}

// Entry point when run as a script (not when imported by tests).
/* v8 ignore next 3 */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => (console.error(err), process.exit(1)));
}
