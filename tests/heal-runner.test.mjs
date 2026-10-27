import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  healCommand,
  healTimeoutMs,
  proposalFromCompatRow,
  proposalFromContractRow,
  readFindingsContract,
  renderTriageHtml,
  rowsFromCompatStdout,
  runHealCommand,
} from '../dist/index.js';

const cli = path.resolve('dist/cli.js');
const fake = path.resolve('tests/fake-heal.mjs');
const recorded = 'demo/saucedemo/reports/recorded-seed-443.json';
const FORBIDDEN = ['--apply', '--yes', '--no-verify'];

function keepTemp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, env = {}, cwd) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd,
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
  assert.ok(contract.includes('--dry-run'));
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
  assert.match(html, /data-heal-status="proposed"/);
  assert.match(html, /data-heal-refusal="strict-needs-human"/);
  assert.match(html, /Needs Review/);
  assert.equal(html.includes('<script>alert'), false);
  const patches = fs.readdirSync(path.join(dir, 'h')).map((name) => fs.readFileSync(path.join(dir, 'h', name), 'utf8'));
  assert.ok(patches.some((text) => text.includes('Proposal from qa-core-heal (dry run, not applied)')));
  assert.ok(patches.some((text) => text.includes('choose the element')));
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
  assert.equal(html.split('<script').length, 2);
  const patches = fs.readdirSync(path.join(dir, 'h')).map((name) => fs.readFileSync(path.join(dir, 'h', name), 'utf8'));
  assert.ok(patches.some((text) => text.includes('<script>alert(1)</script>')));
  const markdown = fs.readFileSync(path.join(dir, 'triage.md'), 'utf8');
  assert.match(markdown, /<script>alert\(1\)<\/script>/);
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
  const hrefs = [...html.matchAll(/h\/[0-9a-f]{12}\.diff/g)].map((match) => match[0]);
  assert.ok(hrefs.length > 0, html);
  const patch = hrefs.map((href) => fs.readFileSync(path.join(dir, href), 'utf8')).find((text) => text.includes('patched line 19'));
  assert.ok(patch);
  const page = renderTriageHtml(JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8')));
  assert.equal(page.includes('patched line 19'), false);
});

test('--heal-findings is refused when it is a triage output path', (t) => {
  const dir = keepTemp(t, 'heal-same-');
  for (const name of ['triage.json', 'triage.md', 'triage.html']) {
    const result = run(
      ['triage', recorded, '--out-dir', dir, '--heal-findings', path.join(dir, name), '--fail-on', 'never'],
    );
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /cannot be the same file as triage\.json/, name);
    assert.equal(fs.existsSync(path.join(dir, 'triage.json')), false, name);
  }
  const link = path.join(dir, 'findings-link.json');
  fs.symlinkSync(path.join(dir, 'triage.json'), link);
  const linked = run(
    ['triage', recorded, '--out-dir', dir, '--heal-findings', link, '--fail-on', 'never'],
  );
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /cannot be the same file/);
  assert.equal(fs.existsSync(path.join(dir, 'triage.json')), false);
});

test('one eligible finding is not passed with --test', (t) => {
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
  assert.equal(contract.includes('--test'), false, JSON.stringify(contract));
  assert.ok(contract.includes('--dry-run'));
  assert.equal(contract.includes('only the missing button'), false);
  const triage = JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
  assert.equal(triage.entries.length, 1);
  assert.equal(triage.entries[0].healProposal.status, 'proposed');
  assert.equal(triage.entries[0].review.status, 'Needs Review');
});

test('capabilities JSON with a contract array selects contract mode', () => {
  const caps = fs.readFileSync('fixtures/heal/heal-0.4.0-capabilities.json', 'utf8');
  assert.equal(readFindingsContract(caps).findings, 1);
  assert.equal(readFindingsContract('{"contracts":{"findings":[1],"results":[1]}}').findings, 1);
  assert.equal(readFindingsContract('{"contracts":{"findings":1,"results":1}}').findings, 1);
  assert.equal(readFindingsContract('{"findingsContract":1}').findings, 1);
  assert.equal(readFindingsContract('{"contracts":{"findings":[1]}}').findings, null);
  assert.equal(readFindingsContract('{"contracts":{"findings":[2],"results":[1]}}').findings, null);
});

test('real 0.3.4 stdout maps a refusal and a proposal', () => {
  const recorded = fs.readFileSync('fixtures/heal/real-heal-0.3.4-dry-run.json', 'utf8');
  const refused = rowsFromCompatStdout(recorded);
  assert.equal(refused.length, 1);
  const refusedProposal = proposalFromCompatRow(refused[0], '0.3.4');
  assert.equal(refusedProposal.status, 'refused');
  assert.match(refusedProposal.refusal.message, /page-title/);
  assert.equal(refusedProposal.verification.performed, false);
  assert.equal(refusedProposal.label, 'Heal 0.3.x dry run, not re-run verified');

  const both = rowsFromCompatStdout(fs.readFileSync('fixtures/heal/heal-0.3.4-compat.json', 'utf8'));
  const proposed = both.find((row) => row.status === 'proposed');
  const stillRefused = both.find((row) => row.status === 'refused');
  assert.ok(proposed);
  assert.ok(stillRefused);
  const proposal = proposalFromCompatRow(proposed, '0.3.4');
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.changes[0].startLine, 14);
  assert.equal(proposal.changes[0].after, "page.getByTestId('join')");
  assert.equal(proposal.verification.performed, false);
  assert.equal(validateProposal(proposal), true, JSON.stringify(validateProposal.errors));
  assert.equal(validateProposal(refusedProposal), true, JSON.stringify(validateProposal.errors));
});

test('an applied dry-run row becomes an error', () => {
  const proposal = proposalFromContractRow(
    {
      status: 'applied',
      strategy: 'rule-suggestion',
      changes: [{ file: 'a.spec.ts', startLine: 1, endLine: 1, before: 'a', after: 'b' }],
      verification: { performed: true, method: 'shadow-rerun', runs: 1, passed: 1, failed: 0, baselineReproduced: true, outcome: 'passed' },
    },
    '0.4.0',
    'dry-run',
  );
  assert.equal(proposal.status, 'error');
  assert.match(proposal.explanation, /applied/);
  assert.equal(proposal.changes.length, 0);
});

test('the heal timeout honours 120 seconds and clamps above it', () => {
  const saved = process.env.QA_CORE_HEAL_TIMEOUT_MS;
  try {
    process.env.QA_CORE_HEAL_TIMEOUT_MS = '120000';
    assert.equal(healTimeoutMs(), 120_000);
    process.env.QA_CORE_HEAL_TIMEOUT_MS = '130000';
    assert.equal(healTimeoutMs(), 120_000);
    process.env.QA_CORE_HEAL_TIMEOUT_MS = '5000';
    assert.equal(healTimeoutMs(), 5000);
    process.env.QA_CORE_HEAL_TIMEOUT_MS = '0';
    assert.equal(healTimeoutMs(), 60_000);
  } finally {
    if (saved === undefined) delete process.env.QA_CORE_HEAL_TIMEOUT_MS;
    else process.env.QA_CORE_HEAL_TIMEOUT_MS = saved;
  }
});

test('the default heal command does not install from the registry', () => {
  const saved = process.env.QA_CORE_HEAL_BIN;
  try {
    delete process.env.QA_CORE_HEAL_BIN;
    assert.deepEqual(healCommand(['capabilities', '--json']), {
      command: 'npx',
      argv: ['--no-install', 'qa-core-heal', 'capabilities', '--json'],
    });
  } finally {
    if (saved === undefined) delete process.env.QA_CORE_HEAL_BIN;
    else process.env.QA_CORE_HEAL_BIN = saved;
  }
});

test('a grandchild holding the pipe does not extend the timeout', async () => {
  const savedBin = process.env.QA_CORE_HEAL_BIN;
  const savedMode = process.env.FAKE_HEAL_MODE;
  process.env.QA_CORE_HEAL_BIN = fake;
  process.env.FAKE_HEAL_MODE = 'grandchild';
  const started = Date.now();
  try {
    const result = await runHealCommand(['--version'], 400);
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.ok(elapsed >= 300, String(elapsed));
    assert.ok(elapsed < 2000, String(elapsed));
    const live = spawnSync('pgrep', ['-f', 'sleep 25'], { encoding: 'utf8' });
    assert.equal(live.stdout.includes('sleep 25'), false, live.stdout);
  } finally {
    if (savedBin === undefined) delete process.env.QA_CORE_HEAL_BIN;
    else process.env.QA_CORE_HEAL_BIN = savedBin;
    if (savedMode === undefined) delete process.env.FAKE_HEAL_MODE;
    else process.env.FAKE_HEAL_MODE = savedMode;
  }
});

test('a test titled --apply does not abort the run', (t) => {
  const dir = keepTemp(t, 'heal-apply-title-');
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
              title: '--apply',
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
  assert.ok(contract);
  assert.equal(contract.includes('--apply'), false);
  assert.equal(contract.includes('--test'), false);
  const triage = JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
  assert.equal(triage.entries.length, 1);
  assert.equal(triage.entries[0].healProposal.status, 'proposed');
  assert.equal(triage.entries[0].review.status, 'Needs Review');
});

test('a testDir relative spec is resolved before heal sees it', (t) => {
  const dir = keepTemp(t, 'heal-spec-');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'a.spec.ts'), 'test("only the missing button", () => {});\n');
  const report = path.join(dir, 'one.json');
  const message = "Error: expect(locator).toBeVisible() failed\\n\\nLocator: locator('#missing')\\nError: element(s) not found\\n";
  fs.writeFileSync(
    report,
    JSON.stringify({
      config: {
        rootDir: '.',
        version: '1.60.0',
        projects: [{ name: 'chromium', testDir: 'tests' }],
      },
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
  const findingsOut = path.join(dir, 'seen-findings.json');
  const userFindings = path.join(dir, 'heal-findings.json');
  const result = run(
    ['triage', report, '--out-dir', dir, '--heal', '--heal-findings', userFindings, '--fail-on', 'never'],
    healEnv(dir, 'contract', { FAKE_HEAL_FINDINGS_OUT: findingsOut }),
    dir,
  );
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(fs.readFileSync(findingsOut, 'utf8'));
  assert.equal(seen.findings[0].file, 'tests/a.spec.ts');
  assert.equal(seen.findings[0].project, '');
  const user = JSON.parse(fs.readFileSync(userFindings, 'utf8'));
  assert.equal(user.findings[0].file, 'a.spec.ts');
  assert.equal(user.findings[0].project, 'default');
  const compat = run(
    ['triage', report, '--out-dir', path.join(dir, 'compat'), '--heal', '--fail-on', 'never'],
    healEnv(dir, 'compat'),
    dir,
  );
  assert.equal(compat.status, 0, compat.stderr);
  const specs = argvLog(dir).filter((args) => args.includes('--json'));
  assert.ok(specs.some((args) => args[0] === 'tests/a.spec.ts'), JSON.stringify(specs));
});

test('--heal is rejected outside triage', () => {
  const result = run(['parse', recorded, '--heal']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--heal is only valid for triage/);
  const help = run(['--help']);
  assert.match(help.stdout, /--heal/);
});
