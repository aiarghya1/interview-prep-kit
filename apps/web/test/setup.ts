import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { nav } from './nav';

// Next.js routing hooks are framework internals; tests drive them through `nav`.
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.searchParams,
  redirect: (url: string) => nav.redirect(url),
}));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return { default: ({ href, children, ...rest }: { href: string; children?: import('react').ReactNode }) => createElement('a', { href, ...rest }, children) };
});

// jsdom's Blob lacks .text(), which every real browser has. Test-environment shim only.
if (typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function text(this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

afterEach(() => {
  cleanup();
  nav.reset();
  vi.useRealTimers();
});
