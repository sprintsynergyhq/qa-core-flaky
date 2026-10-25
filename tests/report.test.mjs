import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildTriageReport,
  fixTemplates,
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
