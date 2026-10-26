import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildTriageReport,
  classifyCauses,
  homeMarks,
  parseJunit,
  redactHomeText,
  redactParseResult,
  renderTriageJson,
  renderTriageMarkdown,
  writeReportPair,
} from '../dist/index.js';

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

test('parse --redact applies home redaction to source.reportPath', (t) => {
  const dir = keepTemp(t, 'qa-core-flaky-redact-path-');
  const report = path.join(dir, 'r.xml');
  fs.writeFileSync(
    report,
    '<testsuite hostname="chromium"><testcase name="home" classname="a.spec.ts"><failure message="Error: gave up">Error: gave up</failure></testcase></testsuite>',
  );
  const raw = run(['parse', report]);
  assert.equal(raw.status, 0, raw.stderr);
  const hidden = run(['parse', report, '--redact']);
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.equal(JSON.parse(raw.stdout).records[0].source.reportPath, report);
  assert.equal(JSON.parse(hidden.stdout).records[0].source.reportPath, redactHomeText(report));
});

function homeSuiteReport(message) {
  return JSON.stringify({
    suites: [
      {
        title: '/home/alice/a.spec.ts',
        file: '/home/alice/a.spec.ts',
        specs: [
          {
            title: 't',
            file: '/home/alice/a.spec.ts',
            tests: [
              {
                expectedStatus: 'passed',
                status: 'unexpected',
                results: [{ retry: 0, status: 'failed', duration: 1, errors: [{ message }] }],
              },
            ],
          },
        ],
      },
    ],
  });
}

test('a test id does not change when only the error text changes', (t) => {
  const dir = keepTemp(t, 'triage-home-id-');
  const messages = [
    'ENOENT open /home/bob/x.json',
    'ENOENT open /home/alice/x.json',
    ['Error: expect(locator).toHaveURL(expected) failed', 'Expected: "/home/carol"', 'Received: "/home/bob"'].join('\n'),
  ];
  const stable = '<home>/a.spec.ts::default::<home>/a.spec.ts > t';
  const ids = [];
  for (const [index, message] of messages.entries()) {
    const report = path.join(dir, `home-${index}.json`);
    fs.writeFileSync(report, homeSuiteReport(message));
    const triage = run(['triage', report, '--json', '--fail-on', 'never']);
    assert.equal(triage.status, 0, triage.stderr);
    const causes = run(['causes', report, '--json']);
    assert.equal(causes.status, 0, causes.stderr);
    const entry = JSON.parse(triage.stdout).entries[0];
    const row = JSON.parse(causes.stdout)[0];
    assert.equal(entry.id, stable);
    assert.equal(row.id, entry.id);
    assert.equal(entry.id.includes('alice'), false);
    assert.equal(entry.id.includes('bob'), false);
    assert.equal(entry.id.includes('carol'), false);
    assert.equal(row.id.includes('alice'), false);
    ids.push(entry.id);
    const triageEvidence = entry.causes.flatMap((finding) => finding.evidence);
    const causeEvidence = row.findings.flatMap((finding) => finding.evidence);
    assert.deepEqual(causeEvidence, triageEvidence);
  }
  assert.equal(new Set(ids).size, 1);
});

test('rerun rejects an unknown id before launching Playwright', () => {
  const result = run(['rerun', '--from', fixture, '--only', 'missing-id', '--fail-on', 'never']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown test id missing-id/);
  assert.equal(result.stderr.includes('npx'), false);
});

test('rerun of a passing id prints the cap and does not launch Playwright', (t) => {
  const dir = keepTemp(t, 'qa-core-flaky-rerun-pass-');
  const report = path.join(dir, 'pass.json');
  fs.writeFileSync(
    report,
    JSON.stringify({
      config: { rootDir: '.' },
      suites: [
        {
          title: 'tests/a.spec.ts',
          file: 'tests/a.spec.ts',
          specs: [
            {
              title: 'ok',
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
  const result = run(['rerun', '--from', report, '--fail-on', 'never']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Cap: max-tests 20, times 5, modes repeat,isolated\. Selected 0 of 0 failing tests\. Commands 0\./);
  assert.equal(result.stderr.includes('npx'), false);
});

test('a read error names the typed path and not the absolute path', () => {
  const rel = path.join('fixtures', `no-such-read-${process.pid}.json`);
  const result = run(['parse', rel]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(result.stderr.includes(path.resolve(rel)), false);
  assert.equal(oneLine(result.stderr), true);
});

test('a pretty copy, a compact copy, and a CRLF copy are one run', (t) => {
  const dir = keepTemp(t, 'qa-core-flaky-norm-');
  const body = {
    config: { rootDir: '.' },
    suites: [
      {
        title: 'tests/a.spec.ts',
        file: 'tests/a.spec.ts',
        specs: [
          {
            title: 'once',
            tests: [
              {
                projectName: 'chromium',
                expectedStatus: 'passed',
                status: 'unexpected',
                results: [{ retry: 0, status: 'failed', duration: 1, errors: [{ message: 'Error: gave up' }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  const pretty = JSON.stringify(body, null, 2);
  const compact = JSON.stringify(body);
  fs.writeFileSync(path.join(dir, 'pretty.json'), pretty);
  fs.writeFileSync(path.join(dir, 'compact.json'), compact);
  fs.writeFileSync(path.join(dir, 'crlf.json'), pretty.replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(dir, 'extra.json'), `${pretty}\n`);
  const result = run([
    'triage',
    path.join(dir, 'pretty.json'),
    path.join(dir, 'compact.json'),
    path.join(dir, 'crlf.json'),
    path.join(dir, 'extra.json'),
    '--commit',
    'abc',
    '--json',
    '--fail-on',
    'never',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const entry = JSON.parse(result.stdout).entries[0];
  assert.equal(entry.attempts.total, 1);
  assert.equal(entry.verdict, 'needs-more-runs');
});

test('a failed json rename in an empty folder removes the new markdown', (t) => {
  const dir = keepTemp(t, 'qa-core-flaky-eio-');
  const renameSync = (from, to) => {
    if (to.endsWith(`${path.sep}triage.json`)) {
      const error = new Error('EIO');
      error.code = 'EIO';
      throw error;
    }
    fs.renameSync(from, to);
  };
  assert.throws(() => writeReportPair(dir, '{"ok":true}\n', '# T\n', { renameSync }), /EIO/);
  assert.equal(fs.existsSync(path.join(dir, 'triage.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'triage.json')), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('rerun rejects a huge times value, a huge max-tests value, and a repeated mode', () => {
  const times = run(['rerun', '--from', fixture, '--times', '1000000', '--fail-on', 'never']);
  assert.equal(times.status, 1);
  assert.equal(times.stdout, '');
  assert.match(times.stderr, /times must be from 1 to 20/);
  assert.match(times.stderr, /1000000/);
  const maxTests = run(['rerun', '--from', fixture, '--max-tests', '1000000', '--fail-on', 'never']);
  assert.equal(maxTests.status, 1);
  assert.match(maxTests.stderr, /max-tests must be from 1 to 50/);
  const modes = run(['rerun', '--from', fixture, '--modes', 'repeat,repeat', '--fail-on', 'never']);
  assert.equal(modes.status, 1);
  assert.match(modes.stderr, /Duplicate mode repeat/);
});

test('a failed rename keeps the previous triage pair', (t) => {
  const dir = keepTemp(t, 'qa-core-flaky-keep-');
  const previous = 'previous markdown\n';
  fs.writeFileSync(path.join(dir, 'triage.md'), previous);
  fs.mkdirSync(path.join(dir, 'triage.json'));
  const result = run(['triage', fixture, '--out-dir', dir, '--fail-on', 'never']);
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'triage.md'), 'utf8'), previous);
  assert.equal(fs.statSync(path.join(dir, 'triage.json')).isDirectory(), true);
});

test('parsing the JUnit fixture twice is byte identical', () => {
  const first = run(['parse', junitFixture]);
  const second = run(['parse', junitFixture]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.ok(first.stdout.endsWith('\n'));
});

test('a UNC, extended, or SMB path is redacted from JSON and JUnit', (t) => {
  const dir = keepTemp(t, 'qa-core-flaky-unc-');
  const unc = String.raw`at \\srv\Users\bob\proj\a.ts:3:1`;
  const extended = String.raw`\\?\UNC\server\Users\carol\y`;
  const smb = 'smb://server/Users/alice/z.ts';
  const specs = [
    ['unc.spec.ts', 'unc', unc],
    ['ext.spec.ts', 'extended', extended],
    ['smb.spec.ts', 'smb', smb],
  ];
  const jsonPath = path.join(dir, 'unc.json');
  const xmlPath = path.join(dir, 'unc.xml');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      config: { rootDir: '/workspace/app' },
      suites: specs.map(([file, title, message]) => ({
        title: file,
        file,
        specs: [
          {
            title,
            file,
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
                    errors: [{ message, stack: message }],
                  },
                ],
              },
            ],
          },
        ],
      })),
    }),
  );
  fs.writeFileSync(
    xmlPath,
    `<testsuites>${specs
      .map(
        ([file, title, message]) => `<testsuite hostname="chromium">
          <testcase name="${title}" classname="${file}" file="${file}">
            <failure message="path"><![CDATA[${message}]]></failure>
          </testcase>
        </testsuite>`,
      )
      .join('')}</testsuites>`,
  );

  function hidden(text, label) {
    for (const name of ['alice', 'bob', 'carol']) {
      assert.equal(text.includes(name), false, `${label} contains ${name}`);
    }
    assert.equal(text.includes('srv/Users'), false, `${label} made the UNC path relative`);
    assert.equal(text.includes('../../srv'), false, `${label} made the UNC path relative`);
    assert.equal(text.includes('<home>') || text.includes('&lt;home&gt;'), true, `${label} did not redact`);
  }

  for (const report of [jsonPath, xmlPath]) {
    const parsed = run(['parse', report]);
    assert.equal(parsed.status, 0, parsed.stderr);
    const stored = JSON.parse(parsed.stdout).records.flatMap((record) =>
      record.attempts.flatMap((attempt) =>
        attempt.errors.flatMap((error) => [error.message, error.stack].filter((item) => item !== undefined)),
      ),
    );
    assert.equal(stored.includes(unc), true, report);
    assert.equal(stored.some((item) => item.includes('srv/Users') || item.includes('../../srv')), false, report);

    const redacted = run(['parse', report, '--redact']);
    assert.equal(redacted.status, 0, redacted.stderr);
    hidden(redacted.stdout, `parse --redact ${path.basename(report)}`);

    const out = path.join(dir, `${path.basename(report)}-out`);
    fs.mkdirSync(out);
    const triage = run(['triage', report, '--out-dir', out, '--fail-on', 'never']);
    assert.equal(triage.status, 0, triage.stderr);
    assert.equal(triage.stdout, '');
    hidden(fs.readFileSync(path.join(out, 'triage.md'), 'utf8'), `triage.md ${path.basename(report)}`);
    hidden(fs.readFileSync(path.join(out, 'triage.json'), 'utf8'), `triage.json ${path.basename(report)}`);
    const asJson = run(['triage', report, '--json', '--fail-on', 'never']);
    assert.equal(asJson.status, 0, asJson.stderr);
    hidden(asJson.stdout, `triage --json ${path.basename(report)}`);

    const causes = run(['causes', report]);
    assert.equal(causes.status, 0, causes.stderr);
    hidden(causes.stdout, `causes ${path.basename(report)}`);
    const causesJson = run(['causes', report, '--json']);
    assert.equal(causesJson.status, 0, causesJson.stderr);
    hidden(causesJson.stdout, `causes --json ${path.basename(report)}`);
  }
});

test('an extended drive frame is relative inside the root across triage, causes, and parse', (t) => {
  const dir = keepTemp(t, 'qa-core-flaky-ext-drive-');
  const frame = String.raw`    at \\?\C:\Users\zbob\proj\tests\p.spec.ts:3:5`;
  const relative = 'tests/p.spec.ts:3:5';
  const roots = [
    ['drive', String.raw`C:\Users\zbob\proj`, true],
    ['extended', String.raw`\\?\C:\Users\zbob\proj`, true],
    ['outside', String.raw`D:\w`, false],
    ['none', undefined, false],
  ];

  function jsonReport(rootDir) {
    return JSON.stringify({
      config: rootDir === undefined ? {} : { rootDir },
      suites: [
        {
          title: 'p.spec.ts',
          file: 'p.spec.ts',
          specs: [
            {
              title: 'reads',
              file: 'p.spec.ts',
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
                      errors: [{ message: frame, stack: frame }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  }

  function xmlReport() {
    return `<testsuite hostname="chromium">
      <testcase name="reads" classname="p.spec.ts" file="p.spec.ts">
        <failure message="${frame}"><![CDATA[${frame}]]></failure>
      </testcase>
    </testsuite>`;
  }

  function assertSurface(text, label, inside) {
    assert.equal(text.includes('zbob'), false, `${label} leaks zbob`);
    assert.equal(text.includes('C:Users'), false, `${label} is garbled`);
    if (inside) assert.equal(text.includes(relative), true, `${label} is not relative`);
    else assert.equal(text.includes('<home>') || text.includes('&lt;home&gt;'), true, `${label} did not redact`);
  }

  function assertCli(report, label, inside) {
    const parsed = run(['parse', report]);
    assert.equal(parsed.status, 0, parsed.stderr);
    const parsedJson = JSON.parse(parsed.stdout);
    assert.equal(
      parsedJson.warnings.some((warning) => warning.includes('zbob')),
      false,
      `${label} warning`,
    );
    if (inside) {
      assert.equal(parsed.stdout.includes('zbob'), false, `${label} parse`);
      assert.equal(parsed.stdout.includes(relative), true, `${label} parse`);
    } else {
      assert.equal(parsed.stdout.includes('zbob'), true, `${label} parse dropped the frame`);
      assert.equal(parsed.stdout.includes('C:Users'), false, `${label} parse garbled`);
    }
    const redacted = run(['parse', report, '--redact']);
    assert.equal(redacted.status, 0, redacted.stderr);
    assertSurface(redacted.stdout, `${label} parse --redact`, inside);

    const out = path.join(dir, `${label}-out`);
    fs.mkdirSync(out);
    const triage = run(['triage', report, '--out-dir', out, '--fail-on', 'never']);
    assert.equal(triage.status, 0, triage.stderr);
    assertSurface(fs.readFileSync(path.join(out, 'triage.md'), 'utf8'), `${label} triage.md`, inside);
    assertSurface(fs.readFileSync(path.join(out, 'triage.json'), 'utf8'), `${label} triage.json`, inside);
    const asJson = run(['triage', report, '--json', '--fail-on', 'never']);
    assert.equal(asJson.status, 0, asJson.stderr);
    assertSurface(asJson.stdout, `${label} triage --json`, inside);

    const causes = run(['causes', report]);
    assert.equal(causes.status, 0, causes.stderr);
    assertSurface(causes.stdout, `${label} causes`, inside);
    const causesJson = run(['causes', report, '--json']);
    assert.equal(causesJson.status, 0, causesJson.stderr);
    assertSurface(causesJson.stdout, `${label} causes --json`, inside);
  }

  function librarySurfaces(result) {
    const report = buildTriageReport(result.records);
    const findings = result.records.flatMap((record) => {
      const rows = classifyCauses(record);
      const title = record.titlePath.at(-1) ?? record.id;
      const marks = homeMarks([record.id, title, record.file, ...rows.flatMap((row) => row.evidence)]);
      return [
        redactHomeText(record.id, marks),
        ...rows.flatMap((row) => row.evidence.map((line) => redactHomeText(line, marks))),
      ];
    });
    return {
      'parse --redact': JSON.stringify(redactParseResult(result)),
      'triage.md': renderTriageMarkdown(report),
      'triage.json': renderTriageJson(report),
      'triage --json': renderTriageJson(report),
      causes: findings.join('\n'),
      'causes --json': JSON.stringify(findings),
    };
  }

  for (const [name, rootDir, inside] of roots) {
    const jsonPath = path.join(dir, `${name}.json`);
    fs.writeFileSync(jsonPath, jsonReport(rootDir));
    assertCli(jsonPath, `json-${name}`, inside);

    const xml = xmlReport();
    if (rootDir === undefined) {
      const xmlPath = path.join(dir, 'none.xml');
      fs.writeFileSync(xmlPath, xml);
      assertCli(xmlPath, 'junit-none', false);
    }
    const parsed = parseJunit(xml, `${name}.xml`, rootDir === undefined ? undefined : { rootDir });
    for (const [surface, text] of Object.entries(librarySurfaces(parsed))) {
      assertSurface(text, `junit-${name} ${surface}`, inside);
    }
    assert.equal(
      parsed.warnings.some((warning) => warning.includes('zbob')),
      false,
      `junit-${name} warning`,
    );
  }
});
