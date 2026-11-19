/**
 * Batch entry point (brief, Section 9):
 *   npm run evaluate -- --input cases.json --output kits.json
 *
 * Runs the same generateKit() the API uses, one case at a time (the LLM
 * budget is shared, so parallel cases would only fight over it). Writes the
 * output file after every case, so a crash still leaves completed results.
 * A failing case is recorded and the run continues.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BatchCaseSchema, type BatchOutput, type BatchResult, type Kit } from '../schema.js';
import { generateKit, PipelineError } from '../pipeline.js';
import { Fetcher } from '../retrieval/fetcher.js';
import { llmFromEnv } from '../llm/groq.js';
import { LlmError, type Llm } from '../llm/types.js';
import { rescheduleKit } from '../reschedule.js';

const TOTAL_BUDGET_MS = Number(process.env.EVAL_TOTAL_BUDGET_MS) || 14 * 60_000;
const MAX_CASE_MS = Number(process.env.EVAL_CASE_BUDGET_MS) || 170_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.split('=').slice(1).join('=');
}

const log = (msg: string) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

function errorOf(err: unknown): { code: string; message: string } {
  if (err instanceof PipelineError || err instanceof LlmError) return { code: err.code, message: err.message };
  return { code: 'INTERNAL', message: (err as Error)?.message ?? String(err) };
}

async function writeAtomic(path: string, data: unknown) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

async function main() {
  const input = arg('input');
  const output = arg('output');
  if (!input || !output) {
    console.error('Usage: npm run evaluate -- --input <cases.json> --output <kits.json>');
    process.exit(2);
  }
  const inPath = resolve(process.env.INIT_CWD ?? process.cwd(), input);
  const outPath = resolve(process.env.INIT_CWD ?? process.cwd(), output);

  let cases: unknown;
  try {
    cases = JSON.parse(await readFile(inPath, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${inPath}: ${(err as Error).message}`);
    process.exit(2);
  }
  if (!Array.isArray(cases)) {
    console.error('Input must be a JSON array of cases');
    process.exit(2);
  }

  const out: BatchOutput = { version: '1.0', generated_at: new Date().toISOString(), kits: [] };
  const started = Date.now();

  let llm: Llm | null = null;
  let llmError: { code: string; message: string } | null = null;
  try {
    llm = llmFromEnv(process.env, (e) => {
      if (e.type !== 'call') log(`  llm ${e.type} [${e.task}] ${e.message}${e.waitMs ? ` (${Math.round(e.waitMs / 1000)}s)` : ''}`);
    });
  } catch (err) {
    llmError = errorOf(err);
    log(`LLM not configured: ${llmError.message}`);
  }

  // Batch cases may point at local fixture sites, so private addresses are allowed
  // here unless explicitly disabled.
  const fetcher = new Fetcher({
    policy: { allowPrivate: process.env.ALLOW_PRIVATE_URLS !== 'false' },
    minIntervalMs: Number(process.env.CRAWL_MIN_INTERVAL_MS) || 300,
    timeoutMs: 8000,
    retries: 2,
  });
  const cache = new Map<string, Kit>();

  for (let i = 0; i < cases.length; i++) {
    const raw = cases[i] as { id?: unknown };
    const id = typeof raw?.id === 'string' && raw.id ? raw.id : `case-${i + 1}`;
    const parsed = BatchCaseSchema.safeParse(raw);
    let result: BatchResult;

    if (!parsed.success) {
      result = { id, status: 'failed', kit: null, error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') } };
    } else if (!llm) {
      result = { id, status: 'failed', kit: null, error: llmError! };
    } else {
      const c = parsed.data;
      const remainingCases = cases.length - i;
      const budget = Math.min(MAX_CASE_MS, (TOTAL_BUDGET_MS - (Date.now() - started)) / remainingCases);
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
