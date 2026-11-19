import { expect, test } from '@playwright/test';
import { buildKit, JD, signUp } from './helpers';

test('batch upload from a real file creates several kits', async ({ page }) => {
  await signUp(page);
  const cases = [
    { jd: JD, company_url: 'http://localhost:8199/acme/', days: 2 },
    { jd: 'Frontend developer wanted. Must know React.', company_url: 'http://localhost:8199/globex/' },
  ];
  await page.getByLabel('Batch file').setInputFiles({ name: 'roles.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(cases)) });
  await expect(page.getByText('localhost:8199/globex/ · 5d')).toBeVisible();
  await page.getByRole('button', { name: 'Create 2 kits' }).click();
  await expect(page.getByText(/2 kit\(s\) queued/)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Your kits' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByText('Ready')).toHaveCount(2, { timeout: 60_000 });
});

test('a thin posting and an unreachable company are reported honestly', async ({ page }) => {
  await signUp(page);
  await buildKit(page, 'Frontend developer wanted. Must know React.', 'http://localhost:8199/does-not-exist/', '1');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/could not be retrieved/)).toBeVisible();
  await expect(page.getByText(/Thin job description/)).toBeVisible();
  await expect(page.getByText(/deliberately sparse instead of guessed/)).toBeVisible();
});

test('submitting the same posting twice opens the existing kit', async ({ page }) => {
  await signUp(page);
  await buildKit(page);
  await expect(page.getByRole('heading', { level: 1, name: /Senior Backend Engineer/ })).toBeVisible();
  const first = page.url();
  await page.goto('/kits');
  await buildKit(page);
  await expect(page).toHaveURL(`${first}?note=existing`);
  await expect(page.getByText(/already have a kit for this posting/)).toBeVisible();
});
