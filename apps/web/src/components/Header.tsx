'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const onAuthPage = pathname === '/login' || pathname === '/register';

  useEffect(() => {
    if (onAuthPage) return setEmail(null);
    api<{ user: { email: string } }>('/auth/me')
      .then((r) => setEmail(r.user.email))
      .catch(() => setEmail(null));
  }, [onAuthPage, pathname]);

  async function logout() {
    await api('/auth/logout', { body: {} }).catch(() => {});
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/kits" className="flex items-center gap-2 font-semibold text-slate-900">
          <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-xs font-bold text-white">IP</span>
          <span>Interview Prep Kit</span>
        </Link>
        {email && (
          <nav aria-label="Account" className="flex items-center gap-3 text-sm">
            <span className="hidden text-slate-500 sm:inline">{email}</span>
            <button type="button" onClick={logout} className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900">
              Sign out
            </button>
          </nav>
        )}
      </div>
    </header>
  );
}
