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

test('a fractional duration and a private tmp path normalize', () => {
  const left = 'Timeout 1.5ms exceeded at /private/tmp/run-12/a.txt';
  const right = 'Timeout 30ms exceeded at /private/tmp/run-9/a.txt';
  assert.equal(normalizeErrorSignature(left), normalizeErrorSignature(right));
  assert.match(normalizeErrorSignature(left), /Nms/);
  assert.match(normalizeErrorSignature(left), /\/private\/tmp\/run-N\/a.txt/);
});
