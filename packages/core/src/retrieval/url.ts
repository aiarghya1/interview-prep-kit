/**
 * Validation of URLs we are about to fetch on someone else's behalf.
 *
 * - only http(s), no credentials in the URL
 * - in production, the hostname must not resolve to a private, loopback,
 *   link-local or otherwise internal address (SSRF). Every redirect hop is
 *   re-validated by the fetcher.
 * - private addresses are allowed when `allowPrivate` is set: local
 *   development and the batch command, whose test sites may be on localhost.
 *
 * Known gap: DNS rebinding between this lookup and the connection.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { RetrievalError } from './errors.js';

export interface UrlPolicy {
  allowPrivate: boolean;
}

export function defaultUrlPolicy(env: NodeJS.ProcessEnv = process.env): UrlPolicy {
  if (env.ALLOW_PRIVATE_URLS === 'true') return { allowPrivate: true };
  if (env.ALLOW_PRIVATE_URLS === 'false') return { allowPrivate: false };
  return { allowPrivate: env.NODE_ENV !== 'production' };
}

/** Parse user input into a URL, adding https:// if the scheme was omitted. */
export function normaliseUserUrl(input: string): URL {
  const raw = input.trim();
  if (!raw) throw new RetrievalError('INVALID_URL', 'No URL given', input);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new RetrievalError('INVALID_URL', `Not a valid URL: ${raw}`, input);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RetrievalError('INVALID_URL', `Only http and https URLs are supported (got ${url.protocol})`, input);
  }
  if (url.username || url.password) throw new RetrievalError('INVALID_URL', 'URLs with credentials are not allowed', input);
  if (!url.hostname) throw new RetrievalError('INVALID_URL', 'URL has no host', input);
  url.hash = '';
  return url;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(lower);
  }
  return true; // not an IP at all: treat as unsafe
}

/** Throws RetrievalError if the URL must not be fetched under this policy. */
export async function assertFetchable(url: URL, policy: UrlPolicy): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RetrievalError('INVALID_URL', `Unsupported protocol ${url.protocol}`, url.href);
  }
  if (policy.allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new RetrievalError('BLOCKED_URL', `Refusing to fetch internal host ${host}`, url.href);
  }
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new RetrievalError('NETWORK', `Could not resolve ${host}`, url.href);
    }
  }
  if (addresses.some(isPrivateAddress)) {
    throw new RetrievalError('BLOCKED_URL', `Refusing to fetch ${host}: resolves to a private address`, url.href);
  }
}
