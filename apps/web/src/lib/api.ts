export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path?: string; message: string }[],
  ) {
    super(message);
  }
  get isNetwork() {
    return this.status === 0;
  }
  get retryable() {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

const SESSION_CODES = new Set(['UNAUTHENTICATED', 'SESSION_EXPIRED', 'INVALID_SESSION']);

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', "Can't reach the server. Check your connection.");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error ?? {};
    const err = new ApiError(res.status, e.code ?? `HTTP_${res.status}`, e.message ?? `Request failed (${res.status})`, e.details);
    if (res.status === 401 && SESSION_CODES.has(err.code) && !path.startsWith('/auth/') && typeof window !== 'undefined') {
      const next = encodeURIComponent(window.location.pathname);
      window.location.assign(`/login?next=${next}&reason=${err.code}`);
    }
    throw err;
  }
  return data as T;
}
