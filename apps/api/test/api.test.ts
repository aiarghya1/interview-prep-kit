import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Fetcher, validateKit } from '@kit/core';
import { startFixtureServer } from '../../../packages/core/fixtures/serve.js';
import { FakeLlm } from '../../../packages/core/test/fakeLlm.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { JobRunner } from '../src/jobs/runner.js';
import { KitModel, User } from '../src/db/models.js';
import { SESSION_COOKIE } from '../src/auth/session.js';

let mongo: MongoMemoryServer;
let fixtures: Server;
let origin: string;
let llm: FakeLlm;
const config = loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv);
const runner = new JobRunner({
  createLlm: () => llm,
  fetcher: new Fetcher({ policy: { allowPrivate: true }, minIntervalMs: 0, timeoutMs: 2000, retries: 0 }),
  search: async () => ({ items: [], searched: [], skipped: [] }),
  timeoutMs: 60_000,
});
const app = createApp(config, runner);

const JD = `Senior Backend Engineer

Requirements:
- 5+ years of backend development
- Node.js and TypeScript
- Experience mentoring engineers

Nice to have:
- Kubernetes`;

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
  await KitModel.deleteMany({});
  await User.deleteMany({});
});

async function signUp(email = 'a@example.com') {
  const agent = request.agent(app);
  await agent.post('/api/auth/register').send({ email, password: 'correct horse' }).expect(201);
  return agent;
}

async function readyKit(agent: ReturnType<typeof request.agent>, days = 3) {
  const res = await agent.post('/api/kits').send({ jd: JD, company_url: `${origin}/acme/`, days }).expect(202);
  await runner.idle();
  const kit = await agent.get(`/api/kits/${res.body.kit.id}`).expect(200);
  expect(kit.body.status).toBe('ready');
  return kit.body;
}

describe('auth', () => {
  it('register, me, logout, login', async () => {
    const agent = await signUp();
    expect((await agent.get('/api/auth/me').expect(200)).body.user.email).toBe('a@example.com');
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);
    await agent.post('/api/auth/login').send({ email: 'A@example.com', password: 'wrong password' }).expect(401);
    await agent.post('/api/auth/login').send({ email: 'A@example.com', password: 'correct horse' }).expect(200);
  });

  it('rejects duplicate email and weak input with structured errors', async () => {
    await signUp();
    const dup = await request(app).post('/api/auth/register').send({ email: 'a@example.com', password: 'correct horse' }).expect(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    const bad = await request(app).post('/api/auth/register').send({ email: 'nope', password: 'short' }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('distinguishes missing, expired and tampered sessions', async () => {
    expect((await request(app).get('/api/kits').expect(401)).body.error.code).toBe('UNAUTHENTICATED');
    const expired = jwt.sign({ sub: new mongoose.Types.ObjectId().toString() }, config.JWT_SECRET, { expiresIn: -10 });
    const r1 = await request(app).get('/api/kits').set('Cookie', `${SESSION_COOKIE}=${expired}`).expect(401);
    expect(r1.body.error.code).toBe('SESSION_EXPIRED');
    expect(r1.headers['set-cookie']?.[0]).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
    const forged = jwt.sign({ sub: 'x' }, 'another-secret-that-is-long-enough-123');
    expect((await request(app).get('/api/kits').set('Cookie', `${SESSION_COOKIE}=${forged}`).expect(401)).body.error.code).toBe('INVALID_SESSION');
  });
});

describe('kits', () => {
  it('generates a kit in the background with visible progress', async () => {
    const agent = await signUp();
    const res = await agent.post('/api/kits').send({ jd: JD, company_url: `${origin}/acme/`, days: 4 }).expect(202);
    expect(res.body.kit.status).toBe('queued');
    await runner.idle();
    const status = await agent.get(`/api/kits/${res.body.kit.id}/status`).expect(200);
    expect(status.body.status).toBe('ready');
    expect(status.body.progress.map((p: { step: string }) => p.step)).toEqual(expect.arrayContaining(['extract', 'crawl', 'coverage', 'schedule']));
    const full = await agent.get(`/api/kits/${res.body.kit.id}`).expect(200);
    expect(validateKit(full.body.kit).ok).toBe(true);
    expect(full.body.kit.schedule.days).toHaveLength(4);
    expect(full.body).not.toHaveProperty('corpus');
    const list = await agent.get('/api/kits').expect(200);
    expect(list.body.kits).toHaveLength(1);
  });

  it('users only see their own kits', async () => {
    const a = await signUp('a@example.com');
    const kit = await readyKit(a);
    const b = await signUp('b@example.com');
    await b.get(`/api/kits/${kit.id}`).expect(404);
    await b.patch(`/api/kits/${kit.id}`).send({ ops: [{ op: 'question.delete', id: 'q1' }] }).expect(404);
    await b.delete(`/api/kits/${kit.id}`).expect(404);
    expect((await b.get('/api/kits').expect(200)).body.kits).toEqual([]);
    await b.get('/api/kits/not-an-id').expect(404);
  });

  it('validates input', async () => {
    const agent = await signUp();
    const res = await agent.post('/api/kits').send({ jd: 'short', company_url: '', days: 0 }).expect(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['company_url', 'days', 'jd']);
  });

  it('deduplicates repeat submissions; a different day count reuses research', async () => {
    const agent = await signUp();
    const first = await agent.post('/api/kits').send({ jd: JD, company_url: `${origin}/acme/`, days: 3 }).expect(202);
    const again = await agent.post('/api/kits').send({ jd: `  ${JD}\n`, company_url: `${origin}/acme`, days: 3 }).expect(200);
    expect(again.body).toMatchObject({ deduplicated: 'in_progress', kit: { id: first.body.kit.id } });
    await runner.idle();
    const callsAfterFirst = llm.calls.length;
    const same = await agent.post('/api/kits').send({ jd: JD, company_url: `${origin}/acme/`, days: 3 }).expect(200);
    expect(same.body.deduplicated).toBe('existing');
    const other = await agent.post('/api/kits').send({ jd: JD, company_url: `${origin}/acme/`, days: 10 }).expect(201);
    expect(other.body.deduplicated).toBe('rescheduled');
    expect(llm.calls.length).toBe(callsAfterFirst);
    const k = await agent.get(`/api/kits/${other.body.kit.id}`).expect(200);
    expect(k.body.kit.schedule.days).toHaveLength(10);
    await agent.post('/api/kits').send({ jd: JD, company_url: `${origin}/acme/`, days: 3, force: true }).expect(202);
    await runner.idle();
  });

  it('records a failure clearly and can retry', async () => {
    const agent = await signUp();
    llm.failTasks = new Set(['extract_requirements']);
    const res = await agent.post('/api/kits').send({ jd: JD, company_url: `${origin}/acme/`, days: 3 }).expect(202);
    await runner.idle();
    const s = await agent.get(`/api/kits/${res.body.kit.id}/status`).expect(200);
    expect(s.body.status).toBe('failed');
    expect(s.body.error.code).toBe('EXTRACTION_FAILED');
    llm.failTasks = new Set();
    await agent.post(`/api/kits/${res.body.kit.id}/retry`).expect(202);
    await runner.idle();
    expect((await agent.get(`/api/kits/${res.body.kit.id}/status`)).body.status).toBe('ready');
  });

  it('accepts a batch with per-item validation errors', async () => {
    const agent = await signUp();
    const res = await agent.post('/api/kits/batch').send({ items: [{ jd: JD, company_url: `${origin}/acme/`, days: 2 }, { jd: 'x' }] }).expect(202);
    expect(res.body.results[0].kit.status).toBe('queued');
    expect(res.body.results[1].error.code).toBe('VALIDATION_ERROR');
    await runner.idle();
  });
});

describe('builder', () => {
  it('applies edit ops atomically and bumps the version', async () => {
    const agent = await signUp();
    const kit = await readyKit(agent);
    const q1 = kit.kit.questions[0];
    const res = await agent.patch(`/api/kits/${kit.id}`).send({ ops: [
      { op: 'question.update', id: q1.id, patch: { prompt: 'My own wording' } },
      { op: 'question.add', tempId: 'tmp-1', question: { category: 'behavioural', prompt: 'Hand-written question' } },
    ] }).expect(200);
    expect(res.body.version).toBe(kit.version + 1);
    const newId = res.body.created['tmp-1'];
    expect(res.body.kit.questions.find((q: { id: string }) => q.id === newId).state.origin).toBe('user');
    expect(res.body.scheduleStale).toBe(true);

    const bad = await agent.patch(`/api/kits/${kit.id}`).send({ ops: [{ op: 'question.update', id: 'q999', patch: { prompt: 'x' } }] }).expect(404);
    expect(bad.body.error.code).toBe('EDIT_NOT_FOUND');
    await agent.patch(`/api/kits/${kit.id}`).send({ ops: [{ op: 'question.update', id: q1.id, patch: { difficulty: 9 } }] }).expect(400);
  });

  it('regenerating a category keeps edited, pinned and hand-written questions and leaves other sections alone', async () => {
    const agent = await signUp();
    const kit = await readyKit(agent);
    const tech = kit.kit.questions.filter((q: { category: string }) => q.category === 'technical');
    expect(tech.length).toBeGreaterThan(2);
    const edits = await agent.patch(`/api/kits/${kit.id}`).send({ ops: [
      { op: 'question.update', id: tech[0].id, patch: { prompt: 'Edited by me' } },
      { op: 'pin', target: 'question', id: tech[1].id, pinned: true },
      { op: 'question.add', tempId: 't', question: { category: 'technical', prompt: 'Written by me' } },
      { op: 'brief.update', patch: { summary: 'My brief notes' } },
    ] }).expect(200);
    const mine = edits.body.created.t;

    await agent.post(`/api/kits/${kit.id}/regenerate`).send({ section: 'questions:technical' }).expect(202);
    const dup = await agent.post(`/api/kits/${kit.id}/regenerate`).send({ section: 'brief' }).expect(409);
    expect(dup.body.error.code).toBe('REGEN_IN_PROGRESS');
    await runner.idle();

    const after = (await agent.get(`/api/kits/${kit.id}`).expect(200)).body;
    expect(after.regen).toMatchObject({ status: 'done', section: 'questions:technical' });
    expect(after.regen.message).toMatch(/kept 3/);
    const ids = after.kit.questions.map((q: { id: string }) => q.id);
    expect(ids).toEqual(expect.arrayContaining([tech[0].id, tech[1].id, mine]));
    expect(after.kit.questions.find((q: { id: string }) => q.id === tech[0].id).prompt).toBe('Edited by me');
    tech.slice(2).forEach((q: { id: string }) => expect(ids).not.toContain(q.id));
    expect(after.kit.company_brief.summary).toBe('My brief notes');
    expect(after.kit.questions.filter((q: { category: string }) => q.category === 'behavioural')).toEqual(
      kit.kit.questions.filter((q: { category: string }) => q.category === 'behavioural'),
    );
    expect(validateKit(after.kit).ok).toBe(true);

    // brief was edited -> regeneration leaves it alone and says so
    await agent.post(`/api/kits/${kit.id}/regenerate`).send({ section: 'brief' }).expect(202);
    await runner.idle();
    const b = (await agent.get(`/api/kits/${kit.id}`)).body;
    expect(b.kit.company_brief.summary).toBe('My brief notes');
    expect(b.regen.message).toMatch(/left unchanged/);
  });

  it('rebuilds the schedule synchronously and clears the stale flag', async () => {
    const agent = await signUp();
    const kit = await readyKit(agent, 2);
    await agent.patch(`/api/kits/${kit.id}`).send({ ops: [{ op: 'question.add', question: { category: 'technical', prompt: 'Extra' } }] }).expect(200);
    const res = await agent.post(`/api/kits/${kit.id}/regenerate`).send({ section: 'schedule' }).expect(200);
    expect(res.body.scheduleStale).toBe(false);
    expect(res.body.kit.schedule.days).toHaveLength(2);
    const all = new Set(res.body.kit.schedule.days.flatMap((d: { question_ids: string[] }) => d.question_ids));
    res.body.kit.questions.forEach((q: { id: string }) => expect(all.has(q.id)).toBe(true));
  });
});

describe('practice', () => {
  it('records confidence and orders the next session by it', async () => {
    const agent = await signUp();
    const kit = await readyKit(agent);
    const [f1, f2] = kit.kit.flashcards;
    await agent.post(`/api/kits/${kit.id}/practice`).send({ cardId: f1.id, confidence: 3 }).expect(200);
    const res = await agent.post(`/api/kits/${kit.id}/practice`).send({ cardId: f2.id, confidence: 1 }).expect(200);
    expect(res.body.order[0]).toBe(f2.id);
    expect(res.body.order.at(-1)).toBe(f1.id);
    expect(res.body.summary).toMatchObject({ seen: 2, byConfidence: { 1: 1, 2: 0, 3: 1 } });
    await agent.post(`/api/kits/${kit.id}/practice`).send({ cardId: 'f999', confidence: 1 }).expect(404);
    await agent.post(`/api/kits/${kit.id}/practice`).send({ cardId: f1.id, confidence: 5 }).expect(400);
    expect((await agent.delete(`/api/kits/${kit.id}/practice`).expect(200)).body.summary.seen).toBe(0);
  });
});
