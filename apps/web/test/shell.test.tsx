import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Badge, Banner, Button, Card, EmptyState, Field, Input, Spinner, TextArea, cx } from '@/components/ui';
import { Header } from '@/components/Header';
import { AuthForm } from '@/components/AuthForm';
import RootLayout, { metadata, viewport } from '@/app/layout';
import Home from '@/app/page';
import LoginPage from '@/app/login/page';
import RegisterPage from '@/app/register/page';
import { mockApi } from './http';
import { nav } from './nav';

afterEach(() => vi.unstubAllGlobals());

describe('ui primitives', () => {
  it('render every variant accessibly', () => {
    render(
      <>
        <Button variant="primary">P</Button>
        <Button variant="ghost" size="sm">G</Button>
        <Button variant="danger" busy>D</Button>
        <Button>S</Button>
        <Spinner />
        <Spinner label="Loading" />
        <Field id="f" label="Name" hint="A hint"><Input id="f" /></Field>
        <Field id="g" label="Bad" error="Required"><Input id="g" invalid /></Field>
        <Field id="h" label="Plain"><TextArea id="h" invalid /></Field>
        <TextArea aria-label="ok" />
        <Banner tone="error" title="Oops" action={<span>act</span>}>body</Banner>
        <Banner tone="warn" />
        <Banner />
        <Badge>default</Badge>
        {(['brand', 'amber', 'emerald', 'red', 'violet'] as const).map((t) => <Badge key={t} tone={t}>{t}</Badge>)}
        <EmptyState title="Empty" action={<span>do</span>}>Nothing</EmptyState>
        <EmptyState title="Bare" />
        <Card className="x">card</Card>
      </>,
    );
    expect(screen.getByRole('button', { name: 'D' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'D' })).toBeDisabled();
    expect(screen.getByText('A hint')).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.getByLabelText('Bad')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Oops');
    expect(screen.getByText('Loading')).toHaveClass('sr-only');
    expect(screen.getAllByRole('status').length).toBeGreaterThan(1);
    expect(cx('a', false, null, undefined, 'b')).toBe('a b');
  });
});

describe('Header', () => {
  it('shows the signed-in user and signs out', async () => {
    const api = mockApi({ 'GET /auth/me': { user: { email: 'a@b.c' } }, 'POST /auth/logout': { status: 204 } });
    render(<Header />);
    expect(await screen.findByText('a@b.c')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(api.calls.map((c) => c.path)).toContain('/auth/logout');
    expect(nav.router.push).toHaveBeenCalledWith('/login');
    expect(nav.router.refresh).toHaveBeenCalled();
  });
  it('signs out even if the request fails, and shows no account menu on auth pages or when signed out', async () => {
    mockApi({ 'GET /auth/me': { user: { email: 'a@b.c' } }, 'POST /auth/logout': { status: 500, body: null } });
    render(<Header />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(nav.router.push).toHaveBeenCalledWith('/login');
  });
  it('hides the menu when not signed in, and on auth pages', async () => {
    const api = mockApi({ 'GET /auth/me': { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: '' } } } });
    render(<Header />);
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    nav.pathname = '/login';
    const again = mockApi({});
    render(<Header />);
    expect(again.calls).toHaveLength(0);
  });
});

describe('AuthForm', () => {
  const assign = vi.fn();
  beforeEach(() => {
    assign.mockReset();
    vi.stubGlobal('location', { ...window.location, assign });
  });
  it('signs in and returns to a safe next path', async () => {
    nav.searchParams = new URLSearchParams('next=/kits/k1');
    const api = mockApi({ 'POST /auth/login': { user: { id: '1', email: 'a@b.c' } } });
    render(<AuthForm mode="login" />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.c');
    await userEvent.type(screen.getByLabelText('Password'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/kits/k1'));
    expect(api.calls[0]!.body).toEqual({ email: 'a@b.c', password: 'password123' });
  });
  it('refuses open redirects and explains expired sessions', async () => {
    nav.searchParams = new URLSearchParams('next=//evil.example&reason=SESSION_EXPIRED');
    mockApi({ 'POST /auth/login': {} });
    render(<AuthForm mode="login" />);
    expect(screen.getByText(/session expired/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/kits'));
  });
  it('shows field errors and general errors on registration', async () => {
    nav.searchParams = new URLSearchParams('reason=UNKNOWN');
    let n = 0;
    mockApi({
      'POST /auth/register': () =>
        n++ === 0
          ? { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'bad', details: [{ path: 'email', message: 'Invalid email' }, { path: 'password', message: 'Too short' }, { message: 'no path' }] } } }
          : { status: 409, body: { error: { code: 'EMAIL_TAKEN', message: 'An account with this email already exists' } } },
    });
    render(<AuthForm mode="register" />);
    expect(screen.getByText('At least 8 characters.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Invalid email')).toBeInTheDocument();
    expect(screen.getByText('Too short')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });
});

describe('pages', () => {
  it('layout renders the shell with a skip link and metadata', () => {
    mockApi({ 'GET /auth/me': { status: 401, body: null } });
    const html = renderToStaticMarkup(<RootLayout><p>child</p></RootLayout>);
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/Skip to content/);
    expect(html).toMatch(/<main id="main"[^>]*><p>child<\/p>/);
    expect(metadata.title).toBe('Interview Prep Kit');
    expect(viewport.width).toBe('device-width');
  });
  it('home redirects to the kit list; auth pages render their forms', () => {
    Home();
    expect(nav.redirect).toHaveBeenCalledWith('/kits');
    render(<LoginPage />);
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    render(<RegisterPage />);
    expect(screen.getByRole('heading', { name: 'Create an account' })).toBeInTheDocument();
  });
});
