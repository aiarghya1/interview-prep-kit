import { expect, test } from '@playwright/test';
import { buildKit, JD, signUp } from './helpers';

test('sign up, build a kit, edit, reorder, regenerate without losing edits, schedule, practise, stories, sign out', async ({ page }) => {
  await test.step('protected pages need a session', async () => {
    await page.goto('/kits');
    await expect(page).toHaveURL(/\/login\?next=%2Fkits/);
  });

  await signUp(page);

  await test.step('generation shows progress and lands in the workspace', async () => {
    await buildKit(page);
    await expect(page.getByRole('heading', { level: 1, name: /Senior Backend Engineer/ })).toBeVisible();
    await expect(page.getByText('Screen', { exact: true })).toBeVisible(); // hiring stages found in the handbook
    await expect(page.getByText('Must').first()).toBeVisible();
  });

  const tab = (name: string) => page.getByRole('tab', { name });
  const technical = page.locator('section', { has: page.getByRole('heading', { name: /^Technical \(/ }) });
  const prompts = () => technical.getByRole('textbox', { name: /^Technical question \d+$/ });
  const values = () => prompts().evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value));

  await test.step('inline edit saves without a round trip per keystroke', async () => {
    await tab('Questions').click();
    const first = prompts().first();
    await first.click();
    await first.fill('My own wording of the first question');
    await first.blur();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await expect(technical.getByText('Edited').first()).toBeVisible();
  });

  await test.step('keyboard drag-and-drop reorders and persists', async () => {
    const before = await values();
    await technical.getByRole('button', { name: /^Reorder Technical question 1\./ }).focus();
    // Human-speed keystrokes: dnd-kit measures positions between them.
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    await page.keyboard.press('Space');
    await expect.poll(() => prompts().nth(1).inputValue()).toBe(before[0]);
    await expect(page.getByText('All changes saved')).toBeVisible();
  });

  await test.step('regenerating the category keeps the edited question', async () => {
    await technical.getByRole('button', { name: 'Regenerate technical' }).click();
    await expect(page.getByText(/Regenerated questions:technical/)).toBeVisible();
    await expect(page.getByText(/kept 1 edited\/pinned\/hand-written/)).toBeVisible();
    expect(await values()).toContain('My own wording of the first question');
  });

  await test.step('adding a question marks the schedule stale; rebuild fixes it', async () => {
    await page.getByRole('button', { name: '+ Add a technical question' }).click();
    await page.getByLabel('New question').fill('Walk me through a production incident you led');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await tab('Schedule').click();
    await expect(page.getByText(/Questions changed since this schedule was built/)).toBeVisible();
    await page.getByRole('button', { name: 'Rebuild now' }).click();
    await expect(page.getByText(/Questions changed since/)).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Day 3' })).toBeVisible();
  });

  await test.step('practice with the keyboard', async () => {
    await tab('Practice').click();
    await page.getByRole('button', { name: 'Start session' }).click();
    await page.keyboard.press('Space');
    await expect(page.getByText('Answer', { exact: true })).toBeVisible();
    await page.keyboard.press('3');
    await expect(page.getByText(/^1 done ·/)).toBeVisible();
    await expect(page.getByText(/1 of \d+ cards practised/)).toBeVisible();
  });

  await test.step('story bank saves and analyses', async () => {
    await tab('Your stories').click();
    await page.getByRole('button', { name: '+ Add a story' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Experience mentoring other engineers/ }).first().click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  });

  await test.step('everything survives a reload', async () => {
    await page.reload();
    await tab('Questions').click();
    expect(await values()).toContain('My own wording of the first question');
    expect(await values()).toContain('Walk me through a production incident you led');
  });

  await test.step('sign out ends the session', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/kits');
    await expect(page).toHaveURL(/\/login/);
  });

  void JD;
});
