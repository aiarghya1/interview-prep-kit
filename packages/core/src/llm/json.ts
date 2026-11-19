/** Lenient JSON extraction from model output: fences, prose, trailing commas. */
export function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim();
  const attempts: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1]!.trim());
  const first = trimmed.search(/[[{]/);
  const lastObj = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (first >= 0 && lastObj > first) attempts.push(trimmed.slice(first, lastObj + 1));
  for (const a of [...attempts]) attempts.push(a.replace(/,\s*([}\]])/g, '$1'));
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      /* next */
    }
  }
  throw new SyntaxError('Model output is not valid JSON');
}
