import { expect, test } from '@playwright/test';
import { login } from '../support/login';

test('typo locator never finds the backpack button', async ({ page }) => {
  await login(page);
  // click() on a missing id times out without "element(s) not found".
  // toBeVisible on this typo locator does print that error.
  await expect(page.locator('#add-to-cart-sauce-labs-bakpack')).toBeVisible({ timeout: 1000 });
});
