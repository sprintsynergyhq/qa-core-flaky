import { defineConfig, devices } from '@playwright/test';

/**
 * Runs fixtures/pw-project/tests/causes.spec.ts only. The JSON report is
 * written under the system temp directory and is not committed. The
 * outcomes fixture config ignores this spec.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: 'causes.spec.ts',
  retries: 0,
  workers: 1,
  timeout: 10000,
  expect: { timeout: 1000 },
  outputDir: '/tmp/qa-core-flaky-causes-results',
  reporter: [['json', { outputFile: '/tmp/qa-core-flaky-causes.json' }]],
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
