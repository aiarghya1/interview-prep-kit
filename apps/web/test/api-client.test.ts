import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/lib/api';
import { mockApi } from './http';

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('GETs JSON, POSTs when given a body, handles 204', async () => {
    const { calls } = mockApi({ 'GET /a': { x: 1 }, 'POST /b': (b) => b, 'DELETE /c': { status: 204 } });
    expect(await api('/a')).toEqual({ x: 1 });
    expect(await api('/b', { body: { y: 2 } })).toEqual({ y: 2 });
    expect(await api('/c', { method: 'DELETE' })).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'DELETE']);
  });

  it('turns error responses into ApiError with code, message and details', async () => {
    mockApi({ 'GET /bad': { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'nope', details: [{ path: 'jd', message: 'short' }] } } }, 'GET /weird': { status: 502, body: null } });
    const e = await api('/bad').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', message: 'nope', details: [{ path: 'jd' }], isNetwork: false, retryable: false });
    const w = await api('/weird').catch((x) => x);
    expect(w).toMatchObject({ code: 'HTTP_502', message: 'Request failed (502)', retryable: true });
  });

  it('reports network failures as retryable; rethrows aborts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));
    const e = await api('/x').catch((x) => x);
    expect(e).toMatchObject({ status: 0, code: 'NETWORK', isNetwork: true, retryable: true });
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(abort));
    await expect(api('/x')).rejects.toBe(abort);
  });

  it('sends expired sessions to the login page with a return path, but not from auth calls', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, pathname: '/kits/k1', assign });
    mockApi({ 'GET /kits': { status: 401, body: { error: { code: 'SESSION_EXPIRED', message: 'expired' } } }, 'GET /auth/me': { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'no' } } }, 'GET /other': { status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'x' } } } });
    await expect(api('/kits')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(assign).toHaveBeenCalledWith('/login?next=%2Fkits%2Fk1&reason=SESSION_EXPIRED');
    await expect(api('/auth/me')).rejects.toBeTruthy();
    await expect(api('/other')).rejects.toBeTruthy();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(new ApiError(429, 'X', 'y').retryable).toBe(true);
  });
});
