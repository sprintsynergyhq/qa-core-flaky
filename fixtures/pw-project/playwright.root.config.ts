import { defineConfig } from '@playwright/test';

/**
 * Used by the root-dir child-process test. `testDir` is this folder's
 * `tests` directory, which is not the directory that holds this file.
 * Resolving `outcomes.spec.ts` succeeds only when that root is loaded.
 */
export default defineConfig({
  testDir: './tests',
});
