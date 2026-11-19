/**
 * Failure paths and edge cases of the API, job runner and kit store, against
 * a real (in-memory) MongoDB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Fetcher, type Kit, type LlmEvent } from '@kit/core';
import { startFixtureServer } from '../../../packages/core/fixtures/serve.js';
import { FakeLlm } from '../../../packages/core/test/fakeLlm.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { JobRunner } from '../src/jobs/runner.js';
import { KitModel, User } from '../src/db/models.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { updateKitWithRetry } from '../src/kits/store.js';

let mongo: MongoMemoryServer;
let fixtures: Server;
let origin: string;
let llm: FakeLlm;
let llmFactory: (onEvent: (e: LlmEvent) => void) => FakeLlm;
const testConfig = loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'y'.repeat(40) } as NodeJS.ProcessEnv);
const runner = new JobRunner({
  createLlm: (onEvent) => llmFactory(onEvent),
  fetcher: new Fetcher({ policy: { allowPrivate: true }, minIntervalMs: 0, timeoutMs: 2000, retries: 0 }),
  search: async () => ({ items: [], searched: [], skipped: [] }),
  timeoutMs: 60_000,
});
const app = createApp(testConfig, runner);

const JD = 'Backend Engineer\n\nRequirements:\n- Node.js and TypeScript\n- PostgreSQL\n- Mentoring engineers';

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ server: fixtures, origin } = await startFixtureServer(0));
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  fixtures.close();
});
beforeEach(async () => {
  llm = new FakeLlm();
  llmFactory = () => llm;
  await KitModel.deleteMany({});
  await User.deleteMany({});
});

async function signUp(a: ReturnType<typeof createApp> = app, email = 'e@example.com') {
  const agent = request.agent(a);
  const res = await agent.post('/api/auth/register').send({ email, password: 'correct horse' }).expect(201);
  return { agent, userId: res.body.user.id as string };
}
async function readyKit(agent: ReturnType<typeof request.agent>) {
  const res = await agent.post('/api/kits').send({ jd: JD, company_url: `${origin}/acme/`, days: 3 }).expect(202);
  await runner.idle();
  return (await agent.get(`/api/kits/${res.body.kit.id}`).expect(200)).body;
}
const queuedDoc = (userId: string, extra: Record<string, unknown> = {}) =>
  KitModel.create({ userId, status: 'queued', input: { jd: JD, company_url: 'x', days: 2 }, inputHash: Math.random().toString(), title: 'Q', ...extra });

describe('auth edges', () => {
  it('rate-limits auth attempts outside tests', async () => {
    const devApp = createApp({ ...testConfig, NODE_ENV: 'development' }, runner);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await request(devApp).post('/api/auth/login').send({ email: 'x@example.com', password: 'whatever1' })).status;
    expect(last).toBe(429);
  });
  it('rejects unknown emails like wrong passwords, deleted accounts and tokens without a subject', async () => {
    expect((await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'whatever1' }).expect(401)).body.error.code).toBe('INVALID_CREDENTIALS');
    const { agent } = await signUp();
    await User.deleteMany({});
    expect((await agent.get('/api/auth/me').expect(401)).body.error.code).toBe('INVALID_SESSION');
    const noSub = jwt.sign({ foo: 1 }, testConfig.JWT_SECRET);
    expect((await request(app).get('/api/kits').set('Cookie', `${SESSION_COOKIE}=${noSub}`).expect(401)).body.error.code).toBe('INVALID_SESSION');
  });
  it('unknown API routes return structured 404s', async () => {
    expect((await request(app).get('/api/nope').expect(404)).body.error.code).toBe('NOT_FOUND');
  });
});

describe('kit route edges', () => {
  it('rate-limits kit creation per user outside tests', async () => {
    const devApp = createApp({ ...testConfig, NODE_ENV: 'development' }, runner);
    const { agent } = await signUp(devApp);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await agent.post('/api/kits').send({})).status;
    expect(last).toBe(429);
  });

  it('caps active generations per user, in single and batch creation', async () => {
    const { agent, userId } = await signUp();
    for (let i = 0; i < 6; i++) await queuedDoc(userId);
    expect((await agent.post('/api/kits').send({ jd: JD, company_url: 'acme.com', days: 2 }).expect(429)).body.error.code).toBe('TOO_MANY_ACTIVE');
    const batch = await agent.post('/api/kits/batch').send({ items: [{ jd: `${JD} 1`, company_url: 'a.com', days: 2 }] }).expect(202);
    expect(batch.body.results[0].error.code).toBe('TOO_MANY_ACTIVE');
  });

  it('reports unexpected batch failures as INTERNAL without failing the batch', async () => {
    const { agent } = await signUp();
    const spy = vi.spyOn(KitModel, 'countDocuments').mockRejectedValueOnce(new Error('db hiccup'));
    const batch = await agent.post('/api/kits/batch').send({ items: [{ jd: JD, company_url: 'a.com', days: 2 }] }).expect(202);
    expect(batch.body.results[0].error).toEqual({ code: 'INTERNAL', message: 'db hiccup' });
    spy.mockRestore();
  });

  it('guards actions on kits that are not ready, or not retryable, or gone', async () => {
    const { agent, userId } = await signUp();
    const q = await queuedDoc(userId);
    const id = String(q._id);
    expect((await agent.get(`/api/kits/${id}/practice`).expect(409)).body.error.code).toBe('KIT_NOT_READY');
    expect((await agent.patch(`/api/kits/${id}`).send({ ops: [{ op: 'question.delete', id: 'q1' }] }).expect(409)).body.error.code).toBe('KIT_NOT_READY');
    expect((await agent.post(`/api/kits/${id}/regenerate`).send({ section: 'brief' }).expect(409)).body.error.code).toBe('KIT_NOT_READY');
    expect((await agent.post(`/api/kits/${id}/retry`).send({}).expect(409)).body.error.code).toBe('NOT_RETRYABLE');
    await agent.delete(`/api/kits/${id}`).expect(204);
    await agent.delete(`/api/kits/${id}`).expect(404);
    await agent.get(`/api/kits/${id}/status`).expect(404);
    expect((await agent.put('/api/kits/64b7f0c2a1b2c3d4e5f60718/stories').send({ stories: [] }).expect(404)).body.error.code).toBe('NOT_FOUND');
  });

  it('pins without marking the schedule stale; practice view and repeated reviews', async () => {
    const { agent } = await signUp();
    const kit = await readyKit(agent);
    const r = await agent.patch(`/api/kits/${kit.id}`).send({ ops: [{ op: 'pin', target: 'brief', pinned: true }] }).expect(200);
    expect(r.body.scheduleStale).toBe(false);
    const f1 = kit.kit.flashcards[0].id;
    await agent.post(`/api/kits/${kit.id}/practice`).send({ cardId: f1, confidence: 3 }).expect(200);
    const again = await agent.post(`/api/kits/${kit.id}/practice`).send({ cardId: f1, confidence: 3 }).expect(200);
    expect(again.body.progress[f1]).toMatchObject({ box: 2, reviews: 2 });
    await KitModel.updateOne({ _id: kit.id }, { $set: { [`practice.junk`]: { nope: true } } });
    const view = await agent.get(`/api/kits/${kit.id}/practice`).expect(200);
    expect(view.body.progress).not.toHaveProperty('junk');
    const status = await agent.get(`/api/kits/${kit.id}/status`).expect(200);
    expect(status.body).toMatchObject({ error: null, regen: null });
  });
});

describe('job runner', () => {
  it('recovers after a restart: re-queues interrupted generations, fails interrupted regenerations', async () => {
    const { userId } = await signUp();
    const running = await queuedDoc(userId, { status: 'running' });
    const regen = await queuedDoc(userId, { status: 'ready', regen: { section: 'brief', status: 'running' } });
    await runner.recover();
    await runner.idle();
    expect((await KitModel.findById(running._id).lean())!.status).toBe('ready');
    expect((await KitModel.findById(regen._id).lean())!.regen).toMatchObject({ status: 'failed', message: expect.stringMatching(/restart/) });
  });

  it('records provider waits as progress, and ignores jobs that are no longer queued', async () => {
    llmFactory = (onEvent) => {
      onEvent({ type: 'rate_limited', task: 'x', message: 'Provider asked us to slow down', waitMs: 2500 });
      onEvent({ type: 'repair', task: 'x', message: 'Repairing' });
      onEvent({ type: 'call', task: 'x', message: 'ok' });
      return llm;
    };
    const { agent } = await signUp();
    const kit = await readyKit(agent);
    const llmSteps = kit.progress.filter((p: { step: string }) => p.step === 'llm').map((p: { message: string }) => p.message);
    expect(llmSteps).toEqual(['Provider asked us to slow down (waiting 3s)', 'Repairing']);
    runner.enqueue({ kind: 'generate', kitId: kit.id });
    await runner.idle();
    expect((await KitModel.findById(kit.id).lean())!.version).toBe(kit.version);
  });

  it('names untitled roles, and records errors without a code as INTERNAL', async () => {
    const { agent } = await signUp();
    const real = llm.json.bind(llm);
    llm.json = (async (r) => (r.task === 'extract_requirements' ? { ...(await real(r)), title: '' } : real(r))) as FakeLlm['json'];
    const kit = await readyKit(agent);
    expect(kit.title).toBe('Untitled role');
    llmFactory = () => { throw new Error('factory exploded'); };
    const res = await agent.post('/api/kits').send({ jd: `${JD}\n- Kafka`, company_url: `${origin}/acme/`, days: 2 }).expect(202);
    await runner.idle();
    expect((await agent.get(`/api/kits/${res.body.kit.id}/status`)).body.error).toEqual({ code: 'INTERNAL', message: 'factory exploded' });
  });

  it('regeneration: flashcards, brief without stored research, failures, and gap-filling', async () => {
    const { agent } = await signUp();
    const kit = await readyKit(agent);
    const regen = async (section: string) => {
      await agent.post(`/api/kits/${kit.id}/regenerate`).send({ section }).expect(202);
      await runner.idle();
      return (await agent.get(`/api/kits/${kit.id}`)).body;
    };
    expect((await regen('flashcards')).regen).toMatchObject({ status: 'done', section: 'flashcards' });
    expect((await agent.get(`/api/kits/${kit.id}/status`)).body.regen).toMatchObject({ status: 'done', section: 'flashcards' });

    await KitModel.updateOne({ _id: kit.id }, { $unset: { corpus: 1 } });
    const b = await regen('brief');
    expect(b.kit.company_brief.summary).toMatch(/No reliable information/);

    llm.failTasks = new Set(['flashcards']);
    expect((await regen('flashcards')).regen).toMatchObject({ status: 'failed', message: expect.stringMatching(/fake failure/) });
    llm.failTasks = new Set();

    // A model whose regenerated questions cover nothing forces the code-side gap check to act.
    const real = llm.json.bind(llm);
    llm.json = (async (r) => {
      if (r.task === 'questions_technical') {
        llm.calls.push({ task: r.task, system: r.system, user: r.user });
        return r.schema.parse({ questions: [{ prompt: 'A question about nothing in particular', answer_outline: '', difficulty: 2, requirement_ids: [] }] });
      }
      return real(r);
    }) as FakeLlm['json'];
    const before = llm.calls.length;
    const t = await regen('questions:technical');
    expect(llm.calls.slice(before).map((c) => c.task)).toEqual(['questions_technical', 'questions_technical_gap']);
    const must = t.kit.role.requirements.filter((r: { priority: string; kind: string }) => r.priority === 'must' && r.kind === 'technical').map((r: { id: string }) => r.id);
    must.forEach((id: string) => expect(t.kit.coverage.uncovered_requirement_ids).not.toContain(id));

    llm.failTasks = new Set(['questions_technical_gap']);
    expect((await regen('questions:technical')).regen.status).toBe('done');
  });

  it('the schedule is never regenerated as a background job; missing kits are skipped', async () => {
    const { agent, userId } = await signUp();
    const kit = await readyKit(agent);
    await KitModel.updateOne({ _id: kit.id }, { $set: { regen: { section: 'schedule', status: 'running' } } });
    runner.enqueue({ kind: 'regenerate', kitId: kit.id, section: 'schedule' });
    const q = await queuedDoc(userId);
    runner.enqueue({ kind: 'regenerate', kitId: String(q._id), section: 'brief' });
    await runner.idle();
    expect((await KitModel.findById(kit.id).lean())!.regen).toMatchObject({ status: 'failed', message: expect.stringMatching(/synchronously/) });
  });
});

describe('kit store', () => {
  it('rejects mutations that would leave the kit invalid', async () => {
    const { agent } = await signUp();
    const kit = await readyKit(agent);
    await expect(updateKitWithRetry(kit.id, undefined, (d) => ({ kit: { ...d.kit, questions: [...d.kit.questions, d.kit.questions[0]!] } }))).rejects.toMatchObject({ code: 'KIT_INVALID' });
  });
  it('re-applies on concurrent writes, and gives up with CONFLICT if it never settles', async () => {
    const { agent } = await signUp();
    const kit = await readyKit(agent);
    // Simulate losing the version race deterministically (no un-awaited writes):
    // the guarded update reports "nothing modified", as it would after a concurrent write.
    const lost = { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null } as const;
    const once = vi.spyOn(KitModel, 'updateOne').mockResolvedValueOnce(lost as never);
    let attempts = 0;
    const ok = await updateKitWithRetry(kit.id, undefined, (d) => (attempts++, { kit: d.kit as Kit }));
    expect(attempts).toBe(2); // re-read and re-applied after losing the race
    expect(ok.version).toBe(kit.version + 1);
    once.mockRestore();

    const always = vi.spyOn(KitModel, 'updateOne').mockResolvedValue(lost as never);
    await expect(updateKitWithRetry(kit.id, undefined, (d) => ({ kit: d.kit as Kit }))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(always).toHaveBeenCalledTimes(6);
    always.mockRestore();
  });
});
