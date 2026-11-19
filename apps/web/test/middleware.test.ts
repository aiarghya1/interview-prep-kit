// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { config, middleware } from '@/middleware';

describe('middleware', () => {
  it('redirects protected pages to sign-in when there is no session cookie', () => {
    const res = middleware(new NextRequest('http://localhost:3000/kits/k1'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login?next=%2Fkits%2Fk1');
  });
  it('lets requests with a session cookie through', () => {
    const res = middleware(new NextRequest('http://localhost:3000/kits', { headers: { cookie: 'ipk_session=abc' } }));
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
  it('only guards the kits pages', () => {
    expect(config.matcher).toEqual(['/kits/:path*']);
  });
});
