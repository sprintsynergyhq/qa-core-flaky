import { defineConfig, devices } from '@playwright/test';

function device(name: string) {
  const found = devices[name];
  if (!found) throw new Error(`Missing Playwright device ${name}`);
  return found;
}

export default defineConfig({
  testDir: 'tests',
  testMatch: 'html-report.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  outputDir: 'test-results/html-report',
  use: {
    acceptDownloads: false,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...device('Desktop Chrome') } },
    { name: 'firefox', use: { ...device('Desktop Firefox') } },
    { name: 'webkit', use: { ...device('Desktop Safari') } },
  ],
});
