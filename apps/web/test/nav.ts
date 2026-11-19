import { vi } from 'vitest';

export const nav = {
  pathname: '/kits',
  searchParams: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  redirect: vi.fn(),
  reset() {
    this.pathname = '/kits';
    this.searchParams = new URLSearchParams();
    this.router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
    this.redirect = vi.fn();
  },
};
