import { describe, expect, it } from 'vitest';
import { extractRole, finaliseRequirements, priorityFromPosting } from '../src/steps/extract.js';
import { notFoundBrief, NO_HIRING_PROCESS, summariseHiringProcess, writeCompanyBrief } from '../src/steps/research.js';
import { generateCategoryQuestions, planCategories, type QuestionContext } from '../src/steps/questions.js';
import { cardsFromQuestions, generateFlashcards } from '../src/steps/flashcards.js';
import type { CrawledPage } from '../src/retrieval/crawler.js';
import { q, req } from './fixtures.js';
import { stubLlm } from './stubLlm.js';

const page = (url: string, kind: CrawledPage['kind'], text: string, extra: Partial<CrawledPage> = {}): CrawledPage => ({
  url, title: 'T', kind, text, linkScore: 0, hiringSignals: [], ...extra,
});
const LONG = 'Acme builds payment software for online marketplaces and their sellers. '.repeat(3);

describe('extract: priority and grounding edge cases', () => {
  it('returns null without evidence, or when evidence is not in the posting', () => {
    expect(priorityFromPosting('Go experience', '')).toBeNull();
    expect(priorityFromPosting('Go experience', 'Rust')).toBeNull();
    expect(priorityFromPosting('Go experience', 'Go experience')).toBeNull();
  });
  it('matches evidence that spans past a line, and skips long or blank lines when looking for headings', () => {
    const jd = `Requirements:\n\nThis line is a very long sentence that is clearly body text and not a heading at all, ok\nExperience with distributed systems`;
    expect(priorityFromPosting(jd, 'Experience with distributed systems and event sourcing')).toBe('must');
  });
  it('drops blank requirements, falls back to text for evidence, keeps paraphrased evidence last', () => {
    const jd = 'Requirements:\n- Python and SQL\n- Airflow';
    const { requirements } = finaliseRequirements(jd, [
      { text: '   ', kind: 'technical', priority: 'must', evidence: 'x' },
      { text: 'SQL and Python', kind: 'technical', priority: 'must', evidence: 'Strong SQL plus Python' },
      { text: 'Airflow', kind: 'technical', priority: 'nice', evidence: '' },
    ]);
    expect(requirements.map((r) => [r.text, r.evidence, r.priority])).toEqual([
      ['Airflow', 'Airflow', 'must'],
      ['SQL and Python', 'Strong SQL plus Python', 'must'],
    ]);
  });
  it('extractRole keeps a named company and a full posting is not thin', async () => {
    const jd = 'Backend Engineer at Acme\nRequirements:\n- Node.js\n- PostgreSQL\n- Kafka\n' + 'We build payments. '.repeat(30);
    const llm = stubLlm({
      extract_requirements: {
        company: '  Acme  ', title: 'Backend Engineer', seniority: '', location: '', responsibilities: ['Build', ''],
        requirements: ['Node.js', 'PostgreSQL', 'Kafka'].map((t) => ({ text: t, kind: 'technical', priority: 'must', evidence: t })),
      },
    });
    const r = await extractRole(jd, llm);
    expect(r).toMatchObject({ company: 'Acme', thin: false, notes: [], responsibilities: ['Build'] });
    const blank = await extractRole(jd, stubLlm({ extract_requirements: { company: '   ', requirements: [] } }));
    expect(blank.company).toBeNull();
  });
});

describe('research: brief', () => {
  it('writes an honest brief without calling the model when there is too little material', async () => {
    const llm = stubLlm({});
    const b = await writeCompanyBrief({ llm, company: '', companyUrl: '', pages: [page('https://a/', 'home', 'hi')], jd: '' });
    expect(b.found).toBe(false);
    expect(b.summary).toMatch(/this company/);
    expect(b.what_they_do).toMatch(/the given address/);
    const c = await writeCompanyBrief({ llm, company: 'A', companyUrl: 'x', pages: [], jd: '', unreachableReason: 'HTTP 404' });
    expect(c.summary).toMatch(/HTTP 404/);
    expect(llm.calls).toHaveLength(0);
  });
  it('cites fetched pages when the model cites none, sorted home first', async () => {
    const llm = stubLlm({ company_brief: { enough_information: true, summary: 'S', what_they_do: 'W', sources: ['https://evil.example/'] } });
    const b = await writeCompanyBrief({ llm, company: 'A', companyUrl: 'x', pages: [page('https://a/about', 'about', LONG), page('https://a/', 'home', LONG)], jd: '' });
    expect(b.sources).toEqual(['https://a/', 'https://a/about']);
  });
  it('says so when the pages do not describe the company', async () => {
    const withSummary = await writeCompanyBrief({
      llm: stubLlm({ company_brief: { enough_information: false, summary: 'Only a login page.', what_they_do: '', sources: [] } }),
      company: 'A', companyUrl: 'x', pages: [page('https://a/', 'home', LONG)], jd: '',
    });
    expect(withSummary).toMatchObject({ found: false, summary: 'Only a login page.' });
    const empty = await writeCompanyBrief({
      llm: stubLlm({ company_brief: { enough_information: true, summary: '', what_they_do: '  ', sources: [] } }),
      company: 'A', companyUrl: 'x', pages: [page('https://a/', 'home', LONG)], jd: '',
    });
    expect(empty.summary).toMatch(/No reliable information/);
  });
  it('notFoundBrief names the company when known', () => {
    expect(notFoundBrief('Acme', 'acme.com', 'timeout').summary).toMatch(/about Acme could be gathered: timeout/);
  });
});

describe('research: hiring process', () => {
  const hiringPage = page('https://a/how-we-hire', 'hiring-process', 'Our interview process: recruiter screen, take-home, onsite.', { hiringSignals: ['interview', 'take-home', 'screen'] });
  it('skips the model when there is nothing to summarise', async () => {
    const llm = stubLlm({});
    expect(await summariseHiringProcess({ llm, company: 'A', pages: [page('https://a/', 'home', LONG)], discussion: [] })).toBe(NO_HIRING_PROCESS);
    expect(llm.calls).toHaveLength(0);
  });
  it('returns not-found (with sources) when the material does not describe a process', async () => {
    const llm = stubLlm({ hiring_process: { described: false, stages: [], formats: [], tips: [], sources: ['https://a/how-we-hire'] } });
    expect(await summariseHiringProcess({ llm, company: 'A', pages: [hiringPage], discussion: [] })).toMatchObject({ found: false, sources: ['https://a/how-we-hire'] });
  });
  it('labels discussion-only material and falls back to the material as sources', async () => {
    const llm = stubLlm({ hiring_process: { described: true, stages: [{ name: 'Phone screen', description: '' }], formats: ['recruiter_screen', 'take_home'], tips: ['Be concise'], sources: [] } });
    const r = await summariseHiringProcess({
      llm, company: 'A', pages: [],
      discussion: [{ source: 'hackernews', url: 'https://news.ycombinator.com/item?id=1', title: 'A interview', snippet: 'A recruiter phone screen, then onsite' }],
    });
    expect(r).toMatchObject({ found: true, source_type: 'discussion', formats: ['recruiter_screen'], sources: ['https://news.ycombinator.com/item?id=1'] });
  });
});

describe('questions and flashcards', () => {
  const ctx: QuestionContext = {
    roleTitle: '',
    seniority: '',
    brief: { summary: '', what_they_do: '', sources: [], found: false },
    hiring: { found: true, source_type: 'official', stages: [], formats: ['system_design', 'take_home', 'live_coding', 'behavioural'], tips: ['Write a README'], sources: [] },
  };
  it('plans a 3-question system-design round when the company publishes one', () => {
    const plan = planCategories([req('r1')], ctx).find((p) => p.category === 'system-design')!;
    expect(plan).toMatchObject({ count: 3, reason: expect.stringMatching(/system-design round/) });
  });
  it('passes process guidance into each category and cleans model output', async () => {
    const llm = stubLlm({
      questions_: { questions: [
        { prompt: '      ', answer_outline: '', difficulty: 2, requirement_ids: [] },
        { prompt: 'Explain the trade-offs', answer_outline: 'x', difficulty: 'Infinity', requirement_ids: ['r1', 'r1', 'zz'] },
      ] },
    });
    for (const category of ['technical', 'system-design', 'behavioural'] as const) {
      const out = await generateCategoryQuestions({ llm, plan: { category, requirements: [req('r1')], count: 2, reason: '' }, ctx });
      expect(out).toEqual([expect.objectContaining({ prompt: 'Explain the trade-offs', difficulty: 2, requirement_ids: ['r1'] })]);
    }
    const [tech, sd, beh] = llm.calls.map((c) => c.user);
    expect(tech).toMatch(/Role: unspecified\n[\s\S]*not itemised[\s\S]*take-home[\s\S]*live coding[\s\S]*Write a README/);
    expect(sd).toMatch(/full end-to-end design/);
    expect(beh).toMatch(/stated values/);
  });
  it('flashcards: derived cards fill blank answers; general cards when no requirements', async () => {
    expect(cardsFromQuestions([{ ...q('q1', []), answer_outline: '' }], 5)[0]!.back).toBe('Draft your own answer.');
    const llm = stubLlm({ flashcards: { flashcards: [{ front: '   ', back: '', requirement_ids: [] }, { front: 'What is X?', back: 'Y', requirement_ids: [] }] } });
    const cards = await generateFlashcards({ llm, requirements: [], questions: [], roleTitle: '' });
    expect(cards.map((c) => c.front)).toEqual(['What is X?']);
    expect(llm.calls[0]!.user).toMatch(/Role: unspecified[\s\S]*none stated/);
  });
});
