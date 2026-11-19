import { vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are whatever the test sends
export type Handler = (body: any, init: RequestInit) => unknown;
export interface Reply {
  status?: number;
  body?: unknown;
}

/**
 * Fake backend for component tests: routes "METHOD /path" to handlers.
 * A handler returns a body (200) or a Reply ({status, body}); throwing a
 * TypeError simulates a network failure.
 */
export function mockApi(routes: Record<string, Handler | Reply | object | null>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = String(input).replace(/^\/api/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const match = Object.keys(routes).find((k) => k === key) ?? Object.keys(routes).find((k) => k.endsWith('*') && key.startsWith(k.slice(0, -1)));
    if (!match) return new Response(JSON.stringify({ error: { code: 'NOT_MOCKED', message: key } }), { status: 599 });
    const r = routes[match];
    const out = typeof r === 'function' ? await (r as Handler)(body, init) : r;
    // A Reply has a numeric HTTP status; API bodies may have a string `status` field.
    const reply: Reply = out && typeof out === 'object' && typeof (out as Reply).status === 'number' ? (out as Reply) : { status: 200, body: out };
    if (reply.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(reply.body ?? null), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock, routes };
}
