import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Local file:// cases that produce Playwright 1.60.0 error text for the
 * cause rules. The outcomes config ignores this file so the committed
 * outcomes report stays the seven-test fixture. Run it with
 * playwright.causes.config.ts. Navigation uses a closed localhost port.
 */
const pageUrl = pathToFileURL(path.join(import.meta.dirname, '../pages/causes.html')).href;

test('strict mode', async ({ page }) => {
  await page.goto(pageUrl);
  await page.getByRole('button', { name: 'Remove' }).click({ timeout: 500 });
});

test('element not found', async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.getByRole('button', { name: 'Missing' })).toBeVisible({ timeout: 400 });
});

test('locator unresolved', async ({ page }) => {
  await page.goto(pageUrl);
  await page.locator('#missing').click({ timeout: 400 });
});

test('count zero', async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.getByRole('listitem')).toHaveCount(1, { timeout: 400 });
});

test('visible timeout', async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.locator('#hidden')).toBeVisible({ timeout: 400 });
});

test('test timeout', async ({ page }) => {
  test.setTimeout(800);
  await page.goto(pageUrl);
  await page.getByRole('button', { name: 'Missing' }).waitFor({ timeout: 0 });
});

test('intercepts pointer events', async ({ page }) => {
  await page.goto(pageUrl);
  await page.evaluate(() => {
    const cover = document.createElement('div');
    cover.id = 'cover';
    cover.style.position = 'fixed';
    cover.style.inset = '0';
    document.body.appendChild(cover);
  });
  await page.locator('#go').click({ timeout: 400 });
});

test('value mismatch one', async ({ page }) => {
  await page.setContent('<h1 id="n">1</h1>');
  await expect(page.locator('#n')).toHaveText('9', { timeout: 400 });
});

test('value mismatch two', async ({ page }) => {
  await page.setContent('<h1 id="n">2</h1>');
  await expect(page.locator('#n')).toHaveText('9', { timeout: 400 });
});

test('closed port', async ({ page }) => {
  await page.goto('http://127.0.0.1:54321/', { timeout: 2000 });
});
