import { defineConfig, devices } from '@playwright/test';

/**
 * Config for `qa-core-flaky rerun` on the local order pair.
 * The main fixture config ignores order.spec.ts so the outcomes report
 * stays the seven-test fixture. This file matches only the order pair.
 * It does not use the network.
 */
export default defineConfig({
  retries: 0,
  workers: 1,
  testMatch: ['**/order.spec.ts'],
  outputDir: 'test-results',
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        screenshot: 'off',
        trace: 'off',
        video: 'off',
      },
    },
  ],
});
