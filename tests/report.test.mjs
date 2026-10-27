import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildTriageReport,
  commandForInvocation,
  classifyCauses,
  collapseRunRecords,
  decideVerdict,
  fixTemplates,
  homeMarks,
  parseJunit,
  parsePlaywrightJson,
  redactHomeText,
  redactParseResult,
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

test('the rerun sentence uses the program that started triage', () => {
  assert.equal(commandForInvocation('/workspace/dist/cli.js', '/workspace'), "node 'dist/cli.js'");
  assert.equal(commandForInvocation('/tmp/kit/node_modules/.bin/qa-core-flaky', '/tmp/kit'), 'npx qa-core-flaky');
  assert.equal(commandForInvocation(undefined, '/workspace'), 'npx qa-core-flaky');
  const outside = commandForInvocation('/workspace/dist/cli.js', '/tmp/kit');
  assert.match(outside, /^node '/);
  assert.equal(outside.includes('qa-core-flaky'), false);
  assert.equal(commandForInvocation('/home/alice/proj/dist/cli.js', '/tmp'), 'npx qa-core-flaky');
});

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
    'TIM-SLOW-LOAD',
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

test('a triage entry keeps the review status and a command', (t) => {
  const report = buildTriageReport(fixtureRecords());
  for (const entry of report.entries) {
    assert.equal(entry.review.status, 'Needs Review');
    assert.match(entry.nextStep, /qa-core-flaky rerun --from 'fixtures\/reports\/pw-1\.60\.0-outcomes\.json' --only '/);
    assert.equal(entry.nextStep.includes('-g '), false);
    assert.equal(entry.suggestedFix.length > 0, true);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

test('a home path does not change the verdict', () => {
  const net = 'Error: missing /home/alice\nError: connect ECONNREFUSED';
  const notFound = 'Error: missing /home/alice\nError: element(s) not found';
  const netEntry = entryFor(net);
  const netRedacted = entryFor(redactHomeText(net));
  const netEaten = entryFor('Error: missing <home>/');
  assert.equal(redactHomeText(net), 'Error: missing <home>\nError: connect ECONNREFUSED');
  assert.equal(netEntry.verdict, netRedacted.verdict);
  assert.equal(netEntry.verdict, 'environment-issue');
  assert.equal(netEntry.confidence, 'high');
  assert.equal(netEntry.ruleId, 'ENVIRONMENT-ISSUE');
  assert.equal(netEntry.causes[0].ruleIds.includes('ENV-NET'), true);
  assert.equal(netEaten.verdict, 'likely-real-bug');
  assert.equal(netEntry.evidence.some((line) => line.includes('ECONNREFUSED')), true);
  assert.equal(netEntry.evidence.join('\n').includes('alice'), false);

  const missing = entryFor(notFound);
  const missingRedacted = entryFor(redactHomeText(notFound));
  assert.equal(redactHomeText(notFound), 'Error: missing <home>\nError: element(s) not found');
  assert.equal(missing.verdict, missingRedacted.verdict);
  assert.equal(missing.verdict, 'broken-test');
  assert.equal(missing.confidence, 'high');
  assert.equal(missing.causes[0].ruleIds.includes('SEL-NOTFOUND'), true);
  assert.equal(missing.evidence.join('\n').includes('element(s) not found'), true);

  const onTheLine = 'Error: connect ECONNREFUSED /home/alice';
  const quoted = entryFor(onTheLine);
  assert.equal(quoted.verdict, entryFor(redactHomeText(onTheLine)).verdict);
  assert.equal(quoted.evidence.some((line) => line.includes('<home>')), true);
  assert.equal(quoted.evidence.join('\n').includes('alice'), false);
  assert.equal(quoted.evidence.join('\n').includes('ECONNREFUSED'), true);

  const feed = [
    'Error: expect(locator).toHaveURL(expected) failed',
    'Expected: "/home/feed"',
    'Received: "/home/login"',
  ].join('\n');
  const settings = [
    'Error: expect(locator).toHaveURL(expected) failed',
    'Expected: "/home/feed"',
    'Received: "/home/settings"',
  ].join('\n');
  const drift = buildTriageReport([
    oneRecord('routes', [attempt('failed', feed, 0), attempt('failed', settings, 1)]),
  ]).entries[0];
  const driftRecord = oneRecord('routes', [attempt('failed', feed, 0), attempt('failed', settings, 1)]);
  assert.equal(
    classifyCauses(driftRecord).some((finding) => finding.ruleIds.includes('DATA-VALUE-DRIFT')),
    true,
  );
  assert.equal(drift.causes.some((finding) => finding.ruleIds.includes('DATA-VALUE-DRIFT')), true);
  const received = drift.evidence.filter((row) => row.startsWith('Received:'));
  assert.deepEqual(received, ['Received: "<home>"', 'Received: "<home~2>"']);
  assert.equal(drift.evidence.join('\n').includes('/home/'), false);
  assert.equal(drift.evidence.join('\n').includes('login'), false);
  assert.equal(drift.evidence.join('\n').includes('settings'), false);
});

function entryFor(text) {
  const attempts = [0, 1, 2].map((retry) => attempt('failed', text, retry));
  const record = oneRecord('sample', attempts);
  assert.equal(record.attempts[0].errors[0].message, text);
  return buildTriageReport([record]).entries[0];
}

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

test('a newline or a pipe in a title stays inside one summary row', () => {
  const message = 'Error: element(s) not found';
  const item = oneRecord('left | right\nnext', [
    attempt('failed', message, 0),
    attempt('failed', message, 1),
    attempt('failed', message, 2),
  ]);
  const markdown = renderTriageMarkdown(buildTriageReport([item]));
  const table = markdown.split('\n').filter((line) => line.startsWith('|'));
  assert.equal(table.length, 3);
  assert.match(table[2], /left \\| right\\nnext/);
  const heading = markdown.split('\n').find((line) => line.startsWith('## ') && line.includes('left'));
  assert.match(heading, /left \\| right\\nnext/);
  assert.equal(heading.includes('\n'), false);
});

test('a newline in the rerun command stays inside one code span', () => {
  const message = 'Error: element(s) not found';
  const item = oneRecord('line\nbreak', [
    attempt('failed', message, 0),
    attempt('failed', message, 1),
    attempt('failed', message, 2),
  ]);
  const markdown = renderTriageMarkdown(buildTriageReport([item]));
  const next = markdown.split('\n').find((line) => line.includes('qa-core-flaky rerun'));
  assert.ok(next);
  assert.match(next, /line\\nbreak/);
  assert.equal(next.includes('`qa-core-flaky rerun'), true);
});

test('markdown escapes home and title brackets in the table, heading, and next step', () => {
  const message = 'Error: element(s) not found';
  const item = oneRecord('renders <Cart> & qty', [
    attempt('failed', message, 0),
    attempt('failed', message, 1),
    attempt('failed', message, 2),
  ]);
  item.file = '<home>/proj/a.spec.ts';
  item.id = '<home>/proj/a.spec.ts::chromium::renders <Cart> & qty';
  const report = buildTriageReport([item]);
  const markdown = renderTriageMarkdown(report);
  const json = renderTriageJson(report);
  assert.match(markdown, /\| &lt;home&gt;\/proj\/a\.spec\.ts::chromium::renders &lt;Cart&gt; &amp; qty \|/);
  assert.match(markdown, /^## &lt;home&gt;\/proj\/a\.spec\.ts::chromium::renders &lt;Cart&gt; &amp; qty$/m);
  assert.match(
    markdown,
    /`qa-core-flaky rerun --from 'fixture\.json' --only '<home>\/proj\/a\.spec\.ts::chromium::renders <Cart> & qty'`/,
  );
  assert.equal(markdown.includes('\\'), false);
  assert.equal(markdown.includes('&amp;amp;'), false);
  assert.equal(json.includes('renders <Cart> & qty'), true);
  assert.equal(json.includes('<home>/proj/a.spec.ts'), true);
  assert.equal(json.includes('&lt;'), false);
});

test('doubled Windows backslashes in JUnit Expected and Received lines hide the username', () => {
  const expected = 'Expected: "C:\\\\Users\\\\alice\\\\Downloads\\\\report.csv"';
  const received = 'Received: "C:\\\\Users\\\\alice\\\\Downloads\\\\report.csv"';
  const frame = '    at readCsv (C:\\\\Users\\\\alice\\\\x.json:12:3)';
  assert.equal(expected.includes('\\\\'), true);
  assert.equal(frame.includes('\\\\'), true);
  const xml = `<testsuite hostname="chromium">
    <testcase name="csv" classname="a.spec.ts">
      <failure message="mismatch">${expected}\n${received}\n${frame}</failure>
    </testcase>
  </testsuite>`;
  const parsed = parseJunit(xml, 'reports/doubled-win.xml');
  const stored = parsed.records[0].attempts[0].errors[0].stack ?? parsed.records[0].attempts[0].errors[0].message;
  assert.equal(stored.includes('\\\\Users\\\\alice\\\\Downloads\\\\report.csv'), true);
  assert.equal(stored.includes('\\\\Users\\\\alice\\\\x.json'), true);
  const report = buildTriageReport(parsed.records);
  const json = renderTriageJson(report);
  const markdown = renderTriageMarkdown(report);
  assert.equal(json.includes('alice'), false);
  assert.equal(markdown.includes('alice'), false);
  assert.equal(json.includes('<home>/Downloads/report.csv'), true);
  assert.equal(markdown.includes('&lt;home&gt;/Downloads/report.csv'), true);
  assert.equal(markdown.includes('<home>'), false);
  assert.equal(redactHomeText(frame), '    at readCsv (<home>/x.json:12:3)');
});

test('a Playwright JSON report with no root hides a doubled Windows home path', () => {
  const win = 'C:\\\\Users\\\\alice\\\\x.json';
  const message = `Error at ${win}`;
  const stack = `${message}\n    at readCsv (${win}:12:3)`;
  assert.equal(message.includes('\\\\Users\\\\alice\\\\x.json'), true);
  const raw = JSON.stringify({
    config: {},
    suites: [
      {
        title: 'sample.spec.ts',
        file: 'sample.spec.ts',
        specs: [
          {
            title: 'reads',
            file: 'sample.spec.ts',
            tests: [
              {
                projectName: 'chromium',
                expectedStatus: 'passed',
                status: 'unexpected',
                results: [
                  {
                    retry: 0,
                    status: 'failed',
                    duration: 1,
                    errors: [{ message, stack }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const parsed = parsePlaywrightJson(raw, 'reports/no-root-win.json');
  const error = parsed.records[0].attempts[0].errors[0];
  assert.equal(error.message, message);
  assert.equal(error.stack.includes('\\\\Users\\\\alice\\\\x.json'), true);
  const report = buildTriageReport(parsed.records);
  const json = renderTriageJson(report);
  const markdown = renderTriageMarkdown(report);
  assert.equal(json.includes('alice'), false);
  assert.equal(markdown.includes('alice'), false);
  assert.match(json, /Error at <home>\/x\.json/);
  assert.match(markdown, /Error at &lt;home&gt;\/x\.json/);
  assert.equal(markdown.includes('<home>'), false);
  assert.equal(redactHomeText(error.stack).includes('alice'), false);
  assert.match(redactHomeText(error.stack), /at readCsv \(<home>\/x\.json:12:3\)/);
});

test('home-path drift keeps both redacted lines', () => {
  const line = (user) =>
    ['Error: expect(locator).toHaveText(expected) failed', 'Expected: "9"', `Received: "/home/${user}/proj/a.json"`].join('\n');
  const item = oneRecord('files', [attempt('failed', line('alice'), 0), attempt('failed', line('bob'), 1)]);
  const entry = buildTriageReport([item]).entries[0];
  const received = entry.evidence.filter((row) => row.startsWith('Received:'));
  assert.deepEqual(received, ['Received: "<home>/proj/a.json"', 'Received: "<home~2>/proj/a.json"']);
  assert.equal(entry.evidence.join('\n').includes('alice'), false);
  assert.equal(entry.evidence.join('\n').includes('bob'), false);
});

test('test ids that differ only by username stay separate after redaction', () => {
  const text = 'Error: element(s) not found';
  const alice = oneRecord('reads', [attempt('failed', text, 0), attempt('failed', text, 1), attempt('failed', text, 2)]);
  alice.file = '/home/alice/proj/a.spec.ts';
  alice.id = '/home/alice/proj/a.spec.ts::chromium::reads';
  const bob = oneRecord('reads', [attempt('failed', text, 0), attempt('failed', text, 1), attempt('failed', text, 2)]);
  bob.file = '/home/bob/proj/a.spec.ts';
  bob.id = '/home/bob/proj/a.spec.ts::chromium::reads';
  bob.source = { ...bob.source, reportPath: 'other.json' };
  const report = buildTriageReport([alice, bob]);
  assert.equal(report.entries.length, 2);
  assert.notEqual(report.entries[0].id, report.entries[1].id);
  const joined = report.entries.map((entry) => entry.id).join('\n');
  assert.equal(joined.includes('alice'), false);
  assert.equal(joined.includes('bob'), false);
  assert.match(joined, /<home>\/proj\/a\.spec\.ts/);
  assert.match(joined, /\(2\)$/m);
});

test('bare homes in Expected and Received are numbered inside one entry', () => {
  const pair = [
    'Error: expect(received).toBe(expected) // Object.is equality',
    'Expected: "/home/alice"',
    'Received: "/Users/bob"',
  ].join('\n');
  const pairReport = buildTriageReport([
    oneRecord('pair', [attempt('failed', pair, 0), attempt('failed', pair, 1), attempt('failed', pair, 2)]),
  ]);
  const pairJson = renderTriageJson(pairReport);
  const pairMd = renderTriageMarkdown(pairReport);
  assert.equal(pairJson.includes('alice'), false);
  assert.equal(pairJson.includes('bob'), false);
  assert.equal(pairMd.includes('alice'), false);
  assert.equal(pairMd.includes('bob'), false);
  assert.equal(pairReport.entries[0].evidence.includes('Expected: "<home>"'), true);
  assert.equal(pairReport.entries[0].evidence.includes('Received: "<home~2>"'), true);
  assert.match(pairMd, /Expected: "&lt;home&gt;"/);
  assert.match(pairMd, /Received: "&lt;home~2&gt;"/);

  const slash = [
    'Error: expect(received).toBe(expected) // Object.is equality',
    'Expected: "/home/alice"',
    'Received: "/home/alice/"',
  ].join('\n');
  const slashReport = buildTriageReport([
    oneRecord('slash', [attempt('failed', slash, 0), attempt('failed', slash, 1)]),
  ]);
  const slashJson = renderTriageJson(slashReport);
  assert.equal(slashJson.includes('alice'), false);
  assert.equal(slashReport.entries[0].evidence.includes('Expected: "<home>"'), true);
  assert.equal(slashReport.entries[0].evidence.includes('Received: "<home>/"'), true);
  assert.equal(slashReport.entries[0].evidence.some((line) => line.includes('<home~2>')), false);

  const line = (user) =>
    ['Error: expect(locator).toHaveText(expected) failed', 'Expected: "saved"', `Received: "/home/${user}"`].join('\n');
  const driftReport = buildTriageReport([
    oneRecord('users', [
      attempt('failed', line('alice'), 0),
      attempt('failed', line('bob'), 1),
      attempt('failed', line('carol'), 2),
    ]),
  ]);
  const driftJson = renderTriageJson(driftReport);
  const driftMd = renderTriageMarkdown(driftReport);
  const driftText = driftJson + driftMd;
  assert.equal(driftText.includes('alice'), false);
  assert.equal(driftText.includes('bob'), false);
  assert.equal(driftText.includes('carol'), false);
  const driftReceived = driftReport.entries[0].evidence.filter((row) => row.startsWith('Received:'));
  assert.deepEqual(driftReceived, ['Received: "<home>"', 'Received: "<home~2>"', 'Received: "<home~3>"']);
  assert.match(driftMd, /Received: "&lt;home&gt;"/);
  assert.match(driftMd, /Received: "&lt;home~2&gt;"/);
  assert.match(driftMd, /Received: "&lt;home~3&gt;"/);
});

test('redaction on and off keeps the same verdict', () => {
  const files = [
    ['fixtures/reports/pw-1.60.0-outcomes.json', 'json'],
    ['fixtures/reports/pw-1.60.0-outcomes.junit.xml', 'junit'],
    ['demo/saucedemo/reports/recorded-seed-443.json', 'json'],
    ['demo/saucedemo/reports/recorded-seed-443.junit.xml', 'junit'],
  ];
  const groups = [];
  for (const [file, format] of files) {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = format === 'json' ? parsePlaywrightJson(text, file) : parseJunit(text, file);
    groups.push(...groupsFrom(parsed.records));
  }
  const route = (received) =>
    ['Error: expect(locator).toHaveURL(expected) failed', 'Expected: "/home/feed"', `Received: "${received}"`].join('\n');
  groups.push([
    oneRecord('routes', [attempt('failed', route('/home/login'), 0), attempt('failed', route('/home/settings'), 1)]),
  ]);
  const homes = (user) =>
    ['Error: expect(locator).toHaveText(expected) failed', 'Expected: "saved"', `Received: "/home/${user}"`].join('\n');
  groups.push([
    oneRecord('users', [
      attempt('failed', homes('alice'), 0),
      attempt('failed', homes('bob'), 1),
      attempt('failed', homes('carol'), 2),
    ]),
  ]);
  const net = 'Error: missing /home/alice\nError: connect ECONNREFUSED';
  groups.push([oneRecord('net', [0, 1, 2].map((retry) => attempt('failed', net, retry)))]);
  assert.equal(countVerdictDifferences(groups), 0);
});

function groupsFrom(records) {
  const byId = new Map();
  for (const record of records) {
    const list = byId.get(record.id) ?? [];
    list.push(record);
    byId.set(record.id, list);
  }
  return [...byId.values()].filter((group) =>
    group.some((record) => record.outcome === 'failed' || record.outcome === 'flaky'),
  );
}

function decisionOf(records) {
  const collapsed = collapseRunRecords(records);
  const base = collapsed[0];
  const merged = { ...base, attempts: collapsed.flatMap((record) => record.attempts) };
  const decision = decideVerdict(collapsed, classifyCauses(merged));
  return { verdict: decision.verdict, ruleId: decision.ruleId, cause: decision.cause };
}

function redactErrors(records) {
  const texts = [];
  for (const record of records) {
    for (const attempt of record.attempts) {
      for (const error of attempt.errors ?? []) {
        texts.push(error.message ?? '');
        if (error.stack !== undefined) texts.push(error.stack);
      }
    }
  }
  const marks = homeMarks(texts);
  return records.map((record) => ({
    ...record,
    attempts: record.attempts.map((attempt) => ({
      ...attempt,
      errors: (attempt.errors ?? []).map((error) => {
        const next = { ...error, message: redactHomeText(error.message ?? '', marks) };
        if (error.stack !== undefined) next.stack = redactHomeText(error.stack, marks);
        return next;
      }),
    })),
  }));
}

function countVerdictDifferences(groups) {
  let differences = 0;
  for (const group of groups) {
    const before = decisionOf(group);
    const after = decisionOf(redactErrors(group));
    if (before.verdict !== after.verdict || before.ruleId !== after.ruleId || before.cause !== after.cause) {
      differences += 1;
    }
  }
  return differences;
}

test('the same report passed twice is counted once', () => {
  const item = oneRecord('once', [attempt('failed', 'Error: gave up', 0)]);
  const copy = { ...item, attempts: item.attempts.map((row) => ({ ...row })) };
  const entry = buildTriageReport([item, copy]).entries[0];
  assert.equal(entry.attempts.total, 1);
  assert.equal(entry.history.runsSeen, 1);
});

test('spellings of one report path are one run', () => {
  const file = 'demo/saucedemo/reports/recorded-seed-443.junit.xml';
  const make = (reportPath) => {
    const item = oneRecord('once', [attempt('failed', 'Error: gave up', 0)]);
    item.source = { format: 'junit', reportPath };
    return item;
  };
  const entry = buildTriageReport([make(file), make(`./${file}`), make(path.resolve(file))]).entries[0];
  assert.equal(entry.attempts.total, 1);
  assert.equal(entry.history.runsSeen, 1);
  assert.equal(entry.verdict, 'needs-more-runs');
});

test('a run JSON report is used instead of its JUnit twin', () => {
  const text = 'Error: element(s) not found';
  const json = oneRecord('missing', [attempt('failed', text, 0), attempt('failed', text, 1), attempt('failed', text, 2)]);
  json.source = { format: 'playwright-json', reportPath: 'demo/recorded-seed-1.json' };
  const junit = oneRecord('missing', [attempt('failed', text, 0)]);
  junit.source = { format: 'junit', reportPath: 'demo/recorded-seed-1.junit.xml' };
  const entry = buildTriageReport([json, junit]).entries[0];
  assert.equal(entry.attempts.total, 3);
  assert.equal(entry.history.runsSeen, 1);
  assert.equal(entry.verdict, 'broken-test');
});

test('markdown escapes stars, underscores, and backticks in a title', () => {
  const message = 'Error: element(s) not found';
  const item = oneRecord('show *bold* and _em_ and `code`', [
    attempt('failed', message, 0),
    attempt('failed', message, 1),
    attempt('failed', message, 2),
  ]);
  const markdown = renderTriageMarkdown(buildTriageReport([item]));
  assert.match(markdown, /\\*bold\\*/);
  assert.match(markdown, /\\_em\\_/);
  assert.match(markdown, /\\`code\\`/);
});

test('corpus triage text hides the known home usernames', () => {
  const corpora = [
    'fixtures/reports/pw-1.60.0-outcomes.json',
    'fixtures/reports/pw-1.60.0-outcomes.junit.xml',
    'fixtures/reports/junit-generic.xml',
    'fixtures/reports/junit-no-root-home.xml',
    'demo/saucedemo/reports/recorded-seed-443.json',
    'demo/saucedemo/reports/recorded-seed-443.junit.xml',
  ];
  const names = ['alice', 'bob', 'carol'];
  for (const reportPath of corpora) {
    const source = fs.readFileSync(reportPath, 'utf8');
    const parsed = reportPath.endsWith('.json') ? parsePlaywrightJson(source, reportPath) : parseJunit(source, reportPath);
    const report = buildTriageReport(parsed.records);
    const outputs = {
      'triage.json': renderTriageJson(report),
      'triage.md': renderTriageMarkdown(report),
      'parse --redact': JSON.stringify(redactParseResult(parsed)),
    };
    for (const [label, text] of Object.entries(outputs)) {
      for (const name of names) {
        assert.equal(text.includes(name), false, `${reportPath} ${label} contains ${name}`);
      }
    }
  }
});
