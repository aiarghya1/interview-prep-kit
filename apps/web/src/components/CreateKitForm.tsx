'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import type { KitSummary } from '@/lib/types';
import { Banner, Button, Field, Input, TextArea } from './ui';

const DAY_PRESETS = [1, 3, 7, 14];

export function CreateKitForm({ onCreated }: { onCreated?: () => void }) {
  const router = useRouter();
  const [jd, setJd] = useState('');
  const [url, setUrl] = useState('');
  const [days, setDays] = useState('5');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function validate() {
    const e: Record<string, string> = {};
    if (jd.trim().length < 20) e.jd = 'Paste the job description (at least 20 characters).';
    if (!url.trim()) e.company_url = 'Enter the company website, e.g. acme.com';
    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 365) e.days = 'Enter a whole number of days from 1 to 365.';
    return e;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) {
      document.getElementById(Object.keys(e)[0] === 'company_url' ? 'company_url' : Object.keys(e)[0]!)?.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ kit: KitSummary; deduplicated: string | false }>('/kits', { body: { jd, company_url: url, days: Number(days) } });
      onCreated?.();
      const note = res.deduplicated ? `?note=${res.deduplicated}` : '';
      router.push(`/kits/${res.kit.id}${note}`);
    } catch (err) {
      const ae = err as ApiError;
      if (ae.details?.length) setErrors(Object.fromEntries(ae.details.map((d) => [d.path ?? '', d.message])));
      else setFormError(ae.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-labelledby="create-heading">
      <h2 id="create-heading" className="text-lg font-semibold">New prep kit</h2>
      <Field id="jd" label="Job description" error={errors.jd} hint={`${jd.trim().length.toLocaleString()} characters. Paste the full posting: requirements, nice-to-haves, everything.`}>
        <TextArea
          id="jd"
          rows={10}
          value={jd}
          onChange={(e) => setJd(e.target.value)}
          invalid={!!errors.jd}
          aria-describedby={errors.jd ? 'jd-error' : 'jd-hint'}
          placeholder={'Senior Backend Engineer\n\nRequirements:\n- 5+ years with Node.js\n...'}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field id="company_url" label="Company website" error={errors.company_url} hint="We crawl it for what they do and how they hire.">
          <Input id="company_url" inputMode="url" autoComplete="url" placeholder="acme.com" value={url} onChange={(e) => setUrl(e.target.value)} invalid={!!errors.company_url} aria-describedby={errors.company_url ? 'company_url-error' : 'company_url-hint'} />
        </Field>
        <Field id="days" label="Days until interview" error={errors.days}>
          <div className="flex items-center gap-2">
            <Input id="days" type="number" min={1} max={365} className="w-20" value={days} onChange={(e) => setDays(e.target.value)} invalid={!!errors.days} aria-describedby={errors.days ? 'days-error' : undefined} />
            <div className="flex gap-1" role="group" aria-label="Quick pick days">
              {DAY_PRESETS.map((d) => (
                <button key={d} type="button" onClick={() => setDays(String(d))} aria-pressed={days === String(d)} className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 aria-pressed:border-brand-500 aria-pressed:bg-brand-50 aria-pressed:text-brand-700">
                  {d}
                </button>
              ))}
            </div>
          </div>
        </Field>
      </div>
      {formError && <Banner tone="error">{formError}</Banner>}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" busy={busy}>
          {busy ? 'Starting…' : 'Build my kit'}
        </Button>
        <p className="text-xs text-slate-500">Research and generation take one to three minutes. You can leave this page.</p>
      </div>
    </form>
  );
}
