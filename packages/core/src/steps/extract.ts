/**
 * Step: extract the role and its requirements from the pasted description.
 *
 * The model proposes requirements, each with a verbatim `evidence` quote.
 * Code then decides what survives and how it is marked:
 *   - grounding: evidence must actually appear in the posting (normalised),
 *     otherwise the requirement is dropped as invented
 *   - priority: the posting's own wording/section heading overrides the
 *     model ("Nice to have:", "Bonus points", "Requirements:" ...)
 *   - dedupe, cap, and stable ids r1..rn in posting order
 * A thin posting yields few requirements plus an explicit note; we never pad.
 */
import { z } from 'zod';
import type { Requirement } from '../schema.js';
import type { Llm } from '../llm/types.js';
import { untrusted, UNTRUSTED_RULES } from '../llm/untrusted.js';

const str = z.string().catch('');
const ExtractionSchema = z.object({
  company: z.string().nullable().catch(null),
  title: str,
  seniority: str,
  location: str,
  responsibilities: z.array(z.string()).catch([]),
  requirements: z
    .array(
      z.object({
        text: z.string().min(1),
        kind: z.enum(['technical', 'behavioural', 'domain']).catch('technical'),
        priority: z.enum(['must', 'nice']).catch('must'),
        evidence: z.string().catch(''),
      }),
    )
    .catch([]),
});

export interface ExtractedRole {
  company: string | null;
  title: string;
  seniority: string;
  location: string;
  responsibilities: string[];
  requirements: Requirement[];
  notes: string[];
  thin: boolean;
}

export const MAX_REQUIREMENTS = 20;
export const THIN_JD_CHARS = 400;

const SYSTEM = `You analyse job descriptions for an interview-preparation tool. Output JSON only.

${UNTRUSTED_RULES}

Extract from the job description:
- company: the hiring company's name if stated, else null
- title, seniority (e.g. junior, mid, senior, staff, lead; "" if not stated), location ("" if not stated)
- responsibilities: short phrases for what the person will do (only those stated)
- requirements: what the candidate must have or would ideally have. One skill/quality per item.
  - text: short and specific, e.g. "5+ years with React", "Mentoring junior engineers"
  - kind: "technical" (languages, tools, engineering skills), "behavioural" (communication, leadership, mentoring, collaboration, ownership), or "domain" (industry/business knowledge, e.g. payments, healthcare compliance)
  - priority: "must" if the posting presents it as required; "nice" if it says preferred, bonus, nice to have, a plus, ideally
  - evidence: copy the exact words from the posting that state it (verbatim, max ~20 words)

Rules:
- Never invent requirements. If the posting is short or vague, return only what it actually says, even if that is one or zero items.
- Do not turn responsibilities into requirements unless the posting asks for the skill.
- Do not split one sentence into many trivially different items; at most ${MAX_REQUIREMENTS} requirements.

Return: {"company": ..., "title": "", "seniority": "", "location": "", "responsibilities": [], "requirements": [{"text": "", "kind": "", "priority": "", "evidence": ""}]}`;

// ---------- deterministic checks ----------

export function normaliseForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(['the', 'and', 'with', 'for', 'you', 'our', 'are', 'have', 'has', 'will', 'your', 'who', 'that', 'this', 'from', 'can', 'in', 'of', 'to', 'a', 'an', 'or', 'on', 'as', 'is', 'be', 'we', 'at', 'it']);

function contentTokens(s: string): string[] {
  return normaliseForMatch(s)
    .split(' ')
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Is this requirement supported by the posting? Evidence must appear verbatim
 * (after normalisation); failing that, nearly all of its content words must
 * appear in a single line of the posting.
 */
export function isGrounded(jd: string, evidence: string, text: string): boolean {
  const nJd = normaliseForMatch(jd);
  const nEv = normaliseForMatch(evidence);
  if (nEv.length >= 3 && nJd.includes(nEv)) return true;
  const lines = jd.split(/\n|(?<=[.;•])\s+/).map((l) => new Set(contentTokens(l)));
  for (const candidate of [evidence, text]) {
    const toks = contentTokens(candidate);
    if (toks.length === 0) continue;
    for (const line of lines) {
      const hit = toks.filter((t) => line.has(t)).length;
      if (hit / toks.length >= 0.75) return true;
    }
  }
  return false;
}

const NICE_CUES = /\b(nice[\s-]to[\s-]have|bonus|a plus|is a plus|plus if|preferred|preferably|ideally|desirable|would be (great|nice|a plus)|not required|optional|good to have|extra credit|advantage|we'd love|we would love)\b/i;
const MUST_CUES = /\b(must|required|requirements?|essential|minimum|need(ed)?|what you('|’)?ll need|you have|you bring|qualifications|about you|you will need|you should have|we're looking for|we are looking for|at least)\b/i;

function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 70) return false;
  if (/^#{1,6}\s/.test(t) || /:$/.test(t)) return true;
  return !/[.!?]$/.test(t) && !/^[-*•]/.test(t) && t.split(/\s+/).length <= 7;
}

/** Priority from the posting's own wording, or null if it doesn't say. */
export function priorityFromPosting(jd: string, evidence: string): 'must' | 'nice' | null {
  const lines = jd.split('\n');
  const nEv = normaliseForMatch(evidence);
  if (!nEv) return null;
  const idx = lines.findIndex((l) => {
    const nl = normaliseForMatch(l);
    return nl.length > 0 && (nl.includes(nEv) || (nEv.includes(nl) && nl.length > 12));
  });
  if (idx < 0) return null;
  const line = lines[idx]!;
  if (NICE_CUES.test(line)) return 'nice';
  for (let i = idx - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!looksLikeHeading(l)) continue;
    if (NICE_CUES.test(l)) return 'nice';
    if (MUST_CUES.test(l)) return 'must';
    // An explicit heading ("About the team:", "## Perks") that says nothing
    // scopes this line: stop. A short unpunctuated line may just be another
    // bare list item, so keep looking upward.
    if (/:$|^#{1,6}\s/.test(l.trim())) return null;
  }
  if (/\b(must|required|essential)\b/i.test(line)) return 'must';
  return null;
}

export function finaliseRequirements(
  jd: string,
  raw: z.infer<typeof ExtractionSchema>['requirements'],
): { requirements: Requirement[]; dropped: string[] } {
  const dropped: string[] = [];
  const seen = new Set<string>();
  const kept: (Requirement & { pos: number })[] = [];
  const nJd = normaliseForMatch(jd);

  for (const r of raw) {
    const text = r.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) continue;
    const key = normaliseForMatch(text);
    if (seen.has(key)) continue;
    if (!isGrounded(jd, r.evidence, text)) {
      dropped.push(text);
      continue;
    }
    seen.add(key);
    const evidence = r.evidence.trim() || text;
    const fromPosting = priorityFromPosting(jd, evidence);
    const pos = nJd.indexOf(normaliseForMatch(evidence));
    kept.push({ id: '', text, kind: r.kind, priority: fromPosting ?? r.priority, evidence, pos: pos < 0 ? Number.MAX_SAFE_INTEGER : pos });
  }

  kept.sort((a, b) => a.pos - b.pos);
  const requirements = kept.slice(0, MAX_REQUIREMENTS).map(({ pos: _pos, ...r }, i) => ({ ...r, id: `r${i + 1}` }));
  return { requirements, dropped };
}

export async function extractRole(jd: string, llm: Llm): Promise<ExtractedRole> {
  const raw = await llm.json({
    task: 'extract_requirements',
    system: SYSTEM,
    user: `Job description:\n${untrusted('job-description', jd, 12_000)}`,
    schema: ExtractionSchema,
    maxTokens: 1800,
    temperature: 0,
  });

  const { requirements, dropped } = finaliseRequirements(jd, raw.requirements);
  const notes: string[] = [];
  if (dropped.length) notes.push(`Dropped ${dropped.length} extracted requirement(s) not supported by the posting text: ${dropped.join('; ')}.`);
  const thin = jd.trim().length < THIN_JD_CHARS || requirements.length < 3;
  if (thin) {
    notes.push(
      `Thin job description (${jd.trim().length} characters, ${requirements.length} requirement(s) found). The kit covers only what the posting states; nothing has been invented to fill it out.`,
    );
  }
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    company: raw.company?.trim() ? clean(raw.company) : null,
    title: clean(raw.title),
    seniority: clean(raw.seniority),
    location: clean(raw.location),
    responsibilities: raw.responsibilities.map(clean).filter(Boolean).slice(0, 15),
    requirements,
    notes,
    thin,
  };
}
