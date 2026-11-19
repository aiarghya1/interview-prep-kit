import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateKitForm } from '@/components/CreateKitForm';
import { BatchUpload } from '@/components/BatchUpload';
import { KitList, StatusBadge, useKitList } from '@/components/KitList';
import KitsPage from '@/app/kits/page';
import type { KitSummary } from '@/lib/types';
import { mockApi } from './http';
import { nav } from './nav';

afterEach(() => vi.unstubAllGlobals());

const summary = (o: Partial<KitSummary> = {}): KitSummary => ({
  id: 'k1', status: 'ready', title: 'Backend Engineer', company: 'Acme', days: 5, questions: 12, flashcards: 8, lastProgress: null, error: null, createdAt: '', ...o,
});
const JD = 'Senior Backend Engineer. Requirements: Node.js.';

describe('CreateKitForm', () => {
  it('validates fields locally and focuses the first problem', async () => {
    mockApi({});
    render(<CreateKitForm />);
    await userEvent.clear(screen.getByLabelText('Days until interview'));
    await userEvent.type(screen.getByLabelText('Days until interview'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Build my kit' }));
    expect(screen.getByText(/at least 20 characters/)).toBeInTheDocument();
    expect(screen.getByText(/Enter the company website/)).toBeInTheDocument();
    expect(screen.getByText(/whole number of days/)).toBeInTheDocument();
    expect(screen.getByLabelText('Job description')).toHaveFocus();
  });

  it('focuses the company field when that is the first problem', async () => {
    mockApi({});
    render(<CreateKitForm />);
    await userEvent.type(screen.getByLabelText('Job description'), JD);
    await userEvent.click(screen.getByRole('button', { name: 'Build my kit' }));
    expect(screen.getByLabelText('Company website')).toHaveFocus();
  });

  it('submits, uses the day presets, and navigates (noting duplicates)', async () => {
    const onCreated = vi.fn();
    let dedupe: string | false = false;
    const api = mockApi({ 'POST /kits': () => ({ kit: summary({ id: 'new' }), deduplicated: dedupe }) });
    const first = render(<CreateKitForm onCreated={onCreated} />);
    await userEvent.type(screen.getByLabelText('Job description'), JD);
    await userEvent.type(screen.getByLabelText('Company website'), 'acme.com');
    await userEvent.click(screen.getByRole('button', { name: '7' }));
    expect(screen.getByRole('button', { name: '7' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Build my kit' }));
    await waitFor(() => expect(nav.router.push).toHaveBeenCalledWith('/kits/new'));
    expect(api.calls[0]!.body).toEqual({ jd: JD, company_url: 'acme.com', days: 7 });
    expect(onCreated).toHaveBeenCalled();
    // While navigating away the button stays busy, so a duplicate submit is a fresh form.
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    dedupe = 'existing';
    first.unmount();
    render(<CreateKitForm />);
    await userEvent.type(screen.getByLabelText('Job description'), JD);
    await userEvent.type(screen.getByLabelText('Company website'), 'acme.com');
    await userEvent.click(screen.getByRole('button', { name: 'Build my kit' }));
    await waitFor(() => expect(nav.router.push).toHaveBeenCalledWith('/kits/new?note=existing'));
  });

  it('shows server field errors and general errors', async () => {
    let n = 0;
    mockApi({
      'POST /kits': () =>
        n++ === 0
          ? { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'x', details: [{ path: 'company_url', message: 'Server says no' }, { message: 'pathless' }] } } }
          : { status: 429, body: { error: { code: 'TOO_MANY_ACTIVE', message: 'Too many generating' } } },
    });
    render(<CreateKitForm />);
    await userEvent.type(screen.getByLabelText('Job description'), JD);
    await userEvent.type(screen.getByLabelText('Company website'), 'acme.com');
    await userEvent.click(screen.getByRole('button', { name: 'Build my kit' }));
    expect(await screen.findByText('Server says no')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Build my kit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many generating');
  });
});

describe('BatchUpload', () => {
  const upload = (name: string, content: string, type = 'application/json') => userEvent.upload(screen.getByLabelText('Batch file'), new File([content], name, { type }));

  it('previews valid rows and warnings, then submits and reports results', async () => {
    const onCreated = vi.fn();
    const api = mockApi({ 'POST /kits/batch': { results: [{ index: 0, kit: { id: 'a' } }, { index: 1, error: { message: 'Rejected by server' } }] } });
    render(<BatchUpload onCreated={onCreated} />);
    await upload('roles.json', JSON.stringify([{ jd: JD, company_url: 'a.com' }, { jd: JD, company_url: 'b.com', days: 3 }, { jd: 'short', company_url: 'c.com' }]));
    expect(await screen.findByText(/1 row\(s\) need attention/)).toBeInTheDocument();
    expect(screen.getByText('a.com · 5d')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create 2 kits' }));
    expect(await screen.findByText(/1 kit\(s\) queued, 1 rejected/)).toBeInTheDocument();
    expect(screen.getByText(/Row 2: Rejected by server/)).toBeInTheDocument();
    expect(api.calls[0]!.body).toEqual({ items: [{ jd: JD, company_url: 'a.com', days: 5 }, { jd: JD, company_url: 'b.com', days: 3 }] });
    expect(onCreated).toHaveBeenCalled();
  });

  it('handles a single row, all-success results, empty files, big files and request errors', async () => {
    let fail = false;
    mockApi({ 'POST /kits/batch': () => (fail ? { status: 500, body: { error: { code: 'INTERNAL', message: 'Server broke' } } } : { results: [{ index: 0, kit: { id: 'a' } }] }) });
    render(<BatchUpload onCreated={() => {}} />);
    await upload('one.csv', `jd,company_url\n"${JD}",a.com\n`, 'text/csv');
    await userEvent.click(await screen.findByRole('button', { name: 'Create 1 kit' }));
    expect(await screen.findByText('Batch submitted')).toBeInTheDocument();
    await upload('empty.json', '[]');
    expect(await screen.findByText('No usable rows in empty.json.')).toBeInTheDocument();
    await upload('big.json', 'x'.repeat(500_001));
    expect(screen.getByRole('alert')).toHaveTextContent('larger than 500 KB');
    fail = true;
    await upload('one.json', JSON.stringify([{ jd: JD, company_url: 'a.com' }]));
    await userEvent.click(await screen.findByRole('button', { name: 'Create 1 kit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server broke');
    await act(async () => {
      await userEvent.upload(screen.getByLabelText('Batch file'), []);
    });
  });
});

describe('KitList', () => {
  function Harness() {
    return <KitList list={useKitList()} />;
  }

  it('shows loading, then kits with status, progress and errors; deletes with confirmation', async () => {
    const api = mockApi({
      'GET /kits': { kits: [
        summary(),
        summary({ id: 'k2', status: 'running', lastProgress: 'Crawling', days: 1, company: '' }),
        summary({ id: 'k3', status: 'failed', error: { code: 'X', message: 'Model unavailable' } }),
        summary({ id: 'k4', status: 'queued' }),
      ] },
      'DELETE /kits/k1': { status: 204 },
    });
    render(<Harness />);
    expect(screen.getByText(/Loading your kits/)).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Your kits' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('Crawling')).toBeInTheDocument();
    expect(screen.getByText('Model unavailable')).toBeInTheDocument();
    expect(screen.getByText('Acme · 5 days · 12 questions · 8 cards')).toBeInTheDocument();
    expect(screen.getByText('1 day')).toBeInTheDocument();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(screen.getAllByRole('button', { name: /Delete kit/ })[0]!);
    expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    await userEvent.click(screen.getAllByRole('button', { name: /Delete kit/ })[0]!);
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
  });

  it('restores the list if a delete fails, polls while kits generate, and offers retry on load errors', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let n = 0;
    mockApi({
      'GET /kits': () => (n++ === 0 ? { status: 500, body: { error: { code: 'X', message: 'List failed' } } } : { kits: [summary({ status: n < 3 ? 'running' : 'ready' })] }),
      'DELETE /kits/k1': { status: 500, body: null },
    });
    render(<Harness />);
    expect(await screen.findByText('List failed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Generating')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: /Delete kit/ }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
  });

  it('empty state, and status badges', async () => {
    mockApi({ 'GET /kits': { kits: [] } });
    render(<Harness />);
    expect(await screen.findByText('No kits yet')).toBeInTheDocument();
    render(<><StatusBadge status="queued" /><StatusBadge status="failed" /></>);
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});

describe('kits page', () => {
  it('lays out the create form, batch upload and list', async () => {
    mockApi({ 'GET /kits': { kits: [] } });
    render(<KitsPage />);
    expect(screen.getByRole('heading', { name: 'New prep kit' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Preparing for several roles?' })).toBeInTheDocument();
    expect(await screen.findByText('No kits yet')).toBeInTheDocument();
  });
});
