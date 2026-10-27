import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  anchoredGrep,
  buildPlaywrightArgs,
  buildTriageReport,
  classifyCauses,
  formatPrintedCommand,
  parseJunit,
  parsePlaywrightJson,
  redactHomeText,
  resolveProjectFile,
  runnableConfigPath,
  suggestFix,
} from '../dist/index.js';
import { relativizeText, toPortablePath } from '../dist/report-path.js';

const cli = 'dist/cli.js';
const sessionPath = 'fixtures/reports/saucedemo-session.json';

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

function record(message) {
  return {
    id: 'tests/a.spec.ts::chromium::sample',
    file: 'tests/a.spec.ts',
    project: 'chromium',
    titlePath: ['sample'],
    expectedStatus: 'passed',
    outcome: 'failed',
    attempts: [
      {
        retry: 0,
        status: 'failed',
        durationMs: 10,
        errors: [{ message }],
        attachments: [],
      },
    ],
    source: { format: 'playwright-json', reportPath: 'fixture.json' },
  };
}

function withPass(item) {
  return {
    ...item,
    outcome: 'flaky',
    attempts: [
      ...item.attempts,
      {
        retry: item.attempts.length,
        status: 'passed',
        durationMs: 10,
        errors: [],
        attachments: [],
      },
    ],
  };
}

function repeated(message, count, source = {}) {
  return {
    ...record(message),
    attempts: Array.from({ length: count }, (_, index) => ({
      retry: index,
      status: 'failed',
      durationMs: 10,
      errors: [{ message }],
      attachments: [],
    })),
    source: { format: 'playwright-json', reportPath: 'fixture.json', ...source },
  };
}

test('a UNC stack frame that names only the share stays absolute and redacts the username', () => {
  const line = String.raw`    at \\srv\Users\bob\share\e.txt`;
  const warnings = [];
  const stored = relativizeText(line, String.raw`C:\work\repo`, warnings);
  assert.equal(stored, line);
  const redacted = redactHomeText(stored);
  assert.equal(redacted.includes('bob'), false);
  assert.equal(redacted.includes('srv/Users'), false);
  assert.equal(redacted.includes('C:Users'), false);
  assert.match(redacted, /\\srv<home>/);
});

test('a pipe is a path boundary between two homes', () => {
  assert.equal(redactHomeText('/home/a/x|/home/b/y'), '<home>/x|<home>/y');
});

test('a home glued to a word is not a home', () => {
  assert.equal(redactHomeText('at/home/bob/a'), 'at/home/bob/a');
  assert.equal(redactHomeText('/api/home/settings/save'), '/api/home/settings/save');
});

test('a space-continued path tail keeps slashes when it contains a backslash', () => {
  assert.equal(redactHomeText(String.raw`/home/bob/my project/a\b.ts`), '<home>/my project/a/b.ts');
  assert.equal(redactHomeText(String.raw`/home/bob/a\b/c\d`), '<home>/a/b/c/d');
  const split = redactHomeText(String.raw`/home/bob/a \Users\carol\b`);
  assert.equal(split.includes('bob'), false);
  assert.equal(split.includes('carol'), false);
});

test('a describe title and a flat title share a grep pattern and a unique line omits -g', () => {
  const nested = anchoredGrep('chromium', 'tests/a.spec.ts', ['Outer', 'child']);
  const pattern = new RegExp(nested.slice(1, -1));
  assert.equal(pattern.test('chromium tests/a.spec.ts Outer child'), true);
  assert.equal(pattern.test('chromium tests/a.spec.ts Outer @smoke child'), true);
  const unique = buildPlaywrightArgs({
    file: 'tests/a.spec.ts',
    titlePath: ['Outer', 'child'],
    line: 12,
    mode: 'repeat',
    times: 1,
    project: 'chromium',
  });
  assert.equal(unique.includes('-g'), false);
  const shared = buildPlaywrightArgs({
    file: 'tests/a.spec.ts',
    titlePath: ['Outer', 'child'],
    mode: 'repeat',
    times: 1,
    project: 'chromium',
  });
  assert.equal(shared.includes('-g'), true);
});

test('resolveProjectFile loads the Playwright root in a child process', async () => {
  const file = await resolveProjectFile(
    'outcomes.spec.ts',
    process.cwd(),
    'fixtures/pw-project/playwright.root.config.ts',
  );
  assert.equal(typeof file, 'string');
  assert.equal(fs.existsSync(file), true);
  assert.equal(file.endsWith(`${path.sep}tests${path.sep}outcomes.spec.ts`), true);
  assert.equal(file.includes(`${path.sep}pw-project${path.sep}tests${path.sep}`), true);
});

test('a JUnit attachment that is only the home folder is redacted', () => {
  const xml = `<testsuite hostname="chromium">
    <testcase name="reads" classname="t.spec.ts" file="t.spec.ts">
      <failure message="missing">missing</failure>
      <system-out><![CDATA[
[[ATTACHMENT|home/bob]]
[[ATTACHMENT|home/bob/]]
[[ATTACHMENT|users/carol/]]
[[ATTACHMENT|Users/Default User/NTUSER.DAT]]
[[ATTACHMENT|Users/All Users/desktop.ini]]
]]></system-out>
    </testcase>
  </testsuite>`;
  const paths = parseJunit(xml, 'reports/home-only.xml').records[0].attempts[0].attachments.map((item) => item.path);
  assert.deepEqual(paths, ['<home>', '<home>/', '<home>/', 'Users/Default User/NTUSER.DAT', 'Users/All Users/desktop.ini']);
});

test('a slash-only root leaves a UNC path absolute', () => {
  const unc = String.raw`\\srv\Users\bob\share\e.txt`;
  for (const root of ['/', '\\\\']) {
    const warnings = [];
    const stored = toPortablePath(unc, root, warnings, false);
    assert.equal(stored, unc, root);
    assert.equal(stored.includes('srv/Users'), false);
    const redacted = redactHomeText(stored);
    assert.equal(redacted.includes('bob'), false);
    assert.equal(warnings.join('\n').includes('bob'), false);
  }
});

test('a dotdot segment that leaves the root is rewritten and warned', () => {
  const warnings = [];
  const stored = toPortablePath(
    String.raw`\\srv\share\proj\..\proj2\x.ts`,
    String.raw`\\srv\share\proj`,
    warnings,
    false,
  );
  assert.equal(stored, '../proj2/x.ts');
  assert.equal(warnings.some((warning) => warning.includes('../proj2/x.ts')), true);
  const inside = [];
  const kept = toPortablePath(String.raw`\\srv\share\proj\a\..\b.ts`, String.raw`\\srv\share\proj`, inside, false);
  assert.equal(kept, 'b.ts');
  assert.equal(inside.length, 0);
});

test('Default User and All Users stay and a real username is redacted', () => {
  assert.equal(redactHomeText(String.raw`C:\Users\Default User\x`), String.raw`C:\Users\Default User\x`);
  assert.equal(redactHomeText(String.raw`C:\Users\All Users\x`), String.raw`C:\Users\All Users\x`);
  assert.equal(redactHomeText(String.raw`C:\Users\zbob\x`), '<home>/x');
});

test('parse --root makes a JUnit file path relative to that directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-root-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'report.xml');
  fs.writeFileSync(
    file,
    `<testsuite hostname="chromium">
      <testcase name="reads" classname="t" file="C:/Users/zalice/proj/tests/a.spec.ts">
        <failure message="nope">nope</failure>
      </testcase>
    </testsuite>`,
  );
  const result = run(['parse', file, '--format', 'junit', '--root', 'C:/Users/zalice/proj']);
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout).records[0];
  assert.equal(record.file, 'tests/a.spec.ts');
  assert.equal(result.stdout.includes('zalice'), false);
});

test('a sibling UNC share stays absolute', () => {
  const warnings = [];
  const file = String.raw`\\srv\share\proj2\a.ts`;
  const stored = toPortablePath(file, String.raw`\\srv\share\proj`, warnings, false);
  assert.equal(stored, file);
  assert.equal(stored.includes('../'), false);
});

test('a device path with a drive root is not garbled and the username is hidden', () => {
  const warnings = [];
  const inside = relativizeText(
    String.raw`    at \\.\C:\Users\name\proj\a.ts:3:5`,
    String.raw`C:\Users\name\proj`,
    warnings,
  );
  assert.equal(inside.includes('C:Users'), false);
  assert.equal(inside.includes('name'), false);
  assert.match(inside, /a\.ts:3:5/);
  assert.equal(warnings.join('\n').includes('name'), false);
  const outside = redactHomeText(String.raw`\\.\C:\Users\name\a.ts`);
  assert.equal(outside, String.raw`\\.\<home>/a.ts`);
  const forward = redactHomeText('//./C:/Users/name/a.ts');
  assert.equal(forward.includes('name'), false);
  assert.equal(forward.includes('C:Users'), false);
});

test('an extended UNC path with a forward slash before Users is a home', () => {
  assert.equal(redactHomeText('//?/UNC/srv/Users/name/a'), '//?/UNC/srv<home>/a');
  assert.equal(redactHomeText(String.raw`\\?\UNC\srv/Users/name/a`), String.raw`\\?\UNC\srv<home>/a`);
  assert.equal(redactHomeText(String.raw`\\?\UNC\srv\Users\name\a`), String.raw`\\?\UNC\srv<home>/a`);
});

test('a path in another user home stays absolute and the warning hides the username', () => {
  const warnings = [];
  const stored = toPortablePath(String.raw`C:\Users\zeve\proj2\a.ts`, String.raw`C:\Users\zalice\proj`, warnings, false);
  assert.equal(stored, 'C:/Users/zeve/proj2/a.ts');
  assert.equal(warnings.join('\n').includes('zeve'), false);
  assert.equal(warnings.join('\n').includes('zalice'), false);
  assert.equal(redactHomeText(stored).includes('zeve'), false);
  const fileWarnings = [];
  const file = toPortablePath(String.raw`C:\Users\zeve\proj2\a.ts`, String.raw`C:\Users\zalice\proj`, fileWarnings, true);
  assert.equal(file.includes('zeve'), false);
  assert.equal(file.includes('zalice'), false);
  const same = [];
  const relative = toPortablePath(String.raw`C:\Users\zalice\other\a.ts`, String.raw`C:\Users\zalice\proj`, same, false);
  assert.equal(relative, '../other/a.ts');
  assert.equal(relative.includes('zalice'), false);
  const posix = [];
  const other = toPortablePath('/home/zeve/proj2/a.ts', '/home/zalice/proj', posix, false);
  assert.equal(other, '/home/zeve/proj2/a.ts');
  assert.equal(posix.join('\n').includes('zeve'), false);
  const tmp = [];
  const kept = toPortablePath('/home/bob/proj/a.ts', '/tmp/project', tmp, false);
  assert.equal(kept.includes('home/bob'), true);
});

test('a climb out of an exempt folder hides the username and keeps the folder', () => {
  assert.equal(
    redactHomeText(String.raw`at C:\Users\Public\..\zbob\x.ts:1:1`),
    String.raw`at C:\Users\Public\..\<home>/x.ts:1:1`,
  );
  assert.equal(redactHomeText('/Users/Public/../zbob/x'), '/Users/Public/../<home>/x');
  assert.equal(redactHomeText(String.raw`at C:\Users\Public\..\zbob\x.ts:1:1`).includes('zbob'), false);
});

test('Public is not joined to the next drive letter', () => {
  assert.equal(redactHomeText(String.raw`C:\Users\Public C:\Users\zbob\x`), String.raw`C:\Users\Public <home>/x`);
  assert.equal(redactHomeText(String.raw`C:\Users\Jöhn Smith\proj`), '<home>/proj');
  assert.equal(redactHomeText(String.raw`C:\Users\Jo Smith Failed Again`), '<home> Failed Again');
});

test('a slow page load is a timing cause and a short selector miss stays selectors', () => {
  const slow = [
    'Error: expect(locator).toBeVisible() failed',
    "Locator: getByTestId('inventory-list')",
    'Timeout: 2000ms',
    'Error: element(s) not found',
    '  - waiting for getByTestId(\'inventory-list\')',
  ].join('\n');
  const missed = classifyCauses(record(slow));
  assert.equal(missed.some((finding) => finding.ruleIds.includes('TIM-SLOW-LOAD')), false);
  assert.equal(missed[0].cause, 'selectors');
  const findings = classifyCauses(withPass(record(slow)));
  assert.equal(findings[0].cause, 'timing');
  assert.equal(findings[0].ruleIds.includes('TIM-SLOW-LOAD'), true);
  const selectors = findings.find((finding) => finding.cause === 'selectors');
  assert.ok(selectors);
  assert.equal(selectors.confidence, 'low');
  const fix = suggestFix(findings[0].ruleIds);
  assert.equal(fix.includes('PR '), false);
  assert.equal(/only raise|raise the timeout|increase the timeout/i.test(fix), false);
  const nav = classifyCauses(
    record('page.goto: Timeout 15000ms exceeded.\nnavigating to "https://example.test/", waiting until "load"'),
  );
  assert.equal(nav[0].ruleIds.includes('TIM-SLOW-LOAD'), true);
  const short = classifyCauses(record(fs.readFileSync('fixtures/errors/sel-notfound.txt', 'utf8')));
  assert.equal(short.some((finding) => finding.ruleIds.includes('TIM-SLOW-LOAD')), false);
  assert.equal(short[0].cause, 'selectors');
  const typo = classifyCauses(
    record('Error: expect(locator).toBeVisible() failed\nTimeout: 1000ms\nError: element(s) not found'),
  );
  assert.equal(typo.some((finding) => finding.ruleIds.includes('TIM-SLOW-LOAD')), false);
  assert.equal(typo[0].cause, 'selectors');
  const testTimeout = classifyCauses(record(fs.readFileSync('fixtures/errors/tim-test-timeout.txt', 'utf8')));
  assert.equal(testTimeout.some((finding) => finding.ruleIds.includes('TIM-SLOW-LOAD')), false);
  assert.deepEqual(
    testTimeout.map((finding) => finding.cause),
    ['selectors', 'timing'],
  );
  const resolved = classifyCauses(
    record(
      [
        'Error: expect(locator).toBeVisible() failed',
        'Timeout 2000ms exceeded.',
        'Call log:',
        "  - waiting for locator('#go')",
        '    - locator resolved to <button id="go">Go</button>',
      ].join('\n'),
    ),
  );
  assert.deepEqual(resolved[0].ruleIds, ['TIM-EXPECT-TIMEOUT']);
  assert.equal(resolved.some((finding) => finding.ruleIds.includes('TIM-SLOW-LOAD')), false);
});

test('a SauceDemo slow-user session is timing and the next step config is runnable', () => {
  const parsed = parsePlaywrightJson(fs.readFileSync(sessionPath, 'utf8'), sessionPath);
  assert.equal(parsed.records[0].source.configFile, 'playwright.config.ts');
  assert.equal(parsed.records[0].source.commitSha, 'abc1234');
  const report = buildTriageReport(parsed.records);
  const slow = report.entries.find((entry) => entry.id.includes('slow user'));
  assert.ok(slow);
  assert.equal(slow.verdict, 'flaky');
  assert.equal(slow.causes[0].cause, 'timing');
  assert.equal(slow.causes[0].ruleIds.includes('TIM-SLOW-LOAD'), true);
  const selectors = slow.causes.find((finding) => finding.cause === 'selectors');
  if (selectors) assert.equal(selectors.confidence, 'low');
  assert.equal(slow.suggestedFix.includes('PR '), false);
  assert.equal(slow.nextStep.includes('playwright.config.ts'), true);
  assert.equal(slow.nextStep.includes('<home>'), false);
  assert.equal(slow.nextStep.includes('synthetic'), false);
  assert.equal(slow.nextStep.includes('Every attempt in this one run failed'), false);
  assert.equal(JSON.stringify(slow).includes('/workspace/'), false);
  const random = report.entries.find((entry) => entry.id.includes('random coin flip'));
  assert.ok(random);
  assert.equal(random.verdict, 'likely-real-bug');
  assert.equal(random.nextStep.includes('Every attempt in this one run failed'), true);
  assert.equal(random.nextStep.includes('--commit'), true);
  assert.equal(random.nextStep.includes('<home>'), false);
  assert.equal(random.nextStep.includes('synthetic'), false);
  assert.equal(random.nextStep.includes('playwright.config.ts'), true);
});

test('the next step config path can be pasted from the project folder', () => {
  assert.equal(
    runnableConfigPath('/home/synthetic/kit/playwright.config.ts', '/home/synthetic/kit'),
    'playwright.config.ts',
  );
  assert.equal(
    runnableConfigPath('/home/synthetic/kit/playwright.config.ts', '/home/synthetic/kit/tests'),
    'playwright.config.ts',
  );
  assert.equal(
    runnableConfigPath('/home/synthetic/kit/e2e/playwright.config.ts', '/home/synthetic/kit'),
    'e2e/playwright.config.ts',
  );
  const base = runnableConfigPath('/home/synthetic/other/playwright.config.ts', '/tmp/project');
  assert.equal(base.includes('<home>'), false);
  assert.equal(base.includes('synthetic'), false);
  assert.equal(base, 'playwright.config.ts');
  const raw = '/home/synthetic/kit/playwright.config.ts';
  const args = buildPlaywrightArgs({
    file: 'outcomes.spec.ts',
    mode: 'isolated',
    times: 1,
    project: 'chromium',
    config: raw,
  });
  assert.equal(args[args.indexOf('--config') + 1], raw);
  const printed = formatPrintedCommand(args);
  assert.equal(printed.includes('synthetic'), false);
  assert.equal(printed.includes('<home>'), true);
  const reportText = JSON.stringify({
    config: {
      rootDir: '/home/synthetic/kit/tests',
      configFile: '/home/synthetic/kit/playwright.config.ts',
    },
    suites: [
      {
        title: 'tests/a.spec.ts',
        file: 'tests/a.spec.ts',
        specs: [
          {
            title: 'typo',
            file: 'tests/a.spec.ts',
            tests: [
              {
                projectName: 'chromium',
                expectedStatus: 'passed',
                status: 'unexpected',
                results: [
                  {
                    retry: 0,
                    status: 'failed',
                    duration: 5000,
                    errors: [{ message: 'Error: element(s) not found\nTimeout: 5000ms' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const parsed = parsePlaywrightJson(reportText, 'reports/out.json');
  assert.equal(parsed.records[0].source.configFile, 'playwright.config.ts');
  const entry = buildTriageReport(parsed.records).entries[0];
  assert.equal(entry.nextStep.includes('../playwright.config.ts'), false);
  assert.match(entry.nextStep, /--config 'playwright\.config\.ts'/);
  assert.equal(entry.nextStep.includes('synthetic'), false);
});

test('rerun passes --retries and the default is 0', (t) => {
  const passed = buildPlaywrightArgs({
    file: 'tests/a.spec.ts',
    mode: 'repeat',
    times: 1,
    retries: 2,
    project: 'chromium',
  });
  assert.equal(passed[passed.indexOf('--retries') + 1], '2');
  assert.equal(passed.includes('--update-snapshots'), false);
  const defaults = buildPlaywrightArgs({
    file: 'tests/a.spec.ts',
    mode: 'repeat',
    times: 1,
    project: 'chromium',
  });
  assert.equal(defaults[defaults.indexOf('--retries') + 1], '0');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-retries-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
  const capped = run(['rerun', '--from', report, '--retries', '2', '--fail-on', 'never']);
  assert.equal(capped.status, 0, capped.stderr);
  assert.match(capped.stderr, /retries 2/);
  assert.equal(capped.stderr.includes('npx'), false);
  const rejected = run(['parse', report, '--retries', '1']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /only valid for rerun/);
});

test('a typo at the default timeout stays a broken test, and a pass makes it a slow load', () => {
  const visible = [
    'Error: expect(locator).toBeVisible() failed',
    'Timeout: 5000ms',
    'Error: element(s) not found',
    "Call log:",
    '  - Expect "toBeVisible" with timeout 5000ms',
    "  - waiting for getByRole('button', { name: 'Missing' })",
  ].join('\n');
  const counted = [
    'Error: expect(locator).toHaveCount(expected) failed',
    'Expected: 1',
    'Received: 0',
    'Timeout: 5000ms',
    'Error: element(s) not found',
    'Call log:',
    '  - Expect "toHaveCount" with timeout 5000ms',
    "  - waiting for locator('#missing')",
    '    8 × locator resolved to 0 elements',
  ].join('\n');
  const timed = [
    'Test timeout of 30000ms exceeded.',
    'Error: element(s) not found',
    "  - waiting for getByRole('button', { name: 'Missing' })",
  ].join('\n');
  for (const message of [visible, counted, timed]) {
    const entry = buildTriageReport([repeated(message, 2)]).entries[0];
    assert.equal(entry.verdict, 'broken-test', message);
    assert.equal(entry.causes[0].cause, 'selectors', message);
    assert.equal(entry.causes[0].confidence, 'high', message);
    assert.equal(entry.causes[0].ruleIds.includes('SEL-NOTFOUND'), true, message);
    assert.equal(JSON.stringify(entry.causes).includes('TIM-SLOW-LOAD'), false, message);
  }
  const zeros = [
    'Error: expect(locator).toHaveCount(expected) failed',
    'Expected: 1',
    'Received: 0',
    'Timeout: 5000ms',
    'Call log:',
    '  - Expect "toHaveCount" with timeout 5000ms',
    "  - waiting for locator('#missing')",
    '    8 × locator resolved to 0 elements',
  ].join('\n');
  const zeroEntry = buildTriageReport([repeated(zeros, 2)]).entries[0];
  assert.equal(zeroEntry.causes[0].cause, 'selectors');
  assert.equal(zeroEntry.causes[0].confidence, 'high');
  assert.equal(JSON.stringify(zeroEntry.causes).includes('TIM-SLOW-LOAD'), false);
  const shortZeros = zeros.replace('Timeout: 5000ms', 'Timeout: 400ms');
  const shortEntry = buildTriageReport([repeated(shortZeros, 2)]).entries[0];
  assert.equal(zeroEntry.verdict, shortEntry.verdict);
  assert.deepEqual(zeroEntry.causes[0].ruleIds, shortEntry.causes[0].ruleIds);

  const navs = [
    'page.goto: Timeout 15000ms exceeded.',
    'page.waitForURL: Timeout 5000ms exceeded.',
    'page.waitForLoadState: Timeout 5000ms exceeded.',
    'Navigation timeout of 30000ms exceeded.',
  ];
  for (const message of navs) {
    const findings = classifyCauses(record(`${message}\nnavigating to "https://example.test/", waiting until "load"`));
    assert.equal(findings[0].ruleIds.includes('TIM-SLOW-LOAD'), true, message);
    assert.equal(findings.some((finding) => finding.cause === 'timing'), true, message);
  }
  const callLog = 'Call log:\n  - navigating to "https://example.test/", waiting until "load"';
  const onlyLog = classifyCauses(record(callLog));
  assert.equal(onlyLog.some((finding) => finding.ruleIds.includes('TIM-SLOW-LOAD')), false);

  const net = [
    'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/',
    'Call log:',
    '  - navigating to "http://127.0.0.1:9/", waiting until "load"',
  ].join('\n');
  const netFindings = classifyCauses(repeated(net, 2));
  assert.deepEqual(netFindings.map((finding) => finding.cause), ['environment']);
  assert.deepEqual(netFindings[0].ruleIds, ['ENV-NET']);
  const netTimeout = [
    'Error: page.goto: Timeout 30000ms exceeded.',
    'Call log:',
    '  - navigating to "https://example.test/", waiting until "load"',
    'net::ERR_CONNECTION_TIMED_OUT',
  ].join('\n');
  const netTimeoutFindings = classifyCauses(record(netTimeout));
  assert.equal(netTimeoutFindings.some((finding) => finding.cause === 'timing'), false);
  assert.equal(netTimeoutFindings[0].ruleIds.includes('ENV-NET'), true);

  const flaky = buildTriageReport([withPass(repeated(visible, 1))]).entries[0];
  assert.equal(flaky.verdict, 'flaky');
  assert.equal(flaky.causes[0].ruleIds.includes('TIM-SLOW-LOAD'), true);

  const sameCommitFail = repeated(visible, 2, { commitSha: 'abc1234', reportPath: 'run-a.json' });
  const sameCommitPass = {
    ...sameCommitFail,
    outcome: 'passed',
    source: { ...sameCommitFail.source, reportPath: 'run-b.json', commitSha: 'abc1234' },
    attempts: [{ retry: 0, status: 'passed', durationMs: 10, errors: [], attachments: [] }],
  };
  const same = buildTriageReport([sameCommitFail, sameCommitPass]).entries[0];
  assert.equal(same.verdict, 'flaky');
  assert.equal(same.causes[0].ruleIds.includes('TIM-SLOW-LOAD'), true);

  const otherCommitPass = {
    ...sameCommitPass,
    source: { ...sameCommitPass.source, reportPath: 'run-c.json', commitSha: 'def5678' },
  };
  const other = buildTriageReport([sameCommitFail, otherCommitPass]).entries[0];
  assert.equal(JSON.stringify(other.causes).includes('TIM-SLOW-LOAD'), false);
  assert.equal(other.causes[0].cause, 'selectors');
  assert.equal(other.causes[0].confidence, 'high');
});

test('rerun passes the typed config path to Playwright', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = path.join(dir, 'report.json');
  fs.writeFileSync(
    report,
    JSON.stringify({
      suites: [
        {
          title: 'outcomes.spec.ts',
          file: 'outcomes.spec.ts',
          specs: [
            {
              title: 'sample',
              file: 'outcomes.spec.ts',
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
                      errors: [{ message: 'Error: element(s) not found' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const config = path.resolve('fixtures/pw-project/playwright.root.config.ts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-config-paste-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const child = spawn(
    process.execPath,
    [
      path.resolve(cli),
      'rerun',
      '--from',
      report,
      '--config',
      config,
      '--modes',
      'isolated',
      '--times',
      '1',
      '--fail-on',
      'never',
    ],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    },
  );
  let stderr = '';
  let stopping;
  const stop = () => {
    if (stopping) return stopping;
    stopping = new Promise((resolve) => {
      if (!child.pid || child.exitCode !== null) {
        resolve();
        return;
      }
      const kill = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 3000);
      child.once('close', () => {
        clearTimeout(kill);
        resolve();
      });
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    });
    return stopping;
  };
  t.after(() => stop());
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      void stop().then(resolve);
    }, 20000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes('playwright.root.config.ts') || stderr.includes('Cannot find test file')) {
        clearTimeout(timer);
        void stop().then(resolve);
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.equal(stderr.includes('Cannot find test file'), false, stderr);
  assert.match(stderr, /--config/);
  assert.match(stderr, /playwright\.root\.config\.ts/);
  assert.equal(stderr.includes('../playwright.root.config.ts'), false);
  const home = os.homedir();
  if (config.startsWith(`${home}${path.sep}`)) {
    assert.equal(stderr.includes(config), false, stderr);
    assert.match(stderr, /<home>\/.*playwright\.root\.config\.ts/);
    assert.equal(stderr.includes(path.basename(home)), false, stderr);
  } else {
    assert.equal(stderr.includes(config), true, stderr);
  }
});

test('an extended UNC home is redacted anywhere in a line', (t) => {
  const lines = [
    '    at //?/UNC/srv/Users/norah/a.ts:3:5',
    'Error: see "//?/UNC/srv/Users/norah/b.ts" now',
    'Error: see [//?/UNC/srv/Users/norah/c.ts] now',
    String.raw`    at \\?\UNC\srv/Users/norah/d.ts:1:2`,
    '    at //./UNC/srv/Users/norah/e.ts:4:5',
    String.raw`    at \\.\UNC\srv/Users/norah/f.ts:6:7`,
    '    at Context.<anonymous> (//?/UNC/srv/Users/norah/proj/g.spec.ts:9:5)',
  ];
  assert.equal(redactHomeText(lines[0]), '    at //?/UNC/srv<home>/a.ts:3:5');
  assert.equal(redactHomeText(lines[1]), 'Error: see "//?/UNC/srv<home>/b.ts" now');
  assert.equal(redactHomeText(lines[2]), 'Error: see [//?/UNC/srv<home>/c.ts] now');
  assert.equal(redactHomeText(lines[3]), String.raw`    at \\?\UNC\srv<home>/d.ts:1:2`);
  assert.equal(redactHomeText(lines[4]), '    at //./UNC/srv<home>/e.ts:4:5');
  assert.equal(redactHomeText(lines[5]), String.raw`    at \\.\UNC\srv<home>/f.ts:6:7`);
  assert.equal(
    redactHomeText(lines[6]),
    '    at Context.<anonymous> (//?/UNC/srv<home>/proj/g.spec.ts:9:5)',
  );
  for (const line of lines) assert.equal(redactHomeText(line).includes('norah'), false, line);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-unc-line-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = path.join(dir, 'unc.json');
  fs.writeFileSync(
    report,
    JSON.stringify({
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            {
              title: 'frame',
              file: 'a.spec.ts',
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
                      errors: lines.map((message) => ({ message, stack: message })),
                    },
                    {
                      retry: 1,
                      status: 'failed',
                      duration: 1,
                      errors: lines.map((message) => ({ message, stack: message })),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const parsed = run(['parse', report, '--redact']);
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout.includes('norah'), false, parsed.stdout);
  assert.equal(parsed.stdout.includes('//?/UNC/srv<home>/'), true);
  const causes = run(['causes', report]);
  assert.equal(causes.status, 0, causes.stderr);
  assert.equal(causes.stdout.includes('norah'), false, causes.stdout);
  assert.equal(causes.stdout.includes('<home>'), true, causes.stdout);
  const triage = run(['triage', report, '--fail-on', 'never', '--json']);
  assert.equal(triage.status, 0, triage.stderr);
  assert.equal(triage.stdout.includes('norah'), false, triage.stdout);
  assert.equal(triage.stdout.includes('<home>'), true, triage.stdout);
});

test('a dotdot climb into another home hides that user', () => {
  const root = String.raw`C:\Users\zbob\proj`;
  for (const file of [
    String.raw`C:\Users\zbob\proj\..\..\zeve\x.ts`,
    String.raw`C:\Users\Public\..\zeve\x.ts`,
  ]) {
    const warnings = [];
    const stored = toPortablePath(file, root, warnings);
    assert.equal(stored.includes('zeve'), false, `${file} -> ${stored}`);
    assert.equal(warnings.join('\n').includes('zeve'), false, warnings.join('\n'));
    const rawWarnings = [];
    const raw = toPortablePath(file, root, rawWarnings, false);
    assert.equal(raw.includes('..'), false, raw);
    assert.equal(redactHomeText(raw).includes('zeve'), false, raw);
    assert.equal(rawWarnings.join('\n').includes('zeve'), false, rawWarnings.join('\n'));
  }
  const warnings = [];
  const posix = toPortablePath('/home/zbob/proj/../../zeve/x.ts', '/home/zbob/proj', warnings);
  assert.equal(posix.includes('zeve'), false, posix);
  assert.equal(warnings.join('\n').includes('zeve'), false, warnings.join('\n'));
  const textWarnings = [];
  const text = relativizeText(String.raw`at C:\Users\zbob\proj\..\..\zeve\x.ts:1:1`, root, textWarnings);
  assert.equal(text.includes('../../zeve'), false, text);
  assert.equal(text.includes('../zeve'), false, text);
  assert.equal(redactHomeText(text).includes('zeve'), false, text);
  assert.equal(textWarnings.join('\n').includes('zeve'), false, textWarnings.join('\n'));
  const publicText = relativizeText(String.raw`at C:\Users\Public\..\zeve\x.ts:2:2`, root, []);
  assert.equal(publicText.includes('zeve') && redactHomeText(publicText).includes('zeve'), false, publicText);
  const posixText = relativizeText('at /home/zbob/proj/../../zeve/x.ts:3:3', '/home/zbob/proj', []);
  assert.equal(posixText.includes('../../zeve'), false, posixText);
  assert.equal(redactHomeText(posixText).includes('zeve'), false, posixText);
});

test('an extended root and a bare climb hide the other user', (t) => {
  const root = String.raw`\\?\C:\Users\zbob\proj`;
  const files = [
    String.raw`C:\Users\zbob\proj\..\..\zeve\x.ts`,
    String.raw`C:\Users\Public\..\..\Users\zeve\x.ts`,
    'C:/Users\\zbob/proj\\..\\..\\zeve/x.ts',
    String.raw`C:\Users\Public\..\zeve\x.ts`,
    String.raw`C:\Users\Default\..\zeve\x.ts`,
  ];
  for (const file of files) {
    const warnings = [];
    const stored = toPortablePath(file, root, warnings);
    assert.equal(stored.includes('zeve'), false, `${file} -> ${stored}`);
    assert.equal(stored.includes('../../zeve'), false, stored);
    assert.equal(warnings.join('\n').includes('zeve'), false, `${file}\n${warnings.join('\n')}`);
    const rawWarnings = [];
    const raw = toPortablePath(file, root, rawWarnings, false);
    assert.equal(raw.includes('..'), false, raw);
    assert.equal(redactHomeText(raw).includes('zeve'), false, raw);
    assert.equal(rawWarnings.join('\n').includes('zeve'), false, rawWarnings.join('\n'));
  }
  const posixWarnings = [];
  const mixedPosix = toPortablePath('/home/zbob/proj\\..\\..\\zeve/x.ts', '/home/zbob/proj', posixWarnings);
  assert.equal(mixedPosix.includes('zeve'), false, mixedPosix);
  assert.equal(posixWarnings.join('\n').includes('zeve'), false, posixWarnings.join('\n'));

  assert.equal(redactHomeText(String.raw`C:\Users\Public\x`).includes('Public'), true);
  assert.equal(redactHomeText(String.raw`C:\Users\Default\x`).includes('Default'), true);
  assert.equal(redactHomeText('/Users/Public/../zbob/x'), '/Users/Public/../<home>/x');
  const shallowDefault = redactHomeText('/Users/Default/../nora/x');
  assert.equal(shallowDefault.includes('nora'), false, shallowDefault);
  assert.match(shallowDefault, /Default/);
  const bare = redactHomeText('/home/zbob/proj/../../zeve/data.json');
  assert.equal(bare.includes('zeve'), false, bare);
  assert.equal(bare.includes('<home>/proj/../../zeve'), false, bare);
  const mixedBare = redactHomeText('/home/zbob/proj\\..\\..\\zeve/data.json');
  assert.equal(mixedBare.includes('zeve'), false, mixedBare);
  for (const climbed of [
    String.raw`C:\Users\Public\..\..\Users\zeve\x.ts`,
    String.raw`C:\Users\Default\..\..\Users\zeve\x.ts`,
    String.raw`\\?\C:\Users\zbob\proj\..\..\zeve\x.ts`,
    'C:/Users\\Public/../../Users/zeve/x.ts',
  ]) {
    assert.equal(redactHomeText(climbed).includes('zeve'), false, climbed);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-dotdot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = path.join(dir, 'climb.json');
  const climbs = [
    String.raw`C:\Users\zbob\proj\..\..\zeve\x.ts`,
    String.raw`C:\Users\Public\..\..\Users\zeve\x.ts`,
  ];
  fs.writeFileSync(
    report,
    JSON.stringify({
      config: { rootDir: root, configFile: 'playwright.config.ts' },
      suites: climbs.map((file, index) => ({
        title: `t${index}.spec.ts`,
        file,
        specs: [
          {
            title: `climb ${index}`,
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
                    errors: [{ message: `Error: open ${file}`, stack: `at read (${file}:1:1)` }],
                  },
                  {
                    retry: 1,
                    status: 'failed',
                    duration: 1,
                    errors: [{ message: `Error: open ${file}` }],
                  },
                ],
              },
            ],
          },
        ],
      })),
    }),
  );
  const parsed = run(['parse', report, '--redact']);
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout.includes('zeve'), false, parsed.stdout);
  const causes = run(['causes', report]);
  assert.equal(causes.status, 0, causes.stderr);
  assert.equal(causes.stdout.includes('zeve'), false, causes.stdout);
  const triage = run(['triage', report, '--fail-on', 'never', '--json']);
  assert.equal(triage.status, 0, triage.stderr);
  assert.equal(triage.stdout.includes('zeve'), false, triage.stdout);
  const markdown = run(['triage', report, '--fail-on', 'never']);
  assert.equal(markdown.status, 0, markdown.stderr);
  assert.equal(markdown.stdout.includes('zeve'), false, markdown.stdout);

  const junit = path.join(dir, 'climb.xml');
  fs.writeFileSync(
    junit,
    `<testsuite hostname="chromium">
      <testcase name="reads" classname="t">
        <failure message="/home/zbob/proj/../../zeve/data.json">/home/zbob/proj/../../zeve/data.json</failure>
      </testcase>
    </testsuite>`,
  );
  const junitParsed = run(['parse', junit, '--format', 'junit', '--redact']);
  assert.equal(junitParsed.status, 0, junitParsed.stderr);
  assert.equal(junitParsed.stdout.includes('zeve'), false, junitParsed.stdout);
  assert.equal(junitParsed.stdout.includes('<home>/proj/../../zeve'), false, junitParsed.stdout);
  const junitCauses = run(['causes', junit, '--format', 'junit']);
  assert.equal(junitCauses.status, 0, junitCauses.stderr);
  assert.equal(junitCauses.stdout.includes('zeve'), false, junitCauses.stdout);
  const junitTriage = run(['triage', junit, '--format', 'junit', '--fail-on', 'never', '--json']);
  assert.equal(junitTriage.status, 0, junitTriage.stderr);
  assert.equal(junitTriage.stdout.includes('zeve'), false, junitTriage.stdout);
});

test('the printed config path runs from the folder where triage ran', { timeout: 240000 }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-paste-'));
  const kit = path.join(parent, 'saucedemo-flaky-kit');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-e2e-'));
  const linkModules = (dir) => {
    fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir');
  };
  const spec = [
    "import { test, expect } from '@playwright/test';",
    "test('slow user reaches the inventory', () => {",
    '  expect(1).toBe(1);',
    '});',
    '',
  ].join('\n');
  const config = [
    "import { defineConfig } from '@playwright/test';",
    'export default defineConfig({',
    "  testDir: './tests',",
    '  retries: 0,',
    '  workers: 1,',
    "  projects: [{ name: 'chromium' }],",
    '});',
    '',
  ].join('\n');
  const writeProject = (dir) => {
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests', 'flaky-slow-user.spec.ts'), spec);
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'), config);
  };
  const writeReport = (dir) => {
    const reportPath = path.join(dir, 'reports', 'run-1.json');
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        config: {
          rootDir: path.join(dir, 'tests'),
          configFile: path.join(dir, 'playwright.config.ts'),
          metadata: { gitCommit: 'abc1234' },
        },
        suites: [
          {
            title: 'flaky-slow-user.spec.ts',
            file: 'flaky-slow-user.spec.ts',
            specs: [
              {
                title: 'slow user reaches the inventory',
                file: 'flaky-slow-user.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    expectedStatus: 'passed',
                    status: 'unexpected',
                    results: [
                      {
                        retry: 0,
                        status: 'failed',
                        duration: 10,
                        errors: [{ message: 'Error: element(s) not found' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    return reportPath;
  };
  const runIn = (cwd, args) =>
    spawnSync(process.execPath, [path.resolve(cli), ...args], { encoding: 'utf8', cwd });
  const paste = (nextStep, cwd) => {
    const marker = 'run: ';
    const at = nextStep.lastIndexOf(marker);
    assert.ok(at >= 0, nextStep);
    const command = nextStep.slice(at + marker.length);
    assert.match(command, / rerun /);
    return spawnSync('sh', ['-c', command], { encoding: 'utf8', cwd, timeout: 180000 });
  };
  const assertRan = (result, label) => {
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.error, undefined, output);
    assert.ok(result.status === 0 || result.status === 2, `${label} exit ${result.status}\n${output}`);
    assert.equal(output.includes('Cannot find test file'), false, output);
    assert.equal(output.includes('Local Playwright was not found'), false, output);
    assert.match(output, /Commands \d+/, output);
    assert.match(result.stdout, /Reruns:/, output);
    assert.equal(result.stdout.includes('slow user reaches the inventory'), true, output);
  };

  try {
    fs.mkdirSync(parent, { recursive: true });
    writeProject(kit);
    // The real kit keeps node_modules inside the kit. The parent has none.
    linkModules(kit);
    assert.equal(fs.existsSync(path.join(parent, 'node_modules')), false);
    writeReport(kit);

    const fromKit = runIn(kit, ['triage', 'reports/run-1.json', '--fail-on', 'never', '--json']);
    assert.equal(fromKit.status, 0, fromKit.stderr);
    const kitStep = JSON.parse(fromKit.stdout).entries[0].nextStep;
    assert.match(kitStep, /--config 'playwright\.config\.ts'/);
    assert.equal(kitStep.includes('../playwright.config.ts'), false, kitStep);
    assert.match(kitStep, /--from 'reports\/run-1\.json'/);
    assert.match(kitStep, /slow user reaches the inventory/);
    assertRan(paste(kitStep, kit), 'kit');

    const fromParent = runIn(parent, [
      'triage',
      'saucedemo-flaky-kit/reports/run-1.json',
      '--fail-on',
      'never',
      '--json',
    ]);
    assert.equal(fromParent.status, 0, fromParent.stderr);
    const parentStep = JSON.parse(fromParent.stdout).entries[0].nextStep;
    assert.match(parentStep, /--config 'saucedemo-flaky-kit\/playwright\.config\.ts'/);
    assert.match(parentStep, /--from 'saucedemo-flaky-kit\/reports\/run-1\.json'/);
    assert.match(parentStep, /slow user reaches the inventory/);
    assertRan(paste(parentStep, parent), 'parent');

    const e2e = path.join(project, 'e2e');
    writeProject(e2e);
    // Hoisted monorepo: node_modules is only on the parent of the config.
    linkModules(project);
    assert.equal(fs.existsSync(path.join(e2e, 'node_modules')), false);
    writeReport(e2e);
    const fromProject = runIn(project, ['triage', 'e2e/reports/run-1.json', '--fail-on', 'never', '--json']);
    assert.equal(fromProject.status, 0, fromProject.stderr);
    const projectStep = JSON.parse(fromProject.stdout).entries[0].nextStep;
    assert.match(projectStep, /--config 'e2e\/playwright\.config\.ts'/);
    assert.match(projectStep, /--from 'e2e\/reports\/run-1\.json'/);
    assertRan(paste(projectStep, project), 'e2e');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
