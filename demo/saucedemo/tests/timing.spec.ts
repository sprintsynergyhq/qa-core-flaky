import { expect, test } from '@playwright/test';
import { login } from '../support/login';
import { shouldFlake } from '../support/seed';

const IMAGE_ID = 'timing-image';
const WAIT_ID = 'timing-wait';

test('image delay fails the short visibility check', async ({ page }, testInfo) => {
  const flake = shouldFlake(IMAGE_ID, testInfo.retry);
  // Checked 25 Oct 2026 UTC: product images are /assets/*.jpg.
  // The older /static/media/ path is not what this site serves.
  // A delayed image stays hidden, so the short visibility check fails.
  await page.route('**/assets/**/*.jpg', async (route) => {
    if (flake) await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });
  await login(page);
  const firstItemImage = page.locator('[data-test="inventory-item"] img').first();
  await expect(firstItemImage).toBeVisible({ timeout: 1000 });
});

test('waitForTimeout before add to cart', async ({ page }, testInfo) => {
  test.setTimeout(8000);
  await login(page);
  // waitForTimeout before the click is the antipattern being demonstrated.
  if (shouldFlake(WAIT_ID, testInfo.retry)) await page.waitForTimeout(12000);
  await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
  await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText('1');
});
