export type RetrievalErrorCode =
  | 'INVALID_URL'
  | 'BLOCKED_URL'
  | 'ROBOTS_DISALLOWED'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'UNSUPPORTED_CONTENT'
  | 'TOO_LARGE'
  | 'TOO_MANY_REDIRECTS';

export class RetrievalError extends Error {
  constructor(
    readonly code: RetrievalErrorCode,
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RetrievalError';
  }

  /** Worth retrying: transient network trouble or server-side throttling. */
  get transient(): boolean {
    return (
      this.code === 'TIMEOUT' ||
      this.code === 'NETWORK' ||
      (this.code === 'HTTP_ERROR' && (this.status === 429 || (this.status ?? 0) >= 500))
    );
  }
}
