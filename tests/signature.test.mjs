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
});

test('a fractional duration and a private tmp path normalize', () => {
  const left = 'Timeout 1.5ms exceeded at /private/tmp/run-12/a.txt';
  const right = 'Timeout 30ms exceeded at /private/tmp/run-9/a.txt';
  assert.equal(normalizeErrorSignature(left), normalizeErrorSignature(right));
  assert.match(normalizeErrorSignature(left), /Nms/);
  assert.match(normalizeErrorSignature(left), /\/private\/tmp\/run-N\/a.txt/);
});
