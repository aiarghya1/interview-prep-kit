import { describe, expect, it, vi } from 'vitest';
import { ZodError, z } from 'zod';
import { EditError } from '@kit/core';
import { loadConfig } from '../src/config.js';
import { ApiError, errorHandler } from '../src/errors.js';
import { inputHash } from '../src/kits/service.js';
import { maxIdNum, ownerFilter, toSummary, toView, type StoredKit } from '../src/kits/store.js';

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  return res;
}
const handle = (err: unknown) => {
  const res = fakeRes();
  errorHandler(err, {} as never, res as never, () => {});
  return res;
};

describe('config', () => {
  it('requires a real JWT secret in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
    expect(loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) } as NodeJS.ProcessEnv)).toMatchObject({ cookieSecure: true, PORT: 4000 });
  });
  it('generates a random secret in development and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = loadConfig({ NODE_ENV: 'development', JWT_SECRET: 'short' } as NodeJS.ProcessEnv);
    expect(c.JWT_SECRET).toHaveLength(64);
    expect(c.cookieSecure).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('errorHandler', () => {
  it('maps every known error type to a structured response', () => {
    expect(handle(new ApiError(418, 'TEAPOT', 'no'))).toMatchObject({ statusCode: 418, body: { error: { code: 'TEAPOT', message: 'no' } } });
    const zerr = z.object({ a: z.string() }).safeParse({}).error as ZodError;
    expect(handle(zerr)).toMatchObject({ statusCode: 400, body: { error: { code: 'VALIDATION_ERROR', details: [{ path: 'a' }] } } });
    expect(handle(new EditError('NOT_FOUND', 'gone'))).toMatchObject({ statusCode: 404, body: { error: { code: 'EDIT_NOT_FOUND' } } });
    expect(handle(new EditError('INVALID', 'bad'))).toMatchObject({ statusCode: 422, body: { error: { code: 'EDIT_INVALID' } } });
    expect(handle({ type: 'entity.parse.failed' })).toMatchObject({ statusCode: 400, body: { error: { code: 'INVALID_JSON' } } });
    expect(handle({ type: 'entity.too.large' })).toMatchObject({ statusCode: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE' } } });
  });
  it('hides unexpected errors behind a generic 500 and logs them', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(handle(new Error('db password is hunter2'))).toMatchObject({ statusCode: 500, body: { error: { code: 'INTERNAL', message: 'Something went wrong on our side' } } });
    expect(handle(null).statusCode).toBe(500);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});

describe('store helpers', () => {
  const base = {
    _id: { toString: () => 'id1' },
    status: 'queued',
    input: { jd: 'jd', company_url: 'x', days: 2 },
    kit: null,
    version: 0,
    highWater: { q: 0, f: 0 },
    progress: [],
    practice: {},
    scheduleStale: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as StoredKit;

  it('toView fills absent optional fields and hides empty error/regen', () => {
    expect(toView(base)).toMatchObject({ id: 'id1', title: '', company: '', error: null, regen: null, stories: [] });
    const full = { ...base, title: 'T', company: 'C', error: { code: 'X', message: 'm' }, regen: { section: 'brief', status: 'done' }, stories: [{ id: 's1' }] } as unknown as StoredKit;
    expect(toView(full)).toMatchObject({ title: 'T', company: 'C', error: { code: 'X' }, regen: { section: 'brief' }, stories: [{ id: 's1' }] });
  });

  it('toSummary prefers stored titles, then the kit, then a placeholder', () => {
    expect(toSummary(base)).toMatchObject({ title: 'Untitled role', company: '', questions: 0, lastProgress: null, error: null });
    const kit = { role: { title: 'From kit' }, source: { company: 'KitCo' }, questions: [1], flashcards: [1, 2] };
    expect(toSummary({ ...base, kit, progress: [{ message: 'last' }], error: { code: 'E', message: 'm' } } as unknown as StoredKit)).toMatchObject({
      title: 'From kit', company: 'KitCo', questions: 1, flashcards: 2, lastProgress: 'last', error: { code: 'E' },
    });
  });

  it('ownerFilter rejects malformed ids; maxIdNum ignores junk', () => {
    expect(() => ownerFilter('nope')).toThrow(/not found/);
    expect(ownerFilter('64b7f0c2a1b2c3d4e5f60718')).toEqual({ _id: '64b7f0c2a1b2c3d4e5f60718' });
    expect(maxIdNum(['q2', 'q10', 'qx'])).toBe(10);
  });

  it('inputHash ignores whitespace, scheme, www, case and trailing slashes', () => {
    expect(inputHash(' A  b \n', 'https://www.Acme.com/')).toBe(inputHash('A b', 'acme.com'));
  });
});
