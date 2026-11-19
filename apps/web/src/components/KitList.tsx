'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { KitSummary } from '@/lib/types';
import { Badge, Banner, Button, EmptyState, Spinner } from './ui';

export function StatusBadge({ status }: { status: KitSummary['status'] }) {
  if (status === 'ready') return <Badge tone="emerald">Ready</Badge>;
  if (status === 'failed') return <Badge tone="red">Failed</Badge>;
  return (
    <Badge tone="brand">
      <span className="animate-pulseSoft">{status === 'queued' ? 'Queued' : 'Generating'}</span>
    </Badge>
  );
}

export function useKitList() {
  const [kits, setKits] = useState<KitSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    try {
      setKits((await api<{ kits: KitSummary[] }>('/kits')).kits);
      setError(null);
    } catch (err) {
      setError(err as ApiError);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const busy = kits?.some((k) => k.status === 'queued' || k.status === 'running');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [busy, load]);
  return { kits, error, reload: load, setKits };
}

export function KitList({ list }: { list: ReturnType<typeof useKitList> }) {
  const { kits, error, reload, setKits } = list;

  async function remove(k: KitSummary) {
    if (!window.confirm(`Delete the kit for "${k.title}"? This cannot be undone.`)) return;
    setKits((cur) => cur!.filter((x) => x.id !== k.id));
    try {
      await api(`/kits/${k.id}`, { method: 'DELETE' });
    } catch {
      void reload();
    }
  }

  if (error) return <Banner tone="error" title="Couldn't load your kits" action={<Button size="sm" onClick={reload}>Retry</Button>}>{error.message}</Banner>;
  if (!kits) return <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner label="Loading kits" /> Loading your kits…</div>;
  if (kits.length === 0) return <EmptyState title="No kits yet">Paste a job description and the company's website to build your first one.</EmptyState>;

  return (
    <ul className="space-y-2" aria-label="Your kits">
      {kits.map((k) => (
        <li key={k.id} className="group flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm focus-within:ring-2 focus-within:ring-brand-500">
          <Link href={`/kits/${k.id}`} className="min-w-0 flex-1 focus:outline-none">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium text-slate-900 group-hover:text-brand-700">{k.title}</span>
              <StatusBadge status={k.status} />
            </div>
            <p className="mt-0.5 truncate text-sm text-slate-500">
              {[k.company, `${k.days} day${k.days === 1 ? '' : 's'}`, k.status === 'ready' ? `${k.questions} questions · ${k.flashcards} cards` : null].filter(Boolean).join(' · ')}
            </p>
            {k.status !== 'ready' && (k.error?.message || k.lastProgress) && (
              <p className={`mt-1 truncate text-xs ${k.error ? 'text-red-700' : 'text-slate-500'}`}>{k.error?.message ?? k.lastProgress}</p>
            )}
          </Link>
          <Button size="sm" variant="ghost" onClick={() => remove(k)} aria-label={`Delete kit ${k.title}`}>
            Delete
          </Button>
        </li>
      ))}
    </ul>
  );
}
