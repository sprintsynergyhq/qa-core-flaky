import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeErrorSignature } from '../dist/index.js';

test('durations, ports, line and column, tmp paths, and ids normalize together', () => {
  const first = [
    'Timeout 5000ms exceeded.',
    'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1111/',
    'at tests/cart.spec.ts:10:2',
    'see /tmp/playwright-artifacts-123/trace.zip',
    'id=99 uuid 123e4567-e89b-12d3-a456-426614174000',
  ].join('\n');
  const second = [
    'Timeout 20ms exceeded.',
    'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:54321/',
    'at tests/cart.spec.ts:40:8',
    'see /tmp/playwright-artifacts-7/trace.zip',
    'id=1000 uuid 123e4567-e89b-12d3-a456-426614174099',
  ].join('\n');
  assert.equal(normalizeErrorSignature(first), normalizeErrorSignature(second));
  assert.equal(normalizeErrorSignature(first), normalizeErrorSignature(first));
});

test('different assertions keep different signatures', () => {
  const text = 'Error: expect(locator).toHaveText(expected) failed\nReceived: "1"';
  const count = 'Error: expect(locator).toHaveCount(expected) failed\nReceived: "1"';
  assert.notEqual(normalizeErrorSignature(text), normalizeErrorSignature(count));
  const otherValue = 'Error: expect(locator).toHaveText(expected) failed\nReceived: "2"';
  assert.notEqual(normalizeErrorSignature(text), normalizeErrorSignature(otherValue));
});

test('a long token does not stall line and column normalization', () => {
  const text = 'a'.repeat(80000);
  const started = Date.now();
  const signature = normalizeErrorSignature(text);
  assert.equal(Date.now() - started < 1000, true);
  assert.equal(signature, text);
});

test('call-log repeat counts share a signature', () => {
  const left = '9 × locator resolved to <button>Add</button>\n    - waiting for getByRole';
  const right = '2 × locator resolved to <button>Add</button>\n    - waiting for getByRole';
  assert.equal(normalizeErrorSignature(left), normalizeErrorSignature(right));
  assert.match(normalizeErrorSignature(left), /N × locator/);
  const letter = '9 x locator resolved to 1 element';
  const other = '3 x locator resolved to 1 element';
  assert.equal(normalizeErrorSignature(letter), normalizeErrorSignature(other));
  const received = 'Received: "9 x"';
  assert.equal(normalizeErrorSignature(received), received);
  const dashed = '  - 9 x locator.click';
  const dashedOther = '  - 2 × locator.click';
  assert.equal(normalizeErrorSignature(dashed), normalizeErrorSignature(dashedOther));
  assert.match(normalizeErrorSignature(dashed), /N × locator/);
});

test('a count inside an assertion value does not share a signature', () => {
  const toBe = (expected, received) =>
    ['Error: expect(received).toBe(expected) // Object.is equality', '', `Expected: "${expected}"`, `Received: "${received}"`].join(
      '\n',
    );
  const times = ['2 × 4', '3 × 4', '5 × 4'].map((received) => normalizeErrorSignature(toBe('1 × 4', received)));
  assert.notEqual(times[0], times[1]);
  assert.notEqual(times[1], times[2]);
  assert.match(times[0], /Expected: "1 × 4"/);
  assert.match(times[0], /Received: "2 × 4"/);

  const marks = ['2×', '3×', '5×'].map((received) => normalizeErrorSignature(toBe('1×', received)));
  assert.notEqual(marks[0], marks[1]);
  assert.notEqual(marks[1], marks[2]);
  assert.match(marks[0], /Received: "2×"/);

  const text = (received) =>
    [
      'Error: expect(locator).toHaveText(expected) failed',
      `Locator: locator('[data-test="item"]')`,
      'Expected: "Backpack"',
      `Received: "${received}"`,
    ].join('\n');
  const backpack = ['2 × Backpack', '3 × Backpack', '5 × Backpack'].map((received) => normalizeErrorSignature(text(received)));
  assert.notEqual(backpack[0], backpack[1]);
  assert.notEqual(backpack[1], backpack[2]);
  assert.match(backpack[0], /Received: "2 × Backpack"/);
});

test('a fractional duration and a private tmp path normalize', () => {
  const left = 'Timeout 1.5ms exceeded at /private/tmp/run-12/a.txt';
  const right = 'Timeout 30ms exceeded at /private/tmp/run-9/a.txt';
  assert.equal(normalizeErrorSignature(left), normalizeErrorSignature(right));
  assert.match(normalizeErrorSignature(left), /Nms/);
  assert.match(normalizeErrorSignature(left), /\/private\/tmp\/run-N\/a.txt/);
});
