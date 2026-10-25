import { defineConfig } from '@playwright/test';

/**
 * Live SauceDemo demo. One worker, two retries.
 * Unit tests and CI do not run this config. They read the recorded reports.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 2,
  timeout: 30_000,
  outputDir: './test-results',
  reporter: [
    ['json', { outputFile: 'reports/live.json' }],
    ['junit', { outputFile: 'reports/live.junit.xml' }],
  ],
  use: {
    baseURL: 'https://www.saucedemo.com',
    testIdAttribute: 'data-test',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
