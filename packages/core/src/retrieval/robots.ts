/**
 * Minimal robots.txt support: groups for our user-agent (or *), Allow/Disallow
 * with longest-match precedence, `*` and `$` wildcards, Crawl-delay and
 * Sitemap lines. A missing or unreadable robots.txt means everything is allowed.
 */
export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelayMs?: number;
  sitemaps: string[];
}

export const ALLOW_ALL: RobotsRules = { allow: [], disallow: [], sitemaps: [] };

export function parseRobots(txt: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();
  type Group = { agents: string[]; allow: string[]; disallow: string[]; delay?: number };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' && value) current.allow.push(value);
    else if (key === 'disallow' && value) current.disallow.push(value);
    else if (key === 'crawl-delay' && !Number.isNaN(Number(value))) current.delay = Number(value) * 1000;
  }

  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
    crawlDelayMs: chosen.find((g) => g.delay !== undefined)?.delay,
    sitemaps,
  };
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export function isAllowed(rules: RobotsRules, pathWithQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  for (const [list, allow] of [
    [rules.allow, true],
    [rules.disallow, false],
  ] as const) {
    for (const p of list) {
      if (patternToRegex(p).test(pathWithQuery)) {
        // Longest match wins; on a tie, Allow wins.
        if (!best || p.length > best.len || (p.length === best.len && allow)) best = { len: p.length, allow };
      }
    }
  }
  return best ? best.allow : true;
}
