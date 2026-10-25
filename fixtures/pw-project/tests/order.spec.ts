import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * Deterministic order pair. The writer creates a marker. The reader expects it.
 * In file order the reader passes. Run alone, the reader fails.
 * afterAll removes the marker so a local run does not leave the file behind.
 */
const marker = path.join(import.meta.dirname, '.order-marker');

test.afterAll(() => {
  fs.rmSync(marker, { force: true });
});

test('order writer sets the marker', () => {
  fs.writeFileSync(marker, 'set');
  expect(fs.existsSync(marker)).toBe(true);
});

test('order reader expects the marker', () => {
  expect(fs.existsSync(marker), 'marker missing').toBe(true);
});
