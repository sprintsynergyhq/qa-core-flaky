import { expect, test } from '@playwright/test';
import { login } from '../support/login';

test('inventory shows six products', async ({ page }) => {
  await login(page);
  await expect(page.locator('[data-test="inventory-item"]')).toHaveCount(6);
});

test('adding the backpack shows a badge of 1', async ({ page }) => {
  await login(page);
  await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
  await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText('1');
});
