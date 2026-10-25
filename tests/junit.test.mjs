import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { detectFormat, parseJunit, parsePlaywrightJson } from '../dist/index.js';

const jsonPath = 'fixtures/reports/pw-1.60.0-outcomes.json';
const junitPath = 'fixtures/reports/pw-1.60.0-outcomes.junit.xml';
const genericPath = 'fixtures/reports/junit-generic.xml';
const NO_ATTEMPT =
  'junit report has no per-attempt data; flaky detection needs the JSON report or reruns';

function byTitle(records, title) {
  const found = records.filter((record) => record.titlePath.at(-1) === title);
  assert.equal(found.length, 1, `expected one record titled ${title}`);
  return found[0];
}

test('Playwright JUnit ids match the JSON fixture', () => {
  const json = parsePlaywrightJson(fs.readFileSync(jsonPath, 'utf8'), jsonPath);
  const junit = parseJunit(fs.readFileSync(junitPath, 'utf8'), junitPath);
  assert.deepEqual(
    junit.records.map((record) => record.id),
    json.records.map((record) => record.id),
  );
  assert.deepEqual(junit.warnings, [NO_ATTEMPT]);
});

test('always fails, skipped test, and always passes match the JSON outcomes', () => {
  const json = parsePlaywrightJson(fs.readFileSync(jsonPath, 'utf8'), jsonPath);
  const junit = parseJunit(fs.readFileSync(junitPath, 'utf8'), junitPath);
  for (const title of ['always fails', 'skipped test', 'always passes']) {
    assert.equal(byTitle(junit.records, title).outcome, byTitle(json.records, title).outcome, title);
  }
});

test('flaky by retry is one passed attempt when the JUnit file has no per-attempt data', () => {
  const result = parseJunit(fs.readFileSync(junitPath, 'utf8'), junitPath);
  const record = byTitle(result.records, 'flaky by retry');
  assert.equal(record.outcome, 'passed');
  assert.equal(record.attempts.length, 1);
  assert.equal(record.attempts[0].retry, 0);
  assert.equal(record.attempts[0].status, 'passed');
  assert.equal(record.attempts[0].errors.length, 0);
  assert.equal(record.attempts[0].attachments.length, 1);
  assert.equal(record.attempts[0].attachments[0].name, 'error-context.md');
  assert.match(record.attempts[0].attachments[0].path, /error-context\.md$/);
  assert.ok(result.warnings.includes(NO_ATTEMPT));
});

test('always fails keeps the failure message and the retry text on one attempt', () => {
  const record = byTitle(parseJunit(fs.readFileSync(junitPath, 'utf8'), junitPath).records, 'always fails');
  assert.equal(record.outcome, 'failed');
  assert.equal(record.attempts.length, 1);
  assert.equal(record.attempts[0].status, 'failed');
  assert.equal(record.attempts[0].errors[0].message, 'expect(locator).toHaveText(expected) failed');
  assert.match(record.attempts[0].errors[0].stack, /Retry #1/);
  assert.match(record.attempts[0].errors[0].stack, /Retry #2/);
  assert.equal(record.attempts[0].errors[0].stack.includes('/workspace'), false);
});

test('times out is failed, not timedOut, in the JUnit fixture', () => {
  const json = parsePlaywrightJson(fs.readFileSync(jsonPath, 'utf8'), jsonPath);
  const junit = parseJunit(fs.readFileSync(junitPath, 'utf8'), junitPath);
  const jsonRecord = byTitle(json.records, 'times out');
  const junitRecord = byTitle(junit.records, 'times out');
  assert.equal(jsonRecord.outcome, 'failed');
  assert.equal(junitRecord.outcome, 'failed');
  assert.ok(jsonRecord.attempts.some((attempt) => attempt.status === 'timedOut'));
  assert.equal(junitRecord.attempts.length, 1);
  assert.equal(junitRecord.attempts[0].status, 'failed');
});

test('expected status is passed because the JUnit file does not carry it', () => {
  const json = parsePlaywrightJson(fs.readFileSync(jsonPath, 'utf8'), jsonPath);
  const junit = parseJunit(fs.readFileSync(junitPath, 'utf8'), junitPath);
  const skipped = byTitle(junit.records, 'skipped test');
  const expected = byTitle(junit.records, 'expected to fail');
  assert.equal(skipped.outcome, 'skipped');
  assert.equal(skipped.expectedStatus, 'passed');
  assert.equal(byTitle(json.records, 'skipped test').expectedStatus, 'skipped');
  assert.equal(expected.outcome, 'passed');
  assert.equal(expected.expectedStatus, 'passed');
  assert.equal(byTitle(json.records, 'expected to fail').expectedStatus, 'failed');
});

test('junit-generic.xml has passed, failed, and skipped with project default', () => {
  const result = parseJunit(fs.readFileSync(genericPath, 'utf8'), genericPath);
  assert.equal(result.records.length, 3);
  assert.deepEqual(
    result.records.map((record) => record.outcome),
    ['passed', 'failed', 'skipped'],
  );
  for (const record of result.records) {
    assert.equal(record.project, 'default');
    assert.equal(record.file, 'tests/cart.spec.ts');
    assert.equal(record.source.format, 'junit');
  }
  assert.equal(result.records[1].attempts[0].errors[0].message, 'Expected 1 but saw 2');
  assert.deepEqual(result.warnings, [
    NO_ATTEMPT,
    'JUnit report has no project name; used default',
  ]);
});

test('malformed XML throws an error that includes the report path', () => {
  assert.throws(() => parseJunit('<testsuites><testsuite>', 'reports/bad.xml'), /reports\/bad\.xml/);
  assert.throws(() => parseJunit('<root></root>', 'reports/not-junit.xml'), /reports\/not-junit\.xml/);
});

test('XML default entities are decoded and custom entities are not expanded', () => {
  const xml = `<?xml version="1.0"?>
<!DOCTYPE testsuites [
  <!ENTITY secret "super-secret-value">
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<testsuites>
  <testsuite>
    <testcase name="entity" classname="a.spec.ts">
      <failure message="&lt;tag&amp;attr&gt; &secret; &xxe;">&quot;quoted&quot; &nbsp;</failure>
    </testcase>
  </testsuite>
</testsuites>`;
  const result = parseJunit(xml, 'reports/entities.xml');
  const blob = JSON.stringify(result);
  assert.equal(blob.includes('super-secret-value'), false);
  assert.equal(blob.includes('root:'), false);
  const error = result.records[0].attempts[0].errors[0];
  assert.match(error.message, /<tag&attr>/);
  assert.match(error.message, /&secret;/);
  assert.match(error.message, /&xxe;/);
  assert.match(error.stack, /"quoted"/);
  assert.match(error.stack, /&nbsp;/);
});

test('a second DOCTYPE does not expand a custom entity', () => {
  const xml = `<!DOCTYPE a []><!DOCTYPE b [<!ENTITY e "SECOND">]>
<testsuites><testsuite hostname="chromium">
  <testcase name="&e;" classname="a.spec.ts">
    <failure message="&lt;kept&gt; &e;">nope</failure>
  </testcase>
</testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/two-doctype.xml');
  const blob = JSON.stringify(result);
  assert.equal(blob.includes('SECOND'), false);
  assert.equal(result.records[0].titlePath[0], '&e;');
  const error = result.records[0].attempts[0].errors[0];
  assert.match(error.message, /<kept>/);
  assert.match(error.message, /&e;/);
  assert.equal(error.stack, 'nope');
});

test('a DOCTYPE after a comment or a processing instruction is not expanded', () => {
  const comment = `<!-- <testsuite --><!DOCTYPE a [<!ENTITY e "DECOY">]>
<testsuite hostname="chromium"><testcase name="&e;" classname="a.spec.ts"></testcase></testsuite>`;
  const instruction = `<?x <testsuites?><!DOCTYPE a [<!ENTITY e "DECOY">]>
<testsuite hostname="chromium"><testcase name="&e;" classname="a.spec.ts"></testcase></testsuite>`;
  for (const xml of [comment, instruction]) {
    const result = parseJunit(xml, 'reports/decoy.xml');
    assert.equal(JSON.stringify(result).includes('DECOY'), false);
    assert.equal(result.records[0].titlePath[0], '&e;');
  }
});

test('numeric character references are decoded', () => {
  const xml = `<testsuite hostname="chromium">
    <testcase name="&#65;&#x42;" classname="a.spec.ts">
      <failure message="&lt;&#65;&gt;">&#x42; &amp; &nbsp;</failure>
    </testcase>
  </testsuite>`;
  const result = parseJunit(xml, 'reports/numeric.xml');
  assert.equal(result.records[0].titlePath[0], 'AB');
  const error = result.records[0].attempts[0].errors[0];
  assert.equal(error.message, '<A>');
  assert.equal(error.stack, 'B & &nbsp;');
});

test('error text that is not a filesystem path stays unchanged', () => {
  const text =
    'Expected pattern: /Ready/ "/inventory.html" https://www.saucedemo.com/inventory.html regex /\\d+/ "a\\\\b"';
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="patterns" classname="a.spec.ts">
      <failure message='${text}'>kept</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/patterns.xml');
  const error = result.records[0].attempts[0].errors[0];
  assert.equal(error.message, text);
  assert.equal(error.stack, 'kept');
  assert.deepEqual(result.warnings, [NO_ATTEMPT]);
});

test('an absolute JUnit path is rewritten and does not stay absolute', () => {
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="runs elsewhere" file="/var/data/a.spec.ts">
      <failure message="boom at /var/data/a.spec.ts">boom</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/absolute.xml');
  const blob = JSON.stringify(result);
  assert.equal(blob.includes('/var/data/a.spec.ts'), false);
  assert.equal(result.records[0].file, 'var/data/a.spec.ts');
  assert.equal(result.records[0].file.startsWith('/'), false);
  assert.match(result.records[0].attempts[0].errors[0].message, /var\/data\/a\.spec\.ts/);
  assert.ok(
    result.warnings.some((warning) =>
      warning.startsWith('File path was absolute and was rewritten to a relative path:'),
    ),
  );
  for (const warning of result.warnings) {
    assert.equal(warning.includes('/var/data/a.spec.ts'), false);
  }
});

test('time in seconds becomes durationMs', () => {
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="timed" classname="a.spec.ts" time="1.5"></testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/time.xml');
  assert.equal(result.records[0].attempts[0].durationMs, 1500);
});

test('ANSI codes are removed from a JUnit failure', () => {
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="colored" classname="a.spec.ts">
      <failure message="Error: \u001b[31mnope\u001b[0m">still \u001b[31mred\u001b[0m</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/ansi.xml');
  const error = result.records[0].attempts[0].errors[0];
  assert.equal(error.message.includes('\u001b'), false);
  assert.equal(error.stack.includes('\u001b'), false);
  assert.match(error.message, /nope/);
  assert.match(error.stack, /red/);
});

test('a leading UTF-8 BOM is ignored for detection and JSON parsing', () => {
  const raw = '\uFEFF{"suites":[]}';
  assert.equal(detectFormat(raw, 'reports/bom.json'), 'json');
  const result = parsePlaywrightJson(raw, 'reports/bom.json');
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(detectFormat('\uFEFF<testsuite name="only"></testsuite>', 'reports/bom.xml'), 'junit');
});

test('format detection uses contents, not the file name', () => {
  assert.equal(detectFormat('  \n{"suites":[]}', 'reports/note.txt'), 'json');
  assert.equal(detectFormat('<?xml version="1.0"?><testsuites></testsuites>', 'reports/out.json'), 'junit');
  assert.equal(detectFormat('<testsuite name="only"></testsuite>', 'reports/out.json'), 'junit');
  assert.throws(() => detectFormat('not a report', 'reports/notes.txt'), /unknown report format: reports\/notes\.txt/);
});

test('parsing the JUnit fixture twice is byte identical', () => {
  const text = fs.readFileSync(junitPath, 'utf8');
  const first = JSON.stringify(parseJunit(text, junitPath));
  const second = JSON.stringify(parseJunit(text, junitPath));
  assert.equal(first, second);
});
