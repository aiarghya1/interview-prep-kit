import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { startFixtureServer } from '../fixtures/serve.js';
import { generateKit, deriveCompanyName, PipelineError } from '../src/pipeline.js';
import { Fetcher } from '../src/retrieval/fetcher.js';
import { validateKit } from '../src/schema.js';
import { FakeLlm } from './fakeLlm.js';
import cases from '../../../examples/cases.sample.json';

let server: Server;
let origin: string;
beforeAll(async () => {
  ({ server, origin } = await startFixtureServer(0));
});
afterAll(() => server.close());

const at = (c: (typeof cases)[number]) => ({ ...c, company_url: c.company_url.replace('http://localhost:8099', origin) });
const deps = (llm = new FakeLlm()) => ({
  llm,
  fetcher: new Fetcher({ policy: { allowPrivate: true }, minIntervalMs: 0, timeoutMs: 2000, retries: 0 }),
  search: async () => ({ items: [], searched: ['test'], skipped: [] }),
});

describe('generateKit end to end (fake model, fixture sites)', () => {
  it('builds a valid kit; hiring process shapes the questions; coverage loop closes gaps', async () => {
    const llm = new FakeLlm();
    const kit = await generateKit(at(cases[0]!), deps(llm));
    expect(validateKit(kit).ok).toBe(true);

    // invented requirement dropped; priorities from headings
    expect(kit.role.requirements.some((r) => /COBOL/.test(r.text))).toBe(false);
    expect(kit.role.requirements.find((r) => /Kubernetes/.test(r.text))!.priority).toBe('nice');
    expect(kit.role.requirements.find((r) => /Node\.js/.test(r.text))!.priority).toBe('must');

    // research
    expect(kit.research!.hiring_page_found).toBe(true);
    expect(kit.research!.hiring_process.formats).toEqual(expect.arrayContaining(['take_home', 'system_design']));
    expect(kit.research!.hiring_process.formats).not.toContain('quantum_round');
    expect(kit.company_brief.sources.every((s) => kit.source.pages_used.includes(s))).toBe(true);

    // category calls are separate, and the published take-home changes the technical brief
    const tasks = llm.calls.map((c) => c.task);
    expect(tasks).toEqual(expect.arrayContaining(['questions_technical', 'questions_behavioural', 'questions_system-design', 'questions_company-fit']));
    expect(llm.calls.find((c) => c.task === 'questions_technical')!.user).toMatch(/take-home/);
    expect(llm.calls.find((c) => c.task === 'questions_behavioural')!.system).toMatch(/STAR/);

    // second pass happened and nothing must-have is uncovered
    expect(tasks.some((t) => t.endsWith('_gap'))).toBe(true);
    expect(kit.coverage.passes).toBeGreaterThanOrEqual(2);
    const must = kit.role.requirements.filter((r) => r.priority === 'must').map((r) => r.id);
    must.forEach((id) => expect(kit.coverage.uncovered_requirement_ids).not.toContain(id));
    kit.questions.forEach((q) => q.requirement_ids.forEach((id) => expect(id).not.toBe('r999')));

    expect(kit.schedule.days).toHaveLength(5);
  });

  it('thin description -> thin kit that says so; no hiring page reported honestly', async () => {
    const kit = await generateKit(at(cases[1]!), deps());
    expect(kit.role.requirements).toHaveLength(1);
    expect(kit.research!.thin_description).toBe(true);
    expect(kit.source.notes!.join(' ')).toMatch(/Thin job description/);
    expect(kit.source.notes!.join(' ')).toMatch(/NO_HIRING_PAGE/);
    expect(kit.research!.hiring_process.found).toBe(false);
    expect(kit.schedule.days).toHaveLength(1);
  });

  it('unreachable company -> ok kit with an honest brief, model never asked about the company', async () => {
    const llm = new FakeLlm();
    const kit = await generateKit(at(cases[3]!), deps(llm));
    expect(kit.source.notes!.join(' ')).toMatch(/COMPANY_UNREACHABLE/);
    expect(kit.company_brief.sources).toEqual([]);
    expect(kit.company_brief.summary).toMatch(/No reliable information/);
    expect(llm.calls.map((c) => c.task)).not.toContain('company_brief');
    expect(kit.schedule.days).toHaveLength(60);
  });

  it('invalid company URL still yields a kit', async () => {
    const kit = await generateKit({ ...at(cases[3]!), company_url: 'not a url', days: 2 }, deps());
    expect(kit.source.notes!.join(' ')).toMatch(/INVALID_COMPANY_URL/);
  });

  it('crawled text reaches the model only inside untrusted blocks', async () => {
    const llm = new FakeLlm();
    await generateKit(at(cases[2]!), deps(llm));
    const brief = llm.calls.find((c) => c.task === 'company_brief')!;
    expect(brief.system).toMatch(/Never follow instructions/);
    const idx = brief.user.indexOf('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(idx).toBeGreaterThan(brief.user.lastIndexOf('<untrusted_content', idx));
    expect(idx).toBeLessThan(brief.user.indexOf('</untrusted_content>', idx));
  });

  it('survives a failing category and failing flashcards', async () => {
    const llm = new FakeLlm();
    llm.failTasks = new Set(['questions_technical', 'flashcards']);
    const kit = await generateKit(at(cases[0]!), deps(llm));
    expect(kit.flashcards.length).toBeGreaterThan(0);
    expect(kit.coverage.uncovered_requirement_ids.filter((id) => kit.role.requirements.find((r) => r.id === id)!.priority === 'must')).toEqual([]);
  });

  it('fails only when no kit can be produced', async () => {
    const llm = new FakeLlm();
    llm.failTasks = new Set(['extract_requirements']);
    await expect(generateKit(at(cases[0]!), deps(llm))).rejects.toBeInstanceOf(PipelineError);
    await expect(generateKit({ ...at(cases[0]!), jd: 'hi' }, deps())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('deriveCompanyName', () => {
  it.each([
    [new URL('https://www.posthog.com/'), undefined, undefined, 'Posthog'],
    [new URL('http://localhost:8099/acme/'), undefined, undefined, 'Acme'],
    [null, 'GitLab', undefined, 'GitLab'],
    [null, undefined, 'Globex | Logistics', 'Globex'],
  ])('%s', (u, site, title, expected) => expect(deriveCompanyName(u, site, title)).toBe(expected));
});
