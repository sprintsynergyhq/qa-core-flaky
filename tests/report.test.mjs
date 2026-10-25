import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildTriageReport,
  fixTemplates,
  parseJunit,
  parsePlaywrightJson,
  renderTriageJson,
  renderTriageMarkdown,
} from '../dist/index.js';

const fixturePath = 'fixtures/reports/pw-1.60.0-outcomes.json';
const goldenJson = 'fixtures/reports/golden/triage.json';
const goldenMd = 'fixtures/reports/golden/triage.md';

function fixtureRecords() {
  return parsePlaywrightJson(fs.readFileSync(fixturePath, 'utf8'), fixturePath).records;
}

function validateTriage(report) {
  assert.equal(report.schemaVersion, 1);
  assert.ok(Array.isArray(report.entries));
  const verdicts = ['likely-real-bug', 'flaky', 'broken-test', 'environment-issue', 'needs-more-runs'];
  const confidences = ['high', 'medium', 'low'];
  for (const entry of report.entries) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(verdicts.includes(entry.verdict), entry.verdict);
    assert.ok(confidences.includes(entry.confidence), entry.confidence);
    assert.equal(typeof entry.ruleId, 'string');
    assert.ok(Array.isArray(entry.signals));
    assert.ok(Array.isArray(entry.causes));
    assert.ok(Array.isArray(entry.evidence));
    assert.ok(entry.evidence.length > 0, entry.id);
    assert.equal(typeof entry.attempts.total, 'number');
    assert.equal(typeof entry.attempts.failed, 'number');
    assert.equal(typeof entry.attempts.passed, 'number');
    assert.equal(typeof entry.attempts.sameCommit, 'boolean');
    assert.equal(typeof entry.history.runsSeen, 'number');
    assert.equal(entry.history.firstFailingCommit, null);
    assert.equal(typeof entry.suggestedFix, 'string');
    assert.ok(entry.suggestedFix.length > 0);
    assert.equal(entry.healProposal, null);
    assert.match(entry.nextStep, /qa-core-flaky rerun /);
    assert.equal(entry.llm, null);
    assert.deepEqual(entry.review, { status: 'Needs Review', reviewer: null, decision: null });
    for (const finding of entry.causes) {
      assert.ok(['selectors', 'timing', 'test-data', 'environment', 'unknown'].includes(finding.cause));
      assert.ok(confidences.includes(finding.confidence));
      assert.ok(Array.isArray(finding.evidence));
      assert.ok(Array.isArray(finding.ruleIds));
      for (const line of finding.evidence) {
        assert.equal(line.includes('\r'), false);
        assert.equal(line.length <= 300, true);
      }
    }
  }
}

test('fix templates cover the cause rules and do not only say to raise a timeout', () => {
  const templates = fixTemplates();
  const ids = [
    'SEL-STRICT',
    'SEL-NOTFOUND',
    'SEL-UNRESOLVED',
    'SEL-ZERO',
    'ENV-NET',
    'ENV-HTTP5XX',
    'ENV-BROWSER',
    'TIM-EXPECT-TIMEOUT',
    'TIM-TEST-TIMEOUT',
    'TIM-INTERCEPT',
    'TIM-NEAR-TIMEOUT',
    'DATA-VALUE-DRIFT',
    'DATA-ALREADY-EXISTS',
    'DATA-ORDER',
    'UNK-NONE',
    'UNK-EMPTY',
  ];
  assert.deepEqual(Object.keys(templates), ids);
  for (const [id, text] of Object.entries(templates)) {
    assert.equal(text.length > 0, true, id);
    assert.equal(/raise the timeout|increase the timeout|only raise|bump the timeout|higher timeout/i.test(text), false, id);
    assert.equal(/confirmed/i.test(text), false, id);
    assert.equal(/\bstable\b/i.test(text), false, id);
  }
  assert.match(templates['SEL-STRICT'], /data-test/);
  assert.match(templates['SEL-NOTFOUND'], /qa-core-heal/);
  assert.match(templates['TIM-EXPECT-TIMEOUT'], /web-first/);
  assert.match(templates['TIM-INTERCEPT'], /overlay/);
  assert.match(templates['DATA-VALUE-DRIFT'], /beforeEach/);
  assert.match(templates['ENV-NET'], /base URL/);
});

test('the fixture report validates and matches the golden files', () => {
  const report = buildTriageReport(fixtureRecords());
  validateTriage(report);
  assert.equal(report.generatedAt, undefined);
  const titles = report.entries.map((entry) => entry.id.split('::').at(-1));
  assert.deepEqual(titles, ['always fails', 'flaky by retry', 'times out']);
  assert.equal(report.entries[0].verdict, 'likely-real-bug');
  assert.equal(report.entries[1].verdict, 'flaky');
  assert.equal(report.entries[2].verdict, 'needs-more-runs');
  assert.equal(titles.includes('always passes'), false);
  assert.equal(titles.includes('skipped test'), false);
  assert.equal(titles.includes('expected to fail'), false);

  const json = renderTriageJson(report);
  const markdown = renderTriageMarkdown(report);
  assert.equal(json, fs.readFileSync(goldenJson, 'utf8'));
  assert.equal(markdown, fs.readFileSync(goldenMd, 'utf8'));
  assert.equal(json.includes('confirmed'), false);
  assert.equal(/\bstable\b/.test(json), false);
  assert.equal(markdown.includes('confirmed'), false);
  assert.equal(/\bstable\b/.test(markdown), false);
  assert.equal(markdown.includes('A flaky test can still point to a real app defect. Check the app behavior too.'), true);
  assert.equal(markdown.split('A flaky test can still point to a real app defect.').length, 2);
});

test('two triage builds are byte identical, and a timestamp is opt in', () => {
  const first = renderTriageJson(buildTriageReport(fixtureRecords()));
  const second = renderTriageJson(buildTriageReport(fixtureRecords()));
  assert.equal(first, second);
  const firstMd = renderTriageMarkdown(buildTriageReport(fixtureRecords()));
  const secondMd = renderTriageMarkdown(buildTriageReport(fixtureRecords()));
  assert.equal(firstMd, secondMd);

  const stamped = buildTriageReport(fixtureRecords(), { timestamp: '2026-01-02T03:04:05.000Z' });
  assert.equal(stamped.generatedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(renderTriageJson(stamped).includes('2026-01-02T03:04:05.000Z'), true);
  assert.notEqual(renderTriageJson(stamped), first);
});

test('passed records produce an empty report', () => {
  const records = fixtureRecords().filter((record) => record.outcome === 'passed' || record.outcome === 'skipped');
  const report = buildTriageReport(records);
  validateTriage(report);
  assert.equal(report.entries.length, 0);
});

test('a triage entry keeps the review status and a command', () => {
  const report = buildTriageReport(fixtureRecords());
  for (const entry of report.entries) {
    assert.equal(entry.review.status, 'Needs Review');
    assert.match(entry.nextStep, /qa-core-flaky rerun "tests\/outcomes\.spec\.ts"/);
    assert.equal(entry.suggestedFix.length > 0, true);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'unused');
  assert.equal(fs.existsSync(dir), true);
});

function attempt(status, message, retry = 0) {
  return {
    retry,
    status,
    durationMs: 10,
    errors: message === undefined ? [] : [{ message }],
    attachments: [],
  };
}

function oneRecord(title, attempts, source = {}) {
  const failed = attempts.some((item) => item.status === 'failed' || item.status === 'timedOut' || item.status === 'interrupted');
  const passed = attempts.some((item) => item.status === 'passed');
  return {
    id: `tests/a.spec.ts::chromium::${title}`,
    file: 'tests/a.spec.ts',
    project: 'chromium',
    titlePath: [title],
    expectedStatus: 'passed',
    outcome: failed && passed ? 'flaky' : 'failed',
    attempts,
    source: {
      format: 'playwright-json',
      reportPath: 'fixture.json',
      ...source,
    },
  };
}

function received(value) {
  return ['Error: expect(locator).toHaveText(expected) failed', 'Expected: "9"', `Received: "${value}"`].join('\n');
}

test('triage keeps the cause from the commit that decided the verdict', () => {
  const flaky = oneRecord('cart', [attempt('failed', received('2'), 0), attempt('passed', undefined, 1)], {
    commitSha: 'aaa',
    reportPath: 'b1.json',
  });
  const later = oneRecord(
    'cart',
    [attempt('failed', received('1'), 0), attempt('failed', received('1'), 1), attempt('failed', received('1'), 2)],
    { commitSha: 'bbb', reportPath: 'b2.json' },
  );
  const entry = buildTriageReport([flaky, later]).entries[0];
  assert.equal(entry.verdict, 'likely-real-bug');
  assert.equal(entry.confidence, 'medium');
  assert.equal(entry.causes[0].cause, 'unknown');
  assert.equal(entry.causes[0].confidence, 'low');
  assert.equal(entry.causes.some((finding) => finding.cause === 'test-data'), false);
  assert.equal(entry.evidence.some((line) => line.includes('Received: "1"')), true);
  assert.equal(entry.evidence.some((line) => line.includes('Received: "2"')), false);
  assert.match(entry.suggestedFix, /did not name a cause/);
  const details = entry.signals.map((signal) => `${signal.kind}: ${signal.detail}`).join('\n');
  assert.match(details, /consistent-failure: All attempts on commit bbb failed with one error signature\./);
  assert.match(details, /same-code-flip: At least one pass and one fail share commit aaa\./);

  const net = 'Error: connect ECONNREFUSED';
  const flip = oneRecord('net', [attempt('failed', net, 0), attempt('passed', undefined, 1)], {
    commitSha: 'aaa',
    reportPath: 'e1.json',
  });
  const env = oneRecord(
    'net',
    [attempt('failed', net, 0), attempt('failed', net, 1), attempt('failed', net, 2)],
    { commitSha: 'bbb', reportPath: 'e2.json' },
  );
  const envEntry = buildTriageReport([flip, env]).entries[0];
  assert.equal(envEntry.verdict, 'environment-issue');
  assert.equal(envEntry.causes[0].cause, 'environment');
  assert.equal(envEntry.causes[0].confidence, 'high');
  assert.equal(envEntry.confidence, 'high');
  assert.match(envEntry.signals[0].detail, /commit bbb/);
  assert.match(envEntry.signals[1].detail, /commit aaa/);
});

test('three failures with no error text are needs-more-runs', () => {
  const item = oneRecord('blank', [
    attempt('failed', undefined, 0),
    attempt('failed', undefined, 1),
    attempt('failed', undefined, 2),
  ]);
  const entry = buildTriageReport([item]).entries[0];
  assert.equal(entry.verdict, 'needs-more-runs');
  assert.equal(entry.ruleId, 'NEEDS-MORE-RUNS');
  assert.equal(entry.note, 'The report has no error text for these attempts.');
  assert.deepEqual(entry.evidence, ['The report has no error text for these attempts.']);
  assert.equal(entry.confidence, 'medium');
});

test('a flaky entry with no error text still has evidence', () => {
  const item = oneRecord('blank', [attempt('failed', undefined, 0), attempt('passed', undefined, 1)]);
  const report = buildTriageReport([item]);
  const entry = report.entries[0];
  assert.equal(entry.verdict, 'flaky');
  assert.equal(entry.note, 'The report has no error text for these attempts.');
  assert.deepEqual(entry.evidence, ['The report has no error text for these attempts.']);
  const markdown = renderTriageMarkdown(report);
  assert.equal(markdown.includes('No error text was quoted.'), false);
  assert.match(markdown, /The report has no error text for these attempts\./);
});

test('a real JUnit run with no root hides the home username in triage', () => {
  const reportPath = 'fixtures/reports/junit-no-root-home.xml';
  const source = fs.readFileSync(reportPath, 'utf8');
  assert.equal(source.includes('/home/alice/proj/tests/seed-users.json'), true);
  const records = parseJunit(source, reportPath).records;
  const report = buildTriageReport(records);
  const json = renderTriageJson(report);
  const markdown = renderTriageMarkdown(report);
  assert.equal(json, fs.readFileSync('fixtures/reports/golden/junit-home-triage.json', 'utf8'));
  assert.equal(markdown, fs.readFileSync('fixtures/reports/golden/junit-home-triage.md', 'utf8'));
  const triage = json + markdown;
  assert.equal(triage.includes('alice'), false);
  assert.equal(triage.includes('/home/'), false);
  assert.equal(triage.includes('Users'), false);
  assert.match(json, /<home>\/proj\/tests\/seed-users\.json/);
  assert.match(markdown, /&lt;home&gt;\/proj\/tests\/seed-users\.json/);
  assert.equal(markdown.includes('<home>'), false);
});

test('markdown evidence escapes html from an overlay error', () => {
  const message = '<div id="cover"> intercepts pointer events';
  const item = oneRecord('overlay', [
    attempt('failed', message, 0),
    attempt('failed', message, 1),
    attempt('failed', message, 2),
  ]);
  const report = buildTriageReport([item]);
  const markdown = renderTriageMarkdown(report);
  assert.equal(markdown.includes('<div'), false);
  assert.match(markdown, /&lt;div id="cover"&gt;/);
  assert.equal(report.entries[0].evidence.some((line) => line.includes('<div id="cover">')), true);
});
