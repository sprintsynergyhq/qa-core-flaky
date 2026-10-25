import { expect, test, type Page } from '@playwright/test';
import { login } from '../support/login';
import { shouldFlake } from '../support/seed';

const TEST_ID = 'testdata-badge';

const ADD = [
  'add-to-cart-sauce-labs-backpack',
  'add-to-cart-sauce-labs-bike-light',
  'add-to-cart-sauce-labs-bolt-t-shirt',
];

let shared: Page;

async function removeAll(page: Page): Promise<void> {
  const remove = page.getByRole('button', { name: 'Remove' });
  while ((await remove.count()) > 0) {
    await remove.first().click();
  }
}

async function setCount(page: Page, count: number): Promise<void> {
  await removeAll(page);
  for (let index = 0; index < count; index += 1) {
    await page.locator(`[data-test="${ADD[index]}"]`).click();
  }
}

test.describe('shared cart page', () => {
  test.beforeAll(async ({ browser }) => {
    shared = await browser.newPage();
    await login(shared);
  });

  test.afterAll(async () => {
    await shared.close();
  });

  test('A adds one backpack', async () => {
    await shared.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
    await expect(shared.locator('[data-test="shopping-cart-badge"]')).toHaveText('1');
  });

  test('B expects the badge A added', async ({}, testInfo) => {
    const flake = shouldFlake(TEST_ID, testInfo.retry);
    if (flake) {
      // Attempt 0 receives 2. Attempt 1 receives 3. The values differ on purpose.
      await setCount(shared, testInfo.retry === 0 ? 2 : 3);
    } else if (testInfo.retry > 0) {
      // A previous attempt changed the shared cart. Put back the one item A added.
      await setCount(shared, 1);
    }
    await expect(shared.locator('[data-test="shopping-cart-badge"]')).toHaveText('1');
  });
});
