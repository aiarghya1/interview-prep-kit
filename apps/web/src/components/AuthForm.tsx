'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import { Banner, Button, Card, Field, Input } from './ui';

const REASONS: Record<string, string> = {
  SESSION_EXPIRED: 'Your session expired. Sign in again to continue where you left off.',
  INVALID_SESSION: 'Please sign in again.',
};

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const params = useSearchParams();
  const next = params.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/kits';
  const reason = params.get('reason');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await api(`/auth/${mode}`, { body: { email, password } });
      // Full navigation, not router.replace: the client router may hold a
      // prefetched "redirect to login" for this page from before sign-in.
      window.location.assign(safeNext);
    } catch (err) {
      const e = err as ApiError;
      if (e.details?.length) setFieldErrors(Object.fromEntries(e.details.map((d) => [d.path ?? '', d.message])));
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const isLogin = mode === 'login';
  return (
    <div className="mx-auto max-w-sm space-y-4 pt-8">
      <h1 className="text-2xl font-semibold">{isLogin ? 'Sign in' : 'Create an account'}</h1>
      {reason && REASONS[reason] && <Banner tone="warn">{REASONS[reason]}</Banner>}
      <Card>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field id="email" label="Email" error={fieldErrors.email}>
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} invalid={!!fieldErrors.email} />
          </Field>
          <Field id="password" label="Password" error={fieldErrors.password} hint={isLogin ? undefined : 'At least 8 characters.'}>
            <Input
              id="password"
              type="password"
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              invalid={!!fieldErrors.password}
            />
          </Field>
          {error && <Banner tone="error">{error}</Banner>}
          <Button type="submit" variant="primary" busy={busy} className="w-full">
            {isLogin ? 'Sign in' : 'Create account'}
          </Button>
        </form>
      </Card>
      <p className="text-center text-sm text-slate-600">
        {isLogin ? 'New here? ' : 'Already have an account? '}
        <Link className="font-medium text-brand-700 underline-offset-2 hover:underline" href={isLogin ? '/register' : '/login'}>
          {isLogin ? 'Create an account' : 'Sign in'}
        </Link>
      </p>
    </div>
  );
}
