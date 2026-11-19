'use client';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { parseBatchFile, type ParsedBatch } from '@/lib/parseBatch';
import { Banner, Button } from './ui';

interface BatchResult {
  index: number;
  kit?: { id: string };
  deduplicated?: string | false;
  error?: { message: string };
}

export function BatchUpload({ onCreated }: { onCreated: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<(ParsedBatch & { name: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    setResults(null);
    setError(null);
    if (!file) return;
    if (file.size > 500_000) return setError('That file is larger than 500 KB.');
    setParsed({ ...parseBatchFile(file.name, await file.text(), 5), name: file.name });
  }

  async function submit() {
    if (!parsed?.rows.length) return;
    setBusy(true);
    try {
      const res = await api<{ results: BatchResult[] }>('/kits/batch', { body: { items: parsed.rows } });
      setResults(res.results);
      setParsed(null);
      if (input.current) input.current.value = '';
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">Preparing for several roles?</h2>
      <p className="text-sm text-slate-600">
        Upload a <strong>.json</strong> array of <code className="rounded bg-slate-100 px-1">{'{ jd, company_url, days }'}</code> or a <strong>.csv</strong> with those columns. Up to 10 at a time.
      </p>
      <label htmlFor="batch-file" className="sr-only">Batch file</label>
      <input
        id="batch-file"
        ref={input}
        type="file"
        accept=".json,.csv,application/json,text/csv"
        onChange={(e) => onFile(e.target.files?.[0])}
        className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-slate-50"
      />
      {parsed && (
        <div className="space-y-2 text-sm">
          {parsed.errors.length > 0 && (
            <Banner tone="warn" title={`${parsed.errors.length} row(s) need attention`}>
              <ul className="list-disc pl-4">
                {parsed.errors.slice(0, 6).map((e) => <li key={e}>{e}</li>)}
              </ul>
            </Banner>
          )}
          {parsed.rows.length > 0 ? (
            <>
              <ul className="divide-y divide-slate-100 rounded border border-slate-200 bg-white">
                {parsed.rows.map((r, i) => (
                  <li key={i} className="flex justify-between gap-2 px-3 py-2">
                    <span className="truncate">{r.jd.split('\n')[0]}</span>
                    <span className="shrink-0 text-slate-500">{r.company_url} · {r.days}d</span>
                  </li>
                ))}
              </ul>
              <Button variant="primary" busy={busy} onClick={submit}>
                Create {parsed.rows.length} kit{parsed.rows.length === 1 ? '' : 's'}
              </Button>
            </>
          ) : (
            <p className="text-slate-500">No usable rows in {parsed.name}.</p>
          )}
        </div>
      )}
      {results && (
        <Banner tone={results.some((r) => r.error) ? 'warn' : 'success'} title="Batch submitted">
          {results.filter((r) => r.kit).length} kit(s) queued{results.some((r) => r.error) ? `, ${results.filter((r) => r.error).length} rejected` : ''}. They will appear in your list as they generate.
          {results.filter((r) => r.error).map((r) => <p key={r.index}>Row {r.index + 1}: {r.error!.message}</p>)}
        </Banner>
      )}
      {error && <Banner tone="error">{error}</Banner>}
    </div>
  );
}
