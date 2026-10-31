import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { findHealCli, healCommand, runHealCommand } from '../dist/index.js';

// How qa-core-heal is found and started. On Windows `npx` is `npx.cmd`, and
// Node does not start a `.cmd` file without a shell, so flaky runs the heal
// package's own `bin` script with this Node instead.

const cli = path.resolve('dist/cli.js');
const fake = path.resolve('tests/fake-heal.mjs');
const recorded = path.resolve('demo/saucedemo/reports/recorded-seed-443.json');

function keepTemp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake `node_modules/qa-core-heal` whose bin script runs tests/fake-heal.mjs. */
function installFakeHeal(root, { bin = { 'qa-core-heal': 'dist/cli.js' }, name = 'qa-core-heal', script = 'dist/cli.js' } = {}) {
  const pkg = path.join(root, 'node_modules', 'qa-core-heal');
  fs.mkdirSync(path.join(pkg, path.dirname(script)), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version: '0.7.1', type: 'module', bin }));
  fs.writeFileSync(path.join(pkg, script), `await import(${JSON.stringify(pathToFileURL(fake).href)});\n`);
  return path.join(pkg, script);
}

function withoutOverride(fn) {
  const saved = process.env.QA_CORE_HEAL_BIN;
  delete process.env.QA_CORE_HEAL_BIN;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.QA_CORE_HEAL_BIN;
    else process.env.QA_CORE_HEAL_BIN = saved;
  }
}

test('a local qa-core-heal is started with this Node and its bin script on every OS', (t) => {
  const kit = keepTemp(t, 'heal-local-');
  const script = installFakeHeal(kit);
  withoutOverride(() => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      assert.deepEqual(healCommand(['--version'], { cwd: kit, platform }), {
        command: process.execPath,
        argv: [script, '--version'],
        source: 'local',
      });
    }
  });
});

test('the heal lookup walks parent folders and the nearest install wins', (t) => {
  const root = keepTemp(t, 'heal-walk-');
  const outer = installFakeHeal(root);
  const deep = path.join(root, 'packages', 'kit', 'tests');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findHealCli(deep), outer);
  const inner = installFakeHeal(path.join(root, 'packages', 'kit'));
  assert.equal(findHealCli(deep), inner);
});

test('bin can be a string or an object with a qa-core-heal key', (t) => {
  const asString = keepTemp(t, 'heal-bin-string-');
  const script = installFakeHeal(asString, { bin: './bin/heal.mjs', script: 'bin/heal.mjs' });
  assert.equal(findHealCli(asString), script);
  const otherKey = keepTemp(t, 'heal-bin-other-');
  installFakeHeal(otherKey, { bin: { 'something-else': 'dist/cli.js' } });
  assert.equal(findHealCli(otherKey), undefined);
});

test('a bin that leaves the package folder, is missing, or names another package is refused', (t) => {
  const escape = keepTemp(t, 'heal-bin-escape-');
  installFakeHeal(escape);
  fs.writeFileSync(path.join(escape, 'outside.mjs'), 'process.exit(0);\n');
  const manifest = path.join(escape, 'node_modules', 'qa-core-heal', 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'qa-core-heal', bin: { 'qa-core-heal': '../../outside.mjs' } }));
  assert.equal(findHealCli(escape), undefined);
  fs.writeFileSync(manifest, JSON.stringify({ name: 'qa-core-heal', bin: path.join(escape, 'outside.mjs') }));
  assert.equal(findHealCli(escape), undefined);
  fs.writeFileSync(manifest, JSON.stringify({ name: 'qa-core-heal', bin: 'dist/none.js' }));
  assert.equal(findHealCli(escape), undefined);
  fs.writeFileSync(manifest, JSON.stringify({ name: 'qa-core-heal' }));
  assert.equal(findHealCli(escape), undefined);
  fs.writeFileSync(manifest, '{ not json');
  assert.equal(findHealCli(escape), undefined);
  const named = keepTemp(t, 'heal-bin-name-');
  installFakeHeal(named, { name: 'not-heal' });
  assert.equal(findHealCli(named), undefined);
});

test('a link inside the package that points outside it is refused', (t) => {
  if (process.platform === 'win32') return t.skip('symlinks need extra rights on Windows');
  const kit = keepTemp(t, 'heal-bin-link-');
  const script = installFakeHeal(kit);
  const outside = path.join(kit, 'outside.mjs');
  fs.writeFileSync(outside, 'process.exit(0);\n');
  fs.rmSync(script);
  fs.symlinkSync(outside, script);
  assert.equal(findHealCli(kit), undefined);
});

test('on Windows without a local install nothing is started and heal reads as not installed', async (t) => {
  const dir = keepTemp(t, 'heal-win-missing-');
  await withoutOverride(async () => {
    assert.deepEqual(healCommand(['--version'], { cwd: dir, platform: 'win32' }), { command: '', argv: [], source: 'missing' });
    if (process.platform === 'win32') {
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const result = await runHealCommand(['--version'], 5000);
        assert.equal(result.spawnError, 'ENOENT');
        assert.equal(result.command, '');
      } finally {
        process.chdir(cwd);
      }
    }
  });
});

test('QA_CORE_HEAL_BIN still wins over a local install, and a .cmd override is not started on Windows', (t) => {
  const kit = keepTemp(t, 'heal-override-');
  installFakeHeal(kit);
  const saved = process.env.QA_CORE_HEAL_BIN;
  try {
    process.env.QA_CORE_HEAL_BIN = fake;
    assert.deepEqual(healCommand(['--version'], { cwd: kit, platform: 'win32' }), {
      command: process.execPath,
      argv: [fake, '--version'],
      source: 'env',
    });
    process.env.QA_CORE_HEAL_BIN = 'C:\\kit\\node_modules\\.bin\\qa-core-heal.CMD';
    assert.deepEqual(healCommand(['--version'], { cwd: kit, platform: 'win32' }), { command: '', argv: [], source: 'missing' });
    process.env.QA_CORE_HEAL_BIN = '/opt/heal/qa-core-heal';
    assert.deepEqual(healCommand(['--version'], { cwd: kit, platform: 'linux' }), {
      command: '/opt/heal/qa-core-heal',
      argv: ['--version'],
      source: 'env',
    });
  } finally {
    if (saved === undefined) delete process.env.QA_CORE_HEAL_BIN;
    else process.env.QA_CORE_HEAL_BIN = saved;
  }
});

test('the forbidden flag guard runs before the lookup', (t) => {
  const kit = keepTemp(t, 'heal-guard-');
  installFakeHeal(kit);
  withoutOverride(() => {
    assert.throws(() => healCommand(['--apply'], { cwd: kit, platform: 'win32' }), /Refusing to pass --apply/);
  });
});

test('triage --heal finds qa-core-heal in node_modules without QA_CORE_HEAL_BIN or npx', (t) => {
  const kit = keepTemp(t, 'heal-e2e-');
  installFakeHeal(kit);
  const log = path.join(kit, 'heal-argv.log');
  const out = path.join(kit, 'handoff');
  const env = { ...process.env, FAKE_HEAL_MODE: 'contract', FAKE_HEAL_LOG: log, QA_CORE_HEAL_TIMEOUT_MS: '5000' };
  delete env.QA_CORE_HEAL_BIN;
  // No npx on PATH, so only the local lookup can start heal.
  env.PATH = path.join(kit, 'no-bin');
  const result = spawnSync(
    process.execPath,
    [cli, 'triage', recorded, '--out-dir', out, '--html', '--heal', '--heal-findings', path.join(kit, 'handoff-findings.json'), '--fail-on', 'never'],
    { cwd: kit, env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.includes('not installed'), false, result.stderr);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines[0], ['capabilities', '--json']);
  assert.ok(lines.some((args) => args.includes('--findings') && args.includes('--dry-run')), JSON.stringify(lines));
  const triage = JSON.parse(fs.readFileSync(path.join(out, 'triage.json'), 'utf8'));
  const statuses = triage.entries.map((entry) => entry.healProposal?.status);
  assert.ok(statuses.includes('proposed'), JSON.stringify(statuses));
  assert.equal(statuses.includes('unavailable'), false, JSON.stringify(statuses));
  assert.ok(fs.readdirSync(path.join(out, 'h')).length > 0);
});

test('triage --heal without any heal install says it is not installed and exits 0', (t) => {
  const kit = keepTemp(t, 'heal-e2e-missing-');
  const out = path.join(kit, 'handoff');
  const env = { ...process.env, QA_CORE_HEAL_TIMEOUT_MS: '5000' };
  delete env.QA_CORE_HEAL_BIN;
  env.PATH = path.join(kit, 'no-bin');
  const result = spawnSync(process.execPath, [cli, 'triage', recorded, '--out-dir', out, '--heal', '--fail-on', 'never'], {
    cwd: kit,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /qa-core-heal is not installed/);
  assert.equal(result.stderr.includes(os.homedir()), false);
  const triage = JSON.parse(fs.readFileSync(path.join(out, 'triage.json'), 'utf8'));
  for (const entry of triage.entries) assert.equal(entry.healProposal.status, 'unavailable');
});
