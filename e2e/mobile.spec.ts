import { expect, test } from '@playwright/test';
import { buildKit, signUp } from './helpers';

test('usable at phone width: no horizontal scrolling, tabs reachable', async ({ page }) => {
  await signUp(page);
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noSideScroll()).toBe(true);
  await buildKit(page);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await noSideScroll()).toBe(true);
  await page.getByRole('tab', { name: 'Your stories' }).click();
  await expect(page.getByRole('tab', { name: 'Your stories' })).toHaveAttribute('aria-selected', 'true');
  expect(await noSideScroll()).toBe(true);
});
