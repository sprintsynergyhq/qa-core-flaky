import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { renderTriageHtml } from '../dist/index.js';

const cli = 'dist/cli.js';
const fake = path.resolve('tests/fake-heal.mjs');
const recorded = 'demo/saucedemo/reports/recorded-seed-443.json';
const FORBIDDEN = ['--apply', '--yes', '--no-verify'];

function keepTemp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function healEnv(dir, mode, extra = {}) {
  return {
    QA_CORE_HEAL_BIN: fake,
    FAKE_HEAL_MODE: mode,
    FAKE_HEAL_LOG: path.join(dir, 'heal-argv.log'),
    QA_CORE_HEAL_TIMEOUT_MS: '5000',
    ...extra,
  };
}

function argvLog(dir) {
  const file = path.join(dir, 'heal-argv.log');
  const text = fs.readFileSync(file, 'utf8').trim();
  return text.length === 0 ? [] : text.split('\n').map((line) => JSON.parse(line));
}

function assertDryRun(lines) {
  for (const args of lines) {
    for (const arg of args) {
      assert.equal(FORBIDDEN.includes(arg), false, JSON.stringify(args));
      assert.equal(arg.startsWith('--apply='), false, arg);
      assert.equal(arg.startsWith('--yes='), false, arg);
      assert.equal(arg.startsWith('--no-verify='), false, arg);
    }
  }
}

function proposalValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(JSON.parse(fs.readFileSync('schemas/heal-results.v1.schema.json', 'utf8')));
  return ajv.compile(JSON.parse(fs.readFileSync('schemas/heal-proposal.v1.schema.json', 'utf8')));
}

const validateProposal = proposalValidator();

test('contract mode proposes the SauceDemo typo and refuses the strict Remove test', (t) => {
  const dir = keepTemp(t, 'heal-contract-');
  const result = run(
    ['triage', recorded, '--out-dir', dir, '--html', '--heal', '--heal-findings', path.join(dir, 'heal-findings.json'), '--fail-on', 'never'],
    healEnv(dir, 'contract'),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.includes('not installed'), false, result.stderr);
  const lines = argvLog(dir);
  assertDryRun(lines);
  assert.deepEqual(lines[0], ['capabilities', '--json']);
  const contract = lines.find((args) => args.includes('--findings'));
  assert.ok(contract, JSON.stringify(lines));
  assert.ok(contract.includes('--results'));
  assert.equal(contract.includes('--test'), false);
  assert.equal(lines.some((args) => args.includes('--version')), false);

  const triage = JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
  const byTitle = new Map(triage.entries.map((entry) => [entry.id.split('::').slice(2).join('::'), entry]));
  const typo = byTitle.get('typo locator never finds the backpack button');
  const remove = byTitle.get('unscoped Remove is strict when two items were added');
  assert.equal(typo.healProposal.status, 'proposed');
  assert.equal(typo.healProposal.strategy, 'locator-heal');
  assert.equal(typo.healProposal.label, 'Proposal from qa-core-heal (dry run, not applied)');
  assert.equal(typo.healProposal.mode, 'dry-run');
  assert.match(typo.healProposal.applyCommand, /--apply/);
  assert.equal(typo.healProposal.changes[0].after.includes('backpack'), true);
  assert.equal(remove.healProposal.status, 'refused');
  assert.equal(remove.healProposal.refusal.code, 'strict-needs-human');
  assert.match(remove.healProposal.refusal.message, /choose the element/);
  for (const entry of triage.entries) {
    assert.equal(entry.review.status, 'Needs Review');
    assert.equal(validateProposal(entry.healProposal), true, JSON.stringify(validateProposal.errors));
  }
  const html = fs.readFileSync(path.join(dir, 'triage.html'), 'utf8');
  assert.match(html, /Proposal from qa-core-heal \(dry run, not applied\)/);
  assert.match(html, /strict-needs-human/);
  assert.match(html, /Needs Review/);
  assert.equal(html.includes('<script>alert'), false);
  const markdown = fs.readFileSync(path.join(dir, 'triage.md'), 'utf8');
  assert.match(markdown, /Proposal from qa-core-heal \(dry run, not applied\)/);
  assert.match(markdown, /Review status: Needs Review\./);
});

test('compat mode joins on the spec path and the test title', (t) => {
  const dir = keepTemp(t, 'heal-compat-');
  const result = run(
    ['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'],
    healEnv(dir, 'compat'),
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = argvLog(dir);
  assertDryRun(lines);
  const specs = lines.filter((args) => args.includes('--dry-run') && args.includes('--json'));
  assert.ok(specs.length >= 2, JSON.stringify(lines));
  assert.ok(specs.some((args) => args[0].endsWith('broken.spec.ts')));
  assert.ok(specs.some((args) => args[0].endsWith('selectors.spec.ts')));
  const triage = JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
  const typo = triage.entries.find((entry) => entry.id.includes('typo locator'));
  const remove = triage.entries.find((entry) => entry.id.includes('unscoped Remove'));
  assert.equal(typo.healProposal.status, 'proposed');
  assert.equal(typo.healProposal.label, 'Heal 0.3.x dry run, not re-run verified');
  assert.equal(typo.healProposal.verification.performed, false);
  assert.equal(remove.healProposal.status, 'refused');
  assert.match(remove.healProposal.refusal.message, /choose the element/);
  assert.equal(validateProposal(typo.healProposal), true, JSON.stringify(validateProposal.errors));
  assert.equal(validateProposal(remove.healProposal), true, JSON.stringify(validateProposal.errors));
});

test('a refused result, an error, and a timeout stay in the proposal', (t) => {
  const refusedDir = keepTemp(t, 'heal-refused-');
  const refused = run(['triage', recorded, '--out-dir', refusedDir, '--heal', '--fail-on', 'never'], healEnv(refusedDir, 'refused'));
  assert.equal(refused.status, 0, refused.stderr);
  assertDryRun(argvLog(refusedDir));
  const refusedTriage = JSON.parse(fs.readFileSync(path.join(refusedDir, 'triage.json'), 'utf8'));
  const typo = refusedTriage.entries.find((entry) => entry.id.includes('typo locator'));
  assert.equal(typo.healProposal.status, 'refused');
  assert.equal(typo.review.status, 'Needs Review');

  const errorDir = keepTemp(t, 'heal-error-');
  const error = run(['triage', recorded, '--out-dir', errorDir, '--heal', '--fail-on', 'never'], healEnv(errorDir, 'error'));
  assert.equal(error.status, 0, error.stderr);
  assert.match(error.stderr, /exited with an error/);
  const errorTriage = JSON.parse(fs.readFileSync(path.join(errorDir, 'triage.json'), 'utf8'));
  const errorTypo = errorTriage.entries.find((entry) => entry.id.includes('typo locator'));
  assert.equal(errorTypo.healProposal.status, 'error');
  assert.equal(validateProposal(errorTypo.healProposal), true, JSON.stringify(validateProposal.errors));

  const timeoutDir = keepTemp(t, 'heal-timeout-');
  const timeout = run(
    ['triage', recorded, '--out-dir', timeoutDir, '--heal', '--fail-on', 'never'],
    healEnv(timeoutDir, 'timeout', { QA_CORE_HEAL_TIMEOUT_MS: '200' }),
  );
  assert.equal(timeout.status, 0, timeout.stderr);
  assert.match(timeout.stderr, /timed out/);
  const timeoutTriage = JSON.parse(fs.readFileSync(path.join(timeoutDir, 'triage.json'), 'utf8'));
  const timeoutTypo = timeoutTriage.entries.find((entry) => entry.id.includes('typo locator'));
  assert.equal(timeoutTypo.healProposal.status, 'error');
  assert.equal(timeoutTypo.healProposal.refusal.code, 'timeout');
});

test('a missing heal is unavailable and the triage run still finishes', (t) => {
  const dir = keepTemp(t, 'heal-missing-');
  const result = run(
    ['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'],
    { QA_CORE_HEAL_BIN: path.join(dir, 'missing-heal') },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.match(result.stderr, /qa-core-heal is not installed/);
  const triage = JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
  assert.ok(triage.entries.length > 0);
  for (const entry of triage.entries) {
    assert.equal(entry.healProposal.status, 'unavailable');
    assert.equal(entry.review.status, 'Needs Review');
    assert.equal(validateProposal(entry.healProposal), true, JSON.stringify(validateProposal.errors));
  }
});

test('the spawned command is still a dry run when the diff contains a script tag', (t) => {
  const dir = keepTemp(t, 'heal-xss-');
  const result = run(
    ['triage', recorded, '--out-dir', dir, '--html', '--heal', '--fail-on', 'never'],
    healEnv(dir, 'contract', { FAKE_HEAL_XSS: '1' }),
  );
  assert.equal(result.status, 0, result.stderr);
  assertDryRun(argvLog(dir));
  const html = fs.readFileSync(path.join(dir, 'triage.html'), 'utf8');
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.split('<script').length, 2);
  const markdown = fs.readFileSync(path.join(dir, 'triage.md'), 'utf8');
  assert.equal(markdown.includes('<script>alert(1)</script>'), false);
  assert.match(markdown, /&lt;script&gt;/);
});

test('a long diff is linked from the html and stored beside it', (t) => {
  const dir = keepTemp(t, 'heal-long-');
  const result = run(
    ['triage', recorded, '--out-dir', dir, '--html', '--heal', '--fail-on', 'never'],
    healEnv(dir, 'contract', { FAKE_HEAL_LONG: '1' }),
  );
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(path.join(dir, 'triage.html'), 'utf8');
  assert.equal(html.includes('patched line 19'), false);
  const href = html.match(/heal-patches\/[0-9a-f]{12}\.diff/);
  assert.ok(href, html);
  const patch = fs.readFileSync(path.join(dir, href[0]), 'utf8');
  assert.match(patch, /patched line 19/);
  const page = renderTriageHtml(JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8')));
  assert.equal(page.includes('patched line 19'), false);
});

test('--heal-findings is refused when it is the triage.json path', (t) => {
  const dir = keepTemp(t, 'heal-same-');
  const result = run(
    ['triage', recorded, '--out-dir', dir, '--heal-findings', path.join(dir, 'triage.json'), '--fail-on', 'never'],
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be the same file as triage\.json/);
  assert.equal(fs.existsSync(path.join(dir, 'triage.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'triage.md')), false);
});

test('one eligible finding is passed with --test', (t) => {
  const dir = keepTemp(t, 'heal-one-');
  const report = path.join(dir, 'one.json');
  const message = "Error: expect(locator).toBeVisible() failed\\n\\nLocator: locator('#missing')\\nError: element(s) not found\\n";
  fs.writeFileSync(
    report,
    JSON.stringify({
      config: { configFile: 'playwright.config.ts', rootDir: '.', version: '1.60.0' },
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            {
              title: 'only the missing button',
              file: 'a.spec.ts',
              line: 4,
              tests: [
                {
                  projectName: 'chromium',
                  expectedStatus: 'passed',
                  status: 'unexpected',
                  results: [0, 1, 2].map((retry) => ({
                    retry,
                    status: 'failed',
                    duration: 10,
                    errors: [{ message }],
                  })),
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const result = run(['triage', report, '--out-dir', dir, '--heal', '--fail-on', 'never'], healEnv(dir, 'contract'));
  assert.equal(result.status, 0, result.stderr);
  const lines = argvLog(dir);
  assertDryRun(lines);
  const contract = lines.find((args) => args.includes('--findings'));
  assert.ok(contract, JSON.stringify(lines));
  const testFlag = contract.indexOf('--test');
  assert.notEqual(testFlag, -1, JSON.stringify(contract));
  assert.equal(contract[testFlag + 1], 'only the missing button');
  const triage = JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
  assert.equal(triage.entries.length, 1);
  assert.equal(triage.entries[0].healProposal.status, 'proposed');
  assert.equal(triage.entries[0].review.status, 'Needs Review');
});

test('--heal is rejected outside triage', () => {
  const result = run(['parse', recorded, '--heal']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--heal is only valid for triage/);
  const help = run(['--help']);
  assert.match(help.stdout, /--heal/);
});
