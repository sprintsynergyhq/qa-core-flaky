import type { Page } from '@playwright/test';

/** Public SauceDemo password. There is no other credential in this demo. */
export const DEMO_PASSWORD = 'secret_sauce';

/** Absolute origin. A page opened from `browser.newPage()` has no baseURL. */
export const DEMO_ORIGIN = 'https://www.saucedemo.com';

/**
 * Log in with `data-test` locators.
 * The default user is standard_user. Callers pass a special user only after
 * a live run has shown what that user does.
 */
export async function login(page: Page, username = 'standard_user'): Promise<void> {
  await page.goto(`${DEMO_ORIGIN}/`);
  await page.locator('[data-test="username"]').fill(username);
  await page.locator('[data-test="password"]').fill(DEMO_PASSWORD);
  await page.locator('[data-test="login-button"]').click();
  await page.locator('[data-test="inventory-container"]').waitFor();
}
