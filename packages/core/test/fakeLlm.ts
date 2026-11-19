import type { Llm, LlmJsonRequest } from '../src/llm/types.js';

export interface Call {
  task: string;
  system: string;
  user: string;
}

/**
 * Deterministic stand-in for the model. It behaves like a mediocre but
 * cooperative model: extraction includes one invented requirement (which the
 * grounding check must drop), and first-draft questions only cover half the
 * requirements (so the coverage loop has gaps to close).
 */
export class FakeLlm implements Llm {
  readonly name = 'fake';
  calls: Call[] = [];
  failTasks = new Set<string>();

  async json<T>(req: LlmJsonRequest<T>): Promise<T> {
    this.calls.push({ task: req.task, system: req.system, user: req.user });
    if (this.failTasks.has(req.task)) throw new Error(`fake failure in ${req.task}`);
    return req.schema.parse(this.respond(req));
  }

  private respond(req: LlmJsonRequest<unknown>): unknown {
    const reqLines = [...req.user.matchAll(/^- (r\d+) \[(must|nice)\] (.+)$/gm)].map((m) => ({ id: m[1]!, text: m[3]! }));
    if (req.task === 'extract_requirements') {
      const jd = req.user.match(/<untrusted_content[^>]*>\n([\s\S]*?)\n<\/untrusted_content>/)![1]!;
      const bullets = jd.split('\n').filter((l) => /^\s*-\s+/.test(l)).map((l) => l.replace(/^\s*-\s+/, '').trim());
      const reqs = bullets
        .filter((b) => !/^(design, build|own the|mentor engineers and lead)/i.test(b))
        .map((b) => ({
          text: b,
          kind: /mentor|communication|collaboration/i.test(b) ? 'behavioural' : /payments|banking|fintech/i.test(b) ? 'domain' : 'technical',
          priority: 'must',
          evidence: b,
        }));
      if (reqs.length === 0) {
        const m = jd.match(/must know (\w+)/i);
        if (m) reqs.push({ text: `${m[1]} experience`, kind: 'technical', priority: 'must', evidence: m[0] });
      }
      reqs.push({ text: '10+ years of COBOL', kind: 'technical', priority: 'must', evidence: 'Expert COBOL programmer' });
      return { company: null, title: jd.split('\n')[0]!.trim().slice(0, 60), seniority: /senior/i.test(jd) ? 'senior' : '', location: '', responsibilities: [], requirements: reqs };
    }
    if (req.task === 'company_brief') {
      const src = [...req.user.matchAll(/source="([^"]+)"/g)].map((m) => m[1]!).filter((s) => s.startsWith('http'));
      return { enough_information: true, summary: 'A company that builds software.', what_they_do: 'Builds software.', sources: src.slice(0, 2) };
    }
    if (req.task === 'hiring_process') {
      const src = [...req.user.matchAll(/source="([^"]+)"/g)].map((m) => m[1]!);
      const lower = req.user.toLowerCase();
      const formats = ['take_home', 'system_design', 'live_coding', 'behavioural', 'recruiter_screen', 'onsite'].filter((f) =>
        lower.includes(f.replace('_', '-')) || lower.includes(f.replace('_', ' ')) || (f === 'live_coding' && lower.includes('live coding')),
      );
      return { described: true, stages: [{ name: 'Screen', description: '' }, { name: 'Technical', description: '' }], formats: [...formats, 'quantum_round'], tips: [], sources: src };
    }
    if (req.task.startsWith('questions_')) {
      const gap = req.task.endsWith('_gap');
      const n = Number(req.user.match(/Write (\d+)/)?.[1] ?? 2);
      const targets = gap ? reqLines : reqLines.slice(0, Math.ceil(reqLines.length / 2));
      const cat = req.task.replace(/^questions_/, '').replace(/_gap$/, '');
      const qs = Array.from({ length: gap ? reqLines.length : n }, (_, i) => {
        const r = targets[i % Math.max(1, targets.length)];
        return { prompt: `${cat} question ${i + 1} about ${r?.text ?? 'the role'}${gap ? ' (gap)' : ''}`, answer_outline: 'points', difficulty: (i % 3) + 1, requirement_ids: r ? [r.id, 'r999'] : [] };
      });
      return { questions: qs };
    }
    if (req.task === 'flashcards') {
      return { flashcards: reqLines.map((r) => ({ front: `What is ${r.text}?`, back: 'An answer.', requirement_ids: [r.id] })) };
    }
    throw new Error(`FakeLlm: unhandled task ${req.task}`);
  }
}
