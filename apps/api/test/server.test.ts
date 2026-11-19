import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { start } from '../src/server.js';

let mongo: MongoMemoryServer;
const saved = { ...process.env };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
});
afterAll(async () => {
  process.env = saved;
  await mongo.stop();
});

describe('server start()', () => {
  it('boots from environment defaults, serves requests, runs jobs with the default model client, and stops cleanly', async () => {
    process.env = { ...saved, NODE_ENV: 'test', PORT: '0', MONGODB_URI: mongo.getUri(), JWT_SECRET: 'z'.repeat(40) };
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_MODELS;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { port, stop } = await start();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/API listening on :\d+ \(test\)/));
    log.mockRestore();

    const base = `http://127.0.0.1:${port}/api`;
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });

    const reg = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 's@example.com', password: 'password123' }) });
    const cookie = reg.headers.get('set-cookie')!.split(';')[0]!;
    const created = await (
      await fetch(`${base}/kits`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ jd: 'Frontend developer wanted. Must know React.', company_url: 'example.invalid', days: 1 }) })
    ).json();
    let status: { status: string; error: { code: string } | null } = { status: 'queued', error: null };
    for (let i = 0; i < 50 && (status.status === 'queued' || status.status === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await (await fetch(`${base}/kits/${created.kit.id}/status`, { headers: { cookie } })).json();
    }
    // No key configured: the default client refuses, and the kit says why.
    expect(status).toMatchObject({ status: 'failed', error: { code: 'LLM_NOT_CONFIGURED' } });
    await stop();
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });

  it('accepts explicit config, job dependencies and logger', async () => {
    const lines: string[] = [];
    const { stop } = await start(
      { NODE_ENV: 'test', PORT: 0, MONGODB_URI: mongo.getUri(), JWT_SECRET: 'z'.repeat(40), SESSION_TTL_HOURS: 1, JOB_TIMEOUT_MS: 1000, MAX_ACTIVE_JOBS_PER_USER: 1, cookieSecure: false },
      { concurrency: 2 },
      (m) => lines.push(m),
    );
    expect(lines[0]).toMatch(/listening/);
    await stop();
  });
});
