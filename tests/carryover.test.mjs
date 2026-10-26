import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  anchoredGrep,
  buildPlaywrightArgs,
  buildTriageReport,
  classifyCauses,
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
  const findings = classifyCauses(record(slow));
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

test('the next step config path is project-relative', () => {
  assert.equal(
    runnableConfigPath('/home/synthetic/kit/playwright.config.ts', '/home/synthetic/kit'),
    'playwright.config.ts',
  );
  assert.equal(
    runnableConfigPath('/home/synthetic/kit/playwright.config.ts', '/home/synthetic/kit/tests'),
    '../playwright.config.ts',
  );
  const base = runnableConfigPath('/home/synthetic/other/playwright.config.ts', '/tmp/project');
  assert.equal(base.includes('<home>'), false);
  assert.equal(base.includes('synthetic'), false);
  assert.equal(base, 'playwright.config.ts');
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
