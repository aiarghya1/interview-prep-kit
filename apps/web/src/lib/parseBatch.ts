/** Parse an uploaded file of description/company pairs: JSON array or CSV with a header row. */
export interface BatchRow {
  jd: string;
  company_url: string;
  days: number;
}
export interface ParsedBatch {
  rows: BatchRow[];
  errors: string[];
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

const pick = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== '') return o[k];
  return undefined;
};

export function parseBatchFile(name: string, text: string, defaultDays: number): ParsedBatch {
  let records: Record<string, unknown>[] = [];
  const errors: string[] = [];
  if (name.toLowerCase().endsWith('.json') || text.trimStart().startsWith('[')) {
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) return { rows: [], errors: ['The JSON file must contain an array of objects.'] };
      records = data;
    } catch {
      return { rows: [], errors: ['The file is not valid JSON.'] };
    }
  } else {
    const table = parseCsv(text);
    const header = (table.shift() ?? []).map((h) => h.trim().toLowerCase());
    if (!header.includes('jd') && !header.includes('job_description')) {
      return { rows: [], errors: ['CSV needs a header row with columns: jd, company_url, days (days optional).'] };
    }
    records = table.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  }
  const rows: BatchRow[] = [];
  records.forEach((r, i) => {
    const jd = String(pick(r, ['jd', 'job_description', 'description']) ?? '').trim();
    const url = String(pick(r, ['company_url', 'companyUrl', 'url', 'company']) ?? '').trim();
    const daysRaw = pick(r, ['days', 'days_available']);
    const days = daysRaw === undefined ? defaultDays : Number(daysRaw);
    if (jd.length < 20) errors.push(`Row ${i + 1}: job description is missing or too short.`);
    else if (!url) errors.push(`Row ${i + 1}: company_url is missing.`);
    else if (!Number.isInteger(days) || days < 1 || days > 365) errors.push(`Row ${i + 1}: days must be a whole number from 1 to 365.`);
    else rows.push({ jd, company_url: url, days });
  });
  if (rows.length > 10) {
    errors.push(`Only the first 10 of ${rows.length} rows will be used.`);
    rows.length = 10;
  }
  return { rows, errors };
}
