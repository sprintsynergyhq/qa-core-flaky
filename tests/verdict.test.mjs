import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { classifyCauses, decideVerdict, parsePlaywrightJson } from '../dist/index.js';

function attempt(status, message, retry = 0) {
  return {
    retry,
    status,
    durationMs: 10,
    errors: message === undefined ? [] : [{ message }],
    attachments: [],
  };
}

function record(title, attempts, source = {}) {
  return {
    id: `tests/a.spec.ts::chromium::${title}`,
    file: 'tests/a.spec.ts',
    project: 'chromium',
    titlePath: [title],
    expectedStatus: 'passed',
    outcome: attempts.some((item) => item.status === 'passed') && attempts.some((item) => item.status !== 'passed' && item.status !== 'skipped')
      ? 'flaky'
      : 'failed',
    attempts,
    source: {
      format: 'playwright-json',
      reportPath: 'fixture.json',
      ...source,
    },
  };
}

function verdictOf(attempts, source) {
  const item = record('sample', attempts, source);
  return decideVerdict([item], classifyCauses(item));
}

test('SEL-NOTFOUND on a consistent failure is a broken test', () => {
  const text = 'Error: element(s) not found';
  const three = verdictOf([attempt('failed', text, 0), attempt('failed', text, 1), attempt('failed', text, 2)]);
  assert.equal(three.verdict, 'broken-test');
  assert.equal(three.ruleId, 'BROKEN-TEST');
  assert.equal(three.confidence, 'high');
  assert.equal(three.cause, 'selectors');

  const one = verdictOf([attempt('failed', text, 0)]);
  assert.equal(one.verdict, 'broken-test');
  assert.equal(one.confidence, 'low');
});

test('a consistent environment failure is an environment issue', () => {
  const text = 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/';
  const three = verdictOf([attempt('failed', text, 0), attempt('failed', text, 1), attempt('timedOut', text, 2)]);
  assert.equal(three.verdict, 'environment-issue');
  assert.equal(three.ruleId, 'ENVIRONMENT-ISSUE');
  assert.equal(three.confidence, 'high');

  const one = verdictOf([attempt('failed', text, 0)]);
  assert.equal(one.verdict, 'environment-issue');
  assert.equal(one.confidence, 'low');
});

test('assertion values that contain a times sign stay different failures', () => {
  const toBe = (expected, received) =>
    ['Error: expect(received).toBe(expected) // Object.is equality', '', `Expected: "${expected}"`, `Received: "${received}"`].join(
      '\n',
    );
  const product = verdictOf([
    attempt('failed', toBe('1 × 4', '2 × 4'), 0),
    attempt('failed', toBe('1 × 4', '3 × 4'), 1),
    attempt('failed', toBe('1 × 4', '5 × 4'), 2),
  ]);
  assert.equal(product.verdict, 'needs-more-runs');
  assert.equal(product.signals.some((signal) => signal.kind === 'consistent-failure'), false);

  const tight = verdictOf([
    attempt('failed', toBe('1×', '2×'), 0),
    attempt('failed', toBe('1×', '3×'), 1),
    attempt('failed', toBe('1×', '5×'), 2),
  ]);
  assert.equal(tight.verdict, 'needs-more-runs');
  assert.equal(tight.signals.some((signal) => signal.kind === 'consistent-failure'), false);

  const text = (received) =>
    [
      'Error: expect(locator).toHaveText(expected) failed',
      `Locator: locator('[data-test="item"]')`,
      'Expected: "Backpack"',
      `Received: "${received}"`,
      'Timeout: 5000ms',
    ].join('\n');
  const backpack = verdictOf([
    attempt('failed', text('2 × Backpack'), 0),
    attempt('failed', text('3 × Backpack'), 1),
    attempt('failed', text('5 × Backpack'), 2),
  ]);
  assert.equal(backpack.verdict, 'needs-more-runs');
  assert.equal(backpack.signals.some((signal) => signal.kind === 'consistent-failure'), false);
  assert.equal(backpack.cause, 'test-data');
});

test('a repeated unknown value mismatch is a likely real bug', () => {
  const text = ['Error: expect(locator).toHaveText(expected) failed', 'Expected: "9"', 'Received: "1"'].join('\n');
  const two = verdictOf([attempt('failed', text, 0), attempt('failed', text, 1)]);
  assert.equal(two.verdict, 'likely-real-bug');
  assert.equal(two.ruleId, 'LIKELY-REAL-BUG');
  assert.equal(two.confidence, 'low');
  assert.equal(two.cause, 'unknown');

  const three = verdictOf([attempt('failed', text, 0), attempt('failed', text, 1), attempt('failed', text, 2)]);
  assert.equal(three.verdict, 'likely-real-bug');
  assert.equal(three.confidence, 'medium');
  assert.equal(three.signals.some((signal) => signal.kind === 'consistent-failure'), true);
  assert.equal(three.note, null);
});

test('any verdict with no error text keeps the empty-text note', () => {
  const item = record('blank', [attempt('failed', undefined, 0), attempt('failed', undefined, 1), attempt('failed', undefined, 2)]);
  const decision = decideVerdict([item], [
    { cause: 'selectors', confidence: 'high', evidence: [], ruleIds: ['SEL-NOTFOUND'] },
  ]);
  assert.equal(decision.verdict, 'broken-test');
  assert.equal(decision.note, 'The report has no error text for these attempts.');
});

test('a pass and a fail on the same code are flaky', () => {
  const text = 'Error: element(s) not found';
  const sameReport = verdictOf([attempt('failed', text, 0), attempt('passed', undefined, 1)]);
  assert.equal(sameReport.verdict, 'flaky');
  assert.equal(sameReport.ruleId, 'FLAKY');
  assert.equal(sameReport.confidence, 'low');
  assert.equal(sameReport.signals.some((signal) => signal.kind === 'same-code-flip'), true);

  const fail = record('again', [attempt('failed', text, 0), attempt('failed', text, 1)], { commitSha: 'aaa' });
  const pass = record('again', [attempt('passed', undefined, 0)], { commitSha: 'aaa', reportPath: 'other.json' });
  pass.outcome = 'passed';
  const merged = { ...fail, outcome: 'flaky', attempts: [...fail.attempts, ...pass.attempts] };
  const across = decideVerdict([fail, pass], classifyCauses(merged));
  assert.equal(across.verdict, 'flaky');
  assert.equal(across.confidence, 'high');
});

test('a missing SHA does not join a pass and a fail from two reports', () => {
  const fail = record('split', [attempt('failed', 'Error: gave up', 0)], { reportPath: 'a.json' });
  const pass = record('split', [attempt('passed', undefined, 0)], { reportPath: 'b.json' });
  pass.outcome = 'passed';
  const result = decideVerdict([fail, pass], []);
  assert.equal(result.verdict, 'needs-more-runs');
  assert.equal(result.signals.some((signal) => signal.kind === 'same-code-flip'), false);
});

test('one failed attempt, or different signatures and no pass, needs more runs', () => {
  const once = verdictOf([attempt('failed', 'Error: gave up', 0)]);
  assert.equal(once.verdict, 'needs-more-runs');
  assert.equal(once.ruleId, 'NEEDS-MORE-RUNS');
  assert.equal(once.confidence, 'low');
  assert.match(once.signals[0].detail, /Only one failed attempt/);

  const mixed = verdictOf([
    attempt('failed', 'Error: gave up', 0),
    attempt('failed', 'Error: something else broke', 1),
    attempt('failed', 'Error: a third message', 2),
  ]);
  assert.equal(mixed.verdict, 'needs-more-runs');
  assert.equal(mixed.confidence, 'medium');
  assert.match(mixed.signals[0].detail, /do not share one error signature/);
});

test('a test.fail() test that passed is needs-more-runs with a note', () => {
  const item = record('expected', [attempt('passed', undefined, 0)]);
  item.expectedStatus = 'failed';
  item.outcome = 'failed';
  const result = decideVerdict([item], classifyCauses(item));
  assert.equal(result.verdict, 'needs-more-runs');
  assert.equal(result.ruleId, 'UNEXPECTED-PASS');
  assert.equal(result.note, 'This test uses test.fail() and it passed. The expected failure did not happen.');
  assert.equal(result.signals.some((signal) => signal.kind === 'unexpected-pass'), true);
});

test('a same-code flip and a later consistent failure on a new SHA keep both signals', () => {
  const text = ['Error: expect(locator).toHaveText(expected) failed', 'Expected: "9"', 'Received: "1"'].join('\n');
  const flaky = record('cart', [attempt('failed', 'Error: element(s) not found', 0), attempt('passed', undefined, 1)], {
    commitSha: 'aaa',
    reportPath: 'first.json',
  });
  const later = record('cart', [attempt('failed', text, 0), attempt('failed', text, 1)], {
    commitSha: 'bbb',
    reportPath: 'second.json',
  });
  const result = decideVerdict([flaky, later], []);
  assert.equal(result.verdict, 'likely-real-bug');
  assert.equal(result.ruleId, 'LIKELY-REAL-BUG');
  assert.equal(result.signals.some((signal) => signal.kind === 'consistent-failure'), true);
  assert.equal(result.signals.some((signal) => signal.kind === 'same-code-flip'), true);
  assert.equal(result.confidence, 'medium');
});

test('an environment failure on a new SHA outranks an earlier flip', () => {
  const net = 'Error: connect ECONNREFUSED';
  const flaky = record('net', [attempt('failed', net, 0), attempt('passed', undefined, 1)], {
    commitSha: 'aaa',
    reportPath: 'first.json',
  });
  const later = record('net', [attempt('failed', net, 0), attempt('failed', net, 1), attempt('failed', net, 2)], {
    commitSha: 'bbb',
    reportPath: 'second.json',
  });
  const result = decideVerdict([flaky, later], []);
  assert.equal(result.verdict, 'environment-issue');
  assert.equal(result.signals.map((signal) => signal.kind).join(','), 'consistent-failure,same-code-flip');
});

test('a later passing commit does not keep an earlier broken verdict', () => {
  const text = 'Error: element(s) not found';
  const broken = record('missing', [attempt('failed', text, 0), attempt('failed', text, 1), attempt('failed', text, 2)], {
    commitSha: 'aaa',
    reportPath: 'old.json',
  });
  const passed = record('missing', [attempt('passed', undefined, 0)], {
    commitSha: 'bbb',
    reportPath: 'new.json',
  });
  passed.outcome = 'passed';
  const result = decideVerdict([broken, passed], classifyCauses(broken));
  assert.equal(result.verdict, 'needs-more-runs');
  assert.equal(result.signals.some((signal) => signal.detail.includes('commit')), false);
});

test('a signal does not name a commit when the record has no SHA', () => {
  const text = 'Error: element(s) not found';
  const result = verdictOf([attempt('failed', text, 0), attempt('failed', text, 1), attempt('failed', text, 2)]);
  assert.equal(result.verdict, 'broken-test');
  assert.equal(result.signals.some((signal) => signal.detail.includes('commit')), false);
  assert.match(result.signals[0].detail, /on this code/);
});

test('the outcomes fixture matches the decision table', () => {
  const parsed = parsePlaywrightJson(
    fs.readFileSync('fixtures/reports/pw-1.60.0-outcomes.json', 'utf8'),
    'fixtures/reports/pw-1.60.0-outcomes.json',
  );
  const byTitle = (title) => parsed.records.find((item) => item.titlePath.at(-1) === title);

  const flaky = byTitle('flaky by retry');
  const flakyVerdict = decideVerdict([flaky], classifyCauses(flaky));
  assert.equal(flakyVerdict.verdict, 'flaky');

  const always = byTitle('always fails');
  const alwaysVerdict = decideVerdict([always], classifyCauses(always));
  assert.equal(alwaysVerdict.verdict, 'likely-real-bug');

  // times out: three timedOut attempts share one signature.
  // The causes are selectors (SEL-UNRESOLVED) and timing (TIM-TEST-TIMEOUT).
  // The primary cause is selectors, and the rule is not SEL-NOTFOUND, so it is not a broken test.
  // It is not environment, and it is not unknown, so it is not a likely real bug.
  // There is no pass, so it is not flaky.
  // There is more than one failure and only one signature, so the mixed-signature row does not match.
  // No earlier row applies, so the verdict is needs-more-runs.
  const timed = byTitle('times out');
  const timedCauses = classifyCauses(timed);
  const timedVerdict = decideVerdict([timed], timedCauses);
  assert.equal(timedCauses[0].cause, 'selectors');
  assert.equal(timedCauses[0].ruleIds.includes('SEL-NOTFOUND'), false);
  assert.ok(timedCauses.some((finding) => finding.ruleIds.includes('TIM-TEST-TIMEOUT')));
  assert.equal(timedVerdict.verdict, 'needs-more-runs');
  assert.match(timedVerdict.signals[0].detail, /not a broken test/);

  assert.equal(byTitle('always passes').outcome, 'passed');
  assert.equal(byTitle('skipped test').outcome, 'skipped');
  assert.equal(byTitle('expected to fail').outcome, 'passed');
});
