import { expect, test } from '@playwright/test';
import { login } from '../support/login';
import { shouldFlake } from '../support/seed';

const TEST_ID = 'selectors-remove';

test('unscoped Remove is strict when two items were added', async ({ page }, testInfo) => {
  await login(page);
  const count = shouldFlake(TEST_ID, testInfo.retry) ? 2 : 1;
  const addButtons = ['add-to-cart-sauce-labs-backpack', 'add-to-cart-sauce-labs-bike-light'];
  for (let index = 0; index < count; index += 1) {
    await page.locator(`[data-test="${addButtons[index]}"]`).click();
  }
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveCount(0);
});
