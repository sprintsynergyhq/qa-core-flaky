import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildTriageReport, parseJunit, parsePlaywrightJson } from '../dist/index.js';
import { shouldFlake } from '../demo/saucedemo/support/seed.ts';

const expected = JSON.parse(
  fs.readFileSync(new URL('../demo/saucedemo/expected-verdicts.json', import.meta.url), 'utf8'),
);
const jsonPath = new URL('../demo/saucedemo/reports/recorded-seed-443.json', import.meta.url);
const junitPath = new URL('../demo/saucedemo/reports/recorded-seed-443.junit.xml', import.meta.url);

const SAMPLE = [
  ['timing-image', 0],
  ['timing-image', 1],
  ['timing-wait', 0],
  ['timing-wait', 1],
  ['selectors-remove', 0],
  ['selectors-remove', 1],
  ['environment-net', 0],
  ['environment-net', 1],
  ['testdata-badge', 0],
  ['testdata-badge', 1],
  ['testdata-badge', 2],
];

const PASSED_IDS = [
  'healthy.spec.ts::chromium::inventory shows six products',
  'healthy.spec.ts::chromium::adding the backpack shows a badge of 1',
  'test-data.spec.ts::chromium::shared cart page > A adds one backpack',
];

test('the same seed and inputs return the same booleans', () => {
  const env = { FLAKE_SEED: '443', FLAKE_RATE: '0.5' };
  const first = SAMPLE.map(([id, retry]) => shouldFlake(id, retry, env));
  const second = SAMPLE.map(([id, retry]) => shouldFlake(id, retry, env));
  assert.deepEqual(second, first);
  assert.deepEqual(first, [true, false, true, false, true, false, true, false, true, true, false]);
});

test('a different seed differs on the fixed sample', () => {
  const seeded = SAMPLE.map(([id, retry]) => shouldFlake(id, retry, { FLAKE_SEED: '443', FLAKE_RATE: '0.5' }));
  const other = SAMPLE.map(([id, retry]) => shouldFlake(id, retry, { FLAKE_SEED: '1', FLAKE_RATE: '0.5' }));
  assert.notDeepEqual(other, seeded);
});

test('triage on the recorded JSON report matches expected-verdicts.json', () => {
  const parsed = parsePlaywrightJson(fs.readFileSync(jsonPath, 'utf8'), 'demo/saucedemo/reports/recorded-seed-443.json');
  const report = buildTriageReport(parsed.records);
  const byId = new Map(report.entries.map((entry) => [entry.id, entry]));
  const expectedIds = Object.keys(expected.tests);

  assert.deepEqual([...byId.keys()].sort(), [...expectedIds].sort());

  for (const id of expectedIds) {
    const entry = byId.get(id);
    const wanted = expected.tests[id];
    assert.ok(entry, id);
    assert.equal(entry.verdict, wanted.verdict, id);
    assert.equal(entry.causes[0]?.cause, wanted.cause, id);
  }

  for (const id of PASSED_IDS) {
    assert.equal(byId.has(id), false, id);
  }

  const records = new Map(parsed.records.map((record) => [record.id, record]));
  for (const id of expectedIds) {
    const attempts = records.get(id)?.attempts ?? [];
    const first = attempts.find((attempt) => attempt.retry === 0);
    assert.ok(first, id);
    assert.notEqual(first.status, 'passed', id);
    if (wantedFlaky(id)) {
      assert.equal(attempts.some((attempt) => attempt.retry > 0 && attempt.status === 'passed'), true, id);
    } else {
      assert.equal(attempts.every((attempt) => attempt.status !== 'passed'), true, id);
      assert.ok(attempts.length >= 2, id);
    }
  }
});

test('JUnit omits flaky passes and keeps one attempt for the failures', () => {
  const parsed = parseJunit(fs.readFileSync(junitPath, 'utf8'), 'demo/saucedemo/reports/recorded-seed-443.junit.xml');
  assert.ok(
    parsed.warnings.some((warning) =>
      warning.includes('junit report has no per-attempt data; flaky detection needs the JSON report or reruns'),
    ),
  );

  const report = buildTriageReport(parsed.records);
  const byId = new Map(report.entries.map((entry) => [entry.id, entry]));
  const records = new Map(parsed.records.map((record) => [record.id, record]));

  for (const id of Object.keys(expected.tests)) {
    if (!wantedFlaky(id)) continue;
    assert.equal(byId.has(id), false, id);
    assert.equal(records.get(id)?.outcome, 'passed', id);
    assert.equal(records.get(id)?.attempts.length, 1, id);
  }

  const broken = byId.get('broken.spec.ts::chromium::typo locator never finds the backpack button');
  assert.ok(broken);
  assert.equal(broken.verdict, 'broken-test');
  assert.equal(broken.causes[0]?.cause, 'selectors');
  assert.equal(broken.confidence, 'low');
  assert.equal(broken.attempts.total, 1);
  assert.equal(broken.attempts.failed, 1);

  const realBug = byId.get(
    'real-bug.spec.ts::chromium::problem user image src differs from the standard catalog',
  );
  assert.ok(realBug);
  assert.equal(realBug.verdict, 'needs-more-runs');
  assert.equal(realBug.causes[0]?.cause, 'unknown');
  assert.equal(realBug.confidence, 'low');
  assert.equal(realBug.attempts.total, 1);
  assert.equal(realBug.attempts.failed, 1);
  assert.equal(byId.size, 2);
});

function wantedFlaky(id) {
  return expected.tests[id].verdict === 'flaky';
}
