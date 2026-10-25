import { expect, test } from '@playwright/test';
import { login } from '../support/login';

/**
 * problem_user, 25 Oct 2026 UTC, three logins: every product image src was
 * /assets/sl-404-Cq1a9k9X.jpg. standard_user's backpack image on that date
 * contained sauce-backpack. This expects that catalog src. The same mismatch
 * on every attempt is a likely real bug, not a seeded flake.
 */
test('problem user image src differs from the standard catalog', async ({ page }) => {
  await login(page, 'problem_user');
  const src = await page.locator('[data-test="inventory-item"] img').first().getAttribute('src');
  expect(src ?? '').toContain('sauce-backpack');
});
