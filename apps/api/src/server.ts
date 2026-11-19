import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { Fetcher, defaultUrlPolicy, llmFromEnv } from '@kit/core';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { JobRunner } from './jobs/runner.js';

// Local dev: read the repo-root .env (hosted environments set real env vars).
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

async function main() {
  const config = loadConfig();
  await mongoose.connect(config.MONGODB_URI);
  const runner = new JobRunner({
    createLlm: (onEvent) => llmFromEnv(process.env, onEvent),
    // Production blocks private/loopback targets (SSRF); see ALLOW_PRIVATE_URLS.
    fetcher: new Fetcher({ policy: defaultUrlPolicy(), minIntervalMs: 750 }),
    timeoutMs: config.JOB_TIMEOUT_MS,
  });
  await runner.recover();
  const app = createApp(config, runner);
  const server = app.listen(config.PORT, () => console.log(`API listening on :${config.PORT} (${config.NODE_ENV})`));

  const shutdown = async () => {
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
