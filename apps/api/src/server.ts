import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import { Fetcher, defaultUrlPolicy, llmFromEnv } from '@kit/core';
import { loadConfig, type Config } from './config.js';
import { createApp } from './app.js';
import { JobRunner, type JobDeps } from './jobs/runner.js';

/** Boot the API: connect, recover interrupted jobs, listen. Returns a stop() for graceful shutdown. */
export async function start(
  config: Config = loadConfig(),
  jobDeps: Partial<JobDeps> = {},
  log: (m: string) => void = console.log,
): Promise<{ server: Server; port: number; stop: () => Promise<void> }> {
  await mongoose.connect(config.MONGODB_URI);
  const runner = new JobRunner({
    createLlm: (onEvent) => llmFromEnv(process.env, onEvent),
    // Production blocks private/loopback targets (SSRF); see ALLOW_PRIVATE_URLS.
    fetcher: new Fetcher({ policy: defaultUrlPolicy(), minIntervalMs: 750 }),
    timeoutMs: config.JOB_TIMEOUT_MS,
    ...jobDeps,
  });
  await runner.recover();
  const app = createApp(config, runner);
  const server = await new Promise<Server>((ok) => {
    const s = app.listen(config.PORT, () => ok(s));
  });
  const port = (server.address() as { port: number }).port;
  log(`API listening on :${port} (${config.NODE_ENV})`);
  const stop = async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    await runner.idle();
    await mongoose.disconnect();
  };
  return { server, port, stop };
}

// Entry point when run as a script (not when imported by tests).
/* v8 ignore start */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // Local dev: read the repo-root .env (hosted environments set real env vars).
  loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
  start()
    .then(({ stop }) => {
      const shutdown = () => stop().then(() => process.exit(0));
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
/* v8 ignore stop */
