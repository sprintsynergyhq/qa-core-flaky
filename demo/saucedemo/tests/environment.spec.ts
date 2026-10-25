import { expect, test } from '@playwright/test';
import { shouldFlake } from '../support/seed';

const TEST_ID = 'environment-net';

test('aborted document fails page.goto', async ({ page }, testInfo) => {
  if (shouldFlake(TEST_ID, testInfo.retry)) {
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() === 'document') {
        await route.abort('internetdisconnected');
        return;
      }
      await route.continue();
    });
  }
  await page.goto('/');
  await expect(page.locator('[data-test="username"]')).toBeVisible();
});
