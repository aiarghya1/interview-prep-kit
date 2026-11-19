import { expect, type Page } from '@playwright/test';

export const ACME = 'http://localhost:8199/acme/';
export const JD = `Senior Backend Engineer — Payments

Requirements:
- 5+ years of backend development experience
- Strong experience with Node.js and TypeScript
- Experience mentoring other engineers

Nice to have:
- Familiarity with Kubernetes`;

let n = 0;
export async function signUp(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Email').fill(`e2e-${Date.now()}-${n++}@example.com`);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/kits$/);
}

export async function buildKit(page: Page, jd = JD, url = ACME, days = '3') {
  await page.getByLabel('Job description').fill(jd);
  await page.getByLabel('Company website').fill(url);
  await page.getByLabel('Days until interview').fill(days);
  await page.getByRole('button', { name: 'Build my kit' }).click();
  await expect(page).toHaveURL(/\/kits\/[a-f0-9]{24}/);
}
