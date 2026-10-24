import { defineConfig, devices } from '@playwright/test';

/**
 * Local fixture project. It serves pages/app.html over file:// and does not
 * use the network. The JSON reporter writes the report that
 * scripts/make-fixtures.mjs then sanitizes.
 *
 * testDir is left unset on purpose. Playwright 1.60.0 stores config.rootDir
 * as the resolved testDir when testDir is set. Leaving it unset keeps
 * rootDir as this config's directory, so spec paths stay like
 * tests/outcomes.spec.ts.
 */
export default defineConfig({
  retries: 2,
  workers: 1,
  outputDir: 'test-results',
  // A failing toHaveText should be an assertion error, not the test timeout.
  expect: { timeout: 1000 },
  reporter: [['json', { outputFile: '../reports/pw-1.60.0-outcomes.json' }]],
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
