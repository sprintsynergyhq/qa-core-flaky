import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  buildHealFindings,
  buildTriageReport,
  decideHandoff,
  findingIdFor,
  parseJunit,
  parsePlaywrightJson,
  quoteFailingSelector,
  readReportProjectFacts,
  redactFindingText,
  renderHealFindings,
} from '../dist/index.js';

const cli = 'dist/cli.js';
const schemaPath = 'schemas/heal-findings.v1.schema.json';
const recordedJson = 'demo/saucedemo/reports/recorded-seed-443.json';
const recordedJunit = 'demo/saucedemo/reports/recorded-seed-443.junit.xml';
const goldenJson = 'fixtures/reports/golden/heal-findings-saucedemo.json';
const goldenJunit = 'fixtures/reports/golden/heal-findings-saucedemo-junit.json';

const LOCATOR_RULES = ['SEL-NOTFOUND', 'SEL-UNRESOLVED', 'SEL-ZERO'];
const SUGGEST_RULES = [
  'SEL-STRICT',
  'TIM-EXPECT-TIMEOUT',
  'TIM-SLOW-LOAD',
  'TIM-TEST-TIMEOUT',
  'TIM-INTERCEPT',
  'DATA-VALUE-DRIFT',
  'DATA-ALREADY-EXISTS',
  'DATA-ORDER',
];
const REFUSE_RULES = ['TIM-NEAR-TIMEOUT', 'ENV-NET', 'ENV-HTTP5XX', 'ENV-BROWSER', 'UNK-NONE', 'UNK-EMPTY'];

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

function keepTemp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function compileSchema() {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
}

function playwrightReport(specs, config = {}) {
  return JSON.stringify({
    config: {
      configFile: 'playwright.config.ts',
      rootDir: '.',
      version: '1.60.0',
      ...config,
    },
    suites: [
      {
        title: 'a.spec.ts',
        file: 'a.spec.ts',
        line: 0,
        specs,
      },
    ],
  });
}

function spec(title, results, file = 'a.spec.ts', line = 4) {
  return {
    title,
    file,
    line,
    tests: [
      {
        projectName: 'chromium',
        expectedStatus: 'passed',
        status: results.some((result) => result.status === 'passed') ? 'flaky' : 'unexpected',
        results,
      },
    ],
  };
}

function failed(message, extra = {}) {
  return {
    retry: extra.retry ?? 0,
    status: 'failed',
    duration: extra.duration ?? 10,
    errors: [
      {
        message,
        location: extra.location,
      },
    ],
  };
}

function passed(retry) {
  return { retry, status: 'passed', duration: 10, errors: [] };
}

const validate = compileSchema();

test('the five gates and every cause rule choose the handoff from the table', () => {
  const open = {
    verdict: 'broken-test',
    primaryRuleId: 'SEL-NOTFOUND',
    ruleIds: ['SEL-NOTFOUND'],
    evidence: ['Error: element(s) not found'],
  };
  assert.equal(decideHandoff(open).mode, 'locator');
  assert.deepEqual(
    decideHandoff(open).gates.map((gate) => gate.name),
    [
      'verdict-not-likely-real-bug',
      'verdict-not-environment-issue',
      'no-slow-load-signal',
      'rule-has-fix-strategy',
      'evidence-present',
    ],
  );

  const realBug = decideHandoff({ ...open, verdict: 'likely-real-bug' });
  assert.equal(realBug.mode, 'none');
  assert.equal(realBug.gates[0].passed, false);
  assert.match(realBug.reason, /likely-real-bug/);

  const environment = decideHandoff({ ...open, verdict: 'environment-issue' });
  assert.equal(environment.mode, 'none');
  assert.equal(environment.gates[1].passed, false);
  assert.match(environment.reason, /environment-issue/);

  const slow = decideHandoff({ ...open, ruleIds: ['SEL-NOTFOUND', 'TIM-SLOW-LOAD'] });
  assert.equal(slow.mode, 'none');
  assert.equal(slow.gates[2].passed, false);
  assert.match(slow.reason, /slow load/);

  const noStrategy = decideHandoff({ ...open, primaryRuleId: 'TIM-NEAR-TIMEOUT', ruleIds: ['TIM-NEAR-TIMEOUT'] });
  assert.equal(noStrategy.mode, 'none');
  assert.equal(noStrategy.gates[3].passed, false);
  assert.match(noStrategy.reason, /no fix strategy/);

  const noEvidence = decideHandoff({ ...open, evidence: [] });
  assert.equal(noEvidence.mode, 'none');
  assert.equal(noEvidence.gates[4].passed, false);
  assert.match(noEvidence.reason, /no quoted evidence/);

  for (const ruleId of LOCATOR_RULES) {
    const decision = decideHandoff({ ...open, primaryRuleId: ruleId, ruleIds: [ruleId] });
    assert.equal(decision.mode, 'locator', ruleId);
  }
  for (const ruleId of SUGGEST_RULES) {
    const decision = decideHandoff({
      verdict: 'flaky',
      primaryRuleId: ruleId,
      ruleIds: [ruleId],
      evidence: ['quoted'],
    });
    assert.equal(decision.mode, 'suggest', ruleId);
    if (ruleId === 'TIM-SLOW-LOAD') assert.equal(decision.gates[2].passed, false);
    else assert.equal(decision.gates[2].passed, true);
  }
  for (const ruleId of REFUSE_RULES) {
    const decision = decideHandoff({
      verdict: 'flaky',
      primaryRuleId: ruleId,
      ruleIds: [ruleId],
      evidence: ['quoted'],
    });
    assert.equal(decision.mode, 'none', ruleId);
  }

  assert.equal(
    decideHandoff({ ...open, primaryRuleId: 'NOT-A-RULE', ruleIds: ['NOT-A-RULE'] }).mode,
    'none',
  );
});

test('redaction hides home paths, other absolute paths, queries, tokens, and emails', () => {
  const raw = [
    'Error: element(s) not found',
    'see /home/alice/proj/a.ts',
    'see /opt/ci/build/secret.ts',
    'see /root/.ssh/id_rsa',
    'see /workspace/repo/file.ts',
    'see /private/var/folders/ab/x',
    'see C:\\opt\\ci\\a.ts',
    'encoded %2Fhome%2Falice%2Fsecret',
    'mail qa-user@example.test',
    'url https://user:pass@www.saucedemo.com/inventory.html?token=abc123#frag',
    'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.signaturevalue',
    'api_key=supersecretvalue',
    'keep /assets/sl-404-Cq1a9k9X.jpg',
    'keep Expected: "a?b"',
    'keep https://www.saucedemo.com/',
  ].join('\n');
  const hidden = redactFindingText(raw);
  assert.equal(redactFindingText(hidden), hidden);
  for (const secret of [
    'alice',
    '/opt/ci',
    '/root/',
    '/workspace/',
    '/private/var',
    'C:\\opt',
    'C:/opt',
    '%2Fhome',
    'qa-user@example.test',
    'token=abc123',
    'user:pass',
    'eyJhbGci',
    'supersecretvalue',
  ]) {
    assert.equal(hidden.includes(secret), false, secret);
  }
  assert.match(hidden, /<home>/);
  assert.match(hidden, /<path>/);
  assert.match(hidden, /<email>/);
  assert.match(hidden, /<token>/);
  assert.match(hidden, /\/assets\/sl-404-Cq1a9k9X\.jpg/);
  assert.match(hidden, /Expected: "a\?b"/);
  assert.match(hidden, /https:\/\/www\.saucedemo\.com\//);
  assert.equal(hidden.includes('?token'), false);
});

test('a failing selector is quoted from the error and source frames are skipped', () => {
  assert.equal(
    quoteFailingSelector(["Locator: locator('#add-to-cart-sauce-labs-bakpack')"]),
    '#add-to-cart-sauce-labs-bakpack',
  );
  assert.equal(
    quoteFailingSelector(['Locator:  locator(\'[data-test="inventory-item"] img\').first()']),
    'locator(\'[data-test="inventory-item"] img\').first()',
  );
  assert.equal(
    quoteFailingSelector(["Error: strict mode violation: getByRole('button', { name: 'Remove' }) resolved to 2 elements:"]),
    "getByRole('button', { name: 'Remove' })",
  );
  const frame = [
    ">  8 |   await expect(page.locator('#add-to-cart-sauce-labs-bakpack')).toBeVisible();",
    '     |                                                                 ^',
  ].join('\n');
  assert.equal(quoteFailingSelector([frame]), null);
});

test('project facts keep the origin and ignore a report that has none', () => {
  const facts = readReportProjectFacts(
    playwrightReport([], {
      projects: [
        {
          use: {
            baseURL: 'https://user:pass@www.saucedemo.com/inventory.html?token=abc',
            testIdAttribute: 'data-test',
          },
        },
      ],
    }),
  );
  assert.equal(facts.baseUrl, 'https://www.saucedemo.com');
  assert.equal(facts.testIdAttribute, 'data-test');
  assert.equal(facts.playwrightVersion, '1.60.0');
  assert.equal(facts.configPath, 'playwright.config.ts');
  assert.deepEqual(readReportProjectFacts('<testsuite></testsuite>'), {
    configPath: null,
    baseUrl: null,
    testIdAttribute: null,
    playwrightVersion: null,
  });
});

test('gate results from a built report match the verdict and the cause', () => {
  const notFound = 'Error: expect(locator).toBeVisible() failed\n\nLocator: locator(\'#missing\')\nExpected: visible\nTimeout: 1000ms\nError: element(s) not found\n';
  const locatorDoc = buildHealFindings(parseReport([spec('missing', [failed(notFound), failed(notFound, { retry: 1 }), failed(notFound, { retry: 2 })])]), {
    reports: ['a.json'],
    version: '0.0.1',
  });
  assert.equal(locatorDoc.findings.length, 1);
  assert.equal(locatorDoc.findings[0].verdict, 'broken-test');
  assert.equal(locatorDoc.findings[0].primaryRuleId, 'SEL-NOTFOUND');
  assert.equal(locatorDoc.findings[0].handoff.mode, 'locator');
  assert.equal(locatorDoc.findings[0].failingSelector, '#missing');
  assert.equal(locatorDoc.findings[0].findingId, findingIdFor('a.spec.ts', 'chromium', ['missing']));

  const slowDoc = buildHealFindings(
    parseReport([spec('slow miss', [failed(notFound, { retry: 0 }), passed(1)])]),
    { reports: ['a.json'], version: '0.0.1' },
  );
  assert.equal(slowDoc.findings[0].verdict, 'flaky');
  assert.equal(slowDoc.findings[0].handoff.mode === 'locator', false);
  assert.equal(slowDoc.findings[0].handoff.gates.find((gate) => gate.name === 'no-slow-load-signal').passed, false);

  const net = 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/\n';
  const envDoc = buildHealFindings(
    parseReport([spec('offline', [failed(net), failed(net, { retry: 1 }), failed(net, { retry: 2 })])]),
    { reports: ['a.json'], version: '0.0.1' },
  );
  assert.equal(envDoc.findings[0].verdict, 'environment-issue');
  assert.equal(envDoc.findings[0].primaryRuleId, 'ENV-NET');
  assert.equal(envDoc.findings[0].handoff.mode, 'none');

  const mismatch = 'Error: expect(locator).toHaveText(expected) failed\n\nLocator: locator(\'#n\')\nExpected: "1"\nReceived: "9"\n';
  const bugDoc = buildHealFindings(
    parseReport([spec('mismatch', [failed(mismatch), failed(mismatch, { retry: 1 }), failed(mismatch, { retry: 2 })])]),
    { reports: ['a.json'], version: '0.0.1' },
  );
  assert.equal(bugDoc.findings[0].verdict, 'likely-real-bug');
  assert.equal(bugDoc.findings[0].handoff.mode, 'none');
  assert.equal(bugDoc.findings[0].review.status, 'Needs Review');
});

test('secrets in a quoted error are absent from the findings file', () => {
  const line = [
    'Error: element(s) not found',
    '/home/alice/a.ts',
    '/opt/ci/secret.ts',
    '/root/id_rsa',
    '/workspace/a.ts',
    '/private/var/folders/x',
    'qa-user@example.test',
    'https://www.saucedemo.com/x?token=abc123',
    'Bearer eyJhbGciOiJI.eyJzdWIiOiIx.signature1',
    '%2Fhome%2Falice',
    '/assets/pic.jpg',
  ].join(' ');
  assert.ok(line.length <= 300, line.length);
  const records = parsePlaywrightJson(
    playwrightReport([
      spec('leaks', [failed(line), failed(line, { retry: 1 }), failed(line, { retry: 2 })], 'a.spec.ts', 4),
    ]),
    'a.json',
  );
  records.records[0].attempts[0].errors[0].location = { file: '/opt/ci/a.spec.ts', line: 4, column: 1 };
  const body = renderHealFindings(
    buildHealFindings(records.records, {
      reports: ['/opt/ci/reports/a.json'],
      version: packageVersion(),
      cwd: '/opt/ci',
    }),
  );
  for (const secret of [
    'alice',
    '/opt/ci',
    '/root/',
    '/workspace/',
    '/private/var',
    'qa-user@example.test',
    'token=abc123',
    'eyJhbGci',
    '%2Fhome',
  ]) {
    assert.equal(body.includes(secret), false, secret);
  }
  assert.match(body, /\/assets\/pic\.jpg/);
  assert.equal(validate(JSON.parse(body)), true, JSON.stringify(validate.errors));

  const gaps = [
    'see /app/tests/a.spec.ts and /data/db /code/src /src/app.js /project/a /Library/App /proc/1 /run/a /dev/null /nix/store/a',
    'url=/opt/ci/x?y=1',
    'page.goto("/cart?session=abc")',
    'ws://host:9/socket?key=abc',
    'ftp://files.example.test/a?token=abc',
    'sk_live_abc123xyz',
    'ghp_abcdefghijklmnopqrstuvwxyz',
    'AKIAIOSFODNN7EXAMPLE',
    'Authorization: Basic dXNlcjpwYXNz',
    '/mnt/c/Users/bob/secret.ts',
    'file:///home/alice/proj/a.ts',
  ].join(' ');
  const hidden = redactFindingText(gaps);
  for (const secret of [
    'y=1',
    'session=abc',
    'key=abc',
    'token=abc',
    'sk_live_',
    'ghp_',
    'AKIA',
    'dXNlcjpwYXNz',
    'bob',
    'alice',
    '/app/',
    '/src/',
    '/nix/',
    '/proc/',
  ]) {
    assert.equal(hidden.includes(secret), false, secret);
  }
  assert.match(hidden, /<path>\/x/);
  assert.match(hidden, /\/cart/);
  assert.match(hidden, /<token>/);
  assert.match(hidden, /file:\/\/\/<path>\/a\.ts/);
});

test('titles that differ only by a redacted email do not share a findingId', () => {
  const message = 'Error: element(s) not found\nLocator: locator(\'#missing\')\n';
  const records = parseReport([
    spec('login as a@x.com', [failed(message), failed(message, { retry: 1 }), failed(message, { retry: 2 })]),
    spec('login as b@x.com', [failed(message), failed(message, { retry: 1 }), failed(message, { retry: 2 })]),
  ]);
  const document = buildHealFindings(records, { reports: ['a.json'], version: packageVersion() });
  assert.equal(document.findings.length, 2);
  assert.equal(document.findings[0].titlePath[0], 'login as <email>');
  assert.equal(document.findings[1].titlePath[0], 'login as <email>');
  assert.notEqual(document.findings[0].findingId, document.findings[1].findingId);
  const plain = findingIdFor('a.spec.ts', 'chromium', ['login as <email>']);
  assert.notEqual(document.findings[0].findingId, plain);
  assert.notEqual(document.findings[1].findingId, plain);
  const again = buildHealFindings(records, { reports: ['a.json'], version: packageVersion() });
  assert.deepEqual(
    again.findings.map((finding) => finding.findingId),
    document.findings.map((finding) => finding.findingId),
  );
  const body = renderHealFindings(document);
  assert.equal(body.includes('a@x.com'), false);
  assert.equal(body.includes('b@x.com'), false);
  const alone = buildHealFindings(
    parseReport([spec('login as a@x.com', [failed(message), failed(message, { retry: 1 }), failed(message, { retry: 2 })])]),
    { reports: ['a.json'], version: packageVersion() },
  );
  assert.equal(alone.findings[0].findingId, plain);
});

test('recorded SauceDemo findings match the golden files and the schema', () => {
  const json = fs.readFileSync(goldenJson, 'utf8');
  const junit = fs.readFileSync(goldenJunit, 'utf8');
  const renderedJson = renderRecorded(recordedJson);
  const renderedJunit = renderRecorded(recordedJunit);
  assert.equal(stripToolVersion(renderedJson), stripToolVersion(json));
  assert.equal(stripToolVersion(renderedJunit), stripToolVersion(junit));
  assert.equal(JSON.parse(renderedJson).tool.version, packageVersion());
  assert.equal(renderedJson, renderRecorded(recordedJson));
  const document = JSON.parse(json);
  assert.equal(validate(document), true, JSON.stringify(validate.errors));
  assert.equal(validate(JSON.parse(junit)), true, JSON.stringify(validate.errors));
  assert.equal(document.schema, 'qa-core.heal-findings');
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.generatedAt, undefined);
  assert.equal(document.project.baseUrl, null);
  assert.equal(document.project.testIdAttribute, null);
  assert.equal(document.project.playwrightVersion, '1.60.0');
  const modes = Object.fromEntries(document.findings.map((finding) => [finding.primaryRuleId, finding.handoff.mode]));
  assert.equal(modes['SEL-NOTFOUND'], 'locator');
  assert.equal(modes['SEL-STRICT'], 'suggest');
  assert.equal(modes['TIM-EXPECT-TIMEOUT'], 'suggest');
  assert.equal(modes['TIM-TEST-TIMEOUT'], 'suggest');
  assert.equal(modes['DATA-VALUE-DRIFT'], 'suggest');
  assert.equal(modes['ENV-NET'], 'none');
  assert.equal(modes['UNK-NONE'], 'none');
  for (const finding of document.findings) {
    assert.equal(finding.findingId, findingIdFor(finding.file, finding.project, finding.titlePath));
    assert.equal(finding.review.status, 'Needs Review');
    if (finding.verdict === 'likely-real-bug' || finding.verdict === 'environment-issue') {
      assert.equal(finding.handoff.mode, 'none');
    }
    assert.match(finding.errorSignature, /^sha256:[0-9a-f]{64}$/);
  }
  const triage = buildTriageReport(parsePlaywrightJson(fs.readFileSync(recordedJson, 'utf8'), recordedJson).records);
  assert.deepEqual(
    document.findings.map((finding) => finding.verdict),
    triage.entries.map((entry) => entry.verdict),
  );
  assert.ok(triage.entries.every((entry) => entry.healProposal === null));
});

test('the schema rejects a locator handoff on a likely real bug, a bad review, and an unknown field', () => {
  const document = JSON.parse(fs.readFileSync(goldenJson, 'utf8'));
  const realBug = structuredClone(document);
  realBug.findings[0].handoff.mode = 'locator';
  assert.equal(validate(realBug), false);

  const review = structuredClone(document);
  review.findings[0].review.status = 'Approved';
  assert.equal(validate(review), false);

  const extra = structuredClone(document);
  extra.findings[0].extra = 1;
  assert.equal(validate(extra), false);

  const version = structuredClone(document);
  version.schemaVersion = 2;
  assert.equal(validate(version), false);

  const unknown = structuredClone(document);
  unknown.extra = true;
  assert.equal(validate(unknown), false);

  const redaction = structuredClone(document);
  redaction.redaction.applied = false;
  assert.equal(validate(redaction), false);

  const gate = structuredClone(document);
  gate.findings[0].handoff.gates[0].name = 'not-a-gate';
  assert.equal(validate(gate), false);

  const evidence = structuredClone(document);
  evidence.findings[0].causes[0].evidence[0] = 'x'.repeat(301);
  assert.equal(validate(evidence), false);
});

test('the vendored findings schema matches the frozen contract', () => {
  const bytes = fs.readFileSync(schemaPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  // Frozen heal-findings v1. A byte change needs a schema version bump.
  assert.equal(digest, '0770177865f22aa0117fde757a6172feddb59033a562bc6c081cc96833315583');
  const results = createHash('sha256').update(fs.readFileSync('schemas/heal-results.v1.schema.json')).digest('hex');
  const proposal = createHash('sha256').update(fs.readFileSync('schemas/heal-proposal.v1.schema.json')).digest('hex');
  assert.equal(results, '92b6debf0d0612ecae1498c7fdd25d9e572d4f7b6565ec6065634e04ee8eb3d4');
  assert.equal(proposal, '5866df6944671b8132d4d72fd93fd0fe0b08a38a015232c138ef3c6937c0ecc2');
});

test('triage --heal-findings writes the golden bytes and leaves triage.json unchanged', (t) => {
  const dir = keepTemp(t, 'heal-findings-');
  const findingsPath = path.join(dir, 'heal-findings.json');
  const first = run(['triage', recordedJson, '--out-dir', dir, '--heal-findings', findingsPath, '--fail-on', 'never']);
  assert.equal(first.status, 0, first.stderr);
  const written = fs.readFileSync(findingsPath, 'utf8');
  assert.equal(stripToolVersion(written), stripToolVersion(fs.readFileSync(goldenJson, 'utf8')));
  assert.equal(JSON.parse(written).tool.version, packageVersion());
  const sauceTriage = JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
  assert.ok(sauceTriage.entries.every((entry) => entry.healProposal === null));

  const plain = keepTemp(t, 'heal-findings-plain-');
  const flagged = keepTemp(t, 'heal-findings-flag-');
  const fixture = 'fixtures/reports/pw-1.60.0-outcomes.json';
  const without = run(['triage', fixture, '--out-dir', plain, '--fail-on', 'never']);
  const withFlag = run([
    'triage',
    fixture,
    '--out-dir',
    flagged,
    '--heal-findings',
    path.join(flagged, 'heal-findings.json'),
    '--fail-on',
    'never',
  ]);
  assert.equal(without.status, 0, without.stderr);
  assert.equal(withFlag.status, 0, withFlag.stderr);
  const triageJson = fs.readFileSync(path.join(flagged, 'triage.json'), 'utf8');
  assert.equal(triageJson, fs.readFileSync(path.join(plain, 'triage.json'), 'utf8'));
  assert.equal(triageJson, fs.readFileSync('fixtures/reports/golden/triage.json', 'utf8'));
  assert.ok(JSON.parse(triageJson).entries.every((entry) => entry.healProposal === null));

  const secondPath = path.join(dir, 'again.json');
  const second = run(['triage', recordedJson, '--heal-findings', secondPath, '--fail-on', 'never']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(secondPath, 'utf8'), written);
  const digest = createHash('sha256').update(written).digest('hex');
  assert.equal(createHash('sha256').update(fs.readFileSync(secondPath)).digest('hex'), digest);
});

test('triage --timestamp adds a generatedAt that validates, and other commands reject the flag', (t) => {
  const dir = keepTemp(t, 'heal-findings-time-');
  const findingsPath = path.join(dir, 'heal-findings.json');
  const result = run(['triage', recordedJson, '--heal-findings', findingsPath, '--timestamp', '--fail-on', 'never']);
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  assert.match(document.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(validate(document), true, JSON.stringify(validate.errors));

  const parse = run(['parse', recordedJson, '--heal-findings', findingsPath]);
  assert.equal(parse.status, 1);
  assert.match(parse.stderr, /--heal-findings is only valid for triage/);
  const help = run(['--help']);
  assert.match(help.stdout, /--heal-findings/);
});

test('a passing report writes an empty findings list', (t) => {
  const dir = keepTemp(t, 'heal-findings-pass-');
  const report = path.join(dir, 'pass.json');
  const findingsPath = path.join(dir, 'heal-findings.json');
  fs.writeFileSync(
    report,
    playwrightReport([
      {
        title: 'ok',
        file: 'a.spec.ts',
        line: 1,
        tests: [
          {
            projectName: 'chromium',
            expectedStatus: 'passed',
            status: 'expected',
            results: [{ retry: 0, status: 'passed', duration: 1, errors: [] }],
          },
        ],
      },
    ]),
  );
  const result = run(['triage', report, '--heal-findings', findingsPath, '--fail-on', 'never']);
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  assert.deepEqual(document.findings, []);
  assert.equal(validate(document), true, JSON.stringify(validate.errors));
});

function parseReport(specs) {
  return parsePlaywrightJson(playwrightReport(specs), 'a.json').records;
}

function packageVersion() {
  return JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
}

function stripToolVersion(text) {
  const document = JSON.parse(text);
  document.tool.version = 'VERSION';
  return `${JSON.stringify(document, null, 2)}\n`;
}

function renderRecorded(reportPath) {
  const text = fs.readFileSync(reportPath, 'utf8');
  const parsed = reportPath.endsWith('.xml') ? parseJunit(text, reportPath) : parsePlaywrightJson(text, reportPath);
  return renderHealFindings(
    buildHealFindings(parsed.records, {
      reports: [reportPath],
      version: packageVersion(),
      project: readReportProjectFacts(text),
    }),
  );
}
