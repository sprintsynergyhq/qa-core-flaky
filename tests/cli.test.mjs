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

test('triage writes both files and exits 2 when there are entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-cli-'));
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

test('triage --fail-on never exits 0 and writes the same bytes', () => {
  const findingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-findings-'));
  const neverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-never-'));
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

test('triage of a passing report exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-pass-'));
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

test('two triage runs are byte identical', () => {
  const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-a-'));
  const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-b-'));
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

test('parsing the JUnit fixture twice is byte identical', () => {
  const first = run(['parse', junitFixture]);
  const second = run(['parse', junitFixture]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.ok(first.stdout.endsWith('\n'));
});
