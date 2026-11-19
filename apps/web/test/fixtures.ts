import type { Kit } from '@kit/core/schema';
import { sampleKit } from '../../../packages/core/test/kitFixture';
import type { KitView } from '@/lib/types';

/** A ready kit with research, as the API returns it. */
export function richKit(): Kit {
  const k = sampleKit();
  k.role.requirements[0] = { ...k.role.requirements[0]!, text: 'Node.js and TypeScript', evidence: 'Strong Node.js and TypeScript' };
  k.source = { ...k.source, notes: ['NO_HIRING_PAGE: no page describing the interview process was found on the company site.', 'NO_PUBLIC_DISCUSSION: x'] };
  k.company_brief = { ...k.company_brief, sources: ['https://acme.example/about'] };
  k.research = {
    hiring_page_found: true,
    hiring_process: { found: true, source_type: 'official', stages: [{ name: 'Screen', description: 'Recruiter call' }, { name: 'Onsite', description: '' }], formats: ['take_home', 'mystery'], tips: ['Write a README'], sources: [] },
    discussion: [{ source: 'hackernews', url: 'https://news.ycombinator.com/item?id=1', title: 'Acme interview' }, { source: 'reddit', url: 'https://reddit.com/r/x', title: '' }],
    skipped_sources: [{ url: 'https://acme.example/careers', reason: 'HTTP 404' }],
    steps: [],
    thin_description: false,
  };
  k.coverage = { ...k.coverage, notes: ['Pass 2 closed no gaps; stopping early.'] };
  return k;
}

export function view(overrides: Partial<KitView> = {}): KitView {
  return {
    id: 'k1',
    status: 'ready',
    title: 'Engineer',
    company: 'Acme',
    input: { jd: 'jd', company_url: 'https://acme.example', days: 3 },
    kit: richKit(),
    version: 1,
    highWater: { q: 4, f: 2 },
    progress: [],
    error: null,
    regen: null,
    scheduleStale: false,
    stories: [],
    createdAt: '2026-11-20T00:00:00Z',
    updatedAt: '2026-11-20T00:00:00Z',
    ...overrides,
  };
}
