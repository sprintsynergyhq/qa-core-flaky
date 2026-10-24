import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

const appUrl = pathToFileURL(path.join(import.meta.dirname, '../pages/app.html')).href;

test('always passes', async ({ page }) => {
  await page.goto(appUrl);
  await expect(page.getByRole('heading', { name: 'Ready' })).toBeVisible();
});

test('flaky by retry', async ({ page }, testInfo) => {
  await page.goto(appUrl);
  if (testInfo.retry === 0) {
    await expect(page.getByRole('heading', { name: 'Ready' })).toHaveText('not ready');
  } else {
    await expect(page.getByRole('heading', { name: 'Ready' })).toHaveText('Ready');
  }
});

test('always fails', async ({ page }) => {
  await page.goto(appUrl);
  await expect(page.getByRole('heading', { name: 'Ready' })).toHaveText('a different heading');
});

test('times out', async ({ page }) => {
  test.setTimeout(1000);
  await page.goto(appUrl);
  await page.getByRole('button', { name: 'Never Appears' }).waitFor();
});

test.skip('skipped test', async () => {
  // The body does not run. Playwright records a skipped result.
});

test('expected to fail', async ({ page }) => {
  test.fail();
  await page.goto(appUrl);
  await expect(page.getByRole('heading', { name: 'Ready' })).toHaveText('not the heading');
});

test.describe('Cart', () => {
  test('shows the heading', async ({ page }) => {
    await page.goto(appUrl);
    await expect(page.getByRole('heading', { name: 'Ready' })).toBeVisible();
  });
});
