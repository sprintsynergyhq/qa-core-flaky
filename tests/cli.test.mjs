import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = 'dist/cli.js';
const fixture = 'fixtures/reports/pw-1.60.0-outcomes.json';

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
  });
}

function oneLine(text) {
  const trimmed = text.replace(/\n$/, '');
  return !trimmed.includes('\n');
}

function keepTemp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parse exits 0 and prints schemaVersion 1', () => {
  const result = run(['parse', fixture]);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.schemaVersion, 1);
  assert.ok(Array.isArray(json.records));
});

test('commit and branch are copied onto every record', () => {
  const result = run(['parse', fixture, '--commit', 'abc123', '--branch', 'main']);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.ok(json.records.length > 0);
  for (const record of json.records) {
    assert.equal(record.source.commitSha, 'abc123');
    assert.equal(record.source.branch, 'main');
    assert.equal(record.source.format, 'playwright-json');
    assert.equal(record.source.reportPath, fixture);
  }
});

test('a missing file exits 1 with a one-line stderr message', () => {
  const result = run(['parse', 'does-not-exist.json']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.length > 0);
  assert.equal(oneLine(result.stderr), true);
  assert.match(result.stderr, /does-not-exist\.json/);
});

test('help exits 0 and lists parse', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /parse/);
  assert.match(result.stdout, /\/proc/);
  assert.match(result.stdout, /--redact/);
});

test('version exits 0 and prints the package version', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '0.0.1\n');
});

test('parsing the fixture twice is byte identical', () => {
  const first = run(['parse', fixture]);
  const second = run(['parse', fixture]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.ok(first.stdout.endsWith('\n'));
});

const junitFixture = 'fixtures/reports/pw-1.60.0-outcomes.junit.xml';

test('parse auto-detects a JUnit report', () => {
  const result = run(['parse', junitFixture, '--commit', 'abc123', '--branch', 'main']);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.schemaVersion, 1);
  assert.ok(json.records.length > 0);
  for (const record of json.records) {
    assert.equal(record.source.format, 'junit');
    assert.equal(record.source.reportPath, junitFixture);
    assert.equal(record.source.commitSha, 'abc123');
    assert.equal(record.source.branch, 'main');
  }
});

test('--format json on a JUnit file exits 1', () => {
  const result = run(['parse', junitFixture, '--format', 'json']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(oneLine(result.stderr), true);
  assert.match(result.stderr, /Invalid JSON/);
  assert.match(result.stderr, /pw-1\.60\.0-outcomes\.junit\.xml/);
});

test('causes exits 0 and json output is byte identical twice', () => {
  const first = run(['causes', fixture, '--json']);
  const second = run(['causes', fixture, '--json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.ok(first.stdout.endsWith('\n'));
  const rows = JSON.parse(first.stdout);
  assert.ok(Array.isArray(rows));
  const ids = rows.map((row) => row.id);
  assert.equal(ids.some((id) => id.endsWith('always fails')), true);
  assert.equal(ids.some((id) => id.endsWith('skipped test')), false);
  const alwaysFails = rows.find((row) => row.id.endsWith('always fails'));
  assert.equal(alwaysFails.findings.length, 1);
  assert.equal(alwaysFails.findings[0].cause, 'unknown');
  const timedOut = rows.find((row) => row.id.endsWith('times out'));
  assert.ok(timedOut.findings.some((finding) => finding.ruleIds.includes('TIM-TEST-TIMEOUT')));
});

test('causes text lists the test id and a finding', () => {
  const result = run(['causes', fixture]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /always fails/);
  assert.match(result.stdout, /unknown low UNK-NONE/);
});

test('help lists causes', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /causes/);
});

test('help lists triage', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /triage/);
});

test('triage writes both files and exits 2 when there are entries', (t) => {
  const dir = keepTemp(t, 'triage-cli-');
  const result = run(['triage', fixture, '--out-dir', dir]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, '');
  const json = fs.readFileSync(path.join(dir, 'triage.json'), 'utf8');
  const markdown = fs.readFileSync(path.join(dir, 'triage.md'), 'utf8');
  assert.equal(json, fs.readFileSync('fixtures/reports/golden/triage.json', 'utf8'));
  assert.equal(markdown, fs.readFileSync('fixtures/reports/golden/triage.md', 'utf8'));
  assert.equal(json.endsWith('\n'), true);
  assert.equal(markdown.endsWith('\n'), true);
});

test('triage --fail-on never exits 0 and writes the same bytes', (t) => {
  const findingsDir = keepTemp(t, 'triage-findings-');
  const neverDir = keepTemp(t, 'triage-never-');
  const findings = run(['triage', fixture, '--out-dir', findingsDir]);
  const never = run(['triage', fixture, '--out-dir', neverDir, '--fail-on', 'never']);
  assert.equal(findings.status, 2, findings.stderr);
  assert.equal(never.status, 0, never.stderr);
  assert.equal(
    fs.readFileSync(path.join(findingsDir, 'triage.json'), 'utf8'),
    fs.readFileSync(path.join(neverDir, 'triage.json'), 'utf8'),
  );
  assert.equal(
    fs.readFileSync(path.join(findingsDir, 'triage.md'), 'utf8'),
    fs.readFileSync(path.join(neverDir, 'triage.md'), 'utf8'),
  );
});

test('triage of a passing report exits 0', (t) => {
  const dir = keepTemp(t, 'triage-pass-');
  const report = path.join(dir, 'pass.json');
  fs.writeFileSync(
    report,
    JSON.stringify({
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            {
              title: 'ok',
              file: 'a.spec.ts',
              tests: [
                {
                  projectName: 'chromium',
                  expectedStatus: 'passed',
                  status: 'expected',
                  results: [{ retry: 0, status: 'passed', duration: 1, errors: [] }],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const out = path.join(dir, 'out');
  const result = run(['triage', report, '--out-dir', out]);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(fs.readFileSync(path.join(out, 'triage.json'), 'utf8'));
  assert.equal(json.schemaVersion, 1);
  assert.deepEqual(json.entries, []);
});

test('triage of a missing file exits 1', () => {
  const result = run(['triage', 'does-not-exist.json', '--out-dir', os.tmpdir()]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(oneLine(result.stderr), true);
  assert.match(result.stderr, /does-not-exist\.json/);
});

test('triage rejects an unknown --fail-on value', () => {
  const result = run(['triage', fixture, '--fail-on', 'maybe']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(oneLine(result.stderr), true);
  assert.match(result.stderr, /fail-on/);
});

test('a failed triage.md write does not leave triage.json behind', (t) => {
  const dir = keepTemp(t, 'qa-core-flaky-partial-');
  fs.mkdirSync(path.join(dir, 'triage.json'));
  const result = run(['triage', fixture, '--out-dir', dir, '--fail-on', 'never']);
  assert.equal(result.status, 1);
  assert.equal(oneLine(result.stderr), true);
  assert.equal(fs.existsSync(path.join(dir, 'triage.md')), false);
  assert.equal(fs.statSync(path.join(dir, 'triage.json')).isDirectory(), true);
});

test('parse --redact hides a home username and the default leaves it', (t) => {
  const dir = keepTemp(t, 'qa-core-flaky-redact-');
  const report = path.join(dir, 'home.xml');
  fs.writeFileSync(
    report,
    `<testsuite hostname="chromium"><testcase name="home" classname="a.spec.ts"><failure message="open /home/alice/a.json">open /home/alice/a.json</failure></testcase></testsuite>`,
  );
  const raw = run(['parse', report]);
  assert.equal(raw.status, 0, raw.stderr);
  assert.match(raw.stdout, /\/home\/alice\/a\.json/);
  const hidden = run(['parse', report, '--redact']);
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.equal(hidden.stdout.includes('alice'), false);
  assert.match(hidden.stdout, /<home>\/a\.json/);
});

test('triage exit 2 leaves the full stdout report intact', () => {
  const result = run(['triage', fixture, '--json']);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, fs.readFileSync('fixtures/reports/golden/triage.json', 'utf8'));
  JSON.parse(result.stdout);
});

test('two triage runs are byte identical', (t) => {
  const firstDir = keepTemp(t, 'triage-a-');
  const secondDir = keepTemp(t, 'triage-b-');
  const first = run(['triage', fixture, '--out-dir', firstDir, '--fail-on', 'never']);
  const second = run(['triage', fixture, '--out-dir', secondDir, '--fail-on', 'never']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    fs.readFileSync(path.join(firstDir, 'triage.json'), 'utf8'),
    fs.readFileSync(path.join(secondDir, 'triage.json'), 'utf8'),
  );
  assert.equal(
    fs.readFileSync(path.join(firstDir, 'triage.md'), 'utf8'),
    fs.readFileSync(path.join(secondDir, 'triage.md'), 'utf8'),
  );
});

const recordedJunit = 'demo/saucedemo/reports/recorded-seed-443.junit.xml';

function problemUser(stdout) {
  const report = JSON.parse(stdout);
  const entry = report.entries.find((item) => item.id.includes('problem user'));
  assert.ok(entry, stdout);
  return entry;
}

test('the same report spelled three ways is counted once', () => {
  const absolute = path.resolve(recordedJunit);
  const once = run(['triage', recordedJunit, '--commit', 'abc', '--json', '--fail-on', 'never']);
  const repeated = run([
    'triage',
    recordedJunit,
    `./${recordedJunit}`,
    absolute,
    '--commit',
    'abc',
    '--json',
    '--fail-on',
    'never',
  ]);
  assert.equal(once.status, 0, once.stderr);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, once.stdout);
  const entry = problemUser(once.stdout);
  assert.equal(entry.verdict, 'needs-more-runs');
  assert.equal(entry.attempts.total, 1);
});

test('a byte-identical copy of a report is counted once', (t) => {
  const dir = keepTemp(t, 'triage-copy-');
  const copy = path.join(dir, 'copy.junit.xml');
  fs.copyFileSync(recordedJunit, copy);
  const link = path.join(dir, 'link.junit.xml');
  fs.symlinkSync(path.resolve(recordedJunit), link);
  const once = run(['triage', recordedJunit, '--commit', 'abc', '--json', '--fail-on', 'never']);
  const repeated = run(['triage', recordedJunit, copy, link, '--commit', 'abc', '--json', '--fail-on', 'never']);
  assert.equal(once.status, 0, once.stderr);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, once.stdout);
  const entry = problemUser(repeated.stdout);
  assert.equal(entry.verdict, 'needs-more-runs');
  assert.equal(entry.attempts.total, 1);
});

test('parse --redact hides a home username in source.reportPath', (t) => {
  const homeDir = path.join(os.tmpdir(), 'home');
  const aliceDir = path.join(homeDir, 'alice');
  const homeExisted = fs.existsSync(homeDir);
  const aliceExisted = fs.existsSync(aliceDir);
  fs.mkdirSync(aliceDir, { recursive: true });
  const report = path.join(aliceDir, 'r.xml');
  t.after(() => {
    fs.rmSync(report, { force: true });
    if (!aliceExisted) fs.rmSync(aliceDir, { recursive: true, force: true });
    if (!homeExisted) fs.rmSync(homeDir, { recursive: true, force: true });
  });
  fs.writeFileSync(
    report,
    '<testsuite hostname="chromium"><testcase name="home" classname="a.spec.ts"><failure message="Error: gave up">Error: gave up</failure></testcase></testsuite>',
  );
  const raw = run(['parse', report]);
  assert.equal(raw.status, 0, raw.stderr);
  assert.match(raw.stdout, /\/home\/alice\/r\.xml/);
  const hidden = run(['parse', report, '--redact']);
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.equal(hidden.stdout.includes('alice'), false);
  assert.match(hidden.stdout, /<home>\/r\.xml/);
});

test('parsing the JUnit fixture twice is byte identical', () => {
  const first = run(['parse', junitFixture]);
  const second = run(['parse', junitFixture]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.ok(first.stdout.endsWith('\n'));
});
