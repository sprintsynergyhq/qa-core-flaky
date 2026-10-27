import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  findingIdFor,
  findingsPathIsTriageOutput,
  healCommand,
  healTimeoutMs,
  installHealStopHandlers,
  proposalFromCompatRow,
  proposalFromContractRow,
  readFindingsContract,
  readRunTimeoutSupport,
  removeHealStopHandlers,
  renderTriageHtml,
  rowsFromCompatStdout,
  runHealCommand,
  runTimeoutSeconds,
  writeHealPatchFiles,
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

function run(args, env = {}, cwd, timeout) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd,
    timeout,
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
  assert.equal(contract.includes('--run-timeout'), false);
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
  assert.match(html, /class=hp/);
  assert.match(html, /class=hr/);
  assert.match(html, />proposed /);
  assert.match(html, /add-to-cart-sauce-labs-backpack/);
  assert.match(html, /choose the element/);
  assert.equal(html.split('Proposal from qa-core-heal (dry run, not applied)').length - 1, 1);
  assert.equal(html.includes('data-heal-refusal'), false);
  assert.match(html, /Needs Review/);
  assert.equal(html.includes('<script>alert'), false);
  const patches = fs.readdirSync(path.join(dir, 'h')).map((name) => fs.readFileSync(path.join(dir, 'h', name), 'utf8'));
  assert.ok(patches.some((text) => text.includes('Proposal from qa-core-heal (dry run, not applied)')));
  assert.ok(patches.some((text) => text.includes('choose the element')));
  const markdown = fs.readFileSync(path.join(dir, 'triage.md'), 'utf8');
  assert.match(markdown, /Proposal from qa-core-heal \(dry run, not applied\)/);
  assert.match(markdown, /Review status: Needs Review\./);
});

test('compat mode joins on the test title', (t) => {
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

test('a page object verdict joins on the title and keeps the page object path', (t) => {
  const dir = keepTemp(t, 'heal-page-');
  const report = JSON.parse(fs.readFileSync(recorded, 'utf8'));
  let found = false;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.title === 'typo locator never finds the backpack button') {
      node.title = 'subscribes with an email and the weekly digest';
      found = true;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(report);
  assert.equal(found, true);
  const reportPath = path.join(dir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report));
  const fixture = path.resolve('fixtures/heal/real-heal-0.3.4-page-object.json');
  const result = run(
    ['triage', reportPath, '--out-dir', dir, '--heal', '--fail-on', 'never'],
    healEnv(dir, 'compat', { FAKE_HEAL_STDOUT: fixture }),
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = argvLog(dir);
  assert.ok(lines.some((args) => String(args[0]).endsWith('broken.spec.ts') && args.includes('--dry-run')));
  assert.equal(lines.some((args) => String(args[0]).includes('newsletter-page.ts')), false);
  const triage = JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
  const entry = triage.entries.find((item) => item.id.includes('subscribes with an email'));
  assert.ok(entry);
  assert.equal(entry.id.includes('broken.spec.ts'), true);
  assert.equal(entry.id.includes('newsletter-page.ts'), false);
  assert.equal(entry.healProposal.status, 'proposed');
  assert.equal(entry.healProposal.changes[0].file, 'pages/newsletter-page.ts');
  assert.equal(entry.healProposal.changes[0].startLine, 20);
  assert.match(entry.healProposal.changes[0].after, /input\[type/);
  assert.equal(entry.healProposal.verification.performed, false);
  assert.equal(entry.healProposal.label, 'Heal 0.3.x dry run, not re-run verified');
  assert.equal(validateProposal(entry.healProposal), true, JSON.stringify(validateProposal.errors));

  const doubled = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  doubled.verdicts.push({ ...doubled.verdicts[0], after: 'this.page.locator("#other")' });
  const doubledPath = path.join(dir, 'doubled.json');
  fs.writeFileSync(doubledPath, JSON.stringify(doubled));
  const ambiguous = run(
    ['triage', reportPath, '--out-dir', dir, '--heal', '--fail-on', 'never'],
    healEnv(dir, 'compat', { FAKE_HEAL_STDOUT: doubledPath }),
  );
  assert.equal(ambiguous.status, 0, ambiguous.stderr);
  const again = JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
  const missed = again.entries.find((item) => item.id.includes('subscribes with an email'));
  assert.equal(missed.healProposal.status, 'error');
  assert.match(missed.healProposal.explanation, /more than one/);
});

test('a user folder named h is not deleted', (t) => {
  const dir = keepTemp(t, 'heal-keep-h-');
  const folder = path.join(dir, 'h');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'mine.txt'), 'keep\n');
  fs.writeFileSync(path.join(folder, 'abcdef012345.diff'), 'user\n');
  const plain = run(['triage', recorded, '--out-dir', dir, '--fail-on', 'never']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(fs.readFileSync(path.join(folder, 'mine.txt'), 'utf8'), 'keep\n');
  assert.equal(fs.readFileSync(path.join(folder, 'abcdef012345.diff'), 'utf8'), 'user\n');
  assert.equal(fs.existsSync(path.join(folder, '.qa-core-flaky')), false);

  const findings = path.join(folder, 'x.diff');
  const healed = run(
    ['triage', recorded, '--out-dir', dir, '--html', '--heal', '--heal-findings', findings, '--fail-on', 'never'],
    healEnv(dir, 'contract'),
  );
  assert.equal(healed.status, 0, healed.stderr);
  assert.equal(fs.readFileSync(path.join(folder, 'mine.txt'), 'utf8'), 'keep\n');
  assert.equal(fs.readFileSync(path.join(folder, 'abcdef012345.diff'), 'utf8'), 'user\n');
  assert.match(fs.readFileSync(findings, 'utf8'), /qa-core\.heal-findings/);
  const marker = fs.readFileSync(path.join(folder, '.qa-core-flaky'), 'utf8');
  assert.match(marker, /^qa-core-flaky\n/);
  const owned = markerNames(marker);
  assert.ok(owned.length > 0);
  for (const name of owned) assert.equal(fs.existsSync(path.join(folder, name)), true);

  const cleared = run(
    ['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'],
    healEnv(dir, 'contract', { QA_CORE_HEAL_BIN: path.join(dir, 'missing-heal') }),
  );
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(fs.readFileSync(path.join(folder, 'mine.txt'), 'utf8'), 'keep\n');
  assert.equal(fs.readFileSync(path.join(folder, 'abcdef012345.diff'), 'utf8'), 'user\n');
  assert.equal(fs.existsSync(findings), true);
  for (const name of owned) assert.equal(fs.existsSync(path.join(folder, name)), false, name);
  assert.equal(fs.existsSync(path.join(folder, '.qa-core-flaky')), false);
  assert.equal(fs.statSync(folder).isDirectory(), true);

  const fileDir = keepTemp(t, 'heal-h-file-');
  fs.writeFileSync(path.join(fileDir, 'h'), 'keep-file\n');
  const untouched = run(['triage', recorded, '--out-dir', fileDir, '--fail-on', 'never']);
  assert.equal(untouched.status, 0, untouched.stderr);
  assert.equal(fs.readFileSync(path.join(fileDir, 'h'), 'utf8'), 'keep-file\n');
  const blocked = run(
    ['triage', recorded, '--out-dir', fileDir, '--heal', '--fail-on', 'never'],
    healEnv(fileDir, 'contract'),
  );
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /not a directory/);
  assert.equal(fs.readFileSync(path.join(fileDir, 'h'), 'utf8'), 'keep-file\n');
});

function markerNames(text) {
  return text
    .split('\n')
    .map((line) => /^([0-9a-f]{12}\.diff) [0-9a-f]{64}$/.exec(line.trim())?.[1])
    .filter((name) => name !== undefined);
}

function seededPatches(t) {
  const dir = keepTemp(t, 'heal-link-');
  const folder = path.join(dir, 'h');
  const first = run(['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'], healEnv(dir, 'contract'));
  assert.equal(first.status, 0, first.stderr);
  const marker = path.join(folder, '.qa-core-flaky');
  const owned = markerNames(fs.readFileSync(marker, 'utf8'));
  assert.ok(owned.length > 0);
  return { dir, folder, marker, owned };
}

test('a symlink marker is not followed', (t) => {
  const dir = keepTemp(t, 'heal-symlink-marker-');
  const folder = path.join(dir, 'h');
  fs.mkdirSync(folder);
  const outside = path.join(dir, 'outside-marker');
  const body = 'qa-core-flaky\n0123456789ab.diff\n';
  fs.writeFileSync(outside, body);
  const marker = path.join(folder, '.qa-core-flaky');
  fs.symlinkSync(outside, marker);
  fs.writeFileSync(path.join(folder, '0123456789ab.diff'), 'stay\n');
  const result = run(['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'], healEnv(dir, 'contract'));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /is a symlink/);
  assert.equal(fs.existsSync(path.join(dir, 'triage.json')), true);
  assert.equal(fs.readFileSync(outside, 'utf8'), body);
  assert.equal(fs.lstatSync(marker).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(folder, '0123456789ab.diff'), 'utf8'), 'stay\n');
});

test('a symlink diff is not followed', (t) => {
  const { dir, folder, owned } = seededPatches(t);
  const outside = path.join(dir, 'outside.diff');
  fs.writeFileSync(outside, 'KEEP-DIFF\n');
  const diff = path.join(folder, owned[0]);
  fs.unlinkSync(diff);
  fs.symlinkSync(outside, diff);
  const result = run(['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'], healEnv(dir, 'contract'));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /is a symlink/);
  assert.equal(fs.existsSync(path.join(dir, 'triage.json')), true);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'KEEP-DIFF\n');
  assert.equal(fs.lstatSync(diff).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(diff), outside);
});

test('a hard linked marker is not rewritten', (t) => {
  const dir = keepTemp(t, 'heal-hard-marker-');
  const folder = path.join(dir, 'h');
  fs.mkdirSync(folder);
  const outside = path.join(dir, 'outside-marker');
  fs.writeFileSync(outside, 'KEEP-MARKER\n');
  const marker = path.join(folder, '.qa-core-flaky');
  fs.linkSync(outside, marker);
  const result = run(['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'], healEnv(dir, 'contract'));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /has more than one link/);
  assert.equal(fs.existsSync(path.join(dir, 'triage.json')), true);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'KEEP-MARKER\n');
  assert.equal(fs.lstatSync(marker).nlink > 1, true);
  assert.equal(fs.lstatSync(marker).ino, fs.lstatSync(outside).ino);
});

test('a hard linked diff is not rewritten', (t) => {
  const { dir, folder, owned } = seededPatches(t);
  const diff = path.join(folder, owned[0]);
  const before = fs.readFileSync(diff);
  const hard = path.join(dir, 'hard.diff');
  fs.linkSync(diff, hard);
  const result = run(['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'], healEnv(dir, 'contract'));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /has more than one link/);
  assert.equal(fs.existsSync(path.join(dir, 'triage.json')), true);
  assert.equal(fs.readFileSync(hard).equals(before), true);
  assert.equal(fs.lstatSync(diff).nlink > 1, true);
  assert.equal(fs.lstatSync(diff).ino, fs.lstatSync(hard).ino);
});

test('a fifo patch path is not opened', (t) => {
  const markerDir = keepTemp(t, 'heal-fifo-marker-');
  const markerFolder = path.join(markerDir, 'h');
  fs.mkdirSync(markerFolder);
  const marker = path.join(markerFolder, '.qa-core-flaky');
  assert.equal(spawnSync('mkfifo', [marker]).status, 0);
  const markerRun = run(
    ['triage', recorded, '--out-dir', markerDir, '--heal', '--fail-on', 'never'],
    healEnv(markerDir, 'contract'),
    undefined,
    8000,
  );
  assert.equal(markerRun.status, 1, markerRun.stderr);
  assert.match(markerRun.stderr, /is a fifo/);
  assert.equal(fs.existsSync(path.join(markerDir, 'triage.json')), true);
  assert.equal(fs.lstatSync(marker).isFIFO(), true);

  const { dir, folder, marker: seeded, owned } = seededPatches(t);
  const diff = path.join(folder, owned[0]);
  fs.unlinkSync(diff);
  assert.equal(spawnSync('mkfifo', [diff]).status, 0);
  const diffRun = run(
    ['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'],
    healEnv(dir, 'contract'),
    undefined,
    8000,
  );
  assert.equal(diffRun.status, 1, diffRun.stderr);
  assert.match(diffRun.stderr, /is a fifo/);
  assert.equal(fs.existsSync(path.join(dir, 'triage.json')), true);
  assert.equal(fs.lstatSync(diff).isFIFO(), true);
  assert.equal(fs.lstatSync(seeded).isFile(), true);
  assert.equal(fs.lstatSync(seeded).nlink, 1);
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
  assert.equal(html.includes('patched line 0'), true);
  assert.equal(html.includes('<script>alert'), false);
  const hrefs = [...html.matchAll(/h\/[0-9a-f]{12}\.diff/g)].map((match) => match[0]);
  assert.ok(hrefs.length > 0, html);
  const patch = hrefs.map((href) => fs.readFileSync(path.join(dir, href), 'utf8')).find((text) => text.includes('patched line 19'));
  assert.ok(patch);
  const page = renderTriageHtml(JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8')));
  assert.equal(page.includes('patched line 0'), true);
  assert.equal(page.includes('<script>alert'), false);
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

test('a grandchild holding the pipe does not extend the timeout', async (t) => {
  const dir = keepTemp(t, 'heal-timeout-pipe-');
  const note = path.join(dir, 'note');
  const savedBin = process.env.QA_CORE_HEAL_BIN;
  const savedMode = process.env.FAKE_HEAL_MODE;
  const savedNote = process.env.FAKE_HEAL_TEMP_NOTE;
  process.env.QA_CORE_HEAL_BIN = fake;
  process.env.FAKE_HEAL_MODE = 'grandchild';
  process.env.FAKE_HEAL_TEMP_NOTE = note;
  const started = Date.now();
  try {
    const result = await runHealCommand(['--version'], 400);
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.ok(elapsed >= 300, String(elapsed));
    assert.ok(elapsed < 2000, String(elapsed));
    assertNoHealLeak(note);
    const sameGroup = spawnSync('pgrep', ['-f', 'sleep 25'], { encoding: 'utf8' });
    assert.equal(sameGroup.stdout.includes('sleep 25'), false, sameGroup.stdout);
  } finally {
    if (savedBin === undefined) delete process.env.QA_CORE_HEAL_BIN;
    else process.env.QA_CORE_HEAL_BIN = savedBin;
    if (savedMode === undefined) delete process.env.FAKE_HEAL_MODE;
    else process.env.FAKE_HEAL_MODE = savedMode;
    if (savedNote === undefined) delete process.env.FAKE_HEAL_TEMP_NOTE;
    else process.env.FAKE_HEAL_TEMP_NOTE = savedNote;
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
  assert.equal(user.findings[0].file, 'tests/a.spec.ts');
  assert.equal(user.findings[0].project, 'default');
  assert.equal(user.findings[0].findingId, findingIdFor('tests/a.spec.ts', 'default', ['only the missing button']));
  assert.equal(user.findings[0].findingId, seen.findings[0].findingId);
  const compat = run(
    ['triage', report, '--out-dir', path.join(dir, 'compat'), '--heal', '--fail-on', 'never'],
    healEnv(dir, 'compat'),
    dir,
  );
  assert.equal(compat.status, 0, compat.stderr);
  const specs = argvLog(dir).filter((args) => args.includes('--json'));
  assert.ok(specs.some((args) => args[0] === 'tests/a.spec.ts'), JSON.stringify(specs));
});

test('SIGINT kills detached heal descendants and removes both temp folders', async (t) => {
  const stopped = await stopTriageHeal(t, 'SIGINT');
  assert.equal(stopped.code, 130);
});

test('SIGTERM kills detached heal descendants and removes both temp folders', async (t) => {
  const stopped = await stopTriageHeal(t, 'SIGTERM');
  assert.equal(stopped.code, 143);
});

test('a heal timeout kills detached descendants and removes both temp folders', async (t) => {
  const dir = keepTemp(t, 'heal-timeout-tree-');
  const note = path.join(dir, 'note');
  const child = spawn(process.execPath, [cli, 'triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'], {
    env: { ...process.env, ...healEnv(dir, 'orphan', { FAKE_HEAL_TEMP_NOTE: note, QA_CORE_HEAL_TIMEOUT_MS: '8000' }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => killTree(child.pid, note));
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 0, stderr);
  assert.match(stderr, /timed out/);
  assertNoHealLeak(note);
  const triage = JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
  assert.ok(triage.entries.some((entry) => entry.healProposal?.refusal?.code === 'timeout'));
});

async function stopTriageHeal(t, signal) {
  const dir = keepTemp(t, `heal-${signal.toLowerCase()}-`);
  const note = path.join(dir, 'note');
  const child = spawn(process.execPath, [cli, 'triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'], {
    env: { ...process.env, ...healEnv(dir, 'orphan', { FAKE_HEAL_TEMP_NOTE: note, QA_CORE_HEAL_TIMEOUT_MS: '30000' }) },
    detached: true,
    stdio: 'ignore',
  });
  t.after(() => killTree(child.pid, note));
  const deadline = Date.now() + 8_000;
  let flakyDir = '';
  let outDir = '';
  while (Date.now() < deadline) {
    if (fs.existsSync(note)) {
      const lines = fs.readFileSync(note, 'utf8').split('\n');
      flakyDir = lines[0] ?? '';
      outDir = lines[1] ?? '';
      if (flakyDir && outDir) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(fs.existsSync(flakyDir), true, flakyDir || 'the stand-in did not reach the findings command');
  assert.equal(outDir.startsWith(`${flakyDir}${path.sep}`), true, outDir);
  assert.equal(fs.existsSync(outDir), true, outDir);
  assert.ok(child.pid);
  if (signal === 'SIGINT') process.kill(-child.pid, 'SIGINT');
  else process.kill(child.pid, signal);
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assertNoHealLeak(note);
  return { code };
}

function assertNoHealLeak(note) {
  assert.equal(fs.existsSync(note), true, note);
  const [flakyDir, outDir, pidText] = fs.readFileSync(note, 'utf8').split('\n');
  const sleepPid = Number(pidText);
  if (flakyDir) assert.equal(fs.existsSync(flakyDir), false, flakyDir);
  assert.match(outDir, /qa-core-flaky-heal-[^/\\]+[/\\]tmp[/\\]qa-core-heal-out-/);
  assert.equal(fs.existsSync(outDir), false, outDir);
  assert.equal(path.basename(outDir).startsWith('qa-core-heal-out-'), true, outDir);
  assert.throws(() => process.kill(sleepPid, 0));
  const leaked = path.join(os.tmpdir(), path.basename(outDir));
  assert.equal(fs.existsSync(leaked), false, leaked);
}

function killTree(pid, note) {
  if (pid) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The process has already exited.
    }
  }
  if (!fs.existsSync(note)) return;
  const pidText = fs.readFileSync(note, 'utf8').split('\n')[2];
  const sleepPid = Number(pidText);
  if (!sleepPid) return;
  try {
    process.kill(-sleepPid, 'SIGKILL');
  } catch {
    try {
      process.kill(sleepPid, 'SIGKILL');
    } catch {
      // The sleep has already exited.
    }
  }
}

test('heal stop handlers are removed after they are installed', () => {
  const sigint = process.listenerCount('SIGINT');
  const sigterm = process.listenerCount('SIGTERM');
  installHealStopHandlers();
  installHealStopHandlers();
  assert.equal(process.listenerCount('SIGINT'), sigint + 1);
  assert.equal(process.listenerCount('SIGTERM'), sigterm + 1);
  removeHealStopHandlers();
  assert.equal(process.listenerCount('SIGINT'), sigint);
  assert.equal(process.listenerCount('SIGTERM'), sigterm);
});

test('compat spec runs share one wait', (t) => {
  const dir = keepTemp(t, 'heal-budget-');
  const started = Date.now();
  const result = run(
    ['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'],
    healEnv(dir, 'compat-hang', { QA_CORE_HEAL_TIMEOUT_MS: '700' }),
    undefined,
    5_000,
  );
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsed < 2_500, `elapsed ${elapsed}`);
  const specs = argvLog(dir).filter((args) => args.includes('--dry-run') && args.includes('--json'));
  assert.equal(specs.length, 1, JSON.stringify(argvLog(dir)));
  const triage = JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
  const timed = triage.entries.filter((entry) => entry.healProposal?.refusal?.code === 'timeout');
  assert.ok(timed.length >= 2, JSON.stringify(timed.map((entry) => entry.id)));
});

test('--run-timeout is passed only when capabilities advertise it', (t) => {
  assert.equal(runTimeoutSeconds(5_000), 4);
  assert.equal(runTimeoutSeconds(1_500), null);
  const recordedCaps = fs.readFileSync('fixtures/heal/heal-0.4.0-capabilities.json', 'utf8');
  assert.equal(readRunTimeoutSupport(recordedCaps), false);
  const dir = keepTemp(t, 'heal-run-timeout-');
  const caps = JSON.parse(recordedCaps);
  caps.features.runTimeout = true;
  const capsPath = path.join(dir, 'caps.json');
  fs.writeFileSync(capsPath, JSON.stringify(caps));
  const result = run(
    ['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'],
    healEnv(dir, 'contract', { FAKE_HEAL_CAPABILITIES: capsPath }),
  );
  assert.equal(result.status, 0, result.stderr);
  const contract = argvLog(dir).find((args) => args.includes('--findings'));
  assert.ok(contract);
  const at = contract.indexOf('--run-timeout');
  assert.ok(at > 0);
  const seconds = Number(contract[at + 1]);
  assert.equal(runTimeoutSeconds(5_000) !== null && seconds < 5 && seconds >= 1, true, String(seconds));
  assert.ok(seconds * 1000 < 5_000);

  const short = keepTemp(t, 'heal-run-timeout-short-');
  const shortRun = run(
    ['triage', recorded, '--out-dir', short, '--heal', '--fail-on', 'never'],
    healEnv(short, 'contract', { FAKE_HEAL_CAPABILITIES: capsPath, QA_CORE_HEAL_TIMEOUT_MS: '1500' }),
  );
  assert.equal(shortRun.status, 0, shortRun.stderr);
  const shortArgs = argvLog(short).find((args) => args.includes('--findings'));
  assert.ok(shortArgs);
  assert.equal(shortArgs.includes('--run-timeout'), false);
});

test('a swapped patch directory does not receive the files', (t) => {
  const dir = keepTemp(t, 'heal-swap-');
  const folder = path.join(dir, 'h');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(folder);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'aaaaaaaaaaaa.diff'), 'outside-keep\n');
  const oldName = 'bbbbbbbbbbbb.diff';
  const oldBody = 'old\n';
  fs.writeFileSync(path.join(folder, oldName), oldBody);
  fs.writeFileSync(
    path.join(folder, '.qa-core-flaky'),
    `qa-core-flaky\n${oldName} ${patchHash(oldBody)}\n`,
  );
  writeHealPatchFiles({
    dir,
    planned: [{ name: 'cccccccccccc.diff', body: 'new\n' }],
    beforeWrite() {
      fs.renameSync(folder, path.join(dir, 'h-real'));
      fs.symlinkSync(outside, folder);
    },
  });
  assert.equal(fs.readFileSync(path.join(dir, 'h-real', 'cccccccccccc.diff'), 'utf8'), 'new\n');
  assert.equal(fs.existsSync(path.join(outside, 'cccccccccccc.diff')), false);
  assert.equal(fs.existsSync(path.join(outside, '.qa-core-flaky')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'aaaaaaaaaaaa.diff'), 'utf8'), 'outside-keep\n');
  assert.equal(fs.existsSync(path.join(dir, 'h-real', oldName)), false);
  assert.match(fs.readFileSync(path.join(dir, 'h-real', '.qa-core-flaky'), 'utf8'), /cccccccccccc\.diff/);
});

test('a failed patch write leaves the new file in the marker and keeps the old file', (t) => {
  const dir = keepTemp(t, 'heal-partial-');
  const folder = path.join(dir, 'h');
  fs.mkdirSync(folder);
  const oldName = 'dddddddddddd.diff';
  const oldBody = 'old\n';
  fs.writeFileSync(path.join(folder, oldName), oldBody);
  fs.writeFileSync(path.join(folder, '.qa-core-flaky'), `qa-core-flaky\n${oldName} ${patchHash(oldBody)}\n`);
  assert.throws(
    () =>
      writeHealPatchFiles({
        dir,
        planned: [
          { name: 'eeeeeeeeeeee.diff', body: 'one\n' },
          { name: 'ffffffffffff.diff', body: 'two\n' },
        ],
        afterEachWrite(index) {
          if (index === 0) throw new Error('stop after one');
        },
      }),
    /stop after one/,
  );
  const marker = fs.readFileSync(path.join(folder, '.qa-core-flaky'), 'utf8');
  assert.match(marker, /eeeeeeeeeeee\.diff/);
  assert.match(marker, /dddddddddddd\.diff/);
  assert.equal(fs.readFileSync(path.join(folder, 'eeeeeeeeeeee.diff'), 'utf8'), 'one\n');
  assert.equal(fs.readFileSync(path.join(folder, oldName), 'utf8'), oldBody);
  assert.equal(fs.existsSync(path.join(folder, 'ffffffffffff.diff')), false);
});

test('a user diff listed with the wrong hash is not deleted', (t) => {
  const { dir, folder, owned } = seededPatches(t);
  const kept = owned[0];
  fs.writeFileSync(path.join(folder, kept), 'user-keeps-this\n');
  const cleared = run(
    ['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'],
    healEnv(dir, 'contract', { QA_CORE_HEAL_BIN: path.join(dir, 'missing-heal') }),
  );
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(fs.readFileSync(path.join(folder, kept), 'utf8'), 'user-keeps-this\n');
});

test('a dangling symlink marker, a directory marker, and a linked owned name are refused', (t) => {
  const danglingDir = keepTemp(t, 'heal-dangling-');
  const danglingFolder = path.join(danglingDir, 'h');
  fs.mkdirSync(danglingFolder);
  const dangling = path.join(danglingFolder, '.qa-core-flaky');
  fs.symlinkSync(path.join(danglingDir, 'missing-marker'), dangling);
  const danglingRun = run(
    ['triage', recorded, '--out-dir', danglingDir, '--heal', '--fail-on', 'never'],
    healEnv(danglingDir, 'contract'),
  );
  assert.equal(danglingRun.status, 1, danglingRun.stderr);
  assert.match(danglingRun.stderr, /is a symlink/);
  assert.equal(fs.existsSync(path.join(danglingDir, 'missing-marker')), false);
  assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(danglingDir, 'triage.json')), true);

  const directoryDir = keepTemp(t, 'heal-dir-marker-');
  const directoryFolder = path.join(directoryDir, 'h');
  const directoryMarker = path.join(directoryFolder, '.qa-core-flaky');
  fs.mkdirSync(directoryMarker, { recursive: true });
  const directoryRun = run(
    ['triage', recorded, '--out-dir', directoryDir, '--heal', '--fail-on', 'never'],
    healEnv(directoryDir, 'contract'),
  );
  assert.equal(directoryRun.status, 1, directoryRun.stderr);
  assert.match(directoryRun.stderr, /is a directory/);
  assert.equal(fs.lstatSync(directoryMarker).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(directoryDir, 'triage.json')), true);

  const { dir, folder, owned } = seededPatches(t);
  const outside = path.join(dir, 'outside-clean.diff');
  fs.writeFileSync(outside, 'KEEP-CLEAN\n');
  const linked = path.join(folder, owned[0]);
  fs.unlinkSync(linked);
  fs.symlinkSync(outside, linked);
  const cleanup = run(
    ['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'],
    healEnv(dir, 'contract', { QA_CORE_HEAL_BIN: path.join(dir, 'missing-heal') }),
  );
  assert.equal(cleanup.status, 1, cleanup.stderr);
  assert.match(cleanup.stderr, /is a symlink/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'KEEP-CLEAN\n');
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(dir, 'triage.json')), true);
});

test('a symlinked marker with nothing to write still exits 1', (t) => {
  const dir = keepTemp(t, 'heal-empty-link-');
  const folder = path.join(dir, 'h');
  fs.mkdirSync(folder);
  const outside = path.join(dir, 'outside-empty');
  fs.writeFileSync(outside, 'KEEP-EMPTY\n');
  fs.symlinkSync(outside, path.join(folder, '.qa-core-flaky'));
  const result = run(
    ['triage', recorded, '--out-dir', dir, '--heal', '--fail-on', 'never'],
    healEnv(dir, 'contract', { QA_CORE_HEAL_BIN: path.join(dir, 'missing-heal') }),
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /is a symlink/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'KEEP-EMPTY\n');
  assert.equal(fs.existsSync(path.join(dir, 'triage.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'triage.md')), true);
});

test('a symlinked parent and a hard link cannot be the findings file', (t) => {
  const parent = keepTemp(t, 'heal-guard-');
  const out = path.join(parent, 'out');
  fs.mkdirSync(out);
  fs.symlinkSync(out, path.join(parent, 'lnkdir'));
  const linked = run(
    ['triage', recorded, '--out-dir', out, '--heal-findings', path.join(parent, 'lnkdir', 'triage.json'), '--fail-on', 'never'],
  );
  assert.equal(linked.status, 1, linked.stderr);
  assert.match(linked.stderr, /cannot be the same file/);
  assert.equal(fs.existsSync(path.join(out, 'triage.json')), false);

  const first = run(['triage', recorded, '--out-dir', out, '--fail-on', 'never']);
  assert.equal(first.status, 0, first.stderr);
  const hard = path.join(parent, 'hard.md');
  fs.linkSync(path.join(out, 'triage.md'), hard);
  const hardRun = run(['triage', recorded, '--out-dir', out, '--heal-findings', hard, '--fail-on', 'never']);
  assert.equal(hardRun.status, 1, hardRun.stderr);
  assert.match(hardRun.stderr, /cannot be the same file/);
  assert.equal(fs.readFileSync(hard, 'utf8'), fs.readFileSync(path.join(out, 'triage.md'), 'utf8'));

  const folded = path.join(out, 'TRIAGE.json');
  assert.equal(findingsPathIsTriageOutput(folded, out, 'linux'), false);
  assert.equal(findingsPathIsTriageOutput(folded, out, 'darwin'), true);
  assert.equal(findingsPathIsTriageOutput(folded, out, 'win32'), true);
  assert.equal(findingsPathIsTriageOutput(hard, out), true);
});

function patchHash(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

test('--heal is rejected outside triage', () => {
  const result = run(['parse', recorded, '--heal']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--heal is only valid for triage/);
  const help = run(['--help']);
  assert.match(help.stdout, /--heal/);
});
