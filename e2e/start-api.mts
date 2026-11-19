/**
 * API for end-to-end tests: the real server (start()), real MongoDB (in
 * memory), real crawler against the fixture company sites, but the scripted
 * model, so runs are deterministic and need no API key.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Fetcher } from '@kit/core';
import { start } from '../apps/api/src/server.js';
import { startFixtureServer } from '../packages/core/fixtures/serve.js';
import { FakeLlm } from '../packages/core/test/fakeLlm.js';

const mongo = await MongoMemoryServer.create();
await startFixtureServer(8199);
await start(
  { NODE_ENV: 'test', PORT: 4199, MONGODB_URI: mongo.getUri(), JWT_SECRET: 'e2e'.repeat(12), SESSION_TTL_HOURS: 1, JOB_TIMEOUT_MS: 60_000, MAX_ACTIVE_JOBS_PER_USER: 10, cookieSecure: false },
  {
    createLlm: () => new FakeLlm(),
    fetcher: new Fetcher({ policy: { allowPrivate: true }, minIntervalMs: 0, timeoutMs: 3000, retries: 0 }),
    search: async () => ({ items: [], searched: [], skipped: [] }),
  },
);
